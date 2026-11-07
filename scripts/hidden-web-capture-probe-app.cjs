'use strict';
// A standalone synthetic Electron graph. It never loads electron/main.cjs or user data.
const {app,BrowserWindow,WebContentsView,session,screen,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {CAPTURE_TIMEOUT_MS,HIDDEN_SETTLE_MS,GEOMETRY,hostedOnly,validateConfig,sourcePreserved,geometryPreserved}=require('./hidden-web-capture-probe-common.cjs');
hostedOnly();
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),testCase=validateConfig(config);
app.setPath('userData',config.profile);
const sessionDirectory=path.join(config.profile,'session');fs.mkdirSync(sessionDirectory,{recursive:true});app.setPath('sessionData',sessionDirectory);
const report={schema:1,diagnosticOnly:true,productQaPassed:false,id:testCase.id,case:testCase,geometry:GEOMETRY,platform:process.platform,arch:process.arch,versions:{electron:process.versions.electron,chrome:process.versions.chrome,node:process.version},status:'starting',trace:[]};
let parent,clip,view,server,origin,requests=0,blockedRequests=0;
const started=Date.now();
function save(){const file=config.result+'.tmp';fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');fs.renameSync(file,config.result);}
function mark(phase,details={}){report.phase=phase;if(report.trace.length<200)report.trace.push({ms:Date.now()-started,phase,...details});save();}
function bounded(promise,ms) {
  let timer;
  return Promise.race([Promise.resolve(promise).then(value=>({status:'resolved',value}),error=>({status:'rejected',message:String(error?.message||error).slice(0,300)})),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout',timeoutMs:ms}),ms);})]).finally(()=>clearTimeout(timer));
}
async function must(promise,phase){const result=await bounded(promise,5000);if(result.status!=='resolved')throw new Error(`${phase}: ${result.status}${result.message?': '+result.message:''}`);return result.value;}
function nativeState(){
  const contents=view.webContents;
  return {webContentsId:contents.id,url:contents.getURL(),loading:contents.isLoading(),crashed:contents.isCrashed(),capturing:contents.isBeingCaptured(),backgroundThrottling:contents.getBackgroundThrottling(),debuggerAttached:contents.debugger.isAttached(),parentVisible:parent.isVisible(),parentMinimized:parent.isMinimized(),clipVisible:clip.isVisible(),clipMinimized:clip.isMinimized(),viewBounds:view.getBounds(),clipBounds:clip.getBounds()};
}
async function snapshot(){
  const state=nativeState(),dom=await bounded(view.webContents.executeJavaScript('({instance:window.instance,form:document.querySelector("input").value,phase:window.probePhase,raf:window.rafCount,visibility:document.visibilityState,innerWidth,innerHeight,devicePixelRatio,readyState:document.readyState})'),1000);
  return {...state,requests,blockedRequests,...(dom.status==='resolved'?dom.value:{domObservation:dom})};
}
function pngFacts(png,expectedBlue){
  if(!Buffer.isBuffer(png)||png.length<24||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Capture did not return PNG bytes.');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  // Decode original PNG pixels only; no resize, crop, rewritten image or image file.
  const bitmap=nativeImage.createFromBuffer(png).toBitmap();
  if(bitmap.length!==width*height*4)throw new Error('Unexpected native PNG bitmap dimensions.');
  const x=Math.max(0,Math.floor(width*.02)),y=Math.max(0,Math.floor(height*.02)),offset=(y*width+x)*4,sample=[...bitmap.subarray(offset,offset+4)];
  const orders=expectedBlue?[[report.visibleBaseline.png.marker.order,report.visibleBaseline.png.marker.order==='BGRA'?[210,100,20,255]:[20,100,210,255]]]:[['BGRA',[30,60,210,255]],['RGBA',[210,60,30,255]]];
  const matched=orders.find(([,expected])=>sample.every((n,i)=>Math.abs(n-expected[i])<=2));
  return {bytes:png.length,width,height,sha256:crypto.createHash('sha256').update(png).digest('hex'),marker:{sampleCoordinate:{x,y},rawPixel:sample,order:matched?.[0]||'unrecognized',expectedRawPixel:matched?.[1]||orders[0][1],matches:Boolean(matched)}};
}
async function capture(method,options,expectedBlue){
  const start=Date.now();let promise;
  try {
    promise=method==='native'
      ? (options===null?view.webContents.capturePage():view.webContents.capturePage(undefined,options)).then(image=>{if(image.isEmpty())throw new Error('Native capture is empty.');return image.toPNG();})
      :view.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:testCase.fromSurface,captureBeyondViewport:false}).then(result=>Buffer.from(result.data,'base64'));
  }catch(error){return {status:'threw',message:String(error.message).slice(0,300),elapsedMs:Date.now()-start};}
  const result=await bounded(promise,CAPTURE_TIMEOUT_MS);
  if(result.status==='resolved') {
    try{const png=pngFacts(result.value,expectedBlue);return {status:'resolved',elapsedMs:Date.now()-start,png,freshSourceFrame:png.marker.matches};}
    catch(error){return {status:'invalid-image',message:error.message,elapsedMs:Date.now()-start};}
  }
  return {...result,elapsedMs:Date.now()-start};
}

async function main(){
  await app.whenReady();
  server=http.createServer((request,response)=>{
    requests++;
    if(request.url!=='/fixture'){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"});
    response.end(`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Synthetic owned capture source</title><style>html,body{margin:0;background:#e8edf2}canvas{display:block;width:240px;height:160px}input{font:24px sans-serif}</style><canvas width="240" height="160"></canvas><label>Unsaved synthetic form<input value="INITIAL"></label><script>window.instance=crypto.randomUUID();window.rafCount=0;window.probePhase='baseline';const ctx=document.querySelector('canvas').getContext('2d');window.setProbePhase=phase=>{window.probePhase=phase;ctx.fillStyle=phase==='hidden'?'rgb(20,100,210)':'rgb(210,60,30)';ctx.fillRect(0,0,240,160);};window.setProbePhase('baseline');function frame(){window.rafCount++;requestAnimationFrame(frame)}requestAnimationFrame(frame);</script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  const partition='capture-probe-'+crypto.randomUUID(),isolated=session.fromPartition(partition);
  isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  isolated.setPermissionCheckHandler(()=>false);
  isolated.webRequest.onBeforeRequest((details,callback)=>{const allowed=details.url===origin+'/fixture'||details.url==='about:blank'||details.url.startsWith('data:');if(!allowed)blockedRequests++;callback({cancel:!allowed});});
  parent=new BrowserWindow({show:true,width:800,height:600,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  clip=new BrowserWindow({parent,show:false,width:1,height:1,frame:false,roundedCorners:false,hasShadow:false,resizable:false,movable:false,minimizable:false,maximizable:false,fullscreenable:false,skipTaskbar:true,excludedFromShownWindowsMenu:true,acceptFirstMouse:true,backgroundColor:'#ffffff',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  view=new WebContentsView({webPreferences:{partition,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,sandbox:true,webSecurity:false,allowRunningInsecureContent:true,webviewTag:false,navigateOnDragDrop:false,backgroundThrottling:testCase.backgroundThrottling}});
  clip.contentView.addChildView(view);
  for(const event of ['show','hide','closed'])clip.on(event,()=>mark('clip-'+event));
  for(const event of ['did-start-loading','did-stop-loading','did-finish-load','dom-ready'])view.webContents.on(event,()=>mark(event));
  view.webContents.on('render-process-gone',(_event,details)=>mark('renderer-gone',details));
  view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  view.webContents.on('will-navigate',(event,url)=>{if(url!==origin+'/fixture')event.preventDefault();});
  mark('created');
  await must(view.webContents.loadURL('about:blank'),'initial blank load');
  mark('blank-loaded');
  view.webContents.debugger.attach('1.3');
  await must(view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:GEOMETRY.viewportWidth,height:GEOMETRY.viewportHeight,deviceScaleFactor:0,mobile:false,scale:GEOMETRY.scale,dontSetVisibleSize:true}),'initial emulation');
  mark('emulation-applied');
  if(testCase.focusEmulated){await must(view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true}),'focus emulation');mark('focus-emulation-enabled');}
  const area=parent.getContentBounds();clip.setBounds({x:area.x+50,y:area.y+50,width:GEOMETRY.width,height:GEOMETRY.height});view.setBounds({x:0,y:0,width:GEOMETRY.width,height:GEOMETRY.height});clip.showInactive();
  await must(view.webContents.loadURL(origin+'/fixture'),'fixture load');
  await must(view.webContents.executeJavaScript('document.querySelector("input").value="UNSAVED_FORM_PRESERVED";new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),'visible fixture frame');
  report.sourceBefore=await snapshot();report.isBeingCapturedBeforeVisibleBaseline=view.webContents.isBeingCaptured();report.visibleBaseline=await capture('native',{stayHidden:true},false);report.isBeingCapturedAfterVisibleBaseline=view.webContents.isBeingCaptured();
  if(report.visibleBaseline.status!=='resolved'||!report.visibleBaseline.png.marker.matches)throw new Error('Visible baseline failed; hidden outcome would not be interpretable.');
  report.display={scaleFactor:screen.getDisplayMatching(clip.getBounds()).scaleFactor};
  mark('visible-baseline-complete');
  clip.hide();
  await must(view.webContents.executeJavaScript('window.setProbePhase("hidden")'),'hidden marker update');
  mark('hidden-marker-updated');
  const settleStarted=Date.now();await new Promise(resolve=>setTimeout(resolve,HIDDEN_SETTLE_MS));report.hiddenSettleMs=Date.now()-settleStarted;
  report.hiddenBefore=await snapshot();
  if(testCase.temporaryUnthrottled)view.webContents.setBackgroundThrottling(false);
  try {
    report.captureBefore=await snapshot();mark('hidden-capture-start');
    report.hidden=await capture(testCase.method,testCase.options,true);
    report.captureAfter=await snapshot();
  } finally {
    if(testCase.temporaryUnthrottled)view.webContents.setBackgroundThrottling(testCase.backgroundThrottling);
  }
  report.sourceAfter=await snapshot();
  report.sourcePreserved=sourcePreserved(report.sourceBefore,report.sourceAfter)&&report.sourceAfter.blockedRequests===0;
  report.geometryPreserved=geometryPreserved(report.sourceBefore,report.sourceAfter);
  report.throttlingRestored=view.webContents.getBackgroundThrottling()===testCase.backgroundThrottling;
  report.status=report.sourcePreserved&&report.geometryPreserved&&report.throttlingRestored?'observed':'invariant-failed';
  mark('complete');
}

main().catch(error=>{report.status='setup-or-observation-failed';report.error=String(error.message).slice(0,400);process.exitCode=1;save();}).finally(()=>{
  // End this one independent graph after a pending native request; never issue a second capture on it.
  try{if(view&&!view.webContents.isDestroyed())view.webContents.close({waitForBeforeUnload:false});}catch{}
  try{if(clip&&!clip.isDestroyed())clip.destroy();}catch{}
  try{if(parent&&!parent.isDestroyed())parent.destroy();}catch{}
  server?.close();
  app.exit(process.exitCode||0);
});
