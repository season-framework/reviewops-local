const contextVersion=1;
const ids=value=>Array.isArray(value)?value:[];

// A request consumes its selected materials once. Preserve anything added in
// another open panel while that request was being accepted.
export function acceptedAgentDraft(current,sent){
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
