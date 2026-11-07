'use strict';

const {createHash} = require('node:crypto');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OPERATIONS = new Set(['review.create', 'review.update', 'review.status.set', 'comment.add',
  'agent.start', 'agent.followup', 'agent.followup.start', 'agent.stop']);
const STATUS = new Set(['open', 'in_progress', 'in_review', 'resolved', 'recheck', 'closed']);
const PUBLIC_ERRORS = new Set(['ACCESS_DENIED', 'NOT_FOUND', 'STALE_EPOCH', 'STALE_REVIEW',
  'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'COMMAND_LIMIT', 'EXECUTION_UNAVAILABLE', 'COMMAND_FAILED']);
function fail(code) { throw Object.assign(new Error('Remote app command could not be completed.'), {code}); }
function object(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(input))) fail('INVALID_COMMAND');
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) fail('INVALID_COMMAND');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_COMMAND');
    result[key] = descriptor.value;
  }
  return result;
}
function text(value, maximum, required = false) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || required && !value.trim()) fail('INVALID_COMMAND');
  return value;
}
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_COMMAND'); return value; }
function intent(input) {
  const row = object(input, ['operation', 'requestId', 'projectId', 'reviewId', 'epoch', 'expectedRevision', 'payload']);
  if (!OPERATIONS.has(row.operation) || typeof row.epoch !== 'string' || !EPOCH.test(row.epoch)) fail('INVALID_COMMAND');
  identifier(row.requestId); identifier(row.projectId);
  if (row.operation === 'review.create') {
    if (row.reviewId !== '' || row.expectedRevision !== 0) fail('INVALID_COMMAND');
  } else {
    identifier(row.reviewId);
    if (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1) fail('INVALID_COMMAND');
  }
  let payload;
  if (['review.create', 'review.update'].includes(row.operation)) {
    payload = object(row.payload, ['title', 'body', 'priority', 'category']);
    text(payload.title, 300, true); text(payload.body, 100000); identifier(payload.category);
    if (!['low', 'normal', 'high', 'critical'].includes(payload.priority)) fail('INVALID_COMMAND');
  } else if (row.operation === 'review.status.set') {
    payload = object(row.payload, ['status']); if (!STATUS.has(payload.status)) fail('INVALID_COMMAND');
  } else if (row.operation === 'comment.add') {
    payload = object(row.payload, ['body']); text(payload.body, 100000, true);
  } else if (['agent.start', 'agent.followup'].includes(row.operation)) {
    payload = object(row.payload, ['prompt']); text(payload.prompt, 100000, true);
  } else if (row.operation === 'agent.followup.start') {
    payload = object(row.payload, ['followupId']); identifier(payload.followupId);
  } else {
    payload = object(row.payload, ['runId']); identifier(payload.runId);
  }
  return Object.freeze({...row, payload: Object.freeze(payload)});
}
const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

// This transport owns only its receipt table. Business data, revision counters,
// host execution and backup epochs remain owned by the existing Store.
function createRemoteAppCommands({store, authorize, executeAgent, onCommitted = () => {}}) {
  if (!store || typeof store.transaction !== 'function' || typeof authorize !== 'function' ||
      typeof executeAgent !== 'function' || typeof onCommitted !== 'function' || store.inTransaction) fail('INVALID_COMMAND');
  store.transaction(() => store.db.exec(`CREATE TABLE IF NOT EXISTS remote_app_commands (
    epoch TEXT NOT NULL, principalId TEXT NOT NULL, requestId TEXT NOT NULL,
    operation TEXT NOT NULL, digest TEXT NOT NULL, projectId TEXT NOT NULL,
    projectBirth INTEGER NOT NULL, reviewId TEXT NOT NULL, reviewGeneration INTEGER NOT NULL,
    serviceId TEXT, hostRequestId TEXT NOT NULL, state TEXT NOT NULL,
    resultJson TEXT NOT NULL DEFAULT '', errorCode TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(epoch,principalId,requestId)
  ) WITHOUT ROWID;`));
  const running = new Map();
  function authority(session, projectId, operation) {
    let caller;
    try { caller = authorize(session); } catch { fail('ACCESS_DENIED'); }
    if (!caller || typeof caller.principalId !== 'string' || !ID.test(caller.principalId) ||
        !Array.isArray(caller.projectGrants)) fail('ACCESS_DENIED');
    const grant = caller.projectGrants.find(row => row?.projectId === projectId);
    const permission = operation === 'read' ? 'read' : operation.startsWith('agent.') ? 'execute' : 'write';
    if (!grant || grant.read !== true || grant[permission] !== true) fail('ACCESS_DENIED');
    return caller.principalId;
  }
  function binding(row, expected) {
    const epoch = store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get()?.epoch;
    if (epoch !== row.epoch) fail('STALE_EPOCH');
    const birth = store.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(row.projectId)?.birth;
    if (!birth || expected && birth !== expected.projectBirth) fail('NOT_FOUND');
    if (row.operation === 'review.create' && !expected) return {projectBirth: birth, reviewGeneration: 0, serviceId: null};
    const review = store.db.prepare(`SELECT r.projectId,r.serviceId,v.revision,v.generation,v.deleted
      FROM reviews r JOIN review_revisions v ON v.reviewId=r.id WHERE r.id=?`).get(expected?.reviewId || row.reviewId);
    if (!review || review.deleted || review.projectId !== row.projectId ||
        expected && review.generation !== expected.reviewGeneration) fail('NOT_FOUND');
    return {projectBirth: birth, reviewGeneration: review.generation, serviceId: review.serviceId, revision: review.revision};
  }
  function acknowledgement(row) {
    return {version: 1, operation: row.operation, requestId: row.requestId,
      projectId: row.projectId, reviewId: row.reviewId, state: row.state,
      result: row.resultJson ? JSON.parse(row.resultJson) : null, errorCode: row.errorCode};
  }
  const fetch = (epoch, principalId, requestId) => store.db.prepare(
    'SELECT * FROM remote_app_commands WHERE epoch=? AND principalId=? AND requestId=?').get(epoch, principalId, requestId);
  function complete(row, result) {
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > 8192) fail('COMMAND_FAILED');
    store.db.prepare("UPDATE remote_app_commands SET state='completed',resultJson=?,errorCode='' WHERE epoch=? AND principalId=? AND requestId=?")
      .run(json, row.epoch, row.principalId, row.requestId);
    return acknowledgement(fetch(row.epoch, row.principalId, row.requestId));
  }
  function reviewResult(reviewId) {
    const row = store.db.prepare('SELECT r.status,v.revision FROM reviews r JOIN review_revisions v ON v.reviewId=r.id WHERE r.id=?').get(reviewId);
    return {reviewId, status: row.status, revision: row.revision};
  }
  function applySynchronous(row, command) {
    if (command.operation === 'review.create') {
      const review = store.saveReview({...command.payload, projectId: command.projectId,
        serviceId: store.project(command.projectId).connection?.id || null});
      const generation = store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(review.id).generation;
      store.db.prepare('UPDATE remote_app_commands SET reviewId=?,reviewGeneration=? WHERE epoch=? AND principalId=? AND requestId=?')
        .run(review.id, generation, row.epoch, row.principalId, row.requestId);
      row = {...row, reviewId: review.id, reviewGeneration: generation};
      return {result: complete(row, reviewResult(review.id)), changed: true};
    }
    if (command.operation === 'review.status.set') {
      const result = store.setReviewStatusCommand({requestId: row.hostRequestId, projectId: command.projectId,
        reviewId: command.reviewId, epoch: command.epoch, expectedRevision: command.expectedRevision, status: command.payload.status},
      () => ({principalId: row.principalId, projectGrants: [{projectId: command.projectId, write: true}]}));
      return {result: complete(row, {reviewId: result.reviewId, status: result.status, revision: result.revision}), changed: result.changed};
    }
    if (command.operation === 'review.update') store.saveReview({id: command.reviewId, ...command.payload});
    else {
      const activity = store.addActivity({reviewId: command.reviewId, body: command.payload.body});
      return {result: complete(row, {...reviewResult(command.reviewId), activityId: activity.id}), changed: true};
    }
    return {result: complete(row, reviewResult(command.reviewId)), changed: true};
  }
  function admit(session, command) {
    return store.transaction(() => {
      const principalId = authority(session, command.projectId, command.operation);
      const previous = fetch(command.epoch, principalId, command.requestId), digest = hash(command);
      if (previous) {
        if (previous.digest !== digest) fail('IDEMPOTENCY_CONFLICT');
        binding(command, previous);
        return {row: previous, existing: true};
      }
      const current = binding(command);
      if (command.operation !== 'review.create' && current.revision !== command.expectedRevision) fail('REVISION_CONFLICT');
      if (store.db.prepare('SELECT COUNT(*) AS count FROM remote_app_commands WHERE epoch=?').get(command.epoch).count >= 100000) fail('COMMAND_LIMIT');
      const hostRequestId = hash(['remote-app-v1', command.epoch, principalId, command.requestId]);
      store.db.prepare(`INSERT INTO remote_app_commands(epoch,principalId,requestId,operation,digest,projectId,
        projectBirth,reviewId,reviewGeneration,serviceId,hostRequestId,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')`)
        .run(command.epoch, principalId, command.requestId, command.operation, digest, command.projectId,
          current.projectBirth, command.reviewId, current.reviewGeneration, current.serviceId, hostRequestId);
      const row = fetch(command.epoch, principalId, command.requestId);
      if (!command.operation.startsWith('agent.')) return {row: {...row, state: 'completed'}, ...applySynchronous(row, command)};
      return {row};
    });
  }
  async function execute(session, input) {
    // A new command owns its outer transaction. A caller's uncommitted frame
    // cannot publish a host-window notification before its own later commit.
    if (store.inTransaction) fail('INVALID_COMMAND');
    const command = intent(input), admission = admit(session, command), row = admission.row;
    if (admission.result) {
      if (admission.changed) onCommitted(Object.freeze({operation: command.operation,
        projectId: command.projectId, reviewId: admission.result.reviewId}));
      return admission.result;
    }
    if (row.state !== 'pending') return acknowledgement(row);
    const key = JSON.stringify([row.epoch, row.principalId, row.requestId]);
    if (running.has(key)) return running.get(key);
    const guard = () => store.transaction(() => {
      if (authority(session, row.projectId, row.operation) !== row.principalId) fail('ACCESS_DENIED');
      const current = binding(command, row);
      if (current.serviceId !== row.serviceId) fail('STALE_REVIEW');
      if (row.operation === 'agent.stop') {
        const run = store.get('agent_runs', command.payload.runId);
        if (run.reviewId !== row.reviewId) fail('NOT_FOUND');
      }
      if (row.operation === 'agent.followup.start') {
        const request = store.db.prepare('SELECT reviewId FROM agent_requests WHERE id=?').get(command.payload.followupId);
        if (request?.reviewId !== row.reviewId) fail('NOT_FOUND');
      }
    });
    const task = Promise.resolve().then(async () => {
      guard();
      const action = {'agent.start': 'agent.start', 'agent.followup': 'agent.request.add',
        'agent.followup.start': 'agent.request.start', 'agent.stop': 'agent.cancel'}[row.operation];
      const payload = row.operation === 'agent.stop' ? {id: command.payload.runId} :
        row.operation === 'agent.followup.start' ? {id: command.payload.followupId, reviewId: row.reviewId, projectId: row.projectId} :
          {reviewId: row.reviewId, projectId: row.projectId, requestId: row.hostRequestId, prompt: command.payload.prompt};
      // The host must carry this original guard in its write frame through
      // queueing, preflight and the final launch commit, not just call it here.
      const value = await executeAgent(action, payload, guard);
      return store.transaction(() => {
        guard();
        const result = row.operation === 'agent.followup' ?
          {followupId: identifier(value?.id), state: text(value?.state || 'waiting', 64, true)} :
          {runId: identifier(row.operation === 'agent.stop' ? command.payload.runId : value?.id),
            status: text(value?.status || (row.operation === 'agent.stop' ? 'stop_requested' : 'queued'), 64, true)};
        return complete(row, result);
      });
    }).catch(error => {
      // A denied or interrupted launch can already have a durable host run.
      // Leave the receipt pending for the same idempotent host request to be
      // resolved; never manufacture a second request ID or assert no effects.
      if (PUBLIC_ERRORS.has(error?.code)) throw error;
      fail('COMMAND_FAILED');
    }).finally(() => running.delete(key));
    running.set(key, task);
    return task;
  }
  function result(session, input) {
    const query = object(input, ['requestId', 'epoch', 'projectId']); identifier(query.requestId); identifier(query.projectId);
    if (!EPOCH.test(query.epoch)) fail('INVALID_COMMAND');
    return store.transaction(() => {
      let caller;
      try { caller = authorize(session); } catch { fail('ACCESS_DENIED'); }
      if (!caller || typeof caller.principalId !== 'string' || !ID.test(caller.principalId)) fail('ACCESS_DENIED');
      const row = fetch(query.epoch, caller?.principalId, query.requestId);
      if (!row || row.projectId !== query.projectId) fail('NOT_FOUND');
      authority(session, row.projectId, row.operation);
      binding({...row, reviewId: row.reviewId}, row);
      return acknowledgement(row);
    });
  }
  function writeState(session, input) {
    const query = object(input, ['projectId', 'reviewId']); identifier(query.projectId);
    if (query.reviewId !== '') identifier(query.reviewId);
    return store.transaction(() => {
      authority(session, query.projectId, 'read');
      const epoch = store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get()?.epoch;
      if (typeof epoch !== 'string' || !EPOCH.test(epoch) || !store.db.prepare('SELECT 1 FROM projects WHERE id=?').get(query.projectId)) fail('NOT_FOUND');
      let revision = 0, status = '';
      if (query.reviewId) {
        const row = store.db.prepare(`SELECT r.status,v.revision FROM reviews r JOIN review_revisions v ON v.reviewId=r.id
          WHERE r.id=? AND r.projectId=? AND v.deleted=0`).get(query.reviewId, query.projectId);
        if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1 || !STATUS.has(row.status)) fail('NOT_FOUND');
        revision = row.revision; status = row.status;
      }
      return {version: 1, epoch, projectId: query.projectId, reviewId: query.reviewId, revision, status};
    });
  }
  return Object.freeze({execute, result, writeState});
}

module.exports = {createRemoteAppCommands, captureRemoteAppIntent: intent};
