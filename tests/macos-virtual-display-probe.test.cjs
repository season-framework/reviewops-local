const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const modulePromise=import('../experiments/macos-virtual-display/policy.mjs');
const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'macOS',GITHUB_REPOSITORY:'season-framework/reviewops-local',GITHUB_REF:'refs/heads/codex/macos-virtual-display-prototype',GITHUB_EVENT_NAME:'push',GITHUB_SHA:'a'.repeat(40)};
test('lifecycle refuses local/self-hosted/other-branch/PR/repository and incomplete runner contexts',async()=>{
 const {executionRefusal}=await modulePromise;
 assert.ok(executionRefusal({},'darwin','x64'));
 for(const key of Object.keys(env)){const altered={...env};delete altered[key];assert.ok(executionRefusal(altered,'darwin','x64'),key)}
 for(const [key,value] of Object.entries({RUNNER_ENVIRONMENT:'self-hosted',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:'other/repo'}))assert.ok(executionRefusal({...env,[key]:value},'darwin','arm64'));
 assert.equal(executionRefusal(env,'darwin','x64'),null);assert.equal(executionRefusal(env,'darwin','arm64'),null);assert.ok(executionRefusal(env,'linux','x64'));
});
test('caught Objective-C failure releases the owned strong parameter before cleanup',{
 skip:process.platform!=='darwin'?'Foundation lifetime regression requires macOS; no display APIs':false,
 timeout:75000
},async()=>{
 const {objectiveCOwnershipFlags}=await modulePromise;
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-owned-unwind-'));
 try{
  const binary=path.join(temporary,'helper');
  const built=spawnSync('xcrun',['clang','-O0',...objectiveCOwnershipFlags,'-fmodules','-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/macos-display-owned-unwind.m'),'-framework','Foundation','-o',binary],{encoding:'utf8',timeout:60000,maxBuffer:64*1024});
  assert.equal(built.status,0,built.stderr||built.error?.message);
  const ran=spawnSync(binary,[],{encoding:'utf8',timeout:3000,maxBuffer:4096});
  assert.equal(ran.status,0,ran.stderr||ran.error?.message);
  const observed=JSON.parse(ran.stdout);assert.equal(observed.caught,true);
  assert.equal(observed.deallocationsBeforePoolExit,1,'helper flags must release the real NSObject before cleanup');
 }finally{fs.rmSync(temporary,{recursive:true,force:true})}
});
const baseline={id:1,bounds:{x:0,y:0,width:1280,height:800},online:true,active:true,modeWidth:1280,modeHeight:800};
const owned={id:2,bounds:{x:1280,y:0,width:1920,height:1080},online:true,active:true,mirrored:false,modeAvailable:true,modeWidth:1920,modeHeight:1080,pixelWidth:1920,pixelHeight:1080,vendor:505,serial:77};
// Native JSON snapshots contain independent records, not shared object aliases.
const fixture=()=>JSON.parse(JSON.stringify({source:'a'.repeat(40),runId:'11111111-1111-4111-8111-111111111111',outcome:'passed',createdDisplays:1,settingsApplyCalls:1,ownedDisplayId:2,ownedModeSetCalls:0,requestedIdentity:{vendor:505,serial:77},before:[baseline],during:[baseline,owned],afterWindow:[baseline,owned],after:[baseline],cleanupVerified:true,windowPlacement:{verified:true,observedScreenId:2,windowNumber:42},capturedFrames:0,injectedInputs:0,requestedPermissions:0,topologyDiagnostics:{registered:true,stopped:true,completeAtCutoff:true,reserved:1,ready:1}}));
test('existing display inventory detects identity, bounds and mode changes without restoring anything',async()=>{
 const {inventoryDifference}=await modulePromise;
 assert.equal(inventoryDifference([baseline],[owned,baseline],2),null);
 assert.ok(inventoryDifference([baseline],[]));
 assert.ok(inventoryDifference([baseline],[{...baseline,bounds:{...baseline.bounds,x:30}}]));
 assert.ok(inventoryDifference([baseline],[{...baseline,modeWidth:640}]));
 assert.ok(inventoryDifference([baseline],[baseline,owned]));
});
test('only one actual new online mode plus unchanged existing displays and verified cleanup/window can pass',async()=>{
 const {verifyNativeResult}=await modulePromise;
 assert.equal(verifyNativeResult(fixture()),null);
 for(const outcome of ['unsupported','compile-only','not-run','failed','refused'])assert.ok(verifyNativeResult({...fixture(),outcome}));
 for(const change of [x=>x.code='PREEXISTING_CHANGED',x=>x.primaryCode='PREEXISTING_CHANGED',x=>x.cleanupCode='CLEANUP_FAILED',x=>x.observerCode='REMOVE_FAILED',x=>x.outputCode='NATIVE_OUTPUT_FAILED',x=>x.diagnosticCode='TRACE_OUTPUT_FAILED',x=>x.topologyDiagnostics.completeAtCutoff=false,x=>x.topologyDiagnostics.ready=0,x=>x.topologyDiagnostics.registered=false,x=>x.createdDisplays=0,x=>x.settingsApplyCalls=2,x=>x.ownedDisplayId=1,x=>x.during=[],x=>x.during[1].modeWidth=1,x=>x.during[1].modeAvailable=false,x=>x.during[1].modeWidth=null,x=>x.during[1].pixelHeight=2160,x=>x.during[1].serial=78,x=>x.during[1].mirrored=true,x=>x.ownedModeSetCalls=2,x=>x.ownedModeSetCalls=1,x=>x.during[0].bounds.x=20,x=>x.afterWindow[0].bounds.x=20,x=>x.after.push(owned),x=>x.cleanupVerified=false,x=>x.windowPlacement.verified=false,x=>x.windowPlacement.observedScreenId=9,x=>x.windowPlacement.windowNumber=0,x=>x.capturedFrames=1,x=>x.injectedInputs=1,x=>x.requestedPermissions=1]){const x=fixture();change(x);assert.ok(verifyNativeResult(x))}
});

test('a separate correlated topology artifact must be complete and cannot mask lifecycle failure',async()=>{
 const {verifyTopologyTrace}=await modulePromise;
 const traceFor=native=>({schema:1,source:native.source,runId:native.runId,registrationError:0,removalError:0,completeAtCutoff:true,inFlightAtSnapshot:0,overflow:false,clockFailed:false,reserved:1,ready:1,events:[[1,'2',2,16,4]],stages:['baseline-first','baseline-confirmed','before-init','after-init','before-apply','after-apply','after-window'].map((stage,index)=>({stage,preexistingMatches:true,query:{startNS:'1',endNS:'2',sequenceBefore:0,sequenceAfter:1,objectIDBefore:index<3?0:2,objectIDAfter:index<3?0:2}}))});
 const native=fixture();assert.equal(verifyTopologyTrace(traceFor(native),native),null);
 for(const alter of [x=>x.source='b'.repeat(40),x=>x.runId='foreign',x=>x.rawReportOmitted=true,x=>x.registrationError=1,x=>x.removalError=1,x=>x.failureCode='FAILED',x=>x.inFlightAtSnapshot=1,x=>x.overflow=true,x=>x.clockFailed=true,x=>x.ready=0,x=>x.events=[],x=>x.events[0][0]=2,x=>x.events[0][1]='18446744073709551616',x=>x.events[0][3]=-1,x=>x.stages.pop(),x=>x.stages[3].query.objectIDAfter=1,x=>x.stages[4].preexistingMatches=false,x=>x.stages[4].query.sequenceAfter=2]){
  const value=traceFor(native);alter(value);assert.ok(verifyTopologyTrace(value,native));
 }
});

test('pure C callback storage handles concurrency, reentrancy, stop and overflow without display calls',{
 skip:process.platform!=='darwin'?'macOS compiler fixture only; no display APIs':false,timeout:75000
},t=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-topology-c-'));
 try{
  const binary=path.join(temporary,'fixture');
  const built=spawnSync('xcrun',['clang','-std=c11','-pthread','-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/macos-topology-trace.c'),'-o',binary],{encoding:'utf8',timeout:60000,maxBuffer:64*1024});
  assert.equal(built.status,0,built.stderr||built.error?.message);
  const ran=spawnSync(binary,[],{encoding:'utf8',timeout:5000,maxBuffer:4096});assert.equal(ran.status,0,ran.stderr||ran.error?.message);
  const value=JSON.parse(ran.stdout);assert.equal(value.ok,true);assert.equal(value.checks,7);assert.equal(value.displayCalls,0);
  t.diagnostic(JSON.stringify({fixture:'pure-C',...value}));
 }finally{fs.rmSync(temporary,{recursive:true,force:true})}
});

test('Foundation-only worst-case JSON fits budgets and output failures preserve primary failure',{
 skip:process.platform!=='darwin'?'Foundation JSON fixture only; no display APIs':false,timeout:75000
},async t=>{
 const {objectiveCOwnershipFlags}=await modulePromise;
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-topology-json-'));
 try{
  const binary=path.join(temporary,'fixture');
  const built=spawnSync('xcrun',['clang',...objectiveCOwnershipFlags,'-fmodules','-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/macos-topology-json.m'),'-framework','Foundation','-o',binary],{encoding:'utf8',timeout:60000,maxBuffer:64*1024});
  assert.equal(built.status,0,built.stderr||built.error?.message);
  const ran=spawnSync(binary,[temporary],{encoding:'utf8',timeout:5000,maxBuffer:4096});assert.equal(ran.status,0,ran.stderr||ran.error?.message);
  const value=JSON.parse(ran.stdout);assert.equal(value.ok,true);assert.equal(value.checks,6);assert.equal(value.displayCalls,0);assert.ok(value.nativeBytes<=128*1024);assert.ok(value.traceBytes<=32*1024);
  t.diagnostic(JSON.stringify({fixture:'Foundation-only',...value}));
  const {encodeProbeJSON}=await modulePromise;
  const native=JSON.parse(fs.readFileSync(path.join(temporary,'native.json'),'utf8'));
  const wrapped={schema:1,outcome:'failed',code:native.code,native,postProcess:{displays:native.before},topologyArtifact:{file:'reconfiguration.json',source:native.source,reserved:128,ready:128,completeAtCutoff:true}};
  const encoded=encodeProbeJSON(wrapped);assert.equal(encoded.ok,true);assert.ok(Buffer.byteLength(encoded.bytes)<=128*1024);
  t.diagnostic(JSON.stringify({fixture:'launcher-wrapper',bytes:Buffer.byteLength(encoded.bytes)}));
  const overflow=encodeProbeJSON({...wrapped,code:'FIRST_NATIVE_FAILURE',oversized:'x'.repeat(128*1024)});assert.equal(overflow.ok,false);assert.equal(JSON.parse(overflow.bytes).code,'FIRST_NATIVE_FAILURE');assert.equal(JSON.parse(overflow.bytes).rawReportOmitted,true);
  const cycle={outcome:'failed',code:'ORIGINAL'};cycle.self=cycle;const invalid=encodeProbeJSON(cycle);assert.equal(invalid.ok,false);assert.equal(JSON.parse(invalid.bytes).code,'ORIGINAL');
  const successful={outcome:'passed',code:'ONE_OWNED_DISPLAY_CREATED_VALIDATED_REMOVED',oversized:'x'.repeat(128*1024)};
  const failedOutput=encodeProbeJSON(successful);assert.equal(failedOutput.ok,false);assert.equal(JSON.parse(failedOutput.bytes).code,'LAUNCHER_JSON_BUDGET_EXCEEDED');assert.equal(JSON.parse(failedOutput.bytes).outcome,'failed');
  const compileOnly={outcome:'compile-only',code:'NO_DISPLAY_LIFECYCLE_EXECUTED'};compileOnly.self=compileOnly;
  assert.equal(JSON.parse(encodeProbeJSON(compileOnly).bytes).code,'LAUNCHER_JSON_ENCODING_FAILED');
 }finally{fs.rmSync(temporary,{recursive:true,force:true})}
});
