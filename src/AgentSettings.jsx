import {t} from './i18n/index.js';
import Select from './Select.jsx';
import React,{useEffect,useState} from 'react';
import {Button,Field,TrustDialog,invoke} from './components.jsx';
import './agent.css';

export default function AgentSettings({form,set,service,busy=false}) {
 const [environment,setEnvironment]=useState(null),[working,setWorking]=useState(false),[error,setError]=useState(''),[login,setLogin]=useState(null),[trust,setTrust]=useState(null);
 useEffect(()=>{let live=true;invoke('agent.loginState',{serviceId:service.id}).then(result=>{if(live&&result)setLogin(result)}).catch(cause=>{if(live)setError(cause.message)});return()=>{live=false}},[service.id]);
 const changed=['agentBinary','agentWorkPath','agentModel','agentReasoningEffort','agentInstructions','kind','rootPath','host','port','username','authType','privateKeyPath'].some(key=>(form[key]||'')!==(service[key]||''));
 const action=async name=>{setWorking(true);setError('');try{const result=await invoke(name,{serviceId:service.id});if(name==='agent.login')setLogin(result);else setEnvironment(result)}catch(cause){if(cause.code==='SSH_TRUST_REQUIRED')setTrust({host:cause.host||service.host,fingerprint:cause.fingerprint});else setError(cause.message)}finally{setWorking(false)}};
 useEffect(()=>{if(login?.status!=='running')return;let live=true,timer;const poll=async()=>{try{const result=await invoke('agent.read',{id:login.id});if(!live)return;setLogin(result);if(result.status==='running')timer=setTimeout(poll,700);else if(result.status==='completed')action('agent.environment')}catch(cause){if(live)setError(cause.message)}};timer=setTimeout(poll,400);return()=>{live=false;clearTimeout(timer)}},[login?.id,login?.status]);
 const model=environment?.models?.find(item=>item.id===form.agentModel);
 const reasoning=(model?.reasoning||[]).map(item=>typeof item==='string'?item:item.effort||item.id).filter(Boolean);
 const loginUrl=login?.output?.match(/https:\/\/[^\s<>]+/)?.[0];
 const disabled=busy||working||changed||login?.status==='running';
 return <div className="agent-settings-fields">
  <label className="agent-enable"><input type="checkbox" checked={Boolean(form.agentEnabled)} onChange={event=>set('agentEnabled',event.target.checked?1:0)}/>{t("에이전트 사용")}</label>
  <p className="agent-help">{t("Codex가")+" "}{form.kind==='ssh'?t("SSH 서버"):t("이 Mac")}{t("의 작업 폴더에서 요청을 수행합니다. 파일 수정과 명령 실행이 가능합니다.")}</p>
  <Field label={t("실행 파일")}><input aria-label={t("에이전트 실행 파일")} value={form.agentBinary||'codex'} onChange={event=>set('agentBinary',event.target.value)} placeholder={t("codex 또는 실행 파일의 전체 경로")}/></Field>
  <Field label={t("작업 폴더")} hint={t("비워 두면 프로젝트의 파일 경로를 사용합니다.")}><input aria-label={t("에이전트 작업 폴더")} value={form.agentWorkPath||''} onChange={event=>set('agentWorkPath',event.target.value)} placeholder={form.rootPath}/></Field>
  <Field label={t("모델")} hint={t("비워 두면 Codex에 설정된 모델을 사용합니다.")}><Select searchable allowCustom aria-label={t("에이전트 모델")} value={form.agentModel||''} onChange={event=>{set('agentModel',event.target.value);set('agentReasoningEffort','')}} placeholder={t("자동")}><option value="">{t("자동")}</option>{form.agentModel&&!environment?.models?.some(item=>item.id===form.agentModel)&&<option value={form.agentModel}>{form.agentModel}</option>}{environment?.models?.map(item=><option key={item.id} value={item.id}>{item.label||item.id}</option>)}</Select></Field>
  <Field label={t("추론 수준")} hint={reasoning.length?t("선택한 모델에서 제공하는 값입니다."):t("모델이 지원하는 값을 입력하거나 자동으로 사용하십시오.")}>{reasoning.length?<Select searchable={false} aria-label={t("에이전트 추론 수준")} value={form.agentReasoningEffort||''} onChange={event=>set('agentReasoningEffort',event.target.value)}><option value="">{t("자동")}</option>{reasoning.map(value=><option key={value} value={value}>{value}</option>)}</Select>:<input aria-label={t("에이전트 추론 수준")} value={form.agentReasoningEffort||''} onChange={event=>set('agentReasoningEffort',event.target.value)} placeholder={t("자동")}/>}</Field>
  <Field label={t("작업 지침")}><textarea aria-label={t("에이전트 작업 지침")} rows={5} maxLength={50000} value={form.agentInstructions||''} onChange={event=>set('agentInstructions',event.target.value)} placeholder={t("이 프로젝트의 작업에 공통으로 적용할 내용을 입력하십시오.")}/></Field>
  <div className="agent-actions"><Button type="button" disabled={disabled} onClick={()=>action('agent.environment')}>{working?t("검사 중"):t("실행 환경 검사")}</Button><Button type="button" disabled={disabled} onClick={()=>action('agent.login')}>{t("Codex 로그인")}</Button>{environment?.loggedIn&&<Button type="button" disabled={disabled} onClick={()=>action('agent.logout')}>{t("Codex 로그아웃")}</Button>}</div>
  {changed&&<p className="agent-help">{t("설정을 저장한 후 실행 환경과 로그인을 검사할 수 있습니다.")}</p>}
  {environment&&<div className="agent-environment" role="status"><strong>{environment.installed?environment.version||t("Codex 설치됨"):t("Codex 설치 필요")}</strong><span>{environment.loggedIn?t("로그인됨"):t("로그인 필요")}</span>{!environment.installed&&<p>{t("작업 환경에 Codex CLI를 설치하거나 실행 파일의 전체 경로를 지정하십시오.")}</p>}</div>}
  {login&&<div className="agent-login"><strong>{login.status==='running'?t("브라우저에서 Codex 로그인을 완료하십시오."):login.status==='completed'?t("로그인 완료"):login.status==='cancelled'?t("로그인 중지"):t("로그인 실패")}</strong>{login.status==='running'&&loginUrl&&<Button type="button" onClick={()=>invoke('external.open',{url:loginUrl}).catch(cause=>setError(cause.message))}>{t("로그인 페이지 열기")}</Button>}<pre>{login.output||t("로그인 주소와 코드를 불러오는 중입니다.")}</pre>{login.error&&<p role="alert">{login.error}</p>}{login.status==='running'&&<Button type="button" onClick={async()=>{try{setLogin(await invoke('agent.cancel',{id:login.id}))}catch(cause){setError(cause.message)}}}>{t("로그인 중지")}</Button>}</div>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  {trust&&<TrustDialog trust={trust} onClose={()=>setTrust(null)} onTrust={async()=>{try{await invoke('ssh.trust',{serviceId:service.id,fingerprint:trust.fingerprint});setTrust(null);action('agent.environment')}catch(cause){setError(cause.message);setTrust(null)}}}/>}
 </div>;
}
