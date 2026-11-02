import React, {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {t} from './i18n/index.js';
import {Button} from './components.jsx';
import './service-readiness.css';
import {createServiceRuntimeDraft,emptyServiceRuntimeDraft,serviceRuntimeUnloadGuard} from './service-runtime-draft.mjs';

const time=value=>value?new Date(value).toLocaleString():t('미확인');
const statusLabel=status=>({responding:t('HTTP 응답 확인'),'http-error':t('HTTP 오류 응답'),unreachable:t('연결 실패')})[status]||t('미검사');
const agentLabel=status=>({queued:t('대기'),running:t('진행 중'),completed:t('완료'),failed:t('실패'),cancelled:t('중지'),interrupted:t('앱 종료로 중단')})[status]||t('미확인');

export default function ServiceReadiness({projectId,service,url,invoke,active=true,onDirtyChange}) {
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
  if(!open||!active||!service)return;
  let cancelled=false,timer;
  const poll=async()=>{
   try{const state=await invoke('viewer.agentState',{projectId,connectionId:service.id});if(!cancelled&&identityRef.current===identity)setAgentState({identity,...state})}
   catch(cause){if(!cancelled&&identityRef.current===identity)setAgentState({identity,error:cause.message})}
   if(!cancelled)timer=setTimeout(poll,1800);
  };
  poll();return()=>{cancelled=true;clearTimeout(timer)};
 },[open,active,identity,invoke]);
 if(!projectId)return null;
 const result=observation?.generation===generation?observation.result:null,agents=agentState?.identity===identity?agentState:null,busy=pending===generation;
 const check=async event=>{
  event.preventDefault();if(busy||!service)return;const requested=generation;setPending(requested);setError(null);
  try{const result=await invoke('viewer.readiness',{projectId,connectionId:service.id,url:checkUrl,path});if(alive.current&&current.current.generation===requested)setObservation({generation:requested,result})}
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
    <label>{t('비교 파일 (선택)')}<input aria-label={t('비교 파일 (선택)')} value={path} disabled={service?.kind!=='local'} placeholder={service?.kind==='local'?'dist/index.html':t('로컬 프로젝트만 지원')} onChange={event=>setPath(event.target.value)}/></label>
    <Button type="submit" disabled={busy||!checkUrl||!service}>{busy?t('검사 중'):t('지금 검사')}</Button>
   </form>
   {error?.generation===generation&&<p role="alert">{t(error.message)}</p>}
   <dl className="service-readiness-results" aria-live="polite">
    <div><dt>{t('HTTP 상태')}</dt><dd>{statusLabel(result?.http.status)}{result?.http.statusCode?` · ${result.http.statusCode}`:''}{result?.http.errorCode?` · ${result.http.errorCode}`:''}</dd></div>
    <div><dt>{t('마지막 검사 시각')}</dt><dd>{time(result?.http.checkedAt)}</dd></div>
    <div><dt>{t('검사한 URL')}</dt><dd>{result?.http.url||'—'}</dd></div>
    <div><dt>{t('프로젝트 에이전트')}</dt><dd>{agentText}{agents?.checkedAt&&<small>{t('조회 시각')}: {time(agents.checkedAt)}</small>}{agents?.error&&<small>{t(agents.error)}</small>}</dd></div>
    <div><dt>{t('실행 배포 파일')}</dt><dd>{t('HTTP 응답과 비교 파일만으로 실행 프로세스나 배포 파일을 확인하지 않습니다.')}</dd></div>
    <div><dt>{t('비교 파일')}</dt><dd>{result?.comparisonFile?<><span>{result.comparisonFile.path}</span>{result.comparisonFile.error?<small>{result.comparisonFile.error}</small>:<><code>SHA-256: {result.comparisonFile.sha256}</code><small>{time(result.comparisonFile.checkedAt)} · {result.comparisonFile.size} B</small></>}</>:t('선택하지 않음')}<small>{t('선택 파일의 현재 해시이며, 서비스가 실행한 파일을 증명하지 않습니다.')}</small></dd></div>
   </dl>
   <p className="service-readiness-scope">{t('검사 결과는 프로젝트 화면을 닫거나 앱을 종료하면 보존되지 않습니다. 주소·연결·비교 파일을 바꾸면 다시 검사해야 합니다.')}</p>
   <p className="service-readiness-scope">{t('에이전트 완료와 서비스 종료는 다릅니다. 직접 시작한 외부 서비스의 수명은 별도로 확인해야 합니다.')}</p>
   <OwnedLocalService projectId={projectId} service={service} invoke={invoke} active={open&&active} onDirtyChange={onDirtyChange}/>
  </div>
 </details>;
}

const emptyConfig=emptyServiceRuntimeDraft;
const runtimeLabel=status=>({starting:t('시작 중'),running:t('실행 중'),stopping:t('중지 중'),'stop-unconfirmed':t('중지 확인 필요'),stopped:t('중지됨'),exited:t('종료됨'),failed:t('실패')})[status]||status||t('시작 전');
const runtimeEnded=instance=>!instance||['stopped','exited'].includes(instance.status)||instance.exit!=null||instance.status==='failed'&&!instance.pid;
const errorText=value=>typeof value==='string'?value:value?.message||'';

function OwnedLocalService({projectId,service,invoke,active,onDirtyChange}) {
 const binding=JSON.stringify([projectId,service?.id,service]),identity={projectId,connectionId:service?.id||'',rootPath:service?.rootPath||'',kind:service?.kind||'none',name:service?.name||''};
 const guard=useRef({binding,epoch:0});
 if(guard.current.binding!==binding)guard.current={binding,epoch:guard.current.epoch+1};
 const epoch=guard.current.epoch,alive=useRef(true),readSequence=useRef(0),operation=useRef(null),controller=useRef(null),dirtyCallback=useRef(onDirtyChange);dirtyCallback.current=onDirtyChange;
 const [saved,setSaved]=useState(null),[draft,setDraft]=useState({binding,draft:emptyConfig(),dirty:false,origin:identity,current:identity,reviewRequired:false,canConfigure:service?.kind==='local',canReview:false}),[edited,setEdited]=useState(false),[pending,setPending]=useState(null),[error,setError]=useState(null),[probe,setProbe]=useState(null);
 const current=()=>alive.current&&guard.current.epoch===epoch;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const syncDraft=value=>{setDraft(value);setEdited(value.dirty)};
 useLayoutEffect(()=>{const unload=serviceRuntimeUnloadGuard(()=>controller.current);window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload)},[]);
 useLayoutEffect(()=>{
  const owner=createServiceRuntimeDraft(binding,value=>dirtyCallback.current?.(value),identity);controller.current=owner;syncDraft(owner.snapshot());
  return()=>{owner.dispose();if(controller.current===owner)controller.current=null;};
 },[]);
 useLayoutEffect(()=>{
  if(controller.current)syncDraft(controller.current.transition(binding,identity));
  operation.current=null;readSequence.current++;setPending(null);setError(null);setSaved(null);setProbe(null);
 },[binding]);
 const accept=(value,sequence)=>{
  if(!current()||sequence!==readSequence.current)return;
  setSaved({...value,binding});
  setError(previous=>previous?.kind==='state'?null:previous);
  if(controller.current?.binding===binding)syncDraft(controller.current.accept(value.config));
 };
 const read=async()=>{
  const sequence=++readSequence.current;
  const value=await invoke('serviceRuntime.state',{projectId,connectionId:service.id});
  accept(value,sequence);
  return value;
 };
 useEffect(()=>{
  if(!active||service?.kind!=='local')return;
  let cancelled=false,timer;
  const poll=async()=>{
   if(!cancelled&&!operation.current){
    try{await read()}
    catch(cause){if(!cancelled&&current())setError({binding,kind:'state',message:cause.message})}
   }
   if(!cancelled)timer=setTimeout(poll,1800);
  };
  poll();return()=>{cancelled=true;clearTimeout(timer)};
 },[active,binding,invoke]);
 if(service?.kind!=='local'&&!draft.dirty)return <section className="owned-service-runtime"><h3>{t('관리형 로컬 Node 서비스')}</h3><p className="service-readiness-scope">{t('관리형 서비스는 로컬 Node .cjs 실행만 지원합니다. SSH 서비스와 호스트 재부팅 후 유지는 지원하지 않습니다.')}</p></section>;
 const state=saved?.binding===binding?saved:null,form=draft.draft,instance=state?.instance||null,ended=runtimeEnded(instance),busy=pending?.epoch===epoch,ready=draft.binding===binding,canConfigure=ready&&draft.canConfigure,reviewRequired=!ready||draft.reviewRequired;
 const checked=probe?.binding===binding&&probe.instanceId===(instance?.instanceId||null)&&probe.url===state?.config?.readinessUrl?probe.result:null;
 const priorOrigin=draft.origin.projectId!==projectId||draft.origin.connectionId!==(service?.id||'')||draft.origin.rootPath!==(service?.rootPath||'');
 const change=(name,value)=>{if(current()&&controller.current?.binding===binding)syncDraft(controller.current.change(name,value))};
 const run=async(action,config)=>{
  if(operation.current||!current()||!service||(['configure','start','restart','check'].includes(action)&&!canConfigure))return;
  const token={epoch};operation.current=token;readSequence.current++;setPending({epoch,action});setError(null);setProbe(null);
  try{
   const payload={projectId,connectionId:service.id,...(config?{config}:{}),...(['stop','restart'].includes(action)?{instanceId:instance.instanceId}:{})};
   if(action==='check'){
    const result=await invoke('viewer.readiness',{projectId,connectionId:service.id,url:state.config.readinessUrl,path:''});
    if(current())setProbe({binding,instanceId:instance?.instanceId||null,url:state.config.readinessUrl,result});
   }else if(action==='configure'){
    const owner=controller.current;
    if(!owner||owner.binding!==binding)return;
    await owner.save(()=>invoke('serviceRuntime.configure',payload));
    if(current()&&controller.current===owner)syncDraft(owner.snapshot());
   }else await invoke('serviceRuntime.'+action,payload);
   if(!current())return;
   await read();
  }catch(cause){if(current())setError({binding,message:cause.message})}
  finally{if(operation.current===token){operation.current=null;if(current())setPending(null)}}
 };
 const save=event=>{
  event.preventDefault();
  try{
   const args=JSON.parse(form.argsText);
   if(!Array.isArray(args)||args.some(value=>typeof value!=='string'))throw new Error(t('실행 인수는 문자열 배열 JSON으로 입력하십시오.'));
   run('configure',{executable:form.executable,entry:form.entry,args,readinessUrl:form.readinessUrl});
  }catch(cause){setError({binding,message:cause.message})}
 };
 return <section className="owned-service-runtime" aria-label={t('관리형 로컬 Node 서비스')}>
  <h3>{t('관리형 로컬 Node 서비스')}</h3>
  <p className="service-readiness-scope">{t('저장한 설정으로 이 프로젝트의 Node 서비스를 시작합니다. 에이전트 종료·취소나 프로젝트 화면 닫기로 이 서비스가 중지되지는 않습니다.')}</p>
  {service?.kind!=='local'&&<p className="service-readiness-scope">{t('관리형 서비스는 로컬 Node .cjs 실행만 지원합니다. SSH 서비스와 호스트 재부팅 후 유지는 지원하지 않습니다.')}</p>}
  {(reviewRequired||priorOrigin)&&<section aria-label={t('이전 연결 초안')}>
   <h4>{t('이전 연결 초안')}</h4>
   <p className="service-readiness-scope">{reviewRequired?t('연결이 바뀌어 저장하지 않은 초안을 보존했습니다. 이 연결에서 검토하거나 초안을 버리기 전에는 실행 설정을 저장하거나 서비스를 시작할 수 없습니다.'):t('이 연결에서 초안을 검토했습니다. 현재 작업 폴더 안의 진입 파일을 검사한 뒤 저장하며, 원래 연결의 초안 정보는 저장 성공까지 유지합니다.')}</p>
   <dl className="service-readiness-results"><div><dt>{t('초안의 원래 프로젝트')}</dt><dd>{draft.origin.name||draft.origin.projectId||'—'}<small>{draft.origin.projectId||'—'}</small></dd></div><div><dt>{t('초안의 원래 연결')}</dt><dd>{draft.origin.connectionId||'—'}<small>{draft.origin.rootPath||'—'}</small></dd></div><div><dt>{t('현재 프로젝트 연결')}</dt><dd>{projectId} · {service?.id||'—'}<small>{service?.rootPath||'—'}</small></dd></div></dl>
   <p className="service-readiness-scope">{t('원래 프로젝트와 연결을 선택하면 보존한 초안을 이어서 작성할 수 있습니다. 다른 프로젝트에는 이 초안을 저장할 수 없습니다.')}</p>
   <div className="owned-service-actions"><Button type="button" disabled={busy||!ready||!draft.canReview||!state||!reviewRequired} onClick={()=>syncDraft(controller.current.review())}>{t('이 연결에서 검토')}</Button><Button type="button" disabled={busy||!ready} onClick={()=>syncDraft(controller.current.discard())}>{t('이전 초안 버리기')}</Button></div>
  </section>}

  <form onSubmit={save} className="service-readiness-form owned-service-config">
   <label>{t('Node 실행 파일')}<input required aria-label={t('Node 실행 파일')} value={form.executable} placeholder="/usr/local/bin/node" disabled={busy||!ended} readOnly={!canConfigure} onChange={event=>change('executable',event.target.value)}/></label>
   <label>{t('프로젝트 안의 .cjs 진입 파일')}<input required aria-label={t('프로젝트 안의 .cjs 진입 파일')} value={form.entry} placeholder="server.cjs" disabled={busy||!ended} readOnly={!canConfigure} onChange={event=>change('entry',event.target.value)}/></label>
   <label>{t('실행 인수 (JSON 문자열 배열)')}<textarea required rows="2" aria-label={t('실행 인수 (JSON 문자열 배열)')} value={form.argsText} disabled={busy||!ended} readOnly={!canConfigure} onChange={event=>change('argsText',event.target.value)}/></label>
   <label>{t('관리형 서비스 준비 URL')}<input required type="url" aria-label={t('관리형 서비스 준비 URL')} value={form.readinessUrl} placeholder="http://127.0.0.1:3000/health" disabled={busy||!ended} readOnly={!canConfigure} onChange={event=>change('readinessUrl',event.target.value)}/></label>
   <Button type="submit" disabled={busy||!ended||!canConfigure}>{pending?.action==='configure'?t('저장 중'):t('서비스 설정 저장')}</Button>
  </form>
  <p className="service-readiness-scope">{t('설정 저장은 서비스를 실행하지 않습니다. 인수는 셸 명령으로 해석하지 않으며, 준비 URL은 이 컴퓨터의 loopback HTTP 주소만 지원합니다.')}</p>
  <div className="owned-service-actions" role="group" aria-label={t('관리형 서비스 제어')}>
   <Button disabled={busy||!state?.config||!ended||edited||!canConfigure} onClick={()=>run('start')}>{pending?.action==='start'?t('시작 중'):t('저장한 서비스 시작')}</Button>
   <Button disabled={busy||!instance||ended} onClick={()=>run('stop')}>{pending?.action==='stop'?t('중지 중'):t('이 인스턴스 중지')}</Button>
   <Button disabled={busy||!instance||edited||!canConfigure} onClick={()=>run('restart')}>{pending?.action==='restart'?t('복구 중'):t('이 인스턴스 복구')}</Button>
   <Button disabled={busy||!state?.config||edited||!canConfigure} onClick={()=>run('check')}>{pending?.action==='check'?t('검사 중'):t('저장한 준비 URL 검사')}</Button>
  </div>
  {edited&&<p className="service-readiness-scope">{t('변경한 설정을 저장한 뒤 시작할 수 있습니다.')}</p>}
  {error?.binding===binding&&<p role="alert">{t(error.message)}</p>}
  <dl className="service-readiness-results" aria-live="polite">
   <div><dt>{t('관리형 서비스 상태')}</dt><dd>{state?runtimeLabel(instance?.status):t('조회 전')}{errorText(instance?.error)&&<small>{t(errorText(instance.error))}</small>}</dd></div>
   <div><dt>{t('소유 인스턴스')}</dt><dd>{instance?.instanceId||'—'}<small>PID: {instance?.pid||'—'}</small></dd></div>
   <div><dt>{t('시작 시각')}</dt><dd>{time(instance?.startedAt)}</dd></div>
   <div><dt>{t('저장한 준비 URL의 응답')}</dt><dd>{statusLabel(checked?.http?.status)}{checked?.http?.statusCode?` · ${checked.http.statusCode}`:''}{checked?.http?.errorCode?` · ${checked.http.errorCode}`:''}<small>{checked?.http?.url||state?.config?.readinessUrl||'—'}</small><small>{time(checked?.http?.checkedAt)}</small></dd></div>
   <div><dt>{t('실제 Node 실행 정보')}</dt><dd>{instance?.actual?.executable||'—'}<code>{instance?.actual?.argv?JSON.stringify(instance.actual.argv):''}</code><small>{instance?.actual?.cwd||''}</small><small>{instance?.actual?.nodeVersion||''}</small></dd></div>
   <div><dt>{t('시작 전 진입 파일 스냅샷')}</dt><dd>{instance?.entrySnapshot?.path||'—'}{instance?.entrySnapshot&&<><code>SHA-256: {instance.entrySnapshot.sha256}</code><small>{instance.entrySnapshot.size} B · {t('시작 전 파일 바이트의 해시이며 Node가 실제 로드한 바이트의 증명은 아닙니다.')}</small></>}</dd></div>
   <div><dt>{t('이 인스턴스에서 관찰한 수신 주소')}</dt><dd>{instance?.listeners?.length?<code>{JSON.stringify(instance.listeners)}</code>:'—'}<small>{t('HTTP 응답 성공만으로 이 프로세스나 올바른 배포 파일을 확인하지 않습니다.')}</small></dd></div>
   {instance?.exit&&<div><dt>{t('서비스 종료 결과')}</dt><dd>{JSON.stringify(instance.exit)}</dd></div>}
  </dl>
  {instance?.logTail&&<details className="owned-service-log"><summary>{t('최근 서비스 로그')}</summary><pre>{typeof instance.logTail==='string'?instance.logTail:JSON.stringify(instance.logTail,null,2)}</pre></details>}
  <p className="service-readiness-scope">{t('앱 종료를 시작하면 관리형 서비스의 중지를 먼저 기다립니다. 계속 작성을 선택해도 중지된 서비스는 자동으로 다시 시작하지 않습니다. 이미 버리기에 동의해 닫은 창은 복원하지 않습니다.')}</p>
  <p className="service-readiness-scope">{t('앱 종료 시 협력적 중지를 요청합니다. 별도 자식 프로세스, SSH, 앱·호스트 재시작 후 유지와 OS 자동 시작은 지원하지 않습니다.')}</p>
 </section>;
}
