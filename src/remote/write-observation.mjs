// An edit belongs to the exact host dataset and review incarnation that was
// observed before the user typed. Refreshing a view never rebases that intent.
export function sameWriteObservation(left,right){
 return Boolean(left&&right&&['epoch','projectId','reviewId','projectBirth','reviewGeneration','revision'].every(key=>left[key]===right[key]));
}
export function captureWriteObservation(value,{projectId,reviewId}){
 const keys=['version','epoch','projectId','reviewId','projectBirth','reviewGeneration','revision','status'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value'))||value.version!==1||value.projectId!==projectId||value.reviewId!==reviewId||
  typeof value.epoch!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.epoch)||
  !Number.isSafeInteger(value.projectBirth)||value.projectBirth<1||!Number.isSafeInteger(value.reviewGeneration)||
  !Number.isSafeInteger(value.revision)||value.reviewGeneration<(reviewId?1:0)||value.revision<(reviewId?1:0)||
  !reviewId&&(value.reviewGeneration!==0||value.revision!==0||value.status!=='')||reviewId&&!['open','in_progress','in_review','resolved','recheck','closed'].includes(value.status))throw Object.assign(new Error('Invalid remote revision.'),{code:'INVALID_RESPONSE'});
 return Object.freeze({...value});
}
export async function readObservedReview({writeState,read,projectId,reviewId,assertCurrent}){
 const target={projectId,reviewId};assertCurrent();
 const before=captureWriteObservation(await writeState(target),target);assertCurrent();
 const value=await read('reviews.get',target);assertCurrent();
 const timeline=await read('reviews.timeline',target);assertCurrent();
 const after=captureWriteObservation(await writeState(target),target);assertCurrent();
 if(!sameWriteObservation(before,after))throw Object.assign(new Error('Remote review changed while reading.'),{code:'REVISION_CONFLICT'});
 return {review:value.review,timeline,binding:after};
}
export function observedCommand({operation,requestId,projectId,reviewId,payload,binding}){
 const target={projectId,reviewId:operation==='review.create'?'':reviewId};
 const observed=captureWriteObservation(binding,target);
 return {operation,requestId,...target,epoch:observed.epoch,expectedProjectBirth:observed.projectBirth,
  expectedReviewGeneration:observed.reviewGeneration,expectedRevision:observed.revision,payload};
}
