'use strict';

// Real Store/facade tests with explicit protocol/provider doubles. These do not
// establish browser, TLS, native storage or cross-PC acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const https = require('node:https');
const net = require('node:net');
const {createRequire} = require('node:module');
const {createStore} = require('../electron/store.cjs');
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };
const publicIdentity = Object.freeze({deviceId:'test-only-device',address:'127.0.0.1',keyFingerprint:'a'.repeat(64),
  certificateFingerprint:'b'.repeat(64),validUntil:'2099-01-01T00:00:00.000Z'});

async function fixture(t, hooks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-remote-management-'));
  const store = createStore({dbPath:path.join(root,'owned.sqlite')});
  const group = store.saveGroup({name:'Owned fixture'});
  const project = store.saveProject({groupId:group.id,name:'Allowed project'});
  const foreign = store.saveProject({groupId:group.id,name:'Foreign project'});
  const review = store.saveReview({projectId:project.id,title:'Original review',body:'Owned body'});
  const f = {root,store,project,foreign,review,listeners:[],appListeners:[],events:[],queue:[],closed:false};
  let providerStatus = hooks.initialStatus || 'ready';
  const provider = {
    state() { return {status:providerStatus,backend:'electron-safe-storage',identity:providerStatus==='ready'?publicIdentity:null,errorCode:null}; },
    async initialize(input) { f.events.push('initialize'); await hooks.initialize?.(input); input.assertCurrent(); providerStatus='ready'; },
    publicCertificate() { return {...publicIdentity,certificatePEM:'-----BEGIN CERTIFICATE-----\nTEST_ONLY\n-----END CERTIFICATE-----\n'}; },
    async acquireServerTLS(input) {
      f.events.push('acquire'); await hooks.acquire?.(input);
      return {identity:publicIdentity,async release() { f.events.push('release'); await hooks.release?.(); }};
    },
    async closeAndDrain() { f.events.push('provider-close'); await hooks.closeProvider?.(); }
  };
  const filename=path.resolve(__dirname,'../electron/remote-management.cjs'), ordinaryRequire=createRequire(filename);
  const source=fs.readFileSync(filename,'utf8'), compiled=vm.runInThisContext(`(function(require,module,exports){${source}\n})`,{filename});
  const module={exports:{}};
  compiled(name=>{
    if(name==='./remote-web-assets.cjs')return {loadRemoteWebAssets(){f.events.push('assets');return {};}};
    if(name==='./remote-app-listener.cjs')return {createRemoteAppListener(options){
      const sessions=new Map();let running=false;
      const listener={options,
        async start(input){running=true;listener.address=input.address;listener.port=input.port;},
        state(){return {running,address:listener.address,port:listener.port,sessions:[...sessions.values()].map(row=>({
          id:row.id,label:'Test app',address:'127.0.0.1',state:row.approved?'approved':'pending',expiresAt:Date.now()+60000,grants:row.grants||[]}))};},
        createInvitation(){return {invitation:'TEST_ONLY_APP_SECRET',expiresAt:Date.now()+60000};},
        pending(id='pending-app'){const peer=Object.freeze(Object.create(null));sessions.set(id,{id,peer});return peer;},
        approve({id,grants}){const row=sessions.get(id);options.onApprove(row.peer,grants);row.approved=true;row.grants=grants;return listener.state().sessions.find(row=>row.id===id);},
        read(peer,name,payload){return options.onRead(peer,name,payload);},
        revoke({id}){const row=sessions.get(id);if(row){sessions.delete(id);options.onRevoke(row.peer);}return Boolean(row);},
        async close(){running=false;for(const id of [...sessions.keys()])listener.revoke({id});f.events.push('app-close');}
      };f.appListeners.push(listener);return listener;
    }};
    if(name==='./remote-web-listener.cjs')return {createWebReadListener(options){
      const sessions=new Map();let enabled=false,close;
      const listener={options,
        async listen(input){f.events.push('listen');await hooks.listen?.();enabled=true;listener.endpoint=`https://${input.address}:${input.port}/`;},
        state(){return {state:enabled?'listening':'closed',endpoint:{url:listener.endpoint},connections:[...sessions.values()]};},
        inviteBrowser(){return {invitationId:'test-invitation',secret:'TEST_ONLY_LOCAL_SECRET'};},
        pending(id='pending-browser'){
          const handle=Object.freeze(Object.create(null));
          const value={pendingId:id,pendingHandle:handle,clientName:'Test browser',createdAt:new Date().toISOString(),
            expiresAt:new Date(Date.now()+60000).toISOString()};
          sessions.set(handle,{pendingId:id,pendingHandle:handle,approved:false,connectionId:'connection-'+id,expiresAt:value.expiresAt});
          options.onPendingBrowser(value);return handle;
        },
        approveBrowser(handle,authority){Object.assign(sessions.get(handle),{approved:true,authority});},
        read(handle,name,payload){return options.onRead(sessions.get(handle).authority,name,payload);},
        disconnect(handle){const row=sessions.get(handle);if(row){sessions.delete(handle);options.onClosed({pendingId:row.pendingId,pendingHandle:handle,authorityHandle:row.authority||null});}},
        revoke(authority){for(const [handle,row]of sessions)if(row.authority===authority)listener.disconnect(handle);},
        stopAdmission(){enabled=false;f.events.push('stop');},
        closeAndDrain(){if(!close)close=(async()=>{enabled=false;await hooks.closeListener?.();
          for(const handle of [...sessions.keys()])listener.disconnect(handle);await options.tlsLease.release();f.events.push('listener-close');})();return close;}
      };f.listeners.push(listener);return listener;
    }};
    return ordinaryRequire(name);
  },module,module.exports);
  const enqueueRead=fn=>hooks.holdQueue?new Promise((resolve,reject)=>f.queue.push(()=>{try{resolve(fn());}catch(error){reject(error);}})):Promise.resolve().then(fn);
  f.manager=module.exports.createRemoteManagement({store,identityProvider:provider,assetDirectory:path.join(root,'dist'),enqueueRead,
    executeAgent(){throw new Error('This fixture does not execute agents.');}});
  f.input=extra=>({expectedGeneration:f.manager.state().generation,...extra});
  f.enable=()=>f.manager.configureWeb(f.input({bindAddress:'127.0.0.1',port:9443,enabled:true}),()=>{});
  f.approve=(id='pending-browser')=>{const listener=f.listeners.at(-1),handle=listener.pending(id);
    f.manager.approveBrowser(f.input({pendingId:id,projectIds:[project.id]}),()=>{});return {listener,handle};};
  f.enableApp=()=>f.manager.configureApp(f.input({bindAddress:'127.0.0.1',port:9444,enabled:true}),()=>{});
  f.approveApp=()=>{const listener=f.appListeners.at(-1),peer=listener.pending();
    f.manager.approveApp(f.input({id:'pending-app',grants:[{projectId:project.id,read:true,write:true,execute:false}]}),()=>{});
    return {listener,peer};};
  t.after(async()=>{try{await f.manager.closeAndDrain();}finally{try{store.close();}finally{fs.rmSync(root,{recursive:true,force:true});}}});
  return f;
}

test('remote coordinator is default off and rejects stale control generations before provider work',async t=>{
  const f=await fixture(t,{initialStatus:'not_initialized'}), state=f.manager.state();
  assert.equal(state.web.enabled,false);assert.equal(state.identity.status,'not_initialized');assert.deepEqual(f.events,[]);
  await assert.rejects(f.manager.configureWeb({expectedGeneration:0,bindAddress:'127.0.0.1',port:9443,enabled:true},()=>{}),{code:'STALE_REMOTE_REQUEST'});
  assert.deepEqual(f.events,[]);
  await f.manager.initializeIdentity(f.input({address:'127.0.0.1'}),()=>{});
  assert.equal(f.manager.state().identity.status,'ready');assert.deepEqual(f.events,['initialize']);
});

test('remote coordinator binds original browser authority to real selected-project DTOs',async t=>{
  const f=await fixture(t);await f.enable();const {listener,handle}=f.approve();
  const projects=await listener.read(handle,'projects.list',{});
  assert.deepEqual(projects.projects.map(row=>row.id),[f.project.id]);
  const reviews=await listener.read(handle,'reviews.list',{projectId:f.project.id});
  assert.deepEqual(reviews.reviews.map(row=>row.id),[f.review.id]);
  const detail=await listener.read(handle,'reviews.get',{projectId:f.project.id,reviewId:f.review.id});
  assert.equal(detail.review.body,'Owned body');
  await assert.rejects(listener.read(handle,'reviews.list',{projectId:f.foreign.id}),{code:'NOT_FOUND'});
  assert.throws(()=>listener.read(handle,'arbitrary.ipc',{}),{code:'ACCESS_DENIED'});
  const state=f.manager.state();assert.equal(state.connections.length,1);assert.equal(JSON.stringify(state).includes('TEST_ONLY_LOCAL_SECRET'),false);
});

test('remote coordinator revocation invalidates an already queued original read',async t=>{
  const f=await fixture(t,{holdQueue:true});await f.enable();const {listener,handle}=f.approve();
  const pending=listener.read(handle,'reviews.get',{projectId:f.project.id,reviewId:f.review.id});
  const refused=assert.rejects(pending,{code:'ACCESS_DENIED'});
  f.manager.revoke(f.input({principalId:f.manager.state().connections[0].principalId}),()=>{});
  assert.equal(f.queue.length,1);f.queue.shift()();await refused;
  assert.equal(f.manager.state().connections.length,0);
});

test('remote coordinator refuses project rebirth under a still-original session',async t=>{
  const f=await fixture(t);await f.enable();const {listener,handle}=f.approve();
  f.store.transaction(()=>{f.store.db.prepare('DELETE FROM reviews WHERE projectId=?').run(f.project.id);
    f.store.db.prepare('DELETE FROM projects WHERE id=?').run(f.project.id);
    f.store.db.prepare('INSERT INTO projects(id,groupId,name,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(f.project.id,f.project.groupId,'Replacement','',f.project.createdAt,f.project.updatedAt);});
  await assert.rejects(listener.read(handle,'reviews.list',{projectId:f.project.id}),error=>['NOT_FOUND','ACCESS_DENIED'].includes(error.code));
});

test('remote coordinator pause drains the same late lease before acknowledging cancelled enable',async t=>{
  const acquire=gate(),entered=gate(),release=gate();
  const f=await fixture(t,{acquire:async()=>{entered.resolve();await acquire.promise;},release:()=>release.promise});
  let enabling,pausing,settled=false;
  try{
    enabling=f.enable();const refused=assert.rejects(enabling,{code:'STALE_REMOTE_REQUEST'});await entered.promise;
    pausing=f.manager.pause().then(()=>{settled=true;});acquire.resolve();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.deepEqual(f.events,['assets','acquire','release']);
    release.resolve();await Promise.all([refused,pausing]);assert.equal(f.manager.state().web.enabled,false);
  }finally{acquire.resolve();release.resolve();await Promise.allSettled([enabling,pausing].filter(Boolean));}
});

test('remote coordinator final close waits listener then provider before retiring the real Store',async t=>{
  const provider=gate(),entered=gate();const f=await fixture(t,{closeProvider:async()=>{entered.resolve();await provider.promise;}});
  await f.enable();f.approve();let closing;
  try{
    closing=f.manager.closeAndDrain();assert.equal(closing,f.manager.closeAndDrain());await entered.promise;
    assert.equal(f.manager.storeClosed(),false);assert.equal(f.store.get('reviews',f.review.id).body,'Owned body');
    assert.ok(f.events.indexOf('listener-close')<f.events.indexOf('provider-close'));
    provider.resolve();await closing;assert.equal(f.manager.storeClosed(),true);
    assert.throws(()=>f.store.snapshot());
  }finally{provider.resolve();if(closing)await closing;}
});

test('remote coordinator web and app owners share one facade without sharing session authority',async t=>{
  const f=await fixture(t);await f.enable();const browser=f.approve();await f.enableApp();const app=f.approveApp();
  assert.equal((await app.listener.read(app.peer,'reviews.get',{projectId:f.project.id,reviewId:f.review.id})).review.body,'Owned body');
  assert.throws(()=>app.listener.read(browser.handle,'projects.list',{}),{code:'ACCESS_DENIED'});
  await f.manager.configureWeb(f.input({bindAddress:'127.0.0.1',port:9443,enabled:false}),()=>{});
  assert.equal(f.manager.state().app.enabled,true);
  assert.deepEqual((await app.listener.read(app.peer,'projects.list',{})).projects.map(row=>row.id),[f.project.id]);
  f.manager.revokeApp(f.input({id:'pending-app'}),()=>{});
  assert.throws(()=>app.listener.read(app.peer,'projects.list',{}),{code:'ACCESS_DENIED'});
});

test('remote coordinator app shutdown leaves the original browser capability usable',async t=>{
  const f=await fixture(t);await f.enable();const browser=f.approve();await f.enableApp();f.approveApp();
  await f.manager.configureApp(f.input({bindAddress:'127.0.0.1',port:9444,enabled:false}),()=>{});
  assert.equal(f.manager.state().web.enabled,true);assert.equal(f.manager.state().app.enabled,false);
  assert.equal((await browser.listener.read(browser.handle,'reviews.get',{projectId:f.project.id,reviewId:f.review.id})).review.id,f.review.id);
  assert.equal(f.events.filter(value=>value==='app-close').length,1);
});

test('real coordinator serves approved browser and app reads over independently pinned HTTPS listeners',async()=>{
  // The provider below holds a generated test key in memory. This exercises
  // genuine HTTPS and Store integration, not OS credential storage or two PCs.
  const {createRemoteManagement}=require('../electron/remote-management.cjs');
  const {createRemoteCertificate,createRemoteTLSLease}=require('../electron/remote-tls.cjs');
  const {createRemoteAppClient}=require('../electron/remote-app-client.cjs');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-connected-https-')));
  const store=createStore({dbPath:path.join(root,'owned.sqlite')});
  const group=store.saveGroup({name:'Real HTTPS'}),project=store.saveProject({groupId:group.id,name:'Allowed'}),
    other=store.saveProject({groupId:group.id,name:'Private'}),review=store.saveReview({projectId:project.id,title:'Actual saved review',body:'Actual body'});
  const dist=path.join(root,'dist');fs.mkdirSync(path.join(dist,'.vite'),{recursive:true});fs.mkdirSync(path.join(dist,'assets'));
  fs.writeFileSync(path.join(dist,'remote.html'),'<!doctype html><title>Owned remote entry</title>');
  fs.writeFileSync(path.join(dist,'assets/remote-test.js'),'export const ready=true;');
  fs.writeFileSync(path.join(dist,'.vite/manifest.json'),JSON.stringify({'remote.html':{file:'assets/remote-test.js',src:'remote.html',isEntry:true}}));
  const generated=await createRemoteCertificate({address:'127.0.0.1'});
  const {certificatePEM:_publicPEM,...identityFields}=generated.identity;
  const identity={deviceId:'test-memory-device',...identityFields};
  const provider={state:()=>({status:'ready',backend:'electron-safe-storage',identity,errorCode:null}),
    initialize:async()=>{},publicCertificate:()=>({...identity,certificatePEM:generated.certificatePEM}),
    acquireServerTLS:async({address,assertCurrent})=>{assertCurrent();return createRemoteTLSLease({address,...generated});},
    closeAndDrain:async()=>{generated.privateKeyDER.fill(0);}};
  let queue=Promise.resolve(),manager,client;
  const unusedPort=()=>new Promise((resolve,reject)=>{const reservation=net.createServer();reservation.once('error',reject);
    reservation.listen(0,'127.0.0.1',()=>{const port=reservation.address().port;reservation.close(error=>error?reject(error):resolve(port));});});
  const webPort=await unusedPort();
  const request=(route,value,cookie)=>new Promise((resolve,reject)=>{
    const bytes=value===undefined?null:Buffer.from(JSON.stringify(value));
    const req=https.request({hostname:'127.0.0.1',port:webPort,path:route,method:bytes?'POST':'GET',ca:generated.certificatePEM,
      rejectUnauthorized:true,agent:false,headers:{...(bytes?{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,Origin:`https://127.0.0.1:${webPort}`} : {}),...(cookie?{Cookie:cookie}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
    });req.once('error',reject);req.end(bytes);
  });
  try {
    manager=createRemoteManagement({store,identityProvider:provider,assetDirectory:dist,enqueueRead:fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;},
      executeAgent(){throw new Error('No agent execution in this read integration test.');}});
    const input=extra=>({expectedGeneration:manager.state().generation,...extra});
    await manager.configureWeb(input({bindAddress:'127.0.0.1',port:webPort,enabled:true}),()=>{});
    assert.match((await request('/')).body,/Owned remote entry/);assert.equal(JSON.parse((await request('/index.html')).body).error.code,'NOT_FOUND');
    const invitation=manager.inviteBrowser(input({}),()=>{});
    const login=await request('/web/v1/session',{version:1,requestId:'real-login',action:'login',invitationId:invitation.invitationId,
      secret:invitation.secret,clientName:'Real HTTPS browser fixture'});
    assert.equal(JSON.parse(login.body).data.state,'pending');const cookie=login.headers['set-cookie'][0].split(';')[0];
    manager.approveBrowser(input({pendingId:manager.state().pending[0].pendingId,projectIds:[project.id]}),()=>{});
    const read=await request('/web/v1/read',{version:1,requestId:'real-read',operation:'reviews.get',payload:{projectId:project.id,reviewId:review.id}},cookie);
    assert.equal(JSON.parse(read.body).data.review.body,'Actual body');
    const appPort=await unusedPort();await manager.configureApp(input({bindAddress:'127.0.0.1',port:appPort,enabled:true}),()=>{});
    client=createRemoteAppClient({address:'127.0.0.1',port:appPort,certificatePEM:generated.certificatePEM,certificateFingerprint:identity.certificateFingerprint});
    const appInvitation=manager.inviteApp(input({}),()=>{}),pending=await client.connect({invitation:appInvitation.invitation,label:'Real HTTPS app fixture'});
    manager.approveApp(input({id:pending.id,grants:[{projectId:project.id,read:true,write:true,execute:false}]}),()=>{});
    assert.equal((await client.read('reviews.get',{projectId:project.id,reviewId:review.id})).review.title,'Actual saved review');
    await assert.rejects(client.read('reviews.list',{projectId:other.id}));
    await manager.configureApp(input({bindAddress:'127.0.0.1',port:appPort,enabled:false}),()=>{});
    await manager.configureApp(input({bindAddress:'127.0.0.1',port:appPort,enabled:true}),()=>{});
    // Same token and durable approved principal reconnect to a fresh listener;
    // only the new runtime opaque peer is admitted to the one browsing facade.
    assert.equal((await client.read('reviews.get',{projectId:project.id,reviewId:review.id})).review.body,'Actual body');
    assert.equal((await request('/')).status,200,'App restart must leave the browser listener active');
  } finally {
    if(client)await client.disconnect().catch(()=>{});
    if(manager)await manager.closeAndDrain();else{generated.privateKeyDER.fill(0);store.close();}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
