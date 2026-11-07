'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../src/remote/write-observation.mjs');
const binding={version:1,epoch:'11111111-1111-4111-8111-111111111111',projectId:'project',reviewId:'review',projectBirth:3,reviewGeneration:4,revision:7,status:'open'};
test('a draft retains its original revision after a newer view refreshes',async()=>{
 const {observedCommand,sameWriteObservation}=await modulePromise;
 const draft=Object.freeze({...binding}),fresh={...binding,revision:8};
 assert.equal(sameWriteObservation(draft,fresh),false);
 const command=observedCommand({operation:'review.update',requestId:'original-draft',projectId:'project',reviewId:'review',payload:{title:'Retained original draft'},binding:draft});
 assert.equal(command.expectedRevision,7);assert.equal(command.expectedReviewGeneration,4);assert.equal(command.expectedProjectBirth,3);
 assert.throws(()=>observedCommand({operation:'comment.add',requestId:'different-selection',projectId:'other',reviewId:'review',payload:{body:'retained'},binding:draft}),{code:'INVALID_RESPONSE'});
});
test('a review read interleaved with a host write does not adopt the newer revision for older content',async()=>{
 const {readObservedReview}=await modulePromise;let calls=0;
 await assert.rejects(readObservedReview({projectId:'project',reviewId:'review',assertCurrent(){},
  writeState:async()=>({...binding,revision:calls++?8:7}),read:async operation=>operation==='reviews.get'?{review:{body:'Before concurrent write'}}:{activities:[]}}),{code:'REVISION_CONFLICT'});
});
test('a late response from a retired selection is never adopted by the next review',async()=>{
 const {readObservedReview}=await modulePromise;let live=true,reads=0;
 await assert.rejects(readObservedReview({projectId:'project',reviewId:'review',assertCurrent(){if(!live)throw Object.assign(new Error(),{code:'STALE_REMOTE_VIEW'});},
  writeState:async()=>({...binding}),read:async()=>{reads++;live=false;return {review:{}};}}),{code:'STALE_REMOTE_VIEW'});
 assert.equal(reads,1);
});
