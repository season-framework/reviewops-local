// Manual, explicitly admitted packaged UI diagnostics. Importing this file launches nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE = JSON.parse(fs.readFileSync(path.join(here, 'arm-first-run-ui-package.json'), 'utf8'));
export const ADDED_PATHS = new Set([
  'scripts/diagnostics/arm-first-run-ui.mjs', 'scripts/diagnostics/arm-first-run-ui-package.json',
  'scripts/diagnostics/arm-first-run-ui.py', '.github/workflows/arm-first-run-ui.yml',
  'tests/arm-first-run-ui.test.mjs', 'docs/diagnostics/arm-first-run-ui.md',
]);
const FILE_AUTH_CONFIG = 'cli_auth_credentials_store = "file"\n';
const SHA = /^[a-f0-9]{64}$/;
const inside = (root, file) => file !== root && file.startsWith(root + '/');
const absolute = value => typeof value === 'string' && path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && !/[\0\r\n]/.test(value);

export function assertBinding(b, host) {
  assert.equal(b.schema, 1);
  assert.equal(b.approvedForOnePositiveUILaunch, true);
  assert.equal(b.allowNormalStartupMetadata, true);
  assert.equal(host.platform, 'darwin'); assert.equal(host.arch, 'arm64');
  assert.equal(host.electron, undefined); assert.match(host.node, /^24\./);
  assert.equal(b.source, PACKAGE.source); assert.match(b.harnessSource, /^[a-f0-9]{40}$/);
  const source = b.sourceGuard;
  assert.equal(source.baseSource, PACKAGE.source); assert.equal(source.harnessSource, b.harnessSource);
  assert.equal(source.baselineFiles, 419); assert.equal(source.oldFilesUnchanged, true);
  assert.ok(Array.isArray(source.addedPaths) && source.addedPaths.length > 0);
  assert.equal(new Set(source.addedPaths).size, source.addedPaths.length);
  assert.ok(source.addedPaths.every(name => ADDED_PATHS.has(name)), 'Only the reviewed new diagnostic paths may differ');
  for (const name of ['root','privateRoot','home','codeHome','dataDir','sshConfig','packageApp','vendorApp','CLI','output'])
    assert.ok(absolute(b[name]), 'Expected canonical absolute ' + name);
  assert.equal(b.home, path.posix.join(b.privateRoot, 'home'));
  assert.equal(b.codeHome, path.posix.join(b.home, '.codex'));
  assert.equal(b.dataDir, path.posix.join(b.privateRoot, 'data'));
  assert.equal(b.sshConfig, path.posix.join(b.home, '.ssh', 'config'));
  assert.ok(inside(b.privateRoot, b.packageApp) && b.packageApp.endsWith('/ReviewOps.app'));
  assert.ok(['ChatGPT.app','Codex.app'].some(name => b.vendorApp === path.posix.join(b.home, 'Applications', name)));
  assert.ok(inside(b.vendorApp, b.CLI) && SHA.test(b.CLISHA256));
  assert.ok(inside(path.posix.join(b.root, 'test-results', 'arm-first-run-ui'), b.output));
  for (const name of ['packageZipPin','expectedASARPin','vendorIdentityPin','vendorInventoryPin','actualNodeIdentity']) {
    const row = b[name]; assert.ok(row && absolute(row.path) && Number.isSafeInteger(row.bytes) && row.bytes > 0 && SHA.test(row.sha256), 'Complete regular-file pin required: ' + name);
  }
  assert.equal(b.packageZipPin.bytes, PACKAGE.package.bytes); assert.equal(b.packageZipPin.sha256, PACKAGE.package.sha256);
  assert.equal(b.expectedASARPin.path, path.posix.join(b.packageApp, PACKAGE.asar.relativePath));
  assert.equal(b.expectedASARPin.bytes, PACKAGE.asar.bytes); assert.equal(b.expectedASARPin.sha256, PACKAGE.asar.sha256);
  assert.equal(b.actualNodeIdentity.platform, 'darwin'); assert.equal(b.actualNodeIdentity.arch, 'arm64');
  assert.equal(b.actualNodeIdentity.version.replace(/^v/, ''), host.node);
}

export function assertDefaultInventory(rows, CLI) {
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 256);
  assert.equal(new Set(rows.map(row => row.candidate)).size, rows.length);
  for (const row of rows) {
    assert.ok(absolute(row.candidate));
    assert.ok(['missing','present'].includes(row.status), 'Unknown inventory errors cannot become missing');
    if (row.status === 'present') assert.ok(absolute(row.canonical) && typeof row.file === 'boolean');
  }
  const ownIndex = rows.findIndex(row => row.status === 'present' && row.file && row.canonical === CLI);
  assert.ok(ownIndex >= 0, 'The actual vendor CLI must occur in production defaults');
  assert.ok(!rows.slice(0, ownIndex).some(row => row.status === 'present' && row.canonical !== CLI),
    'An earlier real candidate blocks this positive-only lane before app launch');
  return ownIndex;
}

export function assertRuntimeObservation(state, summary, CLI) {
  assert.ok(Array.isArray(state.accounts)); assert.equal(state.accounts.length, 0);
  assert.equal(state.runtime.available, true); assert.equal(state.runtime.path, CLI);
  assert.match(state.runtime.version, /^[0-9][A-Za-z0-9.+_-]{0,159}$/);
  assert.equal(summary.path, CLI); assert.equal(summary.version, 'Codex CLI ' + state.runtime.version);
}

export function assertMissingBinding(b, host) {
  assert.equal(b.schema, 1); assert.equal(b.scenario, 'missing-cli-first-run');
  assert.equal(b.approvedForOneMissingCLIUILaunch, true); assert.equal(b.allowNormalStartupMetadata, true);
  for (const name of ['approvedForOnePositiveUILaunch','vendorApp','CLI','CLISHA256','vendorIdentityPin','vendorInventoryPin'])
    assert.equal(Object.hasOwn(b, name), false, 'The missing lane cannot inherit positive vendor authority');
  assert.equal(host.platform, 'darwin'); assert.equal(host.arch, 'arm64');
  assert.equal(host.electron, undefined); assert.match(host.node, /^24\./);
  assert.equal(b.source, PACKAGE.source); assert.match(b.harnessSource, /^[a-f0-9]{40}$/);
  const source = b.sourceGuard;
  assert.equal(source.baseSource, PACKAGE.source); assert.equal(source.harnessSource, b.harnessSource);
  assert.equal(source.baselineFiles, 419); assert.equal(source.oldFilesUnchanged, true);
  assert.ok(Array.isArray(source.addedPaths) && source.addedPaths.length === ADDED_PATHS.size);
  assert.equal(new Set(source.addedPaths).size, source.addedPaths.length);
  assert.ok(source.addedPaths.every(name => ADDED_PATHS.has(name)));
  for (const name of ['root','privateRoot','home','codeHome','dataDir','sshConfig','packageApp','output']) assert.ok(absolute(b[name]));
  assert.equal(b.home, path.posix.join(b.privateRoot, 'home'));
  assert.equal(b.codeHome, path.posix.join(b.home, '.codex'));
  assert.equal(b.dataDir, path.posix.join(b.privateRoot, 'data'));
  assert.equal(b.sshConfig, path.posix.join(b.home, '.ssh', 'config'));
  assert.ok(inside(b.privateRoot, b.packageApp) && b.packageApp.endsWith('/ReviewOps.app'));
  assert.ok(inside(path.posix.join(b.root, 'test-results', 'arm-first-run-ui'), b.output));
  for (const name of ['packageZipPin','expectedASARPin','actualNodeIdentity']) {
    const row = b[name]; assert.ok(row && absolute(row.path) && Number.isSafeInteger(row.bytes) && row.bytes > 0 && SHA.test(row.sha256));
  }
  assert.equal(b.packageZipPin.bytes, PACKAGE.package.bytes); assert.equal(b.packageZipPin.sha256, PACKAGE.package.sha256);
  assert.equal(b.expectedASARPin.path, path.posix.join(b.packageApp, PACKAGE.asar.relativePath));
  assert.equal(b.expectedASARPin.bytes, PACKAGE.asar.bytes); assert.equal(b.expectedASARPin.sha256, PACKAGE.asar.sha256);
  assert.equal(b.actualNodeIdentity.platform, 'darwin'); assert.equal(b.actualNodeIdentity.arch, 'arm64');
  assert.equal(b.actualNodeIdentity.version.replace(/^v/, ''), host.node);
}

export function missingCandidateRow(candidate, inspect = fs.lstatSync) {
  assert.ok(absolute(candidate));
  try { inspect(candidate); return {candidate, status: 'present'}; }
  catch (error) {
    if (['ENOENT','ENOTDIR'].includes(error.code)) return {candidate, status: 'missing'};
    throw error; // Permission and unknown errors cannot prove an absent executable.
  }
}

export function assertAllMissingInventory(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 256);
  assert.equal(new Set(rows.map(row => row.candidate)).size, rows.length);
  for (const row of rows) {
    assert.ok(absolute(row.candidate)); assert.deepEqual(Object.keys(row).sort(), ['candidate','status']);
    assert.equal(row.status, 'missing', 'Any present path, including a dangling symlink or directory, blocks this lane');
  }
}

const MISSING_NOTICES = ['Codex CLI를 찾을 수 없습니다. 설치하거나 실행 파일을 선택해 주십시오.',
  'Could not find Codex CLI. Install it or choose its executable.'];
export function assertMissingRuntimeObservation(state, view) {
  assert.ok(Array.isArray(state.accounts)); assert.equal(state.accounts.length, 0);
  assert.equal(state.runtime.available, false); assert.equal(state.runtime.errorKind, 'missing');
  assert.equal(state.runtime.path, null); assert.equal(state.runtime.version, null);
  assert.equal(state.runtime.error, MISSING_NOTICES[0]);
  assert.ok(Array.isArray(state.runtime.diagnostics?.records) && state.runtime.diagnostics.records.length > 0);
  assert.ok(state.runtime.diagnostics.records.every(row => row.kind === 'missing'));
  assert.ok(MISSING_NOTICES.includes(view.notice)); assert.equal(view.summaryCount, 0);
  assert.equal(view.recheckVisible, true); assert.equal(view.chooseVisible, true); assert.equal(view.loginDialogCount, 0);
}

export function assertOriginalClosure(owner) {
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0);
  assert.equal(owner.applicationClosed, true); assert.equal(owner.exitObserved, true);
  assert.equal(owner.childClosed, true); assert.deepEqual(owner.exit, {code: 0, signal: null});
  assert.equal(owner.stdoutEOF, true); assert.equal(owner.stderrEOF, true);
  assert.equal(owner.stdoutClosed, true); assert.equal(owner.stderrClosed, true);
}

const hash = file => {
  const fd = fs.openSync(file, 'r'), h = crypto.createHash('sha256'), block = Buffer.alloc(1024 * 1024);
  try { for (;;) { const n = fs.readSync(fd, block, 0, block.length, null); if (!n) break; h.update(block.subarray(0, n)); } }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
};
function readJSON(file, cap = 16 * 1024 ** 2) {
  const info = fs.lstatSync(file); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= cap);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function pin(row) {
  assert.ok(absolute(row.path)); const info = fs.lstatSync(row.path);
  assert.ok(info.isFile() && !info.isSymbolicLink()); assert.equal(info.size, row.bytes);
  assert.equal(hash(row.path), row.sha256); return row.path;
}
function noSymlinkParents(file, root) {
  assert.ok(file === root || inside(root, file));
  for (let current = file; current !== root; current = path.dirname(current))
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'Owned path cannot follow a symlink');
}
function regularText(file, maximum) {
  const info = fs.lstatSync(file); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum);
  return fs.readFileSync(file, 'utf8');
}
function inventory(app) {
  const rows = []; let bytes = 0;
  function visit(folder) {
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name), info = fs.lstatSync(file), relative = path.relative(app, file).split(path.sep).join('/');
      if (info.isSymbolicLink()) {
        const target = fs.readlinkSync(file), real = fs.realpathSync(file);
        assert.ok(real === app || inside(app, real), 'Vendor link escapes its owned app');
        rows.push({path: relative, kind: 'symlink', target, sha256: crypto.createHash('sha256').update(target).digest('hex'), mode: info.mode & 0o7777});
      } else if (info.isFile()) {
        bytes += info.size; assert.ok(bytes <= 3 * 1024 ** 3);
        rows.push({path: relative, kind: 'file', bytes: info.size, sha256: hash(file), mode: info.mode & 0o7777});
      } else { assert.ok(info.isDirectory()); visit(file); }
      assert.ok(rows.length <= 50000);
    }
  }
  visit(app); return rows.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
async function until(read, test, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = await read(); if (test(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(label + ' observation deadline; do not retry the launch');
}

export async function run(bindingFile) {
  const b = readJSON(bindingFile, 1024 ** 2);
  const missing = Object.hasOwn(b, 'scenario');
  const host = {platform: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron};
  if (missing) assertMissingBinding(b, host); else assertBinding(b, host);
  for (const name of ['root','privateRoot','home','codeHome','packageApp', ...(missing ? [] : ['vendorApp'])]) assert.equal(fs.realpathSync(b[name]), b[name]);
  const tempBases = [fs.realpathSync(os.tmpdir()), ...(process.env.RUNNER_TEMP ? [fs.realpathSync(process.env.RUNNER_TEMP)] : [])];
  assert.ok(tempBases.some(base => inside(base, b.privateRoot)), 'Root must prepare a fresh private temporary installation');
  assert.equal(fs.realpathSync(process.execPath), b.actualNodeIdentity.path); pin(b.actualNodeIdentity);
  pin(b.packageZipPin); pin(b.expectedASARPin);
  const executable = path.join(b.packageApp, PACKAGE.executable.relativePath);
  noSymlinkParents(executable, b.packageApp); noSymlinkParents(b.expectedASARPin.path, b.packageApp);
  assert.ok(fs.lstatSync(executable).isFile() && (fs.statSync(executable).mode & 0o111));
  assert.equal(fs.statSync(executable).size, PACKAGE.executable.bytes); assert.equal(hash(executable), PACKAGE.executable.sha256);
  noSymlinkParents(b.output, b.root); noSymlinkParents(b.dataDir, b.privateRoot);
  noSymlinkParents(b.sshConfig, b.home);
  assert.ok(!fs.existsSync(b.output)); assert.ok(!fs.existsSync(b.dataDir) || fs.readdirSync(b.dataDir).length === 0);
  assert.deepEqual(fs.readdirSync(b.home).sort(), ['.codex','.ssh','Applications']);
  assert.deepEqual(fs.readdirSync(path.join(b.home, 'Applications')), missing ? [] : [path.basename(b.vendorApp)]);
  assert.deepEqual(fs.readdirSync(b.codeHome), ['config.toml']);
  assert.equal(regularText(path.join(b.codeHome, 'config.toml'), 256), FILE_AUTH_CONFIG);
  assert.equal(regularText(b.sshConfig, 1), '');
  let vendorBefore;
  if (!missing) {
  const identity = readJSON(pin(b.vendorIdentityPin));
  assert.equal(identity.appPath, b.vendorApp); assert.equal(identity.CLI, b.CLI);
  assert.equal(identity.bundleId, 'com.openai.codex');
  for (const key of ['appVersion','appBuild']) assert.ok(typeof identity[key] === 'string' && identity[key].length > 0 && identity[key].length <= 128);
  assert.equal(identity.appTeamID, '2DC432GLL2'); assert.equal(identity.CLITeamID, identity.appTeamID);
  assert.equal(identity.CLIArchitecture, 'arm64');
  for (const key of ['appDeepStrictAppleOpenAIVerified','CLIDeepStrictAppleOpenAIVerified','originalToolsClosed','ownedMountOrdinarilyDetached']) assert.equal(identity[key], true);
  assert.equal(fs.realpathSync(b.CLI), b.CLI); assert.equal(hash(b.CLI), b.CLISHA256);
  vendorBefore = inventory(b.vendorApp); assert.deepEqual(vendorBefore, readJSON(pin(b.vendorInventoryPin)));
  }
  fs.mkdirSync(b.output, {recursive: true, mode: 0o700}); fs.mkdirSync(b.dataDir, {recursive: true, mode: 0o700});
  const write = (name, value) => fs.writeFileSync(path.join(b.output, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  const note = row => fs.appendFileSync(path.join(b.output, 'original-app-events.jsonl'), JSON.stringify({at: new Date().toISOString(), ...row}) + '\n');
  const require = createRequire(path.join(b.root, 'package.json')), asar = require('@electron/asar');
  const observer = path.join(b.output, 'observer-runtime'); fs.mkdirSync(observer);
  for (const row of [PACKAGE.runtime, ...PACKAGE.runtimeDependencies]) {
    const raw = asar.extractFile(b.expectedASARPin.path, row.sourcePath);
    assert.equal(raw.length, row.bytes); assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), row.sha256);
    assert.deepEqual(raw, fs.readFileSync(path.join(b.root, row.sourcePath)));
    fs.writeFileSync(path.join(observer, path.basename(row.sourcePath)), raw, {flag: 'wx'});
  }
  const env = {HOME: b.home, USERPROFILE: b.home, CODEX_HOME: b.codeHome, REVIEWOPS_DATA_DIR: b.dataDir,
    REVIEWOPS_SSH_CONFIG: b.sshConfig, REVIEWOPS_CODEX_SSH_CONFIG: b.sshConfig,
    TMPDIR: path.join(b.privateRoot, 'tmp'), TMP: path.join(b.privateRoot, 'tmp'), TEMP: path.join(b.privateRoot, 'tmp'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC'};
  fs.mkdirSync(env.TMPDIR, {recursive: true, mode: 0o700});
  // Only enumerate defaults from an exact outside-app copy. Never call its finder or change the packaged app.
  const {default: runtime} = await import(pathToFileURL(path.join(observer, 'runtime.cjs')));
  const resourcesPath = path.join(b.packageApp, 'Contents', 'Resources');
  const candidates = runtime.defaultCandidates({home: b.home, env, platform: 'darwin', target: runtime.platformTarget('darwin', 'arm64'), resourcesPath});
  const missingInventory = () => candidates.map(candidate => {
    try { return missingCandidateRow(candidate); }
    catch (error) { return {candidate, status: 'unknown', code: String(error.code || 'UNKNOWN')}; }
  });
  const rows = missing ? missingInventory() : candidates.map(candidate => {
    try { const canonical = fs.realpathSync(candidate); return {candidate, status: 'present', canonical, file: fs.statSync(canonical).isFile()}; }
    catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; return {candidate, status: 'missing'}; }
  });
  let ownIndex;
  try {
    if (missing) assertAllMissingInventory(rows); else ownIndex = assertDefaultInventory(rows, b.CLI);
    write('default-candidate-inventory.json', {rows, ownIndex: ownIndex ?? null, admitted: true, launches: 0, customPath: false, ...(missing ? {scenario: b.scenario} : {})});
  } catch (error) {
    write('default-candidate-inventory.json', {rows, ownIndex: null, admitted: false, launches: 0, customPath: false, reason: error.message});
    throw error;
  }
  const result = {ok: false, source: b.source, harnessSource: b.harnessSource, package: PACKAGE.package,
    ...(missing ? {scenario: b.scenario, vendorPrepared: false} : {positiveOnly: true}), appLaunchAttempts: 0, normalStartupMetadataAllowed: ['--version','login status','app-server initialize/config/read/model/list'],
    internalCLIHandlesObserved: false, externalTrafficAssertedZero: false, OAuthSubmitted: false, modelGenerationRequested: false,
    wrapperSignals: 0, automaticRetries: 0, frameworkPrehandleCleanupSignals: 'not-observed',
    stdioObservationScope: 'Starts after successful _electron.launch returns its public app/launcher handle; byte counts do not attest all earlier output.',
    startedAt: new Date().toISOString()};
  let app, owner, quitRequested = false, failure;
  const closed = () => owner?.applicationClosed && owner?.exitObserved && owner?.childClosed
    && owner?.stdoutEOF && owner?.stderrEOF && owner?.stdoutClosed && owner?.stderrClosed;
  async function quit() {
    quitRequested = true; note({phase: 'ordinary-quit-request'});
    try { await app.evaluate(({app}) => {setImmediate(() => app.quit());}); }
    catch (error) { note({phase: 'quit-evaluation-ended', message: error.message}); }
    try { await until(() => closed(), Boolean, 20000, 'Original app/launcher closure'); }
    catch (error) {
      write('held-original-app.json', {reason: error.message, owner, noPIDAdoption: true, noExtraQuitOrSignal: true});
      // Retain the exact app and launcher until their original events arrive; never adopt or kill a PID.
      await until(() => closed(), Boolean, Number.MAX_SAFE_INTEGER, 'Retained original app'); throw error;
    }
    assertOriginalClosure(owner);
  }
  try {
    if (!missing) assert.equal(hash(b.CLI), b.CLISHA256);
    assert.equal(hash(b.expectedASARPin.path), PACKAGE.asar.sha256);
    const {_electron} = await import('@playwright/test');
    if (missing) {
      const immediate = missingInventory();
      write('immediate-before-launch-inventory.json', {rows: immediate, launches: 0});
      assertAllMissingInventory(immediate);
    }
    result.appLaunchAttempts = 1;
    app = await _electron.launch({executablePath: executable, args: [], env, timeout: 30000});
    const child = app.process();
    owner = {pid: child.pid, applicationClosed: false, exitObserved: false, childClosed: false,
      retainedAfterLaunchReturn: true, stdoutEOF: child.stdout?.readableEnded === true, stderrEOF: child.stderr?.readableEnded === true,
      stdoutClosed: child.stdout?.destroyed === true, stderrClosed: child.stderr?.destroyed === true, stdoutObservedBytes: 0, stderrObservedBytes: 0};
    note({phase: 'original-app-and-launcher-retained', pid: child.pid});
    child.stdout?.on('data', chunk => {owner.stdoutObservedBytes += chunk.length;});
    child.stderr?.on('data', chunk => {owner.stderrObservedBytes += chunk.length;});
    child.stdout?.once('end', () => {owner.stdoutEOF = true; note({phase: 'original-stdout-EOF', pid: child.pid});});
    child.stderr?.once('end', () => {owner.stderrEOF = true; note({phase: 'original-stderr-EOF', pid: child.pid});});
    child.stdout?.once('close', () => {owner.stdoutClosed = true; note({phase: 'original-stdout-closed', pid: child.pid});});
    child.stderr?.once('close', () => {owner.stderrClosed = true; note({phase: 'original-stderr-closed', pid: child.pid});});
    child.once('exit', (code, signal) => {owner.exitObserved = true; owner.exit = {code, signal}; note({phase: 'original-launcher-exit', pid: child.pid, code, signal});});
    child.once('close', (code, signal) => {owner.childClosed = true; note({phase: 'original-launcher-close', pid: child.pid, code, signal});});
    app.once('close', () => {owner.applicationClosed = true; note({phase: 'original-application-closed', pid: child.pid});});
    const actual = await app.evaluate(({app}) => ({pid: process.pid, platform: process.platform, arch: process.arch,
      isPackaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(), executablePath: process.execPath,
      resourcesPath: process.resourcesPath, dataPath: app.getPath('userData'), OSHome: app.getPath('home'),
      nodeHome: process.getBuiltinModule('os').homedir(), codeHome: process.env.CODEX_HOME,
      forbiddenEnvironmentNames: ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GH_TOKEN','GITHUB_TOKEN','SSH_AUTH_SOCK','NODE_OPTIONS','NODE_PATH'].filter(k => Boolean(process.env[k]))}));
    assert.equal(actual.pid, child.pid); assert.equal(actual.platform, 'darwin'); assert.equal(actual.arch, 'arm64');
    assert.equal(actual.isPackaged, true); assert.equal(actual.version, PACKAGE.version);
    assert.equal(actual.appPath, b.expectedASARPin.path); assert.equal(actual.executablePath, executable);
    assert.equal(actual.resourcesPath, resourcesPath); assert.equal(actual.dataPath, b.dataDir);
    assert.equal(actual.nodeHome, b.home); assert.equal(actual.codeHome, b.codeHome); assert.deepEqual(actual.forbiddenEnvironmentNames, []);
    write('same-original-app-identity.json', actual);
    const page = await until(() => app.windows().filter(p => !p.isClosed() && /^reviewops:\/\/app\/index\.html$/.test(p.url())), rows => rows.length === 1, 10000, 'Owned unbound main host').then(rows => rows[0]);
    const accounts = page.locator('.main-nav button[aria-label="Accounts"], .main-nav button[aria-label="계정관리"]');
    await accounts.waitFor({state: 'visible', timeout: 10000});
    assert.equal(await accounts.count(), 1); await accounts.click();
    if (missing) {
      const state = await until(() => page.evaluate(() => window.accountManager.getState()),
        state => state.runtime?.errorKind === 'missing', 10000, 'Settled missing runtime');
      const notice = page.locator('.runtime-panel > .runtime-notice'); await notice.waitFor({state: 'visible', timeout: 10000});
      const text = await until(() => notice.textContent(), value => MISSING_NOTICES.includes(value?.trim()), 10000, 'Missing CLI guidance');
      const view = {notice: text.trim(), summaryCount: await page.locator('.runtime-summary').count(),
        recheckVisible: await page.getByRole('button', {name: /^(CLI 다시 검사|Check CLI again)$/}).isVisible(),
        chooseVisible: await page.getByRole('button', {name: /^(실행 파일 선택|Choose executable)$/}).isVisible(),
        loginDialogCount: await page.getByRole('dialog').count()};
      assertMissingRuntimeObservation(state, view);
      assert.equal(fs.existsSync(path.join(b.dataDir, 'codex-manager', 'runtime.json')), false);
      write('runtime-panel-observation.json', {accountCount: state.accounts.length, runtime: state.runtime, view,
        customSelectionFileAbsent: true, recheckClicks: 0, chooseClicks: 0, loginActions: 0});
      await page.screenshot({path: path.join(b.output, '01-first-run-missing-cli-host.png'), type: 'png', fullPage: false});
      result.UIMissingCLIConfirmed = true;
    } else {
    await page.locator('.runtime-summary').waitFor({state: 'visible', timeout: 10000});
    const state = await page.evaluate(() => window.accountManager.getState());
    const summary = {path: (await page.locator('.runtime-summary code').textContent()).trim(), version: (await page.locator('.runtime-summary strong').textContent()).trim()};
    assertRuntimeObservation(state, summary, b.CLI);
    const selectionFile = path.join(b.dataDir, 'codex-manager', 'runtime.json'); assert.equal(fs.existsSync(selectionFile), false);
    const models = await page.evaluate(() => window.reviewops.invoke('modelCache.state'));
    assert.ok(Array.isArray(models.targets) && models.targets.every(row => row.id === 'local'), 'Fresh profile must not import another model target');
    const modelMetadata = {refreshing: models.refreshing, targets: models.targets.map(row => ({id: row.id,
      status: row.status, refreshing: row.refreshing, modelCount: row.models.length})),
      scope: 'Read-only cache state; it exposes neither original CLI handles nor a separately verified login-status result.'};
    write('runtime-panel-observation.json', {accountCount: state.accounts.length, runtime: state.runtime, summary, customSelectionFileAbsent: true,
      modelCache: modelMetadata, modelMetadataIsNotModelGeneration: true, rawInternalCLIStdioNotAvailable: true});
    await page.screenshot({path: path.join(b.output, '01-first-run-accounts-host.png'), type: 'png', fullPage: false});
    result.UIPositive = true;
    }
  } catch (error) {
    failure = error; result.error = {name: error.name, message: error.message};
    if (result.appLaunchAttempts && !owner) result.launchOwnership = 'UNKNOWN: launch rejected before a public app/launcher handle was available; library cleanup is not independently observed';
  }
  finally {
    if (app && owner && !quitRequested) try {await quit();} catch (error) {failure ||= error; result.cleanupError = error.message;}
    result.originalOwner = owner || null;
    result.originalAppHandleConfirmed = Boolean(app && owner);
    result.cleanupConfirmed = Boolean(owner && closed());
    if (missing) {
      try {
        const after = missingInventory(); write('after-cleanup-inventory.json', {rows: after});
        assertAllMissingInventory(after);
        result.allCandidatesMissingAfterCleanup = true;
      } catch (error) {failure ||= error; result.allCandidatesMissingAfterCleanup = false;}
    } else {
      try {assert.deepEqual(inventory(b.vendorApp), vendorBefore); result.vendorInventoryUnchanged = true;}
      catch (error) {failure ||= error; result.vendorInventoryUnchanged = false;}
    }
    result.ok = !failure && result.cleanupConfirmed && (missing
      ? result.UIMissingCLIConfirmed === true && result.allCandidatesMissingAfterCleanup
      : result.UIPositive === true && result.vendorInventoryUnchanged);
    result.completedAt = new Date().toISOString(); write('result.json', result);
  }
  if (failure) throw failure;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 && args[0] === '--run' && absolute(args[1]), 'Explicit --run /absolute/root-prepared-binding.json required');
  run(args[1]).then(value => console.log(JSON.stringify({ok: value.ok, ...(value.scenario ? {scenario: value.scenario} : {positiveOnly: true}), appLaunchAttempts: value.appLaunchAttempts})))
    .catch(error => {console.error(error.message); process.exitCode = 1;});
}
