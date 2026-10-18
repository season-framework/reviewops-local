import {setTestLocale} from './test-locale.mjs';
import {_electron as electron, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// All records, files, and CLI responses in this test are synthetic and isolated.
const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join('/tmp', 'reviewops-deletion-'));
const dataPath = path.join(testRoot, 'data');
const homePath=path.join(testRoot,'home'),sshConfig=path.join(homePath,'.ssh','config');
fs.mkdirSync(path.dirname(sshConfig),{recursive:true});fs.writeFileSync(sshConfig,'# Synthetic deletion fixture\n',{mode:0o600});
const work = path.join(testRoot, 'work');
const results = path.join(root, 'test-results');
for (const directory of [work, results]) fs.mkdirSync(directory, {recursive:true});
const binary = path.join(testRoot, 'fixture-codex');
fs.writeFileSync(binary, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli synthetic-deletion');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const send=event=>console.log(JSON.stringify(event));
 send({type:'thread.started',thread_id:'synthetic-deletion-'+process.pid});
 send({type:'turn.started'});
 send({type:'item.completed',item:{id:'answer',type:'agent_message',text:'삭제 검사에 사용할 합성 작업이력입니다.'}});
 send({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
});
`, {mode:0o755});
const errors = [], network = [], checks = [];
let app, page;
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
const pane = () => page.locator('.workspace-pane:not([hidden])');
const tasks = () => page.getByRole('tablist', {name:'작업 탭', exact:true});
const task = name => tasks().getByRole('tab', {name, exact:true});
const dialog = noun => page.getByRole('dialog', {name:`${noun} 삭제`, exact:true});
const invoke = (action, payload = {}) => page.evaluate(({action, payload}) => window.reviewops.invoke(action, payload), {action, payload});
const snapshot = () => invoke('snapshot');
const refresh = () => page.locator('.workspace-refresh').click();
const primary = name => page.locator('.main-nav').getByRole('button', {name, exact:true});
async function openGroup(group, section = '프로젝트') {
  await primary('그룹').click();
  await page.getByRole('button', {name:`그룹 열기: ${group.name}`, exact:true}).click();
  await pane().getByRole('navigation', {name:'그룹 기능', exact:true}).getByRole('button', {name:section, exact:true}).click();
}
async function openProject(project) {
  await primary('홈').click();
  await page.getByRole('button', {name:`${project.name} 프로젝트 열기`, exact:true}).click();
  await expect(task(project.name)).toHaveAttribute('aria-selected', 'true');
}
async function projectDelete(project) {
  await task(project.name).last().click();
  await pane().getByRole('navigation', {name:'프로젝트 기능', exact:true}).getByRole('button', {name:'설정', exact:true}).click();
  await pane().getByRole('tablist', {name:'프로젝트 설정 항목', exact:true}).getByRole('tab', {name:'기타', exact:true}).click();
  await pane().getByRole('button', {name:'프로젝트 삭제', exact:true}).click();
  await expect(dialog('프로젝트')).toBeVisible();
}
async function groupDelete(group) {
  await openGroup(group, '설정');
  await expect(pane().getByLabel('삭제 확인', {exact:false})).toHaveCount(0);
  await pane().getByRole('button', {name:'그룹 삭제', exact:true}).click();
  await expect(dialog('그룹')).toBeVisible();
}
const stateRows = state => Object.fromEntries(['groups','projects','services','reviews','activities','attachments'].map(key => [key,state[key]]));
async function authorizeDeletion(noun, name, {checkInvalid = false, previousName = ''} = {}) {
  const input = dialog(noun).getByRole('textbox', {name:'삭제 확인', exact:true});
  const remove = dialog(noun).getByRole('button', {name:'삭제', exact:true});
  await expect(input).toHaveCount(1);
  await expect(input).toHaveValue('');
  await expect(remove).toBeDisabled();
  await expect(dialog(noun).getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  if (checkInvalid) {
    for (const invalid of ['', '다른 이름', '   ', ` ${name}`, `${name} `, ...(previousName ? [previousName] : [])]) {
      await input.fill(invalid);
      await expect(remove).toBeDisabled();
      await input.press('Enter');
      await expect(dialog(noun)).toBeVisible();
    }
  }
  await input.fill(name);
  await expect(remove).toBeEnabled();
}
async function seedReview(project, service, name) {
  const file = path.join(work, `${name}.txt`);
  fs.writeFileSync(file, `SYNTHETIC_${name}_ATTACHMENT`);
  const staged = await invoke('attachment.stageFiles', {paths:[file]});
  const review = await invoke('review.save', {projectId:project.id, serviceId:service.id, title:name, body:'삭제 화면 검사에 사용하는 리뷰입니다.', attachmentTokens:staged.map(item=>item.token)});
  await invoke('activity.add', {reviewId:review.id, body:`${name}의 보존할 작업이력`});
  const run = await invoke('agent.start', {reviewId:review.id, prompt:'합성 작업이력 생성', requestId:crypto.randomUUID()});
  await expect.poll(async () => (await invoke('agent.list', {reviewId:review.id})).find(item=>item.id===run.id)?.status, {timeout:15000}).toBe('completed');
  return review;
}
const reviewDraftKeys = review => ['reviewops.agent.draft.','reviewops.review.edit.','reviewops.draft.','reviewops.comment.'].map(prefix=>prefix+review.id);
const projectDraftKeys = project => [`reviewops.review.create.${project.id}`,`reviewops.draft.create-${project.id}`,`reviewops.comment.create-${project.id}`];
async function stored(keys) { return page.evaluate(keys=>Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)])), keys); }
async function assertDraftsRemoved(keys) { assert.ok(Object.values(await stored(keys)).every(value=>value===null), '삭제한 항목의 초안이 남아 있습니다.'); }

try {
  const env = {...process.env, HOME:homePath, CODEX_HOME:path.join(homePath,'.codex'), REVIEWOPS_CODEX_SSH_CONFIG:sshConfig, REVIEWOPS_DATA_DIR:dataPath}; for(const name of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
  app = await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root], executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout:30000});
  page = await app.firstWindow(); await setTestLocale(page); page.setDefaultTimeout(10000);
  page.on('pageerror', error=>errors.push(error.message));
  page.on('request', request=>{if(/^https?:/.test(request.url()))network.push(request.url());});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1600,1000));
  await page.waitForFunction(()=>!!window.reviewops?.invoke);
  await expect(page.getByRole('heading', {name:'홈', exact:true})).toBeVisible();
  const group = await invoke('group.save', {name:'삭제할 그룹'});
  const otherGroup = await invoke('group.save', {name:'보존할 다른 그룹'});
  const createService = (owner,name) => invoke('service.save', {groupId:owner.id,name,kind:'local',rootPath:work,agentWorkPath:work,agentEnabled:true,agentBinary:binary});
  const shared = await createService(group,'함께 사용하는 서비스');
  const removable = await createService(group,'연결 해제 후 삭제할 서비스');
  const otherService = await createService(otherGroup,'다른 그룹 서비스');
  const project = await invoke('project.save', {groupId:group.id,name:'리뷰와 함께 삭제할 프로젝트',serviceIds:[shared.id]});
  const remaining = await invoke('project.save', {groupId:group.id,name:'그룹 삭제까지 유지할 프로젝트',serviceIds:[shared.id,removable.id]});
  const otherProject = await invoke('project.save', {groupId:otherGroup.id,name:'다른 그룹 프로젝트',serviceIds:[otherService.id]});
  const review = await seedReview(project,shared,'프로젝트 삭제 대상 리뷰');
  const keptReview = await seedReview(remaining,removable,'그룹 삭제 대상 리뷰');
  const otherReview = await seedReview(otherProject,otherService,'다른 그룹 리뷰');
  const baseline = await snapshot();
  const attachmentPath = file => path.join(dataPath,'attachments',file.storageName);
  for (const file of baseline.attachments) assert.equal(fs.existsSync(attachmentPath(file)),true);
  const pendingFile = path.join(work,'삭제할 초안 첨부.txt');fs.writeFileSync(pendingFile,'SYNTHETIC_DRAFT_ATTACHMENT');
  const [pending] = await invoke('attachment.stageFiles', {paths:[pendingFile]});
  await page.evaluate(({review,keptReview,otherReview,project,remaining,otherProject,pending})=>{
    for(const item of [review,keptReview,otherReview]) {
      localStorage.setItem(`reviewops.agent.draft.${item.id}`,JSON.stringify({prompt:'저장하지 않은 에이전트 요청',pending:item.id===review.id?[pending]:[],requestId:`draft-${item.id}`}));
      localStorage.setItem(`reviewops.review.edit.${item.id}`,JSON.stringify({title:item.title,body:'저장하지 않은 리뷰 본문',priority:'normal',category:'ux'}));
      localStorage.setItem(`reviewops.draft.${item.id}`,'저장하지 않은 작업 내용');
      localStorage.setItem(`reviewops.comment.${item.id}`,'이전 형식 작업 초안');
    }
    for(const item of [project,remaining,otherProject])for(const key of [`reviewops.review.create.${item.id}`,`reviewops.draft.create-${item.id}`,`reviewops.comment.create-${item.id}`])localStorage.setItem(key,'삭제할 프로젝트의 작성 초안');
    localStorage.setItem('reviewops.home.favorites',JSON.stringify([project.id,remaining.id,otherProject.id]));
  },{review,keptReview,otherReview,project,remaining,otherProject,pending});
  await refresh();
  await page.locator(`[data-tree-node="r-${review.id}"]`).click();
  await expect(page.locator('.work-home').getByRole('textbox',{name:'작업 내용',exact:true})).toHaveValue('저장하지 않은 작업 내용');
  await openProject(otherProject);
  await openProject(project);
  await page.getByRole('button',{name:'새 작업 탭',exact:true}).click();
  await expect(task(project.name)).toHaveCount(2);
  const deletedDrafts = [...reviewDraftKeys(review),...projectDraftKeys(project)];
  const retainedDrafts = [...reviewDraftKeys(keptReview),...projectDraftKeys(remaining),...reviewDraftKeys(otherReview),...projectDraftKeys(otherProject)];
  const beforeDrafts = await stored([...deletedDrafts,...retainedDrafts]);
  await projectDelete(project);
  await authorizeDeletion('프로젝트',project.name,{checkInvalid:true});
  await expect(dialog('프로젝트')).toContainText('프로젝트의 연결 설정, 리뷰, 작업이력과 첨부 파일을 모두 삭제합니다.');
  await page.screenshot({path:path.join(results,'deletion-project-confirm.png')});
  await dialog('프로젝트').getByRole('button',{name:'취소',exact:true}).click();
  assert.deepEqual(stateRows(await snapshot()),stateRows(baseline));
  assert.deepEqual(await stored([...deletedDrafts,...retainedDrafts]),beforeDrafts);
  for(const file of baseline.attachments)assert.equal(fs.existsSync(attachmentPath(file)),true);
  passed('프로젝트 이름의 빈 값·다른 이름·공백 입력을 거절하고 정확히 입력한 뒤 취소하면 자료와 초안을 유지');

  await projectDelete(project);
  await authorizeDeletion('프로젝트',project.name);
  await dialog('프로젝트').getByRole('button',{name:'삭제',exact:true}).click();
  await expect(dialog('프로젝트')).toHaveCount(0);
  const afterProject = await snapshot();
  assert.ok(!afterProject.projects.some(item=>item.id===project.id));
  assert.ok(!afterProject.reviews.some(item=>item.id===review.id));
  assert.ok(!afterProject.activities.some(item=>item.reviewId===review.id));
  assert.ok(!afterProject.attachments.some(item=>item.reviewId===review.id));
  assert.deepEqual((await invoke('agent.list')).filter(item=>item.reviewId===review.id),[]);
  assert.equal(afterProject.services.length,3);
  assert.ok(afterProject.projects.find(item=>item.id===remaining.id).serviceIds.includes(shared.id));
  for(const file of baseline.attachments.filter(item=>item.reviewId===review.id))assert.equal(fs.existsSync(attachmentPath(file)),false);
  await expect(task(project.name)).toHaveCount(0);
  await expect(task(otherProject.name)).toHaveCount(1);
  await assertDraftsRemoved(deletedDrafts);
  assert.deepEqual(await stored(retainedDrafts),Object.fromEntries(retainedDrafts.map(key=>[key,beforeDrafts[key]])));
  assert.equal(await page.evaluate(()=>localStorage.getItem('reviewops.home.selected')),null);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('reviewops.home.favorites'))),[remaining.id,otherProject.id]);
  await expect.poll(async()=> (await invoke('attachment.staged',{tokens:[pending.token]})).expiredTokens).toEqual([pending.token]);
  await expect(page.getByRole('dialog',{name:'작성 중인 내용',exact:true})).toHaveCount(0);
  passed('프로젝트의 리뷰·작업이력·실행 기록·첨부 파일·탭·초안을 삭제하고 다른 프로젝트 유지');

  const keptActivities=afterProject.activities.filter(item=>item.reviewId===keptReview.id);
  const keptAttachments=afterProject.attachments.filter(item=>item.reviewId===keptReview.id);
  const keptRuns=await invoke('agent.list',{reviewId:keptReview.id});
  assert.ok(keptActivities.length>0&&keptAttachments.length>0&&keptRuns.length>0);
  for(const file of keptAttachments)assert.equal(fs.existsSync(attachmentPath(file)),true);
  assert.deepEqual(await stored(retainedDrafts),Object.fromEntries(retainedDrafts.map(key=>[key,beforeDrafts[key]])));
  passed('프로젝트 삭제 후 다른 프로젝트의 리뷰·대화·실행 기록·첨부와 초안 유지');

  await openProject(remaining);
  await openGroup(group,'프로젝트');
  await pane().getByRole('button',{name:'프로젝트 등록',exact:true}).click();
  await pane().getByLabel('프로젝트명',{exact:true}).fill('삭제할 그룹의 새 프로젝트 초안');
  const beforeGroup=await snapshot();
  await groupDelete(group);
  await authorizeDeletion('그룹',group.name,{checkInvalid:true,previousName:project.name});
  await expect(dialog('그룹')).toContainText('그룹의 프로젝트, 리뷰, 작업이력과 첨부 파일을 모두 삭제합니다.');
  await page.screenshot({path:path.join(results,'deletion-group-confirm.png')});
  await dialog('그룹').getByRole('button',{name:'취소',exact:true}).click();
  assert.deepEqual(stateRows(await snapshot()),stateRows(beforeGroup));
  await expect(task('프로젝트 등록')).toHaveCount(1);
  passed('그룹 이름을 정확히 입력해야 삭제할 수 있고 다른 대상의 확인 이름을 재사용하지 않으며 취소하면 하위 자료와 탭 유지');

  await groupDelete(group);
  await authorizeDeletion('그룹',group.name);
  await dialog('그룹').getByRole('button',{name:'삭제',exact:true}).click();
  await expect(dialog('그룹')).toHaveCount(0);
  const final=await snapshot();
  assert.deepEqual(final.groups.map(item=>item.id),[otherGroup.id]);
  assert.deepEqual(final.projects.map(item=>item.id),[otherProject.id]);
  assert.deepEqual(final.services.map(item=>item.id),[otherService.id]);
  assert.deepEqual(final.reviews,baseline.reviews.filter(item=>item.id===otherReview.id));
  assert.deepEqual(final.activities,baseline.activities.filter(item=>item.reviewId===otherReview.id));
  assert.deepEqual(final.attachments,baseline.attachments.filter(item=>item.reviewId===otherReview.id));
  assert.deepEqual((await invoke('agent.list')).filter(item=>item.reviewId===keptReview.id),[]);
  for(const item of [group,remaining])await expect(task(item.name)).toHaveCount(0);
  await expect(task('프로젝트 등록')).toHaveCount(0);
  await expect(task(otherProject.name)).toHaveCount(1);
  await assertDraftsRemoved([...reviewDraftKeys(keptReview),...projectDraftKeys(remaining)]);
  const otherKeys=[...reviewDraftKeys(otherReview),...projectDraftKeys(otherProject)];
  assert.deepEqual(await stored(otherKeys),Object.fromEntries(otherKeys.map(key=>[key,beforeDrafts[key]])));
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('reviewops.home.favorites'))),[otherProject.id]);
  for(const file of baseline.attachments)assert.equal(fs.existsSync(attachmentPath(file)),file.reviewId===otherReview.id);
  await expect(page.getByRole('dialog',{name:'작성 중인 내용',exact:true})).toHaveCount(0);
  passed('그룹의 프로젝트·리뷰·작업이력·첨부·하위 탭과 초안을 함께 삭제하고 다른 그룹 유지');

  await primary('홈').click();await refresh();
  await expect(page.locator(`[data-tree-node="r-${otherReview.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-tree-node="g-${group.id}"]`)).toHaveCount(0);
  await page.locator(`[data-tree-node="r-${otherReview.id}"]`).click();
  await expect(page.locator('.work-home').getByRole('textbox',{name:'작업 내용',exact:true})).toHaveValue('저장하지 않은 작업 내용');
  await page.screenshot({path:path.join(results,'deletion-remaining-group.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  passed('삭제 후 홈 탐색·다른 그룹의 초안 복원 및 화면 오류·외부 요청 없음');

  const reviewFile=path.join(work,'제목 확인 후 삭제할 첨부.txt');
  fs.writeFileSync(reviewFile,'SYNTHETIC_REVIEW_CONFIRMATION_ATTACHMENT');
  const [reviewPending]=await invoke('attachment.stageFiles',{paths:[reviewFile]});
  const namedReview=await invoke('review.save',{projectId:otherProject.id,serviceId:otherService.id,title:'제목 입력 후 삭제할 리뷰',body:'리뷰 제목 확인을 검사합니다.',attachmentTokens:[reviewPending.token]});
  await invoke('activity.add',{reviewId:namedReview.id,body:'리뷰 제목 입력 후 삭제할 작업이력'});
  await page.evaluate(id=>localStorage.setItem(`reviewops.agent.draft.${id}`,JSON.stringify({prompt:'취소하면 보존할 에이전트 요청'})),namedReview.id);
  const beforeNamedReview=await snapshot(),namedDraft=await stored(reviewDraftKeys(namedReview));
  const openReviewDelete=async()=>{
    await primary('홈').click();await refresh();
    await page.locator(`[data-tree-node="r-${namedReview.id}"]`).click();
    await page.locator('.work-home').getByRole('tab',{name:'정보',exact:true}).click();
    await page.locator('.work-home .original-review-delete').getByRole('button',{name:'삭제',exact:true}).click();
  };
  await openReviewDelete();
  await authorizeDeletion('리뷰',namedReview.title,{checkInvalid:true,previousName:group.name});
  await page.screenshot({path:path.join(results,'deletion-review-title-confirm.png')});
  await dialog('리뷰').getByRole('button',{name:'취소',exact:true}).click();
  assert.deepEqual(stateRows(await snapshot()),stateRows(beforeNamedReview));
  assert.deepEqual(await stored(reviewDraftKeys(namedReview)),namedDraft);
  await openReviewDelete();
  await authorizeDeletion('리뷰',namedReview.title);
  await dialog('리뷰').getByRole('button',{name:'삭제',exact:true}).click();
  await expect(dialog('리뷰')).toHaveCount(0);
  const afterNamedReview=await snapshot();
  assert.ok(!afterNamedReview.reviews.some(item=>item.id===namedReview.id));
  assert.ok(!afterNamedReview.activities.some(item=>item.reviewId===namedReview.id));
  assert.ok(!afterNamedReview.attachments.some(item=>item.reviewId===namedReview.id));
  for(const file of beforeNamedReview.attachments.filter(item=>item.reviewId===namedReview.id))assert.equal(fs.existsSync(attachmentPath(file)),false);
  await assertDraftsRemoved(reviewDraftKeys(namedReview));
  assert.deepEqual(afterNamedReview.projects.map(item=>item.id),[otherProject.id]);
  assert.deepEqual(afterNamedReview.services.map(item=>item.id),[otherService.id]);
  assert.deepEqual(afterNamedReview.reviews,final.reviews);
  assert.deepEqual(afterNamedReview.activities,final.activities);
  assert.deepEqual(afterNamedReview.attachments,final.attachments);
  passed('리뷰 제목도 정확히 입력해야 삭제할 수 있고 취소·재열기 시 초기화하며 해당 리뷰의 기록·파일·초안만 삭제');

  const refreshProject=await invoke('project.save',{groupId:otherGroup.id,name:'삭제 후 새로고침 실패 검사',serviceIds:[otherService.id]});
  const refreshReview=await invoke('review.save',{projectId:refreshProject.id,serviceId:otherService.id,title:'삭제 후 정리할 초안',body:'화면 갱신 실패 검사'});
  await page.evaluate(id=>localStorage.setItem(`reviewops.draft.${id}`,'화면 갱신이 실패해도 삭제할 초안'),refreshReview.id);
  await refresh();await openProject(refreshProject);
  await projectDelete(refreshProject);
  await authorizeDeletion('프로젝트',refreshProject.name,{checkInvalid:true,previousName:namedReview.title});
  await app.evaluate(({ipcMain},projectId)=>{
    const original=ipcMain._invokeHandlers.get('reviewops:invoke');
    const state=globalThis.__reviewopsDeletionFixture={projectId,deletions:0,snapshotFailures:0,pendingFailure:false};
    ipcMain.removeHandler('reviewops:invoke');
    ipcMain.handle('reviewops:invoke',async(event,action,payload)=>{
      if(action==='snapshot'&&state.pendingFailure){state.pendingFailure=false;state.snapshotFailures++;return {ok:false,error:{code:'SYNTHETIC_REFRESH_ERROR',message:'합성 화면 갱신 오류'}};}
      const result=await original(event,action,payload);
      if(action==='project.delete'&&payload.id===state.projectId){state.deletions++;if(result.ok)state.pendingFailure=true;}
      return result;
    });
  },refreshProject.id);
  await dialog('프로젝트').getByRole('button',{name:'삭제',exact:true}).click();
  await expect(dialog('프로젝트')).toHaveCount(0);
  await expect(page.locator('.error-banner')).toContainText('삭제했습니다. 화면을 새로고침하지 못했습니다. 합성 화면 갱신 오류');
  await expect(task(refreshProject.name)).toHaveCount(0);
  await assertDraftsRemoved(reviewDraftKeys(refreshReview));
  await expect(pane().getByRole('button',{name:`${refreshProject.name} 열기`,exact:true})).toHaveCount(0);
  const refreshState=await app.evaluate(()=>globalThis.__reviewopsDeletionFixture);
  assert.equal(refreshState.deletions,1);assert.equal(refreshState.snapshotFailures,1);assert.equal(refreshState.pendingFailure,false);
  assert.ok(!(await snapshot()).projects.some(item=>item.id===refreshProject.id));
  await page.screenshot({path:path.join(results,'deletion-refresh-failure.png')});
  await refresh();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  assert.equal((await app.evaluate(()=>globalThis.__reviewopsDeletionFixture)).deletions,1);
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  passed('삭제 후 화면 갱신 실패도 삭제 완료로 표시하고 탭·초안을 정리하며 중복 삭제 없이 새로고침 복구');
  const result={ok:true,version:(await invoke('app.info')).version,checks,rendererErrors:errors,externalRequests:network,testRoot,syntheticCliRuns:3,paidRequests:0,executable:process.env.REVIEWOPS_TEST_EXECUTABLE||'development Electron'};
  fs.writeFileSync(path.join(results,'deletion.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} catch(error) {
  await page?.screenshot({path:path.join(testRoot,'failure.png')}).catch(()=>{});
  console.error('DELETION FAILURE',testRoot,error);process.exitCode=1;
} finally {
  await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});
  await app?.close().catch(()=>{});
}
