import {t} from './i18n/index.js';
import React, {forwardRef,useImperativeHandle,useLayoutEffect,useRef,useState} from 'react';

const emptyState={id:'',url:'',title:'',loading:false,canGoBack:false,canGoForward:false,error:''};
const rectOf=rect=>({x:rect.left,y:rect.top,width:rect.width,height:rect.height});
const intersect=(a,b)=>{const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)}};
const shown=element=>Boolean(element?.isConnected&&element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden');

function measure(element,enabled,viewport) {
 const bounds=rectOf(element.getBoundingClientRect());
 let clip=intersect(bounds,{x:0,y:0,width:window.innerWidth,height:window.innerHeight});
 let visible=enabled&&document.body.style.cursor!=='col-resize'&&shown(element)&&document.visibilityState!=='hidden'&&(!document.fullscreenElement||document.fullscreenElement.contains(element));
 for(let parent=element.parentElement;parent&&visible;parent=parent.parentElement){
  const style=getComputedStyle(parent);
  if(parent.hidden||style.display==='none'||style.visibility==='hidden'){visible=false;break}
  if(/auto|scroll|hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)){
   const rect=parent.getBoundingClientRect(),scaleX=parent.offsetWidth?rect.width/parent.offsetWidth:1,scaleY=parent.offsetHeight?rect.height/parent.offsetHeight:1;
   const area={x:rect.left+parent.clientLeft*scaleX,y:rect.top+parent.clientTop*scaleY,width:parent.clientWidth*scaleX,height:parent.clientHeight*scaleY};
   if(!/auto|scroll|hidden|clip/.test(style.overflowX)){area.x=clip.x;area.width=clip.width}
   if(!/auto|scroll|hidden|clip/.test(style.overflowY)){area.y=clip.y;area.height=clip.height}
   clip=intersect(clip,area);
  }
 }
 if(visible&&[...document.querySelectorAll('.dialog-backdrop,[role="dialog"][aria-modal="true"]')].some(dialog=>shown(dialog)&&!dialog.contains(element)))visible=false;
 // A renderer popup needs the native page hidden. The renderer keeps only
 // an in-memory image of the same page while that popup covers its surface.
 visible=Boolean(visible&&bounds.width>0&&bounds.height>0&&clip.width>0&&clip.height>0);
 const popupOccluded=visible&&[...document.querySelectorAll('.reviewops-select-popup,.reviewops-popup-menu')].some(popup=>{if(!shown(popup))return false;const overlap=intersect(clip,rectOf(popup.getBoundingClientRect()));return overlap.width>0&&overlap.height>0});
 return {visible:visible&&!popupOccluded,popupOccluded,bounds,clip,viewport};
}

// The native page is separate from this renderer. This element only reserves its
// position and keeps the native view beneath application dialogs and hidden tabs.
const NativeBrowser=forwardRef(function NativeBrowser({invoke,url,contextId='',navigationRequest=0,enabled=true,viewport,onState,onError},ref){
 const surface=useRef(null),id=useRef(''),creation=useRef(null),alive=useRef(false),visible=useRef(false),lastLayout=useRef(''),lastTarget=useRef(''),lastRequest=useRef(0),browserError=useRef(''),syncLayout=useRef(()=>{});
 const latest=useRef({invoke,url,contextId,navigationRequest,enabled,viewport,onState,onError});latest.current={invoke,url,contextId,navigationRequest,enabled,viewport,onState,onError};
 const [state,setState]=useState({...emptyState,url}),[popupPreview,setPopupPreview]=useState(null);
 const published=useRef({...emptyState,url}),preview=useRef(null),previewEpisode=useRef({key:'',attempted:false}),previewEpoch=useRef(0),navigationRevision=useRef(0),navigationPending=useRef(0);
 const previewIdentity=()=>{const current=latest.current,page=published.current;return JSON.stringify([id.current,current.contextId,current.url,current.navigationRequest,current.enabled,current.viewport?.width,current.viewport?.height,current.viewport?.scale,page.url,page.loading,page.error,navigationRevision.current])};
 const clearPreview=()=>{if(previewEpisode.current.key){previewEpoch.current++;previewEpisode.current={key:'',attempted:false}}if(preview.current){preview.current=null;setPopupPreview(null)}};
 const beginNavigation=()=>{navigationRevision.current++;navigationPending.current++;clearPreview()};
 const updatePreview=measured=>{
  const page=published.current;
  if(!measured.popupOccluded||!id.current||browserError.current||page.loading||navigationPending.current){clearPreview();return}
  const identity=previewIdentity(),key=JSON.stringify([identity,measured.bounds.width,measured.bounds.height,measured.clip.width,measured.clip.height]);
  if(previewEpisode.current.key!==key){clearPreview();previewEpisode.current={key,attempted:false}}
  if(previewEpisode.current.attempted)return;
  previewEpisode.current.attempted=true;
  const epoch=++previewEpoch.current,currentId=id.current,expectedUrl=page.url||latest.current.url;
  Promise.resolve().then(()=>{if(!alive.current||epoch!==previewEpoch.current||previewEpisode.current.key!==key||identity!==previewIdentity()||!surface.current||!measure(surface.current,latest.current.enabled,latest.current.viewport).popupOccluded)return null;return latest.current.invoke('browser.capture',{id:currentId})}).then(result=>{
   if(!alive.current||epoch!==previewEpoch.current||previewEpisode.current.key!==key||id.current!==currentId||identity!==previewIdentity()||navigationPending.current||browserError.current||published.current.loading)return;
   if(!result?.dataUrl?.startsWith('data:image/png;base64,')||result.url&&result.url!==expectedUrl)return;
   const current=measure(surface.current,latest.current.enabled,latest.current.viewport),currentKey=JSON.stringify([previewIdentity(),current.bounds.width,current.bounds.height,current.clip.width,current.clip.height]);
   if(!current.popupOccluded||currentKey!==key)return;
   const image={dataUrl:result.dataUrl,identity};preview.current=image;setPopupPreview(image);
  }).catch(()=>{});
 };
 const publish=result=>{if(!alive.current||!result)return;const previousPage=published.current,nextError=result.error||'',changed=browserError.current!==nextError||previousPage.url!==result.url||previousPage.loading!==result.loading;published.current=result;browserError.current=nextError;if(changed){clearPreview();syncLayout.current()}setState(previous=>JSON.stringify(previous)===JSON.stringify(result)?previous:result);latest.current.onState?.(result)};
 const report=error=>{if(alive.current)latest.current.onError?.(error.message||String(error))};
 const ensure=async()=>{
  if(id.current)return id.current;
  if(creation.current)return creation.current;
  const initial=latest.current.url,initialRequest=latest.current.navigationRequest;
  if(!initial)return '';
  lastTarget.current=initial;lastRequest.current=initialRequest;
 creation.current=latest.current.invoke('browser.create',{url:initial,contextId:latest.current.contextId,viewport:latest.current.viewport}).then(result=>{
   if(!alive.current){latest.current.invoke('browser.close',{id:result.id}).catch(()=>{});return ''}
   id.current=result.id;publish(result);syncLayout.current();if(latest.current.url&&(latest.current.url!==initial||latest.current.navigationRequest!==initialRequest)){lastTarget.current=latest.current.url;lastRequest.current=latest.current.navigationRequest;beginNavigation();latest.current.invoke('browser.navigate',{id:result.id,url:latest.current.url,contextId:latest.current.contextId}).then(publish).catch(report).finally(()=>{navigationPending.current=Math.max(0,navigationPending.current-1);if(alive.current)syncLayout.current()})}return result.id;
  }).finally(()=>{creation.current=null});
  return creation.current;
 };
 const command=async(action,payload={})=>{
  const navigates=['navigate','back','forward','reload'].includes(action);if(navigates)beginNavigation();
  try{const current=id.current||await ensure();if(!current||!alive.current)return;const result=await latest.current.invoke(`browser.${action}`,{id:current,...(action==='navigate'?{contextId:latest.current.contextId}:{}),...payload});publish(result);return result}catch(error){report(error)}finally{if(navigates){navigationPending.current=Math.max(0,navigationPending.current-1);if(alive.current)syncLayout.current()}}
 };
 const dataCommand=async(action,payload={})=>{const current=id.current||await ensure();if(!current||!alive.current)throw new Error(t("대상 화면을 먼저 여십시오."));return latest.current.invoke('browser.'+action,{id:current,...payload})};
 useImperativeHandle(ref,()=>({navigate:url=>command('navigate',{url}),back:()=>command('back'),forward:()=>command('forward'),reload:()=>command('reload'),stop:()=>command('stop'),capture:()=>dataCommand('capture'),evidence:()=>dataCommand('evidence'),clearLogs:kind=>dataCommand('clearLogs',{kind}),pickElement:()=>dataCommand('pickElement')}),[]);
 useLayoutEffect(()=>{
  alive.current=true;
  return()=>{alive.current=false;visible.current=false;previewEpoch.current++;previewEpisode.current={key:'',attempted:false};preview.current=null;const current=id.current;id.current='';if(current)latest.current.invoke('browser.close',{id:current}).catch(()=>{})};
 },[]);
 useLayoutEffect(()=>{clearPreview();if(id.current){beginNavigation();latest.current.invoke('browser.context',{id:id.current,contextId}).catch(report).finally(()=>{navigationPending.current=Math.max(0,navigationPending.current-1);if(alive.current)syncLayout.current()})}},[contextId]);
 useLayoutEffect(()=>{
  if(!url)return;
  const current=id.current;
  if(!current){ensure().catch(report);return}
  if(lastTarget.current!==url||lastRequest.current!==navigationRequest){lastTarget.current=url;lastRequest.current=navigationRequest;command('navigate',{url})}
 },[url,navigationRequest]);
 useLayoutEffect(()=>{
  const element=surface.current;if(!element)return;
  let disposed=false,polling=false;
  const update=()=>{
   if(disposed)return;
   const measured=measure(element,latest.current.enabled,latest.current.viewport),{popupOccluded,...layout}=measured;
   // Poll the active page beneath its temporary image too, so redirects and
   // loading changes invalidate it without waiting for the popup to close.
   visible.current=layout.visible||popupOccluded;
   updatePreview(measured);
   layout.visible=layout.visible&&!browserError.current;
   if(!id.current)return;
   const serialized=JSON.stringify(layout);
   if(serialized===lastLayout.current)return;
   lastLayout.current=serialized;
   latest.current.invoke('browser.layout',{id:id.current,...layout}).catch(error=>{lastLayout.current='';report(error)});
  };
  syncLayout.current=update;
  const resize=new ResizeObserver(update);for(let elementToWatch=element;elementToWatch;elementToWatch=elementToWatch.parentElement)resize.observe(elementToWatch);
  const mutation=new MutationObserver(update);mutation.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','class','style','open','aria-hidden']});
  const poll=async()=>{update();if(!visible.current||!id.current||polling)return;polling=true;try{publish(await latest.current.invoke('browser.state',{id:id.current}))}catch(error){report(error)}finally{polling=false}};
  const timer=setInterval(poll,250);
  window.addEventListener('resize',update);document.addEventListener('scroll',update,true);document.addEventListener('fullscreenchange',update);document.addEventListener('visibilitychange',update);
  update();
  return()=>{disposed=true;resize.disconnect();mutation.disconnect();clearInterval(timer);window.removeEventListener('resize',update);document.removeEventListener('scroll',update,true);document.removeEventListener('fullscreenchange',update);document.removeEventListener('visibilitychange',update);syncLayout.current=()=>{}};
 },[]);
 useLayoutEffect(()=>{clearPreview();syncLayout.current()},[enabled,url,contextId,navigationRequest,viewport.width,viewport.height,viewport.scale]);
 return <div ref={surface} className="native-browser-surface" hidden={!enabled} data-browser-id={state.id||undefined} data-browser-loading={state.loading?'true':'false'} aria-label={t("검토 화면")}>{popupPreview&&popupPreview.identity===previewIdentity()&&<img className="native-browser-popup-preview" src={popupPreview.dataUrl} alt="" aria-hidden="true" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'fill',pointerEvents:'none'}} onError={()=>{if(preview.current===popupPreview){preview.current=null;setPopupPreview(null)}}}/>}{state.error&&<div className="native-browser-error" role="status"><p>{t("페이지를 열 수 없습니다.")}</p><small>{state.error}</small><button type="button" onClick={()=>command('reload')}>{t("다시 시도")}</button></div>}</div>;
});
export default NativeBrowser;
