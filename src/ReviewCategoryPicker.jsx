import React,{useEffect,useId,useRef,useState} from 'react';
import Icon from './icons.jsx';
import Select from './Select.jsx';
import {t} from './i18n/index.js';
import {categoryNameKey,reviewCategoryLabel,reviewCategoryOptions} from './review-categories.js';
import './review-categories.css';

export default function ReviewCategoryPicker({data,value,onChange,onAdd,disabled=false,compact=false}) {
  const id=useId(),input=useRef(null),addButton=useRef(null),alive=useRef(false),saving=useRef(false);
  const [adding,setAdding]=useState(false),[name,setName]=useState(''),[error,setError]=useState(''),[pending,setPending]=useState(false),[added,setAdded]=useState([]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  useEffect(()=>{if(adding)input.current?.focus()},[adding]);
  const options=reviewCategoryOptions(data,value);
  for(const item of added)if(!options.some(([key])=>key===item.id))options.push([item.id,item.name]);
  const close=()=>{setAdding(false);setName('');setError('');requestAnimationFrame(()=>addButton.current?.focus())};
  const add=async()=>{
    if(disabled||saving.current)return;
    const trimmed=name.trim();
    if(!trimmed){setError(t('분류 이름을 입력하십시오.'));input.current?.focus();return}
    const existing=options.find(([key,label])=>[key,label].some(value=>categoryNameKey(value)===categoryNameKey(trimmed)));
    if(existing){onChange(existing[0]);close();return}
    saving.current=true;setPending(true);setError('');
    try{
      const category=await onAdd(trimmed);
      if(!category?.id)throw new Error(t('분류를 추가하지 못했습니다.'));
      if(alive.current){setAdded(current=>[...current.filter(item=>item.id!==category.id),category]);onChange(category.id);close()}
    }catch(cause){if(alive.current)setError(t(cause.message||'분류를 추가하지 못했습니다.'))}
    finally{saving.current=false;if(alive.current)setPending(false)}
  };
  const selected=options.find(([key])=>key===value)?.[1]||reviewCategoryLabel(value,data);
  return <div className={`review-category-picker original-review-option-section${compact?' is-compact':''}`}>
    <div><label htmlFor={compact?id:undefined}><strong>{t('분류')}</strong></label>{!compact&&<span>{selected}</span>}</div>
    <div className={compact?'review-category-select-row':'original-review-options review-category-options'} role="group" aria-label={t('분류')}>
      {compact?<Select id={id} aria-label={t('분류')} searchable value={value} disabled={disabled||pending} onChange={event=>onChange(event.target.value)}>{options.map(([key,label])=><option key={key} value={key}>{label}</option>)}</Select>:options.map(([key,label])=><button type="button" key={key} data-value={key} aria-pressed={value===key} className={value===key?'selected':''} disabled={disabled||pending} onClick={()=>onChange(key)}>{label}</button>)}
      <button ref={addButton} type="button" className="review-category-add" aria-label={t('분류 추가')} title={t('분류 추가')} aria-expanded={adding} disabled={disabled||pending} onClick={()=>{setAdding(current=>!current);setError('')}}><Icon name="plus" size={16}/></button>
    </div>
    {adding&&<div className="review-category-new" role="group" aria-label={t('분류 추가')}><input ref={input} aria-label={t('분류 이름')} placeholder={t('새 분류 이름')} maxLength={60} value={name} disabled={disabled||pending} onChange={event=>{setName(event.target.value);setError('')}} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='Enter'){event.preventDefault();event.stopPropagation();add()}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}}}/><button type="button" disabled={disabled||pending} onClick={add}>{t('추가')}</button><button type="button" disabled={disabled||pending} onClick={close}>{t('취소')}</button></div>}
    {error&&<p className="review-category-error" role="alert">{error}</p>}
  </div>;
}
