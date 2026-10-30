'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createUpdateManager, testManifestFor, testPointer, testBuild, inspectBundle, TEST_RELEASE_API, TEST_RELEASE_URL, RELEASE_API, RELEASES_URL } = require('../electron/updates.cjs');
const { createZip } = require('../electron/archive.cjs');
const { validateBuildInfo } = require('../electron/build-info.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const build = (number = 2) => ({ channel:'test', version:'1.2.9', buildNumber:number, commit:number.toString(16).padStart(40,'0'), builtAt:'2026-10-31T00:00:00.000Z' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function publication(info = build(), platform = 'darwin') {
  let bytes;
  if (platform === 'darwin') bytes = createZip([{name:'ReviewOps.app/Contents/Info.plist',bytes:Buffer.from('test')},{name:'ReviewOps.app/Contents/MacOS/ReviewOps',bytes:crypto.randomBytes(1024)}]);
  else { bytes = Buffer.alloc(2048); bytes.write('MZ'); bytes.writeUInt32LE(128,60); bytes.write('PE\0\0',128); }
  const arch = platform === 'darwin' ? 'arm64' : 'x64';
  const name = `ReviewOps-${info.version}-test.${info.buildNumber}-${platform === 'darwin' ? arch+'.zip' : 'windows-'+arch+'.exe'}`;
  const item = {name,url:`${RELEASES_URL}/download/test-latest/${name}`,size:bytes.length,sha256:sha(bytes)};
  const document = {schema:2,channel:'test',version:info.version,build:info,artifacts:{[`${platform}-${arch}`]:item}};
  const manifestBytes = Buffer.from(JSON.stringify(document));
  const manifestName = `reviewops-test-update-${info.buildNumber}-${info.commit.slice(0,12)}.json`;
  const pointer = {schema:1,buildNumber:info.buildNumber,commit:info.commit,manifest:manifestName,size:manifestBytes.length,sha256:sha(manifestBytes)};
  const published = {tag_name:'test-latest',draft:false,prerelease:true,body:`<!-- reviewops-test-pointer:${JSON.stringify(pointer)} -->`,assets:[{name,size:item.size,browser_download_url:item.url},{name:manifestName,size:manifestBytes.length,browser_download_url:`${RELEASES_URL}/download/test-latest/${manifestName}`}]};
  return {info,bytes,item,document,manifestBytes,pointer,published};
}
async function fixture(t, {platform='darwin', info, beforeRequest, beforeInspect, beforeOpen}={}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-test-channel-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dataPath=path.join(root,'data'), exe=path.join(root,'ReviewOps.app/Contents/MacOS/ReviewOps');
  await fs.mkdir(path.dirname(exe),{recursive:true}); await fs.writeFile(exe,'original app');
  const observed={requests:[],states:[],quit:0,opens:[],inspections:[],busy:false};
  let published=publication(build(),platform);
  const options={app:{isPackaged:true,getVersion:()=> '1.2.9',getPath:()=>exe,quit:()=>observed.quit++},dataPath,platform,arch:platform==='darwin'?'arm64':'x64',buildInfo:info,
    shell:{openExternal:async url=>observed.opens.push(url),openPath:async file=>{observed.opens.push(file);return await beforeOpen?.() || '';}},
    onChange:state=>observed.states.push(state),isBusy:()=>observed.busy,
    request:async(url,options)=>{
      observed.requests.push(url); await beforeRequest?.(url,options);
      if(url===RELEASE_API)return Buffer.from(JSON.stringify({tag_name:'v1.2.9',draft:false,prerelease:false}));
      if(url===TEST_RELEASE_API)return Buffer.from(JSON.stringify(published.published));
      const bytes=url.endsWith('.json')?published.manifestBytes:published.bytes;
      if(options.expectedHash)assert.equal(sha(bytes),options.expectedHash);
      if(options.expectedSize)assert.equal(bytes.length,options.expectedSize);
      if(options.filename){await fs.writeFile(options.filename,bytes);return {size:bytes.length};}
      return bytes;
    },
    command:async(_file,args)=>{if(args[0]==='-x')await fs.mkdir(path.join(args.at(-1),'ReviewOps.app'),{recursive:true});return {stdout:''};},
    inspect:async(...args)=>{observed.inspections.push(args);await beforeInspect?.(args);}
  };
  const manager=createUpdateManager(options); t.after(()=>manager.close());
  return {manager,options,root,dataPath,exe,observed,publication:()=>published,publish:info=>{published=publication(info,platform);}};
}
test('build identity and test pointer reject malformed or mismatched metadata',()=>{
  const p=publication();assert.deepEqual(testBuild(build(),'1.2.9'),validateBuildInfo(build(),'1.2.9'));
  assert.equal(testPointer(p.published).sha256,p.pointer.sha256);
  for(const patch of [{buildNumber:0},{commit:'short'},{builtAt:'yesterday'},{version:'1.2.9-beta'},{channel:'stable'}])assert.throws(()=>validateBuildInfo({...build(),...patch}));
  assert.throws(()=>testPointer({...p.published,prerelease:false}));
  assert.throws(()=>testPointer({...p.published,assets:[]}));
  assert.throws(()=>testPointer({...p.published,body:p.published.body+p.published.body}));
  assert.equal(testManifestFor(p.document,p.published,'arm64','1.2.9',null).build.buildNumber,2);
  assert.equal(testManifestFor(p.document,p.published,'arm64','1.2.9',build()),null);
  assert.throws(()=>testManifestFor(p.document,p.published,'arm64','1.2.9',build(3)),/오래된/);
  assert.throws(()=>testManifestFor(p.document,p.published,'arm64','1.3.0',null),/낮은/);
  assert.throws(()=>testManifestFor({...p.document,build:{...build(),commit:'a'.repeat(40)}},p.published,'arm64','1.2.9',build()),/같은/);
  assert.throws(()=>testManifestFor(p.document,{...p.published,assets:[]},'arm64','1.2.9',null));
});
test('test updates are opt-in, recognize a rebuild and persist after relaunch',async t=>{
  const f=await fixture(t);assert.equal(f.manager.snapshot().testUpdates,false);
  await f.manager.check();assert.deepEqual(f.observed.requests,[RELEASE_API]);
  const state=await f.manager.configure({testUpdates:true});assert.equal(state.status,'available');assert.equal(state.availableVersion,'1.2.9');assert.equal(state.availableBuild.buildNumber,2);
  assert.equal(f.observed.quit,0);assert.equal(await fs.readFile(f.exe,'utf8'),'original app');
  const restored=createUpdateManager(f.options);t.after(()=>restored.close());assert.equal(restored.snapshot().testUpdates,true);
  await f.manager.configure({testUpdates:false});assert.equal(f.manager.snapshot().channel,'stable');assert.equal(f.manager.snapshot().availableBuild,null);assert.equal(f.observed.quit,0);
  const stable=createUpdateManager(f.options);t.after(()=>stable.close());assert.equal(stable.snapshot().testUpdates,false);
});
test('remembered build order rejects server rollback and same-number changes',async t=>{
  const f=await fixture(t);await f.manager.configure({testUpdates:true});f.publish(build(1));
  assert.equal((await f.manager.check()).errorCode,'older_build');assert.equal(f.manager.snapshot().availableVersion,null);
  f.publish({...build(),builtAt:'2026-10-31T01:00:00.000Z'});assert.equal((await f.manager.check()).errorCode,'invalid_manifest');
  f.publish(build(3));assert.equal((await f.manager.check()).availableBuild.buildNumber,3);
});
test('channel switch discards an outstanding test check, even if transport ignores abort',async t=>{
  const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
  const f=await fixture(t,{beforeRequest:async url=>{if(url===TEST_RELEASE_API){entered.resolve();await gate.promise;}}});
  const checking=f.manager.configure({testUpdates:true});await entered.promise;
  await f.manager.configure({testUpdates:false});gate.resolve();await checking;
  assert.equal(f.manager.snapshot().channel,'stable');assert.equal(f.manager.snapshot().availableBuild,null);assert.equal(f.manager.snapshot().status,'current');
});
test('channel switch removes an outstanding download and blocks old-channel installation',async t=>{
  const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
  const f=await fixture(t,{beforeRequest:async(url,options)=>{if(options.filename){entered.resolve();await gate.promise;}}});
  await f.manager.configure({testUpdates:true});const downloading=f.manager.download();await entered.promise;
  await f.manager.configure({testUpdates:false});gate.resolve();await downloading;
  assert.equal(f.manager.snapshot().channel,'stable');await assert.rejects(f.manager.install(),/verify/);assert.equal(f.observed.quit,0);
  assert.equal((await fs.readdir(path.join(f.dataPath,'updates'))).filter(name=>name.startsWith('download-')).length,0);
});
test('test absence and network errors never report current',async t=>{
  for(const code of ['not_found','network_error']){
    const f=await fixture(t,{beforeRequest:async url=>{if(url===TEST_RELEASE_API)throw Object.assign(new Error('cannot check'),{code});}});
    const state=await f.manager.configure({testUpdates:true});assert.equal(state.status,'error');assert.equal(state.errorCode,code==='not_found'?'test_unavailable':code);assert.equal(state.availableVersion,null);
  }
});
test('removed older test download requires a fresh check and can then recover',async t=>{
  let removed=true;
  const f=await fixture(t,{beforeRequest:async(_url,options)=>{if(options.filename&&removed)throw Object.assign(new Error('removed'),{code:'not_found'});}});
  await f.manager.configure({testUpdates:true});assert.equal((await f.manager.download()).errorCode,'test_changed');assert.equal(f.manager.snapshot().availableVersion,null);
  removed=false;f.publish(build(3));await f.manager.check();assert.equal((await f.manager.download()).status,'ready');assert.equal(f.observed.inspections[0][4].buildNumber,3);
});
test('test package build mismatch prevents native installation',async t=>{
  const f=await fixture(t,{beforeInspect:async()=>{throw Object.assign(new Error('wrong build'),{code:'build_mismatch'});}});
  await f.manager.configure({testUpdates:true});assert.equal((await f.manager.download()).errorCode,'build_mismatch');await assert.rejects(f.manager.install());assert.equal(f.observed.quit,0);
});
test('Windows receives, verifies and opens its installer without replacing or quitting the app',async t=>{
  const f=await fixture(t,{platform:'win32'});assert.equal(f.manager.snapshot().testSupported,true);assert.equal(f.manager.snapshot().canCheck,false);
  await f.manager.configure({testUpdates:true});assert.equal(f.manager.snapshot().manualInstall,true);assert.equal((await f.manager.download()).status,'ready');
  const original=await fs.readFile(f.exe,'utf8');assert.equal((await f.manager.install()).status,'ready');assert.equal(f.observed.opens.length,1);assert.match(f.observed.opens[0],/-windows-x64\.exe$/);assert.equal(f.observed.quit,0);assert.equal(await fs.readFile(f.exe,'utf8'),original);
  await fs.writeFile(f.observed.opens[0],'corrupt');assert.equal((await f.manager.install()).status,'error');assert.equal(f.observed.opens.length,1);
});
test('channel cannot change after the Windows installer launch has begun',async t=>{
  const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
  const f=await fixture(t,{platform:'win32',beforeOpen:async()=>{entered.resolve();await gate.promise;}});
  await f.manager.configure({testUpdates:true});await f.manager.download();const opening=f.manager.install();await entered.promise;
  await assert.rejects(f.manager.configure({testUpdates:false}),/설치/);gate.resolve();await opening;assert.equal(f.observed.quit,0);
});
test('same-size Windows installer tampering is blocked and opening failures can be retried',async t=>{
  let failed=true;
  const f=await fixture(t,{platform:'win32',beforeOpen:async()=>{if(failed){failed=false;return 'cannot open';}return '';}});
  await f.manager.configure({testUpdates:true});await f.manager.download();
  assert.equal((await f.manager.install()).errorCode,'installer_failed');assert.equal((await f.manager.install()).status,'ready');
  assert.equal(f.observed.opens.length,2);
  const file=f.observed.opens[0],bytes=await fs.readFile(file);bytes[bytes.length-1]^=1;await fs.writeFile(file,bytes);
  assert.equal((await f.manager.install()).errorCode,'hash_mismatch');assert.equal(f.observed.opens.length,2);assert.equal(f.observed.quit,0);
});
test('bundle verification compares embedded metadata with the selected generation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-bundle-build-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bundle=path.join(root,'ReviewOps.app'),binary=path.join(bundle,'Contents/MacOS/ReviewOps'),metadata=path.join(bundle,'Contents/Resources/app.asar/electron/reviewops-build.json');
  await fs.mkdir(path.dirname(binary),{recursive:true});await fs.mkdir(path.dirname(metadata),{recursive:true});
  const header=Buffer.alloc(32);header.writeUInt32LE(0xfeedfacf);header.writeUInt32LE(0x0100000c,4);await fs.writeFile(binary,header);await fs.writeFile(metadata,JSON.stringify(build()));
  const command=async(file,args)=>({stdout:file.endsWith('PlistBuddy')?(args[1].endsWith('CFBundleIdentifier')?'kr.co.season.reviewops.local':args[1].endsWith('CFBundleShortVersionString')?'1.2.9':'ReviewOps'):''});
  await inspectBundle(bundle,'1.2.9','arm64',command,build());await assert.rejects(inspectBundle(bundle,'1.2.9','arm64',command,build(3)),/빌드 정보/);
});
