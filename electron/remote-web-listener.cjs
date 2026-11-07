'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const LIMITS = Object.freeze({
  assets: 64, assetBytes: 4 * 1024 * 1024, totalAssetBytes: 16 * 1024 * 1024,
  requestBytes: 8192, headerBytes: 8192, headers: 32, routeBytes: 256,
  dtoBytes: 1024 * 1024, responseBytes: 1024 * 1024 + 1024, errorBytes: 4096,
  connections: 16, requests: 32, pending: 8, sessions: 16,
  invitationMs: 5 * 60 * 1000, sessionMs: 15 * 60 * 1000, attempts: 5,
  socketMs: 15000, bodyMs: 5000
});
const MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Invalid web request.', AUTH_REQUIRED: 'Browser authentication is required.',
  AUTH_FAILED: 'Browser authentication failed.', PENDING_APPROVAL: 'Local approval is required.',
  ACCESS_DENIED: 'Web access is not allowed.', NOT_FOUND: 'Shared resource not found.',
  QUERY_LIMIT_EXCEEDED: 'The complete web response exceeds the query limit.',
  INVALID_QUERY: 'Invalid shared-data query.', INVALID_SNAPSHOT: 'Shared data is unavailable.',
  UNAVAILABLE: 'Web access is unavailable.', BUSY: 'Web access is busy.',
  STALE_SESSION: 'The browser session is no longer current.', INTERNAL_ERROR: 'The web request failed.'
});
const PUBLIC_CODES = Object.freeze({BROWSING_QUERY_LIMIT_EXCEEDED: 'QUERY_LIMIT_EXCEEDED',
  AUTHORITY_LIMIT_EXCEEDED: 'BUSY', STALE_EPOCH: 'STALE_SESSION', STALE_REVIEW: 'STALE_SESSION',
  PEER_READ_UNAVAILABLE: 'UNAVAILABLE',INVALID_ATTACHMENT_REQUEST:'INVALID_QUERY',
  ATTACHMENT_TOO_LARGE:'QUERY_LIMIT_EXCEEDED',ATTACHMENT_CHANGED:'INVALID_SNAPSHOT',ATTACHMENTS_UNAVAILABLE:'UNAVAILABLE',
  ENOENT:'NOT_FOUND',ELOOP:'NOT_FOUND',EACCES:'UNAVAILABLE',EPERM:'UNAVAILABLE'});
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ATTACHMENT_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MIME = new Set(['text/html; charset=utf-8', 'application/javascript; charset=utf-8',
  'text/css; charset=utf-8', 'application/json; charset=utf-8', 'image/svg+xml', 'image/png', 'font/woff2']);
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'"
});

function fail(code) { throw Object.assign(new Error(MESSAGES[code]), {code}); }
function data(object, key) {
  if (!object || typeof object !== 'object') fail('INVALID_REQUEST');
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_REQUEST');
  return descriptor.value;
}
function closed(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(object))) fail('INVALID_REQUEST');
  const actual = Reflect.ownKeys(object);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail('INVALID_REQUEST');
  for (const key of keys) data(object, key);
  return object;
}
function handle(value) { return value !== null && (typeof value === 'object' || typeof value === 'function'); }
const token = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value, 'ascii').digest();
const sameDigest = (first, second) => crypto.timingSafeEqual(first, second);

// Requests have only primitive fields and nested exact payload objects, never arrays.
// This finite grammar rejects duplicate keys before any object can hide them.
function parseRequest(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { fail('INVALID_REQUEST'); }
  let index = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[index] || '\0')) index++; };
  function string() {
    const start = index++;
    while (index < text.length) {
      const character = text[index++];
      if (character === '\\') { index++; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, index)); } catch { fail('INVALID_REQUEST'); }
      }
    }
    fail('INVALID_REQUEST');
  }
  function value(depth) {
    if (depth > 4) fail('INVALID_REQUEST');
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === '{') {
      index++; whitespace(); const result = Object.create(null), seen = new Set();
      if (text[index] === '}') { index++; return result; }
      while (index < text.length) {
        whitespace(); if (text[index] !== '"') fail('INVALID_REQUEST');
        const key = string();
        if (seen.has(key) || seen.size >= 16) fail('INVALID_REQUEST');
        seen.add(key); whitespace(); if (text[index++] !== ':') fail('INVALID_REQUEST');
        Object.defineProperty(result, key, {value: value(depth + 1), enumerable: true});
        whitespace(); const delimiter = text[index++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') fail('INVALID_REQUEST');
      }
      fail('INVALID_REQUEST');
    }
    const match = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index));
    if (!match) fail('INVALID_REQUEST');
    index += match[0].length;
    try { return JSON.parse(match[0]); } catch { fail('INVALID_REQUEST'); }
  }
  const result = value(0); whitespace();
  if (index !== text.length) fail('INVALID_REQUEST');
  return result;
}

function captureAssets(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(input))) fail('INVALID_REQUEST');
  const names = Reflect.ownKeys(input), assets = new Map(); let total = 0;
  if (!names.length || names.length > LIMITS.assets) fail('INVALID_REQUEST');
  for (const name of names) {
    if (typeof name !== 'string' || name !== '/' &&
        (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(name) || name.split('/').some(part => part === '.' || part === '..')))
      fail('INVALID_REQUEST');
    const item = closed(data(input, name), ['bytes', 'mimeType']);
    const bytes = data(item, 'bytes'), mimeType = data(item, 'mimeType');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.assetBytes || !MIME.has(mimeType)) fail('INVALID_REQUEST');
    total += bytes.length; if (total > LIMITS.totalAssetBytes) fail('INVALID_REQUEST');
    assets.set(name, {bytes: Buffer.from(bytes), mimeType});
  }
  if (assets.get('/')?.mimeType !== 'text/html; charset=utf-8') fail('INVALID_REQUEST');
  return assets;
}

function captureRead(input) {
  closed(input, ['version', 'requestId', 'operation', 'payload']);
  if (input.version !== 1 || typeof input.requestId !== 'string' || !ID.test(input.requestId)) fail('INVALID_REQUEST');
  const keys = input.operation === 'projects.list' ? [] : input.operation === 'reviews.list' ? ['projectId'] :
    ['reviews.get','reviews.timeline'].includes(input.operation) ? ['projectId', 'reviewId'] :
      input.operation==='attachments.read'?['projectId','reviewId','attachmentId','offset']:null;
  if (!keys) fail('INVALID_QUERY');
  closed(input.payload, keys);
  const payload = Object.create(null);
  for (const key of keys) {
    if(key==='offset'){
      if(!Number.isSafeInteger(input.payload[key])||input.payload[key]<0||input.payload[key]>ATTACHMENT_BYTES||Object.is(input.payload[key],-0))fail('INVALID_QUERY');
    }else if (typeof input.payload[key] !== 'string' || !ID.test(input.payload[key])) fail('INVALID_QUERY');
    payload[key] = input.payload[key];
  }
  return Object.freeze({operation: input.operation, payload: Object.freeze(payload)});
}

// Count complete JSON without first allocating its encoded representation.
function jsonStringBytes(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}
function copyReadDTO(operation, payload, input) {
  let bytes = 0;
  const charge = amount => { bytes += amount; if (bytes > LIMITS.dtoBytes) fail('QUERY_LIMIT_EXCEEDED'); };
  const primitive = value => { charge(typeof value === 'string' ? jsonStringBytes(value) : String(value).length); return value; };
  function object(row, fields) {
    try { closed(row, fields.map(([key]) => key)); } catch { fail('INVALID_SNAPSHOT'); }
    const result = {}; charge(2);
    fields.forEach(([key, validate], index) => {
      if (index) charge(1); charge(jsonStringBytes(key) + 1);
      const value = data(row, key); if (!validate(value)) fail('INVALID_SNAPSHOT');
      result[key] = primitive(value);
    });
    return result;
  }
  const text = (max, required = false) => value => typeof value === 'string' && value.length <= max &&
    !value.includes('\0') && (!required || Boolean(value.trim()));
  const id = value => typeof value === 'string' && ID.test(value);
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
  const projectFields = [['id', id], ['name', text(120, true)], ['description', text(10000)], ['createdAt', date], ['updatedAt', date]];
  const reviewFields = [['id', id], ['projectId', value => value === payload.projectId],
    ['number', value => Number.isSafeInteger(value) && value > 0], ['title', text(300, true)], ['body', text(100000)],
    ['status', value => ['open', 'in_progress', 'in_review', 'resolved', 'recheck', 'closed'].includes(value)],
    ['priority', value => ['low', 'normal', 'high', 'critical'].includes(value)], ['category', id], ['createdAt', date], ['updatedAt', date]];
  if(operation==='attachments.read'){
    try{closed(input,['version','attachment','offset','nextOffset','data','complete']);}catch{fail('INVALID_SNAPSHOT');}
    if(input.version!==1||input.offset!==payload.offset||!Number.isSafeInteger(input.offset)||input.offset<0||
      !Number.isSafeInteger(input.nextOffset)||typeof input.complete!=='boolean'||typeof input.data!=='string'||
      input.data.length>Math.ceil(CHUNK_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data))fail('INVALID_SNAPSHOT');
    const attachment=object(data(input,'attachment'),[
      ['id',value=>id(value)&&value===payload.attachmentId],['reviewId',value=>value===payload.reviewId],['activityId',value=>value===null||id(value)],
      ['name',value=>text(255,true)(value)&&value!=='.'&&value!=='..'&&!/[\x00-\x1f\x7f/\\]/.test(value)],
      ['mimeType',value=>text(255)(value)&&!/[\x00-\x1f\x7f]/.test(value)],
      ['size',value=>Number.isSafeInteger(value)&&value>=0&&value<=ATTACHMENT_BYTES],
      ['sha256',value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)],['createdAt',date]
    ]);
    const decoded=Buffer.from(input.data,'base64');
    if(decoded.length>CHUNK_BYTES||decoded.toString('base64')!==input.data||input.offset>attachment.size||
      input.nextOffset!==input.offset+decoded.length||input.nextOffset>attachment.size||
      input.complete!==(input.nextOffset===attachment.size)||(!input.complete&&!decoded.length))fail('INVALID_SNAPSHOT');
    const result={version:1,attachment,offset:input.offset,nextOffset:input.nextOffset,data:input.data,complete:input.complete};
    charge(Buffer.byteLength(JSON.stringify({...result,attachment:null})));
    return result;
  }
  if (operation === 'reviews.timeline') {
    try { closed(input, ['version','projectId','reviewId','activities','attachments','agentRuns']); } catch { fail('INVALID_SNAPSHOT'); }
    if (input.version !== 1 || input.projectId !== payload.projectId || input.reviewId !== payload.reviewId) fail('INVALID_SNAPSHOT');
    const result = {version: 1, projectId: payload.projectId, reviewId: payload.reviewId};
    charge(Buffer.byteLength(JSON.stringify({...result,activities:[],attachments:[],agentRuns:[]})));
    const common = [['id',id],['reviewId',value=>value===payload.reviewId]];
    const dates = [['createdAt',date],['updatedAt',date]];
    const schemas = {
      activities: [...common,['type',value=>['comment','created','updated','status'].includes(value)],['role',value=>['user','agent','system'].includes(value)],['body',text(100000)],['fromStatus',value=>value===''||['open','in_progress','in_review','resolved','recheck','closed'].includes(value)],['toStatus',value=>value===''||['open','in_progress','in_review','resolved','recheck','closed'].includes(value)],...dates],
      attachments: [...common,['activityId',value=>value===null||id(value)],['name',value=>text(255,true)(value)&&value!=='.'&&value!=='..'&&!/[/\\]/.test(value)],['mimeType',text(255)],['size',value=>Number.isSafeInteger(value)&&value>=0&&value<=1024**3],['sha256',value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)],...dates],
      agentRuns: [...common,['status',value=>['queued','running','completed','failed','cancelled','interrupted'].includes(value)],['response',text(100000)],['startedAt',date],['finishedAt',value=>value===null||date(value)],...dates]
    };
    for (const [name,schema] of Object.entries(schemas)) {
      const rows=data(input,name),seen=new Set();
      if(!Array.isArray(rows)||rows.length>1000)fail('INVALID_SNAPSHOT');
      result[name]=rows.map((row,index)=>{if(index)charge(1);const item=object(row,schema);if(seen.has(item.id))fail('INVALID_SNAPSHOT');seen.add(item.id);return item;});
    }
    return result;
  }
  const keys = operation === 'projects.list' ? ['version', 'projects'] : operation === 'reviews.list' ?
    ['version', 'projectId', 'reviews'] : ['version', 'projectId', 'review'];
  try { closed(input, keys); } catch { fail('INVALID_SNAPSHOT'); }
  if (data(input, 'version') !== 1 || operation !== 'projects.list' && data(input, 'projectId') !== payload.projectId) fail('INVALID_SNAPSHOT');
  const result = {version: 1}; charge(1 + jsonStringBytes('version') + 1 + 1);
  if (operation !== 'projects.list') { charge(1 + jsonStringBytes('projectId') + 1); result.projectId = primitive(payload.projectId); }
  const name = operation === 'projects.list' ? 'projects' : operation === 'reviews.list' ? 'reviews' : 'review';
  charge(1 + jsonStringBytes(name) + 1);
  if (name === 'review') {
    result.review = object(data(input, name), reviewFields);
    if (result.review.id !== payload.reviewId) fail('INVALID_SNAPSHOT');
  } else {
    const rows = data(input, name), ids = new Set();
    if (!Array.isArray(rows) || rows.length > 100000) fail('INVALID_SNAPSHOT');
    charge(2); const copied = [];
    for (let index = 0; index < rows.length; index++) {
      if (index) charge(1);
      const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_SNAPSHOT');
      const item = object(descriptor.value, name === 'projects' ? projectFields : reviewFields);
      if (ids.has(item.id)) fail('INVALID_SNAPSHOT'); ids.add(item.id); copied.push(item);
    }
    result[name] = copied;
  }
  charge(1); return result;
}

function createWebReadListener(options) {
  closed(options, ['tlsLease', 'assets', 'onPendingBrowser', 'onRead', 'onClosed']);
  const lease = closed(options.tlsLease, ['identity', 'createServer', 'release']);
  const createServer = data(lease, 'createServer'), release = data(lease, 'release');
  const certificateAddress = data(data(lease, 'identity'), 'address');
  const onPendingBrowser = options.onPendingBrowser, onRead = options.onRead, onClosed = options.onClosed;
  if ([createServer, release, onPendingBrowser, onRead, onClosed].some(value => typeof value !== 'function')) fail('INVALID_REQUEST');
  const assets = captureAssets(options.assets), rawSockets = new Set(), sockets = new Map(), socketClosures = new Set(), sessions = new Map(), pendingHandles = new WeakMap();
  const active = new Set(), cleanups = new Set();
  let server = null, accepting = false, attempted = false, admissionStopped = false, endpoint = null, invitation = null;
  let closing = null, released = false, cleanupFailure = null, serverFailure = null, sweeper = null, listeningConfirmed = false;
  let creationPending = null, listenOutcome = null;

  const now = () => Date.now();
  function current(session) {
    return accepting && session && sessions.get(session.cookieHash) === session && !session.retired && session.expires > now();
  }
  function trackCleanup(session, reason, finishingSocket = null) {
    if (session.retired) return;
    session.retired = true; session.version++;
    if (sessions.get(session.cookieHash) === session) sessions.delete(session.cookieHash);
    for (const job of active) if (job.session === session) job.cancelled = true;
    for (const [socket, owner] of sockets) if (owner.session === session && socket !== finishingSocket) socket.destroy();
    const observation = Object.freeze({connectionId: session.id, pendingId: session.pendingId, reason,
      pendingHandle: session.handle, authorityHandle: session.authority});
    const cleanup = Promise.resolve().then(() => onClosed(observation));
    cleanups.add(cleanup);
    cleanup.catch(error => { cleanupFailure ||= error; accepting = false; }).finally(() => cleanups.delete(cleanup));
  }
  function prune() {
    if (invitation && invitation.expires <= now()) invitation = null;
    for (const session of sessions.values()) if (session.expires <= now()) trackCleanup(session, 'expired');
  }
  function authorized(job, session, approved = false) {
    if (!accepting || job.cancelled || !current(session)) fail('STALE_SESSION');
    if (approved && !session.authority) fail('PENDING_APPROVAL');
  }
  function headers(response, contentType, length, extra = {}) {
    response.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': contentType, 'Content-Length': length, ...extra});
  }
  function reply(job, requestId, dataValue, extra) {
    if (job.cancelled || job.response.destroyed) return;
    const bytes = Buffer.from(JSON.stringify({version: 1, requestId, ok: true, data: dataValue}), 'utf8');
    if (bytes.length > LIMITS.responseBytes) fail('QUERY_LIMIT_EXCEEDED');
    if (job.session) authorized(job, job.session);
    headers(job.response, 'application/json; charset=utf-8', bytes.length, extra);
    job.response.end(bytes);
  }
  function errorReply(job, requestId, error) {
    if (job.cancelled || job.response.destroyed || job.response.headersSent) return;
    let code = 'INTERNAL_ERROR';
    try {
      if (Object.hasOwn(MESSAGES, error?.code)) code = error.code;
      else if (Object.hasOwn(PUBLIC_CODES, error?.code)) code = PUBLIC_CODES[error.code];
    } catch { /* Fixed public fallback. */ }
    const bytes = Buffer.from(JSON.stringify({version: 1, requestId, ok: false, error: {code, message: MESSAGES[code]}}), 'utf8');
    if (bytes.length > LIMITS.errorBytes) return job.response.destroy();
    job.response.writeHead(code === 'AUTH_REQUIRED' ? 401 : code === 'BUSY' ? 429 : 400,
      {...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Connection': 'close'});
    job.response.end(bytes);
  }
  function cookie(session) {
    return `${endpoint.cookieName}=${session.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor((session.expires - now()) / 1000))}`;
  }
  function sessionFor(request, job) {
    const raw = request.headers.cookie || '';
    if (typeof raw !== 'string' || raw.length > 4096) fail('AUTH_REQUIRED');
    const found = raw.split(';').map(value => value.trim()).filter(value => value.startsWith(endpoint.cookieName + '='));
    if (found.length !== 1) fail('AUTH_REQUIRED');
    const value = found[0].slice(endpoint.cookieName.length + 1);
    if (!TOKEN.test(value)) fail('AUTH_REQUIRED');
    const session = sessions.get(digest(value).toString('hex'));
    if (!current(session)) fail('AUTH_REQUIRED');
    const socketOwner = sockets.get(request.socket);
    if (!socketOwner || socketOwner.session && socketOwner.session !== session) fail('AUTH_REQUIRED');
    socketOwner.session = session; job.session = session;
    return session;
  }
  function requestHeaders(request) {
    const raw = request.rawHeaders;
    if (!Array.isArray(raw) || raw.length % 2 || raw.length / 2 > LIMITS.headers) fail('INVALID_REQUEST');
    let bytes = 2; const names = new Set();
    for (let index = 0; index < raw.length; index += 2) {
      const name = raw[index].toLowerCase(), value = raw[index + 1];
      bytes += Buffer.byteLength(raw[index]) + Buffer.byteLength(value) + 4;
      if (names.has(name) || bytes > LIMITS.headerBytes) fail('INVALID_REQUEST'); names.add(name);
    }
    if (!request.socket.encrypted || !sockets.has(request.socket) || request.httpVersion !== '1.1' || request.headers.host !== endpoint.host ||
        typeof request.url !== 'string' || Buffer.byteLength(request.url) > LIMITS.routeBytes || request.url.includes('?') ||
        request.headers.expect !== undefined || request.headers.upgrade !== undefined) fail('INVALID_REQUEST');
    if (request.method === 'POST') {
      if (request.headers.origin !== endpoint.origin || request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin' ||
          request.headers['transfer-encoding'] !== undefined || request.headers['content-encoding'] !== undefined ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '') ||
          !/^(?:0|[1-9][0-9]{0,4})$/.test(request.headers['content-length'] || '') ||
          Number(request.headers['content-length']) > LIMITS.requestBytes) fail('INVALID_REQUEST');
    }
  }
  async function body(request, job) {
    const expected = Number(request.headers['content-length']), chunks = []; let received = 0;
    const timer = setTimeout(() => { job.cancelled = true; request.socket.destroy(); }, LIMITS.bodyMs); timer.unref?.();
    try {
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) fail('INVALID_REQUEST');
        received += chunk.length;
        if (received > expected || received > LIMITS.requestBytes || job.cancelled) fail('INVALID_REQUEST');
        chunks.push(Buffer.from(chunk));
      }
      if (received !== expected || job.cancelled) fail('INVALID_REQUEST');
      return parseRequest(Buffer.concat(chunks, received));
    } finally { clearTimeout(timer); }
  }
  async function perform(request, response, job) {
    let requestId = '';
    try {
      prune(); if (!accepting) fail('UNAVAILABLE'); requestHeaders(request);
      if (request.method === 'GET') {
        if (request.headers['content-length'] !== undefined || request.headers['transfer-encoding'] !== undefined) fail('INVALID_REQUEST');
        const asset = assets.get(request.url); if (!asset) fail('NOT_FOUND');
        headers(response, asset.mimeType, asset.bytes.length); response.end(asset.bytes); return;
      }
      if (request.method !== 'POST' || !['/web/v1/session', '/web/v1/read', '/web/v1/logout'].includes(request.url)) fail('NOT_FOUND');
      const input = await body(request, job);
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST');
      if (typeof input?.requestId === 'string' && ID.test(input.requestId)) requestId = input.requestId;
      if (input.version !== 1 || !requestId) fail('INVALID_REQUEST');
      if (!accepting || job.cancelled) fail('UNAVAILABLE');
      if (request.url === '/web/v1/session' && input.action === 'login') {
        closed(input, ['version', 'requestId', 'action', 'invitationId', 'secret', 'clientName']);
        if (typeof input.invitationId !== 'string' || !UUID.test(input.invitationId) || typeof input.secret !== 'string' || !TOKEN.test(input.secret) ||
            typeof input.clientName !== 'string' || !input.clientName.trim() || input.clientName.length > 80 || /[\x00-\x1f\x7f]/.test(input.clientName)) fail('INVALID_REQUEST');
        const originalInvitation = invitation;
        if (!originalInvitation || originalInvitation.expires <= now() || originalInvitation.attempts >= LIMITS.attempts) fail('AUTH_FAILED');
        originalInvitation.attempts++;
        if (input.invitationId !== originalInvitation.id || !sameDigest(originalInvitation.secretHash, digest(input.secret))) fail('AUTH_FAILED');
        if (sessions.size >= LIMITS.sessions || [...sessions.values()].filter(item => !item.authority).length >= LIMITS.pending) fail('BUSY');
        invitation = null;
        const socketOwner = sockets.get(request.socket); if (!socketOwner || socketOwner.session) fail('AUTH_FAILED');
        const rawToken = token(), pendingHandle = Object.freeze(Object.create(null));
        const session = {id: crypto.randomUUID(), pendingId: crypto.randomUUID(), handle: pendingHandle,
          token: rawToken, cookieHash: digest(rawToken).toString('hex'), clientName: input.clientName,
          created: now(), expires: now() + LIMITS.invitationMs, authority: null, retired: false, busy: false, version: 0};
        sessions.set(session.cookieHash, session); pendingHandles.set(pendingHandle, session);
        socketOwner.session = session; job.session = session;
        try {
          await onPendingBrowser(Object.freeze({pendingId: session.pendingId, pendingHandle, clientName: session.clientName,
            createdAt: new Date(session.created).toISOString(), expiresAt: new Date(session.expires).toISOString()}));
          authorized(job, session);
          reply(job, requestId, {state: session.authority ? 'approved' : 'pending', expiresAt: new Date(session.expires).toISOString()}, {'Set-Cookie': cookie(session)});
        } catch (error) { trackCleanup(session, 'login-failed'); throw error; }
        return;
      }
      const session = sessionFor(request, job);
      if (request.url === '/web/v1/session') {
        closed(input, ['version', 'requestId', 'action']); if (input.action !== 'status') fail('INVALID_REQUEST');
        authorized(job, session);
        reply(job, requestId, {state: session.authority ? 'approved' : 'pending', expiresAt: new Date(session.expires).toISOString()}, {'Set-Cookie': cookie(session)});
      } else if (request.url === '/web/v1/logout') {
        closed(input, ['version', 'requestId']);
        // Send the closed acknowledgement before retiring this original socket/session.
        reply(job, requestId, {state: 'logged-out'}, {'Set-Cookie': `${endpoint.cookieName}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, 'Connection': 'close'});
        trackCleanup(session, 'logout', request.socket);
      } else {
        const captured = captureRead(input); authorized(job, session, true);
        if (session.busy) fail('BUSY'); session.busy = true;
        const authority = session.authority, version = session.version;
        try {
          const returned = await onRead(authority, captured.operation, captured.payload);
          authorized(job, session, true);
          if (session.authority !== authority || session.version !== version) fail('STALE_SESSION');
          const dto = copyReadDTO(captured.operation, captured.payload, returned);
          authorized(job, session, true);
          reply(job, requestId, dto);
        } finally { session.busy = false; }
      }
    } catch (error) { errorReply(job, requestId, error); }
  }
  function onRequest(request, response) {
    const job = {request, response, session: null, cancelled: false, pending: null};
    if (!accepting || active.size >= LIMITS.requests) { errorReply(job, '', {code: accepting ? 'BUSY' : 'UNAVAILABLE'}); return; }
    const aborted = () => { job.cancelled = true; };
    const responseClosed = () => { if (!response.writableFinished) job.cancelled = true; };
    request.once('aborted', aborted); response.once('close', responseClosed);
    active.add(job);
    job.pending = perform(request, response, job).finally(() => {
      active.delete(job); request.removeListener('aborted', aborted); response.removeListener('close', responseClosed);
    });
    // All request failures are handled with fixed messages; retain the original pending operation for drain.
    job.pending.catch(() => { cleanupFailure ||= new Error('Unconfirmed web request completion.'); accepting = false; });
  }

  function stopAdmission() {
    accepting = false; admissionStopped = true; invitation = null;
    for (const job of active) job.cancelled = true;
    for (const session of sessions.values()) trackCleanup(session, 'disabled');
  }
  function state() {
    prune();
    return Object.freeze({state: released ? 'closed' : cleanupFailure ? 'unconfirmed' : accepting ? 'listening' : closing ? 'closing' : serverFailure ? 'error' : 'stopped',
      endpoint: endpoint ? Object.freeze({address: endpoint.address, port: endpoint.port, url: endpoint.origin + '/'}) : null,
      pending: Object.freeze([...sessions.values()].filter(item => !item.authority).map(item => Object.freeze({pendingId: item.pendingId,
        clientName: item.clientName, createdAt: new Date(item.created).toISOString(), expiresAt: new Date(item.expires).toISOString()}))),
      connections: Object.freeze([...sessions.values()].map(item => Object.freeze({connectionId: item.id, pendingId: item.pendingId,
        clientName: item.clientName, approved: Boolean(item.authority), expiresAt: new Date(item.expires).toISOString()})))});
  }
  return Object.freeze({
    async listen(input) {
      closed(input, ['address', 'port']);
      const address = data(input, 'address'), port = data(input, 'port');
      if (attempted || admissionStopped || closing || released || typeof address !== 'string' || net.isIP(address) !== 4 || address !== certificateAddress ||
          ['0.0.0.0', '255.255.255.255'].includes(address) || Number(address.split('.')[0]) >= 224 ||
          !Number.isInteger(port) || port < 1 || port > 65535) fail('INVALID_REQUEST');
      attempted = true;
      let created;
      creationPending = new Promise(resolve => { created = resolve; });
      try { server = Reflect.apply(createServer, lease, [onRequest]); }
      finally { created(); }
      if (!server || ['on', 'once', 'prependListener', 'removeListener', 'listen', 'close', 'address'].some(key => typeof server[key] !== 'function')) fail('UNAVAILABLE');
      if (admissionStopped || closing || released) fail('UNAVAILABLE');
      // Keep every parsed header visible so the explicit count check cannot be
      // bypassed by silent truncation. The lease must set maxHeaderSize=8192.
      server.maxHeadersCount = 0; server.headersTimeout = LIMITS.bodyMs;
      server.requestTimeout = LIMITS.bodyMs; server.keepAliveTimeout = LIMITS.socketMs;
      server.on('connection', socket => {
        let observedClose;
        const originalClose = new Promise(resolve => { observedClose = resolve; });
        socketClosures.add(originalClose);
        socket.once('close', () => {
          rawSockets.delete(socket);
          socketClosures.delete(originalClose); observedClose();
        });
        if (rawSockets.size >= LIMITS.connections || closing || admissionStopped) return socket.destroy();
        rawSockets.add(socket);
        socket.setTimeout(LIMITS.socketMs, () => socket.destroy());
      });
      // HTTPS requests address the original TLSSocket, not its raw TCP wrapper.
      // The server's own event is the binding; never infer it from an address or
      // use a private parent-socket property to adopt an unregistered request.
      server.prependListener('secureConnection', socket => {
        let observedClose;
        const originalClose = new Promise(resolve => { observedClose = resolve; });
        socketClosures.add(originalClose);
        const owner = {id: crypto.randomUUID(), session: null};
        socket.once('close', () => {
          if (sockets.get(socket) === owner) sockets.delete(socket);
          socketClosures.delete(originalClose); observedClose();
        });
        if (!socket.encrypted || socket.destroyed || sockets.size >= LIMITS.connections || closing || admissionStopped)
          return socket.destroy();
        sockets.set(socket, owner);
      });
      server.on('clientError', (_error, socket) => socket.destroy());
      server.on('upgrade', (_request, socket) => socket.destroy());
      server.on('connect', (_request, socket) => socket.destroy());
      server.on('checkContinue', onRequest);
      server.on('error', error => {
        serverFailure ||= error;
        if (listeningConfirmed) { cleanupFailure ||= error; stopAdmission(); }
      });
      const originalListen = new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { listeningConfirmed = true; server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        try { server.listen({host: address, port}); } catch (error) { failed(error); }
      });
      listenOutcome = originalListen.then(() => null, error => error);
      await originalListen;
      if (admissionStopped || closing || released || serverFailure) fail('UNAVAILABLE');
      const bound = server.address();
      if (!bound || typeof bound !== 'object' || bound.address !== address || bound.port !== port) fail('UNAVAILABLE');
      const url = new URL(`https://${bound.address}:${bound.port}`);
      endpoint = Object.freeze({address: bound.address, port: bound.port, host: url.host, origin: url.origin,
        cookieName: '__Host-reviewops-web-' + bound.port});
      accepting = true; sweeper = setInterval(prune, 1000); sweeper.unref?.();
      return state();
    },
    inviteBrowser() {
      if (arguments.length || !accepting) fail('UNAVAILABLE'); prune();
      const secret = token(); invitation = {id: crypto.randomUUID(), secretHash: digest(secret), expires: now() + LIMITS.invitationMs, attempts: 0};
      return Object.freeze({invitationId: invitation.id, secret, expiresAt: new Date(invitation.expires).toISOString()});
    },
    approveBrowser(pendingHandle, authorityHandle) {
      if (arguments.length !== 2 || !handle(authorityHandle)) fail('INVALID_REQUEST');
      const session = pendingHandles.get(pendingHandle);
      if (!current(session) || session.authority) fail('STALE_SESSION');
      session.authority = authorityHandle; session.version++; session.expires = now() + LIMITS.sessionMs;
    },
    revoke(authorityHandle) {
      if (arguments.length !== 1 || !handle(authorityHandle)) fail('INVALID_REQUEST');
      for (const session of sessions.values()) if (session.authority === authorityHandle) trackCleanup(session, 'revoked');
    },
    disconnect(pendingHandle) {
      if (arguments.length !== 1 || !handle(pendingHandle)) fail('INVALID_REQUEST');
      const session = pendingHandles.get(pendingHandle); if (session && !session.retired) trackCleanup(session, 'disconnected');
    },
    stopAdmission() {
      if (arguments.length) fail('INVALID_REQUEST'); stopAdmission();
    },
    closeAndDrain() {
      if (arguments.length) fail('INVALID_REQUEST');
      if (closing) return closing;
      stopAdmission(); clearInterval(sweeper);
      closing = (async () => {
        // A reentrant close cannot release a lease underneath its same original
        // factory/listen attempt, even when no socket is listening yet.
        if (creationPending) await creationPending;
        if (listenOutcome) await listenOutcome;
        const closed = server ? new Promise(resolve => {
          try { server.close(error => resolve({error})); } catch (error) { resolve({error}); }
        }) : Promise.resolve({error: null});
        for (const socket of new Set([...rawSockets, ...sockets.keys()])) socket.destroy();
        await Promise.allSettled([...active].map(job => job.pending));
        await Promise.allSettled([...cleanups]);
        const closedOutcome = await closed;
        if (closedOutcome.error && !(closedOutcome.error.code === 'ERR_SERVER_NOT_RUNNING' && !listeningConfirmed && !rawSockets.size && !sockets.size))
          throw closedOutcome.error;
        // The server callback can precede the close events of its original
        // sockets. Await each observed original, including a rejected socket.
        await Promise.all([...socketClosures]);
        if (cleanupFailure || active.size || cleanups.size || rawSockets.size || sockets.size || socketClosures.size) fail('UNAVAILABLE');
        await Reflect.apply(release, lease, []); released = true;
      })();
      return closing;
    },
    state() {
      if (arguments.length) fail('INVALID_REQUEST'); return state();
    }
  });
}

module.exports = {createWebReadListener,copyReadDTO};
