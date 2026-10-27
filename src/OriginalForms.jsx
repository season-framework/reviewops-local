import {t,localized} from './i18n/index.js';
import Select from './Select.jsx';
import React, {useEffect, useRef, useState} from 'react';
import Icon from './icons.jsx';
import LocalFolderField from './LocalFolderField.jsx';
import {Button, Dialog, Field, invoke} from './components.jsx';
import './original-forms.css';

const STATUS_OPTIONS = localized([['active','활성'],['archived','보관'],['disabled','비활성']]);
export const PROJECT_CONNECTION_DEFAULTS = {kind:'local',hostAlias:'',rootPath:'',viewerUrl:'',viewerWidth:1920,viewerHeight:1080,viewerScale:'fit',agentEnabled:1,agentBinary:'codex',agentWorkPath:'',agentModel:'',agentReasoningEffort:'',agentInstructions:'',agentModels:[]};
export const projectConnection = (project,data={}) => project?.connection || data.services?.find(item=>project?.serviceIds?.includes(item.id)) || null;
export const connectionLabel = connection => !connection ? t("작업 폴더 미설정") : connection.kind==='ssh' ? `SSH · ${connection.hostAlias||connection.host||t("호스트 미선택")}` : t("로컬 폴더");
function useDraft(initial,onDirtyChange,pendingInput='',revision) {
 const [form,setForm]=useState(initial),[saved,setSaved]=useState(initial);
 const [conflicts,setConflicts]=useState([]);
 const previousSaved=useRef(initial);
 const callback=useRef(onDirtyChange);callback.current=onDirtyChange;
 useEffect(()=>{
  if(revision===undefined)return;
  const previous=previousSaved.current;
  setConflicts(existing=>[...new Set([...existing,...Object.keys(initial).filter(key=>JSON.stringify(form[key])!==JSON.stringify(previous[key])&&JSON.stringify(initial[key])!==JSON.stringify(previous[key])&&JSON.stringify(form[key])!==JSON.stringify(initial[key]))])].filter(key=>JSON.stringify(form[key])!==JSON.stringify(initial[key])));
  setForm(current=>Object.fromEntries([...new Set([...Object.keys(current),...Object.keys(initial)])].map(key=>[key,JSON.stringify(current[key])===JSON.stringify(previous[key])?initial[key]:current[key]])));
  setSaved(initial);previousSaved.current=initial;
 },[revision]);
 const dirty=[...new Set([...Object.keys(form),...Object.keys(saved)])].some(key=>JSON.stringify(form[key])!==JSON.stringify(saved[key]))||Boolean(pendingInput.trim());
 useEffect(()=>{callback.current?.(dirty);return()=>callback.current?.(false)},[dirty]);
 useEffect(()=>{if(!dirty)return;const guard=event=>{event.preventDefault();event.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[dirty]);
 const set=(key,value)=>{setForm(previous=>({...previous,[key]:value}));setConflicts(previous=>previous.filter(item=>item!==key))};
 const savedAs=value=>{setForm(value);setSaved(value);previousSaved.current=value;setConflicts([])};
 return {form,setForm,set,savedAs,dirty,conflicts,keepChanges:()=>setConflicts([])};
}
export function FormSection({title,description,children,actions,className=''}) {
 return <section className={`original-form-section ${className}`} aria-label={title}><header><div><h2>{title}</h2>{description&&<p>{description}</p>}</div>{actions}</header><div className="original-form-section-body">{children}</div></section>;
}
export function LabelsField({value=[],onChange,disabled=false,draft,onDraftChange}) {
 const [internalInput,setInternalInput]=useState('');const input=draft??internalInput,setInput=onDraftChange||setInternalInput;
 const add=()=>{const values=input.split(/[,\n]/).map(v=>v.trim().replace(/^#+/,'')).filter(Boolean);if(values.length)onChange([...new Set([...value,...values])]);setInput('')};
 return <div className="original-label-field"><span>{t("라벨")}</span><div className="original-label-editor">{value.map(item=><span className="original-label-chip" key={item}><span>#{item}</span><button type="button" disabled={disabled} aria-label={t("{0} 라벨 삭제",[item])} onClick={()=>onChange(value.filter(label=>label!==item))}><Icon name="close" size={12}/></button></span>)}<input aria-label={t("라벨")} value={input} disabled={disabled} placeholder={t("라벨 입력 후 Enter")} onChange={event=>setInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();add()}}}/><Button type="button" disabled={disabled||!input.trim()} onClick={add}>{t("추가")}</Button></div></div>;
}
export function OperationalStatusField({value='active',onChange,disabled=false}) {
 return <div className="original-status-field"><span>{t("운영 상태")}</span><div role="group" aria-label={t("운영 상태")}>{STATUS_OPTIONS.map(([key,label])=><button type="button" key={key} disabled={disabled} aria-pressed={value===key} className={value===key?'active':''} onClick={()=>onChange(key)}>{label}</button>)}</div></div>;
}
export function ProjectConnectionFields({form,set,busy=false,setError=()=>{},onOpenHosts}) {
 const [hosts,setHosts]=useState([]),[loading,setLoading]=useState(true),[hostError,setHostError]=useState('');
 useEffect(()=>{let live=true;const apply=value=>{if(live){setHosts(value?.hosts||[]);setLoading(false)}};const bridge=window.hostManager;if(!bridge){setLoading(false);setHostError(t("호스트 관리를 불러올 수 없습니다."));return}Promise.resolve(bridge.getState()).then(apply).catch(error=>{if(live){setHostError(error.message);setLoading(false)}});const unsubscribe=bridge.onState?.(apply);return()=>{live=false;unsubscribe?.()}},[]);
 const available=hosts.filter(host=>host.connectable!==false);
 const selected=available.find(host=>host.alias===form.hostAlias);
 const legacy=Boolean(form.id&&form.host&&!form.hostAlias);
 return <div className="project-connection-fields"><Field label={t("접속 방식")}><Select searchable={false} aria-label={t("접속 방식")} value={form.kind||'local'} disabled={busy} onChange={event=>set('kind',event.target.value)}><option value="local">{t("로컬 폴더")}</option><option value="ssh">{t("SSH 호스트")}</option></Select></Field>{form.kind==='ssh'&&<><Field label={t("SSH 호스트")} hint={t("호스트 관리에 등록된 접속 설정을 사용합니다.")}><div className="input-action"><Select searchable aria-label={t("SSH 호스트")} value={form.hostAlias||''} disabled={busy||loading} required={!legacy} onChange={event=>set('hostAlias',event.target.value)}><option value="">{legacy?t("기존 연결 · {0}{1}",[form.username?`${form.username}@`:'',form.host]):loading?t("호스트 불러오는 중"):t("호스트 선택")}</option>{form.hostAlias&&!selected&&<option value={form.hostAlias}>{form.hostAlias}{" "+t("(등록된 호스트 없음)")}</option>}{available.map(host=><option key={host.id||host.alias} value={host.alias}>{host.alias}{host.hostName&&host.hostName!==host.alias?` · ${host.hostName}`:''}</option>)}</Select>{onOpenHosts&&<Button type="button" onClick={onOpenHosts}>{t("SSH 호스트 관리")}</Button>}</div></Field>{!loading&&!available.length&&<p className="original-form-help">{t("호스트 관리에서 SSH 호스트를 추가하십시오.")}</p>}{hostError&&<p className="form-error" role="alert">{hostError}</p>}</>}{form.kind==='ssh'?<Field label={t("서버 작업 폴더")} hint={t("선택한 호스트에서 사용할 폴더를 입력합니다.")}><input aria-label={t("서버 작업 폴더")} value={form.rootPath||''} disabled={busy} required placeholder="/opt/project" onChange={event=>set('rootPath',event.target.value)}/></Field>:<LocalFolderField label={t("로컬 폴더")} value={form.rootPath||''} disabled={busy} required onChange={value=>set('rootPath',value)}/>}</div>;
}
export function ViewerFields({form,set}) {
 return <><Field label={t("뷰어 URL")}><input aria-label={t("뷰어 URL")} type="url" value={form.viewerUrl||''} placeholder={t("https:// 또는 http://localhost:3000")} onChange={event=>set('viewerUrl',event.target.value)}/></Field><Field label={t("화면 너비")}><input aria-label={t("화면 너비")} type="number" min={240} max={7680} value={form.viewerWidth??1920} onChange={event=>set('viewerWidth',event.target.value===''?'':Number(event.target.value))}/></Field><Field label={t("화면 높이")}><input aria-label={t("화면 높이")} type="number" min={240} max={7680} value={form.viewerHeight??1080} onChange={event=>set('viewerHeight',event.target.value===''?'':Number(event.target.value))}/></Field><Field label={t("기본 배율")}><Select searchable={false} aria-label={t("기본 배율")} value={form.viewerScale||'fit'} onChange={event=>set('viewerScale',event.target.value)}>{[['fit',t("맞춤")],['50','50%'],['75','75%'],['100','100%'],['125','125%'],['150','150%'],['200','200%']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select></Field></>;
}
export function validateProjectConnection(connection) {if(!connection.rootPath?.trim())return connection.kind==='ssh'?t("서버 작업 폴더를 입력하십시오."):t("로컬 폴더를 선택하십시오.");if(connection.kind==='ssh'&&!connection.hostAlias?.trim()&&!(connection.id&&connection.host))return t("SSH 호스트를 선택하십시오.");return '';}
export function RegistrationScreen({record={},data,busy=false,onClose,onSave,onDirtyChange,onOpenHosts}) {
 const initial=useRef({name:'',description:'',groupId:data.groups[0]?.id||'',...record,connection:{...PROJECT_CONNECTION_DEFAULTS,...record.connection}}).current;
 const {form,set,dirty}=useDraft(initial,onDirtyChange),[error,setError]=useState(''),[discard,setDiscard]=useState(false);
 const group=data.groups.find(group=>group.id===form.groupId);
 const close=()=>dirty?setDiscard(true):onClose();
 const setConnection=(key,value)=>set('connection',{...form.connection,[key]:value});
 const submit=async event=>{event.preventDefault();const nextError=!form.name.trim()?t("프로젝트명을 입력하십시오."):validateProjectConnection(form.connection);setError(nextError);if(nextError)return;try{await onSave({name:form.name.trim(),description:form.description,groupId:form.groupId,connection:form.connection})}catch(error){setError(error.message)}};
 return <section className="original-registration" role="region" aria-label={t("프로젝트 등록")}><header className="original-registration-header"><button className="icon-button" aria-label={t("그룹으로 돌아가기")} onClick={close}><Icon name="back"/></button><div><h1>{t("프로젝트 등록")}</h1><p>{group?.name||''}</p></div></header><main className="original-registration-scroll"><form className="original-registration-form" onSubmit={submit}><fieldset disabled={busy}><FormSection title={t("프로젝트 기본 정보")} description={t("프로젝트의 이름과 목적을 입력합니다.")}><Field label={t("프로젝트명")}><input aria-label={t("프로젝트명")} autoFocus required maxLength={120} value={form.name} onChange={event=>set('name',event.target.value)}/></Field><Field label={t("설명")}><textarea aria-label={t("설명")} rows={3} value={form.description} onChange={event=>set('description',event.target.value)}/></Field></FormSection><FormSection title={t("프로젝트 연결")} description={t("이 Mac의 폴더 또는 SSH 호스트의 작업 폴더를 선택합니다.")}><ProjectConnectionFields form={form.connection} set={setConnection} busy={busy} setError={setError} onOpenHosts={onOpenHosts}/></FormSection><FormSection title={t("뷰어 설정")} description={t("검토할 주소와 화면 크기를 설정합니다.")}><ViewerFields form={form.connection} set={setConnection}/></FormSection>{error&&<div className="form-error" role="alert">{error}</div>}<footer className="original-creation-actions"><Button type="button" onClick={close}>{t("취소")}</Button><Button type="submit" variant="primary" disabled={busy}>{busy?t("등록 중"):t("프로젝트 등록")}</Button></footer></fieldset></form></main>{discard&&<Dialog title={t("작성 중인 내용")} onClose={()=>setDiscard(false)} footer={<><Button onClick={()=>setDiscard(false)}>{t("계속 작성")}</Button><Button variant="danger" onClick={onClose}>{t("변경 내용 버리기")}</Button></>}><p>{t("저장하지 않은 변경 내용이 있습니다.")}</p></Dialog>}</section>;
}
function DeleteSection({noun,busy,onDelete,description,disabled=false}) {
 return <FormSection title={t("{0} 삭제",[noun])} description={description} className="original-delete-section"><div className="original-form-actions"><Button type="button" variant="danger-text" disabled={busy||disabled} onClick={onDelete}>{noun}{" "+t("삭제")}</Button></div></FormSection>;
}
export function GroupSettings({group,data,mutate,busy=false,onDelete,onDirtyChange}) {
 const [labelDraft,setLabelDraft]=useState('');
 const {form,set,savedAs}=useDraft({labels:[],operationalStatus:'active',...group},onDirtyChange,labelDraft),[error,setError]=useState('');
 const save=async event=>{event.preventDefault();setError('');try{const result=await mutate('group.save',{...form,labels:[...new Set([...(form.labels||[]),...labelDraft.split(/[,\n]/).map(value=>value.trim().replace(/^#+/,'')).filter(Boolean)])]},t("그룹 저장 완료"));if(result){savedAs(result);setLabelDraft('')}}catch(error){setError(error.message)}};
 return <div className="original-settings-scroll"><div className="original-settings-sections"><form onSubmit={save}><FormSection title={t("그룹 설정")}><Field label={t("그룹명")}><input required maxLength={120} value={form.name} onChange={event=>set('name',event.target.value)}/></Field><Field label={t("설명")}><textarea aria-label={t("설명")} rows={4} value={form.description} onChange={event=>set('description',event.target.value)}/></Field><LabelsField value={form.labels||[]} onChange={value=>set('labels',value)} disabled={busy} draft={labelDraft} onDraftChange={setLabelDraft}/><OperationalStatusField value={form.operationalStatus} onChange={value=>set('operationalStatus',value)} disabled={busy}/>{error&&<div className="form-error" role="alert">{error}</div>}<div className="original-form-actions"><Button type="submit" variant="primary" disabled={busy}>{busy?t("저장 중"):t("저장")}</Button></div></FormSection></form><DeleteSection noun={t("그룹")} name={group.name} busy={busy} onDelete={onDelete} description={t("그룹의 프로젝트, 리뷰, 작업이력과 첨부 파일을 함께 삭제합니다.")}/></div></div>;
}
