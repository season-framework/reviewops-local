import {setTestLocale} from './test-locale.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=process.cwd(),testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-update-ui-'));
const output=path.join(root,'test-results','update-ui');fs.mkdirSync(output,{recursive:true});
const checks=[],errors=[],requests=[];
const passed=name=>{checks.push(name);console.log(`PASS: ${name}`)};
let app,page;
const update=()=>page.locator('.sidebar-bottom .sidebar-update');
const settings=()=>page.locator('.workspace-pane:not([hidden]) .update-settings');
const publish=patch=>app.evaluate(({BrowserWindow},patch)=>{
 const fixture=globalThis.updateUiFixture;Object.assign(fixture.state,patch);
 BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('reviewops://app/')).webContents.send('reviewops:update-state',{...fixture.state});
},patch);
const finish=patch=>app.evaluate(({BrowserWindow},patch)=>{
 const fixture=globalThis.updateUiFixture;Object.assign(fixture.state,patch);
 BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('reviewops://app/')).webContents.send('reviewops:update-state',{...fixture.state});
 fixture.resolve?.({ok:true,data:{...fixture.state}});fixture.resolve=null;
},patch);
const calls=()=>app.evaluate(()=>globalThis.updateUiFixture.calls);
const pendingStates=()=>app.evaluate(()=>globalThis.updateUiFixture.pendingStates.length);
const holdInitialState=()=>app.evaluate(()=>{
 const fixture=globalThis.updateUiFixture;
 Object.assign(fixture.state,{availableVersion:'',status:'idle',progress:0,error:''});fixture.holdState=true;
});
const releaseInitialState=async()=>{
 await app.evaluate(()=>{
  const fixture=globalThis.updateUiFixture;fixture.holdState=false;
  for(const pending of fixture.pendingStates.splice(0))pending.resolve({ok:true,data:pending.state});
 });
 // A later IPC reply and animation frame let React render the delayed reply.
 await page.evaluate(()=>window.reviewops.invoke('update.state'));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
};
const settle=async()=>{
 await page.mouse.move(500,50);
 await page.locator('.sidebar-brand img').evaluate(image=>image.decode());
 await update().evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})))});
};
const geometry=()=>update().evaluate(node=>{
 const bounds=node.getBoundingClientRect(),sidebar=node.closest('.sidebar').getBoundingClientRect();
 return {bounds:{x:bounds.x,y:bounds.y,right:bounds.right,bottom:bounds.bottom,width:bounds.width,height:bounds.height},sidebar:{x:sidebar.x,y:sidebar.y,right:sidebar.right,bottom:sidebar.bottom},viewport:{width:innerWidth,height:innerHeight},color:getComputedStyle(node).color,background:getComputedStyle(node).backgroundColor};
});
function visibleBounds({bounds,sidebar,viewport}){
 assert.ok(bounds.width>=40&&bounds.height>=40);
 assert.ok(bounds.x>=sidebar.x&&bounds.right<=sidebar.right);
 assert.ok(bounds.y>=sidebar.y&&bounds.bottom<=sidebar.bottom);
 assert.ok(bounds.right<=viewport.width&&bounds.bottom<=viewport.height);
}
function readableColors({color,background}){
 const lightness=rgb=>{const [r,g,b]=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4});return .2126*r+.7152*g+.0722*b};
 const a=lightness(color),b=lightness(background);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${color} on ${background}`);
}

try{
 const env={...process.env,REVIEWOPS_DATA_DIR:path.join(testRoot,'data'),REVIEWOPS_SSH_CONFIG:path.join(testRoot,'ssh-config'),REVIEWOPS_CODEX_SSH_CONFIG:path.join(testRoot,'ssh-config')};
 fs.writeFileSync(env.REVIEWOPS_SSH_CONFIG,'# Isolated update UI fixture\n');
 for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});
 page=await app.firstWindow();page.setDefaultTimeout(10000);await setTestLocale(page);
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url())});
 await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
 await app.evaluate(({BrowserWindow,ipcMain})=>{
  const host=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('reviewops://app/'));host.setSize(1200,850);
  const original=ipcMain._invokeHandlers.get('reviewops:invoke');
  globalThis.updateUiFixture={state:{supported:true,version:'1.2.2',availableVersion:'',status:'current',automatic:false,progress:0,error:''},calls:0,resolve:null,holdState:false,pendingStates:[]};
  ipcMain.removeHandler('reviewops:invoke');ipcMain.handle('reviewops:invoke',async(event,action,payload)=>{
   const fixture=globalThis.updateUiFixture;
   if(action==='update.state'){
    const state={...fixture.state};
    if(fixture.holdState)return new Promise(resolve=>fixture.pendingStates.push({resolve,state}));
    return {ok:true,data:state};
   }
   if(action==='update.apply'){fixture.calls++;return new Promise(resolve=>{fixture.resolve=resolve})}
   if(action.startsWith('update.'))return {ok:true,data:{...fixture.state}};
   return original(event,action,payload);
  });
  host.webContents.send('reviewops:update-state',{...globalThis.updateUiFixture.state});
 });
 await expect(update()).toHaveCount(0);

 await app.evaluate(()=>Object.assign(globalThis.updateUiFixture.state,{availableVersion:'1.2.3',status:'available'}));
 await page.reload();await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
 await expect(update()).toBeVisible();await expect(update()).toHaveAttribute('aria-label','업데이트 설치 · 새 버전 1.2.3');
 passed('렌더러가 열리기 전에 발견한 새 버전을 초기 조회로 표시');

 await holdInitialState();await page.reload();await expect.poll(pendingStates).toBe(1);
 await publish({availableVersion:'1.2.3',status:'available'});await expect(update()).toBeVisible();
 await releaseInitialState();await expect(update()).toHaveAttribute('aria-label','업데이트 설치 · 새 버전 1.2.3');await expect(update()).toBeEnabled();
 passed('새 버전 이벤트 뒤에 도착한 초기 idle 응답이 사이드 메뉴 알림을 지우지 않음');

 await holdInitialState();await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();await expect.poll(pendingStates).toBe(1);
 await publish({availableVersion:'1.2.3',status:'available'});await expect(settings().getByRole('button',{name:'업데이트 설치',exact:true})).toBeVisible();
 await releaseInitialState();await expect(settings().getByRole('button',{name:'업데이트 설치',exact:true})).toBeVisible();await expect(settings().getByRole('status')).toContainText('새 버전을 사용할 수 있습니다.');
 passed('설정에서도 새 버전 이벤트 뒤에 도착한 초기 idle 응답을 무시');

 await publish({status:'checking'});await expect(update()).toBeVisible();await expect(update()).toBeDisabled();await expect(settings().getByRole('status')).toContainText('업데이트 확인 중');
 await publish({status:'available'});await expect(update()).toBeEnabled();await expect(settings().getByRole('button',{name:'업데이트 설치',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'설정 닫기',exact:true}).click();
 passed('주기 확인 상태 이벤트 중에도 새 버전 알림을 유지하고 확인 후 설치 버튼을 다시 활성화');

 await publish({availableVersion:'1.2.3',status:'available'});
 await expect(update()).toBeVisible();await expect(update()).toBeEnabled();
 await expect(update()).toHaveAttribute('aria-label','업데이트 설치 · 새 버전 1.2.3');
 await settle();visibleBounds(await geometry());readableColors(await geometry());await expect(update().locator('.sidebar-update-copy')).toBeHidden();
 await page.screenshot({path:path.join(output,'collapsed-light.png')});
 const before=(await geometry()).background;await update().hover();
 await expect.poll(async()=>{const animations=await update().evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{})));return getComputedStyle(node).backgroundColor});return animations}).not.toBe(before);
 await page.locator('.main-nav').getByRole('button',{name:'호스트관리',exact:true}).focus();await page.keyboard.press('Tab');await expect(update()).toBeFocused();
 assert.equal(await update().evaluate(node=>node.matches(':focus-visible')),true);
 passed('새 버전을 접힌 메뉴 하단에 표시하고 마우스·키보드 효과 제공');

 await page.getByRole('button',{name:'메뉴 펼치기',exact:true}).click();
 await expect(update().locator('.sidebar-update-copy')).toBeVisible();await expect(update()).toContainText('새 버전 1.2.3');await settle();visibleBounds(await geometry());readableColors(await geometry());
 await page.screenshot({path:path.join(output,'expanded-light.png')});
 await page.getByRole('button',{name:'어두운 화면',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await settle();visibleBounds(await geometry());readableColors(await geometry());
 await page.screenshot({path:path.join(output,'expanded-dark.png')});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('reviewops://app/')).setSize(800,600));visibleBounds(await geometry());
 passed('펼친 메뉴에서 버전을 표시하고 밝은·어두운 화면과 최소 창 크기에 맞게 배치');

 await update().click();await expect(update()).toBeDisabled();
 await update().evaluate(node=>{node.click();node.click()});await expect.poll(calls).toBe(1);
 await publish({status:'downloading',progress:37});await expect(update()).toHaveAttribute('aria-label','다운로드 중 37% · 새 버전 1.2.3');await expect(update().locator('progress')).toHaveAttribute('value','37');
 await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();
 await expect(settings().getByRole('button',{name:'업데이트 진행 중',exact:true})).toBeDisabled();await expect(settings().getByRole('status')).toContainText('37%');
 await publish({status:'verifying',progress:100});await expect(update()).toHaveAttribute('aria-label','다운로드한 앱 검사 중 · 새 버전 1.2.3');await expect(update()).toBeDisabled();
 passed('한 번 클릭으로 설치를 요청하고 다운로드·검사 중 중복 클릭과 설정 화면 재요청 차단');

 await finish({status:'error',error:'업데이트 다운로드를 완료하지 못했습니다.'});
 await expect(update()).toBeEnabled();await expect(update()).toContainText('업데이트 다시 시도');
 await expect(page.locator('.error-banner')).toContainText('업데이트 다운로드를 완료하지 못했습니다.');
 await expect(settings().getByRole('alert')).toContainText('업데이트 다운로드를 완료하지 못했습니다.');
 await settings().getByRole('button',{name:'업데이트 설치',exact:true}).click();await expect.poll(calls).toBe(2);await expect(settings().getByRole('button',{name:'업데이트 진행 중',exact:true})).toBeDisabled();
 await publish({status:'installing',error:''});await expect(update()).toContainText('업데이트 설치 중');await expect(update()).toBeDisabled();
 await finish({status:'ready'});await expect(update()).toBeEnabled();await expect(settings().getByRole('button',{name:'설치하고 다시 시작',exact:true})).toBeEnabled();
 await settings().getByRole('button',{name:'설치하고 다시 시작',exact:true}).click();await expect.poll(calls).toBe(3);await finish({status:'ready'});
 passed('실패 내용을 표시하고 설정에서 같은 설치 동작으로 재시도하며 취소 후 다시 설치 가능');

 await publish({supported:false,status:'available',availableVersion:'1.2.3',error:''});
 await expect(update()).toHaveCount(0);await expect(settings().getByRole('button',{name:'업데이트 설치',exact:true})).toHaveCount(0);
 await expect(settings().getByRole('button',{name:'설치하고 다시 시작',exact:true})).toHaveCount(0);
 await expect(settings().getByRole('button',{name:'업데이트 확인',exact:true})).toBeDisabled();
 await expect(settings().getByRole('checkbox',{name:'새 버전 자동 확인',exact:true})).toBeDisabled();
 await expect(settings()).toContainText('자동 업데이트는 설치된 macOS 앱에서 사용할 수 있습니다.');
 await publish({supported:true,status:'current',availableVersion:''});await expect(update()).toHaveCount(0);
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);assert.equal(await calls(),3);
 passed('자동 설치를 지원하지 않는 실행 환경과 최신 버전에서는 설치 알림을 표시하지 않음');
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:true,checks,rendererErrors:errors,externalRequests:requests,applyRequests:await calls(),downloads:0,installations:0},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length,applyRequests:await calls(),downloads:0,installations:0}));
}catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error}
finally{await app?.close().catch(()=>{})}
