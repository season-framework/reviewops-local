'use strict';

const {randomUUID, createHash} = require('node:crypto');

const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_RECEIPTS = 100000;
const writeAdmissions = new WeakMap();
const reviewWriteAdmissions = new WeakMap();
const reviewSnapshotRevisions = new WeakMap();
const attachmentWriteAdmissions = new WeakMap();
const OPERATION = 'review.status.set';
const STATUSES = new Set(['open', 'in_progress', 'in_review', 'resolved', 'recheck', 'closed']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MESSAGES = Object.freeze({
  INVALID_COMMAND: 'Invalid review status command.',
  ACCESS_DENIED: 'A current application-owned write grant is required.',
  NOT_FOUND: 'Shared resource not found.',
  STALE_EPOCH: 'The dataset changed. Resynchronize before writing.',
  REVISION_CONFLICT: 'The review changed. Reconcile before writing.',
  IDEMPOTENCY_CONFLICT: 'The command identity already has a different intent.',
  RECEIPT_LIMIT: 'The active dataset command receipt limit was reached.',
  INVALID_CONSISTENCY_STATE: 'Durable review consistency state is unavailable.',
  INVALID_WRITE_ADMISSION: 'An original application-owned write admission is required.',
  INVALID_REVIEW_ADMISSION: 'An original application-owned review admission is required.',
  STALE_REVIEW: 'The original review was replaced or moved. Resynchronize before writing.'
});
function fail(code, extra) { throw Object.assign(new Error(MESSAGES[code]), {code, ...extra}); }
function closed(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
  return value;
}
function identifier(value, code) { if (typeof value !== 'string' || !ID.test(value)) fail(code); }
function revision(value, code) { if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REVISION) fail(code); }
function currentEpoch(db) {
  const row = db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get();
  if (!row || !EPOCH.test(row.epoch)) fail('INVALID_CONSISTENCY_STATE');
  return row.epoch;
}
function caller(provider) {
  if (typeof provider !== 'function') fail('ACCESS_DENIED');
  const value = closed(provider(), ['principalId', 'projectGrants'], 'ACCESS_DENIED');
  identifier(value.principalId, 'ACCESS_DENIED');
  if (!Array.isArray(value.projectGrants) || value.projectGrants.length > 100000) fail('ACCESS_DENIED');
  const projects = new Set();
  for (const grant of value.projectGrants) {
    closed(grant, ['projectId', 'write'], 'ACCESS_DENIED'); identifier(grant.projectId, 'ACCESS_DENIED');
    if (grant.write !== true || projects.has(grant.projectId)) fail('ACCESS_DENIED');
    projects.add(grant.projectId);
  }
  return {principalId: value.principalId, projects};
}
function scopedReview(db, context, intent) {
  if (!context.projects.has(intent.projectId)) fail('NOT_FOUND');
  const row = db.prepare('SELECT id,projectId,status FROM reviews WHERE id=? AND projectId=?').get(intent.reviewId, intent.projectId);
  if (!row) fail('NOT_FOUND');
  return row;
}
function currentRevision(db, reviewId) {
  const row = db.prepare('SELECT revision,generation,deleted FROM review_revisions WHERE reviewId=?').get(reviewId);
  if (!row || row.deleted !== 0) fail('INVALID_CONSISTENCY_STATE');
  revision(row.revision, 'INVALID_CONSISTENCY_STATE'); revision(row.generation, 'INVALID_CONSISTENCY_STATE');
  if (row.generation > row.revision) fail('INVALID_CONSISTENCY_STATE');
  return row.revision;
}
function target(value, command) {
  closed(value, command ? ['requestId', 'projectId', 'reviewId', 'epoch', 'expectedRevision', 'status'] : ['projectId', 'reviewId'], 'INVALID_COMMAND');
  identifier(value.projectId, 'INVALID_COMMAND'); identifier(value.reviewId, 'INVALID_COMMAND');
  if (command) {
    identifier(value.requestId, 'INVALID_COMMAND');
    if (typeof value.epoch !== 'string' || !EPOCH.test(value.epoch) || !STATUSES.has(value.status)) fail('INVALID_COMMAND');
    revision(value.expectedRevision, 'INVALID_COMMAND');
  }
  return {...value};
}
function intentDigest(intent) {
  return createHash('sha256').update(JSON.stringify([1, OPERATION, intent.requestId, intent.projectId,
    intent.reviewId, intent.epoch, intent.expectedRevision, intent.status])).digest('hex');
}
function acknowledgement(json, intent, committedRevision) {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 4096) fail('INVALID_CONSISTENCY_STATE');
  let value; try { value = JSON.parse(json); } catch { fail('INVALID_CONSISTENCY_STATE'); }
  closed(value, ['version', 'operation', 'requestId', 'projectId', 'reviewId', 'epoch', 'status', 'revision', 'changed', 'committedAt'], 'INVALID_CONSISTENCY_STATE');
  if (value.version !== 1 || value.operation !== OPERATION || typeof value.changed !== 'boolean' ||
      typeof value.committedAt !== 'string' || !Number.isFinite(Date.parse(value.committedAt))) fail('INVALID_CONSISTENCY_STATE');
  for (const key of ['requestId', 'projectId', 'reviewId', 'epoch', 'status']) if (value[key] !== intent[key]) fail('INVALID_CONSISTENCY_STATE');
  revision(value.revision, 'INVALID_CONSISTENCY_STATE');
  if (value.revision !== committedRevision) fail('INVALID_CONSISTENCY_STATE');
  return value;
}

function reseed(db) {
  db.exec('DELETE FROM review_revisions; INSERT INTO review_revisions(reviewId,revision,generation,deleted) SELECT id,1,1,0 FROM reviews;');
}
function migrate(db) {
  db.exec(`
    CREATE TABLE dataset_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL CHECK(length(epoch)=36));
    CREATE TABLE review_revisions (
      reviewId TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND ${MAX_REVISION}),
      generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND ${MAX_REVISION} AND generation<=revision),
      deleted INTEGER NOT NULL CHECK(deleted IN (0,1))
    );
    CREATE TABLE command_receipts (
      epoch TEXT NOT NULL, principalId TEXT NOT NULL, requestId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation='${OPERATION}'), intentVersion INTEGER NOT NULL CHECK(intentVersion=1),
      projectId TEXT NOT NULL, reviewId TEXT NOT NULL, intentSHA256 TEXT NOT NULL CHECK(length(intentSHA256)=64),
      acknowledgementJson TEXT NOT NULL CHECK(length(CAST(acknowledgementJson AS BLOB))<=4096),
      committedRevision INTEGER NOT NULL CHECK(typeof(committedRevision)='integer' AND committedRevision BETWEEN 1 AND ${MAX_REVISION}),
      committedAt TEXT NOT NULL, PRIMARY KEY(epoch,principalId,requestId)
    ) WITHOUT ROWID;
    CREATE TRIGGER shared_receipt_no_update BEFORE UPDATE ON command_receipts
    BEGIN SELECT RAISE(ABORT,'Command receipts are immutable.'); END;
    CREATE TRIGGER shared_receipt_no_active_delete BEFORE DELETE ON command_receipts
    WHEN OLD.epoch=(SELECT epoch FROM dataset_meta WHERE singleton=1)
    BEGIN SELECT RAISE(ABORT,'Active command receipts cannot be retired.'); END;
    CREATE TRIGGER shared_receipt_current_epoch BEFORE INSERT ON command_receipts
    WHEN NEW.epoch!=(SELECT epoch FROM dataset_meta WHERE singleton=1)
    BEGIN SELECT RAISE(ABORT,'Command receipt epoch is not current.'); END;
  `);
  db.prepare('INSERT INTO dataset_meta(singleton,epoch) VALUES(1,?)').run(randomUUID()); reseed(db);
  const bump = owner => `
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM review_revisions WHERE reviewId=${owner}) THEN RAISE(ABORT,'Review revision is missing.') END;
    UPDATE review_revisions SET revision=revision+1 WHERE reviewId=${owner};`;
  db.exec(`
    CREATE TRIGGER shared_review_insert AFTER INSERT ON reviews BEGIN
      INSERT INTO review_revisions(reviewId,revision,generation,deleted) VALUES(NEW.id,1,1,0)
      ON CONFLICT(reviewId) DO UPDATE SET revision=revision+1,generation=revision+1,deleted=0;
    END;
    CREATE TRIGGER shared_review_update AFTER UPDATE ON reviews BEGIN
      ${bump('OLD.id')}
      UPDATE review_revisions SET deleted=CASE WHEN OLD.id=NEW.id THEN 0 ELSE 1 END WHERE reviewId=OLD.id;
      INSERT INTO review_revisions(reviewId,revision,generation,deleted) SELECT NEW.id,1,1,0 WHERE NEW.id!=OLD.id
      ON CONFLICT(reviewId) DO UPDATE SET revision=revision+1,generation=revision+1,deleted=0;
    END;
    CREATE TRIGGER shared_review_delete BEFORE DELETE ON reviews BEGIN
      ${bump('OLD.id')}
      UPDATE review_revisions SET deleted=1 WHERE reviewId=OLD.id;
    END;
  `);
  // Child cascades only increment the existing sidecar: they never revive a tombstone.
  for (const table of ['activities', 'attachments', 'agent_runs', 'agent_requests']) db.exec(`
    CREATE TRIGGER shared_${table}_insert AFTER INSERT ON ${table} BEGIN ${bump('NEW.reviewId')} END;
    CREATE TRIGGER shared_${table}_delete AFTER DELETE ON ${table} BEGIN ${bump('OLD.reviewId')} END;
    CREATE TRIGGER shared_${table}_update AFTER UPDATE ON ${table} BEGIN
      ${bump('OLD.reviewId')}
      SELECT CASE WHEN NEW.reviewId!=OLD.reviewId AND NOT EXISTS(SELECT 1 FROM review_revisions WHERE reviewId=NEW.reviewId) THEN RAISE(ABORT,'Review revision is missing.') END;
      UPDATE review_revisions SET revision=revision+1 WHERE reviewId=NEW.reviewId AND NEW.reviewId!=OLD.reviewId;
    END;
  `);
}
function beginLogicalImport(db) {
  // Reset the old graph's counters before deletes, so exhausted old revisions cannot prevent a new epoch.
  const previous = currentEpoch(db), next = randomUUID();
  if (previous === next) fail('INVALID_CONSISTENCY_STATE');
  db.prepare('UPDATE dataset_meta SET epoch=? WHERE singleton=1').run(next);
  db.exec('DELETE FROM command_receipts;'); reseed(db);
}
function finishLogicalImport(db) { currentEpoch(db); reseed(db); }
// Admissions are process-local capabilities, not payload fields or write grants.
function captureWriteAdmission(store) {
  return store.transaction(() => {
    const admission = Object.freeze(Object.create(null));
    writeAdmissions.set(admission, {store, epoch: currentEpoch(store.db)});
    return admission;
  });
}
function assertWriteAdmission(store, admission) {
  return store.transaction(() => {
    const original = writeAdmissions.get(admission);
    if (!original || original.store !== store) fail('INVALID_WRITE_ADMISSION');
    if (original.epoch !== currentEpoch(store.db)) fail('STALE_EPOCH');
  });
}
// A process-local incarnation token is not a renderer revision or a write grant.
function reviewBinding(store, scope) {
  const row=store.db.prepare('SELECT r.projectId,r.serviceId,v.generation,v.deleted FROM reviews r JOIN review_revisions v ON v.reviewId=r.id WHERE r.id=?').get(scope.reviewId);
  if(!row||row.deleted!==0||row.projectId!==scope.projectId||row.serviceId!==scope.serviceId)fail('STALE_REVIEW');
  currentRevision(store.db,scope.reviewId);
  if(scope.serviceId!==null&&!store.db.prepare('SELECT 1 FROM project_services WHERE projectId=? AND serviceId=?').get(scope.projectId,scope.serviceId))fail('STALE_REVIEW');
  return row.generation;
}
function captureReviewWriteAdmission(store, admission, input) {
  const scope=closed(input,['reviewId','projectId','serviceId'],'INVALID_REVIEW_ADMISSION');
  identifier(scope.reviewId,'INVALID_REVIEW_ADMISSION');identifier(scope.projectId,'INVALID_REVIEW_ADMISSION');
  if(scope.serviceId!==null)identifier(scope.serviceId,'INVALID_REVIEW_ADMISSION');
  return store.transaction(()=>{
    assertWriteAdmission(store,admission);
    const original={store,admission,reviewId:scope.reviewId,projectId:scope.projectId,serviceId:scope.serviceId};
    original.generation=reviewBinding(store,original);
    const token=Object.freeze(Object.create(null));reviewWriteAdmissions.set(token,original);return token;
  });
}
function assertReviewWriteAdmission(store, token) {
  return store.transaction(()=>{
    const original=reviewWriteAdmissions.get(token);
    if(!original||original.store!==store)fail('INVALID_REVIEW_ADMISSION');
    assertWriteAdmission(store,original.admission);
    if(reviewBinding(store,original)!==original.generation)fail('STALE_REVIEW');
  });
}
// An attachment belongs to its original review/project, not a selected service
// or a fixed history revision. Keep this capability separate from agent tokens.
function attachmentReviewGeneration(store, original) {
  const row=store.db.prepare('SELECT r.projectId,v.generation,v.deleted FROM reviews r JOIN review_revisions v ON v.reviewId=r.id WHERE r.id=?').get(original.reviewId);
  if(!row||row.deleted!==0||row.projectId!==original.projectId)fail('STALE_REVIEW');
  currentRevision(store.db,original.reviewId);
  return row.generation;
}
function captureAttachmentWriteAdmission(store, admission, input) {
  const scope=closed(input,['reviewId','projectId'],'INVALID_REVIEW_ADMISSION');
  identifier(scope.reviewId,'INVALID_REVIEW_ADMISSION');identifier(scope.projectId,'INVALID_REVIEW_ADMISSION');
  return store.transaction(()=>{
    assertWriteAdmission(store,admission);
    const original={store,admission,reviewId:scope.reviewId,projectId:scope.projectId};
    original.generation=attachmentReviewGeneration(store,original);
    const token=Object.freeze(Object.create(null));attachmentWriteAdmissions.set(token,original);return token;
  });
}
function assertAttachmentWriteAdmission(store, token) {
  return store.transaction(()=>{
    const original=attachmentWriteAdmissions.get(token);
    if(!original||original.store!==store)fail('INVALID_REVIEW_ADMISSION');
    assertWriteAdmission(store,original.admission);
    if(attachmentReviewGeneration(store,original)!==original.generation)fail('STALE_REVIEW');
  });
}
// Snapshot saves retain an original aggregate revision as well as its birth and
// epoch. Ordinary running callbacks deliberately keep the less restrictive token.
function captureReviewSnapshotAdmission(store, admission, input) {
  return store.transaction(()=>{
    const token=captureReviewWriteAdmission(store,admission,input);
    reviewSnapshotRevisions.set(token,currentRevision(store.db,input.reviewId));
    return token;
  });
}
function assertReviewSnapshotAdmission(store, token) {
  return store.transaction(()=>{
    if(!reviewSnapshotRevisions.has(token))fail('INVALID_REVIEW_ADMISSION');
    assertReviewWriteAdmission(store,token);
    const original=reviewWriteAdmissions.get(token);
    if(currentRevision(store.db,original.reviewId)!==reviewSnapshotRevisions.get(token))fail('REVISION_CONFLICT');
  });
}
// An accepted callback may save only its original run/history after the next
// selected service changes. The original review birth/project and service link
// must still exist; this never grants a new launch or detached persistence.
function assertRunningReviewCallback(store, token) {
  return store.transaction(()=>{
    const original=reviewWriteAdmissions.get(token);
    if(!original||original.store!==store)fail('INVALID_REVIEW_ADMISSION');
    assertWriteAdmission(store,original.admission);
    const row=store.db.prepare('SELECT r.projectId,v.generation,v.deleted FROM reviews r JOIN review_revisions v ON v.reviewId=r.id WHERE r.id=?').get(original.reviewId);
    if(original.serviceId===null||!row||row.deleted!==0||row.projectId!==original.projectId||row.generation!==original.generation)fail('STALE_REVIEW');
    currentRevision(store.db,original.reviewId);
    if(!store.db.prepare('SELECT 1 FROM project_services WHERE projectId=? AND serviceId=?').get(original.projectId,original.serviceId))fail('STALE_REVIEW');
  });
}
// Only explicit cancellation maintenance may use an originally linked token
// after that project detached its service. Normal callback admission stays strict.
function assertDetachedReviewCancellation(store, token) {
  return store.transaction(()=>{
    const original=reviewWriteAdmissions.get(token);
    if(!original||original.store!==store)fail('INVALID_REVIEW_ADMISSION');
    assertWriteAdmission(store,original.admission);
    const row=store.db.prepare('SELECT r.projectId,r.serviceId,v.generation,v.deleted FROM reviews r JOIN review_revisions v ON v.reviewId=r.id WHERE r.id=?').get(original.reviewId);
    if(original.serviceId===null||!row||row.deleted!==0||row.projectId!==original.projectId||row.generation!==original.generation)fail('STALE_REVIEW');
    currentRevision(store.db,original.reviewId);
    if(store.db.prepare('SELECT 1 FROM project_services WHERE projectId=? AND serviceId=?').get(original.projectId,original.serviceId))fail('STALE_REVIEW');
    // A different next selection is valid only while it remains in this project.
    if(row.serviceId!==null&&!store.db.prepare('SELECT 1 FROM project_services WHERE projectId=? AND serviceId=?').get(original.projectId,row.serviceId))fail('STALE_REVIEW');
  });
}
function readState(store, input, provider) {
  const intent = target(input, false);
  return store.transaction(() => {
    const context = caller(provider), review = scopedReview(store.db, context, intent);
    return {version: 1, epoch: currentEpoch(store.db), projectId: review.projectId, reviewId: review.id,
      revision: currentRevision(store.db, review.id), status: review.status};
  });
}
function setStatus(store, input, provider) {
  const intent = target(input, true);
  return store.transaction(() => {
    const db = store.db, context = caller(provider), review = scopedReview(db, context, intent), epoch = currentEpoch(db);
    if (intent.epoch !== epoch) fail('STALE_EPOCH');
    const digest = intentDigest(intent);
    const previous = db.prepare('SELECT * FROM command_receipts WHERE epoch=? AND principalId=? AND requestId=?').get(epoch, context.principalId, intent.requestId);
    if (previous) {
      if (previous.operation !== OPERATION || previous.intentVersion !== 1 || previous.projectId !== intent.projectId || previous.reviewId !== intent.reviewId) fail('IDEMPOTENCY_CONFLICT');
      currentRevision(db, review.id);
      const generation = db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(review.id).generation;
      if (previous.committedRevision < generation) fail('NOT_FOUND');
      if (previous.intentSHA256 !== digest) fail('IDEMPOTENCY_CONFLICT');
      return acknowledgement(previous.acknowledgementJson, intent, previous.committedRevision);
    }
    const observed = currentRevision(db, review.id);
    if (observed !== intent.expectedRevision) fail('REVISION_CONFLICT', {currentRevision: observed});
    if (db.prepare('SELECT COUNT(*) AS count FROM command_receipts WHERE epoch=?').get(epoch).count >= MAX_RECEIPTS) fail('RECEIPT_LIMIT');
    const changed = review.status !== intent.status;
    if (changed) store.saveReview({id: review.id, status: intent.status});
    const committedRevision = currentRevision(db, review.id), committedAt = new Date().toISOString();
    const result = {version: 1, operation: OPERATION, requestId: intent.requestId, projectId: review.projectId,
      reviewId: review.id, epoch, status: intent.status, revision: committedRevision, changed, committedAt};
    const json = JSON.stringify(result); acknowledgement(json, intent, committedRevision);
    db.prepare(`INSERT INTO command_receipts(epoch,principalId,requestId,operation,intentVersion,projectId,reviewId,intentSHA256,acknowledgementJson,committedRevision,committedAt)
      VALUES(?,?,?,?,1,?,?,?,?,?,?)`).run(epoch, context.principalId, intent.requestId, OPERATION, intent.projectId, intent.reviewId, digest, json, committedRevision, committedAt);
    return result;
  });
}

module.exports = {migrate, beginLogicalImport, finishLogicalImport, captureWriteAdmission, assertWriteAdmission, captureReviewWriteAdmission, assertReviewWriteAdmission, captureAttachmentWriteAdmission, assertAttachmentWriteAdmission, captureReviewSnapshotAdmission, assertReviewSnapshotAdmission, assertRunningReviewCallback, assertDetachedReviewCancellation, readState, setStatus, MAX_REVISION, MAX_RECEIPTS};
