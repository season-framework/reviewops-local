'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const modules=async()=>({...await import('../src/service-runtime-draft.mjs'),...await import('../src/window-context.mjs')});
const saved={executable:'/node',entry:'server.cjs',args:['--port','3000'],readinessUrl:'http://127.0.0.1:3000/'};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function registration(createServiceRuntimeDraft,dirtyTabSet,binding='A'){
 const reports=[],dataset={reviewopsDirty:'false'},tabs=dirtyTabSet(value=>{dataset.reviewopsDirty=String(value);});
 const dirtyParts={review:false,'service-runtime':false};
 const controller=createServiceRuntimeDraft(binding,value=>{reports.push(value);dirtyParts['service-runtime']=value;if(Object.values(dirtyParts).some(Boolean))tabs.add('project');else tabs.delete('project');});
 return {controller,reports,dataset,tabs,dirtyParts};
}
test('actual Node draft change/poll/revert handlers register and clear the existing dirty tab guard',async()=>{
 const {createServiceRuntimeDraft,dirtyTabSet}=await modules(),r=registration(createServiceRuntimeDraft,dirtyTabSet);r.controller.accept(saved);
 assert.equal(r.tabs.size,0);r.controller.change('entry','unsaved.cjs');assert.equal(r.dataset.reviewopsDirty,'true');assert.equal(r.tabs.has('project'),true);
 const polled=r.controller.accept({...saved});assert.equal(polled.draft.entry,'unsaved.cjs');assert.equal(polled.dirty,true);assert.deepEqual(r.reports,[true]);
 r.controller.change('entry','server.cjs');assert.equal(r.dataset.reviewopsDirty,'false');assert.equal(r.tabs.size,0);assert.deepEqual(r.reports,[true,false]);
});
test('failed async configure keeps the edited fields, saved baseline and dirty registration',async()=>{
 const {createServiceRuntimeDraft,dirtyTabSet}=await modules(),r=registration(createServiceRuntimeDraft,dirtyTabSet);r.controller.accept(saved);r.controller.change('entry','retry.cjs');
 const pending=deferred(),saving=r.controller.save(()=>pending.promise);pending.reject(new Error('configuration rejected'));await assert.rejects(saving,/rejected/);
 assert.equal(r.controller.snapshot().draft.entry,'retry.cjs');assert.equal(r.controller.snapshot().dirty,true);assert.equal(r.dataset.reviewopsDirty,'true');
 r.controller.accept(saved);assert.equal(r.controller.snapshot().dirty,true);r.controller.change('entry',saved.entry);assert.equal(r.tabs.size,0);
});
test('successful configure adopts the actual normalized saved baseline and clears only that submitted draft',async()=>{
 const {createServiceRuntimeDraft,dirtyTabSet}=await modules(),r=registration(createServiceRuntimeDraft,dirtyTabSet);r.controller.accept(saved);r.controller.change('readinessUrl','http://127.0.0.1:4000');
 await r.controller.save(async()=>({config:{...saved,readinessUrl:'http://127.0.0.1:4000/'}}));
 assert.equal(r.controller.snapshot().draft.readinessUrl,'http://127.0.0.1:4000/');assert.equal(r.controller.snapshot().dirty,false);assert.equal(r.dataset.reviewopsDirty,'false');
 r.controller.change('readinessUrl',saved.readinessUrl);assert.equal(r.controller.snapshot().dirty,true,'Previous baseline must no longer count as saved');
});
test('a late successful configure preserves newer edits and polls cannot clear them',async()=>{
 const {createServiceRuntimeDraft,dirtyTabSet}=await modules(),r=registration(createServiceRuntimeDraft,dirtyTabSet);r.controller.accept(saved);r.controller.change('entry','submitted.cjs');
 const pending=deferred(),saving=r.controller.save(()=>pending.promise);r.controller.change('entry','newer.cjs');r.controller.change('argsText','["newer"]');
 const accepted={...saved,entry:'submitted.cjs'};pending.resolve({config:accepted});await saving;r.controller.accept(accepted);
 assert.equal(r.controller.snapshot().draft.entry,'newer.cjs');assert.equal(r.controller.snapshot().draft.argsText,'["newer"]');assert.equal(r.dataset.reviewopsDirty,'true');
 r.controller.change('entry',accepted.entry);r.controller.change('argsText',JSON.stringify(saved.args));assert.equal(r.controller.snapshot().dirty,false);assert.equal(r.tabs.size,0);
});
test('unmount/binding cleanup clears its registration once and a late old save cannot clear a new binding',async()=>{
 const {createServiceRuntimeDraft,dirtyTabSet}=await modules(),values=[],tabs=dirtyTabSet(value=>values.push(value));
 const report=value=>value?tabs.add('project'):tabs.delete('project'),a=createServiceRuntimeDraft('A',report);a.accept(saved);a.change('entry','A-unsaved.cjs');
 const pending=deferred(),saving=a.save(()=>pending.promise);a.dispose();a.dispose();assert.equal(tabs.size,0);
 const b=createServiceRuntimeDraft('B',report);b.accept(saved);b.change('entry','B-unsaved.cjs');pending.resolve({config:{...saved,entry:'A-unsaved.cjs'}});await saving;
 assert.equal(tabs.has('project'),true);assert.equal(b.snapshot().draft.entry,'B-unsaved.cjs');assert.deepEqual(values,[false,true,false,true]);
 a.accept(saved);a.change('entry','must-not-return');let called=false;await a.save(()=>{called=true;});assert.equal(called,false);assert.equal(tabs.has('project'),true);b.dispose();assert.equal(tabs.size,0);
});
test('JSON argument formatting can revert to the saved array while invalid text remains a draft',async()=>{
 const {createServiceRuntimeDraft,dirtyTabSet}=await modules(),r=registration(createServiceRuntimeDraft,dirtyTabSet);r.controller.accept(saved);
 r.controller.change('argsText','["--port", "3000"]');assert.equal(r.controller.snapshot().dirty,false);r.controller.change('argsText','not JSON');assert.equal(r.controller.snapshot().dirty,true);
 r.controller.change('argsText',JSON.stringify(saved.args));assert.equal(r.dataset.reviewopsDirty,'false');
});
test('a poll may confirm an externally saved matching value without overwriting another dirty field',async()=>{
 const {createServiceRuntimeDraft,dirtyTabSet}=await modules(),r=registration(createServiceRuntimeDraft,dirtyTabSet);r.controller.accept(saved);r.controller.change('entry','already-saved.cjs');r.controller.change('readinessUrl','http://127.0.0.1:4000/');
 r.controller.accept({...saved,entry:'already-saved.cjs'});assert.equal(r.controller.snapshot().dirty,true);assert.equal(r.controller.snapshot().draft.readinessUrl,'http://127.0.0.1:4000/');
 r.controller.change('readinessUrl',saved.readinessUrl);assert.equal(r.controller.snapshot().dirty,false);
});


test('the actual unload handler sees a just-edited Node draft before any React render or effect flush',async()=>{
 const {createServiceRuntimeDraft,serviceRuntimeUnloadGuard}=await modules();let current=createServiceRuntimeDraft('A');current.accept(saved);
 const unload=serviceRuntimeUnloadGuard(()=>current),event=()=>({defaultPrevented:false,returnValue:undefined,preventDefault(){this.defaultPrevented=true;}});
 let e=event();unload(e);assert.equal(e.defaultPrevented,false);
 current.change('entry','just-edited.cjs');e=event();unload(e);assert.equal(e.defaultPrevented,true);assert.equal(e.returnValue,'');
 current.change('entry',saved.entry);e=event();unload(e);assert.equal(e.defaultPrevented,false);
 current.change('entry','unmounted.cjs');current.dispose();e=event();unload(e);assert.equal(e.defaultPrevented,false);
 current=createServiceRuntimeDraft('B');current.accept(saved);current.change('entry','B-new.cjs');e=event();unload(e);assert.equal(e.defaultPrevented,true,'Mounted handler must read the current binding owner');
});

const local=(projectId='p',connectionId='a',rootPath='/A')=>({projectId,connectionId,rootPath,kind:'local',name:projectId});
test('connection props changes retain dirty origin and block save until explicit review against the current saved baseline',async()=>{
 const {createServiceRuntimeDraft}=await modules(),reports=[],owner=createServiceRuntimeDraft('A',v=>reports.push(v),local());owner.accept(saved);owner.change('entry','kept.cjs');
 let state=owner.transition('B',local('p','b','/B'));assert.equal(state.draft.entry,'kept.cjs');assert.equal(state.origin.rootPath,'/A');assert.equal(state.dirty,true);assert.equal(state.reviewRequired,true);assert.equal(state.canConfigure,false);
 owner.accept({...saved,entry:'B-saved.cjs'});assert.equal(owner.snapshot().draft.entry,'kept.cjs');let called=false;await assert.rejects(owner.save(()=>{called=true;}),{code:'SERVICE_DRAFT_REVIEW_REQUIRED'});assert.equal(called,false);
 state=owner.review();assert.equal(state.canConfigure,true);assert.equal(state.dirty,true);assert.equal(state.origin.connectionId,'a','Origin remains visible until successful save');
 await owner.save(async()=>({config:{...saved,entry:'kept.cjs'}}));state=owner.snapshot();assert.equal(state.dirty,false);assert.equal(state.origin.connectionId,'b');assert.equal(state.origin.rootPath,'/B');assert.deepEqual(reports,[true,false]);
});
test('a dirty local draft stays registered on SSH or removed connection and is recovered exactly on original local return',async()=>{
 const {createServiceRuntimeDraft,serviceRuntimeUnloadGuard}=await modules(),owner=createServiceRuntimeDraft('A',()=>{},local());owner.accept(saved);owner.change('entry','A-unsaved.cjs');owner.change('argsText','["original A draft"]');const original=owner.snapshot().draft;
 for(const [binding,target]of [['SSH',{projectId:'p',connectionId:'ssh',rootPath:'/remote',kind:'ssh'}],['NONE',{projectId:'p',connectionId:'',rootPath:'',kind:'none'}]]){
  const state=owner.transition(binding,target);assert.equal(state.dirty,true);assert.equal(state.canConfigure,false);assert.equal(state.canReview,false);assert.deepEqual(state.draft,original);
  const event={prevented:false,preventDefault(){this.prevented=true;}};serviceRuntimeUnloadGuard(()=>owner)(event);assert.equal(event.prevented,true);assert.equal(owner.review().canConfigure,false);
 }
 const returned=owner.transition('A-new-request-epoch',local());assert.equal(returned.canConfigure,true);assert.equal(returned.reviewRequired,false);assert.equal(returned.dirty,true);assert.deepEqual(returned.draft,original);
});
test('cross-project retarget is denied even with a local current connection, and explicit discard clears only this draft',async()=>{
 const {createServiceRuntimeDraft,dirtyTabSet}=await modules(),tabs=dirtyTabSet(()=>{});tabs.add('other-review');const owner=createServiceRuntimeDraft('A',v=>v?tabs.add('runtime'):tabs.delete('runtime'),local());owner.accept(saved);owner.change('entry','A-unsaved.cjs');
 owner.transition('foreign',local('other-project','b','/B'));owner.accept({...saved,entry:'foreign-saved.cjs'});assert.equal(owner.snapshot().canReview,false);assert.equal(owner.review().canConfigure,false);let invoked=false;await assert.rejects(owner.save(()=>{invoked=true;}),{code:'SERVICE_DRAFT_REVIEW_REQUIRED'});assert.equal(invoked,false);
 const discarded=owner.discard();assert.equal(discarded.dirty,false);assert.equal(discarded.origin.projectId,'other-project');assert.equal(discarded.draft.entry,'foreign-saved.cjs');assert.equal(tabs.has('runtime'),false);assert.equal(tabs.has('other-review'),true);
});
test('A save acknowledged after B transition cannot clean B or replace the retained original draft',async()=>{
 const {createServiceRuntimeDraft}=await modules(),owner=createServiceRuntimeDraft('A',()=>{},local());owner.accept(saved);owner.change('entry','submitted-A.cjs');const pending=deferred(),saving=owner.save(()=>pending.promise);
 owner.transition('B',local('p','b','/B'));owner.change('entry','newer-retained.cjs');owner.accept({...saved,entry:'submitted-A.cjs'});pending.resolve({config:{...saved,entry:'submitted-A.cjs'}});await saving;
 const state=owner.snapshot();assert.equal(state.binding,'B');assert.equal(state.dirty,true);assert.equal(state.reviewRequired,true);assert.equal(state.canConfigure,false);assert.equal(state.draft.entry,'newer-retained.cjs');assert.equal(state.origin.connectionId,'a');
});
test('A→B→A request epochs invalidate old save acknowledgements while retaining exact newer A edits',async()=>{
 const {createServiceRuntimeDraft}=await modules(),owner=createServiceRuntimeDraft('A0',()=>{},local());owner.accept(saved);owner.change('entry','submitted-A.cjs');const pending=deferred(),saving=owner.save(()=>pending.promise);
 owner.transition('B',local('p','b','/B'));owner.transition('A1',local());owner.change('entry','newer-A.cjs');pending.resolve({config:{...saved,entry:'submitted-A.cjs'}});await saving;
 const state=owner.snapshot();assert.equal(state.binding,'A1');assert.equal(state.canConfigure,true);assert.equal(state.dirty,true);assert.equal(state.draft.entry,'newer-A.cjs');
});
test('new-connection poll matching an old draft does not silently acknowledge its transfer',async()=>{
 const {createServiceRuntimeDraft}=await modules(),owner=createServiceRuntimeDraft('A',()=>{},local());owner.accept(saved);owner.change('entry','kept.cjs');owner.transition('B',local('p','b','/B'));owner.accept({...saved,entry:'kept.cjs'});
 assert.equal(owner.snapshot().dirty,true);assert.equal(owner.snapshot().canConfigure,false);assert.equal(owner.snapshot().reviewRequired,true);
 assert.equal(owner.review().dirty,true,'Review alone cannot replace current-root validation through a saved configuration');await owner.save(async()=>({config:{...saved,entry:'kept.cjs'}}));assert.equal(owner.snapshot().dirty,false);
});
test('explicit discard on SSH preserves the current unsupported binding without assigning Node control',async()=>{
 const {createServiceRuntimeDraft}=await modules(),owner=createServiceRuntimeDraft('A',()=>{},local());owner.accept(saved);owner.change('entry','unsaved.cjs');owner.transition('SSH',{projectId:'p',connectionId:'ssh',rootPath:'/remote',kind:'ssh'});
 const state=owner.discard();assert.equal(state.dirty,false);assert.equal(state.canConfigure,false);assert.equal(state.current.kind,'ssh');assert.equal(state.origin.connectionId,'ssh');
});

test('returning to the original connection after reviewing a matching B baseline restores A dirty comparison',async()=>{
 const {createServiceRuntimeDraft}=await modules(),owner=createServiceRuntimeDraft('A',()=>{},local());owner.accept(saved);owner.change('entry','A-unsaved.cjs');
 owner.transition('B',local('p','b','/B'));owner.accept({...saved,entry:'A-unsaved.cjs'});owner.review();assert.equal(owner.snapshot().dirty,true);
 const returned=owner.transition('A-return',local());assert.equal(returned.dirty,true);assert.equal(returned.draft.entry,'A-unsaved.cjs');owner.accept(saved);assert.equal(owner.snapshot().dirty,true);assert.equal(owner.snapshot().draft.entry,'A-unsaved.cjs');
 owner.change('entry',saved.entry);assert.equal(owner.snapshot().dirty,false);
});

test('reviewed retained entry is validated in the actual current root before configure can clear dirty',async t=>{
 const {createServiceRuntimeDraft}=await modules(),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createProjectServiceRuntime}=require('../electron/project-service-runtime.cjs');
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'rv-draft-root-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));await fs.mkdir(path.join(base,'A'));await fs.mkdir(path.join(base,'B'));const rootA=await fs.realpath(path.join(base,'A')),rootB=await fs.realpath(path.join(base,'B'));await fs.writeFile(path.join(rootA,'server.cjs'),'');await fs.writeFile(path.join(rootA,'retained.cjs'),'');
 let selected='a';const manager=createProjectServiceRuntime({resolveBinding:(projectId,connectionId)=>projectId==='p'&&connectionId===selected?{projectId,connectionId,kind:'local',rootPath:selected==='a'?rootA:rootB,signature:selected}:null});t.after(()=>manager.close());
 const initial={...saved,executable:process.execPath},owner=createServiceRuntimeDraft('A',()=>{},local('p','a',rootA));owner.accept((await manager.configure('p','a',initial)).config);owner.change('entry','retained.cjs');selected='b';owner.transition('B',local('p','b',rootB));owner.accept(null);owner.review();
 const persist=()=>manager.configure('p','b',{...initial,entry:owner.snapshot().draft.entry});await assert.rejects(owner.save(persist),{code:'ENOENT'});assert.equal(owner.snapshot().dirty,true);assert.equal(owner.snapshot().origin.connectionId,'a');assert.equal(manager.state('p','b').config,null);
 await fs.writeFile(path.join(rootB,'retained.cjs'),'');await owner.save(persist);assert.equal(owner.snapshot().dirty,false);assert.equal(owner.snapshot().origin.rootPath,rootB);assert.equal(manager.state('p','b').config.entry,'retained.cjs');
});
