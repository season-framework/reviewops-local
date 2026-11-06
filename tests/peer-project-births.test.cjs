'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createStore, SCHEMA_VERSION, BACKUP_FORMAT_VERSION} = require('../electron/store.cjs');
const {migrate, readDataset, resetForLogicalImport, MAX_BIRTH} = require('../electron/peer-project-births.cjs');

const OTHER_EPOCH = '22222222-2222-4222-8222-222222222222';
const unavailable = error => error.code === 'PEER_READ_UNAVAILABLE' &&
  error.message === 'Committed peer read state is unavailable.';
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-peer-births-'));
  const dbPath = path.join(root, 'owned.sqlite'), stores = [], connections = [];
  const open = () => { const store = createStore({dbPath}); stores.push(store); return store; };
  t.after(() => {
    try { for (const db of connections) db.close(); }
    finally { try { for (const store of stores) store.close(); }
      finally { fs.rmSync(root, {recursive: true, force: true}); } }
  });
  return {dbPath, open, connections, store: open()};
}
function seed(store, names = ['A', 'B']) {
  const group = store.saveGroup({name: 'Synthetic project-birth fixture'});
  return {group, projects: names.map(name => store.saveProject({groupId: group.id, name}))};
}
function rawProject(db, projectId) { return {...db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)}; }
function insertProject(db, row, replace = false) {
  const keys = Object.keys(row);
  db.prepare(`${replace ? 'INSERT OR REPLACE' : 'INSERT'} INTO projects(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map(key => row[key]));
}
function controls(store) {
  return {
    epoch: store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch,
    counter: {...store.db.prepare('SELECT * FROM peer_project_birth_counter WHERE singleton=1').get()},
    births: store.db.prepare('SELECT projectId,birth FROM peer_project_births ORDER BY projectId').all().map(row => ({...row})),
    reviews: store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all().map(row => ({...row})),
    receipts: store.db.prepare('SELECT * FROM command_receipts ORDER BY epoch,principalId,requestId').all().map(row => ({...row}))
  };
}
function birth(dataset, projectId) {
  const row = dataset.projects.find(row => row.projectId === projectId);
  assert.ok(row, 'Expected an actual live project birth'); return row.birth;
}
function oldControlRows(db) {
  return {
    dataset_meta: db.prepare('SELECT * FROM dataset_meta ORDER BY singleton').all().map(row => ({...row})),
    review_revisions: db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all().map(row => ({...row})),
    command_receipts: db.prepare('SELECT * FROM command_receipts ORDER BY epoch,principalId,requestId').all().map(row => ({...row}))
  };
}
function businessRows(db) {
  return Object.fromEntries(['groups', 'projects', 'services', 'project_services', 'reviews', 'agent_runs',
    'agent_requests', 'activities', 'attachments', 'settings'].map(table => [table,
    db.prepare(`SELECT * FROM ${table}`).all().map(row => ({...row}))]));
}
function addOwnedHistoryAndReceipt(store, project) {
  const review = store.saveReview({projectId: project.id, title: 'Owned migration history'});
  const activity = store.addActivity({reviewId: review.id, body: 'Synthetic history retained across migration'});
  const provider = () => ({principalId: 'owned-migration-writer', projectGrants: [{projectId: project.id, write: true}]});
  const state = store.reviewWriteState({projectId: project.id, reviewId: review.id}, provider);
  const acknowledgement = store.setReviewStatusCommand({requestId: 'owned-migration-status', projectId: project.id,
    reviewId: review.id, epoch: state.epoch, expectedRevision: state.revision, status: 'resolved'}, provider);
  assert.equal(acknowledgement.changed, true);
  assert.equal(oldControlRows(store.db).command_receipts.length, 1);
  return {review, activity, acknowledgement};
}
function stripBirthFoundationForOwnedV11Fixture(db) {
  for (const name of ['peer_project_birth_insert', 'peer_project_birth_delete', 'peer_project_birth_id_update'])
    db.exec(`DROP TRIGGER ${name}`);
  db.exec('DROP TABLE peer_project_births; DROP TABLE peer_project_birth_counter; PRAGMA user_version=11;');
}

test('empty committed projection has a closed frozen schema and no caller-supplied authority', t => {
  const {store} = setup(t);
  assert.equal(SCHEMA_VERSION, 12); assert.equal(BACKUP_FORMAT_VERSION, 10);
  assert.equal(MAX_BIRTH, Number.MAX_SAFE_INTEGER);
  for (const entry of [migrate, readDataset, resetForLogicalImport]) assert.equal(typeof entry, 'function');
  const result = store.peerReadDataset();
  assert.deepEqual(Object.keys(result).sort(), ['epoch', 'projects']);
  assert.match(result.epoch, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(result.projects, []); assert.ok(Object.isFrozen(result) && Object.isFrozen(result.projects));
  for (const input of [undefined, {}, {projectIds: []}, {projectGrants: []}])
    assert.throws(() => store.peerReadDataset(input), unavailable);
  store.close(); assert.throws(() => store.peerReadDataset(), unavailable);
});

test('synthetic owned schema-11 backfill preserves history, receipts, business rows and all old controls', t => {
  const f = setup(t), {projects} = seed(f.store);
  const history = addOwnedHistoryAndReceipt(f.store, projects[0]);
  const before = f.store.exportData(), oldControls = oldControlRows(f.store.db), oldBusiness = businessRows(f.store.db);
  const epoch = f.store.peerReadDataset().epoch; f.store.close();
  const legacy = new DatabaseSync(f.dbPath);
  try { stripBirthFoundationForOwnedV11Fixture(legacy); }
  finally { legacy.close(); }
  const physicalV11 = new DatabaseSync(f.dbPath);
  try {
    assert.equal(physicalV11.prepare('PRAGMA user_version').get().user_version, 11);
    assert.deepEqual(oldControlRows(physicalV11), oldControls); assert.deepEqual(businessRows(physicalV11), oldBusiness);
  } finally { physicalV11.close(); }
  const migrated = f.open(), state = migrated.peerReadDataset();
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(state.epoch, epoch); assert.deepEqual(migrated.exportData(), before);
  assert.deepEqual(oldControlRows(migrated.db), oldControls); assert.deepEqual(businessRows(migrated.db), oldBusiness);
  assert.equal(migrated.get('reviews', history.review.id).status, 'resolved');
  assert.equal(migrated.get('activities', history.activity.id).body, 'Synthetic history retained across migration');
  assert.deepEqual(state.projects.map(row => row.projectId), projects.map(row => row.id).sort());
  assert.equal(new Set(state.projects.map(row => row.birth)).size, projects.length);
  assert.ok(state.projects.every(row => Number.isSafeInteger(row.birth) && row.birth >= 1));
  const durable = controls(migrated); migrated.close();
  const reopened = f.open(); assert.deepEqual(reopened.peerReadDataset(), state); assert.deepEqual(controls(reopened), durable);
});

test('failed migration of a synthetic owned v11 fixture rolls back DDL, backfill and version with old data exact', t => {
  const f = setup(t), {projects} = seed(f.store);
  addOwnedHistoryAndReceipt(f.store, projects[0]);
  const oldBusiness = businessRows(f.store.db), oldControls = oldControlRows(f.store.db); f.store.close();
  let collision;
  const legacy = new DatabaseSync(f.dbPath);
  try {
    stripBirthFoundationForOwnedV11Fixture(legacy);
    // The last CREATE TRIGGER collides after tables, backfill and two prior trigger statements.
    legacy.exec('CREATE TRIGGER peer_project_birth_id_update AFTER UPDATE OF id ON projects BEGIN SELECT 1; END;');
    collision = {...legacy.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='peer_project_birth_id_update'").get()};
    assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 11);
  } finally { legacy.close(); }
  assert.throws(() => createStore({dbPath: f.dbPath}), /peer_project_birth_id_update/);
  // The failed constructor owns closing its original DatabaseSync; this is a new inspection connection.
  const retained = new DatabaseSync(f.dbPath);
  try {
    assert.equal(retained.prepare('PRAGMA user_version').get().user_version, 11);
    assert.deepEqual(retained.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('peer_project_birth_counter','peer_project_births')").all(), []);
    assert.deepEqual(retained.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('peer_project_birth_insert','peer_project_birth_delete')").all(), []);
    assert.deepEqual({...retained.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='peer_project_birth_id_update'").get()}, collision);
    assert.deepEqual(oldControlRows(retained), oldControls); assert.deepEqual(businessRows(retained), oldBusiness);
  } finally { retained.close(); }
});

test('empty-project deletion and same-ID same-timestamp reinsertion receive a new birth without an epoch change', t => {
  const {store} = setup(t), {projects: [project]} = seed(store, ['Empty']);
  const row = rawProject(store.db, project.id), before = store.peerReadDataset();
  store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
  assert.deepEqual(store.peerReadDataset().projects, []);
  insertProject(store.db, row);
  const after = store.peerReadDataset();
  assert.equal(after.epoch, before.epoch); assert.ok(birth(after, project.id) > birth(before, project.id));
  assert.deepEqual(rawProject(store.db, project.id), row);
  const backup = store.exportData(); store.deleteProject(project.id);
  store.insertImport({...backup, groups: []});
  const inserted = store.peerReadDataset();
  assert.equal(inserted.epoch, before.epoch); assert.ok(birth(inserted, project.id) > birth(after, project.id));
  assert.deepEqual(rawProject(store.db, project.id), row);
});

test('INSERT OR REPLACE changes birth even with recursive delete triggers disabled', t => {
  const {store} = setup(t), {projects: [project]} = seed(store, ['Replace']);
  const row = rawProject(store.db, project.id), before = store.peerReadDataset();
  store.db.exec('PRAGMA recursive_triggers=OFF;');
  assert.equal(store.db.prepare('PRAGMA recursive_triggers').get().recursive_triggers, 0);
  insertProject(store.db, row, true);
  const after = store.peerReadDataset();
  assert.equal(after.epoch, before.epoch); assert.ok(birth(after, project.id) > birth(before, project.id));
  assert.equal(after.projects.length, 1); assert.deepEqual(rawProject(store.db, project.id), row);
});

test('A-to-B-to-A primary-key changes cannot reuse an earlier project birth', t => {
  const {store} = setup(t), {projects: [project]} = seed(store, ['Rename ID']);
  const a = project.id, b = `${a}_next`, first = store.peerReadDataset();
  store.db.prepare('UPDATE projects SET id=? WHERE id=?').run(b, a);
  const middle = store.peerReadDataset(); assert.deepEqual(middle.projects.map(row => row.projectId), [b]);
  store.db.prepare('UPDATE projects SET id=? WHERE id=?').run(a, b);
  const last = store.peerReadDataset(); assert.deepEqual(last.projects.map(row => row.projectId), [a]);
  assert.equal(last.epoch, first.epoch);
  assert.ok(birth(middle, b) > birth(first, a)); assert.ok(birth(last, a) > birth(middle, b));
});

test('ordinary project and review metadata changes keep every unaffected birth', t => {
  const {store} = setup(t), {group, projects: [a, b]} = seed(store);
  const before = store.peerReadDataset();
  store.saveProject({id: a.id, name: 'A renamed', description: 'An ordinary edit'});
  store.saveProject({id: b.id, intro: 'Unrelated project metadata'});
  const review = store.saveReview({projectId: a.id, title: 'Synthetic review'});
  store.saveReview({id: review.id, body: 'Ordinary review body'});
  store.saveGroup({id: group.id, description: 'Ordinary group metadata'});
  assert.deepEqual(store.peerReadDataset(), before);
});

test('Store project and group deletion remove live births and never reset the allocation counter', t => {
  const {store} = setup(t), {group, projects: [a, b]} = seed(store);
  const before = controls(store); store.deleteProject(a.id);
  assert.deepEqual(store.peerReadDataset().projects.map(row => row.projectId), [b.id]);
  assert.equal(controls(store).counter.value, before.counter.value);
  store.deleteGroup(group.id); assert.deepEqual(store.peerReadDataset().projects, []);
  assert.equal(controls(store).counter.value, before.counter.value);
});

test('rollback restores births and counter while a nested read cannot leak an uncommitted projection', t => {
  const {store} = setup(t), {group} = seed(store, []), before = controls(store);
  const rollback = new Error('Owned birth rollback'); let uncommittedBirth, leaked;
  assert.throws(() => store.transaction(() => {
    const project = store.saveProject({groupId: group.id, name: 'Must roll back'});
    uncommittedBirth = store.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(project.id).birth;
    assert.throws(() => { leaked = store.peerReadDataset(); }, unavailable);
    throw rollback;
  }), error => error === rollback);
  assert.equal(leaked, undefined); assert.deepEqual(controls(store), before);
  const committed = store.saveProject({groupId: group.id, name: 'Later committed project'});
  assert.equal(birth(store.peerReadDataset(), committed.id), uncommittedBirth,
    'Counter reuse after rollback is safe only because no uncommitted projection escaped');
  const committedName = store.get('projects', committed.id).name;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('UPDATE projects SET name=? WHERE id=?').run('Owned raw transaction still open', committed.id);
    assert.equal(store.inTransaction, false); leaked = undefined;
    assert.throws(() => { leaked = store.peerReadDataset(); }, unavailable);
    assert.equal(leaked, undefined);
    assert.equal(store.db.prepare('SELECT name FROM projects WHERE id=?').get(committed.id).name,
      'Owned raw transaction still open', 'The refused reader must not roll back a caller-owned SQL transaction');
  } finally { store.db.exec('ROLLBACK'); }
  assert.equal(store.get('projects', committed.id).name, committedName);
});

test('a failed read COMMIT withholds the projection, restores db.exec, and leaves durable state unchanged', t => {
  const {store} = setup(t); seed(store);
  const before = controls(store), original = store.db.exec;
  let attempts = 0, leaked;
  store.db.exec = function(sql) {
    if (sql === 'COMMIT') { attempts++; throw new Error('PRIVATE injected read commit failure'); }
    return original.call(this, sql);
  };
  try { assert.throws(() => { leaked = store.peerReadDataset(); }, unavailable); }
  finally { store.db.exec = original; }
  assert.equal(attempts, 1); assert.equal(leaked, undefined); assert.equal(store.inTransaction, false);
  assert.deepEqual(controls(store), before); assert.equal(store.peerReadDataset().projects.length, 2);
});

test('logical import changes epoch and safely reseeds births while backup format and business data stay exact', t => {
  const {store} = setup(t), {group} = seed(store);
  const spare = store.saveProject({groupId: group.id, name: 'Deleted allocation'}); store.deleteProject(spare.id);
  const before = store.peerReadDataset(), backup = store.exportData();
  store.importData(backup);
  const after = store.peerReadDataset();
  assert.notEqual(after.epoch, before.epoch); assert.deepEqual(store.exportData(), backup);
  assert.deepEqual(after.projects.map(row => row.projectId), before.projects.map(row => row.projectId));
  assert.equal(controls(store).counter.epoch, after.epoch); assert.equal(controls(store).counter.value, after.projects.length);
  assert.equal(new Set(after.projects.map(row => row.birth)).size, after.projects.length);
});

test('a failure during live import rolls back the new epoch, removed projects, birth rows and counter together', t => {
  const {store} = setup(t); seed(store);
  const backup = store.exportData(), before = controls(store);
  store.db.exec("CREATE TRIGGER injected_peer_birth_import_failure BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'Owned live import failure'); END;");
  try { assert.throws(() => store.importData(backup), /Owned live import failure/); }
  finally { store.db.exec('DROP TRIGGER injected_peer_birth_import_failure;'); }
  assert.deepEqual(controls(store), before); assert.deepEqual(store.exportData(), backup);
  assert.equal(store.peerReadDataset().epoch, before.epoch);
});

test('counter exhaustion cannot be ignored or reuse the last committed birth, and a new-epoch import recovers', t => {
  const {store} = setup(t), {group, projects: [project]} = seed(store, ['Existing']);
  store.db.prepare('UPDATE peer_project_birth_counter SET value=? WHERE singleton=1').run(MAX_BIRTH - 1);
  const last = store.saveProject({groupId: group.id, name: 'Actual last committed birth'});
  const lastRow = rawProject(store.db, last.id), lastBirth = birth(store.peerReadDataset(), last.id);
  assert.equal(lastBirth, MAX_BIRTH); store.deleteProject(last.id);
  const backup = store.exportData();
  const before = controls(store), originalRow = rawProject(store.db, project.id);
  assert.throws(() => store.saveProject({groupId: group.id, name: 'No allocation available'}));
  assert.throws(() => insertProject(store.db, originalRow, true));
  assert.throws(() => store.db.prepare('UPDATE projects SET id=? WHERE id=?').run('exhausted-id', project.id));
  const keys = Object.keys(lastRow);
  assert.throws(() => store.db.prepare(`INSERT OR IGNORE INTO projects(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map(key => lastRow[key])));
  assert.equal(store.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(last.id), undefined);
  assert.equal(store.db.prepare('SELECT id FROM projects WHERE id=?').get(last.id), undefined);
  assert.deepEqual(controls(store), before);
  assert.throws(() => store.db.prepare('UPDATE OR IGNORE projects SET id=? WHERE id=?').run('exhausted-ignore-id', project.id));
  assert.equal(store.db.prepare('SELECT birth FROM peer_project_births WHERE birth=?').get(lastBirth), undefined,
    'Neither ignored allocation may reuse the actual old committed birth');
  assert.deepEqual(controls(store), before); assert.deepEqual(store.exportData(), backup);
  assert.equal(store.peerReadDataset().projects.length, 1);
  store.importData(backup); const after = store.peerReadDataset();
  assert.notEqual(after.epoch, before.epoch); assert.equal(controls(store).counter.value, 1);
  const next = store.saveProject({groupId: group.id, name: 'Allocation after import'});
  assert.equal(birth(store.peerReadDataset(), next.id), 2);
});

test('logical-import reset refuses the same epoch and a nonempty live project graph', t => {
  const {store} = setup(t), {projects: [project]} = seed(store, ['Existing']);
  const before = controls(store);
  assert.throws(() => store.transaction(() => {
    store.db.prepare('UPDATE dataset_meta SET epoch=? WHERE singleton=1').run(OTHER_EPOCH);
    resetForLogicalImport(store.db);
  }));
  assert.deepEqual(controls(store), before);
  store.deleteProject(project.id); const empty = controls(store);
  assert.throws(() => store.transaction(() => resetForLogicalImport(store.db)));
  assert.deepEqual(controls(store), empty);
});

test('a second plain SQLite connection allocates and replaces births without any JavaScript SQL function', t => {
  const f = setup(t), {projects: [project]} = seed(f.store, ['External writer']);
  const before = f.store.peerReadDataset(), original = rawProject(f.store.db, project.id);
  const db = new DatabaseSync(f.dbPath); f.connections.push(db);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF;');
  const external = {...original, id: 'external-owned-project', name: 'Second connection'};
  insertProject(db, external);
  assert.ok(birth(f.store.peerReadDataset(), external.id) > birth(before, project.id));
  db.prepare('DELETE FROM projects WHERE id=?').run(project.id); insertProject(db, original);
  const after = f.store.peerReadDataset();
  assert.equal(after.epoch, before.epoch); assert.ok(birth(after, project.id) > birth(before, project.id));
  assert.equal(new Set(after.projects.map(row => row.birth)).size, 2);
});

test('missing, orphaned or inconsistent control rows deny with one fixed error and no partial projection', t => {
  const corruptions = [
    (store, project) => store.db.prepare('DELETE FROM peer_project_births WHERE projectId=?').run(project.id),
    store => {
      const next = controls(store).counter.value + 1;
      store.db.prepare('UPDATE peer_project_birth_counter SET value=? WHERE singleton=1').run(next);
      store.db.prepare('INSERT INTO peer_project_births(projectId,birth) VALUES(?,?)').run('orphan-owned-project', next);
    },
    store => store.db.prepare('UPDATE peer_project_birth_counter SET epoch=? WHERE singleton=1').run(OTHER_EPOCH),
    store => store.db.exec('UPDATE peer_project_birth_counter SET value=0 WHERE singleton=1;'),
    store => store.db.exec('DELETE FROM peer_project_birth_counter;'),
    store => store.db.exec('PRAGMA ignore_check_constraints=ON; UPDATE peer_project_births SET birth=0;'),
    store => store.db.exec('PRAGMA ignore_check_constraints=ON; UPDATE peer_project_birth_counter SET value=9223372036854775807;'),
    store => store.db.exec('PRAGMA ignore_check_constraints=ON; UPDATE peer_project_births SET birth=9223372036854775807;')
  ];
  // Text diagnostics must not themselves convert an unsafe SQLite integer to JS.
  const diagnostic = store => ({
    counter: store.db.prepare('SELECT singleton,epoch,typeof(value) AS kind,quote(value) AS value FROM peer_project_birth_counter').all().map(row => ({...row})),
    births: store.db.prepare('SELECT projectId,typeof(birth) AS kind,quote(birth) AS birth FROM peer_project_births ORDER BY projectId').all().map(row => ({...row}))
  });
  for (const corrupt of corruptions) {
    const {store} = setup(t), {projects: [project]} = seed(store, ['Corrupt fixture']);
    corrupt(store, project); const before = diagnostic(store); let leaked;
    assert.throws(() => { leaked = store.peerReadDataset(); }, unavailable);
    assert.equal(leaked, undefined); assert.deepEqual(diagnostic(store), before);
  }
});

test('projection is detached and reads only its internal state without changing snapshots, exports or receipts', t => {
  const {store} = setup(t); seed(store);
  const snapshot = store.snapshot(), backup = store.exportData(), before = controls(store);
  const originals = new Map(['snapshot', 'exportData', 'get', 'project', 'captureWriteAdmission', 'reviewWriteState']
    .map(key => [key, store[key]]));
  let first, second;
  try {
    for (const key of originals.keys()) store[key] = () => { throw new Error('Peer projection must not call ' + key); };
    first = store.peerReadDataset(); second = store.peerReadDataset();
  } finally { for (const [key, value] of originals) store[key] = value; }
  assert.notEqual(first, second); assert.notEqual(first.projects, second.projects);
  assert.deepEqual(first, second); assert.ok(first.projects.every(Object.isFrozen));
  assert.deepEqual(Object.keys(first.projects[0]).sort(), ['birth', 'projectId']);
  assert.throws(() => { first.projects[0].birth = 0; }, TypeError);
  assert.throws(() => first.projects.push({projectId: 'forged', birth: 1}), TypeError);
  assert.deepEqual(store.snapshot(), snapshot); assert.deepEqual(store.exportData(), backup); assert.deepEqual(controls(store), before);
  for (const key of ['peer_project_births', 'peer_project_birth_counter', 'birth', 'peerReadDataset']) {
    assert.equal(Object.hasOwn(snapshot, key), false); assert.equal(Object.hasOwn(backup, key), false);
    assert.throws(() => store.importData({...backup, [key]: []}), /unsupported or consistency/);
  }
});
