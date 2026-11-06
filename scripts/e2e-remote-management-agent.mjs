import {_electron as electron,expect} from '@playwright/test';
import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {createRequire} from 'node:module';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// Explicit account-backed feature QA, never a default test or release gate.
// Both the HTTPS client and the owned SSH server run on this computer. The
// server executes the installed CLI; it does not synthesize model responses.
if(!process.argv.includes('--real-codex'))throw new Error('Account-backed QA requires --real-codex.');
const stopOnly=process.argv.includes('--stop-only');
const localStop=process.argv.includes('--local-stop');
if(localStop&&!stopOnly)throw new Error('--local-stop requires --stop-only.');
const root=process.cwd(),require=createRequire(import.meta.url),{Server,utils}=require('ssh2');
const {fingerprintOf}=require('../electron/ssh.cjs');
const codex=fs.realpathSync(process.env.REVIEWOPS_E2E_CODEX_BINARY||execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim());
const realHome=os.homedir(),realCodexHome=process.env.CODEX_HOME||path.join(realHome,'.codex');
const actualEnv={...process.env,HOME:realHome,CODEX_HOME:realCodexHome};
for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','OPENAI_API_KEY','CODEX_API_KEY'])delete actualEnv[key];
try{execFileSync(codex,['login','status'],{env:actualEnv,stdio:'ignore',timeout:15000});}
catch{throw new Error('The installed CLI has no usable existing login; no credentials were copied.');}
const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-remote-agent-e2e-')));
const dataPath=path.join(temporary,'data'),home=path.join(temporary,'model-home'),bin=path.join(temporary,'bin');
const localWork=path.join(temporary,'host-local-project'),sshWork=path.join(temporary,"host SSH project ' folder");
const stopWork=localStop?localWork:sshWork;
const output=path.join(root,'test-results','remote-management-agent',new Date().toISOString().replace(/[:.]/g,'-'));
for(const directory of [dataPath,home,bin,localWork,sshWork,output,path.join(dataPath,'updates')])fs.mkdirSync(directory,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(dataPath,'updates/settings.json'),JSON.stringify({automatic:false,intervalMinutes:10}));
const quote=value=>`'${String(value).replace(/'/g,`'"'"'`)}'`;
const wrapper=path.join(bin,'real-codex');
fs.writeFileSync(wrapper,`#!/bin/sh\nexport HOME=${quote(realHome)}\nexport CODEX_HOME=${quote(realCodexHome)}\nexec ${quote(codex)} "$@"\n`,{mode:0o700});
// macOS has no setsid utility. This owned shim preserves the remote runner's
// process-group contract while leaving system configuration unchanged.
fs.writeFileSync(path.join(bin,'setsid'),`#!${process.execPath}\nconst {spawn}=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='--wait')args.shift();const child=spawn(args.shift(),args,{detached:true,stdio:'inherit'});child.on('error',()=>process.exit(127));child.on('exit',code=>process.exit(Number.isInteger(code)?code:143));\n`,{mode:0o700});
const sshConfig=path.join(temporary,'ssh-config');fs.writeFileSync(sshConfig,'# Owned account-backed feature fixture only\n',{mode:0o600});
const localNonce='LOCAL_'+randomUUID(),sshNonce='SSH_'+randomUUID();
fs.writeFileSync(path.join(localWork,'host-sentinel.txt'),localNonce,{mode:0o600});
fs.writeFileSync(path.join(sshWork,'host-sentinel.txt'),sshNonce,{mode:0o600});
const hostKey=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
const fingerprint=fingerprintOf(utils.parseKey(hostKey).getPublicSSH()),clients=new Set(),shells=new Set();
let sshCommands=0;
const sshServer=new Server({hostKeys:[hostKey]},client=>{
 clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
 client.on('authentication',context=>context.method==='password'&&context.username==='owned-fixture'&&context.password==='owned-fixture-only-password'?context.accept():context.reject());
 client.on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,_reject,info)=>{
  sshCommands++;const channel=accept();channel.on('error',()=>{});
  const child=spawn('/bin/bash',['-c',info.command],{env:{...actualEnv,PATH:bin+path.delimiter+process.env.PATH},stdio:['pipe','pipe','pipe'],detached:true});
  shells.add(child);channel.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.pipe(channel,{end:false});child.stderr.pipe(channel.stderr,{end:false});
  child.on('close',code=>{shells.delete(child);if(!channel.destroyed){channel.exit(Number.isInteger(code)?code:143);channel.end();}});
 })));
});
await new Promise((resolve,reject)=>{sshServer.once('error',reject);sshServer.listen(0,'127.0.0.1',resolve);});
const unusedPort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
const appPort=await unusedPort(),checks=[],errors=[],runs=[];
let application,page,identityAttempted=false,identityCleaned=false,deviceId,originalExit=null,failure=null,cleanupError=null,ownedToolPid=null,runtimeVersion=null;
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const remote=()=>page.locator('.remote-management-settings'),section=name=>remote().getByRole('region',{name,exact:true});
const outgoing=()=>section('다른 PC에 원격 접속');
const promptField=()=>outgoing().getByRole('group',{name:'작업 PC의 에이전트 제어',exact:true}).locator('textarea');
async function refresh(){await remote().getByRole('button',{name:'상태 새로고침',exact:true}).click();await expect(remote().getByRole('button',{name:'상태 새로고침',exact:true})).toBeEnabled();}
async function details(){await outgoing().getByRole('button',{name:'상세·작업 결과 새로고침',exact:true}).click();await expect(outgoing().getByRole('button',{name:'상세·작업 결과 새로고침',exact:true})).toBeEnabled();}
async function shot(name){await outgoing().getByRole('group',{name:'작업 PC의 에이전트 제어',exact:true}).evaluate(node=>node.scrollIntoView({block:'center'}));await page.screenshot({path:path.join(output,name),fullPage:false});}
async function choose(project,review){
 await outgoing().getByRole('combobox',{name:'원격 프로젝트',exact:true}).selectOption(project.id);
 await outgoing().getByRole('button',{name:'리뷰 불러오기',exact:true}).click();
 await outgoing().getByRole('combobox',{name:'원격 리뷰',exact:true}).selectOption(review.id);await details();
}
async function submit(review,prompt,button='작업 PC에서 실행'){
 const previous=new Set((await ipc('agent.list',{reviewId:review.id})).map(row=>row.id));
 await promptField().fill(prompt);await outgoing().getByRole('button',{name:button,exact:true}).click();
 await expect(outgoing().getByRole('button',{name:button,exact:true})).toBeEnabled({timeout:30000});
 await expect.poll(async()=> (await ipc('agent.list',{reviewId:review.id})).filter(row=>!previous.has(row.id)).length,{timeout:30000}).toBe(1);
 const run=(await ipc('agent.list',{reviewId:review.id})).find(row=>!previous.has(row.id));runs.push(run.id);return run;
}
async function completed(id){
 await expect.poll(async()=>{const run=await ipc('agent.read',{id});return ['completed','failed','cancelled'].includes(run.status)?run.status:'running';},{timeout:180000,intervals:[1000,2000,4000]}).toBe('completed');
 return ipc('agent.read',{id});
}
async function cleanIdentity(){
 if(!application||!identityAttempted||identityCleaned)return;
 const result=await application.evaluate(async({app},{root,dataPath,deviceId})=>{
  const require=process.mainModule.require.bind(process.mainModule),fs=require('node:fs'),path=require('node:path');
  if(app.getPath('userData')!==dataPath||app.getAppPath()!==root)throw new Error('Fixture identity owner changed.');
  if(process.platform!=='darwin')return true;
  const index=JSON.parse(fs.readFileSync(path.join(dataPath,'remote-device-identity/index.json'),'utf8'));
  if(deviceId&&index.deviceId!==deviceId)throw new Error('Fixture identity changed.');
  const reference=Buffer.from(index.referenceBase64,'base64'),digest=Buffer.from(index.payloadSHA256,'hex');
  try{require(path.join(root,'electron/remote-device-identity-native.cjs')).loadMacIdentityStorage({appPath:root,packaged:false}).remove(reference,digest);return true;}
  finally{reference.fill(0);digest.fill(0);}
 },{root,dataPath,deviceId});identityCleaned=result===true;
}
try{
 const env={...process.env,...isolatedModelRuntime({home,dataPath}),HOME:realHome,REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:sshConfig,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig};
 for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','ELECTRON_EXTRA_LAUNCH_ARGS','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 application=await electron.launch({args:[root],env,timeout:30000});application.process().once('exit',(code,signal)=>{originalExit={code,signal};});
 runtimeVersion=await application.evaluate(()=>process.versions.electron);
 page=await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await setTestLocale(page);
 await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1100));
 const group=await ipc('group.save',{name:'Owned real remote-agent feature fixture'});
 const localService=await ipc('service.save',{groupId:group.id,name:'Host local CLI',kind:'local',rootPath:localWork,agentWorkPath:localWork,agentBinary:wrapper,agentEnabled:true});
 const sshService=await ipc('service.save',{groupId:group.id,name:'Owned loopback SSH with real CLI',kind:'ssh',host:'127.0.0.1',port:sshServer.address().port,username:'owned-fixture',authType:'password',password:'owned-fixture-only-password',rootPath:sshWork,agentWorkPath:sshWork,agentBinary:wrapper,agentEnabled:true});
 await assert.rejects(ipc('ssh.test',{serviceId:sshService.id}));await ipc('ssh.trust',{serviceId:sshService.id,fingerprint});
 const localProject=await ipc('project.save',{groupId:group.id,name:'Host local execution',serviceIds:[localService.id]});
 const sshProject=await ipc('project.save',{groupId:group.id,name:'Host SSH execution',serviceIds:[sshService.id]});
 const localReview=await ipc('review.save',{projectId:localProject.id,serviceId:localService.id,title:'Actual local remote-agent request',body:'Temporary acceptance data only.'});
 const sshReview=await ipc('review.save',{projectId:sshProject.id,serviceId:sshService.id,title:'Actual SSH remote-agent request',body:'Temporary acceptance data only.'});
 await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();await page.locator('.settings-section-menu').getByRole('button',{name:'원격 관리',exact:true}).click();
 await section('이 컴퓨터 신원').getByLabel('인증서에 사용할 이 컴퓨터의 IPv4 주소',{exact:true}).fill('127.0.0.1');identityAttempted=true;
 await section('이 컴퓨터 신원').getByRole('button',{name:'컴퓨터 신원 설정',exact:true}).click();await expect(section('이 컴퓨터 신원').getByText('이 컴퓨터의 신원을 확인했습니다.',{exact:true})).toBeVisible();
 const state=await ipc('remoteManagement.state');deviceId=state.identity.identity.deviceId;
 const certificate=await application.evaluate(({app},dataPath)=>process.mainModule.require(app.getAppPath()+'/electron/remote-device-identity.cjs').createRemoteDeviceIdentity({app,dataPath}).publicCertificate(),dataPath);
 const certificatePath=path.join(temporary,'public.crt');fs.writeFileSync(certificatePath,certificate.certificatePEM,{mode:0o600});
 const incoming=section('ReviewOps 앱 원격 접속');await incoming.getByLabel('앱 수신 IPv4 주소',{exact:true}).fill('127.0.0.1');await incoming.getByLabel('앱 접속 포트',{exact:true}).fill(String(appPort));
 await incoming.getByRole('button',{name:'앱 접속 켜기',exact:true}).click();await incoming.getByRole('button',{name:'앱 초대 만들기',exact:true}).click();const invitation=await incoming.locator('.remote-secret').textContent();
 await outgoing().getByLabel('연결 이름',{exact:true}).fill('Owned HTTPS client to host');await outgoing().getByLabel('작업 PC IPv4 주소',{exact:true}).fill('127.0.0.1');await outgoing().getByLabel('포트',{exact:true}).fill(String(appPort));
 await outgoing().getByLabel('작업 PC 공개 인증서',{exact:true}).setInputFiles(certificatePath);await outgoing().getByRole('checkbox',{name:'작업 PC에 표시된 인증서 지문과 일치함을 확인했습니다.',exact:true}).check();await outgoing().getByLabel('앱 초대 비밀값',{exact:true}).fill(invitation);
 await outgoing().getByRole('button',{name:'원격 접속 추가',exact:true}).click();await refresh();
 const pending=section('앱 기기와 프로젝트 권한').getByRole('group').filter({hasText:'Owned HTTPS client to host'});
 for(const project of [localProject,sshProject]){
  await pending.getByRole('checkbox',{name:project.name,exact:true}).check();
  const row=pending.locator('.remote-project-grant').filter({hasText:project.name});
  await row.getByRole('checkbox',{name:'리뷰 작성',exact:true}).check();await row.getByRole('checkbox',{name:'에이전트 실행·중지',exact:true}).check();
 }
 await pending.getByRole('button',{name:'선택한 권한 승인',exact:true}).click();await outgoing().getByRole('button',{name:'공유 프로젝트 불러오기',exact:true}).click();
 if(!stopOnly){
 await choose(localProject,localReview);
 const local=await submit(localReview,'This is an isolated ReviewOps acceptance task. Work only in the current directory. Read host-sentinel.txt, write its exact bytes to local-result.txt, then reply with LOCAL_RESULT followed by those bytes. Do not inspect other folders or use network tools.');
 const localResult=await completed(local.id);assert.equal(fs.readFileSync(path.join(localWork,'local-result.txt'),'utf8'),localNonce);assert.equal(fs.existsSync(path.join(sshWork,'local-result.txt')),false);
 assert.equal(localResult.serviceId,localService.id);assert.equal(localResult.workPath,localWork);assert.ok(localResult.response.includes(localNonce));await details();await expect(outgoing().getByText(localResult.response,{exact:true}).first()).toBeVisible();await shot('local-host-real-response.png');
 checks.push('HTTPS app request ran the genuine logged-in CLI in the host local project and displayed its response.');
 await promptField().fill('Continue this same isolated task. Read local-result.txt, write its exact bytes followed by _FOLLOWUP to local-followup.txt, then reply with FOLLOWUP_RESULT and that text. Work only in the current directory.');
 await outgoing().getByRole('button',{name:'후속 요청 저장',exact:true}).click();await expect(outgoing().getByRole('button',{name:'후속 요청 실행',exact:true})).toBeEnabled();
 const follow=await submit(localReview,await promptField().inputValue(),'후속 요청 실행');const followResult=await completed(follow.id);
 assert.equal(fs.readFileSync(path.join(localWork,'local-followup.txt'),'utf8'),localNonce+'_FOLLOWUP');assert.equal(followResult.sessionId,localResult.sessionId);await details();await shot('local-host-real-followup.png');
 checks.push('Remote saved follow-up started once in the same real CLI session and preserved the host-owned result.');
 }
 await choose(localStop?localProject:sshProject,localStop?localReview:sshReview);
 if(!stopOnly){
 const sshRun=await submit(sshReview,'This is an isolated ReviewOps acceptance task over an owned SSH connection. Work only in the current directory. Read host-sentinel.txt, write its exact bytes to ssh-result.txt, then reply with SSH_RESULT followed by those bytes. Do not inspect other folders or use network tools.');
 const sshResult=await completed(sshRun.id);assert.equal(fs.readFileSync(path.join(sshWork,'ssh-result.txt'),'utf8'),sshNonce);assert.equal(fs.existsSync(path.join(localWork,'ssh-result.txt')),false);
 assert.equal(sshResult.serviceId,sshService.id);assert.equal(sshResult.workPath,sshWork);assert.ok(sshResult.response.includes(sshNonce));assert.ok(sshCommands>0);await details();await shot('ssh-host-real-response.png');
 checks.push('HTTPS app request used the host-selected SSH service, real shell and genuine CLI in the separate SSH work directory.');
 }
 const stopping=await submit(localStop?localReview:sshReview,'For this isolated cancellation check, work only in the current directory. Execute this one shell command exactly: /bin/sh -c \'echo $$ > stop-command.pid; printf STARTED > stop-started.txt; /bin/sleep 90; printf FINISHED > stop-finished.txt\'. After the command completes reply FINISHED. Do not change other files or use network tools.');
 await expect.poll(()=>fs.existsSync(path.join(stopWork,'stop-started.txt')),{timeout:90000,intervals:[1000,2000]}).toBe(true);
 const commandPid=Number(fs.readFileSync(path.join(stopWork,'stop-command.pid'),'utf8'));assert.ok(Number.isInteger(commandPid)&&commandPid>1);ownedToolPid=commandPid;
 const alive=()=>{try{process.kill(commandPid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};assert.equal(alive(),true);
 await details();await outgoing().getByRole('button',{name:'이 작업 중지',exact:true}).click();
 await expect.poll(async()=>(await ipc('agent.read',{id:stopping.id})).status,{timeout:20000}).toBe('cancelled');const stopped=await ipc('agent.read',{id:stopping.id});assert.equal(stopped.terminationConfirmed,true);
 await expect.poll(alive,{timeout:10000}).toBe(false);assert.equal(fs.existsSync(path.join(stopWork,'stop-finished.txt')),false);await details();await shot(`${localStop?'local':'ssh'}-host-real-cancelled.png`);
 checks.push(`Remote stop cancelled the actual ${localStop?'local':'SSH'} CLI process group after its host-side marker; no post-sleep result was written.`);
 assert.deepEqual(errors,[]);
}catch(error){failure={name:error.name,message:error.message};if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png'),fullPage:false}).catch(()=>{});process.exitCode=1;}
finally{
 if(application){
  if(page&&!page.isClosed()){
   for(const id of runs){const run=await ipc('agent.read',{id}).catch(()=>null);if(run&&['running','queued'].includes(run.status))await ipc('agent.cancel',{id}).catch(()=>{});}
   const state=await ipc('remoteManagement.state').catch(()=>null);if(state?.app?.enabled)await ipc('remoteManagement.configureApp',{expectedGeneration:state.generation,bindAddress:state.app.bindAddress,port:state.app.port,enabled:false}).catch(()=>{});
  }
  try{await cleanIdentity();}catch{cleanupError='OWN_IDENTITY_CLEANUP_UNCONFIRMED';process.exitCode=1;}
  const processHandle=application.process(),exit=originalExit?Promise.resolve():once(processHandle,'exit');await application.evaluate(({app})=>app.quit()).catch(()=>{});await exit;
  if(originalExit?.code!==0||originalExit?.signal!==null){cleanupError||='ORIGINAL_EXIT_UNCONFIRMED';process.exitCode=1;}
 }
 for(const child of shells)try{process.kill(-child.pid,'SIGKILL');}catch{}
 for(const client of clients)client.destroy();await new Promise(resolve=>sshServer.close(resolve));
 // A failed cancellation assertion must not leave the owned test command
 // running. Require its exact command, group and working directory first.
 if(ownedToolPid){
  let row='';try{row=execFileSync('/bin/ps',['-p',String(ownedToolPid),'-o','pgid=,command='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
  if(row){
   let cwd='';try{cwd=process.platform==='linux'?fs.realpathSync(`/proc/${ownedToolPid}/cwd`):execFileSync('/usr/sbin/lsof',['-a','-p',String(ownedToolPid),'-d','cwd','-Fn'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).split('\n').find(line=>line.startsWith('n'))?.slice(1)||'';}catch{}
   const match=/^(\d+)\s+([\s\S]+)$/.exec(row);
   if(cwd===stopWork&&Number(match?.[1])===ownedToolPid&&match?.[2]==='/bin/sh -c echo $$ > stop-command.pid; printf STARTED > stop-started.txt; /bin/sleep 90; printf FINISHED > stop-finished.txt'){
    try{process.kill(-ownedToolPid,'SIGTERM');}catch{}
   }else{cleanupError||='OWN_TOOL_CLEANUP_UNCONFIRMED';process.exitCode=1;}
  }
 }
 const result={ok:checks.length===(stopOnly?1:4)&&identityCleaned&&!cleanupError&&!failure,checks,rendererErrors:errors,failure,identityCleaned,cleanupError,originalExit,runIds:runs,sshCommands,output,requestedScope:stopOnly?`${localStop?'local':'SSH'} cancellation only`:'local start/follow-up and SSH start/stop',
  runtimeVersion,scope:`Source Electron ${runtimeVersion} HTTPS app self-connection, genuine existing-account CLI, owned loopback SSH server on this Mac; not installed/two-PC/full release QA`,
  credentials:'Existing CLI authentication used directly; no authentication values copied or logged',retainedProfile:identityAttempted&&(!identityCleaned||cleanupError)?temporary:null};
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));if((!identityAttempted||identityCleaned)&&!cleanupError)fs.rmSync(temporary,{recursive:true,force:true});console.log(JSON.stringify(result));
}
