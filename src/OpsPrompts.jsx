import React,{useEffect,useRef,useState} from 'react';
import Select from './Select.jsx';
import {t} from './i18n/index.js';
import {errorText} from './OpsState.mjs';
import {opsTime} from './OpsConversation.jsx';
const layerName=name=>({common:t('공통 실행 지침'),goal:t('목표 프롬프트'),schedule:t('예약 작업 프롬프트'),request:t('사용자 요청'),context:t('목표 진행 내용과 실행 사유')}[name]||name);

export function OpsPromptPreview({goal,bridge,revision,scheduleId='',fixedSchedule=false}){
 const [selected,setSelected]=useState(scheduleId),[reason,setReason]=useState(''),[instruction,setInstruction]=useState(''),[preview,setPreview]=useState(null),[sourceRevision,setSourceRevision]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState(false),[requestedAt,setRequestedAt]=useState('');
 const request=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current++}},[]);
 useEffect(()=>{setSelected(scheduleId);setPreview(null);setSourceRevision(null);setError('');setPending(false);request.current++},[goal.id,scheduleId]);
 useEffect(()=>{if(selected&&!goal.schedules?.some(schedule=>schedule.id===selected)){setSelected('');setPreview(null);setSourceRevision(null)}},[selected,goal.schedules]);
 const load=async()=>{const id=++request.current;setPending(true);setError('');try{const result=await bridge.preview({goalId:goal.id,...(selected?{scheduleId:selected}:{}),...(reason.trim()?{reason}:{}),...(instruction.trim()?{instruction}:{})});if(mounted.current&&id===request.current){setPreview(result);setSourceRevision(revision);setRequestedAt(new Date().toISOString())}}catch(cause){if(mounted.current&&id===request.current)setError(errorText(cause))}finally{if(mounted.current&&id===request.current)setPending(false)}};
 const change=(setter,value)=>{setter(value);request.current++;setPreview(null);setSourceRevision(null);setPending(false)};
 return <section className="ops-preview" aria-label={t('조립된 프롬프트 미리보기')}><div className="ops-section-heading"><h3>{t('조립된 프롬프트 미리보기')}</h3><button type="button" className="button" disabled={pending||!bridge} onClick={load}>{pending?t('불러오는 중'):t('미리보기 갱신')}</button></div><p className="ops-muted">{t('저장된 지침과 현재 진행 내용을 사용해 실행·추가 지시의 전체 프롬프트를 조립합니다. 이 미리보기는 작업을 실행하지 않습니다.')}</p>
  {!fixedSchedule&&<label className="ops-field"><span>{t('미리볼 예약 작업')}</span><Select aria-label={t('미리볼 예약 작업')} value={selected} onChange={event=>change(setSelected,event.target.value)}><option value="">{t('예약 없는 실행')}</option>{(goal.schedules||[]).map(schedule=><option key={schedule.id} value={schedule.id}>{schedule.name}</option>)}</Select></label>}
  <div className="ops-form-grid"><label className="ops-field"><span>{t('미리보기 실행 사유')}</span><input aria-label={t('미리보기 실행 사유')} value={reason} onChange={event=>change(setReason,event.target.value)} placeholder={t('저장된 실행 사유 사용')}/></label><label className="ops-field"><span>{t('미리보기 추가 요청')}</span><input aria-label={t('미리보기 추가 요청')} value={instruction} onChange={event=>change(setInstruction,event.target.value)}/></label></div>
  {error&&<p className="form-error" role="alert">{t(error)}</p>}
  {preview&&<><p className="ops-muted">{t('미리보기 시각')}: {opsTime(requestedAt)}</p>{sourceRevision!==revision&&<p className="ops-inline-notice" role="status">{t('설정이나 진행 내용이 바뀌었습니다. 미리보기를 갱신하면 최신 내용을 볼 수 있습니다.')}</p>}<ol className="ops-prompt-layers" aria-label={t('프롬프트 적용 순서')}>{(preview.layers||[]).map((layer,index)=><li key={`${layer.name}-${index}`}><details><summary><span>{index+1}. {layerName(layer.name)}</span></summary><pre className="ops-prompt-preview">{layer.content||t('내용 없음')}</pre></details></li>)}</ol><details className="ops-complete-prompt" open><summary>{t('조립된 전체 프롬프트')}</summary><pre className="ops-prompt-preview" aria-label={t('조립된 전체 프롬프트')}>{preview.prompt}</pre></details></>}
 </section>;
}

export function OpsCommonPromptEditor({value='',onSave,onDirtyChange,pending=false}){
 const [draft,setDraft]=useState(value),[error,setError]=useState(''),[conflict,setConflict]=useState(false),source=useRef(value),callback=useRef(onDirtyChange);callback.current=onDirtyChange;
 const dirty=draft!==source.current;
 useEffect(()=>{if(draft!==source.current)setConflict(value!==source.current);else setDraft(value);source.current=value},[value]);
 useEffect(()=>{callback.current?.(dirty);return()=>callback.current?.(false)},[dirty]);
 const submit=async event=>{event.preventDefault();setError('');try{const result=await onSave(draft);source.current=result.commonPrompt;setDraft(result.commonPrompt);setConflict(false)}catch(cause){setError(errorText(cause))}};
 return <form className="ops-common-editor" aria-label={t('공통 실행 지침 설정')} onSubmit={submit}><p className="ops-muted">{t('모든 목표의 실행과 추가 지시에 적용할 공통 지침입니다. 목표와 예약의 지시는 각 항목에서 저장합니다.')}</p>{conflict&&<div className="ops-inline-notice" role="alert"><p>{t('다른 실행에서 설정이 바뀌었습니다. 작성 중인 입력은 유지합니다.')}</p><button className="button" type="button" onClick={()=>{setDraft(value);source.current=value;setConflict(false)}}>{t('최신 값 불러오기')}</button></div>}<label className="ops-field"><span>{t('공통 실행 지침')}</span><textarea aria-label={t('공통 실행 지침')} rows={12} className="ops-prompt-input" value={draft} onChange={event=>setDraft(event.target.value)} disabled={pending}/></label>{error&&<p className="form-error" role="alert">{t(error)}</p>}<div className="ops-form-actions"><button type="submit" className="button primary" disabled={pending||!dirty||conflict}>{pending?t('저장 중'):t('공통 지침 저장')}</button></div></form>;
}

export default function OpsPrompts({goal,state,bridge,onEditGoal,onCommonSettings}){
 return <div className="ops-prompts-panel"><section className="ops-saved-prompts"><h3>{t('저장된 프롬프트')}</h3><details><summary>{t('공통 실행 지침')}</summary><pre className="ops-prompt-preview">{state.commonPrompt||t('내용 없음')}</pre><button type="button" className="button" onClick={onCommonSettings}>{t('공통 지침 수정')}</button></details><details><summary>{t('목표 프롬프트')}</summary><pre className="ops-prompt-preview">{goal.prompt||t('내용 없음')}</pre><button type="button" className="button" onClick={onEditGoal}>{t('목표 설정 열기')}</button></details></section><OpsPromptPreview goal={goal} bridge={bridge} revision={state.revision}/></div>;
}
