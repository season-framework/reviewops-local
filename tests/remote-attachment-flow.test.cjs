'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const load=()=>import('../src/remote/attachments.mjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const scope={projectId:'project-one',reviewId:'review-one'};
const revision={epoch:'f5f99abc-8261-41bb-ae31-8bce3f8996bf',revision:3};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
function fileDTO(bytes,extra={}){return {id:'attachment-one',reviewId:scope.reviewId,activityId:null,name:'owned.txt',
 mimeType:'text/plain',size:bytes.length,sha256:hash(bytes),createdAt:'2026-11-06T00:00:00.000Z',...extra};}
function server(bytes,hooks={}){
 const calls=[],chunks=[];let intent;
 return {calls,chunks,async call(operation,payload){
  calls.push({operation,payload});if(hooks.call){const result=await hooks.call(operation,payload);if(result!==undefined)return result;}
  if(operation==='beginUpload'){intent=payload;return {version:1,state:'uploading',uploadId:'upload-one',received:0,size:bytes.length,expiresAt:Date.now()+60000};}
  if(operation==='writeChunk'){assert.equal(payload.offset,chunks.reduce((size,row)=>size+row.length,0));chunks.push(Buffer.from(payload.data,'base64'));
   return {version:1,uploadId:'upload-one',received:chunks.reduce((size,row)=>size+row.length,0),size:bytes.length};}
  if(operation==='commitUpload'){assert.equal(hash(Buffer.concat(chunks)),hash(bytes));return {version:1,state:'committed',uploadId:'upload-one',requestId:intent.requestId,
   ...scope,attachment:fileDTO(bytes,{activityId:intent.activityId,name:intent.name,mimeType:intent.mimeType}),revision:4};}
  if(operation==='describe')return fileDTO(bytes);
  if(operation==='readChunk'){const chunk=bytes.subarray(payload.offset,Math.min(payload.offset+65536,bytes.length));return {version:1,attachment:fileDTO(bytes),
   offset:payload.offset,nextOffset:payload.offset+chunk.length,data:chunk.toString('base64'),complete:payload.offset+chunk.length===bytes.length};}
  throw new Error('Unexpected operation');
 }};
}

for(const length of [0,65536*2+17])test(`renderer uploads ${length} bytes in bounded chunks and commits exactly once`,async()=>{
 const {uploadRemoteAttachment}=await load(),bytes=Buffer.alloc(length,0xa7),engine=server(bytes),progress=[],intents=[];
 const result=await uploadRemoteAttachment({file:new File([bytes],'owned.txt',{type:'text/plain'}),scope,activityId:null,revision,requestId:'one-original-request',
  call:engine.call,onIntent:value=>intents.push(value),onProgress:value=>progress.push(value)});
 assert.equal(intents.length,1);assert.equal(intents[0].sha256,hash(bytes));assert.ok(Object.isFrozen(intents[0]));
 assert.equal(result.attachment.sha256,hash(bytes));assert.equal(result.requestId,'one-original-request');
 assert.equal(engine.calls.filter(row=>row.operation==='commitUpload').length,1);
 assert.ok(engine.chunks.every(row=>row.length<=65536));assert.equal(progress.at(-1).phase,'committing');
});

test('renderer refuses an oversized file before reading its body or calling IPC',async()=>{
 const {uploadRemoteAttachment}=await load();let reads=0,calls=0;
 await assert.rejects(uploadRemoteAttachment({file:{name:'huge.bin',size:10*1024*1024+1,type:'application/octet-stream',arrayBuffer(){reads++;throw new Error();}},
  scope,activityId:null,revision,requestId:'oversized',call(){calls++;}}),{code:'INVALID_ATTACHMENT_REQUEST'});
 assert.equal(reads,0);assert.equal(calls,0);
});

test('renderer keeps a failed commit uncertain and never retries commit or starts another upload',async()=>{
 const {uploadRemoteAttachment}=await load(),bytes=Buffer.from('Original upload'),failure=Object.assign(new Error('Reply lost'),{code:'CONNECTION_TIMEOUT'});
 const engine=server(bytes,{call(operation){if(operation==='commitUpload')throw failure;}});
 await assert.rejects(uploadRemoteAttachment({file:new File([bytes],'owned.txt',{type:'text/plain'}),scope,activityId:null,revision,
  requestId:'uncertain-original',call:engine.call}),error=>error===failure);
 assert.deepEqual(engine.calls.map(row=>row.operation),['beginUpload','writeChunk','commitUpload']);
});

test('renderer refuses malformed chunk acknowledgement before it can commit',async()=>{
 const {uploadRemoteAttachment}=await load(),bytes=Buffer.from('Original upload');
 const engine=server(bytes,{call(operation){if(operation==='writeChunk')return {version:1,uploadId:'other-upload',received:bytes.length,size:bytes.length};}});
 await assert.rejects(uploadRemoteAttachment({file:new File([bytes],'owned.txt',{type:'text/plain'}),scope,activityId:null,revision,
  requestId:'wrong-acknowledgement',call:engine.call}),{code:'INVALID_ATTACHMENT_RESPONSE'});
 assert.equal(engine.calls.some(row=>row.operation==='commitUpload'),false);
});

test('renderer refuses a committed reply for a different original upload identity',async()=>{
 const {uploadRemoteAttachment}=await load(),bytes=Buffer.from('Original upload');let intent;
 const engine=server(bytes,{call(operation,payload){if(operation==='beginUpload')intent=payload;
  if(operation==='commitUpload')return {version:1,state:'committed',uploadId:'replacement-upload',requestId:intent.requestId,
   ...scope,attachment:fileDTO(bytes),revision:4};}});
 await assert.rejects(uploadRemoteAttachment({file:new File([bytes],'owned.txt',{type:'text/plain'}),scope,activityId:null,revision,
  requestId:'wrong-commit-identity',call:engine.call}),{code:'INVALID_ATTACHMENT_RESPONSE'});
});

test('renderer projects the genuine nine-field timeline attachment into its exact download descriptor',async()=>{
 const {captureTimelineAttachment}=await load(),bytes=Buffer.from('Timeline metadata'),row=fileDTO(bytes);
 assert.deepEqual(captureTimelineAttachment({...row,updatedAt:'2026-11-06T00:01:00.000Z'}),row);
 assert.throws(()=>captureTimelineAttachment({...row,updatedAt:'invalid'}),{code:'INVALID_ATTACHMENT_RESPONSE'});
});

test('renderer original-view invalidation after an awaited chunk withholds commit',async()=>{
 const {uploadRemoteAttachment}=await load(),bytes=Buffer.from('Original upload'),entered=deferred(),release=deferred();let current=true;
 const engine=server(bytes,{async call(operation){if(operation==='writeChunk'){entered.resolve();await release.promise;}}});
 const pending=uploadRemoteAttachment({file:new File([bytes],'owned.txt',{type:'text/plain'}),scope,activityId:null,revision,requestId:'held-chunk',call:engine.call,
  assertCurrent(){if(!current)throw Object.assign(new Error(),{code:'STALE_ATTACHMENT_VIEW'});}});
 const refused=assert.rejects(pending,{code:'STALE_ATTACHMENT_VIEW'});
 try{await entered.promise;current=false;release.resolve();await refused;assert.equal(engine.calls.some(row=>row.operation==='commitUpload'),false);}
 finally{release.resolve();await Promise.allSettled([pending]);}
});

for(const length of [0,65536*2+17])test(`renderer downloads ${length} bytes only after exact metadata and full SHA-256 verification`,async()=>{
 const {downloadRemoteAttachment}=await load(),bytes=Buffer.alloc(length,0xd3),engine=server(bytes);
 const result=await downloadRemoteAttachment({scope,expected:fileDTO(bytes),call:engine.call});
 assert.equal(result.bytes.length,length);assert.equal(hash(result.bytes),hash(bytes));assert.equal(result.attachment.id,'attachment-one');
 assert.equal(engine.calls.filter(row=>row.operation==='readChunk').length,Math.max(1,Math.ceil(length/65536)));
});

test('renderer refuses a changed target descriptor before reading any chunks',async()=>{
 const {downloadRemoteAttachment}=await load(),bytes=Buffer.from('Original download');
 const engine=server(bytes,{call(operation){if(operation==='describe')return fileDTO(bytes,{reviewId:'foreign-review'});}});
 await assert.rejects(downloadRemoteAttachment({scope,expected:fileDTO(bytes),call:engine.call}),{code:'ATTACHMENT_CHANGED'});
 assert.deepEqual(engine.calls.map(row=>row.operation),['describe']);
});

test('renderer never releases downloaded bytes when the complete SHA differs',async()=>{
 const {downloadRemoteAttachment}=await load(),bytes=Buffer.from('Original download');
 const engine=server(bytes,{call(operation){if(operation==='readChunk')return {version:1,attachment:fileDTO(bytes),offset:0,nextOffset:bytes.length,
  data:Buffer.alloc(bytes.length,1).toString('base64'),complete:true};}});
 await assert.rejects(downloadRemoteAttachment({scope,expected:fileDTO(bytes),call:engine.call}),{code:'HASH_MISMATCH'});
});

test('renderer rejects malformed offsets and noncanonical chunk data',async()=>{
 const {downloadRemoteAttachment}=await load(),bytes=Buffer.from('Original download');
 for(const extra of [{nextOffset:1},{data:'!!!!'},{attachment:fileDTO(bytes,{id:'replacement'})}]){
  const engine=server(bytes,{call(operation){if(operation==='readChunk')return {version:1,attachment:fileDTO(bytes),offset:0,nextOffset:bytes.length,
   data:bytes.toString('base64'),complete:true,...extra};}});
  await assert.rejects(downloadRemoteAttachment({scope,expected:fileDTO(bytes),call:engine.call}),{code:'INVALID_ATTACHMENT_RESPONSE'});
 }
});
