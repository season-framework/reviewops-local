import {setTestLocale} from './test-locale.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-browser-quit-'));
const files = path.join(testRoot, 'files');
fs.mkdirSync(files);
const checks = [], errors = [];
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>${request.url === '/popup' ? 'Quit test popup' : 'Quit test service'}</title><h1>Quit test fixture</h1><input id="draft" aria-label="External draft"><script>window.instanceId=crypto.randomUUID();</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let app, page;
const ipc = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.invoke(action, payload), { action, payload });
const native = (id, expression) => app.evaluate(({ webContents }, { id, expression }) => webContents.fromId(id).executeJavaScript(expression, true), { id, expression });

try {
  const env = { ...process.env, REVIEWOPS_DATA_DIR: path.join(testRoot, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root], executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout: 30000 });
  page = await app.firstWindow(); await setTestLocale(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.reviewops?.invoke);
  const group = await ipc('group.save', { name: '종료 검사' });
  const service = await ipc('service.save', { name: '종료 검사 서비스', groupId: group.id, kind: 'local', rootPath: files, viewerUrl: origin });
  const project = await ipc('project.save', { name: '종료 검사 프로젝트', groupId: group.id, serviceIds: [service.id] });
  await ipc('review.save', { title: '종료 검사 리뷰', projectId: project.id, serviceId: service.id });
  await page.locator('.workspace-refresh').click();
  await page.getByRole('button', { name: `${project.name} 프로젝트 열기`, exact: true }).click();
  const pane = page.locator('.workspace-pane:not([hidden])');
  await expect(pane.locator('.native-browser-surface')).toHaveAttribute('data-browser-id', /.+/);
  await expect.poll(() => app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/`)?.id, origin)).toBeTruthy();
  const nativeId = await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find(contents => contents.getURL() === `${origin}/`).id, origin);
  const geometry = () => app.evaluate(({ BrowserWindow }, nativeId) => {
    const child = BrowserWindow.getAllWindows().find(window => window.contentView.children.some(view => view.webContents?.id === nativeId));
    return child ? { id: child.id, visible: child.isVisible() } : null;
  }, nativeId);
  await expect.poll(async () => (await geometry())?.visible).toBe(true);
  const child = await geometry();
  const instance = await native(nativeId, 'document.querySelector("#draft").value="외부 화면 작성 내용"; window.instanceId');
  await native(nativeId, `window.open(${JSON.stringify(origin + '/popup')},'reviewops-quit-popup'); void 0`);
  await expect.poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)?.id, origin + '/popup')).toBeTruthy();
  const popupId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url).id, origin + '/popup');
  const popupInstance = await native(popupId, 'document.querySelector("#draft").value="팝업 작성 내용"; window.instanceId');
  await pane.getByRole('navigation', { name: '프로젝트 기능', exact: true }).getByRole('button', { name: '설정', exact: true }).click();
  const name = pane.locator('.original-project-settings').getByLabel('프로젝트명', { exact: true });
  await name.fill('저장 전 프로젝트 이름');
  await expect.poll(() => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);

  // A surface belongs to the host; closing it by itself must not lose the page.
  await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id).close(); }, child.id);
  assert.deepEqual(await geometry(), child);
  assert.equal(await native(nativeId, 'window.instanceId'), instance);
  passed('외부 화면의 독립 종료를 막고 페이지 유지');

  await app.evaluate(({ dialog }) => {
    globalThis.quitTestDialogs = 0;
    dialog.showMessageBoxSync = () => { globalThis.quitTestDialogs += 1; return 0; };
  });
  await app.evaluate(({ app }) => { app.quit(); });
  await expect.poll(() => app.evaluate(() => globalThis.quitTestDialogs)).toBe(1);
  assert.equal(app.process().exitCode, null);
  assert.deepEqual(await geometry(), child);
  assert.equal(await native(nativeId, 'window.instanceId'), instance);
  assert.equal(await native(nativeId, 'document.querySelector("#draft").value'), '외부 화면 작성 내용');
  assert.equal(await native(popupId, 'window.instanceId'), popupInstance);
  assert.equal(await native(popupId, 'document.querySelector("#draft").value'), '팝업 작성 내용');
  await expect(name).toHaveValue('저장 전 프로젝트 이름');
  assert.equal((await ipc('snapshot')).projects.find(item => item.id === project.id).name, project.name);
  passed('종료 취소 후 프로젝트 초안·외부 화면·팝업의 작성 내용 유지');

  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
  const appProcess = app.process();
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('실제 앱 종료가 10초 안에 완료되지 않았습니다.')), 10000);
    appProcess.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 20); });
  const result = await exited;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  app = null;
  passed('작성 내용 버리기 선택 후 자식 화면과 팝업을 정리하고 앱 종료');
  assert.deepEqual(errors, []);
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-results', 'browser-quit.json'), JSON.stringify({ ok: true, executable: process.env?.REVIEWOPS_TEST_EXECUTABLE || 'development', testRoot, checks, errors }, null, 2));
} finally {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy(); }).catch(() => {});
    await app.close().catch(() => {});
  }
  await new Promise(resolve => server.close(resolve));
}
