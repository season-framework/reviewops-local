'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createStore} = require('../electron/store.cjs');
const {createRemoteAppCommands} = require('../electron/remote-app-commands.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-app-commands-'));
  const dbPath = path.join(directory, 'owned.sqlite'); let store = createStore({dbPath});
  t.after(() => { store.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const group = store.saveGroup({name: 'App command fixture'});
  const service = store.saveService({groupId: group.id, name: 'Host execution', kind: 'local', rootPath: directory});
  const project = store.saveProject({groupId: group.id, name: 'Shared project', serviceIds: [service.id]});
  const other = store.saveProject({groupId: group.id, name: 'Private project', serviceIds: [service.id]});
  const review = store.saveReview({projectId: project.id, serviceId: service.id, title: 'Original review'});
  let allowed = true, write = true, execute = true;
  const session = Object.freeze({});
  const authorize = value => {
    assert.equal(value, session);
    if (!allowed) throw Object.assign(new Error('Revoked'), {code: 'ACCESS_DENIED'});
    return {principalId: 'paired-device', projectGrants: [{projectId: project.id, read: true, write, execute}]};
  };
  const envelope = (operation, payload, requestId = operation.replaceAll('.', '-'), reviewId = review.id) => ({operation, requestId,
    projectId: project.id, reviewId, epoch: store.peerReadDataset().epoch,
    expectedProjectBirth: store.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(project.id).birth,
    expectedReviewGeneration: reviewId ? store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(reviewId).generation : 0,
    expectedRevision: reviewId ? store.db.prepare('SELECT revision FROM review_revisions WHERE reviewId=?').get(reviewId).revision : 0, payload});
  return {group, service, project, other, review, session, authorize, envelope,
    get store() { return store; }, setRights(value) { ({allowed = allowed, write = write, execute = execute} = value); },
    reopen() { store.close(); store = createStore({dbPath}); return store; }};
}
const code = expected => error => error.code === expected;
const unreachable = () => { throw new Error('Agent execution was not expected'); };

test('app review creation, edit and comment commit once and receipts survive Store reopen', async t => {
  const f = fixture(t); let commands = createRemoteAppCommands({store: f.store, authorize: f.authorize, executeAgent: unreachable});
  const create = f.envelope('review.create', {title: 'Created remotely', body: 'Host-owned data', priority: 'normal', category: 'ux'}, 'create-once', '');
  const created = await commands.execute(f.session, create), id = created.result.reviewId;
  assert.equal(f.store.get('reviews', id).projectId, f.project.id);
  assert.deepEqual(await commands.execute(f.session, create), created);
  const edit = f.envelope('review.update', {title: 'Remote edit', body: 'Updated once', priority: 'high', category: 'ux'}, 'edit-once', id);
  const updated = await commands.execute(f.session, edit);
  const comment = f.envelope('comment.add', {body: 'One remote comment'}, 'comment-once', id);
  const commented = await commands.execute(f.session, comment);
  assert.equal(f.store.snapshot().activities.filter(row => row.reviewId === id && row.body === 'One remote comment').length, 1);
  const exported = f.store.exportData(); assert.equal(Object.hasOwn(exported, 'remote_app_commands'), false);
  commands = createRemoteAppCommands({store: f.reopen(), authorize: f.authorize, executeAgent: unreachable});
  assert.deepEqual(await commands.execute(f.session, create), created);
  assert.deepEqual(await commands.execute(f.session, edit), updated);
  assert.deepEqual(await commands.execute(f.session, comment), commented);
  assert.deepEqual(commands.result(f.session, {epoch: create.epoch, projectId: f.project.id, requestId: create.requestId}), created);
  assert.deepEqual(f.store.exportData(), exported);
});

test('app permissions, request identity, revision conflicts and backup replacement reject before mutation', async t => {
  const f = fixture(t), commands = createRemoteAppCommands({store: f.store, authorize: f.authorize, executeAgent: unreachable});
  const command = f.envelope('review.status.set', {status: 'resolved'});
  f.setRights({write: false}); await assert.rejects(commands.execute(f.session, command), code('ACCESS_DENIED'));
  assert.equal(f.store.get('reviews', f.review.id).status, 'open');
  f.setRights({write: true}); const result = await commands.execute(f.session, command);
  await assert.rejects(commands.execute(f.session, {...command, payload: {status: 'closed'}}), code('IDEMPOTENCY_CONFLICT'));
  const stale = f.envelope('comment.add', {body: 'Stale comment'}); f.store.addActivity({reviewId: f.review.id, body: 'Local edit'});
  await assert.rejects(commands.execute(f.session, stale), code('REVISION_CONFLICT'));
  f.setRights({allowed: false}); await assert.rejects(commands.execute(f.session, command), code('ACCESS_DENIED'));
  f.setRights({allowed: true}); assert.deepEqual(await commands.execute(f.session, command), result);
  f.store.importData(f.store.exportData());
  await assert.rejects(commands.execute(f.session, command), code('STALE_EPOCH'));
  assert.equal(f.store.snapshot().activities.filter(row => row.body === 'Stale comment').length, 0);
});

test('a remote agent start retains one host request identity while concurrent requests and reconnects query it', async t => {
  const f = fixture(t); let launches = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  const executeAgent = async (action, payload, guard) => {
    assert.equal(action, 'agent.start'); assert.equal(Object.hasOwn(payload, 'workPath'), false);
    await wait; guard();
    const existing = f.store.listAgentRuns().find(row => row.id === payload.requestId);
    if (existing) return existing;
    launches++;
    return f.store.saveAgentRun({id: payload.requestId, reviewId: payload.reviewId, serviceId: f.service.id,
      prompt: payload.prompt, workPath: '/host-owned/workspace', status: 'running'});
  };
  const commands = createRemoteAppCommands({store: f.store, authorize: f.authorize, executeAgent});
  const command = f.envelope('agent.start', {prompt: 'Run on the host'});
  const first = commands.execute(f.session, command), second = commands.execute(f.session, command);
  assert.equal(commands.result(f.session, {epoch: command.epoch, projectId: f.project.id, requestId: command.requestId}).state, 'pending');
  release(); const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(launches, 1); assert.match(a.result.runId, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(a.result, 'workPath'), false);
  const reopened = createRemoteAppCommands({store: f.reopen(), authorize: f.authorize, executeAgent});
  assert.deepEqual(await reopened.execute(f.session, command), a); assert.equal(launches, 1);
});

test('host checks the original app grant after asynchronous preparation and cannot stop another review run', async t => {
  const f = fixture(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const commands = createRemoteAppCommands({store: f.store, authorize: f.authorize, executeAgent: async (_action, _payload, guard) => {
    entered(); await wait; guard(); calls++; return {id: 'unexpected', status: 'running'};
  }});
  const request = commands.execute(f.session, f.envelope('agent.start', {prompt: 'Must be revoked before host launch'}));
  await ready; f.setRights({execute: false}); release(); await assert.rejects(request, code('ACCESS_DENIED')); assert.equal(calls, 0);
  f.setRights({execute: true});
  const otherReview = f.store.saveReview({projectId: f.other.id, serviceId: f.service.id, title: 'Private review'});
  const run = f.store.saveAgentRun({reviewId: otherReview.id, serviceId: f.service.id, prompt: 'Private host task', workPath: '/private', status: 'running'});
  await assert.rejects(commands.execute(f.session, f.envelope('agent.stop', {runId: run.id})), code('NOT_FOUND'));
  assert.equal(calls, 0);
});

test('pending agent command survives a failed response and resumes with the same durable host ID', async t => {
  const f = fixture(t), ids = []; let loseResponse = true;
  const executeAgent = async (_action, payload, guard) => {
    guard(); ids.push(payload.requestId);
    const run = f.store.listAgentRuns().find(row => row.id === payload.requestId) ||
      f.store.saveAgentRun({id: payload.requestId, reviewId: payload.reviewId, serviceId: f.service.id,
        prompt: payload.prompt, workPath: '/host-only', status: 'running'});
    if (loseResponse) throw new Error('Synthetic lost response after durable host acceptance');
    return run;
  };
  let commands = createRemoteAppCommands({store: f.store, authorize: f.authorize, executeAgent});
  const command = f.envelope('agent.start', {prompt: 'Do not launch twice'});
  await assert.rejects(commands.execute(f.session, command), code('COMMAND_FAILED'));
  loseResponse = false; commands = createRemoteAppCommands({store: f.reopen(), authorize: f.authorize, executeAgent});
  const result = await commands.execute(f.session, command);
  assert.equal(result.state, 'completed'); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(f.store.listAgentRuns().length, 1);
});

test('read permission supplies command metadata for execute-only devices and empty-project creation', t => {
  const f = fixture(t), commands = createRemoteAppCommands({store: f.store, authorize: f.authorize, executeAgent: unreachable});
  f.setRights({write: false, execute: true});
  const state = commands.writeState(f.session, {projectId: f.project.id, reviewId: f.review.id});
  assert.equal(state.epoch, f.store.peerReadDataset().epoch); assert.equal(state.status, 'open'); assert.ok(state.revision >= 1);
  const create = commands.writeState(f.session, {projectId: f.project.id, reviewId: ''});
  assert.equal(create.revision, 0); assert.equal(create.reviewId, ''); assert.equal(create.status, '');
  assert.throws(() => commands.writeState(f.session, {projectId: f.other.id, reviewId: ''}), code('ACCESS_DENIED'));
});

test('host change notification follows the first business commit and excludes receipt replays and unchanged status', async t => {
  const f = fixture(t), notifications = [];
  const commands = createRemoteAppCommands({store: f.store, authorize: f.authorize, executeAgent: unreachable,
    onCommitted(event) {
      assert.equal(f.store.inTransaction, false);
      assert.ok(Object.isFrozen(event));
      notifications.push({...event, storedStatus: f.store.get('reviews', event.reviewId).status,
        comments: f.store.snapshot().activities.filter(row => row.body === 'Notify the host once').length});
    }});
  const comment = f.envelope('comment.add', {body: 'Notify the host once'});
  await commands.execute(f.session, comment); await commands.execute(f.session, comment);
  assert.equal(notifications.length, 1); assert.equal(notifications[0].comments, 1);
  const unchanged = f.envelope('review.status.set', {status: 'open'}, 'unchanged-status');
  await commands.execute(f.session, unchanged); assert.equal(notifications.length, 1);
  const status = f.envelope('review.status.set', {status: 'resolved'}, 'changed-status');
  await commands.execute(f.session, status); await commands.execute(f.session, status);
  assert.equal(notifications.length, 2); assert.equal(notifications[1].storedStatus, 'resolved');
  const conflict = f.envelope('comment.add', {body: 'Do not notify failed admission'}, 'conflicted');
  f.store.addActivity({reviewId: f.review.id, body: 'Concurrent local save'});
  await assert.rejects(commands.execute(f.session, conflict), code('REVISION_CONFLICT'));
  assert.equal(notifications.length, 2);
});

test('an original draft cannot target a deleted and recreated review with matching ID and revision', async t => {
  const f=fixture(t),commands=createRemoteAppCommands({store:f.store,authorize:f.authorize,executeAgent:unreachable});
  const stale=f.envelope('comment.add',{body:'Do not attach to the replacement'}),original=f.store.get('reviews',f.review.id);
  f.store.deleteReview(f.review.id);f.store.upsert('reviews',original);
  const current=commands.writeState(f.session,{projectId:f.project.id,reviewId:f.review.id});
  // Even if a replacement's revision numerically matches the observed draft,
  // its monotonic incarnation must reject the original intent before receipts.
  await assert.rejects(commands.execute(f.session,{...stale,expectedRevision:current.revision}),code('STALE_REVIEW'));
  assert.notEqual(current.reviewGeneration,stale.expectedReviewGeneration);
  assert.equal(f.store.snapshot().activities.filter(row=>row.body===stale.payload.body).length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM remote_app_commands').get().count,0);
});

test('a create draft cannot follow a project deleted and reinserted in the same epoch', async t => {
  const f=fixture(t),commands=createRemoteAppCommands({store:f.store,authorize:f.authorize,executeAgent:unreachable});
  const stale=f.envelope('review.create',{title:'Old project draft',body:'Retained',priority:'normal',category:'ux'},'old-project','');
  const original={...f.store.db.prepare('SELECT * FROM projects WHERE id=?').get(f.project.id)};
  f.store.deleteProject(f.project.id);f.store.upsert('projects',original);
  await assert.rejects(commands.execute(f.session,stale),code('STALE_REVIEW'));
  assert.equal(f.store.snapshot().reviews.some(row=>row.title==='Old project draft'),false);
});
