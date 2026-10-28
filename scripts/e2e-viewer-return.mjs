import {setTestLocale} from './test-locale.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const root=process.cwd(),testRoot=fs.mkdtempSync('/tmp/reviewops-viewer-return-');
const homePath=path.join(testRoot,'home'),configPath=path.join(homePath,'.ssh','config');
fs.mkdirSync(path.dirname(configPath),{recursive:true});fs.writeFileSync(configPath,'# Viewer return fixture\n');
const results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
const fixtures=[['preview.png','이미지'],['records.csv','CSV'],['notes.md','Markdown']];
fs.copyFileSync(path.join(root,'public/assets/brand/reviewops-icon-512.png'),path.join(testRoot,'preview.png'));
fs.writeFileSync(path.join(testRoot,'records.csv'),'name,value\nreview,ready');
fs.writeFileSync(path.join(testRoot,'notes.md'),'# Viewer return\n\nREVIEWOPS_VIEWER_RETURN');
const server=http.createServer((request,response)=>{response.writeHead(200,{'content-type':'text/html;charset=utf-8'});response.end('<!doctype html><title>검사 화면</title><style>body{margin:0;padding:20px;background:#dceef2;font:18px sans-serif}</style><h1>검사 화면</h1><input id="draft"><script>window.instance=crypto.randomUUID()</script>')});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const errors=[],checks=[];let app,page,nativeId,browserId;
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const pane=()=>page.locator('.workspace-pane:not([hidden])');
const native=expression=>app.evaluate(({webContents},{id,expression})=>webContents.fromId(id).executeJavaScript(expression,true),{id:nativeId,expression});
const passed=name=>{checks.push(name);console.log(`PASS: ${name}`)};
try{
 const env={...process.env,HOME:homePath,CODEX_HOME:path.join(homePath,'.codex'),REVIEWOPS_CODEX_SSH_CONFIG:configPath,REVIEWOPS_DATA_DIR:path.join(testRoot,'data')};for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>!!window.reviewops?.invoke);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('reviewops://app/')).setSize(1700,1050));
 const group=await ipc('group.save',{name:'뷰어 복귀 검사'}),project=await ipc('project.save',{name:'검사 화면과 첨부 파일',groupId:group.id,connection:{kind:'local',rootPath:testRoot,viewerUrl:origin,viewerWidth:1280,viewerHeight:800,viewerScale:'fit'}}),review=await ipc('review.save',{projectId:project.id,serviceId:project.connection.id,title:'첨부 파일 왕복',body:'서비스 화면과 첨부 파일을 번갈아 엽니다.'});
 await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files})},fixtures.map(([name])=>path.join(testRoot,name)));await ipc('attachment.add',{reviewId:review.id});
 const fileReview=await ipc('review.save',{projectId:project.id,serviceId:project.connection.id,title:'파일이 연결된 리뷰',body:'리뷰 선택으로 파일을 엽니다.',targetPath:'notes.md'});
 await page.locator('.workspace-refresh').click();await page.getByRole('button',{name:`${project.name} 프로젝트 열기`,exact:true}).click();
 const surface=pane().locator('.native-browser-surface');await expect(surface).toHaveAttribute('data-browser-id',/.+/);browserId=await surface.getAttribute('data-browser-id');await expect.poll(async()=>(await ipc('browser.state',{id:browserId})).loading).toBe(false);
 nativeId=await app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(contents=>contents.getURL().startsWith(origin)).id,origin);
 const target=origin+'/inspection?step=2';await pane().getByLabel('뷰어 주소',{exact:true}).fill(target);await pane().getByLabel('뷰어 주소',{exact:true}).press('Enter');await expect.poll(()=>native('location.href')).toBe(target);await expect.poll(async()=>(await ipc('browser.state',{id:browserId})).loading).toBe(false);
 await native('document.querySelector("#draft").value="저장 전 입력"');const instance=await native('window.instance');const history=(await ipc('browser.state',{id:browserId})).canGoBack;assert.equal(history,true);
 await pane().locator('.original-review-table tbody tr').filter({hasText:review.title}).click();await pane().getByRole('tab',{name:'정보',exact:true}).click();
 for(const [name,type]of fixtures){
  await pane().locator('.original-review-attachment-table').getByRole('button',{name,exact:true}).click();const banner=pane().getByRole('region',{name:'열린 파일과 이전 화면',exact:true});await expect(banner).toContainText(`${type} · ${name}`);await expect(banner).toContainText(target);await expect(banner).toContainText('페이지를 새로 불러오지 않고');await expect(surface).toBeHidden();
  if(type==='이미지')await expect(pane().locator('.original-project-preview img')).toBeVisible();else await expect(pane().locator('.original-project-preview .source-preview')).toBeVisible();
  if(type==='Markdown'){await pane().locator('.original-viewer-functions').getByRole('button',{name:'전체화면',exact:true}).click();await expect(pane().locator('.original-browser-address')).toBeHidden();await expect(banner.getByRole('button',{name:'이전 화면으로 돌아가기',exact:true})).toBeVisible();}
  await banner.getByRole('button',{name:'이전 화면으로 돌아가기',exact:true}).click();await expect(surface).toBeVisible();await expect(banner).toHaveCount(0);
  if(type==='Markdown')await pane().locator('.original-viewer-functions').getByRole('button',{name:'전체화면 종료',exact:true}).click();
  await expect(pane().getByLabel('뷰어 주소',{exact:true})).toHaveValue(target);assert.equal(await native('window.instance'),instance);assert.equal(await native('document.querySelector("#draft").value'),'저장 전 입력');assert.equal((await ipc('browser.state',{id:browserId})).canGoBack,history);assert.equal(await surface.getAttribute('data-browser-id'),browserId);
  if(type!=='Markdown')await expect(pane().getByLabel('뷰어 주소',{exact:true})).toBeFocused();
  passed(`${type} 첨부 파일에서 실제 이동한 주소로 복귀하며 페이지·입력·뒤로 가기 유지`);
 }
 await pane().getByRole('button',{name:'리뷰 닫기',exact:true}).click();await pane().locator('.original-review-table tbody tr').filter({hasText:fileReview.title}).click();await expect(pane().getByRole('region',{name:'열린 파일과 이전 화면',exact:true})).toContainText(target);await page.screenshot({path:path.join(results,'viewer-return-file.png'),scale:'css'});await pane().getByRole('button',{name:'파일 닫기',exact:true}).click();await expect(pane().getByLabel('뷰어 주소',{exact:true})).toHaveValue(target);assert.equal(await native('window.instance'),instance);assert.equal(await native('document.querySelector("#draft").value'),'저장 전 입력');passed('리뷰 선택으로 열린 파일도 닫기 버튼으로 같은 화면에 복귀');
 await pane().getByRole('button',{name:'뒤로',exact:true}).click();await expect.poll(()=>native('location.href')).toBe(origin+'/');await pane().getByRole('button',{name:'앞으로',exact:true}).click();await expect.poll(()=>native('location.href')).toBe(target);passed('파일을 닫은 후 뒤로·앞으로 이동');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(results,'viewer-return.json'),JSON.stringify({passed:true,version:(await ipc('app.info')).version,checks,errors,testRoot,target},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,testRoot}));
}catch(error){await page?.screenshot({path:path.join(results,'viewer-return-failure.png')}).catch(()=>{});console.error('VIEWER_RETURN_FAILURE',testRoot,error);throw error}finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})}server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
