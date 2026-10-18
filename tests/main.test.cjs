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
  const state = { switches: [], window: null, startup: null, liveStore: null, realVault: null, failures: {}, openResult: null, saveResult: null, messageResponse: 1, messageCalls: 0, unloadResponse: 0, unloadCalls: 0, windowMessages: [], startupErrors: [] };
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
    constructor(options) {
      super(); this.options = options;
      this.destroyed = false; this.maximized = false; this.fullScreen = false; this.closeCalls = 0;
      this.visible = true; this.minimized = false; this.bounds = {x:0,y:0,width:1440,height:940};
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: 'reviewops://app/index.html' },
        setWindowOpenHandler() {}, getURL() { return this.mainFrame.url; },
        isLoadingMainFrame() { return false; },
        send(channel, data) {
          state.windowMessages.push({ channel, data: JSON.parse(JSON.stringify(data)) });
          if(channel==='reviewops:season-review'&&!options.manualSeasonAcknowledgment)setImmediate(()=>handlers.get('reviewops:invoke')({sender:this,senderFrame:this.mainFrame},'integration.displayed',{...data,section:'review'}));
        },
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }
      });
      state.window = this;
    }
    loadURL(url) { this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullScreen; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    focus() {}
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = {...bounds}; }
    maximize() { this.maximized = true; this.emit('maximize'); }
    unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    setFullScreen(value) { this.fullScreen = value; this.emit(value ? 'enter-full-screen' : 'leave-full-screen'); }
    close() {
      this.closeCalls++;
      const closeEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', closeEvent);
      if (closeEvent.defaultPrevented) return;
      if (state.preventUnload) {
        const unloadEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        this.webContents.emit('will-prevent-unload', unloadEvent);
        if (!unloadEvent.defaultPrevented) return;
      }
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const safeStorage = new Proxy({}, {get(){throw new Error('Keychain must not be accessed');}});
  const electron = {
    app, BrowserWindow: FakeBrowserWindow, safeStorage,
    screen: { getAllDisplays: () => [{id:1,bounds:{x:0,y:0,width:1440,height:940}},{id:2,bounds:{x:1440,y:0,width:1920,height:1080}}], getPrimaryDisplay: () => ({id:1}) },
    ipcMain: { handle(name, callback) { handlers.set(name, callback); } },
    dialog: {
      async showOpenDialog() { if(state.openHandler)return state.openHandler();return state.openResult || { canceled: true, filePaths: [] }; },
      async showSaveDialog() { return state.saveResult || { canceled: true }; },
      async showMessageBox() { state.messageCalls++; return { response: state.messageResponse }; },
      showMessageBoxSync() { state.unloadCalls++; return state.unloadResponse; },
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
      return { ...vault, commit: wrapMutation(vault, 'commit'), clear: wrapMutation(vault, 'clear'), delete: wrapMutation(vault, 'delete') };
    } };
    if (name === './ssh.cjs') return { createSshService: () => ({ close() {}, async openShell(_config,{onData,onClose}) { if(!state.allowShell)throw new Error('SSH must not run in these tests');onData(Buffer.from('session ready'));return {write:data=>onData(Buffer.from(data)),resize(){},close(){onClose()}}; }, test() { if(state.trustFingerprint)throw Object.assign(new Error('Synthetic SSH trust required'),{code:'SSH_TRUST_REQUIRED',fingerprint:state.trustFingerprint});throw new Error('SSH must not run in these tests'); } }) };
    if (name === './terminal.cjs') return require('../electron/terminal.cjs');
    if (name === './agents.cjs') return {createAgentManager:({onUpdate})=>{
      const validator=require('../electron/agents.cjs').createAgentManager({spawn(){throw new Error('CLI must not run in main tests');}});
      state.agentStarts=[];state.agentValidations=[];state.agentCancelled=[];state.agentUpdate=onUpdate;
      return {validateStart(input){state.agentValidations.push(input);validator.validateStart(input);},start(input){state.agentStarts.push(input);validator.validateStart(input);if(state.agentStartError)throw new Error('synthetic agent start failure');return {id:input.id,status:'running'};},async cancel(id){if(state.agentCancelError)throw new Error('synthetic agent cancel failure');const input=state.agentStarts.find(item=>item.id===id);assert(input);state.agentCancelled.push(id);onUpdate({...input,status:'cancelled',finishedAt:new Date().toISOString()});},async session(config,settings,sessionId){state.sessionCheck={config,settings,sessionId};return {available:true,sessionId,model:settings.model,status:'available'};},closeAll:async()=>{}};
    }};
    if (name === './updates.cjs') return require('../electron/updates.cjs');
    if (name === './app-language.cjs') return require('../electron/app-language.cjs');
    if (name === './archive.cjs') return require('../electron/archive.cjs');
    if (name === './html-preview.cjs') return require('../electron/html-preview.cjs');
    if (name === './files.cjs') return files;
    if (name === './agent-files.cjs') return require('../electron/agent-files.cjs');
    if (name === './codex/index.cjs') return {createCodexManager:async options=>{state.codexOptions=options;return {registerHandlers(){state.codexRegistered=true;},async close(){state.codexClosed=true;},async resolveHost(alias){if(!state.codexHost||state.codexHost.alias!==alias)throw new Error('SSH 호스트를 찾을 수 없습니다.');return state.codexHost;}};}};
    if (name === './season-integration.cjs') return { createSeasonIntegration: async options => {
      state.seasonIntegration = options;
      return { close: async () => { state.seasonIntegrationClosed = true; } };
    } };
    if (name.startsWith('node:')) return require(name);
    throw new Error(`Unexpected module: ${name}`);
  };
  t.after(() => {
    appEvents.emit('will-quit');
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  options.prepare?.({dataPath,root});
  vm.runInNewContext(MAIN_SOURCE, {
    require: customRequire, __dirname: path.dirname(MAIN_PATH),
    process: { env: { REVIEWOPS_DATA_DIR: dataPath }, platform: process.platform, arch: process.arch },
    URL, Response, Buffer, console, setImmediate, setTimeout, clearTimeout
  }, { filename: MAIN_PATH, timeout: 5000 });
  await state.startup;
  assert.deepEqual(state.startupErrors, []);
  assert(state.window);
  const handler = handlers.get('reviewops:invoke');
  assert.equal(typeof handler, 'function');
  const event = () => ({ sender: state.window.webContents, senderFrame: state.window.webContents.mainFrame });
  const invoke = (action, payload = {}, sender = event()) => handler(sender, action, payload);
  const success = async (action, payload) => {
    const result = await invoke(action, payload);
    assert.equal(result.ok, true, result.error?.message);
    // VM creates objects in another realm; return plain local values to assertions.
    return result.data === undefined ? undefined : JSON.parse(JSON.stringify(result.data));
  };
  return { root, dataPath, state, invoke, success, event };
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

test('Season AI navigation preserves data and moves an already fullscreen window to the requested display', async t => {
  const h = await harness(t);
  const { review, project } = await seed(h);
  const before = await h.success('snapshot');
  h.state.window.fullScreen = true;
  const bounds = {x:1440,y:0,width:1920,height:1080};
  const result = await h.state.seasonIntegration.showReview({ reviewId: review.id, fullscreen: true, displayBounds: bounds });
  assert.equal(result.shown, true); assert.equal(result.fullscreen, true);
  assert.equal(result.view,'project');assert.equal(result.projectId,project.id);assert.equal(result.reviewId,review.id);
  assert.deepEqual(h.state.window.getBounds(), bounds);
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
  const pending=await h.success('integration.pending');
  assert.equal(pending.projectId,project.id);assert.equal(pending.view,'project');assert.equal(completed,false);
  for(const mismatch of [{view:'home'},{projectId:'another-project'},{reviewId:'another-review'},{request:pending.request-1},{section:'settings'}]){
    assert.deepEqual(await h.success('integration.displayed',{...pending,section:'review',...mismatch}),{accepted:false});
    assert.equal(completed,false);
  }
  assert.deepEqual(await h.success('integration.displayed',{...pending,section:'review'}),{accepted:true});
  assert.equal((await showing).shown,true);
});

test('Season AI rejects a missing project and reports a closed renderer before showing a review',async t=>{
  const h=await harness(t,{manualSeasonAcknowledgment:true});
  const {review}=await seed(h);
  await assert.rejects(h.state.seasonIntegration.showReview({reviewId:review.id,projectId:'another-project',fullscreen:false}),/프로젝트/);
  const showing=h.state.seasonIntegration.showReview({reviewId:review.id,fullscreen:false});
  const rejected=assert.rejects(showing,/창이 닫혔습니다/);
  h.state.window.close();
  await rejected;
});

test('Season AI replaces an unacknowledged route and ignores its late acknowledgment',async t=>{
  const h=await harness(t,{manualSeasonAcknowledgment:true});
  const first=await seed(h),second=await seed(h);
  const showingFirst=h.state.seasonIntegration.showReview({reviewId:first.review.id,fullscreen:false});
  const firstRequest=await h.success('integration.pending');
  const rejected=assert.rejects(showingFirst,/다른 프로젝트/);
  const showingSecond=h.state.seasonIntegration.showReview({reviewId:second.review.id,fullscreen:false});
  const secondRequest=await h.success('integration.pending');
  await rejected;
  assert(secondRequest.request>firstRequest.request);
  assert.deepEqual(await h.success('integration.displayed',{...firstRequest,section:'review'}),{accepted:false});
  assert.deepEqual(await h.success('integration.displayed',{...secondRequest,section:'review'}),{accepted:true});
  assert.equal((await showingSecond).reviewId,second.review.id);
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
 await h.success('service.save',{id:target.service.id,agentEnabled:1});await h.success('service.save',{id:keep.service.id,agentEnabled:1});
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
    assert.match(result.error.message, /창이 닫혔습니다/);
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

test('agent materials expose generated instructions and only shared files from the same group',async t=>{
 const h=await harness(t),{group,review}=await seed(h),otherProject=await h.success('project.save',{groupId:group.id,name:'같은 그룹'}),other=await h.success('review.save',{projectId:otherProject.id,title:'공용 자료'}),shared=await addFile(h,other.id,'shared bytes');
 const outsideGroup=await h.success('group.save',{name:'다른 그룹'}),outsideProject=await h.success('project.save',{groupId:outsideGroup.id,name:'다른 프로젝트'}),outside=await h.success('review.save',{projectId:outsideProject.id,title:'공유 제외'}),hidden=await addFile(h,outside.id,'hidden bytes');
 await h.success('review.save',{id:review.id,evidence:syntheticEvidence('selected log')});
 const materials=await h.success('agent.materials',{reviewId:review.id});
 assert.match(materials.instruction.markdown,/# 에이전트 작업 지시서/);assert.match(materials.instruction.markdown,/보존할 내용/);assert.equal(materials.logs.length,1);
 assert.deepEqual(materials.sharedFiles.map(item=>item.id),[shared.id]);assert.equal(materials.sharedFiles.some(item=>item.id===hidden.id),false);
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
