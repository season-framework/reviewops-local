import React,{useEffect,useRef,useState} from 'react';
import Select from './Select.jsx';
import Icon from './icons.jsx';
import {t} from './i18n/index.js';
import {goalDraft,dirtySettings,errorText} from './OpsState.mjs';

export default function OpsGoalEditor({goal,projects=[],services=[],invoke,onSave,onCancel,onDirtyChange,pending=false}){
 const [draft,setDraft]=useState(()=>goalDraft(goal)),[mode,setMode]=useState(goal?.projectId?'project':'folder'),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[choosing,setChoosing]=useState(false);
 const source=useRef(goalDraft(goal)),sourceMode=useRef(goal?.projectId?'project':'folder'),dirty=dirtySettings(draft,source.current)||mode!==sourceMode.current,dirtyCallback=useRef(onDirtyChange);dirtyCallback.current=onDirtyChange;
 const serialized=JSON.stringify(goalDraft(goal));
 useEffect(()=>{const incoming=JSON.parse(serialized);if(dirtySettings(draft,source.current)||mode!==sourceMode.current)setConflict(dirtySettings(incoming,source.current));else{setDraft(incoming);setMode(incoming.projectId?'project':'folder');setConflict(false)}source.current=incoming;sourceMode.current=incoming.projectId?'project':'folder'},[serialized]);
 useEffect(()=>{dirtyCallback.current?.(dirty);return()=>dirtyCallback.current?.(false)},[dirty]);
 const project=projects.find(row=>row.id===draft.projectId),connections=services.filter(row=>project?.serviceIds?.includes(row.id)),connection=connections.find(row=>row.id===draft.serviceId)||(connections.length===1?connections[0]:null);
 const update=(key,value)=>{setDraft(current=>({...current,[key]:value}));setError('')};
 const choose=async()=>{setChoosing(true);setError('');try{const path=await invoke('dialog.directory');if(path)update('workPath',path)}catch(cause){setError(errorText(cause))}finally{setChoosing(false)}};
 const submit=async event=>{event.preventDefault();setError('');if(conflict){setError(t('다른 실행에서 설정이 바뀌었습니다. 최신 값을 불러온 뒤 다시 수정하십시오.'));return}try{const saved=await onSave({...draft,projectId:mode==='project'?draft.projectId:'',serviceId:mode==='project'?draft.serviceId:null,workPath:mode==='folder'?draft.workPath:''});if(saved){source.current=goalDraft(saved);sourceMode.current=saved.projectId?'project':'folder';setDraft(source.current);setMode(sourceMode.current)}}catch(cause){setError(errorText(cause))}};
 const reload=()=>{setDraft(source.current);setMode(source.current.projectId?'project':'folder');setConflict(false);setError('')};
 return <form className="ops-editor" aria-label={goal?t('목표 설정'):t('새 목표')} onSubmit={submit}>
  {conflict&&<div className="ops-inline-notice" role="alert"><p>{t('다른 실행에서 설정이 바뀌었습니다. 작성 중인 입력은 유지합니다.')}</p><button className="button" type="button" onClick={reload}>{t('최신 값 불러오기')}</button></div>}
  <fieldset disabled={pending}><div className="ops-form-grid">
   <label className="ops-field ops-span"><span>{t('목표 이름')}</span><input aria-label={t('목표 이름')} value={draft.name} maxLength={160} required onChange={event=>update('name',event.target.value)}/></label>
   <label className="ops-field ops-span"><span>{t('목표 설명')}</span><textarea aria-label={t('목표 설명')} rows={3} value={draft.description} onChange={event=>update('description',event.target.value)}/></label>
   <label className="ops-field ops-span"><span>{t('작업 대상 선택')}</span><Select searchable={false} aria-label={t('작업 대상 선택')} value={mode} onChange={event=>{setMode(event.target.value);setError('')}}><option value="project">{t('등록된 프로젝트')}</option><option value="folder">{t('로컬 폴더')}</option></Select></label>
   {mode==='project'?<label className="ops-field ops-span"><span>{t('대상 프로젝트')}</span><Select aria-label={t('대상 프로젝트')} value={draft.projectId} onChange={event=>{setDraft(current=>({...current,projectId:event.target.value,serviceId:''}));setError('')}} required><option value="">{t('프로젝트 선택')}</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</Select><small>{t('프로젝트에 등록된 연결과 작업 폴더를 사용합니다.')}</small></label>:<label className="ops-field ops-span"><span>{t('대상 폴더')}</span><div className="ops-input-action"><input aria-label={t('대상 폴더')} value={draft.workPath} required placeholder={t('로컬 폴더의 전체 경로')} onChange={event=>update('workPath',event.target.value)}/><button type="button" className="button" disabled={choosing} onClick={choose}><Icon name="folder" size={15}/>{t('폴더 선택')}</button></div></label>}
   {mode==='project'&&connections.length>1&&<label className="ops-field ops-span"><span>{t('프로젝트 연결')}</span><Select aria-label={t('프로젝트 연결')} value={draft.serviceId} required onChange={event=>update('serviceId',event.target.value)}><option value="">{t('연결 선택')}</option>{connections.map(row=><option key={row.id} value={row.id}>{row.type==='ssh'?'SSH':t('로컬')} · {row.name||row.host||row.id}</option>)}</Select></label>}
   {mode==='project'&&connection&&<div className="ops-field ops-span"><span>{connection.type==='ssh'?t('SSH 작업 폴더'):t('프로젝트 작업 폴더')}</span><code className="ops-target-path">{connection.agentWorkPath||connection.rootPath||'—'}</code></div>}
   <label className="ops-field"><span>{t('Codex 모델')}</span><input aria-label={t('Codex 모델')} value={draft.model} placeholder={t('Codex 기본값 사용')} onChange={event=>update('model',event.target.value)}/></label>
   <label className="ops-field"><span>{t('추론 수준')}</span><Select aria-label={t('추론 수준')} searchable={false} value={draft.reasoningEffort} onChange={event=>update('reasoningEffort',event.target.value)}><option value="">{t('Codex 기본값 사용')}</option>{['none','minimal','low','medium','high','xhigh','max','ultra'].map(value=><option key={value} value={value}>{value}</option>)}</Select></label>
   <label className="ops-field"><span>{t('파일 접근 범위')}</span><Select aria-label={t('파일 접근 범위')} searchable={false} value={draft.sandboxMode} onChange={event=>update('sandboxMode',event.target.value)}><option value="read-only">{t('읽기 전용')}</option><option value="workspace-write">{t('작업 폴더 쓰기')}</option><option value="danger-full-access">{t('전체 접근')}</option></Select></label>
   <label className="ops-field"><span>{t('실행 승인 정책')}</span><Select aria-label={t('실행 승인 정책')} searchable={false} value={draft.approvalPolicy} onChange={event=>update('approvalPolicy',event.target.value)}>{['never','untrusted','on-failure','on-request'].map(value=><option key={value} value={value}>{value}</option>)}</Select>{draft.approvalPolicy!=='never'&&<small>{t('Ops에는 대화형 승인 창이 없어, 승인이 필요한 요청은 실패로 표시됩니다.')}</small>}</label>
   <label className="ops-field ops-span"><span>{t('목표 프롬프트')}</span><textarea aria-label={t('목표 프롬프트')} className="ops-prompt-input" rows={9} required value={draft.prompt} onChange={event=>update('prompt',event.target.value)}/></label>
  </div></fieldset>
  {error&&<p className="form-error" role="alert">{t(error)}</p>}
  <div className="ops-form-actions">{onCancel&&<button type="button" className="button" onClick={onCancel}>{t('취소')}</button>}<button type="submit" className="button primary" disabled={pending||conflict||Boolean(goal)&&!dirty}>{pending?t('저장 중'):t('목표 저장')}</button></div>
 </form>;
}
