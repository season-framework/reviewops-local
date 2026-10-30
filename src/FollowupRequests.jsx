import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n/index.js';
import {Button} from './components.jsx';
import {reasoningOptions} from './agent-models.mjs';
import {pendingSettingsForEdit} from './agent-conversation.mjs';
import {persistAgentDraft,readPersistedAgentDraft} from './agent-draft.mjs';

const stored=key=>readPersistedAgentDraft(localStorage,key);
const labels={waiting:'대기 중',ready:'실행 가능',running:'실행 중',finished:'실행 종료',cancelled:'취소됨'};
const settingsFor=(draft,service)=>{
 const model=draft.model??'',reasoningEffort=draft.reasoningEffort??'';
 return {version:1,selected:{model,reasoningEffort},automatic:{model:!model,reasoningEffort:!reasoningEffort},sent:{model:model||service?.agentModel||'',reasoningEffort:draft.reasoningEffort??service?.agentReasoningEffort??''}};
};

export default function FollowupRequests({reviewId,invoke,onStarted,onNavigate,service,models=[],refreshToken=0}) {
 const key=`reviewops.agent.followup.${reviewId}`;
 const [draft,setDraft]=useState(()=>stored(key)),[value,setValue]=useState({requests:[],predecessors:[]}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(null),[resolution,setResolution]=useState(null),[notice,setNotice]=useState('');
 const live=useRef(true),draftRef=useRef(draft);draftRef.current=draft;
 const saveLocal=next=>{const result=persistAgentDraft(localStorage,key,next);if(!result.saved)setError(t('초안을 이 기기에 저장하지 못했습니다. 입력한 내용은 이 화면에 유지됩니다.'));};
 const change=patch=>setDraft(current=>{const next={...current,...patch,requestId:null};draftRef.current=next;saveLocal(next);return next;});
 const load=async()=>{const result=await invoke('agent.request.list',{reviewId});if(live.current)setValue(result);return result;};
 useEffect(()=>{live.current=true;let timer;const poll=async()=>{try{await load()}catch(cause){if(live.current)setError(cause.message)}if(live.current)timer=setTimeout(poll,1500);};poll();return()=>{live.current=false;clearTimeout(timer);};},[reviewId,invoke,refreshToken]);
 const act=async(method,payload)=>{if(busy)return;setBusy(true);setError('');try{const result=await invoke(`agent.request.${method}`,payload);await load();return result;}catch(cause){if(live.current)setError(cause.message);return null;}finally{if(live.current)setBusy(false);}};
 const add=async event=>{
  event.preventDefault();if(busy||!draft.prompt?.trim())return;
  const sent=draftRef.current,requestId=sent.requestId||crypto.randomUUID(),next={...sent,requestId};draftRef.current=next;setDraft(next);saveLocal(next);
  const executionSettings=settingsFor(sent,service);
  const result=await act('add',{reviewId,prompt:sent.prompt,predecessorId:sent.predecessorId||'',requiredResult:sent.requiredResult||'',newConversation:Boolean(sent.newConversation),model:executionSettings.sent.model,reasoningEffort:executionSettings.sent.reasoningEffort,executionSettings,requestId});
  if(result){if(stored(key).requestId===requestId){draftRef.current={};setDraft({});saveLocal({});}setNotice(t('후속 요청을 저장했습니다. 실행 버튼을 누르면 시작합니다.'));}
 };
 const start=async row=>{const result=await act('start',{id:row.id});if(result)await onStarted?.(result);};
 const update=async event=>{event.preventDefault();const executionSettings=editing.executionSettings||settingsFor(editing,service);if(await act('update',{id:editing.id,prompt:editing.prompt,newConversation:editing.newConversation,model:executionSettings.sent.model,reasoningEffort:executionSettings.sent.reasoningEffort,executionSettings}))setEditing(null);};
 const resolve=async event=>{event.preventDefault();if(await act('resolve',resolution))setResolution(null);};
 const pending=value.requests.filter(row=>!['finished','cancelled'].includes(row.state));
 const editSettings=patch=>setEditing(current=>{
  const next=pendingSettingsForEdit(current.executionSettings||settingsFor(current,service),patch,{model:service?.agentModel||'',reasoningEffort:service?.agentReasoningEffort||''});
  return {...current,...patch,executionSettings:next};
 });
 const modelFields=(item,changeItem)=><div className="agent-followup-settings-fields"><label>{t('모델')}<select aria-label={t('후속 요청 모델')} value={item.model??''} onChange={event=>changeItem({model:event.target.value})}><option value="">{t('프로젝트 기본 모델')}</option>{item.model&&!models.some(model=>model.id===item.model)&&<option value={item.model}>{item.model}</option>}{models.map(model=><option key={model.id} value={model.id}>{model.label||model.id}</option>)}</select></label><label>{t('추론 수준')}<select aria-label={t('후속 요청 추론 수준')} value={item.reasoningEffort??''} onChange={event=>changeItem({reasoningEffort:event.target.value})}><option value="">{t('자동')}</option>{[...new Set([...reasoningOptions(models.find(model=>model.id===(item.model||service?.agentModel))),...(item.reasoningEffort?[item.reasoningEffort]:[])])].map(effort=><option key={effort} value={effort}>{effort}</option>)}</select></label><label className="agent-followup-conversation"><input type="checkbox" checked={Boolean(item.newConversation)} onChange={event=>changeItem({newConversation:event.target.checked})}/>{t('새 대화로 시작')}</label></div>;
 return <details className="agent-followups">
  <summary>{t('후속 요청 작성')}{pending.length>0?` · ${t('대기 {0}개',[pending.length])}`:''}</summary>
  <div className="agent-followups-body">
  <form onSubmit={add} className="agent-followup-form">
   <label>{t('후속 요청 내용')}<textarea aria-label={t('후속 요청 내용')} placeholder={t('다음에 실행할 요청을 입력하십시오.')} value={draft.prompt||''} maxLength={100000} onChange={event=>change({prompt:event.target.value})} onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form.requestSubmit();}}}/></label>
   <details className="agent-followup-settings"><summary>{t('더보기')} · {draft.newConversation?t('새 대화'):t('같은 대화')}</summary>{modelFields(draft,change)}
    <label>{t('먼저 끝나야 하는 실행')}<select aria-label={t('먼저 끝나야 하는 실행')} value={draft.predecessorId||''} onChange={event=>change({predecessorId:event.target.value})}><option value="">{t('선택하지 않음')}</option>{value.predecessors.map(run=><option key={run.id} value={run.id}>{run.title} · {run.prompt.slice(0,70)}</option>)}</select></label>
    <label>{t('실행에 필요한 결과')}<input aria-label={t('실행에 필요한 결과')} value={draft.requiredResult||''} maxLength={10000} placeholder={t('예: 수정한 화면과 테스트 결과')} onChange={event=>change({requiredResult:event.target.value})}/></label>
   </details><Button type="submit" disabled={busy||!draft.prompt?.trim()}>{t('대기 목록에 저장')}</Button>
  </form>
  {notice&&<p role="status">{notice}</p>}
  {value.requests.length>0&&<ol className="agent-followup-list" aria-label={t('후속 요청 목록')}>{value.requests.map(row=><li key={row.id}>
   <header><strong>{t(labels[row.state]||row.state)}</strong><span>{row.newConversation?t('새 대화'):t('같은 대화')}</span></header>
   <p className="agent-followup-prompt">{row.prompt}</p>{row.predecessorId&&<button type="button" className="agent-text-link agent-followup-predecessor" title={value.predecessors.find(item=>item.id===row.predecessorId)?.prompt||''} onClick={()=>onNavigate?.(row.predecessorId,value.predecessors.find(item=>item.id===row.predecessorId)?.reviewId)}><span>{t('기다리는 요청 · {0}',[(()=>{const previous=value.predecessors.find(item=>item.id===row.predecessorId);return previous?`${previous.title} · ${previous.prompt}`.slice(0,110):t('이전 요청');})()])}</span></button>}<p className="agent-model-summary">{row.settingsRecorded?`${row.model||t('자동')} · ${row.reasoningEffort||t('자동')}`:t('모델·추론 기록 없음')}</p>
   {row.state==='waiting'&&<p>{t(row.reason)}</p>}
   <div className="agent-response-actions">{row.state==='ready'&&<Button disabled={busy||!row.settingsRecorded} onClick={()=>start(row)}>{t('실행')}</Button>}{['waiting','ready'].includes(row.state)&&<><Button disabled={busy} onClick={()=>setEditing({...row,model:row.executionSettings?.selected?.model??row.model??'',reasoningEffort:row.executionSettings?.selected?.reasoningEffort??row.reasoningEffort??'',settingsEdited:!row.settingsRecorded})}>{t('수정')}</Button><Button disabled={busy} onClick={()=>act('cancel',{id:row.id})}>{t('대기 취소')}</Button>{row.requiredResult&&!row.resultConfirmed&&<Button disabled={busy||Boolean(row.predecessorId&&value.predecessors.find(run=>run.id===row.predecessorId)?.status!=='completed')} onClick={()=>act('confirmResult',{id:row.id})}>{t('필요한 결과가 준비됨')}</Button>}</>}{row.runId&&<Button onClick={()=>onNavigate?.(row.runId)}>{t('요청·응답으로 이동')}</Button>}</div>
   {!row.settingsRecorded&&['waiting','ready'].includes(row.state)&&<p>{t('설정 기록이 없습니다. 수정에서 모델과 추론 설정을 저장하십시오.')}</p>}
   {editing?.id===row.id&&<form className="agent-followup-form" onSubmit={update}><label>{t('후속 요청 내용')}<textarea required maxLength={100000} value={editing.prompt} onChange={event=>setEditing({...editing,prompt:event.target.value})}/></label>{modelFields(editing,editSettings)}<div className="agent-response-actions"><Button type="submit" disabled={busy}>{t('변경 저장')}</Button><Button type="button" disabled={busy} onClick={()=>setEditing(null)}>{t('취소')}</Button></div></form>}
   <details className="agent-followup-details"><summary>{t('상세 정보')}</summary>{row.settingsRecorded&&<table className="agent-settings-table"><thead><tr><th>{t('항목')}</th><th>{t('선택값')}</th><th>{t('전달값')}</th></tr></thead><tbody>{[['model',t('모델')],['reasoningEffort',t('추론 수준')]].map(([key,label])=><tr key={key}><th>{label}</th><td>{row.executionSettings?.automatic?.[key]?t('자동'):row.executionSettings?.selected?.[key]||t('기록 없음')}</td><td>{row.executionSettings?.sent?.[key]||t('자동')}</td></tr>)}</tbody></table>}<dl><dt>{t('요청 ID')}</dt><dd>{row.id}</dd><dt>{t('전달 상태')}</dt><dd>{row.delivery==='not_sent'?t('전달하지 않음'):t('후속 실행에 제출됨')}</dd>{row.predecessorId&&<><dt>{t('기다리는 실행')}</dt><dd><button type="button" onClick={()=>onNavigate?.(row.predecessorId,value.predecessors.find(item=>item.id===row.predecessorId)?.reviewId)}>{value.predecessors.find(item=>item.id===row.predecessorId)?.title||t('요청·응답으로 이동')}</button><br/>{row.predecessorId}</dd></>}{row.requiredResult&&<><dt>{t('필요한 결과')}</dt><dd>{row.requiredResult}{row.resultConfirmed?` · ${t('사용자 확인 완료')}`:''}</dd></>}{row.runId&&<><dt>{t('연결된 실행')}</dt><dd>{row.runId}</dd></>}</dl>
    {row.runId&&<p>{t('수신 여부는 제공되지 않습니다. 실행 완료만으로 요청이 반영되었다고 표시하지 않습니다.')}</p>}
    {row.resolution==='applied'?<p>{t('사용자가 반영 완료로 기록함')} · {row.resultVersion}{row.resultNote?` · ${row.resultNote}`:''}</p>:row.resolution==='deferred'?<p>{t('사용자가 보류로 기록함')} · {row.resultNote}</p>:row.state==='finished'?<p>{t('요청 반영 여부를 기록하지 않았습니다.')}</p>:null}
    {row.state==='finished'&&<Button disabled={busy} onClick={()=>setResolution({id:row.id,resolution:row.resolution==='pending'?'applied':row.resolution,resultVersion:row.resultVersion,resultNote:row.resultNote})}>{t('반영 여부 기록')}</Button>}
    {resolution?.id===row.id&&<form className="agent-followup-form" onSubmit={resolve}><label>{t('처리 결과')}<select value={resolution.resolution} onChange={event=>setResolution({...resolution,resolution:event.target.value})}><option value="applied">{t('반영 완료')}</option><option value="deferred">{t('보류')}</option></select></label>{resolution.resolution==='applied'&&<label>{t('결과 버전 또는 파일')}<input required maxLength={1000} value={resolution.resultVersion} onChange={event=>setResolution({...resolution,resultVersion:event.target.value})}/></label>}<label>{resolution.resolution==='deferred'?t('보류 이유'):t('처리 내용')}<textarea required={resolution.resolution==='deferred'} maxLength={10000} value={resolution.resultNote} onChange={event=>setResolution({...resolution,resultNote:event.target.value})}/></label><div className="agent-response-actions"><Button type="submit" disabled={busy}>{t('기록 저장')}</Button><Button type="button" disabled={busy} onClick={()=>setResolution(null)}>{t('취소')}</Button></div></form>}
   </details>{row.runError&&<p className="form-error" role="alert">{row.runError}</p>}
  </li>)}</ol>}{error&&<p className="form-error" role="alert">{error}</p>}
  </div>
 </details>;
}
