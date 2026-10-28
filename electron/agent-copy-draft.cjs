'use strict';

function executionTarget(service,settings) {
 return {kind:service.kind,host:service.kind==='ssh'?service.host||'':'',hostAlias:service.kind==='ssh'?service.hostAlias||'':'',sshConfigPath:service.kind==='ssh'?service.sshConfigPath||'':'',port:service.kind==='ssh'?service.port:0,username:service.kind==='ssh'?service.username:'',workPath:settings.workPath,binary:settings.binary,model:settings.model||'',reasoningEffort:settings.reasoningEffort||''};
}
function copyAgentDraft({run,current,materials,sameLocation}) {
 if(!['failed','cancelled','interrupted'].includes(run.status))throw new Error('실패하거나 중단된 요청만 새 초안으로 가져올 수 있습니다.');
 const previous=run.executionTarget||{workPath:run.workPath,model:run.model,reasoningEffort:run.reasoningEffort},context=run.context||{},excluded=[];
 const available=new Map([...(materials.attachments||[]),...(materials.sharedFiles||[])].map(file=>[file.id,file]));
 const choose=(id,kind)=>{
  if(!id)return null;
  const saved=(kind==='screenshot'?context.screenshot:context.attachments?.find(file=>file.id===id)),file=available.get(id);
  if(!sameLocation||!file){excluded.push({id,name:saved?.name||id,reason:!sameLocation?'실행 대상이 변경되어 자료를 다시 선택해야 합니다.':'첨부 자료를 더 이상 사용할 수 없습니다.'});return null;}
  return id;
 };
 const screenshotId=choose(context.screenshotId,'screenshot'),attachmentIds=(context.attachmentIds||[]).map(id=>choose(id,'attachment')).filter(Boolean),availableLogs=new Set((materials.logs||[]).map(log=>log.id));
 const logIds=(context.logIds||[]).filter(id=>{if(sameLocation&&availableLogs.has(id))return true;excluded.push({id,name:context.logs?.find(log=>log.id===id)?.name||id,reason:!sameLocation?'실행 대상이 변경되어 로그를 다시 선택해야 합니다.':'저장된 로그를 더 이상 사용할 수 없습니다.'});return false;});
 if(context.instruction&&!sameLocation)excluded.push({id:'instruction',name:'작업 지시서',reason:'실행 대상이 변경되어 작업 지시서를 다시 선택해야 합니다.'});
 const fields=[['kind','접속 방식'],['host','호스트'],['hostAlias','SSH 호스트 이름'],['sshConfigPath','SSH 설정 파일'],['port','포트'],['username','사용자'],['workPath','작업 폴더'],['binary','Codex 실행 파일'],['model','모델'],['reasoningEffort','추론 수준']];
 const comparison=fields.filter(([key])=>!['host','hostAlias','sshConfigPath','port','username'].includes(key)||current.kind==='ssh'||previous.kind==='ssh').map(([key,label])=>({key,label,before:previous[key]??null,after:current[key]??'',changed:previous[key]!==undefined&&previous[key]!==current[key]}));
 return {sourceRunId:run.id,comparison,excluded,draft:{prompt:run.prompt,pending:[],screenshotToken:null,screenshotId,attachmentIds,logIds,instruction:Boolean(context.instruction&&sameLocation),model:current.model||'',reasoningEffort:current.reasoningEffort||'',fresh:true,independent:Boolean(run.independentExecution),requestId:null,sourceRunId:run.id,sourceTarget:{...current},contextInitialized:true,contextVersion:1,hasAcceptedRequest:true}};
}
module.exports={executionTarget,copyAgentDraft};
