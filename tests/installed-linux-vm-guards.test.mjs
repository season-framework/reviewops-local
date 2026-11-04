// Inert fixture bodies: no subprocess/socket/key/tool/guest/app operations; one owned file fixture is <64 KiB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run as ownerRun, verifyPin, verifyEvidencePin, readLiveClosure, materializeUIBinding} from '../scripts/diagnostics/installed-linux-permission-vm.mjs';
import crypto from 'node:crypto';
import {assertBinding as actualUIAdmission, BUILD as ACTUAL_UI_BUILD, FAILURE_TEXT_CAP, boundedFailureSummary,
  readOwnedUIState, captureFailureEvidence} from '../scripts/diagnostics/installed-linux-permission-ui-v2.mjs';
import {strictJSON, QMPFrames, QMPProtocol, OriginalVM, closure, uiCleanup, powerdownSafe, inspectSeedISO,
  publicKey, seedFiles, bootstrapMarker, witnessSource, materialized, assertParentAuthority, unboundRequest,
  hashBytes, CONTRACT, PRODUCT_SOURCE, R3_ROOT_SHA256, UI_SHA256, UI_CI_KEYS, uiChildEnvironment,
  EvidencePersistence, evidenceSaver, LIVE_LIMITS, LIVE_TYPE, inventoryShape, resolveInventoryLink,
  privatePrefixShape} from '../scripts/diagnostics/installed-linux-vm-guards.mjs';

assert.match(process.versions.node, /^24\./, 'Run the inert suite with the pinned Node 24 interpreter');
console.log(JSON.stringify({scope: 'inert VM guards and import-safe owner export', node: process.version,
  testAuthoredSubprocessCalls: 0, testAuthoredSocketCalls: 0, keysGenerated: 0, testAuthoredFileFixtureMaximumBytes: 65535}));
const clone = value => JSON.parse(JSON.stringify(value));
const packet = value => Buffer.from(JSON.stringify(value) + '\r\n');
const greeting = {QMP: {version: {qemu: {major: 11, minor: 1, micro: 3}, package: 'fixture'}, capabilities: []}};
function negotiated() { const p = new QMPProtocol(); p.receive(greeting); p.command('qmp_capabilities', 'cap'); p.receive({id: 'cap', return: {}}); return p; }
function originalClosure() { return {exitObserved: true, closed: true, exit: {code: 0, signal: null}, stdoutEOF: true, stderrEOF: true, stdoutClosed: true, stderrClosed: true, stdoutFileClosed: true, stderrFileClosed: true, failedObservation: null}; }
function cleanUI() { return {permissionRestored: true, controlConnectionClosed: true, cleanupConfirmed: true, appLaunchAttempts: 1, normalQuitRequests: 1,
  originalApp: {applicationClosed: true, childClosed: true, exitObserved: true, exit: {code: 0, signal: null}, stdoutEOF: true, stderrEOF: true, stdoutClosed: true, stderrClosed: true}}; }

test('owner import exposes an entry without activating unbound authority', () => {
  assert.equal(typeof ownerRun, 'function'); assert.equal(unboundRequest().authority.approved, false);
  assert.equal(unboundRequest().inputPins.runtimeRoot, null);
});

test('strict JSON rejects escaped-equivalent duplicate keys and trailing/invalid JSON', () => {
  assert.equal(strictJSON('{"b":2,"a":1}').a, 1);
  for (const value of ['{"id":1,"\\u0069d":2}', '{"x":{"a":1,"a":2}}', '{"a":01}', '{"a":1,}', '{"a":1}true', '"unterminated', '{"a":"\\q"}']) {
    assert.throws(() => strictJSON(value), value);
  }
  assert.throws(() => strictJSON('['.repeat(26) + '0' + ']'.repeat(26)), /json-depth-count/);
});

test('QMP framing joins split UTF-8 and CRLF while preserving distinct objects', () => {
  const frame = new QMPFrames(), bytes = Buffer.concat([packet({event: 'NOTE', data: {text: '한글'}}), packet({id: 'x', return: {}})]);
  const output = []; for (const byte of bytes) output.push(...frame.push(Buffer.from([byte])));
  assert.equal(output.length, 2); assert.equal(output[0].data.text, '한글'); assert.equal(output[1].id, 'x'); frame.end();
  assert.throws(() => new QMPFrames().push(Buffer.from('{"a":1}\n')), /qmp-crlf/);
  const partial = new QMPFrames(); partial.push(Buffer.from('{"a":1}\r')); assert.throws(() => partial.end(), /qmp-partial-eof/);
  assert.throws(() => new QMPFrames().push(Buffer.from('{"id":1,"\\u0069d":2}\r\n')), /json-duplicate-key/);
});

test('QMP one outstanding ID rejects foreign replies and never resends', () => {
  const p = negotiated(); p.command('query-status', 'status');
  assert.throws(() => p.command('query-target', 'target'), /qmp-one-outstanding/);
  assert.throws(() => p.receive({id: 'foreign', return: {status: 'running'}}), /qmp-reply-id/);
  p.receive({event: 'STOP', data: {}}); const r = p.receive({return: {status: 'running'}, id: 'status'});
  assert.equal(r.value.status, 'running'); assert.equal(p.outstanding, null);
});

test('powerdown acknowledgement and POWERDOWN are insufficient; exact post-request event is required', () => {
  const p = negotiated(); p.command('system_powerdown', 'poweroff'); p.receive({return: {}, id: 'poweroff'});
  assert.equal(p.normalPoweroff(), false); p.receive({event: 'POWERDOWN', data: {}}); assert.equal(p.normalPoweroff(), false);
  p.receive({event: 'SHUTDOWN', data: {guest: true, reason: 'guest-shutdown'}}); assert.equal(p.normalPoweroff(), true);
  assert.throws(() => p.command('system_powerdown', 'again'), /qmp-powerdown-once/);
  for (const event of [{event: 'RESET'}, {event: 'GUEST_PANICKED'}, {event: 'SHUTDOWN', data: {guest: true, reason: 'guest-reset'}},
    {event: 'SHUTDOWN', data: {guest: false, reason: 'host-qmp-quit'}}]) {
    const bad = negotiated(); bad.command('system_powerdown', 'off'); bad.receive({id: 'off', return: {}}); bad.receive(event); assert.equal(bad.normalPoweroff(), false);
  }
  const early = negotiated(); early.receive({event: 'SHUTDOWN', data: {guest: true, reason: 'guest-shutdown'}}); assert.equal(early.normalPoweroff(), false);
});

test('current original identity and actual closure cannot be replaced by a closed foreign owner', () => {
  const life = new OriginalVM(), token = life.begin(), original = {}, foreign = {}; life.retain(token, original);
  assert.throws(() => life.retain(token, foreign), /vm-current-original/); assert.throws(() => life.begin(), /vm-once/);
  const context = {bootstrapClosed: true, uiLaunchAttempts: 1, uiChildStarted: true, uiDriverClosed: true, uiResult: cleanUI()};
  assert.throws(() => life.powerdown(foreign, context), /vm-powerdown-admission/); life.powerdown(original, context);
  const qmp = negotiated(); qmp.command('system_powerdown', 'off'); qmp.receive({id: 'off', return: {}}); qmp.receive({event: 'SHUTDOWN', data: {guest: true, reason: 'guest-shutdown'}});
  assert.throws(() => life.confirm(foreign, originalClosure(), qmp), /vm-normal-closure/);
  const noEOF = originalClosure(); noEOF.stderrEOF = false; assert.throws(() => life.confirm(original, noEOF, qmp), /vm-normal-closure/);
  life.confirm(original, originalClosure(), qmp);
  const prehandle = new OriginalVM(); prehandle.begin(); assert.equal(prehandle.matches(original), false);
});

test('pre-UI failure can power down only with explicit no-attempt/no-deny and bootstrap closure', () => {
  const untouched = {bootstrapClosed: true, uiLaunchAttempts: 0, uiChildStarted: false, denyOperationPossible: false};
  assert.equal(powerdownSafe(untouched), true);
  for (const changed of [{...untouched, bootstrapClosed: false}, {...untouched, uiLaunchAttempts: 1}, {...untouched, denyOperationPossible: true}]) assert.equal(powerdownSafe(changed), false);
  const post = {bootstrapClosed: true, uiLaunchAttempts: 1, uiChildStarted: true, uiDriverClosed: true, uiResult: cleanUI()};
  assert.equal(powerdownSafe(post), true); post.uiResult.permissionRestored = false; assert.equal(powerdownSafe(post), false);
  assert.equal(uiCleanup({...cleanUI(), normalQuitRequests: 0}), false);
  assert.equal(closure({...originalClosure(), exit: {code: 1, signal: null}}), false);
});

function isoFixture() {
  const bytes = Buffer.alloc(32 * 2048), expected = {'user-data': Buffer.from('#cloud-config\n'), 'meta-data': Buffer.from('instance-id: fixture\n'), 'network-config': Buffer.from('version: 2\n')};
  const u32 = (b, at, n) => { b.writeUInt32LE(n, at); b.writeUInt32BE(n, at + 4); };
  const u16 = (b, at, n) => { b.writeUInt16LE(n, at); b.writeUInt16BE(n, at + 2); };
  const be = s => { const b = Buffer.alloc(s.length * 2); [...s].forEach((c, i) => b.writeUInt16BE(c.charCodeAt(0), i * 2)); return b; };
  const record = (name, sector, size, flags = 0) => { const b = Buffer.alloc(33 + name.length + (name.length % 2 === 0 ? 1 : 0)); b[0] = b.length; u32(b, 2, sector); u32(b, 10, size); b[25] = flags; u16(b, 28, 1); b[32] = name.length; name.copy(b, 33); return b; };
  for (const [sector, type, rootSector] of [[16, 1, 20], [17, 2, 21]]) {
    const d = bytes.subarray(sector * 2048, (sector + 1) * 2048); d[0] = type; d.write('CD001', 1); d[6] = 1;
    if (type === 1) d.fill(32, 40, 72), d.write('CIDATA', 40); else { be('cidata'.padEnd(16)).copy(d, 40); d.write('%/E', 88); }
    u32(d, 80, 32); u16(d, 128, 2048); record(Buffer.from([0]), rootSector, 2048, 2).copy(d, 156);
    let at = rootSector * 2048;
    for (const dot of [0, 1]) { const row = record(Buffer.from([dot]), rootSector, 2048, 2); row.copy(bytes, at); at += row.length; }
    Object.entries(expected).forEach(([name, content], i) => { content.copy(bytes, (22 + i) * 2048);
      const row = record(type === 2 ? be(name + ';1') : Buffer.from(['USER_DAT;1', 'META_DAT;1', 'NETWORK_;1'][i]), 22 + i, content.length); row.copy(bytes, at); at += row.length; });
  }
  bytes[18 * 2048] = 255; bytes.write('CD001', 18 * 2048 + 1); bytes[18 * 2048 + 6] = 1;
  return {bytes, expected};
}

test('actual ISO namespace parser checks label, exact files/bytes and primary/Joliet extent agreement', () => {
  const {bytes, expected} = isoFixture(), result = inspectSeedISO(bytes, expected);
  assert.equal(result.files.length, 3); assert.equal(result.primaryLabel, 'CIDATA');
  const badLabel = Buffer.from(bytes); badLabel.write('BADBAD', 16 * 2048 + 40); assert.throws(() => inspectSeedISO(badLabel, expected), /iso-cidata-label/);
  const changedContent = Buffer.from(bytes); changedContent[22 * 2048] ^= 1; assert.throws(() => inspectSeedISO(changedContent, expected), /iso-exact-content/);
  assert.throws(() => inspectSeedISO(bytes.subarray(0, 24 * 2048), expected), /iso-volume-size|iso-file-bounds/);
  const wrongEndian = Buffer.from(bytes); wrongEndian[16 * 2048 + 84] ^= 1; assert.throws(() => inspectSeedISO(wrongEndian, expected), /iso-u32-pair/);
});

const wire = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
const fixturePublicKey = 'ssh-ed25519 ' + wire.toString('base64') + ' inert-public-fixture';
test('public host key parsing binds wire bytes without generating a private key', () => {
  const key = publicKey(fixturePublicKey); assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.throws(() => publicKey('ssh-rsa ' + wire.toString('base64')), /public-key-type/);
  assert.throws(() => publicKey('ssh-ed25519 AAAA'), /public-key-wire/);
  const marker = {nonce: 'a'.repeat(32), username: 'rvqa', uid: 1001, bootId: '11111111-2222-3333-4444-555555555555', platform: 'Linux', machine: 'x86_64', hostPublicKey: fixturePublicKey};
  assert.equal(bootstrapMarker(marker, 'a'.repeat(32)).hostKeyFingerprint, key.fingerprint);
  assert.throws(() => bootstrapMarker(marker, 'b'.repeat(32)), /bootstrap-marker/);
});

test('NoCloud source uses only public key/local marker and refuses arbitrary identity injection', () => {
  const files = seedFiles({username: 'rvqa', uid: 1001, nonce: 'a'.repeat(32), clientPublicKey: fixturePublicKey});
  assert.deepEqual(Object.keys(files).sort(), ['meta-data', 'network-config', 'user-data']);
  const user = files['user-data'].toString(); assert.match(user, /ssh_pwauth: false/); assert.match(user, /disable_root: true/);
  assert.match(user, /REVIEWOPS_BOOTSTRAP/); assert.doesNotMatch(user, /PRIVATE KEY|https?:\/\/|apt-get|packages:/);
  assert.throws(() => seedFiles({username: 'rvqa\nroot', uid: 1001, nonce: 'a'.repeat(32), clientPublicKey: fixturePublicKey}), /seed-identity/);
  assert.throws(() => seedFiles({username: 'rvqa', uid: 0, nonce: 'a'.repeat(32), clientPublicKey: fixturePublicKey}), /seed-identity/);
});

test('witness source records context then execs exact genuine CLI without synthetic responses', () => {
  const source = witnessSource({cli: '/home/rvqa/bin/real', home: '/home/rvqa', codeHome: '/home/rvqa/.codex', logPath: '/home/rvqa/observations/exec.jsonl'}).toString();
  assert.match(source, /os\.execve\(v\["cli"\]/); assert.match(source, /os\.O_NOFOLLOW/); assert.match(source, /forbiddenEnvironmentNames/);
  assert.doesNotMatch(source, /subprocess|socket|print\(/);
  assert.throws(() => witnessSource({cli: '/tmp/foreign', home: '/home/rvqa', codeHome: '/home/rvqa/.codex', logPath: '/home/rvqa/log'}), /witness-paths/);
});

test('materialization preserves historical proof identity and binds a distinct local file explicitly', () => {
  const original = {path: '/Users/season/original.json', bytes: 10, sha256: 'a'.repeat(64)}, local = {...original, path: '/private/tmp/staged.json'};
  materialized(original, local, [{originalPin: original, localPin: local}]);
  assert.throws(() => materialized(original, local, [{originalPin: {...original, path: local.path}, localPin: local}]), /materialization-exact-join/);
  assert.throws(() => materialized(original, {...local, sha256: 'b'.repeat(64)}, []), /materialization-exact-join/);
});

function admittedFixture() {
  const pin = name => ({path: '/private/tmp/' + name, bytes: 10, sha256: 'a'.repeat(64)});
  const b = unboundRequest(); Object.assign(b, {harnessSource: 'b'.repeat(40), runID: 123, root: '/private/tmp/repo', privateRoot: '/private/tmp/r34v-abcdefgh', output: '/private/tmp/repo/test-results/installed-linux-permission-vm/one', machineID: 'pc-i440fx-11.1'});
  for (const k of Object.keys(b.inputPins)) b.inputPins[k] = pin(k); b.inputPins.r3Root.sha256 = R3_ROOT_SHA256;
  for (const k of Object.keys(b.tools)) b.tools[k] = pin(k); b.tools.hdiutil.path = '/usr/bin/hdiutil'; b.tools.sshKeygen.path = '/usr/bin/ssh-keygen';
  b.ui = {driverPin: {...pin('driver'), sha256: UI_SHA256}, privateRoot: b.privateRoot, packageApp: b.privateRoot + '/Applications/ReviewOps.app'};
  for (const k of Object.keys(b.deadlines)) b.deadlines[k] = 1000;
  const code = {requestSHA256: 'c'.repeat(64), ownerSHA256: 'd'.repeat(64), guardsSHA256: 'e'.repeat(64)};
  const a = {approved: true, scope: CONTRACT, requestSHA256: code.requestSHA256, runID: b.runID, harnessSource: b.harnessSource, productSource: PRODUCT_SOURCE,
    ownerSHA256: code.ownerSHA256, guardsSHA256: code.guardsSHA256, uiDriverSHA256: UI_SHA256, predicateContract: CONTRACT,
    allowConditionalGuestProofAndUIApproval: true, maximumVMLaunches: 1, maximumAppLaunches: 1, maximumPowerdownRequests: 1, networkAcquisitionAuthorized: false, inputPins: b.inputPins};
  const host = {platform: 'darwin', arch: 'arm64', node: '24.22.2', uid: 501, sha: b.harnessSource, runID: 123, ci: 'true', actions: 'true', event: 'workflow_dispatch', attempt: 1};
  return {b, a, host, code};
}
test('FALSE/NULL template and altered delegation cannot activate owner or generic self-approval', () => {
  const f = admittedFixture(); assertParentAuthority(f.b, f.a, f.host, f.code);
  for (const change of [{approved: false}, {runID: 124}, {uiDriverSHA256: '0'.repeat(64)}, {allowConditionalGuestProofAndUIApproval: false}, {maximumVMLaunches: 2}]) {
    assert.throws(() => assertParentAuthority(f.b, {...f.a, ...change}, f.host, f.code), /exact-root-delegation/);
  }
  assert.throws(() => assertParentAuthority(unboundRequest(), {approved: false}, f.host, f.code));
  const alias = clone(f.b); alias.machineID = 'pc'; assert.throws(() => assertParentAuthority(alias, f.a, f.host, f.code), /owner-paths-machine/);
  const oldRunner = {...f.host, runID: 122}; assert.throws(() => assertParentAuthority(f.b, f.a, oldRunner, f.code), /owner-request/);
});

test('UI child receives the six admitted CI fields and passes the unchanged driver admission without ambient credentials', () => {
  const privateRoot = '/private/tmp/r34v-abcdefgh', root = '/private/tmp/repo';
  const pin = filename => ({path: filename, bytes: 1, sha256: 'a'.repeat(64)});
  const fixture = {
    schema: 1, phase: 'ui', scenario: 'installed-linux-permission', source: PRODUCT_SOURCE, build: ACTUAL_UI_BUILD,
    harnessSource: 'b'.repeat(40), sourceGuard: {productSource: PRODUCT_SOURCE, harnessSource: 'b'.repeat(40), baselineFiles: 429, existingFilesUnchanged: true},
    root, privateRoot, home: privateRoot + '/home', codeHome: privateRoot + '/home/.codex', dataDir: privateRoot + '/data',
    sshConfig: privateRoot + '/home/.ssh/config', packageApp: privateRoot + '/Applications/ReviewOps.app',
    output: root + '/test-results/installed-linux-permission-ui/one', claimPath: privateRoot + '/installed-linux-permission-ui-once.json',
    preparedSupplyPin: pin('/private/tmp/supply.json'), preparedRootAcceptancePin: pin('/private/tmp/prepared.json'),
    guestRootAcceptancePin: pin('/private/tmp/guest.json'), sourceGuardRootPin: pin('/private/tmp/source.json'),
    packageZipPin: {path: '/private/tmp/app.zip', bytes: 133831763, sha256: '2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead'},
    expectedASARPin: pin(privateRoot + '/Applications/ReviewOps.app/Contents/Resources/app.asar'),
    executablePin: pin(privateRoot + '/Applications/ReviewOps.app/Contents/MacOS/ReviewOps'),
    actualNodeIdentity: pin('/private/tmp/node'), driverPin: pin('/private/tmp/driver.mjs'),
    dependencyPins: [pin('/private/tmp/ssh2.js'), pin('/private/tmp/playwright.js')], allowNormalMetadata: true,
    maximumAppLaunches: 1, newFormalQAIDs: 0, vmLifecycleOwnedByOuterController: true,
    guest: {host: '127.0.0.1', port: 2222, username: 'rvqa', privateKeyPin: pin(privateRoot + '/vm-secrets/client-key'),
      hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43), home: '/home/rvqa', codeHome: '/home/rvqa/.codex',
      identity: {bootId: '11111111-2222-3333-4444-555555555555', uid: 1001, euid: 1001, kernel: 'fixture', machine: 'x86_64'},
      leaf: {path: '/home/rvqa/owned-work', dev: 1, ino: 2, uid: 1001},
      genuineCLI: {...pin('/home/rvqa/bin/real'), version: 'codex-cli 0.166.0'},
      witness: {...pin('/home/rvqa/bin/observed'), logPath: '/home/rvqa/observations/exec.jsonl'}}};
  const base = {HOME: privateRoot + '/owner-home', TMPDIR: privateRoot + '/vm', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC',
    GH_TOKEN: 'must-not-copy', GITHUB_TOKEN: 'must-not-copy', SSH_AUTH_SOCK: '/foreign/agent.sock', NODE_OPTIONS: '--require foreign', OPENAI_API_KEY: 'must-not-copy'};
  const admittedCI = {CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_SHA: fixture.harnessSource};
  const env = uiChildEnvironment(base, admittedCI, {runID: 123, harnessSource: fixture.harnessSource});
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'TMPDIR', 'PATH', 'LANG', 'TZ', ...UI_CI_KEYS].sort());
  for (const key of UI_CI_KEYS) assert.equal(env[key], admittedCI[key]);
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'OPENAI_API_KEY']) assert.equal(Object.hasOwn(env, key), false);
  const childHost = values => ({platform: 'darwin', arch: 'arm64', node: process.versions.node, electron: undefined, uid: 501, euid: 501,
    ci: values.CI, actions: values.GITHUB_ACTIONS, event: values.GITHUB_EVENT_NAME,
    attempt: Number(values.GITHUB_RUN_ATTEMPT), runId: Number(values.GITHUB_RUN_ID), githubSHA: values.GITHUB_SHA});
  assert.throws(() => actualUIAdmission(fixture, childHost(base))); // Reproduces v1's absent child CI data.
  assert.doesNotThrow(() => actualUIAdmission(fixture, childHost(env)));
  assert.throws(() => uiChildEnvironment(base, {...admittedCI, GITHUB_SHA: 'c'.repeat(40)}, {runID: 123, harnessSource: fixture.harnessSource}), /ui-child-admitted-ci/);
});

test('an injected evidence ENOSPC never escapes callbacks or HELD saves, permanently fails widening and still permits observation', () => {
  let writes = 0, drained = 0; const retained = [], diskError = Object.assign(new Error('private text must not be serialized'), {code: 'ENOSPC'});
  const state = {ok: true, events: 0};
  const {evidence, save} = evidenceSaver(state, text => { writes++; if (writes === 1) throw diskError; retained.push(JSON.parse(text)); });
  const callback = () => { save({events: drained}); drained++; };
  assert.doesNotThrow(callback); assert.equal(drained, 1); assert.equal(evidence.failed, true); assert.equal(evidence.failure.code, 'ENOSPC');
  assert.equal(state.ok, false); // A first failure on the final successful-result save cannot leave an OK result.
  assert.throws(() => evidence.requireHealthy(), /evidence-persistence-failed/);
  assert.doesNotThrow(callback); assert.equal(drained, 2); assert.equal(evidence.failed, true);
  assert.equal(retained[0].evidencePersistenceFailure.code, 'ENOSPC'); assert.equal(JSON.stringify(evidence.failure).includes('private text'), false);
  save({ok: true}); assert.equal(state.ok, false); assert.equal(retained[1].ok, false);
  state.bad = {toJSON() { throw Object.assign(new Error('serialization'), {code: 'EIO'}); }};
  const heldTick = () => save({held: true});
  assert.doesNotThrow(heldTick); assert.equal(evidence.failure.code, 'ENOSPC'); // First failure remains permanent.
  const cleanup = {bootstrapClosed: true, uiLaunchAttempts: 0, uiChildStarted: false, denyOperationPossible: false};
  assert.equal(powerdownSafe(cleanup), true); // Storage failure does not invent an unknown app or prohibit safe ordinary cleanup.
  assert.equal(evidence.failed || false, true); // Even clean later observations cannot turn this operation into PASS.
});


test('only permitted regular output evidence accepts an exact empty file; executable and JSON pins remain nonempty', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r34-empty-')));
  const empty = path.join(root, 'empty.stderr'), data = path.join(root, 'nonempty.stdout');
  const directory = path.join(root, 'not-file'), link = path.join(root, 'not-regular');
  const zero = filename => ({path: filename, bytes: 0, sha256: hashBytes(Buffer.alloc(0))});
  try {
    fs.writeFileSync(empty, '', {flag: 'wx', mode: 0o600});
    fs.writeFileSync(data, 'observed output\n', {flag: 'wx', mode: 0o600});
    fs.mkdirSync(directory); fs.symlinkSync(empty, link);
    for (const role of ['probe-stderr', 'original-stdout', 'original-stderr']) {
      assert.equal(verifyEvidencePin(zero(empty), role), empty);
    }
    assert.throws(() => verifyPin(zero(empty)), /pin-shape/); // Actual executable/JSON admission is unchanged.
    assert.throws(() => verifyEvidencePin(zero(empty), 'executable'), /evidence-pin-role/);
    assert.throws(() => verifyEvidencePin(zero(empty), 'json'), /evidence-pin-role/);
    assert.throws(() => verifyEvidencePin(zero(path.join(root, 'missing')), 'probe-stderr'), {code: 'ENOENT'});
    for (const filename of [directory, link]) assert.throws(() => verifyEvidencePin(zero(filename), 'probe-stderr'), /regular-file/);
    assert.throws(() => verifyEvidencePin({...zero(empty), sha256: '0'.repeat(64)}, 'probe-stderr'), /empty-evidence-pin/);
    assert.throws(() => verifyEvidencePin(zero(data), 'probe-stderr'), /file-pin/);
    const content = fs.readFileSync(data), nonempty = {path: data, bytes: content.length, sha256: hashBytes(content)};
    assert.equal(verifyPin(nonempty), data); assert.equal(verifyEvidencePin(nonempty, 'probe-stderr'), data);
    assert.throws(() => verifyEvidencePin({...nonempty, sha256: '0'.repeat(64)}, 'probe-stderr'), /file-pin/);
    assert.equal(content.length < 65536, true);
  } finally {
    for (const filename of [link, data, empty]) if (fs.lstatSync(filename, {throwIfNoEntry: false})) fs.unlinkSync(filename);
    if (fs.existsSync(directory)) fs.rmdirSync(directory); fs.rmdirSync(root);
  }
});

function liveFixture() {
  assert.equal(fs.realpathSync('/tmp'), '/private/tmp', 'Owned fixture uses the same admitted macOS alias');
  const logical = '/tmp/r34' + crypto.randomBytes(2).toString('hex'), root = '/private' + logical;
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r34-live-fixture-')));
  let created = false;
  const populate = () => {
    fs.mkdirSync(root, {mode: 0o700}); created = true;
    for (const name of ['lib', 'share']) fs.mkdirSync(path.join(root, name), {mode: 0o700});
    fs.writeFileSync(path.join(root, 'lib', 'data'), 'owned library fixture\n', {mode: 0o600, flag: 'wx'});
    fs.writeFileSync(path.join(root, 'share', 'empty'), '', {mode: 0o600, flag: 'wx'});
    fs.symlinkSync('../lib/data', path.join(root, 'share', 'link'));
  };
  const inventory = () => {
    const rows = Object.create(null);
    const walk = (directory, relative = '') => { for (const name of fs.readdirSync(directory).sort()) {
      const key = relative ? relative + '/' + name : name, filename = path.join(directory, name), st = fs.lstatSync(filename);
      const row = {mode: st.mode & 0o7777, type: st.mode & 0o170000}; rows[key] = row;
      if (st.isDirectory()) walk(filename, key);
      else if (st.isSymbolicLink()) row.target = fs.readlinkSync(filename);
      else { const raw = fs.readFileSync(filename); row.bytes = raw.length; row.sha256 = hashBytes(raw); }
    } }; walk(root);
    const filename = path.join(storage, 'inventory.json'); fs.writeFileSync(filename, JSON.stringify(rows), {mode: 0o600});
    const raw = fs.readFileSync(filename); assert.ok(raw.length + 655 < 65536);
    return {rows, capability: {logicalPrefix: logical, physicalPrefix: root,
      installedInventoryPin: {path: filename, bytes: raw.length, sha256: hashBytes(raw)}}};
  };
  try { populate(); return {root, logical, storage, inventory, populate, close() {
    if (created) fs.rmSync(root, {recursive: true}); fs.rmSync(storage, {recursive: true});
  }}; } catch (error) { if (created) fs.rmSync(root, {recursive: true}); fs.rmSync(storage, {recursive: true}); throw error; }
}

test('live producer dict admission bounds exact rows, byte budgets and literal relative links', () => {
  const dir = {mode: 0o700, type: LIVE_TYPE.directory}, file = {mode: 0o600, type: LIVE_TYPE.regular, bytes: 0, sha256: hashBytes(Buffer.alloc(0))};
  const rows = {d: dir, 'd/empty': file, link: {mode: 0o755, type: LIVE_TYPE.link, target: 'd/empty'}};
  assert.equal(inventoryShape(rows).regularBytes, 0); assert.equal(resolveInventoryLink('link', rows), 'd/empty');
  for (const bad of [{...rows, '/outside': file}, {...rows, 'd/../other': file}, {...rows, d: {...dir, extra: true}},
    {...rows, 'd/empty': {...file, sha256: '0'.repeat(64)}}, {...rows, 'd/empty': {...file, bytes: LIVE_LIMITS.fileBytes + 1}},
    {...rows, link: {...rows.link, target: '/private/tmp/foreign'}},
    {...rows, link: {...rows.link, target: '../foreign'}}, {...rows, link: {...rows.link, target: 'missing'}},
    {...rows, link: {...rows.link, target: 'link'}}]) assert.throws(() => inventoryShape(bad), /live-/);
  const huge = {a: {...file, bytes: LIVE_LIMITS.fileBytes, sha256: 'a'.repeat(64)},
    b: {...file, bytes: LIVE_LIMITS.fileBytes, sha256: 'a'.repeat(64)}, c: {...file, bytes: 1, sha256: 'a'.repeat(64)}};
  assert.throws(() => inventoryShape(huge), /live-total-byte-cap/);
  const entries = Object.fromEntries(Array.from({length: LIVE_LIMITS.entries + 1}, (_, i) => ['n' + i, file]));
  assert.throws(() => inventoryShape(entries), /live-entry-cap/);
  assert.throws(() => privatePrefixShape({logicalPrefix: '/tmp/r34abcd', physicalPrefix: '/tmp/r34abcd'}), /live-prefix-spelling/);
});

test('live reader matches an exact owned tree including zero-byte data without granting empty executable pins', () => {
  const f = liveFixture(); try {
    const {capability} = f.inventory(), first = readLiveClosure(capability), second = readLiveClosure(capability, first.rootIncarnation);
    assert.equal(first.entries, 5); assert.equal(first.regularFiles, 2); assert.equal(first.symlinks, 1);
    assert.equal(first.regularBytes, Buffer.byteLength('owned library fixture\n')); assert.deepEqual(second.rootIncarnation, first.rootIncarnation);
    assert.equal(first.ok, true); assert.match(first.scope, /not loaded-image, ABI, JIT or guest/);
    assert.throws(() => verifyPin({path: path.join(f.root, 'share/empty'), bytes: 0, sha256: hashBytes(Buffer.alloc(0))}), /pin-shape/);
  } finally { f.close(); }
});

test('live reader refuses changed bytes, modes, types and extra or missing members', () => {
  for (const kind of ['bytes', 'mode', 'type', 'extra', 'missing']) {
    const f = liveFixture(); try {
      const {capability} = f.inventory(), file = path.join(f.root, 'lib/data');
      if (kind === 'bytes') { const changed = fs.readFileSync(file); changed[0] ^= 1; fs.writeFileSync(file, changed); }
      if (kind === 'mode') fs.chmodSync(file, 0o644);
      if (kind === 'type') { fs.unlinkSync(file); fs.mkdirSync(file, {mode: 0o600}); }
      if (kind === 'extra') fs.writeFileSync(path.join(f.root, 'extra'), 'extra', {flag: 'wx'});
      if (kind === 'missing') fs.unlinkSync(path.join(f.root, 'share/empty'));
      assert.throws(() => readLiveClosure(capability), /live-/, kind);
    } finally { f.close(); }
  }
});

test('outside and cyclic link targets are refused before any outside file is opened', () => {
  const f = liveFixture(); try {
    const original = f.inventory(), outside = path.join(f.storage, 'outside'); fs.writeFileSync(outside, 'outside-owned-fixture');
    const opened = [], io = {...fs, openSync(filename, ...args) { opened.push(filename); assert.notEqual(filename, outside); return fs.openSync(filename, ...args); }};
    const link = path.join(f.root, 'share/link'); fs.unlinkSync(link); fs.symlinkSync(path.relative(path.dirname(link), outside), link);
    assert.throws(() => readLiveClosure(original.capability, null, io), /live-link-target/);
    assert.throws(() => readLiveClosure(f.inventory().capability, null, io), /live-link-/);
    fs.unlinkSync(link); fs.symlinkSync('../other', link); fs.symlinkSync('share/link', path.join(f.root, 'other'));
    assert.throws(() => readLiveClosure(f.inventory().capability, null, io), /live-link-cycle-cap/);
    assert.equal(opened.includes(outside), false);
  } finally { f.close(); }
});

test('the same pathname with a recreated root cannot renew an earlier prefix incarnation', () => {
  const f = liveFixture(), retained = f.root + '-old'; try {
    const {capability} = f.inventory(), first = readLiveClosure(capability);
    fs.renameSync(f.root, retained); f.populate();
    assert.throws(() => readLiveClosure(capability, first.rootIncarnation), /live-prefix-incarnation-changed/);
  } finally { f.close(); if (fs.existsSync(retained)) fs.rmSync(retained, {recursive: true}); }
});

test('an opened file changed during a read fails its descriptor/path identity checks', () => {
  const f = liveFixture(); try {
    const {capability} = f.inventory(), data = path.join(f.root, 'lib/data'), descriptors = new Map(); let changed = false;
    const io = {...fs, openSync(filename, ...args) { const fd = fs.openSync(filename, ...args); descriptors.set(fd, filename); return fd; },
      readSync(fd, ...args) { const count = fs.readSync(fd, ...args);
        if (!changed && descriptors.get(fd) === data && count > 0) { fs.chmodSync(data, 0o644); changed = true; } return count; },
      closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); }};
    assert.throws(() => readLiveClosure(capability, null, io), /live-read-file-changed/);
    assert.equal(changed, true); assert.equal(descriptors.size, 0);
  } finally { f.close(); }
});

test('a read EIO closes every opened descriptor and never repairs or writes the tree', () => {
  const f = liveFixture(); try {
    const {capability} = f.inventory(), data = path.join(f.root, 'lib/data'), descriptors = new Map(); let injected = false;
    const io = {...fs, openSync(filename, ...args) { const fd = fs.openSync(filename, ...args); descriptors.set(fd, filename); return fd; },
      readSync(fd, ...args) { if (descriptors.get(fd) === data) { injected = true; throw Object.assign(new Error('do not serialize contents'), {code: 'EIO'}); } return fs.readSync(fd, ...args); },
      closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
      writeFileSync() { assert.fail('Reader must never write'); }, chmodSync() { assert.fail('Reader must never repair'); }};
    assert.throws(() => readLiveClosure(capability, null, io), {code: 'EIO'}); assert.equal(injected, true); assert.equal(descriptors.size, 0);
    assert.equal(fs.readFileSync(data, 'utf8'), 'owned library fixture\n'); assert.equal(fs.statSync(data).mode & 0o7777, 0o600);
  } finally { f.close(); }
});

test('fixed volume fields accept the observed local hdiutil trailing-NUL padding', () => {
  const {bytes, expected} = isoFixture();
  const primary = Buffer.from('4349444154410000000000000000000000000000000000000000000000000000', 'hex');
  const joliet = Buffer.from('0063006900640061007400610000000000000000000000000000000000000000', 'hex');
  assert.equal(primary.length, 32); assert.equal(joliet.length, 32);
  primary.copy(bytes, 16 * 2048 + 40); joliet.copy(bytes, 17 * 2048 + 40);
  Buffer.from('252f40', 'hex').copy(bytes, 17 * 2048 + 88);
  const result = inspectSeedISO(bytes, expected);
  assert.equal(result.primaryLabel, 'CIDATA'); assert.equal(result.jolietLabel, 'cidata');
  assert.equal(result.files.length, 3);
});

test('volume padding removal cannot hide leading or internal NULs or a different label', () => {
  for (const [namespace, text] of [['primary', '\0CIDATA'], ['primary', 'CI\0DATA'], ['primary', 'CIDATAX'],
    ['joliet', '\0cidata'], ['joliet', 'ci\0data'], ['joliet', 'cidatb']]) {
    const {bytes, expected} = isoFixture(), field = Buffer.alloc(32);
    if (namespace === 'primary') field.write(text, 'ascii');
    else [...text].forEach((character, index) => field.writeUInt16BE(character.charCodeAt(0), index * 2));
    field.copy(bytes, (namespace === 'primary' ? 16 : 17) * 2048 + 40);
    assert.throws(() => inspectSeedISO(bytes, expected), /iso-cidata-label/, namespace + ':' + JSON.stringify(text));
  }
});

function strictOwnerUIProjection() {
  const root = '/private/tmp/fixture-repo', privateRoot = '/private/tmp/r34v-fixture1234', head = 'b'.repeat(40);
  const pin = filename => ({path: filename, bytes: 1, sha256: 'a'.repeat(64)});
  const ui = {root, privateRoot, build: ACTUAL_UI_BUILD, packageApp: privateRoot + '/Applications/ReviewOps.app',
    home: privateRoot + '/home', codeHome: privateRoot + '/home/.codex', dataDir: privateRoot + '/data',
    sshConfig: privateRoot + '/home/.ssh/config', output: root + '/test-results/installed-linux-permission-ui/one',
    claimPath: privateRoot + '/installed-linux-permission-ui-once.json', driverPin: pin(root + '/driver.mjs'),
    packageZipPin: {path: privateRoot + '/app.zip', bytes: 133831763, sha256: '2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead'},
    expectedASARPin: pin(privateRoot + '/Applications/ReviewOps.app/Contents/Resources/app.asar'),
    executablePin: pin(privateRoot + '/Applications/ReviewOps.app/Contents/MacOS/ReviewOps'),
    dependencyPins: [pin(root + '/node_modules/playwright/index.js'), pin(root + '/node_modules/ssh2/index.js')]};
  const b = strictJSON(JSON.stringify({ui, harnessSource: head,
    inputPins: {preparedSupply: pin('/private/tmp/supply.json'), sourceRoot: pin('/private/tmp/source.json')},
    tools: {node: {...pin('/private/tmp/node'), version: '24.22.2'}}}));
  const guest = strictJSON(JSON.stringify({host: '127.0.0.1', port: 2222, username: 'rvqa',
    privateKeyPin: pin(privateRoot + '/vm-secrets/client-key'), hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43),
    home: '/home/rvqa', codeHome: '/home/rvqa/.codex',
    identity: {bootId: '11111111-2222-3333-4444-555555555555', uid: 1001, euid: 1001, kernel: 'fixture', machine: 'x86_64'},
    leaf: {path: '/home/rvqa/owned-work', dev: 1, ino: 2, uid: 1001},
    genuineCLI: {...pin('/home/rvqa/owned-bin/codex.real'), version: 'codex-cli 0.166.0'},
    witness: {...pin('/home/rvqa/owned-bin/witness'), logPath: '/home/rvqa/observations/exec.jsonl'}}));
  // Same owner projection, starting with the actual strict request/parser contract.
  const projected = {...b.ui, schema: 1, phase: 'ui', scenario: 'installed-linux-permission', source: PRODUCT_SOURCE, harnessSource: b.harnessSource,
    sourceGuard: {productSource: PRODUCT_SOURCE, harnessSource: b.harnessSource, baselineFiles: 429, existingFilesUnchanged: true},
    preparedSupplyPin: b.inputPins.preparedSupply, preparedRootAcceptancePin: pin('/private/tmp/prepared-root.json'),
    guestRootAcceptancePin: pin('/private/tmp/guest.json'), sourceGuardRootPin: b.inputPins.sourceRoot,
    actualNodeIdentity: b.tools.node, guest, allowNormalMetadata: true, maximumAppLaunches: 1, newFormalQAIDs: 0,
    vmLifecycleOwnedByOuterController: true};
  const host = {platform: 'darwin', arch: 'arm64', node: process.versions.node, electron: undefined, uid: 501, euid: 501,
    ci: 'true', actions: 'true', event: 'workflow_dispatch', attempt: 1, runId: 123, githubSHA: head};
  return {b, projected, host};
}

test('strict request to owner UI projection uses the same JSON reader boundary as the unchanged child', () => {
  const {b, projected, host} = strictOwnerUIProjection();
  assert.equal(Object.getPrototypeOf(b.ui.build), null);
  assert.throws(() => actualUIAdmission(projected, host), {name: 'AssertionError', operator: 'deepStrictEqual'});
  const materialized = materializeUIBinding(projected);
  assert.doesNotThrow(() => actualUIAdmission(materialized, host));
  assert.equal(Object.getPrototypeOf(materialized.build), Object.prototype);
  assert.equal(Object.getPrototypeOf(b.ui.build), null); // Original request/control objects were not normalized.
  assert.equal(JSON.stringify(materialized, null, 2), JSON.stringify(projected, null, 2));
  assert.equal(materialized.claimPath, projected.claimPath); assert.equal(materialized.maximumAppLaunches, 1);
});

test('UI materialization does not normalize authority, launder duplicate input or accept an altered build', () => {
  const authority = strictJSON('{"approved":false,"scope":"original-vm-control"}');
  assert.throws(() => materializeUIBinding(authority), /ui-materialization-scope/);
  assert.equal(authority.approved, false); assert.equal(Object.getPrototypeOf(authority), null);
  assert.throws(() => strictJSON('{"ui":{"build":{"version":"1.4.1","version":"foreign"}}}'), /json-duplicate-key/);
  const {projected, host} = strictOwnerUIProjection();
  projected.build.version = 'foreign';
  assert.throws(() => actualUIAdmission(materializeUIBinding(projected), host), {name: 'AssertionError'});
});

test('failure summary has a closed public-field shape and an 8 KiB UTF-8 cap', () => {
  const large = {phase: 'agent-tab', lang: 'ko', fixtureProjectID: 'fixture-project', visiblePaneCount: 1,
    settingsCount: 1, visibleSettingsCount: 1, agentFieldsCount: 1, visibleAgentFieldsCount: 1,
    visibleProjectIDs: ['fixture-project'], selectedTabs: Array.from({length: 8}, () => ({name: '가'.repeat(128)})),
    visibleButtons: Array.from({length: 100}, () => ({name: '😀'.repeat(128), disabled: true})),
    connectionSaveHint: false, inputValue: 'must-not-copy', modelRPC: {secret: 'must-not-copy'}};
  const summary = boundedFailureSummary(large), raw = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(raw) <= FAILURE_TEXT_CAP); assert.equal(summary.truncated, true);
  assert.equal(summary.visiblePaneCount, 1); assert.equal(summary.fixtureProjectID, 'fixture-project');
  assert.ok(summary.visibleButtons.length < 32); assert.equal(raw.includes('must-not-copy'), false);
  assert.deepEqual(Object.keys(summary).sort(), ['phase', 'lang', 'fixtureProjectID', 'visiblePaneCount', 'settingsCount',
    'visibleSettingsCount', 'agentFieldsCount', 'visibleAgentFieldsCount', 'visibleProjectIDs', 'selectedTabs',
    'visibleButtons', 'connectionSaveHint', 'truncated'].sort());
});

test('owned-page collector reads structural visibility and labels without reading input values', () => {
  const element = (name, shown = true) => Object.defineProperty({disabled: false, getClientRects: () => shown ? [1] : [],
    getAttribute: key => key === 'aria-label' ? name : key === 'data-project-id' ? 'fixture-project' : null,
    innerText: name, textContent: name}, 'value', {get() { throw new Error('Input values are forbidden'); }});
  const button = element('실행 환경 검사'), tab = element('에이전트'), field = element('fields'), hiddenField = element('hidden', false),
    hint = element('프로젝트 연결을 저장한 뒤 에이전트를 설정할 수 있습니다.'), project = element('project');
  const settings = {...element('settings'), querySelectorAll: selector => ({'.agent-settings-fields': [field, hiddenField],
    button: [button], '.original-setting-body>p': [hint]})[selector] || []};
  const pane = {...element('pane'), querySelectorAll: selector => selector === '.original-project-settings' ? [settings]
    : selector === '.original-project[data-project-id]' ? [project] : [tab]};
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  try {
    Object.defineProperty(globalThis, 'document', {configurable: true, value: {documentElement: {lang: 'ko'},
      querySelectorAll: selector => {assert.equal(selector, '.workspace-pane:not([hidden])'); return [pane];}}});
    Object.defineProperty(globalThis, 'getComputedStyle', {configurable: true, value: () => ({visibility: 'visible'})});
    const actual = boundedFailureSummary(readOwnedUIState({phase: 'initial-environment-inspect', fixtureProjectID: 'fixture-project'}));
    assert.equal(actual.visiblePaneCount, 1); assert.equal(actual.agentFieldsCount, 2); assert.equal(actual.visibleAgentFieldsCount, 1);
    assert.deepEqual(actual.visibleButtons, [{name: '실행 환경 검사', disabled: false}]);
    assert.deepEqual(actual.selectedTabs, [{name: '에이전트', disabled: false}]); assert.equal(actual.connectionSaveHint, true);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
    if (oldStyle) Object.defineProperty(globalThis, 'getComputedStyle', oldStyle); else delete globalThis.getComputedStyle;
  }
});

test('secondary evidence failures preserve the original error and scenario verdict before cleanup', async () => {
  const original = {name: 'AssertionError', message: 'original locator failed'}, result = {error: original, conditions: [], photos: [], failurePhotos: [], fixture: {projectId: 'fixture'}};
  let cleanupReached = false;
  try {
    await captureFailureEvidence(result, {evaluate: async () => {throw new TypeError('unretained arbitrary DOM error');}},
      'initial-environment-inspect', async () => {throw new RangeError('unretained screenshot error');}, () => {throw new Error('unretained persistence error');});
  } finally { cleanupReached = true; }
  assert.equal(cleanupReached, true); assert.equal(result.error, original); assert.deepEqual(result.conditions, []);
  assert.deepEqual(result.photos, []); assert.deepEqual(result.failurePhotos, []);
  assert.deepEqual(result.failureEvidence.errors, [{operation: 'dom', name: 'TypeError'}, {operation: 'whole-app-photo', name: 'RangeError'}, {operation: 'persist', name: 'Error'}]);
  assert.equal(JSON.stringify(result.failureEvidence).includes('unretained'), false);
  const calls = [], accepted = {error: original, conditions: [], photos: [], failurePhotos: [], fixture: {projectId: 'fixture'}};
  await captureFailureEvidence(accepted, {evaluate: async (collector, input) => {assert.equal(collector, readOwnedUIState); calls.push('dom'); return {...input, lang: 'ko', visiblePaneCount: 1};}},
    'agent-tab', async () => {calls.push('failure-photo'); return {file: 'INERT-FIXTURE-NOT-A-PNG', sha256: 'a'.repeat(64)};}, () => calls.push('persist'));
  assert.deepEqual(calls, ['dom', 'failure-photo', 'persist']); assert.equal(accepted.error, original);
  assert.equal(accepted.failurePhotos.length, 1); assert.deepEqual(accepted.photos, []); assert.deepEqual(accepted.conditions, []);
});
