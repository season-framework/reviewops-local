// Import-safe owner. Runtime work begins only after an exact external Root authority.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {PRODUCT_SOURCE, BASE_SOURCE, CONTRACT, UI_SHA256, R3_ROOT_SHA256, absolute, inside, need, same,
  pinShape, evidencePinShape, hashBytes, strictJSON, QMPFrames, QMPProtocol, OriginalVM, closure, uiCleanup, powerdownSafe,
  inspectSeedISO, publicKey, seedFiles, bootstrapMarker, witnessSource, materialized, assertParentAuthority,
  UI_CI_KEYS, uiChildEnvironment, evidenceSaver, LIVE_LIMITS, LIVE_TYPE, inventoryShape,
  privatePrefixShape, liveIdentity, prefixIncarnation} from './installed-linux-vm-guards.mjs';

const BLOCK = 1024 * 1024, SELF = fileURLToPath(import.meta.url), GUARDS = fileURLToPath(new URL('./installed-linux-vm-guards.mjs', import.meta.url));
function filePin(filename) {
  const before = fs.lstatSync(filename); need(before.isFile() && !before.isSymbolicLink(), 'regular-file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), hash = crypto.createHash('sha256');
  let bytes = 0; const buffer = Buffer.alloc(BLOCK);
  try { const opened = fs.fstatSync(fd); need(opened.dev === before.dev && opened.ino === before.ino, 'same-open-file');
    for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { bytes += count; need(bytes <= 2 * 1024**3, 'file-cap'); hash.update(buffer.subarray(0, count)); }
    const after = fs.fstatSync(fd); need(after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size && after.size === bytes, 'file-stable');
  } finally { fs.closeSync(fd); }
  return {path: filename, bytes, sha256: hash.digest('hex')};
}
export function verifyPin(record) { pinShape(record); need(same(filePin(record.path), {path: record.path, bytes: record.bytes, sha256: record.sha256}), 'file-pin'); return record.path; }
export function verifyEvidencePin(record, role) { evidencePinShape(record, role); need(same(filePin(record.path), {path: record.path, bytes: record.bytes, sha256: record.sha256}), 'file-pin'); return record.path; }
function read(record, maximum = 2 * BLOCK) { const filename = verifyPin(record); need(record.bytes <= maximum, 'json-file-cap'); return strictJSON(fs.readFileSync(filename, 'utf8'), maximum); }

export function materializeUIBinding(projected) {
  need(projected?.schema === 1 && projected.phase === 'ui' && projected.scenario === 'installed-linux-permission', 'ui-materialization-scope');
  // Match the unchanged child driver's JSON.parse read before its identical preflight.
  return JSON.parse(JSON.stringify(projected));
}

// This is filesystem correspondence at an observation boundary, not a dyld/ABI/JIT attestation.
export function readLiveClosure(capability, expectedRoot = null, io = fs) {
  privatePrefixShape(capability); pinShape(capability.installedInventoryPin);
  const root = capability.physicalPrefix, uid = process.getuid(), inventoryPin = capability.installedInventoryPin;
  need(inventoryPin.bytes <= LIVE_LIMITS.jsonBytes, 'live-json-cap');
  const identity = filename => liveIdentity(io.lstatSync(filename, {bigint: true}));
  const isType = (value, kind) => (Number(value.mode) & 0o170000) === kind;
  const sameAt = (filename, expected) => need(same(identity(filename), expected), 'live-path-identity-changed');
  const lineage = filename => {
    const parents = []; let current = path.dirname(filename);
    while (true) { const st = identity(current); need(isType(st, LIVE_TYPE.directory), 'live-ancestor-directory');
      parents.push([current, st]); if (current === path.dirname(current)) return parents; current = path.dirname(current); }
  };
  const checkParents = parents => { for (const [filename, st] of parents)
    need(same(prefixIncarnation(identity(filename)), prefixIncarnation(st)), 'live-ancestor-identity-changed'); };
  const readRegular = (filename, before, maximum, consume, parents) => {
    checkParents(parents); sameAt(filename, before);
    let fd;
    try {
      fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const opened = liveIdentity(io.fstatSync(fd, {bigint: true}));
      need(isType(opened, LIVE_TYPE.regular) && same(opened, before), 'live-open-file-identity');
      let bytes = 0; const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(BLOCK);
      for (let count; (count = io.readSync(fd, buffer, 0, Math.min(buffer.length, maximum + 1 - bytes), null)) > 0;) {
        bytes += count; need(bytes <= maximum, 'live-read-byte-cap');
        hash.update(buffer.subarray(0, count)); consume?.(buffer.subarray(0, count));
      }
      need(bytes === Number(opened.size) && same(liveIdentity(io.fstatSync(fd, {bigint: true})), opened), 'live-read-file-changed');
      sameAt(filename, before); checkParents(parents);
      return {bytes, sha256: hash.digest('hex')};
    } finally { if (fd !== undefined) io.closeSync(fd); }
  };
  const inputBefore = identity(inventoryPin.path), inputParents = lineage(inventoryPin.path), pieces = [];
  need(isType(inputBefore, LIVE_TYPE.regular) && Number(inputBefore.size) === inventoryPin.bytes, 'live-inventory-file');
  const inputObserved = readRegular(inventoryPin.path, inputBefore, LIVE_LIMITS.jsonBytes,
    bytes => pieces.push(Buffer.from(bytes)), inputParents);
  need(inputObserved.bytes === inventoryPin.bytes && inputObserved.sha256 === inventoryPin.sha256, 'live-inventory-pin');
  let text; try { text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(pieces)); }
  catch { need(false, 'live-json-utf8'); }
  const rows = strictJSON(text, LIVE_LIMITS.jsonBytes), counts = inventoryShape(rows);
  const rootBefore = identity(root), rootIncarnation = prefixIncarnation(rootBefore), rootParents = lineage(root);
  need(isType(rootBefore, LIVE_TYPE.directory) && Number(rootBefore.uid) === uid &&
    (Number(rootBefore.mode) & 0o7777) === 0o700 && io.realpathSync('/tmp') === '/private/tmp' &&
    io.realpathSync(root) === root && io.realpathSync(capability.logicalPrefix) === root, 'live-owned-canonical-root');
  if (expectedRoot !== null) need(same(rootIncarnation, expectedRoot), 'live-prefix-incarnation-changed');
  const observed = new Map(), directories = new Map([[root, rootBefore]]);
  const walk = (directory, relative) => {
    const before = directories.get(directory); sameAt(directory, before); checkParents(rootParents);
    const names = io.readdirSync(directory).sort();
    need(names.length <= LIVE_LIMITS.entries, 'live-directory-entry-cap');
    for (const name of names) {
      const relativeName = relative ? relative + '/' + name : name, row = rows[relativeName];
      need(row && !observed.has(relativeName) && observed.size < LIVE_LIMITS.entries, 'live-extra-entry');
      const filename = path.join(directory, name), st = identity(filename);
      need(Number(st.uid) === uid && (Number(st.mode) & 0o170000) === row.type &&
        (Number(st.mode) & 0o7777) === row.mode, 'live-entry-type-mode-owner');
      observed.set(relativeName, st);
      if (row.type === LIVE_TYPE.directory) { directories.set(filename, st); walk(filename, relativeName); }
      else if (row.type === LIVE_TYPE.link) {
        need(io.readlinkSync(filename) === row.target, 'live-link-target'); sameAt(filename, st);
      } else need(Number(st.size) === row.bytes, 'live-file-size');
      sameAt(directory, before);
    }
    sameAt(directory, before);
  };
  walk(root, ''); need(observed.size === counts.entries, 'live-missing-entry');
  const privateParents = filename => {
    const output = []; let current = path.dirname(filename);
    while (true) { need(directories.has(current), 'live-declared-ancestor'); output.push([current, directories.get(current)]);
      if (current === root) break; current = path.dirname(current); }
    return [...output, ...rootParents];
  };
  let regularBytes = 0;
  for (const name of Object.keys(rows).sort()) {
    const row = rows[name], filename = path.join(root, name), before = observed.get(name), parents = privateParents(filename);
    checkParents(parents); sameAt(filename, before);
    if (row.type === LIVE_TYPE.regular) {
      const actual = readRegular(filename, before, row.bytes, null, parents);
      need(actual.bytes === row.bytes && actual.sha256 === row.sha256, 'live-file-seal'); regularBytes += actual.bytes;
    } else if (row.type === LIVE_TYPE.link) need(io.readlinkSync(filename) === row.target, 'live-link-target');
    sameAt(filename, before); checkParents(parents);
  }
  // Enumerate once more without following links; no new/missing member can be hidden by an earlier listing.
  const sealedIdentities = new Map(observed);
  observed.clear(); walk(root, ''); need(observed.size === counts.entries, 'live-missing-entry');
  for (const [name, st] of sealedIdentities) sameAt(path.join(root, name), st);
  for (const [filename, st] of directories) sameAt(filename, st);
  sameAt(root, rootBefore); checkParents(rootParents); sameAt(inventoryPin.path, inputBefore); checkParents(inputParents);
  need(regularBytes === counts.regularBytes, 'live-total-bytes');
  return {ok: true, scope: 'Boundary filesystem correspondence only; not loaded-image, ABI, JIT or guest attestation',
    inventoryPin, rootIncarnation, ...counts, observedRegularBytes: regularBytes};
}
function write(filename, value) { fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600}); return filePin(filename); }
function quote(value) { need(typeof value === 'string' && !/[\0\r\n]/.test(value), 'shell-scalar'); return "'" + value.replaceAll("'", "'\\''") + "'"; }
function python(body, values) { return "python3 - <<'REVIEWOPS_BOOTSTRAP_CONTROL'\nimport os,sys,json,stat,hashlib,platform\nv=json.loads(" + JSON.stringify(JSON.stringify(values)) + ')\n' + body + '\nREVIEWOPS_BOOTSTRAP_CONTROL'; }
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(observe, predicate, milliseconds) { const deadline = Date.now() + milliseconds; do { const value = await observe(); if (predicate(value)) return value; await sleep(100); } while (Date.now() < deadline); throw new Error('observation-deadline'); }
async function hold(save, reason) { save({held: true, heldReason: reason}); await new Promise(() => { setInterval(() => save({held: true, heldReason: reason}), 10000); }); }

function original(label, executable, args, context, onStdout, onSpawnAttempt) {
  context.requireEvidence();
  verifyPin(executable);
  const record = {label, argv: [executable.path, ...args], cwd: context.root, startedAt: new Date().toISOString(),
    pid: null, spawnAttempted: false, exitObserved: false, closed: false, exit: null, stdoutEOF: false, stderrEOF: false,
    stdoutClosed: false, stderrClosed: false, stdoutFileClosed: false, stderrFileClosed: false,
    failedObservation: null, bytes: {stdout: 0, stderr: 0}, signals: 0, retries: 0};
  context.records.push(record); context.save(); context.requireEvidence();
  const streams = {}, paths = {};
  try { for (const name of ['stdout', 'stderr']) { paths[name] = path.join(context.secret, label + '.' + name); streams[name] = fs.openSync(paths[name], 'wx', 0o600); } }
  catch (error) { for (const fd of Object.values(streams)) fs.closeSync(fd); throw error; }
  let child;
  try { record.spawnAttempted = true; onSpawnAttempt?.(); child = spawn(executable.path, args, {cwd: context.root, env: context.env, stdio: ['ignore', 'pipe', 'pipe']}); }
  catch { for (const fd of Object.values(streams)) fs.closeSync(fd); record.failedObservation = 'pre-handle-unknown'; context.save(); throw new Error('pre-handle-unknown'); }
  record.pid = child.pid ?? null; context.save();
  for (const name of ['stdout', 'stderr']) {
    const stream = child[name]; record[name + 'EOF'] = stream?.readableEnded === true; record[name + 'Closed'] = stream?.closed === true;
    stream?.on('data', block => { record.bytes[name] += block.length;
      if (record.bytes[name] <= 16 * BLOCK) { try {
        for (let offset = 0; offset < block.length;) { const count = fs.writeSync(streams[name], block, offset, block.length - offset); need(count > 0, 'output-short-write'); offset += count; }
      } catch (error) { record.failedObservation ||= 'output-write'; context.evidence.noteFailure(error); }
        if (name === 'stdout' && !record.failedObservation) { try { onStdout?.(block); } catch { record.failedObservation ||= 'stdout-parser'; } }
      }
      else record.failedObservation ||= 'output-cap';
    });
    stream?.once('end', () => { record[name + 'EOF'] = true; context.save(); });
    stream?.once('close', () => { record[name + 'Closed'] = true; context.save(); });
    stream?.on('error', () => { record.failedObservation ||= 'original-stream-error'; context.save(); });
  }
  child.once('error', error => { record.failedObservation ||= 'original-start-or-process-error'; record.errorCode = error.code || error.name; context.save(); });
  child.once('exit', (code, signal) => { record.exitObserved = true; record.exit = {code, signal}; context.save(); });
  child.once('close', () => { record.closed = true; record.closedAt = new Date().toISOString();
    for (const name of ['stdout', 'stderr']) { try { fs.closeSync(streams[name]); record[name + 'FileClosed'] = true; }
      catch (error) { record.failedObservation ||= 'output-close'; context.evidence.noteFailure(error); } }
    context.save(); });
  return {child, record, paths};
}
function ended(record) { return record.exitObserved && record.closed && ['stdoutEOF', 'stderrEOF', 'stdoutClosed', 'stderrClosed', 'stdoutFileClosed', 'stderrFileClosed'].every(k => record[k]); }
async function waitOriginal(value, milliseconds, context, requireZero = true) {
  try { await until(() => value.record, ended, milliseconds); }
  catch { value.record.failedObservation ||= 'observation-deadline'; await hold(context.save, 'original-' + value.record.label); }
  for (const name of ['stdout', 'stderr']) value.record[name + 'Pin'] = filePin(value.paths[name]);
  context.save(); need(!value.record.failedObservation && (!requireZero || value.record.exit?.code === 0 && value.record.exit.signal === null), 'original-tool-failure');
  return value;
}
async function tool(label, executable, args, context) {
  const value = await waitOriginal(original(label, executable, args, context), context.deadlines.tool, context);
  context.requireEvidence(); return value;
}

class QMPConnection {
  constructor(socket, context) {
    this.socket = socket; this.context = context; this.frames = new QMPFrames(); this.protocol = new QMPProtocol(); this.closed = false; this.error = null; this.pending = null;
    const observation = () => { Object.assign(context.qmpObservation, {closed: this.closed, error: this.error, greeted: this.protocol.greeted,
      negotiated: this.protocol.negotiated, pendingId: this.protocol.outstanding?.id || null, protocolFailure: this.protocol.failure}); context.save(); };
    socket.on('data', bytes => { try { for (const object of this.frames.push(bytes)) { const value = this.protocol.receive(object); context.qmp.push(object); observation(); if (value.kind === 'reply') { const pending = this.pending; this.pending = null; pending?.resolve(value.value); } } }
      catch { this.error = 'qmp-protocol-error'; this.pending?.reject(new Error(this.error)); observation(); } });
    socket.on('error', () => { this.error = 'qmp-socket-error'; this.pending?.reject(new Error(this.error)); observation(); });
    socket.once('end', () => { try { this.frames.end(); } catch { this.error = 'qmp-partial-eof'; } observation(); });
    socket.once('close', () => { this.closed = true; observation(); });
  }
  async command(name, id) {
    if (name !== 'system_powerdown') this.context.requireEvidence();
    need(!this.error && !this.closed && !this.pending, 'qmp-current-connection');
    const intended = Buffer.from(JSON.stringify({execute: name, id}) + '\r\n');
    const sent = {command: name, id, bytesSHA256: hashBytes(intended), CRLFTerminated: true, intendedAt: new Date().toISOString(), writeAttempted: false, writeCallbackObserved: false};
    this.context.qmpCommands.push(sent); this.context.save();
    if (name !== 'system_powerdown') this.context.requireEvidence();
    const bytes = this.protocol.command(name, id); need(bytes.equals(intended), 'qmp-intent-bytes');
    let resolve, reject; const result = new Promise((a, b) => { resolve = a; reject = b; }); sent.writeAttempted = true;
    this.pending = {resolve, reject}; this.socket.write(bytes, error => { sent.writeCallbackObserved = true;
      if (error) { this.error = 'qmp-write'; sent.error = 'qmp-write'; reject(new Error(this.error)); } this.context.save(); });
    let timer; try { return await Promise.race([result, new Promise((_, fail) => { timer = setTimeout(() => { this.error = 'qmp-reply-deadline'; fail(new Error(this.error)); }, this.context.deadlines.qmp); })]); }
    finally { clearTimeout(timer); }
  }
}

function bootstrapClient(Client, guest, key, context) {
  context.requireEvidence();
  const client = new Client(), state = {connectAttempts: 1, ready: false, closed: false, channels: [], sftpClosed: true, error: null};
  client.once('ready', () => { state.ready = true; context.save(); }); client.once('close', () => { state.closed = true; context.save(); });
  client.on('error', error => { state.error = error.code || error.name; context.save(); });
  client.connect({host: '127.0.0.1', port: guest.port, username: guest.username, privateKey: fs.readFileSync(key), agent: undefined,
    readyTimeout: context.deadlines.channel, hostVerifier: bytes => 'SHA256:' + crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '') === guest.hostKeyFingerprint});
  return {client, state};
}
async function execRemote(bootstrap, command, context) {
  context.requireEvidence();
  need(bootstrap.state.ready && !bootstrap.state.closed && bootstrap.state.channels.every(row => row.closed), 'one-bootstrap-channel');
  const row = {ordinal: bootstrap.state.channels.length + 1, requestAttempted: false, stdout: '', stderr: '', stdoutEOF: false, stderrEOF: false, closed: false, code: null, signal: null};
  bootstrap.state.channels.push(row); context.save(); context.requireEvidence(); row.requestAttempted = true;
  bootstrap.client.exec(command, (error, channel) => {
    if (error) { row.error = error.code || error.name; context.save(); return; }
    for (const [stream, name] of [[channel, 'stdout'], [channel.stderr, 'stderr']]) {
      const decoder = new StringDecoder('utf8'); let bytes = 0;
      stream.on('data', block => { bytes += block.length; if (bytes <= 2 * BLOCK) row[name] += decoder.write(block); else row.overflow = true; });
      stream.once('end', () => { row[name] += decoder.end(); row[name + 'EOF'] = true; context.save(); });
    }
    channel.once('error', error => { row.error = error.code || error.name; context.save(); });
    channel.once('close', (code, signal) => { row.code = code; row.signal = signal || null; row.closed = true; context.save(); }); channel.end();
  });
  await until(() => row, value => value.closed || value.error, context.deadlines.channel);
  need(row.closed && row.stdoutEOF && row.stderrEOF && row.code === 0 && row.signal === null && !row.error && !row.overflow, 'bootstrap-channel-closure'); return row.stdout;
}
async function transfer(bootstrap, files, context) {
  context.requireEvidence();
  bootstrap.state.sftpClosed = false;
  const sftp = await new Promise((resolve, reject) => bootstrap.client.sftp((error, value) => error ? reject(error) : resolve(value)));
  sftp.on('error', error => { bootstrap.state.sftpError = error.code || error.name; context.save(); });
  sftp.once('close', () => { bootstrap.state.sftpClosed = true; context.save(); });
  try { for (const file of files) {
    context.requireEvidence();
    const handle = await new Promise((resolve, reject) => sftp.open(file.remote, 'wx', {mode: 0o700}, (error, h) => error ? reject(error) : resolve(h)));
    const fd = file.local ? fs.openSync(verifyPin(file.local), 'r') : null; let position = 0;
    try { while (true) {
      context.requireEvidence();
      const buffer = Buffer.alloc(BLOCK), count = fd === null ? Math.min(BLOCK, file.bytes.length - position) : fs.readSync(fd, buffer, 0, BLOCK, null);
      if (!count) break; const bytes = fd === null ? file.bytes.subarray(position, position + count) : buffer.subarray(0, count);
      await new Promise((resolve, reject) => sftp.write(handle, bytes, 0, bytes.length, position, error => error ? reject(error) : resolve())); position += count;
    } } finally { if (fd !== null) fs.closeSync(fd); await new Promise((resolve, reject) => sftp.close(handle, error => error ? reject(error) : resolve())); }
    need(position === (file.local ? file.local.bytes : file.bytes.length), 'sftp-exact-bytes');
  } } finally { sftp.end(); await until(() => bootstrap.state.sftpClosed, Boolean, context.deadlines.channel); }
}
async function closeBootstrap(bootstrap, context) {
  if (!bootstrap) return true;
  need(bootstrap.state.channels.every(row => !row.requestAttempted || row.closed && row.stdoutEOF && row.stderrEOF) && bootstrap.state.sftpClosed, 'bootstrap-no-pending-channel');
  if (!bootstrap.state.closed) bootstrap.client.end();
  await until(() => bootstrap.state.closed, Boolean, context.deadlines.channel); return true;
}
async function port(context) {
  context.requireEvidence();
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const selected = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  context.portReservation = {host: '127.0.0.1', port: selected, releasedBeforeOriginalQEMU: true}; context.save(); return selected;
}

function inputs(b, a, code) {
  const admittedCI = Object.freeze(Object.fromEntries(UI_CI_KEYS.map(key => [key, process.env[key]])));
  const host = {platform: process.platform, arch: process.arch, node: process.versions.node, uid: process.getuid?.(), sha: admittedCI.GITHUB_SHA,
    runID: Number(admittedCI.GITHUB_RUN_ID), ci: admittedCI.CI, actions: admittedCI.GITHUB_ACTIONS,
    event: admittedCI.GITHUB_EVENT_NAME, attempt: Number(admittedCI.GITHUB_RUN_ATTEMPT)};
  assertParentAuthority(b, a, host, code);
  for (const record of [...Object.values(b.inputPins), ...Object.values(b.tools)]) verifyPin(record);
  need(fs.realpathSync(process.execPath) === b.tools.node.path && b.tools.node.version?.replace(/^v/, '') === process.versions.node, 'actual-node');
  const r3 = read(b.inputPins.r3Root), prepared = read(b.inputPins.preparedSupply), material = read(b.inputPins.materialization);
  need(b.inputPins.r3Root.sha256 === R3_ROOT_SHA256 && r3.accepted === true && r3.wholeSupplyAccepted === true && r3.nativeOrRuntimeAccepted === false, 'accepted-cached-supply-only');
  need(material.originalRootPin.sha256 === R3_ROOT_SHA256 && material.originalRootPin.bytes === b.inputPins.r3Root.bytes &&
    same(material.stagedRootPin, b.inputPins.r3Root), 'historical-proof-byte-preservation');
  materialized(r3.preparedSupplyPin, b.inputPins.preparedSupply, material.files);
  materialized(prepared.ubuntu.imagePin, b.inputPins.baseImage, material.files); materialized(prepared.vendor.elfPin, b.inputPins.vendorELF, material.files);
  const runtimeRoot = read(b.inputPins.runtimeRoot), runtime = read(b.inputPins.runtimeResult);
  need(runtimeRoot.acceptedRuntime === true && runtimeRoot.productSource === PRODUCT_SOURCE && runtimeRoot.harnessSource === b.harnessSource &&
    runtimeRoot.runID === b.runID && runtimeRoot.machineName === b.machineID && same(runtimeRoot.runtimeResultPin, b.inputPins.runtimeResult) &&
    same(runtimeRoot.capabilityHandoff, runtime.capabilityHandoff), 'same-runner-runtime-primary');
  const capability = runtime.capabilityHandoff;
  need(same(capability.qemuSystemPin, b.tools.qemuSystem) && same(capability.qemuImgPin, b.tools.qemuImg) &&
    capability.machineListed === 'pc' && capability.acceleratorListed === 'tcg', 'runtime-handoff');
  verifyPin(capability.installedInventoryPin); Object.values(capability.firmwarePins).forEach(verifyPin);
  need(fs.realpathSync(capability.dataDirectory) === capability.physicalDataDirectory &&
    inside(capability.physicalPrefix, fs.realpathSync(b.tools.qemuSystem.path)) && inside(capability.physicalPrefix, fs.realpathSync(b.tools.qemuImg.path)), 'private-runtime-paths');
  const source = read(b.inputPins.sourceRoot);
  need(source.accepted === true && source.productSource === PRODUCT_SOURCE && source.harnessSource === b.harnessSource &&
    source.baselineFiles === 429 && source.existingFilesUnchanged === true && source.baseSource === BASE_SOURCE &&
    source.baseFiles === 438 && source.baseFilesUnchanged === true && same(source.baseInventoryPin, b.inputPins.base438Inventory), 'source-438-primary');
  const baseInventory = read(b.inputPins.base438Inventory);
  need(baseInventory.source === BASE_SOURCE && baseInventory.fileCount === 438 && baseInventory.files.length === 438 &&
    new Set(baseInventory.files.map(row => row.path)).size === 438, 'source-438-inventory');
  const sourceRows = baseInventory.files.map(row => {
    need(typeof row.path === 'string' && row.path && !path.isAbsolute(row.path) && path.normalize(row.path) === row.path &&
      !row.path.split('/').includes('..') && !/[\0\\\r\n]/.test(row.path) && [0o644, 0o755].includes(row.mode), 'source-row');
    const filename = path.join(b.root, row.path), st = fs.lstatSync(filename);
    need(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === row.mode &&
      same(filePin(filename), {path: filename, bytes: row.bytes, sha256: row.sha256}), 'source-row-bytes-mode');
    return {...row, absolutePath: filename};
  });
  need(same(Object.keys(capability.probeEvidence).sort(), ['accelerators', 'image-version', 'machines', 'system-version']), 'capability-probe-roles');
  const machine = capability.probeEvidence.machines;
  verifyPin(machine.receiptPin); verifyPin(machine.stdoutPin); verifyEvidencePin(machine.stderrPin, 'probe-stderr');
  const lines = fs.readFileSync(machine.stdoutPin.path, 'utf8').split(/\r?\n/);
  need(lines.some(line => line.trim().split(/\s+/)[0] === b.machineID), 'exact-versioned-machine-listed');
  const app = read(b.inputPins.privateAppRoot);
  need(app.acceptedPrivateApp === true && app.productSource === PRODUCT_SOURCE && app.harnessSource === b.harnessSource && app.runID === b.runID &&
    same(app.packageZipPin, b.ui.packageZipPin) && same(app.expectedASARPin, b.ui.expectedASARPin) && same(app.executablePin, b.ui.executablePin) &&
    app.privateRoot === b.privateRoot, 'same-runner-private-app');
  need(b.ui.driverPin.path === path.join(b.root, 'scripts/diagnostics/installed-linux-permission-ui-v2.mjs') && b.ui.driverPin.sha256 === UI_SHA256, 'reviewed-ui-v2-driver');
  for (const record of [b.ui.driverPin, b.ui.packageZipPin, b.ui.expectedASARPin, b.ui.executablePin, ...b.ui.dependencyPins]) verifyPin(record);
  need(fs.realpathSync(b.privateRoot) === b.privateRoot, 'canonical-private-root'); const st = fs.lstatSync(b.privateRoot);
  need(st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o777) === 0o700, 'owned-private-root');
  return {r3, prepared, runtimeRoot, capability, source, sourceRows, host, admittedCI};
}

export async function run(requestFile, authorityFile) {
  need(absolute(requestFile) && absolute(authorityFile) && requestFile !== authorityFile, 'owner-input-paths');
  const requestBytes = fs.readFileSync(requestFile), b = strictJSON(requestBytes.toString('utf8'), 2 * BLOCK), a = strictJSON(fs.readFileSync(authorityFile, 'utf8'));
  const code = {requestSHA256: hashBytes(requestBytes), ownerSHA256: filePin(SELF).sha256, guardsSHA256: filePin(GUARDS).sha256};
  const admitted = inputs(b, a, code); // No mutable work, subprocess or socket precedes complete admission.
  need(!fs.existsSync(b.output) && !fs.existsSync(path.join(b.privateRoot, 'vm-owner-once.json')), 'owner-fresh-once');
  for (const name of ['vm-secrets', 'seed', 'vm']) need(!fs.existsSync(path.join(b.privateRoot, name)), 'fresh-private-subdirectory');
  fs.mkdirSync(b.output, {recursive: true, mode: 0o700}); write(path.join(b.privateRoot, 'vm-owner-once.json'), {contract: CONTRACT, requestSHA256: code.requestSHA256, runID: b.runID});
  for (const name of ['vm-secrets', 'seed', 'vm']) fs.mkdirSync(path.join(b.privateRoot, name), {mode: 0o700});
  const state = {ok: false, contract: CONTRACT, productSource: PRODUCT_SOURCE, harnessSource: b.harnessSource, runID: b.runID,
    startedAt: new Date().toISOString(), records: [], qmp: [], qmpCommands: [], qmpObservation: {closed: false, error: null}, vmLaunchAttempts: 0, uiLaunchAttempts: 0,
    uiChildStarted: false, denyOperationPossible: false, bootstrapClosed: true, powerdownRequests: 0,
    appOrVMForceSignals: 0, automaticRetries: 0, networkAcquisitions: 0, nativeQAAccepted: false,
    privateClosureRevalidationScope: 'Exact live-tree filesystem correspondence before qemu-img, before VM launch, and after original closure; no loaded-image/ABI/JIT/guest attestation.',
    liveClosureReads: [], liveClosureFailure: null, liveClosurePostRead: 'pending'};
  const {evidence, save} = evidenceSaver(state, text => fs.writeFileSync(path.join(b.output, 'owner-result.json'), text, {mode: 0o600}));
  const context = {root: b.root, secret: path.join(b.privateRoot, 'vm-secrets'), deadlines: b.deadlines,
    env: {HOME: path.join(b.privateRoot, 'owner-home'), TMPDIR: path.join(b.privateRoot, 'vm'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TZ: 'UTC'},
    records: state.records, qmp: state.qmp, qmpCommands: state.qmpCommands, qmpObservation: state.qmpObservation,
    evidence, requireEvidence: () => {
      evidence.requireHealthy(); need(state.records.every(row => !row.failedObservation), 'original-observation-failure');
      need(!state.liveClosureFailure, 'live-closure-permanent-failure');
      need(!state.qmpObservation.error && !state.qmpObservation.protocolFailure, 'qmp-observation-failure');
    }, save};
  fs.mkdirSync(context.env.HOME, {mode: 0o700}); save();
  let liveRoot = null;
  const validateClosure = boundary => {
    try {
      need(!state.liveClosureFailure, 'live-closure-permanent-failure');
      const actual = readLiveClosure(admitted.capability, liveRoot);
      liveRoot ||= actual.rootIncarnation;
      state.liveClosureReads.push({boundary, observedAt: new Date().toISOString(), ...actual});
      if (boundary === 'after-original-closure') state.liveClosurePostRead = 'passed';
      save(); evidence.requireHealthy();
    } catch (error) {
      state.liveClosureFailure ||= {boundary, name: error.name,
        code: error.name === 'VMGuardError' ? error.message : error.code || 'filesystem-observation-failed'};
      if (boundary === 'after-original-closure') state.liveClosurePostRead = 'failed';
      state.ok = false; save(); throw error;
    }
  };
  let vm, qmp, bootstrap, uiOriginal, failure; const lifetime = new OriginalVM();
  try {
    const nonce = crypto.randomBytes(16).toString('hex'), keyPath = path.join(context.secret, 'client-key');
    await tool('ephemeral-client-key', b.tools.sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'reviewops-' + nonce, '-f', keyPath], context);
    const keyInfo = fs.lstatSync(keyPath); need(keyInfo.isFile() && keyInfo.uid === process.getuid() && (keyInfo.mode & 0o777) === 0o600, 'owned-ephemeral-private-key');
    state.clientPrivateKeyPin = filePin(keyPath);
    const clientKey = publicKey(fs.readFileSync(keyPath + '.pub', 'utf8')), files = seedFiles({username: 'rvqa', uid: 1001, nonce, clientPublicKey: clientKey.line});
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(b.privateRoot, 'seed', name), bytes, {flag: 'wx', mode: 0o600});
    const seed = path.join(b.privateRoot, 'vm', 'cidata.iso');
    await tool('nocloud-seed', b.tools.hdiutil, ['makehybrid', '-o', seed, path.join(b.privateRoot, 'seed'), '-iso', '-joliet', '-default-volume-name', 'cidata'], context);
    const seedInfo = fs.lstatSync(seed); need(seedInfo.isFile() && seedInfo.size <= 16 * BLOCK, 'seed-file-cap');
    state.seedObservation = inspectSeedISO(fs.readFileSync(seed), files); state.seedPin = filePin(seed); save();
    const base = path.join(b.privateRoot, 'vm', 'base.img'), overlay = path.join(b.privateRoot, 'vm', 'overlay.qcow2');
    fs.copyFileSync(verifyPin(b.inputPins.baseImage), base, fs.constants.COPYFILE_EXCL); fs.chmodSync(base, 0o400);
    need(filePin(base).sha256 === b.inputPins.baseImage.sha256, 'read-only-base-copy'); state.readOnlyBasePin = filePin(base);
    validateClosure('before-first-qemu-img'); context.requireEvidence();
    await tool('overlay-create', b.tools.qemuImg, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', base, overlay], context);
    const info = await tool('overlay-info', b.tools.qemuImg, ['info', '--output=json', overlay], context);
    const overlayInfo = strictJSON(fs.readFileSync(info.paths.stdout, 'utf8'));
    need(overlayInfo.format === 'qcow2' && overlayInfo['backing-filename-format'] === 'qcow2' &&
      (overlayInfo['full-backing-filename'] || overlayInfo['backing-filename']) === base && overlayInfo['virtual-size'] === admitted.r3.image.virtualBytes, 'overlay-relationship');
    state.overlayInfo = overlayInfo; save();
    const guestPort = await port(context), qmpPath = path.join(b.privateRoot, 'qmp.sock'); need(!fs.existsSync(qmpPath), 'fresh-qmp-path');
    const serial = new StringDecoder('utf8'); let serialLine = '', marker = null;
    const serialRead = bytes => { serialLine += serial.write(bytes); let at;
      while ((at = serialLine.indexOf('\n')) >= 0) { const line = serialLine.slice(0, at).replace(/\r$/, ''); serialLine = serialLine.slice(at + 1);
        need(line.length <= 65536, 'serial-line-cap');
        if (line.startsWith('REVIEWOPS_BOOTSTRAP ')) { need(!marker, 'one-bootstrap-marker'); marker = bootstrapMarker(strictJSON(line.slice(20)), nonce); state.bootstrapMarker = marker; save(); }
      } need(serialLine.length <= 65536, 'serial-line-cap'); };
    const token = lifetime.begin();
    const argv = ['-machine', b.machineID, '-accel', 'tcg', '-smp', '2', '-m', '2048', '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
      '-bios', admitted.capability.firmwarePins['bios-256k.bin'].path, '-L', admitted.capability.dataDirectory, '-nodefaults',
      '-drive', 'file=' + overlay + ',if=virtio,format=qcow2', '-drive', 'file=' + seed + ',if=ide,media=cdrom,format=raw,readonly=on',
      '-netdev', 'user,id=net0,restrict=on,ipv6=off,hostfwd=tcp:127.0.0.1:' + guestPort + '-:22', '-device', 'virtio-net-pci,netdev=net0',
      '-qmp', 'unix:' + qmpPath + ',server=on,wait=off'];
    validateClosure('before-vm-launch'); context.requireEvidence();
    vm = original('original-qemu', b.tools.qemuSystem, argv, context, serialRead, () => { state.vmLaunchAttempts = 1; }); lifetime.retain(token, vm.child);
    await until(() => fs.existsSync(qmpPath), Boolean, b.deadlines.qmp); need(fs.lstatSync(qmpPath).isSocket(), 'qmp-socket-type');
    context.requireEvidence();
    qmp = new QMPConnection(net.createConnection({path: qmpPath}), context);
    await until(() => qmp.protocol.greeted && !qmp.error, Boolean, b.deadlines.qmp);
    await qmp.command('qmp_capabilities', 'vm1-capabilities');
    const target = await qmp.command('query-target', 'vm1-target'); need(target.arch === 'x86_64', 'actual-qmp-target');
    await until(() => marker, Boolean, b.deadlines.boot); need(!vm.record.exitObserved && !vm.record.failedObservation && !qmp.error, 'original-live-after-boot');
    const require = createRequire(path.join(b.root, 'package.json'));
    need(b.ui.dependencyPins.some(row => row.path === require.resolve('ssh2')), 'actual-ssh2-entry'); const {Client} = require('ssh2');
    context.requireEvidence(); state.bootstrapClosed = false;
    bootstrap = bootstrapClient(Client, {port: guestPort, username: 'rvqa', hostKeyFingerprint: marker.hostKeyFingerprint}, keyPath, context); state.bootstrap = bootstrap.state; save();
    await until(() => bootstrap.state, row => row.ready || row.error, b.deadlines.channel); need(bootstrap.state.ready && !bootstrap.state.error, 'bootstrap-ready');
    const home = '/home/rvqa', codeHome = home + '/.codex', cli = home + '/owned-bin/codex.real', witness = home + '/owned-bin/codex-observed', logPath = home + '/observations/exec.jsonl', leaf = home + '/owned-work';
    const initial = strictJSON(await execRemote(bootstrap, python("assert os.getuid()==os.geteuid()==1001 and os.path.expanduser('~')==v['home']\nassert open('/proc/sys/kernel/random/boot_id').read().strip()==v['bootId']\nfor p in [v['home']+'/owned-bin',v['home']+'/observations',v['leaf'],v['codeHome']]: os.mkdir(p,0o700)\nprint(json.dumps({'createdOwnedDirectories':True}))", {home, codeHome, leaf, bootId: marker.bootId}), context));
    need(initial.createdOwnedDirectories === true, 'guest-private-directories');
    const witnessBytes = witnessSource({cli, home, codeHome, logPath});
    await transfer(bootstrap, [{local: b.inputPins.vendorELF, remote: cli}, {bytes: witnessBytes, remote: witness}], context);
    const sealBody = "assert os.getuid()==os.geteuid()==1001 and os.path.expanduser('~')==v['home']\nassert os.environ.get('CODEX_HOME',v['codeHome'])==v['codeHome']\ndef seal(p):\n s=os.lstat(p); assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_size<=536870912\n h=hashlib.sha256()\n with open(p,'rb') as f:\n  for b in iter(lambda:f.read(1048576),b''): h.update(b)\n return {'path':p,'bytes':s.st_size,'sha256':h.hexdigest()}\ns=os.lstat(v['leaf']); assert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and os.path.realpath(v['leaf'])==v['leaf'] and stat.S_IMODE(s.st_mode)==448\nassert all(not os.path.lexists(v['codeHome']+'/'+n) for n in ['auth.json','credentials.json'])\nprint(json.dumps({'identity':{'bootId':open('/proc/sys/kernel/random/boot_id').read().strip(),'uid':os.getuid(),'euid':os.geteuid(),'kernel':platform.release(),'machine':platform.machine()},'leaf':{'path':v['leaf'],'dev':s.st_dev,'ino':s.st_ino,'uid':s.st_uid},'cli':seal(v['cli']),'witness':seal(v['witness'])}))";
    const actual = strictJSON(await execRemote(bootstrap, python(sealBody, {home, codeHome, leaf, cli, witness}), context));
    need(actual.identity.bootId === marker.bootId && actual.identity.machine === 'x86_64' && actual.cli.bytes === b.inputPins.vendorELF.bytes &&
      actual.cli.sha256 === b.inputPins.vendorELF.sha256 && actual.witness.bytes === witnessBytes.length && actual.witness.sha256 === hashBytes(witnessBytes), 'guest-byte-identity');
    const version = (await execRemote(bootstrap, quote(cli) + ' --version', context)).trim(); need(/^[A-Za-z0-9][A-Za-z0-9 .+_-]{0,159}$/.test(version), 'actual-cli-version');
    const guest = {host: '127.0.0.1', port: guestPort, username: 'rvqa', privateKeyPin: filePin(keyPath), hostKeyFingerprint: marker.hostKeyFingerprint,
      home, codeHome, identity: actual.identity, leaf: actual.leaf, genuineCLI: {...actual.cli, version}, witness: {...actual.witness, logPath}};
    state.guest = guest; await closeBootstrap(bootstrap, context); state.bootstrapClosed = true; save();
    context.requireEvidence();
    const parentPin = filePin(authorityFile), localPrepared = write(path.join(b.output, 'local-prepared-acceptance.json'), {accepted: true, productSource: PRODUCT_SOURCE,
      preparedSupplyPin: b.inputPins.preparedSupply, originalR3RootPin: b.inputPins.r3Root, materializationPin: b.inputPins.materialization,
      conditionalParentAuthorityPin: parentPin, predicateContract: CONTRACT});
    const guestProof = write(path.join(b.output, 'guest-acceptance.json'), {accepted: true, productSource: PRODUCT_SOURCE, preparedSupplyPin: b.inputPins.preparedSupply,
      guest, originalVMRetained: lifetime.matches(vm.child) && !vm.record.exitObserved, originalQEMUPID: vm.record.pid,
      conditionalParentAuthorityPin: parentPin, predicateContract: CONTRACT, runID: b.runID, seedPin: state.seedPin});
    const ui = materializeUIBinding({...b.ui, schema: 1, phase: 'ui', scenario: 'installed-linux-permission', source: PRODUCT_SOURCE, harnessSource: b.harnessSource,
      sourceGuard: {productSource: PRODUCT_SOURCE, harnessSource: b.harnessSource, baselineFiles: 429, existingFilesUnchanged: true},
      preparedSupplyPin: b.inputPins.preparedSupply, preparedRootAcceptancePin: localPrepared, guestRootAcceptancePin: guestProof,
      sourceGuardRootPin: b.inputPins.sourceRoot, actualNodeIdentity: b.tools.node, guest,
      allowNormalMetadata: true, maximumAppLaunches: 1, newFormalQAIDs: 0, vmLifecycleOwnedByOuterController: true});
    need(lifetime.matches(vm.child) && !vm.record.exitObserved && !vm.record.failedObservation && !qmp.error && !qmp.protocol.failure, 'live-original-before-ui');
    const driver = await import(pathToFileURL(verifyPin(b.ui.driverPin)).href);
    const uiEnvironment = uiChildEnvironment(context.env, admitted.admittedCI, b);
    driver.assertBinding(ui, {platform: admitted.host.platform, arch: admitted.host.arch, node: admitted.host.node, electron: undefined,
      uid: process.getuid(), euid: process.geteuid(), ci: uiEnvironment.CI, actions: uiEnvironment.GITHUB_ACTIONS,
      event: uiEnvironment.GITHUB_EVENT_NAME, attempt: Number(uiEnvironment.GITHUB_RUN_ATTEMPT), runId: Number(uiEnvironment.GITHUB_RUN_ID), githubSHA: uiEnvironment.GITHUB_SHA});
    const uiPin = write(path.join(b.output, 'ui-binding.json'), ui), uiAuthority = write(path.join(b.output, 'ui-approval.json'),
      {approvedForOneInstalledLinuxPermissionUI: true, bindingSHA256: uiPin.sha256, source: PRODUCT_SOURCE, harnessSource: b.harnessSource,
        maximumAppLaunches: 1, vmStartOrStopAuthorized: false, conditionalParentAuthorityPin: parentPin, predicateContract: CONTRACT});
    const uiContext = {...context, env: uiEnvironment};
    uiOriginal = original('original-ui-driver', b.tools.node, [ui.driverPin.path, '--binding', uiPin.path, '--approval', uiAuthority.path], uiContext,
      undefined, () => { state.uiLaunchAttempts = 1; state.denyOperationPossible = true; });
    state.uiChildStarted = Number.isSafeInteger(uiOriginal.child.pid) && uiOriginal.child.pid > 0; save();
    await waitOriginal(uiOriginal, b.deadlines.ui, context, false);
    const resultPath = path.join(ui.output, 'results.json'); need(fs.existsSync(resultPath), 'actual-ui-result'); const uiResult = read(filePin(resultPath));
    need(uiResult.source === PRODUCT_SOURCE && uiResult.harnessSource === b.harnessSource && uiCleanup(uiResult), 'actual-ui-cleanup');
    state.uiResultPin = filePin(resultPath); state.uiResult = uiResult; state.uiDriverClosed = true; save();
    need(uiResult.ok === true && same(uiResult.conditions.map(row => row.phase), ['normal', 'denied', 'restored']) && uiOriginal.record.exit.code === 0, 'actual-ui-verdict');
  } catch (error) { failure = error; state.failure = {name: error.name, message: error.name === 'VMGuardError' ? error.message : 'Original VM operation failed; preserve owned evidence.'}; save(); }
  finally {
    try { if (bootstrap && !state.bootstrapClosed) { state.bootstrapClosed = await closeBootstrap(bootstrap, context); save(); } }
    catch { state.bootstrapClosureUnknown = true; save(); }
    if (vm) {
      const cleanup = {bootstrapClosed: state.bootstrapClosed, uiLaunchAttempts: state.uiLaunchAttempts, uiChildStarted: state.uiChildStarted,
        denyOperationPossible: state.denyOperationPossible, uiDriverClosed: state.uiDriverClosed === true, uiResult: state.uiResult};
      if (qmp?.protocol.negotiated && !qmp.error && !qmp.closed && powerdownSafe(cleanup)) {
        try { lifetime.powerdown(vm.child, cleanup); state.powerdownRequests = 1; save(); await qmp.command('system_powerdown', 'vm1-powerdown');
          await until(() => vm.record, row => ended(row) && qmp.protocol.normalPoweroff(), b.deadlines.poweroff);
          await until(() => qmp.closed, Boolean, b.deadlines.qmp); need(!qmp.error, 'qmp-complete-closure');
          lifetime.confirm(vm.child, vm.record, qmp.protocol); state.originalVMClosureConfirmed = true; save();
        } catch { state.normalPoweroffUnconfirmed = true; save(); }
      }
      if (ended(vm.record)) {
        try { for (const name of ['stdout', 'stderr']) vm.record[name + 'Pin'] = filePin(vm.paths[name]); }
        catch (error) { evidence.noteFailure(error); } save();
      }
      if (!state.originalVMClosureConfirmed) {
        if (ended(vm.record) && powerdownSafe(cleanup)) { state.originalVMTerminalObserved = true; failure ||= new Error('non-normal-vm-closure'); }
        else await hold(save, 'original-vm-or-ui-cleanup-unknown');
      }
      if (ended(vm.record)) {
        try { validateClosure('after-original-closure'); }
        catch (error) { failure ||= error; }
      }
    } else if (state.records.some(row => row.spawnAttempted && !ended(row))) await hold(save, 'setup-original-unknown');
    try { for (const record of [...Object.values(b.inputPins), ...Object.values(b.tools), b.ui.packageZipPin, b.ui.expectedASARPin, b.ui.executablePin,
      ...[state.seedPin, state.readOnlyBasePin, state.clientPrivateKeyPin].filter(Boolean)]) verifyPin(record); }
    catch { state.preservationFailed = true; failure ||= new Error('input-preservation'); }
    try { for (const row of admitted.sourceRows) {
      const st = fs.lstatSync(row.absolutePath); need(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === row.mode &&
        same(filePin(row.absolutePath), {path: row.absolutePath, bytes: row.bytes, sha256: row.sha256}), 'source-after-bytes-mode');
    } need(filePin(SELF).sha256 === code.ownerSHA256 && filePin(GUARDS).sha256 === code.guardsSHA256, 'owner-code-preserved'); }
    catch { state.sourcePreservationFailed = true; failure ||= new Error('source-preservation'); }
    if (state.records.some(record => record.failedObservation)) failure ||= new Error('original-observation-failure');
    if (evidence.failed) failure ||= new Error('evidence-persistence-failed');
    state.finishedAt = new Date().toISOString(); state.ok = !failure && state.originalVMClosureConfirmed === true && state.uiResult?.ok === true;
    state.nativeQAAccepted = false; save();
  }
  if (!state.ok || evidence.failed) throw failure || new Error('VM diagnostic failed; retained original verdict'); return state;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2); need(args.length === 4 && args[0] === '--request' && args[2] === '--authority', 'owner-cli');
  run(args[1], args[3]).then(result => console.log(JSON.stringify({ok: result.ok, runID: result.runID, originalVMClosureConfirmed: result.originalVMClosureConfirmed, nativeQAAccepted: false})))
    .catch(error => { console.error(error.name === 'VMGuardError' ? error.message : 'Original VM owner failed; retain evidence.'); process.exitCode = 1; });
}
