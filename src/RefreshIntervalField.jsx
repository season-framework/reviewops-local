import React,{useId,useState} from 'react';
import Select from './Select.jsx';
import {t} from './i18n/index.js';

export const intervalValue=(value,min,max=1440)=>/^\d+$/.test(String(value))&&Number(value)>=min&&Number(value)<=max?Number(value):null;

export default function RefreshIntervalField({label,value,onChange,min,presets,disabled=false}){
 const id=useId(),[custom,setCustom]=useState(false),direct=custom||!presets.includes(Number(value));
 return <div className="refresh-interval-field"><label htmlFor={id}>{label}</label><div className="refresh-interval-inputs"><Select id={id} searchable={false} aria-label={label} value={direct?'custom':String(value)} disabled={disabled} onChange={event=>{const next=event.target.value;setCustom(next==='custom');if(next!=='custom')onChange(next)}}>{presets.map(minutes=><option key={minutes} value={String(minutes)}>{t('{0}분',[minutes])}</option>)}<option value="custom">{t('직접 입력')}</option></Select>{direct&&<div className="refresh-interval-number"><input type="number" inputMode="numeric" min={min} max="1440" step="1" aria-label={t('{0} 직접 입력',[label])} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}/><span>{t('분')}</span></div>}</div></div>;
}
