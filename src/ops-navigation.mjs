export function opsNavigationPlan({target,data,tabs,dirtyIds,qaScoped=false}){
 if(qaScoped)throw new Error('QA 창에서는 관리 대화가 화면을 바꿀 수 없습니다.');
 if(!target||!['home','groups','group','project','ops'].includes(target.view))throw new Error('요청한 화면을 열 수 없습니다.');
 const review=target.reviewId&&data.reviews.find(row=>row.id===target.reviewId),document=target.documentId&&data.attachments.find(row=>row.id===target.documentId);
 if(target.reviewId&&!review||target.documentId&&!document)throw new Error('표시할 리뷰 또는 문서를 찾을 수 없습니다.');
 const projectId=target.projectId||review?.projectId||'',groupId=target.groupId||'';
 if(projectId&&!data.projects.some(row=>row.id===projectId)||review&&review.projectId!==projectId||groupId&&!data.groups.some(row=>row.id===groupId)||document&&(review&&document.reviewId!==review.id||projectId&&!data.reviews.some(row=>row.id===document.reviewId&&row.projectId===projectId)))throw new Error('표시할 항목의 프로젝트와 리뷰가 일치하지 않습니다.');
 let kind=target.view,entityId=kind==='project'?projectId:kind==='group'?groupId:'';
 if(kind==='project'&&!entityId||kind==='group'&&!entityId)throw new Error('표시할 대상을 선택하십시오.');
 // Keep dirty home and resource panes mounted. A review goes to another project
 // pane rather than replacing the user's home review editor.
 if(kind==='home'&&review){kind='project';entityId=review.projectId;}
 const existing=tabs.find(row=>row.kind===kind&&(row.entityId||'')===entityId&&!dirtyIds.has(row.id));
 return {kind,entityId,existingId:existing?.id||'',extra:{section:target.section||(kind==='project'?'review':kind==='group'?'projects':''),...(review?{reviewId:review.id,reviewMode:'detail'}:{})},document,goalId:target.goalId||''};
}
