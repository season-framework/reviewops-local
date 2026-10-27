import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {markdownLinkType} from './markdown-inline.mjs';
import './review-markdown.css';

// Render documents and review messages with the same Markdown support. File
// links still use the application's project-scoped file reader.
export default function ReviewMarkdown({text='',invoke,onError,onFileLink}) {
 const components={
  a:({href,children})=>{
   const kind=markdownLinkType(href||'');
   if(kind==='external')return <a href={href} onClick={event=>{event.preventDefault();invoke('external.open',{url:href}).catch(error=>onError?.(error.message))}}>{children}</a>;
   if(kind==='file'&&onFileLink)return <a href="#" onClick={event=>{event.preventDefault();Promise.resolve(onFileLink(href)).catch(error=>onError?.(error.message))}}>{children}</a>;
   return <>{children}</>;
  },
  img:({alt})=><span>{alt}</span>,
  table:({children})=><div className="review-markdown-table"><table>{children}</table></div>,
  ...Object.fromEntries([1,2,3,4,5,6].map(level=>[`h${level}`,({children})=>React.createElement(`h${Math.min(level+1,6)}`,null,children)])),
 };
 return <div className="original-review-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml urlTransform={(url,key)=>key==='href'&&markdownLinkType(url)?url:''}>{String(text)}</ReactMarkdown></div>;
}
