import {setTestLocale} from './test-locale.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root=process.cwd(),testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-browser-elements-'));
const home=path.join(testRoot,'home'),config=path.join(home,'.ssh','config'),screenshots=path.join(testRoot,'screenshots');
fs.mkdirSync(path.dirname(config),{recursive:true});fs.mkdirSync(screenshots);fs.writeFileSync(config,'# Synthetic element selection\n');
const checks=[],errors=[];let app,page,nativeId,browserId;
const passed=name=>{checks.push(name);console.log('PASS: '+name)};
const server=http.createServer((request,response)=>{
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
 if(request.url==='/frame'){response.end('<!doctype html><style>body{margin:0;font:18px system-ui;height:1600px}#frame-hit{margin:500px 20px 0;padding:18px 30px}</style><button id="frame-hit" onclick="window.clicked=(window.clicked||0)+1">iframe 선택 요소</button>');return}
 response.end('<!doctype html><title>요소 표시 검사</title><style>body{margin:0;padding:24px;background:#f2f6fb;font:18px system-ui;height:2600px}h1{font-size:26px}button{padding:18px 30px;border:1px solid #7a93ae;background:white;border-radius:7px}#hit{display:block;margin-top:90px}#scroll-box{height:120px;width:500px;overflow:auto;margin-top:80px;border:2px solid #7a93ae}#scroll-content{height:900px}#scroll-hit{margin-top:250px}iframe{display:block;margin-top:300px;width:650px;height:240px;border:4px solid #7a93ae}#deep{display:block;margin-top:900px}</style><h1>검토할 요소의 위치 표시</h1><p>요소를 선택한 뒤 이동하거나 스크롤해도 표시를 유지합니다.</p><button id="hit" onclick="window.clicked=(window.clicked||0)+1">선택할 버튼</button><div id="scroll-box"><div id="scroll-content"><button id="scroll-hit">스크롤 영역 요소</button></div></div><iframe id="frame" src="/frame"></iframe><button id="deep">페이지 아래쪽 요소</button><input id="private" type="password" value="synthetic-password">');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const native=expression=>app.evaluate(({webContents},{id,expression})=>webContents.fromId(id).executeJavaScript(expression,true),{id:nativeId,expression});
const pane=()=>page.locator('.workspace-pane:not([hidden])');
const overlay=()=>native('(()=>{const el=document.querySelector("reviewops-element-highlight");if(!el)return null;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,pointerEvents:s.pointerEvents,border:s.borderTopWidth}})()');
const pickerReady=()=>app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScriptInIsolatedWorld(109,[{code:'Boolean(window.__reviewopsElementInspector?.picking)'}]),nativeId);
async function pick(expression){
 await pane().getByRole('button',{name:'요소 지정',exact:true}).click();
 await expect(pane().getByRole('button',{name:'요소 선택 중 · Esc 취소',exact:true})).toBeDisabled();
 await expect.poll(pickerReady).toBe(true);
 await native(`(()=>{const el=${expression};el.dispatchEvent(new PointerEvent('pointermove',{bubbles:true}));el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,composed:true}))})()`);
 await expect(pane().getByRole('button',{name:'요소 지정',exact:true})).toBeEnabled();
}
async function expectHighlight(expression){
 await expect.poll(async()=>{
  const actual=await overlay(),expected=await native(`(()=>{const r=${expression};return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  return actual?.display==='block'&&['x','y','width','height'].every(key=>Math.abs(actual[key]-expected[key])<2);
 }).toBe(true);
}
async function capture(name){
 const content=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).capturePage()).toPNG().toString('base64'),nativeId);
 fs.writeFileSync(path.join(screenshots,name+'-page.png'),Buffer.from(content,'base64'));
 const window=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().startsWith('reviewops://app/')).capturePage()).toPNG().toString('base64'));
 fs.writeFileSync(path.join(screenshots,name+'-window.png'),Buffer.from(window,'base64'));
}
try{
 const env={...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),REVIEWOPS_CODEX_SSH_CONFIG:config,REVIEWOPS_DATA_DIR:path.join(testRoot,'data')};delete env.ELECTRON_RUN_AS_NODE;delete env.SSH_AUTH_SOCK;
 app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().startsWith('reviewops://app/')).setSize(1700,1050));
 const group=await ipc('group.save',{name:'요소 표시 검사'}),project=await ipc('project.save',{name:'검토대상 요소',groupId:group.id,connection:{kind:'local',rootPath:testRoot,viewerUrl:origin,viewerWidth:1000,viewerHeight:650,viewerScale:'fit'}});
 await page.locator('.workspace-refresh').click();await page.getByRole('button',{name:project.name+' 프로젝트 열기',exact:true}).click();
 const surface=pane().locator('.native-browser-surface');await expect(surface).toHaveAttribute('data-browser-id',/.+/);browserId=await surface.getAttribute('data-browser-id');
 await expect.poll(async()=>(await ipc('browser.state',{id:browserId})).loading).toBe(false);
 nativeId=await app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(item=>item.getURL().startsWith(origin)).id,origin);
 await expect.poll(()=>native('Boolean(document.querySelector("#frame").contentDocument?.querySelector("#frame-hit"))')).toBe(true);
 await pick('document.querySelector("#hit")');
 await expect(pane().locator('.viewer-selected-element')).toContainText('#hit');await expectHighlight('document.querySelector("#hit").getBoundingClientRect()');
 assert.equal((await overlay()).pointerEvents,'none');assert.equal((await overlay()).border,'3px');assert.equal(await native('window.clicked||0'),0);
 await capture('selected-element');passed('요소 지정 완료 후 상단 결과와 실제 페이지 강조 표시 유지');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().startsWith('reviewops://app/')).setSize(1050,900));
 await expect.poll(()=>pane().locator('.viewer-selected-element').evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
 await pane().locator('.viewer-element-action').evaluateAll(elements=>elements.forEach(element=>{const node=document.createTextNode(' Long translated element action description');element.appendChild(node);element.__syntheticTranslationNode=node}));
 await expect.poll(()=>pane().locator('.viewer-selected-element').evaluate(element=>{const r=element.getBoundingClientRect();return element.scrollWidth<=element.clientWidth&&[...element.children].every(child=>{const c=child.getBoundingClientRect();return c.left>=r.left&&c.right<=r.right})})).toBe(true);
 await capture('narrow-selected-element');
 await pane().locator('.viewer-element-action').evaluateAll(elements=>elements.forEach(element=>{element.__syntheticTranslationNode?.remove();delete element.__syntheticTranslationNode}));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().startsWith('reviewops://app/')).setSize(1700,1050));
 passed('좁은 검토 화면과 긴 번역 문구에서 요소 표시 줄 가로 넘침 방지');

 await native('document.querySelector("#hit").style.marginLeft="140px"');await expectHighlight('document.querySelector("#hit").getBoundingClientRect()');
 await native('window.scrollTo(0,1000)');await expect.poll(async()=>(await overlay())?.display).toBe('none');
 await pane().getByRole('button',{name:'선택 요소로 이동',exact:true}).click();await expectHighlight('document.querySelector("#hit").getBoundingClientRect()');
 await native('document.querySelector("#hit").click()');assert.equal(await native('window.clicked'),1);
 passed('요소 위치 변경과 스크롤 추적, 선택 요소로 이동, 웹페이지 클릭 유지');

 await pane().getByRole('button',{name:'요소 지정',exact:true}).click();await expect(pane().getByRole('button',{name:'요소 선택 중 · Esc 취소',exact:true})).toBeDisabled();
 await expect.poll(pickerReady).toBe(true);
 await native('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await expect(pane().getByRole('button',{name:'요소 지정',exact:true})).toBeEnabled();
 await expectHighlight('document.querySelector("#hit").getBoundingClientRect()');assert.equal((await ipc('browser.state',{id:browserId})).selectedElement.selector,'#hit');
 passed('새 요소 지정 취소 후 이전 선택과 강조 표시 보존');

 await native('document.querySelector("#scroll-hit").scrollIntoView({block:"center"})');await pick('document.querySelector("#scroll-hit")');
 await expectHighlight('document.querySelector("#scroll-hit").getBoundingClientRect()');
 await native('document.querySelector("#scroll-box").scrollTop=0');await expect.poll(async()=>(await overlay())?.display).toBe('none');
 await pane().getByRole('button',{name:'선택 요소로 이동',exact:true}).click();await expectHighlight('document.querySelector("#scroll-hit").getBoundingClientRect()');
 passed('스크롤 영역 밖으로 가려진 요소 표시 숨김과 이동 후 복원');

 await native('document.querySelector("#frame").scrollIntoView({block:"center"});document.querySelector("#frame").contentDocument.querySelector("#frame-hit").scrollIntoView({block:"center"})');
 await pick('document.querySelector("#frame").contentDocument.querySelector("#frame-hit")');
 const frameRect='(()=>{const f=document.querySelector("#frame"),r=f.getBoundingClientRect(),c=f.contentDocument.querySelector("#frame-hit").getBoundingClientRect();return {x:r.x+f.clientLeft+c.x,y:r.y+f.clientTop+c.y,width:c.width,height:c.height}})()';
 await expectHighlight(frameRect);await expect(pane().locator('.viewer-selected-element')).toContainText('#frame → #frame-hit');
 assert.deepEqual((await ipc('browser.state',{id:browserId})).selectedElement.framePath,['#frame']);
 await native('window.scrollTo(0,1800)');await pane().getByRole('button',{name:'선택 요소로 이동',exact:true}).click();await expectHighlight(frameRect);
 await capture('iframe-element');passed('iframe 내부 요소 선택과 화면 좌표 일치, 이동 후 강조 표시 유지');

 await pane().getByRole('button',{name:'요소 표시 해제',exact:true}).click();await expect(pane().locator('.viewer-selected-element')).toHaveCount(0);
 assert.equal(await overlay(),null);assert.equal((await ipc('browser.evidence',{id:browserId})).fingerprint_log.selectedElement,undefined);
 await native('window.scrollTo(0,0)');await pick('document.querySelector("#private")');
 assert.equal((await ipc('browser.evidence',{id:browserId})).fingerprint_log.selectedElement.text,'');
 await ipc('browser.context',{id:browserId,contextId:'different-context'});await expect.poll(overlay).toBe(null);assert.equal((await ipc('browser.state',{id:browserId})).selectedElement,null);
 passed('표시 해제와 연결 변경 시 선택 정리, 입력 영역 내용 제외');

 await pick('document.querySelector("#hit")');await pane().getByRole('group',{name:'기능',exact:true}).getByRole('button',{name:'새로고침',exact:true}).click();
 await expect.poll(async()=>(await ipc('browser.state',{id:browserId})).loading).toBe(false);await expect(pane().locator('.viewer-selected-element')).toHaveCount(0);assert.equal(await overlay(),null);
 passed('페이지를 다시 불러온 후 이전 요소 표시와 결과 정리');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(testRoot,'results.json'),JSON.stringify({checks,errors,screenshots},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,testRoot,screenshots}));
}finally{
 if(app){const timer=setTimeout(()=>app.process().kill('SIGKILL'),10000);try{await app.close()}finally{clearTimeout(timer)}}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
