'use strict';

const path = require('node:path');
const {createHash} = require('node:crypto');
const {RpcClient} = require('./codex/rpc-client.cjs');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TEXT = 256 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error('The Codex goal session could not complete this request.'), {code}); }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('OPS_INVALID_SESSION'); return value; }
function prompt(value) { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > MAX_TEXT) fail('OPS_INVALID_PROMPT'); return value; }
function opsDeliveryPrompt({deliveryId, prompt: value}) {
  id(deliveryId);prompt(value);
  const prefix = `[ReviewOps Ops delivery ${deliveryId}; `;
  if (value.startsWith(prefix)) {
    const match = /^\[ReviewOps Ops delivery ([A-Za-z0-9_-]+); sha256=([a-f0-9]{64})\]\n\n([\s\S]*)$/.exec(value);
    if (!match || match[1] !== deliveryId || digest(match[3]) !== match[2]) fail('OPS_DELIVERY_CONFLICT');
    return value;
  }
  const result = `${prefix}sha256=${digest(value)}]\n\n${value}`;
  if (Buffer.byteLength(result) > MAX_TEXT) fail('OPS_INVALID_PROMPT');
  return result;
}
const messageText = item => item?.type === 'userMessage' ? (item.content || []).filter(row => row?.type === 'text').map(row => row.text || '').join('') : item?.type === 'agentMessage' ? item.text : null;

// Each instance owns one app-server connection and one persistent thread. The
// durable watcher owns delivery admission, goal state and schedule receipts.
function createOpsSession(options) {
  const {goalId, workPath, onEvent = () => {}, tools = []} = options || {};
  id(goalId);
  const target = options.target || {kind: 'local'}, paths = target.kind === 'ssh' ? path.posix : path;
  if (!['local','ssh'].includes(target.kind) || typeof workPath !== 'string' || !paths.isAbsolute(workPath) || /[\0\r\n]/.test(workPath)) fail('OPS_INVALID_WORK_PATH');
  const config = {model: '', reasoningEffort: '', sandboxMode: 'workspace-write', approvalPolicy: 'never', ...(options.config || {})}, definitions = new Map();
  if (!['read-only','workspace-write','danger-full-access'].includes(config.sandboxMode) || !['never','untrusted','on-request'].includes(config.approvalPolicy) ||
      typeof config.model !== 'string' || config.model.length > 256 || /[\s\0]/.test(config.model) ||
      !['','none','minimal','low','medium','high','xhigh','max','ultra'].includes(config.reasoningEffort)) {
    throw Object.assign(new Error('The selected Codex execution settings are unsupported.'), {code: 'OPS_INVALID_EXECUTION_CONFIG', deliveryState: 'not_sent'});
  }
  for (const tool of tools) {
    if (!tool || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) || definitions.has(tool.name) || typeof tool.execute !== 'function' || typeof tool.description !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object') fail('OPS_INVALID_TOOL');
    const spec = {type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema};
    if (Buffer.byteLength(JSON.stringify(spec)) > 65536) fail('OPS_INVALID_TOOL');
    definitions.set(tool.name, {spec: JSON.parse(JSON.stringify(spec)), execute: tool.execute});
  }
  let threadId = options.threadId ? id(options.threadId) : null;
  let rpc = null, connecting = null, loaded = false, creating = false, creationUnknown = false, closed = false;
  let sshService = null, sessionWorkPath = workPath, targetIdentity = target.identityKey || null;
  let activeTurnId = null, state = 'unknown', queue = Promise.resolve(), eventQueue = Promise.resolve(), persistenceFailed = false;
  const turns = new Map(), deliveries = new Map(), toolCalls = new Map(), partials = new Map(), overflowed = new Set();
  const publish = event => {
    const task = eventQueue.then(() => onEvent({...event, goalId}));
    eventQueue = task.catch(() => { persistenceFailed = true; });
    return task;
  };
  async function flush() { await eventQueue; if (persistenceFailed) fail('OPS_EVENT_PERSISTENCE_FAILED'); }
  function current() { if (closed) fail('OPS_SESSION_CLOSED'); }
  function serial(operation) {
    const pending = queue.then(() => { current(); return operation(); });
    queue = pending.catch(() => {});return pending;
  }
  function bind(value) {
    id(value);
    if (threadId && value !== threadId) fail('OPS_THREAD_MISMATCH');
    threadId = value;
  }
  function responseOverflow(turnId, itemId) {
    const key = `${turnId}:${itemId}`;
    if (overflowed.has(key)) return;
    overflowed.add(key);partials.delete(key);
    publish({type: 'error', threadId, turnId, code: 'OPS_RESPONSE_TOO_LARGE',
      message: 'A Codex message exceeded the 4 MiB Ops display limit. Its full content remains in the original Codex thread.'}).catch(() => {});
  }
  function itemMessage(item, turnId, partial = false) {
    const text = messageText(item);
    if (typeof text !== 'string' || typeof item.id !== 'string') return null;
    if (Buffer.byteLength(text) > MAX_RESPONSE) {responseOverflow(turnId, item.id);return null;}
    return {type: 'message', threadId, turnId, itemId: item.id, role: item.type === 'userMessage' ? 'user' : 'assistant', text, partial};
  }
  function notify(method, params) {
    if (closed) return;
    if (method === 'thread/started' && creating && !threadId && params.thread?.id) {
      bind(params.thread.id);
      publish({type: 'thread', threadId, state: 'idle'}).catch(() => {});
    }
    if (params.threadId !== threadId) return;
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = params.turn;
      if (!turn?.id || !ID.test(turn.id)) return;
      turns.set(turn.id, turn);
      if (method === 'turn/started') { activeTurnId = turn.id;state = 'running'; }
      else if (activeTurnId === turn.id) { activeTurnId = null;state = 'idle'; }
      publish({type: method === 'turn/started' ? 'turn.started' : 'turn.completed', threadId, turnId: turn.id, status: turn.status, state,
        ...(turn.error ? {errorCode: 'OPS_TURN_FAILED'} : {})}).catch(() => {});
      for (const item of turn.items || []) { const event = itemMessage(item, turn.id);if (event) publish(event).catch(() => {}); }
    } else if (method === 'item/completed') {
      const event = itemMessage(params.item, params.turnId);if (event) {partials.delete(`${params.turnId}:${params.item.id}`);publish(event).catch(() => {});}
    } else if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const key = `${params.turnId}:${params.itemId}`;
      if (overflowed.has(key)) return;
      const text = (partials.get(key) || '') + params.delta;
      if (Buffer.byteLength(text) > MAX_RESPONSE) {responseOverflow(params.turnId, params.itemId);return;}
      partials.set(key, text);
      publish({type: 'message', threadId, turnId: params.turnId, itemId: params.itemId, role: 'assistant', text, partial: true}).catch(() => {});
    } else if (method === 'error') publish({type: 'error', threadId, turnId: params.turnId, code: 'OPS_TURN_ERROR', message: 'Codex reported an error while processing this goal.'}).catch(() => {});
  }
  async function serverRequest({method, params}) {
    if (method !== 'item/tool/call') {
      if (params.threadId === threadId && /Approval|requestUserInput|elicitation/.test(method)) await publish({type: 'error', threadId, turnId: params.turnId, code: 'OPS_APPROVAL_REQUIRED', message: 'This Codex turn requires an approval that Ops cannot provide.'});
      return undefined;
    }
    const denied = code => ({success: false, contentItems: [{type: 'inputText', text: JSON.stringify({error: code})}]});
    if (closed || !threadId || params.threadId !== threadId || params.namespace != null || !ID.test(params.turnId || '') || typeof params.callId !== 'string') return denied('OPS_TOOL_SCOPE_DENIED');
    const tool = definitions.get(params.tool);
    if (!tool || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) return denied('OPS_TOOL_SCOPE_DENIED');
    const bytes = JSON.stringify(params.arguments);
    if (Buffer.byteLength(bytes) > 65536) return denied('OPS_TOOL_ARGUMENTS_INVALID');
    const signature = digest(JSON.stringify([params.turnId, params.tool, params.arguments]));
    const previous = toolCalls.get(params.callId);
    if (previous) return previous.signature === signature ? previous.promise : denied('OPS_TOOL_CALL_CONFLICT');
    const task = Promise.resolve().then(async () => {
      current();
      if (activeTurnId !== params.turnId) {
        const view = await readState();
        if (view.state !== 'running' || view.turnId !== params.turnId) return denied('OPS_TOOL_SCOPE_DENIED');
      }
      await flush();current();
      const result = await tool.execute(JSON.parse(bytes), Object.freeze({callId: params.callId, threadId, turnId: params.turnId}));
      const text = JSON.stringify(result ?? null);
      if (Buffer.byteLength(text) > MAX_TEXT) return denied('OPS_TOOL_RESULT_TOO_LARGE');
      return {success: true, contentItems: [{type: 'inputText', text}]};
    }).catch(() => denied('OPS_TOOL_FAILED'));
    const record = {signature, promise: task, done: false};toolCalls.set(params.callId, record);
    task.finally(() => { record.done = true; });
    if (toolCalls.size > 1000) for (const [key, value] of toolCalls) { if (value.done && key !== params.callId) {toolCalls.delete(key);break;} }
    return task;
  }
  async function connection() {
    current();
    if (rpc && !rpc.closed) return rpc;
    if (connecting) return connecting;
    connecting = (async () => {
      const env = {...(options.env || process.env)};delete env.ELECTRON_RUN_AS_NODE;
      let transport;
      if (target.kind === 'ssh') {
        if (typeof options.resolveSessionTarget !== 'function') fail('OPS_SSH_TARGET_UNAVAILABLE');
        const resolved = await options.resolveSessionTarget();current();
        const expectedIdentity = targetIdentity || resolved.targetIdentity;
        if (!resolved.sshConfig || resolved.workPath !== workPath || targetIdentity && resolved.targetIdentity !== targetIdentity) fail('OPS_TARGET_CHANGED');
        sshService = (options.sshServiceFactory || (() => require('./ssh.cjs').createSshService()))();
        const opened = await sshService.openAppServer(resolved.sshConfig, {workPath, binary: resolved.binary || 'codex', targetIdentity: expectedIdentity});
        current();sessionWorkPath = opened.canonicalWorkPath;targetIdentity = opened.identity;
        transport = {command: 'trusted-ssh-app-server', args: [], spawnImpl: () => opened.child};
      } else {
        const runtime = await (options.resolveRuntime ? options.resolveRuntime() : typeof options.runtime === 'function' ? options.runtime() : options.runtime || require('./codex/runtime.cjs').findRuntime());
        current();
        const command = runtime?.command || runtime?.path;
        if (!command || runtime.available === false) fail('OPS_CODEX_UNAVAILABLE');
        const args = [...(runtime.args || [])];if (!args.includes('app-server')) args.push('app-server');
        transport = {command, args, env, cwd: sessionWorkPath};
      }
      const selected = (options.rpcFactory || (value => new RpcClient(value)))({...transport, timeoutMs: options.timeoutMs || 60000,
        clientInfo: {name: 'reviewops_ops', title: 'ReviewOps Ops', version: require('../package.json').version}, onServerRequest: serverRequest});
      rpc = selected;loaded = false;
      selected.on('notification', (method, params) => {
        try {notify(method, params);} catch {publish({type: 'error', threadId, code: 'OPS_PROTOCOL_ERROR', message: 'Codex returned an invalid session event.'}).catch(() => {});}
      });
      selected.on('close', () => {
        if (rpc !== selected) return;
        loaded = false;state = 'unknown';
        if (!closed) publish({type: 'error', threadId, turnId: activeTurnId, code: 'OPS_CONNECTION_LOST', message: 'The Codex connection was lost. Reconcile the saved thread before sending work again.'}).catch(() => {});
      });
      await selected.start();current();return selected;
    })().finally(() => { connecting = null; });
    return connecting;
  }
  function threadOptions() {
    const result = {cwd: sessionWorkPath};
    if (config.model) result.model = config.model;
    if (config.reasoningEffort) result.config = {model_reasoning_effort: config.reasoningEffort};
    if (config.sandboxMode) result.sandbox = config.sandboxMode;
    if (config.approvalPolicy) result.approvalPolicy = config.approvalPolicy;
    return result;
  }
  async function ensureThread(allowCreate) {
    const client = await connection();
    if (loaded) return client;
    if (threadId) {
      const result = await client.request('thread/resume', {threadId, excludeTurns: true, ...threadOptions()});
      bind(result.thread?.id);loaded = true;
      await publish({type: 'thread', threadId, state: result.thread?.status?.type === 'active' ? 'running' : 'idle', canonicalWorkPath: sessionWorkPath, targetIdentity});await flush();return client;
    }
    if (!allowCreate || creationUnknown) return null;
    creating = true;creationUnknown = true;
    try {
      const result = await client.request('thread/start', {...threadOptions(), ephemeral: false, historyMode: 'paginated', dynamicTools: [...definitions.values()].map(value => value.spec)});
      bind(result.thread?.id);loaded = true;creationUnknown = false;
      await publish({type: 'thread', threadId, state: 'idle', canonicalWorkPath: sessionWorkPath, targetIdentity});await flush();return client;
    } catch (error) {
      if (error.code === -32602 && !threadId) creationUnknown = false;
      throw error;
    } finally {creating = false;}
  }
  async function readState({allowIdleMetadata = false} = {}) {
    const client = await ensureThread(false);
    if (!client || !threadId) return {threadId, turnId: null, state: 'unknown', turns: [], updatedAt: null};
    const read = await client.request('thread/read', {threadId, includeTurns: false});bind(read.thread?.id);
    // Current CLI builds expose metadata before a first turn has materialized
    // paginated history. A new, admitted delivery can use authoritative idle
    // metadata; unknown deliveries still require real history reconciliation.
    if (allowIdleMetadata && read.thread.status?.type === 'idle') {
      activeTurnId = null;state = 'idle';
      return {threadId, turnId: null, state: 'idle', turns: [], updatedAt: read.thread.updatedAt, historyUnavailable: true};
    }
    const page = await client.request('thread/turns/list', {threadId, limit: 100, sortDirection: 'desc', itemsView: 'full'});
    if (!Array.isArray(page.data)) fail('OPS_PROTOCOL_UNAVAILABLE');
    for (const turn of page.data) if (turn?.id) turns.set(turn.id, turn);
    const active = page.data.find(turn => turn.status === 'inProgress');
    const type = read.thread.status?.type;
    const next = active ? 'running' : type === 'idle' ? 'idle' : 'unknown';
    activeTurnId = active?.id || null;state = next;
    return {threadId, turnId: activeTurnId, state, turns: page.data, updatedAt: read.thread.updatedAt, nextCursor: page.nextCursor};
  }
  async function history(view, text) {
    const client = await connection(), messages = [], seen = new Set();let page = {data: view.turns, nextCursor: view.nextCursor}, allFull = true;
    for (let count = 0; count < 100; count++) {
      if (!Array.isArray(page.data)) return {complete: false, messages};
      for (const turn of page.data) {
        if (turn?.id) turns.set(turn.id, turn);
        if (turn.itemsView !== 'full' || !Array.isArray(turn.items)) allFull = false;
        const turnMessages = [];let found = false;
        for (const item of turn.items || []) {
          const event = itemMessage(item, turn.id);if (event) turnMessages.push(event);
          if (item?.type === 'userMessage' && messageText(item) === text) found = true;
        }
        messages.unshift(...turnMessages);
        if (found) return {complete: false, found: turn.id, messages};
      }
      if (page.nextCursor == null) return {complete: allFull, messages};
      if (typeof page.nextCursor !== 'string' || seen.has(page.nextCursor)) return {complete: false, messages};
      seen.add(page.nextCursor);
      page = await client.request('thread/turns/list', {threadId, limit: 100, sortDirection: 'desc', itemsView: 'full', cursor: page.nextCursor});
    }
    return {complete: false, messages};
  }
  async function reconcileInternal(input) {
    if (input.threadId) bind(input.threadId);
    const text = input.deliveryId ? opsDeliveryPrompt(input) : null;
    let view;
    try {
      view = await readState();
      if (!threadId) return {threadId: null, turnId: null, state: 'unknown', delivery: 'unknown'};
      if (!text) return {...view, activeTurnId: view.turnId, delivery: 'unknown'};
      const known = deliveries.get(input.deliveryId);
      if (known && known.prompt !== text) fail('OPS_DELIVERY_CONFLICT');
      const result = await history(view, text);
      for (const event of result.messages) await publish(event);
      const after = await readState();
      const stable = digest(JSON.stringify(view.turns)) === digest(JSON.stringify(after.turns));
      const delivery = result.found ? 'accepted' : result.complete && view.state === 'idle' && after.state === 'idle' && view.updatedAt === after.updatedAt && stable ? 'not_found' : 'unknown';
      if (delivery === 'accepted') deliveries.set(input.deliveryId, {prompt: text, state: 'accepted', turnId: result.found});
      await publish({type: 'delivery', threadId, turnId: result.found || after.turnId, deliveryId: input.deliveryId, state: delivery, deliveredPrompt: text});await flush();
      const turnStatus = result.found ? turns.get(result.found)?.status || null : null;
      return {threadId, turnId: after.turnId || result.found || null, activeTurnId: after.turnId, deliveryTurnId: result.found || null, state: after.state, delivery, turnStatus,
        outcome: ['completed','failed','interrupted'].includes(turnStatus) ? turnStatus : null, safeToRetry: false,
        items: result.messages};
    } catch (error) {
      if (['OPS_DELIVERY_CONFLICT','OPS_THREAD_MISMATCH','OPS_EVENT_PERSISTENCE_FAILED'].includes(error.code)) throw error;
      return {threadId, turnId: activeTurnId, activeTurnId, state: 'unknown', delivery: 'unknown', errorCode: 'OPS_RECONCILIATION_UNAVAILABLE'};
    }
  }
  async function deliver(input) {
    const deliveryId = id(input.deliveryId), text = opsDeliveryPrompt(input);
    if (input.threadId) bind(input.threadId);
    const known = deliveries.get(deliveryId);
    if (known && known.prompt !== text) fail('OPS_DELIVERY_CONFLICT');
    if (known?.state === 'accepted') {
      const turnStatus = turns.get(known.turnId)?.status || null;
      return {threadId, turnId: activeTurnId || known.turnId, activeTurnId, deliveryTurnId: known.turnId, state, delivery: 'accepted', deliveredPrompt: text,
        turnStatus, outcome: ['completed','failed','interrupted'].includes(turnStatus) ? turnStatus : null};
    }
    if (known?.state === 'unknown') return reconcileInternal({...input, prompt: text});
    let client, view;
    try {
      client = await ensureThread(true);
      if (client) view = await readState({allowIdleMetadata: true});
    } catch (error) {
      // Queries/resume and target preparation do not submit a user prompt.
      // An unidentified thread creation is the sole pre-turn ambiguous case.
      if (!threadId && creationUnknown) return {threadId: null, turnId: null, state: 'unknown', delivery: 'unknown', errorCode: 'OPS_THREAD_CREATION_UNKNOWN'};
      const failure = Object.assign(new Error('Codex or the selected execution target is unavailable before input delivery.'), {
        code: error.code || 'OPS_CODEX_UNAVAILABLE', deliveryState: 'not_sent',
      });
      throw failure;
    }
    if (!client) return {threadId, turnId: activeTurnId, state: 'unknown', delivery: 'unknown'};
    if (!['running','idle'].includes(view.state)) return {threadId, turnId: view.turnId, state: 'unknown', delivery: 'unknown'};
    // A serial caller can still race a model completion. A failed steer is
    // reconciled before an idle fallback; transport errors never replay input.
    for (let attempt = 0; attempt < 2; attempt++) {
      current();await flush();
      const method = view.state === 'running' ? 'turn/steer' : 'turn/start';
      const params = {threadId, clientUserMessageId: deliveryId, input: [{type: 'text', text, text_elements: []}]};
      if (method === 'turn/steer') params.expectedTurnId = view.turnId;
      else if (config.reasoningEffort) params.effort = config.reasoningEffort;
      deliveries.set(deliveryId, {prompt: text, state: 'unknown'});
      await publish({type: 'delivery', threadId, turnId: view.turnId, deliveryId, state: 'unknown', deliveredPrompt: text});
      try {
        const result = await client.request(method, params), acceptedTurn = method === 'turn/steer' ? result.turnId : result.turn?.id;
        id(acceptedTurn);
        const observed = turns.get(acceptedTurn) || result.turn;
        const terminal = observed && ['completed','failed','interrupted'].includes(observed.status);
        if (observed && !turns.has(acceptedTurn)) turns.set(acceptedTurn, observed);
        activeTurnId = terminal ? null : acceptedTurn;state = terminal ? 'idle' : 'running';
        deliveries.set(deliveryId, {prompt: text, state: 'accepted', turnId: acceptedTurn});
        await publish({type: 'delivery', threadId, turnId: acceptedTurn, deliveryId, state: 'accepted', deliveredPrompt: text});await flush();
        const turnStatus = observed?.status || 'inProgress';
        return {threadId, turnId: acceptedTurn, activeTurnId, deliveryTurnId: acceptedTurn, state, delivery: 'accepted', deliveredPrompt: text, turnStatus,
          outcome: ['completed','failed','interrupted'].includes(turnStatus) ? turnStatus : null};
      } catch (error) {
        if (error.code === 'OPS_EVENT_PERSISTENCE_FAILED') throw error;
        const reconciled = await reconcileInternal({...input, prompt: text});
        if (method === 'turn/steer' && [-32600,-32602].includes(error.code) && reconciled.delivery === 'not_found' && reconciled.state === 'idle' && !client.closed && attempt === 0) {view = reconciled;continue;}
        return reconciled;
      }
    }
  }
  return Object.freeze({
    start: input => serial(() => deliver(input)),
    steer: input => serial(() => deliver(input)),
    reconcile: (input = {}) => serial(() => reconcileInternal(input)),
    interrupt: input => serial(async () => {
      if (input.threadId) bind(input.threadId);
      const view = await readState(), target = input.turnId || view.turnId;
      if (!target) return {threadId, turnId: null, state: view.state, confirmed: view.state === 'idle'};
      id(target);
      let requested = false;
      try { await (await connection()).request('turn/interrupt', {threadId, turnId: target});requested = true; } catch {}
      for (let count = 0; count < 20; count++) {
        const result = await readState(), turn = turns.get(target);
        if (turn && ['completed','interrupted','failed'].includes(turn.status)) {await flush();return {threadId, turnId: target, activeTurnId: result.turnId, state: result.state, confirmed: true, status: turn.status};}
        if (!requested && result.state === 'idle' && !turn) fail('OPS_INTERRUPT_UNCONFIRMED');
        await pause(options.interruptPollMs || 250);
      }
      fail('OPS_INTERRUPT_UNCONFIRMED');
    }),
    async close() {closed = true;rpc?.close();await sshService?.close();await eventQueue;},
  });
}

module.exports = {createOpsSession, opsDeliveryPrompt};
