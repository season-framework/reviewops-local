import React,{useEffect,useRef,useState} from 'react';
import RefreshIntervalField,{intervalValue} from './RefreshIntervalField.jsx';
import {t,useLocale} from './i18n/index.js';

export default function UsageRefreshSettings({bridge=window.accountManager}){
 useLocale();
 const [state,setState]=useState(null),[minutes,setMinutes]=useState('30'),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
 const previous=useRef(null),revision=useRef(0),inFlight=useRef(false);
 useEffect(()=>{
  let live=true;
  const receive=value=>{if(live&&value?.usageRefresh){revision.current++;setState(value.usageRefresh)}};
  const stop=bridge?.onState?.(receive),before=revision.current;
  bridge?.getState?.().then(value=>{if(before===revision.current)receive(value)}).catch(cause=>{if(live)setError(cause.message)});
  return()=>{live=false;stop?.()};
 },[bridge]);
 useEffect(()=>{if(!state)return;const next=String(state.intervalMinutes),prior=previous.current;setMinutes(current=>prior===null||current===prior?next:current);previous.current=next},[state?.intervalMinutes]);
 const save=async event=>{
  event.preventDefault();if(inFlight.current)return;
  const value=intervalValue(minutes,1);
  if(value===null){setError(t('계정 사용량 갱신 주기는 1~1440분 사이의 정수로 입력하십시오.'));return}
  inFlight.current=true;setSaving(true);setError('');setSaved(false);
  try{const result=await bridge.configureUsageRefresh(value);setState(result.usageRefresh);setMinutes(String(result.usageRefresh.intervalMinutes));setSaved(true)}
  catch(cause){setError(cause.message||String(cause))}
  finally{inFlight.current=false;setSaving(false)}
 };
 return <section className="settings-panel" aria-label={t('계정 사용량 자동 갱신')}>
  <div className="section-heading"><h2>{t('계정 사용량 자동 갱신')}</h2></div>
  <p>{t('ReviewOps가 실행 중이면 다른 화면을 보거나 창을 최소화해도 로그인한 계정의 사용량을 갱신합니다.')}</p>
  <form className="settings-interval-form" onSubmit={save} noValidate><RefreshIntervalField label={t('계정 사용량 갱신 주기')} value={minutes} onChange={value=>{setMinutes(value);setSaved(false)}} min={1} presets={[1,5,15,30,60,120,360,1440]} disabled={!state||saving}/><button type="submit" className="button" disabled={!state||saving||String(state.intervalMinutes)===minutes}>{saving?t('저장 중'):t('주기 저장')}</button></form>
  <p className="muted">{t('기본 30분이며, 저장한 주기는 즉시 적용되고 앱을 다시 실행해도 유지됩니다.')}</p>
  {saved&&<p className="settings-save-note" aria-live="polite">{t('주기를 저장했습니다.')}</p>}
  {error&&<p className="form-error" role="alert">{t(error)}</p>}
 </section>;
}
