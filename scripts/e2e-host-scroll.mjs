import {_electron as electron, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {setTestLocale} from './test-locale.mjs';

const root=process.cwd(),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-host-scroll-'));
const home=path.join(temporary,'home'),dataPath=path.join(temporary,'data'),config=path.join(temporary,'ssh-config');
const output=path.join(root,'test-results','host-scroll');
const require=createRequire(import.meta.url),{createStore}=require('../electron/store.cjs');
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(config,'# Isolated scroll fixture\n');
const checks=[],errors=[],requests=[],measurements=[];let app,page;
const pane=()=>page.locator('.workspace-pane:not([hidden])');
const pass=name=>{checks.push(name);console.log('PASS: '+name)};
const files=()=>page.locator('.host-files-table-scroll');
const row=name=>page.getByRole('button',{name:name+' 파일 선택',exact:true});
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});

async function resize(width,height){
 await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('reviewops://app/')).setSize(width,height),{width,height});
 await expect.poll(()=>page.evaluate(()=>innerWidth)).toBe(width);
}
async function measure(label,locator){
 const value=await locator.evaluate(node=>{
  const rect=node.getBoundingClientRect();
  return {clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,scrollTop:node.scrollTop,top:rect.top,bottom:rect.bottom,viewportHeight:innerHeight,
   ancestors:[...function*(entry){for(let current=entry.parentElement;current;current=current.parentElement)yield current;}(node)].map(current=>({className:current.className,height:current.clientHeight,scrollHeight:current.scrollHeight,scrollTop:current.scrollTop,overflow:getComputedStyle(current).overflowY}))};
 });
 measurements.push({label,...value});return value;
}
async function wheelToEnd(locator,label){
 const before=await measure(label+' before',locator);
 assert.ok(before.clientHeight>40,label+' has usable height');
 assert.ok(before.bottom<=before.viewportHeight+1,label+' stays inside window');
 assert.ok(before.scrollHeight>before.clientHeight,label+' has overflowing fixture content');
 const bounds=await locator.boundingBox();await page.mouse.move(bounds.x+Math.min(80,bounds.width/2),bounds.y+Math.min(80,bounds.height/2));
 await page.mouse.wheel(0,100000);
 await expect.poll(()=>locator.evaluate(node=>node.scrollTop+node.clientHeight>=node.scrollHeight-2)).toBe(true);
 const after=await measure(label+' after',locator);
 assert.ok(after.scrollTop>before.scrollTop,label+' responds to wheel');
 for(let index=0;index<before.ancestors.length;index++)assert.equal(after.ancestors[index].scrollTop,before.ancestors[index].scrollTop,label+' keeps ancestor scroll positions');
 return after;
}
async function screenshot(name){await page.screenshot({path:path.join(output,name+'.png'),scale:'css'});}
async function enclosingScroller(locator){
 const handle=await locator.evaluateHandle(node=>{for(let current=node;current;current=current.parentElement)if(/auto|scroll/.test(getComputedStyle(current).overflowY)&&current.scrollHeight>current.clientHeight+1)return current;return null});
 assert.ok(handle.asElement(),'fixture exposes a real scrolling ancestor');return handle.asElement();
}
async function launch(){
 const env={...process.env,...isolatedModelRuntime({home,dataPath}),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_CODEX_SSH_CONFIG:config,REVIEWOPS_SSH_CONFIG:config};
 for(const name of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
 app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(10000);await setTestLocale(page);
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url())});
 await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
 await app.evaluate(({ipcMain,BrowserWindow})=>{
  const hosts=Array.from({length:65},(_,index)=>({id:'scroll-host-'+index,alias:'검사 호스트 '+String(index+1).padStart(3,'0'),hostName:'fixture.invalid',user:'fixture',port:22,connectable:true,connection:{status:'ready'},codex:{available:true,version:'synthetic'}}));
  const state={configPath:'/fixture/config',revision:'fixture',groups:[],hosts,refresh:{running:false},batchUpgrade:{running:false,hostIds:[]}};
  const transfers=Array.from({length:45},(_,index)=>({id:'fixture-transfer-'+index,hostId:hosts[0].id,direction:'download',status:'completed',currentFile:'/fixtures/전송-'+String(index+1).padStart(3,'0')+'.md',totalBytes:1024,completedBytes:1024}));
  const f=globalThis.scrollFixture={state,transfers,listingCalls:[],fileCalls:[]};
  const handler=(name,fn)=>{ipcMain.removeHandler('hosts:'+name);ipcMain.handle('hosts:'+name,fn)};
  for(const name of ['getState','reloadHosts','refreshHosts'])handler(name,()=>state);
  handler('getFileTransfers',()=>transfers);
  handler('listFiles',(_event,hostId,input='')=>{
   const folder=input||'/fixtures';f.listingCalls.push({hostId,path:folder});
   const root=folder==='/fixtures';
   const entries=[...(root?Array.from({length:40},(_,index)=>({name:'folder-'+String(index+1).padStart(3,'0'),type:'directory'})):[]),...Array.from({length:160},(_,index)=>({name:(root?'file-':'nested-')+String(index+1).padStart(3,'0')+'.md',type:'file',size:1024}))].map(item=>({...item,path:folder+'/'+item.name,modifiedAt:'2026-01-01T00:00:00Z'}));
   return {path:folder,home:'/fixtures',entries};
  });
  handler('readTextFile',(_event,hostId,file)=>{f.fileCalls.push({hostId,path:file});return {hostId,path:file,name:file.split('/').at(-1),size:24000,content:'# 긴 문서 검사\n\n'+Array.from({length:200},(_,index)=>'## 검사 문단 '+(index+1)+'\n\n스크롤로 읽을 검사 전용 본문입니다.\n\n').join('')+'문서 마지막 줄'};});
  // Fixtures replace remote responses only. The normal component, layout,
  // input handlers and Electron window remain in use; no SSH target is contacted.
  const accounts={accounts:Array.from({length:60},(_,index)=>({id:'account-'+index,label:'검사 계정 '+String(index+1).padStart(3,'0'),email:'fixture@example.test',status:'ready',usage:{}})),runtime:{available:true},refresh:{running:false}};
  ipcMain.removeHandler('accounts:getState');ipcMain.handle('accounts:getState',()=>accounts);
  BrowserWindow.getAllWindows()[0].setSize(1280,800);
 });
}

try{
 await launch();
 await page.locator('.main-nav').getByRole('button',{name:'호스트관리',exact:true}).click();
 await page.getByRole('button',{name:'검사 호스트 001 파일 관리',exact:true}).click();
 await expect(page.getByRole('table',{name:'원격 파일 목록',exact:true})).toBeVisible();await expect(row('file-160.md')).toHaveCount(1);
 const baseline=await measure('initial file list',files());console.log('INITIAL: '+JSON.stringify(baseline));await screenshot(process.env.REVIEWOPS_SCROLL_BASELINE?'baseline-before':'initial-list');
 const initialBounds=await files().boundingBox();await page.mouse.move(initialBounds.x+80,initialBounds.y+80);await page.mouse.wheel(0,36);await expect.poll(()=>files().evaluate(node=>node.scrollTop)).toBeGreaterThan(0);await page.mouse.wheel(0,52);await expect.poll(()=>files().evaluate(node=>node.scrollTop)).toBeGreaterThan(36);pass('작은 wheel 델타 입력으로 파일 목록 내부 이동');
 await wheelToEnd(files(),'long file list');await row('file-160.md').click();await expect(row('file-160.md').locator('..').locator('..')).toHaveClass(/selected/);await screenshot('last-file-selected');
 pass('긴 파일 목록을 마우스 휠로 끝까지 이동하고 마지막 파일 선택');
 const outerScroll=await page.locator('.codex-management-page').evaluate(node=>node.scrollTop);assert.equal(outerScroll,0);
 await page.getByRole('button',{name:'파일 옵션',exact:true}).click();await page.getByRole('menuitemcheckbox',{name:'파일 정보 표시',exact:true}).click();
 await expect(page.getByRole('complementary',{name:'파일 정보',exact:true})).toBeVisible();await page.getByRole('button',{name:'파일 새로고침',exact:true}).click();await expect(row('file-160.md')).toBeEnabled();await files().evaluate(node=>{node.scrollTop=0});await wheelToEnd(files(),'list with inspector');
 await screenshot('inspector-last-file');pass('파일 정보와 전송 내역을 표시한 뒤에도 목록 새로고침과 마지막 파일 선택 유지');
 const sidebar=page.getByRole('complementary',{name:'파일 정보',exact:true});await wheelToEnd(sidebar,'file inspector');
 const transfers=page.locator('.host-files-transfers ul');await wheelToEnd(transfers,'transfer history');await expect(transfers.locator('li').last()).toContainText('전송-001.md');await screenshot('transfer-history-end');pass('파일 정보와 긴 전송 내역의 마지막 항목 접근');
 for(const [width,height]of [[800,600],[1600,1000],[1280,800]]){
  await resize(width,height);await files().evaluate(node=>{node.scrollTop=0});await wheelToEnd(files(),`file list ${width}x${height}`);await row('file-160.md').click();
  const header=await page.getByRole('toolbar',{name:'파일 관리 도구',exact:true}).boundingBox();assert.ok(header.y>=0&&header.y+header.height<=height);await screenshot(`resized-${width}x${height}`);
 }
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].maximize());await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
 await files().evaluate(node=>{node.scrollTop=0});await wheelToEnd(files(),'maximized file list');await screenshot('maximized-list');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].unmaximize());await resize(1280,800);
 pass('800×600 축소와 1600×1000 확장 후 파일 목록·고정 도구 접근');
 await page.getByRole('button',{name:'파일 검색',exact:true}).click();await page.getByRole('searchbox',{name:'파일 이름 검색',exact:true}).fill('file-1');await expect(page.locator('.host-files-table tbody tr')).toHaveCount(61);await files().evaluate(node=>{node.scrollTop=0});await wheelToEnd(files(),'search results');await row('file-160.md').click();await screenshot('search-results-end');await page.getByRole('button',{name:'검색 닫기',exact:true}).click();pass('검색 후 마지막 검색 결과까지 스크롤하고 선택');
 await page.getByRole('button',{name:'이동',exact:true}).click();const picker=page.locator('.host-files-picker-folders');await wheelToEnd(picker,'destination folders');await page.getByRole('button',{name:'folder-040 이동 폴더 열기',exact:true}).click();await expect(page.locator('.host-files-picker-target')).toContainText('folder-040');await screenshot('destination-last-folder');await page.getByRole('button',{name:'취소',exact:true}).click();pass('이동할 폴더 목록의 마지막 폴더 선택 및 취소');
 await page.getByRole('button',{name:'파일 정보 닫기',exact:true}).click();await files().evaluate(node=>{node.scrollTop=0});await page.getByRole('button',{name:'folder-001 폴더 열기',exact:true}).click();await expect(row('nested-160.md')).toHaveCount(1);await wheelToEnd(files(),'nested folder');await row('nested-160.md').dblclick();await expect(page.locator('.markdown-viewer')).toContainText('문서 마지막 줄');await wheelToEnd(page.locator('.markdown-viewer-scroll'),'long document');await screenshot('document-end');await page.getByRole('button',{name:'파일 목록',exact:true}).click();await expect(row('nested-160.md')).toHaveCount(1);await page.getByRole('button',{name:'이전 폴더',exact:true}).click();await expect(row('file-160.md')).toHaveCount(1);await files().evaluate(node=>{node.scrollTop=0});await wheelToEnd(files(),'returned folder');pass('폴더 이동·긴 문서 미리보기·이전 폴더 복귀 후 스크롤 유지');
 await page.getByRole('button',{name:'호스트 목록으로 돌아가기',exact:true}).click();await wheelToEnd(page.locator('.codex-management-page'),'host management');await page.getByRole('button',{name:'검사 호스트 065 파일 관리',exact:true}).click();await expect(files()).toBeVisible();await screenshot('host-list-last-opened');pass('긴 호스트 목록 마지막 호스트의 파일 관리 접근');
 await page.locator('.main-nav').getByRole('button',{name:'계정관리',exact:true}).click();await expect(page.getByRole('button',{name:'검사 계정 060 상세 통계',exact:true})).toHaveCount(1);await wheelToEnd(page.locator('.workspace-pane:not([hidden]) .codex-management-page'),'account management');await expect(page.getByRole('button',{name:'검사 계정 060 상세 통계',exact:true})).toBeInViewport();await screenshot('account-list-end');pass('긴 계정 목록 마지막 계정 작업 접근');
 // Prepare disposable records through the public IPC; no live model or host runs.
 await resize(800,600);
 const group=await ipc('group.save',{name:'스크롤 그룹 001',description:'긴 목록 검사'});
 for(let index=2;index<=25;index++)await ipc('group.save',{name:'스크롤 그룹 '+String(index).padStart(3,'0'),description:'긴 그룹 목록의 마지막 항목 접근 검사'});
 const service=await ipc('service.save',{groupId:group.id,name:'스크롤 검사 연결',kind:'local',rootPath:temporary,agentEnabled:true});
 const project=await ipc('project.save',{groupId:group.id,name:'스크롤 프로젝트 001',serviceIds:[service.id]});
 for(let index=2;index<=25;index++)await ipc('project.save',{groupId:group.id,name:'스크롤 프로젝트 '+String(index).padStart(3,'0'),serviceIds:[service.id]});
 const review=await ipc('review.save',{projectId:project.id,title:'긴 작업이력과 대화',body:'긴 리뷰 본문\n\n'+('본문 스크롤 검사용 문단입니다.\n\n'.repeat(30))});
 for(let index=1;index<=40;index++)await ipc('review.save',{projectId:project.id,title:'스크롤 리뷰 '+String(index).padStart(3,'0'),body:'목록 검사'});
 for(let index=1;index<=40;index++)await ipc('activity.add',{reviewId:review.id,body:'작업이력 '+String(index).padStart(3,'0')+'\n\n'+('검사 기록입니다.\n\n'.repeat(3))});
 for(let index=1;index<=20;index++)await ipc('agent.request.add',{reviewId:review.id,requestId:'scroll-followup-'+index,prompt:'검사 후속 요청 '+String(index).padStart(3,'0'),requiredResult:'검사자가 결과를 준비해야 함'});
 const store=createStore({dbPath:path.join(dataPath,'reviewops.sqlite')});try{for(let index=1;index<=10;index++)store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'completed',workPath:temporary,prompt:'검사 요청 '+index,response:'시험용 응답 '+index+'\n\n'+('실제 모델 호출 없이 저장한 대화 검사 문단입니다.\n\n'.repeat(15))})}finally{store.close()}
 await page.locator('.workspace-refresh').click();await page.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();await wheelToEnd(pane().locator('.work-home-tree-scroll'),'home explorer');await screenshot('home-tree-end');
 await pane().locator(`[data-tree-node="r-${review.id}"]`).click();const history=pane().locator('.original-review-history-scroll');await history.evaluate(node=>{node.scrollTop=0});await wheelToEnd(history,'review history');const sendBounds=await pane().getByRole('button',{name:'작업이력 보내기',exact:true}).boundingBox();assert.ok(sendBounds.y+sendBounds.height<=600,'history send control remains fully inside small window');await screenshot('review-history-end');pass('홈 탐색과 긴 리뷰 본문·작업이력 끝까지 접근');
 await page.locator('.main-nav').getByRole('button',{name:'그룹',exact:true}).click();const groups=await enclosingScroller(page.getByRole('region',{name:'그룹 목록',exact:true}));await groups.evaluate(node=>{node.scrollTop=0});await wheelToEnd(groups,'group catalog');await screenshot('group-list-end');await page.getByRole('button',{name:'그룹 열기: '+group.name,exact:true}).click();
 const projects=await enclosingScroller(pane().locator('.group-resource-list'));await projects.evaluate(node=>{node.scrollTop=0});await wheelToEnd(projects,'project catalog');await screenshot('project-list-end');await pane().getByRole('button',{name:project.name+' 열기',exact:true}).click();
 const reviewList=await enclosingScroller(pane().locator('.original-review-table tbody tr').first());await reviewList.evaluate(node=>{node.scrollTop=0});await wheelToEnd(reviewList,'project review list');await screenshot('project-reviews-end');pass('긴 그룹·프로젝트·프로젝트 리뷰 목록에서 하단 항목 접근');
 await pane().locator('.original-review-table tbody tr').filter({hasText:review.title}).click();await pane().getByRole('tab',{name:'에이전트',exact:true}).click();const conversation=pane().locator('.agent-conversation');await expect(conversation.locator('.agent-turn')).toHaveCount(10);await conversation.evaluate(node=>{node.scrollTop=0});await wheelToEnd(conversation,'agent conversation');await screenshot('agent-conversation-end');
 await pane().locator('.agent-followups > summary').click();await expect(pane().locator('.agent-followup-area')).toHaveClass(/is-open/);const followups=pane().locator('.agent-followups-body');await wheelToEnd(followups,'follow-up request list');await followups.locator('.agent-followup-prompt').last().scrollIntoViewIfNeeded();await expect(followups.locator('.agent-followup-prompt').last()).toContainText('검사 후속 요청 020');await screenshot('followups-end');await pane().locator('.agent-followups > summary').click();await expect(followups).toBeHidden();await pane().locator('.agent-followups > summary').click();await expect(pane().locator('.agent-followup-area')).toHaveClass(/is-open/);await expect(followups).toBeVisible();pass('긴 에이전트 대화와 후속 요청 목록 끝까지 접근');
 await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();await pane().locator('.settings-section-menu').getByRole('button',{name:'자료 관리',exact:true}).click();const settings=await enclosingScroller(pane().getByRole('button',{name:'백업 파일 열기',exact:true}));await settings.evaluate(node=>{node.scrollTop=0});await wheelToEnd(settings,'data settings');await expect(pane().getByRole('button',{name:'백업 파일 열기',exact:true})).toBeInViewport();await screenshot('settings-bottom');pass('작은 창에서 긴 설정 하단의 백업 복원 버튼 접근');
 const fixture=await app.evaluate(()=>({listingCalls:globalThis.scrollFixture.listingCalls,fileCalls:globalThis.scrollFixture.fileCalls}));
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);assert.ok(fixture.listingCalls.every(call=>call.hostId.startsWith('scroll-host-')));
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:true,checks,measurements,fixture,rendererErrors:errors,externalRequests:requests,realSshConnections:0,temporary},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length,output}));
}catch(error){
 await screenshot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:false,checks,measurements,rendererErrors:errors,externalRequests:requests,error:String(error),temporary},null,2));throw error;
}finally{await app?.close().catch(()=>{})}
