import React, {useEffect,useRef,useState} from 'react';
import {t} from './i18n/index.js';
import {Button} from './components.jsx';
import './service-readiness.css';

const time=value=>value?new Date(value).toLocaleString():t('미확인');
const statusLabel=status=>({responding:t('HTTP 응답 확인'),'http-error':t('HTTP 오류 응답'),unreachable:t('연결 실패')})[status]||t('미검사');
const agentLabel=status=>({queued:t('대기'),running:t('진행 중'),completed:t('완료'),failed:t('실패'),cancelled:t('중지'),interrupted:t('앱 종료로 중단')})[status]||t('미확인');

export default function ServiceReadiness({projectId,service,url,invoke,active=true}) {
 const [open,setOpen]=useState(false),[checkUrl,setCheckUrl]=useState(url||''),[path,setPath]=useState(''),[observation,setObservation]=useState(null),[pending,setPending]=useState(null),[error,setError]=useState(null),[agentState,setAgentState]=useState(null);
 const identity=JSON.stringify([projectId,service]),identityRef=useRef(identity);identityRef.current=identity;
 const key=JSON.stringify([identity,checkUrl,path]),current=useRef({key,generation:0});
 if(current.current.key!==key)current.current={key,generation:current.current.generation+1};
 const generation=current.current.generation;
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{setCheckUrl(url||'')},[identity,url]);
 useEffect(()=>{setPath('')},[identity]);
 useEffect(()=>{setObservation(null);setError(null)},[generation]);
 useEffect(()=>{
  if(!open||!active)return;
  let cancelled=false,timer;
  const poll=async()=>{
   try{const state=await invoke('viewer.agentState',{projectId});if(!cancelled&&identityRef.current===identity)setAgentState({identity,...state})}
   catch(cause){if(!cancelled&&identityRef.current===identity)setAgentState({identity,error:cause.message})}
   if(!cancelled)timer=setTimeout(poll,1800);
  };
  poll();return()=>{cancelled=true;clearTimeout(timer)};
 },[open,active,identity,invoke]);
 if(!projectId||!service)return null;
 const result=observation?.generation===generation?observation.result:null,agents=agentState?.identity===identity?agentState:null,busy=pending===generation;
 const check=async event=>{
  event.preventDefault();if(busy)return;const requested=generation;setPending(requested);setError(null);
  try{const result=await invoke('viewer.readiness',{projectId,url:checkUrl,path});if(alive.current&&current.current.generation===requested)setObservation({generation:requested,result})}
  catch(cause){if(alive.current&&current.current.generation===requested)setError({generation:requested,message:cause.message})}
  finally{if(alive.current)setPending(value=>value===requested?null:value)}
 };
 const agentText=!agents?t('조회 전'):agents.error?t('조회 실패'):agents.running?t('진행 중 {0}개',[agents.running]):agents.latest?t('진행 중 없음 · 최근 {0}',[agentLabel(agents.latest.status)]):t('실행 기록 없음');
 return <details className="service-readiness" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary><strong>{t('서비스 준비 상태')}</strong><span>{t('마지막 검사')}: {statusLabel(result?.http.status)} · {t('에이전트')}: {open?agentText:t('펼쳐서 조회')}</span></summary>
  <div className="service-readiness-body">
   <p className="service-readiness-scope">{t('이 컴퓨터에서 인증 정보 없이 GET 요청합니다. SSH 호스트 내부의 상태와 실제 사용 흐름은 별도 확인이 필요합니다.')}</p>
   <form onSubmit={check} className="service-readiness-form">
    <label>{t('준비 상태 URL')}<input aria-label={t('준비 상태 URL')} type="url" required value={checkUrl} placeholder="http://localhost:3000/health" onChange={event=>setCheckUrl(event.target.value)}/></label>
    <label>{t('비교 파일 (선택)')}<input aria-label={t('비교 파일 (선택)')} value={path} disabled={service.kind!=='local'} placeholder={service.kind==='local'?'dist/index.html':t('로컬 프로젝트만 지원')} onChange={event=>setPath(event.target.value)}/></label>
    <Button type="submit" disabled={busy||!checkUrl}>{busy?t('검사 중'):t('지금 검사')}</Button>
   </form>
   {error?.generation===generation&&<p role="alert">{error.message}</p>}
   <dl className="service-readiness-results" aria-live="polite">
    <div><dt>{t('HTTP 상태')}</dt><dd>{statusLabel(result?.http.status)}{result?.http.statusCode?` · ${result.http.statusCode}`:''}{result?.http.errorCode?` · ${result.http.errorCode}`:''}</dd></div>
    <div><dt>{t('마지막 검사 시각')}</dt><dd>{time(result?.http.checkedAt)}</dd></div>
    <div><dt>{t('검사한 URL')}</dt><dd>{result?.http.url||'—'}</dd></div>
    <div><dt>{t('프로젝트 에이전트')}</dt><dd>{agentText}{agents?.checkedAt&&<small>{t('조회 시각')}: {time(agents.checkedAt)}</small>}{agents?.error&&<small>{agents.error}</small>}</dd></div>
    <div><dt>{t('실행 배포 파일')}</dt><dd>{t('미확인 · 실행 PID·시작 명령·파일의 연결을 확인하지 않았습니다.')}</dd></div>
    <div><dt>{t('비교 파일')}</dt><dd>{result?.comparisonFile?<><span>{result.comparisonFile.path}</span>{result.comparisonFile.error?<small>{result.comparisonFile.error}</small>:<><code>SHA-256: {result.comparisonFile.sha256}</code><small>{time(result.comparisonFile.checkedAt)} · {result.comparisonFile.size} B</small></>}</>:t('선택하지 않음')}<small>{t('선택 파일의 현재 해시이며, 서비스가 실행한 파일을 증명하지 않습니다.')}</small></dd></div>
   </dl>
   <p className="service-readiness-scope">{t('검사 결과는 프로젝트 화면을 닫거나 앱을 종료하면 보존되지 않습니다. 주소·연결·비교 파일을 바꾸면 다시 검사해야 합니다.')}</p>
   <p className="service-readiness-scope">{t('서비스 시작·복구는 관리하지 않습니다. 에이전트 완료는 서비스 종료를 뜻하지 않으며, 로컬 에이전트 취소는 같은 프로세스 그룹의 서비스도 종료할 수 있습니다. 앱·호스트 재시작 후 유지는 확인하지 않았습니다.')}</p>
  </div>
 </details>;
}
