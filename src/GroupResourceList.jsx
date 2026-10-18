import {t,localized} from './i18n/index.js';
import Select from './Select.jsx';
import React, {useEffect, useState} from 'react';
import Icon from './icons.jsx';
import './group-resource-list.css';

const OPERATING_STATES = localized([['active','활성'],['archived','보관'],['disabled','비활성']]);
const REVIEW_STATES = localized([['open','열림'],['in_progress','진행'],['in_review','검토'],['resolved','해결']]);
const PAGE_SIZE = 20;
// Font Awesome Free 6.7.2 by Fonticons, Inc. (https://fontawesome.com).
// Solid icons from the original ReviewOps UI; CC BY 4.0: https://fontawesome.com/license/free
const LIST_ICON_PATHS = {
 search:['0 0 512 512','M416 208c0 45.9-14.9 88.3-40 122.7L502.6 457.4c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0L330.7 376c-34.4 25.2-76.8 40-122.7 40C93.1 416 0 322.9 0 208S93.1 0 208 0S416 93.1 416 208zM208 352a144 144 0 1 0 0-288 144 144 0 1 0 0 288z'],
 tag:['0 0 448 512','M0 80L0 229.5c0 17 6.7 33.3 18.7 45.3l176 176c25 25 65.5 25 90.5 0L418.7 317.3c25-25 25-65.5 0-90.5l-176-176c-12-12-28.3-18.7-45.3-18.7L48 32C21.5 32 0 53.5 0 80zm112 32a32 32 0 1 1 0 64 32 32 0 1 1 0-64z'],
 sort:['0 0 320 512','M137.4 41.4c12.5-12.5 32.8-12.5 45.3 0l128 128c9.2 9.2 11.9 22.9 6.9 34.9s-16.6 19.8-29.6 19.8L32 224c-12.9 0-24.6-7.8-29.6-19.8s-2.2-25.7 6.9-34.9l128-128zm0 429.3l-128-128c-9.2-9.2-11.9-22.9-6.9-34.9s16.6-19.8 29.6-19.8l256 0c12.9 0 24.6 7.8 29.6 19.8s2.2 25.7-6.9 34.9l-128 128c-12.5 12.5-32.8 12.5-45.3 0z'],
 down:['0 0 512 512','M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z'],
 plus:['0 0 448 512','M256 80c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 144L48 224c-17.7 0-32 14.3-32 32s14.3 32 32 32l144 0 0 144c0 17.7 14.3 32 32 32s32-14.3 32-32l0-144 144 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-144 0 0-144z'],
 back:['0 0 320 512','M9.4 233.4c-12.5 12.5-12.5 32.8 0 45.3l192 192c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L77.3 256 246.6 86.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-192 192z']
};
export function GroupListIcon({name,size=12,className=''}) {const [viewBox,d]=LIST_ICON_PATHS[name];return <svg className={className} aria-hidden="true" width={size*Number(viewBox.split(' ')[2])/512} height={size} viewBox={viewBox} fill="currentColor"><path d={d}/></svg>}
function updatedLabel(item) {const value=new Date(item.updatedAt||item.createdAt);if(!Number.isFinite(value.getTime()))return '-';const pad=value=>String(value).padStart(2,'0');return `${value.getFullYear()}.${pad(value.getMonth()+1)}.${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;}

const includesText = (value, query) => String(value || '').toLocaleLowerCase().includes(query.toLocaleLowerCase());

function LabelFilter({labels,value,onChange}) {
 return <div className="group-list-label-filter"><Select searchable clearable aria-label={t("라벨 필터")} value={value} onChange={event=>onChange(event.target.value)} searchPlaceholder={t("라벨 검색")}><option value="">{t("전체 라벨")}</option>{labels.map(label=><option key={label} value={label}>{label}</option>)}</Select></div>;
}

function ReviewSummary({reviews}) {
 return <div className="group-list-review-summary" aria-label={t("리뷰 현황")}>{REVIEW_STATES.map(([status,label])=><div key={status}><span>{label}</span><strong data-count={reviews.filter(review=>review.status===status).length}>{reviews.filter(review=>review.status===status).length}</strong></div>)}</div>;
}

export default function GroupResourceList({groupId,projects=[],services=[],reviews=[],onOpenProject,onEdit}) {
 const [search,setSearch]=useState(''),[label,setLabel]=useState(''),[status,setStatus]=useState('active'),[sort,setSort]=useState('name_asc'),[page,setPage]=useState(1);
 useEffect(()=>{setSearch('');setLabel('');setStatus('active');setSort('name_asc');setPage(1)},[groupId]);
 useEffect(()=>setPage(1),[search,label,status,sort]);
 const target=item=>item.connection||services.find(connection=>item.serviceIds?.includes(connection.id));
 const targetLabel=item=>{const connection=target(item);return connection?`${connection.kind==='ssh'?`SSH · ${connection.hostAlias||connection.host||t("호스트 미선택")}`:t("로컬 폴더")}${connection.rootPath?` · ${connection.rootPath}`:''}`:t("작업 폴더 미설정")};
 const labels=[...new Set(projects.flatMap(item=>item.labels||[]))].sort((a,b)=>a.localeCompare(b,'ko'));
 const filtered=projects.filter(item=>{const connection=target(item);return (!status||(item.operationalStatus||'active')===status)&&(!label||(item.labels||[]).includes(label))&&includesText([item.name,item.description,connection?.hostAlias,connection?.host,connection?.rootPath,connection?.viewerUrl,...item.labels||[]].join(' '),search)});
 filtered.sort((a,b)=>{const [field,direction]=sort.split('_');return (direction==='asc'?1:-1)*(field==='updated'?new Date(a.updatedAt)-new Date(b.updatedAt):a.name.localeCompare(b.name,'ko',{numeric:true}))});
 const totalPages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)),currentPage=Math.min(page,totalPages),visible=filtered.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE);
 const open=item=>onOpenProject(item.id);
 const rowKey=(event,item)=>{if(event.target!==event.currentTarget)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();open(item)}};
 const toggleSort=field=>setSort(value=>value.startsWith(`${field}_`)?`${field}_${value.endsWith('_asc')?'desc':'asc'}`:`${field}_${field==='updated'?'desc':'asc'}`);
 const sortAria=field=>sort.startsWith(`${field}_`)?sort.endsWith('_asc')?'ascending':'descending':'none';
 const sortButton=(field,name)=><button type="button" className={`group-list-sort ${sort.startsWith(`${field}_`)?'is-active':''}`} aria-label={field==='name'?t("프로젝트 이름 정렬"):t("최근 업데이트 정렬")} onClick={()=>toggleSort(field)}>{name}<GroupListIcon name={sort.startsWith(`${field}_`)?'down':'sort'} className={sort===`${field}_asc`?'ascending':!sort.startsWith(`${field}_`)?'unsorted':''}/></button>;
 const empty=search||label?t("검색 결과가 없습니다."):t("{0} 프로젝트가 없습니다.",[OPERATING_STATES.find(([value])=>value===status)?.[1]||t("등록된")]);
 return <section className="group-resource-list group-project-catalog" aria-label={t("프로젝트 목록")}>
  <header className="group-list-query"><div className="group-list-filters" role="group" aria-label={t("프로젝트 조건")}><label className="group-list-input group-list-search"><GroupListIcon name="search"/><input type="search" aria-label={t("프로젝트 검색")} placeholder={t("프로젝트명, 설명, URL, 라벨 검색")} value={search} onChange={event=>setSearch(event.target.value)}/></label><LabelFilter labels={labels} value={label} onChange={setLabel}/><div className="group-list-status-options" role="group" aria-label={t("프로젝트 운영 상태")}>{OPERATING_STATES.map(([value,name])=><button type="button" key={value} aria-label={name} aria-pressed={status===value} onClick={()=>setStatus(value)}><span>{name}</span><span>{projects.filter(item=>(item.operationalStatus||'active')===value).length}</span></button>)}</div><button type="button" className="group-list-register" aria-label={t("프로젝트 등록")} onClick={()=>onEdit('project',{groupId})}><GroupListIcon name="plus"/><span>{t("프로젝트 등록")}</span></button></div></header>
  <div className="group-list-mobile-projects"><div className="group-list-mobile-sort"><span>{t("정렬")}</span><div>{sortButton('name',t("프로젝트명"))}{sortButton('updated',t("최근 업데이트"))}</div></div><div className="group-list-project-cards">{visible.map(item=><article className="group-list-project-card" key={item.id} tabIndex={0} aria-label={t("{0} 프로젝트",[item.name])} onKeyDown={event=>rowKey(event,item)}><div className="group-list-card-top"><div><h2 className="resource-name group-list-resource-name">{item.name}</h2>{item.description&&<p className="group-list-description">{item.description}</p>}<p className="group-list-linked-services">{targetLabel(item)}</p></div><div className="group-list-actions"><button type="button" className="group-list-open" aria-label={t("{0} 열기",[item.name])} onClick={()=>open(item)}>{t("열기")}</button></div></div><p className="group-list-card-updated"><Icon name="clock" size={12}/>{t("최근 업데이트")+" "}{updatedLabel(item)}</p>{item.labels?.length>0&&<div className="group-list-labels">{item.labels.map(value=><span key={value}>#{value}</span>)}</div>}<ReviewSummary reviews={reviews.filter(review=>review.projectId===item.id)}/></article>)}{!visible.length&&<p className="group-list-empty">{empty}</p>}</div></div>
  <div className="group-list-table-scroll" tabIndex={0} role="region" aria-label={t("프로젝트 목록 가로 스크롤")}><table className="group-list-table" aria-label={t("프로젝트 목록")}><thead><tr><th className="group-list-name-column" scope="col" aria-sort={sortAria('name')}>{sortButton('name',t("프로젝트명"))}</th><th scope="col" aria-sort={sortAria('updated')}>{sortButton('updated',t("최근 업데이트"))}</th><th scope="col">{t("리뷰 현황")}</th><th scope="col" className="group-list-actions-column">{t("작업")}</th></tr></thead><tbody>{visible.map(item=><tr key={item.id} tabIndex={0} aria-label={t("{0} 프로젝트",[item.name])} onKeyDown={event=>rowKey(event,item)}><td className="group-list-name-column"><h2 className="resource-name group-list-resource-name">{item.name}</h2>{item.description&&<p className="group-list-description" title={item.description}>{item.description}</p>}<p className="group-list-linked-services">{targetLabel(item)}</p>{item.labels?.length>0&&<div className="group-list-labels">{item.labels.map(value=><span key={value}>#{value}</span>)}</div>}</td><td className="group-list-updated-column"><time dateTime={item.updatedAt}>{updatedLabel(item)}</time></td><td><ReviewSummary reviews={reviews.filter(review=>review.projectId===item.id)}/></td><td className="group-list-actions-column"><div className="group-list-actions"><button type="button" className="group-list-open" aria-label={t("{0} 열기",[item.name])} onClick={()=>open(item)}>{t("열기")}</button></div></td></tr>)}{!visible.length&&<tr><td colSpan={4} className="group-list-empty">{empty}</td></tr>}</tbody></table></div>
  {totalPages>1&&<nav className="group-list-pagination" aria-label={t("프로젝트 페이지")}><span>{(currentPage-1)*PAGE_SIZE+1}–{Math.min(currentPage*PAGE_SIZE,filtered.length)} / {filtered.length}{t("개")}</span><button type="button" aria-label={t("이전 페이지")} disabled={currentPage===1} onClick={()=>setPage(currentPage-1)}>{t("이전")}</button>{Array.from({length:totalPages},(_,index)=>index+1).filter(value=>value===1||value===totalPages||Math.abs(value-currentPage)<3).map(value=><button type="button" key={value} aria-label={t("{0} 페이지",[value])} aria-current={value===currentPage?'page':undefined} onClick={()=>setPage(value)}>{value}</button>)}<button type="button" aria-label={t("다음 페이지")} disabled={currentPage===totalPages} onClick={()=>setPage(currentPage+1)}>{t("다음")}</button></nav>}
 </section>;
}
