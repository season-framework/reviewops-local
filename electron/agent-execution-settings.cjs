'use strict';

const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const fail = () => {throw new Error('저장된 모델과 추론 설정이 올바르지 않습니다.');};
function model(value) {
  if(typeof value!=='string'||value.length>256||/[\s\0]/.test(value))fail();
  return value;
}
function pair(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['model','reasoningEffort'].includes(key)))fail();
  if(!EFFORTS.includes(value.reasoningEffort))fail();
  return {model:model(value.model),reasoningEffort:value.reasoningEffort};
}
function executionSettings(value, sent) {
  if(value===undefined) {
    const selected=pair(sent);
    return {version:1,selected,automatic:{model:!selected.model,reasoningEffort:!selected.reasoningEffort},sent:{...selected}};
  }
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||Object.keys(value).some(key=>!['version','selected','automatic','sent'].includes(key)))fail();
  const selected=pair(value.selected),transmitted=pair(value.sent),automatic=value.automatic;
  if(!automatic||typeof automatic!=='object'||Array.isArray(automatic)||Object.keys(automatic).length!==2||typeof automatic.model!=='boolean'||typeof automatic.reasoningEffort!=='boolean')fail();
  if(automatic.model!==!selected.model||automatic.reasoningEffort!==!selected.reasoningEffort)fail();
  if(sent&&(transmitted.model!==sent.model||transmitted.reasoningEffort!==sent.reasoningEffort))fail();
  return {version:1,selected,automatic:{...automatic},sent:transmitted};
}
function reportedSettings(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['model','reasoningEffort','source','eventType','reportedAt'].includes(key)))fail();
  if(value.source!=='cli_event'||typeof value.eventType!=='string'||!/^[-a-zA-Z_.]{1,128}$/.test(value.eventType)||typeof value.reportedAt!=='string'||!Number.isFinite(Date.parse(value.reportedAt)))fail();
  if(value.model===undefined&&value.reasoningEffort===undefined)fail();
  if(value.model!==undefined)model(value.model);
  if(value.reasoningEffort!==undefined&&(typeof value.reasoningEffort!=='string'||!/^[\w-]{1,128}$/.test(value.reasoningEffort)))fail();
  return {...value};
}
function requestContext(value) {
  if(value===undefined||value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['instruction','screenshotId','attachmentIds','logIds'].includes(key))||typeof value.instruction!=='boolean')throw new Error('후속 요청의 첨부 자료가 올바르지 않습니다.');
  const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
  if(value.screenshotId!==null&&value.screenshotId!==undefined&&!identifier(value.screenshotId))throw new Error('후속 요청의 스크린샷을 다시 선택하십시오.');
  const result={instruction:value.instruction,screenshotId:value.screenshotId||null};
  for(const key of ['attachmentIds','logIds']) {
    const ids=value[key]||[];
    if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!identifier(id))||new Set(ids).size!==ids.length)throw new Error('후속 요청의 첨부 자료 목록이 올바르지 않습니다.');
    result[key]=[...ids];
  }
  return result;
}
module.exports={executionSettings,reportedSettings,requestContext};
