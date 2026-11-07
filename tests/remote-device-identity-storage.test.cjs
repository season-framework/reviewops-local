'use strict';

// Controlled encryption fixtures verify the wrapper's refusal/binding contract.
// They do not claim Windows DPAPI or macOS Keychain qualification.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createEncryptedIdentityStorage} = require('../electron/remote-device-identity-storage.cjs');
const {identityRuntimeAllowed} = require('../electron/remote-identity-qualification.cjs');
function fixture() {
  let available = true, allowed = true, encryptions = 0;
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString(text) {
      encryptions++;
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(data) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    }
  };
  return {safeStorage, make: () => createEncryptedIdentityStorage({safeStorage, allowed: () => allowed}),
    unavailable: () => { available = false; }, deny: () => { allowed = false; }, encryptions: () => encryptions};
}
test('ciphertext reopens under the same immutable account and exposes no plaintext', () => {
  const f = fixture(), account = crypto.randomUUID(), first = f.make(), payload = Buffer.from('a private fixture value');
  first.initialize(account);
  const reference = first.create(payload);
  assert.equal(reference.includes(payload), false);
  assert.deepEqual(first.read(reference), payload);
  first.close();
  const reopened = f.make(); reopened.initialize(account);
  assert.deepEqual(reopened.read(reference), payload);
  const other = f.make(); other.initialize(crypto.randomUUID());
  assert.throws(() => other.read(reference), {code: 'IDENTITY_LOST'});
});
test('unavailable or disallowed backend performs no encryption and cannot become usable by retry', () => {
  for (const change of ['unavailable', 'deny']) {
    const f = fixture(); f[change](); const store = f.make();
    assert.throws(() => store.initialize(crypto.randomUUID()), {code: 'IDENTITY_UNAVAILABLE'});
    assert.throws(() => store.initialize(crypto.randomUUID()), {code: 'IDENTITY_UNAVAILABLE'});
    assert.equal(f.encryptions(), 0);
  }
});
test('tampered ciphertext, oversized reference and wrong removal digest are refused', () => {
  const f = fixture(), store = f.make(), payload = Buffer.from('secret'); store.initialize(crypto.randomUUID());
  const reference = store.create(payload), tampered = Buffer.from(reference); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => store.read(tampered), {code: 'IDENTITY_LOST'});
  assert.throws(() => store.read(Buffer.alloc(4097)), {code: 'IDENTITY_LOST'});
  assert.throws(() => store.remove(reference, Buffer.alloc(32)), {code: 'IDENTITY_UNAVAILABLE'});
  store.remove(reference, crypto.createHash('sha256').update(payload).digest());
  store.close(); assert.throws(() => store.read(reference), {code: 'IDENTITY_UNAVAILABLE'});
});
test('Windows runtime rejects basic/mock switches; unsupported systems have no fallback', () => {
  const switches = new Map(), app = {isReady: () => true};
  const commandLine = {hasSwitch: name => switches.has(name), getSwitchValue: name => switches.get(name) || ''};
  assert.equal(identityRuntimeAllowed({app, commandLine, platform: 'win32'}), true);
  for (const [name, value] of [['use-mock-keychain', ''], ['password-store', 'basic'], ['disable-encryption', '']]) {
    switches.set(name, value); assert.equal(identityRuntimeAllowed({app, commandLine, platform: 'win32'}), false); switches.clear();
  }
  assert.equal(identityRuntimeAllowed({app, commandLine, platform: 'linux'}), false);
});
