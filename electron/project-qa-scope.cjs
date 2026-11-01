'use strict';
const fs=require('node:fs');
const path=require('node:path');
const denied=()=>{throw Object.assign(new Error('프로젝트 QA 연결에서는 지정한 프로젝트만 사용할 수 있습니다. 전체 관리는 QA 연결을 해제하거나 기본 창에서 수행하십시오.'),{code:'TARGET_MISMATCH'});};
const qaProjectId=record=>record?.qaActive&&record.projectId||'';
function scopedSnapshot(snapshot,projectId){
  if(!projectId)return snapshot;
  const projects=snapshot.projects.filter(item=>item.id===projectId),groupIds=new Set(projects.map(item=>item.groupId));
  const serviceIds=new Set(projects.flatMap(item=>item.serviceIds||[])),reviews=snapshot.reviews.filter(item=>item.projectId===projectId),reviewIds=new Set(reviews.map(item=>item.id));
  return {...snapshot,projects,groups:snapshot.groups.filter(item=>groupIds.has(item.id)),services:snapshot.services.filter(item=>serviceIds.has(item.id)),reviews,
    activities:snapshot.activities.filter(item=>reviewIds.has(item.reviewId)),attachments:snapshot.attachments.filter(item=>reviewIds.has(item.reviewId))};
}
// Resolve existing symlink ancestors even when the requested child is missing.
function realLocation(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0'))denied();
  let parent=path.resolve(value);const missing=[];
  for(;;){try{return path.join(fs.realpathSync(parent),...missing.reverse());}catch(error){if(error.code!=='ENOENT'||path.dirname(parent)===parent)denied();missing.push(path.basename(parent));parent=path.dirname(parent);}}
}
function assertProjectAction({projectId,action,payload={},snapshot,run,request,stagedAttachment}){
  if(!projectId)return;
  if(!payload||typeof payload!=='object'||Array.isArray(payload))denied();
  const project=snapshot.projects.find(item=>item.id===projectId);if(!project)denied();
  const services=new Set(project.serviceIds||[]);
  const ownProject=value=>{if(value!==projectId)denied();};
  const ownReview=value=>{const item=snapshot.reviews.find(row=>row.id===value);if(!item||item.projectId!==projectId)denied();return item;};
  const ownService=value=>{if(!services.has(value))denied();};
  const ownRun=value=>{const item=run?.(value);if(!item)denied();if(item.reviewId)ownReview(item.reviewId);else ownService(item.serviceId);return item;};
  const ownRequest=value=>{const item=request?.(value);if(!item)denied();ownReview(item.reviewId);return item;};
  const ownAttachment=value=>{const item=snapshot.attachments.find(row=>row.id===value);if(item)ownReview(item.reviewId);else if(!stagedAttachment?.(value))denied();};
  if(payload.projectId!==undefined)ownProject(payload.projectId);
  if(payload.reviewId!==undefined)ownReview(payload.reviewId);
  if(payload.serviceId!==undefined&&payload.serviceId!==null)ownService(payload.serviceId);
  if(payload.runId!==undefined)ownRun(payload.runId);
  for(const key of ['retryOf','sourceRunId','continuedFromRunId','predecessorId'])if(payload[key]){if(key==='predecessorId'&&request?.(payload[key]))ownRequest(payload[key]);else ownRun(payload[key]);}
  for(const source of [payload,payload.context||{}]){
    if(source.screenshotId)ownAttachment(source.screenshotId);
    for(const key of ['attachmentIds','removeAttachmentIds'])if(Array.isArray(source[key]))for(const value of source[key])ownAttachment(value);
  }
  const simple=new Set(['snapshot','app.info','window.context','window.state','window.navigation','window.fullscreen','window.close','integration.pending','integration.displayed','update.state','update.rendererReady','clipboard.writeText','viewer.capture','screenshot.export','attachment.stage','attachment.stageFiles','attachment.stageData','attachment.staged','attachment.stagePreview','attachment.discard','dialog.directory','dialog.key','dialog.executable']);
  if(simple.has(action)||action.startsWith('browser.'))return;
  if(action==='window.openProject'){ownProject(payload.projectId);return;}
  if(action==='project.save'){
    ownProject(payload.id);
    if(payload.groupId!==undefined&&payload.groupId!==project.groupId)denied();
    if(Array.isArray(payload.serviceIds))for(const value of payload.serviceIds)ownService(value);
    if(payload.connection?.id)ownService(payload.connection.id);
    return;
  }
  if(action==='project.delete'){ownProject(payload.id);return;}
  if(action==='review.save'){if(payload.id)ownReview(payload.id);else ownProject(payload.projectId);return;}
  if(action==='review.delete'){ownReview(payload.id);return;}
  if(action.startsWith('review.version.')){ownReview(payload.reviewId);return;}
  if(action==='activity.add'||action==='attachment.add'){ownReview(payload.reviewId);return;}
  if(action==='activity.update'){const item=snapshot.activities.find(row=>row.id===payload.id);if(!item)denied();ownReview(item.reviewId);return;}
  if(['attachment.read','attachment.export','attachment.delete'].includes(action)){ownAttachment(payload.id);return;}
  if(['files.list','files.read','ssh.test','ssh.run','ssh.trust','terminal.open'].includes(action)){const serviceId=payload.serviceId||project.connection?.id;ownService(serviceId);if(action==='ssh.trust'&&snapshot.projects.some(item=>item.id!==projectId&&item.serviceIds?.includes(serviceId)))denied();return;}
  if(['terminal.read','terminal.write','terminal.resize','terminal.close'].includes(action))return; // The terminal manager separately verifies its owning window.
  if(['directory.inspect','directory.create'].includes(action)){
    const target=realLocation(action==='directory.create'?payload.parent:payload.path);
    if(!snapshot.services.some(item=>services.has(item.id)&&item.kind==='local'&&item.rootPath&&(()=>{const relative=path.relative(realLocation(item.rootPath),target);return !relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)})()))denied();
    return;
  }
  if(action.startsWith('agent.request.')){if(['agent.request.list','agent.request.add'].includes(action))ownReview(payload.reviewId);else ownRequest(payload.id);return;}
  if(['agent.read','agent.cancel'].includes(action)){ownRun(payload.id);return;}
  if(['agent.models','agent.environment','agent.loginState','agent.login','agent.logout'].includes(action)){
    ownService(payload.serviceId||project.connection?.id);
    if(['agent.login','agent.logout'].includes(action)&&snapshot.projects.some(item=>item.id!==projectId&&item.serviceIds?.includes(payload.serviceId||project.connection?.id)))denied();
    return;
  }
  if(['agent.start','agent.list','agent.materials','agent.instructionExport','agent.copyDraft','agent.session','agent.fileRead','agent.fileExport'].includes(action)){ownReview(payload.reviewId);return;}
  if(action==='agent.transfer'){ownRun(payload.runId);return;}
  // Global groups, hosts, accounts, backup, updates, settings, category creation,
  // service mutation, cross-project copying and future actions require the full app.
  denied();
}
module.exports={qaProjectId,scopedSnapshot,assertProjectAction};
