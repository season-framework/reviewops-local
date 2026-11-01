// Test-only lifecycle observations. Every wrapped method returns its original value/promise.
export async function installSessionCaptureDiagnostics(application, fixtureOrigin) {
 return application.evaluate(({app,BrowserWindow,webContents,ipcMain},{origin})=>{
  const records=[],limit=3000,started=Date.now(),observed=new Set();let operation=0;
  const emit=(type,details={})=>{if(records.length<limit)records.push({ms:Date.now()-started,type,...details});};
  const safeUrl=value=>{try{const url=new URL(value);return url.origin===origin?url.origin+url.pathname:url.protocol==='about:'?'about:blank':url.protocol==='file:'?'app-file':url.origin==='null'?'app-inline':'other';}catch{return 'unset';}};
  const state=contents=>{try{const owner=BrowserWindow.fromWebContents(contents),parent=owner?.getParentWindow?.();return {wc:contents.id,url:safeUrl(contents.getURL()),destroyed:contents.isDestroyed(),crashed:contents.isCrashed?.(),loading:contents.isLoading(),owner:owner?.id,ownerVisible:owner?.isVisible(),ownerMinimized:owner?.isMinimized(),ownerFocused:owner?.isFocused?.(),parent:parent?.id,parentVisible:parent?.isVisible(),parentFocused:parent?.isFocused?.(),osProcessId:contents.getOSProcessId?.(),debuggerAttached:contents.debugger?.isAttached(),capturing:contents.isBeingCaptured?.()};}catch{return {wc:contents.id,destroyed:true};}};
  const observePromise=(value,id,kind,contents)=>{if(value&&typeof value.then==='function')value.then(result=>emit(kind+'-fulfilled',{operation:id,...state(contents),...(kind==='capture'?{empty:result?.isEmpty?.(),size:result?.getSize?.()}: {})}),error=>emit(kind+'-rejected',{operation:id,...state(contents),message:String(error?.message||error).slice(0,250)})).catch(()=>{});return value;};
  const observe=contents=>{
   if(observed.has(contents.id))return;observed.add(contents.id);emit('wc-created',state(contents));
   for(const name of ['did-start-loading','did-stop-loading','did-finish-load','dom-ready','destroyed'])contents.on(name,()=>emit(name,state(contents)));
   contents.on('did-start-navigation',(_event,url,_inPlace,main)=>emit('navigation',{...state(contents),url:safeUrl(url),main}));
   contents.on('did-fail-load',(_event,code,description,url,main)=>emit('load-failure',{...state(contents),code,description:String(description).slice(0,160),url:safeUrl(url),main}));
   contents.on('render-process-gone',(_event,details)=>emit('renderer-gone',{...state(contents),reason:details.reason,exitCode:details.exitCode}));
   contents.debugger?.on('detach',(_event,reason)=>emit('debugger-detach',{...state(contents),reason}));
   const capture=contents.capturePage;contents.capturePage=function(...args){const id=++operation;emit('capture-start',{operation:id,...state(contents),rect:args[0]||null,opts:args[1]||null});try{return observePromise(capture.apply(this,args),id,'capture',contents);}catch(error){emit('capture-threw',{operation:id,...state(contents),message:String(error.message).slice(0,250)});throw error;}};
   const debuggerApi=contents.debugger,send=debuggerApi?.sendCommand;
   if(send)debuggerApi.sendCommand=function(...args){if(args[0]!=='Emulation.setDeviceMetricsOverride')return send.apply(this,args);const id=++operation;emit('emulation-start',{operation:id,...state(contents),metrics:{width:args[1]?.width,height:args[1]?.height,scale:args[1]?.scale}});try{return observePromise(send.apply(this,args),id,'emulation',contents);}catch(error){emit('emulation-threw',{operation:id,...state(contents),message:String(error.message).slice(0,250)});throw error;}};
  };
  const safelyObserve=contents=>{try{observe(contents);}catch(error){emit('observer-unavailable',{wc:contents.id,message:String(error.message).slice(0,200)});}};
  for(const contents of webContents.getAllWebContents())safelyObserve(contents);
  app.on('web-contents-created',(_event,contents)=>safelyObserve(contents));
  for(const name of ['browser-window-created'])app.on(name,(_event,window)=>{const windowId=window.id;for(const event of ['show','hide','minimize','restore','unresponsive','responsive','closed'])window.on(event,()=>emit('window-'+event,{window:windowId}));});
  const handler=ipcMain?._invokeHandlers?.get('reviewops:invoke');
  if(handler)ipcMain._invokeHandlers.set('reviewops:invoke',function(event,action,payload){
   if(typeof action!=='string'||!(/^(viewerSession\.|browser\.)/.test(action)))return handler.apply(this,arguments);
   const id=++operation;emit('ipc-start',{operation:id,action,sender:event.sender.id,browserId:typeof payload?.id==='string'?payload.id:undefined});
   const observeResult=result=>emit('ipc-settled',{operation:id,action,sender:event.sender.id,ok:result?.ok,errorCode:result?.error?.code,message:typeof result?.error?.message==='string'?result.error.message.slice(0,250):undefined});
   try{const value=handler.apply(this,arguments);if(value&&typeof value.then==='function')value.then(observeResult,error=>emit('ipc-rejected',{operation:id,action,message:String(error?.message||error).slice(0,250)})).catch(()=>{});else observeResult(value);return value;}catch(error){emit('ipc-threw',{operation:id,action,message:String(error.message).slice(0,250)});throw error;}
  });
  global.__reviewopsCaptureDiagnostics={mark:(phase)=>emit('phase',{phase}),snapshot:()=>({version:1,pending:(()=>{const pending=new Map();for(const record of records){if(['capture-start','emulation-start','ipc-start'].includes(record.type))pending.set(record.operation,record);else if(/-(fulfilled|rejected|settled|threw)$/.test(record.type))pending.delete(record.operation);}return [...pending.values()].map(record=>({...record,pendingMs:Date.now()-started-record.ms}));})(),platform:process.platform,arch:process.arch,electron:process.versions.electron,node:process.version,truncated:records.length===limit,records:[...records],current:webContents.getAllWebContents().map(state)})};
  emit('installed',{origin});return {installed:true};
 },{origin:fixtureOrigin});
}
export async function markSessionCaptureDiagnostics(application,phase){return application.evaluate((_electron,phase)=>global.__reviewopsCaptureDiagnostics.mark(phase),phase);}
export async function readSessionCaptureDiagnostics(application){return application.evaluate(()=>global.__reviewopsCaptureDiagnostics.snapshot());}

export async function readSessionCaptureFailureFacts(page) {
 if(!page||page.isClosed())return {pageClosed:true};
 return Promise.race([page.evaluate(async()=>{
  const browserId=document.querySelector('.native-browser-surface[data-browser-id]')?.dataset.browserId;
  if(!browserId)return {browserId:null};
  const result=await window.reviewops.request('browser.state',{id:browserId});
  if(!result.ok)return {browserId,ok:false,code:result.error?.code,message:result.error?.message};
  const {loading,error,sessionId,epoch}=result.data;return {browserId,ok:true,loading,error,sessionId,epoch};
 }),new Promise(resolve=>setTimeout(()=>resolve({diagnosticTimeout:true}),1500))]);
}

// Optional diagnostic only. Call after saving the original failure; never convert it to a pass.
export async function probeSessionCaptureAfterFailure(application, fixtureUrl) {
 return application.evaluate(async({BrowserWindow,webContents},url)=>{
  const allowed=new URL(url);if(allowed.hostname!=='127.0.0.1'||allowed.protocol!=='http:'||allowed.username||allowed.password||allowed.search||allowed.hash)throw new Error('Only an exact loopback fixture URL may be probed');
  const candidates=webContents.getAllWebContents().filter(contents=>contents.getURL()===url);
  if(candidates.length!==1)return {diagnosticOnly:true,attempted:false,reason:'Owned fixture WebContents was absent or ambiguous',matches:candidates.length};
  const contents=candidates[0],id=contents.id;
  const bounded=async(promise,ms)=>{let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve({diagnosticTimeout:true}),ms);})]);}finally{clearTimeout(timer);}};
  const state=()=>{try{const owner=BrowserWindow.fromWebContents(contents),parent=owner?.getParentWindow?.();return {wc:id,url:contents.getURL(),destroyed:contents.isDestroyed(),crashed:contents.isCrashed?.(),loading:contents.isLoading(),owner:owner?.id,ownerVisible:owner?.isVisible(),ownerFocused:owner?.isFocused(),parent:parent?.id,parentVisible:parent?.isVisible(),parentFocused:parent?.isFocused(),debuggerAttached:contents.debugger.isAttached()};}catch{return {wc:id,destroyed:true};}};
  const dom=()=>bounded(contents.executeJavaScript('({visibility:document.visibilityState,instance:typeof window.instance==="string"?window.instance:null})').catch(error=>({error:String(error.message).slice(0,200)})),500);
  const before=state(),domBefore=await dom();if(contents.isDestroyed()||contents.getURL()!==url)return {diagnosticOnly:true,attempted:false,reason:'Owned fixture changed before the diagnostic capture',before,domBefore};const started=Date.now();let result;
  try{result=await bounded(contents.capturePage(undefined,{stayHidden:false}).then(image=>({resolved:true,empty:image.isEmpty(),size:image.getSize()}),error=>({resolved:false,message:String(error.message).slice(0,250)})),2000);}catch(error){result={threw:true,message:String(error.message).slice(0,250)};}
  const after=state(),domAfter=await dom();return {diagnosticOnly:true,attempted:true,originalQaResult:'failed',options:{stayHidden:false},elapsedMs:Date.now()-started,before,domBefore,result,after,domAfter,sameInstance:typeof domBefore.instance==='string'&&domBefore.instance===domAfter.instance};
 },fixtureUrl);
}
