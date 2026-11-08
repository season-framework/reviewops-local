import {_electron as electron, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createOpsUiAdmission} from './ops-ui-admission.mjs';
import {expectedPackagedSourceFiles, comparePackagedElectronTree} from './packaged-source-policy.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {setTestLocale} from './test-locale.mjs';

// UI-only negative-state acceptance. This test uses the established private
// main-IPC interception pattern from e2e-settings-ui/e2e-test-updates. It does
// not add a shipping fixture flag, call native identity storage, request OS
// approval, enable a listener, or represent a successful connection recovery.
if (process.argv.includes('--help')) {
 console.log('Render the real full ReviewOps window with a synthetic existing-identity read refusal (-25293). An inert provider, real remote coordinator and separate private Store supply only state/read-only retry responses. No OS approval, Keychain enrollment, saved-connection recovery, model turn or hardware acceptance. REVIEWOPS_QA_OUTPUT must be fresh/absolute. The four existing native admission environment values are required together for an installed lane.');
 process.exit(0);
}
const root = fs.realpathSync(process.cwd()), require = createRequire(import.meta.url), asar = require('@electron/asar');
const sourceCommit = process.env.REVIEWOPS_EXPECTED_BUILD_INFO ? JSON.parse(fs.readFileSync(process.env.REVIEWOPS_EXPECTED_BUILD_INFO, 'utf8')).commit : execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const readSource = name => execFileSync('git', ['show', sourceCommit + ':' + name], {cwd: root, maxBuffer: 16 * 1024 ** 2});
const sha = value => createHash('sha256').update(value).digest('hex');
const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', sourceCommit, '--', 'electron'], {cwd: root, encoding: 'utf8'}).trim().split('\n').filter(Boolean);
const policyPath = 'scripts/packaged-source-policy.mjs', policyBytes = readSource(policyPath);
assert.deepEqual(fs.readFileSync(path.join(root, policyPath)), policyBytes, 'Use the selected producer source admission policy');
const selectedArchive = process.env.REVIEWOPS_TEST_EXECUTABLE ? path.resolve(path.dirname(fs.realpathSync(process.env.REVIEWOPS_TEST_EXECUTABLE)), '../Resources/app.asar') : null;
const bindingFiles = selectedArchive ? expectedPackagedSourceFiles(tracked, asar.listPackage(selectedArchive)) : tracked;
const omitted = tracked.filter(name => !bindingFiles.includes(name));
assert.ok(omitted.length <= 1 && omitted.every(name => name === 'electron/native/.gitignore'));
const admission = await createOpsUiAdmission({sourceRoot: root, files: bindingFiles});
if (selectedArchive) {
 const tree = comparePackagedElectronTree(admission.record.archive, {asar, sourceFiles: tracked, readSource, platform: 'darwin'});
 assert.deepEqual(tree.source.map(row => row.path).sort(), bindingFiles.slice().sort());
 assert.deepEqual(tree.omittedRepositoryControlFiles, omitted); assert.equal(tree.generatedNative.length, 3);
 admission.record.packagedElectronTree = {...tree, sourcePolicy: {path: policyPath, sourceCommit, sha256: sha(policyBytes)}};
} else {
 for (const name of [...tracked, 'src/RemoteManagementSettings.jsx', 'src/i18n/en.json']) assert.deepEqual(fs.readFileSync(path.join(root, name)), readSource(name), 'Source fixture must run after the shared source freeze: ' + name);
}
function inventory(directory) {
 const rows = [];
 function walk(base) {
  for (const entry of fs.readdirSync(base, {withFileTypes: true})) {
   const file = path.join(base, entry.name), relative = path.relative(directory, file), stat = fs.lstatSync(file);
   if (stat.isSymbolicLink()) rows.push({path: relative, type: 'symlink', target: fs.readlinkSync(file)});
   else if (stat.isDirectory()) walk(file);
   else { assert.ok(stat.isFile()); rows.push({path: relative, type: 'file', bytes: stat.size, sha256: sha(fs.readFileSync(file))}); }
  }
 }
 walk(directory); return rows.sort((a, b) => a.path.localeCompare(b.path));
}
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-existing-identity-guidance-')));
const dataPath = path.join(fixture, 'data'), home = path.join(fixture, 'home'), coordinatorData = path.join(fixture, 'coordinator'), config = path.join(fixture, 'ssh-config');
const output = process.env.REVIEWOPS_QA_OUTPUT || path.join(root, 'test-results/existing-identity-guidance', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
assert.ok(path.isAbsolute(output) && !fs.existsSync(output), 'Preserve prior evidence; select a fresh absolute output directory');
fs.mkdirSync(output, {recursive: true}); fs.mkdirSync(path.join(dataPath, 'updates'), {recursive: true});
fs.writeFileSync(config, '# Owned synthetic identity-guidance UI fixture\n');
fs.writeFileSync(path.join(dataPath, 'updates/settings.json'), JSON.stringify({automatic: false, intervalMinutes: 10}));
const fixtureRuntimeEnvironment = Object.fromEntries(Object.entries(isolatedModelRuntime({home, dataPath})).filter(([key]) => !['HOME', 'CODEX_HOME'].includes(key)));
const env = {...process.env, ...fixtureRuntimeEnvironment, REVIEWOPS_DATA_DIR: dataPath, REVIEWOPS_SSH_CONFIG: config, REVIEWOPS_CODEX_SSH_CONFIG: config};
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_ACCESS_TOKEN']) delete env[key];
for (const key of ['HOME', 'CODEX_HOME']) assert.equal(env[key], process.env[key], 'Keep inherited ' + key + ' unchanged; the private PATH and explicit runtime lookup isolate this fixture.');
const checks = [], photos = [], errors = [], externalRequests = [], packageIntegrity = [];
let app, page, failure, fixtureObservation, exit, expectedInventory;
const guardedDirectory = admission.record.lane === 'source' ? path.join(root, 'dist') : path.resolve(path.dirname(admission.record.executable), '../..');
if (admission.record.lane === 'installed-test-candidate') {
 const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-identity-guidance-original-'));
 try { execFileSync('/usr/bin/ditto', ['-x', '-k', admission.record.package.zip, extracted]); expectedInventory = inventory(path.join(extracted, 'ReviewOps.app')); }
 finally { fs.rmSync(extracted, {recursive: true, force: true}); }
} else expectedInventory = inventory(guardedDirectory);
function verifyFiles(stage) {
 const actual = inventory(guardedDirectory); assert.deepEqual(actual, expectedInventory, 'Original bundle or source renderer bytes must remain exact');
 if (admission.record.lane === 'installed-test-candidate') execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', guardedDirectory]);
 packageIntegrity.push({stage, entries: actual.length, inventorySHA256: sha(Buffer.from(JSON.stringify(actual))), originalBytesAndSymlinksPreserved: true});
}
const remote = () => page.locator('.workspace-pane:not([hidden]) .remote-management-settings');
const identitySection = () => remote().getByRole('region', {name: '이 컴퓨터 신원', exact: true});
const guidance = () => identitySection().locator('details').filter({has: page.locator('summary', {hasText: 'macOS에서 기존 신원 접근 확인'})});
const observe = () => app.evaluate(() => ({...globalThis.existingIdentityGuidanceFixture.observation, state: globalThis.existingIdentityGuidanceFixture.manager.state()}));
const photo = async name => { await page.screenshot({path: path.join(output, name), fullPage: false}); photos.push(name); };
const pass = (id, actual) => { checks.push({id, actual, status: 'pass'}); console.log('PASS ' + id + ': ' + actual); };
try {
 verifyFiles('before-launch');
 app = await electron.launch({...admission.launchOptions, env, timeout: 60000}); app.process().once('exit', (code, signal) => { exit = {code, signal}; });
 page = await app.firstWindow(); page.setDefaultTimeout(20000);
 page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
 await admission.verify(app, page, dataPath); assert.deepEqual(await app.evaluate(() => ({HOME: process.env.HOME ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null})), {HOME: process.env.HOME ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null}); await setTestLocale(page);
 await expect(page.getByRole('heading', {name: '홈', exact: true})).toBeVisible();
 assert.equal(fs.existsSync(path.join(dataPath, 'remote-device-identity')), false, 'Start without an enrolled or pending real identity');
 await app.evaluate(({app, BrowserWindow, ipcMain}, {dataPath, coordinatorData}) => {
  const require = process.mainModule.require.bind(process.mainModule), path = require('node:path');
  if (app.getPath('userData') !== dataPath) throw new Error('Unexpected profile owner.');
  const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('reviewops://app/'));
  if (!window) throw new Error('Original app window not found.'); window.setSize(1600, 1100);
  const source = app.getAppPath(), original = ipcMain._invokeHandlers.get('reviewops:invoke');
  const observation = {syntheticReadRefusal: true, retryCalls: 0, enrollmentCalls: 0, tlsCalls: 0, certificateCalls: 0, agentCalls: 0, blockedMutations: [], calls: [], osApprovalRequested: false};
  const identity = {status: 'unavailable', backend: 'macos-default-file-keychain', identity: null, errorCode: 'IDENTITY_UNAVAILABLE', diagnostic: {version: 1, source: 'live-operation', stage: 'verify-protected-item', code: 'ITEM_READ_FAILED', osStatus: -25293, mayRemain: true, cleanup: 'not-attempted'}};
  const refused = () => { throw Object.assign(new Error('This controlled fixture cannot perform identity or network operations.'), {code: 'IDENTITY_UNAVAILABLE'}); };
  const provider = Object.freeze({
   state: () => structuredClone(identity),
   async retryExisting(input) { input.assertCurrent(); observation.retryCalls++; input.assertCurrent(); return structuredClone(identity); },
   async initialize() { observation.enrollmentCalls++; refused(); },
   async acquireServerTLS() { observation.tlsCalls++; refused(); },
   publicCertificate() { observation.certificateCalls++; refused(); },
   async closeAndDrain() {}
  });
  const store = require(path.join(source, 'electron/store.cjs')).createStore({dbPath: path.join(coordinatorData, 'reviewops.sqlite')});
  const manager = require(path.join(source, 'electron/remote-management.cjs')).createRemoteManagement({store, identityProvider: provider, assetDirectory: path.join(source, 'dist'), enqueueRead: callback => callback(), executeAgent: () => { observation.agentCalls++; refused(); }});
  const f = globalThis.existingIdentityGuidanceFixture = {manager, observation, original, windowId: window.id};
  ipcMain.removeHandler('reviewops:invoke');
  ipcMain.handle('reviewops:invoke', async (event, action, payload = {}) => {
   if (!action.startsWith('remoteManagement.') && !action.startsWith('remoteApp.')) return original(event, action, payload);
   if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return {ok: false, error: {code: 'ACCESS_DENIED', message: 'Only the original controlled app window is admitted.'}};
   f.observation.calls.push({action, payload});
   if (action === 'remoteApp.state') return {ok: true, data: {connections: [], pendingCommands: [], pendingUploads: []}};
   try {
    if (action === 'remoteManagement.state') return {ok: true, data: manager.state()};
    if (action === 'remoteManagement.retryExistingIdentity') return {ok: true, data: await manager.retryExistingIdentity(payload, () => {})};
    f.observation.blockedMutations.push(action); refused();
   } catch (error) { return {ok: false, error: {code: error.code || 'IDENTITY_UNAVAILABLE', message: 'Controlled read refusal; no OS storage operation was requested.'}}; }
  });
 }, {dataPath, coordinatorData});
 await page.locator('.sidebar-bottom').getByRole('button', {name: '설정', exact: true}).click();
 await page.locator('.settings-section-menu').getByRole('button', {name: '원격 관리', exact: true}).click();
 await expect(identitySection().getByText('이 컴퓨터에서 보안 저장소를 사용할 수 없습니다.', {exact: true})).toBeVisible();
 await expect(identitySection().getByText('-25293', {exact: true})).toBeVisible();
 await expect(identitySection().getByRole('button', {name: '컴퓨터 신원 설정', exact: true})).toBeDisabled();
 await expect(identitySection().getByRole('button', {name: '기존 신원 읽기 다시 시도', exact: true})).toBeEnabled();
 await expect(guidance()).not.toHaveAttribute('open', '');
 await identitySection().evaluate(node => node.scrollIntoView({block: 'start'}));
 await photo('01-synthetic-read-refusal-collapsed.png');
 pass('IDENTITY-GUIDANCE-01', 'The real source/native app renders the controlled read-refusal diagnostic, keeps new enrollment disabled, and offers the existing read-only retry with the macOS guide initially collapsed.');
 await guidance().locator('summary').focus(); await page.keyboard.press('Enter');
 await expect(guidance()).toHaveAttribute('open', '');
 await expect(guidance().locator('li')).toHaveCount(3);
 await expect(guidance()).toContainText('macOS 접근 승인 창을 띄우지 않습니다.');
 await expect(guidance().locator('code')).toHaveText('kr.co.season.reviewops.remote-device-identity.v1');
 await expect(guidance()).toContainText('해당 앱만 개별적으로');
 await expect(guidance()).toContainText('신원 확인이 성공하면 기존 저장 연결로 다시 접속');
 await expect(guidance()).toContainText('같은 서비스의 항목이 여러 개');
 await expect(guidance()).toContainText('암호 표시와 모든 응용 프로그램 접근 허용은 필요하지 않습니다.');
 await expect(guidance()).toContainText('기존 항목과 접속 정보를 보존하십시오.');
 assert.equal(await guidance().locator('a,button,input,form').count(), 0, 'The guide itself cannot open OS approval or mutate access settings');
 await identitySection().evaluate(node => node.scrollIntoView({block: 'start'}));
 await photo('02-synthetic-read-refusal-guidance-expanded.png');
 pass('IDENTITY-GUIDANCE-02', 'Keyboard expansion shows the actual three-step per-existing-item/per-app guide, fixed native service, conditional reconnection wording and preservation instructions. No OS authorization UI is opened.');
 await identitySection().getByRole('button', {name: '기존 신원 읽기 다시 시도', exact: true}).click();
 await expect.poll(async () => (await observe()).retryCalls).toBe(1);
 await expect(identitySection().getByRole('button', {name: '기존 신원 읽기 다시 시도', exact: true})).toBeEnabled();
 await expect(identitySection().getByText('이 컴퓨터에서 보안 저장소를 사용할 수 없습니다.', {exact: true})).toBeVisible();
 await expect(identitySection().getByText('-25293', {exact: true})).toBeVisible();
 fixtureObservation = await observe();
 assert.equal(fixtureObservation.state.identity.status, 'unavailable'); assert.equal(fixtureObservation.state.web.enabled, false); assert.equal(fixtureObservation.state.app.enabled, false);
 for (const key of ['enrollmentCalls', 'tlsCalls', 'certificateCalls', 'agentCalls']) assert.equal(fixtureObservation[key], 0);
 assert.deepEqual(fixtureObservation.blockedMutations, []); assert.equal(fixtureObservation.osApprovalRequested, false);
 assert.equal(fs.existsSync(path.join(dataPath, 'remote-device-identity')), false);
 assert.equal(fs.existsSync(path.join(coordinatorData, 'remote-device-identity')), false);
 assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
 await identitySection().evaluate(node => node.scrollIntoView({block: 'start'})); await photo('03-synthetic-read-refusal-after-retry.png');
 pass('IDENTITY-GUIDANCE-03', 'One real renderer/preload retry reaches the actual coordinator and inert provider exactly once; denial remains visible, listeners remain off, and no native identity profile, enrollment, TLS, certificate or agent action is created. This does not establish OS approval or saved-connection recovery.');
} catch (error) { failure = {message: error.message, stack: error.stack}; process.exitCode = 1; if (page && app) await photo('failure.png').catch(() => {}); }
finally {
 if (app) {
  try {
   await app.evaluate(async ({ipcMain}) => { const f = globalThis.existingIdentityGuidanceFixture; if (!f) return; ipcMain.removeHandler('reviewops:invoke'); ipcMain.handle('reviewops:invoke', f.original); await f.manager.closeAndDrain(); delete globalThis.existingIdentityGuidanceFixture; });
   await app.close(); app = null;
   const deadline = Date.now() + 30000; while (!exit && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
   assert.deepEqual(exit, {code: 0, signal: null}); verifyFiles('after-clean-exit');
  } catch (error) { failure ||= {message: error.message, stack: error.stack}; process.exitCode = 1; }
 }
 const photoFiles = photos.map(name => { const file = path.join(output, name); return {name, bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)), fullAppWindow: true, syntheticReadRefusal: true}; });
 const result = {ok: !failure && checks.length === 3, checks, photos: photoFiles, errors, externalRequests, failure, exit, fixtureObservation, admission: admission.record, packageIntegrity, sourceCommit, syntheticReadRefusal: true, actualOsApproval: false, actualSavedConnectionRecovery: false, actualModelTurns: 0, environmentIsolation: {inheritedHomeAndCodexHomePreserved: true, privateFixturePATHAndExplicitRuntime: true, explicitPrivateDataPath: true}, scope: 'Actual unmodified full ReviewOps renderer and preload with a test-only narrow main IPC response fixture, real coordinator and separate private Store. Precise synthetic -25293 state and denied retry only; no native identity storage operation, enrollment, OS approval, listener/network setup, hardware or comprehensive QA acceptance.', output};
 if (!failure) fs.rmSync(fixture, {recursive: true, force: true}); else result.fixturePreserved = fixture;
 fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
 console.log(JSON.stringify({ok: result.ok, checks: checks.length, syntheticReadRefusal: true, failure, output}));
}
