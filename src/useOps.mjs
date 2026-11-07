import {useCallback,useEffect,useRef,useState} from 'react';
import {t} from './i18n/index.js';
import {chooseOpsSnapshot,errorText} from './OpsState.mjs';

export default function useOps(bridge){
 const [state,setState]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[pending,setPending]=useState(new Set());
 const current=useRef(null),live=useRef(false),tasks=useRef(new Map()),sequence=useRef(0);
 const receive=useCallback(value=>{const next=chooseOpsSnapshot(current.current,value);if(next&&next!==current.current){current.current=next;if(live.current){setState(next);setError('');setLoading(false)}}return current.current},[]);
 const refresh=useCallback(async()=>{if(!bridge?.snapshot)throw new Error(t('Ops 연결을 사용할 수 없습니다.'));const id=++sequence.current;setLoading(!current.current);try{const result=await bridge.snapshot();if(live.current&&id===sequence.current)receive(result);return current.current}catch(cause){if(live.current&&id===sequence.current){setError(errorText(cause));setLoading(false)}throw cause}},[bridge,receive]);
 useEffect(()=>{live.current=true;if(!bridge){setLoading(false);return()=>{live.current=false;sequence.current++}}const stop=bridge?.onState?.(value=>receive(value));refresh().catch(()=>{});return()=>{live.current=false;sequence.current++;stop?.()}},[bridge,receive,refresh]);
 const command=useCallback((method,payload,key)=>{
  if(tasks.current.has(key))return tasks.current.get(key);
  if(!bridge?.[method])return Promise.reject(new Error(t('Ops 연결을 사용할 수 없습니다.')));
  const task=Promise.resolve().then(()=>bridge[method](payload)).then(value=>{if(live.current)return receive(value);return value}).finally(()=>{if(tasks.current.get(key)===task)tasks.current.delete(key);if(live.current)setPending(new Set(tasks.current.keys()))});
  tasks.current.set(key,task);setPending(new Set(tasks.current.keys()));return task;
 },[bridge,receive]);
 return {state,error,loading,pending,refresh,command};
}
