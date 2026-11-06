import React,{useEffect,useRef,useState} from 'react';
import {t,useLocale} from './i18n/index.js';

export default function RemoteAppConnections({invoke,active=true}){
 useLocale();
 const [hosts,setHosts]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [form,setForm]=useState({id:'',label:'',address:'',port:'9444',certificatePEM:'',certificateFingerprint:'',invitation:''});
 const [verified,setVerified]=useState(false),[selected,setSelected]=useState(''),[projects,setProjects]=useState([]),[reviews,setReviews]=useState([]),[projectId,setProjectId]=useState(''),[reviewId,setReviewId]=useState('');
 const [detail,setDetail]=useState(null),[timeline,setTimeline]=useState(null),[editor,setEditor]=useState({title:'',body:'',priority:'normal',category:'ux'});
 const [comment,setComment]=useState(''),[prompt,setPrompt]=useState(''),[followup,setFollowup]=useState(null),[pendingCommand,setPendingCommand]=useState(null);
 const alive=useRef(true),pending=useRef(false);
 const drafts=useRef(new Map()),draftKey=[selected,projectId,reviewId].join(':');
 const saveDraft=patch=>drafts.current.set(draftKey,{...(drafts.current.get(draftKey)||{}),...patch});
 const editReview=patch=>setEditor(previous=>{const value={...previous,...patch};saveDraft({editor:value});return value;});
 useEffect(()=>{const draft=drafts.current.get(draftKey);setEditor(draft?.editor||{title:'',body:'',priority:'normal',category:'ux'});setComment(draft?.comment||'');setPrompt(draft?.prompt||'');},[draftKey]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const state=async()=>{
  const result=await invoke('remoteApp.state');if(!Array.isArray(result?.connections)||!Array.isArray(result.pendingCommands))throw new Error();
  if(alive.current){setHosts(result.connections);setPendingCommand(current=>{
   const saved=result.pendingCommands.find(row=>row.id===current?.id&&row.requestId===current?.envelope?.requestId)||result.pendingCommands[0];
   return saved?{id:saved.id,envelope:{requestId:saved.requestId,epoch:saved.epoch,projectId:saved.projectId,operation:saved.operation}}:null;
  });}
 };
 const perform=async(action)=>{
  if(pending.current||!active)return;pending.current=true;setBusy(true);setError('');setMessage('');
  try{await action();await state();}
  catch(cause){if(alive.current)setError(t('원격 요청을 완료하지 못했습니다. 연결과 권한을 확인하십시오. ({0})',[typeof cause?.code==='string'?cause.code:'CONNECTION_UNAVAILABLE']));}
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
 const host=hosts.find(row=>row.id===selected),grant=host?.remote?.grants?.find(row=>row.projectId===projectId);
 const read=(operation,payload)=>invoke('remoteApp.read',{id:selected,operation,payload});
 const loadProjects=()=>perform(async()=>{await invoke('remoteApp.refresh',{id:selected});const value=await read('projects.list',{});setProjects(value.projects);});
 const loadReviews=()=>perform(async()=>{const value=await read('reviews.list',{projectId});setReviews(value.reviews);});
 const loadDetail=async()=>{
  const value=await read('reviews.get',{projectId,reviewId}),history=await read('reviews.timeline',{projectId,reviewId});
  setDetail(value.review);setTimeline(history);if(!drafts.current.get(draftKey)?.editor)setEditor(({title:value.review.title,body:value.review.body,priority:value.review.priority,category:value.review.category}));
 };
 const command=(operation,payload)=>perform(async()=>{
  if(pendingCommand)throw Object.assign(new Error(),{code:'UNRESOLVED_COMMAND'});
  const revision=await invoke('remoteApp.writeState',{id:selected,projectId,reviewId:operation==='review.create'?'':reviewId});
  const envelope={operation,requestId:crypto.randomUUID(),projectId,reviewId:operation==='review.create'?'':reviewId,epoch:revision.epoch,expectedRevision:operation==='review.create'?0:revision.revision,payload};
  setPendingCommand({id:selected,envelope});
  let value;
  try{value=await invoke('remoteApp.command',{id:selected,envelope});}
  catch(cause){if(['INVALID_COMMAND','REVISION_CONFLICT'].includes(cause?.code))setPendingCommand(null);throw cause;}
  if(value.state!=='pending')setPendingCommand(null);
  if(value.result?.followupId)setFollowup(value.result.followupId);
  if(['review.create','review.update'].includes(operation)){const draft=drafts.current.get(draftKey);if(draft)delete draft.editor;}
  setMessage(t('작업 PC에서 요청을 처리했습니다. 결과를 새로고침하여 확인하십시오.'));
  if(operation==='comment.add'){setComment('');saveDraft({comment:''});}
 });
 const checkResult=()=>perform(async()=>{
  const {id,envelope}=pendingCommand;
  const value=await invoke('remoteApp.result',{id,requestId:envelope.requestId,epoch:envelope.epoch,projectId:envelope.projectId});
  if(value.state!=='pending')setPendingCommand(null);
  setMessage(value.state==='pending'?t('처리 결과를 기다리고 있습니다. 요청을 다시 실행하지 마십시오.'):t('작업 PC의 저장된 처리 결과를 확인했습니다.'));
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
  {hosts.map(row=><div className="remote-host" key={row.id}><strong>{row.label}</strong><p>{row.address}:{row.port} · {row.state}</p><code>{row.certificateFingerprint}</code><div>
   <button type="button" className="button" disabled={busy} onClick={()=>{setSelected(row.id);setProjects([]);setReviews([]);setProjectId('');setReviewId('');setDetail(null);setTimeline(null);}}>{t('이 원격 PC 선택')}</button>
   <button type="button" className="button" disabled={busy} onClick={()=>perform(()=>invoke('remoteApp.refresh',{id:row.id}))}>{t('연결 상태 확인')}</button>
   <button type="button" className="button" disabled={busy} onClick={()=>perform(()=>invoke('remoteApp.disconnect',{id:row.id}))}>{t('연결 해제')}</button>
   <button type="button" className="button" disabled={busy} onClick={()=>perform(()=>invoke('remoteApp.forget',{id:row.id}))}>{t('저장한 연결 삭제')}</button>
   </div></div>)}
  {host&&<div className="remote-host"><h3>{t('원격 작업 공간: {0}',[host.label])}</h3><p>{host.address}:{host.port}</p>
   <button type="button" className="button" disabled={busy} onClick={loadProjects}>{t('공유 프로젝트 불러오기')}</button>
   <label>{t('원격 프로젝트')}<select value={projectId} disabled={busy} onChange={event=>{setProjectId(event.target.value);setReviewId('');setReviews([]);setDetail(null);setTimeline(null);}}><option value="">{t('프로젝트 선택')}</option>{projects.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
   <button type="button" className="button" disabled={busy||!projectId} onClick={loadReviews}>{t('리뷰 불러오기')}</button>
   <label>{t('원격 리뷰')}<select value={reviewId} disabled={busy} onChange={event=>{setReviewId(event.target.value);setDetail(null);setTimeline(null);}}><option value="">{t('새 리뷰 또는 리뷰 선택')}</option>{reviews.map(row=><option key={row.id} value={row.id}>#{row.number} · {row.title}</option>)}</select></label>
   <button type="button" className="button" disabled={busy||!reviewId} onClick={()=>perform(loadDetail)}>{t('상세·작업 결과 새로고침')}</button>
   {pendingCommand&&<div role="status"><p>{t('처리 결과가 확인되지 않은 요청이 있습니다. 새 요청을 보내지 말고 저장된 결과를 확인하십시오.')}</p><button type="button" className="button" disabled={busy} onClick={checkResult}>{t('요청 결과 확인')}</button></div>}
   <fieldset disabled={busy||!grant?.write||Boolean(pendingCommand)}><legend>{t('원격 리뷰 작성')}</legend><label>{t('제목')}<input value={editor.title} onChange={event=>editReview({title:event.target.value})} maxLength={300}/></label><label>{t('내용')}<textarea value={editor.body} onChange={event=>editReview({body:event.target.value})} maxLength={100000}/></label>
    <button className="button primary" type="button" disabled={!projectId||!editor.title.trim()} onClick={()=>command(reviewId?'review.update':'review.create',editor)}>{reviewId?t('원격 리뷰 수정'):t('원격 리뷰 등록')}</button>
    {detail&&<label>{t('상태 변경')}<select value={detail.status} onChange={event=>command('review.status.set',{status:event.target.value})}>{['open','in_progress','in_review','resolved','recheck','closed'].map(status=><option key={status}>{status}</option>)}</select></label>}
    <label>{t('댓글')}<textarea value={comment} onChange={event=>{setComment(event.target.value);saveDraft({comment:event.target.value});}} maxLength={100000}/></label><button type="button" className="button" disabled={!reviewId||!comment.trim()} onClick={()=>command('comment.add',{body:comment})}>{t('원격 댓글 저장')}</button>
   </fieldset>
   <fieldset disabled={busy||!grant?.execute||!reviewId||Boolean(pendingCommand)}><legend>{t('작업 PC의 에이전트 제어')}</legend><label>{t('작업 요청')}<textarea value={prompt} onChange={event=>{setPrompt(event.target.value);saveDraft({prompt:event.target.value});}} maxLength={100000}/></label><button type="button" className="button primary" disabled={!prompt.trim()} onClick={()=>command('agent.start',{prompt})}>{t('작업 PC에서 실행')}</button><button type="button" className="button" disabled={!prompt.trim()} onClick={()=>command('agent.followup',{prompt})}>{t('후속 요청 저장')}</button>{followup&&<button type="button" className="button" onClick={()=>command('agent.followup.start',{followupId:followup})}>{t('후속 요청 실행')}</button>}
    {timeline?.agentRuns.map(run=><div key={run.id}><p>{run.status}</p>{['queued','running'].includes(run.status)&&<button className="button" type="button" onClick={()=>command('agent.stop',{runId:run.id})}>{t('이 작업 중지')}</button>}<pre className="user-text">{run.response}</pre></div>)}
   </fieldset>
   {timeline&&<section><h3>{t('원격 작업 이력')}</h3>{timeline.activities.map(row=><article key={row.id}><p>{row.type} · {row.createdAt}</p><pre className="user-text">{row.body}</pre></article>)}</section>}
  </div>}
 </section>;
}
