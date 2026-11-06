'use strict';

const {randomBytes, randomUUID, createHash, timingSafeEqual} = require('node:crypto');
const {isIP} = require('node:net');
const {createRemoteAppCommands} = require('./remote-app-commands.cjs');
const {captureAppSessions} = require('./remote-app-session-store.cjs');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const LIMIT = Object.freeze({body: 256 * 1024, response: 1024 * 1024, connections: 16, requests: 8, sessions: 16});
const publicCodes = new Set(['INVALID_COMMAND', 'INVALID_REQUEST', 'AUTH_REQUIRED', 'AUTH_FAILED', 'PENDING_APPROVAL',
  'ACCESS_DENIED', 'NOT_FOUND', 'STALE_EPOCH', 'STALE_REVIEW', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'COMMAND_LIMIT', 'EXECUTION_UNAVAILABLE', 'COMMAND_FAILED', 'BUSY']);
const freshToken = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
function fail(code) { throw Object.assign(new Error('Remote app access is unavailable.'), {code}); }
function closed(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('INVALID_REQUEST');
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) fail('INVALID_REQUEST');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_REQUEST');
    result[key] = descriptor.value;
  }
  return result;
}

// App authorization is deliberately separate from browser cookies and grants.
// Only the local main process receives this object's invitation/approval API.
function createRemoteAppListener({lease, store, executeAgent, clock = Date.now,
  onApprove = () => {}, onRead = () => fail('EXECUTION_UNAVAILABLE'), onRevoke = () => {}, sessionStore = null,
  assertActive = () => {}, onCommitted = () => {}}) {
  if (!lease || typeof lease.createServer !== 'function' ||
      [clock, onApprove, onRead, onRevoke, assertActive, onCommitted].some(value => typeof value !== 'function') ||
      sessionStore && (typeof sessionStore.read !== 'function' || typeof sessionStore.write !== 'function')) fail('INVALID_REQUEST');
  const sessions = new Map(), sockets = new Set(), secureSockets = new Set(), work = new Set();
  let server, address, port, closing = false, active = 0, invitation, closePromise;
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_REQUEST'); return value; };
  const assertReady = () => { if (assertActive() !== undefined) fail('ACCESS_DENIED'); };
  function persist() {
    if (!sessionStore) return;
    sessionStore.write({version: 1, sessions: [...sessions.values()].filter(row => row.state === 'approved').map(row =>
      ({id: row.id, label: row.label, address: row.address, digest: row.digest.toString('hex'), epoch: row.epoch,
        expiresAt: row.expiresAt, grants: row.grants}))});
  }
  function retire(session, save = true) {
    sessions.delete(session.id); session.state = 'revoked';
    try { onRevoke(session.peer); } finally { if (save) persist(); }
  }
  function restore() {
    if (!sessionStore) return;
    const saved = captureAppSessions(sessionStore.read()), dataset = store.peerReadDataset(), time = now();
    const births = new Map(dataset.projects.map(row => [row.projectId, row.birth]));
    for (const row of saved.sessions) {
      if (row.expiresAt <= time || row.expiresAt > time + 24 * 60 * 60 * 1000 || row.epoch !== dataset.epoch ||
          row.grants.some(grant => births.get(grant.projectId) !== grant.birth)) continue;
      const session = {...row, digest: Buffer.from(row.digest, 'hex'), peer: Object.freeze(Object.create(null)), state: 'pending'};
      sessions.set(session.id, session);
      onApprove(session.peer, Object.freeze(session.grants.map(({projectId, read, write, execute}) =>
        Object.freeze({projectId, read, write, execute}))));
      session.state = 'approved';
    }
    persist();
  }
  function retireExpired() {
    const time = now();
    for (const session of sessions.values()) if (session.expiresAt <= time) retire(session);
    if (invitation?.expiresAt <= time) invitation = null;
  }
  function authorize(session) {
    assertReady();
    retireExpired();
    if (closing || !server?.listening || !session || sessions.get(session.id) !== session || session.state !== 'approved') fail('ACCESS_DENIED');
    const currentEpoch = store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get()?.epoch;
    if (session.epoch !== currentEpoch) { retire(session); fail('STALE_EPOCH'); }
    const projectGrants = [];
    for (const grant of session.grants) {
      const birth = store.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(grant.projectId)?.birth;
      if (birth === grant.birth) projectGrants.push({projectId: grant.projectId, read: grant.read, write: grant.write, execute: grant.execute});
    }
    return {principalId: session.id, projectGrants};
  }
  const commands = createRemoteAppCommands({store, authorize, executeAgent, onCommitted});
  function findSession(header) {
    retireExpired();
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || !TOKEN.test(header.slice(7))) fail('AUTH_REQUIRED');
    const candidate = digest(header.slice(7));
    for (const session of sessions.values()) if (timingSafeEqual(candidate, session.digest)) return session;
    fail('AUTH_FAILED');
  }
  function publicState(session) {
    return {id: session.id, label: session.label, address: session.address, state: session.state,
      expiresAt: session.expiresAt, grants: session.grants.map(({projectId, read, write, execute}) => ({projectId, read, write, execute}))};
  }
  function send(response, status, value) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > LIMIT.response) fail('COMMAND_FAILED');
    response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Connection': 'close'});
    response.end(body);
  }
  async function readBody(request) {
    const chunks = []; let size = 0;
    const timeout = setTimeout(() => request.destroy(), 5000); timeout.unref();
    try {
      for await (const bytes of request) { size += bytes.length; if (size > LIMIT.body) fail('INVALID_REQUEST'); chunks.push(bytes); }
      let body;
      try { body = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)); } catch { fail('INVALID_REQUEST'); }
      try { return JSON.parse(body); } catch { fail('INVALID_REQUEST'); }
    } finally { clearTimeout(timeout); }
  }
  async function receive(request, response) {
    if (active >= LIMIT.requests) { send(response, 503, {ok: false, error: {code: 'BUSY'}}); return; }
    active++;
    try {
      assertReady();
      if (closing || !request.socket.encrypted || !secureSockets.has(request.socket) || request.method !== 'POST' ||
          request.headers.origin !== undefined || request.headers.cookie !== undefined ||
          request.headers.host !== `${address}:${port}` && !(port === 443 && request.headers.host === address) ||
          request.headers['content-type'] !== 'application/json' ||
          request.headers['transfer-encoding'] !== undefined || !/^\d+$/.test(request.headers['content-length'] || '') ||
          Number(request.headers['content-length']) > LIMIT.body) fail('INVALID_REQUEST');
      const route = request.url;
      if (!['/api/app/connect', '/api/app/state', '/api/app/read', '/api/app/writeState',
        '/api/app/command', '/api/app/result', '/api/app/disconnect'].includes(route)) fail('NOT_FOUND');
      const input = await readBody(request);
      if (route === '/api/app/connect') {
        const {invitation: supplied, label} = closed(input, ['invitation', 'label']);
        if (typeof supplied !== 'string' || !TOKEN.test(supplied) || typeof label !== 'string' ||
            !label.trim() || label.length > 120 || /[\x00-\x1f]/.test(label)) fail('INVALID_REQUEST');
        retireExpired();
        if (!invitation) fail('AUTH_FAILED');
        if (!timingSafeEqual(digest(supplied), invitation.digest)) {
          invitation.attempts++; if (invitation.attempts >= 5) invitation = null; fail('AUTH_FAILED');
        }
        invitation = null;
        if (sessions.size >= LIMIT.sessions) fail('BUSY');
        const secret = freshToken(), session = {id: randomUUID(), peer: Object.freeze(Object.create(null)), digest: digest(secret), label, address: request.socket.remoteAddress || '',
          state: 'pending', grants: [], epoch: '', expiresAt: now() + 24 * 60 * 60 * 1000};
        sessions.set(session.id, session);
        send(response, 200, {ok: true, data: {...publicState(session), sessionToken: secret}}); return;
      }
      const session = findSession(request.headers.authorization);
      if (route === '/api/app/state') { closed(input, []); send(response, 200, {ok: true, data: publicState(session)}); return; }
      if (route === '/api/app/disconnect') { closed(input, []); retire(session); send(response, 200, {ok: true, data: {disconnected: true}}); return; }
      if (session.state !== 'approved') fail('PENDING_APPROVAL');
      let value;
      if (route === '/api/app/read') {
        const {operation, payload} = closed(input, ['operation', 'payload']);
        const keys = operation === 'projects.list' ? [] : operation === 'reviews.list' ? ['projectId'] :
          ['reviews.get', 'reviews.timeline'].includes(operation) ? ['projectId', 'reviewId'] : null;
        if (!keys) fail('INVALID_REQUEST');
        const captured = closed(payload, keys);
        for (const key of keys) if (typeof captured[key] !== 'string' || !ID.test(captured[key])) fail('INVALID_REQUEST');
        authorize(session); value = await onRead(session.peer, operation, captured); authorize(session);
      } else value = route === '/api/app/writeState' ? commands.writeState(session, input) :
        route === '/api/app/command' ? await commands.execute(session, input) : commands.result(session, input);
      send(response, 200, {ok: true, data: value});
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response, 400, {ok: false,
        error: {code: publicCodes.has(error?.code) ? error.code : 'COMMAND_FAILED'}});
      else response.destroy();
    } finally { active--; }
  }
  return Object.freeze({
    async start(input) {
      const options = closed(input, ['address', 'port']);
      if (server || closing || isIP(options.address) !== 4 || options.address !== lease.identity?.address ||
          !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) fail('INVALID_REQUEST');
      address = options.address;
      server = lease.createServer((request, response) => {
        const task = receive(request, response); work.add(task); task.finally(() => work.delete(task));
      });
      server.headersTimeout = 5000; server.requestTimeout = 10000; server.maxHeadersCount = 32;
      server.on('connection', socket => {
        sockets.add(socket); socket.once('close', () => sockets.delete(socket));
        if (closing || sockets.size > LIMIT.connections) socket.destroy(); else socket.setTimeout(15000, () => socket.destroy());
      });
      server.on('secureConnection', socket => { secureSockets.add(socket); socket.once('close', () => secureSockets.delete(socket)); });
      server.on('clientError', (_error, socket) => socket.destroy());
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, address, () => { server.off('error', reject); port = server.address().port; resolve(); });
      });
      try { restore(); }
      catch (error) {
        closing = true; for (const session of sessions.values()) { try { retire(session, false); } catch {} }
        await new Promise(resolve => server.close(resolve)); throw error;
      }
      server.on('error', () => {
        closing = true; for (const session of sessions.values()) { try { retire(session, false); } catch {} } invitation = null;
      });
      return {address, port};
    },
    createInvitation() {
      if (!server?.listening || closing) fail('ACCESS_DENIED');
      const value = freshToken(), expiresAt = now() + 5 * 60 * 1000;
      invitation = {digest: digest(value), expiresAt, attempts: 0};
      return {invitation: value, expiresAt};
    },
    approve(input) {
      const {id, grants} = closed(input, ['id', 'grants']); retireExpired();
      const session = sessions.get(id);
      if (!session || !Array.isArray(grants) || !grants.length || grants.length > 1000 || closing) fail('INVALID_REQUEST');
      const dataset = store.peerReadDataset(), seen = new Set();
      const captured = grants.map(value => {
        const grant = closed(value, ['projectId', 'read', 'write', 'execute']);
        if (typeof grant.projectId !== 'string' || !ID.test(grant.projectId) || seen.has(grant.projectId) || grant.read !== true ||
            typeof grant.write !== 'boolean' || typeof grant.execute !== 'boolean') fail('INVALID_REQUEST');
        const project = dataset.projects.find(row => row.projectId === grant.projectId);
        if (!project) fail('NOT_FOUND'); seen.add(grant.projectId);
        return Object.freeze({...grant, birth: project.birth});
      });
      session.state = 'pending'; session.grants = []; session.epoch = '';
      try {
        onApprove(session.peer, Object.freeze(captured.map(({projectId, read, write, execute}) =>
          Object.freeze({projectId, read, write, execute}))));
        session.grants = captured; session.epoch = dataset.epoch; session.state = 'approved'; persist();
      } catch (error) { try { retire(session, false); } catch {} throw error; }
      return publicState(session);
    },
    revoke(input) {
      const {id} = closed(input, ['id']); if (typeof id !== 'string') fail('INVALID_REQUEST');
      const session = sessions.get(id); if (!session) return false; retire(session); return true;
    },
    state() {
      retireExpired(); return {running: Boolean(server?.listening && !closing), address: address || '', port: port || 0,
        sessions: [...sessions.values()].map(publicState)};
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; invitation = null;
      const cleanupErrors = [];
      for (const session of sessions.values()) { try { retire(session, false); } catch (error) { cleanupErrors.push(error); } }
      closePromise = new Promise((resolve, reject) => {
        const waits = [...sockets, ...secureSockets].map(socket => new Promise(done => {
          if (socket.closed) done(); else socket.once('close', done); socket.destroy();
        }));
        const closed = !server?.listening ? Promise.resolve() : new Promise((done, failed) => server.close(error => error ? failed(error) : done()));
        Promise.all([closed, ...waits, ...work]).then(() => {
          if (cleanupErrors.length) reject(new AggregateError(cleanupErrors, 'App approval cleanup failed.')); else resolve();
        }, reject);
      });
      return closePromise;
    }
  });
}

module.exports = {createRemoteAppListener};
