import {t,localized} from './i18n/index.js';
import Select from './Select.jsx';
import React, {useEffect, useMemo, useState} from 'react';
import Icon from './icons.jsx';
import {GroupListIcon} from './GroupResourceList.jsx';
import './groups-list.css';

const OPERATING_STATES = localized([['active','활성'],['archived','보관'],['disabled','비활성']]);
const REVIEW_STATES = localized([['open','열림'],['in_progress','진행'],['in_review','검토'],['resolved','해결']]);
const PAGE_SIZE = 20;
const lower = value => String(value || '').toLocaleLowerCase();

function GroupLabelFilter({labels,value,onChange}) {
 return <div className="groups-page-label-filter"><Select searchable clearable aria-label={t("그룹 라벨")} value={value} onChange={event=>onChange(event.target.value)} searchPlaceholder={t("라벨 검색")}><option value="">{t("전체 라벨")}</option>{labels.map(label=><option key={label} value={label}>{label}</option>)}</Select></div>;
}

function ReviewSummary({counts}) {
 return <div className="groups-page-review-summary" aria-label={t("리뷰 현황")}>{REVIEW_STATES.map(([status,label])=><div key={status}><span>{label}</span><strong data-count={counts[status]}>{counts[status]}</strong></div>)}</div>;
}

export default function GroupsList({data,onOpen,onCreate}) {
 const [search,setSearch]=useState(''),[label,setLabel]=useState(''),[status,setStatus]=useState('active'),[page,setPage]=useState(1);
 const groups=data.groups||[],projects=data.projects||[],reviews=data.reviews||[];
 const labels=useMemo(()=>[...new Set(groups.flatMap(group=>group.labels||[]))].sort((a,b)=>a.localeCompare(b,'ko')),[groups]);
 const summaries=useMemo(()=>{
  const result=new Map(groups.map(group=>[group.id,{projects:0,reviews:Object.fromEntries(REVIEW_STATES.map(([state])=>[state,0]))}]));
  const projectGroups=new Map();
  for(const project of projects){const summary=result.get(project.groupId);if(summary){summary.projects++;projectGroups.set(project.id,project.groupId)}}
  for(const review of reviews){const summary=result.get(projectGroups.get(review.projectId));if(summary&&Object.hasOwn(summary.reviews,review.status))summary.reviews[review.status]++}
  return result;
 },[groups,projects,reviews]);
 const filtered=groups.filter(group=>(group.operationalStatus||'active')===status&&(!label||(group.labels||[]).some(value=>lower(value)===lower(label)))&&lower([group.name,group.description,...group.labels||[]].join(' ')).includes(lower(search.trim())));
 const totalPages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)),currentPage=Math.min(page,totalPages),visible=filtered.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE);
 const pageStart=Math.floor((currentPage-1)/5)*5+1,pages=Array.from({length:Math.min(5,totalPages-pageStart+1)},(_,index)=>pageStart+index);
 useEffect(()=>setPage(1),[search,label,status]);
 const emptyMessage=search.trim()||label?t("검색 결과가 없습니다."):!groups.length?t("등록된 그룹이 없습니다."):t("{0} 그룹이 없습니다.",[OPERATING_STATES.find(([value])=>value===status)?.[1]]);
 const rowKey=(event,group)=>{if(event.target===event.currentTarget&&(event.key==='Enter'||event.key===' ')){event.preventDefault();onOpen(group.id)}};
 return <>
  <header className="groups-page-header"><div className="groups-page-header-row"><div className="groups-page-heading"><h1>{t("그룹")}</h1><span className="groups-page-count">{filtered.length}{t("개 그룹")}</span></div><div className="groups-page-scope" aria-label={t("그룹 범위")}><span>{t("내 그룹")}</span></div></div></header>
  <div className="groups-page-content"><section className="groups-page-region" aria-label={t("그룹 목록")}>
   <div className="groups-page-query" role="group" aria-label={t("그룹 조건")}>
    <label className="groups-page-input groups-page-search"><GroupListIcon name="search"/><input type="search" aria-label={t("그룹명, 설명, 라벨 검색")} placeholder={t("그룹명, 설명, 라벨 검색")} value={search} onChange={event=>setSearch(event.target.value)}/></label>
    <GroupLabelFilter labels={labels} value={label} onChange={setLabel}/>
    <div className="groups-page-status-options" role="group" aria-label={t("그룹 운영 상태")}>{OPERATING_STATES.map(([value,name])=><button type="button" key={value} aria-label={name} aria-pressed={status===value} onClick={()=>setStatus(value)}><span>{name}</span><span>{groups.filter(group=>(group.operationalStatus||'active')===value).length}</span></button>)}</div>
    <button type="button" className="groups-page-register" aria-label={t("그룹 등록")} onClick={onCreate}><GroupListIcon name="plus"/><span>{t("그룹 등록")}</span></button>
   </div>
   <div className="groups-page-table-wrap"><table className="groups-page-table" aria-label={t("그룹 목록")}><thead><tr><th scope="col" className="groups-page-title-column">{t("그룹")}</th><th scope="col">{t("프로젝트")}</th><th scope="col">{t("리뷰 현황")}</th><th scope="col" className="groups-page-action-column">{t("작업")}</th></tr></thead><tbody>
    {visible.map(group=>{const summary=summaries.get(group.id);return <tr key={group.id} tabIndex={0} aria-label={t("{0} 그룹",[group.name])} onKeyDown={event=>rowKey(event,group)} onClick={()=>onOpen(group.id)}>
     <td className="groups-page-title-column"><p className="groups-page-name">{group.name}</p><p className="groups-page-description">{group.description||t("설명 없음")}</p>{group.labels?.length>0&&<div className="groups-page-labels">{group.labels.map(value=><span key={value}>#{value}</span>)}</div>}</td>
     <td className="groups-page-project-column"><p>{summary.projects}</p><p>{t("프로젝트")}</p></td>
     <td><ReviewSummary counts={summary.reviews}/></td>
     <td className="groups-page-action-column"><button type="button" className="groups-page-open" aria-label={t("그룹 열기: {0}",[group.name])} onClick={event=>{event.stopPropagation();onOpen(group.id)}}>{t("열기")}</button></td>
    </tr>})}
    {!visible.length&&<tr><td colSpan={4} className="groups-page-empty">{emptyMessage}</td></tr>}
   </tbody></table></div>
   {totalPages>1&&<div className="groups-page-pagination"><span>{(currentPage-1)*PAGE_SIZE+1}–{Math.min(currentPage*PAGE_SIZE,filtered.length)} / {filtered.length}{t("개")}</span><nav aria-label={t("그룹 페이지")}><button type="button" aria-label={t("이전 페이지")} disabled={currentPage===1} onClick={()=>setPage(currentPage-1)}>{t("이전")}</button>{pages.map(value=><button type="button" key={value} aria-label={t("{0} 페이지",[value])} aria-current={value===currentPage?'page':undefined} onClick={()=>setPage(value)}>{value}</button>)}<button type="button" aria-label={t("다음 페이지")} disabled={currentPage===totalPages} onClick={()=>setPage(currentPage+1)}>{t("다음")}</button></nav></div>}
  </section></div>
 </>;
}
