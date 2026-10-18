'use strict';
const LIMIT = 250;
const WORLD = 109;
const sensitive = /pass(word|phrase)?|passwd|secret|token|authorization|cookie|api[-_]?key|(^|[-_])(otp|code|credential)([-_]|$)/i;
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    url.username='';url.password='';
    for(const key of url.searchParams.keys())if(sensitive.test(key))url.searchParams.set(key,'[비공개]');
    if(/token|password|secret|code=|access_token/i.test(url.hash))url.hash='';
    return url.href.slice(0,4096);
  } catch { return String(value||'').slice(0,4096); }
}
function safeText(value) {
  return String(value||'').replace(/\b((?:bearer|basic)\s+)[a-z0-9._~+/=-]+/ig,'$1[비공개]').replace(/((?:["']?(?:password|passwd|passphrase|[a-z_-]*token|secret|api[_-]?key|authorization|cookie)["']?)\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/ig,(_match,prefix,content)=>prefix+(content[0]==='"'?'"[비공개]"':content[0]==="'"?"'[비공개]'":'[비공개]')).slice(0,6000);
}
function installInputRecorder() {
  if(window.__reviewopsInputRecorder)return;
  const events=[];window.__reviewopsInputRecorder={events};
  const target=element=>({tag:element.tagName?.toLowerCase()||'',id:element.id||'',name:element.name||'',type:element.type||'',label:(element.getAttribute?.('aria-label')||element.placeholder||'').slice(0,160)});
  const add=event=>{events.push(event);if(events.length>250)events.shift()};
  document.addEventListener('click',event=>{
    const element=event.target?.closest?.('button,a,input,select,textarea,[role="button"]');
    if(element)add({type:'click',at:new Date().toISOString(),target:target(element)});
  },true);
  document.addEventListener('change',event=>{
    const element=event.target;
    if(!element?.matches?.('input,select,textarea,[contenteditable="true"]'))return;
    const value=String(element.type==='checkbox'||element.type==='radio'?element.checked:element.value??element.textContent??'');
    add({type:'change',at:new Date().toISOString(),target:target(element),value_length:value.length,masked:true});
  },true);
}
function readInputRecorder() {
  const logs=window.__reviewopsInputRecorder?.events||[];
  return {logs:logs.splice(0),fingerprint:{url:location.href,title:document.title,userAgent:navigator.userAgent,language:navigator.language,platform:navigator.platform,viewport:{width:innerWidth,height:innerHeight},screen:{width:screen.width,height:screen.height},devicePixelRatio}};
}
function selectElement() {
  return new Promise(resolve=>{
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #c43d1c;background:#c43d1c18;display:none';
    document.documentElement.appendChild(overlay);
    let finished=false,timer;
    const clean=value=>{if(finished)return;finished=true;clearTimeout(timer);document.removeEventListener('pointermove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);overlay.remove();resolve(value)};
    const move=event=>{const r=event.target.getBoundingClientRect();Object.assign(overlay.style,{display:'block',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'})};
    const click=event=>{
      event.preventDefault();event.stopImmediatePropagation();
      const el=event.target,r=el.getBoundingClientRect(),escape=value=>CSS.escape(value);
      const pieces=[];let current=el;
      while(current&&pieces.length<6){let piece=current.tagName.toLowerCase();if(current.id){pieces.unshift('#'+escape(current.id));break}const parent=current.parentElement;if(parent){const siblings=[...parent.children].filter(child=>child.tagName===current.tagName);if(siblings.length>1)piece+=':nth-of-type('+(siblings.indexOf(current)+1)+')'}pieces.unshift(piece);current=parent}
      const editable=el.isContentEditable||el.closest('[contenteditable]')||/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)||el.querySelector('input,textarea,select,[contenteditable]');
      clean({selector:pieces.join(' > '),tag:el.tagName.toLowerCase(),id:el.id||'',classes:typeof el.className==='string'?el.className:'',text:editable?'':String(el.textContent||'').trim().slice(0,1000),rect:{x:r.x,y:r.y,width:r.width,height:r.height},at:new Date().toISOString()});
    };
    const key=event=>{if(event.key==='Escape'){event.preventDefault();clean(null)}};
    document.addEventListener('pointermove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);
    timer=setTimeout(()=>clean(null),60000);
  });
}
function createEvidenceRecorder() {
  const owners=new Map(),tracked=new Map(),requests=new Map(),reading=new Map();
  const add=(item,kind,value)=>{const list=item.evidence[kind];list.push(value);if(list.length>LIMIT)list.splice(0,list.length-LIMIT)};
  function drain(contents,item) {
    if(contents.isDestroyed())return Promise.resolve();
    if(reading.has(contents.id))return reading.get(contents.id);
    const generation=item.evidenceGeneration||0;
    const promise=contents.executeJavaScriptInIsolatedWorld(WORLD,[{code:'('+readInputRecorder.toString()+')()'}]).then(value=>{
      if(generation!==(item.evidenceGeneration||0))return;
      for(const event of value?.logs||[]){const {value:inputValue,...metadata}=event;add(item,'input_log',event.type==='change'?{...metadata,value_length:event.value_length??String(inputValue||'').length,masked:true}:metadata);}
      if(contents===item.view.webContents&&value?.fingerprint)item.evidence.fingerprint_log={...value.fingerprint,url:safeUrl(value.fingerprint.url)};
    }).catch(()=>{}).finally(()=>reading.delete(contents.id));
    reading.set(contents.id,promise);return promise;
  }
  const timer=setInterval(()=>{for(const [id,contents]of tracked){const item=owners.get(id);if(item)drain(contents,item)}},700);
  timer.unref?.();
  function track(contents,item) {
    if(!item.evidence)item.evidence={navigation_log:[],input_log:[],network_log:[],console_log:[],fingerprint_log:{}};
    owners.set(contents.id,item);
    tracked.set(contents.id,contents);
    const install=()=>{if(!contents.isDestroyed())contents.executeJavaScriptInIsolatedWorld(WORLD,[{code:'('+installInputRecorder.toString()+')()'}]).catch(()=>{})};
    contents.on('dom-ready',install);
    contents.on('did-navigate',(_event,url)=>add(item,'navigation_log',{type:'navigate',url:safeUrl(url),at:new Date().toISOString()}));
    contents.on('did-navigate-in-page',(_event,url,isMainFrame)=>{if(isMainFrame)add(item,'navigation_log',{type:'navigate-in-page',url:safeUrl(url),at:new Date().toISOString()})});
    contents.on('console-message',(_event,...args)=>{
      const details=typeof args[0]==='object'?args[0]:{level:args[0],message:args[1],lineNumber:args[2],sourceId:args[3]};
      add(item,'console_log',{level:details.level??'info',message:safeText(details.message),line:details.lineNumber||0,source:safeUrl(details.sourceId),at:new Date().toISOString()});
    });
    contents.on('destroyed',()=>{owners.delete(contents.id);tracked.delete(contents.id);reading.delete(contents.id);for(const [id,entry]of requests)if(entry.contentsId===contents.id)requests.delete(id)});
  }
  function beforeRequest(details) {
    const item=owners.get(details.webContentsId);
    if(!item||!/^https?:|^wss?:/.test(details.url))return;
    if(requests.size>2000)requests.delete(requests.keys().next().value);
    requests.set(details.id,{item,contentsId:details.webContentsId,started:Date.now(),url:safeUrl(details.url),method:details.method,resourceType:details.resourceType});
  }
  function complete(details,error=false) {
    const entry=requests.get(details.id);
    if(!entry)return;requests.delete(details.id);
    add(entry.item,'network_log',{url:entry.url,method:entry.method,resourceType:entry.resourceType,status:details.statusCode||null,error:error?safeText(details.error):'',durationMs:Math.max(0,Date.now()-entry.started),at:new Date().toISOString()});
  }
  async function collect(item) {
    const contents=item.view.webContents;
    await Promise.all([...tracked].filter(([id])=>owners.get(id)===item).map(([,page])=>drain(page,item)));
    if(item.selectedElement)item.evidence.fingerprint_log.selectedElement=item.selectedElement;
    const viewport=item.emulation?JSON.parse(item.emulation):{};
    return JSON.parse(JSON.stringify({schemaVersion:1,capturedAt:new Date().toISOString(),available:true,url:safeUrl(contents.isDestroyed()?item.requestedUrl:contents.getURL()),title:contents.isDestroyed()?'':contents.getTitle(),viewport,...item.evidence}));
  }
  return {track,beforeRequest,completed:details=>complete(details),failed:details=>complete(details,true),collect,
    async reset(item){
      item.evidenceGeneration=(item.evidenceGeneration||0)+1;
      await Promise.all([...tracked].filter(([id])=>owners.get(id)===item).map(async([,page])=>{try{if(!page.isDestroyed())await page.executeJavaScriptInIsolatedWorld(WORLD,[{code:'('+readInputRecorder.toString()+')()'}])}catch{}}));
      item.evidence={navigation_log:[],input_log:[],network_log:[],console_log:[],fingerprint_log:{}};delete item.selectedElement;
      for(const [id,entry]of requests)if(entry.item===item)requests.delete(id);
    },
    counts:item=>Object.fromEntries(['navigation','input','network','console'].map(kind=>[kind,item.evidence?.[kind+'_log']?.length||0])),
    async clear(item,kind='all'){await collect(item);for(const key of ['navigation_log','input_log','network_log','console_log'])if(kind==='all'||key===kind||key===kind+'_log')item.evidence[key]=[];return collect(item)},
    async pick(item){const result=await item.view.webContents.executeJavaScriptInIsolatedWorld(WORLD,[{code:'('+selectElement.toString()+')()'}]);if(result)item.selectedElement=result;return result},
    close(){clearInterval(timer);owners.clear();tracked.clear();reading.clear();requests.clear()}
  };
}
module.exports={createEvidenceRecorder,safeUrl,safeText,LIMIT};
