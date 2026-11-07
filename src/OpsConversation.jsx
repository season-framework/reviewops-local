import React,{useEffect,useRef,useState} from 'react';
import {getLocale,t} from './i18n/index.js';
import OpsAppliedSkills from './OpsAppliedSkills.jsx';
import Markdown from './ReviewMarkdown.jsx';
import {errorText,outcomeKey} from './OpsState.mjs';
export const opsTime=(value,timezone)=>{if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return '—';try{return date.toLocaleString(getLocale(),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZoneName:'short',...(timezone?{timeZone:timezone}:{})})}catch{return date.toISOString()}};
const roleLabel=role=>({assistant:t('Codex'),user:t('사용자'),system:t('시스템'),tool:t('도구')}[role]||role||t('작업 기록'));
const qaStateKey=state=>({attached:'연결됨',released:'해제됨',stale:'만료된 연결',unknown:'결과 확인 필요',unavailable:'사용 불가'}[state]||'연결 없음');
const qaValue=value=>typeof value==='string'||typeof value==='number'?String(value):'';
function QaIdentifiers({record={}}){
 const fields=[['projectId','프로젝트 ID'],['windowId','QA 창 ID'],['sessionId','QA 세션 ID'],['clientId','QA 클라이언트 ID'],['threadId','Codex 세션'],['turnId','실행 ID'],['appInstanceId','앱 실행 ID']];
 return <dl className="ops-meta">{fields.map(([key,label])=>qaValue(record[key])?<React.Fragment key={key}><dt>{t(label)}</dt><dd><code>{qaValue(record[key])}</code></dd></React.Fragment>:null)}</dl>;
}

export function OpsQaStatus({goal,projects=[]}){
 const binding=goal.qaBinding,unavailable=!goal.projectId||binding?.state==='unavailable',state=unavailable?'unavailable':binding?.state;
 const project=projects.find(row=>row.id===(binding?.projectId||goal.projectId));
 return <section className="ops-inline-notice ops-qa-binding" aria-label={t('목표 QA 연결')}><div style={{width:'100%',minWidth:0}}><div className="ops-section-heading"><strong>{t('목표 QA 연결')}</strong><span className="ops-status" role="status">{t(qaStateKey(state))}</span></div>
  {unavailable?<p>{t('QA는 프로젝트에 연결된 목표에서 사용할 수 있습니다. 폴더 목표에는 QA 연결을 만들지 않습니다.')}</p>:<><p>{project?.name||binding?.projectId||goal.projectId}</p>{binding?.reason&&<p>{t(errorText(binding.reason))}</p>}{!binding&&<p>{t('Codex가 이 목표의 프로젝트에 QA를 연결하면 실제 연결 상태를 표시합니다.')}</p>}{binding&&<details><summary>{t('QA 연결 식별자')}</summary><QaIdentifiers record={binding}/>{binding.attachedAt&&<p>{t('연결 시각')}: {opsTime(binding.attachedAt)}</p>}{binding.releasedAt&&<p>{t('해제 시각')}: {opsTime(binding.releasedAt)}</p>}</details>}</>}
  {binding?.lastError&&<p className="form-error" role="alert">{t(errorText(binding.lastError))}</p>}
 </div></section>;
}

export function OpsQaReceipts({receipts=[]}){
 const [limit,setLimit]=useState(10),rows=receipts.slice().reverse();
 if(!rows.length)return null;
 return <section className="ops-history ops-qa-receipts" aria-label={t('QA 처리 기록')}><h3>{t('QA 처리 기록')}</h3><ol>{rows.slice(0,limit).map((row,index)=><li key={row.callId||index}><details><summary><span><strong>{row.tool||t('QA 작업')}</strong><small>{opsTime(row.createdAt)}</small></span><span className="ops-status">{t(outcomeKey(row.status))}</span></summary><div className="ops-history-body"><OpsAppliedSkills snapshot={row.skills}/><dl className="ops-meta"><dt>{t('도구 호출 ID')}</dt><dd><code>{row.callId||'—'}</code></dd>{row.completedAt&&<><dt>{t('처리 시각')}</dt><dd>{opsTime(row.completedAt)}</dd></>}</dl><QaIdentifiers record={row}/>{row.binding&&<><h4>{t('기록된 QA 연결')}</h4><p>{t(qaStateKey(row.binding.state))}</p><QaIdentifiers record={row.binding}/></>}{row.capture&&<><h4>{t('캡처 기록')}</h4><dl className="ops-meta">{[['id','캡처 ID'],['sha256','SHA-256'],['size','파일 크기 (바이트)'],['mimeType','파일 형식'],['width','이미지 너비'],['height','이미지 높이'],['relativePath','저장 위치']].map(([key,label])=>qaValue(row.capture[key])?<React.Fragment key={key}><dt>{t(label)}</dt><dd><code>{qaValue(row.capture[key])}</code></dd></React.Fragment>:null)}</dl></>}{row.error&&<p className="form-error" role="alert">{t(errorText(row.error))}</p>}</div></details></li>)}</ol>{rows.length>limit&&<button type="button" className="button" onClick={()=>setLimit(value=>value+10)}>{t('이전 QA 기록 더 보기')}</button>}</section>;
}

export function OpsHistory({history=[],scheduleId='',invoke,onError}){
 const [limit,setLimit]=useState(30),rows=history.filter(row=>!scheduleId||row.scheduleId===scheduleId||row.scheduleIds?.includes(scheduleId)).slice().reverse();
 useEffect(()=>setLimit(30),[scheduleId]);
 return <section className="ops-history" aria-label={t('실행·변경 기록')}><h3>{t('실행·변경 기록')}</h3>{rows.length?<><ol>{rows.slice(0,limit).map(row=><li key={row.id}><details><summary><span><strong>{row.message||row.reason||row.type||t('작업 기록')}</strong><small>{opsTime(row.createdAt)}</small></span>{row.status&&<span className="ops-status">{t(outcomeKey(row.status))}</span>}</summary><div className="ops-history-body"><OpsAppliedSkills snapshot={row.skills}/><dl className="ops-meta">{row.actor&&<><dt>{t('변경 주체')}</dt><dd>{row.actor==='codex'?'Codex':row.actor==='user'?t('사용자'):row.actor}</dd></>}{row.type&&<><dt>{t('기록 종류')}</dt><dd><code>{row.type}</code></dd></>}{row.reason&&<><dt>{t('실행·변경 이유')}</dt><dd>{row.reason}</dd></>}{(row.scheduleId||row.scheduleIds?.length>0)&&<><dt>{t('예약 작업 ID')}</dt><dd><code>{row.scheduleIds?.length?row.scheduleIds.join(', '):row.scheduleId}</code></dd></>}{row.threadId&&<><dt>{t('Codex 세션')}</dt><dd><code>{row.threadId}</code></dd></>}{row.turnId&&<><dt>{t('실행 ID')}</dt><dd><code>{row.turnId}</code></dd></>}</dl>{row.error&&<p className="form-error" role="alert">{t(errorText(row.error))}</p>}{row.schedule&&<><h4>{t('변경한 예약 내용')}</h4><dl className="ops-meta"><dt>{t('예약 작업 이름')}</dt><dd>{row.schedule.name}</dd><dt>{t('반복 일정 (cron)')}</dt><dd><code>{row.schedule.cron}</code></dd><dt>{t('시간대')}</dt><dd>{row.schedule.timezone}</dd></dl><pre className="ops-prompt-preview">{row.schedule.prompt}</pre></>}{row.prompt&&<><h4>{t('기록된 실행 프롬프트')}</h4><pre className="ops-prompt-preview">{row.prompt}</pre></>}{row.text&&<Markdown text={row.text} invoke={invoke} onError={onError}/>}</div></details></li>)}</ol>{rows.length>limit&&<button type="button" className="button" onClick={()=>setLimit(value=>value+30)}>{t('이전 기록 더 보기')}</button>}</>:<p className="ops-empty-note">{t('저장된 실행·변경 기록이 없습니다.')}</p>}</section>;
}

export default function OpsConversation({goal,invoke,onRequest,onDirtyChange,pending=false}){
 const [instruction,setInstruction]=useState(''),[error,setError]=useState(''),[limit,setLimit]=useState(50),dirtyCallback=useRef(onDirtyChange);dirtyCallback.current=onDirtyChange;
 useEffect(()=>{dirtyCallback.current?.(Boolean(instruction.trim()));return()=>dirtyCallback.current?.(false)},[instruction]);
 const messages=goal.conversation||[],visible=messages.slice(-limit),canRequest=goal.status==='active'&&!['unknown','error','starting'].includes(goal.executionState);
 const submit=async event=>{event.preventDefault();if(!instruction.trim()||pending||!canRequest)return;setError('');try{await onRequest(instruction);setInstruction('')}catch(cause){setError(errorText(cause))}};
 return <div className="ops-conversation-panel"><section className="ops-conversation" aria-label={t('목표 대화')}><div className="ops-section-heading"><h3>{t('목표 대화')}</h3><span>{messages.length}{t('개 메시지')}</span></div>{goal.threadId?<p className="ops-session-label">{t('연결된 Codex 세션')}: <code>{goal.threadId}</code></p>:<p className="ops-empty-note">{t('첫 실행에서 이 목표의 Codex 세션을 연결합니다.')}</p>}{messages.length?<>{messages.length>limit&&<button type="button" className="button" onClick={()=>setLimit(value=>value+50)}>{t('이전 대화 더 보기')}</button>}<ol className="ops-messages">{visible.map((message,index)=><li key={message.id||message.itemId||index} className={`ops-message ops-message-${message.role}`}><header><strong>{roleLabel(message.role)}</strong><time dateTime={message.createdAt}>{opsTime(message.createdAt)}</time>{message.partial&&<span className="ops-streaming" role="status">{t('응답 중')}</span>}</header><OpsAppliedSkills snapshot={message.skills} compact/><Markdown text={message.text||''} invoke={invoke} onError={setError}/></li>)}</ol></>:<p className="ops-empty-note">{t('아직 저장된 대화가 없습니다.')}</p>}</section>
  <form className="ops-request-form" aria-label={t('목표에 추가 지시')} onSubmit={submit}><label className="ops-field"><span>{t('추가 지시')}</span><textarea aria-label={t('추가 지시')} rows={3} value={instruction} onChange={event=>setInstruction(event.target.value)} disabled={!canRequest||pending} placeholder={t('같은 Codex 세션에서 이어갈 요청을 입력하십시오.')}/></label><div className="ops-request-footer"><small>{canRequest?t('실행 중이면 같은 작업에 전달하고, 대기 중이면 같은 세션에서 이어갑니다.'):t('추가 지시는 활성 목표에 전달할 수 있습니다.')}</small><button type="submit" className="button primary" disabled={!canRequest||pending||!instruction.trim()}>{pending?t('전달 중'):t('지시 전달')}</button></div>{error&&<p className="form-error" role="alert">{t(error)}</p>}</form>
  <OpsQaReceipts key={goal.id} receipts={goal.qaReceipts}/>
  <OpsHistory history={goal.history} invoke={invoke} onError={setError}/>
 </div>;
}
