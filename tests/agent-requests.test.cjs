'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../electron/store.cjs');
const {createRequestQueue,listSavedRequests,requestTargetKey,conflictingTargets}=require('../electron/agent-requests.cjs');

function fixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-requests-'));
 const store=createStore({dbPath:path.join(directory,'data.sqlite')});
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const group=store.saveGroup({name:'Queue test'}),service=store.saveService({groupId:group.id,name:'Local',kind:'local',rootPath:directory}),project=store.saveProject({groupId:group.id,name:'Project',serviceIds:[service.id]});
 const review=store.saveReview({projectId:project.id,serviceId:service.id,title:'First review'}),nextReview=store.saveReview({projectId:project.id,serviceId:service.id,title:'Followup review'});
 let starts=0,targetKey='folder-a';
 const run=(extra={})=>store.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'Previous work',workPath:directory,status:'running',...extra});
 const queue=createRequestQueue({store,targetForReview:row=>({serviceId:row.serviceId,key:targetKey}),targetForRun:()=>targetKey,start:async input=>{starts++;return run({id:input.requestId,reviewId:input.reviewId,prompt:input.prompt});}});
 const add=extra=>queue.add({requestId:'request-a',reviewId:nextReview.id,prompt:'Check the updated screen',...extra});
 const current=()=>queue.list(nextReview.id).requests[0];
 return {directory,store,service,group,project,review,nextReview,queue,run,add,current,get starts(){return starts;},setTarget:key=>{targetKey=key;}};
}

test('followup preserves request while running and starts only after explicit action and result confirmation',async t=>{
 const f=fixture(t),previous=f.run();
 const waiting=f.add({predecessorId:previous.id,requiredResult:'Updated screen and tests'});
 assert.equal(waiting.state,'waiting');assert.equal(waiting.delivery,'not_sent');assert.equal(f.starts,0);
 assert.throws(()=>f.queue.confirmResult({id:waiting.id}),/완료된 뒤/);
 await assert.rejects(f.queue.start({id:waiting.id}),/기다리고/);
 f.store.saveAgentRun({...previous,status:'completed',response:'Screen updated'});
 assert.match(f.current().reason,/필요한 결과/);assert.equal(f.starts,0);
 f.queue.confirmResult({id:waiting.id});assert.equal(f.current().state,'ready');assert.equal(f.starts,0);
 const job=await f.queue.start({id:waiting.id});assert.equal(f.starts,1);assert.equal(job.reviewId,f.nextReview.id);
 assert.equal(f.current().state,'running');assert.equal(f.current().delivery,'submitted');assert.equal(f.current().resolution,'pending');
 assert.equal((await f.queue.start({id:waiting.id})).id,job.id);assert.equal(f.starts,1);
 f.store.saveAgentRun({...job,status:'completed',response:'Done'});
 assert.equal(f.current().state,'finished');assert.equal(f.current().resolution,'pending');
 assert.throws(()=>f.queue.resolve({id:waiting.id,resolution:'applied'}),/결과 버전/);
 f.queue.resolve({id:waiting.id,resolution:'applied',resultVersion:'commit abc123',resultNote:'Test passed'});
 assert.equal(f.current().resultVersion,'commit abc123');assert.equal(f.current().resolution,'applied');
});

test('failed or interrupted predecessors keep followups waiting and cannot be bypassed by confirmation',async t=>{
 for(const status of ['failed','cancelled','interrupted']) {
  const f=fixture(t),previous=f.run({status});f.add({predecessorId:previous.id,requiredResult:'Result'});
  assert.equal(f.current().state,'waiting');assert.match(f.current().reason,/실패|중단/);
  assert.throws(()=>f.queue.confirmResult({id:'request-a'}),/완료된 뒤/);
  await assert.rejects(f.queue.start({id:'request-a'}),/실패|중단/);assert.equal(f.starts,0);
 }
});

test('same-folder requests retain order and do not overlap existing work',async t=>{
 const f=fixture(t);f.add();f.add({requestId:'request-b',prompt:'Second request'});
 const second=()=>f.queue.list(f.nextReview.id).requests[1];
 assert.equal(f.current().state,'ready');assert.equal(second().state,'waiting');assert.equal(second().blockingRequestId,'request-a');
 await assert.rejects(f.queue.start({id:'request-b'}),/먼저 등록/);
 const job=await f.queue.start({id:'request-a'});assert.equal(second().blockingRunId,job.id);
 f.store.saveAgentRun({...job,status:'completed'});assert.equal(second().state,'ready');
});

test('cancelled request releases the next request without starting anything',t=>{
 const f=fixture(t);f.add();f.add({requestId:'request-b',prompt:'Second'});f.queue.cancel({id:'request-a'});
 assert.equal(f.current().state,'cancelled');assert.equal(f.queue.list(f.nextReview.id).requests[1].state,'ready');assert.equal(f.starts,0);
});

test('duplicate additions are idempotent but reuse with changed content is rejected',t=>{
 const f=fixture(t),first=f.add();assert.equal(f.add().id,first.id);assert.equal(f.queue.list(f.nextReview.id).requests.length,1);
 assert.throws(()=>f.add({prompt:'Different approval scope'}),/이미 사용한/);
});

test('concurrent starts share a single execution and a rejected start keeps the saved request',async t=>{
 const f=fixture(t);f.add();const [first,second]=await Promise.all([f.queue.start({id:'request-a'}),f.queue.start({id:'request-a'})]);
 assert.equal(first.id,second.id);assert.equal(f.starts,1);
 const failed=createRequestQueue({store:f.store,targetForReview:row=>({serviceId:row.serviceId,key:'folder-a'}),targetForRun:()=>'',start:async()=>{throw new Error('Login required');}});
 f.store.saveAgentRun({...first,status:'completed'});f.add({requestId:'request-b',prompt:'Next'});
 await assert.rejects(failed.start({id:'request-b'}),/Login required/);
 assert.equal(failed.list(f.nextReview.id).requests[1].state,'ready');assert.equal(listSavedRequests(f.store.db)[1].runId,'');
});

test('folder conflicts ignore executable and model settings, resolve aliases and include child folders',t=>{
 const f=fixture(t),alias=path.join(f.directory,'alias'),child=path.join(f.directory,'child');fs.mkdirSync(child);fs.symlinkSync(child,alias,'dir');
 const target=(folder,binary='codex',model='')=>requestTargetKey({kind:'local'},{workPath:folder,binary,model});
 assert.equal(target(child),target(alias,'/different/codex','other-model'));
 assert.equal(conflictingTargets(target(f.directory),target(child)),true);assert.equal(conflictingTargets(target(child),target(f.directory)),true);
 assert.equal(conflictingTargets(target(child),target(child+'-other')),false);
 const remote=(host,folder)=>requestTargetKey({kind:'ssh',host,port:22,username:'user'},{workPath:folder});
 assert.equal(conflictingTargets(remote('one','/work'),remote('two','/work')),false);
 assert.equal(conflictingTargets(remote('one','/work'),remote('one','/work/sub')),true);
});

test('changed execution target leaves the original request waiting',async t=>{
 const f=fixture(t);f.add();f.setTarget('folder-b');assert.match(f.current().reason,/변경/);
 await assert.rejects(f.queue.start({id:'request-a'}),/변경/);assert.equal(f.starts,0);
});

test('requests survive restart, interrupted run handling, and backup restore',t=>{
 const f=fixture(t),previous=f.run();f.add({predecessorId:previous.id,requiredResult:'Report'});
 const before=listSavedRequests(f.store.db);f.store.interruptAgentRuns();assert.deepEqual(listSavedRequests(f.store.db),before);
 const backup=f.store.exportData();assert.equal(backup.agentRequests.length,1);
 const another=createStore({dbPath:':memory:'});t.after(()=>another.close());another.importData(backup);
 assert.deepEqual(listSavedRequests(another.db),before);
 const reopened=createStore({dbPath:path.join(f.directory,'data.sqlite')});t.after(()=>reopened.close());assert.deepEqual(listSavedRequests(reopened.db),before);
});

test('backup rejects invalid connections and duplicate requests without replacing live data',t=>{
 const f=fixture(t);f.add();const baseline=f.store.exportData();
 for(const mutate of [data=>{data.agentRequests.push(data.agentRequests[0]);},data=>{data.agentRequests[0].reviewId='missing';},data=>{data.agentRequests[0].predecessorId='invalid run id';},data=>{data.agentRequests[0].resultConfirmed='true';},data=>{data.agentRequests[0].resolution='received';},data=>{data.agentRequests[0].unexpected='unsupported';},data=>{delete data.agentRequests;}]) {
  const changed=structuredClone(baseline);mutate(changed);assert.throws(()=>f.store.importData(changed));assert.deepEqual(f.store.exportData(),baseline);
 }
});

test('backup rejects predecessors from another project and services from another group',t=>{
 const f=fixture(t);f.add();
 const otherGroup=f.store.saveGroup({name:'Other group'}),otherService=f.store.saveService({groupId:otherGroup.id,name:'Other service',kind:'local',rootPath:f.directory}),otherProject=f.store.saveProject({groupId:otherGroup.id,name:'Other project',serviceIds:[otherService.id]}),otherReview=f.store.saveReview({projectId:otherProject.id,serviceId:otherService.id,title:'Other review'});
 const previous=f.store.saveAgentRun({reviewId:otherReview.id,serviceId:otherService.id,prompt:'Other work',status:'completed',workPath:f.directory}),baseline=f.store.exportData();
 for(const mutate of [data=>{data.agentRequests[0].predecessorId=previous.id;},data=>{data.agentRequests[0].serviceId=otherService.id;}]){const changed=structuredClone(baseline);mutate(changed);assert.throws(()=>f.store.importData(changed),/다른 프로젝트|다른 그룹/);assert.deepEqual(f.store.exportData(),baseline);}
});

test('deleting a predecessor review retains the followup and a clear missing-run reason',t=>{
 const f=fixture(t),previous=f.run({status:'completed'});f.add({predecessorId:previous.id});
 f.store.deleteReview(f.review.id);assert.equal(f.current().state,'waiting');assert.match(f.current().reason,/찾을 수 없습니다/);
 f.store.deleteReview(f.nextReview.id);assert.equal(listSavedRequests(f.store.db).length,0);
});

test('later result notes do not pretend delivery receipt or agent confirmation',async t=>{
 const f=fixture(t);f.add();const job=await f.queue.start({id:'request-a'});
 assert.throws(()=>f.queue.resolve({id:'request-a',resolution:'applied',resultVersion:'abc'}),/끝난 뒤/);
 f.store.saveAgentRun({...job,status:'failed',error:'CLI error'});
 assert.equal(f.current().resolution,'pending');assert.equal(f.current().delivery,'submitted');
 assert.throws(()=>f.queue.resolve({id:'request-a',resolution:'deferred'}),/처리 내용/);
 f.queue.resolve({id:'request-a',resolution:'deferred',resultNote:'Needs a new execution'});assert.equal(f.current().resolution,'deferred');
});

test('editing a pending request preserves settings and links while changing its prerequisite and required result',t=>{
 const f=fixture(t),first=f.run({reviewId:f.nextReview.id,status:'completed'}),second=f.run({reviewId:f.nextReview.id,status:'completed'});
 const request=f.add({predecessorId:first.id,requiredResult:'First result',model:'saved-model',reasoningEffort:'high',continuedFromRunId:first.id,context:{instruction:false,attachmentIds:[],logIds:[]}});
 f.queue.confirmResult({id:request.id});assert.equal(f.current().resultConfirmed,true);
 const edited=f.queue.update({id:request.id,prompt:'  edited request\n',predecessorId:second.id,requiredResult:'New result'});
 assert.equal(edited.predecessorId,second.id);assert.equal(edited.requiredResult,'New result');assert.equal(edited.resultConfirmed,false);assert.equal(edited.model,'saved-model');assert.equal(edited.reasoningEffort,'high');assert.equal(edited.continuedFromRunId,first.id);assert.deepEqual(edited.context,request.context);assert.deepEqual(edited.executionSettings,request.executionSettings);assert.equal(edited.prompt,'  edited request\n');
 f.queue.confirmResult({id:request.id});f.queue.update({id:request.id,prompt:'Only prompt changed'});assert.equal(f.current().resultConfirmed,true);
 const otherProject=f.store.saveProject({groupId:f.group.id,name:'Other project',serviceIds:[f.service.id]}),otherReview=f.store.saveReview({projectId:otherProject.id,serviceId:f.service.id,title:'Other'}),otherRun=f.store.saveAgentRun({reviewId:otherReview.id,serviceId:f.service.id,prompt:'Other',status:'completed',workPath:f.directory});
 const before=f.current();assert.throws(()=>f.queue.update({id:request.id,predecessorId:otherRun.id,requiredResult:'Lost result'}),/같은 프로젝트/);assert.deepEqual(f.current(),before);
});
