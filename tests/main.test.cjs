'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createStore } = require('../electron/store.cjs');
const { createVault, atomicWrite } = require('../electron/vault.cjs');
const files = require('../electron/files.cjs');

const MAIN_PATH = path.resolve(__dirname, '../electron/main.cjs');
const MAIN_SOURCE = fs.readFileSync(MAIN_PATH, 'utf8');

// Only Electron's process/window boundary and SSH are mocked. Persistence uses the
// production store and vault on temporary files, including real SQL rollback.
async function harness(t, options = {}) {
  const root = fs.mkdtempSync('/tmp/reviewops-main-test-');
  const dataPath = path.join(root, options.defaultDataRoot ? 'ReviewOps Local' : 'data');
  const resourcesPath = path.join(root, 'resources');
  fs.mkdirSync(path.join(resourcesPath,'owned-services'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../electron/owned-node-bootstrap.cjs'),path.join(resourcesPath,'owned-services','owned-node-bootstrap.cjs'));
  const handlers = new Map();
  const appEvents = new EventEmitter();
  const state = { appQuitCalls:0, quitCloseTimers:[], switches: [], window: null, primaryWindow:null, windows:[], browserManagers:[], startup: null, liveStore: null, realVault: null, failures: {}, openResult: null, saveResult: null, messageResponse: 1, messageCalls: 0, unloadResponse: 0, unloadCalls: 0, windowMessages: [], startupErrors: [], dialogCalls:[] };
  const stores = [];
  const app = Object.assign(appEvents, {
    commandLine: {appendSwitch(...args) {state.switches.push(args);}},
    isPackaged: options.isPackaged !== false,
    setName() {}, setPath() {}, quit() {state.appQuitCalls++;},setAboutPanelOptions(value){state.aboutPanelOptions=value;},
    getPath(name) { if (name === 'temp' || name === 'appData') return root;if(name==='home')return path.join(root,'home');if(name==='exe')return path.join(resourcesPath,'ReviewOps');throw new Error(`Unexpected getPath: ${name}`); },
    getAppPath() {if(options.appPathError)throw new Error('Synthetic app path unavailable');return path.join(resourcesPath,'app.asar');},
    getVersion() { return options.version||'0.0.0-test'; },
    requestSingleInstanceLock() { return true; },
    whenReady() { return { then(callback) { state.startup = callback(); return state.startup; } }; }
  });
  class FakeBrowserWindow extends EventEmitter {
    constructor(windowOptions) {
      super(); this.options = windowOptions; this.id=state.windows.length+1;this.messages=[];
      const host=this;
      this.destroyed = false; this.maximized = false; this.fullScreen = false; this.closeCalls = 0;
      this.visible = windowOptions.show !== false; this.minimized = false; this.bounds = {x:0,y:0,width:1440,height:940};
      this.webContents = Object.assign(new EventEmitter(), {
        id:this.id+1000,
        mainFrame: { url: 'reviewops://app/index.html' },
        setWindowOpenHandler() {}, getURL() { return this.mainFrame.url; },
        isDestroyed(){return host.destroyed;},getZoomFactor(){return host.zoomFactor||1;},
        isLoadingMainFrame() { return false; },
        async executeJavaScript(){return Boolean(host.preventUnload ?? state.preventUnload);},
        send(channel, data) {
          const message={ channel, data: JSON.parse(JSON.stringify(data)) };state.windowMessages.push(message);host.messages.push(message);
          if(channel==='reviewops:qa-scope'&&data.projectId)setImmediate(()=>handlers.get('reviewops:invoke')({sender:this,senderFrame:this.mainFrame},'window.qaReady',{projectId:data.projectId}));
          if(channel==='reviewops:season-review'&&!options.manualSeasonAcknowledgment)setImmediate(()=>handlers.get('reviewops:invoke')({sender:this,senderFrame:this.mainFrame},'integration.displayed',{...data,section:'review'}));
        },
        async capturePage(bounds){(state.captureCalls||=[]).push({windowId:host.id,bounds});return {isEmpty:()=>false,toPNG:()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64')};},
        session: { setPermissionRequestHandler(callback) {state.permissionRequest=callback;}, setPermissionCheckHandler(callback) {state.permissionCheck=callback;} }
      });
      state.windows.push(this);state.primaryWindow ||= this;
      state.window = this;
    }
    static getAllWindows(){return state.windows.filter(host=>!host.destroyed);}
    static getFocusedWindow(){return state.focusedWindow||FakeBrowserWindow.getAllWindows().at(-1)||null;}
    static fromWebContents(contents){return state.windows.find(host=>host.webContents===contents)||null;}
    static fromId(id){return state.windows.find(host=>host.id===id)||null;}
    loadURL(url) { this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullScreen; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    focus() {state.focusedWindow=this;}
    getBounds() { return this.bounds; }
    getContentBounds(){return this.bounds;}
    getContentSize(){return [this.bounds.width,this.bounds.height];}
    setBounds(bounds) { this.bounds = {...bounds}; }
    maximize() { this.maximized = true; this.emit('maximize'); }
    unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    setFullScreen(value) { this.fullScreen = value; this.emit(value ? 'enter-full-screen' : 'leave-full-screen'); }
    close() {
      this.closeCalls++;
      const closeEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', closeEvent);
      if (closeEvent.defaultPrevented) return;
      const complete=()=>{
        if(this.destroyed)return;
        if (this.preventUnload ?? state.preventUnload) {
          const unloadEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
          this.webContents.emit('will-prevent-unload', unloadEvent);
          if (!unloadEvent.defaultPrevented) return;
        }
        this.destroyed = true;
        this.emit('closed');
      };
      if(this.delayClose ?? state.delayClose){(this.pendingCloses||=[]).push(complete);return;}
      complete();
    }
    flushClose(){this.pendingCloses?.shift()?.();}
    destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('closed');}
  }
  const safeStorage = new Proxy({}, {get(){throw new Error('Keychain must not be accessed');}});
  const electron = {
    app, BrowserWindow: FakeBrowserWindow, safeStorage,
    screen: { getAllDisplays: () => [{id:1,bounds:{x:0,y:0,width:1440,height:940}},{id:2,bounds:{x:1440,y:0,width:1920,height:1080}}], getPrimaryDisplay: () => ({id:1}) },
    ipcMain: { handle(name, callback) { handlers.set(name, callback); },removeHandler(name){handlers.delete(name);} },
    dialog: {
      async showOpenDialog(host,options) { state.dialogCalls.push({kind:'open',host,options});if(state.openHandler)return state.openHandler(host,options);return state.openResult || { canceled: true, filePaths: [] }; },
      async showSaveDialog(host,options) { state.dialogCalls.push({kind:'save',host,options});return state.saveResult || { canceled: true }; },
      async showMessageBox() { state.messageCalls++; return { response: state.messageResponse }; },
      showMessageBoxSync(host,options) { state.unloadCalls++;(state.unloadPrompts||=[]).push({windowId:host.id,draft:host.draftText||'',options});return state.syncDialogHandler?state.syncDialogHandler(host,options):host.unloadResponse ?? state.unloadResponse; },
      showErrorBox(title, message) { state.startupErrors.push({ title, message }); }
    },
    shell: { async openPath() { return ''; }, async openExternal() {} },
    clipboard: {writeText(text){if(options.clipboardWrite)return options.clipboardWrite(text,state);if(state.clipboardError)throw state.clipboardError;state.clipboardText=text;(state.clipboardWrites||=[]).push(text);}},
    protocol: { registerSchemesAsPrivileged() {}, handle(_scheme,callback) { state.protocol=callback; } },
    net: { async fetch() { throw new Error('Network access must not occur in main tests'); } },
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} }
  };
  function wrapMutation(vault, method) {
    return (...args) => {
      if (state.failures[method] === 'before') throw new Error(`simulated vault ${method} failure before write`);
      const result = vault[method](...args);
      if (state.failures[method] === 'after') throw new Error(`simulated vault ${method} failure after write`);
      return result;
    };
  }
  const customRequire = name => {
    if (name === 'electron') return electron;
    if (name === './store.cjs') return { createStore(options) {
      const store = createStore(options); stores.push(store);
      if (options.dbPath === path.join(dataPath, 'reviewops.sqlite')) state.liveStore = store;
      return store;
    } };
    if (name === './vault.cjs') return { atomicWrite(file, content) {
      const result = atomicWrite(file, content);
      options.afterMainAtomicWrite?.({file, store:state.liveStore});
      return result;
    }, createVault(file, storage) {
      const vault = createVault(file, storage); state.realVault = vault;
      return { ...vault, get: wrapMutation(vault, 'get'), commit: wrapMutation(vault, 'commit'), clear: wrapMutation(vault, 'clear'), delete: wrapMutation(vault, 'delete') };
    } };
    if (name === './ssh.cjs') return { createSshService: () => ({ close() {}, async openShell(_config,{onData,onClose}) { if(!state.allowShell)throw new Error('SSH must not run in these tests');onData(Buffer.from('session ready'));return {write:data=>onData(Buffer.from(data)),resize(){},close(){onClose()}}; }, test() { if(state.trustFingerprint)throw Object.assign(new Error('Synthetic SSH trust required'),{code:'SSH_TRUST_REQUIRED',fingerprint:state.trustFingerprint});throw new Error('SSH must not run in these tests'); } }) };
    if (name === './terminal.cjs') return require('../electron/terminal.cjs');
    if (name === './browser.cjs') return {createBrowserManager(host,browserOptions={}){
      const manager={host,options:browserOptions,closed:false,views:new Map(),async dispatch(action,payload){
        if(action==='browser.create'){const view={id:options.browserId?.({host,payload})||crypto.randomUUID(),url:payload.url};this.views.set(view.id,view);await options.browserCreateGate?.({host,manager:this,view,payload});return view;}
        if(action==='browser.close'){this.views.delete(payload.id);return {closed:true};}
        const view=this.views.get(payload.id);if(!view)throw new Error('열린 화면을 찾을 수 없습니다.');return view;
      },closeAll(){this.closed=true;this.views.clear();},async flush(){}};
      state.browserManagers.push(manager);return manager;
    }};
    if (name === './agents.cjs') return {createAgentManager:({onUpdate,...agentOptions})=>{
      state.agentOptions=agentOptions;
      const validator=require('../electron/agents.cjs').createAgentManager({spawn(){throw new Error('CLI must not run in main tests');}});
      state.agentStarts=[];state.agentRestores=[];state.agentValidations=[];state.agentPreflights=[];state.agentCancelled=[];state.agentCallbacks=new Map();state.agentUpdate=job=>(state.agentCallbacks.get(job.id)||onUpdate)(job);
      return {async preflight(config,settings){state.agentPreflights.push({config,settings});await state.preflightGate;if(state.preflightError)throw state.preflightError;return {installed:true,loggedIn:true,binary:settings.binary,workPath:settings.workPath};},login({id,serviceId}){const job={id,serviceId,kind:'login',status:'running',output:'synthetic login'};state.agentStarts.push(job);return job;},validateStart(input){state.agentValidations.push(input);validator.validateStart(input);},start(input){state.agentStarts.push(input);state.agentCallbacks.set(input.id,input.onUpdate);validator.validateStart(input);if(state.agentStartError)throw new Error('synthetic agent start failure');return {id:input.id,status:'running'};},restore(input){state.agentRestores.push(input);state.agentCallbacks.set(input.job.id,input.onUpdate);(input.onUpdate||onUpdate)(input.job);return input.job;},async cancel(id){if(state.agentCancelError)throw new Error('synthetic agent cancel failure');const input=state.agentStarts.find(item=>item.id===id);assert(input);state.agentCancelled.push(id);if(!state.agentCancelWithoutFinal)(input.onUpdate||onUpdate)({...input,status:'cancelled',finishedAt:new Date().toISOString(),...state.agentCancelFinal});if(state.agentCancelGate)await state.agentCancelGate(id);},async environment(config,settings){state.environmentCheck={config,settings};(state.environmentChecks||=[]).push({config,settings});await state.environmentGate;return state.agentEnvironment||{installed:true,loggedIn:true,models:[],modelSource:'none',defaultModel:'',defaultReasoningEffort:''};},async session(config,settings,sessionId){state.sessionCheck={config,settings,sessionId};return {available:true,sessionId,model:settings.model,status:'available'};},closeAll:async options=>{state.agentCloseOptions=options;await state.agentCloseGate?.();}};
    }};
    if (name === './automation-api.cjs' || name === path.join(resourcesPath,'mcp','automation-api.cjs')) {
      state.automationModulePath=name;
      return require('../electron/automation-api.cjs');
    }
    if(name==='./project-service-runtime.cjs'){const runtime=require('../electron/project-service-runtime.cjs');return {...runtime,createProjectServiceRuntime(options){state.managedServices=runtime.createProjectServiceRuntime(options);return state.managedServices;}};}
    if(name==='./review-versions.cjs'&&(options.versionListReadObserver||options.versionListReadGate||options.versionListReturnGate)){
      const versions=require('../electron/review-versions.cjs');
      return {...versions,async listReviewVersions(store,reviewId,read,operation){
        const result=await versions.listReviewVersions(store,reviewId,async file=>{
          options.versionListReadObserver?.(file);await options.versionListReadGate?.({file,store});return read(file);
        },operation);
        await options.versionListReturnGate?.({store,reviewId,result});return result;
      }};
    }
    if(name==='./review-versions.cjs'&&options.versionReadGate){
      const versions=require('../electron/review-versions.cjs');
      return {...versions,saveReviewVersion(store,input,read,operation){return versions.saveReviewVersion(store,input,async file=>{await options.versionReadGate({file,store});return read(file);},operation);}};
    }
    if (name === './qa-automation.cjs') {
      const qa = require('../electron/qa-automation.cjs');
      return {...qa, createQaAutomation(options) { state.qaOptions = options;state.qaApi=qa.createQaAutomation(options);return state.qaApi; }};
    }
    if (['./ops-qa.cjs','./work-directory.cjs','./review-versions.cjs','./review-copy.cjs','./agent-requests.cjs','./agent-copy-draft.cjs','./agent-execution-settings.cjs','./local-shared-data-query.cjs','./project-qa-scope.cjs','./service-readiness.cjs','./project-service-runtime.cjs'].includes(name))return require('../electron/'+name.slice(2));
    if (name === './updates.cjs') return require('../electron/updates.cjs');
    if (name === './build-info.cjs') return {...require('../electron/build-info.cjs'),getBuildInfo:version=>options.buildInfo||({channel:'stable',version})};
    if (name === './model-cache.cjs') return require('../electron/model-cache.cjs');
    if (name === './model-targets.cjs') return require('../electron/model-targets.cjs');
    if (name === './app-language.cjs') return require('../electron/app-language.cjs');
    if (name === './review-categories.json') return require('../electron/review-categories.json');
    if (name === './archive.cjs') return require('../electron/archive.cjs');
    if (name === './html-preview.cjs') return require('../electron/html-preview.cjs');
    if (name === './files.cjs') return files;
    if (name === './agent-files.cjs') return require('../electron/agent-files.cjs');
    if (name === './codex/index.cjs') return {createCodexManager:async options=>{state.codexOptions=options;return {registerHandlers(){state.codexRegistered=true;},localRuntime(){return state.codexRuntime;},async close(){state.codexClosed=true;if(state.codexCloseError)throw new Error('synthetic close failure');},async resolveHost(alias){if(!state.codexHost||state.codexHost.alias!==alias)throw new Error('SSH 호스트를 찾을 수 없습니다.');return state.codexHost;}};}};
    if(name==='./ops-manager.cjs')return {createOpsManager:async config=>{state.opsOptions=config;const {createOpsManager}=require('../electron/ops-manager.cjs');await options.opsBeforeCreate?.(config);state.opsManager=await createOpsManager({...config,...(options.opsCreateSession?{createSession:options.opsCreateSession}:{}),resolveTarget:async input=>{await options.opsTargetGate?.();return config.resolveTarget(input);}});return state.opsManager;}};
    if (name === './season-integration.cjs') return { createSeasonIntegration: async options => {
      state.seasonIntegration = options;
      if (state.seasonError) throw new Error(state.seasonError);
      return { close: async () => { state.seasonIntegrationClosed = true; } };
    } };
    if (name === './tool-integration.cjs') return {createToolIntegration:async options=>{state.toolIntegration=options;let unregistered=false;return {
      close:async()=>{state.toolIntegrationClosed=true;(state.toolBridgeCalls||=[]).push('close');await state.toolCloseGate;},
      unregisterForFinalQuitSync(){if(!unregistered){unregistered=true;(state.toolBridgeCalls||=[]).push('unregister');}}
    };}};
    if (name === './instance-discovery.cjs') return require('../electron/instance-discovery.cjs');
    if (name.startsWith('node:')) return require(name);
    if(name==='./viewer-sessions.cjs')return require('../electron/viewer-sessions.cjs');
    throw new Error(`Unexpected module: ${name}`);
  };
  t.after(() => {
    appEvents.emit('will-quit');
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  options.prepare?.({dataPath,root});
  state.seasonError = options.seasonError;
  vm.runInNewContext(MAIN_SOURCE, {
    require: customRequire, __dirname: path.dirname(MAIN_PATH),
    process: { env: {...options.registryEnvironment,...(options.defaultDataRoot ? {} : { REVIEWOPS_DATA_DIR: dataPath })}, platform: options.platform || process.platform, arch: process.arch, resourcesPath },
    URL, Response, Buffer, Date:options.quitClock?class extends Date{static now(){return options.quitClock.now;}}:Date, console: {...console, warn(...args) { (state.seasonWarnings ||= []).push(args); }}, setImmediate,
    setTimeout(callback,delay,...args){
      if((delay===10000||callback.name==='quitCloseExpired')&&options.captureQuitCloseTimers)state.quitCloseTimers.push(callback);
      if((delay===10000||callback.name==='quitCloseExpired')&&options.controlQuitCloseTimers){const handle={callback,delay,active:true,unref(){}};(state.controlledQuitTimers||=[]).push(handle);return handle;}
      return setTimeout(callback,delay===10000&&options.quitCloseTimeoutMs?options.quitCloseTimeoutMs:delay,...args);
    },clearTimeout(handle){if(options.controlQuitCloseTimers&&state.controlledQuitTimers?.includes(handle))handle.active=false;else clearTimeout(handle);}
  }, { filename: MAIN_PATH, timeout: 5000 });
  await state.startup;
  assert.deepEqual(state.startupErrors, []);
  assert(state.window);
  const handler = handlers.get('reviewops:invoke');
  assert.equal(typeof handler, 'function');
  const event = (host=state.window) => ({ sender: host.webContents, senderFrame: host.webContents.mainFrame });
  const invoke = (action, payload = {}, sender = event()) => handler(sender, action, payload);
  const success = async (action, payload, sender=event()) => {
    const result = await invoke(action, payload, sender);
    assert.equal(result.ok, true, result.error?.message);
    // VM creates objects in another realm; return plain local values to assertions.
    return result.data === undefined ? undefined : JSON.parse(JSON.stringify(result.data));
  };
  // Model collection is independent of window actions. Settle its synthetic
  // startup work before each test begins observing window-specific events.
  await success('modelCache.refresh');
  state.windowMessages=[];
  const forWindow=host=>({event:()=>event(host),invoke:(action,payload)=>invoke(action,payload,event(host)),success:(action,payload)=>success(action,payload,event(host))});
  const ops=(method,input,sender=event())=>handlers.get('ops:invoke')(sender,method,input);
  return { root, dataPath, state, invoke, success, event, forWindow, appEvents,ops };
}

async function seed(h) {
  const group = await h.success('group.save', { name: '합성 그룹' });
  const service = await h.success('service.save', {
    groupId: group.id, name: '합성 SSH', kind: 'ssh', host: 'example.test', username: 'tester', rootPath: '/tmp/test',
    authType: 'password', password: 'synthetic-old-password'
  });
  const project = await h.success('project.save', { groupId: group.id, name: '합성 프로젝트', serviceIds: [service.id] });
  const review = await h.success('review.save', { projectId: project.id, serviceId: service.id, title: '합성 리뷰', body: '보존할 내용' });
  return { group, service, project, review };
}

test('attachment.add refuses a picker completion after its original QA scope is released', async t => {
  const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow);
  await main.success('window.openProject', {projectId:a.project.id});
  const host = await projectHost(h, a.project.id), client = h.forWindow(host);
  const qa = await h.state.toolIntegration.automationHandler('automation.qa.open', {projectId:a.project.id, clientId:'attachment-picker-owner'});
  const file = path.join(h.root, 'owned-picker-material.txt');
  fs.writeFileSync(file, 'Original privately selected attachment');
  let releasePicker, pickerStarted;
  const ready = new Promise(resolve => pickerStarted = resolve);
  const picker = new Promise(resolve => releasePicker = resolve);
  h.state.openHandler = async () => { pickerStarted(); return picker; };
  const pending = client.invoke('attachment.add', {reviewId:a.review.id});
  let result, before, files, notices;
  try {
    await ready;
    await h.state.toolIntegration.automationHandler('automation.qa.release', qa);
    before = h.state.liveStore.exportData();
    files = fs.readdirSync(path.join(h.dataPath, 'attachments')).sort();
    notices = h.state.windowMessages.length;
    releasePicker({canceled:false, filePaths:[file]});
    result = await pending;
  } finally {
    releasePicker({canceled:true, filePaths:[]});
    await pending;
  }
  assert.equal(result.ok, false, 'The original QA scope must still authorize the final attachment write');
  assert.equal(result.error.code, 'TARGET_MISMATCH');
  assert.deepEqual(h.state.liveStore.exportData(), before);
  assert.deepEqual(fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), files);
  assert.equal(h.state.windowMessages.length, notices, 'The refused attachment adds no data-change notice');
});

test('attachment.add refuses an original QA scope after release and same-window reopen', async t => {
  const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow);
  await main.success('window.openProject', {projectId:a.project.id});
  const client = h.forWindow(await projectHost(h, a.project.id));
  const qa = await h.state.toolIntegration.automationHandler('automation.qa.open', {projectId:a.project.id, clientId:'attachment-original-scope'});
  const file = path.join(h.root, 'reopened-scope-attachment.txt'); fs.writeFileSync(file, 'Do not renew the original operation');
  let entered, release; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  h.state.openHandler = () => { entered(); return gate; };
  const pending = client.invoke('attachment.add', {reviewId:a.review.id}); let result, before, files, notices;
  try {
    await ready; await h.state.toolIntegration.automationHandler('automation.qa.release', qa);
    const reopened = await h.state.toolIntegration.automationHandler('automation.qa.open', {projectId:a.project.id, clientId:'attachment-new-scope'});
    assert.equal(reopened.windowId, qa.windowId); assert.notEqual(reopened.sessionId, qa.sessionId);
    before = h.state.liveStore.exportData(); files = fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(); notices = h.state.windowMessages.length;
    release({canceled:false, filePaths:[file]}); result = await pending;
  } finally { release({canceled:true, filePaths:[]}); await pending; }
  assert.equal(result.ok, false, 'A new same-window QA session must not renew the original attachment operation');
  assert.equal(result.error.code, 'TARGET_MISMATCH'); assert.deepEqual(h.state.liveStore.exportData(), before);
  assert.deepEqual(fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), files); assert.equal(h.state.windowMessages.length, notices);
});

test('attachment.add survives another window scope change and an unchanged own QA activation', async t => {
  const h = await harness(t), a = await seed(h), b = await seed(h), main = h.forWindow(h.state.primaryWindow);
  await main.success('window.openProject', {projectId:a.project.id}); const client = h.forWindow(await projectHost(h, a.project.id));
  const qa = await h.state.toolIntegration.automationHandler('automation.qa.open', {projectId:a.project.id, clientId:'attachment-stable-scope'});
  const file = path.join(h.root, 'unchanged-scope-attachment.txt'); fs.writeFileSync(file, 'Keep the unchanged original scope');
  let entered, release; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  h.state.openHandler = () => { entered(); return gate; };
  const pending = client.invoke('attachment.add', {reviewId:a.review.id}); let result;
  try {
    await ready;
    const other = await h.state.toolIntegration.automationHandler('automation.qa.open', {projectId:b.project.id, clientId:'other-attachment-window'});
    await h.state.toolIntegration.automationHandler('automation.qa.release', other);
    // Exercise the actual main callback supplied to the real QA manager.
    h.state.qaOptions.onActiveChange(h.state.qaOptions.getWindow(qa.windowId), true);
    release({canceled:false, filePaths:[file]}); result = await pending;
  } finally { release({canceled:true, filePaths:[]}); await pending; }
  assert.equal(result.ok, true, result.error?.message); assert.equal(result.data.length, 1);
  assert.equal((await client.success('attachment.read', {id:result.data[0].id})).content, 'Keep the unchanged original scope');
});

for (const change of ['main-frame replacement', 'restored epoch', 'review rebirth', 'review move']) {
  test('attachment.add refuses its ' + change + ' while the picker is held', async t => {
    const h = await harness(t), a = await seed(h), client = h.forWindow(h.state.primaryWindow);
    const file = path.join(h.root, 'held-attachment.txt'); fs.writeFileSync(file, 'Unpublished attachment bytes');
    let entered, release; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
    h.state.openHandler = () => { entered(); return gate; };
    const pending = client.invoke('attachment.add', {reviewId:a.review.id});
    let result, before, files, notices;
    try {
      await ready;
      if (change === 'main-frame replacement') h.state.primaryWindow.webContents.mainFrame = {url:'reviewops://app/index.html'};
      else if (change === 'restored epoch') h.state.liveStore.importData(h.state.liveStore.exportData());
      else if (change === 'review rebirth') {
        const db = h.state.liveStore.db, raw = {...db.prepare('SELECT * FROM reviews WHERE id=?').get(a.review.id)}, keys = Object.keys(raw);
        h.state.liveStore.deleteReview(a.review.id);
        db.prepare('INSERT INTO reviews(' + keys.join(',') + ') VALUES(' + keys.map(() => '?').join(',') + ')').run(...keys.map(key => raw[key]));
      } else {
        const destination = h.state.liveStore.saveProject({groupId:a.group.id, name:'Other attachment project', serviceIds:[a.service.id]});
        h.state.liveStore.db.prepare('UPDATE reviews SET projectId=?,number=(SELECT COALESCE(MAX(number),0)+1 FROM reviews WHERE projectId=?) WHERE id=?').run(destination.id, destination.id, a.review.id);
      }
      before = h.state.liveStore.exportData(); files = fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(); notices = h.state.windowMessages.length;
      release({canceled:false, filePaths:[file]}); result = await pending;
    } finally { release({canceled:true, filePaths:[]}); await pending; }
    assert.equal(result.ok, false);
    assert.equal(result.error.code, change === 'main-frame replacement' ? 'ACCESS_DENIED' : change === 'restored epoch' ? 'STALE_EPOCH' : 'STALE_REVIEW');
    if(change!=='main-frame replacement')assert.equal(result.error.message, '리뷰가 변경되었습니다. 파일을 다시 선택하십시오.');
    assert.deepEqual(h.state.liveStore.exportData(), before);
    assert.deepEqual(fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), files);
    assert.equal(h.state.windowMessages.length, notices);
  });
}

test('attachment.add permits agent history and next-service changes in its original review', async t => {
  const h = await harness(t), a = await seed(h), client = h.forWindow(h.state.primaryWindow);
  await client.success('service.save', {id:a.service.id, agentEnabled:1});
  const job = await client.success('agent.start', {reviewId:a.review.id, requestId:crypto.randomUUID(), prompt:'Owned concurrent history'});
  const file = path.join(h.root, 'history-attachment.txt'); fs.writeFileSync(file, 'Keep the original selected bytes');
  let entered, release; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  h.state.openHandler = () => { entered(); return gate; };
  const pending = client.invoke('attachment.add', {reviewId:a.review.id}); let result;
  try {
    await ready;
    h.state.agentUpdate({...job, kind:'agent', status:'completed', response:'Actual accepted callback history', finishedAt:new Date().toISOString()});
    assert.equal(h.state.liveStore.get('agent_runs', job.id).response, 'Actual accepted callback history', 'Persist the accepted callback before unlinking its original service');
    const next = h.state.liveStore.saveService({groupId:a.group.id, name:'Next attachment selection', kind:'local', rootPath:h.root});
    h.state.liveStore.setProjectServices(a.project.id, [a.service.id, next.id]);
    h.state.liveStore.saveReview({...h.state.liveStore.get('reviews', a.review.id), serviceId:next.id});
    h.state.liveStore.setProjectServices(a.project.id, [next.id]);
    release({canceled:false, filePaths:[file]}); result = await pending;
    assert.equal(result.ok, true, result.error?.message); assert.equal(result.data.length, 1);
    assert.equal(h.state.liveStore.get('reviews', a.review.id).serviceId, next.id);
  } finally { release({canceled:true, filePaths:[]}); await pending; }
  assert.equal(h.state.liveStore.get('agent_runs', job.id).response, 'Actual accepted callback history');
  assert.equal((await client.success('attachment.read', {id:result.data[0].id})).content, 'Keep the original selected bytes');
});

test('attachment.add rolls back its failed commit without removing retained files or another window token', async t => {
  const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow);
  const existing = await addFile(h, a.review.id, 'Keep this existing attachment');
  await main.success('window.openProject', {projectId:a.project.id}); const other = h.forWindow(await projectHost(h, a.project.id));
  const draft = path.join(h.root, 'other-window-draft.txt'); fs.writeFileSync(draft, 'Keep this other window token');
  const [token] = await other.success('attachment.stageFiles', {paths:[draft]});
  const file = path.join(h.root, 'rejected-new-file.txt'); fs.writeFileSync(file, 'Reject only this new attachment');
  h.state.openResult = {canceled:false, filePaths:[file]};
  const before = h.state.liveStore.exportData(), files = fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), notices = h.state.windowMessages.length;
  const add = h.state.liveStore.addAttachment; h.state.liveStore.addAttachment = function(input) { add.call(this, input); throw new Error('Owned attachment commit failure'); };
  let result; try { result = await main.invoke('attachment.add', {reviewId:a.review.id}); } finally { h.state.liveStore.addAttachment = add; }
  assert.equal(result.ok, false); assert.match(result.error.message, /Owned attachment commit failure/);
  assert.deepEqual(h.state.liveStore.exportData(), before); assert.deepEqual(fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), files);
  assert.equal(h.state.windowMessages.length, notices);
  assert.equal((await main.success('attachment.read', {id:existing.id})).content, 'Keep this existing attachment');
  assert.equal((await other.success('attachment.stagePreview', {token:token.token})).content, 'Keep this other window token');
});

test('attachment.add retains primitive review and activity targets across the picker boundary', async t => {
  const h = await harness(t), a = await seed(h), b = await seed(h);
  const activity = await h.success('activity.add', {reviewId:a.review.id, body:'Original activity'});
  const foreign = await h.success('activity.add', {reviewId:b.review.id, body:'Other activity'});
  const file = path.join(h.root, 'activity-material.txt'); fs.writeFileSync(file, 'Original activity material');
  let entered, release; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  h.state.openHandler = () => { entered(); return gate; };
  const input = {reviewId:a.review.id, activityId:activity.id}, pending = h.invoke('attachment.add', input); let result;
  try { await ready; input.reviewId = b.review.id; input.activityId = foreign.id; release({canceled:false, filePaths:[file]}); result = await pending; }
  finally { release({canceled:true, filePaths:[]}); await pending; }
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data[0].reviewId, a.review.id); assert.equal(result.data[0].activityId, activity.id);
  assert.equal(h.state.liveStore.snapshot().attachments.some(row => row.reviewId === b.review.id), false);
});

test('attachment.add rechecks its epoch after physical file publication and before the final transaction', async t => {
  let armed = false, publications = 0, expected, writtenFile;
  const h = await harness(t, {afterMainAtomicWrite({file, store}) {
    if(!armed)return;
    assert.equal(path.dirname(file), path.join(h.dataPath, 'attachments'));
    armed = false; publications++; writtenFile = file;
    assert.equal(fs.readFileSync(file, 'utf8'), 'Only this unpublished file belongs to the refused operation');
    // A controlled Store seam after the real write, not a GUI restore schedule.
    store.importData(store.exportData()); expected = store.exportData();
  }}), a = await seed(h);
  const existing = await addFile(h, a.review.id, 'Retain this previously committed attachment');
  const existingPath = path.join(h.dataPath, 'attachments', existing.storageName), retained = fs.readFileSync(existingPath);
  const files = fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), notices = h.state.windowMessages.length;
  const file = path.join(h.root, 'final-transaction-material.txt'); fs.writeFileSync(file, 'Only this unpublished file belongs to the refused operation');
  h.state.openResult = {canceled:false, filePaths:[file]}; armed = true;
  const result = await h.invoke('attachment.add', {reviewId:a.review.id});
  assert.equal(publications, 1); assert.equal(result.ok, false); assert.equal(result.error.code, 'STALE_EPOCH');
  assert.equal(result.error.message, '리뷰가 변경되었습니다. 파일을 다시 선택하십시오.');
  assert.deepEqual(h.state.liveStore.exportData(), expected);
  assert.equal(fs.existsSync(writtenFile), false); assert.deepEqual(fs.readFileSync(existingPath), retained);
  assert.deepEqual(fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), files);
  assert.equal(h.state.windowMessages.length, notices);
});

test('local agent runtime lookup reads the current trusted account-manager selection without changing project settings', async t => {
 const h=await harness(t),group=await h.success('group.save',{name:'Local runtime fixture'});
 const project=await h.success('project.save',{groupId:group.id,name:'Local default CLI',connection:{kind:'local',rootPath:h.root,agentEnabled:true}}),service=project.connection;
 const runtime={available:true,path:'/fixture/bundled-codex',command:'/usr/bin/arch',args:['-arm64','/fixture/bundled-codex']};
 h.state.codexRuntime=runtime;
 await h.success('agent.environment',{serviceId:service.id});
 assert.deepEqual(h.state.agentOptions.getLocalRuntime(),runtime);
 const changed={...runtime,path:'/fixture/new-bundled-codex',args:['-arm64','/fixture/new-bundled-codex']};
 h.state.codexRuntime=changed;assert.deepEqual(h.state.agentOptions.getLocalRuntime(),changed);
 const saved=(await h.success('snapshot')).projects.find(row=>row.id===project.id);
 assert.equal(saved.connection.agentBinary,service.agentBinary);
 assert.equal(h.state.environmentCheck.settings.binary,service.agentBinary||'codex');
});
test('detailed test identity agrees across app information, native About and copied information',async t=>{
 const buildInfo={channel:'test',version:'1.2.11',buildNumber:11001,developmentNumber:10,commit:'a'.repeat(40),builtAt:'2026-11-01T16:00:00.000Z'};
 const h=await harness(t,{version:'1.2.11',buildInfo,isPackaged:false});
 assert.equal(h.state.aboutPanelOptions.applicationVersion,'1.2.11-dev-10');assert.equal(h.state.aboutPanelOptions.version,'11001');
 assert.equal((await h.success('app.info')).build.developmentNumber,10);
 await h.success('update.copyInfo');assert.match(h.state.clipboardText,/1\.2\.11-dev-10/);assert.match(h.state.clipboardText,/11001/);assert.match(h.state.clipboardText,/UTC/);
 const {project,review}=await seed(h),snapshot=await h.success('snapshot');
 assert.ok(snapshot.projects.some(item=>item.id===project.id));assert.ok(snapshot.reviews.some(item=>item.id===review.id));
});

test('bridge connection metadata captures actual startup identity independently of later focus and closed windows',async t=>{
 const buildInfo={channel:'test',version:'1.4.0',buildNumber:12345,developmentNumber:7,commit:'a'.repeat(40),builtAt:'2026-11-03T00:00:00.000Z'};
 const h=await harness(t,{version:'1.4.0',buildInfo,isPackaged:false}),metadata=h.state.toolIntegration.connectionInfo;
 const {publicConnectionInfo}=require('../electron/tool-integration.cjs');
 const first=publicConnectionInfo(metadata,h.dataPath);
 assert.equal(first.app.version,'1.4.0');assert.equal(first.app.displayVersion,'1.4.0-dev-7');assert.deepEqual(first.app.build,buildInfo);assert.equal(first.app.isPackaged,false);
 assert.equal(metadata.dataPath,h.dataPath);assert.equal(metadata.homePath,path.join(h.root,'home'));assert.equal(metadata.appPath,path.join(h.root,'resources','app.asar'));assert.equal(metadata.executablePath,path.join(h.root,'resources','ReviewOps'));assert.equal(first.location.dataRootSource,'environment');
 assert.match(first.instanceId,/^[a-f0-9-]{36}$/);assert.ok(Object.values(metadata).every(value=>typeof value!=='function'));
 const getPath=h.appEvents.getPath,getAppPath=h.appEvents.getAppPath;
 try{
  h.appEvents.getPath=()=>{throw new Error('Metadata must not requery paths');};h.appEvents.getAppPath=()=>{throw new Error('Metadata must not requery app path');};
  h.state.focusedWindow={focus(){throw new Error('Metadata must not use native focus');}};
  h.state.window.close();
  assert.deepEqual(publicConnectionInfo(metadata,h.dataPath),first);
 }finally{h.appEvents.getPath=getPath;h.appEvents.getAppPath=getAppPath;}
});

test('default-data-root bridge metadata retains unknown stable source as null',async t=>{
 const h=await harness(t,{version:'1.4.0',defaultDataRoot:true}),metadata=h.state.toolIntegration.connectionInfo;
 const result=require('../electron/tool-integration.cjs').publicConnectionInfo(metadata,h.dataPath);
 assert.equal(metadata.dataPath,path.join(h.root,'ReviewOps Local'));assert.equal(result.location.dataRootSource,'platform-default');
 assert.equal(result.app.displayVersion,'1.4.0');assert.deepEqual(result.app.build,{channel:'stable',version:'1.4.0',buildNumber:null,developmentNumber:null,commit:null,builtAt:null});
});

test('a missing actual app path leaves diagnostics unavailable without inventing identity or disabling the bridge',async t=>{
 const h=await harness(t,{appPathError:true});
 assert.equal(h.state.toolIntegration.connectionInfo,undefined);
 const result=await h.state.toolIntegration.automationHandler('automation.projects.list',{});
 assert.deepEqual(result,{projects:[]});assert.equal(h.state.startupErrors.length,0);
});

async function waitForValue(read, message) {
  for(let attempt=0;attempt<100;attempt++) {
    const value=await read();if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail(message);
}
async function projectHost(h,projectId) {
  return waitForValue(async()=>{
    for(const host of h.state.windows.filter(host=>!host.isDestroyed())) {
      const result=await h.forWindow(host).invoke('window.context');
      if(result.ok&&result.data.projectId===projectId)return host;
    }
  },`No window opened for project ${projectId}`);
}
const pendingRoute=(h,host)=>waitForValue(()=>h.forWindow(host).success('integration.pending'),'The project window did not receive its review');
const routeWindowId=host=>new URL(host.webContents.getURL()).searchParams.get('windowId');

function savedRemoteFixture({dataPath},change={}) {
  fs.mkdirSync(dataPath,{recursive:true});
  const store=createStore({dbPath:path.join(dataPath,'reviewops.sqlite')});
  try {
    const group=store.saveGroup({name:'재연결 검사'});
    const service=store.saveService({groupId:group.id,name:'서버 작업',kind:'ssh',host:'example.test',username:'tester',rootPath:'/tmp/project',authType:'password',agentEnabled:1,agentBinary:'codex',agentModel:'fixture-model'});
    const project=store.saveProject({groupId:group.id,name:'프로젝트',serviceIds:[service.id]});
    const review=store.saveReview({projectId:project.id,serviceId:service.id,title:'앱 재시작 후 계속'});
    const sessionScope='target-v2:'+crypto.createHash('sha256').update(JSON.stringify(['ssh',service.host,service.port,service.username,service.hostAlias||'',service.sshConfigPath||'',service.rootPath,service.agentBinary,service.agentModel])).digest('hex');
    const run=store.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'보존할 요청',status:'running',workPath:service.rootPath,model:service.agentModel,sessionScope,response:'기존 부분 응답',remoteExecution:{version:1,ready:true,stdoutOffset:200,stderrOffset:0},...change.run});
    if(change.service)store.saveService({id:service.id,...change.service});
    const vault=createVault(path.join(dataPath,'credentials.json'));vault.commit(service.id,vault.prepare({password:'fixture-resume-password'}));
    return {run,service};
  }finally{store.close();}
}

test('packaged and source startup load the shared MCP API from their respective locations',async t=>{
  for(const isPackaged of [true,false]) {
    const h=await harness(t,{isPackaged});
    assert.equal(h.state.automationModulePath,isPackaged?path.join(h.root,'resources','mcp','automation-api.cjs'):'./automation-api.cjs');
    const result=await h.state.toolIntegration.automationHandler('automation.projects.list',{});
    assert.deepEqual(result,{projects:[]});
  }
});

test('startup reconnects a durable SSH job using its saved target and vault without starting another request',async t=>{
  let fixture;const h=await harness(t,{prepare:paths=>{fixture=savedRemoteFixture(paths);}});
  assert.equal(h.state.agentRestores.length,1);assert.equal(h.state.agentStarts.length,0);
  const restored=h.state.agentRestores[0];
  assert.equal(restored.job.id,fixture.run.id);assert.equal(restored.config.password,'fixture-resume-password');
  assert.equal(restored.settings.workPath,fixture.run.workPath);assert.equal(restored.settings.model,fixture.run.model);
  assert.equal((await h.success('snapshot')).agentRunning,1);
  assert.equal((await h.success('agent.read',{id:fixture.run.id})).response,'기존 부분 응답');
  h.state.window.close();h.appEvents.emit('before-quit',{preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.state.agentCloseOptions.preserveRemote,true);
});

test('startup retains saved SSH output and refuses to reconnect a changed execution target',async t=>{
  let fixture;const h=await harness(t,{prepare:paths=>{fixture=savedRemoteFixture(paths,{service:{host:'changed.example.test'}});}});
  assert.deepEqual(h.state.agentRestores,[]);
  const saved=await h.success('agent.read',{id:fixture.run.id});assert.equal(saved.status,'interrupted');assert.equal(saved.response,'기존 부분 응답');
  assert.match(saved.error,/접속 설정/);assert.equal((await h.success('snapshot')).agentRunning,0);
});

test('startup interrupts remote launch preparation instead of launching it again',async t=>{
  let fixture;const h=await harness(t,{prepare:paths=>{fixture=savedRemoteFixture(paths,{run:{remoteExecution:{version:1,ready:false,stdoutOffset:0,stderrOffset:0}}});}});
  assert.deepEqual(h.state.agentRestores,[]);assert.equal((await h.success('agent.read',{id:fixture.run.id})).status,'interrupted');
});

test('Windows starts the standalone app without opening the Unix-only Season AI connection', async t => {
  const h = await harness(t, { platform: 'win32' });
  assert.equal(h.state.seasonIntegration, undefined);
  assert.equal(h.state.codexRegistered, true);
  assert.equal((await h.success('snapshot')).projects.length, 0);
});

test('an unavailable optional Season AI connection leaves the app open', async t => {
  const h = await harness(t, { platform: 'darwin', seasonError: 'fixture integration failure' });
  assert.equal(h.state.seasonWarnings.length, 1);
  assert.equal(h.state.window.isDestroyed(), false);
  assert.equal((await h.success('snapshot')).groups.length, 0);
});

test('Season AI navigation preserves data and moves an already fullscreen window to the requested display', async t => {
  const h = await harness(t);
  const { review, project } = await seed(h);
  const before = await h.success('snapshot');
  await h.state.seasonIntegration.showReview({reviewId:review.id,fullscreen:false});
  const host=await projectHost(h,project.id);host.fullScreen=true;
  const bounds = {x:1440,y:0,width:1920,height:1080};
  const result = await h.state.seasonIntegration.showReview({ reviewId: review.id, fullscreen: true, displayBounds: bounds });
  assert.equal(result.shown, true); assert.equal(result.fullscreen, true);
  assert.equal(result.view,'project');assert.equal(result.projectId,project.id);assert.equal(result.reviewId,review.id);
  assert.equal(result.windowId,routeWindowId(host));assert.notEqual(host,h.state.primaryWindow);assert.equal(h.state.windows.length,2);
  assert.deepEqual(host.getBounds(), bounds);
  assert.equal((await h.success('integration.pending')).reviewId, review.id);
  assert.ok(h.state.windowMessages.some(item => item.channel === 'reviewops:season-review' && item.data.reviewId === review.id));
  assert.deepEqual(await h.success('snapshot'), before);
  assert.equal(h.state.seasonIntegration.workspaceRoot, path.join(h.root, 'Season AI', 'reviewops-workspace'));
});

test('Season AI waits for the matching visible project review instead of accepting an open window',async t=>{
  const h=await harness(t,{manualSeasonAcknowledgment:true});
  const {review,project}=await seed(h);
  let completed=false;
  const showing=h.state.seasonIntegration.showReview({reviewId:review.id,fullscreen:false}).then(result=>{completed=true;return result;});
  const host=await projectHost(h,project.id),client=h.forWindow(host),pending=await pendingRoute(h,host);
  assert.equal(pending.projectId,project.id);assert.equal(pending.view,'project');assert.equal(completed,false);
  for(const mismatch of [{view:'home'},{projectId:'another-project'},{reviewId:'another-review'},{request:pending.request-1},{section:'settings'}]){
    assert.deepEqual(await client.success('integration.displayed',{...pending,section:'review',...mismatch}),{accepted:false});
    assert.equal(completed,false);
  }
  assert.deepEqual(await h.forWindow(h.state.primaryWindow).success('integration.displayed',{...pending,section:'review'}),{accepted:false});
  assert.equal(await h.forWindow(h.state.primaryWindow).success('integration.pending'),null);
  assert.deepEqual(await client.success('integration.displayed',{...pending,section:'review'}),{accepted:true});
  assert.equal((await showing).shown,true);
});

test('Season AI rejects a missing project and reports a closed renderer before showing a review',async t=>{
  const h=await harness(t,{manualSeasonAcknowledgment:true});
  const {review,project}=await seed(h);
  await assert.rejects(h.state.seasonIntegration.showReview({reviewId:review.id,projectId:'another-project',fullscreen:false}),/프로젝트/);
  const showing=h.state.seasonIntegration.showReview({reviewId:review.id,fullscreen:false});
  const rejected=assert.rejects(showing,/창이 닫혔습니다/);
  const host=await projectHost(h,project.id);await pendingRoute(h,host);host.close();
  await rejected;
  assert.equal(h.state.primaryWindow.isDestroyed(),false);
});

test('simultaneous Season AI routes use separate project windows and reject another window acknowledgment',async t=>{
  const h=await harness(t,{manualSeasonAcknowledgment:true});
  const first=await seed(h),second=await seed(h);
  const showingFirst=h.state.seasonIntegration.showReview({reviewId:first.review.id,fullscreen:false});
  const showingSecond=h.state.seasonIntegration.showReview({reviewId:second.review.id,fullscreen:false});
  const firstHost=await projectHost(h,first.project.id),secondHost=await projectHost(h,second.project.id);
  const firstClient=h.forWindow(firstHost),secondClient=h.forWindow(secondHost);
  const firstRequest=await pendingRoute(h,firstHost),secondRequest=await pendingRoute(h,secondHost);
  assert.notEqual(firstHost,secondHost);assert.equal(h.state.windows.length,3);
  assert.deepEqual(await secondClient.success('integration.displayed',{...firstRequest,section:'review'}),{accepted:false});
  assert.deepEqual(await firstClient.success('integration.displayed',{...secondRequest,section:'review'}),{accepted:false});
  assert.deepEqual(await secondClient.success('integration.displayed',{...secondRequest,section:'review'}),{accepted:true});
  assert.equal((await showingSecond).windowId,routeWindowId(secondHost));
  assert.deepEqual(await firstClient.success('integration.pending'),firstRequest);
  assert.deepEqual(await firstClient.success('integration.displayed',{...firstRequest,section:'review'}),{accepted:true});
  assert.equal((await showingFirst).windowId,routeWindowId(firstHost));
});

test('simultaneous requests for the same project reuse one window and acknowledge each review in order',async t=>{
  const h=await harness(t,{manualSeasonAcknowledgment:true}),{project,review}=await seed(h);
  const other=await h.success('review.save',{projectId:project.id,title:'같은 프로젝트의 다음 리뷰'});
  const first=h.state.seasonIntegration.showReview({reviewId:review.id,fullscreen:false});
  const second=h.state.seasonIntegration.showReview({reviewId:other.id,fullscreen:false});
  const host=await projectHost(h,project.id),client=h.forWindow(host),pending=await pendingRoute(h,host);
  assert.equal(pending.reviewId,review.id);assert.equal(h.state.windows.length,2);
  await client.success('integration.displayed',{...pending,section:'review'});assert.equal((await first).windowId,routeWindowId(host));
  const next=await waitForValue(async()=>{const item=await client.success('integration.pending');return item?.reviewId===other.id?item:null;},'The second review did not reach the reused window');
  assert.equal(h.state.windows.length,2);assert(next.request>pending.request);
  assert.deepEqual(await client.success('integration.displayed',{...pending,section:'review'}),{accepted:false});
  await client.success('integration.displayed',{...next,section:'review'});assert.equal((await second).windowId,routeWindowId(host));
});

test('window controls, capture, dialogs and permissions use the requesting registered application window',async t=>{
  const h=await harness(t),first=await seed(h),second=await seed(h),primary=h.state.primaryWindow;
  const openedA=await h.forWindow(primary).success('window.openProject',{projectId:first.project.id,reviewId:first.review.id});
  const a=await projectHost(h,first.project.id),clientA=h.forWindow(a);
  const openedB=await h.forWindow(primary).success('window.openProject',{projectId:second.project.id,reviewId:second.review.id});
  const b=await projectHost(h,second.project.id),clientB=h.forWindow(b);
  assert.equal(openedA.windowId,routeWindowId(a));assert.equal(openedB.windowId,routeWindowId(b));assert.notEqual(openedA.windowId,openedB.windowId);
  assert.deepEqual(await clientA.success('window.context'),{windowId:routeWindowId(a),projectId:first.project.id});
  assert.deepEqual(await clientB.success('window.context'),{windowId:routeWindowId(b),projectId:second.project.id});
  assert.equal((await clientA.success('window.fullscreen')).fullScreen,true);assert.equal((await clientB.success('window.state')).fullScreen,false);assert.equal(primary.fullScreen,false);
  await clientA.success('viewer.capture',{bounds:{x:10,y:20,width:300,height:200}});
  assert.equal(h.state.captureCalls.at(-1).windowId,a.id);
  await clientA.success('dialog.directory');assert.equal(h.state.dialogCalls.at(-1).host,a);
  for(const host of [primary,a,b]) {
    assert.equal(h.state.permissionCheck(host.webContents,'fullscreen','reviewops://app/index.html'),true);
    assert.equal(h.state.permissionCheck(host.webContents,'media','reviewops://app/index.html'),false);
    let allowed;h.state.permissionRequest(host.webContents,'fullscreen',value=>{allowed=value;},{isMainFrame:false,requestingUrl:'reviewops://app/index.html'});assert.equal(allowed,false);
  }
  const foreign=new primary.constructor({});
  assert.equal((await h.forWindow(foreign).invoke('snapshot')).ok,false);
  assert.equal(h.state.permissionCheck(foreign.webContents,'fullscreen','reviewops://app/index.html'),false);
  const frame={url:'reviewops://app/index.html',parent:a.webContents.mainFrame};
  assert.equal((await h.invoke('window.close',{}, {sender:a.webContents,senderFrame:frame})).ok,false);
  assert.equal(a.closeCalls,0);assert.equal(b.closeCalls,0);
});

test('cross-project navigation retains create, edit and settings destinations only in the target window',async t=>{
  const h=await harness(t),first=await seed(h),second=await seed(h),primary=h.state.primaryWindow;
  await h.forWindow(primary).success('window.openProject',{projectId:first.project.id});
  const a=await projectHost(h,first.project.id),clientA=h.forWindow(a);
  const ownNavigation=await clientA.success('window.navigation');
  const opened=await clientA.success('window.openProject',{projectId:second.project.id,section:'review',reviewMode:'create'});
  const b=await projectHost(h,second.project.id),clientB=h.forWindow(b);
  const creating=await clientB.success('window.navigation');
  assert.equal(creating.projectId,second.project.id);assert.equal(creating.section,'review');assert.equal(creating.reviewMode,'create');assert.equal(creating.reviewId,'');
  assert.deepEqual(b.messages.filter(item=>item.channel==='reviewops:project-open').at(-1).data,creating);
  const editingResult=await clientA.success('window.openProject',{projectId:second.project.id,section:'review',reviewMode:'edit',reviewId:second.review.id});
  const editing=await clientB.success('window.navigation');
  assert.equal(editing.reviewMode,'edit');assert.equal(editing.reviewId,second.review.id);assert.ok(editing.request>creating.request);assert.equal(editingResult.windowId,opened.windowId);
  await clientA.success('window.openProject',{projectId:second.project.id,section:'settings'});
  const settings=await clientB.success('window.navigation');assert.equal(settings.section,'settings');assert.ok(settings.request>editing.request);
  assert.equal(h.state.windows.length,3);assert.deepEqual(await clientA.success('window.navigation'),ownNavigation);assert.equal(await h.forWindow(primary).success('window.navigation'),null);
  await h.state.seasonIntegration.showReview({projectId:second.project.id,reviewId:second.review.id,fullscreen:false});
  assert.equal(await clientB.success('window.navigation'),null);
  const shown=await clientB.success('integration.pending');assert.ok(shown.request>settings.request);
  await clientA.success('window.openProject',{projectId:second.project.id,section:'settings'});
  assert.equal(await clientB.success('integration.pending'),null);
  assert.equal((await clientB.success('window.navigation')).section,'settings');
  assert.deepEqual(await clientB.success('integration.displayed',{...shown,section:'review'}),{accepted:false});
});

test('invalid cross-project navigation cannot replace a target window destination',async t=>{
  const h=await harness(t),first=await seed(h),second=await seed(h),primary=h.state.primaryWindow;
  await h.forWindow(primary).success('window.openProject',{projectId:second.project.id,section:'settings'});
  const host=await projectHost(h,second.project.id),before=await h.forWindow(host).success('window.navigation');
  for(const payload of [
    {projectId:second.project.id,reviewId:first.review.id,reviewMode:'edit'},
    {projectId:second.project.id,reviewMode:'edit'},
    {projectId:second.project.id,section:'unsupported'},
    {projectId:second.project.id,reviewMode:'unsupported'}
  ])assert.equal((await h.forWindow(primary).invoke('window.openProject',payload)).ok,false);
  assert.deepEqual(await h.forWindow(host).success('window.navigation'),before);assert.equal(h.state.windows.length,2);
});

for(const ending of ['close','crash','reload'])test(`a project window ${ending} preserves another window's browser, terminal and staged files`,async t=>{
  const h=await harness(t),first=await seed(h),second=await seed(h);h.state.allowShell=true;
  await h.state.seasonIntegration.showReview({reviewId:first.review.id,fullscreen:false});const a=await projectHost(h,first.project.id),clientA=h.forWindow(a);
  await h.state.seasonIntegration.showReview({reviewId:second.review.id,fullscreen:false});const b=await projectHost(h,second.project.id),clientB=h.forWindow(b);
  const browserA=await clientA.success('browser.create',{url:'https://fixture.invalid/a'}),browserB=await clientB.success('browser.create',{url:'https://fixture.invalid/b'});
  const managerA=h.state.browserManagers.find(manager=>manager.host===a),managerB=h.state.browserManagers.find(manager=>manager.host===b);
  assert.equal(managerA.options.partition,`persist:reviewops-browser-project-${first.project.id}`);assert.equal(managerB.options.partition,`persist:reviewops-browser-project-${second.project.id}`);
  assert.equal((await clientA.invoke('browser.state',{id:browserB.id})).ok,false);
  const terminalA=await clientA.success('terminal.open',{serviceId:first.service.id}),terminalB=await clientB.success('terminal.open',{serviceId:second.service.id});
  assert.equal((await clientB.invoke('terminal.read',{id:terminalA.id})).ok,false);
  assert.equal((await clientA.invoke('terminal.write',{id:terminalB.id,data:'must not arrive'})).ok,false);
  const fileA=path.join(h.root,'window-a.txt'),fileB=path.join(h.root,'window-b.txt');fs.writeFileSync(fileA,'draft A');fs.writeFileSync(fileB,'draft B');
  const [stagedA]=await clientA.success('attachment.stageFiles',{paths:[fileA]}),[stagedB]=await clientB.success('attachment.stageFiles',{paths:[fileB]});
  assert.equal((await clientB.invoke('attachment.stagePreview',{token:stagedA.token})).ok,false);
  assert.equal((await clientB.invoke('activity.add',{reviewId:second.review.id,body:'wrong owner',attachmentTokens:[stagedA.token]})).ok,false);
  await clientB.invoke('attachment.discard',{tokens:[stagedA.token]});
  assert.equal((await clientA.success('attachment.stagePreview',{token:stagedA.token})).content,'draft A');
  if(ending==='close')a.close();else if(ending==='crash')a.webContents.emit('render-process-gone',{}, {reason:'crashed'});else a.webContents.emit('did-start-navigation',{},a.webContents.getURL(),false,true);
  assert.equal(managerA.closed,true);assert.equal(managerB.closed,false);assert.equal(b.isDestroyed(),false);
  assert.equal((await clientB.success('browser.state',{id:browserB.id})).id,browserB.id);
  await clientB.success('terminal.write',{id:terminalB.id,data:'B remains connected'});
  const output=await clientB.success('terminal.read',{id:terminalB.id,cursor:0});assert.match(output.data,/B remains connected/);assert.doesNotMatch(output.data,/must not arrive/);
  assert.equal((await clientB.success('attachment.stagePreview',{token:stagedB.token})).content,'draft B');
  assert.equal((await h.forWindow(h.state.primaryWindow).invoke('terminal.read',{id:terminalA.id,cursor:0})).ok,false);
  assert.equal((await clientB.success('attachment.staged',{tokens:[stagedB.token]})).files.length,1);
  if(ending!=='close'){
    assert.equal((await clientA.success('attachment.stagePreview',{token:stagedA.token})).content,'draft A');
    assert.equal((await clientA.success('attachment.staged',{tokens:[stagedA.token]})).files.length,1);
  }
  assert.equal(managerA.views.has(browserA.id),false);
});

for(const completion of ['resolve','reject'])test(`main commit retires a late provisional browser create without changing another owner (${completion})`,async t=>{
  let entered,release,reject;
  const started=new Promise(resolve=>{entered=resolve;});
  const pendingNative=new Promise((resolve,no)=>{release=resolve;reject=no;});
  const nativeError=Object.assign(new Error('original pending native preparation failed'),{code:'ORIGINAL_NATIVE_FAILURE'});
  const h=await harness(t,{
    // Native IDs belong to each manager. Reuse deliberately so a stale cleanup
    // sent to the replacement manager would close the valid new-document view.
    browserId:({payload})=>payload.url.includes('owner-b')?'owner-b-view':'reused-owner-a-view',
    browserCreateGate:({manager,payload})=>{
      if(payload.url.includes('provisional')){entered(manager);return pendingNative;}
    }
  });
  const first=await seed(h),second=await seed(h),primary=h.state.primaryWindow;
  await h.forWindow(primary).success('window.openProject',{projectId:first.project.id});
  const a=await projectHost(h,first.project.id),clientA=h.forWindow(a);
  await h.forWindow(primary).success('window.openProject',{projectId:second.project.id});
  const b=await projectHost(h,second.project.id),clientB=h.forWindow(b);
  const kept=await clientB.success('browser.create',{url:'https://fixture.invalid/owner-b'});
  const managerB=h.state.browserManagers.find(manager=>manager.host===b);
  const before=await clientA.success('browser.create',{url:'https://fixture.invalid/before-reload'});
  const beforeManager=h.state.browserManagers.find(manager=>manager.host===a);
  a.webContents.emit('did-start-navigation',{},a.webContents.getURL(),false,true);
  assert.equal(beforeManager.closed,true);assert.equal(beforeManager.views.has(before.id),false);

  // This create arrives after start cleanup and remains pending at native await.
  const old=clientA.invoke('browser.create',{url:'https://fixture.invalid/provisional'});
  const provisional=await started;
  assert.equal(provisional.closed,false);assert.equal(provisional.views.size,1);
  a.webContents.emit('did-navigate',{},a.webContents.getURL(),200,'OK');
  assert.equal(provisional.closed,true);assert.equal(provisional.views.size,0);
  const fresh=await clientA.success('browser.create',{url:'https://fixture.invalid/new-document'});
  const current=h.state.browserManagers.filter(manager=>manager.host===a).at(-1);
  assert.notEqual(current,provisional);assert.equal(current.views.size,1);
  if(completion==='resolve')release();else reject(nativeError);
  const ended=await old;
  assert.equal(ended.ok,false);
  if(completion==='resolve')assert.equal(ended.error.code,'STALE_BROWSER_OWNER');
  else {assert.equal(ended.error.code,nativeError.code);assert.equal(ended.error.message,nativeError.message);}
  assert.equal(current.closed,false);assert.equal(current.views.size,1);
  assert.equal((await clientA.success('browser.state',{id:fresh.id})).url,'https://fixture.invalid/new-document');
  assert.equal(managerB.closed,false);assert.equal(b.isDestroyed(),false);
  assert.equal((await clientB.success('browser.state',{id:kept.id})).url,'https://fixture.invalid/owner-b');
});

test('subframe and in-page navigation do not retire the current native browser owner',async t=>{
  const h=await harness(t),{project}=await seed(h),primary=h.state.primaryWindow;
  await h.forWindow(primary).success('window.openProject',{projectId:project.id});
  const host=await projectHost(h,project.id),client=h.forWindow(host);
  const view=await client.success('browser.create',{url:'https://fixture.invalid/preserved'});
  const manager=h.state.browserManagers.find(value=>value.host===host);
  host.webContents.emit('did-start-navigation',{},'https://fixture.invalid/subframe',false,false);
  host.webContents.emit('did-frame-navigate',{},'https://fixture.invalid/subframe',200,'OK',false,1,2);
  host.webContents.emit('did-start-navigation',{},host.webContents.getURL()+'#same-document',true,true);
  host.webContents.emit('did-navigate-in-page',{},host.webContents.getURL()+'#same-document',true,1,2);
  assert.equal(manager.closed,false);assert.equal((await client.success('browser.state',{id:view.id})).id,view.id);
});

for(const dirtyAt of ['before selection','during selection'])test(`backup restore preserves another window draft started ${dirtyAt}`,async t=>{
  const h=await harness(t),{project,review}=await seed(h),primary=h.state.primaryWindow;
  await h.state.seasonIntegration.showReview({reviewId:review.id,fullscreen:false});
  const host=await projectHost(h,project.id),client=h.forWindow(host);
  const file=path.join(h.root,'unsaved-restore-draft.txt');fs.writeFileSync(file,'Keep this other window attachment');
  const [draft]=await client.success('attachment.stageFiles',{paths:[file]});
  const backup=importBundle(h),before=await client.success('snapshot');
  if(dirtyAt==='before selection')host.preventUnload=true;
  h.state.openHandler=async()=>{host.preventUnload=true;return {canceled:false,filePaths:[backup]};};
  const result=await h.forWindow(primary).invoke('backup.import');
  assert.equal(result.ok,false);assert.match(result.error.message,/다른 창에서 작성 중인 내용/);
  assert.deepEqual(await client.success('snapshot'),before);
  assert.equal((await client.success('attachment.stagePreview',{token:draft.token})).content,'Keep this other window attachment');
  assert.equal(host.isDestroyed(),false);
  assert.equal(h.state.dialogCalls.filter(call=>call.kind==='open').length,dirtyAt==='before selection'?0:1);
});

test('cancelling final unload keeps remaining dirty windows and browsers but does not restore discarded ones',async t=>{
  const h=await harness(t),first=await seed(h),second=await seed(h);
  await h.state.seasonIntegration.showReview({reviewId:first.review.id,fullscreen:false});const a=await projectHost(h,first.project.id);
  await h.state.seasonIntegration.showReview({reviewId:second.review.id,fullscreen:false});const b=await projectHost(h,second.project.id);
  await h.forWindow(a).success('browser.create',{url:'https://fixture.invalid/a'});await h.forWindow(b).success('browser.create',{url:'https://fixture.invalid/b'});
  a.preventUnload=true;a.unloadResponse=1;b.preventUnload=true;b.unloadResponse=0;
  h.appEvents.emit('before-quit',{preventDefault(){}});
  await waitForValue(()=>h.state.unloadCalls===2,'Each dirty window must be asked at its own final unload');
  assert.equal(a.isDestroyed(),true);assert.equal(b.isDestroyed(),false);assert.equal(h.state.appQuitCalls,0);
  assert.equal(h.state.browserManagers.find(manager=>manager.host===a).closed,true);assert.equal(h.state.browserManagers.find(manager=>manager.host===b).closed,false);
  b.unloadResponse=1;h.appEvents.emit('before-quit',{preventDefault(){}});
  await waitForValue(()=>h.state.windows.every(host=>host.isDestroyed()),'Approved quit must close all application windows');
  assert.equal(h.state.unloadCalls,3,'Only the still-open window asks once on retry');
  assert.ok(h.state.browserManagers.every(manager=>manager.closed));
});

test('shared data changes notify all registered windows without consuming another window draft',async t=>{
  const h=await harness(t),first=await seed(h),second=await seed(h);
  await h.state.seasonIntegration.showReview({reviewId:first.review.id,fullscreen:false});const a=await projectHost(h,first.project.id),clientA=h.forWindow(a);
  await h.state.seasonIntegration.showReview({reviewId:second.review.id,fullscreen:false});const b=await projectHost(h,second.project.id),clientB=h.forWindow(b);
  const file=path.join(h.root,'unsaved-window-b.txt');fs.writeFileSync(file,'B draft');
  const [draft]=await clientB.success('attachment.stageFiles',{paths:[file]});
  for(const host of h.state.windows)host.messages=[];
  const activity=await clientA.success('activity.add',{reviewId:first.review.id,body:'A saved this comment'});
  const revisions=[];
  for(const host of h.state.windows){const changes=host.messages.filter(message=>message.channel==='reviewops:data-change');assert.equal(changes.length,1);assert.deepEqual(Object.keys(changes[0].data),['revision']);assert.equal(Number.isSafeInteger(changes[0].data.revision),true);revisions.push(changes[0].data.revision);}
  assert.equal(new Set(revisions).size,1);assert.ok((await clientB.success('snapshot')).activities.some(item=>item.id===activity.id));
  assert.equal((await clientB.success('attachment.stagePreview',{token:draft.token})).content,'B draft');
  a.close();const closedMessageCount=a.messages.length;
  await clientB.success('activity.add',{reviewId:second.review.id,body:'B saved this comment'});
  assert.equal(a.messages.length,closedMessageCount);assert.ok(b.messages.filter(message=>message.channel==='reviewops:data-change').at(-1).data.revision>revisions[0]);
});

test('a queued write from a closed window cannot run after another window releases the action queue',async t=>{
  const h=await harness(t),{review,project}=await seed(h),primary=h.state.primaryWindow;
  await h.state.seasonIntegration.showReview({reviewId:review.id,fullscreen:false});const host=await projectHost(h,project.id),client=h.forWindow(host);
  let opened,release;const ready=new Promise(resolve=>{opened=resolve;});
  h.state.openHandler=()=>{opened();return new Promise(resolve=>{release=resolve;});};
  const restore=h.forWindow(primary).success('backup.import');await ready;
  const before=await h.forWindow(primary).success('snapshot');
  const queued=client.invoke('group.save',{name:'Must not be saved after the owner closes'});host.close();
  release({canceled:true,filePaths:[]});assert.equal((await restore).cancelled,true);
  const result=await queued;assert.equal(result.ok,false);assert.match(result.error.message,/창이 닫혔습니다|허용되지 않은 요청/);
  assert.deepEqual(await h.forWindow(primary).success('snapshot'),before);
});

test('integration display text stays separate from execution instructions and updates the visible history', async t => {
  const h = await harness(t);
  const { review, service } = await seed(h);
  await h.success('service.save', {id:service.id,agentEnabled:1});
  await h.state.seasonIntegration.showReview({reviewId:review.id,fullscreen:true});
  const job = await h.success('agent.start', {reviewId:review.id,requestId:'season-display-test',prompt:'User request. Internal execution instructions.',displayPrompt:'사용자 제작 요청'});
  const snapshot = await h.success('snapshot');
  assert.equal(snapshot.activities.find(item=>item.agentRunId===job.id&&item.role==='user').body,'사용자 제작 요청');
  assert.match(h.state.agentStarts[0].prompt,/Internal execution instructions/);
  h.state.agentUpdate({...job,kind:'agent',status:'running'});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.ok(h.state.windowMessages.some(item=>item.channel==='reviewops:season-update'&&item.data.reviewId===review.id));
  const again=await h.success('agent.start',{reviewId:review.id,requestId:job.id,prompt:'User request. Internal execution instructions.',displayPrompt:'사용자 제작 요청'});
  assert.equal(again.id,job.id);assert.equal(h.state.agentStarts.length,1);
});

async function addFile(h, reviewId, content = 'synthetic attachment') {
  const file = path.join(h.root, `${crypto.randomUUID()}.txt`);
  fs.writeFileSync(file, content);
  h.state.openResult = { canceled: false, filePaths: [file] };
  const added = await h.success('attachment.add', { reviewId });
  assert.equal(added.length, 1);
  return added[0];
}

test('review.copy refuses its original request after same-window QA activation during attachment reading',async t=>{
  const h=await harness(t),source=await seed(h),destination=await seed(h);
  const original=await addFile(h,source.review.id,'Retain these original copy bytes');
  const originalPath=path.join(h.dataPath,'attachments',original.storageName),originalBytes=fs.readFileSync(originalPath);
  await h.state.seasonIntegration.showReview({reviewId:source.review.id,fullscreen:false});
  const host=await projectHost(h,source.project.id),client=h.forWindow(host),originalContext=await client.success('window.context');
  assert.equal(originalContext.qaProjectId,undefined);
  const fsp=require('node:fs/promises'),readFile=fsp.readFile;
  let entered,releaseRead,readCalls=0,pending,result,qa,before,after,activationContext,setupError;
  let cleanupQAReleased=false;const cleanupErrors=[];
  const reading=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{releaseRead=resolve;});
  const notices=()=>host.messages.filter(row=>row.channel==='reviewops:data-change').length;
  const storedFiles=()=>fs.readdirSync(path.join(h.dataPath,'attachments')).sort().map(name=>{
    const file=path.join(h.dataPath,'attachments',name),stat=fs.lstatSync(file);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4096);
    const bytes=fs.readFileSync(file);
    return {name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
  });
  const observe=()=>({graph:h.state.liveStore.exportData(),files:storedFiles(),notices:notices(),originalBytesBase64:fs.readFileSync(originalPath).toString('base64')});
  const errorValue=error=>({name:error.name,message:error.message,code:error.code,stack:error.stack});
  const noticesBeforeActivation=notices();
  // Temporarily gate only this owned read and restore the shared-module method
  // before cleanup. Production source and harness helpers remain unchanged.
  fsp.readFile=async function(file,...args){
    if(typeof file==='string'&&path.resolve(file)===originalPath){
      readCalls++;assert.equal(readCalls,1);entered();await gate;
    }
    return readFile.call(fsp,file,...args);
  };
  try{
    pending=client.invoke('review.copy',{reviewId:source.review.id,projectId:destination.project.id,attachmentIds:[original.id]})
      .then(value=>({value}),error=>({error:errorValue(error)}));
    await Promise.race([reading,pending.then(()=>{throw new Error('The original copy settled without entering its selected attachment read');})]);
    qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:source.project.id,clientId:'held-copy-scope-owner'});
    assert.equal(qa.windowId,originalContext.windowId);assert.equal(qa.projectId,source.project.id);
    activationContext=await client.success('window.context');assert.equal(activationContext.qaProjectId,source.project.id);
    await waitForValue(()=>notices()===noticesBeforeActivation+1,'QA activation must settle exactly its own existing scope notice');
    before=observe();releaseRead();result=await pending;after=observe();
  }catch(error){setupError=errorValue(error);}
  finally{
    releaseRead();fsp.readFile=readFile;
    if(pending){const settled=await pending;if(!result)result=settled;}
    if(qa){
      try{const released=await h.state.toolIntegration.automationHandler('automation.qa.release',qa);assert.equal(released.released,true);cleanupQAReleased=true;}
      catch(error){cleanupErrors.push(errorValue(error));}
    }
  }
  const graphKeys=['reviews','activities','attachments'];
  const observed={sourceReviewId:source.review.id,destinationProjectId:destination.project.id,originalContext,activationContext,
    actualQAWindowId:qa?.windowId,readCalls,readFunctionRestored:fsp.readFile===readFile,setupError:setupError||null,
    settledResult:result?JSON.parse(JSON.stringify(result)):null,before:before||null,after:after||null,
    originalBytesBase64:originalBytes.toString('base64'),cleanupQAReleased,cleanupErrors,
    deltas:before&&after?{...Object.fromEntries(graphKeys.map(key=>[key,after.graph[key].length-before.graph[key].length])),
      storedFiles:after.files.length-before.files.length,copyNotices:after.notices-before.notices,
      activationNotices:before.notices-noticesBeforeActivation}:null,
    scope:'Controlled production main/Store copy with a test-held file read and actual QA handler; no Electron GUI or native picker'};
  t.diagnostic('review-copy-scope-baseline '+JSON.stringify(observed));
  assert.equal(setupError,undefined,'The test-controlled read and actual same-window QA activation must complete before checking the product result');
  assert.deepEqual(cleanupErrors,[]);assert.equal(cleanupQAReleased,true);assert.equal(readCalls,1);assert.equal(fsp.readFile,readFile);
  assert.equal(result.error,undefined);assert.equal(result.value.ok,false,'The copy must refuse its original request after the same window gains a different QA scope');
  assert.equal(result.value.error.code,'TARGET_MISMATCH');
  assert.deepEqual(after.graph,before.graph);assert.deepEqual(after.files,before.files);assert.equal(after.notices,before.notices);
  assert.equal(after.originalBytesBase64,originalBytes.toString('base64'));
});

async function heldReviewCopy(t) {
  const h=await harness(t),source=await seed(h),destination=await seed(h);
  const original=await addFile(h,source.review.id,'Original held copy attachment');
  const originalPath=path.join(h.dataPath,'attachments',original.storageName);
  await h.state.seasonIntegration.showReview({reviewId:source.review.id,fullscreen:false});
  const host=await projectHost(h,source.project.id),client=h.forWindow(host),context=await client.success('window.context');
  const fsp=require('node:fs/promises'),readFile=fsp.readFile,qaHandles=new Set();
  let pending,releaseRead,installed=false,readCalls=0;
  const restoreRead=()=>{if(installed){fsp.readFile=readFile;installed=false;}};
  const files=()=>fs.readdirSync(path.join(h.dataPath,'attachments')).sort().map(name=>{
    const bytes=fs.readFileSync(path.join(h.dataPath,'attachments',name));
    return {name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  });
  const observe=()=>({graph:h.state.liveStore.exportData(),files:files(),notices:host.messages.filter(row=>row.channel==='reviewops:data-change').length});
  const input=()=>({reviewId:source.review.id,projectId:destination.project.id,attachmentIds:[original.id]});
  const settle=async()=>{releaseRead?.();restoreRead();if(!pending)return;const settled=await pending;if(settled.error)throw settled.error;return settled.value;};
  const releaseQA=async handle=>{
    assert.ok(qaHandles.has(handle));const result=await h.state.toolIntegration.automationHandler('automation.qa.release',handle);
    assert.equal(result.released,true);qaHandles.delete(handle);
  };
  return {h,source,destination,original,originalPath,host,client,context,files,observe,input,
    async hold(payload=input()) {
      assert.equal(pending,undefined);
      let entered;const reading=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{releaseRead=resolve;});
      fsp.readFile=async function(file,...args){
        if(typeof file==='string'&&path.resolve(file)===originalPath){readCalls++;assert.equal(readCalls,1);entered();await gate;}
        return readFile.call(fsp,file,...args);
      };installed=true;
      pending=client.invoke('review.copy',payload).then(value=>({value}),error=>({error}));
      await Promise.race([reading,pending.then(()=>{throw new Error('Copy did not reach the owned selected read');})]);
    },
    settle,releaseQA,
    async openQA(projectId=source.project.id) {
      const handle=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId,clientId:'copy-regression-'+crypto.randomUUID()});
      qaHandles.add(handle);return handle;
    },
    async close() {
      releaseRead?.();restoreRead();
      try{if(pending)await pending;}finally{for(const handle of [...qaHandles])await releaseQA(handle);}
      assert.equal(fsp.readFile,readFile);
    }
  };
}

test('review.copy refuses selected attachment replacement without mixing copied bytes and source provenance',async t=>{
  const plain=value=>JSON.parse(JSON.stringify(value));
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const delta=(before,after)=>({
    reviews:after.graph.reviews.length-before.graph.reviews.length,
    activities:after.graph.activities.length-before.graph.activities.length,
    attachments:after.graph.attachments.length-before.graph.attachments.length,
    storedFiles:after.files.length-before.files.length,
    notices:after.notices-before.notices
  });
  const normal=await heldReviewCopy(t);let normalObservation;
  try{
    const source=normal.h.state.liveStore.get('reviews',normal.source.review.id);
    const attachment=normal.h.state.liveStore.get('attachments',normal.original.id),bytes=fs.readFileSync(normal.originalPath);
    await normal.hold();
    const before=normal.observe(),result=plain(await normal.settle()),after=normal.observe();
    assert.equal(result.ok,true);
    const copied=after.graph.attachments.filter(row=>row.reviewId===result.data.id);assert.equal(copied.length,1);
    const copiedBytes=fs.readFileSync(path.join(normal.h.dataPath,'attachments',copied[0].storageName));
    assert.deepEqual(copiedBytes,bytes);assert.equal(copied[0].sha256,hash(bytes));
    assert.equal(result.data.evidence.copiedFrom.attachments[0].sha256,hash(copiedBytes));
    assert.deepEqual(normal.h.state.liveStore.get('reviews',source.id),source);
    assert.deepEqual(normal.h.state.liveStore.get('attachments',attachment.id),attachment);
    assert.deepEqual(fs.readFileSync(normal.originalPath),bytes);
    assert.deepEqual(delta(before,after),{reviews:1,activities:3,attachments:1,storedFiles:1,notices:1});
    normalObservation={result,before,after,deltas:delta(before,after),sourcePreserved:true,originalBytesPreserved:true,provenanceMatchesCopiedBytes:true};
  }finally{await normal.close();}

  const f=await heldReviewCopy(t),store=f.h.state.liveStore,readFile=require('node:fs/promises').readFile;
  const sourceBefore=store.get('reviews',f.source.review.id),attachmentBefore=store.get('attachments',f.original.id);
  assert.equal(attachmentBefore.activityId,null);
  const bytesA=fs.readFileSync(f.originalPath),bytesB=Buffer.from('Valid replacement attachment B with different bytes');
  const storageB=crypto.randomUUID()+'.txt',pathB=path.join(f.h.dataPath,'attachments',storageB);
  fs.writeFileSync(pathB,bytesB,{flag:'wx'});assert.notEqual(hash(bytesA),hash(bytesB));
  const controls=()=>({epoch:store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch,
    sourceRevision:{...store.db.prepare('SELECT * FROM review_revisions WHERE reviewId=?').get(sourceBefore.id)}});
  const originalControls=controls();
  let replacement,before,after,beforeSource,afterSource,beforeAttachment,afterAttachment,beforeControls,afterControls,result,setupError,cleanupError;
  try{
    await f.hold();
    // A supported synchronous Store seam replaces only the selected row. Both
    // real private files remain intact; queued GUI interleaving is not claimed.
    store.transaction(()=>{
      store.deleteAttachment(attachmentBefore.id);
      replacement=store.addAttachment({id:attachmentBefore.id,reviewId:sourceBefore.id,name:'Replacement source B.txt',
        mimeType:'text/plain',storageName:storageB,size:bytesB.length,sha256:hash(bytesB)});
    });
    beforeControls=controls();
    assert.equal(beforeControls.epoch,originalControls.epoch);
    assert.equal(beforeControls.sourceRevision.generation,originalControls.sourceRevision.generation);
    assert.equal(beforeControls.sourceRevision.deleted,0);
    beforeSource=store.get('reviews',sourceBefore.id);beforeAttachment=store.get('attachments',attachmentBefore.id);
    // addAttachment legitimately updates updatedAt; all other source fields stay.
    const stable=row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='updatedAt'));
    assert.deepEqual(stable(beforeSource),stable(sourceBefore));
    assert.equal(beforeAttachment.id,attachmentBefore.id);assert.equal(beforeAttachment.reviewId,sourceBefore.id);
    assert.equal(beforeAttachment.sha256,hash(fs.readFileSync(pathB)));assert.deepEqual(fs.readFileSync(f.originalPath),bytesA);
    assert.deepEqual(plain(await f.client.success('window.context')),f.context);
    before=f.observe();result=plain(await f.settle());after=f.observe();afterControls=controls();
    afterSource=store.get('reviews',sourceBefore.id);afterAttachment=store.get('attachments',attachmentBefore.id);
  }catch(error){setupError={name:error.name,message:error.message,code:error.code,stack:error.stack};}
  finally{try{await f.close();}catch(error){cleanupError={name:error.name,message:error.message,code:error.code,stack:error.stack};}}
  const copiedRows=result?.ok&&after?after.graph.attachments.filter(row=>row.reviewId===result.data.id):[];
  const copiedFiles=copiedRows.map(row=>{
    const bytes=fs.readFileSync(path.join(f.h.dataPath,'attachments',row.storageName));
    return {metadata:row,actualBytesBase64:bytes.toString('base64'),actualSHA256:hash(bytes)};
  });
  const copiedFrom=result?.ok?result.data.evidence.copiedFrom:null;
  t.diagnostic('review-copy-attachment-provenance-baseline '+JSON.stringify({normal:normalObservation,
    sourceBefore,attachmentBefore,replacement:replacement||null,beforeSource:beforeSource||null,afterSource:afterSource||null,
    beforeAttachment:beforeAttachment||null,afterAttachment:afterAttachment||null,originalControls,beforeControls:beforeControls||null,afterControls:afterControls||null,
    bytesA:{base64:bytesA.toString('base64'),sha256:hash(bytesA)},bytesB:{base64:bytesB.toString('base64'),sha256:hash(bytesB)},
    result:result||null,copiedFrom,copiedFiles,before:before||null,after:after||null,deltas:before&&after?delta(before,after):null,
    provenanceMatchesCopiedBytes:copiedFiles.length===1&&copiedFrom?copiedFrom.attachments[0].sha256===copiedFiles[0].actualSHA256:null,
    readFunctionRestored:require('node:fs/promises').readFile===readFile,setupError:setupError||null,cleanupError:cleanupError||null,
    scope:'Controlled production main/Store with one held A read and supported same-ID attachment-row replacement; no review rebirth, GUI/native race or remote writer'}));
  assert.equal(setupError,undefined,'The same-source attachment replacement and original read must settle before checking the copy');
  assert.equal(cleanupError,undefined);
  assert.equal(result.ok,false,'The original copy must refuse changed selected material instead of mixing copied bytes and current source provenance');
  assert.deepEqual(after,before);assert.deepEqual(afterControls,beforeControls);
  assert.deepEqual(afterSource,beforeSource);assert.deepEqual(afterAttachment,beforeAttachment);
  assert.deepEqual(fs.readFileSync(f.originalPath),bytesA);assert.deepEqual(fs.readFileSync(pathB),bytesB);
});

for(const change of ['removed','moved to another review']) {
  test(`review.copy refuses a selected attachment ${change} during its read`,async t=>{
    const f=await heldReviewCopy(t),store=f.h.state.liveStore,bytes=fs.readFileSync(f.originalPath);
    const other=change==='moved to another review'?store.saveReview({projectId:f.source.project.id,serviceId:f.source.service.id,title:'Other attachment owner'}):null;
    const generation=()=>store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(f.source.review.id).generation;
    const originalGeneration=generation();
    try{
      await f.hold();
      if(other)store.db.prepare('UPDATE attachments SET reviewId=? WHERE id=?').run(other.id,f.original.id);
      else store.deleteAttachment(f.original.id);
      assert.equal(generation(),originalGeneration);
      const before=f.observe(),result=await f.settle();
      assert.equal(result.ok,false);assert.equal(result.error.code,'REVISION_CONFLICT');
      assert.deepEqual(f.observe(),before);assert.deepEqual(fs.readFileSync(f.originalPath),bytes);
    }finally{await f.close();}
  });
}

test('review.copy permits replacement of an unselected attachment during its selected read',async t=>{
  const f=await heldReviewCopy(t),store=f.h.state.liveStore,selectedBytes=fs.readFileSync(f.originalPath);
  const bytesC=Buffer.from('Unselected original C'),bytesD=Buffer.from('Unselected current D');
  const storageC=crypto.randomUUID()+'.txt',storageD=crypto.randomUUID()+'.txt';
  const pathC=path.join(f.h.dataPath,'attachments',storageC),pathD=path.join(f.h.dataPath,'attachments',storageD);
  fs.writeFileSync(pathC,bytesC);fs.writeFileSync(pathD,bytesD);
  const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const unselected=store.addAttachment({reviewId:f.source.review.id,name:'Unselected C.txt',storageName:storageC,size:bytesC.length,sha256:digest(bytesC)});
  try{
    await f.hold();
    const replacement=store.transaction(()=>{
      store.deleteAttachment(unselected.id);
      return store.addAttachment({id:unselected.id,reviewId:f.source.review.id,name:'Unselected D.txt',storageName:storageD,size:bytesD.length,sha256:digest(bytesD)});
    });
    const currentSource=store.get('reviews',f.source.review.id),before=f.observe(),result=await f.settle(),after=f.observe();
    assert.equal(result.ok,true);assert.deepEqual(store.get('attachments',unselected.id),replacement);
    assert.deepEqual(store.get('reviews',f.source.review.id),currentSource);
    const copied=after.graph.attachments.filter(row=>row.reviewId===result.data.id);assert.equal(copied.length,1);
    assert.equal(copied[0].sha256,f.original.sha256);assert.equal(result.data.evidence.copiedFrom.attachments[0].sha256,f.original.sha256);
    assert.equal(after.notices,before.notices+1);
    assert.deepEqual(fs.readFileSync(path.join(f.h.dataPath,'attachments',copied[0].storageName)),selectedBytes);
    assert.deepEqual(fs.readFileSync(f.originalPath),selectedBytes);assert.deepEqual(fs.readFileSync(pathC),bytesC);assert.deepEqual(fs.readFileSync(pathD),bytesD);
  }finally{await f.close();}
});

test('review.copy refuses selected attachment replacement after physical publication and before SQL',async t=>{
  let armed=false,published,expected,expectedRevisions,sourceReviewId,originalAttachment,originalPath,originalBytes,pathB,bytesB,storageB;
  const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const h=await harness(t,{afterMainAtomicWrite({file,store}){
    if(!armed||path.dirname(file)!==path.join(h.dataPath,'attachments'))return;
    armed=false;published=file;assert.notEqual(file,originalPath);assert.notEqual(file,pathB);
    assert.deepEqual(fs.readFileSync(file),originalBytes);
    store.transaction(()=>{
      store.deleteAttachment(originalAttachment.id);
      store.addAttachment({id:originalAttachment.id,reviewId:sourceReviewId,name:'Current source B at final commit.txt',
        mimeType:'text/plain',storageName:storageB,size:bytesB.length,sha256:digest(bytesB)});
    });
    expected=store.exportData();expectedRevisions=store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all().map(row=>({...row}));
  }}),source=await seed(h),destination=await seed(h),original=await addFile(h,source.review.id,'Original A at attachment commit');
  const store=h.state.liveStore,epoch=store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch;
  const generation=store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(source.review.id).generation;
  sourceReviewId=source.review.id;originalAttachment=original;originalPath=path.join(h.dataPath,'attachments',original.storageName);originalBytes=fs.readFileSync(originalPath);
  bytesB=Buffer.from('Current valid source B at attachment commit');storageB=crypto.randomUUID()+'.txt';pathB=path.join(h.dataPath,'attachments',storageB);fs.writeFileSync(pathB,bytesB);
  await h.state.seasonIntegration.showReview({reviewId:source.review.id,fullscreen:false});
  const sourceClient=h.forWindow(await projectHost(h,source.project.id));
  await h.state.seasonIntegration.showReview({reviewId:destination.review.id,fullscreen:false});
  const other=h.forWindow(await projectHost(h,destination.project.id)),draft=path.join(h.root,'other-provenance-draft.txt');
  fs.writeFileSync(draft,'Keep this other window provenance token');const [token]=await other.success('attachment.stageFiles',{paths:[draft]});
  const files=fs.readdirSync(path.join(h.dataPath,'attachments')).sort();
  const notices=()=>h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length,beforeNotices=notices();
  try{
    armed=true;const result=await sourceClient.invoke('review.copy',{reviewId:source.review.id,projectId:destination.project.id,attachmentIds:[original.id]});
    assert.ok(published);assert.equal(armed,false);assert.equal(result.ok,false);assert.equal(result.error.code,'REVISION_CONFLICT');
    assert.equal(result.error.message,'리뷰 또는 선택한 첨부 자료가 변경되었습니다. 사본을 다시 검사한 뒤 저장하십시오.');
    assert.equal(store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch,epoch);
    assert.equal(store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(source.review.id).generation,generation);
    assert.deepEqual(store.exportData(),expected);
    assert.deepEqual(store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all().map(row=>({...row})),expectedRevisions);
    assert.equal(fs.existsSync(published),false);assert.deepEqual(fs.readdirSync(path.join(h.dataPath,'attachments')).sort(),files);
    assert.deepEqual(fs.readFileSync(originalPath),originalBytes);assert.deepEqual(fs.readFileSync(pathB),bytesB);assert.equal(notices(),beforeNotices);
    assert.equal(store.get('attachments',original.id).sha256,digest(bytesB));
    assert.equal((await other.success('attachment.stagePreview',{token:token.token})).content,'Keep this other window provenance token');
  }finally{armed=false;await other.success('attachment.discard',{tokens:[token.token]});}
});

test('review.copy refuses a new same-ID source incarnation after its selected attachment read',async t=>{
  const plain=value=>JSON.parse(JSON.stringify(value));
  const delta=(before,after)=>({
    reviews:after.graph.reviews.length-before.graph.reviews.length,
    activities:after.graph.activities.length-before.graph.activities.length,
    attachments:after.graph.attachments.length-before.graph.attachments.length,
    storedFiles:after.files.length-before.files.length,
    notices:after.notices-before.notices
  });
  const normal=await heldReviewCopy(t);
  let normalObservation;
  try{
    const sourceBefore=normal.h.state.liveStore.get('reviews',normal.source.review.id);
    const attachmentBefore=normal.h.state.liveStore.get('attachments',normal.original.id);
    const bytesBefore=fs.readFileSync(normal.originalPath);
    await normal.hold();
    const before=normal.observe(),result=plain(await normal.settle()),after=normal.observe();
    assert.equal(result.ok,true);
    const copied=after.graph.attachments.filter(row=>row.reviewId===result.data.id);
    assert.equal(copied.length,1);
    assert.deepEqual(normal.h.state.liveStore.get('reviews',normal.source.review.id),sourceBefore);
    assert.deepEqual(normal.h.state.liveStore.get('attachments',normal.original.id),attachmentBefore);
    assert.deepEqual(fs.readFileSync(normal.originalPath),bytesBefore);
    assert.deepEqual(fs.readFileSync(path.join(normal.h.dataPath,'attachments',copied[0].storageName)),bytesBefore);
    assert.equal(result.data.title,sourceBefore.title);assert.equal(result.data.body,sourceBefore.body);
    assert.deepEqual(delta(before,after),{reviews:1,activities:3,attachments:1,storedFiles:1,notices:1});
    normalObservation={result,before,after,deltas:delta(before,after),sourcePreserved:true,originalBytesPreserved:true};
  }finally{await normal.close();}

  const f=await heldReviewCopy(t),store=f.h.state.liveStore,originalRead=require('node:fs/promises').readFile;
  const rawSource={...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(f.source.review.id)};
  const rawAttachment={...store.db.prepare('SELECT * FROM attachments WHERE id=?').get(f.original.id)};
  const originalBytes=fs.readFileSync(f.originalPath);
  const epoch=()=>store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch;
  const birth=()=>store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(f.source.review.id).generation;
  const originalEpoch=epoch(),originalGeneration=birth(),admission=store.captureWriteAdmission();
  const replacementTitle='Replacement review with the same public ID';
  const replacementBody='This content belongs to a new source incarnation.';
  let before,after,result,replacementGeneration,setupError,cleanupError;
  try{
    await f.hold();
    // This controlled Store seam exercises the production review-birth trigger.
    // It is not a claim that a queued UI deletion runs past the held copy.
    store.transaction(()=>{
      store.deleteReview(f.source.review.id);
      store.upsert('reviews',{...rawSource,title:replacementTitle,body:replacementBody});
      store.upsert('attachments',rawAttachment);
    });
    replacementGeneration=birth();
    assert.ok(replacementGeneration>originalGeneration);
    assert.equal(epoch(),originalEpoch);store.assertWriteAdmission(admission);
    assert.deepEqual(store.get('attachments',f.original.id),f.original);
    assert.deepEqual(fs.readFileSync(f.originalPath),originalBytes);
    assert.deepEqual(plain(await f.client.success('window.context')),f.context);
    before=f.observe();result=plain(await f.settle());after=f.observe();
  }catch(error){setupError={name:error.name,message:error.message,code:error.code,stack:error.stack};}
  finally{
    try{await f.close();}catch(error){cleanupError={name:error.name,message:error.message,code:error.code,stack:error.stack};}
  }
  const copiedAttachments=result?.ok&&after?after.graph.attachments.filter(row=>row.reviewId===result.data.id):[];
  const copiedFiles=copiedAttachments.map(row=>({metadata:row,bytesBase64:fs.readFileSync(path.join(f.h.dataPath,'attachments',row.storageName)).toString('base64')}));
  const observation={normal:normalObservation,sourceReviewId:f.source.review.id,destinationProjectId:f.destination.project.id,
    originalSource:rawSource,replacementTitle,replacementBody,originalEpoch,currentEpoch:epoch(),originalGeneration,replacementGeneration,
    originalAttachment:rawAttachment,originalBytesBase64:originalBytes.toString('base64'),result:result||null,before:before||null,after:after||null,
    deltas:before&&after?delta(before,after):null,copiedFiles,
    replacementAdopted:Boolean(result?.ok&&result.data.title===replacementTitle&&result.data.body===replacementBody),
    readFunctionRestored:require('node:fs/promises').readFile===originalRead,setupError:setupError||null,cleanupError:cleanupError||null,
    scope:'Controlled production main/Store copy with one held attachment read and same-epoch review replacement; no GUI, native app, or remote writer'};
  t.diagnostic('review-copy-source-incarnation-baseline '+JSON.stringify(observation));
  assert.equal(setupError,undefined,'The same-epoch replacement and original read must settle before checking the product result');
  assert.equal(cleanupError,undefined);
  assert.ok(replacementGeneration>originalGeneration);assert.equal(epoch(),originalEpoch);
  assert.equal(result.ok,false,'The original copy must not adopt a new source review merely because its public ID is unchanged');
  assert.deepEqual(after,before);
  assert.deepEqual(fs.readFileSync(f.originalPath),originalBytes);
});

test('review.copy refuses a source moved to another project during its selected attachment read',async t=>{
  const f=await heldReviewCopy(t),store=f.h.state.liveStore;
  const moved=store.saveProject({groupId:f.source.group.id,name:'Moved source project',serviceIds:[f.source.service.id]});
  const epoch=store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch;
  const generation=()=>store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(f.source.review.id).generation;
  const originalGeneration=generation(),bytes=fs.readFileSync(f.originalPath);
  try{
    await f.hold();
    store.db.prepare('UPDATE reviews SET projectId=?,number=1 WHERE id=?').run(moved.id,f.source.review.id);
    assert.equal(generation(),originalGeneration);
    assert.equal(store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch,epoch);
    const before=f.observe(),result=await f.settle();
    assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_REVIEW');
    assert.deepEqual(f.observe(),before);assert.deepEqual(fs.readFileSync(f.originalPath),bytes);
  }finally{await f.close();}
});

test('review.copy permits a changed source service and unlinked old service during its selected attachment read',async t=>{
  const f=await heldReviewCopy(t),store=f.h.state.liveStore,bytes=fs.readFileSync(f.originalPath);
  const generation=()=>store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(f.source.review.id).generation;
  const originalGeneration=generation();
  try{
    await f.hold();
    const next=store.saveService({groupId:f.source.group.id,name:'Next source service',kind:'local',rootPath:f.h.root});
    store.setProjectServices(f.source.project.id,[f.source.service.id,next.id]);
    store.saveReview({id:f.source.review.id,serviceId:next.id});
    store.setProjectServices(f.source.project.id,[next.id]);
    assert.equal(generation(),originalGeneration);assert.equal(store.listAgentRuns(f.source.review.id).length,0);
    const currentSource=store.get('reviews',f.source.review.id),before=f.observe(),result=await f.settle(),after=f.observe();
    assert.equal(result.ok,true);assert.equal(result.data.projectId,f.destination.project.id);
    assert.deepEqual(store.get('reviews',f.source.review.id),currentSource);
    assert.equal(store.get('reviews',f.source.review.id).serviceId,next.id);
    assert.equal(store.project(f.source.project.id).serviceIds.includes(f.source.service.id),false);
    assert.ok(before.graph.activities.every(row=>after.graph.activities.some(current=>current.id===row.id&&current.body===row.body)));
    const copied=after.graph.attachments.filter(row=>row.reviewId===result.data.id);assert.equal(copied.length,1);
    assert.equal(copied[0].sha256,f.original.sha256);assert.equal(after.notices,before.notices+1);
    assert.deepEqual(fs.readFileSync(path.join(f.h.dataPath,'attachments',copied[0].storageName)),bytes);
    assert.deepEqual(fs.readFileSync(f.originalPath),bytes);
  }finally{await f.close();}
});

test('review.copy refuses source rebirth after physical publication and before SQL',async t=>{
  let armed=false,published,expected,rawSource,rawAttachment,sourceReviewId,originalPath,originalBytes,generationBefore;
  const h=await harness(t,{afterMainAtomicWrite({file,store}){
    if(!armed||path.dirname(file)!==path.join(h.dataPath,'attachments'))return;
    armed=false;published=file;assert.notEqual(file,originalPath);
    assert.deepEqual(fs.readFileSync(file),originalBytes);
    store.transaction(()=>{
      store.deleteReview(sourceReviewId);
      store.upsert('reviews',{...rawSource,title:'Replacement at the final copy commit',body:'Preserve this new source incarnation'});
      store.upsert('attachments',rawAttachment);
    });
    assert.ok(store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(sourceReviewId).generation>generationBefore);
    expected=store.exportData();
  }}),source=await seed(h),destination=await seed(h),original=await addFile(h,source.review.id,'Original source-birth commit bytes');
  const store=h.state.liveStore,epoch=store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch;
  sourceReviewId=source.review.id;originalPath=path.join(h.dataPath,'attachments',original.storageName);originalBytes=fs.readFileSync(originalPath);
  rawSource={...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(sourceReviewId)};
  rawAttachment={...store.db.prepare('SELECT * FROM attachments WHERE id=?').get(original.id)};
  generationBefore=store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(sourceReviewId).generation;
  await h.state.seasonIntegration.showReview({reviewId:source.review.id,fullscreen:false});
  const sourceClient=h.forWindow(await projectHost(h,source.project.id));
  await h.state.seasonIntegration.showReview({reviewId:destination.review.id,fullscreen:false});
  const other=h.forWindow(await projectHost(h,destination.project.id)),draft=path.join(h.root,'other-source-birth-draft.txt');
  fs.writeFileSync(draft,'Keep this other window source-birth token');
  const [token]=await other.success('attachment.stageFiles',{paths:[draft]});
  const files=fs.readdirSync(path.join(h.dataPath,'attachments')).sort();
  const notices=()=>h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length,beforeNotices=notices();
  try{
    armed=true;const result=await sourceClient.invoke('review.copy',{reviewId:source.review.id,projectId:destination.project.id,attachmentIds:[original.id]});
    assert.ok(published);assert.equal(armed,false);assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_REVIEW');
    assert.equal(result.error.message,'리뷰 또는 선택한 첨부 자료가 변경되었습니다. 사본을 다시 검사한 뒤 저장하십시오.');
    assert.equal(store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get().epoch,epoch);
    assert.deepEqual(store.exportData(),expected);assert.equal(fs.existsSync(published),false);
    assert.deepEqual(fs.readdirSync(path.join(h.dataPath,'attachments')).sort(),files);
    assert.deepEqual(fs.readFileSync(originalPath),originalBytes);assert.equal(notices(),beforeNotices);
    assert.equal((await other.success('attachment.stagePreview',{token:token.token})).content,'Keep this other window source-birth token');
  }finally{armed=false;await other.success('attachment.discard',{tokens:[token.token]});}
});

for(const change of ['QA activation and release','restored epoch','closed sender']) {
  test(`review.copy refuses its original ${change} after a held attachment read`,async t=>{
    const f=await heldReviewCopy(t),originalBytes=fs.readFileSync(f.originalPath);
    try{
      await f.hold();
      if(change==='QA activation and release'){
        const qa=await f.openQA();assert.equal(qa.windowId,f.context.windowId);await f.releaseQA(qa);
        assert.equal((await f.client.success('window.context')).qaProjectId,undefined);
      }
      if(change==='restored epoch')f.h.state.liveStore.importData(f.h.state.liveStore.exportData());
      if(change==='closed sender')f.host.destroy();
      const before=f.observe(),result=await f.settle(),after=f.observe();
      assert.equal(result.ok,false);assert.equal(result.error.code,change==='restored epoch'?'STALE_EPOCH':change==='closed sender'?'ACCESS_DENIED':'TARGET_MISMATCH');
      assert.deepEqual(after,before);assert.deepEqual(fs.readFileSync(f.originalPath),originalBytes);
    }finally{await f.close();}
  });
}

for(const change of ['ordinary activity history','another window QA activation']) {
  test(`review.copy allows ${change} while retaining its original request`,async t=>{
    const f=await heldReviewCopy(t),other=change==='another window QA activation'?await seed(f.h):null;
    let history;
    try{
      await f.hold();
      if(change==='ordinary activity history')history=f.h.state.liveStore.addActivity({reviewId:f.source.review.id,body:'A legitimate ordinary history entry'});
      if(other){const qa=await f.openQA(other.project.id);assert.notEqual(qa.windowId,f.context.windowId);}
      assert.equal(f.h.state.liveStore.listAgentRuns(f.source.review.id).length,0);
      assert.equal(f.h.state.liveStore.exportData().agentRequests.filter(row=>row.reviewId===f.source.review.id).length,0);
      const before=f.observe(),result=await f.settle(),after=f.observe();
      assert.equal(result.ok,true);assert.equal(result.data.projectId,f.destination.project.id);
      const copied=after.graph.attachments.filter(row=>row.reviewId===result.data.id);assert.equal(copied.length,1);
      assert.equal(copied[0].sha256,f.original.sha256);assert.equal(after.notices,before.notices+1);
      if(history)assert.ok(after.graph.activities.some(row=>row.id===history.id&&row.body===history.body));
      assert.deepEqual(fs.readFileSync(path.join(f.h.dataPath,'attachments',copied[0].storageName)),fs.readFileSync(f.originalPath));
    }finally{await f.close();}
  });
}

test('review.copy retains primitive request IDs when the caller object changes during its read',async t=>{
  const f=await heldReviewCopy(t),other=await seed(f.h),foreign=await addFile(f.h,other.review.id,'Foreign copy material');
  const input=f.input();
  try{
    await f.hold(input);input.reviewId=other.review.id;input.projectId=f.source.project.id;input.attachmentIds[0]=foreign.id;
    const result=await f.settle();assert.equal(result.ok,true);assert.equal(result.data.projectId,f.destination.project.id);
    assert.equal(result.data.evidence.copiedFrom.reviewId,f.source.review.id);
    assert.deepEqual(Array.from(result.data.evidence.copiedFrom.attachments,row=>row.id),[f.original.id]);
    const copied=f.h.state.liveStore.snapshot().attachments.filter(row=>row.reviewId===result.data.id);assert.equal(copied.length,1);
    assert.equal(copied[0].sha256,f.original.sha256);assert.deepEqual(fs.readFileSync(path.join(f.h.dataPath,'attachments',copied[0].storageName)),fs.readFileSync(f.originalPath));
  }finally{await f.close();}
});

test('review.copy is denied before reading in QA scope and a fresh request works after release',async t=>{
  const f=await heldReviewCopy(t);
  try{
    const qa=await f.openQA();assert.equal(qa.windowId,f.context.windowId);
    const before=f.observe(),fsp=require('node:fs/promises'),readFile=fsp.readFile;let reads=0,denied;
    fsp.readFile=async function(file,...args){if(file===f.originalPath)reads++;return readFile.call(fsp,file,...args);};
    try{denied=await f.client.invoke('review.copy',f.input());}finally{fsp.readFile=readFile;}
    assert.equal(reads,0);
    assert.equal(denied.ok,false);assert.equal(denied.error.code,'TARGET_MISMATCH');assert.deepEqual(f.observe(),before);
    await f.releaseQA(qa);await f.hold();const current=f.observe(),result=await f.settle();
    assert.equal(result.ok,true);assert.equal(result.data.projectId,f.destination.project.id);assert.equal(f.observe().notices,current.notices+1);
  }finally{await f.close();}
});

test('review.copy rechecks its epoch after physical publication and before SQL',async t=>{
  let armed=false,published,expected;
  const h=await harness(t,{afterMainAtomicWrite({file,store}){
    if(!armed||path.dirname(file)!==path.join(h.dataPath,'attachments'))return;
    armed=false;published=file;assert.equal(fs.readFileSync(file,'utf8'),'Original copy commit material');
    store.importData(store.exportData());expected=store.exportData();
  }}),source=await seed(h),destination=await seed(h),original=await addFile(h,source.review.id,'Original copy commit material');
  const originalPath=path.join(h.dataPath,'attachments',original.storageName),bytes=fs.readFileSync(originalPath),files=fs.readdirSync(path.join(h.dataPath,'attachments')).sort();
  const notices=()=>h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length,beforeNotices=notices();
  armed=true;const result=await h.invoke('review.copy',{reviewId:source.review.id,projectId:destination.project.id,attachmentIds:[original.id]});
  assert.ok(published);assert.notEqual(published,originalPath);assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_EPOCH');
  assert.deepEqual(h.state.liveStore.exportData(),expected);assert.equal(fs.existsSync(published),false);
  assert.deepEqual(fs.readdirSync(path.join(h.dataPath,'attachments')).sort(),files);assert.deepEqual(fs.readFileSync(originalPath),bytes);assert.equal(notices(),beforeNotices);
});

test('review.copy SQL failure removes only its new files and preserves another window staging token',async t=>{
  const h=await harness(t),source=await seed(h),destination=await seed(h),original=await addFile(h,source.review.id,'Keep the original copy bytes');
  await h.state.seasonIntegration.showReview({reviewId:source.review.id,fullscreen:false});const sourceClient=h.forWindow(await projectHost(h,source.project.id));
  await h.state.seasonIntegration.showReview({reviewId:destination.review.id,fullscreen:false});const other=h.forWindow(await projectHost(h,destination.project.id));
  const draft=path.join(h.root,'other-copy-draft.txt');fs.writeFileSync(draft,'Keep this unrelated staged token');
  const [token]=await other.success('attachment.stageFiles',{paths:[draft]});
  const before=h.state.liveStore.exportData(),files=fs.readdirSync(path.join(h.dataPath,'attachments')).sort(),originalPath=path.join(h.dataPath,'attachments',original.storageName),bytes=fs.readFileSync(originalPath);
  const notices=h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length,add=h.state.liveStore.addAttachment;
  h.state.liveStore.addAttachment=function(input){add.call(this,input);throw new Error('Deliberate copy attachment SQL failure');};
  try{
    const result=await sourceClient.invoke('review.copy',{reviewId:source.review.id,projectId:destination.project.id,attachmentIds:[original.id]});
    assert.equal(result.ok,false);assert.equal(result.error.message,'Deliberate copy attachment SQL failure');
    assert.deepEqual(h.state.liveStore.exportData(),before);assert.deepEqual(fs.readdirSync(path.join(h.dataPath,'attachments')).sort(),files);
    assert.deepEqual(fs.readFileSync(originalPath),bytes);assert.equal(h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length,notices);
    assert.equal((await other.success('attachment.stagePreview',{token:token.token})).content,'Keep this unrelated staged token');
  }finally{
    h.state.liveStore.addAttachment=add;await other.success('attachment.discard',{tokens:[token.token]});
  }
});

test('review.copy preserves selected attachment bytes in a separate file owned by the requesting window',async t=>{
  const h=await harness(t),source=await seed(h),destination=await seed(h);
  const original=await addFile(h,source.review.id,'Selected source attachment to copy');
  const originalContents=await h.success('attachment.read',{id:original.id});
  const originalReview=(await h.success('snapshot')).reviews.find(review=>review.id===source.review.id);
  await h.state.seasonIntegration.showReview({reviewId:source.review.id,fullscreen:false});
  const sourceHost=await projectHost(h,source.project.id),sourceClient=h.forWindow(sourceHost);
  await h.state.seasonIntegration.showReview({reviewId:destination.review.id,fullscreen:false});
  const otherHost=await projectHost(h,destination.project.id);h.state.focusedWindow=otherHost;
  const copied=await sourceClient.success('review.copy',{reviewId:source.review.id,projectId:destination.project.id,attachmentIds:[original.id]});
  const snapshot=await sourceClient.success('snapshot'),copies=snapshot.attachments.filter(file=>file.reviewId===copied.id);
  assert.equal(copied.projectId,destination.project.id);assert.equal(copies.length,1);
  const copy=copies[0];assert.equal(copy.name,original.name);assert.equal(copy.sha256,original.sha256);assert.equal(copy.size,original.size);
  assert.notEqual(copy.id,original.id);assert.notEqual(copy.storageName,original.storageName);
  assert.equal((await sourceClient.success('attachment.read',{id:copy.id})).content,originalContents.content);
  assert.deepEqual(fs.readFileSync(path.join(h.dataPath,'attachments',copy.storageName)),fs.readFileSync(path.join(h.dataPath,'attachments',original.storageName)));
  assert.deepEqual(snapshot.reviews.find(review=>review.id===source.review.id),originalReview);
  assert.deepEqual(snapshot.attachments.find(file=>file.id===original.id),original);
  assert.equal(copied.evidence.copiedFrom.reviewId,source.review.id);assert.equal(copied.evidence.copiedFrom.attachments[0].sha256,original.sha256);
  assert.deepEqual(await sourceClient.success('agent.list',{reviewId:copied.id}),[]);assert.equal(h.state.agentStarts.length,0);
});

test('version lists return inspected copies without changing data or notifying local and integration readers',async t=>{
 const h=await harness(t),a=await seed(h),file=await addFile(h,a.review.id,'Read-only version bytes');
 const entry=await h.success('review.version.save',{reviewId:a.review.id,target:{code:'retained-target'},attachmentIds:[file.id]});
 const before=h.state.liveStore.exportData(),notices=()=>h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length,beforeNotices=notices();
 const local=await h.success('review.version.list',{reviewId:a.review.id});
 const integration=await h.state.toolIntegration.dispatch('review.version.list',{reviewId:a.review.id});
 for(const listed of [local,integration]){
  assert.equal(listed.currentTarget.code,'retained-target');assert.equal(listed.entries[0].id,entry.id);
  assert.equal(listed.entries[0].attachments[0].status,'available');assert.equal(listed.entries[0].attachments[0].sha256,file.sha256);
 }
 assert.deepEqual(h.state.liveStore.exportData(),before);
 assert.equal(notices(),beforeNotices,'Reading retained versions must not send a data-change notification');
});

test('version targets send one notice per committed change and none for refusals',async t=>{
 const h=await harness(t),a=await seed(h),file=await addFile(h,a.review.id,'Retained target bytes');
 const entry=await h.success('review.version.save',{reviewId:a.review.id,target:{code:'saved-target'},attachmentIds:[file.id]});
 const notices=()=>h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length;
 for(const [label,change] of [
  ['local',payload=>h.success('review.version.target',payload)],
  ['integration',payload=>h.state.toolIntegration.dispatch('review.version.target',payload)]
 ]){
  const beforeNotices=notices(),code=`${label}-target`;
  await change({reviewId:a.review.id,target:{code}});
  const versions=h.state.liveStore.get('reviews',a.review.id).evidence.review_versions;
  assert.equal(versions.currentTarget.code,code);assert.deepEqual(versions.entries.map(row=>row.id),[entry.id]);
  assert.equal(notices(),beforeNotices+1,`${label} target commits must send exactly one notice`);
  const before=h.state.liveStore.exportData();
  await assert.rejects(change({reviewId:a.review.id,target:{}}),/하나의 버전을 입력/);
  assert.deepEqual(h.state.liveStore.exportData(),before);
  assert.equal(notices(),beforeNotices+1,`${label} target refusals must not send a notice`);
 }
});

test('version save uses its original main frame and sends one notice after its commit',async t=>{
 const h=await harness(t),a=await seed(h),file=await addFile(h,a.review.id,'Retained version bytes');
 const notices=()=>h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length,before=notices();
 const entry=await h.success('review.version.save',{reviewId:a.review.id,target:{code:'owned-version'},attachmentIds:[file.id]});
 assert.equal(h.state.liveStore.get('reviews',a.review.id).evidence.review_versions.entries[0].id,entry.id);
 assert.equal(notices(),before+1);assert.equal((await h.success('review.version.list',{reviewId:a.review.id})).entries[0].attachments[0].status,'available');
});
for(const change of ['revision','closed window','released QA scope','restored epoch']) {
 test(`version save rejects its ${change} race without a data-change notice`,async t=>{
  let entered,release;const reading=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
  const h=await harness(t,{versionReadGate:()=>{entered();return gate;}}),a=await seed(h),file=await addFile(h,a.review.id,'Retained version bytes');
  await h.state.seasonIntegration.showReview({reviewId:a.review.id,fullscreen:false});
  const host=await projectHost(h,a.project.id),client=h.forWindow(host);
  const qa=change==='released QA scope'?await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'version-original-scope'}):null;
  const notices=()=>h.state.windowMessages.filter(row=>row.channel==='reviewops:data-change').length,beforeNotices=notices();
  const input={reviewId:a.review.id,target:{code:'Keep this draft'},source:'Keep this source',attachmentIds:[file.id]},beforeInput=structuredClone(input);
  const pending=client.invoke('review.version.save',input);await reading;let expected,result,expectedNotices;
  try{
   if(change==='revision')h.state.liveStore.addActivity({reviewId:a.review.id,body:'A legitimate concurrent edit'});
   if(change==='closed window'){host.destroy();h.state.focusedWindow=h.state.primaryWindow;}
   if(change==='released QA scope')assert.equal((await h.state.toolIntegration.automationHandler('automation.qa.release',qa)).released,true);
   if(change==='restored epoch')h.state.liveStore.importData(h.state.liveStore.exportData());
   expected=h.state.liveStore.exportData();expectedNotices=notices();
  }finally{release();result=await pending;}
  const code=change==='revision'?'REVISION_CONFLICT':change==='closed window'?'ACCESS_DENIED':change==='released QA scope'?'TARGET_MISMATCH':'STALE_EPOCH';
  assert.equal(result.ok,false);assert.equal(result.error.code,code);assert.deepEqual(h.state.liveStore.exportData(),expected);
  assert.equal(expectedNotices,beforeNotices+(change==='released QA scope'?1:0),'Only the explicit QA release sends its existing scope notification');
  assert.equal(notices(),expectedNotices);assert.deepEqual(input,beforeInput);
  if(['revision','restored epoch'].includes(change))assert.equal(result.error.message,'리뷰 또는 선택한 첨부 자료가 변경되었습니다. 사본을 다시 검사한 뒤 저장하십시오.');
 });
}

function importBundle(h) {
  const source = createStore({ dbPath: path.join(h.root, 'import-source.sqlite') });
  try {
    const group = source.saveGroup({ name: '가져올 합성 그룹' });
    const project = source.saveProject({ groupId: group.id, name: '가져올 합성 프로젝트' });
    const review = source.saveReview({ projectId: project.id, title: '가져올 합성 리뷰' });
    const bytes = Buffer.from('new synthetic attachment');
    const storageName = `${crypto.randomUUID()}.txt`;
    source.addAttachment({ reviewId: review.id, name: '새 첨부.txt', storageName, mimeType: 'text/plain', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    const bundle = { format: 'reviewops-local-backup', version: 1, data: source.exportData(), files: { [storageName]: bytes.toString('base64') } };
    const file = path.join(h.root, 'restore.reviewops.json');
    fs.writeFileSync(file, JSON.stringify(bundle));
    return file;
  } finally { source.close(); }
}

for (const when of ['before', 'after']) {
  test(`service.save restores SQLite and vault when secret commit fails ${when} writing`, async t => {
    const h = await harness(t);
    const { group, service } = await seed(h);
    const before = await h.success('snapshot');
    const credentialPath = path.join(h.dataPath, 'credentials.json');
    const credentials = fs.readFileSync(credentialPath, 'utf8');
    h.state.failures.commit = when;
    for (const payload of [
      { id: service.id, name: '저장되면 안 되는 서비스', host: 'changed.example.test', password: 'synthetic-new-password' },
      { groupId: group.id, name: '생성되면 안 되는 서비스', kind: 'ssh', host: 'new.example.test', username: 'tester', password: 'synthetic-new-password' }
    ]) {
      const result = await h.invoke('service.save', payload);
      assert.equal(result.ok, false);
      assert.match(result.error.message, /simulated vault commit/);
      assert.deepEqual(await h.success('snapshot'), before);
      assert.equal(fs.readFileSync(credentialPath, 'utf8'), credentials);
      assert.deepEqual(h.state.realVault.get(service.id), { password: 'synthetic-old-password' });
    }
    delete h.state.failures.commit;
    const saved = await h.success('service.save', { id: service.id, name: '정상 저장' });
    assert.equal(saved.name, '정상 저장');
    assert.equal(saved.hasPassword, true);
    assert.equal(Object.hasOwn(saved, 'password'), false);
  });

  test(`backup.import retains old data and attachments when vault.clear fails ${when} writing`, async t => {
    const h = await harness(t);
    const { service, review } = await seed(h);
    const attachment = await addFile(h, review.id);
    const before = await h.success('snapshot');
    const credentials = fs.readFileSync(path.join(h.dataPath, 'credentials.json'), 'utf8');
    const attachmentDir = path.join(h.dataPath, 'attachments');
    const filesBefore = fs.readdirSync(attachmentDir).sort();
    const bytesBefore = fs.readFileSync(path.join(attachmentDir, attachment.storageName));
    h.state.openResult = { canceled: false, filePaths: [importBundle(h)] };
    h.state.failures.clear = when;
    const result = await h.invoke('backup.import');
    assert.equal(result.ok, false);
    assert.match(result.error.message, /simulated vault clear/);
    assert.deepEqual(await h.success('snapshot'), before);
    assert.equal(fs.readFileSync(path.join(h.dataPath, 'credentials.json'), 'utf8'), credentials);
    assert.deepEqual(h.state.realVault.get(service.id), { password: 'synthetic-old-password' });
    assert.deepEqual(fs.readdirSync(attachmentDir).sort(), filesBefore, 'staged imported attachments must be removed');
    assert.deepEqual(fs.readFileSync(path.join(attachmentDir, attachment.storageName)), bytesBefore);
    assert.equal(h.state.messageCalls, 1);
    const recovery = fs.readdirSync(path.join(h.dataPath, 'recovery'));
    assert.equal(recovery.length, 1);
    const recoveryData = JSON.parse(fs.readFileSync(path.join(h.dataPath, 'recovery', recovery[0], 'backup.reviewops.json'), 'utf8'));
    assert.equal(recoveryData.data.reviews[0].title, '합성 리뷰');
    delete h.state.failures.clear;
    assert.equal((await h.success('settings.save', { theme: 'dark' })).theme, 'dark', 'restore lock must be released after failure');
  });
}

test('service.delete restores an unreferenced service and secrets when credential deletion fails', async t => {
  const h = await harness(t);
  const { service, review } = await seed(h);
  await h.success('review.delete', { id: review.id });
  const project=(await h.success('snapshot')).projects[0];await h.success('project.save',{id:project.id,serviceIds:[]});
  const before = await h.success('snapshot');
  h.state.failures.delete = 'after';
  const result = await h.invoke('service.delete', { id: service.id });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /simulated vault delete/);
  assert.deepEqual(await h.success('snapshot'), before);
  assert.deepEqual(h.state.realVault.get(service.id), { password: 'synthetic-old-password' });
});

test('group deletion removes descendant files and credentials, cancels only its agents, and preserves another group',async t=>{
 const h=await harness(t),target=await seed(h),keep=await seed(h);
 await h.success('service.save',{id:target.service.id,agentEnabled:1});await h.success('service.save',{id:keep.service.id,agentEnabled:1,rootPath:'/tmp/retained-group-work'});
 const removed=await addFile(h,target.review.id,'remove bytes'),retained=await addFile(h,keep.review.id,'keep bytes');
 const run=await h.success('agent.start',{reviewId:target.review.id,prompt:'synthetic delete target'}),other=await h.success('agent.start',{reviewId:keep.review.id,prompt:'synthetic retained request'});
 await h.state.seasonIntegration.showReview({reviewId:target.review.id,fullscreen:false});
 assert.deepEqual(await h.success('group.delete',{id:target.group.id}),{deleted:true});
 const snapshot=await h.success('snapshot');
 assert.deepEqual(snapshot.groups.map(item=>item.id),[keep.group.id]);assert.deepEqual(snapshot.projects.map(item=>item.id),[keep.project.id]);assert.deepEqual(snapshot.services.map(item=>item.id),[keep.service.id]);assert.deepEqual(snapshot.reviews.map(item=>item.id),[keep.review.id]);
 assert(snapshot.activities.every(item=>item.reviewId===keep.review.id));assert.deepEqual(snapshot.attachments.map(item=>item.id),[retained.id]);
 assert.equal(fs.existsSync(path.join(h.dataPath,'attachments',removed.storageName)),false);assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',retained.storageName),'utf8'),'keep bytes');
 assert.deepEqual(h.state.realVault.get(target.service.id),{});assert.equal(h.state.realVault.get(keep.service.id).password,'synthetic-old-password');
 assert.deepEqual(h.state.agentCancelled,[run.id]);assert.equal((await h.success('agent.read',{id:other.id})).status,'running');assert.equal((await h.invoke('agent.read',{id:run.id})).ok,false);assert.equal(snapshot.agentRunning,1);assert.equal(await h.success('integration.pending'),null);
 assert.equal(fs.readdirSync(path.join(h.dataPath,'attachments')).some(name=>name.startsWith('.deleting-')),false);
});

test('project deletion removes its descendants and files while retaining a shared service and other project',async t=>{
 const h=await harness(t),{group,service,project,review}=await seed(h);
 const keep=await h.success('project.save',{groupId:group.id,name:'유지 프로젝트',serviceIds:[service.id]}),other=await h.success('review.save',{projectId:keep.id,serviceId:service.id,title:'유지 리뷰'});
 const removed=await addFile(h,review.id),retained=await addFile(h,other.id,'keep shared service');
 await h.success('project.delete',{id:project.id});const snapshot=await h.success('snapshot');
 assert.deepEqual(snapshot.projects.map(item=>item.id),[keep.id]);assert.deepEqual(snapshot.projects[0].serviceIds,[service.id]);assert.deepEqual(snapshot.reviews.map(item=>item.id),[other.id]);assert.equal(snapshot.services.length,1);
 assert.equal(fs.existsSync(path.join(h.dataPath,'attachments',removed.storageName)),false);assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',retained.storageName),'utf8'),'keep shared service');assert.equal(h.state.realVault.get(service.id).password,'synthetic-old-password');
});

test('group credential failure rolls back every descendant and restores staged attachment bytes',async t=>{
 const h=await harness(t),{group,review,service}=await seed(h);const file=await addFile(h,review.id,'restore deleted bytes');
 const before=await h.success('snapshot'),credentials=fs.readFileSync(path.join(h.dataPath,'credentials.json'));h.state.failures.delete='after';
 const result=await h.invoke('group.delete',{id:group.id});assert.equal(result.ok,false);assert.match(result.error.message,/simulated vault delete/);
 assert.deepEqual(await h.success('snapshot'),before);assert.deepEqual(fs.readFileSync(path.join(h.dataPath,'credentials.json')),credentials);assert.equal(h.state.realVault.get(service.id).password,'synthetic-old-password');assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',file.storageName),'utf8'),'restore deleted bytes');
 assert.equal(fs.readdirSync(path.join(h.dataPath,'attachments')).some(name=>name.startsWith('.deleting-')),false);
});

test('service deletion requires detaching projects and then cancels its agent while retaining the review and history',async t=>{
 const h=await harness(t),{project,service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});const attachment=await addFile(h,review.id,'retained service deletion');
 const run=await h.success('agent.start',{reviewId:review.id,prompt:'synthetic service request'});
 const before=await h.success('snapshot'),blocked=await h.invoke('service.delete',{id:service.id});assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'IN_USE');assert.deepEqual(await h.success('snapshot'),before);assert.deepEqual(h.state.agentCancelled,[]);
 await h.success('project.save',{id:project.id,serviceIds:[]});await h.success('service.delete',{id:service.id});const after=await h.success('snapshot');
 assert.equal(after.reviews[0].id,review.id);assert.equal(after.reviews[0].serviceId,null);assert.equal(after.projects[0].id,project.id);assert.deepEqual(after.projects[0].serviceIds,[]);assert.equal(after.services.length,0);assert.equal(after.agentRunning,0);assert.equal(after.attachments[0].id,attachment.id);
 assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',attachment.storageName),'utf8'),'retained service deletion');assert.deepEqual(h.state.agentCancelled,[run.id]);const history=await h.success('agent.read',{id:run.id});assert.equal(history.status,'cancelled');assert.equal(history.serviceId,null);assert.deepEqual(h.state.realVault.get(service.id),{});
});

test('deletion waits for agent termination and leaves all data when stopping fails',async t=>{
 const h=await harness(t),{project,service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});await addFile(h,review.id);
 await h.success('agent.start',{reviewId:review.id,prompt:'synthetic active request'});const before=await h.success('snapshot');h.state.agentCancelError=true;
 const result=await h.invoke('project.delete',{id:project.id});assert.equal(result.ok,false);assert.match(result.error.message,/synthetic agent cancel failure/);assert.deepEqual(await h.success('snapshot'),before);
});

test('startup restores still-referenced staged files and removes files from committed deletions',async t=>{
 const keptName=crypto.randomUUID()+'.txt',orphanName=crypto.randomUUID()+'.txt';
 const h=await harness(t,{prepare({dataPath}){
  const store=createStore({dbPath:path.join(dataPath,'reviewops.sqlite')}),group=store.saveGroup({name:'중단 복구'}),project=store.saveProject({groupId:group.id,name:'복구 프로젝트'}),review=store.saveReview({projectId:project.id,title:'유지 리뷰'});
  const bytes=Buffer.from('retain after interruption');store.addAttachment({reviewId:review.id,name:'retained.txt',storageName:keptName,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});store.close();
  const directory=path.join(dataPath,'attachments',`.deleting-${crypto.randomUUID()}`);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,keptName),bytes);fs.writeFileSync(path.join(directory,orphanName),'committed deletion');
 }});
 assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',keptName),'utf8'),'retain after interruption');assert.deepEqual(fs.readdirSync(path.join(h.dataPath,'attachments')),[keptName]);assert.equal((await h.success('snapshot')).attachments.length,1);
});

test('a database error after vault.clear restores previous credentials and imported files', async t => {
  const h = await harness(t);
  const { service, review } = await seed(h);
  await addFile(h, review.id);
  const before = await h.success('snapshot');
  const beforeFiles = fs.readdirSync(path.join(h.dataPath, 'attachments')).sort();
  h.state.openResult = { canceled: false, filePaths: [importBundle(h)] };
  const originalImport = h.state.liveStore.importData;
  h.state.liveStore.importData = function(data) {
    originalImport.call(this, data);
    throw new Error('simulated SQL commit failure');
  };
  const result = await h.invoke('backup.import');
  assert.equal(result.ok, false);
  assert.match(result.error.message, /simulated SQL commit failure/);
  assert.deepEqual(await h.success('snapshot'), before);
  assert.deepEqual(h.state.realVault.get(service.id), { password: 'synthetic-old-password' });
  assert.deepEqual(fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), beforeFiles);
});

test('backup.export and attachment.export reject the managed folder and directory symlink aliases', async t => {
  const h = await harness(t);
  const { review } = await seed(h);
  const attachment = await addFile(h, review.id);
  const before = await h.success('snapshot');
  const credentials = fs.readFileSync(path.join(h.dataPath, 'credentials.json'), 'utf8');
  const alias = path.join(h.root, 'data-link');
  fs.symlinkSync(h.dataPath, alias, 'dir');
  for (const action of ['backup.export', 'attachment.export']) {
    for (const destination of [path.join(h.dataPath, 'reviewops.sqlite'), path.join(h.dataPath, 'credentials.json'), path.join(h.dataPath, 'attachments', attachment.storageName), path.join(alias, 'reviewops.sqlite')]) {
      h.state.saveResult = { canceled: false, filePath: destination };
      const result = await h.invoke(action, { id: attachment.id });
      assert.equal(result.ok, false, `${action} must reject ${destination}`);
      assert.match(result.error.message, /앱 데이터 폴더 밖/);
      assert.deepEqual(await h.success('snapshot'), before);
      assert.equal(fs.readFileSync(path.join(h.dataPath, 'credentials.json'), 'utf8'), credentials);
      assert.equal(fs.readFileSync(path.join(h.dataPath, 'attachments', attachment.storageName), 'utf8'), 'synthetic attachment');
    }
  }
});

test('export to a sibling folder succeeds and backups exclude plaintext and encrypted secrets', async t => {
  const h = await harness(t);
  const { review } = await seed(h);
  const attachment = await addFile(h, review.id);
  const destination = path.join(h.root, 'data-exports'); fs.mkdirSync(destination);
  const backupFile = path.join(destination, 'backup.reviewops.json');
  h.state.saveResult = { canceled: false, filePath: backupFile };
  assert.equal((await h.success('backup.export')).path, backupFile);
  const serialized = fs.readFileSync(backupFile, 'utf8');
  const data = JSON.parse(serialized);
  assert.equal(data.data.reviews[0].id, review.id);
  assert.equal(Buffer.from(data.files[attachment.storageName], 'base64').toString(), 'synthetic attachment');
  for (const value of ['synthetic-old-password', 'hasPassword', 'hasPassphrase', 'credentials.json']) assert.equal(serialized.includes(value), false);
  const credentials = JSON.parse(fs.readFileSync(path.join(h.dataPath, 'credentials.json'), 'utf8'));
  for (const record of Object.values(credentials)) {
    for (const encrypted of Object.values(record)) assert.equal(serialized.includes(encrypted), false);
  }
  const outputFile = path.join(destination, 'attachment.txt');
  h.state.saveResult = { canceled: false, filePath: outputFile };
  assert.equal((await h.success('attachment.export', { id: attachment.id })).path, outputFile);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'synthetic attachment');
});

test('IPC rejects iframe and different-window senders before reading or changing local data', async t => {
  const h = await harness(t);
  await seed(h);
  const before = await h.success('snapshot');
  const base = h.event();
  const badSenders = [
    { sender: base.sender, senderFrame: { url: base.senderFrame.url, parent: base.senderFrame } },
    { sender: {}, senderFrame: base.senderFrame },
    { sender: base.sender, senderFrame: { url: 'https://example.test/' } },
    { sender: base.sender, senderFrame: null }
  ];
  for (const sender of badSenders) {
    for (const action of ['snapshot', 'group.save']) {
      const result = await h.invoke(action, { name: '허용되면 안 되는 그룹' }, sender);
      assert.equal(result.ok, false);
      assert.match(result.error.message, /허용되지 않은 요청/);
    }
  }
  const originalUrl = base.senderFrame.url;
  base.senderFrame.url = 'https://example.test/';
  const foreignOrigin = await h.invoke('snapshot', {}, base);
  assert.equal(foreignOrigin.ok, false);
  base.senderFrame.url = originalUrl;
  assert.deepEqual(await h.success('snapshot'), before);
});

test('frameless host controls enter and leave native fullscreen and follow OS changes', async t => {
  const h = await harness(t), host = h.state.window;
  assert.equal(host.options.frame, false);
  assert.deepEqual(await h.success('window.state'), { maximized: false, fullScreen: false });
  assert.deepEqual(await h.success('window.fullscreen'), { maximized: false, fullScreen: true });
  assert.deepEqual(await h.success('window.fullscreen'), { maximized: false, fullScreen: false });
  // The native menu and OS shortcuts must keep the custom buttons in sync too.
  host.maximize();
  assert.deepEqual(await h.success('window.state'), { maximized: true, fullScreen: false });
  host.unmaximize();
  assert.deepEqual(await h.success('window.state'), { maximized: false, fullScreen: false });
  host.setFullScreen(true);
  assert.deepEqual(await h.success('window.state'), { maximized: false, fullScreen: true });
  host.setFullScreen(false);
  assert.deepEqual(await h.success('window.state'), { maximized: false, fullScreen: false });
  assert.deepEqual(h.state.windowMessages, [
    { channel: 'reviewops:window-state', data: { maximized: false, fullScreen: true } },
    { channel: 'reviewops:window-state', data: { maximized: false, fullScreen: false } },
    { channel: 'reviewops:window-state', data: { maximized: true, fullScreen: false } },
    { channel: 'reviewops:window-state', data: { maximized: false, fullScreen: false } },
    { channel: 'reviewops:window-state', data: { maximized: false, fullScreen: true } },
    { channel: 'reviewops:window-state', data: { maximized: false, fullScreen: false } }
  ]);
});

test('fullscreen replies wait for native transitions and do not maximize the window', async t => {
  const h = await harness(t), host = h.state.window;
  let requested, settled = false, requests = 0;
  host.maximize = host.unmaximize = () => { throw new Error('Fullscreen must use the native fullscreen transition'); };
  host.setFullScreen = value => { requested = value; requests++; };
  const entering = h.success('window.fullscreen').then(result => { settled = true; return result; });
  await new Promise(setImmediate);
  assert.equal(requested, true);
  assert.equal(settled, false, 'macOS may still be animating after setFullScreen returns');
  const repeated = h.success('window.fullscreen');
  await new Promise(setImmediate);
  assert.equal(requests, 1, 'Repeated clicks must share the native transition');
  assert.deepEqual(await h.success('window.state'), { maximized: false, fullScreen: false });
  assert.deepEqual(h.state.windowMessages, []);
  host.fullScreen = true;
  host.emit('enter-full-screen');
  assert.deepEqual(await entering, { maximized: false, fullScreen: true });
  assert.deepEqual(await repeated, { maximized: false, fullScreen: true });
  settled = false;
  const leaving = h.success('window.fullscreen').then(result => { settled = true; return result; });
  await new Promise(setImmediate);
  assert.equal(requested, false);
  assert.equal(settled, false);
  assert.deepEqual(await h.success('window.state'), { maximized: false, fullScreen: true });
  host.fullScreen = false;
  host.emit('leave-full-screen');
  assert.deepEqual(await leaving, { maximized: false, fullScreen: false });
  assert.deepEqual(h.state.windowMessages, [
    { channel: 'reviewops:window-state', data: { maximized: false, fullScreen: true } },
    { channel: 'reviewops:window-state', data: { maximized: false, fullScreen: false } }
  ]);
});

test('closing during a fullscreen transition rejects the request and removes transition listeners', async t => {
  const h = await harness(t), host = h.state.window;
  const enteringListeners = host.listenerCount('enter-full-screen');
  const leavingListeners = host.listenerCount('leave-full-screen');
  host.setFullScreen = () => {};
  const pending = h.invoke('window.fullscreen');
  await new Promise(setImmediate);
  assert.equal(host.listenerCount('enter-full-screen'), enteringListeners + 1);
  host.close();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error.message, /창이 닫혔습니다/);
  assert.equal(host.listenerCount('enter-full-screen'), enteringListeners);
  assert.equal(host.listenerCount('leave-full-screen'), leavingListeners);
  assert.equal(host.isDestroyed(), true);
});

test('external pages, child frames and other windows cannot operate host window controls', async t => {
  const h = await harness(t), base = h.event();
  const badSenders = [
    { sender: base.sender, senderFrame: { url: base.senderFrame.url, parent: base.senderFrame } },
    { sender: {}, senderFrame: base.senderFrame },
    { sender: base.sender, senderFrame: { url: 'https://example.test/' } },
    { sender: base.sender, senderFrame: null }
  ];
  for (const sender of badSenders) {
    for (const action of ['window.state', 'window.fullscreen', 'window.close']) {
      const result = await h.invoke(action, {}, sender);
      assert.equal(result.ok, false);
      assert.match(result.error.message, /허용되지 않은 요청/);
    }
  }
  const originalUrl = base.senderFrame.url;
  try {
    base.senderFrame.url = 'https://example.test/';
    for (const action of ['window.state', 'window.fullscreen', 'window.close']) {
      assert.equal((await h.invoke(action, {}, base)).ok, false);
    }
  } finally { base.senderFrame.url = originalUrl; }
  await new Promise(setImmediate);
  assert.equal(h.state.window.closeCalls, 0);
  assert.deepEqual(h.state.windowMessages, []);
  assert.deepEqual(await h.success('window.state'), { maximized: false, fullScreen: false });
});

test('custom close replies before using native close and preserves the unsaved-changes choice', async t => {
  const h = await harness(t), host = h.state.window;
  h.state.preventUnload = true;
  assert.deepEqual(await h.success('window.close'), { closing: true });
  assert.equal(host.closeCalls, 0, 'IPC response must reach the renderer before closing');
  await new Promise(setImmediate);
  assert.equal(host.closeCalls, 1);
  assert.equal(h.state.unloadCalls, 1);
  assert.equal(host.isDestroyed(), false, 'continuing to edit must preserve the host');
  assert.deepEqual(await h.success('window.state'), { maximized: false, fullScreen: false });
  h.state.unloadResponse = 1;
  assert.deepEqual(await h.success('window.close'), { closing: true });
  await new Promise(setImmediate);
  assert.equal(host.closeCalls, 2);
  assert.equal(h.state.unloadCalls, 2);
  assert.equal(host.isDestroyed(), true);
});

test('a pending custom close does not close an already destroyed host again', async t => {
  const h = await harness(t), host = h.state.window;
  assert.deepEqual(await h.success('window.close'), { closing: true });
  host.destroyed = true;
  await new Promise(setImmediate);
  assert.equal(host.closeCalls, 0);
  for (const action of ['window.state', 'window.fullscreen', 'window.close']) {
    const result = await h.invoke(action);
    assert.equal(result.ok, false);
    assert.match(result.error.message, /허용되지 않은 요청/);
  }
});

test('window controls stay available while a backup restore occupies the action queue', async t => {
  const h = await harness(t), host = h.state.window;
  let release, opened;
  const ready = new Promise(resolve => opened = resolve);
  h.state.openHandler = () => { opened(); return new Promise(resolve => release = resolve); };
  const restore = h.success('backup.import');
  await ready;
  const responsive = async action => {
    let timer;
    try {
      return await Promise.race([
        h.success(action),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${action} waited for the restore queue`)), 1000); })
      ]);
    } finally { clearTimeout(timer); }
  };
  // Keep this synthetic window alive while the open-file dialog is pending.
  host.on('close', event => event.preventDefault());
  try {
    assert.deepEqual(await responsive('window.state'), { maximized: false, fullScreen: false });
    assert.deepEqual(await responsive('window.fullscreen'), { maximized: false, fullScreen: true });
    assert.deepEqual(await responsive('window.close'), { closing: true });
    await new Promise(setImmediate);
    assert.equal(host.closeCalls, 1);
    assert.equal(host.isDestroyed(), false);
  } finally {
    release({ canceled: true, filePaths: [] });
    assert.equal((await restore).cancelled, true);
  }
});

test('successful restore replaces content, clears credentials and keeps previous recovery copy', async t => {
  const h = await harness(t);
  const { service, review } = await seed(h);
  await addFile(h, review.id);
  h.state.openResult = { canceled: false, filePaths: [importBundle(h)] };
  assert.deepEqual(await h.success('backup.import'), { imported: true });
  const after = await h.success('snapshot');
  assert.equal(after.groups[0].name, '가져올 합성 그룹');
  assert.equal(after.reviews[0].title, '가져올 합성 리뷰');
  assert.deepEqual(h.state.realVault.get(service.id), {});
  assert.equal(fs.readFileSync(path.join(h.dataPath, 'credentials.json'), 'utf8'), '{}');
  assert.equal((await h.success('attachment.read', { id: after.attachments[0].id })).content, 'new synthetic attachment');
  const recovery = fs.readdirSync(path.join(h.dataPath, 'recovery'));
  const previousCredentials = fs.readFileSync(path.join(h.dataPath, 'recovery', recovery[0], 'credentials.json'), 'utf8');
  assert(previousCredentials.includes(service.id));
  assert.equal(previousCredentials.includes('synthetic-old-password'), false);
});

async function stageFile(h, name='staged.txt') {
  const file=path.join(h.root,name);fs.writeFileSync(file,'staged attachment content');
  h.state.openResult={canceled:false,filePaths:[file]};
  return (await h.success('attachment.stage'))[0];
}
test('review registration commits staged files together and retries after validation failure',async t=>{
  const h=await harness(t),{project}=await seed(h);
  const staged=await stageFile(h);
  assert.deepEqual(Object.keys(staged).sort(),['mimeType','name','size','token']);
  const before=await h.success('snapshot');
  assert.equal(before.attachments.length,0);
  const invalid=await h.invoke('review.save',{projectId:project.id,title:'',attachmentTokens:[staged.token]});
  assert.equal(invalid.ok,false);
  assert.deepEqual(await h.success('snapshot'),before);
  assert.equal(fs.readdirSync(path.join(h.dataPath,'attachments')).length,0);
  const review=await h.success('review.save',{projectId:project.id,title:'첨부 포함 등록',attachmentTokens:[staged.token]});
  const after=await h.success('snapshot');
  assert.equal(after.attachments.length,1);
  assert.equal(after.attachments[0].reviewId,review.id);
  assert.equal((await h.success('attachment.read',{id:after.attachments[0].id})).content,'staged attachment content');
  assert.equal((await h.invoke('review.save',{id:review.id,title:'재사용',attachmentTokens:[staged.token]})).ok,false);
  assert.equal((await h.success('snapshot')).reviews.find(item=>item.id===review.id).title,review.title);
});
test('staged files-only comment belongs to its activity and can be edited',async t=>{
  const h=await harness(t),{review}=await seed(h),staged=await stageFile(h);
  assert.equal((await h.invoke('activity.add',{reviewId:review.id,allowEmpty:true,body:''})).ok,false);
  const activity=await h.success('activity.add',{reviewId:review.id,body:'',status:'in_progress',attachmentTokens:[staged.token]});
  const snapshot=await h.success('snapshot');
  assert.equal(activity.type,'comment');assert.equal(snapshot.attachments[0].activityId,activity.id);
  assert.equal(snapshot.reviews[0].status,'in_progress');
  assert.equal((await h.success('activity.update',{id:activity.id,body:'설명 추가'})).body,'설명 추가');
  const file=await h.success('attachment.read',{id:snapshot.attachments[0].id});
  assert.equal(file.content,'staged attachment content');
});
test('discarded, duplicate and unknown file tokens cannot change a review',async t=>{
  const h=await harness(t),{review}=await seed(h),staged=await stageFile(h);
  const before=await h.success('snapshot');
  for(const tokens of [[staged.token,staged.token],['unknown'],[42]]) {
    assert.equal((await h.invoke('review.save',{id:review.id,title:'저장 안 됨',attachmentTokens:tokens})).ok,false);
    assert.deepEqual(await h.success('snapshot'),before);
  }
  await h.success('attachment.discard',{tokens:[staged.token]});
  await h.success('attachment.discard',{tokens:[staged.token]});
  assert.equal((await h.invoke('review.save',{id:review.id,title:'저장 안 됨',attachmentTokens:[staged.token]})).ok,false);
  assert.equal(fs.readdirSync(path.join(h.dataPath,'attachments')).length,0);
});
test('failed comment attachment insert rolls back both comment and status',async t=>{
  const h=await harness(t),{review}=await seed(h),staged=await stageFile(h),before=await h.success('snapshot');
  const original=h.state.liveStore.addAttachment;
  h.state.liveStore.addAttachment=()=>{throw new Error('simulated metadata failure')};
  const result=await h.invoke('activity.add',{reviewId:review.id,body:'원자적 저장',status:'closed',attachmentTokens:[staged.token]});
  h.state.liveStore.addAttachment=original;
  assert.equal(result.ok,false);assert.deepEqual(await h.success('snapshot'),before);
  assert.equal(fs.readdirSync(path.join(h.dataPath,'attachments')).length,0);
  await h.success('activity.add',{reviewId:review.id,body:'재시도',attachmentTokens:[staged.token]});
  assert.equal((await h.success('snapshot')).attachments.length,1);
});
test('files selected in separate batches can be saved and discarded together',async t=>{
  const h=await harness(t),{review}=await seed(h),tokens=[];
  for(let index=0;index<12;index++)tokens.push((await stageFile(h,`part-${index}.txt`)).token);
  await h.success('activity.add',{reviewId:review.id,body:'여러 번 선택한 파일',attachmentTokens:tokens});
  assert.equal((await h.success('snapshot')).attachments.length,12);
  const more=[];
  for(let index=0;index<12;index++)more.push((await stageFile(h,`cancel-${index}.txt`)).token);
  await h.success('attachment.discard',{tokens:more});
  assert.equal((await h.invoke('activity.add',{reviewId:review.id,body:'취소한 첨부',attachmentTokens:more})).ok,false);
  assert.equal((await h.success('snapshot')).attachments.length,12);
});

test('opening and cancelling the restore picker preserves an active terminal',async t=>{
  const h=await harness(t),{service}=await seed(h);h.state.allowShell=true;
  const terminal=await h.success('terminal.open',{serviceId:service.id});
  let release,opened;
  const ready=new Promise(resolve=>opened=resolve);
  h.state.openHandler=()=>{opened();return new Promise(resolve=>release=resolve)};
  const restore=h.success('backup.import');await ready;
  const output=await h.success('terminal.read',{id:terminal.id,cursor:0});
  assert.equal(output.data,'session ready');assert.equal(output.closed,false);
  await h.success('terminal.resize',{id:terminal.id,cols:100,rows:30});
  release({canceled:true,filePaths:[]});assert.equal((await restore).cancelled,true);
  await h.success('terminal.write',{id:terminal.id,data:'still connected'});
  assert.equal((await h.success('terminal.read',{id:terminal.id,cursor:output.cursor})).data,'still connected');
  await h.success('terminal.close',{id:terminal.id});
});

for (const [label,patch] of [
  ['metadata',{name:'수정한 서비스',description:'설명 변경',memo:'작업 메모',labels:['개발'],operationalStatus:'archived'}],
  ['viewer',{viewerUrl:'https://viewer.example.test',viewerWidth:1600,viewerHeight:1000,viewerScale:'75'}],
  ['agent',{agentEnabled:1,agentBinary:'codex-custom',agentWorkPath:'/tmp/agent-work',agentModel:'fixture-model',agentReasoningEffort:'high',agentInstructions:'서비스의 작업 내용을 수정하십시오.'}],
  ['unchanged connection and empty secrets',{kind:'ssh',host:'example.test',port:22,username:'tester',authType:'password',privateKeyPath:'',rootPath:'/tmp/test',password:'',passphrase:''}]
]) test(`service.save preserves an active terminal and pending trust for ${label}`,async t=>{
  const h=await harness(t),{service}=await seed(h);h.state.allowShell=true;
  const terminal=await h.success('terminal.open',{serviceId:service.id});
  h.state.trustFingerprint=`SHA256:${'a'.repeat(43)}`;
  assert.equal((await h.invoke('ssh.test',{serviceId:service.id})).error.code,'SSH_TRUST_REQUIRED');
  await h.success('service.save',{id:service.id,...patch});
  const initial=await h.success('terminal.read',{id:terminal.id,cursor:0});
  assert.equal(initial.closed,false);
  await h.success('terminal.write',{id:terminal.id,data:'connection preserved'});
  assert.equal((await h.success('terminal.read',{id:terminal.id,cursor:initial.cursor})).data,'connection preserved');
  await h.success('terminal.resize',{id:terminal.id,cols:110,rows:32});
  await h.success('ssh.trust',{serviceId:service.id,fingerprint:h.state.trustFingerprint});
  await h.success('terminal.close',{id:terminal.id});
});

for (const [field,value] of [
  ['kind','local'],['host','changed.example.test'],['port',2222],['username','other-user'],
  ['authType','agent'],['privateKeyPath','/tmp/changed-private-key'],['rootPath','/tmp/changed-work']
]) test(`service.save closes its active terminal and discards pending trust when ${field} changes`,async t=>{
  const h=await harness(t),{service}=await seed(h);h.state.allowShell=true;
  const terminal=await h.success('terminal.open',{serviceId:service.id});
  h.state.trustFingerprint=`SHA256:${'a'.repeat(43)}`;
  assert.equal((await h.invoke('ssh.test',{serviceId:service.id})).error.code,'SSH_TRUST_REQUIRED');
  await h.success('service.save',{id:service.id,[field]:value});
  const read=await h.invoke('terminal.read',{id:terminal.id,cursor:0});
  assert.equal(read.ok,false);assert.equal(read.error.code,'TERMINAL_NOT_FOUND');
  assert.equal((await h.invoke('ssh.trust',{serviceId:service.id,fingerprint:h.state.trustFingerprint})).ok,false);
});

for (const [label,patch] of [
  ['password set',{password:'synthetic-new-password'}],['password clear',{clearPassword:true}],
  ['passphrase set',{passphrase:'synthetic-new-passphrase'}],['passphrase clear',{clearPassphrase:true}]
]) test(`service.save closes its active terminal and discards pending trust after ${label}`,async t=>{
  const h=await harness(t),{service}=await seed(h);h.state.allowShell=true;
  await h.success('service.save',{id:service.id,passphrase:'synthetic-old-passphrase'});
  const terminal=await h.success('terminal.open',{serviceId:service.id});
  h.state.trustFingerprint=`SHA256:${'a'.repeat(43)}`;
  assert.equal((await h.invoke('ssh.test',{serviceId:service.id})).error.code,'SSH_TRUST_REQUIRED');
  await h.success('service.save',{id:service.id,...patch});
  const read=await h.invoke('terminal.read',{id:terminal.id,cursor:0});
  assert.equal(read.ok,false);assert.equal(read.error.code,'TERMINAL_NOT_FOUND');
  assert.equal((await h.invoke('ssh.trust',{serviceId:service.id,fingerprint:h.state.trustFingerprint})).ok,false);
});

for (const when of ['before','after']) test(`failed service.save preserves its active terminal and pending trust ${when} credential write`,async t=>{
  const h=await harness(t),{service}=await seed(h);h.state.allowShell=true;
  const terminal=await h.success('terminal.open',{serviceId:service.id});
  h.state.trustFingerprint=`SHA256:${'a'.repeat(43)}`;
  assert.equal((await h.invoke('ssh.test',{serviceId:service.id})).error.code,'SSH_TRUST_REQUIRED');
  h.state.failures.commit=when;
  assert.equal((await h.invoke('service.save',{id:service.id,host:'changed.example.test',password:'synthetic-new-password'})).ok,false);
  delete h.state.failures.commit;
  const initial=await h.success('terminal.read',{id:terminal.id,cursor:0});
  assert.equal(initial.closed,false);
  await h.success('terminal.write',{id:terminal.id,data:'connection preserved after rollback'});
  assert.equal((await h.success('terminal.read',{id:terminal.id,cursor:initial.cursor})).data,'connection preserved after rollback');
  await h.success('ssh.trust',{serviceId:service.id,fingerprint:h.state.trustFingerprint});
  await h.success('terminal.close',{id:terminal.id});
});

test('dropped files use the staging limits, preview, validity check and discard path',async t=>{
 const h=await harness(t),file=path.join(h.root,'dropped.txt');fs.writeFileSync(file,'dropped file contents');
 const staged=await h.success('attachment.stageFiles',{paths:[file]});assert.equal(staged.length,1);
 const token=staged[0].token;assert.equal((await h.success('attachment.stagePreview',{token})).content,'dropped file contents');
 assert.deepEqual(await h.success('attachment.staged',{tokens:[token,'missing']}),{files:staged,expiredTokens:['missing']});
 for(const paths of [['relative.txt'],Array(11).fill(file),[file,path.join(h.root,'missing.txt')]])assert.equal((await h.invoke('attachment.stageFiles',{paths})).ok,false);
 assert.equal((await h.success('snapshot')).attachments.length,0);
 await h.success('attachment.discard',{tokens:[token]});assert.deepEqual((await h.success('attachment.staged',{tokens:[token]})).expiredTokens,[token]);
});

const syntheticEvidence=message=>({schemaVersion:1,capturedAt:new Date().toISOString(),url:'https://example.test',viewport:{width:1440,height:900,scale:1},console_log:[{message}],network_log:[],navigation_log:[],input_log:[],fingerprint_log:{platform:'fixture'}});
test('review logs and staged files commit together and a failed activity leaves logs unchanged',async t=>{
 const h=await harness(t),{review}=await seed(h),staged=await stageFile(h),before=await h.success('snapshot'),original=h.state.liveStore.addAttachment;
 h.state.liveStore.addAttachment=()=>{throw new Error('synthetic evidence save failure')};
 assert.equal((await h.invoke('activity.add',{reviewId:review.id,evidence:syntheticEvidence('new log'),attachmentTokens:[staged.token]})).ok,false);
 h.state.liveStore.addAttachment=original;assert.deepEqual(await h.success('snapshot'),before);assert.equal(fs.readdirSync(path.join(h.dataPath,'attachments')).length,0);
 await h.success('activity.add',{reviewId:review.id,evidence:syntheticEvidence('new log'),attachmentTokens:[staged.token]});
 const saved=await h.success('snapshot');assert.equal(saved.reviews[0].evidence.log_captures.length,1);assert.equal(saved.activities.at(-1).evidence.console_log[0].message,'new log');assert.equal(saved.attachments.length,1);
});

test('agent environment uses registered models only when the host did not return a model list',async t=>{
 const h=await harness(t),{service}=await seed(h);
 const models=[{id:'manual-code',label:'Manual Code',reasoning:['low','high'],defaultReasoningEffort:'high'}];
 await h.success('service.save',{id:service.id,agentModels:models});
 const fallback=await h.success('agent.environment',{serviceId:service.id});
 assert.equal(fallback.modelSource,'manual');assert.deepEqual(fallback.models,models);
 const hostModels=[{id:'host-code',label:'Host Code',reasoning:['medium'],defaultReasoningEffort:'medium'}];
 h.state.agentEnvironment={installed:true,loggedIn:true,models:hostModels,modelSource:'host',defaultModel:'host-code',defaultReasoningEffort:'medium'};
 const remote=await h.success('agent.environment',{serviceId:service.id});
 assert.equal(remote.modelSource,'host');assert.deepEqual(remote.models,hostModels);assert.equal(remote.defaultModel,'host-code');
 await h.success('service.save',{id:service.id,agentModels:[]});h.state.agentEnvironment={installed:true,models:[],modelSource:'none',modelError:'모델 목록을 불러오지 못했습니다.'};
 const empty=await h.success('agent.environment',{serviceId:service.id});assert.deepEqual(empty.models,[]);assert.equal(empty.modelSource,'none');assert.equal(empty.modelError,h.state.agentEnvironment.modelError);
});

test('review model reads stay immediate and do not probe hosts during a background refresh or running task',async t=>{
 const h=await harness(t),{service,review,project}=await seed(h);
 const saved=await h.success('project.save',{id:project.id,connection:{...service,agentEnabled:1}});
 h.state.agentEnvironment={installed:true,loggedIn:true,models:[{id:'cached-model',label:'Saved model',reasoning:['low','high'],defaultReasoningEffort:'high'}],defaultModel:'cached-model',defaultReasoningEffort:'high',modelSource:'host'};
 const snapshot=await h.success('modelCache.refresh');
 const remote=snapshot.targets.find(row=>row.id.startsWith('connection:'));assert(remote);
 let resolve;h.state.environmentGate=new Promise(done=>{resolve=done});t.after(()=>resolve());
 const refreshing=h.success('modelCache.refresh',{id:remote.id});await new Promise(setImmediate);
 const probes=h.state.environmentChecks.length;
 const value=await h.success('agent.models',{serviceId:service.id});
 assert.equal(value.models[0].id,'cached-model');assert.equal(value.refreshing,true);assert.equal(value.modelSource,'cache');assert.equal(h.state.environmentChecks.length,probes);
 await h.success('agent.start',{reviewId:review.id,prompt:'Use the saved model list',context:{instruction:false}});
 const running=await h.success('agent.models',{serviceId:saved.connection.id});assert.equal(running.models[0].id,'cached-model');assert.equal(h.state.environmentChecks.length,probes);
 resolve();const result=await refreshing;assert(Array.isArray(result.targets));
});

test('cache settings persist and cached reads preserve manual registrations without a live query',async t=>{
 const h=await harness(t),{service}=await seed(h);
 await h.success('service.save',{...service,agentModels:[{id:'registered-model',label:'Registered model',reasoning:['low'],defaultReasoningEffort:'low'}]});
 await h.success('modelCache.refresh');const before=h.state.environmentChecks.length;
 const value=await h.success('agent.models',{serviceId:service.id});assert.equal(value.modelSource,'manual');assert.equal(value.models[0].id,'registered-model');assert.equal(h.state.environmentChecks.length,before);
 const configured=await h.success('modelCache.configure',{intervalMinutes:120});assert.equal(configured.intervalMinutes,120);assert.equal((await h.success('modelCache.state')).intervalMinutes,120);
 const untrusted={sender:h.state.window.webContents,senderFrame:{url:'https://example.test/'}};
 assert.equal((await h.invoke('modelCache.refresh',{},untrusted)).ok,false);assert.equal((await h.invoke('agent.models',{serviceId:service.id},untrusted)).ok,false);
});

test('a host credential failure cannot block catalog listing or a different local catalog',async t=>{
 const h=await harness(t),{group}=await seed(h);
 h.state.agentEnvironment={installed:true,loggedIn:true,models:[{id:'local-model',label:'Local model',reasoning:['low']}],modelSource:'host'};
 h.state.failures.get='before';
 const local=await h.success('project.save',{groupId:group.id,name:'Independent local project',connection:{kind:'local',rootPath:h.root}});
 const state=await h.success('modelCache.refresh');assert(state.targets.some(row=>row.id.startsWith('connection:')&&row.error));assert.equal(state.targets.find(row=>row.id==='local').models[0].id,'local-model');
 assert.equal((await h.success('agent.models',{serviceId:local.connection.id})).models[0].id,'local-model');assert(Array.isArray((await h.success('modelCache.state')).targets));
});

test('login changes invalidate every executable sharing the same local account catalog',async t=>{
 const h=await harness(t),group=await h.success('group.save',{name:'Shared account catalogs'});
 h.state.agentEnvironment={models:[{id:'old-account',reasoning:['low']}],modelSource:'host'};
 const one=await h.success('project.save',{groupId:group.id,name:'Default executable',connection:{kind:'local',rootPath:h.root}});
 await h.success('project.save',{groupId:group.id,name:'Custom executable',connection:{kind:'local',rootPath:h.root,agentBinary:'/fixture/custom-codex'}});
 assert((await h.success('modelCache.refresh')).targets.every(row=>row.models[0].id==='old-account'));
 let release;h.state.environmentGate=new Promise(done=>{release=done});t.after(()=>release());
 h.state.agentUpdate({id:'synthetic-login',kind:'login',status:'completed',serviceId:one.connection.id});
 const changed=await h.success('modelCache.state');assert.equal(changed.targets.length,2);assert(changed.targets.every(row=>!row.models.length&&row.refreshing));
 h.state.agentEnvironment={models:[{id:'new-account',reasoning:['high']}],modelSource:'host'};release();
 assert((await h.success('modelCache.refresh')).targets.every(row=>row.models[0].id==='new-account'));
});

test('agent materials expose generated instructions and only shared files from the same group',async t=>{
 const h=await harness(t),{group,review}=await seed(h),otherProject=await h.success('project.save',{groupId:group.id,name:'같은 그룹'}),other=await h.success('review.save',{projectId:otherProject.id,title:'공용 자료'}),shared=await addFile(h,other.id,'shared bytes');
 const outsideGroup=await h.success('group.save',{name:'다른 그룹'}),outsideProject=await h.success('project.save',{groupId:outsideGroup.id,name:'다른 프로젝트'}),outside=await h.success('review.save',{projectId:outsideProject.id,title:'공유 제외'}),hidden=await addFile(h,outside.id,'hidden bytes');
 await h.success('review.save',{id:review.id,evidence:syntheticEvidence('selected log')});
 const materials=await h.success('agent.materials',{reviewId:review.id});
 assert.match(materials.instruction.markdown,/# 에이전트 작업 지시서/);assert.match(materials.instruction.markdown,/보존할 내용/);assert.equal(materials.logs.length,1);
 assert.deepEqual(materials.sharedFiles.map(item=>item.id),[shared.id]);assert.equal(materials.sharedFiles.some(item=>item.id===hidden.id),false);
});

test('agent instruction categories use display names for built-in, legacy and custom categories',async t=>{
 const h=await harness(t),{review}=await seed(h),custom=h.state.liveStore.saveReviewCategory({name:'결제 화면'});
 for(const [id,name] of [['bug','버그'],['feature','기능'],[custom.id,custom.name]]){
  await h.success('review.save',{id:review.id,category:id});
  const materials=await h.success('agent.materials',{reviewId:review.id});assert(materials.instruction.markdown.includes(`- 분류: ${name}\n`));assert.equal(materials.instruction.markdown.includes(custom.id),false);
 }
});

test('selected agent context, per-request model and staged files persist atomically and the same request cannot execute twice',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1,agentModel:'service-model',agentReasoningEffort:'low'});
 await h.success('review.save',{id:review.id,evidence:syntheticEvidence('selected log')});
 const old=await addFile(h,review.id,'selected stored file'),staged=await stageFile(h,'request.txt'),materials=await h.success('agent.materials',{reviewId:review.id});
 const payload={requestId:crypto.randomUUID(),reviewId:review.id,prompt:'선택한 자료로 수정하십시오.',newConversation:true,model:'request-model',reasoningEffort:'high',attachmentTokens:[staged.token],context:{instruction:true,screenshotId:null,attachmentIds:[old.id],logIds:[materials.logs[0].id]}};
 const original=h.state.liveStore.addAttachment;h.state.liveStore.addAttachment=()=>{throw new Error('synthetic request attachment failure')};
 assert.equal((await h.invoke('agent.start',payload)).ok,false);assert.equal(h.state.agentStarts.length,0);assert.equal(h.state.liveStore.listAgentRuns().length,0);
 assert.equal(h.state.liveStore.get('reviews',review.id).status,'open');assert.equal((await h.success('snapshot')).activities.filter(item=>item.type==='status').length,0);
 h.state.liveStore.addAttachment=original;
 const run=await h.success('agent.start',payload);assert.equal(h.state.agentStarts.length,1);assert.equal(run.model,'request-model');assert.equal(run.context.attachments.length,2);assert.equal(run.context.logs[0].console_log[0].message,'selected log');assert.match(run.context.instructionMarkdown,/작업 지시서/);
 assert.equal(h.state.liveStore.get('reviews',review.id).status,'in_progress');
 assert.deepEqual((await h.success('snapshot')).activities.filter(item=>item.type==='status').map(item=>[item.fromStatus,item.toStatus]),[['open','in_progress']]);
 const execution=h.state.agentStarts[0];assert.equal(execution.files.length,3);assert.equal(execution.files.find(item=>item.name==='request.txt').bytes.toString(),'staged attachment content');assert.match(execution.prompt,/선택한 자료로 수정/);
 const user=(await h.success('snapshot')).activities.find(item=>item.agentRunId===run.id);assert.equal((await h.success('snapshot')).attachments.filter(item=>item.activityId===user.id).length,1);
 assert.deepEqual(await h.success('agent.start',payload),run);assert.equal(h.state.agentStarts.length,1);
 assert.equal((await h.success('snapshot')).activities.filter(item=>item.type==='status').length,1);
 assert.equal((await h.invoke('agent.start',{...payload,model:'changed-model'})).ok,false);
 h.state.agentUpdate({id:run.id,kind:'agent',status:'failed',sessionId:'original-session',error:'synthetic failure',finishedAt:new Date().toISOString()});
 assert.equal((await h.success('agent.start',payload)).status,'failed');assert.equal(h.state.agentStarts.length,1);
 assert.equal((await h.success('snapshot')).services.find(item=>item.id===service.id).agentModel,'service-model');
 const persisted=h.state.liveStore.get('agent_runs',run.id);assert.equal(persisted.context.attachments.length,2);assert.equal(persisted.newConversation,true);
});

for(const invalid of ['image bytes','combined prompt'])test(`agent preflight rejects invalid ${invalid} without consuming attachments or changing review history`,async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1,agentInstructions:'실제 에이전트 지침'});
 const old=await addFile(h,review.id,'original stored file'),staged=await stageFile(h,invalid==='image bytes'?'invalid.png':'request.txt');
 const payload={requestId:crypto.randomUUID(),reviewId:review.id,prompt:invalid==='combined prompt'?'한'.repeat(90000):'첨부 자료를 읽으십시오.',context:{instruction:true,screenshotId:null,attachmentIds:[old.id],logIds:[]},attachmentTokens:[staged.token]};
 const before=await h.success('snapshot'),filesBefore=fs.readdirSync(path.join(h.dataPath,'attachments')).sort();
 const result=await h.invoke('agent.start',payload);
 assert.equal(result.ok,false);assert.equal(result.error.code,invalid==='image bytes'?'AGENT_IMAGES_INVALID':'AGENT_PROMPT_INVALID');
 assert.equal(h.state.agentValidations.length,1);assert.equal(h.state.agentStarts.length,0);
 assert.match(h.state.agentValidations[0].prompt,/작업 지시서/);assert.match(h.state.agentValidations[0].prompt,/사용자 작업 요청/);
 assert.deepEqual(await h.success('snapshot'),before);assert.deepEqual(fs.readdirSync(path.join(h.dataPath,'attachments')).sort(),filesBefore);
 assert.equal((await h.success('attachment.staged',{tokens:[staged.token]})).files[0].token,staged.token);
 assert.equal((await h.success('attachment.read',{id:old.id})).content,'original stored file');
});

test('a synchronous start failure returns the accepted failed request and its attachments exactly once',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const staged=await stageFile(h,'accepted.txt'),imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64'),imagePath=path.join(h.root,'accepted.png');fs.writeFileSync(imagePath,imageBytes);
 const [screenshot]=await h.success('attachment.stageFiles',{paths:[imagePath]}),tokens=[staged.token,screenshot.token],payload={requestId:crypto.randomUUID(),reviewId:review.id,prompt:'보관한 파일을 읽으십시오.',context:{instruction:false,screenshotId:null,screenshotToken:screenshot.token,attachmentIds:[],logIds:[]},attachmentTokens:tokens};
 h.state.agentStartError=true;
 const failed=await h.success('agent.start',payload);
 assert.equal(failed.id,payload.requestId);assert.equal(failed.status,'failed');assert.equal(failed.error,'synthetic agent start failure');assert.equal(failed.errorCode,'AGENT_START_FAILED');
 const saved=await h.success('snapshot'),user=saved.activities.find(item=>item.agentRunId===failed.id),file=saved.attachments.find(item=>item.id===failed.context.attachments.find(item=>item.name==='accepted.txt').id);
 assert.equal(saved.reviews[0].status,'in_progress');assert.equal(saved.agentRunning,0);assert.equal(user.body,payload.prompt);assert.equal(file.name,'accepted.txt');assert.equal(file.activityId,user.id);
 assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',file.storageName),'utf8'),'staged attachment content');
 const savedScreenshot=saved.attachments.find(item=>item.id===failed.context.screenshotId);assert.equal(savedScreenshot.name,'accepted.png');assert.equal(savedScreenshot.activityId,user.id);assert.deepEqual(fs.readFileSync(path.join(h.dataPath,'attachments',savedScreenshot.storageName)),imageBytes);
 assert.deepEqual((await h.success('attachment.staged',{tokens})).expiredTokens,tokens);
 assert.deepEqual(await h.success('agent.start',payload),failed);assert.equal(h.state.agentStarts.length,1);assert.deepEqual(await h.success('snapshot'),saved);
 h.state.agentStartError=false;
 const retried=await h.success('agent.start',{requestId:crypto.randomUUID(),retryOf:failed.id,reviewId:review.id,prompt:failed.prompt,newConversation:true});
 assert.equal(retried.status,'running');assert.equal(retried.retryOf,failed.id);assert.deepEqual(retried.context,failed.context);assert.equal(h.state.agentStarts.length,2);
 assert.equal(h.state.agentStarts[1].files.find(item=>item.name==='accepted.txt').bytes.toString(),'staged attachment content');assert.deepEqual(h.state.agentStarts[1].images.find(item=>item.name==='accepted.png').bytes,imageBytes);assert.equal((await h.success('snapshot')).attachments.length,2);
});

test('new agent requests set every review state to in progress without duplicate changes or replaying old transitions',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 for(const status of ['open','in_review','resolved','recheck','closed','in_progress']){
  await h.success('review.save',{id:review.id,status});
  const before=(await h.success('snapshot')).activities.filter(item=>item.type==='status').length;
  const payload={requestId:crypto.randomUUID(),reviewId:review.id,prompt:'에이전트 작업 시작',context:{instruction:false,screenshotId:null,attachmentIds:[],logIds:[]}};
  const run=await h.success('agent.start',payload),snapshot=await h.success('snapshot');
  assert.equal(snapshot.reviews[0].status,'in_progress');
  assert.equal(snapshot.activities.filter(item=>item.type==='status').length,before+(status==='in_progress'?0:1));
  h.state.agentUpdate({id:run.id,kind:'agent',status:'completed',response:'완료 응답',finishedAt:new Date().toISOString()});
  assert.equal(h.state.liveStore.get('reviews',review.id).status,'in_progress');
  await h.success('review.save',{id:review.id,status:'closed'});
  const saved=await h.success('snapshot');await h.success('agent.start',payload);
  assert.deepEqual(await h.success('snapshot'),saved);
 }
});

test('cross-group agent files and expired tokens fail before saving or starting a request',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const group=await h.success('group.save',{name:'범위 밖'}),project=await h.success('project.save',{groupId:group.id,name:'범위 밖'}),other=await h.success('review.save',{projectId:project.id,title:'범위 밖'}),file=await addFile(h,other.id);
 const base={reviewId:review.id,prompt:'검사 요청',context:{instruction:false,screenshotId:null,attachmentIds:[],logIds:[]}};
 assert.equal((await h.invoke('agent.start',{...base,context:{...base.context,attachmentIds:[file.id]}})).ok,false);
 assert.equal((await h.invoke('agent.start',{...base,attachmentTokens:['expired-token']})).ok,false);
 assert.equal(h.state.agentStarts.length,0);assert.equal(h.state.liveStore.listAgentRuns().length,0);
});

test('an explicit empty context excludes unselected review instructions, screenshots, files and logs',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 await h.success('review.save',{id:review.id,body:'PRIVATE_REVIEW_INSTRUCTION',evidence:syntheticEvidence('PRIVATE_LOG')});await addFile(h,review.id,'PRIVATE_FILE');
 const image=path.join(h.root,'excluded.png');fs.writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64'));
 const staged=await h.success('attachment.stageFiles',{paths:[image]});await h.success('activity.add',{reviewId:review.id,attachmentTokens:[staged[0].token]});
 const run=await h.success('agent.start',{requestId:crypto.randomUUID(),reviewId:review.id,prompt:'현재 요청만 수행하십시오.',context:{instruction:false,screenshotId:null,attachmentIds:[],logIds:[]}});
 const execution=h.state.agentStarts[0];assert.equal(execution.images.length,0);assert.equal(execution.files.length,0);assert.equal(execution.prompt.includes('PRIVATE_REVIEW_INSTRUCTION'),false);assert.equal(execution.prompt.includes('PRIVATE_LOG'),false);assert.equal(execution.prompt.includes('PRIVATE_FILE'),false);assert.equal(run.context.instructionMarkdown,'');
});

test('review materials are automatic only before the first accepted request, including new conversations',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 await h.success('review.save',{id:review.id,body:'FIRST_REQUEST_INSTRUCTION',evidence:syntheticEvidence('FIRST_REQUEST_LOG')});
 await addFile(h,review.id,'FIRST_REQUEST_FILE');
 const image=path.join(h.root,'first-request.png');fs.writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64'));
 const staged=await h.success('attachment.stageFiles',{paths:[image]});await h.success('activity.add',{reviewId:review.id,attachmentTokens:[staged[0].token]});
 assert.equal((await h.success('agent.materials',{reviewId:review.id})).hasRequests,false);
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'First request',requestId:crypto.randomUUID()});
 assert.equal(first.context.instruction,true);assert.equal(first.context.logs.length,1);assert.equal(h.state.agentStarts[0].images.length,1);assert.equal(h.state.agentStarts[0].files.length,2);
 const saved=await h.success('agent.materials',{reviewId:review.id});assert.equal(saved.hasRequests,true);assert.deepEqual(saved.requestIds,[first.id]);assert.deepEqual(saved.lastRequestContext.attachmentIds,first.context.attachmentIds);
 h.state.agentUpdate({id:first.id,status:'completed',kind:'agent',sessionId:'first-session',response:'Done',finishedAt:new Date().toISOString()});
 for(const newConversation of [false,true]){
  const next=await h.success('agent.start',{reviewId:review.id,prompt:'Text only',requestId:crypto.randomUUID(),newConversation}),execution=h.state.agentStarts.at(-1);
  assert.equal(next.context.instruction,false);assert.equal(next.context.screenshotId,null);assert.deepEqual(next.context.attachmentIds,[]);assert.deepEqual(next.context.logIds,[]);assert.equal(execution.images.length,0);assert.equal(execution.files.length,0);assert.equal(execution.prompt,'Text only');assert.equal(execution.sessionId,newConversation?'':'first-session');
  h.state.agentUpdate({id:next.id,status:'completed',kind:'agent',sessionId:'first-session',response:'Done',finishedAt:new Date().toISOString()});
 }
});

test('rejected requests keep first-request materials while accepted failures retain the original retry snapshot',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 await h.success('review.save',{id:review.id,body:'RETRY_ORIGINAL_INSTRUCTION',evidence:syntheticEvidence('RETRY_ORIGINAL_LOG')});const file=await addFile(h,review.id,'RETRY_ORIGINAL_FILE');
 const original=h.state.liveStore.addActivity;h.state.liveStore.addActivity=()=>{throw new Error('synthetic request save failure')};
 assert.equal((await h.invoke('agent.start',{reviewId:review.id,prompt:'Rejected before acceptance',requestId:crypto.randomUUID()})).ok,false);
 h.state.liveStore.addActivity=original;assert.equal((await h.success('agent.materials',{reviewId:review.id})).hasRequests,false);assert.equal(h.state.agentStarts.length,0);
 h.state.agentStartError=true;
 const failed=await h.success('agent.start',{reviewId:review.id,prompt:'Accepted request',requestId:crypto.randomUUID()});
 assert.equal(failed.status,'failed');assert.equal(failed.context.instruction,true);assert.equal((await h.success('agent.materials',{reviewId:review.id})).hasRequests,true);
 await h.success('review.save',{id:review.id,body:'RETRY_UPDATED_INSTRUCTION',evidence:syntheticEvidence('RETRY_UPDATED_LOG')});h.state.agentStartError=false;
 const retry=await h.success('agent.start',{reviewId:review.id,prompt:failed.prompt,requestId:crypto.randomUUID(),retryOf:failed.id,newConversation:true});assert.deepEqual(retry.context,failed.context);assert.match(h.state.agentStarts.at(-1).prompt,/RETRY_ORIGINAL_INSTRUCTION/);assert.equal(h.state.agentStarts.at(-1).prompt.includes('RETRY_UPDATED_INSTRUCTION'),false);
 h.state.agentUpdate({id:retry.id,status:'completed',kind:'agent',response:'Done',finishedAt:new Date().toISOString()});
 const manual=await h.success('agent.start',{reviewId:review.id,prompt:'Explicit new attachment',requestId:crypto.randomUUID(),newConversation:true,context:{instruction:false,attachmentIds:[file.id],logIds:[]}});
 assert.deepEqual(manual.context.attachmentIds,[file.id]);assert.equal(manual.context.instruction,false);assert.deepEqual(manual.context.logIds,[]);assert.equal(h.state.agentStarts.at(-1).files[0].bytes.toString(),'RETRY_ORIGINAL_FILE');assert.equal(h.state.agentStarts.at(-1).prompt,'Explicit new attachment');
});

test('follow-up material requests and retries include only explicit materials without automatic review history',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 await h.success('review.save',{id:review.id,body:'DO_NOT_REPEAT_REVIEW_BODY',evidence:syntheticEvidence('EXPLICIT_LOG')});const file=await addFile(h,review.id,'EXPLICIT_FILE');
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'Original user request',context:{instruction:false}});
 h.state.agentUpdate({id:first.id,status:'completed',kind:'agent',response:'DO_NOT_REPEAT_HISTORY',sessionId:'material-session',finishedAt:new Date().toISOString()});
 const materials=await h.success('agent.materials',{reviewId:review.id}),next=await h.success('agent.start',{reviewId:review.id,prompt:'Read selected materials',context:{instruction:false,attachmentIds:[file.id],logIds:[materials.logs[0].id]}}),execution=h.state.agentStarts.at(-1);
 assert.equal(next.context.initialRequest,false);assert.equal(execution.prompt,`선택한 로그:\n${JSON.stringify(next.context.logs)}\n\n사용자 작업 요청:\nRead selected materials`);assert.equal(execution.files.length,2);
 for(const marker of ['DO_NOT_REPEAT_REVIEW_BODY','DO_NOT_REPEAT_HISTORY','리뷰:','이전 대화:'])assert.equal(execution.prompt.includes(marker),false);
 h.state.agentUpdate({id:next.id,status:'failed',kind:'agent',error:'synthetic failure',finishedAt:new Date().toISOString()});
 await h.success('review.save',{id:review.id,evidence:syntheticEvidence('CHANGED_LOG')});
 const retried=await h.success('agent.start',{reviewId:review.id,prompt:next.prompt,retryOf:next.id});assert.deepEqual(retried.context,next.context);assert.equal(h.state.agentStarts.at(-1).prompt,execution.prompt);assert.equal(h.state.agentStarts.at(-1).files[0].bytes.toString(),'EXPLICIT_FILE');
});

test('a retry uses the original material snapshot after the review changes and preserves the old run context',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 await h.success('review.save',{id:review.id,body:'ORIGINAL_INSTRUCTION',evidence:syntheticEvidence('ORIGINAL_LOG')});
 const materials=await h.success('agent.materials',{reviewId:review.id}),first=await h.success('agent.start',{requestId:crypto.randomUUID(),reviewId:review.id,prompt:'원본 요청',model:'original-model',reasoningEffort:'high',newConversation:true,context:{instruction:true,screenshotId:null,attachmentIds:[],logIds:[materials.logs[0].id]}});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'failed',sessionId:'original-session',error:'synthetic failure',finishedAt:new Date().toISOString()});
 await h.success('review.save',{id:review.id,body:'UPDATED_INSTRUCTION',evidence:syntheticEvidence('UPDATED_LOG')});
 h.state.liveStore.saveAgentRun({id:first.id,context:{instruction:false}});
 const retained=await h.success('agent.read',{id:first.id});assert.deepEqual(retained.context,first.context);
 const second=await h.success('agent.start',{requestId:crypto.randomUUID(),retryOf:first.id,reviewId:review.id,prompt:first.prompt});
 assert.deepEqual(second.context,first.context);assert.equal(second.model,'original-model');assert.equal(second.reasoningEffort,'high');assert.equal(second.newConversation,false);assert.equal(second.sessionId,'original-session');assert.equal(second.retryOf,first.id);
 const executed=h.state.agentStarts[1];assert.match(executed.prompt,/ORIGINAL_INSTRUCTION/);assert.equal(executed.prompt.includes('UPDATED_INSTRUCTION'),false);assert.equal(executed.files[0].bytes.toString().includes('UPDATED_LOG'),false);
});

test('activity attachment edits commit together, preserve old data on failure and discard removed bytes after success',async t=>{
 const h=await harness(t),{review}=await seed(h),initial=await stageFile(h,'initial.txt');
 const activity=await h.success('activity.add',{reviewId:review.id,body:'원래 내용',attachmentTokens:[initial.token]});
 const before=await h.success('snapshot'),old=before.attachments.find(file=>file.activityId===activity.id),replacement=await stageFile(h,'replacement.txt');
 const input={id:activity.id,body:'',attachmentTokens:[replacement.token],removeAttachmentIds:[old.id]},original=h.state.liveStore.addAttachment;
 h.state.liveStore.addAttachment=()=>{throw new Error('synthetic edited attachment failure')};
 assert.equal((await h.invoke('activity.update',input)).ok,false);h.state.liveStore.addAttachment=original;
 assert.deepEqual(await h.success('snapshot'),before);assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',old.storageName),'utf8'),'staged attachment content');
 assert.equal((await h.success('attachment.staged',{tokens:[replacement.token]})).files.length,1);
 const updated=await h.success('activity.update',input),after=await h.success('snapshot');
 assert.equal(updated.id,activity.id);assert.equal(updated.createdAt,activity.createdAt);assert.equal(updated.body,'');
 const added=after.attachments.find(file=>file.activityId===activity.id);assert.notEqual(added.id,old.id);assert.equal(added.name,'replacement.txt');
 assert.equal(fs.existsSync(path.join(h.dataPath,'attachments',old.storageName)),false);
 assert.equal((await h.invoke('activity.update',{id:activity.id,body:'',removeAttachmentIds:[added.id]})).ok,false);
 const other=await h.success('activity.add',{reviewId:review.id,body:'다른 작업'});
 assert.equal((await h.invoke('activity.update',{id:other.id,body:'수정하면 안 되는 내용',removeAttachmentIds:[added.id]})).ok,false);
 assert.equal((await h.success('snapshot')).activities.find(item=>item.id===other.id).body,'다른 작업');
});

test('instruction ZIP includes stored review materials and honours cancellation and managed-data guards',async t=>{
 const h=await harness(t),{review}=await seed(h);await h.success('review.save',{id:review.id,evidence:syntheticEvidence('ZIP_LOG')});
 const stored=await addFile(h,review.id,'ZIP_FILE'),stage=await stageFile(h,'history.txt');
 await h.success('activity.add',{reviewId:review.id,body:'ZIP_HISTORY',attachmentTokens:[stage.token]});
 assert.deepEqual(await h.success('agent.instructionExport',{reviewId:review.id}),{cancelled:true});
 h.state.saveResult={canceled:false,filePath:path.join(h.dataPath,'overwrite.zip')};
 assert.equal((await h.invoke('agent.instructionExport',{reviewId:review.id})).ok,false);
 const destination=path.join(h.root,'instruction.zip');h.state.saveResult={canceled:false,filePath:destination};
 const result=await h.success('agent.instructionExport',{reviewId:review.id});assert.equal(result.saved,true);assert.equal(result.size,fs.statSync(destination).size);
 const {execFileSync}=require('node:child_process'),listing=execFileSync('/usr/bin/unzip',['-Z1',destination],{encoding:'utf8'}).trim().split('\n');
 for(const entry of ['README.md','request.md','review.json','logs/current.json','activities/history.md'])assert.ok(listing.includes(entry),entry);
 assert.match(execFileSync('/usr/bin/unzip',['-p',destination,'request.md'],{encoding:'utf8'}),/보존할 내용/);
 const file=listing.find(name=>name.startsWith('attachments/'+stored.id+'_'));assert.ok(file);
 assert.equal(execFileSync('/usr/bin/unzip',['-p',destination,file],{encoding:'utf8'}),'ZIP_FILE');
 assert.match(execFileSync('/usr/bin/unzip',['-p',destination,'activities/history.md'],{encoding:'utf8'}),/ZIP_HISTORY/);
 assert.equal(fs.readFileSync(destination).includes(Buffer.from('synthetic-old-password')),false);
});

test('agent work files stay inside the work folder, export binary bytes and isolate HTML previews',async t=>{
 const h=await harness(t),{service,review}=await seed(h),work=path.join(h.root,'work');fs.mkdirSync(work);
 const bytes=Buffer.from([0,255,10,32,0,65]);fs.writeFileSync(path.join(work,'result.bin'),bytes);fs.writeFileSync(path.join(work,'result.html'),'<script>document.body.textContent="fixture"</script>');
 const outside=path.join(h.root,'private.txt');fs.writeFileSync(outside,'outside');fs.symlinkSync(outside,path.join(work,'outside-link'));
 await h.success('service.save',{id:service.id,kind:'local',rootPath:h.root,agentWorkPath:work});
 for(const file of ['../private.txt',outside,'outside-link'])assert.equal((await h.invoke('agent.fileRead',{reviewId:review.id,path:file})).ok,false);
 const preview=await h.success('agent.fileRead',{reviewId:review.id,path:path.join(work,'result.html')});assert.match(preview.previewUrl,/^reviewops:\/\/preview\//);assert.equal(Object.hasOwn(preview,'bytes'),false);
 const response=h.state.protocol({url:preview.previewUrl,method:'GET'});assert.equal(response.status,200);assert.match(response.headers.get('Content-Security-Policy'),/sandbox allow-scripts/);
 assert.equal((await h.invoke('snapshot',{}, {...h.event(),senderFrame:{url:preview.previewUrl}})).ok,false);
 const binary=await h.success('agent.fileRead',{reviewId:review.id,path:'result.bin'});assert.equal(binary.size,bytes.length);assert.equal(Object.hasOwn(binary,'bytes'),false);
 assert.deepEqual(await h.success('agent.fileExport',{reviewId:review.id,path:'result.bin'}),{cancelled:true});
 const exported=path.join(h.root,'saved.bin');h.state.saveResult={canceled:false,filePath:exported};
 assert.equal((await h.success('agent.fileExport',{reviewId:review.id,path:'result.bin'})).saved,true);assert.deepEqual(fs.readFileSync(exported),bytes);
 h.state.saveResult={canceled:false,filePath:path.join(h.dataPath,'bad.bin')};assert.equal((await h.invoke('agent.fileExport',{reviewId:review.id,path:'result.bin'})).ok,false);
});

test('agent file links use their original run folder after settings change and reject another review run',async t=>{
 const h=await harness(t),{service,project,review}=await seed(h),work=path.join(h.root,'old-work'),nextWork=path.join(h.root,'new-work');
 fs.mkdirSync(path.join(work,'docs'),{recursive:true});fs.mkdirSync(nextWork);
 fs.writeFileSync(path.join(work,'docs/development-log.md'),'SAVED_RUN_FILE');fs.writeFileSync(path.join(work,'docs/next.md'),'NESTED_RUN_FILE');
 await h.success('service.save',{id:service.id,kind:'local',rootPath:nextWork,agentWorkPath:nextWork});
 const run=h.state.liveStore.saveAgentRun({reviewId:review.id,serviceId:service.id,workPath:work,status:'completed',response:'[배포 재시도 기록]('+path.join(work,'docs/development-log.md')+':8305)'});
 const file=await h.success('agent.fileRead',{reviewId:review.id,runId:run.id,path:path.join(work,'docs/development-log.md')+':8305'});
 assert.equal(file.content,'SAVED_RUN_FILE');assert.equal(file.absolutePath,fs.realpathSync(path.join(work,'docs/development-log.md')));
 assert.equal((await h.success('agent.fileRead',{reviewId:review.id,runId:run.id,path:'./next.md#L2',basePath:file.absolutePath})).content,'NESTED_RUN_FILE');
 const other=await h.success('review.save',{projectId:project.id,serviceId:service.id,title:'다른 리뷰'});
 assert.equal((await h.invoke('agent.fileRead',{reviewId:other.id,runId:run.id,path:'docs/next.md'})).ok,false);
});

test('credentials use the internal key and ignore unused legacy fields for the chosen authentication method',async t=>{
 const h=await harness(t),{service,review}=await seed(h);
 if(process.platform==='darwin')assert.ok(h.state.switches.some(([name])=>name==='use-mock-keychain'));
 const values=JSON.parse(h.state.realVault.checkpoint());assert.match(values[service.id].password,/^reviewops-aes256gcm-v1:/);
 assert.equal(fs.readFileSync(path.join(h.dataPath,'credentials.json'),'utf8').includes('synthetic-old-password'),false);
 assert.equal(fs.statSync(path.join(h.dataPath,'credentials.json.key')).mode&0o777,0o600);
 values[service.id].passphrase='OLD_KEYCHAIN_CIPHERTEXT';h.state.realVault.restore(JSON.stringify(values));
 await h.success('service.save',{id:service.id,agentEnabled:1});
 await h.success('agent.start',{reviewId:review.id,prompt:'인증 방식 검사',context:{instruction:false,attachmentIds:[],logIds:[]}});
 assert.equal(h.state.agentStarts[0].config.password,'synthetic-old-password');assert.equal(h.state.agentStarts[0].config.passphrase,undefined);
});

test('independent execution retains its own option and resumes separately from the fresh-conversation option',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1,agentModel:'fixture-model'});
 const base={reviewId:review.id,prompt:'옵션 검사',context:{instruction:false,attachmentIds:[],logIds:[]}};
 const first=await h.success('agent.start',{...base,requestId:crypto.randomUUID()});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'completed',sessionId:'stored-session',response:'응답',finishedAt:new Date().toISOString()});
 const second=await h.success('agent.start',{...base,requestId:crypto.randomUUID(),independentExecution:true,newConversation:false});
 assert.equal(second.independentExecution,true);assert.equal(second.newConversation,false);assert.equal(h.state.agentStarts[1].sessionId,'stored-session');
 h.state.agentUpdate({id:second.id,kind:'agent',status:'completed',sessionId:'stored-session',response:'응답2',finishedAt:new Date().toISOString()});
 const checked=await h.success('agent.session',{reviewId:review.id});assert.equal(checked.available,true);assert.equal(h.state.sessionCheck.sessionId,'stored-session');
 const third=await h.success('agent.start',{...base,requestId:crypto.randomUUID(),independentExecution:false,newConversation:true});
 assert.equal(third.independentExecution,false);assert.equal(third.newConversation,true);assert.equal(h.state.agentStarts[2].sessionId,'');
 h.state.agentUpdate({id:third.id,kind:'agent',status:'completed',sessionId:'fresh-session',response:'응답3',finishedAt:new Date().toISOString()});
 const transfer=await h.success('agent.transfer',{runId:third.id});assert.equal(transfer.alreadySaved,true);assert.deepEqual(await h.success('agent.transfer',{runId:third.id}),transfer);
 await h.success('service.save',{id:service.id,agentWorkPath:'/tmp/another-fixture-work'});assert.equal((await h.success('agent.session',{reviewId:review.id})).status,'work_path_changed');
});

test('project-owned local connections create usable reviews without registering or selecting a service',async t=>{
 const h=await harness(t),group=await h.success('group.save',{name:'직접 연결'});
 const project=await h.success('project.save',{groupId:group.id,name:'로컬 프로젝트',connection:{kind:'local',rootPath:h.root,viewerUrl:'https://example.test',agentEnabled:1,agentWorkPath:h.root}});
 assert.equal(project.connection.kind,'local');assert.equal(project.connection.managedProjectId,project.id);assert.equal(project.connection.rootPath,h.root);assert.equal(project.connectionClonedFrom,undefined);
 const review=await h.success('review.save',{projectId:project.id,title:'프로젝트 연결 리뷰'});assert.equal(review.serviceId,project.connection.id);
 const snapshot=await h.success('snapshot');assert.equal(snapshot.projects[0].connection.id,project.connection.id);assert.equal(snapshot.projects[0].connection.hasPassword,false);
 await h.success('project.delete',{id:project.id});assert.equal((await h.success('snapshot')).services.length,0);
});

test('project SSH selection resolves a saved host and rejects missing aliases before changing data',async t=>{
 const h=await harness(t),group=await h.success('group.save',{name:'호스트 선택'});
 h.state.codexHost={alias:'test-host',hostName:'127.0.0.1',user:'synthetic',port:2222,configPath:'/tmp/synthetic-ssh/config'};
 const project=await h.success('project.save',{groupId:group.id,name:'SSH 프로젝트',connection:{kind:'ssh',hostAlias:'test-host',rootPath:'/work',host:'ignored.invalid',username:'ignored',sshConfigPath:'/ignored/config'}});
 assert.equal(project.connection.host,'127.0.0.1');assert.equal(project.connection.username,'synthetic');assert.equal(project.connection.port,2222);assert.equal(project.connection.hostAlias,'test-host');assert.equal(project.connection.sshConfigPath,'/tmp/synthetic-ssh/config');assert.equal(project.connection.authType,'agent');
 const before=await h.success('snapshot');const invalid=await h.invoke('project.save',{id:project.id,connection:{...project.connection,hostAlias:'missing-host'}});assert.equal(invalid.ok,false);assert.deepEqual(await h.success('snapshot'),before);
 const missing=await h.invoke('project.save',{groupId:group.id,name:'실패',connection:{kind:'ssh',hostAlias:'',rootPath:'/work'}});assert.equal(missing.ok,false);assert.deepEqual(await h.success('snapshot'),before);
});

test('moving legacy credentials into project settings preserves ciphertext and rolls back a failed commit',async t=>{
 const h=await harness(t),{project,service,review}=await seed(h),original=JSON.parse(h.state.realVault.checkpoint())[service.id];
 h.state.failures.commit='after';const before=await h.success('snapshot');
 const failed=await h.invoke('project.save',{id:project.id,connection:{...service,memo:'프로젝트 설정'}});assert.equal(failed.ok,false);assert.deepEqual(await h.success('snapshot'),before);assert.deepEqual(JSON.parse(h.state.realVault.checkpoint()),{[service.id]:original});
 delete h.state.failures.commit;const changed=await h.success('project.save',{id:project.id,connection:{...service,memo:'프로젝트 설정'}});assert.notEqual(changed.connection.id,service.id);
 assert.deepEqual(JSON.parse(h.state.realVault.checkpoint())[changed.connection.id],original);assert.equal(h.state.realVault.get(changed.connection.id).password,'synthetic-old-password');assert.equal((await h.success('snapshot')).reviews.find(item=>item.id===review.id).serviceId,changed.connection.id);
 await h.success('project.delete',{id:project.id});assert.deepEqual(h.state.realVault.get(changed.connection.id),{});assert.equal(h.state.realVault.get(service.id).password,'synthetic-old-password');
});

test('Codex manager uses the app data folder and the existing trusted-frame boundary',async t=>{
 const h=await harness(t);assert.equal(h.state.codexRegistered,true);assert.equal(h.state.codexOptions.dataPath,h.dataPath);
 assert.throws(()=>h.state.codexOptions.trusted({sender:{},senderFrame:{url:'https://external.invalid'}}),/허용되지/);
 h.state.codexOptions.trusted({sender:h.state.window.webContents,senderFrame:h.state.window.webContents.mainFrame});
});

test('project edits preserve an approved SSH pin and cannot replace it from a stale form',async t=>{
 const h=await harness(t),{project,service}=await seed(h),fingerprint='SHA256:'+Buffer.alloc(32,7).toString('base64').replace(/=+$/,'');
 h.state.trustFingerprint=fingerprint;
 assert.equal((await h.invoke('ssh.test',{serviceId:service.id})).error.code,'SSH_TRUST_REQUIRED');
 await h.success('ssh.trust',{serviceId:service.id,fingerprint});
 const changed=await h.success('project.save',{id:project.id,connection:{...service,memo:'승인 후 설정 저장'}});
 assert.equal(changed.connection.hostFingerprint,fingerprint);
 const injected='SHA256:'+Buffer.alloc(32,9).toString('base64').replace(/=+$/,'');
 const saved=await h.success('project.save',{id:project.id,connection:{...changed.connection,hostFingerprint:injected,memo:'다른 설정'}});
 assert.equal(saved.connection.hostFingerprint,fingerprint);
 const moved=await h.success('project.save',{id:project.id,connection:{...saved.connection,port:2222,hostFingerprint:fingerprint}});
 assert.equal(moved.connection.hostFingerprint,'');
});

test('project setting migration preserves legacy Codex sessions when only the viewer changes',async t=>{
 const h=await harness(t),{project,service,review}=await seed(h);
 await h.success('service.save',{id:service.id,agentEnabled:1});
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'기존 대화',requestId:crypto.randomUUID()});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'completed',sessionId:'legacy-project-session',response:'기존 응답',finishedAt:new Date().toISOString()});
 const oldScope=crypto.createHash('sha256').update(JSON.stringify([service.id,service.kind,service.host,service.port,service.username,first.workPath,first.model])).digest('hex');
 h.state.liveStore.saveAgentRun({id:first.id,sessionScope:oldScope});
 const retained=await h.success('agent.read',{id:first.id});
 const changed=await h.success('project.save',{id:project.id,connection:{...h.state.liveStore.get('services',service.id),viewerWidth:1920}});
 assert.notEqual(changed.connection.id,service.id);
 const session=await h.success('agent.session',{reviewId:review.id});
 assert.equal(session.available,true);assert.equal(h.state.sessionCheck.sessionId,'legacy-project-session');
 const next=await h.success('agent.start',{reviewId:review.id,prompt:'계속 진행',requestId:crypto.randomUUID()});
 assert.equal(h.state.agentStarts.at(-1).sessionId,'legacy-project-session');assert.match(next.sessionScope,/^target-v2:/);
 assert.equal(next.serviceId,changed.connection.id);assert.deepEqual(await h.success('agent.read',{id:first.id}),retained);
});

test('project configuration versions keep current Codex sessions across display and reasoning edits',async t=>{
 const h=await harness(t),{project,service,review}=await seed(h);
 const initial=await h.success('project.save',{id:project.id,connection:{...service,agentEnabled:1}});
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'설정 변경 전',requestId:crypto.randomUUID()});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'completed',sessionId:'project-version-session',response:'보존할 응답',finishedAt:new Date().toISOString()});
 const changed=await h.success('project.save',{id:project.id,connection:{...initial.connection,viewerUrl:'https://other-viewer.invalid',agentReasoningEffort:'high'}});
 assert.notEqual(changed.connection.id,initial.connection.id);
 assert.equal((await h.success('agent.session',{reviewId:review.id})).available,true);
 await h.success('agent.start',{reviewId:review.id,prompt:'설정 변경 후',requestId:crypto.randomUUID()});
 assert.equal(h.state.agentStarts.at(-1).sessionId,'project-version-session');
});

test('a retry crosses a project configuration copy while keeping its original materials and review restriction',async t=>{
 const h=await harness(t),{project,service,review}=await seed(h);
 await h.success('service.save',{id:service.id,agentEnabled:1});
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'재실행할 요청',newConversation:true,requestId:crypto.randomUUID(),context:{instruction:true,attachmentIds:[],logIds:[]}});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'failed',sessionId:'configuration-session',error:'합성 실패',finishedAt:new Date().toISOString()});
 const oldScope=crypto.createHash('sha256').update(JSON.stringify([service.id,service.kind,service.host,service.port,service.username,first.workPath,first.model])).digest('hex');
 h.state.liveStore.saveAgentRun({id:first.id,sessionScope:oldScope});
 const changed=await h.success('project.save',{id:project.id,connection:{...h.state.liveStore.get('services',service.id),viewerHeight:1080}});
 const other=await h.success('review.save',{projectId:project.id,title:'다른 리뷰'}),before=await h.success('snapshot');
 const rejected=await h.invoke('agent.start',{reviewId:other.id,retryOf:first.id,prompt:first.prompt,requestId:crypto.randomUUID()});
 assert.equal(rejected.ok,false);assert.match(rejected.error.message,/같은 리뷰/);assert.deepEqual(await h.success('snapshot'),before);
 const retried=await h.success('agent.start',{reviewId:review.id,retryOf:first.id,prompt:first.prompt,requestId:crypto.randomUUID()});
 assert.equal(retried.serviceId,changed.connection.id);assert.equal(retried.retryOf,first.id);assert.deepEqual(retried.context,first.context);
});

for(const [label,change] of [
 ['host',{host:'another.example.test'}],['port',{port:2222}],['user',{username:'another-user'}],
 ['root folder',{rootPath:'/tmp/another-project'}],['agent folder',{agentWorkPath:'/tmp/another-agent'}],
 ['binary',{agentBinary:'another-codex'}]
])test(`changing the project ${label} starts a fresh session and rejects retries against the previous execution target`,async t=>{
 const h=await harness(t),{project,service,review}=await seed(h);
 await h.success('service.save',{id:service.id,agentEnabled:1});
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'변경 전 요청',requestId:crypto.randomUUID()});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'completed',sessionId:'previous-target-session',response:'변경 전 응답',finishedAt:new Date().toISOString()});
 await h.success('project.save',{id:project.id,connection:{...h.state.liveStore.get('services',service.id),...change}});
 assert.equal((await h.success('agent.session',{reviewId:review.id})).available,false);
 const next=await h.success('agent.start',{reviewId:review.id,prompt:'변경 후 요청',requestId:crypto.randomUUID()});
 assert.equal(h.state.agentStarts.at(-1).sessionId,'');
 h.state.agentUpdate({id:next.id,kind:'agent',status:'failed',error:'합성 중지',finishedAt:new Date().toISOString()});
 const before=await h.success('snapshot');
 const retry=await h.invoke('agent.start',{reviewId:review.id,retryOf:first.id,prompt:first.prompt,requestId:crypto.randomUUID(),...(label==='model'?{model:change.agentModel}:{})});
 assert.equal(retry.ok,false);assert.match(retry.error.message,/새 요청/);assert.deepEqual(await h.success('snapshot'),before);
});

test('changing an existing connection executable does not reuse a session recorded for the previous binary',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'이전 실행 파일',requestId:crypto.randomUUID()});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'completed',sessionId:'old-binary-session',response:'기존 응답',finishedAt:new Date().toISOString()});
 await h.success('service.save',{id:service.id,agentBinary:'new-codex'});
 assert.equal((await h.success('agent.session',{reviewId:review.id})).available,false);
 await h.success('agent.start',{reviewId:review.id,prompt:'새 실행 파일',requestId:crypto.randomUUID()});
 assert.equal(h.state.agentStarts.at(-1).sessionId,'');
});

test('runtime preflight rejection preserves the draft attachment and all review records',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const staged=await stageFile(h,'preserved.txt'),before=await h.success('snapshot');
 const payload={requestId:'preflight-denied',reviewId:review.id,prompt:'Keep the request',context:{instruction:false,attachmentIds:[],logIds:[]},attachmentTokens:[staged.token]};
 for(const code of ['AGENT_WORK_PATH_MISSING','AGENT_NOT_INSTALLED','AGENT_AUTH_REQUIRED']){
  h.state.preflightError=Object.assign(new Error('Choose a folder, executable, or login'),{code});
  const result=await h.invoke('agent.start',payload);assert.equal(result.ok,false);assert.equal(result.error.code,code);
  assert.equal(h.state.agentStarts.length,0);assert.deepEqual(await h.success('snapshot'),before);
  assert.equal((await h.success('attachment.staged',{tokens:[staged.token]})).files[0].token,staged.token);
 }
 h.state.preflightError=null;const run=await h.success('agent.start',payload);assert.equal(run.id,payload.requestId);assert.equal(h.state.agentStarts.length,1);
});

test('a settings change during runtime preflight rejects execution without consuming staged files',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const staged=await stageFile(h,'before-settings-change.txt');let release;h.state.preflightGate=new Promise(done=>{release=done});t.after(()=>release());
 const pending=h.invoke('agent.start',{requestId:'preflight-change',reviewId:review.id,prompt:'Keep this request',context:{instruction:false,attachmentIds:[],logIds:[]},attachmentTokens:[staged.token]});
 for(let attempt=0;attempt<100&&!h.state.agentPreflights.length;attempt++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.state.agentPreflights.length,1);
 h.state.liveStore.saveService({id:service.id,rootPath:path.join(h.root,'different-folder')});release();
 const result=await pending;assert.equal(result.ok,false);assert.match(result.error.message,/검사 중 프로젝트 설정이 변경/);
 assert.equal(h.state.agentStarts.length,0);assert.deepEqual(h.state.liveStore.listAgentRuns(),[]);
 assert.equal((await h.success('attachment.staged',{tokens:[staged.token]})).files[0].token,staged.token);
});

for(const relation of ['same','child','symlink'])test(`normal requests on another service cannot edit an active ${relation} workspace`,async t=>{
 const h=await harness(t),group=await h.success('group.save',{name:'Workspace overlap'}),folder=path.join(h.root,'work');fs.mkdirSync(folder);
 let other=relation==='child'?path.join(folder,'child'):relation==='symlink'?path.join(h.root,'linked-work'):folder;
 if(relation==='child')fs.mkdirSync(other);if(relation==='symlink')fs.symlinkSync(folder,other,'dir');
 const firstProject=await h.success('project.save',{groupId:group.id,name:'First',connection:{kind:'local',rootPath:folder,agentBinary:'/fixture/first-codex',agentEnabled:1}});
 const secondProject=await h.success('project.save',{groupId:group.id,name:'Second',connection:{kind:'local',rootPath:other,agentBinary:'/fixture/second-codex',agentEnabled:1}});
 const firstReview=await h.success('review.save',{projectId:firstProject.id,title:'First'}),secondReview=await h.success('review.save',{projectId:secondProject.id,title:'Second'});
 await h.success('agent.start',{requestId:'active-workspace',reviewId:firstReview.id,prompt:'First request',context:{instruction:false,attachmentIds:[],logIds:[]}});
 const staged=await stageFile(h,'waiting-for-workspace.txt'),before=await h.success('snapshot'),payload={requestId:'conflicting-workspace',reviewId:secondReview.id,prompt:'Second request',context:{instruction:false,attachmentIds:[],logIds:[]},attachmentTokens:[staged.token]};
 const refused=await h.invoke('agent.start',payload);assert.equal(refused.ok,false);assert.match(refused.error.message,/같은 작업 폴더 또는 그 안의 폴더/);
 assert.equal(h.state.agentStarts.length,1);assert.deepEqual(await h.success('snapshot'),before);assert.equal((await h.success('attachment.staged',{tokens:[staged.token]})).files.length,1);
 const explicit=await h.success('agent.start',{...payload,independentExecution:true});assert.equal(explicit.independentExecution,true);assert.equal(h.state.agentStarts.length,2);
});

test('a copied draft cannot run against settings changed after the comparison was accepted',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const source=await h.success('agent.start',{requestId:'copied-source',reviewId:review.id,prompt:'Original failed request',context:{instruction:false,attachmentIds:[],logIds:[]}});
 h.state.agentUpdate({id:source.id,kind:'agent',status:'failed',error:'fixture failure',finishedAt:new Date().toISOString()});
 const original=await h.success('agent.read',{id:source.id}),copied=await h.success('agent.copyDraft',{reviewId:review.id,runId:source.id});
 assert.ok(copied.draft.sourceTarget);
 const staged=await stageFile(h,'kept-after-target-change.txt');
 await h.success('service.save',{id:service.id,rootPath:'/tmp/changed-after-copy'});const before=await h.success('snapshot');
 const refused=await h.invoke('agent.start',{requestId:'copied-new-target',reviewId:review.id,prompt:copied.draft.prompt,newConversation:true,sourceRunId:copied.draft.sourceRunId,sourceTarget:copied.draft.sourceTarget,context:{instruction:false,attachmentIds:[],logIds:[]},attachmentTokens:[staged.token]});
 assert.equal(refused.ok,false);assert.match(refused.error.message,/설정|대상/);assert.equal(h.state.agentStarts.length,1);
 assert.deepEqual(await h.success('snapshot'),before);assert.deepEqual(await h.success('agent.read',{id:source.id}),original);assert.equal((await h.success('attachment.staged',{tokens:[staged.token]})).files.length,1);
});

test('a project connection replacement during preflight cannot execute the retained old service',async t=>{
 const h=await harness(t),{service,review,project}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const beforeService=h.state.liveStore.get('services',service.id),staged=await stageFile(h,'keep-after-connection-copy.txt');let release;h.state.preflightGate=new Promise(done=>{release=done});t.after(()=>release());
 const pending=h.invoke('agent.start',{requestId:'preflight-connection-copy',reviewId:review.id,prompt:'Preserve this request',context:{instruction:false,attachmentIds:[],logIds:[]},attachmentTokens:[staged.token]});
 for(let attempt=0;attempt<100&&!h.state.agentPreflights.length;attempt++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.state.agentPreflights.length,1);
 const changed=h.state.liveStore.saveProjectConnection(project.id,{...beforeService,rootPath:'/tmp/new-owned-connection'});
 assert.notEqual(changed.connection.id,service.id);assert.deepEqual(h.state.liveStore.get('services',service.id),beforeService);release();
 const result=await pending;assert.equal(result.ok,false);assert.match(result.error.message,/검사 중 프로젝트 설정이 변경/);assert.equal(h.state.agentStarts.length,0);assert.deepEqual(h.state.liveStore.listAgentRuns(),[]);
 assert.equal((await h.success('attachment.staged',{tokens:[staged.token]})).files.length,1);
});

for(const damage of ['missing','corrupted'])test(`copied drafts exclude ${damage} selected attachment bytes without changing the failed request`,async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const broken=await addFile(h,review.id,'selected file to validate'),kept=await addFile(h,review.id,'keep this selected file'),unselected=await addFile(h,review.id,'unselected file');
 const imagePath=path.join(h.root,'selected-image.png'),imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64');fs.writeFileSync(imagePath,imageBytes);h.state.openResult={canceled:false,filePaths:[imagePath]};
 const [image]=await h.success('attachment.add',{reviewId:review.id});
 const source=await h.success('agent.start',{requestId:`copy-${damage}-source`,reviewId:review.id,prompt:'Preserve the selected files',context:{instruction:false,screenshotId:image.id,attachmentIds:[broken.id,kept.id],logIds:[]}});
 h.state.agentUpdate({id:source.id,kind:'agent',status:'failed',error:'fixture failure',finishedAt:new Date().toISOString()});
 const original=await h.success('agent.read',{id:source.id}),before=await h.success('snapshot'),starts=h.state.agentStarts.length;
 for(const file of [broken,image]){const location=path.join(h.dataPath,'attachments',file.storageName);if(damage==='missing')fs.unlinkSync(location);else fs.writeFileSync(location,'changed bytes');}
 fs.unlinkSync(path.join(h.dataPath,'attachments',unselected.storageName));
 const copy=await h.success('agent.copyDraft',{reviewId:review.id,runId:source.id});
 assert.equal(copy.draft.screenshotId,null);assert.deepEqual(copy.draft.attachmentIds,[kept.id]);assert.equal(copy.draft.prompt,source.prompt);assert.deepEqual(copy.excluded.map(file=>file.id).sort(),[image.id,broken.id].sort());assert.ok(copy.excluded.every(file=>file.reason==='첨부 자료를 더 이상 사용할 수 없습니다.'));
 assert.deepEqual(await h.success('agent.read',{id:source.id}),original);assert.deepEqual(await h.success('snapshot'),before);assert.equal(h.state.agentStarts.length,starts);assert.equal(h.state.liveStore.listAgentRuns().length,1);
 assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',kept.storageName),'utf8'),'keep this selected file');
 for(const file of [broken,image]){const location=path.join(h.dataPath,'attachments',file.storageName);if(damage==='missing')assert.equal(fs.existsSync(location),false);else assert.equal(fs.readFileSync(location,'utf8'),'changed bytes');}
});

test('issue 27 dispatch preserves automatic selection, transmitted values, reported values and retry history separately',async t=>{
 const h=await harness(t),{service,review}=await seed(h);
 await h.success('service.save',{id:service.id,agentEnabled:1,agentModel:'project-model',agentReasoningEffort:'high'});
 const executionSettings={version:1,selected:{model:'',reasoningEffort:''},automatic:{model:true,reasoningEffort:true},sent:{model:'project-model',reasoningEffort:'high'}};
 const first=await h.success('agent.start',{reviewId:review.id,requestId:'issue27-auto',prompt:'\n  요청 원문\n\n',executionSettings,context:{instruction:false,attachmentIds:[],logIds:[]}});
 assert.deepEqual(first.executionSettings,executionSettings);assert.equal(first.reportedSettings,undefined);
 assert.equal(first.prompt,'\n  요청 원문\n\n');
 const reportedSettings={model:'reported-model',source:'cli_event',eventType:'turn.started',reportedAt:new Date().toISOString()};
 h.state.agentUpdate({id:first.id,kind:'agent',status:'failed',reportedSettings,sessionId:'issue27-original-session',error:'synthetic failure',finishedAt:new Date().toISOString()});
 const original=await h.success('agent.read',{id:first.id});
 await h.success('service.save',{id:service.id,agentModel:'later-model',agentReasoningEffort:'low'});
 const retried=await h.success('agent.start',{reviewId:review.id,requestId:'issue27-retry',retryOf:first.id,prompt:first.prompt});
 assert.deepEqual(retried.executionSettings,executionSettings);assert.equal(retried.model,'project-model');assert.equal(retried.reasoningEffort,'high');
 assert.equal(retried.reportedSettings,undefined);assert.equal(retried.retryOf,first.id);assert.notEqual(retried.id,first.id);
 assert.deepEqual(await h.success('agent.read',{id:first.id}),original);
});

test('issue 27 queued settings survive project connection replacement and explicit edits control the subsequent manual execution',async t=>{
 const h=await harness(t),{service,project,review}=await seed(h);
 await h.success('service.save',{id:service.id,agentEnabled:1,agentModel:'saved-project-model',agentReasoningEffort:'high'});
 const first=await h.success('agent.start',{reviewId:review.id,requestId:'issue27-before-queue',prompt:'First',context:{instruction:false}});
 assert.deepEqual(first.executionSettings.selected,{model:'',reasoningEffort:''});assert.deepEqual(first.executionSettings.automatic,{model:true,reasoningEffort:true});assert.deepEqual(first.executionSettings.sent,{model:'saved-project-model',reasoningEffort:'high'});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'completed',response:'Complete',sessionId:'issue27-session',finishedAt:new Date().toISOString()});
 const queued=await h.success('agent.request.add',{reviewId:review.id,requestId:'issue27-queued',prompt:'  저장한 요청\n\n',predecessorId:first.id,context:{instruction:false,attachmentIds:[],logIds:[]}});
 assert.equal(queued.model,'saved-project-model');assert.equal(queued.reasoningEffort,'high');assert.equal(queued.prompt,'  저장한 요청\n\n');
 assert.deepEqual(queued.executionSettings.selected,{model:'',reasoningEffort:''});assert.deepEqual(queued.executionSettings.sent,first.executionSettings.sent);
 const changed=await h.success('project.save',{id:project.id,connection:{agentModel:'changed-project-model',agentReasoningEffort:'low'}});
 assert.notEqual(changed.connection.id,service.id);
 const starts=h.state.agentStarts.length;
 assert.equal((await h.success('agent.request.list',{reviewId:review.id})).requests[0].state,'ready');assert.equal(h.state.agentStarts.length,starts);
 const run=await h.success('agent.request.start',{id:queued.id});
 assert.equal(run.serviceId,changed.connection.id);assert.equal(run.model,queued.model);assert.equal(run.reasoningEffort,queued.reasoningEffort);assert.deepEqual(run.executionSettings,queued.executionSettings);
 h.state.agentUpdate({id:run.id,kind:'agent',status:'completed',response:'Queued result',finishedAt:new Date().toISOString()});
 const next=await h.success('agent.request.add',{reviewId:review.id,requestId:'issue27-edited-queue',prompt:'Edit before starting',model:'before-edit',reasoningEffort:'medium',continuedFromRunId:run.id});
 const edited=await h.success('agent.request.update',{id:next.id,model:'after-edit',reasoningEffort:'low',newConversation:true});
 assert.equal(edited.model,'after-edit');assert.equal(edited.reasoningEffort,'low');assert.equal(edited.continuedFromRunId,'');
 const [a,b]=await Promise.all([h.success('agent.request.start',{id:next.id}),h.success('agent.request.start',{id:next.id})]);
 assert.equal(a.id,b.id);assert.equal(a.model,'after-edit');assert.equal(a.reasoningEffort,'low');assert.equal(a.newConversation,true);assert.equal(a.continuedFromRunId,undefined);assert.equal(h.state.agentStarts.filter(input=>input.id===next.id).length,1);
});

test('issue 28 queued attachments and draft identifiers survive a storage failure before atomic save and execute once',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const staged=await stageFile(h,'queued-attachment.txt'),before=await h.success('snapshot');
 const input={reviewId:review.id,requestId:'issue28-queue-save',prompt:'  후속 요청 원문\n',model:'queue-model',reasoningEffort:'high',context:{instruction:false,attachmentIds:[],logIds:[]},attachmentTokens:[staged.token]};
 const original=h.state.liveStore.addAttachment;h.state.liveStore.addAttachment=()=>{throw new Error('synthetic queued attachment failure')};
 const rejected=await h.invoke('agent.request.add',input);assert.equal(rejected.ok,false);
 h.state.liveStore.addAttachment=original;
 assert.deepEqual(await h.success('snapshot'),before);assert.deepEqual((await h.success('agent.request.list',{reviewId:review.id})).requests,[]);
 assert.equal((await h.success('attachment.staged',{tokens:[staged.token]})).files.length,1);
 const saved=await h.success('agent.request.add',input);
 assert.equal(saved.prompt,input.prompt);assert.equal(saved.context.attachmentIds.length,1);assert.equal(h.state.agentStarts.length,0);
 const acceptedAgain=await h.success('agent.request.add',input);assert.equal(acceptedAgain.id,saved.id);
 assert.equal((await h.success('agent.request.list',{reviewId:review.id})).requests.length,1);
 const file=(await h.success('snapshot')).attachments.find(item=>item.id===saved.context.attachmentIds[0]);assert.equal(file.name,'queued-attachment.txt');
 const run=await h.success('agent.request.start',{id:saved.id});assert.deepEqual(run.context.attachmentIds,saved.context.attachmentIds);
 assert.equal(h.state.agentStarts.at(-1).files[0].bytes.toString(),'staged attachment content');
 assert.equal(run.prompt,input.prompt);
});

test('issue 27 continuing after a model change keeps the source request link and copied requests keep a separate origin',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const first=await h.success('agent.start',{reviewId:review.id,requestId:'issue27-link-first',prompt:'First request',model:'model-a',reasoningEffort:'high',context:{instruction:false}});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'completed',sessionId:'issue27-link-session',response:'First response',finishedAt:new Date().toISOString()});
 const second=await h.success('agent.start',{reviewId:review.id,requestId:'issue27-link-second',continuedFromRunId:first.id,prompt:'Follow up',model:'model-b',reasoningEffort:'low',context:{instruction:false}});
 assert.equal(second.continuedFromRunId,first.id);assert.equal(second.model,'model-b');assert.equal(second.sessionId,'issue27-link-session');assert.equal(h.state.agentStarts.at(-1).sessionId,'issue27-link-session');assert.notEqual(second.id,first.id);
 h.state.agentUpdate({id:second.id,kind:'agent',status:'failed',error:'synthetic failed followup',finishedAt:new Date().toISOString()});
 const before=await h.success('agent.read',{id:second.id}),copied=await h.success('agent.copyDraft',{reviewId:review.id,runId:second.id});
 const copy=await h.success('agent.start',{reviewId:review.id,requestId:'issue27-link-copy',prompt:copied.draft.prompt,newConversation:true,model:copied.draft.model,reasoningEffort:copied.draft.reasoningEffort,sourceRunId:copied.draft.sourceRunId,sourceTarget:copied.draft.sourceTarget,context:{instruction:false}});
 assert.equal(copy.sourceRunId,second.id);assert.equal(copy.continuedFromRunId,undefined);assert.equal(copy.newConversation,true);
 assert.deepEqual(await h.success('agent.read',{id:second.id}),before);
});

for(const sourceStatus of ['completed','failed'])test(`issue 27 an explicit ${sourceStatus} source never resumes an unrelated later conversation`,async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const source=await h.success('agent.start',{reviewId:review.id,requestId:`issue27-session-source-${sourceStatus}`,prompt:'Source A',model:'same-model',reasoningEffort:'high',context:{instruction:false}});
 h.state.agentUpdate({id:source.id,kind:'agent',status:sourceStatus,sessionId:'selected-session-a',response:'A response',...(sourceStatus==='failed'?{error:'synthetic failure'}:{}),finishedAt:new Date().toISOString()});
 const other=await h.success('agent.start',{reviewId:review.id,requestId:`issue27-session-other-${sourceStatus}`,prompt:'Separate B',model:'same-model',reasoningEffort:'high',newConversation:true,context:{instruction:false}});
 h.state.agentUpdate({id:other.id,kind:'agent',status:'completed',sessionId:'later-session-b',response:'B response',finishedAt:new Date().toISOString()});
 const continued=await h.success('agent.start',{reviewId:review.id,requestId:`issue27-session-continued-${sourceStatus}`,prompt:'Continue selected A',model:'same-model',reasoningEffort:'high',continuedFromRunId:source.id,context:{instruction:false}});
 assert.equal(continued.continuedFromRunId,source.id);assert.notEqual(continued.sessionId,'later-session-b');
 if(sourceStatus==='completed')assert.equal(continued.sessionId,'selected-session-a');
 assert.equal(h.state.agentStarts.at(-1).sessionId,continued.sessionId);
});

test('issue 27 retry stays with its failed source after another conversation completes',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const a=await h.success('agent.start',{reviewId:review.id,requestId:'retry-source-a',prompt:'A',model:'model-a',context:{instruction:false}});
 h.state.agentUpdate({id:a.id,kind:'agent',status:'failed',sessionId:'session-a',error:'A failed',finishedAt:new Date().toISOString()});
 const b=await h.success('agent.start',{reviewId:review.id,requestId:'retry-other-b',prompt:'B',model:'model-b',newConversation:true,context:{instruction:false}});
 h.state.agentUpdate({id:b.id,kind:'agent',status:'completed',sessionId:'session-b',response:'B done',finishedAt:new Date().toISOString()});
 const original=await h.success('agent.read',{id:a.id});
 const input={reviewId:review.id,requestId:'retry-a-again',prompt:a.prompt,retryOf:a.id,model:'model-c',newConversation:false};
 const [first,second]=await Promise.all([h.success('agent.start',input),h.success('agent.start',input)]);
 assert.equal(first.id,second.id);assert.equal(first.sessionId,'session-a');assert.equal(first.continuedFromRunId,a.id);assert.equal(first.model,'model-c');
 assert.equal(h.state.agentStarts.filter(item=>item.id===input.requestId).length,1);assert.equal(h.state.agentStarts.at(-1).sessionId,'session-a');
 assert.deepEqual(await h.success('agent.read',{id:a.id}),original);
});

test('issue 27 retry can use the original parent session and refuses a missing source session',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const a=await h.success('agent.start',{reviewId:review.id,prompt:'A',context:{instruction:false}});
 h.state.agentUpdate({id:a.id,kind:'agent',status:'completed',sessionId:'parent-session',response:'A done',finishedAt:new Date().toISOString()});
 const failed=await h.success('agent.start',{reviewId:review.id,prompt:'A followup',continuedFromRunId:a.id,context:{instruction:false}});
 h.state.agentUpdate({id:failed.id,kind:'agent',status:'failed',sessionId:'',error:'failed before CLI reported session',finishedAt:new Date().toISOString()});
 const retry=await h.success('agent.start',{reviewId:review.id,prompt:failed.prompt,retryOf:failed.id});assert.equal(retry.sessionId,'parent-session');assert.equal(retry.continuedFromRunId,a.id);
 h.state.agentUpdate({id:retry.id,kind:'agent',status:'failed',sessionId:'',error:'stop',finishedAt:new Date().toISOString()});
 const missing=await h.success('agent.start',{reviewId:review.id,prompt:'New initial',newConversation:true,context:{instruction:false}});
 h.state.agentUpdate({id:missing.id,kind:'agent',status:'failed',error:'no session',finishedAt:new Date().toISOString()});
 const before=await h.success('snapshot'),starts=h.state.agentStarts.length;
 const rejected=await h.invoke('agent.start',{reviewId:review.id,prompt:missing.prompt,retryOf:missing.id,newConversation:false});
 assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'AGENT_RETRY_SESSION_MISSING');assert.match(rejected.error.message,/새 대화/);assert.equal(h.state.agentStarts.length,starts);assert.deepEqual(await h.success('snapshot'),before);
 const fresh=await h.success('agent.start',{reviewId:review.id,prompt:missing.prompt,retryOf:missing.id,newConversation:true});assert.equal(fresh.sessionId,'');assert.equal(fresh.newConversation,true);
});

test('issue 27 model selection keeps session availability and implicit continuation on the same target',async t=>{
 const h=await harness(t),{service,project,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1,agentModel:'model-a'});
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'First',context:{instruction:false}});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'completed',sessionId:'model-independent-session',response:'Done',finishedAt:new Date().toISOString()});
 await h.success('project.save',{id:project.id,connection:{...h.state.liveStore.get('services',service.id),agentModel:'model-b'}});
 assert.equal((await h.success('agent.session',{reviewId:review.id,model:'model-c'})).available,true);assert.equal(h.state.sessionCheck.sessionId,'model-independent-session');
 const next=await h.success('agent.start',{reviewId:review.id,prompt:'Continue',model:'model-c',context:{instruction:false}});assert.equal(next.sessionId,'model-independent-session');assert.equal(next.model,'model-c');assert.equal(next.continuedFromRunId,first.id);
});

test('issue 28 native clipboard writes exact original text only for a trusted application main frame',async t=>{
 const h=await harness(t),text='  요청 원문\n\n```js\na = 1;\n```\n| 열 | 값 |\n| --- | --- |\n| 한글 | 2 |\n';
 assert.deepEqual(await h.success('clipboard.writeText',{text}),{copied:true});assert.equal(h.state.clipboardText,text);
 const host=h.state.window,untrusted=[{sender:host.webContents,senderFrame:{url:'reviewops://app/index.html',parent:host.webContents.mainFrame}},{sender:host.webContents,senderFrame:{url:'https://external.example/'}}];
 for(const event of untrusted)assert.equal((await h.invoke('clipboard.writeText',{text:'untrusted'},event)).ok,false);
 host.webContents.mainFrame.url='https://external.example/';assert.equal((await h.invoke('clipboard.writeText',{text:'untrusted'})).ok,false);host.webContents.mainFrame.url='reviewops://app/index.html';
 for(const value of ['',null,8,'x'.repeat(2*1024*1024+1)])assert.equal((await h.invoke('clipboard.writeText',{text:value})).ok,false);
 h.state.clipboardError=new Error('synthetic clipboard failure');const failed=await h.invoke('clipboard.writeText',{text:'retry text'});assert.equal(failed.ok,false);assert.match(failed.error.message,/synthetic clipboard failure/);assert.equal(h.state.clipboardText,text);
 h.state.clipboardError=null;assert.deepEqual(await h.success('clipboard.writeText',{text:'retry text'}),{copied:true});assert.equal(h.state.clipboardText,'retry text');
 assert.equal(h.state.permissionCheck(host.webContents,'clipboard-read','reviewops://app/index.html'),false);assert.equal(h.state.permissionCheck(host.webContents,'clipboard-sanitized-write','https://external.example'),false);
});

test('native clipboard results wait for asynchronous writes and preserve rejections',async t=>{
 const writes=[];
 const h=await harness(t,{clipboardWrite(text){return new Promise((resolve,reject)=>writes.push({text,resolve,reject}));}});
 for(const action of ['clipboard.writeText','update.copyInfo']){
  let settled=false;
  const pending=h.invoke(action,{text:'Owned diagnostic text'}).then(result=>{settled=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));
  const write=writes.shift();assert.ok(write);assert.equal(typeof write.text,'string');
  try{assert.equal(settled,false,'Copy success must wait for the native clipboard write');}
  finally{write.resolve();}
  assert.equal((await pending).ok,true);
  const rejected=h.invoke(action,{text:'Owned rejected diagnostic text'});
  await new Promise(resolve=>setImmediate(resolve));
  const failure=writes.shift();assert.ok(failure);failure.reject(new Error('Synthetic asynchronous clipboard denial'));
  const result=await rejected;assert.equal(result.ok,false);assert.match(result.error.message,/Synthetic asynchronous clipboard denial/);
 }
 assert.equal(writes.length,0);
});

test('update build information copies through the trusted native clipboard route',async t=>{
 const h=await harness(t),state=await h.success('update.state');
 assert.deepEqual(await h.success('update.copyInfo'),{copied:true});
 assert.ok(h.state.clipboardText.includes(`설치된 버전: ${state.version} (정식)`));
 assert.ok(h.state.clipboardText.includes(`CPU: ${state.arch}`));
 assert.ok(!h.state.clipboardText.includes('빌드:'));
 const host=h.state.window;
 assert.equal((await h.invoke('update.copyInfo',{}, {sender:host.webContents,senderFrame:{url:'https://external.example/'}})).ok,false);
});

test('project QA rejects global and foreign IPC while its project and the unbound main window still work',async t=>{
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);
 const gb=await main.success('group.save',{name:'Other QA group'}),sb=await main.success('service.save',{groupId:gb.id,name:'Other connection',kind:'local',rootPath:h.root});
 const pb=await main.success('project.save',{groupId:gb.id,name:'Other project',serviceIds:[sb.id]}),rb=await main.success('review.save',{projectId:pb.id,serviceId:sb.id,title:'Other review'});
 await main.success('window.openProject',{projectId:a.project.id});const host=await projectHost(h,a.project.id),client=h.forWindow(host);
 const qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'scoped-qa'});
 const result=await client.success('snapshot');assert.deepEqual(result.projects.map(item=>item.id),[a.project.id]);assert.deepEqual(result.reviews.map(item=>item.id),[a.review.id]);assert.equal(result.groups.some(item=>item.id===gb.id),false);
 for(const [action,payload]of [['group.save',{id:gb.id,name:'must not change'}],['group.delete',{id:gb.id}],['project.save',{id:pb.id,name:'must not change'}],['review.save',{id:rb.id,body:'must not change'}],['files.list',{serviceId:sb.id}],['window.openProject',{projectId:pb.id}],['agent.list',{}],['settings.save',{theme:'dark'}],['agent.login',{serviceId:a.service.id}],['agent.logout',{serviceId:a.service.id}],['backup.export',{}]]){
  const denied=await client.invoke(action,payload);assert.equal(denied.ok,false,action);assert.equal(denied.error.code,'TARGET_MISMATCH',action);
 }
 assert.throws(()=>h.state.codexOptions.withWindow(client.event(),()=>h.state.codexOptions.trusted(client.event())),{code:'TARGET_MISMATCH'});
 assert.ok(!h.state.codexOptions.getWindows().includes(host));
 await client.success('review.save',{id:a.review.id,body:'Own project remains editable'});
 await main.success('group.save',{id:gb.id,name:'Full app remains editable'});
 assert.equal((await main.success('snapshot')).groups.find(item=>item.id===gb.id).name,'Full app remains editable');
 assert.equal((await main.success('snapshot')).reviews.find(item=>item.id===rb.id).body,'');
 await h.state.toolIntegration.automationHandler('automation.qa.release',qa);
 assert.equal((await client.success('snapshot')).projects.length,2);assert.ok(h.state.codexOptions.getWindows().includes(host));
 assert.equal(h.state.codexOptions.withWindow(client.event(),()=>h.state.codexOptions.trusted(client.event())),undefined);
});

test('a queued QA IPC keeps its project guard after the QA session is released',async t=>{
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow),other=await main.success('group.save',{name:'Preserve this group'});
 await main.success('window.openProject',{projectId:a.project.id});const client=h.forWindow(await projectHost(h,a.project.id));
 const qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'queue-qa'});
 let unblock;h.state.environmentGate=new Promise(resolve=>unblock=resolve);
 const probe=main.invoke('agent.environment',{serviceId:a.service.id});await waitForValue(()=>h.state.environmentCheck,'Environment probe did not start');
 const pending=client.invoke('group.save',{id:other.id,name:'must stay blocked'});
 await h.state.toolIntegration.automationHandler('automation.qa.release',qa);unblock();await probe;
 const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'TARGET_MISMATCH');
 assert.equal((await main.success('snapshot')).groups.find(item=>item.id===other.id).name,'Preserve this group');
});

test('QA scope readiness does not wait behind a different queued operation',async t=>{
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('window.openProject',{projectId:a.project.id});
 let unblock;h.state.environmentGate=new Promise(resolve=>unblock=resolve);
 const probe=main.invoke('agent.environment',{serviceId:a.service.id});await waitForValue(()=>h.state.environmentCheck,'Environment probe did not start');
 try{
  const qa=await Promise.race([h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'ready-qa'}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('QA ready was blocked by the mutation queue')),1000))]);
  await h.state.toolIntegration.automationHandler('automation.qa.release',qa);
 }finally{unblock();await probe;}
});

test('project QA cannot inspect or cancel shared login jobs while own review jobs remain usable',async t=>{
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('service.save',{id:a.service.id,agentEnabled:1});
 await main.success('project.save',{groupId:a.group.id,name:'Shared connection B',serviceIds:[a.service.id]});
 const login=await main.success('agent.login',{serviceId:a.service.id});
 const qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'auth-scope-qa'}),client=h.forWindow(await projectHost(h,a.project.id));
 for(const [action,payload] of [['agent.loginState',{serviceId:a.service.id}],['agent.read',{id:login.id}],['agent.cancel',{id:login.id}]]){
  const result=await client.invoke(action,payload);assert.equal(result.ok,false,action);assert.equal(result.error.code,'TARGET_MISMATCH',action);
 }
 assert.deepEqual(h.state.agentCancelled,[]);assert.equal((await main.success('agent.loginState',{serviceId:a.service.id})).status,'running');
 await main.success('agent.cancel',{id:login.id});
 const own=await client.success('agent.start',{reviewId:a.review.id,prompt:'Synthetic own project request'});
 assert.equal((await client.success('agent.read',{id:own.id})).reviewId,a.review.id);
 await client.success('agent.cancel',{id:own.id});assert.ok(h.state.agentCancelled.includes(own.id));
 await h.state.toolIntegration.automationHandler('automation.qa.release',qa);
});

test('project QA permits its saved sibling work folder but rejects a symlink escape',async t=>{
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow),files=path.join(h.root,'files'),work=path.join(h.root,'work'),outside=path.join(h.root,'outside');
 for(const folder of [files,work,outside])fs.mkdirSync(folder);fs.symlinkSync(outside,path.join(work,'other'));
 const project=await main.success('project.save',{groupId:a.group.id,name:'Separate local work path',connection:{kind:'local',rootPath:files,agentWorkPath:work,agentEnabled:false}});
 const qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:project.id,clientId:'path-scope-qa'}),client=h.forWindow(await projectHost(h,project.id));
 for(const folder of [files,work]){
  assert.equal((await client.success('directory.inspect',{path:folder})).status,'ready');
  await client.success('directory.create',{parent:folder,name:'child'});assert.equal(fs.statSync(path.join(folder,'child')).isDirectory(),true);
 }
 for(const target of [outside,path.join(work,'other'),path.join(work,'other','missing')]){
  const result=await client.invoke('directory.create',{parent:target,name:'blocked'});assert.equal(result.ok,false);assert.equal(result.error.code,'TARGET_MISMATCH');
 }
 assert.deepEqual(fs.readdirSync(outside),[]);await h.state.toolIntegration.automationHandler('automation.qa.release',qa);
});

test('a QA window can render an empty snapshot and close after deleting its own project',async t=>{
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('project.save',{groupId:a.group.id,name:'Other project remains',serviceIds:[a.service.id]});
 await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'deleted-scope-qa'});
 const host=await projectHost(h,a.project.id),client=h.forWindow(host);
 await client.success('project.delete',{id:a.project.id});
 const snapshot=await client.success('snapshot');for(const key of ['projects','groups','services','reviews','activities','attachments'])assert.deepEqual(snapshot[key],[],key);
 assert.equal((await client.success('window.context')).projectId,a.project.id);await client.success('window.state');
 const blocked=await client.invoke('project.save',{id:a.project.id,name:'Restore through scope'});assert.equal(blocked.error.code,'TARGET_MISMATCH');
 await client.success('window.close');await waitForValue(()=>host.isDestroyed(),'Deleted QA window did not close');assert.equal(host.isDestroyed(),true);assert.equal(h.state.primaryWindow.isDestroyed(),false);
});

test('owned Node controls use saved configuration only, remain private and isolate project/consumer/connection',async t=>{
 const h=await harness(t),group=await h.success('group.save',{name:'Owned fixture'}),root=path.join(h.root,'owned');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'server.cjs'),`require('node:http').createServer((q,r)=>r.end('owned')).listen(0,'127.0.0.1');`);
 const project=await h.success('project.save',{groupId:group.id,name:'Owned project',connection:{kind:'local',rootPath:root}}),payload={projectId:project.id,connectionId:project.connection.id},config={executable:process.execPath,entry:'server.cjs',args:[],readinessUrl:'http://127.0.0.1:9999/health'};
 const other=await h.success('project.save',{groupId:group.id,name:'Other owned project',connection:{kind:'local',rootPath:root}});
 for(const action of ['serviceRuntime.configure','serviceRuntime.start','serviceRuntime.stop','serviceRuntime.restart','serviceRuntime.state'])await assert.rejects(h.state.toolIntegration.dispatch(action,payload),/프로젝트 화면/);
 assert.equal((await h.invoke('serviceRuntime.configure',{...payload,config},{sender:h.state.primaryWindow.webContents,senderFrame:{url:'https://external.example'}})).ok,false);
 await h.success('serviceRuntime.configure',{...payload,config});assert.equal((await h.invoke('serviceRuntime.start',{...payload,executable:'/bin/sh'})).ok,false);
 assert.equal((await h.invoke('serviceRuntime.start',{...payload,connectionId:other.connection.id})).ok,false);
 await h.success('window.openProject',{projectId:project.id});const client=h.forWindow(await projectHost(h,project.id));
 assert.equal((await client.invoke('serviceRuntime.state',{projectId:other.id,connectionId:other.connection.id})).ok,false);
 const qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:project.id,clientId:'owned-service-scope'});
 assert.equal((await client.invoke('serviceRuntime.configure',{...payload,config})).error.code,'TARGET_MISMATCH');await client.success('serviceRuntime.state',payload);
 let instance;
 try{
  instance=(await client.success('serviceRuntime.start',payload)).instance;assert.equal(instance.status,'running');
  const read=await client.success('serviceRuntime.state',payload);assert.equal(read.instance.instanceId,instance.instanceId);
  for(const [action,body]of [['project.save',{id:project.id,connection:{...project.connection,rootPath:h.root}}],['project.save',{id:project.id,serviceIds:[]}],['service.save',{id:project.connection.id,description:'blocked'}],['project.delete',{id:project.id}],['group.delete',{id:group.id}],['backup.import',{}]]){
   const denied=await h.forWindow(h.state.primaryWindow).invoke(action,body);assert.equal(denied.ok,false,action);assert.equal(denied.error.code,'SERVICE_BUSY',action);
  }
  // Agent cancellation/renderer disposal do not appear in the manager ownership key.
  assert.equal((await client.success('serviceRuntime.state',payload)).instance.instanceId,instance.instanceId);
 }finally{if(instance)await client.success('serviceRuntime.stop',{...payload,instanceId:instance.instanceId});await h.state.toolIntegration.automationHandler('automation.qa.release',qa);}
});

test('readiness observation is separate from execution proof and rejects late A→B→A connection results',async t=>{
 const h=await harness(t),http=require('node:http');let respond,requested;const called=new Promise(resolve=>requested=resolve);
 const server=http.createServer((_req,res)=>{respond=()=>res.end('external');requested();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const root=path.join(h.root,'readiness'),other=path.join(h.root,'other');fs.mkdirSync(root);fs.mkdirSync(other);fs.writeFileSync(path.join(root,'comparison.bin'),'not deployment proof');
 const group=await h.success('group.save',{name:'Readiness'}),project=await h.success('project.save',{groupId:group.id,name:'Readiness',connection:{kind:'local',rootPath:root}}),url=`http://127.0.0.1:${server.address().port}/`;
 const pending=h.invoke('viewer.readiness',{projectId:project.id,connectionId:project.connection.id,url,path:'comparison.bin'});await called;
 await h.success('service.save',{id:project.connection.id,rootPath:other});await h.success('service.save',{id:project.connection.id,rootPath:root});respond();
 const late=await pending;assert.equal(late.ok,false);assert.match(late.error.message,/연결이 변경/);
 await assert.rejects(h.state.toolIntegration.dispatch('viewer.readiness',{projectId:project.id,url}),/프로젝트 화면/);
 assert.equal((await h.invoke('viewer.agentState',{projectId:project.id,connectionId:'foreign'})).ok,false);
});

test('cancelled quit with a surviving window can quit again and configure services afterward',async t=>{
 const h=await harness(t),host=h.state.primaryWindow;host.on('close',event=>event.preventDefault());
 const close=()=>h.appEvents.emit('before-quit',{preventDefault(){}});
 close();for(let n=0;n<100&&host.closeCalls<1;n++)await new Promise(r=>setTimeout(r,5));assert.equal(host.closeCalls,1);assert.equal(host.destroyed,false);
 close();for(let n=0;n<100&&host.closeCalls<2;n++)await new Promise(r=>setTimeout(r,5));assert.equal(host.closeCalls,2);
 const group=await h.success('group.save',{name:'survived quit'}),project=await h.success('project.save',{groupId:group.id,name:'survived quit',connection:{kind:'local',rootPath:h.root}});fs.writeFileSync(path.join(h.root,'service.cjs'),'');
 await h.success('serviceRuntime.configure',{projectId:project.id,connectionId:project.connection.id,config:{executable:process.execPath,entry:'service.cjs',args:[],readinessUrl:'http://127.0.0.1:9999/'}});
});

test('a failure in another quit subsystem resumes the surviving runtime without adopting any PID',async t=>{
 const h=await harness(t);h.state.primaryWindow.destroyed=true;h.state.codexCloseError=true;
 h.appEvents.emit('before-quit',{preventDefault(){}});
 for(let n=0;n<100&&h.state.windows.length<2;n++)await new Promise(r=>setTimeout(r,5));assert.equal(h.state.windows.length,2);assert.equal(h.state.window.destroyed,false);
 const group=await h.success('group.save',{name:'subsystem failure'}),project=await h.success('project.save',{groupId:group.id,name:'subsystem failure',connection:{kind:'local',rootPath:h.root}});fs.writeFileSync(path.join(h.root,'service.cjs'),'');
 const configured=await h.success('serviceRuntime.configure',{projectId:project.id,connectionId:project.connection.id,config:{executable:process.execPath,entry:'service.cjs',args:[],readinessUrl:'http://127.0.0.1:9999/'}});assert.equal(configured.instance,null);
});


test('quit waits for delayed Electron beforeunload close and asks app to quit only after closed',async t=>{
 const h=await harness(t),host=h.state.primaryWindow;host.delayClose=true;host.preventUnload=true;host.unloadResponse=1;
 h.appEvents.emit('before-quit',{preventDefault(){}});
 await waitForValue(()=>host.pendingCloses?.length,'No delayed close was requested');
 assert.equal(host.destroyed,false);assert.equal(h.state.appQuitCalls,0);assert.equal(h.state.unloadCalls,0,'No early discard consent before actual unload');
 h.appEvents.emit('before-quit',{preventDefault(){}});assert.equal(host.closeCalls,1,'Repeated quit must share the pending attempt');
 host.flushClose();await waitForValue(()=>h.state.appQuitCalls,'Async closed did not finish quit');
 assert.equal(h.state.appQuitCalls,1);assert.equal(host.destroyed,true);assert.equal(h.state.unloadCalls,1,'The final unload asks exactly once');
});

test('a real close veto revokes approval so fresh unsaved work still prompts and runtime can resume',async t=>{
 const h=await harness(t),host=h.state.primaryWindow,veto=event=>event.preventDefault();host.on('close',veto);
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>host.closeCalls,'Quit did not try to close');
 host.removeListener('close',veto);host.preventUnload=true;host.unloadResponse=0;host.close();
 assert.equal(host.destroyed,false);assert.equal(h.state.unloadCalls,1,'Cancelled quit approval must not bypass a later dirty prompt');assert.equal(h.state.appQuitCalls,0);
 host.preventUnload=false;
 const group=await h.success('group.save',{name:'approval revoked'}),project=await h.success('project.save',{groupId:group.id,name:'approval revoked',connection:{kind:'local',rootPath:h.root}});fs.writeFileSync(path.join(h.root,'service.cjs'),'');
 await h.success('serviceRuntime.configure',{projectId:project.id,connectionId:project.connection.id,config:{executable:process.execPath,entry:'service.cjs',args:[],readinessUrl:'http://127.0.0.1:9999/'}});
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>h.state.appQuitCalls,'Fresh quit was blocked after veto');assert.equal(h.state.appQuitCalls,1);
});

test('a bounded incomplete close cancels without destroying the delayed window or retaining approval',async t=>{
 const h=await harness(t,{quitCloseTimeoutMs:25}),host=h.state.primaryWindow;host.delayClose=true;
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>h.state.startupErrors.length,'Incomplete close did not time out');
 assert.match(h.state.startupErrors[0].message,/창 닫힘/);assert.equal(host.destroyed,false);assert.equal(h.state.appQuitCalls,0);
 host.preventUnload=true;host.unloadResponse=0;host.flushClose();assert.equal(host.destroyed,false);assert.equal(h.state.unloadCalls,1);
 const group=await h.success('group.save',{name:'timeout resumed'}),project=await h.success('project.save',{groupId:group.id,name:'timeout resumed',connection:{kind:'local',rootPath:h.root}});fs.writeFileSync(path.join(h.root,'service.cjs'),'');
 await h.success('serviceRuntime.configure',{projectId:project.id,connectionId:project.connection.id,config:{executable:process.execPath,entry:'service.cjs',args:[],readinessUrl:'http://127.0.0.1:9999/'}});
});

test('a new window invalidates pending quit and its stale timeout cannot cancel the next attempt',async t=>{
 const h=await harness(t,{captureQuitCloseTimers:true}),host=h.state.primaryWindow;
 const group=await h.success('group.save',{name:'new quit window'}),project=await h.success('project.save',{groupId:group.id,name:'new quit window',connection:{kind:'local',rootPath:h.root}});fs.writeFileSync(path.join(h.root,'service.cjs'),'');
 const payload={projectId:project.id,connectionId:project.connection.id,config:{executable:process.execPath,entry:'service.cjs',args:[],readinessUrl:'http://127.0.0.1:9999/'}};
 host.delayClose=true;h.state.delayClose=true;
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>host.pendingCloses?.length,'First quit did not wait');const staleTimeout=h.state.quitCloseTimers[0];
 await h.success('window.openProject',{projectId:project.id});const newer=await projectHost(h,project.id);await h.success('serviceRuntime.configure',payload);
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>newer.pendingCloses?.length,'Second quit did not wait');
 staleTimeout();assert.equal(h.state.appQuitCalls,0);assert.deepEqual(h.state.startupErrors,[]);
 const denied=await h.forWindow(host).invoke('serviceRuntime.configure',payload);assert.equal(denied.ok,false,'Old timeout must not resume the new attempt');
 host.flushClose();assert.equal(h.state.appQuitCalls,0);newer.flushClose();await waitForValue(()=>h.state.appQuitCalls,'Current exact window closes did not finish');assert.equal(h.state.appQuitCalls,1);
});

test('input made while service drain waits is presented only at final unload and cancel keeps the draft',async t=>{
 const h=await harness(t),host=h.state.primaryWindow;let release,started=false,resumed=0;
 const resume=h.state.managedServices.resume;h.state.managedServices.resume=()=>{resumed++;resume();};h.state.managedServices.close=()=>{started=true;return new Promise(resolve=>release=resolve);};
 host.draftText='before drain';host.preventUnload=false;host.unloadResponse=0;h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>started,'Service drain did not begin');assert.equal(host.closeCalls,0);assert.equal(h.state.unloadCalls,0);
 host.draftText='new input while draining';host.preventUnload=true;release();await waitForValue(()=>h.state.unloadCalls,'Final renderer unload did not ask');assert.equal(h.state.unloadPrompts[0].draft,'new input while draining');assert.equal(host.destroyed,false);assert.equal(host.draftText,'new input while draining');assert.equal(h.state.appQuitCalls,0);assert.equal(resumed,1);
});

test('input just before delayed native beforeunload still asks and never uses an early clean check',async t=>{
 const h=await harness(t),host=h.state.primaryWindow;host.delayClose=true;
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>host.pendingCloses?.length,'Delayed close not requested');assert.equal(h.state.unloadCalls,0);
 host.draftText='last close input';host.preventUnload=true;host.unloadResponse=0;host.flushClose();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.state.unloadCalls,1);assert.equal(h.state.unloadPrompts[0].draft,'last close input');assert.equal(host.destroyed,false);assert.equal(host.draftText,'last close input');assert.equal(h.state.appQuitCalls,0);
});

test('discard consent for one window never authorizes edits in another window',async t=>{
 const h=await harness(t),first=h.state.primaryWindow;const group=await h.success('group.save',{name:'quit consent fixture'}),project=await h.success('project.save',{groupId:group.id,name:'another dirty window'});await h.success('window.openProject',{projectId:project.id});const second=await projectHost(h,project.id);
 first.preventUnload=true;first.unloadResponse=1;first.draftText='explicitly discarded A';second.delayClose=true;second.draftText='B before A consent';
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>second.pendingCloses?.length,'Second window did not wait');assert.equal(first.destroyed,true);assert.equal(h.state.unloadCalls,1);
 second.preventUnload=true;second.unloadResponse=0;second.draftText='B edited after A consent';second.flushClose();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.state.unloadCalls,2);assert.equal(h.state.unloadPrompts[1].draft,'B edited after A consent');assert.equal(second.destroyed,false);assert.equal(first.destroyed,true);assert.equal(h.state.appQuitCalls,0);
 second.draftText='B edited again after cancel';second.unloadResponse=1;h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>second.pendingCloses?.length,'Retry did not reach final close');second.flushClose();await waitForValue(()=>h.state.appQuitCalls,'Retry did not finish');assert.equal(h.state.unloadCalls,3);assert.equal(h.state.unloadPrompts[2].draft,'B edited again after cancel');assert.equal(h.state.appQuitCalls,1);
});

test('the close watchdog excludes time in the final synchronous discard dialog and invalidates queued expiry',async t=>{
 const clock={now:0},h=await harness(t,{quitClock:clock,controlQuitCloseTimers:true}),host=h.state.primaryWindow;host.delayClose=true;host.preventUnload=true;
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>host.pendingCloses?.length,'Delayed close did not begin');const old=h.state.controlledQuitTimers[0];assert.equal(old.delay,10000);clock.now=1000;
 h.state.syncDialogHandler=()=>{assert.equal(old.active,false,'Watchdog must pause before the modal');clock.now=61000;old.callback();assert.deepEqual(h.state.startupErrors,[]);return 1;};
 host.flushClose();const resumed=h.state.controlledQuitTimers[1];assert.equal(resumed.delay,9000,'Only time before the user question consumes the close budget');old.callback();await waitForValue(()=>h.state.appQuitCalls,'Approved close did not finish');assert.equal(h.state.appQuitCalls,1);assert.equal(resumed.active,false);assert.deepEqual(h.state.startupErrors,[]);
});

test('cancelled modal cannot rearm its old watchdog or cancel a later quit attempt',async t=>{
 const clock={now:0},h=await harness(t,{quitClock:clock,controlQuitCloseTimers:true}),host=h.state.primaryWindow;host.delayClose=true;host.preventUnload=true;
 h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>host.pendingCloses?.length,'First close did not begin');const old=h.state.controlledQuitTimers[0];
 h.state.syncDialogHandler=()=>{clock.now=120000;old.callback();return 0;};host.flushClose();await new Promise(resolve=>setImmediate(resolve));assert.equal(host.destroyed,false);assert.equal(h.state.controlledQuitTimers.length,1,'Cancel must not resume the expired attempt');assert.equal(old.active,false);
 h.state.syncDialogHandler=()=>1;h.appEvents.emit('before-quit',{preventDefault(){}});await waitForValue(()=>host.pendingCloses?.length,'Retry did not begin');const current=h.state.controlledQuitTimers[1];old.callback();assert.equal(current.active,true);assert.deepEqual(h.state.startupErrors,[]);host.flushClose();await waitForValue(()=>h.state.appQuitCalls,'Retry close did not finish');assert.equal(h.state.appQuitCalls,1);
});


test('backup import outer COMMIT failure restores owned runtime configuration with store, vault and attachment bytes',async t=>{
 const h=await harness(t),{group,service,review}=await seed(h);await addFile(h,review.id,'Original bytes survive outer COMMIT failure');
 const ownedRoot=path.join(h.root,'owned-reset');fs.mkdirSync(ownedRoot);fs.writeFileSync(path.join(ownedRoot,'entry.cjs'),'');
 const project=await h.success('project.save',{groupId:group.id,name:'Owned rollback fixture',connection:{kind:'local',rootPath:ownedRoot}}),target={projectId:project.id,connectionId:project.connection.id};
 await h.success('serviceRuntime.configure',{...target,config:{executable:process.execPath,entry:'entry.cjs',args:['preserved'],readinessUrl:'http://127.0.0.1:9999/'}});
 const configPath=path.join(h.dataPath,'owned-node-services.json'),vaultPath=path.join(h.dataPath,'credentials.json'),attachmentRoot=path.join(h.dataPath,'attachments');
 const before=await h.success('snapshot'),configBytes=fs.readFileSync(configPath),vaultBytes=fs.readFileSync(vaultPath),runtimeState=await h.success('serviceRuntime.state',target),revision=h.state.managedServices.revision(project.id);
 const oldAttachments=Object.fromEntries(fs.readdirSync(attachmentRoot).map(name=>[name,fs.readFileSync(path.join(attachmentRoot,name))]));
 // Keep the owned IDs resolvable in both transaction states, while changing
 // actual rows and staging replacement attachment files to prove rollback.
 const data=h.state.liveStore.exportData();data.groups.find(row=>row.id===group.id).name='Must roll back imported group';data.reviews.find(row=>row.id===review.id).title='Must roll back imported review';
 const bundle={format:'reviewops-local-backup',version:1,data,files:Object.fromEntries(data.attachments.map(row=>[row.storageName,fs.readFileSync(path.join(attachmentRoot,row.storageName)).toString('base64')]))},file=path.join(h.root,'outer-commit.reviewops.json');fs.writeFileSync(file,JSON.stringify(bundle));h.state.openResult={canceled:false,filePaths:[file]};
 const database=h.state.liveStore.db,exec=database.exec;let injected=0;
 database.exec=function(sql){
  if(sql==='COMMIT'&&!injected&&JSON.parse(fs.readFileSync(configPath,'utf8')).configurations.length===0){
   injected++;assert.equal(h.state.managedServices.state(project.id,project.connection.id).config,null);assert.ok(h.state.managedServices.revision(project.id)>revision);assert.equal(h.state.liveStore.get('groups',group.id).name,'Must roll back imported group');assert.deepEqual(JSON.parse(fs.readFileSync(vaultPath,'utf8')),{});
   throw Object.assign(new Error('injected real outer SQLite COMMIT failure'),{code:'SQLITE_IOERR'});
  }
  return exec.call(this,sql);
 };
 let result;try{result=await h.invoke('backup.import');}finally{database.exec=exec;}
 assert.equal(injected,1);assert.equal(result.ok,false);assert.match(result.error.message,/real outer SQLite COMMIT failure/);
 assert.deepEqual(await h.success('snapshot'),before);assert.deepEqual(fs.readFileSync(vaultPath),vaultBytes);assert.deepEqual(h.state.realVault.get(service.id),{password:'synthetic-old-password'});
 assert.deepEqual(await h.success('serviceRuntime.state',target),runtimeState);assert.deepEqual(fs.readFileSync(configPath),configBytes);assert.equal(h.state.managedServices.revision(project.id),revision);
 assert.deepEqual(fs.readdirSync(attachmentRoot).sort(),Object.keys(oldAttachments).sort());for(const [name,bytes]of Object.entries(oldAttachments))assert.deepEqual(fs.readFileSync(path.join(attachmentRoot,name)),bytes);
 const {createProjectServiceRuntime}=require('../electron/project-service-runtime.cjs'),reopened=createProjectServiceRuntime({configPath,resolveBinding:(projectId,connectionId)=>({projectId,connectionId,kind:'local',rootPath:ownedRoot,signature:JSON.stringify(h.state.liveStore.project(projectId).connection)})});assert.deepEqual(reopened.state(project.id,project.connection.id).config,runtimeState.config);assert.equal(reopened.hasActive(),false);await reopened.close();
});

const followupApi=async(h,action,payload)=>JSON.parse(JSON.stringify(await h.state.toolIntegration.automationHandler('automation.followups.'+action,payload)));

test('public follow-up retries preserve original identity through edits, backup and restart',async t=>{
 const h=await harness(t),{project,review}=await seed(h),input={projectId:project.id,reviewId:review.id,requestId:'public-original',prompt:'  Original request\n',requiredResult:'Original prerequisite',model:'saved-model',reasoningEffort:'high'};
 h.state.failures.get='before';
 const [first,again]=await Promise.all([followupApi(h,'create',input),followupApi(h,'create',input)]);
 assert.equal(first.requestId,again.requestId);assert.deepEqual([first.reused,again.reused],[false,true]);
 assert.equal((await h.success('agent.request.list',{reviewId:review.id})).requests.length,1);
 await h.success('agent.request.update',{id:first.requestId,prompt:'Edited in the UI',requiredResult:'Edited prerequisite',model:'edited-model',reasoningEffort:'low',context:{instruction:false,attachmentIds:[],logIds:[]}});
 const before=h.state.liveStore.exportData(),signature=before.agentRequests[0].requestSignature;assert.match(signature,/^[a-f0-9]{64}$/);
 const retry=await followupApi(h,'create',input);assert.equal(retry.request.prompt,'Edited in the UI');assert.equal(retry.request.model,'edited-model');assert.equal(retry.request.requiredResult,'Edited prerequisite');assert.equal(retry.reused,true);
 await assert.rejects(followupApi(h,'create',{...input,prompt:'Altered original retry'}),{code:'REQUEST_ID_CONFLICT'});
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.agentStarts.length,0);assert.equal(h.state.agentPreflights.length,0);
 const reopened=await harness(t,{prepare({dataPath}){fs.mkdirSync(dataPath,{recursive:true});const store=createStore({dbPath:path.join(dataPath,'reviewops.sqlite')});try{store.importData(before);}finally{store.close();}}});
 reopened.state.failures.get='before';const persisted=await followupApi(reopened,'create',input);
 assert.equal(persisted.requestId,first.requestId);assert.equal(persisted.request.prompt,'Edited in the UI');assert.equal(persisted.reused,true);
 assert.equal(reopened.state.liveStore.exportData().agentRequests[0].requestSignature,signature);assert.equal(reopened.state.agentStarts.length,0);
});

test('public follow-up scope permits sibling-review predecessors and rejects foreign IDs before mutation',async t=>{
 const h=await harness(t),{group,service,project,review}=await seed(h);
 const sibling=await h.success('review.save',{projectId:project.id,serviceId:service.id,title:'Sibling review'}),otherProject=await h.success('project.save',{groupId:group.id,name:'Other project',serviceIds:[service.id]}),foreign=await h.success('review.save',{projectId:otherProject.id,serviceId:service.id,title:'Foreign review'});
 const previous=h.state.liveStore.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'Previous',status:'running',workPath:'/tmp/test'}),foreignRun=h.state.liveStore.saveAgentRun({reviewId:foreign.id,serviceId:service.id,prompt:'Private foreign work',status:'running',workPath:'/tmp/test'});
 const input={projectId:project.id,reviewId:sibling.id,requestId:'scoped-public',prompt:'Saved only',predecessorId:previous.id};
 const made=await followupApi(h,'create',input);assert.equal(made.request.predecessorReviewId,review.id);assert.equal(made.request.predecessorStatus,'running');assert.equal(made.request.state,'waiting');
 const baseline=h.state.liveStore.exportData();
 for(const action of ['create','list','get','cancel'])await assert.rejects(followupApi(h,action,{projectId:otherProject.id,reviewId:sibling.id,...(action==='list'?{}:{requestId:input.requestId}),...(action==='create'?{prompt:input.prompt}:{})}),{code:'TARGET_MISMATCH'});
 for(const action of ['get','cancel'])await assert.rejects(followupApi(h,action,{projectId:project.id,reviewId:review.id,requestId:input.requestId}),{code:'TARGET_MISMATCH'});
 await assert.rejects(followupApi(h,'create',{...input,requestId:'foreign-dependency',predecessorId:foreignRun.id}),{code:'TARGET_MISMATCH'});
 await assert.rejects(followupApi(h,'create',{...input,reviewId:review.id}),{code:'REQUEST_ID_CONFLICT'});
 await assert.rejects(followupApi(h,'create',{projectId:otherProject.id,reviewId:foreign.id,requestId:input.requestId,prompt:input.prompt}),{code:'REQUEST_ID_CONFLICT'});
 await assert.rejects(followupApi(h,'create',{...input,requestId:previous.id}),{code:'REQUEST_ID_CONFLICT'});
 assert.deepEqual(h.state.liveStore.exportData(),baseline);assert.equal(h.state.agentStarts.length,0);assert.deepEqual(h.state.agentCancelled,[]);
});

test('public follow-up readiness and cancellation never start or stop a run',async t=>{
 const h=await harness(t),{service,project,review}=await seed(h),previous=h.state.liveStore.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'Previous',status:'running',workPath:'/tmp/test'});
 const target={projectId:project.id,reviewId:review.id},input={...target,requestId:'cancel-waiting',prompt:'Wait without delivery',predecessorId:previous.id};
 const waiting=await followupApi(h,'create',input);assert.equal(waiting.request.state,'waiting');assert.equal(waiting.request.delivery,'not_sent');assert.equal(waiting.automaticStart,false);assert.equal(waiting.supportsLiveDelivery,false);
 assert.equal((await followupApi(h,'cancel',{...target,requestId:input.requestId})).request.state,'cancelled');
 assert.equal(h.state.liveStore.get('agent_runs',previous.id).status,'running');assert.deepEqual(h.state.agentCancelled,[]);
 const retried=await followupApi(h,'create',input);assert.equal(retried.request.state,'cancelled');assert.equal(retried.request.delivery,'not_sent');assert.equal(retried.reused,true);
 const next=await followupApi(h,'create',{...input,requestId:'become-ready',prompt:'Review after completion'});
 h.state.liveStore.saveAgentRun({id:previous.id,status:'completed'});
 const ready=await followupApi(h,'get',{...target,requestId:next.requestId});assert.equal(ready.request.state,'ready');assert.equal(ready.request.delivery,'not_sent');assert.equal(ready.request.runId,null);
 const listed=await followupApi(h,'list',target);assert.equal(listed.requests.length,2);assert.equal(h.state.agentStarts.length,0);assert.equal(h.state.agentPreflights.length,0);assert.deepEqual(h.state.agentCancelled,[]);
});

test('public follow-up manual-run links and cancellation races retain separate run ownership',async t=>{
 const h=await harness(t),{service,project,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 const input={projectId:project.id,reviewId:review.id,requestId:'manual-public',prompt:'Explicit unit-fixture start only',model:'fixture-model'};
 const saved=await followupApi(h,'create',input);assert.equal(h.state.agentStarts.length,0);
 let release;h.state.preflightGate=new Promise(resolve=>{release=resolve;});
 const manual=h.success('agent.request.start',{id:saved.requestId});
 let cancellation;
 try{await waitForValue(()=>h.state.agentPreflights.length===1,'The explicit synthetic start did not reach preflight');cancellation=followupApi(h,'cancel',{projectId:project.id,reviewId:review.id,requestId:saved.requestId});}
 finally{release();}
 const run=await manual;await assert.rejects(cancellation,/시작된 요청/);
 const running=await followupApi(h,'get',{projectId:project.id,reviewId:review.id,requestId:saved.requestId});assert.equal(running.request.runId,run.id);assert.equal(running.request.state,'running');assert.equal(running.request.delivery,'submitted');assert.deepEqual(h.state.agentCancelled,[]);
 assert.equal((await followupApi(h,'create',input)).request.runId,run.id);assert.equal(h.state.agentStarts.length,1);
 h.state.agentUpdate({id:run.id,kind:'agent',status:'completed',response:'Synthetic result',finishedAt:new Date().toISOString()});
 const finished=await followupApi(h,'get',{projectId:project.id,reviewId:review.id,requestId:saved.requestId});assert.equal(finished.request.state,'finished');assert.equal(finished.request.delivery,'submitted');assert.equal(finished.request.resolution,'pending');assert.equal(h.state.agentStarts.length,1);
});

test('public follow-up original retries survive missing predecessors and changed targets without rebinding',async t=>{
 const h=await harness(t),{service,project,review}=await seed(h),next=await h.success('review.save',{projectId:project.id,serviceId:service.id,title:'Retained follow-up'});
 const previous=h.state.liveStore.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'Previous',status:'completed',workPath:'/tmp/test'}),input={projectId:project.id,reviewId:next.id,requestId:'missing-predecessor-public',prompt:'Retain original request',predecessorId:previous.id};
 await followupApi(h,'create',input);const original=h.state.liveStore.exportData().agentRequests[0];
 await h.success('review.delete',{id:review.id});
 const missing=await followupApi(h,'create',input);assert.equal(missing.request.state,'waiting');assert.equal(missing.request.predecessorId,previous.id);assert.equal(missing.request.predecessorReviewId,null);assert.match(missing.request.reason,/찾을 수 없습니다/);
 await h.success('service.save',{id:service.id,agentBinary:'changed-fixture-binary'});
 const changed=await followupApi(h,'create',input);assert.equal(changed.request.state,'waiting');assert.match(changed.request.reason,/변경/);
 assert.equal(h.state.liveStore.exportData().agentRequests[0].targetKey,original.targetKey);assert.equal(h.state.liveStore.exportData().agentRequests[0].binary,original.binary);assert.equal(h.state.agentStarts.length,0);
});

test('public follow-ups retain global blockers without exposing foreign request content or private execution fields',async t=>{
 const h=await harness(t),{group,service,project,review}=await seed(h),other=await h.success('project.save',{groupId:group.id,name:'Conflicting project',serviceIds:[service.id]}),foreign=await h.success('review.save',{projectId:other.id,serviceId:service.id,title:'Other target'});
 await followupApi(h,'create',{projectId:other.id,reviewId:foreign.id,requestId:'foreign-public-blocker',prompt:'FOREIGN_PRIVATE_PROMPT'});
 h.state.failures.get='before';
 const local=await followupApi(h,'create',{projectId:project.id,reviewId:review.id,requestId:'blocked-public',prompt:'Local request'}),listed=await followupApi(h,'list',{projectId:project.id,reviewId:review.id});
 assert.equal(local.request.state,'waiting');assert.equal(local.request.blockingRequestId,null);assert.equal(listed.requests.length,1);
 for(const forbidden of ['FOREIGN_PRIVATE_PROMPT','foreign-public-blocker','targetKey','requestSignature','executionSettings','privateKeyPath','synthetic-old-password','example.test','tester','binary','context'])assert.ok(!JSON.stringify(listed).includes(forbidden),forbidden);
 assert.equal(h.state.agentStarts.length,0);
});

test('legacy unsigned follow-ups remain readable and cancellable but cannot claim an unknown original create identity',async t=>{
 const h=await harness(t),{project,review}=await seed(h),input={projectId:project.id,reviewId:review.id,requestId:'legacy-public',prompt:'Existing legacy request'};
 await followupApi(h,'create',input);h.state.liveStore.db.prepare('UPDATE agent_requests SET requestSignature=\'\' WHERE id=?').run(input.requestId);
 const baseline=h.state.liveStore.exportData();assert.equal((await followupApi(h,'get',{projectId:project.id,reviewId:review.id,requestId:input.requestId})).request.prompt,input.prompt);
 await assert.rejects(followupApi(h,'create',input),{code:'REQUEST_ID_CONFLICT'});assert.deepEqual(h.state.liveStore.exportData(),baseline);
 assert.equal((await followupApi(h,'cancel',{projectId:project.id,reviewId:review.id,requestId:input.requestId})).request.state,'cancelled');assert.equal(h.state.agentStarts.length,0);
});

test('public follow-up ownership is rechecked at serialized dispatch after IDs are restored',async t=>{
 for(const scenario of ['list','get','create-new','create-retry','cancel']){
  const h=await harness(t),{group,service,project,review}=await seed(h),other=await h.success('project.save',{groupId:group.id,name:'Restored destination',serviceIds:[service.id]}),input={projectId:project.id,reviewId:review.id,requestId:'restore-scope',prompt:'Original saved request'};
  if(scenario!=='create-new')await followupApi(h,'create',input);
  const restored=h.state.liveStore.exportData();restored.reviews.find(row=>row.id===review.id).projectId=other.id;
  const action=scenario.startsWith('create')?'create':scenario,barrier=scenario==='cancel'?'agent.request.cancel':scenario.startsWith('create')?'agent.request.add':'agent.request.list';
  let injected=false,afterRestore;
  const api=require('../electron/automation-api.cjs').createAutomationApi({dispatch:async(method,payload)=>{
   if(method===barrier&&!injected){injected=true;h.state.liveStore.importData(restored);afterRestore=h.state.liveStore.exportData();}
   return h.state.toolIntegration.dispatch(method,payload);
  }});
  await assert.rejects(api.handle('automation.followups.'+action,action==='list'?{projectId:project.id,reviewId:review.id}:action==='create'?input:{projectId:project.id,reviewId:review.id,requestId:input.requestId}),{code:'TARGET_MISMATCH'});
  assert.equal(injected,true,scenario);assert.deepEqual(h.state.liveStore.exportData(),afterRestore,scenario);assert.equal(h.state.agentStarts.length,0);assert.deepEqual(h.state.agentCancelled,[]);
  const currentTarget={projectId:other.id,reviewId:review.id,requestId:input.requestId};
  if(scenario==='create-new')assert.equal((await followupApi(h,'create',{...input,projectId:other.id})).requestId,input.requestId);
  else{
   assert.equal((await followupApi(h,'get',currentTarget)).request.prompt,input.prompt);
   if(scenario==='create-retry')await assert.rejects(followupApi(h,'create',{...input,projectId:other.id}),{code:'REQUEST_ID_CONFLICT'});
   if(scenario==='cancel')assert.equal((await followupApi(h,'cancel',currentTarget)).request.state,'cancelled');
  }
 }
});

// These cases exercise the actual registered IPC handler with owned fake windows
// and the production temporary Store. They launch no Electron, CLI or listener.
test('local shared read scopes main, project and QA windows without widening after release', async t => {
 const h=await harness(t),a=await seed(h),b=await seed(h),main=h.forWindow(h.state.primaryWindow);
 assert.deepEqual((await main.success('shared.projects.list')).projects.map(row=>row.id).sort(),[a.project.id,b.project.id].sort());
 await main.success('window.openProject',{projectId:a.project.id});const client=h.forWindow(await projectHost(h,a.project.id));
 assert.deepEqual((await client.success('shared.projects.list')).projects.map(row=>row.id),[a.project.id]);
 assert.equal((await client.success('shared.reviews.get',{projectId:a.project.id,reviewId:a.review.id})).review.id,a.review.id);
 assert.deepEqual((await client.success('shared.reviews.list',{projectId:a.project.id})).reviews.map(row=>row.id),[a.review.id]);
 const expected={code:'NOT_FOUND',message:'Shared resource not found.'};
 for(const payload of [{projectId:b.project.id,reviewId:b.review.id},{projectId:a.project.id,reviewId:b.review.id},{projectId:a.project.id,reviewId:'absent'}]){
  const result=await client.invoke('shared.reviews.get',payload);assert.equal(result.ok,false);assert.deepEqual({code:result.error.code,message:result.error.message},expected);
 }
 const qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'local-shared-scope'});
 try{assert.deepEqual((await client.success('shared.projects.list')).projects.map(row=>row.id),[a.project.id]);}
 finally{await h.state.toolIntegration.automationHandler('automation.qa.release',qa);}
 assert.deepEqual((await client.success('shared.projects.list')).projects.map(row=>row.id),[a.project.id]);
 assert.equal((await main.success('shared.projects.list')).projects.length,2);
 assert.equal((await client.success('snapshot')).projects.length,2,'Existing full local snapshot keeps its previous contract');
});

test('local shared read takes one current snapshot and has no mutation or presentation effects', async t => {
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow),store=h.state.liveStore;
 const before=store.exportData(),messages=h.state.windowMessages.length,windows=h.state.windows.length;
 const snapshot=store.snapshot.bind(store);let calls=0;store.snapshot=()=>{calls++;return snapshot();};
 let result;try{result=await main.success('shared.reviews.get',{projectId:a.project.id,reviewId:a.review.id});}finally{store.snapshot=snapshot;}
 assert.equal(calls,1);assert.equal(result.version,1);assert.deepEqual(Object.keys(result.review).sort(),['body','category','createdAt','id','number','priority','projectId','status','title','updatedAt']);
 assert.equal(JSON.stringify(result).includes('privateKeyPath'),false);assert.equal(JSON.stringify(result).includes('connection'),false);
 assert.deepEqual(store.exportData(),before);assert.equal(h.state.windowMessages.length,messages);assert.equal(h.state.windows.length,windows);
 assert.equal(h.state.agentStarts?.length||0,0);assert.equal(h.state.clipboardWrites?.length||0,0);
 const invalid=await main.invoke('shared.projects.list',{projectGrants:[{projectId:a.project.id,read:true}]});assert.equal(invalid.ok,false);assert.equal(invalid.error.code,'INVALID_QUERY');
 assert.equal((await main.success('shared.projects.list')).projects.length,1,'A rejected read must not poison the shared action queue');
});

test('local shared read rejects foreign frames and external integration dispatch', async t => {
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow),host=h.state.primaryWindow;
 for(const event of [{},{sender:host.webContents,senderFrame:{url:host.webContents.mainFrame.url}}]){
  const result=await h.invoke('shared.reviews.get',{projectId:a.project.id,reviewId:a.review.id},event);assert.equal(result.ok,false);
 }
 const url=host.webContents.mainFrame.url;host.webContents.mainFrame.url='https://foreign.invalid/';
 try{assert.equal((await main.invoke('shared.projects.list')).ok,false);}finally{host.webContents.mainFrame.url=url;}
 await assert.rejects(h.state.toolIntegration.dispatch('shared.projects.list',{}),/지원하지 않는 기능/);
 await assert.rejects(h.state.toolIntegration.automationHandler('automation.shared.projects.list',{}),{code:'UNKNOWN_ACTION'});
 assert.equal((await main.success('shared.projects.list')).projects.length,1);
});

test('local shared read never adopts a replacement or focused window after queued owner closure', async t => {
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('window.openProject',{projectId:a.project.id});const oldHost=await projectHost(h,a.project.id),client=h.forWindow(oldHost);
 let unblock;h.state.environmentGate=new Promise(resolve=>unblock=resolve);
 const probe=main.invoke('agent.environment',{serviceId:a.service.id});await waitForValue(()=>h.state.environmentCheck,'Queue blocker did not start');
 const pending=client.invoke('shared.projects.list');
 try{
  oldHost.destroy();await main.success('window.openProject',{projectId:a.project.id});const replacement=await projectHost(h,a.project.id);assert.notEqual(replacement,oldHost);
  h.state.focusedWindow=replacement;unblock();await probe;
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'ACCESS_DENIED');
  assert.deepEqual((await h.forWindow(replacement).success('shared.projects.list')).projects.map(row=>row.id),[a.project.id]);
 }finally{unblock();await probe;}
});

test('local shared read rechecks the original trusted frame after a queued wait', async t => {
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('window.openProject',{projectId:a.project.id});const host=await projectHost(h,a.project.id),client=h.forWindow(host),url=host.webContents.mainFrame.url;
 let unblock;h.state.environmentGate=new Promise(resolve=>unblock=resolve);
 const probe=main.invoke('agent.environment',{serviceId:a.service.id});await waitForValue(()=>h.state.environmentCheck,'Queue blocker did not start');
 const pending=client.invoke('shared.projects.list');
 try{host.webContents.mainFrame.url='https://foreign.invalid/';unblock();await probe;const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'ACCESS_DENIED');}
 finally{host.webContents.mainFrame.url=url;unblock();await probe;}
});

test('local shared read observes queued deletion and never returns a stale bound draft', async t => {
 const h=await harness(t),a=await seed(h),b=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('window.openProject',{projectId:a.project.id});const client=h.forWindow(await projectHost(h,a.project.id));
 let unblock;h.state.environmentGate=new Promise(resolve=>unblock=resolve);
 const probe=main.invoke('agent.environment',{serviceId:a.service.id});await waitForValue(()=>h.state.environmentCheck,'Queue blocker did not start');
 const removeReview=main.invoke('review.delete',{id:a.review.id}),removeProject=main.invoke('project.delete',{id:a.project.id});
 const pending=client.invoke('shared.projects.list');
 try{
  unblock();await probe;assert.equal((await removeReview).ok,true);assert.equal((await removeProject).ok,true);
  const result=await pending;assert.equal(result.ok,true);assert.deepEqual(result.data.projects,[]);
  assert.equal((await client.invoke('shared.reviews.get',{projectId:a.project.id,reviewId:a.review.id})).error.code,'NOT_FOUND');
  assert.deepEqual((await main.success('shared.projects.list')).projects.map(row=>row.id),[b.project.id]);
 }finally{unblock();await probe;}
});

test('local shared read observes the completed restore rather than its pre-queue snapshot', async t => {
 const h=await harness(t),empty=h.state.liveStore.exportData(),a=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('window.openProject',{projectId:a.project.id});const client=h.forWindow(await projectHost(h,a.project.id));
 const backup=path.join(h.root,'empty-shared-read.reviewops.json');fs.writeFileSync(backup,JSON.stringify({format:'reviewops-local-backup',version:1,data:empty,files:{}}));h.state.openResult={canceled:false,filePaths:[backup]};
 let unblock;h.state.environmentGate=new Promise(resolve=>unblock=resolve);
 const probe=main.invoke('agent.environment',{serviceId:a.service.id});await waitForValue(()=>h.state.environmentCheck,'Queue blocker did not start');
 const restore=main.invoke('backup.import'),pending=client.invoke('shared.projects.list');
 try{
  unblock();await probe;assert.equal((await restore).ok,true);const result=await pending;assert.equal(result.ok,true);assert.deepEqual(result.data.projects,[]);
  assert.equal((await client.invoke('shared.reviews.get',{projectId:a.project.id,reviewId:a.review.id})).error.code,'NOT_FOUND');
  assert.deepEqual((await main.success('shared.projects.list')).projects,[]);
 }finally{unblock();await probe;}
});

test('local shared read remains project-bound when QA is released before queued execution', async t => {
 const h=await harness(t),a=await seed(h),b=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('window.openProject',{projectId:a.project.id});const client=h.forWindow(await projectHost(h,a.project.id));
 const qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'local-shared-queued-release'});
 let unblock;h.state.environmentGate=new Promise(resolve=>unblock=resolve);
 const probe=main.invoke('agent.environment',{serviceId:a.service.id});await waitForValue(()=>h.state.environmentCheck,'Queue blocker did not start');
 const pending=client.invoke('shared.reviews.get',{projectId:b.project.id,reviewId:b.review.id});let released=false;
 try{
  await h.state.toolIntegration.automationHandler('automation.qa.release',qa);released=true;unblock();await probe;
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'NOT_FOUND');
  assert.deepEqual((await client.success('shared.projects.list')).projects.map(row=>row.id),[a.project.id]);
 }finally{unblock();await probe;if(!released)await h.state.toolIntegration.automationHandler('automation.qa.release',qa);}
});

test('local shared comments use one production snapshot without writes or presentation effects', async t => {
 const h=await harness(t),a=await seed(h),b=await seed(h),main=h.forWindow(h.state.primaryWindow),store=h.state.liveStore;
 const first=store.addActivity({reviewId:a.review.id,body:'Shared human comment',evidence:{note:'PRIVATE_COMMENT_EVIDENCE'}});
 const empty=store.addActivity({reviewId:a.review.id,body:'',allowEmpty:true});
 store.addActivity({reviewId:a.review.id,body:'PRIVATE_SYSTEM_COMMENT',role:'system'});
 store.addActivity({reviewId:b.review.id,body:'PRIVATE_OTHER_PROJECT'});
 const run=store.saveAgentRun({reviewId:a.review.id,serviceId:a.service.id,workPath:a.service.rootPath,status:'completed',response:'PRIVATE_AGENT_RESPONSE'});
 store.addActivity({reviewId:a.review.id,body:'PRIVATE_AGENT_PROMPT',role:'user',agentRunId:run.id});
 const linked=store.snapshot().activities.filter(row=>row.agentRunId===run.id);
 assert.deepEqual(linked.map(row=>[row.role,row.body]),[['agent','PRIVATE_AGENT_RESPONSE'],['user','PRIVATE_AGENT_PROMPT']]);
 const before=store.exportData(),revisions=store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all(),receipts=store.db.prepare('SELECT * FROM command_receipts').all();
 const messages=h.state.windowMessages.length,windows=h.state.windows.length,snapshot=store.snapshot.bind(store);let calls=0;
 store.snapshot=()=>{calls++;return snapshot();};
 let result;try{result=await main.success('shared.comments.list',{projectId:a.project.id,reviewId:a.review.id});}finally{store.snapshot=snapshot;}
 assert.equal(calls,1);assert.equal(result.version,1);
 assert.deepEqual(result.comments,[first,empty].map(row=>({id:row.id,reviewId:row.reviewId,body:row.body,createdAt:row.createdAt,updatedAt:row.updatedAt})));
 assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
 assert.deepEqual(store.exportData(),before);assert.deepEqual(store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all(),revisions);assert.deepEqual(store.db.prepare('SELECT * FROM command_receipts').all(),receipts);
 assert.equal(h.state.windowMessages.length,messages);assert.equal(h.state.windows.length,windows);assert.equal(h.state.agentStarts?.length||0,0);
 await main.success('window.openProject',{projectId:a.project.id});const client=h.forWindow(await projectHost(h,a.project.id));
 const expected={code:'NOT_FOUND',message:'Shared resource not found.'};
 for(const payload of [{projectId:b.project.id,reviewId:b.review.id},{projectId:a.project.id,reviewId:b.review.id},{projectId:a.project.id,reviewId:'missing'}]){
  const denied=await client.invoke('shared.comments.list',payload);assert.equal(denied.ok,false);assert.deepEqual({code:denied.error.code,message:denied.error.message},expected);
 }
 await assert.rejects(h.state.toolIntegration.dispatch('shared.comments.list',{projectId:a.project.id,reviewId:a.review.id}),/지원하지 않는 기능/);
 await assert.rejects(h.state.toolIntegration.automationHandler('automation.shared.comments.list',{}),{code:'UNKNOWN_ACTION'});
});

test('local shared comments recheck their original main frame after a queued wait', async t => {
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('window.openProject',{projectId:a.project.id});const host=await projectHost(h,a.project.id),client=h.forWindow(host),url=host.webContents.mainFrame.url;
 const unblock=await holdWriteAdmissionQueue(t,h,a.service.id);
 const pending=client.invoke('shared.comments.list',{projectId:a.project.id,reviewId:a.review.id});
 try{host.webContents.mainFrame.url='https://foreign.invalid/';await unblock();const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'ACCESS_DENIED');}
 finally{host.webContents.mainFrame.url=url;await unblock();await pending;}
});

test('local shared comments observe queued project deletion without widening the bound scope', async t => {
 const h=await harness(t),a=await seed(h),b=await seed(h),main=h.forWindow(h.state.primaryWindow);
 await main.success('window.openProject',{projectId:a.project.id});const client=h.forWindow(await projectHost(h,a.project.id));
 const unblock=await holdWriteAdmissionQueue(t,h,a.service.id);
 const removeReview=main.invoke('review.delete',{id:a.review.id}),removeProject=main.invoke('project.delete',{id:a.project.id});
 const pending=client.invoke('shared.comments.list',{projectId:a.project.id,reviewId:a.review.id});
 try{
  await unblock();assert.equal((await removeReview).ok,true);assert.equal((await removeProject).ok,true);
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'NOT_FOUND');
  assert.equal((await client.invoke('shared.comments.list',{projectId:b.project.id,reviewId:b.review.id})).error.code,'NOT_FOUND');
  assert.deepEqual((await main.success('shared.comments.list',{projectId:b.project.id,reviewId:b.review.id})).comments,[]);
 }finally{await unblock();await Promise.all([removeReview,removeProject,pending]);}
});


async function holdWriteAdmissionQueue(t, h, serviceId) {
  let release; h.state.environmentGate = new Promise(resolve => { release = resolve; });
  const blocker = h.forWindow(h.state.primaryWindow).invoke('agent.environment', {serviceId});
  t.after(async () => { release(); await blocker; });
  await waitForValue(() => h.state.environmentCheck, 'Owned action queue blocker did not start');
  return async () => { release(); assert.equal((await blocker).ok, true); };
}
function sameIDAdmissionBackup(h, reviewId) {
  const data = h.state.liveStore.exportData();
  data.reviews.find(row => row.id === reviewId).title = 'Restored same-ID title';
  const backup = path.join(h.root, 'same-id-admission.reviewops.json');
  fs.writeFileSync(backup, JSON.stringify({format:'reviewops-local-backup', version:1, data, files:{}}));
  return backup;
}

test('queued Store writes keep their original epoch across a same-ID restore', async t => {
  const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow);
  const activity = await main.success('activity.add', {reviewId:a.review.id, body:'Original activity'});
  h.state.openResult = {canceled:false, filePaths:[sameIDAdmissionBackup(h, a.review.id)]};
  const release = await holdWriteAdmissionQueue(t, h, a.service.id);
  const messages = h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length;
  const restore = main.invoke('backup.import');
  const edits = [
    main.invoke('review.save', {id:a.review.id, title:'Queued obsolete title', epoch:'renderer-upgrade', admission:{}}),
    main.invoke('activity.update', {id:activity.id, body:'Queued obsolete activity'}),
    main.invoke('settings.save', {theme:'dark'})
  ];
  await release(); assert.equal((await restore).ok, true);
  for (const result of await Promise.all(edits)) { assert.equal(result.ok, false); assert.equal(result.error.code, 'STALE_EPOCH'); }
  assert.equal(h.state.liveStore.get('reviews', a.review.id).title, 'Restored same-ID title');
  assert.equal(h.state.liveStore.get('activities', activity.id).body, 'Original activity');
  assert.equal(h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length, messages + 1, 'Only the committed restore notifies');
  assert.equal((await main.success('review.save', {id:a.review.id, title:'Fresh intended title'})).title, 'Fresh intended title');
});

for (const outcome of ['cancelled', 'invalid']) {
  test(`a ${outcome} queued import leaves an earlier write admission usable`, async t => {
    const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow);
    if (outcome === 'cancelled') h.state.openResult = {canceled:true, filePaths:[]};
    else {
      const file = path.join(h.root, 'invalid-admission-backup.json'); fs.writeFileSync(file, '{');
      h.state.openResult = {canceled:false, filePaths:[file]};
    }
    const release = await holdWriteAdmissionQueue(t, h, a.service.id);
    const restore = main.invoke('backup.import'), edit = main.invoke('review.save', {id:a.review.id, title:'Same-epoch queued edit'});
    await release(); const result = await restore;
    assert.equal(result.ok, outcome === 'cancelled');
    if (outcome === 'cancelled') assert.equal(result.data.cancelled, true);
    assert.equal((await edit).ok, true);
    assert.equal(h.state.liveStore.get('reviews', a.review.id).title, 'Same-epoch queued edit');
  });
}

test('a queued Store write rechecks its original main-frame owner before execution', async t => {
  const h = await harness(t), a = await seed(h), host = h.state.primaryWindow, main = h.forWindow(host);
  const release = await holdWriteAdmissionQueue(t, h, a.service.id);
  const edit = main.invoke('review.save', {id:a.review.id, title:'Untrusted queued edit'}), url = host.webContents.mainFrame.url;
  host.webContents.mainFrame.url = 'https://foreign.invalid/';
  try {
    await release(); const result = await edit;
    assert.equal(result.ok, false); assert.equal(result.error.code, 'ACCESS_DENIED');
    assert.notEqual(h.state.liveStore.get('reviews', a.review.id).title, 'Untrusted queued edit');
  } finally { host.webContents.mainFrame.url = url; }
});

test('queued Store writes cannot retain a released QA scope as an upgraded grant', async t => {
  const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow);
  await main.success('window.openProject', {projectId:a.project.id});
  const client = h.forWindow(await projectHost(h, a.project.id));
  const qa = await h.state.toolIntegration.automationHandler('automation.qa.open', {projectId:a.project.id, clientId:'write-admission-scope'});
  const release = await holdWriteAdmissionQueue(t, h, a.service.id);
  const edit = client.invoke('review.save', {id:a.review.id, title:'Obsolete QA admission'});
  await h.state.toolIntegration.automationHandler('automation.qa.release', qa);
  await release(); const result = await edit;
  assert.equal(result.ok, false); assert.equal(result.error.code, 'TARGET_MISMATCH');
  assert.notEqual(h.state.liveStore.get('reviews', a.review.id).title, 'Obsolete QA admission');
});

test('one integration dispatch keeps its original queue admission across restore', async t => {
  const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow);
  h.state.openResult = {canceled:false, filePaths:[sameIDAdmissionBackup(h, a.review.id)]};
  const release = await holdWriteAdmissionQueue(t, h, a.service.id), restore = main.invoke('backup.import');
  const pending = h.state.toolIntegration.dispatch('review.save', {id:a.review.id, title:'Obsolete integration dispatch'})
    .then(data => ({ok:true, data}), error => ({ok:false, error}));
  await release(); assert.equal((await restore).ok, true); const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.error.code, 'STALE_EPOCH');
  assert.equal(h.state.liveStore.get('reviews', a.review.id).title, 'Restored same-ID title');
});


const ownedAgentInput=(review,id)=>({requestId:id,reviewId:review.id,prompt:'Owned asynchronous fixture',context:{instruction:false,attachmentIds:[],logIds:[]}});
async function holdOwnedPreflight(t,h,payload) {
 let release;h.state.preflightGate=new Promise(resolve=>{release=resolve;});
 const pending=h.invoke('agent.start',payload);t.after(()=>release());
 await waitForValue(()=>h.state.agentPreflights.length===1,'Original synthetic preflight did not start');
 return {pending,release};
}

test('an agent preflight retains its original epoch through a same-ID Store import',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const backup=h.state.liveStore.exportData(),held=await holdOwnedPreflight(t,h,ownedAgentInput(a.review,'old-preflight-epoch'));
 h.state.liveStore.importData(backup);const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 held.release();const result=await held.pending;
 assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_EPOCH');assert.equal(h.state.agentStarts.length,0);
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);
});

test('a failed Store import does not invalidate an original delayed agent launch',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const held=await holdOwnedPreflight(t,h,ownedAgentInput(a.review,'failed-import-preflight'));
 const invalid=h.state.liveStore.exportData();invalid.reviews[0].projectId='missing';
 assert.throws(()=>h.state.liveStore.importData(invalid));held.release();
 const result=await held.pending;assert.equal(result.ok,true);assert.equal(h.state.agentStarts.length,1);
 assert.equal(h.state.liveStore.get('agent_runs',result.data.id).prompt,'Owned asynchronous fixture');
});

test('an agent launch rechecks its original window after preflight without adopting another window',async t=>{
 const h=await harness(t),a=await seed(h),host=h.state.primaryWindow;await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const held=await holdOwnedPreflight(t,h,ownedAgentInput(a.review,'closed-preflight-owner'));
 host.destroy();held.release();const result=await held.pending;
 assert.equal(result.ok,false);assert.equal(result.error.code,'ACCESS_DENIED');assert.equal(h.state.agentStarts.length,0);
 assert.deepEqual(h.state.liveStore.listAgentRuns(),[]);
});

test('a same-epoch running agent can persist after its original project window closes',async t=>{
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);await main.success('service.save',{id:a.service.id,agentEnabled:1});
 await main.success('window.openProject',{projectId:a.project.id});const host=await projectHost(h,a.project.id),client=h.forWindow(host);
 const run=await client.success('agent.start',ownedAgentInput(a.review,'closed-running-window'));
 const callback=h.state.agentCallbacks.get(run.id);assert.equal(typeof callback,'function');host.destroy();
 callback({id:run.id,kind:'agent',status:'completed',response:'Ordinary completion after window closure',finishedAt:new Date().toISOString()});
 assert.equal(h.state.liveStore.get('agent_runs',run.id).response,'Ordinary completion after window closure');
 assert.equal(h.state.liveStore.snapshot().activities.filter(row=>row.agentRunId===run.id&&row.role==='agent').length,1);
});

test('an old manager callback cannot persist into or remove a new same-ID job after restore',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const backup=path.join(h.root,'callback-owner.reviewops.json');fs.writeFileSync(backup,JSON.stringify({format:'reviewops-local-backup',version:1,data:h.state.liveStore.exportData(),files:{}}));
 const payload=ownedAgentInput(a.review,'reused-manager-job'),old=await h.success('agent.start',payload),oldCallback=h.state.agentCallbacks.get(old.id);
 oldCallback({id:old.id,kind:'agent',status:'completed',response:'Old completed graph',finishedAt:new Date().toISOString()});
 h.state.openResult={canceled:false,filePaths:[backup]};assert.equal((await h.success('backup.import')).imported,true);
 const fresh=await h.success('agent.start',{...payload,prompt:'Fresh intended job'}),freshCallback=h.state.agentCallbacks.get(fresh.id);
 const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 oldCallback({id:old.id,kind:'agent',status:'completed',response:'Late obsolete response',finishedAt:new Date().toISOString()});
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);
 assert.equal((await h.success('snapshot')).agentRunning,1);
 const refused=await h.invoke('backup.import');assert.equal(refused.ok,false);assert.match(refused.error.message,/진행 중인 SSH 또는 에이전트/);
 freshCallback({id:fresh.id,kind:'agent',status:'completed',response:'New owner completion',finishedAt:new Date().toISOString()});
 assert.equal(h.state.liveStore.get('agent_runs',fresh.id).response,'New owner completion');assert.equal((await h.success('snapshot')).agentRunning,0);
});

test('callback persistence asserts original epoch and progress in the same rollback-capable transaction',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const run=await h.success('agent.start',ownedAgentInput(a.review,'atomic-owned-callback')),callback=h.state.agentCallbacks.get(run.id),before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 const save=h.state.liveStore.saveAgentRun;
 h.state.liveStore.saveAgentRun=function(input){assert.equal(this.inTransaction,true);save.call(this,input);throw new Error('Injected final owner write failure');};
 assert.throws(()=>callback({id:run.id,kind:'agent',status:'running',response:'Uncommitted progress'}),/Injected final owner/);
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);
 h.state.liveStore.saveAgentRun=save;callback({id:run.id,kind:'agent',status:'completed',response:'Committed progress',finishedAt:new Date().toISOString()});
 assert.equal(h.state.liveStore.get('agent_runs',run.id).response,'Committed progress');
});

test('callback target membership is rechecked without granting a moved review',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const other=await h.success('project.save',{groupId:a.group.id,name:'Other owner',serviceIds:[a.service.id]}),run=await h.success('agent.start',ownedAgentInput(a.review,'moved-callback-review')),callback=h.state.agentCallbacks.get(run.id);
 h.state.liveStore.db.prepare('UPDATE reviews SET projectId=? WHERE id=?').run(other.id,a.review.id);const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 callback({id:run.id,kind:'agent',status:'completed',response:'Wrong project completion',finishedAt:new Date().toISOString()});
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);assert.equal((await h.success('snapshot')).agentRunning,0);
});

test('post-import interruption uses a new maintenance admission while old callbacks remain stale',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const run=await h.success('agent.start',ownedAgentInput(a.review,'maintenance-owned-run')),callback=h.state.agentCallbacks.get(run.id),data=h.state.liveStore.exportData();
 callback({id:run.id,kind:'agent',status:'completed',response:'Original epoch complete',finishedAt:new Date().toISOString()});
 const backup=path.join(h.root,'maintenance-owner.reviewops.json');fs.writeFileSync(backup,JSON.stringify({format:'reviewops-local-backup',version:1,data,files:{}}));h.state.openResult={canceled:false,filePaths:[backup]};
 h.state.agentCloseGate=async()=>callback({id:run.id,kind:'agent',status:'completed',response:'Stale closeAll callback',finishedAt:new Date().toISOString()});
 assert.equal((await h.success('backup.import')).imported,true);
 const restored=h.state.liveStore.get('agent_runs',run.id);assert.equal(restored.status,'interrupted');assert.equal(restored.response,'');assert.equal(h.state.liveStore.snapshot().activities.some(row=>row.body==='Stale closeAll callback'),false);
});


test('a delayed agent launch cannot adopt a review moved to another project',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const other=await h.success('project.save',{groupId:a.group.id,name:'Other launch owner',serviceIds:[a.service.id]}),held=await holdOwnedPreflight(t,h,ownedAgentInput(a.review,'moved-preflight-review'));
 h.state.liveStore.db.prepare('UPDATE reviews SET projectId=? WHERE id=?').run(other.id,a.review.id);held.release();const result=await held.pending;
 assert.equal(result.ok,false);assert.match(result.error.message,/검사 중 프로젝트 설정이 변경/);assert.equal(h.state.agentStarts.length,0);assert.deepEqual(h.state.liveStore.listAgentRuns(),[]);
});


test('a same-manager callback keeps its old epoch instead of adopting restored same-ID rows',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const run=await h.success('agent.start',ownedAgentInput(a.review,'same-manager-restored-row')),callback=h.state.agentCallbacks.get(run.id),backup=h.state.liveStore.exportData();
 h.state.liveStore.importData(backup);const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 callback({id:run.id,kind:'agent',status:'completed',response:'Obsolete epoch callback',finishedAt:new Date().toISOString()});
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);assert.equal(h.state.liveStore.get('agent_runs',run.id).status,'running');
});

test('a preflight launch cannot retain a released QA scope as a new grant',async t=>{
 const h=await harness(t),a=await seed(h),main=h.forWindow(h.state.primaryWindow);await main.success('service.save',{id:a.service.id,agentEnabled:1});
 const qa=await h.state.toolIntegration.automationHandler('automation.qa.open',{projectId:a.project.id,clientId:'owned-preflight-qa-release'}),host=await projectHost(h,a.project.id),client=h.forWindow(host);
 let release;h.state.preflightGate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 const pending=client.invoke('agent.start',ownedAgentInput(a.review,'released-qa-preflight'));
 await waitForValue(()=>h.state.agentPreflights.length===1,'Original QA preflight did not start');
 await h.state.toolIntegration.automationHandler('automation.qa.release',qa);release();const result=await pending;
 assert.equal(result.ok,false);assert.equal(result.error.code,'TARGET_MISMATCH');assert.equal(h.state.agentStarts.length,0);assert.deepEqual(h.state.liveStore.listAgentRuns(),[]);
});


test('restore drops only the original cohort retained start-failure snapshot',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const backup=path.join(h.root,'failed-owner.reviewops.json');fs.writeFileSync(backup,JSON.stringify({format:'reviewops-local-backup',version:1,data:h.state.liveStore.exportData(),files:{}}));
 h.state.agentStartError=true;const failed=await h.success('agent.start',ownedAgentInput(a.review,'retained-failed-owner'));
 assert.equal(failed.status,'failed');assert.deepEqual(await h.success('agent.read',{id:failed.id}),failed);
 h.state.openResult={canceled:false,filePaths:[backup]};assert.equal((await h.success('backup.import')).imported,true);
 const missing=await h.invoke('agent.read',{id:failed.id});assert.equal(missing.ok,false);assert.equal(missing.error.code,'NOT_FOUND');
});


function recreateOwnedReview(store,id) {
 const original={...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(id)},before=store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(id).generation;
 store.deleteReview(id);store.upsert('reviews',original);
 assert(store.db.prepare('SELECT generation FROM review_revisions WHERE reviewId=?').get(id).generation>before);
 return original;
}

test('persisted terminal state is exposed without releasing a still-running original manager owner',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const run=await h.success('agent.start',ownedAgentInput(a.review,'persisted-terminal-winner')),callback=h.state.agentCallbacks.get(run.id);
 const winner=h.state.liveStore.saveAgentRun({...run,status:'cancelled',response:'Stored terminal winner',finishedAt:new Date().toISOString()});
 callback({id:run.id,kind:'agent',status:'running',response:'Obsolete running progress'});
 assert.deepEqual(await h.success('agent.read',{id:run.id}),winner);assert.deepEqual(h.state.liveStore.get('agent_runs',run.id),winner);
 assert.equal((await h.success('snapshot')).agentRunning,1,'The original source owner remains active');
 const metadataCount=(h.state.environmentChecks||[]).length,probe=await h.invoke('agent.environment',{serviceId:a.service.id});assert.equal(probe.ok,false);assert.match(probe.error.message,/에이전트 실행 또는 로그인/);assert.equal((h.state.environmentChecks||[]).length,metadataCount);
 const backup=path.join(h.root,'held-terminal-owner.reviewops.json');fs.writeFileSync(backup,JSON.stringify({format:'reviewops-local-backup',version:1,data:h.state.liveStore.exportData(),files:{}}));h.state.openResult={canceled:false,filePaths:[backup]};
 assert.match((await h.invoke('backup.import')).error.message,/진행 중인 SSH 또는 에이전트/);
 callback({id:run.id,kind:'agent',status:'failed',response:'Another conflicting final status',finishedAt:new Date().toISOString()});
 assert.deepEqual(await h.success('agent.read',{id:run.id}),winner);assert.equal((await h.success('snapshot')).agentRunning,0);
});

test('a microtask closing the launch window sees an already accepted original manager owner',async t=>{
 const h=await harness(t),a=await seed(h),host=h.state.primaryWindow;await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const add=h.state.liveStore.addActivity;h.state.liveStore.addActivity=function(input){const value=add.call(this,input);if(input.agentRunId==='microtask-close-owned-launch')queueMicrotask(()=>host.destroy());return value;};
 const result=await h.invoke('agent.start',ownedAgentInput(a.review,'microtask-close-owned-launch'));
 assert.equal(result.ok,true);assert.equal(host.isDestroyed(),true);assert.equal(h.state.agentStarts.length,1);
 const saved=h.state.liveStore.get('agent_runs',result.data.id);assert.equal(saved.status,'running');assert.equal(typeof h.state.agentCallbacks.get(saved.id),'function');
 h.state.agentCallbacks.get(saved.id)({id:saved.id,kind:'agent',status:'completed',response:'Accepted owner completed',finishedAt:new Date().toISOString()});
 assert.equal(h.state.liveStore.get('agent_runs',saved.id).response,'Accepted owner completed');
});

test('synchronous scope loss after recording a launch fails only that accepted run and keeps its files',async t=>{
 const h=await harness(t),a=await seed(h),host=h.state.primaryWindow;await h.success('service.save',{id:a.service.id,agentEnabled:1});const staged=await stageFile(h,'accepted-scope-loss.txt');
 const add=h.state.liveStore.addActivity;h.state.liveStore.addActivity=function(input){const value=add.call(this,input);if(input.agentRunId==='synchronous-scope-loss')host.destroy();return value;};
 const result=await h.invoke('agent.start',{...ownedAgentInput(a.review,'synchronous-scope-loss'),attachmentTokens:[staged.token]});
 assert.equal(result.ok,false);assert.equal(result.error.code,'ACCESS_DENIED');assert.match(result.error.message,/허용되지 않은 요청/);assert.equal(h.state.agentStarts.length,0);
 const saved=h.state.liveStore.get('agent_runs','synchronous-scope-loss');assert.equal(saved.status,'failed');assert.equal(saved.errorCode,'ACCESS_DENIED');
 const snapshot=h.state.liveStore.snapshot(),activity=snapshot.activities.find(row=>row.agentRunId===saved.id&&row.role==='user'),file=snapshot.attachments.find(row=>row.activityId===activity.id);
 assert(file);assert.equal(fs.readFileSync(path.join(h.dataPath,'attachments',file.storageName),'utf8'),'staged attachment content');
});

test('preflight cannot adopt a new same-ID review generation in the same epoch',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const held=await holdOwnedPreflight(t,h,ownedAgentInput(a.review,'recreated-preflight-review'));
 recreateOwnedReview(h.state.liveStore,a.review.id);const before=h.state.liveStore.exportData();held.release();const result=await held.pending;
 assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_REVIEW');assert.equal(h.state.agentStarts.length,0);assert.deepEqual(h.state.liveStore.exportData(),before);
});

test('an original callback cannot recreate a run in a new same-ID review generation',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const run=await h.success('agent.start',ownedAgentInput(a.review,'recreated-callback-review')),callback=h.state.agentCallbacks.get(run.id);
 recreateOwnedReview(h.state.liveStore,a.review.id);const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 callback({id:run.id,kind:'agent',status:'completed',response:'Obsolete prior birth',finishedAt:new Date().toISOString()});
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);assert.equal((await h.success('snapshot')).agentRunning,0);
});

test('an original callback cannot overwrite a distinct same-ID run in the same review birth',async t=>{
 for(const field of ['prompt','model']) {
  const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
  const run=await h.success('agent.start',ownedAgentInput(a.review,'replaced-agent-record')),callback=h.state.agentCallbacks.get(run.id);
  const replacement=field==='prompt'?{prompt:'Distinct replacement intent'}:{model:'different-model',executionSettings:require('../electron/agent-execution-settings.cjs').executionSettings(undefined,{model:'different-model',reasoningEffort:run.reasoningEffort})};
  h.state.liveStore.db.prepare('DELETE FROM agent_runs WHERE id=?').run(run.id);h.state.liveStore.saveAgentRun({...run,...replacement});const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
  callback({id:run.id,kind:'agent',status:'completed',response:'Old run output',finishedAt:new Date().toISOString()});assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);
 }
});

async function holdDetachedServiceCancellation(t,h,a,id) {
 await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const run=await h.success('agent.start',ownedAgentInput(a.review,id));
 await h.success('project.save',{id:a.project.id,serviceIds:[]});
 let release;const gate=new Promise(resolve=>{release=resolve;});h.state.agentCancelGate=()=>gate;t.after(()=>release());
 const pending=h.invoke('service.delete',{id:a.service.id});
 await waitForValue(()=>h.state.agentCancelled.includes(run.id),'Original service cancellation did not begin');
 return {run,pending,release};
}

test('detached service deletion waits for the original cancel promise and preserves its actual final outcome',async t=>{
 for(const status of ['cancelled','completed']) {
  const h=await harness(t),a=await seed(h);h.state.agentCancelFinal={status,response:'Actual original final event'};
  const held=await holdDetachedServiceCancellation(t,h,a,'detached-final-'+status);
  assert.equal(h.state.liveStore.get('agent_runs',held.run.id).status,'running');assert.equal(h.state.liveStore.get('services',a.service.id).id,a.service.id);
  held.release();const result=await held.pending;assert.equal(result.ok,true,result.error?.message);
  const history=await h.success('agent.read',{id:held.run.id});assert.equal(history.status,status);assert.equal(history.serviceId,null);assert.equal(history.response,'Actual original final event');assert.equal(history.prompt,held.run.prompt);
  assert.equal((await h.success('snapshot')).agentRunning,0);
 }
});

test('detached service cancellation cannot write or delete after a same-ID logical import',async t=>{
 const h=await harness(t),a=await seed(h),held=await holdDetachedServiceCancellation(t,h,a,'detached-import');
 h.state.liveStore.importData(h.state.liveStore.exportData());const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 held.release();const result=await held.pending;assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_EPOCH');
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);assert.equal(h.state.liveStore.get('services',a.service.id).id,a.service.id);
});

test('detached service cancellation cannot adopt a recreated review with the original IDs',async t=>{
 const h=await harness(t),a=await seed(h),held=await holdDetachedServiceCancellation(t,h,a,'detached-review-birth');
 recreateOwnedReview(h.state.liveStore,a.review.id);const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 held.release();const result=await held.pending;assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_REVIEW');
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);
});

test('detached service cancellation cannot overwrite or delete for a distinct same-ID run',async t=>{
 const h=await harness(t),a=await seed(h),held=await holdDetachedServiceCancellation(t,h,a,'detached-run-replacement');
 const raw={...h.state.liveStore.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(held.run.id)};
 h.state.liveStore.db.prepare('DELETE FROM agent_runs WHERE id=?').run(held.run.id);
 h.state.liveStore.upsert('agent_runs',{...raw,prompt:'Replacement execution intent',createdAt:'2026-11-03T00:00:00.000Z'});
 const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 held.release();const result=await held.pending;assert.equal(result.ok,false);assert.equal(result.error.code,'STALE_AGENT');
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);
});

test('detached service deletion rechecks its original window before maintaining status or deleting',async t=>{
 const h=await harness(t),a=await seed(h),held=await holdDetachedServiceCancellation(t,h,a,'detached-window-close');
 h.state.primaryWindow.destroy();const before=h.state.liveStore.exportData();held.release();const result=await held.pending;
 assert.equal(result.ok,false);assert.equal(result.error.code,'ACCESS_DENIED');assert.deepEqual(h.state.liveStore.exportData(),before);
});

test('unconfirmed detached cancellation stays held until its own late final without fabricating a status',async t=>{
 for(const rejected of [false,true]) {
  const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
  const run=await h.success('agent.start',ownedAgentInput(a.review,'detached-unconfirmed-'+rejected)),callback=h.state.agentCallbacks.get(run.id);
  await h.success('project.save',{id:a.project.id,serviceIds:[]});h.state.agentCancelWithoutFinal=true;h.state.agentCancelError=rejected;
  const before=h.state.liveStore.exportData(),result=await h.invoke('service.delete',{id:a.service.id});assert.equal(result.ok,false);
  if(rejected)assert.match(result.error.message,/synthetic agent cancel failure/);else assert.equal(result.error.code,'AGENT_CANCELLATION_UNCONFIRMED');
  const backup=path.join(h.root,'detached-cancel-probe.reviewops.json');fs.writeFileSync(backup,JSON.stringify({format:'reviewops-local-backup',version:1,data:before,files:{}}));
  h.state.openResult={canceled:false,filePaths:[backup]};const confirmations=h.state.messageCalls;
  assert.deepEqual(h.state.liveStore.exportData(),before);const blocked=await h.invoke('backup.import');assert.equal(blocked.ok,false);assert.match(blocked.error.message,/진행 중인 SSH 또는 에이전트/);assert.equal(h.state.messageCalls,confirmations,'Busy refusal must occur before restore confirmation');assert.deepEqual(h.state.liveStore.exportData(),before);
  callback({id:run.id,kind:'agent',status:'cancelled',finishedAt:new Date().toISOString()});assert.deepEqual(h.state.liveStore.exportData(),before,'A later strict callback cannot become detached maintenance');
  h.state.messageResponse=0;const cancelled=await h.success('backup.import');assert.deepEqual(cancelled,{cancelled:true},'The same valid selection reaches the restore confirmation after exact late-final release');assert.equal(h.state.messageCalls,confirmations+1);assert.deepEqual(h.state.liveStore.exportData(),before,'Cancelling confirmation must leave the graph unchanged');
 }
});

test('a service credential deletion failure preserves the confirmed original cancellation history',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const run=await h.success('agent.start',ownedAgentInput(a.review,'detached-vault-failure'));await h.success('project.save',{id:a.project.id,serviceIds:[]});
 h.state.failures.delete='after';const result=await h.invoke('service.delete',{id:a.service.id});assert.equal(result.ok,false);assert.match(result.error.message,/simulated vault delete/);
 assert.equal(h.state.liveStore.get('services',a.service.id).id,a.service.id);const history=await h.success('agent.read',{id:run.id});assert.equal(history.status,'cancelled');assert.equal(history.serviceId,a.service.id);
 assert.equal(h.state.realVault.get(a.service.id).password,'synthetic-old-password');assert.equal((await h.success('snapshot')).agentRunning,0);
});


test('an accepted original run keeps its own completion when the next selected service and notes change',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const next=await h.success('service.save',{groupId:a.group.id,name:'Next selected target',kind:'local',rootPath:h.root,agentEnabled:1});
 await h.success('project.save',{id:a.project.id,serviceIds:[a.service.id,next.id]});
 const run=await h.success('agent.start',ownedAgentInput(a.review,'original-service-completion')),callback=h.state.agentCallbacks.get(run.id);
 await h.success('review.save',{id:a.review.id,serviceId:next.id,body:'Current reviewer notes for the next execution'});const current={...h.state.liveStore.get('reviews',a.review.id)};
 callback({id:run.id,kind:'agent',status:'completed',response:'Original linked service completed',finishedAt:new Date().toISOString()});
 const latest=h.state.liveStore.get('reviews',a.review.id),{updatedAt:beforeUpdatedAt,...beforeFields}=current,{updatedAt:afterUpdatedAt,...afterFields}=latest;
 assert.deepEqual(afterFields,beforeFields);assert.equal(current.serviceId,next.id);
 const saved=h.state.liveStore.get('agent_runs',run.id);assert.equal(afterUpdatedAt,saved.updatedAt);assert.equal(saved.serviceId,a.service.id);assert.equal(saved.response,'Original linked service completed');assert.equal(saved.status,'completed');
 assert.equal(h.state.liveStore.snapshot().activities.filter(row=>row.agentRunId===run.id&&row.role==='agent').length,1);assert.equal((await h.success('snapshot')).agentRunning,0);
});

test('a selected-service change never lets an original callback write after its project service is unlinked',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const next=await h.success('service.save',{groupId:a.group.id,name:'Remaining selected target',kind:'local',rootPath:h.root,agentEnabled:1});
 await h.success('project.save',{id:a.project.id,serviceIds:[a.service.id,next.id]});
 const run=await h.success('agent.start',ownedAgentInput(a.review,'unlinked-original-completion')),callback=h.state.agentCallbacks.get(run.id);
 await h.success('review.save',{id:a.review.id,serviceId:next.id});h.state.liveStore.setProjectServices(a.project.id,[next.id]);const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;
 callback({id:run.id,kind:'agent',status:'completed',response:'Must not persist after unlink',finishedAt:new Date().toISOString()});
 assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);assert.equal((await h.success('snapshot')).agentRunning,0);
});


test('detached original service deletion preserves the next selected service and its running owner',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
 const next=await h.success('service.save',{groupId:a.group.id,name:'Next still-running target',kind:'local',rootPath:h.root,agentEnabled:1});
 await h.success('project.save',{id:a.project.id,serviceIds:[a.service.id,next.id]});
 const original=await h.success('agent.start',{...ownedAgentInput(a.review,'delete-original-P'),newConversation:true,independentExecution:true});
 await h.success('review.save',{id:a.review.id,serviceId:next.id,body:'Notes for the next selected service'});
 const active=await h.success('agent.start',{...ownedAgentInput(a.review,'retain-current-A'),newConversation:true,independentExecution:true}),callback=h.state.agentCallbacks.get(active.id);
 await h.success('project.save',{id:a.project.id,serviceIds:[next.id]});const current={...h.state.liveStore.get('reviews',a.review.id)};
 h.state.agentCancelFinal={status:'completed',response:'Confirmed original P outcome'};
 assert.equal((await h.success('service.delete',{id:a.service.id})).deleted,true);
 const history=await h.success('agent.read',{id:original.id});assert.equal(history.status,'completed');assert.equal(history.response,'Confirmed original P outcome');assert.equal(history.serviceId,null);
 const {updatedAt:beforeUpdatedAt,...beforeFields}=current,{updatedAt:afterUpdatedAt,...afterFields}=h.state.liveStore.get('reviews',a.review.id);assert.deepEqual(afterFields,beforeFields);assert.equal(afterUpdatedAt,history.updatedAt);
 assert.deepEqual(h.state.agentCancelled,[original.id]);assert.equal(h.state.agentStarts.length,2);assert.equal(h.state.agentCallbacks.get(active.id),callback);assert.equal((await h.success('snapshot')).agentRunning,1);
 assert.equal((await h.success('agent.read',{id:active.id})).status,'running');
 callback({id:active.id,kind:'agent',status:'running',response:'Original A owner still accepts progress'});assert.equal(h.state.liveStore.get('agent_runs',active.id).response,'Original A owner still accepts progress');
 callback({id:active.id,kind:'agent',status:'completed',response:'A original final',finishedAt:new Date().toISOString()});assert.equal((await h.success('snapshot')).agentRunning,0);
});

test('a different next selection cannot upgrade stale detached cancellation ownership',async t=>{
 for(const kind of ['restore','review-birth','run-replacement','project-move']){
  const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,agentEnabled:1});
  const next=await h.success('service.save',{groupId:a.group.id,name:'Next selected target',kind:'local',rootPath:h.root,agentEnabled:1});await h.success('project.save',{id:a.project.id,serviceIds:[a.service.id,next.id]});
  const original=await h.success('agent.start',ownedAgentInput(a.review,'detached-next-'+kind));await h.success('review.save',{id:a.review.id,serviceId:next.id,body:'Current next-service notes'});await h.success('project.save',{id:a.project.id,serviceIds:[next.id]});
  let release;const gate=new Promise(resolve=>{release=resolve;});h.state.agentCancelGate=()=>gate;const pending=h.invoke('service.delete',{id:a.service.id});
  try{
   await waitForValue(()=>h.state.agentCancelled.includes(original.id),'Original P cancellation did not begin');
   if(kind==='restore')h.state.liveStore.importData(h.state.liveStore.exportData());
   else if(kind==='review-birth')recreateOwnedReview(h.state.liveStore,a.review.id);
   else if(kind==='project-move'){const other=h.state.liveStore.saveProject({groupId:a.group.id,name:'Different project',serviceIds:[next.id]});h.state.liveStore.db.prepare('UPDATE reviews SET projectId=? WHERE id=?').run(other.id,a.review.id);}
   else {const raw={...h.state.liveStore.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(original.id)};h.state.liveStore.db.prepare('DELETE FROM agent_runs WHERE id=?').run(original.id);h.state.liveStore.upsert('agent_runs',{...raw,prompt:'Distinct replacement execution',createdAt:'2026-11-03T00:00:00.000Z'});}
   const before=h.state.liveStore.exportData(),messages=h.state.windowMessages.length;release();const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,kind==='restore'?'STALE_EPOCH':kind==='run-replacement'?'STALE_AGENT':'STALE_REVIEW');assert.deepEqual(h.state.liveStore.exportData(),before);assert.equal(h.state.windowMessages.length,messages);assert.equal(h.state.liveStore.get('services',a.service.id).id,a.service.id);
  }finally{release();await pending;}
 }
});

test('invalid optional discovery configuration keeps the existing custom-root bridge available', async t => {
  const h = await harness(t, { platform: 'linux', registryEnvironment: { XDG_CONFIG_HOME: 'relative-config' } });
  assert.ok(h.state.toolIntegration); assert.equal(h.state.toolIntegration.discoveryDirectory, undefined);
  assert.equal(h.state.toolIntegration.connectionInfo.dataPath, h.dataPath);
  const result = await h.state.toolIntegration.automationHandler('automation.projects.list', {});
  assert.ok(Array.isArray(result.projects));
  assert.ok(h.state.seasonWarnings.some(args => args[0] === 'Running-instance discovery is unavailable. Explicit connections remain available.'));
});
test('vetoed quit and failed agent drain retain the running-instance publication and bridge', async t => {
  const vetoed = await harness(t), host = vetoed.state.primaryWindow;
  host.on('close', event => event.preventDefault());
  vetoed.appEvents.emit('before-quit', { preventDefault() {} });
  await waitForValue(() => host.closeCalls, 'Quit did not reach the renderer veto');
  assert.deepEqual(vetoed.state.toolBridgeCalls || [], []);
  const failed = await harness(t); failed.state.primaryWindow.destroyed = true; failed.state.codexCloseError = true;
  failed.appEvents.emit('before-quit', { preventDefault() {} });
  await waitForValue(() => failed.state.windows.length > 1, 'Agent drain failure did not resume a window');
  assert.deepEqual(failed.state.toolBridgeCalls || [], []);
  assert.equal(failed.state.toolIntegrationClosed, undefined);
});
test('irreversible will-quit unregisters synchronously after bridge close starts without awaiting its drain', async t => {
  const h = await harness(t); let release;
  h.state.toolCloseGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  h.appEvents.emit('will-quit');
  assert.deepEqual(h.state.toolBridgeCalls, ['close', 'unregister']);
  assert.equal(h.state.toolIntegrationClosed, true);
  release();
});

test('local shared attachments project actual normalized Store metadata without writes or presentation effects', async t => {
  const h = await harness(t), a = await seed(h), b = await seed(h), main = h.forWindow(h.state.primaryWindow), store = h.state.liveStore;
  const user = store.addActivity({ reviewId: a.review.id, body: 'Ordinary user comment' });
  const system = store.addActivity({ reviewId: a.review.id, body: 'PRIVATE_SYSTEM_ROW', role: 'system' });
  const run = store.saveAgentRun({ reviewId: a.review.id, serviceId: a.service.id, workPath: a.service.rootPath,
    status: 'completed', response: 'PRIVATE_AGENT_RESPONSE' });
  const prompt = store.addActivity({ reviewId: a.review.id, body: 'PRIVATE_LINKED_USER_PROMPT', role: 'user', agentRunId: run.id });
  const response = store.snapshot().activities.find(row => row.agentRunId === run.id && row.role === 'agent');
  assert.ok(response); assert.equal(prompt.role, 'user'); assert.equal(prompt.agentRunId, run.id);
  const add = (id, reviewId, extra = {}) => store.addAttachment({ id, reviewId, name: id + '.txt',
    mimeType: 'text/plain', size: 0, storageName: 'PRIVATE-' + id + '.txt', sha256: 'F'.repeat(64), ...extra });
  const first = add('direct-z', a.review.id, { name: '  Actual report 한.txt  ', mimeType: ' text/plain ', size: '0' });
  const second = add('direct-a', a.review.id, { activityId: '', size: 1073741824, sha256: 'ab'.repeat(32) });
  for (const [id, activityId] of [['user-linked', user.id], ['system-linked', system.id], ['agent-linked', response.id], ['prompt-linked', prompt.id]])
    add(id, a.review.id, { activityId });
  const foreign = add('foreign-direct', b.review.id);
  assert.equal(first.activityId, null); assert.equal(second.activityId, null);
  assert.equal(first.name, 'Actual report 한.txt'); assert.equal(first.mimeType, 'text/plain'); assert.equal(first.size, 0);
  const stored = store.snapshot().attachments;
  assert.equal(stored.filter(row => row.reviewId === a.review.id && row.activityId === null).length, 2);
  assert.equal(stored.filter(row => row.reviewId === a.review.id && row.activityId !== null).length, 4);
  const expected = store.db.prepare('SELECT * FROM attachments WHERE reviewId=? AND activityId IS NULL ORDER BY createdAt,id').all(a.review.id).map(row =>
    ({ id: row.id, reviewId: row.reviewId, name: row.name, mimeType: row.mimeType, size: row.size,
      sha256: row.sha256, createdAt: row.createdAt, updatedAt: row.updatedAt }));
  await main.success('window.openProject', { projectId: a.project.id });
  const aHost = await projectHost(h, a.project.id), client = h.forWindow(aHost);
  await main.success('window.openProject', { projectId: b.project.id });
  const bHost = await projectHost(h, b.project.id); bHost.focus();
  const before = store.exportData(), revisions = store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all();
  const receipts = store.db.prepare('SELECT * FROM command_receipts').all(), messages = h.state.windowMessages.length;
  const windows = h.state.windows.map(host => ({ host, bounds: { ...host.bounds }, visible: host.visible, destroyed: host.destroyed }));
  const filesBefore = fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), snapshot = store.snapshot.bind(store); let calls = 0;
  store.snapshot = () => { calls++; return snapshot(); };
  let result;
  try { result = await client.success('shared.attachments.list', { projectId: a.project.id, reviewId: a.review.id }); }
  finally { store.snapshot = snapshot; }
  assert.equal(calls, 1);
  assert.deepEqual(result, { version: 1, projectId: a.project.id, reviewId: a.review.id, attachments: expected });
  assert.deepEqual(Object.keys(result.attachments[0]), ['id', 'reviewId', 'name', 'mimeType', 'size', 'sha256', 'createdAt', 'updatedAt']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  result.attachments[0].name = 'Caller-only.txt';
  assert.deepEqual((await client.success('shared.attachments.list', { projectId: a.project.id, reviewId: a.review.id })).attachments, expected);
  const invalid = await client.invoke('shared.attachments.list', { projectId: a.project.id, reviewId: a.review.id, projectGrants: [{ projectId: b.project.id, read: true }] });
  assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_QUERY');
  const notFound = { code: 'NOT_FOUND', message: 'Shared resource not found.' };
  for (const payload of [{ projectId: b.project.id, reviewId: b.review.id }, { projectId: a.project.id, reviewId: b.review.id },
    { projectId: a.project.id, reviewId: 'missing' }]) {
    const denied = await client.invoke('shared.attachments.list', payload);
    assert.equal(denied.ok, false); assert.deepEqual({ code: denied.error.code, message: denied.error.message }, notFound);
  }
  assert.deepEqual((await client.success('shared.attachments.list', { projectId: a.project.id, reviewId: a.review.id })).attachments, expected,
    'A rejected read must not poison the action queue');
  assert.equal((await main.success('shared.attachments.list', { projectId: b.project.id, reviewId: b.review.id })).attachments[0].id, foreign.id);
  await assert.rejects(h.state.toolIntegration.dispatch('shared.attachments.list', { projectId: a.project.id, reviewId: a.review.id }), /지원하지 않는 기능/);
  await assert.rejects(h.state.toolIntegration.automationHandler('automation.shared.attachments.list', {}), { code: 'UNKNOWN_ACTION' });
  assert.deepEqual(store.exportData(), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all(), revisions);
  assert.deepEqual(store.db.prepare('SELECT * FROM command_receipts').all(), receipts);
  assert.equal(h.state.windowMessages.length, messages); assert.equal(h.state.focusedWindow, bHost);
  assert.deepEqual(h.state.windows.map(host => ({ host, bounds: { ...host.bounds }, visible: host.visible, destroyed: host.destroyed })), windows);
  assert.deepEqual(fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), filesBefore);
  assert.equal(h.state.agentStarts.length, 0); assert.equal(h.state.clipboardWrites?.length || 0, 0);
});

test('local shared attachments recheck the original queued frame and never adopt a replacement window', async t => {
  for (const change of ['foreign-frame', 'closed-owner']) {
    const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow);
    await main.success('window.openProject', { projectId: a.project.id });
    const host = await projectHost(h, a.project.id), client = h.forWindow(host), url = host.webContents.mainFrame.url;
    const unblock = await holdWriteAdmissionQueue(t, h, a.service.id);
    const pending = client.invoke('shared.attachments.list', { projectId: a.project.id, reviewId: a.review.id });
    try {
      if (change === 'foreign-frame') host.webContents.mainFrame.url = 'https://foreign.invalid/';
      else {
        host.destroy(); await main.success('window.openProject', { projectId: a.project.id });
        const replacement = await projectHost(h, a.project.id); assert.notEqual(replacement, host); replacement.focus();
      }
      const before = h.state.liveStore.exportData(), messages = h.state.windowMessages.length;
      await unblock(); const result = await pending;
      assert.equal(result.ok, false, change); assert.equal(result.error.code, 'ACCESS_DENIED', change);
      assert.deepEqual(h.state.liveStore.exportData(), before); assert.equal(h.state.windowMessages.length, messages);
      if (change === 'closed-owner')
        assert.deepEqual((await h.forWindow(h.state.focusedWindow).success('shared.attachments.list', { projectId: a.project.id, reviewId: a.review.id })).attachments, []);
    } finally { host.webContents.mainFrame.url = url; await unblock(); await pending; }
  }
});

test('local shared attachments observe queued deletion without returning stale metadata or widening scope', async t => {
  const h = await harness(t), a = await seed(h), b = await seed(h), main = h.forWindow(h.state.primaryWindow);
  h.state.liveStore.addAttachment({ id: 'queued-direct', reviewId: a.review.id, name: 'Queued.txt', mimeType: 'text/plain',
    size: 0, storageName: 'PRIVATE-queued.txt', sha256: 'F'.repeat(64) });
  await main.success('window.openProject', { projectId: a.project.id });
  const client = h.forWindow(await projectHost(h, a.project.id));
  const unblock = await holdWriteAdmissionQueue(t, h, a.service.id);
  const removeReview = main.invoke('review.delete', { id: a.review.id }), removeProject = main.invoke('project.delete', { id: a.project.id });
  const pending = client.invoke('shared.attachments.list', { projectId: a.project.id, reviewId: a.review.id });
  try {
    await unblock(); assert.equal((await removeReview).ok, true); assert.equal((await removeProject).ok, true);
    const before = h.state.liveStore.exportData(), messages = h.state.windowMessages.length, result = await pending;
    assert.equal(result.ok, false); assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'NOT_FOUND', message: 'Shared resource not found.' });
    assert.equal((await client.invoke('shared.attachments.list', { projectId: b.project.id, reviewId: b.review.id })).error.code, 'NOT_FOUND');
    assert.deepEqual((await main.success('shared.attachments.list', { projectId: b.project.id, reviewId: b.review.id })).attachments, []);
    assert.deepEqual(h.state.liveStore.exportData(), before); assert.equal(h.state.windowMessages.length, messages);
  } finally { await unblock(); await Promise.all([removeReview, removeProject, pending]); }
});


test('version list refuses its replaced original main frame while queued', async t => {
  const reads = [], h = await harness(t, { versionListReadObserver: file => reads.push(file.id) });
  const a = await seed(h), main = h.forWindow(h.state.primaryWindow);
  const file = await addFile(h, a.review.id, 'Original version-list attachment bytes');
  const entry = await main.success('review.version.save', { reviewId: a.review.id,
    target: { code: 'original-reader-target' }, attachmentIds: [file.id] });
  await main.success('window.openProject', { projectId: a.project.id });
  const host = await projectHost(h, a.project.id), client = h.forWindow(host);
  const normal = await client.success('review.version.list', { reviewId: a.review.id });
  assert.equal(normal.entries[0].id, entry.id);
  assert.equal(normal.entries[0].attachments[0].status, 'available');
  assert.equal(normal.entries[0].attachments[0].sha256, file.sha256);
  assert.deepEqual(reads, [file.id]); reads.length = 0;
  const originalFrame = host.webContents.mainFrame;
  const unblock = await holdWriteAdmissionQueue(t, h, a.service.id);
  let settled = false, result, expected, expectedNotices;
  const pending = client.invoke('review.version.list', { reviewId: a.review.id })
    .then(value => { settled = true; return value; });
  try {
    await Promise.resolve(); assert.equal(settled, false, 'The original read must still be queued');
    host.webContents.mainFrame = { url: originalFrame.url };
    assert.notEqual(host.webContents.mainFrame, originalFrame);
    assert.equal(host.isDestroyed(), false, 'Frame replacement does not close the original host');
    expected = h.state.liveStore.exportData();
    expectedNotices = h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length;
  } finally {
    // Settle the exact queued request before restoring its frame or closing Store.
    try { await unblock(); }
    finally {
      try { result = await pending; }
      finally { host.webContents.mainFrame = originalFrame; }
    }
  }
  assert.equal(settled, true);
  assert.deepEqual(h.state.liveStore.exportData(), expected);
  assert.equal(h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length, expectedNotices);
  t.diagnostic(JSON.stringify({ scope: 'Controlled production main/Store with an owned queue gate; no native app or remote caller',
    originalFrameReplaced: true, hostStillAlive: !host.isDestroyed(), actualOK: result.ok,
    actualErrorCode: result.error?.code || null, returnedVersionEntries: result.data?.entries?.length ?? null,
    businessStateUnchanged: true, newDataChangeNotices: 0, queuedAttachmentReads: reads.length }));
  assert.equal(result.ok, false, 'A version-list read must refuse its replaced original main frame');
  assert.equal(result.error.code, 'ACCESS_DENIED'); assert.deepEqual(reads, []);
});


for (const change of ['foreign navigation', 'closed window', 'released QA scope', 'restored epoch', 'review reborn', 'review moved']) {
  test(`version list refuses its original reader after ${change} during an attachment read`, async t => {
    let entered, release, armed = false;
    const reading = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const h = await harness(t, { versionListReadGate: async () => { if (armed) { entered(); await gate; } } });
    const a = await seed(h), b = await seed(h), main = h.forWindow(h.state.primaryWindow);
    const file = await addFile(h, a.review.id, 'Original list read bytes');
    await main.success('review.version.save', { reviewId: a.review.id, target: { code: 'list-target' }, attachmentIds: [file.id] });
    await main.success('window.openProject', { projectId: a.project.id });
    const host = await projectHost(h, a.project.id), client = h.forWindow(host), originalURL = host.webContents.mainFrame.url;
    const qa = change === 'released QA scope' ? await h.state.toolIntegration.automationHandler('automation.qa.open',
      { projectId: a.project.id, clientId: 'version-list-original-reader' }) : null;
    armed = true;
    const pending = client.invoke('review.version.list', { reviewId: a.review.id });
    let result, expected, expectedNotices;
    try {
      await Promise.race([reading, pending.then(() => { throw new Error('Version list settled before its owned read gate'); })]);
      if (change === 'foreign navigation') host.webContents.mainFrame.url = 'https://foreign.invalid/';
      if (change === 'closed window') { host.destroy(); h.state.focusedWindow = h.state.primaryWindow; }
      if (change === 'released QA scope') assert.equal((await h.state.toolIntegration.automationHandler('automation.qa.release', qa)).released, true);
      if (change === 'restored epoch') h.state.liveStore.importData(h.state.liveStore.exportData());
      if (change === 'review reborn') {
        const original = { ...h.state.liveStore.db.prepare('SELECT * FROM reviews WHERE id=?').get(a.review.id) }, keys = Object.keys(original);
        h.state.liveStore.transaction(() => {
          h.state.liveStore.deleteReview(a.review.id);
          h.state.liveStore.db.prepare(`INSERT INTO reviews(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => original[key]));
        });
      }
      if (change === 'review moved') h.state.liveStore.db.prepare('UPDATE reviews SET projectId=?,serviceId=NULL,number=(SELECT COALESCE(MAX(number),0)+1 FROM reviews WHERE projectId=?) WHERE id=?').run(b.project.id, b.project.id, a.review.id);
      expected = h.state.liveStore.exportData();
      expectedNotices = h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length;
    } finally {
      release();
      try { result = await pending; }
      finally { host.webContents.mainFrame.url = originalURL; }
    }
    const code = change === 'restored epoch' ? 'STALE_EPOCH' : ['review reborn', 'review moved'].includes(change) ? 'STALE_REVIEW' :
      change === 'released QA scope' ? 'TARGET_MISMATCH' : 'ACCESS_DENIED';
    assert.equal(result.ok, false, change); assert.equal(result.error.code, code, change);
    assert.deepEqual(h.state.liveStore.exportData(), expected);
    assert.equal(h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length, expectedNotices);
    assert.equal(h.state.agentStarts.length, 0);
  });
}

for (const route of ['local frame replacement', 'integration epoch replacement']) {
  test(`version list rechecks its ${route} after helper settlement before delivery`, async t => {
    let entered, release, armed = false;
    const returned = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const h = await harness(t, { versionListReturnGate: async () => { if (armed) { entered(); await gate; } } });
    const a = await seed(h), file = await addFile(h, a.review.id, 'Returned helper bytes');
    await h.success('review.version.save', { reviewId: a.review.id, target: { code: 'settled-target' }, attachmentIds: [file.id] });
    const host = h.state.primaryWindow, originalFrame = host.webContents.mainFrame;
    armed = true;
    const pending = (route === 'local frame replacement' ? h.forWindow(host).invoke('review.version.list', { reviewId: a.review.id }) :
      h.state.toolIntegration.dispatch('review.version.list', { reviewId: a.review.id })).then(value => ({ value }), error => ({ error }));
    let result, expected, expectedNotices;
    try {
      await Promise.race([returned, pending.then(() => { throw new Error('Version list settled before its delivery gate'); })]);
      if (route === 'local frame replacement') host.webContents.mainFrame = { url: originalFrame.url };
      else h.state.liveStore.importData(h.state.liveStore.exportData());
      expected = h.state.liveStore.exportData();
      expectedNotices = h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length;
    } finally {
      release();
      try { result = await pending; }
      finally { host.webContents.mainFrame = originalFrame; }
    }
    if (route === 'local frame replacement') {
      assert.equal(result.value.ok, false); assert.equal(result.value.error.code, 'ACCESS_DENIED');
    } else assert.equal(result.error.code, 'STALE_EPOCH');
    assert.deepEqual(h.state.liveStore.exportData(), expected);
    assert.equal(h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length, expectedNotices);
  });
}


for (const route of ['local', 'integration']) {
  test(`version list keeps its original ${route} epoch while queued without starting byte reads`, async t => {
    const reads = [], h = await harness(t, { versionListReadObserver: file => reads.push(file.id) });
    const a = await seed(h), file = await addFile(h, a.review.id, 'Queued epoch original bytes');
    await h.success('review.version.save', { reviewId: a.review.id, target: { code: 'queued-epoch' }, attachmentIds: [file.id] });
    const unblock = await holdWriteAdmissionQueue(t, h, a.service.id);
    const pending = (route === 'local' ? h.invoke('review.version.list', { reviewId: a.review.id }) :
      h.state.toolIntegration.dispatch('review.version.list', { reviewId: a.review.id })).then(value => ({ value }), error => ({ error }));
    let result, expected, expectedNotices;
    try {
      h.state.liveStore.importData(h.state.liveStore.exportData());
      expected = h.state.liveStore.exportData();
      expectedNotices = h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length;
    } finally {
      try { await unblock(); }
      finally { result = await pending; }
    }
    const error = route === 'local' ? result.value.error : result.error;
    if (route === 'local') assert.equal(result.value.ok, false);
    assert.equal(error.code, 'STALE_EPOCH');
    assert.equal(error.message, '리뷰 또는 자료가 변경되었습니다. 검토자료 버전 목록을 다시 불러오십시오.');
    assert.deepEqual(reads, []); assert.deepEqual(h.state.liveStore.exportData(), expected);
    assert.equal(h.state.windowMessages.filter(row => row.channel === 'reviewops:data-change').length, expectedNotices);
  });
}

test('local shared comment attachments use actual Store classification without writes or window effects', async t => {
  const h = await harness(t), a = await seed(h), b = await seed(h), main = h.forWindow(h.state.primaryWindow), store = h.state.liveStore;
  const empty = store.addActivity({ reviewId: a.review.id, body: '', allowEmpty: true });
  const other = store.addActivity({ reviewId: a.review.id, body: 'Another user comment' });
  const system = store.addActivity({ reviewId: a.review.id, body: 'PRIVATE_SYSTEM', role: 'system' });
  const run = store.saveAgentRun({ reviewId: a.review.id, serviceId: a.service.id, workPath: a.service.rootPath,
    status: 'completed', response: 'PRIVATE_AGENT_RESPONSE' });
  const prompt = store.addActivity({ reviewId: a.review.id, body: 'PRIVATE_AGENT_PROMPT', role: 'user', agentRunId: run.id });
  const response = store.snapshot().activities.find(row => row.agentRunId === run.id && row.role === 'agent');
  const created = store.snapshot().activities.find(row => row.reviewId === a.review.id && row.type === 'created');
  const foreign = store.addActivity({ reviewId: b.review.id, body: 'Other project user comment' });
  assert.ok(response); assert.ok(created); assert.equal(empty.body, ''); assert.equal(empty.role, 'user'); assert.equal(empty.agentRunId, '');
  const add = (id, reviewId, activityId, extra = {}) => store.addAttachment({ id, reviewId, activityId, name: id + '.txt',
    mimeType: 'text/plain', size: 0, storageName: 'PRIVATE-' + id + '.txt', sha256: 'F'.repeat(64), ...extra });
  add('comment-z', a.review.id, empty.id, { name: '  Actual 한 e\u0301 🙂.txt  ', mimeType: ' text/plain ', size: '0' });
  add('comment-a', a.review.id, empty.id, { sha256: 'ab'.repeat(32), size: 1073741824 });
  add('review-direct', a.review.id, null);
  for (const [id, activityId] of [['other-user', other.id], ['system', system.id], ['response', response.id], ['prompt', prompt.id], ['created', created.id]])
    add('linked-' + id, a.review.id, activityId);
  const foreignFile = add('foreign-comment', b.review.id, foreign.id);
  const expected = store.db.prepare('SELECT * FROM attachments WHERE reviewId=? AND activityId=? ORDER BY createdAt,id').all(a.review.id, empty.id).map(row =>
    ({ id: row.id, reviewId: row.reviewId, name: row.name, mimeType: row.mimeType, size: row.size,
      sha256: row.sha256, createdAt: row.createdAt, updatedAt: row.updatedAt }));
  assert.equal(expected.length, 2); assert.ok(expected.some(row => row.name === 'Actual 한 e\u0301 🙂.txt' && row.size === 0));
  await main.success('window.openProject', { projectId: a.project.id });
  const host = await projectHost(h, a.project.id), client = h.forWindow(host);
  await main.success('window.openProject', { projectId: b.project.id });
  const bHost = await projectHost(h, b.project.id); bHost.focus();
  const before = store.exportData(), revisions = store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all();
  const receipts = store.db.prepare('SELECT * FROM command_receipts').all(), messages = h.state.windowMessages.length;
  const windows = () => h.state.windows.map(window => ({ window, bounds: { ...window.bounds }, visible: window.visible, destroyed: window.destroyed }));
  const windowBefore = windows(), filesBefore = fs.readdirSync(path.join(h.dataPath, 'attachments')).sort();
  const database = () => ['reviewops.sqlite', 'reviewops.sqlite-wal'].map(name => {
    const file = path.join(h.dataPath, name);
    return { name, sha256: fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null };
  });
  const databaseBefore = database(), snapshot = store.snapshot.bind(store); let calls = 0;
  store.snapshot = () => { calls++; return snapshot(); };
  let result;
  try { result = await client.success('shared.commentAttachments.list', { projectId: a.project.id, reviewId: a.review.id, commentId: empty.id }); }
  finally { store.snapshot = snapshot; }
  assert.equal(calls, 1);
  assert.deepEqual(result, { version: 1, projectId: a.project.id, reviewId: a.review.id, commentId: empty.id, attachments: expected });
  assert.deepEqual(Object.keys(result.attachments[0]), ['id', 'reviewId', 'name', 'mimeType', 'size', 'sha256', 'createdAt', 'updatedAt']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  result.attachments[0].name = 'Caller-only.txt'; result.attachments.push({ id: 'caller-only' });
  const target = { projectId: a.project.id, reviewId: a.review.id, commentId: empty.id };
  assert.deepEqual((await client.success('shared.commentAttachments.list', target)).attachments, expected);
  const notFound = { code: 'NOT_FOUND', message: 'Shared resource not found.' };
  for (const payload of [{ ...target, commentId: system.id }, { ...target, commentId: prompt.id },
    { ...target, commentId: response.id }, { ...target, commentId: created.id }, { ...target, commentId: foreign.id },
    { ...target, commentId: 'missing' }, { ...target, reviewId: b.review.id },
    { projectId: b.project.id, reviewId: b.review.id, commentId: foreign.id }]) {
    const denied = await client.invoke('shared.commentAttachments.list', payload);
    assert.equal(denied.ok, false); assert.deepEqual({ code: denied.error.code, message: denied.error.message }, notFound);
  }
  const invalid = await client.invoke('shared.commentAttachments.list', { ...target, projectGrants: [{ projectId: b.project.id, read: true }] });
  assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_QUERY');
  assert.equal((await main.success('shared.commentAttachments.list', { projectId: b.project.id, reviewId: b.review.id, commentId: foreign.id })).attachments[0].id, foreignFile.id);
  await assert.rejects(h.state.toolIntegration.dispatch('shared.commentAttachments.list', target), /지원하지 않는 기능/);
  await assert.rejects(h.state.toolIntegration.automationHandler('automation.shared.commentAttachments.list', target), { code: 'UNKNOWN_ACTION' });
  assert.deepEqual((await client.success('shared.commentAttachments.list', target)).attachments, expected, 'Denied reads do not poison the queue');
  assert.deepEqual(store.exportData(), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM review_revisions ORDER BY reviewId').all(), revisions);
  assert.deepEqual(store.db.prepare('SELECT * FROM command_receipts').all(), receipts);
  assert.deepEqual(database(), databaseBefore);
  assert.deepEqual(fs.readdirSync(path.join(h.dataPath, 'attachments')).sort(), filesBefore);
  assert.deepEqual(windows(), windowBefore); assert.equal(h.state.focusedWindow, bHost);
  assert.equal(h.state.windowMessages.length, messages); assert.equal(h.state.agentStarts.length, 0);
  assert.equal(h.state.clipboardWrites?.length || 0, 0);
});

test('local shared comment attachments refuse queued frame replacement and closed original owners', async t => {
  for (const change of ['same-URL-frame', 'closed-owner']) {
    const h = await harness(t), a = await seed(h), main = h.forWindow(h.state.primaryWindow), store = h.state.liveStore;
    const user = store.addActivity({ reviewId: a.review.id, body: '', allowEmpty: true });
    await main.success('window.openProject', { projectId: a.project.id });
    const host = await projectHost(h, a.project.id), client = h.forWindow(host), frame = host.webContents.mainFrame;
    const unblock = await holdWriteAdmissionQueue(t, h, a.service.id);
    let settled = false, result, before, messages;
    const pending = client.invoke('shared.commentAttachments.list', { projectId: a.project.id, reviewId: a.review.id, commentId: user.id })
      .then(value => { settled = true; return value; });
    try {
      await Promise.resolve(); assert.equal(settled, false, 'The exact original read is still queued');
      if (change === 'same-URL-frame') {
        host.webContents.mainFrame = { url: frame.url };
        assert.notEqual(host.webContents.mainFrame, frame); assert.equal(host.isDestroyed(), false);
      } else {
        host.destroy(); await main.success('window.openProject', { projectId: a.project.id });
        const replacement = await projectHost(h, a.project.id); assert.notEqual(replacement, host); replacement.focus();
      }
      before = store.exportData(); messages = h.state.windowMessages.length;
    } finally {
      try { await unblock(); }
      finally { try { result = await pending; } finally { host.webContents.mainFrame = frame; } }
    }
    assert.equal(settled, true); assert.equal(result.ok, false, change); assert.equal(result.error.code, 'ACCESS_DENIED', change);
    assert.deepEqual(store.exportData(), before); assert.equal(h.state.windowMessages.length, messages);
    if (change === 'closed-owner')
      assert.deepEqual((await h.forWindow(h.state.focusedWindow).success('shared.commentAttachments.list',
        { projectId: a.project.id, reviewId: a.review.id, commentId: user.id })).attachments, []);
  }
});

test('local shared comment attachments observe queued deletion without widening their original project', async t => {
  const h = await harness(t), a = await seed(h), b = await seed(h), main = h.forWindow(h.state.primaryWindow), store = h.state.liveStore;
  const user = store.addActivity({ reviewId: a.review.id, body: '', allowEmpty: true });
  const other = store.addActivity({ reviewId: b.review.id, body: '', allowEmpty: true });
  store.addAttachment({ id: 'queued-comment-file', reviewId: a.review.id, activityId: user.id, name: 'Queued.txt',
    mimeType: 'text/plain', size: 0, storageName: 'PRIVATE-queued-comment.txt', sha256: 'F'.repeat(64) });
  await main.success('window.openProject', { projectId: a.project.id });
  const client = h.forWindow(await projectHost(h, a.project.id)), unblock = await holdWriteAdmissionQueue(t, h, a.service.id);
  const removeReview = main.invoke('review.delete', { id: a.review.id }), removeProject = main.invoke('project.delete', { id: a.project.id });
  const pending = client.invoke('shared.commentAttachments.list', { projectId: a.project.id, reviewId: a.review.id, commentId: user.id });
  try {
    await unblock(); assert.equal((await removeReview).ok, true); assert.equal((await removeProject).ok, true);
    const before = store.exportData(), messages = h.state.windowMessages.length, result = await pending;
    assert.equal(result.ok, false); assert.deepEqual({ code: result.error.code, message: result.error.message }, { code: 'NOT_FOUND', message: 'Shared resource not found.' });
    const foreign = { projectId: b.project.id, reviewId: b.review.id, commentId: other.id };
    assert.equal((await client.invoke('shared.commentAttachments.list', foreign)).error.code, 'NOT_FOUND');
    assert.deepEqual((await main.success('shared.commentAttachments.list', foreign)).attachments, []);
    assert.deepEqual(store.exportData(), before); assert.equal(h.state.windowMessages.length, messages);
  } finally {
    try { await unblock(); }
    finally { await Promise.allSettled([removeReview, removeProject, pending]); }
  }
});

test('Ops IPC permits the trusted home frame and denies project, QA and foreign frames',async t=>{
 const h=await harness(t),main=h.state.primaryWindow,a=await seed(h);
 const saved=await h.ops('saveGoal',{name:'Isolated Ops goal',description:'',prompt:'Inspect this target',workPath:h.root},h.event(main));
 assert.equal(saved.goals.length,1);assert.equal(saved.goals[0].workPath,fs.realpathSync(h.root));
 await h.forWindow(main).success('window.openProject',{projectId:a.project.id});const project=await projectHost(h,a.project.id);
 await assert.rejects(h.ops('snapshot',undefined,h.event(project)),{code:'OPS_ACCESS_DENIED'});
 const foreign={sender:main.webContents,senderFrame:{url:'https://example.invalid'}};
 await assert.rejects(h.ops('snapshot',undefined,foreign),{code:'OPS_ACCESS_DENIED'});
 assert.equal((await h.ops('snapshot',undefined,h.event(main))).goals.length,1);
});

test('Ops goal save revalidates its original window after asynchronous target resolution',async t=>{
 let release,entered;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const h=await harness(t,{opsTargetGate:async()=>{entered();await gate;}}),host=h.state.primaryWindow;
 const pending=h.ops('saveGoal',{name:'Late target',description:'',prompt:'Inspect',workPath:h.root},h.event(host));
 await ready;host.webContents.mainFrame={url:'reviewops://app/index.html'};release();
 await assert.rejects(pending,{code:'OPS_ACCESS_DENIED'});assert.equal(h.state.opsManager.snapshot().goals.length,0);
});

test('Ops application backup includes versioned settings and restores session-independent goals paused',async t=>{
 const h=await harness(t),file=path.join(h.root,'ops-backup.json');
 await h.ops('saveGoal',{name:'Saved Ops goal',description:'Description',prompt:'Preserve data',workPath:h.root});
 await h.ops('configure',{commonPrompt:'Original shared instructions'});h.state.saveResult={canceled:false,filePath:file};
 await h.success('backup.export');const bundle=JSON.parse(fs.readFileSync(file));assert.equal(bundle.ops.version,1);assert.equal(bundle.ops.goals.length,1);
 await h.ops('configure',{commonPrompt:'Changed instructions'});h.state.openResult={canceled:false,filePaths:[file]};
 assert.equal((await h.success('backup.import')).imported,true);const restored=await h.ops('snapshot');assert.equal(restored.commonPrompt,'Original shared instructions');assert.equal(restored.goals[0].status,'paused');
});

test('Ops backup restore rolls back its original records when the outer review-data commit fails',async t=>{
 const h=await harness(t),file=path.join(h.root,'ops-rollback.json');
 await h.ops('saveGoal',{name:'Original records',description:'',prompt:'Preserve the original session',workPath:h.root});
 h.state.opsManager.store.update(data=>{Object.assign(data.goals[0],{threadId:'existing-saved-thread',status:'paused',modelState:'idle',backgroundState:'empty',backgroundCount:0});});
 h.state.saveResult={canceled:false,filePath:file};await h.success('backup.export');await h.ops('configure',{commonPrompt:'Current instructions that must survive a failed restore'});
 const before=h.state.opsManager.exportData(),restore=h.state.opsManager.restore.bind(h.state.opsManager),db=h.state.liveStore.db,exec=db.exec.bind(db);let armed=false;
 h.state.opsManager.restore=(data,options)=>{const result=restore(data,options);if(options?.pause!==false)armed=true;return result;};
 db.exec=sql=>{if(armed&&sql==='COMMIT'){armed=false;throw new Error('Injected outer commit failure after Ops restoration');}return exec(sql);};
 h.state.openResult={canceled:false,filePaths:[file]};try{const result=await h.invoke('backup.import');assert.equal(result.ok,false);assert.match(result.error.message,/Injected outer commit failure/);}finally{db.exec=exec;}
 const after=h.state.opsManager.exportData();assert.equal(after.commonPrompt,before.commonPrompt);assert.deepEqual(after.goals,before.goals);
});

test('Ops project targets retain committed birth and require confirmation after dataset replacement',async t=>{
 const h=await harness(t),a=await seed(h);await h.success('service.save',{id:a.service.id,kind:'local',rootPath:h.root,agentWorkPath:''});
 const input={name:'Project-bound Ops',description:'',prompt:'Inspect this project',projectId:a.project.id,serviceId:a.service.id,workPath:''};
 const saved=await h.ops('saveGoal',input),goal=saved.goals[0];assert.ok(Number.isSafeInteger(goal.projectBirth));assert.equal((await h.state.opsOptions.resolveTarget(goal)).workPath,fs.realpathSync(h.root));
 h.state.liveStore.importData(h.state.liveStore.exportData());await assert.rejects(h.state.opsOptions.resolveTarget(goal),{code:'OPS_PROJECT_CHANGED'});
 const confirmed=await h.ops('saveGoal',{...input,id:goal.id});assert.notEqual(confirmed.goals[0].projectEpoch,goal.projectEpoch);assert.equal((await h.state.opsOptions.resolveTarget(confirmed.goals[0])).workPath,fs.realpathSync(h.root));
});


test('Ops startup opens the main window and IPC while an original SSH-like thread reconciliation is held',async t=>{
 let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const pending=harness(t,{opsBeforeCreate:async config=>{const {OpsManager}=require('../electron/ops-manager.cjs');const seed=new OpsManager({dataPath:config.dataPath});await seed.saveGoal({name:'Saved unavailable target',description:'',prompt:'Continue original work',workPath:path.dirname(config.dataPath)});seed.store.update(data=>{Object.assign(data.goals[0],{status:'active',executionState:'running',threadId:'saved-original-thread',turnId:'saved-original-turn',modelState:'running',backgroundState:'active',backgroundCount:1});});await seed.close();},opsCreateSession:()=>({reconcile:async()=>{entered();await gate;return {threadId:'saved-original-thread',state:'idle',backgroundState:'empty',backgroundCount:0,delivery:'unknown'};},close:async()=>{}})});let h,timer;
 try{await ready;h=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('A held Ops connection prevented the main window from opening.')),1500);})]);assert.ok(h.state.primaryWindow);const state=await h.ops('snapshot');assert.equal(state.goals[0].executionState,'unknown');assert.equal(state.goals[0].threadId,'saved-original-thread');assert.equal(h.state.opsManager.hasActiveWork(),true);}finally{clearTimeout(timer);release();h||=await pending;if(h?.state.opsManager)await h.state.opsManager.reconnect(h.state.opsManager.snapshot().goals[0].id);}
});

function controlledOpsSessions(){const sessions=new Map();return {sessions,create:options=>{const threadId='thread-'+options.goalId,turnId='turn-'+options.goalId;let state='running';sessions.set(options.goalId,{options,threadId,turnId});return {start:async()=>{await options.onEvent({type:'thread',threadId});await options.onEvent({type:'turn.started',threadId,turnId});return {delivery:'accepted',state:'running',threadId,turnId};},interrupt:async()=>{state='idle';await options.onEvent({type:'turn.completed',threadId,turnId,status:'interrupted',backgroundState:'empty',backgroundCount:0});return {confirmed:true,state:'idle',threadId,turnId};},reconcile:async()=>({delivery:'accepted',state,threadId,turnId,backgroundState:state==='idle'?'empty':'unknown',backgroundCount:state==='idle'?0:null,...(state==='idle'?{outcome:'interrupted'}:{})}),close:async()=>{}};}};}
async function mainQaGoal(h,name){const project=await seed(h),workPath=path.join(h.root,name);fs.mkdirSync(workPath);await h.success('service.save',{id:project.service.id,kind:'local',rootPath:workPath,agentWorkPath:''});const saved=await h.ops('saveGoal',{name,description:'',prompt:'Inspect this registered project.',projectId:project.project.id,serviceId:project.service.id,workPath:''}),id=saved.goals.at(-1).id;await h.ops('goalAction',{goalId:id,action:'start'});await h.state.opsManager.pumpAll();assert.equal(h.state.opsManager.snapshot().goals.find(g=>g.id===id).executionState,'running',h.state.opsManager.snapshot().goals.find(g=>g.id===id).lastError);return {id,...project};}
const qaCall=(sessions,id,name,args,callId)=>{const session=sessions.get(id);return session.options.tools.find(tool=>tool.name===name).execute(args,{callId,threadId:session.threadId,turnId:session.turnId});};
async function qaRefused(operation,code){const result=await operation;assert.equal(result.success,false);assert.equal(JSON.parse(result.text).error.code,code);return result;}

test('Ops QA tools bind two original projects and pause fences queued input while retaining the other lease',async t=>{
 const fixture=controlledOpsSessions(),h=await harness(t,{opsCreateSession:fixture.create}),a=await mainQaGoal(h,'QA-main-A'),b=await mainQaGoal(h,'QA-main-B');const openedA=await qaCall(fixture.sessions,a.id,'ops_qa_open',{},'open-A'),openedB=await qaCall(fixture.sessions,b.id,'ops_qa_open',{},'open-B');assert.equal(openedA.success,true,openedA.text);assert.equal(openedB.success,true,openedB.text);const bindingA=JSON.parse(openedA.text),bindingB=JSON.parse(openedB.text);assert.equal(bindingA.projectId,a.project.id);assert.equal(bindingB.projectId,b.project.id);assert.notEqual(bindingA.clientId,bindingB.clientId);assert.notEqual(bindingA.sessionId,bindingB.sessionId);assert.notEqual(bindingA.windowId,bindingB.windowId);
 await qaRefused(qaCall(fixture.sessions,a.id,'ops_qa_open',{projectId:b.project.id},'foreign-project'),'INVALID_REQUEST');
 const record=h.state.qaOptions.getWindow(bindingA.windowId),commands=[];let release;const gate=new Promise(r=>release=r);record.host.webContents.debugger={isAttached:()=>true,sendCommand:async(method,params)=>{commands.push({method,params});return {};}};record.browsers={automationTargets:()=>[{browserId:'held-surface',contents:record.host.webContents,ready:gate}],closeAll(){},async flush(){}};
 const input=qaCall(fixture.sessions,a.id,'ops_qa_type',{browserId:'held-surface',text:'Must not enter after pause'},'pending-A');await new Promise(setImmediate);assert.equal(h.state.opsManager.snapshot().goals.find(g=>g.id===a.id).qaReceipts.at(-1).status,'prepared');const pause=h.ops('goalAction',{goalId:a.id,action:'pause'},h.event(h.state.primaryWindow));release();await qaRefused(input,'OPS_QA_RELEASE_UNCONFIRMED');await pause;assert.deepEqual(commands,[]);const goals=h.state.opsManager.snapshot().goals;assert.equal(goals.find(g=>g.id===a.id).qaBinding.state,'released');assert.equal(goals.find(g=>g.id===a.id).qaReceipts.at(-1).status,'unknown');assert.equal(goals.find(g=>g.id===b.id).qaBinding.state,'attached');assert.equal(h.state.qaOptions.getWindow(bindingB.windowId).qaActive,true);
});

test('Ops QA input revalidates committed project birth after readiness waits and folder goals cannot acquire QA',async t=>{
 const fixture=controlledOpsSessions(),h=await harness(t,{opsCreateSession:fixture.create}),a=await mainQaGoal(h,'QA-birth-target'),opened=await qaCall(fixture.sessions,a.id,'ops_qa_open',{},'open-birth');assert.equal(opened.success,true,opened.text);const binding=JSON.parse(opened.text),record=h.state.qaOptions.getWindow(binding.windowId),commands=[];let release;const gate=new Promise(r=>release=r);record.host.webContents.debugger={isAttached:()=>true,sendCommand:async(method,params)=>{commands.push({method,params});return {};}};record.browsers={automationTargets:()=>[{browserId:'birth-surface',contents:record.host.webContents,ready:gate}],closeAll(){},async flush(){}};
 const input=qaCall(fixture.sessions,a.id,'ops_qa_type',{browserId:'birth-surface',text:'Must not enter replacement project'},'pending-birth');await new Promise(setImmediate);h.state.liveStore.importData(h.state.liveStore.exportData());release();await qaRefused(input,'OPS_QA_PROJECT_CHANGED');assert.deepEqual(commands,[]);assert.equal(h.state.opsManager.snapshot().goals.find(g=>g.id===a.id).qaReceipts.at(-1).status,'unknown');
 fs.mkdirSync(path.join(h.root,'QA-folder'));const folder=await h.ops('saveGoal',{name:'Folder QA unavailable',description:'',prompt:'Inspect folder only.',workPath:path.join(h.root,'QA-folder')},h.event(h.state.primaryWindow)),id=folder.goals.at(-1).id;await h.ops('goalAction',{goalId:id,action:'start'},h.event(h.state.primaryWindow));await h.state.opsManager.pumpAll();await qaRefused(qaCall(fixture.sessions,id,'ops_qa_open',{},'folder-open'),'OPS_QA_SCOPE');assert.equal(h.state.opsManager.snapshot().goals.find(g=>g.id===id).qaBinding.state,'unavailable');
});


test('Ops paused cleanup proves its original lease absent without releasing a replacement client in that project',async t=>{
 const fixture=controlledOpsSessions(),h=await harness(t,{opsCreateSession:fixture.create}),a=await mainQaGoal(h,'QA-original-cleanup'),opened=await qaCall(fixture.sessions,a.id,'ops_qa_open',{},'original-open');assert.equal(opened.success,true,opened.text);const original=JSON.parse(opened.text),originalRequest={sessionId:original.sessionId,projectId:original.projectId,windowId:original.windowId};await h.state.qaApi.handle('release',originalRequest);const replacement=await h.state.qaApi.handle('open',{projectId:a.project.id,clientId:'replacement-qa-client'});
 await h.ops('goalAction',{goalId:a.id,action:'pause'},h.event(h.state.primaryWindow));const goal=h.state.opsManager.snapshot().goals.find(g=>g.id===a.id);assert.equal(goal.status,'paused');assert.equal(goal.executionState,'idle');assert.equal(goal.qaBinding.state,'released');assert.equal(h.state.qaApi.leaseStatus(replacement).leaseState,'attached');assert.equal(h.state.qaOptions.getWindow(replacement.windowId).qaActive,true);
});

test('logical QA controller metadata is visible only in its original project window',async t=>{
 const h=await harness(t),a=await seed(h),b=await seed(h),api=h.state.qaApi;
 const aBinding=await api.handle('controller',{operation:'open',projectId:a.project.id,label:'Chat A'}),bBinding=await api.handle('controller',{operation:'open',projectId:b.project.id,label:'Chat B'});
 const aHost=await projectHost(h,a.project.id),bHost=await projectHost(h,b.project.id),call=(binding,operation)=>api.handle('controller',{operation,projectId:binding.projectId,appInstanceId:binding.appInstanceId,controllerId:binding.controllerId,controllerProof:binding.controllerProof});
 const contextA=await h.forWindow(aHost).success('window.context'),contextB=await h.forWindow(bHost).success('window.context');
 assert.deepEqual(contextA.qaController,{contract:'logical-qa-controller-v1',label:'Chat A',projectId:a.project.id,state:'attached',generation:1});assert.equal(contextB.qaController.label,'Chat B');assert.equal((await h.forWindow(h.state.primaryWindow).success('window.context')).qaController,undefined);
 const publicText=JSON.stringify([contextA,contextB]);for(const value of [aBinding.controllerProof,bBinding.controllerProof,aBinding.controllerId,bBinding.controllerId,aBinding.sessionId,bBinding.sessionId,aBinding.clientId,bBinding.clientId])assert.equal(publicText.includes(value),false);
 await call(bBinding,'detach');assert.equal((await h.forWindow(bHost).success('window.context')).qaController.state,'detached');assert.deepEqual(await h.forWindow(aHost).success('window.context'),contextA);
 await call(bBinding,'reconnect');await call(bBinding,'release');assert.equal((await h.forWindow(bHost).success('window.context')).qaController.state,'released');assert.deepEqual(await h.forWindow(aHost).success('window.context'),contextA);
});

test('logical QA proof retains original Store epoch and review birth without adopting restored IDs',async t=>{
 for(const replacement of ['epoch','review']){
  const h=await harness(t),a=await seed(h),api=h.state.qaApi;
  const binding=await api.handle('controller',{operation:'open',projectId:a.project.id,reviewId:a.review.id,label:'Original target'});
  if(replacement==='epoch')h.state.liveStore.importData(h.state.liveStore.exportData());else recreateOwnedReview(h.state.liveStore,a.review.id);
  await assert.rejects(async()=>api.handle('controller',{operation:'status',projectId:binding.projectId,appInstanceId:binding.appInstanceId,controllerId:binding.controllerId,controllerProof:binding.controllerProof}),{code:'QA_CONTROLLER_STALE'});
 }
});
