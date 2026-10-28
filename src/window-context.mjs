export const HOME_TAB = Object.freeze({id:'home',kind:'home'});
const validId = value => typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function readWindowContext(search='') {
 const params=new URLSearchParams(search);
 return {projectId:validId(params.get('projectId'))?params.get('projectId'):'',windowId:validId(params.get('windowId'))?params.get('windowId'):''};
}

export function windowStorageKeys(projectId='') {
 const suffix=projectId?`.project.${projectId}`:'';
 return {tabs:`reviewops.workspace.tabs${suffix}`,home:`reviewops.home${suffix}`,homeSelected:`reviewops.home${suffix}.selected`};
}

export function restoreWindowTabs(serialized,projectId='') {
 let saved=[];
 try{const value=JSON.parse(serialized||'[]');if(Array.isArray(value))saved=value}catch{}
 const seen=new Set(['home']);
 const tabs=[HOME_TAB,...saved.filter(tab=>{
  if(!tab||!['groups','group','project','service','settings','accounts','hosts'].includes(tab.kind)||typeof tab.id!=='string'||!tab.id||seen.has(tab.id))return false;
  if(projectId&&(tab.kind==='service'||tab.kind==='project'&&tab.entityId!==projectId))return false;
  seen.add(tab.id);return true;
 }).slice(0,30)];
 let project=tabs.find(tab=>tab.kind==='project'&&tab.entityId===projectId);
 if(projectId&&!project){project={id:`window-project-${projectId}`,kind:'project',entityId:projectId,section:'review'};tabs.push(project)}
 return {tabs,active:projectId?project.id:'home'};
}

export function externalProjectRequest(ownerProjectId,projectId,extra={}) {
 if(!ownerProjectId||ownerProjectId===projectId)return null;
 return {projectId,...Object.fromEntries(['reviewId','section','reviewMode'].filter(key=>extra[key]).map(key=>[key,extra[key]]))};
}

export function projectNavigationUpdate(ownerProjectId,value) {
 if(!ownerProjectId||value?.projectId!==ownerProjectId||!Number.isSafeInteger(value.request)||value.request<=0)return null;
 if(!['review','dashboard','file','terminal','settings'].includes(value.section)||!['detail','create','edit'].includes(value.reviewMode))return null;
 if(value.reviewMode==='edit'&&!validId(value.reviewId)||value.reviewId&&!validId(value.reviewId))return null;
 return {section:value.section,sectionRequest:value.request,reviewId:value.reviewId||'',reviewMode:value.reviewMode,selectionRequest:value.request,integrationRequest:0};
}

export function dirtyTabSet(onChange) {
 const values=new Set();
 values.add=function(value){Set.prototype.add.call(this,value);onChange(this.size>0);return this};
 values.delete=function(value){const deleted=Set.prototype.delete.call(this,value);onChange(this.size>0);return deleted};
 values.clear=function(){Set.prototype.clear.call(this);onChange(false)};
 onChange(false);
 return values;
}

// A deletion in another window must not unmount a form that still has input.
// Keep only missing records needed by dirty tabs; existing records stay fresh.
export function preserveDeletedDrafts(previous,next,tabs,dirty,homeReviewId='') {
 const projectIds=new Set(),groupIds=new Set(),reviewIds=new Set();
 for(const tab of tabs){
  if(!dirty.has(tab.id))continue;
  if(tab.kind==='project')projectIds.add(tab.entityId);
  if(tab.kind==='group')groupIds.add(tab.entityId);
  if(tab.kind==='home'&&homeReviewId)reviewIds.add(homeReviewId);
  if(tab.kind==='editor'){
   if(tab.record?.projectId)projectIds.add(tab.record.projectId);
   if(tab.record?.groupId)groupIds.add(tab.record.groupId);
  }
 }
 for(const review of previous.reviews||[])if(projectIds.has(review.projectId)||reviewIds.has(review.id)){reviewIds.add(review.id);projectIds.add(review.projectId)}
 const serviceIds=new Set();
 for(const project of previous.projects||[])if(projectIds.has(project.id)){groupIds.add(project.groupId);for(const id of project.serviceIds||[])serviceIds.add(id)}
 for(const review of previous.reviews||[])if(reviewIds.has(review.id)&&review.serviceId)serviceIds.add(review.serviceId);
 const data={...next};let preserved=false;
 for(const [key,ids] of [['groups',groupIds],['projects',projectIds],['services',serviceIds],['reviews',reviewIds]]){
  const rows=next[key]||[],existing=new Set(rows.map(row=>row.id));
  const missing=(previous[key]||[]).filter(row=>ids.has(row.id)&&!existing.has(row.id));
  if(missing.length){data[key]=[...rows,...missing];preserved=true}
 }
 if(preserved)for(const key of ['activities','attachments']){
  const rows=next[key]||[],existing=new Set(rows.map(row=>row.id));
  data[key]=[...rows,...(previous[key]||[]).filter(row=>reviewIds.has(row.reviewId)&&!existing.has(row.id))];
 }
 return {data,preserved};
}
