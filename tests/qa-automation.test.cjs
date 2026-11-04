'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createQaAutomation}=require('../electron/qa-automation.cjs');
function fixture(){
  const records=new Map(),commands=[];let time=1,gate;
  const create=projectId=>{
    const contents={isDestroyed:()=>false,debugger:{isAttached:()=>true,sendCommand:async(method,args)=>{commands.push({projectId,method,args});if(projectId==='a'&&gate)await gate;}},executeJavaScript:async()=>false};
    const record={id:'window-'+projectId,projectId,host:{webContents:contents,isDestroyed:()=>false,close(){this.isDestroyed=()=>true;}}};records.set(record.id,record);return record;
  };
  const api=createQaAutomation({getProject:id=>['a','b'].includes(id),getWindow:id=>records.get(id),openWindow:async({projectId})=>create(projectId),now:()=>time,sessionTimeoutMs:100});
  return {api,records,commands,setTime:value=>time=value,setGate:value=>gate=value};
}
const only=({sessionId,projectId,windowId})=>({sessionId,projectId,windowId});
test('QA locks one project to a client and rejects another window identity',async()=>{
 const {api,commands}=fixture(),a=only(await api.handle('open',{projectId:'a',clientId:'codex-a'})),b=only(await api.handle('open',{projectId:'b',clientId:'codex-b'}));
 assert.deepEqual(only(await api.handle('open',{projectId:'a',clientId:'codex-a'})),a);
 await assert.rejects(api.handle('open',{projectId:'a',clientId:'claude-a'}),{code:'PROJECT_BUSY'});
 assert.throws(()=>api.handle('type',{...a,windowId:b.windowId,text:'wrong'}),{code:'SESSION_MISMATCH'});
 assert.throws(()=>api.handle('type',{...a,projectId:b.projectId,text:'wrong'}),{code:'SESSION_MISMATCH'});
 await assert.rejects(api.handle('type',{...a,browserId:'other',text:'wrong'}),{code:'TARGET_MISMATCH'});
 assert.equal(commands.length,0);
});
test('a blocked input in A does not delay B and same-project inputs retain order',async()=>{
 const f=fixture(),a=only(await f.api.handle('open',{projectId:'a',clientId:'codex-a'})),b=only(await f.api.handle('open',{projectId:'b',clientId:'claude-b'}));
 let unblock;f.setGate(new Promise(resolve=>unblock=resolve));
 const first=f.api.handle('type',{...a,text:'A-1'}),second=f.api.handle('type',{...a,text:'A-2'});
 await f.api.handle('type',{...b,text:'B'});
 assert.deepEqual(f.commands.map(c=>c.args.text),['A-1','B']);
 unblock();await Promise.all([first,second]);assert.deepEqual(f.commands.map(c=>c.args.text),['A-1','B','A-2']);
});
test('closed windows and released or expired sessions cannot receive input',async()=>{
 const f=fixture();let a=only(await f.api.handle('open',{projectId:'a',clientId:'codex-a'}));
 await f.api.handle('release',a);assert.throws(()=>f.api.handle('type',{...a,text:'bad'}),{code:'SESSION_MISMATCH'});
 a=only(await f.api.handle('open',{projectId:'a',clientId:'claude-a'}));f.setTime(102);
 assert.throws(()=>f.api.handle('type',{...a,text:'bad'}),{code:'SESSION_EXPIRED'});
 a=only(await f.api.handle('open',{projectId:'a',clientId:'claude-a'}));
 f.records.get(a.windowId).host.isDestroyed=()=>true;
 assert.throws(()=>f.api.handle('type',{...a,text:'bad'}),{code:'TARGET_CLOSED'});assert.equal(f.commands.length,0);
});
test('unsaved input blocks close and reload without global native prompts',async()=>{
 const f=fixture(),a=only(await f.api.handle('open',{projectId:'a',clientId:'codex-a'}));f.records.get(a.windowId).host.webContents.executeJavaScript=async()=>true;
 await assert.rejects(f.api.handle('close',a),{code:'UNSAVED_INPUT'});await assert.rejects(f.api.handle('reload',a),{code:'UNSAVED_INPUT'});
 assert.equal(f.records.get(a.windowId).host.isDestroyed(),false);
});
test('concurrent opens of a project share one pending initialization and recover failed opens',async()=>{
 let resolve,calls=0;const record={id:'window-a',projectId:'a',host:{isDestroyed:()=>false}};
 const api=createQaAutomation({getProject:()=>true,getWindow:()=>record,openWindow:async()=>{calls++;return new Promise(done=>resolve=done);}});
 const first=api.handle('open',{projectId:'a',clientId:'one'}),second=api.handle('open',{projectId:'a',clientId:'one'});
 resolve(record);assert.deepEqual(await first,await second);assert.equal(calls,1);
 let failures=0;const retry=createQaAutomation({getProject:()=>true,getWindow:()=>record,openWindow:async()=>{if(!failures++)throw new Error('failed');return record;}});
 await assert.rejects(retry.handle('open',{projectId:'a',clientId:'one'}),/failed/);assert.equal((await retry.handle('open',{projectId:'a',clientId:'two'})).windowId,'window-a');
});
test('same-client reconnect keeps the bound review and refreshes idle time',async()=>{
 const f=fixture(),a=only(await f.api.handle('open',{projectId:'a',clientId:'same',reviewId:'review-a'}));
 await assert.rejects(f.api.handle('open',{projectId:'a',clientId:'same',reviewId:'review-other'}),{code:'REVIEW_MISMATCH'});
 f.setTime(80);assert.deepEqual(only(await f.api.handle('open',{projectId:'a',clientId:'same',reviewId:'review-a'})),a);
 f.setTime(160);await f.api.handle('type',{...a,text:'alive'});
});
test('timed-out commands cannot share their old window with another session',async()=>{
 let done,record={id:'window-a',projectId:'a',host:{isDestroyed:()=>false,webContents:{isDestroyed:()=>false,debugger:{isAttached:()=>true,sendCommand:()=>new Promise(resolve=>done=resolve)}}}};
 const api=createQaAutomation({getProject:()=>true,getWindow:()=>record,openWindow:async()=>record,operationTimeoutMs:15});
 const a=only(await api.handle('open',{projectId:'a',clientId:'one'}));
 await assert.rejects(api.handle('type',{...a,text:'pending'}),{code:'QA_TIMEOUT'});
 await api.handle('release',a);
 await assert.rejects(api.handle('open',{projectId:'a',clientId:'two'}),{code:'QA_TARGET_UNAVAILABLE'});
 done();record.host.isDestroyed=()=>true;
 await assert.rejects(api.handle('open',{projectId:'a',clientId:'two'}),{code:'TARGET_CLOSED'});
 record={...record,id:'window-new',host:{...record.host,isDestroyed:()=>false}};
 assert.equal((await api.handle('open',{projectId:'a',clientId:'two'})).windowId,'window-new');
});

test('idle expiry removes the project UI scope without requiring another client request',async()=>{
 let time=1;const changed=[],record={id:'window-a',projectId:'a',host:{isDestroyed:()=>false}};
 const api=createQaAutomation({getProject:()=>true,getWindow:()=>record,openWindow:async()=>record,now:()=>time,sessionTimeoutMs:20,onActiveChange:(_record,active)=>changed.push(active)});
 try{
  await api.handle('open',{projectId:'a',clientId:'one'});assert.equal(record.qaActive,true);time=100;
  for(let attempt=0;attempt<20&&record.qaActive;attempt++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(record.qaActive,false);assert.deepEqual(changed,[true,false]);
 }finally{api.close();}
});

test('capability descriptions do not open, touch or release a project session',async()=>{
 const f=fixture();try{
  const expected={protocolVersion:1,actions:['open','state','click','type','key','scroll','capture','navigate','reload','close','release'],bindingFields:['sessionId','projectId','windowId'],optionalBrowserId:true,documentGeneration:false};
  const first=f.api.capabilities();assert.deepEqual(first,expected);assert.equal(f.records.size,0);assert.equal(f.commands.length,0);
  first.actions.push('focus');first.bindingFields.length=0;assert.deepEqual(f.api.capabilities(),expected);
  const a=only(await f.api.handle('open',{projectId:'a',clientId:'owner'}));
  f.setTime(80);assert.deepEqual(f.api.capabilities(),expected);
  await assert.rejects(f.api.handle('open',{projectId:'a',clientId:'other'}),{code:'PROJECT_BUSY'});
  f.setTime(102);f.api.capabilities();
  assert.throws(()=>f.api.handle('type',{...a,text:'expired'}),{code:'SESSION_EXPIRED'});
  assert.equal(f.commands.length,0);
 }finally{f.api.close();}
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function documentFixture(t,options={}){
 const {EventEmitter}=require('node:events'),commands=[],records=new Map(),scopes=[];
 class Contents extends EventEmitter{
  constructor(name){
   super();this.name=name;this.loading=false;this.destroyed=false;this.crashed=false;this.url='https://fixture.invalid/first';this.attached=true;this.attachments=0;
   this.debugger={isAttached:()=>this.attached,attach:()=>{this.attachments++;this.attached=true;},sendCommand:async(method,params)=>{commands.push({contents:this,method,params});return this.onCommand?.(method,params);}};
  }
  isDestroyed(){return this.destroyed;}
  isCrashed(){return this.crashed;}
  isLoadingMainFrame(){return this.loading;}
  getZoomFactor(){return 1;}
  async executeJavaScript(script){if(this.onScript)await this.onScript(script);return script.includes('scrollX')?{url:this.url,title:'Controlled page',text:'fixture',elements:[],viewport:{width:800,height:600},documentId:'page-forgery',contract:'page-forgery'}:{width:800,height:600};}
  async capturePage(){if(this.onCapture)await this.onCapture();const png=Buffer.alloc(24);png.writeUInt32BE(800,16);png.writeUInt32BE(600,20);return{isEmpty:()=>false,toPNG:()=>png};}
  navigate({details=true,main=true,same=false,url=this.url}={}){this.url=url;if(details)this.emit('did-start-navigation',{isMainFrame:main,isSameDocument:same,url});else this.emit('did-start-navigation',{},url,same,main);}
 }
 const create=projectId=>{const web=new Contents(projectId),record={id:'window-'+projectId,projectId,draft:'keep-'+projectId,terminalFixture:{connected:true},ready:null,web,targets:[],host:{isDestroyed:()=>false,webContents:new Contents('host-'+projectId)}};record.targets=[{browserId:'browser-'+projectId,contents:web,documentReady:true}];record.browsers={automationTargets:()=>record.targets.map(target=>({...target,ready:record.ready,inputScale:1}))};records.set(record.id,record);return record;};
 const api=createQaAutomation({getProject:projectId=>['A','B'].includes(projectId),getWindow:id=>records.get(id),openWindow:async({projectId})=>create(projectId),operationTimeoutMs:2000,onActiveChange:(record,active)=>scopes.push([record.id,active]),...options});
 t.after(()=>api.close());
 const bindings={A:only(await api.handle('open',{projectId:'A',clientId:'a'})),B:only(await api.handle('open',{projectId:'B',clientId:'b'}))};
 const call=(operation,extra={},project='B')=>api.handle('document',{...bindings[project],browserId:'browser-'+project,operation,...extra});
 const observe=async(project='B')=>call('state',{},project);
 return{api,records,commands,scopes,bindings,call,observe,Contents,get a(){return records.get('window-A');},get b(){return records.get('window-B');}};
}

test('document observations issue scoped app UUIDs and normal input retains the legacy contract',async t=>{
 const f=await documentFixture(t),state=await f.observe(),capture=await f.call('capture');
 assert.equal(state.contract,'observed-web-document-v1');assert.match(state.documentId,/^[a-f0-9-]{36}$/);assert.notEqual(state.documentId,'page-forgery');assert.equal(capture.documentId,state.documentId);assert.equal(capture.width,800);
 await f.call('type',{documentId:state.documentId,text:'normal'});await f.call('scroll',{documentId:state.documentId,x:1,y:2,deltaY:4});await f.call('click',{documentId:state.documentId,x:4,y:5});await f.call('key',{documentId:state.documentId,key:'Enter',modifiers:['Control']});
 assert.equal(f.commands.length,7);assert.ok(f.commands.every(row=>row.contents===f.b.web));
 assert.deepEqual(f.commands.slice(-2).map(row=>row.params.type),['keyDown','keyUp']);
 assert.equal(f.api.capabilities().documentGeneration,false);assert.equal(f.api.capabilities().actions.length,11);
 assert.equal((await f.api.handle('type',{...f.bindings.A,text:'legacy'})).applied,true);
 for(const extra of [{browserId:undefined},{operation:'navigate'},{documentId:state.documentId},{x:1}])await assert.rejects(async()=>f.call('state',extra));
 for(const extra of [{text:'missing token'},{documentId:'forged',text:'bad'},{documentId:state.documentId,text:'bad',unknown:true}])await assert.rejects(async()=>f.call('type',extra));
});

test('document tokens cannot cross browser or project membership even with shared contents',async t=>{
 const f=await documentFixture(t),state=await f.observe();f.b.targets.push({browserId:'alias',contents:f.b.web,documentReady:true});f.a.targets.push({browserId:'alias-A',contents:f.b.web,documentReady:true});
 const alias=await f.call('state',{browserId:'alias'}),other=await f.call('state',{browserId:'alias-A'},'A');assert.notEqual(alias.documentId,state.documentId);assert.notEqual(other.documentId,state.documentId);
 for(const [browserId,project]of [['alias','B'],['alias-A','A']])await assert.rejects(async()=>f.call('type',{browserId,documentId:state.documentId,text:'wrong'},project),{code:'QA_DOCUMENT_STALE'});
 assert.equal(f.commands.length,0);
});

test('navigation while target.ready is held rejects B before input while A continues',async t=>{
 const f=await documentFixture(t),b=await f.observe(),a=await f.observe('A'),entered=deferred(),hold=deferred();let pending;
 try{
  f.b.ready={then(resolve,reject){entered.resolve();return hold.promise.then(resolve,reject);}};
  pending=f.call('type',{documentId:b.documentId,text:'old'});const refused=assert.rejects(pending,{code:'QA_DOCUMENT_STALE'});
  await entered.promise;await f.call('type',{documentId:a.documentId,text:'A continues'},'A');f.b.web.navigate({url:'https://fixture.invalid/second'});hold.resolve();await refused;
  assert.equal(f.commands.filter(row=>row.contents===f.b.web).length,0);assert.equal(f.commands.length,1);assert.equal(f.a.draft,'keep-A');assert.deepEqual(f.a.terminalFixture,{connected:true});assert.equal(f.a.qaActive,true);
  const fresh=await f.observe();assert.notEqual(fresh.documentId,b.documentId);await f.call('type',{documentId:fresh.documentId,text:'new'});
 }finally{hold.resolve();await pending?.catch(()=>{});}
});

test('queued input and a held state observation both retain their original document',async t=>{
 const f=await documentFixture(t),state=await f.observe(),entered=deferred(),hold=deferred();let reading,pending;
 try{
  f.b.web.onScript=async()=>{entered.resolve();await hold.promise;};reading=f.observe();const readRefused=assert.rejects(reading,{code:'QA_DOCUMENT_STALE'});await entered.promise;
  pending=f.call('type',{documentId:state.documentId,text:'queued'});const inputRefused=assert.rejects(pending,{code:'QA_DOCUMENT_STALE'});
  f.b.web.navigate();hold.resolve();await Promise.all([readRefused,inputRefused]);assert.equal(f.commands.length,0);
 }finally{hold.resolve();await Promise.allSettled([reading,pending].filter(Boolean));}
});

test('target removal, replacement or a new readiness promise cannot pass a held original ready check',async t=>{
 for(const change of ['removed','replacement','ready'])await t.test(change,async t=>{
  const f=await documentFixture(t),state=await f.observe(),entered=deferred(),hold=deferred();let pending;
  try{
   f.b.ready={then(resolve,reject){entered.resolve();return hold.promise.then(resolve,reject);}};
   pending=f.call('type',{documentId:state.documentId,text:'not sent'});const refused=assert.rejects(pending,{code:change==='ready'?'QA_DOCUMENT_NOT_READY':'QA_DOCUMENT_STALE'});await entered.promise;
   if(change==='removed')f.b.targets=[];else if(change==='replacement')f.b.targets=[{browserId:'browser-B',contents:new f.Contents('replacement')}];else f.b.ready=Promise.resolve();
   hold.resolve();await refused;assert.equal(f.commands.length,0);
  }finally{hold.resolve();await pending?.catch(()=>{});}
 });
});

test('capture fences capturePage and the separate viewport await',async t=>{
 for(const phase of ['capture','viewport'])await t.test(phase,async t=>{
  const f=await documentFixture(t),entered=deferred(),hold=deferred();let pending,scripts=0;
  try{
   f.b.web.onCapture=async()=>{if(phase==='capture'){entered.resolve();await hold.promise;}};
   f.b.web.onScript=async()=>{scripts++;if(phase==='viewport'){entered.resolve();await hold.promise;}};
   pending=f.call('capture');const refused=assert.rejects(pending,{code:'QA_DOCUMENT_STALE'});await entered.promise;f.b.web.navigate();hold.resolve();await refused;
   assert.equal(scripts,phase==='capture'?0:1);assert.equal(f.commands.length,0);
  }finally{hold.resolve();await pending?.catch(()=>{});}
 });
});

test('same URL, same-document and positional main-frame navigation roll pins; subframes do not',async t=>{
 const f=await documentFixture(t);let previous=await f.observe();
 f.b.web.navigate({main:false});assert.equal((await f.observe()).documentId,previous.documentId);
 for(const event of [{same:true},{details:false},{url:'https://fixture.invalid/new'}]){
  f.b.web.navigate(event);const current=await f.observe();assert.notEqual(current.documentId,previous.documentId);await assert.rejects(async()=>f.call('type',{documentId:previous.documentId,text:'stale'}),{code:'QA_DOCUMENT_STALE'});previous=current;
 }
 f.b.web.loading=true;await assert.rejects(async()=>f.observe(),{code:'QA_DOCUMENT_NOT_READY'});f.b.web.loading=false;
 f.b.web.emit('render-process-gone');await assert.rejects(async()=>f.observe(),{code:'QA_DOCUMENT_NOT_READY'});f.b.web.emit('did-finish-load');const recovered=await f.observe();assert.notEqual(recovered.documentId,previous.documentId);
 const old=f.b.web;old.destroyed=true;old.emit('destroyed');f.b.web=new f.Contents('replacement');f.b.targets=[{browserId:'browser-B',contents:f.b.web,documentReady:true}];
 await assert.rejects(async()=>f.call('type',{documentId:recovered.documentId,text:'old contents'}),{code:'QA_DOCUMENT_STALE'});assert.notEqual((await f.observe()).documentId,recovered.documentId);assert.equal(f.commands.length,0);
});

test('a first observation respects retained manager crash state even when isCrashed is false',async t=>{
 const f=await documentFixture(t);delete f.b.targets[0].documentReady;
 await assert.rejects(async()=>f.observe(),{code:'QA_DOCUMENT_NOT_READY'});f.b.targets[0].documentReady=false;
 assert.equal(f.b.web.isCrashed(),false);await assert.rejects(async()=>f.observe(),{code:'QA_DOCUMENT_NOT_READY'});assert.equal(f.commands.length,0);
 f.b.targets[0].documentReady=true;assert.equal((await f.observe()).contract,'observed-web-document-v1');
});

test('document request primitives and modifiers are captured before waiting',async t=>{
 const f=await documentFixture(t),state=await f.observe(),entered=deferred(),hold=deferred();let pending;
 try{
  f.b.ready={then(resolve,reject){entered.resolve();return hold.promise.then(resolve,reject);}};
  const modifiers=['Control'],request={...f.bindings.B,browserId:'browser-B',operation:'key',documentId:state.documentId,key:'A',modifiers};pending=f.api.handle('document',request);await entered.promise;
  request.key='B';request.documentId='forged';modifiers.push('Shift');hold.resolve();await pending;
  assert.deepEqual(f.commands.map(row=>[row.params.type,row.params.key,row.params.modifiers]),[['keyDown','A',2],['keyUp','A',2]]);
 }finally{hold.resolve();await pending?.catch(()=>{});}
});

test('the first CDP attempt including mouseMoved makes later navigation uncertain without replay',async t=>{
 for(const operation of ['type','scroll','click'])await t.test(operation,async t=>{
  const f=await documentFixture(t),state=await f.observe();f.b.web.onCommand=()=>f.b.web.navigate();
  await assert.rejects(f.call(operation,{documentId:state.documentId,...(operation==='type'?{text:'one'}:{x:1,y:2,...(operation==='scroll'?{deltaY:1}:{})})}),error=>error.code==='QA_DOCUMENT_CHANGED_AFTER_INPUT'&&error.inputMayHaveApplied===true&&error.cause.code==='QA_DOCUMENT_STALE'&&/do not replay/.test(error.message));
  assert.equal(f.commands.length,1);assert.equal(f.commands[0].params.type,operation==='click'?'mouseMoved':operation==='scroll'?'mouseWheel':undefined);
 });
});

test('press and keyDown always attempt only the matching release on the original contents',async t=>{
 for(const operation of ['click','key'])await t.test(operation,async t=>{
  const f=await documentFixture(t),state=await f.observe(),original=f.b.web;let replacement;
  original.onCommand=(_method,params)=>{if(['mousePressed','keyDown'].includes(params.type)){replacement=new f.Contents('new');f.b.web=replacement;f.b.targets=[{browserId:'browser-B',contents:replacement}];original.navigate();}};
  await assert.rejects(f.call(operation,{documentId:state.documentId,...(operation==='click'?{x:1,y:2}:{key:'Enter'})}),{code:'QA_DOCUMENT_CHANGED_AFTER_INPUT'});
  assert.ok(f.commands.every(row=>row.contents===original));assert.equal(f.commands.at(-1).params.type,operation==='click'?'mouseReleased':'keyUp');assert.equal(replacement.attachments,0);
 });
});

test('a rejected press retains its primary failure and still releases the same original target',async t=>{
 const f=await documentFixture(t),state=await f.observe();f.b.web.onCommand=(_method,params)=>{if(params.type==='keyDown')throw Object.assign(new Error('controlled down failure'),{code:'CDP_DOWN_FAILED'});};
 await assert.rejects(f.call('key',{documentId:state.documentId,key:'Enter'}),error=>error.code==='QA_DOCUMENT_CHANGED_AFTER_INPUT'&&error.cause.code==='CDP_DOWN_FAILED');
 assert.deepEqual(f.commands.map(row=>row.params.type),['keyDown','keyUp']);
});

test('failed matching release retains primary plus cleanup errors and quarantines the original window',async t=>{
 const f=await documentFixture(t),state=await f.observe();f.b.web.onCommand=(_method,params)=>{if(params.type==='keyDown')f.b.web.navigate();if(params.type==='keyUp')throw Object.assign(new Error('controlled release failure'),{code:'CDP_RELEASE_FAILED'});};
 await assert.rejects(f.call('key',{documentId:state.documentId,key:'Enter'}),error=>error.code==='QA_DOCUMENT_CHANGED_AFTER_INPUT'&&error.cause.code==='QA_DOCUMENT_STALE'&&error.cleanupError.code==='CDP_RELEASE_FAILED'&&/QA_DOCUMENT_STALE/.test(error.message)&&/CDP_RELEASE_FAILED/.test(error.message));
 assert.deepEqual(f.api.connectionStatus({projectId:'B',binding:f.bindings.B}),{projectId:'B',availability:'quarantined',bindingState:'unavailable'});
 await assert.rejects(async()=>f.observe(),{code:'QA_TARGET_UNAVAILABLE'});assert.throws(()=>f.api.handle('type',{...f.bindings.B,text:'legacy bypass'}),{code:'QA_TARGET_UNAVAILABLE'});
 await f.api.handle('release',f.bindings.B);await assert.rejects(f.api.handle('open',{projectId:'B',clientId:'replacement'}),{code:'QA_TARGET_UNAVAILABLE'});assert.equal(f.a.qaActive,true);
});

test('debugger loss never reattaches cleanup to a new debugger session',async t=>{
 const f=await documentFixture(t),state=await f.observe(),original=f.b.web;original.onCommand=(_method,params)=>{if(params.type==='keyDown'){original.attached=false;throw Object.assign(new Error('detached'),{code:'DEBUGGER_GONE'});}};
 await assert.rejects(f.call('key',{documentId:state.documentId,key:'Enter'}),error=>error.cause.code==='DEBUGGER_GONE'&&error.cleanupError.code==='QA_RELEASE_TARGET_GONE');
 assert.equal(original.attachments,0);assert.deepEqual(f.commands.map(row=>row.params.type),['keyDown']);assert.equal(f.api.connectionStatus({projectId:'B'}).availability,'quarantined');
});

test('navigation emitted synchronously by debugger attach is refused before any input invocation',async t=>{
 const f=await documentFixture(t),state=await f.observe(),web=f.b.web;web.attached=false;web.debugger.attach=()=>{web.attachments++;web.attached=true;web.navigate();};
 await assert.rejects(f.call('type',{documentId:state.documentId,text:'not sent'}),{code:'QA_DOCUMENT_STALE'});
 assert.equal(web.attachments,1);assert.equal(f.commands.length,0);assert.equal(f.api.connectionStatus({projectId:'B',binding:f.bindings.B}).bindingState,'attached');
});

test('timeout while matched release is pending retains its first cause after late success or failure',async t=>{
 for(const rejectLate of [false,true])await t.test(rejectLate?'late release failure':'late release success',async t=>{
  const f=await documentFixture(t,{operationTimeoutMs:20}),state=await f.observe(),entered=deferred(),hold=deferred();let pending;
  try{
   f.b.web.onCommand=async(_method,params)=>{if(params.type==='keyUp'){entered.resolve();await hold.promise;if(rejectLate)throw Object.assign(new Error('late release failure'),{code:'LATE_RELEASE_FAILED'});}};
   pending=f.call('key',{documentId:state.documentId,key:'Enter'});const timedOut=assert.rejects(pending,error=>error.code==='QA_TIMEOUT'&&error.inputMayHaveApplied===true&&/do not replay/.test(error.message));await entered.promise;await timedOut;
   assert.equal(f.api.connectionStatus({projectId:'B',binding:f.bindings.B}).bindingState,'timed_out');hold.resolve();await new Promise(resolve=>setImmediate(resolve));
   assert.equal(f.api.connectionStatus({projectId:'B',binding:f.bindings.B}).bindingState,'timed_out');await assert.rejects(async()=>f.observe(),{code:'QA_TARGET_UNAVAILABLE'});assert.deepEqual(f.commands.map(row=>row.params.type),['keyDown','keyUp']);
  }finally{hold.resolve();await pending?.catch(()=>{});}
 });
});

test('a late failed matching release quarantines its original window after explicit lease release',async t=>{
 const f=await documentFixture(t,{operationTimeoutMs:20}),state=await f.observe(),entered=deferred(),hold=deferred();let pending;
 try{
  f.b.web.onCommand=async(_method,params)=>{if(params.type==='keyUp'){entered.resolve();await hold.promise;throw new Error('late cleanup failure');}};
  pending=f.call('key',{documentId:state.documentId,key:'Enter'});const timedOut=assert.rejects(pending,{code:'QA_TIMEOUT'});await entered.promise;await timedOut;
  await f.api.handle('release',f.bindings.B);hold.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.b.qaActive,true);assert.equal(f.api.connectionStatus({projectId:'B'}).availability,'quarantined');await assert.rejects(f.api.handle('open',{projectId:'B',clientId:'other'}),{code:'QA_TARGET_UNAVAILABLE'});assert.equal(f.a.qaActive,true);
 }finally{hold.resolve();await pending?.catch(()=>{});}
});
