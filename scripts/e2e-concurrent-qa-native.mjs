// Preparation only. Ten mandatory synthetic scenarios retained; native source/installed input packet required.
import {setTestLocale} from './test-locale.mjs';
import {selectControl,expectSelectValue} from './select-control.mjs';
import {regressionContext,launchRegression,finishRegression,until,bounded,selectProjectHost} from './native-regression-contract.mjs';
import {trustedHostURL} from './native-adapters.mjs';
import {verifyNativePacket} from './native-packet.mjs';
import {_electron as electron, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';

// Prepared native derivative. No real AI/client optional branch runs in this gate.
const context=await regressionContext('concurrent10'),{root,paths,fixture:fixtureReceipt,packet}=context;
const temporary=paths.root,dataPath=paths.data,home=paths.home,resultDir=packet.outputDir,executable=context.launch.executablePath;
const env=context.env,connection=path.join(dataPath,'integrations/tools.json'),mcpScript=path.join(root,'electron/mcp-server.cjs');
const finish=path.join(temporary,'finish'),fixture=fixtureReceipt.agentExecutable;
const server=http.createServer((request,response)=>{
 const project=new URL(request.url,'http://qa.invalid').pathname.slice(1)||'unknown';
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
 const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>동시 QA ${project}</title><style>body{font:20px system-ui;margin:28px;min-height:2600px;background:${project.startsWith('A')?'#eff6ff':'#fff7ed'}}input,button{font:inherit;padding:10px}input{display:block;width:80%;margin:20px 0}.tail{margin-top:1500px}</style></head><body><h1>프로젝트 ${project}</h1><label for="draft">QA 입력 ${project}</label><input id="draft" aria-label="QA 입력 ${project}"><button id="counter" onclick="document.querySelector('#count').textContent=++window.hits">클릭 ${project}</button><p>클릭 횟수: <span id="count">0</span></p><p>이 화면의 입력과 스크롤은 프로젝트 ${project}에만 적용됩니다.</p><a target="_blank" href="/${project}-popup">새 검사 화면</a><div class="tail">프로젝트 ${project} 스크롤 결과</div><script>window.hits=0;window.instance=crypto.randomUUID()</script></body></html>`;
 if(project.endsWith('-slow'))setTimeout(()=>response.end(html),1600);else response.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const checks=[],errors=[],calls=[],clients=[],live=[];
const report=context.report;Object.assign(report,{app:{executable,packaged:context.mode!=='source'},checks,errors,calls,live,temporary,limits:['Synthetic MCP clients and local native fixture only; optional live Claude/Codex branches are preserved in original source but disabled by this packet contract.']});
let app,main,owner,session;const ownedJobIds=[];
const passed=(name,details={})=>{checks.push({name,status:'pass',...details});console.log('PASS: '+name)};
const ipc=(page,action,payload={})=>session.ipc(page,action,payload);
const pane=page=>page.locator('.workspace-pane:not([hidden])');
const pages=()=>app.windows().filter(page=>!page.isClosed()&&page.url().startsWith('reviewops://app/'));
const projectPage=async(id,windowId)=>{const selected=await selectProjectHost(app,{projectId:id,windowId},until,ipc,bounded);await expect(selected.page.locator('.workspace-app')).toHaveAttribute('data-window-project-id',id);return selected.page;};

class McpClient {
 constructor(projectId,label){
  this.label=label;this.projectId=projectId;this.next=0;this.pending=new Map();this.stderr='';this.buffer='';
  this.child=spawn(process.execPath,[mcpScript,'--connection',connection,...(projectId?['--project-id',projectId]:[])],{env,stdio:['pipe','pipe','pipe']});
  this.child.stderr.on('data',chunk=>this.stderr+=chunk);
  this.child.stdout.on('data',chunk=>{
   this.buffer+=chunk;let end;
   while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(!line.trim())continue;
    let value;try{value=JSON.parse(line)}catch{this.abort(new Error('MCP stdout contains non-JSON output'));continue}
    const pending=this.pending.get(value.id);if(pending){this.pending.delete(value.id);clearTimeout(pending.timer);value.error?pending.reject(new Error(JSON.stringify(value.error))):pending.resolve(value.result)}
   }
  });
  this.child.once('error',error=>this.abort(error));this.child.stdin.on('error',error=>this.abort(error));
  this.closed=new Promise(resolve=>{this.child.once('close',(code,signal)=>{this.exit={code,signal};this.abort(new Error(`MCP closed: ${code}; ${this.stderr}`));resolve({code,signal});});});
  clients.push(this);
 }
 abort(error){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error)}this.pending.clear()}
 request(method,params){return new Promise((resolve,reject)=>{
  const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('MCP response timeout: '+method))},45000);
  this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 })}
 async initialize(){const result=await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:this.label,version:'1'}});assert.ok(result.serverInfo);this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return result}
 async raw(name,args){return this.request('tools/call',{name:'reviewops_'+name,arguments:args})}
 async call(name,args={}){
  const started=Date.now(),result=await this.raw(name,args);const item={client:this.label,tool:name,projectId:args.projectId,windowId:args.windowId,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),ok:!result.isError};calls.push(item);
  if(result.isError)throw new Error(`${name}: ${result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')}`);
  const text=result.content?.find(item=>item.type==='text')?.text;
  let data=result.structuredContent;if(data===undefined&&text){try{data=JSON.parse(text)}catch{data={text}}}
  const image=result.content?.find(item=>item.type==='image');if(image)data={...data,data:image.data,mimeType:image.mimeType};
  return data;
 }
 async close(){if(!this.child.stdin.destroyed&&!this.child.stdin.writableEnded)this.child.stdin.end();const ended=await this.closed;assert.equal(ended.code,0);assert.equal(ended.signal,null);return ended;}
}
const center=element=>{assert.ok(element?.rect,'Target element is missing');return {x:Math.round(element.rect.x+element.rect.width/2),y:Math.round(element.rect.y+element.rect.height/2)}};
const binding=session=>({sessionId:session.sessionId,projectId:session.projectId,windowId:session.windowId});
const saveCapture=async(client,target,name)=>{
 const capture=await client.call('qa_capture',target);const bytes=Buffer.from(capture.data||capture.dataUrl?.split(',')[1]||'','base64');
 assert.ok(bytes.length>3000);assert.equal(bytes.subarray(1,4).toString(),'PNG');fs.writeFileSync(path.join(resultDir,name+'.png'),bytes);
 return {name:name+'.png',width:capture.width,height:capture.height,bytes:bytes.length};
};
const snapshot=async target=>{
 const url=new URL(target),name=url.pathname.startsWith('/A')?'A':url.pathname.startsWith('/B')?'B':null;assert.ok(name,'Only an own synthetic URL is observed');
 const binding=report.projects[name],page=(await selectProjectHost(app,{projectId:binding.projectId,windowId:binding.windowId},until,ipc,bounded)).page;
 const host=await bounded(app.browserWindow(page),'snapshot exact host'),hostId=await bounded(host.evaluate(win=>win.id),'snapshot exact host ID');
 return bounded(app.evaluate(({BrowserWindow},{url,hostId})=>{
  const candidates=new Map(),owned=window=>{let cursor=window;while(cursor){if(cursor.id===hostId)return true;cursor=cursor.getParentWindow();}return false;};
  const visit=view=>{if(view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL()===url)candidates.set(view.webContents.id,view.webContents);for(const child of view.children||[])visit(child);};
  for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed()&&win.isVisible()&&owned(win)){if(!win.webContents.isDestroyed()&&win.webContents.getURL()===url)candidates.set(win.webContents.id,win.webContents);visit(win.contentView);}
  if(candidates.size!==1)throw new Error('Expected one exact own source for this retained project/window');
  return [...candidates.values()][0].executeJavaScript('({draft:document.querySelector("#draft").value,hits:window.hits,scrollY,instance:window.instance,activeElement:document.activeElement?.id,hasFocus:document.hasFocus()})');
 },{url:new URL(target).href,hostId}),'exact own QA source snapshot');
};

const focused=()=>bounded(app.evaluate(({BrowserWindow})=>BrowserWindow.getFocusedWindow()?.id??null),'own app focus observation');

// Observe only this retained project's existing source. These are future run
// receipts: the proposal does not supply runtime geometry or manager internals.
const scrollSurfaceObservation=async(page,target,url)=>{
 const windowContext=await ipc(page,'window.context');
 assert.equal(windowContext.projectId,target.projectId);assert.equal(windowContext.windowId,target.windowId);
 const host=await bounded(app.browserWindow(page),'scroll fixture exact host'),hostId=await bounded(host.evaluate(win=>win.id),'scroll fixture host ID');
 const renderer=await bounded(pane(page).locator('.original-viewport').evaluate(element=>{
  const transform=getComputedStyle(element).transform,matrix=new DOMMatrixReadOnly(transform==='none'?undefined:transform),viewer=element.closest('.original-viewer'),surface=element.querySelector('.native-browser-surface'),rect=surface.getBoundingClientRect();
  return {transform,renderedScaleX:matrix.a,renderedScaleY:matrix.d,skewX:matrix.c,skewY:matrix.b,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},browserId:surface.dataset.browserId,selectedScale:viewer.querySelector('[role="combobox"][aria-label="뷰포트 배율"]')?.dataset.value};
 }),'scroll fixture rendered viewport');
 assert.equal(renderer.browserId,target.browserId);
 const native=await bounded(app.evaluate(async({BrowserWindow},{hostId,url})=>{
  const host=BrowserWindow.fromId(hostId);if(!host||host.isDestroyed())throw new Error('Retained scroll fixture host missing');
  const candidates=new Map(),owned=win=>{for(let cursor=win;cursor;cursor=cursor.getParentWindow())if(cursor.id===hostId)return true;return false;};
  const visit=(view,win)=>{if(view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL()===url)candidates.set(view.webContents.id,{contents:view.webContents,view,win});for(const child of view.children||[])visit(child,win);};
  for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed()&&win.isVisible()&&owned(win))visit(win.contentView,win);
  if(candidates.size!==1)throw new Error('Expected one exact own native scroll fixture');
  const {contents,view,win}=[...candidates.values()][0],clip=win.getContentBounds(),viewBounds=view.getBounds();
  const dom=await contents.executeJavaScript('({instance:window.instance,draft:document.querySelector("#draft").value,hits:window.hits,scrollY,innerWidth,innerHeight,scrollHeight:document.scrollingElement.scrollHeight,clientHeight:document.scrollingElement.clientHeight,activeElement:document.activeElement?.id,hasFocus:document.hasFocus()})');
  return {webContentsId:contents.id,url:contents.getURL(),hostId,hostZoom:host.webContents.getZoomFactor(),clipWindowId:win.id,clipVisible:win.isVisible(),clip:{width:clip.width,height:clip.height},viewBounds,dom};
 },{hostId,url}),'scroll fixture exact native metrics');
 const derivedInputScale=renderer.renderedScaleX*native.hostZoom;
 return {windowContext,binding:{...target},renderer,native,derivedInputScale,derivedInputScaleSource:'Observed renderer DOMMatrix scale X multiplied by exact host zoom; same emulationFor formula, not a read of private manager.inputScale',remainingScrollRange:native.dom.scrollHeight-native.dom.clientHeight-native.dom.scrollY};
};
const assertScrollIdentity=(before,after)=>{
 assert.deepEqual(after.binding,before.binding);assert.equal(after.windowContext.projectId,before.windowContext.projectId);assert.equal(after.windowContext.windowId,before.windowContext.windowId);
 for(const field of ['webContentsId','url','hostId','clipWindowId'])assert.equal(after.native[field],before.native[field],field);
 for(const field of ['instance','draft','hits','innerWidth','innerHeight'])assert.equal(after.native.dom[field],before.native.dom[field],field);
 assert.equal(after.renderer.browserId,before.renderer.browserId);
};
const nativeLayoutMatches=observation=>{
 const {bounds}=observation.renderer,{viewBounds,hostZoom}=observation.native;
 return [bounds.width,bounds.height,hostZoom,viewBounds.width,viewBounds.height].every(value=>Number.isFinite(value)&&value>0)&&viewBounds.width===Math.round(bounds.width*hostZoom)&&viewBounds.height===Math.round(bounds.height*hostZoom);
};
const assertScrollReady=(observation,deltaY)=>{
 assert.ok(nativeLayoutMatches(observation),'Native bounds must match the new rendered scale before MCP awaits its emulation readiness');
 assert.equal(observation.renderer.selectedScale,'100');assert.equal(observation.renderer.renderedScaleX,1);assert.equal(observation.renderer.renderedScaleY,1);assert.equal(observation.renderer.skewX,0);assert.equal(observation.renderer.skewY,0);assert.equal(observation.derivedInputScale,1);
 assert.equal(observation.native.clipVisible,true);assert.ok(observation.remainingScrollRange>deltaY,'Fixture must have enough measured remaining native scroll range');
 // qa_scroll converts CSS x/y using inputScale. Check the unchanged (100,200)
 // point against the actual native view offset inside its visible OS clip.
 const x=observation.native.viewBounds.x+100*observation.derivedInputScale,y=observation.native.viewBounds.y+200*observation.derivedInputScale;
 assert.ok(x>0&&x<observation.native.clip.width&&y>0&&y<observation.native.clip.height,'Unchanged MCP wheel point must lie inside actual native clip');
};

try{
 session=await launchRegression(context);({app,owner,main}=session);app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));main.on('pageerror',error=>errors.push(error.message));
 await setTestLocale(main);await ipc(main,'update.configure',{automatic:false});
 report.app={...report.app,...await ipc(main,'app.info')};delete report.app.dataPath;
 await expect.poll(()=>fs.existsSync(connection)).toBe(true);
 const group=await ipc(main,'group.save',{name:'동시 QA 검사'}),projects={},reviews={};
 for(const name of ['A','B']){
  const work=path.join(temporary,name);fs.mkdirSync(work);
  projects[name]=await ipc(main,'project.save',{groupId:group.id,name:'동시 QA 프로젝트 '+name,connection:{kind:'local',rootPath:work,viewerUrl:origin+'/'+name,agentEnabled:true,agentBinary:fixture,agentModel:'fixture-model'}});
 }
 const admin=new McpClient(null,'qa-admin'),a=new McpClient(projects.A.id,'qa-A'),b=new McpClient(projects.B.id,'qa-B');
 await Promise.all([admin.initialize(),a.initialize(),b.initialize()]);
 const tools=await admin.request('tools/list',{});assert.ok(tools.tools.some(item=>item.name==='reviewops_qa_open'));
 const listed=await a.call('projects_list');assert.equal(JSON.stringify(listed).includes(projects.B.id),false);
 const rejected=await a.raw('reviews_list',{projectId:projects.B.id});assert.equal(rejected.isError,true);
 passed('MCP 연결과 도구 목록, 연결한 프로젝트 밖의 요청 거부');
 for(const [name,client]of [['A',a],['B',b]]){
  const created=await client.call('review_create',{projectId:projects[name].id,requestId:'qa-create-'+name,title:'MCP 리뷰 '+name,body:'MCP 입력 '+name});
  reviews[name]=created.review||created;assert.ok(reviews[name].id||created.reviewId);if(!reviews[name].id)reviews[name].id=created.reviewId;
 }
 const [openedA,openedB]=await Promise.all([
  a.call('qa_open',{projectId:projects.A.id,reviewId:reviews.A.id,clientId:'qa-A'}),
  b.call('qa_open',{projectId:projects.B.id,reviewId:reviews.B.id,clientId:'qa-B'})
 ]);
 const targetA=binding(openedA),targetB=binding(openedB);assert.notEqual(targetA.windowId,targetB.windowId);
 const pageA=await projectPage(projects.A.id,targetA.windowId),pageB=await projectPage(projects.B.id,targetB.windowId);
 await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows())if(win.webContents.getURL().startsWith('reviewops://app/'))win.setContentSize(1500,950)});
 assert.equal(pages().length,3);report.projects={A:{projectId:projects.A.id,reviewId:reviews.A.id,windowId:targetA.windowId},B:{projectId:projects.B.id,reviewId:reviews.B.id,windowId:targetB.windowId}};
 passed('프로젝트별 창 동시 생성과 프로젝트·리뷰·창 연결',report.projects);
 const busy=await b.raw('qa_open',{projectId:projects.B.id,clientId:'different-client'});assert.equal(busy.isError,true);
 const foreign=await admin.raw('qa_state',{...targetA,windowId:targetB.windowId});assert.equal(foreign.isError,true);
 passed('다른 조작자의 창 연결과 잘못 조합한 창 ID 거부');
 async function browserTarget(client,target,url){
  let state;await expect.poll(async()=>{state=await client.call('qa_state',target);return state.browsers?.some(item=>item.url===url&&item.visible)}).toBe(true);
  return {...target,browserId:state.browsers.find(item=>item.url===url&&item.visible).browserId};
 }
 const browserA=await browserTarget(a,targetA,origin+'/A'),browserB=await browserTarget(b,targetB,origin+'/B');
 const initialB=await snapshot(origin+'/B');
 async function inputRound(client,target,value){
  const state=await client.call('qa_state',target);const input=state.elements.find(item=>item.tag?.toLowerCase()==='input'&&item.type!=='hidden');
  await client.call('qa_click',{...target,...center(input)});await client.call('qa_key',{...target,key:'a',modifiers:[process.platform==='darwin'?'Meta':'Control']});await client.call('qa_type',{...target,text:value});
  const after=await client.call('qa_state',target),button=after.elements.find(item=>item.tag?.toLowerCase()==='button'&&item.text?.includes('클릭'));
  await client.call('qa_click',{...target,...center(button)});
 }
 const sentinel=main.getByLabel('리뷰 제목·분류 검색',{exact:true});await sentinel.fill('MAIN_INPUT_UNCHANGED');
 const mainInput=()=>main.evaluate(()=>({label:document.activeElement?.getAttribute('aria-label'),value:document.activeElement?.value}));
 const expectedMainInput=await mainInput();assert.equal(expectedMainInput.value,'MAIN_INPUT_UNCHANGED');
 await app.evaluate(({BrowserWindow})=>{globalThis.qaFocusEvents=[];for(const window of BrowserWindow.getAllWindows())for(const event of ['focus','blur'])window.on(event,()=>globalThis.qaFocusEvents.push({id:window.id,event,url:window.webContents.isDestroyed()?'closed':window.webContents.getURL()}))});
 const focusBefore=await focused(),overlapStarted=Date.now();
 await Promise.all([inputRound(a,browserA,'PROJECT_A_ONLY'),inputRound(b,browserB,'PROJECT_B_ONLY')]);
 const [valueA,valueB]=await Promise.all([snapshot(origin+'/A'),snapshot(origin+'/B')]);
 report.initialInput={valueA,valueB};
 report.focus={before:focusBefore,after:await focused(),events:await app.evaluate(()=>globalThis.qaFocusEvents)};
 assert.equal(valueA.draft,'PROJECT_A_ONLY');assert.equal(valueB.draft,'PROJECT_B_ONLY');assert.equal(valueA.hits,1);assert.equal(valueB.hits,1);assert.ok(!report.focus.events.some(event=>event.event==='focus'),'QA must not focus a native window');assert.deepEqual(await mainInput(),expectedMainInput);
 const overlapCalls=calls.filter(item=>Date.parse(item.startedAt)>=overlapStarted);assert.ok(overlapCalls.some(x=>overlapCalls.some(y=>x.client!==y.client&&Date.parse(x.startedAt)<Date.parse(y.finishedAt)&&Date.parse(y.startedAt)<Date.parse(x.finishedAt))));
 report.screenshots=await Promise.all([saveCapture(a,targetA,'01-project-A-input'),saveCapture(b,targetB,'02-project-B-input'),saveCapture(a,browserA,'03-browser-A-input'),saveCapture(b,browserB,'04-browser-B-input')]);
 passed('두 MCP 클라이언트의 동시 클릭·입력, 홈 입력 대상 유지, 다른 창 표시 없음');
 // Keep the preceding four original input/capture checks at their original fit
 // scale. Change only this fixture's visible UI before the unchanged wheel calls.
 const scrollFixture=report.scrollFixture={method:'visible viewer scale UI 100%; original MCP wheel requests retained',phase:'before-ui-scale'};
 const observeBoth=async()=>({A:await scrollSurfaceObservation(pageA,browserA,origin+'/A'),B:await scrollSurfaceObservation(pageB,browserB,origin+'/B')});
 scrollFixture.before=await observeBoth();scrollFixture.uiFocusBefore=await focused();
 const uiFocusStart=await app.evaluate(()=>globalThis.qaFocusEvents.length);
 for(const page of [pageA,pageB]){const control=pane(page).getByRole('combobox',{name:'뷰포트 배율',exact:true});await selectControl(control,'100');await expectSelectValue(control,'100');}
 await expect.poll(async()=>{scrollFixture.afterUI=await observeBoth();return ['A','B'].every(name=>{const value=scrollFixture.afterUI[name];return value.renderer.selectedScale==='100'&&value.renderer.renderedScaleX===1&&value.renderer.renderedScaleY===1&&value.derivedInputScale===1&&value.native.clipVisible&&nativeLayoutMatches(value);});}).toBe(true);
 scrollFixture.uiFocusAfter=await focused();scrollFixture.uiFocusEvents=(await app.evaluate(()=>globalThis.qaFocusEvents)).slice(uiFocusStart);
 for(const name of ['A','B']){assertScrollIdentity(scrollFixture.before[name],scrollFixture.afterUI[name]);assert.equal(scrollFixture.afterUI[name].native.dom.scrollY,scrollFixture.before[name].native.dom.scrollY);}
 assert.deepEqual(await mainInput(),expectedMainInput);
 scrollFixture.beforeScroll=await observeBoth();assertScrollReady(scrollFixture.beforeScroll.A,620);assertScrollReady(scrollFixture.beforeScroll.B,340);
 for(const name of ['A','B'])assertScrollIdentity(scrollFixture.afterUI[name],scrollFixture.beforeScroll[name]);
 const scrollFocusStart=await app.evaluate(()=>globalThis.qaFocusEvents.length);scrollFixture.scrollFocusBefore=await focused();scrollFixture.phase='single-mcp-wheel';
 await Promise.all([a.call('qa_scroll',{...browserA,x:100,y:200,deltaY:620}),b.call('qa_scroll',{...browserB,x:100,y:200,deltaY:340})]);
 await expect.poll(async()=>(await snapshot(origin+'/A')).scrollY).toBeGreaterThan(300);
 await expect.poll(async()=>(await snapshot(origin+'/B')).scrollY).toBeGreaterThan(100);
 assert.notEqual((await snapshot(origin+'/A')).scrollY,(await snapshot(origin+'/B')).scrollY);
 scrollFixture.afterScroll=await observeBoth();scrollFixture.scrollFocusAfter=await focused();scrollFixture.scrollFocusEvents=(await app.evaluate(()=>globalThis.qaFocusEvents)).slice(scrollFocusStart);
 for(const name of ['A','B'])assertScrollIdentity(scrollFixture.beforeScroll[name],scrollFixture.afterScroll[name]);
 assert.ok(!scrollFixture.scrollFocusEvents.some(event=>event.event==='focus'),'MCP scrolling must not focus a native window');assert.deepEqual(await mainInput(),expectedMainInput);
 // Restore the original UI scale before the remaining unchanged navigation,
 // popup and input scenarios, whose targets were established at that scale.
 scrollFixture.phase='restore-ui-scale';scrollFixture.restoreFocusBefore=await focused();
 const restoreFocusStart=await app.evaluate(()=>globalThis.qaFocusEvents.length);
 for(const [name,page] of [['A',pageA],['B',pageB]]){const control=pane(page).getByRole('combobox',{name:'뷰포트 배율',exact:true}),scale=scrollFixture.before[name].renderer.selectedScale;await selectControl(control,scale);await expectSelectValue(control,scale);}
 await expect.poll(async()=>{scrollFixture.restored=await observeBoth();return ['A','B'].every(name=>{const value=scrollFixture.restored[name],before=scrollFixture.before[name];return value.renderer.selectedScale===before.renderer.selectedScale&&value.renderer.renderedScaleX===before.renderer.renderedScaleX&&value.renderer.renderedScaleY===before.renderer.renderedScaleY&&value.derivedInputScale===before.derivedInputScale&&value.native.clipVisible&&nativeLayoutMatches(value);});}).toBe(true);
 scrollFixture.restoreFocusAfter=await focused();scrollFixture.restoreFocusEvents=(await app.evaluate(()=>globalThis.qaFocusEvents)).slice(restoreFocusStart);
 // Restoring the visible scale changes native bounds and CDP device metrics;
 // record its scroll effect separately from the unchanged MCP wheel assertions.
 scrollFixture.restoreScrollObservation={};
 for(const name of ['A','B']){assertScrollIdentity(scrollFixture.afterScroll[name],scrollFixture.restored[name]);const before=scrollFixture.afterScroll[name].native.dom.scrollY,after=scrollFixture.restored[name].native.dom.scrollY;scrollFixture.restoreScrollObservation[name]={before,after,delta:after-before,phase:'visible UI scale restoration after verified MCP wheel'};}
 assert.deepEqual(await mainInput(),expectedMainInput);scrollFixture.phase='verified';
 passed('프로젝트별 스크롤 동시 적용');
 const focusForData=await focused();
 const [updated,run]=await Promise.all([
  b.call('review_update',{projectId:projects.B.id,reviewId:reviews.B.id,title:'MCP 수정 리뷰 B',body:'B만 변경'}),
  a.call('run_start',{projectId:projects.A.id,reviewId:reviews.A.id,requestId:'qa-run-A',prompt:'WAIT_FOR_QA A'})
 ]);
 assert.ok(updated);assert.equal(await focused(),focusForData);
 const runA=run.run||run;const runId=runA.id||run.runId;assert.ok(runId);ownedJobIds.push(runId);
 const quickB=await b.call('run_start',{projectId:projects.B.id,reviewId:reviews.B.id,requestId:'qa-run-B',prompt:'QUICK_QA B'});const runBId=(quickB.run||quickB).id||quickB.runId;ownedJobIds.push(runBId);
 let doneB;await expect.poll(async()=>{doneB=await b.call('run_get',{projectId:projects.B.id,reviewId:reviews.B.id,runId:runBId});return (doneB.run||doneB).status}).toBe('completed');
 const waitingA=await a.call('run_get',{projectId:projects.A.id,reviewId:reviews.A.id,runId});assert.equal((waitingA.run||waitingA).status,'running');assert.match(JSON.stringify(doneB),/QA_FIXTURE_RESULT B/);
 const cross=await admin.raw('run_get',{projectId:projects.A.id,reviewId:reviews.A.id,runId:runBId});assert.equal(cross.isError,true);
 assert.equal((await snapshot(origin+'/B')).draft,'PROJECT_B_ONLY');assert.equal(await focused(),focusForData);
 passed('화면 QA 중 MCP 리뷰 수정·작업 요청·결과 조회, 작업과 결과의 프로젝트 분리');
 let navigationFinished=false;
 const navigation=a.call('qa_navigate',{...browserA,url:origin+'/A-slow'}).then(value=>{navigationFinished=true;return value});
 await b.call('qa_capture',browserB);assert.equal(navigationFinished,false,'B capture must finish while A page is loading');
 await navigation;assert.match((await a.call('qa_state',browserA)).title,/A-slow/);
 await a.call('qa_navigate',{...browserA,url:origin+'/A'});assert.match((await a.call('qa_state',browserA)).title,/QA A$/);
 assert.equal((await snapshot(origin+'/B')).draft,'PROJECT_B_ONLY');
 passed('A의 느린 페이지 이동 중 B 촬영 완료, 이동 응답 이후 새 페이지 표시');
 const beforePopup=await app.evaluate(()=>globalThis.qaFocusEvents.length);
 const popupLink=(await a.call('qa_state',browserA)).elements.find(item=>item.tag==='a'&&item.text==='새 검사 화면');
 await a.call('qa_click',{...browserA,...center(popupLink)});
 const popupA=await browserTarget(a,targetA,origin+'/A-popup');
 await inputRound(a,popupA,'POPUP_A_ONLY');assert.equal((await snapshot(origin+'/A-popup')).draft,'POPUP_A_ONLY');assert.equal((await snapshot(origin+'/B')).draft,'PROJECT_B_ONLY');
 assert.ok(!(await app.evaluate(()=>globalThis.qaFocusEvents)).slice(beforePopup).some(event=>event.event==='focus'));
 report.screenshots.push(await saveCapture(a,popupA,'06-project-A-popup'));
 passed('새 검사 창도 프로젝트 A에 연결하고 B 입력과 창 표시 유지');
 await pane(pageB).getByRole('tab',{name:'작업이력',exact:true}).click();
 const draftB=pane(pageB).locator('.original-review-composer').getByLabel('작업 내용',{exact:true});await draftB.fill('B 창에서 작성 중인 내용');
 const beforeReloadB=await snapshot(origin+'/B');
 await a.call('qa_reload',targetA);await pageA.waitForFunction(()=>Boolean(window.reviewops?.invoke));
 await expect(draftB).toHaveValue('B 창에서 작성 중인 내용');assert.deepEqual(await snapshot(origin+'/B'),beforeReloadB);
 await a.call('qa_close',targetA);await expect.poll(()=>pageA.isClosed()).toBe(true);
 await expect(draftB).toHaveValue('B 창에서 작성 중인 내용');assert.equal((await snapshot(origin+'/B')).instance,initialB.instance);
 report.screenshots.push(await saveCapture(b,targetB,'05-project-B-after-A-closed'));
 passed('A 창 새로고침·종료 후 B 창의 화면·입력·초안 유지');
 fs.writeFileSync(finish,'done');
 await expect.poll(async()=>{const value=await a.call('run_get',{projectId:projects.A.id,reviewId:reviews.A.id,runId});return (value.run||value).status}).toBe('completed');
 passed('창을 종료한 프로젝트의 진행 중 작업 완료와 결과 조회');
 await b.call('qa_release',targetB);
 // Optional live model/client scenarios remain outside the mandatory synthetic ten-case gate.
 assert.deepEqual(errors,[]);assert.equal(checks.length,10);await verifyNativePacket(packet);report.scenariosComplete=true;
}catch(error){report.error=error.stack||error.message;for(const page of app?pages():[])await page.screenshot({path:path.join(resultDir,'failure-'+(new URL(page.url()).searchParams.get('projectId')||'main')+'.png')}).catch(()=>{});console.error('CONCURRENT_QA_FAILURE',error);throw error}
finally{
 await finishRegression(context,{app,owner,main,ipc:session?.ipc,jobs:ownedJobIds,clients,server,release:async()=>{fs.writeFileSync(finish,'done');}});
 console.log(JSON.stringify({ok:report.ok,source:context.source,target:context.target,gate:'concurrent10',resultPath:packet.resultPath,cleanup:report.cleanup}));
}
