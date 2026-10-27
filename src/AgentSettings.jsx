import {t} from './i18n/index.js';
import Select from './Select.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {Button,Field,TrustDialog,invoke} from './components.jsx';
import {automaticReasoning,availableModels,defaultReasoning,environmentTarget,REASONING_EFFORTS,reasoningOptions,supportedReasoning} from './agent-models.mjs';
import './agent.css';
import LocalFolderField from './LocalFolderField.jsx';

export default function AgentSettings({form,set,service,busy=false,active=true}) {
 const [diagnosticResult,setDiagnosticResult]=useState(null),[environmentResult,setEnvironmentResult]=useState(null),[working,setWorking]=useState(false),[error,setError]=useState(''),[login,setLogin]=useState(null),[trust,setTrust]=useState(null);
 const target=environmentTarget(service),request=useRef(0),cacheRequest=useRef(0),currentTarget=useRef(target);currentTarget.current=target;
 const registered=Array.isArray(form.agentModels)?form.agentModels:[];
 const changed=['agentBinary','agentWorkPath','agentModel','agentReasoningEffort','agentInstructions','kind','rootPath','host','port','username','authType','privateKeyPath','hostAlias','sshConfigPath'].some(key=>(form[key]||'')!==(service[key]||''))||JSON.stringify(registered)!==JSON.stringify(service.agentModels||[]);
 const unsavedTarget=environmentTarget({...service,...form})!==target;
 const environment=!unsavedTarget&&environmentResult?.target===target?environmentResult.value:null,models=availableModels(environment,registered),model=models.find(item=>item.id===(form.agentModel||environment?.defaultModel)),reasoning=reasoningOptions(model),automaticEffort=model?.id&&model.id===environment?.defaultModel?automaticReasoning(model,environment.defaultReasoningEffort):'';
 const modelSource=environment?.models?.length&&environment.modelSource!=='manual'?(environment.modelSource||'host'):models.length?'manual':'none';
 const diagnostic=!unsavedTarget&&diagnosticResult?.target===target?diagnosticResult.value:null;
 const readModels=async()=>{
  if(!active||!target)return;
  const token=++cacheRequest.current;
  try{const value=await invoke('agent.models',{serviceId:service.id});if(token===cacheRequest.current&&currentTarget.current===target)setEnvironmentResult({target,value,error:''})}
  catch(cause){if(token===cacheRequest.current&&currentTarget.current===target)setEnvironmentResult(current=>({target,value:current?.target===target?current.value:null,error:cause.message||String(cause)}))}
 };
 const action=async(name,interactive=true)=>{
  if(name==='agent.models')return readModels();
  if(!active||!target)return;
  const token=++request.current;setWorking(true);setError('');if(name==='agent.login')setDiagnosticResult(null);
  try{
   const result=await invoke(name,{serviceId:service.id});
   if(token!==request.current||currentTarget.current!==target)return;
   if(name==='agent.login')setLogin(result);else setDiagnosticResult({target,value:result});
  }catch(cause){
   if(token!==request.current||currentTarget.current!==target)return;
   setError(cause.message||String(cause));
   if(interactive&&cause.code==='SSH_TRUST_REQUIRED')setTrust({host:cause.host||service.host,fingerprint:cause.fingerprint});
  }finally{if(token===request.current&&currentTarget.current===target)setWorking(false)}
 };
 useEffect(()=>{
  if(!active||!target)return;
  let live=true;setTrust(null);setLogin(null);
  const loginRevision=request.current;
  invoke('agent.loginState',{serviceId:service.id}).then(result=>{if(live&&result&&loginRevision===request.current)setLogin(result)}).catch(cause=>{if(live&&loginRevision===request.current)setError(cause.message)});
  if(!changed)action('agent.models',false);
  const stop=window.reviewops?.onModelCacheState?.(()=>{if(live&&!changed)action('agent.models',false)});
  return()=>{live=false;request.current++;cacheRequest.current++;setWorking(false);stop?.()};
 },[active,target]);
 useEffect(()=>{if(!active||!model)return;const value=supportedReasoning(model,form.agentReasoningEffort);if(value!==(form.agentReasoningEffort||''))set('agentReasoningEffort',value)},[active,target,JSON.stringify(model),form.agentReasoningEffort]);
 useEffect(()=>{if(login?.status!=='running')return;let live=true,timer;const poll=async()=>{try{const result=await invoke('agent.read',{id:login.id});if(!live)return;setLogin(result);if(result.status==='running')timer=setTimeout(poll,700);else if(result.status==='completed'&&active&&!changed)action('agent.models',false)}catch(cause){if(live)setError(cause.message)}};timer=setTimeout(poll,400);return()=>{live=false;clearTimeout(timer)}},[login?.id,login?.status,active,changed]);
 const chooseBinary=async()=>{try{const selected=await invoke('dialog.executable');if(selected)set('agentBinary',selected)}catch(cause){setError(cause.message)}};
 const updateModel=(index,patch)=>set('agentModels',registered.map((item,row)=>row===index?{...item,...patch}:item));
 const invalidModels=registered.some((item,index)=>!item.id?.trim()||/\s/.test(item.id)||registered.some((other,row)=>row!==index&&other.id?.trim()===item.id?.trim()));
 const loginUrl=login?.output?.match(/https:\/\/[^\s<>]+/)?.[0],disabled=busy||working||changed||login?.status==='running';
 const modelError=!unsavedTarget&&environmentResult?.target===target?environmentResult.error||environment?.modelError:'';
 return <div className="agent-settings-fields">
  <label className="agent-enable"><input type="checkbox" checked={Boolean(form.agentEnabled)} onChange={event=>set('agentEnabled',event.target.checked?1:0)}/>{t("에이전트 사용")}</label>
  <p className="agent-help">{t("Codex가")+" "}{form.kind==='ssh'?t("SSH 서버"):t("이 Mac")}{t("의 작업 폴더에서 요청을 수행합니다. 파일 수정과 명령 실행이 가능합니다.")}</p>
  <Field label={t("실행 파일")}><div className="input-action"><input aria-label={t("에이전트 실행 파일")} disabled={busy} value={form.agentBinary||'codex'} onChange={event=>set('agentBinary',event.target.value)} placeholder={t("codex 또는 실행 파일의 전체 경로")}/>{form.kind!=='ssh'&&<Button type="button" disabled={busy} onClick={chooseBinary}>{t('실행 파일 선택')}</Button>}</div></Field>
  {form.kind==='ssh'?<Field label={t("작업 폴더")} hint={t("비워 두면 프로젝트의 파일 경로를 사용합니다.")}><input aria-label={t("에이전트 작업 폴더")} disabled={busy} value={form.agentWorkPath||''} onChange={event=>set('agentWorkPath',event.target.value)} placeholder={form.rootPath}/></Field>:<LocalFolderField label={t('에이전트 작업 폴더')} hint={t('비워 두면 프로젝트의 파일 경로를 사용합니다.')} value={form.agentWorkPath||''} placeholder={form.rootPath} disabled={busy} onChange={value=>set('agentWorkPath',value)}/>}
  <p className="agent-help">{t('실행 대상')}: {form.kind==='ssh'?`SSH · ${form.hostAlias||form.host}`:t('이 컴퓨터')} · {form.agentBinary||'codex'}</p>
  <p className="agent-help">{t('선택한 실행 대상의 기존 Codex 로그인을 사용합니다. 요청을 보내기 전에 폴더, 실행 파일과 로그인 상태를 검사합니다.')}</p>
  <Field label={t("모델")} hint={t("비워 두면 Codex에 설정된 모델을 사용합니다.")}><Select searchable allowCustom aria-label={t("에이전트 모델")} value={form.agentModel||''} disabled={busy} onChange={event=>{const value=event.target.value;set('agentModel',value);set('agentReasoningEffort',value?defaultReasoning(models.find(item=>item.id===value)):'')}} placeholder={t("자동")}><option value="">{environment?.defaultModel?t("호스트 기본 모델 · {0}",[models.find(item=>item.id===environment.defaultModel)?.label||environment.defaultModel]):t("호스트 기본 모델")}</option>{form.agentModel&&!models.some(item=>item.id===form.agentModel)&&<option value={form.agentModel}>{form.agentModel}</option>}{models.map(item=><option key={item.id} value={item.id}>{item.label||item.id}</option>)}</Select></Field>
  <Field label={t("추론 수준")} hint={model?t("선택한 모델에서 제공하는 값입니다."):t("모델이 지원하는 추론 수준을 선택하십시오.")}><Select searchable={false} aria-label={t("에이전트 추론 수준")} value={form.agentReasoningEffort||''} disabled={busy} onChange={event=>set('agentReasoningEffort',event.target.value)}><option value="">{automaticEffort?t("자동 · {0}",[automaticEffort]):t("자동")}</option>{reasoning.map(value=><option key={value} value={value}>{value}</option>)}</Select></Field>
  <section className="agent-model-manager" aria-label={t("모델 직접 등록")}>
   <header><div><h4>{t("모델 직접 등록")}</h4><p className="agent-help">{t("호스트에서 모델 목록을 불러올 수 없을 때 이 프로젝트에서 사용할 목록입니다.")}</p></div><Button type="button" icon="plus" disabled={busy||registered.length>=100} onClick={()=>set('agentModels',[...registered,{id:'',label:'',reasoning:[],defaultReasoningEffort:''}])}>{t("모델 추가")}</Button></header>
   {registered.map((item,index)=><div className="agent-model-row" key={index}>
    <div className="agent-model-row-fields"><Field label={t("모델 ID")}><input aria-label={t("모델 {0} ID",[index+1])} value={item.id||''} maxLength={256} disabled={busy} onChange={event=>updateModel(index,{id:event.target.value})} placeholder="model-id"/></Field><Field label={t("표시 이름")}><input aria-label={t("모델 {0} 표시 이름",[index+1])} value={item.label||''} maxLength={256} disabled={busy} onChange={event=>updateModel(index,{label:event.target.value})} placeholder={item.id||t("모델 이름")}/></Field><Button type="button" icon="trash" aria-label={t("모델 {0} 삭제",[index+1])} disabled={busy} onClick={()=>set('agentModels',registered.filter((_,row)=>row!==index))}>{t("삭제")}</Button></div>
    <fieldset className="agent-model-reasoning" disabled={busy}><legend>{t("지원 추론 수준")}</legend>{REASONING_EFFORTS.map(value=><label key={value}><input type="checkbox" aria-label={t("모델 {0} 추론 {1}",[index+1,value])} checked={Boolean(item.reasoning?.includes(value))} onChange={event=>{const values=event.target.checked?[...(item.reasoning||[]),value]:(item.reasoning||[]).filter(level=>level!==value);updateModel(index,{reasoning:values,defaultReasoningEffort:values.includes(item.defaultReasoningEffort)?item.defaultReasoningEffort:''})}}/>{value}</label>)}</fieldset>
    <Field label={t("기본 추론 수준")}><Select searchable={false} aria-label={t("모델 {0} 기본 추론 수준",[index+1])} value={item.defaultReasoningEffort||''} disabled={busy} onChange={event=>updateModel(index,{defaultReasoningEffort:event.target.value})}><option value="">{t("자동")}</option>{reasoningOptions(item).map(value=><option key={value} value={value}>{value}</option>)}</Select></Field>
   </div>)}
   {!registered.length&&<p className="agent-help">{t("직접 등록한 모델이 없습니다.")}</p>}
   {invalidModels&&<p className="form-error" role="alert">{t("각 모델에 공백 없이 서로 다른 모델 ID를 입력하십시오.")}</p>}
  </section>
  <Field label={t("작업 지침")}><textarea aria-label={t("에이전트 작업 지침")} rows={5} maxLength={50000} value={form.agentInstructions||''} onChange={event=>set('agentInstructions',event.target.value)} placeholder={t("이 프로젝트의 작업에 공통으로 적용할 내용을 입력하십시오.")}/></Field>
  <div className="agent-actions"><Button type="button" disabled={disabled} onClick={()=>action('agent.environment')}>{working?t("검사 중"):t("실행 환경 검사")}</Button><Button type="button" disabled={disabled} onClick={()=>action('agent.login')}>{t("Codex 로그인")}</Button>{diagnostic?.loggedIn&&<Button type="button" disabled={disabled} onClick={()=>action('agent.logout')}>{t("Codex 로그아웃")}</Button>}</div>
  {changed&&<p className="agent-help">{t("설정을 저장한 후 실행 환경과 로그인을 검사할 수 있습니다.")}</p>}
  {modelError&&<p className="agent-help agent-model-notice" role="status">{t("모델 정보를 모두 불러오지 못했습니다.")} {modelSource==='manual'?t("직접 등록한 모델을 사용합니다."):modelSource==='cache'?t("이전에 불러온 모델 목록을 사용합니다."):modelSource==='none'?t("위 목록에 모델을 직접 등록할 수 있습니다."):null}<span>{t(modelError)}</span></p>}
  {diagnostic&&<div className="agent-environment" role="status"><strong>{diagnostic.installed?diagnostic.version||t("Codex 설치됨"):t("Codex 설치 필요")}</strong><span>{!diagnostic.installed?t('로그인 검사 전'):diagnostic.loggedIn?t("로그인됨"):diagnostic.authState==='unknown'?t('로그인 검사 실패'):t("로그인 필요")}</span><span>{t('실행 파일')}: {diagnostic.binary}</span><span>{t('작업 폴더')}: {diagnostic.workPath}</span>{diagnostic.error&&<p>{t(diagnostic.error)}</p>}{diagnostic.defaultModel&&<span>{t("호스트 기본 모델: {0}",[diagnostic.defaultModel])}</span>}{diagnostic.modelSource==='manual'&&<p>{t("직접 등록한 모델을 사용합니다.")}</p>}{!diagnostic.installed&&<p>{t("작업 환경에 Codex CLI를 설치하거나 실행 파일의 전체 경로를 지정하십시오.")}</p>}</div>}
  {login&&<div className="agent-login"><strong>{login.status==='running'?t("브라우저에서 Codex 로그인을 완료하십시오."):login.status==='completed'?t("로그인 완료"):login.status==='cancelled'?t("로그인 중지"):t("로그인 실패")}</strong>{login.status==='running'&&loginUrl&&<Button type="button" onClick={()=>invoke('external.open',{url:loginUrl}).catch(cause=>setError(cause.message))}>{t("로그인 페이지 열기")}</Button>}<pre>{login.output||t("로그인 주소와 코드를 불러오는 중입니다.")}</pre>{login.error&&<p role="alert">{login.error}</p>}{login.status==='running'&&<Button type="button" onClick={async()=>{try{setLogin(await invoke('agent.cancel',{id:login.id}))}catch(cause){setError(cause.message)}}}>{t("로그인 중지")}</Button>}</div>}
  {error&&<p className="form-error" role="alert">{t(error)}</p>}
  {trust&&<TrustDialog trust={trust} onClose={()=>setTrust(null)} onTrust={async()=>{try{await invoke('ssh.trust',{serviceId:service.id,fingerprint:trust.fingerprint});setTrust(null);action('agent.environment')}catch(cause){setError(cause.message);setTrust(null)}}}/>}
 </div>;
}
