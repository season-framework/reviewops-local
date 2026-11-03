// Inert guards only. No vendor CLI, app, filesystem fixture, network or product import.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PACKAGE, assertBinding, assertDefaultInventory, assertRuntimeObservation, assertOriginalClosure,
  ADDED_PATHS, assertMissingBinding, missingCandidateRow, assertAllMissingInventory, assertMissingRuntimeObservation} from '../scripts/diagnostics/arm-first-run-ui.mjs';

const host = {platform: 'darwin', arch: 'arm64', node: '24.22.2', electron: undefined};
function binding() {
  const root = '/checkout', privateRoot = '/private/tmp/owned-arm-first-run', home = privateRoot + '/home';
  const packageApp = privateRoot + '/package/ReviewOps.app';
  return {schema: 1, approvedForOnePositiveUILaunch: true, allowNormalStartupMetadata: true,
    root, source: PACKAGE.source, harnessSource: 'a'.repeat(40),
    sourceGuard: {baseSource: PACKAGE.source, harnessSource: 'a'.repeat(40), baselineFiles: 419, oldFilesUnchanged: true,
      addedPaths: ['scripts/diagnostics/arm-first-run-ui.mjs','scripts/diagnostics/arm-first-run-ui-package.json','tests/arm-first-run-ui.test.mjs','docs/diagnostics/arm-first-run-ui.md']},
    privateRoot, home, codeHome: home + '/.codex', dataDir: privateRoot + '/data', sshConfig: home + '/.ssh/config',
    packageApp, packageZipPin: {path: privateRoot + '/public.zip', bytes: PACKAGE.package.bytes, sha256: PACKAGE.package.sha256},
    expectedASARPin: {path: packageApp + '/Contents/Resources/app.asar', bytes: PACKAGE.asar.bytes, sha256: PACKAGE.asar.sha256},
    vendorApp: home + '/Applications/ChatGPT.app', CLI: home + '/Applications/ChatGPT.app/Contents/Resources/codex',
    vendorIdentityPin: {path: root + '/test-results/arm-first-run-ui/identity.json', bytes: 1, sha256: 'c'.repeat(64)},
    vendorInventoryPin: {path: root + '/test-results/arm-first-run-ui/inventory.json', bytes: 1, sha256: 'd'.repeat(64)},
    CLISHA256: 'b'.repeat(64), output: root + '/test-results/arm-first-run-ui/owned-run/ui',
    actualNodeIdentity: {path: '/toolchain/node', bytes: 1, sha256: 'e'.repeat(64), platform: 'darwin', arch: 'arm64', version: 'v24.22.2'}};
}
const absent = candidate => ({candidate, status: 'missing'});
const present = (candidate, canonical = candidate) => ({candidate, status: 'present', canonical, file: true});

test('inert complete ARM binding permits only the accepted package and unchanged baseline', () => {
  assert.doesNotThrow(() => assertBinding(binding(), host));
});
test('non-ARM, Electron drivers and unsupported Node cannot pass the launch admission', () => {
  for (const changed of [{arch: 'x64'}, {platform: 'linux'}, {electron: '44.9.0'}, {node: '22.0.0'}])
    assert.throws(() => assertBinding(binding(), {...host, ...changed}));
});
test('missing explicit authority and different archive/ASAR bytes fail before an app is possible', () => {
  for (const change of [b => {b.approvedForOnePositiveUILaunch = false;}, b => {b.allowNormalStartupMetadata = false;},
    b => {b.packageZipPin.sha256 = '0'.repeat(64);}, b => {b.expectedASARPin.bytes++;}, b => {b.vendorIdentityPin = undefined;}]) {
    const b = binding(); change(b); assert.throws(() => assertBinding(b, host));
  }
});
test('changed old source, extra paths and a reused user profile cannot acquire admission', () => {
  for (const change of [b => {b.sourceGuard.oldFilesUnchanged = false;},
    b => {b.sourceGuard.addedPaths.push('electron/codex/runtime.cjs');}, b => {b.home = '/Users/example';},
    b => {b.CLI = '/Applications/ChatGPT.app/Contents/Resources/codex';}]) {
    const b = binding(); change(b); assert.throws(() => assertBinding(b, host));
  }
});
test('default discovery requires the real private vendor CLI rather than a custom fallback', () => {
  const cli = binding().CLI;
  assert.equal(assertDefaultInventory([absent('/Applications/Codex.app/Contents/Resources/codex'), present(cli), present('/usr/local/bin/codex')], cli), 1);
  assert.throws(() => assertDefaultInventory([absent('/usr/bin/codex')], cli));
});
test('earlier actual candidates, unknown inventory errors and duplicate rows block the lane', () => {
  const cli = binding().CLI;
  assert.throws(() => assertDefaultInventory([present('/Applications/Codex.app/Contents/Resources/codex'), present(cli)], cli));
  assert.throws(() => assertDefaultInventory([{candidate: '/usr/bin/codex', status: 'permission-unknown'}, present(cli)], cli));
  assert.throws(() => assertDefaultInventory([absent('/usr/bin/codex'), absent('/usr/bin/codex'), present(cli)], cli));
});
test('visible version/path and empty account state must describe the same real selected runtime', () => {
  const CLI = binding().CLI, state = {accounts: [], runtime: {available: true, path: CLI, version: '0.166.0-alpha.5.1'}};
  const summary = {path: CLI, version: 'Codex CLI ' + state.runtime.version};
  assert.doesNotThrow(() => assertRuntimeObservation(state, summary, CLI));
  assert.throws(() => assertRuntimeObservation({...state, accounts: [{id: 'unexpected-account'}]}, summary, CLI));
  assert.throws(() => assertRuntimeObservation(state, {...summary, path: '/usr/local/bin/codex'}, CLI));
  assert.throws(() => assertRuntimeObservation(state, {...summary, version: 'Codex CLI synthetic'}, CLI));
});
test('a PID or application close alone cannot be reported as original launcher/stream closure', () => {
  const owner = {pid: 31, applicationClosed: true, exitObserved: true, childClosed: true, exit: {code: 0, signal: null}, stdoutEOF: true, stderrEOF: true, stdoutClosed: true, stderrClosed: true};
  assert.doesNotThrow(() => assertOriginalClosure(owner));
  for (const changed of [{stderrEOF: false}, {stdoutEOF: false}, {stderrClosed: false}, {childClosed: false}, {applicationClosed: false}, {exit: {code: 0, signal: 'SIGTERM'}}, {pid: null}])
    assert.throws(() => assertOriginalClosure({...owner, ...changed}));
});

function missingBinding() {
  const b = binding();
  for (const name of ['approvedForOnePositiveUILaunch','vendorApp','CLI','CLISHA256','vendorIdentityPin','vendorInventoryPin']) delete b[name];
  return {...b, scenario: 'missing-cli-first-run', approvedForOneMissingCLIUILaunch: true,
    sourceGuard: {...b.sourceGuard, addedPaths: [...ADDED_PATHS]}};
}
test('missing first-run requires its own exact scenario and authority without a positive vendor grant', () => {
  assert.doesNotThrow(() => assertMissingBinding(missingBinding(), host));
  for (const change of [b => {delete b.scenario;}, b => {b.scenario = 'positive';},
    b => {b.approvedForOneMissingCLIUILaunch = false;}, b => {b.approvedForOnePositiveUILaunch = true;},
    b => {b.vendorIdentityPin = binding().vendorIdentityPin;}, b => {b.CLI = binding().CLI;}]) {
    const b = missingBinding(); change(b); assert.throws(() => assertMissingBinding(b, host));
  }
});
test('missing lane keeps the actual ARM package, unchanged baseline and fresh private profile boundaries', () => {
  for (const changed of [{platform: 'linux'}, {arch: 'x64'}, {electron: '44.9.0'}, {node: '22.0.0'}])
    assert.throws(() => assertMissingBinding(missingBinding(), {...host, ...changed}));
  for (const change of [b => {b.sourceGuard.oldFilesUnchanged = false;}, b => {b.sourceGuard.addedPaths.pop();},
    b => {b.sourceGuard.addedPaths[0] = 'electron/main.cjs';}, b => {b.home = '/Users/other';},
    b => {b.packageZipPin.sha256 = '0'.repeat(64);}, b => {b.expectedASARPin.bytes++;},
    b => {b.allowNormalStartupMetadata = false;}]) {
    const b = missingBinding(); change(b); assert.throws(() => assertMissingBinding(b, host));
  }
});
test('all actual default paths must be absent without assuming the former 63-candidate count', () => {
  assert.doesNotThrow(() => assertAllMissingInventory([absent('/usr/bin/codex')]));
  assert.doesNotThrow(() => assertAllMissingInventory([absent('/usr/bin/codex'), absent('/opt/homebrew/bin/codex')]));
  for (const rows of [[], [absent('/usr/bin/codex'), absent('/usr/bin/codex')],
    [present('/usr/bin/codex')], [{candidate: '/usr/bin/codex', status: 'permission-unknown'}],
    [{candidate: '/usr/bin/codex', status: 'missing', canonical: '/another/cli'}]])
    assert.throws(() => assertAllMissingInventory(rows));
});
test('lstat distinguishes absent candidates from present files, directories, dangling links and unknown failures', () => {
  for (const code of ['ENOENT','ENOTDIR']) {
    const row = missingCandidateRow('/usr/bin/codex', () => {throw Object.assign(new Error(code), {code});});
    assert.deepEqual(row, absent('/usr/bin/codex')); assertAllMissingInventory([row]);
  }
  for (const stat of [{isFile: () => true}, {isDirectory: () => true}, {isSymbolicLink: () => true}]) {
    const row = missingCandidateRow('/usr/bin/codex', () => stat);
    assert.equal(row.status, 'present'); assert.throws(() => assertAllMissingInventory([row]));
  }
  for (const code of ['EACCES','EPERM','EIO'])
    assert.throws(() => missingCandidateRow('/usr/bin/codex', () => {throw Object.assign(new Error(code), {code});}), error => error.code === code);
});
function missingObservation() {
  return {state: {accounts: [], runtime: {available: false, path: null, version: null, errorKind: 'missing',
    error: 'Codex CLI를 찾을 수 없습니다. 설치하거나 실행 파일을 선택해 주십시오.', diagnostics: {records: [{kind: 'missing'}]}}},
  view: {notice: 'Could not find Codex CLI. Install it or choose its executable.', summaryCount: 0,
    recheckVisible: true, chooseVisible: true, loginDialogCount: 0}};
}
test('only a settled missing runtime with installation guidance can pass the negative UI observation', () => {
  const {state, view} = missingObservation(); assert.doesNotThrow(() => assertMissingRuntimeObservation(state, view));
  assert.throws(() => assertMissingRuntimeObservation({accounts: [], runtime: {available: false}}, view));
  for (const change of [s => {s.runtime.errorKind = 'permissions';}, s => {s.runtime.available = true;},
    s => {s.runtime.path = '/usr/bin/codex';}, s => {s.runtime.version = '1.0.0';},
    s => {s.runtime.diagnostics.records = [];}, s => {s.runtime.diagnostics.records.push({kind: 'available'});},
    s => {s.accounts.push({id: 'other'});}, s => {s.runtime.error = 'Log in to continue.';}]) {
    const next = missingObservation(); change(next.state); assert.throws(() => assertMissingRuntimeObservation(next.state, next.view));
  }
});
test('a login notice, stale runtime summary or hidden recovery buttons cannot stand in for missing-CLI guidance', () => {
  for (const change of [v => {v.notice = 'Log in to continue.';}, v => {v.summaryCount = 1;},
    v => {v.chooseVisible = false;}, v => {v.recheckVisible = false;}, v => {v.loginDialogCount = 1;}]) {
    const next = missingObservation(); change(next.view); assert.throws(() => assertMissingRuntimeObservation(next.state, next.view));
  }
});
