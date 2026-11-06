'use strict';
const crypto = require('node:crypto');
const fail = (message, code = 'INVALID_REQUEST') => { throw Object.assign(new Error(message), {code}); };
const id = (value, label) => { if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value))fail(`${label}가 올바르지 않습니다.`);return value; };
const number = (value, label, max=100000) => { if(!Number.isFinite(value)||Math.abs(value)>max)fail(`${label}가 올바르지 않습니다.`);return value; };
const DOCUMENT_CONTRACT='observed-web-document-v1';
const documentId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function documentRequest(payload){
  const fields={state:[],capture:[],click:['x','y','button','clickCount'],type:['text'],key:['key','modifiers'],scroll:['x','y','deltaX','deltaY']};
  if(!Object.hasOwn(fields,payload.operation))fail('Choose a supported document operation.');
  const input=!['state','capture'].includes(payload.operation),allowed=['sessionId','projectId','windowId','browserId','operation',...fields[payload.operation],...(input?['documentId']:[])];
  if(Object.keys(payload).some(key=>!allowed.includes(key)))fail('Unexpected document operation field.');
  const value={operation:payload.operation};
  for(const key of ['sessionId','projectId','windowId','browserId'])value[key]=id(payload[key],key);
  if(input){if(!documentId(payload.documentId))fail('Use the documentId returned by a document observation.');value.documentId=payload.documentId;}
  for(const key of fields[value.operation])if(Object.hasOwn(payload,key))value[key]=payload[key];
  if(['click','scroll'].includes(value.operation)){
    for(const key of ['x','y'])if(number(value[key],key,20000)<0)fail('Input coordinates must be nonnegative.');
  }
  if(value.operation==='click'&&(!['left','right'].includes(value.button??'left')||![1,2].includes(value.clickCount??1)))fail('Invalid click button or count.');
  if(value.operation==='scroll'){number(value.deltaY,'deltaY',20000);if(value.deltaX!==undefined)number(value.deltaX,'deltaX',20000);}
  if(value.operation==='type'&&(typeof value.text!=='string'||value.text.length>100000||value.text.includes('\0')))fail('Invalid document text.');
  if(value.operation==='key'){
    if(typeof value.key!=='string'||!value.key||value.key.length>30)fail('Invalid document key.');
    if(value.modifiers!==undefined&&(!Array.isArray(value.modifiers)||value.modifiers.length>4||value.modifiers.some(key=>!['Alt','Control','Meta','Shift'].includes(key))))fail('Invalid document modifiers.');
    if(value.modifiers)value.modifiers=[...value.modifiers];
  }
  return Object.freeze(value);
}
function waitForLoad(contents) {
  if(contents.isDestroyed())return Promise.reject(new Error('화면이 닫혔습니다.'));
  if(!contents.isLoadingMainFrame())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);contents.removeListener('did-finish-load',done);contents.removeListener('destroyed',closed);contents.removeListener('did-fail-load',failed);};
    const done=()=>{cleanup();resolve();},closed=()=>{cleanup();reject(new Error('화면이 닫혔습니다.'));};
    const failed=(_event,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){cleanup();reject(new Error(description));}};
    const timer=setTimeout(()=>{cleanup();reject(new Error('화면을 불러오는 시간이 초과되었습니다.'));},15000);
    contents.once('did-finish-load',done);contents.once('destroyed',closed);contents.on('did-fail-load',failed);
  });
}
// Coordinates and input stay inside one Chromium target. Neither the OS cursor
// nor BrowserWindow.focus() participates in a QA operation.
async function command(contents,method,params={},beforeSend) {
  if(contents.isDestroyed())fail('화면이 닫혔습니다.','TARGET_CLOSED');
  if(!contents.debugger.isAttached())contents.debugger.attach('1.3');
  beforeSend?.();
  return contents.debugger.sendCommand(method,params);
}
const snapshotScript = `(() => {
  const visible = element => { const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.visibility!=='hidden'&&s.display!=='none'; };
  const elements=[...document.querySelectorAll('button,a,input,textarea,select,[role],[contenteditable="true"]')].filter(visible).slice(0,400).map(element=>{
    const r=element.getBoundingClientRect();return {tag:element.tagName.toLowerCase(),role:element.getAttribute('role')||'',label:element.getAttribute('aria-label')||element.labels?.[0]?.innerText||element.getAttribute('title')||'',text:(element.innerText||'').slice(0,300),type:element.type||'',value:element.type==='password'?'':String(element.value||'').slice(0,2000),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  });
  return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,30000),elements,viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY}};
})()`;

async function capture(record,contents,browserId,nativeImage,guard=()=>{}) {
  guard();const image=await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});guard();
  if(image.isEmpty())fail('화면을 촬영하지 못했습니다.','CAPTURE_FAILED');
  let result=image;
  // The website is a child native view, absent from a host capture. Composite
  // its actual pixels at the same clipped position, preserving application UI.
  if(!browserId&&nativeImage){
    const size=image.getSize(),[width,height]=record.host.getContentSize();
    const sx=size.width/width,sy=size.height/height,pixels=image.toBitmap();
    for(const target of record.browsers?.automationTargets()||[]){
      if(!target.visible||!target.bounds||!target.clip)continue;
      guard();const shot=await target.contents.capturePage(undefined,{stayHidden:true,stayAwake:true});guard();
      if(shot.isEmpty())continue;
      const source=shot.toBitmap(),sourceSize=shot.getSize(),bounds=target.bounds,clip=target.clip;
      const left=Math.max(0,Math.ceil(Math.max(bounds.x,clip.x)*sx)),top=Math.max(0,Math.ceil(Math.max(bounds.y,clip.y)*sy));
      const right=Math.min(size.width,Math.floor(Math.min(bounds.x+bounds.width,clip.x+clip.width)*sx));
      const bottom=Math.min(size.height,Math.floor(Math.min(bounds.y+bounds.height,clip.y+clip.height)*sy));
      for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
        const px=Math.min(sourceSize.width-1,Math.max(0,Math.floor((x/sx-bounds.x)/bounds.width*sourceSize.width)));
        const py=Math.min(sourceSize.height-1,Math.max(0,Math.floor((y/sy-bounds.y)/bounds.height*sourceSize.height)));
        source.copy(pixels,(y*size.width+x)*4,(py*sourceSize.width+px)*4,(py*sourceSize.width+px)*4+4);
      }
    }
    result=nativeImage.createFromBitmap(pixels,{width:size.width,height:size.height,scaleFactor:1});
  }
  const png=result.toPNG();
  guard();const viewport=await contents.executeJavaScript('({width:innerWidth,height:innerHeight})');guard();
  return {mimeType:'image/png',data:png.toString('base64'),width:png.readUInt32BE(16),height:png.readUInt32BE(20),viewport,imageToCss:{scaleX:viewport.width/png.readUInt32BE(16),scaleY:viewport.height/png.readUInt32BE(20)},capturedAt:new Date().toISOString()};
}
function createQaAutomation({getProject,getWindow,openWindow,nativeImage,onActiveChange=()=>{},now=Date.now,sessionTimeoutMs=30*60*1000,operationTimeoutMs=20000}) {
  const sessions=new Map(),projects=new Map(),quarantined=new Set(),documents=new Map();
  let closed=false;
  const expiry=setInterval(()=>{if(!closed)prune();},Math.max(1,Math.min(sessionTimeoutMs,60000)));expiry.unref?.();
  const binding=session=>({sessionId:session.id,projectId:session.projectId,windowId:session.windowId,clientId:session.clientId});
  function forget(session){const record=session.windowId&&getWindow(session.windowId);if(record){onActiveChange(record,quarantined.has(record.id));record.qaActive=quarantined.has(record.id);}sessions.delete(session.id);if(projects.get(session.projectId)===session)projects.delete(session.projectId);}
  function prune(){for(const windowId of quarantined){const record=getWindow(windowId);if(!record||record.host.isDestroyed())quarantined.delete(windowId);}for(const session of sessions.values()){const record=session.windowId&&getWindow(session.windowId);if(session.windowId&&(!record||record.host.isDestroyed())||!session.active&&now()-session.touched>sessionTimeoutMs)forget(session);}}
  function check(session,payload){
    if(!session||session.projectId!==payload.projectId||session.windowId!==payload.windowId)fail('프로젝트와 창에 연결된 QA 세션을 지정하십시오.','SESSION_MISMATCH');
    if(now()-session.touched>sessionTimeoutMs&&!session.active){forget(session);fail('QA 연결 시간이 만료되었습니다. 다시 연결하십시오.','SESSION_EXPIRED');}
    const record=getWindow(session.windowId);
    if(!getProject(session.projectId)||!record||record.projectId!==session.projectId||record.host.isDestroyed()){forget(session);fail('연결한 프로젝트 창이 닫혔습니다.','TARGET_CLOSED');}
    session.touched=now();return record;
  }
  function connectionStatus(payload={}){
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['projectId','binding'].includes(key)))fail('Invalid QA connection status request.');
    const projectId=id(payload.projectId,'projectId'),hasBinding=Object.hasOwn(payload,'binding');
    if(hasBinding){
      const value=payload.binding;
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||Object.keys(value).some(key=>!['sessionId','projectId','windowId'].includes(key)))fail('Invalid recorded QA binding.');
      for(const key of ['sessionId','projectId','windowId'])id(value[key],key);
      if(value.projectId!==projectId)fail('Recorded QA binding belongs to another project.','TARGET_MISMATCH');
    }
    const result={projectId,availability:'unavailable',bindingState:hasBinding?'unavailable':'not_supplied'};
    if(closed||!getProject(projectId))return result;
    // Peek only: check/prune renew or forget leases and must not run here.
    const current=projects.get(projectId),record=current?.windowId?getWindow(current.windowId):null;
    const remembered=hasBinding&&sessions.get(payload.binding.sessionId);
    const matched=Boolean(remembered&&remembered===current&&remembered.projectId===projectId&&remembered.windowId===payload.binding.windowId);
    const quarantinedHere=[...quarantined].some(windowId=>{const value=getWindow(windowId);return value?.projectId===projectId&&!value.host.isDestroyed();});
    const expired=current&&!current.active&&now()-current.touched>sessionTimeoutMs;
    if(quarantinedHere)result.availability='quarantined';
    else if(!current)result.availability=hasBinding?'unavailable':'available';
    else if(!matched)result.availability='busy';
    else if(!current.windowId)result.availability='busy';
    else if(!record||record.projectId!==projectId)result.availability='unavailable';
    else if(record.host.isDestroyed()||expired)result.availability='available';
    else result.availability=current.failed?'quarantined':'busy';
    if(!matched)return result;
    if(remembered.failed)result.bindingState=remembered.failureKind==='document-release'?'unavailable':'timed_out';
    else if(!record||record.projectId!==projectId)result.bindingState='unavailable';
    else if(record.host.isDestroyed())result.bindingState='target_closed';
    else if(expired)result.bindingState='expired';
    else result.bindingState='attached';
    return result;
  }
  // Private cleanup proof: unlike UI availability, this reads exact lease
  // membership without pruning, touching, reconnecting or selecting a window.
  function leaseStatus(payload){
    const keys=['clientId','sessionId','projectId','windowId'];
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==keys.length||Object.keys(payload).some(key=>!keys.includes(key)))fail('Invalid original QA lease status request.');
    for(const key of keys)id(payload[key],key);
    const session=sessions.get(payload.sessionId),leaseState=closed?'unknown':!session?'absent':keys.every(key=>(key==='sessionId'?session.id:session[key])===payload[key])?'attached':'unknown';
    return {...payload,leaseState};
  }
  async function open(payload,guard){
    guard();
    const projectId=id(payload.projectId,'프로젝트 ID'),clientId=id(payload.clientId,'클라이언트 ID');
    if(payload.reviewId!==undefined)id(payload.reviewId,'리뷰 ID');
    if(!getProject(projectId))fail('프로젝트를 찾을 수 없습니다.','NOT_FOUND');
    prune();
    if([...quarantined].some(windowId=>getWindow(windowId)?.projectId===projectId))fail('응답이 중단된 프로젝트 창을 닫고 다시 연결하십시오.','QA_TARGET_UNAVAILABLE');
    let session=projects.get(projectId);
    if(session){
      if(session.clientId!==clientId)fail('다른 QA가 이 프로젝트 창에 연결되어 있습니다. 연결을 해제한 뒤 다시 시도하십시오.','PROJECT_BUSY');
      await session.opening;guard();check(session,{projectId,windowId:session.windowId});
      if(payload.reviewId!==undefined&&payload.reviewId!==session.reviewId)fail('연결된 QA의 리뷰가 다릅니다. 연결을 해제한 뒤 대상 리뷰로 다시 연결하십시오.','REVIEW_MISMATCH');
      return binding(session);
    }
    if(sessions.size>=64)fail('QA 연결이 많습니다. 사용하지 않는 연결을 해제하십시오.','SESSION_LIMIT');
    session={id:crypto.randomUUID(),projectId,clientId,reviewId:payload.reviewId||'',windowId:null,touched:now(),queue:Promise.resolve(),active:1};
    sessions.set(session.id,session);projects.set(projectId,session);
    session.opening=(async()=>{
      try{guard();const record=await openWindow(payload,guard);guard();if(!record||record.projectId!==projectId||record.host.isDestroyed())fail('연결할 프로젝트 창이 닫혔습니다.','TARGET_CLOSED');if(closed)fail('QA 연결이 종료되었습니다.','CLOSED');session.windowId=record.id;onActiveChange(record,true);record.qaActive=true;session.touched=now();return binding(session);}
      catch(error){forget(session);throw error;}finally{session.active--;}
    })();
    return session.opening;
  }
  function watchDocument(contents){
    if(documents.has(contents))return documents.get(contents);
    const state={id:crypto.randomUUID(),tokens:new Map(),dead:contents.isDestroyed(),crashed:Boolean(contents.isCrashed?.())};
    const rotate=()=>{state.id=crypto.randomUUID();state.tokens.clear();};
    const navigating=(details,_url,_sameDocument,isMainFrame)=>{if(typeof details?.isMainFrame==='boolean'?details.isMainFrame:isMainFrame===true)rotate();};
    const crashed=()=>{state.crashed=true;rotate();};
    const loaded=()=>{if(!state.dead&&!contents.isCrashed?.())state.crashed=false;};
    const destroyed=()=>{state.dead=true;rotate();state.detach();documents.delete(contents);};
    const listeners=[['did-start-navigation',navigating],['render-process-gone',crashed],['did-finish-load',loaded],['destroyed',destroyed]];
    state.detach=()=>{for(const [event,listener]of listeners)contents.removeListener(event,listener);};
    for(const [event,listener]of listeners)contents.on(event,listener);
    documents.set(contents,state);return state;
  }
  function documentTarget(payload,session){
    const record=check(session,payload),target=record.browsers?.automationTargets().find(item=>item.browserId===payload.browserId);
    if(!target)fail('Select an existing web surface in this project.','TARGET_MISMATCH');
    const state=watchDocument(target.contents),scope=[payload.projectId,payload.windowId,payload.browserId].join('\0');
    if(!state.tokens.has(scope))state.tokens.set(scope,crypto.randomUUID());
    const entry={record,contents:target.contents,state,scope,generation:state.id,id:state.tokens.get(scope),ready:target.ready,scale:target.inputScale||target.contents.getZoomFactor?.()||1};
    if(payload.documentId!==undefined&&payload.documentId!==entry.id)fail('The observed document changed before input. Read this same surface again.','QA_DOCUMENT_STALE');
    assertDocument(payload,session,entry);return entry;
  }
  function assertDocument(payload,session,entry){
    if(closed||sessions.get(session.id)!==session)fail('The QA session is no longer attached.','SESSION_EXPIRED');
    if(session.failed)fail('This QA window is quarantined. Close and reopen it before further QA.','QA_TARGET_UNAVAILABLE');
    const record=check(session,payload),target=record.browsers?.automationTargets().find(item=>item.browserId===payload.browserId);
    if(record!==entry.record||!target||target.contents!==entry.contents||entry.state.dead||entry.state.id!==entry.generation||entry.state.tokens.get(entry.scope)!==entry.id||payload.documentId!==undefined&&payload.documentId!==entry.id)fail('The observed document changed before input. Read this same surface again.','QA_DOCUMENT_STALE');
    if(target.documentReady!==true||entry.state.crashed||entry.contents.isDestroyed()||entry.contents.isCrashed?.()||entry.contents.isLoadingMainFrame())fail('The selected web document is not ready. Observe it after loading or recovery.','QA_DOCUMENT_NOT_READY');
    if(target.ready!==entry.ready||(target.inputScale||entry.contents.getZoomFactor?.()||1)!==entry.scale)fail('The selected web surface changed readiness or scale. Observe it again.','QA_DOCUMENT_NOT_READY');
  }
  async function performDocument(payload,session,entry,guard){
    let deliveryBegun=false,release,primary,cleanupFailure,result;
    entry.deliveryBegun=false;
    const fence=()=>{guard();assertDocument(payload,session,entry);};
    const send=async(method,params,matchingRelease)=>{
      fence();
      const value=await command(entry.contents,method,params,()=>{
        // Attach can synchronously change the document. Fence again immediately
        // before the first actual Input.* invocation, including mouseMoved.
        fence();deliveryBegun=true;entry.deliveryBegun=true;if(matchingRelease)release={method,params:matchingRelease};
      });fence();return value;
    };
    const matchingRelease=async()=>{
      if(!release)return;
      const pending=release;release=null;
      try{
        // Release only on the original live contents, even if its document changed.
        // No membership lookup may replace the object selected before press/down.
        if(entry.state.dead||entry.state.crashed||entry.contents.isDestroyed()||entry.contents.isCrashed?.()||!entry.contents.debugger.isAttached())fail('The original pressed surface or debugger is no longer live.','QA_RELEASE_TARGET_GONE');
        await entry.contents.debugger.sendCommand(pending.method,pending.params);
      }catch(error){
        cleanupFailure=error;session.documentReleaseFailure=error;session.failed=true;session.failureKind??='document-release';quarantined.add(entry.record.id);
        // A disconnected controller may already have released the lease while
        // the original release command was pending. Keep that same window scoped.
        if(getWindow(entry.record.id)===entry.record&&!entry.record.host.isDestroyed()){
          entry.record.qaActive=true;try{onActiveChange(entry.record,true);}catch(failure){session.documentQuarantineFailure=failure;}
        }
      }
    };
    try{
      fence();if(entry.ready){await entry.ready;fence();}
      const metadata={...binding(session),browserId:payload.browserId,contract:DOCUMENT_CONTRACT,documentId:entry.id};
      if(payload.operation==='state'){
        const value=await entry.contents.executeJavaScript(snapshotScript);fence();result={...value,...metadata};
      }else if(payload.operation==='capture'){
        const image=await entry.contents.capturePage(undefined,{stayHidden:true,stayAwake:true});fence();
        if(image.isEmpty())fail('The selected document could not be captured.','CAPTURE_FAILED');
        const png=image.toPNG(),viewport=await entry.contents.executeJavaScript('({width:innerWidth,height:innerHeight})');fence();
        result={...metadata,mimeType:'image/png',data:png.toString('base64'),width:png.readUInt32BE(16),height:png.readUInt32BE(20),viewport,imageToCss:{scaleX:viewport.width/png.readUInt32BE(16),scaleY:viewport.height/png.readUInt32BE(20)},capturedAt:new Date().toISOString()};
      }else{
        const x=payload.x*entry.scale,y=payload.y*entry.scale;
        if(payload.operation==='type')await send('Input.insertText',{text:payload.text});
        else if(payload.operation==='scroll')await send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:(payload.deltaX??0)*entry.scale,deltaY:payload.deltaY*entry.scale});
        else if(payload.operation==='click'){
          const button=payload.button??'left';await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
          for(let count=1;count<=(payload.clickCount??1);count++){
            try{await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button,clickCount:count},{type:'mouseReleased',x,y,button,clickCount:count});}
            finally{await matchingRelease();}
            if(cleanupFailure)throw cleanupFailure;fence();
          }
        }else if(payload.operation==='key'){
          const values={Alt:1,Control:2,Meta:4,Shift:8},mask=(payload.modifiers||[]).reduce((value,key)=>value|values[key],0),key=payload.key;
          const keys={Enter:13,Tab:9,Backspace:8,Delete:46,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34,' ':32};
          const code=keys[key]||(/^[a-z0-9]$/i.test(key)?key.toUpperCase().charCodeAt(0):0);if(!code)fail('Unsupported document key.');
          const params={key,modifiers:mask,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,...(key==='Enter'?{text:'\r'}:{})};
          const down={type:'keyDown',...params};
          // Editing belongs to the original down event, never its cleanup release.
          if(process.platform==='darwin'&&mask===4&&/^[aA]$/.test(key))down.commands=['selectAll'];
          try{await send('Input.dispatchKeyEvent',down,{type:'keyUp',...params});}
          finally{await matchingRelease();}
          if(cleanupFailure)throw cleanupFailure;fence();
        }
        result={...metadata,applied:true};
      }
      fence();
    }catch(error){primary=error;}
    finally{await matchingRelease();}
    if(primary||cleanupFailure){
      if(!deliveryBegun)throw primary||cleanupFailure;
      const describe=error=>`[${error.code||'REQUEST_FAILED'}] ${String(error.message||'Request failed').slice(0,240)}`;
      const error=Object.assign(new Error(`Input may have applied. Observe the same surface and do not replay. Primary: ${describe(primary||cleanupFailure)}${cleanupFailure?`; matching release failed: ${describe(cleanupFailure)}`:''}`),{code:'QA_DOCUMENT_CHANGED_AFTER_INPUT',cause:primary||cleanupFailure,inputMayHaveApplied:true});
      if(cleanupFailure)error.cleanupError=cleanupFailure;throw error;
    }
    return result;
  }
  async function perform(action,payload,session,guard){
    const record=check(session,payload),metadata=binding(session);
    const assertActive=()=>{guard();if(session.failed)fail('QA 응답 시간이 초과되었습니다.','QA_TIMEOUT');};
    guard();
    if(action==='release'){forget(session);return {...metadata,released:true};}
    assertActive();
    const targets=record.browsers?.automationTargets()||[];
    if(payload.browserId!==undefined)id(payload.browserId,'검사 화면 ID');
    const target=payload.browserId&&targets.find(item=>item.browserId===payload.browserId);
    if(payload.browserId&&!target)fail('이 프로젝트 창의 검사 화면을 지정하십시오.','TARGET_MISMATCH');
    const contents=target?.contents||record.host.webContents;
    const send=async(method,params,begun)=>{assertActive();const result=await command(contents,method,params,()=>{assertActive();begun?.();});assertActive();return result;};
    const releaseInput=async(method,params)=>{
      try{if(contents.isDestroyed()||!contents.debugger.isAttached())fail('The original pressed QA surface is unavailable.','QA_RELEASE_TARGET_GONE');await contents.debugger.sendCommand(method,params);}
      catch(error){session.failed=true;session.failureKind??='document-release';quarantined.add(record.id);throw Object.assign(error,{inputMayHaveApplied:true});}
    };
    if(target?.ready)await target.ready;
    assertActive();
    const inputScale=target?.inputScale||contents.getZoomFactor?.()||1;
    if(contents.isDestroyed())fail('검사 화면이 닫혔습니다.','TARGET_CLOSED');
    if(payload.browserId)metadata.browserId=payload.browserId;
    if(action==='state'){const value=await contents.executeJavaScript(snapshotScript);assertActive();return {...metadata,...value,browsers:targets.map(({browserId,url,title,visible,bounds,clip})=>{const zoom=record.host.webContents.getZoomFactor?.()||1;const css=rect=>rect&&Object.fromEntries(Object.entries(rect).map(([key,value])=>[key,value/zoom]));return {browserId,url,title,visible,bounds:css(bounds)||null,clip:css(clip)||null};})};}
    if(action==='capture'){const value=await capture(record,contents,payload.browserId,nativeImage,assertActive);assertActive();return {...metadata,...value};}
    if(action==='close'){
      if(payload.browserId)fail('창 종료는 검사 화면 ID 없이 요청하십시오.');
      const dirty=await contents.executeJavaScript('document.documentElement.dataset.reviewopsDirty === "true"');
      assertActive();
      if(dirty)fail('작성 중인 내용을 저장한 뒤 창을 닫으십시오.','UNSAVED_INPUT');
      const didClose=await new Promise(resolve=>{
        let timer;const finish=value=>{clearTimeout(timer);record.host.removeListener?.('closed',closed);resolve(value);};
        const closed=()=>finish(true);record.host.once?.('closed',closed);
        record.host.close();if(record.host.isDestroyed())finish(true);else timer=setTimeout(()=>finish(record.host.isDestroyed()),1500);
      });
      guard();if(didClose)forget(session);return {...metadata,closed:didClose};
    }
    if(action==='reload'){
      if(!payload.browserId&&await contents.executeJavaScript('document.documentElement.dataset.reviewopsDirty === "true"'))fail('작성 중인 내용을 저장한 뒤 화면을 다시 불러오십시오.','UNSAVED_INPUT');
      assertActive();contents.reload();await waitForLoad(contents);assertActive();return {...metadata,reloaded:true};
    }
    if(action==='navigate'){
      if(!payload.browserId)fail('주소 이동은 검사 화면 ID가 필요합니다.');
      assertActive();if(target.navigate)await target.navigate(payload.url,assertActive);else {
        await record.browsers.dispatch('browser.navigate',{id:payload.browserId,url:payload.url});
        await waitForLoad(contents);
        const state=await record.browsers.dispatch('browser.state',{id:payload.browserId});
        if(state.error)fail(state.error,'NAVIGATION_FAILED');
      }
      assertActive();return {...metadata,url:contents.getURL()};
    }
    if(action==='click'){
      const x=number(payload.x,'가로 위치')*inputScale,y=number(payload.y,'세로 위치')*inputScale,button=payload.button||'left',clickCount=payload.clickCount||1;
      if(x<0||y<0||!['left','right'].includes(button)||![1,2].includes(clickCount))fail('클릭할 위치와 버튼을 지정하십시오.');
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      for(let count=1;count<=clickCount;count++){
        let pressed=false;
        try{await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button,clickCount:count},()=>{pressed=true;});}
        finally{if(pressed)await releaseInput('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button,clickCount:count});}
        assertActive();
      }
    }else if(action==='type'){
      if(typeof payload.text!=='string'||payload.text.length>100000||payload.text.includes('\0'))fail('입력할 내용을 지정하십시오.');
      await send('Input.insertText',{text:payload.text});
    }else if(action==='key'){
      if(typeof payload.key!=='string'||!payload.key||payload.key.length>30)fail('키 이름을 지정하십시오.');
      const values={Alt:1,Control:2,Meta:4,Shift:8},modifiers=payload.modifiers||[];
      if(!Array.isArray(modifiers)||modifiers.some(value=>!Object.hasOwn(values,value)))fail('보조 키가 올바르지 않습니다.');
      const mask=modifiers.reduce((result,value)=>result|values[value],0),key=payload.key;
      const keys={Enter:13,Tab:9,Backspace:8,Delete:46,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34,' ':32};
      const code=keys[key]||(/^[a-z0-9]$/i.test(key)?key.toUpperCase().charCodeAt(0):0);
      if(!code)fail('지원하지 않는 키입니다.');
      const params={key,modifiers:mask,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,...(key==='Enter'?{text:'\r'}:{})};
      let pressed=false;
      try{await send('Input.dispatchKeyEvent',{type:'keyDown',...params},()=>{pressed=true;});}
      finally{if(pressed)await releaseInput('Input.dispatchKeyEvent',{type:'keyUp',...params});}
      assertActive();
    }else if(action==='scroll'){
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:number(payload.x,'가로 위치')*inputScale,y:number(payload.y,'세로 위치')*inputScale,deltaX:number(payload.deltaX??0,'가로 이동')*inputScale,deltaY:number(payload.deltaY,'세로 이동')*inputScale});
    }else fail('지원하지 않는 QA 요청입니다.','UNKNOWN_ACTION');
    return {...metadata,applied:true};
  }
  function handle(action,payload={},guard=()=>{}){
    if(typeof guard!=='function')fail('Invalid trusted QA guard.');guard();
    if(closed)return Promise.reject(Object.assign(new Error('QA 연결이 종료되었습니다.'),{code:'CLOSED'}));
    if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('JSON 객체로 요청하십시오.');
    action=action.replace(/^automation\.qa\./,'');
    if(action==='open')return open(payload,guard);
    id(payload.sessionId,'QA 세션 ID');id(payload.projectId,'프로젝트 ID');id(payload.windowId,'창 ID');
    const session=sessions.get(payload.sessionId);check(session,payload);
    if(session.failed&&action!=='release')fail('응답이 중단된 프로젝트 창을 닫고 다시 연결하십시오.','QA_TARGET_UNAVAILABLE');
    let documentEntry;
    if(action==='document'){payload=documentRequest(payload);documentEntry=documentTarget(payload,session);}
    // Serialize only operations on the same project. Different windows never
    // wait for one another's input, capture, navigation, or page loading.
    session.active++;
    const result=session.queue.then(async()=>{
      guard();
      if(sessions.get(session.id)!==session)fail('QA 연결이 해제되었습니다.','SESSION_EXPIRED');
      if(session.failed&&action!=='release')fail('응답이 중단된 프로젝트 창을 닫고 다시 연결하십시오.','QA_TARGET_UNAVAILABLE');
      let timer;
      try{return await Promise.race([action==='document'?performDocument(payload,session,documentEntry,guard):perform(action,payload,session,guard),new Promise((_,reject)=>{timer=setTimeout(()=>{session.failed=true;session.failureKind??='timeout';quarantined.add(session.windowId);const error=Object.assign(new Error(action==='document'?'The document request timed out. Close and reopen this window; do not replay input.':'QA 응답 시간이 초과되었습니다. 프로젝트 창을 닫고 다시 연결하십시오.'),{code:'QA_TIMEOUT'});if(documentEntry)error.inputMayHaveApplied=Boolean(documentEntry.deliveryBegun);reject(error);},operationTimeoutMs);})]);}
      finally{clearTimeout(timer);}
    });
    session.queue=result.catch(()=>{});
    return result.finally(()=>{session.active--;session.touched=now();});
  }
  return {handle,connectionStatus,leaseStatus,capabilities(){return {protocolVersion:1,actions:['open','state','click','type','key','scroll','capture','navigate','reload','close','release'],bindingFields:['sessionId','projectId','windowId'],optionalBrowserId:true,documentGeneration:false};},close(){closed=true;clearInterval(expiry);for(const state of documents.values())state.detach();documents.clear();for(const session of sessions.values())forget(session);sessions.clear();projects.clear();quarantined.clear();}};
}
module.exports={createQaAutomation,waitForLoad};
