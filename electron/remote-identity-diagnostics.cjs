'use strict';

// Public diagnostic metadata only. Never a capability to retry, delete or read
// a protected item. Missing historical evidence stays explicitly unknown.
const crypto=require('node:crypto');
const STAGES=Object.freeze(['unknown','backend-preflight','certificate-generation','write-intent','create-protected-item','verify-protected-item','publish-index','publish-certificate','commit-intent']);
const SOURCES=Object.freeze(['live-operation','retained-intent','legacy-intent']);
const CLEANUP=Object.freeze(['unknown','not-needed','not-attempted','confirmed','unconfirmed']);
const CODES=Object.freeze(['UNKNOWN','IDENTITY_UNAVAILABLE','IDENTITY_NOT_INITIALIZED','IDENTITY_LOST','IDENTITY_PENDING','CERTIFICATE_REISSUE_REQUIRED','INVALID_REMOTE_ADDRESS','STALE_IDENTITY_REQUEST',
 'ACCOUNT_IMMUTABLE','ACCOUNT_REFUSED','ARGUMENTS_REFUSED','ATTRIBUTES_REFUSED','BUFFER_REFUSED','CF_RELEASE_FAILED','CLASS_MISMATCH','CREATE_READBACK_MISMATCH','CREATOR_ACCESS_FAILED','CREATOR_APPLICATION_FAILED','CREATOR_LIST_REFUSED','DEFAULT_KEYCHAIN_FAILED','DEFAULT_LOCKED','DEFAULT_STATUS_FAILED','DETACHED_BUFFER_REFUSED','DIGEST_FAILED','DIGEST_MISMATCH','FINAL_DEFAULT_FAILED','ITEM_CREATE_FAILED','ITEM_DELETE_FAILED','ITEM_KEYCHAIN_FAILED','ITEM_READ_FAILED','NAPI_FAILURE','NATIVE_EXCEPTION','NATIVE_SHAPE_REFUSED','NO_UI_GET_FAILED','NO_UI_NOT_ENFORCED','NO_UI_SET_FAILED','NO_UI_VERIFY_FAILED','OWNER_CONTEXT_REFUSED','OWN_CREATE_CLEANUP_FAILED','PAYLOAD_SIZE_REFUSED','PROVIDER_BUSY','PROVIDER_CLOSED','PROVIDER_FAILED','PROVIDER_NOT_READY','READ_FREE_FAILED','REFERENCE_CREATE_FAILED','REFERENCE_RESOLVE_FAILED','REFERENCE_SIZE_REFUSED','SHARED_BUFFER_REFUSED','TARGET_CHANGED','TARGET_MISMATCH']);
// Public Security.framework constants from SecBase.h/CSCommon.h. Unknown numeric
// statuses remain null, rather than allowing an arbitrary error payload.
const OS_STATUSES=Object.freeze([-50,-128,-25291,-25293,-25294,-25295,-25299,-25300,-25307,-25308,-25315,-34018,-67068,-67062,-67054,-67050,-67034,-67022]);
const KEYS=Object.freeze(['version','source','stage','code','osStatus','mayRemain','cleanup']);
const INTENT_STAGES=Object.freeze(['create-protected-item','verify-protected-item','publish-index','publish-certificate','commit-intent']);
function fail(){throw Object.assign(new Error('The identity diagnostic was refused.'),{code:'IDENTITY_UNAVAILABLE'});}
function fields(value,names){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const keys=Reflect.ownKeys(value);if(keys.length!==names.length||keys.some(k=>!names.includes(k)))fail();
 const result={};for(const key of names){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))fail();result[key]=d.value;}return result;
}
function copyIdentityDiagnostic(value){
 try{
 const result=fields(value,KEYS);
 if(result.version!==1||!SOURCES.includes(result.source)||!STAGES.includes(result.stage)||!CODES.includes(result.code)||
  !(result.osStatus===null||OS_STATUSES.includes(result.osStatus))||![true,false,null].includes(result.mayRemain)||!CLEANUP.includes(result.cleanup))fail();
 if(result.source==='legacy-intent'&&(result.stage!=='unknown'||result.code!=='UNKNOWN'||result.osStatus!==null||result.mayRemain!==null||result.cleanup!=='unknown'))fail();
 if(result.source==='retained-intent'&&!INTENT_STAGES.includes(result.stage))fail();
 if(result.cleanup==='unconfirmed'&&result.mayRemain!==true||result.cleanup==='confirmed'&&result.mayRemain!==false)fail();
 return Object.freeze(result);
 }catch{fail();}
}
const legacyIdentityDiagnostic=()=>copyIdentityDiagnostic({version:1,source:'legacy-intent',stage:'unknown',code:'UNKNOWN',osStatus:null,mayRemain:null,cleanup:'unknown'});
function captureIdentityDiagnostic({stage,error,mayRemain,cleanup}){
 let code='UNKNOWN',osStatus=null,nativeMayRemain=null;
 try{
  const d=error&&Object.getOwnPropertyDescriptors(error);
  if(d&&Object.hasOwn(d.code||{},'value')&&CODES.includes(d.code.value)){
   code=d.code.value;
   if(Object.hasOwn(d.osStatus||{},'value')&&OS_STATUSES.includes(d.osStatus.value))osStatus=d.osStatus.value;
   if(Object.hasOwn(d.mayRemain||{},'value')&&typeof d.mayRemain.value==='boolean')nativeMayRemain=d.mayRemain.value;
  }
 }catch{}
 return copyIdentityDiagnostic({version:1,source:'live-operation',stage,code,osStatus,
  mayRemain:cleanup==='unconfirmed'?true:cleanup==='confirmed'?false:mayRemain===undefined?nativeMayRemain:mayRemain,cleanup});
}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function identityDiagnosticRecord(pendingBytes,diagnostic){
 if(!Buffer.isBuffer(pendingBytes)||!pendingBytes.length||pendingBytes.length>1024)fail();
 const captured=copyIdentityDiagnostic(diagnostic);
 if(captured.source!=='live-operation'||!INTENT_STAGES.includes(captured.stage))fail();
 return Object.freeze({schema:1,pendingSHA256:hash(pendingBytes),diagnostic:captured});
}
function retainedIdentityDiagnostic(record,pendingBytes){
 try{
  const value=fields(record,['schema','pendingSHA256','diagnostic']);
  if(value.schema!==1||typeof value.pendingSHA256!=='string'||!/^[a-f0-9]{64}$/.test(value.pendingSHA256)||!Buffer.isBuffer(pendingBytes)||hash(pendingBytes)!==value.pendingSHA256)return legacyIdentityDiagnostic();
  const diagnostic=identityDiagnosticRecord(pendingBytes,value.diagnostic).diagnostic;
  return copyIdentityDiagnostic({...diagnostic,source:'retained-intent'});
 }catch{return legacyIdentityDiagnostic();}
}
module.exports={STAGES,SOURCES,CLEANUP,CODES,OS_STATUSES,copyIdentityDiagnostic,captureIdentityDiagnostic,legacyIdentityDiagnostic,identityDiagnosticRecord,retainedIdentityDiagnostic};
