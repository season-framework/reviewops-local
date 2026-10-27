import React,{useEffect,useState} from 'react';
import {t} from './i18n/index.js';
import {reviewNextAction} from './review-status.mjs';

const labels={completed:'완료',failed:'실패',cancelled:'사용자 중지',interrupted:'연결 끊김',running:'실행 중',queued:'대기 중'};
export default function ReviewExecutionStatus({review,invoke,active,onOpenAgent,statusLabel}) {
  const [state,setState]=useState({reviewId:review.id,runs:[],error:''});
  useEffect(()=>{if(!active)return;let live=true,timer;const poll=async()=>{try{const runs=await invoke('agent.list',{reviewId:review.id});if(live)setState({reviewId:review.id,runs,error:''});}catch(error){if(live)setState({reviewId:review.id,runs:[],error:error.message});}if(live)timer=setTimeout(poll,2000);};poll();return()=>{live=false;clearTimeout(timer)};},[review.id,active,invoke]);
  const run=state.reviewId===review.id?[...state.runs].sort((a,b)=>String(b.createdAt||b.startedAt).localeCompare(String(a.createdAt||a.startedAt)))[0]:null;
  return <section className="review-execution-summary" aria-label={t('실행 결과와 리뷰 상태')}><div><strong>{t('리뷰 상태')}: {statusLabel(review.status)}</strong><span>{t('마지막 실행')}: {run?t(labels[run.status]||run.status):state.error?t('불러오기 실패'):t('실행 이력 없음')}</span></div>{run&&<><p>{t('마지막 실행 시각')}: {new Date(run.finishedAt||run.startedAt||run.createdAt).toLocaleString()}</p>{run.error&&<p>{run.error}</p>}{run.response&&<p className="review-result-excerpt">{run.response.slice(0,240)}{run.response.length>240?'…':''}</p>}<button type="button" onClick={onOpenAgent}>{t('실행 결과 열기')}</button></>}<p>{t(reviewNextAction(review.status,run?.status))}</p><small>{t('상태는 작업이력의 상태 변경 메뉴에서 변경합니다. 실행 종료만으로 리뷰가 해결되거나 닫히지 않습니다.')}</small>{state.error&&<p role="status">{state.error}</p>}</section>;
}
