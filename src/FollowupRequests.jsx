import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n/index.js';
import {Button} from './components.jsx';

const stored=key=>{try{return JSON.parse(localStorage.getItem(key)||'{}')}catch{return {}}};
const labels={waiting:'대기 중',ready:'실행 가능',running:'실행 중',finished:'실행 종료',cancelled:'취소됨'};

export default function FollowupRequests({reviewId,invoke,onStarted}) {
 const key=`reviewops.agent.followup.${reviewId}`;
 const [draft,setDraft]=useState(()=>stored(key)),[value,setValue]=useState({requests:[],predecessors:[]}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(null),[notice,setNotice]=useState('');
 const live=useRef(true),draftRef=useRef(draft);draftRef.current=draft;
 const change=patch=>setDraft(current=>{const next={...current,...patch,requestId:null};localStorage.setItem(key,JSON.stringify(next));return next;});
 const load=async()=>{const result=await invoke('agent.request.list',{reviewId});if(live.current)setValue(result);return result;};
 useEffect(()=>{live.current=true;let timer;const poll=async()=>{try{await load()}catch(cause){if(live.current)setError(cause.message)}if(live.current)timer=setTimeout(poll,1500);};poll();return()=>{live.current=false;clearTimeout(timer);};},[reviewId,invoke]);
 const act=async(method,payload)=>{if(busy)return;setBusy(true);setError('');try{const result=await invoke(`agent.request.${method}`,payload);await load();return result;}catch(cause){setError(cause.message);return null;}finally{setBusy(false);}};
 const add=async event=>{
  event.preventDefault();if(busy||!draft.prompt?.trim())return;
  const sent=draftRef.current,requestId=sent.requestId||crypto.randomUUID(),next={...sent,requestId};setDraft(next);localStorage.setItem(key,JSON.stringify(next));
  const result=await act('add',{reviewId,prompt:sent.prompt,predecessorId:sent.predecessorId||'',requiredResult:sent.requiredResult||'',requestId});
  if(result){if(draftRef.current.requestId===requestId){setDraft({});localStorage.removeItem(key);}setNotice(t('후속 요청을 저장했습니다. 실행 버튼을 누르기 전에는 시작하지 않습니다.'));}
 };
 const start=async row=>{const result=await act('start',{id:row.id});if(result)onStarted?.(result);};
 const resolve=async event=>{event.preventDefault();if(await act('resolve',editing))setEditing(null);};
 const pending=value.requests.filter(row=>!['finished','cancelled'].includes(row.state));
 return <details className="agent-followups">
  <summary aria-live="polite">{t('후속 요청')}{pending.length>0?` · ${pending.length}`:''}{pending.some(row=>row.state==='ready')?` · ${t('실행 가능')}`:''}</summary>
  <p>{t('실행 중인 에이전트에는 추가 요청을 전달할 수 없습니다. 요청을 여기에 저장하고, 앞선 작업이 끝난 뒤 실행하십시오.')}</p>
  <form onSubmit={add} className="agent-followup-form">
   <label>{t('후속 요청 내용')}<textarea aria-label={t('후속 요청 내용')} value={draft.prompt||''} maxLength={100000} disabled={busy} onChange={event=>change({prompt:event.target.value})}/></label>
   <label>{t('먼저 끝나야 하는 실행')}<select aria-label={t('먼저 끝나야 하는 실행')} value={draft.predecessorId||''} disabled={busy} onChange={event=>change({predecessorId:event.target.value})}><option value="">{t('선택하지 않음')}</option>{value.predecessors.map(run=><option key={run.id} value={run.id}>{run.title} · {run.prompt.slice(0,70)} · {run.id.slice(0,8)}</option>)}</select></label>
   <label>{t('실행에 필요한 결과')}<input aria-label={t('실행에 필요한 결과')} value={draft.requiredResult||''} maxLength={10000} placeholder={t('예: 수정한 화면과 테스트 결과')} disabled={busy} onChange={event=>change({requiredResult:event.target.value})}/></label>
   <p>{t('요청문을 저장합니다. 후속 실행은 해당 리뷰 내용과 함께 시작되며, 자동으로 시작하지 않습니다.')}</p>
   <Button type="submit" disabled={busy||!draft.prompt?.trim()}>{t('대기 목록에 추가')}</Button>
  </form>
  {notice&&<p role="status">{notice}</p>}
  {value.requests.length>0&&<ol className="agent-followup-list" aria-label={t('후속 요청 목록')}>{value.requests.map(row=><li key={row.id}>
   <header><strong>{t(labels[row.state]||row.state)}</strong><small>{row.delivery==='not_sent'?t('전달하지 않음'):t('후속 실행에 제출됨')}</small></header>
   <p className="agent-followup-prompt">{row.prompt}</p>
   <p>{t(row.reason)}</p>
   <dl><dt>{t('요청 ID')}</dt><dd>{row.id}</dd>{row.predecessorId&&<><dt>{t('기다리는 실행')}</dt><dd>{value.predecessors.find(item=>item.id===row.predecessorId)?.title||row.predecessorId} · {row.predecessorId}</dd></>}{row.requiredResult&&<><dt>{t('필요한 결과')}</dt><dd>{row.requiredResult}{row.resultConfirmed?` · ${t('사용자 확인 완료')}`:''}</dd></>}{row.runId&&<><dt>{t('연결된 실행')}</dt><dd>{row.runId}</dd></>}</dl>
   {row.runId&&<p>{t('수신 여부는 제공되지 않습니다. 실행 완료만으로 요청이 반영되었다고 표시하지 않습니다.')}</p>}
   {row.resolution==='applied'?<p>{t('사용자가 반영 완료로 기록함')} · {row.resultVersion}{row.resultNote?` · ${row.resultNote}`:''}</p>:row.resolution==='deferred'?<p>{t('사용자가 보류로 기록함')} · {row.resultNote}</p>:row.state==='finished'?<p>{t('요청 반영 여부를 기록하지 않았습니다.')}</p>:null}
   {row.runError&&<p className="form-error">{row.runError}</p>}
   <div className="agent-response-actions">{row.state==='ready'&&<Button disabled={busy} onClick={()=>start(row)}>{t('후속 요청 실행')}</Button>}{['waiting','ready'].includes(row.state)&&<><Button disabled={busy} onClick={()=>act('cancel',{id:row.id})}>{t('요청 취소')}</Button>{row.requiredResult&&!row.resultConfirmed&&<Button disabled={busy||Boolean(row.predecessorId&&value.predecessors.find(run=>run.id===row.predecessorId)?.status!=='completed')} onClick={()=>act('confirmResult',{id:row.id})}>{t('필요한 결과가 준비됨')}</Button>}</>}{row.state==='finished'&&<Button disabled={busy} onClick={()=>setEditing({id:row.id,resolution:row.resolution==='pending'?'applied':row.resolution,resultVersion:row.resultVersion,resultNote:row.resultNote})}>{t('반영 여부 기록')}</Button>}</div>
   {editing?.id===row.id&&<form className="agent-followup-form" onSubmit={resolve}><label>{t('처리 결과')}<select aria-label={t('처리 결과')} value={editing.resolution} onChange={event=>setEditing({...editing,resolution:event.target.value})}><option value="applied">{t('반영 완료')}</option><option value="deferred">{t('보류')}</option></select></label>{editing.resolution==='applied'&&<label>{t('결과 버전 또는 파일')}<input aria-label={t('결과 버전 또는 파일')} required maxLength={1000} value={editing.resultVersion} onChange={event=>setEditing({...editing,resultVersion:event.target.value})}/></label>}<label>{editing.resolution==='deferred'?t('보류 이유'):t('처리 내용')}<textarea aria-label={editing.resolution==='deferred'?t('보류 이유'):t('처리 내용')} required={editing.resolution==='deferred'} maxLength={10000} value={editing.resultNote} onChange={event=>setEditing({...editing,resultNote:event.target.value})}/></label><div className="agent-response-actions"><Button type="submit" disabled={busy}>{t('기록 저장')}</Button><Button disabled={busy} onClick={()=>setEditing(null)}>{t('취소')}</Button></div></form>}
  </li>)}</ol>}
  {error&&<p className="form-error" role="alert">{error}</p>}
 </details>;
}
