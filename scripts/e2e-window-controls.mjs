import {setTestLocale} from './test-locale.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-window-controls-'));
const resultRoot = path.join(root, 'test-results');
const checks = [], errors = [], externalRequests = [];
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
const files = path.join(testRoot, 'files');
fs.mkdirSync(files);
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Window controls fixture</title><input id="draft" aria-label="External draft"><script>window.instanceId=crypto.randomUUID();</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let app, page;
const invoke = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.invoke(action, payload), { action, payload });
const nativeWindow = fn => app.evaluate(({ BrowserWindow }, expression) => {
  const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('reviewops://app/'));
  if (!host) throw new Error('ReviewOps 창이 없습니다.');
  return Function('host', `return (${expression})(host)`)(host);
}, fn.toString());
const enterFullScreen = () => page.getByRole('button', { name: '창 전체 화면', exact: true });
const leaveFullScreen = () => page.getByRole('button', { name: '창 전체 화면 종료', exact: true });
const close = () => page.getByRole('button', { name: '창 닫기', exact: true });
const nativeContents = (id, expression) => app.evaluate(({ webContents }, { id, expression }) => webContents.fromId(id).executeJavaScript(expression, true), { id, expression });
const toggleNativeMenuFullScreen = async expected => {
  await app.evaluate(({ app, BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('reviewops://app/'));
    app.focus({ steal: true });
    host.show(); host.focus(); host.webContents.focus();
  });
  await expect.poll(() => nativeWindow(host => host.isFocused())).toBe(true);
  await app.evaluate(({ Menu, BrowserWindow }, expected) => new Promise((resolve, reject) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('reviewops://app/'));
    const event = expected ? 'enter-full-screen' : 'leave-full-screen';
    const finish = () => { clearTimeout(timer); resolve(host.isFullScreen()); };
    const timer = setTimeout(() => { host.removeListener(event, finish); reject(new Error(`운영체제 ${event} 이벤트가 발생하지 않았습니다.`)); }, 15000);
    host.once(event, finish);
    Menu.sendActionToFirstResponder('toggleFullScreen:');
  }), expected);
};
const equalBounds = (actual, expected) => {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) <= 1, `${key}: ${actual[key]} / ${expected[key]}`);
};

async function controlsGeometry() {
  return page.locator('.sidebar').evaluate(sidebar => {
    const box = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
    const buttons = [...sidebar.querySelectorAll('button')].filter(button => ['창 닫기', '창 전체 화면', '창 전체 화면 종료'].includes(button.getAttribute('aria-label')));
    return { sidebar: box(sidebar), buttons: buttons.map(button => ({ label: button.getAttribute('aria-label'), ...box(button), appRegion: getComputedStyle(button).getPropertyValue('-webkit-app-region') })), scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth };
  });
}

try {
  const env = { ...process.env, REVIEWOPS_DATA_DIR: path.join(testRoot, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root], executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout: 30000 });
  page = await app.firstWindow(); await setTestLocale(page);
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) externalRequests.push(request.url()); });
  await page.waitForFunction(() => !!window.reviewops?.onWindowState);
  await nativeWindow(host => { host.setFullScreen(false); host.unmaximize(); host.setBounds({ x: 100, y: 100, width: 1200, height: 850 }); host.show(); host.focus(); });
  await expect(page.getByRole('heading', { name: '홈', exact: true })).toBeVisible();
  const version = (await invoke('app.info')).version;
  const normal = await nativeWindow(host => ({ bounds: host.getBounds(), content: host.getContentBounds(), normal: host.getNormalBounds(), maximized: host.isMaximized(), fullScreen: host.isFullScreen() }));
  equalBounds(normal.content, normal.bounds);
  assert.equal(normal.maximized, false);
  assert.equal(normal.fullScreen, false);
  await expect(page.locator('.titlebar')).toHaveCount(0);
  await expect(page.locator('.local-status')).toHaveCount(0);
  await expect(page.locator('.sidebar')).not.toContainText(/로컬\s*저장/);
  passed('기본 창에서 운영체제 제목 표시줄과 로컬 저장 표시 제거');

  const logo = await page.locator('.sidebar-brand').evaluate(node => ({ region: getComputedStyle(node).getPropertyValue('-webkit-app-region'), selection: getComputedStyle(node).userSelect, imageRegion: getComputedStyle(node.querySelector('img')).getPropertyValue('-webkit-app-region'), draggable: node.querySelector('img').draggable }));
  assert.equal(logo.region, 'drag');
  assert.equal(logo.selection, 'none');
  assert.equal(logo.draggable, false);
  await expect(enterFullScreen()).toHaveAttribute('aria-pressed', 'false');
  await expect(close()).toBeVisible();
  const collapsed = await controlsGeometry();
  assert.equal(collapsed.buttons.length, 2);
  for (const button of collapsed.buttons) {
    assert.equal(button.appRegion, 'no-drag');
    assert.ok(button.width >= 40 && button.height >= 40);
    assert.ok(button.x >= collapsed.sidebar.x && button.x + button.width <= collapsed.sidebar.x + collapsed.sidebar.width + 1);
    assert.ok(button.y + button.height <= collapsed.sidebar.y + collapsed.sidebar.height);
  }
  assert.ok(Math.abs(collapsed.buttons[0].x - collapsed.buttons[1].x) <= 1);
  assert.ok(Math.abs(collapsed.buttons[0].y - collapsed.buttons[1].y) >= 40);
  assert.ok(collapsed.scrollWidth <= collapsed.width);
  passed('로고의 기본 창 드래그 영역과 접힌 메뉴 하단의 세로 창 제어 버튼');

  const dragRegions = await page.locator('.workspace-tabs').evaluate(strip => {
    const region = node => getComputedStyle(node).getPropertyValue('-webkit-app-region');
    const list = strip.querySelector('.workspace-tab-list');
    const add = strip.querySelector('.workspace-add-tab').getBoundingClientRect();
    const refresh = strip.querySelector('.workspace-refresh').getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const blank = document.elementFromPoint((add.right + refresh.left) / 2, stripBox.y + stripBox.height / 2);
    const controls = [...strip.querySelectorAll('.workspace-tab, .workspace-tab *, button, button *')];
    return { strip: region(strip), list: region(list), selection: getComputedStyle(strip).userSelect, blankWidth: refresh.left - add.right, blankRegion: region(blank), blankControl: !!blank.closest('button,.workspace-tab'), controls: controls.map(node => ({ tag: node.tagName, class: node.getAttribute('class'), region: region(node) })) };
  });
  assert.equal(dragRegions.strip, 'drag');
  assert.equal(dragRegions.list, 'drag');
  assert.equal(dragRegions.selection, 'none');
  assert.ok(dragRegions.blankWidth > 50);
  assert.equal(dragRegions.blankRegion, 'drag');
  assert.equal(dragRegions.blankControl, false);
  for (const control of dragRegions.controls) assert.equal(control.region, 'no-drag', JSON.stringify(control));
  passed('상단 탭의 빈 영역은 창 드래그로 처리하고 탭·버튼·아이콘·텍스트는 클릭 영역 유지');

  await page.evaluate(() => {
    window.windowControlsEvents = [];
    window.windowControlsUnsubscribe = window.reviewops.onWindowState(state => window.windowControlsEvents.push(state));
  });
  await nativeWindow(host => {
    globalThis.windowControlsNativeEvents = [];
    host.on('enter-full-screen', () => globalThis.windowControlsNativeEvents.push('enter-full-screen'));
    host.on('leave-full-screen', () => globalThis.windowControlsNativeEvents.push('leave-full-screen'));
  });
  await enterFullScreen().click();
  await expect.poll(() => nativeWindow(host => host.isFullScreen())).toBe(true);
  await expect(leaveFullScreen()).toHaveAttribute('aria-pressed', 'true');
  await expect(leaveFullScreen()).toBeEnabled();
  const fullScreen = await nativeWindow(host => ({ bounds: host.getBounds(), content: host.getContentBounds(), maximized: host.isMaximized(), fullScreen: host.isFullScreen() }));
  assert.equal(fullScreen.fullScreen, true);
  equalBounds(fullScreen.content, fullScreen.bounds);
  assert.equal((await invoke('window.state')).fullScreen, true);
  await expect.poll(() => page.evaluate(() => window.windowControlsEvents.some(state => state.fullScreen))).toBe(true);
  await leaveFullScreen().click();
  await expect.poll(() => nativeWindow(host => host.isFullScreen())).toBe(false);
  await expect(enterFullScreen()).toHaveAttribute('aria-pressed', 'false');
  await expect(enterFullScreen()).toBeEnabled();
  equalBounds(await nativeWindow(host => host.getBounds()), normal.bounds);
  assert.equal((await invoke('window.state')).fullScreen, false);
  assert.deepEqual(await app.evaluate(() => globalThis.windowControlsNativeEvents), ['enter-full-screen', 'leave-full-screen']);
  passed('전체 화면 버튼이 macOS 전체 화면에 진입하고 종료 시 이전 위치와 크기를 복원');

  const nativeMenuRole = await app.evaluate(({ Menu }) => {
    const find = menu => menu.items.flatMap(item => [item, ...(item.submenu ? find(item.submenu) : [])]);
    return find(Menu.getApplicationMenu()).find(item => item.role === 'togglefullscreen')?.role;
  });
  assert.equal(nativeMenuRole, 'togglefullscreen');
  await toggleNativeMenuFullScreen(true);
  await expect.poll(() => nativeWindow(host => host.isFullScreen()), { timeout: 15000 }).toBe(true);
  await expect(leaveFullScreen()).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => app.evaluate(() => globalThis.windowControlsNativeEvents.filter(event => event === 'enter-full-screen').length)).toBe(2);
  assert.equal((await invoke('window.state')).fullScreen, true);
  await toggleNativeMenuFullScreen(false);
  await expect.poll(() => nativeWindow(host => host.isFullScreen()), { timeout: 15000 }).toBe(false);
  await expect(enterFullScreen()).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => app.evaluate(() => globalThis.windowControlsNativeEvents.filter(event => event === 'leave-full-screen').length)).toBe(2);
  equalBounds(await nativeWindow(host => host.getBounds()), normal.bounds);
  passed('운영체제 전체 화면 메뉴로 전환한 상태도 창 버튼에 반영');

  await nativeWindow(host => host.maximize());
  await expect.poll(() => nativeWindow(host => host.isMaximized())).toBe(true);
  assert.equal((await invoke('window.state')).fullScreen, false);
  await expect(enterFullScreen()).toHaveAttribute('aria-pressed', 'false');
  await expect(leaveFullScreen()).toHaveCount(0);
  await nativeWindow(host => host.unmaximize());
  await expect.poll(() => nativeWindow(host => host.isMaximized())).toBe(false);
  equalBounds(await nativeWindow(host => host.getBounds()), normal.bounds);
  await page.evaluate(() => window.windowControlsUnsubscribe());
  const unsubscribedCount = await page.evaluate(() => window.windowControlsEvents.length);
  await enterFullScreen().click();
  await expect(leaveFullScreen()).toBeEnabled();
  await leaveFullScreen().click();
  await expect(enterFullScreen()).toBeEnabled();
  assert.equal(await page.evaluate(() => window.windowControlsEvents.length), unsubscribedCount);
  passed('일반 창 최대화는 전체 화면으로 표시하지 않으며 상태 구독 해제 후에도 창 제어 유지');

  const tabs = page.getByRole('tablist', { name: '작업 탭', exact: true });
  await page.locator('.main-nav').getByRole('button', { name: '그룹', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: '그룹', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('button', { name: '새 작업 탭', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: '그룹', exact: true })).toHaveCount(2);
  await tabs.getByRole('tab', { name: '홈', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: '홈', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: '그룹', exact: true }).last().click();
  const refreshedGroup = await invoke('group.save', { name: '탭 새로고침 검사 그룹' });
  await expect(page.getByRole('button', { name: `그룹 열기: ${refreshedGroup.name}`, exact: true })).toHaveCount(0);
  await tabs.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('button', { name: `그룹 열기: ${refreshedGroup.name}`, exact: true })).toBeVisible();
  for (let index = 0; index < 12; index += 1) await tabs.getByRole('button', { name: '새 작업 탭', exact: true }).click();
  await expect(tabs.getByRole('tab')).toHaveCount(15);
  const overflow = await tabs.evaluate(strip => {
    const list = strip.querySelector('.workspace-tab-list');
    const refresh = strip.querySelector('.workspace-refresh').getBoundingClientRect();
    return { scrollWidth: list.scrollWidth, width: list.clientWidth, pageWidth: document.documentElement.scrollWidth, innerWidth, refreshRight: refresh.right, tabRegions: [...list.querySelectorAll('.workspace-tab,.workspace-tab *')].map(node => getComputedStyle(node).getPropertyValue('-webkit-app-region')) };
  });
  assert.ok(overflow.scrollWidth > overflow.width);
  assert.ok(overflow.pageWidth <= overflow.innerWidth);
  assert.ok(overflow.refreshRight <= overflow.innerWidth);
  assert.ok(overflow.tabRegions.every(region => region === 'no-drag'));
  const lastTab = tabs.getByRole('tab').last();
  await lastTab.focus();
  await lastTab.press('Home');
  await expect(tabs.getByRole('tab', { name: '홈', exact: true })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: '홈', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(lastTab).toBeFocused();
  await expect(lastTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab').nth(13)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(lastTab).toBeFocused();
  while (await tabs.getByRole('button', { name: '그룹 닫기', exact: true }).count()) await tabs.getByRole('button', { name: '그룹 닫기', exact: true }).last().click();
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await expect(tabs.getByRole('tab', { name: '홈', exact: true })).toHaveAttribute('aria-selected', 'true');
  passed('탭 클릭·추가·닫기·새로고침·키보드 이동을 유지하고 넘친 탭은 가로 스크롤로 표시');

  await page.getByRole('button', { name: '메뉴 펼치기', exact: true }).click();
  await expect(page.locator('.workspace-app')).toHaveClass(/sidebar-expanded/);
  const expanded = await controlsGeometry();
  assert.equal(expanded.buttons.length, 2);
  assert.ok(Math.abs(expanded.buttons[0].y - expanded.buttons[1].y) <= 1);
  assert.ok(Math.abs(expanded.buttons[0].x - expanded.buttons[1].x) >= 40);
  for (const button of expanded.buttons) assert.ok(button.x + button.width <= expanded.sidebar.x + expanded.sidebar.width && button.y + button.height <= expanded.sidebar.y + expanded.sidebar.height);
  await page.getByRole('button', { name: '어두운 화면', exact: true }).click();
  await expect(enterFullScreen()).toHaveAttribute('aria-pressed', 'false');
  await expect(close()).toBeVisible();
  const dark = await close().evaluate(button => ({ color: getComputedStyle(button).color, background: getComputedStyle(button.closest('.sidebar')).backgroundColor }));
  assert.notEqual(dark.color, dark.background);
  fs.mkdirSync(resultRoot, { recursive: true });
  await page.screenshot({ scale: 'css', path: path.join(resultRoot, 'window-controls-expanded-dark.png') });
  await page.getByRole('button', { name: '밝은 화면', exact: true }).click();
  await page.getByRole('button', { name: '메뉴 접기', exact: true }).click();
  await page.screenshot({ scale: 'css', path: path.join(resultRoot, 'window-controls-collapsed.png') });
  passed('펼친 메뉴의 가로 창 제어 버튼과 밝은 화면·어두운 화면 표시');

  const group = await invoke('group.save', { name: '창 닫기 검사 그룹' });
  const service = await invoke('service.save', { name: '창 닫기 검사 서비스', groupId: group.id, kind: 'local', rootPath: files, viewerUrl: origin });
  const project = await invoke('project.save', { name: '창 닫기 검사 프로젝트', groupId: group.id, serviceIds: [service.id] });
  await invoke('review.save', { title: '창 닫기 검사 리뷰', projectId: project.id, serviceId: service.id });
  await page.locator('.workspace-refresh').click();
  await page.getByRole('button', { name: `${project.name} 프로젝트 열기`, exact: true }).click();
  const pane = page.locator('.workspace-pane:not([hidden])');
  await expect.poll(() => app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/`)?.id, origin)).toBeTruthy();
  const browserId = await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/`).id, origin);
  const instanceId = await nativeContents(browserId, 'document.querySelector("#draft").value="작성 중인 외부 화면"; window.instanceId');
  await pane.getByRole('navigation', { name: '프로젝트 기능', exact: true }).getByRole('button', { name: '설정', exact: true }).click();
  const name = pane.locator('.original-project-settings').getByLabel('프로젝트명', { exact: true });
  await name.fill('저장하지 않은 프로젝트 이름');
  await enterFullScreen().click();
  await expect(leaveFullScreen()).toBeEnabled();
  await app.evaluate(({ dialog }) => { globalThis.windowControlsDialogs = 0; dialog.showMessageBoxSync = () => { globalThis.windowControlsDialogs += 1; return 0; }; });
  await close().click();
  await expect.poll(() => app.evaluate(() => globalThis.windowControlsDialogs)).toBe(1);
  await expect(leaveFullScreen()).toHaveAttribute('aria-pressed', 'true');
  assert.equal((await invoke('window.state')).fullScreen, true);
  assert.equal(await nativeWindow(host => host.isFullScreen()), true);
  await expect(name).toHaveValue('저장하지 않은 프로젝트 이름');
  assert.equal((await invoke('snapshot')).projects.find(item => item.id === project.id).name, project.name);
  assert.equal(await nativeContents(browserId, 'window.instanceId'), instanceId);
  assert.equal(await nativeContents(browserId, 'document.querySelector("#draft").value'), '작성 중인 외부 화면');
  passed('전체 화면에서 닫기를 취소하면 전체 화면 상태·프로젝트 초안·외부 화면 유지');

  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
  await close().click();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  assert.equal(app.process().exitCode, null);
  await app.evaluate(({ app }) => app.emit('activate'));
  await expect.poll(() => app.windows().filter(candidate => !candidate.isClosed() && candidate.url().startsWith('reviewops://app/')).length).toBe(1);
  page = app.windows().find(candidate => !candidate.isClosed() && candidate.url().startsWith('reviewops://app/'));
  await page.waitForFunction(() => !!window.reviewops?.onWindowState);
  await expect(enterFullScreen()).toHaveAttribute('aria-pressed', 'false');
  await expect(close()).toBeVisible();
  assert.equal((await invoke('snapshot')).projects.find(item => item.id === project.id).name, project.name);
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id) === undefined, browserId), true);
  equalBounds(await nativeWindow(host => host.getBounds()), await nativeWindow(host => host.getContentBounds()));
  passed('내용 버리고 닫기를 선택하면 창과 외부 화면을 정리하고 다시 실행한 창도 동일하게 동작');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  fs.writeFileSync(path.join(resultRoot, 'window-controls.json'), JSON.stringify({ version, executable: process.env.REVIEWOPS_TEST_EXECUTABLE || 'development Electron', checks, errors, externalRequests, normal, fullScreen, collapsed, expanded, logo, dragRegions, overflow, dark }, null, 2));
  console.log(`PASS: 창 제어 ${checks.length}개 검사 완료`);
} finally {
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(testRoot, { recursive: true, force: true });
}
