const activeRequests=new Set(['queued','prepared','accepted','unknown']);
const phases=new Set(['submitting','working','responding','stopping','completed','stopped','error','unknown']);

// A quiet output stream is not evidence that a request finished. Keep controls
// tied to admission, durable requests and the actual agent state instead.
export function canStopManagementConversation(row,{submitting=false}={}){
 return submitting||Boolean(row&&(['starting','running','unknown'].includes(row.executionState)||row.backgroundState==='active'||['submitting','working','responding','stopping','unknown'].includes(row.activity?.phase)||row.requests?.some(request=>activeRequests.has(request.status))));
}

export function managementPhase(row,{submitting=false,stopping=false}={}){
 if(row?.executionState==='unknown'||row?.activity?.phase==='unknown')return 'unknown';
 if(stopping||row?.activity?.phase==='stopping')return 'stopping';
 if(['working','responding'].includes(row?.activity?.phase))return row.activity.phase;
 if(submitting||row?.requests?.some(request=>['queued','prepared'].includes(request.status))||row?.executionState==='starting')return 'submitting';
 if(row?.executionState==='running'||row?.backgroundState==='active')return 'working';
 if(row?.executionState==='error')return 'error';
 if(phases.has(row?.activity?.phase))return row.activity.phase;
 const last=row?.requests?.at(-1);
 return {completed:'completed',interrupted:'stopped',cancelled:'stopped',failed:'error',unknown:'unknown',accepted:'working'}[last?.status]||'idle';
}

export function managementTimeline(row){
 return [...(row?.conversation||[]).map((value,index)=>({type:'message',value,index})),...(row?.progressEvents||[]).map((value,index)=>({type:'progress',value,index:index+(row?.conversation?.length||0)}))]
  .sort((a,b)=>(Date.parse(a.value.createdAt)||0)-(Date.parse(b.value.createdAt)||0)||a.index-b.index);
}

export function managementPreview(row){
 const message=[...(row?.conversation||[])].reverse().find(value=>typeof value.text==='string'&&value.text.trim());
 return message?.text.replace(/\s+/g,' ').trim().slice(0,160)||'';
}

export function removeManagementUiConversation(current,deletedId,remaining){
 const without=(value={})=>Object.fromEntries(Object.entries(value).filter(([key])=>key!==deletedId));
 return {...current,selected:current.selected===deletedId?(remaining[0]?.id||''):current.selected,historyOrigin:current.historyOrigin===deletedId?'':current.historyOrigin,drafts:without(current.drafts),scrollPositions:without(current.scrollPositions),selections:without(current.selections)};
}
