import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),{Server,utils}=require('ssh2'),{fingerprintOf}=require('../electron/ssh.cjs');
const root=process.cwd(),testRoot=fs.mkdtempSync('/tmp/reviewops-ssh-diagnostics-'),home=path.join(testRoot,'app-home'),serverHome=path.join(testRoot,'server-home'),dataPath=path.join(testRoot,'data'),work=path.join(testRoot,'server-work'),bin=path.join(testRoot,'bin'),output=path.join(root,'test-results/ssh-diagnostics',path.basename(testRoot));
for(const directory of [work,bin,output,path.join(home,'.ssh'),path.join(serverHome,'.codex')])fs.mkdirSync(directory,{recursive:true});
const sshConfig=path.join(home,'.ssh/config');fs.writeFileSync(sshConfig,'# Synthetic SSH diagnostic test only\n',{mode:0o600});
const binary=path.join(bin,'codex');
fs.writeFileSync(binary,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli synthetic-diagnostics');process.exit(0)}
if(args[0]==='login'&&args[1]==='status'){process.exit(fs.existsSync(${JSON.stringify(path.join(testRoot,'logged-out'))})?1:0)}
if(args[0]==='app-server'){
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line),send=result=>console.log(JSON.stringify({id:message.id,result}));
  if(message.method==='initialize')send({});else if(message.method==='config/read')send({config:{}});else if(message.method==='model/list')send({data:[],nextCursor:null});
 });return;
}
fs.writeFileSync(${JSON.stringify(path.join(testRoot,'unexpected-request'))},JSON.stringify(args));process.exit(90);
`,{mode:0o755});
// macOS does not include setsid. This fixture provides equivalent detached groups.
fs.writeFileSync(path.join(bin,'setsid'),`#!${process.execPath}
const {spawn}=require('node:child_process'),args=process.argv.slice(2);if(args[0]==='--wait')args.shift();const child=spawn(args.shift(),args,{detached:true,stdio:'inherit'});child.on('error',()=>process.exit(127));child.on('exit',code=>process.exit(Number.isInteger(code)?code:143));
`,{mode:0o755});
const hostKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
const fingerprint=fingerprintOf(utils.parseKey(hostKey).getPublicSSH()),clients=new Set(),commands=new Set();
const server=new Server({hostKeys:[hostKey]},client=>{
 clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
 client.on('authentication',context=>{if(context.method==='password'&&context.username==='synthetic'&&context.password==='synthetic-diagnostics-password')context.accept();else context.reject()});
 client.on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,_reject,info)=>{
  const channel=accept();channel.on('error',()=>{});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,HOME:serverHome,CODEX_HOME:path.join(serverHome,'.codex')};for(const key of ['SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
  const child=spawn('/bin/bash',['-c',info.command],{env,stdio:['pipe','pipe','pipe'],detached:true});commands.add(child);
  channel.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.pipe(channel,{end:false});child.stderr.pipe(channel.stderr,{end:false});
  child.on('close',code=>{commands.delete(child);if(!channel.destroyed){channel.exit(Number.isInteger(code)?code:143);channel.end()}});
 })));
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
let app,page;const errors=[],externalRequests=[],checks=[];
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const pane=()=>page.locator('.workspace-pane:not([hidden])'),settings=()=>pane().locator('.original-project-settings'),diagnostic=()=>settings().locator('.agent-environment');
async function capture(name){await diagnostic().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,name),scale:'css'})}
async function inspect(){await settings().getByRole('button',{name:'실행 환경 검사',exact:true}).click();await expect(settings().getByRole('button',{name:'실행 환경 검사',exact:true})).toBeEnabled()}
async function setWork(value){await settings().getByLabel('에이전트 작업 폴더',{exact:true}).fill(value);await settings().getByRole('button',{name:'저장하기',exact:true}).click();await expect(settings().getByRole('button',{name:'실행 환경 검사',exact:true})).toBeEnabled();await inspect()}
function passed(name){checks.push(name);console.log('PASS: '+name)}
try{
 const env={...process.env,...isolatedModelRuntime({home,dataPath}),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig,REVIEWOPS_SSH_CONFIG:sshConfig};for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))externalRequests.push(request.url())});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1500,1050));
 const group=await ipc('group.save',{name:'SSH 환경 진단 QA'});
 const service=await ipc('service.save',{groupId:group.id,name:'격리 SSH 서버',kind:'ssh',host:'127.0.0.1',port:server.address().port,username:'synthetic',authType:'password',password:'synthetic-diagnostics-password',rootPath:work,agentWorkPath:work,agentBinary:binary,agentEnabled:true});await assert.rejects(ipc('ssh.test',{serviceId:service.id}));await ipc('ssh.trust',{serviceId:service.id,fingerprint});
 const project=await ipc('project.save',{groupId:group.id,name:'SSH 폴더 진단 검사',serviceIds:[service.id]});
 await page.locator('.workspace-refresh').click();await page.getByRole('button',{name:`${project.name} 프로젝트 열기`,exact:true}).click();await pane().getByRole('navigation',{name:'프로젝트 기능',exact:true}).getByRole('button',{name:'설정',exact:true}).click();await settings().getByRole('tab',{name:'에이전트',exact:true}).click();
 await inspect();await expect(diagnostic()).toContainText('codex-cli synthetic-diagnostics');await expect(diagnostic()).toContainText('로그인됨');await capture('01-valid-folder.png');passed('정상 SSH 폴더에서 같은 합성 CLI 버전과 로그인됨 표시');
 await setWork(path.join(testRoot,'missing-folder'));await expect(diagnostic()).toContainText('Codex 설치 미확인');await expect(diagnostic()).toContainText('로그인 미확인');await expect(diagnostic()).toContainText('폴더 경로와 접근 권한을 확인하십시오.');await expect(diagnostic()).not.toContainText('Codex 설치 필요');await expect(diagnostic()).not.toContainText('작업 환경에 Codex CLI를 설치');await capture('02-missing-folder.png');passed('폴더만 없는 경로로 변경하면 설치 미확인·로그인 미확인과 폴더 조치 안내');
 await setWork(work);await expect(diagnostic()).toContainText('codex-cli synthetic-diagnostics');await expect(diagnostic()).toContainText('로그인됨');await capture('03-restored-folder.png');passed('원래 폴더로 복원하면 같은 CLI와 로그인 상태 재확인');
 const restricted=path.join(testRoot,'restricted-folder');fs.mkdirSync(restricted);fs.chmodSync(restricted,0o000);
 try{await setWork(restricted);await expect(diagnostic()).toContainText('Codex 설치 미확인');await expect(diagnostic()).toContainText('Permission denied');await expect(diagnostic()).not.toContainText('작업 환경에 Codex CLI를 설치');await capture('04-permission-denied.png');passed('실제 폴더 접근 권한 거부에서도 설치 안내 없이 폴더 조치 안내')}finally{fs.chmodSync(restricted,0o700)}
 await setWork(work);await settings().getByLabel('에이전트 실행 파일',{exact:true}).fill(path.join(bin,'missing-codex'));await settings().getByRole('button',{name:'저장하기',exact:true}).click();await inspect();await expect(diagnostic()).toContainText('Codex 설치 필요');await expect(diagnostic()).toContainText('로그인 검사 전');await expect(diagnostic()).toContainText('작업 환경에 Codex CLI를 설치하거나 실행 파일의 전체 경로를 지정하십시오.');await capture('05-missing-cli.png');passed('실제 실행 파일이 없는 경우의 설치 안내 유지');
 fs.writeFileSync(path.join(testRoot,'logged-out'),'');await settings().getByLabel('에이전트 실행 파일',{exact:true}).fill(binary);await settings().getByRole('button',{name:'저장하기',exact:true}).click();await inspect();await expect(diagnostic()).toContainText('codex-cli synthetic-diagnostics');await expect(diagnostic()).toContainText('로그인 필요');await expect(diagnostic()).not.toContainText('작업 환경에 Codex CLI를 설치');await capture('06-signin-required.png');passed('설치된 CLI의 로그인 필요 상태를 폴더·설치 오류와 구분');
 fs.unlinkSync(path.join(testRoot,'logged-out'));await inspect();await expect(diagnostic()).toContainText('로그인됨');
 assert.equal(fs.existsSync(path.join(testRoot,'unexpected-request')),false);assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
 const qaScenarios=[
  {id:'QA-034-001',status:'pass',operation:'정상 SSH 폴더에서 실행 환경 검사',expected:'CLI 버전과 로그인 상태 표시',actual:'codex-cli synthetic-diagnostics · 로그인됨',screenshot:'01-valid-folder.png'},
  {id:'QA-034-002',status:'pass',operation:'같은 CLI를 유지하고 없는 작업 폴더 저장 후 검사',expected:'폴더 안내와 설치·로그인 미확인, 재설치 안내 없음',actual:'Codex 설치 미확인 · 로그인 미확인 · 폴더 경로와 접근 권한 안내',screenshot:'02-missing-folder.png'},
  {id:'QA-034-003',status:'pass',operation:'정상 작업 폴더 복원 후 재검사',expected:'같은 CLI 버전과 로그인 상태 복구',actual:'codex-cli synthetic-diagnostics · 로그인됨',screenshot:'03-restored-folder.png'},
  {id:'QA-034-004',status:'pass',operation:'운영체제 권한을 000으로 제한한 폴더에서 검사',expected:'권한 오류와 설치 미확인, 재설치 안내 없음',actual:'Permission denied · Codex 설치 미확인 · 폴더 경로와 접근 권한 안내',screenshot:'04-permission-denied.png'},
  {id:'QA-034-005',status:'pass',operation:'정상 작업 폴더에서 없는 실행 파일 지정 후 검사',expected:'실제 미설치 안내 유지',actual:'Codex 설치 필요 · 로그인 검사 전 · CLI 설치/경로 지정 안내',screenshot:'05-missing-cli.png'},
  {id:'QA-034-006',status:'pass',operation:'설치된 합성 CLI가 로그인 상태 코드 1을 반환하도록 한 후 검사',expected:'설치 버전과 로그인 필요 표시',actual:'codex-cli synthetic-diagnostics · 로그인 필요',screenshot:'06-signin-required.png'}
 ];
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:true,checks,qaScenarios,rendererErrors:errors,externalRequests,environment:'Source Electron app; local synthetic SSH server and fake Codex CLI; actual OS directory permission denial',testRoot,screenshots:output,actualAgentRequests:0},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,screenshots:output}));
}catch(error){await page?.screenshot({path:path.join(output,'failure.png'),scale:'css'}).catch(()=>{});throw error}
finally{await app?.close().catch(()=>{});for(const child of commands)try{process.kill(-child.pid,'SIGKILL')}catch{};for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve))}
