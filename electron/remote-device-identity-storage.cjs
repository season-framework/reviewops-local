'use strict';

// Application-internal adapter. The persisted reference IS ciphertext; this does
// not create or delete individual OS vault records. Never exported through IPC.
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code = 'IDENTITY_UNAVAILABLE') {
  throw Object.assign(new Error('The remote identity request was refused.'), {code});
}
function createEncryptedIdentityStorage({safeStorage, allowed}) {
  // Capture the original module methods; callers cannot replace a live owner.
  const available = safeStorage.isEncryptionAvailable.bind(safeStorage);
  const encrypt = safeStorage.encryptString.bind(safeStorage);
  const decrypt = safeStorage.decryptString.bind(safeStorage);
  let account = null, closed = false;
  function guard() {
    if (closed || !account || allowed() !== true || available() !== true) fail();
  }
  function read(reference) {
    guard();
    if (!Buffer.isBuffer(reference) || reference.length < 1 || reference.length > 4096) fail('IDENTITY_LOST');
    let snapshot = Buffer.from(reference), text, envelope, payload;
    try {
      try { text = decrypt(snapshot); } catch { fail('IDENTITY_LOST'); }
      guard();
      if (typeof text !== 'string' || Buffer.byteLength(text) > 100000) fail('IDENTITY_LOST');
      try { envelope = JSON.parse(text); } catch { fail('IDENTITY_LOST'); }
      if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype ||
          Object.keys(envelope).sort().join(',') !== 'account,payload,schema' ||
          envelope.schema !== 1 || envelope.account !== account ||
          typeof envelope.payload !== 'string' || envelope.payload.length > 87384 ||
          JSON.stringify(envelope) !== text) fail('IDENTITY_LOST');
      payload = Buffer.from(envelope.payload, 'base64');
      if (!payload.length || payload.length > 65536 || payload.toString('base64') !== envelope.payload) fail('IDENTITY_LOST');
      guard();
      const result = payload; payload = null; return result;
    } finally {
      snapshot.fill(0); payload?.fill(0);
      // Electron's string API necessarily creates GC-managed plaintext strings.
      // They are never logged, persisted, or returned beyond this main module.
      text = null; envelope = null;
    }
  }
  return Object.freeze({
    initialize(value) {
      if (closed || account || typeof value !== 'string' || !UUID.test(value)) fail();
      account = value;
      guard();
    },
    create(payload) {
      guard();
      if (!Buffer.isBuffer(payload) || !payload.length || payload.length > 65536) fail();
      let result;
      try {
        result = encrypt(JSON.stringify({schema: 1, account, payload: payload.toString('base64')}));
        guard();
        if (!Buffer.isBuffer(result) || !result.length || result.length > 4096) fail();
        return result;
      } catch { result?.fill(0); fail(); }
    },
    read,
    remove(reference, expectedDigest) {
      let payload;
      try {
        if (!Buffer.isBuffer(expectedDigest) || expectedDigest.length !== 32) fail();
        payload = read(reference);
        if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(payload).digest(), expectedDigest)) fail();
        // The caller removes its own ciphertext file. The app-wide OS master key
        // belongs to Electron; deleting it would damage unrelated app storage.
      } finally { payload?.fill(0); }
    },
    close() { closed = true; account = null; }
  });
}

module.exports = {createEncryptedIdentityStorage};
