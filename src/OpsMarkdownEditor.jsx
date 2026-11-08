import React,{useEffect,useRef,useState} from 'react';
import {t} from './i18n/index.js';

// Keep the editor and its worker in the app package; editing never needs a CDN.
let runtime;
function loadEditor(){return runtime ||= import('./ops-markdown-runtime.mjs')}

export default function OpsMarkdownEditor({value,onChange,disabled=false,label=t('목표 프롬프트')}){
 const host=useRef(null),editor=useRef(null),current=useRef({value,onChange,disabled,label}),[error,setError]=useState('');current.current={value,onChange,disabled,label};
 useEffect(()=>{
  let live=true,model,subscription,themeObserver;
  loadEditor().then(({monaco})=>{
   if(!live)return;
   model=monaco.editor.createModel(current.current.value,'markdown');
   const instance=monaco.editor.create(host.current,{model,ariaLabel:current.current.label,language:'markdown',automaticLayout:true,wordWrap:'on',lineNumbers:'on',minimap:{enabled:false},scrollBeyondLastLine:false,fontSize:13,tabSize:2,readOnly:current.current.disabled,theme:document.documentElement.dataset.theme==='dark'?'vs-dark':'vs',accessibilitySupport:'on',tabFocusMode:true});
   editor.current=instance;
   subscription=instance.onDidChangeModelContent(()=>{const next=model.getValue();if(next!==current.current.value)current.current.onChange(next)});
   themeObserver=new MutationObserver(()=>monaco.editor.setTheme(document.documentElement.dataset.theme==='dark'?'vs-dark':'vs'));themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  }).catch(cause=>{if(live)setError(cause.message||String(cause))});
  return()=>{live=false;themeObserver?.disconnect();subscription?.dispose();editor.current?.dispose();editor.current=null;model?.dispose()};
 },[]);
 useEffect(()=>{const instance=editor.current;if(instance&&instance.getValue()!==value){const selection=instance.getSelection();instance.setValue(value);if(selection)instance.setSelection(selection)}},[value]);
 useEffect(()=>{editor.current?.updateOptions({readOnly:disabled,ariaLabel:label})},[disabled,label]);
 return <div className="ops-markdown-editor"><div ref={host} className="ops-monaco-host" aria-label={label}/>{error&&<p className="form-error" role="alert">{t('프롬프트 편집기를 불러오지 못했습니다.')}: {error}</p>}</div>;
}
