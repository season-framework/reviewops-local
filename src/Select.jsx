import {t} from './i18n/index.js';
import React,{Children,Fragment,forwardRef,isValidElement,useCallback,useEffect,useId,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

const textOf=value=>Children.toArray(value).map(item=>typeof item==='string'||typeof item==='number'?String(item):isValidElement(item)?textOf(item.props.children):'').join('');
function readOptions(children,group='',disabled=false,result=[]) {
 Children.forEach(children,child=>{
  if(!isValidElement(child))return;
  if(child.type===Fragment){readOptions(child.props.children,group,disabled,result);return}
  if(child.type==='optgroup'){readOptions(child.props.children,String(child.props.label||''),disabled||Boolean(child.props.disabled),result);return}
  if(child.type!=='option')return;
  const label=child.props.label??textOf(child.props.children),value=String(child.props.value??label);
  result.push({key:`option-${result.length}`,value,label:String(label),group,disabled:disabled||Boolean(child.props.disabled),hidden:Boolean(child.props.hidden),selected:Boolean(child.props.selected),title:child.props.title});
 });
 return result;
}
const normalized=value=>String(value??'').normalize('NFKC').toLocaleLowerCase();
const samePosition=(a,b)=>a&&a.left===b.left&&a.top===b.top&&a.width===b.width&&a.maxHeight===b.maxHeight&&a.side===b.side;
const focusable=root=>[...root.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(node=>node.tabIndex>=0&&!node.matches(':disabled')&&node.getAttribute('aria-hidden')!=='true'&&node.getClientRects().length);

/** Native-select props and option children, with a portal listbox instead of an OS popup. */
const Select=forwardRef(function Select({children,value,defaultValue,onChange,disabled=false,required=false,name,id:providedId,className='',style,searchable,allowCustom=false,clearable=false,placeholder=t("선택"),searchPlaceholder=t("검색"),emptyMessage=t("검색 결과가 없습니다."),popupClassName='',onKeyDown,onFocus,onBlur,onClick,onInvalid,autoFocus=false,form,tabIndex=0,...attributes},ref) {
 const generated=useId(),id=providedId||`reviewops-select-${generated.replace(/:/g,'')}`,popupId=`${id}-popup`,listId=`${id}-listbox`;
 const options=useMemo(()=>readOptions(children),[children]);
 const controlled=value!==undefined;
 const [internalValue,setInternalValue]=useState(()=>String(defaultValue??options.find(item=>item.selected)?.value??options[0]?.value??''));
 const currentValue=String((controlled?value:internalValue)??'');
 const selected=options.find(item=>item.value===currentValue);
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[activeKey,setActiveKey]=useState(''),[position,setPosition]=useState(null),[portal,setPortal]=useState(null),[derivedLabel,setDerivedLabel]=useState(''),[invalid,setInvalid]=useState(false),[inheritedDisabled,setInheritedDisabled]=useState(false);
 const wrapper=useRef(null),trigger=useRef(null),native=useRef(null),popup=useRef(null),search=useRef(null),list=useRef(null),composing=useRef(false),navigationUsed=useRef(false),typeahead=useRef({value:'',at:0}),openRef=useRef(false),openFocusFrame=useRef(0);
 const searchEnabled=searchable===undefined?(allowCustom||options.filter(item=>!item.hidden).length>=8):Boolean(searchable)||Boolean(allowCustom);
 const label=attributes['aria-label']||derivedLabel||name||t("항목");
 const effectiveDisabled=disabled||inheritedDisabled;
 const matches=options.filter(item=>!item.hidden&&(!query||normalized(`${item.label} ${item.value} ${item.group}`).includes(normalized(query))));
 const customValue=query.trim(),exactCustom=options.some(item=>normalized(item.value)===normalized(customValue)||normalized(item.label)===normalized(customValue));
 const custom=allowCustom&&customValue&&!exactCustom?{key:'custom',value:customValue,label:t("직접 입력: {0}",[customValue]),custom:true,disabled:false,group:''}:null;
 const visible=custom?[...matches,custom]:matches,enabled=visible.filter(item=>!item.disabled),active=enabled.find(item=>item.key===activeKey);
 useImperativeHandle(ref,()=>trigger.current);
 useLayoutEffect(()=>{
  const button=trigger.current;if(!button)return;
  const labels=[...(button.labels||[])];if(!labels.length&&button.closest('label'))labels.push(button.closest('label'));
  const next=labels.map(element=>{const clone=element.cloneNode(true);clone.querySelectorAll('.reviewops-select,select,input,button,small').forEach(node=>node.remove());return clone.textContent.trim().replace(/\s+/g,' ')}).filter(Boolean).join(' ');
  setDerivedLabel(current=>current===next?current:next);
 });
 useEffect(()=>{
  const button=trigger.current;if(!button)return;
  const update=()=>setInheritedDisabled(button.matches(':disabled'));
  update();const observer=new MutationObserver(update);let parent=button.parentElement;while(parent){if(parent.tagName==='FIELDSET')observer.observe(parent,{attributes:true,attributeFilter:['disabled']});parent=parent.parentElement}return()=>observer.disconnect();
 },[disabled]);
 const close=useCallback((restore=false)=>{openRef.current=false;cancelAnimationFrame(openFocusFrame.current);setOpen(false);setQuery('');composing.current=false;navigationUsed.current=false;if(restore&&trigger.current?.isConnected&&!trigger.current.matches(':disabled'))trigger.current.focus({preventScroll:true})},[]);
 useEffect(()=>()=>cancelAnimationFrame(openFocusFrame.current),[]);
 useEffect(()=>{if(effectiveDisabled&&open)close(false)},[effectiveDisabled,open,close]);
 const openMenu=(edge='selected',initialQuery='')=>{
  if(effectiveDisabled||trigger.current?.matches(':disabled'))return;
  setPortal(trigger.current?.closest('[role="dialog"],[role="alertdialog"],dialog')||document.body);setQuery(initialQuery);setPosition(null);navigationUsed.current=false;
  const available=options.filter(item=>!item.disabled&&!item.hidden),choice=edge==='last'?available.at(-1):edge==='first'?available[0]:available.find(item=>item.value===currentValue)||available[0];
  setActiveKey(choice?.key||'');openRef.current=true;setOpen(true);window.dispatchEvent(new CustomEvent('reviewops:select-open',{detail:{id}}));
 };
 const select=(item,event)=>{
  if(!item||item.disabled||effectiveDisabled)return;
  const next=item.value;if(!controlled)setInternalValue(next);setInvalid(false);
  if(native.current&&[...native.current.options].some(option=>option.value===next))native.current.value=next;
  close(true);
  if(next!==currentValue){
   const target={value:next,name:name||'',id,type:'select-one',selectedIndex:options.findIndex(option=>option.value===next),selectedOptions:[{value:next,label:item.label,text:item.label}],form:native.current?.form};
   onChange?.({type:'change',target,currentTarget:target,nativeEvent:event?.nativeEvent||event,timeStamp:Date.now(),bubbles:true,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;event?.preventDefault?.()},stopPropagation(){event?.stopPropagation?.()},persist(){},isDefaultPrevented(){return this.defaultPrevented}});
  }
 };
 const move=(key)=>{
  if(!enabled.length)return;navigationUsed.current=true;const index=enabled.findIndex(item=>item.key===activeKey);let next;
  if(key==='Home')next=0;else if(key==='End')next=enabled.length-1;else next=index<0?(key==='ArrowUp'?enabled.length-1:0):Math.max(0,Math.min(enabled.length-1,index+(key==='ArrowUp'?-1:1)));
  setActiveKey(enabled[next].key);
 };
 const leaveByTab=event=>{
  const scope=trigger.current?.closest('[role="dialog"],[role="alertdialog"],dialog')||document,items=focusable(scope).filter(node=>!popup.current?.contains(node)&&node!==native.current),index=items.indexOf(trigger.current);let next=items[index+(event.shiftKey?-1:1)];
  if(!next&&scope!==document)next=event.shiftKey?items.at(-1):items[0];
  close(false);event.stopPropagation();if(next){event.preventDefault();next.focus({preventScroll:true})}else trigger.current?.focus({preventScroll:true});
 };
 const handleKey=event=>{
  if(event.isComposing||event.nativeEvent?.isComposing||composing.current||event.keyCode===229)return;
  if(effectiveDisabled)return;
  if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close(true);return}
  if(event.key==='Tab'&&open){leaveByTab(event);return}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
   event.preventDefault();event.stopPropagation();if(!open)openMenu(event.key==='End'||event.key==='ArrowUp'?'last':event.key==='Home'?'first':'selected');else move(event.key);return;
  }
  if(event.key==='Enter'||event.key===' '&&event.target===trigger.current){
   event.preventDefault();event.stopPropagation();if(!open)openMenu();else select(custom&&!navigationUsed.current?custom:active||enabled[0],event);return;
  }
  if(event.target===trigger.current&&event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
   event.preventDefault();if(searchEnabled){if(!open)openMenu('first',event.key);else setQuery(previous=>previous+event.key)}else{
    const now=Date.now();typeahead.current={value:now-typeahead.current.at>700?event.key:typeahead.current.value+event.key,at:now};
    const choice=options.find(item=>!item.disabled&&!item.hidden&&normalized(item.label).startsWith(normalized(typeahead.current.value)));if(choice){if(!open)openMenu();setActiveKey(choice.key)}
   }
  }
 };
 const measure=useCallback(()=>{
  const button=trigger.current;if(!button?.getClientRects().length){close(false);return}
  const rect=button.getBoundingClientRect(),viewport=window.visualViewport,leftEdge=(viewport?.offsetLeft||0)+8,topEdge=(viewport?.offsetTop||0)+8,rightEdge=(viewport?.offsetLeft||0)+(viewport?.width||innerWidth)-8,bottomEdge=(viewport?.offsetTop||0)+(viewport?.height||innerHeight)-8;
  if(rect.bottom<topEdge||rect.top>bottomEdge||rect.right<leftEdge||rect.left>rightEdge){close(false);return}
  const below=bottomEdge-rect.bottom-4,above=rect.top-topEdge-4,side=below>=160||below>=above?'bottom':'top',maxHeight=Math.max(48,Math.min(360,side==='bottom'?below:above)),width=Math.min(Math.max(rect.width,searchEnabled?220:160),Math.max(80,rightEdge-leftEdge));
  const height=Math.min(popup.current?.getBoundingClientRect().height||maxHeight,maxHeight),next={left:Math.max(leftEdge,Math.min(rect.left,rightEdge-width)),top:side==='bottom'?Math.max(topEdge,rect.bottom+4):Math.max(topEdge,rect.top-4-height),width,maxHeight,side};
  setPosition(previous=>samePosition(previous,next)?previous:next);
 },[close,searchEnabled]);
 useLayoutEffect(()=>{if(open)measure()},[open,measure]);
 useLayoutEffect(()=>{if(!open||!position)return;const focus=()=>{if(!openRef.current||trigger.current?.matches(':disabled'))return;const active=document.activeElement;if(active!==trigger.current&&!popup.current?.contains(active)&&active!==document.body)return;(searchEnabled?search.current:trigger.current)?.focus({preventScroll:true})};focus();openFocusFrame.current=requestAnimationFrame(focus);return()=>cancelAnimationFrame(openFocusFrame.current)},[open,Boolean(position),searchEnabled]);
 useLayoutEffect(()=>{if(open)measure()},[open,query,visible.length,measure]);
 useLayoutEffect(()=>{if(!open)return;const current=enabled.find(item=>item.key===activeKey);if(!current)setActiveKey((enabled.find(item=>item.value===currentValue)||enabled[0])?.key||'')},[open,query,options,activeKey,currentValue]);
 useLayoutEffect(()=>{if(open&&activeKey)list.current?.querySelector(`[data-select-key="${activeKey}"]`)?.scrollIntoView({block:'nearest'})},[open,activeKey]);
 useEffect(()=>{
  if(!open)return;let frame=0;const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure)};
  const pointer=event=>{const path=event.composedPath();if(!path.includes(wrapper.current)&&!path.includes(popup.current))close(false)};
  const focus=event=>{if(!wrapper.current?.contains(event.target)&&!popup.current?.contains(event.target))close(false)};
  const other=event=>{if(event.detail?.id!==id)close(false)},blur=()=>close(false);
  document.addEventListener('pointerdown',pointer,true);document.addEventListener('focusin',focus,true);window.addEventListener('reviewops:select-open',other);window.addEventListener('blur',blur);window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);
  const observer=new ResizeObserver(schedule);if(trigger.current)observer.observe(trigger.current);if(popup.current)observer.observe(popup.current);
  return()=>{cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener('pointerdown',pointer,true);document.removeEventListener('focusin',focus,true);window.removeEventListener('reviewops:select-open',other);window.removeEventListener('blur',blur);window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule)};
 },[open,id,measure,close]);
 useEffect(()=>{const control=native.current,owner=control?.form;if(!owner)return;const reset=()=>{if(!controlled)setInternalValue(String(defaultValue??options[0]?.value??''));setInvalid(false);close(false)};owner.addEventListener('reset',reset);return()=>owner.removeEventListener('reset',reset)},[controlled,defaultValue,options,close]);
 const popupNode=open&&portal?createPortal(<div ref={popup} id={popupId} className={`reviewops-select-popup ${popupClassName}`} data-select-owner={id} data-side={position?.side||'bottom'} style={{left:position?.left??0,top:position?.top??0,width:position?.width??220,maxHeight:position?.maxHeight??360,visibility:position?'visible':'hidden'}} onKeyDown={handleKey}>
  {searchEnabled&&<div className="reviewops-select-search"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input ref={search} type="search" aria-label={t("목록 검색")} data-select-search="true" placeholder={searchPlaceholder} value={query} aria-controls={listId} aria-activedescendant={active?`${id}-${active.key}`:undefined} autoComplete="off" spellCheck={false} onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false}} onChange={event=>{navigationUsed.current=false;setQuery(event.target.value)}}/></div>}
  <div ref={list} id={listId} role="listbox" aria-label={t("{0} 목록",[label])} className="reviewops-select-options">
   {visible.map((item,index)=><Fragment key={item.key}>{item.group&&item.group!==visible[index-1]?.group&&<div role="presentation" className="reviewops-select-group">{item.group}</div>}<div id={`${id}-${item.key}`} role="option" aria-selected={item.value===currentValue} aria-disabled={item.disabled||undefined} data-value={item.value} data-select-key={item.key} data-custom={item.custom?'true':undefined} data-highlighted={activeKey===item.key?'true':undefined} className={`reviewops-select-option ${item.value===currentValue?'is-selected':''} ${activeKey===item.key?'is-highlighted':''}`} title={item.title||item.label} onPointerDown={event=>event.preventDefault()} onPointerMove={()=>{if(!item.disabled)setActiveKey(item.key)}} onClick={event=>select(item,event)}><span className="reviewops-select-option-label">{item.label}</span><span className="reviewops-select-option-check" aria-hidden="true">{item.value===currentValue&&<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 12 4 4L19 6"/></svg>}</span></div></Fragment>)}
   {!visible.length&&<div className="reviewops-select-empty" role="status">{emptyMessage}</div>}
  </div>
 </div>,portal):null;
 return <div ref={wrapper} className={`reviewops-select ${className}`} style={style} data-select-open={open?'true':'false'} data-disabled={effectiveDisabled?'true':undefined}>
  <button {...attributes} ref={trigger} id={id} type="button" role="combobox" className="reviewops-select-trigger" value={currentValue} disabled={disabled} tabIndex={tabIndex} autoFocus={autoFocus} aria-label={attributes['aria-label']||(!attributes['aria-labelledby']?derivedLabel||undefined:undefined)} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?listId:undefined} aria-activedescendant={open&&active?`${id}-${active.key}`:undefined} aria-required={required||undefined} aria-invalid={invalid||attributes['aria-invalid']} aria-errormessage={invalid?`${id}-error`:attributes['aria-errormessage']} data-value={currentValue} title={attributes.title||selected?.label||currentValue||undefined} onFocus={onFocus} onBlur={onBlur} onKeyDown={event=>{onKeyDown?.(event);if(!event.defaultPrevented)handleKey(event)}} onClick={event=>{onClick?.(event);if(!event.defaultPrevented){if(open)close(false);else openMenu()}}}>
   <span className={`reviewops-select-value ${!selected&&!currentValue?'is-placeholder':''}`}>{selected?.label||currentValue||placeholder}</span><svg className="reviewops-select-chevron" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m6 9 6 6 6-6"/></svg>
  </button>
  {clearable&&currentValue!==''&&<button type="button" className="reviewops-select-clear" disabled={disabled} aria-label={t("{0} 지우기",[label])} onClick={event=>{event.preventDefault();event.stopPropagation();select({value:'',label:''},event)}}><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg></button>}
  <select ref={native} className="reviewops-select-native" aria-hidden="true" tabIndex={-1} name={name} form={form} value={currentValue} disabled={disabled} required={required} onChange={event=>select({value:event.target.value,label:event.target.selectedOptions[0]?.label||event.target.value},event)} onInvalid={event=>{event.preventDefault();onInvalid?.(event);setInvalid(true);trigger.current?.focus({preventScroll:true});openMenu()}}>{!selected&&<option value={currentValue}>{currentValue}</option>}{children}</select>
  {invalid&&<span id={`${id}-error`} className="reviewops-select-validation" role="alert">{t("항목을 선택하십시오.")}</span>}
  {popupNode}
 </div>;
});
export default Select;
