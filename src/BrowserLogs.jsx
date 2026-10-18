import {t,localized} from './i18n/index.js';
import React,{useEffect,useState} from 'react';
import Icon from './icons.jsx';
import {tabKeyboard} from './tabKeyboard.js';
import './browser-logs.css';

const KINDS=localized([['navigation','이동'],['input','입력'],['network','트래픽'],['console','콘솔'],['fingerprint','환경']]);
export default function BrowserLogs({collect,onClear,onClose,onError}) {
 const [kind,setKind]=useState('console'),[evidence,setEvidence]=useState(null),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true,pending=false;const load=async()=>{if(pending)return;pending=true;try{const value=await collect();if(live)setEvidence(value)}catch(error){if(live)onError?.(error.message)}finally{pending=false}};load();const timer=setInterval(load,1200);return()=>{live=false;clearInterval(timer)}},[collect]);
 const value=evidence?.[kind+'_log'],rows=Array.isArray(value)?value:value?[value]:[];
 const clear=async key=>{setBusy(true);try{await onClear(key);setEvidence(await collect())}catch(error){onError?.(error.message)}finally{setBusy(false)}};
 return <section className="viewer-log-panel" aria-label={t("뷰어 로그")}><header><strong>{t("로그")}</strong><button type="button" aria-label={t("뷰어 로그 닫기")} onClick={onClose}><Icon name="close" size={15}/></button></header><nav className="reviewops-tab-strip" aria-label={t("뷰어 로그 종류")} onKeyDown={tabKeyboard}>{KINDS.map(([key,label])=><button key={key} type="button" className="reviewops-tab" tabIndex={kind===key?0:-1} aria-pressed={kind===key} onClick={()=>setKind(key)}>{label}<span className="reviewops-tab-count">{Array.isArray(evidence?.[key+'_log'])?evidence[key+'_log'].length:key==='fingerprint'&&Object.keys(evidence?.fingerprint_log||{}).length?1:0}</span></button>)}</nav><div className="viewer-log-actions"><button type="button" disabled={busy||!onClear||kind==='fingerprint'} onClick={()=>clear(kind)}>{t("선택 로그 지우기")}</button><button type="button" disabled={busy||!onClear} onClick={()=>clear('all')}>{t("전체 지우기")}</button></div><div className="viewer-log-entries" role="log">{rows.length?rows.map((row,index)=><pre key={index}>{JSON.stringify(row,null,2)}</pre>):<p>{t("수집된 로그가 없습니다.")}</p>}</div></section>;
}
