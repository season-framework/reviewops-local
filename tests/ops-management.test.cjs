'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {OpsManager} = require('../electron/ops-manager.cjs');
const {OpsStore, validateOpsData} = require('../electron/ops-store.cjs');
const {createProjectAdapter} = require('../electron/ops-management.cjs');
const {createStore} = require('../electron/store.cjs');

async function harness(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-ops-management-')), dataPath = path.join(root, 'data'), sessions = new Map(), external = new Map(), calls = [], managers = [];
  const projectStore = createStore({dbPath: path.join(root, 'projects.sqlite')}); let changed = 0;
  const adapter = createProjectAdapter({getStore: () => projectStore, onChange: () => changed++, ...extra.adapterOptions});
  const createSession = options => {
    const state = {options, threadId: options.threadId, turnId: null, runtime: null}; sessions.set(options.goalId, state);
    const deliver = kind => async input => {
      const saved = JSON.parse(fs.readFileSync(path.join(dataPath, 'ops', 'state.json'), 'utf8'));
      const owner = saved.managementConversations?.find(row => row.id === options.goalId) || saved.goals.find(row => row.id === options.goalId);
      const request = (owner.requests || owner.history).find(row => row.id === input.deliveryId);
      assert.equal(request.status, 'prepared', 'Every model input is durably prepared before it is sent');
      calls.push({kind, id: options.goalId, ...input});
      state.runtime ||= await (options.resolveRuntime ? options.resolveRuntime() : options.runtime);
      if (extra.beforeDeliver) await extra.beforeDeliver(input, state);
      state.threadId ||= 'thread_' + options.goalId; state.turnId ||= 'turn_' + randomUUID();
      await options.onEvent({type: 'thread', threadId: state.threadId});
      await options.onEvent({type: 'turn.started', threadId: state.threadId, turnId: state.turnId});
      const result = {threadId: state.threadId, turnId: state.turnId, state: 'running', delivery: 'accepted', backgroundState: 'empty', backgroundCount: 0};
      external.set(input.deliveryId, result);
      if (extra.deliver) return extra.deliver(input, state, result);
      return result;
    };
    return {
      start: deliver('start'), steer: deliver('steer'),
      async reconcile(input) { calls.push({kind: 'reconcile', id: options.goalId, ...input}); return extra.reconcile ? extra.reconcile(input, state, external) : external.get(input.deliveryId) || {threadId: input.threadId, state: 'idle', backgroundState: 'empty', backgroundCount: 0, delivery: 'not_found', safeToRetry: true}; },
      async interrupt(input) { calls.push({kind: 'interrupt', id: options.goalId, ...input}); await options.onEvent({type: 'turn.completed', threadId: state.threadId || input.threadId, turnId: state.turnId || input.turnId, status: 'interrupted', backgroundState: 'empty', backgroundCount: 0}); return {confirmed: true, state: 'idle', turnId: state.turnId || input.turnId}; },
      async close() { calls.push({kind: 'close', id: options.goalId}); if(extra.close)await extra.close(state); }
    };
  };
  const options = {dataPath, createSession, managementAdapter: adapter, schedulerOptions: {setTimer: () => 1, clearTimer: () => {}}, resolveTarget: async input => {
    const project = input.projectId && projectStore.project(input.projectId), workPath = project ? project.connection.rootPath : input.workPath;
    return {workPath: fs.realpathSync(workPath), projectId: project?.id || '', targetKind: 'local', targetIdentity: 'local', serviceId: project?.connection?.id || null};
  },...extra.managerOptions};
  const manager = new OpsManager(options); managers.push(manager);
  t.after(async () => { await Promise.allSettled(managers.map(item => item.close())); projectStore.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const create = async (input = {}) => (await manager.managementCreate(input)).managementConversations.at(-1).id;
  const request = async (id, instruction = 'List the current projects.') => { await manager.managementRequest({conversationId: id, instruction}); await manager.management.pump(id); };
  const tool = (id, name, args, callId = randomUUID()) => { const session = sessions.get(id); return session.options.tools.find(item => item.name === name).execute(args, {callId, threadId: session.threadId, turnId: session.turnId}); };
  const complete = async id => {
    const session = sessions.get(id), turnId = session.turnId;
    for (const item of external.values()) if (item.threadId === session.threadId) Object.assign(item, {state: 'idle', outcome: 'completed', turnStatus: 'completed', backgroundState: 'empty', backgroundCount: 0});
    await session.options.onEvent({type: 'turn.completed', threadId: session.threadId, turnId, status: 'completed', backgroundState: 'empty', backgroundCount: 0}); session.turnId = null;
  };
  return {root, dataPath, manager, options, managers, sessions, external, calls, projectStore, adapter, create, request, tool, complete, changed: () => changed};
}

test('management conversations use separate persistent threads, private working folders and real streaming snapshots', async t => {
  const h = await harness(t), a = await h.create({name: 'Release planning', model: 'gpt-6.1', reasoningEffort: 'high'}), b = await h.create({name: 'Project setup'});
  assert.equal(h.calls.length, 0, 'Creating a conversation does not execute a turn');
  await h.request(a); await h.request(b);
  const first = h.sessions.get(a), second = h.sessions.get(b);
  assert.notEqual(first.threadId, second.threadId);
  assert.equal(first.options.workPath, path.join(h.dataPath, 'ops', 'management', a));
  assert.deepEqual(first.options.config, {model: 'gpt-6.1', reasoningEffort: 'high', sandboxMode: 'danger-full-access', approvalPolicy: 'never'});
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.options.workPath).mode & 0o077, 0);
  await first.options.onEvent({type: 'message', role: 'assistant', itemId: 'answer', text: 'Working', partial: true});
  assert.equal(h.manager.snapshot().managementConversations[0].conversation.at(-1).text, 'Working');
  assert.equal(h.manager.snapshot().managementConversations[0].conversation.at(-1).partial, true);
  assert.ok(h.manager.snapshot().managementConversations[0].conversation.at(-1).createdAt);
  await first.options.onEvent({type: 'message', role: 'assistant', itemId: 'answer', text: 'Finished the requested inspection.', partial: false});
  await h.complete(a); await h.request(a, 'Continue the same planning conversation.');
  assert.equal(h.sessions.get(a), first); assert.equal(h.calls.filter(row => row.id === a && row.kind === 'start').length, 2);
  const restored = new OpsStore({dataPath: h.dataPath}).read();
  assert.equal(restored.managementConversations[0].threadId, first.threadId);
  assert.equal(restored.managementConversations[0].conversation.filter(row => row.id === 'answer').length, 1);
  assert.equal(restored.managementConversations[0].conversation.find(row => row.id === 'answer').partial, false);
  assert.equal(restored.goals.length, 0);
});

test('reconciled management messages retain original positions metadata and timestamps across restart', async t => {
  const messages = [{itemId: 'first-replayed-answer', text: 'First original answer'}, {itemId: 'second-replayed-answer', text: 'Second original answer'}];
  const h = await harness(t, {reconcile: async (input, state) => {
    for (const message of messages) await state.options.onEvent({type: 'message', role: 'assistant', partial: false, ...message});
    return {threadId: input.threadId, state: 'idle', backgroundState: 'empty', backgroundCount: 0, delivery: 'accepted', outcome: 'completed'};
  }}), id = await h.create();
  await h.request(id); const session = h.sessions.get(id);
  await session.options.onEvent({type: 'message', role: 'assistant', partial: false, ...messages[0]});
  const project = await h.tool(id, 'ops_projects_create', {name: 'Interleaved real project result', workPath: h.root});
  await session.options.onEvent({type: 'message', role: 'assistant', partial: false, ...messages[1]});
  h.manager.store.update(data => { data.managementConversations[0].conversation.find(row => row.id === messages[0].itemId).links = [{kind: 'project', id: project.data.id, name: project.data.name}]; });
  await h.complete(id); const before = h.manager.snapshot().managementConversations[0], starts = h.calls.filter(row => row.kind === 'start').length;
  assert.deepEqual(before.conversation.map(row => row.role), ['user', 'assistant', 'tool', 'assistant']);
  await h.manager.management.reconnect(id);
  assert.deepEqual(h.manager.snapshot().managementConversations[0].conversation, before.conversation);
  await h.manager.close(); const reopened = new OpsManager(h.options); h.managers.push(reopened); await reopened.init(); await reopened.management.reconnect(id);
  assert.deepEqual(reopened.snapshot().managementConversations[0].conversation, before.conversation);
  assert.equal(h.calls.filter(row => row.kind === 'start').length, starts, 'Metadata replay never sends another model turn');
  const restored = h.sessions.get(id); await restored.options.onEvent({type: 'message', role: 'assistant', itemId: 'genuinely-new-message', text: 'New message appends', partial: false});
  const after = reopened.snapshot().managementConversations[0].conversation; assert.deepEqual(after.slice(0, -1), before.conversation); assert.equal(after.at(-1).id, 'genuinely-new-message');
  await restored.options.onEvent({type: 'message', role: 'assistant', itemId: messages[0].itemId, text: 'Updated same original message', partial: false});
  const updated = reopened.snapshot().managementConversations[0].conversation; assert.deepEqual(updated.map(row => row.id), after.map(row => row.id)); assert.equal(updated[1].createdAt, before.conversation[1].createdAt); assert.deepEqual(updated[1].links, before.conversation[1].links); assert.equal(updated[1].text, 'Updated same original message');
});

test('typed management tools create actual projects/goals/schedules and link results without using the management thread for goal work', async t => {
  const h = await harness(t), id = await h.create(); await h.request(id, 'Create a project and a goal; then start that goal.');
  const projectResult = await h.tool(id, 'ops_projects_create', {name: 'Managed project', workPath: h.root, groupName: 'Release work'}, 'project-add');
  assert.equal(projectResult.ok, true); const project = h.projectStore.project(projectResult.data.id);
  assert.equal(project.name, 'Managed project'); assert.equal(project.connection.rootPath, fs.realpathSync(h.root)); assert.equal(h.changed(), 1);
  const created = await h.tool(id, 'ops_goals_save', {name: 'Ship feature', prompt: 'Implement and verify the feature.', projectId: project.id}, 'goal-add');
  assert.equal(created.ok, true); const goalId = created.data.id;
  assert.equal(h.manager.snapshot().goals[0].status, 'draft', 'Saving a goal never implicitly starts it');
  const scheduleArgs = {goalId, name: 'Review follow-up', prompt: 'Inspect changes.', cron: '0 * * * *', timezone: 'UTC', enabled: false};
  const scheduled = await h.tool(id, 'ops_schedules_save', scheduleArgs, 'schedule-add'); assert.equal(scheduled.ok, true);
  const scheduleId = h.manager.snapshot().goals[0].schedules[0].id;
  await h.tool(id, 'ops_schedules_save', {...scheduleArgs, id: scheduleId, cron: '30 * * * *'}, 'schedule-edit');
  assert.equal(h.manager.snapshot().goals[0].schedules[0].cron, '30 * * * *');
  await h.tool(id, 'ops_goals_action', {goalId, action: 'start'}, 'goal-start'); await h.manager.pumpAll();
  assert.notEqual(h.sessions.get(goalId).threadId, h.sessions.get(id).threadId);
  assert.equal(h.manager.snapshot().goals[0].threadId, h.sessions.get(goalId).threadId);
  await h.tool(id, 'ops_schedules_delete', {goalId, id: scheduleId}, 'schedule-delete');
  assert.equal(h.manager.snapshot().goals[0].schedules.length, 0);
  const conversation = h.manager.snapshot().managementConversations[0].conversation;
  assert.ok(conversation.some(row => row.links?.some(link => link.kind === 'project' && link.id === project.id)));
  assert.ok(conversation.some(row => row.links?.some(link => link.kind === 'goal' && link.id === goalId)));
  assert.equal((await h.tool(id, 'ops_projects_list', {})).data.projects[0].id, project.id);
});

test('persisted management call receipts prevent duplicate mutations and surface real failures', async t => {
  const h = await harness(t), id = await h.create(); await h.request(id);
  const args = {name: 'Only one project', workPath: h.root};
  const first = await h.tool(id, 'ops_projects_create', args, 'same-call');
  const second = await h.tool(id, 'ops_projects_create', args, 'same-call');
  assert.deepEqual(second, first); assert.equal(h.projectStore.snapshot().projects.length, 1); assert.equal(h.changed(), 1);
  await assert.rejects(h.tool(id, 'ops_projects_create', {...args, name: 'Changed'}, 'same-call'), {code: 'OPS_TOOL_REPLAY_MISMATCH'});
  await assert.rejects(h.tool(id, 'ops_projects_create', {...args, action: 'project.delete'}), {code: 'INVALID_OPS_REQUEST'});
  const failure = await h.tool(id, 'ops_projects_create', {name: 'Missing folder', workPath: path.join(h.root, 'missing')}, 'missing-folder');
  assert.equal(failure.ok, false); assert.equal(h.projectStore.snapshot().projects.length, 1);
  const state = h.manager.snapshot().managementConversations[0];
  assert.equal(state.lastError, failure.error.message); assert.ok(state.conversation.some(row => row.role === 'tool' && row.text === failure.error.message));
  assert.equal(state.toolReceipts.find(row => row.callId === 'missing-folder').status, 'failed');
});

test('management goal actions report an actual delivery failure with its related goal link', async t => {
  const h=await harness(t),id=await h.create();await h.request(id);
  const created=await h.tool(id,'ops_goals_save',{name:'Unavailable target',prompt:'Do the requested work.',workPath:h.root});
  h.manager.resolveTarget=async()=>{throw Object.assign(new Error('Actual working target is unavailable'),{code:'OPS_TARGET_UNAVAILABLE'});};
  const result=await h.tool(id,'ops_goals_action',{goalId:created.data.id,action:'start'});
  assert.equal(result.ok,false);assert.equal(result.error.code,'OPS_GOAL_ACTION_UNCONFIRMED');assert.match(result.message,/Actual working target/);
  assert.equal(result.links[0].id,created.data.id);assert.equal(h.manager.snapshot().managementConversations[0].lastError,result.message);
});

test('duplicate pending requests send once and management stop fences old tools while preserving its conversation', async t => {
  let release, entered; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const h = await harness(t, {beforeDeliver: async () => { entered(); await gate; }}), id = await h.create();
  t.after(() => release());
  await h.manager.managementRequest({conversationId: id, instruction: 'One management request'}); await ready;
  await h.manager.managementRequest({conversationId: id, instruction: 'One management request'});
  assert.equal(h.manager.snapshot().managementConversations[0].requests.length, 1); assert.equal(h.calls.filter(row => row.kind === 'start').length, 1);
  release(); await h.manager.management.pump(id);
  const session = h.sessions.get(id), tools = session.options.tools, context = {callId: 'stopped-tool', threadId: session.threadId, turnId: session.turnId};
  await h.manager.managementAction({conversationId: id, action: 'stop'});
  await assert.rejects(tools.find(row => row.name === 'ops_projects_create').execute({name: 'Must not exist', workPath: h.root}, context), {code: 'OPS_MANAGEMENT_STALE'});
  assert.equal(h.projectStore.snapshot().projects.length, 0);
  assert.equal(h.manager.snapshot().managementConversations[0].threadId, session.threadId);
  assert.equal(h.manager.snapshot().managementConversations[0].executionState, 'idle');
});

test('lost management acknowledgements are reconciled on their original thread without duplicate model input or tool replay', async t => {
  const h = await harness(t, {deliver: async () => { throw new Error('Acknowledgement lost'); }}), id = await h.create(); await h.request(id);
  assert.equal(h.manager.snapshot().managementConversations[0].executionState, 'unknown');
  await assert.rejects(h.manager.managementRequest({conversationId: id, instruction: 'Duplicate unsafe retry'}), {code: 'OPS_DELIVERY_UNKNOWN'});
  await h.manager.managementAction({conversationId: id, action: 'reconnect'});
  assert.equal(h.manager.snapshot().managementConversations[0].executionState, 'running');
  assert.equal(h.calls.filter(row => row.kind === 'start').length, 1);
  const session = h.sessions.get(id);
  h.manager.store.update(data => data.managementConversations[0].toolReceipts.push({callId: 'unfinished-call', tool: 'ops_projects_create', digest: 'a'.repeat(64), threadId: session.threadId, turnId: session.turnId, status: 'prepared', createdAt: new Date().toISOString()}));
  await h.manager.close();
  const reopened = new OpsManager(h.options); h.managers.push(reopened); await reopened.init(); await reopened.management.reconnect(id);
  assert.equal(h.calls.filter(row => row.kind === 'start').length, 1);
  assert.equal(reopened.snapshot().managementConversations[0].toolReceipts[0].status, 'unknown');
  assert.equal(h.projectStore.snapshot().projects.length, 0);
});

test('backup compatibility preserves management history/links and blocks callbacks from the replaced incarnation', async t => {
  const h = await harness(t), id = await h.create(); await h.request(id);
  const project = await h.tool(id, 'ops_projects_create', {name: 'Retained result', workPath: h.root});
  await h.complete(id); const data = h.manager.exportData(), old = h.sessions.get(id);
  h.manager.restore(data);
  await old.options.onEvent({type: 'message', role: 'assistant', itemId: 'stale-message', text: 'Must not enter restored data'});
  const state = h.manager.snapshot().managementConversations[0];
  assert.ok(state.conversation.some(row => row.links?.some(link => link.id === project.data.id)));
  assert.equal(state.conversation.some(row => row.id === 'stale-message'), false);
  assert.equal(state.executionState, 'unknown'); assert.equal(state.threadId, data.managementConversations[0].threadId);
  const legacy = structuredClone(data); delete legacy.managementConversations;
  assert.deepEqual(validateOpsData(legacy).managementConversations, []);
  h.manager.setSuspended(true); h.manager.restore(data, {pause: false});
  assert.deepEqual(h.manager.exportData().managementConversations, data.managementConversations, 'Outer application rollback preserves the original management records exactly');
  const invalid = structuredClone(data); invalid.managementConversations[0].threadId = 'foreign-thread'; invalid.goals.push({});
  assert.throws(() => validateOpsData(invalid), {code: 'OPS_STORAGE_UNAVAILABLE'});
});

test('unknown thread allocation cannot be presented as a confirmed management stop', async t => {
  const h = await harness(t), id = await h.create();
  h.manager.store.update(data => { const row=data.managementConversations[0];row.executionState='unknown';row.requests.push({id:randomUUID(),instruction:'Unconfirmed allocation',prompt:'Unconfirmed allocation',status:'unknown',threadId:null,turnId:null}); });
  await assert.rejects(h.manager.managementAction({conversationId:id,action:'stop'}),{code:'OPS_DELIVERY_UNKNOWN'});
  assert.equal(h.manager.snapshot().managementConversations[0].executionState,'unknown');assert.equal(h.manager.hasActiveWork(),true);assert.equal(h.calls.length,0);
});

test('finished goal restart retains configuration, original thread, schedules and history; fixed execution settings apply to existing goals', async t => {
  const h = await harness(t);
  await h.manager.saveGoal({name: 'Restart retained goal', workPath: h.root, prompt: 'Preserve the original work.', model: 'gpt-6.1', reasoningEffort: 'high', sandboxMode: 'read-only', approvalPolicy: 'on-request'});
  const id = h.manager.snapshot().goals[0].id;
  await h.manager.goalAction({goalId: id, action: 'start'}); await h.manager.pumpAll();
  h.manager.saveSchedule({goalId: id, name: 'Preserved schedule', prompt: 'Continue.', cron: '* * * * *', timezone: 'UTC', enabled: true});
  await h.manager.goalAction({goalId: id, action: 'finish'}); const before = h.manager.snapshot().goals[0];
  await h.manager.tick(Date.now() + 3600000); assert.equal(h.calls.filter(row => row.id === id && row.kind === 'start').length, 1);
  await Promise.all([h.manager.goalAction({goalId: id, action: 'start'}), h.manager.goalAction({goalId: id, action: 'start'})]); await h.manager.pumpAll();
  await h.manager.goalAction({goalId: id, action: 'start'}); await h.manager.pumpAll();
  const after = h.manager.snapshot().goals[0]; assert.equal(after.status, 'active'); assert.equal(after.threadId, before.threadId); assert.deepEqual(after.schedules, before.schedules);
  assert.deepEqual(after.history.slice(0, before.history.length), before.history); assert.equal(after.model, 'gpt-6.1'); assert.equal(after.reasoningEffort, 'high');
  assert.equal(after.sandboxMode, 'danger-full-access'); assert.equal(after.approvalPolicy, 'never');
  assert.equal(h.sessions.get(id).options.config.sandboxMode, 'danger-full-access');
  assert.equal(h.calls.filter(row => row.id === id && row.kind === 'start').length, 2);
  await h.complete(id); h.manager.store.update(data => Object.assign(data.goals[0], {sandboxMode: 'workspace-write', approvalPolicy: 'untrusted'}));
  await h.manager.close(); const reopened = new OpsManager(h.options); h.managers.push(reopened); await reopened.init(); await reopened.reconnect(id);
  assert.equal(reopened.snapshot().goals[0].sandboxMode, 'danger-full-access'); assert.equal(reopened.snapshot().goals[0].approvalPolicy, 'never');
  assert.equal(h.sessions.get(id).options.config.sandboxMode, 'danger-full-access'); assert.equal(h.sessions.get(id).options.config.approvalPolicy, 'never');
});

test('actual project adapter retains original write admission across async directory preparation', async t => {
  let release, entered; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const h = await harness(t, {adapterOptions: {requireDirectory: async value => { entered(); await gate; return value; }}});
  t.after(() => release());
  const guard = h.adapter.capture(), pending = h.adapter.createProject({name: 'Stale project', workPath: h.root}, guard); await ready;
  const backup = h.projectStore.exportData(); h.projectStore.importData(backup); release();
  await assert.rejects(pending, {code: 'STALE_EPOCH'}); assert.equal(h.projectStore.snapshot().projects.length, 0); assert.equal(h.changed(), 0);
});

test('a global runtime change retires only a proven-idle management adapter and resumes its original thread', async t => {
  let runtime={command:'/original/codex',available:true};const h=await harness(t,{managerOptions:{runtime:()=>runtime}}),id=await h.create();await h.request(id);const old=h.sessions.get(id),threadId=old.threadId;await h.complete(id);
  runtime={command:'/replacement/codex',available:true};h.manager.runtimeChanged();await h.manager.management.pump(id);
  assert.equal(h.calls.filter(row=>row.kind==='close').length,1);assert.equal(h.manager.snapshot().managementConversations[0].threadId,threadId);assert.equal(h.manager.snapshot().managementConversations[0].requests.length,1);
  await h.request(id,'Resume after the selected runtime changed.');const current=h.sessions.get(id);assert.notEqual(current,old);assert.equal(current.options.threadId,threadId);assert.equal(current.threadId,threadId);assert.equal(current.runtime.command,'/replacement/codex');
  await old.options.onEvent({type:'error',message:'Late old adapter close error'});await old.options.onEvent({type:'message',itemId:'late-old',role:'assistant',text:'Stale original connection'});
  const row=h.manager.snapshot().managementConversations[0];assert.equal(row.executionState,'running');assert.equal(row.lastError,null);assert.equal(row.conversation.some(message=>message.id==='late-old'),false);
});

test('global runtime retirement preserves an active or background management owner until explicit idle proof', async t => {
  let runtime={command:'/original/codex',available:true};const h=await harness(t,{managerOptions:{runtime:()=>runtime}}),id=await h.create();await h.request(id);const old=h.sessions.get(id);
  runtime={command:'/replacement/codex',available:true};h.manager.runtimeChanged();await h.manager.management.pump(id);await h.request(id,'Steer the already active original turn.');assert.equal(h.sessions.get(id),old);assert.equal(old.runtime.command,'/original/codex');assert.equal(h.calls.filter(row=>row.kind==='close').length,0);
  await old.options.onEvent({type:'turn.completed',threadId:old.threadId,turnId:old.turnId,status:'completed',backgroundState:'active',backgroundCount:1});await h.manager.management.pump(id);assert.equal(h.sessions.get(id),old);assert.equal(h.calls.filter(row=>row.kind==='close').length,0);assert.equal(h.manager.hasActiveWork(),true);
  await h.manager.managementAction({conversationId:id,action:'stop'});await h.manager.management.pump(id);assert.equal(h.calls.filter(row=>row.kind==='interrupt').length,1);assert.equal(h.calls.filter(row=>row.kind==='close').length,1);
  await h.request(id,'Start new work only after confirmed original cleanup.');assert.notEqual(h.sessions.get(id),old);assert.equal(h.sessions.get(id).threadId,old.threadId);assert.equal(h.sessions.get(id).runtime.command,'/replacement/codex');
  const unknown=h.sessions.get(id);await unknown.options.onEvent({type:'error',message:'Original turn acknowledgement is uncertain'});runtime={command:'/third/codex',available:true};h.manager.runtimeChanged();await h.manager.management.pump(id);assert.equal(h.manager.snapshot().managementConversations[0].executionState,'unknown');assert.equal(h.sessions.get(id),unknown);assert.equal(h.calls.filter(row=>row.kind==='close').length,1,'An unknown owner is not retired on another runtime change');
});

test('pending or failed management adapter close fences delivery until original cleanup is explicitly recovered', async t => {
  let runtime={command:'/original/codex',available:true},release,entered,first=true;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const h=await harness(t,{managerOptions:{runtime:()=>runtime},close:async()=>{if(first){first=false;entered();await gate;throw new Error('Original adapter close failed');}}}),id=await h.create();t.after(()=>release());await h.request(id);await h.complete(id);
  runtime={command:'/replacement/codex',available:true};h.manager.runtimeChanged();await ready;await h.manager.managementRequest({conversationId:id,instruction:'Known unsent request during original close.'});assert.equal(h.calls.filter(row=>row.kind==='start').length,1);assert.equal(h.manager.hasActiveWork(),true);
  release();await h.manager.management.pump(id);let row=h.manager.snapshot().managementConversations[0];assert.equal(row.executionState,'unknown');assert.equal(row.requests.at(-1).status,'queued');assert.equal(h.manager.hasActiveWork(),true);assert.equal(h.manager.management.retirementFailures.has(id),true);
  await assert.rejects(h.manager.managementRequest({conversationId:id,instruction:'Must not skip failed cleanup'}),{code:'OPS_DELIVERY_UNKNOWN'});assert.equal(h.calls.filter(row=>row.kind==='start').length,1);
  await h.manager.managementAction({conversationId:id,action:'reconnect'});await h.manager.management.pump(id);row=h.manager.snapshot().managementConversations[0];assert.equal(h.manager.management.retirementFailures.has(id),false);assert.equal(row.executionState,'running');assert.equal(h.calls.filter(call=>call.kind==='start'&&call.deliveryId===row.requests.at(-1).id).length,1);assert.equal(h.sessions.get(id).runtime.command,'/replacement/codex');assert.equal(h.calls.filter(call=>call.kind==='close').length,2);
});

test('management requests freeze model settings and queue a changed model until the original turn completes', async t => {
  const h = await harness(t), id = await h.create({model:'model-a',reasoningEffort:'low'});
  await h.request(id,'First request');
  const original = h.sessions.get(id), first = h.manager.snapshot().managementConversations[0].requests[0];
  await h.manager.managementRequest({conversationId:id,instruction:'Next request',model:'model-b',reasoningEffort:'high'});
  await h.manager.management.pump(id);
  let row = h.manager.snapshot().managementConversations[0];
  assert.equal(h.calls.filter(x=>['start','steer'].includes(x.kind)).length,1,'Changed settings must not steer the active turn with the old model');
  assert.equal(row.requests[1].status,'queued');
  assert.deepEqual(row.requests[0],first,'Later preferences do not rewrite an already delivered request');
  assert.deepEqual(row.requests[1].executionSettings.sent,{model:'model-b',reasoningEffort:'high'});
  assert.deepEqual(original.options.config,{model:'model-a',reasoningEffort:'low',sandboxMode:'danger-full-access',approvalPolicy:'never'});
  const thread = original.threadId;
  await h.complete(id); await h.manager.management.pump(id);
  const next = h.sessions.get(id); row = h.manager.snapshot().managementConversations[0];
  assert.notEqual(next,original); assert.equal(next.options.threadId,thread);
  assert.deepEqual(next.options.config,{model:'model-b',reasoningEffort:'high',sandboxMode:'danger-full-access',approvalPolicy:'never'});
  assert.equal(h.calls.filter(x=>x.kind==='close'&&x.id===id).length,1);
  assert.equal(h.calls.filter(x=>x.kind==='start'&&x.id===id).length,2);
  assert.equal(row.requests[1].status,'accepted');
  assert.deepEqual(row.conversation.filter(x=>x.role==='user').map(x=>x.executionSettings.sent),[{model:'model-a',reasoningEffort:'low'},{model:'model-b',reasoningEffort:'high'}]);
  assert.deepEqual(new OpsStore({dataPath:h.dataPath}).read().managementConversations[0].requests,row.requests);
});

test('management rejects invalid model settings before storing or submitting the request', async t => {
  const h=await harness(t),id=await h.create();
  for(const settings of [{model:'invalid model',reasoningEffort:'high'},{model:'valid',reasoningEffort:'invented'}])await assert.rejects(h.manager.managementRequest({conversationId:id,instruction:'Do not deliver',...settings}));
  assert.equal(h.manager.snapshot().managementConversations[0].requests.length,0);
  assert.equal(h.calls.length,0);
});

test('new conversations retain the caller identity despite another window creating a conversation first',async t=>{
 const h=await harness(t),own=randomUUID(),other=randomUUID();
 await h.manager.managementCreate({id:other,name:'Other window'});
 const result=await h.manager.managementCreate({id:own,name:'This window'});
 assert.equal(result.managementConversations.find(row=>row.id===own).name,'This window');
 assert.equal(result.managementConversations.find(row=>row.id===other).name,'Other window');
 await assert.rejects(h.manager.managementCreate({id:own}),{code:'OPS_CONVERSATION_EXISTS'});
 await assert.rejects(h.manager.managementCreate({id:'not-a-uuid'}),{code:'INVALID_OPS_REQUEST'});
 assert.equal(h.manager.snapshot().managementConversations.length,2);assert.equal(h.calls.length,0);
});

test('simultaneous matching requests share one durable admission after asynchronous skill capture',async t=>{
 const h=await harness(t),id=await h.create(),input={conversationId:id,instruction:'One simultaneous request',model:'model-a',reasoningEffort:'low'};
 await Promise.all([h.manager.managementRequest(input),h.manager.managementRequest({...input})]);
 await h.manager.management.pump(id);
 const row=h.manager.snapshot().managementConversations[0];
 assert.equal(row.requests.length,1);assert.equal(row.conversation.filter(x=>x.role==='user').length,1);
 assert.equal(h.calls.filter(x=>['start','steer'].includes(x.kind)).length,1);
 await h.manager.managementRequest({...input,model:'model-b'});await h.manager.management.pump(id);
 assert.equal(h.manager.snapshot().managementConversations[0].requests.length,2,'A distinct selected model is a distinct frozen request');
});

test('changing a model preserves the known conversation configuration of unfinished legacy requests',async t=>{
 const h=await harness(t),id=await h.create({model:'legacy-model',reasoningEffort:'low'});await h.request(id,'Legacy active request');
 h.manager.store.update(data=>{delete data.managementConversations[0].requests[0].executionSettings;});
 await h.manager.managementRequest({conversationId:id,instruction:'Future request',model:'new-model',reasoningEffort:'high'});await h.manager.management.pump(id);
 const row=h.manager.snapshot().managementConversations[0];
 assert.deepEqual(row.requests[0].executionSettings.sent,{model:'legacy-model',reasoningEffort:'low'});
 assert.equal(row.requests[0].executionSettingsOrigin,'legacy-conversation-config');
 assert.deepEqual(row.requests[1].executionSettings.sent,{model:'new-model',reasoningEffort:'high'});
 assert.equal(row.requests[1].status,'queued');assert.equal(h.calls.filter(x=>x.kind==='steer').length,0);
 assert.deepEqual(new OpsStore({dataPath:h.dataPath}).read().managementConversations[0].requests,row.requests);
});
