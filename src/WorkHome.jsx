import {t,localized,getLocale} from './i18n/index.js';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import Icon from './icons.jsx';
import OriginalReviewPanel from './OriginalReviewPanel.jsx';
import HomeCapture from './HomeCapture.jsx';
import {projectConnection} from './OriginalForms.jsx';
import './work-home.css';
import {matchesReviewSearch} from './review-categories.js';

const STATES = localized([['open','열림'],['in_progress','진행'],['in_review','검토'],['resolved','해결'],['recheck','재검토'],['closed','닫힘']]);
const stateName = value => STATES.find(([key]) => key === value)?.[1] || t("열림");
const isClosed = review => ['closed','resolved'].includes(review.status);
const storage = {
  get(key, fallback = '') { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } },
  set(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} }
};

function ProjectIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1" y="2" width="4" height="4" rx="1"/><rect x="10" y="1" width="5" height="4" rx="1"/><rect x="10" y="10" width="5" height="4" rx="1"/><path d="M4 3h5v1h2v2H8V5H4zm0 1h2v7h5v2H4z"/></svg>;
}

export default function WorkHome({data, invoke, mutate, busy, onOpenGroup, onOpenProject, onEditReview, onCreateReview, onPreview, onError, onRefresh, onGroups, onDirtyChange, initialReviewId = '', selectionRequest = 0, storageScope='reviewops.home', windowProjectId=''}) {
  const selectedKey=`${storageScope}.selected`,favoritesKey=`${storageScope}.favorites`;
  const [selectedId, setSelectedId] = useState(() => initialReviewId || storage.get(selectedKey));
  const [scope, setScope] = useState('active');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [focusedKey, setFocusedKey] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [favorites, setFavorites] = useState(() => {try {const values = JSON.parse(storage.get(favoritesKey,'[]'));return Array.isArray(values) ? values : [];} catch {return [];}});
  const [captureRequest,setCaptureRequest]=useState(null);
  const captureResolver=useRef(null),capturedEvidence=useRef(null);
  useEffect(()=>()=>{captureResolver.current?.resolve(null);captureResolver.current=null},[]);
  const requestCapture=options=>new Promise(resolve=>{captureResolver.current?.resolve(null);const id=crypto.randomUUID();captureResolver.current={id,resolve};setCaptureRequest({id,review:selected,options:options||{}})});
  const finishCapture=(id,result,evidence)=>{if(captureResolver.current?.id!==id)return;if(evidence)capturedEvidence.current={reviewId:captureRequest.review.id,evidence};captureResolver.current.resolve(result);captureResolver.current=null;setCaptureRequest(null)};
  const collectEvidence=async()=>{const service=projectConnection(data.projects.find(item=>item.id===selected?.projectId),data);const evidence=await invoke('browser.collectFor',{contextId:service?.id||'',url:selected?.targetUrl||service?.viewerUrl||''});return evidence.available?evidence:capturedEvidence.current?.reviewId===selected?.id?capturedEvidence.current.evidence:evidence};
  useEffect(()=>{if(captureResolver.current){captureResolver.current.resolve(null);captureResolver.current=null;setCaptureRequest(null)}},[selectedId]);
  const treeRef = useRef(null);
  const initialSelection = useRef(false);
  const selected = data.reviews.find(item => item.id === selectedId&&(!windowProjectId||item.projectId===windowProjectId));
  const selectedProject = data.projects.find(item => item.id === selected?.projectId);
  const selectedGroup = data.groups.find(item => item.id === selectedProject?.groupId);
  const visible = useMemo(() => data.reviews.filter(item => (scope === 'closed' ? isClosed(item) : !isClosed(item)) && matchesReviewSearch(item,search,data)).sort((a,b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)), [data.reviews, data.settings?.reviewCategories, scope, search, getLocale()]);
  const selectReview = review => {
    if(windowProjectId&&review.projectId!==windowProjectId){onOpenProject(review.projectId,{reviewId:review.id,reviewMode:'detail',selectionRequest:Date.now(),section:'review'});return;}
    setSelectedId(review.id); storage.set(selectedKey,review.id);
    const project = data.projects.find(item => item.id === review.projectId);
    setCollapsed(value => ({...value, [`g-${project?.groupId}`]:false, [`p-${review.projectId}`]:false}));
  };
  useEffect(() => {
    if (!data.reviews.length || initialSelection.current) return;
    initialSelection.current = true;
    const review = data.reviews.find(item => item.id === (initialReviewId || selectedId)&&(!windowProjectId||item.projectId===windowProjectId));
    if (review) {setScope(isClosed(review) ? 'closed' : 'active');selectReview(review);}
    else {setSelectedId('');storage.set(selectedKey,'');}
  }, [data.reviews]);
  useEffect(() => {
    if (!initialReviewId) return;
    const review = data.reviews.find(item => item.id === initialReviewId);
    if (review) {setScope(isClosed(review) ? 'closed' : 'active');setSearch('');selectReview(review);}
  }, [initialReviewId, selectionRequest]);
  useEffect(() => {if (selectedId && !data.reviews.some(item => item.id === selectedId&&(!windowProjectId||item.projectId===windowProjectId))) {setSelectedId('');storage.set(selectedKey,'');}}, [data.reviews, selectedId]);
  useEffect(() => {setFavorites(current=>{const next=current.filter(id=>data.projects.some(project=>project.id===id));if(next.length===current.length)return current;storage.set(favoritesKey,JSON.stringify(next));return next})}, [data.projects]);
  const clearSelection = () => {setSelectedId('');storage.set(selectedKey,'');};
  const setIssueScope = (value, focus = false) => {
    setScope(value); if (selected && isClosed(selected) !== (value === 'closed')) clearSelection();
    if (focus) requestAnimationFrame(() => document.getElementById(`work-home-scope-${value}`)?.focus());
  };
  const toggleFavorite = id => {setFavorites(values => {const next = values.includes(id) ? values.filter(value => value !== id) : [...values,id];storage.set(favoritesKey,JSON.stringify(next));return next;});};
  const toggle = key => setCollapsed(values => ({...values,[key]:!values[key]}));
  const treeKey = event => {
    const node = event.target.closest('[data-tree-node]');
    if (!node || event.altKey || event.ctrlKey || event.metaKey) return;
    const nodes = [...treeRef.current.querySelectorAll('[data-tree-node]')];
    const index = nodes.indexOf(node), key = node.dataset.treeNode;
    let next;
    if (event.key === 'ArrowDown') next = nodes[Math.min(index + 1,nodes.length - 1)];
    if (event.key === 'ArrowUp') next = nodes[Math.max(index - 1,0)];
    if (event.key === 'Home') next = nodes[0];
    if (event.key === 'End') next = nodes.at(-1);
    if (event.key === 'ArrowRight') {if (node.getAttribute('aria-expanded') === 'false') toggle(key);else if (nodes[index + 1]?.dataset.parent === key) next = nodes[index + 1];}
    if (event.key === 'ArrowLeft') {if (node.getAttribute('aria-expanded') === 'true') toggle(key);else next = nodes.find(item => item.dataset.treeNode === node.dataset.parent);}
    if (['ArrowDown','ArrowUp','Home','End','ArrowRight','ArrowLeft'].includes(event.key)) {event.preventDefault();next?.focus();}
  };
  const nodeProps = (key, parent, level) => ({'data-tree-node':key,'data-parent':parent,role:'treeitem','aria-level':level,tabIndex:focusedKey ? (focusedKey === key ? 0 : -1) : key === `g-${data.groups[0]?.id}` ? 0 : -1,onFocus:() => setFocusedKey(key)});
  const refresh = async () => {setRefreshing(true);try {await onRefresh?.();} catch (error) {onError?.(error.message);} finally {setRefreshing(false);}};
  const filteredGroups = search.trim() ? data.groups.filter(group => data.projects.some(project => project.groupId === group.id && visible.some(review => review.projectId === project.id))) : data.groups;
  useEffect(() => {
    const nodes = [...treeRef.current.querySelectorAll('[data-tree-node]')];
    if (!nodes.some(node => node.dataset.treeNode === focusedKey)) setFocusedKey(nodes[0]?.dataset.treeNode || '');
  }, [visible, collapsed, data.groups, data.projects, focusedKey]);
  return <div className="work-home">
    <header className="work-home-header"><div className="work-home-heading"><h1>{t("홈")}</h1><p title={selected ? `${selectedGroup?.name || ''} / ${selectedProject?.name || ''}` : undefined}>{selected ? `${selectedGroup?.name || ''} / ${selectedProject?.name || ''}` : '\u00a0'}</p></div><div className="work-home-filters"><div className="work-home-scope" role="group" aria-label={t("리뷰 상태")}>{[['active',t("진행 리뷰")],['closed',t("닫힌 리뷰")]].map(([key,name]) => <button key={key} id={`work-home-scope-${key}`} type="button" aria-pressed={scope === key} tabIndex={scope === key ? 0 : -1} className={scope === key ? 'active is-active' : ''} onClick={() => setIssueScope(key)} onKeyDown={event => {if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {event.preventDefault();setIssueScope(event.key === 'Home' ? 'active' : event.key === 'End' ? 'closed' : scope === 'active' ? 'closed' : 'active',true);}}}>{name}</button>)}</div><label className="work-home-search"><Icon name="search" size={14}/><input type="search" aria-label={t("리뷰 제목·분류 검색")} placeholder={t("리뷰 제목·분류 검색")} value={search} onChange={event => setSearch(event.target.value)}/></label></div></header>
    <div className="work-home-panes"><aside className="work-home-explorer" aria-label={t("그룹 프로젝트 리뷰 탐색")}><header><h2>{t("탐색")}</h2><span>{visible.length}{t("개 리뷰")}</span><button type="button" className="work-home-icon" onClick={refresh} disabled={refreshing || busy} title={t("새로고침")} aria-label={t("작업 트리 새로고침")}><Icon name="refresh" size={13}/></button></header><div className="work-home-tree-scroll"><h3>{t("내 그룹")}</h3><div role="tree" aria-label={t("그룹 프로젝트 리뷰")} ref={treeRef} onKeyDown={treeKey}>{filteredGroups.map(group => {
      const projects = data.projects.filter(project => project.groupId === group.id && (!search.trim() || visible.some(review => review.projectId === project.id)));
      const groupCount = visible.filter(review => projects.some(project => project.id === review.projectId)).length;
      const groupKey = `g-${group.id}`;
      return <div key={group.id} role="none"><div className="work-home-tree-row" role="none"><button type="button" className="work-home-tree-item work-home-tree-group" {...nodeProps(groupKey,'',1)} aria-expanded={!collapsed[groupKey]} onClick={() => toggle(groupKey)}><Icon name={collapsed[groupKey] ? 'chevron' : 'down'} size={10}/><Icon name="folder" size={13}/><span className="work-home-node-title">{group.name}</span><span className="work-home-node-count" aria-label={t("{0}개 리뷰",[groupCount])}>{groupCount}</span></button><button type="button" className="work-home-node-link" title={t("{0} 그룹 열기",[group.name])} aria-label={t("{0} 그룹 열기",[group.name])} onClick={() => onOpenGroup(group.id)}><Icon name="arrow" size={14}/></button></div>{!collapsed[groupKey] && <div role="group">{projects.map(project => {
        const reviews = visible.filter(review => review.projectId === project.id), projectKey = `p-${project.id}`;
        return <div key={project.id} role="none"><div className="work-home-tree-row" role="none"><button type="button" className="work-home-tree-item work-home-tree-project" {...nodeProps(projectKey,groupKey,2)} aria-expanded={!collapsed[projectKey]} onClick={() => toggle(projectKey)}><Icon name={collapsed[projectKey] ? 'chevron' : 'down'} size={10}/><ProjectIcon/><span className="work-home-node-title">{project.name}</span><span className="work-home-node-count" aria-label={t("{0}개 리뷰",[reviews.length])}>{reviews.length}</span></button><button type="button" className={`work-home-favorite ${favorites.includes(project.id) ? 'active' : ''}`} aria-pressed={favorites.includes(project.id)} title={t("{0} 즐겨찾기",[project.name])} aria-label={t("{0} 즐겨찾기",[project.name])} onClick={() => toggleFavorite(project.id)}><svg width="14" height="14" viewBox="0 0 24 24" fill={favorites.includes(project.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg></button><button type="button" className="work-home-node-link" title={t("{0} 프로젝트 열기",[project.name])} aria-label={t("{0} 프로젝트 열기",[project.name])} onClick={() => onOpenProject(project.id)}><Icon name="arrow" size={14}/></button></div>{!collapsed[projectKey] && <div role="group">{reviews.map(review => <button key={review.id} type="button" className={`work-home-tree-item work-home-tree-review ${selectedId === review.id ? 'is-selected' : ''}`} {...nodeProps(`r-${review.id}`,projectKey,3)} aria-selected={selectedId === review.id} onClick={() => selectReview(review)} title={review.title}><span className="work-home-review-dot" data-status={review.status}/><span className="work-home-node-title">{review.title}</span><span className="work-home-review-status">{stateName(review.status)}</span></button>)}{!reviews.length && <div className="work-home-tree-message"><p>{search.trim() ? t("검색 결과가 없습니다.") : scope === 'closed' ? t("닫힌 리뷰가 없습니다.") : t("진행 리뷰가 없습니다.")}</p>{scope === 'active' && !search.trim() && <button type="button" onClick={() => onCreateReview(project.id)}><Icon name="plus" size={12}/>{t("리뷰 작성")}</button>}</div>}</div>}</div>;
      })}{!projects.length && <div className="work-home-tree-message"><p>{t("프로젝트가 없습니다.")}</p><button type="button" onClick={() => onOpenGroup(group.id)}>{t("그룹 열기")}<Icon name="arrow" size={12}/></button></div>}</div>}</div>;
    })}</div>{!filteredGroups.length && <div className="work-home-tree-message"><p>{search.trim() ? t("검색 결과가 없습니다.") : t("등록된 그룹이 없습니다.")}</p>{!data.groups.length && <button type="button" onClick={onGroups}>{t("그룹 만들기")}<Icon name="arrow" size={12}/></button>}</div>}</div></aside>
    <section className="work-home-detail" aria-label={t("선택한 리뷰 상세")}>{selected ? <OriginalReviewPanel key={selected.id} review={selected} projectId={selected.projectId} data={data} invoke={invoke} mutate={mutate} busy={busy} onPreview={onPreview} onError={onError} onClose={clearSelection} onSaved={review => selectReview(review)} onDirtyChange={onDirtyChange} onCaptureScreenshot={requestCapture} onCollectEvidence={collectEvidence}/> : <div className="work-home-empty"><Icon name="review" size={34}/><h2>{data.groups.length ? t("리뷰 선택") : t("그룹 만들기")}</h2><p>{data.groups.length ? t("왼쪽에서 그룹과 프로젝트를 펼치고 리뷰를 선택하십시오.") : t("그룹을 만든 뒤 프로젝트를 추가합니다.")}</p><button type="button" className="work-home-small-button" onClick={onGroups}>{data.groups.length ? t("내 그룹으로 이동") : t("그룹 만들기")}</button></div>}</section></div>
    {captureRequest&&<HomeCapture request={captureRequest} service={projectConnection(data.projects.find(item=>item.id===captureRequest.review.projectId),data)} invoke={invoke} key={captureRequest.id} onFinish={(result,evidence)=>finishCapture(captureRequest.id,result,evidence)}/>}
  </div>;
}
