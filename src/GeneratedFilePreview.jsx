import {t} from './i18n/index.js';
import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import Icon from './icons.jsx';
import './agent.css';

export function useGeneratedFilePreview({reviewId,invoke}) {
 const [value,setValue]=useState(null),request=useRef(0),mounted=useRef(true),currentReview=useRef(reviewId);
 currentReview.current=reviewId;
 useEffect(()=>{mounted.current=true;setValue(null);return()=>{mounted.current=false;request.current++}},[reviewId]);
 const close=()=>{request.current++;setValue(null)};
 const open=async(path,runId,basePath)=>{
  const id=++request.current,context={path,runId,basePath};
  setValue({...context,loading:true});
  try {
   const file=await invoke('agent.fileRead',{reviewId,path,...(runId?{runId}:{}),...(basePath?{basePath}:{})});
   if(mounted.current&&currentReview.current===reviewId&&request.current===id)setValue({...context,file,loading:false});
  } catch(cause) {if(mounted.current&&currentReview.current===reviewId&&request.current===id)setValue({...context,loading:false,error:cause.message||String(cause)})}
 };
 const save=current=>invoke('agent.fileExport',{reviewId,path:current.file?.absolutePath||current.path,...(current.runId?{runId:current.runId}:{}),...(current.basePath?{basePath:current.basePath}:{})});
 return {value,open,close,save};
}

export default function GeneratedFilePreview({value,onClose,onSave,renderMarkdown,onFileLink}) {
 const overlay=useRef(null),dialog=useRef(null),[fullscreen,setFullscreen]=useState(false),[saving,setSaving]=useState(false),[notice,setNotice]=useState(''),[markdownMode,setMarkdownMode]=useState('preview');
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{setNotice('');setMarkdownMode('preview')},[value.path]);
 const close=()=>closeRef.current();
 useEffect(()=>{
  const previous=document.activeElement;dialog.current?.focus();
  const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(overlay.current?.classList.contains('is-fullscreen'))setFullscreen(false);else closeRef.current()}else if(event.key==='Tab'){const items=[...dialog.current.querySelectorAll('button:not(:disabled),a[href],iframe,[tabindex="0"]')],first=items[0],last=items.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus()}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){event.preventDefault();first?.focus()}}};
  document.addEventListener('keydown',key,true);
  return()=>{document.removeEventListener('keydown',key,true);if(previous?.isConnected)previous.focus()};
 },[]);
 const save=async()=>{setSaving(true);setNotice('');try{const result=await onSave(value);if(result?.saved)setNotice(t("{0} 저장 완료",[result.name||value.file?.name||t("파일")]))}catch(cause){setNotice(cause.message)}finally{setSaving(false)}};
 const file=value.file,mime=file?.mimeType||'',name=file?.name||value.path?.split('/').at(-1)||t("파일 미리보기"),markdown=/\.(md|markdown)$/i.test(name)||/^text\/markdown/i.test(mime),html=/\.html?$/i.test(name)||/^text\/html/i.test(mime);
 const openNested=path=>onFileLink(path,value.runId,file?.absolutePath||value.basePath);
 return createPortal(<div ref={overlay} className={`agent-generated-preview ${fullscreen?'is-fullscreen':''}`} onMouseDown={event=>{if(event.target===event.currentTarget)close()}}><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={name} className="agent-generated-dialog"><header><h2>{name}</h2><div>{file&&!value.error&&<button type="button" className="agent-generated-download" disabled={saving} onClick={save}>{saving?t("저장 중"):t("다운로드")}</button>}<button type="button" aria-label={fullscreen?t("전체화면 종료"):t("전체화면 보기")} title={fullscreen?t("전체화면 종료"):t("전체화면 보기")} aria-pressed={fullscreen} onClick={()=>setFullscreen(current=>!current)}><Icon name={fullscreen?'compress':'expand'} size={13}/></button><button type="button" aria-label={t("닫기")} onClick={close}><Icon name="close" size={13}/></button></div></header>{file&&markdown&&!value.error&&<div className="agent-generated-markdown-options" role="group" aria-label={t("문서 표시 방식")}><button type="button" aria-pressed={markdownMode==='preview'} onClick={()=>setMarkdownMode('preview')}>{t("문서 보기")}</button><button type="button" aria-pressed={markdownMode==='source'} onClick={()=>setMarkdownMode('source')}>{t("원문")}</button><small>{t("제목, 목록, 링크, 코드, 표, 체크 목록을 표시합니다.")}</small></div>}{notice&&<p role="status" className="agent-generated-notice">{notice}</p>}<div className="agent-generated-body">{value.loading?<p role="status" className="agent-generated-empty">{t("파일을 불러오는 중입니다.")}</p>:value.error?<p role="alert" className="agent-generated-empty form-error">{value.error}</p>:file?(markdown?(markdownMode==='source'?<pre className="agent-generated-text">{file.content||''}</pre>:<div className="agent-generated-markdown">{renderMarkdown(file.content||'',{onFileLink:openNested})}</div>):html&&file.content!==undefined?<iframe className="agent-generated-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" title={t("{0} HTML 미리보기",[name])} src={file.previewUrl||undefined} srcDoc={file.previewUrl?undefined:file.content}/>:mime.startsWith('image/')&&file.dataUrl?<div className="agent-generated-image"><img src={file.dataUrl} alt={name}/></div>:mime==='application/pdf'&&file.dataUrl?<iframe className="agent-generated-frame" title={t("{0} PDF 미리보기",[name])} src={file.dataUrl}/>:file.content!==undefined?<pre className="agent-generated-text">{file.content}</pre>:<p className="agent-generated-empty">{t("이 파일은 미리보기를 지원하지 않습니다. 다운로드하여 열 수 있습니다.")}</p>):null}</div></section></div>,document.body);
}
