import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd(),testRoot=fs.mkdtempSync(path.join('/tmp','reviewops-agent-start-'));
const dataPath=path.join(testRoot,'data'),work=path.join(testRoot,'work'),home=path.join(testRoot,'home'),results=path.join(root,'test-results');
for(const directory of [dataPath,work,home,results])fs.mkdirSync(directory,{recursive:true});
const sshConfig=path.join(home,'.ssh','config');fs.mkdirSync(path.dirname(sshConfig),{recursive:true});fs.writeFileSync(sshConfig,'# Synthetic agent start fixture\n',{mode:0o600});
const attachment=path.join(testRoot,'전송할 자료.txt');fs.writeFileSync(attachment,'SYNTHETIC_ATTACHMENT_CONTENT');
const binary=path.join(testRoot,'fixture-codex');
fs.writeFileSync(binary,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),file=name=>path.join(process.cwd(),name);
if(args[0]==='--version'){console.log('codex-cli synthetic-start');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
if(args[0]==='app-server'){const child=require('node:child_process').spawn(path.join(process.env.HOME,'.local/bin/codex'),args,{stdio:'inherit'});child.once('error',()=>process.exit(79));child.once('exit',code=>process.exit(code??1));return}
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const previous=fs.existsSync(file('requests.json'))?JSON.parse(fs.readFileSync(file('requests.json'),'utf8')):[];
 previous.push({args,input});fs.writeFileSync(file('requests.json'),JSON.stringify(previous));
 const send=event=>console.log(JSON.stringify(event));send({type:'thread.started',thread_id:'synthetic-start-session'});send({type:'turn.started'});
 const timer=setInterval(()=>{if(fs.existsSync(file('finish-request'))){clearInterval(timer);send({type:'turn.failed',error:{message:'합성 실행 종료'}});process.exitCode=1;}},50);
});
`,{mode:0o755});
const legacyMessage='이전에 저장한 SSH 비밀번호는 다시 입력해야 합니다. 호스트관리에서 SSH 키를 등록한 뒤 프로젝트의 SSH 호스트를 선택하십시오. 기존 암호화 자료는 새 값을 저장하기 전까지 보존됩니다.';
const fingerprint='SHA256:synthetic-agent-start-trust-fingerprint';
const checks=[],errors=[],network=[];let app,page,group,sshService,localService,project,legacyReview,localReview;
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const panel=()=>page.locator('.work-home .agent-panel').last();
const draft=id=>page.evaluate(id=>JSON.parse(localStorage.getItem(`reviewops.agent.draft.${id}`)||'{}'),id);
const fixtureRequests=()=>fs.existsSync(path.join(work,'requests.json'))?JSON.parse(fs.readFileSync(path.join(work,'requests.json'),'utf8')):[];
const passed=value=>{checks.push(value);console.log('PASS: '+value)};
async function launch(){
 const env={...process.env,...isolatedModelRuntime({home,dataPath}),REVIEWOPS_SSH_CONFIG:sshConfig,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig,REVIEWOPS_DATA_DIR:dataPath};for(const name of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});page=await app.firstWindow(); await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))network.push(request.url())});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1500,1000));await page.waitForFunction(()=>!!window.reviewops?.invoke);await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
}
async function close(){if(!app)return;await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});app=null;}
async function openReview(value){
 await page.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();await page.locator('.workspace-refresh').click();await page.locator(`[data-tree-node="r-${value.id}"]`).click();await page.locator('.work-home').getByRole('tab',{name:'에이전트',exact:true}).click();await expect(panel().getByLabel('에이전트 작업 요청',{exact:true})).toBeEnabled();
}
async function attach(){
 await app.evaluate(({dialog},attachment)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[attachment]})},attachment);await panel().getByRole('button',{name:'에이전트 자료 추가',exact:true}).click();await page.getByRole('menuitem',{name:'파일 첨부',exact:true}).click();await expect(panel().getByLabel('선택한 에이전트 자료')).toContainText(path.basename(attachment));
}
async function mode(value){await app.evaluate((_electron,value)=>Object.assign(globalThis.__reviewopsAgentStartFixture,value),value);}
try{
 await launch();group=await ipc('group.save',{name:'에이전트 전송 검사'});
 sshService=await ipc('service.save',{groupId:group.id,name:'이전 인증 정보 검사',kind:'ssh',host:'127.0.0.1',port:9,username:'synthetic',authType:'password',rootPath:'/synthetic',agentWorkPath:'/synthetic',agentEnabled:true});
 localService=await ipc('service.save',{groupId:group.id,name:'합성 CLI',kind:'local',rootPath:work,agentWorkPath:work,agentBinary:binary,agentEnabled:true});project=await ipc('project.save',{groupId:group.id,name:'SSH 전송 검사 프로젝트',serviceIds:[sshService.id]});const localProject=await ipc('project.save',{groupId:group.id,name:'로컬 전송 검사 프로젝트',serviceIds:[localService.id]});
 legacyReview=await ipc('review.save',{projectId:project.id,serviceId:sshService.id,title:'이전 인증 정보 오류',body:'합성 요청',status:'open'});localReview=await ipc('review.save',{projectId:localProject.id,serviceId:localService.id,title:'수락 후 새로고침 실패',body:'합성 요청',status:'open'});
 await close();
 // Only this disposable app's vault is changed. No system Keychain or real account is accessed.
 fs.writeFileSync(path.join(dataPath,'credentials.json'),JSON.stringify({[sshService.id]:{password:Buffer.from('synthetic legacy encrypted value').toString('base64')}}),{mode:0o600});
 await launch();
 // Inject transport replies only for failure states; accepted work still uses the real IPC handler and fixture CLI.
 await app.evaluate(({ipcMain})=>{
  const original=ipcMain._invokeHandlers.get('reviewops:invoke');if(typeof original!=='function')throw new Error('합성 IPC 처리기를 찾지 못했습니다.');
  const state=globalThis.__reviewopsAgentStartFixture={mode:'normal',starts:[],failRefreshAfterStart:false,snapshotFailures:0,materialFailures:0};
  ipcMain.removeHandler('reviewops:invoke');ipcMain.handle('reviewops:invoke',async(event,action,payload)=>{
   if(action==='agent.start'){
    state.starts.push(payload);
    if(state.mode==='trust')return {ok:false,error:{code:'SSH_TRUST_REQUIRED',message:'합성 서버의 SSH 지문을 확인하십시오.',host:'synthetic.example.test',fingerprint:'SHA256:synthetic-agent-start-trust-fingerprint'}};
    if(state.mode==='retry-error')return {ok:false,error:{code:'CREDENTIALS_REENTRY_REQUIRED',message:'합성 재실행 인증 정보를 다시 입력하십시오.'}};
   }
   if(action==='snapshot'&&state.snapshotFailures>0){state.snapshotFailures--;return {ok:false,error:{code:'SYNTHETIC_REFRESH_ERROR',message:'합성 화면 새로고침 오류'}};}
   if(action==='agent.materials'&&state.materialFailures>0){state.materialFailures--;return {ok:false,error:{code:'SYNTHETIC_MATERIAL_ERROR',message:'합성 첨부 자료 새로고침 오류'}};}
   const result=await original(event,action,payload);
   if(action==='agent.start'&&result.ok&&result.data?.id&&state.failRefreshAfterStart){state.failRefreshAfterStart=false;state.snapshotFailures=1;state.materialFailures=1;}
   return result;
  });
 });
 await openReview(legacyReview);await attach();await panel().getByLabel('에이전트 작업 요청',{exact:true}).fill('오류가 발생해도 유지할 요청');const before=await draft(legacyReview.id);
 await panel().getByRole('button',{name:'작업 요청',exact:true}).click();await expect(panel().locator('.agent-composer [role="alert"]')).toHaveText(legacyMessage);await expect(panel().getByLabel('에이전트 작업 요청',{exact:true})).toHaveValue(before.prompt);await expect(page.locator('.error-banner')).toHaveCount(0);
 const rejected=await draft(legacyReview.id);assert.ok(rejected.requestId);assert.deepEqual({...rejected,requestId:null},{...before,requestId:null});assert.equal((await ipc('attachment.staged',{tokens:before.pending.map(file=>file.token)})).files.length,before.pending.length);assert.deepEqual(await ipc('agent.list',{reviewId:legacyReview.id}),[]);assert.equal(fixtureRequests().length,0);await page.screenshot({path:path.join(results,'agent-start-legacy-error.png'),scale:'css'});passed('실제 이전 인증 자료 오류를 입력창에 표시하고 요청·선택 자료·임시 첨부·요청 ID 유지');
 await panel().getByRole('button',{name:'작업 요청',exact:true}).click();await expect(panel().locator('.agent-composer [role="alert"]')).toHaveText(legacyMessage);assert.equal((await draft(legacyReview.id)).requestId,rejected.requestId);passed('시작이 거절된 같은 요청을 재전송할 때 요청 ID 유지');
 await mode({mode:'trust'});await panel().getByRole('button',{name:'작업 요청',exact:true}).click();const trust=page.getByRole('dialog',{name:'SSH 호스트 확인',exact:true});await expect(trust).toContainText(fingerprint);await expect(trust).toContainText('synthetic.example.test');await trust.getByRole('button',{name:'취소',exact:true}).click();assert.deepEqual(await draft(legacyReview.id),rejected);passed('SSH 신뢰 오류의 코드와 지문을 전달하여 확인 창 표시, 취소 후 초안 유지');
 await mode({mode:'normal'});await openReview(localReview);await attach();await panel().getByLabel('에이전트 작업 요청',{exact:true}).fill('수락 후 새로고침 실패 검사');const localBefore=await draft(localReview.id);await mode({failRefreshAfterStart:true});await panel().getByRole('button',{name:'작업 요청',exact:true}).click();
 await expect(panel().getByLabel('에이전트 작업 요청',{exact:true})).toHaveValue('');await expect(panel().locator('.agent-composer [role="alert"]')).toContainText('작업 요청은 저장되었습니다.');await expect(panel().locator('.agent-composer [role="alert"]')).toContainText('합성 첨부 자료 새로고침 오류');await expect(panel().getByRole('button',{name:'작업 중지',exact:true})).toBeVisible();await expect.poll(()=>fixtureRequests().length).toBe(1);let runs=await ipc('agent.list',{reviewId:localReview.id});assert.equal(runs.length,1);assert.equal(runs[0].status,'running');const acceptedId=runs[0].id,acceptedDraft=await draft(localReview.id);assert.equal(acceptedDraft.prompt,'');assert.deepEqual(acceptedDraft.pending,[]);assert.equal(acceptedDraft.requestId,null);assert.equal(acceptedDraft.instruction,false);assert.equal(acceptedDraft.screenshotId,null);assert.deepEqual(acceptedDraft.attachmentIds,[]);assert.deepEqual(acceptedDraft.logIds,[]);assert.deepEqual((await ipc('attachment.staged',{tokens:localBefore.pending.map(file=>file.token)})).expiredTokens,localBefore.pending.map(file=>file.token));
 await panel().getByLabel('에이전트 작업 요청',{exact:true}).press('Control+Enter');await page.waitForTimeout(200);assert.equal(fixtureRequests().length,1);assert.equal((await ipc('agent.list',{reviewId:localReview.id})).length,1);await page.screenshot({path:path.join(results,'agent-start-accepted-refresh-error.png'),scale:'css'});passed('실제 CLI가 수락한 뒤 화면·자료 새로고침이 실패해도 초안 정리와 진행 상태를 유지하고 중복 전송 방지');
 fs.writeFileSync(path.join(work,'finish-request'),'');await expect.poll(async()=>(await ipc('agent.list',{reviewId:localReview.id}))[0]?.status).toBe('failed');await expect(panel().locator('.agent-answer').last().getByRole('button',{name:'재실행',exact:true})).toBeVisible();await panel().getByLabel('에이전트 작업 요청',{exact:true}).fill('재실행과 별도로 보존할 초안');await attach();const retryDraft=await draft(localReview.id);await mode({mode:'retry-error'});await panel().locator('.agent-answer').last().getByRole('button',{name:'재실행',exact:true}).click();await expect(panel().locator('.agent-composer [role="alert"]')).toHaveText('합성 재실행 인증 정보를 다시 입력하십시오.');assert.deepEqual(await draft(localReview.id),retryDraft);assert.equal((await ipc('agent.list',{reviewId:localReview.id}))[0].id,acceptedId);assert.equal(fixtureRequests().length,1);passed('재실행 거절의 원문 표시와 별도로 작성 중인 요청·첨부 보존');
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);fs.writeFileSync(path.join(results,'agent-start.json'),JSON.stringify({ok:true,checks,rendererErrors:errors,externalRequests:network,fixtureCliRequests:fixtureRequests().length,testRoot,executable:process.env.REVIEWOPS_TEST_EXECUTABLE||'development'},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,testRoot}));
}catch(error){await page?.screenshot({path:path.join(results,'agent-start-failure.png'),scale:'css'}).catch(()=>{});console.error('AGENT_START_FAILURE',testRoot,error);throw error;}finally{await close();}
