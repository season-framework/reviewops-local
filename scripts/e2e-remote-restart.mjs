import {setTestLocale} from './test-locale.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),{Server,utils}=require('ssh2'),{fingerprintOf}=require('../electron/ssh.cjs');
const root=process.cwd(),testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-remote-restart-'));
const dataPath=path.join(testRoot,'data'),appHome=path.join(testRoot,'app-home'),serverHome=path.join(testRoot,'server-home');
const work=path.join(testRoot,"server project ' folder"),bin=path.join(testRoot,'bin'),screenshots=path.join(testRoot,'screenshots');
for(const directory of [work,bin,screenshots,path.join(appHome,'.ssh'),path.join(appHome,'.codex'),path.join(serverHome,'.codex')])fs.mkdirSync(directory,{recursive:true});
const sshConfig=path.join(appHome,'.ssh','config');fs.writeFileSync(sshConfig,'# Synthetic restart test only\n',{mode:0o600});
const binary=path.join(bin,'codex'),partial='앱을 종료해도 서버에서 작업을 계속합니다.',answer='최종 응답: 서버 작업과 한글 출력이 재시작 뒤에도 유지됩니다.';
fs.writeFileSync(binary,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),root=process.cwd(),file=name=>path.join(root,name);
if(args[0]==='--version'){console.log('codex-cli synthetic-restart-1.0');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const requests=fs.existsSync(file('requests.json'))?JSON.parse(fs.readFileSync(file('requests.json'),'utf8')):[];
 requests.push({pid:process.pid,args,input});fs.writeFileSync(file('requests.json'),JSON.stringify(requests));
 const send=event=>process.stdout.write(JSON.stringify(event)+'\\n');
 send({type:'thread.started',thread_id:'synthetic-restart-thread'});send({type:'turn.started'});
 send({type:'item.completed',item:{id:'partial',type:'agent_message',text:${JSON.stringify(partial)}}});
 const final=Buffer.from(JSON.stringify({type:'item.completed',item:{id:'final',type:'agent_message',text:${JSON.stringify(answer)}}})+'\\n');
 const split=final.indexOf(Buffer.from('최종'))+1;process.stdout.write(final.subarray(0,split));
 fs.writeFileSync(file('waiting'),String(process.pid));
 const timer=setInterval(()=>{if(!fs.existsSync(file('complete')))return;clearInterval(timer);process.stdout.write(final.subarray(split));send({type:'turn.completed',usage:{input_tokens:17,output_tokens:23}});},25);
});
`,{mode:0o755});
// macOS lacks setsid. This test-owned wrapper creates the same detached group.
fs.writeFileSync(path.join(bin,'setsid'),`#!${process.execPath}
const {spawn}=require('node:child_process'),args=process.argv.slice(2);if(args[0]==='--wait')args.shift();
const child=spawn(args.shift(),args,{detached:true,stdio:'inherit'});child.on('error',()=>process.exit(127));child.on('exit',(code)=>process.exit(Number.isInteger(code)?code:143));
`,{mode:0o755});
const hostKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
const fingerprint=fingerprintOf(utils.parseKey(hostKey).getPublicSSH()),clients=new Set(),commands=new Set();
const server=new Server({hostKeys:[hostKey]},client=>{
 clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
 client.on('authentication',context=>{if(context.method==='password'&&context.username==='synthetic'&&context.password==='synthetic-restart-password')context.accept();else context.reject();});
 client.on('ready',()=>client.on('session',accept=>{
  const session=accept();session.on('exec',(accept,_reject,info)=>{
   const channel=accept();channel.on('error',()=>{});
   const child=spawn('/bin/bash',['-c',info.command],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,HOME:serverHome,CODEX_HOME:path.join(serverHome,'.codex')},stdio:['pipe','pipe','pipe'],detached:true});
   commands.add(child);channel.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.pipe(channel,{end:false});child.stderr.pipe(channel.stderr,{end:false});
   child.on('close',code=>{commands.delete(child);if(!channel.destroyed){channel.exit(Number.isInteger(code)?code:143);channel.end();}});
  });
 }));
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
let app,page,processHandle,runId,runnerPid,workerPid;
const errors=[],network=[],checks=[];
const passed=name=>{checks.push(name);console.log(`PASS: ${name}`);};
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const requests=()=>fs.existsSync(path.join(work,'requests.json'))?JSON.parse(fs.readFileSync(path.join(work,'requests.json'),'utf8')):[];
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
async function launch(){
 const env={...process.env,HOME:appHome,CODEX_HOME:path.join(appHome,'.codex'),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:sshConfig,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});processHandle=app.process();
 page=await app.firstWindow();await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))network.push(request.url());});
 await page.waitForFunction(()=>!!window.reviewops?.invoke);await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
}
async function quit(){
 const process=processHandle;
 await app.evaluate(({app})=>app.quit()).catch(()=>{});
 await expect.poll(()=>process.exitCode,{timeout:15000}).toBe(0);app=null;page=null;
}
try{
 await launch();
 const group=await ipc('group.save',{name:'SSH 재시작 검사'});
 const service=await ipc('service.save',{groupId:group.id,name:'합성 SSH 서버',kind:'ssh',host:'127.0.0.1',port:server.address().port,username:'synthetic',authType:'password',password:'synthetic-restart-password',rootPath:work,agentWorkPath:work,agentBinary:binary,agentEnabled:true});
 await assert.rejects(ipc('ssh.test',{serviceId:service.id}));
 await ipc('ssh.trust',{serviceId:service.id,fingerprint});
 const project=await ipc('project.save',{groupId:group.id,name:'서버 작업 유지 검사',serviceIds:[service.id]});
 const review=await ipc('review.save',{projectId:project.id,serviceId:service.id,title:'앱 재시작 뒤 SSH 작업 복구',body:'서버 작업을 한 번만 실행하고 결과를 복구합니다.'});
 runId=crypto.randomUUID();
 const started=await ipc('agent.start',{reviewId:review.id,requestId:runId,prompt:'서버에서 작업을 계속하고 결과를 저장하십시오.',newConversation:true,context:{instruction:false,attachmentIds:[],logIds:[]}});
 assert.equal(started.id,runId);
 await expect.poll(()=>requests().length,{timeout:15000}).toBe(1);
 workerPid=requests()[0].pid;
 const directory=`/tmp/reviewops-agent-${runId}`;
 await expect.poll(async()=>{
  const run=await ipc('agent.read',{id:runId});
  return run.status==='running'&&run.remoteExecution?.ready&&run.remoteExecution.stdoutOffset===fs.statSync(path.join(directory,'stdout')).size&&run.response===partial;
 },{timeout:15000}).toBe(true);
 runnerPid=Number(fs.readFileSync(path.join(directory,'pid'),'utf8'));
 passed('실제 앱에서 SSH 작업을 시작하고 부분 응답과 출력 위치 저장');
 await quit();
 assert.equal(alive(workerPid),true);assert.equal(alive(runnerPid),true);assert.equal(requests().length,1);
 fs.writeFileSync(path.join(work,'complete'),'');
 await expect.poll(()=>fs.existsSync(path.join(directory,'result')),{timeout:10000}).toBe(true);
 assert.equal(fs.readFileSync(path.join(directory,'result'),'utf8').trim(),'0');
 passed('앱을 종료한 동안 서버 작업이 중단되지 않고 정상 완료');
 await launch();
 await expect.poll(async()=>(await ipc('agent.read',{id:runId})).status,{timeout:15000}).toBe('completed');
 const restored=await ipc('agent.read',{id:runId}),snapshot=await ipc('snapshot');
 assert.equal(restored.id,runId);assert.equal(restored.sessionId,'synthetic-restart-thread');assert.equal(restored.response,answer);assert.equal(restored.terminationConfirmed,true);
 assert.deepEqual(restored.usage,{input_tokens:17,output_tokens:23});assert.equal(restored.output.includes('\ufffd'),false);assert.ok(restored.output.includes(answer));assert.equal(requests().length,1);
 const responses=snapshot.activities.filter(item=>item.agentRunId===runId&&item.role==='agent');
 assert.equal(responses.length,1);assert.equal(responses[0].body,answer);assert.equal(snapshot.activities.filter(item=>item.agentRunId===runId&&item.role==='user').length,1);
 assert.equal(snapshot.reviews.find(item=>item.id===review.id).status,'in_progress');
 await page.locator('.workspace-refresh').click();await page.locator(`[data-tree-node="r-${review.id}"]`).click();
 await expect(page.locator('.review-chat-message.is-agent .original-review-markdown')).toContainText(answer);
 await page.screenshot({path:path.join(screenshots,'remote-restored-history.png')});
 passed('같은 자료 폴더 재시작 후 같은 작업 ID·한글 응답·작업이력 한 개 복구, 추가 실행 없음');
 await expect.poll(()=>fs.existsSync(directory),{timeout:10000}).toBe(false);
 await quit();await launch();
 const final=await ipc('agent.read',{id:runId}),finalSnapshot=await ipc('snapshot');
 assert.equal(final.status,'completed');assert.equal(final.response,answer);assert.equal(requests().length,1);
 assert.equal(finalSnapshot.activities.filter(item=>item.agentRunId===runId&&item.role==='agent').length,1);
 passed('다시 재시작해도 완료 응답과 작업이력 한 개 유지');
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 const result={ok:true,checks,rendererErrors:errors,externalRequests:network,runId,workerPid,testRoot,screenshots,executable:process.env.REVIEWOPS_TEST_EXECUTABLE||'development'};
 fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results','remote-restart-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){
 if(page)await page.screenshot({path:path.join(screenshots,'failure.png')}).catch(()=>{});
 console.error('REMOTE RESTART UI FAILURE',testRoot,error);process.exitCode=1;
}finally{
 if(app){await app.close().catch(()=>{});if(processHandle?.exitCode===null)processHandle.kill('SIGKILL');}
 if(runnerPid&&alive(runnerPid))try{process.kill(-runnerPid,'SIGKILL')}catch{}
 if(workerPid&&alive(workerPid))try{process.kill(workerPid,'SIGKILL')}catch{}
 for(const child of commands)try{process.kill(-child.pid,'SIGKILL')}catch{}
 for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));
 if(runId)fs.rmSync(`/tmp/reviewops-agent-${runId}`,{recursive:true,force:true});
}
