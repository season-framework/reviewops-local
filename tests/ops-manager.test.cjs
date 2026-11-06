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
        if(overrides.beforeStart)await overrides.beforeStart(input,state);
        calls.push({kind:'start',goalId:options.goalId,...input});state.threadId=input.threadId||'thread-'+options.goalId;state.turnId='turn-'+calls.length;
        await options.onEvent({type:'thread',threadId:state.threadId});await options.onEvent({type:'turn.started',threadId:state.threadId,turnId:state.turnId});
        external.set(input.deliveryId,{threadId:state.threadId,turnId:state.turnId,state:'running',delivery:'accepted'});
        if(overrides.start){const result=await overrides.start(input,state);if(result)return result;}
        return {threadId:state.threadId,turnId:state.turnId,state:'running',delivery:'accepted'};
      },
      async steer(input){calls.push({kind:'steer',goalId:options.goalId,...input});external.set(input.deliveryId,{threadId:state.threadId,turnId:state.turnId,state:'running',delivery:'accepted'});return {threadId:state.threadId,turnId:state.turnId,state:'running',delivery:'accepted'};},
      async reconcile(input){calls.push({kind:'reconcile',goalId:options.goalId,...input});if(overrides.reconcile)return overrides.reconcile(input,state,external);return external.get(input.deliveryId)||{threadId:input.threadId,state:'unknown',delivery:'unknown'};},
      async interrupt(input){calls.push({kind:'interrupt',goalId:options.goalId,...input});if(overrides.interrupt)return overrides.interrupt(input,state);await options.onEvent({type:'turn.completed',threadId:state.threadId||input.threadId,turnId:state.turnId||input.turnId,status:'interrupted',backgroundState:'empty',backgroundCount:0});return {confirmed:true,state:'idle',turnId:state.turnId||input.turnId};},
      async close(){calls.push({kind:'close',goalId:options.goalId});if(overrides.close)await overrides.close(state);}
    };
  };
  const options={dataPath,createSession,...overrides.managerOptions,now:()=>clock,schedulerOptions:{setTimer:()=>1,clearTimer:()=>{}}};
  const manager=new OpsManager(options);t.after(async()=>{await manager.close();fs.rmSync(root,{recursive:true,force:true});});
  const folder=name=>{const p=path.join(root,name);fs.mkdirSync(p,{recursive:true});return p;};
  const add=async(name,workPath=folder(name))=>{const snapshot=await manager.saveGoal({name,description:'Deliver the requested feature',workPath,prompt:'Implement and verify it.'});return snapshot.goals.at(-1).id;};
  const complete=async id=>{const s=sessions.get(id);for(const state of external.values())if(state.threadId===s.threadId){state.state='idle';state.backgroundState='empty';state.backgroundCount=0;}await s.options.onEvent({type:'turn.completed',threadId:s.threadId,turnId:s.turnId,status:'completed',backgroundState:'empty',backgroundCount:0});await manager.pumpAll();};
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
  h.setTime(h.now()+8*60*60*1000);await Promise.all([h.manager.tick(),h.manager.tick()]);await h.manager.pumpAll();
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
  await h.manager.close();const recovered=new OpsManager(h.options);t.after(()=>recovered.close());await recovered.init();await recovered.reconnect(id);assert.equal(recovered.snapshot().goals[0].executionState,'running');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);assert.equal(recovered.snapshot().goals[0].threadId,'thread-'+id);
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
  const h=await harness(t,{start:async(_input,state)=>{await state.options.onEvent({type:'turn.completed',threadId:state.threadId,turnId:state.turnId,status:'completed',backgroundState:'empty',backgroundCount:0});}}),id=await h.add('Fast turn');
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
 const h=await harness(t,{start:async(_input,state)=>{await state.options.onEvent({type:'turn.completed',threadId:state.threadId,turnId:state.turnId,status:'failed',backgroundState:'empty',backgroundCount:0});}}),id=await h.add('Actual failure');
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

test('pause keeps its target claim after turn completion until background cleanup is confirmed',async t=>{
 let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const h=await harness(t,{interrupt:async(input,state)=>{await state.options.onEvent({type:'turn.completed',threadId:state.threadId,turnId:state.turnId,status:'interrupted',backgroundState:'empty',backgroundCount:0});entered();await gate;return {confirmed:true,state:'idle',turnId:input.turnId,status:'interrupted'};}}),folder=h.folder('held-terminal-cleanup'),a=await h.add('Stopping owner',folder),b=await h.add('Waiting target',folder);
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();
 const stopping=h.manager.goalAction({goalId:a,action:'pause'});await ready;await h.manager.pumpAll();assert.equal(h.manager.snapshot().goals.find(g=>g.id===a).executionState,'unknown');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);
 release();await stopping;await h.manager.pumpAll();assert.equal(h.calls.filter(c=>c.kind==='start').length,2);assert.equal(h.manager.snapshot().goals.find(g=>g.id===a).executionState,'idle');
});

test('pausing an idle persisted thread still asks its adapter to drain background terminals',async t=>{
 const h=await harness(t),id=await h.add('Idle terminal owner');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();await h.complete(id);
 assert.equal(h.manager.snapshot().goals[0].turnId,null);await h.manager.goalAction({goalId:id,action:'pause'});assert.equal(h.calls.filter(c=>c.kind==='interrupt').length,1);assert.equal(h.manager.snapshot().goals[0].status,'paused');assert.equal(h.manager.snapshot().goals[0].executionState,'idle');
});

test('cron is exactly five fields, validates IANA zones, and preserves DST wall-clock recurrence',()=>{
  assert.throws(()=>validateSchedule('0 * * * * *','UTC'));assert.throws(()=>validateSchedule('* * * * *','Moon/Base'));assert.throws(()=>validateSchedule('H * * * *','UTC'));
  assert.equal(nextOccurrence('0 9 * * *','America/New_York',Date.parse('2026-03-07T15:00:00Z')),'2026-03-08T13:00:00.000Z');
  assert.equal(nextOccurrence('0 4 * * *','Asia/Seoul',Date.parse('2026-11-06T20:00:00Z')),'2026-11-07T19:00:00.000Z');
});

test('normal model completion retains its folder while a background terminal is active and releases only after empty proof',async t=>{
 const h=await harness(t),folder=h.folder('live-background'),a=await h.add('Background owner',folder),b=await h.add('Waiting peer',folder);
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();
 const session=h.sessions.get(a);for(const value of h.external.values())if(value.threadId===session.threadId)Object.assign(value,{state:'idle',backgroundState:'active',backgroundCount:1,outcome:'completed'});
 await session.options.onEvent({type:'turn.completed',threadId:session.threadId,turnId:session.turnId,status:'completed',backgroundState:'active',backgroundCount:1});await h.manager.pumpAll();
 let owner=h.manager.snapshot().goals.find(g=>g.id===a);assert.equal(owner.modelState,'idle');assert.equal(owner.turnId,null);assert.equal(owner.executionState,'running');assert.equal(owner.backgroundCount,1);assert.equal(h.calls.filter(c=>c.kind==='start').length,1);
 await h.manager.tick();await h.manager.reconnect(a);assert.equal(h.calls.filter(c=>c.kind==='start').length,1);assert.equal(h.calls.filter(c=>c.kind==='interrupt').length,0);
 for(const value of h.external.values())if(value.threadId===session.threadId)Object.assign(value,{backgroundState:'empty',backgroundCount:0});
 await h.manager.tick();await h.manager.reconnect(a);await h.manager.pumpAll();owner=h.manager.snapshot().goals.find(g=>g.id===a);assert.equal(owner.executionState,'idle');assert.equal(owner.backgroundCount,0);assert.equal(h.calls.filter(c=>c.kind==='start').length,2);assert.equal(h.calls.filter(c=>c.kind==='interrupt').length,0);
});

test('unknown background proof and failed metadata reads retain a completed model target claim',async t=>{
 let failed=false;const h=await harness(t,{reconcile:async(input,_session,external)=>{if(failed)throw new Error('Metadata unavailable');return external.get(input.deliveryId);}}),folder=h.folder('unknown-background'),a=await h.add('Unknown background',folder),b=await h.add('Blocked peer',folder);
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();const session=h.sessions.get(a);for(const value of h.external.values())if(value.threadId===session.threadId)Object.assign(value,{state:'idle',backgroundState:'unknown',backgroundCount:null,outcome:'completed'});
 await session.options.onEvent({type:'turn.completed',threadId:session.threadId,turnId:session.turnId,status:'completed',backgroundState:'unknown',backgroundCount:null});await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();
 failed=true;await h.manager.reconnect(a);await h.manager.pumpAll();let owner=h.manager.snapshot().goals.find(g=>g.id===a);assert.equal(owner.executionState,'unknown');assert.equal(owner.history.find(r=>r.type==='delivery').status,'completed');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);
 failed=false;for(const value of h.external.values())if(value.threadId===session.threadId)Object.assign(value,{backgroundState:'empty',backgroundCount:0});await h.manager.reconnect(a);await h.manager.pumpAll();assert.equal(h.calls.filter(c=>c.kind==='start').length,2);
});

test('one held background metadata probe does not delay an unrelated due schedule',async t=>{
 let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let heldGoal;
 const h=await harness(t,{reconcile:async(input,session,external)=>{if(session.options.goalId===heldGoal){entered();await gate;}return external.get(input.deliveryId);}}),a=await h.add('Slow metadata'),b=await h.add('Independent due');heldGoal=a;
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();const session=h.sessions.get(a);for(const value of h.external.values())if(value.threadId===session.threadId)Object.assign(value,{state:'idle',backgroundState:'active',backgroundCount:1,outcome:'completed'});await session.options.onEvent({type:'turn.completed',threadId:session.threadId,turnId:session.turnId,status:'completed',backgroundState:'active',backgroundCount:1});
 await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();h.manager.saveSchedule({goalId:b,name:'Due independently',prompt:'Inspect the current state.',cron:'* * * * *',timezone:'UTC',enabled:true});h.setTime(h.now()+60000);
 await h.manager.tick();await ready;await h.manager.pumpAll();assert.equal(h.calls.filter(c=>c.kind==='steer'&&c.goalId===b).length,1);release();await h.manager.reconnect(a);
});


for(const failureKind of ['target lookup','definite pre-send'])test(`a ${failureKind} failure for a new instruction retains an earlier background owner's target`,async t=>{
 let rejectNext=false;const h=await harness(t,{beforeStart:async()=>{if(rejectNext&&failureKind==='definite pre-send')throw Object.assign(new Error('SSH unavailable before input'),{deliveryState:'not_sent'});}}),folder=h.folder('failure-retains-owner'),a=await h.add('Live background owner',folder),b=await h.add('Waiting writer',folder);
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();const session=h.sessions.get(a);for(const value of h.external.values())if(value.threadId===session.threadId)Object.assign(value,{state:'idle',backgroundState:'active',backgroundCount:1,outcome:'completed'});await session.options.onEvent({type:'turn.completed',threadId:session.threadId,turnId:session.turnId,status:'completed',backgroundState:'active',backgroundCount:1});
 await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();const resolve=h.manager.resolveTarget;h.manager.resolveTarget=async input=>{if(rejectNext&&failureKind==='target lookup'&&input.id===a)throw new Error('SSH target unavailable');return resolve(input);};rejectNext=true;
 await h.manager.goalAction({goalId:a,action:'request',instruction:'Check the running service.'});await h.manager.pumpAll();await h.manager.pumpAll();
 const owner=h.manager.snapshot().goals.find(g=>g.id===a),peer=h.manager.snapshot().goals.find(g=>g.id===b);assert.equal(owner.executionState,'unknown');assert.equal(owner.backgroundState,'active');assert.equal(owner.backgroundCount,1);assert.ok(owner.lastError.includes('unavailable'));assert.equal(owner.history.find(row=>row.type==='delivery').status,'completed');assert.equal(owner.history.filter(row=>row.type==='delivery').at(-1).status,'queued');assert.equal(peer.executionState,'waiting');assert.equal(h.calls.filter(c=>c.kind==='start').length,1);assert.equal(h.calls.filter(c=>c.kind==='interrupt').length,0);assert.equal(h.manager.hasActiveWork(),true);
 h.manager.resolveTarget=resolve;rejectNext=false;await assert.rejects(h.manager.saveGoal({id:a,model:'different-model'}),{code:'OPS_GOAL_BUSY'});await assert.rejects(h.manager.deleteGoal(a),{code:'OPS_GOAL_BUSY'});assert.throws(()=>h.manager.restore(h.manager.exportData()),{code:'OPS_GOAL_BUSY'});
});

test('persisted background facts protect ownership and destructive guards even with an error display label',async t=>{
 const h=await harness(t),folder=h.folder('legacy-error-owner'),a=await h.add('Legacy background owner',folder),b=await h.add('Waiting peer',folder);await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();const session=h.sessions.get(a);
 await session.options.onEvent({type:'turn.completed',threadId:session.threadId,turnId:session.turnId,status:'completed',backgroundState:'active',backgroundCount:1});
 // Model the valid persisted shape produced by the earlier error transition.
 h.manager.store.update(data=>{const owner=data.goals.find(g=>g.id===a);owner.status='paused';owner.executionState='error';});
 await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();assert.equal(h.manager.snapshot().goals.find(g=>g.id===b).executionState,'waiting');assert.equal(h.manager.hasActiveWork(),true);h.manager.runtimeChanged();assert.equal(h.calls.filter(c=>c.kind==='close'&&c.goalId===a).length,0);
 await assert.rejects(h.manager.saveGoal({id:a,model:'different-model'}),{code:'OPS_GOAL_BUSY'});await assert.rejects(h.manager.deleteGoal(a),{code:'OPS_GOAL_BUSY'});assert.throws(()=>h.manager.restore(h.manager.exportData()),{code:'OPS_GOAL_BUSY'});
});

test('a metadata-only save rechecks live ownership before closing a previously idle adapter',async t=>{
 const h=await harness(t),id=await h.add('Saved during activation');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();await h.complete(id);let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),resolve=h.manager.resolveTarget;
 h.manager.resolveTarget=async input=>{if(input.name==='Updated metadata'){entered();await gate;}return resolve(input);};const save=h.manager.saveGoal({id,name:'Updated metadata'});await ready;await h.manager.goalAction({goalId:id,action:'request',instruction:'Continue work.'});await h.manager.pumpAll();release();await save;
 assert.equal(h.manager.snapshot().goals[0].executionState,'running');assert.equal(h.calls.filter(c=>c.kind==='close').length,0);
});


test('deleting an inactive proven-idle goal cannot reactivate it while its adapter close is pending',async t=>{
 let release,entered,held=false;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const h=await harness(t,{close:async()=>{if(!held){held=true;entered();await gate;}}}),id=await h.add('Delete before await');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();await h.manager.goalAction({goalId:id,action:'pause'});
 const deletion=h.manager.deleteGoal(id);await ready;await assert.rejects(h.manager.goalAction({goalId:id,action:'resume'}),{code:'OPS_GOAL_NOT_FOUND'});assert.equal(h.calls.filter(c=>c.kind==='start').length,1);release();await deletion;assert.equal(h.manager.snapshot().goals.length,0);
});


test('startup returns with durable held claims while a slow original thread reconciles and unrelated goals proceed',async t=>{
 let held=false,release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let ownerId;const h=await harness(t,{reconcile:async(input,session,external)=>{if(held&&session.options.goalId===ownerId){const persisted=JSON.parse(fs.readFileSync(path.join(h.dataPath,'ops/state.json')));assert.equal(persisted.goals.find(g=>g.id===ownerId).executionState,'unknown');entered();await gate;}return external.get(input.deliveryId);}}),folder=h.folder('restored-owner'),a=await h.add('Original thread',folder),b=await h.add('Overlapping restored peer',folder),c=await h.add('Independent goal');ownerId=a;
 await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();await h.manager.close();held=true;const recovered=new OpsManager(h.options);t.after(async()=>{release();await recovered.close();});let initialized=false;const init=recovered.init().then(()=>{initialized=true;});await ready;await new Promise(setImmediate);assert.equal(initialized,true);await init;
 await recovered.goalAction({goalId:b,action:'start'});await recovered.goalAction({goalId:c,action:'start'});await recovered.pumpAll();assert.equal(recovered.snapshot().goals.find(g=>g.id===a).executionState,'unknown');assert.equal(recovered.snapshot().goals.find(g=>g.id===b).executionState,'waiting');assert.equal(recovered.snapshot().goals.find(g=>g.id===c).executionState,'running');assert.equal(h.calls.filter(c=>c.kind==='start').length,2);
 for(const value of h.external.values())if(value.threadId==='thread-'+a)Object.assign(value,{state:'idle',backgroundState:'empty',backgroundCount:0,outcome:'completed'});release();await recovered.reconnect(a);await recovered.pumpAll();assert.equal(recovered.snapshot().goals.find(g=>g.id===b).executionState,'running');assert.equal(h.calls.filter(c=>c.kind==='start').length,3);
});

test('startup connection errors remain visible per goal without blocking independent work',async t=>{
 let unavailable=false;const h=await harness(t,{reconcile:async(input,_session,external)=>{if(unavailable)throw new Error('Original SSH unavailable');return external.get(input.deliveryId);}}),a=await h.add('Offline restored target'),b=await h.add('Usable goal');await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();await h.manager.close();unavailable=true;const recovered=new OpsManager(h.options);t.after(()=>recovered.close());await recovered.init();await recovered.reconnect(a);await recovered.goalAction({goalId:b,action:'start'});await recovered.pumpAll();const owner=recovered.snapshot().goals.find(g=>g.id===a);assert.equal(owner.executionState,'unknown');assert.match(owner.lastError,/Original SSH unavailable/);assert.equal(recovered.snapshot().goals.find(g=>g.id===b).executionState,'running');
});

test('one authoritative completed-turn proof terminalizes its accepted steering receipts without false retained claims',async t=>{
 const h=await harness(t),folder=h.folder('shared-receipts'),a=await h.add('Accepted receipts',folder),b=await h.add('Waiting after receipts',folder);await h.manager.goalAction({goalId:a,action:'start'});await h.manager.pumpAll();await h.manager.goalAction({goalId:a,action:'request',instruction:'First extra requirement.'});await h.manager.pumpAll();await h.manager.goalAction({goalId:a,action:'request',instruction:'Second extra requirement.'});await h.manager.pumpAll();await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();const owner=h.manager.snapshot().goals.find(g=>g.id===a);assert.equal(owner.history.filter(r=>r.type==='delivery'&&r.status==='accepted').length,3);
 for(const value of h.external.values())if(value.threadId===owner.threadId)Object.assign(value,{state:'idle',backgroundState:'empty',backgroundCount:0,outcome:'completed'});await h.manager.reconnect(a);await h.manager.pumpAll();assert.equal(h.manager.snapshot().goals.find(g=>g.id===a).history.filter(r=>r.type==='delivery'&&r.status==='completed').length,3);assert.equal(h.manager.snapshot().goals.find(g=>g.id===b).executionState,'running');
});


test('a held target lookup does not keep the scheduler wake open or block an unrelated due instruction',async t=>{
 const h=await harness(t),a=await h.add('Slow first connection'),b=await h.add('Independent scheduled target');await h.manager.goalAction({goalId:b,action:'start'});await h.manager.pumpAll();h.manager.saveSchedule({goalId:b,name:'Independent poll',prompt:'Inspect current progress.',cron:'* * * * *',timezone:'UTC',enabled:true});let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),resolve=h.manager.resolveTarget;t.after(()=>release());h.manager.resolveTarget=async input=>{if(input.id===a){entered();await gate;}return resolve(input);};
 await h.manager.goalAction({goalId:a,action:'start'});await ready;h.setTime(h.now()+60000);let woke=false;const wake=h.manager.scheduler.wake().then(()=>{woke=true;});await new Promise(setImmediate);assert.equal(woke,true);await wake;await h.manager.pump(b);assert.equal(h.calls.filter(c=>c.kind==='steer'&&c.goalId===b).length,1);release();await h.manager.pumpAll();
});

test('an in-progress reconciliation preserves accepted steering receipts and inconsistent idle metadata stays unknown',async t=>{
 const h=await harness(t),id=await h.add('Active receipt status');await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();await h.manager.goalAction({goalId:id,action:'request',instruction:'Continue the active turn.'});await h.manager.pumpAll();for(const value of h.external.values())Object.assign(value,{turnStatus:'inProgress',backgroundState:'empty',backgroundCount:0});
 await h.manager.reconnect(id);let current=h.manager.snapshot().goals[0];assert.equal(current.executionState,'running');assert.equal(current.history.filter(h=>h.type==='delivery'&&h.status==='accepted').length,2);assert.equal(current.history.filter(h=>h.type==='delivery'&&h.status==='completed').length,0);
 for(const value of h.external.values())value.state='idle';await h.manager.reconnect(id);current=h.manager.snapshot().goals[0];assert.equal(current.executionState,'unknown');assert.equal(current.history.filter(h=>h.type==='delivery'&&h.status==='completed').length,0);assert.equal(current.history.filter(h=>h.type==='delivery'&&h.status==='unknown').length,1);assert.equal(h.calls.filter(c=>c.kind==='start').length,1);
});


async function qaHarness(t){
 const bridges=new Map(),released=[];const h=await harness(t,{managerOptions:{createQaBridge:options=>{bridges.set(options.goalId,options);return {tools:[],release:async reason=>{released.push(options.goalId);const binding=options.getContext?(()=>{try{return h.manager.snapshot().goals.find(g=>g.id===options.goalId)?.qaBinding}catch{return null}})():null;if(binding?.sessionId)await options.recordOutcome({callId:null,status:'completed',binding:{...binding,state:'released',reason}});}};}}});
 const add=async name=>{const id=await h.add(name);h.manager.store.update(data=>Object.assign(data.goals.find(g=>g.id===id),{projectId:'project-'+id,serviceId:'service-'+id,projectEpoch:'epoch',projectBirth:1,projectConnectionSignature:'a'.repeat(64)}));await h.manager.goalAction({goalId:id,action:'start'});await h.manager.pumpAll();return id;};
 const request=(id,callId='qa-call',args={})=>{const tool='ops_qa_open',context=bridges.get(id).getContext(),argsDigest=require('node:crypto').createHash('sha256').update(JSON.stringify({args,tool})).digest('hex');return {callId,tool,args,argsDigest,context};};
 const binding=id=>({clientId:'client-'+id,sessionId:'session-'+id,windowId:'window-'+id,projectId:'project-'+id,appInstanceId:h.manager.appInstanceId});return {...h,bridges,released,qaAdd:add,request,binding};
}

test('QA operations checkpoint the original goal/thread before mutation and reject replay or foreign ownership',async t=>{
 const h=await qaHarness(t),a=await h.qaAdd('QA A'),b=await h.qaAdd('QA B'),bridge=h.bridges.get(a),request=h.request(a);assert.equal(bridge.admit(request).reused,false);await bridge.recordStart(request);const disk=JSON.parse(fs.readFileSync(path.join(h.dataPath,'ops/state.json'))),saved=disk.goals.find(g=>g.id===a).qaReceipts[0];assert.equal(saved.status,'prepared');assert.equal(saved.threadId,request.context.threadId);assert.equal(saved.turnId,request.context.turnId);assert.throws(()=>bridge.admit(request),{code:'OPS_QA_OPERATION_UNKNOWN'});
 await bridge.recordOutcome({callId:request.callId,status:'completed',binding:h.binding(a),result:{...h.binding(a),data:'MUST_NOT_PERSIST',password:'MUST_NOT_PERSIST',applied:true}});const replay=bridge.admit(request);assert.equal(replay.reused,true);assert.equal(replay.receipt.result.applied,true);assert.equal(JSON.stringify(h.manager.exportData()).includes('MUST_NOT_PERSIST'),false);assert.equal(h.manager.snapshot().goals.find(g=>g.id===b).qaReceipts.length,0);assert.throws(()=>bridge.admit({...request,context:h.bridges.get(b).getContext()}),{code:'INVALID_OPS_TOOL'});
});

test('pause fences an in-flight QA call before awaits and releases only its own goal lease',async t=>{
 const h=await qaHarness(t),a=await h.qaAdd('Pause QA A'),b=await h.qaAdd('Keep QA B');for(const id of [a,b]){const req=h.request(id,'open-'+id);await h.bridges.get(id).recordStart(req);await h.bridges.get(id).recordOutcome({callId:req.callId,status:'completed',binding:h.binding(id),result:h.binding(id)});}
 const bridge=h.bridges.get(a),request=h.request(a,'pending-input');await bridge.recordStart(request);const pause=h.manager.goalAction({goalId:a,action:'pause'});assert.throws(()=>bridge.isCurrent(request.context),{code:'OPS_QA_SCOPE'});await pause;await bridge.recordOutcome({callId:request.callId,status:'completed',result:{applied:true},binding:h.binding(a)});const goals=h.manager.snapshot().goals;assert.equal(goals.find(g=>g.id===a).qaReceipts.at(-1).status,'unknown');assert.equal(goals.find(g=>g.id===a).qaBinding.state,'released');assert.equal(goals.find(g=>g.id===b).qaBinding.state,'attached');assert.deepEqual(h.released,[a]);
});

test('restart and backup restore keep QA evidence but never adopt old leases or replay a prepared call',async t=>{
 const h=await qaHarness(t),id=await h.qaAdd('Restored QA'),bridge=h.bridges.get(id),request=h.request(id);await bridge.recordStart({...request,binding:h.binding(id)});const data=h.manager.exportData(),store=new OpsStore({dataPath:path.join(h.root,'restored')});store.restore(data);assert.equal(store.read().goals[0].qaBinding.state,'stale');assert.equal(store.read().goals[0].qaReceipts[0].status,'unknown');
 await h.manager.close();const recovered=new OpsManager(h.options);t.after(()=>recovered.close());await recovered.init();await recovered.reconnect(id);const goal=recovered.snapshot().goals[0];assert.equal(goal.qaBinding.state,'stale');assert.equal(goal.qaReceipts[0].status,'unknown');assert.notEqual(goal.qaBinding.appInstanceId,recovered.appInstanceId);const current=h.bridges.get(id);assert.throws(()=>current.admit({...request,context:current.getContext()}),{code:'OPS_QA_OPERATION_UNKNOWN'});
});

test('QA backup validation rejects bulk image data, traversal references and serialized capabilities',async t=>{
 const h=await qaHarness(t),id=await h.qaAdd('Bounded QA storage'),bridge=h.bridges.get(id),request=h.request(id);await bridge.recordStart(request);await bridge.recordOutcome({callId:request.callId,status:'completed',binding:h.binding(id),result:{applied:true}});const {validateOpsData}=require('../electron/ops-store.cjs'),base=h.manager.exportData();
 for(const mutate of [g=>{g.qaBinding.guard={capability:true};},g=>{g.qaReceipts[0].result.data='base64';},g=>{g.qaReceipts[0].capture={id:'11111111-1111-4111-8111-111111111111',sha256:'a'.repeat(64),size:100,mimeType:'image/png',width:1,height:1,relativePath:'../capture.png'};}]){const changed=structuredClone(base);mutate(changed.goals[0]);assert.throws(()=>validateOpsData(changed),{code:'OPS_STORAGE_UNAVAILABLE'});}
});
