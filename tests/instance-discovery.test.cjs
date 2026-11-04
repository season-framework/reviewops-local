'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registryDirectory, findInstance, publishInstance, readPrivateFile, assertUnchanged } = require('../electron/instance-discovery.cjs');
const id = '11111111-1111-4111-8111-111111111111', otherId = '22222222-2222-4222-8222-222222222222';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ro-discovery-')));
  fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'registry'), connectionPath = path.join(root, 'data', 'integrations', 'tools.json');
  return { root, directory, connectionPath };
}
test('registry location uses the shared effective home/config basis and ignores custom data roots', () => {
  const env = { REVIEWOPS_DATA_DIR: '/unrelated', XDG_CONFIG_HOME: '/private/config', APPDATA: 'C:\\private\\roaming' };
  assert.equal(registryDirectory({ platform: 'darwin', home: '/private/home', env }), '/private/home/Library/Application Support/ReviewOps Local/running-instances');
  assert.equal(registryDirectory({ platform: 'linux', home: '/private/home', env }), '/private/config/ReviewOps Local/running-instances');
  assert.equal(registryDirectory({ platform: 'win32', home: 'C:\\private', env }), 'C:\\private\\roaming\\ReviewOps Local\\running-instances');
  assert.throws(() => registryDirectory({ platform: 'linux', home: '/private/home', env: { XDG_CONFIG_HOME: 'relative' } }));
});
test('Windows automatic discovery is explicitly unsupported without treating chmod as an ACL', () => {
  assert.throws(() => findInstance('C:\\never-read', { platform: 'win32' }), { code: 'DISCOVERY_UNSUPPORTED' });
  assert.equal(publishInstance({ platform: 'win32' }), null);
});
test('publication is private, token-free, exclusive and removes only its own exact record', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), publication = publishInstance({ ...f, instanceId: id });
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(publication.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(publication.file)), { schema: 1, instanceId: id, connectionPath: f.connectionPath });
  assert.deepEqual(fs.readdirSync(f.directory), [id + '.json']);
  assert.equal(findInstance(f.directory).instanceId, id);
  assert.throws(() => publishInstance({ ...f, instanceId: id }));
  assert.deepEqual(fs.readdirSync(f.directory), [id + '.json']);
  publication.removeSync(); publication.removeSync(); assert.deepEqual(fs.readdirSync(f.directory), []);
});
test('normal cleanup preserves other records and refuses a replacement under its own UUID', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), own = publishInstance({ ...f, instanceId: id }), other = publishInstance({ ...f, instanceId: otherId });
  const replacement = Buffer.from(JSON.stringify({ schema: 1, instanceId: id, connectionPath: path.join(f.root, 'foreign', 'integrations', 'tools.json') }));
  fs.unlinkSync(own.file); fs.writeFileSync(own.file, replacement, { mode: 0o600 });
  assert.throws(() => own.removeSync(), { code: 'DISCOVERED_INSTANCE_CHANGED' });
  assert.deepEqual(fs.readFileSync(own.file), replacement); assert.ok(fs.existsSync(other.file));
});
test('discovery does not open any endpoint when the candidate set is ambiguous', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); publishInstance({ ...f, instanceId: id }); publishInstance({ ...f, instanceId: otherId });
  assert.throws(() => findInstance(f.directory), { code: 'MULTIPLE_RUNNING_INSTANCES' });
});
test('registry rejects insecure, malformed, symlink and noncanonical matching records', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), own = publishInstance({ ...f, instanceId: id }), original = fs.readFileSync(own.file);
  fs.chmodSync(own.file, 0o644); assert.throws(() => findInstance(f.directory)); fs.chmodSync(own.file, 0o600);
  for (const data of [Buffer.from('{}'), Buffer.from('{bad'), Buffer.concat([original, Buffer.from('\n')]), Buffer.from(original.toString().replace('"schema":1', '"schema":1,"schema":1'))]) {
    fs.writeFileSync(own.file, data); assert.throws(() => findInstance(f.directory));
  }
  fs.writeFileSync(own.file, original); fs.unlinkSync(own.file); const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, original, { mode: 0o600 }); fs.symlinkSync(outside, own.file);
  assert.throws(() => findInstance(f.directory)); assert.deepEqual(fs.readFileSync(outside), original);
  fs.unlinkSync(own.file); fs.chmodSync(f.directory, 0o755); assert.throws(() => findInstance(f.directory));
});
test('snapshot refuses same-byte inode replacement and insecure ancestors without opening outside data', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.connectionPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(f.connectionPath, '{}', { mode: 0o600 });
  const snapshot = readPrivateFile(f.connectionPath); fs.unlinkSync(f.connectionPath); fs.writeFileSync(f.connectionPath, '{}', { mode: 0o600 });
  assert.throws(() => assertUnchanged(snapshot), { code: 'DISCOVERED_INSTANCE_CHANGED' });
  fs.chmodSync(path.dirname(path.dirname(f.connectionPath)), 0o777); assert.throws(() => readPrivateFile(f.connectionPath));
});
test('bounded registry does not scan arbitrary names or silently sweep stale entries', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.mkdirSync(f.directory, { mode: 0o700 });
  fs.writeFileSync(path.join(f.directory, 'unrelated.json'), 'not opened', { mode: 0o600 });
  assert.throws(() => findInstance(f.directory), { code: 'DISCOVERY_UNAVAILABLE' });
  fs.unlinkSync(path.join(f.directory, 'unrelated.json')); fs.writeFileSync(path.join(f.directory, '.publish-owned'), '');
  assert.throws(() => findInstance(f.directory), { code: 'NO_RUNNING_INSTANCE' });
  for (let i = 0; i < 64; i++) fs.writeFileSync(path.join(f.directory, 'junk-' + i), '');
  assert.throws(() => findInstance(f.directory), { code: 'DISCOVERY_UNAVAILABLE' });
  assert.equal(fs.readdirSync(f.directory).length, 65);
});
