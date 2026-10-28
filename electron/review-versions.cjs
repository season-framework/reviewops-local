'use strict';
const crypto = require('node:crypto');

const MAX_VERSIONS = 100;
const MAX_FILES = 20;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const text = (value, label, limit = 300) => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`${label} 입력이 올바르지 않습니다.`);
  return value.trim();
};
function targetValue(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('대상 버전을 입력하십시오.');
  const target = {code:text(input.code, '코드 버전'), artifact:text(input.artifact, '산출물 버전'), database:text(input.database, '데이터베이스 버전')};
  if (!Object.values(target).some(Boolean)) throw new Error('코드, 산출물, 데이터베이스 중 하나의 버전을 입력하십시오.');
  return target;
}
const sameTarget = (a, b) => ['code','artifact','database'].every(key => (a?.[key] || '') === (b?.[key] || ''));
function versionsOf(review) {
  const value = review.evidence?.review_versions;
  if (!value) return {currentTarget:null, entries:[]};
  if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_VERSIONS) throw new Error('저장된 검토 버전 정보를 읽을 수 없습니다.');
  const currentTarget = value.currentTarget ? targetValue(value.currentTarget) : null;
  for (const entry of value.entries) {
    if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.attachments) || entry.attachments.length > MAX_FILES || entry.attachments.some(file => !file || typeof file.id !== 'string' || typeof file.sha256 !== 'string')) throw new Error('저장된 검토자료 목록을 읽을 수 없습니다.');
    targetValue(entry.target);
  }
  return {...value,currentTarget};
}
function saveState(store, review, state) {
  return store.saveReview({id:review.id, evidence:{review_versions:{...state,version:1}}});
}
function changeReviewTarget(store, input) {
  const review = store.get('reviews', input.reviewId), previous = versionsOf(review);
  return saveState(store, review, {...previous,currentTarget:targetValue(input.target)});
}
async function saveReviewVersion(store, input, readAttachment) {
  const review = store.get('reviews', input.reviewId), previous = versionsOf(review), target = targetValue(input.target);
  if (previous.entries.length >= MAX_VERSIONS) throw new Error('검토 버전은 리뷰마다 100개까지 저장할 수 있습니다.');
  const ids = input.attachmentIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FILES || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('저장할 첨부 자료를 1개에서 20개까지 선택하십시오.');
  const source = text(input.source, '자료 출처', 1000), attachments = [];
  for (const id of ids) {
    const file = store.get('attachments', id);
    if (file.reviewId !== review.id) throw new Error('이 리뷰에 속한 첨부 자료만 선택할 수 있습니다.');
    const bytes = await readAttachment(file);
    if (digest(bytes) !== file.sha256) throw new Error('첨부 사본이 변경되었거나 손상되었습니다.');
    attachments.push({id:file.id,name:file.name,mimeType:file.mimeType,size:file.size,sha256:file.sha256,createdAt:file.createdAt});
  }
  const entry = {id:crypto.randomUUID(),createdAt:new Date().toISOString(),target,source,attachments};
  saveState(store,review,{...previous,currentTarget:target,entries:[...previous.entries,entry]});
  return entry;
}
async function listReviewVersions(store, reviewId, readAttachment) {
  const review = store.get('reviews', reviewId), state = versionsOf(review), files = new Map(store.snapshot().attachments.filter(file => file.reviewId === reviewId).map(file => [file.id,file]));
  const inspected = new Map();
  const inspect = async snapshot => {
    if (!inspected.has(snapshot.id)) inspected.set(snapshot.id,(async()=>{
      const file = files.get(snapshot.id);
      if (!file) return {status:'missing'};
      try {return {status:'available',sha256:digest(await readAttachment(file))};}
      catch (error) {return {status:error.code==='ENOENT'?'missing':error.code==='ATTACHMENT_INTEGRITY_FAILED'?'changed':'unreadable',message:'보관된 사본을 읽을 수 없습니다. 파일 손상 또는 접근 권한을 검사하십시오.'};}
    })());
    const result = await inspected.get(snapshot.id);
    return {...snapshot,...result,status:result.status==='available'&&result.sha256!==snapshot.sha256?'changed':result.status,sha256:snapshot.sha256};
  };
  const entries = [];
  for (const entry of state.entries) entries.push({...entry,needsReview:!sameTarget(entry.target,state.currentTarget),attachments:await Promise.all(entry.attachments.map(inspect))});
  return {currentTarget:state.currentTarget,entries};
}
// Version labels are local review notes. Explicit data backups retain them;
// generated agent instructions and selectable browser logs do not include them.
function withoutReviewVersions(value) {
  if (Array.isArray(value)) return value.map(withoutReviewVersions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='review_versions').map(([key,item])=>[key,withoutReviewVersions(item)]));
}
module.exports = {changeReviewTarget,saveReviewVersion,listReviewVersions,withoutReviewVersions};
