'use strict';

// Controlled owner contract only. No addon, Electron, Keychain, certificate
// generation, private-key read, item creation/removal or real profile is used.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createIdentityOwner}=require('../electron/remote-device-identity-internal.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const pending=()=>({schema:1,operationId:'00000000-0000-4000-8000-000000000001',deviceId:'00000000-0000-4000-8000-000000000002',accountUUID:'00000000-0000-4000-8000-000000000003',keyFingerprint:'a'.repeat(64)});

async function fixture(t,options={}){
 const original=Buffer.from(JSON.stringify(pending())),records=new Map([['pending.json',{bytes:Buffer.from(original),version:1}]]),calls={initialize:0,create:0,read:0,remove:0,close:0,inspect:0,tls:0,writes:0,removes:0};
 let current=true,live=true,opened=false,version=1,owner;const inputs=[];
 const f={calls,records,inputs,original,onFence:null};
 function refuse(){throw Object.assign(new Error('Synthetic private failure must not escape'),{code:'IDENTITY_UNAVAILABLE'});}
 const files={probe:()=>true,open(enroll){assert.equal(enroll,false);opened=true;},assertDirectory(){assert.equal(opened,true);},
  read(name){const value=records.get(name);return value?{name,bytes:Buffer.from(value.bytes),identity:value.version}:null;},
  unchanged(snapshot,name=snapshot?.name){f.onFence?.();const current=records.get(name);if(snapshot?!current||current.version!==snapshot.identity||!current.bytes.equals(snapshot.bytes):Boolean(current))refuse();},
  write(){calls.writes++;refuse();},remove(){calls.removes++;refuse();},close(){opened=false;}};
 const denied=name=>()=>{calls[name]++;refuse();};
 const native={initialize:denied('initialize'),create:denied('create'),read:denied('read'),remove:denied('remove'),close(){calls.close++;},
  async inspectPendingMetadata(accountUUID,digest){calls.inspect++;inputs.push({accountUUID,pendingSHA256:digest.toString('hex')});return options.inspect?options.inspect({accountUUID,pendingSHA256:digest.toString('hex'),fixture:f}):{version:1,state:'found_current_default',pendingSHA256:digest.toString('hex'),osStatus:0};}};
 if(options.unsupported)delete native.inspectPendingMetadata;
 const tls={createRemoteCertificate:denied('tls'),reissueRemoteCertificate:denied('tls'),createRemoteTLSLease:denied('tls')};
 owner=createIdentityOwner({files,loadNative:()=>native,tls,ownerCurrent:()=>current});
 const assertCurrent=()=>{if(!live)throw new Error('Synthetic revoked window');};
 assert.equal((await owner.initialize({address:'192.0.2.10',assertCurrent})).status,'pending');
 const baseline=owner.state();t.after(()=>owner.closeAndDrain());
 Object.assign(f,{owner,baseline,assertCurrent,observe:()=>owner.inspectPendingMetadata({assertCurrent}),setCurrent:value=>current=value,setLive:value=>live=value,
  replace(value=pending()){records.set('pending.json',{bytes:Buffer.from(JSON.stringify(value)),version:++version});},
  assertPreserved(){assert.deepEqual(owner.state(),baseline);assert.equal(records.get('pending.json').bytes.equals(original),true);assert.equal(calls.writes,0);assert.equal(calls.removes,0);},
  assertNoItemCapabilities(){for(const name of ['initialize','create','read','remove','tls','writes','removes'])assert.equal(calls[name],0,name);}});
 return f;
}

test('current metadata derives only the original runtime pending binding and never promotes legacy history',async t=>{
 const f=await fixture(t),observed=await f.observe();
 assert.deepEqual(f.inputs,[{accountUUID:pending().accountUUID,pendingSHA256:hash(f.original)}]);
 assert.deepEqual(observed,{version:1,kind:'current-pending-metadata',scope:'current-default',state:'found_current_default',pendingSHA256:hash(f.original),code:'OK',osStatus:0});
 assert.equal(Object.isFrozen(observed),true);assert.equal(f.owner.state().diagnostic.source,'legacy-intent');assert.equal(f.owner.state().diagnostic.code,'UNKNOWN');assert.equal(f.owner.state().diagnostic.mayRemain,null);
 f.assertPreserved();f.assertNoItemCapabilities();
});

test('not found means only the current default and does not authorize reset or enrollment',async t=>{
 const f=await fixture(t,{inspect:({pendingSHA256})=>({version:1,state:'not_found_current_default',pendingSHA256,osStatus:-25300})}),observed=await f.observe();
 assert.equal(observed.state,'not_found_current_default');assert.equal(observed.scope,'current-default');assert.equal(observed.code,'ITEM_NOT_FOUND');
 assert.equal(Object.hasOwn(observed,'mayRemain'),false);assert.equal(Object.hasOwn(observed,'recovery'),false);assert.equal(f.owner.state().status,'pending');f.assertPreserved();f.assertNoItemCapabilities();
});

test('evidence copies, arbitrary account/service/digest and path options are refused before lookup',async t=>{
 const f=await fixture(t);
 for(const extra of [{pendingBytes:f.original},{accountUUID:crypto.randomUUID()},{service:'foreign-service'},{pendingSHA256:hash(f.original)},{dataPath:'/synthetic/evidence-copy'},{pendingPath:'/synthetic/evidence-copy/pending.json'}]){
  await assert.rejects(f.owner.inspectPendingMetadata({assertCurrent:f.assertCurrent,...extra}),{code:'STALE_IDENTITY_REQUEST'});
 }
 assert.equal(f.calls.inspect,0);f.assertPreserved();f.assertNoItemCapabilities();
});

test('a pending replacement before native admission refuses lookup without writing either intent',async t=>{
 const f=await fixture(t);let replaced=false;
 f.onFence=()=>{if(!replaced){replaced=true;f.replace({...pending(),operationId:crypto.randomUUID()});}};
 const observed=await f.observe();assert.equal(observed.state,'unavailable');assert.equal(observed.code,'PENDING_CHANGED');assert.equal(observed.pendingSHA256,null);assert.equal(f.calls.inspect,0);assert.notEqual(hash(f.records.get('pending.json').bytes),hash(f.original));assert.deepEqual(f.owner.state(),f.baseline);f.assertNoItemCapabilities();
});

test('a pending swap during the original lookup withholds the old response instead of attaching it to B',async t=>{
 const entered=deferred(),release=deferred(),f=await fixture(t,{inspect:async({pendingSHA256})=>{entered.resolve();await release.promise;return {version:1,state:'found_current_default',pendingSHA256,osStatus:0};}});
 const observed=f.observe();await entered.promise;f.replace({...pending(),operationId:crypto.randomUUID()});release.resolve();
 const result=await observed;assert.deepEqual({state:result.state,code:result.code,pendingSHA256:result.pendingSHA256},{state:'unavailable',code:'PENDING_CHANGED',pendingSHA256:null});assert.equal(f.calls.inspect,1);assert.deepEqual(f.owner.state(),f.baseline);f.assertNoItemCapabilities();
});

test('the same bytes in a replacement file cannot rebind an already captured inspection owner',async t=>{
 const f=await fixture(t);await f.observe();f.replace();const observed=await f.observe();
 assert.equal(observed.state,'unavailable');assert.equal(observed.code,'PENDING_CHANGED');assert.equal(f.calls.inspect,1);assert.equal(hash(f.records.get('pending.json').bytes),hash(f.original));assert.deepEqual(f.owner.state(),f.baseline);f.assertNoItemCapabilities();
});

test('lifecycle revocation during lookup rejects the response and preserves both unknown history and bytes',async t=>{
 for(const kind of ['owner','window'])await t.test(kind,async t=>{
  const entered=deferred(),release=deferred(),f=await fixture(t,{inspect:async({pendingSHA256})=>{entered.resolve();await release.promise;return {version:1,state:'found_current_default',pendingSHA256,osStatus:0};}});
  const observed=f.observe();await entered.promise;kind==='owner'?f.setCurrent(false):f.setLive(false);const refused=assert.rejects(observed,{code:'STALE_IDENTITY_REQUEST'});release.resolve();await refused;
  assert.equal(f.records.get('pending.json').bytes.equals(f.original),true);f.assertNoItemCapabilities();f.setCurrent(true);f.setLive(true);assert.deepEqual(f.owner.state(),f.baseline);
 });
});

test('native default change or locked state returns unavailable without rewriting historical diagnostics',async t=>{
 for(const code of ['METADATA_DEFAULT_CHANGED','DEFAULT_LOCKED'])await t.test(code,async t=>{
  const secret='Synthetic provider path and description must not escape',f=await fixture(t,{inspect:()=>{throw Object.assign(new Error(secret),{code,osStatus:null,mayRemain:false});}}),observed=await f.observe();
  assert.equal(observed.state,'unavailable');assert.equal(observed.code,code);assert.equal(observed.osStatus,null);assert.equal(JSON.stringify(observed).includes(secret),false);assert.equal(Object.hasOwn(observed,'mayRemain'),false);f.assertPreserved();f.assertNoItemCapabilities();
 });
});

test('extra native attributes, references, wrong hashes and accessors cannot become a current observation',async t=>{
 const secret='Synthetic reference must not escape';let accessed=0;
 const variants=[value=>({...value,referenceBase64:secret}),value=>({...value,attributes:{account:secret}}),value=>({...value,pendingSHA256:'f'.repeat(64)}),value=>({...value,osStatus:-25300}),value=>{Object.defineProperty(value,'state',{get(){accessed++;return 'found_current_default';},enumerable:true});return value;}];
 for(const variant of variants){const f=await fixture(t,{inspect:({pendingSHA256})=>variant({version:1,state:'found_current_default',pendingSHA256,osStatus:0})}),observed=await f.observe();assert.equal(observed.state,'unavailable');assert.equal(observed.code,'METADATA_RESULT_REFUSED');assert.equal(JSON.stringify(observed).includes(secret),false);f.assertPreserved();f.assertNoItemCapabilities();}
 assert.equal(accessed,0);
});

test('a module without the private metadata capability does not fall back to protected read',async t=>{
 const f=await fixture(t,{unsupported:true}),observed=await f.observe();assert.equal(observed.state,'unavailable');assert.equal(observed.code,'METADATA_UNSUPPORTED');assert.equal(f.calls.inspect,0);f.assertPreserved();f.assertNoItemCapabilities();
});

test('an inspection-only owner cannot later open item capabilities after external metadata publication',async t=>{
 const f=await fixture(t);await f.observe();f.records.delete('pending.json');
 f.records.set('index.json',{version:2,bytes:Buffer.from(JSON.stringify({schema:1,deviceId:pending().deviceId,accountUUID:pending().accountUUID,referenceBase64:Buffer.from('synthetic reference').toString('base64'),payloadSHA256:'b'.repeat(64),keyFingerprint:pending().keyFingerprint}))});
 assert.equal((await f.owner.initialize({address:'192.0.2.10',assertCurrent:f.assertCurrent})).status,'pending');assert.equal(f.calls.inspect,1);f.assertNoItemCapabilities();
});
