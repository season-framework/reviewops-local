'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createNativeCaptureLease}=require('../electron/browser-capture.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(previous=true){
 const contents=Object.assign(new EventEmitter(),{destroyed:false,crashed:false,throttling:previous,calls:[],isDestroyed(){return this.destroyed;},isCrashed(){return this.crashed;},getBackgroundThrottling(){return this.throttling;},setBackgroundThrottling(value){this.calls.push(value);this.throttling=value;}});
 let available=true;
 return {contents,lease:createNativeCaptureLease(contents,{alive:()=>available&&!contents.crashed}),available:value=>{available=value;}};
}
const noListeners=contents=>{assert.equal(contents.listenerCount('destroyed'),0);assert.equal(contents.listenerCount('render-process-gone'),0);};

test('native image identity survives a target-only lease and its original true setting is restored',async()=>{
 const {contents,lease}=fixture(),other=fixture(),native=deferred(),image={original:'native-image'};
 const capture=lease.capture(()=>{assert.equal(contents.throttling,false);assert.equal(other.contents.throttling,true);return native.promise;});
 assert.deepEqual(contents.calls,[false]);native.resolve(image);assert.equal(await capture,image);assert.deepEqual(contents.calls,[false,true]);assert.equal(contents.throttling,true);noListeners(contents);
});

test('native rejection and synchronous throw retain the original error and restore the setting',async t=>{
 for(const sync of [false,true])await t.test(sync?'sync throw':'async rejection',async()=>{
  const {contents,lease}=fixture(),error=new Error('original capture failure');
  await assert.rejects(lease.capture(()=>{if(sync)throw error;return Promise.reject(error);}),value=>value===error);
  assert.deepEqual(contents.calls,[false,true]);assert.equal(contents.throttling,true);noListeners(contents);
 });
});

test('a target that was already unthrottled is left false without setter calls',async()=>{
 const {contents,lease}=fixture(false),image={original:true};assert.equal(await lease.capture(()=>image),image);assert.equal(contents.throttling,false);assert.deepEqual(contents.calls,[]);noListeners(contents);
});

test('a second request is rejected instead of sharing pixels or starting another native capture',async()=>{
 const {contents,lease}=fixture(),native=deferred();let calls=0;
 const first=lease.capture(()=>{calls++;return native.promise;});await assert.rejects(lease.capture(()=>{calls++;return 'wrong';}),{code:'CAPTURE_BUSY'});assert.equal(calls,1);assert.equal(contents.throttling,false);
 native.resolve('first');assert.equal(await first,'first');assert.equal(await lease.capture(()=>{calls++;return 'next';}),'next');assert.equal(calls,2);assert.deepEqual(contents.calls,[false,true,false,true]);noListeners(contents);
});

test('independent target leases neither block nor restore another WebContents',async()=>{
 const a=fixture(),b=fixture(),one=deferred(),two=deferred();const first=a.lease.capture(()=>one.promise),second=b.lease.capture(()=>two.promise);
 one.resolve('A');assert.equal(await first,'A');assert.equal(a.contents.throttling,true);assert.equal(b.contents.throttling,false);two.resolve('B');assert.equal(await second,'B');assert.equal(b.contents.throttling,true);
});

test('destroying a source settles its caller and never calls a setter on dead contents',async()=>{
 const {contents,lease}=fixture(),native=deferred(),capture=lease.capture(()=>native.promise),rejected=assert.rejects(capture,{code:'SESSION_GONE'});
 contents.destroyed=true;contents.emit('destroyed');await rejected;assert.deepEqual(contents.calls,[false]);noListeners(contents);
 native.reject(new Error('late native rejection'));await Promise.resolve();await assert.rejects(lease.capture(()=>assert.fail('dead source captured')),{code:'SESSION_GONE'});assert.deepEqual(contents.calls,[false]);
});

test('renderer exit cancels a capture and late old completion cannot restore a recovered lease',async t=>{
 for(const rejectLate of [false,true])for(const afterFresh of [false,true])await t.test(`${rejectLate?'reject':'resolve'} late ${afterFresh?'after':'during'} fresh capture`,async()=>{
  const f=fixture(),old=deferred(),fresh=deferred(),first=f.lease.capture(()=>old.promise),rejected=assert.rejects(first,{code:'SESSION_GONE'});
  f.available(false);f.contents.emit('render-process-gone');await rejected;assert.equal(f.contents.throttling,true);noListeners(f.contents);
  await assert.rejects(f.lease.capture(()=>assert.fail('unrecovered source captured')),{code:'SESSION_GONE'});
  f.available(true);const second=f.lease.capture(()=>fresh.promise);assert.equal(f.contents.throttling,false);
  if(afterFresh){fresh.resolve('new');assert.equal(await second,'new');}
  if(rejectLate)old.reject(new Error('old raw rejection'));else old.resolve('old raw image');await Promise.resolve();await Promise.resolve();
  assert.equal(f.contents.throttling,afterFresh);assert.deepEqual(f.contents.calls,afterFresh?[false,true,false,true]:[false,true,false]);
  if(!afterFresh){assert.equal(f.contents.listenerCount('render-process-gone'),1);fresh.resolve('new');assert.equal(await second,'new');}
  assert.equal(f.contents.throttling,true);noListeners(f.contents);
 });
});

test('lifecycle listeners are installed before an unthrottling setter can reenter',async()=>{
 const {contents,lease}=fixture(),set=contents.setBackgroundThrottling;let nativeCalls=0;
 contents.setBackgroundThrottling=function(value){set.call(this,value);if(value===false)this.emit('render-process-gone');};
 await assert.rejects(lease.capture(()=>{nativeCalls++;return 'must not capture';}),{code:'SESSION_GONE'});assert.equal(nativeCalls,0);assert.deepEqual(contents.calls,[false,true]);noListeners(contents);
});

test('a setter failure restores a partially applied change and does not start capture',async()=>{
 const {contents,lease}=fixture(),error=new Error('setter failed'),set=contents.setBackgroundThrottling;
 contents.setBackgroundThrottling=function(value){set.call(this,value);if(value===false)throw error;};
 await assert.rejects(lease.capture(()=>assert.fail('capture called')),value=>value===error);assert.equal(contents.throttling,true);assert.deepEqual(contents.calls,[false,true]);noListeners(contents);
});

test('a failed restoration cannot replace the original error and is retried before a recovered lease',async()=>{
 const f=fixture(),old=deferred(),nativeError=new Error('native failed'),restoreError=new Error('renderer cannot restore yet'),set=f.contents.setBackgroundThrottling;let restorationBlocked=true;
 f.contents.setBackgroundThrottling=function(value){if(value&&restorationBlocked){this.calls.push(value);throw restoreError;}set.call(this,value);};
 const first=f.lease.capture(()=>old.promise);old.reject(nativeError);await assert.rejects(first,value=>value===nativeError);noListeners(f.contents);
 await assert.rejects(f.lease.capture(()=>assert.fail('capture before restoration')),value=>value===restoreError);restorationBlocked=false;
 const fresh=deferred(),second=f.lease.capture(()=>fresh.promise);assert.equal(f.contents.throttling,false);fresh.resolve('fresh');assert.equal(await second,'fresh');assert.equal(f.contents.throttling,true);noListeners(f.contents);
});

test('success with an unrecoverable restore failure rejects instead of accepting an unrestored lease',async()=>{
 const {contents,lease}=fixture(),error=new Error('restore failed'),set=contents.setBackgroundThrottling;
 contents.setBackgroundThrottling=function(value){if(value)throw error;set.call(this,value);};await assert.rejects(lease.capture(()=>({image:true})),value=>value===error);noListeners(contents);
});

test('source exit during the final restoration cannot return a successful stale image',async t=>{
 for(const event of ['destroyed','render-process-gone'])await t.test(event,async()=>{
  const {contents,lease}=fixture(),set=contents.setBackgroundThrottling;
  contents.setBackgroundThrottling=function(value){set.call(this,value);if(value){if(event==='destroyed')this.destroyed=true;this.emit(event);}};
  await assert.rejects(lease.capture(()=>({oldImage:true})),{code:'SESSION_GONE'});noListeners(contents);
 });
});
