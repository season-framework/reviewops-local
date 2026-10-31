'use strict';
const crypto = require('node:crypto');
const fail = (message, code = 'INVALID_REQUEST') => { throw Object.assign(new Error(message), {code}); };
const id = (value, label) => { if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value))fail(`${label}가 올바르지 않습니다.`);return value; };
const number = (value, label, max=100000) => { if(!Number.isFinite(value)||Math.abs(value)>max)fail(`${label}가 올바르지 않습니다.`);return value; };
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
async function command(contents,method,params={}) {
  if(contents.isDestroyed())fail('화면이 닫혔습니다.','TARGET_CLOSED');
  if(!contents.debugger.isAttached())contents.debugger.attach('1.3');
  return contents.debugger.sendCommand(method,params);
}
const snapshotScript = `(() => {
  const visible = element => { const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.visibility!=='hidden'&&s.display!=='none'; };
  const elements=[...document.querySelectorAll('button,a,input,textarea,select,[role],[contenteditable="true"]')].filter(visible).slice(0,400).map(element=>{
    const r=element.getBoundingClientRect();return {tag:element.tagName.toLowerCase(),role:element.getAttribute('role')||'',label:element.getAttribute('aria-label')||element.labels?.[0]?.innerText||element.getAttribute('title')||'',text:(element.innerText||'').slice(0,300),type:element.type||'',value:element.type==='password'?'':String(element.value||'').slice(0,2000),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  });
  return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,30000),elements,viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY}};
})()`;

async function capture(record,contents,browserId,nativeImage) {
  const image=await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  if(image.isEmpty())fail('화면을 촬영하지 못했습니다.','CAPTURE_FAILED');
  let result=image;
  // The website is a child native view, absent from a host capture. Composite
  // its actual pixels at the same clipped position, preserving application UI.
  if(!browserId&&nativeImage){
    const size=image.getSize(),[width,height]=record.host.getContentSize();
    const sx=size.width/width,sy=size.height/height,pixels=image.toBitmap();
    for(const target of record.browsers?.automationTargets()||[]){
      if(!target.visible||!target.bounds||!target.clip)continue;
      const shot=await target.contents.capturePage(undefined,{stayHidden:true,stayAwake:true});
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
  const viewport=await contents.executeJavaScript('({width:innerWidth,height:innerHeight})');
  return {mimeType:'image/png',data:png.toString('base64'),width:png.readUInt32BE(16),height:png.readUInt32BE(20),viewport,imageToCss:{scaleX:viewport.width/png.readUInt32BE(16),scaleY:viewport.height/png.readUInt32BE(20)},capturedAt:new Date().toISOString()};
}
function createQaAutomation({getProject,getWindow,openWindow,nativeImage,now=Date.now,sessionTimeoutMs=30*60*1000,operationTimeoutMs=20000}) {
  const sessions=new Map(),projects=new Map(),quarantined=new Set();
  let closed=false;
  const binding=session=>({sessionId:session.id,projectId:session.projectId,windowId:session.windowId,clientId:session.clientId});
  function forget(session){const record=session.windowId&&getWindow(session.windowId);if(record)record.qaActive=quarantined.has(record.id);sessions.delete(session.id);if(projects.get(session.projectId)===session)projects.delete(session.projectId);}
  function prune(){for(const windowId of quarantined){const record=getWindow(windowId);if(!record||record.host.isDestroyed())quarantined.delete(windowId);}for(const session of sessions.values()){const record=session.windowId&&getWindow(session.windowId);if(session.windowId&&(!record||record.host.isDestroyed())||!session.active&&now()-session.touched>sessionTimeoutMs)forget(session);}}
  function check(session,payload){
    if(!session||session.projectId!==payload.projectId||session.windowId!==payload.windowId)fail('프로젝트와 창에 연결된 QA 세션을 지정하십시오.','SESSION_MISMATCH');
    if(now()-session.touched>sessionTimeoutMs&&!session.active){forget(session);fail('QA 연결 시간이 만료되었습니다. 다시 연결하십시오.','SESSION_EXPIRED');}
    const record=getWindow(session.windowId);
    if(!getProject(session.projectId)||!record||record.projectId!==session.projectId||record.host.isDestroyed()){forget(session);fail('연결한 프로젝트 창이 닫혔습니다.','TARGET_CLOSED');}
    session.touched=now();return record;
  }
  async function open(payload){
    const projectId=id(payload.projectId,'프로젝트 ID'),clientId=id(payload.clientId,'클라이언트 ID');
    if(payload.reviewId!==undefined)id(payload.reviewId,'리뷰 ID');
    if(!getProject(projectId))fail('프로젝트를 찾을 수 없습니다.','NOT_FOUND');
    prune();
    if([...quarantined].some(windowId=>getWindow(windowId)?.projectId===projectId))fail('응답이 중단된 프로젝트 창을 닫고 다시 연결하십시오.','QA_TARGET_UNAVAILABLE');
    let session=projects.get(projectId);
    if(session){
      if(session.clientId!==clientId)fail('다른 QA가 이 프로젝트 창에 연결되어 있습니다. 연결을 해제한 뒤 다시 시도하십시오.','PROJECT_BUSY');
      await session.opening;check(session,{projectId,windowId:session.windowId});
      if(payload.reviewId!==undefined&&payload.reviewId!==session.reviewId)fail('연결된 QA의 리뷰가 다릅니다. 연결을 해제한 뒤 대상 리뷰로 다시 연결하십시오.','REVIEW_MISMATCH');
      return binding(session);
    }
    if(sessions.size>=64)fail('QA 연결이 많습니다. 사용하지 않는 연결을 해제하십시오.','SESSION_LIMIT');
    session={id:crypto.randomUUID(),projectId,clientId,reviewId:payload.reviewId||'',windowId:null,touched:now(),queue:Promise.resolve(),active:1};
    sessions.set(session.id,session);projects.set(projectId,session);
    session.opening=(async()=>{
      try{const record=await openWindow(payload);if(!record||record.projectId!==projectId||record.host.isDestroyed())fail('연결할 프로젝트 창이 닫혔습니다.','TARGET_CLOSED');if(closed)fail('QA 연결이 종료되었습니다.','CLOSED');session.windowId=record.id;record.qaActive=true;session.touched=now();return binding(session);}
      catch(error){forget(session);throw error;}finally{session.active--;}
    })();
    return session.opening;
  }
  async function perform(action,payload,session){
    const record=check(session,payload),metadata=binding(session);
    const assertActive=()=>{if(session.failed)fail('QA 응답 시간이 초과되었습니다.','QA_TIMEOUT');};
    if(action==='release'){forget(session);return {...metadata,released:true};}
    const targets=record.browsers?.automationTargets()||[];
    if(payload.browserId!==undefined)id(payload.browserId,'검사 화면 ID');
    const target=payload.browserId&&targets.find(item=>item.browserId===payload.browserId);
    if(payload.browserId&&!target)fail('이 프로젝트 창의 검사 화면을 지정하십시오.','TARGET_MISMATCH');
    const contents=target?.contents||record.host.webContents;
    const send=async(method,params)=>{if(session.failed)fail('QA 응답 시간이 초과되었습니다.','QA_TIMEOUT');const result=await command(contents,method,params);if(session.failed)fail('QA 응답 시간이 초과되었습니다.','QA_TIMEOUT');return result;};
    if(target?.ready)await target.ready;
    assertActive();
    const inputScale=target?.inputScale||contents.getZoomFactor?.()||1;
    if(contents.isDestroyed())fail('검사 화면이 닫혔습니다.','TARGET_CLOSED');
    if(payload.browserId)metadata.browserId=payload.browserId;
    if(action==='state')return {...metadata,...await contents.executeJavaScript(snapshotScript),browsers:targets.map(({browserId,url,title,visible,bounds,clip})=>{const zoom=record.host.webContents.getZoomFactor?.()||1;const css=rect=>rect&&Object.fromEntries(Object.entries(rect).map(([key,value])=>[key,value/zoom]));return {browserId,url,title,visible,bounds:css(bounds)||null,clip:css(clip)||null};})};
    if(action==='capture')return {...metadata,...await capture(record,contents,payload.browserId,nativeImage)};
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
      if(didClose)forget(session);return {...metadata,closed:didClose};
    }
    if(action==='reload'){
      if(!payload.browserId&&await contents.executeJavaScript('document.documentElement.dataset.reviewopsDirty === "true"'))fail('작성 중인 내용을 저장한 뒤 화면을 다시 불러오십시오.','UNSAVED_INPUT');
      assertActive();contents.reload();await waitForLoad(contents);return {...metadata,reloaded:true};
    }
    if(action==='navigate'){
      if(!payload.browserId)fail('주소 이동은 검사 화면 ID가 필요합니다.');
      assertActive();if(target.navigate)await target.navigate(payload.url);else {
        await record.browsers.dispatch('browser.navigate',{id:payload.browserId,url:payload.url});
        await waitForLoad(contents);
        const state=await record.browsers.dispatch('browser.state',{id:payload.browserId});
        if(state.error)fail(state.error,'NAVIGATION_FAILED');
      }
      return {...metadata,url:contents.getURL()};
    }
    if(action==='click'){
      const x=number(payload.x,'가로 위치')*inputScale,y=number(payload.y,'세로 위치')*inputScale,button=payload.button||'left',clickCount=payload.clickCount||1;
      if(x<0||y<0||!['left','right'].includes(button)||![1,2].includes(clickCount))fail('클릭할 위치와 버튼을 지정하십시오.');
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      for(let count=1;count<=clickCount;count++){
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button,clickCount:count});
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button,clickCount:count});
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
      await send('Input.dispatchKeyEvent',{type:'keyDown',...params});
      await send('Input.dispatchKeyEvent',{type:'keyUp',...params});
    }else if(action==='scroll'){
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:number(payload.x,'가로 위치')*inputScale,y:number(payload.y,'세로 위치')*inputScale,deltaX:number(payload.deltaX??0,'가로 이동')*inputScale,deltaY:number(payload.deltaY,'세로 이동')*inputScale});
    }else fail('지원하지 않는 QA 요청입니다.','UNKNOWN_ACTION');
    return {...metadata,applied:true};
  }
  function handle(action,payload={}){
    if(closed)return Promise.reject(Object.assign(new Error('QA 연결이 종료되었습니다.'),{code:'CLOSED'}));
    if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('JSON 객체로 요청하십시오.');
    action=action.replace(/^automation\.qa\./,'');
    if(action==='open')return open(payload);
    id(payload.sessionId,'QA 세션 ID');id(payload.projectId,'프로젝트 ID');id(payload.windowId,'창 ID');
    const session=sessions.get(payload.sessionId);check(session,payload);
    if(session.failed&&action!=='release')fail('응답이 중단된 프로젝트 창을 닫고 다시 연결하십시오.','QA_TARGET_UNAVAILABLE');
    // Serialize only operations on the same project. Different windows never
    // wait for one another's input, capture, navigation, or page loading.
    session.active++;
    const result=session.queue.then(async()=>{
      if(sessions.get(session.id)!==session)fail('QA 연결이 해제되었습니다.','SESSION_EXPIRED');
      if(session.failed&&action!=='release')fail('응답이 중단된 프로젝트 창을 닫고 다시 연결하십시오.','QA_TARGET_UNAVAILABLE');
      let timer;
      try{return await Promise.race([perform(action,payload,session),new Promise((_,reject)=>{timer=setTimeout(()=>{session.failed=true;quarantined.add(session.windowId);reject(Object.assign(new Error('QA 응답 시간이 초과되었습니다. 프로젝트 창을 닫고 다시 연결하십시오.'),{code:'QA_TIMEOUT'}));},operationTimeoutMs);})]);}
      finally{clearTimeout(timer);}
    });
    session.queue=result.catch(()=>{});
    return result.finally(()=>{session.active--;session.touched=now();});
  }
  return {handle,close(){closed=true;sessions.clear();projects.clear();quarantined.clear();}};
}
module.exports={createQaAutomation,waitForLoad};
