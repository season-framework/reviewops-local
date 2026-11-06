import {_electron as electron, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTestLocale} from './test-locale.mjs';

// Focused source-app acceptance. These are two logical clients on one physical
// MCP transport, not two genuine external model chats or installed-release QA.
assert.deepEqual(process.argv.slice(2), ['--source']);
const root = fs.realpathSync(process.cwd());
assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim(), '', 'Commit the reviewed source before binding this execution to Git HEAD.');
const owned = fs.realpathSync(fs.mkdtempSync('/tmp/reviewops-controller-'));
fs.chmodSync(owned, 0o700);
const data = path.join(owned, 'data'), work = path.join(owned, 'work');
const output = path.join(root, 'test-results/qa-controller-reconnect', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
for (const directory of [data, work, output]) fs.mkdirSync(directory, {recursive: true, mode: 0o700});
const config = path.join(owned, 'ssh-config');
fs.writeFileSync(config, '# Owned local-only controller feature acceptance\n', {mode: 0o600});
const env = {...process.env, REVIEWOPS_DATA_DIR: data, REVIEWOPS_SSH_CONFIG: config, REVIEWOPS_CODEX_SSH_CONFIG: config};
for (const key of ['ELECTRON_RUN_AS_NODE', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
const checks = [], photos = [], launches = [], controllers = {}, errors = [];
const result = {ok: false, scope: 'Focused source Electron controller isolation and document recovery on one physical MCP. No genuine model, SSH, installed-app, public delivery or whole-product QA claim.',
  source: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), platform: process.platform, arch: process.arch, owned, output, checks, photos, launches, models: 0, sshConnections: 0};
let app, main, server, client, childClose, failure;
const ipc = (page, action, payload = {}) => page.evaluate(({action, payload}) => window.reviewops.invoke(action, payload), {action, payload});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {const value = await read();if (accept(value)) return value;await wait(100);}
  throw new Error('Timed out: ' + label);
}
async function bounded(promise, label, timeout = 20000) {
  let timer;try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(label + ' timed out; existing owned work was not restarted.')), timeout);})]);} finally {clearTimeout(timer);}
}
const pass = name => {checks.push(name);console.log('PASS: ' + name);};
const safeBinding = value => Object.fromEntries(['appInstanceId', 'controllerId', 'projectId', 'reviewId', 'sessionId', 'windowId', 'generation', 'state', 'expiresAt'].map(key => [key, value[key]]));
const proof = value => ({appInstanceId: value.appInstanceId, controllerId: value.controllerId, controllerProof: value.controllerProof, projectId: value.projectId});
const center = element => {assert.ok(element?.rect, 'The observed input is missing.');return {x: Math.round(element.rect.x + element.rect.width / 2), y: Math.round(element.rect.y + element.rect.height / 2)};};
class Mcp {
  constructor() {
    this.next = 0;this.pending = new Map();this.buffer = '';this.stderr = '';
    this.child = spawn(process.execPath, [path.join(root, 'electron/mcp-server.cjs'), '--data-path', data], {env, stdio: ['pipe', 'pipe', 'pipe']});
    const record = {kind: 'physical-mcp', pid: this.child.pid, exit: null};launches.push(record);
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);this.buffer = this.buffer.slice(end + 1);if (!line.trim()) continue;
        let value;try {value = JSON.parse(line);} catch {this.abort(new Error('MCP returned non-JSON stdout.'));continue;}
        const pending = this.pending.get(value.id);if (!pending) continue;
        this.pending.delete(value.id);clearTimeout(pending.timer);value.error ? pending.reject(new Error('MCP protocol request failed.')) : pending.resolve(value.result);
      }
    });
    this.child.stderr.on('data', chunk => {this.stderr = (this.stderr + chunk).slice(-8192);});
    this.child.on('error', error => this.abort(error));this.child.stdin.on('error', error => this.abort(error));
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {record.exit = {code, signal};this.abort(new Error('Owned physical MCP closed.'));resolve(record.exit);}));
  }
  abort(error) {for (const pending of this.pending.values()) {clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();}
  request(method, params) {return new Promise((resolve, reject) => {
    const id = ++this.next, timer = setTimeout(() => {this.pending.delete(id);reject(new Error('MCP request timed out: ' + method));}, 45000);
    this.pending.set(id, {resolve, reject, timer});this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });}
  async initialize() {
    await this.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'owned-controller-feature', version: '1'}});
    this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
    const tools = await this.request('tools/list', {});assert.ok(tools.tools.some(tool => tool.name === 'reviewops_qa_controller'));
  }
  raw(args) {return this.request('tools/call', {name: 'reviewops_qa_controller', arguments: args});}
  async call(args) {
    const value = await this.raw(args);
    if (value.isError) {
      const text = value.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      let refusal;try {refusal = JSON.parse(text);} catch {refusal = {};}
      throw Object.assign(new Error('Controller operation ' + args.operation + ' refused: ' + text), {code: refusal.code});
    }
    const text = value.content.find(item => item.type === 'text')?.text;
    const parsed = value.structuredContent ?? JSON.parse(text);
    const image = value.content.find(item => item.type === 'image');return image ? {...parsed, data: image.data} : parsed;
  }
  async close() {if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();assert.deepEqual(await bounded(this.closed, 'owned MCP natural exit'), {code: 0, signal: null});}
}
const call = (key, operation, fields = {}) => client.call({...proof(controllers[key]), operation, ...fields});
async function projectPage(value) {return until(async () => {
  for (const page of app.windows()) if (!page.isClosed() && page.url().startsWith('reviewops://app/')) {
    const context = await ipc(page, 'window.context');if (context.windowId === value.windowId && context.projectId === value.projectId) return page;
  }
}, Boolean, 'exact project host');}
async function browser(key, url) {
  return until(async () => {
    try {
      const state = await call(key, 'state'), target = state.browsers?.find(row => row.url === url && row.visible);
      if (!target) return null;
      const web = await call(key, 'state', {browserId: target.browserId});
      return web.elements.some(row => row.tag?.toLowerCase() === 'input') ? target.browserId : null;
    } catch (error) {if (error.code === 'QA_DOCUMENT_NOT_READY') return null;throw error;}
  }, Boolean, 'exact ready project browser');
}
async function input(key, browserId, text) {
  const state = await call(key, 'state', {browserId});
  const element = state.elements.find(row => row.tag?.toLowerCase() === 'input' && row.type !== 'hidden');
  await call(key, 'click', {browserId, observationId: state.observationId, ...center(element)});
  await call(key, 'key', {browserId, observationId: state.observationId, key: 'a', modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control']});
  await call(key, 'type', {browserId, observationId: state.observationId, text});
}
async function contentsValue(url) {
  return app.evaluate(async ({webContents}, url) => {
    const all = webContents.getAllWebContents().filter(value => !value.isDestroyed() && value.getURL() === url);
    if (all.length !== 1) throw new Error('The exact owned browser is not unique.');
    return all[0].executeJavaScript('({draft:document.querySelector("#draft").value,instance:window.instance,scrollY})');
  }, url);
}
async function photo(page, name) {await page.screenshot({path: path.join(output, name)});photos.push(name);}
try {
  server = http.createServer((request, response) => {
    const key = request.url === '/A' ? 'A' : request.url === '/B' ? 'B' : null;
    if (!key) {response.writeHead(404);response.end();return;}
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end('<!doctype html><meta charset="utf-8"><title>Owned controller ' + key + '</title><style>body{font:24px sans-serif;padding:30px;min-height:2600px;background:#edf6ff}input{display:block;font:inherit;width:75%;padding:10px;margin-top:20px}</style><h1>Controller ' + key + '</h1><label>Draft ' + key + '<input id="draft"></label><p>Each controller preserves its own input and scroll.</p><script>window.instance=crypto.randomUUID()</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));const origin = 'http://127.0.0.1:' + server.address().port;
  app = await electron.launch({args: [root], env, timeout: 60000});const child = app.process();
  const launch = {kind: 'source-electron', pid: child.pid, exit: null};launches.push(launch);
  childClose = new Promise(resolve => child.once('close', (code, signal) => {launch.exit = {code, signal};resolve(launch.exit);}));
  main = await app.firstWindow();await setTestLocale(main);main.on('pageerror', error => errors.push(error.message));
  assert.equal(await app.evaluate(({app}) => app.isPackaged), false);
  await ipc(main, 'update.configure', {automatic: false});
  const group = await ipc(main, 'group.save', {name: 'Controller feature'}), projects = {};
  for (const key of ['A', 'B']) {
    const folder = path.join(work, key);fs.mkdirSync(folder);
    projects[key] = await ipc(main, 'project.save', {groupId: group.id, name: 'Controller project ' + key, connection: {kind: 'local', rootPath: folder, viewerUrl: origin + '/' + key}});
  }
  client = new Mcp();await client.initialize();
  controllers.A = await client.call({operation: 'open', projectId: projects.A.id, label: 'Chat A'});
  const pageA = await projectPage(controllers.A), browserA = await browser('A', origin + '/A');
  await input('A', browserA, 'A_UNSAVED_DRAFT');const originalA = await contentsValue(origin + '/A');
  const beforeB = safeBinding(await call('A', 'status'));
  controllers.B = await client.call({operation: 'open', projectId: projects.B.id, label: 'Chat B'});
  let pageB = await projectPage(controllers.B), browserB = await browser('B', origin + '/B');
  assert.notEqual(controllers.A.windowId, controllers.B.windowId);
  assert.deepEqual(safeBinding(await call('A', 'status')), beforeB);assert.deepEqual(await contentsValue(origin + '/A'), originalA);
  await expect(pageA.locator('.workspace-qa-scope')).toContainText('Chat A');await expect(pageB.locator('.workspace-qa-scope')).toContainText('Chat B');
  pass('Fresh B attaches on the same physical MCP without replacing A or its unsaved browser draft.');
  await Promise.all([input('A', browserA, 'A_PARALLEL_ONLY'), input('B', browserB, 'B_PARALLEL_ONLY')]);
  assert.equal((await contentsValue(origin + '/A')).draft, 'A_PARALLEL_ONLY');assert.equal((await contentsValue(origin + '/B')).draft, 'B_PARALLEL_ONLY');
  const forged = await client.raw({...proof(controllers.B), controllerProof: controllers.A.controllerProof, operation: 'detach'});assert.equal(forged.isError, true);
  await photo(pageA, '01-a-attached.png');await photo(pageB, '02-b-attached.png');
  pass('Independent inputs and visible controller labels remain scoped; a foreign controller proof is refused.');
  const retainedA = safeBinding(await call('A', 'status')), retainedDraft = await contentsValue(origin + '/A');
  const oldB = await call('B', 'state', {browserId: browserB});
  await call('B', 'detach');await expect(pageB.locator('.workspace-qa-scope')).toContainText('Chat B');
  assert.equal((await client.raw({...proof(controllers.B), operation: 'type', browserId: browserB, observationId: oldB.observationId, text: 'MUST_NOT_REPLAY'})).isError, true);
  const resumedB = await call('B', 'reconnect');assert.equal(resumedB.windowId, controllers.B.windowId);assert.equal(resumedB.sessionId, controllers.B.sessionId);
  assert.equal((await client.raw({...proof(controllers.B), operation: 'type', browserId: browserB, observationId: oldB.observationId, text: 'MUST_NOT_REPLAY'})).isError, true);
  assert.equal((await contentsValue(origin + '/B')).draft, 'B_PARALLEL_ONLY');
  assert.deepEqual(safeBinding(await call('A', 'status')), retainedA);assert.deepEqual(await contentsValue(origin + '/A'), retainedDraft);
  await input('B', browserB, 'B_AFTER_RECONNECT');pass('B-only detach/reconnect preserves A and requires a new observation without replaying old input.');
  const hostObservation = await call('B', 'state');await pageB.reload();await expect(pageB.locator('.workspace-qa-scope')).toContainText('Chat B');
  const staleHost = await client.raw({...proof(controllers.B), operation: 'type', observationId: hostObservation.observationId, text: 'MUST_NOT_REPLAY'});assert.equal(staleHost.isError, true);
  await call('B', 'reconnect');browserB = await browser('B', origin + '/B');await input('B', browserB, 'B_AFTER_USER_RELOAD');
  assert.deepEqual(safeBinding(await call('A', 'status')), retainedA);assert.deepEqual(await contentsValue(origin + '/A'), retainedDraft);
  pass('A user reload invalidates B host observations; fresh B recovery leaves A unchanged.');
  const oldWindow = controllers.B.windowId, handle = await app.browserWindow(pageB);await handle.evaluate(window => window.close());
  await until(() => pageB.isClosed(), Boolean, 'normal B window closure');
  const reopened = await call('B', 'reconnect');assert.notEqual(reopened.windowId, oldWindow);assert.notEqual(reopened.sessionId, controllers.B.sessionId);
  pageB = await projectPage(reopened);browserB = await browser('B', origin + '/B');await input('B', browserB, 'B_NEW_WINDOW_ONLY');
  assert.deepEqual(safeBinding(await call('A', 'status')), retainedA);assert.deepEqual(await contentsValue(origin + '/A'), retainedDraft);
  await photo(pageB, '03-b-new-window.png');pass('Normally closed B is recreated only for its original project/controller while A retains its exact lease and draft.');
  const beforeEOF = {A: safeBinding(await call('A', 'status')), B: safeBinding(await call('B', 'status'))};
  await client.close();client = new Mcp();await client.initialize();
  for (const key of ['A', 'B']) assert.deepEqual(safeBinding(await call(key, 'status')), beforeEOF[key]);
  assert.deepEqual(await contentsValue(origin + '/A'), retainedDraft);await call('A', 'capture', {browserId: browserA});
  pass('Physical MCP EOF retains the opt-in app-owned controllers; the same proofs recover exact bindings on a new transport.');
  for (const key of ['A', 'B']) await call(key, 'release');
  await expect(pageA.locator('.workspace-app')).toHaveAttribute('data-qa-project-id', '');await expect(pageB.locator('.workspace-app')).toHaveAttribute('data-qa-project-id', '');
  assert.deepEqual(errors, []);result.bindings = beforeEOF;result.ok = true;
} catch (error) {
  failure = error;result.error = error.message;
  if (main && !main.isClosed()) await photo(main, 'failure.png').catch(() => {});
} finally {
  if (client) {
    for (const key of ['A', 'B']) if (controllers[key]) await call(key, 'release').catch(() => {});
    await client.close().catch(error => {failure ||= error;result.cleanupError = error.message;});
  }
  if (app) try {await bounded(app.close(), 'owned source app graceful close', 30000);assert.deepEqual(await bounded(childClose, 'original Electron natural exit'), {code: 0, signal: null});} catch (error) {failure ||= error;result.cleanupError = error.message;}
  if (server) await new Promise(resolve => server.close(resolve));
  result.ok &&= !failure;result.pageErrors = errors;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', {mode: 0o600});console.log('Result: ' + path.join(output, 'result.json'));
}
if (failure) throw failure;
