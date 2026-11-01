const test=require('node:test');
const assert=require('node:assert/strict');
const modulePromise=import('../experiments/macos-virtual-display/policy.mjs');
const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'macOS',GITHUB_REPOSITORY:'season-framework/reviewops-local',GITHUB_REF:'refs/heads/codex/macos-virtual-display-prototype',GITHUB_EVENT_NAME:'push',GITHUB_SHA:'a'.repeat(40)};
test('lifecycle refuses local/self-hosted/other-branch/PR/repository and incomplete runner contexts',async()=>{
 const {executionRefusal}=await modulePromise;
 assert.ok(executionRefusal({},'darwin','x64'));
 for(const key of Object.keys(env)){const altered={...env};delete altered[key];assert.ok(executionRefusal(altered,'darwin','x64'),key)}
 for(const [key,value] of Object.entries({RUNNER_ENVIRONMENT:'self-hosted',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:'other/repo'}))assert.ok(executionRefusal({...env,[key]:value},'darwin','arm64'));
 assert.equal(executionRefusal(env,'darwin','x64'),null);assert.equal(executionRefusal(env,'darwin','arm64'),null);assert.ok(executionRefusal(env,'linux','x64'));
});
const baseline={id:1,bounds:{x:0,y:0,width:1280,height:800},online:true,active:true,modeWidth:1280,modeHeight:800};
const owned={id:2,bounds:{x:1280,y:0,width:1920,height:1080},online:true,active:true,mirrored:false,modeAvailable:true,modeWidth:1920,modeHeight:1080,pixelWidth:1920,pixelHeight:1080,vendor:505,serial:77};
// Native JSON snapshots contain independent records, not shared object aliases.
const fixture=()=>JSON.parse(JSON.stringify({outcome:'passed',createdDisplays:1,ownedDisplayId:2,ownedModeSetCalls:0,requestedIdentity:{vendor:505,serial:77},before:[baseline],during:[baseline,owned],afterWindow:[baseline,owned],after:[baseline],cleanupVerified:true,windowPlacement:{verified:true,observedScreenId:2,windowNumber:42},capturedFrames:0,injectedInputs:0,requestedPermissions:0}));
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
 for(const change of [x=>x.code='PREEXISTING_CHANGED',x=>x.primaryCode='PREEXISTING_CHANGED',x=>x.cleanupCode='CLEANUP_FAILED',x=>x.createdDisplays=0,x=>x.ownedDisplayId=1,x=>x.during=[],x=>x.during[1].modeWidth=1,x=>x.during[1].modeAvailable=false,x=>x.during[1].modeWidth=null,x=>x.during[1].pixelHeight=2160,x=>x.during[1].serial=78,x=>x.during[1].mirrored=true,x=>x.ownedModeSetCalls=2,x=>x.ownedModeSetCalls=1,x=>x.during[0].bounds.x=20,x=>x.afterWindow[0].bounds.x=20,x=>x.after.push(owned),x=>x.cleanupVerified=false,x=>x.windowPlacement.verified=false,x=>x.windowPlacement.observedScreenId=9,x=>x.windowPlacement.windowNumber=0,x=>x.capturedFrames=1,x=>x.injectedInputs=1,x=>x.requestedPermissions=1]){const x=fixture();change(x);assert.ok(verifyNativeResult(x))}
});
