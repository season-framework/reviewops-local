'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createOpsQa}=require('../electron/ops-qa.cjs');
const png=()=>{const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(800,16);bytes.writeUInt32BE(600,20);return bytes;};
async function refused(operation,code){const result=await operation;assert.equal(result.success,false);const error=JSON.parse(result.text).error;if(code)assert.equal(error.code,code);return error;}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-ops-qa-')),receipts=new Map(),calls=[],outcomes=[];let gate,mutations=0,removed=false,releaseFailures=0,outcomeFailures=0,leaseState='attached',proofOverride=null;
 let context={goalId:'goal_A',status:'active',threadId:'thread_A',turnId:'turn_A',projectId:'project_A',projectEpoch:'epoch_one',projectBirth:1,serviceId:'service_A',lifecycleToken:{},appInstanceId:'app_one'};
 const options={goalId:'goal_A',captureDir:path.join(root,'captures'),getContext:()=>{if(removed)throw new Error('Goal deleted');return context;},isCurrent:value=>{if(value.lifecycleToken!==context.lifecycleToken||value.threadId!==context.threadId||value.turnId!==context.turnId||value.projectEpoch!==context.projectEpoch||value.projectBirth!==context.projectBirth||context.status!=='active')throw Object.assign(new Error('Goal changed'),{code:'OPS_QA_STALE'});},
  admit:request=>{const old=receipts.get(request.callId);if(old){assert.equal(old.argsDigest,request.argsDigest);if(!['completed','failed'].includes(old.status))throw Object.assign(new Error('Original unknown'),{code:'OPS_QA_UNKNOWN'});return {reused:true,receipt:old};}return {reused:false};},
  recordStart:request=>{assert.equal(receipts.has(request.callId),false);receipts.set(request.callId,{...request,status:'prepared'});},
  recordOutcome:result=>{if(!result.callId&&outcomeFailures>0){outcomeFailures--;throw new Error('Receipt storage failed');}outcomes.push(result);if(result.callId)receipts.set(result.callId,{...receipts.get(result.callId),...result});},
  handle:async(action,payload,guard)=>{calls.push({action,payload});guard();if(action==='status')return {projectId:payload.projectId,availability:'available',bindingState:payload.binding?'attached':'not_supplied'};if(action==='automation.qa.open'){leaseState='attached';return {projectId:payload.projectId,clientId:payload.clientId,sessionId:'session_A',windowId:'window_A'};}
   if(action==='cleanupStatus')return {...payload,leaseState,...proofOverride};
   if(action==='automation.qa.release'){if(releaseFailures>0){releaseFailures--;throw new Error('Temporary release failure');}if(leaseState==='absent')throw Object.assign(new Error('Original lease is gone'),{code:'SESSION_MISMATCH'});leaseState='absent';return {...payload,released:true};}
   if(action==='automation.qa.type'){await gate;guard();mutations++;}
   if(action==='automation.qa.capture')return {...payload,mimeType:'image/png',data:png().toString('base64'),width:800,height:600,viewport:{width:800,height:600},imageToCss:{scaleX:1,scaleY:1}};
   return {...payload,...(action.endsWith('release')?{released:true}:{applied:true})};}};
 const bridge=createOpsQa(options),call=(name,args={},callId=name)=>bridge.tools.find(tool=>tool.name===name).execute(args,{callId,threadId:context.threadId,turnId:context.turnId});
 t.after(async()=>{await bridge.close().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});});
 return {root,receipts,calls,outcomes,options,bridge,call,setContext:change=>{context={...context,...change};},removeGoal:()=>{removed=true;},setGate:value=>{gate=value;},failReleases:count=>{releaseFailures=count;},failCleanupOutcomes:count=>{outcomeFailures=count;},setProof:value=>{proofOverride=value;},get mutations(){return mutations;}};
}
test('QA schemas derive from public tools but only the trusted goal chooses project, client, session and window',async t=>{
 const f=fixture(t);assert.equal(f.bridge.tools.length,13);for(const tool of f.bridge.tools)for(const name of ['projectId','clientId','sessionId','windowId'])assert.equal(Object.hasOwn(tool.inputSchema.properties,name),false);
 await refused(f.call('ops_qa_open',{projectId:'other'}),'INVALID_REQUEST');assert.equal(f.calls.length,0);
 await f.call('ops_qa_open');const open=f.calls[0];assert.equal(open.payload.projectId,'project_A');assert.match(open.payload.clientId,/^ops_[a-f0-9]{48}$/);
 await f.call('ops_qa_type',{text:'owned'});assert.equal(f.mutations,1);assert.deepEqual(f.calls.at(-1).payload,{text:'owned',sessionId:'session_A',projectId:'project_A',windowId:'window_A'});
 assert.equal(f.receipts.get('ops_qa_type').status,'completed');
});
test('capture stores original private PNG bytes and returns transient image content with metadata-only receipts',async t=>{
 const f=fixture(t);await f.call('ops_qa_open');const result=await f.call('ops_qa_capture'),metadata=JSON.parse(result.text),receipt=f.receipts.get('ops_qa_capture');
 assert.equal(result.images.length,1);assert.deepEqual(result.images[0],png());assert.equal(metadata.data,undefined);assert.equal(JSON.stringify(receipt).includes(png().toString('base64')),false);assert.equal(receipt.capture.size,png().length);assert.equal(receipt.capture.mimeType,'image/png');assert.equal(path.isAbsolute(receipt.capture.relativePath),false);
 assert.equal(fs.statSync(path.join(f.options.captureDir,receipt.capture.relativePath)).mode&0o077,0);
 const duplicate=await f.call('ops_qa_capture');assert.deepEqual(duplicate.images,result.images);assert.equal(f.calls.filter(row=>row.action==='automation.qa.capture').length,1);
 fs.writeFileSync(path.join(f.options.captureDir,receipt.capture.relativePath),'changed');await refused(f.call('ops_qa_capture'),'OPS_QA_IMAGE_UNAVAILABLE');assert.equal(f.calls.filter(row=>row.action==='automation.qa.capture').length,1);
});
test('a restarted bridge returns completed receipts without adopting their old lease or replaying input',async t=>{
 const f=fixture(t);await f.call('ops_qa_open');await f.call('ops_qa_type',{text:'once'});const other=createOpsQa(f.options);t.after(()=>other.close());
 const run=(name,args,callId)=>other.tools.find(tool=>tool.name===name).execute(args,{callId,threadId:'thread_A',turnId:'turn_A'});
 await run('ops_qa_type',{text:'once'},'ops_qa_type');assert.equal(f.mutations,1);
 const state=await run('ops_qa_state',{},'new_state');assert.equal(state.success,false);assert.equal(JSON.parse(state.text).error.code,'OPS_QA_NOT_CONNECTED');assert.equal(f.calls.filter(row=>row.action==='automation.qa.state').length,0);
});
test('prepared or unknown receipts are never replayed, and a folder-only goal cannot acquire QA',async t=>{
 const f=fixture(t);await f.call('ops_qa_open');f.receipts.set('uncertain',{status:'unknown',argsDigest:f.receipts.get('ops_qa_open').argsDigest});const error=await refused(f.call('ops_qa_open',{},'uncertain'),'OPS_QA_UNKNOWN');assert.match(error.message,/Do not replay this operation/);assert.equal(f.calls.length,1);
 f.setContext({projectId:''});await refused(f.call('ops_qa_status',{},'folder'),'OPS_QA_SCOPE');assert.equal(f.calls.length,1);
});
test('pause invalidates a held operation before GUI input and releases only the captured own lease',async t=>{
 const f=fixture(t);await f.call('ops_qa_open');let release;f.setGate(new Promise(resolve=>release=resolve));const pending=f.call('ops_qa_type',{text:'must not apply'},'held');
 while(!f.calls.some(row=>row.action==='automation.qa.type'))await new Promise(resolve=>setImmediate(resolve));
 f.setContext({status:'paused',lifecycleToken:{}});await f.bridge.release('Paused');release();const result=await pending;assert.equal(result.success,false);assert.equal(f.mutations,0);assert.equal(f.receipts.get('held').status,'unknown');
 const cleanup=f.calls.find(row=>row.action==='automation.qa.release');assert.deepEqual(cleanup.payload,{sessionId:'session_A',projectId:'project_A',windowId:'window_A'});assert.equal(f.outcomes.find(row=>row.callId===null).binding.state,'released');
});
test('project replacement refuses old input while cleanup uses its own original binding after goal deletion',async t=>{
 const f=fixture(t);await f.call('ops_qa_open');f.setContext({projectBirth:2,projectEpoch:'new',lifecycleToken:{}});await refused(f.call('ops_qa_state',{},'changed'),'OPS_QA_STALE');assert.equal(f.calls.length,1);
 f.removeGoal();await f.bridge.release('Deleted');assert.equal(f.calls.at(-1).action,'automation.qa.release');assert.equal(f.calls.at(-1).payload.projectId,'project_A');
});

test('failed release retains the exact private lease and blocks acquisition until explicit cleanup succeeds',async t=>{
 const f=fixture(t);await f.call('ops_qa_open');f.failReleases(1);await assert.rejects(f.bridge.release('Pause failed'),{code:'OPS_QA_RELEASE_UNCONFIRMED'});
 const count=f.calls.length;await refused(f.call('ops_qa_open',{},'blocked_open'),'OPS_QA_RELEASE_UNCONFIRMED');assert.equal(f.calls.length,count);
 await f.bridge.release('Explicit recovery');const releases=f.calls.filter(row=>row.action==='automation.qa.release');assert.equal(releases.length,2);assert.deepEqual(releases[0].payload,releases[1].payload);assert.deepEqual(releases[1].payload,{sessionId:'session_A',projectId:'project_A',windowId:'window_A'});
 assert.equal(f.outcomes.filter(row=>row.callId===null).at(-1).binding.state,'released');
});

test('an already applied release with failed receipt storage recovers only from exact original-binding absence proof',async t=>{
 const f=fixture(t);await f.call('ops_qa_open');const clientId=f.calls[0].payload.clientId;f.failCleanupOutcomes(1);await assert.rejects(f.bridge.release('Lost receipt'),/Receipt storage failed/);
 await f.bridge.release('Retry original receipt');const proof=f.calls.find(row=>row.action==='cleanupStatus');assert.deepEqual(proof.payload,{clientId,sessionId:'session_A',projectId:'project_A',windowId:'window_A'});
 assert.equal(f.calls.filter(row=>row.action==='automation.qa.open').length,1);assert.equal(f.calls.filter(row=>row.action==='automation.qa.release').length,2);assert.equal(f.outcomes.at(-1).binding.state,'released');
});

test('unknown or mismatched cleanup status never confirms another lease as the original released lease',async t=>{
 const f=fixture(t);await f.call('ops_qa_open');f.failReleases(2);f.setProof({leaseState:'unknown'});await assert.rejects(f.bridge.release('Unavailable status'),{code:'OPS_QA_RELEASE_UNCONFIRMED'});
 f.setProof({leaseState:'absent',windowId:'another_window'});await assert.rejects(f.bridge.release('Mismatched status'),{code:'OPS_QA_RELEASE_UNCONFIRMED'});assert.ok(f.outcomes.filter(row=>row.callId===null).every(row=>row.binding.state==='unknown'));
 f.setProof(null);await f.bridge.release('Confirmed original cleanup');assert.equal(f.outcomes.at(-1).binding.windowId,'window_A');assert.equal(f.outcomes.at(-1).binding.state,'released');
});
