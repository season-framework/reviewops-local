'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createOpsSession, opsDeliveryPrompt,opsToolOutput} = require('../electron/ops-session.cjs');

function fixture(t, settings = {}) {
  const calls = [], events = [], clients = [], threads = new Map();let nextThread = 0, nextTurn = 0, nextItem = 0;
  const server = {loseStart: false, loseSteer: false, finishBeforeAck: false, steerRace: false, ackInterruptOnly: false, pages: null, ...settings};
  class Client extends EventEmitter {
    constructor(options) { super();this.options = options;this.closed = false;clients.push(this); }
    async start() {}
    close() {this.closed = true;this.emit('close');}
    complete(threadId, status = 'completed') {
      const thread = threads.get(threadId), turn = thread.turns.find(row => row.status === 'inProgress');
      if (!turn) return;
      turn.status = status;thread.status.type = 'idle';thread.updatedAt++;
      this.emit('notification', 'turn/completed', {threadId, turn: {...turn}});
    }
    async request(method, params) {
      calls.push({client: this, method, params});
      if(server.unsupported===method)throw Object.assign(new Error('Unsupported method'),{code:-32601});
      if (method === 'thread/start') {
        const thread = {id: `thread_${++nextThread}`, status: {type: 'idle'}, updatedAt: 1, turns: [], entries: []};threads.set(thread.id, thread);
        this.emit('notification', 'thread/started', {thread});return {thread};
      }
      const thread = threads.get(params.threadId);
      if (!thread) throw Object.assign(new Error('Not found'), {code: -32600});
      if (method === 'thread/resume' || method === 'thread/read') return {thread: {...thread, turns: []}};
      if (method === 'thread/turns/list') {
        if (server.pages) return server.pages(params);
        return {data: [...thread.turns].reverse(), nextCursor: null};
      }
      if (method === 'thread/items/list') {
        if (server.pages) return server.pages(params);
        return {data: [...thread.entries].reverse(), nextCursor: null};
      }
      if (method === 'turn/start' || method === 'turn/steer') {
        let turn = thread.turns.find(row => row.status === 'inProgress');
        if (method === 'turn/steer' && server.steerRace) {server.steerRace = false;this.complete(thread.id);throw Object.assign(new Error('Turn completed'), {code: -32600});}
        if (method === 'turn/steer' && (!turn || turn.id !== params.expectedTurnId)) throw Object.assign(new Error('Wrong turn'), {code: -32600});
        if (!turn) {
          turn = {id: `turn_${++nextTurn}`, status: 'inProgress', itemsView: 'full', items: []};thread.turns.push(turn);thread.status.type = 'active';
          this.emit('notification', 'turn/started', {threadId: thread.id, turn: {...turn}});
        }
        const item = {id: `item_${++nextItem}`, type: 'userMessage', content: params.input};
        turn.items.push(item);thread.entries.push({turnId: turn.id, item});thread.updatedAt++;
        this.emit('notification', 'item/completed', {threadId: thread.id, turnId: turn.id, item});
        if (server.finishBeforeAck) {server.finishBeforeAck = false;this.complete(thread.id);}
        if (method === 'turn/start' && server.loseStart) {server.loseStart = false;throw Object.assign(new Error('Lost response'), {code: 'TIMEOUT'});}
        if (method === 'turn/steer' && server.loseSteer) {server.loseSteer = false;throw Object.assign(new Error('Lost response'), {code: 'TIMEOUT'});}
        return method === 'turn/start' ? {turn: {...turn, status: 'inProgress'}} : {turnId: turn.id};
      }
      if (method === 'turn/interrupt') {if (!server.ackInterruptOnly) this.complete(thread.id, 'interrupted');return {};}
      if (method === 'thread/backgroundTerminals/clean') {
        if (server.cleanupDenied) throw Object.assign(new Error('Unsupported cleanup'), {code: -32601});
        return {};
      }
      if (method === 'thread/backgroundTerminals/list') return server.terminalPages?.(params) || {data: [], nextCursor: null};
      throw new Error(`Unexpected method ${method}`);
    }
  }
  const session = extra => createOpsSession({goalId: extra?.goalId || 'goal_one', workPath: '/tmp/ops-owned-project', config: {approvalPolicy: 'never', sandboxMode: 'workspace-write'},
    runtime: {command: 'trusted-runtime', args: [],version:'0.166.0-alpha.5.1'}, rpcFactory: value => new Client(value), onEvent: event => events.push(event), interruptPollMs: 1, ...extra});
  const primary = session();t.after(() => primary.close());
  return {primary, session, calls, events, clients, threads, server};
}

test('delivery markers preserve exact prompt content and reject changed marked input', () => {
  const value = opsDeliveryPrompt({deliveryId: 'delivery_one', prompt: 'Original\n\nrequest'});
  assert.equal(opsDeliveryPrompt({deliveryId: 'delivery_one', prompt: value}), value);
  assert.match(value, /^\[ReviewOps Ops delivery delivery_one; sha256=[a-f0-9]{64}\]\n\nOriginal\n\nrequest$/);
  assert.throws(() => opsDeliveryPrompt({deliveryId: 'delivery_one', prompt: value + 'changed'}), {code: 'OPS_DELIVERY_CONFLICT'});
});

test('a runtime below the validated protocol baseline is rejected before allocating a thread',async t=>{
  const f=fixture(t),old=f.session({runtime:{command:'trusted-runtime',args:[],version:'0.165.99'}});t.after(()=>old.close());
  await assert.rejects(old.start({deliveryId:'old',prompt:'Do not send'}),{code:'OPS_CODEX_PROTOCOL_UNSUPPORTED',deliveryState:'not_sent'});assert.equal(f.clients.length,0);assert.equal(f.threads.size,0);
});

test('missing required protocol methods refuse model input and retain an allocated empty thread for repair',async t=>{
 for(const method of ['thread/turns/list','thread/backgroundTerminals/list','thread/backgroundTerminals/clean']){
  const f=fixture(t,{unsupported:method});await assert.rejects(f.primary.start({deliveryId:'preflight',prompt:'Send only after repair'}),{code:'OPS_CODEX_PROTOCOL_UNSUPPORTED',deliveryState:'not_sent'});
  assert.equal(f.calls.filter(row=>row.method==='turn/start').length,0);assert.equal(new Set(f.events.filter(row=>row.type==='thread').map(row=>row.threadId)).size,1);
  f.server.unsupported=null;await f.primary.start({deliveryId:'preflight',prompt:'Send only after repair'});assert.equal(f.calls.filter(row=>row.method==='thread/start').length,1);assert.equal(f.calls.filter(row=>row.method==='turn/start').length,1);
 }
});

test('protocol compatibility probes never clean a resumed owner',async t=>{
 const f=fixture(t),started=await f.primary.start({deliveryId:'existing',prompt:'Keep existing work'});await f.primary.close();const before=f.calls.filter(row=>row.method==='thread/backgroundTerminals/clean').length;
 const resumed=f.session({threadId:started.threadId});t.after(()=>resumed.close());await resumed.reconcile({deliveryId:'existing',prompt:'Keep existing work'});assert.equal(f.calls.filter(row=>row.method==='thread/backgroundTerminals/clean').length,before);
});

test('trusted QA image results use actual inputImage content and keep PNG bytes outside text and events',async t=>{
 const f=fixture(t),png=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(10,16);png.writeUInt32BE(10,20);
 const session=f.session({tools:[{name:'ops_qa_capture',description:'Owned image result',inputSchema:{type:'object'},execute:()=>opsToolOutput({capture:{sha256:'a'.repeat(64)}},{images:[png]})}]});t.after(()=>session.close());
 const started=await session.start({deliveryId:'image',prompt:'Read only the owned image'}),handler=f.clients[0].options.onServerRequest;
 const result=await handler({method:'item/tool/call',params:{threadId:started.threadId,turnId:started.turnId,callId:'image_call',tool:'ops_qa_capture',arguments:{}}});
 assert.equal(result.success,true);assert.deepEqual(result.contentItems.map(row=>row.type),['inputText','inputImage']);assert.equal(result.contentItems[1].imageUrl,'data:image/png;base64,'+png.toString('base64'));assert.equal(result.contentItems[0].text.includes(png.toString('base64')),false);assert.equal(JSON.stringify(f.events).includes(png.toString('base64')),false);
 assert.throws(()=>opsToolOutput({}, {images:[Buffer.alloc(2*1024*1024+1)]}),{code:'OPS_INVALID_TOOL_IMAGE'});
});

test('one goal steers its active turn and starts idle work in the same persistent thread and process', async t => {
  const f = fixture(t), first = await f.primary.start({deliveryId: 'one', prompt: 'First request'});
  const second = await f.primary.steer({deliveryId: 'two', prompt: 'Additional instruction', threadId: first.threadId, turnId: first.turnId});
  assert.equal(second.threadId, first.threadId);assert.equal(second.turnId, first.turnId);
  assert.equal(f.clients.length, 1);assert.equal(f.calls.filter(row => row.method === 'turn/start').length, 1);assert.equal(f.calls.filter(row => row.method === 'turn/steer').length, 1);
  const steer = f.calls.find(row => row.method === 'turn/steer').params;
  assert.equal(steer.expectedTurnId, first.turnId);assert.equal(steer.clientUserMessageId, 'two');assert.equal(steer.input[0].text, opsDeliveryPrompt({deliveryId: 'two', prompt: 'Additional instruction'}));
  f.clients[0].complete(first.threadId);
  const third = await f.primary.start({deliveryId: 'three', prompt: 'Next idle request'});
  assert.equal(third.threadId, first.threadId);assert.notEqual(third.turnId, first.turnId);assert.equal(f.clients.length, 1);
  assert.ok(f.events.some(row => row.type === 'thread' && row.threadId === first.threadId));
});

test('independent goals run concurrently and interrupt only their own target', async t => {
  const f = fixture(t), other = f.session({goalId: 'goal_two'});t.after(() => other.close());
  const [a,b] = await Promise.all([f.primary.start({deliveryId: 'a', prompt: 'A'}), other.start({deliveryId: 'b', prompt: 'B'})]);
  assert.notEqual(a.threadId, b.threadId);assert.equal(f.clients.length, 2);
  const beforeStop=f.calls.length;const stopped = await f.primary.interrupt({threadId: a.threadId, turnId: a.turnId});assert.equal(stopped.confirmed, true);
  assert.equal(f.threads.get(b.threadId).status.type, 'active');
  assert.deepEqual(f.calls.filter(row => row.method === 'turn/interrupt').map(row => row.params), [{threadId: a.threadId, turnId: a.turnId}]);
  assert.deepEqual(f.calls.slice(beforeStop).filter(row => row.method === 'thread/backgroundTerminals/clean').map(row => row.params), [{threadId: a.threadId}]);
  const cleanupIndex = beforeStop;
  assert.ok(f.calls.slice(cleanupIndex).filter(row => row.method === 'thread/backgroundTerminals/list').every(row => row.params.threadId === a.threadId));
});

test('interrupt cleans yielded commands even after the model is idle and verifies every terminal page', async t => {
  const f = fixture(t), started = await f.primary.start({deliveryId: 'background', prompt: 'Owned background work'});
  f.clients[0].complete(started.threadId);
  let scans = 0;
  f.server.terminalPages = params => !f.calls.some(row => row.method === 'thread/backgroundTerminals/clean')
    ? {data: [{processId: 'owned_process'}], nextCursor: null} : params.cursor
    ? {data: [{processId: 'owned_process'}], nextCursor: null}
    : ++scans === 1 ? {data: [], nextCursor: 'more'} : {data: [], nextCursor: null};
  const stopped = await f.primary.interrupt({threadId: started.threadId});
  assert.equal(stopped.confirmed, true);assert.equal(stopped.terminalsStopped, true);assert.equal(stopped.turnId, null);
  assert.equal(f.calls.filter(row => row.method === 'turn/interrupt').length, 0);
  assert.ok(f.calls.some(row => row.method === 'thread/backgroundTerminals/list' && row.params.cursor === 'more'));
  assert.ok(scans >= 2);
});

test('normal model completion reports active, empty and unknown terminal ownership without cleaning it', async t => {
  const f = fixture(t), started = await f.primary.start({deliveryId: 'terminal_owner', prompt: 'Owned background service'});
  const priorCleanCount=f.calls.filter(row=>row.method==='thread/backgroundTerminals/clean').length;
  f.server.terminalPages = params => params.cursor ? {data: [{processId: 'second'}], nextCursor: null} : {data: [{processId: 'first'}], nextCursor: 'more'};
  f.clients[0].complete(started.threadId);await new Promise(resolve => setImmediate(resolve));
  const complete = f.events.find(row => row.type === 'turn.completed');assert.equal(complete.backgroundState, 'active');assert.equal(complete.backgroundCount, 2);
  let view = await f.primary.reconcile({deliveryId: 'terminal_owner', prompt: 'Owned background service'});assert.equal(view.state, 'idle');assert.equal(view.backgroundState, 'active');assert.equal(view.backgroundCount, 2);
  f.server.terminalPages = () => ({data: [], nextCursor: null});view = await f.primary.reconcile({deliveryId: 'terminal_owner', prompt: 'Owned background service'});assert.equal(view.backgroundState, 'empty');assert.equal(view.backgroundCount, 0);
  f.server.terminalPages = () => {throw Object.assign(new Error('Unsupported list'), {code: -32601});};view = await f.primary.reconcile({deliveryId: 'terminal_owner', prompt: 'Owned background service'});assert.equal(view.state, 'idle');assert.equal(view.backgroundState, 'unknown');assert.equal(view.backgroundCount, null);
  assert.equal(f.calls.filter(row => row.method === 'thread/backgroundTerminals/clean').length, priorCleanCount);
});

test('a terminal model event never publishes idle ownership before its background query completes', async t => {
  const f = fixture(t), started = await f.primary.start({deliveryId: 'terminal_probe', prompt: 'Wait for terminal ownership proof'});let finish;
  f.server.terminalPages = () => new Promise(resolve => {finish = resolve;});f.clients[0].complete(started.threadId);await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.some(row => row.type === 'turn.completed'), false);assert.equal(typeof finish, 'function');
  finish({data: [{processId: 'still_owned'}], nextCursor: null});await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.find(row => row.type === 'turn.completed').backgroundState, 'active');
});

test('unsupported cleanup and acknowledged cleanup with live terminals never confirm Pause', async t => {
  const f = fixture(t), started = await f.primary.start({deliveryId: 'cleanup', prompt: 'Owned background work'});f.server.cleanupDenied=true;
  await assert.rejects(f.primary.interrupt({threadId: started.threadId, turnId: started.turnId}), {code: 'OPS_TERMINAL_CLEANUP_UNCONFIRMED'});
  f.server.cleanupDenied = false;f.server.terminalPages = () => ({data: [{processId: 'still_running'}], nextCursor: null});
  await assert.rejects(f.primary.interrupt({threadId: started.threadId}), {code: 'OPS_TERMINAL_CLEANUP_UNCONFIRMED'});
  f.server.terminalPages = () => ({data: [], nextCursor: 'repeated'});
  await assert.rejects(f.primary.interrupt({threadId: started.threadId}), {code: 'OPS_TERMINAL_CLEANUP_UNCONFIRMED'});
});

test('lost start and steering replies reconcile original user history without replay', async t => {
  const f = fixture(t, {loseStart: true});
  const start = await f.primary.start({deliveryId: 'start_lost', prompt: 'Keep the original start'});assert.equal(start.delivery, 'accepted');
  f.server.loseSteer = true;
  const steer = await f.primary.steer({deliveryId: 'steer_lost', prompt: 'Keep the original steer', threadId: start.threadId, turnId: start.turnId});assert.equal(steer.delivery, 'accepted');
  await f.primary.start({deliveryId: 'start_lost', prompt: 'Keep the original start'});
  assert.equal(f.calls.filter(row => row.method === 'turn/start').length, 1);assert.equal(f.calls.filter(row => row.method === 'turn/steer').length, 1);
});

test('restart resumes the stored thread and finds a prior delivery across paginated history', async t => {
  const f = fixture(t), started = await f.primary.start({deliveryId: 'saved', prompt: 'Persistent original'});f.clients[0].complete(started.threadId);await f.primary.close();
  const entry = f.threads.get(started.threadId).entries[0];
  f.server.pages = params => params.cursor ? {data: [{id: started.turnId, status: 'completed', itemsView: 'full', items: [entry.item]}], nextCursor: null} : {data: [{id: 'later_turn', status: 'completed', itemsView: 'full', items: [{id: 'assistant', type: 'agentMessage', text: 'Response'}]}], nextCursor: 'older'};
  const resumed = f.session({threadId: started.threadId});t.after(() => resumed.close());
  const result = await resumed.reconcile({deliveryId: 'saved', prompt: 'Persistent original'});
  assert.equal(result.delivery, 'accepted');assert.equal(result.deliveryTurnId, started.turnId);assert.equal(result.state, 'idle');
  assert.equal(f.calls.filter(row => row.method === 'thread/start').length, 1);assert.equal(f.calls.filter(row => row.method === 'turn/start').length, 1);
  assert.ok(f.calls.some(row => row.method === 'thread/resume' && row.params.threadId === started.threadId));
});

test('assistant quotations, active missing input and truncated history never prove delivery absence', async t => {
  const f = fixture(t), started = await f.primary.start({deliveryId: 'existing', prompt: 'Running request'});
  const text = opsDeliveryPrompt({deliveryId: 'missing', prompt: 'New request'});
  f.server.pages = () => ({data: [{id: started.turnId, status: 'inProgress', itemsView: 'full', items: [{id: 'quoted', type: 'agentMessage', text}]}], nextCursor: null});
  assert.equal((await f.primary.reconcile({deliveryId: 'missing', prompt: 'New request'})).delivery, 'unknown');
  f.clients[0].complete(started.threadId);f.server.pages = () => ({data: [], nextCursor: 'same'});
  assert.equal((await f.primary.reconcile({deliveryId: 'missing', prompt: 'New request'})).delivery, 'unknown');
  f.server.pages = () => ({data: [], nextCursor: null});
  assert.equal((await f.primary.reconcile({deliveryId: 'missing', prompt: 'New request'})).delivery, 'not_found');
});

test('a completed-turn steer race reconciles before one idle fallback', async t => {
  const f = fixture(t), first = await f.primary.start({deliveryId: 'first', prompt: 'Initial'});f.server.steerRace = true;
  const result = await f.primary.steer({deliveryId: 'race', prompt: 'Arrived as work completed', threadId: first.threadId, turnId: first.turnId});
  assert.equal(result.delivery, 'accepted');assert.equal(result.threadId, first.threadId);assert.notEqual(result.turnId, first.turnId);
  assert.equal(f.calls.filter(row => row.method === 'turn/steer').length, 1);assert.equal(f.calls.filter(row => row.method === 'turn/start').length, 2);
});

test('completion before the start response does not revert the goal to running', async t => {
  const f = fixture(t, {finishBeforeAck: true});
  const result = await f.primary.start({deliveryId: 'fast', prompt: 'Fast response'});
  assert.equal(result.delivery, 'accepted');assert.equal(result.state, 'idle');assert.equal(result.activeTurnId, null);
});

test('dynamic tools use trusted goal closures, reject other threads and deduplicate call identities', async t => {
  const f = fixture(t), changes = [];
  const session = f.session({tools: [{name: 'ops_schedules_create', description: 'Create a schedule for this goal', inputSchema: {type: 'object'}, execute: (args, metadata) => {changes.push({args, metadata});return {scheduleId: 'schedule_one'};}}]});t.after(() => session.close());
  const started = await session.start({deliveryId: 'tools', prompt: 'Use the bound tools'}), handler = f.clients[0].options.onServerRequest;
  const call = {method: 'item/tool/call', params: {threadId: started.threadId, turnId: started.turnId, callId: 'call_one', namespace: null, tool: 'ops_schedules_create', arguments: {reason: 'Need a daily follow-up'}}};
  const [one,two] = await Promise.all([handler(call), handler(call)]);
  assert.equal(one.success, true);assert.deepEqual(two, one);assert.equal(changes.length, 1);assert.equal(changes[0].metadata.callId, 'call_one');
  assert.equal((await handler({...call, params: {...call.params, threadId: 'other_thread'}})).success, false);
  assert.equal((await handler({...call, params: {...call.params, arguments: {reason: 'Changed'}}})).success, false);assert.equal(changes.length, 1);
  const spec = f.calls.find(row => row.method === 'thread/start').params.dynamicTools[0];assert.equal(spec.type, 'function');assert.equal(spec.name, 'ops_schedules_create');
});

test('interrupt acknowledgements alone do not claim terminal execution', async t => {
  const f = fixture(t, {ackInterruptOnly: true}), started = await f.primary.start({deliveryId: 'active', prompt: 'Still working'});
  await assert.rejects(f.primary.interrupt({threadId: started.threadId, turnId: started.turnId}), {code: 'OPS_INTERRUPT_UNCONFIRMED'});
  assert.equal(f.threads.get(started.threadId).status.type, 'active');
});

test('thread identity and delivery content cannot be switched inside a session', async t => {
  const f = fixture(t), started = await f.primary.start({deliveryId: 'bound', prompt: 'Original'});
  await assert.rejects(f.primary.start({deliveryId: 'bound', prompt: 'Changed'}), {code: 'OPS_DELIVERY_CONFLICT'});
  await assert.rejects(f.primary.steer({deliveryId: 'other', prompt: 'Other', threadId: 'unrelated_thread'}), {code: 'OPS_THREAD_MISMATCH'});
  assert.equal(f.calls.filter(row => row.method === 'turn/start').length, 1);
});

test('definite runtime failures are not-sent and selected access policies stay explicit', async t => {
  const f=fixture(t),missing=f.session({runtime:{available:false}});t.after(()=>missing.close());
  await assert.rejects(missing.start({deliveryId:'unavailable',prompt:'Not submitted'}),error=>error.deliveryState==='not_sent'&&error.code==='OPS_CODEX_UNAVAILABLE');
  assert.equal(f.calls.length,0);
  assert.throws(()=>f.session({config:{sandboxMode:'workspace-write',approvalPolicy:'on-failure'}}),{code:'OPS_INVALID_EXECUTION_CONFIG'});
  await f.primary.start({deliveryId:'policies',prompt:'Use selected settings'});
  const params=f.calls.find(row=>row.method==='thread/start').params;
  assert.equal(params.sandbox,'workspace-write');assert.equal(params.approvalPolicy,'never');assert.equal(params.historyMode,'paginated');
});

test('SSH sessions use only their freshly resolved private target and never discover a local CLI', async t => {
  const f=fixture(t),opened=[],identity='ssh:'+'a'.repeat(64),privateConfig={password:'private-auth-never-in-events'};
  const remote=f.session({workPath:'/srv/remote-only-project',target:{kind:'ssh',identityKey:identity},resolveRuntime:()=>{throw new Error('Local discovery is forbidden');},
    resolveSessionTarget:async()=>({sshConfig:privateConfig,workPath:'/srv/remote-only-project',binary:'/opt/codex',targetIdentity:identity}),
    sshServiceFactory:()=>({openAppServer:async(config,options)=>{opened.push({config,options});return {canonicalWorkPath:options.workPath,identity,runtimeVersion:'0.166.0-alpha.5.1',child:{}};},close:async()=>{}})});t.after(()=>remote.close());
  const started=await remote.start({deliveryId:'remote',prompt:'Remote target'});await remote.steer({deliveryId:'remote_steer',prompt:'Same remote turn'});
  assert.equal(opened.length,1);assert.equal(opened[0].config,privateConfig);assert.equal(opened[0].options.targetIdentity,identity);
  assert.equal(f.calls.find(row=>row.method==='thread/start').params.cwd,'/srv/remote-only-project');assert.equal(f.clients.length,1);
  assert.equal(JSON.stringify(f.events).includes(privateConfig.password),false);assert.equal(started.delivery,'accepted');
});

test('SSH identity changes fail before app-server or user input is started', async t => {
  const f=fixture(t);let opened=0;
  const remote=f.session({target:{kind:'ssh',identityKey:'ssh:'+'a'.repeat(64)},resolveSessionTarget:()=>({sshConfig:{},workPath:'/tmp/ops-owned-project',targetIdentity:'ssh:'+'b'.repeat(64)}),
    sshServiceFactory:()=>({openAppServer:()=>{opened++;},close:async()=>{}})});t.after(()=>remote.close());
  await assert.rejects(remote.start({deliveryId:'changed',prompt:'Must not be sent'}),error=>error.code==='OPS_TARGET_CHANGED'&&error.deliveryState==='not_sent');assert.equal(opened,0);assert.equal(f.calls.length,0);
});

test('runtime selection is refreshed only when reopening the same saved thread', async t => {
  const f=fixture(t);let lookups=0;
  const session=f.session({resolveRuntime:()=>({command:'runtime_'+(++lookups),args:[],version:'0.166.0-alpha.5.1'})});t.after(()=>session.close());
  const first=await session.start({deliveryId:'original',prompt:'Keep this thread'});await session.steer({deliveryId:'extra',prompt:'Same process'});assert.equal(lookups,1);
  f.clients[0].close();const recovered=await session.reconcile({threadId:first.threadId,deliveryId:'original',prompt:'Keep this thread'});
  assert.equal(recovered.delivery,'accepted');assert.equal(lookups,2);assert.equal(f.clients[1].options.command,'runtime_2');assert.equal(f.calls.filter(row=>row.method==='thread/start').length,1);
});

test('history recovery includes final responses after the matching delivery in chronological order', async t => {
  const f=fixture(t),first=await f.primary.start({deliveryId:'restore',prompt:'Original input'}),thread=f.threads.get(first.threadId),turn=thread.turns[0];
  turn.items.push({id:'restored_answer',type:'agentMessage',text:'Actual stored response'});f.clients[0].complete(first.threadId);
  const result=await f.primary.reconcile({deliveryId:'restore',prompt:'Original input'});
  assert.deepEqual(result.items.map(row=>row.role),['user','assistant']);assert.equal(result.items[1].text,'Actual stored response');assert.equal(result.outcome,'completed');assert.equal(result.safeToRetry,false);
});

test('responses retain their prefix beyond the prompt limit and report overflow instead of a final tail', async t => {
  const f=fixture(t),started=await f.primary.start({deliveryId:'long_output',prompt:'Read a long response'});
  const text='ORIGINAL_PREFIX_'+ 'x'.repeat(300000);
  f.clients[0].emit('notification','item/completed',{threadId:started.threadId,turnId:started.turnId,item:{type:'agentMessage',id:'large_answer',text}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.events.find(event=>event.type==='message'&&event.itemId==='large_answer').text,text);
  for(let count=0;count<5;count++)f.clients[0].emit('notification','item/agentMessage/delta',{threadId:started.threadId,turnId:started.turnId,itemId:'overflow',delta:'x'.repeat(1024*1024)});
  f.clients[0].emit('notification','item/agentMessage/delta',{threadId:started.threadId,turnId:started.turnId,itemId:'overflow',delta:'must not become a new tail'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.events.filter(event=>event.code==='OPS_RESPONSE_TOO_LARGE').length,1);
  assert.equal(f.events.some(event=>event.itemId==='overflow'&&event.text?.includes('must not become')),false);
  assert.equal(f.events.filter(event=>event.itemId==='overflow').every(event=>event.partial),true);
});

test('bound tools wait for durable turn scope before executing', async t => {
  const f=fixture(t);let release,persisted=false,executed=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const session=f.session({onEvent:async event=>{if(event.type==='turn.started'){await gate;persisted=true;}},tools:[{name:'ops_owned_tool',description:'Owned scope check',inputSchema:{type:'object'},execute:()=>{assert.equal(persisted,true);executed=true;return {done:true};}}]});t.after(()=>session.close());
  const starting=session.start({deliveryId:'durable_scope',prompt:'Scope must be durable'});
  await new Promise(resolve=>setImmediate(resolve));
  const thread=[...f.threads.values()][0],turn=thread.turns[0];
  const call=f.clients[0].options.onServerRequest({method:'item/tool/call',params:{threadId:thread.id,turnId:turn.id,callId:'durable_call',namespace:null,tool:'ops_owned_tool',arguments:{}}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(executed,false);release();await starting;assert.equal((await call).success,true);assert.equal(executed,true);
});
