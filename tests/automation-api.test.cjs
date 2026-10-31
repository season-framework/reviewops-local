'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../electron/store.cjs');
const { createAutomationApi } = require('../electron/automation-api.cjs');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-automation-'));
  const dbPath = path.join(directory,'reviews.sqlite'); let store = createStore({dbPath});
  const group = store.saveGroup({name:'QA group'});
  const serviceA = store.saveService({groupId:group.id,name:'A connection',kind:'local',rootPath:directory});
  const serviceB = store.saveService({groupId:group.id,name:'B connection',kind:'ssh',host:'private.invalid',username:'secret-user',privateKeyPath:'/tmp/private-key'});
  const a = store.saveProject({groupId:group.id,name:'Project A',serviceIds:[serviceA.id]}), b = store.saveProject({groupId:group.id,name:'Project B',serviceIds:[serviceB.id]});
  const calls=[],qaCalls=[]; let api;
  const dispatch = async (action,payload={}) => {
    calls.push({action,payload});
    if(action==='snapshot') return store.snapshot();
    if(action==='review.save') return store.saveReview(payload);
    if(action==='agent.list') return store.listAgentRuns(payload.reviewId);
    if(action==='agent.read') return store.get('agent_runs',payload.id);
    if(action==='agent.start') return store.saveAgentRun({id:payload.requestId,reviewId:payload.reviewId,serviceId:store.get('reviews',payload.reviewId).serviceId,prompt:payload.prompt,status:'running'});
    if(action==='agent.cancel') return store.saveAgentRun({id:payload.id,status:'cancelled'});
    throw new Error('Unexpected dispatch '+action);
  };
  function start() { api=createAutomationApi({dispatch,qa:async(action,payload)=>{qaCalls.push({action,payload});return payload;}}); }
  start();
  return { a,b,serviceA,serviceB,calls,qaCalls, get store(){return store;}, handle:(action,payload)=>api.handle('automation.'+action,payload),
    create:(project=a,requestId='new-review')=>api.handle('automation.reviews.create',{projectId:project.id,requestId,title:'QA review',serviceId:project===a?serviceA.id:serviceB.id}),
    restart(){store.close();store=createStore({dbPath});start();},
    async close(){store.close();await fs.rm(directory,{recursive:true,force:true});}
  };
}
test('project discovery excludes credentials and data operations never invoke a window',async()=>{
  const f=await fixture();try{
    const result=await f.handle('projects.list',{});
    assert.equal(result.projects.length,2);
    for(const secret of ['private.invalid','secret-user','private-key'])assert.ok(!JSON.stringify(result).includes(secret));
    const made=await f.create();
    assert.equal(made.projectId,f.a.id);
    assert.equal((await f.handle('reviews.list',{projectId:f.b.id})).reviews.length,0);
    assert.equal((await f.handle('reviews.get',{projectId:f.a.id,reviewId:made.reviewId})).activities.length,1);
    assert.equal(f.qaCalls.length,0);
  }finally{await f.close();}
});
test('concurrent identical creation and retry after restart create one review without overwriting edits',async()=>{
  const f=await fixture();try{
    const [first,second]=await Promise.all([f.create(),f.create()]);
    assert.equal(first.reviewId,second.reviewId);assert.equal(f.store.snapshot().reviews.length,1);
    await f.handle('reviews.update',{projectId:f.a.id,reviewId:first.reviewId,body:'Edited in app'});
    f.restart();
    const retry=await f.create();assert.equal(retry.reviewId,first.reviewId);assert.equal(retry.review.body,'Edited in app');assert.equal(retry.reused,true);
    await assert.rejects(f.handle('reviews.create',{projectId:f.a.id,requestId:'new-review',title:'Changed',serviceId:f.serviceA.id}),{code:'REQUEST_ID_CONFLICT'});
    await assert.rejects(f.create(f.b),{code:'REQUEST_ID_CONFLICT'});
  }finally{await f.close();}
});
test('cross-project review IDs and foreign services fail before changing data',async()=>{
  const f=await fixture();try{
    const review=await f.create();
    for(const action of ['reviews.get','reviews.update','runs.list','runs.start']){
      const args={projectId:f.b.id,reviewId:review.reviewId,...(action==='reviews.update'?{title:'wrong'}:{}),...(action==='runs.start'?{requestId:'wrong-run',prompt:'wrong'}:{})};
      await assert.rejects(f.handle(action,args),{code:'TARGET_MISMATCH'});
    }
    await assert.rejects(f.handle('reviews.create',{projectId:f.a.id,requestId:'foreign-service',title:'bad',serviceId:f.serviceB.id}));
    assert.equal(f.store.snapshot().reviews.length,1);assert.equal(f.store.listAgentRuns().length,0);
  }finally{await f.close();}
});
test('run status, logs and cancellation remain attached to exact project and review',async()=>{
  const f=await fixture();try{
    const [ra,rb]=await Promise.all([f.create(f.a,'review-a'),f.create(f.b,'review-b')]);
    const [a,b]=await Promise.all([f.handle('runs.start',{projectId:f.a.id,reviewId:ra.reviewId,requestId:'run-a',prompt:'A work'}),f.handle('runs.start',{projectId:f.b.id,reviewId:rb.reviewId,requestId:'run-b',prompt:'B work'})]);
    f.store.saveAgentRun({id:a.runId,output:'A output',response:'A response'});
    await assert.rejects(f.handle('runs.get',{projectId:f.b.id,reviewId:rb.reviewId,runId:a.runId}),{code:'TARGET_MISMATCH'});
    await assert.rejects(f.handle('runs.cancel',{projectId:f.b.id,reviewId:rb.reviewId,runId:a.runId}),{code:'TARGET_MISMATCH'});
    const result=await f.handle('runs.get',{projectId:f.a.id,reviewId:ra.reviewId,runId:a.runId});
    assert.equal(result.run.output,'A output');assert.equal(result.run.response,'A response');
    await f.handle('runs.cancel',{projectId:f.a.id,reviewId:ra.reviewId,runId:a.runId});
    assert.equal(f.store.get('agent_runs',a.runId).status,'cancelled');assert.equal(f.store.get('agent_runs',b.runId).status,'running');
  }finally{await f.close();}
});
test('unknown fields, empty updates and malformed targets cannot bypass ownership checks',async()=>{
  const f=await fixture();try{
    const r=await f.create();
    for(const [action,payload] of [
      ['reviews.update',{projectId:f.a.id,reviewId:r.reviewId,id:'other',title:'X'}],
      ['reviews.update',{projectId:f.a.id,reviewId:r.reviewId}],
      ['reviews.list',{projectId:'__proto__'}],
      ['runs.start',{projectId:f.a.id,reviewId:r.reviewId,requestId:'bad',prompt:' ',independentExecution:true}],
      ['projects.list',{projectId:f.a.id}]
    ])await assert.rejects(f.handle(action,payload),{code:'INVALID_REQUEST'});
    await assert.rejects(f.handle('delete.everything',{}),{code:'UNKNOWN_ACTION'});
    assert.equal(f.store.get('reviews',r.reviewId).title,'QA review');
  }finally{await f.close();}
});
