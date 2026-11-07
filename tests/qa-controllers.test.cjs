'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createQaAutomation}=require('../electron/qa-automation.cjs');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(t,options={}){
 const records=new Map(),commands=[],events=[];let time=1000,birth=1,number=0;
 class Contents extends EventEmitter{
  constructor(name){super();this.name=name;this.destroyed=false;this.loading=false;this.url='https://fixture.invalid/'+name;this.debugger={isAttached:()=>true,sendCommand:async(method,params)=>{commands.push({contents:this,method,params});await this.onCommand?.(method,params);return {};}};}
  isDestroyed(){return this.destroyed;}isCrashed(){return false;}isLoadingMainFrame(){return this.loading;}getZoomFactor(){return 1;}getURL(){return this.url;}
  async executeJavaScript(script){await this.onScript?.();if(script.includes('reviewopsDirty'))return false;return script.includes('scrollX')?{url:this.url,title:this.name,text:'Controlled fixture',elements:[],viewport:{width:800,height:600,scrollX:0,scrollY:0}}:{width:800,height:600};}
  async capturePage(){const png=Buffer.alloc(24);png.writeUInt32BE(800,16);png.writeUInt32BE(600,20);return {isEmpty:()=>false,toPNG:()=>png};}
  reload(){this.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});this.emit('did-finish-load');}
 }
 const api=createQaAutomation({appInstanceId:crypto.randomUUID(),getProject:id=>['A','B'].includes(id),getWindow:id=>records.get(id),now:()=>time,sessionTimeoutMs:1000,operationTimeoutMs:100,
  captureControllerTarget:()=>{const original=birth;return()=>{if(original!==birth)throw Object.assign(new Error('Original project replaced'),{code:'QA_CONTROLLER_STALE'});};},
  openWindow:async({projectId})=>{let record=[...records.values()].find(r=>r.projectId===projectId&&!r.host.isDestroyed());if(record)return record;
   const host=new Contents('host-'+projectId),web=new Contents('web-'+projectId);record={id:'window-'+(++number),projectId,draft:'unsaved-'+projectId,sshKeepalive:{connected:true},host:{webContents:host,isDestroyed:()=>host.destroyed},web};
   record.browsers={automationTargets:()=>[{browserId:'browser-'+projectId,contents:web,documentReady:true,ready:record.ready,inputScale:1,url:web.url,title:'Fixture',visible:true,bounds:record.bounds,clip:record.clip}]};records.set(record.id,record);return record;},
  onControllerChange:(windowId,value)=>events.push({windowId,value}),...options});t.after(()=>api.close());
 const call=(binding,operation,extra={})=>api.handle('controller',{operation,projectId:binding.projectId,appInstanceId:binding.appInstanceId,controllerId:binding.controllerId,controllerProof:binding.controllerProof,...extra});
 const open=projectId=>api.handle('controller',{operation:'open',projectId,label:'Chat '+projectId});
 return {api,records,commands,events,call,open,record:b=>records.get(b.windowId),setTime:value=>time=value,replaceProject:()=>birth++};
}
test('logical B detach/reconnect/release keeps A lease, window, draft and independent work',async t=>{
 const f=fixture(t),a=await f.open('A'),b=await f.open('B'),aBefore=await f.call(a,'status'),aWindow=f.record(a);
 const aObservation=await f.call(a,'state',{browserId:'browser-A'}),old=await f.call(b,'state',{browserId:'browser-B'});
 assert.equal((await f.call(b,'detach')).state,'detached');await assert.rejects(f.call(b,'state'),{code:'QA_CONTROLLER_DETACHED'});
 const recovered=await f.call(b,'reconnect');assert.equal(recovered.sessionId,b.sessionId);assert.equal(recovered.windowId,b.windowId);
 await assert.rejects(f.call(b,'type',{browserId:'browser-B',observationId:old.observationId,text:'stale'}),{code:'QA_CONTROLLER_OBSERVATION_REQUIRED'});
 const fresh=await f.call(b,'state',{browserId:'browser-B'});await f.call(b,'type',{browserId:'browser-B',observationId:fresh.observationId,text:'B recovered'});
 await f.call(a,'type',{browserId:'browser-A',observationId:aObservation.observationId,text:'A continues'});
 assert.equal((await f.call(b,'release')).state,'released');assert.deepEqual(await f.call(a,'status'),aBefore);assert.equal(f.record(a),aWindow);assert.equal(aWindow.draft,'unsaved-A');assert.deepEqual(aWindow.sshKeepalive,{connected:true});assert.equal(aWindow.qaActive,true);
 await assert.rejects(async()=>f.call(b,'reconnect'),{code:'QA_CONTROLLER_PROOF_REFUSED'});
});
test('app-issued proof cannot cross app, project or controller and returned IDs cannot use legacy routes',async t=>{
 const f=fixture(t),a=await f.open('A'),b=await f.open('B');
 for(const extra of [{appInstanceId:crypto.randomUUID()},{projectId:'A'},{controllerId:a.controllerId},{controllerProof:crypto.randomBytes(32).toString('base64url')}])await assert.rejects(async()=>f.call(b,'status',extra),{code:'QA_CONTROLLER_PROOF_REFUSED'});
 const ids={sessionId:b.sessionId,windowId:b.windowId,projectId:b.projectId};
 for(const action of ['state','type','release','document'])assert.throws(()=>f.api.handle(action,{...ids,text:'wrong',operation:'state',browserId:'browser-B'}),{code:'QA_CONTROLLER_PROOF_REQUIRED'});
 await assert.rejects(f.api.handle('open',{projectId:'B',clientId:b.clientId}),{code:'QA_CONTROLLER_PROOF_REQUIRED'});
 assert.equal(f.commands.length,0);assert.equal((await f.call(a,'status')).state,'attached');
 const publicText=JSON.stringify(f.events);for(const value of [a.controllerProof,b.controllerProof,a.controllerId,b.controllerId,a.sessionId,b.sessionId,a.clientId,b.clientId])assert.equal(publicText.includes(value),false);
});
test('host observations follow actual external reload/navigation and do not change the legacy web-only contract',async t=>{
 const f=fixture(t),b=await f.open('B'),host=f.record(b).host.webContents,first=await f.call(b,'state');assert.equal(first.browsers[0].browserId,'browser-B');
 host.reload();await assert.rejects(f.call(b,'type',{observationId:first.observationId,text:'old host'}),{code:'QA_DOCUMENT_STALE'});
 const second=await f.call(b,'capture');await f.call(b,'type',{observationId:second.observationId,text:'fresh host'});
 host.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});await assert.rejects(f.call(b,'type',{observationId:second.observationId,text:'old navigation'}),{code:'QA_DOCUMENT_STALE'});
 const legacy=await f.api.handle('open',{projectId:'A',clientId:'legacy'});assert.throws(()=>f.api.handle('document',{sessionId:legacy.sessionId,projectId:'A',windowId:legacy.windowId,operation:'state'}),{code:'INVALID_REQUEST'});
 assert.equal(f.api.capabilities().actions.length,11);assert.equal(f.api.capabilities().documentGeneration,false);
});
test('zoomed host observations describe child surfaces in host CSS coordinates',async t=>{
 const f=fixture(t),b=await f.open('B'),record=f.record(b);record.host.webContents.getZoomFactor=()=>2;record.bounds={x:20,y:40,width:400,height:600};record.clip={x:20,y:40,width:300,height:500};
 const state=await f.call(b,'state');assert.deepEqual(state.browsers[0].bounds,{x:10,y:20,width:200,height:300});assert.deepEqual(state.browsers[0].clip,{x:10,y:20,width:150,height:250});
});
test('normal B window recreation reconnects only B and refuses all old observations',async t=>{
 const f=fixture(t),a=await f.open('A'),b=await f.open('B'),aWindow=f.record(a),old=await f.call(b,'state',{browserId:'browser-B'});
 f.record(b).host.webContents.destroyed=true;f.record(b).host.webContents.emit('destroyed');
 const newB=await f.call(b,'reconnect');assert.notEqual(newB.windowId,b.windowId);assert.notEqual(newB.sessionId,b.sessionId);assert.equal(f.record(a),aWindow);
 await assert.rejects(f.call(b,'type',{browserId:'browser-B',observationId:old.observationId,text:'wrong old target'}),{code:'QA_CONTROLLER_OBSERVATION_REQUIRED'});
 const fresh=await f.call(b,'state',{browserId:'browser-B'});await f.call(b,'type',{browserId:'browser-B',observationId:fresh.observationId,text:'new B'});assert.equal(aWindow.draft,'unsaved-A');assert.equal(aWindow.qaActive,true);
});
test('B detach fences queued and waiting input while A remains executable',async t=>{
 const f=fixture(t),a=await f.open('A'),b=await f.open('B'),aState=await f.call(a,'state',{browserId:'browser-A'}),bState=await f.call(b,'state',{browserId:'browser-B'}),entered=deferred(),gate=deferred();
 f.record(b).ready={then(resolve,reject){entered.resolve();return gate.promise.then(resolve,reject);}};
 const waiting=f.call(b,'type',{browserId:'browser-B',observationId:bState.observationId,text:'must not enter'}),refused=assert.rejects(waiting,{code:'QA_CONTROLLER_STALE'});await entered.promise;
 await f.call(b,'detach');await f.call(a,'type',{browserId:'browser-A',observationId:aState.observationId,text:'A while B waits'});gate.resolve();await refused;
 assert.equal(f.commands.length,1);assert.equal(f.commands[0].contents,f.record(a).web);
});
test('proof expiry, replaced target and timeout quarantine cannot be recovered or replayed',async t=>{
 const f=fixture(t,{operationTimeoutMs:15}),a=await f.open('A'),b=await f.open('B'),seen=await f.call(b,'state',{browserId:'browser-B'}),gate=deferred();
 f.record(b).web.onCommand=()=>gate.promise;
 try{
  await assert.rejects(f.call(b,'type',{browserId:'browser-B',observationId:seen.observationId,text:'uncertain'}),{code:'QA_TIMEOUT'});
  await assert.rejects(f.call(b,'reconnect'),{code:'QA_TARGET_UNAVAILABLE'});assert.equal(f.commands.length,1);assert.equal(f.record(b).host.isDestroyed(),false);assert.equal((await f.call(a,'status')).state,'attached');
 }finally{gate.resolve();}
 f.replaceProject();await assert.rejects(async()=>f.call(a,'status'),{code:'QA_CONTROLLER_STALE'});
 const expiring=fixture(t),proof=await expiring.open('B');expiring.setTime(2001);await assert.rejects(async()=>expiring.call(proof,'reconnect'),{code:'QA_CONTROLLER_EXPIRED'});assert.equal(expiring.commands.length,0);
});
test('queued controller input retains the admitted text and modifier snapshot',async t=>{
 const f=fixture(t),b=await f.open('B'),observation=await f.call(b,'state',{browserId:'browser-B'}),entered=deferred(),gate=deferred();
 f.record(b).web.onScript=async()=>{entered.resolve();await gate.promise;};const reading=f.call(b,'state',{browserId:'browser-B'});await entered.promise;
 const base={projectId:b.projectId,appInstanceId:b.appInstanceId,controllerId:b.controllerId,controllerProof:b.controllerProof,browserId:'browser-B',observationId:observation.observationId};
 const text={...base,operation:'type',text:'Original input'},key={...base,operation:'key',key:'Enter',modifiers:['Control']};
 const typing=f.api.handle('controller',text),pressing=f.api.handle('controller',key);text.text='Changed after admission';key.key='Delete';key.modifiers.push('Shift');gate.resolve();await Promise.all([reading,typing,pressing]);
 assert.equal(f.commands[0].params.text,'Original input');assert.deepEqual(f.commands.slice(1).map(row=>[row.params.key,row.params.modifiers]),[['Enter',2],['Enter',2]]);
});
