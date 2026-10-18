'use strict';
const { BrowserWindow, WebContentsView, session, screen } = require('electron');
const crypto = require('node:crypto');
const {createEvidenceRecorder} = require('./browser-evidence.cjs');

// Start a separate cookie store instead of attempting to decrypt legacy
// Keychain-encrypted cookies. The previous partition is left intact.
const PARTITION = 'persist:reviewops-browser-internal';
const RESOURCE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:']);
function browserUrl(value, allowBlank = false) {
  if (allowBlank && value === 'about:blank') return value;
  if (typeof value !== 'string' || value.length > 32768) throw new Error('화면 주소가 올바르지 않습니다.');
  let url;
  try { url = new URL(value); } catch { throw new Error('HTTP 또는 HTTPS 주소를 입력하십시오.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP 또는 HTTPS 주소만 열 수 있습니다.');
  return url.href;
}
function rectangle(value) {
  if (!value || ['x','y','width','height'].some(key => !Number.isFinite(value[key]) || Math.abs(value[key]) > 100000) || value.width < 0 || value.height < 0) throw new Error('화면 크기가 올바르지 않습니다.');
  return value;
}
function intersection(...rects) {
  const x = Math.max(...rects.map(rect => rect.x)), y = Math.max(...rects.map(rect => rect.y));
  const right = Math.min(...rects.map(rect => rect.x + rect.width)), bottom = Math.min(...rects.map(rect => rect.y + rect.height));
  return {x, y, width:Math.max(0,right-x), height:Math.max(0,bottom-y)};
}

function createBrowserManager(window) {
  const views = new Map(), popups = new Set();
  const recorder = createEvidenceRecorder();
  function bindContext(item,value){
    const next=typeof value==='string'?value.slice(0,120):'';
    if(item.contextId===next)return item.contextPromise||Promise.resolve();
    item.contextId=next;
    item.contextPromise=(item.contextPromise||Promise.resolve()).catch(()=>{}).then(()=>recorder.reset(item));
    return item.contextPromise;
  }
  // macOS attaches WebContentsView's native view directly to its window. A
  // generic View cannot clip it. A frameless child window supplies an actual OS
  // clipping boundary while preserving Chromium's native input coordinates.
  function syncWindow(item) {
    if (window.isDestroyed() || item.clipWindow.isDestroyed()) return;
    if (!item.visible || !item.area || !window.isVisible() || window.isMinimized()) {
      item.clipWindow.hide(); return;
    }
    const root = window.getContentBounds(), area = item.area;
    const next={x:root.x+area.x,y:root.y+area.y,width:area.width,height:area.height};
    if (JSON.stringify(item.clipWindow.getBounds()) !== JSON.stringify(next)) item.clipWindow.setBounds(next);
    if (!item.clipWindow.isVisible()) item.clipWindow.showInactive();
  }
  const syncWindows = () => { for (const item of views.values()) syncWindow(item); };
  const syncAfterShow = () => { syncWindows();setImmediate(syncWindows); };
  const hideWindows = () => { for (const item of views.values()) if (!item.clipWindow.isDestroyed()) item.clipWindow.hide(); };
  for (const event of ['move','resize']) window.on(event,syncWindows);
  // Cocoa can emit show before isVisible() reflects the new window state.
  for (const event of ['show','restore','focus','enter-full-screen','leave-full-screen']) window.on(event,syncAfterShow);
  for (const event of ['hide','minimize']) window.on(event,hideWindows);
  const browserSession = session.fromPartition(PARTITION);
  // This partition belongs only to external pages. It has no application preload
  // or IPC bridge and cannot request app assets or local files.
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try { allowed = RESOURCE_SCHEMES.has(new URL(details.url).protocol); } catch {}
    if(allowed)recorder.beforeRequest(details);
    callback({cancel:!allowed});
  });
  browserSession.webRequest.onCompleted(details=>recorder.completed(details));
  browserSession.webRequest.onErrorOccurred(details=>recorder.failed(details));
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => callback(['fullscreen','pointerLock'].includes(permission)));
  browserSession.setPermissionCheckHandler((_contents, permission) => ['fullscreen','pointerLock'].includes(permission));
  const preferences = {
    partition:PARTITION, contextIsolation:true, nodeIntegration:false,
    nodeIntegrationInSubFrames:false, nodeIntegrationInWorker:false,
    sandbox:true, webSecurity:false, allowRunningInsecureContent:true,
    webviewTag:false, navigateOnDragDrop:false, backgroundThrottling:true
  };
  function protect(contents, owner) {
    recorder.track(contents,owner);
    contents.setUserAgent(contents.getUserAgent().replace(/\sElectron\/\S+/g,'').replace(/\s(?:ReviewOps|reviewops-local|ReviewOps-Local)\/\S+/gi,''));
    contents.setZoomMode?.('isolated');
    const checkNavigation = (event, target) => {
      const url = typeof target === 'string' ? target : target?.url;
      try { browserUrl(url, true); }
      catch { event.preventDefault(); }
    };
    contents.on('will-navigate', checkNavigation);
    contents.on('will-redirect', checkNavigation);
    contents.on('will-frame-navigate', (event, details) => {
      const url = details?.url || event.url;
      try { if (!RESOURCE_SCHEMES.has(new URL(url).protocol)) event.preventDefault(); } catch { event.preventDefault(); }
    });
    contents.setWindowOpenHandler(details => {
      try { browserUrl(details.url, true); } catch { return {action:'deny'}; }
      if (popups.size >= 12) return {action:'deny'};
      // Let Chromium create the popup, retaining opener, POST bodies and session.
      return {action:'allow', overrideBrowserWindowOptions:{
        parent:window, width:1000, height:780, minWidth:480, minHeight:360,
        title:'ReviewOps', autoHideMenuBar:true, backgroundColor:'#ffffff',
        webPreferences:{...preferences, preload:undefined}
      }};
    });
    contents.on('did-create-window', popup => {
      popups.add(popup); owner.popups.add(popup);
      protect(popup.webContents, owner);
      popup.on('closed', () => { popups.delete(popup); owner.popups.delete(popup); });
    });
  }
  function get(id) {
    const item = views.get(id);
    if (!item || item.view.webContents.isDestroyed()) throw new Error('열린 화면을 찾을 수 없습니다.');
    return item;
  }
  function state(item) {
    const contents = item.view.webContents, currentUrl = contents.getURL();
    const url = !currentUrl || currentUrl === 'about:blank' ? item.requestedUrl : currentUrl;
    return {id:item.id,url,title:contents.getTitle(),loading:contents.isLoading(),canGoBack:contents.navigationHistory.canGoBack(),canGoForward:contents.navigationHistory.canGoForward(),error:item.error,logCounts:recorder.counts(item),selectedElement:item.selectedElement||null};
  }
  async function navigate(item, url) {
    const target = browserUrl(url);
    await item.emulationPromise;
    get(item.id);
    item.requestedUrl = target; item.error = '';
    // Loading must not hold the UI IPC queue while a slow site responds.
    item.view.webContents.loadURL(item.requestedUrl).catch(error => {
      if (views.has(item.id) && error.code !== 'ERR_ABORTED') item.error = `화면을 열지 못했습니다. ${error.code || error.message}`;
    });
    return state(item);
  }
  function close(id) {
    const item = views.get(id);
    if (!item) return {closed:true};
    views.delete(id);
    for (const popup of item.popups) if (!popup.isDestroyed()) popup.destroy();
    if (!item.view.webContents.isDestroyed()) item.view.webContents.close({waitForBeforeUnload:false});
    if (!item.clipWindow.isDestroyed()) item.clipWindow.destroy();
    browserSession.flushStorageData();
    return {closed:true};
  }
  function emulationFor(viewport) {
    if (!viewport || !Number.isFinite(viewport.width) || viewport.width < 1 || viewport.width > 7680 || !Number.isFinite(viewport.height) || viewport.height < 1 || viewport.height > 7680 || !Number.isFinite(viewport.scale) || viewport.scale <= 0 || viewport.scale > 4) throw new Error('화면 배율이 올바르지 않습니다.');
    return {width:Math.round(viewport.width),height:Math.round(viewport.height),scale:viewport.scale*window.webContents.getZoomFactor()};
  }
  function applyEmulation(item, emulation) {
    const serialized = JSON.stringify(emulation);
    item.emulation = serialized;
    // CDP preserves these metrics when Chromium replaces a page's renderer.
    // Serialize updates so an older resize cannot overwrite a newer setting.
    item.emulationPromise = item.emulationPromise.catch(()=>{}).then(async()=>{
      get(item.id);
      const debuggerApi = item.view.webContents.debugger;
      if (item.appliedEmulation === serialized && debuggerApi.isAttached()) return;
      if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
      await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride',{
        width:emulation.width,height:emulation.height,deviceScaleFactor:0,
        mobile:false,scale:emulation.scale,dontSetVisibleSize:true
      });
      item.appliedEmulation = serialized;
    });
    return item.emulationPromise;
  }
  async function layout(item, payload) {
    const revision = ++item.layoutRevision;
    if (payload.visible !== true) { item.visible=false;syncWindow(item);return state(item); }
    const bounds = rectangle(payload.bounds), clip = rectangle(payload.clip || bounds);
    const emulation = emulationFor(payload.viewport);
    const zoom = window.webContents.getZoomFactor();
    const native = rect => ({x:Math.round(rect.x*zoom),y:Math.round(rect.y*zoom),width:Math.round(rect.width*zoom),height:Math.round(rect.height*zoom)});
    const root = window.getContentBounds();
    const area = intersection(native(bounds),native(clip),{x:0,y:0,width:root.width,height:root.height});
    if (area.width < 1 || area.height < 1) { item.visible=false;syncWindow(item);return state(item); }
    const full = native(bounds);
    item.area = area;
    item.view.setBounds({x:full.x-area.x,y:full.y-area.y,width:Math.max(1,full.width),height:Math.max(1,full.height)});
    await applyEmulation(item,emulation);
    get(item.id);
    if (revision === item.layoutRevision) { item.visible=true;syncWindow(item); }
    return state(item);
  }
  return {
    async dispatch(action, payload) {
      if (action === 'browser.create') {
        const url = browserUrl(payload.url), initialEmulation = emulationFor(payload.viewport || {width:1920,height:1080,scale:1});
        if (views.size >= 32) throw new Error('열린 화면이 많습니다. 사용하지 않는 작업 탭을 닫으십시오.');
        const view = new WebContentsView({webPreferences:preferences});
        const clipWindow = new BrowserWindow({
          parent:window,show:false,width:1,height:1,frame:false,
          roundedCorners:false,hasShadow:false,resizable:false,movable:false,
          minimizable:false,maximizable:false,fullscreenable:false,
          skipTaskbar:true,excludedFromShownWindowsMenu:true,acceptFirstMouse:true,
          backgroundColor:'#ffffff',title:'ReviewOps',
          webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}
        });
        clipWindow.contentView.addChildView(view);
        clipWindow.on('close',event=>{if(!window.isDestroyed())event.preventDefault();});
        const item = {id:crypto.randomUUID(),view,clipWindow,visible:false,area:null,layoutRevision:0,popups:new Set(),requestedUrl:url,error:'',emulation:null,appliedEmulation:null,emulationPromise:Promise.resolve(),contextId:typeof payload.contextId==='string'?payload.contextId.slice(0,120):''};
        views.set(item.id,item);
        try {
          // Initialize the target before awaiting CDP; an unnavigated target can
          // otherwise hold commands until its first navigation starts.
          await view.webContents.loadURL('about:blank');
          get(item.id);
          protect(view.webContents,item);
          view.webContents.debugger.on('detach',()=>{item.appliedEmulation=null;});
          view.webContents.on('devtools-closed',()=>{
            if (views.has(item.id) && !view.webContents.isDestroyed() && item.emulation) applyEmulation(item,JSON.parse(item.emulation)).catch(()=>{});
          });
          view.webContents.on('did-start-loading',()=>{item.error='';});
          view.webContents.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame && code !== -3)item.error=`화면을 열지 못했습니다. ${description}`;});
          view.webContents.on('render-process-gone',()=>{item.error='화면을 다시 불러오십시오.';});
          await applyEmulation(item,initialEmulation);
          return await navigate(item,url);
        } catch (error) {
          close(item.id);
          throw error;
        }
      }
      if (action === 'browser.close') return close(payload.id);
      if (action === 'browser.collectFor') {
        const matching=[...views.values()].filter(item=>payload.contextId&&item.contextId===payload.contextId);
        const item=matching.find(item=>payload.url&&item.view.webContents.getURL()===payload.url)||matching.at(-1)||(!payload.contextId&&[...views.values()].find(item=>payload.url&&item.view.webContents.getURL()===payload.url));
        if (item) { await item.emulationPromise;get(item.id); }
        return item?recorder.collect(item):{schemaVersion:1,capturedAt:new Date().toISOString(),available:false,url:payload.url||'',title:'',viewport:{},navigation_log:[],input_log:[],network_log:[],console_log:[],fingerprint_log:{}};
      }
      const item = get(payload.id), contents = item.view.webContents;
      if (['browser.evidence','browser.clearLogs','browser.pickElement','browser.capture'].includes(action)) { await item.emulationPromise;get(item.id); }
      if (action === 'browser.context') return bindContext(item,payload.contextId).then(()=>state(item));
      if (action === 'browser.evidence') return recorder.collect(item);
      if (action === 'browser.clearLogs') return recorder.clear(item,payload.kind);
      if (action === 'browser.pickElement') return recorder.pick(item);
      if (action === 'browser.layout') return layout(item,payload);
      if (action === 'browser.navigate') {
        if(payload.contextId===undefined)return navigate(item,payload.url);
        const contextId=payload.contextId;
        return bindContext(item,contextId).then(()=>item.contextId===contextId?navigate(item,payload.url):state(item));
      }
      if (action === 'browser.state') { syncWindow(item);return state(item); }
      if (action === 'browser.capture') {
        if (!item.emulation || item.error || !contents.getURL()) throw new Error('캡처할 화면을 먼저 여십시오.');
        const bounds=item.view.getBounds(),density=screen.getDisplayMatching(item.clipWindow.getBounds()).scaleFactor;
        if (bounds.width*bounds.height*density*density>64*1024*1024) throw new Error('캡처할 화면이 너무 큽니다. 화면 크기나 배율을 줄인 뒤 다시 캡처하십시오.');
        // Capture the external page itself. Capturing the host window excludes
        // WebContentsView, while desktop capture could include unrelated apps.
        return contents.capturePage(undefined,{stayHidden:true}).then(image => {
          if (image.isEmpty()) throw new Error('스크린샷을 만들지 못했습니다. 화면을 다시 불러오십시오.');
          const png=image.toPNG(),capturedAt=new Date().toISOString();
          if (png.length > 20*1024*1024) throw new Error('스크린샷이 20 MB를 초과했습니다. 화면 크기를 줄인 뒤 다시 캡처하십시오.');
          return {dataUrl:`data:image/png;base64,${png.toString('base64')}`,mimeType:'image/png',name:`스크린샷 ${capturedAt.replace(/[T:]/g,'-').slice(0,19)}.png`,width:png.readUInt32BE(16),height:png.readUInt32BE(20),url:contents.getURL(),capturedAt};
        });
      }
      await item.emulationPromise;
      get(item.id);
      if (action === 'browser.back') { if(contents.navigationHistory.canGoBack())contents.navigationHistory.goBack(); }
      else if (action === 'browser.forward') { if(contents.navigationHistory.canGoForward())contents.navigationHistory.goForward(); }
      else if (action === 'browser.reload') { item.error='';contents.reload(); }
      else if (action === 'browser.stop') contents.stop();
      else throw new Error('지원하지 않는 화면 기능입니다.');
      return state(item);
    },
    closeAll() { for (const id of [...views.keys()]) close(id); recorder.close();browserSession.flushStorageData(); },
    async flush() { browserSession.flushStorageData(); await browserSession.cookies.flushStore(); }
  };
}
module.exports = {createBrowserManager,browserUrl,intersection,rectangle};
