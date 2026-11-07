import React,{useEffect,useRef,useState} from 'react';
import Select from './Select.jsx';
import {t} from './i18n/index.js';
import {goalDraft,dirtySettings,errorText} from './OpsState.mjs';
import {availableModels,defaultReasoning,reasoningOptions,environmentTarget} from './agent-models.mjs';
import OpsMarkdownEditor from './OpsMarkdownEditor.jsx';

export default function OpsGoalEditor({goal,projects=[],services=[],invoke,onSave,onCancel,onDirtyChange,pending=false}){
 const [draft,setDraft]=useState(()=>goalDraft(goal)),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[environment,setEnvironment]=useState(null),[modelError,setModelError]=useState(''),[loadingModels,setLoadingModels]=useState(false);
 const source=useRef(goalDraft(goal)),dirty=dirtySettings(draft,source.current),dirtyCallback=useRef(onDirtyChange);dirtyCallback.current=onDirtyChange;
 const serialized=JSON.stringify(goalDraft(goal));
 useEffect(()=>{const incoming=JSON.parse(serialized);if(dirtySettings(draft,source.current))setConflict(dirtySettings(incoming,source.current));else{setDraft(incoming);setConflict(false)}source.current=incoming},[serialized]);
 useEffect(()=>{dirtyCallback.current?.(dirty);return()=>dirtyCallback.current?.(false)},[dirty]);
 const project=projects.find(row=>row.id===draft.projectId),connections=services.filter(row=>project?.serviceIds?.includes(row.id)),connection=connections.find(row=>row.id===draft.serviceId)||(connections.length===1?connections[0]:null),target=environmentTarget(connection);
 useEffect(()=>{
  let live=true;setEnvironment(null);setModelError('');
  if(!connection?.id){setLoadingModels(false);return()=>{live=false}}
  setLoadingModels(true);
  Promise.resolve(invoke('agent.models',{serviceId:connection.id})).then(value=>{if(live)setEnvironment(value)}).catch(cause=>{if(live)setModelError(errorText(cause))}).finally(()=>{if(live)setLoadingModels(false)});
  return()=>{live=false};
 },[target,invoke]);
 const models=availableModels(environment,connection?.agentModels||[]),selectedModel=models.find(row=>row.id===(draft.model||environment?.defaultModel)),efforts=reasoningOptions(selectedModel),legacyFolder=Boolean(goal&&!draft.projectId&&draft.workPath);
 const update=(key,value)=>{setDraft(current=>({...current,[key]:value}));setError('')};
 const selectProject=id=>{const selected=projects.find(row=>row.id===id),ids=selected?.serviceIds||[],serviceId=ids.includes(selected?.connection?.id)?selected.connection.id:ids[0]||'';setDraft(current=>({...current,projectId:id,serviceId,workPath:id?'':current.workPath}));setError('')};
 const submit=async event=>{event.preventDefault();setError('');if(conflict){setError(t('다른 실행에서 설정이 바뀌었습니다. 최신 값을 불러온 뒤 다시 수정하십시오.'));return}try{const saved=await onSave({...draft,workPath:draft.projectId?'':draft.workPath,sandboxMode:'danger-full-access',approvalPolicy:'never'});if(saved){source.current=goalDraft(saved);setDraft(source.current)}}catch(cause){setError(errorText(cause))}};
 const reload=()=>{setDraft(source.current);setConflict(false);setError('')};
 return <form className="ops-editor" aria-label={goal?t('목표 설정'):t('새 목표')} onSubmit={submit}>
  {conflict&&<div className="ops-inline-notice" role="alert"><p>{t('다른 실행에서 설정이 바뀌었습니다. 작성 중인 입력은 유지합니다.')}</p><button className="button" type="button" onClick={reload}>{t('최신 값 불러오기')}</button></div>}
  <fieldset disabled={pending}><div className="ops-form-grid">
   <label className="ops-field ops-span"><span>{t('목표 이름')}</span><input aria-label={t('목표 이름')} value={draft.name} maxLength={160} required onChange={event=>update('name',event.target.value)}/></label>
   <label className="ops-field ops-span"><span>{t('대상 프로젝트')}</span><Select searchable aria-label={t('대상 프로젝트')} value={draft.projectId} onChange={event=>selectProject(event.target.value)} required={!legacyFolder}><option value="">{legacyFolder?t('기존 작업 대상 유지'):t('프로젝트 선택')}</option>{projects.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</Select></label>
   {connections.length>1&&<label className="ops-field ops-span"><span>{t('프로젝트 연결')}</span><Select searchable aria-label={t('프로젝트 연결')} value={draft.serviceId} required onChange={event=>update('serviceId',event.target.value)}><option value="">{t('연결 선택')}</option>{connections.map(row=><option key={row.id} value={row.id}>{row.name||row.host||row.id}</option>)}</Select></label>}
   <label className="ops-field"><span>{t('Codex 모델')}</span><Select searchable aria-label={t('Codex 모델')} value={draft.model} disabled={loadingModels} onChange={event=>{const value=event.target.value;setDraft(current=>({...current,model:value,reasoningEffort:value?defaultReasoning(models.find(row=>row.id===value)):''}));setError('')}}><option value="">{loadingModels?t('모델 불러오는 중'):environment?.defaultModel?t('호스트 기본 모델 · {0}',[environment.defaultModel]):t('Codex 기본값 사용')}</option>{draft.model&&!models.some(row=>row.id===draft.model)&&<option value={draft.model}>{draft.model} · {t('저장된 모델')}</option>}{models.map(row=><option key={row.id} value={row.id}>{row.label||row.displayName||row.id}</option>)}</Select>{modelError&&<small className="form-error" role="status">{modelError}</small>}</label>
   <label className="ops-field"><span>{t('추론 수준')}</span><Select aria-label={t('추론 수준')} searchable={false} value={draft.reasoningEffort} onChange={event=>update('reasoningEffort',event.target.value)}><option value="">{t('Codex 기본값 사용')}</option>{draft.reasoningEffort&&!efforts.includes(draft.reasoningEffort)&&<option value={draft.reasoningEffort}>{draft.reasoningEffort}</option>}{efforts.map(value=><option key={value} value={value}>{value}</option>)}</Select></label>
   <div className="ops-field ops-span"><span>{t('목표 프롬프트')}</span><OpsMarkdownEditor value={draft.prompt} onChange={value=>update('prompt',value)} disabled={pending}/></div>
  </div></fieldset>
  {error&&<p className="form-error" role="alert">{t(error)}</p>}
  <div className="ops-form-actions">{onCancel&&<button type="button" className="button" onClick={onCancel}>{t('취소')}</button>}<button type="submit" className="button primary" disabled={pending||conflict||!draft.prompt.trim()||Boolean(goal)&&!dirty}>{pending?t('저장 중'):t('목표 저장')}</button></div>
 </form>;
}
