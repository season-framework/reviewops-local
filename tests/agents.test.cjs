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
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function eventually(check) {for(let attempt=0;attempt<200;attempt++){const result=await check();if(result)return result;await pause(20);}assert.fail('Expected agent state was not received');}
async function completed(manager,id){return eventually(()=>{const job=manager.read(id);return ['completed','failed','cancelled'].includes(job.status)?job:null;});}
const executable = `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process');
const args=process.argv.slice(2), cwd=process.cwd();
if(args[0]==='--version'){if(fs.existsSync(cwd+'/hang-probe')){fs.writeFileSync(cwd+'/probe.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}console.log('codex-cli synthetic-1.0');process.exit(0);}
if(args[0]==='login'&&args[1]==='status'){process.exit(fs.existsSync(cwd+'/unauthenticated')?1:0);}
if(args[0]==='logout'){fs.writeFileSync(cwd+'/unauthenticated','');process.exit(0);}
if(args[0]==='login'){console.log('Open https://auth.example.test/device and enter TEST-1234');setTimeout(()=>{try{fs.unlinkSync(cwd+'/unauthenticated')}catch{};process.exit(0)},150);return;}
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const images=args.flatMap((arg,index)=>arg==='-i'?[{path:args[index+1],bytes:fs.readFileSync(args[index+1]).toString('base64'),mode:fs.statSync(args[index+1]).mode&0o777}]:[]);
 const files=input.split('\\n').filter(line=>line.startsWith('"')&&line.includes(': /')).map(line=>{const location=line.slice(line.indexOf(': /')+2);return {path:location,bytes:fs.readFileSync(location).toString('base64'),mode:fs.statSync(location).mode&0o777};});
 fs.writeFileSync(cwd+'/last-input.json',JSON.stringify({args,input,cwd,images,files,codexHome:process.env.CODEX_HOME,loginProfile:process.env.REVIEWOPS_FIXTURE_LOGIN||''}));
 const send=event=>process.stdout.write(JSON.stringify(event)+'\\n');
 send({type:'thread.started',thread_id:'synthetic-thread'});send({type:'turn.started'});
 if(input.includes('WAIT_FOR_CANCEL')){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(cwd+'/child.pid',String(child.pid));setInterval(()=>{},1000);return;}
 if(input.includes('FAIL_TURN')){send({type:'turn.failed',error:{message:'Synthetic request failure'}});process.exitCode=1;return;}
 send({type:'item.started',item:{id:'command-1',type:'command_execution',command:'echo secret',status:'in_progress'}});
 send({type:'item.completed',item:{id:'command-1',type:'command_execution',status:'completed',exit_code:0}});
 const response=JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'작업 완료: '+input}})+'\\n';const bytes=Buffer.from(response),split=bytes.indexOf(Buffer.from('작업'))+1;
 process.stdout.write(bytes.subarray(0,split));setTimeout(()=>{process.stdout.write(bytes.subarray(split));send({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}})},25);
});
`;
async function fixture(t,options={}) {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-agent-')),root=path.join(base,"project ' folder"),bin=path.join(base,'bin'),home=path.join(base,'home');
 await fs.mkdir(root);await fs.mkdir(bin);await fs.mkdir(path.join(home,'.codex'),{recursive:true});
 const binary=path.join(bin,'codex');await fs.writeFile(binary,executable,{mode:0o755});
 await fs.writeFile(path.join(home,'.codex/models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',display_name:'Fixture model',supported_reasoning_levels:[{effort:'low'},{effort:'high'}],default_reasoning_level:'high'}]}));
 const updates=[];const manager=createAgentManager({env:{...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:bin+path.delimiter+process.env.PATH},onUpdate:job=>updates.push(job),killTimeoutMs:100,commandTimeoutMs:3000,...options});
 t.after(async()=>{await manager.closeAll();try{const pid=Number(await fs.readFile(path.join(root,'child.pid'),'utf8'));process.kill(pid,'SIGKILL');}catch{}await fs.rm(base,{recursive:true,force:true});});
 return {base,root,bin,home,binary,manager,updates,config:{id:'service',kind:'local',rootPath:root},settings:{binary,model:'fixture-model',reasoningEffort:'high'}};
}

test('agent arguments bypass approvals and sandbox for fresh and resumed CLI requests while preserving model, effort and stdin',()=>{
 const settings=normalizeSettings({binary:'/opt/Codex Tool/codex',model:'model; touch /tmp/never',reasoningEffort:'high',workPath:'/tmp/work'},{kind:'local'});
 const expected=['exec','--json','--skip-git-repo-check','--model','model; touch /tmp/never','-c','model_reasoning_effort="high"','--dangerously-bypass-approvals-and-sandbox'];
 assert.deepEqual(buildArguments(settings),[...expected,'-']);
 assert.deepEqual(buildArguments(settings,'thread-id'),[...expected,'resume','thread-id','-']);
 assert.throws(()=>buildArguments(settings,'bad;id'),{code:'AGENT_SESSION_INVALID'});
 assert.throws(()=>normalizeSettings({workPath:'relative'},{}),{code:'AGENT_CONFIG_INVALID'});
 assert.throws(()=>normalizeSettings({provider:'unknown',workPath:'/tmp'},{}),{code:'AGENT_PROVIDER_INVALID'});
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
 const f=await fixture(t,options.managerOptions||{}),clients=new Set(),processes=new Set();let authentications=0;
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
   if(options.rejectStop&&info.command.startsWith("bash -c 'd=")){channel.exit(1);channel.end();return;}
   const child=spawn('/bin/bash',['-c',info.command],{env:{...process.env,PATH:f.bin+path.delimiter+process.env.PATH,HOME:f.home,CODEX_HOME:path.join(f.home,'.codex')},stdio:['pipe','pipe','pipe'],detached:true});processes.add(child);
   channel.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.pipe(channel,{end:false});child.stderr.pipe(channel.stderr,{end:false});
   child.on('close',(code)=>{processes.delete(child);if(!channel.destroyed){channel.exit(Number.isInteger(code)?code:143);channel.end();}});
  });}));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(async()=>{await f.manager.closeAll();for(const child of processes){try{process.kill(-child.pid,'SIGKILL')}catch{}}for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));});
 return {...f,config:{id:'remote-service',kind:'ssh',host:'127.0.0.1',port:server.address().port,username:'tester',authType:'password',password:'fixture-password',rootPath:f.root,hostFingerprint:fingerprint},authentications:()=>authentications};
}

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
 await assert.rejects(fs.access(`/tmp/reviewops-agent-${job.id}`));
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


test('SSH stop failures remain failed and never report a confirmed cancellation',async t=>{
 const f=await remoteFixture(t,{rejectStop:true}),job=f.manager.start({config:f.config,settings:f.settings,prompt:'WAIT_FOR_CANCEL',images:[{name:'test.png',mimeType:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64')}]});
 const pid=await eventually(async()=>{try{return Number(await fs.readFile(path.join(f.root,'child.pid'),'utf8'));}catch{return false;}});
 const group=Number(await fs.readFile(`/tmp/reviewops-agent-${job.id}/pid`,'utf8'));
 t.after(async()=>{try{process.kill(-group,'SIGKILL')}catch{}try{process.kill(pid,'SIGKILL')}catch{}await fs.rm(`/tmp/reviewops-agent-${job.id}`,{recursive:true,force:true});});
 await assert.rejects(f.manager.cancel(job.id),{code:'AGENT_STOP_UNCONFIRMED'});
 const result=await completed(f.manager,job.id);assert.equal(result.status,'failed');assert.equal(result.terminationConfirmed,false);
 assert.doesNotThrow(()=>process.kill(pid,0));
 try{process.kill(-group,'SIGKILL')}catch{}
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
