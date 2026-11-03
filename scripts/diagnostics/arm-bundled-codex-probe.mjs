// Native vendor metadata only. Import the unchanged production finder after guards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const [bindingFile, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert.ok(path.isAbsolute(bindingFile));
const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(process.versions.node, '24.22.2');
assert.equal(process.versions.electron, undefined);
assert.equal(os.homedir(), binding.home);
assert.equal(process.env.CODEX_HOME, binding.codeHome);
assert.equal(process.resourcesPath, undefined);
assert.equal(binding.maximumVersionLaunches, 1);
assert.equal(fs.existsSync(path.join(binding.codeHome, 'auth.json')), false);
assert.equal(fs.readFileSync(path.join(binding.codeHome, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n');
const environmentNames = Object.keys(process.env).sort();
const environmentNamesTruncated = environmentNames.length > 32 || environmentNames.some(key => key.length > 128);
fs.writeFileSync(path.join(binding.output, 'probe-environment-names.json'), JSON.stringify({environmentNames: environmentNames.slice(0, 32).map(key => key.slice(0, 128)), environmentNamesTruncated, environmentValuesRecorded: false}, null, 2) + '\n', {flag: 'wx'});
const allowedEnv = new Set(['HOME', 'CODEX_HOME', 'TMPDIR', 'PATH', 'LANG', 'TZ', '__CF_USER_TEXT_ENCODING']);
assert.equal(environmentNamesTruncated, false);
assert.ok(environmentNames.every(key => allowedEnv.has(key)));
const hash = file => {
  const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024), fd = fs.openSync(file, 'r');
  try {for (;;) {const bytes = fs.readSync(fd, buffer, 0, buffer.length, null); if (!bytes) break; digest.update(buffer.subarray(0, bytes));}}
  finally {fs.closeSync(fd);}
  return digest.digest('hex');
};
const write = (name, value) => fs.writeFileSync(path.join(binding.output, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const journalFile = path.join(binding.output, 'original-version-child.jsonl');
const note = value => fs.appendFileSync(journalFile, JSON.stringify({at: new Date().toISOString(), ...value}) + '\n');
const realCLI = await fsp.realpath(binding.CLI);
assert.equal(realCLI, binding.CLI);
const fingerprint = file => {const value = fs.statSync(file); return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode];};
const sealedCLI = fingerprint(realCLI);
assert.equal(hash(realCLI), binding.CLISHA256);
assert.deepEqual(fingerprint(realCLI), sealedCLI);
const pins = JSON.parse(fs.readFileSync(path.join(binding.root, 'scripts/diagnostics/arm-bundled-codex-source.json'), 'utf8'));
for (const row of pins.files) {
  const file = path.join(binding.root, row.path), stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.size, row.bytes);
  assert.equal(stat.mode & 0o777, row.mode);
  assert.equal(hash(file), row.sha256);
}

const {createRuntimeFinder, defaultCandidates, platformTarget} = (await import(pathToFileURL(path.join(binding.root, 'electron/codex/runtime.cjs')))).default;
assert.equal(typeof createRuntimeFinder, 'function');
assert.equal(typeof defaultCandidates, 'function');
assert.equal(typeof platformTarget, 'function');
const candidates = defaultCandidates({home: binding.home, env: process.env, platform: process.platform, target: platformTarget(process.platform, process.arch)});
assert.ok(candidates.length > 0 && candidates.length <= 256);
const inventory = [];
for (const candidate of candidates) {
  assert.ok(path.isAbsolute(candidate) && candidate.length <= 4096);
  try {
    const canonical = await fsp.realpath(candidate), stat = await fsp.stat(canonical);
    inventory.push({candidate, canonical, status: 'present', file: stat.isFile()});
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('Candidate inventory is unconfirmed');
    inventory.push({candidate, status: 'missing'});
  }
}
const ownIndex = inventory.findIndex(row => row.status === 'present' && row.file && row.canonical === realCLI);
assert.ok(ownIndex >= 0, 'The genuine nested CLI is absent from production defaults');
const earlier = inventory.slice(0, ownIndex).filter(row => row.status === 'present' && row.canonical !== realCLI);
write('default-candidate-inventory.json', {source: binding.source, inventory, ownIndex, earlierPresentCandidates: earlier, inspectedOnly: true});
const lane = earlier.length ? 'custom-path-diagnostic' : 'default-discovery';
if (earlier.length && binding.allowCustomPathDiagnostic !== true) {
  write('runtime-result.json', {ok: false, lane: 'default-admission-stopped', defaultDiscoveryProven: false, versionLaunches: 0, reason: 'An earlier real candidate exists; custom diagnostic was not preapproved.'});
  throw new Error('Default lane stopped before any CLI launch');
}

let launches = 0, spawned = 0;
let retained = null;
let exit = null;
let close = null;
let closePromise;
let stdoutBytes = 0, stderrBytes = 0;
function tracedExecFile(command, args, options, callback) {
  assert.equal(launches, 0, 'At most one actual CLI version child');
  assert.equal(command, realCLI);
  assert.deepEqual(args, ['--version']);
  assert.equal(options.shell, false);
  assert.equal(options.timeout, 0, 'Keep the unchanged production AbortController deadline');
  assert.equal(options.maxBuffer, 64 * 1024);
  assert.ok(options.signal && !options.signal.aborted);
  assert.deepEqual(options.env, process.env);
  // Keep hashing outside the product's five-second launch deadline. The
  // unchanged production executor also rechecks this file's stat fingerprint.
  assert.deepEqual(fingerprint(realCLI), sealedCLI);
  const nonce = crypto.randomUUID();
  launches++;
  // Forward the real callback and all options unchanged; no fake results.
  const child = execFile(command, args, options, callback);
  retained = {child, nonce};
  note({phase: 'original-child-retained', nonce, pid: child.pid, parentPID: process.pid, command, args, cwd: process.cwd(), executableSHA256: binding.CLISHA256});
  child.once('spawn', () => {spawned++; note({phase: 'original-child-spawned', nonce, pid: child.pid, parentPID: process.pid});});
  child.stdout.on('data', chunk => {stdoutBytes += chunk.length;});
  child.stderr.on('data', chunk => {stderrBytes += chunk.length;});
  child.once('error', error => note({phase: 'original-child-error', nonce, pid: child.pid, code: typeof error.code === 'string' ? error.code : null}));
  child.once('exit', (code, signal) => {exit = {code, signal}; note({phase: 'original-child-exit', nonce, pid: child.pid, ...exit});});
  closePromise = new Promise(resolve => child.once('close', (code, signal) => {
    close = {code, signal, stdoutDestroyed: child.stdout.destroyed, stderrDestroyed: child.stderr.destroyed};
    note({phase: 'original-stdio-close', nonce, pid: child.pid, ...close, stdoutBytes, stderrBytes});
    resolve();
  }));
  return child;
}

let result;
let error = null;
try {
  // No candidate, execute-result, platform, architecture or clock override.
  const finder = createRuntimeFinder({home: binding.home, env: process.env, execFile: tracedExecFile});
  result = await finder(lane === 'custom-path-diagnostic' ? realCLI : '');
  assert.equal(launches, 1);
  let timer;
  try {
    await Promise.race([closePromise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Original version child closure is unconfirmed')), 10000);})]);
  } finally {clearTimeout(timer);}
  assert.equal(spawned, 1);
  assert.equal(retained.child.pid > 0, true);
  assert.deepEqual(exit, {code: 0, signal: null});
  assert.equal(close.code, 0);
  assert.equal(close.signal, null);
  assert.ok(close.stdoutDestroyed && close.stderrDestroyed);
  assert.equal(result.available, true);
  assert.equal(await fsp.realpath(result.path), realCLI);
  assert.equal(result.command, realCLI);
  assert.deepEqual(result.args, []);
  assert.ok(result.diagnostics.records.some(row => row.kind === 'available' && row.architecture?.split(',').includes('arm64')));
  assert.equal(hash(realCLI), binding.CLISHA256);
} catch (caught) {
  error = caught.message;
} finally {
  write('runtime-result.json', {ok: error === null, source: binding.source, lane, defaultDiscoveryProven: error === null && lane === 'default-discovery', versionLaunches: spawned, versionExecFileCalls: launches, version: result?.version || null, runtime: result || null, originalPID: retained?.child.pid || null, exit, close, error, harnessSignalsRequested: 0, authModelLoginAppServerStarts: 0});
}
if (error) process.exitCode = 1;
