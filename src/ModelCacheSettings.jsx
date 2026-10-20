import React,{useCallback,useEffect,useRef,useState} from 'react';
import Icon from './icons.jsx';
import RefreshIntervalField,{intervalValue} from './RefreshIntervalField.jsx';
import {getLocale,t,useLocale} from './i18n/index.js';
import './settings-layout.css';

const cacheInvoke=(action,payload)=>window.reviewops?.invoke?window.reviewops.invoke(action,payload):Promise.reject(new Error(t('모델 목록을 불러오지 못했습니다.')));
export const cacheTime=value=>{if(!value)return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString(getLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})};
export const cacheModels=target=>Array.isArray(target?.models)?target.models:[];
export const cacheLabel=target=>target?.id==='local'?t('이 컴퓨터'):target?.id?.startsWith('local:')?`${t('이 컴퓨터')}${(target.label||'').replace(/^이 컴퓨터/,'')}`:target?.label||target?.id||'';

export function useModelCacheState(invoke=cacheInvoke){
 const [state,setState]=useState(null),[error,setError]=useState(''),revision=useRef(0),live=useRef(false);
 useEffect(()=>{
  live.current=true;const receive=value=>{if(live.current&&Array.isArray(value?.targets)){revision.current++;setState(value);setError('')}};
  const stop=window.reviewops?.onModelCacheState?.(receive),before=revision.current;
  invoke('modelCache.state').then(value=>{if(live.current&&before===revision.current)receive(value)}).catch(cause=>{if(live.current&&before===revision.current)setError(cause.message||String(cause))});
  return()=>{live.current=false;stop?.()};
 },[invoke]);
 const command=useCallback(async(name,payload)=>{
  const before=revision.current,value=await invoke(`modelCache.${name}`,payload);
  if(live.current&&before===revision.current&&Array.isArray(value?.targets)){revision.current++;setState(value);setError('')}
  return value;
 },[invoke]);
 return {state,error,command};
}

export function ModelCatalog({target,showErrors=true}){
 const models=cacheModels(target),cachedAt=cacheTime(target?.cachedAt||target?.updatedAt);
 return <div className="model-catalog">
  <p className="model-cache-date">{cachedAt?t('마지막 수집: {0}',[cachedAt]):t('아직 수집하지 않았습니다.')}</p>
  {showErrors&&target?.error&&<div className="model-cache-failure" role="status"><p>{t('수집하지 못했습니다.')} {models.length?t('이전에 수집한 모델 목록을 유지합니다.'):null}</p><p>{t(target.error)}</p></div>}
  {target?.defaultModel&&<p>{t('기본 모델: {0}',[target.defaultModel])}</p>}
  {target?.defaultReasoningEffort&&<p>{t('기본 추론 수준: {0}',[target.defaultReasoningEffort])}</p>}
  {models.length?<ul className="model-catalog-list">{models.map(model=><li key={model.id}><div><strong>{model.label||model.id}</strong>{model.label&&model.label!==model.id&&<code>{model.id}</code>}</div><dl><div><dt>{t('지원 추론 수준')}</dt><dd>{(model.reasoning||[]).map(value=>typeof value==='string'?value:value.effort||value.id).filter(Boolean).join(', ')||'—'}</dd></div>{model.defaultReasoningEffort&&<div><dt>{t('기본 추론 수준')}</dt><dd>{model.defaultReasoningEffort}</dd></div>}</dl></li>)}</ul>:<p className="muted">{t('저장된 모델 목록이 없습니다.')}</p>}
 </div>;
}

export default function ModelCacheSettings({invoke=cacheInvoke}){
 useLocale();
 const {state,error:loadError,command}=useModelCacheState(invoke),[minutes,setMinutes]=useState('60'),[error,setError]=useState(''),[pending,setPending]=useState(''),[saved,setSaved]=useState(false),previous=useRef(null),inFlight=useRef(false);
 useEffect(()=>{if(!state)return;const next=String(state.intervalMinutes??60),prior=previous.current;setMinutes(current=>prior===null||current===prior?next:current);previous.current=next},[state?.intervalMinutes]);
 const action=async(name,payload)=>{if(inFlight.current)return;inFlight.current=true;setPending(name);setError('');setSaved(false);try{await command(name,payload);if(name==='configure'){setMinutes(String(payload.intervalMinutes));setSaved(true)}}catch(cause){setError(cause.message||String(cause))}finally{inFlight.current=false;setPending('')}};
 const save=event=>{event.preventDefault();const value=intervalValue(minutes,5);if(value===null){setError(t('모델 목록 수집 주기는 5~1440분 사이의 정수로 입력하십시오.'));return}action('configure',{intervalMinutes:value})};
 return <section className="settings-panel model-cache-settings" aria-label={t('모델 목록 자동 수집')}>
  <div className="section-heading"><h2>{t('모델 목록 자동 수집')}</h2><button type="button" className="button" disabled={!state||Boolean(pending)||state.refreshing} onClick={()=>action('refresh')}><Icon name="refresh" size={16}/>{pending==='refresh'||state?.refreshing?t('수집 중'):t('지금 수집')}</button></div>
  <p>{t('로컬과 등록된 SSH 호스트의 모델 목록을 정해진 간격으로 불러옵니다.')}</p>
  <form className="settings-interval-form" onSubmit={save} noValidate><RefreshIntervalField label={t('모델 목록 수집 주기')} value={minutes} onChange={value=>{setMinutes(value);setSaved(false)}} min={5} presets={[5,15,30,60,120,360,1440]} disabled={!state||Boolean(pending)}/><button className="button" type="submit" disabled={!state||Boolean(pending)||String(state.intervalMinutes??60)===minutes}>{t('주기 저장')}</button></form>
  {saved&&<p className="settings-save-note" aria-live="polite">{t('주기를 저장했습니다.')}</p>}
  {(error||loadError)&&<p className="form-error" role="alert">{t(error||loadError)}</p>}
  <div className="model-cache-targets">{state?.targets?.map(target=><details key={target.id}><summary><strong>{cacheLabel(target)}</strong><span>{t('모델 {0}개',[cacheModels(target).length])}</span><small>{target.error?(cacheModels(target).length?t('수집 실패 · 이전 목록 사용'):t('수집하지 못했습니다.')):cacheTime(target.cachedAt||target.updatedAt)?t('마지막 수집: {0}',[cacheTime(target.cachedAt||target.updatedAt)]):t('아직 수집하지 않았습니다.')}</small></summary><ModelCatalog target={target}/></details>)}</div>
 </section>;
}
