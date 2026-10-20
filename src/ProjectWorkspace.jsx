import {t,localized} from './i18n/index.js';
import Select from './Select.jsx';
import React, {forwardRef,useCallback,useEffect,useId,useImperativeHandle,useLayoutEffect,useRef,useState} from 'react';
import Icon from './icons.jsx';
import {tabKeyboard} from './tabKeyboard.js';
import {STATES,PRIORITIES,label,Button,Empty,Badge,FileBrowser,FileContent,TrustDialog} from './components.jsx';
import {matchesReviewSearch,reviewCategoryLabel,reviewCategoryOptions} from './review-categories.js';
import OriginalReviewPanel from './OriginalReviewPanel.jsx';
import {OperationalStatusField,ProjectConnectionFields,ViewerFields,PROJECT_CONNECTION_DEFAULTS,projectConnection,connectionLabel,validateProjectConnection} from './OriginalForms.jsx';
import AgentSettings from './AgentSettings.jsx';
import TerminalPanel from './TerminalPanel.jsx';
import NativeBrowser from './NativeBrowser.jsx';
import ScreenshotEditor from './ScreenshotEditor.jsx';
import BrowserLogs from './BrowserLogs.jsx';
import './project-workspace.css';

const stamp=value=>value?new Date(value).toLocaleString('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const safeStored=(key,fallback)=>{try{const value=localStorage.getItem(key);return value===null?fallback:JSON.parse(value)}catch{return fallback}};
const store=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch{}};
const bound=(value,min,max)=>Math.min(max,Math.max(min,Number(value)||min));
const VIEWER_PRESETS=localized([['4K',3840,2160],['FHD',1920,1080],['HD',1280,720],['태블릿',768,1024],['모바일',390,844]]);
const serviceViewport=service=>({width:service?.viewerWidth||1920,height:service?.viewerHeight||1080});
const viewportPreset=viewport=>VIEWER_PRESETS.find(([,width,height])=>width===viewport.width&&height===viewport.height)?.[0]||t("직접 입력");
const viewportDraft=viewport=>({width:String(viewport.width),height:String(viewport.height)});

export default function ProjectWorkspace({data,projectId,resourceMode='project',invoke,mutate,busy,onOpenGroup,onError,onDirtyChange,onDelete,onOpenHosts,initialReviewId='',selectionRequest=0,initialSection='',sectionRequest=0,initialReviewMode='detail',integrationRequest=0,active=true,onIntegrationReady}) {
 const isService=false;
 const resource=data.projects.find(item=>item.id===projectId);
 const group=data.groups.find(item=>item.id===resource?.groupId);
 const connection=projectConnection(resource,data);
 const service=connection?{...connection,name:resource?.name||''}:null;
 const services=service?[service]:[];
 const [tab,setTab]=useState(initialSection||'review');
 const [selectedReviewId,setSelectedReviewId]=useState(initialReviewId),[creating,setCreating]=useState(initialReviewMode==='create'),[reviewMode,setReviewMode]=useState(initialReviewMode),[closeRequest,setCloseRequest]=useState(0);
 const [file,setFile]=useState(null),[fileMode,setFileMode]=useState('preview'),[previewFile,setPreviewFile]=useState(null),[previewUrl,setPreviewUrl]=useState(''),[previewRequest,setPreviewRequest]=useState(0),[trust,setTrust]=useState(null);
 const [mobilePane,setMobilePane]=useState('workspace');
 const [width,setWidth]=useState(()=>bound(safeStored('reviewops.project.panelWidth',560),420,900));
 const [dirtyParts,setDirtyParts]=useState({}),dirtyCallback=useRef(onDirtyChange);dirtyCallback.current=onDirtyChange;
 const container=useRef(null),resize=useRef(null),viewer=useRef(null);
 const integrationReady=useRef(onIntegrationReady),acknowledgedRequest=useRef(0);integrationReady.current=onIntegrationReady;
 const [initialScreenshot,setInitialScreenshot]=useState(null),[screenshotTargetUrl,setScreenshotTargetUrl]=useState('');
 const reviews=data.reviews.filter(item=>item.projectId===projectId);
 const selectedReview=reviews.find(item=>item.id===selectedReviewId);
 const dashboard=tab==='dashboard';
 useEffect(()=>{dirtyCallback.current?.(Object.values(dirtyParts).some(Boolean));return()=>dirtyCallback.current?.(false)},[dirtyParts]);
 const dirty=(part,value)=>setDirtyParts(current=>current[part]===value?current:{...current,[part]:value});
 useEffect(()=>{if(initialSection){setTab(initialSection);setMobilePane(initialSection==='viewer'?'preview':'workspace')}},[initialSection,sectionRequest]);
 useEffect(()=>{if(initialReviewId||initialReviewMode==='create'){
  setSelectedReviewId(initialReviewId);setCreating(initialReviewMode==='create');setReviewMode(initialReviewMode);setTab('review');setMobilePane('workspace');
  const requested=data.reviews.find(item=>item.id===initialReviewId&&item.projectId===projectId);
  if(requested){setPreviewFile(null);setPreviewUrl(requested.targetUrl||'');setPreviewRequest(value=>value+1);}
 }},[initialReviewId,initialReviewMode,selectionRequest]);
 useEffect(()=>{
  if(!integrationRequest||acknowledgedRequest.current===integrationRequest||!active||isService||!resource||tab!=='review'||creating||reviewMode!=='detail'||selectedReview?.id!==initialReviewId)return;
  const frame=requestAnimationFrame(()=>{
   const history=container.current?.querySelector('.original-review-history-scroll');
   if(!history?.getClientRects().length)return;
   acknowledgedRequest.current=integrationRequest;
   integrationReady.current?.({request:integrationRequest,view:'project',projectId,reviewId:selectedReview.id,section:'review'});
  });
  return()=>cancelAnimationFrame(frame);
 },[integrationRequest,active,isService,resource,tab,creating,reviewMode,selectedReview?.id,initialReviewId,projectId]);
 useEffect(()=>{if(selectedReviewId&&!selectedReview)setSelectedReviewId('')},[selectedReviewId,selectedReview]);
 useEffect(()=>{setFile(null);setFileMode('preview')},[service?.id]);
 useEffect(()=>{if(tab==='terminal'&&service?.kind!=='ssh')setTab(isService?'settings':'review')},[service?.kind,tab,isService]);
 useEffect(()=>()=>{if(resize.current){document.removeEventListener('pointermove',resize.current.move);document.removeEventListener('pointerup',resize.current.end)}},[]);
 const startResize=event=>{
  event.preventDefault();const rect=container.current.getBoundingClientRect();
  const move=ev=>setWidth(bound(dashboard?ev.clientX-rect.left:rect.right-ev.clientX,420,Math.min(900,Math.max(420,rect.width-360))));
  const end=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.body.style.cursor='';document.body.style.userSelect='';resize.current=null;setWidth(value=>{store('reviewops.project.panelWidth',value);return value})};
  resize.current={move,end};document.body.style.cursor='col-resize';document.body.style.userSelect='none';document.addEventListener('pointermove',move);document.addEventListener('pointerup',end);
 };
 const openPreview=async (item,show=true)=>{
  if(item?.unloaded){try{const result=await invoke('files.read',{serviceId:service?.id||item.serviceId,projectId,path:item.path});setPreviewFile({...result,serviceId:service?.id||item.serviceId})}catch(error){if(error.code==='SSH_TRUST_REQUIRED')setTrust({...error,file:item});else onError(error.message)}}
  else if(item?.targetUrl){setPreviewUrl(item.targetUrl);setPreviewRequest(value=>value+1);setPreviewFile(null)}
  else setPreviewFile(item);
  if(show)setMobilePane('preview');
 };
 const selectTab=value=>{setTab(value);setMobilePane(value==='viewer'?'preview':'workspace')};
 const attachScreenshot=async capture=>{
  if(!capture)return;
  if(isService){await invoke('screenshot.export',capture);return}
  if(selectedReview&&!creating){
   const staged=await invoke('attachment.stageData',{dataUrl:capture.dataUrl,name:capture.name});
   let saved;
   try{saved=await mutate('activity.add',{reviewId:selectedReview.id,body:'',attachmentTokens:[staged.token]},t("스크린샷 저장 완료"))}finally{if(!saved)await invoke('attachment.discard',{tokens:[staged.token]})}
   selectTab('review');
  }else{
   setInitialScreenshot({requestId:crypto.randomUUID(),capture});setScreenshotTargetUrl(capture.url||'');setCreating(true);setReviewMode('detail');selectTab('review');
  }
 };
 const captureScreenshot=async(options)=>{const capture=await viewer.current?.capture(options);if(creating&&capture?.url)setScreenshotTargetUrl(capture.url);return capture||null};
 const tabs=[['review',t("리뷰")],['dashboard',t("대시보드")],['file',t("파일")],...(service?.kind==='ssh'?[['terminal',t("터미널")]]:[]),['settings',t("설정")]];
 const currentLabel=tabs.find(([key])=>key===tab)?.[1]||t("리뷰");
 if(!resource)return <Empty title={t("프로젝트를 찾을 수 없습니다.")}/>;
 const fullViewer=isService&&tab==='viewer';
 return <div className="original-project" data-resource-mode={resourceMode} data-project-id={isService?'':projectId} data-review-id={selectedReview?.id||''}>
  <header className="original-project-header" aria-label={t("프로젝트 정보와 기능 선택")}><div className="original-project-identity"><button className="original-project-back" aria-label={t("목록으로 돌아가기")} title={t("목록으로 돌아가기")} onClick={()=>onOpenGroup(resource.groupId,'projects')}><Icon name="back" size={14}/></button><h1 title={resource.name}>{resource.name}</h1><span className="original-project-connection-label" title={service?.rootPath||''}><Icon name={service?.kind==='ssh'?'terminal':'folder'} size={14}/>{connectionLabel(service)}</span></div><nav className="original-project-nav reviewops-tab-strip reviewops-tab-strip--text reviewops-tab-strip--desktop-text" aria-label={t("프로젝트 기능")} onKeyDown={tabKeyboard}>{tabs.map(([key,name])=><button key={key} type="button" className={`reviewops-tab ${tab===key?'active is-active':''}`} tabIndex={tab===key?0:-1} aria-pressed={tab===key} onClick={()=>selectTab(key)}>{name}</button>)}</nav></header>
  {!fullViewer&&<div className="original-mobile-pane-switcher"><div className="original-mobile-panes reviewops-tab-strip" role="group" aria-label={t("프로젝트 화면 전환")} onKeyDown={tabKeyboard}><button type="button" className={`reviewops-tab ${mobilePane==='preview'?'active is-active':''}`} aria-pressed={mobilePane==='preview'} tabIndex={mobilePane==='preview'?0:-1} onClick={()=>setMobilePane('preview')}>{dashboard?t("통계"):t("화면")}</button><button type="button" className={`reviewops-tab ${mobilePane==='workspace'?'active is-active':''}`} aria-pressed={mobilePane==='workspace'} tabIndex={mobilePane==='workspace'?0:-1} onClick={()=>setMobilePane('workspace')}>{dashboard?t("소개"):currentLabel}</button></div></div>}
  <div ref={container} className={`original-project-workspace ${dashboard?'is-dashboard':''} ${fullViewer?'viewer-only':''}`} data-mobile-pane={mobilePane}>
   <section className="original-project-preview" aria-label={dashboard?t("프로젝트 통계"):t("검토 대상 화면")}><div className="original-project-pane-label"><strong>{dashboard?t("프로젝트 현황"):t("검토 대상")}</strong><span>{dashboard?t("통계"):previewFile?(previewFile.mimeType==='application/pdf'?'PDF':/html/.test(previewFile.mimeType||'')?'HTML':t("파일")):t("화면")}</span></div><div className="original-preview-surface" hidden={!dashboard}><ProjectDashboard project={resource} reviews={reviews} activities={data.activities} attachments={data.attachments}/></div><div className="original-preview-surface" hidden={dashboard}><OriginalViewer ref={viewer} onScreenshot={attachScreenshot} service={service} services={services} invoke={invoke} file={previewFile} targetUrl={previewUrl} targetRequest={previewRequest} onError={onError} onBrowse={()=>selectTab('file')} onClearFile={()=>setPreviewFile(null)}/></div></section>
   <><div hidden={fullViewer} className="original-workspace-resizer" role="separator" tabIndex={0} aria-label={t("작업 영역 너비")} aria-orientation="vertical" aria-valuenow={Math.round(width)} aria-valuemin={420} aria-valuemax={900} onPointerDown={startResize} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?560:bound(width+(event.key==='ArrowLeft'?1:-1)*(dashboard?-24:24),420,Math.min(900,Math.max(420,(container.current?.clientWidth||1200)-360)));setWidth(next);store('reviewops.project.panelWidth',next)}}}><span/><span/><span/></div><aside hidden={fullViewer} className="original-project-task" aria-label={t("{0} 작업 영역",[dashboard?t("소개"):currentLabel])} style={{width}}>
    <div className="original-kept-panel" hidden={tab!=='review'}>{creating&&<PanelHeader title={t("리뷰")} actions={<Button icon="close" onClick={()=>setCloseRequest(value=>value+1)}>{t("등록 닫기")}</Button>}/>}<div className="original-review-create">{creating||selectedReview?<OriginalReviewPanel active={active&&tab==='review'} key={creating?'create':`${selectedReview.id}-${reviewMode}-${selectionRequest}`} mode={creating?'create':reviewMode} onCaptureScreenshot={captureScreenshot} onCollectEvidence={options=>viewer.current?.collectEvidence(options)} initialScreenshot={creating?initialScreenshot:null} onScreenshotConsumed={()=>setInitialScreenshot(null)} closeRequest={closeRequest} review={creating?undefined:selectedReview} projectId={projectId} data={data} invoke={invoke} mutate={mutate} busy={busy} defaultServiceId={service?.id||''} targetPath={file?.path||previewFile?.path||''} targetUrl={screenshotTargetUrl||previewUrl||service?.viewerUrl||''} onClose={()=>{setCreating(false);setSelectedReviewId('');setScreenshotTargetUrl('')}} onSaved={review=>{setCreating(false);setReviewMode('detail');setSelectedReviewId(review.id);setScreenshotTargetUrl('')}} onPreview={openPreview} onError={onError} onDirtyChange={value=>dirty('review',value)}/>:<ProjectReviews data={data} reviews={reviews} busy={busy} onCreate={()=>{setCreating(true);setReviewMode('detail')}} onSelect={review=>{setReviewMode('detail');setSelectedReviewId(review.id);if(review.targetPath)openPreview({unloaded:true,path:review.targetPath,serviceId:review.serviceId},false);else if(review.targetUrl){setPreviewUrl(review.targetUrl);setPreviewRequest(value=>value+1);setPreviewFile(null)}}} onRefresh={()=>mutate('snapshot',{})}/>}</div></div>
    <div className="original-kept-panel" hidden={tab!=='file'}>{service?(file?<><PanelHeader title={t("파일")} subtitle={file.path} actions={<Button icon="back" onClick={()=>setFile(null)}>{t("목록으로")}</Button>}/><div className="original-file-actions">{file.content!==undefined&&<div className="original-file-view-tabs reviewops-tab-strip" role="group" aria-label={t("파일 표시 방식")} onKeyDown={tabKeyboard}><button type="button" className="reviewops-tab" aria-pressed={fileMode==='preview'} tabIndex={fileMode==='preview'?0:-1} onClick={()=>setFileMode('preview')}>{t("미리보기")}</button><button type="button" className="reviewops-tab" aria-pressed={fileMode==='source'} tabIndex={fileMode==='source'?0:-1} onClick={()=>setFileMode('source')}>{t("원문")}</button></div>}<Button icon="external" onClick={()=>{setPreviewFile(file);setMobilePane('preview')}}>{t("뷰어에서 열기")}</Button>{!isService&&<Button icon="plus" variant="primary" onClick={()=>{setTab('review');setCreating(true)}}>{t("새 리뷰")}</Button>}</div><FileContent file={file} mode={fileMode}/></>:<FileBrowser key={service.id} service={service} onOpen={item=>{setFile(item);setFileMode('preview')}} onError={onError}/>):<Empty icon="folder" title={t("작업 폴더가 설정되지 않았습니다.")}><Button onClick={()=>selectTab('settings')}>{t("프로젝트 연결 설정")}</Button></Empty>}</div>
    {service?.kind==='ssh'&&<div className="original-kept-panel" hidden={tab!=='terminal'}><TerminalPanel key={service.id} service={service} active={tab==='terminal'} onError={onError}/></div>}
    <div className="original-kept-panel" hidden={tab!=='settings'}><ProjectSettings active={active&&tab==='settings'} project={resource} data={data} invoke={invoke} mutate={mutate} busy={busy} onDirtyChange={value=>dirty('settings',value)} onDelete={()=>onDelete('project',resource)} onOpenHosts={onOpenHosts}/></div>
    <div className="original-kept-panel" hidden={!dashboard}><ProjectIntro project={resource} mutate={mutate} busy={busy} onDirtyChange={value=>dirty('intro',value)}/></div>
   </aside></>
  </div>
  {trust&&<TrustDialog trust={trust} onClose={()=>setTrust(null)} onTrust={async()=>{try{await invoke('ssh.trust',{serviceId:service?.id||trust.file.serviceId,fingerprint:trust.fingerprint});const item=trust.file;setTrust(null);await openPreview(item)}catch(error){onError(error.message)}}}/>}
 </div>;
}

function PanelHeader({title,subtitle,actions,children}) {return <div className="original-feature-header"><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div>{children}{actions&&<div className="original-feature-actions">{actions}</div>}</div>}

function ProjectReviews({data,reviews,busy,onSelect,onCreate,onRefresh}) {
 const [statuses,setStatuses]=useState([]),[search,setSearch]=useState(''),[query,setQuery]=useState(''),[advanced,setAdvanced]=useState(false),[priority,setPriority]=useState(''),[category,setCategory]=useState(''),[sort,setSort]=useState({key:'updatedAt',direction:-1}),[page,setPage]=useState(1);
 const categories=reviewCategoryOptions({...data,reviews});
 const matches=reviews.filter(review=>(statuses.length?statuses.includes(review.status):review.status!=='closed')&&matchesReviewSearch(review,query,data)&&(!priority||priority===review.priority)&&(!category||category===review.category));
 const ranks={status:STATES.map(([key])=>key),priority:['low','normal','high','critical']};
 const sorted=[...matches].sort((a,b)=>{const compare=ranks[sort.key]?ranks[sort.key].indexOf(a[sort.key])-ranks[sort.key].indexOf(b[sort.key]):String(a[sort.key]||'').localeCompare(String(b[sort.key]||''),'ko');return compare*sort.direction});
 const pages=Math.max(1,Math.ceil(sorted.length/20)),current=Math.min(page,pages),visible=sorted.slice((current-1)*20,current*20);
 const toggleStatus=value=>{setStatuses(current=>value?(current.includes(value)?current.filter(item=>item!==value):[...current,value]):[]);setPage(1)};
 const changeSort=key=>setSort(current=>({key,direction:current.key===key?-current.direction:1}));
 return <div className="original-review-list"><PanelHeader title={t("리뷰")} actions={<><Button icon="refresh" disabled={busy} onClick={onRefresh}>{t("새로고침")}</Button><Button icon="plus" variant="primary" onClick={onCreate}>{t("새 리뷰")}</Button></>}><span className="original-feature-count">{matches.length}{t("건")}</span></PanelHeader>
  <section className="original-review-query" aria-label={t("리뷰 검색 조건")}><div className="original-status-filters"><div><span>{t("상태")}</span><button className={!statuses.length?'active':''} aria-pressed={!statuses.length} title={t("닫힘을 제외한 전체 상태")} onClick={()=>toggleStatus('')}>{t("전체")}</button>{STATES.map(([key,name])=><button key={key} className={statuses.includes(key)?'active':''} aria-pressed={statuses.includes(key)} onClick={()=>toggleStatus(key)}>{name}</button>)}</div><button className="original-filter-expand" aria-expanded={advanced} onClick={()=>setAdvanced(!advanced)}><Icon name="settings" size={12}/>{advanced?t("축소"):t("확장")}</button></div><form className="original-review-search" onSubmit={event=>{event.preventDefault();setQuery(search.trim());setPage(1)}}><label><Icon name="search" size={13}/><input aria-label={t("리뷰 제목 또는 분류")} placeholder={t("리뷰 제목 또는 분류")} value={search} onChange={event=>setSearch(event.target.value)}/></label><button type="button" className="original-clear-search" aria-label={t("검색어 지우기")} disabled={!search} onClick={()=>{setSearch('');setQuery('');setPage(1)}}><Icon name="close" size={13}/></button><Button type="submit" icon="search">{t("검색")}</Button></form>{advanced&&<div className="original-advanced-filters">{[[t("분류"),categories,category,setCategory,t("모든 분류")],[t("우선순위"),PRIORITIES,priority,setPriority,t("모든 우선순위")]].map(([title,options,value,setValue,all])=><div key={title}><span>{title}</span>{[['',all],...options].map(([key,name])=><button key={key} className={key===value?'active':''} aria-pressed={key===value} onClick={()=>{setValue(key);setPage(1)}}>{name}</button>)}</div>)}</div>}</section>
  <div className="original-review-results" role="region" aria-label={t("프로젝트 리뷰 목록")}><table className="original-review-table"><thead><tr>{[['status',t("상태")],['title',t("제목")],['priority',t("우선순위")]].map(([key,name])=><th key={key} aria-sort={sort.key===key?(sort.direction===1?'ascending':'descending'):'none'}><button onClick={()=>changeSort(key)} aria-label={t("{0} 정렬",[name])}>{name}<span>{sort.key===key?(sort.direction===1?'↑':'↓'):'↕'}</span></button></th>)}<th>{t("분류")}</th></tr></thead><tbody>{visible.map(review=><tr key={review.id} tabIndex={0} onClick={()=>onSelect(review)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(review)}}}><td><Badge status={review.status}/></td><td><strong>{review.title}</strong><div><span>{t("생성")+" "}{stamp(review.createdAt)}</span><span>{t("업데이트")+" "}{stamp(review.updatedAt)}</span></div></td><td>{label(PRIORITIES,review.priority)}</td><td>{reviewCategoryLabel(review.category,data)}</td></tr>)}{!visible.length&&<tr><td colSpan="4" className="original-list-empty">{query||priority||category?t("검색 결과가 없습니다."):t("등록된 리뷰가 없습니다.")}</td></tr>}</tbody></table></div>{pages>1&&<div className="original-pagination"><span>{matches.length}{t("건")}</span><Button onClick={()=>setPage(current-1)} disabled={current===1}>{t("이전")}</Button><span>{current} / {pages}</span><Button onClick={()=>setPage(current+1)} disabled={current===pages}>{t("다음")}</Button></div>}
 </div>;
}

export const OriginalViewer=forwardRef(function OriginalViewer({service,services,invoke,file,targetUrl,targetRequest=0,onError,onSelectService,onBrowse,onClearFile,onScreenshot},ref) {
 const initialUrl=targetUrl||service?.viewerUrl||'';
 const [viewport,setViewport]=useState(()=>serviceViewport(service)),[draft,setDraft]=useState(()=>viewportDraft(serviceViewport(service))),[preset,setPreset]=useState(()=>viewportPreset(serviceViewport(service))),[scale,setScale]=useState(service?.viewerScale||'fit'),[input,setInput]=useState(initialUrl),[browserState,setBrowserState]=useState({url:initialUrl,title:'',loading:false,canGoBack:false,canGoForward:false,error:''}),[revision,setRevision]=useState(0),[bounds,setBounds]=useState({width:800,height:700}),[fullscreen,setFullscreen]=useState(false);
 const draftRef=useRef(draft);
 const syncDraft=next=>{const value=viewportDraft(next);draftRef.current=value;setDraft(value)};
 const applyViewport=next=>{setViewport(next);setPreset(viewportPreset(next));syncDraft(next)};
 const changeDraft=(key,value)=>{const next={...draftRef.current,[key]:value};draftRef.current=next;setDraft(next);setPreset(t("직접 입력"))};
 const commitDraft=()=>{if(fullscreen)return;const dimension=key=>{const value=draftRef.current[key].trim(),number=Number(value);return value&&Number.isFinite(number)?Math.round(bound(number,240,7680)):viewport[key]};applyViewport({width:dimension('width'),height:dimension('height')})};
 const dimensionKeyDown=event=>{if(event.key==='Enter'){event.preventDefault();commitDraft()}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();syncDraft(viewport);setPreset(viewportPreset(viewport))}};
 const canvas=useRef(null),browser=useRef(null),viewportWrap=useRef(null),lastBrowserUrl=useRef(initialUrl),captureResolve=useRef(null),captureBusy=useRef(false),captureAlive=useRef(true);
 const [capturing,setCapturing]=useState(false),[screenshot,setScreenshot]=useState(null),[showLogs,setShowLogs]=useState(false),[picking,setPicking]=useState(false);
 const [browserTarget,setBrowserTarget]=useState(initialUrl),[navigationRequest,setNavigationRequest]=useState(0);
 const targetIdentity=JSON.stringify([service?.id,service?.viewerUrl,targetUrl,targetRequest]),previousTarget=useRef(targetIdentity);
 const url=browserState.url||browserTarget;
 useEffect(()=>{applyViewport(serviceViewport(service));setScale(service?.viewerScale||'fit')},[service?.id,service?.viewerWidth,service?.viewerHeight,service?.viewerScale]);
 useEffect(()=>{if(previousTarget.current===targetIdentity)return;previousTarget.current=targetIdentity;const next=targetUrl||service?.viewerUrl||'';setInput(next);setBrowserTarget(next);setNavigationRequest(value=>value+1);lastBrowserUrl.current=next;setBrowserState(current=>({...current,url:next,title:''}))},[targetIdentity]);
 useEffect(()=>{if(!canvas.current)return;const observer=new ResizeObserver(entries=>{const rect=entries[0].contentRect;if(rect.width&&rect.height)setBounds({width:rect.width,height:rect.height})});observer.observe(canvas.current);return()=>observer.disconnect()},[]);
 useLayoutEffect(()=>{const element=canvas.current;if(!element)return;element.scrollLeft=0;element.scrollTop=0;if(fullscreen&&element.clientWidth&&element.clientHeight)setBounds({width:element.clientWidth,height:element.clientHeight})},[fullscreen]);
 const fit=fullscreen?1:Math.max(.1,Math.min(1,(bounds.width-32)/viewport.width,(bounds.height-32-82)/viewport.height));
 // Keep browser-mode settings intact while the page fills the viewer area.
 const displayViewport=fullscreen?{width:bound(Math.floor(bounds.width),1,7680),height:bound(Math.floor(bounds.height),1,7680)}:viewport;
 const factor=fullscreen?1:scale==='fit'?fit:Number(scale)/100;
 const navigate=event=>{event?.preventDefault();try{const parsed=new URL(input);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error();onClearFile();if(browserTarget)browser.current?.navigate(parsed.href);else setBrowserTarget(parsed.href)}catch{onError(t("http:// 또는 https://로 시작하는 주소를 입력하십시오."))}};
 const receiveState=state=>{setBrowserState(current=>JSON.stringify(current)===JSON.stringify(state)?current:state);if(state.url&&state.url!==lastBrowserUrl.current){lastBrowserUrl.current=state.url;setInput(state.url)}};
 const reload=()=>file?setRevision(value=>value+1):browser.current?.reload();
 const adjust=delta=>setScale(String(bound((scale==='fit'?Math.round(fit*100):Number(scale))+delta,10,200)));
 const toggleFullscreen=()=>{syncDraft(viewport);setPreset(viewportPreset(viewport));setFullscreen(value=>!value)};
 const finishCapture=result=>{captureBusy.current=false;setScreenshot(null);setCapturing(false);const resolve=captureResolve.current;captureResolve.current=null;resolve?.(result)};
 useEffect(()=>{captureAlive.current=true;return()=>{captureAlive.current=false;captureResolve.current?.(null);captureResolve.current=null}},[]);
 const collectEvidence=useCallback(async()=>{const base={schemaVersion:1,capturedAt:new Date().toISOString(),available:Boolean(file||browserTarget),url:file?'':browserState.url||browserTarget,targetPath:file?.path||'',title:file?.name||browserState.title||'',viewport:{...displayViewport,scale:factor},navigation_log:[],input_log:[],network_log:[],console_log:[],fingerprint_log:{}};if(file)return {...base,source:'file',fingerprint_log:{name:file.name,path:file.path,mimeType:file.mimeType}};if(!browserTarget)return base;const logs=await browser.current?.evidence();return {...base,...logs,available:true,viewport:base.viewport}},[file,browserTarget,browserState.url,browserState.title,displayViewport.width,displayViewport.height,factor]);
 const capture=async(options={})=>{
  if(options.mode==='none')return null;
  if(captureBusy.current)throw new Error(t("열린 스크린샷을 먼저 저장하거나 취소하십시오."));
  captureBusy.current=true;setCapturing(true);
  try{
   let result;
   if(file){
    const rect=viewportWrap.current?.getBoundingClientRect(),visible=canvas.current?.getBoundingClientRect();
    if(!rect||!visible)throw new Error(t("캡처할 파일을 먼저 여십시오."));
    const x=Math.max(0,rect.left,visible.left),y=Math.max(0,rect.top,visible.top),right=Math.min(window.innerWidth,rect.right,visible.right),bottom=Math.min(window.innerHeight,rect.bottom,visible.bottom);
    if(right<=x||bottom<=y)throw new Error(t("캡처할 화면이 보이지 않습니다."));
    result=await invoke('viewer.capture',{bounds:{x,y,width:right-x,height:bottom-y}});
   }else result=await browser.current?.capture();
   if(!captureAlive.current){captureBusy.current=false;return null}
   if(!result?.dataUrl)throw new Error(t("캡처할 화면을 먼저 여십시오."));
   if(options.mode==='auto'){captureBusy.current=false;setCapturing(false);return result}
   setScreenshot(result);
   return await new Promise(resolve=>{captureResolve.current=resolve});
  }catch(error){captureBusy.current=false;if(captureAlive.current)setCapturing(false);throw error}
 };
 useImperativeHandle(ref,()=>({capture,collectEvidence}));
 const captureFromToolbar=async()=>{try{const result=await capture();if(result&&captureAlive.current)await onScreenshot?.(result)}catch(error){if(captureAlive.current)onError?.(error.message)}};
 const showSelectedElement=async()=>{
  try{
   const selected=await browser.current?.showElement(),area=canvas.current,viewportRect=viewportWrap.current?.getBoundingClientRect();
   if(!selected?.rect||!area||!viewportRect)return;
   const clip=area.getBoundingClientRect(),r=selected.rect,left=viewportRect.left+r.x*factor,top=viewportRect.top+r.y*factor,right=left+r.width*factor,bottom=top+r.height*factor;
   area.scrollBy({left:left<clip.left||right>clip.right?(left+right-clip.left-clip.right)/2:0,top:top<clip.top||bottom>clip.bottom?(top+bottom-clip.top-clip.bottom)/2:0,behavior:'instant'});
   setBrowserState(current=>({...current,selectedElement:selected}));
  }catch(error){onError?.(error.message)}
 };
 return <div className={`original-viewer${fullscreen?' is-fullscreen':''}`}>
  <div className="original-viewer-toolbar">
   <div className="original-viewer-settings" role="group" aria-label={t("뷰어 설정")}><span className="original-viewer-control-label">{t("뷰어 설정")}</span><Select searchable={false} aria-label={t("화면 크기")} disabled={fullscreen} value={preset} onChange={event=>{const item=VIEWER_PRESETS.find(([name])=>name===event.target.value);if(item)applyViewport({width:item[1],height:item[2]});else{setPreset(t("직접 입력"));syncDraft(viewport)}}}>{VIEWER_PRESETS.map(([name])=><option key={name}>{name}</option>)}<option>{t("직접 입력")}</option></Select><div className="original-viewer-dimensions"><input type="number" aria-label={t("뷰포트 너비")} min="240" max="7680" step="1" value={fullscreen?displayViewport.width:draft.width} disabled={fullscreen} onChange={event=>changeDraft('width',event.target.value)} onBlur={commitDraft} onKeyDown={dimensionKeyDown}/><span aria-hidden="true">×</span><input type="number" aria-label={t("뷰포트 높이")} min="240" max="7680" step="1" value={fullscreen?displayViewport.height:draft.height} disabled={fullscreen} onChange={event=>changeDraft('height',event.target.value)} onBlur={commitDraft} onKeyDown={dimensionKeyDown}/></div><div className="original-scale-control"><button aria-label={t("뷰포트 축소")} title={t("뷰포트 축소")} disabled={fullscreen} onClick={()=>adjust(-10)}>−</button><Select searchable={false} aria-label={t("뷰포트 배율")} disabled={fullscreen} value={fullscreen?'fit':scale} onChange={event=>setScale(event.target.value)}><option value="fit">{t("맞춤 (")}{Math.round(fit*100)}%)</option>{[25,50,75,100,125,150,200,...(scale!=='fit'&&![25,50,75,100,125,150,200].includes(Number(scale))?[Number(scale)]:[])].sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value}%</option>)}</Select><button aria-label={t("뷰포트 확대")} title={t("뷰포트 확대")} disabled={fullscreen} onClick={()=>adjust(10)}>+</button></div></div>
   <div className="original-viewer-functions" role="group" aria-label={t("기능")}><span className="original-viewer-control-label">{t("기능")}</span><Button icon="refresh" aria-label={t("새로고침")} title={t("새로고침")} onClick={reload}/><Button icon="image" aria-label={t("스크린샷")} title={t("스크린샷")} disabled={capturing||(!file&&(!browserTarget||!browserState.id||browserState.loading||Boolean(browserState.error)))} onClick={captureFromToolbar}/><Button icon={fullscreen?'compress':'expand'} className="original-fullscreen-toggle" variant={fullscreen?'primary':''} aria-label={fullscreen?t("전체화면 종료"):t("전체화면")} title={fullscreen?t("뷰어 전체화면 종료"):t("뷰어 전체화면")} aria-pressed={fullscreen} onClick={toggleFullscreen}/><Button icon="file" aria-label={t("로그")} title={t("로그")} aria-pressed={showLogs} onClick={()=>setShowLogs(value=>!value)}/><Button icon="search" aria-label={picking?t("요소 선택 중 · Esc 취소"):t("요소 지정")} title={picking?t("요소 선택 중 · Esc 취소"):t("요소 지정")} disabled={picking||!!file||!browserState.id} onClick={async()=>{setPicking(true);try{await browser.current?.pickElement()}catch(error){onError?.(error.message)}finally{setPicking(false)}}}/></div>
  </div>

  {!file&&browserState.selectedElement&&<div className="viewer-selected-element"><strong>{t("선택 요소")}</strong><span title={[...(browserState.selectedElement.framePath||[]),browserState.selectedElement.selector].join(' → ')}>{[...(browserState.selectedElement.framePath||[]),browserState.selectedElement.selector].join(' → ')}</span><button type="button" className="viewer-element-action" disabled={picking} onClick={showSelectedElement} title={t("선택 요소로 이동")}><Icon name="search" size={12}/>{t("선택 요소로 이동")}</button><button type="button" className="viewer-element-action" onClick={()=>browser.current?.clearElement()} title={t("요소 표시 해제")}><Icon name="close" size={12}/>{t("요소 표시 해제")}</button></div>}
  <div ref={canvas} className="original-viewer-canvas"><div className="original-browser-shell" style={fullscreen?{width:'100%',height:'100%'}:{width:viewport.width*factor,height:viewport.height*factor+82}}><div className="original-browser-tabs" hidden={fullscreen}><div className="original-window-dots"><i/><i/><i/></div><div className="original-browser-tab"><Icon name="external" size={12}/><span>{file?.name||browserState.title||service?.name||t("검토 대상")}</span>{!file&&browserState.loading&&<i className="native-browser-loading" aria-label={t("페이지 여는 중")}/>}</div></div><form className="original-browser-address" hidden={fullscreen} onSubmit={navigate}><div className="original-browser-navigation"><button type="button" aria-label={t("뒤로")} disabled={!!file||!browserState.canGoBack} onClick={()=>browser.current?.back()}><Icon name="back" size={12}/></button><button type="button" aria-label={t("앞으로")} disabled={!!file||!browserState.canGoForward} onClick={()=>browser.current?.forward()}><Icon name="chevron" size={12}/></button><button type="button" aria-label={t("뷰어 새로고침")} onClick={reload}><Icon name="refresh" size={12}/></button></div><label><Icon name={file?'file':'lock'} size={11}/><input aria-label={t("뷰어 주소")} placeholder="http://localhost:3000" value={file?file.path||file.name:input} readOnly={!!file} onChange={event=>setInput(event.target.value)}/>{file?<button type="button" aria-label={t("파일 닫기")} onClick={event=>{event.preventDefault();onClearFile()}}><Icon name="close" size={12}/></button>:<button type="submit" aria-label={t("이동")}><Icon name="arrow" size={13}/></button>}</label>{url&&!file&&<button type="button" aria-label={t("브라우저에서 열기")} title={t("브라우저에서 열기")} onClick={()=>invoke('external.open',{url}).catch(error=>onError(error.message))}><Icon name="external" size={13}/></button>}</form><div ref={viewportWrap} className="original-viewport-wrap" style={{height:fullscreen?'100%':viewport.height*factor}}><div className="original-viewport" style={{width:displayViewport.width,height:displayViewport.height,transform:`scale(${factor})`}}><NativeBrowser ref={browser} invoke={invoke} contextId={service?.id||''} url={browserTarget} navigationRequest={navigationRequest} enabled={!file&&Boolean(browserTarget)} viewport={{...displayViewport,scale:factor}} onState={receiveState} onError={onError}/>{file?<FileContent key={`${file.path||file.name}-${revision}`} file={file}/>:!browserTarget?<div className="original-viewer-empty"><p>{service?t("뷰어 주소가 설정되지 않았습니다."):t("작업 폴더가 설정되지 않았습니다.")}</p>{service&&<Button icon="folder" onClick={onBrowse}>{t("파일 열기")}</Button>}</div>:null}</div></div></div></div>
  {showLogs&&<BrowserLogs collect={collectEvidence} onClear={!file&&browserTarget?kind=>browser.current?.clearLogs(kind):undefined} onClose={()=>setShowLogs(false)} onError={onError}/>}
  {screenshot&&<ScreenshotEditor capture={screenshot} onConfirm={finishCapture} onCancel={()=>finishCapture(null)}/>}
 </div>;
});

function ProjectSettings({active=true,project,data,invoke,mutate,busy,onDirtyChange,onDelete,onOpenHosts}) {
 const savedConnection={...PROJECT_CONNECTION_DEFAULTS,...projectConnection(project,data)};
 const initial={name:project.name,description:project.description||'',memo:project.memo||'',labels:project.labels||[],operationalStatus:project.operationalStatus||'active',connection:savedConnection};
 const [section,setSection]=useState('info'),[form,setForm]=useState(initial),[labelInput,setLabelInput]=useState(''),[error,setError]=useState(''),[testing,setTesting]=useState(false),[connectionResult,setConnectionResult]=useState(null),[trust,setTrust]=useState(null);
 const formId=useId(),callback=useRef(onDirtyChange),baseline=useRef(initial);callback.current=onDirtyChange;
 useEffect(()=>{const prior=baseline.current;setForm(current=>Object.fromEntries(Object.keys(initial).map(key=>[key,JSON.stringify(current[key])===JSON.stringify(prior[key])?initial[key]:current[key]])));baseline.current=initial},[project.updatedAt,JSON.stringify(project.connection)]);
 const dirty=JSON.stringify(form)!==JSON.stringify(initial)||Boolean(labelInput.trim());
 useEffect(()=>{callback.current?.(dirty);return()=>callback.current?.(false)},[dirty]);
 useEffect(()=>{if(!dirty)return;const guard=event=>{event.preventDefault();event.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[dirty]);
 const set=(key,value)=>setForm(current=>({...current,[key]:value}));
 const setConnection=(key,value)=>setForm(current=>({...current,connection:{...current.connection,[key]:value}}));
 const addLabel=()=>{const values=labelInput.split(/[,\n]/).map(value=>value.trim().replace(/^#+/,'')).filter(Boolean);if(values.length)set('labels',[...new Set([...form.labels,...values])]);setLabelInput('')};
 const save=async event=>{event.preventDefault();const invalid=!form.name.trim()?t("프로젝트명을 입력하십시오."):validateProjectConnection(form.connection);if(invalid){setError(invalid);if(!form.connection.rootPath?.trim()||form.connection.kind==='ssh'&&!form.connection.hostAlias?.trim()&&!(form.connection.id&&form.connection.host))setSection('connection');return}setError('');const labels=[...new Set([...form.labels,...labelInput.split(/[,\n]/).map(value=>value.trim().replace(/^#+/,'')).filter(Boolean)])];try{const result=await mutate('project.save',{id:project.id,...form,name:form.name.trim(),labels},t("프로젝트 저장 완료"));if(result){setForm({name:result.name,description:result.description||'',memo:result.memo||'',labels:result.labels||labels,operationalStatus:result.operationalStatus||'active',connection:{...PROJECT_CONNECTION_DEFAULTS,...projectConnection(result,data)}});setLabelInput('');setConnectionResult(null)}}catch(cause){setError(cause.message)}};
 const testConnection=async()=>{setTesting(true);setConnectionResult(null);try{const result=await invoke('ssh.test',{projectId:project.id,serviceId:savedConnection.id});setConnectionResult({ok:true,message:t("연결 완료 · {0}",[result.host||savedConnection.hostAlias||savedConnection.host])})}catch(cause){if(cause.code==='SSH_TRUST_REQUIRED')setTrust({host:cause.host||savedConnection.hostAlias||savedConnection.host,fingerprint:cause.fingerprint});else setConnectionResult({ok:false,message:cause.message})}finally{setTesting(false)}};
 const connectionDirty=JSON.stringify(form.connection)!==JSON.stringify(savedConnection);
 const sections=[['info',t("프로젝트 정보")],['connection',t("연결")],['viewer',t("뷰어")],['agent',t("에이전트")],['etc',t("기타")]];
 return <div className="original-project-settings"><div className="original-settings-subnav"><nav className="reviewops-tab-strip reviewops-tab-strip--text original-project-settings-tabs" aria-label={t("프로젝트 설정 항목")} role="tablist" onKeyDown={tabKeyboard}>{sections.map(([key,name])=><button type="button" role="tab" aria-selected={section===key} tabIndex={section===key?0:-1} key={key} className={`reviewops-tab ${section===key?'active is-active':''}`} onClick={()=>setSection(key)}>{name}</button>)}</nav>{section!=='etc'&&<Button type="submit" form={formId} variant="primary" disabled={busy}>{busy?t("저장 중"):t("저장하기")}</Button>}</div><div className="original-project-settings-content"><form id={formId} onSubmit={save} noValidate>
  <div hidden={section!=='info'}><section className="original-setting-panel" aria-label={t("프로젝트 정보")}><PanelHeader title={t("프로젝트 정보")} subtitle={t("프로젝트의 기본 정보와 업무 상태를 관리합니다.")}/><div className="original-setting-body"><label><span>{t("프로젝트명")}</span><input aria-label={t("프로젝트명")} value={form.name} onChange={event=>set('name',event.target.value)} required maxLength={200}/></label><label><span>{t("설명")}</span><textarea aria-label={t("설명")} rows="4" value={form.description} onChange={event=>set('description',event.target.value)}/></label><label><span>{t("기록용 메모")}</span><textarea aria-label={t("기록용 메모")} rows="5" value={form.memo} onChange={event=>set('memo',event.target.value)} placeholder={t("접속 정보와 작업 내용을 기록합니다.")}/></label><div><span className="original-field-label">{t("라벨")}</span><div className="original-label-input">{form.labels.map(value=><span key={value}>#{value}<button type="button" aria-label={t("{0} 라벨 삭제",[value])} onClick={()=>set('labels',form.labels.filter(item=>item!==value))}><Icon name="close" size={11}/></button></span>)}<input value={labelInput} aria-label={t("라벨 입력")} placeholder={t("라벨 입력 후 Enter")} onChange={event=>setLabelInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();addLabel()}}}/><Button type="button" onClick={addLabel}>{t("추가")}</Button></div></div><OperationalStatusField value={form.operationalStatus} onChange={value=>set('operationalStatus',value)}/></div></section></div>
  <div hidden={section!=='connection'}><section className="original-setting-panel" aria-label={t("프로젝트 연결")}><PanelHeader title={t("프로젝트 연결")} subtitle={t("로컬 폴더 또는 등록된 SSH 호스트의 작업 폴더를 선택합니다.")}/><div className="original-setting-body"><ProjectConnectionFields form={form.connection} set={setConnection} busy={busy} setError={setError} onOpenHosts={onOpenHosts}/>{form.connection.kind==='ssh'&&<div className="original-connection-test"><Button type="button" disabled={busy||testing||connectionDirty||!savedConnection.id} onClick={testConnection}>{testing?t("접속 중"):t("연결 검사")}</Button><p>{connectionDirty?t("변경 내용을 저장한 뒤 검사할 수 있습니다."):t("저장된 SSH 호스트와 작업 폴더로 검사합니다.")}</p>{connectionResult&&<div role="status" className={connectionResult.ok?'connection-ok':'form-error'}>{connectionResult.message}</div>}</div>}</div></section></div>
  <div hidden={section!=='viewer'}><section className="original-setting-panel" aria-label={t("뷰어 설정")}><PanelHeader title={t("뷰어 설정")}/><div className="original-setting-body"><ViewerFields form={form.connection} set={setConnection}/></div></section></div>
  <div hidden={section!=='agent'}><section className="original-setting-panel" aria-label={t("에이전트 설정")}><PanelHeader title={t("에이전트 설정")}/><div className="original-setting-body">{savedConnection.id?<AgentSettings active={active&&section==='agent'} form={form.connection} set={setConnection} service={savedConnection} busy={busy}/>:<p>{t("프로젝트 연결을 저장한 뒤 에이전트를 설정할 수 있습니다.")}</p>}</div></section></div>
 </form>{error&&<p className="form-error original-project-settings-error" role="alert">{error}</p>}<div hidden={section!=='etc'}><section className="original-setting-panel original-delete-section"><PanelHeader title={t("프로젝트 삭제")}/><div className="original-setting-body"><p>{t("프로젝트의 리뷰, 작업이력과 첨부 파일을 함께 삭제합니다.")}</p><div className="original-setting-actions"><Button variant="danger" icon="trash" disabled={busy} onClick={onDelete}>{t("프로젝트 삭제")}</Button></div></div></section></div></div>{trust&&<TrustDialog trust={trust} onClose={()=>setTrust(null)} onTrust={async()=>{try{await invoke('ssh.trust',{projectId:project.id,serviceId:savedConnection.id,fingerprint:trust.fingerprint});setTrust(null);testConnection()}catch(cause){setError(cause.message);setTrust(null)}}}/>}</div>;
}

function ProjectIntro({project,mutate,busy,onDirtyChange}) {
 const [editing,setEditing]=useState(false),[text,setText]=useState(project.intro||'');
 const callback=useRef(onDirtyChange);callback.current=onDirtyChange;
 useEffect(()=>{callback.current?.(editing&&text!==(project.intro||''));return()=>callback.current?.(false)},[editing,text,project.intro]);
 return <div className="original-intro"><PanelHeader title={t("소개")} actions={editing?<><Button disabled={busy} onClick={()=>{setText(project.intro||'');setEditing(false)}}>{t("취소")}</Button><Button variant="primary" disabled={busy} onClick={async()=>{const result=await mutate('project.save',{...project,intro:text},t("프로젝트 소개 저장 완료"));if(result)setEditing(false)}}>{t("저장")}</Button></>:<Button onClick={()=>{setText(project.intro||'');setEditing(true)}}>{t("수정하기")}</Button>}/><div className="original-intro-content">{editing?<textarea aria-label={t("프로젝트 소개")} rows="16" value={text} onChange={event=>setText(event.target.value)}/>:<div className="original-intro-description">{project.intro||t("등록된 소개가 없습니다.")}</div>}</div></div>;
}

function ProjectDashboard({project,reviews,activities,attachments}) {
 const ids=new Set(reviews.map(item=>item.id)),events=activities.filter(item=>ids.has(item.reviewId));
 const completed=reviews.filter(item=>['resolved','closed'].includes(item.status)).length;
 const dates=[...new Set([...reviews,...events].map(item=>item.createdAt?.slice(0,10)).filter(Boolean))].sort().slice(-14);
 const daily=dates.map(day=>({day,reviews:reviews.filter(item=>item.createdAt?.startsWith(day)).length,activities:events.filter(item=>item.createdAt?.startsWith(day)).length}));
 const max=Math.max(1,...daily.map(item=>Math.max(item.reviews,item.activities)));
 return <div className="original-dashboard"><PanelHeader title={t("프로젝트 통계")} subtitle={t("업데이트 {0}",[stamp(project.updatedAt)])}/><div className="original-dashboard-scroll"><div className="original-metrics">{[[t("전체 리뷰"),reviews.length],[t("진행 리뷰"),reviews.length-completed],[t("완료 리뷰"),completed],[t("작업이력"),events.length]].map(([name,value])=><div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div><section><h3>{t("날짜별 추이")}</h3><div className="original-chart" aria-label={t("날짜별 리뷰와 작업이력")}>{daily.map(item=><div key={item.day}><div><span style={{height:`${item.reviews/max*100}%`}} title={t("{0} 리뷰 {1}건",[item.day,item.reviews])}/><span style={{height:`${item.activities/max*100}%`}} title={t("{0} 작업이력 {1}건",[item.day,item.activities])}/></div><small>{item.day.slice(5)}</small></div>)}{!daily.length&&<p>{t("등록된 기록이 없습니다.")}</p>}</div><div className="original-chart-legend"><span>{t("리뷰")}</span><span>{t("작업이력")}</span></div></section><section><h3>{t("상태별 리뷰")}</h3><div className="original-status-chart">{STATES.map(([key,name])=>{const count=reviews.filter(item=>item.status===key).length;return <div key={key}><span>{name}</span><div><i style={{width:`${reviews.length?count/reviews.length*100:0}%`}}/></div><strong>{count}{t("건")}</strong></div>})}</div></section><section><h3>{t("최근 날짜별 현황")}</h3><table><thead><tr><th>{t("날짜")}</th><th>{t("리뷰")}</th><th>{t("작업이력")}</th></tr></thead><tbody>{[...daily].reverse().map(item=><tr key={item.day}><td>{item.day}</td><td>{item.reviews}</td><td>{item.activities}</td></tr>)}{!daily.length&&<tr><td colSpan="3">{t("등록된 기록이 없습니다.")}</td></tr>}</tbody></table></section></div></div>;
}
