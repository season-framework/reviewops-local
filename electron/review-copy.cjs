'use strict';

function copySource(store, input) {
  const source = store.get('reviews', input.reviewId);
  if (store.listAgentRuns(source.id).length) throw new Error('실행 이력이 있는 리뷰는 다른 프로젝트로 복사할 수 없습니다.');
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_requests'").get() && store.db.prepare('SELECT 1 FROM agent_requests WHERE reviewId=? AND cancelled=0 AND runId=\'\' LIMIT 1').get(source.id)) throw new Error('대기 중인 요청을 취소한 뒤 리뷰를 복사하십시오.');
  const destination = store.project(input.projectId);
  if (source.projectId === destination.id) throw new Error('다른 프로젝트를 선택하십시오.');
  const ids = input.attachmentIds ?? [];
  if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('복사할 첨부 파일 목록이 올바르지 않습니다.');
  const attachments = ids.map(id => store.get('attachments', id));
  if (attachments.some(file => file.reviewId !== source.id)) throw new Error('원본 리뷰에 속한 첨부 파일만 복사할 수 있습니다.');
  return {source, destination, attachments};
}

function copyReviewRecord(store, input) {
  return store.transaction(() => {
    const {source, destination, attachments} = copySource(store, input);
    const originalProject = store.project(source.projectId);
    const origin = {reviewId:source.id, projectId:source.projectId, projectName:originalProject.name,
      targetPath:source.targetPath, targetUrl:source.targetUrl,
      attachments:attachments.map(file => ({id:file.id, name:file.name, sha256:file.sha256}))};
    const copy = store.saveReview({projectId:destination.id, serviceId:destination.connection?.id || null,
      title:source.title, body:source.body, priority:source.priority, category:source.category,
      status:'open', targetPath:'', targetUrl:'', evidence:{copiedFrom:origin}});
    store.insertActivity(source.id, `리뷰를 ${destination.name} 프로젝트의 #${copy.number} 리뷰로 복사했습니다. 원본은 유지됩니다.`, 'comment', '', '', {role:'system'});
    store.insertActivity(copy.id, `${originalProject.name} 프로젝트의 #${source.number} 리뷰에서 복사했습니다. 첨부 사본 ${attachments.length}개를 포함했습니다. 파일 경로와 뷰어 주소는 새 프로젝트에서 선택하십시오. 에이전트는 실행하지 않았습니다.`, 'comment', '', '', {role:'system'});
    return copy;
  });
}

module.exports = {copySource, copyReviewRecord};
