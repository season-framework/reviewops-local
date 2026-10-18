import {t,localized,useLocale} from './i18n/index.js';
import React, {useEffect, useRef, useState} from 'react';
import Icon from './icons.jsx';
import {tabKeyboard} from './tabKeyboard.js';
import WorkHome from './WorkHome.jsx';
import ProjectWorkspace from './ProjectWorkspace.jsx';
import {RegistrationScreen,GroupSettings} from './OriginalForms.jsx';
import GroupResourceList, {GroupListIcon} from './GroupResourceList.jsx';
import GroupsList from './GroupsList.jsx';
import useWorkspaceTabOrder from './useWorkspaceTabOrder.js';
import {CodexManagement} from './codex/CodexManagement.jsx';
import {deletionTargets,deletedTab,clearDeletionDrafts} from './deletion.mjs';
import {EMPTY, date, invoke, Button, Empty, Field, Dialog, TrustDialog, EntityDialog, FileContent, DataSettings} from './components.jsx';

const HOME = {id:'home',kind:'home'};
const nouns = localized({group:'그룹',project:'프로젝트',service:'서비스',review:'리뷰'});
const unique = () => crypto.randomUUID();
function savedTabs() {
 try { const saved=JSON.parse(localStorage.getItem('reviewops.workspace.tabs')||'[]');return [HOME,...saved.filter(t=>['groups','group','project','service','settings','accounts','hosts'].includes(t.kind)&&typeof t.id==='string'&&t.id!=='home').slice(0,30)]; } catch {return [HOME];}
}

export default function App() {
 useLocale();
 const [data,setData]=useState(EMPTY),[ready,setReady]=useState(false),[tabs,setTabs]=useState(savedTabs),[active,setActive]=useState('home');
 const [error,setError]=useState(''),[toast,setToast]=useState(''),[busy,setBusy]=useState(false),[modal,setModal]=useState(null),[closePending,setClosePending]=useState(null);
 const [deleteConfirm,setDeleteConfirm]=useState('');
 const [updateState,setUpdateState]=useState(null);
 const dataLoaded=useRef(false);
 useEffect(()=>{let alive=true;invoke('update.state').then(value=>{if(alive)setUpdateState(value)}).catch(()=>{});const unsubscribe=window.reviewops?.onUpdateState?.(value=>{if(alive)setUpdateState(value)});return()=>{alive=false;unsubscribe?.()}},[]);
 useEffect(()=>{if(!ready||!dataLoaded.current)return;const frame=requestAnimationFrame(()=>invoke('update.rendererReady').catch(()=>{}));return()=>cancelAnimationFrame(frame)},[ready]);
 const [dark,setDark]=useState(()=>localStorage.getItem('reviewops.theme')==='dark'),[expanded,setExpanded]=useState(()=>localStorage.getItem('reviewops.sidebar.expanded')==='true');
 const [windowState,setWindowState]=useState({maximized:false,fullScreen:false}),[windowChanging,setWindowChanging]=useState(false);
 const [homeSelection,setHomeSelection]=useState({id:'',request:0});
 const dirtyTabs=useRef(new Set()),tabsRef=useRef(tabs);tabsRef.current=tabs;
 useEffect(()=>{const guard=event=>{if(dirtyTabs.current.size){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[]);
 const [workspaceRevision,setWorkspaceRevision]=useState(0);
 const reload=async()=>{const result=await invoke('snapshot');setData({...EMPTY,...result});dataLoaded.current=true;setReady(true);return result};
 useEffect(()=>{reload().catch(e=>{setError(e.message);setReady(true)})},[]);
 useEffect(()=>{
  let live=true,updated=false;
  const unsubscribe=window.reviewops?.onWindowState?.(state=>{updated=true;if(live)setWindowState(state)});
  invoke('window.state').then(state=>{if(live&&!updated)setWindowState(state)}).catch(e=>{if(live)setError(e.message)});
  return()=>{live=false;unsubscribe?.()};
 },[]);
 useEffect(()=>{if(!data.agentRunning)return;let live=true,timer;const poll=async()=>{try{const result=await invoke('snapshot');if(!live)return;setData({...EMPTY,...result});if(result.agentRunning)timer=setTimeout(poll,1000)}catch(e){if(live){setError(e.message);timer=setTimeout(poll,3000)}}};timer=setTimeout(poll,1000);return()=>{live=false;clearTimeout(timer)}},[data.agentRunning]);
 useEffect(()=>{localStorage.setItem('reviewops.workspace.tabs',JSON.stringify(tabs.filter(t=>!['editor','home'].includes(t.kind))))},[tabs]);
 useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';localStorage.setItem('reviewops.theme',dark?'dark':'light')},[dark]);
 useEffect(()=>{localStorage.setItem('reviewops.sidebar.expanded',String(expanded))},[expanded]);
 useEffect(()=>{if(toast){const timer=setTimeout(()=>setToast(''),3500);return()=>clearTimeout(timer)}},[toast]);
 const run=async(fn,message)=>{setBusy(true);setError('');try{const result=await fn();if(message)setToast(message);return result}catch(e){setError(e.message);return null}finally{setBusy(false)}};
 const mutate=async(action,payload,message)=>run(async()=>{
  const entity=/^(group|project|service|review)\.delete$/.exec(action)?.[1];
  const targets=entity?deletionTargets(data,entity,payload.id):null;
  const deletingHomeReview=targets&&(targets.reviewIds.has(homeSelection.id)||targets.reviewIds.has(localStorage.getItem('reviewops.home.selected')));
  const result=await invoke(action,payload);
  if(targets){
   const closing=tabsRef.current.filter(tab=>deletedTab(tab,targets)).map(tab=>tab.id);
   closing.forEach(id=>dirtyTabs.current.delete(id));
   if(deletingHomeReview)dirtyTabs.current.delete('home');
   setTabs(current=>current.filter(tab=>!deletedTab(tab,targets)).map(tab=>targets.reviewIds.has(tab.reviewId)?{...tab,reviewId:'',reviewMode:'detail'}:tab));
   setActive(current=>closing.includes(current)?'home':current);
   setClosePending(current=>closing.includes(current)?null:current);
   setHomeSelection(current=>targets.reviewIds.has(current.id)?{id:'',request:Date.now()}:current);
   const tokens=clearDeletionDrafts(localStorage,targets);
   if(tokens.length)invoke('attachment.discard',{tokens}).catch(()=>{});
   setData(current=>({...current,
    groups:current.groups.filter(item=>!targets.groupIds.has(item.id)),
    projects:current.projects.filter(item=>!targets.projectIds.has(item.id)),
    services:current.services.filter(item=>!targets.serviceIds.has(item.id)),
    reviews:current.reviews.filter(item=>!targets.reviewIds.has(item.id)),
    activities:current.activities.filter(item=>!targets.reviewIds.has(item.reviewId)),
    attachments:current.attachments.filter(item=>!targets.reviewIds.has(item.reviewId))
   }));
   try{await reload()}catch(cause){setError(t("삭제했습니다. 화면을 새로고침하지 못했습니다. {0}",[cause.message||String(cause)]))}
  }else await reload();
  return result;
 },message);
 const beforeRestore=()=>{if(dirtyTabs.current.size)throw new Error(t("작성 중인 설정을 저장하거나 닫은 뒤 백업을 복원하십시오."));};
 const restoreWorkspace=async()=>{
  await reload();
  dirtyTabs.current.clear();
  setTabs(current=>current.filter(tab=>['home','settings'].includes(tab.kind)));
  setHomeSelection({id:'',request:Date.now()});
  setWorkspaceRevision(value=>value+1);
 };
 const openTab=(kind,entityId='',extra={})=>{
  const existing=tabsRef.current.find(t=>t.kind===kind&&(t.entityId||'')===entityId);
  if(existing){if(Object.keys(extra).length)setTabs(current=>current.map(t=>t.id===existing.id?{...t,...extra}:t));setActive(existing.id);return existing.id;}
  const tab={id:unique(),kind,entityId,...extra};setTabs(current=>[...current,tab]);setActive(tab.id);return tab.id;
 };
 useEffect(()=>{
  if(!ready)return;
  setTabs(current=>current.map(tab=>{
   if(tab.kind!=='service')return tab;
   const project=data.projects.find(item=>item.serviceIds?.includes(tab.entityId));
   const service=data.services.find(item=>item.id===tab.entityId);
   return project?{...tab,kind:'project',entityId:project.id,section:'settings'}:service?{...tab,kind:'group',entityId:service.groupId,section:'projects'}:{...tab,kind:'hosts',entityId:''};
  }));
 },[ready]);
 const openGroups=()=>openTab('groups');
 const openHosts=()=>openTab('hosts');
 const openGroup=(id,section='projects')=>openTab('group',id,{section,sectionRequest:Date.now()});
 const openProject=(id,extra={})=>openTab('project',id,{...extra,sectionRequest:Date.now()});
 const openService=(id,extra={})=>{const project=data.projects.find(item=>item.serviceIds?.includes(id));return project?openProject(project.id,extra):openHosts()};
 const openReview=review=>{setHomeSelection({id:typeof review==='string'?review:review.id,request:Date.now()});setActive('home')};
 useEffect(()=>{
  let live=true,lastRequest=0;
  const receive=async value=>{
   if(!value?.reviewId||value.request<=lastRequest)return;
   lastRequest=value.request;
   try{
    const result=await reload();
    if(!live||value.request!==lastRequest)return;
    const review=result.reviews.find(item=>item.id===value.reviewId);
    const project=result.projects.find(item=>item.id===(value.projectId||review?.projectId));
    if((value.view&&value.view!=='project')||!review||!project||review.projectId!==project.id)throw new Error(t("요청한 리뷰의 프로젝트를 찾을 수 없습니다."));
    const extra={section:'review',sectionRequest:value.request,reviewId:review.id,reviewMode:'detail',selectionRequest:value.request,integrationRequest:value.request};
    const existing=tabsRef.current.find(tab=>tab.kind==='project'&&tab.entityId===project.id&&!dirtyTabs.current.has(tab.id));
    if(existing){setTabs(current=>current.map(tab=>tab.id===existing.id?{...tab,...extra}:tab));setActive(existing.id);}
    else {const tab={id:unique(),kind:'project',entityId:project.id,...extra};setTabs(current=>[...current,tab]);setActive(tab.id);}
   }catch(error){if(live&&value.request===lastRequest){setError(error.message);invoke('integration.displayed',{...value,view:'project',section:'review',error:error.message}).catch(()=>{});}}
  };
  const unsubscribe=window.reviewops?.onIntegrationReview?.(receive);
  const stopUpdates=window.reviewops?.onIntegrationUpdate?.(()=>{reload().catch(error=>{if(live)setError(error.message)})});
  invoke('integration.pending').then(receive).catch(()=>{});
  return()=>{live=false;unsubscribe?.();stopUpdates?.()};
 },[]);
 const closeTab=id=>{
  if(id==='home')return;
  dirtyTabs.current.delete(id);
  setTabs(current=>{const index=current.findIndex(t=>t.id===id),closing=current[index];const returnId=closing?.returnTabId&&current.some(tab=>tab.id===closing.returnTabId)?closing.returnTabId:current[Math.max(0,index-1)]?.id||'home';if(active===id)setActive(returnId);return current.filter(t=>t.id!==id)});
 };
 const requestClose=id=>dirtyTabs.current.has(id)?setClosePending(id):closeTab(id);
 const edit=(type,record={})=>{
  setError('');
  if(type==='group'){if(record.id)openGroup(record.id,'settings');else setModal({type,record});return;}
  if(type==='review'){openProject(record.projectId,{reviewId:record.id||'',reviewMode:record.id?'edit':'create',selectionRequest:Date.now(),section:'review'});return;}
  if(record.id){if(type==='project')openProject(record.id,{section:'settings'});else openService(record.id,{section:'settings'});return;}
  const existing=tabs.find(t=>t.kind==='editor'&&t.entityType===type&&(record.id?t.record.id===record.id:!t.record.id&&t.record.groupId===record.groupId));
  if(existing){setActive(existing.id);return;}
  const tab={id:unique(),kind:'editor',entityType:type,record};setTabs(current=>[...current,tab]);setActive(tab.id);
 };
 const createReview=(projectId,extra={})=>edit('review',{projectId,status:'open',priority:'normal',category:'bug',...extra});
 const createService=({groupId,onCreated}={})=>{const tab={id:unique(),kind:'editor',entityType:'service',record:{groupId},returnTabId:active,onCreated};setTabs(current=>[...current,tab]);setActive(tab.id);};
 const remove=(type,record)=>{setError('');setDeleteConfirm('');setModal({type:'delete',entity:type,record})};
 const save=async(type,record,tabId)=>{
  const result=await mutate(`${type}.save`,record,t("{0} 저장 완료",[nouns[type]]));
  if(!result)return null;
  const source=tabsRef.current.find(tab=>tab.id===tabId);
  if(tabId){dirtyTabs.current.delete(tabId);setTabs(current=>current.filter(t=>t.id!==tabId));}
  setModal(null);
  if(source?.onCreated&&tabsRef.current.some(tab=>tab.id===source.returnTabId)){source.onCreated(result);setActive(source.returnTabId);return result;}
  if(type==='group')openGroup(result.id);
  if(type==='project')openProject(result.id);
  if(type==='service')openService(result.id);
  if(type==='review')openReview(result);
  return result;
 };
 const deleteRecord=async()=>{
  const {entity,record}=modal;
  if(busy||!deleteConfirm||deleteConfirm!==(record.name||record.title)||entity==='service'&&data.projects.some(project=>project.serviceIds?.includes(record.id)))return;
  const result=await mutate(`${entity}.delete`,{id:record.id},t("{0} 삭제 완료",[nouns[entity]]));
  if(!result)return;
  setModal(null);
  if(entity==='group')openGroups();else if(record.groupId)openGroup(record.groupId,entity==='service'?'services':'projects');else setActive('home');
 };
 const previewFile=async file=>{
  setBusy(true);setError('');
  try {
   const loaded=file.unloaded?{...await invoke('files.read',{serviceId:file.serviceId,path:file.path}),serviceId:file.serviceId}:file;
   setModal({type:'preview',file:loaded});
  } catch(error) {
   if(error.code==='SSH_TRUST_REQUIRED')setModal({type:'preview-trust',file,trust:{fingerprint:error.fingerprint,host:error.host}});
   else setError(error.message);
  } finally {setBusy(false)}
 };
 const tabTitle=tab=>tab.kind==='home'?t("홈"):tab.kind==='groups'?t("그룹"):tab.kind==='accounts'?t("계정관리"):tab.kind==='hosts'?t("호스트관리"):tab.kind==='settings'?t("설정"):tab.kind==='editor'?t("{0} 등록",[nouns[tab.entityType]]):data[tab.kind==='group'?'groups':tab.kind==='service'?'services':'projects'].find(item=>item.id===tab.entityId)?.name||nouns[tab.kind];
 const tabIcon=tab=>tab.kind==='home'?'home':tab.kind==='groups'||tab.kind==='group'?'group':tab.kind==='accounts'?'users':tab.kind==='hosts'?'service':tab.kind==='settings'?'database':tab.kind==='editor'?'edit':tab.kind==='service'?'service':'project';
 const tabOrder=useWorkspaceTabOrder({tabsRef,setTabs,onActivate:setActive,tabTitle});
 const tabKey=(event,index)=>{
  if(tabOrder.reorderKey(event,tabs[index].id))return;
  let target;
  if(event.key==='ArrowRight')target=tabs[(index+1)%tabs.length];
  if(event.key==='ArrowLeft')target=tabs[(index+tabs.length-1)%tabs.length];
  if(event.key==='Home')target=tabs[0];
  if(event.key==='End')target=tabs.at(-1);
  if(target){event.preventDefault();setActive(target.id);requestAnimationFrame(()=>document.getElementById(`tab-${target.id}`)?.focus())}
 };
 const duplicateTab=()=>{const current=tabs.find(t=>t.id===active);if(!current||['home','editor'].includes(current.kind)){openGroups();return;}const next={...current,id:unique()};setTabs(list=>[...list,next]);setActive(next.id)};
 const controlWindow=async action=>{
  const changingFullScreen=action==='window.fullscreen';
  if(changingFullScreen)setWindowChanging(true);setError('');
  try{const state=await invoke(action);if(changingFullScreen&&state)setWindowState(state)}catch(e){setError(e.message)}finally{if(changingFullScreen)setWindowChanging(false)}
 };
 const fullscreenLabel=windowState.fullScreen?t("창 전체 화면 종료"):t("창 전체 화면");
 const selectedTab=tabs.find(t=>t.id===active)||HOME;
 const updateAvailable=Boolean(updateState?.availableVersion);
 const settingsTitle=updateAvailable?t('설정 · 새 버전 {0}',[updateState.availableVersion]):t('설정');
 const deleteLinks=modal?.type==='delete'&&modal.entity==='service'?data.projects.filter(project=>project.serviceIds?.includes(modal.record.id)):[];
 return <div className={`app workspace-app ${expanded?'sidebar-expanded':''}`}>
  <aside className="sidebar"><div className="sidebar-brand" title={t("드래그하여 창 이동")}><img src={expanded?'./assets/brand/reviewops-logo.svg':'./assets/brand/reviewops-icon.svg'} alt="ReviewOps" draggable={false}/></div>
   <nav className="main-nav" aria-label={t("주요 메뉴")}>{[['home','home',t("홈")],['groups','group',t("그룹")],['accounts','users',t("계정관리")],['hosts','service',t("호스트관리")]].map(([key,icon,name])=><button key={key} className={`nav-item ${(key==='home'?selectedTab.kind==='home':key==='groups'?['groups','group','project','editor'].includes(selectedTab.kind):selectedTab.kind===key)?'active':''}`} onClick={()=>key==='home'?setActive('home'):key==='groups'?openGroups():openTab(key)} title={name} aria-label={name}><Icon name={icon}/>{expanded&&<span>{name}</span>}</button>)}</nav>
   <div className="sidebar-bottom"><button className="nav-item" onClick={()=>setExpanded(!expanded)} title={expanded?t("메뉴 접기"):t("메뉴 펼치기")} aria-label={expanded?t("메뉴 접기"):t("메뉴 펼치기")}><Icon name="columns"/>{expanded&&<span>{t("메뉴 접기")}</span>}</button><button className={`nav-item ${selectedTab.kind==='settings'?'active':''}`} onClick={()=>openTab('settings')} title={settingsTitle} aria-label={t("설정")}><Icon name="settings"/>{updateAvailable&&<span className="sidebar-update-dot" aria-label={t("새 버전을 사용할 수 있습니다.")}/>}{expanded&&<span>{t("설정")}</span>}</button><button className="nav-item" onClick={()=>setDark(!dark)} title={dark?t("밝은 화면"):t("어두운 화면")} aria-label={dark?t("밝은 화면"):t("어두운 화면")}><Icon name={dark?'sun':'moon'}/>{expanded&&<span>{dark?t("밝은 화면"):t("어두운 화면")}</span>}</button></div>
  </aside>
  <main className="workspace-main">
   <div className="workspace-tabs" role="tablist" aria-label={t("작업 탭")}><div ref={tabOrder.listRef} className={`workspace-tab-list reviewops-tab-strip ${tabOrder.draggedTabId?'is-reordering':''}`}>{tabs.map((tab,index)=><div key={tab.id} data-tab-id={tab.id} className={`workspace-tab reviewops-tab-item ${active===tab.id?'active is-active':''} ${tabOrder.draggedTabId===tab.id?'dragging':''}`} role="presentation" onPointerDown={event=>tabOrder.beginDrag(event,tab.id)} onDragStart={event=>event.preventDefault()}><button id={`tab-${tab.id}`} type="button" className="workspace-tab-select reviewops-tab-label" role="tab" aria-label={tabTitle(tab)} aria-selected={active===tab.id} aria-controls={`pane-${tab.id}`} aria-describedby={tab.id==='home'?undefined:'workspace-tab-move-help'} aria-keyshortcuts={tab.id==='home'?undefined:'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight'} tabIndex={active===tab.id?0:-1} onClick={()=>setActive(tab.id)} onKeyDown={event=>tabKey(event,index)}><Icon name={tabIcon(tab)} size={16}/><span className="tab-title">{tabTitle(tab)}</span></button>{tab.id!=='home'&&<button className="tab-close reviewops-tab-close" onClick={()=>requestClose(tab.id)} aria-label={t("{0} 닫기",[tabTitle(tab)])} title={t("탭 닫기")}><Icon name="close" size={12}/></button>}</div>)}<button className="workspace-add-tab" aria-label={t("새 작업 탭")} title={t("새 작업 탭")} onClick={duplicateTab}><Icon name="plus" size={17}/></button></div><button className="workspace-refresh" aria-label={t("새로고침")} title={t("새로고침")} onClick={()=>run(reload)} disabled={busy}><Icon name="refresh" size={18}/></button>
    <div className="window-controls" role="group" aria-label={t("창 제어")}><button type="button" className="window-control" onClick={()=>controlWindow('window.fullscreen')} title={fullscreenLabel} aria-label={fullscreenLabel} aria-pressed={windowState.fullScreen} disabled={windowChanging}><Icon name={windowState.fullScreen?'compress':'expand'} size={17}/></button><button type="button" className="window-control window-control-close" onClick={()=>controlWindow('window.close')} title={t("창 닫기")} aria-label={t("창 닫기")}><Icon name="close" size={17}/></button></div>
   </div>
   <span id="workspace-tab-move-help" className="workspace-tab-assistive">{t("드래그하거나 Alt와 Shift를 누른 채 좌우 방향키로 탭 순서를 바꿀 수 있습니다. 홈 탭은 고정되어 있습니다.")}</span><span className="workspace-tab-assistive" role="status" aria-live="polite">{tabOrder.announcement}</span>
   {error&&<div className="error-banner" role="alert"><Icon name="warning" size={17}/><span>{t(error)}</span><button className="icon-button" onClick={()=>setError('')} aria-label={t("오류 닫기")}><Icon name="close" size={15}/></button></div>}
   {!ready?<div className="loading"><span className="spinner"/>{t("자료 불러오는 중")}</div>:<div className="workspace-panes">{tabs.map(tab=><section id={`pane-${tab.id}`} key={tab.id} className="workspace-pane" role="tabpanel" aria-labelledby={`tab-${tab.id}`} hidden={active!==tab.id}>
    {tab.kind==='home'&&<WorkHome key={workspaceRevision} data={data} invoke={invoke} mutate={mutate} busy={busy} onOpenGroup={openGroup} onOpenProject={openProject} onEditReview={review=>edit('review',review)} onCreateReview={createReview} onPreview={previewFile} onError={setError} onRefresh={()=>run(reload)} onGroups={openGroups} initialReviewId={homeSelection.id} selectionRequest={homeSelection.request} onDirtyChange={dirty=>dirty?dirtyTabs.current.add('home'):dirtyTabs.current.delete('home')}/>}
    {['accounts','hosts'].includes(tab.kind)&&active===tab.id&&<CodexManagement page={tab.kind}/>}
    {tab.kind==='groups'&&<GroupsList data={data} onOpen={openGroup} onCreate={()=>edit('group')}/>}
    {tab.kind==='group'&&<GroupPane data={data} groupId={tab.entityId} initialSection={tab.section} sectionRequest={tab.sectionRequest} onGroups={openGroups} onOpenProject={openProject} onOpenService={openService} onEdit={edit} onDelete={remove} mutate={mutate} busy={busy} onDirtyChange={dirty=>dirty?dirtyTabs.current.add(tab.id):dirtyTabs.current.delete(tab.id)}/>}
    {['project','service'].includes(tab.kind)&&<ProjectWorkspace data={data} projectId={tab.kind==='project'?tab.entityId:undefined} serviceId={tab.kind==='service'?tab.entityId:undefined} resourceMode={tab.kind} invoke={invoke} mutate={mutate} busy={busy} onOpenGroup={openGroup} onOpenProject={openProject} onOpenService={openService} onDelete={remove} onError={setError} onCreateService={createService} onOpenHosts={openHosts} initialSection={tab.section} sectionRequest={tab.sectionRequest} initialReviewId={tab.reviewId} initialReviewMode={tab.reviewMode} selectionRequest={tab.selectionRequest} integrationRequest={tab.integrationRequest} active={active===tab.id} onIntegrationReady={value=>invoke('integration.displayed',value).catch(error=>setError(error.message))} onDirtyChange={dirty=>dirty?dirtyTabs.current.add(tab.id):dirtyTabs.current.delete(tab.id)}/>}
    {tab.kind==='settings'&&<><ResourceHeader title={t("설정")}/><DataSettings data={data} invoke={invoke} run={run} reload={reload} setToast={setToast} onBeforeRestore={beforeRestore} onRestored={restoreWorkspace}/></>}
    {tab.kind==='editor'&&<RegistrationScreen type={tab.entityType} record={tab.record} data={data} busy={busy} onClose={()=>closeTab(tab.id)} onSave={record=>save(tab.entityType,record,tab.id)} onCreateService={createService} onOpenHosts={openHosts} onDirtyChange={dirty=>dirty?dirtyTabs.current.add(tab.id):dirtyTabs.current.delete(tab.id)}/>}
   </section>)}</div>}
  </main>
  {toast&&<div className="toast" role="status"><Icon name="check" size={16}/>{toast}</div>}
  {modal?.type==='group'&&<EntityDialog type="group" record={modal.record} data={data} busy={busy} onClose={()=>setModal(null)} onSave={record=>save('group',record)} run={run} externalError={error}/>}
  {modal?.type==='delete'&&<Dialog title={t("{0} 삭제",[nouns[modal.entity]])} onClose={()=>setModal(null)} footer={<><Button onClick={()=>setModal(null)}>{t("취소")}</Button><Button variant="danger" onClick={deleteRecord} disabled={busy||deleteLinks.length>0||!deleteConfirm||deleteConfirm!==(modal.record.name||modal.record.title)}>{t("삭제")}</Button></>}><p className="delete-message"><strong>{modal.record.name||modal.record.title}</strong>{" "+t("항목을 삭제합니다.")}</p><p className="muted">{modal.entity==='group'?t("그룹의 프로젝트, 리뷰, 작업이력과 첨부 파일을 모두 삭제합니다."):modal.entity==='project'?t("프로젝트의 연결 설정, 리뷰, 작업이력과 첨부 파일을 모두 삭제합니다."):modal.entity==='service'?t("프로젝트 연결을 모두 해제한 서비스만 삭제할 수 있습니다. 기존 리뷰와 작업이력은 유지됩니다."):t("리뷰의 작업이력과 첨부 파일을 모두 삭제합니다.")}</p>{modal.entity!=='service'&&<p className="muted">{t("진행 중인 에이전트 작업도 중지합니다.")}</p>}{deleteLinks.length>0&&<div className="form-error" role="alert"><p>{t("다음 프로젝트에서 서비스 연결을 해제하십시오.")}</p><ul>{deleteLinks.map(project=><li key={project.id}>{project.name}</li>)}</ul></div>}<Field label={t("삭제 확인")} hint={t("삭제하려면 {0}을 그대로 입력하십시오: {1}",[modal.entity==='review'?t("리뷰 제목"):t("이름"),modal.record.name||modal.record.title])}><input aria-label={t("삭제 확인")} autoComplete="off" spellCheck={false} value={deleteConfirm} disabled={busy} onChange={event=>setDeleteConfirm(event.target.value)} placeholder={modal.record.name||modal.record.title}/></Field>{error&&<div className="form-error" role="alert">{error}</div>}</Dialog>}
  {modal?.type==='preview-trust'&&<TrustDialog trust={modal.trust} onClose={()=>setModal(null)} onTrust={()=>run(async()=>{await invoke('ssh.trust',{serviceId:modal.file.serviceId,fingerprint:modal.trust.fingerprint});await reload();await previewFile(modal.file)})}/>}
  {modal?.type==='preview'&&<Dialog title={modal.file.name||modal.file.path||t("파일")} onClose={()=>setModal(null)} wide><FileContent file={modal.file}/></Dialog>}
  {closePending&&<Dialog title={t("작성 중인 내용")} onClose={()=>setClosePending(null)} footer={<><Button onClick={()=>setClosePending(null)}>{t("계속 작성")}</Button><Button variant="danger" onClick={()=>{closeTab(closePending);setClosePending(null)}}>{t("변경 내용 버리기")}</Button></>}><p>{t("저장하지 않은 변경 내용이 있습니다. 내용을 버리고 탭을 닫을 수 있습니다.")}</p></Dialog>}
 </div>;
}

function ResourceHeader({title,children,onBack,backLabel,actions,inlineBack=false}) {
 if(inlineBack)return <header className="resource-header group-resource-header"><div className="group-resource-header-row"><div className="resource-heading">{onBack&&<button type="button" className="group-resource-back" onClick={onBack} aria-label={t("그룹 목록")} title={t("그룹 목록")}><GroupListIcon name="back" size={15}/></button>}<h1>{title}</h1></div>{children}{actions&&<div className="resource-actions">{actions}</div>}</div></header>;
 return <header className="resource-header"><div className="resource-heading"><h1>{title}</h1>{onBack&&<button className="group-breadcrumb" onClick={onBack}><Icon name="back" size={12}/>{backLabel||t("그룹")}</button>}</div>{children}{actions&&<div className="resource-actions">{actions}</div>}</header>;
}
function ResourceTabs({items,value,onChange,label}) {return <nav className="resource-tabs reviewops-tab-strip reviewops-tab-strip--text" aria-label={label} onKeyDown={tabKeyboard}>{items.map(([key,name,count])=><button type="button" key={key} aria-label={name} aria-pressed={value===key} tabIndex={value===key?0:-1} className={`reviewops-tab ${value===key?'active is-active':''}`} onClick={()=>onChange(key)}>{count===undefined?name:`${name}(${count})`}</button>)}</nav>}
function GroupPane({data,groupId,initialSection='projects',sectionRequest,onGroups,onOpenProject,onOpenService,onEdit,onDelete,mutate,busy,onDirtyChange}) {
 const normalize=section=>['info','projects','settings'].includes(section)?section:'projects';
 const [section,setSection]=useState(()=>normalize(initialSection));
 useEffect(()=>{setSection(normalize(initialSection))},[initialSection,sectionRequest]);
 const group=data.groups.find(item=>item.id===groupId),projects=data.projects.filter(item=>item.groupId===groupId);
 if(!group)return <Empty icon="group" title={t("그룹을 찾을 수 없습니다.")}><Button onClick={onGroups}>{t("그룹 목록")}</Button></Empty>;
 return <><ResourceHeader title={group.name} onBack={onGroups} backLabel={t("그룹")} inlineBack><ResourceTabs label={t("그룹 기능")} value={section} onChange={setSection} items={[["info",t("그룹정보")],["projects",t("프로젝트"),projects.length],["settings",t("설정")]]}/></ResourceHeader><div className="resource-content group-resource-content"><div className="group-resource-workspace">
  {section==='projects'?<GroupResourceList key={`${groupId}-${sectionRequest||''}`} type="project" groupId={groupId} projects={projects} services={data.services} reviews={data.reviews} onOpenProject={onOpenProject} onEdit={onEdit}/>:<div className="resource-detail" hidden={section!=='info'}>{section==='info'?<dl><dt>{t("그룹 이름")}</dt><dd>{group.name}</dd><dt>{t("설명")}</dt><dd>{group.description||t("설명 없음")}</dd><dt>{t("프로젝트")}</dt><dd>{projects.length}{t("개")}</dd><dt>{t("등록일")}</dt><dd>{date(group.createdAt)}</dd></dl>:null}</div>}<div className="resource-detail" hidden={section!=='settings'}><GroupSettings group={group} data={data} mutate={mutate} busy={busy} onDelete={()=>onDelete('group',group)} onDirtyChange={onDirtyChange}/></div>
 </div></div></>;
}
