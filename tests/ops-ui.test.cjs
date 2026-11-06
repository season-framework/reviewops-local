'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const helpers=()=>import('../src/OpsState.mjs');

test('an earlier snapshot or action result cannot overwrite a newer Ops event',async()=>{
 const {chooseOpsSnapshot}=await helpers();
 const running={revision:8,goals:[{id:'A',status:'active',executionState:'running',threadId:'same-thread'}]};
 const old={revision:7,goals:[{id:'A',status:'draft',threadId:null}]};
 assert.equal(chooseOpsSnapshot(running,old),running);
 assert.equal(chooseOpsSnapshot(running,{revision:9,goals:null}),running);
 const paused={revision:9,goals:[{id:'A',status:'paused',threadId:'same-thread'}]};
 assert.equal(chooseOpsSnapshot(running,paused),paused);
 assert.equal(chooseOpsSnapshot(null,old),old);
});

test('schedule editing preserves its goal, prompt, cron and IANA zone without sending runtime history',async()=>{
 const {scheduleDraft}=await helpers();
 const saved={id:'schedule-A',goalId:'goal-A',name:'Hourly work',prompt:'Continue actual work',cron:'15 * * * *',timezone:'Asia/Seoul',enabled:false,lastRunAt:'2026-11-06T12:00:00Z',threadId:'must-stay-in-main'};
 const edit=scheduleDraft(saved,'goal-B');
 assert.deepEqual(edit,{id:'schedule-A',goalId:'goal-A',name:saved.name,prompt:saved.prompt,cron:saved.cron,timezone:'Asia/Seoul',enabled:false});
 assert.equal(scheduleDraft({},'goal-B').goalId,'goal-B');
 assert.equal(scheduleDraft(null,'goal-B').goalId,'goal-B');
});

test('goal editing preserves explicit connection and Codex settings while excluding session ownership',async()=>{
 const {goalDraft}=await helpers();
 const saved={id:'A',name:'Goal A',description:'Work',projectId:'P',serviceId:'SSH',workPath:'/workspace',prompt:'Do the work',model:'chosen-model',reasoningEffort:'ultra',sandboxMode:'read-only',approvalPolicy:'on-request',threadId:'protected-thread',status:'paused'};
 const draft=goalDraft(saved);
 assert.equal(draft.projectId,'P');assert.equal(draft.serviceId,'SSH');assert.equal(draft.model,'chosen-model');assert.equal(draft.reasoningEffort,'ultra');assert.equal(draft.approvalPolicy,'on-request');
 assert.equal(goalDraft({...saved,approvalPolicy:'on-failure'}).approvalPolicy,'on-failure','Unsupported persisted values must not be silently rewritten.');
 assert.equal('threadId'in draft,false);assert.equal('status'in draft,false);
});

test('prepared and unknown delivery states are not labeled as delivered',async()=>{
 const {outcomeKey}=await helpers();
 assert.equal(outcomeKey('coalesced'),'합침');assert.equal(outcomeKey('replaced'),'설정 변경으로 교체');assert.equal(outcomeKey('prepared'),'실행 준비');assert.equal(outcomeKey('queued'),'전달 대기');assert.equal(outcomeKey('unknown'),'결과 확인 필요');assert.equal(outcomeKey('accepted'),'전달 확인');
});
