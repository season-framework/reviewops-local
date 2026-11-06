'use strict';
// Controlled JS fixtures only: no Electron, addon, Keychain, OS identity or actual listener acceptance.
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createIdentityOwner}=require('../electron/remote-device-identity-internal.cjs');
const realTLS=require('../electron/remote-tls.cjs'); // Adopt beside Root's separately reviewed genuine TLS module before running.
const A='192.0.2.10',B='192.0.2.11';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const isCode=code=>error=>error.code===code&&error.message==='The remote identity request was refused.';
function memoryFiles(store={exists:false,records:new Map(),version:0,locked:false},trace=[]) {
  let opened=false;const fail=()=>{throw Object.assign(new Error('synthetic file refusal'),{code:'IDENTITY_UNAVAILABLE'});};
  function read(name){const r=store.records.get(name);return r?{name,bytes:Buffer.from(r.bytes),identity:r.version}:null;}
  function unchanged(snapshot,name=snapshot?.name){const r=store.records.get(name);if(snapshot? !r||r.version!==snapshot.identity||!r.bytes.equals(snapshot.bytes):!!r)fail();}
  return{store,probe:()=>store.exists,open(enroll){if(opened)return;if(enroll){if(store.exists)fail();store.exists=true;}else if(!store.exists)fail();opened=true;},read,unchanged,assertDirectory(){if(!opened)fail();},
    write(name,value,expected,guard){guard();unchanged(expected,name);trace.push('write:'+name);store.beforeWrite?.(name,value);guard();unchanged(expected,name);store.records.set(name,{bytes:Buffer.from(JSON.stringify(value)),version:++store.version});return read(name);},
    remove(name,snapshot,guard){guard();unchanged(snapshot,name);trace.push('remove:'+name);store.records.delete(name);},close(){if(opened)store.locked=false;opened=false;}};
}
function nativeFixture(records=new Map(),trace=[]) {
  let initialized=null,closed=false;const calls={initialize:0,create:0,read:0,remove:0,close:0};
  const rawReads=[];
  const native={
    initialize(account){calls.initialize++;if(closed||initialized||native.initializeError)throw{code:'PROVIDER_FAILED',osStatus:null,mayRemain:false};initialized=account;trace.push('native:initialize');},
    create(payload){calls.create++;trace.push('native:create');native.beforeCreate?.();if(native.createError)throw native.createError;const ref=Buffer.from(crypto.randomUUID());records.set(ref.toString('base64'),Buffer.from(payload));native.afterCreate?.();return native.badReference?Buffer.from(native.badReference):ref;},
    read(ref){calls.read++;trace.push('native:read');const value=records.get(ref.toString('base64'));if(!value)throw{code:'REFERENCE_RESOLVE_FAILED',osStatus:-25300,mayRemain:true};const answer=Buffer.from(native.readOverride||value);rawReads.push(answer);return answer;},
    remove(ref,digest){calls.remove++;trace.push('native:remove');const key=ref.toString('base64'),value=records.get(key);if(!value||!crypto.createHash('sha256').update(value).digest().equals(digest))throw{code:'DIGEST_MISMATCH',osStatus:null,mayRemain:true};value.fill(0);records.delete(key);},
    close(){calls.close++;trace.push('native:close');closed=true;}
  };
  return{native,calls,records,rawReads};
}
function fixture(options={}) {
  const trace=[],files=memoryFiles(options.store,trace),n=nativeFixture(options.records,trace),leases=[];
  let certificateCalls=0,reissueCalls=0,loads=0,current=true,live=true;
  const tls={
    async createRemoteCertificate(input){certificateCalls++;return options.create?options.create(input):realTLS.createRemoteCertificate(input);},
    async reissueRemoteCertificate(input){reissueCalls++;return options.reissue?options.reissue(input):realTLS.reissueRemoteCertificate(input);},
    createRemoteTLSLease(input){
      const verified=realTLS.createRemoteTLSLease(input); // Software validation only; this returned server is never created/listened.
      verified.release();
      const socketGate=deferred(),closeGate=deferred();let server;
      const lease={identity:verified.identity,releases:0,socketGate,closeGate,
        createServer(){server=new EventEmitter();server.listening=false;server.listen=function(){trace.push('server:listen');server.listening=true;server.emit('listening');return server;};server.close=function(done){trace.push('server:close');server.listening=false;closeGate.promise.then(()=>{server.emit('close');done();});};lease.server=server;return server;},
        async release(){lease.releases++;trace.push('lease:release');if(server)await socketGate.promise;trace.push('lease:drained');}
      };leases.push(lease);return lease;
    }
  };
  const owner=createIdentityOwner({files,loadNative:()=>{loads++;return n.native;},tls,ownerCurrent:()=>current});
  const request=address=>({address,assertCurrent(){if(!live)throw new Error('synthetic stale frame');}});
  return{owner,files,n,trace,leases,request,setLive:v=>{live=v;},setCurrent:v=>{current=v;},counts:()=>({certificateCalls,reissueCalls,loads})};
}
async function enrolled(options){const f=fixture(options);assert.equal((await f.owner.initialize(f.request(A))).status,'ready');return f;}

test('constructor loads once but never enrolls; public state is a closed DTO',async()=>{
  const f=fixture();assert.deepEqual(f.owner.state(),{status:'not_initialized',backend:'macos-default-file-keychain',identity:null,errorCode:null});assert.equal(f.counts().loads,1);assert.equal(f.n.calls.initialize,0);assert.equal(f.n.calls.create,0);await f.owner.closeAndDrain();assert.equal(f.n.calls.close,1);
});
test('first explicit enrollment persists PENDING before the one create and verifies protected read',async()=>{
  const f=await enrolled();assert.ok(f.trace.indexOf('write:pending.json')<f.trace.indexOf('native:create'));assert.ok(f.trace.indexOf('native:initialize')<f.trace.indexOf('native:create'));assert.equal(f.n.calls.create,1);assert.equal(f.n.calls.initialize,1);assert.equal(f.n.calls.read,1);assert.ok(f.n.rawReads.every(b=>b.every(x=>x===0)));
  const state=f.owner.state(),pub=f.owner.publicCertificate();assert.deepEqual(Object.keys(state.identity).sort(),['address','certificateFingerprint','deviceId','keyFingerprint','validUntil']);assert.deepEqual(Object.keys(pub).sort(),['address','certificateFingerprint','certificatePEM','deviceId','keyFingerprint','validUntil']);assert.equal(f.files.store.records.has('pending.json'),false);
  for(const r of f.files.store.records.values()){assert.equal(r.bytes.includes(Buffer.from('privateKeyDERbase64')),false);assert.equal(r.bytes.includes(Buffer.from('PRIVATE KEY')),false);}await f.owner.closeAndDrain();
});
test('same owner repeated initialize never creates or initializes native twice',async()=>{const f=await enrolled();await f.owner.initialize(f.request(A));assert.equal(f.n.calls.create,1);assert.equal(f.n.calls.initialize,1);await f.owner.closeAndDrain();});
test('coordinator null-prototype request records preserve exact guarded provider interop',async()=>{const f=fixture(),request=Object.assign(Object.create(null),f.request(A));assert.equal((await f.owner.initialize(request)).status,'ready');const lease=await f.owner.acquireServerTLS(request);await lease.release();await f.owner.closeAndDrain();});
test('unavailable backend setup creates neither a private profile nor a permanent pending intent',async()=>{const f=fixture();f.n.native.initializeError=true;assert.equal((await f.owner.initialize(f.request(A))).status,'unavailable');assert.equal(f.files.store.exists,false);assert.equal(f.n.calls.create,0);await f.owner.closeAndDrain();});
test('fresh synthetic process acquire verifies existing key without generating or replacing it',async()=>{
  const first=await enrolled(),pub=first.owner.publicCertificate();await first.owner.closeAndDrain();const f=fixture({store:first.files.store,records:first.n.records});assert.equal(f.owner.state().status,'not_initialized');const lease=await f.owner.acquireServerTLS(f.request(A));assert.equal(f.owner.state().status,'ready');assert.equal(f.owner.publicCertificate().deviceId,pub.deviceId);assert.equal(f.n.calls.create,0);assert.equal(f.counts().certificateCalls,0);await lease.release();await f.owner.closeAndDrain();
});
test('missing protected record is identity_lost with no automatic replacement',async()=>{const first=await enrolled();await first.owner.closeAndDrain();first.n.records.clear();const f=fixture({store:first.files.store,records:first.n.records});assert.equal((await f.owner.initialize(f.request(A))).status,'identity_lost');assert.equal(f.n.calls.create,0);assert.equal(f.counts().certificateCalls,0);await f.owner.closeAndDrain();});
test('profile disappearance in the same original owner is lost and never reenrolled',async()=>{const f=await enrolled();f.files.store.exists=false;assert.equal((await f.owner.initialize(f.request(A))).status,'identity_lost');assert.equal(f.n.calls.create,1);assert.equal(f.counts().certificateCalls,1);await f.owner.closeAndDrain();});
test('PENDING and existing empty profile both refuse first-create retry',async()=>{
  const pending={schema:1,operationId:crypto.randomUUID(),deviceId:crypto.randomUUID(),accountUUID:crypto.randomUUID(),keyFingerprint:'a'.repeat(64)};
  for(const records of [new Map([['pending.json',{bytes:Buffer.from(JSON.stringify(pending)),version:1}]]),new Map()]){const f=fixture({store:{exists:true,records,version:1,locked:false}});const s=await f.owner.initialize(f.request(A));assert.ok(['pending','identity_lost'].includes(s.status));assert.equal(f.n.calls.create,0);assert.equal(f.counts().certificateCalls,0);await f.owner.closeAndDrain();}
});
test('ambiguous native create failure retains pending and never retries',async()=>{const f=fixture();f.n.native.createError={code:'NATIVE_EXCEPTION',osStatus:null,mayRemain:true};assert.equal((await f.owner.initialize(f.request(A))).status,'pending');assert.equal((await f.owner.initialize(f.request(A))).status,'pending');assert.equal(f.n.calls.create,1);assert.ok(f.files.store.records.has('pending.json'));await f.owner.closeAndDrain();});
test('index publication failure cleans only the returned create and retains PENDING',async()=>{const f=fixture();f.files.store.beforeWrite=name=>{if(name==='index.json')throw new Error('synthetic commit failure');};assert.equal((await f.owner.initialize(f.request(A))).status,'pending');assert.equal(f.n.calls.remove,1);assert.equal(f.n.records.size,0);assert.ok(f.files.store.records.has('pending.json'));await f.owner.initialize(f.request(A));assert.equal(f.n.calls.create,1);await f.owner.closeAndDrain();});
test('stale after certificate await withholds and wipes DER before any enrollment',async()=>{const gate=deferred();let result;const f=fixture({create:async input=>{result=await realTLS.createRemoteCertificate(input);await gate.promise;return result;}});const task=f.owner.initialize(f.request(A));await new Promise(resolve=>setImmediate(resolve));f.setLive(false);gate.resolve();await assert.rejects(task,isCode('STALE_IDENTITY_REQUEST'));assert.equal(f.n.calls.create,0);assert.equal(f.files.store.exists,false);assert.ok(result.privateKeyDER.every(x=>x===0));await f.owner.closeAndDrain();});
test('stale immediately after create uses its own guarded cleanup, not a second create',async()=>{const f=fixture();f.n.native.afterCreate=()=>f.setLive(false);await assert.rejects(f.owner.initialize(f.request(A)),isCode('STALE_IDENTITY_REQUEST'));assert.equal(f.n.calls.create,1);assert.equal(f.n.calls.remove,1);assert.ok(f.files.store.records.has('pending.json'));await f.owner.closeAndDrain();});
test('public certificate reissue changes address/leaf while preserving key, device and OS payload',async()=>{
  const f=await enrolled(),before=f.owner.publicCertificate(),payload=Buffer.from([...f.n.records.values()][0]);await f.owner.initialize(f.request(B));const after=f.owner.publicCertificate();assert.equal(after.deviceId,before.deviceId);assert.equal(after.keyFingerprint,before.keyFingerprint);assert.notEqual(after.certificateFingerprint,before.certificateFingerprint);assert.equal(after.address,B);assert.ok([...f.n.records.values()][0].equals(payload));payload.fill(0);assert.equal(f.n.calls.create,1);assert.equal(f.counts().reissueCalls,1);await f.owner.closeAndDrain();
});
test('wrong-address acquire never silently reissues or generates',async()=>{const f=await enrolled();await assert.rejects(f.owner.acquireServerTLS(f.request(B)),isCode('CERTIFICATE_REISSUE_REQUIRED'));assert.equal(f.counts().reissueCalls,0);assert.equal(f.n.calls.create,1);await f.owner.closeAndDrain();});
test('stale reissue await never commits new public metadata',async()=>{const gate=deferred();const f=await enrolled({reissue:async input=>{const v=await realTLS.reissueRemoteCertificate(input);await gate.promise;return v;}});const old=Buffer.from(f.files.store.records.get('certificate.json').bytes);const task=f.owner.initialize(f.request(B));await new Promise(resolve=>setImmediate(resolve));f.setLive(false);gate.resolve();await assert.rejects(task,isCode('STALE_IDENTITY_REQUEST'));assert.ok(f.files.store.records.get('certificate.json').bytes.equals(old));assert.equal(f.n.calls.create,1);old.fill(0);await f.owner.closeAndDrain();});
test('changed profile while reissue awaits refuses its publication',async()=>{const gate=deferred();const f=await enrolled({reissue:async input=>{const v=await realTLS.reissueRemoteCertificate(input);await gate.promise;return v;}});const task=f.owner.initialize(f.request(B));await new Promise(resolve=>setImmediate(resolve));const r=f.files.store.records.get('index.json');r.version++;gate.resolve();assert.equal((await task).status,'unavailable');assert.equal(f.n.calls.create,1);await f.owner.closeAndDrain();});
test('private index key mismatch is lost, never a create fallback',async()=>{const first=await enrolled();await first.owner.closeAndDrain();const r=first.files.store.records.get('index.json'),v=JSON.parse(r.bytes);v.keyFingerprint='f'.repeat(64);r.bytes=Buffer.from(JSON.stringify(v));r.version++;const f=fixture({store:first.files.store,records:first.n.records});assert.equal((await f.owner.initialize(f.request(A))).status,'identity_lost');assert.equal(f.n.calls.create,0);await f.owner.closeAndDrain();});
test('oversized protected payload is wholly refused and the returned buffer is wiped',async()=>{const first=await enrolled();await first.owner.closeAndDrain();const f=fixture({store:first.files.store,records:first.n.records});f.n.native.readOverride=Buffer.alloc(65537,1);assert.equal((await f.owner.initialize(f.request(A))).status,'identity_lost');assert.ok(f.n.rawReads.every(b=>b.every(x=>x===0)));assert.equal(f.n.calls.create,0);await f.owner.closeAndDrain();});
test('async or false assertions are not accepted as current authority',async()=>{const f=fixture();for(const assertCurrent of [()=>Promise.resolve(),()=>false])await assert.rejects(f.owner.initialize({address:A,assertCurrent}),isCode('STALE_IDENTITY_REQUEST'));assert.equal(f.n.calls.initialize,0);assert.equal(f.n.calls.create,0);await f.owner.closeAndDrain();});
test('lease cannot begin listening after its original request became stale',async()=>{const f=await enrolled(),lease=await f.owner.acquireServerTLS(f.request(A)),server=lease.createServer(()=>{});f.setLive(false);assert.throws(()=>server.listen(0),isCode('STALE_IDENTITY_REQUEST'));assert.equal(f.trace.includes('server:listen'),false);f.leases[0].socketGate.resolve();await lease.release();await f.owner.closeAndDrain();});
test('close waits the original listener callback and socket drain before native close',async()=>{
  const f=await enrolled(),lease=await f.owner.acquireServerTLS(f.request(A)),server=lease.createServer(()=>{});server.listen(0);const closing=f.owner.closeAndDrain();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.n.calls.close,0);assert.ok(f.trace.includes('server:close'));f.leases[0].closeGate.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.n.calls.close,0);f.leases[0].socketGate.resolve();await closing;assert.equal(f.n.calls.close,1);assert.ok(f.trace.indexOf('lease:drained')<f.trace.indexOf('native:close'));assert.equal(f.owner.state().status,'unavailable');assert.equal(f.owner.closeAndDrain(),closing);
});
test('close during a pending certificate operation waits it, wipes and never creates',async()=>{
  const gate=deferred();let result;const f=fixture({create:async input=>{result=await realTLS.createRemoteCertificate(input);await gate.promise;return result;}});const task=f.owner.initialize(f.request(A));await new Promise(resolve=>setImmediate(resolve));const closed=f.owner.closeAndDrain();assert.equal(f.n.calls.close,0);gate.resolve();await assert.rejects(task,isCode('STALE_IDENTITY_REQUEST'));await closed;assert.equal(f.n.calls.create,0);assert.equal(f.n.calls.close,1);assert.ok(result.privateKeyDER.every(x=>x===0));
});
test('production wrapper has no constructor loader/provider/path override',()=>{const {createRemoteDeviceIdentity}=require('../electron/remote-device-identity.cjs');assert.throws(()=>createRemoteDeviceIdentity({app:{},dataPath:'/synthetic',loadNative(){throw new Error('must not run');}}),e=>e.code==='IDENTITY_UNAVAILABLE');});

test('saved app credentials are bound to scope and survive a certificate reissue and protected reopen',async()=>{
  const first=await enrolled(),scope='remote-app-client:'+crypto.randomUUID()+':'+'a'.repeat(64),secret=crypto.randomBytes(32).toString('base64url');
  const request={scope,secret,assertCurrent(){}};
  const ciphertext=await first.owner.sealCredential(request);
  assert.equal(ciphertext.includes(secret),false);
  assert.equal(await first.owner.openCredential({scope,ciphertext,assertCurrent(){}}),secret);
  const other='remote-app-client:'+crypto.randomUUID()+':'+'a'.repeat(64);
  await assert.rejects(first.owner.openCredential({scope:other,ciphertext,assertCurrent(){}}),isCode('IDENTITY_UNAVAILABLE'));
  assert.equal(first.owner.state().status,'ready');
  await first.owner.initialize(first.request(B));
  assert.equal(await first.owner.openCredential({scope,ciphertext,assertCurrent(){}}),secret);
  await first.owner.closeAndDrain();
  const reopened=fixture({store:first.files.store,records:first.n.records});
  assert.equal(await reopened.owner.openCredential({scope,ciphertext,assertCurrent(){}}),secret);
  assert.equal(reopened.n.calls.create,0);assert.equal(reopened.counts().certificateCalls,0);
  await reopened.owner.closeAndDrain();
});
test('credential operations refuse missing identities, malformed tokens and retired request guards',async()=>{
  const scope='remote-app-client:'+crypto.randomUUID()+':'+'f'.repeat(64),fresh=fixture();
  await assert.rejects(fresh.owner.sealCredential({scope,secret:crypto.randomBytes(32).toString('base64url'),assertCurrent(){}}),isCode('IDENTITY_NOT_INITIALIZED'));
  assert.equal(fresh.n.calls.create,0);await fresh.owner.closeAndDrain();
  const f=await enrolled();
  await assert.rejects(f.owner.sealCredential({scope,secret:'not-a-32-byte-token',assertCurrent(){}}),isCode('IDENTITY_UNAVAILABLE'));
  await assert.rejects(f.owner.openCredential({scope,ciphertext:'malformed',assertCurrent(){}}),isCode('IDENTITY_UNAVAILABLE'));
  await assert.rejects(f.owner.sealCredential({scope,secret:crypto.randomBytes(32).toString('base64url'),assertCurrent(){return false;}}),isCode('STALE_IDENTITY_REQUEST'));
  const secret=crypto.randomBytes(32).toString('base64url'),pending=f.owner.sealCredential({scope,secret,assertCurrent(){}});
  f.setCurrent(false);await assert.rejects(pending,isCode('STALE_IDENTITY_REQUEST'));await f.owner.closeAndDrain();
});
