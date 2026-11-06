'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {isIP} = require('node:net');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BYTES = 256 * 1024;
function fail() { throw Object.assign(new Error('Approved app access could not be saved.'), {code: 'APP_ACCESS_STORAGE_UNAVAILABLE'}); }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) fail();
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(); copy[key] = descriptor.value;
  }
  return copy;
}
function captureAppSessions(input) {
  const value = object(input, ['version', 'sessions']);
  if (value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > 16) fail();
  const seen = new Set(), hashes = new Set();
  const sessions = value.sessions.map(input => {
    const row = object(input, ['id', 'label', 'address', 'digest', 'epoch', 'expiresAt', 'grants']);
    if (typeof row.id !== 'string' || !UUID.test(row.id) || seen.has(row.id) ||
        typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) || hashes.has(row.digest) ||
        typeof row.label !== 'string' || !row.label.trim() || row.label.length > 120 || /[\x00-\x1f]/.test(row.label) ||
        typeof row.address !== 'string' || !isIP(row.address) || typeof row.epoch !== 'string' || !UUID.test(row.epoch) ||
        !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0 || !Array.isArray(row.grants) || !row.grants.length || row.grants.length > 1000) fail();
    seen.add(row.id); hashes.add(row.digest);
    const projects = new Set();
    row.grants = row.grants.map(input => {
      const grant = object(input, ['projectId', 'birth', 'read', 'write', 'execute']);
      if (typeof grant.projectId !== 'string' || !ID.test(grant.projectId) || projects.has(grant.projectId) ||
          !Number.isSafeInteger(grant.birth) || grant.birth < 1 || grant.read !== true ||
          typeof grant.write !== 'boolean' || typeof grant.execute !== 'boolean') fail();
      projects.add(grant.projectId); return Object.freeze(grant);
    });
    return Object.freeze({...row, grants: Object.freeze(row.grants)});
  });
  return Object.freeze({version: 1, sessions: Object.freeze(sessions)});
}

// Only non-replayable token hashes and local approval metadata are stored here.
// The raw bearer credential remains in the client PC's protected profile.
function createRemoteAppSessionStore({directory}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail();
  const file = path.join(directory, 'approved-apps.json');
  function owned(stat, directory = false) {
    if (stat.isSymbolicLink() || directory && !stat.isDirectory() || !directory && !stat.isFile() ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail();
    if (process.platform !== 'win32' && (stat.mode & 0o077)) fail();
  }
  function prepare() {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700}); owned(fs.lstatSync(directory), true);
  }
  return Object.freeze({
    read() {
      prepare(); let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd); owned(stat); if (stat.size > MAX_BYTES) fail();
        const bytes = fs.readFileSync(fd); if (bytes.length > MAX_BYTES) fail();
        return captureAppSessions(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
      } catch (error) { if (error.code === 'ENOENT') return {version: 1, sessions: []}; fail(); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    },
    write(input) {
      const value = captureAppSessions(input), bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > MAX_BYTES) fail(); prepare();
      const temporary = path.join(directory, `.approved-apps-${randomUUID()}.tmp`); let fd;
      try {
        try { owned(fs.lstatSync(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, file);
        if (process.platform !== 'win32') { const parent = fs.openSync(directory, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
      } catch { fail(); }
      finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') fail(); } }
    }
  });
}

module.exports = {createRemoteAppSessionStore, captureAppSessions};
