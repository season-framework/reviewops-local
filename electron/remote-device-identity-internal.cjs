'use strict';
// Application-internal assembly seam for controlled tests, never an IPC/constructor option.
const crypto = require('node:crypto');
const net = require('node:net');
const {captureIdentityDiagnostic,legacyIdentityDiagnostic,identityDiagnosticRecord,retainedIdentityDiagnostic}=require('./remote-identity-diagnostics.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const CODES=new Set(['IDENTITY_UNAVAILABLE','IDENTITY_NOT_INITIALIZED','IDENTITY_LOST','IDENTITY_PENDING','CERTIFICATE_REISSUE_REQUIRED','INVALID_REMOTE_ADDRESS','STALE_IDENTITY_REQUEST']);
const METADATA_CODES=new Set(['METADATA_UNAVAILABLE','METADATA_UNSUPPORTED','PENDING_EVIDENCE_UNAVAILABLE','PENDING_CHANGED','METADATA_BINDING_REFUSED','METADATA_RESULT_REFUSED','INSPECTION_ONLY_REFUSED',
 'DEFAULT_KEYCHAIN_FAILED','DEFAULT_LOCKED','DEFAULT_STATUS_FAILED','FINAL_DEFAULT_FAILED','METADATA_DEFAULT_CHANGED','METADATA_QUERY_FAILED','METADATA_QUERY_REFUSED','METADATA_SHAPE_REFUSED',
 'NO_UI_GET_FAILED','NO_UI_SET_FAILED','NO_UI_VERIFY_FAILED','NO_UI_NOT_ENFORCED','PROVIDER_BUSY','PROVIDER_CLOSED','PROVIDER_FAILED','OWNER_CONTEXT_REFUSED','NAPI_FAILURE','NATIVE_EXCEPTION','NATIVE_SHAPE_REFUSED','CF_RELEASE_FAILED']);
const METADATA_OS_STATUSES=new Set([-50,-128,-25291,-25293,-25294,-25295,-25300,-25307,-25308,-25315,-34018,-67068,-67062,-67054,-67050,-67034,-67022]);
const wipe=value=>{if(Buffer.isBuffer(value))Buffer.prototype.fill.call(value,0);};
function fail(code) {throw Object.assign(new Error('The remote identity request was refused.'),{code});}
function codeOf(error) {try{const d=error&&Object.getOwnPropertyDescriptor(error,'code');return d&&CODES.has(d.value)?d.value:'IDENTITY_UNAVAILABLE';}catch{return'IDENTITY_UNAVAILABLE';}}
function exact(value,keys) {if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;const names=Reflect.ownKeys(value);return names.every(x=>typeof x==='string')&&JSON.stringify(names.sort())===JSON.stringify([...keys].sort());}
function addressValue(value) {if(typeof value!=='string'||value.length>15||net.isIP(value)!==4||value==='0.0.0.0'||value==='255.255.255.255'||Number(value.split('.')[0])>=224)fail('INVALID_REMOTE_ADDRESS');return value;}
function base64(value,max) {if(typeof value!=='string'||value.length<4||value.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('IDENTITY_LOST');const b=Buffer.from(value,'base64');if(!b.length||b.length>max||b.toString('base64')!==value){b.fill(0);fail('IDENTITY_LOST');}return b;}
function canonical(snapshot) {if(!snapshot)return null;let v;try{v=JSON.parse(snapshot.bytes.toString('utf8'));}catch{fail('IDENTITY_LOST');}if(!Buffer.from(JSON.stringify(v)).equals(snapshot.bytes))fail('IDENTITY_LOST');return v;}
function sha(bytes) {return crypto.createHash('sha256').update(bytes).digest('hex');}
function keyValue(der) {
  if(!Buffer.isBuffer(der)||der.length<1||der.length>16384)fail('IDENTITY_LOST');
  let key;try{key=crypto.createPrivateKey({key:der,format:'der',type:'pkcs8'});}catch{fail('IDENTITY_LOST');}
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail('IDENTITY_LOST');
  return{key,keyFingerprint:sha(crypto.createPublicKey(key).export({type:'spki',format:'der'}))};
}
function certificateValue(value,der,address,now,allowExpired=false) {
  if(!exact(value,['certificatePEM','identity'])||typeof value.certificatePEM!=='string'||Buffer.byteLength(value.certificatePEM)>16384)fail('IDENTITY_UNAVAILABLE');
  const info=keyValue(der);let cert;
  try{cert=new crypto.X509Certificate(value.certificatePEM);}catch{fail('IDENTITY_UNAVAILABLE');}
  const pem=cert.toString(),validUntil=new Date(cert.validTo).toISOString();
  if(value.certificatePEM.trim()!==pem.trim()||cert.ca||cert.checkIP(address)!==address||!cert.verify(cert.publicKey)||!cert.checkPrivateKey(info.key)||!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1')||Date.parse(cert.validFrom)>now()||(!allowExpired&&Date.parse(validUntil)<=now()))fail('CERTIFICATE_REISSUE_REQUIRED');
  const identity={address,keyFingerprint:info.keyFingerprint,certificateFingerprint:sha(cert.raw),validUntil,certificatePEM:pem};
  if(!exact(value.identity,Object.keys(identity))||!Object.keys(identity).every(k=>value.identity[k]===identity[k]))fail('IDENTITY_UNAVAILABLE');
  return identity;
}
function parseIndex(snapshot) {
  const v=canonical(snapshot);if(!exact(v,['schema','deviceId','accountUUID','referenceBase64','payloadSHA256','keyFingerprint'])||v.schema!==1||!UUID.test(v.deviceId)||!UUID.test(v.accountUUID)||!HEX.test(v.payloadSHA256)||!HEX.test(v.keyFingerprint))fail('IDENTITY_LOST');
  const ref=base64(v.referenceBase64,4096);ref.fill(0);return v;
}
function parseCertificate(snapshot,index) {
  if(!snapshot)return null;const v=canonical(snapshot);
  if(!exact(v,['schema','deviceId','address','keyFingerprint','certificateFingerprint','validUntil','certificatePEM'])||v.schema!==1||v.deviceId!==index.deviceId||v.keyFingerprint!==index.keyFingerprint||!HEX.test(v.certificateFingerprint)||typeof v.validUntil!=='string'||typeof v.certificatePEM!=='string'||Buffer.byteLength(v.certificatePEM)>16384)fail('IDENTITY_LOST');
  addressValue(v.address);return v;
}
function parsePending(snapshot) {const v=canonical(snapshot);if(!exact(v,['schema','operationId','deviceId','accountUUID','keyFingerprint'])||v.schema!==1||![v.operationId,v.deviceId,v.accountUUID].every(x=>UUID.test(x))||!HEX.test(v.keyFingerprint))fail('IDENTITY_LOST');return v;}
function createIdentityOwner({files,loadNative,tls,ownerCurrent,now=Date.now,uuid=crypto.randomUUID,backend='macos-default-file-keychain'}) {
  let status='not_initialized',errorCode=null,publicIdentity=null,diagnostic=null,closing=false,closePromise=null;
  let epoch=0,identityVersion=0,queue=Promise.resolve(),native=null,nativeAccount=null,nativeUsable=false,everProfileObserved=false,inspectionOnly=false,metadataBinding=null;
  const leases=new Set();
  try{const original=loadNative(),names=['initialize','create','read','remove','close'];if(!original)fail('IDENTITY_UNAVAILABLE');const captured={};for(const name of names){const d=Object.getOwnPropertyDescriptor(original,name);if(!d||typeof d.value!=='function')fail('IDENTITY_UNAVAILABLE');captured[name]=d.value.bind(original);}const inspect=Object.getOwnPropertyDescriptor(original,'inspectPendingMetadata');if(inspect){if(!Object.hasOwn(inspect,'value')||typeof inspect.value!=='function')fail('IDENTITY_UNAVAILABLE');captured.inspectPendingMetadata=inspect.value.bind(original);}native=Object.freeze(captured);}catch{fail('IDENTITY_UNAVAILABLE');}
  function state() {let current=false;try{current=ownerCurrent()===true&&!closing;}catch{}if(!current)return Object.freeze({status:'unavailable',backend,identity:null,errorCode:'IDENTITY_UNAVAILABLE'});if(status==='ready'&&publicIdentity&&Date.parse(publicIdentity.validUntil)<=now())return Object.freeze({status:'unavailable',backend,identity:null,errorCode:'CERTIFICATE_REISSUE_REQUIRED'});return Object.freeze({status,backend,identity:status==='ready'&&publicIdentity?Object.freeze({deviceId:publicIdentity.deviceId,address:publicIdentity.address,keyFingerprint:publicIdentity.keyFingerprint,certificateFingerprint:publicIdentity.certificateFingerprint,validUntil:publicIdentity.validUntil}):null,errorCode,...(diagnostic?{diagnostic}:{})});}
  function set(code,detail) {if(closing)code='IDENTITY_UNAVAILABLE';if(detail!==undefined)diagnostic=detail;else if(code!=='IDENTITY_PENDING')diagnostic=null;errorCode=code;status=code==='IDENTITY_PENDING'?'pending':code==='IDENTITY_LOST'?'identity_lost':code==='IDENTITY_NOT_INITIALIZED'?'not_initialized':'unavailable';publicIdentity=null;}
  function originalGuard(assertCurrent) {
    if(typeof assertCurrent!=='function')fail('STALE_IDENTITY_REQUEST');
    const originalEpoch=epoch;
    return()=>{if(closing||epoch!==originalEpoch)fail('STALE_IDENTITY_REQUEST');try{if(ownerCurrent()!==true)fail('STALE_IDENTITY_REQUEST');const result=assertCurrent();if((result!==undefined&&result!==true)||closing||epoch!==originalEpoch||ownerCurrent()!==true)fail('STALE_IDENTITY_REQUEST');}catch{fail('STALE_IDENTITY_REQUEST');}};
  }
  function request(options) {
    try{
    if(!exact(options,['address','assertCurrent']))fail('STALE_IDENTITY_REQUEST');const d=Object.getOwnPropertyDescriptors(options);
    if(d.address.get||d.address.set||d.assertCurrent.get||d.assertCurrent.set||typeof d.assertCurrent.value!=='function')fail('STALE_IDENTITY_REQUEST');
    const address=addressValue(d.address.value),guard=originalGuard(d.assertCurrent.value);
    guard();return{address,guard};
    }catch(e){if(codeOf(e)==='INVALID_REMOTE_ADDRESS')fail('INVALID_REMOTE_ADDRESS');fail('STALE_IDENTITY_REQUEST');}
  }
  function serial(work) {const task=queue.then(work);queue=task.catch(()=>{});return task;}
  function bindNative(account,guard,onNativeFailure) {
    if(inspectionOnly)fail('IDENTITY_PENDING');
    guard();if(nativeAccount&&nativeAccount!==account)fail('IDENTITY_LOST');
    if(!nativeUsable){if(nativeAccount)fail('IDENTITY_UNAVAILABLE');nativeAccount=account;try{native.initialize(account);}catch(e){onNativeFailure?.(e,'backend-preflight');throw e;}nativeUsable=true;}
    guard();return native;
  }
  function material(index,guard,onNativeFailure) {
    let raw,ref,der;
    try {
      ref=base64(index.referenceBase64,4096);const n=bindNative(index.accountUUID,guard,onNativeFailure);guard();
      try{raw=n.read(ref);}catch(e){onNativeFailure?.(e,'verify-protected-item');const d=e&&Object.getOwnPropertyDescriptor(e,'osStatus');if(d?.value===-25300)fail('IDENTITY_LOST');throw e;}
      guard();if(!Buffer.isBuffer(raw)||raw.length<1||raw.length>65536||sha(raw)!==index.payloadSHA256)fail('IDENTITY_LOST');
      const v=canonical({bytes:raw});if(!exact(v,['version','deviceId','privateKeyDERbase64'])||v.version!==1||v.deviceId!==index.deviceId)fail('IDENTITY_LOST');
      der=base64(v.privateKeyDERbase64,16384);if(keyValue(der).keyFingerprint!==index.keyFingerprint)fail('IDENTITY_LOST');
      const answer=der;der=null;return answer;
    } finally {ref?.fill(0);if(Buffer.isBuffer(raw))raw.fill(0);der?.fill(0);}
  }
  function readBundle(guard) {
    guard();if(!files.probe()){if(everProfileObserved||nativeAccount)fail('IDENTITY_LOST');return null;}everProfileObserved=true;files.open(false);guard();
    const pending=files.read('pending.json'),index=files.read('index.json'),certificate=files.read('certificate.json');
    try {
      if(pending){
        parsePending(pending);diagnostic=legacyIdentityDiagnostic();let saved;
        try{saved=files.read('diagnostic.json');if(saved){const captured=retainedIdentityDiagnostic(canonical(saved),pending.bytes);files.unchanged(pending,'pending.json');diagnostic=captured;}}catch{ /* Changed or optional evidence never authorizes recovery. */ }
        finally{saved?.bytes.fill(0);}
        fail('IDENTITY_PENDING');
      }
      if(!index)fail('IDENTITY_LOST');
      const parsed=parseIndex(index),pub=parseCertificate(certificate,parsed);
      return{index,certificate,parsed,pub};
    } catch(e){pending?.bytes.fill(0);index?.bytes.fill(0);certificate?.bytes.fill(0);throw e;}
  }
  function currentBundle(bundle,guard) {guard();files.assertDirectory();files.unchanged(bundle.index,'index.json');files.unchanged(bundle.certificate,'certificate.json');files.unchanged(null,'pending.json');}
  function operationalFailure(code,detail,bundle,guard) {
    if(detail)try{currentBundle(bundle,guard);}catch(changed){
      // A retired request cannot alter its successor. A current owner whose
      // files changed must stop exposing ready identity, without the old cause.
      guard();const changedCode=codeOf(changed);if(changedCode==='STALE_IDENTITY_REQUEST')fail(changedCode);set(changedCode);return changedCode;
    }
    set(code,detail);return code;
  }
  function publishPublic(value) {if(!publicIdentity||publicIdentity.certificateFingerprint!==value.certificateFingerprint||publicIdentity.deviceId!==value.deviceId)identityVersion++;publicIdentity=Object.freeze(value);status='ready';errorCode=null;diagnostic=null;}
  async function enroll(address,guard) {
    let generated,der,payload,reference,digest,pending,indexSnapshot,certificateSnapshot,nativeFailure,committed=false,owned=false,pendingAttempted=false,createAttempted=false,stage='certificate-generation';
    try {
      guard();generated=await tls.createRemoteCertificate({address});guard();
      if(!exact(generated,['certificatePEM','privateKeyDER','identity'])||!Buffer.isBuffer(generated.privateKeyDER))fail('IDENTITY_UNAVAILABLE');
      der=generated.privateKeyDER;const identity=certificateValue({certificatePEM:generated.certificatePEM,identity:generated.identity},der,address,now);
      const deviceId=uuid(),accountUUID=uuid(),operationId=uuid();if(![deviceId,accountUUID,operationId].every(x=>UUID.test(x)))fail('IDENTITY_UNAVAILABLE');
      payload=Buffer.from(JSON.stringify({version:1,deviceId,privateKeyDERbase64:der.toString('base64')}));if(payload.length>65536)fail('IDENTITY_UNAVAILABLE');digest=crypto.createHash('sha256').update(payload).digest();
      // Availability/account setup creates no item. A locked/unavailable OS
      // backend must not strand a brand-new profile in PENDING before any create.
      stage='backend-preflight';const n=bindNative(accountUUID,guard);
      guard();if(files.probe()){everProfileObserved=true;fail('IDENTITY_PENDING');}files.open(true);everProfileObserved=true;guard();
      stage='write-intent';pendingAttempted=true;pending=files.write('pending.json',{schema:1,operationId,deviceId,accountUUID,keyFingerprint:identity.keyFingerprint},null,guard);
      stage='create-protected-item';guard();createAttempted=true;reference=n.create(payload);owned=true;
      if(!Buffer.isBuffer(reference)||reference.length<1||reference.length>4096)fail('IDENTITY_PENDING');guard();
      const encodedDER=Buffer.from(der.toString('base64'));try{if(reference.includes(der)||reference.includes(payload)||reference.includes(encodedDER))fail('IDENTITY_PENDING');}finally{wipe(encodedDER);}
      const index={schema:1,deviceId,accountUUID,referenceBase64:reference.toString('base64'),payloadSHA256:digest.toString('hex'),keyFingerprint:identity.keyFingerprint};
      stage='verify-protected-item';let verified;try{verified=material(index,guard,error=>{nativeFailure=error;});if(!verified.equals(der))fail('IDENTITY_PENDING');}finally{verified?.fill(0);}
      guard();files.unchanged(pending,'pending.json');files.unchanged(null,'index.json');files.unchanged(null,'certificate.json');
      stage='publish-index';indexSnapshot=files.write('index.json',index,null,guard);
      stage='publish-certificate';certificateSnapshot=files.write('certificate.json',{schema:1,deviceId,...identity},null,guard);
      stage='commit-intent';guard();files.remove('pending.json',pending,guard);committed=true;guard();publishPublic({deviceId,...identity});return state();
    } catch(e) {
      // Cleanup of only this returned create is allowed after revocation; no new identity is retried.
      let cleanup=createAttempted?'not-attempted':'not-needed',mayRemain=createAttempted?undefined:false;
      if(owned){mayRemain=true;if(!committed&&Buffer.isBuffer(reference)&&reference.length>=1&&reference.length<=4096&&digest&&nativeUsable){try{native.remove(reference,digest);cleanup='confirmed';mayRemain=false;}catch{cleanup='unconfirmed';}}}
      const detail=captureIdentityDiagnostic({stage,error:nativeFailure||e,mayRemain,cleanup});
      // Persist only against the original successfully captured intent. A failed
      // publication/capture cannot be reconstructed from a later path lookup.
      if(pending&&!committed){let previous,written;try{guard();files.unchanged(pending,'pending.json');previous=files.read('diagnostic.json');written=files.write('diagnostic.json',identityDiagnosticRecord(pending.bytes,detail),previous,guard);files.unchanged(pending,'pending.json');}catch{ /* Keep the primary cause and the original intent. */ }finally{previous?.bytes.fill(0);written?.bytes.fill(0);}}
      if(codeOf(e)==='STALE_IDENTITY_REQUEST'){set(committed?'IDENTITY_NOT_INITIALIZED':pendingAttempted?'IDENTITY_PENDING':'IDENTITY_NOT_INITIALIZED',detail);throw e;}
      set(pendingAttempted||owned?'IDENTITY_PENDING':codeOf(e)==='IDENTITY_LOST'?'IDENTITY_UNAVAILABLE':codeOf(e),detail);guard();return state();
    } finally {wipe(der);wipe(generated?.privateKeyDER);wipe(payload);wipe(reference);wipe(digest);wipe(pending?.bytes);wipe(indexSnapshot?.bytes);wipe(certificateSnapshot?.bytes);}
  }
  async function initialize(options) {
    const {address,guard}=request(options);
    return serial(async()=>{
      let bundle,der,nativeFailure,certificateCommitted=false;
      try {
        guard();bundle=readBundle(guard);if(!bundle)return await enroll(address,guard);
        der=material(bundle.parsed,guard,(error,stage)=>{nativeFailure=captureIdentityDiagnostic({stage,error,mayRemain:true,cleanup:'not-attempted'});});currentBundle(bundle,guard);
        let identity=null;
        if(bundle.pub){
          try{identity=certificateValue({certificatePEM:bundle.pub.certificatePEM,identity:{address:bundle.pub.address,keyFingerprint:bundle.pub.keyFingerprint,certificateFingerprint:bundle.pub.certificateFingerprint,validUntil:bundle.pub.validUntil,certificatePEM:bundle.pub.certificatePEM}},der,bundle.pub.address,now,true);}catch(e){if(codeOf(e)!=='CERTIFICATE_REISSUE_REQUIRED')throw e;}
        }
        if(!identity||identity.address!==address||Date.parse(identity.validUntil)<=now()){
          if(leases.size)fail('CERTIFICATE_REISSUE_REQUIRED');guard();
          const renewed=await tls.reissueRemoteCertificate({address,privateKeyDER:der});guard();
          identity=certificateValue(renewed,der,address,now);if(identity.keyFingerprint!==bundle.parsed.keyFingerprint)fail('IDENTITY_LOST');
          currentBundle(bundle,guard);const written=files.write('certificate.json',{schema:1,deviceId:bundle.parsed.deviceId,...identity},bundle.certificate,guard);certificateCommitted=true;written.bytes.fill(0);
        }
        guard();publishPublic({deviceId:bundle.parsed.deviceId,...identity});return state();
      } catch(e){const code=codeOf(e);if(code==='STALE_IDENTITY_REQUEST'){if(certificateCommitted)set('IDENTITY_NOT_INITIALIZED');throw e;}operationalFailure(code,nativeFailure,bundle,guard);guard();return state();}
      finally {der?.fill(0);bundle?.index.bytes.fill(0);bundle?.certificate?.bytes.fill(0);}
    });
  }
  // An explicit recovery probe may only read the originally persisted identity.
  // It has no enrollment, certificate renewal, intent cleanup or ACL capability.
  async function retryExisting(options) {
    let guard;
    try{if(!exact(options,['assertCurrent']))fail('STALE_IDENTITY_REQUEST');const descriptor=Object.getOwnPropertyDescriptor(options,'assertCurrent');
      if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')fail('STALE_IDENTITY_REQUEST');guard=originalGuard(descriptor.value);guard();
    }catch{fail('STALE_IDENTITY_REQUEST');}
    return serial(async()=>{
      let bundle,der,nativeFailure;
      try {
        guard();bundle=readBundle(guard);if(!bundle)fail('IDENTITY_NOT_INITIALIZED');
        if(!bundle.pub)fail('CERTIFICATE_REISSUE_REQUIRED');
        der=material(bundle.parsed,guard,(error,stage)=>{nativeFailure=captureIdentityDiagnostic({stage,error,mayRemain:true,cleanup:'not-attempted'});});
        currentBundle(bundle,guard);
        const identity=certificateValue({certificatePEM:bundle.pub.certificatePEM,identity:{address:bundle.pub.address,keyFingerprint:bundle.pub.keyFingerprint,
          certificateFingerprint:bundle.pub.certificateFingerprint,validUntil:bundle.pub.validUntil,certificatePEM:bundle.pub.certificatePEM}},der,bundle.pub.address,now);
        guard();publishPublic({deviceId:bundle.parsed.deviceId,...identity});return state();
      }catch(error){const code=codeOf(error);if(code==='STALE_IDENTITY_REQUEST')throw error;operationalFailure(code,nativeFailure,bundle,guard);guard();return state();}
      finally{wipe(der);wipe(bundle?.index?.bytes);wipe(bundle?.certificate?.bytes);}
    });
  }
  function metadataFailure(code){throw Object.assign(new Error('The pending metadata observation was refused.'),{code});}
  function metadataReason(error){
    let code='METADATA_UNAVAILABLE',osStatus=null;
    try{const d=error&&Object.getOwnPropertyDescriptors(error);if(d&&Object.hasOwn(d.code||{},'value')&&METADATA_CODES.has(d.code.value)){code=d.code.value;if(Object.hasOwn(d.osStatus||{},'value')&&METADATA_OS_STATUSES.has(d.osStatus.value))osStatus=d.osStatus.value;}}catch{}
    return {code,osStatus};
  }
  function metadataObservation(state,pendingSHA256,code,osStatus){
    // A current observation is separate from state()/diagnostic and is never
    // written to the runtime profile or interpreted as recovery authority.
    return Object.freeze({version:1,kind:'current-pending-metadata',scope:'current-default',state,pendingSHA256,code,osStatus});
  }
  async function inspectPendingMetadata(options){
    let guard;
    try{if(!exact(options,['assertCurrent']))fail('STALE_IDENTITY_REQUEST');const d=Object.getOwnPropertyDescriptor(options,'assertCurrent');if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function')fail('STALE_IDENTITY_REQUEST');guard=originalGuard(d.value);guard();}catch{fail('STALE_IDENTITY_REQUEST');}
    return serial(async()=>{
      let pending,digest,pendingSHA256=null,fence;
      try{
        guard();if(backend!=='macos-default-file-keychain'||!native.inspectPendingMetadata)metadataFailure('METADATA_UNSUPPORTED');
        if(nativeAccount||nativeUsable||leases.size)metadataFailure('INSPECTION_ONLY_REFUSED');
        if(!files.probe())metadataFailure('PENDING_EVIDENCE_UNAVAILABLE');files.open(false);files.assertDirectory();guard();
        pending=files.read('pending.json');if(!pending)metadataFailure('PENDING_EVIDENCE_UNAVAILABLE');const value=parsePending(pending);pendingSHA256=sha(pending.bytes);
        fence=()=>{guard();files.assertDirectory();files.unchanged(pending,'pending.json');if(sha(pending.bytes)!==pendingSHA256)metadataFailure('PENDING_CHANGED');};
        fence();
        if(metadataBinding&&(metadataBinding.pendingSHA256!==pendingSHA256||metadataBinding.accountUUID!==value.accountUUID||metadataBinding.fileIdentity!==pending.identity))metadataFailure('PENDING_CHANGED');
        metadataBinding??=Object.freeze({pendingSHA256,accountUUID:value.accountUUID,fileIdentity:pending.identity});inspectionOnly=true;
        digest=crypto.createHash('sha256').update(pending.bytes).digest();fence();
        const result=await native.inspectPendingMetadata(value.accountUUID,digest);
        fence();
        if(!exact(result,['version','state','pendingSHA256','osStatus']))metadataFailure('METADATA_RESULT_REFUSED');
        const d=Object.getOwnPropertyDescriptors(result);if(Object.values(d).some(field=>!Object.hasOwn(field,'value')))metadataFailure('METADATA_RESULT_REFUSED');
        const observed=Object.fromEntries(Object.entries(d).map(([key,field])=>[key,field.value]));
        if(observed.version!==1||observed.pendingSHA256!==pendingSHA256||
          !(observed.state==='found_current_default'&&observed.osStatus===0||observed.state==='not_found_current_default'&&observed.osStatus===-25300))metadataFailure('METADATA_RESULT_REFUSED');
        return metadataObservation(observed.state,pendingSHA256,observed.state==='found_current_default'?'OK':'ITEM_NOT_FOUND',observed.osStatus);
      }catch(error){
        if(codeOf(error)==='STALE_IDENTITY_REQUEST')throw error;guard();
        if(fence){try{fence();}catch(changed){if(codeOf(changed)==='STALE_IDENTITY_REQUEST')throw changed;return metadataObservation('unavailable',null,'PENDING_CHANGED',null);}}
        const reason=metadataReason(error);return metadataObservation('unavailable',pendingSHA256,reason.code,reason.osStatus);
      }finally{wipe(pending?.bytes);wipe(digest);}
    });
  }
  function wrapLease(lease,guard) {
    const version=identityVersion;let server=null,attempted=false,settled=false,releasePromise=null,settle;
    const canStart=()=>{guard();if(status!=='ready'||!publicIdentity||Date.parse(lease.identity.validUntil)<=now()||version!==identityVersion||lease.identity.certificateFingerprint!==publicIdentity.certificateFingerprint)fail('STALE_IDENTITY_REQUEST');};
    const listenSettled=new Promise(resolve=>{settle=resolve;});
    const record={close:()=>{
      if(releasePromise)return releasePromise;
      releasePromise=(async()=>{
        if(attempted&&!settled)await listenSettled;
        if(server?.listening)await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());});
        await lease.release();leases.delete(record);
      })().catch(()=>{fail('IDENTITY_UNAVAILABLE');});return releasePromise;
    }};
    leases.add(record);
    return Object.freeze({
      identity:Object.freeze({...lease.identity,deviceId:publicIdentity.deviceId}),
      createServer(handler){
        canStart();if(releasePromise||attempted||server)fail('STALE_IDENTITY_REQUEST');
        try{
          server=lease.createServer(handler);const originalListen=server.listen;
          if(!server||typeof originalListen!=='function'||typeof server.once!=='function'||typeof server.close!=='function')fail('IDENTITY_UNAVAILABLE');
          server.once('listening',()=>{settled=true;settle();});server.once('error',()=>{settled=true;settle();});
          server.listen=function(...args){canStart();if(releasePromise||attempted)fail('STALE_IDENTITY_REQUEST');attempted=true;try{return originalListen.apply(server,args);}catch(e){settled=true;settle();throw e;}};
          canStart();return server;
        }catch(e){record.close().catch(()=>{});fail(codeOf(e));}
      },
      release:record.close
    });
  }
  async function acquireServerTLS(options) {
    const {address,guard}=request(options);
    return serial(async()=>{
      let bundle,der,lease,nativeFailure;
      try{
        guard();bundle=readBundle(guard);if(!bundle)fail('IDENTITY_NOT_INITIALIZED');if(!bundle.pub)fail('CERTIFICATE_REISSUE_REQUIRED');der=material(bundle.parsed,guard,(error,stage)=>{nativeFailure=captureIdentityDiagnostic({stage,error,mayRemain:true,cleanup:'not-attempted'});});currentBundle(bundle,guard);
        const identity=certificateValue({certificatePEM:bundle.pub.certificatePEM,identity:{address:bundle.pub.address,keyFingerprint:bundle.pub.keyFingerprint,certificateFingerprint:bundle.pub.certificateFingerprint,validUntil:bundle.pub.validUntil,certificatePEM:bundle.pub.certificatePEM}},der,address,now);
        if(publicIdentity&&bundle.parsed.deviceId!==publicIdentity.deviceId)fail('IDENTITY_LOST');
        guard();publishPublic({deviceId:bundle.parsed.deviceId,...identity});
        guard();lease=tls.createRemoteTLSLease({address,certificatePEM:identity.certificatePEM,privateKeyDER:der});guard();
        if(!lease||typeof lease.createServer!=='function'||typeof lease.release!=='function'||!exact(lease.identity,Object.keys(identity))||!Object.keys(identity).every(k=>lease.identity[k]===identity[k]))fail('IDENTITY_UNAVAILABLE');
        return wrapLease(lease,guard);
      }catch(e){if(lease){try{await lease.release();}catch{}}let code=codeOf(e);if(code!=='STALE_IDENTITY_REQUEST'){
        // Operational reads never create an intent or persist a cause. Publish
        // only the bounded native-call observation for this original bundle.
        code=operationalFailure(code,nativeFailure,bundle,guard);
      }throw Object.assign(new Error('The remote identity request was refused.'),{code});}
      finally{der?.fill(0);bundle?.index.bytes.fill(0);bundle?.certificate?.bytes.fill(0);}
    });
  }
  function publicCertificate() {if(ownerCurrent()!==true||closing)fail('IDENTITY_UNAVAILABLE');if(status!=='ready'||!publicIdentity)fail(errorCode||'IDENTITY_NOT_INITIALIZED');if(Date.parse(publicIdentity.validUntil)<=now())fail('CERTIFICATE_REISSUE_REQUIRED');return Object.freeze({...publicIdentity});}
  function credentialRequest(options,field) {
    if(!exact(options,['scope',field,'assertCurrent']))fail('IDENTITY_UNAVAILABLE');
    const d=Object.getOwnPropertyDescriptors(options);
    if(Object.values(d).some(x=>!Object.hasOwn(x,'value')))fail('IDENTITY_UNAVAILABLE');
    const scope=d.scope.value,value=d[field].value,guard=originalGuard(d.assertCurrent.value);
    if(typeof scope!=='string'||!/^remote-app-client:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:[a-f0-9]{64}$/.test(scope))fail('IDENTITY_UNAVAILABLE');
    if(typeof value!=='string'||value.length<1||value.length>512)fail('IDENTITY_UNAVAILABLE');
    guard();return{scope,value,guard};
  }
  function credentialBytes(value,length) {
    if(!/^[A-Za-z0-9_-]+$/.test(value))fail('IDENTITY_UNAVAILABLE');
    const result=Buffer.from(value,'base64url');
    if((length!==undefined&&result.length!==length)||result.toString('base64url')!==value){result.fill(0);fail('IDENTITY_UNAVAILABLE');}
    return result;
  }
  async function credential(options,seal) {
    const {scope,value,guard}=credentialRequest(options,seal?'secret':'ciphertext');
    return serial(async()=>{
      let bundle,der,key,plain,partial,nonce,tag,data,encoded,nativeFailure,verified=false;
      try {
        guard();bundle=readBundle(guard);if(!bundle)fail('IDENTITY_NOT_INITIALIZED');
        der=material(bundle.parsed,guard,(error,stage)=>{nativeFailure=captureIdentityDiagnostic({stage,error,mayRemain:true,cleanup:'not-attempted'});});currentBundle(bundle,guard);verified=true;diagnostic=null;
        key=Buffer.from(crypto.hkdfSync('sha256',der,Buffer.from('kr.co.season.reviewops.remote-device-identity.v1'),Buffer.from('ReviewOps remote app client credentials v1'),32));
        guard();
        if(seal){
          plain=credentialBytes(value,32);nonce=crypto.randomBytes(12);
          const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(scope));
          data=Buffer.concat([cipher.update(plain),cipher.final()]);tag=cipher.getAuthTag();
          encoded=Buffer.from(JSON.stringify({version:1,nonce:nonce.toString('base64url'),tag:tag.toString('base64url'),data:data.toString('base64url')}));
          currentBundle(bundle,guard);return encoded.toString('base64url');
        }
        encoded=credentialBytes(value);
        let envelope;try{envelope=JSON.parse(encoded.toString('utf8'));}catch{fail('IDENTITY_UNAVAILABLE');}
        if(!exact(envelope,['version','nonce','tag','data'])||envelope.version!==1||!Buffer.from(JSON.stringify(envelope)).equals(encoded))fail('IDENTITY_UNAVAILABLE');
        if(![envelope.nonce,envelope.tag,envelope.data].every(x=>typeof x==='string'&&x.length<=64))fail('IDENTITY_UNAVAILABLE');
        nonce=credentialBytes(envelope.nonce,12);tag=credentialBytes(envelope.tag,16);data=credentialBytes(envelope.data,32);
        const decipher=crypto.createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(Buffer.from(scope));decipher.setAuthTag(tag);
        partial=decipher.update(data);plain=Buffer.concat([partial,decipher.final()]);
        if(plain.length!==32)fail('IDENTITY_UNAVAILABLE');
        currentBundle(bundle,guard);return plain.toString('base64url');
      } catch(e){let code=codeOf(e);if(!verified&&code!=='STALE_IDENTITY_REQUEST')code=operationalFailure(code,nativeFailure,bundle,guard);fail(code);}
      finally{[der,key,plain,partial,nonce,tag,data,encoded,bundle?.index?.bytes,bundle?.certificate?.bytes].forEach(wipe);}
    });
  }
  const sealCredential=options=>credential(options,true),openCredential=options=>credential(options,false);
  function closeAndDrain() {
    if(closePromise)return closePromise;closing=true;epoch++;set('IDENTITY_UNAVAILABLE');
    closePromise=(async()=>{await queue;let failed=false;const results=await Promise.allSettled([...leases].map(x=>x.close()));if(results.some(x=>x.status==='rejected'))failed=true;
      if(!failed&&native){try{native.close();nativeUsable=false;}catch{failed=true;}}
      if(!failed){try{files.close();}catch{failed=true;}}if(failed)fail('IDENTITY_UNAVAILABLE');
    })();return closePromise;
  }
  return Object.freeze({state,initialize,retryExisting,inspectPendingMetadata,acquireServerTLS,publicCertificate,sealCredential,openCredential,closeAndDrain});
}
module.exports={createIdentityOwner};
