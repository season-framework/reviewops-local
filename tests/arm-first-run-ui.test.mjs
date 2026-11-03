// Inert guards only. No vendor CLI, app, filesystem fixture, network or product import.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PACKAGE, assertBinding, assertDefaultInventory, assertRuntimeObservation, assertOriginalClosure} from '../scripts/diagnostics/arm-first-run-ui.mjs';

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
