'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createStore} = require('../electron/store.cjs');
const {createRemoteCertificate, createRemoteTLSLease} = require('../electron/remote-tls.cjs');
const {createRemoteAppListener} = require('../electron/remote-app-listener.cjs');
const {createRemoteAppSessionStore} = require('../electron/remote-app-session-store.cjs');
const {createRemoteAppConnections} = require('../electron/remote-app-connections.cjs');

// This fixture isolates connection/profile logic from the independently tested
// OS identity backend. It makes no Keychain, DPAPI or installed-app claim.
function protectedCredentialFixture(t) {
  const key = crypto.randomBytes(32), observed = new Set();
  t.after(() => key.fill(0));
  return {observed,
    async sealCredential({scope, secret, assertCurrent}) {
      assertCurrent(); observed.add(secret);
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(scope)); const bytes = Buffer.concat([cipher.update(secret), cipher.final()]);
      assertCurrent(); return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
    },
    async openCredential({scope, ciphertext, assertCurrent}) {
      assertCurrent(); const bytes = Buffer.from(ciphertext, 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(bytes.subarray(12, 28));
      const secret = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
      assertCurrent(); return secret;
    }
  };
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-app-profiles-'));
  const store = createStore({dbPath: path.join(root, 'host.sqlite')});
  const group = store.saveGroup({name: 'Connection fixture'});
  const project = store.saveProject({groupId: group.id, name: 'Shared'}), other = store.saveProject({groupId: group.id, name: 'Private'});
  const review = store.saveReview({projectId: project.id, serviceId: null, title: 'Host review'});
  const generated = await createRemoteCertificate({address: '127.0.0.1'}), lease = createRemoteTLSLease({address: '127.0.0.1', ...generated});
  generated.privateKeyDER.fill(0); let dropNextCommandResponse = false;
  const wrappedLease = {identity: lease.identity, createServer(handler) {
    return lease.createServer((request, response) => {
      if (request.url === '/api/app/command' && dropNextCommandResponse) {
        dropNextCommandResponse = false;
        response.end = () => { request.socket.destroy(); return response; };
      }
      handler(request, response);
    });
  }};
  const listener = createRemoteAppListener({lease: wrappedLease, store,
    executeAgent() { throw new Error('Unexpected agent execution'); },
    sessionStore: createRemoteAppSessionStore({directory: path.join(root, 'host-access')})});
  const {port} = await listener.start({address: '127.0.0.1', port: 0});
  const identityProvider = protectedCredentialFixture(t), dataPath = path.join(root, 'client'), managers = [];
  function manager() { const result = createRemoteAppConnections({dataPath, identityProvider}); managers.push(result); return result; }
  const guard = () => {};
  const connectInput = () => ({id: '', label: 'Saved host', address: '127.0.0.1', port,
    certificatePEM: generated.certificatePEM, certificateFingerprint: generated.identity.certificateFingerprint,
    invitation: listener.createInvitation().invitation});
  async function pair(connections, currentGuard = guard) {
    const connected = await connections.connect(connectInput(), currentGuard);
    listener.approve({id: connected.remote.id, grants: [{projectId: project.id, read: true, write: true, execute: false}]});
    await connections.refresh({id: connected.id}, currentGuard); return connected.id;
  }
  t.after(async () => {
    for (const item of managers) await item.closeAndDrain();
    await listener.close(); await lease.release(); store.close(); fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, store, project, other, review, listener, identityProvider, manager, pair, guard, dataPath, connectInput,
    profileFile: path.join(dataPath, 'remote-app-connections', 'hosts.json'),
    dropNextResponse() { dropNextCommandResponse = true; }};
}
const code = expected => error => error.code === expected;

test('outgoing profile restores the protected token over real HTTPS and public IPC state contains no credential', async t => {
  const f = await fixture(t), first = f.manager(), id = await f.pair(first);
  const original = first.state({}, f.guard), deviceId = original.connections[0].remote.id;
  const file = fs.readFileSync(f.profileFile, 'utf8');
  assert.equal(f.identityProvider.observed.size, 2); // Preflight probe and the actual bearer credential.
  for (const token of f.identityProvider.observed) {
    assert.equal(file.includes(token), false); assert.equal(JSON.stringify(original).includes(token), false);
  }
  assert.equal(Object.hasOwn(original.connections[0], 'ciphertext'), false);
  assert.equal(Object.hasOwn(original.connections[0].remote, 'sessionToken'), false);
  await first.closeAndDrain();
  const second = f.manager(); assert.equal(second.state({}, f.guard).connections[0].state, 'saved');
  const restored = await second.refresh({id}, f.guard);
  assert.equal(restored.remote.id, deviceId); assert.equal(restored.remote.state, 'approved');
  const metadata = await second.writeState({id, projectId: f.project.id, reviewId: f.review.id}, f.guard);
  assert.equal(metadata.epoch, f.store.peerReadDataset().epoch); assert.ok(metadata.revision >= 1);
});

test('lost response stays unresolved across manager reopen; NOT_FOUND does not claim no effects and exact lookup clears it', async t => {
  const f = await fixture(t), first = f.manager(), id = await f.pair(first);
  const metadata = await first.writeState({id, projectId: f.project.id, reviewId: f.review.id}, f.guard);
  const envelope = {operation: 'comment.add', requestId: crypto.randomUUID(), projectId: f.project.id, reviewId: f.review.id,
    epoch: metadata.epoch, expectedProjectBirth: metadata.projectBirth, expectedReviewGeneration: metadata.reviewGeneration, expectedRevision: metadata.revision, payload: {body: 'Private prompt text must not be stored in the client ledger'}};
  f.dropNextResponse(); await assert.rejects(first.command({id, envelope}, f.guard));
  assert.equal(f.store.snapshot().activities.filter(row => row.body === envelope.payload.body).length, 1);
  assert.equal(first.state({}, f.guard).pendingCommands.length, 1);
  const saved = fs.readFileSync(f.profileFile, 'utf8'); assert.equal(saved.includes(envelope.payload.body), false);
  await first.closeAndDrain(); const second = f.manager(); await second.refresh({id}, f.guard);
  assert.equal(second.state({}, f.guard).pendingCommands.length, 1);
  await assert.rejects(second.result({id, requestId: envelope.requestId, epoch: envelope.epoch, projectId: f.other.id}, f.guard), code('NOT_FOUND'));
  assert.equal(second.state({}, f.guard).pendingCommands.length, 1);
  await assert.rejects(second.forget({id}, f.guard), code('UNRESOLVED_COMMAND'));
  const result = await second.result({id, requestId: envelope.requestId, epoch: envelope.epoch, projectId: f.project.id}, f.guard);
  assert.equal(result.state, 'completed'); assert.equal(second.state({}, f.guard).pendingCommands.length, 0);
  assert.equal(f.store.snapshot().activities.filter(row => row.body === envelope.payload.body).length, 1);
});

test('a later current window can disconnect a saved client after the original pairing window becomes stale', async t => {
  const f = await fixture(t), connections = f.manager(); let originalCurrent = true;
  const originalGuard = () => { if (!originalCurrent) throw Object.assign(new Error('Original window changed'), {code: 'ACCESS_DENIED'}); };
  const id = await f.pair(connections, originalGuard); originalCurrent = false;
  await connections.disconnect({id}, f.guard);
  assert.equal(connections.state({}, f.guard).connections[0].state, 'disconnected');
  assert.equal(JSON.parse(fs.readFileSync(f.profileFile, 'utf8')).hosts[0].ciphertext, '');
});

test('missing protected identity fails before the one-use invitation is sent or consumed', async t => {
  const f = await fixture(t), input = f.connectInput();
  const unavailable = createRemoteAppConnections({dataPath: path.join(f.root, 'unavailable-client'), identityProvider: {
    async sealCredential() { throw Object.assign(new Error('Fixture identity unavailable'), {code: 'IDENTITY_UNAVAILABLE'}); },
    async openCredential() { throw new Error('Must not open'); }
  }});
  await assert.rejects(unavailable.connect(input, f.guard), code('IDENTITY_UNAVAILABLE'));
  assert.equal(f.listener.state().sessions.length, 0); await unavailable.closeAndDrain();
  const available = f.manager(), connected = await available.connect(input, f.guard);
  assert.equal(connected.remote.state, 'pending');
});

test('unresolved command identity retains its original intent and host while a lost response is investigated', async t => {
  const f = await fixture(t), first = f.manager(), id = await f.pair(first);
  const metadata = await first.writeState({id, projectId: f.project.id, reviewId: f.review.id}, f.guard);
  const envelope = {operation: 'comment.add', requestId: crypto.randomUUID(), projectId: f.project.id, reviewId: f.review.id,
    epoch: metadata.epoch, expectedProjectBirth: metadata.projectBirth, expectedReviewGeneration: metadata.reviewGeneration, expectedRevision: metadata.revision, payload: {body: 'Original ambiguous intent'}};
  f.dropNextResponse(); await assert.rejects(first.command({id, envelope}, f.guard));
  const original = first.state({}, f.guard).pendingCommands;
  assert.match(original[0].intentSHA256, /^[a-f0-9]{64}$/);
  await assert.rejects(first.command({id, envelope: {...envelope, payload: {body: 'Changed same request'}}}, f.guard), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(first.state({}, f.guard).pendingCommands, original);
  await first.closeAndDrain(); const second = f.manager();
  await assert.rejects(second.connect({...f.connectInput(), id, port: 65534}, f.guard), code('UNRESOLVED_COMMAND'));
  assert.deepEqual(second.state({}, f.guard).pendingCommands, original);
});

test('an explicit pre-admission revision conflict clears the lookup ledger and preserves the unsent draft', async t => {
  const f = await fixture(t), connections = f.manager(), id = await f.pair(connections);
  const metadata = await connections.writeState({id, projectId: f.project.id, reviewId: f.review.id}, f.guard);
  f.store.addActivity({reviewId: f.review.id, body: 'Concurrent local change'});
  const envelope = {operation: 'comment.add', requestId: crypto.randomUUID(), projectId: f.project.id, reviewId: f.review.id,
    epoch: metadata.epoch, expectedProjectBirth: metadata.projectBirth, expectedReviewGeneration: metadata.reviewGeneration, expectedRevision: metadata.revision, payload: {body: 'Draft remains on the client'}};
  await assert.rejects(connections.command({id, envelope}, f.guard), code('REVISION_CONFLICT'));
  assert.equal(connections.state({}, f.guard).pendingCommands.length, 0);
  assert.equal(f.store.snapshot().activities.filter(row => row.body === envelope.payload.body).length, 0);
  assert.equal(envelope.payload.body, 'Draft remains on the client');
});

test('saved outgoing credentials refuse symlink or broadly readable profile files', async t => {
  const f = await fixture(t), connections = f.manager(); await f.pair(connections); await connections.closeAndDrain();
  if (process.platform !== 'win32') {
    fs.chmodSync(f.profileFile, 0o644);
    assert.throws(() => f.manager(), code('REMOTE_CONNECTIONS_UNAVAILABLE')); fs.chmodSync(f.profileFile, 0o600);
  }
  const original = f.profileFile + '.original'; fs.renameSync(f.profileFile, original); fs.symlinkSync(original, f.profileFile);
  assert.throws(() => f.manager(), code('REMOTE_CONNECTIONS_UNAVAILABLE'));
});

test('credential denial preserves the exact saved connection and explicit retry restores the original approval',async t=>{
 const f=await fixture(t),first=f.manager(),id=await f.pair(first),original=first.state({},f.guard).connections[0].remote.id;
 await first.closeAndDrain();const second=f.manager(),before=fs.readFileSync(f.profileFile);
 const open=f.identityProvider.openCredential;f.identityProvider.openCredential=async()=>{throw Object.assign(new Error('Controlled denial; not an OS Keychain result'),{code:'IDENTITY_UNAVAILABLE'});};
 await assert.rejects(second.refresh({id},f.guard),code('IDENTITY_UNAVAILABLE'));
 assert.equal(second.state({},f.guard).connections[0].state,'credential_locked');assert.deepEqual(fs.readFileSync(f.profileFile),before);
 f.identityProvider.openCredential=open;
 const restored=await second.refresh({id},f.guard);assert.equal(restored.remote.id,original);
 assert.equal(second.state({},f.guard).connections[0].state,'approved');assert.deepEqual(fs.readFileSync(f.profileFile),before);
});
test('a failed saved-host replacement cannot erase the original protected credential or endpoint',async t=>{
 const f=await fixture(t),first=f.manager(),id=await f.pair(first);await first.closeAndDrain();
 const second=f.manager(),before=JSON.parse(fs.readFileSync(f.profileFile,'utf8')).hosts[0];
 // An invalid one-use secret fails deterministically without changing the old
 // enrollment. Production network errors use the same replacement rollback.
 await assert.rejects(second.connect({...f.connectInput(),id,label:'Replacement label',invitation:'bad'},f.guard),code('INVALID_REQUEST'));
 const after=JSON.parse(fs.readFileSync(f.profileFile,'utf8')).hosts[0];assert.deepEqual(after,before);
 assert.equal((await second.refresh({id},f.guard)).remote.state,'approved');
});
