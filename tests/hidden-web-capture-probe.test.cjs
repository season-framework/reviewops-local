'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {BRANCH,CASES,CAPTURE_TIMEOUT_MS,HIDDEN_SETTLE_MS,CHILD_TIMEOUT_MS,GEOMETRY,hostedOnly,validateConfig,childEnvironment,sourcePreserved,geometryPreserved}=require('../scripts/hidden-web-capture-probe-common.cjs');

test('native execution refuses local, self-hosted, foreign-repository and unrelated-branch contexts',()=>{
  const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'season-framework/reviewops-local',GITHUB_REF:`refs/heads/${BRANCH}`,GITHUB_EVENT_NAME:'push',REVIEWOPS_HOSTED_CAPTURE_PROBE:'1'};
  assert.doesNotThrow(()=>hostedOnly(env,'win32','x64'));assert.doesNotThrow(()=>hostedOnly(env,'darwin','x64'));
  for(const patch of [{GITHUB_ACTIONS:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_REPOSITORY:'other/repository'},{GITHUB_REF:'refs/heads/main'},{REVIEWOPS_HOSTED_CAPTURE_PROBE:'0'}])assert.throws(()=>hostedOnly({...env,...patch},'win32','x64'),/GitHub-hosted/);
  const manual={...env,GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',REVIEWOPS_MANUAL_CAPTURE_PROBE:'1'};
  assert.doesNotThrow(()=>hostedOnly(manual,'win32','x64'));
  for(const patch of [{GITHUB_EVENT_NAME:'push'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REF:'refs/heads/unreviewed'},{REVIEWOPS_MANUAL_CAPTURE_PROBE:'0'},{REVIEWOPS_MANUAL_CAPTURE_PROBE:undefined}])assert.throws(()=>hostedOnly({...manual,...patch},'win32','x64'));
  assert.throws(()=>hostedOnly(env,'darwin','arm64'));assert.throws(()=>hostedOnly(env,'linux','x64'));
});

test('owned case configuration rejects path escapes and non-enumerated actions',()=>{
  const runDirectory=path.resolve('/tmp/rvhcap-synthetic'),value={id:'native-hidden',runDirectory,profile:path.join(runDirectory,'case/profile'),result:path.join(runDirectory,'case/result.json')};
  assert.equal(validateConfig(value).id,'native-hidden');
  for(const patch of [{id:'arbitrary-script'},{profile:path.resolve('/outside')},{result:path.join(runDirectory,'../outside.json')},{runDirectory:path.resolve('/tmp/user-profile')}])assert.throws(()=>validateConfig({...value,...patch}));
});

test('child environment excludes secrets, agents, application settings and Electron injection',()=>{
  const profile=path.resolve('/tmp/rvhcap-profile'),result=childEnvironment({PATH:'/safe/path',SystemRoot:'C:\\Windows',GITHUB_ACTIONS:'true',OPENAI_API_KEY:'private',GITHUB_TOKEN:'private',SSH_AUTH_SOCK:'private',NODE_OPTIONS:'--require private',ELECTRON_RUN_AS_NODE:'1',REVIEWOPS_DATA_DIR:'/user-data',HOME:'/user-home'},profile);
  assert.equal(result.PATH,'/safe/path');assert.equal(result.HOME,profile);assert.equal(result.USERPROFILE,profile);
  for(const key of ['OPENAI_API_KEY','GITHUB_TOKEN','SSH_AUTH_SOCK','NODE_OPTIONS','ELECTRON_RUN_AS_NODE','REVIEWOPS_DATA_DIR'])assert.equal(result[key],undefined);
});

test('matrix separates independent native and CDP options with a bounded optional temporary case',()=>{
  assert.equal(new Set(CASES.map(value=>value.id)).size,8);assert.deepEqual(CASES.slice(0,5).map(value=>value.id),['native-hidden','native-default','native-unthrottled','cdp-surface','cdp-view']);
  assert.deepEqual(CASES[0].options,{stayHidden:true});assert.equal(CASES[1].options,null);assert.equal(CASES[2].backgroundThrottling,false);assert.equal(CASES[7].requires,CASES[2].id);assert.equal(CASES[7].temporaryUnthrottled,true);
  assert.deepEqual(CASES.filter(value=>value.focusEmulated).map(value=>value.id),['native-hidden-focus-emulated','native-default-focus-emulated']);assert.ok(CASES.length*CHILD_TIMEOUT_MS<6*60*1000);
  assert.equal(CAPTURE_TIMEOUT_MS,5000);assert.equal(HIDDEN_SETTLE_MS,5000);assert.ok(CHILD_TIMEOUT_MS<=35000);assert.ok(CHILD_TIMEOUT_MS>CAPTURE_TIMEOUT_MS*2+HIDDEN_SETTLE_MS+6000);assert.equal(GEOMETRY.scale,310/1200);
});

test('source and geometry proofs reject replacement, navigation, form or request changes',()=>{
  const value={instance:'synthetic-instance',form:'unsaved',url:'http://127.0.0.1:1234/fixture',requests:1,webContentsId:3,innerWidth:1200,innerHeight:800,devicePixelRatio:1,viewBounds:{x:0,y:0,width:310,height:207},clipBounds:{x:50,y:50,width:310,height:207}};
  assert.ok(sourcePreserved(value,{...value,raf:999}));assert.ok(geometryPreserved(value,{...value}));
  assert.equal(sourcePreserved({},{}),false);assert.equal(geometryPreserved({},{}),false);
  for(const patch of [{instance:''},{form:''},{url:''},{requests:0},{webContentsId:0}])assert.equal(sourcePreserved({...value,...patch},{...value,...patch}),false);
  for(const patch of [{innerWidth:0},{innerHeight:Infinity},{devicePixelRatio:0},{viewBounds:{}},{clipBounds:{x:0,y:0,width:0,height:207}}])assert.equal(geometryPreserved({...value,...patch},{...value,...patch}),false);
  for(const [key,next] of Object.entries({instance:'replacement',form:'changed',url:'http://127.0.0.1:1234/new',requests:2,webContentsId:4}))assert.equal(sourcePreserved(value,{...value,[key]:next}),false);
  for(const [key,next] of Object.entries({innerWidth:500,innerHeight:500,devicePixelRatio:2,viewBounds:{width:1},clipBounds:{width:1}}))assert.equal(geometryPreserved(value,{...value,[key]:next}),false);
});

test('probe workflow is branch-restricted, read-only, native hosted, pinned and JSON-only',()=>{
  const file=fs.readFileSync(path.join(__dirname,'../.github/workflows/hidden-web-capture-probe.yml'),'utf8');
  assert.match(file,/push:\s+branches:\s+- codex\/hidden-web-capture-probe/);assert.match(file,/permissions:\s+contents: read/);assert.match(file,/timeout-minutes: 10/);assert.match(file,/runner: windows-latest/);assert.match(file,/runner: macos-15-intel/);assert.match(file,/node-version: '24'/);
  const uses=[...file.matchAll(/uses: ([^\n]+)/g)].map(match=>match[1]);assert.equal(uses.length,3);assert.ok(uses.every(value=>/@[a-f0-9]{40}(?:\s|$)/.test(value)));
  assert.match(file,/persist-credentials: false/);assert.match(file,/run: npm ci/);assert.match(file,/path: test-results\/hidden-web-capture-probe\/\*\.json/);
  assert.match(file,/timeout-minutes: 6/);
  assert.match(file,/workflow_dispatch:/);assert.match(file,/github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(file,/contents: write|actions: write|secrets\.|GITHUB_TOKEN|npm run build|test-release\.mjs|test-build\.mjs|release\/|--publish|reviewops-test-build-/);
});

test('standalone app records capture metadata and never loads the product or writes image bytes',()=>{
  const file=fs.readFileSync(path.join(__dirname,'../scripts/hidden-web-capture-probe-app.cjs'),'utf8');
  assert.doesNotMatch(file,/require\(['"]\.\/main\.cjs|desktopCapturer|captureStream|setPermissionRequestHandler\([^\n]+callback\(true\)|disableHardwareAcceleration|appendSwitch|\.png['"]|console\.log/);
  assert.match(file,/clip\.hide\(\)/);assert.match(file,/window\.setProbePhase\(\\"hidden\\"\)|window\.setProbePhase\("hidden"\)/);assert.match(file,/sourcePreserved\(report\.sourceBefore,report\.sourceAfter\)/);assert.match(file,/geometryPreserved\(report\.sourceBefore,report\.sourceAfter\)/);assert.match(file,/setBackgroundThrottling\(testCase\.backgroundThrottling\)/);
});

test('watchdog verifies its child is still live before killing an owned process tree',()=>{
  const file=fs.readFileSync(path.join(__dirname,'../scripts/hidden-web-capture-probe.mjs'),'utf8');
  assert.ok(file.indexOf('if(child.exitCode!==null||child.signalCode!==null)')<file.indexOf("spawn('taskkill'"));
  assert.match(file,/if\(child\.exitCode===null&&child\.signalCode===null\)child\.kill/);assert.match(file,/process\.kill\(-child\.pid,'SIGKILL'\)/);
});
