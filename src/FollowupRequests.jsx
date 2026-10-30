import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n/index.js';
import {Button} from './components.jsx';

const labels={waiting:'대기 중',ready:'실행 가능',running:'실행 중',finished:'실행 종료',cancelled:'취소됨'};

export default function FollowupRequests({reviewId,invoke,onStarted,onNavigate,onEdit,editingId,onQueueChange,onOpenChange,refreshToken=0}) {
 const [value,setValue]=useState({requests:[],predecessors:[]}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[resolution,setResolution]=useState(null);
 const live=useRef(true),queueChange=useRef(onQueueChange);queueChange.current=onQueueChange;
 const load=async()=>{const result=await invoke('agent.request.list',{reviewId});if(live.current){setValue(result);queueChange.current?.(result);}return result;};
 useEffect(()=>{live.current=true;let timer;const poll=async()=>{try{await load()}catch(cause){if(live.current)setError(cause.message)}if(live.current)timer=setTimeout(poll,1500);};poll();return()=>{live.current=false;clearTimeout(timer);};},[reviewId,invoke,refreshToken]);
 const act=async(method,payload)=>{if(busy)return;setBusy(true);setError('');try{const result=await invoke(`agent.request.${method}`,payload);await load();return result;}catch(cause){if(live.current)setError(cause.message);return null;}finally{if(live.current)setBusy(false);}};
 const start=async row=>{const result=await act('start',{id:row.id});if(result)await onStarted?.(result);};
 const resolve=async event=>{event.preventDefault();if(await act('resolve',resolution))setResolution(null);};
 const pending=value.requests.filter(row=>!['finished','cancelled'].includes(row.state));
 return <details className="agent-followups" onToggle={event=>{if(event.target===event.currentTarget)onOpenChange?.(event.currentTarget.open)}}>
  <summary>{t('대기 요청')}{pending.length>0?` · ${t('대기 {0}개',[pending.length])}`:''}</summary>
  <div className="agent-followups-body">
  {!value.requests.length&&<p>{t('대기 중인 요청이 없습니다. 아래 입력창에서 작성하여 저장하십시오.')}</p>}
  {value.requests.length>0&&<ol className="agent-followup-list" aria-label={t('후속 요청 목록')}>{value.requests.map(row=><li key={row.id}>
   <header><strong>{t(labels[row.state]||row.state)}</strong><span>{row.newConversation?t('새 대화'):t('같은 대화')}</span></header>
   <p className="agent-followup-prompt">{row.prompt}</p>
   {row.state==='waiting'&&<p>{t(row.reason)}</p>}
   <div className="agent-response-actions">{row.state==='ready'&&<Button disabled={busy||!row.settingsRecorded} onClick={()=>start(row)}>{t('실행')}</Button>}{['waiting','ready'].includes(row.state)&&<><Button disabled={busy} onClick={()=>onEdit?.(row)}>{editingId===row.id?t('수정 중'):t('수정')}</Button><Button disabled={busy} onClick={()=>act('cancel',{id:row.id})}>{t('대기 취소')}</Button>{row.requiredResult&&!row.resultConfirmed&&<Button disabled={busy||Boolean(row.predecessorId&&value.predecessors.find(run=>run.id===row.predecessorId)?.status!=='completed')} onClick={()=>act('confirmResult',{id:row.id})}>{t('필요한 결과가 준비됨')}</Button>}</>}{row.runId&&<Button onClick={()=>onNavigate?.(row.runId)}>{t('요청·응답으로 이동')}</Button>}</div>
   {!row.settingsRecorded&&['waiting','ready'].includes(row.state)&&<p>{t('설정 기록이 없습니다. 수정에서 모델과 추론 설정을 저장하십시오.')}</p>}
   <details className="agent-followup-details"><summary>{t('더보기')}</summary>{row.settingsRecorded&&<table className="agent-settings-table"><thead><tr><th>{t('항목')}</th><th>{t('선택값')}</th><th>{t('전달값')}</th></tr></thead><tbody>{[['model',t('모델')],['reasoningEffort',t('추론 수준')]].map(([key,label])=><tr key={key}><th>{label}</th><td>{row.executionSettings?.automatic?.[key]?t('자동'):row.executionSettings?.selected?.[key]||t('기록 없음')}</td><td>{row.executionSettings?.sent?.[key]||t('자동')}</td></tr>)}</tbody></table>}<dl><dt>{t('요청 ID')}</dt><dd>{row.id}</dd><dt>{t('전달 상태')}</dt><dd>{row.delivery==='not_sent'?t('전달하지 않음'):t('후속 실행에 제출됨')}</dd>{row.predecessorId&&<><dt>{t('기다리는 실행')}</dt><dd><button type="button" onClick={()=>onNavigate?.(row.predecessorId,value.predecessors.find(item=>item.id===row.predecessorId)?.reviewId)}>{value.predecessors.find(item=>item.id===row.predecessorId)?.title||t('요청·응답으로 이동')}</button><br/>{row.predecessorId}</dd></>}{row.requiredResult&&<><dt>{t('필요한 결과')}</dt><dd>{row.requiredResult}{row.resultConfirmed?` · ${t('사용자 확인 완료')}`:''}</dd></>}{row.runId&&<><dt>{t('연결된 실행')}</dt><dd>{row.runId}</dd></>}</dl>
    {row.runId&&<p>{t('수신 여부는 제공되지 않습니다. 실행 완료만으로 요청이 반영되었다고 표시하지 않습니다.')}</p>}
    {row.resolution==='applied'?<p>{t('사용자가 반영 완료로 기록함')} · {row.resultVersion}{row.resultNote?` · ${row.resultNote}`:''}</p>:row.resolution==='deferred'?<p>{t('사용자가 보류로 기록함')} · {row.resultNote}</p>:row.state==='finished'?<p>{t('요청 반영 여부를 기록하지 않았습니다.')}</p>:null}
    {row.state==='finished'&&<Button disabled={busy} onClick={()=>setResolution({id:row.id,resolution:row.resolution==='pending'?'applied':row.resolution,resultVersion:row.resultVersion,resultNote:row.resultNote})}>{t('반영 여부 기록')}</Button>}
    {resolution?.id===row.id&&<form className="agent-followup-form" onSubmit={resolve}><label>{t('처리 결과')}<select value={resolution.resolution} onChange={event=>setResolution({...resolution,resolution:event.target.value})}><option value="applied">{t('반영 완료')}</option><option value="deferred">{t('보류')}</option></select></label>{resolution.resolution==='applied'&&<label>{t('결과 버전 또는 파일')}<input required maxLength={1000} value={resolution.resultVersion} onChange={event=>setResolution({...resolution,resultVersion:event.target.value})}/></label>}<label>{resolution.resolution==='deferred'?t('보류 이유'):t('처리 내용')}<textarea required={resolution.resolution==='deferred'} maxLength={10000} value={resolution.resultNote} onChange={event=>setResolution({...resolution,resultNote:event.target.value})}/></label><div className="agent-response-actions"><Button type="submit" disabled={busy}>{t('기록 저장')}</Button><Button type="button" disabled={busy} onClick={()=>setResolution(null)}>{t('취소')}</Button></div></form>}
   </details>{row.runError&&<p className="form-error" role="alert">{row.runError}</p>}
  </li>)}</ol>}{error&&<p className="form-error" role="alert">{error}</p>}
  </div>
 </details>;
}
