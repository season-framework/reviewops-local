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
  const dataPath = path.join(root, 'data');
  const handlers = new Map();
  const appEvents = new EventEmitter();
  const state = { switches: [], window: null, primaryWindow:null, windows:[], browserManagers:[], startup: null, liveStore: null, realVault: null, failures: {}, openResult: null, saveResult: null, messageResponse: 1, messageCalls: 0, unloadResponse: 0, unloadCalls: 0, windowMessages: [], startupErrors: [], dialogCalls:[] };
  const stores = [];
  const app = Object.assign(appEvents, {
    commandLine: {appendSwitch(...args) {state.switches.push(args);}},
    isPackaged: true,
    setName() {}, setPath() {}, quit() {},
    getPath(name) { if (name === 'temp' || name === 'appData') return root; throw new Error(`Unexpected getPath: ${name}`); },
    getVersion() { return '0.0.0-test'; },
    requestSingleInstanceLock() { return true; },
    whenReady() { return { then(callback) { state.startup = callback(); return state.startup; } }; }
  });
  class FakeBrowserWindow extends EventEmitter {
    constructor(windowOptions) {
      super(); this.options = windowOptions; this.id=state.windows.length+1;this.messages=[];
      const host=this;
      this.destroyed = false; this.maximized = false; this.fullScreen = false; this.closeCalls = 0;
      this.visible = true; this.minimized = false; this.bounds = {x:0,y:0,width:1440,height:940};
      this.webContents = Object.assign(new EventEmitter(), {
        id:this.id+1000,
        mainFrame: { url: 'reviewops://app/index.html' },
        setWindowOpenHandler() {}, getURL() { return this.mainFrame.url; },
        isDestroyed(){return host.destroyed;},getZoomFactor(){return host.zoomFactor||1;},
        isLoadingMainFrame() { return false; },
        async executeJavaScript(){return Boolean(host.preventUnload ?? state.preventUnload);},
        send(channel, data) {
          const message={ channel, data: JSON.parse(JSON.stringify(data)) };state.windowMessages.push(message);host.messages.push(message);
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
      if (this.preventUnload ?? state.preventUnload) {
        const unloadEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        this.webContents.emit('will-prevent-unload', unloadEvent);
        if (!unloadEvent.defaultPrevented) return;
      }
      this.destroyed = true;
      this.emit('closed');
    }
    destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('closed');}
  }
  const safeStorage = new Proxy({}, {get(){throw new Error('Keychain must not be accessed');}});
  const electron = {
    app, BrowserWindow: FakeBrowserWindow, safeStorage,
    screen: { getAllDisplays: () => [{id:1,bounds:{x:0,y:0,width:1440,height:940}},{id:2,bounds:{x:1440,y:0,width:1920,height:1080}}], getPrimaryDisplay: () => ({id:1}) },
    ipcMain: { handle(name, callback) { handlers.set(name, callback); } },
    dialog: {
      async showOpenDialog(host,options) { state.dialogCalls.push({kind:'open',host,options});if(state.openHandler)return state.openHandler(host,options);return state.openResult || { canceled: true, filePaths: [] }; },
      async showSaveDialog(host,options) { state.dialogCalls.push({kind:'save',host,options});return state.saveResult || { canceled: true }; },
      async showMessageBox() { state.messageCalls++; return { response: state.messageResponse }; },
      showMessageBoxSync(host) { state.unloadCalls++; return host.unloadResponse ?? state.unloadResponse; },
      showErrorBox(title, message) { state.startupErrors.push({ title, message }); }
    },
    shell: { async openPath() { return ''; }, async openExternal() {} },
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
    if (name === './vault.cjs') return { atomicWrite, createVault(file, storage) {
      const vault = createVault(file, storage); state.realVault = vault;
      return { ...vault, get: wrapMutation(vault, 'get'), commit: wrapMutation(vault, 'commit'), clear: wrapMutation(vault, 'clear'), delete: wrapMutation(vault, 'delete') };
    } };
    if (name === './ssh.cjs') return { createSshService: () => ({ close() {}, async openShell(_config,{onData,onClose}) { if(!state.allowShell)throw new Error('SSH must not run in these tests');onData(Buffer.from('session ready'));return {write:data=>onData(Buffer.from(data)),resize(){},close(){onClose()}}; }, test() { if(state.trustFingerprint)throw Object.assign(new Error('Synthetic SSH trust required'),{code:'SSH_TRUST_REQUIRED',fingerprint:state.trustFingerprint});throw new Error('SSH must not run in these tests'); } }) };
    if (name === './terminal.cjs') return require('../electron/terminal.cjs');
    if (name === './browser.cjs') return {createBrowserManager(host,options={}){
      const manager={host,options,closed:false,views:new Map(),async dispatch(action,payload){
        if(action==='browser.create'){const view={id:crypto.randomUUID(),url:payload.url};this.views.set(view.id,view);return view;}
        if(action==='browser.close'){this.views.delete(payload.id);return {closed:true};}
        const view=this.views.get(payload.id);if(!view)throw new Error('열린 화면을 찾을 수 없습니다.');return view;
      },closeAll(){this.closed=true;this.views.clear();},async flush(){}};
      state.browserManagers.push(manager);return manager;
    }};
    if (name === './agents.cjs') return {createAgentManager:({onUpdate})=>{
      const validator=require('../electron/agents.cjs').createAgentManager({spawn(){throw new Error('CLI must not run in main tests');}});
      state.agentStarts=[];state.agentRestores=[];state.agentValidations=[];state.agentPreflights=[];state.agentCancelled=[];state.agentUpdate=onUpdate;
      return {async preflight(config,settings){state.agentPreflights.push({config,settings});await state.preflightGate;if(state.preflightError)throw state.preflightError;return {installed:true,loggedIn:true,binary:settings.binary,workPath:settings.workPath};},validateStart(input){state.agentValidations.push(input);validator.validateStart(input);},start(input){state.agentStarts.push(input);validator.validateStart(input);if(state.agentStartError)throw new Error('synthetic agent start failure');return {id:input.id,status:'running'};},restore(input){state.agentRestores.push(input);onUpdate(input.job);return input.job;},async cancel(id){if(state.agentCancelError)throw new Error('synthetic agent cancel failure');const input=state.agentStarts.find(item=>item.id===id);assert(input);state.agentCancelled.push(id);onUpdate({...input,status:'cancelled',finishedAt:new Date().toISOString()});},async environment(config,settings){state.environmentCheck={config,settings};(state.environmentChecks||=[]).push({config,settings});await state.environmentGate;return state.agentEnvironment||{installed:true,loggedIn:true,models:[],modelSource:'none',defaultModel:'',defaultReasoningEffort:''};},async session(config,settings,sessionId){state.sessionCheck={config,settings,sessionId};return {available:true,sessionId,model:settings.model,status:'available'};},closeAll:async options=>{state.agentCloseOptions=options;}};
    }};
    if (['./work-directory.cjs','./review-versions.cjs','./review-copy.cjs','./agent-requests.cjs','./agent-copy-draft.cjs','./agent-execution-settings.cjs'].includes(name))return require('../electron/'+name.slice(2));
    if (name === './updates.cjs') return require('../electron/updates.cjs');
    if (name === './model-cache.cjs') return require('../electron/model-cache.cjs');
    if (name === './model-targets.cjs') return require('../electron/model-targets.cjs');
    if (name === './app-language.cjs') return require('../electron/app-language.cjs');
    if (name === './review-categories.json') return require('../electron/review-categories.json');
    if (name === './archive.cjs') return require('../electron/archive.cjs');
    if (name === './html-preview.cjs') return require('../electron/html-preview.cjs');
    if (name === './files.cjs') return files;
    if (name === './agent-files.cjs') return require('../electron/agent-files.cjs');
    if (name === './codex/index.cjs') return {createCodexManager:async options=>{state.codexOptions=options;return {registerHandlers(){state.codexRegistered=true;},async close(){state.codexClosed=true;},async resolveHost(alias){if(!state.codexHost||state.codexHost.alias!==alias)throw new Error('SSH 호스트를 찾을 수 없습니다.');return state.codexHost;}};}};
    if (name === './season-integration.cjs') return { createSeasonIntegration: async options => {
      state.seasonIntegration = options;
      if (state.seasonError) throw new Error(state.seasonError);
      return { close: async () => { state.seasonIntegrationClosed = true; } };
    } };
    if (name === './tool-integration.cjs') return {createToolIntegration:async options=>{state.toolIntegration=options;return {close:async()=>{state.toolIntegrationClosed=true;}};}};
    if (name.startsWith('node:')) return require(name);
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
    process: { env: { REVIEWOPS_DATA_DIR: dataPath }, platform: options.platform || process.platform, arch: process.arch },
    URL, Response, Buffer, console: {...console, warn(...args) { (state.seasonWarnings ||= []).push(args); }}, setImmediate, setTimeout, clearTimeout
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
  return { root, dataPath, state, invoke, success, event, forWindow, appEvents };
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

test('cancelling application quit in the second dirty window keeps every window and browser open',async t=>{
  const h=await harness(t),first=await seed(h),second=await seed(h);
  await h.state.seasonIntegration.showReview({reviewId:first.review.id,fullscreen:false});const a=await projectHost(h,first.project.id);
  await h.state.seasonIntegration.showReview({reviewId:second.review.id,fullscreen:false});const b=await projectHost(h,second.project.id);
  await h.forWindow(a).success('browser.create',{url:'https://fixture.invalid/a'});await h.forWindow(b).success('browser.create',{url:'https://fixture.invalid/b'});
  a.preventUnload=true;a.unloadResponse=1;b.preventUnload=true;b.unloadResponse=0;
  h.appEvents.emit('before-quit',{preventDefault(){}});
  await waitForValue(()=>h.state.unloadCalls===2,'Both dirty windows must be asked before any window closes');
  for(const host of h.state.windows){assert.equal(host.isDestroyed(),false);assert.equal(host.closeCalls,0);}
  assert.ok(h.state.browserManagers.every(manager=>!manager.closed));
  b.unloadResponse=1;h.appEvents.emit('before-quit',{preventDefault(){}});
  await waitForValue(()=>h.state.windows.every(host=>host.isDestroyed()),'Approved quit must close all application windows');
  assert.equal(h.state.unloadCalls,4,'Approved windows must not show the same discard prompt again');
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
 h.state.agentUpdate({id:run.id,kind:'agent',status:'failed',error:'synthetic failure',finishedAt:new Date().toISOString()});
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
 const retried=await h.success('agent.start',{requestId:crypto.randomUUID(),retryOf:failed.id,reviewId:review.id,prompt:failed.prompt});
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
 const retry=await h.success('agent.start',{reviewId:review.id,prompt:failed.prompt,requestId:crypto.randomUUID(),retryOf:failed.id});assert.deepEqual(retry.context,failed.context);assert.match(h.state.agentStarts.at(-1).prompt,/RETRY_ORIGINAL_INSTRUCTION/);assert.equal(h.state.agentStarts.at(-1).prompt.includes('RETRY_UPDATED_INSTRUCTION'),false);
 h.state.agentUpdate({id:retry.id,status:'completed',kind:'agent',response:'Done',finishedAt:new Date().toISOString()});
 const manual=await h.success('agent.start',{reviewId:review.id,prompt:'Explicit new attachment',requestId:crypto.randomUUID(),newConversation:true,context:{instruction:false,attachmentIds:[file.id],logIds:[]}});
 assert.deepEqual(manual.context.attachmentIds,[file.id]);assert.equal(manual.context.instruction,false);assert.deepEqual(manual.context.logIds,[]);assert.equal(h.state.agentStarts.at(-1).files[0].bytes.toString(),'RETRY_ORIGINAL_FILE');assert.equal(h.state.agentStarts.at(-1).prompt,'Explicit new attachment');
});

test('follow-up material requests and retries include only explicit materials without automatic review history',async t=>{
 const h=await harness(t),{service,review}=await seed(h);await h.success('service.save',{id:service.id,agentEnabled:1});
 await h.success('review.save',{id:review.id,body:'DO_NOT_REPEAT_REVIEW_BODY',evidence:syntheticEvidence('EXPLICIT_LOG')});const file=await addFile(h,review.id,'EXPLICIT_FILE');
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'Original user request',context:{instruction:false}});
 h.state.agentUpdate({id:first.id,status:'completed',kind:'agent',response:'DO_NOT_REPEAT_HISTORY',finishedAt:new Date().toISOString()});
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
 h.state.agentUpdate({id:first.id,kind:'agent',status:'failed',error:'synthetic failure',finishedAt:new Date().toISOString()});
 await h.success('review.save',{id:review.id,body:'UPDATED_INSTRUCTION',evidence:syntheticEvidence('UPDATED_LOG')});
 h.state.liveStore.saveAgentRun({id:first.id,context:{instruction:false}});
 const retained=await h.success('agent.read',{id:first.id});assert.deepEqual(retained.context,first.context);
 const second=await h.success('agent.start',{requestId:crypto.randomUUID(),retryOf:first.id,reviewId:review.id,prompt:first.prompt});
 assert.deepEqual(second.context,first.context);assert.equal(second.model,'original-model');assert.equal(second.reasoningEffort,'high');assert.equal(second.newConversation,true);assert.equal(second.retryOf,first.id);
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
 const first=await h.success('agent.start',{reviewId:review.id,prompt:'재실행할 요청',requestId:crypto.randomUUID(),context:{instruction:true,attachmentIds:[],logIds:[]}});
 h.state.agentUpdate({id:first.id,kind:'agent',status:'failed',error:'합성 실패',finishedAt:new Date().toISOString()});
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
 ['binary',{agentBinary:'another-codex'}],['model',{agentModel:'another-model'}]
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
 h.state.agentUpdate({id:first.id,kind:'agent',status:'failed',reportedSettings,error:'synthetic failure',finishedAt:new Date().toISOString()});
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
 assert.equal(second.continuedFromRunId,first.id);assert.equal(second.model,'model-b');assert.notEqual(second.id,first.id);
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
