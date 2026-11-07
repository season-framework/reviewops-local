'use strict';

// Opt-in real Electron/Keychain development fixture. Never the application's
// identity profile. Only public assertions and a cleanup flag leave this process.
const {app} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const [phase, directory] = process.argv.slice(2);
if (!['create', 'reopen-cleanup'].includes(phase) || !path.isAbsolute(directory) ||
    !path.basename(directory).startsWith('reviewops-native-identity-test-')) throw new Error('Invalid fixture profile.');
app.setName('ReviewOps');
app.setAppPath(root);
app.setPath('userData', directory);
app.disableHardwareAcceleration();
// Exercise the native identity backend alongside the unchanged cookie policy.
app.commandLine.appendSwitch('use-mock-keychain');
let provider, lease, cleaned = false;
function removeOwnFixtureItem() {
  const index = JSON.parse(fs.readFileSync(path.join(directory, 'remote-device-identity/index.json'), 'utf8'));
  const storage = require('../../electron/remote-device-identity-native.cjs').loadMacIdentityStorage({appPath: root, packaged: false});
  const reference = Buffer.from(index.referenceBase64, 'base64'), digest = Buffer.from(index.payloadSHA256, 'hex');
  try { storage.remove(reference, digest); cleaned = true; } finally { reference.fill(0); digest.fill(0); }
}
app.whenReady().then(async () => {
  try {
    provider = require('../../electron/remote-device-identity.cjs').createRemoteDeviceIdentity({app, dataPath: directory});
    assert.equal(provider.state().status, 'not_initialized');
    const request = {address: '127.0.0.1', assertCurrent() {}};
    const state = await provider.initialize(request);
    assert.equal(state.status, 'ready', state.errorCode);
    assert.equal(state.backend, 'macos-default-file-keychain');
    const publicIdentity = provider.publicCertificate();
    const expectedFile = path.join(directory, 'expected-public.json');
    if (phase === 'create') fs.writeFileSync(expectedFile, JSON.stringify(publicIdentity), {flag: 'wx', mode: 0o600});
    else assert.deepEqual(publicIdentity, JSON.parse(fs.readFileSync(expectedFile, 'utf8')));
    lease = await provider.acquireServerTLS(request);
    const server = lease.createServer((req, res) => { res.end('identity-fixture-ok'); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const response = await new Promise((resolve, reject) => {
      // Trust exactly this public leaf before sending HTTP, independently of
      // Electron's CA store. This does not install operating-system trust.
      const socket = tls.connect({host: '127.0.0.1', port: server.address().port,
        ca: publicIdentity.certificatePEM, allowPartialTrustChain: true,
        minVersion: 'TLSv1.2', rejectUnauthorized: true}, () => {
        try {
          assert.equal(socket.authorized, true);
          const actual = new crypto.X509Certificate(socket.getPeerCertificate().raw);
          assert.equal(crypto.createHash('sha256').update(actual.raw).digest('hex'), publicIdentity.certificateFingerprint);
          assert.equal(actual.checkIP('127.0.0.1'), '127.0.0.1');
          assert.equal(actual.verify(actual.publicKey), true);
          socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        } catch (error) { socket.destroy(); reject(error); }
      });
      let body = '';
      socket.on('data', chunk => { body += chunk; });
      socket.on('end', () => resolve(body));
      socket.on('error', reject);
    });
    assert.match(response, /identity-fixture-ok/);
    await lease.release(); lease = null;
    const credentialFile=path.join(directory,'public-fixture-ciphertext.json');
    const publicTestToken=Buffer.alloc(32,7).toString('base64url');
    if(phase==='create'){
      const scope='remote-app-client:'+crypto.randomUUID()+':'+'a'.repeat(64);
      const ciphertext=await provider.sealCredential({scope,secret:publicTestToken,assertCurrent(){}});
      fs.writeFileSync(credentialFile,JSON.stringify({scope,ciphertext}),{flag:'wx',mode:0o600});
    }else{
      const {scope,ciphertext}=JSON.parse(fs.readFileSync(credentialFile,'utf8'));
      assert.equal(await provider.openCredential({scope,ciphertext,assertCurrent(){}}),publicTestToken);
      const renewed=await provider.initialize({address:'127.0.0.2',assertCurrent(){}});
      assert.equal(renewed.status,'ready');assert.equal(renewed.identity.keyFingerprint,publicIdentity.keyFingerprint);
      assert.equal(await provider.openCredential({scope,ciphertext,assertCurrent(){}}),publicTestToken);
    }
    if (phase === 'reopen-cleanup') {
      removeOwnFixtureItem();
    }
    await provider.closeAndDrain(); provider = null;
    console.log(JSON.stringify({ok: true, phase, tls: true, sameIdentity: true, cleaned}));
    app.exit(0);
  } catch (error) {
    // Fixed diagnostic only; never print a private buffer/native exception/path.
    try { await lease?.release(); } catch {}
    if (phase === 'reopen-cleanup' && provider?.state().status === 'ready' && !cleaned) {
      try { removeOwnFixtureItem(); } catch {}
    }
    try { await provider?.closeAndDrain(); } catch {}
    console.error(JSON.stringify({ok: false, phase, code: error?.code || 'FIXTURE_ASSERTION_FAILED', cleaned}));
    app.exit(1);
  }
});
