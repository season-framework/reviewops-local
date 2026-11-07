'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const LIMITS = Object.freeze({fileBytes: 10 * 1024 * 1024, chunkBytes: 64 * 1024,
  uploads: 16, ownerUploads: 4, pendingBytes: 40 * 1024 * 1024, lifetimeMs: 15 * 60 * 1000});
const owners = new Map();
function fail(code) { throw Object.assign(new Error('The remote attachment request could not be completed.'), {code}); }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_ATTACHMENT_REQUEST');
  const names = Reflect.ownKeys(value), result = {};
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) fail('INVALID_ATTACHMENT_REQUEST');
  for (const key of keys) {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item || !Object.hasOwn(item, 'value')) fail('INVALID_ATTACHMENT_REQUEST'); result[key] = item.value;
  }
  return result;
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ATTACHMENT_REQUEST'); return value; }
function filename(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[/\\\x00-\x1f\x7f]/.test(value) || ['.', '..'].includes(value)) fail('INVALID_ATTACHMENT_REQUEST');
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fileDTO(row) {
  return {id: row.id, reviewId: row.reviewId, activityId: row.activityId, name: row.name,
    mimeType: row.mimeType, size: row.size, sha256: row.sha256, createdAt: row.createdAt};
}

// One host-owned engine is shared by browser and app transports. The verifier
// recognizes original session handles; network callers never choose a path.
function createRemoteAttachments({store, dataPath, authorize, onCommitted = () => {}, clock = Date.now}) {
  if (!store || typeof store.transaction !== 'function' || store.inTransaction ||
      typeof dataPath !== 'string' || !path.isAbsolute(dataPath) ||
      [authorize, onCommitted, clock].some(value => typeof value !== 'function')) fail('ATTACHMENTS_UNAVAILABLE');
  const root = path.join(dataPath, 'attachments'), staging = path.join(dataPath, 'remote-attachment-uploads');
  function ownedDirectory(directory) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('ATTACHMENTS_UNAVAILABLE');
  }
  ownedDirectory(root); ownedDirectory(staging);
  const ownerKey = fs.realpathSync(staging);
  if (owners.has(ownerKey)) fail('ATTACHMENTS_UNAVAILABLE');
  const uploads = new Map(), verifiedFiles = new Map(); let closed = false;
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail('ATTACHMENTS_UNAVAILABLE'); return value; };
  store.transaction(() => store.db.exec(`
    CREATE TABLE IF NOT EXISTS remote_attachment_pending (
      uploadId TEXT PRIMARY KEY, stageName TEXT NOT NULL, storageName TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS remote_attachment_receipts (
      epoch TEXT NOT NULL,principalId TEXT NOT NULL,requestId TEXT NOT NULL,uploadId TEXT NOT NULL UNIQUE,
      projectId TEXT NOT NULL,projectBirth INTEGER NOT NULL,reviewId TEXT NOT NULL,reviewGeneration INTEGER NOT NULL,
      intentSHA256 TEXT NOT NULL,acknowledgementJson TEXT NOT NULL,
      PRIMARY KEY(epoch,principalId,requestId)
    ) WITHOUT ROWID;
  `));
  function stagePath(name) { if (typeof name !== 'string' || !/^[a-f0-9-]{36}\.part$/.test(name) || !UUID.test(name.slice(0, 36))) fail('ATTACHMENTS_UNAVAILABLE'); return path.join(staging, name); }
  function finalPath(name) { if (typeof name !== 'string' || !/^[a-f0-9-]{36}(?:\.[a-zA-Z0-9]{1,12})?$/.test(name) || !UUID.test(name.slice(0, 36))) fail('ATTACHMENTS_UNAVAILABLE'); return path.join(root, name); }
  function unlink(file) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  function syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  // A crash between physical publication and SQLite commit leaves this small
  // journal. Never remove bytes referenced by committed attachment metadata.
  for (const row of store.db.prepare('SELECT * FROM remote_attachment_pending').all()) {
    const temporary = stagePath(row.stageName), published = finalPath(row.storageName);
    unlink(temporary);
    if (!store.db.prepare('SELECT 1 FROM attachments WHERE storageName=?').get(row.storageName)) unlink(published);
    store.transaction(() => store.db.prepare('DELETE FROM remote_attachment_pending WHERE uploadId=?').run(row.uploadId));
  }
  for (const entry of fs.readdirSync(staging)) if (/^[a-f0-9-]{36}\.part$/.test(entry) && UUID.test(entry.slice(0, 36))) unlink(stagePath(entry));
  owners.set(ownerKey, uploads);
  function available() { if (closed || owners.get(ownerKey) !== uploads) fail('ATTACHMENTS_UNAVAILABLE'); }
  function caller(owner, scope, write) {
    if (!owner || !['object', 'function'].includes(typeof owner)) fail('ACCESS_DENIED');
    let value;
    try { value = fields(authorize(owner, Object.freeze({projectId: scope.projectId, reviewId: scope.reviewId, write})), ['principalId']); }
    catch { fail('ACCESS_DENIED'); }
    if (typeof value.principalId !== 'string' || !ID.test(value.principalId)) fail('ACCESS_DENIED');
    return value.principalId;
  }
  function binding(scope, expected = null) {
    const epoch = store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get()?.epoch;
    if (scope.epoch !== undefined && scope.epoch !== epoch) fail('STALE_EPOCH');
    const birth = store.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(scope.projectId)?.birth;
    const review = store.db.prepare(`SELECT r.projectId,v.revision,v.generation,v.deleted FROM reviews r
      JOIN review_revisions v ON v.reviewId=r.id WHERE r.id=?`).get(scope.reviewId);
    if (!birth || !review || review.deleted || review.projectId !== scope.projectId ||
        expected && (birth !== expected.projectBirth || review.generation !== expected.reviewGeneration)) fail('NOT_FOUND');
    let activityFingerprint = null;
    if (scope.activityId) {
      const activity = store.db.prepare("SELECT rowid,id,reviewId,type,role,agentRunId,body,createdAt,updatedAt FROM activities WHERE id=? AND reviewId=? AND type='comment' AND role='user' AND agentRunId=''")
        .get(scope.activityId, scope.reviewId);
      if (!activity) fail('NOT_FOUND'); activityFingerprint = digest(activity);
      if (expected?.activityFingerprint && activityFingerprint !== expected.activityFingerprint) fail('STALE_REVIEW');
    }
    return {epoch, projectBirth: birth, reviewGeneration: review.generation, revision: review.revision, activityFingerprint};
  }
  function checkUpload(record, revision = false) {
    available();
    const principal = caller(record.owner, record.input, true);
    if (principal !== record.principalId || uploads.get(record.uploadId) !== record) fail('ACCESS_DENIED');
    store.assertAttachmentWriteAdmission(record.admission);
    const current = binding(record.input, record);
    if (record.expiresAt <= now()) fail('UPLOAD_EXPIRED');
    if (revision && current.revision !== record.input.expectedRevision) fail('REVISION_CONFLICT');
  }
  function remove(record, published = false) {
    clearTimeout(record.timer); uploads.delete(record.uploadId);
    if (record.fd !== null) { fs.closeSync(record.fd); record.fd = null; }
    unlink(stagePath(record.stageName));
    if (published && !store.db.prepare('SELECT 1 FROM attachments WHERE storageName=?').get(record.storageName)) unlink(finalPath(record.storageName));
    store.transaction(() => store.db.prepare('DELETE FROM remote_attachment_pending WHERE uploadId=?').run(record.uploadId));
  }
  function original(owner, uploadId) {
    id(uploadId); const record = uploads.get(uploadId);
    if (!record || record.owner !== owner) fail('ACCESS_DENIED'); return record;
  }
  function metadata(owner, input) {
    const scope = fields(input, ['projectId', 'reviewId', 'attachmentId']); id(scope.projectId); id(scope.reviewId); id(scope.attachmentId);
    return store.transaction(() => {
      caller(owner, scope, false); const current = binding(scope);
      const row = store.db.prepare(`SELECT a.* FROM attachments a WHERE a.id=? AND a.reviewId=? AND
        (a.activityId IS NULL OR EXISTS(SELECT 1 FROM activities c WHERE c.id=a.activityId AND c.reviewId=a.reviewId AND NOT(c.role='user' AND c.agentRunId!='')))`)
        .get(scope.attachmentId, scope.reviewId);
      if (!row) fail('NOT_FOUND');
      filename(row.name);
      if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > LIMITS.fileBytes || typeof row.sha256 !== 'string' || !HEX.test(row.sha256)) fail('ATTACHMENT_TOO_LARGE');
      return {scope, row, current};
    });
  }
  function readChunk(owner, input) {
    available(); const query = fields(input, ['projectId', 'reviewId', 'attachmentId', 'offset']);
    if (!Number.isSafeInteger(query.offset) || query.offset < 0) fail('INVALID_ATTACHMENT_REQUEST');
    const {scope, row, current} = metadata(owner, {projectId: query.projectId, reviewId: query.reviewId, attachmentId: query.attachmentId});
    if (query.offset > row.size) fail('INVALID_ATTACHMENT_REQUEST');
    const file = path.join(root, filename(row.storageName)); let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const before = fs.fstatSync(fd), named = fs.lstatSync(file);
      if (!before.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || before.size !== row.size) fail('ATTACHMENT_CHANGED');
      const stamp = fs.fstatSync(fd, {bigint: true});
      const signature = JSON.stringify([row.storageName, row.sha256, ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stamp[key]))]);
      // Hash once for a stable physical file. Later chunks keep their bounded
      // read size; clients must still verify the assembled file's final hash.
      if (verifiedFiles.get(row.id) !== signature) {
        const hash = createHash('sha256'), buffer = Buffer.alloc(LIMITS.chunkBytes); let position = 0;
        while (position < row.size) {
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, row.size - position), position);
          if (!count) fail('ATTACHMENT_CHANGED'); hash.update(buffer.subarray(0, count)); position += count;
        }
        if (hash.digest('hex') !== row.sha256) fail('ATTACHMENT_CHANGED');
      }
      const bytes = Buffer.alloc(Math.min(LIMITS.chunkBytes, row.size - query.offset));
      const read = fs.readSync(fd, bytes, 0, bytes.length, query.offset);
      const after = fs.fstatSync(fd), final = fs.lstatSync(file);
      const finalStamp = fs.fstatSync(fd, {bigint: true});
      if (read !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => finalStamp[key] !== stamp[key]) ||
          final.isSymbolicLink() || final.dev !== before.dev || final.ino !== before.ino) fail('ATTACHMENT_CHANGED');
      if (verifiedFiles.size >= 128 && !verifiedFiles.has(row.id)) verifiedFiles.delete(verifiedFiles.keys().next().value);
      verifiedFiles.set(row.id, signature);
      store.transaction(() => {
        caller(owner, scope, false); binding({...scope, epoch: current.epoch}, current);
        const latest = metadata(owner, scope).row;
        if (['id', 'reviewId', 'activityId', 'name', 'mimeType', 'storageName', 'size', 'sha256', 'createdAt'].some(key => latest[key] !== row[key])) fail('ATTACHMENT_CHANGED');
      });
      return {version: 1, attachment: fileDTO(row), offset: query.offset, nextOffset: query.offset + read,
        data: bytes.toString('base64'), complete: query.offset + read === row.size};
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function beginUpload(owner, input) {
    available();
    const value = fields(input, ['requestId', 'projectId', 'reviewId', 'activityId', 'epoch', 'expectedRevision', 'name', 'mimeType', 'size', 'sha256']);
    id(value.requestId); id(value.projectId); id(value.reviewId); if (value.activityId !== null) id(value.activityId);
    filename(value.name);
    if (typeof value.epoch !== 'string' || !UUID.test(value.epoch) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 ||
        typeof value.mimeType !== 'string' || value.mimeType.length > 255 || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(value.mimeType) ||
        !Number.isSafeInteger(value.size) || value.size < 0 || value.size > LIMITS.fileBytes || typeof value.sha256 !== 'string' || !HEX.test(value.sha256)) fail('INVALID_ATTACHMENT_REQUEST');
    const intentSHA256 = digest(value);
    const captured = store.transaction(() => {
      const principalId = caller(owner, value, true), current = binding(value);
      const receipt = store.db.prepare('SELECT * FROM remote_attachment_receipts WHERE epoch=? AND principalId=? AND requestId=?').get(value.epoch, principalId, value.requestId);
      if (receipt) {
        if (receipt.intentSHA256 !== intentSHA256) fail('IDEMPOTENCY_CONFLICT'); binding(value, receipt);
        return {receipt: JSON.parse(receipt.acknowledgementJson)};
      }
      if (current.revision !== value.expectedRevision) fail('REVISION_CONFLICT');
      if (store.db.prepare('SELECT COUNT(*) AS count FROM remote_attachment_receipts WHERE epoch=?').get(value.epoch).count >= 100000) fail('UPLOAD_LIMIT');
      return {principalId, ...current, admission: store.captureAttachmentWriteAdmission(store.captureWriteAdmission(), {projectId: value.projectId, reviewId: value.reviewId})};
    });
    if (captured.receipt) return captured.receipt;
    for (const record of uploads.values()) if (record.principalId === captured.principalId && record.input.epoch === value.epoch && record.input.requestId === value.requestId) {
      if (record.owner !== owner || record.intentSHA256 !== intentSHA256) fail('IDEMPOTENCY_CONFLICT');
      try { checkUpload(record, true); } catch (error) { remove(record); throw error; }
      return {version: 1, state: 'uploading', uploadId: record.uploadId, received: record.received, size: value.size, expiresAt: record.expiresAt};
    }
    if (uploads.size >= LIMITS.uploads || [...uploads.values()].filter(row => row.owner === owner).length >= LIMITS.ownerUploads ||
        [...uploads.values()].reduce((size, row) => size + row.input.size, value.size) > LIMITS.pendingBytes) fail('UPLOAD_LIMIT');
    const uploadId = randomUUID(), stageName = uploadId + '.part', suffix = path.extname(value.name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 13);
    const extension = /^\.[a-zA-Z0-9]{1,12}$/.test(suffix) ? suffix : '';
    const record = {owner, input: Object.freeze(value), uploadId, stageName, storageName: randomUUID() + extension,
      ...captured, intentSHA256, received: 0, fd: null, expiresAt: now() + LIMITS.lifetimeMs, timer: null};
    store.transaction(() => store.db.prepare('INSERT INTO remote_attachment_pending(uploadId,stageName,storageName) VALUES(?,?,?)').run(uploadId, stageName, record.storageName));
    try {
      record.fd = fs.openSync(stagePath(stageName), 'wx+', 0o600); uploads.set(uploadId, record);
      record.timer = setTimeout(() => { try { remove(record); } catch {} }, LIMITS.lifetimeMs); record.timer.unref();
      return {version: 1, state: 'uploading', uploadId, received: 0, size: value.size, expiresAt: record.expiresAt};
    } catch (error) { remove(record); throw error; }
  }
  function writeChunk(owner, input) {
    available(); const value = fields(input, ['uploadId', 'offset', 'data']), record = original(owner, value.uploadId);
    try {
      checkUpload(record, true);
      if (!Number.isSafeInteger(value.offset) || value.offset < 0 || typeof value.data !== 'string' || value.data.length > Math.ceil(LIMITS.chunkBytes / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) fail('INVALID_ATTACHMENT_REQUEST');
      const bytes = Buffer.from(value.data, 'base64');
      if (!bytes.length || bytes.length > LIMITS.chunkBytes || bytes.toString('base64') !== value.data || value.offset > record.received || value.offset + bytes.length > record.input.size) fail('INVALID_ATTACHMENT_REQUEST');
      if (value.offset < record.received) {
        if (value.offset + bytes.length > record.received) fail('CHUNK_CONFLICT');
        const prior = Buffer.alloc(bytes.length); fs.readSync(record.fd, prior, 0, prior.length, value.offset);
        if (!prior.equals(bytes)) fail('CHUNK_CONFLICT');
      } else {
        let written = 0;
        while (written < bytes.length) written += fs.writeSync(record.fd, bytes, written, bytes.length - written, record.received + written);
        record.received += bytes.length;
      }
      checkUpload(record, true);
      return {version: 1, uploadId: record.uploadId, received: record.received, size: record.input.size};
    } catch (error) { remove(record); throw error; }
  }
  function receiptByUpload(owner, uploadId) {
    return store.transaction(() => {
      const row = store.db.prepare('SELECT * FROM remote_attachment_receipts WHERE uploadId=?').get(uploadId);
      if (!row || caller(owner, row, true) !== row.principalId) fail('ACCESS_DENIED'); binding(row, row);
      return JSON.parse(row.acknowledgementJson);
    });
  }
  function commitUpload(owner, input) {
    available(); const {uploadId} = fields(input, ['uploadId']); id(uploadId);
    if (!uploads.has(uploadId)) return receiptByUpload(owner, uploadId);
    const record = original(owner, uploadId); let published = false, committed = false, acknowledgement;
    try {
      checkUpload(record, true);
      if (record.received !== record.input.size) fail('UPLOAD_INCOMPLETE');
      const hash = createHash('sha256'), bytes = Buffer.alloc(LIMITS.chunkBytes); let offset = 0;
      while (offset < record.received) { const count = fs.readSync(record.fd, bytes, 0, Math.min(bytes.length, record.received - offset), offset); if (!count) fail('HASH_MISMATCH'); hash.update(bytes.subarray(0, count)); offset += count; }
      if (hash.digest('hex') !== record.input.sha256) fail('HASH_MISMATCH');
      fs.fsyncSync(record.fd); fs.closeSync(record.fd); record.fd = null;
      acknowledgement = store.transaction(() => {
        checkUpload(record, true);
        fs.linkSync(stagePath(record.stageName), finalPath(record.storageName)); published = true;
        syncDirectory(root);
        const attachment = store.addAttachment({reviewId: record.input.reviewId, activityId: record.input.activityId,
          name: record.input.name, mimeType: record.input.mimeType, size: record.input.size, sha256: record.input.sha256, storageName: record.storageName});
        const revision = store.db.prepare('SELECT revision FROM review_revisions WHERE reviewId=?').get(record.input.reviewId).revision;
        const result = {version: 1, state: 'committed', uploadId, requestId: record.input.requestId,
          projectId: record.input.projectId, reviewId: record.input.reviewId, attachment: fileDTO(attachment), revision};
        store.db.prepare(`INSERT INTO remote_attachment_receipts(epoch,principalId,requestId,uploadId,projectId,projectBirth,reviewId,reviewGeneration,intentSHA256,acknowledgementJson)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(record.input.epoch, record.principalId, record.input.requestId, uploadId,
          record.input.projectId, record.projectBirth, record.input.reviewId, record.reviewGeneration, record.intentSHA256, JSON.stringify(result));
        store.db.prepare('DELETE FROM remote_attachment_pending WHERE uploadId=?').run(uploadId);
        return result;
      });
      committed = true;
      let cleanupFailure;
      try { remove(record); } catch (error) { cleanupFailure = error; }
      try { onCommitted(Object.freeze({operation: 'attachment.add', projectId: record.input.projectId, reviewId: record.input.reviewId})); }
      catch (notificationFailure) {
        if (cleanupFailure) throw new AggregateError([cleanupFailure, notificationFailure], 'Attachment cleanup and notification failed.', {cause: cleanupFailure});
        throw notificationFailure;
      }
      if (cleanupFailure) throw cleanupFailure;
      return acknowledgement;
    } catch (error) { if (!committed) remove(record, published); throw error; }
  }
  return Object.freeze({
    describe(owner, input) { available(); return fileDTO(metadata(owner, input).row); }, readChunk, beginUpload, writeChunk, commitUpload,
    result(owner, input) {
      available(); const query = fields(input, ['requestId', 'projectId', 'reviewId', 'epoch']);
      id(query.requestId); id(query.projectId); id(query.reviewId); if (typeof query.epoch !== 'string' || !UUID.test(query.epoch)) fail('INVALID_ATTACHMENT_REQUEST');
      return store.transaction(() => {
        const principal = caller(owner, query, true); binding(query);
        const row = store.db.prepare('SELECT * FROM remote_attachment_receipts WHERE epoch=? AND principalId=? AND requestId=?').get(query.epoch, principal, query.requestId);
        if (!row || row.projectId !== query.projectId || row.reviewId !== query.reviewId) fail('NOT_FOUND'); binding(query, row);
        return JSON.parse(row.acknowledgementJson);
      });
    },
    discardUpload(owner, input) { available(); const {uploadId} = fields(input, ['uploadId']); remove(original(owner, uploadId)); return {discarded: true}; },
    revokeOwner(owner) { available(); let discarded = 0; for (const record of uploads.values()) if (record.owner === owner) { remove(record); discarded++; } return {discarded}; },
    close() { if (closed) return; for (const record of uploads.values()) remove(record); verifiedFiles.clear(); closed = true; if (owners.get(ownerKey) === uploads) owners.delete(ownerKey); }
  });
}

module.exports = {createRemoteAttachments, REMOTE_ATTACHMENT_LIMITS: LIMITS};
