'use strict';
// This registry contains locations, never credentials. Importing it performs no I/O.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const failure = (message, code = 'DISCOVERY_UNAVAILABLE') => Object.assign(new Error(message), { code });
const invalid = () => { throw failure('Running-instance registry is missing, insecure or invalid. Select --data-path or --connection explicitly.'); };
function supported(platform = process.platform) { return platform !== 'win32' && typeof process.getuid === 'function' && Number.isInteger(fs.constants.O_NOFOLLOW); }
function registryDirectory({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const base = platform === 'darwin' ? paths.join(home, 'Library', 'Application Support') : platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME || paths.join(home, '.config');
  if (typeof base !== 'string' || !paths.isAbsolute(base) || /[\x00-\x1f\x7f]/.test(base) || Buffer.byteLength(base) > 3500) invalid();
  return paths.join(base, 'ReviewOps Local', 'running-instances');
}
function identity(stat) { return [stat.dev, stat.ino, stat.uid, stat.mode].join(':'); }
function fileIdentity(stat) { return [identity(stat), stat.size, stat.mtimeNs, stat.ctimeNs].join(':'); }
function ancestors(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || Buffer.byteLength(directory) > 4096 || /[\x00-\x1f\x7f]/.test(directory)) invalid();
  const result = [], absolute = path.resolve(directory), parts = absolute.split(path.sep).filter(Boolean);
  if (parts.length > 128) invalid();
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { bigint: true });
    // A root-owned sticky temporary ancestor is safe only with the checked owned children below it.
    if (!stat.isDirectory() || (stat.uid !== BigInt(process.getuid()) && stat.uid !== 0n) || (stat.mode & 0o022n) && !(stat.uid === 0n && stat.mode & 0o1000n)) invalid();
    result.push([current, identity(stat)]);
  }
  return result;
}
function sameAncestors(rows) { for (const [name, expected] of rows) if (identity(fs.lstatSync(name, { bigint: true })) !== expected) invalid(); }
function directorySnapshot(directory) {
  const chain = ancestors(directory), stat = fs.lstatSync(directory, { bigint: true });
  if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o700n) invalid();
  return chain;
}
function createDirectory(directory) {
  if (!path.isAbsolute(directory)) invalid();
  const missing = []; let current = directory;
  while (true) { try { ancestors(current); break; } catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(current); current = path.dirname(current); } }
  for (const name of missing.reverse()) { const chain = ancestors(path.dirname(name)); fs.mkdirSync(name, { mode: 0o700 }); sameAncestors(chain); }
  return directorySnapshot(directory);
}
function readPrivateFile(file) {
  if (!supported()) throw failure('Automatic running-instance discovery is unsupported on this platform. Select --data-path or --connection explicitly.', 'DISCOVERY_UNSUPPORTED');
  const directory = path.dirname(file), chain = directorySnapshot(directory);
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > 8192n) invalid();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (fileIdentity(fs.fstatSync(fd, { bigint: true })) !== fileIdentity(before)) invalid();
    const buffer = Buffer.alloc(8193); let length = 0, count;
    while ((count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) { length += count; if (length > 8192) invalid(); }
    if (BigInt(length) !== before.size || fileIdentity(fs.fstatSync(fd, { bigint: true })) !== fileIdentity(before) || fileIdentity(fs.lstatSync(file, { bigint: true })) !== fileIdentity(before)) invalid();
    sameAncestors(chain);
    return { file, bytes: buffer.subarray(0, length), identity: fileIdentity(before), chain };
  } catch { invalid(); } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function assertUnchanged(snapshot) {
  try {
    sameAncestors(snapshot.chain);
    const now = readPrivateFile(snapshot.file);
    if (now.identity !== snapshot.identity || !now.bytes.equals(snapshot.bytes)) invalid();
  } catch { throw failure('The discovered ReviewOps instance changed. Restart this MCP connection or select an explicit connection.', 'DISCOVERED_INSTANCE_CHANGED'); }
}
function recordFrom(snapshot, basename) {
  let record; try { record = JSON.parse(snapshot.bytes.toString('utf8')); } catch { invalid(); }
  if (!record || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(['connectionPath', 'instanceId', 'schema']) || record.schema !== 1 || !UUID.test(record.instanceId || '') || basename !== record.instanceId + '.json' || typeof record.connectionPath !== 'string' || !path.isAbsolute(record.connectionPath) || /[\x00-\x1f\x7f]/.test(record.connectionPath) || Buffer.byteLength(record.connectionPath) > 4096) invalid();
  // The app writes one canonical representation; reject duplicate keys and ambiguous encodings.
  if (!snapshot.bytes.equals(Buffer.from(JSON.stringify(record)))) invalid();
  return record;
}
function findInstance(directory, { platform = process.platform } = {}) {
  if (!supported(platform)) throw failure('Automatic running-instance discovery is unsupported on this platform. Select --data-path or --connection explicitly.', 'DISCOVERY_UNSUPPORTED');
  try {
    const chain = directorySnapshot(directory), names = [], handle = fs.opendirSync(directory, { bufferSize: 16 });
    try { for (let i = 0; i < 65; i++) { const entry = handle.readSync(); if (!entry) break; names.push(entry.name); } }
    finally { handle.closeSync(); }
    if (names.length > 64 || names.some(name => name.endsWith('.json') && !UUID.test(name.slice(0, -5)))) invalid();
    const candidates = names.filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5))).sort();
    if (candidates.length > 16) invalid();
    if (!candidates.length) throw failure('No running ReviewOps instance was found. Start the app or select --data-path explicitly.', 'NO_RUNNING_INSTANCE');
    if (candidates.length !== 1) throw failure('Multiple ReviewOps instances are registered. Select --data-path or --connection explicitly.', 'MULTIPLE_RUNNING_INSTANCES');
    const snapshot = readPrivateFile(path.join(directory, candidates[0])), record = recordFrom(snapshot, candidates[0]);
    sameAncestors(chain);
    return { ...record, snapshot };
  } catch (error) { if (['NO_RUNNING_INSTANCE', 'MULTIPLE_RUNNING_INSTANCES', 'DISCOVERY_UNSUPPORTED'].includes(error.code)) throw error; invalid(); }
}
function publishInstance({ directory, instanceId, connectionPath, platform = process.platform }) {
  if (!supported(platform)) return null;
  if (!UUID.test(instanceId || '') || typeof connectionPath !== 'string' || !path.isAbsolute(connectionPath) || /[\x00-\x1f\x7f]/.test(connectionPath) || Buffer.byteLength(connectionPath) > 4096) invalid();
  const chain = createDirectory(directory), file = path.join(directory, instanceId + '.json');
  const temporary = path.join(directory, '.publish-' + crypto.randomUUID());
  const bytes = Buffer.from(JSON.stringify({ schema: 1, instanceId, connectionPath }));
  let temporaryIdentity;
  try {
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); temporaryIdentity = identity(fs.fstatSync(fd, { bigint: true })); } finally { fs.closeSync(fd); }
    sameAncestors(chain);
    fs.linkSync(temporary, file); // Atomic no-overwrite publication, including against another app.
  } finally {
    if (temporaryIdentity && identity(fs.lstatSync(temporary, { bigint: true })) === temporaryIdentity) fs.unlinkSync(temporary);
  }
  const published = readPrivateFile(file);
  if (!published.bytes.equals(bytes)) invalid();
  let removed = false, removalFailed = false;
  return { file, removeSync() {
    if (removed || removalFailed) return;
    try { assertUnchanged(published); fs.unlinkSync(file); removed = true; }
    catch (error) { removalFailed = true; throw error; }
  } };
}
module.exports = { registryDirectory, supported, findInstance, publishInstance, readPrivateFile, assertUnchanged };
