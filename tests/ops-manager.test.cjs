'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {OpsManager}=require('../electron/ops-manager.cjs');
const {OpsStore}=require('../electron/ops-store.cjs');
const {nextOccurrence,validateSchedule}=require('../electron/ops-scheduler.cjs');

async function harness(t,overrides={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-ops-')),dataPath=path.join(root,'data'),calls=[],sessions=new Map(),external=new Map();let clock=Date.parse('2026-11-07T00:00:00Z');
  const createSession=options=>{
    const state={options,threadId:options.threadId,turnId:null};sessions.set(options.goalId,state);
    return {
      async start(input){
        const persisted=JSON.parse(fs.readFileSync(path.join(dataPath,'ops/state.json'))),goal=persisted.goals.find(g=>g.id===options.goalId),record=goal.history.find(h=>h.id===input.deliveryId);
        assert.equal(record.status,'prepared');assert.equal(record.prompt,input.prompt);assert.ok(input.prompt.includes(input.deliveryId));
        calls.push({kind:'start',goalId:options.goalId,...input});state.threadId=input.threadId||'thread-'+options.goalId;state.turnId='turn-'+calls.length;
        await options.onEvent({type:'thread',threadId:state.threadId});await options.onEvent({type:'turn.started',threadId:state.threadId,turnId:state.turnId});
        external.set(input.deliveryId,{threadId:state.threadId,turnId:state.turnId,state:'running',delivery:'accepted'});
        if(overrides.start){const result=await overrides.start(input,state);if(result)return result;}
        return {threadId:state.threadId,turnId:state.turnId,state:'running',delivery:'accepted'};
      },
      async steer(input){calls.push({kind:'steer',goalId:options.goalId,...input});external.set(input.deliveryId,{threadId:state.threadId,turnId:state.turnId,state:'running',delivery:'accepted'});return {threadId:state.threadId,turnId:state.turnId,state:'running',delivery:'accepted'};},
      async reconcile(input){calls.push({kind:'reconcile',goalId:options.goalId,...input});return external.get(input.deliveryId)||{threadId:input.threadId,state:'unknown',delivery:'unknown'};},
      async interrupt(input){calls.push({kind:'interrupt',goalId:options.goalId,...input});if(overrides.interrupt)return overrides.interrupt(input,state);await options.onEvent({type:'turn.completed',threadId:state.threadId||input.threadId,turnId:state.turnId||input.turnId,status:'interrupted'});return {confirmed:true,state:'idle',turnId:state.turnId||input.turnId};},
      async close(){}
    };
  };
  const options={dataPath,createSession,now:()=>clock,schedulerOptions:{setTimer:()=>1,clearTimer:()=>{}}};
  const manager=new OpsManager(options);t.after(async()=>{await manager.close();fs.rmSync(root,{recursive:true,force:true});});
  const folder=name=>{const p=path.join(root,name);fs.mkdirSync(p,{recursive:true});return p;};
  const add=async(name,workPath=folder(name))=>{const snapshot=await manager.saveGoal({name,description:'Deliver the requested feature',workPath,prompt:'Implement and verify it.'});return snapshot.goals.at(-1).id;};
  const complete=async id=>{const s=sessions.get(id);for(const state of external.values())if(state.threadId===s.threadId)state.state='idle';await s.options.onEvent({type:'turn.completed',threadId:s.threadId,turnId:s.turnId,status:'completed'});await manager.pumpAll();};
  return {root,dataPath,manager,options,calls,sessions,external,folder,add,complete,setTime:at=>{clock=at;},now:()=>clock};
}

test('independent goals start in parallel, persist before send, and steer the original active thread',async t=>{
  const h=await harness(t),a=await h.add('A'),b=await h.add('B');
  await Promise.all([h.manager.goalAction({goalId:a,action:'start'}),h.manager.goalAction({goalId:b,action:'start'})]);await h.manager.pumpAll();
  assert.equal(h.calls.filter(c=>c.kind==='start').length,2);
  await h.manager.goalAction({goalId:a,action:'request',instruction:'Also preserve existing data.'});await h.manager.pumpAll();
  const start=h.calls.find(c=>c.kind==='start'&&c.goalId===a),steer=h.calls.find(c=>c.kind==='steer');assert.equal(steer.threadId,'thread-'+a);assert.equal(steer.turnId,h.sessions.get(a).turnId);assert.notEqual(start.deliveryId,steer.deliveryId);
  assert.equal(h.manager.snapshot().goals.find(g=>g.id===b).executionState,'running');
});

test('overlapping canonical folders wait while unrelated folders remain parallel and release after terminal event',async t=>{
  const h=await harness(t),parent=h.folder('shared'),a=await h.add('A',parent),b=await h.add('B',h.folder('shared/child')),c=await h.add('C');
  await Promise.all([a,b,c].map(goalId=>h.manager.goalAction({goalId,action:'start'})));await h.manager.pumpAll();
  assert.equal(h.calls.filter(c=>c.kind==='start').length,2);const waiting=h.manager.snapshot().goals.find(g=>g.executionState==='waiting');assert.ok(waiting.waitingReason.includes('겹치는'));
  const first=h.manager.snapshot().goals.find(g=>g.id!==c&&g.executionState==='running');await h.complete(first.id);
  assert.equal(h.calls.filter(c=>c.kind==='start').length,3);assert.equal(h.manager.snapshot().goals.find(g=>g.id===waiting.id).executionState,'running');
});

test('same-goal due schedules coalesce once and steer without creating another session',async t=>{
  const h=await harness(t),id=await h.add('Scheduled');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();
  for(const name of ['Issue review','CI check'])h.manager.saveSchedule({goalId:id,name,prompt:name,cron:'* * * * *',timezone:'Asia/Seoul',enabled:true});
  h.setTime(h.now()+8*60*60*1000);await Promise.all([h.manager.tick(),h.manager.tick()]);
  assert.equal(h.calls.filter(c=>c.kind==='start').length,1);assert.equal(h.calls.filter(c=>c.kind==='steer').length,1);
  const delivery=h.manager.snapshot().goals[0].history.filter(h=>h.type==='delivery').at(-1);assert.equal(delivery.scheduleIds.length,2);assert.ok(delivery.prompt.includes('Issue review'));assert.ok(delivery.prompt.includes('CI check'));
  await h.manager.tick();assert.equal(h.calls.filter(c=>c.kind==='steer').length,1);
});

test('pause persists before interrupt and paused or finished goals never auto-start',async t=>{
  const h=await harness(t),id=await h.add('Paused');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();
  h.manager.saveSchedule({goalId:id,name:'Follow-up',prompt:'Continue',cron:'* * * * *',timezone:'UTC',enabled:true});
  await h.manager.goalAction({goalId:id,action:'pause'});assert.equal(h.manager.snapshot().goals[0].status,'paused');
  h.setTime(h.now()+3600000);await h.manager.tick();assert.equal(h.calls.filter(c=>c.kind==='start').length,1);await assert.rejects(h.manager.goalAction({goalId:id,action:'request',instruction:'Do not activate'}),{code:'OPS_GOAL_INACTIVE'});
  await h.manager.goalAction({goalId:id,action:'finish'});await h.manager.tick();assert.equal(h.manager.snapshot().goals[0].status,'finished');
});

test('unknown acknowledgement is reconciled against original delivery after restart without replay',async t=>{
  const h=await harness(t,{start:async()=>{throw new Error('Lost acknowledgement');}}),id=await h.add('Recover');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();
  assert.equal(h.manager.snapshot().goals[0].executionState,'unknown');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);
  await h.manager.close();const recovered=new OpsManager(h.options);t.after(()=>recovered.close());await recovered.init();assert.equal(recovered.snapshot().goals[0].executionState,'running');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);assert.equal(recovered.snapshot().goals[0].threadId,'thread-'+id);
});

test('bound model tools cannot select another goal and repeated server call IDs do not duplicate schedule changes',async t=>{
  const h=await harness(t),id=await h.add('Own schedules'),other=await h.add('Other');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();
  const state=h.sessions.get(id),tool=state.options.tools.find(t=>t.name==='ops_schedules_save'),args={id:'',name:'Check progress',prompt:'Review the latest result.',cron:'0 * * * *',timezone:'UTC',enabled:true,reason:'Wait for external progress.'},context={callId:'call-1',threadId:state.threadId,turnId:state.turnId};
  await tool.execute(args,context);await tool.execute(args,context);assert.equal(h.manager.snapshot().goals.find(g=>g.id===id).schedules.length,1);assert.equal(h.manager.snapshot().goals.find(g=>g.id===other).schedules.length,0);
  await assert.rejects(async()=>tool.execute({...args,goalId:other},{...context,callId:'call-2'}),{code:'INVALID_OPS_REQUEST'});
  await assert.rejects(async()=>tool.execute({...args,prompt:'Changed request'},context),{code:'OPS_TOOL_REPLAY_MISMATCH'});
  const data=h.manager.exportData();assert.equal(data.goals.find(g=>g.id===id).toolReceipts.length,1);assert.ok(data.goals.find(g=>g.id===id).history.some(r=>r.reason===args.reason));
});

test('versioned backup preserves all Ops data and restores goals paused without erasing session identity',async t=>{
  const h=await harness(t),id=await h.add('Backup');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();await h.complete(id);const original=h.manager.exportData();
  h.manager.setSuspended(true);h.manager.restore(original);const restored=h.manager.snapshot().goals[0];assert.equal(restored.status,'paused');assert.equal(restored.threadId,original.goals[0].threadId);assert.deepEqual(restored.history,original.goals[0].history);
  assert.equal(new OpsStore({dataPath:h.dataPath}).read().goals[0].threadId,restored.threadId);
});

test('a failed goal target does not change an independently running goal',async t=>{
  const h=await harness(t),a=await h.add('Unavailable'),b=await h.add('Healthy');
  await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();
  const target=h.manager.snapshot().goals.find(g=>g.id===a).workPath;fs.rmSync(target,{recursive:true});
  await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();
  const state=h.manager.snapshot();assert.equal(state.goals.find(g=>g.id===a).executionState,'error');assert.equal(state.goals.find(g=>g.id===b).executionState,'running');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);
});

test('a terminal event before a delayed start acknowledgement cannot restore a running directory claim',async t=>{
  const h=await harness(t,{start:async(_input,state)=>{await state.options.onEvent({type:'turn.completed',threadId:state.threadId,turnId:state.turnId,status:'completed'});}}),id=await h.add('Fast turn');
  await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();
  const goal=h.manager.snapshot().goals[0];assert.equal(goal.executionState,'idle');assert.equal(goal.turnId,null);assert.equal(goal.history.find(r=>r.type==='delivery').status,'completed');
});

test('disabling a queued schedule cancels its unsent instruction while a folder is occupied',async t=>{
 const h=await harness(t),folder=h.folder('schedule-lock'),a=await h.add('Lock owner',folder),b=await h.add('Waiting goal',folder);
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();
 await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();
 const fields={goalId:b,name:'Do not run after disable',prompt:'Scheduled follow-up',cron:'* * * * *',timezone:'UTC',enabled:true};h.manager.saveSchedule(fields);
 h.setTime(h.now()+60000);await h.manager.tick();const schedule=h.manager.snapshot().goals.find(g=>g.id===b).schedules[0];
 h.manager.saveSchedule({...fields,id:schedule.id,enabled:false});await h.complete(a);
 const calls=h.calls.filter(c=>c.goalId===b);assert.equal(calls.filter(c=>c.kind==='start').length,1);assert.equal(calls.filter(c=>c.kind==='steer').length,0);
 assert.equal(h.manager.snapshot().goals.find(g=>g.id===b).history.find(r=>r.scheduleId===schedule.id&&r.type==='delivery').status,'cancelled');
});

test('SSH users share a server directory lock without sharing session identity',async t=>{
 const h=await harness(t);h.manager.resolveTarget=async input=>({projectId:'project',workPath:'/shared/work',targetKind:'ssh',targetIdentity:'server-user:'+input.name,targetLockIdentity:'server-key:original'});
 const a=await h.add('alice'),b=await h.add('bob');await Promise.all([a,b].map(goalId=>h.manager.goalAction({goalId,action:'start'})));await h.manager.pumpAll();
 const goals=h.manager.snapshot().goals;assert.notEqual(goals[0].targetIdentity,goals[1].targetIdentity);assert.equal(goals.filter(g=>g.executionState==='running').length,1);assert.equal(goals.filter(g=>g.executionState==='waiting').length,1);
});

test('repeated due scans while a target waits retain only one unsent scheduled follow-up',async t=>{
 const h=await harness(t),folder=h.folder('missed-target'),a=await h.add('Busy owner',folder),b=await h.add('Waiting schedules',folder);
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();
 h.manager.saveSchedule({goalId:b,name:'One bounded follow-up',prompt:'Inspect progress',cron:'* * * * *',timezone:'UTC',enabled:true});
 for(let n=0;n<3;n++){h.setTime(h.now()+60000);await h.manager.tick();}
 let goal=h.manager.snapshot().goals.find(g=>g.id===b);assert.equal(goal.history.filter(r=>r.type==='delivery'&&r.status==='queued'&&r.scheduleIds.length).length,1);
 await h.complete(a);assert.equal(h.calls.filter(c=>c.goalId===b&&c.kind==='steer').length,1);goal=h.manager.snapshot().goals.find(g=>g.id===b);assert.equal(goal.history.filter(r=>r.status==='coalesced').length,2);
});

test('failed turns remain failed in the delivery result and do not retain a running claim',async t=>{
 const h=await harness(t,{start:async(_input,state)=>{await state.options.onEvent({type:'turn.completed',threadId:state.threadId,turnId:state.turnId,status:'failed'});}}),id=await h.add('Actual failure');
 await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();const goal=h.manager.snapshot().goals[0];assert.equal(goal.executionState,'error');assert.equal(goal.turnId,null);assert.equal(goal.history.find(r=>r.type==='delivery').status,'failed');
});

test('a settings change during target lookup replaces only the unsent request and preserves its identity guard',async t=>{
 const h=await harness(t),id=await h.add('Updated while queued'),resolve=h.manager.resolveTarget;let release,entered,held=false;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 h.manager.resolveTarget=async input=>{if(input.status==='active'&&!held){held=true;entered();await gate;}return resolve(input);};
 await h.manager.goalAction({goalId:id,action:'start'});await ready;h.manager.configure({commonPrompt:'New authoritative shared instructions'});release();await h.manager.pumpAll();
 const calls=h.calls.filter(c=>c.kind==='start');assert.equal(calls.length,1);assert.ok(calls[0].prompt.includes('New authoritative shared instructions'));
 const goal=h.manager.snapshot().goals[0];assert.equal(goal.history.filter(r=>r.type==='delivery'&&r.status==='replaced').length,1);assert.equal(goal.history.filter(r=>r.type==='delivery'&&r.status==='accepted').length,1);
});

test('unknown delivery results and idle marker absence cannot become accepted work or an automatic replay',async t=>{
 const h=await harness(t,{start:async(_input,state)=>({threadId:state.threadId,turnId:state.turnId,state:'idle',delivery:'unknown'})}),id=await h.add('Unknown delivery');
 await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();let goal=h.manager.snapshot().goals[0],delivery=goal.history.find(r=>r.type==='delivery');
 assert.equal(goal.executionState,'unknown');assert.equal(delivery.status,'unknown');assert.equal(delivery.deliveredAt,undefined);
 h.external.set(delivery.id,{threadId:goal.threadId,state:'idle',delivery:'not_found',safeToRetry:false});await h.manager.reconnect(id);await h.manager.pumpAll();
 goal=h.manager.snapshot().goals[0];assert.equal(goal.executionState,'unknown');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);
});

test('an unconfirmed interruption retains the original directory claim instead of releasing a running target',async t=>{
 const h=await harness(t,{interrupt:async()=>({confirmed:false,state:'unknown'})}),folder=h.folder('unconfirmed-stop'),a=await h.add('Original turn',folder),b=await h.add('Waiting writer',folder);
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();await h.manager.goalAction({goalId:a,action:'pause'});await h.manager.pumpAll();
 const goals=h.manager.snapshot().goals;assert.equal(goals.find(g=>g.id===a).status,'paused');assert.equal(goals.find(g=>g.id===a).executionState,'unknown');assert.equal(goals.find(g=>g.id===b).executionState,'waiting');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);
});

test('direct and OpenSSH goals claim their shared endpoint alias for one remote canonical folder',async t=>{
 const h=await harness(t);h.manager.resolveTarget=async input=>({projectId:'project',workPath:'/shared/repo',targetKind:'ssh',targetIdentity:'session:'+input.name,targetLockIdentity:input.name==='direct'?'server-key':'endpoint',targetLockIdentities:input.name==='direct'?['server-key','endpoint']:['endpoint']});
 const a=await h.add('direct'),b=await h.add('openssh');await Promise.all([a,b].map(goalId=>h.manager.goalAction({goalId,action:'start'})));await h.manager.pumpAll();assert.equal(h.calls.filter(c=>c.kind==='start').length,1);assert.equal(h.manager.snapshot().goals.filter(g=>g.executionState==='waiting').length,1);
});

test('cron is exactly five fields, validates IANA zones, and preserves DST wall-clock recurrence',()=>{
  assert.throws(()=>validateSchedule('0 * * * * *','UTC'));assert.throws(()=>validateSchedule('* * * * *','Moon/Base'));assert.throws(()=>validateSchedule('H * * * *','UTC'));
  assert.equal(nextOccurrence('0 9 * * *','America/New_York',Date.parse('2026-03-07T15:00:00Z')),'2026-03-08T13:00:00.000Z');
  assert.equal(nextOccurrence('0 4 * * *','Asia/Seoul',Date.parse('2026-11-06T20:00:00Z')),'2026-11-07T19:00:00.000Z');
});
