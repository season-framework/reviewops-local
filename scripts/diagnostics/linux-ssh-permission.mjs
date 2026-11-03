// Linux-only, owned loopback SSH diagnostics. Importing this file launches nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {StringDecoder} from 'node:string_decoder';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),repository=path.resolve(here,'../..');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const folderMessage='SSH 계정으로 에이전트 작업 폴더를 열 수 없습니다.';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

export function assertHost(value){
 assert.equal(value.platform,'linux','This diagnostic requires an actual Linux host');
 assert.equal(value.ci,'true');assert.equal(value.actions,'true');assert.equal(value.event,'workflow_dispatch');
 assert.ok(Number.isSafeInteger(value.uid)&&value.uid>0,'Linux permission denial must run as a non-root account');
 assert.ok(Number.isSafeInteger(value.euid)&&value.euid>0,'Effective root can bypass directory permissions');
 assert.match(value.source,/^[a-f0-9]{40}$/);assert.equal(value.source,value.head);assert.equal(value.source,value.githubSHA);
 assert.match(value.ref,/^refs\/heads\/.+/);assert.equal(value.workflowRef,`season-framework/reviewops-local/.github/workflows/linux-ssh-permission.yml@${value.ref}`);
 assert.equal(value.dirty,'');assert.equal(value.nodeMajor,24);
 assert.ok(Number.isSafeInteger(value.runId)&&value.runId>0);assert.equal(value.attempt,1,'A rerun is not automatically admitted');
}

export function assertDenied(status,workPath){
 assert.equal(status.installed,null);assert.equal(status.authState,'unknown');assert.equal(status.loggedIn,false);
 assert.equal(status.errorCode,'AGENT_WORK_PATH_INACCESSIBLE');assert.equal(status.workPath,workPath);
 assert.equal(status.modelSource,'none');assert.deepEqual(status.models,[]);
 assert.match(status.error,/Permission denied/);assert.ok(status.error.includes(folderMessage));
}

export function assertClosures(value){
 assert.equal(value.serverClosed,true);assert.equal(value.jobs,0);assert.equal(value.updates,0);assert.equal(value.unexpectedRequests,0);
 assert.ok(value.shells.length>0&&value.channels.length===value.shells.length&&value.clients.length>0);
 for(const row of value.shells){
  assert.equal(row.exitObserved,true);assert.equal(row.closeObserved,true);assert.equal(row.stdoutEnded,true);assert.equal(row.stderrEnded,true);
  assert.ok(Number.isInteger(row.code));assert.ok([0,125,127].includes(row.code));assert.equal(row.signal,null);assert.equal(row.overflow,false);
 }
 assert.ok(value.channels.every(row=>row.closed===true));assert.ok(value.clients.every(row=>row.closed===true));
}

function argumentsFor(argv){
 assert.deepEqual(argv.slice(0,1),['--run'],'Explicit --run is required');
 assert.equal(argv.length,3);assert.equal(argv[1],'--source');assert.match(argv[2],/^[a-f0-9]{40}$/);return argv[2];
}
async function bounded(promise,label,ms=15000){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} closure is unconfirmed; preserve owned resources`)),ms);})]);}finally{clearTimeout(timer);}
}

export async function run(argv=process.argv.slice(2)){
 const source=argumentsFor(argv);
 // Reject macOS, root, dirty checkouts and non-manual invocations before creating keys or servers.
 assert.equal(process.platform,'linux');assert.ok(process.getuid()>0&&process.geteuid()>0);
 const git=args=>execFileSync('git',args,{cwd:repository,encoding:'utf8',maxBuffer:2*1024*1024}).trim();
 assertHost({platform:process.platform,uid:process.getuid(),euid:process.geteuid(),ci:process.env.CI,actions:process.env.GITHUB_ACTIONS,event:process.env.GITHUB_EVENT_NAME,
  source,head:git(['rev-parse','HEAD']),githubSHA:process.env.GITHUB_SHA,ref:process.env.GITHUB_REF,workflowRef:process.env.GITHUB_WORKFLOW_REF,
  dirty:git(['status','--porcelain=v1','--untracked-files=all']),nodeMajor:Number(process.versions.node.split('.')[0]),runId:Number(process.env.GITHUB_RUN_ID),attempt:Number(process.env.GITHUB_RUN_ATTEMPT)});
 const output=path.join(repository,'test-results/linux-ssh-permission',`${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
 assert.ok(!fs.existsSync(output),'Preserve the original result; no automatic retry');fs.mkdirSync(output,{recursive:true,mode:0o700});
 const privateRoot=fs.mkdtempSync('/tmp/reviewops-linux-permission-'),home=path.join(privateRoot,'home'),work=path.join(privateRoot,'project'),restricted=path.join(work,'restricted'),bin=path.join(privateRoot,'bin');
 for(const dir of [home,work,restricted,bin,path.join(home,'.codex')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(home,'.bash_profile'),'# Private Linux diagnostic login profile.\n',{mode:0o600});
 const cliLog=path.join(privateRoot,'cli.jsonl'),binary=path.join(bin,'codex-fixture');
 fs.writeFileSync(binary,`#!${process.execPath}\nconst fs=require('node:fs'),os=require('node:os'),args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(cliLog)},JSON.stringify({args,cwd:process.cwd(),uid:process.getuid(),gid:process.getgid(),home:os.homedir(),codexHome:process.env.CODEX_HOME})+'\\n');\nif(args.length===1&&args[0]==='--version'){console.log('codex-cli linux-permission-fixture');process.exit(0)}\nif(args.length===2&&args[0]==='login'&&args[1]==='status')process.exit(0);\nprocess.exit(90);\n`,{mode:0o700});
 const binarySHA=hash(fs.readFileSync(binary));
 const env={HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
 const require=createRequire(import.meta.url),{Server,utils}=require('ssh2'),{fingerprintOf}=require('../../electron/ssh.cjs'),{createAgentManager}=require('../../electron/agents.cjs');
 const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
 const fingerprint=fingerprintOf(utils.parseKey(key).getPublicSSH()),password=crypto.randomBytes(24).toString('hex');
 const clients=[],channels=[],shells=[],pending=[];let updates=0,unexpectedRequests=0,serverClosed=false,phase='setup';
 const report={ok:false,source,platform:process.platform,kernel:os.release(),uname:{sysname:os.type(),release:os.release(),version:os.version(),machine:os.machine()},uid:process.getuid(),euid:process.geteuid(),gid:process.getgid(),node:process.version,
  runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),privateRoot,host:'127.0.0.1',hostFingerprint:fingerprint,
  testCredentialScope:'Fresh in-memory SSH2 test host key and synthetic authentication; shell runs as the recorded Linux account.',
  productionModules:Object.fromEntries(['electron/agents.cjs','electron/ssh.cjs'].map(name=>[name,hash(fs.readFileSync(path.join(repository,name)))])),
  criterion:'QA-034-004',newFormalQAIDs:0,agentJobs:0,modelRequests:0,harnessProcessSignals:0,checks:[],shells,channels,clients};
 const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');save();
 const server=new Server({hostKeys:[key]},client=>{
  const state={ordinal:clients.length+1,closed:false},closed=deferred();clients.push(state);pending.push(closed.promise);
  client.on('error',error=>{state.error=error.code||error.name;save();});client.once('close',()=>{state.closed=true;closed.resolve();save();});
  client.on('authentication',auth=>{if(auth.method==='password'&&auth.username==='permission-fixture'&&auth.password===password)auth.accept();else auth.reject();});
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();
   session.on('sftp',(_accept,reject)=>{unexpectedRequests++;reject();save();});
   session.on('exec',(acceptExec,_reject,info)=>{
    const channel=acceptExec(),channelClosed=deferred(),state={ordinal:channels.length+1,phase,closed:false};channels.push(state);pending.push(channelClosed.promise);
    channel.on('error',error=>{state.error=error.code||error.name;save();});channel.once('close',()=>{state.closed=true;channelClosed.resolve();save();});
    const row={ordinal:shells.length+1,phase,command:info.command,exitObserved:false,closeObserved:false,stdoutEnded:false,stderrEnded:false,code:null,signal:null,stdout:'',stderr:'',overflow:false};shells.push(row);
    const child=spawn('/bin/bash',['-c',info.command],{env,stdio:['pipe','pipe','pipe']});row.pid=child.pid||null;row.startedAt=new Date().toISOString();
    const done=deferred();pending.push(done.promise);let bytes=0;const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const collect=(name,chunk)=>{bytes+=chunk.length;if(bytes<=64*1024)row[name]+=decoders[name].write(chunk);else row.overflow=true;save();};
    channel.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{collect('stdout',chunk);channel.write(chunk);});child.stderr.on('data',chunk=>{collect('stderr',chunk);channel.stderr.write(chunk);});
    child.stdout.once('end',()=>{row.stdout+=decoders.stdout.end();row.stdoutEnded=true;save();});child.stderr.once('end',()=>{row.stderr+=decoders.stderr.end();row.stderrEnded=true;save();});
    child.once('error',error=>{row.error=error.code||error.name;save();});
    child.once('exit',(code,signal)=>{row.exitObserved=true;row.code=code;row.signal=signal;save();});
    child.once('close',(code,signal)=>{row.closeObserved=true;row.code=code;row.signal=signal;row.closedAt=new Date().toISOString();try{if(!channel.destroyed){if(Number.isInteger(code)&&code>=0&&code<=255)channel.exit(code);channel.end();}}catch(error){row.transportError=error.code||error.name;}finally{done.resolve();save();}});
   });
  }));
 });
 const manager=createAgentManager({env,onUpdate(){updates++;}});
 const cliRows=()=>fs.existsSync(cliLog)?fs.readFileSync(cliLog,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
 const check=(name,value)=>{report.checks.push({name,status:'pass',...value});save();};
 let primaryError;
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});report.port=server.address().port;save();
  const config={id:'linux-permission-owned',kind:'ssh',host:'127.0.0.1',port:report.port,username:'permission-fixture',authType:'password',password,rootPath:work,hostFingerprint:fingerprint};
  const settings={binary,workPath:restricted};
  phase='normal';const normal=await manager.preflight(config,settings);assert.equal(normal.installed,true);assert.equal(normal.authState,'authenticated');check('normal diagnostic',{dto:normal});
  for(const row of cliRows()){assert.equal(row.uid,process.getuid());assert.equal(row.home,home);assert.equal(row.codexHome,env.CODEX_HOME);}
  const before=cliRows().length;assert.equal(before,2);fs.chmodSync(restricted,0o000);
  assert.equal(fs.statSync(restricted).mode&0o777,0);assert.equal(fs.realpathSync(restricted),restricted);
  phase='denied-environment';const denied=await manager.environment(config,settings);assertDenied(denied,restricted);assert.equal(cliRows().length,before);check('actual Linux permission denial',{dto:denied,mode:0,existingDirectory:true,cliCallsAdded:0});
  phase='denied-preflight';await assert.rejects(manager.preflight(config,settings),{code:'AGENT_WORK_PATH_INACCESSIBLE'});assert.equal(cliRows().length,before);
  const deniedShells=shells.filter(row=>row.phase.startsWith('denied-'));assert.equal(deniedShells.length,2);
  for(const row of deniedShells){assert.equal(row.closeObserved,true);assert.equal(row.code,125);assert.match(row.stderr,/Permission denied/);assert.ok(row.stderr.includes(folderMessage));}
  check('preflight retains folder error',{cliCallsAdded:0,originalShellExitCodes:deniedShells.map(row=>row.code)});
  fs.chmodSync(restricted,0o700);phase='restored';const restored=await manager.preflight(config,settings);assert.equal(restored.installed,true);assert.equal(restored.version,normal.version);assert.equal(restored.authState,'authenticated');check('same folder and CLI restored',{dto:restored,mode:fs.statSync(restricted).mode&0o777});
  phase='missing-cli';const missing=await manager.environment(config,{...settings,binary:path.join(bin,'absent-cli')});assert.equal(missing.installed,false);assert.equal(missing.authState,'not_installed');assert.equal(missing.errorCode,'AGENT_NOT_INSTALLED');check('missing CLI remains distinct',{dto:missing});
  const rows=cliRows();assert.equal(rows.length,4);assert.ok(rows.every(row=>JSON.stringify(row.args)==='["--version"]'||JSON.stringify(row.args)==='["login","status"]'));
  assert.deepEqual(shells.map(row=>row.phase),['normal','normal','denied-environment','denied-preflight','restored','restored','missing-cli']);
  assert.equal(manager.size,0);assert.deepEqual(manager.list(),[]);assert.equal(updates,0);assert.equal(hash(fs.readFileSync(binary)),binarySHA);
  report.fixtureCLI={path:binary,sha256:binarySHA,calls:rows};
 }catch(error){primaryError=error;report.error={name:error.name,message:error.message};save();}
 finally{
  phase='cleanup';fs.chmodSync(restricted,0o700);report.restoredMode=fs.statSync(restricted).mode&0o777;
  try{
   await bounded(Promise.all(pending),'Owned shell/channel/client');
   await manager.closeAll();await bounded(new Promise(resolve=>server.close(()=>{serverClosed=true;resolve();})),'Owned SSH server');
   const observedCLI=cliRows();unexpectedRequests+=observedCLI.filter(row=>JSON.stringify(row.args)!=='["--version"]'&&JSON.stringify(row.args)!=='["login","status"]').length;
   report.cleanup={status:'confirmed',serverClosed,jobs:manager.size,updates,unexpectedRequests};
   assertClosures({serverClosed,jobs:manager.size,updates,unexpectedRequests,shells,channels,clients});
  }catch(error){report.cleanup={status:'unconfirmed',error:error.message,serverClosed};primaryError||=error;}
  try{const rows=cliRows();report.fixtureCLI={path:binary,sha256:hash(fs.readFileSync(binary)),calls:rows,finalObservation:report.cleanup.status==='confirmed'};report.modelRequests=rows.filter(row=>row.args[0]==='app-server').length;}catch(error){report.fixtureLogError=error.message;primaryError||=error;}
  report.agentJobs=manager.size;report.ok=!primaryError;report.completedAt=new Date().toISOString();save();
  // Keep the owned fixture tree and logs for both success and failure. No PID lookup,
  // process signal, forced disconnect, or recursive cleanup is used by this driver.
 }
 if(primaryError)throw primaryError;
 console.log(JSON.stringify({ok:true,source,output,criterion:'QA-034-004',newFormalQAIDs:0,agentJobs:0,modelRequests:0,cleanup:report.cleanup}));
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)run().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
