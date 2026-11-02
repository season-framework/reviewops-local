// Proposed integration only. No native QA has run from this draft.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const NATIVE_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
export const OWNED_16 = [
  'UI-save-start-provenance-and-core', 'actual-agent-normal', 'actual-agent-cancel',
  'actual-agent-failed', 'actual-fault-selected-recovery',
  'actual-consumer-and-foreign-control-denied', 'midPOST-and-post-response-write-drain',
  'stop-unconfirmed-blocks-then-late-drain-confirms', 'postlaunch-bytes-not-loaded-attestation',
  'view-reopen-and-A-B-A-readiness', 'external200-never-own-URL-proof',
  'two-trusted-windows-binding-draft-review', 'actual-managed-form-unsaved-close-and-quit',
  'actual-late-input-during-service-drain-protected',
  'controlled11s-final-consent-real-app-and-child-exit', 'actual-beforeunload-cancel-quit-reopen',
];
export function assertNativeTarget(target) {
  assert.ok(NATIVE_TARGETS.includes(target));
  assert.equal(`${process.platform}-${process.arch}`, target, 'Run each declared target natively');
  assert.equal(process.versions.electron, undefined, 'The driver must be standalone Node');
}
export const nativeOutput = (repository, target) => path.join(repository, 'test-results', 'owned-service-native', target);
export const nativeRendererRecord = (repository, target) => path.join(nativeOutput(repository, target), 'renderer-build.json');
export const nativePackagedRendererRecord = (repository, target, channel) => path.join(nativeOutput(repository, target), 'packaged', channel, 'renderer-build.json');
async function readJSON(file) {
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 ** 2);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
const preservedError = (message, details = {}) => Object.assign(new Error(message), {preservePrivateRoot: true, ...details});
function exactOwned16(report, target) {
  assert.equal(report.ok, true);
  assert.equal(`${report.platform}-${report.arch}`, target);
  assert.equal(report.syntheticCLI, true); assert.equal(report.externalAI, 0); assert.equal(report.SSH, 0);
  assert.equal(report.cleanup?.status, 'confirmed');
  assert.deepEqual(report.checks.map(row => row.name).sort(), [...OWNED_16].sort(), 'Same sixteen real checks on source and installed app');
  assert.ok(report.checks.every(row => row.status === 'pass'));
}

export async function runRequiredOwnedGate(options) {
  assertNativeTarget(options.target);
  const {runNativeGate} = await import('./native-packet.mjs');
  const observed = await runNativeGate({...options, gate: 'owned16', regressions: options.mode === 'source'});
  try {
    assert.equal(observed.ok, true); assert.equal(observed.cleanupConfirmed, true);
    assert.equal(observed.preservePrivateRoot, false);
    exactOwned16(observed.result, options.target);
  } catch (cause) {
    throw preservedError('Owned native gate is incomplete; retain app and profile', {
      cause, ownedRoot: observed.ownedRoot, resultPath: observed.resultPath,
    });
  }
  return observed;
}

// Observation deadline only. It never kills a compiler, driver, app, or agent.
// On incomplete observation, retained process/stdio handles are unref'ed, never
// signalled or force-closed; the caller must retain its private installation.
export async function observeOwnedCommand({executable = process.execPath, args, cwd, env = process.env,
  reportPath, timeoutMs = 900000, maxBytes = 16 * 1024 ** 2}) {
  await fs.mkdir(path.dirname(reportPath), {recursive: true});
  const stdoutPath = reportPath + '.stdout.log', stderrPath = reportPath + '.stderr.log';
  await fs.writeFile(stdoutPath, ''); await fs.writeFile(stderrPath, '');
  const state = {schema: 1, executable, args, cwd, startedAt: new Date().toISOString(),
    exitObserved: false, closeObserved: false, signalSentByOrchestrator: false, preservePrivateRoot: false};
  const save = () => fsSync.writeFileSync(reportPath, JSON.stringify(state, null, 2) + '\n');
  const child = spawn(executable, args, {cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  state.retainedDriverPid = child.pid || null; save();
  let bytes = 0, timer, settle;
  const completed = new Promise(resolve => { settle = resolve; });
  const consume = file => chunk => {
    bytes += chunk.length;
    if (bytes <= maxBytes) fsSync.appendFileSync(file, chunk);
    else settle({complete: false, reason: 'owned-driver-output-limit'});
  };
  child.stdout.on('data', consume(stdoutPath)); child.stderr.on('data', consume(stderrPath));
  child.once('error', error => settle({complete: false, reason: 'owned-driver-start-error', error: error.message}));
  child.once('exit', (code, signal) => { state.exitObserved = true; state.exit = {code, signal}; save(); });
  child.once('close', (code, signal) => { state.closeObserved = true; settle({complete: true, code, signal}); });
  let outcome;
  try {
    outcome = await Promise.race([completed, new Promise(resolve => {
      timer = setTimeout(() => resolve({complete: false, reason: 'owned-driver-observation-timeout'}), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
  Object.assign(state, {outcome, bytes, finishedAt: new Date().toISOString()});
  if (!outcome.complete || !state.exitObserved || !state.closeObserved || outcome.code !== 0 || outcome.signal) {
    state.preservePrivateRoot = true; save();
    if (!outcome.complete) { child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); }
    throw preservedError('Owned driver failed or its lifetime is unconfirmed; preserve private roots', {resultPath: reportPath});
  }
  save(); return state;
}

export async function runWindowsInstalledSmoke({repository, installer, env = process.env}) {
  assertNativeTarget('win32-x64');
  const observation = path.join(nativeOutput(repository, 'win32-x64'), 'windows-installer', 'driver-observation.json');
  return observeOwnedCommand({args: [path.join(repository, 'scripts', 'windows-release-smoke.mjs'), installer],
    cwd: repository, env, reportPath: observation, timeoutMs: 1200000});
}

async function verifyExistingSharedRegression(repository, target, source, rendererBuildRecord) {
  const rendererStat = await fs.stat(rendererBuildRecord);
  for (const file of ['test-results/live-web-sessions/result.json', 'test-results/qa-viewer-sessions/results.json']) {
    assert.ok((await fs.stat(path.join(repository, file))).mtimeMs >= rendererStat.mtimeMs, 'Shared regression must follow this renderer build record');
  }
  const common = await readJSON(path.join(repository, 'test-results', 'live-web-sessions', 'result.json'));
  const qa = await readJSON(path.join(repository, 'test-results', 'qa-viewer-sessions', 'results.json'));
  assert.equal(common.passed, true); assert.equal(common.source.commit, source); assert.equal(common.source.dirty, false);
  assert.equal(`${common.source.platform}-${common.source.arch}`, target); assert.equal(common.checks.length, 14);
  assert.equal(qa.ok, true); assert.equal(qa.source, source); assert.equal(qa.dirty, false);
  assert.equal(`${qa.platform}-${qa.arch}`, target); assert.equal(qa.checks.length, 8);
  assert.ok(qa.checks.every(row => row.status === 'pass'));
  return {common14: path.join(repository, 'test-results/live-web-sessions/result.json'),
    qa8: path.join(repository, 'test-results/qa-viewer-sessions/results.json')};
}

export async function runSourceOwnedAndRegression({repository, target, source}) {
  assertNativeTarget(target); assert.match(source, /^[a-f0-9]{40}$/);
  const suites = [
    {gate: 'panel8', script: 'e2e-service-readiness-native.mjs', count: 8},
    {gate: 'concurrent10', script: 'e2e-concurrent-qa-native.mjs', count: 10},
  ];
  // A missing portable implementation is a failure, before opening another app.
  for (const suite of suites) await fs.access(path.join(repository, 'scripts', suite.script));
  const rendererBuildRecord = nativeRendererRecord(repository, target);
  const previous = await verifyExistingSharedRegression(repository, target, source, rendererBuildRecord);
  const summaryPath = path.join(nativeOutput(repository, target), 'source-gates.json');
  const summary = {schema: 1, source, target, mode: 'source', ok: false, previous, gates: [], fullIssueComplete: false};
  const save = () => fsSync.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  await fs.mkdir(path.dirname(summaryPath), {recursive: true}); save();
  try {
    const owned = await runRequiredOwnedGate({repository, target, mode: 'source', rendererBuildRecord});
    assert.equal(owned.result.source, source);
    summary.gates.push({gate: 'owned16', resultPath: owned.resultPath, cleanupConfirmed: true}); save();
    const {prepareNativePacket,snapshotNativeFixtureEvidence} = await import('./native-packet.mjs');
    for (const suite of suites) {
      const previousInput = owned.regressionInputs?.[suite.gate];
      const packet = previousInput ? {...await readJSON(previousInput), inputPath: previousInput}
        : await prepareNativePacket({repository, target, mode: 'source', gate: suite.gate, rendererBuildRecord}).then(value=>({...value.packet,inputPath:value.inputPath}));
      try {
        await observeOwnedCommand({args: [path.join(repository, 'scripts', suite.script), '--run', '--target', target,
          '--mode', 'source', '--source', source, '--inputs', packet.inputPath], cwd: repository,
          env: {...process.env, REVIEWOPS_LIVE_CODEX: '0', REVIEWOPS_LIVE_CLAUDE: ''},
          reportPath: path.join(nativeOutput(repository, target), suite.gate, 'driver-observation.json')});
        const report = await readJSON(packet.resultPath);
        assert.equal(report.ok, true); assert.equal(report.source, source);
        assert.equal(`${report.platform}-${report.arch}`, target); assert.equal(report.checks.length, suite.count);
        assert.equal(report.cleanup?.status, 'confirmed');
        assert.ok(report.checks.every(row => row.status === 'pass' || row.verdict === '통과'));
        summary.gates.push({gate: suite.gate, resultPath: packet.resultPath, checks: suite.count, cleanupConfirmed: true}); save();
      } catch (error) {
        try{snapshotNativeFixtureEvidence({packet});}catch{}
        throw preservedError('Required portable regression incomplete: ' + suite.gate,
          {cause: error, ownedRoot: packet.ownedRoot, resultPath: packet.resultPath});
      }
    }
    summary.ok = true; save(); return summary;
  } catch (error) {
    summary.failure = {message: error.message, ownedRoot: error.ownedRoot || null,
      resultPath: error.resultPath || null, preservePrivateRoot: error.preservePrivateRoot === true};
    save(); throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const action = args.shift(), options = {};
  assert.equal(action, 'source');
  assert.equal(args.length, 4, 'source requires exact --target and --source');
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--target', '--source'].includes(args[i]));
    assert.equal(options[args[i]], undefined); options[args[i]] = args[i + 1];
  }
  return runSourceOwnedAndRegression({repository: fsSync.realpathSync(process.cwd()), target: options['--target'], source: options['--source']});
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
