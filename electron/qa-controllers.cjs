'use strict';
// Ephemeral app-owned controller proofs. Nothing here is persisted or logged.
const crypto=require('node:crypto');
const {validateQaControllerArguments}=require('./automation-api.cjs');
const CONTRACT='logical-qa-controller-v1';
const refuse=(code,message='The original QA controller could not be verified.')=>{throw Object.assign(new Error(message),{code});};
const digest=value=>crypto.createHash('sha256').update(value).digest();
function createQaControllers({appInstanceId,now,sessionTimeoutMs,qa,status,leaseStatus,captureTarget,onPublicChange=()=>{}}){
 const records=new Map();let closed=false;
 const expires=record=>!record.active&&now()-record.touched>sessionTimeoutMs;
 const binding=record=>record.lease&&({sessionId:record.lease.sessionId,projectId:record.projectId,windowId:record.lease.windowId});
 const describe=(record,operation)=>({contract:CONTRACT,operation,appInstanceId,controllerId:record.id,projectId:record.projectId,reviewId:record.reviewId,state:record.state,generation:record.generation,expiresAt:new Date(record.touched+sessionTimeoutMs).toISOString(),sessionId:record.lease?.sessionId??null,windowId:record.lease?.windowId??null,clientId:record.lease?.clientId??null});
 const publish=record=>onPublicChange(record.lease?.windowId,{contract:CONTRACT,label:record.label,projectId:record.projectId,state:record.state,generation:record.generation});
 function current(record,guard,generation,{attached=true}={}){
  guard();
  if(closed||records.get(record.id)!==record||record.generation!==generation)refuse('QA_CONTROLLER_STALE');
  if(expires(record))refuse('QA_CONTROLLER_EXPIRED');
  record.assertTarget();
  if(record.state==='released')refuse('QA_CONTROLLER_PROOF_REFUSED');
  if(attached&&record.state!=='attached')refuse('QA_CONTROLLER_DETACHED');
 }
 function authenticate(payload,guard){
  guard();const record=records.get(payload.controllerId),hash=digest(payload.controllerProof);
  if(!record||payload.appInstanceId!==appInstanceId||record.projectId!==payload.projectId||!crypto.timingSafeEqual(record.proofHash,hash))refuse('QA_CONTROLLER_PROOF_REFUSED');
  if(closed)refuse('QA_CONTROLLER_STALE');
  if(expires(record))refuse('QA_CONTROLLER_EXPIRED');
  record.assertTarget();return record;
 }
 function serial(record,work){const task=record.queue.then(work);record.queue=task.catch(()=>{});return task;}
 const inputOperations=new Set(['click','type','key','scroll']);
 async function open(payload,guard){
  guard();if(closed)refuse('QA_CONTROLLER_STALE');
  for(const [key,record] of records)if(expires(record))records.delete(key);
  if(records.size>=64)refuse('SESSION_LIMIT');
  const proof=crypto.randomBytes(32).toString('base64url'),record={id:crypto.randomUUID(),proofHash:digest(proof),projectId:payload.projectId,reviewId:payload.reviewId??'',label:payload.label??'External QA',clientId:crypto.randomUUID(),state:'attached',generation:1,touched:now(),active:1,observations:new Map(),queue:Promise.resolve(),assertTarget:captureTarget(payload)};
  records.set(record.id,record);
  try{
   const lease=await qa('open',{projectId:record.projectId,clientId:record.clientId,...(record.reviewId?{reviewId:record.reviewId}:{})},()=>current(record,guard,1));
   record.lease=lease;current(record,guard,1);record.touched=now();publish(record);
   return {...describe(record,'open'),controllerProof:proof};
  }catch(error){records.delete(record.id);if(record.lease)try{await qa('release',binding(record),()=>{});}catch{}throw error;}
  finally{record.active--;}
 }
 function handle(payload,guard=()=>{}){
  validateQaControllerArguments(payload);
  payload=Object.freeze({...payload,...(payload.modifiers?{modifiers:Object.freeze([...payload.modifiers])}:{})});
  if(payload.operation==='open')return open(payload,guard);
  const record=authenticate(payload,guard),operation=payload.operation;
  if(operation==='status'){
   return Promise.resolve({...describe(record,operation),...(record.lease?status({projectId:record.projectId,binding:binding(record)}):{availability:'unavailable',bindingState:'unavailable'})});
  }
  if(record.revoked&&operation!=='release')refuse('QA_CONTROLLER_PROOF_REFUSED');
  if(record.state==='released')return Promise.resolve(describe(record,operation));
  if(['detach','reconnect','release'].includes(operation)){
   record.generation++;record.observations.clear();
   if(operation==='release')record.revoked=true;
   record.state=operation==='release'?'unknown':'detached';publish(record);
   if(operation==='detach')return Promise.resolve(describe(record,operation));
  }
  const generation=record.generation;
  return serial(record,async()=>{
   current(record,guard,generation,{attached:!['reconnect','release'].includes(operation)});
   record.active++;
   try{
    if(operation==='release'){
     if(record.lease){const observed=leaseStatus({clientId:record.lease.clientId,...binding(record)});if(observed.leaseState==='attached')await qa('release',binding(record),()=>current(record,guard,generation,{attached:false}));else if(observed.leaseState!=='absent')refuse('QA_CONTROLLER_STALE');}
     current(record,guard,generation,{attached:false});
     record.state='released';publish(record);return describe(record,operation);
    }
    if(operation==='reconnect'){
     const observed=record.lease&&status({projectId:record.projectId,binding:binding(record)});
     if(observed?.availability==='quarantined')refuse('QA_TARGET_UNAVAILABLE','The original QA window remains quarantined; no request was replayed.');
     // The private client ID can reuse only its own current lease. Normal
     // window closure is pruned by the existing open path; foreign owners fail.
     record.lease=await qa('open',{projectId:record.projectId,clientId:record.clientId,...(record.reviewId?{reviewId:record.reviewId}:{})},()=>current(record,guard,generation,{attached:false}));
     current(record,guard,generation,{attached:false});record.state='attached';record.touched=now();publish(record);return describe(record,operation);
    }
    const scoped=()=>current(record,guard,generation),base={...binding(record),...(payload.browserId?{browserId:payload.browserId}:{})};
    if(operation==='navigate'||operation==='reload'){
     record.observations.clear();const result=await qa(operation,{...base,...(operation==='navigate'?{url:payload.url}:{})},scoped);scoped();record.touched=now();return {...result,...describe(record,operation)};
    }
    let observation;
    if(inputOperations.has(operation)){
     observation=record.observations.get(payload.observationId);
     if(!observation||observation.generation!==generation||observation.browserId!==(payload.browserId??null))refuse('QA_CONTROLLER_OBSERVATION_REQUIRED','Observe this original controller surface before sending input.');
    }
    const fields={click:['x','y','button','clickCount'],type:['text'],key:['key','modifiers'],scroll:['x','y','deltaX','deltaY'],state:[],capture:[]},request={...base,operation};
    for(const key of fields[operation])if(Object.hasOwn(payload,key))request[key]=payload[key];
    if(observation)request.documentId=observation.documentId;
    const result=await qa('document',request,scoped);scoped();record.touched=now();
    const {contract,documentId,...value}=result;
    if(operation==='state'||operation==='capture'){
     const observationId=crypto.randomUUID();record.observations.set(observationId,{generation,browserId:payload.browserId??null,documentId});
     if(record.observations.size>64)record.observations.delete(record.observations.keys().next().value);
     return {...value,...describe(record,operation),observationId};
    }
    return {...value,...describe(record,operation)};
   }finally{record.active--;}
  });
 }
 return {handle,close(){closed=true;for(const record of records.values()){record.generation++;record.proofHash.fill(0);record.observations.clear();}records.clear();}};
}
module.exports={createQaControllers,CONTRACT};
