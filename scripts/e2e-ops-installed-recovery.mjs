import {_electron as electron, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {setTestLocale} from './test-locale.mjs';
import {comparePackagedElectronTree} from './packaged-source-policy.mjs';
import {inspectMac} from './test-build.mjs';
import {readBoundedJSON, inventory} from './packaged-bundle-guards.mjs';
import {requireNativeHost, selectMainHost, selectProjectHost, verifyOriginalMainProcess} from './native-adapters.mjs';

// This feature lane makes two original goal turns and one follow-up on A's
// original thread. It never substitutes a new thread or claims a version update.
const repository = fs.realpathSync(process.cwd()), require = createRequire(import.meta.url);
const {validateBuildInfo} = require('../electron/build-info.cjs');
const {validateArchive} = require('../electron/update-archive.cjs');
const {requireOpsVersion} = require('../electron/ops-protocol.cjs');
const asar = require('@electron/asar');
assert.deepEqual(process.argv.slice(2), ['--real-codex'], 'Explicit --real-codex is required; this lane makes exactly three genuine turns.');
assert.equal(process.platform, 'darwin', 'This lane checks an actual native macOS private installation.');
const target = `${process.platform}-${process.arch}`;
requireNativeHost(target);
assert.ok(['darwin-x64', 'darwin-arm64'].includes(target));
const packageDirectory = process.env.REVIEWOPS_CANDIDATE_PACKAGE_DIR;
assert.ok(packageDirectory && path.isAbsolute(packageDirectory), 'Select a verified native candidate package directory.');
const build = validateBuildInfo(readBoundedJSON(path.join(packageDirectory, 'build-info.json'), 65536));
assert.equal(build.commit, process.env.REVIEWOPS_EXPECT_SOURCE_SHA, 'Explicitly select the complete reviewed candidate source SHA.');
const verification = readBoundedJSON(path.join(packageDirectory, `verification-${target}.json`));
assert.equal(verification.ok, true);assert.equal(verification.target, target);
assert.deepEqual(validateBuildInfo(verification.build), build);
for (const check of ['codesign', 'zip-extraction', 'native-smoke', 'ops-package-source', 'ops-native-smoke'])
  assert.ok(verification.checks.includes(check), `Required native baseline is missing: ${check}`);
const zipName = `ReviewOps-${build.version}-test.${build.buildNumber}-${process.arch}.zip`;
assert.equal(verification.files.filter(row => row.name === zipName).length, 1, 'The selected ZIP must have exactly one verified descriptor.');
const descriptor = verification.files.find(row => row.name === zipName);
assert.ok(descriptor && /^[a-f0-9]{64}$/.test(descriptor.sha256) && Number.isSafeInteger(descriptor.size) && descriptor.size >= 1024 && descriptor.size <= 512 * 1024 ** 2);
const zip = fs.realpathSync(path.join(packageDirectory, zipName));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = file => sha(fs.readFileSync(file));
assert.equal(fs.statSync(zip).size, descriptor.size);assert.equal(fileHash(zip), descriptor.sha256);
const cliPath = process.env.REVIEWOPS_E2E_CODEX_BINARY;
assert.ok(cliPath && path.isAbsolute(cliPath), 'Select the actual authenticated CLI by absolute path; no credential copy is performed.');
const cli = fs.realpathSync(cliPath);
fs.accessSync(cli, fs.constants.X_OK);
const cliVersion = requireOpsVersion(execFileSync(cli, ['--version'], {encoding: 'utf8', timeout: 15000, maxBuffer: 4096}).trim());
const driverCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim();
const gitBytes = name => execFileSync('git', ['show', `${build.commit}:${name}`], {cwd: repository, maxBuffer: 16 * 1024 ** 2});
// Resolve the source object before any UI or model work; do not compare a
// future driver's HEAD with an older artifact and call them the same source.
assert.equal(execFileSync('git', ['rev-parse', `${build.commit}^{commit}`], {cwd: repository, encoding: 'utf8'}).trim(), build.commit);

const ownedRoot = fs.realpathSync(fs.mkdtempSync('/tmp/reviewops-ops-recovery-'));
fs.chmodSync(ownedRoot, 0o700);
const dataPath = path.join(ownedRoot, 'data'), installRoot = path.join(ownedRoot, 'installed');
const bundle = path.join(installRoot, 'ReviewOps.app'), executable = path.join(bundle, 'Contents/MacOS/ReviewOps');
const work = {A: path.join(ownedRoot, 'work-a'), B: path.join(ownedRoot, 'work-b')};
const output = path.join(repository, 'test-results/ops-installed-recovery', new Date().toISOString().replace(/[:.]/g, '-'));
for (const folder of [dataPath, installRoot, ...Object.values(work), output, path.join(dataPath, 'codex-manager'), path.join(dataPath, 'updates')]) fs.mkdirSync(folder, {recursive: true, mode: 0o700});
function writePrivate(file, bytes) {const fd = fs.openSync(file, 'w', 0o600);try {fs.writeFileSync(fd, bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
const writeJSON = (file, value) => writePrivate(file, JSON.stringify(value, null, 2) + '\n');
const config = path.join(ownedRoot, 'ssh-config'), wrapper = path.join(ownedRoot, 'qa-codex'), tee = path.join(ownedRoot, 'qa-runtime.cjs');
fs.writeFileSync(config, '# Owned installed Ops recovery has no SSH connections\n', {mode: 0o600});
fs.copyFileSync(path.join(repository, 'scripts/ops-qa-cli-fixture.cjs'), tee);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(tee) + ' "$@"\n', {mode: 0o700});
writeJSON(path.join(dataPath, 'codex-manager/runtime.json'), {path: wrapper});
writeJSON(path.join(dataPath, 'updates/settings.json'), {automatic: false, intervalMinutes: 10});
const env = {...process.env, REVIEWOPS_DATA_DIR: dataPath, REVIEWOPS_SSH_CONFIG: config, REVIEWOPS_CODEX_SSH_CONFIG: config,
  REVIEWOPS_OPS_QA_FIXTURE_ROOT: ownedRoot, REVIEWOPS_OPS_QA_REAL_CLI: cli};
for (const key of ['ELECTRON_RUN_AS_NODE', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
// HOME and CODEX_HOME remain exactly the same for all launches. Existing CLI
// authentication and durable threads stay in their original location.
const authEnvironment = {home: env.HOME, codexHome: env.CODEX_HOME};
const nonce = () => randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const nonces = {baseline: {A: nonce(), B: nonce()}, recovered: {A: nonce(), B: nonce()}};
let phase = 'baseline', app, main, child, childClose, server, failure, origin, originalInventory, original;
const goals = {}, projects = {}, reviews = {}, checks = [], errors = [], photos = [], launches = [], boundaries = [];
const result = {ok: false, scope: 'Focused installed macOS Ops feature QA: two original genuine goals, ordinary restart, same-candidate reinstall and one real QA-tool turn on original A. B retention is checked; B resumed tool availability and actual version update are not claimed.',
  target, build, driverCommit, package: {zip, ...descriptor}, cli: {path: cli, version: cliVersion, sha256: fileHash(cli)}, ownedRoot, dataPath, output, checks, photos, launches, boundaries};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label, timeout = 15000) {let timer;try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(`${label} timed out; underlying owned work was not cancelled.`)), timeout);})]);} finally {clearTimeout(timer);}}
async function until(read, predicate, label, timeout = 20000) {const end = Date.now() + timeout;while (Date.now() < end) {const value = await read();if (predicate(value)) return value;await wait(100);}throw new Error(`Timed out: ${label}`);}
const ipc = (page, action, payload = {}) => page.evaluate(({action, payload}) => window.reviewops.invoke(action, payload), {action, payload});
const invoke = (action, payload = {}) => ipc(main, action, payload);
const snapshot = () => main.evaluate(() => window.opsManager.snapshot());
const goal = async key => (await snapshot()).goals.find(row => row.id === goals[key].id);
const ops = () => main.locator('.workspace-pane:not([hidden]) .ops-workspace');
const detail = () => ops().locator('.ops-detail');
const traffic = () => {const file = path.join(ownedRoot, 'protocol.jsonl');return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];};
const pass = text => {checks.push(text);console.log('PASS: ' + text);};
async function photo(name) {await main.screenshot({path: path.join(output, name)});photos.push(name);}
async function select(key) {await ops().locator('.ops-goal-list').getByRole('button').filter({has: main.getByText(goals[key].name, {exact: true})}).click();await expect(detail().getByRole('heading', {name: goals[key].name, exact: true})).toBeVisible();}
async function action(key, label, status) {await select(key);await detail().getByRole('button', {name: label, exact: true}).click();return until(() => goal(key), row => row.status === status && (status !== 'paused' || row.executionState === 'idle'), `${key} ${label}`, 30000);}
function protocolAssertions(expectedTurns) {
  const rows = traffic(), starts = rows.filter(row => row.direction === 'client' && row.method === 'thread/start');
  assert.equal(starts.length, 2, 'Never allocate a replacement thread after the original A/B pair.');
  assert.equal(rows.filter(row => row.direction === 'client' && row.method === 'turn/start').length, expectedTurns);
  assert.equal(rows.filter(row => row.direction === 'client' && row.method === 'turn/steer').length, 0, 'No extra steering input is part of this lane.');
  const denied = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'collabAgentToolCall', 'subAgentActivity', 'imageView', 'imageGeneration']);
  assert.deepEqual(rows.filter(row => denied.has(row.itemType)), [], 'The model must use only the goal-bound QA tools.');
  assert.ok(rows.filter(row => row.direction === 'server' && row.method === 'item/tool/call').every(row => row.tool?.startsWith('ops_qa_')));
  return rows;
}
function captureEvidence(row, label) {
  const captures = row.qaReceipts.filter(receipt => receipt.status === 'completed' && receipt.capture).map(receipt => ({receipt, capture: receipt.capture}));
  assert.ok(captures.length);const directory = path.join(output, label + '-pngs');fs.mkdirSync(directory, {mode: 0o700});
  return captures.map(({receipt, capture}) => {
    assert.match(capture.relativePath, /^[a-f0-9-]{36}\.png$/);assert.equal(capture.relativePath, capture.id + '.png');
    const file = path.join(dataPath, 'ops/captures', row.id, capture.relativePath), stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());assert.equal(stat.size, capture.size);assert.ok(stat.size <= 2 * 1024 ** 2);
    const bytes = fs.readFileSync(file);assert.equal(sha(bytes), capture.sha256);assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), capture.width);assert.equal(bytes.readUInt32BE(20), capture.height);
    assert.ok(traffic().some(entry => entry.images?.some(image => image.sha256 === capture.sha256 && image.size === capture.size)), 'The original PNG must actually pass to the CLI.');
    writePrivate(path.join(directory, capture.relativePath), bytes);return {callId: receipt.callId, threadId: receipt.threadId, turnId: receipt.turnId, ...capture};
  });
}
function fixedGoal(row) {return Object.fromEntries(['id', 'name', 'description', 'projectId', 'projectEpoch', 'projectBirth', 'projectConnectionSignature', 'serviceId', 'workPath', 'prompt', 'model', 'reasoningEffort', 'sandboxMode', 'approvalPolicy', 'threadId', 'status', 'schedules', 'targetKind', 'targetIdentity', 'targetLockIdentity', 'targetLockIdentities'].map(key => [key, row[key]]));}
function stableHistory(row) {return row.history.filter(entry => entry.type === 'delivery' || entry.type === 'turn.completed' || entry.type === 'qa.operation');}
function projectData(state) {return Object.fromEntries(['groups', 'projects', 'services', 'reviews'].map(kind => [kind, state[kind]]));}
async function checkpoint(label, baseline = null) {
  const state = await snapshot(), core = projectData(await invoke('snapshot'));
  assert.equal(state.goals.length, 2);assert.equal(JSON.stringify(state).includes('data:image/'), false);
  const values = Object.fromEntries(['A', 'B'].map(key => [key, state.goals.find(row => row.id === goals[key].id)]));
  for (const key of ['A', 'B']) {
    const current = values[key];assert.ok(current);assert.equal(current.projectId, projects[key].id);assert.equal(current.status, 'paused');assert.equal(current.executionState, 'idle');
    assert.equal(current.backgroundState, 'empty');assert.equal(current.turnId, null);
    if (baseline) {const old = baseline.goals[key];assert.deepEqual(fixedGoal(current), fixedGoal(old));assert.deepEqual(current.conversation, old.conversation);assert.deepEqual(current.qaReceipts, old.qaReceipts);assert.deepEqual(stableHistory(current), stableHistory(old));assert.notEqual(current.qaBinding?.state, 'attached', 'Startup must not adopt a previous application lease.');for (const field of ['clientId', 'sessionId', 'projectId', 'windowId', 'appInstanceId']) assert.equal(current.qaBinding?.[field], old.qaBinding?.[field]);}
  }
  if (baseline) assert.deepEqual(core, baseline.core, 'Registered project/service/review data must remain the original data.');
  const saved = {goals: values, core};writeJSON(path.join(output, `${label}.json`), saved);
  for (const key of ['A', 'B']) captureEvidence(values[key], label + '-' + key);
  return saved;
}
async function inspectInstalled(label) {
  asar.uncache(path.join(bundle, 'Contents/Resources/app.asar'));
  await inspectMac(bundle, build, process.arch);
  const archive = path.join(bundle, 'Contents/Resources/app.asar');
  const expectedFiles = execFileSync('git', ['ls-tree', '-rz', '--name-only', build.commit, '--', 'electron'], {cwd: repository, maxBuffer: 2 * 1024 ** 2}).toString().split('\0').filter(Boolean);
  const {source,generatedNative}=comparePackagedElectronTree(archive,{asar,sourceFiles:expectedFiles,readSource:gitBytes});
  assert.ok(source.some(row => row.path === 'electron/ops-qa.cjs'));
  const current = inventory(bundle);if (originalInventory) assert.deepEqual(current, originalInventory, 'Same-candidate reinstall must reproduce identical bundle file bytes.');else originalInventory = current;
  boundaries.push({label, source,generatedNative, archiveSHA256: fileHash(archive), inventorySHA256: sha(JSON.stringify(current))});
}
async function install(label) {
  assert.equal(app, undefined, 'The owned app must be confirmed closed before replacing its bundle.');
  assert.equal(fs.realpathSync(installRoot), installRoot);assert.ok(installRoot.startsWith(ownedRoot + path.sep));
  if (fs.existsSync(bundle)) {assert.equal(fs.realpathSync(bundle), bundle);assert.equal(fs.lstatSync(bundle).isSymbolicLink(), false);}
  assert.equal(fileHash(zip), descriptor.sha256);assert.equal(fs.statSync(zip).size, descriptor.size);await validateArchive(zip);
  if (fs.existsSync(bundle)) fs.rmSync(bundle, {recursive: true});
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, installRoot], {timeout: 120000});
  assert.deepEqual(fs.readdirSync(installRoot), ['ReviewOps.app']);assert.equal(fs.realpathSync(bundle), bundle);
  await inspectInstalled(label);
}
async function launch(label) {
  assert.deepEqual({home: env.HOME, codexHome: env.CODEX_HOME}, authEnvironment);
  app = await electron.launch({executablePath: executable, args: [], env, timeout: 60000});child = app.process();
  const record = {label, mainPID: child.pid, exit: null, close: null};launches.push(record);
  child.once('exit', (code, signal) => {record.exit = {code, signal};});
  childClose = new Promise(resolve => child.once('close', (code, signal) => {record.close = {code, signal};resolve(record.close);}));
  const host = await selectMainHost(app, until, ipc, bounded);main = host.page;main.setDefaultTimeout(15000);
  const actual = await app.evaluate(({app}) => ({pid: process.pid, ppid: process.ppid, platform: process.platform, arch: process.arch, executable: process.execPath, packaged: app.isPackaged}));
  verifyOriginalMainProcess({...actual, expectedPlatform: process.platform, childPID: child.pid});
  assert.equal(actual.arch, process.arch);assert.equal(actual.packaged, true);assert.equal(fs.realpathSync(actual.executable), fs.realpathSync(executable));
  record.identity = actual;const info = await invoke('app.info');assert.deepEqual(info.build, build);assert.equal(info.platform, process.platform);assert.equal(info.arch, process.arch);assert.equal(fs.realpathSync(info.dataPath), dataPath);
  main.on('pageerror', error => errors.push({label, message: error.message}));await setTestLocale(main);
  await main.locator('.main-nav').getByRole('button', {name: 'Ops', exact: true}).click();await expect(ops()).toBeVisible();
  if (Object.keys(goals).length) await until(async () => (await snapshot()).goals, rows => rows.length === 2 && rows.every(row => row.status === 'paused' && row.executionState === 'idle'), 'original paused goals reconcile without model input', 45000);
}
function alive(pid) {try {process.kill(pid, 0);return true;} catch (error) {if (error.code === 'ESRCH') return false;throw error;}}
async function close(label) {
  await bounded(app.close(), 'graceful owned app close', 30000);await bounded(childClose, 'original Electron child close', 15000);
  const record = launches.at(-1);assert.deepEqual(record.exit, {code: 0, signal: null});assert.deepEqual(record.close, {code: 0, signal: null});
  await until(() => traffic(), rows => rows.filter(row => row.event === 'real-cli-start').every(start => rows.some(end => end.pid === start.pid && end.event === 'real-cli-exit') && !alive(start.pid) && !alive(start.childPid)), 'all owned wrappers and actual CLI children exit', 15000);
  record.cliProcesses = traffic().filter(row => row.event === 'real-cli-start').map(start => ({wrapperPID: start.pid, childPID: start.childPid, operation: start.operation, exit: traffic().find(end => end.pid === start.pid && end.event === 'real-cli-exit'), wrapperGone: !alive(start.pid), childGone: !alive(start.childPid)}));
  for (const row of record.cliProcesses) assert.equal(row.exit.code, 0, 'The underlying owned CLI must exit successfully.');
  app = undefined;main = undefined;child = undefined;
  boundaries.push({label, opsFileSHA256: fileHash(path.join(dataPath, 'ops/state.json')), databaseSHA256: fileHash(path.join(dataPath, 'reviewops.sqlite'))});
}
async function imageTurn(key, label, prior = null) {
  await action(key, prior ? '재개' : '목표 시작', 'active');
  const expectedCount = prior ? 2 : 1;
  const row = await until(() => goal(key), current => {
    if (current.lastError || ['error', 'unknown'].includes(current.executionState)) throw new Error(`Goal ${key}: ${current.lastError || current.executionState}`);
    return current.history.filter(entry => entry.type === 'delivery' && entry.status === 'completed').length === expectedCount && current.executionState === 'idle';
  }, 'actual image interpretation ' + label, 240000);
  if (prior) assert.equal(row.threadId, prior.threadId);
  const oldMessages = new Set(prior?.conversation.map(message => message.id) || []), answer = `OPS_RECOVERY_${key}_IMAGE ${nonces[phase][key]}`;
  assert.ok(row.conversation.some(message => message.role === 'assistant' && !oldMessages.has(message.id) && message.text.includes(answer)), 'The real model must return the exact new canvas-only nonce.');
  const newReceipts = row.qaReceipts.filter(receipt => !prior?.qaReceipts.some(old => old.callId === receipt.callId));
  assert.ok(newReceipts.some(receipt => receipt.tool === 'ops_qa_open' && receipt.status === 'completed'));
  assert.ok(newReceipts.some(receipt => receipt.tool === 'ops_qa_document' && receipt.capture && receipt.status === 'completed'));
  assert.ok(newReceipts.every(receipt => receipt.status === 'completed' && receipt.threadId === row.threadId && receipt.projectId === projects[key].id));
  assert.equal(row.qaBinding.state, 'attached');assert.equal(row.qaBinding.projectId, projects[key].id);
  if (prior) for (const field of ['clientId', 'sessionId', 'windowId', 'appInstanceId']) assert.notEqual(row.qaBinding[field], prior.qaBinding[field], `Restart must create a fresh ${field} rather than adopt the previous lease.`);
  const host = await selectProjectHost(app, row.qaBinding, until, ipc, bounded);
  const state = await ipc(host.page, 'window.context');assert.equal(state.windowId, row.qaBinding.windowId);assert.equal(state.projectId, projects[key].id);
  const inputs = await app.evaluate(({webContents}, url) => webContents.getAllWebContents().filter(contents => contents.getURL() === url).map(contents => contents.id), origin + '/' + key.toLowerCase());
  assert.equal(inputs.length, 1);
  const value = await app.evaluate(async ({webContents}, id) => webContents.fromId(id).executeJavaScript('document.querySelector("#draft").value'), inputs[0]);assert.equal(value, 'MODEL_' + key);
  const images = captureEvidence(row, label);
  if (prior) assert.ok(images.some(image => !prior.qaReceipts.some(receipt => receipt.capture?.sha256 === image.sha256)), 'Recovery must return a new image, not substitute an old capture.');
  await select(key);await expect(detail().getByRole('region', {name: '목표 QA 연결'})).toContainText('연결됨');await photo(label + '.png');
  writeJSON(path.join(output, label + '.json'), {goal: row, newReceipts, images});return row;
}

try {
  await install('initial-private-install');
  server = http.createServer((request, response) => {
    const key = request.url === '/a' ? 'A' : request.url === '/b' ? 'B' : null;
    if (!key) {response.writeHead(404);response.end();return;}
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end('<!doctype html><meta charset="utf-8"><title>Owned recovery ' + key + '</title><style>body{font:24px sans-serif;padding:30px;background:#edf6ff}input{font:inherit;padding:9px}canvas{display:block;margin-top:30px}</style><h1>Owned recovery ' + key + '</h1><label>Input ' + key + '<input id="draft"></label><canvas width="850" height="120"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#fff";c.fillRect(0,0,850,120);c.fillStyle="#111";c.font="40px monospace";c.fillText("IMAGE ' + key + ': ' + nonces[phase][key] + '",20,75);</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));origin = 'http://127.0.0.1:' + server.address().port;result.origin = origin;
  await launch('initial');const group = await invoke('group.save', {name: 'Owned installed recovery'});
  for (const key of ['A', 'B']) {
    projects[key] = await invoke('project.save', {groupId: group.id, name: 'Installed recovery ' + key, connection: {kind: 'local', rootPath: work[key], viewerUrl: origin + '/' + key.toLowerCase(), viewerWidth: 1100, viewerHeight: 750, viewerScale: 'fit'}});
    reviews[key] = await invoke('review.save', {projectId: projects[key].id, title: 'Owned installed recovery ' + key});
    const prompt = 'Use only this goal’s ops_qa tools. Do not use shell, files, network, search, image-viewing, subagent or schedule tools. Open ops_qa_open with reviewId ' + reviews[key].id + '. Use ops_qa_state to identify this project’s embedded browser. Use ops_qa_document state to obtain its current documentId and input rectangle, then click and type MODEL_' + key + ' using that documentId. Use ops_qa_document capture for the same browser. Read the actual IMAGE ' + key + ' nonce drawn only in its returned PNG. It is absent from state text and may change between turns. Reply exactly OPS_RECOVERY_' + key + '_IMAGE followed by the nonce actually seen. Do not invent a value or create another goal/session.';
    const saved = await main.evaluate(values => window.opsManager.saveGoal(values), {name: 'Installed recovery goal ' + key, description: 'Owned original-thread installation feature acceptance', projectId: projects[key].id, serviceId: projects[key].connection?.id || projects[key].serviceIds[0], prompt, model: '', reasoningEffort: '', sandboxMode: 'workspace-write', approvalPolicy: 'never'});
    goals[key] = saved.goals.find(row => row.name === 'Installed recovery goal ' + key);
  }
  await imageTurn('A', '01-original-a');await imageTurn('B', '02-original-b');
  assert.notEqual((await goal('A')).threadId, (await goal('B')).threadId);assert.notEqual((await goal('A')).qaBinding.windowId, (await goal('B')).qaBinding.windowId);
  await action('A', '일시정지', 'paused');await action('B', '일시정지', 'paused');for (const key of ['A', 'B']) assert.equal((await goal(key)).qaBinding.state, 'released');protocolAssertions(2);
  original = await checkpoint('original-paused');pass('Two genuine installed goals used independent original threads/project QA windows and their real PNG nonces; both paused cleanly.');
  await close('before-ordinary-restart');await launch('ordinary-restart');protocolAssertions(2);await checkpoint('after-ordinary-restart', original);await select('A');await photo('03-ordinary-restart.png');
  pass('Ordinary restart reconciled both original paused threads without a new thread, model input or copied application data.');
  await close('before-same-candidate-reinstall');
  const before = {ops: fileHash(path.join(dataPath, 'ops/state.json')), database: fileHash(path.join(dataPath, 'reviewops.sqlite'))};
  await install('same-candidate-reinstall');assert.deepEqual({ops: fileHash(path.join(dataPath, 'ops/state.json')), database: fileHash(path.join(dataPath, 'reviewops.sqlite'))}, before, 'Replacing only the private app must leave data bytes untouched.');
  phase = 'recovered';await launch('after-same-candidate-reinstall');protocolAssertions(2);await checkpoint('after-reinstall-before-input', original);await select('B');await photo('04-b-retained-before-a-resume.png');
  pass('Same-candidate private reinstall retained original projects, goals, conversations, QA receipts and PNG bytes; no version-update claim.');
  const recovered = await imageTurn('A', '05-original-a-recovered', original.goals.A);const rows = protocolAssertions(3);
  assert.ok(rows.some(row => row.direction === 'client' && row.method === 'thread/resume' && row.threadId === original.goals.A.threadId));
  assert.equal(rows.filter(row => row.direction === 'client' && row.method === 'turn/start' && row.threadId === original.goals.A.threadId).length, 2);
  assert.equal(rows.filter(row => row.direction === 'client' && row.method === 'turn/start' && row.threadId === original.goals.B.threadId).length, 1);
  assert.ok(rows.some(row => row.direction === 'server' && row.method === 'item/tool/call' && row.threadId === original.goals.A.threadId && recovered.qaReceipts.some(receipt => receipt.turnId === row.turnId && !original.goals.A.qaReceipts.some(old => old.callId === receipt.callId))));
  const b = await goal('B');assert.deepEqual(fixedGoal(b), fixedGoal(original.goals.B));assert.deepEqual(b.conversation, original.goals.B.conversation);assert.deepEqual(b.qaReceipts, original.goals.B.qaReceipts);assert.deepEqual(stableHistory(b), stableHistory(original.goals.B));captureEvidence(b, 'retained-b');
  await action('A', '일시정지', 'paused');assert.equal((await goal('A')).qaBinding.state, 'released');assert.equal((await goal('B')).qaBinding.state, b.qaBinding.state);assert.deepEqual((await goal('B')).qaReceipts, b.qaReceipts);await select('B');await photo('06-b-retained-after-a-pause.png');
  result.originalThreads = {A: original.goals.A.threadId, B: original.goals.B.threadId};result.actualModelTurns = 3;result.bResumedToolAvailabilityTested = false;result.actualVersionUpdateTested = false;
  pass('A invoked real QA tools and interpreted a new PNG on its original genuine thread after restart/reinstall; its new lease stayed goal-bound, and paused B was not resumed or rewritten.');
  await close('final');assert.deepEqual(errors, []);result.ok = true;
} catch (error) {
  failure = error;result.failure = {message: error.message, stack: error.stack};await main?.screenshot({path: path.join(output, 'failure.png')}).catch(() => {});
} finally {
  if (app) {
    try {for (const key of Object.keys(goals)) if ((await goal(key))?.status === 'active') await action(key, '일시정지', 'paused');await close('failure-cleanup');}
    catch (error) {result.cleanupError = error.message;failure ??= error;result.ok = false;}
  }
  if (server) await bounded(new Promise(resolve => server.close(resolve)), 'owned HTTP fixture close').catch(error => {result.cleanupError = error.message;failure ??= error;result.ok = false;});
  result.errors = errors;result.fixtureRetained = fs.existsSync(ownedRoot);result.cleanupConfirmed = !app && launches.length > 0 && launches.every(row => row.close?.code === 0) && traffic().filter(row => row.event === 'real-cli-start').every(row => !alive(row.pid) && !alive(row.childPid));
  result.protocolCounts = Object.fromEntries(['thread/start', 'thread/resume', 'turn/start', 'turn/steer'].map(method => [method, traffic().filter(row => row.direction === 'client' && row.method === method).length]));
  if (!result.cleanupConfirmed) {result.ok = false;failure ??= new Error('Owned process cleanup is unconfirmed; preserve the original fixture.');}
  writeJSON(path.join(output, 'protocol.json'), traffic());
  const responses = path.join(ownedRoot, 'responses');if (fs.existsSync(responses)) fs.cpSync(responses, path.join(output, 'model-image-evidence'), {recursive: true});
  writeJSON(path.join(output, 'results.json'), result);console.log(JSON.stringify({ok: result.ok, output, ownedRoot, fixtureRetained: true, cleanupConfirmed: result.cleanupConfirmed}));
}
if (failure) throw failure;
