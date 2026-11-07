'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const {createPeerReadBrowsing} = require('./peer-read-browsing.cjs');
const {createWebReadListener} = require('./remote-web-listener.cjs');
const {createRemoteAppListener} = require('./remote-app-listener.cjs');
const {createRemoteAttachments} = require('./remote-attachments.cjs');
const {createRemoteAppSessionStore} = require('./remote-app-session-store.cjs');
const {loadRemoteWebAssets} = require('./remote-web-assets.cjs');
const {copyIdentityDiagnostic} = require('./remote-identity-diagnostics.cjs');

const MESSAGES = Object.freeze({
  INVALID_REMOTE_REQUEST: 'Invalid Remote Management request.',
  STALE_REMOTE_REQUEST: 'Remote Management changed. Reload its settings.',
  REMOTE_MANAGEMENT_BUSY: 'Remote Management is completing another operation.',
  REMOTE_MANAGEMENT_CLOSED: 'Remote Management is unavailable.',
  WEB_ACCESS_ACTIVE: 'Turn off web access before changing the device certificate.',
  WEB_ACCESS_DISABLED: 'Turn on web access before inviting a browser.',
  WEB_LISTENER_UNAVAILABLE: 'The web listener is unavailable.',
  WEB_DRAIN_UNCONFIRMED: 'The original web listener could not be closed.',
  APP_ACCESS_DISABLED: 'Turn on app access before inviting a device.',
  APP_LISTENER_UNAVAILABLE: 'The app listener is unavailable.',
  APP_DRAIN_UNCONFIRMED: 'The original app listener could not be closed.',
  PORT_IN_USE: 'The selected web port is already in use.',
  ADDRESS_UNAVAILABLE: 'The selected address is unavailable on this computer.',
  REMOTE_WEB_ASSETS_UNAVAILABLE: 'The built browser application is unavailable.',
  IDENTITY_UNAVAILABLE: 'The device identity is unavailable.',
  IDENTITY_NOT_INITIALIZED: 'Initialize this device identity first.',
  IDENTITY_LOST: 'The original device identity is missing.',
  IDENTITY_PENDING: 'The device identity has an unfinished operation.',
  CERTIFICATE_REISSUE_REQUIRED: 'Reissue the public certificate for this address.',
  INVALID_REMOTE_ADDRESS: 'Select a concrete IPv4 address on this computer.',
  STALE_IDENTITY_REQUEST: 'The original device identity request is no longer current.',
  ACCESS_DENIED: 'Remote access is not allowed.'
});
const PROVIDER_CODES = new Set(['IDENTITY_UNAVAILABLE', 'IDENTITY_NOT_INITIALIZED', 'IDENTITY_LOST',
  'IDENTITY_PENDING', 'CERTIFICATE_REISSUE_REQUIRED', 'INVALID_REMOTE_ADDRESS', 'STALE_IDENTITY_REQUEST']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ownRecord = values => Object.assign(Object.create(null), values);
const opaque = () => Object.freeze(Object.create(null));
function fail(code) { throw Object.assign(new Error(MESSAGES[code]), {code}); }
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail('INVALID_REMOTE_REQUEST');
  const actual = Reflect.ownKeys(value), copied = Object.create(null);
  if (actual.length !== names.length || actual.some(key => !names.includes(key))) fail('INVALID_REMOTE_REQUEST');
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_REMOTE_REQUEST');
    copied[name] = descriptor.value;
  }
  return copied;
}
function address(value) {
  if (typeof value !== 'string' || net.isIP(value) !== 4 || ['0.0.0.0', '255.255.255.255'].includes(value) ||
      Number(value.split('.')[0]) >= 224) fail('INVALID_REMOTE_ADDRESS');
  return value;
}
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_REMOTE_REQUEST'); return value; }
function timestamp(value) { return typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value)); }
function publicIdentity(value, certificate = false) {
  const names = ['deviceId', 'address', 'keyFingerprint', 'certificateFingerprint', 'validUntil', ...(certificate ? ['certificatePEM'] : [])];
  const result = fields(value, names);
  identifier(result.deviceId); address(result.address);
  if (typeof result.keyFingerprint !== 'string' || !HEX.test(result.keyFingerprint) ||
      typeof result.certificateFingerprint !== 'string' || !HEX.test(result.certificateFingerprint) || !timestamp(result.validUntil) ||
      certificate && (typeof result.certificatePEM !== 'string' || Buffer.byteLength(result.certificatePEM) > 16384 ||
        !result.certificatePEM.startsWith('-----BEGIN CERTIFICATE-----\n'))) fail('IDENTITY_UNAVAILABLE');
  return Object.freeze({...result});
}
function providerError(error) {
  let code = 'IDENTITY_UNAVAILABLE';
  try { if (PROVIDER_CODES.has(error?.code)) code = error.code; } catch { /* Never expose a provider exception. */ }
  fail(code);
}

function createRemoteManagement(options) {
  const {store, identityProvider, assetDirectory, enqueueRead, executeAgent, onCommitted = () => {}} = fields(options,
    ['store', 'identityProvider', 'assetDirectory', 'enqueueRead', 'executeAgent', ...(options&&Object.hasOwn(options,'onCommitted')?['onCommitted']:[])]);
  if (!identityProvider || typeof enqueueRead !== 'function' || typeof executeAgent !== 'function' || typeof onCommitted !== 'function' || typeof assetDirectory !== 'string' || !assetDirectory ||
      ['state', 'initialize', 'acquireServerTLS', 'publicCertificate', 'closeAndDrain'].some(name => typeof identityProvider[name] !== 'function'))
    fail('INVALID_REMOTE_REQUEST');
  const provider = Object.freeze(Object.fromEntries(['state', 'initialize', 'acquireServerTLS', 'publicCertificate', 'closeAndDrain']
    .map(name => [name, identityProvider[name].bind(identityProvider)])));
  const records = new Map(), principalRecords = new WeakMap(), appRecords = new Map();
  let generation = 1, web = null, app = null, operation = null, finalClose = null, closed = false;
  let lastAddress = '', lastPort = 9443, webError = null;
  let lastAppAddress = '', lastAppPort = 9444, appError = null;

  function providerState() {
    let original;
    try { original = provider.state(); } catch (error) { providerError(error); }
    let result;
    try {
      const diagnostic = Boolean(original && Object.hasOwn(original, 'diagnostic'));
      result = fields(original, ['status', 'backend', 'identity', 'errorCode', ...(diagnostic ? ['diagnostic'] : [])]);
      if (!['not_initialized', 'ready', 'unavailable', 'identity_lost', 'pending'].includes(result.status) ||
          !['macos-default-file-keychain', 'electron-safe-storage', 'unsupported'].includes(result.backend) ||
          result.errorCode !== null && !PROVIDER_CODES.has(result.errorCode)) fail('IDENTITY_UNAVAILABLE');
      result.identity = result.identity === null ? null : publicIdentity(result.identity);
      if (result.status === 'ready' && (!result.identity || result.errorCode !== null)) fail('IDENTITY_UNAVAILABLE');
      if (diagnostic) {
        if (result.status === 'ready' || result.errorCode === null) fail('IDENTITY_UNAVAILABLE');
        result.diagnostic = copyIdentityDiagnostic(result.diagnostic);
      }
    } catch { fail('IDENTITY_UNAVAILABLE'); }
    return Object.freeze({...result});
  }
  function bump() {
    if (generation >= Number.MAX_SAFE_INTEGER) fail('REMOTE_MANAGEMENT_CLOSED');
    generation++;
  }
  function trusted(record) {
    const owner = record?.app || record?.web;
    if (!record || record.retired || !record.approved || !owner ||
        (record.app ? app !== owner : web !== owner) || (!owner.enabled && !record.bootstrapping) || finalClose || closed || record.expires <= Date.now()) return false;
    try { return providerState().status === 'ready'; } catch { return false; }
  }
  function live(record) { return trusted(record) && Boolean(record.capability); }
  const browsing = createPeerReadBrowsing(ownRecord({store, verifyPeerHandle: principal => trusted(principalRecords.get(principal))}));
  const attachments = createRemoteAttachments({store,dataPath:path.dirname(store.dbPath),onCommitted,
    authorize(principal,scope) {
      const record=principalRecords.get(principal);
      if(!live(record)||!record.attachmentScope)fail('ACCESS_DENIED');
      const grant=record.attachmentScope.grants.find(row=>row.projectId===scope.projectId);
      if(!grant||grant.read!==true||scope.write&&(!record.app||grant.write!==true))fail('ACCESS_DENIED');
      const epoch=store.db.prepare('SELECT epoch FROM dataset_meta WHERE singleton=1').get()?.epoch;
      const birth=store.db.prepare('SELECT birth FROM peer_project_births WHERE projectId=?').get(scope.projectId)?.birth;
      if(epoch!==record.attachmentScope.epoch||birth!==grant.birth)fail('ACCESS_DENIED');
      return {principalId:record.principalId};
    }});
  function attachmentScope(projectGrants) {
    const dataset=store.peerReadDataset(),births=new Map(dataset.projects.map(row=>[row.projectId,row.birth]));
    return Object.freeze({epoch:dataset.epoch,grants:Object.freeze(projectGrants.map(row=>{
      if(!births.has(row.projectId))fail('ACCESS_DENIED');return Object.freeze({...row,birth:births.get(row.projectId)});
    }))});
  }
  function syncBrowsingEnabled() { browsing.setEnabled(Boolean(web?.enabled || app?.enabled)); }

  function assertOperation(original) {
    if (closed || finalClose || operation !== original || original.cancelled) fail('STALE_REMOTE_REQUEST');
    if (original.assertCurrent() !== undefined) fail('INVALID_REMOTE_REQUEST');
  }
  function begin(input, names, assertCurrent) {
    if (typeof assertCurrent !== 'function') fail('INVALID_REMOTE_REQUEST');
    const captured = fields(input, ['expectedGeneration', ...names]);
    if (!Number.isSafeInteger(captured.expectedGeneration) || captured.expectedGeneration !== generation) fail('STALE_REMOTE_REQUEST');
    if (closed || finalClose) fail('REMOTE_MANAGEMENT_CLOSED');
    if (operation) fail('REMOTE_MANAGEMENT_BUSY');
    let settled;
    const original = {assertCurrent, cancelled: false, done: new Promise(resolve => { settled = resolve; }), settle: () => settled()};
    operation = original;
    try { assertOperation(original); } catch (error) { operation = null; original.settle(); throw error; }
    return {original, captured};
  }
  function finish(original) { if (operation === original) operation = null; original.settle(); }
  function snapshot() {
    const identity = providerState(), listenerState = web?.listener?.state();
    const enabled = Boolean(web?.enabled && listenerState?.state === 'listening');
    return Object.freeze({generation, managementAllowed: true, identity,
      web: Object.freeze({enabled, state: closed || finalClose ? 'unavailable' : listenerState?.state === 'unconfirmed' || webError ? 'unavailable' :
        web?.closing ? 'closing' : enabled ? 'listening' : 'disabled',
        endpoint: enabled ? listenerState.endpoint.url : null, bindAddress: lastAddress, port: lastPort, errorCode: webError}),
      app: Object.freeze({enabled: Boolean(app?.enabled && app.listener.state().running),
        state: closed || finalClose || appError ? 'unavailable' : app?.closing ? 'closing' : app?.enabled ? 'listening' : 'disabled',
        endpoint: app?.enabled ? new URL(`https://${lastAppAddress}:${app.listener.state().port}`).href : null,
        bindAddress: lastAppAddress, port: lastAppPort, errorCode: appError,
        sessions: Object.freeze(app?.listener.state().sessions || [])}),
      pending: Object.freeze([...records.values()].filter(record => !record.retired && !record.capability).map(record => Object.freeze({
        pendingId: record.pendingId, clientName: record.clientName, expiresAt: record.expiresAt}))),
      connections: Object.freeze([...records.values()].filter(record => live(record)).map(record => Object.freeze({
        connectionId: record.connectionId, principalId: record.principalId, clientName: record.clientName,
        projectIds: Object.freeze([...record.projectIds]), expiresAt: record.expiresAt})))});
  }
  function result(original) { const value = snapshot(); assertOperation(original); return value; }
  function forget(record) {
    if (record.retired) return;
    record.retired = true;
    const errors = [];
    if(record.principal)try{attachments.revokeOwner(record.principal);}catch(error){errors.push(error);}
    if (record.capability) {
      try { browsing.closeSession(record.capability); } catch (error) { errors.push(error); }
      try { browsing.revokePeer(record.principal); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      record.web.cleanupUnconfirmed = true; webError = 'WEB_DRAIN_UNCONFIRMED';
      throw new AggregateError(errors, MESSAGES.WEB_DRAIN_UNCONFIRMED, {cause: errors[0]});
    }
    if (records.get(record.pendingId) === record) records.delete(record.pendingId);
  }
  function readRequest(originalWeb, authority, name, payload) {
    const record = principalRecords.get(authority);
    if (!live(record) || (record.app || record.web) !== originalWeb) fail('ACCESS_DENIED');
    const names = name === 'attachments.read' ? ['projectId','reviewId','attachmentId','offset'] : name === 'projects.list' ? [] : name === 'reviews.list' ? ['projectId'] :
      ['reviews.get', 'reviews.timeline'].includes(name) ? ['projectId', 'reviewId'] : null;
    if (!names) fail('ACCESS_DENIED');
    const captured = fields(payload, names); for (const key of names)if(key==='offset'){if(!Number.isSafeInteger(captured[key])||captured[key]<0)fail('ACCESS_DENIED');}else identifier(captured[key]); Object.freeze(captured);
    const capability = record.capability, activation = originalWeb.activation;
    const check = () => {
      if (!live(record) || (record.app ? app : web) !== originalWeb || originalWeb.activation !== activation || record.capability !== capability) fail('ACCESS_DENIED');
    };
    return enqueueRead(() => {
      check(); const value = name==='attachments.read'?attachments.readChunk(authority,captured):browsing.query(capability, name, captured); check(); return value;
    });
  }
  function makeListener(lease, assets) {
    const originalWeb = {listener: null, enabled: false, closing: null, activation: opaque(), cleanupUnconfirmed: false};
    originalWeb.listener = createWebReadListener(ownRecord({tlsLease: lease, assets,
      onPendingBrowser: notice => {
        if (web !== originalWeb || !originalWeb.enabled || closed || finalClose || records.size >= 16) fail('ACCESS_DENIED');
        const item = fields(notice, ['pendingId', 'pendingHandle', 'clientName', 'createdAt', 'expiresAt']);
        identifier(item.pendingId);
        if (records.has(item.pendingId) || !timestamp(item.expiresAt)) fail('ACCESS_DENIED');
        records.set(item.pendingId, {pendingId: item.pendingId, pendingHandle: item.pendingHandle, web: originalWeb,
          clientName: item.clientName, expiresAt: item.expiresAt, expires: Date.parse(item.expiresAt), retired: false,
          principal: null, approved: false, capability: null, principalId: null, connectionId: null, projectIds: []});
        bump();
      },
      onRead: (authority, name, payload) => readRequest(originalWeb, authority, name, payload),
      onClosed: event => {
        const record = records.get(event.pendingId);
        if (record && record.web === originalWeb && record.pendingHandle === event.pendingHandle &&
            (event.authorityHandle === null || event.authorityHandle === record.principal)) { forget(record); bump(); }
      }}));
    return originalWeb;
  }
  function closeWeb(originalWeb) {
    if (!originalWeb) return Promise.resolve();
    if (originalWeb.closing) return originalWeb.closing;
    originalWeb.enabled = false; originalWeb.activation = opaque();
    const failures = [];
    try { originalWeb.listener.stopAdmission(); } catch (error) { failures.push(error); }
    try { syncBrowsingEnabled(); } catch (error) { failures.push(error); }
    originalWeb.closing = (async () => {
      try { await originalWeb.listener.closeAndDrain(); } catch (error) { failures.push(error); }
      if (originalWeb.cleanupUnconfirmed || failures.length) {
        webError = 'WEB_DRAIN_UNCONFIRMED';
        if (!failures.length) fail('WEB_DRAIN_UNCONFIRMED');
        throw Object.assign(new AggregateError(failures, MESSAGES.WEB_DRAIN_UNCONFIRMED, {cause: failures[0]}), {code: 'WEB_DRAIN_UNCONFIRMED'});
      }
      if (web === originalWeb) web = null;
    })();
    return originalWeb.closing;
  }
  function forgetApp(peer) {
    const record = appRecords.get(peer);
    if (!record || record.retired) return;
    record.retired = true;
    const failures = [];
    try { attachments.revokeOwner(record.principal); } catch(error) { failures.push(error); }
    if (record.capability) try { browsing.closeSession(record.capability); } catch (error) { failures.push(error); }
    try { browsing.revokePeer(record.principal); } catch (error) { failures.push(error); }
    if (failures.length) {
      record.app.cleanupUnconfirmed = true; appError = 'APP_DRAIN_UNCONFIRMED';
      throw new AggregateError(failures, MESSAGES.APP_DRAIN_UNCONFIRMED, {cause: failures[0]});
    }
    appRecords.delete(peer); bump();
  }
  function makeAppListener(lease) {
    const originalApp = {listener:null,lease,enabled:false,closing:null,activation:opaque(),cleanupUnconfirmed:false};
    const assertActive=()=>{if(app!==originalApp||!originalApp.enabled||closed||finalClose)fail('ACCESS_DENIED');};
    originalApp.listener = createRemoteAppListener({lease,store,assertActive,onCommitted,
      sessionStore:createRemoteAppSessionStore({directory:path.join(path.dirname(store.dbPath),'remote-app-access')}),
      executeAgent(action,payload,guard) {
        assertActive();const activation=originalApp.activation;
        return executeAgent(action,payload,()=>{
          assertActive();if(originalApp.activation!==activation)fail('ACCESS_DENIED');return guard();
        });
      },
      onApprove(peer, grants, identity) {
        if (app !== originalApp || closed || finalClose) fail('ACCESS_DENIED');
        if(appRecords.has(peer))forgetApp(peer);
        if(appRecords.size>=16)fail('ACCESS_DENIED');
        const principal = opaque(), record = {app:originalApp,principal,approved:true,retired:false,
          capability:null,bootstrapping:true,expires:identity?.expiresAt||Number.MAX_SAFE_INTEGER,
          principalId:identity?.principalId||crypto.randomUUID(),attachmentScope:attachmentScope(grants)};
        appRecords.set(peer,record); principalRecords.set(principal,record);
        try {
          browsing.approvePeer(principal,ownRecord({projectIds:grants.map(row=>row.projectId)}));
          record.capability=browsing.openSession(principal);
        } catch (primary) {
          try { forgetApp(peer); } catch (cleanup) { throw new AggregateError([primary,cleanup],MESSAGES.APP_DRAIN_UNCONFIRMED,{cause:primary}); }
          throw primary;
        } finally { record.bootstrapping=false; }
      },
      onRead(peer,name,payload) { return readRequest(originalApp,appRecords.get(peer)?.principal,name,payload); },
      onAttachment(peer,name,payload) {
        const record=appRecords.get(peer),activation=originalApp.activation;
        const check=()=>{if(!live(record)||app!==originalApp||originalApp.activation!==activation)fail('ACCESS_DENIED');};
        return enqueueRead(()=>{check();const value=attachments[name](record.principal,payload);check();return value;});
      },
      onRevoke:forgetApp});
    return originalApp;
  }
  function closeApp(originalApp) {
    if (!originalApp) return Promise.resolve();
    if (originalApp.closing) return originalApp.closing;
    originalApp.enabled=false; originalApp.activation=opaque(); syncBrowsingEnabled();
    originalApp.closing=(async()=>{
      await originalApp.listener.close();
      if (originalApp.cleanupUnconfirmed) fail('APP_DRAIN_UNCONFIRMED');
      await originalApp.lease.release();
      if (app===originalApp) app=null;
    })().catch(error=>{appError='APP_DRAIN_UNCONFIRMED';throw error;});
    return originalApp.closing;
  }

  return Object.freeze({
    state() { if (arguments.length) fail('INVALID_REMOTE_REQUEST'); return snapshot(); },
    async initializeIdentity(input, assertCurrent) {
      const {original, captured} = begin(input, ['address'], assertCurrent);
      try {
        const selectedAddress = address(captured.address);
        if (web || app) fail('WEB_ACCESS_ACTIVE');
        try { await provider.initialize(ownRecord({address: selectedAddress, assertCurrent: () => assertOperation(original)})); }
        catch (error) { providerError(error); }
        assertOperation(original); lastAddress = selectedAddress; bump(); return result(original);
      } finally { finish(original); }
    },
    async publicCertificate(input, assertCurrent) {
      const {original} = begin(input, [], assertCurrent);
      try {
        let value; try { value = await provider.publicCertificate(); } catch (error) { providerError(error); }
        assertOperation(original); const captured = publicIdentity(value, true); assertOperation(original); return captured;
      } finally { finish(original); }
    },
    async configureWeb(input, assertCurrent) {
      const {original, captured} = begin(input, ['bindAddress', 'port', 'enabled'], assertCurrent);
      let lease = null, candidate = null;
      try {
        if (typeof captured.enabled !== 'boolean' || !Number.isInteger(captured.port) || captured.port < 1 || captured.port > 65535) fail('INVALID_REMOTE_REQUEST');
        const selectedAddress = address(captured.bindAddress);
        const previous = web;
        if (previous) await closeWeb(previous);
        assertOperation(original); lastAddress = selectedAddress; lastPort = captured.port; webError = null;
        if (!captured.enabled) { bump(); return result(original); }
        const assets = loadRemoteWebAssets(assetDirectory); assertOperation(original);
        try { lease = await provider.acquireServerTLS(ownRecord({address: selectedAddress, assertCurrent: () => assertOperation(original)})); }
        catch (error) { providerError(error); }
        assertOperation(original);
        candidate = makeListener(lease, assets); lease = null; web = candidate;
        await candidate.listener.listen(ownRecord({address: selectedAddress, port: captured.port}));
        assertOperation(original); candidate.enabled = true; syncBrowsingEnabled(); bump(); return result(original);
      } catch (primary) {
        let cleanup;
        try { if (candidate) await closeWeb(candidate); else if (lease) await lease.release(); }
        catch (error) { cleanup = error; webError = 'WEB_DRAIN_UNCONFIRMED'; }
        if (!cleanup) {
          try { webError = primary.code === 'EADDRINUSE' ? 'PORT_IN_USE' : primary.code === 'EADDRNOTAVAIL' ? 'ADDRESS_UNAVAILABLE' :
            Object.hasOwn(MESSAGES, primary.code) ? primary.code : 'WEB_LISTENER_UNAVAILABLE'; } catch { webError = 'WEB_LISTENER_UNAVAILABLE'; }
        }
        if (cleanup) throw new AggregateError([primary, cleanup], MESSAGES.WEB_DRAIN_UNCONFIRMED, {cause: primary});
        if (Object.hasOwn(MESSAGES, primary?.code)) throw primary;
        fail(webError);
      } finally { finish(original); }
    },
    inviteBrowser(input, assertCurrent) {
      const {original} = begin(input, [], assertCurrent);
      try {
        if (!web?.enabled) fail('WEB_ACCESS_DISABLED');
        const value = web.listener.inviteBrowser(); assertOperation(original);
        return Object.freeze({generation, ...value, endpoint: web.listener.state().endpoint.url});
      } finally { finish(original); }
    },
    async configureApp(input, assertCurrent) {
      const {original,captured}=begin(input,['bindAddress','port','enabled'],assertCurrent);
      let lease=null,candidate=null;
      try {
        if (typeof captured.enabled!=='boolean' || !Number.isInteger(captured.port) || captured.port<1 || captured.port>65535) fail('INVALID_REMOTE_REQUEST');
        const selected=address(captured.bindAddress);
        if (app) await closeApp(app);
        assertOperation(original);lastAppAddress=selected;lastAppPort=captured.port;appError=null;
        if (!captured.enabled) { bump();return result(original); }
        if (web?.enabled && selected===lastAddress && captured.port===lastPort) fail('PORT_IN_USE');
        try { lease=await provider.acquireServerTLS(ownRecord({address:selected,assertCurrent:()=>assertOperation(original)})); }
        catch(error) { providerError(error); }
        assertOperation(original);candidate=makeAppListener(lease);lease=null;app=candidate;
        // Opening restored capabilities is synchronous and private. Listener
        // callbacks still deny requests until the original enable completes.
        browsing.setEnabled(true);
        await candidate.listener.start({address:selected,port:captured.port});
        assertOperation(original);candidate.enabled=true;syncBrowsingEnabled();bump();return result(original);
      } catch(primary) {
        try { if(candidate)await closeApp(candidate);else if(lease)await lease.release(); }
        catch(cleanup){appError='APP_DRAIN_UNCONFIRMED';throw new AggregateError([primary,cleanup],MESSAGES.APP_DRAIN_UNCONFIRMED,{cause:primary});}
        appError=primary?.code==='EADDRINUSE'?'PORT_IN_USE':primary?.code==='EADDRNOTAVAIL'?'ADDRESS_UNAVAILABLE':
          Object.hasOwn(MESSAGES,primary?.code)?primary.code:'APP_LISTENER_UNAVAILABLE';
        if(Object.hasOwn(MESSAGES,primary?.code))throw primary;fail(appError);
      } finally { finish(original); }
    },
    inviteApp(input,assertCurrent) {
      const {original}=begin(input,[],assertCurrent);
      try {
        if(!app?.enabled)fail('APP_ACCESS_DISABLED');
        const value=app.listener.createInvitation();assertOperation(original);
        return Object.freeze({generation,...value,endpoint:new URL(`https://${lastAppAddress}:${app.listener.state().port}`).href});
      } finally { finish(original); }
    },
    approveApp(input,assertCurrent) {
      const {original,captured}=begin(input,['id','grants'],assertCurrent);
      try {
        if(!app?.enabled)fail('APP_ACCESS_DISABLED');
        identifier(captured.id);
        if(!Array.isArray(captured.grants)||!captured.grants.length||captured.grants.length>1000||
            Reflect.ownKeys(captured.grants).length!==captured.grants.length+1)fail('INVALID_REMOTE_REQUEST');
        const grants=[],seen=new Set();
        for(let index=0;index<captured.grants.length;index++) {
          const descriptor=Object.getOwnPropertyDescriptor(captured.grants,String(index));
          if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('INVALID_REMOTE_REQUEST');
          const grant=fields(descriptor.value,['projectId','read','write','execute']);identifier(grant.projectId);
          if(seen.has(grant.projectId)||grant.read!==true||typeof grant.write!=='boolean'||typeof grant.execute!=='boolean')fail('INVALID_REMOTE_REQUEST');
          seen.add(grant.projectId);grants.push(Object.freeze({...grant}));
        }
        assertOperation(original);app.listener.approve({id:captured.id,grants});bump();return result(original);
      } finally { finish(original); }
    },
    revokeApp(input,assertCurrent) {
      const {original,captured}=begin(input,['id'],assertCurrent);
      try {
        if(!app?.enabled)fail('APP_ACCESS_DISABLED');identifier(captured.id);
        assertOperation(original);app.listener.revoke({id:captured.id});bump();return result(original);
      } finally { finish(original); }
    },
    approveBrowser(input, assertCurrent) {
      const {original, captured} = begin(input, ['pendingId', 'projectIds'], assertCurrent);
      let record, principal, capability;
      try {
        identifier(captured.pendingId);
        if (!Array.isArray(captured.projectIds) || captured.projectIds.length > 1000) fail('INVALID_REMOTE_REQUEST');
        const projects = [];
        if (Reflect.ownKeys(captured.projectIds).length !== captured.projectIds.length + 1) fail('INVALID_REMOTE_REQUEST');
        for (let index = 0; index < captured.projectIds.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(captured.projectIds, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_REMOTE_REQUEST');
          projects.push(identifier(descriptor.value));
        }
        if (new Set(projects).size !== projects.length) fail('INVALID_REMOTE_REQUEST');
        record = records.get(captured.pendingId);
        if (!record || record.retired || record.capability || record.web !== web || !web.enabled || record.expires <= Date.now()) fail('STALE_REMOTE_REQUEST');
        principal = opaque(); record.principal = principal; record.principalId = crypto.randomUUID();
        record.projectIds = Object.freeze(projects); record.approved = true; principalRecords.set(principal, record);
        record.attachmentScope=attachmentScope(projects.map(projectId=>({projectId,read:true,write:false,execute:false})));
        // The verifier must recognize this locally approved original before the
        // facade opens its session. No serialized peer or grants are accepted.
        browsing.approvePeer(principal, ownRecord({projectIds: projects}));
        capability = browsing.openSession(principal); record.capability = capability;
        assertOperation(original); web.listener.approveBrowser(record.pendingHandle, principal);
        const observed = web.listener.state().connections.find(item => item.pendingId === record.pendingId);
        if (!observed || !observed.approved) fail('ACCESS_DENIED');
        record.connectionId = observed.connectionId; record.expiresAt = observed.expiresAt; record.expires = Date.parse(observed.expiresAt);
        bump(); return result(original);
      } catch (primary) {
        if (record && principal) {
          const errors = [];
          if (capability) try { browsing.closeSession(capability); } catch (error) { errors.push(error); }
          try { browsing.revokePeer(principal); } catch (error) { errors.push(error); }
          record.retired = true;
          try { record.web.listener.disconnect(record.pendingHandle); } catch (error) { errors.push(error); }
          if (errors.length) { record.web.cleanupUnconfirmed = true; throw new AggregateError([primary, ...errors], MESSAGES.WEB_DRAIN_UNCONFIRMED, {cause: primary}); }
          if (records.get(record.pendingId) === record) records.delete(record.pendingId);
        }
        throw primary;
      } finally { finish(original); }
    },
    revoke(input, assertCurrent) {
      const {original, captured} = begin(input, ['principalId'], assertCurrent);
      try {
        identifier(captured.principalId);
        const record = [...records.values()].find(item => item.principalId === captured.principalId);
        if (!record || record.retired) fail('STALE_REMOTE_REQUEST');
        assertOperation(original); record.web.listener.revoke(record.principal); forget(record); bump(); return result(original);
      } finally { finish(original); }
    },
    disconnect(input, assertCurrent) {
      const {original, captured} = begin(input, ['connectionId'], assertCurrent);
      try {
        identifier(captured.connectionId);
        const record = [...records.values()].find(item => item.connectionId === captured.connectionId);
        if (!record || record.retired) fail('STALE_REMOTE_REQUEST');
        assertOperation(original); record.web.listener.disconnect(record.pendingHandle); forget(record); bump(); return result(original);
      } finally { finish(original); }
    },
    async pause() {
      if (arguments.length) fail('INVALID_REMOTE_REQUEST');
      const original = operation; if (original) original.cancelled = true;
      bump(); await Promise.all([closeWeb(web),closeApp(app)]); if (original) await original.done;
    },
    closeAndDrain() {
      if (arguments.length) fail('INVALID_REMOTE_REQUEST');
      if (finalClose) return finalClose;
      const original = operation; if (original) original.cancelled = true;
      finalClose = (async () => {
        await Promise.all([closeWeb(web),closeApp(app)]);
        // Retain the same original control completion, including its late lease
        // cleanup, rather than releasing the provider beneath it.
        if (original) await original.done;
        if (operation) fail('REMOTE_MANAGEMENT_BUSY');
        attachments.close();
        await provider.closeAndDrain();
        browsing.retireAndClose(); closed = true;
      })();
      return finalClose;
    },
    storeClosed() {
      if (arguments.length) fail('INVALID_REMOTE_REQUEST'); return closed;
    },
    hasActiveWork() {
      if (arguments.length) fail('INVALID_REMOTE_REQUEST');
      return Boolean(operation || web?.closing || app?.closing || finalClose && !closed);
    }
  });
}

module.exports = {createRemoteManagement};
