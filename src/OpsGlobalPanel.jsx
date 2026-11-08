import React,{useEffect,useRef,useState} from 'react';
import Icon from './icons.jsx';
import OpsManagement from './OpsManagement.jsx';
import {t} from './i18n/index.js';
import './Ops.css';
import './ops-global-panel.css';
export default function OpsGlobalPanel({open,onClose,controller,...props}){
 const [preferredWidth,setPreferredWidth]=useState(()=>{try{return Math.max(320,Math.min(640,Number(localStorage.getItem('reviewops.ops.panelWidth'))||420))}catch{return 420}}),[maximum,setMaximum]=useState(640),drag=useRef(null),panel=useRef(null),width=Math.min(preferredWidth,maximum);
 const change=value=>setPreferredWidth(Math.max(320,Math.min(maximum,value)));
 useEffect(()=>{try{localStorage.setItem('reviewops.ops.panelWidth',String(preferredWidth))}catch{}},[preferredWidth]);
 useEffect(()=>{const host=panel.current?.parentElement;if(!host)return;const measure=()=>setMaximum(Math.max(320,Math.min(640,Math.floor(host.getBoundingClientRect().width)-280)));measure();const observer=new ResizeObserver(measure);observer.observe(host);return()=>observer.disconnect()},[]);
 const {state,error,loading,pending,command,refresh}=controller;
 return <aside ref={panel} className="ops-global-panel" style={{'--ops-panel-width':`${width}px`}} aria-label={t('Ops 대화 패널')} hidden={!open}>
  <div className="ops-panel-resize" role="separator" aria-label={t('Ops 패널 폭 조절')} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={maximum} aria-valuenow={width} tabIndex={0} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();change(event.key==='Home'?320:event.key==='End'?maximum:width+(event.key==='ArrowLeft'?20:-20))}}} onPointerDown={event=>{if(event.button!==0)return;drag.current={x:event.clientX,width};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault()}} onPointerMove={event=>{if(drag.current)change(drag.current.width+drag.current.x-event.clientX)}} onPointerUp={event=>{drag.current=null;event.currentTarget.releasePointerCapture?.(event.pointerId)}} onPointerCancel={()=>{drag.current=null}}/>
  {!state&&<header className="ops-management-header"><h2 className="ops-management-brand">Ops</h2><span className="ops-management-conversation-name"/><button type="button" className="button ops-management-close" aria-label={t('Ops 대화 패널 닫기')} onClick={onClose}><Icon name="close" size={16}/></button></header>}
  {error&&<div role="alert" className="ops-error">{t(error)}<button type="button" className="button" onClick={()=>refresh().catch(()=>{})}>{t('다시 연결')}</button></div>}
  {loading&&!state?<p role="status">{t('대화 불러오는 중')}</p>:state&&<OpsManagement {...props} state={state} command={command} pending={pending} onClose={onClose} compact/>}
 </aside>;
}
