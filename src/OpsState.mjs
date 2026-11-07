export function chooseOpsSnapshot(current,incoming){
 if(!incoming||!Array.isArray(incoming.goals)||!Number.isSafeInteger(incoming.revision))return current;
 if(current&&incoming.revision<current.revision)return current;
 return incoming;
}
export function goalDraft(goal={}){
 goal ||= {};
 return {id:goal.id||'',name:goal.name||'',description:goal.description||'',projectId:goal.projectId||'',serviceId:goal.serviceId||'',workPath:goal.workPath||'',prompt:goal.prompt||'',model:goal.model||'',reasoningEffort:goal.reasoningEffort||'',sandboxMode:'danger-full-access',approvalPolicy:'never'};
}
export function scheduleDraft(schedule={},goalId=''){
 schedule ||= {};
 return {goalId:schedule.goalId||goalId,id:schedule.id||'',name:schedule.name||'',prompt:schedule.prompt||'',cron:schedule.cron||'0 * * * *',timezone:schedule.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',enabled:schedule.enabled??true};
}
export function goalStatusKey(status){return {draft:'시작 전',active:'활성',paused:'일시정지',finished:'목표 종료됨'}[status]||'상태 확인 중'}
export function executionStateKey(status){return {idle:'대기 중',starting:'시작 중',running:'실행 중',waiting:'작업 대상 대기',unknown:'전달 결과 확인 필요',error:'실행 오류'}[status]||'상태 확인 중'}
export function outcomeKey(status){return {pending:'전달 대기',queued:'전달 대기',prepared:'실행 준비',coalesced:'합침',replaced:'설정 변경으로 교체',accepted:'전달 확인',delivered:'전달 확인',completed:'완료',success:'성공',failed:'실패',error:'실패',unknown:'결과 확인 필요',interrupted:'중단',cancelled:'취소'}[status]||status||'기록 없음'}
export function errorText(error){return typeof error==='string'?error:error?.message||''}
export function dirtySettings(draft,source){return JSON.stringify(draft)!==JSON.stringify(source)}
