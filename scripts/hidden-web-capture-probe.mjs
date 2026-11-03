import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {CASES,CHILD_TIMEOUT_MS,hostedOnly,childEnvironment}=require('./hidden-web-capture-probe-common.cjs');

hostedOnly();
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(source!==process.env.GITHUB_SHA)throw new Error('Checkout source must equal this workflow run source.');
if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw new Error('A clean reviewed checkout is required before native execution.');
const runDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'rvhcap-'));
const output=path.join(root,'test-results/hidden-web-capture-probe');
fs.mkdirSync(output,{recursive:true});
const electron=require('electron');
const results=[];
const write=(name,data)=>fs.writeFileSync(path.join(output,name),JSON.stringify(data,null,2)+'\n');

function runCase(item) {
  return new Promise(resolve=>{
    const owned=path.join(runDirectory,item.id),profile=path.join(owned,'profile'),result=path.join(owned,'result.json'),config=path.join(owned,'config.json');
    fs.mkdirSync(profile,{recursive:true});
    fs.writeFileSync(config,JSON.stringify({id:item.id,runDirectory,profile,result}));
    const child=spawn(electron,[path.join(root,'scripts/hidden-web-capture-probe-app.cjs'),config],{cwd:root,env:childEnvironment(process.env,profile),stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
    let stderr='',stdout='',timedOut=false,spawnError;
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(-2048);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);});
    const timer=setTimeout(()=>{
      timedOut=true;
      if(child.exitCode!==null||child.signalCode!==null){child.stdout.destroy();child.stderr.destroy();return;}
      if(process.platform==='win32') {
        // Only this newly spawned, owned Electron process tree is terminated.
        const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
        const fallback=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');};
        killer.on('error',fallback);killer.on('close',code=>{if(code!==0)fallback();});
      } else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    },CHILD_TIMEOUT_MS);
    child.on('error',error=>{spawnError=error.message;});
    child.on('close',(code,signal)=>{
      clearTimeout(timer);
      let value;
      try{value=JSON.parse(fs.readFileSync(result,'utf8'));}catch{}
      value={...(value||{diagnosticOnly:true,id:item.id,status:'no-result'}),process:{code,signal,watchdogTimeout:timedOut,spawnError,stderrTail:stderr,unexpectedStdout:stdout}};
      if(timedOut||spawnError||code!==0||['no-result','invariant-failed'].includes(value.status))value.infrastructureFailure=true;
      write(item.id+'.json',value);
      console.log(JSON.stringify({diagnosticOnly:true,id:item.id,status:value.status,hiddenOutcome:value.hidden?.status,infrastructureFailure:Boolean(value.infrastructureFailure)}));
      resolve(value);
    });
  });
}

try {
  for(const item of CASES) {
    const prerequisite=item.requires&&results.find(result=>result.id===item.requires);
    if(item.requires&&(!prerequisite||!prerequisite.hidden?.freshSourceFrame||!prerequisite.sourcePreserved||!prerequisite.geometryPreserved)) {
      const skipped={diagnosticOnly:true,id:item.id,status:'skipped-prerequisite',requires:item.requires};results.push(skipped);write(item.id+'.json',skipped);continue;
    }
    results.push(await runCase(item));
  }
  const summary={schema:1,diagnosticOnly:true,productQaPassed:false,probeCompleted:results.every(result=>!result.infrastructureFailure),source,dirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),platform:process.platform,arch:process.arch,node:process.version,cases:results,limits:['Synthetic isolated source only; no ReviewOps application launch, renderer build, package, release or installation.','Timeout/rejection are diagnostic observations, not a passed product QA gate.','No native screenshot file or base64 image is written or logged; PNG metadata and hashes only.','No display mode, permission, hardware-acceleration or Chromium feature flags are changed.']};
  write('summary.json',summary);
  if(!summary.probeCompleted)process.exitCode=1;
} finally {
  fs.rmSync(runDirectory,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
