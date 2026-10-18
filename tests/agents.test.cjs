'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Server, utils } = require('ssh2');
const { createAgentManager, normalizeSettings, buildArguments, modelOptions } = require('../electron/agents.cjs');
const { fingerprintOf } = require('../electron/ssh.cjs');
const remoteAgent = require('../electron/remote-agent.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function eventually(check) {for(let attempt=0;attempt<200;attempt++){const result=await check();if(result)return result;await pause(20);}assert.fail('Expected agent state was not received');}
async function completed(manager,id){return eventually(()=>{const job=manager.read(id);return ['completed','failed','cancelled'].includes(job.status)?job:null;});}
async function updateReady(manager,id){return eventually(()=>{const job=manager.read(id);return job.status==='running'&&job.remoteExecution?.ready&&manager.hasBlockingJobs===false?job:null;});}
function killFixtureProcess(pid,group=false,kill=process.kill){
 if(!Number.isSafeInteger(pid)||pid<=1)return false;
 try{kill(group?-pid:pid,'SIGKILL');return true;}catch{return false;}
}
const executable = `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process');
const args=process.argv.slice(2), cwd=process.cwd();
const writePid=(name,pid)=>{const target=cwd+'/'+name;fs.writeFileSync(target+'.tmp',String(pid));fs.renameSync(target+'.tmp',target);};
if(args[0]==='--version'){if(fs.existsSync(cwd+'/hang-probe')){writePid('probe.pid',process.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}console.log('codex-cli synthetic-1.0');process.exit(0);}
if(args[0]==='login'&&args[1]==='status'){process.exit(fs.existsSync(cwd+'/unauthenticated')?1:0);}
if(args[0]==='logout'){fs.writeFileSync(cwd+'/unauthenticated','');process.exit(0);}
if(args[0]==='login'){console.log('Open https://auth.example.test/device and enter TEST-1234');setTimeout(()=>{try{fs.unlinkSync(cwd+'/unauthenticated')}catch{};process.exit(0)},150);return;}
if(args[0]==='app-server'){
 const file=process.env.CODEX_HOME+'/app-server-models.json';
 if(!fs.existsSync(file)){console.error('Synthetic app-server is unavailable');process.exit(2);}
 const options=JSON.parse(fs.readFileSync(file,'utf8'));
 writePid('model-server.pid',process.pid);
 if(options.ignoreTerm)process.on('SIGTERM',()=>{});
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);fs.appendFileSync(cwd+'/model-requests.jsonl',JSON.stringify(message)+'\\n');
  const send=result=>process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
  if(message.method==='initialize')send({});
  else if(message.method==='initialized')return;
  else if(message.method==='config/read'){
   if(options.configError)process.stdout.write(JSON.stringify({id:message.id,error:{code:-32601,message:'synthetic secret token'}})+'\\n');
   else send({config:options.config||{}});
  }else if(message.method==='model/list'){
   if(options.hang)return;
   if(options.invalidJson){process.stdout.write('not-json\\n');return;}
   if(options.oversized){send({data:[{model:'huge',displayName:'x'.repeat(3*1024*1024)}]});return;}
   if(options.modelError){process.stdout.write(JSON.stringify({id:message.id,error:{code:-32601,message:'synthetic secret token'}})+'\\n');return;}
   send(options.pages?.[message.params.cursor||'first']||{data:[],nextCursor:null});
  }else{fs.writeFileSync(cwd+'/forbidden-rpc',message.method);process.exit(3);}
 });return;
}
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const images=args.flatMap((arg,index)=>arg==='-i'?[{path:args[index+1],bytes:fs.readFileSync(args[index+1]).toString('base64'),mode:fs.statSync(args[index+1]).mode&0o777}]:[]);
 const files=input.split('\\n').filter(line=>line.startsWith('"')&&line.includes(': /')).map(line=>{const location=line.slice(line.indexOf(': /')+2);return {path:location,bytes:fs.readFileSync(location).toString('base64'),mode:fs.statSync(location).mode&0o777};});
 fs.writeFileSync(cwd+'/last-input.json',JSON.stringify({args,input,cwd,pid:process.pid,images,files,codexHome:process.env.CODEX_HOME,loginProfile:process.env.REVIEWOPS_FIXTURE_LOGIN||''}));
 fs.appendFileSync(cwd+'/request-starts','1');
 const send=event=>process.stdout.write(JSON.stringify(event)+'\\n');
 send({type:'thread.started',thread_id:'synthetic-thread'});send({type:'turn.started'});
 if(input.includes('WAIT_FOR_CANCEL')){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writePid('child.pid',child.pid);if(input.includes('FINAL_ON_CANCEL'))process.on('SIGTERM',()=>{fs.writeSync(1,JSON.stringify({type:'item.completed',item:{id:'last-answer',type:'agent_message',text:'중지 직전 마지막 응답'}})+'\\n');process.exit(0);});setInterval(()=>{},1000);return;}
 if(input.includes('FAIL_TURN')){send({type:'turn.failed',error:{message:'Synthetic request failure'}});process.exitCode=1;return;}
 send({type:'item.started',item:{id:'command-1',type:'command_execution',command:'echo secret',status:'in_progress'}});
 send({type:'item.completed',item:{id:'command-1',type:'command_execution',status:'completed',exit_code:0}});
 const response=JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'작업 완료: '+input}})+'\\n';const bytes=Buffer.from(response),split=bytes.indexOf(Buffer.from('작업'))+1;
 process.stdout.write(bytes.subarray(0,split));setTimeout(()=>{process.stdout.write(bytes.subarray(split));send({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}})},input.includes('FINISH_AFTER_RESTART')?1200:25);
});
`;
async function fixture(t,options={}) {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-agent-')),root=path.join(base,"project ' folder"),bin=path.join(base,'bin'),home=path.join(base,'home');
 await fs.mkdir(root);await fs.mkdir(bin);await fs.mkdir(path.join(home,'.codex'),{recursive:true});
 const binary=path.join(bin,'codex');await fs.writeFile(binary,executable,{mode:0o755});
 await fs.writeFile(path.join(home,'.codex/models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',display_name:'Fixture model',supported_reasoning_levels:[{effort:'low'},{effort:'high'}],default_reasoning_level:'high'}]}));
 const updates=[];const manager=createAgentManager({env:{...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:bin+path.delimiter+process.env.PATH},onUpdate:job=>updates.push(job),killTimeoutMs:100,commandTimeoutMs:3000,...options});
 t.after(async()=>{await manager.closeAll();try{killFixtureProcess(Number(await fs.readFile(path.join(root,'child.pid'),'utf8')));}catch{}await fs.rm(base,{recursive:true,force:true});});
 return {base,root,bin,home,binary,manager,updates,config:{id:'service',kind:'local',rootPath:root},settings:{binary,model:'fixture-model',reasoningEffort:'high'}};
}

test('fixture cleanup never signals PID zero, one or invalid process identifiers',()=>{
 const signals=[],kill=(pid,signal)=>signals.push({pid,signal});
 for(const pid of [Number(''),0,1,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,undefined])for(const group of [false,true])assert.equal(killFixtureProcess(pid,group,kill),false);
 assert.deepEqual(signals,[]);
 assert.equal(killFixtureProcess(42,false,kill),true);assert.equal(killFixtureProcess(42,true,kill),true);
 assert.deepEqual(signals,[{pid:42,signal:'SIGKILL'},{pid:-42,signal:'SIGKILL'}]);
});

test('agent arguments bypass approvals and sandbox for fresh and resumed CLI requests while preserving model, effort and stdin',()=>{
 const settings=normalizeSettings({binary:'/opt/Codex Tool/codex',model:'model; touch /tmp/never',reasoningEffort:'high',workPath:'/tmp/work'},{kind:'local'});
 const expected=['exec','--json','--skip-git-repo-check','--model','model; touch /tmp/never','-c','model_reasoning_effort="high"','--dangerously-bypass-approvals-and-sandbox'];
 assert.deepEqual(buildArguments(settings),[...expected,'-']);
 assert.deepEqual(buildArguments(settings,'thread-id'),[...expected,'resume','thread-id','-']);
 assert.throws(()=>buildArguments(settings,'bad;id'),{code:'AGENT_SESSION_INVALID'});
 assert.throws(()=>normalizeSettings({workPath:'relative'},{}),{code:'AGENT_CONFIG_INVALID'});
 assert.throws(()=>normalizeSettings({provider:'unknown',workPath:'/tmp'},{}),{code:'AGENT_PROVIDER_INVALID'});
});

test('remote result detection rechecks completion after the runner exits during its process check',async t=>{
 const id='completion-race-'+crypto.randomUUID(),directory=remoteAgent.directory(id),bin=path.join(directory,'bin');
 await fs.mkdir(bin,{recursive:true,mode:0o700});
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.writeFile(path.join(directory,'stdout'),'');await fs.writeFile(path.join(directory,'stderr'),'');await fs.writeFile(path.join(directory,'pid'),'99999999');
 await fs.writeFile(path.join(bin,'ps'),`#!/bin/sh\nprintf '0\\n' > '${directory}/result'\n`,{mode:0o700});
 const result=await new Promise((resolve,reject)=>{
  const child=spawn('/bin/bash',['-c',remoteAgent.read(id)],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}}),output=[];
  child.stdout.on('data',chunk=>output.push(chunk));child.once('error',reject);child.once('close',code=>code===0?resolve(remoteAgent.parseRead(Buffer.concat(output).toString())):reject(new Error('원격 작업 결과 검사 실패')));
 });
 assert.equal(result.state,'done');assert.equal(result.code,0);
});

test('Windows agent workspaces accept drive and share paths while SSH keeps server paths', () => {
 for(const workPath of ['C:\\Users\\Operator\\work', '\\\\server\\share\\work']) assert.equal(normalizeSettings({workPath},{kind:'local'},'win32').workPath,workPath);
 assert.equal(normalizeSettings({workPath:'/srv/work'},{kind:'ssh'},'win32').workPath,'/srv/work');
 assert.throws(()=>normalizeSettings({workPath:'C:\\work'},{kind:'ssh'},'win32'),{code:'AGENT_CONFIG_INVALID'});
 assert.throws(()=>normalizeSettings({workPath:'relative'},{kind:'local'},'win32'),{code:'AGENT_CONFIG_INVALID'});
});

test('Windows local agents resolve npm wrappers and cancel the whole process tree without a shell', async t => {
 const calls=[],resolved=[],children=new Map();let nextPid=45000;
 const spawnImpl=(command,args,options)=>{
  calls.push({command,args,options});
  const child=Object.assign(new EventEmitter(),{pid:++nextPid,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough()});children.set(child.pid,child);
  if(command==='taskkill.exe')setImmediate(()=>{children.get(Number(args[1])).emit('close',null,'SIGKILL');child.emit('close',0);});
  else if(args[0]==='--version')setImmediate(()=>{child.stdout.write('codex-cli 0.161.0\n');child.emit('close',0);});
  else if(args[0]==='login')setImmediate(()=>child.emit('close',0));
  else child.stdin.on('finish',()=>child.stdout.write(JSON.stringify({type:'thread.started',thread_id:'windows-thread'})+'\n'));
  return child;
 };
 const f=await fixture(t,{platform:'win32',env:{Path:'C:\\Windows\\System32',APPDATA:'C:\\Users\\Operator\\AppData\\Roaming'},spawn:spawnImpl,findRuntime:async custom=>{resolved.push(custom);return{available:true,path:'C:\\Codex\\codex.exe',command:'C:\\Codex\\codex.exe',args:[]};}});
 const binary='C:\\Users\\Operator\\AppData\\Roaming\\npm\\codex.cmd';
 const job=f.manager.start({config:f.config,settings:{...f.settings,binary},prompt:'Keep running until cancelled'});
 await eventually(()=>f.manager.read(job.id).sessionId==='windows-thread');
 const stopped=await f.manager.cancel(job.id);
 assert.equal(stopped.status,'cancelled');assert.equal(stopped.terminationConfirmed,true);
 assert.ok(resolved.length>=2);assert.ok(resolved.every(value=>value===binary));
 const cliCalls=calls.filter(call=>call.command!=='taskkill.exe');
 assert.ok(cliCalls.every(call=>call.command==='C:\\Codex\\codex.exe'&&call.options.shell===false&&call.options.windowsHide===true&&call.options.detached===false));
 assert.equal(cliCalls[0].options.env.Path,undefined);assert.match(cliCalls[0].options.env.PATH,/C:\\Windows\\System32;C:\\Users\\Operator\\AppData\\Roaming\\npm/);
 const kill=calls.find(call=>call.command==='taskkill.exe');assert.deepEqual(kill.args.slice(2),['/T','/F']);assert.equal(kill.options.shell,false);
});

test('agent preflight shares start validation without creating a job, process or SSH connection',async()=>{
 let spawnCalls=0,connections=0,updates=0;
 const manager=createAgentManager({spawn(){spawnCalls++;throw new Error('No process expected');},ssh2:{Client:class{constructor(){connections++;throw new Error('No SSH expected');}}},onUpdate(){updates++;}});
 const valid={id:'preflight-only',config:{id:'service',kind:'ssh',rootPath:'/work',host:'example.test',username:'tester'},settings:{binary:'codex',instructions:'한국어로 응답하십시오.'},prompt:'자료를 검토하십시오.',images:[{mimeType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64')}],files:[{name:'자료.txt',bytes:Buffer.from('자료')}]};
 manager.validateStart(valid);manager.validateStart(valid);
 for(const [patch,code] of [
  [{prompt:'bad\0prompt'},'AGENT_PROMPT_INVALID'],
  [{settings:{workPath:'relative'}},'AGENT_CONFIG_INVALID'],
  [{config:{...valid.config,host:''}},'SSH_CONFIG_INVALID'],
  [{sessionId:'invalid;session'},'AGENT_SESSION_INVALID'],
  [{images:[{mimeType:'image/png',bytes:Buffer.from('not an image')}]},'AGENT_IMAGES_INVALID'],
  [{files:[{name:'large.bin',bytes:Buffer.alloc(20*1024*1024+1)}]},'AGENT_FILES_INVALID'],
 ])for(const operation of ['validateStart','start'])assert.throws(()=>manager[operation]({...valid,...patch}),{code});
 const prompt='한'.repeat(87380),instructions='x'.repeat(3);
 assert.equal(Buffer.byteLength(prompt)+Buffer.byteLength(instructions),256*1024-1);
 for(const operation of ['validateStart','start'])assert.throws(()=>manager[operation]({...valid,prompt,settings:{instructions}}),{code:'AGENT_PROMPT_INVALID'});
 manager.validateStart({...valid,prompt,settings:{instructions:'xx'}});
 assert.equal(manager.size,0);assert.deepEqual(manager.list(),[]);assert.equal(spawnCalls,0);assert.equal(connections,0);assert.equal(updates,0);
 await manager.closeAll();
});

test('local agent probes fixture authentication and available model cache without running a request',async t=>{
 const f=await fixture(t),status=await f.manager.environment(f.config,f.settings);
 assert.equal(status.installed,true);assert.equal(status.loggedIn,true);assert.equal(status.version,'codex-cli synthetic-1.0');
 assert.deepEqual(status.models,[{id:'fixture-model',label:'Fixture model',reasoning:['low','high'],defaultReasoningEffort:'high'}]);
 assert.equal(status.modelSource,'cache');assert.match(status.modelError,/모델 목록을 읽지 못했습니다/);
 await assert.rejects(fs.access(path.join(f.root,'last-input.json')));
 const missing=await f.manager.environment(f.config,{binary:path.join(f.bin,'missing')});assert.equal(missing.installed,false);
});

test('local execution streams UTF8 progress, preserves prompt and completes with response/session',async t=>{
 const f=await fixture(t),prompt='파일을 수정하십시오. $HOME `whoami` $(echo x)';
 const job=f.manager.start({reviewId:'review-1',config:f.config,settings:{...f.settings,instructions:'한국어로 응답하십시오.'},prompt});
 assert.equal(job.status,'running');assert.equal(job.response,'');
 const result=await completed(f.manager,job.id);assert.equal(result.status,'completed');assert.equal(result.sessionId,'synthetic-thread');assert.ok(result.response.includes(prompt));assert.equal(result.response.includes('\ufffd'),false);
 assert.ok(result.progress.some(row=>row.message==='명령 실행 완료'));assert.deepEqual(result.usage,{input_tokens:12,output_tokens:8});assert.equal(result.terminationConfirmed,true);
 const recorded=JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8'));assert.equal(recorded.input,'한국어로 응답하십시오.\n\n'+prompt);assert.equal(recorded.cwd,await fs.realpath(f.root));assert.ok(f.updates.filter(update=>update.id===job.id).length>3);
 const continued=f.manager.start({reviewId:'review-1',config:f.config,settings:f.settings,sessionId:result.sessionId,prompt:'계속하십시오.'});assert.equal((await completed(f.manager,continued.id)).status,'completed');
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8')).args.slice(-3),['resume','synthetic-thread','-']);
});

test('local authentication failure stops before any paid CLI request and device login can finish',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'unauthenticated'),'');
 const failed=f.manager.start({config:f.config,settings:f.settings,prompt:'요청'}),result=await completed(f.manager,failed.id);
 assert.equal(result.status,'failed');assert.equal(result.errorCode,'AGENT_AUTH_REQUIRED');await assert.rejects(fs.access(path.join(f.root,'last-input.json')));
 const login=f.manager.login({config:f.config,settings:f.settings});await eventually(()=>f.manager.read(login.id).output.includes('TEST-1234'));assert.equal((await completed(f.manager,login.id)).status,'completed');assert.equal((await f.manager.environment(f.config,f.settings)).loggedIn,true);
 const loggedOut=await f.manager.logout(f.config,f.settings);assert.equal(loggedOut.loggedIn,false);
});

test('local cancellation stops the CLI process group including a child that ignores SIGTERM',async t=>{
 const f=await fixture(t),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL',images:[{name:'test.png',mimeType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64')}]});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 await pause(150);const stopped=await f.manager.cancel(job.id);assert.equal(stopped.status,'cancelled');assert.equal(stopped.terminationConfirmed,true);
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
 const image=JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8')).images[0];await assert.rejects(fs.access(image.path));
 assert.equal(f.manager.size,0);assert.equal((await f.manager.cancel(job.id)).status,'cancelled');
});

test('failed turns and cancellation during startup do not become successful responses',async t=>{
 const f=await fixture(t);const failed=f.manager.start({config:f.config,settings:f.settings,prompt:'FAIL_TURN'});const result=await completed(f.manager,failed.id);assert.equal(result.status,'failed');assert.equal(result.error,'Synthetic request failure');
 const job=f.manager.start({config:f.config,settings:f.settings,prompt:'never run'});assert.equal((await f.manager.cancel(job.id)).status,'cancelled');
 assert.throws(()=>f.manager.start({config:f.config,settings:f.settings,prompt:'x'.repeat(256*1024+1)}),{code:'AGENT_PROMPT_INVALID'});
 assert.throws(()=>f.manager.read('missing'),{code:'AGENT_JOB_NOT_FOUND'});
});

const hostKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
const fingerprint=fingerprintOf(utils.parseKey(hostKey).getPublicSSH());
async function remoteFixture(t,options={}) {
 const f=await fixture(t,options.managerOptions||{}),clients=new Set(),processes=new Set(),heldLaunchResponses=new Set();let authentications=0,rejectedStops=0,launchResponseReleased=!options.holdLaunchResponse;
 if(options.loginProfile) {
  f.profileCodexHome=path.join(f.home,'profile-codex');
  await fs.mkdir(f.profileCodexHome);
  await fs.writeFile(path.join(f.profileCodexHome,'models_cache.json'),JSON.stringify({models:[{slug:'profile-model',display_name:'Profile model'}]}));
  const shellQuote=value=>`'${value.replace(/'/g,`'"'"'`)}'`;
  await fs.writeFile(path.join(f.home,'.bash_profile'),`export PATH=${shellQuote(f.bin)}:"$PATH"\nexport CODEX_HOME=${shellQuote(f.profileCodexHome)}\nexport REVIEWOPS_FIXTURE_LOGIN=loaded\n`);
 }
 // macOS does not ship setsid. This fixture creates the same detached process group.
 await fs.writeFile(path.join(f.bin,'setsid'),`#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='--wait')a.shift();const c=spawn(a.shift(),a,{detached:true,stdio:'inherit'});c.on('error',()=>process.exit(127));c.on('exit',(code,signal)=>process.exit(code===null?143:code));\n`,{mode:0o755});
 const server=new Server({hostKeys:[hostKey]},client=>{
  clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
  client.on('authentication',context=>{authentications++;if(context.method==='password'&&context.username==='tester'&&context.password==='fixture-password')context.accept();else context.reject();});
  client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('sftp',accept=>{
   const sftp=accept(),handles=new Map();let next=0;
   sftp.on('OPEN',async(id,file,flags,attrs)=>{try{const handle=await fs.open(file,'wx',attrs.mode||0o600),key=String(++next);handles.set(key,handle);sftp.handle(id,Buffer.from(key));}catch(error){sftp.status(id,4,error.message);}});
   sftp.on('WRITE',async(id,key,offset,data)=>{try{await handles.get(key.toString()).write(data,0,data.length,offset);sftp.status(id,0);}catch(error){sftp.status(id,4,error.message);}});
   sftp.on('CLOSE',async(id,key)=>{try{await handles.get(key.toString()).close();handles.delete(key.toString());sftp.status(id,0);}catch(error){sftp.status(id,4,error.message);}});
  });session.on('exec',(accept,reject,info)=>{
   const channel=accept();channel.on('error',()=>{});
   if(options.rejectLaunch&&info.command.includes('nohup setsid bash')){channel.exit(127);channel.end();return;}
   if(info.command.startsWith("bash -c 'd=")&&(options.rejectStop||options.rejectStopOnce&&rejectedStops++===0)){channel.exit(1);channel.end();return;}
   const child=spawn('/bin/bash',['-c',info.command],{env:{...process.env,PATH:f.bin+path.delimiter+process.env.PATH,HOME:f.home,CODEX_HOME:path.join(f.home,'.codex')},stdio:['pipe','pipe','pipe'],detached:true});processes.add(child);
   channel.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.pipe(channel,{end:false});child.stderr.pipe(channel.stderr,{end:false});
   child.on('close',(code)=>{
    processes.delete(child);
    const respond=()=>{if(!channel.destroyed){if(!(options.dropLaunchResponse&&info.command.includes('nohup setsid bash')))channel.exit(Number.isInteger(code)?code:143);channel.end();}};
    if(info.command.includes('nohup setsid bash')&&!launchResponseReleased)heldLaunchResponses.add(respond);else respond();
   });
  });}));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(async()=>{await f.manager.closeAll();for(const child of processes)killFixtureProcess(child.pid,true);for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));});
 return {...f,config:{id:'remote-service',kind:'ssh',host:'127.0.0.1',port:server.address().port,username:'tester',authType:'password',password:'fixture-password',rootPath:f.root,hostFingerprint:fingerprint},authentications:()=>authentications,disconnect:()=>{for(const client of clients)client.end();},releaseLaunchResponse:()=>{launchResponseReleased=true;for(const respond of heldLaunchResponses)respond();heldLaunchResponses.clear();}};
}

async function configureModels(f,overrides={}) {
 const options={config:{model:'host-configured-model',model_reasoning_effort:'high',api_key:'synthetic-secret-never-returned'},pages:{
  first:{data:[{id:'catalog-entry',model:'host-recommended-model',displayName:'Host recommended',supportedReasoningEfforts:[{reasoningEffort:'minimal'},{reasoningEffort:'xhigh'}],defaultReasoningEffort:'minimal',isDefault:true}],nextCursor:'page-two'},
  'page-two':{data:[{id:'different-entry-id',model:'host-configured-model',displayName:'Host configured',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}],defaultReasoningEffort:'medium'},{model:'hidden-model',hidden:true}],nextCursor:null},
 },...overrides};
 await fs.writeFile(path.join(f.profileCodexHome||path.join(f.home,'.codex'),'app-server-models.json'),JSON.stringify(options));
 return options;
}
const modelRequests=async f=>(await fs.readFile(path.join(f.root,'model-requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));

test('model catalog accepts current RPC fields, keeps CLI model IDs, and skips malformed or hidden entries',()=>{
 const options=modelOptions({data:[null,{id:'internal',model:'cli-model',displayName:'CLI model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'},'high'],defaultReasoningEffort:'high'},{model:'hidden',hidden:true},{slug:'legacy-hidden',visibility:'hidden'},{slug:17},{slug:'bad\nmodel'},{model:'cli-model'},{model:'no-efforts',supportedReasoningEfforts:{invalid:true},defaultReasoningEffort:'invalid\nvalue'}]});
 assert.deepEqual(options,[{id:'cli-model',label:'CLI model',reasoning:['low','high'],defaultReasoningEffort:'high'},{id:'no-efforts',label:'no-efforts',reasoning:[],defaultReasoningEffort:''}]);
 assert.equal(modelOptions(Array.from({length:200},(_,index)=>({model:`model-${index}`}))).length,100);
});

for(const kind of ['local','ssh'])test(`${kind} model discovery reads paginated host RPC capabilities and effective defaults without starting a task`,async t=>{
 const f=kind==='ssh'?await remoteFixture(t,{loginProfile:true}):await fixture(t);
 await configureModels(f);
 const status=await f.manager.environment(f.config,{...f.settings,binary:kind==='ssh'?'codex':f.binary});
 assert.equal(status.modelSource,'host',status.modelError);assert.equal(status.modelError,'');
 assert.deepEqual(status.models,[{id:'host-recommended-model',label:'Host recommended',reasoning:['minimal','xhigh'],defaultReasoningEffort:'minimal'},{id:'host-configured-model',label:'Host configured',reasoning:['medium','high'],defaultReasoningEffort:'medium'}]);
 assert.equal(status.defaultModel,'host-configured-model');assert.equal(status.defaultReasoningEffort,'high');
 assert.equal(JSON.stringify(status).includes('synthetic-secret'),false);
 const requests=await modelRequests(f);
 assert.deepEqual(requests.map(row=>row.method),['initialize','initialized','config/read','model/list','model/list']);
 assert.equal(requests[4].params.cursor,'page-two');assert.equal(requests[3].params.includeHidden,false);
 await assert.rejects(fs.access(path.join(f.root,'last-input.json')));await assert.rejects(fs.access(path.join(f.root,'forbidden-rpc')));
});

test('host default model uses the recommendation only when effective configuration omits it',async t=>{
 const f=await fixture(t);await configureModels(f,{config:{}});
 const status=await f.manager.environment(f.config,f.settings);
 assert.equal(status.defaultModel,'host-recommended-model');assert.equal(status.defaultReasoningEffort,'minimal');
});

test('agent execution checks authentication without querying model RPC again',async t=>{
 const f=await fixture(t);await configureModels(f);await f.manager.environment(f.config,f.settings);
 const before=await modelRequests(f);
 const job=f.manager.start({config:f.config,settings:f.settings,prompt:'Synthetic execution without a model query'});
 assert.equal((await completed(f.manager,job.id)).status,'completed');
 assert.deepEqual(await modelRequests(f),before);
});

for(const kind of ['local','ssh'])test(`${kind} malformed model RPC falls back to that host's cache and keeps safe effective defaults`,async t=>{
 const f=kind==='ssh'?await remoteFixture(t,{loginProfile:true}):await fixture(t);
 await configureModels(f,{invalidJson:true});
 const status=await f.manager.environment(f.config,f.settings);
 assert.equal(status.modelSource,'cache');assert.match(status.modelError,/모델 목록을 읽지 못했습니다/);
 assert.equal(status.models[0].id,kind==='ssh'?'profile-model':'fixture-model');
 assert.equal(status.defaultModel,'host-configured-model');assert.equal(status.defaultReasoningEffort,'high');
 assert.equal(JSON.stringify(status).includes('synthetic-secret'),false);
});

test('unsupported model RPC with no cache returns no invented models and a useful message',async t=>{
 const f=await fixture(t);await fs.rm(path.join(f.home,'.codex','models_cache.json'));
 const started=Date.now(),status=await f.manager.environment(f.config,f.settings);
 assert.equal(status.installed,true);assert.equal(status.modelSource,'none');assert.deepEqual(status.models,[]);
 assert.match(status.modelError,/모델 목록을 읽지 못했습니다/);assert.ok(Date.now()-started<2000);
});

test('RPC method errors preserve the safe code boundary and fall back to the cache',async t=>{
 const f=await fixture(t);await configureModels(f,{modelError:true});
 const status=await f.manager.environment(f.config,f.settings);
 assert.equal(status.modelSource,'cache');assert.equal(JSON.stringify(status).includes('synthetic secret'),false);
});

test('host model recommendations remain usable when older CLI versions cannot read effective configuration',async t=>{
 const f=await fixture(t);await configureModels(f,{configError:true});
 const status=await f.manager.environment(f.config,f.settings);
 assert.equal(status.modelSource,'host');assert.equal(status.defaultModel,'host-recommended-model');assert.equal(status.defaultReasoningEffort,'minimal');
 assert.match(status.modelError,/기본 모델 설정을 읽지 못했습니다/);
});

test('Windows model discovery resolves the native npm runtime and preserves its launch arguments without a shell',async t=>{
 const calls=[],resolved=[],children=new Map();let nextPid=25000;
 const spawnImpl=(command,args,options)=>{
  calls.push({command,args,options});
  const child=new EventEmitter();child.pid=nextPid++;child.exitCode=null;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();children.set(child.pid,child);
  const close=(target,code=0)=>{if(target.exitCode!==null)return;target.exitCode=code;target.emit('close',code);};
  child.kill=()=>{close(child);return true;};
  if(command==='taskkill.exe')setImmediate(()=>{close(children.get(Number(args[1])));close(child);});
  else if(args.includes('--version'))setImmediate(()=>{child.stdout.write('codex-cli synthetic-windows\n');close(child);});
  else if(args.includes('login'))setImmediate(()=>close(child));
  else {
   assert.deepEqual(args,['--runtime-flag','app-server']);
   let buffer='';child.stdin.on('data',chunk=>{
    buffer+=chunk;
    let boundary;
    while((boundary=buffer.indexOf('\n'))>=0){
     const message=JSON.parse(buffer.slice(0,boundary));buffer=buffer.slice(boundary+1);
     if(message.method==='initialized')continue;
     let result;
     if(message.method==='initialize')result={};
     else if(message.method==='config/read')result={config:{model:'windows-host-model',model_reasoning_effort:'high'}};
     else {assert.equal(message.method,'model/list');result={data:[{model:'windows-host-model',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null};}
     child.stdout.write(JSON.stringify({id:message.id,result})+'\n');
    }
   });
  }
  return child;
 };
 const f=await fixture(t,{platform:'win32',spawn:spawnImpl,findRuntime:async custom=>{resolved.push(custom);return {available:true,command:'C:\\Native Codex\\codex.exe',path:'C:\\Native Codex\\codex.exe',args:['--runtime-flag']};}});
 const binary='C:\\Users\\Operator\\AppData\\Roaming\\npm\\codex.cmd';
 const status=await f.manager.environment(f.config,{...f.settings,binary});
 assert.deepEqual(resolved,[binary]);assert.equal(status.modelSource,'host',status.modelError);assert.equal(status.models[0].id,'windows-host-model');
 assert.equal(status.defaultModel,'windows-host-model');assert.equal(status.defaultReasoningEffort,'high');
 const processes=calls.filter(call=>call.command!=='taskkill.exe');
 assert.equal(processes.length,3);assert.ok(processes.every(call=>call.command==='C:\\Native Codex\\codex.exe'&&call.options.shell===false&&call.options.windowsHide===true&&call.options.detached===false));
});

for(const failure of ['repeated cursor','too many pages','oversized response'])test(`model discovery bounds ${failure} and recovers with the cache`,async t=>{
 const f=await fixture(t),pages={first:{data:[],nextCursor:'next'}};
 if(failure==='repeated cursor')pages.next={data:[],nextCursor:'next'};
 if(failure==='too many pages'){pages.next={data:[],nextCursor:'page2'};for(let i=2;i<=5;i++)pages[`page${i}`]={data:[],nextCursor:`page${i+1}`};}
 await configureModels(f,{pages,oversized:failure==='oversized response'});
 const status=await f.manager.environment(f.config,f.settings);
 assert.equal(status.modelSource,'cache');assert.equal(status.models[0].id,'fixture-model');
 assert.ok((await modelRequests(f)).filter(row=>row.method==='model/list').length<=5);
});

test('model query timeout terminates the RPC process and recovers with the cache',async t=>{
 const f=await fixture(t,{commandTimeoutMs:1000});await configureModels(f,{hang:true,ignoreTerm:true});
 const status=await f.manager.environment(f.config,f.settings);
 assert.equal(status.modelSource,'cache');
 const pid=Number(await fs.readFile(path.join(f.root,'model-server.pid'),'utf8'));
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
});

for(const kind of ['local','ssh'])test(`${kind} app shutdown also stops a hanging model RPC and does not detach it as a server task`,async t=>{
 const f=kind==='ssh'?await remoteFixture(t):await fixture(t);await configureModels(f,{hang:true,ignoreTerm:true});
 const pending=f.manager.environment(f.config,f.settings).then(value=>value,error=>({error:error.code}));
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'model-server.pid'),'utf8'));}catch{return false;}});
 await f.manager.closeAll({preserveRemote:true});
 const status=await pending;assert.equal(status.error,'AGENT_CLOSING');
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
});

test('SSH agent refuses missing or changed host trust before sending credentials',async t=>{
 const f=await remoteFixture(t);
 await assert.rejects(f.manager.environment({...f.config,hostFingerprint:''},f.settings),error=>error.code==='SSH_TRUST_REQUIRED'&&error.fingerprint===fingerprint);assert.equal(f.authentications(),0);
 await assert.rejects(f.manager.environment({...f.config,hostFingerprint:`SHA256:${'a'.repeat(43)}`},f.settings),{code:'SSH_HOST_KEY_CHANGED'});assert.equal(f.authentications(),0);
});

test('SSH execution streams over pinned direct connection, quotes paths and resumes the same session',async t=>{
 const f=await remoteFixture(t),env=await f.manager.environment(f.config,f.settings);assert.equal(env.loggedIn,true);assert.equal(env.models[0].id,'fixture-model');
 const job=f.manager.start({config:f.config,settings:f.settings,reviewId:'review-ssh',sessionId:'prior-thread',prompt:'SSH 요청 $HOME `touch /tmp/never`'}),result=await completed(f.manager,job.id);
 assert.equal(result.status,'completed',result.error);assert.equal(result.sessionId,'synthetic-thread');assert.equal(result.terminationConfirmed,true);
 const input=JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8'));assert.equal(input.input,'SSH 요청 $HOME `touch /tmp/never`');assert.equal(input.cwd,await fs.realpath(f.root));assert.deepEqual(input.args.slice(-3),['resume','prior-thread','-']);
 assert.ok(input.args.includes('--dangerously-bypass-approvals-and-sandbox'));assert.equal(input.args.some(arg=>arg.includes('sandbox_mode=')),false);
 await eventually(async()=>{try{await fs.access(`/tmp/reviewops-agent-${job.id}`);return false;}catch{return true;}});
});

test('SSH CLI, model cache and stored sessions share the server login profile environment',async t=>{
 const f=await remoteFixture(t,{loginProfile:true}),settings={...f.settings,binary:'codex',model:'profile-model'};
 const status=await f.manager.environment(f.config,settings);assert.equal(status.installed,true,status.error);assert.equal(status.loggedIn,true);assert.equal(status.models[0].id,'profile-model');
 const sessionId='login-profile-session',directory=path.join(f.profileCodexHome,'sessions');await fs.mkdir(directory);
 await fs.writeFile(path.join(directory,`rollout-${sessionId}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:sessionId,cwd:f.root,model:'profile-model'}})+'\n');
 const session=await f.manager.session(f.config,settings,sessionId);assert.equal(session.available,true);assert.equal(session.model,'profile-model');
 const job=f.manager.start({config:f.config,settings,sessionId,prompt:'프로필 환경을 사용하십시오.'});const result=await completed(f.manager,job.id);assert.equal(result.status,'completed',result.error);
 const record=JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8'));assert.equal(record.loginProfile,'loaded');assert.equal(record.codexHome,f.profileCodexHome);assert.deepEqual(record.args.slice(-3),['resume',sessionId,'-']);
});

test('SSH startup failures explain missing CLI and inaccessible work folders without sending a request',async t=>{
 const f=await remoteFixture(t);
 const missing=await f.manager.environment(f.config,{...f.settings,binary:path.join(f.bin,'missing')});assert.equal(missing.installed,false);assert.match(missing.error,/Codex 실행 파일을 찾을 수 없거나 실행 권한이 없습니다/);
 const folder=await f.manager.environment(f.config,{...f.settings,workPath:path.join(f.root,'missing-folder')});assert.equal(folder.installed,false);assert.match(folder.error,/SSH 계정으로 에이전트 작업 폴더를 열 수 없습니다/);
 await assert.rejects(fs.access(path.join(f.root,'last-input.json')));
});

test('SSH cancellation confirms process group termination instead of only closing the connection',async t=>{
 const f=await remoteFixture(t),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL',images:[{name:'test.png',mimeType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64')}]});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 await pause(150);const result=await f.manager.cancel(job.id);assert.equal(result.status,'cancelled');assert.equal(result.terminationConfirmed,true);
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
 const image=JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8')).images[0];await assert.rejects(fs.access(image.path));
});

test('SSH requests keep running during an app update and restore finished UTF8 output without duplicate execution',async t=>{
 const f=await remoteFixture(t,{managerOptions:{remotePollMs:20,remoteReconnectMs:30}}),prompt='FINISH_AFTER_RESTART 한글 응답 유지';
 const job=f.manager.start({config:f.config,settings:f.settings,prompt,files:[{name:'source.txt',bytes:Buffer.from('첨부 자료')}]});
 await eventually(async()=>{
  const current=f.manager.read(job.id);
  try{return current.remoteExecution?.ready && current.remoteExecution.stdoutOffset===(await fs.stat(`/tmp/reviewops-agent-${job.id}/stdout`)).size && current.output.includes('command-1');}catch{return false;}
 });
 const saved=f.manager.read(job.id),record=JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8'));
 assert.equal(f.manager.hasBlockingJobs,false);assert.equal(saved.status,'running');
 await f.manager.closeAll({preserveRemote:true});
 assert.equal(f.manager.read(job.id).cancelRequested,false);assert.doesNotThrow(()=>process.kill(record.pid,0));
 assert.equal(await fs.readFile(record.files[0].path,'utf8'),'첨부 자료');
 await pause(1400);
 const restored=createAgentManager({remotePollMs:20,remoteReconnectMs:30,commandTimeoutMs:3000});
 try {
  restored.restore({job:saved,config:f.config,settings:f.settings});
  const result=await completed(restored,job.id);
  assert.equal(result.status,'completed',result.error);assert.equal(result.sessionId,'synthetic-thread');
  assert.ok(result.response.includes(prompt));assert.equal(result.response.includes('\ufffd'),false);assert.equal(result.output.includes('\ufffd'),false);
  assert.equal(await fs.readFile(path.join(f.root,'request-starts'),'utf8'),'1');
  await eventually(async()=>{try{await fs.access(`/tmp/reviewops-agent-${job.id}`);return false;}catch{return true;}});
 } finally {await restored.closeAll();}
});

test('SSH connection loss reconnects to the same running request and reads its result',async t=>{
 const f=await remoteFixture(t,{managerOptions:{remotePollMs:20,remoteReconnectMs:30}});
 const job=f.manager.start({config:f.config,settings:f.settings,prompt:'FINISH_AFTER_RESTART 연결 복구'});
 await eventually(()=>f.manager.read(job.id).sessionId==='synthetic-thread');
 f.disconnect();
 const result=await completed(f.manager,job.id);
 assert.equal(result.status,'completed',result.error);assert.ok(result.response.includes('연결 복구'));
 assert.equal(await fs.readFile(path.join(f.root,'request-starts'),'utf8'),'1');
});

test('an interrupted SSH launch response observes the existing request without retrying execution',async t=>{
 const f=await remoteFixture(t,{dropLaunchResponse:true,managerOptions:{remotePollMs:20,remoteReconnectMs:30}});
 const job=f.manager.start({config:f.config,settings:f.settings,prompt:'FINISH_AFTER_RESTART 실행 응답 복구'});
 const result=await completed(f.manager,job.id);
 assert.equal(result.status,'completed',result.error);assert.ok(result.response.includes('실행 응답 복구'));
 assert.equal(await fs.readFile(path.join(f.root,'request-starts'),'utf8'),'1');
});

test('explicit cancellation after restoring a running SSH request stops its process group',async t=>{
 const f=await remoteFixture(t,{managerOptions:{remotePollMs:20,remoteReconnectMs:30}});
 const job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 await updateReady(f.manager,job.id);
 await eventually(()=>f.manager.read(job.id).sessionId);
 const saved=f.manager.read(job.id);
 await f.manager.closeAll({preserveRemote:true});
 const restored=createAgentManager({remotePollMs:20,remoteReconnectMs:30,commandTimeoutMs:3000});
 try {
  restored.restore({job:saved,config:f.config,settings:f.settings});
  const result=await restored.cancel(job.id);
  assert.equal(result.status,'cancelled');assert.equal(result.terminationConfirmed,true);
  await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
  assert.equal(await fs.readFile(path.join(f.root,'request-starts'),'utf8'),'1');
 } finally {await restored.closeAll();}
});

test('restoring a missing SSH execution reports failure without starting another request',async t=>{
 const f=await remoteFixture(t),job={id:'missing-'+crypto.randomUUID(),kind:'agent',status:'running',reviewId:'review',serviceId:f.config.id,sessionId:'',progress:[],remoteExecution:{version:1,ready:true,stdoutOffset:200,stderrOffset:0}};
 f.manager.restore({job,config:f.config,settings:f.settings});
 const result=await completed(f.manager,job.id);assert.equal(result.status,'failed');assert.equal(result.terminationConfirmed,false);assert.match(result.error,/다시 실행하지 않았습니다/);
 await assert.rejects(fs.access(path.join(f.root,'request-starts')));
});

test('failed SSH recovery preserves saved partial output, response and progress in every update',async t=>{
 const f=await remoteFixture(t),saved={id:'missing-'+crypto.randomUUID(),kind:'agent',status:'running',reviewId:'review',serviceId:f.config.id,sessionId:'prior-session',response:'저장된 응답',output:'저장된 출력\n',progress:[{sequence:1,state:'running',message:'저장된 진행 기록',step:'execution'}],remoteExecution:{version:1,ready:true,stdoutOffset:1024,stderrOffset:20}};
 f.manager.restore({job:saved,config:f.config,settings:f.settings});
 const result=await completed(f.manager,saved.id);
 assert.equal(result.status,'failed');assert.equal(result.response,saved.response);assert.equal(result.output,saved.output);assert.equal(result.sessionId,saved.sessionId);
 assert.ok(result.progress.some(row=>row.message==='저장된 진행 기록'));
 for(const update of f.updates.filter(row=>row.id===saved.id)){assert.equal(update.output,saved.output);assert.equal(update.response,saved.response);assert.ok(update.progress.some(row=>row.message==='저장된 진행 기록'));}
});

test('missing SSH recovery also retains preparation progress before the first output byte',async t=>{
 const f=await remoteFixture(t),saved={id:'missing-'+crypto.randomUUID(),kind:'agent',status:'running',reviewId:'review',serviceId:f.config.id,sessionId:'',response:'',output:'',progress:[{sequence:1,state:'running',message:'저장된 실행 준비 기록',step:'execution'}],remoteExecution:{version:1,ready:true,stdoutOffset:0,stderrOffset:0}};
 f.manager.restore({job:saved,config:f.config,settings:f.settings});
 const result=await completed(f.manager,saved.id);assert.equal(result.status,'failed');assert.ok(result.progress.some(row=>row.message==='저장된 실행 준비 기록'));
 for(const update of f.updates.filter(row=>row.id===saved.id))assert.ok(update.progress.some(row=>row.message==='저장된 실행 준비 기록'));
});

test('SSH recovery drains unread output after runner failure and keeps the earlier response while replaying',async t=>{
 const f=await remoteFixture(t),id='lost-'+crypto.randomUUID(),directory=`/tmp/reviewops-agent-${id}`;
 const earlier=JSON.stringify({type:'item.completed',item:{id:'earlier',type:'agent_message',text:'앞서 작성한 응답'}})+'\n';
 const answer='서버에 남은 응답 '+ '가'.repeat(30000),unread=JSON.stringify({type:'item.completed',item:{id:'latest',type:'agent_message',text:answer}})+'\n';
 await fs.mkdir(directory,{mode:0o700});await fs.writeFile(path.join(directory,'stdout'),earlier+unread);await fs.writeFile(path.join(directory,'stderr'),'마지막 서버 로그');await fs.writeFile(path.join(directory,'pid'),'99999999');
 try {
  const saved={id,kind:'agent',status:'running',reviewId:'review',serviceId:f.config.id,sessionId:'prior-session',response:'앞서 작성한 응답',output:earlier,progress:[],remoteExecution:{version:1,ready:true,stdoutOffset:Buffer.byteLength(earlier),stderrOffset:0}};
  f.manager.restore({job:saved,config:f.config,settings:f.settings});
  const result=await completed(f.manager,id);
  assert.equal(result.status,'failed');assert.equal(result.response,answer);assert.ok(result.output.includes('마지막 서버 로그'));assert.equal(result.output.includes('\ufffd'),false);
  assert.ok(f.updates.filter(row=>row.id===id).every(row=>row.response));
  await assert.rejects(fs.access(path.join(f.root,'request-starts')));
 } finally {await fs.rm(directory,{recursive:true,force:true});}
});

test('SSH launch reports missing required commands and removes only its own preparation files',async t=>{
 const f=await remoteFixture(t,{rejectLaunch:true}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'실행 명령 검사'});
 const result=await completed(f.manager,job.id);assert.equal(result.status,'failed');assert.equal(result.errorCode,'AGENT_REMOTE_START_FAILED');assert.match(result.error,/nohup 및 setsid/);
 await assert.rejects(fs.access(`/tmp/reviewops-agent-${job.id}`));await assert.rejects(fs.access(path.join(f.root,'request-starts')));
});

test('a saved SSH cancellation is sent again after app restart and still stops descendants',async t=>{
 const f=await remoteFixture(t,{holdLaunchResponse:true,managerOptions:{remotePollMs:20}}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 // A server child can start before the SSH launch acknowledgment reaches the
 // app. Updates must remain blocked until the durable control is attached.
 assert.equal(f.manager.read(job.id).remoteExecution.ready,false);assert.equal(f.manager.hasBlockingJobs,true);
 f.releaseLaunchResponse();
 const saved={...await updateReady(f.manager,job.id),cancelRequested:true};
 await f.manager.closeAll({preserveRemote:true});
 const restored=createAgentManager({remotePollMs:20,commandTimeoutMs:3000});
 try {
  restored.restore({job:saved,config:f.config,settings:f.settings});
  const result=await completed(restored,job.id);assert.equal(result.status,'cancelled');assert.equal(result.terminationConfirmed,true);
  await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
 } finally {await restored.closeAll();}
});

test('a restored SSH cancellation remains active after a failed stop and accepts another cancellation',async t=>{
 const f=await remoteFixture(t,{holdLaunchResponse:true,rejectStopOnce:true,managerOptions:{remotePollMs:20}}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 f.releaseLaunchResponse();
 const saved={...await updateReady(f.manager,job.id),cancelRequested:true};
 await f.manager.closeAll({preserveRemote:true});
 const restored=createAgentManager({remotePollMs:20,commandTimeoutMs:3000});
 try {
  restored.restore({job:saved,config:f.config,settings:f.settings});
  await eventually(()=>restored.read(job.id).errorCode==='AGENT_STOP_UNCONFIRMED');
  assert.equal(restored.read(job.id).status,'running');assert.doesNotThrow(()=>process.kill(pid,0));
  const result=await restored.cancel(job.id);assert.equal(result.status,'cancelled');assert.equal(result.terminationConfirmed,true);
  await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
 } finally {await restored.closeAll();}
});

test('an update shutdown waits for cancellation reserved in the same tick and preserves its final output',async t=>{
 const f=await remoteFixture(t,{managerOptions:{remotePollMs:50}}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL FINAL_ON_CANCEL'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 await updateReady(f.manager,job.id);
 const cancelling=f.manager.cancel(job.id);assert.equal(f.manager.hasBlockingJobs,true);
 await f.manager.closeAll({preserveRemote:true});
 const result=await cancelling;assert.equal(result.status,'cancelled');assert.equal(result.terminationConfirmed,true);assert.equal(result.response,'중지 직전 마지막 응답');
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
});

test('a new SSH request cannot overwrite or remove a prior remote execution with the same ID',async t=>{
 const f=await remoteFixture(t),id='existing-'+crypto.randomUUID(),directory=`/tmp/reviewops-agent-${id}`;
 await fs.mkdir(directory,{mode:0o700});await fs.writeFile(path.join(directory,'retained-output'),'이전 작업 결과');
 try {
  f.manager.start({id,config:f.config,settings:f.settings,prompt:'이전 작업을 덮어쓰지 마십시오.'});
  const result=await completed(f.manager,id);assert.equal(result.status,'failed');assert.equal(result.errorCode,'AGENT_REMOTE_START_FAILED');
  assert.equal(await fs.readFile(path.join(directory,'retained-output'),'utf8'),'이전 작업 결과');
  await assert.rejects(fs.access(path.join(f.root,'request-starts')));
 } finally {await fs.rm(directory,{recursive:true,force:true});}
});

test('updates keep local requests protected while remote requests are prepared for recovery',async t=>{
 const f=await fixture(t),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL'});
 await eventually(()=>f.manager.read(job.id).sessionId);
 assert.equal(f.manager.hasBlockingJobs,true);
 await f.manager.closeAll({preserveRemote:true});
 assert.equal(f.manager.read(job.id).status,'cancelled');assert.equal(f.manager.hasBlockingJobs,false);
});


test('SSH stop failures keep observing the running job and never report a confirmed cancellation',async t=>{
 const f=await remoteFixture(t,{rejectStop:true}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL',images:[{name:'test.png',mimeType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64')}]});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 const group=Number(await fs.readFile(`/tmp/reviewops-agent-${job.id}/pid`,'utf8'));
 t.after(async()=>{killFixtureProcess(group,true);killFixtureProcess(pid);await fs.rm(`/tmp/reviewops-agent-${job.id}`,{recursive:true,force:true});});
 await updateReady(f.manager,job.id);
 await assert.rejects(f.manager.cancel(job.id),{code:'AGENT_STOP_UNCONFIRMED'});
 const result=f.manager.read(job.id);assert.equal(result.status,'running');assert.equal(result.cancelRequested,true);assert.equal(result.terminationConfirmed,false);assert.equal(result.errorCode,'AGENT_STOP_UNCONFIRMED');assert.equal(f.manager.hasBlockingJobs,true);
 assert.doesNotThrow(()=>process.kill(pid,0));
 killFixtureProcess(group,true);
});

test('SSH cancellation can be retried after an unconfirmed stop without losing the running job',async t=>{
 const f=await remoteFixture(t,{rejectStopOnce:true,managerOptions:{remotePollMs:20}}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 await updateReady(f.manager,job.id);
 await assert.rejects(f.manager.cancel(job.id),{code:'AGENT_STOP_UNCONFIRMED'});
 assert.equal(f.manager.read(job.id).status,'running');assert.doesNotThrow(()=>process.kill(pid,0));
 const result=await f.manager.cancel(job.id);assert.equal(result.status,'cancelled');assert.equal(result.terminationConfirmed,true);assert.equal(result.error,'');
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
 assert.equal(await fs.readFile(path.join(f.root,'request-starts'),'utf8'),'1');
});

test('SSH cancellation before its control exists rejects a later failed stop and accepts a retry',async t=>{
 const f=await remoteFixture(t,{holdLaunchResponse:true,rejectStopOnce:true,managerOptions:{remotePollMs:20}}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 assert.equal(f.manager.read(job.id).remoteExecution.ready,false);assert.equal(f.manager.hasBlockingJobs,true);
 const cancelling=f.manager.cancel(job.id);
 f.releaseLaunchResponse();
 await assert.rejects(cancelling,{code:'AGENT_STOP_UNCONFIRMED'});
 assert.equal(f.manager.read(job.id).status,'running');assert.equal(f.manager.read(job.id).terminationConfirmed,false);assert.doesNotThrow(()=>process.kill(pid,0));
 const result=await f.manager.cancel(job.id);
 assert.equal(result.status,'cancelled');assert.equal(result.terminationConfirmed,true);assert.equal(result.error,'');
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
 assert.equal(await fs.readFile(path.join(f.root,'request-starts'),'utf8'),'1');
});

test('app shutdown is bounded when an SSH cancellation cannot be confirmed',async t=>{
 const f=await remoteFixture(t,{rejectStop:true,managerOptions:{remotePollMs:20}}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 await updateReady(f.manager,job.id);
 const group=Number(await fs.readFile(`/tmp/reviewops-agent-${job.id}/pid`,'utf8'));
 try {
  const cancelling=f.manager.cancel(job.id).catch(error=>error.code),started=Date.now();
  await f.manager.closeAll({preserveRemote:true});assert.equal(await cancelling,'AGENT_STOP_UNCONFIRMED');assert.ok(Date.now()-started<5000);
  const result=f.manager.read(job.id);assert.equal(result.status,'running');assert.equal(result.cancelRequested,true);assert.equal(result.remoteExecution.ready,true);
  assert.doesNotThrow(()=>process.kill(pid,0));
 } finally {killFixtureProcess(group,true);killFixtureProcess(pid);await fs.rm(`/tmp/reviewops-agent-${job.id}`,{recursive:true,force:true});}
});

test('app shutdown during SSH startup is bounded when its later cancellation cannot be confirmed',async t=>{
 const f=await remoteFixture(t,{holdLaunchResponse:true,rejectStop:true,managerOptions:{remotePollMs:20}}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 const directory=remoteAgent.directory(job.id),group=Number(await fs.readFile(path.join(directory,'pid'),'utf8'));
 assert.equal(f.manager.read(job.id).remoteExecution.ready,false);assert.equal(f.manager.hasBlockingJobs,true);
 const shutdown=f.manager.closeAll({preserveRemote:true});
 f.releaseLaunchResponse();
 try {
  assert.equal(await Promise.race([shutdown.then(()=>true),pause(5000).then(()=>false)]),true,'Shutdown must settle after an unconfirmed startup cancellation.');
  const result=f.manager.read(job.id);
  assert.equal(result.status,'running');assert.equal(result.cancelRequested,true);assert.equal(result.terminationConfirmed,false);assert.equal(result.errorCode,'AGENT_STOP_UNCONFIRMED');assert.equal(result.remoteExecution.ready,true);
  assert.doesNotThrow(()=>process.kill(pid,0));
 } finally {
  killFixtureProcess(group,true);killFixtureProcess(pid);
  await shutdown;await fs.rm(directory,{recursive:true,force:true});
 }
});

test('closing active jobs waits for termination and the manager can be used after restoring data',async t=>{
 const f=await fixture(t),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL',images:[{name:'test.png',mimeType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64')}]});
 await eventually(()=>f.manager.read(job.id).sessionId);
 await f.manager.closeAll();assert.equal(f.manager.size,0);assert.equal(f.manager.read(job.id).status,'cancelled');
 const next=f.manager.start({config:f.config,settings:f.settings,prompt:'new request'});assert.equal((await completed(f.manager,next.id)).status,'completed');
 const copy=f.manager.read(next.id);copy.status='corrupted';assert.equal(f.manager.read(next.id).status,'completed');
});


const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64');
for(const kind of ['local','ssh'])test(`${kind} image attachments reach the CLI as private image files and are removed after completion`,async t=>{
 const f=kind==='ssh'?await remoteFixture(t):await fixture(t);
 const job=f.manager.start({config:f.config,settings:f.settings,prompt:'이미지를 검토하십시오.',images:[{name:'../../not-used.png',mimeType:'image/png',bytes:imageBytes}]});
 const result=await completed(f.manager,job.id);assert.equal(result.status,'completed',result.error);
 const record=JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8'));assert.equal(record.images.length,1);assert.equal(record.images[0].bytes,imageBytes.toString('base64'));assert.equal(record.images[0].mode,0o600);assert.match(record.images[0].path,/image-1.png$/);
 await eventually(async()=>{try{await fs.access(record.images[0].path);return false;}catch{return true;}});
 assert.throws(()=>f.manager.start({config:f.config,settings:f.settings,prompt:'x',images:[{mimeType:'image/png',bytes:Buffer.from('not an image')}]}),{code:'AGENT_IMAGES_INVALID'});
});

for(const kind of ['local','ssh'])for(const outcome of ['completed','failed','cancelled'])test(`${kind} binary request files arrive intact and are removed after ${outcome}`,async t=>{
 const f=kind==='ssh'?await remoteFixture(t):await fixture(t),bytes=Buffer.from([0,255,13,10,67,79,68,69,88]);
 const prompt=outcome==='failed'?'FAIL_TURN':outcome==='cancelled'?'WAIT_FOR_CANCEL':'문서를 읽으십시오.';
 const job=f.manager.start({config:f.config,settings:f.settings,prompt,files:[{name:'../../source document.bin',mimeType:'application/octet-stream',bytes}]});
 if(outcome==='cancelled')await eventually(async()=>{try{return Boolean(JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8')).files.length);}catch{return false;}});
 const result=outcome==='cancelled'?await f.manager.cancel(job.id):await completed(f.manager,job.id);assert.equal(result.status,outcome,result.error);
 const record=JSON.parse(await fs.readFile(path.join(f.root,'last-input.json'),'utf8'));assert.equal(record.files.length,1);assert.equal(record.files[0].bytes,bytes.toString('base64'));assert.equal(record.files[0].mode,0o600);assert.match(record.files[0].path,/file-1.bin$/);assert.match(record.input,/source document.bin/);
 await eventually(async()=>{try{await fs.access(record.files[0].path);return false;}catch{return true;}});
});


for(const kind of ['local','ssh'])test(`${kind} closeAll terminates a hanging environment probe even when no agent request was created`,async t=>{
 const f=kind==='ssh'?await remoteFixture(t,{managerOptions:{commandTimeoutMs:15000}}):await fixture(t,{commandTimeoutMs:15000});await fs.writeFile(path.join(f.root,'hang-probe'),'');
 const probing=f.manager.environment(f.config,f.settings).then(value=>value,error=>({error:error.code}));
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'probe.pid'),'utf8'));}catch{return false;}});
 assert.equal(f.manager.size,0);await f.manager.closeAll();await probing;
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
});


for(const kind of ['local','ssh'])test(`${kind} closeAll cancels an agent that is still probing its environment without waiting for the probe timeout`,async t=>{
 const f=kind==='ssh'?await remoteFixture(t,{managerOptions:{commandTimeoutMs:15000}}):await fixture(t,{commandTimeoutMs:15000});await fs.writeFile(path.join(f.root,'hang-probe'),'');
 const job=f.manager.start({config:f.config,settings:f.settings,prompt:'never start a request'});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'probe.pid'),'utf8'));}catch{return false;}});
 const started=Date.now();await f.manager.closeAll();assert.ok(Date.now()-started<8000);assert.equal(f.manager.read(job.id).status,'cancelled');
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

for(const kind of ['local','ssh'])test(`${kind} stored-session checks read metadata without invoking the CLI or starting a model request`,async t=>{
 const f=kind==='ssh'?await remoteFixture(t):await fixture(t),sessionId='fixture-session-metadata',directory=path.join(f.home,'.codex','sessions','2026','10','17');
 await fs.mkdir(directory,{recursive:true});
 const head=JSON.stringify({type:'session_meta',payload:{id:sessionId,cwd:f.root}})+'\n';
 const padding=(JSON.stringify({type:'event_msg',payload:{message:'private conversation content '.repeat(60)}})+'\n').repeat(400);
 const tail=JSON.stringify({type:'turn_context',payload:{model:'fixture-model'}})+'\n';
 await fs.writeFile(path.join(directory,`rollout-${sessionId}.jsonl`),head+padding+tail);
 const settings={...f.settings,binary:path.join(f.bin,'does-not-exist')};
 const result=await f.manager.session(f.config,settings,sessionId);assert.equal(result.available,true);assert.equal(result.model,'fixture-model');assert.equal(result.status,'available');
 assert.equal(Object.hasOwn(result,'content'),false);assert.equal(JSON.stringify(result).includes('private conversation'),false);
 const changed=await f.manager.session(f.config,{...settings,model:'another-model'},sessionId);assert.equal(changed.available,false);assert.equal(changed.status,'model_changed');
 const missing=await f.manager.session(f.config,settings,'missing-session');assert.equal(missing.available,false);assert.equal(missing.status,'missing');
 await assert.rejects(f.manager.session(f.config,settings,'bad;session'),{code:'AGENT_SESSION_INVALID'});
 await assert.rejects(fs.access(path.join(f.root,'last-input.json')));assert.equal(f.manager.size,0);
 if(kind==='ssh')await assert.rejects(f.manager.session({...f.config,hostFingerprint:''},settings,sessionId),{code:'SSH_TRUST_REQUIRED'});
});
