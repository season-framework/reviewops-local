// Prepared only. No app/service/UI execution occurred during harness preparation.
import assert from 'node:assert/strict';
import {createAgentReadDiagnostics,retainAgentReadSnapshot,retainAgentReadFailure} from './owned-agent-read-diagnostics.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {finished} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {verifyPackagedBundle,readBoundedJSON} from './packaged-bundle-guards.mjs';
import {verifyNativePacket,verifyReviewedGitFiles,prepareNativeAgentFixture,verifyWindowsAgentExit,verifyNativeFixtureCleanup,snapshotNativeFixtureEvidence} from './native-packet.mjs';
import {selectMainHost,nativePhoto} from './native-adapters.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),cli=name=>{const i=args.indexOf(name);return i<0?null:args[i+1]};
assert.ok(cli('--inputs'),'Exact native input packet required');
const packet=readBoundedJSON(cli('--inputs')),root=fs.realpathSync(packet.repository),target=cli('--target'),mode=cli('--mode');
assert.equal(target,packet.target);assert.equal(mode,packet.mode);assert.ok(['source','private-bundle','nsis-installed'].includes(mode));
const fields={'--source':'source','--expected-files':'expectedFilesPath','--renderer-build-record':'rendererBuildRecordPath','--app':'appPath','--private-install-root':'privateInstallRoot','--bundle-manifest':'bundleManifestPath'};
const option=name=>cli(name)||packet[fields[name]];
if(!args.includes('--run'))throw new Error('Prepared only. Run after root review using --run and exact source/build inputs.');
const expectedHead=option('--source'),expectedFilesPath=option('--expected-files'),buildRecordPath=option('--renderer-build-record');
assert.match(expectedHead||'',/^[a-f0-9]{40}$/);assert.ok(expectedFilesPath&&buildRecordPath);
assert.equal(fs.realpathSync(process.cwd()),fs.realpathSync(root));
assert.equal(process.platform+'-'+process.arch,target);assert.equal(process.versions.electron,undefined);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),fileSha=file=>sha(fs.readFileSync(file));
const git=(...values)=>execFileSync('git',values,{cwd:root,encoding:'utf8'}).trim();
assert.equal(git('rev-parse','HEAD'),expectedHead);assert.equal(git('status','--porcelain'),'','Use final clean reviewed source.');
const expectedFiles=JSON.parse(fs.readFileSync(expectedFilesPath,'utf8')).files;
assert.ok(Array.isArray(expectedFiles)&&expectedFiles.length>=20,'Final complete20+ reviewed source manifest is required');
for(const row of expectedFiles){assert.ok(!path.isAbsolute(row.path)&&!row.path.split('/').includes('..'));assert.equal(fileSha(path.join(root,row.path)),row.sha256,row.path);}
const buildRecord=JSON.parse(fs.readFileSync(buildRecordPath,'utf8'));
assert.equal(buildRecord.source,expectedHead);assert.equal(buildRecord.ok,true);assert.ok(Array.isArray(buildRecord.files)&&buildRecord.files.length);
for(const row of buildRecord.files){assert.ok(row.path.startsWith('dist/')&&!row.path.split('/').includes('..'));assert.equal(fileSha(path.join(root,row.path)),row.sha256,row.path);}
const require=createRequire(path.join(root,'package.json')),{_electron:electron,expect}=require('@playwright/test');
const {invokeSocket}=require(path.join(root,'electron/mcp-server.cjs')),plan=JSON.parse(fs.readFileSync(path.join(here,'owned-service-driver-plan.json'),'utf8'));
assert.equal(plan.sourceCompatibility?.status,'matched-frozen-D3-UI','Frozen D3 UI labels and file hashes must be reviewed before any app/profile launch');
assert.equal(plan.sourceCompatibility.files.length,4,'The frozen D3 UI4 scope is separate from the final full-source and renderer-build inputs');
const reviewedUICompatibility=verifyReviewedGitFiles({repository:root,source:expectedHead,expectedFiles,files:plan.sourceCompatibility.files});
assert.equal(plan.bindingDraftUI?.status,'matched-frozen-D3');
const appPath=option('--app'),privateInstallRoot=option('--private-install-root'),bundleManifestPath=option('--bundle-manifest');
if(mode!=='source')assert.ok(appPath&&privateInstallRoot&&bundleManifestPath,'Private installed app and source-bound root bundle manifest are required');
const packageVersion=readBoundedJSON(path.join(root,'package.json')).version,asar=require('@electron/asar');
const verifyBundle=()=>mode==='source'?(verifyNativePacket(packet),null):verifyPackagedBundle({root,appPath,privateInstallRoot,manifestPath:bundleManifestPath,expectedHead,expectedVersion:packageVersion,buildFiles:buildRecord.files,sourceManifestSHA256:fileSha(expectedFilesPath),rendererBuildRecordSHA256:fileSha(buildRecordPath),asar,expectedTarget:target,installReceiptPath:packet.installReceiptPath});
const bundle=verifyBundle(); // Read-only. Before creating a profile or launching.
const connectionMcp=require(bundle?bundle.mcp.modulePath:path.join(root,'electron/mcp-server.cjs'));
const {getBuildInfo}=require(path.join(root,'electron/build-info.cjs'));

const temporary=fs.realpathSync(packet.ownedRoot),home=path.join(temporary,'home'),data=path.join(temporary,'data');
const output=packet.outputDir;
for(const dir of [home,data,output])fs.mkdirSync(dir,{recursive:true});
const {toolSocketPath}=require(path.join(root,'electron/tool-integration.cjs'));
const preflightSocketPath=toolSocketPath(data,process.platform),toolSocketPreflight={ok:true,platform:process.platform,socketPath:preflightSocketPath,bytes:Buffer.byteLength(preflightSocketPath),contract:'actual production toolSocketPath',contractSourceSHA256:fileSha(path.join(root,'electron/tool-integration.cjs'))};
fs.writeFileSync(path.join(output,'tool-socket-preflight.json'),JSON.stringify(toolSocketPreflight,null,2));
const inside=file=>file===temporary||file.startsWith(temporary+path.sep);
const write=(file,text,mode=0o600)=>{assert.ok(inside(path.resolve(file)));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,{mode});};
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8')),sleep=ms=>new Promise(r=>setTimeout(r,ms));
write(path.join(home,'ssh-config'),'# Private fixture only; no operational SSH hosts\n');
write(path.join(data,'updates/settings.json'),JSON.stringify({automatic:false,intervalMinutes:10}));
const result={source:expectedHead,dirty:false,mode,target,temporary,platform:process.platform,arch:process.arch,startedAt:new Date().toISOString(),toolSocketPreflight,syntheticCLI:true,externalAI:0,SSH:0,installedPackage:mode!=='source',privateCopiedInstallation:mode==='private-bundle',bundleVerification:bundle,checks:[],photos:[],operations:[],errors:[],externalRendererRequests:[],agentRuns:[],runtimeSnapshots:[],requirements:plan.requirements.map(row=>({...row,status:'not-run',observations:[]})),limits:['Only this actual declared target/mode cohort; same16 repeats add no unique count; original NEXT10 incomplete',...plan.limits.filter(text=>!text.includes('Syntax-only')&&!text.includes('source UI')&&!text.includes('native checks on other'))],fullIssueComplete:false};
result.reviewedUICompatibility=reviewedUICompatibility;
result.agentReadDiagnostics=createAgentReadDiagnostics();
result.connectionInfoObservations=[];
const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));
const record=(action,details={})=>{result.operations.push({at:new Date().toISOString(),action,...details});save();};
const pass=(id,name,actual)=>{result.requirements.find(row=>row.id===id).observations.push(name);result.checks.push({id,name,actual,status:'pass'});save();};
// Diagnostic observations never replace the original assertion/stack or a
// cleanup verdict. No product hooks, IPC payloads with tokens, or environment
// dumps are collected. Only our exact created A/B and explicitly rebound D-current fixture roots are read.
const diagnosticDir=path.join(output,'failure-evidence'),fixtureRoots=new Map();
const diagnostics=result.failureEvidence={schema:1,files:[],runtime:[],manifests:[],errors:[],captureComplete:true,confirmsCleanup:false};
const diagnosticError=error=>({name:error?.name||'Error',code:typeof error?.code==='string'?error.code:null,message:String(error?.message??error),stack:typeof error?.stack==='string'?error.stack:null});
let diagnosticSequence=0,diagnosticBytes=0,appJournalFD,appJournalHash;
const diagnosticFailure=(phase,error)=>{diagnostics.captureComplete=false;diagnostics.errors.push({at:new Date().toISOString(),phase,error:diagnosticError(error)});};
function diagnosticJSON(phase,value){
 try{fs.mkdirSync(diagnosticDir,{recursive:true});const file=path.join(diagnosticDir,String(++diagnosticSequence).padStart(4,'0')+'-'+phase+'.json'),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});const receipt={file,size:bytes.length,sha256:sha(bytes),copiedAt:new Date().toISOString()};diagnostics.manifests.push(receipt);return receipt;}
 catch(error){diagnosticFailure(phase,error);return null;}
}
const statIdentity=stat=>({dev:String(stat.dev),ino:String(stat.ino),size:Number(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)});
const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const sameFileState=(a,b)=>sameIdentity(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
function registerFixtureRoot(project,requestedRoot){
 const leaf=['A','B'].includes(project.label)?'project-'+project.label:project.label==='D'&&requestedRoot===path.join(temporary,'project-D-current')?'project-D-current':null;
 if(!leaf)return;
 try{assert.ok(projects.includes(project),'Only the original created project object may be registered');const expectedRoot=path.join(temporary,leaf);assert.equal(project.work,expectedRoot);const canonical=fs.realpathSync.native(project.work),expected=path.join(fs.realpathSync.native(temporary),leaf),stat=fs.lstatSync(project.work,{bigint:true});assert.equal(canonical,expected);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());fixtureRoots.set(project,{expectedRoot,projectId:project.id,canonical,identity:statIdentity(stat),registeredAt:new Date().toISOString()});}
 catch(error){diagnosticFailure('register-fixture-'+project.label,error);}
}
function captureFixtureFiles(phase){
 try{captureFixtureFilesRead(phase);}catch(error){diagnosticFailure(phase+'-collector',error);}
}
function captureFixtureFilesRead(phase){
 const allowed=['service-current.json','service-log.jsonl','cleanup-marker.json','stored-state.json'],limit=4*1024**2,totalLimit=32*1024**2;
 for(const [project,guard] of fixtureRoots){
  for(const name of allowed){
   const row={phase,projectId:project.id,connectionId:project.connection.id,label:project.label,name,startedAt:new Date().toISOString(),status:'unread',noFollowFlagAvailable:Boolean(fs.constants.O_NOFOLLOW)},source=path.join(project.work,name);let fd;
   diagnostics.files.push(row);
   try{
    assert.ok(projects.includes(project)&&guard.projectId===project.id,'Only the registered original project object may be read');assert.equal(project.work,guard.expectedRoot);assert.equal(fs.realpathSync.native(project.work),guard.canonical);
    const rootBefore=fs.lstatSync(project.work,{bigint:true});assert.ok(rootBefore.isDirectory()&&!rootBefore.isSymbolicLink());assert.ok(sameIdentity(statIdentity(rootBefore),guard.identity));
    const canonical=fs.realpathSync.native(source);assert.equal(canonical,path.join(guard.canonical,name));assert.equal(path.relative(guard.canonical,canonical),name);
    const before=fs.lstatSync(source,{bigint:true});assert.ok(before.isFile()&&!before.isSymbolicLink());assert.ok(before.size<=BigInt(limit),'Fixture evidence exceeds per-file4MiB cap');assert.ok(diagnosticBytes+Number(before.size)<=totalLimit,'Fixture evidence exceeds aggregate32MiB cap');
    fd=fs.openSync(canonical,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));const opened=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(source,{bigint:true});
    assert.ok(opened.isFile()&&!named.isSymbolicLink());assert.ok(sameFileState(statIdentity(before),statIdentity(opened))&&sameFileState(statIdentity(named),statIdentity(opened)));assert.equal(fs.realpathSync.native(source),canonical);
    const buffer=Buffer.alloc(Number(opened.size));let length=0;row.readStartedAt=new Date().toISOString();
    while(length<buffer.length){const count=fs.readSync(fd,buffer,length,buffer.length-length,length);if(!count)break;length+=count;}
    row.readFinishedAt=new Date().toISOString();const bytes=buffer.subarray(0,length),after=fs.fstatSync(fd,{bigint:true}),finalNamed=fs.lstatSync(source,{bigint:true}),rootAfter=fs.lstatSync(project.work,{bigint:true});
    const stable=length===Number(opened.size)&&sameFileState(statIdentity(opened),statIdentity(after))&&sameFileState(statIdentity(after),statIdentity(finalNamed))&&!finalNamed.isSymbolicLink()&&rootAfter.isDirectory()&&!rootAfter.isSymbolicLink()&&sameIdentity(statIdentity(rootAfter),guard.identity)&&fs.realpathSync.native(project.work)===guard.canonical&&fs.realpathSync.native(source)===canonical;
    fs.mkdirSync(diagnosticDir,{recursive:true});const copy=path.join(diagnosticDir,String(++diagnosticSequence).padStart(4,'0')+'-'+phase+'-'+project.label+'-'+name);fs.writeFileSync(copy,bytes,{flag:'wx',mode:0o600});diagnosticBytes+=bytes.length;
    Object.assign(row,{source,canonicalSource:canonical,registeredRoot:guard,copy,size:bytes.length,sha256:sha(bytes),copiedAt:new Date().toISOString(),before:statIdentity(before),opened:statIdentity(opened),after:statIdentity(after),finalNamed:statIdentity(finalNamed),stable,status:stable?'copied-stable':'copied-unstable',atomicSnapshotClaimed:false});
    if(!stable)diagnosticFailure(phase+'-'+project.label+'-'+name,new Error('Fixture changed during observation; copied bytes are retained as an unstable observation, not a complete stable file.'));
   }catch(error){row.status=error.code==='ENOENT'?'absent':'capture-error';row.error=diagnosticError(error);row.finishedAt=new Date().toISOString();if(error.code!=='ENOENT')diagnosticFailure(phase+'-'+project.label+'-'+name,error);}
   finally{if(fd!==undefined)try{fs.closeSync(fd);}catch(error){diagnosticFailure(phase+'-close-'+project.label+'-'+name,error);}}
  }
 }
 diagnosticJSON(phase+'-files',{phase,at:new Date().toISOString(),files:diagnostics.files.filter(row=>row.phase===phase),copiedBytesTotal:diagnosticBytes});
}
async function capturePostStopRuntime(project,page,phase){
 if(!fixtureRoots.has(project))return;
 const row={phase,projectId:project.id,connectionId:project.connection.id,requestedAt:new Date().toISOString(),action:'serviceRuntime.state',payload:{projectId:project.id,connectionId:project.connection.id}};diagnostics.runtime.push(row);
 try{row.response=await boundedCleanup(request(page,row.action,row.payload),'readonly post-stop fixture state',3000);row.receivedAt=new Date().toISOString();}
 catch(error){row.error=diagnosticError(error);row.receivedAt=new Date().toISOString();diagnosticFailure(phase,error);}
 diagnosticJSON(phase+'-runtime',row);
}
function expectedNativePath(file,role){
 const legacy=fs.realpathSync(file);if(process.platform!=='win32')return legacy;
 const expected=fs.realpathSync.native(file);(result.expectedPathObservations??=[]).push({role,requestedPath:file,legacyRealpath:legacy,expectedNativePath:expected,checkedAt:new Date().toISOString(),actualValueRewritten:false});return expected;
}
let app,main,a,b,externalServer,qaHandle,fixture;
const agentExecutable=process.platform==='win32'?path.join(temporary,'bin/codex.exe'):path.join(temporary,'fixture-codex');const projects=[],jobs=[],ownedApps=[];
const appLaunchAttempts=result.appLaunchAttempts=[];
const appEvidence=owner=>({pid:owner.pid,exitObserved:owner.exitObserved,closedObserved:owner.closedObserved,exit:owner.exit||null});
function journalOwnedApp(owner,phase,details={}){
 try{
  assert.ok(ownedApps.includes(owner),'Only original retained application/process handles may be observed');
  if(appJournalFD===undefined){const file=path.join(output,'retained-app-events.jsonl');appJournalFD=fs.openSync(file,'wx',0o600);appJournalHash=crypto.createHash('sha256');result.retainedAppJournal={file,size:0,source:'Original retained Electron application and ChildProcess handles only'};}
  const bytes=Buffer.from(JSON.stringify({at:new Date().toISOString(),phase,launchAttemptId:owner.launchAttemptId,...appEvidence(owner),...details})+'\n');fs.appendFileSync(appJournalFD,bytes);appJournalHash.update(bytes);result.retainedAppJournal.size+=bytes.length;result.retainedAppJournal.sha256=appJournalHash.copy().digest('hex');
 }catch(error){diagnosticFailure('retained-app-'+phase,error);}
}
function retainOwnedApp(application,launchAttemptId){
 const child=application.process(),owner={application,child,launchAttemptId,pid:child.pid,exitObserved:false,closedObserved:false};ownedApps.push(owner);
 journalOwnedApp(owner,'retained');
 child.once('exit',(code,signal)=>{owner.exitObserved=true;owner.exit={code,signal,at:new Date().toISOString()};journalOwnedApp(owner,'process-exit');record('owned-Electron-process-exit',appEvidence(owner));});
 child.once('close',(code,signal)=>{journalOwnedApp(owner,'process-stdio-closed',{code,signal});save();});
 application.once('close',()=>{owner.closedObserved=true;journalOwnedApp(owner,'application-closed');record('owned-Electron-application-closed',appEvidence(owner));});
 return owner;
}
async function confirmedAppExit(application,timeout=15000){
 const owner=ownedApps.find(value=>value.application===application);assert.ok(owner,'Only retained Electron application handles may be observed');
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(owner.exitObserved&&owner.closedObserved)return {confirmed:true,...appEvidence(owner)};await sleep(50);}
 return {confirmed:false,reason:'owned-Electron-exit-or-close-unconfirmed',...appEvidence(owner)};
}
async function boundedCleanup(promise,label,timeout=8000){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),timeout);})]);}finally{clearTimeout(timer);}
}
async function cleanupChannels(application){
 const channels=[];
 for(const page of application.windows()){
  if(page.isClosed())continue;
  let url;try{url=new URL(page.url());}catch{continue;}
  if(url.protocol!=='reviewops:'||url.host!=='app')continue;
  try{const context=await boundedCleanup(ipc(page,'window.context'),'owned consumer context',3000);channels.push({page,context});}
  catch(error){record('cleanup-consumer-unavailable',{message:error.message});}
 }
 return channels;
}
const matchingChannel=(channels,projectId)=>channels.find(value=>!value.context.projectId&&!value.context.qaProjectId)||channels.find(value=>value.context.projectId===projectId);
const ipc=(page,action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const request=(page,action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.request(action,payload),{action,payload});
async function until(read,predicate,label,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){const value=await read();if(predicate(value))return value;await sleep(50)}throw new Error('Timed out: '+label);}
async function denied(page,action,payload,code){const response=await request(page,action,payload);assert.equal(response.ok,false,action);if(code)assert.equal(response.error.code,code);record('denied',{action,code:response.error.code});return response.error;}
async function locale(page){await page.waitForFunction(()=>location.protocol==='reviewops:'&&Boolean(window.reviewops?.invoke));await page.evaluate(()=>localStorage.setItem('reviewops.language','ko'));await page.reload();await page.waitForFunction(()=>document.documentElement.lang==='ko');}
function connectionFileSnapshot(file,max,optional=false){
 let info;try{info=fs.lstatSync(file);}catch(error){if(optional&&error.code==='ENOENT')return {exists:false};throw error;}
 assert.ok(info.isFile()&&!info.isSymbolicLink());assert.ok(Number.isSafeInteger(info.size)&&info.size<=max);
 const bytes=fs.readFileSync(file);assert.equal(bytes.length,info.size);const after=fs.lstatSync(file);
 for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],info[key],'Observed file changed during its snapshot');
 return {exists:true,bytes:bytes.length,sha256:sha(bytes)};
}
function connectionDatabaseSnapshot(){
 return Object.fromEntries(['reviewops.sqlite','reviewops.sqlite-wal'].map(name=>[name,connectionFileSnapshot(path.join(data,name),32*1024*1024,true)]));
}
function connectionShmDiagnostic(){
 try{return connectionFileSnapshot(path.join(data,'reviewops.sqlite-shm'),32*1024*1024,true);}
 catch(error){return {unavailable:true,reason:error.code||error.name||'snapshot-unavailable',strictEqualityRequired:false};}
}
const normalizedConnectionBuild=build=>({channel:build.channel,version:build.version,buildNumber:build.buildNumber??null,developmentNumber:build.developmentNumber??null,commit:build.commit??null,builtAt:build.builtAt??null});
const redactedConnectionPath=(homePath,value)=>{const relative=path.relative(homePath,value);return !relative?'$HOME':relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)?'$HOME'+path.sep+relative:value;};
async function connectionWindowSnapshot(application){
 return application.evaluate(({BrowserWindow})=>({focusedOwnedWindowId:BrowserWindow.getFocusedWindow()?.id??null,windows:BrowserWindow.getAllWindows().map(host=>({id:host.id,url:host.webContents.getURL(),visible:host.isVisible(),minimized:host.isMinimized(),bounds:host.getBounds()})).sort((a,b)=>a.id-b.id)}));
}
async function observeConnectionInfo(application,page,phase,qaBinding=null){
 const owner=ownedApps.find(value=>value.application===application);assert.ok(owner?.connectionIdentity,'Use only the original retained app and startup getters');
 const {native,info}=owner.connectionIdentity,observerKey='__ownedConnectionInfo_'+crypto.randomUUID().replaceAll('-','');
 const row={phase,launchAttemptId:owner.launchAttemptId,originalAppPID:owner.pid,target,mode,source:expectedHead,startedAt:new Date().toISOString(),status:'pending',formalQAIDsAdded:0,newOSProcesses:0,transport:'actual MCP JSON-RPC exports in original driver Node and authenticated selected app socket',...(qaBinding?{originalLease:{...qaBinding},originalLeaseReleaseConfirmed:false}:{})};
 result.connectionInfoObservations.push(row);save();
 const config=connectionMcp.options(['--data-path',data,...(qaBinding?['--project-id',qaBinding.projectId]:[])]);
 assert.equal(config.selection,'data-path-argument');assert.equal(config.connectionPath,path.join(data,'integrations','tools.json'));
 const descriptor=fs.readFileSync(config.connectionPath);assert.ok(descriptor.length<=8192);
 let selected;try{selected=JSON.parse(descriptor.toString('utf8'));}catch{throw new Error('Owned connection descriptor JSON is invalid');}
 assert.ok(selected&&typeof selected==='object'&&!Array.isArray(selected)&&Object.keys(selected).sort().join(',')==='pid,socketPath,token,version','Owned descriptor shape is invalid');assert.ok(selected.pid===owner.child.pid,'Owned descriptor PID differs from retained child');assert.ok(selected.socketPath===preflightSocketPath&&selected.version===1,'Owned descriptor route/version differs');
 // Raw descriptor/token bytes remain volatile. Only equality booleans are saved.
 const databaseBefore=connectionDatabaseSnapshot(),windowsBefore=await connectionWindowSnapshot(application),shmBefore=connectionShmDiagnostic();
 await page.evaluate(key=>{const state={changes:0};state.unsubscribe=window.reviewops.onDataChange(()=>{state.changes++;});Object.defineProperty(globalThis,key,{value:state,configurable:true});},observerKey);
 const input=new PassThrough(),outputStream=new PassThrough(),pendingReplies=new Map(),pendingSockets=new Set(),wire=[];row.wire=wire;
 let sequence=0,buffer='',wireBytes=0,wireError,server,originalError;
 const failReplies=error=>{wireError=error;for(const pending of pendingReplies.values())pending.reject(error);pendingReplies.clear();};
 outputStream.setEncoding('utf8');outputStream.on('data',chunk=>{
  if(wireError)return;wireBytes+=Buffer.byteLength(chunk);if(wireBytes>64*1024){failReplies(new Error('Connection diagnostic response budget exceeded'));return;}
  buffer+=chunk;
  try{while(buffer.includes('\n')){const end=buffer.indexOf('\n'),message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);wire.push({direction:'response',message});const pending=pendingReplies.get(message.id);assert.ok(pending,'Unexpected connection diagnostic response');pendingReplies.delete(message.id);pending.resolve(message);}}
  catch(error){failReplies(error);}
 });
 const rpc=(method,params)=>{
  assert.equal(wireError,undefined);const id=++sequence,message={jsonrpc:'2.0',id,method,params};
  const response=new Promise((resolve,reject)=>pendingReplies.set(id,{resolve,reject}));wire.push({direction:'request',message});input.write(JSON.stringify(message)+'\n');
  return boundedCleanup(response,'selected-app MCP response');
 };
 try{
  server=connectionMcp.createMcpServer({input,output:outputStream,projectId:config.projectId,connectionSelection:{selection:config.selection,connectionPath:config.connectionPath,homePath:os.homedir(),platform:process.platform},invoke:(action,args)=>{
   assert.equal(action,'connection.info','Diagnostic client cannot acquire or release a QA lease');assert.deepEqual(args,{});
   const pending=connectionMcp.invokeSocket(config.connectionPath,action,args,{timeoutMs:5000}).finally(()=>pendingSockets.delete(pending));pendingSockets.add(pending);return pending;
  }});
  const initialized=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'owned-native-connection-info',version:'1'}});assert.equal(initialized.error,undefined);
  const response=await rpc('tools/call',{name:'reviewops_connection_info',arguments:{}});assert.equal(response.error,undefined);assert.equal(response.result?.isError,false);
  const value=response.result.structuredContent;assert.ok(value);assert.equal(Buffer.byteLength(JSON.stringify(value))<=16*1024,true);
  assert.equal(value.app.version,native.version);assert.equal(value.app.isPackaged,native.isPackaged);assert.equal(value.app.platform,native.platform);assert.equal(value.app.arch,native.arch);
  const actualBuild=bundle?(bundle.embeddedBuild||{channel:'stable',version:packageVersion}):getBuildInfo(packageVersion),expectedBuild=normalizedConnectionBuild(actualBuild);
  assert.deepEqual(value.app.build,expectedBuild);assert.deepEqual(normalizedConnectionBuild(info.build),expectedBuild);
  assert.equal(value.app.displayVersion,actualBuild.channel==='test'?actualBuild.developmentNumber?`${packageVersion}-dev-${actualBuild.developmentNumber}`:`${packageVersion}-test.${actualBuild.buildNumber}`:packageVersion);
  assert.deepEqual(value.location,{dataRootSource:'environment',dataPath:redactedConnectionPath(native.OSHome,data),appPath:redactedConnectionPath(native.OSHome,native.appPath),executablePath:redactedConnectionPath(native.OSHome,native.executablePath),homeRedacted:true});
  assert.deepEqual(value.qa,{protocolVersion:1,actions:['open','state','click','type','key','scroll','capture','navigate','reload','close','release'],bindingFields:['sessionId','projectId','windowId'],optionalBrowserId:true,documentGeneration:false});
  assert.equal(value.client.selection,'data-path-argument');assert.equal(value.client.boundProjectId,qaBinding?.projectId??null);assert.equal(value.client.connectionPath,redactedConnectionPath(os.homedir(),config.connectionPath));
  assert.match(value.instanceId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  if(owner.connectionInstanceId)assert.equal(value.instanceId,owner.connectionInstanceId);else{assert.ok(ownedApps.every(other=>other===owner||other.connectionInstanceId!==value.instanceId));owner.connectionInstanceId=value.instanceId;}
  const changes=await page.evaluate(key=>globalThis[key].changes,observerKey),databaseAfter=connectionDatabaseSnapshot(),windowsAfter=await connectionWindowSnapshot(application);assert.equal(changes,0);
  assert.deepEqual(databaseAfter,databaseBefore);assert.deepEqual(windowsAfter,windowsBefore);assert.ok(fs.readFileSync(config.connectionPath).equals(descriptor),'Connection query changed its selected descriptor');assert.equal(pendingReplies.size,0);assert.equal(buffer,'');
  Object.assign(row,{status:'query-validated',publicInformation:value,wire,descriptorUnchanged:true,descriptorPIDMatchesOriginalOwner:true,tokenOrDescriptorLogged:false,databaseBefore,databaseAfter,rendererDataChangeEvents:changes,windowsBefore,windowsAfter,ownedWindowsUnchanged:true,shmDiagnostic:{before:shmBefore,after:connectionShmDiagnostic(),strictEqualityRequired:false},MCPModule:bundle?bundle.mcp:{modulePath:path.join(root,'electron/mcp-server.cjs'),sha256:fileSha(path.join(root,'electron/mcp-server.cjs'))}});
  return row;
 }catch(error){originalError=error;row.failure=diagnosticError(error);throw error;}
 finally{
  let cleanupError;
  try{await Promise.allSettled([...pendingSockets]);input.end();await server?.close();input.resume();outputStream.end();await Promise.all([finished(input),finished(outputStream)]);row.inProcessStreamsFinished=true;}
  catch(error){cleanupError=error;row.streamCleanupFailure=diagnosticError(error);}
  try{
   if(page.isClosed())throw new Error('Original diagnostic observer page closed before cleanup');
   const finalChanges=await page.evaluate(key=>{const state=globalThis[key];if(!state)throw new Error('Original diagnostic observer is missing');state.unsubscribe();delete globalThis[key];return state.changes;},observerKey);
   row.rendererDataChangeEvents=finalChanges;assert.equal(finalChanges,0,'Connection query or its client cleanup emitted a data change');
  }
  catch(error){cleanupError||=error;row.observerCleanupFailure=diagnosticError(error);}
  row.status=originalError||cleanupError?'failed':'pass';
  row.completedAt=new Date().toISOString();save();
  if(cleanupError&&!originalError)throw cleanupError;
 }
}
function environment(){assert.ok(fixture,'Synthetic fixture must compile/preflight before app launch');return fixture.environment;}
async function launch(){
 verifyBundle();assertSyntheticLaunchInputs();
 const launchOptions={... (bundle?{executablePath:bundle.executablePath,args:[]}:{args:[root]}),env:environment(),timeout:30000};
 const attempt={id:appLaunchAttempts.length+1,startedAt:new Date().toISOString(),status:'handle-unconfirmed'};appLaunchAttempts.push(attempt);save();
 let launched;
 try{launched=await electron.launch(launchOptions);}catch(error){attempt.rejection=error.message;save();throw error;}
 app=launched;const owner=retainOwnedApp(launched,attempt.id);attempt.status='retained';attempt.pid=owner.pid;save();main=null;
 const selected=await selectMainHost(launched,until,ipc,boundedCleanup),page=selected.page;main=page;await locale(page);
 const native=await launched.evaluate(({app})=>({isPackaged:app.isPackaged,version:app.getVersion(),appPath:app.getAppPath(),executablePath:process.execPath,resourcesPath:process.resourcesPath,userData:app.getPath('userData'),OSHome:app.getPath('home'),nodeHome:process.getBuiltinModule('os').homedir(),selectedEnvironment:Object.fromEntries(['HOME','USERPROFILE','CODEX_HOME','REVIEWOPS_DATA_DIR','REVIEWOPS_SSH_CONFIG','REVIEWOPS_CODEX_SSH_CONFIG'].map(k=>[k,process.env[k]])),sshAuthSocketPresent:Boolean(process.env.SSH_AUTH_SOCK),externalCredentialNames:['OPENAI_API_KEY','ANTHROPIC_API_KEY','AZURE_OPENAI_API_KEY','GH_TOKEN','GITHUB_TOKEN','AWS_ACCESS_KEY_ID'].filter(name=>Boolean(process.env[name])),platform:process.platform,arch:process.arch}));
 const info=await ipc(page,'app.info');assert.equal(native.isPackaged,mode!=='source');assert.equal(native.version,packageVersion);
 if(bundle){assert.equal(fs.realpathSync(native.appPath),bundle.appArchivePath);assert.equal(fs.realpathSync(native.executablePath),bundle.executablePath);assert.equal(fs.realpathSync(native.resourcesPath),bundle.resourcesPath);}else assert.equal(fs.realpathSync(native.appPath),root);
 assert.equal(fs.realpathSync(native.userData),data);assert.equal(fs.realpathSync(native.nodeHome),home);assert.equal(native.platform,process.platform);assert.equal(native.arch,process.arch);
 for(const k of ['HOME','USERPROFILE'])assert.equal(fs.realpathSync(native.selectedEnvironment[k]),home);assert.equal(native.selectedEnvironment.CODEX_HOME,path.join(home,'.codex'));assert.equal(native.selectedEnvironment.REVIEWOPS_DATA_DIR,data);assert.equal(native.selectedEnvironment.REVIEWOPS_SSH_CONFIG,path.join(home,'ssh-config'));assert.equal(native.selectedEnvironment.REVIEWOPS_CODEX_SSH_CONFIG,path.join(home,'ssh-config'));
 assert.equal(info.version,packageVersion);assert.equal(fs.realpathSync(info.dataPath),data);assert.equal(info.platform,process.platform);assert.equal(info.arch,process.arch);if(bundle?.build)assert.deepEqual(info.build,bundle.build);
 record('actual-effective-private-paths-before-account-query',{native,appInfo:info,nativeHomeIsOSGetterNotOverridden:true});assert.equal(typeof native.OSHome,'string');assert.ok(path.isAbsolute(native.OSHome));for(const value of Object.values(native.selectedEnvironment)){assert.ok(inside(path.resolve(value)));if(fs.existsSync(value))assert.ok(inside(fs.realpathSync(value)));}assert.equal(native.sshAuthSocketPresent,false);assert.deepEqual(native.externalCredentialNames,[]);
 owner.connectionIdentity={native,info};await observeConnectionInfo(launched,page,'startup');
 const accounts=await page.evaluate(()=>window.accountManager.getState()),hosts=await page.evaluate(()=>window.hostManager.getState());assert.deepEqual(accounts.accounts,[]);assert.equal(accounts.runtime.available,false);assert.equal(accounts.runtime.path,null);assert.deepEqual(hosts.hosts,[]);
 record('actual-packaged-app-and-private-runtime',{native,appInfo:info,accountCount:accounts.accounts.length,accountRuntimeAvailable:accounts.runtime.available,hostCount:hosts.hosts.length,appInfoDoesNotExposeIsPackagedOrPaths:true,sourceOfPackagedFlagAndPaths:'Same actual retained Electron main handle, readonly getters'});

 page.on('pageerror',e=>result.errors.push(e.message));page.on('request',req=>{if(/^https?:/.test(req.url())&&!/^http:\/\/127\.0\.0\.1:/.test(req.url()))result.externalRendererRequests.push(req.url().split('?')[0])});
 // Controlled dialog choices only. Real Electron windows and DOM beforeunload
 // are used; this does not claim physical clicks on OS-native confirmation UI.
 await launched.evaluate(({dialog},journal)=>{
  const fs=process.getBuiltinModule('fs');
  const trace=value=>fs.appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),fixture:true,...value})+'\n');
  global.__ownedDialogs={answer:0,delayNextMs:0,calls:[],errors:[]};
  dialog.showMessageBoxSync=(_host,options)=>{
   if(options.title!=='저장하지 않은 내용')throw new Error('Unexpected native confirmation');
   const delayMs=global.__ownedDialogs.delayNextMs||0;global.__ownedDialogs.delayNextMs=0;
   if(![0,11000].includes(delayMs))throw new Error('Unexpected controlled dialog delay');
   const answer=global.__ownedDialogs.answer,started=process.hrtime.bigint();
   global.__ownedDialogs.calls.push({title:options.title,message:options.message,answer,delayMs});
   trace({phase:'dialog-start',title:options.title,answer,delayMs});
   // An honest synchronous thinking-delay fixture, never a physical native
   // dialog click. Do not change or wrap production functions/watchdog timers.
   if(delayMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delayMs);
   trace({phase:'dialog-finished',title:options.title,answer,delayMs,elapsedMs:Number(process.hrtime.bigint()-started)/1e6});
   return answer;
  };
  dialog.showErrorBox=(title,message)=>{global.__ownedDialogs.errors.push({title,message});trace({phase:'error-dialog',title,message});};
 },path.join(temporary,'native-dialog-fixture.jsonl'));
 return {app:launched,page};
}
function assertSyntheticLaunchInputs(){
 assert.ok(fixture);verifyNativePacket(packet);for(const row of fixture.files)assert.equal(fileSha(row.path),row.sha256);
 const disabledRuntime=path.join(home,'no-user-runtime');assert.deepEqual(readJSON(path.join(data,'codex-manager/runtime.json')),{path:disabledRuntime});assert.equal(fs.existsSync(disabledRuntime),false);
 const env=environment();for(const key of ['HOME','USERPROFILE'])assert.equal(env[key],home);assert.equal(env.CODEX_HOME,path.join(home,'.codex'));assert.equal(env.REVIEWOPS_DATA_DIR,data);assert.equal(env.SSH_AUTH_SOCK,undefined);assert.equal(env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(fs.existsSync(path.join(env.CODEX_HOME,'auth.json')),false);
 record('synthetic-only-prelaunch-boundary',{agentExecutable:fixture.agentExecutable,agentScript:fixture.agentScript,fixtureFiles:fixture.files,disabledAccountRuntime:disabledRuntime,externalAIRequestsAllowed:false,OSNetworkFirewallClaimed:false});
}
const pane=page=>page.locator('.workspace-pane:not([hidden])'),panel=page=>pane(page).locator('.service-readiness'),owned=page=>panel(page).locator('.owned-service-runtime');
async function show(page){if(await panel(page).getAttribute('open')===null)await panel(page).locator('summary').click();await expect(owned(page)).toBeVisible();}
async function runtime(project,page=main){const state=await ipc(page,'serviceRuntime.state',{projectId:project.id,connectionId:project.connection.id});result.runtimeSnapshots.push({at:new Date().toISOString(),appPid:app?.process().pid,projectId:project.id,state});return state;}
function projectHostURL(raw,target){
 try{const url=new URL(raw);return url.protocol==='reviewops:'&&url.host==='app'&&url.pathname==='/index.html'&&!url.username&&!url.password&&!url.hash&&url.searchParams.size===2&&url.searchParams.getAll('projectId').length===1&&url.searchParams.getAll('windowId').length===1&&url.searchParams.get('projectId')===target.projectId&&url.searchParams.get('windowId')===target.windowId;}catch{return false;}
}
function redactedWindowURL(raw){
 const id=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value||'')?value:value===null?null:'[redacted]';
 try{const url=new URL(raw),trusted=url.protocol==='reviewops:'&&url.host==='app',loopback=url.protocol==='http:'&&url.hostname==='127.0.0.1';return {scheme:url.protocol,host:trusted||loopback?url.host:'[nonfixture-or-empty]',path:trusted||loopback?url.pathname:'[redacted]',...(trusted?{projectId:id(url.searchParams.get('projectId')),windowId:id(url.searchParams.get('windowId'))}:{ }),otherQueryRemoved:[...url.searchParams.keys()].some(key=>!trusted||!['projectId','windowId'].includes(key)),fragmentRemoved:Boolean(url.hash),credentialsRemoved:Boolean(url.username||url.password)};}catch{return {scheme:'unparsed',value:'[redacted]'};}
}
async function ownWindowDiagnostics(target,phase){
 if(!app)return;
 const pages=app.windows(),rows=pages.map((page,index)=>({index,closed:page.isClosed(),url:redactedWindowURL(page.url()),exactTarget:target?projectHostURL(page.url(),target):false}));
 await Promise.allSettled(pages.map(async(page,index)=>{
  if(page.isClosed()||rows[index].url.scheme!=='reviewops:'||rows[index].url.host!=='app')return;
  try{const ready=await boundedCleanup(page.evaluate(()=>Boolean(window.reviewops?.invoke)),'diagnostic own host bridge',1000);rows[index].bridgeReady=ready;if(ready){const context=await boundedCleanup(ipc(page,'window.context'),'diagnostic own host context',1000);rows[index].context={projectId:context.projectId,windowId:context.windowId,qaProjectId:context.qaProjectId||null};}}
  catch(error){rows[index].contextError=error.name||'context-unavailable';}
 }));
 record('own-window-selection-diagnostic',{phase,target,windows:rows,querySecretsRecorded:false});
}
async function open(project,origin=main){
 assert.ok(origin&&!origin.isClosed(),'Opening a project requires a surviving owned trusted renderer');
 let target;
 try{
  target=await ipc(origin,'window.openProject',{projectId:project.id});assert.equal(target.projectId,project.id);assert.equal(typeof target.windowId,'string');assert.ok(target.windowId.length>0);
  const selected=await until(async()=>{
   const candidates=app.windows().filter(page=>!page.isClosed()&&projectHostURL(page.url(),target));assert.ok(candidates.length<=1,'More than one retained host claims the exact project/window identity');if(!candidates.length)return null;
   const page=candidates[0],ready=await boundedCleanup(page.evaluate(()=>Boolean(window.reviewops?.invoke)),'exact owned project host bridge',1000).catch(()=>false);if(!ready)return null;
   const context=await boundedCleanup(ipc(page,'window.context'),'exact owned project host context',3000);assert.equal(context.projectId,target.projectId);assert.equal(context.windowId,target.windowId);return {page,context};
  },Boolean,'exact returned project/window host with real bridge/context');
  const page=selected.page;record('exact-project-host-selected-before-locale',{target,url:redactedWindowURL(page.url()),context:selected.context});
  await locale(page);assert.ok(projectHostURL(page.url(),target));const context=await ipc(page,'window.context');assert.equal(context.projectId,target.projectId);assert.equal(context.windowId,target.windowId);
  page.on('pageerror',error=>result.errors.push(error.message));return page;
 }catch(error){await ownWindowDiagnostics(target||{projectId:project.id,windowId:null},'project-open-failure').catch(()=>{});throw error;}
}
async function afterCancelledQuit(project,page,survivor){
 // D1 may already close clean windows before another renderer vetoes unload.
 // Reopen only this own synthetic project through a surviving trusted UI.
 if(!page||page.isClosed()){page=await open(project,survivor);await show(page);record('explicit-own-project-view-reopened-after-quit-veto',{projectId:project.id});}
 const state=await runtime(project,page);assert.equal(state.instance?.status,'exited');assert.equal(state.instance.exit?.drainConfirmed,true);
 record('cancelled-quit-service-remains-stopped',{projectId:project.id,instance:state.instance,automaticRestart:false});
 return {page,state};
}
async function configure(project,page){
 await show(page);
 for(const [name,value] of [['Node 실행 파일',project.config.executable],['프로젝트 안의 .cjs 진입 파일',project.config.entry],['실행 인수 (JSON 문자열 배열)',JSON.stringify(project.config.args)],['관리형 서비스 준비 URL',project.config.readinessUrl]])await owned(page).getByLabel(name,{exact:true}).fill(value);
 await owned(page).getByRole('button',{name:'서비스 설정 저장',exact:true}).click();await expect(owned(page).getByRole('button',{name:'저장한 서비스 시작',exact:true})).toBeEnabled();assert.deepEqual((await runtime(project,page)).config,project.config);record('actual-ui-configuration-save',{projectId:project.id});
}
async function hostID(page){const handle=await app.browserWindow(page);return handle.evaluate(w=>w.id);}
const sourceSelectionFacts=new Map();
async function sourceID(page,origin,deadline=Date.now()+10000){
 const id=await boundedCleanup(hostID(page),'own source host identity',Math.max(1,deadline-Date.now())),expected=new URL(origin).href;
 const parsed=new URL(expected);assert.equal(parsed.protocol,'http:');assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.pathname,'/');assert.equal(parsed.search,'');assert.equal(parsed.hash,'');assert.equal(parsed.username,'');assert.equal(parsed.password,'');
 const key=app.process().pid+':'+id+':'+expected;
 while(true){
  const snapshot=await boundedCleanup(app.evaluate(({webContents,BrowserWindow},{id,expected})=>{
   const children=[];
   for(const contents of webContents.getAllWebContents()){
    if(contents.isDestroyed())continue;const child=BrowserWindow.fromWebContents(contents);if(!child||child.isDestroyed())continue;const parent=child.getParentWindow();if(parent?.id!==id)continue;
    children.push({webContentsId:contents.id,browserWindowId:child.id,parentWindowId:parent.id,url:contents.getURL(),loading:contents.isLoadingMainFrame()});
   }
   return {hostWindowId:id,children,matches:children.filter(value=>value.url===expected)};
  },{id,expected}),'own source inventory',Math.max(1,deadline-Date.now()));
  const facts={hostWindowId:id,expectedURL:redactedWindowURL(expected),count:snapshot.matches.length,children:snapshot.children.map(value=>({...value,url:redactedWindowURL(value.url)}))},signature=JSON.stringify(facts);
  if(sourceSelectionFacts.get(key)!==signature){sourceSelectionFacts.set(key,signature);record('exact-owned-source-selection',facts);}
  if(snapshot.matches.length>1)throw Object.assign(new Error('Ambiguous exact owned fixture sources'),{code:'HARNESS_SOURCE_AMBIGUOUS'});
  if(snapshot.matches.length===1)return snapshot.matches[0].webContentsId;
  if(Date.now()>=deadline)throw Object.assign(new Error('Timed out waiting for exact owned fixture source'),{code:'HARNESS_SOURCE_LOADING_TIMEOUT'});
  await sleep(Math.min(50,Math.max(1,deadline-Date.now())));
 }
}
async function nativeRead(page,origin,expression,deadline){const id=await sourceID(page,origin,deadline);return app.evaluate(({webContents},{id,expression})=>webContents.fromId(id).executeJavaScript(expression),{id,expression});}
async function nativeClick(page,origin,button){
 const id=await sourceID(page,origin),rect=await nativeRead(page,origin,'(()=>{const r=document.getElementById('+JSON.stringify(button)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()'),surface=await pane(page).locator('.native-browser-surface').boundingBox();assert.ok(surface);const scale=surface.width/rect.width;
 await app.evaluate(({webContents},{id,x,y})=>{const w=webContents.fromId(id);w.focus();w.sendInputEvent({type:'mouseMove',x,y});w.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});w.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1})},{id,x:Math.round(rect.x*scale),y:Math.round(rect.y*scale)});record('actual-native-fixture-click',{button,webContentsId:id});
}
async function readyPage(project,page){
 await pane(page).getByRole('button',{name:'뷰어 새로고침',exact:true}).click();const sourceDeadline=Date.now()+10000,expectedURL=new URL(project.origin).href;
 await sourceID(page,project.origin,sourceDeadline);const deadline=Math.min(sourceDeadline,Date.now()+5000); // Keep the original default5s content gate inside the overall10s source deadline.
 while(true){
  const facts=await boundedCleanup(nativeRead(page,project.origin,'({url:location.href,title:document.title,bridge:typeof window.reviewops,hasCoreButton:Boolean(document.getElementById("increment"))})',deadline),'real owned source content readiness',Math.max(1,deadline-Date.now()));
  record('real-owned-source-content-readiness',{projectId:project.id,url:redactedWindowURL(facts.url),title:facts.title,bridge:facts.bridge,hasCoreButton:facts.hasCoreButton});
  assert.equal(facts.url,expectedURL,'Only the exact owned synthetic URL may become ready');assert.equal(facts.bridge,'undefined','Embedded fixture must not receive the application bridge');
  if(facts.title==='Owned synthetic '+project.label&&facts.hasCoreButton)return;
  if(Date.now()>=deadline)throw new Error('Timed out waiting for exact owned fixture content');await sleep(Math.min(50,Math.max(1,deadline-Date.now())));
 }
}
async function start(project,page){
 await owned(page).getByRole('button',{name:'저장한 서비스 시작',exact:true}).click();
 const state=await until(()=>runtime(project,page),s=>s.instance?.status==='running'&&s.instance.listeners.length>0,'owned child and listen observed');await readyPage(project,page);return state.instance;
}
async function restart(project,page){const old=(await runtime(project,page)).instance;await owned(page).getByRole('button',{name:'이 인스턴스 복구',exact:true}).click();const s=await until(()=>runtime(project,page),v=>v.instance?.status==='running'&&v.instance.instanceId!==old.instanceId&&v.instance.listeners.length>0,'fresh selected instance');assert.notEqual(s.instance.pid,old.pid);await readyPage(project,page);return s.instance;}
async function actualJSON(url){assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\//);const response=await fetch(url,{signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);return response.json();}
async function flow(project,page,label){
 const s=await runtime(project,page),meta=readJSON(path.join(project.work,'service-current.json'));assert.deepEqual(s.instance.actual.spawnArgv,[fs.realpathSync(process.execPath),bundle?path.join(bundle.resourcesPath,'owned-services/owned-node-bootstrap.cjs'):path.join(root,'electron/owned-node-bootstrap.cjs')]);assert.equal(s.instance.pid,meta.pid);assert.equal(s.instance.actual.executable,fs.realpathSync(process.execPath));assert.deepEqual(s.instance.actual.argv,[fs.realpathSync(process.execPath),expectedNativePath(path.join(project.work,s.config.entry),'owned-entry'),...s.config.args]);assert.equal(s.instance.entrySnapshot.loadedBytesVerified,false);assert.equal(s.instance.urlOwnership,'unverified');
 const before=(await actualJSON(project.origin+'/state')).count;await nativeClick(page,project.origin,'increment');
 const stored=await until(()=>{try{return readJSON(path.join(project.work,'stored-state.json'))}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error}},v=>v?.count===before+1,'actual file write '+label),state=await actualJSON(project.origin+'/state');assert.deepEqual(state,stored);assert.equal(stored.pid,s.instance.pid);
 await expect.poll(()=>nativeRead(page,project.origin,'(()=>{try{return JSON.parse(document.getElementById("result").textContent)}catch{return null}})()')).toEqual(stored);record('real-core-flow',{label,projectId:project.id,instanceId:s.instance.instanceId,pid:s.instance.pid,stored,httpState:state});return s.instance;
}
async function photo(page,name,origin){
 const id=await hostID(page),at=new Date().toISOString(),host=await boundedCleanup(app.evaluate(async({BrowserWindow},id)=>{const image=await BrowserWindow.fromId(id).capturePage();return{png:image.toPNG().toString('base64'),size:image.getSize()}},id),'raw full app-host photo',10000);
 const saveImage=(suffix,image,scope)=>{const file=path.join(output,name+'-'+suffix+'.png'),bytes=Buffer.from(image.png,'base64');fs.writeFileSync(file,bytes);result.photos.push({file,capturedAt:at,sha256:sha(bytes),dimensions:image.size,original:true,scope})};
 saveImage('host',host,'Original full app host content; native view content may be absent. Read the paired exact native-source image.');
 if(origin){await sourceID(page,origin);const browserId=await pane(page).locator('.native-browser-surface').getAttribute('data-browser-id');assert.ok(browserId);const raw=await nativePhoto(app,page,origin,browserId,ipc,boundedCleanup);saveImage('native',{png:raw.bytes.toString('base64'),size:{width:raw.width,height:raw.height}},'Exact owned synthetic native source via actual product capture adapter; original PNG, not a full application host photo.')}save();
}
async function port(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const value=s.address().port;await new Promise(r=>s.close(r));return value;}
async function create(group,label,number,mode='normal'){
 const work=path.join(temporary,'project-'+label),origin='http://127.0.0.1:'+number;write(path.join(work,'server.cjs'),SERVICE_SOURCE);write(path.join(work,'sentinel.txt'),'PRESERVE_'+label);
 const project=await ipc(main,'project.save',{groupId:group.id,name:'Owned UI '+label,connection:{kind:'local',rootPath:work,agentWorkPath:work,agentBinary:agentExecutable,agentEnabled:true,agentModel:'fixture-model',viewerUrl:origin,viewerWidth:1000,viewerHeight:700,viewerScale:'fit'}});
 assert.equal(project.connection.kind,'local');assert.equal(project.connection.agentBinary,agentExecutable);assert.equal(project.connection.agentWorkPath,work);
 const review=await ipc(main,'review.save',{projectId:project.id,title:'Owned '+label+' synthetic run',body:'Synthetic CLI / external AI0 / SSH0'});
 Object.assign(project,{work,origin,label,review,config:{executable:fs.realpathSync(process.execPath),entry:'server.cjs',args:[work,label,String(number),mode],readinessUrl:origin+'/health'}});projects.push(project);registerFixtureRoot(project);return project;
}
async function log(project,event){const file=path.join(project.work,'service-log.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(v=>!event||v.event===event):[];}
async function prepareRelatedAgentConnections(project){
 // Set up only A, before any Node configuration/start or agent execution.
 // Public service/project/review APIs retain the single-agent-per-service policy.
 const roles=['starter','inspect-1','inspect-2'],workRoots=roles.map((_,index)=>path.join(temporary,'agent-'+project.label+'-workspace-'+index));
 for(const work of workRoots){write(path.join(work,'sentinel.txt'),'PRIVATE_AGENT_WORKSPACE_'+project.label);assert.equal(path.dirname(work),temporary);assert.notEqual(work,project.work);}
 const adjusted=await ipc(main,'project.save',{id:project.id,connection:{...project.connection,agentWorkPath:workRoots[0]}});project.connection=adjusted.connection;
 const connections=[adjusted.connection];
 for(let index=1;index<3;index++)connections.push(await ipc(main,'service.save',{groupId:project.groupId,name:'Owned '+project.label+' inspector connection '+index,kind:'local',rootPath:project.work,agentWorkPath:workRoots[index],agentBinary:agentExecutable,agentEnabled:true,agentModel:'fixture-model',viewerUrl:project.origin,viewerWidth:1000,viewerHeight:700,viewerScale:'fit'}));
 const attached=await ipc(main,'project.save',{id:project.id,serviceIds:connections.map(value=>value.id)});
 // Store.project selects its actual first connection by ID. Do not assume the
 // initially created connection remains the managed Node primary after attach.
 project.connection=attached.connection;project.serviceIds=attached.serviceIds;
 assert.equal(project.serviceIds.length,3);assert.equal(new Set(project.serviceIds).size,3);assert.ok(connections.some(value=>value.id===project.connection.id));
 const ordered=[project.connection,...connections.filter(value=>value.id!==project.connection.id)];project.agentRoles=[];
 for(let index=0;index<roles.length;index++){
  const connection=ordered[index];assert.equal(connection.kind,'local');assert.equal(connection.rootPath,project.work);assert.equal(new URL(connection.viewerUrl).href,new URL(project.origin).href);assert.equal(connection.agentBinary,agentExecutable);assert.ok(workRoots.includes(connection.agentWorkPath));
  const review=await ipc(main,'review.save',{...(index===0?{id:project.review.id}:{}),projectId:project.id,serviceId:connection.id,title:'Owned '+project.label+' '+roles[index]+' synthetic observer',body:'Main-owned service observer; synthetic CLI / external AI0 / distinct connection and sibling work root'});
  if(index===0)project.review=review;
  project.agentRoles.push({role:roles[index],reviewId:review.id,serviceId:connection.id,workPath:connection.agentWorkPath,binary:connection.agentBinary});
 }
 const snapshot=await ipc(main,'snapshot'),saved=snapshot.projects.find(value=>value.id===project.id);assert.equal(saved.connection.id,project.connection.id);assert.deepEqual(saved.serviceIds.slice().sort(),project.serviceIds.slice().sort());
 assert.equal(new Set(project.agentRoles.map(value=>value.workPath)).size,3);
 for(const binding of project.agentRoles){const review=snapshot.reviews.find(value=>value.id===binding.reviewId),service=snapshot.services.find(value=>value.id===binding.serviceId);assert.equal(review.projectId,project.id);assert.equal(review.serviceId,service.id);assert.equal(service.agentWorkPath,binding.workPath);assert.equal(service.agentBinary,binding.binary);assert.equal(path.dirname(binding.workPath),temporary);}
 assert.equal(project.review.serviceId,project.connection.id);assert.equal((await runtime(project,main)).instance,null);assert.equal((await runtime(project,main)).config,null);
 record('related-agent-connections-prepared-before-Node-or-agent-start',{projectId:project.id,managedPrimaryConnectionId:project.connection.id,bindings:project.agentRoles,independentExecution:false,relatedTargetURL:project.origin,serverOwnershipAttestation:false});
}
async function agents(project,page,tag,ending){
 assert.equal(project.label,'A');assert.equal(project.agentRoles?.length,3);
 if(typeof assertSyntheticLaunchInputs==='function')assertSyntheticLaunchInputs();
 const snapshot=await ipc(page,'snapshot'),saved=snapshot.projects.find(value=>value.id===project.id);assert.equal(saved.connection.id,project.connection.id);
 for(const binding of project.agentRoles){const review=snapshot.reviews.find(value=>value.id===binding.reviewId),service=snapshot.services.find(value=>value.id===binding.serviceId);assert.equal(review.projectId,project.id);assert.equal(review.serviceId,binding.serviceId);assert.equal(service.agentBinary,agentExecutable);assert.equal(service.agentWorkPath,binding.workPath);assert.equal(path.dirname(binding.workPath),temporary);}
 const before=(await runtime(project,page)).instance;write(path.join(temporary,'agent-target.json'),JSON.stringify({url:project.origin,instanceId:before.instanceId}));const group=[];
 for(const binding of project.agentRoles){const key=tag+'-'+binding.role,job=await ipc(page,'agent.start',{reviewId:binding.reviewId,prompt:'OWNED_AGENT:'+key+' Synthetic observer of related target '+project.origin+'; service is main-owned, do not spawn it.',newConversation:true,independentExecution:false});group.push({...binding,key,id:job.id});jobs.push({id:job.id,projectId:project.id});}
 await until(async()=>{const rows=await Promise.all(group.map(value=>ipc(page,'agent.read',{id:value.id})));retainAgentReadSnapshot(result.agentReadDiagnostics,{tag,projectId:project.id,group,rows,at:new Date().toISOString()});save();return rows;},value=>value.every(row=>row.status==='running'),'three actual running jobs on distinct connections');await until(()=>group.every(value=>fs.existsSync(path.join(temporary,'agent-'+value.key+'.json'))),Boolean,'three real synthetic CLI records');
 for(const item of group){const observed=readJSON(path.join(temporary,'agent-'+item.key+'.json'));assert.equal(observed.argv[0],fs.realpathSync(process.execPath));assert.equal(observed.argv[1],expectedNativePath(fixture.agentScript,'agent-script'));assert.equal(observed.cwd,expectedNativePath(item.workPath,'agent-cwd'));}
 // Opt-in driver-only regression. Never passed into a product/app environment.
 if(process.env.REVIEWOPS_OWNED_EARLY_FAILURE_PROBE==='1'&&tag==='normal'&&ending==='normal'){
  assert.equal(process.platform,'win32');assert.equal(mode,'source');assert.equal(process.env.CI,'true');
  assert.equal(result.checks.length,1);assert.equal(result.agentRuns.length,0);assert.equal(jobs.length,3);
  const running=await Promise.all(group.map(value=>ipc(page,'agent.read',{id:value.id})));
  for(let index=0;index<group.length;index++){assert.equal(running[index].id,group[index].id);assert.equal(running[index].status,'running');assert.equal(running[index].reviewId,group[index].reviewId);assert.equal(running[index].serviceId,group[index].serviceId);}
  result.earlyCleanupProbe={schema:1,condition:'three-running-before-first-observe-v1',source:expectedHead,target,mode,tag,ending,
   phase:'after-three-CLI-argv-checks-before-first-observe',at:new Date().toISOString(),
   service:{projectId:project.id,connectionId:project.connection.id,instanceId:before.instanceId,pid:before.pid},
   projectBindings:projects.map(value=>({label:value.label,projectId:value.id,connectionId:value.connection.id})),
   jobs:group.map((value,index)=>({id:value.id,role:value.role,key:value.key,reviewId:value.reviewId,serviceId:value.serviceId,workPath:value.workPath,status:running[index].status,cli:readJSON(path.join(temporary,'agent-'+value.key+'.json'))}))};
  record('controlled-early-cleanup-failure',result.earlyCleanupProbe);
  throw new Error('OWNED_EARLY_CLEANUP_PROBE: three running agents before first observe');
 }
 const observe=async(phase,expectedRunning)=>{
  const runs=await Promise.all(group.map(value=>ipc(page,'agent.read',{id:value.id}))),summary=await ipc(page,'viewer.agentState',{projectId:project.id,connectionId:project.connection.id});assert.equal(summary.running,expectedRunning);
  for(let index=0;index<runs.length;index++){assert.equal(runs[index].reviewId,group[index].reviewId);assert.equal(runs[index].serviceId,group[index].serviceId);assert.equal(runs[index].workPath,group[index].workPath);}
  result.agentRuns.push({tag,phase,relatedProjectId:project.id,relatedTargetURL:project.origin,summary,runs,bindings:project.agentRoles,cli:group.map(value=>readJSON(path.join(temporary,'agent-'+value.key+'.json')))});
  const current=await flow(project,page,tag+' '+phase);assert.equal(current.instanceId,before.instanceId);assert.equal(current.pid,before.pid);save();
 };
 await observe('all-running',3);const first=group[0];
 if(ending==='cancel')await ipc(page,'agent.cancel',{id:first.id});else write(path.join(temporary,(ending==='failed'?'fail-':'finish-')+first.key),'fixture release');
 await until(()=>ipc(page,'agent.read',{id:first.id}),value=>value.status===(ending==='normal'?'completed':ending==='cancel'?'cancelled':'failed'),'actual starter terminal status');await observe('starter-ended',2);
 for(const item of group.slice(1))write(path.join(temporary,'finish-'+item.key),'normal completion');
 await until(()=>Promise.all(group.map(value=>ipc(page,'agent.read',{id:value.id}))),value=>value.every(row=>['completed','cancelled','failed'].includes(row.status)),'all related agents terminal');await observe('all-ended',0);await sleep(1500);await observe('all-ended-after-1500ms',0);if(process.platform==='win32'){for(const item of group){const observed=readJSON(path.join(temporary,'agent-'+item.key+'.json'));record('actual-native-CLI-tree-terminal',{jobId:item.id,key:item.key,...await verifyWindowsAgentExit(fixture,observed)});}}
 pass(ending==='normal'?'NEXT-015-002':'NEXT-015-003','actual-agent-'+ending,{instanceId:before.instanceId,pid:before.pid,projectId:project.id,relatedTargetURL:project.origin,bindings:project.agentRoles,summaryRunning:[3,2,0,0],mainOwnedServiceStartedByUI:true,starterOnlyObservesService:true,extraObservationMs:1500,manualDBAgentStatusWrites:0,independentExecution:false});
}
async function bindingDraftScenario(group){
 const labels=plan.bindingDraftUI,pd=await create(group,'D',await port()),oldRoot=pd.work,oldEntry=path.join(oldRoot,'alternate.cjs');
 write(oldEntry,SERVICE_SOURCE+'\n// original binding fixture\n');const oldEntryHash=fileSha(oldEntry);
 const dedicated=await open(pd);await configure(pd,dedicated);
 const draftEntry=owned(dedicated).getByLabel('프로젝트 안의 .cjs 진입 파일',{exact:true});await draftEntry.fill('alternate.cjs');
 await expect.poll(()=>dedicated.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('true');
 // One dedicated project window and the actual full-app main window show the
 // same project. The second trusted renderer changes only this own fixture.
 await main.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();
 await main.locator('.workspace-refresh').click();await main.getByRole('button',{name:pd.name+' 프로젝트 열기',exact:true}).click();await show(main);
 const newRoot=path.join(temporary,'project-D-current');write(path.join(newRoot,'server.cjs'),SERVICE_SOURCE);write(path.join(newRoot,'sentinel.txt'),'PRESERVE_D_CURRENT');
 const moved=await ipc(main,'project.save',{id:pd.id,connection:{...pd.connection,rootPath:newRoot,agentWorkPath:newRoot}});pd.connection=moved.connection;pd.work=newRoot;registerFixtureRoot(pd,newRoot);
 await expect(draftEntry).toHaveValue('alternate.cjs');await expect(owned(dedicated)).toContainText(oldRoot);
 await expect(owned(dedicated)).toContainText(labels.previousBindingText);
 await expect(owned(dedicated).getByRole('button',{name:'저장한 서비스 시작',exact:true})).toBeDisabled();
 await expect(owned(dedicated).getByRole('button',{name:'서비스 설정 저장',exact:true})).toBeDisabled();
 assert.equal((await runtime(pd,main)).config,null);assert.equal((await runtime(pd,main)).instance,null);
 await photo(dedicated,'06a-old-binding-draft-preserved');
 await owned(dedicated).getByRole('button',{name:labels.reviewCurrentConnection,exact:true}).click();
 const config={...pd.config,entry:'alternate.cjs',args:[newRoot,'D',new URL(pd.origin).port,'normal']};
 await owned(dedicated).getByLabel('실행 인수 (JSON 문자열 배열)',{exact:true}).fill(JSON.stringify(config.args));
 assert.equal(fs.existsSync(path.join(newRoot,'alternate.cjs')),false);
 await owned(dedicated).getByRole('button',{name:'서비스 설정 저장',exact:true}).click();
 await expect(owned(dedicated).getByRole('alert')).toContainText(labels.missingEntryText);
 await expect(owned(dedicated).getByRole('alert')).toContainText(path.join(expectedNativePath(newRoot,'missing-entry-parent'),'alternate.cjs'));
 assert.equal((await runtime(pd,main)).config,null);assert.equal((await runtime(pd,main)).instance,null);assert.equal(fs.existsSync(path.join(newRoot,'service-current.json')),false);
 write(path.join(newRoot,'alternate.cjs'),SERVICE_SOURCE+'\n// explicitly reviewed current binding fixture\n');pd.config=config;
 await owned(dedicated).getByRole('button',{name:'서비스 설정 저장',exact:true}).click();
 await expect(owned(dedicated).getByRole('button',{name:'저장한 서비스 시작',exact:true})).toBeEnabled();assert.deepEqual((await runtime(pd,dedicated)).config,config);
 await start(pd,dedicated);const instance=await flow(pd,dedicated,'explicitly reviewed current D root');
 assert.equal(instance.actual.cwd,expectedNativePath(newRoot,'rebound-owned-cwd'));assert.equal(instance.entrySnapshot.path,expectedNativePath(path.join(newRoot,'alternate.cjs'),'rebound-owned-entry'));
 assert.equal(instance.entrySnapshot.sha256,fileSha(path.join(newRoot,'alternate.cjs')));assert.notEqual(instance.entrySnapshot.sha256,oldEntryHash);assert.equal(fileSha(oldEntry),oldEntryHash);
 assert.equal(fs.readFileSync(path.join(oldRoot,'sentinel.txt'),'utf8'),'PRESERVE_D');assert.equal(fs.readFileSync(path.join(newRoot,'sentinel.txt'),'utf8'),'PRESERVE_D_CURRENT');
 await photo(dedicated,'06b-reviewed-current-root-executed',pd.origin);
 await owned(dedicated).getByRole('button',{name:'이 인스턴스 중지',exact:true}).click();await until(()=>runtime(pd,dedicated),s=>s.instance?.status==='exited','D current-root child stopped');await dedicated.close();
 pass('NEXT-015-007','two-trusted-windows-binding-draft-review',{oldRoot,newRoot,entry:'alternate.cjs',currentInstance:instance,oldEntryHash,newEntryHash:fileSha(path.join(newRoot,'alternate.cjs')),preReviewConfigureAndStartBlocked:true,currentRootMissingEntryRejected:true});
}

const RPC_SOURCE=String.raw`const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli synthetic-owned-service');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
if(args[0]!=='app-server')process.exit(77);
let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;if(pending.length>131072)process.exit(78);let index;while((index=pending.indexOf('\n'))>=0){const raw=pending.slice(0,index);pending=pending.slice(index+1);if(!raw.trim())continue;const m=JSON.parse(raw);if(m.id==null)continue;let result;if(m.method==='initialize')result={};else if(m.method==='config/read')result={config:{model:'fixture-model',model_reasoning_effort:'high'}};else if(m.method==='model/list')result={data:[{id:'fixture-model',model:'fixture-model',displayName:'Synthetic fixture',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null};else process.exit(79);console.log(JSON.stringify({id:m.id,result}));}});`;
const AGENT_SOURCE=String.raw`const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),base=FIXTURE_ROOT;
if(args[0]==='--version'){console.log('codex-cli synthetic-owned-service');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
if(args[0]==='app-server'){require(path.join(base,'model-rpc.cjs'));return}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>{input+=v;if(input.length>262144)process.exit(81)});
process.stdin.on('end',async()=>{
 const role=/OWNED_AGENT:([A-Za-z0-9-]+)/.exec(input)?.[1];if(!role)process.exit(82);
 const log=v=>fs.appendFileSync(path.join(base,'agent-log.jsonl'),JSON.stringify({at:new Date().toISOString(),role,pid:process.pid,...v})+'\n');
 fs.writeFileSync(path.join(base,'agent-'+role+'.json'),JSON.stringify({role,pid:process.pid,...(process.platform==='win32'?{launchNonce:process.env.REVIEWOPS_FIXTURE_LAUNCH_NONCE,ppid:process.ppid}:{}),argv:process.argv,cwd:process.cwd(),startedAt:new Date().toISOString()}));
 console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-'+role}));console.log(JSON.stringify({type:'turn.started'}));
 try{const target=JSON.parse(fs.readFileSync(path.join(base,'agent-target.json')));if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(target.url))throw new Error('Only own synthetic loopback target is allowed');const r=await fetch(target.url+'/health');log({event:'actual-health',status:r.status,body:await r.json(),expectedInstance:target.instanceId});}catch(error){log({event:'health-failed',message:error.message})}
 const timer=setInterval(()=>{if(fs.existsSync(path.join(base,'fail-'+role))){clearInterval(timer);log({event:'intentional-failure'});console.error('Synthetic agent failure; external AI0');process.exit(17)}if(fs.existsSync(path.join(base,'finish-'+role))){clearInterval(timer);log({event:'normal-completion'});console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic local run completed; external AI0'}}));console.log(JSON.stringify({type:'turn.completed'}));process.exit(0)}},30);
 process.on('SIGTERM',()=>{log({event:'actual-product-cancel-SIGTERM'});process.exit(143)});
});`;
const SERVICE_SOURCE=String.raw`'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const [root,label,portText,mode='normal']=process.argv.slice(2),port=Number(portText),statePath=path.join(root,'stored-state.json'),nonce=crypto.randomUUID();
const log=v=>fs.appendFileSync(path.join(root,'service-log.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,label,nonce,...v})+'\n');
process.on('exit',code=>log({event:'actual-process-exit',code}));
let count=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath)).count:0,maintenance;const writes=new Set();
const track=p=>{writes.add(p);p.then(()=>writes.delete(p),error=>{writes.delete(p);log({event:'write-error',message:error.message})});return p};
const persist=async()=>{const s={count,pid:process.pid,label,nonce};await fsp.writeFile(statePath,JSON.stringify(s));log({event:'write-completed',count});return s};
const waitFile=file=>new Promise(resolve=>{const t=setInterval(()=>{if(fs.existsSync(file)){clearInterval(t);resolve()}},30)});
const html='<!doctype html><title>Owned synthetic '+label+'</title><style>body{font:22px sans-serif;padding:25px;background:#eaf4fa}button{font:inherit;padding:12px;margin:8px}output{display:block}</style><h1>Owned synthetic '+label+'</h1><p>Private fixture / external AI0 / SSH0</p><button id="increment">저장값 증가</button><button id="slow">진행 요청 저장</button><button id="after">응답 후 쓰기</button><button id="hold">종료 보류 요청</button><button id="fault">소유 서비스 고장</button><output id="result">대기</output><script>for(const [id,route]of Object.entries({increment:"increment",slow:"slow",after:"after",hold:"hold",fault:"fault"}))document.getElementById(id).onclick=async()=>{try{const r=await fetch("/"+route,{method:"POST"}),s=await r.json();document.getElementById("result").textContent=JSON.stringify(s)}catch(e){document.getElementById("result").textContent="요청 실패"}}</script>';
const server=http.createServer((req,res)=>{log({event:'request',method:req.method,url:req.url});
 if(req.url==='/health'){res.end(JSON.stringify({ready:true,pid:process.pid,label,nonce}));return}
 if(req.url==='/slow-health'){setTimeout(()=>res.end(JSON.stringify({ready:true,pid:process.pid,label,nonce})),700);return}
 if(req.url==='/state'){res.end(fs.existsSync(statePath)?fs.readFileSync(statePath):JSON.stringify({count,pid:process.pid,label,nonce}));return}
 if(req.method==='POST'&&['/increment','/slow','/hold'].includes(req.url)){const route=req.url;track((async()=>{if(route==='/slow'){log({event:'mid-post-pending'});await new Promise(r=>setTimeout(r,900))}if(route==='/hold'){log({event:'hold-pending'});await waitFile(path.join(root,'release-hold'))}count++;const s=await persist();res.end(JSON.stringify(s));log({event:'response-finished',route,count})})());return}
 if(req.method==='POST'&&req.url==='/after'){count++;track((async()=>{log({event:'after-response-write-pending'});await new Promise(r=>setTimeout(r,900));await persist()})());res.end(JSON.stringify({accepted:true,targetCount:count,pid:process.pid}));return}
 if(req.method==='POST'&&req.url==='/fault'){log({event:'intentional-service-failure'});res.end(JSON.stringify({fault:true,pid:process.pid}));setTimeout(()=>process.exit(17),50);return}
 res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(html);
});
// Fixture-only opt-in: resolved by the driver while this source string is built.
// Product runtime env/protocol/timeouts and close behavior remain unchanged.
const shutdownDiagnosticsEnabled=${JSON.stringify(process.env.REVIEWOPS_OWNED_SHUTDOWN_DIAGNOSTICS==='1')};
let shutdownObservationCount=0,shutdownSocketSnapshot;
const shutdownLog=value=>{if(!shutdownDiagnosticsEnabled||shutdownObservationCount>=24)return;shutdownObservationCount++;try{log({event:'shutdown-observation',...value})}catch{}};
const observeShutdown=(phase,withConnections=false)=>{
 if(!shutdownDiagnosticsEnabled||shutdownObservationCount>=24)return;
 try{
  const available=typeof process.getActiveResourcesInfo==='function',types=available?process.getActiveResourcesInfo().slice(0,128):[],resources={};
  for(const type of types)resources[type]=(resources[type]||0)+1;
  shutdownLog({phase,listening:server.listening,address:server.address(),pendingWrites:writes.size,ipcConnected:process.connected===true,resourceAPIAvailable:available,resources,...(shutdownSocketSnapshot?shutdownSocketSnapshot():{})});
  if(withConnections)server.getConnections((error,count)=>{try{shutdownLog({phase:phase+'-connection-count',count:Number.isInteger(count)?count:null,errorCode:error?String(error.code||'unknown').slice(0,80):null})}catch{}});
 }catch(error){try{shutdownLog({phase,observationErrorCode:String(error.code||error.name||'unknown').slice(0,80)})}catch{}}
};
if(shutdownDiagnosticsEnabled){
 // Public-event metadata only. The map exists only in this opt-in fixture path;
 // no payload reads, data/error/timeout listeners, socket actions, or new timers.
 const liveSockets=new Map();let acceptedSockets=0,closedTrackedSockets=0,untrackedAcceptedSockets=0,untrackedRequestEvents=0,socketObserverErrors=0;
 const publicSocket=(socket,row)=>({id:row.id,acceptedAt:row.acceptedAt,requestEvents:row.requestEvents,activeRequests:row.activeRequests,responseFinishes:row.responseFinishes,responseCloses:row.responseCloses,closedBeforeFinish:row.closedBeforeFinish,
  bytesRead:Number.isSafeInteger(socket.bytesRead)?socket.bytesRead:null,bytesWritten:Number.isSafeInteger(socket.bytesWritten)?socket.bytesWritten:null,
  readyState:typeof socket.readyState==='string'?socket.readyState.slice(0,32):null,readableEnded:typeof socket.readableEnded==='boolean'?socket.readableEnded:null,writableEnded:typeof socket.writableEnded==='boolean'?socket.writableEnded:null,destroyed:typeof socket.destroyed==='boolean'?socket.destroyed:null});
 shutdownSocketSnapshot=()=>{
  const sockets=[];let omittedTrackedSockets=0;
  for(const [socket,row]of liveSockets){if(sockets.length>=8){omittedTrackedSockets++;continue;}try{sockets.push(publicSocket(socket,row));}catch{socketObserverErrors++;}}
  return {socketObservation:{schema:1,trackingLimit:64,snapshotLimit:8,acceptedSockets,liveTrackedSockets:liveSockets.size,closedTrackedSockets,untrackedAcceptedSockets,untrackedRequestEvents,omittedTrackedSockets,socketObserverErrors,trackingComplete:untrackedAcceptedSockets===0&&untrackedRequestEvents===0&&socketObserverErrors===0,listedAllTrackedSockets:omittedTrackedSockets===0&&socketObserverErrors===0,sockets}};
 };
 server.on('connection',socket=>{
  try{
   const id=++acceptedSockets;if(liveSockets.size>=64){untrackedAcceptedSockets++;return;}
   const row={id,acceptedAt:new Date().toISOString(),requestEvents:0,activeRequests:0,responseFinishes:0,responseCloses:0,closedBeforeFinish:0};liveSockets.set(socket,row);
   socket.once('close',()=>{try{if(liveSockets.get(socket)===row){liveSockets.delete(socket);closedTrackedSockets++;}}catch{socketObserverErrors++;}});
  }catch{socketObserverErrors++;}
 });
 // Observe actual response events before the entry handler can call res.end().
 // Bootstrap-rejected draining requests may not emit the entry request event;
 // requestEvents is not a claim about every HTTP message seen by the parser.
 server.prependListener('request',(request,response)=>{
  try{
   const row=liveSockets.get(request.socket);if(!row){untrackedRequestEvents++;return;}row.requestEvents++;row.activeRequests++;let settled=false;
   const settledOnce=kind=>{try{if(kind==='finish')row.responseFinishes++;else row.responseCloses++;if(!settled){settled=true;row.activeRequests--;if(kind==='close')row.closedBeforeFinish++;}}catch{socketObserverErrors++;}};
   response.once('finish',()=>settledOnce('finish'));response.once('close',()=>settledOnce('close'));
  }catch{socketObserverErrors++;}
 });
 server.once('close',()=>observeShutdown('server-close-event'));
 server.on('error',error=>{try{shutdownLog({phase:'server-error-event',errorCode:String(error.code||'unknown').slice(0,80)})}catch{}});
 // Synchronous observation only: never start async work from beforeExit.
 process.once('beforeExit',code=>{shutdownLog({phase:'before-exit',code});observeShutdown('before-exit-resources')});
}
server.on('error',error=>{console.error('SYNTHETIC_LISTEN_ERROR '+error.code);log({event:'listen-error',code:error.code});if(mode==='external-port'&&error.code==='EADDRINUSE')maintenance=setInterval(()=>{},1000);else throw error});
server.listen(port,'127.0.0.1',()=>{const s={pid:process.pid,argv:process.argv,executable:process.execPath,cwd:process.cwd(),entry:fs.realpathSync(__filename),entrySHA256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),startedAt:new Date().toISOString(),url:'http://127.0.0.1:'+server.address().port,label,nonce};fs.writeFileSync(path.join(root,'service-current.json'),JSON.stringify(s));log({event:'listening',...s})});
module.exports.reviewopsShutdown=async({reason})=>{log({event:'cleanup-start',reason,pendingWrites:writes.size});clearInterval(maintenance);await Promise.all([...writes]);await fsp.writeFile(path.join(root,'cleanup-marker.json'),JSON.stringify({pid:process.pid,label,count,pendingWrites:writes.size,reason}));log({event:'cleanup-completed',count});
 if(shutdownDiagnosticsEnabled){
  observeShutdown('entry-hook-completed',true);
  for(const delay of [100,1500]){const timer=setTimeout(()=>observeShutdown('entry-hook-plus-'+delay+'ms',true),delay);timer.unref();}
 }
};`;

// These checks run only after the explicit preflight above. No fixture process
// is spawned by importing this prepared file without --run.
try{
 fixture=await prepareNativeAgentFixture({packet,agentSource:AGENT_SOURCE,rpcSource:RPC_SOURCE});assert.equal(fixture.agentExecutable,agentExecutable);
 ({app,page:main}=await launch());
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('reviewops://app/')).setContentSize(1600,1100));
 const group=await ipc(main,'group.save',{name:'Private managed-service UI fixtures'}),pa=await create(group,'A',await port()),pb=await create(group,'B',await port());
 await prepareRelatedAgentConnections(pa);
 a=await open(pa);b=await open(pb);
 await configure(pa,a);await start(pa,a);await configure(pb,b);await start(pb,b);
 const initialA=await flow(pa,a,'initial A'),initialB=await flow(pb,b,'initial B');
 assert.equal(initialA.entrySnapshot.sha256,fileSha(path.join(pa.work,'server.cjs')));
 for(const value of [initialA.instanceId,String(initialA.pid),initialA.actual.executable,initialA.entrySnapshot.sha256,String(initialA.listeners[0].port)])await expect(owned(a)).toContainText(value);
 await photo(a,'01-UI-start-execution-record',pa.origin);
 const entrySHA=owned(a).locator('code').filter({hasText:'SHA-256: '+initialA.entrySnapshot.sha256});await expect(entrySHA).toHaveCount(1);await expect(entrySHA).toHaveText('SHA-256: '+initialA.entrySnapshot.sha256);await entrySHA.scrollIntoViewIfNeeded();await expect(entrySHA).toBeInViewport();
 await photo(a,'01b-execution-file-hash',pa.origin);record('same-NEXT001-hash-photo',{entrySHA256:initialA.entrySnapshot.sha256,actualRowScrolledIntoView:true,originalWholeHostAndNativePair:true,newScenarioCount:0});

 pass('NEXT-015-001','UI-save-start-provenance-and-core',{instance:initialA,server:readJSON(path.join(pa.work,'service-current.json')),getAndPostReal:true});
 await agents(pa,a,'normal','normal');await photo(a,'02-all-related-agents-ended',pa.origin);
 await agents(pa,a,'cancel','cancel');await agents(pa,a,'failure','failed');
 // Fault only this owned synthetic process through its own actual native button.
 await nativeClick(a,pa.origin,'fault');
 const faulted=await until(()=>runtime(pa,a),s=>s.instance?.status==='exited','intentional own-service fault exit');assert.equal(faulted.instance.exit.code,17);assert.ok((await log(pa,'intentional-service-failure')).length);
 await owned(a).getByRole('button',{name:'저장한 준비 URL 검사',exact:true}).click();await expect(owned(a)).toContainText('연결 실패');
 const retainedDOM=await nativeRead(a,pa.origin,'document.title');await photo(a,'03-failed-service-previous-DOM',pa.origin);
 const recovered=await restart(pa,a);await flow(pa,a,'selected A recovery');
 assert.equal((await runtime(pb,b)).instance.instanceId,initialB.instanceId);assert.equal((await runtime(pb,b)).instance.pid,initialB.pid);assert.equal(fs.readFileSync(path.join(pb.work,'sentinel.txt'),'utf8'),'PRESERVE_B');
 assert.equal((await actualJSON(pb.origin+'/health')).pid,initialB.pid);assert.deepEqual(await actualJSON(pb.origin+'/state'),readJSON(path.join(pb.work,'stored-state.json')));
 await photo(a,'04-A-restarted-B-preserved',pa.origin);
 pass('NEXT-015-004','actual-fault-selected-recovery',{retainedDOM,recovered,preservedB:await runtime(pb,b)});
 // Actual private integration/QA route and real renderer IPC, no fake snapshots.
 qaHandle=await invokeSocket(path.join(data,'integrations/tools.json'),'automation.qa.open',{projectId:pa.id,clientId:'owned-ui-'+crypto.randomUUID()});
 await expect(a.locator('.workspace-app')).toHaveAttribute('data-qa-project-id',pa.id);
 const connectionLeaseObservation=await observeConnectionInfo(app,a,'held-existing-QA-lease',qaHandle);await expect(a.locator('.workspace-app')).toHaveAttribute('data-qa-project-id',pa.id);
 await ipc(a,'serviceRuntime.state',{projectId:pa.id,connectionId:pa.connection.id});
 for(const action of ['serviceRuntime.state','serviceRuntime.start','serviceRuntime.stop','serviceRuntime.restart'])await denied(a,action,{projectId:pb.id,connectionId:pb.connection.id,...(['serviceRuntime.stop','serviceRuntime.restart'].includes(action)?{instanceId:initialB.instanceId}:{})},'TARGET_MISMATCH');
 await denied(a,'serviceRuntime.configure',{projectId:pa.id,connectionId:pa.connection.id,config:pa.config},'TARGET_MISMATCH');
 await denied(a,'serviceRuntime.stop',{projectId:pa.id,connectionId:pa.connection.id,instanceId:initialB.instanceId},'TARGET_MISMATCH');
 await denied(a,'serviceRuntime.state',{projectId:pa.id,connectionId:pb.connection.id},'TARGET_MISMATCH');
 await denied(a,'group.save',{id:group.id,name:'Forbidden global mutation'},'TARGET_MISMATCH');
 await assert.rejects(invokeSocket(path.join(data,'integrations/tools.json'),'serviceRuntime.start',{projectId:pa.id,connectionId:pa.connection.id}));
 assert.equal(await nativeRead(a,pa.origin,'typeof window.reviewops'),'undefined');
 assert.equal((await runtime(pb,b)).instance.instanceId,initialB.instanceId);
 await invokeSocket(path.join(data,'integrations/tools.json'),'automation.qa.release',qaHandle);connectionLeaseObservation.originalLeaseReleaseConfirmed=true;save();qaHandle=null;
 pass('NEXT-015-005','actual-consumer-and-foreign-control-denied',{foreignBPreserved:true,PIDReuse:'not-run separately required',harnessPIDSignals:0});
 // Stop during an accepted request and, separately, after a response while its
 // actual asynchronous fs write remains pending. Product deadlines are unchanged.
 let before=await runtime(pa,a);const midPostCount=(await actualJSON(pa.origin+'/state')).count;await nativeClick(a,pa.origin,'slow');
 await until(()=>log(pa,'mid-post-pending'),v=>v.length>0,'accepted pending POST');
 await owned(a).getByRole('button',{name:'이 인스턴스 중지',exact:true}).click();
 await until(()=>runtime(pa,a),s=>s.instance?.status==='exited','midPOST cooperative natural exit');
 let marker=readJSON(path.join(pa.work,'cleanup-marker.json')),stored=readJSON(path.join(pa.work,'stored-state.json'));
 assert.equal(marker.pid,before.instance.pid);assert.equal(marker.count,stored.count);assert.equal(stored.count,midPostCount+1);assert.ok((await log(pa,'response-finished')).some(v=>v.route==='/slow'&&v.count===stored.count));assert.equal((await runtime(pa,a)).instance.exit.drainConfirmed,true);
 await start(pa,a);before=await runtime(pa,a);await nativeClick(a,pa.origin,'after');
 await until(()=>log(pa,'after-response-write-pending'),v=>v.length>0,'response-sent asynchronous write remains');
 await expect.poll(()=>nativeRead(a,pa.origin,'(()=>{try{return JSON.parse(document.getElementById("result").textContent).accepted}catch{return false}})()')).toBe(true);
 const accepted=await nativeRead(a,pa.origin,'JSON.parse(document.getElementById("result").textContent)');assert.ok(readJSON(path.join(pa.work,'stored-state.json')).count<accepted.targetCount,'Actual async write must still be pending after its response arrived');
 await owned(a).getByRole('button',{name:'이 인스턴스 중지',exact:true}).click();
 await until(()=>runtime(pa,a),s=>s.instance?.status==='exited','post-response write natural exit');
 marker=readJSON(path.join(pa.work,'cleanup-marker.json'));stored=readJSON(path.join(pa.work,'stored-state.json'));assert.equal(marker.pid,before.instance.pid);assert.equal(marker.count,stored.count);assert.equal(stored.count,accepted.targetCount);assert.equal(marker.pendingWrites,0);
 pass('NEXT-015-008','midPOST-and-post-response-write-drain',{marker,stored,forcedExitOrSignal:false});
 await start(pa,a);await nativeClick(a,pa.origin,'hold');
 await until(()=>log(pa,'hold-pending'),v=>v.length>0,'held accepted POST');await owned(a).getByRole('button',{name:'이 인스턴스 중지',exact:true}).click();
 before=await until(()=>runtime(pa,a),s=>s.instance?.status==='stop-unconfirmed','original product timeout');
 await expect(owned(a)).toContainText('중지 확인 필요');await photo(a,'05-stop-unconfirmed-retained',pa.origin);
 await denied(a,'serviceRuntime.start',{projectId:pa.id,connectionId:pa.connection.id},'SERVICE_BUSY');
 await denied(a,'serviceRuntime.configure',{projectId:pa.id,connectionId:pa.connection.id,config:pa.config},'SERVICE_BUSY');
 await denied(a,'serviceRuntime.restart',{projectId:pa.id,connectionId:pa.connection.id,instanceId:before.instance.instanceId},'SERVICE_STOP_UNCONFIRMED');
 const quitErrors=(await app.evaluate(()=>global.__ownedDialogs.errors)).length;
 await app.evaluate(({app})=>{setImmediate(()=>app.quit())});
 await until(()=>app.evaluate(()=>global.__ownedDialogs.errors),v=>v.length>quitErrors,'unconfirmed owned drain cancels actual app quit');
 assert.equal(a.isClosed(),false);assert.equal((await runtime(pa,a)).instance.status,'stop-unconfirmed');
 record('actual-app-quit-blocked-on-drain',{error:await app.evaluate(()=>global.__ownedDialogs.errors.at(-1)),nativeErrorDialogFixture:true});
 write(path.join(pa.work,'release-hold'),'Release only this owned synthetic request');
 await until(()=>runtime(pa,a),s=>s.instance?.status==='exited'&&s.instance.exit.drainConfirmed,'late marker and natural exit');await start(pa,a);
 // A failed global quit may have already drained another owned service. Record
 // that result explicitly, then restart B via UI; it is not claimed untouched.
 const bAfterBlockedQuit=await runtime(pb,b);record('B-after-blocked-global-quit',{state:bAfterBlockedQuit});
 if(bAfterBlockedQuit.instance?.status==='exited')await start(pb,b);
 pass('NEXT-015-008','stop-unconfirmed-blocks-then-late-drain-confirms',{forcedSignal:false,instance:await runtime(pa,a)});
 const entrySnapshot=(await runtime(pa,a)).instance.entrySnapshot;
 fs.appendFileSync(path.join(pa.work,'server.cjs'),'\n// Synthetic postlaunch file rewrite only\n');assert.notEqual(fileSha(path.join(pa.work,'server.cjs')),entrySnapshot.sha256);
 await panel(a).getByLabel('비교 파일 (선택)',{exact:true}).fill('server.cjs');await panel(a).getByRole('button',{name:'지금 검사',exact:true}).click();await expect(panel(a)).toContainText(fileSha(path.join(pa.work,'server.cjs')));
 assert.equal((await runtime(pa,a)).instance.entrySnapshot.sha256,entrySnapshot.sha256);assert.equal((await runtime(pa,a)).instance.entrySnapshot.loadedBytesVerified,false);
 pass('NEXT-015-006','postlaunch-bytes-not-loaded-attestation',{prelaunchSHA:entrySnapshot.sha256,currentSHA:fileSha(path.join(pa.work,'server.cjs')),urlOwnership:'unverified'});
 const delayed=pa.origin+'/slow-health';await panel(a).getByLabel('준비 상태 URL',{exact:true}).fill(delayed);await panel(a).getByRole('button',{name:'지금 검사',exact:true}).click();
 await until(()=>log(pa),v=>v.some(x=>x.url==='/slow-health'),'actual delayed readiness GET');
 await panel(a).getByLabel('준비 상태 URL',{exact:true}).fill(pb.origin+'/health');await panel(a).getByLabel('준비 상태 URL',{exact:true}).fill(delayed);await sleep(850);
 await expect(panel(a).locator('.service-readiness-results>div').filter({has:a.locator('dt',{hasText:/^HTTP 상태$/})}).locator('dd')).toHaveText('미검사');
 const sameInstance=(await runtime(pa,a)).instance.instanceId;await a.close();a=await open(pa);await show(a);assert.equal((await runtime(pa,a)).instance.instanceId,sameInstance);await readyPage(pa,a);await flow(pa,a,'view reopened');
 await denied(a,'project.delete',{id:pa.id},'SERVICE_BUSY');await denied(a,'project.save',{id:pa.id,connection:{...pa.connection,rootPath:pb.work}},'SERVICE_BUSY');
 pass('NEXT-015-007','view-reopen-and-A-B-A-readiness',{sameInstance,lateHTTPDiscarded:true,activeProjectMutationDenied:true});
 // Independent loopback server owned by the harness, not by runtime C.
 externalServer=http.createServer((_req,res)=>res.end(JSON.stringify({external:true,sentinel:'PRESERVE_EXTERNAL'})));
 await new Promise(r=>externalServer.listen(0,'127.0.0.1',r));const pc=await create(group,'C',externalServer.address().port,'external-port'),c=await open(pc);
 await configure(pc,c);await owned(c).getByRole('button',{name:'저장한 서비스 시작',exact:true}).click();
 await until(()=>runtime(pc,c),s=>s.instance?.status==='running'&&s.instance.logTail.includes('EADDRINUSE'),'own failed bind next to external200');
 await owned(c).getByRole('button',{name:'저장한 준비 URL 검사',exact:true}).click();await expect(owned(c)).toContainText('HTTP 응답 확인');
 assert.deepEqual((await runtime(pc,c)).instance.listeners,[]);assert.equal((await runtime(pc,c)).instance.urlOwnership,'unverified');
 await owned(c).getByRole('button',{name:'이 인스턴스 중지',exact:true}).click();await until(()=>runtime(pc,c),s=>s.instance?.status==='exited','stop only owned C');
 assert.deepEqual(await actualJSON(pc.origin+'/health'),{external:true,sentinel:'PRESERVE_EXTERNAL'});await photo(c,'06-external200-unverified');await c.close();
 pass('NEXT-015-005','external200-never-own-URL-proof',{externalPreserved:true});
 await bindingDraftScenario(group);
 // D regression: the actual managed-service form participates in the app's
 // unsaved-input policy. No dataset or database dirty flag is injected.
 const bBeforeUnsaved=(await runtime(pb,b)).instance;
 await owned(a).getByRole('button',{name:'이 인스턴스 중지',exact:true}).click();
 await until(()=>runtime(pa,a),s=>s.instance?.status==='exited','stop A before editing managed form');
 const unsavedURL=pa.config.readinessUrl+'?unsaved-owned=true',ownedURL=owned(a).getByLabel('관리형 서비스 준비 URL',{exact:true});
 await ownedURL.fill(unsavedURL);await expect.poll(()=>a.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('true');
 assert.equal((await runtime(pa,a)).config.readinessUrl,pa.config.readinessUrl,'Draft must not silently configure runtime');
 let unsavedDialogCount=(await app.evaluate(()=>global.__ownedDialogs.calls)).length;
 const ownedFormWindow=await app.browserWindow(a);await ownedFormWindow.evaluate(win=>win.close());
 await until(()=>app.evaluate(()=>global.__ownedDialogs.calls),v=>v.length>unsavedDialogCount,'managed form real beforeunload cancellation');
 assert.equal(a.isClosed(),false);await expect(ownedURL).toHaveValue(unsavedURL);
 unsavedDialogCount=(await app.evaluate(()=>global.__ownedDialogs.calls)).length;
 await app.evaluate(({app})=>{global.__ownedDialogs.answer=0;setImmediate(()=>app.quit())});
 await until(()=>app.evaluate(()=>global.__ownedDialogs.calls),v=>v.length>unsavedDialogCount,'managed form app-quit cancellation');
 assert.equal(a.isClosed(),false);await expect(ownedURL).toHaveValue(unsavedURL);
 const afterManagedQuit=await afterCancelledQuit(pb,b,a);b=afterManagedQuit.page;assert.equal(afterManagedQuit.state.instance.instanceId,bBeforeUnsaved.instanceId);
 assert.equal((await runtime(pa,a)).instance.status,'exited');
 const firstCancelServiceStates={A:(await runtime(pa,a)).instance,B:afterManagedQuit.state.instance};
 await photo(a,'07a-managed-form-unsaved-preserved');
 pass('NEXT-015-008','actual-managed-form-unsaved-close-and-quit',{unsavedURL,savedURL:(await runtime(pa,a)).config.readinessUrl,servicesAfterCancel:firstCancelServiceStates,manualDirtyFlagWrites:0,nativeDialogChoiceFixture:true});
 await configure(pa,a);await expect.poll(()=>a.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('false');await start(pa,a);await show(b);await start(pb,b);record('explicit-UI-restart-after-cancelled-quit',{projects:[pa.id,pb.id],automaticRestart:false});
 // Actual UI dirtiness + real Electron beforeunload cancellation and app quit.
 await a.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();await a.getByRole('button',{name:pa.name+' 리뷰 작성',exact:true}).click();
 const form=a.locator('.original-review-form.is-create:visible');await form.getByLabel('제목',{exact:true}).fill('Synthetic unsaved quit cancellation');await form.locator('textarea[name="reviewBody"]').fill('Private draft must survive cancelled quit.');
 await expect.poll(()=>a.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('true');
 const cancelledInstance=(await runtime(pa,a)).instance.instanceId;
 let beforeUnloadEvents=0;a.on('console',message=>{if(message.text()==='OWNED_UI_BEFOREUNLOAD'){beforeUnloadEvents++;record('actual-DOM-beforeunload-observed')}});
 await a.evaluate(()=>window.addEventListener('beforeunload',()=>console.info('OWNED_UI_BEFOREUNLOAD')));
 const individualCloseCalls=(await app.evaluate(()=>global.__ownedDialogs.calls)).length;
 const handle=await app.browserWindow(a);await handle.evaluate(win=>win.close());
 await until(()=>app.evaluate(()=>global.__ownedDialogs.calls),v=>v.length>individualCloseCalls,'actual individual window beforeunload veto');
 await until(()=>beforeUnloadEvents,count=>count>0,'actual beforeunload console observation delivered');
 assert.equal(a.isClosed(),false);assert.ok(beforeUnloadEvents>0);assert.equal((await runtime(pa,a)).instance.instanceId,cancelledInstance);
 const prior=(await app.evaluate(()=>global.__ownedDialogs.calls)).length;
 await app.evaluate(({app})=>{global.__ownedDialogs.answer=0;setImmediate(()=>app.quit())});
 await until(()=>app.evaluate(()=>global.__ownedDialogs.calls),v=>v.length>prior,'actual app quit cancelled');
 assert.equal(a.isClosed(),false);const afterReviewQuitA=(await runtime(pa,a)).instance;assert.equal(afterReviewQuitA.instanceId,cancelledInstance);assert.equal(afterReviewQuitA.status,'exited');assert.equal(afterReviewQuitA.exit.drainConfirmed,true);
 await expect(form.getByLabel('제목',{exact:true})).toHaveValue('Synthetic unsaved quit cancellation');
 const afterReviewQuitB=await afterCancelledQuit(pb,b,a);b=afterReviewQuitB.page;
 record('actual-review-quit-cancel-preserves-draft-not-running-services',{A:afterReviewQuitA,B:afterReviewQuitB.state.instance,automaticRestart:false});
 await photo(a,'07-quit-cancelled-draft-preserved');
 // D regression: preflight sees a clean actual review form, then a real
 // accepted service request keeps close() pending while the user enters text.
 await form.getByLabel('제목',{exact:true}).fill('');await form.locator('textarea[name="reviewBody"]').fill('');
 await expect.poll(()=>a.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('false');
 // Restart through the real saved-runtime API while the actual review form
 // stays visible. UI start was checked above; this is explicitly an API start.
 await ipc(a,'serviceRuntime.start',{projectId:pa.id,connectionId:pa.connection.id});
 const lateStarted=await until(()=>runtime(pa,a),s=>s.instance?.status==='running'&&s.instance.listeners.length>0,'explicit saved-runtime API restart before late-input case');
 record('explicit-API-restart-after-review-quit-cancel',{projectId:pa.id,instance:lateStarted.instance,automaticRestart:false});
 const lateBefore=lateStarted.instance,lateLogCount=(await log(pa,'hold-pending')).length;
 const heldFile=path.join(pa.work,'release-hold');assert.ok(inside(heldFile));fs.rmSync(heldFile,{force:true});
 const lateRequest=fetch(pa.origin+'/hold',{method:'POST',signal:AbortSignal.timeout(10000)}).then(async response=>{assert.equal(response.status,200);return response.json()});lateRequest.catch(()=>{});
 await until(()=>log(pa,'hold-pending'),v=>v.length>lateLogCount&&v.at(-1).pid===lateBefore.pid,'new real accepted request holds service drain');
 const latePromptCount=(await app.evaluate(()=>global.__ownedDialogs.calls)).length,lateErrorCount=(await app.evaluate(()=>global.__ownedDialogs.errors)).length;
 record('late-edit-clean-preflight',{instanceId:lateBefore.instanceId,pid:lateBefore.pid,request:'real loopback POST, no response injection'});
 await app.evaluate(({app})=>{global.__ownedDialogs.answer=0;setImmediate(()=>app.quit())});
 await until(()=>runtime(pa,a),s=>s.instance?.status==='stopping','actual app quit awaiting owned service drain');
 const lateTitle='Late UI input while service drain waits',lateBody='Accepted after quit preflight; a new consent must protect this text.';
 await form.getByLabel('제목',{exact:true}).fill(lateTitle);await form.locator('textarea[name="reviewBody"]').fill(lateBody);
 await expect.poll(()=>a.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('true');record('late-edit-actual-UI-accepted',{lateTitle,lateBody});
 write(heldFile,'Release only the new pending synthetic request');const lateStored=await lateRequest;
 const lateStopped=await until(()=>runtime(pa,a),s=>s.instance?.status==='exited'&&s.instance.exit.drainConfirmed,'late-edit case drain truly confirmed');
 assert.equal(lateStored.pid,lateBefore.pid);assert.equal(lateStopped.instance.pid,lateBefore.pid);
 await until(()=>app.evaluate(()=>global.__ownedDialogs.calls),v=>v.length>latePromptCount,'fresh consent for input accepted after preflight');
 assert.equal((await app.evaluate(()=>global.__ownedDialogs.errors)).length,lateErrorCount,'A stop timeout/error must not masquerade as late-input protection');
 assert.equal(a.isClosed(),false);await expect(form.getByLabel('제목',{exact:true})).toHaveValue(lateTitle);await expect(form.locator('textarea[name="reviewBody"]')).toHaveValue(lateBody);
 await photo(a,'08-late-input-preserved-after-confirmed-drain');
 pass('NEXT-015-008','actual-late-input-during-service-drain-protected',{lateTitle,lateBody,lateStored,drainConfirmed:true,newConsentAnswer:0,manualDirtyFlagWrites:0,nativeDialogChoiceFixture:true});
 // Separate approved late-input attempt: one real synchronous confirmation
 // fixture lasts11s. The product's10s incomplete-close watchdog is untouched.
 await form.getByLabel('제목',{exact:true}).fill('');await form.locator('textarea[name="reviewBody"]').fill('');
 await expect.poll(()=>a.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('false');
 await ipc(a,'serviceRuntime.start',{projectId:pa.id,connectionId:pa.connection.id});
 const delayedOwned=await until(()=>runtime(pa,a),s=>s.instance?.status==='running'&&s.instance.listeners.length>0,'saved owned service for delayed final consent');
 const delayedMeta=readJSON(path.join(pa.work,'service-current.json')),delayedHoldCount=(await log(pa,'hold-pending')).length;
 assert.ok(inside(heldFile));fs.rmSync(heldFile,{force:true});
 const delayedRequest=fetch(pa.origin+'/hold',{method:'POST',signal:AbortSignal.timeout(10000)}).then(async response=>{assert.equal(response.status,200);return response.json()});delayedRequest.catch(()=>{});
 await until(()=>log(pa,'hold-pending'),v=>v.length>delayedHoldCount&&v.at(-1).nonce===delayedMeta.nonce,'new exact owned POST for11s approval case');
 await app.evaluate(({app})=>{global.__ownedDialogs.answer=0;setImmediate(()=>app.quit())});
 await until(()=>runtime(pa,a),s=>s.instance?.status==='stopping','approved-delay case awaiting real service drain');
 const delayedTitle='Late draft approved after11s controlled confirmation';
 await form.getByLabel('제목',{exact:true}).fill(delayedTitle);await form.locator('textarea[name="reviewBody"]').fill('New input accepted after clean preflight; explicit delayed consent follows.');
 await expect.poll(()=>a.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('true');
 await app.evaluate(()=>{global.__ownedDialogs.answer=1;global.__ownedDialogs.delayNextMs=11000;});
 record('controlled-final-consent-delay-armed',{delayMs:11000,productCloseWatchdogMs:10000,productTimeoutModified:false,instanceId:delayedOwned.instance.instanceId,pid:delayedOwned.instance.pid,nonce:delayedMeta.nonce});
 write(heldFile,'Release own request before final synchronous thinking fixture');const delayedStored=await delayedRequest;assert.equal(delayedStored.pid,delayedOwned.instance.pid);
 await until(()=>log(pa,'actual-process-exit'),v=>v.some(row=>row.nonce===delayedMeta.nonce&&row.pid===delayedOwned.instance.pid&&row.code===0),'actual owned child natural exit0, before app teardown');
 const exit=await confirmedAppExit(app);assert.equal(exit.confirmed,true,'Actual Electron process exit AND application closed event must be observed');assert.equal(exit.exit.code,0);assert.equal(exit.exit.signal,null);app=null;
 const nativeDialogJournal=fs.readFileSync(path.join(temporary,'native-dialog-fixture.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const delayedDialogs=nativeDialogJournal.filter(row=>row.phase==='dialog-finished'&&row.delayMs===11000);assert.equal(delayedDialogs.length,1);assert.equal(delayedDialogs[0].answer,1);assert.ok(delayedDialogs[0].elapsedMs>=11000);
 result.nativeDialogJournal=nativeDialogJournal;
 pass('NEXT-015-008','controlled11s-final-consent-real-app-and-child-exit',{dialog:delayedDialogs[0],ownedChildExitCode:0,appExit:exit,nativePhysicalDialogClicks:false,productionWatchdogChanged:false});
 for(const p of [pa,pb]){assert.equal(readJSON(path.join(p.work,'cleanup-marker.json')).pendingWrites,0);await assert.rejects(fetch(p.origin+'/health',{signal:AbortSignal.timeout(500)}))}
 record('actual-Electron-approved-quit',{exit,beforeUnloadEvents,nativeDialogDecisions:'controlled fixture, not physical OS UI clicks'});
 ({app,page:main}=await launch());assert.equal((await runtime(pa)).instance,null);assert.equal((await runtime(pb)).instance,null);assert.ok((await runtime(pa)).config);assert.equal(fs.readFileSync(path.join(pb.work,'sentinel.txt'),'utf8'),'PRESERVE_B');
 pass('NEXT-015-008','actual-beforeunload-cancel-quit-reopen',{priorOwnedChildrenConfirmedExited:true,restoredRuntimeInstances:null,automaticServiceStart:false,nativeDialogChoiceFixture:true});
 for(const row of result.requirements)row.status=row.observations.length?'partial-observed':'not-run';
 for(const id of ['NEXT-015-001','NEXT-015-002','NEXT-015-003'])result.requirements.find(row=>row.id===id).status='observed-local-source';
 assert.deepEqual(result.errors,[]);assert.deepEqual(result.externalRendererRequests,[]);assert.equal(git('rev-parse','HEAD'),expectedHead);assert.equal(git('status','--porcelain'),'');
 for(const row of expectedFiles)assert.equal(fileSha(path.join(root,row.path)),row.sha256,row.path);
 result.finalBundleVerification=verifyBundle();if(bundle){result.packagedObservation={bundle:result.finalBundleVerification,target,sameProductAgentAndServicePaths:true};result.requirements.find(row=>row.id==='NEXT-015-010').status='partial-observed';}
 const expectedChecks=readJSON(path.join(here,'expected-owned-checks.json'));assert.deepEqual(result.checks.map(({id,name})=>({id,name})),expectedChecks);
 assert.equal(result.connectionInfoObservations.length,3);assert.ok(result.connectionInfoObservations.every(row=>row.status==='pass'&&row.inProcessStreamsFinished));assert.equal(result.connectionInfoObservations.filter(row=>row.originalLeaseReleaseConfirmed===true).length,1);
 result.ok=true;save();
}catch(error){retainAgentReadFailure(result.agentReadDiagnostics,new Date().toISOString());result.ok=false;result.failure={message:error.message,stack:error.stack,at:new Date().toISOString()};save();captureFixtureFiles('harness-catch');if(app)await ownWindowDiagnostics(null,'harness-failure').catch(cause=>{result.failureWindowDiagnosticError=cause.name||'unavailable'});if(app&&a&&!a.isClosed())await photo(a,'failure').catch(cause=>{result.failurePhotoError=cause.message});save();throw error;}
finally{
 // Release our own fixture work, cancel exact product job IDs and use retained
 // runtime IPC. Never signal, force-exit, adopt a PID, or destroy a foreign app.
 for(const p of projects)write(path.join(p.work,'release-hold'),'private cleanup release');
 const cleanupIssues=[];
 if(app){
  const owner=ownedApps.find(value=>value.application===app);
  if(!owner?.exitObserved||!owner?.closedObserved){
   let channels=[];try{channels=await cleanupChannels(app);}catch(error){cleanupIssues.push({kind:'consumer-enumeration',message:error.message});}
   if(!channels.length)cleanupIssues.push({kind:'no-owned-consumer',message:'No surviving trusted renderer channel; runtime child status cannot be confirmed.'});
   for(const job of jobs){const channel=matchingChannel(channels,job.projectId);if(!channel){cleanupIssues.push({kind:'job-consumer-lost',id:job.id,projectId:job.projectId});continue;}
    try{const state=await boundedCleanup(ipc(channel.page,'agent.read',{id:job.id}),'owned agent state');if(['running','queued'].includes(state.status))await boundedCleanup(ipc(channel.page,'agent.cancel',{id:job.id}),'owned agent cancel');}
    catch(error){cleanupIssues.push({kind:'job-cancel-unconfirmed',id:job.id,message:error.message});}}
   if(qaHandle)try{await invokeSocket(path.join(data,'integrations/tools.json'),'automation.qa.release',qaHandle,{timeoutMs:5000});qaHandle=null;}catch(error){cleanupIssues.push({kind:'QA-release-unconfirmed',message:error.message});}
   for(const p of projects){const channel=matchingChannel(channels,p.id);if(!channel){cleanupIssues.push({kind:'service-consumer-lost',projectId:p.id});continue;}
    let cleanupPhase='state';const cleanupStartedAt=new Date().toISOString();
    try{let state=await boundedCleanup(ipc(channel.page,'serviceRuntime.state',{projectId:p.id,connectionId:p.connection.id}),'owned runtime state');
     if(fixtureRoots.has(p))diagnosticJSON('cleanup-before-'+p.label,{at:new Date().toISOString(),projectId:p.id,connectionId:p.connection.id,state});
     cleanupPhase='stop';
     if(state.instance&&['starting','running','stopping','stop-unconfirmed'].includes(state.instance.status))state=await boundedCleanup(ipc(channel.page,'serviceRuntime.stop',{projectId:p.id,connectionId:p.connection.id,instanceId:state.instance.instanceId}),'exact owned runtime stop');
     cleanupPhase='terminal-state';
     if(state.instance&&state.instance.status!=='exited')throw new Error('Owned runtime terminal state unconfirmed');
     record('cleanup-owned-runtime-confirmed',{projectId:p.id,instance:state.instance});
    }catch(error){cleanupIssues.push({kind:'service-stop-unconfirmed',projectId:p.id,message:error.message});if(fixtureRoots.has(p)){diagnosticJSON('cleanup-catch-'+p.label,{projectId:p.id,connectionId:p.connection.id,cleanupPhase,startedAt:cleanupStartedAt,caughtAt:new Date().toISOString(),error:diagnosticError(error),originalFailure:result.failure||null});await capturePostStopRuntime(p,channel.page,'cleanup-catch-'+p.label);captureFixtureFiles('cleanup-catch-'+p.label);}}}
   if(!cleanupIssues.length){
    if(owner)journalOwnedApp(owner,'cleanup-quit-request');
    try{await boundedCleanup(app.evaluate(({app})=>{if(global.__ownedDialogs)global.__ownedDialogs.answer=1;setImmediate(()=>app.quit())}),'owned app quit request',3000);
     const exit=await confirmedAppExit(app);record('cleanup-owned-Electron-exit',exit);
     if(!exit.confirmed||exit.exit?.code!==0||exit.exit?.signal)cleanupIssues.push({kind:'app-exit-unconfirmed-or-abnormal',evidence:exit});
    }catch(error){cleanupIssues.push({kind:'app-quit-failed',message:error.message});if(owner)journalOwnedApp(owner,'cleanup-quit-error',{error:diagnosticError(error)});}
   }else if(owner)journalOwnedApp(owner,'cleanup-quit-not-requested',{reason:'Existing cleanupIssues guard retained the app',issueKinds:cleanupIssues.map(value=>value.kind)});
  }
 }
 if(externalServer)try{await boundedCleanup(new Promise((resolve,reject)=>externalServer.close(error=>error?reject(error):resolve())),'own external fixture server close',5000);}catch(error){cleanupIssues.push({kind:'fixture-server-close-unconfirmed',message:error.message});}
 if(fixture)try{result.nativeFixtureCleanup=await verifyNativeFixtureCleanup({packet,fixture});}catch(error){cleanupIssues.push({kind:'native-CLI-identity-unconfirmed',message:error.message});}
 result.appLifetimes=ownedApps.map(appEvidence);
 for(const attempt of appLaunchAttempts)if(!ownedApps.some(owner=>owner.launchAttemptId===attempt.id))cleanupIssues.push({kind:'app-launch-handle-unavailable',attempt});
 for(const owner of result.appLifetimes){if(!owner.exitObserved||!owner.closedObserved)cleanupIssues.push({kind:'retained-app-still-unconfirmed',evidence:owner});else if(owner.exit?.code!==0||owner.exit?.signal)cleanupIssues.push({kind:'retained-app-abnormal-exit',evidence:owner});}
 result.cleanup={status:cleanupIssues.length?'cleanup-unconfirmed':'confirmed',issues:cleanupIssues,appLifetimes:result.appLifetimes};
 if(cleanupIssues.length){result.ok=false;process.exitCode=1;result.cleanupPending='Owned fixture resources retained for root inspection; no signals, force exit or PID adoption.';}
 if(result.failure||cleanupIssues.length)captureFixtureFiles('cleanup-final');
 try{result.nativeFixtureEvidence=snapshotNativeFixtureEvidence({packet});}catch(error){result.ok=false;process.exitCode=1;result.nativeFixtureEvidenceFailure=error.message;}
 result.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({ok:result.ok,output,source:expectedHead,fullIssueComplete:false,cleanupPending:result.cleanupPending||null}));
}

