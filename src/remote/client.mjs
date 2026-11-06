const AUTH_LIMIT = 4096;
const READ_LIMIT = 1024 * 1024 + 1024;
const REQUEST_LIMIT = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATUS = new Set(['open', 'in_progress', 'in_review', 'resolved', 'recheck', 'closed']);
const PRIORITY = new Set(['low', 'normal', 'high', 'critical']);
const SERVER_CODES = new Set(['INVALID_REQUEST', 'AUTH_REQUIRED', 'AUTH_FAILED', 'PENDING_APPROVAL', 'ACCESS_DENIED', 'NOT_FOUND', 'QUERY_LIMIT_EXCEEDED', 'INVALID_QUERY', 'INVALID_SNAPSHOT', 'UNAVAILABLE', 'BUSY', 'STALE_SESSION', 'INTERNAL_ERROR']);
const encoder = new TextEncoder();
const fail = (code = 'INVALID_RESPONSE', message = 'The server returned an invalid response.') => { throw Object.assign(new Error(message), { code }); };
function closed(value, keys, code = 'INVALID_RESPONSE') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
  return value;
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || required && !value.trim()) fail();
}
function identifier(value, code = 'INVALID_RESPONSE') { if (typeof value !== 'string' || !ID.test(value)) fail(code); }
function date(value) { if (typeof value !== 'string' || !DATE.test(value) || !Number.isFinite(Date.parse(value))) fail(); }
function payloadFor(operation, value) {
  const keys = operation === 'projects.list' ? [] : operation === 'reviews.list' ? ['projectId'] : ['reviews.get','reviews.timeline'].includes(operation) ? ['projectId', 'reviewId'] : null;
  if (!keys) fail('INVALID_QUERY', 'Unsupported read operation.');
  closed(value, keys, 'INVALID_REQUEST');
  const captured = {};
  for (const key of keys) { identifier(value[key], 'INVALID_REQUEST'); captured[key] = value[key]; }
  return Object.freeze(captured);
}
function project(row) {
  closed(row, ['id', 'name', 'description', 'createdAt', 'updatedAt']);
  identifier(row.id); text(row.name, 120, true); text(row.description, 10000); date(row.createdAt); date(row.updatedAt);
}
function review(row, projectId) {
  closed(row, ['id', 'projectId', 'number', 'title', 'body', 'status', 'priority', 'category', 'createdAt', 'updatedAt']);
  identifier(row.id); identifier(row.projectId); identifier(row.category);
  if (row.projectId !== projectId || !Number.isSafeInteger(row.number) || row.number < 1 || !STATUS.has(row.status) || !PRIORITY.has(row.priority)) fail();
  text(row.title, 300, true); text(row.body, 100000); date(row.createdAt); date(row.updatedAt);
}
function uniqueRows(rows, validate) {
  if (!Array.isArray(rows) || rows.length > 100000) fail();
  const seen = new Set();
  for (const row of rows) { validate(row); if (seen.has(row.id)) fail(); seen.add(row.id); }
}
function readDTO(operation, payload, data) {
  if (operation === 'reviews.timeline') {
    closed(data,['version','projectId','reviewId','activities','attachments','agentRuns']);
    if(data.projectId!==payload.projectId||data.reviewId!==payload.reviewId)fail();
    const common=row=>{identifier(row.id);if(row.reviewId!==payload.reviewId)fail();date(row.createdAt);date(row.updatedAt);};
    uniqueRows(data.activities,row=>{
      closed(row,['id','reviewId','type','role','body','fromStatus','toStatus','createdAt','updatedAt']);common(row);
      if(!['comment','created','updated','status'].includes(row.type)||!['user','agent','system'].includes(row.role)||
        ![row.fromStatus,row.toStatus].every(value=>value===''||STATUS.has(value)))fail();text(row.body,100000);
    });
    uniqueRows(data.attachments,row=>{
      closed(row,['id','reviewId','activityId','name','mimeType','size','sha256','createdAt','updatedAt']);common(row);
      if(row.activityId!==null)identifier(row.activityId);text(row.name,255,true);text(row.mimeType,255);
      if(row.name==='.'||row.name==='..'||/[/\\]/.test(row.name)||!Number.isSafeInteger(row.size)||row.size<0||row.size>1024**3||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(row.sha256))fail();
    });
    uniqueRows(data.agentRuns,row=>{
      closed(row,['id','reviewId','status','response','startedAt','finishedAt','createdAt','updatedAt']);common(row);
      if(!['queued','running','completed','failed','cancelled','interrupted'].includes(row.status))fail();text(row.response,100000);date(row.startedAt);if(row.finishedAt!==null)date(row.finishedAt);
    });
    if([data.activities,data.attachments,data.agentRuns].some(rows=>rows.length>1000))fail();
  } else if (operation === 'projects.list') {
    closed(data, ['version', 'projects']); uniqueRows(data.projects, project);
  } else if (operation === 'reviews.list') {
    closed(data, ['version', 'projectId', 'reviews']);
    if (data.projectId !== payload.projectId) fail();
    uniqueRows(data.reviews, row => review(row, payload.projectId));
  } else {
    closed(data, ['version', 'projectId', 'review']);
    if (data.projectId !== payload.projectId) fail();
    review(data.review, payload.projectId); if (data.review.id !== payload.reviewId) fail();
  }
  if (data.version !== 1) fail();
  if (encoder.encode(JSON.stringify(data)).byteLength > 1024 * 1024) fail('RESPONSE_LIMIT', 'The response exceeds the read limit.');
  return data;
}
// Check duplicate decoded keys and nesting before JSON.parse constructs a DTO.
function strictJSON(source) {
  let at = 0;
  const skip = () => { while (/[\t\n\r ]/.test(source[at] || '\0')) at++; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === '"') { try { return JSON.parse(source.slice(start, at)); } catch { fail(); } }
      if (char === '\\') at++;
      else if (char.charCodeAt(0) < 32) fail();
    }
    fail();
  };
  const value = depth => {
    if (depth > 8) fail();
    skip(); const char = source[at];
    if (char === '"') { string(); return; }
    if (char === '{') {
      at++; skip(); const keys = new Set(); if (source[at] === '}') { at++; return; }
      while (true) {
        skip(); if (source[at] !== '"') fail(); const key = string();
        if (keys.has(key)) fail(); keys.add(key); skip(); if (source[at++] !== ':') fail(); value(depth + 1); skip();
        if (source[at] === '}') { at++; return; } if (source[at++] !== ',') fail();
      }
    }
    if (char === '[') {
      at++; skip(); if (source[at] === ']') { at++; return; }
      while (true) { value(depth + 1); skip(); if (source[at] === ']') { at++; return; } if (source[at++] !== ',') fail(); }
    }
    const start = at; while (at < source.length && !/[\t\n\r ,\]}]/.test(source[at])) at++;
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(source.slice(start, at))) fail();
  };
  value(0); skip(); if (at !== source.length) fail();
  try { return JSON.parse(source); } catch { fail(); }
}
async function body(response, limit, check) {
  let reader, primary;
  try {
    check();
    let count = 0, bytes = 0;
    for (const [key, value] of response.headers.entries()) { count++; bytes += encoder.encode(`${key}: ${value}\r\n`).byteLength; }
    if (count > 32 || bytes > 8192 || !/^application\/json\s*;\s*charset=utf-8$/i.test(response.headers.get('content-type') || '') || response.redirected) fail();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) > limit)) fail('RESPONSE_LIMIT', 'The response exceeds the read limit.');
    if (!response.body?.getReader) fail();
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true }); let source = '', total = 0;
    while (true) {
      const part = await reader.read(); check(); if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail(); total += part.value.byteLength;
      if (total > limit) fail('RESPONSE_LIMIT', 'The response exceeds the read limit.');
      source += decoder.decode(part.value, { stream: true });
    }
    source += decoder.decode(); check();
    return { value: strictJSON(source), bytes: total };
  } catch (error) {
    primary = error;
    try { if (reader) await reader.cancel(); else await response.body?.cancel?.(); }
    catch (cleanup) { primary = Object.assign(new AggregateError([primary, cleanup], 'The response could not be closed.', { cause: primary }), { code: 'RESPONSE_CLEANUP_FAILED' }); throw primary; }
    throw primary;
  } finally {
    try { reader?.releaseLock(); }
    catch (cleanup) { throw Object.assign(new AggregateError(primary ? [primary, cleanup] : [cleanup], 'The response lock could not be released.', { cause: primary || cleanup }), { code: 'RESPONSE_CLEANUP_FAILED' }); }
  }
}
export function createRemoteWebClient({ fetchImpl = globalThis.fetch, makeRequestId = () => globalThis.crypto.randomUUID(), now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function' || typeof makeRequestId !== 'function' || typeof now !== 'function') fail('INVALID_REQUEST');
  let generation = 0, active = null, preparing = false, logoutPending = null, loggingOut = false, session = null;
  const checkGeneration = original => { if (original !== generation) fail('ABORTED', 'The request was cancelled.'); };
  function call(path, fields, kind, operation, payload) {
    if (active || preparing || loggingOut && kind !== 'logout') fail('BUSY', 'Wait for the current request to finish.');
    const original = generation; let requestId, encoded;
    preparing = true;
    try {
      requestId = makeRequestId(); if (typeof requestId !== 'string' || !UUID.test(requestId)) fail('INVALID_REQUEST');
      encoded = JSON.stringify({ version: 1, requestId, ...fields });
      if (encoder.encode(encoded).byteLength > REQUEST_LIMIT) fail('INVALID_REQUEST');
      checkGeneration(original);
    } finally { preparing = false; }
    const controller = new AbortController(), owner = { controller, pending: null };
    owner.pending = Promise.resolve().then(async () => {
      checkGeneration(original);
      const response = await fetchImpl(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: encoded, signal: controller.signal });
      const result = await body(response, kind === 'read' && response.ok ? READ_LIMIT : AUTH_LIMIT, () => checkGeneration(original));
      checkGeneration(original);
      const envelope = result.value;
      if (!envelope || typeof envelope.ok !== 'boolean') fail();
      closed(envelope, envelope.ok ? ['version', 'requestId', 'ok', 'data'] : ['version', 'requestId', 'ok', 'error']);
      if (envelope.version !== 1 || envelope.requestId !== requestId) fail();
      if (!envelope.ok) {
        if (result.bytes > AUTH_LIMIT) fail('RESPONSE_LIMIT', 'The error response exceeds the limit.');
        closed(envelope.error, ['code', 'message']);
        if (!SERVER_CODES.has(envelope.error.code)) fail(); text(envelope.error.message, 1000, true);
        if (['AUTH_REQUIRED', 'AUTH_FAILED', 'ACCESS_DENIED', 'STALE_SESSION'].includes(envelope.error.code)) session = null;
        throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code });
      }
      if (!response.ok) fail();
      const data = envelope.data; let nextSession = session;
      if (kind === 'read') readDTO(operation, payload, data);
      else if (kind === 'logout') { closed(data, ['state']); if (data.state !== 'logged-out') fail(); nextSession = null; }
      else {
        closed(data, ['state', 'expiresAt']); date(data.expiresAt);
        if (!['pending', 'approved'].includes(data.state) || Date.parse(data.expiresAt) <= now()) fail();
        nextSession = { ...data };
      }
      checkGeneration(original); session = nextSession; return data;
    }).finally(() => { if (active === owner) active = null; });
    active = owner; return owner.pending;
  }
  return Object.freeze({
    login(input) {
      closed(input, ['invitationId', 'secret', 'clientName'], 'INVALID_REQUEST');
      if (typeof input.invitationId !== 'string' || !UUID.test(input.invitationId) || typeof input.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.secret) || typeof input.clientName !== 'string' || input.clientName.length > 80 || !input.clientName.trim() || /[\x00-\x1f\x7f]/.test(input.clientName)) fail('INVALID_REQUEST');
      return call('/web/v1/session', { action: 'login', invitationId: input.invitationId, secret: input.secret, clientName: input.clientName }, 'session');
    },
    status() { return call('/web/v1/session', { action: 'status' }, 'session'); },
    read(operation, value) {
      const payload = payloadFor(operation, value);
      if (session?.state !== 'approved' || Date.parse(session.expiresAt) <= now()) fail('AUTH_REQUIRED', 'Check browser approval before reading.');
      return call('/web/v1/read', { operation, payload }, 'read', operation, payload);
    },
    cancel() { generation++; active?.controller.abort(); },
    logout() {
      if (logoutPending) return logoutPending;
      if (preparing) fail('BUSY', 'Wait for the current request to finish.');
      generation++; loggingOut = true; session = null; const previous = active; previous?.controller.abort();
      logoutPending = Promise.resolve().then(async () => {
        await previous?.pending.catch(error => { if (error?.code === 'RESPONSE_CLEANUP_FAILED') throw error; });
        return call('/web/v1/logout', {}, 'logout');
      }).finally(() => { loggingOut = false; logoutPending = null; });
      return logoutPending;
    }
  });
}
