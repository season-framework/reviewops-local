import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCE,BUILD,assertBinding,assertWitness,assertCheckpoint,assertDeniedObservation,assertOriginalClosure,changePermission,hasFreshFolderCommand,guestScript} from '../scripts/diagnostics/installed-linux-permission-ui.mjs';

// Inert plain records only. No filesystem fixture, app, SSH, key, or subprocess.
const digest='a'.repeat(64),commit='b'.repeat(40),pin=path=>({path,bytes:10,sha256:digest});
const guest={host:'127.0.0.1',port:2244,username:'permission',home:'/home/permission',codeHome:'/home/permission/.codex',privateKeyPin:pin('/private/tmp/r34/key'),hostKeyFingerprint:'SHA256:'+'a'.repeat(43),identity:{bootId:'12345678-1234-1234-1234-123456789abc',uid:1001,euid:1001,kernel:'linux-test',machine:'x86_64'},leaf:{path:'/home/permission/owned/leaf',dev:8,ino:123,uid:1001},genuineCLI:{path:'/home/permission/bin/codex-real',bytes:100,sha256:digest,version:'codex-cli 0.166.0'},witness:{path:'/home/permission/bin/codex-witness',bytes:100,sha256:digest,logPath:'/home/permission/owned/entries.jsonl'}};
function binding(){return {schema:1,phase:'ui',scenario:'installed-linux-permission',source:SOURCE,build:{...BUILD},harnessSource:commit,sourceGuard:{productSource:SOURCE,harnessSource:commit,baselineFiles:429,existingFilesUnchanged:true},preparedSupplyPin:pin('/tmp/proof/supply'),preparedRootAcceptancePin:pin('/tmp/proof/prepared'),guestRootAcceptancePin:pin('/tmp/proof/guest'),sourceGuardRootPin:pin('/tmp/proof/source'),packageZipPin:{path:'/tmp/package.zip',bytes:133831763,sha256:'2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead'},expectedASARPin:pin('/private/tmp/r34/Applications/ReviewOps.app/Contents/Resources/app.asar'),executablePin:pin('/private/tmp/r34/Applications/ReviewOps.app/Contents/MacOS/ReviewOps'),actualNodeIdentity:{...pin('/tmp/node'),version:'24.22.2'},driverPin:pin('/tmp/source/driver.mjs'),root:'/tmp/repository',privateRoot:'/private/tmp/r34',home:'/private/tmp/r34/home',codeHome:'/private/tmp/r34/home/.codex',dataDir:'/private/tmp/r34/data',sshConfig:'/private/tmp/r34/home/.ssh/config',packageApp:'/private/tmp/r34/Applications/ReviewOps.app',output:'/tmp/repository/test-results/installed-linux-permission-ui/once',claimPath:'/private/tmp/r34/installed-linux-permission-ui-once.json',guest:structuredClone(guest),allowNormalMetadata:true,maximumAppLaunches:1,newFormalQAIDs:0,vmLifecycleOwnedByOuterController:true,dependencyPins:[pin('/tmp/playwright'),pin('/tmp/ssh2')]};}
const host={platform:'darwin',arch:'arm64',node:'24.22.2',electron:undefined,uid:501,euid:501,ci:'true',actions:'true',event:'workflow_dispatch',attempt:1,runId:123,githubSHA:commit};
const entry={args:['--version'],cwd:guest.leaf.path,uid:1001,home:guest.home,codeHome:guest.codeHome,forbiddenEnvironmentNames:[]};
function checkpoint(mode=0o700){return {platform:'Linux',identity:{...guest.identity},home:guest.home,codeHome:guest.codeHome,leaf:{...guest.leaf,mode},genuineCLI:{path:guest.genuineCLI.path,bytes:100,sha256:digest},witness:{path:guest.witness.path,bytes:100,sha256:digest},entries:[structuredClone(entry)],authAbsent:true};}

test('UI admission requires the actual packaged cohort and separate supply/guest authority',()=>{
 assert.doesNotThrow(()=>assertBinding(binding(),host));
 for(const change of [{platform:'linux'},{arch:'x64'},{uid:0},{euid:0},{node:'22.0.0'},{ci:'false'},{event:'push'},{attempt:2},{githubSHA:'c'.repeat(40)}])assert.throws(()=>assertBinding(binding(),{...host,...change}));
 for(const key of ['preparedSupplyPin','preparedRootAcceptancePin','guestRootAcceptancePin','sourceGuardRootPin','expectedASARPin']){const b=binding();b[key]=null;assert.throws(()=>assertBinding(b,host));}
 for(const patch of [{source:'c'.repeat(40)},{phase:'prepare'},{maximumAppLaunches:2},{newFormalQAIDs:1},{vmLifecycleOwnedByOuterController:false}])assert.throws(()=>assertBinding({...binding(),...patch},host));
});
test('guest admission rejects root, a foreign endpoint, reused home, and an unbound binary',()=>{
 const largest=binding();largest.guest.genuineCLI.bytes=512*1024**2;assert.doesNotThrow(()=>assertBinding(largest,host));
 for(const modify of [g=>{g.host='192.0.2.1';},g=>{g.identity.uid=0;},g=>{g.identity.euid=0;},g=>{g.home='/Users/real';},g=>{g.codeHome='/root/.codex';},g=>{g.leaf.uid=0;},g=>{g.genuineCLI.sha256=null;},g=>{g.witness.logPath=g.leaf.path+'/entries';},g=>{g.privateKeyPin.path='/Users/real/.ssh/id_ed25519';}]){const b=binding();modify(b.guest);assert.throws(()=>assertBinding(b,host));}
});
test('a stale phase panel or background root command cannot substitute for the clicked folder query',()=>{
 const old={commands:[{command:'old '+guest.leaf.path}]};assert.equal(hasFreshFolderCommand(old,old,guest.leaf.path),false);
 assert.equal(hasFreshFolderCommand(old,{commands:[...old.commands,{command:"cd -- '/'"}]},guest.leaf.path),false);
 assert.equal(hasFreshFolderCommand(old,{commands:[...old.commands,{command:'new '+guest.leaf.path,closed:false}]},guest.leaf.path),true);
});
test('phase checkpoints cannot relabel another guest, inode, mode, credential state or ELF',()=>{
 assert.doesNotThrow(()=>assertCheckpoint(checkpoint(),guest,0o700));assert.doesNotThrow(()=>assertCheckpoint(checkpoint(0),guest,0));
 for(const modify of [v=>{v.platform='Darwin';},v=>{v.identity.bootId='changed';},v=>{v.leaf.ino++;},v=>{v.leaf.mode=0;},v=>{v.genuineCLI.sha256='b'.repeat(64);},v=>{v.authAbsent=false;},v=>{v.entries[0].codeHome='/root/.codex';},v=>{v.entries[0].forbiddenEnvironmentNames=['OPENAI_API_KEY'];}]){const v=checkpoint();modify(v);assert.throws(()=>assertCheckpoint(v,guest,0o700));}
});
test('the witness permits metadata but rejects a generation or login mutation',()=>{
 for(const args of [['--version'],['login','status'],['app-server']])assert.doesNotThrow(()=>assertWitness([{...entry,args}]));
 for(const args of [['exec','prompt'],['login'],['logout'],['app-server','extra']])assert.throws(()=>assertWitness([{...entry,args}]));
});
test('actual folder denial needs both closed streams, manual UI and zero additional entries',()=>{
 const v={closed:true,stdoutEOF:true,stderrEOF:true,code:125,signal:null,stderr:'bash: cd: Permission denied\nSSH 계정으로 에이전트 작업 폴더를 열 수 없습니다.',UIText:'Codex 설치 미확인 로그인 미확인 Permission denied SSH 계정으로 에이전트 작업 폴더를 열 수 없습니다.',extraCLIEntries:0,buttonEnabled:true};
 assert.doesNotThrow(()=>assertDeniedObservation(v));
 for(const patch of [{closed:false},{stdoutEOF:false},{stderrEOF:false},{code:127},{signal:'TERM'},{extraCLIEntries:1},{buttonEnabled:false},{stderr:'No such file or directory'},{UIText:v.UIText+' Codex 설치 필요'},{UIText:'Permission denied'}])assert.throws(()=>assertDeniedObservation({...v,...patch}));
});
test('original app closure cannot be borrowed from an absent or live handle',()=>{
 const o={pid:42,applicationClosed:true,exitObserved:true,childClosed:true,exit:{code:0,signal:null},stdoutEOF:true,stderrEOF:true,stdoutClosed:true,stderrClosed:true};assert.doesNotThrow(()=>assertOriginalClosure(o));
 for(const patch of [{pid:undefined},{applicationClosed:false},{childClosed:false},{stdoutEOF:false},{stderrClosed:false},{exit:{code:1,signal:null}},{exit:{code:0,signal:'TERM'}}])assert.throws(()=>assertOriginalClosure({...o,...patch}));
});
test('guest controls are three explicit source-authored operations, never input shell text',()=>{
 assert.throws(()=>guestScript('shutdown',guest));assert.throws(()=>guestScript('chmod /outside',guest));
 for(const action of ['status','deny','restore']){const source=guestScript(action,guest);assert.ok(source.startsWith("python3 - <<'REVIEWOPS_OWNED_GUEST'"));assert.ok(source.includes('os.chmod(p,0 if'));assert.ok(source.includes('s.st_dev,s.st_ino,s.st_uid'));assert.ok(!source.includes('os.system(')&&!source.includes('subprocess'));}
});
test('a chmod that succeeds before later validation fails still requires verified restoration',async()=>{
 const state={confirmed:true,modeRestored:true};let actualMode=0o700,restores=0;
 await assert.rejects(changePermission(state,'deny',async()=>{actualMode=0;throw new Error('seal/JSON check failed after chmod');}),/after chmod/);
 assert.equal(actualMode,0);assert.equal(state.modeRestored,false);
 if(!state.modeRestored)await changePermission(state,'restore',async()=>{restores++;actualMode=0o700;assert.equal(actualMode,0o700);return {verified:true};});
 assert.equal(restores,1);assert.equal(state.modeRestored,true);
 state.modeRestored=false;await assert.rejects(changePermission(state,'restore',async()=>{actualMode=0o700;throw new Error('restore checkpoint unknown');}),/unknown/);assert.equal(state.modeRestored,false);
});
