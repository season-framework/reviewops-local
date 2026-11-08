import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import Icon from './icons.jsx';
import Markdown from './ReviewMarkdown.jsx';
import Select from './Select.jsx';
import {Dialog} from './components.jsx';
import {t} from './i18n/index.js';
import {errorText} from './OpsState.mjs';
import {opsTime} from './OpsConversation.jsx';
import {targetContext} from './ops-target.mjs';
import {availableModels,defaultReasoning,reasoningOptions} from './agent-models.mjs';
import {canStopManagementConversation,managementPhase,managementPreview,managementTimeline,removeManagementUiConversation} from './ops-chat-state.mjs';
import OpsAppliedSkills from './OpsAppliedSkills.jsx';

const storageKey='reviewops.ops.composer';
const phaseLabel={idle:'대기 중',submitting:'요청 전달 중',working:'작업 중',responding:'응답 생성 중',stopping:'중지 확인 중',completed:'완료',stopped:'중지됨',error:'실행 오류',unknown:'실행 상태 확인 필요'};
const progressLabel={running:'진행 중',completed:'완료',failed:'실패',interrupted:'중단',unknown:'결과 확인 필요'};
const activePhases=new Set(['submitting','working','responding','stopping']);

export const initialManagementUi=()=>{
 let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey)||'{}')||{}}catch{}
 const records=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
 return {selected:typeof saved.selected==='string'?saved.selected:'',drafts:Object.fromEntries(Object.entries(records(saved.drafts)).filter(([,value])=>typeof value==='string')),scrollPositions:records(saved.scrollPositions),selections:records(saved.selections),target:typeof saved.target==='string'?saved.target:'screen',model:typeof saved.model==='string'?saved.model:null,reasoningEffort:typeof saved.reasoningEffort==='string'?saved.reasoningEffort:null,historyOpen:false,historyCollapsed:false,historyOrigin:''};
};

function contextLabel(context,data){
 const review=data.reviews.find(row=>row.id===context?.reviewId),project=data.projects.find(row=>row.id===(context?.projectId||review?.projectId)),group=data.groups.find(row=>row.id===(context?.groupId||project?.groupId));
 const goal=data.goals?.find(row=>row.id===context?.goalId),document=data.attachments?.find(row=>row.id===context?.documentId);
 return [group?.name,project?.name,review?.title,document?.name,goal?.name].filter(Boolean).join(' / ')||t({home:'홈',groups:'그룹 목록',group:'그룹',ops:'Ops',settings:'설정',hosts:'호스트관리',accounts:'계정관리'}[context?.view]||'현재 화면');
}

export default function OpsManagement({state,command,pending,invoke,onGoal,onDirtyChange,data={projects:[],groups:[],reviews:[],attachments:[]},ui,setUi,screenContext,onNavigate,compact=false,onClose,headerControls}){
 const [ownUi,setOwnUi]=useState(initialManagementUi),[error,setError]=useState(''),[catalog,setCatalog]=useState(null),[catalogError,setCatalogError]=useState(''),[wide,setWide]=useState(false),[chatWidth,setChatWidth]=useState(0),[confirmDelete,setConfirmDelete]=useState(null),[preview,setPreview]=useState(false),[control,setControl]=useState(null);
 const view=ui||ownUi,update=setUi||setOwnUi,rows=state.managementConversations||[],conversation=rows.find(row=>row.id===view.selected)||rows[0],id=conversation?.id||'new',draft=view.drafts[id]||'';
 const submitting=pending.has(`management:${id}`)||id==='new'&&pending.has('management:new'),controlBusy=pending.has(`management-control:${id}`),phase=managementPhase(conversation,{submitting,stopping:control?.id===id&&['stop','delete'].includes(control.action)}),canStop=canStopManagementConversation(conversation,{submitting}),running=canStop&&phase!=='unknown',showHistory=wide?!view.historyCollapsed:Boolean(view.historyOpen),historyOnly=!wide&&showHistory;
 const host=useRef(null),messagesElement=useRef(null),textarea=useRef(null),dirtyCallback=useRef(onDirtyChange),currentView=useRef(view),currentId=useRef(id),positions=useRef({}),scrollFrame=useRef(null),restoringScroll=useRef(false),admissions=useRef(new Map());
 dirtyCallback.current=onDirtyChange;currentView.current=view;currentId.current=id;
 let context,targetError='';try{context=targetContext(view.target,screenContext,data)}catch(cause){targetError=errorText(cause)}
 const Heading=compact?'h2':'h1',contextData={...data,goals:state.goals||[]},environment=catalog?.targets?.find(row=>row.id==='local'),models=availableModels(environment),model=view.model??conversation?.model??'',effort=view.reasoningEffort??conversation?.reasoningEffort??'',selectedModel=models.find(row=>row.id===(model||environment?.defaultModel)),efforts=reasoningOptions(selectedModel),timeline=managementTimeline(conversation),messages=conversation?.conversation||[];
 const savePosition=()=>{
  if(scrollFrame.current){cancelAnimationFrame(scrollFrame.current);scrollFrame.current=null}
  const element=messagesElement.current;if(!element||!element.clientHeight||restoringScroll.current)return;
  const value={top:element.scrollTop,atBottom:element.scrollHeight-element.clientHeight-element.scrollTop<48};
  positions.current[id]=value;
  update(current=>({...current,scrollPositions:{...current.scrollPositions,[id]:value}}));
 };
 const restorePosition=()=>{
  const element=messagesElement.current;if(!element||!element.clientHeight)return;
  const position=positions.current[currentId.current]||currentView.current.scrollPositions?.[currentId.current];restoringScroll.current=true;
  element.scrollTop=position?.atBottom===false?Number(position.top)||0:element.scrollHeight;
  restoringScroll.current=false;
 };
 const fitInput=()=>{
  const element=textarea.current;if(!element?.getClientRects().length)return;
  element.style.height='0px';const maximum=parseFloat(getComputedStyle(element).maxHeight)||220,height=Math.max(42,Math.min(maximum,element.scrollHeight));
  element.style.height=`${height}px`;element.style.overflowY=element.scrollHeight>maximum?'auto':'hidden';
 };
 const saveSelection=(element,leaving=false)=>{
  // React reuses the textarea across conversations. Delayed selection events
  // from a blurred/hidden composer must not replace another draft's caret.
  if(!element||!element.getClientRects().length||!leaving&&document.activeElement!==element)return;
  const value={start:element.selectionStart,end:element.selectionEnd,direction:element.selectionDirection};
  update(current=>({...current,selections:{...current.selections,[id]:value}}));
 };
 const rememberConversation=()=>{savePosition();saveSelection(textarea.current,true)};
 useEffect(()=>{dirtyCallback.current?.(Object.values(view.drafts).some(value=>Boolean(value.trim())));return()=>dirtyCallback.current?.(false)},[view.drafts]);
 useLayoutEffect(()=>{
  const element=host.current;if(!element)return;
  // A hidden panel can reopen at its previous width, so state equality alone
  // must not suppress restoring its draft height and saved reading position.
  const measure=()=>{const width=element.getBoundingClientRect().width;if(width>0){setWide(width>=760);setChatWidth(Math.floor(width));fitInput();restorePosition()}};
  measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
 },[]);
 useLayoutEffect(()=>{restorePosition()},[id,historyOnly,wide,chatWidth,showHistory]);
 useLayoutEffect(()=>{
  if(historyOnly)return;const element=messagesElement.current,position=positions.current[id]||currentView.current.scrollPositions?.[id];
  if(element&&position?.atBottom!==false){restoringScroll.current=true;element.scrollTop=element.scrollHeight;restoringScroll.current=false}
 },[id,historyOnly,messages.length,messages.at(-1)?.text,conversation?.progressEvents,phase]);
 useLayoutEffect(()=>{
  if(!historyOnly)fitInput();
 },[draft,id,historyOnly,chatWidth,showHistory]);
 useLayoutEffect(()=>{
  const element=textarea.current,selection=view.selections?.[id];if(!element||!selection)return;
  const restore=()=>{
   const activeSurface=document.activeElement?.closest('.ops-management-layout'),latest=currentView.current.selections?.[id];
   if(currentId.current!==id||textarea.current!==element||!element.getClientRects().length||activeSurface&&activeSurface!==host.current||!latest||latest.start!==selection.start||latest.end!==selection.end)return;
   const length=element.value.length;element.setSelectionRange(Math.min(length,Math.max(0,selection.start||0)),Math.min(length,Math.max(0,selection.end||0)),selection.direction||'none');
  };
  restore();
  // A history button's native click can clear a range after React's layout
  // commit. Restore after that default action, unless the user changed it.
  const frame=requestAnimationFrame(restore);return()=>cancelAnimationFrame(frame);
 },[id,historyOnly]);
 useEffect(()=>()=>{if(scrollFrame.current)cancelAnimationFrame(scrollFrame.current)},[]);
 useEffect(()=>{
  let live=true,updated=false;const receive=value=>{if(live&&Array.isArray(value?.targets)){updated=true;setCatalog(value);setCatalogError('')}};
  const stop=window.reviewops?.onModelCacheState?.(receive);
  Promise.resolve(invoke('modelCache.state')).then(value=>{if(!updated)receive(value)}).catch(cause=>{if(live&&!updated)setCatalogError(errorText(cause))});
  return()=>{live=false;stop?.()};
 },[invoke]);
 useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify({selected:view.selected,drafts:view.drafts,scrollPositions:view.scrollPositions,selections:view.selections,target:view.target,model:view.model,reasoningEffort:view.reasoningEffort}))}catch{}},[view.selected,view.drafts,view.scrollPositions,view.selections,view.target,view.model,view.reasoningEffort]);
 useEffect(()=>{if(conversation?.id&&view.selected!==conversation.id)update(current=>({...current,selected:conversation.id}))},[conversation?.id,view.selected]);
 const setDraft=value=>update(current=>({...current,drafts:{...current.drafts,[id]:value}}));
 const create=async()=>{
  setError('');rememberConversation();const createdId=crypto.randomUUID(),next=await command('managementCreate',{id:createdId,model,reasoningEffort:effort},'management:new'),created=next.managementConversations?.find(row=>row.id===createdId);
  if(!created)throw new Error(t('새 대화를 준비하지 못했습니다.'));
  update(current=>({...current,selected:created.id,historyOpen:false,historyOrigin:''}));setPreview(false);return created;
 };
 const submit=async event=>{
  event.preventDefault();if(!draft.trim()||submitting||targetError||conversation?.executionState==='unknown'||controlBusy)return;
  setError('');const text=draft,frozen=structuredClone(context),settings={model,reasoningEffort:effort};let target,admission;
  try{
   target=conversation||await create();if(!conversation)update(current=>({...current,drafts:{...current.drafts,[id]:'',[target.id]:text}}));
   admission={stopped:false};admissions.current.set(target.id,admission);
   await command('managementRequest',{conversationId:target.id,instruction:text,context:frozen,...settings},`management:${target.id}`);
   if(!admission.stopped)update(current=>({...current,drafts:{...current.drafts,[target.id]:current.drafts[target.id]===text?'':current.drafts[target.id]}}));
   setPreview(false);
  }catch(cause){setError(errorText(cause))}finally{if(target&&admissions.current.get(target.id)===admission)admissions.current.delete(target.id)}
 };
 const action=async(name,target=conversation)=>{
  if(!target)return;setError('');setControl({id:target.id,action:name});
  if(['stop','delete'].includes(name)){const admission=admissions.current.get(target.id);if(admission)admission.stopped=true}
  try{return await command('managementAction',{conversationId:target.id,action:name},`management-control:${target.id}`)}catch(cause){setError(errorText(cause));throw cause}finally{setControl(current=>current?.id===target.id?null:current)}
 };
 const remove=async()=>{
  const target=confirmDelete;if(!target)return;
  try{const next=await action('delete',target);if(next.managementConversations?.some(row=>row.id===target.id))throw new Error(t('대화 삭제 결과를 확인하지 못했습니다.'));update(current=>removeManagementUiConversation(current,target.id,next.managementConversations||[]));setConfirmDelete(null)}catch(cause){setError(errorText(cause))}
 };
 const selectConversation=row=>{
  rememberConversation();update(current=>({...current,selected:row.id,historyOpen:false}));setError('');setPreview(false);
 };
 const openHistory=()=>{
  rememberConversation();update(current=>wide?{...current,historyCollapsed:!current.historyCollapsed}:{...current,historyOpen:!current.historyOpen,historyOrigin:current.historyOpen?current.historyOrigin:id});
 };
 const back=()=>{
  rememberConversation();update(current=>({...current,selected:rows.some(row=>row.id===current.historyOrigin)?current.historyOrigin:current.selected,historyOpen:false,historyOrigin:''}));setError('');setPreview(false);
 };
 const follow=async link=>{setError('');try{if(onNavigate)await onNavigate(link);else if(link.kind==='goal')onGoal?.(link.id);else if(link.kind==='project')await invoke('window.openProject',{projectId:link.id})}catch(cause){setError(errorText(cause))}};
 const backAvailable=!wide&&(historyOnly||view.historyOrigin&&view.historyOrigin!==id&&rows.some(row=>row.id===view.historyOrigin));
 return <div ref={host} className={`ops-management-layout ${compact?'is-compact':''} ${historyOnly?'is-history-only':''}`} data-conversation-id={id} data-history-layout={wide?'split':'replace'}>
  <header className="ops-management-header">
   {backAvailable&&<button type="button" className="button ops-history-back" aria-label={t('원래 대화로 돌아가기')} title={t('원래 대화로 돌아가기')} onClick={back}><Icon name="back" size={16}/></button>}
   <Heading className="ops-management-brand" aria-label="Ops"><Icon name="messagesSquare" size={18}/><span>Ops</span></Heading>{headerControls}
   <span className="ops-management-conversation-name" title={conversation?.name}>{historyOnly?t('이전 대화'):conversation?.name||t('새 대화')}</span>
   <div className="ops-management-header-actions">
    <button type="button" className="button" aria-label={t('이전 대화')} title={t('이전 대화')} aria-expanded={showHistory} onClick={openHistory}><Icon name="clock" size={16}/><span>{t('이전 대화')}</span></button>
    <button type="button" className="button" aria-label={t('새 대화')} title={t('새 대화')} disabled={pending.has('management:new')} onClick={()=>create().catch(cause=>setError(errorText(cause)))}><Icon name="plus" size={16}/><span>{t('새 대화')}</span></button>
    {onClose&&<button type="button" className="button ops-management-close" aria-label={t('Ops 대화 패널 닫기')} title={t('닫기')} onClick={onClose}><Icon name="close" size={16}/></button>}
   </div>
  </header>
  <div className="ops-management-body">
   <aside className="ops-management-list" aria-label={t('이전 대화')} hidden={!showHistory}>
    <h2>{t('이전 대화')}</h2>
    {rows.length?<ul>{[...rows].sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt))).map(row=><li key={row.id} data-conversation-id={row.id}>
     <button type="button" className="ops-history-select" aria-current={conversation?.id===row.id?'true':undefined} onClick={()=>selectConversation(row)}><strong>{row.name||t('새 대화')}</strong><span className="ops-history-preview">{managementPreview(row)||t('기록 없음')}</span><small>{opsTime(row.updatedAt||row.createdAt)}</small></button>
     <button type="button" className="ops-history-delete" aria-label={t('대화 삭제: {0}',[row.name||t('새 대화')])} title={t('대화 삭제')} disabled={pending.has(`management-control:${row.id}`)} onClick={()=>{setError('');setConfirmDelete(row)}}><Icon name="trash" size={15}/></button>
    </li>)}</ul>:<p className="ops-history-empty">{t('이전 대화가 없습니다.')}</p>}
   </aside>
   <section className="ops-management-chat" aria-label={t('ReviewOps 관리 대화')} hidden={historyOnly}>
    <div ref={messagesElement} className="ops-management-messages" role="log" aria-label={t('대화와 작업 기록')} aria-live="polite" aria-relevant="additions text" onScroll={event=>{const element=event.currentTarget;if(!element.clientHeight||restoringScroll.current)return;positions.current[id]={top:element.scrollTop,atBottom:element.scrollHeight-element.clientHeight-element.scrollTop<48};if(!scrollFrame.current)scrollFrame.current=requestAnimationFrame(()=>{scrollFrame.current=null;savePosition()})}}>
     {timeline.length?<ol className="ops-messages">{timeline.map(entry=>{
      const message=entry.value;
      if(entry.type==='progress')return <li key={`progress:${message.turnId}:${message.id}`} className={`ops-progress-event is-${message.status}`} data-event-id={message.id} data-event-kind={message.kind}>
       <details open><summary><Icon name={message.kind==='command'?'terminal':message.kind==='file'?'file':'chevron'} size={14}/><strong>{message.name||t('에이전트 작업')}</strong><span>{t(progressLabel[message.status]||'상태 확인 중')}</span><time>{opsTime(message.createdAt)}</time></summary>{message.text&&<pre>{message.text}</pre>}</details>
      </li>;
      return <li key={`message:${message.id}`} className={`ops-message ops-message-${message.role}`} data-message-id={message.id}>
       <header><strong>{message.role==='user'?t('사용자'):message.role==='assistant'?'Codex':t('처리 결과')}</strong><time>{opsTime(message.createdAt)}</time>{message.partial&&<span className="ops-streaming">{t('응답 중')}</span>}</header>
       {message.context&&<small className="ops-message-target">{t('작업 대상')}: {contextLabel(message.context,contextData)}</small>}
       {message.executionSettings?.sent&&<small className="ops-message-settings">{t('Codex 모델')}: {message.executionSettings.sent.model||t('Codex 기본값 사용')}{message.executionSettings.sent.reasoningEffort&&` · ${t('추론 수준')}: ${message.executionSettings.sent.reasoningEffort}`}</small>}
       {message.skills&&<OpsAppliedSkills snapshot={message.skills} compact/>}
       <Markdown text={message.text||''} invoke={invoke} onError={setError}/>
       {message.links?.length>0&&<div className="ops-management-links">{message.links.map(link=><button type="button" className="button" key={`${link.kind}:${link.id}`} onClick={()=>follow(link)}>{link.name||t('결과 열기')}<Icon name="external" size={14}/></button>)}</div>}
      </li>;
     })}</ol>:<div className="ops-management-welcome"><Icon name="messagesSquare" size={28}/><h2>{t('ReviewOps에서 할 일을 이야기하세요.')}</h2></div>}
    </div>
    <div className={`ops-management-progress is-${phase}`} data-phase={phase} role="status"><span className={`ops-progress-indicator ${activePhases.has(phase)?'is-active':''}`} aria-hidden="true"/>{t(phaseLabel[phase])}{phase==='unknown'&&<span className="ops-progress-explanation">{t('원래 실행 상태를 다시 연결하여 확인하세요.')}</span>}</div>
    {(targetError||error||conversation?.lastError)&&<p className="ops-management-error form-error" role="alert">{t(errorText(targetError||error||conversation.lastError))}</p>}
    <form className="ops-management-composer" onSubmit={submit}>
     <label className="ops-field"><span className="sr-only">{t('ReviewOps에 요청')}</span><textarea key={id} ref={textarea} aria-label={t('ReviewOps에 요청')} rows={1} value={draft} onChange={event=>{setDraft(event.target.value);saveSelection(event.target)}} onSelect={event=>saveSelection(event.target)} onKeyDown={event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.nativeEvent?.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit()}}} placeholder={t('ReviewOps에 요청')}/></label>
     {preview&&<div className="ops-composer-preview-pane" aria-label={t('Markdown 미리보기')}><Markdown text={draft} invoke={invoke} onError={setError}/></div>}
     <div className="ops-management-composer-footer">
      <label className="ops-composer-model"><span className="sr-only">{t('Codex 모델')}</span><Select searchable aria-label={t('Codex 모델')} value={model} onChange={event=>{const value=event.target.value;update(current=>({...current,model:value,reasoningEffort:value?defaultReasoning(models.find(row=>row.id===value)):''}));setError('')}}><option value="">{environment?.defaultModel?t('호스트 기본 모델 · {0}',[environment.defaultModel]):t('Codex 기본값 사용')}</option>{model&&!models.some(row=>row.id===model)&&<option value={model}>{model} · {t('저장된 모델')}</option>}{models.map(row=><option key={row.id} value={row.id}>{row.label||row.displayName||row.id}</option>)}</Select></label>
      <label className="ops-composer-reasoning"><span className="sr-only">{t('추론 수준')}</span><Select aria-label={t('추론 수준')} searchable={false} value={effort} onChange={event=>update(current=>({...current,reasoningEffort:event.target.value}))}><option value="">{t('Codex 기본값 사용')}</option>{effort&&!efforts.includes(effort)&&<option value={effort}>{effort}</option>}{efforts.map(value=><option key={value} value={value}>{value}</option>)}</Select></label>
      <label className="ops-management-target"><span className="sr-only">{t('작업 대상')}</span><Select aria-label={t('Ops 작업 대상')} title={contextLabel(context,contextData)} searchable searchPlaceholder={t('작업 대상 검색')} value={view.target} onChange={event=>update(current=>({...current,target:event.target.value}))}>{targetError&&<option value={view.target}>{t('선택한 대상 없음 · 다시 선택')}</option>}<option value="screen">{t('현재 화면')}: {contextLabel(screenContext,contextData)}</option><optgroup label={t('그룹')}>{data.groups.map(row=><option key={row.id} value={`group:${row.id}`}>{row.name}</option>)}</optgroup><optgroup label={t('프로젝트')}>{data.projects.map(row=><option key={row.id} value={`project:${row.id}`}>{row.name}</option>)}</optgroup><optgroup label={t('리뷰')}>{data.reviews.map(row=><option key={row.id} value={`review:${row.id}`}>{data.projects.find(project=>project.id===row.projectId)?.name} / {row.title}</option>)}</optgroup><optgroup label={t('문서')}>{(data.attachments||[]).map(row=><option key={row.id} value={`document:${row.id}`}>{row.name}</option>)}</optgroup></Select></label>
      <div className="ops-management-compose-actions">
       <button type="button" className="button ops-composer-preview" aria-label={t('Markdown 미리보기')} title={t('Markdown 미리보기')} aria-pressed={preview} disabled={!draft} onClick={()=>setPreview(value=>!value)}><Icon name="eye" size={16}/></button>
       {phase==='unknown'&&<button type="button" className="button ops-composer-reconnect" aria-label={t('다시 연결')} title={t('다시 연결')} disabled={controlBusy} onClick={()=>action('reconnect').catch(()=>{})}><Icon name="refresh" size={16}/></button>}
       {canStop&&<button type="button" className="button ops-composer-stop" aria-label={t('중지')} title={t('중지')} disabled={controlBusy||!conversation} onClick={()=>action('stop').catch(()=>{})}><span aria-hidden="true"/></button>}
       <button type="submit" className="button primary ops-composer-send" aria-label={submitting?t('전달 중'):running?t('추가 지시'):t('보내기')} title={submitting?t('전달 중'):running?t('추가 지시'):t('보내기')} disabled={submitting||controlBusy||!draft.trim()||Boolean(targetError)||phase==='unknown'}><Icon name="arrow" size={17}/></button>
      </div>
     </div>
    </form>
    {(catalogError||environment?.error)&&<small className="ops-management-model-error" role="status">{t(catalogError||environment.error)}</small>}
   </section>
  </div>
  {confirmDelete&&<Dialog title={t('대화 삭제')} onClose={()=>{if(!pending.has(`management-control:${confirmDelete.id}`))setConfirmDelete(null)}} footer={<><button type="button" className="button" disabled={pending.has(`management-control:${confirmDelete.id}`)} onClick={()=>setConfirmDelete(null)}>{t('취소')}</button><button type="button" className="button danger-text" disabled={pending.has(`management-control:${confirmDelete.id}`)} onClick={remove}>{t('삭제')}</button></>}><p>{t('‘{0}’ 대화와 대화 기록을 삭제합니다. 실행 중인 작업은 중지한 뒤 삭제합니다. 연결된 프로젝트와 리뷰는 유지합니다.',[confirmDelete.name||t('새 대화')])}</p>{error&&<p className="form-error" role="alert">{t(error)}</p>}</Dialog>}
 </div>;
}
