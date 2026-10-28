import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button,Dialog,Field,invoke} from './components.jsx';
import {t} from './i18n/index.js';

export default function LocalFolderField({label,value='',onChange,placeholder='',hint,disabled=false,required=false}) {
 const [result,setResult]=useState(null),[checking,setChecking]=useState(false),[error,setError]=useState(''),[creation,setCreation]=useState(null),[working,setWorking]=useState(false);
 const revision=useRef(0),effectivePath=value.trim()||placeholder;
 useEffect(()=>{const token=++revision.current;setResult(null);setError('');if(!effectivePath){setChecking(false);return}setChecking(true);const timer=setTimeout(()=>{invoke('directory.inspect',{path:effectivePath}).then(value=>{if(token===revision.current)setResult(value)}).catch(cause=>{if(token===revision.current)setError(cause.message)}).finally(()=>{if(token===revision.current)setChecking(false)})},300);return()=>{clearTimeout(timer);revision.current++}},[effectivePath]);
 const choose=async()=>{try{const selected=await invoke('dialog.directory');if(selected)onChange(selected)}catch(cause){setError(cause.message)}};
 const chooseParent=async()=>{try{const selected=await invoke('dialog.directory');if(selected)setCreation(current=>({...current,parent:selected,error:''}))}catch(cause){setCreation(current=>({...current,error:cause.message}))}};
 const create=async()=>{setWorking(true);try{const selected=await invoke('directory.create',{parent:creation.parent,name:creation.name});onChange(selected);setCreation(null)}catch(cause){setCreation(current=>({...current,error:cause.message}))}finally{setWorking(false)}};
 return <>
  <Field label={label} hint={hint}><div className="input-action"><input aria-label={label} value={value} onChange={event=>onChange(event.target.value)} placeholder={placeholder} required={required} disabled={disabled}/><Button type="button" icon="folder" disabled={disabled} onClick={choose}>{t('선택')}</Button><Button type="button" disabled={disabled} onClick={()=>setCreation({parent:'',name:'',error:''})}>{t('새 폴더')}</Button></div></Field>
  {checking?<p className="original-form-help" role="status">{t('폴더 검사 중')}</p>:result&&<p className={result.ok?'original-form-help':'form-error'} role="status">{t(result.message)}</p>}
  {error&&<p className="form-error" role="alert">{t(error)}</p>}
  {creation&&createPortal(<Dialog title={t('새 폴더 만들기')} onClose={()=>{if(!working)setCreation(null)}} footer={<><Button type="button" disabled={working} onClick={()=>setCreation(null)}>{t('취소')}</Button><Button type="button" variant="primary" disabled={working||!creation.parent||!creation.name.trim()} onClick={create}>{working?t('생성 중'):t('폴더 만들기')}</Button></>}>
   <p>{t('상위 폴더를 선택하고 그 안에 만들 폴더 이름을 입력하십시오.')}</p>
   <Field label={t('상위 폴더')}><div className="input-action"><input aria-label={t('상위 폴더')} value={creation.parent} readOnly/><Button type="button" disabled={working} onClick={chooseParent}>{t('위치 선택')}</Button></div></Field>
   <Field label={t('새 폴더 이름')}><input aria-label={t('새 폴더 이름')} value={creation.name} disabled={working} onChange={event=>setCreation({...creation,name:event.target.value,error:''})}/></Field>
   {creation.error&&<p className="form-error" role="alert">{t(creation.error)}</p>}
  </Dialog>,document.body)}
 </>;
}
