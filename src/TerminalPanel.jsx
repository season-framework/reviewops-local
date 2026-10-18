import {t} from './i18n/index.js';
import React, {useEffect, useRef, useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {Button, TrustDialog, invoke} from './components.jsx';
import Icon from './icons.jsx';
import '@xterm/xterm/css/xterm.css';
import './terminal-panel.css';

export default function TerminalPanel({service,active=true,onError}) {
 const container=useRef(null),terminal=useRef(null),fit=useRef(null),session=useRef(null),sequence=useRef(0),mounted=useRef(false),cursor=useRef(0),timer=useRef(null),writeQueue=useRef(Promise.resolve()),errorHandler=useRef(onError);
 const [connected,setConnected]=useState(false),[connecting,setConnecting]=useState(false),[trust,setTrust]=useState(null),[error,setError]=useState('');
 errorHandler.current=onError;
 const report=error=>{if(!mounted.current)return;setError(error.message);errorHandler.current?.(error.message)};
 const end=async(showMessage=true)=>{sequence.current++;clearTimeout(timer.current);const id=session.current;session.current=null;cursor.current=0;if(mounted.current){setConnected(false);setConnecting(false)}if(id)await invoke('terminal.close',{id}).catch(()=>{});if(showMessage)terminal.current?.writeln(t("\r\n\u001b[90m연결 종료\u001b[0m"));};
 const dimensions=()=>({cols:Math.max(2,Math.min(500,terminal.current?.cols||80)),rows:Math.max(1,Math.min(300,terminal.current?.rows||24))});
 const resize=()=>{if(!container.current?.getClientRects().length||!fit.current||!terminal.current)return;try{const next=fit.current.proposeDimensions();if(next&&next.cols>0&&next.rows>0)terminal.current.resize(Math.max(2,Math.min(500,next.cols)),Math.max(1,Math.min(300,next.rows)))}catch{}};
 const poll=async(id,token)=>{
  if(!mounted.current||session.current!==id||sequence.current!==token)return;
  try{
   const result=await invoke('terminal.read',{id,cursor:cursor.current});
   if(!mounted.current||session.current!==id||sequence.current!==token)return;
   if(result.truncated)terminal.current?.write(t("\r\n\u001b[90m이전 출력 일부가 생략되었습니다.\u001b[0m\r\n"));
   if(result.data)terminal.current?.write(result.data);
   cursor.current=result.cursor;
   if(result.closed){if(result.error)report(new Error(result.error));await end(true);return;}
   timer.current=setTimeout(()=>poll(id,token),80);
  }catch(error){if(session.current===id&&sequence.current===token){report(error);await end(true);}}
 };
 const connect=async()=>{
  if(session.current||connecting)return;
  const token=++sequence.current;setConnecting(true);setError('');resize();
  try{
   const result=await invoke('terminal.open',{serviceId:service.id,...dimensions()});
   if(!mounted.current||sequence.current!==token){await invoke('terminal.close',{id:result.id}).catch(()=>{});return;}
   session.current=result.id;cursor.current=0;setConnected(true);setConnecting(false);terminal.current?.reset();terminal.current?.focus();poll(result.id,token);
  }catch(error){if(!mounted.current||sequence.current!==token)return;setConnecting(false);if(error.code==='SSH_TRUST_REQUIRED')setTrust({host:error.host||service.host,fingerprint:error.fingerprint});else report(error);}
 };
 useEffect(()=>{
  mounted.current=true;
  const instance=new Terminal({fontFamily:"'SFMono-Regular', Menlo, Monaco, monospace",fontSize:13,lineHeight:1.25,cursorBlink:true,scrollback:10000,convertEol:false,theme:{background:'#111827',foreground:'#e5e7eb',cursor:'#f8fafc',selectionBackground:'#334155'}});
  const addon=new FitAddon();instance.loadAddon(addon);instance.open(container.current);terminal.current=instance;fit.current=addon;
  instance.writeln(t("\u001b[90m연결 버튼을 누르면 SSH 터미널을 사용할 수 있습니다.\u001b[0m"));
  const input=instance.onData(data=>{const id=session.current;if(!id)return;for(let start=0;start<data.length;){let end=Math.min(data.length,start+4096);if(end<data.length&&data.charCodeAt(end-1)>=0xd800&&data.charCodeAt(end-1)<=0xdbff)end--;const chunk=data.slice(start,end);start=end;writeQueue.current=writeQueue.current.then(async()=>{if(session.current===id)await invoke('terminal.write',{id,data:chunk})}).catch(report);}});
  const changed=instance.onResize(size=>{const id=session.current;if(id)invoke('terminal.resize',{id,...size}).catch(error=>{if(session.current===id)report(error)})});
  const observer=new ResizeObserver(resize);observer.observe(container.current);resize();
  return()=>{mounted.current=false;end(false);observer.disconnect();input.dispose();changed.dispose();instance.dispose();terminal.current=null;fit.current=null;};
 },[service.id]);
 useEffect(()=>{if(active){requestAnimationFrame(()=>{resize();if(session.current)terminal.current?.focus()})}},[active]);
 return <section className="original-terminal-panel" aria-label={t("SSH 터미널")}><header><div><Icon name="terminal" size={16}/><strong>{service.username}@{service.host}</strong><span className={connected?'connected':''}>{connected?t("연결됨"):connecting?t("연결 중"):t("연결 안 됨")}</span></div><div>{connected||connecting?<Button type="button" onClick={()=>end(true)}>{t("종료")}</Button>:<Button type="button" icon="link" onClick={connect} disabled={service.kind!=='ssh'}>{t("연결")}</Button>}</div></header>{error&&<div className="terminal-error" role="alert">{error}</div>}<div ref={container} className="original-terminal-screen"/>{trust&&<TrustDialog trust={trust} onClose={()=>setTrust(null)} onTrust={async()=>{try{await invoke('ssh.trust',{serviceId:service.id,fingerprint:trust.fingerprint});setTrust(null);connect()}catch(error){setTrust(null);report(error)}}}/>}</section>;
}
