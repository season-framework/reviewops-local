import {setTestLocale} from './test-locale.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root=process.cwd(),testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-evidence-'));
const checks=[],errors=[];
const passed=name=>{checks.push(name);console.log(`PASS: ${name}`)};
const server=http.createServer((req,res)=>{
 if(req.url.startsWith('/api')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Frame-Options':'DENY'});
 res.end(`<!doctype html><title>로그 검사</title><h1 id="heading">검토할 화면</h1><label>내용<input id="draft" name="draft"></label><label>비밀번호<input id="password" name="password" type="password"></label><div id="editor" contenteditable="true">private-fixture-editor</div><select id="choice"><option>private-fixture-choice</option></select><button id="submit" onclick="window.hit=(window.hit||0)+1">확인</button><script>console.info('초기 콘솔');window.ready=true</script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let app,page,nativeId;
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const native=expression=>app.evaluate(({webContents},{id,expression})=>webContents.fromId(id).executeJavaScript(expression,true),{id:nativeId,expression});
try{
 const env={...process.env,REVIEWOPS_DATA_DIR:path.join(testRoot,'data')};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});
 page=await app.firstWindow(); await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.reviewops?.invoke);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('reviewops://app/')).setSize(1600,1000));
 const group=await ipc('group.save',{name:'로그 검사'}),service=await ipc('service.save',{name:'로그 서비스',groupId:group.id,kind:'local',rootPath:testRoot,viewerUrl:origin}),project=await ipc('project.save',{name:'로그 프로젝트',groupId:group.id,serviceIds:[service.id]});
 await page.locator('.workspace-refresh').click();await page.getByRole('button',{name:`${project.name} 프로젝트 열기`,exact:true}).click();
 const pane=page.locator('.workspace-pane:not([hidden])'),surface=pane.locator('.native-browser-surface');await expect(surface).toHaveAttribute('data-browser-id',/.+/);const id=await surface.getAttribute('data-browser-id');
 await expect.poll(async()=>await app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(contents=>contents.getURL().startsWith(origin))?.id,origin)).toBeTruthy();
 nativeId=await app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(contents=>contents.getURL().startsWith(origin)).id,origin);
 await expect.poll(()=>native('window.ready')).toBe(true);await expect.poll(async()=>(await ipc('browser.state',{id})).loading).toBe(false);
 await native(`(()=>{for(const [key,value]of [['draft','입력 내용'],['password','private-fixture-password']]){const input=document.getElementById(key);input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}))}document.querySelector('#submit').click();console.error('token=private-fixture-token');console.error(JSON.stringify({token:'private-fixture-json',password:'private-fixture-json-password'}));console.error('Authorization: Basic cHJpdmF0ZS1maXh0dXJl');history.pushState({},'', '/detail?token=private-fixture-query&view=1');fetch('/api?access_token=private-fixture-network')})()`);
 await expect.poll(async()=>(await ipc('browser.evidence',{id})).network_log.some(item=>item.url.includes('/api'))).toBe(true);
 const evidence=await ipc('browser.evidence',{id});
 assert.ok(evidence.navigation_log.some(item=>item.type==='navigate-in-page'));
 assert.ok(evidence.input_log.some(item=>item.target.id==='draft'&&item.value===undefined&&item.value_length===5&&item.masked));
 assert.ok(evidence.input_log.some(item=>item.target.id==='password'&&item.value===undefined&&item.masked));
 assert.ok(evidence.console_log.some(item=>item.message==='token=[비공개]'));
 assert.equal(evidence.fingerprint_log.viewport.width,await native('innerWidth'));
 assert.ok(!JSON.stringify(evidence).includes('private-fixture-'));
 assert.equal(await native('typeof window.reviewops'),'undefined');assert.equal(await native('typeof window.__reviewopsInputRecorder'),'undefined');
 passed('실제 브라우저의 이동·입력·통신·콘솔·환경 수집과 입력 원문 제외·앱 연결 격리');
 await pane.getByRole('button',{name:'로그',exact:true}).click();await expect(pane.getByRole('region',{name:'뷰어 로그'})).toBeVisible();
 await pane.getByRole('navigation',{name:'뷰어 로그 종류'}).getByRole('button',{name:/콘솔/}).click();await expect(pane.locator('.viewer-log-entries')).toContainText('token=[비공개]');
 await pane.getByRole('button',{name:'선택 로그 지우기',exact:true}).click();await expect.poll(async()=>(await ipc('browser.evidence',{id})).console_log.length).toBe(0);assert.ok((await ipc('browser.evidence',{id})).input_log.length);
 await pane.getByRole('button',{name:'뷰어 로그 닫기',exact:true}).click();passed('로그 종류 보기와 선택한 종류만 지우기');
 const picking=ipc('browser.pickElement',{id});await page.waitForTimeout(250);await native(`document.querySelector('#heading').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);assert.equal((await picking).selector,'#heading');
 assert.equal((await ipc('browser.evidence',{id})).fingerprint_log.selectedElement.selector,'#heading');passed('검토할 요소 지정과 환경 정보 저장');
 for(const selector of ['#editor','#choice']){const pending=ipc('browser.pickElement',{id});await page.waitForTimeout(150);await native('document.querySelector('+JSON.stringify(selector)+').dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}))');assert.equal((await pending).text,'')}
 const latest=await ipc('browser.collectFor',{contextId:service.id,url:origin});assert.equal(latest.fingerprint_log.selectedElement.selector,'#choice');
 await ipc('browser.context',{id,contextId:'changed-service'});const rebound=await ipc('browser.evidence',{id});for(const kind of ['navigation','input','network','console'])assert.equal(rebound[kind+'_log'].length,0);assert.equal(rebound.fingerprint_log.selectedElement,undefined);assert.equal((await ipc('browser.collectFor',{contextId:service.id})).available,false);assert.equal((await ipc('browser.collectFor',{contextId:'changed-service'})).available,true);await ipc('browser.context',{id,contextId:service.id});
 passed('입력 영역 요소 지정 시 원문 제외와 서비스 전환 시 이전 로그 초기화');
 await ipc('browser.clearLogs',{id,kind:'all'});const cleared=await ipc('browser.evidence',{id});for(const key of ['navigation','input','network','console'])assert.equal(cleared[key+'_log'].length,0);assert.ok(cleared.fingerprint_log.userAgent);passed('전체 로그 지우기와 화면 환경 정보 유지');
 const review=await ipc('review.save',{title:'홈 캡처',body:'캡처 검사',projectId:project.id,serviceId:service.id,targetUrl:origin});await page.locator('.workspace-refresh').click();await page.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();await page.getByRole('treeitem').filter({hasText:review.title}).click();
 const detail=page.locator('.work-home-detail');await detail.getByRole('button',{name:'작업이력 자료 추가',exact:true}).click();await detail.getByRole('menuitem',{name:'작업이력 스크린샷',exact:true}).click();const dialog=page.getByRole('dialog',{name:'스크린샷 캡처',exact:true}).filter({has:page.locator('.original-viewer')});await expect(dialog).toBeVisible();await expect(dialog.locator('.native-browser-surface')).toHaveAttribute('data-browser-id',/.+/);
 const homeId=await dialog.locator('.native-browser-surface').getAttribute('data-browser-id');await expect.poll(async()=>(await ipc('browser.state',{id:homeId})).loading).toBe(false);
 await expect.poll(async()=>app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().some(win=>win.isVisible()&&win.contentView.children.some(view=>view.webContents?.getURL().startsWith(origin))),origin)).toBe(true);
 await dialog.getByRole('button',{name:'스크린샷 캡처',exact:true}).click();const editor=page.getByRole('dialog',{name:'스크린샷',exact:true}).filter({has:page.locator('.screenshot-editor')});await expect(editor).toBeVisible();await editor.getByRole('button',{name:'사용하기',exact:true}).click();await expect(dialog).toBeHidden();await expect(detail.locator('.original-review-pending')).toContainText('스크린샷');
 await detail.getByRole('button',{name:'작업이력 보내기',exact:true}).click();await expect(detail.locator('.original-review-pending')).toBeHidden();await expect.poll(async()=>(await ipc('snapshot')).attachments.filter(file=>file.reviewId===review.id).length).toBe(1);
 passed('홈 캡처 창 안의 외부 브라우저 표시와 편집한 스크린샷 첨부');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(testRoot,'results.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,testRoot}));
}finally{if(app){const timer=setTimeout(()=>app.process().kill('SIGKILL'),10000);try{await app.close()}finally{clearTimeout(timer)}}server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
