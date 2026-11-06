'use strict';

// Pure-source cases test the internal kernel
// contract; only the owned SQLite cases establish driver projection behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createStore, createPeerReadStoreBridge} = require('../electron/store.cjs');
const {createPeerReadBrowsing} = require('../electron/peer-read-browsing.cjs');
const {querySharedData, querySharedBrowsing} = require('../electron/shared-data-query.cjs');
const {encodingByteFactors} = require('../electron/sqlite-read-bounds.cjs');
const MAX = 1024 * 1024, HUGE = 2 * 1024 * 1024;
const T0 = '2026-11-01T00:00:00.000Z', T1 = '2026-11-02T00:00:00.000Z', T2 = '2026-11-03T00:00:00.000Z';
const invalid = error => error.code === 'INVALID_SNAPSHOT' && error.message === 'Shared data is unavailable.';
const limit = error => error.code === 'BROWSING_QUERY_LIMIT_EXCEEDED' && error.message === 'Shared browsing response exceeds the read limit.';
const unavailable = error => error.code === 'PEER_READ_UNAVAILABLE' && error.message === 'Committed peer read state is unavailable.';
const context = (...ids) => ({projectGrants: ids.map(projectId => ({projectId, read: true}))});

function setup(t, {encoding = 'UTF-8', reviews = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-browsing-bounds-')), dbPath = path.join(root, 'owned.sqlite');
  if (encoding !== 'UTF-8') {
    const initial = new DatabaseSync(dbPath); let primary, failed = false;
    // A real owned table persists the selected encoding before Store opens it.
    // If this original close fails, do not remove/retry its unknown connection.
    try { initial.exec(`PRAGMA encoding='${encoding}'; CREATE TABLE owned_encoding_anchor(value TEXT)`); }
    catch (error) { failed = true; primary = error; }
    finally {
      try { initial.close(); }
      catch (cleanup) { throw failed ? new AggregateError([primary, cleanup], 'Fixture setup and close failed.', {cause: primary}) : cleanup; }
    }
    if (failed) { fs.rmSync(root, {recursive: true, force: true}); throw primary; }
  }
  let store;
  try { store = createStore({dbPath}); }
  catch (error) { fs.rmSync(root, {recursive: true, force: true}); throw error; }
  const db = store.db, nativeClose = db.close;
  let nativeClosed = false;
  t.after(() => {
    try { if (!nativeClosed) { Reflect.apply(nativeClose, db, []); nativeClosed = true; } }
    finally { if (nativeClosed) fs.rmSync(root, {recursive: true, force: true}); }
  });
  db.close = function(...args) {
    const result = Reflect.apply(nativeClose, this, args); if (this === db) nativeClosed = true; return result;
  };
  assert.equal(db.prepare('PRAGMA encoding').get().encoding, encoding);
  const group = store.saveGroup({name: 'Owned bounds fixture'});
  const insert = db.prepare('INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)');
  insert.run('project-z', group.id, 'Earlier Z', '', T0, T0);
  insert.run('project-a', group.id, 'Later A', '', T1, T1);
  if (reviews) {
    addReview(db, 'review-z', 'project-z', 1, T1); addReview(db, 'review-a', 'project-z', 2, T1);
    addReview(db, 'review-m', 'project-z', 3, T2); addReview(db, 'review-b', 'project-a', 1, T0);
  }
  return {root, store, db, group, projectId: 'project-z', otherProjectId: 'project-a', reviewId: 'review-z'};
}
function addReview(db, id, projectId, number, updatedAt = T1, body = '') {
  db.prepare('INSERT INTO reviews(id,projectId,number,title,body,status,priority,category,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, projectId, number, `Owned ${id}`, body, 'open', 'normal', 'ux', T0, updatedAt);
}
function reader(f, grants = context(f.projectId), operation = 'projects.list', payload = {}) {
  const request = {operation, payload};
  const bridge = createPeerReadStoreBridge(f.store, view => view.query(grants, request.operation, request.payload));
  return {bridge, request, read(op = request.operation, input = request.payload) {
    request.operation = op; request.payload = input; return bridge.read();
  }};
}
function legacy(f, grants, operation, payload) { return querySharedData(f.store.snapshot(), grants, operation, payload); }
function driver(f, action) {
  const prepare = f.db.prepare, exec = f.db.exec, calls = [], executions = [];
  f.db.exec = function(sql, ...args) { executions.push(sql); return Reflect.apply(exec, this, [sql, ...args]); };
  f.db.prepare = function(sql, ...args) {
    const statement = Reflect.apply(prepare, this, [sql, ...args]), text = sql.replace(/\s+/g, ' ').trim();
    for (const method of ['get', 'all']) {
      const original = statement[method];
      statement[method] = function(...parameters) {
        const result = Reflect.apply(original, this, parameters), rows = method === 'all' ? result : result ? [result] : [];
        calls.push({sql: text, method, parameters, length: rows.length,
          samples: rows.map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field,
            typeof value === 'string' ? {type: 'string', units: value.length} :
              ArrayBuffer.isView(value) ? {type: 'binary', bytes: value.byteLength} : value])))});
        return result;
      };
    }
    return statement;
  };
  try { return action({calls, executions}); }
  finally { f.db.prepare = prepare; f.db.exec = exec; }
}
function noGiantValue(trace) {
  for (const call of trace.calls) for (const row of call.samples) for (const value of Object.values(row)) {
    if (value?.type === 'string') assert.ok(value.units <= 300000, 'No giant text value may cross the selected driver projection');
    assert.notEqual(value?.type, 'binary', 'No BLOB cell may cross a text-only projection');
    assert.notEqual(typeof value, 'bigint');
  }
  for (const call of trace.calls.filter(call => call.method === 'all')) for (const row of call.samples) {
    assert.equal(Object.hasOwn(row, 'description'), false); assert.equal(Object.hasOwn(row, 'body'), false);
  }
}
function giant(db, table, column, id) {
  db.prepare(`UPDATE ${table} SET ${column}=replace(hex(zeroblob(?)),'00','x') WHERE id=?`).run(HUGE, id);
}
function pureProject(id, key, createdAt = T0) {
  return {_readKey: key, id, name: `Owned ${id}`, description: '', createdAt, updatedAt: createdAt};
}
function pureReview(id, key, projectId, number = 1, updatedAt = T1) {
  return {_readKey: key, id, projectId, number, title: `Owned ${id}`, body: '', status: 'open', priority: 'normal',
    category: 'ux', createdAt: T0, updatedAt};
}
function sourceFor(projects, reviews, calls = []) {
  return Object.freeze({
    count(kind) { calls.push(`count:${kind}`); return kind === 'projects' ? projects.length : reviews.length; },
    projectKeys() { calls.push('projectKeys'); return projects.map(row => ({key: row._readKey, id: row.id})); },
    project(key) { calls.push(`project:${key}`); return projects.find(row => row._readKey === key); },
    reviewProjectKeys() { calls.push('reviewProjectKeys'); return reviews.map(row => ({key: row._readKey, projectId: row.projectId})); },
    reviewId(key) { calls.push(`reviewId:${key}`); const row = reviews.find(row => row._readKey === key); return row && {_readKey: key, id: row.id}; },
    review(key) { calls.push(`review:${key}`); return reviews.find(row => row._readKey === key); }
  });
}
const withSource = (source, changes) => Object.freeze({...source, ...changes});

test('encoding factors preserve UTF8 and both UTF16 formats without a permissive fallback', () => {
  for (const [encoding, general, ascii] of [['UTF-8', 3, 1], ['UTF-16le', 2, 2], ['UTF-16be', 2, 2]]) {
    const actual = encodingByteFactors(encoding); assert.deepEqual(actual, {encoding, general, ascii}); assert.ok(Object.isFrozen(actual));
  }
  for (const unknown of [undefined, null, '', 'utf8', 'UTF-32', {}, 8]) assert.equal(encodingByteFactors(unknown), null);
});

test('internal source validation preserves grants/payload then project-count-before-review-count order', () => {
  const calls = [], base = sourceFor([], [], calls);
  assert.throws(() => querySharedBrowsing(base, {}, 'projects.list', {}), error => error.code === 'ACCESS_DENIED');
  assert.deepEqual(calls, []);
  assert.throws(() => querySharedBrowsing(base, context(), 'comments.list', {}), error => error.code === 'INVALID_QUERY');
  assert.deepEqual(calls, []);
  const overflow = Object.freeze({...base, count(kind) { calls.push(`count:${kind}`); if (kind === 'projects') return 100001; throw new Error('Must not query later table'); }});
  assert.throws(() => querySharedBrowsing(overflow, context(), 'projects.list', {}), invalid);
  assert.deepEqual(calls, ['count:projects']);
});

test('admitted counts must equal real key-array lengths and never accept an empty surrogate', () => {
  const project = pureProject('project-z', '1'), review = pureReview('review-z', '1', project.id), calls = [];
  const base = sourceFor([project], [review], calls);
  assert.throws(() => querySharedBrowsing(withSource(base, {projectKeys: () => []}), context(project.id), 'projects.list', {}), invalid);
  assert.throws(() => querySharedBrowsing(withSource(base, {reviewProjectKeys: () => []}), context(project.id), 'reviews.list', {projectId: project.id}), invalid);
  const ungranted = sourceFor([project], [review], []);
  assert.throws(() => querySharedBrowsing(withSource(ungranted, {projectKeys() { throw new Error('No field scan after foreign grant'); }}),
    context(), 'reviews.get', {projectId: project.id, reviewId: review.id}), error => error.code === 'NOT_FOUND');
});

test('unconsumed source fields remain unread and selected project validation still precedes review fields', () => {
  const A = pureProject('project-z', '1'), B = pureProject('project-a', '2');
  const own = pureReview('review-z', '1', A.id), otherOwn = pureReview('review-other', '2', A.id), foreign = pureReview('review-b', '3', B.id);
  const forbidden = () => { throw new Error('Unconsumed field was accessed'); };
  Object.defineProperty(B, 'description', {get: forbidden}); Object.defineProperty(otherOwn, 'body', {get: forbidden});
  Object.defineProperty(foreign, 'id', {get: forbidden}); Object.defineProperty(foreign, 'body', {get: forbidden});
  const calls = [], source = sourceFor([A, B], [own, otherOwn, foreign], calls);
  assert.equal(querySharedBrowsing(source, context(A.id), 'projects.list', {}).projects[0].id, A.id);
  assert.equal(calls.includes('reviewProjectKeys'), false);
  assert.equal(querySharedBrowsing(source, context(A.id), 'reviews.get', {projectId: A.id, reviewId: own.id}).review.id, own.id);
  assert.ok(calls.includes('reviewId:2')); assert.equal(calls.includes('review:2'), false); assert.equal(calls.includes('reviewId:3'), false);
  const bad = pureProject('project-z', '1'); Object.defineProperty(bad, 'description', {get: forbidden});
  const stages = [], badSource = sourceFor([bad], [own], stages);
  assert.throws(() => querySharedBrowsing(badSource, context(bad.id), 'reviews.get', {projectId: bad.id, reviewId: own.id}), invalid);
  assert.equal(stages.includes('reviewProjectKeys'), false);
});

test('point source rows cannot switch key, project selector or selected review identity', () => {
  const A = pureProject('project-z', '1'), R = pureReview('review-z', '1', A.id), base = sourceFor([A], [R]);
  for (const project of [() => undefined, () => ({...A, _readKey: '2'}), () => ({...A, id: 'project-b'})])
    assert.throws(() => querySharedBrowsing(withSource(base, {project}), context(A.id), 'projects.list', {}), invalid);
  assert.throws(() => querySharedBrowsing(withSource(base, {reviewId: () => ({_readKey: '2', id: R.id})}), context(A.id), 'reviews.get', {projectId: A.id, reviewId: R.id}), invalid);
  for (const review of [() => undefined, () => ({...R, _readKey: '2'}), () => ({...R, projectId: 'project-b'}), () => ({...R, id: 'review-b'})])
    assert.throws(() => querySharedBrowsing(withSource(base, {review}), context(A.id), 'reviews.get', {projectId: A.id, reviewId: R.id}), invalid);
});

test('pure kernel accounting handles every JSON string escape without invoking an encoder', () => {
  const A = pureProject('project-z', '1'), R = pureReview('review-z', '1', A.id);
  const pattern = '"\\\b\f\n\r\t\u0001é漢🙂\ud800\udc00\ud800x\udc00';
  A.description = pattern; R.title = pattern; R.body = pattern.repeat(500);
  const source = sourceFor([A], [R]), snapshot = {projects: [A], reviews: [R]};
  for (const [operation, payload] of [['projects.list', {}], ['reviews.list', {projectId: A.id}], ['reviews.get', {projectId: A.id, reviewId: R.id}]]) {
    const expected = querySharedData(snapshot, context(A.id), operation, payload), stringify = JSON.stringify;
    let actual;
    JSON.stringify = () => { throw new Error('Protected code must count rather than encode JSON'); };
    try { actual = querySharedBrowsing(source, context(A.id), operation, payload); }
    finally { JSON.stringify = stringify; }
    assert.deepEqual(actual, expected); assert.ok(Buffer.byteLength(JSON.stringify(actual)) < MAX);
  }
});

test('complete one-MiB pure-kernel boundary includes lone-surrogate escapes and array punctuation exactly', () => {
  const A = pureProject('project-z', '1'), rows = Array.from({length: 16}, (_, index) =>
    pureReview(`review-${String(index).padStart(2, '0')}`, String(index + 1), A.id, index + 1));
  const prefix = '"\\\b\f\n\r\t\u0001é漢🙂\ud800x\udc00';
  for (const row of rows) row.body = prefix;
  const snapshot = {projects: [A], reviews: rows}, grants = context(A.id), payload = {projectId: A.id};
  let remaining = MAX - Buffer.byteLength(JSON.stringify(querySharedData(snapshot, grants, 'reviews.list', payload))), last;
  for (const row of rows) {
    const padding = Math.min(100000 - prefix.length, remaining); row.body += 'x'.repeat(padding); remaining -= padding;
    if (row.body.length < 100000) last = row;
  }
  assert.equal(remaining, 0); assert.ok(last);
  const expected = querySharedData(snapshot, grants, 'reviews.list', payload), source = sourceFor([A], [...rows].reverse());
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), MAX);
  assert.deepEqual(querySharedBrowsing(source, grants, 'reviews.list', payload), expected);
  last.body += 'x'; assert.equal(Buffer.byteLength(JSON.stringify(querySharedData(snapshot, grants, 'reviews.list', payload))), MAX + 1);
  assert.throws(() => querySharedBrowsing(source, grants, 'reviews.list', payload), limit);
});

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'])
  test(`${encoding} actual stored columns preserve ordinary DTO order and bounded key/point projections`, t => {
    const f = setup(t, {encoding}), longId = 'P'.repeat(128);
    f.db.prepare('INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(longId, f.group.id, 'Owned 한🙂', 'é漢🙂', T2, T2);
    const metadata = f.store.peerReadDataset();
    assert.ok(metadata.projects.some(row => row.projectId === longId && Number.isSafeInteger(row.birth)));
    assert.match(metadata.epoch, /^[a-f0-9-]{36}$/);
    const grants = context(f.projectId, f.otherProjectId, longId), r = reader(f, grants);
    const cases = [['projects.list', {}], ['reviews.list', {projectId: f.projectId}], ['reviews.get', {projectId: f.projectId, reviewId: f.reviewId}]];
    for (const [operation, payload] of cases) {
      const expected = legacy(f, grants, operation, payload);
      driver(f, trace => { assert.deepEqual(r.read(operation, payload), expected); noGiantValue(trace); });
    }
    assert.deepEqual(r.read('projects.list', {}).projects.map(row => row.id), ['project-z', 'project-a', longId]);
    assert.deepEqual(r.read('reviews.list', {projectId: f.projectId}).reviews.map(row => row.id), ['review-m', 'review-a', 'review-z']);
  });

test('projects.list with empty grants never returns an unrelated giant review body or project description through the driver', t => {
  const f = setup(t); giant(f.db, 'reviews', 'body', 'review-b'); giant(f.db, 'projects', 'description', f.otherProjectId);
  const r = reader(f, context());
  driver(f, trace => {
    assert.deepEqual(r.read(), {version: 1, projects: []}); noGiantValue(trace);
    assert.equal(trace.calls.some(call => call.samples.some(row => Object.hasOwn(row, 'body') || Object.hasOwn(row, 'description'))), false);
    assert.deepEqual(trace.executions, ['BEGIN IMMEDIATE', 'COMMIT']);
  });
});

test('a giant foreign review ID/body and another own body remain unread by reviews.get', t => {
  const f = setup(t), r = reader(f), before = legacy(f, context(f.projectId), 'reviews.get', {projectId: f.projectId, reviewId: f.reviewId});
  giant(f.db, 'reviews', 'body', 'review-a'); giant(f.db, 'reviews', 'body', 'review-b');
  f.db.prepare("INSERT INTO reviews(id,projectId,number,title,body,status,priority,category,createdAt,updatedAt) SELECT replace(hex(zeroblob(?)),'00','x'),?,2,'Owned giant foreign ID',replace(hex(zeroblob(?)),'00','x'),'open','normal','ux',?,?")
    .run(HUGE, f.otherProjectId, HUGE, T0, T0);
  driver(f, trace => { assert.deepEqual(r.read('reviews.get', {projectId: f.projectId, reviewId: f.reviewId}), before); noGiantValue(trace); });
  driver(f, trace => {
    assert.throws(() => r.read('reviews.list', {projectId: f.otherProjectId}), error => error.code === 'NOT_FOUND');
    assert.equal(trace.calls.some(call => call.samples.some(row => Object.hasOwn(row, 'body'))), false);
  });
});

for (const [table, column, id, operation, payload] of [
  ['projects', 'description', 'project-z', 'projects.list', {}],
  ['projects', 'createdAt', 'project-z', 'projects.list', {}],
  ['reviews', 'body', 'review-z', 'reviews.get', {projectId: 'project-z', reviewId: 'review-z'}],
  ['reviews', 'title', 'review-z', 'reviews.get', {projectId: 'project-z', reviewId: 'review-z'}],
  ['reviews', 'updatedAt', 'review-z', 'reviews.get', {projectId: 'project-z', reviewId: 'review-z'}]])
  test(`selected oversized ${table}.${column} becomes a small invalid marker before driver conversion`, t => {
    const f = setup(t), r = reader(f); giant(f.db, table, column, id);
    driver(f, trace => {
      assert.throws(() => r.read(operation, payload), invalid); noGiantValue(trace);
      assert.ok(trace.calls.some(call => call.samples.some(row => Object.hasOwn(row, column) && row[column] === null)));
      assert.deepEqual(trace.executions, ['BEGIN IMMEDIATE', 'ROLLBACK']);
    });
  });

test('a selected BLOB body and unsafe SQLite integer are masked instead of materialized or converted unsafely', t => {
  const f = setup(t), r = reader(f);
  f.db.prepare('UPDATE reviews SET body=? WHERE id=?').run('ok\0bad', f.reviewId);
  assert.throws(() => r.read('reviews.get', {projectId: f.projectId, reviewId: f.reviewId}), invalid);
  f.db.prepare('UPDATE reviews SET body=zeroblob(?) WHERE id=?').run(HUGE, f.reviewId);
  driver(f, trace => { assert.throws(() => r.read('reviews.get', {projectId: f.projectId, reviewId: f.reviewId}), invalid); noGiantValue(trace); });
  f.db.prepare("UPDATE reviews SET body='',number=9223372036854775807 WHERE id=?").run(f.reviewId);
  driver(f, trace => {
    assert.throws(() => r.read('reviews.get', {projectId: f.projectId, reviewId: f.reviewId}), invalid);
    assert.ok(trace.calls.some(call => call.samples.some(row => Object.hasOwn(row, 'number') && row.number === null)));
  });
  f.db.prepare('UPDATE reviews SET number=1 WHERE id=?').run(f.reviewId);
  assert.equal(r.read('reviews.get', {projectId: f.projectId, reviewId: f.reviewId}).review.id, f.reviewId);
});

test('NUL-suffixed oversized epoch and project IDs are bounded before the earlier control reader', t => {
  const f = setup(t, {reviews: false}), epoch = f.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch;
  f.db.prepare("UPDATE dataset_meta SET epoch=epoch||char(0)||replace(hex(zeroblob(?)),'00','x') WHERE singleton=1").run(HUGE);
  assert.ok(f.db.prepare('SELECT octet_length(epoch) AS bytes FROM dataset_meta WHERE singleton=1').get().bytes > HUGE);
  try {
    driver(f, trace => { assert.throws(() => f.store.peerReadDataset(), unavailable); noGiantValue(trace); });
  } finally { f.db.prepare('UPDATE dataset_meta SET epoch=? WHERE singleton=1').run(epoch); }
  f.db.prepare("INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) SELECT replace(hex(zeroblob(?)),'00','x'),?,'Owned giant ID','',?,?")
    .run(HUGE, f.group.id, T0, T0);
  driver(f, trace => { assert.throws(() => f.store.peerReadDataset(), unavailable); noGiantValue(trace); });
});

test('SQLite rowid identities retain exact signed 64-bit text beyond JavaScript safe integer precision', t => {
  const f = setup(t, {reviews: false});
  f.db.prepare('UPDATE projects SET rowid=9223372036854775807 WHERE id=?').run(f.projectId);
  f.db.prepare('UPDATE projects SET rowid=-9223372036854775808 WHERE id=?').run(f.otherProjectId);
  const r = reader(f, context(f.projectId, f.otherProjectId));
  driver(f, trace => {
    assert.deepEqual(r.read().projects.map(row => row.id), [f.projectId, f.otherProjectId]);
    const parameters = trace.calls.filter(call => call.sql.includes('_readKey')).flatMap(call => call.parameters);
    assert.ok(parameters.includes('9223372036854775807')); assert.ok(parameters.includes('-9223372036854775808'));
    assert.ok(parameters.every(value => typeof value === 'string'));
  });
});

function fillList(f, operation, prefix) {
  const grants = operation === 'projects.list' ? context(...f.db.prepare('SELECT id FROM projects').all().map(row => row.id)) : context(f.projectId);
  const payload = operation === 'projects.list' ? {} : {projectId: f.projectId};
  const table = operation === 'projects.list' ? 'projects' : 'reviews', column = operation === 'projects.list' ? 'description' : 'body';
  const maximum = operation === 'projects.list' ? 10000 : 100000;
  const rows = f.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all();
  for (const row of rows) f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(prefix, row.id);
  let remaining = MAX - Buffer.byteLength(JSON.stringify(legacy(f, grants, operation, payload)), 'utf8'), last;
  assert.ok(remaining > 0);
  for (const row of rows) {
    const padding = Math.min(maximum - prefix.length, remaining), text = prefix + 'x'.repeat(padding);
    f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(text, row.id); remaining -= padding;
    if (text.length < maximum) last = {id: row.id, text};
  }
  assert.equal(remaining, 0); assert.ok(last);
  const expected = legacy(f, grants, operation, payload);
  assert.equal(Buffer.byteLength(JSON.stringify(expected), 'utf8'), MAX);
  return {grants, payload, table, column, last, expected};
}
for (const operation of ['projects.list', 'reviews.list']) for (const prefix of ['', '"\\\n\u0001한🙂'])
  test(`${operation} admits exact complete one-MiB JSON and rejects one additional byte with ${prefix ? 'escaped Unicode' : 'ASCII'} content`, t => {
    const f = setup(t, {reviews: false});
    if (operation === 'projects.list') {
      const insert = f.db.prepare('INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)');
      for (let index = 0; index < 126; index++) insert.run(`budget-${index}`, f.group.id, `Budget ${index}`, '', T0, T0);
    } else {
      f.db.prepare('UPDATE projects SET description=? WHERE id=?').run('Validation-only project text'.repeat(300), f.projectId);
      for (let index = 0; index < 16; index++) addReview(f.db, `budget-${index}`, f.projectId, index + 1);
    }
    const budget = fillList(f, operation, prefix), r = reader(f, budget.grants, operation, budget.payload);
    assert.deepEqual(r.read(), budget.expected);
    f.db.prepare(`UPDATE ${budget.table} SET ${budget.column}=? WHERE id=?`).run(budget.last.text + 'x', budget.last.id);
    assert.equal(Buffer.byteLength(JSON.stringify(legacy(f, budget.grants, operation, budget.payload))), MAX + 1,
      'The unchanged legacy six-operation entry has no new browsing cap');
    driver(f, trace => { assert.throws(() => r.read(), limit); assert.deepEqual(trace.executions, ['BEGIN IMMEDIATE', 'ROLLBACK']); });
    f.db.prepare(`UPDATE ${budget.table} SET ${budget.column}=? WHERE id=?`).run(budget.last.text, budget.last.id);
    assert.deepEqual(r.read(), budget.expected, 'A confirmed rollback preserves the original usable bridge');
  });

test('a maximum-body/title single review is counted without precommit JSON encoding and stays below the list cap', t => {
  const f = setup(t), grants = context(f.projectId), payload = {projectId: f.projectId, reviewId: f.reviewId};
  f.db.prepare('UPDATE reviews SET body=?,title=?,number=?,status=?,priority=? WHERE id=?')
    .run('\u0001'.repeat(100000), '\u0002'.repeat(300), Number.MAX_SAFE_INTEGER, 'in_progress', 'critical', f.reviewId);
  const expected = legacy(f, grants, 'reviews.get', payload), r = reader(f, grants, 'reviews.get', payload), stringify = JSON.stringify;
  let actual;
  JSON.stringify = () => { throw new Error('No protected JSON encoding'); };
  try { actual = r.read(); } finally { JSON.stringify = stringify; }
  assert.deepEqual(actual, expected); assert.ok(Buffer.byteLength(JSON.stringify(actual)) < MAX);
});

test('facade limit failure performs no release sample or replay and retains the same approval for a smaller query', t => {
  const f = setup(t, {reviews: false});
  for (let index = 0; index < 16; index++) addReview(f.db, `large-${index}`, f.projectId, index + 1, T1, 'x'.repeat(90000));
  const peer = Object.freeze(Object.create(null)), trusted = new WeakSet([peer]);
  const api = createPeerReadBrowsing({store: f.store, verifyPeerHandle: value => trusted.has(value)});
  api.approvePeer(peer, {projectIds: [f.projectId]}); api.setEnabled(true); const cap = api.openSession(peer);
  driver(f, trace => {
    assert.throws(() => api.query(cap, 'reviews.list', {projectId: f.projectId}), limit);
    assert.deepEqual(trace.executions, ['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
  assert.equal(api.query(cap, 'reviews.get', {projectId: f.projectId, reviewId: 'large-0'}).review.id, 'large-0');
});
