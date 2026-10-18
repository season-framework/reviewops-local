import {t} from './i18n/index.js';
import React,{useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button,Dialog,FileContent,size} from './components.jsx';
import Icon from './icons.jsx';
import {tabKeyboard} from './tabKeyboard.js';

const logTypes=[['navigation','이동','navigation_log'],['input','입력','input_log'],['network','트래픽','network_log'],['console','콘솔','console_log'],['fingerprint','환경','fingerprint_log']];
const count=value=>Array.isArray(value)?value.length:value&&typeof value==='object'?Object.keys(value).length?1:0:0;
export const logCaptures=evidence=>evidence?.log_captures?.length?evidence.log_captures:logTypes.some(([, ,field])=>count(evidence?.[field]))?[evidence]:[];

export default function TimelineAttachments({files,captures,invoke,mutate,busy,renderLogs}) {
  const [preview,setPreview]=useState(null),[deleting,setDeleting]=useState(null),[pending,setPending]=useState(false),[notice,setNotice]=useState('');
  const request=useRef(0),uid=useId();
  useEffect(()=>()=>{request.current++},[]);
  const close=()=>{request.current++;setPreview(null);setNotice('')};
  const open=async file=>{
    const current=++request.current;setNotice('');setPreview({file,loading:true});
    try {const content=await invoke('attachment.read',{id:file.id});if(request.current===current)setPreview({file,content});}
    catch(error){if(request.current===current)setPreview({file,error:error.message});}
  };
  const openLogs=(capture,index)=>{
    request.current++;setNotice('');
    setPreview({capture,name:capture.label||t('로그 {0}',[index+1]),kind:logTypes.find(([, ,field])=>count(capture[field]))?.[0]||'navigation'});
  };
  const save=async()=>{setPending(true);setNotice('');try{const result=await invoke('attachment.export',{id:preview.file.id});if(!result?.cancelled)setNotice(t('저장 완료'));}catch(error){setNotice(error.message);}finally{setPending(false);}};
  if(!files.length&&!captures.length)return null;
  const name=preview?.file?.name||preview?.name;
  return <>
    <section className="review-chat-attachments" aria-label={t('메시지 첨부 파일')}>
      <div className="review-chat-attachment-label"><Icon name="attach" size={12}/><span>{t('첨부 파일')+' '}{files.length+captures.length}{t('개')}</span></div>
      <div className="review-chat-attachment-buttons">
        {files.map(file=><button key={file.id} type="button" className="review-chat-attachment-button" aria-label={t('{0} 열기',[file.name])} aria-haspopup="dialog" title={`${file.name} · ${size(file.size)}`} onClick={()=>open(file)}><Icon name={file.mimeType?.startsWith('image/')?'image':'file'} size={14}/><span>{file.name}</span><Icon name="expand" size={11}/></button>)}
        {captures.map((capture,index)=><button key={capture.id||index} type="button" className="review-chat-attachment-button is-log" aria-label={t('{0} 열기',[capture.label||t('로그 {0}',[index+1])])} aria-haspopup="dialog" title={capture.capturedAt||capture.captured_at?new Date(capture.capturedAt||capture.captured_at).toLocaleString():t('로그 정보 보기')} onClick={()=>openLogs(capture,index)}><Icon name="terminal" size={14}/><span>{capture.label||t('로그 {0}',[index+1])}</span><Icon name="expand" size={11}/></button>)}
      </div>
    </section>
    {preview&&createPortal(<div className="review-chat-preview"><Dialog title={name} onClose={close} wide footer={preview.file&&<><span className="review-chat-preview-meta">{preview.file.mimeType||t('파일')} · {size(preview.file.size)}</span><Button icon="download" disabled={pending} aria-label={t('{0} 저장',[name])} onClick={save}>{t('다운로드')}</Button><Button icon="trash" disabled={busy||pending} aria-label={t('{0} 삭제',[name])} onClick={()=>setDeleting(preview.file)}>{t('삭제')}</Button></>}>
      {notice&&<p className="review-chat-preview-notice" role="status">{notice}</p>}
      {preview.loading?<p className="review-chat-preview-empty" role="status">{t('파일을 불러오는 중입니다.')}</p>:preview.error?<p className="review-chat-preview-empty form-error" role="alert">{preview.error}</p>:preview.capture?<>
        <nav className="review-chat-log-tabs reviewops-tab-strip" role="tablist" aria-label={t('로그 종류')} onKeyDown={tabKeyboard}>{logTypes.map(([kind,label,field])=><button key={kind} type="button" role="tab" id={`${uid}-${kind}`} aria-controls={`${uid}-logs`} aria-selected={preview.kind===kind} tabIndex={preview.kind===kind?0:-1} className={`reviewops-tab ${preview.kind===kind?'is-active':''}`} onClick={()=>setPreview(current=>({...current,kind}))}>{t(label)}<span>{count(preview.capture[field])}</span></button>)}</nav>
        <div className="review-chat-log-content" role="tabpanel" id={`${uid}-logs`} aria-labelledby={`${uid}-${preview.kind}`} tabIndex={0}>{renderLogs(preview.capture,preview.kind)}</div>
      </>:<FileContent file={preview.content}/>}
    </Dialog></div>,document.body)}
    {deleting&&createPortal(<Dialog title={t('첨부 파일 삭제')} onClose={()=>{if(!pending)setDeleting(null)}} footer={<><Button disabled={pending} onClick={()=>setDeleting(null)}>{t('취소')}</Button><Button variant="danger" disabled={busy||pending} onClick={async()=>{setPending(true);try{const result=await mutate('attachment.delete',{id:deleting.id},t('첨부 파일 삭제 완료'));if(result){setDeleting(null);close();}}finally{setPending(false);}}}>{t('삭제')}</Button></>}><p>‘{deleting.name}{t('’ 파일을 삭제합니다.')}</p></Dialog>,document.body)}
  </>;
}
