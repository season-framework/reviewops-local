'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createViewerSessions,cropRectangle}=require('../electron/viewer-sessions.cjs');
function fixture(){
 let tick=1,alive=true,loading=false,calls=0,resolve;
 const registry=createViewerSessions({now:()=>tick,ttl:1000});
 const details={projectId:'project-a',serviceId:'service-a',owner:'owner-a',targetId:'target-a',alive:()=>alive,describe:()=>({title:'A private title',url:'http://a.invalid',loading}),capture:async()=>{calls++;if(resolve)await new Promise(done=>{resolve.done=done});return {dataUrl:'data:image/png;base64,eA==',width:1920,height:1080,capturedAt:'2026-11-02T00:00:00Z'}},evidence:async()=>({available:true})};
 const sessionId=registry.register(details);registry.register({...details,projectId:'project-b',owner:'owner-b',targetId:'target-b',describe:()=>({title:'B secret',url:'http://secret.invalid'})});
 const binding={consumer:'consumer-a',contextId:'draft-a',projectId:'project-a',reviewId:'review-a',generation:1};registry.setContext(binding);
 const begin=()=>registry.begin({...binding,sessionId,epoch:1});
 return {registry,binding,sessionId,begin,details,get calls(){return calls},close(){alive=false},load(){loading=true},defer(){resolve={};return ()=>resolve.done()},time(){tick=2000}};
}
test('a project list exposes only its own live target and implemented read-only capabilities',()=>{
 const f=fixture(),[s]=f.registry.list('project-a');assert.equal(s.title,'A private title');assert.equal(f.registry.list('project-a').length,1);assert.equal(s.capabilities.provider,'web');assert.equal(s.capabilities.input,false);assert.equal(s.capabilities.virtualDisplay,false);f.close();assert.deepEqual(f.registry.list('project-a'),[]);
});
test('a guessed session cannot be acquired across projects',()=>{
 const f=fixture();f.registry.setContext({...f.binding,contextId:'draft-b',projectId:'project-b',reviewId:'review-b'});
 assert.throws(()=>f.registry.begin({...f.binding,contextId:'draft-b',sessionId:f.sessionId,epoch:1}),{code:'TARGET_MISMATCH'});
});
test('another consumer cannot preview or freeze an intent or proof',async()=>{
 const f=fixture(),{intentId}=f.begin();await assert.rejects(f.registry.capture('consumer-b',intentId),{code:'STALE_CAPTURE'});
 const result=await f.registry.capture('consumer-a',intentId);assert.throws(()=>f.registry.freeze('consumer-b',result.captureProof),{code:'STALE_CAPTURE'});
});
test('preview uses the existing adapter without granting a staging proof',async()=>{
 const f=fixture(),{intentId}=f.begin(),preview=await f.registry.capture('consumer-a',intentId,{preview:true});assert.equal(f.calls,1);assert.equal(preview.captureProof,undefined);assert.equal(preview.source.sessionId,f.sessionId);assert.equal(preview.source.originalSha256.length,64);
});
test('navigation, source replacement and owner closure reject late frames',async()=>{
 for(const change of ['navigation','owner','replacement']){
  const f=fixture(),{intentId}=f.begin(),finish=f.defer(),pending=f.registry.capture('consumer-a',intentId);await Promise.resolve();
  if(change==='navigation')f.registry.changed(f.sessionId);else if(change==='owner')f.registry.closeOwner('owner-a');else f.registry.revoke(f.sessionId);
  finish();await assert.rejects(pending,{code:change==='navigation'?'TARGET_CHANGED':'SESSION_GONE'});
 }
});
test('an in-flight frame is rejected after draft text generation changes or the composer closes',async()=>{
 for(const change of ['edit','cancel']){
  const f=fixture(),{intentId}=f.begin(),finish=f.defer(),pending=f.registry.capture('consumer-a',intentId);await Promise.resolve();
  if(change==='edit')f.registry.setContext({...f.binding,generation:2});else f.registry.closeContext('consumer-a','draft-a');finish();await assert.rejects(pending,{code:'STALE_CAPTURE'});
 }
});
test('a completed frame cannot be staged after navigation, cancellation or generation change',async()=>{
 for(const change of ['navigation','cancel','edit']){
  const f=fixture(),{intentId}=f.begin(),image=await f.registry.capture('consumer-a',intentId);
  if(change==='navigation')f.registry.changed(f.sessionId);else if(change==='cancel')f.registry.end('consumer-a',intentId);else f.registry.setContext({...f.binding,generation:2});
  assert.throws(()=>f.registry.freeze('consumer-a',image.captureProof),{code:change==='navigation'?'TARGET_CHANGED':'STALE_CAPTURE'});
 }
});
test('accepted frozen evidence survives source navigation/closure and legitimate text editing',async()=>{
 const f=fixture(),{intentId}=f.begin(),image=await f.registry.capture('consumer-a',intentId),frozen=f.registry.freeze('consumer-a',image.captureProof,{x:10,y:20,width:600,height:400});f.registry.consume(image.captureProof);
 f.registry.changed(f.sessionId);f.registry.closeOwner('owner-a');f.registry.setContext({...f.binding,generation:2});
 f.registry.assertFrozen(frozen.binding,{consumer:'consumer-a',contextId:'draft-a',projectId:'project-a',reviewId:'review-a'});assert.deepEqual(frozen.source.crop,{x:10,y:20,width:600,height:400});assert.equal(frozen.bytes.toString(),'x');
 assert.throws(()=>f.registry.freeze('consumer-a',image.captureProof),{code:'STALE_CAPTURE'});
});
test('frozen evidence is bound to the exact consumer, project, review and draft, not a new composer',async()=>{
 const f=fixture(),image=await f.registry.capture('consumer-a',f.begin().intentId),{binding}=f.registry.freeze('consumer-a',image.captureProof);
 const destination={consumer:'consumer-a',contextId:'draft-a',projectId:'project-a',reviewId:'review-a'};
 for(const [field,value] of Object.entries({consumer:'consumer-b',contextId:'draft-b',projectId:'project-b',reviewId:'review-b'}))assert.throws(()=>f.registry.assertFrozen(binding,{...destination,[field]:value}),{code:'TARGET_MISMATCH'});
 f.registry.closeContext('consumer-a','draft-a');assert.throws(()=>f.registry.assertFrozen(binding,destination),{code:'STALE_CAPTURE'});
});
test('new-review drafts accept only a new review in the bound project and context',async()=>{
 const f=fixture();f.registry.setContext({...f.binding,contextId:'new-review',reviewId:''});
 const {intentId}=f.registry.begin({...f.binding,contextId:'new-review',sessionId:f.sessionId,epoch:1}),image=await f.registry.capture('consumer-a',intentId),{binding}=f.registry.freeze('consumer-a',image.captureProof);
 f.registry.assertFrozen(binding,{consumer:'consumer-a',contextId:'new-review',projectId:'project-a',reviewId:'newly-created',creatingReview:true});
 assert.throws(()=>f.registry.assertFrozen(binding,{consumer:'consumer-a',contextId:'other-draft',projectId:'project-a',reviewId:'newly-created'}),{code:'TARGET_MISMATCH'});
});
test('loading targets, stale epochs, expired and cancelled requests fail closed',async()=>{
 const f=fixture();assert.throws(()=>f.registry.begin({...f.binding,sessionId:f.sessionId,epoch:0}),{code:'TARGET_CHANGED'});const {intentId}=f.begin();f.load();await assert.rejects(f.registry.capture('consumer-a',intentId),{code:'FRAME_NOT_READY'});f.time();await assert.rejects(f.registry.capture('consumer-a',intentId),{code:'STALE_CAPTURE'});
});
test('crop coordinates use original source pixels and reject overflow/fractional rectangles',()=>{
 assert.deepEqual(cropRectangle(null,3840,2160),{x:0,y:0,width:3840,height:2160});assert.deepEqual(cropRectangle({x:1920,y:1080,width:1920,height:1080},3840,2160),{x:1920,y:1080,width:1920,height:1080});
 for(const rect of [{x:-1,y:0,width:1,height:1},{x:0,y:0,width:3841,height:1},{x:.5,y:0,width:1,height:1},{x:0,y:0,width:0,height:1}])assert.throws(()=>cropRectangle(rect,3840,2160),{code:'INVALID_CROP'});
});
test('frozen capture purposes distinguish a review draft, new comment and exact activity edit',async()=>{
 for(const purpose of ['activity-new','activity-edit']){
  const f=fixture(),binding={...f.binding,contextId:'purpose-test',purpose,activityId:purpose==='activity-edit'?'activity-a':''};f.registry.setContext(binding);const acquired=f.registry.begin({...binding,sessionId:f.sessionId,epoch:1}),image=await f.registry.capture('consumer-a',acquired.intentId),frozen=f.registry.freeze('consumer-a',image.captureProof);
  const destination={consumer:'consumer-a',contextId:'purpose-test',projectId:'project-a',reviewId:'review-a',purpose,activityId:binding.activityId};f.registry.assertFrozen(frozen.binding,destination);
  assert.throws(()=>f.registry.assertFrozen(frozen.binding,{...destination,purpose:'review'}),{code:'TARGET_MISMATCH'});
  if(purpose==='activity-edit')assert.throws(()=>f.registry.assertFrozen(frozen.binding,{...destination,activityId:'activity-b'}),{code:'TARGET_MISMATCH'});
 }
});
