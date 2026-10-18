import {t} from './i18n/index.js';
import React, {useEffect,useRef,useState} from 'react';
import {Button,Dialog} from './components.jsx';
import './screenshot-editor.css';

const clamp=(value,min,max)=>Math.min(max,Math.max(min,Number(value)||0));

export default function ScreenshotEditor({capture,onConfirm,onCancel}) {
 const image=useRef(null),drag=useRef(null);
 const [size,setSize]=useState({width:capture.width||1,height:capture.height||1}),[mode,setMode]=useState('all'),[selection,setSelection]=useState(null),[error,setError]=useState('');
 useEffect(()=>{setSelection(null);setMode('all');setError('')},[capture]);
 const selected=selection||{x:Math.round(size.width*.25),y:Math.round(size.height*.25),width:Math.max(1,Math.round(size.width*.5)),height:Math.max(1,Math.round(size.height*.5))};
 const position=event=>{const rect=image.current.getBoundingClientRect();return {x:clamp(Math.round((event.clientX-rect.left)/rect.width*size.width),0,size.width-1),y:clamp(Math.round((event.clientY-rect.top)/rect.height*size.height),0,size.height-1)}};
 const move=event=>{if(!drag.current)return;const point=position(event),start=drag.current;setSelection({x:Math.min(start.x,point.x),y:Math.min(start.y,point.y),width:Math.max(1,Math.abs(point.x-start.x)),height:Math.max(1,Math.abs(point.y-start.y))})};
 const update=(key,value)=>setSelection(current=>{const next={...(current||selected),[key]:Number(value)||0};next.x=clamp(next.x,0,size.width-1);next.y=clamp(next.y,0,size.height-1);next.width=clamp(next.width,1,size.width-next.x);next.height=clamp(next.height,1,size.height-next.y);return next});
 const confirm=()=>{
  try{
   if(!image.current?.complete||!image.current.naturalWidth)throw new Error(t("스크린샷을 불러오고 있습니다."));
   if(mode==='all'){onConfirm({...capture,...size});return}
   const canvas=document.createElement('canvas');canvas.width=Math.min(selected.width,size.width-selected.x);canvas.height=Math.min(selected.height,size.height-selected.y);
   canvas.getContext('2d').drawImage(image.current,selected.x,selected.y,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
   onConfirm({...capture,dataUrl:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height});
  }catch(cause){setError(cause.message||t("스크린샷을 만들지 못했습니다."))}
 };
 return <Dialog title={t("스크린샷")} wide onClose={onCancel} footer={<><Button onClick={onCancel}>{t("취소")}</Button><Button variant="primary" onClick={confirm} disabled={!image.current?.naturalWidth}>{t("사용하기")}</Button></>}>
  <div className="screenshot-editor">
   <div className="screenshot-editor-tools"><div className="segmented" role="group" aria-label={t("스크린샷 범위")}><button type="button" className={mode==='all'?'active':''} aria-pressed={mode==='all'} onClick={()=>setMode('all')}>{t("전체 화면")}</button><button type="button" className={mode==='selection'?'active':''} aria-pressed={mode==='selection'} onClick={()=>setMode('selection')}>{t("부분 선택")}</button></div><span>{mode==='all'?`${size.width} × ${size.height}`:`${selected.width} × ${selected.height}`}</span></div>
   <p>{mode==='selection'?t("이미지에서 저장할 영역을 드래그하십시오."):t("검토 화면만 이미지로 저장합니다.")}</p>
   <div className="screenshot-editor-scroll"><div className={`screenshot-editor-image ${mode==='selection'?'selecting':''}`} onPointerDown={event=>{if(mode!=='selection'||event.button!==0)return;event.preventDefault();drag.current=position(event);event.currentTarget.setPointerCapture(event.pointerId);setSelection({...drag.current,width:1,height:1})}} onPointerMove={move} onPointerUp={event=>{move(event);drag.current=null}} onPointerCancel={()=>{drag.current=null}}>
    <img ref={image} src={capture.dataUrl} alt={t("캡처한 검토 화면")} draggable={false} onLoad={event=>setSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={()=>setError(t("스크린샷을 불러오지 못했습니다."))}/>
    {mode==='selection'&&<div className="screenshot-editor-selection" aria-hidden="true" style={{left:`${selected.x/size.width*100}%`,top:`${selected.y/size.height*100}%`,width:`${selected.width/size.width*100}%`,height:`${selected.height/size.height*100}%`}}/>}
   </div></div>
   {mode==='selection'&&<div className="screenshot-editor-coordinates">{[['x',t("왼쪽")],['y',t("위쪽")],['width',t("너비")],['height',t("높이")]].map(([key,title])=><label key={key}>{title}<input type="number" aria-label={t("선택 영역 {0}",[title])} min={key==='x'||key==='y'?0:1} max={key==='x'?size.width-1:key==='y'?size.height-1:key==='width'?size.width-selected.x:size.height-selected.y} value={selected[key]} onChange={event=>update(key,event.target.value)}/></label>)}</div>}
   {error&&<p className="form-error" role="alert">{error}</p>}
  </div>
 </Dialog>;
}
