export const REASONING_EFFORTS=['none','minimal','low','medium','high','xhigh','max','ultra'];

export const reasoningOptions=model=>model?[...new Set((model.reasoning||[]).map(value=>typeof value==='string'?value:value?.effort||value?.id).filter(value=>REASONING_EFFORTS.includes(value)))]:REASONING_EFFORTS;

export function defaultReasoning(model,preferred=''){
 const values=reasoningOptions(model);
 return values.includes(preferred)?preferred:values.includes(model?.defaultReasoningEffort)?model.defaultReasoningEffort:'';
}

export function supportedReasoning(model,value=''){
 if(!value)return '';
 return reasoningOptions(model).includes(value)?value:defaultReasoning(model);
}

export function automaticReasoning(model,hostEffort=''){
 return hostEffort?(reasoningOptions(model).includes(hostEffort)?hostEffort:''):defaultReasoning(model);
}

export function manualModels(rows){
 if(!Array.isArray(rows))return [];
 const ids=new Set();
 return rows.flatMap(row=>{
  const id=typeof row?.id==='string'?row.id.trim():'';
  if(!id||id.length>256||/\s/.test(id)||ids.has(id))return [];
  ids.add(id);const model={id,label:typeof row.label==='string'&&row.label.trim()?row.label.trim():id,reasoning:reasoningOptions(row)};
  return [{...model,defaultReasoningEffort:defaultReasoning(model,row.defaultReasoningEffort)}];
 }).slice(0,100);
}

export function availableModels(environment,registered=[]){
 return environment?.modelSource!=='manual'&&environment?.models?.length?environment.models:manualModels(registered);
}

export function environmentTarget(service){
 if(!service?.id)return '';
 return JSON.stringify([service.id,service.kind,service.hostAlias,service.sshConfigPath,service.host,service.port,service.username,service.authType,service.privateKeyPath,service.agentBinary,service.agentWorkPath,service.rootPath,service.updatedAt]);
}
