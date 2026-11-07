'use strict';

// These tests use an explicit fake server/socket owner. They exercise protocol,
// authority identity and drain behavior; they establish no TLS or browser trust.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');
const {createHash}=require('node:crypto');
const {createWebReadListener} = require('../electron/remote-web-listener.cjs');

const date = '2026-11-06T00:00:00.000Z';
const project = {id: 'project-a', name: 'Project A', description: 'Shared description', createdAt: date, updatedAt: date};
const review = {id: 'review-a', projectId: project.id, number: 1, title: 'Review A', body: 'Original body',
  status: 'open', priority: 'normal', category: 'ux', createdAt: date, updatedAt: date};
const projectDTO = () => ({version: 1, projects: [{...project}]});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };

class FakeSocket extends EventEmitter {
  constructor(closeGate = null) { super(); this.encrypted = true; this.destroyed = false; this.closeGate = closeGate; }
  setTimeout() { return this; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.closeGate) this.closeGate.promise.then(() => this.emit('close'));
    else queueMicrotask(() => this.emit('close'));
  }
}
function distinctSockets(secureCloseGate = null) {
  const raw = new FakeSocket(), secure = new FakeSocket(secureCloseGate); raw.encrypted = false;
  const destroyRaw = raw.destroy.bind(raw), destroySecure = secure.destroy.bind(secure);
  raw.destroy = () => { destroyRaw(); destroySecure(); };
  secure.destroy = () => { destroySecure(); destroyRaw(); };
  return {raw, secure};
}
class FakeResponse extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.headersSent = false; this.destroyed = false; this.writableFinished = false;
    this.outcome = deferred();
    socket.once('close', () => { if (!this.writableFinished) this.destroy(); });
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  end(bytes) {
    this.bytes = Buffer.from(bytes || ''); this.writableFinished = true;
    this.emit('finish'); this.outcome.resolve(this);
    if (this.headers.Connection === 'close') this.socket.destroy();
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); this.outcome.resolve(this); } }
  json() { return JSON.parse(this.bytes.toString('utf8')); }
}
class FakeServer extends EventEmitter {
  constructor(handler, {bindError = null, listenGate = null} = {}) {
    super(); this.handler = handler; this.listening = false; this.bindError = bindError; this.listenGate = listenGate; this.closeCalls = 0;
  }
  listen(address) {
    if (this.bindError) return queueMicrotask(() => this.emit('error', this.bindError));
    this.bound = {address: address.host, port: address.port}; this.listening = true;
    if (this.listenGate) this.listenGate.promise.then(() => this.emit('listening'));
    else queueMicrotask(() => this.emit('listening'));
  }
  address() { return this.bound; }
  close(callback) {
    this.closeCalls++;
    const wasListening = this.listening; this.listening = false;
    // Deliberately permit server close to precede an original socket's close.
    queueMicrotask(() => {
      callback(wasListening ? null : Object.assign(new Error('not running'), {code: 'ERR_SERVER_NOT_RUNNING'}));
      this.emit('test-close-callback');
    });
  }
  dispatch(path, body, options = {}) {
    const pair = options.socket ? null : distinctSockets(), socket = options.socket || pair.secure;
    if (pair) {
      this.emit('connection', pair.raw);
      if (!pair.raw.destroyed) this.emit('secureConnection', pair.secure);
    }
    const bytes = options.bytes || Buffer.from(body === undefined ? '' : JSON.stringify(body));
    const endpoint = new URL(`https://${this.bound.address}:${this.bound.port}`);
    const headers = {...(options.method === 'GET' ? {} : {'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes.length), origin: endpoint.origin}),
      host: endpoint.host, ...options.headers};
    const request = Readable.from(options.chunks || (bytes.length ? [bytes] : []));
    request.method = options.method || 'POST'; request.url = path; request.httpVersion = '1.1'; request.headers = headers; request.socket = socket;
    request.rawHeaders = options.rawHeaders || Object.entries(headers).flat();
    const response = new FakeResponse(socket);
    this.handler(request, response);
    return {request, response, socket, rawSocket: pair?.raw, pending: response.outcome.promise};
  }
}

async function fixture(options = {}) {
  const notices = [], closed = [], calls = [], asset = Buffer.from('<!doctype html><title>Original</title>');
  let server, creates = 0, releases = 0;
  const lease = Object.freeze({identity: Object.freeze({kind: 'TEST_ONLY_NOT_TLS', address: options.identityAddress || '127.0.0.1'}),
    createServer(handler) { creates++; server = new FakeServer(handler, options); options.onCreate?.(listener, server); return server; },
    release() { releases++; return options.release?.(); }});
  const listener = createWebReadListener({tlsLease: lease, assets: {'/': {bytes: asset, mimeType: 'text/html; charset=utf-8'}},
    onPendingBrowser: async notice => { notices.push(notice); return options.onPending?.(notice); },
    onRead: async (...args) => { calls.push(args); return options.onRead ? options.onRead(...args) : projectDTO(); },
    onClosed: async event => { closed.push(event); return options.onClosed?.(event); }});
  if (!options.skipListen) await listener.listen({address: '127.0.0.1', port: options.port || 9443});
  const send = async (path, body, extra) => (await server.dispatch(path, body, extra).pending);
  async function login() {
    const invitation = listener.inviteBrowser();
    const response = await send('/web/v1/session', {version: 1, requestId: 'login-1', action: 'login',
      ...invitationFields(invitation), clientName: 'External browser'});
    const cookie = response.headers['Set-Cookie'].split(';')[0];
    return {cookie, pending: notices.at(-1).pendingHandle, response};
  }
  async function approve() {
    const original = await login(), authority = Object.freeze(Object.create(null));
    listener.approveBrowser(original.pending, authority);
    return {...original, authority};
  }
  return {listener, asset, notices, closed, calls, send, login, approve,
    server: () => server, counts: () => ({creates, releases})};
}
function invitationFields(value) { return {invitationId: value.invitationId, secret: value.secret}; }
function read(requestId = 'read-1', operation = 'projects.list', payload = {}) { return {version: 1, requestId, operation, payload}; }
function authenticated(cookie, extra = {}) { return {headers: {cookie, ...extra}}; }

const attachmentQuery={projectId:project.id,reviewId:review.id,attachmentId:'attachment-a',offset:0};
function chunkDTO(bytes=Buffer.from([0,255,1])){
  return{version:1,attachment:{id:'attachment-a',reviewId:review.id,activityId:null,name:'file.bin',mimeType:'application/octet-stream',
    size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:date},offset:0,nextOffset:bytes.length,data:bytes.toString('base64'),complete:true};
}
test('attachment reads retain the original approved browser principal and exact numeric offset',async()=>{
  const original=chunkDTO(Buffer.alloc(65536,13));
  const item=await fixture({onRead:async()=>original});
  try{
    const session=await item.approve();
    const result=await item.send('/web/v1/read',read('chunk','attachments.read',attachmentQuery),authenticated(session.cookie));
    assert.deepEqual(result.json().data,original);
    assert.strictEqual(item.calls[0][0],session.authority);assert.equal(item.calls[0][1],'attachments.read');
    assert.deepEqual({...item.calls[0][2]},attachmentQuery);assert.ok(Object.isFrozen(item.calls[0][2]));
    assert.equal(result.bytes.includes(Buffer.from('storageName')),false);
  }finally{await item.listener.closeAndDrain();}
});
test('attachment offsets and extra authority fields are refused before the engine callback',async()=>{
  const item=await fixture();
  try{
    const session=await item.approve();
    for(const payload of [{...attachmentQuery,offset:-1},{...attachmentQuery,offset:'0'},{...attachmentQuery,offset:0.5},
      {...attachmentQuery,offset:10*1024*1024+1},{...attachmentQuery,path:'/private/file'}]){
      const result=await item.send('/web/v1/read',read('bad','attachments.read',payload),authenticated(session.cookie));
      assert.equal(result.json().ok,false);
    }
    assert.equal(item.calls.length,0);
  }finally{await item.listener.closeAndDrain();}
});
test('attachment output refuses private fields, foreign metadata and noncanonical chunks',async()=>{
  const original=chunkDTO(),invalid=[
    {...original,attachment:{...original.attachment,storageName:'private.bin'}},
    {...original,attachment:{...original.attachment,reviewId:'foreign'}},
    {...original,attachment:{...original.attachment,name:'../private'}},
    {...original,attachment:{...original.attachment,size:10*1024*1024+1}},
    {...original,data:'AB=='},
    {...original,nextOffset:4},
    chunkDTO(Buffer.alloc(65537))
  ];
  let returned;const item=await fixture({onRead:async()=>returned});
  try{
    const session=await item.approve();
    for(const value of invalid){returned=value;const result=await item.send('/web/v1/read',read('bad','attachments.read',attachmentQuery),authenticated(session.cookie));assert.equal(result.json().error.code,'INVALID_SNAPSHOT');}
    returned=chunkDTO(Buffer.alloc(0));
    const empty=await item.send('/web/v1/read',read('empty','attachments.read',attachmentQuery),authenticated(session.cookie));
    assert.deepEqual(empty.json().data,returned);
  }finally{await item.listener.closeAndDrain();}
});
test('revoking browser approval withholds its original held attachment bytes',async()=>{
  const held=deferred(),entered=deferred();const item=await fixture({onRead:()=>{entered.resolve();return held.promise;}});
  try{
    const session=await item.approve();
    const response=item.server().dispatch('/web/v1/read',read('held','attachments.read',attachmentQuery),authenticated(session.cookie));
    await entered.promise;item.listener.revoke(session.authority);
    held.resolve(chunkDTO());const result=await response.pending;
    assert.equal(result.destroyed,true);assert.equal(result.bytes,undefined);
  }finally{held.resolve(chunkDTO());await item.listener.closeAndDrain();}
});

test('captures fixed assets and rejects path/host/origin aliases without invoking authority', async () => {
  const item = await fixture();
  try {
    item.asset.fill(120);
    const page = await item.send('/', undefined, {method: 'GET'});
    assert.equal(page.bytes.toString(), '<!doctype html><title>Original</title>');
    assert.match(page.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
    for (const path of ['/../electron/main.cjs', '/%2e%2e/package.json', '/?token=secret']) {
      const rejected = await item.send(path, undefined, {method: 'GET'}); assert.equal(rejected.json().ok, false);
    }
    for (const headers of [{host: 'attacker.example'}, {origin: 'https://attacker.example'}]) {
      assert.equal((await item.send('/web/v1/read', read(), {headers})).json().error.code, 'INVALID_REQUEST');
    }
    assert.equal(item.calls.length, 0);
  } finally { await item.listener.closeAndDrain(); }
  assert.deepEqual(item.counts(), {creates: 1, releases: 1});
});

test('one-use invitation stays pending until the original local handle is approved', async () => {
  const item = await fixture();
  try {
    const session = await item.login();
    assert.deepEqual(Object.keys(session.response.json().data), ['state', 'expiresAt']);
    assert.equal(session.response.json().data.state, 'pending');
    assert.match(session.response.headers['Set-Cookie'], /Secure; HttpOnly; SameSite=Strict; Path=\//);
    const state = item.listener.state();
    assert.equal(JSON.stringify(state).includes('secret'), false);
    assert.equal(JSON.stringify(state).includes(session.cookie.split('=')[1]), false);
    assert.throws(() => item.listener.approveBrowser({}, {}), {code: 'STALE_SESSION'});
    const denied = await item.send('/web/v1/read', read(), authenticated(session.cookie));
    assert.equal(denied.json().error.code, 'PENDING_APPROVAL'); assert.equal(item.calls.length, 0);
    const authority = Object.freeze(Object.create(null)); item.listener.approveBrowser(session.pending, authority);
    const result = await item.send('/web/v1/read', read(), authenticated(session.cookie));
    assert.deepEqual(result.json().data, projectDTO());
    assert.equal(item.calls[0][0], authority);
    assert.equal(Object.isFrozen(item.calls[0][2]), true);
    assert.throws(() => item.listener.approveBrowser(session.pending, {}), {code: 'STALE_SESSION'});
  } finally { await item.listener.closeAndDrain(); }
  assert.equal(item.closed.length, 1);
});

test('strict framing rejects duplicate decoded keys, invalid UTF8, arrays, depth and surplus bytes', async () => {
  const item = await fixture();
  try {
    const duplicate = Buffer.from('{"version":1,"requestId":"a","operation":"projects.list","payload":{},"paylo\\u0061d":{}}');
    const invalid = [duplicate, Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('null'),
      Buffer.from('{"version":1,"requestId":"a","payload":{"a":{"b":{"c":{"d":{}}}}}}')];
    for (const bytes of invalid) {
      const response = await item.send('/web/v1/read', undefined, {bytes});
      assert.equal(response.json().error.code, 'INVALID_REQUEST');
    }
    const bytes = Buffer.alloc(8193, 32);
    assert.equal((await item.send('/web/v1/read', undefined, {bytes})).json().error.code, 'INVALID_REQUEST');
    const encoded = Buffer.from(JSON.stringify(read()));
    const short = await item.send('/web/v1/read', undefined, {bytes: encoded, headers: {'content-length': String(encoded.length - 1)}});
    assert.equal(short.json().error.code, 'INVALID_REQUEST');
    const duplicateHeader = await item.send('/web/v1/read', read(), {rawHeaders: ['Host', '127.0.0.1:9443', 'host', '127.0.0.1:9443']});
    assert.equal(duplicateHeader.json().error.code, 'INVALID_REQUEST');
    const transfer = await item.send('/web/v1/read', read(), {headers: {'transfer-encoding': 'chunked'}});
    assert.equal(transfer.json().error.code, 'INVALID_REQUEST');
    assert.equal(item.notices.length, 0); assert.equal(item.calls.length, 0);
  } finally { await item.listener.closeAndDrain(); }
});

test('rejects extra authority fields and non-read actions before the read callback', async () => {
  const item = await fixture();
  try {
    const session = await item.approve();
    for (const value of [{...read(), projectGrants: []}, read('a', 'agent.start', {}),
      read('a', 'reviews.get', {projectId: 'project-a', reviewId: 'review-a', serviceId: 'foreign'})]) {
      const result = await item.send('/web/v1/read', value, authenticated(session.cookie));
      assert.equal(result.json().ok, false);
    }
    assert.equal(item.calls.length, 0);
  } finally { await item.listener.closeAndDrain(); }
});

test('preserves review DTO order/text while rejecting private fields and wrong target', async () => {
  let supplied = {version: 1, projectId: project.id, review: {...review, body: '한글😀\n"\\'}};
  const item = await fixture({onRead: () => supplied});
  try {
    const session = await item.approve();
    const request = read('a', 'reviews.get', {projectId: project.id, reviewId: review.id});
    const result = await item.send('/web/v1/read', request, authenticated(session.cookie));
    assert.deepEqual(result.json().data, supplied);
    assert.deepEqual(Object.keys(result.json().data.review), Object.keys(review));
    assert.equal(Number(result.headers['Content-Length']), result.bytes.length);
    let getterCalls = 0;
    supplied = {version: 1, projectId: project.id, review: {...review}};
    Object.defineProperty(supplied.review, 'credentials', {enumerable: true, get() { getterCalls++; throw new Error('secret'); }});
    const privateResult = await item.send('/web/v1/read', request, authenticated(session.cookie));
    assert.equal(privateResult.json().error.code, 'INVALID_SNAPSHOT'); assert.equal(getterCalls, 0);
    supplied = {version: 1, projectId: project.id, review: {...review, id: 'review-b'}};
    assert.equal((await item.send('/web/v1/read', request, authenticated(session.cookie))).json().error.code, 'INVALID_SNAPSHOT');
  } finally { await item.listener.closeAndDrain(); }
});

test('whole DTO limit and kernel limit mapping permit a later smaller read under the same approval', async () => {
  let mode = 'large';
  const item = await fixture({onRead: () => {
    if (mode === 'kernel') throw Object.assign(new Error('/private/path'), {code: 'BROWSING_QUERY_LIMIT_EXCEEDED'});
    return mode === 'large' ? {version: 1, projectId: project.id,
      reviews: Array.from({length: 11}, (_, index) => ({...review, id: 'review-' + index, body: 'x'.repeat(100000)}))} :
      {version: 1, projectId: project.id, reviews: [{...review}]};
  }});
  try {
    const session = await item.approve(), request = read('a', 'reviews.list', {projectId: project.id});
    for (const next of ['large', 'kernel']) {
      mode = next;
      const result = await item.send('/web/v1/read', request, authenticated(session.cookie));
      assert.deepEqual(result.json().error, {code: 'QUERY_LIMIT_EXCEEDED', message: 'The complete web response exceeds the query limit.'});
      assert.equal(result.bytes.includes(Buffer.from('/private/path')), false);
      assert.equal(Object.hasOwn(result.json(), 'data'), false);
    }
    mode = 'small';
    const recovered = await item.send('/web/v1/read', request, authenticated(session.cookie));
    assert.equal(recovered.json().data.reviews.length, 1);
  } finally { await item.listener.closeAndDrain(); }
});

test('same-session concurrent read is busy and revoke withholds the original held result', async () => {
  const entered = deferred(), held = deferred();
  const item = await fixture({onRead: () => { entered.resolve(); return held.promise; }});
  let first;
  try {
    const session = await item.approve();
    first = item.server().dispatch('/web/v1/read', read('first'), authenticated(session.cookie));
    await entered.promise;
    const second = await item.send('/web/v1/read', read('second'), authenticated(session.cookie));
    assert.equal(second.json().error.code, 'BUSY'); assert.equal(item.calls.length, 1);
    item.listener.revoke(session.authority);
    assert.equal((await first.pending).destroyed, true);
    held.resolve(projectDTO());
    await item.listener.closeAndDrain();
    assert.equal(first.response.bytes, undefined);
    assert.equal(item.closed.length, 1);
  } finally {
    held.resolve(projectDTO());
    if (first) await first.pending;
    await item.listener.closeAndDrain();
  }
});

test('closing during pending login retains its original callback and refuses late approval', async () => {
  const entered = deferred(), held = deferred(); let original;
  const item = await fixture({onPending: notice => { original = notice; entered.resolve(); return held.promise; }});
  let launch, closing;
  try {
    const invitation = item.listener.inviteBrowser();
    launch = item.server().dispatch('/web/v1/session', {version: 1, requestId: 'a', action: 'login',
      ...invitationFields(invitation), clientName: 'Held browser'});
    await entered.promise;
    closing = item.listener.closeAndDrain();
    assert.equal(item.counts().releases, 0);
    assert.throws(() => item.listener.approveBrowser(original.pendingHandle, {}), {code: 'STALE_SESSION'});
    held.resolve(); await closing;
    assert.equal((await launch.pending).destroyed, true);
    assert.deepEqual(item.counts(), {creates: 1, releases: 1});
    assert.equal(item.closed.length, 1);
  } finally {
    held.resolve(); if (launch) await launch.pending;
    await (closing || item.listener.closeAndDrain());
  }
});

test('cached close awaits the lease original socket drain and cannot restart its released owner', async () => {
  const release = deferred(), item = await fixture({release: () => release.promise});
  let first;
  try {
    first = item.listener.closeAndDrain(); const second = item.listener.closeAndDrain();
    assert.equal(first, second);
    await Promise.resolve(); await Promise.resolve();
    assert.notEqual(item.listener.state().state, 'closed');
    release.resolve(); await first;
    assert.equal(item.listener.state().state, 'closed'); assert.equal(item.counts().releases, 1);
    await assert.rejects(item.listener.listen({address: '127.0.0.1', port: 9443}), {code: 'INVALID_REQUEST'});
  } finally { release.resolve(); await (first || item.listener.closeAndDrain()); }
});

test('cleanup rejection stays unconfirmed and never releases TLS or retries the callback', async () => {
  const item = await fixture({onClosed: () => { throw new Error('private cleanup diagnostic'); }});
  const session = await item.approve(); item.listener.disconnect(session.pending);
  const closing = item.listener.closeAndDrain();
  await assert.rejects(closing, {code: 'UNAVAILABLE'});
  assert.equal(item.listener.closeAndDrain(), closing);
  assert.equal(item.listener.state().state, 'unconfirmed');
  assert.equal(item.closed.length, 1); assert.equal(item.counts().releases, 0);
});

test('failed bind is not an active listener and can release only after original close', async () => {
  const item = await fixture({skipListen: true, bindError: Object.assign(new Error('busy'), {code: 'EADDRINUSE'})});
  await assert.rejects(item.listener.listen({address: '127.0.0.1', port: 9443}), {code: 'EADDRINUSE'});
  assert.equal(item.listener.state().state, 'error'); assert.equal(item.counts().releases, 0);
  await item.listener.closeAndDrain();
  assert.deepEqual(item.counts(), {creates: 1, releases: 1}); assert.equal(item.server().closeCalls, 1);
});

test('logout retires the same session once and clears its secure cookie', async () => {
  const item = await fixture();
  try {
    const session = await item.approve();
    const result = await item.send('/web/v1/logout', {version: 1, requestId: 'logout-1'}, authenticated(session.cookie));
    assert.deepEqual(result.json().data, {state: 'logged-out'});
    assert.match(result.headers['Set-Cookie'], /Max-Age=0/);
    const old = await item.send('/web/v1/read', read(), authenticated(session.cookie));
    assert.equal(old.json().error.code, 'AUTH_REQUIRED'); assert.equal(item.calls.length, 0);
  } finally { await item.listener.closeAndDrain(); }
  assert.equal(item.closed.length, 1);
});

test('reentrant close during the original server factory waits that same factory before release', async () => {
  let closing;
  const item = await fixture({skipListen: true, onCreate: listener => { closing = listener.closeAndDrain(); }});
  try {
    const listening = item.listener.listen({address: '127.0.0.1', port: 9443});
    assert.equal(item.counts().releases, 0);
    await assert.rejects(listening, {code: 'UNAVAILABLE'});
    await closing;
    assert.equal(item.server().listening, false); assert.equal(item.server().closeCalls, 1);
    assert.deepEqual(item.counts(), {creates: 1, releases: 1});
  } finally { await (closing || item.listener.closeAndDrain()); }
});

test('close during a held listen attempt awaits its original settlement before closing the server', async () => {
  const gate = deferred(), item = await fixture({skipListen: true, listenGate: gate});
  let listening, closing;
  try {
    listening = item.listener.listen({address: '127.0.0.1', port: 9443});
    const observed = assert.rejects(listening, {code: 'UNAVAILABLE'});
    closing = item.listener.closeAndDrain();
    assert.equal(item.server().closeCalls, 0); assert.equal(item.counts().releases, 0);
    gate.resolve(); await observed; await closing;
    assert.equal(item.server().closeCalls, 1); assert.equal(item.counts().releases, 1);
  } finally {
    gate.resolve(); if (listening) await listening.catch(() => {});
    await (closing || item.listener.closeAndDrain());
  }
});

test('listen captures primitive address and port before the trusted factory can mutate the input', async () => {
  const input = {address: '127.0.0.1', port: 9443};
  const item = await fixture({skipListen: true, onCreate: () => { input.address = '0.0.0.0'; input.port = 9999; }});
  try {
    const state = await item.listener.listen(input);
    assert.deepEqual(state.endpoint, {address: '127.0.0.1', port: 9443, url: 'https://127.0.0.1:9443/'});
  } finally { await item.listener.closeAndDrain(); }
});

test('expired pending identity cannot be approved or revived through its old cookie', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const item = await fixture();
  try {
    const session = await item.login(); clock += 5 * 60 * 1000 + 1;
    assert.equal(item.listener.state().pending.length, 0);
    assert.throws(() => item.listener.approveBrowser(session.pending, {}), {code: 'STALE_SESSION'});
    const result = await item.send('/web/v1/read', read(), authenticated(session.cookie));
    assert.equal(result.json().error.code, 'AUTH_REQUIRED'); assert.equal(item.calls.length, 0);
  } finally { await item.listener.closeAndDrain(); }
  assert.equal(item.closed.length, 1);
});

test('server close callback and raw close cannot substitute for the accepted original TLS close', async () => {
  const gate = deferred(), item = await fixture(), pair = distinctSockets(gate), callback = deferred();
  let closing;
  try {
    item.server().emit('connection', pair.raw);
    item.server().emit('secureConnection', pair.secure);
    await item.server().dispatch('/', undefined, {method: 'GET', socket: pair.secure}).pending;
    item.server().once('test-close-callback', callback.resolve);
    closing = item.listener.closeAndDrain();
    const observed = closing.then(() => 'closed', error => error);
    await callback.promise; await Promise.resolve();
    assert.equal(item.counts().releases, 0); assert.notEqual(item.listener.state().state, 'closed');
    gate.resolve(); assert.equal(await observed, 'closed');
    assert.equal(item.counts().releases, 1);
  } finally { gate.resolve(); await (closing || item.listener.closeAndDrain()); }
});

test('a socket rejected at the connection cap also retains its original close event', async () => {
  const gate = deferred(), item = await fixture(), callback = deferred(); let closing;
  try {
    for (let index = 0; index < 16; index++) item.server().emit('connection', new FakeSocket());
    const rejected = new FakeSocket(gate); item.server().emit('connection', rejected);
    assert.equal(rejected.destroyed, true);
    item.server().once('test-close-callback', callback.resolve);
    closing = item.listener.closeAndDrain();
    const observed = closing.then(() => 'closed', error => error);
    await callback.promise; await Promise.resolve(); assert.equal(item.counts().releases, 0);
    gate.resolve(); assert.equal(await observed, 'closed'); assert.equal(item.counts().releases, 1);
  } finally { gate.resolve(); await (closing || item.listener.closeAndDrain()); }
});

test('port 443 uses the browser canonical Host and Origin during actual protocol admission', async () => {
  const item = await fixture({port: 443});
  try {
    assert.equal(item.listener.state().endpoint.url, 'https://127.0.0.1/');
    const session = await item.approve();
    const result = await item.send('/web/v1/read', read(), authenticated(session.cookie));
    assert.deepEqual(result.json().data, projectDTO()); assert.equal(item.calls.length, 1);
  } finally { await item.listener.closeAndDrain(); }
});

test('pinned certificate address mismatch refuses before any original server is created', async () => {
  const item = await fixture({skipListen: true, identityAddress: '127.0.0.2'});
  await assert.rejects(item.listener.listen({address: '127.0.0.1', port: 9443}), {code: 'INVALID_REQUEST'});
  assert.equal(item.counts().creates, 0);
  await item.listener.closeAndDrain(); assert.equal(item.counts().releases, 1);
});

test('existing identifier values remain browseable values rather than dynamic object keys', async () => {
  let supplied;
  const item = await fixture({onRead: () => supplied});
  try {
    const session = await item.approve();
    for (const projectId of ['__proto__', 'constructor', 'prototype']) {
      supplied = {version: 1, projectId, reviews: [{...review, projectId, id: 'constructor'}]};
      const listed = await item.send('/web/v1/read', read('a', 'reviews.list', {projectId}), authenticated(session.cookie));
      assert.equal(listed.json().data.projectId, projectId);
      supplied = {version: 1, projectId, review: {...review, projectId, id: 'constructor'}};
      const selected = await item.send('/web/v1/read', read('b', 'reviews.get', {projectId, reviewId: 'constructor'}), authenticated(session.cookie));
      assert.equal(selected.json().data.review.id, 'constructor');
      assert.equal(Object.getPrototypeOf(item.calls.at(-1)[2]), null);
    }
  } finally { await item.listener.closeAndDrain(); }
});

test('request authority uses the distinct original TLS socket and refuses an unregistered lookalike', async () => {
  const item = await fixture();
  try {
    const invitation = item.listener.inviteBrowser();
    const login = item.server().dispatch('/web/v1/session', {version: 1, requestId: 'a', action: 'login',
      ...invitationFields(invitation), clientName: 'Distinct TLS browser'});
    const result = await login.pending;
    assert.notEqual(login.rawSocket, login.socket);
    assert.equal(login.rawSocket.encrypted, false); assert.equal(login.socket.encrypted, true);
    assert.equal(result.json().data.state, 'pending');
    const cookie = result.headers['Set-Cookie'].split(';')[0];
    item.listener.approveBrowser(item.notices[0].pendingHandle, {});
    const unregistered = new FakeSocket();
    const refused = await item.server().dispatch('/web/v1/read', read(), {...authenticated(cookie), socket: unregistered}).pending;
    assert.equal(refused.json().error.code, 'INVALID_REQUEST'); assert.equal(item.calls.length, 0);
    const readBack = await item.send('/web/v1/read', read(), authenticated(cookie));
    assert.deepEqual(readBack.json().data, projectDTO()); assert.equal(item.calls.length, 1);
  } finally { await item.listener.closeAndDrain(); }
});
