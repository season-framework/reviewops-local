import {t,getLocale} from './i18n/index.js';
import React, {Fragment} from 'react';
import Icon from './icons.jsx';
import TimelineAttachments,{logCaptures} from './TimelineAttachments.jsx';
import './review-timeline.css';

const timestamp = value => new Date(value).getTime() || 0;
const day = value => new Date(value).toLocaleDateString(getLocale(), {year:'numeric',month:'long',day:'numeric',weekday:'short'});
const time = value => new Date(value).toLocaleTimeString(getLocale(), {hour:'2-digit',minute:'2-digit',hour12:false});
const fullDate = value => new Date(value).toLocaleString(getLocale());
const isAgent = item => ['agent','assistant'].includes(item.role || item.authorRole) || ['agent','agent_response'].includes(item.type);

function entries(review, activities, files) {
  const firstActivity = Math.min(...activities.filter(item => item.type !== 'created').map(item => timestamp(item.createdAt)));
  const initialFiles = files.filter(file => !file.activityId && timestamp(file.createdAt) <= Math.min(timestamp(review.createdAt) + 1000, firstActivity));
  const initialIds = new Set(initialFiles.map(file => file.id));
  const activityLogs = new Set(activities.flatMap(item=>logCaptures(item.evidence).map(capture=>capture.id)).filter(Boolean));
  const initialLogs = logCaptures(review.evidence).filter(capture=>!capture.id||!activityLogs.has(capture.id));
  const events = [
    {id:`start-${review.id}`,createdAt:review.createdAt,eventType:'start',body:review.body,files:initialFiles,captures:initialLogs},
    ...activities.filter(item => ['comment','status','agent','agent_response'].includes(item.type)).map(item => ({...item,eventType:item.type,files:files.filter(file => file.activityId === item.id)})),
    ...files.filter(file => !file.activityId && !initialIds.has(file.id)).map(file => ({id:`file-${file.id}`,createdAt:file.createdAt,eventType:'attachment',files:[file]}))
  ].sort((a,b) => timestamp(a.createdAt) - timestamp(b.createdAt));
  return events.reduce((result, item) => {
    const previous = result[result.length - 1];
    if (item.eventType === 'attachment' && previous?.eventType === 'attachment' && timestamp(item.createdAt) - timestamp(previous.createdAt) < 1000) previous.files.push(...item.files);
    else result.push(item);
    return result;
  }, []);
}

export default function ReviewTimeline({review,activities,files,invoke,mutate,renderMarkdown,renderLogs,renderEdit,onFileLink,onEditReview,onEditActivity,editingId,busy,Status,statusLabel}) {
  const timeline = entries(review,activities,files);
  return <div className="original-review-timeline review-chat-timeline" role="list" aria-label={t("작업이력 대화")}>
    {timeline.map((item,index) => {
      const agent = isAgent(item);
      const system = item.role === 'system' || item.authorRole === 'system';
      const start = item.eventType === 'start';
      const fileMessage = item.eventType === 'attachment';
      const captures = item.captures||logCaptures(item.evidence);
      const hasLogs = captures.length > 0;
      const author = agent ? t("에이전트") : system ? t("시스템") : t("사용자");
      const showDate = index === 0 || day(item.createdAt) !== day(timeline[index-1].createdAt);
      return <Fragment key={item.id}>
        {showDate && <div className="review-chat-date"><span>{day(item.createdAt)}</span></div>}
        {item.eventType === 'status' ? <div className="review-chat-event" role="listitem" aria-label={t("상태 변경")}><Icon name="refresh" size={12}/><span className="review-chat-event-label">{t("상태 변경")}</span><span>{statusLabel(item.fromStatus)}</span><Icon name="arrow" size={12}/><Status value={item.toStatus}/><time dateTime={item.createdAt} title={fullDate(item.createdAt)}>{time(item.createdAt)}</time></div> :
          <article className={`review-chat-message ${start?'is-request':agent?'is-agent':system?'is-system':'is-user'}`} role="listitem" data-activity-id={item.id} aria-label={start?t("리뷰 등록"):t("{0} 작업 내용",[author])}>
            <header className="review-chat-message-header">
              <span className="review-chat-avatar" aria-hidden="true">{agent?<Icon name="terminal" size={15}/>:system?<Icon name="info" size={15}/>:<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10" cy="6" r="3"/><path d="M4 17v-2a6 6 0 0 1 12 0v2"/></svg>}</span>
              <strong>{author}</strong>
              {start && <span className="review-chat-kind">{t("리뷰 등록")}</span>}
              {fileMessage && <span className="review-chat-kind">{t("파일 첨부")}</span>}
              {hasLogs && <span className="review-chat-kind">{t("로그")}</span>}
              <time dateTime={item.createdAt} title={fullDate(item.createdAt)}>{time(item.createdAt)}</time>
              {item.updatedAt && timestamp(item.updatedAt) - timestamp(item.createdAt) > 1000 && <span className="review-chat-edited" title={fullDate(item.updatedAt)}>{t("수정됨")}</span>}
              {start || (item.type === 'comment' && !agent && !system) ? <button type="button" className="review-chat-edit" aria-label={start?t("리뷰 편집"):t("작업이력 편집")} title={start?t("리뷰 편집"):t("작업이력 편집")} disabled={busy} onClick={() => start?onEditReview():onEditActivity(item)}><Icon name="edit" size={13}/><span>{t("편집")}</span></button> : null}
            </header>
            {(editingId===item.id||item.body?.trim()||start)&&<div className="review-chat-bubble">
              {editingId === item.id ? renderEdit(item) : <>
                {item.body?.trim() ? renderMarkdown(item.body,agent&&onFileLink?{onFileLink:path=>onFileLink(path,item.agentRunId)}:{}) : start ? <p className="review-chat-empty">{t("등록된 요청 내용이 없습니다.")}</p> : null}
              </>}
            </div>}
            {editingId!==item.id&&<TimelineAttachments files={item.files} captures={captures} invoke={invoke} mutate={mutate} busy={busy} renderLogs={renderLogs}/>}
          </article>}
      </Fragment>;
    })}
  </div>;
}
