'use strict';
const crypto=require('node:crypto');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const capabilities=Object.freeze({provider:'web',sourceKind:'web',preview:true,capture:true,input:false,virtualDisplay:false,permission:'notRequired'});
function cropRectangle(rect,width,height){
  if(!rect)return {x:0,y:0,width,height};
  if(!['x','y','width','height'].every(k=>Number.isSafeInteger(rect[k]))||rect.x<0||rect.y<0||rect.width<1||rect.height<1||rect.x+rect.width>width||rect.y+rect.height>height)fail('INVALID_CROP','선택 영역이 원본 화면을 벗어났습니다.');
  return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
}
function createViewerSessions({now=()=>Date.now(),ttl=30*60*1000}={}){
 const sources=new Map(),contexts=new Map(),intents=new Map(),proofs=new Map(),pendingCaptures=new WeakMap();
 const key=(consumer,id)=>JSON.stringify([consumer,id]);
 const prune=()=>{for(const map of [contexts,intents,proofs])for(const [id,v] of map)if(v.expires<=now())map.delete(id);};
 function source(id,projectId,epoch){
  const s=sources.get(id);if(!s||!s.alive())fail('SESSION_GONE','원본 검사 화면이 종료되었습니다. 프로젝트에서 화면을 다시 선택하십시오.');
  if(s.projectId!==projectId)fail('TARGET_MISMATCH','같은 프로젝트의 검사 화면만 사용할 수 있습니다.');
  if(epoch!==undefined&&s.epoch!==epoch)fail('TARGET_CHANGED','검사 화면이 변경되었습니다. 대상을 다시 선택하십시오.');
  return s;
 }
 function context(consumer,id,generation){
  const c=contexts.get(key(consumer,id));
  if(!c||c.closed||c.expires<=now())fail('STALE_CAPTURE','작성 화면이 닫히거나 취소되었습니다. 다시 캡처하십시오.');
  if(generation!==undefined&&c.generation!==generation)fail('STALE_CAPTURE','캡처 중 작성 내용이 변경되었습니다. 다시 캡처하십시오.');
  return c;
 }
 function intent(consumer,id){
  const i=intents.get(id);if(!i||i.consumer!==consumer||i.expires<=now())fail('STALE_CAPTURE','캡처 요청이 종료되었습니다. 다시 캡처하십시오.');
  const c=context(consumer,i.contextId,i.generation);source(i.sessionId,c.projectId,i.epoch);return {i,c};
 }
 const descriptor=s=>({...s.describe(),sessionId:s.id,epoch:s.epoch,projectId:s.projectId,serviceId:s.serviceId,capabilities});
 return {
  register({projectId,serviceId,owner,targetId,alive,describe,capture,evidence}){
   if(!identifier(projectId)||!identifier(owner)||!identifier(targetId))fail('INVALID_INPUT','검사 화면의 프로젝트 연결이 올바르지 않습니다.');
   const id=crypto.randomUUID();sources.set(id,{id,projectId,serviceId,owner,targetId,epoch:1,alive,describe,capture,evidence});return id;
  },
  changed(id){const s=sources.get(id);if(s)s.epoch++;},
  revoke(id){sources.delete(id);},
  closeOwner(owner){for(const [id,s] of sources)if(s.owner===owner)sources.delete(id);for(const c of contexts.values())if(c.consumer===owner)c.closed=true;},
  list(projectId){prune();return [...sources.values()].filter(s=>s.projectId===projectId&&s.alive()).map(descriptor);},
  setContext({consumer,contextId,projectId,reviewId='',generation,purpose='review',activityId='',requestId=''}){
   prune();if(![consumer,contextId,projectId].every(identifier)||(reviewId&&!identifier(reviewId))||!Number.isSafeInteger(generation)||generation<1)fail('INVALID_INPUT','캡처 작성 정보가 올바르지 않습니다.');
   if(!['review','activity-new','activity-edit','agent-request'].includes(purpose)||(purpose==='activity-edit'&&!identifier(activityId))||(purpose!=='review'&&!reviewId)||(purpose!=='activity-edit'&&activityId!=='')||(requestId&&(purpose!=='agent-request'||!identifier(requestId))))fail('INVALID_INPUT','캡처 저장 대상이 올바르지 않습니다.');
   const k=key(consumer,contextId),old=contexts.get(k);
   if(old&&(old.closed||old.projectId!==projectId||old.reviewId!==reviewId||old.purpose!==purpose||old.activityId!==activityId||old.requestId!==requestId||generation<old.generation))fail('STALE_CAPTURE','작성 대상이 변경되었습니다. 다시 캡처하십시오.');
   contexts.set(k,{consumer,contextId,projectId,reviewId,purpose,activityId,requestId,generation,expires:now()+ttl});return {contextId,generation};
  },
  closeContext(consumer,contextId){const c=contexts.get(key(consumer,contextId));if(c)c.closed=true;},
  begin({consumer,contextId,generation,sessionId,epoch}){
   if(!Number.isSafeInteger(generation)||generation<1)fail('INVALID_INPUT','캡처 작성 세대가 올바르지 않습니다.');
   prune();const c=context(consumer,contextId,generation),s=source(sessionId,c.projectId,epoch);
   if(intents.size>=100)fail('CAPTURE_LIMIT','사용하지 않는 캡처 창을 닫은 뒤 다시 시도하십시오.');
   const id=crypto.randomUUID();intents.set(id,{id,consumer,contextId,generation,sessionId:s.id,epoch:s.epoch,expires:now()+ttl});return {intentId:id,...descriptor(s)};
  },
  binding(consumer,id){const {i,c}=intent(consumer,id);return {projectId:c.projectId,reviewId:c.reviewId,purpose:c.purpose,activityId:c.activityId,requestId:c.requestId,serviceId:source(i.sessionId,c.projectId,i.epoch).serviceId};},
  endPending(consumer,contextId){for(const [id,i] of intents)if(i.consumer===consumer&&i.contextId===contextId){intents.delete(id);for(const [key,p] of proofs)if(p.intentId===id)proofs.delete(key);}},
  end(consumer,id){const i=intents.get(id);if(i?.consumer===consumer){intents.delete(id);for(const [key,p] of proofs)if(p.intentId===id)proofs.delete(key);}},
  async capture(consumer,id,{preview=false}={}){
   const {i,c}=intent(consumer,id),s=source(i.sessionId,c.projectId,i.epoch);
   if(pendingCaptures.has(i))fail('CAPTURE_BUSY','이 화면의 다른 캡처가 진행 중입니다. 잠시 후 다시 시도하십시오.');
   const attempt={};pendingCaptures.set(i,attempt);
   try{
   if(s.describe().loading)fail('FRAME_NOT_READY','페이지를 불러온 뒤 다시 캡처하십시오.');
   const captured=await s.capture();intent(consumer,id);
   if(s.describe().loading)fail('FRAME_NOT_READY','페이지가 변경 중입니다. 다시 캡처하십시오.');
   const bytes=Buffer.from(captured.dataUrl.split(',')[1]||'','base64');
   if(!bytes.length||bytes.length>20*1024*1024)fail('FRAME_NOT_READY','캡처할 화면을 다시 확인하십시오.');
   const provenance={schema:1,kind:'web',provider:'web',sessionId:s.id,epoch:s.epoch,projectId:s.projectId,serviceId:s.serviceId,targetIdentity:s.targetId,capturedAt:captured.capturedAt,width:captured.width,height:captured.height,coordinateSpace:'sourcePixels',originalSha256:crypto.createHash('sha256').update(bytes).digest('hex')};
   if(preview)return {...captured,source:provenance,capabilities};
   prune();if([...proofs.values()].reduce((n,p)=>n+p.bytes.length,bytes.length)>200*1024*1024)fail('CAPTURE_LIMIT','임시 캡처를 저장하거나 취소한 뒤 다시 시도하십시오.');
   const evidence=await s.evidence();intent(consumer,id);
   for(const [key,p] of proofs)if(p.intentId===id)proofs.delete(key);
   const proofId=crypto.randomUUID();proofs.set(proofId,{intentId:id,consumer,contextId:c.contextId,projectId:c.projectId,reviewId:c.reviewId,purpose:c.purpose,activityId:c.activityId,requestId:c.requestId,generation:c.generation,sessionId:s.id,epoch:s.epoch,bytes,source:provenance,expires:now()+ttl});
   return {...captured,captureProof:proofId,source:provenance,evidence:{...evidence,capture_source:provenance},capabilities};
   }finally{if(pendingCaptures.get(i)===attempt)pendingCaptures.delete(i);}
  },
  freeze(consumer,proofId,rect){
   const p=proofs.get(proofId);if(!p||p.consumer!==consumer||p.expires<=now())fail('STALE_CAPTURE','캡처가 취소되거나 만료되었습니다. 다시 캡처하십시오.');
   intent(consumer,p.intentId);const crop=cropRectangle(rect,p.source.width,p.source.height);
   return {bytes:p.bytes,binding:{consumer,contextId:p.contextId,projectId:p.projectId,serviceId:p.source.serviceId,reviewId:p.reviewId,purpose:p.purpose,activityId:p.activityId,requestId:p.requestId},source:{...p.source,crop,sourcePixelSize:{width:p.source.width,height:p.source.height}}};
  },
  consume(proofId){const p=proofs.get(proofId);proofs.delete(proofId);if(p)intents.delete(p.intentId);},
  assertFrozen(binding,{consumer,contextId,projectId,reviewId,purpose='review',activityId='',creatingReview=false,requestId='',agentEditing=false}){
   // Accepted evidence is independent of the original viewer's later lifetime.
   if(binding.consumer!==consumer||binding.contextId!==contextId||binding.projectId!==projectId||(binding.reviewId&&binding.reviewId!==reviewId))fail('TARGET_MISMATCH','이 작성 화면의 스크린샷만 첨부할 수 있습니다.');
   if(binding.purpose!==purpose||(purpose==='activity-edit'&&binding.activityId!==activityId)||(!binding.reviewId&&!creatingReview))fail('TARGET_MISMATCH','스크린샷의 저장 대상과 작성 화면이 일치하지 않습니다.');
   if(purpose==='agent-request'&&(Boolean(binding.requestId)!==agentEditing||(binding.requestId&&binding.requestId!==requestId)))fail('TARGET_MISMATCH','에이전트 요청의 작성 대상이 변경되었습니다.');
   const c=context(consumer,binding.contextId);if(c.projectId!==projectId||c.reviewId!==binding.reviewId)fail('TARGET_MISMATCH','스크린샷의 작성 대상이 변경되었습니다.');
  }
 };
}
module.exports={createViewerSessions,cropRectangle};
