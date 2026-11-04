'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createStore } = require('../electron/store.cjs');
const { createToolIntegration, toolSocketPath, publicConnectionInfo } = require('../electron/tool-integration.cjs');

function connectionMetadata(dataPath, overrides={}) {
  return {instanceId:'11111111-1111-4111-8111-111111111111',version:'1.4.0',build:{channel:'stable',version:'1.4.0'},isPackaged:true,platform:process.platform,arch:process.arch,
    dataPath,homePath:path.dirname(dataPath),appPath:path.join(dataPath,'ReviewOps.app','Contents','Resources','app.asar'),executablePath:path.join(dataPath,'ReviewOps.app','Contents','MacOS','ReviewOps'),dataRootSource:'environment',
    qa:{protocolVersion:1,actions:['open','state','click','type','key','scroll','capture','navigate','reload','close','release'],bindingFields:['sessionId','projectId','windowId'],optionalBrowserId:true,documentGeneration:false},...overrides};
}

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
async function fixture(withConnectionInfo=false) {
  const directory = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'reviewops-tools-'));
  const dbPath = path.join(directory, 'reviews.sqlite');
  let store = createStore({ dbPath }), bridge, connection, display = async value => ({ ...value, windowId: 'window-' + (100 + shown.length), shown: true }), beforeDispatch;
  const calls = [], shown = [];
  const group = store.saveGroup({ name: '검사 그룹' });
  async function addProject(name, options = {}) {
    const rootPath = options.rootPath || path.join(directory, name); if ((options.kind || 'local') === 'local') await fs.mkdir(rootPath, { recursive: true });
    const service = store.saveService({ groupId: group.id, name, kind: 'local', rootPath, ...options });
    const project = store.saveProject({ groupId: group.id, name, serviceIds: [service.id] });
    return { project, service };
  }
  const first = await addProject('첫 프로젝트'), second = await addProject('다른 프로젝트');
  async function start() {
    bridge = await createToolIntegration({ dataPath: directory, dispatch: async (action, payload) => {
      calls.push({ action, payload }); if (beforeDispatch) await beforeDispatch(action, payload);
      if (action === 'snapshot') return store.snapshot();
      if (action === 'review.save') return store.saveReview(payload);
      throw new Error(`Unexpected action: ${action}`);
    }, showReview: async value => { shown.push(value); return display(value); }, displayTimeoutMs: 1000,connectionInfo:withConnectionInfo?connectionMetadata(directory,typeof withConnectionInfo==='object'?withConnectionInfo:{}):undefined,
      automationHandler:withConnectionInfo?()=>{throw new Error('Connection information must not invoke QA');}:undefined });
    connection = JSON.parse(await fs.readFile(bridge.connectionPath, 'utf8'));
  }
  await start();
  function invoke(action, payload = {}, options = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(connection.socketPath); socket.setEncoding('utf8'); let input = '', settled = false;
      const finish = (error, result) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result); };
      socket.setTimeout(3000, () => finish(new Error('fixture request timed out')));
      socket.on('error', error => finish(error));
      socket.on('connect', () => {
        const bytes = Buffer.from(JSON.stringify({ token: options.token ?? connection.token, action, payload }) + '\n');
        if (options.split) { const cut = bytes.indexOf(Buffer.from(options.split)) + 1; socket.write(bytes.subarray(0, cut)); setImmediate(() => socket.write(bytes.subarray(cut))); }
        else socket.write(bytes);
      });
      socket.on('data', chunk => { input += chunk; if (input.includes('\n')) { try { finish(null, JSON.parse(input.slice(0, input.indexOf('\n')))); } catch (error) { finish(error); } } });
      socket.on('close', () => { if (!settled) finish(new Error('fixture connection closed')); });
    });
  }
  return { directory, first, second, calls, shown, addProject, invoke, get store() { return store; }, get connection() { return connection; }, get bridge() { return bridge; },
    display(callback) { display = callback; }, beforeDispatch(callback) { beforeDispatch = callback; },
    payload(requestId = 'request-1', projectId = first.project.id) { return { requestId, projectId, title: '화면 검토', body: '한글과 日本語 내용을 확인하십시오.', tool: 'codex' }; },
    async restart({ forgetRequests = false } = {}) { await bridge.close(); store.close(); if (forgetRequests) await fs.rm(path.join(directory, 'integrations', 'tools-state.json')); store = createStore({ dbPath }); await start(); },
    async close() { await bridge.close(); store.close(); await fs.rm(directory, { recursive: true, force: true }); }
  };
}

test('connection information is a fresh scalar allowlist with home-boundary redaction',()=>{
  for(const platform of ['darwin','win32']){
    const paths=platform==='win32'?path.win32:path.posix,home=platform==='win32'?'C:\\Users\\sample':'/Users/sample',data=paths.join(home,'data');
    const metadata=connectionMetadata(data,{platform,homePath:home,appPath:paths.join(home+'-other','ReviewOps.app'),executablePath:paths.join(home,'bin','ReviewOps')});
    Object.defineProperty(metadata,'credentials',{get(){throw new Error('Private extras must not be traversed');}});
    const result=publicConnectionInfo(metadata,data);
    assert.deepEqual(Object.keys(result),['schema','instanceId','app','location','qa']);
    assert.deepEqual(Object.keys(result.app),['version','displayVersion','isPackaged','platform','arch','build']);
    assert.deepEqual(result.location,{dataRootSource:'environment',dataPath:'$HOME'+paths.sep+'data',appPath:paths.join(home+'-other','ReviewOps.app'),executablePath:'$HOME'+paths.sep+'bin'+paths.sep+'ReviewOps',homeRedacted:true});
    assert.deepEqual(result.app.build,{channel:'stable',version:'1.4.0',buildNumber:null,developmentNumber:null,commit:null,builtAt:null});
    result.qa.actions.push('focus');result.app.build.commit='fabricated';assert.equal(publicConnectionInfo(metadata,data).qa.actions.length,11);assert.equal(publicConnectionInfo(metadata,data).app.build.commit,null);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<16*1024);
  }
});

test('connection information preserves actual test build identity without inventing stable source metadata',()=>{
  const data=path.resolve('/tmp/connection-info'),build={channel:'test',version:'1.4.0',buildNumber:12345,developmentNumber:7,commit:'a'.repeat(40),builtAt:'2026-11-03T00:00:00.000Z'};
  const result=publicConnectionInfo(connectionMetadata(data,{isPackaged:false,build}),data);
  assert.equal(result.app.displayVersion,'1.4.0-dev-7');assert.equal(result.app.isPackaged,false);assert.deepEqual(result.app.build,build);
  assert.throws(()=>publicConnectionInfo(connectionMetadata(data,{build:{...build,version:'1.3.0'}}),data),{code:'CONNECTION_INFO_UNAVAILABLE'});
  assert.throws(()=>publicConnectionInfo(connectionMetadata(data,{build:{channel:'stable',version:'1.4.0',commit:'a'.repeat(40)}}),data),{code:'CONNECTION_INFO_UNAVAILABLE'});
});

test('connection metadata rejects malformed identities and UTF-8 path overflow without truncation',()=>{
  const data=path.resolve('/tmp/connection-info'),metadata=connectionMetadata(data);
  for(const patch of [{instanceId:'pid-123'},{isPackaged:null},{homePath:'relative'},{dataPath:data+'-other'},{dataRootSource:'guessed'},{appPath:'/tmp/invalid\npath'},{appPath:path.parse(data).root+'한'.repeat(1400)},{qa:{...metadata.qa,documentGeneration:true}},{qa:{...metadata.qa,actions:['open','open']}}])
    assert.throws(()=>publicConnectionInfo({...metadata,...patch},data),{code:'CONNECTION_INFO_UNAVAILABLE'});
});

test('authenticated connection.info never dispatches data or windows and rejects every supplied field',async()=>{
  const f=await fixture(true);try{
    f.beforeDispatch(()=>{throw new Error('Connection metadata must not dispatch');});
    const before=await fs.readFile(f.bridge.connectionPath),listed=await f.invoke('connection.info');
    assert.equal(listed.ok,true);assert.equal(listed.data.app.version,'1.4.0');assert.equal(listed.data.location.dataPath,'$HOME'+path.sep+path.basename(f.directory));
    assert.equal(JSON.stringify(listed).includes(f.connection.token),false);
    assert.deepEqual(Object.keys(f.connection),['version','socketPath','token','pid']);
    const again=await f.invoke('connection.info');assert.deepEqual(again,listed);assert.deepEqual(await fs.readFile(f.bridge.connectionPath),before);
    for(const payload of [{projectId:f.first.project.id},{action:'snapshot'},{force:true},{dataPath:f.directory}])assert.equal((await f.invoke('connection.info',payload)).error.code,'INVALID_REQUEST');
    for(const payload of [null,false,0,'',[]])assert.equal((await f.invoke('connection.info',payload)).error.code,'INVALID_REQUEST');
    assert.equal((await f.invoke('connection.info',{}, {token:'0'.repeat(64)})).error.code,'UNAUTHORIZED');
    assert.deepEqual(f.calls,[]);assert.deepEqual(f.shown,[]);
  }finally{await f.close();}
});

test('legacy bridge factories retain their operations with absent or malformed connection metadata',async()=>{
  for(const input of [false,{instanceId:'invalid'}]){
    const f=await fixture(input);try{
      assert.equal((await f.invoke('connection.info')).error.code,'CONNECTION_INFO_UNAVAILABLE');
      assert.equal((await f.invoke('projects.list')).ok,true);
    }finally{await f.close();}
  }
});

test('local socket lists only project connection labels and creates a review without starting an agent', async () => {
  const f = await fixture();
  try {
    const privateKeyPath = path.join(f.directory, 'private-key');
    await f.addProject('SSH 검사', { kind: 'ssh', rootPath: '/srv/project', host: 'private-host.invalid', username: 'private-user', privateKeyPath });
    const listed = await f.invoke('projects.list'); assert.equal(listed.ok, true);
    assert.equal(listed.data.length, 3); assert.equal(listed.data[0].connections[0].kind, 'local');
    for (const secret of ['private-host.invalid', 'private-user', 'private-key', f.connection.token]) assert.ok(!JSON.stringify(listed).includes(secret));
    const result = await f.invoke('review.open', f.payload(), { split: '한글' });
    assert.equal(result.ok, true); assert.equal(result.data.status, 'shown'); assert.equal(result.data.projectId, f.first.project.id);
    assert.equal(f.store.snapshot().reviews.length, 1); assert.equal(f.store.get('reviews', result.data.reviewId).evidence.toolIntegration.requestId, 'request-1');
    assert.deepEqual(f.shown[0], { projectId: f.first.project.id, reviewId: result.data.reviewId, fullscreen: false });
    assert.ok(f.calls.every(call => ['snapshot', 'review.save'].includes(call.action)));
    if (process.platform !== 'win32') for (const filename of ['tools.json', 'tools.sock', 'tools-state.json']) assert.equal((await fs.stat(path.join(f.directory, 'integrations', filename))).mode & 0o777, 0o600);
    assert.equal((await f.invoke('review.status', { requestId: 'request-1' })).data.reviewId, result.data.reviewId);
  } finally { await f.close(); }
});

test('socket rejects missing credentials, unsupported actions and malformed request fields', async () => {
  const f = await fixture();
  try {
    const unauthorized = await f.invoke('projects.list', {}, { token: 'x'.repeat(64) }); assert.equal(unauthorized.error.code, 'UNAUTHORIZED'); assert.equal(f.calls.length, 0);
    assert.equal((await f.invoke('task.start', {})).error.code, 'UNKNOWN_ACTION');
    for (const payload of [{ ...f.payload(), requestId: '__proto__' }, { ...f.payload(), workspacePath: f.first.service.rootPath }, { ...f.payload(), execute: true }, { ...f.payload(), projectId: undefined, workspacePath: 'relative/path' }, { ...f.payload(), reviewId: 'review-id' }]) {
      assert.equal((await f.invoke('review.open', payload)).ok, false);
    }
    assert.equal(f.store.snapshot().reviews.length, 0); assert.equal(f.shown.length, 0);
  } finally { await f.close(); }
});

test('missing and ambiguous targets retain payloads and can be retried after an unambiguous project exists', async () => {
  const f = await fixture();
  try {
    const missing = { ...f.payload('missing'), projectId: undefined };
    assert.equal((await f.invoke('review.open', missing)).data.status, 'needs_project');
    const saved = (await f.invoke('review.status', { requestId: 'missing' })).data;
    assert.equal(saved.payload.body, missing.body); assert.equal(saved.reviewId, null); assert.equal(f.store.snapshot().reviews.length, 0);
    const duplicate = f.store.saveProject({ groupId: f.first.project.groupId, name: '중복 폴더', serviceIds: [f.first.service.id] });
    const payload = { ...f.payload('ambiguous'), projectId: undefined, workspacePath: f.first.service.rootPath };
    assert.equal((await f.invoke('review.open', payload)).data.status, 'needs_project'); assert.equal(f.shown.length, 0);
    f.store.deleteProject(duplicate.id);
    const result = await f.invoke('review.open', payload); assert.equal(result.data.status, 'shown'); assert.equal(result.data.projectId, f.first.project.id);
    assert.equal((await f.invoke('review.open', { ...missing, projectId: f.first.project.id })).error.code, 'REQUEST_ID_CONFLICT');
  } finally { await f.close(); }
});

test('explicit connection ownership and real local paths determine the target without a fallback', async () => {
  const f = await fixture();
  try {
    f.store.saveProject({ id: f.first.project.id, serviceIds: [f.first.service.id, f.second.service.id] });
    assert.equal((await f.invoke('review.open', f.payload('multi'))).data.status, 'needs_project');
    const selected = await f.invoke('review.open', { ...f.payload('selected'), serviceId: f.first.service.id });
    assert.equal(selected.data.status, 'shown'); assert.equal(selected.data.serviceId, f.first.service.id);
    const wrong = await f.invoke('review.open', { ...f.payload('wrong', f.second.project.id), serviceId: f.first.service.id });
    assert.equal(wrong.data.status, 'needs_project');
    const alias = path.join(f.directory, 'folder-alias'); await fs.symlink(f.first.service.rootPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await f.invoke('review.open', { ...f.payload('alias'), projectId: undefined, workspacePath: alias });
    assert.equal(result.data.status, 'shown'); assert.equal(result.data.projectId, f.first.project.id);
    const ssh = await f.addProject('SSH', { kind: 'ssh', rootPath: '/srv/project', host: 'example.invalid', username: 'fixture' });
    const local = await f.invoke('review.open', { ...f.payload('local-only'), projectId: undefined, workspacePath: f.second.service.rootPath, serviceId: ssh.service.id });
    assert.equal(local.data.status, 'needs_project');
  } finally { await f.close(); }
});

test('an explicit project opens a review with a missing folder while workspace selection still requires a real path', async () => {
  const f = await fixture();
  try {
    const missingPath = path.join(f.directory, 'not-created');
    f.store.saveService({ id: f.first.service.id, rootPath: missingPath });
    const explicit = await f.invoke('review.open', f.payload('missing-folder-explicit'));
    assert.equal(explicit.data.status, 'shown'); assert.equal(explicit.data.projectId, f.first.project.id); assert.equal(explicit.data.serviceId, f.first.service.id);
    const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'integrations', 'tools-state.json'), 'utf8'));
    assert.equal(saved.requests.find(record => record.payload.requestId === 'missing-folder-explicit').binding.workPath, missingPath);
    const byPath = await f.invoke('review.open', { ...f.payload('missing-folder-path'), projectId: undefined, workspacePath: missingPath });
    assert.equal(byPath.data.status, 'needs_project'); assert.equal(byPath.data.reviewId, null);
    assert.equal(f.store.snapshot().reviews.length, 1); assert.equal(f.shown.length, 1);
    const retried = await f.invoke('review.open', f.payload('missing-folder-explicit'));
    assert.equal(retried.data.status, 'shown'); assert.equal(retried.data.reviewId, explicit.data.reviewId);
    for (const [index, storedPath] of ['relative-legacy-folder', ''].entries()) {
      // Earlier or imported data may lack an absolute path. Do not resolve it
      // against the app's cwd when the project and connection are explicit.
      f.store.db.prepare('UPDATE services SET rootPath=?,agentWorkPath=? WHERE id=?').run(storedPath, '', f.first.service.id);
      const request = { ...f.payload(`legacy-path-${index}`), serviceId: f.first.service.id };
      assert.equal((await f.invoke('review.open', request)).data.status, 'shown');
      const latest = JSON.parse(await fs.readFile(path.join(f.directory, 'integrations', 'tools-state.json'), 'utf8'));
      assert.equal(latest.requests.find(record => record.payload.requestId === request.requestId).binding.workPath, storedPath);
    }
    assert.ok(f.calls.every(call => ['snapshot', 'review.save'].includes(call.action)));
  } finally { await f.close(); }
});

test('concurrent duplicate IDs share one display while a different project and status request proceed', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.display(async value => { if (value.projectId === f.first.project.id) { entered.resolve(); await release.promise; } return { ...value, windowId: value.projectId === f.first.project.id ? 'window-101' : 'window-102', shown: true }; });
    const first = f.invoke('review.open', f.payload('parallel'));
    await entered.promise;
    const duplicate = f.invoke('review.open', f.payload('parallel'));
    assert.equal((await f.invoke('review.open', { ...f.payload('parallel'), body: '다른 내용' })).error.code, 'REQUEST_ID_CONFLICT');
    assert.equal((await f.invoke('review.status', { requestId: 'parallel' })).data.status, 'opening');
    const other = await f.invoke('review.open', f.payload('other-project', f.second.project.id));
    assert.equal(other.data.status, 'shown'); assert.equal(other.data.windowId, 'window-102');
    release.resolve(); const results = await Promise.all([first, duplicate]);
    assert.deepEqual(results[0], results[1]); assert.equal(results[0].data.status, 'shown');
    assert.equal(f.store.snapshot().reviews.length, 2); assert.equal(f.shown.filter(item => item.projectId === f.first.project.id).length, 1);
  } finally { release.resolve(); await f.close(); }
});

test('display failure and a modified review retain the original review when retried', async () => {
  const f = await fixture();
  try {
    f.display(async () => { throw new Error('창 표시 실패'); });
    const first = await f.invoke('review.open', f.payload('retry')); assert.equal(first.data.status, 'display_failed'); assert.ok(first.data.reviewId);
    f.store.saveReview({ id: first.data.reviewId, body: '사용자가 앱에서 수정한 내용' });
    f.display(async value => ({ ...value, windowId: 'window-9', shown: true }));
    const second = await f.invoke('review.open', f.payload('retry')); assert.equal(second.data.status, 'shown'); assert.equal(second.data.reviewId, first.data.reviewId);
    assert.equal(f.store.get('reviews', first.data.reviewId).body, '사용자가 앱에서 수정한 내용'); assert.equal(f.store.snapshot().reviews.length, 1);
    assert.equal((await f.invoke('review.open', { ...f.payload('retry'), projectId: f.second.project.id })).error.code, 'REQUEST_ID_CONFLICT');
  } finally { await f.close(); }
});

test('a wrong displayed project and a display timeout are never reported as shown', async () => {
  const f = await fixture();
  try {
    f.display(async value => ({ ...value, projectId: f.second.project.id, windowId: 'window-8', shown: true }));
    assert.equal((await f.invoke('review.open', f.payload('wrong-window'))).data.status, 'display_failed');
    f.display(() => new Promise(() => {}));
    assert.equal((await f.invoke('review.open', f.payload('timeout'))).data.status, 'display_failed');
    assert.equal(f.store.snapshot().reviews.length, 2);
  } finally { await f.close(); }
});

test('restart rotates credentials and preserves unresolved requests and review identity', async () => {
  const f = await fixture();
  try {
    const first = await f.invoke('review.open', f.payload('restart')); const oldToken = f.connection.token;
    const unresolved = { ...f.payload('unresolved'), projectId: undefined }; await f.invoke('review.open', unresolved);
    await f.restart(); assert.notEqual(f.connection.token, oldToken);
    assert.equal((await f.invoke('projects.list', {}, { token: oldToken })).error.code, 'UNAUTHORIZED');
    const before = (await f.invoke('review.status', { requestId: 'restart' })).data; assert.equal(before.status, 'display_failed'); assert.equal(before.windowId, null);
    assert.equal((await f.invoke('review.status', { requestId: 'unresolved' })).data.status, 'needs_project');
    const again = await f.invoke('review.open', f.payload('restart')); assert.equal(again.data.reviewId, first.data.reviewId); assert.equal(again.data.status, 'shown');
    assert.equal(f.store.snapshot().reviews.length, 1);
  } finally { await f.close(); }
});

test('review evidence recovers a committed review after request-state loss without poisoning its request ID', async () => {
  const f = await fixture();
  try {
    const first = await f.invoke('review.open', f.payload('recover'));
    await f.restart({ forgetRequests: true });
    assert.equal((await f.invoke('review.open', { ...f.payload('recover'), body: '다른 내용' })).error.code, 'REQUEST_ID_CONFLICT');
    const retry = await f.invoke('review.open', f.payload('recover')); assert.equal(retry.data.status, 'shown'); assert.equal(retry.data.reviewId, first.data.reviewId);
    assert.equal(f.store.snapshot().reviews.length, 1);
  } finally { await f.close(); }
});

test('deleted reviews and changed work folders are retained as needs_project without creating replacements', async () => {
  const f = await fixture();
  try {
    const first = await f.invoke('review.open', f.payload('deleted')); f.store.deleteReview(first.data.reviewId);
    const result = await f.invoke('review.open', f.payload('deleted')); assert.equal(result.data.status, 'needs_project'); assert.equal(result.data.reviewId, first.data.reviewId); assert.equal(f.store.snapshot().reviews.length, 0);
    const changed = await f.invoke('review.open', f.payload('changed'));
    f.store.saveService({ id: f.first.service.id, rootPath: f.second.service.rootPath });
    const blocked = await f.invoke('review.open', f.payload('changed')); assert.equal(blocked.data.status, 'needs_project'); assert.equal(blocked.data.reviewId, changed.data.reviewId);
    assert.equal(f.shown.length, 2);
  } finally { await f.close(); }
});

test('existing reviews require the matching explicit project and do not get replaced', async () => {
  const f = await fixture();
  try {
    const review = f.store.saveReview({ projectId: f.first.project.id, title: '기존 리뷰', body: '' });
    const payload = { requestId: 'existing', projectId: f.first.project.id, reviewId: review.id, tool: 'hermes' };
    const result = await f.invoke('review.open', payload); assert.equal(result.data.status, 'shown'); assert.equal(result.data.reviewId, review.id);
    const wrong = await f.invoke('review.open', { ...payload, requestId: 'wrong-existing', projectId: f.second.project.id }); assert.equal(wrong.data.status, 'needs_project');
    assert.equal(f.store.snapshot().reviews.length, 1);
  } finally { await f.close(); }
});

test('changing an SSH destination prevents a retry from opening the old request against a different target', async () => {
  const f = await fixture();
  try {
    const original = { kind: 'ssh', rootPath: '/srv/project', host: 'first.invalid', hostAlias: 'first', port: 22, username: 'tester', sshConfigPath: path.join(f.directory, 'ssh-config'), privateKeyPath: path.join(f.directory, 'key-do-not-store') };
    const remote = await f.addProject('원격 프로젝트', original);
    for (const [field, value] of Object.entries({ host: 'other.invalid', hostAlias: 'other', port: 2200, username: 'other-user', sshConfigPath: path.join(f.directory, 'other-ssh-config') })) {
      f.store.saveService({ id: remote.service.id, ...original });
      const payload = f.payload(`remote-${field}`, remote.project.id);
      const first = await f.invoke('review.open', payload); assert.equal(first.data.status, 'shown');
      f.store.saveService({ id: remote.service.id, [field]: value });
      const retry = await f.invoke('review.open', payload); assert.equal(retry.data.status, 'needs_project', field); assert.equal(retry.data.reviewId, first.data.reviewId);
    }
    const saved = await fs.readFile(path.join(f.directory, 'integrations', 'tools-state.json'), 'utf8');
    assert.ok(!saved.includes('key-do-not-store')); assert.ok(!saved.includes(f.connection.token));
    assert.equal(f.shown.length, 5);
  } finally { await f.close(); }
});

test('a database-save failure keeps the request and retries without losing its content', async () => {
  const f = await fixture();
  try {
    let failSave = true;
    f.beforeDispatch(action => { if (action === 'review.save' && failSave) throw new Error('합성 저장 실패'); });
    const first = await f.invoke('review.open', f.payload('save-failure'));
    assert.equal(first.data.status, 'display_failed'); assert.equal(first.data.reviewId, null); assert.equal(first.data.payload.body, f.payload().body);
    assert.equal(f.shown.length, 0); assert.equal(f.store.snapshot().reviews.length, 0);
    failSave = false;
    const retry = await f.invoke('review.open', f.payload('save-failure')); assert.equal(retry.data.status, 'shown'); assert.equal(f.store.snapshot().reviews.length, 1);
  } finally { await f.close(); }
});

function cli(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../skills/reviewops/scripts/reviewops.mjs'), ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; }); child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input ?? {}));
  });
}
test('standalone CLI uses JSON stdin and data-dir overrides without printing the connection token', async () => {
  const f = await fixture();
  try {
    const list = await cli(['list', '--data-dir', f.directory], {}); assert.equal(list.code, 0); assert.equal(JSON.parse(list.stdout).data.length, 2);
    const opened = await cli(['open'], f.payload('cli'), { REVIEWOPS_DATA_DIR: f.directory }); assert.equal(opened.code, 0); assert.equal(JSON.parse(opened.stdout).data.status, 'shown');
    const status = await cli(['status', '--data-dir', f.directory], { requestId: 'cli' }); assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).data.reviewId, JSON.parse(opened.stdout).data.reviewId);
    const invalid = await cli(['open', '--data-dir', f.directory], '{bad-json'); assert.equal(invalid.code, 1); assert.match(invalid.stderr, /JSON/);
    const appPath = await cli(['list', '--data-dir', '/Applications/ReviewOps.app'], {}); assert.equal(appPath.code, 1); assert.match(appPath.stderr, /데이터 폴더/);
    for (const result of [list, opened, status, invalid, appPath]) assert.ok(!(result.stdout + result.stderr).includes(f.connection.token));
    await fs.writeFile(f.bridge.connectionPath, `{"token":"${f.connection.token}", broken}`);
    const malformed = await cli(['list', '--data-dir', f.directory], {}); assert.equal(malformed.code, 1); assert.ok(!malformed.stderr.includes(f.connection.token));
  } finally { await f.close(); }
});

test('Windows named pipe and CLI accept the same data and work folders with different casing', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const alternateDataPath = f.directory.toUpperCase(), alternateWorkPath = f.first.service.rootPath.toUpperCase();
    for (const [original, alternate] of [[f.directory, alternateDataPath], [f.first.service.rootPath, alternateWorkPath]]) {
      assert.notEqual(original, alternate);
      const [originalStat, alternateStat] = await Promise.all([fs.stat(original), fs.stat(alternate)]);
      assert.equal(alternateStat.dev, originalStat.dev); assert.equal(alternateStat.ino, originalStat.ino);
    }
    assert.equal(toolSocketPath(alternateDataPath), f.connection.socketPath);
    const list = await cli(['list', '--data-dir', alternateDataPath], {}); assert.equal(list.code, 0, list.stderr); assert.equal(JSON.parse(list.stdout).data.length, 2);
    const opened = await cli(['open', '--data-dir', alternateDataPath], { ...f.payload('cli-path-case'), projectId: undefined, workspacePath: alternateWorkPath });
    assert.equal(opened.code, 0, opened.stderr); assert.equal(JSON.parse(opened.stdout).data.status, 'shown'); assert.equal(JSON.parse(opened.stdout).data.projectId, f.first.project.id);
    const status = await cli(['status'], { requestId: 'cli-path-case' }, { REVIEWOPS_DATA_DIR: f.directory.toLowerCase() });
    assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).data.reviewId, JSON.parse(opened.stdout).data.reviewId);
    assert.equal(f.store.snapshot().reviews.length, 1);
    for (const result of [list, opened, status]) assert.ok(!(result.stdout + result.stderr).includes(f.connection.token));
  } finally { await f.close(); }
});

test('Windows server and client share a case-insensitive local named pipe while Unix paths stay unchanged', async () => {
  const { expectedSocket } = await import('../skills/reviewops/scripts/reviewops.mjs');
  const windowsPath = String.raw`C:\Users\Tester\AppData\Roaming\ReviewOps Local`;
  for (const equivalent of [windowsPath, windowsPath.toLowerCase(), windowsPath.toUpperCase(), 'c:/users/tester/AppData/Roaming/ReviewOps Local/.']) {
    assert.equal(toolSocketPath(equivalent, 'win32'), toolSocketPath(windowsPath, 'win32'));
    assert.equal(expectedSocket(equivalent, 'win32'), toolSocketPath(windowsPath, 'win32'));
  }
  const directory = path.resolve('/tmp/tool-address');
  assert.match(toolSocketPath(directory, 'win32'), /^\\\\\.\\pipe\\reviewops-tools-[a-f0-9]{32}$/);
  assert.notEqual(toolSocketPath(directory, 'win32'), toolSocketPath(directory + '-other', 'win32'));
  assert.equal(toolSocketPath(directory, 'darwin'), path.join(directory, 'integrations', 'tools.sock'));
  assert.equal(expectedSocket(directory, 'darwin'), toolSocketPath(directory, 'darwin'));
  assert.notEqual(toolSocketPath(directory, 'darwin'), toolSocketPath(directory.toUpperCase(), 'darwin'));
  assert.throws(() => toolSocketPath('/' + 'a'.repeat(110), 'darwin'), /경로가 너무 길어/);
});

test('optional discovery publishes only a capable explicit opt-in and final quit removes its own record synchronously', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/ro-publish-')); await fs.chmod(root, 0o700);
  const bridges = []; t.after(async () => { for (const bridge of bridges) await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function start(name, options = {}) {
    const dataPath = path.join(root, name); await fs.mkdir(dataPath, { mode: 0o700 });
    const bridge = await createToolIntegration({ dataPath, dispatch: async () => ({}), showReview: async () => ({}), automationHandler: async () => ({}), connectionInfo: connectionMetadata(dataPath), ...options });
    bridges.push(bridge); return bridge;
  }
  const registry = path.join(root, 'registry'), plain = await start('plain');
  assert.equal(await fs.stat(registry).then(() => true, () => false), false, 'Legacy callers must not implicitly publish');
  const invalid = await start('invalid', { discoveryDirectory: registry, connectionInfo: { instanceId: 'invalid' } });
  assert.equal(await fs.stat(registry).then(() => true, () => false), false, 'Invalid capabilities must not publish');
  const bridge = await start('capable', { discoveryDirectory: registry }), record = path.join(registry, '11111111-1111-4111-8111-111111111111.json');
  assert.ok(await fs.stat(record)); bridge.unregisterForFinalQuitSync(); assert.ok(await fs.stat(record), 'A vetoable running bridge cannot unregister');
  const closing = bridge.close(); bridge.unregisterForFinalQuitSync();
  assert.equal(require('node:fs').existsSync(record), false, 'Do not rely on an Electron exit awaiting the close Promise');
  await closing; await plain.close(); await invalid.close();
});

test('fresh discovered information preserves another client pending request and the current review draft', { skip: process.platform === 'win32' }, async t => {
  const { createConnectionInvoker } = require('../electron/mcp-server.cjs');
  const root = await fs.realpath(await fs.mkdtemp('/tmp/ro-active-')); await fs.chmod(root, 0o700);
  const dataPath = path.join(root, 'data'); await fs.mkdir(dataPath, { mode: 0o700 });
  const store = createStore({ dbPath: path.join(dataPath, 'reviews.sqlite') });
  const group = store.saveGroup({ name: 'Active A' }), service = store.saveService({ groupId: group.id, name: 'Local', kind: 'local', rootPath: root });
  const project = store.saveProject({ groupId: group.id, name: 'A project', serviceIds: [service.id] });
  const draft = store.saveReview({ projectId: project.id, title: 'A retained draft', body: 'Keep this content' });
  const entered = deferred(), release = deferred(), registry = path.join(root, 'registry'); let bridge, pending, requested = 0;
  t.after(async () => { release.resolve(); await pending?.catch(() => {}); await bridge?.close(); store.close(); await fs.rm(root, { recursive: true, force: true }); });
  bridge = await createToolIntegration({ dataPath, discoveryDirectory: registry, connectionInfo: connectionMetadata(dataPath),
    showReview: async value => ({ ...value, shown: true, windowId: 'window-A' }), automationHandler: async () => { throw new Error('No QA grant or action is needed'); },
    dispatch: async (action, payload) => { requested++; if (action === 'snapshot') return store.snapshot(); if (action === 'review.save') { entered.resolve(); await release.promise; return store.saveReview(payload); } throw new Error('Unexpected dispatch'); } });
  pending = bridge.handle('review.open', { requestId: 'A-retained-request', projectId: project.id, title: 'A pending request', body: 'Original A content', tool: 'codex' });
  await entered.promise;
  const before = store.snapshot(), descriptor = await fs.readFile(bridge.connectionPath), calls = requested;
  const invoke = createConnectionInvoker({ selection: 'platform-default', connectionPath: path.join(root, 'absent', 'integrations', 'tools.json') }, { directory: () => registry });
  const info = await invoke('connection.info', {});
  assert.equal(info.instanceId, connectionMetadata(dataPath).instanceId); assert.equal(requested, calls);
  assert.deepEqual(store.snapshot(), before); assert.equal(store.get('reviews', draft.id).body, 'Keep this content');
  assert.deepEqual(await fs.readFile(bridge.connectionPath), descriptor);
  release.resolve(); assert.equal((await pending).status, 'shown');
});
