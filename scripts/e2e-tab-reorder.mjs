import {setTestLocale} from './test-locale.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join('/tmp', 'reviewops-tab-reorder-'));
const dataRoot = path.join(testRoot, 'data');
const homePath=path.join(testRoot,'home'),sshConfig=path.join(homePath,'.ssh','config');fs.mkdirSync(path.dirname(sshConfig),{recursive:true});fs.writeFileSync(sshConfig,'# Synthetic tab reorder fixture\n',{mode:0o600});
const filesRoot = path.join(testRoot, 'files');
const resultRoot = path.join(root, 'test-results');
fs.mkdirSync(filesRoot);
fs.mkdirSync(resultRoot, { recursive: true });
const checks = [], errors = [], externalRequests = [];
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
let app, page, version;
const tabList = () => page.locator('.workspace-tab-list');
const tab = id => page.locator(`.workspace-tab[data-tab-id="${id}"]`).getByRole('tab');
const container = id => page.locator(`.workspace-tab[data-tab-id="${id}"]`);
const order = () => tabList().locator('.workspace-tab').evaluateAll(nodes => nodes.map(node => node.dataset.tabId));
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('reviewops.workspace.tabs') || '[]'));
const selected = () => tabList().getByRole('tab', { selected: true }).getAttribute('id').then(id => id.slice(4));
const invoke = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.invoke(action, payload), { action, payload });
const nativeWindow = fn => app.evaluate(({ BrowserWindow }, expression) => {
  const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('reviewops://app/'));
  if (!host) throw new Error('ReviewOps 창이 없습니다.');
  return Function('host', `return (${expression})(host)`)(host);
}, fn.toString());
async function launch() {
  const env = { ...process.env, HOME:homePath, CODEX_HOME:path.join(homePath,'.codex'), REVIEWOPS_CODEX_SSH_CONFIG:sshConfig, REVIEWOPS_DATA_DIR: dataRoot };
  for(const name of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
  app = await electron.launch({ args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root], executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout: 30000 });
  page = await app.firstWindow(); await setTestLocale(page);
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.waitForFunction(() => !!window.reviewops?.invoke);
  await expect(page.getByRole('heading', { name: '홈', exact: true })).toBeVisible();
  await nativeWindow(host => { host.setFullScreen(false); host.unmaximize(); host.setBounds({ x: 60, y: 60, width: 1800, height: 950 }); host.show(); host.focus(); });
  version = (await invoke('app.info')).version;
}
async function stop() {
  if (!app) return;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = null;
}
const point = box => ({ x: box.x + Math.min(50, box.width / 2), y: box.y + box.height / 2 });
async function beginDrag(id) {
  await tab(id).scrollIntoViewIfNeeded();
  const box = await tab(id).boundingBox();
  assert.ok(box);
  const start = point(box);
  await page.mouse.move(start.x, start.y);
  await page.evaluate(() => window.addEventListener('pointerdown', event => { window.tabReorderPointerId = event.pointerId; }, { once: true, capture: true }));
  await page.mouse.down();
  return start;
}
async function dragTo(id, targetId, side = 'after') {
  const start = await beginDrag(id);
  const target = await container(targetId).boundingBox();
  assert.ok(target);
  await page.mouse.move(target.x + target.width * (side === 'before' ? 0.2 : 0.8), start.y, { steps: 24 });
  await page.mouse.up();
}
function moved(ids, id, target, side) {
  const result = ids.filter(value => value !== id);
  let index = result.indexOf(target) + (side === 'after' ? 1 : 0);
  if (index < 1) index = 1;
  result.splice(index, 0, id);
  return result;
}
async function expectOrder(expected) {
  await expect.poll(order).toEqual(expected);
  await expect.poll(async () => (await saved()).map(item => item.id)).toEqual(expected.filter(id => id !== 'home'));
}
async function dragEdge(id, edge) {
  const start = await beginDrag(id);
  const box = await tabList().boundingBox();
  await page.mouse.move(edge === 'left' ? box.x + 6 : box.x + box.width - 6, start.y, { steps: 30 });
  if (edge === 'left') await expect.poll(() => tabList().evaluate(node => node.scrollLeft), { timeout: 15000 }).toBeLessThan(1);
  else await expect.poll(() => tabList().evaluate(node => node.scrollWidth - node.clientWidth - node.scrollLeft), { timeout: 15000 }).toBeLessThan(1);
  // Keep the pointer at the edge after the last scroll frame so the final target is recalculated.
  await page.mouse.move(edge === 'left' ? box.x + 5 : box.x + box.width - 5, start.y, { steps: 2 });
  await page.mouse.up();
}

try {
  await launch();
  const group = await invoke('group.save', { name: '탭 이동 검사 그룹' });
  const service = await invoke('service.save', { groupId: group.id, name: '탭 이동 검사 서비스', kind: 'local', rootPath: filesRoot });
  const project = await invoke('project.save', { groupId: group.id, name: '탭 이동 검사 프로젝트', serviceIds: [service.id] });
  const fixtureTabs = [
    { id: 'groups', kind: 'groups' },
    { id: 'group', kind: 'group', entityId: group.id },
    { id: 'project', kind: 'project', entityId: project.id },
    { id: 'accounts', kind: 'accounts' },
    { id: 'settings', kind: 'settings' },
    { id: 'group-copy', kind: 'group', entityId: group.id },
  ];
  await page.evaluate(tabs => localStorage.setItem('reviewops.workspace.tabs', JSON.stringify(tabs)), fixtureTabs);
  await page.reload();
  await expect(tab('home')).toHaveAttribute('aria-selected', 'true');
  await expectOrder(['home', ...fixtureTabs.map(item => item.id)]);
  const nativeBounds = await nativeWindow(host => host.getBounds());

  const regions = await page.locator('.workspace-tabs').evaluate(strip => {
    const region = node => getComputedStyle(node).getPropertyValue('-webkit-app-region');
    const add = strip.querySelector('.workspace-add-tab').getBoundingClientRect();
    const refresh = strip.querySelector('.workspace-refresh').getBoundingClientRect();
    const bounds = strip.getBoundingClientRect();
    const blank = document.elementFromPoint((add.right + refresh.left) / 2, bounds.y + bounds.height / 2);
    return { strip: region(strip), list: region(strip.querySelector('.workspace-tab-list')), blank: region(blank), blankIsControl: !!blank.closest('button,.workspace-tab'), controls: [...strip.querySelectorAll('.workspace-tab,.workspace-tab *,button,button *')].map(region) };
  });
  assert.equal(regions.strip, 'drag'); assert.equal(regions.list, 'drag');
  assert.equal(regions.blank, 'drag'); assert.equal(regions.blankIsControl, false);
  assert.ok(regions.controls.every(value => value === 'no-drag'));
  passed('상단 빈 공간은 창 이동 영역이며 탭·아이콘·닫기 버튼은 별도 조작 영역');

  let before = await order();
  await dragTo('group', 'accounts', 'after');
  await expectOrder(moved(before, 'group', 'accounts', 'after'));
  before = await order();
  await dragTo('settings', 'groups', 'before');
  await expectOrder(moved(before, 'settings', 'groups', 'before'));
  assert.deepEqual(await nativeWindow(host => host.getBounds()), nativeBounds);
  assert.equal(await selected(), 'settings');
  passed('실제 마우스로 그룹·데이터 관리 탭을 좌우로 이동하고 이동한 화면과 창 위치 유지');

  await tab('home').click();
  before = await order();
  await dragTo('home', 'project', 'after');
  await expectOrder(before);
  assert.equal(await selected(), 'home');
  await dragTo('accounts', 'home', 'before');
  await expectOrder(moved(before, 'accounts', 'home', 'before'));
  assert.equal((await order())[0], 'home');
  passed('홈은 이동하지 않으며 다른 탭을 홈 앞에 놓아도 홈 다음 위치로 제한');

  before = await order();
  await tab('group-copy').click();
  await expectOrder(before);
  assert.equal(await selected(), 'group-copy');
  await dragTo('group-copy', 'settings', 'before');
  await expectOrder(moved(before, 'group-copy', 'settings', 'before'));
  assert.equal(await selected(), 'group-copy');
  before = await order();
  await container('group-copy').getByRole('button', { name: `${group.name} 닫기`, exact: true }).click();
  await expectOrder(before.filter(id => id !== 'group-copy'));
  assert.equal(await selected(), before[before.indexOf('group-copy') - 1]);
  passed('이름이 같은 복제 탭도 개별 이동하고 클릭·닫기는 순서를 바꾸지 않음');

  await tab('group').click();
  await page.locator('.resource-tabs:visible').getByRole('button', { name: '프로젝트', exact: true }).click();
  await page.getByRole('button', { name: '프로젝트 등록', exact: true }).first().click();
  const projectEditor = page.getByRole('region', { name: '프로젝트 등록', exact: true });
  await projectEditor.getByLabel('프로젝트명', { exact: true }).fill('이동 후에도 유지할 프로젝트 이름');
  await projectEditor.getByLabel('설명', { exact: true }).fill('탭을 옮기거나 연결 설정을 바꿔도 유지되는 입력 내용입니다.');
  const editorId = await selected();
  before = await order();
  await dragTo(editorId, 'accounts', 'before');
  await expect.poll(order).toEqual(moved(before, editorId, 'accounts', 'before'));
  assert.equal(await selected(), editorId);
  await expect(projectEditor.getByLabel('프로젝트명', { exact: true })).toHaveValue('이동 후에도 유지할 프로젝트 이름');
  await expect(projectEditor.getByLabel('설명', { exact: true })).toHaveValue('탭을 옮기거나 연결 설정을 바꿔도 유지되는 입력 내용입니다.');
  assert.ok(!(await saved()).some(item => item.id === editorId));
  await container(editorId).getByRole('button', { name: '프로젝트 등록 닫기', exact: true }).click();
  await page.getByRole('dialog', { name: '작성 중인 내용', exact: true }).getByRole('button', { name: '계속 작성', exact: true }).click();
  assert.equal(await selected(), editorId);
  passed('프로젝트 등록 탭을 이동해도 입력·선택·닫기 확인을 유지하고 미저장 탭은 복원 목록에서 제외');

  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, filesRoot);
  await projectEditor.getByRole('button', { name: '선택', exact: true }).click();
  await expect(projectEditor.getByRole('textbox', { name: '로컬 폴더', exact: true })).toHaveValue(filesRoot);
  await projectEditor.getByRole('spinbutton', { name: '화면 너비', exact: true }).fill('1366');
  before = await order();
  await dragTo(editorId, 'settings', 'before');
  await expect.poll(order).toEqual(moved(before, editorId, 'settings', 'before'));
  await expect(projectEditor.getByRole('textbox', { name: '로컬 폴더', exact: true })).toHaveValue(filesRoot);
  await expect(projectEditor.getByRole('spinbutton', { name: '화면 너비', exact: true })).toHaveValue('1366');
  await expect(projectEditor.getByLabel('프로젝트명', { exact: true })).toHaveValue('이동 후에도 유지할 프로젝트 이름');
  assert.equal((await invoke('snapshot')).projects.length,1);
  passed('프로젝트 등록 탭 이동 후에도 로컬 폴더·뷰어 설정과 프로젝트 초안 유지');

  await tab('home').click();
  before = await order();
  await beginDrag('settings');
  const homeBox = await container('home').boundingBox();
  await page.mouse.move(homeBox.x + homeBox.width * 0.8, homeBox.y + homeBox.height / 2, { steps: 20 });
  await expect(tabList()).toHaveClass(/is-reordering/);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(order).toEqual(before);
  await expect(tabList()).not.toHaveClass(/is-reordering/);
  assert.equal(await selected(), 'settings');
  await tab('home').click();
  await beginDrag('project');
  const serviceBox = await container('accounts').boundingBox();
  await page.mouse.move(serviceBox.x + serviceBox.width * 0.2, serviceBox.y + serviceBox.height / 2, { steps: 20 });
  await expect(tabList()).toHaveClass(/is-reordering/);
  // The drag itself uses real mouse input. Pointer cancellation represents the browser/OS interruption event.
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.tabReorderPointerId, pointerType: 'mouse', bubbles: true })));
  await page.mouse.up();
  await expect.poll(order).toEqual(before);
  await expect(tabList()).not.toHaveClass(/is-reordering/);
  assert.equal(await selected(), 'project');
  await expect.poll(async () => (await saved()).map(item => item.id)).toEqual(before.filter(id => id !== 'home' && id !== editorId));
  passed('Escape와 포인터 중단 시 이전 순서로 복원하고 다른 탭의 클릭 방지');

  await tab('project').focus();
  before = await order();
  const previousId = before[before.indexOf('project') - 1];
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await expect.poll(order).toEqual(moved(before, 'project', previousId, 'before'));
  await expect(tab('project')).toBeFocused();
  assert.equal(await selected(), 'project');
  await page.keyboard.press('Home');
  await expect(tab('home')).toBeFocused();
  await expect(tab('home')).toHaveAttribute('aria-selected', 'true');
  before = await order();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect.poll(order).toEqual(before);
  passed('키보드로 일반 탭 순서를 변경하고 홈 고정 및 기존 Home 키 탐색 유지');

  await tab(editorId).click();
  await projectEditor.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('dialog', { name: '작성 중인 내용', exact: true }).getByRole('button', { name: '변경 내용 버리기', exact: true }).click();
  const reloadOrder = await order();
  await expect.poll(async () => (await saved()).map(item => item.id)).toEqual(reloadOrder.slice(1));
  await page.reload();
  await expect(tab('home')).toHaveAttribute('aria-selected', 'true');
  await expectOrder(reloadOrder);
  passed('페이지를 새로 열어도 저장한 탭 순서가 유지되고 홈은 첫 위치로 복원');

  await nativeWindow(host => host.setSize(1000, 740));
  await tab('groups').click();
  for (let index = 0; index < 16; index += 1) await page.getByRole('button', { name: '새 작업 탭', exact: true }).click();
  const overflowingOrder = await order();
  const lastId = overflowingOrder.at(-1);
  await expect.poll(() => tabList().evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await dragEdge(lastId, 'left');
  await expect.poll(async () => (await order()).indexOf(lastId)).toBe(1);
  assert.equal((await order())[0], 'home');
  await dragEdge(lastId, 'right');
  await expect.poll(async () => (await order()).at(-1)).toBe(lastId);
  assert.equal((await order())[0], 'home');
  passed('넘친 탭을 양 끝으로 끌면 가로로 자동 이동하며 처음·마지막 순서까지 배치');

  await page.getByRole('button', { name: '어두운 화면', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('.workspace-add-tab').scrollIntoViewIfNeeded();
  const compact = await page.locator('.workspace-tabs').evaluate(strip => {
    const refresh = strip.querySelector('.workspace-refresh').getBoundingClientRect();
    const add = strip.querySelector('.workspace-add-tab').getBoundingClientRect();
    const dragging = strip.querySelectorAll('.dragging,.is-reordering').length;
    return { scrollWidth: document.documentElement.scrollWidth, width: innerWidth, refreshRight: refresh.right, addRight: add.right, dragging, colors: [...strip.querySelectorAll('.workspace-tab')].map(node => ({ text: getComputedStyle(node).color, background: getComputedStyle(strip).backgroundColor })) };
  });
  assert.ok(compact.scrollWidth <= compact.width);
  assert.ok(compact.refreshRight <= compact.width && compact.addRight <= compact.width);
  assert.equal(compact.dragging, 0);
  assert.ok(compact.colors.every(item => item.text !== item.background));
  await page.screenshot({ path: path.join(resultRoot, 'tab-reorder-compact-dark.png'), scale: 'css' });
  await page.getByRole('button', { name: '밝은 화면', exact: true }).click();
  await nativeWindow(host => host.setSize(1800, 950));
  await page.screenshot({ path: path.join(resultRoot, 'tab-reorder-desktop.png'), scale: 'css' });
  passed('1000px 창과 어두운 화면에서 탭 표시·조작 버튼·가로 스크롤 영역 유지');

  const restartOrder = await order();
  await expect.poll(async () => (await saved()).map(item => item.id)).toEqual(restartOrder.slice(1));
  await stop();
  await launch();
  await expectOrder(restartOrder);
  const snapshot = await invoke('snapshot');
  assert.equal(snapshot.groups.length, 1); assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.services.length, 1);
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  passed('앱을 종료·실행해도 순서·자료가 유지되며 렌더러 오류와 외부 HTTP 요청 없음');

  fs.writeFileSync(path.join(resultRoot, 'e2e-tab-reorder-result.json'), JSON.stringify({ passed: true, version, checks, errors, externalRequests, executable: process.env.REVIEWOPS_TEST_EXECUTABLE || 'development Electron', platform: process.platform, arch: process.arch }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(resultRoot, 'e2e-tab-reorder-failure.png'), scale: 'css' }).catch(() => {});
  fs.writeFileSync(path.join(resultRoot, 'e2e-tab-reorder-result.json'), JSON.stringify({ passed: false, version, checks, message: error.message, errors, externalRequests }, null, 2));
  throw error;
} finally {
  await stop();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
