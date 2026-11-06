import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {userInfo} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validatePlan,inspectPrivateBundle,compareBuildPair,assertContinuity,sha256,inventory,observeWindowsOriginalMain} from './packaged-identity-continuity.mjs';
import {verifyOriginalMainProcess,createPrivatePaths} from './native-adapters.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';

const run=promisify(execFile),require=createRequire(import.meta.url),repository=fileURLToPath(new URL('..',import.meta.url));
const deadline=(promise,milliseconds)=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Object.assign(new Error('Original operation did not finish.'),{code:'ORIGINAL_EXIT_UNCONFIRMED'})),milliseconds);
 promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);
 server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});

// Runs only inside the admitted packaged Electron main. Original private keys,
// bearer tokens and Keychain references never cross the evaluate boundary.
export async function protectedSummary({app},{dataPath,install,phase,connectionId,principalId,projectId}){
 let secret=null,operation='protected-profile-admission';
 try{
 const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto');
 const assert=process.getBuiltinModule('assert/strict'),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 const expectedExe=process.platform==='darwin'?path.join(install,'Contents/MacOS/ReviewOps'):path.join(install,'ReviewOps.exe');
 assert.equal(app.isPackaged,true);assert.equal(app.getPath('userData'),dataPath);assert.equal(app.getPath('exe'),expectedExe);
 assert.equal(app.getAppPath(),path.join(install,...(process.platform==='darwin'?['Contents','Resources']:['resources']),'app.asar'));
 const provider=process.mainModule.require(app.getAppPath()+'/electron/remote-device-identity.cjs').createRemoteDeviceIdentity({app,dataPath});
 const guard=()=>{assert.equal(app.getPath('userData'),dataPath);assert.equal(app.getPath('exe'),expectedExe);};
 if(phase!=='baseline-enrollment'){
  // Strict protected reopen, with no enrollment or certificate-renewal call.
  operation='protected-server-reopen';
  const lease=await provider.acquireServerTLS({address:'127.0.0.1',assertCurrent:guard});await lease.release();
 }
 const identity=provider.publicCertificate(),backend=provider.state().backend;
 assert.equal(backend,process.platform==='darwin'?'macos-default-file-keychain':'electron-safe-storage');
 const hostsFile=path.join(dataPath,'remote-app-connections/hosts.json'),accessFile=path.join(dataPath,'remote-app-access/approved-apps.json');
 const checkpoint=path.join(dataPath,'identity-continuity-fixture.json');
 const previous=phase==='baseline-enrollment'?null:JSON.parse(fs.readFileSync(checkpoint,'utf8'));
 const selected=previous||{connectionId,principalId,projectId};
 const hosts=JSON.parse(fs.readFileSync(hostsFile,'utf8')),host=hosts.hosts.find(row=>row.id===selected.connectionId);
 assert.ok(host&&typeof host.ciphertext==='string'&&host.ciphertext);
 const scope=`remote-app-client:${host.id}:${host.certificateFingerprint}`;
 operation='protected-credential-open';
 secret=await provider.openCredential({scope,ciphertext:host.ciphertext,assertCurrent:guard});
 if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(secret))throw new Error('Protected credential format was refused.');
 const credentialTokenSHA256=hash(Buffer.from(secret));secret=null;
 const approved=JSON.parse(fs.readFileSync(accessFile,'utf8')).sessions.find(row=>row.id===selected.principalId);
 assert.ok(approved);assert.equal(approved.digest,credentialTokenSHA256);assert.ok(approved.grants.some(row=>row.projectId===selected.projectId));
 const index=fs.readFileSync(path.join(dataPath,'remote-device-identity/index.json'));
 const certificate=fs.readFileSync(path.join(dataPath,'remote-device-identity/certificate.json'));
 const evidence={backend,deviceIdSHA256:hash(Buffer.from(identity.deviceId)),keyFingerprint:identity.keyFingerprint,
  certificateFingerprint:identity.certificateFingerprint,indexSHA256:hash(index),certificateFileSHA256:hash(certificate),
  connectionIdSHA256:hash(Buffer.from(selected.connectionId)),principalIdSHA256:hash(Buffer.from(selected.principalId)),
  credentialScopeSHA256:hash(Buffer.from(scope)),credentialCiphertextSHA256:hash(Buffer.from(host.ciphertext)),
  credentialTokenSHA256,hostTokenSHA256:approved.digest,projectIdSHA256:hash(Buffer.from(selected.projectId)),
  datasetEpochSHA256:hash(Buffer.from(approved.epoch))};
 if(previous)assert.deepEqual(evidence,previous.evidence);
 else fs.writeFileSync(checkpoint,JSON.stringify({schema:1,...selected,evidence}),{flag:'wx',mode:0o600});
 return{evidence,selection:{connectionId:selected.connectionId,principalId:selected.principalId,projectId:selected.projectId}};
 }catch(error){
  // Error objects are serialized by Playwright. Never let a provider or an
  // assertion include protected inputs in an error crossing this boundary.
  let providerCode=null,osStatus=null;
  try{
   const code=Object.getOwnPropertyDescriptor(error,'code')?.value,status=Object.getOwnPropertyDescriptor(error,'osStatus')?.value;
   if(['IDENTITY_UNAVAILABLE','IDENTITY_NOT_INITIALIZED','IDENTITY_LOST','IDENTITY_PENDING','CERTIFICATE_REISSUE_REQUIRED','INVALID_REMOTE_ADDRESS','STALE_IDENTITY_REQUEST'].includes(code))providerCode=code;
   if([-25300,-25308,-25293,-128,-50].includes(status))osStatus=status;
  }catch{}
  throw Object.assign(new Error('Protected identity continuity check was refused.'),{code:'PROTECTED_CONTINUITY_REFUSED',operation,providerCode,osStatus});
 }finally{secret=null;}
}
async function removeOriginalFixture({app},{dataPath,install}){
 const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),crypto=process.getBuiltinModule('crypto'),assert=process.getBuiltinModule('assert/strict');
 assert.equal(app.getPath('userData'),dataPath);assert.equal(app.isPackaged,true);
 assert.equal(app.getAppPath(),path.join(install,...(process.platform==='darwin'?['Contents','Resources']:['resources']),'app.asar'));
 const checkpoint=JSON.parse(fs.readFileSync(path.join(dataPath,'identity-continuity-fixture.json'),'utf8'));
 const indexBytes=fs.readFileSync(path.join(dataPath,'remote-device-identity/index.json'));
 assert.equal(crypto.createHash('sha256').update(indexBytes).digest('hex'),checkpoint.evidence.indexSHA256);
 if(process.platform!=='darwin')return{osItemCleanup:'no-per-item-DPAPI-record',confirmed:true};
 const index=JSON.parse(indexBytes),native=process.mainModule.require(app.getAppPath()+'/electron/remote-device-identity-native.cjs')
  .loadMacIdentityStorage({appPath:app.getAppPath(),packaged:true});
 const reference=Buffer.from(index.referenceBase64,'base64'),digest=Buffer.from(index.payloadSHA256,'hex');
 try{native.remove(reference,digest);return{osItemCleanup:'exact-original-Keychain-reference-and-digest',confirmed:true};}
 finally{reference.fill(0);digest.fill(0);}
}

export function packagedRuntimeIdentity({app}){
 try{
  return{platform:process.platform,pid:process.pid,ppid:process.ppid,packaged:app.isPackaged,executable:app.getPath('exe'),appPath:app.getAppPath(),
   build:process.mainModule.require(app.getAppPath()+'/electron/build-info.cjs').getBuildInfo(app.getVersion())};
 }catch{throw Object.assign(new Error('Packaged main identity observation was refused.'),{code:'PACKAGED_RUNTIME_UNAVAILABLE'});}
}

export async function requestProduct({action,payload}){
 // The preload invoke helper throws in the renderer; Playwright preserves its
 // message/stack but not custom error codes. Keep a fixed envelope instead.
 const codes=['IDENTITY_UNAVAILABLE','IDENTITY_NOT_INITIALIZED','IDENTITY_LOST','IDENTITY_PENDING','CERTIFICATE_REISSUE_REQUIRED','INVALID_REMOTE_ADDRESS','STALE_IDENTITY_REQUEST',
  'ACCESS_DENIED','AUTH_REQUIRED','INVALID_REMOTE_REQUEST','TARGET_MISMATCH','STALE_REMOTE_REQUEST','REMOTE_MANAGEMENT_CLOSED','WEB_ACCESS_ACTIVE','WEB_DRAIN_UNCONFIRMED','APP_DRAIN_UNCONFIRMED'];
 try{
  const reply=await window.reviewops.request(action,payload);
  if(reply?.ok===true)return{ok:true,data:reply.data};
  return{ok:false,error:{code:codes.includes(reply?.error?.code)?reply.error.code:'PRODUCT_OPERATION_REFUSED',message:'Owned product operation refused.'}};
 }catch{return{ok:false,error:{code:'PRODUCT_OPERATION_REFUSED',message:'Owned product operation refused.'}};}
}

export async function main(args=process.argv.slice(2)){
 assert.ok(args.length===2&&args[0]==='--plan','Usage: node scripts/e2e-packaged-identity-continuity.mjs --plan /absolute/plan.json');
 assert.ok(path.isAbsolute(args[1]));const planBytes=fs.readFileSync(args[1]);assert.ok(planBytes.length<=16384);
 const plan=validatePlan(JSON.parse(planBytes.toString('utf8')));
 const output=path.join(repository,'test-results','packaged-identity-continuity',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
 fs.mkdirSync(output,{recursive:true,mode:0o700});
 const reportFile=path.join(output,'result.json'),report={schema:1,ok:false,platform:process.platform,arch:process.arch,
  scope:'Real private packaged bundle replacement and protected identity/saved-connection continuity; not NSIS, product updater UI, two-PC or comprehensive release QA',
  planSHA256:sha256(planBytes),phases:[],processes:[],cleanup:{confirmed:false},identityEnrollmentAttempted:false,identityEnrollmentAttempts:0,failure:null};
 const persist=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 let scratch,active=null,lastExitConfirmed=true,phase='input-admission',step='input-admission',baseline,candidate;
 const asar=require('@electron/asar'),{_electron:electron}=await import('@playwright/test');
 const inspect=(entry,privateRoot=plan.privateRoot)=>inspectPrivateBundle({entry,privateRoot,repository,platform:process.platform,arch:process.arch,asar,run});
 async function quitOriginal(){
  if(!active)return;
  const original=active;
  if(original.record.quitRequested)throw Object.assign(new Error('Original quit remains unconfirmed.'),{code:'ORIGINAL_EXIT_UNCONFIRMED'});
  original.record.quitRequested=true;persist();
  void original.application.evaluate(({app})=>{setImmediate(()=>app.quit());}).catch(()=>{});
  if(process.platform==='win32'&&!original.mainObserver)
   throw Object.assign(new Error('Original Windows main was not bound.'),{code:'ORIGINAL_MAIN_UNCONFIRMED'});
  const [observed,,mainExit]=await deadline(Promise.all([original.childExit,original.applicationClosed,
   original.mainObserver?.exited||Promise.resolve(null)]),30000);
  const natural=observed.code===0&&observed.signal===null&&(!mainExit||mainExit.exitCode===0);
  original.record.exit=observed;original.record.applicationCloseConfirmed=true;original.record.mainExit=mainExit;
  original.record.originalExitConfirmed=true;original.record.naturalExitConfirmed=natural;
  active=null;lastExitConfirmed=natural;persist();
  if(!natural)throw Object.assign(new Error('Original app did not quit naturally.'),{code:'ORIGINAL_EXIT_NOT_CLEAN'});
 }
 try{
  baseline=await inspect(plan.baseline);candidate=await inspect(plan.candidate);compareBuildPair(baseline,candidate);
  report.inputs={baseline,candidate};persist();
  // The shared native helper checks the production socket-path bound before
  // launch. macOS's default temporary directory can exceed that bound.
  const paths=createPrivatePaths(repository);scratch=paths.root;
  const dataPath=paths.data,home=paths.home,installRoot=path.join(scratch,'installation');
  fs.mkdirSync(installRoot,{mode:0o700});
  const install=path.join(installRoot,process.platform==='darwin'?'ReviewOps.app':'ReviewOps'),sshConfig=paths.ssh;
  fs.writeFileSync(sshConfig,'# Owned continuity fixture only\n',{mode:0o600});
  fs.mkdirSync(path.join(dataPath,'updates'),{mode:0o700});fs.writeFileSync(path.join(dataPath,'updates/settings.json'),JSON.stringify({automatic:false,intervalMinutes:10}),{mode:0o600});
  const isolation=process.platform==='darwin'?isolatedModelRuntime({home,dataPath}):{HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex')};
  if(process.platform==='darwin'){
   // The real default file Keychain follows the OS account home, while model,
   // SSH and application data remain in the owned private fixture paths.
   const account=userInfo();
   assert.ok(typeof account.homedir==='string'&&path.isAbsolute(account.homedir)&&!/[\x00-\x1f\x7f]/.test(account.homedir),'The OS account home was refused');
   const osHome=fs.realpathSync(account.homedir),homeStat=fs.lstatSync(osHome);
   assert.ok(osHome!==path.parse(osHome).root&&homeStat.isDirectory()&&!homeStat.isSymbolicLink()&&homeStat.uid===account.uid&&account.uid===process.getuid()&&!(homeStat.mode&0o022),'The canonical owned OS home was refused');
   isolation.HOME=osHome;
  }
  if(process.platform==='win32'){
   fs.mkdirSync(path.join(dataPath,'codex-manager'),{recursive:true});
   fs.writeFileSync(path.join(dataPath,'codex-manager/runtime.json'),JSON.stringify({path:path.join(home,'no-user-runtime.exe')}),{mode:0o600});
  }
  const env={...process.env,...isolation,REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:sshConfig,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig};
  for(const name of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','ELECTRON_EXTRA_LAUNCH_ARGS','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
  const port=await freePort();report.fixture={root:scratch,profile:dataPath,install,port,socketPreflight:paths.socketPreflight};persist();
  const invoke=async(action,payload={})=>{
   const value=await active.page.evaluate(requestProduct,{action,payload});
   if(value?.ok===false)throw Object.assign(new Error('Owned product operation refused.'),{code:value.error?.code||'PRODUCT_OPERATION_REFUSED'});
   return value?.ok===true?value.data:value;
  };
  async function installAndLaunch(admitted,label){
   step='private-bundle-admission';
   assert.equal(active,null);assert.equal(lastExitConfirmed,true,'Do not replace an app whose original process is unconfirmed');
   const source=await inspect({appPath:admitted.appPath,source:admitted.source});assert.equal(source.bundleSHA256,admitted.bundleSHA256);
   const incoming=path.join(installRoot,label+'-incoming'),previous=path.join(installRoot,label+'-previous');
   if(process.platform==='darwin')await run('/usr/bin/ditto',['--norsrc',admitted.appPath,incoming],{timeout:180000});
   else fs.cpSync(admitted.appPath,incoming,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
   assert.equal(sha256(Buffer.from(JSON.stringify(inventory(incoming)))),admitted.bundleSHA256,'Copied private package changed');
   if(fs.existsSync(install))fs.renameSync(install,previous);fs.renameSync(incoming,install);
   const actual=await inspect({appPath:install,source:admitted.source},scratch);assert.equal(actual.bundleSHA256,admitted.bundleSHA256);
   step='original-process-launch';const application=await electron.launch({executablePath:actual.executable,args:[],env,timeout:30000});
   const child=application.process(),record={phase:label,pid:child.pid,source:actual.source,executableSHA256:actual.executableFile.sha256,naturalExitConfirmed:false};
   const childExit=child.exitCode!==null?Promise.resolve({code:child.exitCode,signal:child.signalCode}):new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
   const applicationClosed=new Promise(resolve=>application.once('close',resolve));
   active={application,child,page:null,record,childExit,applicationClosed};lastExitConfirmed=false;report.processes.push(record);persist();
   step='original-first-window';active.page=await application.firstWindow();active.page.setDefaultTimeout(15000);
   step='trusted-renderer-bridge';
   await active.page.waitForFunction(()=>location.protocol==='reviewops:'&&Boolean(window.reviewops?.invoke));
   step='packaged-runtime-summary';const runtime=await application.evaluate(packagedRuntimeIdentity);
   step='packaged-runtime-admission';
   assert.equal(runtime.packaged,true);assert.equal(runtime.executable,actual.executable);assert.deepEqual(runtime.build,actual.build);
   step='original-main-binding';const mainIdentity=verifyOriginalMainProcess({platform:runtime.platform,expectedPlatform:process.platform,pid:runtime.pid,ppid:runtime.ppid,childPID:child.pid});
   record.originalMain=mainIdentity;
   if(process.platform==='win32'){
    step='original-windows-main-lifetime';
    active.mainObserver=observeWindowsOriginalMain({identity:mainIdentity,executable:actual.executable});
    const bound=await deadline(active.mainObserver.bound,15000);
    // The original CDP main must still be the same live owner after the native
    // handle is captured. A descriptor or a reused PID cannot supply this proof.
    const stillOriginal=await application.evaluate(()=>({platform:process.platform,pid:process.pid,ppid:process.ppid}));
    assert.deepEqual(stillOriginal,{platform:runtime.platform,pid:runtime.pid,ppid:runtime.ppid});
    record.originalMainBirth={pid:bound.pid,startTicks:bound.startTicks,executablePathSHA256:sha256(Buffer.from(bound.executable)),observerPID:active.mainObserver.child.pid};persist();
   }
   return actual;
  }
  let original,selection;
  for(const [label,admitted]of [['baseline-enrollment',baseline],['same-version-reinstall',baseline],['changed-bundle-update',candidate]]){
   phase=label;const admittedInstalled=await installAndLaunch(admitted,label);
   if(!original){
    step='baseline-identity-enrollment';
    let state=await invoke('remoteManagement.state');assert.equal(report.identityEnrollmentAttempts,0);
    report.identityEnrollmentAttempted=true;report.identityEnrollmentAttempts=1;persist();
    const initialized=await invoke('remoteManagement.initializeIdentity',{expectedGeneration:state.generation,address:'127.0.0.1'});
    report.initialEnrollment={status:initialized.identity.status,backend:initialized.identity.backend,errorCode:initialized.identity.errorCode};persist();
    if(initialized.identity.status!=='ready')throw Object.assign(new Error('The original identity enrollment was refused.'),{code:initialized.identity.errorCode||'IDENTITY_UNAVAILABLE'});
    const group=await invoke('group.save',{name:'Owned identity continuity'}),project=await invoke('project.save',{groupId:group.id,name:'Preserved shared project'});
    state=await invoke('remoteManagement.state');await invoke('remoteManagement.configureApp',{expectedGeneration:state.generation,bindAddress:'127.0.0.1',port,enabled:true});
    state=await invoke('remoteManagement.state');const invitation=await invoke('remoteManagement.inviteApp',{expectedGeneration:state.generation});
    const certificate=await active.application.evaluate(({app},dataPath)=>process.mainModule.require(app.getAppPath()+'/electron/remote-device-identity.cjs')
     .createRemoteDeviceIdentity({app,dataPath}).publicCertificate(),dataPath);
    const connected=await invoke('remoteApp.connect',{id:'',label:'Owned continuity self connection',address:'127.0.0.1',port,
     certificatePEM:certificate.certificatePEM,certificateFingerprint:certificate.certificateFingerprint,invitation:invitation.invitation});
    state=await invoke('remoteManagement.state');await invoke('remoteManagement.approveApp',{expectedGeneration:state.generation,id:connected.remote.id,
     grants:[{projectId:project.id,read:true,write:false,execute:false}]});
    await invoke('remoteApp.refresh',{id:connected.id});selection={connectionId:connected.id,principalId:connected.remote.id,projectId:project.id};
   }else{
    step='strict-protected-reopen';
    await active.application.evaluate(protectedSummary,{dataPath,install,phase:label});
    const state=await invoke('remoteManagement.state');await invoke('remoteManagement.configureApp',{expectedGeneration:state.generation,bindAddress:'127.0.0.1',port,enabled:true});
    const restored=await invoke('remoteApp.refresh',{id:selection.connectionId});assert.equal(restored.remote.id,selection.principalId);
   }
   step='saved-connection-read';const projects=await invoke('remoteApp.read',{id:selection.connectionId,operation:'projects.list',payload:{}});
   assert.ok(projects.projects.some(row=>row.id===selection.projectId));
   step='protected-continuity-summary';const observed=await active.application.evaluate(protectedSummary,{dataPath,install,phase:label,...selection});
   if(!original)original=observed.evidence;else assertContinuity(original,observed.evidence);
   report.phases.push({phase:label,source:admittedInstalled.source,build:admittedInstalled.build,signing:admittedInstalled.signing,evidence:observed.evidence});persist();
   if(label==='changed-bundle-update'){
    step='exact-original-fixture-cleanup';
    const state=await invoke('remoteManagement.state');await invoke('remoteManagement.configureApp',{expectedGeneration:state.generation,bindAddress:'127.0.0.1',port,enabled:false});
    report.cleanup=await active.application.evaluate(removeOriginalFixture,{dataPath,install});persist();
   }
   step='original-natural-exit';await quitOriginal();
  }
  for(const admitted of [baseline,candidate])assert.equal((await inspect({appPath:admitted.appPath,source:admitted.source})).bundleSHA256,admitted.bundleSHA256,'External input bundle changed');
  assert.equal(report.cleanup.confirmed,true);report.ok=true;phase='complete';fs.rmSync(scratch,{recursive:true,force:true});report.fixture.removed=true;
 }catch(error){
  const codes=['IDENTITY_UNAVAILABLE','IDENTITY_NOT_INITIALIZED','IDENTITY_LOST','IDENTITY_PENDING','CERTIFICATE_REISSUE_REQUIRED','INVALID_REMOTE_ADDRESS','STALE_IDENTITY_REQUEST',
   'ORIGINAL_EXIT_UNCONFIRMED','ORIGINAL_MAIN_UNCONFIRMED','ORIGINAL_EXIT_NOT_CLEAN','PROTECTED_CONTINUITY_REFUSED','PACKAGED_RUNTIME_UNAVAILABLE','SOCKET_PATH_TOO_LONG','PRODUCT_OPERATION_REFUSED','ACCESS_DENIED','AUTH_REQUIRED'];
  report.failure={phase,step,kind:['AssertionError','ReferenceError','TypeError','TimeoutError','Error'].includes(error?.name)?error.name:'Error',
   code:codes.includes(error?.code)?error.code:'CONTINUITY_NOT_VERIFIED',
   operation:['protected-profile-admission','protected-server-reopen','protected-credential-open'].includes(error?.operation)?error.operation:null,
   providerCode:codes.slice(0,7).includes(error?.providerCode)?error.providerCode:null,osStatus:[-25300,-25308,-25293,-128,-50].includes(error?.osStatus)?error.osStatus:null};
 }
 finally{
  if(active){try{await quitOriginal();}catch{report.exitFailure={phase,step:'original-natural-exit',code:'ORIGINAL_EXIT_UNCONFIRMED'};report.failure ||= report.exitFailure;}}
  report.retainedPrivateFixture=Boolean(scratch&&fs.existsSync(scratch));
  report.identityMayRemain=Boolean(report.identityEnrollmentAttempted&&!report.cleanup.confirmed);persist();
 }
 console.log(JSON.stringify({ok:report.ok,report:reportFile,retainedPrivateFixture:report.retainedPrivateFixture,
  originalExitUnconfirmed:Boolean(active),identityMayRemain:report.identityMayRemain}));
 if(!report.ok)process.exitCode=1;
 return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
