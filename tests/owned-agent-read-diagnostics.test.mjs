import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentReadDiagnostics,retainAgentReadSnapshot,retainAgentReadFailure} from '../scripts/owned-agent-read-diagnostics.mjs';
const group=Array.from({length:3},(_,i)=>({id:'job-'+i,role:'role-'+i,reviewId:'review-'+i,serviceId:'service-'+i,workPath:'/private/work-'+i}));
test('retains all three actual status/error/scope distinctions without copying output or settings',()=>{
 const state=createAgentReadDiagnostics(),rows=group.map((v,i)=>({...v,status:i===0?'running':'failed',errorCode:i===0?'':'AGENT_NOT_INSTALLED',error:i===0?'':'Version probe timed out',output:'SECRET OUTPUT',prompt:'SECRET PROMPT',auth:'SECRET AUTH',executionSettings:{token:'SECRET TOKEN'}}));
 retainAgentReadSnapshot(state,{tag:'normal',projectId:'project',group,rows,at:'2026-11-02T00:00:00Z'});
 assert.deepEqual(state.last.rows.map(v=>v.actual.status),['running','failed','failed']);assert.equal(state.last.rows[2].actual.errorCode,'AGENT_NOT_INSTALLED');assert.equal(state.last.rows[1].actual.error,'Version probe timed out');assert.equal(state.last.rows[2].actual.serviceId,group[2].serviceId);assert.deepEqual(state.last.rows.map(v=>v.expected.id),group.map(v=>v.id));assert.doesNotMatch(JSON.stringify(state),/SECRET|output|prompt|auth|executionSettings/);
});
test('many observations keep only the last three bounded rows and redact credential-like error values',()=>{
 const state=createAgentReadDiagnostics(),many=Array.from({length:20},(_,i)=>({...group[0],id:'job-'+i}));
 for(let i=0;i<1000;i++)retainAgentReadSnapshot(state,{tag:'normal',projectId:'project',group:many,rows:many.map(v=>({...v,status:'failed',errorCode:'E'.repeat(1000),error:'Bearer private-value token=another-private-value '+ 'x'.repeat(10000),prompt:'do not copy'})),at:String(i)});
 assert.equal(state.observations,1000);assert.equal(state.last.at,'999');assert.equal(state.last.rows.length,3);assert.ok(Buffer.byteLength(JSON.stringify(state))<8000);assert.doesNotMatch(JSON.stringify(state),/private-value|prompt/);assert.ok(state.last.rows.every(v=>v.actual.error.length<=512&&v.actual.errorCode.length<=128));
});
test('failure freezes the last original observation without replacement reads or later object mutation',()=>{
 const state=createAgentReadDiagnostics(),rows=group.map(v=>({...v,status:'failed',error:'original failure'}));retainAgentReadSnapshot(state,{tag:'normal',projectId:'project',group,rows,at:'before failure'});retainAgentReadFailure(state,'failure cutoff');rows[0].error='changed raw';state.last.rows[0].actual.error='changed latest';assert.equal(state.failure.lastObserved.rows[0].actual.error,'original failure');assert.equal(state.failure.lastObserved.at,'before failure');assert.equal(state.failure.at,'failure cutoff');assert.equal(state.observations,1);
 const empty=createAgentReadDiagnostics();retainAgentReadFailure(empty,'before any complete read');assert.equal(empty.failure.lastObserved,null);assert.equal(empty.observations,0);
});
