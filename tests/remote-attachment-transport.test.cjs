'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const {createStore} = require('../electron/store.cjs');
const {createRemoteManagement} = require('../electron/remote-management.cjs');
const {createRemoteCertificate, createRemoteTLSLease} = require('../electron/remote-tls.cjs');
const {createRemoteAppClient} = require('../electron/remote-app-client.cjs');
const {createRemoteAppConnections} = require('../electron/remote-app-connections.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error.code === expected;
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

async function fixture(t) {
  // Generated in-memory TLS and AES fixture keys isolate transport/Store behavior.
  // This test makes no native Keychain/DPAPI or installed/two-PC claim.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-attachment-https-')));
  const store = createStore({dbPath: path.join(root, 'owned.sqlite')});
  const group = store.saveGroup({name: 'Attachment HTTPS'}), project = store.saveProject({groupId: group.id, name: 'Shared'});
  const other = store.saveProject({groupId: group.id, name: 'Private'}), review = store.saveReview({projectId: project.id, title: 'Host review'});
  const assets = path.join(root, 'dist'); fs.mkdirSync(path.join(assets, '.vite'), {recursive: true}); fs.mkdirSync(path.join(assets, 'assets'));
  fs.writeFileSync(path.join(assets, 'remote.html'), '<!doctype html><title>Attachment test</title>');
  fs.writeFileSync(path.join(assets, 'assets', 'remote-test.js'), 'export const fixture=true;');
  fs.writeFileSync(path.join(assets, '.vite', 'manifest.json'), JSON.stringify({'remote.html': {file: 'assets/remote-test.js', src: 'remote.html', isEntry: true}}));
  const generated = await createRemoteCertificate({address: '127.0.0.1'});
  const {certificatePEM: _certificate, ...identityFields} = generated.identity, identity = {deviceId: 'memory-fixture', ...identityFields};
  const credentialKey = crypto.randomBytes(32); let dropAttachmentResponse = false;
  const provider = {
    state: () => ({status: 'ready', backend: 'electron-safe-storage', identity, errorCode: null}),
    initialize: async () => {}, publicCertificate: () => ({...identity, certificatePEM: generated.certificatePEM}),
    async acquireServerTLS({address, assertCurrent}) {
      assertCurrent(); const lease = createRemoteTLSLease({address, ...generated});
      return {identity: lease.identity, release: lease.release, createServer(handler) {
        return lease.createServer((request, response) => {
          if (request.url === '/api/app/attachment' && dropAttachmentResponse) {
            dropAttachmentResponse = false; response.end = () => { request.socket.destroy(); return response; };
          }
          handler(request, response);
        });
      }};
    },
    async sealCredential({scope, secret, assertCurrent}) {
      assertCurrent(); const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', credentialKey, iv);
      cipher.setAAD(Buffer.from(scope)); const body = Buffer.concat([cipher.update(secret), cipher.final()]);
      assertCurrent(); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    },
    async openCredential({scope, ciphertext, assertCurrent}) {
      assertCurrent(); const body = Buffer.from(ciphertext, 'base64url'), cipher = crypto.createDecipheriv('aes-256-gcm', credentialKey, body.subarray(0, 12));
      cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(body.subarray(12, 28)); const result = Buffer.concat([cipher.update(body.subarray(28)), cipher.final()]).toString();
      assertCurrent(); return result;
    },
    async closeAndDrain() { generated.privateKeyDER.fill(0); credentialKey.fill(0); }
  };
  let queue = Promise.resolve(), held = null; const notifications = [], clients = [], connectionManagers = [];
  const manager = createRemoteManagement({store, identityProvider: provider, assetDirectory: assets,
    onCommitted: event => notifications.push(event), executeAgent() { throw new Error('No agent execution in attachment fixture'); },
    enqueueRead(fn) {
      if (held) { const hold = held; held = null; hold.entered.resolve(); return hold.release.promise.then(fn); }
      const task = queue.then(fn); queue = task.catch(() => {}); return task;
    }});
  t.after(async () => {
    if (held) held.release.resolve();
    for (const item of connectionManagers) await item.closeAndDrain();
    for (const item of clients) await item.close();
    await manager.closeAndDrain(); store.close(); fs.rmSync(root, {recursive: true, force: true});
  });
  const input = extra => ({expectedGeneration: manager.state().generation, ...extra});
  const webPort = await freePort(); await manager.configureWeb(input({bindAddress: '127.0.0.1', port: webPort, enabled: true}), () => {});
  const appPort = await freePort(); await manager.configureApp(input({bindAddress: '127.0.0.1', port: appPort, enabled: true}), () => {});
  const web = (route, body, cookie) => new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const request = https.request({hostname: '127.0.0.1', port: webPort, path: route, method: 'POST', agent: false,
      ca: generated.certificatePEM, rejectUnauthorized: true, allowPartialTrustChain: true,
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, Origin: `https://127.0.0.1:${webPort}`, ...(cookie ? {Cookie: cookie} : {})}}, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.once('error', reject);
      response.once('end', () => resolve({status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks))}));
    }); request.once('error', reject); request.end(bytes);
  });
  async function browser() {
    const invitation = manager.inviteBrowser(input({}), () => {}), response = await web('/web/v1/session',
      {version: 1, requestId: crypto.randomUUID(), action: 'login', invitationId: invitation.invitationId, secret: invitation.secret, clientName: 'Attachment browser'});
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    manager.approveBrowser(input({pendingId: manager.state().pending[0].pendingId, projectIds: [project.id]}), () => {});
    return {cookie, read: payload => web('/web/v1/read', {version: 1, requestId: crypto.randomUUID(), operation: 'attachments.read', payload}, cookie)};
  }
  async function app(write = true) {
    const client = createRemoteAppClient({address: '127.0.0.1', port: appPort, certificatePEM: generated.certificatePEM,
      certificateFingerprint: identity.certificateFingerprint}); clients.push(client);
    const pending = await client.connect({invitation: manager.inviteApp(input({}), () => {}).invitation, label: 'Attachment app'});
    manager.approveApp(input({id: pending.id, grants: [{projectId: project.id, read: true, write, execute: false}]}), () => {});
    return {client, pending};
  }
  const uploadInput = (bytes, extra = {}) => ({requestId: crypto.randomUUID(), projectId: project.id, reviewId: review.id, activityId: null,
    epoch: store.peerReadDataset().epoch, expectedRevision: store.db.prepare('SELECT revision FROM review_revisions WHERE reviewId=?').get(review.id).revision,
    name: 'network.bin', mimeType: 'application/octet-stream', size: bytes.length, sha256: hash(bytes), ...extra});
  function connections() { const value = createRemoteAppConnections({dataPath: path.join(root, 'outgoing'), identityProvider: provider}); connectionManagers.push(value); return value; }
  return {root, store, group, project, other, review, manager, input, browser, app, web, appPort, generated, identity, connections, notifications,
    uploadInput, dropNextAttachmentResponse() { dropAttachmentResponse = true; },
    holdNextRequest() { held = {entered: gate(), release: gate()}; return held; }};
}

test('real HTTPS app uploads once and approved browser/app download the same scoped binary bytes', async t => {
  const f = await fixture(t), {client} = await f.app(), browser = await f.browser(), bytes = Buffer.alloc(65536 + 17, 107);
  const request = f.uploadInput(bytes), begin = await client.attachment('beginUpload', request);
  for (let offset = 0; offset < bytes.length; offset += 65536) await client.attachment('writeChunk',
    {uploadId: begin.uploadId, offset, data: bytes.subarray(offset, offset + 65536).toString('base64')});
  const committed = await client.attachment('commitUpload', {uploadId: begin.uploadId});
  assert.equal(committed.state, 'committed'); assert.equal(f.notifications.length, 1);
  assert.deepEqual(await client.attachment('commitUpload', {uploadId: begin.uploadId}), committed);
  const target = {projectId: f.project.id, reviewId: f.review.id, attachmentId: committed.attachment.id};
  const browserChunks = [], appChunks = [];
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const web = await browser.read({...target, offset}); assert.equal(web.body.ok, true);
    browserChunks.push(Buffer.from(web.body.data.data, 'base64'));
    const app = await client.attachment('readChunk', {...target, offset}); appChunks.push(Buffer.from(app.data, 'base64'));
    assert.equal(Object.hasOwn(app.attachment, 'storageName'), false);
  }
  assert.deepEqual(Buffer.concat(browserChunks), bytes); assert.deepEqual(Buffer.concat(appChunks), bytes);
  assert.equal(f.store.snapshot().attachments.length, 1); assert.equal(f.notifications.length, 1);
  const readonly = await f.app(false);
  await assert.rejects(readonly.client.attachment('beginUpload', f.uploadInput(Buffer.from('denied'))), code('ACCESS_DENIED'));
  await assert.rejects(client.attachment('readChunk', {...target, projectId: f.other.id, offset: 0}));
});

test('revoked app original owner loses queued attachment access and its staged upload is removed', async t => {
  const f = await fixture(t), {client, pending} = await f.app(), bytes = Buffer.from('uncommitted owner bytes');
  const start = await client.attachment('beginUpload', f.uploadInput(bytes));
  await client.attachment('writeChunk', {uploadId: start.uploadId, offset: 0, data: bytes.toString('base64')});
  assert.equal(fs.readdirSync(path.join(f.root, 'remote-attachment-uploads')).length, 1);
  const hold = f.holdNextRequest(), lookup = client.attachment('commitUpload', {uploadId: start.uploadId});
  const refused = assert.rejects(lookup, code('ACCESS_DENIED')); await hold.entered.promise;
  f.manager.revokeApp(f.input({id: pending.id}), () => {}); hold.release.resolve(); await refused;
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'remote-attachment-uploads')), []);
  assert.equal(f.store.snapshot().attachments.length, 0);
});

test('an approved original app cannot attach to a deleted and recreated project with the same IDs', async t => {
  const f = await fixture(t), {client} = await f.app(), bytes = Buffer.from('old project incarnation');
  const start = await client.attachment('beginUpload', f.uploadInput(bytes));
  await client.attachment('writeChunk', {uploadId: start.uploadId, offset: 0, data: bytes.toString('base64')});
  const project = {...f.store.db.prepare('SELECT * FROM projects WHERE id=?').get(f.project.id)}, review = {...f.store.db.prepare('SELECT * FROM reviews WHERE id=?').get(f.review.id)};
  f.store.transaction(() => {
    f.store.deleteProject(f.project.id);
    for (const [table, row] of [['projects', project], ['reviews', review]]) {
      const names = Object.keys(row); f.store.db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`).run(...names.map(key => row[key]));
    }
  });
  await assert.rejects(client.attachment('commitUpload', {uploadId: start.uploadId}), code('ACCESS_DENIED'));
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'remote-attachment-uploads')), []);
  assert.equal(f.store.snapshot().attachments.length, 0);
});

test('lost commit response persists pending upload lookup across outgoing manager reopen without re-uploading', async t => {
  const f = await fixture(t), first = f.connections(), guard = () => {}, invitation = f.manager.inviteApp(f.input({}), guard);
  const connected = await first.connect({id: '', label: 'Durable outgoing app', address: '127.0.0.1', port: f.appPort,
    certificatePEM: f.generated.certificatePEM, certificateFingerprint: f.identity.certificateFingerprint, invitation: invitation.invitation}, guard);
  f.manager.approveApp(f.input({id: connected.remote.id, grants: [{projectId: f.project.id, read: true, write: true, execute: false}]}), guard);
  await first.refresh({id: connected.id}, guard);
  const bytes = Buffer.from('persisted commit lookup'), request = f.uploadInput(bytes);
  const start = await first.attachment({id: connected.id, operation: 'beginUpload', payload: request}, guard);
  await first.attachment({id: connected.id, operation: 'writeChunk', payload: {uploadId: start.uploadId, offset: 0, data: bytes.toString('base64')}}, guard);
  f.dropNextAttachmentResponse();
  await assert.rejects(first.attachment({id: connected.id, operation: 'commitUpload', payload: {uploadId: start.uploadId}}, guard));
  assert.equal(first.state({}, guard).pendingUploads[0].phase, 'committing');
  assert.equal(f.store.snapshot().attachments.length, 1); await first.closeAndDrain();
  const second = f.connections(); await second.refresh({id: connected.id}, guard);
  assert.equal(second.state({}, guard).pendingUploads.length, 1);
  await assert.rejects(second.disconnect({id: connected.id}, guard), code('UNRESOLVED_COMMAND'));
  const committed = await second.attachment({id: connected.id, operation: 'result', payload:
    {requestId: request.requestId, projectId: f.project.id, reviewId: f.review.id, epoch: request.epoch}}, guard);
  assert.equal(committed.state, 'committed'); assert.equal(second.state({}, guard).pendingUploads.length, 0);
  assert.equal(f.store.snapshot().attachments.length, 1); assert.equal(f.notifications.length, 1);
});
