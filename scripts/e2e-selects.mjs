import {setTestLocale} from './test-locale.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { openSelect, closeSelect, selectControl, selectOptions, expectSelectValue, expectSelectLabel, typeSelectValue } from './select-control.mjs';

// All data and SSH definitions are synthetic. No login, usage, reset or SSH connection is started.
const root = process.cwd(), testRoot = fs.mkdtempSync(path.join('/tmp', 'reviewops-selects-'));
const home = path.join(testRoot, 'home'), files = path.join(testRoot, 'files'), config = path.join(home, '.ssh', 'config');
for (const directory of [files, path.dirname(config)]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(config, Array.from({ length: 80 }, (_, index) => `Host fixture-host-${String(index + 1).padStart(3, '0')}\n  HostName 127.0.0.1\n  User fixture-user\n  Port 9\n`).join('\n'), { mode: 0o600 });
fs.writeFileSync(path.join(files, 'fixture.txt'), '검색 목록 검사 자료\n');
const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>선택 목록 검사</title><style>body{background:#e6f1fb;font:20px sans-serif;padding:20px}</style><h1>선택 목록 검사 화면</h1><script>window.selectFixtureInstance=crypto.randomUUID()</script>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let app, page, version, resultPath, nativeId;
const checks = [], errors = [], externalRequests = [], measurements = {};
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
const pane = () => page.locator('.workspace-pane:not([hidden])');
const primary = name => page.locator('.main-nav').getByRole('button', { name, exact: true });
const ipc = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.invoke(action, payload), { action, payload });
const resize = (width, height = 950) => app.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('reviewops://app/')).setSize(dimensions.width, dimensions.height), { width, height });
const combo = (container, name) => container.getByRole('combobox', { name, exact: true });
const geometry = () => app.evaluate(({ BrowserWindow }, id) => {
  const child = BrowserWindow.getAllWindows().find(window => window.contentView.children.some(view => view.webContents?.id === id));
  return child ? { visible: child.isVisible(), bounds: child.getContentBounds() } : null;
}, nativeId);
const native = expression => app.evaluate(({ webContents }, data) => webContents.fromId(data.id).executeJavaScript(data.expression, true), { id: nativeId, expression });
async function screenshot(name) { await page.screenshot({ path: path.join(resultPath, name + '.png') }); }
async function assertPopupBounds(popup, name) {
  const area = await popup.evaluate(element => {
    const rect = element.getBoundingClientRect(), center = document.elementFromPoint(Math.min(innerWidth - 2, rect.left + rect.width / 2), Math.min(innerHeight - 2, rect.top + rect.height / 2));
    return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, windowWidth: innerWidth, windowHeight: innerHeight, unobscured: element.contains(center), position: getComputedStyle(element).position };
  });
  assert.ok(area.x >= 3 && area.y >= 3 && area.right <= area.windowWidth - 3 && area.bottom <= area.windowHeight - 3, `${name}: 팝업이 창 밖으로 벗어났습니다.`);
  assert.equal(area.unobscured, true); assert.equal(area.position, 'fixed');
  measurements[name] = area;
}
async function openGroup(group) {
  await primary('그룹').click();
  await pane().getByRole('button', { name: `그룹 열기: ${group.name}`, exact: true }).click();
  await pane().getByRole('navigation', { name: '그룹 기능', exact: true }).getByRole('button', { name: '프로젝트', exact: true }).click();
}
async function openSettings(project, section) {
  await primary('홈').click(); await page.locator('.workspace-refresh').click();
  await pane().getByRole('button', { name: `${project.name} 프로젝트 열기`, exact: true }).click();
  await pane().getByRole('navigation', { name: '프로젝트 기능', exact: true }).getByRole('button', { name: '설정', exact: true }).click();
  await pane().getByRole('tablist', { name: '프로젝트 설정 항목', exact: true }).getByRole('tab', { name: section, exact: true }).click();
}

try {
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), REVIEWOPS_DATA_DIR: path.join(testRoot, 'data'), REVIEWOPS_SSH_CONFIG: config, REVIEWOPS_CODEX_SSH_CONFIG: config };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
  app = await electron.launch({ args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root], executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout: 30000 });
  page = await app.firstWindow(); await setTestLocale(page); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) externalRequests.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.reviewops?.invoke && window.hostManager?.getState));
  await resize(1600); version = await app.evaluate(({ app }) => app.getVersion());
  resultPath = path.join(root, 'test-results', `selects-v${version}`); fs.mkdirSync(resultPath, { recursive: true });
  const group = await ipc('group.save', { name: '선택 목록 검사', labels: ['문서', '화면', '배포'] });
  const viewerProject = await ipc('project.save', { groupId: group.id, name: '선택 목록 뷰어', connection: { kind: 'local', rootPath: files, viewerUrl: origin, viewerWidth: 1280, viewerHeight: 720, viewerScale: 'fit' } });
  await page.locator('.workspace-refresh').click();

  await openGroup(group); await pane().getByRole('button', { name: '프로젝트 등록', exact: true }).click();
  const registration = page.getByRole('region', { name: '프로젝트 등록', exact: true }), kind = combo(registration, '접속 방식');
  await registration.getByLabel('프로젝트명', { exact: true }).fill('검색해서 연결한 프로젝트');
  await expectSelectValue(kind, 'local');
  let picker = await openSelect(kind); await expect(picker.search).toHaveCount(0);
  await kind.press('End'); await kind.press('Enter'); await expectSelectValue(kind, 'ssh');
  assert.deepEqual(await selectOptions(kind), ['로컬 폴더', 'SSH 호스트']);
  passed('짧은 고정 목록은 같은 디자인과 키보드로 선택하며 검색창을 표시하지 않음');

  const host = combo(registration, 'SSH 호스트');
  picker = await openSelect(host); await expect(picker.search).toBeVisible(); await expect(picker.search).toBeFocused();
  assert.ok(await picker.listbox.getByRole('option').count() >= 80);
  await picker.search.fill('FIXTURE-HOST-043'); await expect(picker.listbox.getByRole('option')).toHaveCount(1);
  await picker.search.press('Enter'); await expectSelectValue(host, 'fixture-host-043'); await expect(host).toBeFocused();
  passed('호스트 목록에서 대소문자 구분 없이 검색하고 Enter로 선택·포커스 복귀');

  picker = await openSelect(host); await picker.search.fill('없는 호스트 이름');
  await expect(picker.listbox.getByRole('option')).toHaveCount(0); await expect(picker.popup).toContainText('검색 결과가 없습니다.');
  await picker.search.press('Enter'); await expect(picker.popup).toBeVisible(); await expect(registration).toBeVisible(); await expectSelectValue(host, 'fixture-host-043');
  await picker.search.press('Escape'); await expect(host).toBeFocused(); await expectSelectValue(host, 'fixture-host-043');
  passed('검색 결과가 없을 때 저장·선택을 실행하지 않고 Escape로 이전 값 유지');

  picker = await openSelect(host); await picker.search.fill('fixture-host-052');
  await picker.search.dispatchEvent('compositionstart', { data: '' }); await picker.search.press('Enter');
  await expect(picker.popup).toBeVisible(); await expectSelectValue(host, 'fixture-host-043');
  await picker.search.dispatchEvent('compositionend', { data: 'fixture-host-052' }); await picker.search.press('Enter');
  await expectSelectValue(host, 'fixture-host-052');
  passed('입력기 조합 중 Enter 선택을 막고 조합이 끝난 뒤 선택');

  picker = await openSelect(host); await picker.search.fill('fixture-host-070');
  await registration.getByLabel('프로젝트명', { exact: true }).click(); await expect(picker.popup).toBeHidden(); await expectSelectValue(host, 'fixture-host-052');
  picker = await openSelect(host); await expect(picker.search).toHaveValue(''); await picker.search.press('Tab');
  await expect(picker.popup).toBeHidden(); await expect(host).not.toBeFocused();
  passed('외부 클릭과 Tab으로 팝업을 닫고 검색어를 다음 열기에 남기지 않음');

  picker = await openSelect(host);
  await host.focus(); await host.press('End');
  const activeId = await host.getAttribute('aria-activedescendant'); assert.ok(activeId);
  await expect(page.locator(`[id=${JSON.stringify(activeId)}]`)).toContainText('fixture-host-080');
  await host.press('Enter'); await expectSelectValue(host, 'fixture-host-080');
  picker = await openSelect(host);
  const scroll = await picker.listbox.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }));
  assert.ok(scroll.scroll > scroll.client, '긴 목록은 팝업 안에서 스크롤되어야 합니다.');
  await assertPopupBounds(picker.popup, 'long-host-list'); await closeSelect(host);
  passed('긴 목록의 스크롤과 마지막 항목 키보드 이동·선택');

  for (const [width, height, theme] of [[1920, 1080, 'light'], [1024, 700, 'light'], [1024, 700, 'dark']]) {
    await resize(width, height);
    const current = await page.locator('html').getAttribute('data-theme');
    if (current !== theme) await page.getByRole('button', { name: theme === 'dark' ? '어두운 화면' : '밝은 화면', exact: true }).click();
    picker = await openSelect(host); await assertPopupBounds(picker.popup, `${width}-${theme}`);
    const color = await picker.popup.evaluate(element => getComputedStyle(element).backgroundColor);
    measurements[`${width}-${theme}`].background = color;
    await screenshot(`host-list-${width}-${theme}`); await closeSelect(host);
  }
  assert.notEqual(measurements['1024-light'].background, measurements['1024-dark'].background);
  passed('넓은 창·좁은 창·밝은 화면·어두운 화면에서 팝업 잘림과 가로 넘침 없음');

  await selectControl(host, 'fixture-host-037', { search: true });
  await registration.getByLabel('서버 작업 폴더', { exact: true }).fill('/fixture/work');
  await registration.getByRole('button', { name: '프로젝트 등록', exact: true }).click(); await expect(registration).toHaveCount(0);
  const savedProject = (await ipc('snapshot')).projects.find(project => project.name === '검색해서 연결한 프로젝트');
  assert.equal(savedProject.connection.kind, 'ssh'); assert.equal(savedProject.connection.hostAlias, 'fixture-host-037');
  await resize(1600); await openSettings(savedProject, '연결');
  await expectSelectValue(combo(pane(), '접속 방식'), 'ssh'); await expectSelectValue(combo(pane(), 'SSH 호스트'), 'fixture-host-037');
  passed('검색해서 선택한 SSH 호스트를 프로젝트에 저장하고 다시 열어 유지');

  await openSettings(viewerProject, '에이전트');
  const model = combo(pane(), '에이전트 모델'); await typeSelectValue(model, 'fixture-custom-model');
  await expectSelectValue(model, 'fixture-custom-model');
  await pane().getByRole('button', { name: '저장하기', exact: true }).click();
  assert.equal((await ipc('snapshot')).projects.find(project => project.id === viewerProject.id).connection.agentModel, 'fixture-custom-model');
  passed('검색 가능한 모델 목록에서 직접 입력한 값을 프로젝트 설정으로 저장');

  await pane().getByRole('navigation', { name: '프로젝트 기능', exact: true }).getByRole('button', { name: '리뷰', exact: true }).click();
  const surface = pane().locator('.native-browser-surface'); await expect(surface).toHaveAttribute('data-browser-id', /.+/);
  await expect.poll(async () => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL().startsWith(url))?.id, origin)).toBeTruthy();
  nativeId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL().startsWith(url)).id, origin);
  await expect.poll(async () => (await geometry())?.visible).toBe(true); const instance = await native('window.selectFixtureInstance');
  measurements.viewerScale = await expectSelectLabel(combo(pane(), '뷰포트 배율'), '맞춤');
  const attachmentCount = (await ipc('snapshot')).attachments.length;
  const preset = combo(pane(), '화면 크기'); picker = await openSelect(preset);
  await expect(picker.search).toHaveCount(0); await expect.poll(async () => (await geometry())?.visible).toBe(false);
  const preview = surface.locator(':scope > img.native-browser-popup-preview');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(preview).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(preview).toHaveCSS('pointer-events', 'none');
  measurements.viewerPopupPreview = await preview.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  await screenshot('viewer-popup-preview');
  await assertPopupBounds(picker.popup, 'viewer-dropdown'); await selectControl(preset, '모바일');
  await expect(preview).toHaveCount(0); await expect.poll(async () => (await geometry())?.visible).toBe(true); assert.equal(await native('window.selectFixtureInstance'), instance);
  measurements.viewerMobileScale = await expectSelectLabel(combo(pane(), '뷰포트 배율'), '맞춤');
  assert.equal((await ipc('snapshot')).attachments.length, attachmentCount);
  await selectControl(preset, '직접 입력');
  await pane().getByLabel('뷰포트 너비', { exact: true }).fill('320');
  await pane().getByLabel('뷰포트 높이', { exact: true }).fill('240');
  await pane().getByLabel('뷰포트 높이', { exact: true }).press('Enter');
  measurements.viewerFitFullScale = await expectSelectLabel(combo(pane(), '뷰포트 배율'), '맞춤 (100%)');
  passed('뷰어와 겹치는 팝업 동안 화면 이미지를 유지하고 닫은 뒤 같은 페이지를 복원');

  await pane().getByRole('button', { name: '전체화면', exact: true }).click();
  for (const name of ['화면 크기', '뷰포트 배율']) {
    const control = combo(pane(), name); await expect(control).toBeDisabled();
    await control.dispatchEvent('click'); await expect(control).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(page.locator('.reviewops-select-popup')).toHaveCount(0);
  await pane().getByRole('button', { name: '전체화면 종료', exact: true }).click(); await expect(preset).toBeEnabled();
  passed('비활성화된 선택 목록은 열리지 않고 전체화면 종료 후 다시 사용');

  await primary('계정관리').click(); await pane().getByRole('button', { name: '계정 추가', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '계정 추가', exact: true }), loginMethod = combo(dialog, '로그인 방식');
  picker = await openSelect(loginMethod); await expect(picker.search).toHaveCount(0);
  await loginMethod.press('Escape'); await expect(loginMethod).toBeFocused(); await expect(dialog).toBeVisible();
  await selectControl(loginMethod, 'chatgptDeviceCode'); await expectSelectValue(loginMethod, 'chatgptDeviceCode'); await expect(loginMethod).toBeFocused();
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  passed('계정 추가 창의 로그인 방식 선택·Escape·포커스 복귀를 실제 로그인 없이 검사');

  let hostState = await page.evaluate(() => window.hostManager.getState());
  for (let index = 1; index <= 12; index++) hostState = await page.evaluate(({ name, revision }) => window.hostManager.saveGroup({ name }, revision), { name: `검사 호스트 그룹 ${String(index).padStart(2, '0')}`, revision: hostState.revision });
  const targetGroup = hostState.groups.find(group => group.name === '검사 호스트 그룹 11'); assert.ok(targetGroup);
  await primary('호스트관리').click(); await pane().getByRole('button', { name: '호스트 추가', exact: true }).click();
  const hostDialog = page.getByRole('dialog', { name: '호스트 추가', exact: true }), hostGroup = combo(hostDialog, '그룹');
  picker = await openSelect(hostGroup); await picker.search.fill('그룹 11'); await expect(picker.listbox.getByRole('option')).toHaveCount(1);
  await picker.search.press('Enter'); await expectSelectValue(hostGroup, targetGroup.id); await expect(hostGroup).toBeFocused();
  picker = await openSelect(hostGroup); await picker.search.press('Escape'); await expect(hostDialog).toBeVisible();
  await hostDialog.getByRole('button', { name: '취소', exact: true }).click();
  passed('호스트 추가 창 안에서 그룹 검색·선택·닫기를 실제 SSH 접속 없이 검사');

  await primary('그룹').click(); const label = combo(pane(), '그룹 라벨'); await selectControl(label, '문서', { search: true });
  await expectSelectValue(label, '문서'); await pane().getByRole('button', { name: '그룹 라벨 지우기', exact: true }).click(); await expectSelectValue(label, '');
  passed('라벨 필터도 같은 검색·선택 UI를 사용하며 필터 지우기 제공');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { ok: true, version, executable: process.env.REVIEWOPS_TEST_EXECUTABLE || 'development', checks, errors, externalRequests, measurements, testRoot };
  fs.writeFileSync(path.join(resultPath, process.env.REVIEWOPS_TEST_EXECUTABLE ? 'dmg.json' : 'source.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, version, checks: checks.length, testRoot }));
} catch (error) {
  const focus = await page?.evaluate(() => ({ active: document.activeElement?.outerHTML, focused: document.hasFocus() })).catch(() => null);
  await page?.screenshot({ path: path.join(testRoot, 'failure.png') }).catch(() => {});
  if (resultPath) fs.writeFileSync(path.join(resultPath, 'failure.json'), JSON.stringify({ checks, errors, externalRequests, message: error.message, focus, testRoot }, null, 2));
  console.error('SELECTS_FAILURE', testRoot, error); process.exitCode = 1;
} finally {
  if (app) { const timer = setTimeout(() => app.process().kill('SIGKILL'), 10000); try { await app.close(); } finally { clearTimeout(timer); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
