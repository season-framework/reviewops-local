'use strict';

// Source-authored, unexecuted proposal until separately admitted. The WeakSet
// verifier is an identity stub, not cryptography or live peer authentication.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createStore} = require('../electron/store.cjs');
const {querySharedData} = require('../electron/shared-data-query.cjs');
const {createPeerReadBrowsing} = require('../electron/peer-read-browsing.cjs');

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-02T00:00:00.000Z';
const T2 = '2026-11-03T00:00:00.000Z';
const code = expected => error => error.code === expected;
const denied = code('ACCESS_DENIED');
const invalidRequest = code('INVALID_AUTHORITY_REQUEST');
const invalidConfig = error => error.code === 'INVALID_AUTHORITY_CONFIG' &&
  error.message === 'Peer read authority is unavailable.';
const invalidQuery = error => error.code === 'INVALID_QUERY' && error.message === 'Invalid shared-data query.';
const unavailable = error => error.code === 'PEER_READ_UNAVAILABLE' &&
  error.message === 'Committed peer read state is unavailable.';
const copy = value => JSON.parse(JSON.stringify(value));

function setup(t, bootstrap = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-peer-browsing-'));
  let store;
  try { store = createStore({dbPath: path.join(root, 'owned.sqlite')}); }
  catch (error) { fs.rmSync(root, {recursive: true, force: true}); throw error; }
  const db = store.db, nativeClose = db.close;
  const f = {root, store, db, nativeClose, nativeClosed: false, nativeCloseCalls: 0,
    trusted: new WeakSet(), verifyHook: null, verifications: []};
  t.after(() => {
    try {
      // Explicit final cleanup of this test's original temporary connection,
      // not a retry through a retired/quarantined facade or an adopted DB.
      if (!f.nativeClosed) { Reflect.apply(nativeClose, db, []); f.nativeClosed = true; }
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  });
  db.close = function(...args) {
    f.nativeCloseCalls++;
    const result = Reflect.apply(nativeClose, this, args);
    if (this === db) f.nativeClosed = true;
    return result;
  };
  const group = store.saveGroup({name: 'Owned browsing fixture'});
  const insertProject = db.prepare('INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)');
  insertProject.run('project-z', group.id, 'Earlier Z', 'Owned earlier project', T0, T0);
  insertProject.run('project-a', group.id, 'Later A', 'Owned later project', T1, T1);
  const insertReview = db.prepare('INSERT INTO reviews(id,projectId,number,title,body,status,priority,category,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insertReview.run('review-z', 'project-z', 1, 'Older Z', 'Owned review Z', 'open', 'normal', 'ux', T0, T1);
  insertReview.run('review-a', 'project-z', 2, 'Older A', 'Owned review A', 'open', 'normal', 'ux', T0, T1);
  insertReview.run('review-m', 'project-z', 3, 'Newer M', 'Owned review M', 'open', 'normal', 'ux', T0, T2);
  Object.assign(f, {group, projectId: 'project-z', otherProjectId: 'project-a', reviewId: 'review-z'});
  f.verifyPeerHandle = function(peer) {
    assert.equal(this, undefined, 'The verifier must not receive the facade owner as its receiver');
    f.verifications.push(peer);
    return f.verifyHook ? f.verifyHook(peer) : f.trusted.has(peer);
  };
  if (bootstrap) f.api = createPeerReadBrowsing({store, verifyPeerHandle: f.verifyPeerHandle});
  return f;
}
function peer(f) { const value = Object.freeze(Object.create(null)); f.trusted.add(value); return value; }
function approve(f, ids = [f.projectId], handle = peer(f)) {
  assert.equal(f.api.approvePeer(handle, {projectIds: ids}), undefined); return handle;
}
function active(f, ids = [f.projectId]) {
  const handle = approve(f, ids); assert.equal(f.api.setEnabled(true), true);
  return {peer: handle, cap: f.api.openSession(handle)};
}
function expected(f, operation, payload, ids = [f.projectId]) {
  return querySharedData(f.store.snapshot(), {projectGrants: ids.map(projectId => ({projectId, read: true}))}, operation, payload);
}
function captureError(action) {
  let failure;
  try { action(); } catch (error) { failure = error; }
  assert.ok(failure, 'Expected the owned operation to fail'); return failure;
}
function state(f) {
  const tables = ['groups', 'projects', 'services', 'project_services', 'reviews', 'activities', 'attachments',
    'settings', 'agent_runs', 'agent_requests', 'dataset_meta', 'review_revisions', 'command_receipts',
    'peer_project_birth_counter', 'peer_project_births'];
  return Object.fromEntries(tables.map(table => [table,
    f.db.prepare(`SELECT * FROM ${table}`).all().map(row => ({...row}))]));
}
function sql(f, hooks, action) {
  const exec = f.db.exec, prepare = f.db.prepare;
  const trace = {exec: [], commits: 0, begins: 0, content: [], birthReads: 0};
  f.db.exec = function(statement, ...args) {
    trace.exec.push(statement);
    if (statement === 'BEGIN IMMEDIATE') trace.begins++;
    if (hooks.beforeExec) hooks.beforeExec(statement, trace);
    const result = Reflect.apply(exec, this, [statement, ...args]);
    if (statement === 'COMMIT') trace.commits++;
    if (hooks.afterExec) hooks.afterExec(statement, trace);
    return result;
  };
  f.db.prepare = function(statement, ...args) {
    const text = statement.replace(/\s+/g, ' ').trim();
    if (hooks.beforePrepare) hooks.beforePrepare(text, trace);
    const prepared = Reflect.apply(prepare, this, [statement, ...args]);
    if (/^SELECT id,name,description,createdAt,updatedAt FROM projects\b/.test(text) ||
        /^SELECT id,projectId,number,title,body,status,priority,category,createdAt,updatedAt FROM reviews\b/.test(text)) {
      const item = {sql: text, allCalls: 0, lengths: []}; trace.content.push(item);
      const all = prepared.all;
      prepared.all = function(...parameters) {
        const rows = Reflect.apply(all, this, parameters);
        item.allCalls++; item.lengths.push(rows.length); return rows;
      };
    }
    if (/FROM projects p LEFT JOIN peer_project_births\b/.test(text)) {
      const all = prepared.all;
      prepared.all = function(...parameters) {
        const rows = Reflect.apply(all, this, parameters); trace.birthReads++; return rows;
      };
    }
    return prepared;
  };
  try { return action(trace); }
  finally { f.db.exec = exec; f.db.prepare = prepare; }
}
function external(f, action) {
  const other = new DatabaseSync(f.store.dbPath);
  try { other.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;'); return action(other); }
  finally { other.close(); }
}
function externalStore(f, action) {
  const other = createStore({dbPath: f.store.dbPath});
  try { return action(other); }
  finally { other.close(); }
}
function recreateProject(db, project) {
  db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
  db.prepare('INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run(project.id, project.groupId, project.name, project.description, project.createdAt, project.updatedAt);
}
function queryProjects(f, cap) { return f.api.query(cap, 'projects.list', {}); }

test('bootstrap exposes only the frozen application API and a duplicate cannot retire its original owner', t => {
  const f = setup(t), session = active(f);
  assert.ok(Object.isFrozen(f.api));
  assert.deepEqual(Object.keys(f.api).sort(), ['approvePeer', 'closeSession', 'openSession', 'query', 'retireAndClose', 'revokePeer', 'setEnabled']);
  sql(f, {}, trace => {
    assert.throws(() => createPeerReadBrowsing({store: f.store, verifyPeerHandle: f.verifyPeerHandle}), unavailable);
    assert.deepEqual(trace.exec, []); assert.deepEqual(trace.content, []);
  });
  assert.equal(f.nativeCloseCalls, 0); assert.deepEqual(queryProjects(f, session.cap), expected(f, 'projects.list', {}));
});

test('factory accepts only its two own-data configuration fields and cannot adopt a prototype Store', t => {
  const f = setup(t, false); let getters = 0;
  const accessor = {store: f.store};
  Object.defineProperty(accessor, 'verifyPeerHandle', {get() { getters++; return f.verifyPeerHandle; }});
  const fake = Object.assign(Object.create(Object.getPrototypeOf(f.store)), {db: f.db, closed: false});
  sql(f, {}, trace => {
    for (const options of [undefined, null, {}, accessor, {store: f.store, verifyPeerHandle: null},
      {store: f.store, verifyPeerHandle: f.verifyPeerHandle, currentDataset() { throw new Error('Never called'); }}])
      assert.throws(() => createPeerReadBrowsing(options), invalidConfig);
    assert.throws(() => createPeerReadBrowsing({store: f.store, verifyPeerHandle: f.verifyPeerHandle}, {}), invalidConfig);
    assert.throws(() => createPeerReadBrowsing({store: fake, verifyPeerHandle: f.verifyPeerHandle}), unavailable);
    assert.deepEqual(trace.exec, []); assert.deepEqual(trace.content, []);
  });
  assert.equal(getters, 0); assert.equal(f.nativeCloseCalls, 0);
  f.api = createPeerReadBrowsing({store: f.store, verifyPeerHandle: f.verifyPeerHandle});
  assert.equal(queryProjects(f, active(f).cap).projects[0].id, f.projectId);
});

test('default-off approval remains disabled and original opaque capabilities never become payload credentials', t => {
  const f = setup(t), handle = approve(f);
  sql(f, {}, trace => {
    assert.throws(() => f.api.openSession(handle), denied);
    assert.throws(() => queryProjects(f, {}), denied);
    assert.deepEqual(trace.exec, []);
  });
  assert.equal(f.api.setEnabled(true), true);
  const cap = f.api.openSession(handle);
  assert.ok(Object.isFrozen(cap)); assert.equal(Object.getPrototypeOf(cap), null); assert.deepEqual(Reflect.ownKeys(cap), []);
  assert.equal(queryProjects(f, cap).projects[0].id, f.projectId);
  sql(f, {}, trace => {
    for (const foreign of [{}, copy(cap), Object.freeze(Object.create(null)), 'serialized-capability'])
      assert.throws(() => queryProjects(f, foreign), denied);
    assert.deepEqual(trace.exec, []);
  });
});

test('only the stub-recognized original object or function handle can acquire an approval', t => {
  const f = setup(t), original = function ownedIdentityHandle() {}, replacement = function ownedIdentityHandle() {};
  f.trusted.add(original);
  for (const candidate of [replacement, {}, 'peer-id', null])
    assert.throws(() => f.api.approvePeer(candidate, {projectIds: [f.projectId]}), denied);
  assert.throws(() => f.api.revokePeer('peer-id'), invalidRequest);
  approve(f, [f.projectId], original); f.api.setEnabled(true);
  const cap = f.api.openSession(original);
  assert.equal(queryProjects(f, cap).projects[0].id, f.projectId);
  assert.throws(() => f.api.openSession(replacement), denied);
  assert.equal(queryProjects(f, cap).projects[0].id, f.projectId);
});

test('closed approval input is captured without invoking accessors and malformed requests do no Store work', t => {
  const f = setup(t), handle = peer(f); let getters = 0;
  const accessor = []; Object.defineProperty(accessor, '0', {enumerable: true, get() { getters++; return f.projectId; }});
  const sparse = new Array(1), extra = [f.projectId]; extra.extra = true;
  const symbol = [f.projectId]; symbol[Symbol('extra')] = true;
  const inherited = [f.projectId]; Object.setPrototypeOf(inherited, Object.create(Array.prototype));
  const requests = [{}, {projectIds: null}, {projectIds: sparse}, {projectIds: accessor}, {projectIds: extra},
    {projectIds: symbol}, {projectIds: inherited}, {projectIds: [f.projectId, f.projectId]},
    {projectIds: ['bad/id']}, {projectIds: Array.from({length: 1001}, (_, index) => `project-${index}`)},
    {projectIds: [f.projectId], projectGrants: []}];
  const inputAccessor = {}; Object.defineProperty(inputAccessor, 'projectIds', {get() { getters++; return [f.projectId]; }});
  requests.push(inputAccessor);
  sql(f, {}, trace => {
    for (const request of requests) assert.throws(() => f.api.approvePeer(handle, request), invalidRequest);
    assert.deepEqual(trace.exec, []); assert.deepEqual(trace.content, []);
  });
  assert.equal(getters, 0); assert.deepEqual(f.verifications, []);
  approve(f, [f.projectId], handle); f.api.setEnabled(true);
  assert.equal(queryProjects(f, f.api.openSession(handle)).projects[0].id, f.projectId);
});

test('only the three closed query payloads are accepted before any Store or verifier callback', t => {
  const f = setup(t), {cap} = active(f); let getters = 0;
  const accessor = {}; Object.defineProperty(accessor, 'projectId', {get() { getters++; return f.projectId; }});
  const requests = [['attachments.list', {projectId: f.projectId, reviewId: f.reviewId}],
    ['projects.list', {projectId: f.projectId}], ['reviews.list', {}], ['reviews.list', accessor],
    ['reviews.list', {projectId: f.projectId, projectGrants: [{projectId: f.otherProjectId, read: true}]}],
    ['reviews.get', {projectId: f.projectId, reviewId: 'bad/id'}],
    ['reviews.get', Object.assign(Object.create({inherited: true}), {projectId: f.projectId, reviewId: f.reviewId})]];
  const before = f.verifications.length;
  sql(f, {}, trace => {
    for (const [operation, payload] of requests) assert.throws(() => f.api.query(cap, operation, payload), invalidQuery);
    assert.throws(() => f.api.query(cap, 'projects.list'), invalidQuery);
    assert.throws(() => f.api.query(cap, 'projects.list', {}, {}), invalidQuery);
    assert.deepEqual(trace.exec, []); assert.deepEqual(trace.content, []);
  });
  assert.equal(getters, 0); assert.equal(f.verifications.length, before);
});

test('method arity checks do not change a good approval or perform Store work', t => {
  const f = setup(t), session = active(f);
  sql(f, {}, trace => {
    for (const call of [() => f.api.setEnabled(), () => f.api.setEnabled(true, false),
      () => f.api.approvePeer(session.peer), () => f.api.approvePeer(session.peer, {projectIds: []}, {}),
      () => f.api.revokePeer(), () => f.api.revokePeer(session.peer, {}),
      () => f.api.openSession(), () => f.api.openSession(session.peer, {}),
      () => f.api.closeSession(), () => f.api.closeSession(session.cap, {}),
      () => f.api.retireAndClose({})]) assert.throws(call, invalidRequest);
    assert.deepEqual(trace.exec, []); assert.deepEqual(trace.content, []);
  });
  assert.equal(f.nativeCloseCalls, 0); assert.equal(queryProjects(f, session.cap).projects[0].id, f.projectId);
});

test('approval uses one detached ID capture when the original array changes at sample COMMIT', t => {
  const f = setup(t), handle = peer(f), ids = [f.projectId], input = {projectIds: ids};
  sql(f, {afterExec(statement, trace) {
    if (statement === 'COMMIT' && trace.commits === 1) { ids[0] = f.otherProjectId; input.projectIds = []; }
  }}, trace => {
    f.api.approvePeer(handle, input); assert.equal(trace.commits, 1); assert.equal(trace.content.length, 0);
  });
  assert.deepEqual(ids, [f.otherProjectId]); assert.deepEqual(input.projectIds, []);
  f.api.setEnabled(true); const cap = f.api.openSession(handle);
  assert.deepEqual(queryProjects(f, cap).projects.map(row => row.id), [f.projectId]);
  assert.throws(() => f.api.query(cap, 'reviews.list', {projectId: f.otherProjectId}), code('NOT_FOUND'));
});

test('query uses one detached payload capture when the verifier mutates the caller object', t => {
  const f = setup(t), {cap} = active(f), payload = {projectId: f.projectId};
  const before = expected(f, 'reviews.list', {projectId: f.projectId}); let mutations = 0;
  f.verifyHook = handle => {
    mutations++; payload.projectId = f.otherProjectId; payload.ownerProjectId = f.otherProjectId;
    return f.trusted.has(handle);
  };
  try { assert.deepEqual(f.api.query(cap, 'reviews.list', payload), before); }
  finally { f.verifyHook = null; }
  assert.ok(mutations > 0); assert.equal(payload.projectId, f.otherProjectId);
  assert.equal(queryProjects(f, cap).projects[0].id, f.projectId);
});

test('first approval revoked at metadata COMMIT cannot publish even when core revoke returns false', t => {
  const f = setup(t), handle = peer(f); let revoked;
  sql(f, {afterExec(statement, trace) {
    if (statement === 'COMMIT' && trace.commits === 1) revoked = f.api.revokePeer(handle);
  }}, trace => {
    assert.throws(() => f.api.approvePeer(handle, {projectIds: [f.projectId]}), denied);
    assert.equal(revoked, false); assert.equal(trace.commits, 1); assert.equal(trace.content.length, 0);
  });
  f.api.setEnabled(true);
  sql(f, {}, trace => { assert.throws(() => f.api.openSession(handle), denied); assert.deepEqual(trace.exec, []); });
  approve(f, [f.projectId], handle);
  assert.equal(queryProjects(f, f.api.openSession(handle)).projects[0].id, f.projectId,
    'A new operation gets a new pending identity; the cancelled first one cannot poison it');
});

test('revoke followed by another unknown revoke cannot reset first-approval cancellation', t => {
  const f = setup(t), handle = peer(f), unrelated = peer(f);
  sql(f, {afterExec(statement, trace) {
    if (statement === 'COMMIT' && trace.commits === 1) {
      assert.equal(f.api.revokePeer(handle), false); assert.equal(f.api.revokePeer(unrelated), false);
      assert.equal(f.api.revokePeer(handle), false);
    }
  }}, () => assert.throws(() => f.api.approvePeer(handle, {projectIds: [f.projectId]}), denied));
  f.api.setEnabled(true); assert.throws(() => f.api.openSession(handle), denied);
  approve(f, [f.otherProjectId], handle);
  assert.deepEqual(queryProjects(f, f.api.openSession(handle)).projects.map(row => row.id), [f.otherProjectId]);
});

test('disable cancels a pending first approval even when sharing was already disabled', t => {
  const f = setup(t), handle = peer(f);
  sql(f, {afterExec(statement, trace) {
    if (statement === 'COMMIT' && trace.commits === 1) assert.equal(f.api.setEnabled(false), false);
  }}, () => assert.throws(() => f.api.approvePeer(handle, {projectIds: [f.projectId]}), denied));
  f.api.setEnabled(true); assert.throws(() => f.api.openSession(handle), denied);
  approve(f, [f.projectId], handle);
  assert.equal(queryProjects(f, f.api.openSession(handle)).projects[0].id, f.projectId);
});

test('a caught nonrestrictive reentry changes neither authority nor the current query', t => {
  const f = setup(t), session = active(f); let attempts = 0;
  const snapshot = expected(f, 'projects.list', {});
  f.verifyHook = handle => {
    attempts++;
    for (const call of [() => f.api.approvePeer(session.peer, {projectIds: [f.otherProjectId]}),
      () => f.api.openSession(session.peer), () => queryProjects(f, session.cap),
      () => f.api.setEnabled(true), () => f.api.retireAndClose()]) assert.throws(call, invalidRequest);
    return f.trusted.has(handle);
  };
  try {
    sql(f, {}, trace => {
      assert.deepEqual(queryProjects(f, session.cap), snapshot);
      assert.equal(trace.begins, 2); assert.equal(trace.commits, 2); assert.equal(trace.content.length, 2);
    });
  } finally { f.verifyHook = null; }
  assert.equal(attempts, 4); assert.equal(f.nativeCloseCalls, 0);
  assert.deepEqual(queryProjects(f, session.cap), snapshot);
});

test('a caught actual Store write in the content verifier poisons the read instead of publishing', t => {
  const f = setup(t), session = active(f), before = state(f); let attempted = 0;
  f.verifyHook = handle => {
    if (!attempted++) assert.throws(() => f.store.upsert('projects', {id: f.projectId, name: 'Must not write'}), unavailable);
    return f.trusted.has(handle);
  };
  try {
    sql(f, {}, trace => {
      assert.throws(() => queryProjects(f, session.cap), unavailable);
      assert.deepEqual(trace.exec, ['BEGIN IMMEDIATE', 'ROLLBACK']);
      assert.deepEqual(trace.content, []);
    });
  } finally { f.verifyHook = null; }
  assert.deepEqual(state(f), before); assert.equal(queryProjects(f, session.cap).projects[0].id, f.projectId);
});

test('closing a sibling capability and revoking another peer do not cancel the queried original', t => {
  const f = setup(t), session = active(f), sibling = f.api.openSession(session.peer);
  const otherPeer = approve(f, [f.otherProjectId]), otherCap = f.api.openSession(otherPeer); let changed = false;
  f.verifyHook = handle => {
    if (!changed) {
      changed = true; assert.equal(f.api.closeSession(sibling), true); assert.equal(f.api.revokePeer(otherPeer), true);
    }
    return f.trusted.has(handle);
  };
  try { assert.deepEqual(queryProjects(f, session.cap).projects.map(row => row.id), [f.projectId]); }
  finally { f.verifyHook = null; }
  assert.equal(changed, true); assert.throws(() => queryProjects(f, sibling), denied); assert.throws(() => queryProjects(f, otherCap), denied);
  assert.equal(queryProjects(f, session.cap).projects[0].id, f.projectId);
});

test('all three DTOs preserve existing kernel ordering, errors, detachment and business state', t => {
  const f = setup(t), {cap} = active(f, [f.projectId, f.otherProjectId]), before = state(f);
  const operations = [['projects.list', {}], ['reviews.list', {projectId: f.projectId}],
    ['reviews.get', {projectId: f.projectId, reviewId: f.reviewId}]];
  for (const [operation, payload] of operations)
    assert.deepEqual(f.api.query(cap, operation, payload), expected(f, operation, payload, [f.projectId, f.otherProjectId]));
  assert.deepEqual(queryProjects(f, cap).projects.map(row => row.id), ['project-z', 'project-a']);
  assert.deepEqual(f.api.query(cap, 'reviews.list', {projectId: f.projectId}).reviews.map(row => row.id),
    ['review-m', 'review-a', 'review-z']);
  const first = queryProjects(f, cap); first.projects[0].name = 'Caller change'; first.projects.push({id: 'fake'});
  assert.deepEqual(queryProjects(f, cap), expected(f, 'projects.list', {}, [f.projectId, f.otherProjectId]));
  assert.throws(() => f.api.query(cap, 'reviews.get', {projectId: f.projectId, reviewId: 'missing-review'}),
    error => error.code === 'NOT_FOUND' && error.message === 'Shared resource not found.');
  assert.equal(f.api.query(cap, 'reviews.get', {projectId: f.projectId, reviewId: f.reviewId}).review.id, f.reviewId);
  assert.deepEqual(state(f), before);
});

test('empty grants never fall back to local all-project access and foreign resource errors stay fixed', t => {
  const f = setup(t), empty = active(f, []), ordinary = approve(f, [f.projectId]);
  assert.deepEqual(queryProjects(f, empty.cap), {version: 1, projects: []});
  assert.throws(() => f.api.query(empty.cap, 'reviews.list', {projectId: f.projectId}), code('NOT_FOUND'));
  const cap = f.api.openSession(ordinary);
  const foreign = captureError(() => f.api.query(cap, 'reviews.get', {projectId: f.otherProjectId, reviewId: f.reviewId}));
  const missing = captureError(() => f.api.query(cap, 'reviews.get', {projectId: 'missing-project', reviewId: 'missing-review'}));
  assert.equal(foreign.code, 'NOT_FOUND'); assert.equal(missing.code, foreign.code); assert.equal(missing.message, foreign.message);
  assert.equal(queryProjects(f, cap).projects[0].id, f.projectId);
});

test('a successful query has one real content SELECT pair and one fresh release sample, without public snapshot fallback', t => {
  const f = setup(t), {cap} = active(f), before = expected(f, 'reviews.list', {projectId: f.projectId});
  const snapshot = f.store.snapshot, dataset = f.store.peerReadDataset;
  f.store.snapshot = () => { throw new Error('Public snapshot fallback is forbidden'); };
  f.store.peerReadDataset = () => { throw new Error('Public dataset fallback is forbidden'); };
  try {
    sql(f, {}, trace => {
      assert.deepEqual(f.api.query(cap, 'reviews.list', {projectId: f.projectId}), before);
      assert.equal(trace.begins, 2); assert.equal(trace.commits, 2); assert.equal(trace.birthReads, 2);
      assert.equal(trace.content.length, 2); assert.ok(trace.content.every(row => row.allCalls === 1));
      assert.deepEqual(trace.content.map(row => row.lengths), [[2], [3]]);
    });
  } finally { f.store.snapshot = snapshot; f.store.peerReadDataset = dataset; }
});

test('an ordinary review edit after content COMMIT returns the old content DTO without replay', t => {
  const f = setup(t), {cap} = active(f), before = expected(f, 'reviews.get', {projectId: f.projectId, reviewId: f.reviewId});
  external(f, other => sql(f, {afterExec(statement, trace) {
    if (statement === 'COMMIT' && trace.commits === 1)
      other.prepare('UPDATE reviews SET title=?,updatedAt=? WHERE id=?').run('Committed later title', T2, f.reviewId);
  }}, trace => {
    assert.deepEqual(f.api.query(cap, 'reviews.get', {projectId: f.projectId, reviewId: f.reviewId}), before);
    assert.equal(trace.commits, 2); assert.equal(trace.content.length, 2);
    assert.ok(trace.content.every(row => row.allCalls === 1));
  }));
  assert.equal(f.store.get('reviews', f.reviewId).title, 'Committed later title');
  assert.equal(f.api.query(cap, 'reviews.get', {projectId: f.projectId, reviewId: f.reviewId}).review.title, 'Committed later title');
});

for (const stage of [1, 2]) for (const restriction of ['revoke', 'close', 'disable'])
  test(`${restriction} at ${stage === 1 ? 'content' : 'release'} COMMIT withholds the DTO and never retries content`, t => {
    const f = setup(t), session = active(f); let restrictions = 0;
    sql(f, {afterExec(statement, trace) {
      if (statement !== 'COMMIT' || trace.commits !== stage) return;
      restrictions++;
      if (restriction === 'revoke') assert.equal(f.api.revokePeer(session.peer), true);
      if (restriction === 'close') assert.equal(f.api.closeSession(session.cap), true);
      if (restriction === 'disable') assert.equal(f.api.setEnabled(false), false);
    }}, trace => {
      assert.throws(() => queryProjects(f, session.cap), denied);
      assert.equal(restrictions, 1); assert.equal(trace.commits, stage); assert.equal(trace.content.length, 2);
      assert.ok(trace.content.every(row => row.allCalls === 1));
    });
    sql(f, {}, trace => { assert.throws(() => queryProjects(f, session.cap), denied); assert.deepEqual(trace.exec, []); });
    if (restriction === 'revoke') approve(f, [f.projectId], session.peer);
    if (restriction === 'disable') f.api.setEnabled(true);
    const replacement = f.api.openSession(session.peer);
    assert.equal(queryProjects(f, replacement).projects[0].id, f.projectId);
    assert.throws(() => queryProjects(f, session.cap), denied);
  });

for (const verifierStage of [1, 2, 3, 4])
  test(`a restrictive revoke in verifier stage ${verifierStage} withholds data and cannot be repaired by replay`, t => {
    const f = setup(t), session = active(f); let calls = 0;
    f.verifyHook = handle => {
      if (++calls === verifierStage) assert.equal(f.api.revokePeer(session.peer), true);
      return f.trusted.has(handle);
    };
    try {
      sql(f, {}, trace => {
        assert.throws(() => queryProjects(f, session.cap), denied);
        assert.equal(calls, verifierStage); assert.equal(trace.content.length, verifierStage === 1 ? 0 : 2);
        assert.ok(trace.content.every(row => row.allCalls === 1));
      });
    } finally { f.verifyHook = null; }
    sql(f, {}, trace => { assert.throws(() => queryProjects(f, session.cap), denied); assert.deepEqual(trace.exec, []); });
    approve(f, [f.projectId], session.peer);
    assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
  });

test('same-ID rebirth between content and release revokes the whole binding without an observed absence', t => {
  const f = setup(t), session = active(f, [f.projectId, f.otherProjectId]);
  const project = {...f.store.get('projects', f.otherProjectId)};
  const oldBirth = f.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(project.id).birth;
  external(f, other => sql(f, {afterExec(statement, trace) {
    if (statement === 'COMMIT' && trace.commits === 1) recreateProject(other, project);
  }}, trace => {
    assert.throws(() => f.api.query(session.cap, 'reviews.get', {projectId: f.projectId, reviewId: f.reviewId}), denied);
    assert.equal(trace.commits, 2); assert.equal(trace.content.length, 2);
  }));
  assert.ok(f.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(project.id).birth > oldBirth);
  sql(f, {}, trace => {
    assert.throws(() => queryProjects(f, session.cap), denied);
    assert.throws(() => f.api.openSession(session.peer), denied); assert.deepEqual(trace.exec, []);
  });
  approve(f, [f.projectId], session.peer);
  assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
  assert.throws(() => queryProjects(f, session.cap), denied);
});

test('a second genuine Store logical import after content COMMIT is seen by the fresh release sample', t => {
  const f = setup(t), session = active(f), epoch = f.store.peerReadDataset().epoch;
  externalStore(f, other => {
    const backup = other.exportData(); let imports = 0;
    sql(f, {afterExec(statement, trace) {
      if (statement === 'COMMIT' && trace.commits === 1) { other.importData(backup); imports++; }
    }}, trace => {
      assert.throws(() => f.api.query(session.cap, 'reviews.get', {projectId: f.projectId, reviewId: f.reviewId}), denied);
      assert.equal(imports, 1); assert.equal(trace.commits, 2); assert.equal(trace.content.length, 2);
      assert.ok(trace.content.every(row => row.allCalls === 1));
    });
    assert.notEqual(other.peerReadDataset().epoch, epoch, 'The independent Store committed a real logical import');
  });
  assert.notEqual(f.store.peerReadDataset().epoch, epoch);
  sql(f, {}, trace => { assert.throws(() => queryProjects(f, session.cap), denied); assert.deepEqual(trace.exec, []); });
  approve(f, [f.projectId], session.peer);
  assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
  assert.throws(() => queryProjects(f, session.cap), denied);
});

test('fresh explicit approval can renew an unobserved same-ID rebirth but cannot revive its old capability', t => {
  const f = setup(t), session = active(f), project = {...f.store.get('projects', f.projectId)};
  // Use the empty project for the replacement so this fixture preserves the
  // saved reviews; both IDs remain in the new explicitly approved binding.
  const empty = {...f.store.get('projects', f.otherProjectId)};
  approve(f, [project.id, empty.id], session.peer);
  const old = f.api.openSession(session.peer);
  const birth = f.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(empty.id).birth;
  recreateProject(f.db, empty);
  assert.ok(f.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(empty.id).birth > birth);
  // No query/open observes the replacement before this fresh local approval.
  approve(f, [project.id, empty.id], session.peer);
  const fresh = f.api.openSession(session.peer);
  assert.deepEqual(queryProjects(f, fresh).projects.map(row => row.id), [project.id, empty.id]);
  assert.throws(() => queryProjects(f, old), denied); assert.throws(() => queryProjects(f, session.cap), denied);
});

test('real revoke at fresh-reapproval COMMIT cancels the candidate even when automatic birth sync also retires the old binding', t => {
  const f = setup(t), session = active(f, [f.projectId, f.otherProjectId]);
  recreateProject(f.db, {...f.store.get('projects', f.otherProjectId)});
  let revocations = 0;
  sql(f, {afterExec(statement, trace) {
    if (statement === 'COMMIT' && trace.commits === 1) {
      revocations++; assert.equal(f.api.revokePeer(session.peer), true);
    }
  }}, () => assert.throws(() => f.api.approvePeer(session.peer, {projectIds: [f.projectId, f.otherProjectId]}), denied));
  assert.equal(revocations, 1); assert.throws(() => queryProjects(f, session.cap), denied);
  assert.throws(() => f.api.openSession(session.peer), denied);
  approve(f, [f.projectId], session.peer);
  assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
});

test('observed project deletion revokes an entire affected binding while unrelated peer and project survive', t => {
  const f = setup(t), affected = active(f, [f.projectId, f.otherProjectId]);
  const unaffectedPeer = approve(f, [f.projectId]), unaffected = f.api.openSession(unaffectedPeer);
  const removed = {...f.store.get('projects', f.otherProjectId)};
  f.db.prepare('DELETE FROM projects WHERE id=?').run(removed.id);
  assert.equal(queryProjects(f, unaffected).projects[0].id, f.projectId);
  assert.throws(() => queryProjects(f, affected.cap), denied);
  assert.throws(() => f.api.openSession(affected.peer), denied);
  f.db.prepare('INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run(removed.id, removed.groupId, removed.name, removed.description, removed.createdAt, removed.updatedAt);
  assert.throws(() => queryProjects(f, affected.cap), denied);
  assert.equal(queryProjects(f, unaffected).projects[0].id, f.projectId);
  approve(f, [f.projectId, f.otherProjectId], affected.peer);
  assert.equal(queryProjects(f, f.api.openSession(affected.peer)).projects.length, 2);
});

test('metadata edits and an unrelated new birth do not invalidate an unaffected approval', t => {
  const f = setup(t), session = active(f);
  const birth = f.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(f.projectId).birth;
  f.store.saveProject({id: f.projectId, name: 'Ordinary current name'});
  f.store.saveProject({groupId: f.group.id, name: 'Unrelated new project'});
  assert.equal(f.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(f.projectId).birth, birth);
  assert.deepEqual(queryProjects(f, session.cap).projects.map(row => [row.id, row.name]), [[f.projectId, 'Ordinary current name']]);
});

test('logical import rotates the epoch and old originals remain denied after matching IDs return', t => {
  const f = setup(t), session = active(f), backup = f.store.exportData(), before = f.store.peerReadDataset().epoch;
  f.store.importData(backup); assert.notEqual(f.store.peerReadDataset().epoch, before);
  assert.throws(() => queryProjects(f, session.cap), denied);
  assert.throws(() => f.api.openSession(session.peer), denied);
  approve(f, [f.projectId], session.peer);
  assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
  assert.throws(() => queryProjects(f, session.cap), denied);
});

test('recoverable metadata SQL failure rolls back without stale scope fallback or invented birth revocation', t => {
  const f = setup(t), session = active(f), failure = new Error('Owned metadata prepare failure'); let injected = false;
  sql(f, {beforePrepare(statement) {
    if (!injected && /FROM peer_project_birth_counter\b/.test(statement)) { injected = true; throw failure; }
  }}, trace => {
    assert.equal(captureError(() => queryProjects(f, session.cap)), failure);
    assert.deepEqual(trace.exec, ['BEGIN IMMEDIATE', 'ROLLBACK']); assert.deepEqual(trace.content, []);
  });
  assert.equal(queryProjects(f, session.cap).projects[0].id, f.projectId);
  assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
});

test('temporarily corrupt birth metadata is not treated as a confirmed deletion or empty dataset', t => {
  const f = setup(t), session = active(f);
  const row = {...f.db.prepare('SELECT * FROM peer_project_births WHERE projectId=?').get(f.projectId)};
  f.db.prepare('DELETE FROM peer_project_births WHERE projectId=?').run(f.projectId);
  try {
    sql(f, {}, trace => {
      assert.throws(() => queryProjects(f, session.cap), unavailable);
      assert.deepEqual(trace.content, []); assert.equal(trace.commits, 0); assert.ok(trace.exec.includes('ROLLBACK'));
    });
  } finally { f.db.prepare('INSERT INTO peer_project_births(projectId,birth) VALUES(?,?)').run(row.projectId, row.birth); }
  assert.equal(queryProjects(f, session.cap).projects[0].id, f.projectId);
});

test('a release metadata failure withholds content and the next operation obtains fresh scopes', t => {
  const f = setup(t), session = active(f), failure = new Error('Owned release metadata failure');
  sql(f, {beforePrepare(statement, trace) {
    if (trace.commits === 1 && /FROM peer_project_birth_counter\b/.test(statement)) throw failure;
  }}, trace => {
    assert.equal(captureError(() => queryProjects(f, session.cap)), failure);
    assert.equal(trace.begins, 2); assert.equal(trace.commits, 1); assert.equal(trace.content.length, 2);
    assert.ok(trace.exec.includes('ROLLBACK'));
  });
  const other = approve(f, [f.otherProjectId]);
  assert.deepEqual(queryProjects(f, f.api.openSession(other)).projects.map(row => row.id), [f.otherProjectId]);
  assert.deepEqual(queryProjects(f, session.cap).projects.map(row => row.id), [f.projectId]);
});

test('confirmed approval replacement permanently retires originals and invalid input does not replace a good binding', t => {
  const f = setup(t), session = active(f);
  assert.throws(() => f.api.approvePeer(session.peer, {projectIds: [f.projectId, f.projectId]}), invalidRequest);
  assert.equal(queryProjects(f, session.cap).projects[0].id, f.projectId);
  approve(f, [f.otherProjectId], session.peer);
  sql(f, {}, trace => { assert.throws(() => queryProjects(f, session.cap), denied); assert.deepEqual(trace.exec, []); });
  const replacement = f.api.openSession(session.peer);
  assert.deepEqual(queryProjects(f, replacement).projects.map(row => row.id), [f.otherProjectId]);
  assert.equal(f.api.closeSession(session.cap), false); assert.equal(f.api.closeSession(replacement), true);
  assert.equal(f.api.closeSession(replacement), false);
});

test('published approvals keep the existing 64-peer bound and revocation releases its slot', t => {
  const f = setup(t);
  for (let index = 0; index < 65; index++)
    assert.throws(() => f.api.approvePeer({}, {projectIds: []}), denied);
  const handles = Array.from({length: 64}, () => approve(f, []));
  const candidate = peer(f);
  assert.throws(() => f.api.approvePeer(candidate, {projectIds: []}), code('AUTHORITY_LIMIT_EXCEEDED'));
  assert.equal(f.api.revokePeer(handles[0]), true);
  approve(f, [f.projectId], candidate); f.api.setEnabled(true);
  assert.equal(queryProjects(f, f.api.openSession(candidate)).projects[0].id, f.projectId);
  assert.throws(() => f.api.openSession(handles[0]), denied);
});

test('disable and re-enable do not revive old originals or discard a retained approval', t => {
  const f = setup(t), session = active(f);
  assert.equal(f.api.setEnabled(false), false); assert.equal(f.api.setEnabled(false), false);
  sql(f, {}, trace => { assert.throws(() => queryProjects(f, session.cap), denied); assert.deepEqual(trace.exec, []); });
  assert.equal(f.api.setEnabled(true), true); assert.throws(() => queryProjects(f, session.cap), denied);
  assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
});

test('strict verifier failure retires old generations, retains approval and frees all 256 core live slots', t => {
  const f = setup(t), handle = approve(f); f.api.setEnabled(true);
  const old = Array.from({length: 256}, () => f.api.openSession(handle));
  assert.throws(() => f.api.openSession(handle), code('AUTHORITY_LIMIT_EXCEEDED'));
  f.verifyHook = () => false;
  try { assert.throws(() => queryProjects(f, old[0]), denied); }
  finally { f.verifyHook = null; }
  sql(f, {}, trace => { for (const cap of old) assert.throws(() => queryProjects(f, cap), denied); assert.deepEqual(trace.exec, []); });
  const fresh = Array.from({length: 256}, () => f.api.openSession(handle));
  assert.throws(() => f.api.openSession(handle), code('AUTHORITY_LIMIT_EXCEEDED'));
  assert.equal(queryProjects(f, fresh[0]).projects[0].id, f.projectId);
  for (const cap of old) assert.equal(f.api.closeSession(cap), false);
  for (const cap of fresh) assert.equal(f.api.closeSession(cap), true);
  // Keep both arrays strongly retained by this caller. The facade must not
  // charge their retired weak records against a second independent quota.
  const again = Array.from({length: 256}, () => f.api.openSession(handle));
  assert.throws(() => f.api.openSession(handle), code('AUTHORITY_LIMIT_EXCEEDED'));
  assert.equal(queryProjects(f, again[0]).projects[0].id, f.projectId);
  for (const cap of again) assert.equal(f.api.closeSession(cap), true);
  assert.equal(old.length + fresh.length + again.length, 768);
});

test('a thrown or non-boolean verifier outcome is strict failure, not a permanent approval deletion', t => {
  for (const outcome of ['throw', 'truthy']) {
    const f = setup(t), session = active(f), second = f.api.openSession(session.peer), original = new Error('Owned verifier exception');
    f.verifyHook = () => { if (outcome === 'throw') throw original; return 1; };
    try { assert.throws(() => queryProjects(f, session.cap), denied); }
    finally { f.verifyHook = null; }
    assert.throws(() => queryProjects(f, session.cap), denied); assert.throws(() => queryProjects(f, second), denied);
    assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
  }
});

for (const verifierStage of [2, 3, 4])
  test(`strict verifier failure at stage ${verifierStage} retires originals even after content was materialized`, t => {
    const f = setup(t), session = active(f); let calls = 0;
    f.verifyHook = handle => ++calls === verifierStage ? false : f.trusted.has(handle);
    try {
      sql(f, {}, trace => {
        assert.throws(() => queryProjects(f, session.cap), denied);
        assert.equal(calls, verifierStage); assert.equal(trace.content.length, 2);
        assert.ok(trace.content.every(row => row.allCalls === 1));
      });
    } finally { f.verifyHook = null; }
    sql(f, {}, trace => { assert.throws(() => queryProjects(f, session.cap), denied); assert.deepEqual(trace.exec, []); });
    assert.equal(queryProjects(f, f.api.openSession(session.peer)).projects[0].id, f.projectId);
  });

test('verifier failure for one peer leaves another binding and its original session unaffected', t => {
  const f = setup(t), first = active(f), secondPeer = approve(f, [f.otherProjectId]), second = f.api.openSession(secondPeer);
  f.verifyHook = handle => handle !== first.peer && f.trusted.has(handle);
  try { assert.throws(() => queryProjects(f, first.cap), denied); }
  finally { f.verifyHook = null; }
  assert.deepEqual(queryProjects(f, second).projects.map(row => row.id), [f.otherProjectId]);
  assert.throws(() => queryProjects(f, first.cap), denied);
});

test('known missing, closed and foreign capabilities are refused without a Store interval', t => {
  const f = setup(t), session = active(f), unknownPeer = peer(f);
  assert.equal(f.api.closeSession(session.cap), true);
  sql(f, {}, trace => {
    assert.throws(() => queryProjects(f, session.cap), denied);
    assert.throws(() => f.api.openSession(unknownPeer), denied);
    assert.throws(() => f.api.closeSession({}), denied);
    assert.throws(() => queryProjects(f, {}), denied);
    assert.deepEqual(trace.exec, []); assert.deepEqual(trace.content, []);
  });
});

test('confirmed COMMIT failure preserves its original diagnostic and the original Store can recover', t => {
  const f = setup(t), session = active(f), primary = new Error('Owned COMMIT refusal'); let once = false;
  sql(f, {beforeExec(statement) { if (!once && statement === 'COMMIT') { once = true; throw primary; } }}, trace => {
    assert.equal(captureError(() => queryProjects(f, session.cap)), primary);
    assert.deepEqual(trace.exec, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']); assert.equal(trace.content.length, 2);
  });
  assert.equal(queryProjects(f, session.cap).projects[0].id, f.projectId);
});

test('unknown BEGIN ownership quarantines the original and never rolls back a raw caller transaction', t => {
  const f = setup(t), session = active(f);
  f.db.exec('BEGIN IMMEDIATE');
  try {
    f.db.prepare('UPDATE projects SET name=? WHERE id=?').run('Owned uncommitted caller name', f.projectId);
    sql(f, {}, trace => {
      const failure = captureError(() => queryProjects(f, session.cap)); assert.ok(unavailable(failure)); assert.ok(failure.cause);
      assert.deepEqual(trace.exec, ['BEGIN IMMEDIATE']); assert.deepEqual(trace.content, []);
    });
    assert.equal(f.db.prepare('SELECT name FROM projects WHERE id=?').get(f.projectId).name, 'Owned uncommitted caller name');
  } finally { f.db.exec('ROLLBACK'); }
  assert.throws(() => queryProjects(f, session.cap), unavailable);
  assert.equal(f.api.retireAndClose(), undefined); assert.equal(f.nativeCloseCalls, 1); assert.equal(f.nativeClosed, true);
});

test('rollback failure preserves both diagnostics, withholds content and cannot be healed by a later raw rollback', t => {
  const f = setup(t), session = active(f), primary = new Error('Owned COMMIT failure'), cleanup = new Error('Owned rollback failure');
  sql(f, {beforeExec(statement) { if (statement === 'COMMIT') throw primary; if (statement === 'ROLLBACK') throw cleanup; }}, trace => {
    const failure = captureError(() => queryProjects(f, session.cap));
    assert.ok(failure instanceof AggregateError); assert.ok(unavailable(failure));
    assert.deepEqual(failure.errors, [primary, cleanup]); assert.equal(failure.cause, primary);
    assert.deepEqual(trace.exec, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']); assert.equal(trace.content.length, 2);
  });
  f.db.exec('ROLLBACK');
  assert.throws(() => queryProjects(f, session.cap), unavailable);
  f.api.retireAndClose(); assert.equal(f.nativeCloseCalls, 1); assert.equal(f.nativeClosed, true);
});

test('idle retirement closes the exact original once and permanently retires all authority', t => {
  const f = setup(t), session = active(f);
  assert.equal(f.api.retireAndClose(), undefined); assert.equal(f.nativeClosed, true); assert.equal(f.nativeCloseCalls, 1);
  assert.equal(f.api.retireAndClose(), undefined); assert.equal(f.nativeCloseCalls, 1);
  assert.throws(() => queryProjects(f, session.cap), denied);
  assert.throws(() => f.api.openSession(session.peer), denied);
  assert.throws(() => f.api.approvePeer(session.peer, {projectIds: [f.projectId]}), denied);
  assert.throws(() => f.api.setEnabled(true), denied);
  assert.throws(() => f.api.setEnabled(false), denied);
  assert.throws(() => f.api.closeSession(session.cap), denied);
  assert.throws(() => f.api.revokePeer(session.peer), denied);
});

test('ordinary successful Store close is not repeated by facade retirement', t => {
  const f = setup(t), session = active(f);
  f.store.close(); assert.equal(f.nativeCloseCalls, 1); assert.equal(f.nativeClosed, true);
  assert.throws(() => queryProjects(f, session.cap), unavailable);
  f.api.retireAndClose(); f.api.retireAndClose(); assert.equal(f.nativeCloseCalls, 1);
});

test('a failed owned native close is terminal, never retried and cannot revive approval', t => {
  const f = setup(t), session = active(f), close = f.db.close, failure = new Error('Owned close outcome unavailable'); let attempts = 0;
  f.db.close = function() { attempts++; throw failure; };
  try {
    const actual = captureError(() => f.api.retireAndClose()); assert.ok(unavailable(actual)); assert.equal(actual.cause, failure);
    assert.throws(() => queryProjects(f, session.cap), denied);
    assert.throws(() => f.api.openSession(session.peer), denied);
    assert.throws(() => f.api.retireAndClose(), denied); assert.equal(attempts, 1);
  } finally { f.db.close = close; }
  assert.equal(f.nativeClosed, false, 'The failed close must not be recorded as confirmed native closure');
});
