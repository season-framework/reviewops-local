// Renderer-only transfer flow. The main process owns authentication and paths.
export const REMOTE_FILE_BYTES=10*1024*1024;
export const REMOTE_CHUNK_BYTES=64*1024;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const SHA=/^[a-f0-9]{64}$/;
const MIME=/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
function fail(code){throw Object.assign(new Error('The attachment transfer could not be verified.'),{code});}
function record(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length)fail('INVALID_ATTACHMENT_RESPONSE');
 const result={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('INVALID_ATTACHMENT_RESPONSE');result[key]=descriptor.value;}
 return result;
}
function target(value){const result=record(value,['projectId','reviewId']);
 if(typeof result.projectId!=='string'||typeof result.reviewId!=='string'||!ID.test(result.projectId)||!ID.test(result.reviewId))fail('INVALID_ATTACHMENT_REQUEST');return Object.freeze(result);}
function name(value){return typeof value==='string'&&value.trim()&&value.length<=255&&!/[/\\\x00-\x1f\x7f]/.test(value)&&!['.','..'].includes(value);}
function attachment(value){const row=record(value,['id','reviewId','activityId','name','mimeType','size','sha256','createdAt']);
 if(typeof row.id!=='string'||!ID.test(row.id)||typeof row.reviewId!=='string'||!ID.test(row.reviewId)||
  row.activityId!==null&&(typeof row.activityId!=='string'||!ID.test(row.activityId))||!name(row.name)||
  typeof row.mimeType!=='string'||!MIME.test(row.mimeType)||!Number.isSafeInteger(row.size)||row.size<0||row.size>REMOTE_FILE_BYTES||
  typeof row.sha256!=='string'||!SHA.test(row.sha256)||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))fail('INVALID_ATTACHMENT_RESPONSE');
 return Object.freeze(row);
}
const sameAttachment=(a,b)=>Object.keys(a).every(key=>a[key]===b[key]);
export function captureTimelineAttachment(value){
 const row=record(value,['id','reviewId','activityId','name','mimeType','size','sha256','createdAt','updatedAt']);
 if(typeof row.updatedAt!=='string'||!Number.isFinite(Date.parse(row.updatedAt)))fail('INVALID_ATTACHMENT_RESPONSE');
 const {updatedAt,...descriptor}=row;return attachment(descriptor);
}
const hex=bytes=>Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
export const attachmentSHA256=async bytes=>hex(await crypto.subtle.digest('SHA-256',bytes));
function encode(bytes){let binary='';for(const value of bytes)binary+=String.fromCharCode(value);return btoa(binary);}
function decode(value){
 if(typeof value!=='string'||value.length>Math.ceil(REMOTE_CHUNK_BYTES/3)*4||
  !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('INVALID_ATTACHMENT_RESPONSE');
 const bytes=Uint8Array.from(atob(value),value=>value.charCodeAt(0));
 if(bytes.length>REMOTE_CHUNK_BYTES||encode(bytes)!==value)fail('INVALID_ATTACHMENT_RESPONSE');return bytes;
}
function committed(value,intent,uploadId=null){
 const row=record(value,['version','state','uploadId','requestId','projectId','reviewId','attachment','revision']);
 const file=attachment(row.attachment);
 if(row.version!==1||row.state!=='committed'||typeof row.uploadId!=='string'||!ID.test(row.uploadId)||uploadId!==null&&row.uploadId!==uploadId||
  row.requestId!==intent.requestId||row.projectId!==intent.projectId||row.reviewId!==intent.reviewId||file.reviewId!==intent.reviewId||
  file.activityId!==intent.activityId||file.name!==intent.name||file.mimeType!==intent.mimeType||file.size!==intent.size||file.sha256!==intent.sha256||
  !Number.isSafeInteger(row.revision)||row.revision<1)fail('INVALID_ATTACHMENT_RESPONSE');return Object.freeze({...row,attachment:file});
}

export async function uploadRemoteAttachment({file,scope,activityId,revision,requestId,call,assertCurrent=()=>{},onIntent=()=>{},onProgress=()=>{}}){
 const destination=target(scope);
 if(!file||typeof file.arrayBuffer!=='function'||!name(file.name)||!Number.isSafeInteger(file.size)||file.size<0||file.size>REMOTE_FILE_BYTES||
  typeof requestId!=='string'||!ID.test(requestId)||activityId!==null&&(typeof activityId!=='string'||!ID.test(activityId))||
  typeof revision?.epoch!=='string'||!ID.test(revision.epoch)||!Number.isSafeInteger(revision?.revision)||revision.revision<1)fail('INVALID_ATTACHMENT_REQUEST');
 assertCurrent();const bytes=new Uint8Array(await file.arrayBuffer());assertCurrent();
 if(bytes.length!==file.size)fail('ATTACHMENT_CHANGED');
 const sha256=await attachmentSHA256(bytes);assertCurrent();
 const intent=Object.freeze({requestId,...destination,activityId,epoch:revision.epoch,expectedRevision:revision.revision,
  name:file.name,mimeType:typeof file.type==='string'&&MIME.test(file.type)?file.type:'application/octet-stream',size:bytes.length,sha256});
 onIntent(intent);const started=await call('beginUpload',intent);assertCurrent();
 if(started?.state==='committed')return committed(started,intent);
 const begin=record(started,['version','state','uploadId','received','size','expiresAt']);
 if(begin.version!==1||begin.state!=='uploading'||typeof begin.uploadId!=='string'||!ID.test(begin.uploadId)||begin.size!==bytes.length||
  begin.received!==0||!Number.isSafeInteger(begin.expiresAt))fail('INVALID_ATTACHMENT_RESPONSE');
 onProgress({phase:'staging',uploadId:begin.uploadId,received:0,size:bytes.length});
 for(let offset=0;offset<bytes.length;offset+=REMOTE_CHUNK_BYTES){
  assertCurrent();const chunk=bytes.subarray(offset,Math.min(offset+REMOTE_CHUNK_BYTES,bytes.length));
  const value=record(await call('writeChunk',{uploadId:begin.uploadId,offset,data:encode(chunk)}),['version','uploadId','received','size']);assertCurrent();
  if(value.version!==1||value.uploadId!==begin.uploadId||value.received!==offset+chunk.length||value.size!==bytes.length)fail('INVALID_ATTACHMENT_RESPONSE');
  onProgress({phase:'staging',uploadId:begin.uploadId,received:value.received,size:bytes.length});
 }
 assertCurrent();onProgress({phase:'committing',uploadId:begin.uploadId,received:bytes.length,size:bytes.length});
 // A failed commit reply is uncertain. Only result(requestId) can settle it;
 // this flow never replays commit or starts a replacement upload.
 const result=await call('commitUpload',{uploadId:begin.uploadId});assertCurrent();return committed(result,intent,begin.uploadId);
}

export async function downloadRemoteAttachment({scope,expected,call,assertCurrent=()=>{},onProgress=()=>{}}){
 const destination=target(scope),selected=attachment(expected);
 if(selected.reviewId!==destination.reviewId)fail('INVALID_ATTACHMENT_REQUEST');
 const payload={...destination,attachmentId:selected.id};assertCurrent();
 const observed=attachment(await call('describe',payload));assertCurrent();
 if(!sameAttachment(selected,observed))fail('ATTACHMENT_CHANGED');
 const bytes=new Uint8Array(observed.size);let offset=0;
 // Include a zero-byte read so its final target is reauthorized as well.
 do{
  const value=record(await call('readChunk',{...payload,offset}),['version','attachment','offset','nextOffset','data','complete']);assertCurrent();
  const chunk=decode(value.data);
  if(value.version!==1||!sameAttachment(observed,attachment(value.attachment))||value.offset!==offset||
   value.nextOffset!==offset+chunk.length||value.nextOffset>bytes.length||value.complete!==(value.nextOffset===bytes.length)||
   chunk.length!==Math.min(REMOTE_CHUNK_BYTES,bytes.length-offset))fail('INVALID_ATTACHMENT_RESPONSE');
  bytes.set(chunk,offset);offset=value.nextOffset;onProgress({phase:'downloading',received:offset,size:bytes.length});
 }while(offset<bytes.length);
 const sha256=await attachmentSHA256(bytes);assertCurrent();if(sha256!==observed.sha256)fail('HASH_MISMATCH');
 return Object.freeze({attachment:observed,bytes});
}
