'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash}=require('node:crypto');
const load = () => import('../src/remote/client.mjs');
const DATE = '2099-01-01T00:00:00.000Z';
const STAMP = '2026-11-06T00:00:00.000Z';
const UUID = '12345678-1234-4123-8123-123456789abc';
const LOGIN = { invitationId: UUID, secret: 'a'.repeat(43), clientName: 'Owned browser' };
const mime = { 'Content-Type': 'application/json; charset=utf-8' };
const encoder = new TextEncoder();
const request = init => JSON.parse(init.body);
const ok = (init, data) => JSON.stringify({ version: 1, requestId: request(init).requestId, ok: true, data });
const response = (init, data) => new Response(ok(init, data), { headers: mime });
const project = id => ({ id, name: 'Project ' + id, description: '<script>not executable</script>', createdAt: STAMP, updatedAt: STAMP });
const review = id => ({ id, projectId: 'project-a', number: 1, title: 'Review', body: '', status: 'open', priority: 'normal', category: 'ux', createdAt: STAMP, updatedAt: STAMP });
const code = expected => error => error?.code === expected;
async function approved(fetchRead, options = {}) {
  const { createRemoteWebClient } = await load();
  const calls = [];
  const client = createRemoteWebClient({ makeRequestId: () => UUID, ...options, fetchImpl: async (path, init) => {
    calls.push({ path, init });
    if (path === '/web/v1/session') return response(init, { state: 'approved', expiresAt: DATE });
    return fetchRead(path, init);
  } });
  await client.status(); return { client, calls };
}
const attachmentMeta=bytes=>({id:'file-a',reviewId:'review-a',activityId:null,name:'download.bin',mimeType:'application/octet-stream',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:STAMP});
const attachmentPayload={projectId:'project-a',reviewId:'review-a',attachmentId:'file-a'};
const attachmentChunk=(bytes,offset,meta=attachmentMeta(bytes))=>{const data=bytes.subarray(offset,offset+65536);return{version:1,attachment:{...meta},offset,nextOffset:offset+data.length,data:data.toString('base64'),complete:offset+data.length===bytes.length};};

test('attachment download owns sequential bounded reads and verifies complete binary SHA256',async()=>{
  const bytes=Buffer.alloc(65541);for(let index=0;index<bytes.length;index++)bytes[index]=index%256;
  const offsets=[];
  const {client}=await approved(async(_path,init)=>{const query=request(init);assert.equal(query.operation,'attachments.read');offsets.push(query.payload.offset);return response(init,attachmentChunk(bytes,query.payload.offset));});
  const result=await client.downloadAttachment(attachmentPayload);
  assert.deepEqual(offsets,[0,65536]);assert.deepEqual(Buffer.from(result.bytes),bytes);assert.deepEqual(result.attachment,attachmentMeta(bytes));
  result.bytes.fill(0);
});
test('empty attachment has one verified complete chunk without an extra EOF request',async()=>{
  let reads=0;const bytes=Buffer.alloc(0),{client}=await approved(async(_path,init)=>{reads++;return response(init,attachmentChunk(bytes,0));});
  const result=await client.downloadAttachment(attachmentPayload);assert.equal(result.bytes.length,0);assert.equal(reads,1);
});
test('exact 10MiB attachment is complete in 160 bounded requests',async()=>{
  const bytes=Buffer.alloc(10*1024*1024,0x9b),meta=attachmentMeta(bytes);let reads=0;
  const {client}=await approved(async(_path,init)=>{reads++;return response(init,attachmentChunk(bytes,request(init).payload.offset,meta));});
  const result=await client.downloadAttachment(attachmentPayload);
  assert.equal(reads,160);assert.equal(result.bytes.length,bytes.length);assert.deepEqual(Buffer.from(result.bytes),bytes);result.bytes.fill(0);
});
test('attachment payload offsets and authority fields are captured before any fetch',async()=>{
  const {client,calls}=await approved(()=>{throw new Error('must not fetch');});
  for(const offset of [-1,-0,NaN,Infinity,1.5,'0',10*1024*1024+1])assert.throws(()=>client.read('attachments.read',{...attachmentPayload,offset}),code('INVALID_REQUEST'));
  assert.throws(()=>client.downloadAttachment({...attachmentPayload,storageName:'private'}),code('INVALID_REQUEST'));
  assert.equal(calls.length,1);
});
test('changed metadata and wrong final hash withhold the entire attachment',async()=>{
  const bytes=Buffer.alloc(65537,7);
  for(const kind of ['metadata','hash']){
    const {client}=await approved(async(_path,init)=>{
      const offset=request(init).payload.offset,value=attachmentChunk(bytes,offset);
      if(kind==='metadata'&&offset)value.attachment.name='changed.bin';
      if(kind==='hash')value.attachment.sha256='0'.repeat(64);
      return response(init,value);
    });
    await assert.rejects(client.downloadAttachment(attachmentPayload),code('INVALID_RESPONSE'));
  }
});
test('chunk DTO refuses private fields, wrong target, bad base64, stalled offsets and oversized files',async()=>{
  const bytes=Buffer.from([0,255,1]),valid=attachmentChunk(bytes,0);
  const invalid=[
    {...valid,attachment:{...valid.attachment,storageName:'private.bin'}},
    {...valid,attachment:{...valid.attachment,id:'foreign'}},
    {...valid,attachment:{...valid.attachment,name:'../secret'}},
    {...valid,attachment:{...valid.attachment,size:10*1024*1024+1}},
    {...valid,data:'AB=='},
    {...valid,nextOffset:4},
    {...valid,data:'',nextOffset:0,complete:false},
    {...valid,complete:false}
  ];
  for(const value of invalid){const {client}=await approved(async(_path,init)=>response(init,value));await assert.rejects(client.read('attachments.read',{...attachmentPayload,offset:0}),code('INVALID_RESPONSE'));}
});
test('logout cancels the original transfer, drains its response and prevents later chunk fetches',async()=>{
  const bytes=Buffer.alloc(131073,9);let streamController,resolveHeld;
  const held=new Promise(resolve=>{resolveHeld=resolve;});
  const {client,calls}=await approved(async(path,init)=>{
    if(path==='/web/v1/logout')return response(init,{state:'logged-out'});
    const offset=request(init).payload.offset;
    if(!offset)return response(init,attachmentChunk(bytes,offset));
    return new Response(new ReadableStream({start(controller){streamController=controller;resolveHeld(init);}}),{headers:mime});
  });
  const transfer=client.downloadAttachment(attachmentPayload),rejected=assert.rejects(transfer,code('ABORTED'));
  const heldRequest=await held;assert.throws(()=>client.status(),code('BUSY'));
  const logout=client.logout();streamController.enqueue(encoder.encode(ok(heldRequest,attachmentChunk(bytes,65536))));streamController.close();
  await rejected;assert.deepEqual(await logout,{state:'logged-out'});
  assert.deepEqual(calls.filter(row=>row.path==='/web/v1/read').map(row=>request(row.init).payload.offset),[0,65536]);
  assert.equal(calls.filter(row=>row.path==='/web/v1/logout').length,1);
});

test('web login uses one fixed same-origin POST and captures input without URL or storage credentials', async () => {
  const { createRemoteWebClient } = await load(); let sent;
  const client = createRemoteWebClient({ makeRequestId: () => UUID, fetchImpl: async (path, init) => { sent = { path, init }; return response(init, { state: 'pending', expiresAt: DATE }); } });
  const original = { ...LOGIN }, pending = client.login(original); original.secret = 'b'.repeat(43); original.clientName = 'changed';
  assert.deepEqual(await pending, { state: 'pending', expiresAt: DATE });
  assert.equal(sent.path, '/web/v1/session'); assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.mode, 'same-origin'); assert.equal(sent.init.credentials, 'same-origin'); assert.equal(sent.init.redirect, 'error');
  assert.deepEqual(request(sent.init), { version: 1, requestId: UUID, action: 'login', ...LOGIN });
  assert.ok(encoder.encode(sent.init.body).byteLength <= 8192);
  assert.throws(() => client.read('projects.list', {}), code('AUTH_REQUIRED'));
});

test('web request capture refuses accessors, extra fields, malformed invitations and non-read operations before fetch', async () => {
  const { createRemoteWebClient } = await load(); let reads = 0, fetches = 0;
  const client = createRemoteWebClient({ fetchImpl: async () => { fetches++; }, makeRequestId: () => UUID });
  const accessor = { invitationId: UUID, clientName: 'Browser', get secret() { reads++; return LOGIN.secret; } };
  assert.throws(() => client.login(accessor), code('INVALID_REQUEST'));
  for (const input of [{ ...LOGIN, extra: true }, { ...LOGIN, invitationId: 'not-a-uuid' }, { ...LOGIN, secret: 'short' }, { ...LOGIN, clientName: 'bad\nname' }]) assert.throws(() => client.login(input), code('INVALID_REQUEST'));
  assert.throws(() => client.read('runs.start', {}), code('INVALID_QUERY'));
  assert.throws(() => client.read('projects.list', { projectId: 'other' }), code('INVALID_REQUEST'));
  assert.equal(reads, 0); assert.equal(fetches, 0);
});

test('approved client validates all three DTOs and preserves server order and plain user strings', async () => {
  const rows = [project('z'), project('a')], item = { ...review('review-a'), body: '<img src=x onerror=alert(1)>' };
  const { client, calls } = await approved(async (_path, init) => {
    const { operation } = request(init);
    return response(init, operation === 'projects.list' ? { version: 1, projects: rows } : operation === 'reviews.list' ? { version: 1, projectId: 'project-a', reviews: [item] } : { version: 1, projectId: 'project-a', review: item });
  });
  assert.deepEqual((await client.read('projects.list', {})).projects.map(row => row.id), ['z', 'a']);
  assert.equal((await client.read('reviews.list', { projectId: 'project-a' })).reviews[0].body, item.body);
  assert.equal((await client.read('reviews.get', { projectId: 'project-a', reviewId: 'review-a' })).review.body, item.body);
  assert.deepEqual(calls.slice(1).map(row => row.path), ['/web/v1/read', '/web/v1/read', '/web/v1/read']);
});

test('read capture is immutable before a request-ID seam mutates the original payload', async () => {
  const payload = { projectId: 'project-a' }; let sent, originalClient, refusals = 0;
  const { client } = await approved(async (_path, init) => { sent = request(init); return response(init, { version: 1, projectId: 'project-a', reviews: [] }); }, { makeRequestId: () => {
    payload.projectId = 'project-b';
    if (originalClient) { assert.throws(() => originalClient.status(), code('BUSY')); assert.throws(() => originalClient.logout(), code('BUSY')); refusals += 2; }
    return UUID;
  } });
  originalClient = client; payload.projectId = 'project-a'; await client.read('reviews.list', payload);
  assert.equal(sent.payload.projectId, 'project-a'); assert.equal(payload.projectId, 'project-b');
  assert.equal(refusals, 2);
});

test('wrong target, duplicate IDs, extra private fields and invalid row values are refused without partial DTOs', async () => {
  const invalid = [
    { version: 1, projectId: 'project-b', reviews: [] },
    { version: 1, projectId: 'project-a', reviews: [review('r'), review('r')] },
    { version: 1, projectId: 'project-a', reviews: [{ ...review('r'), workPath: '/private/host' }] },
    { version: 1, projectId: 'project-a', reviews: [{ ...review('r'), status: 'invented' }] },
    { version: 1, projectId: 'project-a', reviews: [{ ...review('r'), number: 0 }] }
  ];
  for (const data of invalid) { const { client } = await approved(async (_path, init) => response(init, data)); await assert.rejects(client.read('reviews.list', { projectId: 'project-a' }), code('INVALID_RESPONSE')); }
  const { client } = await approved(async (_path, init) => response(init, { version: 1, projectId: 'project-a', review: review('different') }));
  await assert.rejects(client.read('reviews.get', { projectId: 'project-a', reviewId: 'requested' }), code('INVALID_RESPONSE'));
});

test('complete one-MiB DTO succeeds and one additional byte fails while the same approved client recovers', async () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({ ...review('r' + index), number: index + 1, body: index < 10 ? 'a'.repeat(100000) : '' }));
  const data = { version: 1, projectId: 'project-a', reviews: rows };
  const remaining = 1024 * 1024 - encoder.encode(JSON.stringify(data)).byteLength;
  assert.ok(remaining > 0 && remaining < 100000); rows[10].body = 'a'.repeat(remaining);
  assert.equal(encoder.encode(JSON.stringify(data)).byteLength, 1024 * 1024);
  let phase = 0;
  const { client, calls } = await approved(async (_path, init) => {
    if (phase === 2) return response(init, { version: 1, projectId: 'project-a', review: review('r0') });
    return response(init, data);
  });
  assert.equal((await client.read('reviews.list', { projectId: 'project-a' })).reviews.length, 11);
  phase = 1; rows[10].body += 'a';
  await assert.rejects(client.read('reviews.list', { projectId: 'project-a' }), code('RESPONSE_LIMIT'));
  phase = 2; assert.equal((await client.read('reviews.get', { projectId: 'project-a', reviewId: 'r0' })).review.id, 'r0');
  assert.equal(calls.length, 4);
});

test('actual response stream cap is enforced even without Content-Length and cancellation is awaited', async () => {
  let cancelled = false;
  const { client } = await approved(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1025)); }, async cancel() { cancelled = true; } }), { headers: mime }));
  await assert.rejects(client.read('projects.list', {}), code('RESPONSE_LIMIT')); assert.equal(cancelled, true);
});

test('auth and HTTP-error bodies are limited to four KiB before JSON decoding', async () => {
  const { createRemoteWebClient } = await load(); let cancelled = 0;
  const huge = status => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4097)); }, cancel() { cancelled++; } }), { status, headers: mime });
  const client = createRemoteWebClient({ makeRequestId: () => UUID, fetchImpl: async () => huge(200) });
  await assert.rejects(client.status(), code('RESPONSE_LIMIT'));
  const approvedState = await approved(async () => huge(403));
  await assert.rejects(approvedState.client.read('projects.list', {}), code('RESPONSE_LIMIT')); assert.equal(cancelled, 2);
});

test('oversized declared length, MIME and observable-header limits refuse and close the unconsumed body', async () => {
  for (const headers of [{ ...mime, 'Content-Length': '1049601' }, { 'Content-Type': 'text/html' }, { ...mime, 'X-Large': 'a'.repeat(8192) }, { ...mime, ...Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['X-' + index, 'a'])) }]) {
    let cancelled = false;
    const { client } = await approved(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers }));
    await assert.rejects(client.read('projects.list', {})); assert.equal(cancelled, true);
  }
});

test('fatal UTF-8 decoding accepts split Unicode and rejects malformed encoded bytes', async () => {
  const { client } = await approved(async (_path, init) => {
    const encoded = encoder.encode(ok(init, { version: 1, projects: [{ ...project('p'), name: '한글 😀' }] }));
    const at = encoded.findIndex(byte => byte >= 0xf0) + 1;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoded.slice(0, at)); controller.enqueue(encoded.slice(at)); controller.close(); } }), { headers: mime });
  });
  assert.equal((await client.read('projects.list', {})).projects[0].name, '한글 😀');
  const bad = await approved(async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: mime }));
  await assert.rejects(bad.client.read('projects.list', {}));
});

test('duplicate decoded keys and excessive nesting are refused before DTO construction', async () => {
  for (const raw of [
    `{"version":1,"requestId":"${UUID}","ok":true,"data":{"version":1,"projects":[],"pro\\u006aects":[]}}`,
    `{"version":1,"requestId":"${UUID}","ok":true,"data":${'['.repeat(10)}0${']'.repeat(10)}}`,
    `{"version":1,"requestId":"${UUID}","ok":true,"data":{"version":1,"projects":[]},}`
  ]) { const { client } = await approved(async () => new Response(raw, { headers: mime })); await assert.rejects(client.read('projects.list', {}), code('INVALID_RESPONSE')); }
});

test('response identity, envelope closure, server-error allowlist and HTTP success agree', async () => {
  const invalid = [
    { version: 1, requestId: 'wrong', ok: true, data: { version: 1, projects: [] } },
    { version: 2, requestId: UUID, ok: true, data: { version: 1, projects: [] } },
    { version: 1, requestId: UUID, ok: true, data: { version: 1, projects: [] }, extra: true },
    { version: 1, requestId: UUID, ok: false, error: { code: 'RAW_OS_ERROR', message: 'not public' } }
  ];
  for (const envelope of invalid) { const { client } = await approved(async () => new Response(JSON.stringify(envelope), { headers: mime })); await assert.rejects(client.read('projects.list', {}), code('INVALID_RESPONSE')); }
  const deniedSuccess = await approved(async (_path, init) => new Response(ok(init, { version: 1, projects: [] }), { status: 403, headers: mime }));
  await assert.rejects(deniedSuccess.client.read('projects.list', {}), code('INVALID_RESPONSE'));
});

test('public authorization error clears client approval before any subsequent read', async () => {
  const { client, calls } = await approved(async (_path, init) => new Response(JSON.stringify({ version: 1, requestId: request(init).requestId, ok: false, error: { code: 'ACCESS_DENIED', message: 'Access denied.' } }), { status: 403, headers: mime }));
  await assert.rejects(client.read('projects.list', {}), code('ACCESS_DENIED'));
  assert.throws(() => client.read('projects.list', {}), code('AUTH_REQUIRED')); assert.equal(calls.length, 2);
});

test('one original in-flight request blocks a second request without creating network work', async () => {
  const { createRemoteWebClient } = await load(); let release, originalInit, calls = 0;
  const client = createRemoteWebClient({ makeRequestId: () => UUID, fetchImpl: async (_path, init) => { calls++; originalInit = init; return new Promise(resolve => { release = resolve; }); } });
  const original = client.status();
  try { await Promise.resolve(); assert.throws(() => client.status(), code('BUSY')); assert.equal(calls, 1); }
  finally { release(response(originalInit, { state: 'approved', expiresAt: DATE })); await original; }
});

test('logout cancels and settles the same held read, refuses its late result and issues exactly one logout', async () => {
  let release, heldInit, oldBodyCancelled = false;
  const { client, calls } = await approved(async (path, init) => {
    if (path === '/web/v1/logout') return response(init, { state: 'logged-out' });
    heldInit = init; return new Promise(resolve => { release = resolve; });
  });
  const read = client.read('projects.list', {}), observedRead = read.catch(error => error);
  let loggingOut;
  try {
    await Promise.resolve(); loggingOut = client.logout();
    assert.strictEqual(client.logout(), loggingOut); assert.equal(heldInit.signal.aborted, true);
    assert.throws(() => client.status(), code('BUSY'));
  } finally {
    const oldBody = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(ok(heldInit, { version: 1, projects: [project('late')] }))); }, cancel() { oldBodyCancelled = true; } });
    release(new Response(oldBody, { headers: mime }));
    const refusal = await observedRead; assert.equal(refusal.code, 'ABORTED');
    if (loggingOut) await loggingOut;
  }
  assert.equal(oldBodyCancelled, true); assert.equal(calls.filter(row => row.path === '/web/v1/logout').length, 1);
  assert.throws(() => client.read('projects.list', {}), code('AUTH_REQUIRED'));
});

test('pending expiry and local cancellation cannot become a newly approved read context', async () => {
  const { createRemoteWebClient } = await load(); let release, init;
  const client = createRemoteWebClient({ makeRequestId: () => UUID, fetchImpl: async (_path, value) => { init = value; return new Promise(resolve => { release = resolve; }); } });
  const pending = client.status(), observed = pending.catch(error => error);
  try { await Promise.resolve(); client.cancel(); }
  finally { release(response(init, { state: 'approved', expiresAt: DATE })); assert.equal((await observed).code, 'ABORTED'); }
  assert.throws(() => client.read('projects.list', {}), code('AUTH_REQUIRED'));
  const expired = createRemoteWebClient({ makeRequestId: () => UUID, now: () => Date.parse(DATE), fetchImpl: async (_path, value) => response(value, { state: 'approved', expiresAt: DATE }) });
  await assert.rejects(expired.status(), code('INVALID_RESPONSE'));
});

test('unknown original response cancellation preserves both causes and withholds logout POST', async () => {
  const cleanup = new Error('owned cancellation failure'); let release;
  const { client, calls } = await approved(async () => new Promise(resolve => { release = resolve; }));
  const read = client.read('projects.list', {}), observedRead = read.catch(error => error);
  let logout, observedLogout;
  try { await Promise.resolve(); logout = client.logout(); observedLogout = logout.catch(error => error); }
  finally {
    release(new Response(new ReadableStream({ cancel() { throw cleanup; } }), { headers: mime }));
    const first = await observedRead, second = observedLogout ? await observedLogout : null;
    assert.equal(first.code, 'RESPONSE_CLEANUP_FAILED'); assert.equal(first.errors[0].code, 'ABORTED');
    assert.strictEqual(first.errors[1], cleanup); assert.strictEqual(first.cause, first.errors[0]); assert.strictEqual(second, first);
  }
  assert.equal(calls.filter(row => row.path === '/web/v1/logout').length, 0);
  assert.throws(() => client.read('projects.list', {}), code('AUTH_REQUIRED'));
});
