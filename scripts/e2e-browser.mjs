import {setTestLocale} from './test-locale.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-browser-'));
const dataPath = path.join(testRoot, 'data');
const screenshots = path.join(testRoot, 'screenshots');
fs.mkdirSync(screenshots);
fs.writeFileSync(path.join(testRoot, 'private.txt'), 'PRIVATE_HOST_FILE');
const privateURL = pathToFileURL(path.join(testRoot, 'private.txt')).href;
const checks = [], rendererErrors = [], requests = [];
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
let app, page, nativeId, browserId, origin, otherOrigin;
let formPopupBody = '';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const stop = server => new Promise(resolve => server.close(resolve));
const html = (response, title, body, headers = {}) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:24px;background:#eef3f8;color:#172336}input,button{font:inherit;padding:10px;margin:5px}#large{width:1400px;height:1100px;background:linear-gradient(130deg,#d9e9fe,#f8e2d4)}</style></head><body>${body}</body></html>`);
};
const application = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie || '' });
  if (url.pathname === '/login' && request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    assert.equal(new URLSearchParams(body).get('username'), 'fixture-user');
    response.writeHead(303, { Location: '/protected', 'Set-Cookie': 'fixture_auth=authenticated; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400' });
    response.end(); return;
  }
  if (url.pathname === '/protected') {
    if (!(request.headers.cookie || '').includes('fixture_auth=authenticated')) {
      response.writeHead(302, { Location: '/browser' }); response.end(); return;
    }
    html(response, 'Authenticated service', '<h1 id="authenticated">Authenticated service</h1><a id="second" href="/second">Next page</a>'); return;
  }
  if (url.pathname === '/second') {
    html(response, 'Second service page', '<h1>Second page</h1>'); return;
  }
  if (url.pathname === '/popup') {
    html(response, 'Login popup', `<h1>Login popup</h1><button id="approve">Approve login</button><script>document.querySelector('#approve').onclick=()=>{window.opener.postMessage({kind:'login-complete',hasOpener:!!window.opener},'*');window.close()};</script>`, { 'Set-Cookie': 'fixture_popup=approved; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400' }); return;
  }
  if (url.pathname === '/popup-post') {
    let body = ''; for await (const chunk of request) body += chunk;
    formPopupBody = body;
    html(response, 'Form popup', `<h1>POST received</h1><script>window.opener.postMessage({kind:'form-complete',value:${JSON.stringify(body)}},'*');window.close();</script>`); return;
  }
  if (url.pathname === '/download') {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="service-report.txt"' }); response.end('Service report'); return;
  }
  html(response, 'Embedded service', `<h1 id="welcome">Embedded service</h1>
    <form id="login" action="/login" method="post"><label>Username<input name="username" id="username"></label><button id="submit">Sign in</button></form>
    <button id="popup" onclick="window.open('/popup','fixture-login','width=420,height=350')">Open login popup</button>
    <form id="popup-form" method="post" action="/popup-post" target="_blank" rel="opener"><input type="hidden" name="ticket" value="login-ticket"><button id="popup-submit">Submit login popup</button></form>
    <a id="download" href="/download">Download report</a><div id="large">Service canvas</div>
    <script>window.popupMessages=[];window.addEventListener('message',event=>window.popupMessages.push(event.data));window.topLevel=window.top===window;</script>`);
});
const api = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ message: 'cross-origin-response' }));
});

const invoke = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.invoke(action, payload), { action, payload });
const requestIPC = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.request(action, payload), { action, payload });
const state = () => invoke('browser.state', { id: browserId });
const evaluateNative = (script, id = nativeId) => app.evaluate(({ webContents }, { id, script }) => {
  const contents = webContents.fromId(id);
  if (!contents || contents.isDestroyed()) throw new Error(`Missing browser WebContents ${id}`);
  return contents.executeJavaScript(script, true);
}, { id, script });
async function waitNative(script, expected = true) {
  await expect.poll(async () => {
    try { return await evaluateNative(script); } catch { return null; }
  }, { timeout: 15000 }).toEqual(expected);
}
async function findContents(prefix = origin) {
  const ids = await app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().filter(contents => contents.getURL().startsWith(prefix)).map(contents => contents.id), prefix);
  return ids;
}
async function captureNative(name) {
  const encoded = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), nativeId);
  fs.writeFileSync(path.join(screenshots, name), Buffer.from(encoded, 'base64'));
}
async function nativeLayout() {
  return app.evaluate(({ BrowserWindow }, id) => {
    const windows = BrowserWindow.getAllWindows();
    const host = windows.find(window => !window.getParentWindow());
    const hostBounds = host.getContentBounds();
    for (const window of windows) {
      const view = window.contentView.children.find(child => child.webContents?.id === id);
      if (view) {
        const area = window.getContentBounds();
        return { clip: { x: area.x - hostBounds.x, y: area.y - hostBounds.y, width: area.width, height: area.height }, bounds: view.getBounds(), visible: window.isVisible() && view.getVisible() };
      }
    }
    return null;
  }, nativeId);
}
async function launch() {
  const env = { ...process.env, REVIEWOPS_DATA_DIR: dataPath }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root], executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout: 30000 });
  page = await app.firstWindow(); await setTestLocale(page);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.waitForFunction(() => !!window.reviewops?.invoke);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.getParentWindow()).setSize(1500, 1000));
  await expect(page.getByRole('heading', { name: '홈', exact: true })).toBeVisible();
}
async function createBrowser(url = `${origin}/browser`) {
  const created = await invoke('browser.create', { url }); browserId = created.id;
  assert.ok(browserId, 'Native browser returns a stable id');
  await expect.poll(async () => (await findContents(url)).length, { timeout: 15000 }).toBe(1);
  [nativeId] = await findContents(url);
  await invoke('browser.layout', { id: browserId, visible: true, bounds: { x: 100, y: 130, width: 900, height: 600 }, clip: { x: 100, y: 130, width: 900, height: 600 }, viewport: { width: 1200, height: 800, scale: 0.75 } });
  return created;
}
async function navigate(url) {
  await invoke('browser.navigate', { id: browserId, url });
  await expect.poll(async () => (await state()).url, { timeout: 15000 }).toBe(url);
}
async function quit() {
  if (!app) return;
  console.log('CHECK: 앱 종료 및 로그인 저장소 유지');
  await app.close(); app = null; page = null;
}

try {
  origin = await listen(application); otherOrigin = await listen(api);
  await launch(); await createBrowser();
  await waitNative('document.querySelector("#welcome")?.textContent', 'Embedded service');
  assert.equal(await evaluateNative('window.topLevel'), true);
  assert.equal(await evaluateNative('window.frameElement'), null);
  assert.equal((await state()).title, 'Embedded service');
  passed('iframe 차단 응답을 독립된 브라우저 화면으로 표시');

  const preferences = await app.evaluate(({ BrowserWindow, webContents }, id) => ({
    host: BrowserWindow.getAllWindows().find(window => !window.getParentWindow()).webContents.getLastWebPreferences(),
    viewer: webContents.fromId(id).getLastWebPreferences(),
  }), nativeId);
  assert.equal(preferences.host.webSecurity, true);
  assert.equal(preferences.viewer.webSecurity, false);
  assert.equal(preferences.viewer.nodeIntegration, false);
  assert.equal(preferences.viewer.contextIsolation, true);
  assert.equal(preferences.viewer.sandbox, true);
  assert.deepEqual(await evaluateNative('({reviewops:typeof window.reviewops,require:typeof window.require,process:typeof window.process})'), { reviewops: 'undefined', require: 'undefined', process: 'undefined' });
  const cors = await evaluateNative(`fetch(${JSON.stringify(otherOrigin)}).then(response=>response.json())`);
  assert.equal(cors.message, 'cross-origin-response');
  const hostCors = await page.evaluate(url => fetch(url).then(() => true).catch(() => false), otherOrigin);
  assert.equal(hostCors, false);
  passed('외부 화면의 CORS 허용과 앱 본체의 보안·네이티브 기능 분리');

  await waitNative('window.innerWidth', 1200);
  await invoke('browser.layout', { id: browserId, visible: true, bounds: { x: 100, y: 130, width: 390, height: 844 }, clip: { x: 100, y: 160, width: 300, height: 640 }, viewport: { width: 390, height: 844, scale: 1 } });
  await waitNative('window.innerWidth', 390);
  assert.deepEqual(await nativeLayout(), { clip: { x: 100, y: 160, width: 300, height: 640 }, bounds: { x: 0, y: -30, width: 390, height: 844 }, visible: true });
  await captureNative('native-browser-mobile.png');
  await invoke('browser.layout', { id: browserId, visible: false });
  assert.equal((await nativeLayout()).visible, false);
  await invoke('browser.layout', { id: browserId, visible: true, bounds: { x: 100, y: 130, width: 900, height: 600 }, clip: { x: 100, y: 130, width: 900, height: 600 }, viewport: { width: 1200, height: 800, scale: 0.75 } });
  await waitNative('window.innerWidth', 1200);
  passed('화면 크기·축소 배율 및 표시 영역·가리기 반영');

  await evaluateNative(`document.querySelector('#username').value='fixture-user';document.querySelector('#login').requestSubmit();`);
  await waitNative('document.querySelector("#authenticated")?.textContent', 'Authenticated service');
  assert.equal((await state()).url, `${origin}/protected`);
  assert.equal((await state()).canGoBack, true);
  assert.equal(await evaluateNative('document.cookie.includes("fixture_auth")'), false);
  await evaluateNative('localStorage.setItem("fixture-persistent","kept");sessionStorage.setItem("fixture-session","kept")');
  const cookies = await app.evaluate(({ webContents }, id) => webContents.fromId(id).session.cookies.get({ name: 'fixture_auth' }), nativeId);
  assert.equal(cookies.length, 1); assert.equal(cookies[0].httpOnly, true); assert.equal(cookies[0].sameSite, 'strict');
  await evaluateNative('document.querySelector("#second").click()');
  await waitNative('document.title', 'Second service page');
  await expect.poll(async () => (await state()).url).toBe(`${origin}/second`);
  await invoke('browser.back', { id: browserId }); await waitNative('document.title', 'Authenticated service');
  assert.equal((await state()).canGoForward, true);
  await invoke('browser.forward', { id: browserId }); await waitNative('document.title', 'Second service page');
  await invoke('browser.reload', { id: browserId }); await waitNative('document.title', 'Second service page');
  assert.equal(await evaluateNative('sessionStorage.getItem("fixture-session")'), 'kept');
  passed('POST 로그인·리다이렉트·HttpOnly 쿠키 및 실제 방문 기록 이동');

  await navigate(`${origin}/browser`); await waitNative('document.title', 'Embedded service');
  await evaluateNative('document.querySelector("#popup").click()');
  await expect.poll(async () => (await findContents(`${origin}/popup`)).length).toBe(1);
  const [popupId] = await findContents(`${origin}/popup`);
  assert.equal(await evaluateNative('!!window.opener', popupId), true);
  assert.deepEqual(await evaluateNative('({reviewops:typeof window.reviewops,require:typeof window.require})', popupId), { reviewops: 'undefined', require: 'undefined' });
  await evaluateNative('document.querySelector("#approve").click()', popupId);
  await waitNative('window.popupMessages.some(message=>message.kind==="login-complete"&&message.hasOpener)');
  await expect.poll(async () => (await findContents(`${origin}/popup`)).length).toBe(0);
  const popupCookies = await app.evaluate(({ webContents }, id) => webContents.fromId(id).session.cookies.get({ name: 'fixture_popup' }), nativeId);
  assert.equal(popupCookies.length, 1);
  await evaluateNative('document.querySelector("#popup-form").requestSubmit()');
  await waitNative('window.popupMessages.some(message=>message.kind==="form-complete"&&message.value==="ticket=login-ticket")');
  assert.equal(formPopupBody, 'ticket=login-ticket');
  passed('로그인 팝업의 쿠키 공유·opener 응답·POST 새 창 제출');

  for (const url of [privateURL, 'reviewops://app/index.html', 'javascript:alert(1)']) {
    const response = await requestIPC('browser.navigate', { id: browserId, url });
    assert.equal(response.ok, false, `Privileged address must be rejected: ${url}`);
  }
  for (const url of [privateURL, 'reviewops://app/index.html']) {
    const readable = await evaluateNative(`fetch(${JSON.stringify(url)}).then(response=>response.text()).then(()=>true).catch(()=>false)`);
    assert.equal(readable, false, `Remote content must not read ${url}`);
  }
  const safeURL = (await state()).url;
  await evaluateNative(`location.href=${JSON.stringify(privateURL)}`).catch(() => {});
  await expect.poll(async () => (await state()).url).toBe(safeURL);
  passed('외부 사이트에서 앱 내부 주소·Mac 파일·네이티브 기능 접근 차단');

  // Closing a view must keep the shared browsing session; normal app shutdown
  // must retain persistent cookies without test-only storage flushing.
  await invoke('browser.close', { id: browserId });
  await createBrowser(`${origin}/protected`);
  await waitNative('document.title', 'Authenticated service');
  assert.equal(await evaluateNative('localStorage.getItem("fixture-persistent")'), 'kept');
  await quit(); await launch(); await createBrowser(`${origin}/protected`);
  await waitNative('document.title', 'Authenticated service');
  assert.equal(await evaluateNative('localStorage.getItem("fixture-persistent")'), 'kept');
  passed('브라우저 화면 재생성 및 앱 재시작 후 로그인 쿠키·사이트 저장소 유지');

  await captureNative('native-browser-authenticated.png');
  assert.deepEqual(rendererErrors, []);
  const result = { ok: true, executable: process.env.REVIEWOPS_TEST_EXECUTABLE || 'development', testRoot, screenshots, checks, rendererErrors, requestCount: requests.length };
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-results', 'browser.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {});
  console.error('BROWSER E2E FAILURE', testRoot, error); process.exitCode = 1;
} finally {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
    await app.close().catch(() => {});
  }
  await Promise.all([stop(application), stop(api)]);
}
