'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const helper=import('../scripts/packaged-identity-continuity.mjs');
const a='a'.repeat(40),b='b'.repeat(40),sha='c'.repeat(64);

test('continuity plan admits distinct private Mac/Windows bundles and rejects path escapes or reused sources',async()=>{
 const {validatePlan}=await helper;
 const mac={schema:1,platform:'darwin',arch:'x64',privateRoot:'/private/tmp/reviewops-identity-inputs-test',
  baseline:{appPath:'/private/tmp/reviewops-identity-inputs-test/a/ReviewOps.app',source:a},
  candidate:{appPath:'/private/tmp/reviewops-identity-inputs-test/b/ReviewOps.app',source:b}};
 assert.deepEqual(validatePlan(mac,'darwin','x64'),mac);
 assert.throws(()=>validatePlan({...mac,candidate:{appPath:'/Applications/ReviewOps.app',source:b}},'darwin','x64'));
 assert.throws(()=>validatePlan({...mac,candidate:{...mac.candidate,source:a}},'darwin','x64'));
 const windows={schema:1,platform:'win32',arch:'x64',privateRoot:'C:\\Temp\\reviewops-identity-inputs-test',
  baseline:{appPath:'C:\\Temp\\reviewops-identity-inputs-test\\a\\ReviewOps',source:a},
  candidate:{appPath:'C:\\Temp\\reviewops-identity-inputs-test\\b\\ReviewOps',source:b}};
 assert.deepEqual(validatePlan(windows,'win32','x64'),windows);
 assert.throws(()=>validatePlan({...windows,candidate:{...windows.candidate,appPath:'C:\\Temp\\reviewops-identity-inputs-test\\..\\ReviewOps'}},'win32','x64'));
});

test('a real update requires changed source and ASAR plus a later version or test build',async()=>{
 const {compareBuildPair}=await helper;
 const baseline={source:a,archive:{sha256:sha},build:{version:'1.5.0',buildNumber:1}};
 const candidate={source:b,archive:{sha256:'d'.repeat(64)},build:{version:'1.6.0',buildNumber:2}};
 compareBuildPair(baseline,candidate);
 assert.throws(()=>compareBuildPair(baseline,{...candidate,source:a}));
 assert.throws(()=>compareBuildPair(baseline,{...candidate,archive:baseline.archive}));
 assert.throws(()=>compareBuildPair(baseline,{...candidate,build:{version:'1.5.0',buildNumber:1}}));
});

test('changed protected identity, certificate or saved credential fingerprints fail continuity',async()=>{
 const {assertContinuity,CONTINUITY_FIELDS}=await helper;
 const original=Object.fromEntries(CONTINUITY_FIELDS.map(key=>[key,key==='backend'?'macos-default-file-keychain':sha]));
 assertContinuity(original,{...original});
 for(const field of CONTINUITY_FIELDS.filter(key=>key!=='backend'))
  assert.throws(()=>assertContinuity(original,{...original,[field]:'d'.repeat(64)}));
 assert.throws(()=>assertContinuity(original,{...original,backend:'electron-safe-storage'}));
});

test('read-only bundle inventory refuses a symlink that leaves the private bundle',async t=>{
 const {inventory}=await helper,root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-identity-static-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app=path.join(root,'app');fs.mkdirSync(app);fs.writeFileSync(path.join(root,'outside'),'private fixture');
 fs.symlinkSync(path.join(root,'outside'),path.join(app,'escape'));
 assert.throws(()=>inventory(app));
});

test('forged embedded source metadata cannot hide runtime code that differs from the admitted Git source',async t=>{
 // Controlled archive/Git metadata only. No codesign, native module, app,
 // Keychain, DPAPI or actual packaging operation runs in this static test.
 const {inspectPrivateBundle}=await helper;
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-identity-inputs-static-')));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app=path.join(root,'ReviewOps');fs.mkdirSync(path.join(app,'resources'),{recursive:true});
 fs.writeFileSync(path.join(app,'ReviewOps.exe'),'unexecuted fixture');fs.writeFileSync(path.join(app,'resources/app.asar'),'unexecuted fixture archive');
 const pkg={name:'reviewops-local',version:'1.5.0'},build={channel:'test',version:'1.5.0',buildNumber:1,commit:a,builtAt:'2026-11-07T00:00:00.000Z'};
 const modules={'electron/remote-device-identity.cjs':Buffer.from('original identity module'),'electron/remote-app-connections.cjs':Buffer.from('changed credential module')};
 const asar={extractFile(_archive,name){return name==='package.json'?Buffer.from(JSON.stringify(pkg)):name==='electron/reviewops-build.json'?Buffer.from(JSON.stringify(build)):modules[name];}};
 const run=async(command,args)=>{
  assert.equal(command,'git','No OS signing or native command may run in this source-mismatch test');
  if(args[0]==='ls-tree')return{stdout:Object.keys(modules).join('\n')+'\n'};
  if(args[1]===a+':package.json')return{stdout:JSON.stringify(pkg)};
  const file=args[1].slice(a.length+1);return{stdout:Buffer.from(file.endsWith('identity.cjs')?'original identity module':'original credential module')};
 };
 await assert.rejects(inspectPrivateBundle({entry:{appPath:app,source:a},privateRoot:root,repository:root,platform:'win32',arch:'x64',asar,run}),/Packaged runtime differs from source/);
});

test('protected main observation never serializes a malformed credential or provider error plaintext',async()=>{
 // Execute the actual serialized evaluate function against inert boundary
 // fixtures. No real provider, application or protected OS storage is opened.
 const {protectedSummary}=await import('../scripts/e2e-packaged-identity-continuity.mjs');
 const secret='private-bearer-must-never-cross-evaluate',dataPath='/fixture/profile',install='/fixture/ReviewOps.app';
 for(const failure of ['malformed','provider-error']){
  const provider={publicCertificate:()=>({}),state:()=>({backend:'macos-default-file-keychain'}),
   openCredential:async()=>{if(failure==='provider-error')throw new Error(secret);return secret;}};
  const fakeRequire=name=>{
   if(name==='node:fs')return{readFileSync:()=>JSON.stringify({hosts:[{id:'fixture-connection',ciphertext:'fixture-only-ciphertext',certificateFingerprint:sha}]}),
    writeFileSync(){assert.fail('Malformed credentials must not write a checkpoint');}};
   if(name.endsWith('/electron/remote-device-identity.cjs'))return{createRemoteDeviceIdentity:()=>provider};
   return require(name);
  };
  const observe=vm.runInNewContext('('+protectedSummary.toString()+')',{Buffer,process:{platform:'darwin',getBuiltinModule:name=>fakeRequire('node:'+name),mainModule:{require:fakeRequire}}});
  const app={isPackaged:true,getPath:name=>name==='userData'?dataPath:path.posix.join(install,'Contents/MacOS/ReviewOps'),getAppPath:()=>path.posix.join(install,'Contents/Resources/app.asar')};
  await assert.rejects(observe({app},{dataPath,install,phase:'baseline-enrollment',connectionId:'fixture-connection'}),error=>{
   assert.equal(error.code,'PROTECTED_CONTINUITY_REFUSED');
   assert.equal(error.message,'Protected identity continuity check was refused.');
   assert.equal(JSON.stringify({message:error.message,stack:error.stack,...error}).includes(secret),false);
   assert.equal(Object.hasOwn(error,'cause'),false);return true;
  });
 }
});

test('packaged runtime observation uses the original main loader without a global require and sanitizes loader failures',async()=>{
 const {packagedRuntimeIdentity}=await import('../scripts/e2e-packaged-identity-continuity.mjs');
 const appPath='/fixture/ReviewOps.app/Contents/Resources/app.asar',executable='/fixture/ReviewOps.app/Contents/MacOS/ReviewOps';
 const build={channel:'test',version:'1.5.0',buildNumber:1001,commit:a,builtAt:'2026-11-07T00:00:00.000Z'};
 for(const denied of [false,true]){
  const observe=vm.runInNewContext('('+packagedRuntimeIdentity.toString()+')',{process:{platform:'darwin',pid:123,ppid:456,mainModule:{require(name){
   assert.equal(name,appPath+'/electron/build-info.cjs');if(denied)throw new Error('private-loader-diagnostic');
   return{getBuildInfo:version=>{assert.equal(version,'1.5.0');return build;}};
  }}}});
  const app={isPackaged:true,getPath:()=>executable,getAppPath:()=>appPath,getVersion:()=>'1.5.0'};
  if(denied)assert.throws(()=>observe({app}),error=>error.code==='PACKAGED_RUNTIME_UNAVAILABLE'&&!error.stack.includes('private-loader-diagnostic'));
  else assert.equal(JSON.stringify(observe({app})),JSON.stringify({platform:'darwin',pid:123,ppid:456,packaged:true,executable,appPath,build}));
 }
});

test('native private paths satisfy the production socket budget before any application launch',async t=>{
 const {createPrivatePaths}=await import('../scripts/native-adapters.mjs');
 const paths=createPrivatePaths(path.resolve(__dirname,'..'));t.after(()=>fs.rmSync(paths.root,{recursive:true,force:true}));
 assert.equal(paths.socketPreflight.productionHelper,true);
 if(process.platform==='darwin'){
  assert.ok(paths.root.startsWith('/private/tmp/ro-owned-ui-'));
  assert.ok(paths.socketPreflight.bytes<=103);
 }
 assert.equal(fs.existsSync(path.join(paths.data,'remote-device-identity')),false,'Path admission never enrolls an identity');
});

function inertWindowsObserver(observeWindowsOriginalMain){
 const child=new EventEmitter();Object.assign(child,{pid:9001,stdout:new PassThrough(),stderr:new PassThrough()});
 const identity={platform:'win32',expectedPlatform:'win32',pid:123,ppid:456,childPID:456},executable='C:\\Private\\ReviewOps\\ReviewOps.exe';
 const observed=observeWindowsOriginalMain({identity,executable,systemRoot:'C:\\Windows',spawnProcess(command,args,options){
  assert.equal(command,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(options.env.REVIEWOPS_CONTINUITY_PID,'123');assert.equal(options.env.REVIEWOPS_CONTINUITY_EXE,executable);
  assert.equal(options.stdio[0],'ignore');return child;
 }});
 return{child,observed,bound:{kind:'bound',pid:123,startTicks:'639292016556627985',executable},
  emit:row=>child.stdout.write(JSON.stringify(row)+'\r\n')};
}
test('Windows original main proof retains birth identity and waits for main exit plus observer closure',async()=>{
 const {observeWindowsOriginalMain}=await helper,{child,observed,bound,emit}=inertWindowsObserver(observeWindowsOriginalMain);
 emit(bound);assert.deepEqual(await observed.bound,bound);
 let settled=false;observed.exited.then(()=>{settled=true;});
 child.emit('exit',0,null);await new Promise(setImmediate);assert.equal(settled,false,'A shell/observer exit alone cannot certify main exit');
 emit({kind:'exited',pid:123,startTicks:bound.startTicks,exitCode:0});
 await new Promise(setImmediate);assert.equal(settled,false,'The original observer must also close normally');
 child.emit('close',0,null);
 assert.deepEqual(await observed.exited,{kind:'exited',pid:123,startTicks:bound.startTicks,exitCode:0,observerPID:9001,observerExit:{code:0,signal:null}});
});
test('Windows main lifetime refuses PID reuse, missing exit proof and direct-shell identity',async()=>{
 const {observeWindowsOriginalMain}=await helper;
 for(const mode of ['different-birth','missing-exit']){
  const {child,observed,bound,emit}=inertWindowsObserver(observeWindowsOriginalMain);emit(bound);await observed.bound;
  if(mode==='different-birth')emit({kind:'exited',pid:123,startTicks:'639292016556627986',exitCode:0});
  child.emit('close',0,null);await assert.rejects(observed.exited,error=>error.code==='ORIGINAL_MAIN_UNCONFIRMED');
 }
 assert.throws(()=>observeWindowsOriginalMain({identity:{platform:'win32',expectedPlatform:'win32',pid:456,ppid:789,childPID:456},
  executable:'C:\\Private\\ReviewOps.exe',systemRoot:'C:\\Windows',spawnProcess(){assert.fail('An unbound main must never start an observer');}}));
});
