'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const {createStore, SCHEMA_VERSION, BACKUP_FORMAT_VERSION} = require('../electron/store.cjs');
const {MAX_REVISION, MAX_RECEIPTS} = require('../electron/shared-write-core.cjs');
const {copyReviewRecord} = require('../electron/review-copy.cjs');
const {removeWriteConsistencySchema} = require('./helpers/legacy-store-schema.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-write-core-'));
  const dbPath = path.join(root, 'owned.sqlite'), stores = [];
  const open = () => { const store = createStore({dbPath}); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, dbPath, open, store: open()};
}
function fixture(store) {
  const group = store.saveGroup({name: 'Owned consistency fixture'});
  const service = store.saveService({groupId: group.id, name: 'Owned local target', kind: 'local', rootPath: os.tmpdir()});
  const a = store.saveProject({groupId: group.id, name: 'A', serviceIds: [service.id]});
  const b = store.saveProject({groupId: group.id, name: 'B', serviceIds: [service.id]});
  const review = store.saveReview({projectId: a.id, serviceId: service.id, title: 'Synthetic review'});
  const other = store.saveReview({projectId: b.id, serviceId: service.id, title: 'Other synthetic review'});
  const provider = () => ({principalId: 'owned-worker', projectGrants: [{projectId: a.id, write: true}, {projectId: b.id, write: true}]});
  return {group, service, a, b, review, other, provider};
}
const state = (store, f, review = f.review) => store.reviewWriteState({projectId: review.projectId, reviewId: review.id}, f.provider);
const command = (store, f, extra = {}) => {
  const s = state(store, f);
  return {requestId: 'owned-command', projectId: s.projectId, reviewId: s.reviewId, epoch: s.epoch, expectedRevision: s.revision, status: 'resolved', ...extra};
};
const receipts = store => store.db.prepare('SELECT * FROM command_receipts ORDER BY epoch,principalId,requestId').all().map(row => ({...row}));
const controls = store => ({meta: {...store.db.prepare('SELECT * FROM dataset_meta').get()}, revisions: store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all().map(row => ({...row})), receipts: receipts(store)});
const unchanged = store => ({business: store.exportData(), controls: controls(store)});
const code = expected => error => error.code === expected;
function insert(db, table, row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
}
function ownedWorker(dbPath, mode, intent) {
  const argv = [path.join(__dirname, 'fixtures/shared-write-worker.cjs'), dbPath, mode, Buffer.from(JSON.stringify(intent)).toString('base64')];
  const child = spawn(process.execPath, argv, {stdio: ['pipe', 'pipe', 'pipe']});
  const output = [], errors = []; let size = 0, readyResolve, readyReject, isReady = false;
  const ready = mode === 'race' ? new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }) : Promise.resolve();
  child.stdout.on('data', value => { size += value.length; assert.ok(size <= 65536); output.push(value); if (mode === 'race' && Buffer.concat(output).toString().includes('"ready":true')) { isReady = true; readyResolve(); } });
  child.stderr.on('data', value => { assert.ok(errors.reduce((n, x) => n + x.length, 0) + value.length <= 65536); errors.push(value); });
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { if (mode === 'race' && !isReady) readyReject(error); reject(error); });
    child.once('close', (exitCode, signal) => { if (mode === 'race' && !isReady) readyReject(new Error('Original DB worker closed before readiness')); resolve({originalPID: child.pid, exitCode, signal,
      stdoutClosed: child.stdout.closed, stderrClosed: child.stderr.closed,
      rows: Buffer.concat(output).toString().trim().split('\n').filter(Boolean).map(JSON.parse), stderr: Buffer.concat(errors).toString(), signalsSent: 0}); });
  });
  if (mode !== 'race') child.stdin.end();
  return {child, ready, done};
}

test('schema-10 migration preserves business data, format 10 and the epoch across reopen', t => {
  const f = setup(t), data = fixture(f.store), before = f.store.exportData(); f.store.close();
  const db = new DatabaseSync(f.dbPath);
  removeWriteConsistencySchema(db); db.exec('PRAGMA user_version=10;'); db.close();
  const migrated = f.open(); assert.equal(SCHEMA_VERSION, 11); assert.equal(BACKUP_FORMAT_VERSION, 10);
  assert.deepEqual(migrated.exportData(), before); assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 11);
  const token = state(migrated, data); migrated.close(); assert.deepEqual(state(f.open(), data), token);
});

test('logical formats 1 through 10 remain accepted and control metadata cannot enter backups', t => {
  const {store} = setup(t); const empty = store.exportData();
  for (let version = 1; version <= 10; version++) { store.importData({...empty, version}); assert.equal(store.exportData().version, 10); }
  for (const key of ['dataset_meta', 'review_revisions', 'command_receipts', 'epoch', 'receipts', 'pairingSecrets']) {
    assert.throws(() => store.importData({...empty, [key]: {synthetic: true}}), /unsupported or consistency/);
  }
  assert.deepEqual(Object.keys(empty).sort(), ['format', 'version', 'groups', 'projects', 'services', 'reviews', 'activities', 'attachments', 'settings', 'agentRuns', 'agentRequests'].sort());
});

test('status, ordinary activity and immutable receipt commit together; old identical retry remains original', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f), before = state(store, f);
  const result = store.setReviewStatusCommand(intent, f.provider);
  assert.equal(result.changed, true); assert.ok(result.revision > before.revision);
  assert.equal(store.get('reviews', f.review.id).status, 'resolved');
  assert.equal(store.snapshot().activities.filter(a => a.reviewId === f.review.id && a.type === 'status').length, 1);
  store.addActivity({reviewId: f.review.id, body: 'A later intended edit'}); const later = unchanged(store);
  assert.deepEqual(store.setReviewStatusCommand(intent, f.provider), result); assert.deepEqual(unchanged(store), later);
  assert.equal(receipts(store).length, 1); assert.ok(Buffer.byteLength(receipts(store)[0].acknowledgementJson) <= 4096);
});

test('same identity with changed intent conflicts, while another trusted principal has its own identity', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f); store.setReviewStatusCommand(intent, f.provider);
  const before = unchanged(store);
  assert.throws(() => store.setReviewStatusCommand({...intent, status: 'closed'}, f.provider), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(unchanged(store), before);
  const other = () => ({...f.provider(), principalId: 'other-owned-worker'});
  const result = store.setReviewStatusCommand({...intent, expectedRevision: state(store, f).revision}, other);
  assert.equal(result.changed, false); assert.equal(receipts(store).length, 2);
});

test('an A receipt reused for a recreated authorized B conflicts before unrelated generation comparison', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f);
  const ack = store.setReviewStatusCommand(intent, f.provider);
  const originalB = {...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(f.other.id)};
  for (let index = 0; index <= ack.revision; index++) store.saveReview({id: f.other.id, title: 'Owned B history ' + index});
  store.deleteReview(f.other.id); insert(store.db, 'reviews', originalB);
  const b = state(store, f, f.other), generation = store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(f.other.id).generation;
  assert.ok(generation > ack.revision);
  const before = unchanged(store);
  assert.throws(() => store.setReviewStatusCommand({...intent, projectId: b.projectId, reviewId: b.reviewId, expectedRevision: b.revision, status: 'closed'}, f.provider), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(unchanged(store), before);
});

test('permissions are fetched inside each transaction, including retries, with fixed scoped missing errors', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f); let allowed = true, calls = 0;
  const provider = () => { assert.equal(store.inTransaction, true); calls++; return {...f.provider(), projectGrants: allowed ? f.provider().projectGrants : []}; };
  store.setReviewStatusCommand(intent, provider); allowed = false; const before = unchanged(store);
  for (const candidate of [intent, {...intent, reviewId: 'absent-owned-review'}]) assert.throws(() => store.setReviewStatusCommand(candidate, provider), error => error.code === 'NOT_FOUND' && error.message === 'Shared resource not found.' && !Object.hasOwn(error, 'currentRevision'));
  assert.equal(calls, 3); assert.deepEqual(unchanged(store), before);
});

test('strict command and caller shapes reject injected grants, accessors and asynchronous providers', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f), before = unchanged(store); let getterCalls = 0;
  for (const value of [{...intent, principalId: 'forged'}, {...intent, expectedRevision: 0}, {...intent, epoch: 'not-an-epoch'}, {...intent, status: 'invented'}]) assert.throws(() => store.setReviewStatusCommand(value, f.provider), code('INVALID_COMMAND'));
  const accessor = {...intent}; Object.defineProperty(accessor, 'status', {enumerable: true, get() { getterCalls++; return 'closed'; }});
  assert.throws(() => store.setReviewStatusCommand(accessor, f.provider), code('INVALID_COMMAND'));
  for (const provider of [null, () => Promise.resolve(f.provider()), () => ({...f.provider(), projectGrants: [{projectId: f.a.id, write: false}]}), () => ({...f.provider(), projectGrants: [...f.provider().projectGrants, ...f.provider().projectGrants]})]) assert.throws(() => store.setReviewStatusCommand(intent, provider), code('ACCESS_DENIED'));
  assert.equal(getterCalls, 0); assert.deepEqual(unchanged(store), before);
});

test('new commands compare persisted revisions and stale epochs without refreshing old intent', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f); store.addActivity({reviewId: f.review.id, body: 'Concurrent edit'});
  const before = unchanged(store), observed = state(store, f).revision;
  assert.throws(() => store.setReviewStatusCommand(intent, f.provider), error => error.code === 'REVISION_CONFLICT' && error.currentRevision === observed);
  const backup = store.exportData(); store.importData(backup);
  assert.throws(() => store.setReviewStatusCommand(intent, f.provider), code('STALE_EPOCH'));
  assert.equal(receipts(store).length, 0); assert.equal(store.get('reviews', f.review.id).status, before.business.reviews.find(x => x.id === f.review.id).status);
});

test('all five aggregate tables invalidate revisions for raw inserts, updates, deletes and owner moves', t => {
  const {store} = setup(t), f = fixture(store);
  let previous = state(store, f).revision; store.db.prepare('UPDATE reviews SET title=? WHERE id=?').run('Raw edit', f.review.id); assert.ok(state(store, f).revision > previous);
  const activity = store.insertActivity(f.review.id, 'Synthetic', 'comment');
  const attachment = store.addAttachment({reviewId: f.review.id, name: 'fixture.txt', storageName: 'fixture.txt', size: 1, sha256: 'a'.repeat(64)});
  const run = store.saveAgentRun({reviewId: f.review.id, serviceId: f.service.id, prompt: 'Synthetic', workPath: os.tmpdir()});
  const now = new Date().toISOString(); store.db.prepare('INSERT INTO agent_requests(id,reviewId,serviceId,prompt,targetKey,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run('owned-request', f.review.id, f.service.id, 'Synthetic', 'owned-target', now, now);
  for (const [table, rowId] of [['activities', activity.id], ['attachments', attachment.id], ['agent_runs', run.id], ['agent_requests', 'owned-request']]) {
    const original = {...store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(rowId)};
    const a = state(store, f).revision, b = state(store, f, f.other).revision;
    store.db.prepare(`UPDATE ${table} SET reviewId=? WHERE id=?`).run(f.other.id, rowId);
    assert.ok(state(store, f).revision > a); assert.ok(state(store, f, f.other).revision > b);
    const moved = state(store, f, f.other).revision; store.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(rowId); assert.ok(state(store, f, f.other).revision > moved);
    const beforeInsert = state(store, f).revision; insert(store.db, table, original); assert.ok(state(store, f).revision > beforeInsert);
    const beforeDelete = state(store, f).revision; store.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(rowId); assert.ok(state(store, f).revision > beforeDelete);
  }
});

test('agent progress, completion, interruption and review copy use the same database revision boundary', t => {
  const {store} = setup(t), f = fixture(store), beforeCopy = state(store, f).revision;
  const copy = copyReviewRecord(store, {reviewId: f.review.id, projectId: f.b.id}); assert.ok(state(store, f).revision > beforeCopy); assert.ok(state(store, f, copy).revision >= 1);
  const run = store.saveAgentRun({reviewId: f.review.id, serviceId: f.service.id, prompt: 'Synthetic', workPath: os.tmpdir(), status: 'running'});
  let before = state(store, f).revision; store.saveAgentRun({id: run.id, output: 'Synthetic progress'}); assert.ok(state(store, f).revision > before);
  before = state(store, f).revision; store.saveAgentRun({id: run.id, status: 'completed', response: 'Synthetic result'}); assert.ok(state(store, f).revision > before);
  store.saveAgentRun({reviewId: f.review.id, serviceId: f.service.id, prompt: 'Next synthetic', workPath: os.tmpdir(), status: 'running'});
  before = state(store, f).revision; store.interruptAgentRuns(); assert.ok(state(store, f).revision > before);
});

test('service unlink and SET NULL foreign-key effects invalidate existing review aggregates', t => {
  const {store} = setup(t), f = fixture(store); const run = store.saveAgentRun({reviewId: f.review.id, serviceId: f.service.id, prompt: 'Synthetic', workPath: os.tmpdir()});
  const now = new Date().toISOString(); store.db.prepare('INSERT INTO agent_requests(id,reviewId,serviceId,prompt,targetKey,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run('owned-fk-request', f.review.id, f.service.id, 'Synthetic', 'owned-target', now, now);
  let before = state(store, f).revision; store.setProjectServices(f.a.id, []); assert.ok(state(store, f).revision > before); assert.equal(store.get('reviews', f.review.id).serviceId, null);
  store.setProjectServices(f.b.id, []); before = state(store, f).revision; store.deleteService(f.service.id);
  assert.ok(state(store, f).revision > before); assert.equal(store.get('agent_runs', run.id).serviceId, null);
  assert.equal(store.db.prepare('SELECT serviceId FROM agent_requests WHERE id=?').get('owned-fk-request').serviceId, null);
});

test('review deletion cascades preserve a tombstone and reused IDs cannot validate old tokens', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f); store.setReviewStatusCommand(intent, f.provider);
  const original = {...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(f.review.id)};
  const activity = store.addActivity({reviewId: f.review.id, body: 'Owned cascade'});
  const child = store.addAttachment({reviewId: f.review.id, activityId: activity.id, name: 'activity.txt', storageName: 'activity-cascade.txt', sha256: 'c'.repeat(64)});
  const beforeCascade = state(store, f).revision; store.db.prepare('DELETE FROM activities WHERE id=?').run(activity.id);
  assert.equal(store.db.prepare('SELECT id FROM attachments WHERE id=?').get(child.id), undefined); assert.ok(state(store, f).revision > beforeCascade);
  store.addAttachment({reviewId: f.review.id, name: 'fixture.txt', storageName: 'cascade.txt', sha256: 'b'.repeat(64)});
  store.deleteReview(f.review.id); const tombstone = {...store.db.prepare('SELECT * FROM review_revisions WHERE reviewId=?').get(f.review.id)};
  assert.equal(tombstone.deleted, 1); assert.equal(receipts(store).length, 1);
  assert.throws(() => store.setReviewStatusCommand(intent, f.provider), code('NOT_FOUND'));
  insert(store.db, 'reviews', original); assert.ok(state(store, f).revision > tombstone.revision);
  assert.throws(() => store.setReviewStatusCommand(intent, f.provider), code('NOT_FOUND'));
  assert.throws(() => store.setReviewStatusCommand({...intent, requestId: 'new-old-token'}, f.provider), code('REVISION_CONFLICT'));
  store.deleteProject(f.a.id); assert.equal(store.db.prepare('SELECT deleted FROM review_revisions WHERE reviewId=?').get(f.review.id).deleted, 1);
});

test('overflow fails closed and logical import can atomically establish a new bounded epoch', t => {
  const {store} = setup(t), f = fixture(store), backup = store.exportData();
  store.db.prepare('UPDATE review_revisions SET revision=? WHERE reviewId=?').run(MAX_REVISION, f.review.id); const before = unchanged(store);
  assert.throws(() => store.saveReview({id: f.review.id, title: 'Must roll back'}), /CHECK constraint/); assert.deepEqual(unchanged(store), before);
  store.importData(backup); assert.notEqual(state(store, f).epoch, before.controls.meta.epoch); assert.equal(state(store, f).revision, 1);
});

test('receipt insert and COMMIT failures roll back business rows, activities, revisions and receipts', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f), before = unchanged(store);
  store.db.exec("CREATE TRIGGER injected_receipt_failure BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'Owned receipt failure'); END;");
  assert.throws(() => store.setReviewStatusCommand(intent, f.provider), /Owned receipt failure/); assert.deepEqual(unchanged(store), before); store.db.exec('DROP TRIGGER injected_receipt_failure');
  assert.throws(() => store.transaction(() => {
    store.db.exec('PRAGMA defer_foreign_keys=ON'); const now = new Date().toISOString();
    store.db.prepare('INSERT INTO projects(id,groupId,name,createdAt,updatedAt) VALUES(?,?,?,?,?)').run('invalid-owned-project', 'missing-owned-group', 'Synthetic', now, now);
    store.setReviewStatusCommand(intent, f.provider);
  }), /FOREIGN KEY/); assert.deepEqual(unchanged(store), before);
});

test('thenable callbacks and caught nested failures cannot produce a successful outer commit', t => {
  const {store} = setup(t), f = fixture(store), before = unchanged(store);
  assert.throws(() => store.transaction(() => { store.saveReview({id: f.review.id, title: 'Must roll back'}); return Promise.resolve(); }), code('ASYNC_TRANSACTION'));
  assert.deepEqual(unchanged(store), before);
  assert.throws(() => store.transaction(() => {
    store.saveReview({id: f.review.id, title: 'Must also roll back'});
    try { store.transaction(() => { throw new Error('Owned nested failure'); }); } catch {}
  }), /Owned nested failure/); assert.deepEqual(unchanged(store), before);
  assert.throws(() => store.transaction(() => {
    store.saveReview({id: f.review.id, title: 'Falsy exceptions also roll back'});
    try { store.transaction(() => { throw undefined; }); } catch {}
  })); assert.deepEqual(unchanged(store), before);
});

test('no-op receipt leaves the revision unchanged and active receipts reject update or deletion', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f, {status: 'open'}), before = state(store, f);
  const result = store.setReviewStatusCommand(intent, f.provider); assert.equal(result.changed, false); assert.deepEqual(state(store, f), before);
  assert.throws(() => store.db.exec("UPDATE command_receipts SET intentSHA256='changed'"), /immutable/);
  assert.throws(() => store.db.exec('DELETE FROM command_receipts'), /cannot be retired/);
});

test('active receipt budget rejects a new command before any business mutation', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f, {status: 'open'}); store.setReviewStatusCommand(intent, f.provider);
  store.db.exec(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<${MAX_RECEIPTS - 1})
    INSERT INTO command_receipts SELECT epoch,principalId,'budget_'||value,operation,intentVersion,projectId,reviewId,intentSHA256,acknowledgementJson,committedRevision,committedAt FROM command_receipts CROSS JOIN n WHERE requestId='owned-command';`);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM command_receipts').get().count, MAX_RECEIPTS); const before = store.snapshot(), token = state(store, f);
  assert.throws(() => store.setReviewStatusCommand({...intent, requestId: 'over-budget', status: 'resolved'}, f.provider), code('RECEIPT_LIMIT'));
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(state(store, f), token);
  assert.deepEqual(store.setReviewStatusCommand(intent, f.provider).changed, false);
});

test('failed live import preserves epoch and receipts; successful import invalidates old identities', t => {
  const {store} = setup(t), f = fixture(store), intent = command(store, f); store.setReviewStatusCommand(intent, f.provider);
  const backup = store.exportData(), before = unchanged(store);
  store.db.exec("CREATE TRIGGER injected_live_import_failure BEFORE INSERT ON groups BEGIN SELECT RAISE(ABORT,'Owned import failure'); END;");
  assert.throws(() => store.importData(backup), /Owned import failure/); assert.deepEqual(unchanged(store), before); store.db.exec('DROP TRIGGER injected_live_import_failure');
  const invalid = {...backup, reviews: [...backup.reviews, backup.reviews[0]]}; assert.throws(() => store.importData(invalid)); assert.deepEqual(unchanged(store), before);
  store.importData(backup); assert.notEqual(state(store, f).epoch, intent.epoch); assert.equal(receipts(store).length, 0);
  assert.throws(() => store.setReviewStatusCommand(intent, f.provider), code('STALE_EPOCH'));
});

test('two owned SQLite connections accept one competing revision and recover an identical original retry', t => {
  const f = setup(t), data = fixture(f.store), second = f.open(), intent = command(f.store, data);
  const ack = f.store.setReviewStatusCommand(intent, data.provider);
  assert.throws(() => second.setReviewStatusCommand({...intent, requestId: 'competing'}, data.provider), code('REVISION_CONFLICT'));
  assert.deepEqual(second.setReviewStatusCommand(intent, data.provider), ack); assert.equal(receipts(second).length, 1);
});

test('two simultaneous original workers with one identity persist exactly one receipt', async t => {
  const f = setup(t), data = fixture(f.store), intent = command(f.store, data), workers = [ownedWorker(f.dbPath, 'race', intent), ownedWorker(f.dbPath, 'race', intent)];
  const completed = Promise.allSettled(workers.map(w => w.done)); let readinessError;
  try { await Promise.all(workers.map(w => w.ready)); } catch (error) { readinessError = error; }
  finally { for (const worker of workers) if (!worker.child.stdin.destroyed) worker.child.stdin.end('go'); }
  const outcomes = await completed;
  if (readinessError) throw readinessError;
  for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled');
  const rows = outcomes.map(outcome => outcome.value);
  for (const row of rows) { assert.equal(row.exitCode, 0); assert.equal(row.signal, null); assert.ok(row.stdoutClosed && row.stderrClosed); t.diagnostic(JSON.stringify({...row, rows: undefined})); }
  assert.deepEqual(rows[0].rows.at(-1).result, rows[1].rows.at(-1).result); assert.equal(receipts(f.store).length, 1);
});

test('owned natural exits before and after COMMIT preserve rollback or one durable retry receipt', async t => {
  const f = setup(t), data = fixture(f.store), intent = command(f.store, data), before = unchanged(f.store);
  const first = await ownedWorker(f.dbPath, 'before-commit', intent).done;
  assert.equal(first.exitCode, 17); assert.equal(first.signal, null); assert.ok(first.stdoutClosed && first.stderrClosed); assert.deepEqual(unchanged(f.store), before);
  const second = await ownedWorker(f.dbPath, 'after-commit', intent).done;
  assert.equal(second.exitCode, 23); assert.equal(second.signal, null); assert.ok(second.stdoutClosed && second.stderrClosed);
  const reopened = f.open(), saved = receipts(reopened); assert.equal(saved.length, 1);
  assert.deepEqual(reopened.setReviewStatusCommand(intent, data.provider), JSON.parse(saved[0].acknowledgementJson));
  t.diagnostic(JSON.stringify({originalChildren: [first, second].map(({rows, ...row}) => row), signalsSent: 0}));
});


test('write admissions are opaque Store-owned capabilities and do not grant status access', t => {
  const {store, open} = setup(t), f = fixture(store), before = unchanged(store);
  const admission = store.captureWriteAdmission();
  assert.equal(Object.isFrozen(admission), true);
  assert.deepEqual(Reflect.ownKeys(admission), []);
  assert.equal(JSON.stringify(admission), '{}');
  assert.equal(store.assertWriteAdmission(admission), undefined);
  for (const forged of [null, undefined, {}, JSON.parse(JSON.stringify(admission)), {epoch: state(store, f).epoch}])
    assert.throws(() => store.assertWriteAdmission(forged), code('INVALID_WRITE_ADMISSION'));
  assert.throws(() => open().assertWriteAdmission(admission), code('INVALID_WRITE_ADMISSION'));
  assert.throws(() => store.setReviewStatusCommand(command(store, f), () => admission), code('ACCESS_DENIED'));
  assert.deepEqual(unchanged(store), before);
});

test('logical import invalidates an original admission even when all entity IDs survive', t => {
  const {store} = setup(t), f = fixture(store), admission = store.captureWriteAdmission(), original = state(store, f);
  const backup = store.exportData(); backup.reviews.find(row => row.id === f.review.id).title = 'Restored same-ID review';
  store.importData(backup); const restored = unchanged(store);
  assert.equal(store.get('reviews', f.review.id).projectId, f.a.id);
  assert.notEqual(state(store, f).epoch, original.epoch);
  assert.throws(() => store.assertWriteAdmission(admission), code('STALE_EPOCH'));
  assert.equal(store.assertWriteAdmission(store.captureWriteAdmission()), undefined);
  assert.deepEqual(unchanged(store), restored);
});

test('a rolled-back logical import preserves the original admission and all controls', t => {
  const {store} = setup(t); fixture(store);
  const admission = store.captureWriteAdmission(), before = unchanged(store);
  assert.throws(() => store.transaction(() => { store.importData(store.exportData()); throw new Error('Owned import rollback'); }), /Owned import rollback/);
  assert.deepEqual(unchanged(store), before);
  assert.equal(store.assertWriteAdmission(admission), undefined);
});

test('admission validation observes an epoch replaced by another SQLite connection', t => {
  const {store, open} = setup(t); fixture(store);
  const admission = store.captureWriteAdmission(), other = open();
  other.importData(other.exportData());
  assert.throws(() => store.assertWriteAdmission(admission), code('STALE_EPOCH'));
  const current = store.captureWriteAdmission(); store.close();
  assert.throws(() => store.assertWriteAdmission(current), code('STORE_CLOSED'));
});


test('review incarnation admissions are fieldless Store-bound capabilities without a payload grant',t=>{
 const {store}=setup(t),f=fixture(store),other=setup(t).store,admission=store.captureWriteAdmission(),before=unchanged(store),token=store.captureReviewWriteAdmission(admission,{reviewId:f.review.id,projectId:f.a.id,serviceId:f.service.id});
 assert(Object.isFrozen(token));assert.equal(Object.getPrototypeOf(token),null);assert.deepEqual(Reflect.ownKeys(token),[]);assert.equal(JSON.stringify(token),'{}');assert.deepEqual(unchanged(store),before);
 assert.throws(()=>store.assertReviewWriteAdmission({}),code('INVALID_REVIEW_ADMISSION'));assert.throws(()=>other.assertReviewWriteAdmission(token),code('INVALID_REVIEW_ADMISSION'));
 assert.throws(()=>store.captureReviewWriteAdmission(admission,{reviewId:f.review.id,projectId:f.a.id,serviceId:f.service.id,grant:true}),code('INVALID_REVIEW_ADMISSION'));
});

test('review incarnation survives ordinary edits and failed import but not a committed logical import',t=>{
 const {store}=setup(t),f=fixture(store),admission=store.captureWriteAdmission(),token=store.captureReviewWriteAdmission(admission,{reviewId:f.review.id,projectId:f.a.id,serviceId:f.service.id});
 store.addActivity({reviewId:f.review.id,body:'Ordinary concurrent comment'});store.assertReviewWriteAdmission(token);
 const backup=store.exportData(),invalid=structuredClone(backup);invalid.reviews[0].projectId='missing';assert.throws(()=>store.importData(invalid));store.assertReviewWriteAdmission(token);
 store.importData(backup);assert.throws(()=>store.assertReviewWriteAdmission(token),code('STALE_EPOCH'));
});

test('review incarnation rejects a same-epoch recreated ID and poisons an outer attempted write atomically',t=>{
 const {store}=setup(t),f=fixture(store),admission=store.captureWriteAdmission(),token=store.captureReviewWriteAdmission(admission,{reviewId:f.review.id,projectId:f.a.id,serviceId:f.service.id}),raw={...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(f.review.id)};
 const generation=store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(f.review.id).generation;store.deleteReview(f.review.id);insert(store.db,'reviews',raw);assert(store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(f.review.id).generation>generation);
 const before=unchanged(store);assert.throws(()=>store.transaction(()=>{store.addActivity({reviewId:f.review.id,body:'Must roll back'});try{store.assertReviewWriteAdmission(token);}catch{};}),code('STALE_REVIEW'));assert.deepEqual(unchanged(store),before);
 const fresh=store.captureReviewWriteAdmission(admission,{reviewId:f.review.id,projectId:f.a.id,serviceId:f.service.id});store.assertReviewWriteAdmission(fresh);store.setProjectServices(f.a.id,[]);assert.throws(()=>store.assertReviewWriteAdmission(fresh),code('STALE_REVIEW'));
});

test('detached cancellation admission is private Store-bound original ownership and leaves ordinary callbacks strict',t=>{
 const {store}=setup(t),f=fixture(store),other=setup(t).store,token=store.captureReviewWriteAdmission(store.captureWriteAdmission(),{reviewId:f.review.id,projectId:f.a.id,serviceId:f.service.id});
 assert.throws(()=>store.assertDetachedReviewCancellation({}),code('INVALID_REVIEW_ADMISSION'));assert.throws(()=>other.assertDetachedReviewCancellation(token),code('INVALID_REVIEW_ADMISSION'));
 assert.throws(()=>store.assertDetachedReviewCancellation(token),code('STALE_REVIEW'));store.setProjectServices(f.a.id,[]);
 const before=unchanged(store);store.assertDetachedReviewCancellation(token);assert.deepEqual(unchanged(store),before);assert.throws(()=>store.assertReviewWriteAdmission(token),code('STALE_REVIEW'));
});

test('detached cancellation cannot upgrade an old epoch or review generation',t=>{
 for(const change of ['import','review-birth']) {
  const {store}=setup(t),f=fixture(store),token=store.captureReviewWriteAdmission(store.captureWriteAdmission(),{reviewId:f.review.id,projectId:f.a.id,serviceId:f.service.id});store.setProjectServices(f.a.id,[]);
  if(change==='import')store.importData(store.exportData());else {const raw={...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(f.review.id)};store.deleteReview(f.review.id);insert(store.db,'reviews',raw);}
  const before=unchanged(store);assert.throws(()=>store.transaction(()=>{store.addActivity({reviewId:f.review.id,body:'Must roll back'});store.assertDetachedReviewCancellation(token);}),code(change==='import'?'STALE_EPOCH':'STALE_REVIEW'));assert.deepEqual(unchanged(store),before);
 }
});

test('detached cancellation rejects a remaining original project link and an originally service-free review',t=>{
 const {store}=setup(t),f=fixture(store),token=store.captureReviewWriteAdmission(store.captureWriteAdmission(),{reviewId:f.review.id,projectId:f.a.id,serviceId:f.service.id});
 store.db.prepare('UPDATE reviews SET serviceId=NULL WHERE id=?').run(f.review.id);assert.throws(()=>store.assertDetachedReviewCancellation(token),code('STALE_REVIEW'));
 store.setProjectServices(f.a.id,[]);const detached=store.captureReviewWriteAdmission(store.captureWriteAdmission(),{reviewId:f.review.id,projectId:f.a.id,serviceId:null});
 assert.throws(()=>store.assertDetachedReviewCancellation(detached),code('STALE_REVIEW'));store.assertDetachedReviewCancellation(token);
});
