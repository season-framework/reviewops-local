'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const {createStore} = require('../electron/store.cjs');
const {createRemoteCertificate, createRemoteTLSLease} = require('../electron/remote-tls.cjs');
const {createRemoteAppListener} = require('../electron/remote-app-listener.cjs');
const {createRemoteAppClient} = require('../electron/remote-app-client.cjs');
const {createPeerReadBrowsing} = require('../electron/peer-read-browsing.cjs');
const {createRemoteAppSessionStore} = require('../electron/remote-app-session-store.cjs');

async function fixture(t, executeAgent = () => { throw new Error('Unexpected host execution'); }, hooks = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-app-https-'));
  const store = createStore({dbPath: path.join(directory, 'owned.sqlite')});
  const group = store.saveGroup({name: 'HTTPS fixture'});
  const service = store.saveService({groupId: group.id, name: 'Host target', kind: 'local', rootPath: directory});
  const project = store.saveProject({groupId: group.id, name: 'Shared', serviceIds: [service.id]});
  const other = store.saveProject({groupId: group.id, name: 'Private', serviceIds: [service.id]});
  const review = store.saveReview({projectId: project.id, serviceId: service.id, title: 'Network review'});
  const generated = await createRemoteCertificate({address: '127.0.0.1'});
  const lease = createRemoteTLSLease({address: '127.0.0.1', ...generated}); generated.privateKeyDER.fill(0);
  const listener = createRemoteAppListener({lease, store, executeAgent, ...hooks});
  const {port} = await listener.start({address: '127.0.0.1', port: 0});
  const clients = [];
  const client = () => { const result = createRemoteAppClient({address: '127.0.0.1', port,
    certificatePEM: generated.certificatePEM, certificateFingerprint: generated.identity.certificateFingerprint}); clients.push(result); return result; };
  t.after(async () => {
    for (const item of clients) await item.disconnect().catch(() => {});
    await listener.close(); await lease.release(); store.close(); fs.rmSync(directory, {recursive: true, force: true});
  });
  const command = (operation, payload, requestId = operation.replaceAll('.', '-')) => ({operation, requestId,
    projectId: project.id, reviewId: review.id, epoch: store.peerReadDataset().epoch,
    expectedProjectBirth: store.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(project.id).birth,
    expectedReviewGeneration: store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(review.id).generation,
    expectedRevision: store.db.prepare('SELECT revision FROM review_revisions WHERE reviewId=?').get(review.id).revision, payload});
  return {store, service, project, other, review, generated, listener, port, client, command};
}
const code = expected => error => error.code === expected;

test('real pinned HTTPS app pairs with local approval, edits host data once and loses access when revoked', async t => {
  const commits = [];
  const f = await fixture(t, undefined, {onCommitted: event => commits.push(event)}), client = f.client(), invitation = f.listener.createInvitation();
  const pending = await client.connect({invitation: invitation.invitation, label: 'Second ReviewOps PC'});
  assert.equal(pending.state, 'pending'); assert.equal(Object.hasOwn(pending, 'sessionToken'), false);
  const command = f.command('comment.add', {body: 'Saved through real HTTPS'});
  await assert.rejects(client.command(command), code('PENDING_APPROVAL'));
  f.listener.approve({id: pending.id, grants: [{projectId: f.project.id, read: true, write: true, execute: false}]});
  assert.equal((await client.state()).state, 'approved');
  const result = await client.command(command);
  assert.equal(result.state, 'completed'); assert.equal(result.projectId, f.project.id);
  assert.deepEqual(await client.command(command), result);
  assert.deepEqual(await client.result({requestId: command.requestId, epoch: command.epoch, projectId: f.project.id}), result);
  assert.equal(f.store.snapshot().activities.filter(row => row.body === 'Saved through real HTTPS').length, 1);
  assert.deepEqual(commits, [{operation: 'comment.add', projectId: f.project.id, reviewId: f.review.id}]);
  assert.equal(f.listener.revoke({id: pending.id}), true);
  await assert.rejects(client.command(command), code('AUTH_FAILED'));
});

test('app readonly grants refuse writes and execution; one-use invitation and exact certificate pin are enforced', async t => {
  const f = await fixture(t), client = f.client(), invitation = f.listener.createInvitation();
  const pending = await client.connect({invitation: invitation.invitation, label: 'Read only PC'});
  f.listener.approve({id: pending.id, grants: [{projectId: f.project.id, read: true, write: false, execute: false}]});
  await assert.rejects(client.command(f.command('review.status.set', {status: 'closed'})), code('ACCESS_DENIED'));
  await assert.rejects(client.command(f.command('agent.start', {prompt: 'Not allowed'})), code('ACCESS_DENIED'));
  await assert.rejects(f.client().connect({invitation: invitation.invitation, label: 'Replayed invitation'}), code('AUTH_FAILED'));
  assert.equal(f.store.get('reviews', f.review.id).status, 'open');
  assert.throws(() => createRemoteAppClient({address: '127.0.0.1', port: f.port, certificatePEM: f.generated.certificatePEM,
    certificateFingerprint: '0'.repeat(64)}), code('INVALID_CONNECTION'));
  assert.throws(() => createRemoteAppClient({address: '127.0.0.2', port: f.port, certificatePEM: f.generated.certificatePEM,
    certificateFingerprint: f.generated.identity.certificateFingerprint}), code('INVALID_CONNECTION'));
});

test('browser cookies and cross-origin requests cannot acquire app sessions or commands', async t => {
  const f = await fixture(t), invitation = f.listener.createInvitation();
  const post = headers => new Promise((resolve, reject) => {
    const body = JSON.stringify({invitation: invitation.invitation, label: 'Forged browser'});
    const request = https.request({hostname: '127.0.0.1', port: f.port, ca: f.generated.certificatePEM,
      method: 'POST', path: '/api/app/connect', agent: false, headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers}}, response => {
      const chunks = []; response.on('data', value => chunks.push(value)); response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
    }); request.on('error', reject); request.end(body);
  });
  assert.equal((await post({Cookie: 'reviewops_session=forged-browser-cookie'})).error.code, 'INVALID_REQUEST');
  assert.equal((await post({Origin: `https://127.0.0.1:${f.port}`})).error.code, 'INVALID_REQUEST');
  assert.equal(f.listener.state().sessions.length, 0);
  assert.equal((await f.client().connect({invitation: invitation.invitation, label: 'Actual app'})).state, 'pending');
});

test('app grant cannot follow a logical restore into replacement data', async t => {
  const f = await fixture(t), client = f.client(), invitation = f.listener.createInvitation();
  const pending = await client.connect({invitation: invitation.invitation, label: 'Original dataset'});
  f.listener.approve({id: pending.id, grants: [{projectId: f.project.id, read: true, write: true, execute: true}]});
  const command = f.command('review.status.set', {status: 'resolved'});
  f.store.importData(f.store.exportData());
  await assert.rejects(client.command(command), code('ACCESS_DENIED'));
  assert.equal(f.store.get('reviews', f.review.id).status, 'open');
});

test('app browsing callbacks reuse one original opaque peer and the existing Store browsing facade', async t => {
  const peers = new Map(); let browsing, approvedPeer, revokedPeer;
  const f = await fixture(t, undefined, {
    onApprove(peer, grants) {
      assert.equal(Object.getPrototypeOf(peer), null); assert.deepEqual(Reflect.ownKeys(peer), []); assert.ok(Object.isFrozen(peer));
      approvedPeer = peer; peers.set(peer, null);
      browsing.approvePeer(peer, {projectIds: grants.filter(row => row.read).map(row => row.projectId)});
      peers.set(peer, browsing.openSession(peer));
    },
    onRead(peer, name, payload) { assert.equal(peer, approvedPeer); return browsing.query(peers.get(peer), name, payload); },
    onRevoke(peer) {
      revokedPeer = peer;
      const capability = peers.get(peer); if (capability) browsing.closeSession(capability);
      browsing.revokePeer(peer); peers.delete(peer);
    }
  });
  browsing = createPeerReadBrowsing({store: f.store, verifyPeerHandle: peer => peers.has(peer)}); browsing.setEnabled(true);
  const client = f.client(), pending = await client.connect({invitation: f.listener.createInvitation().invitation, label: 'App browse'});
  f.listener.approve({id: pending.id, grants: [{projectId: f.project.id, read: true, write: true, execute: false}]});
  const catalog = await client.read('projects.list', {});
  assert.deepEqual(catalog.projects.map(row => row.id), [f.project.id]);
  const review = await client.read('reviews.get', {projectId: f.project.id, reviewId: f.review.id});
  assert.equal(review.review.title, 'Network review');
  const state = await client.writeState({projectId: f.project.id, reviewId: f.review.id});
  assert.equal(state.epoch, f.store.peerReadDataset().epoch); assert.equal(state.status, 'open'); assert.ok(state.revision >= 1);
  await assert.rejects(client.read('reviews.list', {projectId: f.other.id}));
  f.listener.revoke({id: pending.id}); assert.equal(revokedPeer, approvedPeer);
  await assert.rejects(client.read('projects.list', {}), code('AUTH_FAILED'));
});

test('local owner admission guard refuses provisional-start commands without consuming the invitation', async t => {
  let enabled = false;
  const f = await fixture(t, undefined, {assertActive() {
    if (!enabled) throw Object.assign(new Error('Original app owner not enabled'), {code: 'ACCESS_DENIED'});
  }});
  const invitation = f.listener.createInvitation(), client = f.client();
  await assert.rejects(client.connect({invitation: invitation.invitation, label: 'Provisional client'}), code('ACCESS_DENIED'));
  assert.equal(f.listener.state().sessions.length, 0);
  enabled = true;
  const pending = await client.connect({invitation: invitation.invitation, label: 'Enabled client'});
  f.listener.approve({id: pending.id, grants: [{projectId: f.project.id, read: true, write: true, execute: true}]});
  const command = f.command('comment.add', {body: 'Must remain unsaved'});
  enabled = false;
  await assert.rejects(client.command(command), code('ACCESS_DENIED'));
  assert.equal(f.store.snapshot().activities.filter(row => row.body === 'Must remain unsaved').length, 0);
});

test('approved app token hashes and original principal survive host reopen; the saved command is not repeated', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-approved-apps-'));
  const dbPath = path.join(directory, 'owned.sqlite'), access = createRemoteAppSessionStore({directory: path.join(directory, 'access')});
  const generated = await createRemoteCertificate({address: '127.0.0.1'}), stores = [], listeners = [], leases = [], clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const listener of listeners) await listener.close();
    for (const lease of leases) await lease.release();
    for (const store of stores) store.close(); generated.privateKeyDER.fill(0);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const open = async requestedPort => {
    const store = createStore({dbPath}); stores.push(store);
    const lease = createRemoteTLSLease({address: '127.0.0.1', ...generated}); leases.push(lease);
    const listener = createRemoteAppListener({lease, store, executeAgent: () => { throw new Error('Unexpected agent'); }, sessionStore: access});
    listeners.push(listener); const endpoint = await listener.start({address: '127.0.0.1', port: requestedPort});
    return {store, lease, listener, port: endpoint.port};
  };
  const first = await open(0), group = first.store.saveGroup({name: 'Persistence fixture'});
  const project = first.store.saveProject({groupId: group.id, name: 'Shared'});
  const review = first.store.saveReview({projectId: project.id, serviceId: null, title: 'Durable app command'});
  let savedToken = '';
  const connect = ({port, sessionToken = ''}) => {
    const client = createRemoteAppClient({address: '127.0.0.1', port, certificatePEM: generated.certificatePEM,
      certificateFingerprint: generated.identity.certificateFingerprint, sessionToken, onSessionToken(token) { savedToken = token; }});
    clients.push(client); return client;
  };
  const client = connect(first), pending = await client.connect({invitation: first.listener.createInvitation().invitation, label: 'Saved PC'});
  first.listener.approve({id: pending.id, grants: [{projectId: project.id, read: true, write: true, execute: false}]});
  const metadata = await client.writeState({projectId: project.id, reviewId: review.id});
  const command = {operation: 'comment.add', requestId: 'durable-over-https', projectId: project.id, reviewId: review.id,
    epoch: metadata.epoch, expectedProjectBirth: metadata.projectBirth, expectedReviewGeneration: metadata.reviewGeneration, expectedRevision: metadata.revision, payload: {body: 'Created before host restart'}};
  const original = await client.command(command);
  const file = fs.readFileSync(path.join(directory, 'access', 'approved-apps.json'), 'utf8');
  assert.equal(file.includes(savedToken), false); assert.match(savedToken, /^[A-Za-z0-9_-]{43}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'access', 'approved-apps.json')).mode & 0o777, 0o600);
  client.close(); await first.listener.close(); await first.lease.release(); first.store.close();
  const second = await open(first.port), reconnected = connect({...second, sessionToken: savedToken});
  assert.equal((await reconnected.state()).id, pending.id);
  assert.deepEqual(await reconnected.command(command), original);
  assert.equal(second.store.snapshot().activities.filter(row => row.body === 'Created before host restart').length, 1);
  second.listener.revoke({id: pending.id});
  assert.deepEqual(access.read().sessions, []);
  await assert.rejects(reconnected.command(command), code('AUTH_FAILED'));
});
