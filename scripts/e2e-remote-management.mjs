import {_electron as electron, chromium, expect} from '@playwright/test';
import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {X509Certificate,createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

// Feature smoke only: one fresh native profile and an external browser on this
// computer. It establishes neither an installed package nor Mac/Windows pairing.
const root=process.cwd(),temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-remote-management-e2e-')));
const chromeChannel=process.env.REVIEWOPS_E2E_BROWSER_CHANNEL||'chrome';
if(!['chrome','chromium'].includes(chromeChannel))throw new Error('Choose a supported installed test browser.');
const chromeExecutable=chromeChannel==='chrome'&&process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':null;
if(chromeExecutable&&!fs.existsSync(chromeExecutable))throw new Error('The selected Chrome executable is unavailable.');
const dataPath=path.join(temporary,'data'),home=path.join(temporary,'home');
const sshConfig=path.join(temporary,'ssh-config');fs.writeFileSync(sshConfig,'# Isolated feature fixture\n');
const output=path.join(root,'test-results','remote-management',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
fs.mkdirSync(path.join(dataPath,'updates'),{recursive:true});
fs.writeFileSync(path.join(dataPath,'updates/settings.json'),JSON.stringify({automatic:false,intervalMinutes:10}));
const require=createRequire(import.meta.url),{createStore}=require('../electron/store.cjs');
const fixture=createStore({dbPath:path.join(dataPath,'reviewops.sqlite')});
let project,review;
try {
  const group=fixture.saveGroup({name:'Remote Management feature fixture'});
  project=fixture.saveProject({groupId:group.id,name:'Shared feature project'});
  fixture.saveProject({groupId:group.id,name:'Private unapproved project'});
  review=fixture.saveReview({projectId:project.id,title:'Remote review fixture',body:'Original saved review body'});
  fixture.addActivity({reviewId:review.id,body:'Original fixture comment'});
} finally {fixture.close();}
const unusedPort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
const webPort=await unusedPort(),appPort=await unusedPort();
const checks=[],rendererErrors=[];let application,page,browser,browserPage,deviceId,identityAttempted=false,identityCleaned=false,originalExit=null,cleanupError=null;
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const remote=()=>page.locator('.remote-management-settings');
const section=name=>remote().getByRole('region',{name,exact:true});
const refresh=async()=>{await remote().getByRole('button',{name:'상태 새로고침',exact:true}).click();
  await expect(remote().getByRole('button',{name:'상태 새로고침',exact:true})).toBeEnabled();};
const screenshot=async(name,locator)=>{if(locator)await locator.scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(output,name),fullPage:false});};
async function cleanOwnIdentity(){
  if(!application||!identityAttempted||identityCleaned)return;
  const result=await application.evaluate(async({app},{root,dataPath,deviceId})=>{
    const require=process.mainModule.require.bind(process.mainModule);
    if(app.getPath('userData')!==dataPath||app.getAppPath()!==root)throw new Error('Fixture identity owner changed.');
    if(process.platform!=='darwin')return {cleaned:true,backend:'profile-only'};
    const fs=require('node:fs'),path=require('node:path');
    const index=JSON.parse(fs.readFileSync(path.join(dataPath,'remote-device-identity/index.json'),'utf8'));
    if(deviceId&&index.deviceId!==deviceId)throw new Error('Fixture identity changed.');
    if(typeof index.deviceId!=='string'||typeof index.referenceBase64!=='string'||typeof index.payloadSHA256!=='string')
      throw new Error('Fixture cleanup identity is unavailable.');
    const native=require(path.join(root,'electron/remote-device-identity-native.cjs')).loadMacIdentityStorage({appPath:root,packaged:false});
    const reference=Buffer.from(index.referenceBase64,'base64'),digest=Buffer.from(index.payloadSHA256,'hex');
    try{native.remove(reference,digest);return {cleaned:true,backend:'exact-original-native-reference'};}
    finally{reference.fill(0);digest.fill(0);}
  },{root,dataPath,deviceId});
  identityCleaned=result.cleaned===true;
}
try {
  // The OS default file Keychain belongs to the real user home. Isolate the
  // application's data and model/SSH configuration without changing that home.
  const env={...process.env,...isolatedModelRuntime({home,dataPath}),HOME:process.env.HOME,REVIEWOPS_DATA_DIR:dataPath,
    REVIEWOPS_SSH_CONFIG:sshConfig,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig};
  for(const name of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','ELECTRON_EXTRA_LAUNCH_ARGS','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
  application=await electron.launch({args:[root],env,timeout:30000});
  const original=application.process();original.once('exit',(code,signal)=>{originalExit={code,signal};});
  page=await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>rendererErrors.push(error.message));
  await setTestLocale(page);await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1100));
  await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();
  await page.locator('.settings-section-menu').getByRole('button',{name:'원격 관리',exact:true}).click();
  await expect(section('이 컴퓨터 신원').getByText('아직 설정하지 않았습니다.',{exact:true})).toBeVisible();
  let state=await ipc('remoteManagement.state');assert.equal(state.web.enabled,false);assert.equal(state.app.enabled,false);
  checks.push('Fresh Settings shows both incoming listeners off.');
  await section('이 컴퓨터 신원').getByLabel('인증서에 사용할 이 컴퓨터의 IPv4 주소',{exact:true}).fill('127.0.0.1');
  identityAttempted=true;await section('이 컴퓨터 신원').getByRole('button',{name:'컴퓨터 신원 설정',exact:true}).click();
  await expect(section('이 컴퓨터 신원').getByText('이 컴퓨터의 신원을 확인했습니다.',{exact:true})).toBeVisible();
  state=await ipc('remoteManagement.state');assert.equal(state.identity.status,'ready');deviceId=state.identity.identity.deviceId;
  // This factory returns its cached original app/dataPath owner; it cannot
  // create a second provider for this same main process and profile.
  const certificate=await application.evaluate(({app},dataPath)=>{
    const require=process.mainModule.require.bind(process.mainModule);
    return require(app.getAppPath()+'/electron/remote-device-identity.cjs').createRemoteDeviceIdentity({app,dataPath}).publicCertificate();
  },dataPath);
  fs.writeFileSync(path.join(temporary,'public-certificate.crt'),certificate.certificatePEM,{mode:0o600});
  checks.push(`Actual isolated identity initialized using ${state.identity.backend}.`);
  const web=section('브라우저 읽기 연결');await web.getByLabel('수신 IPv4 주소',{exact:true}).fill('127.0.0.1');
  await web.getByLabel('포트',{exact:true}).fill(String(webPort));await web.getByRole('button',{name:'브라우저 연결 켜기',exact:true}).click();
  await expect(web.getByText('브라우저 연결을 받고 있습니다.',{exact:true})).toBeVisible();
  await web.getByRole('button',{name:'브라우저 초대 만들기',exact:true}).click();
  const codes=web.locator('[role=status] dl dd code');await expect(codes).toHaveCount(3);
  const [endpoint,invitationId,secret]=await codes.allTextContents();
  // Explicit test-process trust for this public key only; the OS trust store
  // and default Chromium verification policy are never changed.
  const publicKey=new X509Certificate(certificate.certificatePEM).publicKey.export({type:'spki',format:'der'});
  const spki=createHash('sha256').update(publicKey).digest('base64');
  browser=await chromium.launch({channel:chromeChannel,headless:true,args:[`--ignore-certificate-errors-spki-list=${spki}`]});
  browserPage=await browser.newPage({viewport:{width:1440,height:1000},ignoreHTTPSErrors:false});
  await browserPage.goto(endpoint);await browserPage.getByLabel('Invitation ID',{exact:true}).fill(invitationId);
  await browserPage.getByLabel('One-use secret',{exact:true}).fill(secret);await browserPage.getByLabel('Browser name',{exact:true}).fill('Owned external Chromium');
  await browserPage.getByRole('button',{name:'Request approval',exact:true}).click();
  await expect(browserPage.getByText('Waiting for local approval',{exact:true})).toBeVisible();
  await refresh();const pendingBrowser=section('브라우저 승인 대기').getByRole('group',{name:'Owned external Chromium',exact:true});
  await pendingBrowser.getByRole('checkbox',{name:project.name,exact:true}).check();
  await pendingBrowser.getByRole('button',{name:'선택한 프로젝트 읽기 승인',exact:true}).click();
  await browserPage.getByRole('button',{name:'Check approval',exact:true}).click();
  await expect(browserPage.getByText('Approved for read-only access',{exact:true})).toBeVisible();
  await browserPage.getByLabel('Shared project',{exact:true}).selectOption(project.id);
  await browserPage.getByRole('button',{name:'Refresh reviews',exact:true}).click();
  await browserPage.getByLabel('Review',{exact:true}).selectOption(review.id);
  await browserPage.getByRole('button',{name:'Open or refresh review',exact:true}).click();
  await expect(browserPage.locator('.review-body')).toHaveText(review.body);
  await expect(browserPage.getByText('Original fixture comment',{exact:true})).toBeVisible();
  assert.equal(await browserPage.getByLabel('Shared project',{exact:true}).locator('option').count(),2);
  await browserPage.screenshot({path:path.join(output,'browser-approved.png'),fullPage:false});
  checks.push('External Chromium read the locally approved project, review and history; private project excluded.');
  const appHost=section('ReviewOps 앱 원격 접속');await appHost.getByLabel('앱 수신 IPv4 주소',{exact:true}).fill('127.0.0.1');
  await appHost.getByLabel('앱 접속 포트',{exact:true}).fill(String(appPort));await appHost.getByRole('button',{name:'앱 접속 켜기',exact:true}).click();
  await expect(appHost.getByText('앱 원격 접속을 받고 있습니다.',{exact:true})).toBeVisible();
  await appHost.getByRole('button',{name:'앱 초대 만들기',exact:true}).click();const appSecret=await appHost.locator('.remote-secret').textContent();
  const outgoing=section('다른 PC에 원격 접속');await outgoing.getByLabel('연결 이름',{exact:true}).fill('Owned self connection');
  await outgoing.getByLabel('작업 PC IPv4 주소',{exact:true}).fill('127.0.0.1');await outgoing.getByLabel('포트',{exact:true}).fill(String(appPort));
  await outgoing.getByLabel('작업 PC 공개 인증서',{exact:true}).setInputFiles(path.join(temporary,'public-certificate.crt'));
  await outgoing.getByRole('checkbox',{name:'작업 PC에 표시된 인증서 지문과 일치함을 확인했습니다.',exact:true}).check();
  await outgoing.getByLabel('앱 초대 비밀값',{exact:true}).fill(appSecret);await outgoing.getByRole('button',{name:'원격 접속 추가',exact:true}).click();
  await expect(outgoing.getByText('작업 PC에서 이 앱의 프로젝트 권한을 승인한 뒤 연결 상태를 확인하십시오.',{exact:true})).toBeVisible();
  await refresh();const pendingApp=section('앱 기기와 프로젝트 권한').getByRole('group').filter({hasText:'Owned self connection'});
  await pendingApp.getByRole('checkbox',{name:project.name,exact:true}).check();await pendingApp.getByRole('checkbox',{name:'리뷰 작성',exact:true}).check();
  await pendingApp.getByRole('button',{name:'선택한 권한 승인',exact:true}).click();
  await outgoing.getByRole('button',{name:'공유 프로젝트 불러오기',exact:true}).click();
  await outgoing.getByLabel('원격 프로젝트',{exact:true}).selectOption(project.id);await outgoing.getByRole('button',{name:'리뷰 불러오기',exact:true}).click();
  await outgoing.getByLabel('원격 리뷰',{exact:true}).selectOption(review.id);await outgoing.getByRole('button',{name:'상세·작업 결과 새로고침',exact:true}).click();
  await expect(outgoing.getByLabel('댓글',{exact:true})).toBeEnabled();await outgoing.getByLabel('댓글',{exact:true}).fill('Actual self-connected comment');
  await outgoing.getByRole('button',{name:'원격 댓글 저장',exact:true}).click();
  await expect(outgoing.getByText('작업 PC에서 요청을 처리했습니다. 결과를 새로고침하여 확인하십시오.',{exact:true})).toBeVisible();
  await outgoing.getByRole('button',{name:'상세·작업 결과 새로고침',exact:true}).click();
  await expect(outgoing.getByText('Actual self-connected comment',{exact:true})).toBeVisible();
  const hostSnapshot=await ipc('snapshot');
  assert.equal(hostSnapshot.activities.filter(row=>row.reviewId===review.id&&row.body==='Actual self-connected comment').length,1);
  await screenshot('app-self-connected-comment.png',outgoing.getByRole('heading',{name:'원격 작업 이력',exact:true}));
  checks.push('Real app self-connection required local project write approval and saved one host comment.');
  await section('앱 기기와 프로젝트 권한').getByRole('button',{name:'앱 승인 취소·연결 해제',exact:true}).click();
  await outgoing.getByRole('button',{name:'연결 상태 확인',exact:true}).click();await expect(outgoing.getByRole('alert')).toBeVisible();
  await section('승인한 브라우저').getByRole('button',{name:'이 브라우저 승인 취소',exact:true}).click();
  await browserPage.getByRole('button',{name:'Check connection',exact:true}).click();await expect(browserPage.getByRole('alert')).toBeVisible();
  await web.getByRole('button',{name:'브라우저 연결 끄기',exact:true}).click();await appHost.getByRole('button',{name:'앱 접속 끄기',exact:true}).click();
  state=await ipc('remoteManagement.state');assert.equal(state.web.enabled,false);assert.equal(state.app.enabled,false);
  await screenshot('settings-disabled-after-revocation.png',remote().getByRole('heading',{name:'원격 관리',exact:true}));
  checks.push('Both approvals revoked; browser/app requests refused and both listeners disabled.');
  assert.deepEqual(rendererErrors,[]);
} catch(error) {
  if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:false}).catch(()=>{});
  throw error;
} finally {
  if(browser)await browser.close();
  if(application){
    if(page&&!page.isClosed()){
      const state=await ipc('remoteManagement.state').catch(()=>null);
      for(const [kind,method]of [['web','configureWeb'],['app','configureApp']])if(state?.[kind]?.enabled){
        const current=await ipc('remoteManagement.state');await ipc(`remoteManagement.${method}`,{expectedGeneration:current.generation,
          bindAddress:current[kind].bindAddress,port:current[kind].port,enabled:false}).catch(()=>{});
      }
    }
    try{await cleanOwnIdentity();}catch{cleanupError='OWN_IDENTITY_CLEANUP_UNCONFIRMED';process.exitCode=1;}
    const original=application.process(),exited=originalExit?Promise.resolve():once(original,'exit');
    await application.evaluate(({app})=>{app.quit();}).catch(()=>{});await exited;
    if(originalExit?.code!==0||originalExit?.signal!==null){cleanupError||='ORIGINAL_EXIT_UNCONFIRMED';process.exitCode=1;}
  }
  const result={ok:checks.length===5&&identityCleaned&&cleanupError===null,checks,rendererErrors,identityCleaned,cleanupError,originalExit,output,
    retainedProfile:identityAttempted&&!identityCleaned?temporary:null,
    scope:'Source Electron and external Chromium on one computer; synthetic temporary data; not installed/two-PC/release QA',
    browserTrust:'Explicit public SPKI allowlist in this test Chromium process only; OS trust unchanged'};
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));
  if(!identityAttempted||identityCleaned)fs.rmSync(temporary,{recursive:true,force:true});
  console.log(JSON.stringify(result));
}
