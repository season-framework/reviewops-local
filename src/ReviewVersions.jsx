import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n/index.js';
import './review-versions.css';

const emptyTarget={code:'',artifact:'',database:''};
const targetFields=[['code','코드 버전'],['artifact','산출물 버전'],['database','데이터베이스 버전']];
const targetLabel=value=>targetFields.filter(([key])=>value?.[key]).map(([key,label])=>`${t(label)}: ${value[key]}`).join(' · ');
const statusLabel={available:'사본 보관됨',missing:'자료 누락',changed:'사본 내용 변경',unreadable:'사본 읽기 실패'};

export default function ReviewVersions({review,files,invoke,mutate,busy}) {
 const [state,setState]=useState({currentTarget:null,entries:[]}),[target,setTarget]=useState(emptyTarget),[selected,setSelected]=useState([]),[source,setSource]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[attempt,setAttempt]=useState(0);
 const dirtyTarget=useRef(false),request=useRef(0);
 useEffect(()=>{
  const token=++request.current;let alive=true;setLoading(true);
  invoke('review.version.list',{reviewId:review.id}).then(result=>{if(alive&&token===request.current){setState(result);setError('');if(!dirtyTarget.current)setTarget(result.currentTarget||emptyTarget)}}).catch(cause=>{if(alive&&token===request.current)setError(cause.message)}).finally(()=>{if(alive&&token===request.current)setLoading(false)});
  return()=>{alive=false};
 },[review.id,review.updatedAt,JSON.stringify(files.map(file=>[file.id,file.sha256])),attempt]);
 useEffect(()=>{setSelected(current=>current.filter(id=>files.some(file=>file.id===id)))},[JSON.stringify(files.map(file=>file.id))]);
 const update=(key,value)=>{dirtyTarget.current=true;setTarget(current=>({...current,[key]:value}))};
 const save=async(record)=>{
  setSaving(true);setError('');
  try{
   const result=await mutate(record?'review.version.save':'review.version.target',{reviewId:review.id,target,...(record?{source,attachmentIds:selected}:{})},record?t('검토자료 버전 저장 완료'):t('대상 버전 변경 완료'));
   if(result){dirtyTarget.current=false;if(record){setSelected([]);setSource('')}setAttempt(value=>value+1)}
  }catch(cause){setError(cause.message)}finally{setSaving(false)}
 };
 const disabled=busy||saving||loading,hasTarget=Object.values(target).some(value=>value.trim());
 return <section className="review-versions" aria-label={t('검토자료 버전')}>
  <header><h3>{t('검토자료 버전')}</h3><button type="button" disabled={disabled} onClick={()=>setAttempt(value=>value+1)}>{t('사본 다시 검사')}</button></header>
  <p>{t('버전을 직접 입력하고 이 리뷰의 첨부 사본을 선택합니다. 원본 파일이 바뀌어도 보관된 사본은 바뀌지 않습니다.')}</p>
  <p className="review-versions-scope">{t('버전과 출처는 이 기기의 리뷰와 자료 백업에 저장되며 에이전트에게 자동 전달되지 않습니다. 첨부 전달은 에이전트 탭에서 선택합니다.')}</p>
  <div className="review-version-target">{targetFields.map(([key,label])=><label key={key}>{t(label)}<input aria-label={t(label)} value={target[key]||''} maxLength={300} disabled={disabled} onChange={event=>update(key,event.target.value)}/></label>)}</div>
  <p className="review-versions-scope">{t('데이터베이스는 버전 이름만 입력합니다. 내용이나 인증 정보는 가져오지 않습니다.')}</p>
  <button type="button" disabled={disabled||!hasTarget} onClick={()=>save(false)}>{t('대상 버전 변경')}</button>
  {state.currentTarget&&<p><strong>{t('검토할 대상')}</strong> {targetLabel(state.currentTarget)}</p>}
  <fieldset disabled={disabled}><legend>{t('보관할 첨부 사본')}</legend>{files.length?files.map(file=><label key={file.id}><input type="checkbox" checked={selected.includes(file.id)} onChange={event=>setSelected(current=>event.target.checked?[...current,file.id]:current.filter(id=>id!==file.id))}/><span>{file.name}<small>{new Date(file.createdAt).toLocaleString()}</small></span></label>):<p>{t('이 리뷰에 파일을 첨부한 뒤 선택하십시오.')}</p>}</fieldset>
  {selected.length>20&&<p role="alert" className="review-version-error">{t('첨부 사본은 한 번에 20개까지 선택할 수 있습니다.')}</p>}
  <label className="review-version-source">{t('자료 출처 (선택)')}<input aria-label={t('자료 출처 (선택)')} value={source} maxLength={1000} disabled={disabled} onChange={event=>setSource(event.target.value)}/></label>
  <button type="button" disabled={disabled||!hasTarget||!selected.length||selected.length>20} onClick={()=>save(true)}>{saving?t('저장 중'):t('선택 자료와 버전 저장')}</button>
  {loading&&<p role="status">{t('보관된 사본을 검사하는 중입니다.')}</p>}{error&&<p role="alert" className="review-version-error">{error}</p>}
  <ol className="review-version-records">{[...state.entries].reverse().map(entry=><li key={entry.id}><header><strong>{targetLabel(entry.target)}</strong><span className={entry.needsReview?'needs-review':''}>{entry.needsReview?t('재검토 필요'):t('검토 대상 일치')}</span></header><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>{entry.source&&<p>{t('자료 출처')}: {entry.source}</p>}<ul>{entry.attachments.map(file=><li key={file.id}><strong>{file.name}</strong><span className={file.status==='available'?'':'review-version-error'}>{t(statusLabel[file.status]||'사본 읽기 실패')}</span><small>{t('사본 저장 시각')}: {new Date(file.createdAt).toLocaleString()}</small><details><summary>{t('파일 해시')}</summary><code>{file.sha256}</code></details></li>)}</ul></li>)}</ol>
 </section>;
}
