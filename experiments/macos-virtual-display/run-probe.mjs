import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {executionRefusal, inventoryDifference, verifyNativeResult, objectiveCOwnershipFlags} from './policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'test-results/virtual-display-probe');
const json = (name, data) => fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2)+'\n');
const read = name => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
const git = (...args) => spawnSync('git', args, {cwd:root, encoding:'utf8', timeout:5000, maxBuffer:64*1024});
let active;
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => active?.kill(signal));
async function bounded(command, args, timeoutMs) {
  return new Promise(resolve => {
    let stdout='', stderr='', total=0, reason=null, finished=false;
    const child=spawn(command,args,{cwd:root,stdio:['ignore','pipe','pipe']}); active=child;
    const stop=why=>{if(reason)return;reason=why;child.kill('SIGTERM');hard=setTimeout(()=>child.kill('SIGKILL'),5000)};
    let hard; const timer=setTimeout(()=>stop('timeout'),timeoutMs);
    child.stdout.on('data',data=>{total+=data.length;stdout=(stdout+data).slice(0,64*1024);if(total>128*1024)stop('output-limit')});
    child.stderr.on('data',data=>{total+=data.length;stderr=(stderr+data).slice(0,64*1024);if(total>128*1024)stop('output-limit')});
    const done=value=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(hard);if(active===child)active=null;resolve({stdout,stderr,reason,...value})};
    child.on('error',error=>done({status:null,error:error.code}));
    child.on('close',(status,signal)=>done({status,signal}));
  });
}

fs.mkdirSync(output,{recursive:true});
const sourceQuery=git('rev-parse','HEAD'),statusQuery=git('status','--porcelain');
let result={schema:1,runId:randomUUID(),outcome:'not-run',scope:'experimental private macOS virtual-display lifecycle only',lifecycleExecuted:false,source:sourceQuery.stdout?.trim()||'',dirty:statusQuery.status!==0||Boolean(statusQuery.stdout?.trim()),architecture:process.arch,osRelease:os.release(),effects:{capturedFrames:0,injectedInputs:0,requestedPermissions:0}};
try {
  const compileOnly=process.argv.length===3&&process.argv[2]==='--compile-only';
  const ci=process.argv.length===3&&process.argv[2]==='--ci';
  if(!compileOnly&&!ci)throw new Error('Use --compile-only (no execution) or --ci (guarded hosted-runner lifecycle).');
  if(sourceQuery.status!==0||!/^([a-f0-9]{40})$/.test(result.source))throw new Error('source-identity-unavailable');
  if(process.platform!=='darwin')throw new Error('Compilation requires macOS/Xcode.');
  if(ci){const refusal=executionRefusal(process.env);if(refusal)throw new Error(refusal);if(process.env.GITHUB_SHA!==result.source||result.dirty)throw new Error('checkout-source-mismatch-or-dirty');if(process.env.PROBE_EXPECTED_ARCH!==process.arch)throw new Error('runner-architecture-mismatch')}
  const binary=path.join(output,'probe');
  const args=['clang',...objectiveCOwnershipFlags,'-fmodules','-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0',...(ci?['-DREVIEWOPS_VIRTUAL_DISPLAY_CI_EXECUTION=1']:[]),'experiments/macos-virtual-display/probe.m','-framework','Foundation','-framework','AppKit','-framework','CoreGraphics','-o',binary];
  const built=await bounded('xcrun',args,60000);
  fs.writeFileSync(path.join(output,'compile.log'),built.stdout+built.stderr);
  result.build={status:built.status,reason:built.reason,ciExecutionCompiled:ci};
  if(built.status!==0||built.reason)throw new Error('compile-failed');
  if(compileOnly){result.outcome='compile-only';result.code='NO_DISPLAY_LIFECYCLE_EXECUTED';json('result.json',result);console.log(JSON.stringify(result));process.exit(0)}
  process.env.REVIEWOPS_PROBE_RUN_ID=result.runId;
  for(const file of ['native.json','post-process.json'])fs.rmSync(path.join(output,file),{force:true});
  result.lifecycleExecuted=true;json('result.json',result);
  const native=await bounded(binary,['--exercise-ci',path.join(output,'native.json')],70000);
  fs.writeFileSync(path.join(output,'native.stdout.log'),native.stdout);
  fs.writeFileSync(path.join(output,'native.stderr.log'),native.stderr);
  result.process={status:native.status,signal:native.signal,reason:native.reason};
  if(fs.existsSync(path.join(output,'native.json')))result.native=read('native.json');
  // Public read-only inventory, including after a child timeout. Never restore
  // or remove an unknown display. A timeout can never count as lifecycle pass.
  const post=await bounded(binary,['--inventory-ci',path.join(output,'post-process.json')],10000);
  result.postProcessInventoryStatus={status:post.status,reason:post.reason,signal:post.signal};
  if(post.status===0)result.postProcess=read('post-process.json');
  result.postProcessInventoryPreserved=Boolean(result.native?.before&&post.status===0&&inventoryDifference(result.native.before,result.postProcess?.displays)===null);
  if(native.reason||native.status!==0){result.outcome=result.native?.outcome==='unsupported'?'unsupported':'failed';result.code=native.reason||result.native?.code||'native-process-failed'}
  else {
    if(!result.native||result.native.architecture!==process.arch||result.native.runId!==result.runId||result.native.source!==result.source)throw new Error('native-result-identity-mismatch');
    const mismatch=verifyNativeResult(result.native||{});
    const postMismatch=!result.postProcessInventoryPreserved||result.postProcess?.runId!==result.runId||result.postProcess?.source!==result.source;
    if(mismatch||postMismatch)throw new Error(mismatch||'post-process-inventory-mismatch');
    result.outcome='passed';result.code='ONE_OWNED_DISPLAY_CREATED_VALIDATED_REMOVED';
  }
}catch(error){result.outcome='failed';result.code=error.message}
json('result.json',result);
console.log(JSON.stringify({outcome:result.outcome,code:result.code,source:result.source,lifecycleExecuted:result.lifecycleExecuted}));
if(result.outcome!=='passed')process.exitCode=1;
