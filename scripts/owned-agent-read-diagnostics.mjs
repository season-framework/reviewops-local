// Pure, bounded observations of the original agent.read results. No product hooks.
const text = (value, limit = 256) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : null;
const safeError = value => text(value, 512)?.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/((?:token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0,512) ?? null;
const scope = value => ({id:text(value?.id,128),reviewId:text(value?.reviewId,128),serviceId:text(value?.serviceId,128),workPath:text(value?.workPath,512)});
export function createAgentReadDiagnostics() { return {schema:1,maxRows:3,observations:0,last:null,failure:null}; }
export function retainAgentReadSnapshot(state, {tag, projectId, group, rows, at}) {
  state.observations = Math.min(Number.MAX_SAFE_INTEGER, state.observations + 1);
  state.last = {at:text(at,64),tag:text(tag,64),projectId:text(projectId,128),phase:'three-running-until',rows:group.slice(0,3).map((expected,index)=>{
    const row=rows[index];
    return {expected:{...scope(expected),role:text(expected?.role,64)},actual:{...scope(row),status:text(row?.status,32),errorCode:text(row?.errorCode,128),error:safeError(row?.error)}};
  })};
  return state.last;
}
export function retainAgentReadFailure(state, at) {
  // The last original reads are retained. Do not issue diagnostic replacement reads.
  state.failure = {at:text(at,64),lastObserved:state.last ? structuredClone(state.last) : null};
}
