const contextVersion=1;
const ids=value=>Array.isArray(value)?value:[];
const draftCache=new Map();

export function hasAgentDraftContent(value={}){
 return Boolean(value.prompt?.trim()||ids(value.pending).length||ids(value.attachmentIds).length||ids(value.logIds).length||value.instruction||value.screenshotId||value.screenshotToken||value.model||value.reasoningEffort||value.predecessorId||value.requiredResult||value.newConversation||value.fresh||value.sourceRunId||value.continuedFromRunId);
}

// Queue edits use a separate slot. Opening them never replaces an unsent request.
export function queueEditDraft(row){
 return {editingId:row.id,prompt:row.prompt||'',fresh:Boolean(row.newConversation),
  model:row.executionSettings?.selected?.model??row.model??'',reasoningEffort:row.executionSettings?.selected?.reasoningEffort??row.reasoningEffort??'',
  executionSettings:row.executionSettings||null,predecessorId:row.predecessorId||'',requiredResult:row.requiredResult||'',
  ...(row.context||{instruction:false,attachmentIds:[],logIds:[]}),pending:[],contextInitialized:true,contextVersion,
  sourceRunId:row.sourceRunId||null,sourceTarget:row.sourceTarget||null,continuedFromRunId:row.continuedFromRunId||null};
}

export function legacyFollowupDraft(value){
 return {...value,fresh:value.fresh??Boolean(value.newConversation),contextInitialized:true,contextVersion,
  instruction:value.instruction??false,attachmentIds:ids(value.attachmentIds),logIds:ids(value.logIds),pending:ids(value.pending)};
}

export function acceptedQueueEditDraft(current,sent,saved){
 if(JSON.stringify(current)===JSON.stringify(sent))return {};
 if(current.editingId!==sent.editingId)return current;
 const consumed=new Set(ids(sent.pending).map(file=>file.token)),context=saved.context||{};
 return {...current,pending:ids(current.pending).filter(file=>!consumed.has(file.token)),
  attachmentIds:[...new Set([...ids(current.attachmentIds),...ids(context.attachmentIds).filter(id=>!ids(sent.attachmentIds).includes(id))])],
  ...(current.screenshotToken&&current.screenshotToken===sent.screenshotToken?{screenshotToken:null,screenshotId:context.screenshotId||current.screenshotId}:{}),
 };
}

export function readPersistedAgentDraft(storage,key,{refresh=false}={}){
 if(!refresh&&draftCache.has(key))return draftCache.get(key);
 let value={};
 try{const raw=storage.getItem(key)||'';if(raw){try{const parsed=JSON.parse(raw);value=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{prompt:raw};}catch{value={prompt:raw};}}}catch{}
 draftCache.set(key,value);return value;
}

export function persistAgentDraft(storage,key,value){
 draftCache.set(key,value);
 try{storage.setItem(key,JSON.stringify(value));return {saved:true};}
 catch(error){return {saved:false,error};}
}

// A request consumes its selected materials once. Preserve anything added in
// another open panel while that request was being accepted.
export function acceptedAgentDraft(current,sent){
 if(current.requestId&&sent.requestId&&current.requestId!==sent.requestId)return current;
 const tokens=new Set(ids(sent.pending).map(file=>file.token));
 return {...current,contextInitialized:true,contextVersion,hasAcceptedRequest:true,
  prompt:current.prompt===sent.prompt?'':current.prompt,
  pending:ids(current.pending).filter(file=>!tokens.has(file.token)),
  instruction:current.instruction===sent.instruction?false:current.instruction,
  screenshotId:current.screenshotId===sent.screenshotId?null:current.screenshotId,
  screenshotToken:current.screenshotToken===sent.screenshotToken?null:current.screenshotToken,
  attachmentIds:ids(current.attachmentIds).filter(id=>!ids(sent.attachmentIds).includes(id)),
  logIds:ids(current.logIds).filter(id=>!ids(sent.logIds).includes(id)),
  requestId:current.requestId===sent.requestId?null:current.requestId,
  fresh:current.fresh===sent.fresh?false:current.fresh,
  sourceRunId:current.sourceRunId===sent.sourceRunId?null:current.sourceRunId,
  sourceTarget:current.sourceRunId===sent.sourceRunId?null:current.sourceTarget,
  continuedFromRunId:current.continuedFromRunId===sent.continuedFromRunId?null:current.continuedFromRunId,
 };
}

export function initializeAgentDraft(current,materials){
 // The main process may have saved a request before its IPC response was lost.
 // Its unchanged request ID identifies the already submitted draft precisely.
 if(current.requestId&&ids(materials.requestIds).includes(current.requestId))return acceptedAgentDraft(current,current);
 if(current.contextVersion===contextVersion)return current;
 const hasRequests=Boolean(materials.hasRequests||current.hasAcceptedRequest);
 const initialized={...current,contextInitialized:true,contextVersion,hasAcceptedRequest:hasRequests};
 const latest=[...(materials.screenshots||[])].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).at(-1)?.id||null;
 if(!current.contextInitialized)return {...initialized,
  instruction:current.instruction??!hasRequests,
  screenshotId:current.screenshotId??(current.screenshotToken||hasRequests?null:latest),
  attachmentIds:ids(current.attachmentIds),
  logIds:current.logIds??(hasRequests?[]:ids(materials.logs).map(log=>log.id)),
 };
 if(!hasRequests||current.requestId)return initialized;
 // Older versions retained the previous request's selections after sending.
 // Remove those repeated selections while keeping new selections and files.
 const previous=materials.lastRequestContext||{instruction:true,screenshotId:latest,logIds:ids(materials.logs).map(log=>log.id)};
 return {...initialized,
  instruction:previous.instruction&&current.instruction?false:current.instruction,
  screenshotId:previous.screenshotId&&current.screenshotId===previous.screenshotId?null:current.screenshotId,
  attachmentIds:ids(current.attachmentIds).filter(id=>!ids(previous.attachmentIds).includes(id)),
  logIds:ids(current.logIds).filter(id=>!ids(previous.logIds).includes(id)),
 };
}
