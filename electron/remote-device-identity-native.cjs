'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let original = null, attempted = false;
function fail() { throw Object.assign(new Error('The remote identity request was refused.'), {code: 'IDENTITY_UNAVAILABLE'}); }
const fingerprint = stat => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function open(file, maximum) {
  const named = fs.lstatSync(file, {bigint: true});
  if (!named.isFile() || named.nlink !== 1n ||
      ![0n, BigInt(process.getuid())].includes(named.uid) || (named.mode & 0o022n) ||
      named.size < 1n || named.size > BigInt(maximum) || fs.realpathSync(file) !== file) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const record = {fd, file, fingerprint: fingerprint(named), maximum};
  try { check(record); return record; } catch (error) { fs.closeSync(fd); throw error; }
}
function check(record) {
  if (fingerprint(fs.fstatSync(record.fd, {bigint: true})) !== record.fingerprint ||
      fingerprint(fs.lstatSync(record.file, {bigint: true})) !== record.fingerprint ||
      fs.realpathSync(record.file) !== record.file) fail();
}
function bytes(record) {
  const result = Buffer.alloc(record.maximum + 1);
  let offset = 0;
  while (offset < result.length) {
    const n = fs.readSync(record.fd, result, offset, result.length - offset, offset);
    if (!n) break;
    offset += n;
  }
  if (offset > record.maximum || BigInt(offset) !== fs.fstatSync(record.fd, {bigint: true}).size) fail();
  check(record); return result.subarray(0, offset);
}
function digest(record) {
  const value = bytes(record);
  return {bytes: value.length, sha256: crypto.createHash('sha256').update(value).digest('hex')};
}
function loadMacIdentityStorage({appPath, packaged}) {
  if (original) { if (original.appPath !== appPath) fail(); return original.storage; }
  if (attempted || process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) fail();
  attempted = true;
  const directory = path.join(packaged ? appPath + '.unpacked' : appPath, 'electron', 'native');
  let manifestFile, addonFile;
  try {
    manifestFile = open(path.join(directory, 'remote-identity-manifest.json'), 1024);
    const raw = bytes(manifestFile), manifest = JSON.parse(raw.toString('utf8'));
    if(!Buffer.from(JSON.stringify(manifest)).equals(raw)&&!Buffer.from(JSON.stringify(manifest)+'\n').equals(raw))fail();
    if (!manifest || Object.keys(manifest).sort().join(',') !== 'files,schema' || manifest.schema !== 1 ||
        !manifest.files || Object.keys(manifest.files).sort().join(',') !== 'arm64,x64') fail();
    for (const arch of ['arm64', 'x64']) {
      const entry = manifest.files[arch];
      if (!entry || Object.keys(entry).sort().join(',') !== 'bytes,file,sha256' ||
          entry.file !== `remote-identity-darwin-${arch}.node` || !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 1 || entry.bytes > 32 * 1024 * 1024 || typeof entry.sha256!=='string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail();
    }
    const expected = manifest.files[process.arch];
    addonFile = open(path.join(directory, expected.file), 32 * 1024 * 1024);
    const matches = () => {
      const actual = digest(addonFile);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || !bytes(manifestFile).equals(raw)) fail();
    };
    matches();
    const storage = require(addonFile.file); // Exactly one image; never reload/delete require.cache.
    matches();
    original = {appPath, storage};
    return storage;
  } catch { fail(); }
  finally { if (addonFile) fs.closeSync(addonFile.fd); if (manifestFile) fs.closeSync(manifestFile.fd); }
}
module.exports = {loadMacIdentityStorage};
