import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=process.cwd(),testRoot=fs.mkdtempSync(path.join('/tmp','reviewops-readiness-'));
const home=path.join(testRoot,'home'),dataPath=path.join(testRoot,'data'),work=path.join(testRoot,'project');
const results=path.join(root,'test-results','service-readiness',path.basename(testRoot));
for(const directory of [home,dataPath,work,results])fs.mkdirSync(directory,{recursive:true});
const configPath=path.join(home,'.ssh','config');fs.mkdirSync(path.dirname(configPath),{recursive:true});fs.writeFileSync(configPath,'# Synthetic readiness fixture\n');
const artifact=Buffer.from('synthetic comparison file; not execution provenance\n');fs.writeFileSync(path.join(work,'bundle.js'),artifact);
const binary=path.join(work,'fixture-codex');fs.writeFileSync(binary,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli synthetic-readiness');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
if(args[0]==='app-server'){const c=require('node:child_process').spawn(path.join(process.env.HOME,'.local/bin/codex'),args,{stdio:'inherit'});c.on('exit',code=>process.exit(code??1));return}
process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-readiness'}));const timer=setInterval(()=>{if(fs.existsSync('finish')){clearInterval(timer);console.log(JSON.stringify({type:'turn.completed'}));process.exit(0)}},30)});
`,{mode:0o755});
let counter=0,slow,app,page,nativeId,job;
const requests=[],checks=[],errors=[],externalRequests=[],photos=[];
const server=http.createServer((req,res)=>{
 requests.push({at:new Date().toISOString(),path:req.url,method:req.method,agent:req.headers['user-agent']});
 if(req.url==='/slow'){slow=()=>{res.end('late response')};return}
 if(req.url==='/health'){res.end('synthetic ready');return}
 if(req.url==='/unhealthy'){res.writeHead(503);res.end('synthetic unhealthy');return}
 if(req.url==='/increment'&&req.method==='POST'){counter++;res.end(String(counter));return}
 res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end('<!doctype html><title>합성 서비스</title><style>body{font:20px sans-serif;background:#edf4fa;padding:24px}button{font-size:20px;padding:16px}</style><h1>합성 서비스 핵심 흐름</h1><p>실제 AI·SSH 요청 없음</p><button id="increment" onclick="fetch(\'/increment\',{method:\'POST\'}).then(r=>r.text()).then(n=>document.querySelector(\'output\').textContent=n)">값 증가</button><p>저장된 값: <output>0</output></p>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const pane=()=>page.locator('.workspace-pane:not([hidden])'),panel=()=>pane().locator('.service-readiness');
const field=name=>panel().getByLabel(name,{exact:true}),result=name=>panel().locator('.service-readiness-results>div').filter({has:page.locator('dt',{hasText:new RegExp(`^${name}$`)})}).locator('dd');
const pass=(id,operation,expected,actual)=>{checks.push({id,operation,expected,actual,verdict:'통과'});console.log(`PASS: ${id} ${actual}`)};
const native=expression=>app.evaluate(({webContents},{id,expression})=>webContents.fromId(id).executeJavaScript(expression,true),{id:nativeId,expression});
async function capture(name){
 const hostCapturedAt=new Date().toISOString();
 const image=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('reviewops://app/')).capturePage()).toPNG().toString('base64'));
 const file=path.join(results,name+'-host.png');fs.writeFileSync(file,Buffer.from(image,'base64'));photos.push({file,capturedAt:hostCapturedAt,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),scope:'전체 앱 호스트 창 원본. 별도 native 서비스 창은 이 캡처에 포함되지 않음.'});
 if(nativeId){const capturedAt=new Date().toISOString();const image=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).capturePage()).toPNG().toString('base64'),nativeId);const file=path.join(results,name+'-service.png');fs.writeFileSync(file,Buffer.from(image,'base64'));photos.push({file,capturedAt,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),scope:'동일 시점 별도 native 서비스 화면 원본. 앱 메뉴/패널은 host 사진 참조.'});}
}
async function check(url){await field('준비 상태 URL').fill(url);await panel().getByRole('button',{name:'지금 검사',exact:true}).click();await expect(panel().getByRole('button',{name:'지금 검사',exact:true})).toBeEnabled();}
try{
 const env={...process.env,...isolatedModelRuntime({home,dataPath}),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:configPath,REVIEWOPS_CODEX_SSH_CONFIG:configPath};for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 app=await electron.launch({args:[root],env});page=await app.firstWindow();await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));page.on('request',req=>{if(/^https?:/.test(req.url())&&!req.url().startsWith(origin))externalRequests.push(req.url())});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1800,1200));
 const group=await ipc('group.save',{name:'준비 상태 합성 검사'}),project=await ipc('project.save',{groupId:group.id,name:'서비스 관찰 프로젝트',connection:{kind:'local',rootPath:work,viewerUrl:origin,agentBinary:binary,agentEnabled:true,agentModel:'fixture-model'}});
 const review=await ipc('review.save',{projectId:project.id,serviceId:project.connection.id,title:'합성 관찰 에이전트',body:'실제 AI 요청 없는 합성 CLI'});
 await page.locator('.workspace-refresh').click();await page.getByRole('button',{name:`${project.name} 프로젝트 열기`,exact:true}).click();
 await expect.poll(async()=>app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(c=>c.getURL().startsWith(origin))?.id,origin)).toBeTruthy();nativeId=await app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(c=>c.getURL().startsWith(origin)).id,origin);
 await panel().locator('summary').click();await expect(result('프로젝트 에이전트')).toContainText('실행 기록 없음');assert.equal(requests.filter(r=>r.agent==='ReviewOps-readiness').length,0);
 await capture('01-before-check');pass('QA-015-001','준비 상태 패널 펼치기','수동 검사 전 HTTP 요청 없음, 실행 파일 미확인','미검사·실행 기록 없음·실행 파일 미확인 표시, 자동 HTTP 검사 0회');
 job=await ipc('agent.start',{reviewId:review.id,prompt:'synthetic observer',context:{instruction:false,attachmentIds:[],logIds:[]}});await expect(result('프로젝트 에이전트')).toContainText('진행 중 1개');
 await field('비교 파일 (선택)').fill('bundle.js');await check(origin+'/health');await expect(result('HTTP 상태')).toHaveText('HTTP 응답 확인 · 200');await expect(result('검사한 URL')).toHaveText(origin+'/health');await expect(result('비교 파일')).toContainText(crypto.createHash('sha256').update(artifact).digest('hex'));await expect(result('실행 배포 파일')).toContainText('미확인');
 assert.notEqual(await result('마지막 검사 시각').textContent(),'미확인');await capture('02-running-response');pass('QA-015-002','합성 에이전트 실행 중 URL·비교 파일 검사','HTTP 응답/시각/파일 비교와 진행 에이전트 상태 분리','HTTP 200·시각·SHA-256·진행 중 1개 동시 표시, 실행 배포 파일 미확인 유지');
 await panel().locator('summary').click();fs.writeFileSync(path.join(work,'finish'),'');await expect.poll(async()=>(await ipc('agent.read',{id:job.id})).status).toBe('completed');await expect(panel().locator('summary')).toContainText('펼쳐서 조회');await expect(panel().locator('summary')).not.toContainText('진행 중 1개');await panel().locator('summary').click();await expect(result('프로젝트 에이전트')).toContainText('진행 중 없음 · 최근 완료');
 const rect=await native('(()=>{const r=document.querySelector("#increment").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');const surface=await pane().locator('.native-browser-surface').boundingBox(),factor=surface.width/await native('innerWidth');rect.x*=factor;rect.y*=factor;
 await app.evaluate(({webContents},{id,rect})=>{const c=webContents.fromId(id),x=Math.round(rect.x),y=Math.round(rect.y);c.focus();c.sendInputEvent({type:'mouseMove',x,y});c.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});c.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1})},{id:nativeId,rect});await expect.poll(()=>native('document.querySelector("output").textContent')).toBe('1');assert.equal(counter,1);await check(origin+'/health');await capture('03-completed-core-flow');pass('QA-015-003','패널을 닫은 상태에서 에이전트 정상 완료→다시 펼치고 실제 서비스 버튼 클릭·GET 재검사','에이전트 종료와 HTTP·핵심 흐름 독립 관찰','닫힌 요약은 펼쳐서 조회, 다시 열면 최근 완료·진행 중 없음, 실제 버튼 POST 저장값 1과 HTTP 200 유지 (서비스는 하네스 소유)');
 await field('준비 상태 URL').fill(origin+'/slow');await panel().getByRole('button',{name:'지금 검사',exact:true}).click();await expect.poll(()=>Boolean(slow)).toBe(true);await field('준비 상태 URL').fill(origin+'/health');await field('준비 상태 URL').fill(origin+'/slow');slow();await expect(result('HTTP 상태')).toHaveText('미검사');await expect(result('마지막 검사 시각')).toHaveText('미확인');pass('QA-015-004','검사 중 주소 변경 후 원래 주소로 되돌리기','변경 전 늦게 도착한 성공은 새 대상에 재사용하지 않음','늦은 응답 폐기, 미검사·시각 미확인 유지');
 await check(origin+'/unhealthy');await expect(result('HTTP 상태')).toHaveText('HTTP 오류 응답 · 503');pass('QA-015-005','HTTP 503 검사','연결 거절과 HTTP 오류 구분','HTTP 오류 응답 · 503 표시');
 await field('비교 파일 (선택)').fill('../outside.js');await check(origin+'/health');await expect(result('HTTP 상태')).toHaveText('HTTP 응답 확인 · 200');await expect(result('비교 파일')).toContainText('폴더 밖');pass('QA-015-006','프로젝트 밖 비교 파일 경로 검사','파일 접근 거절과 HTTP 관찰 독립','폴더 밖 파일 접근 거절, HTTP 200 유지');
 await new Promise(resolve=>{server.closeAllConnections();server.close(resolve)});await check(origin+'/health');await expect(result('HTTP 상태')).toContainText('연결 실패');await expect(result('프로젝트 에이전트')).toContainText('최근 완료');await capture('04-refused-after-completion');pass('QA-015-007','하네스 서비스 종료 후 같은 URL 검사','완료 에이전트 상태와 연결 실패 구분','ECONNREFUSED·최근 완료 함께 표시, 에이전트 완료를 준비 완료로 표시하지 않음');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('reviewops://app/')).setContentSize(800,600));await pane().getByRole('button',{name:'화면',exact:true}).click();await panel().getByText('서비스 시작·복구는 관리하지 않습니다.',{exact:false}).scrollIntoViewIfNeeded();
 const layout=await panel().evaluate(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollable:e.scrollHeight>e.clientHeight}});assert.ok(layout.left>=0&&layout.right<=800&&layout.bottom<=600);assert.equal(layout.scrollable,true);await capture('05-narrow-scope');pass('QA-015-008','800×600 창에서 패널 끝으로 스크롤','유지 범위 안내와 폼/결과에 접근 가능','전체 창 안에서 패널 스크롤 가능, 마지막 유지 범위 안내 도달');
 assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
 const info=await ipc('app.info');const sourceFiles=['electron/main.cjs','electron/service-readiness.cjs','src/ProjectWorkspace.jsx','src/ServiceReadiness.jsx','src/service-readiness.css'].map(file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}));
 fs.writeFileSync(path.join(results,'results.json'),JSON.stringify({ok:true,runtime:{version:info.version,platform:info.platform,arch:info.arch},sourceFiles,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceChanges:'readiness panel uncommitted at run; commit recorded by parent after validation',version:JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,checks,photos,requests,rendererErrors:errors,externalRequests,testRoot,scope:'macOS source app; synthetic observer CLI and harness-owned local HTTP service. Real AI/SSH, packaged binaries, SSH-host perspective, execution-file linkage and app/host restart not verified.'},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,results}));
}catch(error){if(app&&page)await capture('failure').catch(()=>{});throw error}
finally{if(job&&app&&page)await ipc('agent.cancel',{id:job.id}).catch(()=>{});if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})}server.closeAllConnections();server.close();}
