import {setTestLocale} from './test-locale.mjs';
import { selectControl } from './select-control.mjs';
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join('/tmp','reviewops-e2e-'));
const localRoot = path.join(testRoot,'project-files');
const homePath = path.join(testRoot,'home'), configPath = path.join(homePath,'.ssh','config');
fs.mkdirSync(path.dirname(configPath),{recursive:true});fs.writeFileSync(configPath,'# Synthetic test config\n',{mode:0o600});
fs.mkdirSync(localRoot);
fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
fs.writeFileSync(path.join(localRoot,'검토메모.md'),'# 검토 메모\n\n검색 결과와 파일 목록을 검토합니다.\n');
fs.writeFileSync(path.join(localRoot,'화면.html'),'<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;padding:32px;color:#262321;background:#faf8f5}h1{color:#c43d1c}article{padding:24px;background:white;border:1px solid #ddd;border-radius:10px}</style><h1>프로젝트 검토 화면</h1><article><h2>검색 결과</h2><p>검토할 화면의 제목과 목록을 표시합니다.</p><input placeholder="검색어"><button>검색</button></article>');
const backup = path.join(testRoot,'backup.reviewops.json');
let app;
const failures=[], externalRequests=[];
async function launch() {
  const env={...process.env,HOME:homePath,CODEX_HOME:path.join(homePath,'.codex'),REVIEWOPS_CODEX_SSH_CONFIG:configPath,REVIEWOPS_DATA_DIR:path.join(testRoot,'data')};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SSH_AUTH_SOCK;
  app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root], executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});
  const page=await app.firstWindow(); await setTestLocale(page);
  page.setDefaultTimeout(10000);
  await app.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>1;});
  page.on('pageerror',error=>failures.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url()))externalRequests.push(request.url());});
  await page.waitForFunction(()=>!!window.reviewops?.invoke);
  await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
  return page;
}
const ipc=(page,action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const menu=(page,name)=>page.locator('.main-nav').getByRole('button',{name,exact:true});
async function openGroup(page,name,section='프로젝트') {
  await menu(page,'그룹').click();
  await page.getByRole('button',{name:`그룹 열기: ${name}`,exact:true}).click();
  await page.locator('.resource-tabs:visible').getByRole('button',{name:section,exact:true}).click();
}
const editor=(page,name)=>page.getByRole(name.startsWith('그룹 ')?'dialog':'region',{name,exact:true});
try {
  let page=await launch();
  assert.equal((await ipc(page,'snapshot')).groups.length,0);
  await menu(page,'그룹').click();
  await page.getByRole('button',{name:'그룹 등록',exact:true}).click();
  let form=editor(page,'그룹 만들기');
  await form.getByLabel('그룹 이름',{exact:true}).fill('제품 개발');
  await form.getByLabel('설명',{exact:true}).fill('프로젝트와 리뷰 검토');
  await form.getByRole('button',{name:'저장',exact:true}).click();
  await expect(form).toHaveCount(0);
  console.log('PASS: UI 그룹 생성');
  await expect(menu(page,'프로젝트')).toHaveCount(0);
  await expect(menu(page,'서비스')).toHaveCount(0);
  await expect(menu(page,'리뷰')).toHaveCount(0);

  await openGroup(page,'제품 개발');
  await expect(page.getByRole('navigation',{name:'그룹 기능',exact:true}).getByRole('button',{name:'서비스',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'프로젝트 등록',exact:true}).first().click();
  form=editor(page,'프로젝트 등록');
  await form.getByLabel('프로젝트명',{exact:true}).fill('웹사이트 개선');
  await form.getByLabel('설명',{exact:true}).fill('검색 화면과 파일 목록의 사용성을 개선합니다.');
  await selectControl(form.getByLabel('접속 방식',{exact:true}), 'local');
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},localRoot);
  await form.getByRole('button',{name:'선택',exact:true}).click();
  await expect(form.getByLabel('로컬 폴더',{exact:true})).toHaveValue(localRoot);
  await form.getByRole('button',{name:'프로젝트 등록',exact:true}).click();
  await expect(form).toHaveCount(0);
  const createdProject=(await ipc(page,'snapshot')).projects.find(item=>item.name==='웹사이트 개선');
  assert.equal(createdProject.connection.kind,'local');assert.equal(createdProject.connection.rootPath,localRoot);
  console.log('PASS: UI 프로젝트 생성 및 네이티브 작업 폴더 선택');

  await page.getByRole('button',{name:'새 리뷰',exact:true}).first().click();
  form=editor(page,'리뷰 등록');
  await form.getByLabel('제목',{exact:true}).fill('검색 결과에서 파일 이름을 더 명확하게 표시');
  await form.locator('textarea[name="reviewBody"]').fill('검색 결과의 파일 이름과 설명 간격을 조정합니다.\n파일 형식과 수정 날짜를 함께 표시합니다.');
  await form.getByRole('button',{name:'높음',exact:true}).click();
  const snap=await ipc(page,'snapshot');
  await form.getByRole('button',{name:'캡처 안함',exact:true}).click();
  await form.getByRole('button',{name:'등록',exact:true}).click();
  await expect(form).toHaveCount(0);
  const review=(await ipc(page,'snapshot')).reviews[0];
  assert.equal(review.title,'검색 결과에서 파일 이름을 더 명확하게 표시');
  assert.equal(await page.getByRole('tab',{name:'웹사이트 개선',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('button',{name:'작업이력 상태 변경',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'진행',exact:true}).click();
  await page.getByRole('button',{name:'작업이력 보내기',exact:true}).click();
  await expect.poll(async()=>(await ipc(page,'snapshot')).reviews[0].status).toBe('in_progress');
  console.log('PASS: UI 리뷰 생성 및 상태 변경');

  // Comment through the visible composer.
  const composer=page.getByRole('textbox',{name:'작업 내용',exact:true});
  await composer.fill('파일 이름을 먼저 표시하고 수정 날짜는 오른쪽에 배치합니다.');
  await page.getByRole('button',{name:'작업이력 보내기',exact:true}).click();
  await expect.poll(async()=>(await ipc(page,'snapshot')).activities.filter(a=>a.type==='comment').length).toBe(1);
  console.log('PASS: UI 댓글 및 작업 이력');

  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(localRoot,'검토메모.md'));
  const added=await ipc(page,'attachment.add',{reviewId:review.id});
  assert.equal(added.length,1);
  assert.match((await ipc(page,'attachment.read',{id:added[0].id})).content,/검토 메모/);
  const connection=snap.projects.find(item=>item.id===createdProject.id).connection;
  const files=await ipc(page,'files.list',{projectId:createdProject.id,path:''});
  assert.equal(files.entries.length,2);
  await assert.rejects(ipc(page,'files.read',{projectId:createdProject.id,path:'../data/reviewops.sqlite'}),/폴더 밖/);
  assert.equal(review.serviceId,connection.id);
  console.log('PASS: 첨부파일 저장·읽기, 로컬 파일 탐색, 경로 제한');

  // Confirm an untrusted document receives no native bridge.
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.id='untrusted-test';frame.srcdoc='<html>content</html>';frame.sandbox='allow-scripts';document.body.append(frame);});
  const foreign=page.frameLocator('#untrusted-test');
  await expect(foreign.locator('body')).toContainText('content');
  const foreignFrame=page.frames().find(f=>f.url()==='about:srcdoc');
  assert.equal(await foreignFrame.evaluate(()=>typeof window.reviewops),'undefined');
  await page.locator('#untrusted-test').evaluate(e=>e.remove());
  console.log('PASS: 문서 iframe에 native bridge 미노출');

  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},backup);
  await ipc(page,'backup.export');
  const bundle=JSON.parse(fs.readFileSync(backup,'utf8'));
  assert.equal(bundle.data.reviews.length,1); assert.equal(Object.keys(bundle.files).length,1);
  await ipc(page,'review.save',{...review,title:'백업 이후 변경'});
  await page.locator('.workspace-refresh').click();
  await expect(page.getByRole('heading',{name:'백업 이후 변경',exact:true})).toBeVisible();
  await openGroup(page,'제품 개발');
  await page.getByRole('button',{name:'프로젝트 등록',exact:true}).first().click();
  form=editor(page,'프로젝트 등록');
  await form.getByLabel('프로젝트명',{exact:true}).fill('복원 전 작성 중인 프로젝트');
  await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();
  await app.evaluate(({dialog},file)=>{
    globalThis.__reviewopsBackupPickerCalls=0;
    dialog.showOpenDialog=async()=>{globalThis.__reviewopsBackupPickerCalls+=1;return {canceled:false,filePaths:[file]};};
    dialog.showMessageBox=async()=>({response:1});
  },backup);
  await page.getByRole('button',{name:'백업 파일 열기',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('작성 중인 설정을 저장하거나 닫은 뒤 백업을 복원하십시오.');
  assert.equal(await app.evaluate(()=>globalThis.__reviewopsBackupPickerCalls),0);
  assert.equal((await ipc(page,'snapshot')).reviews[0].title,'백업 이후 변경');
  const taskTabs=page.getByRole('tablist',{name:'작업 탭',exact:true});
  await taskTabs.getByRole('tab',{name:'프로젝트 등록',exact:true}).click();
  await expect(form.getByLabel('프로젝트명',{exact:true})).toHaveValue('복원 전 작성 중인 프로젝트');
  await form.getByRole('button',{name:'취소',exact:true}).click();
  await page.getByRole('dialog',{name:'작성 중인 내용',exact:true}).getByRole('button',{name:'변경 내용 버리기',exact:true}).click();
  console.log('PASS: 작성 중인 설정이 있으면 백업 선택창을 열지 않고 자료·입력 유지');

  // Saved project connection editors must also close after a successful restore.
  await openGroup(page,'제품 개발');
  await page.locator('.group-resource-list:visible').getByRole('button',{name:'웹사이트 개선 열기',exact:true}).click();
  await page.locator('.original-project-nav:visible').getByRole('button',{name:'설정',exact:true}).click();
  await page.getByRole('tablist',{name:'프로젝트 설정 항목',exact:true}).getByRole('tab',{name:'연결',exact:true}).click();
  await expect(page.locator('.original-project-settings:visible').getByLabel('로컬 폴더',{exact:true})).toHaveValue(localRoot);
  await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();
  await expect(taskTabs.getByRole('tab',{name:'웹사이트 개선',exact:true})).toHaveCount(1);
  await page.getByRole('button',{name:'백업 파일 열기',exact:true}).click();
  await expect.poll(async()=>(await ipc(page,'snapshot')).reviews[0].title).toBe(review.title);
  await expect(taskTabs.getByRole('tab')).toHaveCount(2);
  assert.deepEqual(await taskTabs.getByRole('tab').evaluateAll(elements=>elements.map(element=>element.getAttribute('aria-label'))),['홈','설정']);
  assert.equal(await app.evaluate(()=>globalThis.__reviewopsBackupPickerCalls),1);
  await expect(page.locator('.original-project-settings')).toHaveCount(0);
  await menu(page,'홈').click();
  await page.locator('.work-home-tree-review').filter({hasText:review.title}).click();
  await expect(page.getByRole('heading',{name:review.title,exact:true})).toBeVisible();
  let restored=await ipc(page,'snapshot');
  assert.equal(restored.reviews[0].title,review.title);
  assert.match((await ipc(page,'attachment.read',{id:restored.attachments[0].id})).content,/검토 메모/);
  assert.equal(fs.readdirSync(path.join(testRoot,'data','recovery')).length,1);
  console.log('PASS: 백업 복원 후 기존 그룹·프로젝트·편집 탭 종료와 복원 전 자료 보존');

  await app.close(); app=null;
  page=await launch();
  restored=await ipc(page,'snapshot');
  assert.equal(restored.reviews.length,1); assert.equal(restored.activities.filter(a=>a.type==='comment').length,1);
  console.log('PASS: 앱 종료·재실행 후 자료 유지');

  await menu(page,'홈').click();
  await page.locator('.work-home-tree-review').filter({hasText:review.title}).click();
  await page.locator('.work-home-node-link').filter({has:page.locator('svg')}).last().click();
  await page.locator('.original-project-nav:visible').getByRole('button',{name:'파일',exact:true}).click();
  await page.getByRole('button',{name:'파일 불러오기',exact:true}).first().click();
  await page.locator('.file-table:visible tbody tr').filter({hasText:'화면.html'}).click();
  await page.getByRole('button',{name:'뷰어에서 열기',exact:true}).click();
  await expect(page.frameLocator('.html-preview').first().getByRole('heading',{name:'프로젝트 검토 화면'})).toBeVisible();
  await page.screenshot({path:path.join(root,'test-results','review-desktop.png'),fullPage:true});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,740));
  await page.screenshot({path:path.join(root,'test-results','review-compact.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth),false);
  console.log('PASS: 1440px / 1000px 화면 캡처 및 가로 넘침 검사');
  assert.deepEqual(failures,[]);
  assert.deepEqual(externalRequests,[]);
  console.log('PASS: 렌더러 오류 없음, 외부 HTTP 요청 없음');
  fs.writeFileSync(path.join(root,'test-results','e2e-result.json'),JSON.stringify({passed:true,executable:process.env.REVIEWOPS_TEST_EXECUTABLE||'development Electron',version:(await ipc(page,'app.info')).version,externalRequests,failures,platform:process.platform,arch:process.arch},null,2));
} catch(error) {
  if(app) {const pages=await app.windows();if(pages[0])await pages[0].screenshot({path:path.join(root,'test-results','failure.png')}).catch(()=>{});}
  throw error;
} finally {
  if(app)await app.close();
  fs.rmSync(testRoot,{recursive:true,force:true});
}
