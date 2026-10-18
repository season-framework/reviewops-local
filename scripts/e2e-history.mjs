import {setTestLocale} from './test-locale.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),{createStore}=require('../electron/store.cjs');
const root=process.cwd(),testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-history-ui-'));
const dataPath=path.join(testRoot,'data'),screenshots=path.join(testRoot,'screenshots');fs.mkdirSync(screenshots);
const filename='검색 결과 화면의 키보드 이동 및 파일 이름 표시 검토 내용.md';
const document=path.join(testRoot,filename),image=path.join(testRoot,'검색 화면.png');
fs.writeFileSync(document,'# 검색 화면\n\n방향키로 검색 결과를 이동하고 파일 이름을 두 줄까지 표시합니다.\n');
let app,page;const errors=[],requests=[],checks=[],layouts=[];
const passed=name=>{checks.push(name);console.log(`PASS: ${name}`);};
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const pane=()=>page.locator('.workspace-pane:not([hidden])');
const capture=message=>({capturedAt:new Date().toISOString(),console_log:[{level:'info',message}],fingerprint_log:{userAgent:'history-fixture'}});
const assertUniformMessages=async(timeline,theme,context)=>{
  const layout=await timeline.evaluate(el=>{
    const rect=el.getBoundingClientRect(),composer=el.closest('.original-review-panel').querySelector('.original-review-composer-shell'),composerRect=composer.getBoundingClientRect();
    const messages=[...el.querySelectorAll('.review-chat-message')].filter(message=>message.querySelector('.review-chat-bubble')).map(message=>{
      const bubble=message.querySelector('.review-chat-bubble'),messageRect=message.getBoundingClientRect(),bubbleRect=bubble.getBoundingClientRect(),style=getComputedStyle(bubble);
      return {left:messageRect.left,right:messageRect.right,width:messageRect.width,bubbleLeft:bubbleRect.left,bubbleRight:bubbleRect.right,bubbleWidth:bubbleRect.width,background:style.backgroundColor,border:style.borderColor,radius:style.borderRadius};
    });
    return {left:rect.left,right:rect.right,width:rect.width,maxWidth:getComputedStyle(el).maxWidth,composer:{left:composerRect.left,right:composerRect.right,width:composerRect.width,maxWidth:getComputedStyle(composer).maxWidth},messages};
  });
  layouts.push({theme,context,...layout});
  for(const key of ['left','right','width'])assert.ok(Math.abs(layout[key]-layout.composer[key])<1,`${context}/${theme}: 작업이력과 입력창 ${key} 일치 (${layout[key]} / ${layout.composer[key]})`);
  assert.equal(layout.maxWidth,'960px');assert.equal(layout.composer.maxWidth,'960px');
  assert.ok(layout.width<=960,`${context}/${theme}: 작업이력 최대 너비 960px`);
  if(context==='home-1440'||context==='home-1920')assert.equal(Math.round(layout.width),960,`${context}/${theme}: 넓은 화면의 작업이력 너비`);
  assert.ok(layout.messages.length>=3,`${theme}: 등록·사용자·에이전트 메시지`);
  const first=layout.messages[0];
  for(const message of layout.messages) {
    assert.ok(Math.abs(message.width-layout.width)<2,`${theme}: 메시지 전체 너비`);
    assert.ok(Math.abs(message.left-layout.left)<2,`${theme}: 메시지 시작 위치`);
    assert.ok(Math.abs(message.bubbleWidth-layout.width)<2,`${theme}: 본문 전체 너비`);
    assert.ok(Math.abs(message.bubbleLeft-layout.left)<2,`${theme}: 본문 시작 위치`);
    assert.ok(Math.abs(message.bubbleRight-layout.composer.right)<1,`${theme}: 본문과 입력창 끝 위치`);
    assert.equal(message.background,first.background,`${theme}: 메시지 배경 통일`);
    assert.equal(message.border,first.border,`${theme}: 메시지 테두리 통일`);
    assert.equal(message.radius,first.radius,`${theme}: 메시지 모양 통일`);
  }
  assert.equal(first.background,theme==='light'?'rgb(255, 255, 255)':'rgb(33, 30, 27)',`${theme}: 기본 화면 배경`);
};
try {
  const env={...process.env,REVIEWOPS_DATA_DIR:dataPath};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});
  page=await app.firstWindow(); await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1050));
  await page.waitForFunction(()=>!!window.reviewops?.invoke);
  const group=await ipc('group.save',{name:'제품 개발'});
  const service=await ipc('service.save',{groupId:group.id,name:'검색 화면',kind:'local',rootPath:testRoot});
  const project=await ipc('project.save',{groupId:group.id,name:'검색 화면 개선',serviceIds:[service.id]});
  await page.screenshot({path:image});
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},image);
  const initialImage=await ipc('attachment.stage');
  const review=await ipc('review.save',{projectId:project.id,serviceId:service.id,title:'검색 결과의 이름과 작업 상태 표시',body:'검색 결과에서 파일 이름과 형식을 구분합니다.\n키보드로 항목을 선택할 수 있도록 수정하십시오.',evidence:capture('등록 시 저장한 로그'),attachmentTokens:initialImage.map(file=>file.token)});
  await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},[image,document]);
  const staged=await ipc('attachment.stage');
  const user=await ipc('activity.add',{reviewId:review.id,body:'검색 화면과 검토 내용을 첨부합니다.\n**파일 이름**은 두 줄까지 표시합니다.',attachmentTokens:staged.map(file=>file.token),evidence:capture('작업 내용과 함께 저장한 로그')});
  await ipc('activity.add',{reviewId:review.id,status:'in_progress'});
  // Only this disposable test database is used to seed a completed agent response.
  const store=createStore({dbPath:path.join(dataPath,'reviewops.sqlite')});
  try {
    store.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'검색 입력과 키보드 이동을 수정하십시오.',status:'completed',workPath:testRoot,sessionScope:'fixture-scope',sessionId:'fixture-thread',response:'검색어 유지와 방향키 이동을 적용했습니다.\n\n- 파일 이름과 형식을 분리했습니다.\n- Enter 키로 선택한 항목을 엽니다.\n\n```js\nconst preserveSearch = true;\n```'});
  } finally {store.close();}
  const agentActivity=(await ipc('snapshot')).activities.find(item=>item.reviewId===review.id&&item.role==='agent');
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},document);
  await ipc('attachment.add',{reviewId:review.id,activityId:agentActivity.id});
  await page.reload();
  const home=page.locator('.work-home');
  await home.locator(`[data-tree-node="r-${review.id}"]`).click();
  const timeline=home.getByRole('list',{name:'작업이력 대화',exact:true});
  await expect(timeline.locator('.review-chat-message')).toHaveCount(3);
  await expect(timeline.locator('.review-chat-event')).toHaveCount(1);
  await expect(timeline.locator('.is-request')).toContainText('리뷰 등록');
  await expect(timeline.locator('.is-user')).toContainText('사용자');
  await expect(timeline.locator('.is-agent')).toContainText('에이전트');
  await expect(timeline.locator('.is-agent').getByRole('button',{name:'작업이력 편집'})).toHaveCount(0);
  await expect(timeline.locator('.is-agent pre code')).toContainText('const preserveSearch = true;');
  await expect(timeline.locator('.is-request .review-chat-attachments')).toContainText('첨부 파일 2개');
  await timeline.locator('.is-agent').getByRole('button',{name:`${filename} 열기`,exact:true}).click();
  await expect(page.getByRole('dialog',{name:filename,exact:true}).locator('.source-preview')).toContainText('방향키로 검색 결과를 이동');
  await page.keyboard.press('Escape');
  passed('리뷰 등록·사용자·에이전트 메시지와 상태 변경을 구분하고 응답 서식을 유지');

  const message=timeline.locator(`[data-activity-id="${user.id}"]`);
  await expect(message.getByLabel('메시지 첨부 파일',{exact:true})).toContainText('첨부 파일 3개');
  await expect(message.locator('.review-chat-bubble .review-chat-attachments,.review-chat-bubble img,.review-chat-bubble .review-chat-file-list')).toHaveCount(0);
  await expect(timeline.getByRole('img')).toHaveCount(0);
  const imageButton=message.getByRole('button',{name:'검색 화면.png 열기',exact:true});
  await imageButton.focus();await imageButton.press('Enter');
  await expect(page.getByRole('dialog',{name:'검색 화면.png',exact:true}).getByRole('img',{name:'검색 화면.png',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(imageButton).toBeFocused();
  await message.getByRole('button',{name:`${filename} 열기`,exact:true}).click();
  const documentDialog=page.getByRole('dialog',{name:filename,exact:true});
  await expect(documentDialog.locator('.source-preview')).toContainText('방향키로 검색 결과를 이동');
  const saved=path.join(testRoot,'saved.md');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},saved);
  await documentDialog.getByRole('button',{name:`${filename} 저장`,exact:true}).click();
  await expect.poll(()=>fs.existsSync(saved)).toBe(true);assert.equal(fs.readFileSync(saved,'utf8'),fs.readFileSync(document,'utf8'));
  await documentDialog.getByRole('button',{name:`${filename} 삭제`,exact:true}).click();
  await page.getByRole('dialog',{name:'첨부 파일 삭제',exact:true}).getByRole('button',{name:'취소',exact:true}).click();
  await expect(documentDialog).toBeVisible();
  await documentDialog.getByRole('button',{name:'닫기',exact:true}).click();
  await expect(message.getByRole('button',{name:`${filename} 열기`,exact:true})).toBeFocused();
  await timeline.locator('.is-request').getByRole('button',{name:'리뷰 등록 로그 열기',exact:true}).click();
  let logs=page.getByRole('dialog',{name:'리뷰 등록 로그',exact:true});
  await expect(logs.getByRole('tabpanel')).toContainText('등록 시 저장한 로그');
  await expect(logs.getByRole('tabpanel')).not.toContainText('작업 내용과 함께 저장한 로그');
  await logs.getByRole('button',{name:'닫기',exact:true}).click();
  await message.getByRole('button',{name:'작업이력 로그 열기',exact:true}).click();
  logs=page.getByRole('dialog',{name:'작업이력 로그',exact:true});
  await expect(logs.getByRole('tabpanel')).toContainText('작업 내용과 함께 저장한 로그');
  await logs.getByRole('tab',{name:/환경/}).click();await expect(logs.getByRole('tabpanel')).toContainText('history-fixture');
  await page.keyboard.press('Escape');
  await expect(home.getByRole('tab',{name:'작업이력',exact:true})).toHaveAttribute('aria-selected','true');
  passed('본문 밖의 작은 첨부 버튼으로 이미지·문서·메시지별 로그를 팝업에서 열고 저장·삭제 취소·키보드 초점 유지');

  await message.getByRole('button',{name:'작업이력 편집',exact:true}).click();
  await message.getByRole('textbox',{name:'작업이력 수정 내용',exact:true}).fill('검토한 화면과 파일을 첨부합니다. 파일 이름은 두 줄까지 표시합니다.');
  await message.getByRole('button',{name:'저장',exact:true}).click();
  await expect(message).toContainText('검토한 화면과 파일을 첨부합니다.');
  assert.equal((await ipc('snapshot')).attachments.filter(file=>file.activityId===user.id).length,2);
  await home.getByRole('textbox',{name:'작업 내용',exact:true}).fill('수정된 화면을 검토하겠습니다.');
  await home.getByRole('textbox',{name:'작업 내용',exact:true}).press('Meta+Enter');
  await expect.poll(async()=>(await ipc('snapshot')).activities.filter(item=>item.type==='comment').length).toBe(3);
  await expect(home.getByRole('textbox',{name:'작업 내용',exact:true})).toHaveValue('');
  passed('메시지 편집 시 첨부파일 유지, 단축키 전송과 입력 내용 지우기');

  const logsOnly=await ipc('activity.add',{reviewId:review.id,body:'',evidence:capture('본문 없는 로그')});
  await page.locator('.workspace-refresh').click();
  const logsMessage=timeline.locator(`[data-activity-id="${logsOnly.id}"]`);
  await expect(logsMessage.locator('.review-chat-bubble')).toHaveCount(0);
  await logsMessage.getByRole('button',{name:'작업이력 로그 열기',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'작업이력 로그',exact:true}).getByRole('tabpanel')).toContainText('본문 없는 로그');
  await page.keyboard.press('Escape');
  passed('본문 없이 저장한 로그는 빈 본문을 만들지 않고 첨부 버튼으로 표시');

  for(const theme of ['light','dark']) {
    if(theme==='dark')await page.getByRole('button',{name:'어두운 화면',exact:true}).click();
    await home.locator('.original-review-history-scroll').evaluate(el=>{el.scrollTop=0;});
    await expect(page.locator('.toast[role="status"]')).toHaveCount(0);
    const contrast=await timeline.locator('.is-agent .original-review-markdown').evaluate(el=>{
      const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
      const luminance=values=>values.map(value=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,index)=>sum+c*[.2126,.7152,.0722][index],0);
      const text=luminance(rgb(getComputedStyle(el).color)),background=luminance(rgb(getComputedStyle(el.closest('.review-chat-bubble')).backgroundColor));
      return (Math.max(text,background)+.05)/(Math.min(text,background)+.05);
    });
    assert.ok(contrast>=4.5,`${theme} message contrast ${contrast}`);
    await expect.poll(()=>timeline.locator('.review-chat-attachment-button').first().evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(theme==='light'?'rgb(255, 255, 255)':'rgb(33, 30, 27)');
    await assertUniformMessages(timeline,theme,'home-1440');
    await page.screenshot({path:path.join(screenshots,`history-${theme}.png`)});
    await timeline.locator('.is-agent').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(screenshots,`history-conversation-${theme}.png`)});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1920,1050));
    await expect.poll(()=>home.locator('.original-review-panel').evaluate(el=>Math.round(el.getBoundingClientRect().width))).toBeGreaterThan(1100);
    await assertUniformMessages(timeline,theme,'home-1920');
    await page.screenshot({path:path.join(screenshots,`history-wide-${theme}.png`)});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1050));
    await expect.poll(()=>home.locator('.original-review-panel').evaluate(el=>Math.round(el.getBoundingClientRect().width))).toBeLessThan(1100);
  }
  passed('1440·1920px 창에서 작업이력과 하단 입력창의 좌우 위치·960px 최대 너비를 맞추고 동일한 메시지 배경 유지');

  await page.getByRole('button',{name:'밝은 화면',exact:true}).click();
  await page.getByRole('button',{name:`${project.name} 프로젝트 열기`,exact:true}).click();
  await pane().locator('.original-review-table tbody tr').filter({hasText:review.title}).click();
  const divider=pane().getByRole('separator',{name:'작업 영역 너비',exact:true});await divider.focus();
  for(let i=0;i<6;i++)await divider.press('ArrowRight');
  assert.equal(Number(await divider.getAttribute('aria-valuenow')),420);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1240,900));
  const panel=pane().locator('.original-review-panel');
  await panel.locator('.original-review-history-scroll').evaluate(el=>{el.scrollTop=0;});
  assert.equal(await panel.evaluate(el=>el.scrollWidth>el.clientWidth),false);
  const overflow=await panel.locator('.review-chat-message,.review-chat-bubble,.review-chat-attachment-button').evaluateAll(elements=>elements.filter(el=>el.scrollWidth>el.clientWidth+1).length);
  assert.equal(overflow,0);
  await expect(panel.getByRole('textbox',{name:'작업 내용',exact:true})).toBeVisible();
  await assertUniformMessages(panel.getByRole('list',{name:'작업이력 대화',exact:true}),'light','project-420');
  await page.screenshot({path:path.join(screenshots,'history-compact.png')});
  await page.getByRole('button',{name:'어두운 화면',exact:true}).click();
  await assertUniformMessages(panel.getByRole('list',{name:'작업이력 대화',exact:true}),'dark','project-420');
  await page.screenshot({path:path.join(screenshots,'history-compact-dark.png')});
  await panel.locator('.is-agent').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(screenshots,'history-compact-conversation-dark.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,780));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await expect(panel.getByRole('textbox',{name:'작업 내용',exact:true})).toBeVisible();
  passed('420px 작업 영역에서 긴 파일명·첨부 카드·입력창 가로 넘침 없음');
  const agentMessage=panel.locator(`[data-activity-id="${agentActivity.id}"]`);
  await agentMessage.getByRole('button',{name:`${filename} 열기`,exact:true}).click();
  const projectPreview=page.getByRole('dialog',{name:filename,exact:true});
  await expect(projectPreview.locator('.source-preview')).toContainText('방향키로 검색 결과를 이동');
  await page.screenshot({path:path.join(screenshots,'history-file-popup-dark.png')});
  await projectPreview.getByRole('button',{name:`${filename} 삭제`,exact:true}).click();
  await page.getByRole('dialog',{name:'첨부 파일 삭제',exact:true}).getByRole('button',{name:'삭제',exact:true}).click();
  await expect(projectPreview).toBeHidden();
  await expect(agentMessage.getByRole('button',{name:`${filename} 열기`,exact:true})).toHaveCount(0);
  const afterDelete=await ipc('snapshot');
  assert.equal(afterDelete.attachments.filter(file=>file.activityId===agentActivity.id).length,0);
  assert.equal(afterDelete.attachments.filter(file=>file.activityId===user.id).length,2);
  assert.ok(afterDelete.activities.find(item=>item.id===agentActivity.id).body.includes('const preserveSearch = true;'));
  passed('프로젝트 작업이력에서도 파일을 팝업으로 열고 삭제하며 다른 메시지의 파일과 본문 유지');
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  const result={ok:true,executable:process.env.REVIEWOPS_TEST_EXECUTABLE||'development',testRoot,screenshots,checks,layouts,rendererErrors:errors,externalRequests:requests};
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/history-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} catch(error) {
  if(page)await page.screenshot({path:path.join(screenshots,'failure.png')}).catch(()=>{});
  console.error('HISTORY UI FAILURE',testRoot,error);process.exitCode=1;
} finally {
  if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(win=>win.destroy())).catch(()=>{});await app.close().catch(()=>{});}
}
