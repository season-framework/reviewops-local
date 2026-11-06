'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {createRemoteAppSessionStore} = require('../electron/remote-app-session-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-app-access-file-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'access'), file = path.join(directory, 'approved-apps.json');
  return {root, directory, file, store: createRemoteAppSessionStore({directory})};
}
const valid = () => ({version: 1, sessions: [{id: randomUUID(), label: 'Approved test device', address: '127.0.0.1',
  digest: 'a'.repeat(64), epoch: randomUUID(), expiresAt: Date.now() + 60000,
  grants: [{projectId: 'owned-project', birth: 1, read: true, write: false, execute: true}]}]});
const unavailable = error => error.code === 'APP_ACCESS_STORAGE_UNAVAILABLE';

test('approved access file excludes bearer secrets and malformed persisted approvals fail closed', t => {
  const f = fixture(t), value = valid();
  assert.deepEqual(f.store.read(), {version: 1, sessions: []});
  f.store.write(value); assert.deepEqual(f.store.read(), value);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.store.write({version: 1, sessions: [{...value.sessions[0], sessionToken: 'unusable-test-secret'}]}), unavailable);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  fs.writeFileSync(f.file, '{"version":1,"sessions":[{"id":"bad"}]}');
  assert.throws(() => f.store.read(), unavailable);
});

test('access persistence refuses symbolic links and broadly readable approval files', t => {
  const f = fixture(t); f.store.read();
  const outside = path.join(f.root, 'outside.json'); fs.writeFileSync(outside, JSON.stringify(valid()), {mode: 0o600});
  fs.symlinkSync(outside, f.file);
  assert.throws(() => f.store.read(), unavailable); assert.throws(() => f.store.write(valid()), unavailable);
  fs.unlinkSync(f.file); f.store.write(valid());
  if (process.platform !== 'win32') {
    fs.chmodSync(f.file, 0o644); assert.throws(() => f.store.read(), unavailable); assert.throws(() => f.store.write(valid()), unavailable);
  }
});
