'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createEvidenceRecorder}=require('../electron/browser-evidence.cjs');
const {createNativeCaptureLease}=require('../electron/browser-capture.cjs');

function harness(t) {
  const sessions=new Map(),views=[],windows=[],managers=[];
  let contentsId=0,requestId=0;
  function sessionFor(partition) {
    if(!sessions.has(partition)) {
      const handlers={};
      sessions.set(partition,{
        handlers,flushStorageData(){},cookies:{async flushStore(){}},
        webRequest:Object.fromEntries(['onBeforeRequest','onCompleted','onErrorOccurred'].map(name=>[name,callback=>{handlers[name]=callback;}])),
        setPermissionRequestHandler(callback){this.permissionRequest=callback;},
        setPermissionCheckHandler(callback){this.permissionCheck=callback;}
      });
    }
    return sessions.get(partition);
  }
  class Contents extends EventEmitter {
    constructor(preferences={}) {
      super();this.id=++contentsId;this.preferences=preferences;this.url='';this.destroyed=false;this.backgroundThrottling=preferences.backgroundThrottling!==false;
      this.debugger=Object.assign(new EventEmitter(),{attached:false,isAttached(){return this.attached;},attach(){this.attached=true;},async sendCommand(){}});
      this.navigationHistory={canGoBack:()=>false,canGoForward:()=>false};
    }
    isDestroyed(){return this.destroyed;}
    isCrashed(){return false;}
    getBackgroundThrottling(){return this.backgroundThrottling;}
    setBackgroundThrottling(value){this.backgroundThrottling=value;}
    getZoomFactor(){return 1;}
    getURL(){return this.url;}
    getTitle(){return this.url;}
    isLoading(){return false;}
    getUserAgent(){return 'Fixture Electron/44.9.0 ReviewOps/1.2.8';}
    setUserAgent(value){this.userAgent=value;}
    setZoomMode(){}
    setWindowOpenHandler(callback){this.openHandler=callback;}
    async loadURL(url){this.url=url;this.emit('did-navigate',{},url);}
    async executeJavaScriptInIsolatedWorld(){return {logs:[],fingerprint:{url:this.url}};}
    close(){this.destroyed=true;this.emit('destroyed');}
  }
  class Window extends EventEmitter {
    constructor(options={}) {
      super();this.options=options;this.destroyed=false;this.visible=options.show!==false;this.minimized=false;
      this.bounds={x:0,y:0,width:1200,height:900};this.webContents=new Contents(options.webPreferences);
      this.contentView={children:[],addChildView(view){this.children.push(view);}};windows.push(this);
    }
    isDestroyed(){return this.destroyed;}
    isVisible(){return this.visible;}
    isMinimized(){return this.minimized;}
    getContentBounds(){return this.bounds;}
    getBounds(){return this.bounds;}
    setBounds(bounds){this.bounds={...bounds};}
    showInactive(){this.visible=true;}
    hide(){this.visible=false;}
    destroy(){this.destroyed=true;this.visible=false;this.webContents.close();this.emit('closed');}
  }
  class View {
    constructor(options){this.options=options;this.webContents=new Contents(options.webPreferences);this.bounds={x:0,y:0,width:1,height:1};views.push(this);}
    setBounds(bounds){this.bounds={...bounds};}
    getBounds(){return this.bounds;}
  }
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/browser.cjs'),'utf8'),{
    module,exports:module.exports,setImmediate,
    require(name){
      if(name==='electron')return {BrowserWindow:Window,WebContentsView:View,session:{fromPartition:sessionFor},screen:{getDisplayMatching:()=>({scaleFactor:1})}};
      if(name==='./browser-evidence.cjs')return {createEvidenceRecorder};
      if(name==='./browser-capture.cjs')return {createNativeCaptureLease};
      return require(name);
    },URL,Buffer
  });
  function manager(host,options){const value=module.exports.createBrowserManager(host,options);managers.push(value);return value;}
  function request(view,url) {
    const handler=sessionFor(view.options.webPreferences.partition).handlers;
    const details={id:++requestId,webContentsId:view.webContents.id,url,method:'GET',resourceType:'xhr'};
    let response;handler.onBeforeRequest(details,value=>{response=value;});
    assert.equal(response.cancel,false);handler.onCompleted({...details,statusCode:200});
  }
  t.after(()=>{for(const manager of managers)manager.closeAll();});
  return {Window,View,manager,request,sessions,views,windows};
}

test('project browser managers retain separate network logs and keep the other window alive on close',async t=>{
  const h=harness(t),firstHost=new h.Window(),secondHost=new h.Window();secondHost.bounds.x=1400;
  const first=h.manager(firstHost,{partition:'persist:reviewops-browser-project-a'}),second=h.manager(secondHost,{partition:'persist:reviewops-browser-project-b'});
  const a=await first.dispatch('browser.create',{url:'https://same.invalid/a',contextId:'shared-name'});
  const b=await second.dispatch('browser.create',{url:'https://same.invalid/b',contextId:'shared-name'});
  const [viewA,viewB]=h.views;
  assert.notEqual(h.sessions.get(viewA.options.webPreferences.partition),h.sessions.get(viewB.options.webPreferences.partition));
  h.request(viewA,'https://same.invalid/a-data');h.request(viewB,'https://same.invalid/b-data');
  const evidenceA=await first.dispatch('browser.collectFor',{contextId:'shared-name'}),evidenceB=await second.dispatch('browser.collectFor',{contextId:'shared-name'});
  assert.deepEqual(evidenceA.network_log.map(item=>item.url),['https://same.invalid/a-data']);
  assert.deepEqual(evidenceB.network_log.map(item=>item.url),['https://same.invalid/b-data']);
  await assert.rejects(first.dispatch('browser.evidence',{id:b.id}),/열린 화면/);
  await assert.rejects(second.dispatch('browser.evidence',{id:a.id}),/열린 화면/);
  const layout={visible:true,bounds:{x:20,y:40,width:600,height:400},viewport:{width:1200,height:800,scale:0.5}};
  await first.dispatch('browser.layout',{id:a.id,...layout});await second.dispatch('browser.layout',{id:b.id,...layout});
  const childA=h.windows.find(window=>window.options.parent===firstHost),childB=h.windows.find(window=>window.options.parent===secondHost);
  assert.equal(childA.bounds.x,20);assert.equal(childB.bounds.x,1420);
  firstHost.bounds.x=100;firstHost.emit('move');assert.equal(childA.bounds.x,120);assert.equal(childB.bounds.x,1420);
  first.closeAll();assert.equal(viewA.webContents.isDestroyed(),true);assert.equal(childA.isDestroyed(),true);
  assert.equal(viewB.webContents.isDestroyed(),false);assert.equal(childB.isVisible(),true);
  h.request(viewB,'https://same.invalid/b-after-close');
  assert.deepEqual((await second.dispatch('browser.evidence',{id:b.id})).network_log.map(item=>item.url),['https://same.invalid/b-data','https://same.invalid/b-after-close']);
});

test('the default browser partition stays compatible and project popups inherit only their owner partition',async t=>{
  const h=harness(t),legacyHost=new h.Window(),projectHost=new h.Window();
  const legacy=h.manager(legacyHost),project=h.manager(projectHost,{partition:'persist:reviewops-browser-project-fixture'});
  await legacy.dispatch('browser.create',{url:'https://fixture.invalid/legacy'});
  const opened=await project.dispatch('browser.create',{url:'https://fixture.invalid/project'});
  assert.equal(h.views[0].options.webPreferences.partition,'persist:reviewops-browser-internal');
  const view=h.views[1],result=view.webContents.openHandler({url:'https://fixture.invalid/popup'});
  assert.equal(result.action,'allow');assert.equal(result.overrideBrowserWindowOptions.parent,projectHost);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.partition,'persist:reviewops-browser-project-fixture');
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.preload,undefined);
  const popup=new h.Window(result.overrideBrowserWindowOptions);view.webContents.emit('did-create-window',popup);
  popup.webContents.emit('console-message',{}, {level:'info',message:'project popup log',sourceId:'https://fixture.invalid/popup'});
  const evidence=await project.dispatch('browser.evidence',{id:opened.id});assert.equal(evidence.console_log[0].message,'project popup log');
  project.closeAll();assert.equal(popup.isDestroyed(),true);assert.equal(h.views[0].webContents.isDestroyed(),false);
  for(const session of h.sessions.values()) {
    let response;session.handlers.onBeforeRequest({url:'reviewops://app/index.html'},value=>{response=value;});assert.equal(response.cancel,true);
    assert.equal(session.permissionCheck(null,'media'),false);assert.equal(session.permissionCheck(null,'fullscreen'),true);
  }
});

test('a delayed navigation cannot cross projects that share the same service context',async t=>{
 const h=harness(t),manager=h.manager(new h.Window()),opened=await manager.dispatch('browser.create',{projectId:'project-a',contextId:'shared-service',url:'https://fixture.invalid/start'}),contents=h.views[0].webContents;
 const loaded=[],load=contents.loadURL.bind(contents);contents.loadURL=url=>{loaded.push(url);return load(url)};
 await Promise.all([
  manager.dispatch('browser.navigate',{id:opened.id,projectId:'project-a',contextId:'shared-service',url:'https://fixture.invalid/old-project-a'}),
  manager.dispatch('browser.navigate',{id:opened.id,projectId:'project-b',contextId:'shared-service',url:'https://fixture.invalid/new-project-b'})
 ]);
 assert.deepEqual(loaded,['https://fixture.invalid/new-project-b']);
});

test('a crashed retained WebContents advertises recovery only after its load and viewport are ready',async t=>{
 const h=harness(t),host=new h.Window(),events=[];let item;
 const manager=h.manager(host,{backgroundPopups:()=>true,onCreated:value=>{item=value;},onChanged:(value,contextChanged)=>events.push({gone:value.rendererGone,contextChanged}),onClosed:value=>events.push({closed:true,gone:value.rendererGone})});
 const opened=await manager.dispatch('browser.create',{url:'https://fixture.invalid/recovery',projectId:'project-a',contextId:'service-a'}),contents=h.views[0].webContents;
 contents.emit('render-process-gone');assert.equal(item.rendererGone,true);assert.deepEqual(events.at(-1),{closed:true,gone:true});
 contents.emit('did-start-navigation',{},'https://fixture.invalid/recovery',false,true);assert.equal(events.at(-1).gone,true);
 contents.emit('did-finish-load');await item.recovery;assert.equal(item.rendererGone,false);assert.deepEqual(events.at(-1),{gone:false,contextChanged:false});assert.equal((await manager.dispatch('browser.state',{id:opened.id})).id,opened.id);assert.equal(h.views.length,1);
 contents.emit('render-process-gone');contents.emit('did-finish-load');manager.closeAll();await item.recovery;assert.equal(events.at(-1).closed,true);assert.equal(item.rendererGone,true);
});

test('native capture keeps the same source, hidden window, exact native options and original PNG bytes',async t=>{
 const h=harness(t),host=new h.Window(),manager=h.manager(host),opened=await manager.dispatch('browser.create',{url:'https://fixture.invalid/native-capture'}),contents=h.views[0].webContents,child=h.windows.find(window=>window.options.parent===host);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 let resolve,entered;const ready=new Promise(done=>{entered=done;}),raw=new Promise(done=>{resolve=done;});let calls=0;
 contents.capturePage=function(...args){assert.equal(this,contents);assert.equal(this.getBackgroundThrottling(),false);assert.equal(args[0],undefined);assert.equal(args[1].stayHidden,true);assert.equal(args.length,2);calls++;entered();return raw;};
 const capture=manager.dispatch('browser.capture',{id:opened.id});await ready;await assert.rejects(manager.dispatch('browser.capture',{id:opened.id}),{code:'CAPTURE_BUSY'});assert.equal(calls,1);
 resolve({isEmpty:()=>false,toPNG:()=>png});const result=await capture;assert.equal(result.dataUrl,'data:image/png;base64,'+png.toString('base64'));assert.equal(result.width,1);assert.equal(result.height,1);assert.equal(result.url,'https://fixture.invalid/native-capture');assert.equal(contents.getBackgroundThrottling(),true);assert.equal(h.views.length,1);assert.equal(child.isVisible(),false);
});

test('renderer exit cancels native capture and the gone flag blocks capture even when isCrashed is false',async t=>{
 const h=harness(t);let item;
 const manager=h.manager(new h.Window(),{onCreated:value=>{item=value;}}),opened=await manager.dispatch('browser.create',{url:'https://fixture.invalid/gone'}),contents=h.views[0].webContents;
 let entered;const ready=new Promise(done=>{entered=done;});let nativeCalls=0;contents.capturePage=()=>{nativeCalls++;entered();return new Promise(()=>{});};
 const pending=manager.dispatch('browser.capture',{id:opened.id});await ready;const rejected=assert.rejects(pending,{code:'SESSION_GONE'});contents.emit('render-process-gone');await rejected;assert.equal(contents.getBackgroundThrottling(),true);
 contents.emit('did-start-loading');assert.equal(item.error,'');assert.equal(item.rendererGone,true);await assert.rejects(manager.dispatch('browser.capture',{id:opened.id}),/캡처할 화면/);assert.equal(nativeCalls,1);
});

test('Electron numeric aborted navigation with empty description does not poison the capture guard',async t=>{
 const h=harness(t),manager=h.manager(new h.Window()),opened=await manager.dispatch('browser.create',{url:'https://fixture.invalid/start'}),contents=h.views[0].webContents;
 const aborted=Object.assign(new Error(" (-3) loading 'https://fixture.invalid/a'"),{errno:-3,code:''});
 contents.loadURL=async url=>{contents.url=url;throw aborted;};
 await manager.dispatch('browser.navigate',{id:opened.id,url:'https://fixture.invalid/a'});await Promise.resolve();assert.equal((await manager.dispatch('browser.state',{id:opened.id})).error,'');
 let captures=0;const png=Buffer.alloc(24);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);contents.capturePage=async()=>{captures++;return {isEmpty:()=>false,toPNG:()=>png};};
 await manager.dispatch('browser.capture',{id:opened.id});assert.equal(captures,1);
});

test('legacy ERR_ABORTED stays ignored but numeric/string and genuine current failures remain distinct',async t=>{
 const h=harness(t),manager=h.manager(new h.Window()),opened=await manager.dispatch('browser.create',{url:'https://fixture.invalid/start'}),contents=h.views[0].webContents;
 for(const entry of [
  {error:Object.assign(new Error('legacy abort'),{code:'ERR_ABORTED'}),expected:''},
  {error:Object.assign(new Error('numeric-looking text is not an abort'),{errno:'-3',code:''}),expected:'화면을 열지 못했습니다. numeric-looking text is not an abort'},
  {error:Object.assign(new Error('real error mentioning ERR_ABORTED'),{errno:-105,code:''}),expected:'화면을 열지 못했습니다. real error mentioning ERR_ABORTED'},
  {error:Object.assign(new Error('connection refused'),{errno:-102,code:'ERR_CONNECTION_REFUSED'}),expected:'화면을 열지 못했습니다. ERR_CONNECTION_REFUSED'}
 ]) {
  contents.loadURL=async url=>{contents.url=url;throw entry.error;};await manager.dispatch('browser.navigate',{id:opened.id,url:'https://fixture.invalid/a'});await Promise.resolve();assert.equal((await manager.dispatch('browser.state',{id:opened.id})).error,entry.expected);
 }
});

test('an older load rejection cannot overwrite a newer navigation even when both URLs are identical',async t=>{
 for(const sameUrl of [false,true])for(const newestFailsFirst of [false,true])await t.test(`${sameUrl?'same':'different'} URL; ${newestFailsFirst?'new':'old'} rejects first`,async t=>{
  const h=harness(t),manager=h.manager(new h.Window()),opened=await manager.dispatch('browser.create',{url:'https://fixture.invalid/start'}),contents=h.views[0].webContents;const loads=[];
  contents.loadURL=url=>{contents.url=url;return new Promise((_resolve,reject)=>loads.push({url,reject}));};
  await manager.dispatch('browser.navigate',{id:opened.id,url:'https://fixture.invalid/first'});await manager.dispatch('browser.navigate',{id:opened.id,url:sameUrl?'https://fixture.invalid/first':'https://fixture.invalid/second'});assert.equal(loads.length,2);
  const failOld=()=>loads[0].reject(Object.assign(new Error('older request failed'),{errno:-105,code:'ERR_NAME_NOT_RESOLVED'})),failNew=()=>loads[1].reject(Object.assign(new Error('latest request failed'),{errno:-102,code:'ERR_CONNECTION_REFUSED'}));
  if(newestFailsFirst){failNew();await Promise.resolve();failOld();}else{failOld();await Promise.resolve();assert.equal((await manager.dispatch('browser.state',{id:opened.id})).error,'');failNew();}
  await Promise.resolve();assert.equal((await manager.dispatch('browser.state',{id:opened.id})).error,'화면을 열지 못했습니다. ERR_CONNECTION_REFUSED');
 });
});

test('only the latest navigate request starts after a pending emulation update',async t=>{
 const h=harness(t);let item;const manager=h.manager(new h.Window(),{onCreated:value=>{item=value;}}),opened=await manager.dispatch('browser.create',{url:'https://fixture.invalid/start'}),contents=h.views[0].webContents;
 let ready;item.emulationPromise=new Promise(resolve=>{ready=resolve;});const loaded=[];contents.loadURL=async url=>{loaded.push(url);contents.url=url;};
 const first=manager.dispatch('browser.navigate',{id:opened.id,url:'https://fixture.invalid/old'}),second=manager.dispatch('browser.navigate',{id:opened.id,url:'https://fixture.invalid/new'});ready();await Promise.all([first,second]);assert.deepEqual(loaded,['https://fixture.invalid/new']);
});

test('a delayed navigation failure cannot change a closed browser item',async t=>{
 const h=harness(t);let item;const manager=h.manager(new h.Window(),{onCreated:value=>{item=value;}}),opened=await manager.dispatch('browser.create',{url:'https://fixture.invalid/start'}),contents=h.views[0].webContents;
 let reject;contents.loadURL=()=>new Promise((_resolve,no)=>{reject=no;});await manager.dispatch('browser.navigate',{id:opened.id,url:'https://fixture.invalid/old'});await manager.dispatch('browser.close',{id:opened.id});reject(new Error('late closed request'));await Promise.resolve();assert.equal(item.error,'');
});
