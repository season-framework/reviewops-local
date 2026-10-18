'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, SCHEMA_VERSION } = require('../electron/store.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const NEW_FIELDS = ['managedProjectId', 'hostAlias', 'sshConfigPath'];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-project-connection-'));
  const dbPath = path.join(directory, 'data.sqlite'), stores = [];
  const open = () => { const store = createStore({ dbPath }); stores.push(store); return store; };
  const store = open(), group = store.saveGroup({ name: '프로젝트 연결 검사' });
  t.after(() => { stores.forEach(item => item.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbPath, store, group, open };
}
function local(f, extra = {}) { return { kind: 'local', rootPath: f.directory, agentEnabled: 1, ...extra }; }
function run(store, review, extra = {}) { return store.saveAgentRun({ reviewId: review.id, serviceId: review.serviceId, status: 'completed', prompt: '합성 요청', response: '합성 응답', ...extra }); }

test('a project owns one local connection and its derived settings survive restart', t => {
  const f = fixture(t), project = f.store.saveProject({ groupId: f.group.id, name: '로컬 프로젝트', connection: local(f) });
  assert.equal(project.connection.kind, 'local');
  assert.equal(project.connection.rootPath, f.directory);
  assert.equal(project.connection.managedProjectId, project.id);
  assert.equal(project.connection.name, project.name);
  assert.equal(project.connectionClonedFrom, '');
  assert.deepEqual(project.serviceIds, [project.connection.id]);
  assert.equal(project.connection.hostAlias, '');
  assert.equal(project.connection.sshConfigPath, '');
  assert.equal(Object.hasOwn(f.store.get('projects', project.id), 'connection'), false);
  const before = f.store.snapshot(); f.store.close();
  assert.deepEqual(f.open().snapshot(), before);
});

test('a shared legacy connection is copied without changing other projects or past execution settings', t => {
  const f = fixture(t), legacy = f.store.saveService({ groupId: f.group.id, name: '기존 공유 연결', ...local(f) });
  const first = f.store.saveProject({ groupId: f.group.id, name: '변경할 프로젝트', serviceIds: [legacy.id] });
  const second = f.store.saveProject({ groupId: f.group.id, name: '보존할 프로젝트', serviceIds: [legacy.id] });
  const review = f.store.saveReview({ projectId: first.id, serviceId: legacy.id, title: '기존 리뷰' });
  const noConnection = f.store.saveReview({ projectId: first.id, title: '연결 없는 리뷰' });
  const other = f.store.saveReview({ projectId: second.id, serviceId: legacy.id, title: '보존할 리뷰' });
  const oldRun = run(f.store, review), secondBefore = f.store.project(second.id);
  const saved = f.store.saveProjectConnection(first.id, { ...legacy, rootPath: '/tmp/new-project', viewerUrl: 'https://example.invalid/new' });
  assert.notEqual(saved.connection.id, legacy.id);
  assert.equal(saved.connectionClonedFrom, legacy.id);
  assert.equal(saved.connection.managedProjectId, first.id);
  assert.equal(saved.connection.rootPath, '/tmp/new-project');
  for (const item of [review, noConnection]) assert.equal(f.store.get('reviews', item.id).serviceId, saved.connection.id);
  assert.deepEqual(f.store.get('services', legacy.id), legacy);
  assert.deepEqual(f.store.project(second.id), secondBefore);
  assert.deepEqual(f.store.get('reviews', other.id), other);
  assert.deepEqual(f.store.get('agent_runs', oldRun.id), oldRun);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('owned settings reuse their identity until a change would overwrite historical execution settings', t => {
  const f = fixture(t), project = f.store.saveProject({ groupId: f.group.id, name: '연결 변경', connection: local(f) });
  const first = f.store.saveProjectConnection(project.id, { rootPath: '/tmp/first-change', hostAlias: '', viewerWidth: 1920 });
  assert.equal(first.connection.id, project.connection.id);
  const review = f.store.saveReview({ projectId: project.id, serviceId: first.connection.id, title: '실행한 리뷰' });
  const execution = run(f.store, review), frozen = f.store.get('services', first.connection.id);
  const unchanged = f.store.saveProjectConnection(project.id, { ...first.connection });
  assert.equal(unchanged.connection.id, first.connection.id);
  const changed = f.store.saveProjectConnection(project.id, { rootPath: '/tmp/second-change', agentModel: 'new-model' });
  assert.notEqual(changed.connection.id, first.connection.id);
  assert.equal(changed.connectionClonedFrom, first.connection.id);
  assert.deepEqual(f.store.get('services', first.connection.id), frozen);
  assert.deepEqual(f.store.get('agent_runs', execution.id), execution);
  assert.equal(f.store.get('reviews', review.id).serviceId, changed.connection.id);
});

test('connection validation and failed review relinking roll back every project and configuration write', t => {
  const f = fixture(t), project = f.store.saveProject({ groupId: f.group.id, name: '보존할 프로젝트', connection: local(f) });
  const review = f.store.saveReview({ projectId: project.id, serviceId: project.connection.id, title: '보존할 리뷰' });
  run(f.store, review);
  const before = f.store.exportData();
  const invalid = [{ rootPath: 'relative' }, { hostAlias: 'host; whoami' }, { sshConfigPath: '/tmp/../config' }, { password: 'must-not-persist' }, { id: 'unlinked-setting' }, []];
  for (const connection of invalid) {
    assert.throws(() => f.store.saveProject({ id: project.id, name: '저장하면 안 되는 이름', connection }));
    assert.deepEqual(f.store.exportData(), before);
  }
  assert.throws(() => f.store.saveProject({ groupId: f.group.id, name: '생성하면 안 되는 프로젝트', connection: { kind: 'local', rootPath: 'relative' } }));
  assert.deepEqual(f.store.exportData(), before);
  f.store.db.exec("CREATE TRIGGER fail_connection_review BEFORE UPDATE OF serviceId ON reviews BEGIN SELECT RAISE(ABORT, '합성 연결 저장 실패'); END;");
  assert.throws(() => f.store.saveProjectConnection(project.id, { rootPath: '/tmp/rejected-change' }), /합성 연결 저장 실패/);
  assert.deepEqual(f.store.exportData(), before);
});

test('clearing a project connection retains all reviews, attachments and past executions', t => {
  const f = fixture(t), project = f.store.saveProject({ groupId: f.group.id, name: '연결 해제', connection: local(f) });
  const review = f.store.saveReview({ projectId: project.id, serviceId: project.connection.id, title: '보존할 리뷰' });
  const execution = run(f.store, review), before = f.store.get('services', project.connection.id);
  const cleared = f.store.saveProjectConnection(project.id, null);
  assert.equal(cleared.connection, null); assert.deepEqual(cleared.serviceIds, []);
  assert.equal(f.store.get('reviews', review.id).serviceId, null);
  assert.deepEqual(f.store.get('agent_runs', execution.id), execution);
  assert.deepEqual(f.store.get('services', before.id), before);
});

test('deleting a project removes owned configuration versions but preserves legacy settings', t => {
  const f = fixture(t), legacy = f.store.saveService({ groupId: f.group.id, name: '이전 설정', ...local(f) });
  const project = f.store.saveProject({ groupId: f.group.id, name: '삭제할 프로젝트', serviceIds: [legacy.id] });
  const first = f.store.saveProjectConnection(project.id, local(f));
  const review = f.store.saveReview({ projectId: project.id, serviceId: first.connection.id, title: '삭제할 리뷰' });
  run(f.store, review);
  const second = f.store.saveProjectConnection(project.id, { rootPath: '/tmp/another-version' });
  f.store.deleteProject(project.id);
  assert.deepEqual(f.store.snapshot().services, [legacy]);
  for (const item of [first, second]) assert.throws(() => f.store.get('services', item.connection.id), /찾을 수 없습니다/);
  assert.deepEqual(f.store.listAgentRuns(), []);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('deleting a project preserves owned settings that another project execution still references', t => {
  const f = fixture(t), owner = f.store.saveProject({ groupId: f.group.id, name: '원래 프로젝트', connection: local(f) });
  const other = f.store.saveProject({ groupId: f.group.id, name: '다른 프로젝트', serviceIds: [owner.connection.id] });
  const review = f.store.saveReview({ projectId: other.id, serviceId: owner.connection.id, title: '남겨야 하는 실행' });
  const execution = run(f.store, review);
  f.store.setProjectServices(other.id, []);
  f.store.deleteProject(owner.id);
  assert.deepEqual(f.store.get('agent_runs', execution.id), execution);
  const archived = f.store.get('services', owner.connection.id);
  assert.equal(archived.managedProjectId, '');
  assert.equal(archived.rootPath, owner.connection.rootPath);
  const backup = f.store.exportData(); f.store.importData(backup);
  assert.deepEqual(f.store.exportData(), backup);
});

test('SSH Host selection fields persist and malformed names or config paths are rejected', t => {
  const f = fixture(t), project = f.store.saveProject({ groupId: f.group.id, name: 'SSH 프로젝트', connection: {
    kind: 'ssh', host: 'example.invalid', username: 'fixture-user', rootPath: '/opt/example',
    hostAlias: 'fixture-server', sshConfigPath: '/Users/example/.ssh/config', authType: 'key', privateKeyPath: '/Users/example/.ssh/id_ed25519'
  } });
  assert.equal(project.connection.hostAlias, 'fixture-server');
  assert.equal(project.connection.sshConfigPath, '/Users/example/.ssh/config');
  const before = f.store.exportData();
  for (const connection of [{ hostAlias: 'bad host' }, { hostAlias: '-option' }, { hostAlias: 'bad\nhost' }, { sshConfigPath: 'relative' }]) {
    assert.throws(() => f.store.saveProjectConnection(project.id, connection));
    assert.deepEqual(f.store.exportData(), before);
  }
  f.store.importData(before); assert.deepEqual(f.store.exportData(), before);
});

test('current backups verify duplicated project connection fields and reject mismatches without changing data', t => {
  const f = fixture(t), project = f.store.saveProject({ groupId: f.group.id, name: '백업할 프로젝트', connection: local(f) });
  const before = f.store.exportData();
  assert.equal(before.version, 6);
  f.store.importData(before); assert.deepEqual(f.store.exportData(), before);
  for (const mutate of [
    data => { data.projects[0].connection = null; },
    data => { data.projects[0].connection.rootPath = '/tmp/mismatched'; },
    data => { data.projects[0].connection.id = 'wrong-setting'; },
    data => { data.projects[0].connection.extraField = 'unsupported'; },
    data => { data.services[0].managedProjectId = 'missing-project'; },
    data => { data.projects[0].connection.password = 'never-import'; }
  ]) {
    const broken = clone(before); mutate(broken);
    assert.throws(() => f.store.importData(broken));
    assert.deepEqual(f.store.exportData(), before);
  }
  assert.equal(f.store.project(project.id).connection.id, project.connection.id);
});

test('version 5 SQLite and JSON data retain all fields and links while new connection fields receive empty defaults', t => {
  const f = fixture(t), service = f.store.saveService({ groupId: f.group.id, name: '이전 연결', ...local(f) });
  const project = f.store.saveProject({ groupId: f.group.id, name: '이전 프로젝트', serviceIds: [service.id] });
  const review = f.store.saveReview({ projectId: project.id, serviceId: service.id, title: '이전 리뷰' });
  run(f.store, review);
  const before = f.store.exportData(), legacy = clone(before); legacy.version = 5;
  for (const row of legacy.projects) delete row.connection;
  for (const row of legacy.services) for (const key of NEW_FIELDS) delete row[key];
  for (const key of NEW_FIELDS) f.store.db.exec(`ALTER TABLE services DROP COLUMN ${key};`);
  f.store.db.exec('PRAGMA user_version=5;'); f.store.close();
  const migrated = f.open();
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(migrated.exportData(), before);
  migrated.importData(legacy);
  assert.deepEqual(migrated.exportData(), before);
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
