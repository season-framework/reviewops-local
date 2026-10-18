'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {createUpdateManager,manifestFor,newer,allowedDownload,inspectBundle,machoArchitectures,hasActiveWork,RELEASE_API,RELEASES_URL}=require('../electron/updates.cjs');
const {validateArchive}=require('../electron/update-archive.cjs');
const {createZip}=require('../electron/archive.cjs');
const asset={name:'ReviewOps-1.2.0-arm64.zip',url:`${RELEASES_URL}/download/v1.2.0/ReviewOps-1.2.0-arm64.zip`,sha256:'a'.repeat(64),size:1024};
const manifest={schema:1,version:'1.2.0',artifacts:{'darwin-arm64':asset}};
const release={tag_name:'v1.2.0',draft:false,prerelease:false,assets:[{...asset,browser_download_url:asset.url},{name:'reviewops-update.json',size:300,browser_download_url:`${RELEASES_URL}/download/v1.2.0/reviewops-update.json`}]};
const archive=()=>createZip([{name:'ReviewOps.app/Contents/Info.plist',bytes:Buffer.from('test')},{name:'ReviewOps.app/Contents/MacOS/ReviewOps',bytes:Buffer.alloc(1024,1)}]);
async function temp(t){const root=await fs.mkdtemp('/tmp/reviewops-update-test-');t.after(()=>fs.rm(root,{recursive:true,force:true}));return root}
test('stable semver comparison refuses downgrade and malformed versions',()=>{
 assert(newer('1.10.0','1.2.0'));assert(!newer('1.2.0','1.2.0'));assert(!newer('1.1.9','1.2.0'));
 for(const version of ['1.2.0-beta','v1.2.0','../1.2.0','1.2','9999999999.0.0'])assert.throws(()=>newer(version,'1.2.0'));
});
test('update manifest binds stable tag, architecture, URL, size and checksum to public GitHub release',()=>{
 assert.equal(manifestFor(manifest,release,'arm64','1.1.1').version,'1.2.0');
 assert.equal(manifestFor(manifest,release,'arm64','1.2.0'),null);
 for(const invalid of [{...release,tag_name:'v1.2.1'},{...release,draft:true},{...release,prerelease:true},{...release,assets:[]}])assert.throws(()=>manifestFor(manifest,invalid,'arm64','1.1.1'));
 for(const changed of [{url:'https://evil.example/update.zip'},{sha256:'x'.repeat(64)},{size:-1},{size:600*1024**2},{name:'other.zip'}])assert.throws(()=>manifestFor({...manifest,artifacts:{'darwin-arm64':{...asset,...changed}}},release,'arm64','1.1.1'));
 assert.throws(()=>manifestFor(manifest,release,'x64','1.1.1'));
});
test('network destinations require HTTPS and known GitHub hosts',()=>{
 for(const url of [RELEASE_API,asset.url,'https://release-assets.githubusercontent.com/a?token=temporary'])assert(allowedDownload(url));
 for(const url of ['http://github.com/a','https://github.com.evil.test/a','https://user@github.com/a','https://github.com:8443/a','file:///tmp/a','https://127.0.0.1/a'])assert.throws(()=>allowedDownload(url));
});
test('ZIP validation rejects traversal, mismatched local names and overlapping file data',async t=>{
 const root=await temp(t),file=path.join(root,'update.zip');await fs.writeFile(file,archive());assert.equal((await validateArchive(file)).entries,2);
 const original=archive(),name=Buffer.from('ReviewOps.app/Contents/Info.plist');
 const mismatch=Buffer.from(original);mismatch[30]=0x58;await fs.writeFile(file,mismatch);await assert.rejects(validateArchive(file));
 const traversal=Buffer.from(original);const evil=Buffer.from('../outside/xx/Contents/Info.plist');assert.equal(evil.length,name.length);let index=0;while((index=traversal.indexOf(name,index))>=0){evil.copy(traversal,index);index+=name.length}await fs.writeFile(file,traversal);await assert.rejects(validateArchive(file));
 const bad=Buffer.from(original),end=bad.length-22,central=bad.readUInt32LE(end+16),next=central+46+name.length;bad.writeUInt32LE(0,next+42);await fs.writeFile(file,bad);await assert.rejects(validateArchive(file));
});
test('ZIP validation rejects links outside bundle and files nested beneath symlinks',async t=>{
 const root=await temp(t),file=path.join(root,'update.zip');
 const make=target=>{const bytes=createZip([{name:'ReviewOps.app/Contents/Info.plist',bytes:Buffer.from('test')},{name:'ReviewOps.app/Contents/MacOS/ReviewOps',bytes:Buffer.from('binary')},{name:'ReviewOps.app/link',bytes:Buffer.from(target)},{name:'ReviewOps.app/link/file',bytes:Buffer.from('bad')}]);let cursor=bytes.readUInt32LE(bytes.length-6);for(let n=0;n<4;n++){if(n===2)bytes.writeUInt32LE((0xa1ff<<16)>>>0,cursor+38);cursor+=46+bytes.readUInt16LE(cursor+28)}return bytes};
 for(const target of ['../../outside','Contents']){await fs.writeFile(file,make(target));await assert.rejects(validateArchive(file))}
});
test('native verification checks bundle identity, version, architecture and code signature',async t=>{
 const root=await temp(t),bundle=path.join(root,'ReviewOps.app');await fs.mkdir(path.join(bundle,'Contents/MacOS'),{recursive:true});const header=Buffer.alloc(32);header.writeUInt32LE(0xfeedfacf,0);header.writeUInt32LE(0x0100000c,4);await fs.writeFile(path.join(bundle,'Contents/MacOS/ReviewOps'),header);
 const calls=[];const command=async(binary,args)=>{calls.push([binary,args]);if(binary.endsWith('PlistBuddy'))return {stdout:args[1].endsWith('CFBundleIdentifier')?'kr.co.season.reviewops.local':args[1].endsWith('CFBundleShortVersionString')?'1.2.0':'ReviewOps'};return {stdout:'arm64'}};
 await inspectBundle(bundle,'1.2.0','arm64',command);assert(calls.some(([name,args])=>name.endsWith('codesign')&&args.includes('--strict')));
 await assert.rejects(inspectBundle(bundle,'1.2.1','arm64',command));await assert.rejects(inspectBundle(bundle,'1.2.0','x64',command));
});
test('active terminal, account, host and file-transfer work blocks installation',()=>{
 assert(!hasActiveWork({}));
 for(const state of [{operations:new Set(['job'])},{terminals:{size:1}},{codexManager:{accountState:()=>({accounts:[{status:'loggingIn'}]})}},{codexManager:{hostState:()=>({hosts:[{operation:{running:true}}]})}},{codexManager:{fileService:{operations:new Set(['job'])}}},{codexManager:{fileService:{getTransfers:()=>[{status:'running'}]}}}])assert(hasActiveWork(state));
});
test('only confirmed durable SSH agents are excluded from active work',()=>{
 const remote={kind:'agent',remoteExecution:{version:1,ready:true}};
 const agents={hasBlockingJobs:false,read:id=>{assert.equal(id,'remote-job');return remote}};
 const durable={operations:new Set(['agent:remote-job']),agents};
 assert.equal(hasActiveWork(durable),false);
 const protectedJobs=[
  ['local agent',{kind:'agent'}],
  ['SSH agent still starting',{kind:'agent',remoteExecution:{version:1,ready:false}}],
  ['unconfirmed SSH agent',{kind:'agent',remoteExecution:{version:1}}],
  ['unsupported remote execution',{kind:'agent',remoteExecution:{version:2,ready:true}}],
  ['ordinary SSH command',{kind:'shell',remoteExecution:{version:1,ready:true}}]
 ];
 for(const [name,job] of protectedJobs)assert.equal(hasActiveWork({...durable,agents:{hasBlockingJobs:false,read:()=>job}}),true,name);
 for(const [name,extra] of [
  ['blocking agent',{agents:{...agents,hasBlockingJobs:true}}],
  ['missing agent manager',{agents:null}],
  ['missing job',{agents:{hasBlockingJobs:false,read:()=>{throw new Error('job missing')}}}],
  ['active terminal',{terminals:{size:1}}],
  ['ordinary operation',{operations:new Set(['agent:remote-job','transfer:one'])}],
  ['account refresh',{codexManager:{accountState:()=>({refresh:{running:true},accounts:[]})}}],
  ['account loading',{codexManager:{accountState:()=>({accounts:[{status:'loading'}]})}}],
  ['account login',{codexManager:{accountState:()=>({accounts:[{status:'loggingIn'}]})}}],
  ['account reset',{codexManager:{accountState:()=>({accounts:[{resetAttempt:{status:'pending'}}]})}}],
  ['host refresh',{codexManager:{hostState:()=>({refresh:{running:true},hosts:[]})}}],
  ['host upgrade',{codexManager:{hostState:()=>({batchUpgrade:{running:true},hosts:[]})}}],
  ['host operation',{codexManager:{hostState:()=>({hosts:[{operation:{running:true}}]})}}],
  ['file operation',{codexManager:{fileService:{operations:new Set(['file-job'])}}}],
  ['file transfer',{codexManager:{fileService:{getTransfers:()=>[{status:'running'}]}}}]
 ])assert.equal(hasActiveWork({...durable,...extra}),true,name);
 assert.equal(hasActiveWork({...durable,codexManager:{fileService:{getTransfers:()=>[{status:'completed'}]}}}),false);
});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
async function managerFixture(t,{requestFailure=false,beforeRequest,beforeInspect}={}) {
 const root=await temp(t),bundle=path.join(root,'ReviewOps.app'),exe=path.join(bundle,'Contents/MacOS/ReviewOps');await fs.mkdir(path.dirname(exe),{recursive:true});await fs.writeFile(exe,'old');
 const bytes=archive(),selected={...asset,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')},published={...release,assets:release.assets.map(item=>item.name===asset.name?{...item,size:bytes.length}:item)},document={...manifest,artifacts:{'darwin-arm64':selected}};
 const observed={requests:[],states:[],inspections:[],quit:0,spawn:[],busy:false,requestFailure};
 const manager=createUpdateManager({app:{isPackaged:true,getVersion:()=> '1.1.1',getPath:()=>exe,quit:()=>observed.quit++},dataPath:path.join(root,'data'),shell:{openExternal:async url=>{observed.url=url}},platform:'darwin',arch:'arm64',isBusy:()=>observed.busy,onChange:state=>observed.states.push(state),request:async(url,options)=>{observed.requests.push(url);await beforeRequest?.(url,options);if(observed.requestFailure)throw new Error('network unavailable');if(url===RELEASE_API)return Buffer.from(JSON.stringify(published));if(url.endsWith('reviewops-update.json'))return Buffer.from(JSON.stringify(document));assert.equal(options.expectedHash,selected.sha256);assert.equal(options.expectedSize,bytes.length);await fs.writeFile(options.filename,bytes);return {size:bytes.length}},command:async(_binary,args)=>{if(args[0]==='-x'){const target=path.join(args.at(-1),'ReviewOps.app');await fs.mkdir(target,{recursive:true})}return {stdout:''}},inspect:async(bundle,version,arch)=>{observed.inspections.push({bundle,version,arch});await beforeInspect?.(observed)},spawnImpl:(...args)=>{observed.spawn.push(args);return {unref(){}}}});
 t.after(()=>manager.close());return {manager,root,observed};
}
test('update check/download/install waits for actual quit and preserves isolated data location',async t=>{
 const {manager,observed,root}=await managerFixture(t);assert.equal((await manager.check()).status,'available');assert.equal((await manager.download()).status,'ready');
 observed.busy=true;await assert.rejects(manager.install(),/active tasks/);observed.busy=false;
 await manager.install();await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);assert.equal(observed.spawn.length,0);
 manager.cancelInstall();assert.equal(manager.snapshot().status,'ready');manager.launchInstall();assert.equal(observed.spawn.length,0);
 await manager.install();manager.launchInstall();assert.equal(observed.spawn.length,1);assert.equal(observed.spawn[0][2].env.REVIEWOPS_DATA_DIR,path.join(root,'data'));assert.equal(observed.spawn[0][0],'/bin/sh');
});
test('failed automatic check reports error and allows retry without installation',async t=>{
 const {manager,observed}=await managerFixture(t,{requestFailure:true});const state=await manager.check();assert.equal(state.status,'error');assert.match(state.error,/network unavailable/);assert.equal(observed.quit,0);assert.equal(observed.spawn.length,0);
 await manager.configure({automatic:false});assert.equal(manager.snapshot().automatic,false);await assert.rejects(manager.configure({automatic:'yes'}));
});
test('one apply checks, downloads, verifies and installs with one quit request',async t=>{
 const {manager,observed}=await managerFixture(t);
 const result=await manager.apply();assert.equal(result.status,'installing');assert.equal(result.availableVersion,'1.2.0');assert.equal(result.progress,100);
 assert.deepEqual(observed.requests,[RELEASE_API,release.assets[1].browser_download_url,asset.url]);
 assert.deepEqual(observed.states.map(state=>state.status),['checking','available','downloading','verifying','ready','installing']);
 assert.equal(observed.inspections.length,2);assert.equal(observed.inspections[0].bundle,observed.inspections[1].bundle);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);assert.equal(observed.spawn.length,0);
});
test('concurrent apply calls share the whole update and never schedule duplicate installation',async t=>{
 const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
 const {manager,observed}=await managerFixture(t,{beforeRequest:async url=>{if(url===RELEASE_API){entered.resolve();await gate.promise}}});
 const first=manager.apply();await entered.promise;
 const second=manager.apply(),third=manager.apply();assert.equal(second,first);assert.equal(third,first);assert.equal(observed.requests.length,1);
 gate.resolve();const results=await Promise.all([first,second,third]);assert.ok(results.every(state=>state.status==='installing'));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);assert.equal(observed.requests.length,3);
 assert.equal((await manager.apply()).status,'installing');await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);assert.equal(observed.requests.length,3);
});
test('apply joins an in-progress scheduled check before downloading and installing',async t=>{
 const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
 const {manager,observed}=await managerFixture(t,{beforeRequest:async url=>{if(url===RELEASE_API){entered.resolve();await gate.promise}}});
 const checking=manager.check();await entered.promise;const applying=manager.apply();
 assert.equal(manager.snapshot().status,'checking');assert.deepEqual(observed.requests,[RELEASE_API]);
 gate.resolve();assert.equal((await checking).status,'available');assert.equal((await applying).status,'installing');
 assert.deepEqual(observed.requests,[RELEASE_API,release.assets[1].browser_download_url,asset.url]);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);
});
test('apply joins a Settings download and installs the same verified bundle',async t=>{
 const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
 const {manager,observed}=await managerFixture(t,{beforeRequest:async url=>{if(url===asset.url){entered.resolve();await gate.promise}}});
 assert.equal((await manager.check()).status,'available');
 const downloading=manager.download();await entered.promise;const applying=manager.apply();
 assert.equal(manager.snapshot().status,'downloading');assert.equal(observed.requests.filter(url=>url===asset.url).length,1);
 gate.resolve();assert.equal((await downloading).status,'ready');assert.equal((await applying).status,'installing');
 assert.equal(observed.requests.length,3);assert.equal(observed.inspections.length,2);assert.equal(observed.inspections[0].bundle,observed.inspections[1].bundle);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);
});
test('apply retries a failed update check without installing until the check succeeds',async t=>{
 const {manager,observed}=await managerFixture(t,{requestFailure:true});
 const failed=await manager.apply();assert.equal(failed.status,'error');assert.match(failed.error,/network unavailable/);assert.equal(observed.quit,0);assert.deepEqual(observed.requests,[RELEASE_API]);
 observed.requestFailure=false;
 assert.equal((await manager.apply()).status,'installing');
 assert.deepEqual(observed.requests,[RELEASE_API,RELEASE_API,release.assets[1].browser_download_url,asset.url]);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);
});
test('apply retries a failed archive download without repeating the successful release check',async t=>{
 let failDownload=true;
 const {manager,observed,root}=await managerFixture(t,{beforeRequest:async(url,options)=>{if(url===asset.url&&failDownload){failDownload=false;await fs.writeFile(options.filename,'incomplete');throw new Error('download disconnected')}}});
 const failed=await manager.apply();assert.equal(failed.status,'error');assert.match(failed.error,/download disconnected/);assert.equal(observed.quit,0);
 assert.equal((await fs.readdir(path.join(root,'data/updates'))).filter(name=>name.startsWith('download-')).length,0);
 assert.equal((await manager.apply()).status,'installing');assert.deepEqual(observed.requests,[RELEASE_API,release.assets[1].browser_download_url,asset.url,asset.url]);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);
});
test('apply preserves a verified download after a busy error and installs it on retry',async t=>{
 const {manager,observed,root}=await managerFixture(t);observed.busy=true;
 const failed=await manager.apply();assert.equal(failed.status,'error');assert.match(failed.error,/active tasks/);assert.equal(failed.availableVersion,'1.2.0');assert.equal(observed.quit,0);assert.equal(observed.requests.length,3);assert.equal(observed.inspections.length,1);
 const verified=observed.inspections[0].bundle;assert.ok((await fs.stat(verified)).isDirectory());
 observed.busy=false;assert.equal((await manager.apply()).status,'installing');assert.equal(observed.requests.length,3);assert.equal(observed.inspections[1].bundle,verified);
 const pending=JSON.parse(await fs.readFile(path.join(root,'data/updates/pending.json'),'utf8'));assert.equal(path.join(pending.job,'unpacked/ReviewOps.app'),verified);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);
});
test('new work started during installation verification prevents quitting and retains the verified update',async t=>{
 const {manager,observed,root}=await managerFixture(t,{beforeInspect:async state=>{if(state.inspections.length===2)state.busy=true}});
 const failed=await manager.apply();assert.equal(failed.status,'error');assert.match(failed.error,/active tasks/);assert.equal(manager.installing,false);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,0);manager.launchInstall();assert.equal(observed.spawn.length,0);
 await assert.rejects(fs.stat(path.join(root,'data/updates/pending.json')),{code:'ENOENT'});
 assert.equal(observed.requests.length,3);const verified=observed.inspections[0].bundle;assert.equal(observed.inspections[1].bundle,verified);
 observed.busy=false;assert.equal((await manager.apply()).status,'installing');assert.equal(observed.requests.length,3);assert.equal(observed.inspections[2].bundle,verified);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);
});
test('apply installs a ready update and reuses it after restart is cancelled',async t=>{
 const {manager,observed}=await managerFixture(t);await manager.check();await manager.download();assert.equal(manager.snapshot().status,'ready');
 const requests=[...observed.requests],verified=observed.inspections[0].bundle;
 assert.equal((await manager.apply()).status,'installing');await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,1);assert.deepEqual(observed.requests,requests);
 manager.cancelInstall();assert.equal(manager.snapshot().status,'ready');manager.launchInstall();assert.equal(observed.spawn.length,0);
 assert.equal((await manager.apply()).status,'installing');await new Promise(resolve=>setImmediate(resolve));assert.equal(observed.quit,2);assert.deepEqual(observed.requests,requests);
 assert.ok(observed.inspections.every(item=>item.bundle===verified));assert.equal(observed.inspections.length,3);
 manager.launchInstall();assert.equal(observed.spawn.length,1);
});
test('streamed download enforces SHA256 and byte count and removes corrupt partial files',async t=>{
 const {download}=require('../electron/updates.cjs'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events');
 const root=await temp(t),payload=Buffer.from('verified release data');
 const transport=(_url,_options,callback)=>{const req=new EventEmitter();req.setTimeout=()=>{};queueMicrotask(()=>{const response=Readable.from([payload]);response.statusCode=200;response.headers={'content-length':String(payload.length)};callback(response)});return req};
 const hash=crypto.createHash('sha256').update(payload).digest('hex');
 const valid=path.join(root,'valid.zip');await download(asset.url,{filename:valid,expectedSize:payload.length,expectedHash:hash,transport});assert.deepEqual(await fs.readFile(valid),payload);
 for(const [name,options] of [['checksum',{expectedHash:'a'.repeat(64)}],['truncated',{expectedSize:payload.length+1}],['oversize',{maxBytes:3}]]){const file=path.join(root,name);await assert.rejects(download(asset.url,{filename:file,transport,...options}));await assert.rejects(fs.stat(file),{code:'ENOENT'})}
});
test('a redirect cannot move the update request outside GitHub HTTPS origins',async()=>{
 const {download}=require('../electron/updates.cjs'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events');let requests=0;
 const transport=(_url,_options,callback)=>{requests++;const req=new EventEmitter();req.setTimeout=()=>{};queueMicrotask(()=>{const response=Readable.from([]);response.statusCode=302;response.headers={location:'https://evil.example/update.zip'};callback(response)});return req};
 await assert.rejects(download(asset.url,{transport}),/not allowed/);assert.equal(requests,1);
});

test('Mach-O processor parsing supports thin and universal apps without developer tools',()=>{
 const thin=Buffer.alloc(32);thin.writeUInt32LE(0xfeedfacf);thin.writeUInt32LE(0x0100000c,4);assert.deepEqual(machoArchitectures(thin),['arm64']);thin.writeUInt32LE(0x01000007,4);assert.deepEqual(machoArchitectures(thin),['x64']);
 const fat=Buffer.alloc(48);fat.writeUInt32BE(0xcafebabe);fat.writeUInt32BE(2,4);fat.writeUInt32BE(0x0100000c,8);fat.writeUInt32BE(0x01000007,28);assert.deepEqual(machoArchitectures(fat),['arm64','x64']);fat.writeUInt32BE(100,4);assert.throws(()=>machoArchitectures(fat));assert.throws(()=>machoArchitectures(Buffer.alloc(32)));
});
test('cache pruning retains active/new candidates and latest rollback without deleting unrelated data',async t=>{
 const {pruneUpdateCache}=require('../electron/updates.cjs'),root=await temp(t),jobs=[];
 for(let i=0;i<8;i++){const job=path.join(root,`download-job00${i}`);jobs.push(job);await fs.mkdir(job);await fs.writeFile(path.join(job,'metadata.json'),JSON.stringify({owner:'reviewops-updater',schema:1,createdAt:i}));if(i===2||i===4)await fs.writeFile(path.join(job,'result'),'installed')}
 const unrelated=path.join(root,'download-user01');await fs.mkdir(unrelated);await fs.writeFile(path.join(unrelated,'user.txt'),'untouched');
 const symlink=path.join(root,'download-link01');await fs.symlink(unrelated,symlink);
 await fs.writeFile(path.join(root,'pending.json'),JSON.stringify({job:jobs[0]}));
 await pruneUpdateCache(root,[jobs[1]]);
 for(const index of [0,1,4,6,7])assert((await fs.stat(jobs[index])).isDirectory());
 for(const index of [2,3,5])await assert.rejects(fs.stat(jobs[index]),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(unrelated,'user.txt'),'utf8'),'untouched');assert((await fs.lstat(symlink)).isSymbolicLink());
});
