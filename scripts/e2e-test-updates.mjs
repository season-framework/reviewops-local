import {_electron as electron,expect} from '@playwright/test';
import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-test-updates-'));
const output=path.join(root,'test-results','test-updates-ui');fs.mkdirSync(output,{recursive:true});
const checks=[],errors=[],requests=[],catalogs=JSON.parse(fs.readFileSync(path.join(root,'src/i18n/translations.json'),'utf8')),english=JSON.parse(fs.readFileSync(path.join(root,'src/i18n/en.json'),'utf8'));
let app,page;
const settings=()=>page.locator('.workspace-pane:not([hidden]) .update-settings');
const toggle=()=>settings().getByRole('checkbox',{name:'테스트 버전 받기',exact:true});
const pass=name=>{checks.push(name);console.log('PASS: '+name)};
const calls=()=>app.evaluate(()=>globalThis.testUpdateUiFixture.calls);
const publish=patch=>app.evaluate(({BrowserWindow},patch)=>{
 const f=globalThis.testUpdateUiFixture;Object.assign(f.state,patch);
 BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('reviewops://app/')).webContents.send('reviewops:update-state',structuredClone(f.state));
},patch);
const hold=action=>app.evaluate((_,action)=>{globalThis.testUpdateUiFixture.hold=action},action);
const finish=({fail=false}={})=>app.evaluate(({BrowserWindow},fail)=>{
 const f=globalThis.testUpdateUiFixture,pending=f.pending.shift();assertPending();
 function assertPending(){if(!pending)throw new Error('No pending fixture action');}
 if(fail)pending.resolve({ok:false,error:{message:'지연된 이전 요청 실패'}});
 else pending.resolve({ok:true,data:pending.result});
 f.hold=null;
},fail);
async function openSettings(){
 await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();
 await page.locator('.settings-section-menu').getByRole('button',{name:'자동 확인',exact:true}).click();
 await expect(settings()).toBeVisible();
}
try{
 const dataPath=path.join(testRoot,'data'),config=path.join(testRoot,'ssh-config');
 fs.writeFileSync(config,'# Isolated test update UI fixture\n');
 const privateRuntime=Object.fromEntries(Object.entries(isolatedModelRuntime({home:path.join(testRoot,'home'),dataPath})).filter(([key])=>!['HOME','CODEX_HOME'].includes(key)));
 const env={...process.env,...privateRuntime,REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:config,REVIEWOPS_CODEX_SSH_CONFIG:config};
 for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(10000);await setTestLocale(page);
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url())});
 await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
 await app.evaluate(({BrowserWindow,ipcMain})=>{
  const window=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().startsWith('reviewops://app/'));window.setSize(1100,800);
  const original=ipcMain._invokeHandlers.get('reviewops:invoke');
  const testBuild={channel:'test',version:'1.2.10',buildNumber:42,commit:'abc1234567890abc1234567890abc1234567890abc',builtAt:'2026-10-31T02:30:00.000Z'};
  const f=globalThis.testUpdateUiFixture={testBuild,state:{version:'1.2.9',arch:'arm64',supported:true,testSupported:true,canCheck:true,manualInstall:false,automatic:false,intervalMinutes:10,channel:'stable',testUpdates:false,installedBuild:{channel:'stable',version:'1.2.9'},availableBuild:null,generation:0,status:'current',error:'',errorCode:'',progress:0,checkedAt:null,availableVersion:null},calls:[],pending:[],hold:null,windows:false};
  const emit=()=>window.webContents.send('reviewops:update-state',structuredClone(f.state));
  ipcMain.removeHandler('reviewops:invoke');ipcMain.handle('reviewops:invoke',async(event,action,payload={})=>{
   if(!action.startsWith('update.'))return original(event,action,payload);
   if(action==='update.state')return {ok:true,data:structuredClone(f.state)};
   if(action==='update.rendererReady')return {ok:true,data:{}};
   f.calls.push({action,payload});
   if(action==='update.copyInfo')return {ok:true,data:{copied:true}};
   if(action==='update.configure'){
    if(Object.hasOwn(payload,'testUpdates')){
     f.state.generation++;f.state.testUpdates=payload.testUpdates;f.state.channel=payload.testUpdates?'test':'stable';
     f.state.canCheck=true;f.state.manualInstall=f.windows;
     Object.assign(f.state,{availableVersion:payload.testUpdates?f.testBuild.version:null,availableBuild:payload.testUpdates?f.testBuild:null,status:payload.testUpdates?'available':'current',error:'',errorCode:'',progress:0});
    }
    if(Object.hasOwn(payload,'automatic'))f.state.automatic=payload.automatic;
    if(Object.hasOwn(payload,'intervalMinutes'))f.state.intervalMinutes=payload.intervalMinutes;
   }
   if(action==='update.check')Object.assign(f.state,{status:'checking',error:'',errorCode:''});
   if(action==='update.download')Object.assign(f.state,{status:'downloading',progress:25});
   if(action==='update.install')f.state.status='installing';
   emit();
   if(f.hold===action){const result=structuredClone({...f.state,status:action==='update.check'?'available':'ready',availableVersion:action==='update.check'?'9.9.9':f.state.availableVersion});return new Promise(resolve=>f.pending.push({resolve,result}))}
   if(action==='update.download')f.state.status='ready';
   if(action==='update.install')f.state.status='ready';
   if(action==='update.check')f.state.status='current';
   emit();return {ok:true,data:structuredClone(f.state)};
  });emit();
 });
 await openSettings();
 await expect(toggle()).not.toBeChecked();await expect(toggle()).toBeEnabled();
 await expect(settings().locator('.update-version-row')).toHaveText('설치된 버전 1.2.9정식');
 await expect(settings().locator('.update-details')).not.toHaveAttribute('open','');
 await expect(settings().getByText('정식 버전과 테스트 버전 중 더 최신인 버전을 받습니다. 업데이트 뒤에도 이 설정을 유지합니다.',{exact:true})).toBeVisible();
 pass('테스트 버전 기본 해제, 설치된 버전과 간단한 설명 표시');

 await toggle().check();await expect(toggle()).toBeChecked();
 await expect(settings().locator('.update-version-row')).toContainText('설치된 버전 1.2.9');await expect(settings().locator('.update-version-row')).toContainText('받을 버전 1.2.10');
 await expect(settings().getByText('abc123456789',{exact:true})).toBeHidden();
 await settings().locator('summary').click();await expect(settings().getByText('abc123456789',{exact:true})).toBeVisible();
 await expect(settings().locator('.update-build-info').nth(1)).toContainText('42');
 await settings().getByRole('button',{name:'버전 정보 복사',exact:true}).click();await expect(settings().getByRole('button',{name:'복사됨',exact:true})).toBeVisible();
 assert.equal((await calls()).filter(call=>call.action==='update.copyInfo').length,1);
 pass('받을 테스트 버전 구분, 자세히 보기 안의 빌드 정보와 복사 동작');

 await hold('update.check');await settings().getByRole('button',{name:'업데이트 확인',exact:true}).click();
 await expect(settings().getByRole('status')).toContainText('업데이트 확인 중');await expect(toggle()).toBeEnabled();await toggle().uncheck();
 await expect(toggle()).not.toBeChecked();await finish();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await expect(settings().locator('.update-version-row')).not.toContainText('9.9.9');await expect(settings().getByRole('status')).toHaveText('최신 버전입니다.');
 pass('확인 중 선택 변경과 이전 확인 응답 무시');

 await toggle().check();await hold('update.check');await settings().getByRole('button',{name:'업데이트 확인',exact:true}).click();await toggle().uncheck();await finish({fail:true});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await expect(settings().getByText('지연된 이전 요청 실패',{exact:true})).toHaveCount(0);
 const stableGeneration=await app.evaluate(()=>globalThis.testUpdateUiFixture.state.generation);
 await app.evaluate(({BrowserWindow},generation)=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('reviewops://app/')).webContents.send('reviewops:update-state',{...globalThis.testUpdateUiFixture.state,generation:generation-1,channel:'test',testUpdates:true,status:'ready',availableVersion:'9.9.9'}),stableGeneration);
 await expect(toggle()).not.toBeChecked();await expect(settings().locator('.update-version-row')).not.toContainText('9.9.9');
 pass('이전 요청의 늦은 실패와 이전 선택의 상태 이벤트 무시');

 await toggle().check();await publish({status:'error',error:'테스트 릴리스 없음',errorCode:'test_unavailable',availableVersion:null,availableBuild:null});
 await expect(settings().getByRole('status')).toHaveText('받을 수 있는 테스트 버전이 없습니다.');await expect(settings().getByRole('status')).not.toContainText('최신 버전');await expect(settings().getByRole('button',{name:'업데이트 확인',exact:true})).toBeEnabled();
 await publish({status:'error',error:'연결하지 못했습니다.',errorCode:'network_error'});await expect(settings().getByRole('alert')).toHaveText('연결하지 못했습니다.');await expect(settings().getByRole('status')).not.toContainText('최신 버전');
 pass('테스트 버전 없음과 통신 실패 구분, 최신 버전으로 잘못 표시하지 않음');

 for(const [errorCode,message]of [['test_changed','테스트 버전이 변경되었습니다. 업데이트를 다시 확인하십시오.'],['older_build','설치했거나 전에 받은 버전보다 오래된 파일입니다.'],['invalid_manifest','업데이트 파일 정보가 일치하지 않습니다. 다시 확인하십시오.'],['build_mismatch','업데이트 파일 정보가 일치하지 않습니다. 다시 확인하십시오.'],['invalid_installer','업데이트 파일 정보가 일치하지 않습니다. 다시 확인하십시오.'],['hash_mismatch','설치 파일 검사가 실패했습니다. 다시 받으십시오.'],['installer_failed','설치 파일을 열지 못했습니다. 다시 시도하십시오.']]){
  await publish({status:'error',error:'Internal fixture detail',errorCode});await expect(settings().getByRole('alert')).toHaveText(message);
 }
 pass('버전 변경·오래된 파일·파일 불일치·파일 검사·설치 파일 열기 실패의 안내');

 await publish({status:'current',error:'',errorCode:'',installedBuild:{channel:'test',version:'1.2.10',buildNumber:41,commit:'def1234567890def1234567890def1234567890def',builtAt:'2026-10-30T02:30:00.000Z'}});
 await toggle().uncheck();await expect(settings()).toContainText('선택 해제 후에는 정식 업데이트를 확인합니다. 설치된 테스트 버전은 바뀌지 않습니다.');
 await expect(settings().locator('.update-version-row')).toContainText('설치된 버전 1.2.10-test.41테스트');
 await page.reload();await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();await openSettings();await expect(toggle()).not.toBeChecked();await expect(settings().locator('.update-version-row')).toContainText('1.2.10');
 pass('선택 해제 후 설치된 테스트 버전 유지 안내와 화면을 다시 열었을 때 설정 표시');

 await app.evaluate(()=>{const f=globalThis.testUpdateUiFixture;f.windows=true;Object.assign(f.state,{supported:false,canCheck:true,manualInstall:true})});
 await toggle().check();await expect(settings().getByRole('button',{name:'설치 파일 받기',exact:true})).toBeEnabled();
 await expect(settings()).toContainText('앱은 자동으로 종료되지 않습니다.');
 await hold('update.download');await settings().getByRole('button',{name:'설치 파일 받기',exact:true}).click();await expect(settings().getByRole('status')).toContainText('25%');await expect(toggle()).toBeEnabled();
 await toggle().uncheck();await finish();await expect(settings().getByRole('button',{name:'설치 파일 열기',exact:true})).toHaveCount(0);
 await toggle().check();await settings().getByRole('button',{name:'설치 파일 받기',exact:true}).click();await expect(settings().getByRole('button',{name:'설치 파일 열기',exact:true})).toBeEnabled();
 await hold('update.install');await settings().getByRole('button',{name:'설치 파일 열기',exact:true}).click();await expect(settings().getByRole('status')).toHaveText('설치 파일을 여는 중');await expect(toggle()).toBeDisabled();
 await publish({status:'ready'});await finish();await expect(toggle()).toBeEnabled();await expect(page.getByRole('button',{name:'설정 닫기',exact:true})).toBeVisible();
 assert.equal((await calls()).filter(call=>call.action==='update.install').length,1);assert.equal((await calls()).filter(call=>call.action==='update.apply').length,0);
 pass('Windows 설치 파일 받기·열기 분리와 다운로드 중 전환, 설치 파일 열기 중 잠금');

 await publish({status:'error',errorCode:'installer_failed',error:'Cannot open installer'});await settings().getByRole('button',{name:'설치 파일 열기',exact:true}).click();
 assert.equal((await calls()).filter(call=>call.action==='update.install').length,2);await publish({errorCode:'',error:''});
 pass('Windows 설치 파일 열기 실패 후 다운로드 없이 다시 열기');

 // Compute this offer through the actual updater, not the preceding UI-state
 // stub. Only authenticated-style metadata bytes are simulated; no download,
 // installation, model, global preferences or production IPC backdoor is used.
 await app.evaluate(async({BrowserWindow,ipcMain},{root,testRoot})=>{
  const {createRequire}=await import('node:module'),require=createRequire(root+'/package.json'),{createUpdateManager,RELEASE_API,TEST_RELEASE_API,RELEASES_URL}=require(root+'/electron/updates.cjs'),crypto=require('node:crypto');
  const window=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().startsWith('reviewops://app/')),prior=ipcMain._invokeHandlers.get('reviewops:invoke'),offset=globalThis.testUpdateUiFixture.state.generation+1,arch=process.arch;
  const build={channel:'test',version:'1.7.0',developmentNumber:5,buildNumber:69001,commit:'5'.repeat(40),builtAt:'2026-11-08T10:00:00.000Z'},stableName=`ReviewOps-1.7.0-${arch}.zip`,testName=`ReviewOps-1.7.0-dev-5-${arch}.zip`,legacyName=`ReviewOps-1.7.0-test.69001-${arch}.zip`;
  const item=name=>({name,url:RELEASES_URL+'/download/'+(name===stableName?'v1.7.0':'test-latest')+'/'+name,size:2048,sha256:'a'.repeat(64)}),stableItem=item(stableName),testItem=item(testName),legacyItem=item(legacyName),manifestName='reviewops-test-update-69001-'+build.commit.slice(0,12)+'.json';
  const testBytes=Buffer.from(JSON.stringify({schema:2,channel:'test',version:'1.7.0',build,artifacts:{['darwin-'+arch]:legacyItem},developmentArtifacts:{['darwin-'+arch]:testItem}})),manifestUrl=RELEASES_URL+'/download/test-latest/'+manifestName;
  const stable={tag_name:'v1.7.0',draft:false,prerelease:false,published_at:'2026-11-08T12:00:00Z',assets:[{...stableItem,browser_download_url:stableItem.url},{name:'reviewops-update.json',size:300,browser_download_url:RELEASES_URL+'/download/v1.7.0/reviewops-update.json'}]},test={tag_name:'test-latest',draft:false,prerelease:true,published_at:'2026-10-01T00:00:00Z',body:'<!-- reviewops-test-pointer:'+JSON.stringify({schema:1,buildNumber:69001,commit:build.commit,manifest:manifestName,size:testBytes.length,sha256:crypto.createHash('sha256').update(testBytes).digest('hex')})+' -->',assets:[{...testItem,browser_download_url:testItem.url},{name:manifestName,size:testBytes.length,browser_download_url:manifestUrl,created_at:'2026-11-08T11:00:00Z'}]};
  const observed=globalThis.realUpdateSelectionFixture={requests:[],manager:null},wrapped=state=>({...state,generation:state.generation+offset});
  const manager=createUpdateManager({app:{isPackaged:true,getVersion:()=> '1.7.0',getPath:()=>root+'/ReviewOps.app/Contents/MacOS/ReviewOps',quit:()=>{throw new Error('No fixture app installation')}},dataPath:testRoot+'/actual-manager-data',platform:'darwin',arch,buildInfo:build,shell:{openExternal:async()=>{throw new Error('No fixture external action')}},onChange:state=>window.webContents.send('reviewops:update-state',wrapped(state)),request:async(url,options)=>{
   observed.requests.push(url);if(options.filename)throw new Error('No fixture download');if(url===RELEASE_API)return Buffer.from(JSON.stringify(stable));if(url===TEST_RELEASE_API)return Buffer.from(JSON.stringify(test));if(url===manifestUrl){if(options.expectedHash!==crypto.createHash('sha256').update(testBytes).digest('hex'))throw new Error('Expected pointer hash');return testBytes}if(url.endsWith('/v1.7.0/reviewops-update.json'))return Buffer.from(JSON.stringify({schema:1,version:'1.7.0',artifacts:{['darwin-'+arch]:stableItem}}));throw new Error('Unexpected fixture URL');
  }});observed.manager=manager;await manager.configure({automatic:false});
  ipcMain.removeHandler('reviewops:invoke');ipcMain.handle('reviewops:invoke',async(event,action,payload={})=>{
   if(action==='update.state')return {ok:true,data:wrapped(manager.snapshot())};if(action==='update.configure'||action==='update.check'){const result=action==='update.configure'?await manager.configure(payload):await manager.check();return {ok:true,data:wrapped(result)}}
   if(['update.download','update.install','update.apply'].includes(action))return {ok:false,error:{message:'No fixture installation'}};return prior(event,action,payload);
  });window.webContents.send('reviewops:update-state',wrapped(manager.snapshot()));
 },{root,testRoot});
 await expect(toggle()).not.toBeChecked();await toggle().check();await expect(toggle()).toBeChecked();
 await expect(settings().locator('.update-version-row')).toContainText('설치된 버전 1.7.0-dev-5테스트');await expect(settings().locator('.update-version-row')).toContainText('받을 버전 1.7.0정식');
 const actualSelection=await app.evaluate(()=>({state:globalThis.realUpdateSelectionFixture.manager.snapshot(),requests:globalThis.realUpdateSelectionFixture.requests}));assert.equal(actualSelection.state.availableChannel,'stable');assert.equal(actualSelection.state.testUpdates,true);assert.equal(actualSelection.state.availableBuild,null);assert.equal(actualSelection.requests.length,4);
 pass('실제 업데이트 관리자의 두 공개 정보 비교로 테스트 선택을 유지한 정식 버전 표시');

 await settings().locator('summary').focus();await page.keyboard.press('Enter');await expect(settings().locator('details')).toHaveAttribute('open','');
 await toggle().focus();await page.keyboard.press('Space');await expect(toggle()).not.toBeChecked();await page.keyboard.press('Space');await expect(toggle()).toBeChecked();
 for(const [width,height,theme]of [[850,700,'light'],[1080,800,'dark']]){
  await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('reviewops://app/')).setSize(width,height),{width,height});
  if(theme==='dark')await page.getByRole('button',{name:'어두운 화면',exact:true}).click();
  await settings().locator('summary').scrollIntoViewIfNeeded();
  const bounds=await settings().evaluate(node=>({right:node.getBoundingClientRect().right,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}));assert.ok(bounds.right<=bounds.width+1);assert.equal(bounds.overflow,false);
  await page.screenshot({path:path.join(output,`${width}-${height}-${theme}.png`)});
 }
 pass('키보드로 선택·상세 열기, 두 창 크기와 밝고 어두운 화면의 가로 넘침 검사');

 for(const language of ['en',...Object.keys(catalogs)]){
  await setTestLocale(page,language);await expect(page.locator('.sidebar-bottom button')).not.toHaveCount(0);
  const catalog=language==='en'?english:catalogs[language],label=key=>catalog[key]??english[key]??key;
  await page.locator('.sidebar-bottom').getByRole('button',{name:label('설정'),exact:true}).click();
  await page.locator('.settings-section-menu').getByRole('button',{name:label('자동 확인'),exact:true}).click();
  await expect(settings().getByRole('checkbox',{name:label('테스트 버전 받기'),exact:true})).toBeVisible();
  await expect(settings().locator('summary')).toHaveText(label('자세히 보기'));
  assert.equal(/[가-힣]/.test(await settings().innerText()),false,language+' update text');
 }
 pass('한국어 외 11개 언어의 테스트 버전 선택과 상세 표시 번역');
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 const report={ok:true,checks,actualManagerSelection:actualSelection,rendererErrors:errors,externalRequests:requests,calls:await calls(),dataPath,defaultProfileAccess:false,realDownloads:0,realInstallations:0};
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,checks:checks.length,realDownloads:0,realInstallations:0}));
}catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error}
finally{await app?.close().catch(()=>{})}
