export function targetContext(value,screen,data){
 if(!value||value==='screen')return screen||{view:'ops',section:'conversation'};
 const [kind,id]=value.split(':');
 if(kind==='document'){const row=(data.attachments||[]).find(item=>item.id===id),review=data.reviews.find(item=>item.id===row?.reviewId);if(review&&data.projects.some(item=>item.id===review.projectId))return {view:'project',section:'file',projectId:review.projectId,reviewId:review.id,documentId:row.id};}
 if(kind==='review'){const row=data.reviews.find(item=>item.id===id);if(row&&data.projects.some(item=>item.id===row.projectId))return {view:'project',section:'review',projectId:row.projectId,reviewId:row.id};}
 if(kind==='project'&&data.projects.some(item=>item.id===id))return {view:'project',section:'review',projectId:id};
 if(kind==='group'&&data.groups.some(item=>item.id===id))return {view:'group',section:'projects',groupId:id};
 throw new Error('선택한 작업 대상이 없어졌습니다. 입력은 유지했습니다. 대상을 다시 선택하십시오.');
}
