'use strict';

// Source-authored tests only until separately admitted. Contexts below are
// application-owned fixtures, not peer authentication or installed-app evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createStore, createPeerReadStoreBridge} = require('../electron/store.cjs');
const {querySharedData} = require('../electron/shared-data-query.cjs');

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-02T00:00:00.000Z';
const T2 = '2026-11-03T00:00:00.000Z';
const unavailable = error => error.code === 'PEER_READ_UNAVAILABLE' &&
  error.message === 'Committed peer read state is unavailable.';
const errorCode = expected => error => error.code === expected;
const copy = value => JSON.parse(JSON.stringify(value));

function setup(t, withSeed = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-peer-read-view-'));
  let store;
  try { store = createStore({dbPath: path.join(root, 'owned.sqlite')}); }
  catch (error) { fs.rmSync(root, {recursive: true, force: true}); throw error; }
  const db = store.db, nativeClose = db.close;
  const f = {root, store, db, nativeClose, nativeClosed: false};
  t.after(() => {
    try {
      // Explicit cleanup of this test's original temporary connection. Never
      // retry a bridge retirement or adopt a different connection as cleanup.
      if (!f.nativeClosed) {
        Reflect.apply(nativeClose, db, []); f.nativeClosed = true;
      }
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  });
  db.close = function(...args) {
    const result = Reflect.apply(nativeClose, this, args);
    if (this === db) f.nativeClosed = true;
    return result;
  };
  if (withSeed) Object.assign(f, seed(store));
  return f;
}
function seed(store) {
  const group = store.saveGroup({name: 'Owned read-view fixture'});
  const project = store.db.prepare('INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)');
  project.run('project-z', group.id, 'Earlier Z', 'Owned earlier project', T0, T0);
  project.run('project-a', group.id, 'Later A', 'Owned later project', T1, T1);
  const review = store.db.prepare('INSERT INTO reviews(id,projectId,number,title,body,status,priority,category,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)');
  review.run('review-z', 'project-z', 1, 'Older Z', 'Owned review Z', 'open', 'normal', 'ux', T0, T1);
  review.run('review-a', 'project-z', 2, 'Older A', 'Owned review A', 'open', 'normal', 'ux', T0, T1);
  review.run('review-m', 'project-z', 3, 'Newer M', 'Owned review M', 'open', 'normal', 'ux', T0, T2);
  return {group, projectId: 'project-z', otherProjectId: 'project-a', reviewId: 'review-z',
    context: {projectGrants: [{projectId: 'project-z', read: true}, {projectId: 'project-a', read: true}]}};
}
function state(store) {
  const tables = ['groups', 'projects', 'services', 'project_services', 'reviews', 'activities', 'attachments',
    'settings', 'agent_runs', 'agent_requests', 'dataset_meta', 'review_revisions', 'command_receipts',
    'peer_project_birth_counter', 'peer_project_births'];
  return Object.fromEntries(tables.map(table => [table,
    store.db.prepare(`SELECT * FROM ${table}`).all().map(row => ({...row}))]));
}
function traceSQL(db, action) {
  const prepare = db.prepare, exec = db.exec, rows = [], executions = [], statements = [];
  db.exec = function(sql) { executions.push(sql); return Reflect.apply(exec, this, [sql]); };
  db.prepare = function(sql, ...args) {
    const text = sql.replace(/\s+/g, ' ').trim();
    statements.push(text);
    const statement = Reflect.apply(prepare, this, [sql, ...args]);
    if (/^SELECT\b/i.test(text) && /\bFROM (projects|reviews)\b/i.test(text) && !/peer_project_births/i.test(text)) {
      const item = {sql: text, allCalls: 0, rowCounts: []}; rows.push(item);
      const all = statement.all;
      statement.all = function(...parameters) {
        const actual = Reflect.apply(all, this, parameters);
        item.allCalls++; item.rowCounts.push(actual.length); return actual;
      };
    }
    return statement;
  };
  try { return action({rows, executions, statements}); }
  finally { db.prepare = prepare; db.exec = exec; }
}
function captureError(action) {
  let failure;
  try { action(); } catch (error) { failure = error; }
  assert.ok(failure, 'Expected the owned operation to fail'); return failure;
}

test('bootstrap rejects foreign/prototype Stores and wrong arity before any SQL or claim', t => {
  const f = setup(t), fake = Object.assign(Object.create(Object.getPrototypeOf(f.store)), {db: f.db, closed: false});
  traceSQL(f.db, trace => {
    for (const foreign of [undefined, null, {}, fake])
      assert.throws(() => createPeerReadStoreBridge(foreign, () => null), unavailable);
    assert.throws(() => createPeerReadStoreBridge(f.store), unavailable);
    assert.throws(() => createPeerReadStoreBridge(f.store, () => null, {}), unavailable);
    assert.deepEqual(trace.executions, []); assert.deepEqual(trace.rows, []);
  });
  const bridge = createPeerReadStoreBridge(f.store, () => null);
  assert.equal(bridge.sample().projects.length, 2);
});

test('invalid fixed reader consumes the original claim without stranding ordinary Store writes or close', t => {
  const f = setup(t);
  assert.throws(() => createPeerReadStoreBridge(f.store, null), unavailable);
  assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable);
  f.store.saveProject({id: f.projectId, name: 'Ordinary write after invalid bootstrap'});
  assert.equal(f.store.get('projects', f.projectId).name, 'Ordinary write after invalid bootstrap');
  f.store.close(); assert.equal(f.store.closed, true);
});

test('bootstrap requires original own-data connection/closed fields without invoking accessors', t => {
  for (const field of ['db', 'closed']) {
    const f = setup(t), descriptor = Object.getOwnPropertyDescriptor(f.store, field); let getters = 0;
    Object.defineProperty(f.store, field, {configurable: true, get() { getters++; return descriptor.value; }});
    try { assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable); }
    finally { Object.defineProperty(f.store, field, descriptor); }
    assert.equal(getters, 0); assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable);
    f.store.saveProject({id: f.projectId, description: 'Invalid bootstrap did not retire ordinary Store use'});
  }
});

test('a replacement DatabaseSync connection cannot adopt an original bridge', t => {
  const f = setup(t), replacement = new DatabaseSync(':memory:');
  const original = f.store.db;
  try {
    const bridge = createPeerReadStoreBridge(f.store, () => 'must not escape');
    f.store.db = replacement;
    assert.throws(() => bridge.sample(), unavailable);
    assert.throws(() => bridge.read(), unavailable);
    assert.equal(replacement.prepare('SELECT 1 AS value').get().value, 1);
  } finally { f.store.db = original; replacement.close(); }
});

test('duplicate bootstrap before and during a view cannot replace its reader, guard or SQL owner', t => {
  const f = setup(t); let calls = 0, competingCalls = 0;
  const bridge = createPeerReadStoreBridge(f.store, function(view) {
    assert.equal(this, undefined, 'The fixed reader must not receive the private owner as its receiver'); calls++;
    traceSQL(f.db, trace => {
      assert.throws(() => createPeerReadStoreBridge(f.store, () => { competingCalls++; }), unavailable);
      assert.deepEqual(trace.executions, []); assert.deepEqual(trace.rows, []);
    });
    return view.dataset();
  });
  assert.throws(() => createPeerReadStoreBridge(f.store, () => { competingCalls++; }), unavailable);
  assert.equal(bridge.read().projects.length, 2); assert.equal(calls, 1); assert.equal(competingCalls, 0);
  assert.equal(bridge.read().projects.length, 2); assert.equal(calls, 2);
});

test('sample is committed metadata only, deeply frozen, detached and independent of the installed reader', t => {
  const f = setup(t), before = state(f.store); let readerCalls = 0;
  const bridge = createPeerReadStoreBridge(f.store, () => { readerCalls++; return 'unused'; });
  assert.ok(Object.isFrozen(bridge)); assert.deepEqual(Object.keys(bridge).sort(), ['read', 'retireAndClose', 'sample']);
  let first, second;
  traceSQL(f.db, trace => {
    first = bridge.sample(); second = bridge.sample();
    assert.deepEqual(trace.rows, [], 'Samples must not materialize project/review content arrays');
    assert.deepEqual(trace.executions, ['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN IMMEDIATE', 'COMMIT']);
  });
  assert.equal(readerCalls, 0); assert.deepEqual(first, f.store.peerReadDataset());
  assert.notEqual(first, second); assert.notEqual(first.projects, second.projects);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.projects) && first.projects.every(Object.isFrozen));
  assert.throws(() => { first.projects[0].birth = 0; }, TypeError);
  assert.deepEqual(state(f.store), before);
  f.store.saveProject({id: f.projectId, name: 'Ordinary write outside intervals'});
  assert.equal(bridge.sample().projects.length, 2);
});

test('bridge arity/reentrant refusal is local and does not poison a caught outer read', t => {
  const f = setup(t); let bridge;
  bridge = createPeerReadStoreBridge(f.store, view => {
    assert.throws(() => bridge.sample(), unavailable); assert.throws(() => bridge.read(), unavailable);
    assert.throws(() => bridge.sample(undefined), unavailable); assert.throws(() => bridge.read({}), unavailable);
    return view.query(f.context, 'projects.list', {});
  });
  traceSQL(f.db, trace => {
    assert.throws(() => bridge.sample(undefined), unavailable); assert.throws(() => bridge.read(undefined), unavailable);
    assert.throws(() => bridge.retireAndClose(undefined), unavailable); assert.deepEqual(trace.executions, []);
  });
  assert.deepEqual(bridge.read().projects.map(row => row.id), ['project-z', 'project-a']);
});

test('a fixed reader sees one lazy cached dataset and returns the existing detached DTO after commit', t => {
  const f = setup(t), snapshot = f.store.snapshot(); let oldView, previousDataset, calls = 0;
  const bridge = createPeerReadStoreBridge(f.store, view => {
    calls++; if (oldView) assert.throws(() => oldView.dataset(), unavailable);
    assert.ok(Object.isFrozen(view)); assert.deepEqual(Object.keys(view).sort(), ['dataset', 'query']);
    const current = view.dataset(); assert.equal(view.dataset(), current);
    if (previousDataset) assert.notEqual(current, previousDataset);
    previousDataset = current; oldView = view;
    return view.query(f.context, 'projects.list', {});
  });
  const first = bridge.read(); assert.deepEqual(first, querySharedData(snapshot, f.context, 'projects.list', {}));
  assert.throws(() => oldView.dataset(), unavailable); assert.throws(() => oldView.query(f.context, 'projects.list', {}), unavailable);
  first.projects[0].name = 'Detached caller change'; first.projects.push({id: 'fabricated'});
  assert.deepEqual(bridge.read(), querySharedData(snapshot, f.context, 'projects.list', {})); assert.equal(calls, 2);
});

test('one owned interval keeps birth metadata and content coherent against a second connection', t => {
  const f = setup(t), other = new DatabaseSync(f.store.dbPath);
  let attemptWrite = true, returnedDataset;
  try {
    other.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
    const bridge = createPeerReadStoreBridge(f.store, view => {
      returnedDataset = view.dataset();
      if (attemptWrite) assert.throws(() => other.prepare('UPDATE projects SET name=? WHERE id=?').run('Later committed name', f.projectId));
      return view.query(f.context, 'projects.list', {});
    });
    const first = bridge.read(), firstBirths = copy(returnedDataset);
    assert.equal(first.projects.find(row => row.id === f.projectId).name, 'Earlier Z');
    other.prepare('UPDATE projects SET name=? WHERE id=?').run('Later committed name', f.projectId);
    attemptWrite = false;
    const second = bridge.read();
    assert.equal(second.projects.find(row => row.id === f.projectId).name, 'Later committed name');
    assert.deepEqual(returnedDataset, firstBirths, 'An ordinary metadata update must not change births');
  } finally { other.close(); }
});

test('all three operation DTOs and below-bound kernel errors preserve ordinary snapshot ordering and semantics', t => {
  const f = setup(t), snapshot = f.store.snapshot(), before = state(f.store);
  let operation, payload, context = f.context;
  const bridge = createPeerReadStoreBridge(f.store, view => view.query(context, operation, payload));
  const requests = [['projects.list', {}], ['reviews.list', {projectId: f.projectId}],
    ['reviews.get', {projectId: f.projectId, reviewId: f.reviewId}]];
  for ([operation, payload] of requests) assert.deepEqual(bridge.read(), querySharedData(snapshot, context, operation, payload));
  operation = 'reviews.list'; payload = {projectId: f.projectId};
  assert.deepEqual(bridge.read().reviews.map(row => row.id), ['review-m', 'review-a', 'review-z']);
  const errors = [
    ['reviews.list', {projectId: 'missing'}, f.context],
    ['reviews.get', {projectId: f.otherProjectId, reviewId: f.reviewId}, f.context],
    ['reviews.get', {projectId: f.projectId, reviewId: 'missing'}, f.context],
    ['reviews.list', {projectId: f.projectId, read: true}, f.context],
    ['projects.list', {}, {projectGrants: [{projectId: f.projectId, read: false}]}]
  ];
  for ([operation, payload, context] of errors) {
    const expected = captureError(() => querySharedData(snapshot, context, operation, payload));
    const actual = captureError(() => bridge.read()); assert.equal(actual.code, expected.code); assert.equal(actual.message, expected.message);
  }
  assert.deepEqual(state(f.store), before);
});

test('content query does not call snapshot or traverse private service/activity/attachment/settings data', t => {
  const f = setup(t); let published;
  const bridge = createPeerReadStoreBridge(f.store, view => view.query(f.context, 'reviews.get', {projectId: f.projectId, reviewId: f.reviewId}));
  const originals = new Map(['snapshot', 'exportData', 'project', 'get', 'settings'].map(key => [key, f.store[key]]));
  const prepare = f.db.prepare; const sql = [];
  try {
    for (const key of originals.keys()) f.store[key] = () => { throw new Error('Unexpected broad Store read: ' + key); };
    f.db.prepare = function(text, ...parameters) { sql.push(text); return Reflect.apply(prepare, this, [text, ...parameters]); };
    published = bridge.read();
  } finally { f.db.prepare = prepare; for (const [key, value] of originals) f.store[key] = value; }
  assert.equal(published.review.id, f.reviewId);
  assert.ok(sql.every(text => !/\bFROM\s+(services|activities|attachments|settings|agent_runs)\b/i.test(text)));
  assert.ok(sql.some(text => /FROM projects ORDER BY createdAt,id LIMIT 100001/.test(text.replace(/\s+/g, ' '))));
  assert.ok(sql.some(text => /FROM reviews ORDER BY updatedAt DESC,id LIMIT 100001/.test(text.replace(/\s+/g, ' '))));
});

test('a caught first kernel error poisons the frame, consumes its query slot, and cannot become manufactured success', t => {
  const f = setup(t); let first, retained, secondAttempts = 0;
  const bridge = createPeerReadStoreBridge(f.store, view => {
    retained = view;
    try { view.query(f.context, 'reviews.get', {projectId: f.projectId, reviewId: 'missing'}); } catch (error) { first = error; }
    assert.ok(first); assert.equal(first.code, 'NOT_FOUND');
    assert.throws(() => { secondAttempts++; view.query(f.context, 'projects.list', {}); });
    return {manufacturedSuccess: true};
  });
  traceSQL(f.db, trace => {
    assert.throws(() => bridge.read(), error => error === first);
    assert.equal(trace.rows.filter(row => row.allCalls).length, 2, 'No second content materialization is allowed');
  });
  assert.equal(secondAttempts, 1); assert.throws(() => retained.dataset());
  assert.equal(bridge.sample().projects.length, 2, 'Confirmed rollback releases the failed frame');
});

test('a successful first query followed by a caught budget error still withholds the first DTO', t => {
  const f = setup(t); let firstBudgetError, leaked;
  const bridge = createPeerReadStoreBridge(f.store, view => {
    const pending = view.query(f.context, 'projects.list', {});
    try { view.query(f.context, 'reviews.list', {projectId: f.projectId}); } catch (error) { firstBudgetError = error; }
    return pending;
  });
  traceSQL(f.db, trace => {
    assert.throws(() => { leaked = bridge.read(); }, error => error === firstBudgetError && unavailable(error));
    assert.equal(trace.rows.filter(row => row.allCalls).length, 2);
  });
  assert.equal(leaked, undefined);
});

test('caught dataset corruption or view arity failure cannot return fake success and retains the first error', t => {
  for (const kind of ['dataset', 'arity', 'unsupported']) {
    const f = setup(t); let first, retained;
    if (kind === 'dataset') f.db.prepare('DELETE FROM peer_project_births WHERE projectId=?').run(f.projectId);
    const bridge = createPeerReadStoreBridge(f.store, view => {
      retained = view;
      try {
        if (kind === 'dataset') view.dataset();
        else if (kind === 'arity') view.query(f.context, 'projects.list');
        else view.query(f.context, 'comments.list', {projectId: f.projectId, reviewId: f.reviewId});
      } catch (error) { first = error; }
      assert.ok(first); assert.throws(() => view.query(f.context, 'projects.list', {})); return {fake: true};
    });
    assert.throws(() => bridge.read(), error => error === first && (kind === 'unsupported' ? error.code === 'INVALID_QUERY' : unavailable(error)));
    assert.throws(() => retained.dataset());
  }
});

test('ordinary reader exceptions and thenable refusal expire views without publishing results', t => {
  const f = setup(t), primary = new Error('Owned reader failure'); let mode = 'throw', retained, leaked;
  const getterFailure = new Error('Owned then getter failure');
  const bridge = createPeerReadStoreBridge(f.store, view => {
    retained = view;
    if (mode === 'throw') throw primary;
    if (mode === 'promise') return Promise.resolve('not admitted');
    if (mode === 'then') return {then() { throw new Error('A then function must never be called'); }};
    return Object.defineProperty({}, 'then', {get() { throw getterFailure; }});
  });
  assert.throws(() => { leaked = bridge.read(); }, error => error === primary); assert.equal(leaked, undefined);
  assert.throws(() => retained.dataset());
  for (mode of ['promise', 'then']) assert.throws(() => bridge.read(), unavailable);
  mode = 'getter'; assert.throws(() => bridge.read(), error => error === getterFailure);
  assert.throws(() => retained.dataset()); assert.equal(bridge.sample().projects.length, 2);
});

test('result.then inspection occurs after view expiry, and a caught retained-method error withholds the result', t => {
  for (const method of ['dataset', 'query']) {
    const f = setup(t); let retained, first, leaked;
    const bridge = createPeerReadStoreBridge(f.store, view => {
      retained = view;
      return Object.defineProperty({}, 'then', {get() {
        try {
          if (method === 'dataset') retained.dataset();
          else retained.query(f.context, 'projects.list', {});
        } catch (error) { first = error; }
        return undefined;
      }});
    });
    traceSQL(f.db, trace => {
      assert.throws(() => { leaked = bridge.read(); }, error => error === first && unavailable(error));
      assert.deepEqual(trace.statements, [], 'An expired method cannot start metadata or content SQL');
      assert.deepEqual(trace.executions, ['BEGIN IMMEDIATE', 'ROLLBACK']);
    });
    assert.equal(leaked, undefined); assert.ok(first); assert.equal(bridge.sample().projects.length, 2);
  }
});

const guardCases = [
  ['transaction', (f, bridge, counts) => f.store.transaction(() => { counts.transactionBody++; })],
  ['upsert', (f, bridge, counts) => {
    const row = {...f.originalProjectRow};
    Object.defineProperty(row, 'name', {enumerable: true, get() { counts.upsertGetter++; return 'Forbidden'; }});
    return f.store.upsert('projects', row);
  }],
  ['insertActivity', (f, bridge, counts) => f.store.insertActivity(f.reviewId, 'Forbidden history', 'comment', '', '',
    Object.defineProperty({}, 'role', {get() { counts.authorGetter++; return 'user'; }}))],
  ['migrate', f => f.store.migrate()],
  ['importData', (f, bridge, counts) => f.store.importData(Object.defineProperty({}, 'format', {
    get() { counts.importGetter++; return 'reviewops-local'; }
  }))],
  ['backup', (f, bridge, counts) => {
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = function(...args) { counts.mkdir++; return Reflect.apply(mkdir, this, args); };
    try { return f.store.backup(path.join(f.root, 'forbidden-backup-directory', 'backup.sqlite')); }
    finally { fs.mkdirSync = mkdir; }
  }],
  ['close', f => f.store.close()],
  ['retireAndClose', (f, bridge) => bridge.retireAndClose()],
  ['saveProject', f => f.store.saveProject({id: f.projectId, name: 'Forbidden project edit'})],
  ['status command', (f, bridge, counts) => f.store.setReviewStatusCommand(f.command, () => {
    counts.statusProvider++; return {principalId: 'owned-view-writer', projectGrants: [{projectId: f.projectId, write: true}]};
  })]
];
for (const phase of ['BEGIN', 'callback', 'COMMIT']) for (const [name, mutate] of guardCases) {
  test(`${name} is refused and caught attempts poison only the original ${phase} view`, t => {
    const f = setup(t), provider = () => ({principalId: 'owned-view-writer', projectGrants: [{projectId: f.projectId, write: true}]});
    f.originalProjectRow = f.store.get('projects', f.projectId);
    const revision = f.store.reviewWriteState({projectId: f.projectId, reviewId: f.reviewId}, provider);
    f.command = {requestId: 'forbidden-in-view', projectId: f.projectId, reviewId: f.reviewId,
      epoch: revision.epoch, expectedRevision: revision.revision, status: 'resolved'};
    const before = state(f.store), counts = {transactionBody: 0, upsertGetter: 0, authorGetter: 0, importGetter: 0, mkdir: 0, statusProvider: 0};
    const originalExec = f.db.exec, executions = []; let first, fired = false, readerCalls = 0, leaked;
    const attempt = () => { fired = true; first = captureError(() => mutate(f, bridge, counts)); };
    const bridge = createPeerReadStoreBridge(f.store, () => {
      readerCalls++; if (phase === 'callback') attempt(); return {mustNotEscape: true};
    });
    f.db.exec = function(sql) {
      executions.push(sql);
      if (!fired && (phase === 'BEGIN' && sql === 'BEGIN IMMEDIATE' || phase === 'COMMIT' && sql === 'COMMIT')) attempt();
      return Reflect.apply(originalExec, this, [sql]);
    };
    try { assert.throws(() => { leaked = bridge.read(); }, error => error === first && unavailable(error)); }
    finally { f.db.exec = originalExec; }
    assert.equal(leaked, undefined); assert.equal(fired, true);
    assert.equal(readerCalls, phase === 'BEGIN' ? 0 : 1);
    assert.deepEqual(counts, {transactionBody: 0, upsertGetter: 0, authorGetter: 0, importGetter: 0, mkdir: 0, statusProvider: 0});
    assert.equal(fs.existsSync(path.join(f.root, 'forbidden-backup-directory')), false);
    assert.equal(f.store.closed, false); assert.deepEqual(state(f.store), before);
    assert.equal(executions.filter(sql => sql === 'COMMIT').length, phase === 'COMMIT' ? 1 : 0);
    assert.equal(executions.filter(sql => sql === 'ROLLBACK').length, phase === 'COMMIT' ? 0 : 1,
      'Confirmed COMMIT must not be followed by a false rollback');
    assert.equal(bridge.sample().projects.length, 2, 'Confirmed cleanup releases this frame without retiring its owner');
    f.store.saveProject({id: f.projectId, description: 'Ordinary write after read interval'});
  });
}

test('retained methods are uncallable in COMMIT and poison even when the COMMIT hook catches their error', t => {
  for (const method of ['dataset', 'query']) {
    const f = setup(t); let retained, first, leaked;
    const bridge = createPeerReadStoreBridge(f.store, view => { retained = view; return {mustNotEscape: true}; });
    const exec = f.db.exec, executions = [];
    f.db.exec = function(sql) {
      executions.push(sql);
      if (sql === 'COMMIT') {
        try {
          if (method === 'dataset') retained.dataset();
          else retained.query(f.context, 'projects.list', {});
        } catch (error) { first = error; }
      }
      return Reflect.apply(exec, this, [sql]);
    };
    try { assert.throws(() => { leaked = bridge.read(); }, error => error === first && unavailable(error)); }
    finally { f.db.exec = exec; }
    assert.equal(leaked, undefined); assert.deepEqual(executions, ['BEGIN IMMEDIATE', 'COMMIT']);
    assert.equal(bridge.sample().projects.length, 2);
  }
});

test('pre-existing Store transactions are refused locally without poisoning that caller-owned transaction', t => {
  const f = setup(t), bridge = createPeerReadStoreBridge(f.store, () => null);
  f.store.transaction(() => {
    traceSQL(f.db, trace => {
      assert.throws(() => bridge.sample(), unavailable); assert.throws(() => bridge.read(), unavailable);
      assert.deepEqual(trace.executions, []); assert.deepEqual(trace.statements, []);
    });
    f.store.saveProject({id: f.projectId, name: 'Caller-owned outer write'});
  });
  assert.equal(f.store.get('projects', f.projectId).name, 'Caller-owned outer write');
  assert.equal(bridge.sample().projects.length, 2);
});

test('raw caller BEGIN is preserved and its failed peer interval stays quarantined after caller rollback', t => {
  const f = setup(t), bridge = createPeerReadStoreBridge(f.store, () => 'must not escape');
  f.db.exec('BEGIN IMMEDIATE');
  try {
    f.db.prepare('UPDATE projects SET name=? WHERE id=?').run('Owned raw transaction', f.projectId);
    traceSQL(f.db, trace => {
      assert.throws(() => bridge.read(), error => unavailable(error) && error.cause instanceof Error);
      assert.deepEqual(trace.executions, ['BEGIN IMMEDIATE']);
    });
    assert.equal(f.db.prepare('SELECT name FROM projects WHERE id=?').get(f.projectId).name, 'Owned raw transaction');
  } finally { f.db.exec('ROLLBACK'); }
  traceSQL(f.db, trace => {
    assert.throws(() => bridge.sample(), unavailable); assert.throws(() => bridge.read(), unavailable);
    assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable);
    assert.throws(() => f.store.saveProject({id: f.projectId, name: 'Cannot adopt recovered connection'}), unavailable);
    assert.deepEqual(trace.executions, []); assert.deepEqual(trace.statements, []);
  });
  bridge.retireAndClose(); assert.equal(f.store.closed, true);
});

test('a BEGIN seam that starts SQL then throws retains quarantine identity and cannot be revived by raw COMMIT', t => {
  const f = setup(t), primary = new Error('Owned post-BEGIN failure'); let leaked;
  const bridge = createPeerReadStoreBridge(f.store, () => { throw new Error('Reader must not run after uncertain BEGIN'); });
  const exec = f.db.exec, executions = [];
  f.db.exec = function(sql) {
    executions.push(sql);
    if (sql === 'BEGIN IMMEDIATE') { Reflect.apply(exec, this, [sql]); throw primary; }
    return Reflect.apply(exec, this, [sql]);
  };
  try { assert.throws(() => { leaked = bridge.read(); }, error => unavailable(error) && error.cause === primary); }
  finally { f.db.exec = exec; }
  assert.equal(leaked, undefined); assert.deepEqual(executions, ['BEGIN IMMEDIATE']);
  f.db.exec('COMMIT');
  traceSQL(f.db, trace => {
    assert.throws(() => bridge.sample(), unavailable); assert.throws(() => bridge.read(), unavailable);
    assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable);
    assert.deepEqual(trace.executions, []); assert.deepEqual(trace.statements, []);
  });
  bridge.retireAndClose(); assert.equal(f.store.closed, true);
});

test('metadata and content COMMIT failures preserve the original error and withhold every pending result', t => {
  for (const method of ['sample', 'read']) {
    const f = setup(t), primary = new Error('Owned original COMMIT failure'); let readerCalls = 0, leaked;
    const bridge = createPeerReadStoreBridge(f.store, view => { readerCalls++; return view.query(f.context, 'projects.list', {}); });
    const before = state(f.store), exec = f.db.exec, executions = [];
    f.db.exec = function(sql) {
      executions.push(sql); if (sql === 'COMMIT') throw primary; return Reflect.apply(exec, this, [sql]);
    };
    try { assert.throws(() => { leaked = bridge[method](); }, error => error === primary); }
    finally { f.db.exec = exec; }
    assert.equal(leaked, undefined); assert.equal(readerCalls, method === 'read' ? 1 : 0);
    assert.deepEqual(executions, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']); assert.deepEqual(state(f.store), before);
    assert.equal(bridge.sample().projects.length, 2);
  }
});

test('failed rollback preserves the first actual method error and cleanup object and permanently quarantines the owner', t => {
  const f = setup(t), cleanup = new Error('Owned rollback failure'), later = new Error('Later reader error');
  let first, leaked;
  const bridge = createPeerReadStoreBridge(f.store, view => {
    try { view.query(f.context, 'reviews.get', {projectId: f.projectId, reviewId: 'missing'}); } catch (error) { first = error; }
    throw later;
  });
  const exec = f.db.exec;
  f.db.exec = function(sql) { if (sql === 'ROLLBACK') throw cleanup; return Reflect.apply(exec, this, [sql]); };
  try {
    assert.throws(() => { leaked = bridge.read(); }, error => error instanceof AggregateError && unavailable(error) &&
      error.cause === first && error.errors.length === 2 && error.errors[0] === first && error.errors[1] === cleanup);
  } finally { f.db.exec = exec; }
  assert.equal(first.code, 'NOT_FOUND'); assert.equal(leaked, undefined);
  f.db.exec('COMMIT');
  traceSQL(f.db, trace => {
    assert.throws(() => bridge.sample(), unavailable); assert.throws(() => bridge.read(), unavailable);
    assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable);
    assert.deepEqual(trace.executions, []); assert.deepEqual(trace.statements, []);
  });
  bridge.retireAndClose(); assert.equal(f.store.closed, true);
});

test('a COMMIT seam that closes SQL then throws is not treated as confirmed cleanup or replayed', t => {
  const f = setup(t), primary = new Error('Owned post-COMMIT failure'); let calls = 0, leaked;
  const bridge = createPeerReadStoreBridge(f.store, view => { calls++; return view.query(f.context, 'projects.list', {}); });
  const exec = f.db.exec, executions = [];
  f.db.exec = function(sql) {
    executions.push(sql); const result = Reflect.apply(exec, this, [sql]); if (sql === 'COMMIT') throw primary; return result;
  };
  try {
    assert.throws(() => { leaked = bridge.read(); }, error => error instanceof AggregateError && unavailable(error) &&
      error.cause === primary && error.errors[0] === primary && error.errors[1] instanceof Error);
  } finally { f.db.exec = exec; }
  assert.equal(leaked, undefined); assert.equal(calls, 1); assert.deepEqual(executions, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
  traceSQL(f.db, trace => { assert.throws(() => bridge.read(), unavailable); assert.deepEqual(trace.executions, []); });
  bridge.retireAndClose(); assert.equal(f.store.closed, true);
});

test('explicit retirement closes the actual original connection once and never releases its bootstrap claim', t => {
  const f = setup(t), bridge = createPeerReadStoreBridge(f.store, () => null);
  const close = f.db.close; let closes = 0;
  f.db.close = function() { closes++; return Reflect.apply(close, this, []); };
  try {
    assert.equal(bridge.retireAndClose(), undefined); assert.equal(f.store.closed, true); assert.equal(closes, 1);
    assert.throws(() => f.db.prepare('SELECT 1'), undefined, 'The real original native connection must be closed');
    assert.equal(bridge.retireAndClose(), undefined); assert.equal(closes, 1);
    assert.throws(() => bridge.sample(), unavailable); assert.throws(() => bridge.read(), unavailable);
    assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable);
    f.store.close(); assert.equal(closes, 1, 'Ordinary confirmed Store.close is idempotent');
  } finally { f.db.close = close; }
});

test('successful idle Store.close marks the private original closed and later retirement never closes it again', t => {
  const f = setup(t), bridge = createPeerReadStoreBridge(f.store, () => null);
  const close = f.db.close; let closes = 0;
  f.db.close = function() { closes++; return Reflect.apply(close, this, []); };
  try {
    f.store.close(); assert.equal(f.store.closed, true); assert.equal(f.nativeClosed, true); assert.equal(closes, 1);
    assert.throws(() => f.db.prepare('SELECT 1'));
    assert.throws(() => bridge.sample(), unavailable); assert.throws(() => bridge.read(), unavailable);
    assert.equal(bridge.retireAndClose(), undefined); assert.equal(closes, 1);
    assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable);
    f.store.close(); assert.equal(closes, 1);
  } finally { f.db.close = close; }
});

test('throwing ordinary close does not falsely confirm native closure or consume explicit bridge retirement', t => {
  const f = setup(t), primary = new Error('Owned ordinary close failure');
  const bridge = createPeerReadStoreBridge(f.store, () => null), close = f.db.close; let attempts = 0;
  f.db.close = function() { attempts++; throw primary; };
  try { assert.throws(() => f.store.close(), error => error === primary); }
  finally { f.db.close = close; }
  assert.equal(attempts, 1); assert.equal(f.store.closed, false); assert.equal(f.nativeClosed, false);
  assert.equal(f.db.prepare('SELECT 1 AS value').get().value, 1);
  bridge.retireAndClose(); assert.equal(f.nativeClosed, true); assert.equal(f.store.closed, true);
});

test('a public closed flag alone is not evidence that the registered original native connection closed', t => {
  const f = setup(t), bridge = createPeerReadStoreBridge(f.store, () => null), close = f.db.close;
  let nativeCalls = 0;
  f.db.close = function() { nativeCalls++; return Reflect.apply(close, this, []); };
  try {
    f.store.closed = true; f.store.close(); assert.equal(nativeCalls, 0); assert.equal(f.nativeClosed, false);
    assert.equal(f.db.prepare('SELECT 1 AS value').get().value, 1);
    bridge.retireAndClose(); assert.equal(nativeCalls, 1); assert.equal(f.nativeClosed, true);
  } finally { f.db.close = close; }
});

test('close failure before or after actual native closure is retained and retirement is never retried', t => {
  for (const afterNative of [false, true]) {
    const f = setup(t), primary = new Error('Owned native close seam'), bridge = createPeerReadStoreBridge(f.store, () => null);
    const close = f.db.close; let attempts = 0;
    f.db.close = function() {
      attempts++;
      if (afterNative) { Reflect.apply(close, this, []); f.nativeClosed = true; }
      throw primary;
    };
    try {
      assert.throws(() => bridge.retireAndClose(), error => unavailable(error) && error.cause === primary);
      assert.throws(() => bridge.retireAndClose(), unavailable); assert.equal(attempts, 1);
      assert.throws(() => bridge.sample(), unavailable); assert.throws(() => bridge.read(), unavailable);
      assert.throws(() => createPeerReadStoreBridge(f.store, () => null), unavailable);
    } finally { f.db.close = close; }
    if (afterNative) assert.throws(() => f.db.prepare('SELECT 1'));
    else assert.equal(f.db.prepare('SELECT 1 AS value').get().value, 1, 'A throwing close does not fabricate native closure');
  }
});

function insertBoundedProjects(db, groupId) {
  db.prepare(`WITH RECURSIVE owned(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM owned WHERE n<100001)
    INSERT INTO projects(id,groupId,name,createdAt,updatedAt)
    SELECT printf('bounded-project-%06d',n),?,'Owned bounded project',?,? FROM owned`).run(groupId, T0, T0);
}
function insertBoundedReviews(db, projectId) {
  db.prepare(`WITH RECURSIVE owned(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM owned WHERE n<100001)
    INSERT INTO reviews(id,projectId,number,title,body,status,priority,category,createdAt,updatedAt)
    SELECT printf('bounded-review-%06d',n),?,n,'Owned bounded review','','open','normal','ux',?,? FROM owned`).run(projectId, T0, T0);
}

test('real project content SQL reaches its 100001 sentinel without an eager dataset read or fabricated metadata', t => {
  const f = setup(t, false), group = f.store.saveGroup({name: 'Owned project limit'});
  insertBoundedProjects(f.db, group.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 100001);
  let readerCalls = 0;
  const bridge = createPeerReadStoreBridge(f.store, view => {
    readerCalls++; return view.query({projectGrants: []}, 'projects.list', {});
  });
  traceSQL(f.db, trace => {
    assert.throws(() => bridge.read(), errorCode('INVALID_SNAPSHOT'));
    const projectRead = trace.rows.find(row => /FROM projects ORDER BY createdAt,id LIMIT 100001/.test(row.sql));
    assert.ok(projectRead); assert.equal(projectRead.allCalls, 1); assert.deepEqual(projectRead.rowCounts, [100001]);
    assert.ok(trace.statements.every(sql => !/peer_project_births|peer_project_birth_counter/.test(sql)),
      'Lazy read query must reach the actual content bound before any dataset() call');
  });
  assert.equal(readerCalls, 1);
  f.db.prepare('DELETE FROM projects WHERE id=?').run('bounded-project-100001');
  traceSQL(f.db, trace => {
    assert.deepEqual(bridge.read(), {version: 1, projects: []}, 'Empty grants are an actual kernel result below the bound');
    const projectRead = trace.rows.find(row => /FROM projects ORDER BY createdAt,id LIMIT 100001/.test(row.sql));
    assert.deepEqual(projectRead.rowCounts, [100000]);
  });
});

test('projects.list still materializes the real required reviews array and refuses its 100001 sentinel', t => {
  const f = setup(t, false), group = f.store.saveGroup({name: 'Owned review limit'});
  const project = f.store.saveProject({groupId: group.id, name: 'One owned project'});
  insertBoundedReviews(f.db, project.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM reviews').get().count, 100001);
  const bridge = createPeerReadStoreBridge(f.store, view => view.query({projectGrants: [{projectId: project.id, read: true}]}, 'projects.list', {}));
  traceSQL(f.db, trace => {
    assert.throws(() => bridge.read(), error => error.code === 'INVALID_SNAPSHOT' && error.message === 'Shared data is unavailable.');
    const projects = trace.rows.find(row => /FROM projects ORDER BY createdAt,id LIMIT 100001/.test(row.sql));
    const reviews = trace.rows.find(row => /FROM reviews ORDER BY updatedAt DESC,id LIMIT 100001/.test(row.sql));
    assert.ok(projects && reviews); assert.deepEqual(projects.rowCounts, [1]); assert.deepEqual(reviews.rowCounts, [100001]);
    assert.deepEqual(trace.executions, ['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});
