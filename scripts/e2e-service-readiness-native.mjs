// Preparation only. Original eight scenario assertions are preserved and updated for the reviewed observation wording.
import {setTestLocale} from './test-locale.mjs';
import {regressionContext,launchRegression,finishRegression,until,bounded,nativeSourceRead,capturePair} from './native-regression-contract.mjs';
import {sourceIdentity} from './native-adapters.mjs';
import {verifyNativePacket} from './native-packet.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const context=await regressionContext('panel8'),{root,paths,fixture,report,packet}=context;
const testRoot=paths.root,home=paths.home,dataPath=paths.data,work=path.join(testRoot,'project'),results=packet.outputDir,binary=fixture.agentExecutable;
for(const directory of [home,dataPath,work,results])fs.mkdirSync(directory,{recursive:true});
const configPath=paths.ssh;
const artifact=Buffer.from('synthetic comparison file; not execution provenance\n');fs.writeFileSync(path.join(work,'bundle.js'),artifact);
let counter=0,slow,app,page,nativeId,browserId,job,owner,session;
const requests=[],checks=report.checks,errors=report.errors,externalRequests=[],photos=report.photos;
const server=http.createServer((req,res)=>{
 requests.push({at:new Date().toISOString(),path:req.url,method:req.method,agent:req.headers['user-agent']});
 if(req.url==='/slow'){slow=()=>{res.end('late response')};return}
 if(req.url==='/health'){res.end('synthetic ready');return}
 if(req.url==='/unhealthy'){res.writeHead(503);res.end('synthetic unhealthy');return}
 if(req.url==='/increment'&&req.method==='POST'){counter++;res.end(String(counter));return}
 res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end('<!doctype html><title>합성 서비스</title><style>body{font:20px sans-serif;background:#edf4fa;padding:24px}button{font-size:20px;padding:16px}</style><h1>합성 서비스 핵심 흐름</h1><p>실제 AI·SSH 요청 없음</p><button id="increment" onclick="fetch(\'/increment\',{method:\'POST\'}).then(r=>r.text()).then(n=>document.querySelector(\'output\').textContent=n)">값 증가</button><p>저장된 값: <output>0</output></p>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const ipc=(action,payload={})=>session.ipc(page,action,payload);
const ipcPage=(page,action,payload={})=>session.ipc(page,action,payload);
const pane=()=>page.locator('.workspace-pane:not([hidden])'),panel=()=>pane().locator('.service-readiness');
const field=name=>panel().getByLabel(name,{exact:true}),result=name=>panel().locator('.service-readiness-results>div').filter({has:page.locator('dt',{hasText:new RegExp(`^${name}$`)})}).locator('dd');
const pass=(id,operation,expected,actual)=>{checks.push({id,operation,expected,actual,verdict:'통과',status:'pass'});console.log(`PASS: ${id} ${actual}`)};
const native=expression=>nativeSourceRead(app,page,origin+'/',browserId,ipcPage,expression);
async function capture(name){await capturePair(context,app,page,name,origin+'/',browserId,ipcPage);}
async function resize(width,height){const host=await bounded(app.browserWindow(page),'exact panel host');await bounded(host.evaluate((win,{width,height})=>win.setContentSize(width,height),{width,height}),'panel host size');}
async function check(url){await field('준비 상태 URL').fill(url);await panel().getByRole('button',{name:'지금 검사',exact:true}).click();await expect(panel().getByRole('button',{name:'지금 검사',exact:true})).toBeEnabled();}
try{
 session=await launchRegression(context);({app,owner,main:page}=session);await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));page.on('request',req=>{if(/^https?:/.test(req.url())&&!req.url().startsWith(origin))externalRequests.push(req.url())});
 await resize(1800,1200);
 const group=await ipc('group.save',{name:'준비 상태 합성 검사'}),project=await ipc('project.save',{groupId:group.id,name:'서비스 관찰 프로젝트',connection:{kind:'local',rootPath:work,viewerUrl:origin,agentBinary:binary,agentEnabled:true,agentModel:'fixture-model'}});
 const review=await ipc('review.save',{projectId:project.id,serviceId:project.connection.id,title:'합성 관찰 에이전트',body:'실제 AI 요청 없는 합성 CLI'});
 await page.locator('.workspace-refresh').click();await page.getByRole('button',{name:`${project.name} 프로젝트 열기`,exact:true}).click();
 await expect(pane().locator('.native-browser-surface')).toHaveAttribute('data-browser-id',/.+/);browserId=await pane().locator('.native-browser-surface').getAttribute('data-browser-id');
 const source=await until(()=>sourceIdentity(app,page,origin+'/',browserId,ipcPage,bounded,{allowPending:true}),Boolean,'exact panel native source');nativeId=source.webContentsId;
 await panel().locator('summary').click();await expect(result('프로젝트 에이전트')).toContainText('실행 기록 없음');assert.equal(requests.filter(r=>r.agent==='ReviewOps-readiness').length,0);
 await capture('01-before-check');pass('QA-015-001','준비 상태 패널 펼치기','수동 검사 전 HTTP 요청 없음, 실행 파일 미확인','미검사·실행 기록 없음·HTTP/비교 파일만으로 실행 파일을 확인하지 않는다는 안내, 자동 HTTP 검사 0회');
 job=await ipc('agent.start',{reviewId:review.id,prompt:'synthetic observer',context:{instruction:false,attachmentIds:[],logIds:[]}});await expect(result('프로젝트 에이전트')).toContainText('진행 중 1개');
 await field('비교 파일 (선택)').fill('bundle.js');await check(origin+'/health');await expect(result('HTTP 상태')).toHaveText('HTTP 응답 확인 · 200');await expect(result('검사한 URL')).toHaveText(origin+'/health');await expect(result('비교 파일')).toContainText(crypto.createHash('sha256').update(artifact).digest('hex'));await expect(result('실행 배포 파일')).toHaveText('HTTP 응답과 비교 파일만으로 실행 프로세스나 배포 파일을 확인하지 않습니다.');
 assert.notEqual(await result('마지막 검사 시각').textContent(),'미확인');await capture('02-running-response');pass('QA-015-002','합성 에이전트 실행 중 URL·비교 파일 검사','HTTP 응답/시각/파일 비교와 진행 에이전트 상태 분리','HTTP 200·시각·SHA-256·진행 중 1개 동시 표시, 실행 배포 파일 미확인 의미의 새 안내 유지');
 await panel().locator('summary').click();fs.writeFileSync(path.join(work,'finish'),'');await expect.poll(async()=>(await ipc('agent.read',{id:job.id})).status).toBe('completed');await expect(panel().locator('summary')).toContainText('펼쳐서 조회');await expect(panel().locator('summary')).not.toContainText('진행 중 1개');await panel().locator('summary').click();await expect(result('프로젝트 에이전트')).toContainText('진행 중 없음 · 최근 완료');
 const rect=await native('(()=>{const r=document.querySelector("#increment").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');const surface=await pane().locator('.native-browser-surface').boundingBox(),factor=surface.width/await native('innerWidth');rect.x*=factor;rect.y*=factor;
 await bounded(app.evaluate(({webContents},{id,rect})=>{const c=webContents.fromId(id),x=Math.round(rect.x),y=Math.round(rect.y);c.focus();c.sendInputEvent({type:'mouseMove',x,y});c.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});c.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1})},{id:nativeId,rect}),'exact native panel click');await expect.poll(()=>native('document.querySelector("output").textContent')).toBe('1');assert.equal(counter,1);await check(origin+'/health');await capture('03-completed-core-flow');pass('QA-015-003','패널을 닫은 상태에서 에이전트 정상 완료→다시 펼치고 실제 서비스 버튼 클릭·GET 재검사','에이전트 종료와 HTTP·핵심 흐름 독립 관찰','닫힌 요약은 펼쳐서 조회, 다시 열면 최근 완료·진행 중 없음, 실제 버튼 POST 저장값 1과 HTTP 200 유지 (서비스는 하네스 소유)');
 await field('준비 상태 URL').fill(origin+'/slow');await panel().getByRole('button',{name:'지금 검사',exact:true}).click();await expect.poll(()=>Boolean(slow)).toBe(true);await field('준비 상태 URL').fill(origin+'/health');await field('준비 상태 URL').fill(origin+'/slow');slow();await expect(result('HTTP 상태')).toHaveText('미검사');await expect(result('마지막 검사 시각')).toHaveText('미확인');pass('QA-015-004','검사 중 주소 변경 후 원래 주소로 되돌리기','변경 전 늦게 도착한 성공은 새 대상에 재사용하지 않음','늦은 응답 폐기, 미검사·시각 미확인 유지');
 await check(origin+'/unhealthy');await expect(result('HTTP 상태')).toHaveText('HTTP 오류 응답 · 503');pass('QA-015-005','HTTP 503 검사','연결 거절과 HTTP 오류 구분','HTTP 오류 응답 · 503 표시');
 await field('비교 파일 (선택)').fill('../outside.js');await check(origin+'/health');await expect(result('HTTP 상태')).toHaveText('HTTP 응답 확인 · 200');await expect(result('비교 파일')).toContainText('폴더 밖');pass('QA-015-006','프로젝트 밖 비교 파일 경로 검사','파일 접근 거절과 HTTP 관찰 독립','폴더 밖 파일 접근 거절, HTTP 200 유지');
 await bounded(new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),'close own HTTP fixture before refused probe',8000);await check(origin+'/health');await expect(result('HTTP 상태')).toContainText('연결 실패');await expect(result('프로젝트 에이전트')).toContainText('최근 완료');await capture('04-refused-after-completion');pass('QA-015-007','하네스 서비스 종료 후 같은 URL 검사','완료 에이전트 상태와 연결 실패 구분','ECONNREFUSED·최근 완료 함께 표시, 에이전트 완료를 준비 완료로 표시하지 않음');
 await resize(800,600);await pane().getByRole('button',{name:'화면',exact:true}).click();await panel().getByText('에이전트 완료와 서비스 종료는 다릅니다. 직접 시작한 외부 서비스의 수명은 별도로 확인해야 합니다.',{exact:false}).scrollIntoViewIfNeeded();
 const layout=await panel().evaluate(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollable:e.scrollHeight>e.clientHeight}});assert.ok(layout.left>=0&&layout.right<=800&&layout.bottom<=600);assert.equal(layout.scrollable,true);await capture('05-narrow-scope');pass('QA-015-008','800×600 창에서 패널 끝으로 스크롤','유지 범위 안내와 폼/결과에 접근 가능','전체 창 안에서 패널 스크롤 가능, 마지막 유지 범위 안내 도달');
 assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
 const info=await ipc('app.info');const sourceFiles=['electron/main.cjs','electron/service-readiness.cjs','src/ProjectWorkspace.jsx','src/ServiceReadiness.jsx','src/service-readiness.css'].map(file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}));
 assert.equal(checks.length,8);await verifyNativePacket(packet);Object.assign(report,{runtime:{version:info.version,platform:info.platform,arch:info.arch},sourceFiles,sourceCommit:context.source,requests,externalRequests,testRoot,scope:'Exact native target and declared source/installed mode; synthetic observer CLI and harness-owned HTTP service. External AI/SSH0; no loaded-bytes or HTTP ownership claim.',scenariosComplete:true});
}catch(error){report.failure={message:error.message,stack:error.stack};if(app&&page)await capture('failure').catch(()=>{});throw error}
finally{await finishRegression(context,{app,owner,main:page,ipc:session?.ipc,jobs:job?[job.id]:[],server,release:async()=>{slow?.();fs.writeFileSync(path.join(work,'finish'),'');}});console.log(JSON.stringify({ok:report.ok,source:context.source,target:context.target,gate:'panel8',resultPath:packet.resultPath,cleanup:report.cleanup}));}
