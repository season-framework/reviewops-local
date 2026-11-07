'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {executionSettings} = require('./agent-execution-settings.cjs');
const {opsDeliveryPrompt} = require('./ops-session.cjs');
const EXECUTION = Object.freeze({sandboxMode: 'danger-full-access', approvalPolicy: 'never'});
const IN_FLIGHT = new Set(['prepared', 'accepted', 'unknown']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
function fail(code, message) { throw Object.assign(new Error(message), {code}); }
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.keys(input).some(key => !allowed.includes(key))) fail('INVALID_OPS_REQUEST', 'Ops 관리 요청 항목을 확인하십시오.');
  return input;
}
function text(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') || required && !value.trim()) fail('INVALID_OPS_REQUEST', 'Ops 관리 요청 내용을 확인하십시오.');
  return value;
}
function canonical(value) { return Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value); }
function schema(properties, required = []) { return {type: 'object', properties, required, additionalProperties: false}; }
const string = maxLength => ({type: 'string', maxLength});
const goalLink = goal => ({kind: 'goal', id: goal.id, name: goal.name});
const projectLink = project => ({kind: 'project', id: project.id, name: project.name});
const goalSummary = goal => ({...Object.fromEntries(['id', 'name', 'projectId', 'workPath', 'model', 'reasoningEffort', 'status', 'executionState', 'lastError'].map(key => [key, goal[key]])), prompt: goal.prompt.slice(0, 2000), promptTruncated: goal.prompt.length > 2000, scheduleCount: goal.schedules.length, schedules: goal.schedules.slice(0, 20).map(({id, name, cron, timezone, enabled}) => ({id, name, cron, timezone, enabled}))});

// The app owns these callbacks. No renderer-supplied action or generic dispatch
// enters this adapter, and an original dataset admission survives async lookup.
function createProjectAdapter({getStore, assertReady = () => {}, enqueue = callback => callback(), onChange = () => {}, requireDirectory = require('./work-directory.cjs').requireDirectory}) {
  return {
    capture() {
      assertReady();
      const store = getStore(), admission = store.captureWriteAdmission();
      return () => { assertReady(); if (getStore() !== store) fail('OPS_MANAGEMENT_STALE', '원래 프로젝트 자료가 변경되었습니다. 새 요청으로 다시 확인하십시오.'); store.assertWriteAdmission(admission); };
    },
    listProjects(guard) {
      guard();
      const data = getStore().snapshot();
      return {groups: data.groups.map(({id, name}) => ({id, name})), projects: data.projects.map(project => ({id: project.id, name: project.name, groupId: project.groupId, description: project.description, workPath: project.connection?.agentWorkPath || project.connection?.rootPath || '', targetKind: project.connection?.kind || null}))};
    },
    async createProject(input, guard) {
      fields(input, ['name', 'groupId', 'groupName', 'description', 'workPath']);
      text(input.name, 120, true); text(input.workPath, 4096, true);
      if (input.groupId !== undefined) text(input.groupId, 128, true);
      if (input.groupName !== undefined) text(input.groupName, 120, true);
      if (input.description !== undefined) text(input.description, 10000);
      if (input.groupId && input.groupName) fail('INVALID_OPS_REQUEST', '기존 그룹 또는 새 그룹 이름 중 하나를 지정하십시오.');
      guard();
      const store = getStore(), workPath = await requireDirectory(input.workPath);
      guard();
      const result = await enqueue(() => store.transaction(() => {
        guard();
        const groups = store.snapshot().groups;
        const group = input.groupId ? groups.find(row => row.id === input.groupId) : groups.find(row => row.name === (input.groupName || 'Ops')) || store.saveGroup({name: input.groupName || 'Ops'});
        if (!group) fail('OPS_PROJECT_NOT_FOUND', '지정한 프로젝트 그룹을 찾을 수 없습니다.');
        return store.saveProject({name: input.name, groupId: group.id, description: input.description || '', connection: {kind: 'local', rootPath: workPath, agentWorkPath: workPath}});
      }));
      guard(); onChange(); return result;
    }
  };
}

class OpsManagement {
  constructor(manager, adapter) {
    this.manager = manager; this.adapter = adapter; this.sessions = new Map(); this.pumps = new Map(); this.actions = new Map(); this.reconciling = new Map(); this.messages = new Map(); this.scopes = new Map(); this.generation = Object.freeze({});
  }
  get data() { return this.manager.store.data.managementConversations || []; }
  _conversation(id, data = this.manager.store.data) { const value = (data.managementConversations || []).find(row => row.id === id); if (!value) fail('OPS_CONVERSATION_NOT_FOUND', '관리 대화를 찾을 수 없습니다.'); return value; }
  _change(id, update) { return this.manager._mutate(data => update(this._conversation(id, data))); }
  _ready() { this.manager._open(); if (this.manager.closing || this.manager.suspended) fail('OPS_MANAGEMENT_UNAVAILABLE', '앱 자료 변경이 끝난 뒤 관리 대화를 재개하십시오.'); }
  _guard(id, context, generation = this.generation) {
    this._ready();
    const row = this._conversation(id), scope = this.scopes.get(id);
    if (generation !== this.generation || !scope || row.threadId !== context.threadId || row.turnId !== context.turnId || row.executionState !== 'running' || this.actions.has(id)) fail('OPS_MANAGEMENT_STALE', '원래 관리 대화의 실행이 변경되었습니다.');
    scope();
  }
  snapshot() {
    return this.data.map(row => ({...structuredClone(row), conversation: [...row.conversation.filter(item => !this.messages.has(row.id + ':' + item.id)), ...[...this.messages].filter(([key]) => key.startsWith(row.id + ':')).map(([, item]) => item)]}));
  }
  async create(input = {}, guard = () => {}) {
    this._ready(); fields(input, ['name', 'model', 'reasoningEffort']);
    const name = text(input.name ?? '새 관리 대화', 200, true), model = text(input.model ?? '', 256), reasoningEffort = input.reasoningEffort ?? '';
    executionSettings(undefined, {model, reasoningEffort});
    guard();
    return this.manager._mutate(data => {
      data.managementConversations ??= [];
      if (data.managementConversations.length >= 100) fail('OPS_LIMIT', '관리 대화는 100개까지 등록할 수 있습니다.');
      const timestamp = this.manager._time();
      data.managementConversations.push({id: randomUUID(), name, model, reasoningEffort, threadId: null, turnId: null, executionState: 'idle', modelState: 'idle', backgroundState: 'empty', backgroundCount: 0, lastError: null, createdAt: timestamp, updatedAt: timestamp, conversation: [], requests: [], toolReceipts: []});
    });
  }
  async request(input, guard = () => {}) {
    this._ready(); fields(input, ['conversationId', 'instruction']); text(input.instruction, 100000, true);
    const row = this._conversation(input.conversationId);
    if (this.actions.has(row.id) || this.reconciling.has(row.id)) fail('OPS_MANAGEMENT_BUSY', '관리 대화 상태 확인이 끝난 뒤 요청하십시오.');
    if (row.executionState === 'unknown') fail('OPS_DELIVERY_UNKNOWN', '원래 관리 대화의 전달 결과를 먼저 다시 연결하여 확인하십시오.');
    // Repeated UI submissions during a pending acknowledgement share admission.
    if (row.requests.some(request => ['queued', ...IN_FLIGHT].includes(request.status) && request.instruction === input.instruction)) return this.manager.snapshot();
    const deliveryId = randomUUID();
    const prompt = opsDeliveryPrompt({deliveryId, prompt: 'You manage ReviewOps through the provided typed management tools. Use those tools for project, goal and schedule changes; never edit app storage files or claim a change without its tool result. List existing records before selecting their IDs. Do not start a goal or enable a schedule unless the user asks. Goal runs keep their own conversation; this is a separate management conversation. Report actual failures and unresolved delivery honestly.\n\nUser instruction:\n' + input.instruction});
    guard();
    const scope = this.adapter?.capture ? this.adapter.capture() : () => {};
    this.scopes.set(row.id, scope);
    this._change(row.id, current => {
      if (current.requests.length >= 10000) fail('OPS_LIMIT', '관리 대화의 요청 기록이 한도에 도달했습니다. 새 대화를 만드십시오.');
      current.requests.push({id: deliveryId, instruction: input.instruction, prompt, status: 'queued', threadId: current.threadId, turnId: null, createdAt: this.manager._time()});
      if (current.requests.length === 1 && current.name === '새 관리 대화') current.name = input.instruction.trim().split('\n')[0].slice(0, 60);
      current.conversation.push({id: deliveryId, role: 'user', text: input.instruction, createdAt: this.manager._time()}); current.lastError = null; current.updatedAt = this.manager._time();
    });
    void this.pump(row.id); return this.manager.snapshot();
  }
  _session(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const row = this._conversation(id), generation = this.generation, workPath = path.join(this.manager.dataPath, 'ops', 'management', id);
    fs.mkdirSync(workPath, {recursive: true, mode: 0o700}); this.manager.store.check(workPath, true);
    const session = (this.manager.createSession || require('./ops-session.cjs').createOpsSession)({goalId: id, workPath, target: {kind: 'local', identityKey: 'local'}, threadId: row.threadId, config: {model: row.model, reasoningEffort: row.reasoningEffort, ...EXECUTION}, runtime: this.manager.runtime, resolveRuntime: typeof this.manager.runtime === 'function' ? this.manager.runtime : undefined, onEvent: event => generation === this.generation ? this._event(id, event) : undefined, tools: this.tools(id)});
    this.sessions.set(id, session); return session;
  }
  _event(id, event) {
    if (this.manager.closed || !this.data.some(row => row.id === id)) return;
    if (event.type === 'message') {
      if (event.role === 'user') return; // The raw user request is already stored.
      const key = id + ':' + event.itemId, previous = this.messages.get(key) || this._conversation(id).conversation.find(item => item.id === event.itemId);
      const item = {id: event.itemId, role: event.role || 'assistant', text: String(event.text || '').slice(0, 4 * 1024 * 1024), createdAt: previous?.createdAt || this.manager._time(), partial: Boolean(event.partial)};
      if (event.partial) { this.messages.set(key, item); this.manager._notify(); }
      else { this.messages.delete(key); this._change(id, row => { row.conversation = row.conversation.filter(message => message.id !== item.id); row.conversation.push(item); row.updatedAt = this.manager._time(); }); }
      return;
    }
    if (event.type === 'thread') this._change(id, row => { row.threadId = event.threadId; });
    else if (event.type === 'turn.started') this._change(id, row => { row.threadId = event.threadId; row.turnId = event.turnId; row.executionState = 'running'; row.modelState = 'running'; row.lastError = null; });
    else if (event.type === 'turn.completed') this._change(id, row => {
      if (row.turnId && row.turnId !== event.turnId) return;
      row.turnId = null; row.modelState = 'idle'; row.backgroundState = event.backgroundState || 'unknown'; row.backgroundCount = event.backgroundCount ?? null;
      row.executionState = event.status === 'failed' ? 'error' : row.backgroundState === 'empty' ? 'idle' : 'unknown';
      row.lastError = event.status === 'failed' ? 'Codex 관리 요청이 실패했습니다. 대화 기록을 확인하십시오.' : row.executionState === 'unknown' ? '관리 대화의 백그라운드 작업 종료를 확인하지 못했습니다.' : null;
      for (const request of row.requests) if (IN_FLIGHT.has(request.status) && (!request.turnId || request.turnId === event.turnId)) { request.status = event.status === 'failed' ? 'failed' : event.status === 'interrupted' ? 'interrupted' : 'completed'; request.turnId = event.turnId; request.completedAt = this.manager._time(); }
      row.updatedAt = this.manager._time();
    });
    else if (event.type === 'error') this._error(id, Object.assign(new Error(event.message || '관리 대화 실행 상태를 확인하지 못했습니다.'), {code: event.code}));
    if (event.type === 'turn.completed') void this.pump(id);
  }
  _error(id, error, requestId) {
    if (this.manager.closed) return;
    this._change(id, row => {
      const request = row.requests.find(value => value.id === requestId) || [...row.requests].reverse().find(value => IN_FLIGHT.has(value.status));
      const uncertain = request && request.status !== 'queued' && error.deliveryState !== 'not_sent';
      if (request) { request.status = uncertain ? 'unknown' : 'failed'; request.error = String(error.message || error).slice(0, 2000); }
      row.executionState = uncertain || row.turnId || row.backgroundState === 'active' ? 'unknown' : 'error'; row.lastError = String(error.message || error).slice(0, 2000); row.updatedAt = this.manager._time();
      row.conversation.push({id: randomUUID(), role: 'system', text: row.lastError, createdAt: this.manager._time()});
    });
  }
  pump(id) {
    if (this.pumps.has(id)) return this.pumps.get(id);
    const task = this._pump(id).catch(error => this._error(id, error)).finally(() => this.pumps.delete(id));
    this.pumps.set(id, task); return task;
  }
  async _pump(id) {
    const generation = this.generation;
    while (!this.manager.closed && !this.manager.closing && !this.manager.suspended && !this.actions.has(id) && !this.reconciling.has(id)) {
      const row = this._conversation(id), request = row.requests.find(value => value.status === 'queued');
      if (!request || row.executionState === 'unknown') return;
      this.scopes.get(id)?.();
      const session = this._session(id), mode = row.turnId && row.executionState === 'running' ? 'steer' : 'start';
      this._change(id, current => { const saved = current.requests.find(value => value.id === request.id); saved.status = 'prepared'; saved.preparedAt = this.manager._time(); current.executionState = mode === 'steer' ? 'running' : 'starting'; });
      let result;
      try { result = await session[mode]({deliveryId: request.id, prompt: request.prompt, threadId: row.threadId, turnId: row.turnId}); }
      catch (error) { this._error(id, error, request.id); return; }
      if (this.manager.closed || generation !== this.generation) return;
      this._change(id, current => {
        const saved = current.requests.find(value => value.id === request.id); saved.threadId = result.threadId || current.threadId; saved.turnId = result.deliveryTurnId || result.turnId || saved.turnId; current.threadId = saved.threadId;
        if (result.delivery !== 'accepted') { saved.status = 'unknown'; current.executionState = 'unknown'; current.lastError = '관리 지시의 전달 결과를 확인하지 못했습니다. 원래 대화를 다시 연결하십시오.'; return; }
        // A completed notification may precede the acknowledgement.
        if (TERMINAL.has(saved.status)) return;
        const outcome = result.outcome || result.turnStatus;
        saved.status = TERMINAL.has(outcome) ? outcome : 'accepted';
        current.turnId = TERMINAL.has(outcome) ? null : result.activeTurnId || result.turnId || current.turnId;
        current.modelState = current.turnId ? 'running' : result.state;
        current.backgroundState = result.backgroundState || current.backgroundState; current.backgroundCount = result.backgroundCount ?? current.backgroundCount;
        current.executionState = outcome === 'failed' ? 'error' : current.turnId ? 'running' : result.state === 'idle' && current.backgroundState === 'empty' ? 'idle' : 'unknown';
        current.lastError = outcome === 'failed' ? 'Codex 관리 요청이 실패했습니다.' : null;
      });
    }
  }
  async action(input, guard = () => {}) {
    this._ready(); fields(input, ['conversationId', 'action']);
    if (!['stop', 'reconnect'].includes(input.action)) fail('INVALID_OPS_REQUEST', '관리 대화 작업을 확인하십시오.');
    const id = this._conversation(input.conversationId).id;
    if (this.actions.has(id)) { await this.actions.get(id); return this.manager.snapshot(); }
    guard();
    const task = (async () => {
      const pending = this.pumps.get(id); if (pending) await pending;
      guard();
      if (input.action === 'reconnect') { this.scopes.set(id, this.adapter?.capture ? this.adapter.capture() : () => {}); await this.reconnect(id); }
      else {
        const before = this._conversation(id);
        if (!before.threadId && before.requests.some(request => IN_FLIGHT.has(request.status))) fail('OPS_DELIVERY_UNKNOWN', '원래 관리 대화의 식별자와 중지 결과를 확인하지 못했습니다. 요청을 반복하지 않았습니다.');
        this._change(id, row => { for (const request of row.requests) if (request.status === 'queued') request.status = 'cancelled'; row.executionState = row.threadId ? 'unknown' : 'idle'; });
        const row = this._conversation(id);
        if (row.threadId) {
          const result = await this._session(id).interrupt({threadId: row.threadId, turnId: row.turnId});
          guard();
          if (!result?.confirmed || result.state !== 'idle') fail('OPS_INTERRUPT_UNCONFIRMED', '관리 대화와 백그라운드 작업의 중지를 확인하지 못했습니다.');
          this._change(id, current => { current.turnId = null; current.executionState = 'idle'; current.modelState = 'idle'; current.backgroundState = 'empty'; current.backgroundCount = 0; current.lastError = null; for (const request of current.requests) if (IN_FLIGHT.has(request.status)) request.status = 'interrupted'; });
        }
      }
    })().catch(error => { this._error(id, error); throw error; }).finally(() => this.actions.delete(id));
    this.actions.set(id, task); await task; return this.manager.snapshot();
  }
  async reconnect(id) {
    if (this.reconciling.has(id)) return this.reconciling.get(id);
    const generation = this.generation, task = (async () => {
      const row = this._conversation(id), request = [...row.requests].reverse().find(value => IN_FLIGHT.has(value.status)) || [...row.requests].reverse().find(value => value.threadId);
      if (!row.threadId) { if (request) fail('OPS_DELIVERY_UNKNOWN', '원래 관리 대화의 식별자를 확인하지 못했습니다. 요청을 자동으로 반복하지 않았습니다.'); return; }
      const result = await this._session(id).reconcile({threadId: row.threadId, turnId: row.turnId, deliveryId: request?.id, prompt: request?.prompt});
      if (generation !== this.generation || this.manager.closed) return;
      this._change(id, current => {
        current.threadId = result.threadId || current.threadId; current.turnId = result.state === 'running' ? result.activeTurnId || result.turnId : null;
        current.modelState = result.state; current.backgroundState = result.backgroundState || 'unknown'; current.backgroundCount = result.backgroundCount ?? null;
        current.executionState = result.state === 'running' ? 'running' : result.state === 'idle' && current.backgroundState === 'empty' ? 'idle' : 'unknown';
        const saved = request && current.requests.find(value => value.id === request.id);
        if (saved && IN_FLIGHT.has(saved.status)) {
          const outcome = result.outcome || result.turnStatus;
          if (result.delivery === 'accepted') { saved.status = TERMINAL.has(outcome) ? outcome : result.state === 'running' ? 'accepted' : 'unknown'; saved.turnId = result.deliveryTurnId || result.turnId || saved.turnId; }
          else if (result.delivery === 'not_found' && result.state === 'idle' && result.safeToRetry === true) { saved.status = 'failed'; saved.error = '원래 지시가 전달되지 않았음을 확인했습니다. 필요하면 새 요청을 보내십시오.'; }
          else saved.status = 'unknown';
          if (saved.status === 'unknown') current.executionState = 'unknown';
        }
        current.lastError = current.executionState === 'unknown' ? '원래 관리 지시 또는 백그라운드 작업의 결과를 아직 확인하지 못했습니다.' : null;
      });
    })().finally(() => this.reconciling.delete(id));
    this.reconciling.set(id, task); return task;
  }
  tools(id) {
    const properties = {id: string(128), name: string(200), projectId: string(128), serviceId: {type: ['string', 'null'], maxLength: 128}, workPath: string(4096), prompt: string(100000), model: string(256), reasoningEffort: {type: 'string', enum: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']}};
    const define = (name, description, inputSchema, execute) => ({name, description, inputSchema, execute: (args, context) => this._tool(id, name, args, context, () => execute(args, () => this._guard(id, context)))});
    return [
      define('ops_projects_list', 'List existing project IDs, groups and working folders before selecting a project.', schema({}), async (_args, guard) => { if (!this.adapter?.listProjects) fail('OPS_MANAGEMENT_UNAVAILABLE', '프로젝트 관리를 사용할 수 없습니다.'); return {data: await this.adapter.listProjects(guard), message: '프로젝트 목록을 확인했습니다.', links: []}; }),
      define('ops_projects_create', 'Create a real local project with a working directory. Use an existing groupId or an optional new groupName. Never invent a directory.', schema({name: string(120), groupId: string(128), groupName: string(120), description: string(10000), workPath: string(4096)}, ['name', 'workPath']), async (args, guard) => { if (!this.adapter?.createProject) fail('OPS_MANAGEMENT_UNAVAILABLE', '프로젝트 추가 기능을 사용할 수 없습니다.'); const project = await this.adapter.createProject(args, guard); return {data: {id: project.id, name: project.name, groupId: project.groupId}, message: '프로젝트를 추가했습니다: ' + project.name, links: [projectLink(project)]}; }),
      define('ops_goals_list', 'List real goals, execution state, prompts and schedules. This does not start a goal.', schema({}), async () => ({data: {goals: this.manager.store.read().goals.map(goalSummary)}, message: '목표 목록을 확인했습니다.', links: []})),
      define('ops_goals_save', 'Create or update a goal using its ID. A new goal requires name, prompt and a projectId or absolute workPath. Existing configuration and history are preserved. Saving does not start it.', schema(properties), async (args, guard) => { fields(args, Object.keys(properties)); const before = new Set(this.manager.store.data.goals.map(goal => goal.id)); await this.manager.saveGoal(args, guard); const goal = args.id ? this.manager._goal(this.manager.store.data, args.id) : this.manager.store.data.goals.find(goal => !before.has(goal.id)); return {data: goalSummary(goal), message: '목표를 저장했습니다: ' + goal.name, links: [goalLink(goal)]}; }),
      define('ops_schedules_save', 'Create or edit a goal schedule using goalId and optional schedule id. Explicit enabled is required. A finished goal is never automatically restarted.', schema({goalId: string(128), id: string(128), name: string(200), prompt: string(100000), cron: string(100), timezone: string(100), enabled: {type: 'boolean'}}, ['goalId', 'name', 'prompt', 'cron', 'timezone', 'enabled']), async (args, guard) => { fields(args, ['goalId', 'id', 'name', 'prompt', 'cron', 'timezone', 'enabled']); guard(); this.manager.saveSchedule(args); const goal = this.manager._goal(this.manager.store.data, args.goalId); return {data: {goalId: goal.id, schedules: goal.schedules}, message: '예약을 저장했습니다: ' + args.name, links: [goalLink(goal)]}; }),
      define('ops_schedules_delete', 'Delete one existing goal schedule by its original goalId and schedule id.', schema({goalId: string(128), id: string(128)}, ['goalId', 'id']), async (args, guard) => { fields(args, ['goalId', 'id']); guard(); this.manager.deleteSchedule(args); const goal = this.manager._goal(this.manager.store.data, args.goalId); return {data: {goalId: goal.id, schedules: goal.schedules}, message: '예약을 삭제했습니다.', links: [goalLink(goal)]}; }),
      define('ops_goals_action', 'Explicitly start/restart, resume, pause, finish, reconnect or send a request to a goal in that goal\'s original conversation. Start only when requested by the user.', schema({goalId: string(128), action: {type: 'string', enum: ['start', 'resume', 'pause', 'finish', 'request', 'reconnect']}, instruction: string(100000)}, ['goalId', 'action']), async (args, guard) => {
        fields(args, ['goalId', 'action', 'instruction']); await this.manager.goalAction(args, guard);
        if (['start', 'resume', 'request'].includes(args.action)) await this.manager.pump(args.goalId);
        guard(); const goal = this.manager._goal(this.manager.store.data, args.goalId), unresolved = ['error', 'unknown'].includes(goal.executionState);
        return {ok: !unresolved, data: goalSummary(goal), ...(unresolved ? {error: {code: 'OPS_GOAL_ACTION_UNCONFIRMED', message: goal.lastError || '목표 실행 결과를 확인하지 못했습니다.'}} : {}), message: unresolved ? goal.lastError || '목표 실행 결과를 확인하지 못했습니다.' : '목표 작업을 적용했습니다: ' + goal.name + ' (' + goal.status + ')', links: [goalLink(goal)]};
      })
    ];
  }
  async _tool(id, name, args, context, execute) {
    const definition = this.toolsSchema(name); fields(args, Object.keys(definition.properties));
    const generation = this.generation; this._guard(id, context, generation);
    if (!context.callId || context.callId.length > 512) fail('INVALID_OPS_TOOL', '원래 관리 도구 호출 식별자가 필요합니다.');
    const digest = createHash('sha256').update(canonical({name, args})).digest('hex'), prior = this._conversation(id).toolReceipts.find(row => row.callId === context.callId);
    if (prior) {
      if (prior.digest !== digest || prior.tool !== name || prior.threadId !== context.threadId || prior.turnId !== context.turnId) fail('OPS_TOOL_REPLAY_MISMATCH', '같은 관리 도구 호출의 내용이 변경되었습니다.');
      if (prior.status === 'completed' || prior.status === 'failed') return structuredClone(prior.result);
      fail('OPS_TOOL_OPERATION_UNKNOWN', '이 관리 도구 호출은 이미 시작되었으며 결과를 확인하지 못했습니다. 다시 실행하지 않았습니다.');
    }
    this._change(id, row => { if (row.toolReceipts.length >= 10000) fail('OPS_LIMIT', '관리 도구 기록이 한도에 도달했습니다.'); row.toolReceipts.push({callId: context.callId, tool: name, digest, threadId: context.threadId, turnId: context.turnId, status: 'prepared', createdAt: this.manager._time()}); });
    let result;
    try { result = {ok: true, ...await execute()}; this._guard(id, context, generation); }
    catch (error) {
      result = {ok: false, error: {code: String(error.code || 'OPS_MANAGEMENT_FAILED').slice(0, 128), message: String(error.message || error).slice(0, 2000)}, message: String(error.message || error).slice(0, 2000), links: []};
      // Keep a prepared receipt uncertain when its original scope disappeared.
      if (generation !== this.generation || this.manager.closed) return result;
      if (error.code === 'OPS_MANAGEMENT_STALE' || error.code === 'STALE_EPOCH') {
        this._change(id, row => { row.toolReceipts.find(value => value.callId === context.callId).status = 'unknown'; row.lastError = '원래 관리 도구 호출 중 대상이나 실행이 변경되어 결과를 재확인해야 합니다.'; row.conversation.push({id: randomUUID(), role: 'system', text: row.lastError, createdAt: this.manager._time()}); });
        return {...result, uncertain: true};
      }
    }
    this._change(id, row => {
      const receipt = row.toolReceipts.find(value => value.callId === context.callId); receipt.status = result.ok ? 'completed' : 'failed'; receipt.result = result; receipt.completedAt = this.manager._time();
      row.lastError = result.ok ? null : result.error.message;
      if (name !== 'ops_projects_list' && name !== 'ops_goals_list' || !result.ok) row.conversation.push({id: randomUUID(), role: 'tool', text: result.message, links: result.links, createdAt: this.manager._time()});
      row.updatedAt = this.manager._time();
    });
    return result;
  }
  toolsSchema(name) { return this.tools('schema-only').find(tool => tool.name === name).inputSchema; }
  init() {
    if (!this.data.length) return;
    this.manager._mutate(data => { for (const row of data.managementConversations || []) {
      if (row.threadId || row.requests.some(request => IN_FLIGHT.has(request.status))) { row.executionState = 'unknown'; row.backgroundState = 'unknown'; row.backgroundCount = null; row.lastError = '앱이 다시 시작되었습니다. 원래 관리 대화를 다시 연결하여 확인하십시오.'; }
      for (const request of row.requests) if (request.status === 'queued') { request.status = 'cancelled'; request.error = '앱 재시작 후 관리 요청을 자동으로 실행하지 않았습니다.'; }
      for (const receipt of row.toolReceipts) if (receipt.status === 'prepared') receipt.status = 'unknown';
    } });
    // Recover metadata without sending a new turn or replaying a tool mutation.
    for (const row of this.data) if (row.threadId) void this.reconnect(row.id).catch(error => this._error(row.id, error));
  }
  hasActiveWork() { return this.pumps.size > 0 || this.actions.size > 0 || this.reconciling.size > 0 || this.data.some(row => ['starting', 'running', 'unknown'].includes(row.executionState) || row.requests.some(request => IN_FLIGHT.has(request.status))); }
  async reset() { this.generation = Object.freeze({}); this.scopes.clear(); const sessions = [...this.sessions.values()]; this.sessions.clear(); this.messages.clear(); await Promise.allSettled(sessions.map(session => session.close?.())); }
  async close() { await this.reset(); }
}

module.exports = {OpsManagement, createProjectAdapter, EXECUTION};
