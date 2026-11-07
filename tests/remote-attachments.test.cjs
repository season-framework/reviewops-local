'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {createStore} = require('../electron/store.cjs');
const {createRemoteAttachments, REMOTE_ATTACHMENT_LIMITS: LIMIT} = require('../electron/remote-attachments.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error.code === expected;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-remote-attachments-')), dbPath = path.join(directory, 'owned.sqlite');
  let store = createStore({dbPath}), engine;
  const group = store.saveGroup({name: 'Attachment fixture'}), project = store.saveProject({groupId: group.id, name: 'Shared'});
  const other = store.saveProject({groupId: group.id, name: 'Private'}), review = store.saveReview({projectId: project.id, title: 'Shared review'});
  const otherReview = store.saveReview({projectId: other.id, title: 'Private review'}), a = Object.freeze({}), b = Object.freeze({});
  let write = true, allowed = true, time = Date.now(); const notifications = [];
  const authorize = (owner, scope) => {
    if (![a, b].includes(owner) || !allowed || scope.projectId !== project.id || scope.write && !write) throw new Error('Denied');
    return {principalId: owner === a ? 'device-a' : 'device-b'};
  };
  const open = () => createRemoteAttachments({store, dataPath: directory, authorize, clock: () => time,
    onCommitted(event) { assert.equal(store.inTransaction, false); notifications.push(event); }});
  engine = open();
  t.after(() => { engine.close(); store.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const intent = (bytes, extra = {}) => ({requestId: randomUUID(), projectId: project.id, reviewId: review.id, activityId: null,
    epoch: store.peerReadDataset().epoch, expectedRevision: store.db.prepare('SELECT revision FROM review_revisions WHERE reviewId=?').get(review.id).revision,
    name: 'owned.bin', mimeType: 'application/octet-stream', size: bytes.length, sha256: sha(bytes), ...extra});
  function upload(bytes, extra = {}, owner = a) {
    const request = intent(bytes, extra), started = engine.beginUpload(owner, request);
    for (let offset = 0; offset < bytes.length; offset += LIMIT.chunkBytes) engine.writeChunk(owner,
      {uploadId: started.uploadId, offset, data: bytes.subarray(offset, offset + LIMIT.chunkBytes).toString('base64')});
    return {request, started};
  }
  function localFile(bytes, activityId = null) {
    const storageName = randomUUID() + '.bin'; fs.writeFileSync(path.join(directory, 'attachments', storageName), bytes, {mode: 0o600});
    return store.addAttachment({reviewId: review.id, activityId, storageName, name: 'local.bin', mimeType: 'application/octet-stream', size: bytes.length, sha256: sha(bytes)});
  }
  return {directory, dbPath, project, other, review, otherReview, a, b, notifications, intent, upload, localFile,
    get store() { return store; }, get engine() { return engine; }, setWrite(value) { write = value; }, setAllowed(value) { allowed = value; }, advance(ms) { time += ms; },
    reopen() { engine.close(); store.close(); store = createStore({dbPath}); engine = open(); return engine; },
    pendingFiles() { return fs.readdirSync(path.join(directory, 'remote-attachment-uploads')); },
    publishedFiles() { return fs.readdirSync(path.join(directory, 'attachments')); }};
}

test('chunked upload commits metadata and receipt once; scoped download returns exact bytes without storage paths', t => {
  const f = fixture(t), bytes = Buffer.alloc(LIMIT.chunkBytes + 73); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const request = f.intent(bytes), start = f.engine.beginUpload(f.a, request);
  const chunk = {uploadId: start.uploadId, offset: 0, data: bytes.subarray(0, LIMIT.chunkBytes).toString('base64')};
  const first = f.engine.writeChunk(f.a, chunk); assert.deepEqual(f.engine.writeChunk(f.a, chunk), first);
  assert.equal(f.engine.beginUpload(f.a, request).received, LIMIT.chunkBytes);
  f.engine.writeChunk(f.a, {uploadId: start.uploadId, offset: LIMIT.chunkBytes, data: bytes.subarray(LIMIT.chunkBytes).toString('base64')});
  const result = f.engine.commitUpload(f.a, {uploadId: start.uploadId});
  assert.deepEqual(f.engine.commitUpload(f.a, {uploadId: start.uploadId}), result);
  assert.deepEqual(f.engine.beginUpload(f.a, request), result);
  assert.equal(f.store.snapshot().attachments.length, 1); assert.equal(f.notifications.length, 1); assert.deepEqual(f.pendingFiles(), []);
  const target = {projectId: f.project.id, reviewId: f.review.id, attachmentId: result.attachment.id};
  assert.equal(Object.hasOwn(f.engine.describe(f.a, target), 'storageName'), false);
  const chunks = [], offsets = []; let offset = 0, complete = false;
  while (!complete) {
    const read = f.engine.readChunk(f.a, {...target, offset}); chunks.push(Buffer.from(read.data, 'base64')); offsets.push(read.offset);
    assert.ok(Buffer.from(read.data, 'base64').length <= LIMIT.chunkBytes); offset = read.nextOffset; complete = read.complete;
  }
  assert.deepEqual(offsets, [0, LIMIT.chunkBytes]); assert.deepEqual(Buffer.concat(chunks), bytes);
  const restored = f.reopen(); assert.deepEqual(restored.commitUpload(f.a, {uploadId: start.uploadId}), result);
  assert.deepEqual(restored.result(f.a, {requestId: request.requestId, projectId: f.project.id, reviewId: f.review.id, epoch: request.epoch}), result);
  assert.equal(f.store.snapshot().attachments.length, 1); assert.equal(f.notifications.length, 1);
});

test('empty files commit and download with one terminal empty chunk', t => {
  const f = fixture(t), empty = f.upload(Buffer.alloc(0)), result = f.engine.commitUpload(f.a, {uploadId: empty.started.uploadId});
  const read = f.engine.readChunk(f.a, {projectId: f.project.id, reviewId: f.review.id, attachmentId: result.attachment.id, offset: 0});
  assert.equal(read.data, ''); assert.equal(read.nextOffset, 0); assert.equal(read.complete, true);
});

test('download hashes a stable file once while later requests read only their requested chunk', t => {
  const f = fixture(t), bytes = Buffer.alloc(LIMIT.chunkBytes + 123, 42), local = f.localFile(bytes);
  const target = {projectId: f.project.id, reviewId: f.review.id, attachmentId: local.id};
  const original = fs.readSync; let totalBytes = 0;
  fs.readSync = (...args) => { const count = original(...args); totalBytes += count; return count; };
  try {
    const first = f.engine.readChunk(f.a, {...target, offset: 0});
    const second = f.engine.readChunk(f.a, {...target, offset: first.nextOffset});
    assert.equal(second.complete, true); assert.equal(totalBytes, bytes.length * 2);
  } finally { fs.readSync = original; }
  const file = path.join(f.directory, 'attachments', local.storageName); fs.writeFileSync(file, Buffer.alloc(bytes.length, 43));
  assert.throws(() => f.engine.readChunk(f.a, {...target, offset: 0}), code('ATTACHMENT_CHANGED'));
});

test('upload ownership and read/write grants remain separate; revocation cleans only that owner stages', t => {
  const f = fixture(t), bytes = Buffer.from('owner-isolated');
  const a = f.engine.beginUpload(f.a, f.intent(bytes)), b = f.engine.beginUpload(f.b, f.intent(bytes));
  assert.throws(() => f.engine.writeChunk(f.b, {uploadId: a.uploadId, offset: 0, data: bytes.toString('base64')}), code('ACCESS_DENIED'));
  assert.equal(f.pendingFiles().length, 2); assert.deepEqual(f.engine.revokeOwner(f.a), {discarded: 1}); assert.equal(f.pendingFiles().length, 1);
  f.engine.writeChunk(f.b, {uploadId: b.uploadId, offset: 0, data: bytes.toString('base64')});
  const saved = f.engine.commitUpload(f.b, {uploadId: b.uploadId}); f.setWrite(false);
  assert.equal(f.engine.describe(f.a, {projectId: f.project.id, reviewId: f.review.id, attachmentId: saved.attachment.id}).size, bytes.length);
  assert.throws(() => f.engine.beginUpload(f.a, f.intent(bytes)), code('ACCESS_DENIED'));
  f.setAllowed(false); assert.throws(() => f.engine.readChunk(f.a, {projectId: f.project.id, reviewId: f.review.id, attachmentId: saved.attachment.id, offset: 0}), code('ACCESS_DENIED'));
});

test('hash failures, incomplete files and changed review revisions leave no temp or published attachment', t => {
  for (const mode of ['hash', 'incomplete', 'revision', 'restore', 'expired']) {
    const f = fixture(t), bytes = Buffer.from('must not publish'), request = f.intent(bytes, mode === 'hash' ? {sha256: '0'.repeat(64)} : {});
    const start = f.engine.beginUpload(f.a, request);
    if (mode !== 'incomplete') f.engine.writeChunk(f.a, {uploadId: start.uploadId, offset: 0, data: bytes.toString('base64')});
    if (mode === 'revision') f.store.addActivity({reviewId: f.review.id, body: 'Intervening local save'});
    if (mode === 'restore') f.store.importData(f.store.exportData());
    if (mode === 'expired') f.advance(LIMIT.lifetimeMs + 1);
    assert.throws(() => f.engine.commitUpload(f.a, {uploadId: start.uploadId}));
    assert.deepEqual(f.pendingFiles(), []); assert.deepEqual(f.publishedFiles(), []);
    assert.equal(f.store.snapshot().attachments.length, 0); assert.equal(f.notifications.length, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM remote_attachment_pending').get().count, 0);
  }
});

test('ordinary user comments accept uploads; private prompts and other review comments are denied', t => {
  const f = fixture(t), bytes = Buffer.from('comment attachment');
  const ordinary = f.store.addActivity({reviewId: f.review.id, body: 'Ordinary user comment'});
  const other = f.store.addActivity({reviewId: f.otherReview.id, body: 'Private comment'});
  const agent = f.store.addActivity({reviewId: f.review.id, body: 'Agent response', role: 'agent'});
  const userPrompt = f.store.addActivity({reviewId: f.review.id, body: 'Private submitted prompt'});
  f.store.db.prepare('UPDATE activities SET agentRunId=? WHERE id=?').run('private-run', userPrompt.id);
  for (const activity of [other, agent, userPrompt]) assert.throws(() => f.engine.beginUpload(f.a, f.intent(bytes, {activityId: activity.id})), code('NOT_FOUND'));
  const uploaded = f.upload(bytes, {activityId: ordinary.id}), saved = f.engine.commitUpload(f.a, {uploadId: uploaded.started.uploadId});
  assert.equal(saved.attachment.activityId, ordinary.id);
  const privateFile = f.localFile(bytes, userPrompt.id), responseFile = f.localFile(bytes, agent.id);
  const target = attachmentId => ({projectId: f.project.id, reviewId: f.review.id, attachmentId});
  assert.throws(() => f.engine.describe(f.a, target(privateFile.id)), code('NOT_FOUND'));
  assert.equal(f.engine.describe(f.a, target(responseFile.id)).id, responseFile.id);
});

test('local corruption, symbolic links, cross-project IDs and network paths cannot expose file contents', t => {
  const f = fixture(t), bytes = Buffer.from('original'), local = f.localFile(bytes);
  const target = {projectId: f.project.id, reviewId: f.review.id, attachmentId: local.id, offset: 0};
  assert.throws(() => f.engine.readChunk(f.a, {...target, reviewId: f.otherReview.id}), code('NOT_FOUND'));
  const file = path.join(f.directory, 'attachments', local.storageName);
  fs.writeFileSync(file, Buffer.from('modified')); assert.throws(() => f.engine.readChunk(f.a, target), code('ATTACHMENT_CHANGED'));
  fs.unlinkSync(file); const outside = path.join(f.directory, 'private.txt'); fs.writeFileSync(outside, bytes); fs.symlinkSync(outside, file);
  assert.throws(() => f.engine.readChunk(f.a, target));
  for (const name of ['../private.txt', '/private.txt', 'a\\private.txt']) assert.throws(() => f.engine.beginUpload(f.a, f.intent(bytes, {name})), code('INVALID_ATTACHMENT_REQUEST'));
  assert.throws(() => f.engine.beginUpload(f.a, f.intent(bytes, {size: LIMIT.fileBytes + 1})), code('INVALID_ATTACHMENT_REQUEST'));
});

test('changing the selected comment during upload invalidates its original attachment target', t => {
  const f = fixture(t), comment = f.store.addActivity({reviewId: f.review.id, body: 'Original comment'}), bytes = Buffer.from('stale');
  const started = f.upload(bytes, {activityId: comment.id}); f.store.updateActivity({id: comment.id, body: 'Changed by the host'});
  assert.throws(() => f.engine.commitUpload(f.a, {uploadId: started.started.uploadId}));
  assert.deepEqual(f.pendingFiles(), []); assert.deepEqual(f.publishedFiles(), []); assert.equal(f.store.snapshot().attachments.length, 0);
});

test('startup recovery removes journaled orphan publications and preserves committed attachment bytes', t => {
  const f = fixture(t), bytes = Buffer.from('keep committed'), saved = f.localFile(bytes);
  f.engine.close();
  const uploadId = randomUUID(), stageName = uploadId + '.part', orphan = randomUUID() + '.bin';
  fs.writeFileSync(path.join(f.directory, 'remote-attachment-uploads', stageName), 'orphan stage');
  fs.writeFileSync(path.join(f.directory, 'attachments', orphan), 'orphan publication');
  f.store.db.prepare('INSERT INTO remote_attachment_pending(uploadId,stageName,storageName) VALUES(?,?,?)').run(uploadId, stageName, orphan);
  const protectedId = randomUUID(), protectedStage = protectedId + '.part';
  fs.writeFileSync(path.join(f.directory, 'remote-attachment-uploads', protectedStage), 'stale linked stage');
  f.store.db.prepare('INSERT INTO remote_attachment_pending(uploadId,stageName,storageName) VALUES(?,?,?)').run(protectedId, protectedStage, saved.storageName);
  f.reopen(); assert.deepEqual(f.pendingFiles(), []); assert.deepEqual(f.publishedFiles(), [saved.storageName]);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'attachments', saved.storageName)), bytes);
});

test('a committed attachment notifies once even when stage cleanup fails; retry returns its durable receipt', t => {
  const f = fixture(t), bytes = Buffer.from('committed before cleanup failure'), upload = f.upload(bytes);
  const original = fs.unlinkSync, cleanupFailure = Object.assign(new Error('Owned synthetic stage cleanup failure'), {code: 'EACCES'});
  fs.unlinkSync = file => { if (String(file).endsWith(upload.started.uploadId + '.part')) throw cleanupFailure; return original(file); };
  try { assert.throws(() => f.engine.commitUpload(f.a, {uploadId: upload.started.uploadId}), error => error === cleanupFailure); }
  finally { fs.unlinkSync = original; }
  assert.equal(f.store.snapshot().attachments.length, 1); assert.equal(f.notifications.length, 1);
  assert.equal(f.pendingFiles().length, 1);
  const receipt = f.engine.commitUpload(f.a, {uploadId: upload.started.uploadId});
  assert.equal(receipt.state, 'committed'); assert.equal(receipt.attachment.sha256, sha(bytes));
  assert.equal(f.notifications.length, 1);
  f.reopen(); assert.deepEqual(f.pendingFiles(), []);
  assert.deepEqual(f.engine.commitUpload(f.a, {uploadId: upload.started.uploadId}), receipt);
  assert.equal(f.notifications.length, 1);
});
