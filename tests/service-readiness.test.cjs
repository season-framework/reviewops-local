'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkHttp, compareFile, summarizeAgents } = require('../electron/service-readiness.cjs');

async function fixture(t, handler) {
 const server = http.createServer(handler);
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
 return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP observation uses unauthenticated GET, reports time and never waits for an unbounded body', async t => {
 let request;
 const url = await fixture(t, (req,res) => { request = req; res.writeHead(200); res.write('stream remains open'); });
 const result = await checkHttp(url + '/health#fragment', {timeoutMs:2000});
 assert.equal(result.status, 'responding'); assert.equal(result.statusCode, 200);
 assert.equal(request.method,'GET'); assert.equal(request.url,'/health');
 assert.equal(request.headers.cookie,undefined); assert.equal(request.headers.authorization,undefined);
 assert.equal(result.observedFrom,'reviewops-computer'); assert.equal(result.url,url+'/health');
 assert.ok(Date.parse(result.checkedAt)>=Date.parse(result.startedAt)); assert.ok(result.durationMs<2000);
});

test('HTTP errors and redirects remain responses, and redirects are not followed', async t => {
 let requests=0;
 const url = await fixture(t, (req,res) => { requests++; res.writeHead(req.url==='/redirect'?302:503,{location:'/followed'});res.end(); });
 assert.equal((await checkHttp(url)).statusCode,503);
 const redirect=await checkHttp(url+'/redirect'); assert.equal(redirect.status,'http-error');assert.equal(redirect.statusCode,302);
 assert.equal(requests,2);
});

test('network refusal and total request timeout are distinguished from HTTP errors', async t => {
 const url=await fixture(t,()=>{}), server = http.createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const port=server.address().port;
 await new Promise(resolve=>server.close(resolve));
 const refused=await checkHttp(`http://127.0.0.1:${port}`);assert.equal(refused.status,'unreachable');assert.equal(refused.errorCode,'ECONNREFUSED');
 const timeout=await checkHttp(url,{timeoutMs:35});assert.equal(timeout.status,'unreachable');assert.equal(timeout.errorCode,'TIMEOUT');
});

test('credentialed, unsupported and malformed URLs are rejected before a request', () => {
 for(const value of ['http://user:secret@localhost/','file:///tmp/a','javascript:alert(1)','bad','http://'+'a'.repeat(4096),null]) assert.throws(()=>checkHttp(value),/인증 정보가 없는/);
});

test('comparison hashes exact bounded project bytes without claiming runtime provenance', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'readiness-files-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const bytes=Buffer.from([0,1,2,255]);await fs.writeFile(path.join(root,'bundle.bin'),bytes);
 const result=await compareFile({kind:'local',rootPath:root},'bundle.bin');
 assert.equal(result.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(result.size,4);assert.equal(result.role,'comparison-only');
 assert.equal(result.pid,undefined);assert.equal(result.command,undefined);assert.equal(result.bytes,undefined);assert.equal(result.content,undefined);
});

test('comparison rejects parent paths, external symlinks and non-files while preserving an independent HTTP observation', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'readiness-scope-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'project'));await fs.writeFile(path.join(root,'outside.txt'),'secret');
 await fs.symlink(path.join(root,'outside.txt'),path.join(root,'project','escape.txt'));
 const service={kind:'local',rootPath:path.join(root,'project')};
 for(const relative of ['../outside.txt','escape.txt','.']) {const result=await compareFile(service,relative);assert.ok(result.error);assert.equal(result.sha256,undefined);assert.equal(result.content,undefined);}
 assert.equal(await compareFile(service,''),null);
 const remote=await compareFile({kind:'ssh',rootPath:'/not-local'},'bundle');assert.match(remote.error,/로컬/);
});

test('agent summary contains only chosen project reviews, with no agent output or credentials', () => {
 const result=summarizeAgents([{id:'other',reviewId:'other',status:'running',response:'private'},{id:'latest',reviewId:'mine',status:'completed',startedAt:'start',finishedAt:'end',response:'private'},{id:'active',reviewId:'mine',status:'running'}],new Set(['mine']));
 assert.equal(result.running,1);assert.deepEqual(result.latest,{id:'latest',status:'completed',startedAt:'start',finishedAt:'end'});assert.equal(JSON.stringify(result).includes('private'),false);
});
