import React,{useEffect,useRef,useState} from 'react';
import Icon from './icons.jsx';
import PageHeader from './PageHeader.jsx';
import OpsManagement from './OpsManagement.jsx';
import {t} from './i18n/index.js';
import './Ops.css';
import './ops-global-panel.css';
export default function OpsGlobalPanel({open,onClose,controller,...props}){
 const [width,setWidth]=useState(()=>{try{return Math.max(320,Math.min(640,Number(localStorage.getItem('reviewops.ops.panelWidth'))||420))}catch{return 420}}),drag=useRef(null);
 const change=value=>setWidth(Math.max(320,Math.min(640,window.innerWidth-430,value)));
 useEffect(()=>{try{localStorage.setItem('reviewops.ops.panelWidth',String(width))}catch{}},[width]);
 const {state,error,loading,pending,command,refresh}=controller;
 return <aside className="ops-global-panel" style={{'--ops-panel-width':`${width}px`}} aria-label={t('Ops 대화 패널')} hidden={!open}>
  <div className="ops-panel-resize" role="separator" aria-label={t('Ops 패널 폭 조절')} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={640} aria-valuenow={width} tabIndex={0} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();change(event.key==='Home'?320:event.key==='End'?640:width+(event.key==='ArrowLeft'?20:-20))}}} onPointerDown={event=>{if(event.button!==0)return;drag.current={x:event.clientX,width};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault()}} onPointerMove={event=>{if(drag.current)change(drag.current.width+drag.current.x-event.clientX)}} onPointerUp={event=>{drag.current=null;event.currentTarget.releasePointerCapture?.(event.pointerId)}} onPointerCancel={()=>{drag.current=null}}/>
  <PageHeader className="ops-global-panel-heading" variant="section" headingLevel={2} title="Ops" actions={<button type="button" className="button" aria-label={t('Ops 대화 패널 닫기')} onClick={onClose}><Icon name="close" size={16}/></button>}/>
  {error&&<div role="alert" className="ops-error">{t(error)}<button type="button" className="button" onClick={()=>refresh().catch(()=>{})}>{t('다시 연결')}</button></div>}
  {loading&&!state?<p role="status">{t('대화 불러오는 중')}</p>:state&&<OpsManagement {...props} state={state} command={command} pending={pending} compact/>}
 </aside>;
}
