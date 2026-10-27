'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { createStore, SCHEMA_VERSION } = require('../electron/store.cjs');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-store-test-'));
  const dbPath = path.join(directory, 'reviewops.sqlite');
  const store = createStore({ dbPath });
  const stores = [store];
  t.after(() => {
    for (const item of stores) item.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory, dbPath, reopen: () => { const next = createStore({ dbPath }); stores.push(next); return next; } };
}
function fixture(store) {
  const group = store.saveGroup({ name: '테스트 그룹', description: '합성자료' });
  const service = store.saveService({ groupId: group.id, name: '테스트 SSH', kind: 'ssh', host: 'example.test', username: 'test-user', rootPath: '/opt/test', viewerUrl: 'https://example.test/' });
  const project = store.saveProject({ groupId: group.id, name: '테스트 프로젝트', serviceIds: [service.id] });
  const review = store.saveReview({ projectId: project.id, serviceId: service.id, title: '버튼 정렬', body: '합성 테스트 내용', category: 'ux', targetPath: 'src/example.ts', targetUrl: 'https://example.test/example' });
  return { group, service, project, review };
}
function attachment(reviewId, extra = {}) {
  return { reviewId, name: '테스트.txt', mimeType: 'text/plain', storageName: `${crypto.randomUUID()}.txt`, size: 9,
    sha256: crypto.createHash('sha256').update('synthetic').digest('hex'), ...extra };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
const PIN = 'SHA256:' + crypto.createHash('sha256').update('synthetic host key').digest('base64').replace(/=+$/, '');

test('Windows services keep native local paths and POSIX server paths separate', () => {
  const windowsModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/store.cjs'), 'utf8'), {
    require: name => name === 'node:path' ? path.win32 : require(name.startsWith('.') ? path.join(__dirname, '../electron', name) : name), module: windowsModule, Buffer
  });
  const normalize = draft => windowsModule.exports.LocalStore.prototype.normalizeService.call({}, { groupId: 'windows-group', name: 'Windows project', ...draft });
  const local = normalize({ kind: 'local', rootPath: 'C:\\Users\\Operator\\My project', agentWorkPath: 'D:\\Work\\ReviewOps', agentBinary: 'C:\\Program Files\\Codex\\codex.exe' });
  assert.equal(local.rootPath, 'C:\\Users\\Operator\\My project');
  assert.equal(local.agentWorkPath, 'D:\\Work\\ReviewOps');
  assert.equal(local.agentBinary, 'C:\\Program Files\\Codex\\codex.exe');
  assert.equal(normalize({ kind: 'local', rootPath: '\\\\server\\share\\work' }).rootPath, '\\\\server\\share\\work');
  const remote = normalize({ kind: 'ssh', host: 'example.test', username: 'operator', rootPath: '/srv/project', agentWorkPath: '/srv/project/work', privateKeyPath: 'C:\\Users\\Operator\\.ssh\\id_ed25519', sshConfigPath: 'C:\\Users\\Operator\\.ssh\\config' });
  assert.equal(remote.rootPath, '/srv/project');
  assert.equal(remote.agentWorkPath, '/srv/project/work');
  assert.equal(remote.privateKeyPath, 'C:\\Users\\Operator\\.ssh\\id_ed25519');
  assert.equal(remote.sshConfigPath, 'C:\\Users\\Operator\\.ssh\\config');
  for (const rootPath of ['C:\\work\\..\\private', 'relative']) assert.throws(() => normalize({kind: 'local', rootPath}), /작업 경로/);
  assert.throws(() => normalize({kind: 'ssh', host: 'example.test', username: 'operator', rootPath: 'C:\\work'}), /작업 경로/);
});

test('empty database migrates, enables foreign keys and WAL, and has no sample data', t => {
  const { store, dbPath } = setup(t);
  assert.deepEqual(store.snapshot(), { groups: [], projects: [], services: [], reviews: [], activities: [], attachments: [], settings: { theme: 'light' } });
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
});

test('groups, project links, reviews, comments, attachments and settings persist after restart', t => {
  const { store, reopen } = setup(t);
  const { group, service, project, review } = fixture(store);
  const second = store.saveProject({ groupId: group.id, name: '두 번째 프로젝트', serviceIds: [service.id] });
  store.saveGroup({ id: group.id, description: '수정한 그룹 설명' });
  store.saveProject({ id: project.id, description: '수정한 프로젝트 설명' });
  store.saveReview({ id: review.id, body: '수정 내용', priority: 'high' });
  const comment = store.addActivity({ reviewId: review.id, body: '댓글 내용' });
  store.addAttachment(attachment(review.id, { activityId: comment.id }));
  store.saveSettings({ theme: 'dark' });
  const before = store.snapshot();
  store.close();
  const next = reopen();
  assert.deepEqual(next.snapshot(), before);
  assert.deepEqual(next.snapshot().projects.find(item => item.id === second.id).serviceIds, [service.id]);
  assert.equal(next.snapshot().reviews[0].priority, 'high');
  assert.equal(next.snapshot().activities.filter(item => item.type === 'comment').length, 1);
  assert.equal(next.snapshot().attachments[0].activityId, comment.id);
});

test('project update rolls back every field when a service association is invalid', t => {
  const { store } = setup(t);
  const { project } = fixture(store);
  const before = store.snapshot();
  assert.throws(() => store.saveProject({ id: project.id, name: '저장되면 안 되는 이름', serviceIds: ['missing-service'] }), /찾을 수 없습니다/);
  assert.deepEqual(store.snapshot(), before);
});

test('services can be shared in one group, but cross-group links and reviews are rejected', t => {
  const { store } = setup(t);
  const { service, project } = fixture(store);
  const group2 = store.saveGroup({ name: '다른 그룹' });
  const project2 = store.saveProject({ groupId: group2.id, name: '다른 프로젝트' });
  assert.throws(() => store.saveProject({ id: project2.id, serviceIds: [service.id] }), /같은 그룹/);
  assert.throws(() => store.saveReview({ projectId: project2.id, serviceId: service.id, title: '잘못된 리뷰' }), /연결된 서비스/);
  assert.throws(() => store.saveProject({ id: project.id, groupId: group2.id }), /그룹을 바꿀 수 없습니다/);
  assert.throws(() => store.saveService({ id: service.id, groupId: group2.id }), /그룹을 바꿀 수 없습니다/);
  assert.throws(() => store.db.prepare('INSERT INTO project_services(projectId,serviceId) VALUES(?,?)').run(project2.id, service.id), /같은 그룹/);
});

test('reviews can only use a linked service and cannot change project', t => {
  const { store } = setup(t);
  const { group, project, review } = fixture(store);
  const unlinked = store.saveService({ groupId: group.id, name: '연결하지 않은 폴더', kind: 'local', rootPath: '/tmp' });
  const other = store.saveProject({ groupId: group.id, name: '다른 프로젝트' });
  assert.throws(() => store.saveReview({ id: review.id, serviceId: unlinked.id }), /연결된 서비스/);
  assert.throws(() => store.saveReview({ id: review.id, projectId: other.id }), /프로젝트를 바꿀 수 없습니다/);
  assert.throws(() => store.saveReview({ projectId: 'missing', title: '실패' }), /찾을 수 없습니다/);
  assert.equal(store.snapshot().reviews[0].projectId, project.id);
});

test('a linked service requires every project to detach it while existing reviews remain intact', t => {
  const { store } = setup(t);
  const { group, project, service, review } = fixture(store);
  const second = store.saveProject({ groupId:group.id, name:'공유 프로젝트', serviceIds:[service.id] });
  const otherReview = store.saveReview({ projectId:second.id, serviceId:service.id, title:'공유 서비스 리뷰' });
  const comment = store.addActivity({reviewId:review.id,body:'보존할 작업 내용'});
  const file = store.addAttachment(attachment(review.id,{activityId:comment.id}));
  const original = store.snapshot();
  assert.throws(()=>store.deleteService(service.id),error=>error.code==='IN_USE' && /모든 프로젝트/.test(error.message));
  assert.deepEqual(store.snapshot(),original);
  store.saveProject({ id: project.id, serviceIds: [] });
  assert.equal(store.get('reviews',review.id).serviceId,null);
  assert.equal(store.get('reviews',otherReview.id).serviceId,service.id);
  assert.equal(store.get('activities',comment.id).body,comment.body);
  assert.deepEqual(store.get('attachments',file.id),file);
  assert.throws(()=>store.deleteService(service.id),error=>error.code==='IN_USE');
  assert.throws(()=>store.db.prepare('DELETE FROM services WHERE id=?').run(service.id),/모든 프로젝트/);
  store.saveProject({id:second.id,serviceIds:[]});
  assert.deepEqual(store.deleteService(service.id), { deleted: true });
  assert.deepEqual(store.snapshot().reviews.map(row=>row.id).sort(),[review.id,otherReview.id].sort());
  assert.equal(store.get('reviews',otherReview.id).serviceId,null);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('project deletion removes all descendant content and preserves a shared service and other projects', t => {
  const {store}=setup(t),{group,project,service,review}=fixture(store);
  const second=store.saveProject({groupId:group.id,name:'보존할 프로젝트',serviceIds:[service.id]});
  const keep=store.saveReview({projectId:second.id,serviceId:service.id,title:'보존할 리뷰'});
  const comment=store.addActivity({reviewId:review.id,body:'삭제할 작업 내용'});
  store.addAttachment(attachment(review.id,{activityId:comment.id}));
  store.addAttachment(attachment(review.id));
  const run=store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'completed',response:'삭제할 응답'});
  const keepFile=store.addAttachment(attachment(keep.id));
  const keepRun=store.saveAgentRun({reviewId:keep.id,serviceId:service.id,status:'completed',response:'보존할 응답'});
  assert.deepEqual(store.deleteProject(project.id),{deleted:true});
  const snapshot=store.snapshot();
  assert.deepEqual(snapshot.projects.map(row=>row.id),[second.id]);
  assert.deepEqual(snapshot.services.map(row=>row.id),[service.id]);
  assert.deepEqual(snapshot.reviews.map(row=>row.id),[keep.id]);
  assert.ok(snapshot.activities.length>0 && snapshot.activities.every(row=>row.reviewId===keep.id));
  assert.deepEqual(snapshot.attachments.map(row=>row.id),[keepFile.id]);
  assert.deepEqual(store.listAgentRuns().map(row=>row.id),[keepRun.id]);
  assert.throws(()=>store.get('agent_runs',run.id),/찾을 수 없습니다/);
  assert.deepEqual(store.project(second.id).serviceIds,[service.id]);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('group deletion removes every project, service and descendant while preserving another group', t=>{
  const {store}=setup(t),removed=fixture(store),keep=fixture(store);
  const extra=store.saveService({groupId:removed.group.id,name:'연결하지 않은 서비스',kind:'local',rootPath:'/tmp'});
  const project=store.saveProject({groupId:removed.group.id,name:'두 번째 프로젝트',serviceIds:[removed.service.id,extra.id]});
  const review=store.saveReview({projectId:project.id,serviceId:extra.id,title:'두 번째 리뷰'});
  for(const item of [removed.review,review,keep.review]) {
    const comment=store.addActivity({reviewId:item.id,body:'작업 내용'});
    store.addAttachment(attachment(item.id,{activityId:comment.id}));
    store.saveAgentRun({reviewId:item.id,serviceId:item.serviceId,status:'completed',response:'작업 응답'});
  }
  const before=store.exportData();
  assert.deepEqual(store.deleteGroup(removed.group.id),{deleted:true});
  const after=store.exportData();
  for(const table of ['groups','projects','services']) assert.deepEqual(after[table],before[table].filter(row=>table==='groups'?row.id===keep.group.id:row.groupId===keep.group.id));
  for(const table of ['reviews','activities','attachments','agentRuns']) assert.deepEqual(after[table],before[table].filter(row=>table==='reviews'?row.projectId===keep.project.id:row.reviewId===keep.review.id));
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('a failure during group deletion rolls back all descendants and service links', t=>{
  const {store}=setup(t),{group,service,project,review}=fixture(store);
  store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'completed',response:'보존할 응답'});
  store.addAttachment(attachment(review.id));
  const before=store.exportData();
  store.db.exec("CREATE TRIGGER fail_group_delete BEFORE DELETE ON groups BEGIN SELECT RAISE(ABORT, '합성 삭제 실패'); END;");
  assert.throws(()=>store.deleteGroup(group.id),/합성 삭제 실패/);
  assert.deepEqual(store.exportData(),before);
  assert.deepEqual(store.project(project.id).serviceIds,[service.id]);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('review deletion cascades comments and attachment metadata without affecting other reviews', t => {
  const { store } = setup(t);
  const { project, review } = fixture(store);
  const other = store.saveReview({ projectId: project.id, title: '보존할 리뷰' });
  const comment = store.addActivity({ reviewId: review.id, body: '삭제될 댓글' });
  store.addAttachment(attachment(review.id));
  store.addAttachment(attachment(review.id, { activityId: comment.id }));
  const keep = store.addAttachment(attachment(other.id));
  store.deleteReview(review.id);
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.reviews.map(row => row.id), [other.id]);
  assert(snapshot.activities.every(row => row.reviewId === other.id));
  assert.deepEqual(snapshot.attachments.map(row => row.id), [keep.id]);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('review creation, edits, status transitions and comments have ordered local history', t => {
  const { store } = setup(t);
  const { review } = fixture(store);
  store.saveReview({ id: review.id, status: 'in_progress' });
  store.saveReview({ id: review.id, title: '수정한 제목', priority: 'high', category: 'feature' });
  store.addActivity({ reviewId: review.id, body: '작업 내용' });
  const activities = store.snapshot().activities;
  assert.deepEqual(activities.map(row => row.type), ['created', 'status', 'updated', 'comment']);
  assert.equal(activities[1].fromStatus, 'open');
  assert.equal(activities[1].toStatus, 'in_progress');
  assert.equal(activities[3].body, '작업 내용');
  const before = store.snapshot();
  assert.throws(() => store.saveReview({ id: review.id, title: '저장 금지', status: 'unknown' }), /올바르지 않습니다/);
  assert.throws(() => store.addActivity({ reviewId: review.id, body: '  ' }), /작업 내용을 입력하거나 상태를 변경/);
  assert.deepEqual(store.snapshot(), before);
});

test('home composer saves status and comment together and rolls back both on failure', t => {
  const { store } = setup(t);
  const { review } = fixture(store);
  const comment = store.addActivity({ reviewId: review.id, body: '작업 완료', status: 'resolved' });
  assert.equal(comment.type, 'comment');
  const changed = store.snapshot();
  assert.equal(changed.reviews[0].status, 'resolved');
  assert.deepEqual(changed.activities.map(item => item.type), ['created', 'status', 'comment']);
  assert.equal(changed.activities[1].fromStatus, 'open');
  assert.equal(changed.activities[1].toStatus, 'resolved');
  const statusOnly = store.addActivity({ reviewId: review.id, status: 'in_progress' });
  assert.equal(statusOnly.type, 'status');
  assert.equal(store.snapshot().reviews[0].status, 'in_progress');
  const before = store.snapshot();
  assert.throws(() => store.addActivity({ reviewId: review.id, body: '저장 금지', status: 'unknown' }), /올바르지 않습니다/);
  assert.throws(() => store.addActivity({ reviewId: review.id, body: '', status: 'in_progress' }), /작업 내용을 입력하거나 상태를 변경/);
  assert.deepEqual(store.snapshot(), before);
  store.db.exec("CREATE TRIGGER reject_test_comment BEFORE INSERT ON activities WHEN NEW.body='reject' BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  assert.throws(() => store.addActivity({ reviewId: review.id, body: 'reject', status: 'closed' }), /test write failure/);
  assert.deepEqual(store.snapshot(), before);
});

test('SSH host trust is retained for description changes and cleared for host or port changes', t => {
  const { store } = setup(t);
  const { service } = fixture(store);
  const trusted = store.saveService({ id: service.id, hostFingerprint: PIN });
  assert.equal(trusted.hostFingerprint, PIN);
  assert.equal(store.saveService({ id: service.id, description: '설명 변경' }).hostFingerprint, PIN);
  assert.equal(store.saveService({ id: service.id, host: 'new.example.test', hostFingerprint: PIN }).hostFingerprint, '');
  store.saveService({ id: service.id, hostFingerprint: PIN });
  assert.equal(store.saveService({ id: service.id, port: 2222 }).hostFingerprint, '');
});

test('service validates roots, keys, URLs and SSH parameters, and never stores secret fields', t => {
  const { store } = setup(t);
  const { group, service } = fixture(store);
  for (const patch of [
    { password: 'synthetic-password' }, { passphrase: 'synthetic-passphrase' }, { privateKey: 'synthetic-private-key' },
    { host: '-oProxyCommand=bad' }, { host: 'bad host' }, { port: 65536 }, { port: -1 },
    { rootPath: '../outside' }, { rootPath: '/tmp/../outside' }, { privateKeyPath: './key' },
    { privateKeyPath: '/tmp/key\nfile' }, { authType: 'key', privateKeyPath: '' },
    { viewerUrl: 'javascript:alert(1)' }, { viewerUrl: 'https://user:pass@example.test' }, { hostFingerprint: 'trust-me' }
  ]) assert.throws(() => store.saveService({ id: service.id, ...patch }));
  assert.throws(() => store.saveService({ groupId: group.id, name: '폴더', kind: 'local' }), /작업 경로/);
  const local = store.saveService({ groupId: group.id, name: '로컬 폴더', kind: 'local', rootPath: '/tmp/test' });
  assert.equal(local.rootPath, '/tmp/test');
  const serialized = JSON.stringify(store.exportData());
  for (const secret of ['synthetic-password', 'synthetic-passphrase', 'synthetic-private-key', 'hasPassword', 'hasPassphrase']) assert.equal(serialized.includes(secret), false);
  assert.equal(Object.hasOwn(store.snapshot().services[0], 'password'), false);
});

test('attachment ownership, filenames, size, hash and uniqueness are validated transactionally', t => {
  const { store } = setup(t);
  const { project, review } = fixture(store);
  const other = store.saveReview({ projectId: project.id, title: '다른 리뷰' });
  const otherComment = store.addActivity({ reviewId: other.id, body: '다른 댓글' });
  const before = store.snapshot();
  for (const patch of [
    { activityId: otherComment.id }, { reviewId: 'missing' }, { storageName: '../escape.txt' }, { name: '../../file' },
    { storageName: 'folder\\file' }, { size: -1 }, { size: 2 ** 40 }, { sha256: 'bad' }, { storageName: '.' }
  ]) assert.throws(() => store.addAttachment(attachment(review.id, patch)));
  assert.deepEqual(store.snapshot(), before);
  const first = store.addAttachment(attachment(review.id));
  assert.throws(() => store.addAttachment(attachment(review.id, { storageName: first.storageName })), /UNIQUE constraint/);
  assert.equal(store.snapshot().attachments.length, 1);
  assert.deepEqual(store.deleteAttachment(first.id), { deleted: true });
});

test('export and import preserve all local content and IDs, while dropping SSH trust and secret availability', t => {
  const { store } = setup(t);
  const { service, review } = fixture(store);
  store.saveService({ id: service.id, hostFingerprint: PIN });
  const activity = store.addActivity({ reviewId: review.id, body: '백업할 댓글' });
  store.addAttachment(attachment(review.id, { activityId: activity.id }));
  store.saveSettings({ theme: 'dark' });
  const backup = store.exportData();
  backup.services[0].hasPassword = true;
  backup.services[0].hasPassphrase = true;
  const original = store.snapshot();
  store.saveGroup({ name: '복원 시 교체할 그룹' });
  const restored = store.importData(backup);
  const expected = clone(original);
  expected.services[0].hostFingerprint = '';
  for (const project of expected.projects) if (project.connection) project.connection.hostFingerprint = '';
  assert.deepEqual(restored, expected);
  assert.deepEqual(store.exportData(), { format: 'reviewops-local', version: SCHEMA_VERSION, ...expected, agentRuns: [], agentRequests: [] });
  assert.equal(backup.services[0].hostFingerprint, PIN, 'input object must remain unchanged');
});

test('invalid imports never alter live data, including malformed final rows and relation violations', t => {
  const { store } = setup(t);
  const { review } = fixture(store);
  store.addAttachment(attachment(review.id));
  const original = store.snapshot();
  const mutations = [
    data => { data.version = 99; },
    data => { data.groups.push(clone(data.groups[0])); },
    data => { data.projects[0].groupId = 'missing'; },
    data => { data.projects[0].serviceIds = ['missing']; },
    data => { data.reviews[0].projectId = 'missing'; },
    data => { data.projects[0].serviceIds = []; },
    data => { data.services[0].password = 'never-import-this'; },
    data => { data.services[0].rootPath = '../escape'; },
    data => { data.activities[0].reviewId = 'missing'; },
    data => { data.attachments[0].storageName = '../escape.txt'; },
    data => { data.attachments[0].size = -1; },
    data => { data.attachments[0].sha256 = 'bad'; },
    data => { data.groups[0].createdAt = 'yesterday'; },
    data => { data.reviews[0].priority = 'unknown'; },
    data => { data.settings = { password: 'never-import-this' }; },
    data => { data.settings = { theme: 'neon' }; },
    data => { data.attachments[0].unexpected = 'unknown-column'; }
  ];
  for (const mutate of mutations) {
    const broken = clone(store.exportData()); mutate(broken);
    assert.throws(() => store.importData(broken));
    assert.deepEqual(store.snapshot(), original);
  }
});

test('import rejects an attachment assigned to a different review activity', t => {
  const { store } = setup(t);
  const { project, review } = fixture(store);
  const other = store.saveReview({ projectId: project.id, title: '다른 리뷰' });
  const comment = store.addActivity({ reviewId: other.id, body: '다른 리뷰 댓글' });
  store.addAttachment(attachment(review.id));
  const before = store.snapshot();
  const broken = store.exportData(); broken.attachments[0].activityId = comment.id;
  assert.throws(() => store.importData(broken), /같은 리뷰/);
  assert.deepEqual(store.snapshot(), before);
});

test('SQLite backup is consistent while WAL is active and never overwrites existing files', t => {
  const { store, directory, dbPath } = setup(t);
  fixture(store); store.saveSettings({ theme: 'dark' });
  const before = store.snapshot();
  const destination = path.join(directory, 'backup.sqlite');
  const result = store.backup(destination);
  assert(result.size > 0);
  assert.throws(() => store.backup(destination), /이미 있습니다/);
  assert.throws(() => store.backup(dbPath), /다른 경로/);
  const backup = createStore({ dbPath: destination });
  try { assert.deepEqual(backup.snapshot(), before); }
  finally { backup.close(); }
});

test('two open stores observe committed writes and allocate distinct review numbers', t => {
  const { store, reopen } = setup(t);
  const { project } = fixture(store);
  const second = reopen();
  const next = store.saveReview({ projectId: project.id, title: '두 번째' });
  const third = second.saveReview({ projectId: project.id, title: '세 번째' });
  assert.equal(next.number, 2); assert.equal(third.number, 3);
  assert.deepEqual(store.snapshot(), second.snapshot());
});

test('a newer database is refused without changing its schema or rows', t => {
  const { store, dbPath, reopen } = setup(t);
  fixture(store); store.close();
  const database = new DatabaseSync(dbPath);
  database.exec('PRAGMA user_version=999'); database.close();
  assert.throws(() => reopen(), error => error.code === 'NEWER_DATABASE');
  const raw = new DatabaseSync(dbPath);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 999);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM groups').get().n, 1);
  raw.close();
});

test('group, project and service metadata persist and invalid metadata leaves the whole row unchanged', t => {
  const { store, reopen } = setup(t);
  const { group, project, service } = fixture(store);
  const values = { memo: '첫 번째 줄\n두 번째 줄', labels: ['배포', '화면', '배포'], operationalStatus: 'archived' };
  const groupSaved = store.saveGroup({ id: group.id, ...values });
  const projectSaved = store.saveProject({ id: project.id, ...values });
  const serviceSaved = store.saveService({ id: service.id, ...values, operationalStatus: 'disabled', viewerWidth: 1920, viewerHeight: 1080, viewerScale: '75' });
  assert.deepEqual(groupSaved.labels, ['배포', '화면']);
  assert.deepEqual(projectSaved.labels, ['배포', '화면']);
  assert.equal(serviceSaved.operationalStatus, 'disabled');
  assert.equal(serviceSaved.viewerWidth, 1920);
  assert.equal(serviceSaved.viewerHeight, 1080);
  assert.equal(serviceSaved.viewerScale, '75');
  store.saveGroup({ id: group.id, name: '그룹 이름 변경' });
  store.saveProject({ id: project.id, name: '프로젝트 이름 변경' });
  store.saveService({ id: service.id, name: '서비스 이름 변경' });
  const before = store.snapshot();
  for (const [method, item] of [['saveGroup', group], ['saveProject', project], ['saveService', service]]) {
    for (const patch of [{ labels: '잘못된 배열' }, { labels: [''] }, { labels: Array(31).fill('라벨') }, { labels: ['x'.repeat(81)] }, { operationalStatus: 'unknown' }, { memo: 'x'.repeat(50001) }]) {
      assert.throws(() => store[method]({ id: item.id, name: '저장 금지', ...patch }));
      assert.deepEqual(store.snapshot(), before);
    }
  }
  for (const patch of [{ viewerWidth: 239 }, { viewerHeight: 7681 }, { viewerScale: '500' }]) {
    assert.throws(() => store.saveService({ id: service.id, ...patch }));
    assert.deepEqual(store.snapshot(), before);
  }
  store.close();
  const next = reopen();
  assert.deepEqual(next.snapshot(), before);
  assert.equal(next.snapshot().groups[0].memo, values.memo);
  assert.deepEqual(next.snapshot().projects[0].labels, ['배포', '화면']);
  assert.equal(next.snapshot().services[0].viewerScale, '75');
});

test('all original ReviewOps categories can be saved and restored without losing the earlier feature category', t => {
  const { store } = setup(t);
  const { project } = fixture(store);
  const categories = ['bug', 'ux', 'feature', 'content', 'performance', 'accessibility', 'security', 'structure', 'design', 'data', 'message', 'typo', 'other'];
  for (const category of categories) {
    const review = store.saveReview({ projectId: project.id, title: `분류 ${category}`, category });
    assert.equal(review.category, category);
  }
  const before = store.snapshot();
  const backup = store.exportData();
  assert.equal(backup.version, SCHEMA_VERSION);
  assert.deepEqual(store.importData(backup), before);
  assert.throws(() => store.saveReview({ projectId: project.id, title: '저장 금지', category: 'not-a-category' }), /올바르지 않습니다/);
  assert.deepEqual(store.snapshot(), before);
});

test('editing a comment keeps its identity, creation time and attached files and updates its review', t => {
  const { store } = setup(t);
  const { review } = fixture(store);
  const comment = store.addActivity({ reviewId: review.id, body: '원래 작업 내용' });
  const file = store.addAttachment(attachment(review.id, { activityId: comment.id }));
  const updated = store.updateActivity({ id: comment.id, body: '수정한 작업 내용' });
  assert.equal(updated.id, comment.id);
  assert.equal(updated.createdAt, comment.createdAt);
  assert.equal(updated.reviewId, review.id);
  assert.equal(updated.body, '수정한 작업 내용');
  assert(updated.updatedAt >= comment.updatedAt);
  assert.equal(store.snapshot().reviews[0].updatedAt, updated.updatedAt);
  assert.deepEqual(store.snapshot().attachments.map(item => item.id), [file.id]);
  const before = store.snapshot();
  const creation = before.activities.find(item => item.type === 'created');
  assert.throws(() => store.updateActivity({ id: creation.id, body: '기록 변조' }), /작업 내용만 편집/);
  assert.throws(() => store.updateActivity({ id: 'missing', body: '없음' }), /찾을 수 없습니다/);
  assert.throws(() => store.updateActivity({ id: comment.id, body: 'x'.repeat(100001) }), /100000자/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.updateActivity({ id: comment.id, body: '' }).body, '');
  const textOnly = store.addActivity({ reviewId: review.id, body: '파일 없는 댓글' });
  assert.throws(() => store.updateActivity({ id: textOnly.id, body: ' ' }), /입력하십시오/);
  assert.equal(store.snapshot().activities.find(item => item.id === textOnly.id).body, '파일 없는 댓글');
});

test('a files-only activity and its attachments save together, survive backup, and roll back on attachment failure', t => {
  const { store } = setup(t);
  const { review } = fixture(store);
  const comment = store.transaction(() => {
    const row = store.addActivity({ reviewId: review.id, body: '', allowEmpty: true });
    store.addAttachment(attachment(review.id, { activityId: row.id }));
    return row;
  });
  assert.equal(comment.type, 'comment');
  assert.equal(comment.body, '');
  const before = store.snapshot();
  assert.deepEqual(store.importData(store.exportData()), before);
  assert.throws(() => store.transaction(() => {
    const row = store.addActivity({ reviewId: review.id, body: '', status: 'resolved', allowEmpty: true });
    store.addAttachment(attachment(review.id, { activityId: row.id, sha256: 'invalid' }));
  }), /파일 해시/);
  assert.deepEqual(store.snapshot(), before);
  const invalidBackup = store.exportData();
  invalidBackup.attachments = [];
  assert.throws(() => store.importData(invalidBackup), /입력하십시오/);
  assert.deepEqual(store.snapshot(), before);
});

function oldBackup() {
  const createdAt = '2026-09-01T01:00:00.000Z';
  const updatedAt = '2026-09-02T02:00:00.000Z';
  const common = { createdAt, updatedAt };
  return {
    format: 'reviewops-local', version: 1,
    groups: [{ id: 'group-old', name: '기존 그룹', description: '그룹 설명', ...common }],
    projects: [{ id: 'project-old', groupId: 'group-old', name: '기존 프로젝트', description: '프로젝트 설명', serviceIds: ['service-old'], ...common }, { id: 'project-shared', groupId: 'group-old', name: '공유 프로젝트', description: '', serviceIds: ['service-old'], ...common }],
    services: [{ id: 'service-old', groupId: 'group-old', name: '기존 SSH 서비스', description: '서비스 설명', kind: 'ssh', host: 'migration.example.test', port: 2222, username: 'test-user', authType: 'agent', privateKeyPath: '', rootPath: '/opt/test', viewerUrl: 'https://migration.example.test/', hostFingerprint: PIN, ...common }],
    reviews: [{ id: 'review-old', projectId: 'project-old', serviceId: 'service-old', number: 1, title: '기존 기능 요청', body: '첫 줄\n둘째 줄', status: 'in_progress', priority: 'high', category: 'feature', targetPath: 'src/app.ts', targetUrl: 'https://migration.example.test/app', ...common }, { id: 'review-other', projectId: 'project-old', serviceId: null, number: 2, title: '기존 화면 요청', body: '내용', status: 'closed', priority: 'normal', category: 'ux', targetPath: '', targetUrl: '', ...common }],
    activities: [{ id: 'activity-start', reviewId: 'review-old', type: 'created', body: '리뷰를 등록했습니다.', fromStatus: '', toStatus: '', ...common }, { id: 'activity-status', reviewId: 'review-old', type: 'status', body: '', fromStatus: 'open', toStatus: 'in_progress', ...common }, { id: 'activity-comment', reviewId: 'review-old', type: 'comment', body: '기존 작업이력', fromStatus: '', toStatus: '', ...common }],
    attachments: [{ id: 'file-comment', ...attachment('review-old', { activityId: 'activity-comment', storageName: 'existing-comment.txt' }), ...common }, { id: 'file-review', ...attachment('review-other', { activityId: null, storageName: 'existing-review.txt' }), ...common }],
    settings: { theme: 'dark' }
  };
}

function populateV1Database(database, payload) {
  database.exec(fs.readFileSync(path.join(__dirname, 'fixtures/schema-v1.sql'), 'utf8'));
  const insert = (table, row) => {
    const keys = Object.keys(row);
    database.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  };
  for (const table of ['groups', 'projects', 'services']) {
    for (const value of payload[table]) { const { serviceIds, ...row } = value; insert(table, row); }
  }
  for (const project of payload.projects) for (const serviceId of project.serviceIds) insert('project_services', { projectId: project.id, serviceId });
  for (const table of ['reviews', 'activities', 'attachments']) for (const row of payload[table]) insert(table, row);
  insert('settings', { key: 'theme', valueJson: JSON.stringify(payload.settings.theme) });
}

function assertOldDataPreserved(snapshot, payload, { resetTrust = false } = {}) {
  for (const table of ['groups', 'projects', 'services', 'reviews', 'activities', 'attachments']) {
    assert.equal(snapshot[table].length, payload[table].length, `${table} row count`);
    for (const previous of payload[table]) {
      const next = snapshot[table].find(item => item.id === previous.id);
      assert(next, `${table} ${previous.id}`);
      for (const [key, value] of Object.entries(previous)) assert.deepEqual(next[key], resetTrust && key === 'hostFingerprint' ? '' : value, `${table}.${key}`);
    }
  }
  for (const table of ['groups', 'projects', 'services']) for (const row of snapshot[table]) {
    assert.deepEqual(row.labels, []); assert.equal(row.memo, ''); assert.equal(row.operationalStatus, 'active');
  }
  assert.equal(snapshot.services[0].viewerWidth, 1440);
  assert.equal(snapshot.services[0].viewerHeight, 900);
  assert.equal(snapshot.services[0].viewerScale, 'fit');
  assert.deepEqual(snapshot.settings, payload.settings);
}

test('an actual 1.0.1 SQLite schema migrates to the current version without losing records, links, identities or host trust', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-migrate-v1-'));
  const dbPath = path.join(directory, 'legacy.sqlite');
  let migrated;
  t.after(() => { migrated?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const original = oldBackup();
  const legacy = new DatabaseSync(dbPath);
  populateV1Database(legacy, original);
  assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(legacy.prepare('PRAGMA table_info(groups)').all().some(item => item.name === 'labels'), false);
  legacy.close();
  migrated = createStore({ dbPath });
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assertOldDataPreserved(migrated.snapshot(), original);
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(migrated.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => migrated.db.prepare('DELETE FROM services WHERE id=?').run('service-old'), /모든 프로젝트/);
  const after = migrated.snapshot();
  migrated.close();
  migrated = createStore({ dbPath });
  assert.deepEqual(migrated.snapshot(), after);
  const next = migrated.saveReview({ projectId: 'project-old', serviceId: 'service-old', title: '갱신 후 리뷰', category: 'security' });
  assert.equal(next.number, 3);
  migrated.deleteReview('review-old');
  assert.equal(migrated.snapshot().activities.some(item => item.reviewId === 'review-old'), false);
  assert.equal(migrated.snapshot().activities.find(item => item.reviewId === next.id).type, 'created');
  assert.deepEqual(migrated.snapshot().attachments.map(item => item.id), ['file-review']);
});

test('a version 1 JSON backup restores with metadata defaults while preserving all old fields and dropping SSH trust', t => {
  const { store } = setup(t);
  fixture(store);
  const original = oldBackup();
  const unchanged = clone(original);
  assertOldDataPreserved(store.importData(original), original, { resetTrust: true });
  assert.deepEqual(original, unchanged);
  assert.equal(store.exportData().version, SCHEMA_VERSION);
});

test('project introduction is independent of its description and survives backup',t=>{
  const {store}=setup(t);const {project}=fixture(store);
  const saved=store.saveProject({id:project.id,intro:'프로젝트 소개 본문',description:'목록에 표시할 설명'});
  assert.equal(saved.intro,'프로젝트 소개 본문');assert.equal(saved.description,'목록에 표시할 설명');
  store.saveProject({id:project.id,intro:'수정한 소개'});
  const before=store.snapshot();
  assert.equal(before.projects.find(row=>row.id===project.id).description,'목록에 표시할 설명');
  assert.deepEqual(store.importData(store.exportData()),before);
});

test('deleting the final file of a files-only activity leaves a restorable history record',t=>{
  const {store}=setup(t);const {review}=fixture(store);
  const comment=store.addActivity({reviewId:review.id,body:'',allowEmpty:true});
  const one=store.addAttachment(attachment(review.id,{activityId:comment.id,storageName:'one.txt'}));
  const two=store.addAttachment(attachment(review.id,{activityId:comment.id,storageName:'two.txt'}));
  store.deleteAttachment(one.id);
  assert.equal(store.snapshot().activities.find(row=>row.id===comment.id).body,'');
  store.deleteAttachment(two.id);
  const before=store.snapshot();
  assert.equal(before.activities.find(row=>row.id===comment.id).body,'첨부 파일을 삭제했습니다.');
  assert.deepEqual(store.importData(store.exportData()),before);
});
