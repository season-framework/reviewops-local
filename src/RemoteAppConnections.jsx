import React,{useEffect,useRef,useState} from 'react';
import {t,useLocale} from './i18n/index.js';
import {readObservedReview,observedCommand,sameWriteObservation,captureWriteObservation} from './remote/write-observation.mjs';
import {uploadRemoteAttachment,downloadRemoteAttachment,captureTimelineAttachment,REMOTE_FILE_BYTES} from './remote/attachments.mjs';

export default function RemoteAppConnections({invoke,active=true}){
 useLocale();
 const [hosts,setHosts]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [form,setForm]=useState({id:'',label:'',address:'',port:'9444',certificatePEM:'',certificateFingerprint:'',invitation:''});
 const [verified,setVerified]=useState(false),[selected,setSelected]=useState(''),[projects,setProjects]=useState([]),[reviews,setReviews]=useState([]),[projectId,setProjectId]=useState(''),[reviewId,setReviewId]=useState('');
 const [detail,setDetail]=useState(null),[timeline,setTimeline]=useState(null),[editor,setEditor]=useState({title:'',body:'',priority:'normal',category:'ux'});
 const [comment,setComment]=useState(''),[prompt,setPrompt]=useState(''),[followup,setFollowup]=useState(null),[pendingCommand,setPendingCommand]=useState(null);
 const [uploadFile,setUploadFile]=useState(null),[uploadActivity,setUploadActivity]=useState(''),[transfer,setTransfer]=useState(null),[pendingUploads,setPendingUploads]=useState([]);
 const [observed,setObserved]=useState(null),[freshness,setFreshness]=useState({at:null,stale:true}),[draftConflict,setDraftConflict]=useState(false);
 const observedRef=useRef(null);
 const alive=useRef(true),pending=useRef(false);
 const selection=useRef(null),fileInput=useRef(null);selection.current={id:selected,projectId,reviewId,active};
 const drafts=useRef(new Map()),draftKey=[selected,projectId,reviewId].join(':');
 const saveDraft=patch=>{const draft={...(drafts.current.get(draftKey)||{}),...patch};if(!draft.editor&&!draft.comment&&!draft.prompt)drafts.current.delete(draftKey);else drafts.current.set(draftKey,draft);};
 const editReview=patch=>setEditor(previous=>{const value={...previous,...patch};saveDraft({editor:value,binding:drafts.current.get(draftKey)?.binding||observedRef.current});return value;});
 useEffect(()=>{const draft=drafts.current.get(draftKey);setEditor(draft?.editor||{title:'',body:'',priority:'normal',category:'ux'});setComment(draft?.comment||'');setPrompt(draft?.prompt||'');setUploadFile(null);setUploadActivity('');setTransfer(null);observedRef.current=null;setObserved(null);setDraftConflict(false);setFreshness({at:null,stale:true});},[draftKey]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const state=async()=>{
  const result=await invoke('remoteApp.state');if(!Array.isArray(result?.connections)||!Array.isArray(result.pendingCommands))throw new Error();
  if(alive.current){setHosts(result.connections);setPendingCommand(current=>{
   const saved=result.pendingCommands.find(row=>row.id===current?.id&&row.requestId===current?.envelope?.requestId)||result.pendingCommands[0];
   return saved?current?.id===saved.id&&current?.envelope?.requestId===saved.requestId?current:{id:saved.id,envelope:{requestId:saved.requestId,epoch:saved.epoch,projectId:saved.projectId,operation:saved.operation}}:null;
  });setPendingUploads(Array.isArray(result.pendingUploads)?result.pendingUploads:[]);}
 };
 const perform=async(action)=>{
  if(pending.current||!active)return;pending.current=true;setBusy(true);setError('');setMessage('');
  try{await action();await state();}
  catch(cause){if(alive.current){setFreshness(previous=>({...previous,stale:true}));setError(t('원격 요청을 완료하지 못했습니다. 연결과 권한을 확인하십시오. ({0})',[typeof cause?.code==='string'?cause.code:'CONNECTION_UNAVAILABLE']));}
   // A lost reply can still have a durable host result. Refresh the main-owned
   // request ledger before offering another upload or command.
   try{await state();}catch{}
  }
  finally{pending.current=false;if(alive.current)setBusy(false);}
 };
 useEffect(()=>{if(active)perform(state)},[active,invoke]);
 const change=(key,value)=>{setForm(previous=>({...previous,[key]:value}));setVerified(false)};
 const certificate=async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{
   if(file.size>32768)throw new Error();const pem=await file.text(),match=/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);if(!match)throw new Error();
   const raw=Uint8Array.from(atob(match[1].replace(/\s/g,'')),char=>char.charCodeAt(0));
   const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',raw))].map(value=>value.toString(16).padStart(2,'0')).join('');
   setForm(previous=>({...previous,certificatePEM:pem,certificateFingerprint:fingerprint}));setVerified(false);
  }catch{setError(t('공개 인증서를 읽지 못했습니다. 작업 PC에서 내보낸 인증서를 선택하십시오.'));}
 };
 const host=hosts.find(row=>row.id===selected),grant=host?.state==='approved'?host?.remote?.grants?.find(row=>row.projectId===projectId):null;
 const read=(operation,payload)=>invoke('remoteApp.read',{id:selected,operation,payload});
 const loadProjects=()=>perform(async()=>{await invoke('remoteApp.refresh',{id:selected});const value=await read('projects.list',{});setProjects(value.projects);});
 const loadReviews=()=>perform(async()=>{const {original,assertCurrent}=viewOwner();const value=await read('reviews.list',{projectId});assertCurrent();setReviews(value.reviews);if(!original.reviewId)await loadCreateState(original,assertCurrent);});
 const viewOwner=()=>{
  const original={id:selected,projectId,reviewId},key=draftKey;
  const assertCurrent=()=>{const current=selection.current;if(!alive.current||!current.active||
   current.id!==original.id||current.projectId!==original.projectId||current.reviewId!==original.reviewId)
   throw Object.assign(new Error(),{code:'STALE_REMOTE_VIEW'});};
  assertCurrent();return {original,key,assertCurrent};
 };
 const loadCreateState=async(original,assertCurrent)=>{
  const target={projectId:original.projectId,reviewId:''},binding=captureWriteObservation(await invoke('remoteApp.writeState',{id:original.id,...target}),target);assertCurrent();
  observedRef.current=binding;setObserved(binding);const draft=drafts.current.get([original.id,original.projectId,''].join(':'));
  setDraftConflict(Boolean(draft?.binding&&!sameWriteObservation(draft.binding,binding)));setFreshness({at:Date.now(),stale:false});
 };
 const loadDetail=async()=>{
  const {original,key,assertCurrent}=viewOwner();
  const result=await readObservedReview({projectId:original.projectId,reviewId:original.reviewId,assertCurrent,
   writeState:payload=>invoke('remoteApp.writeState',{id:original.id,...payload}),
   read:(operation,payload)=>invoke('remoteApp.read',{id:original.id,operation,payload})});
  assertCurrent();observedRef.current=result.binding;setObserved(result.binding);setDetail(result.review);setTimeline(result.timeline);
  const draft=drafts.current.get(key);setDraftConflict(Boolean(draft?.binding&&!sameWriteObservation(draft.binding,result.binding)));
  if(!draft?.editor)setEditor(({title:result.review.title,body:result.review.body,priority:result.review.priority,category:result.review.category}));
  setFreshness({at:Date.now(),stale:false});return result;
 };
 const refreshView=async()=>{
  const {original,assertCurrent}=viewOwner();await invoke('remoteApp.refresh',{id:original.id});assertCurrent();
  const value=await invoke('remoteApp.read',{id:original.id,operation:'projects.list',payload:{}});assertCurrent();setProjects(value.projects);
  if(original.projectId){const value=await invoke('remoteApp.read',{id:original.id,operation:'reviews.list',payload:{projectId:original.projectId}});assertCurrent();setReviews(value.reviews);}
  if(original.reviewId)await loadDetail();else if(original.projectId)await loadCreateState(original,assertCurrent);else setFreshness({at:Date.now(),stale:false});
 };
 // A background read never sends a mutation or substitutes a fresh revision for
 // a draft. Selection ownership is checked after every asynchronous boundary.
 useEffect(()=>{
  if(!active||!selected)return;let retired=false;
  const refresh=async()=>{if(retired||pending.current)return;pending.current=true;setBusy(true);
   try{await refreshView();if(!retired)await state();}
   catch{if(!retired&&alive.current){setFreshness(previous=>({...previous,stale:true}));try{await state();}catch{}}}
   finally{pending.current=false;if(alive.current)setBusy(false);}
  };
  const timer=setInterval(refresh,15000);return()=>{retired=true;clearInterval(timer);};
 },[active,selected,projectId,reviewId,invoke]);
 const finishCommand=async(record,value)=>{
  if(value.state==='pending'){setMessage(t('처리 결과를 기다리고 있습니다. 요청을 다시 실행하지 마십시오.'));return;}
  if(value.state!=='completed')throw Object.assign(new Error(),{code:value.errorCode||'COMMAND_FAILED'});
  setPendingCommand(null);if(value.result?.followupId)setFollowup(value.result.followupId);
  // Clear only the exact submitted draft after its durable success. A lost
  // reply followed by result lookup takes this same path and cannot resend it.
  if(record.key&&record.payload){const draft=drafts.current.get(record.key);
   if(record.envelope.operation==='comment.add'&&draft?.comment===record.payload.body){draft.comment='';if(record.key===draftKey)setComment('');}
   if(['agent.start','agent.followup'].includes(record.envelope.operation)&&draft?.prompt===record.payload.prompt){draft.prompt='';if(record.key===draftKey)setPrompt('');}
   if(record.envelope.operation==='agent.followup.start')setFollowup(null);
   if(['review.create','review.update'].includes(record.envelope.operation)&&draft?.editor&&JSON.stringify(draft.editor)===JSON.stringify(record.payload))delete draft.editor;
   if(draft&&!draft.editor&&!draft.comment&&!draft.prompt)drafts.current.delete(record.key);
  }
  setMessage(t('작업 PC에서 요청을 처리했습니다. 결과를 새로고침하여 확인하십시오.'));
  if(record.id===selected&&reviewId)await loadDetail();
 };
 const command=(operation,payload)=>perform(async()=>{
  if(pendingCommand)throw Object.assign(new Error(),{code:'UNRESOLVED_COMMAND'});
  const {original,key,assertCurrent}=viewOwner(),draft=drafts.current.get(key);
  const binding=draft?.binding||observedRef.current;
  assertCurrent();const envelope=observedCommand({operation,requestId:crypto.randomUUID(),projectId,reviewId,payload,binding});
  const record={id:original.id,envelope,key,payload};setPendingCommand(record);
  let value;
  try{value=await invoke('remoteApp.command',{id:original.id,envelope});}
  catch(cause){if(['INVALID_COMMAND','REVISION_CONFLICT','STALE_REVIEW'].includes(cause?.code))setPendingCommand(null);if(['REVISION_CONFLICT','STALE_REVIEW'].includes(cause?.code))setDraftConflict(true);throw cause;}
  assertCurrent();await finishCommand(record,value);
 });
 const checkResult=()=>perform(async()=>{
  const record=pendingCommand,{id,envelope}=record;
  const value=await invoke('remoteApp.result',{id,requestId:envelope.requestId,epoch:envelope.epoch,projectId:envelope.projectId});
  await finishCommand(record,value);
 });
 const transferOwner=()=>{
  const original=Object.freeze({id:selected,projectId,reviewId});
  const assertCurrent=()=>{const current=selection.current;if(!alive.current||!current.active||
   current.id!==original.id||current.projectId!==original.projectId||current.reviewId!==original.reviewId)
   throw Object.assign(new Error(),{code:'STALE_ATTACHMENT_VIEW'});};
  assertCurrent();return {original,assertCurrent,call:(operation,payload)=>{
   assertCurrent();return invoke('remoteApp.attachment',{id:original.id,operation,payload});
  }};
 };
 const chooseUpload=event=>{const file=event.target.files?.[0]||null;
  if(file&&file.size>REMOTE_FILE_BYTES){setUploadFile(null);event.target.value='';setError(t('10 MiB 이하의 파일을 선택하십시오.'));return;}
  setUploadFile(file);setTransfer(null);setError('');
 };
 const upload=()=>perform(async()=>{
  const {original,assertCurrent,call}=transferOwner(),file=uploadFile,activityId=uploadActivity||null;
  if(!file||pendingUploads.some(row=>row.id===original.id&&row.projectId===original.projectId&&row.reviewId===original.reviewId))
   throw Object.assign(new Error(),{code:'UNRESOLVED_UPLOAD'});
  const revision=await invoke('remoteApp.writeState',{...original});assertCurrent();
  const result=await uploadRemoteAttachment({file,scope:{projectId:original.projectId,reviewId:original.reviewId},activityId,revision,
   requestId:crypto.randomUUID(),call,assertCurrent,onProgress:value=>{assertCurrent();setTransfer({name:file.name,...value});}});
  assertCurrent();setUploadFile(null);if(fileInput.current)fileInput.current.value='';
  setMessage(t('작업 PC에 첨부파일을 저장했습니다.'));await loadDetail();return result;
 });
 const download=file=>perform(async()=>{
  const {original,assertCurrent,call}=transferOwner();
  const result=await downloadRemoteAttachment({scope:{projectId:original.projectId,reviewId:original.reviewId},expected:captureTimelineAttachment(file),call,assertCurrent,
   onProgress:value=>{assertCurrent();setTransfer({name:file.name,...value});}});assertCurrent();
  // Preserve the filename while saving inert binary; never navigate to shared
  // HTML/SVG under the renderer's application origin.
  const url=URL.createObjectURL(new Blob([result.bytes],{type:'application/octet-stream'})),link=document.createElement('a');
  try{link.href=url;link.download=result.attachment.name;link.hidden=true;document.body.appendChild(link);link.click();}
  finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  setMessage(t('파일의 전체 SHA-256을 확인하고 다운로드를 시작했습니다.'));
 });
 const uploadResult=row=>perform(async()=>{
  const result=await invoke('remoteApp.attachment',{id:row.id,operation:'result',payload:{requestId:row.requestId,
   epoch:row.epoch,projectId:row.projectId,reviewId:row.reviewId}});
  if(result?.state!=='committed'||result.requestId!==row.requestId||result.projectId!==row.projectId||result.reviewId!==row.reviewId)
   throw Object.assign(new Error(),{code:'INVALID_ATTACHMENT_RESPONSE'});
  setMessage(t('작업 PC의 첨부파일 저장 결과를 확인했습니다.'));
  if(selected===row.id&&projectId===row.projectId&&reviewId===row.reviewId)await loadDetail();
 });
 if(!active)return null;
 return <section className="settings-panel remote-app-connections" aria-label={t('다른 PC에 원격 접속')}>
  <h2>{t('다른 PC에 원격 접속')}</h2><p>{t('작업 PC의 IP·포트와 초대 정보를 입력하십시오. 자료 저장과 에이전트 실행은 작업 PC에서 처리합니다.')}</p>
  {error&&<p role="alert" className="form-error">{error}</p>}{message&&<p role="status">{message}</p>}
  <form onSubmit={event=>{event.preventDefault();perform(async()=>{const value=await invoke('remoteApp.connect',{...form,port:Number(form.port)});setSelected(value.id);setForm(previous=>({...previous,invitation:''}));setMessage(t('작업 PC에서 이 앱의 프로젝트 권한을 승인한 뒤 연결 상태를 확인하십시오.'));});}}>
   <div className="field-row"><label>{t('연결 이름')}<input value={form.label} onChange={event=>change('label',event.target.value)} maxLength={120} required disabled={busy}/></label><label>{t('작업 PC IPv4 주소')}<input value={form.address} onChange={event=>change('address',event.target.value)} maxLength={15} required disabled={busy}/></label><label>{t('포트')}<input value={form.port} onChange={event=>change('port',event.target.value)} inputMode="numeric" maxLength={5} required disabled={busy}/></label></div>
   <label>{t('작업 PC 공개 인증서')}<input type="file" accept=".pem,.crt,.cer" onChange={certificate} disabled={busy}/></label>
   {form.certificateFingerprint&&<><p>{t('인증서 지문 · SHA-256')}</p><code>{form.certificateFingerprint}</code><label><span><input type="checkbox" checked={verified} onChange={event=>setVerified(event.target.checked)}/>{t('작업 PC에 표시된 인증서 지문과 일치함을 확인했습니다.')}</span></label></>}
   <label>{t('앱 초대 비밀값')}<input type="password" value={form.invitation} onChange={event=>setForm(previous=>({...previous,invitation:event.target.value}))} maxLength={43} autoComplete="off" required disabled={busy}/></label>
   <button className="button primary" type="submit" disabled={busy||!verified}>{t('원격 접속 추가')}</button>
  </form>
  <h3>{t('저장한 원격 연결')}</h3>{!hosts.length&&<p>{t('저장한 연결이 없습니다.')}</p>}
  {hosts.map(row=><div className="remote-host" key={row.id}><strong>{row.label}</strong><p>{row.address}:{row.port} · {row.state}</p>{row.state==='credential_locked'&&<p role="alert">{t('저장한 연결의 보안 자격 증명을 읽지 못했습니다. 기존 연결은 보존했습니다. 운영체제 보안 저장소의 잠금과 앱 접근 권한을 확인한 뒤 연결 상태를 다시 확인하십시오.')}</p>}{row.errorCode&&<code>{row.errorCode}</code>}<code>{row.certificateFingerprint}</code><div>
   <button type="button" className="button" disabled={busy} onClick={()=>{setSelected(row.id);setProjects([]);setReviews([]);setProjectId('');setReviewId('');setDetail(null);setTimeline(null);}}>{t('이 원격 PC 선택')}</button>
   <button type="button" className="button" disabled={busy} onClick={()=>perform(()=>invoke('remoteApp.refresh',{id:row.id}))}>{t('연결 상태 확인')}</button>
   <button type="button" className="button" disabled={busy} onClick={()=>perform(()=>invoke('remoteApp.disconnect',{id:row.id}))}>{t('연결 해제')}</button>
   <button type="button" className="button" disabled={busy} onClick={()=>perform(()=>invoke('remoteApp.forget',{id:row.id}))}>{t('저장한 연결 삭제')}</button>
   </div></div>)}
  {pendingUploads.length>0&&<section aria-label={t('확인할 첨부파일 전송')}><h3>{t('확인할 첨부파일 전송')}</h3>
   <p>{t('저장 결과가 불명확하면 같은 요청의 결과만 확인하십시오. 파일을 다시 보내지 마십시오.')}</p>
   {pendingUploads.map(row=><div key={`${row.id}:${row.requestId}`}><p>{row.name} · <code>{row.requestId}</code></p>
    <button type="button" className="button" disabled={busy} onClick={()=>uploadResult(row)}>{t('첨부파일 저장 결과 확인')}</button>
    {row.phase==='staging'&&<button type="button" className="button" disabled={busy} onClick={()=>perform(async()=>{
     await invoke('remoteApp.cancelPendingUpload',{id:row.id,requestId:row.requestId});setMessage(t('임시 전송을 취소했습니다.'));
    })}>{t('임시 전송 취소')}</button>}
   </div>)}
  </section>}
  {host&&<div className="remote-host"><h3>{t('원격 작업 공간: {0}',[host.label])}</h3><p>{host.address}:{host.port}</p><p role="status">{freshness.stale?t('연결 또는 최신 상태를 확인하지 못했습니다. 저장된 화면과 초안을 보존하고 있습니다.'):t('마지막 확인: {0} · 15초마다 자동 새로고침',[new Date(freshness.at).toLocaleTimeString()])}</p>{draftConflict&&<section aria-label={t('원격 변경과 초안 비교')}><p role="alert">{t('초안을 작성한 뒤 작업 PC의 리뷰가 바뀌었습니다. 초안을 보존했습니다. 최신 내용과 비교한 뒤 새로 작성하십시오.')}</p><h4>{freshness.stale?t('마지막으로 확인한 내용'):t('작업 PC의 최신 내용')}</h4><p>{detail?.title}</p><pre className="user-text">{detail?.body}</pre><button className="button" type="button" disabled={busy||!observed||freshness.stale} onClick={()=>{const draft=drafts.current.get(draftKey);if(draft)drafts.current.set(draftKey,{...draft,binding:observed});setDraftConflict(false);}}>{t('최신 내용을 확인하고 현재 초안 유지')}</button></section>}
   <button type="button" className="button" disabled={busy} onClick={loadProjects}>{t('공유 프로젝트 불러오기')}</button>
   <label>{t('원격 프로젝트')}<select value={projectId} disabled={busy} onChange={event=>{setProjectId(event.target.value);setReviewId('');setReviews([]);setDetail(null);setTimeline(null);}}><option value="">{t('프로젝트 선택')}</option>{projects.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
   <button type="button" className="button" disabled={busy||!projectId} onClick={loadReviews}>{t('리뷰 불러오기')}</button>
   <label>{t('원격 리뷰')}<select value={reviewId} disabled={busy} onChange={event=>{setReviewId(event.target.value);setDetail(null);setTimeline(null);}}><option value="">{t('새 리뷰 또는 리뷰 선택')}</option>{reviews.map(row=><option key={row.id} value={row.id}>#{row.number} · {row.title}</option>)}</select></label>
   <button type="button" className="button" disabled={busy||!reviewId} onClick={()=>perform(loadDetail)}>{t('상세·작업 결과 새로고침')}</button>
   {transfer&&<p role="status">{t('첨부파일 전송: {0} · {1}/{2} 바이트',[transfer.name,transfer.received,transfer.size])}
    {transfer.phase==='committing'&&` · ${t('저장 결과 확인 중')}`}</p>}
   {timeline&&<section aria-label={t('원격 첨부파일')}><h3>{t('원격 첨부파일')}</h3>
    {timeline.attachments.length?<ul>{timeline.attachments.map(file=><li key={file.id}>{file.name} · {file.size.toLocaleString()} {t('바이트')}
     <button className="button" type="button" disabled={busy} onClick={()=>download(file)} aria-label={t('첨부파일 다운로드: {0}',[file.name])}>{t('다운로드')}</button>
    </li>)}</ul>:<p>{t('첨부파일이 없습니다.')}</p>}
    <fieldset disabled={busy||!grant?.write||!reviewId||Boolean(pendingCommand)||pendingUploads.some(row=>row.id===selected&&row.projectId===projectId&&row.reviewId===reviewId)}>
     <legend>{t('작업 PC에 파일 첨부')}</legend><p>{t('파일당 최대 10 MiB입니다. 전송 중 창이나 리뷰를 바꾸면 전송이 중단됩니다.')}</p>
     <label>{t('첨부할 파일')}<input ref={fileInput} key={draftKey} type="file" onChange={chooseUpload}/></label>
     <label>{t('첨부 위치')}<select value={uploadActivity} onChange={event=>setUploadActivity(event.target.value)}>
      <option value="">{t('리뷰에 첨부')}</option>{timeline.activities.filter(row=>row.type==='comment'&&row.role==='user').map(row=>
       <option value={row.id} key={row.id}>{t('댓글: {0}',[row.body.slice(0,80)])}</option>)}
     </select></label>
     <button type="button" className="button primary" disabled={!uploadFile} onClick={upload}>{t('첨부파일 전송')}</button>
    </fieldset>
   </section>}
   {pendingCommand&&<div role="status"><p>{t('처리 결과가 확인되지 않은 요청이 있습니다. 새 요청을 보내지 말고 저장된 결과를 확인하십시오.')}</p><button type="button" className="button" disabled={busy} onClick={checkResult}>{t('요청 결과 확인')}</button></div>}
   <fieldset disabled={busy||!grant?.write||Boolean(pendingCommand)||!observed}><legend>{t('원격 리뷰 작성')}</legend><label>{t('제목')}<input value={editor.title} onChange={event=>editReview({title:event.target.value})} maxLength={300}/></label><label>{t('내용')}<textarea value={editor.body} onChange={event=>editReview({body:event.target.value})} maxLength={100000}/></label>
    <button className="button primary" type="button" disabled={!projectId||!editor.title.trim()} onClick={()=>command(reviewId?'review.update':'review.create',editor)}>{reviewId?t('원격 리뷰 수정'):t('원격 리뷰 등록')}</button>
    {detail&&<label>{t('상태 변경')}<select value={detail.status} onChange={event=>command('review.status.set',{status:event.target.value})}>{['open','in_progress','in_review','resolved','recheck','closed'].map(status=><option key={status}>{status}</option>)}</select></label>}
    <label>{t('댓글')}<textarea value={comment} onChange={event=>{setComment(event.target.value);saveDraft({comment:event.target.value,binding:drafts.current.get(draftKey)?.binding||observedRef.current});}} maxLength={100000}/></label><button type="button" className="button" disabled={!reviewId||!comment.trim()} onClick={()=>command('comment.add',{body:comment})}>{t('원격 댓글 저장')}</button>
   </fieldset>
   <fieldset disabled={busy||!grant?.execute||!reviewId||!observed||Boolean(pendingCommand)}><legend>{t('작업 PC의 에이전트 제어')}</legend><label>{t('작업 요청')}<textarea value={prompt} onChange={event=>{setPrompt(event.target.value);saveDraft({prompt:event.target.value,binding:drafts.current.get(draftKey)?.binding||observedRef.current});}} maxLength={100000}/></label><button type="button" className="button primary" disabled={!prompt.trim()} onClick={()=>command('agent.start',{prompt})}>{t('작업 PC에서 실행')}</button><button type="button" className="button" disabled={!prompt.trim()} onClick={()=>command('agent.followup',{prompt})}>{t('후속 요청 저장')}</button>{followup&&<button type="button" className="button" onClick={()=>command('agent.followup.start',{followupId:followup})}>{t('후속 요청 실행')}</button>}
    {timeline?.agentRuns.map(run=><div key={run.id}><p>{run.status}</p>{['queued','running'].includes(run.status)&&<button className="button" type="button" onClick={()=>command('agent.stop',{runId:run.id})}>{t('이 작업 중지')}</button>}<pre className="user-text">{run.response}</pre></div>)}
   </fieldset>
   {timeline&&<section><h3>{t('원격 작업 이력')}</h3>{timeline.activities.map(row=><article key={row.id}><p>{row.type} · {row.createdAt}</p><pre className="user-text">{row.body}</pre></article>)}</section>}
  </div>}
 </section>;
}
