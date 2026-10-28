'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createEvidenceRecorder}=require('../electron/browser-evidence.cjs');

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
      super();this.id=++contentsId;this.preferences=preferences;this.url='';this.destroyed=false;
      this.debugger=Object.assign(new EventEmitter(),{attached:false,isAttached(){return this.attached;},attach(){this.attached=true;},async sendCommand(){}});
      this.navigationHistory={canGoBack:()=>false,canGoForward:()=>false};
    }
    isDestroyed(){return this.destroyed;}
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
