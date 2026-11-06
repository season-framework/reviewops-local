import React,{useEffect,useRef,useState} from 'react';
import Select from './Select.jsx';
import Icon from './icons.jsx';
import {t} from './i18n/index.js';
import {scheduleDraft,dirtySettings,errorText,outcomeKey} from './OpsState.mjs';
import {opsTime,OpsHistory} from './OpsConversation.jsx';
import {OpsPromptPreview} from './OpsPrompts.jsx';

export function OpsScheduleEditor({schedule,goalId,onSave,onCancel,onDirtyChange,pending=false,unavailable=false}){
 const [draft,setDraft]=useState(()=>scheduleDraft(schedule,goalId)),[error,setError]=useState(''),[conflict,setConflict]=useState(false),source=useRef(scheduleDraft(schedule,goalId)),callback=useRef(onDirtyChange);callback.current=onDirtyChange;
 const dirty=dirtySettings(draft,source.current),serialized=JSON.stringify(scheduleDraft(schedule,goalId));
 useEffect(()=>{const incoming=JSON.parse(serialized);if(dirtySettings(draft,source.current))setConflict(dirtySettings(incoming,source.current));else setDraft(incoming);source.current=incoming},[serialized]);
 useEffect(()=>{callback.current?.(dirty);return()=>callback.current?.(false)},[dirty]);
 const update=(key,value)=>{setDraft(current=>({...current,[key]:value}));setError('')};
 const zones=[...new Set([draft.timezone,'UTC','Asia/Seoul',...(Intl.supportedValuesOf?.('timeZone')||[])])];
 const submit=async event=>{event.preventDefault();setError('');try{await onSave({...draft,goalId})}catch(cause){setError(errorText(cause))}};
 return <form className="ops-editor" aria-label={schedule?t('예약 작업 수정'):t('예약 작업 추가')} onSubmit={submit}>
  {unavailable&&<p className="ops-inline-notice" role="alert">{t('이 예약이 삭제되었습니다. 작성 중인 입력은 보존하며 같은 예약으로 저장하지 않습니다.')}</p>}
  {conflict&&<div className="ops-inline-notice" role="alert"><p>{t('다른 실행에서 설정이 바뀌었습니다. 작성 중인 입력은 유지합니다.')}</p><button type="button" className="button" onClick={()=>{setDraft(source.current);setConflict(false)}}>{t('최신 값 불러오기')}</button></div>}
  <fieldset disabled={pending}><div className="ops-form-grid"><label className="ops-field ops-span"><span>{t('예약 작업 이름')}</span><input aria-label={t('예약 작업 이름')} value={draft.name} required maxLength={160} onChange={event=>update('name',event.target.value)}/></label><label className="ops-field"><span>{t('반복 일정 (cron)')}</span><input aria-label={t('반복 일정 (cron)')} className="ops-code-input" value={draft.cron} required placeholder="0 * * * *" onChange={event=>update('cron',event.target.value)}/><small>{t('예: 0 * * * * — 매시간 정각')}</small></label><label className="ops-field"><span>{t('시간대')}</span><Select aria-label={t('예약 시간대')} searchable allowCustom value={draft.timezone} onChange={event=>update('timezone',event.target.value)}>{zones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</Select></label><label className="ops-field ops-span"><span>{t('예약 작업 프롬프트')}</span><textarea aria-label={t('예약 작업 프롬프트')} rows={8} className="ops-prompt-input" value={draft.prompt} required onChange={event=>update('prompt',event.target.value)}/></label><label className="ops-checkbox ops-span"><input type="checkbox" checked={draft.enabled} onChange={event=>update('enabled',event.target.checked)}/><span>{t('예약 사용')}</span></label></div></fieldset>
  {error&&<p className="form-error" role="alert">{t(error)}</p>}<div className="ops-form-actions"><button type="button" className="button" onClick={onCancel}>{t('취소')}</button><button type="submit" className="button primary" disabled={pending||conflict||unavailable||Boolean(schedule)&&!dirty}>{pending?t('저장 중'):t('예약 저장')}</button></div>
 </form>;
}

export default function OpsSchedules({goal,state,bridge,invoke,onAdd,onEdit,onDelete,onToggle,pendingKeys=new Set()}){
 const [selected,setSelected]=useState(''),[error,setError]=useState(''),schedules=goal.schedules||[],schedule=schedules.find(row=>row.id===selected);
 const toggle=async row=>{setError('');try{await onToggle(row)}catch(cause){setError(errorText(cause))}};
 return <div className="ops-schedules-panel"><div className="ops-section-heading"><h3>{t('예약 작업')} <span className="ops-count">{schedules.length}</span></h3><button type="button" className="button primary" onClick={onAdd}><Icon name="plus" size={15}/>{t('예약 추가')}</button></div><p className="ops-muted">{t('목표가 일시정지되거나 종료되면 예약으로 자동 시작하지 않습니다.')}</p>{error&&<p className="form-error" role="alert">{t(error)}</p>}
  {schedules.length?<ul className="ops-schedule-list">{schedules.map(row=><li key={row.id} className={selected===row.id?'selected':''}><div className="ops-schedule-title"><button type="button" aria-expanded={selected===row.id} onClick={()=>setSelected(selected===row.id?'':row.id)}><Icon name="clock" size={16}/><strong>{row.name}</strong></button><label className="ops-checkbox"><input type="checkbox" aria-label={t('{0} 예약 사용',[row.name])} checked={row.enabled} disabled={pendingKeys.has(`schedule:${row.id}`)} onChange={()=>toggle(row)}/><span>{row.enabled?t('사용 중'):t('사용 중지')}</span></label></div><div className="ops-schedule-summary"><code>{row.cron}</code><span>{row.timezone}</span><span>{t('다음 예약')}: {row.enabled?opsTime(row.nextRunAt,row.timezone):'—'}</span><span>{t('최근 실행')}: {opsTime(row.lastRunAt,row.timezone)}</span><span>{t('최근 결과')}: {typeof row.lastResult==='object'?errorText(row.lastResult)||t(outcomeKey(row.lastResult?.status)):t(outcomeKey(row.lastResult))}</span></div><div className="ops-row-actions"><button type="button" className="button" onClick={()=>onEdit(row)}>{t('수정')}</button><button type="button" className="button danger-text" disabled={pendingKeys.has(`schedule:${row.id}`)} onClick={()=>onDelete(row)}>{t('삭제')}</button></div></li>)}</ul>:<div className="ops-empty-block"><Icon name="clock" size={25}/><p>{t('등록된 예약 작업이 없습니다.')}</p></div>}
  {schedule&&<section className="ops-schedule-detail" aria-label={t('{0} 예약 상세',[schedule.name])}><h3>{schedule.name}</h3><label className="ops-field"><span>{t('저장된 예약 프롬프트')}</span><pre className="ops-prompt-preview">{schedule.prompt}</pre></label><OpsPromptPreview goal={goal} bridge={bridge} revision={state.revision} scheduleId={schedule.id} fixedSchedule/><OpsHistory history={goal.history} scheduleId={schedule.id} invoke={invoke} onError={setError}/></section>}
 </div>;
}
