import {setTestLocale} from './test-locale.mjs';
import { expectSelectValue } from './select-control.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join('/tmp', 'reviewops-navigation-'));
const resultRoot = path.join(root, 'test-results');
const homePath = path.join(testRoot, 'home'), sshConfig = path.join(homePath, '.ssh', 'config');
fs.mkdirSync(path.dirname(sshConfig), {recursive:true});fs.writeFileSync(sshConfig, '# Synthetic navigation fixture\n', {mode:0o600});
const localRoot = path.join(testRoot, 'files');
fs.mkdirSync(localRoot);
fs.mkdirSync(resultRoot, { recursive: true });
fs.writeFileSync(path.join(localRoot, '작업메모.md'), '# 화면 개선\n\n검색어를 유지하고 파일 이름 전체를 표시합니다.\n');
let app;
let page;
const failures = [];
const externalRequests = [];
const checks = [];
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.request(action, payload), { action, payload });
async function invoke(action, payload = {}) {
  const result = await request(action, payload);
  assert.equal(result.ok, true, `${action}: ${result.error?.message || 'IPC failed'}`);
  return result.data;
}
const primary = name => page.locator('.main-nav').getByRole('button', { name, exact: true });
const tabs = () => page.getByRole('tablist', { name: '작업 탭', exact: true });
const task = name => tabs().getByRole('tab', { name, exact: true });
const editor = name => page.getByRole('region', { name, exact: true });
async function openGroup(name, section = '프로젝트') {
  await primary('그룹').click();
  await page.getByRole('button', { name: `그룹 열기: ${name}`, exact: true }).click();
  await page.locator('.resource-tabs:visible').getByRole('button', { name: section, exact: true }).click();
}
async function seed() {
  const product = await invoke('group.save', { name: '제품 개발', description: '검색 화면과 파일 표시 개선' });
  const operations = await invoke('group.save', { name: '운영 관리', description: '배포 점검과 장애 대응' });
  const local = await invoke('service.save', { groupId: product.id, name: '개발 작업 폴더', kind: 'local', rootPath: localRoot });
  const operationsLocal = await invoke('service.save', { groupId: operations.id, name: '운영 작업 폴더', kind: 'local', rootPath: localRoot });
  const search = await invoke('project.save', { groupId: product.id, name: '검색 화면 개선', description: '파일 검색과 결과 화면을 개선합니다.', serviceIds: [local.id] });
  const documents = await invoke('project.save', { groupId: product.id, name: '문서 미리보기', description: '문서 파일 표시와 첨부파일 기능을 개선합니다.', serviceIds: [local.id] });
  const deployment = await invoke('project.save', { groupId: operations.id, name: '배포 점검', description: '서비스 배포 후 화면과 파일 상태를 점검합니다.', serviceIds: [operationsLocal.id] });
  const specs = [
    { projectId: search.id, serviceId: local.id, title: '검색 결과에서 파일 이름 전체 표시', body: '긴 파일 이름은 두 줄까지 표시합니다.\n파일 형식과 수정 날짜를 함께 표시합니다.', status: 'in_progress' },
    { projectId: search.id, serviceId: local.id, title: '검색어를 입력한 상태로 목록 복귀', body: '파일을 열었다가 돌아와도 검색어를 유지합니다.', status: 'open' },
    { projectId: search.id, serviceId: local.id, title: '키보드로 결과 항목 선택', body: '방향키로 항목을 이동하고 Enter 키로 엽니다.', status: 'in_review' },
    { projectId: search.id, serviceId: local.id, title: '빈 검색 결과 안내', body: '검색 결과가 없으면 검색어 변경 안내를 표시합니다.', status: 'closed' },
    { projectId: documents.id, serviceId: local.id, title: '문서 표 너비 조정', body: '작은 창에서 표가 문서 영역을 벗어나지 않도록 조정합니다.', status: 'open' },
    { projectId: documents.id, serviceId: local.id, title: '첨부파일 다운로드 이름 유지', body: '저장할 때 원본 파일 이름을 그대로 사용합니다.', status: 'resolved' },
    { projectId: deployment.id, serviceId: operationsLocal.id, title: '배포 후 파일 목록 검사', body: '배포 폴더의 파일과 수정 시간을 검사합니다.', status: 'recheck' },
  ];
  const reviews = [];
  for (const spec of specs) reviews.push(await invoke('review.save', spec));
  await invoke('activity.add', { reviewId: reviews[0].id, body: '파일 이름을 먼저 표시하고 파일 형식과 수정 날짜는 오른쪽에 배치합니다.' });
  await invoke('activity.add', { reviewId: reviews[0].id, body: '작은 창에서도 이름 전체를 읽을 수 있도록 줄 간격을 조정했습니다.' });
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(localRoot, '작업메모.md'));
  await invoke('attachment.add', { reviewId: reviews[0].id });
  return { product, operations, local, operationsLocal, search, documents, deployment, reviews };
}

try {
  const env = { ...process.env, HOME:homePath, CODEX_HOME:path.join(homePath,'.codex'), REVIEWOPS_CODEX_SSH_CONFIG:sshConfig, REVIEWOPS_DATA_DIR: path.join(testRoot, 'data') };
  for(const name of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
  app = await electron.launch({ args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root], executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout: 30000 });
  page = await app.firstWindow(); await setTestLocale(page);
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.waitForFunction(() => !!window.reviewops?.request);
  await expect(page.getByRole('heading', { name: '홈', exact: true })).toBeVisible();
  await expect(primary('홈')).toBeVisible();
  await expect(primary('그룹')).toBeVisible();
  for (const name of ['프로젝트', '서비스', '리뷰']) await expect(primary(name)).toHaveCount(0);
  await expect(tabs().getByRole('button', { name: '홈 닫기', exact: true })).toHaveCount(0);
  for (const name of ['계정관리', '호스트관리']) await expect(primary(name)).toBeVisible();
  passed('주요 메뉴에 홈·그룹·계정관리·호스트관리 표시, 서비스 메뉴 제거와 홈 작업 탭 유지');

  const fixtures = await seed();
  const legacyDraft = '기존 앱에서 작성 중이던 작업 내용';
  await page.evaluate(({ id, body }) => localStorage.setItem(`reviewops.comment.${id}`, body), { id: fixtures.reviews[0].id, body: legacyDraft });
  await page.reload();
  await expect(page.getByRole('heading', { name: '홈', exact: true })).toBeVisible();

  const home = page.locator('.work-home');
  const tree = home.getByRole('tree', { name: '그룹 프로젝트 리뷰', exact: true });
  const treeReview = review => tree.locator(`[data-tree-node="r-${review.id}"]`);
  const reviewScope = name => home.getByRole('group', { name: '리뷰 상태', exact: true }).getByRole('button', { name, exact: true });
  await expect(home.locator('.work-home-explorer > header')).toContainText('5개 리뷰');
  await expect(tree.locator('.work-home-tree-review')).toHaveCount(5);
  await expect(home.locator('.stats-grid,.dashboard,.summary-tile')).toHaveCount(0);
  await home.getByRole('searchbox', { name: '리뷰 제목·분류 검색', exact: true }).fill('파일 이름');
  await expect(home.locator('.work-home-explorer > header')).toContainText('1개 리뷰');
  await expect(treeReview(fixtures.reviews[0])).toBeVisible();
  await expect(treeReview(fixtures.reviews[1])).toHaveCount(0);
  await home.getByRole('searchbox', { name: '리뷰 제목·분류 검색', exact: true }).fill('');
  await reviewScope('닫힌 리뷰').click();
  await expect(home.locator('.work-home-explorer > header')).toContainText('2개 리뷰');
  await expect(treeReview(fixtures.reviews[3])).toBeVisible();
  await expect(treeReview(fixtures.reviews[5])).toBeVisible();
  await expect(treeReview(fixtures.reviews[0])).toHaveCount(0);
  await reviewScope('진행 리뷰').click();
  const groupNode = tree.locator(`[data-tree-node="g-${fixtures.product.id}"]`);
  await groupNode.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(groupNode).toHaveAttribute('aria-expanded', 'false');
  await expect(treeReview(fixtures.reviews[0])).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(groupNode).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tree.locator(`[data-parent="g-${fixtures.product.id}"]`).first()).toBeFocused();
  await treeReview(fixtures.reviews[0]).focus();
  await page.keyboard.press('Enter');
  await expect(home.getByRole('heading', { name: fixtures.reviews[0].title, exact: true })).toBeVisible();
  await expect(home.getByRole('textbox', { name: '작업 내용', exact: true })).toHaveValue(legacyDraft);
  passed('홈 그룹·프로젝트·리뷰 트리, 제목 검색, 진행·닫힌 리뷰 수량과 키보드 탐색');

  const draft = '목록으로 돌아온 뒤에도 작성 중인 작업 내용을 유지합니다.';
  await home.getByRole('textbox', { name: '작업 내용', exact: true }).fill(draft);
  await home.getByRole('button', { name: `${fixtures.search.name} 프로젝트 열기`, exact: true }).click();
  await expect(task(fixtures.search.name)).toHaveAttribute('aria-selected', 'true');
  await openGroup(fixtures.operations.name);
  await primary('홈').click();
  await expect(home.getByRole('heading', { name: fixtures.reviews[0].title, exact: true })).toBeVisible();
  await expect(home.getByRole('textbox', { name: '작업 내용', exact: true })).toHaveValue(draft);
  await expect(treeReview(fixtures.reviews[0])).toHaveAttribute('aria-selected', 'true');
  passed('프로젝트·그룹 탭 이동 후 홈에서 선택한 리뷰와 작업 초안 유지');

  await task(fixtures.search.name).click();
  const projectPanel = page.locator('.original-project:visible');
  await projectPanel.getByRole('row').filter({ hasText: fixtures.reviews[0].title }).click();
  await expect(projectPanel.getByRole('textbox', { name: '작업 내용', exact: true })).toHaveValue(draft);
  const sharedDraft = `${draft} 동일 리뷰의 다른 화면에도 즉시 반영됩니다.`;
  await projectPanel.getByRole('textbox', { name: '작업 내용', exact: true }).fill(sharedDraft);
  await primary('홈').click();
  await expect(home.getByRole('textbox', { name: '작업 내용', exact: true })).toHaveValue(sharedDraft);
  await home.getByRole('textbox', { name: '작업 내용', exact: true }).fill(draft);
  await home.getByRole('button', { name: '리뷰 편집', exact: true }).click();
  const editedTitle = '같은 리뷰의 편집 초안 유지';
  await home.getByLabel('제목', { exact: true }).fill(editedTitle);
  await home.getByRole('tab', { name: '로그', exact: true }).click();
  await home.getByRole('tab', { name: '정보', exact: true }).click();
  await expect(home.getByLabel('제목', { exact: true })).toHaveValue(editedTitle);
  await task(fixtures.search.name).click();
  await expect(projectPanel.getByRole('textbox', { name: '작업 내용', exact: true })).toHaveValue(draft);
  await projectPanel.getByRole('button', { name: '리뷰 편집', exact: true }).click();
  await expect(projectPanel.getByLabel('제목', { exact: true })).toHaveValue(editedTitle);
  await projectPanel.getByLabel('제목', { exact: true }).fill(`${editedTitle} 변경`);
  await primary('홈').click();
  await expect(home.getByLabel('제목', { exact: true })).toHaveValue(`${editedTitle} 변경`);
  await home.getByRole('button', { name: '리뷰 닫기', exact: true }).click();
  await page.getByRole('dialog', { name: '작성 내용 닫기', exact: true }).getByRole('button', { name: '계속 작성', exact: true }).click();
  await expect(home.getByLabel('제목', { exact: true })).toHaveValue(`${editedTitle} 변경`);
  await home.locator('.original-review-form').getByRole('button', { name: '취소', exact: true }).click();
  await home.getByRole('tab', { name: '작업이력', exact: true }).click();
  await task(fixtures.search.name).click();
  await expect(projectPanel.getByLabel('제목', { exact: true })).toHaveValue(fixtures.reviews[0].title);
  await projectPanel.locator('.original-review-form').getByRole('button', { name: '취소', exact: true }).click();
  await primary('홈').click();
  passed('홈·프로젝트의 동일 리뷰 초안 동기화, 정보·로그 전환과 닫기 취소 후 편집 유지');

  await home.getByRole('button', { name: '작업이력 상태 변경', exact: true }).click();
  await home.getByRole('menuitemradio', { name: '닫힘', exact: true }).click();
  await home.getByRole('textbox', { name: '작업 내용', exact: true }).press('Meta+Enter');
  await expect.poll(async () => (await invoke('snapshot')).reviews.find(item => item.id === fixtures.reviews[0].id).status).toBe('closed');
  await expect(home.getByRole('textbox', { name: '작업 내용', exact: true })).toHaveValue('');
  await expect(home.locator('.work-home-explorer > header')).toContainText('4개 리뷰');
  await expect(home.getByRole('heading', { name: fixtures.reviews[0].title, exact: true })).toBeVisible();
  await reviewScope('닫힌 리뷰').click();
  await expect(home.locator('.work-home-explorer > header')).toContainText('3개 리뷰');
  await expect(treeReview(fixtures.reviews[0])).toBeVisible();
  await home.getByRole('button', { name: '작업이력 상태 변경', exact: true }).click();
  await home.getByRole('menuitemradio', { name: '진행', exact: true }).click();
  await home.getByRole('button', { name: '작업이력 보내기', exact: true }).click();
  await expect.poll(async () => (await invoke('snapshot')).reviews.find(item => item.id === fixtures.reviews[0].id).status).toBe('in_progress');
  await reviewScope('진행 리뷰').click();
  await expect(home.locator('.work-home-explorer > header')).toContainText('5개 리뷰');
  const history = (await invoke('snapshot')).activities.filter(item => item.reviewId === fixtures.reviews[0].id);
  assert.equal(history.filter(item => item.type === 'comment').length, 3);
  assert.equal(history.filter(item => item.type === 'comment' && item.body === draft).length, 1);
  assert.equal(history.filter(item => item.type === 'status').length, 2);
  assert.deepEqual(await page.evaluate(id => [localStorage.getItem(`reviewops.comment.${id}`), localStorage.getItem(`reviewops.draft.${id}`)], fixtures.reviews[0].id), [null, null]);
  passed('기존 작업 초안 복원, 작업 내용과 닫힘 저장, 상태만 변경, 목록 수량 갱신');

  const detailTabs = home.getByRole('tablist', { name: '리뷰 내용', exact: true });
  await detailTabs.getByRole('tab', { name: '작업이력', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(detailTabs.getByRole('tab', { name: '정보', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(detailTabs.getByRole('tab', { name: '정보', exact: true })).toBeFocused();
  await expect(home.getByRole('heading', { name: '리뷰어 요청', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(detailTabs.getByRole('tab', { name: '로그', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(home.getByRole('tablist', { name: '로그 종류', exact: true })).toContainText('변경 기록');
  await page.keyboard.press('End');
  await expect(detailTabs.getByRole('tab', { name: '에이전트', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(detailTabs.getByRole('tab', { name: '에이전트', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(detailTabs.getByRole('tab', { name: '작업이력', exact: true })).toHaveAttribute('aria-selected', 'true');
  await home.getByRole('button', { name: '작업메모.md', exact: true }).click();
  await expect(page.locator('.source-preview')).toContainText('검색어를 유지하고 파일 이름 전체를 표시합니다.');
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
  passed('작업이력·정보·로그·에이전트 키보드 전환과 첨부파일 미리보기');

  // This image is a real capture of the app populated only with synthetic test data.
  const imageFile = path.join(testRoot, '검색 화면 검토.png');
  await expect(page.locator('.toast[role="status"]')).toHaveCount(0, { timeout: 5000 });
  await page.screenshot({ path: imageFile });
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, imageFile);
  await home.getByRole('button', { name: '작업이력 자료 추가', exact: true }).click();
  await home.getByRole('menuitem', { name: '작업이력 첨부 파일 선택', exact: true }).click();
  await expect(home.getByLabel('선택한 첨부 파일', { exact: true })).toContainText('검색 화면 검토.png');
  assert.equal((await invoke('snapshot')).attachments.length, 1, '선택한 파일은 보내기 전까지 자료에 추가하지 않음');
  await home.getByRole('button', { name: '작업이력 보내기', exact: true }).click();
  await expect.poll(async () => (await invoke('snapshot')).attachments.length).toBe(2);
  await expect(home.locator('.original-review-history-scroll').getByRole('img', { name: '검색 화면 검토.png', exact: true })).toBeVisible();
  await home.getByRole('button', { name: '검색 화면 검토.png 열기', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toHaveCount(0, { timeout: 5000 });
  await home.locator('.original-review-history-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(resultRoot, 'home-desktop.png'), fullPage: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
  await expect(home.getByRole('textbox', { name: '작업 내용', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: path.join(resultRoot, 'home-compact.png'), fullPage: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  passed('실제 앱 이미지 첨부와 1440px·1000px 홈 화면, 가로 넘침 없음');
  await detailTabs.getByRole('tab', { name: '정보', exact: true }).click();
  await home.getByRole('button', { name: '작업메모.md 삭제', exact: true }).click();
  await page.getByRole('dialog', { name: '첨부 파일 삭제', exact: true }).getByRole('button', { name: '취소', exact: true }).click();
  assert.equal((await invoke('snapshot')).attachments.length, 2);
  await home.getByRole('button', { name: '작업메모.md 삭제', exact: true }).click();
  await page.getByRole('dialog', { name: '첨부 파일 삭제', exact: true }).getByRole('button', { name: '삭제', exact: true }).click();
  await expect.poll(async () => (await invoke('snapshot')).attachments.length).toBe(1);
  assert.equal((await invoke('snapshot')).activities.filter(item => item.reviewId === fixtures.reviews[0].id && item.type === 'comment').length, 4);
  passed('첨부파일 삭제 취소·확인과 리뷰·작업 내용 유지');
  await expect(page.locator('.toast[role="status"]')).toHaveCount(0, { timeout: 5000 });



  await openGroup(fixtures.product.name);
  await expect(page.locator('.resource-name:visible').filter({ hasText: fixtures.search.name })).toBeVisible();
  await expect(page.locator('.resource-name:visible').filter({ hasText: fixtures.documents.name })).toBeVisible();
  await expect(page.locator('.resource-name:visible').filter({ hasText: fixtures.deployment.name })).toHaveCount(0);
  await page.screenshot({ path: path.join(resultRoot, 'group-projects.png'), fullPage: true });
  await page.getByRole('button', { name: '프로젝트 등록', exact: true }).first().click();
  let form = editor('프로젝트 등록');
  await expect(form).toBeVisible();
  await expect(form.locator('.original-registration-header')).toContainText(fixtures.product.name);
  await expect(form.getByRole('combobox', { name: '그룹', exact: true })).toHaveCount(0);
  await expectSelectValue(form.getByRole('combobox', { name: '접속 방식', exact: true }), 'local');
  await expect(form.getByRole('combobox', { name: 'SSH 호스트', exact: true })).toHaveCount(0);
  await expect(form.getByRole('button', { name: '연결 서비스 선택', exact: true })).toHaveCount(0);
  await form.getByRole('textbox', { name: '로컬 폴더', exact: true }).fill(localRoot);
  await form.getByLabel('프로젝트명', { exact: true }).fill('저장 전 프로젝트');
  await primary('홈').click();
  await task('프로젝트 등록').click();
  form = editor('프로젝트 등록');
  await expect(form.getByLabel('프로젝트명', { exact: true })).toHaveValue('저장 전 프로젝트');
  await form.getByRole('button', { name: '취소', exact: true }).click();
  let discard = page.getByRole('dialog', { name: '작성 중인 내용', exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: '계속 작성', exact: true }).click();
  await expect(form.getByLabel('프로젝트명', { exact: true })).toHaveValue('저장 전 프로젝트');
  await form.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('dialog', { name: '작성 중인 내용', exact: true }).getByRole('button', { name: '변경 내용 버리기', exact: true }).click();
  assert.equal((await invoke('snapshot')).projects.length, 3);
  passed('작성 폼의 그룹 고정, 탭 이동 중 입력 유지와 취소 시 내용 보존');
  await openGroup(fixtures.product.name);
  await expect(page.locator('.resource-tabs:visible').getByRole('button', { name: '서비스', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '서비스 등록', exact: true })).toHaveCount(0);
  await openGroup(fixtures.operations.name);
  await expect(page.locator('.resource-name:visible').filter({ hasText: fixtures.deployment.name })).toBeVisible();
  await expect(page.locator('.resource-name:visible').filter({ hasText: fixtures.search.name })).toHaveCount(0);
  passed('그룹 안에서 프로젝트만 탐색하고 서비스 메뉴와 등록 기능 제거');


  await openGroup(fixtures.product.name);
  await expect(task(fixtures.product.name)).toHaveCount(1);
  await page.getByRole('button', { name: '새 작업 탭', exact: true }).click();
  await expect(task(fixtures.product.name)).toHaveCount(2);
  await tabs().getByRole('button', { name: `${fixtures.product.name} 닫기`, exact: true }).last().click();
  await expect(task(fixtures.product.name)).toHaveCount(1);
  await expect(task('홈')).toHaveCount(1);
  await task('홈').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs().getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabs().getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(task('홈')).toHaveAttribute('aria-selected', 'true');
  passed('작업 탭 열기·복제·닫기와 방향키·Home·End 이동');

  assert.equal((await invoke('snapshot')).reviews.length, 7);
  await invoke('project.delete', { id: fixtures.search.id });
  const projectDeleted = await invoke('snapshot');
  assert.equal(projectDeleted.projects.length, 2);
  assert.equal(projectDeleted.reviews.length, 3);
  assert.equal(projectDeleted.services.length, 2);
  await invoke('group.delete', { id: fixtures.product.id });
  const groupDeleted = await invoke('snapshot');
  assert.deepEqual(groupDeleted.groups.map(item => item.id), [fixtures.operations.id]);
  assert.deepEqual(groupDeleted.projects.map(item => item.id), [fixtures.deployment.id]);
  assert.deepEqual(groupDeleted.services.map(item => item.id), [fixtures.operationsLocal.id]);
  assert.deepEqual(groupDeleted.reviews.map(item => item.id), [fixtures.reviews[6].id]);
  passed('프로젝트·그룹 하위 자료 삭제와 다른 그룹의 프로젝트·리뷰 유지');

  assert.deepEqual(failures, []);
  assert.deepEqual(externalRequests, []);
  passed('렌더러 오류와 외부 HTTP 요청 없음');
  fs.writeFileSync(path.join(resultRoot, 'e2e-navigation-result.json'), JSON.stringify({ passed: true, version: (await invoke('app.info')).version, checks, failures, externalRequests, executable: process.env.REVIEWOPS_TEST_EXECUTABLE || 'development Electron', platform: process.platform, arch: process.arch }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(resultRoot, 'e2e-navigation-failure.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(resultRoot, 'e2e-navigation-result.json'), JSON.stringify({ passed: false, checks, message: error.message, failures, externalRequests }, null, 2));
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
}
