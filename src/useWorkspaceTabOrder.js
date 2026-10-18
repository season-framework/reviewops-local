import {t} from './i18n/index.js';
import {useEffect, useRef, useState} from 'react';

const DRAG_DISTANCE = 6;
const EDGE_SIZE = 40;

function placeTab(tabs,id,index) {
 const current=tabs.findIndex(tab=>tab.id===id);
 if(current<1)return tabs;
 const target=Math.max(1,Math.min(tabs.length-1,index));
 if(target===current)return tabs;
 const next=[...tabs], [tab]=next.splice(current,1);
 next.splice(target,0,tab);
 return next;
}

// Reorder the existing keyed panes, including unsaved editors and their callbacks.
export default function useWorkspaceTabOrder({tabsRef,setTabs,onActivate,tabTitle}) {
 const listRef=useRef(null),gestureRef=useRef(null),suppressionRef=useRef(null);
 const callbacks=useRef({onActivate,tabTitle});callbacks.current={onActivate,tabTitle};
 const [draggedTabId,setDraggedTabId]=useState(''),[announcement,setAnnouncement]=useState('');

 const clearSuppression=()=>{
  const suppression=suppressionRef.current;
  if(!suppression)return;
  window.removeEventListener('click',suppression.click,true);
  window.removeEventListener('pointerdown',suppression.pointerdown,true);
  clearTimeout(suppression.timer);
  suppressionRef.current=null;
 };
 const suppressDragClick=()=>{
  clearSuppression();
  const suppression={
   click:event=>{if(event.detail===0)return;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();clearSuppression()},
   // A fresh press is an independent action and must retain its ordinary click.
   pointerdown:()=>{if(!gestureRef.current)clearSuppression()},timer:null,
  };
  suppressionRef.current=suppression;
  window.addEventListener('click',suppression.click,true);
  window.addEventListener('pointerdown',suppression.pointerdown,true);
 };
 const updateTabs=update=>setTabs(current=>{
  const next=update(current);
  tabsRef.current=next;
  return next;
 });
 const announcePosition=id=>{
  const current=tabsRef.current,index=current.findIndex(tab=>tab.id===id);
  if(index>0)setAnnouncement(t("{0} 탭을 {1}번째로 이동했습니다.",[callbacks.current.tabTitle(current[index]),index+1]));
 };
 const stopGesture=(cancel=false,unmount=false)=>{
  const gesture=gestureRef.current;
  if(!gesture)return;
  gestureRef.current=null;
  cancelAnimationFrame(gesture.frame);
  gesture.removeListeners();
  if(gesture.list.hasPointerCapture?.(gesture.pointerId))gesture.list.releasePointerCapture(gesture.pointerId);
  if(gesture.started){
   if(cancel&&!unmount){
    // Keep live tab objects; a cancelled drag must not undo saves or reopen tabs.
    updateTabs(current=>{
     const byId=new Map(current.map(tab=>[tab.id,tab]));
     return [...gesture.order.map(id=>byId.get(id)).filter(Boolean),...current.filter(tab=>!gesture.order.includes(tab.id))];
    });
    setAnnouncement(t("탭 이동을 취소했습니다."));
   }else if(!unmount){announcePosition(gesture.id);document.getElementById(`tab-${gesture.id}`)?.focus({preventScroll:true})}
   if(!unmount)setDraggedTabId('');
   if(suppressionRef.current)suppressionRef.current.timer=setTimeout(clearSuppression,1000);
  }
 };

 const beginDrag=(event,id)=>{
  if(id==='home'||event.button!==0||event.isPrimary===false||event.target.closest('.tab-close')||gestureRef.current)return;
  const list=listRef.current;
  if(!list)return;
  clearSuppression();
  const gesture={id,list,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:event.clientX,started:false,order:tabsRef.current.map(tab=>tab.id),frame:0,lastFrame:0};
  gestureRef.current=gesture;
  const reorder=()=>{
   if(!list.isConnected||!tabsRef.current.some(tab=>tab.id===id)){stopGesture(true);return;}
   const others=[...list.children].filter(node=>node.dataset.tabId&&node.dataset.tabId!==id&&node.dataset.tabId!=='home');
   const target=1+others.filter(node=>{const rect=node.getBoundingClientRect();return gesture.x>rect.left+rect.width/2}).length;
   updateTabs(current=>placeTab(current,id,target));
  };
  const tick=time=>{
   gesture.frame=0;
   if(gestureRef.current!==gesture||!gesture.started)return;
   const rect=list.getBoundingClientRect();
   const edge=Math.min(EDGE_SIZE,rect.width/3);
   const velocity=gesture.x<rect.left+edge?-Math.min(1,(rect.left+edge-gesture.x)/edge):gesture.x>rect.right-edge?Math.min(1,(gesture.x-rect.right+edge)/edge):0;
   const elapsed=gesture.lastFrame?Math.min(32,time-gesture.lastFrame):16;
   gesture.lastFrame=time;
   if(velocity)list.scrollLeft+=velocity*elapsed*.7;
   reorder();
   if(gestureRef.current===gesture)gesture.frame=requestAnimationFrame(tick);
  };
  const move=pointer=>{
   if(pointer.pointerId!==gesture.pointerId)return;
   gesture.x=pointer.clientX;
   if(!gesture.started&&Math.hypot(pointer.clientX-gesture.startX,pointer.clientY-gesture.startY)<DRAG_DISTANCE)return;
   if(pointer.cancelable)pointer.preventDefault();
   if(!gesture.started){
    gesture.started=true;
    suppressDragClick();
    callbacks.current.onActivate(id);
    setDraggedTabId(id);
    // Capture after the threshold so a simple press still clicks its tab button.
    // The list stays mounted while React moves the individual tab elements.
    try{list.setPointerCapture(pointer.pointerId)}catch{}
    gesture.frame=requestAnimationFrame(tick);
   }
   reorder();
  };
  const up=pointer=>{if(pointer.pointerId===gesture.pointerId)stopGesture(false)};
  const cancel=pointer=>{if(pointer.pointerId===gesture.pointerId)stopGesture(true)};
  const key=keyboard=>{if(keyboard.key==='Escape'){keyboard.preventDefault();keyboard.stopPropagation();stopGesture(true)}};
  const blur=()=>stopGesture(true);
  const visibility=()=>{if(document.hidden)stopGesture(true)};
  gesture.removeListeners=()=>{
   window.removeEventListener('pointermove',move,true);
   window.removeEventListener('pointerup',up,true);
   window.removeEventListener('pointercancel',cancel,true);
   window.removeEventListener('keydown',key,true);
   window.removeEventListener('blur',blur);
   document.removeEventListener('visibilitychange',visibility);
  };
  window.addEventListener('pointermove',move,{capture:true,passive:false});
  window.addEventListener('pointerup',up,true);
  window.addEventListener('pointercancel',cancel,true);
  window.addEventListener('keydown',key,true);
  window.addEventListener('blur',blur);
  document.addEventListener('visibilitychange',visibility);
 };

 const reorderKey=(event,id)=>{
  if(!(event.altKey&&event.shiftKey)||!['ArrowLeft','ArrowRight'].includes(event.key))return false;
  event.preventDefault();
  if(id==='home')return true;
  const index=tabsRef.current.findIndex(tab=>tab.id===id),next=index+(event.key==='ArrowLeft'?-1:1);
  updateTabs(current=>placeTab(current,id,next));
  callbacks.current.onActivate(id);
  requestAnimationFrame(()=>{document.getElementById(`tab-${id}`)?.focus();document.getElementById(`tab-${id}`)?.scrollIntoView({block:'nearest',inline:'nearest'});announcePosition(id)});
  return true;
 };

 useEffect(()=>()=>{stopGesture(true,true);clearSuppression()},[]);
 return {listRef,draggedTabId,announcement,beginDrag,reorderKey};
}
