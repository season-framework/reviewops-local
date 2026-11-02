// Root-review draft. Import is inert; all execution is explicit in exported calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createPrivatePaths,privateEnvironment,requireNativeHost,fileHash} from './native-adapters.mjs';
import {verifyPackagedBundle,inventory,readBoundedJSON} from './packaged-bundle-guards.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const writeJSON=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2));return file;};
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
function clean(root,source){assert.equal(git(root,'rev-parse','HEAD'),source);assert.equal(git(root,'status','--porcelain'),'');}
function walk(root,base=root,rows=[]){for(const e of fs.readdirSync(base,{withFileTypes:true})){const p=path.join(base,e.name);if(e.isDirectory())walk(root,p,rows);else{assert.ok(e.isFile()&&!e.isSymbolicLink());rows.push({path:path.relative(root,p).split(path.sep).join('/'),sha256:fileHash(p)});}}return rows.sort((a,b)=>a.path.localeCompare(b.path));}
export function recordNativeRenderer({repository=process.cwd(),source,recordPath}={}){
 const root=fs.realpathSync(repository),target=process.platform+'-'+process.arch;requireNativeHost(target);clean(root,source);
 const files=walk(root,path.join(root,'dist'));assert.ok(files.length>0);assert.ok(files.every(x=>x.path.startsWith('dist/')));
 return writeJSON(recordPath||path.join(root,'test-results/owned-service-native',target,'renderer-build.json'),{source,ok:true,files,recordedAt:new Date().toISOString(),contract:'Call immediately after successful buildRenderer(generateLicenses:false) in the same reviewed CI step'});
}
export async function buildNativeRenderer(options){const root=fs.realpathSync(options.repository||process.cwd());clean(root,options.source);const {buildRenderer}=await import(path.join(root,'scripts/test-build.mjs'));await buildRenderer({generateLicenses:false});return recordNativeRenderer(options);}
export function verifyNativePacket(packet){
 const root=fs.realpathSync(packet.repository);requireNativeHost(packet.target);clean(root,packet.source);
 const expected=readBoundedJSON(packet.expectedFilesPath);assert.ok(expected.files.length>=20);
 for(const row of expected.files){assert.ok(!path.isAbsolute(row.path)&&!row.path.split(/[\\/]/).includes('..'));assert.equal(fileHash(path.join(root,row.path)),row.sha256,row.path);}
 const buildRecord=readBoundedJSON(packet.rendererBuildRecordPath);assert.equal(buildRecord.source,packet.source);assert.equal(buildRecord.ok,true);
 assert.deepEqual(walk(root,path.join(root,'dist')),buildRecord.files.slice().sort((a,b)=>a.path.localeCompare(b.path)));
 const bundle=packet.mode==='source'?null:verifyPackagedBundle({root,appPath:packet.appPath,privateInstallRoot:packet.privateInstallRoot,manifestPath:packet.bundleManifestPath,expectedHead:packet.source,expectedVersion:readBoundedJSON(path.join(root,'package.json')).version,buildFiles:buildRecord.files,sourceManifestSHA256:fileHash(packet.expectedFilesPath),rendererBuildRecordSHA256:fileHash(packet.rendererBuildRecordPath),asar:createRequire(path.join(root,'package.json'))('@electron/asar'),expectedTarget:packet.target,installReceiptPath:packet.installReceiptPath});
 return {source:packet.source,buildRecord,bundle};
}
export async function prepareNativePacket({repository=process.cwd(),target=process.platform+'-'+process.arch,mode='source',executablePath,privateInstallRoot,installReceipt,outputDir,rendererBuildRecord,build,gate='owned16',regressions=true}={}){
 requireNativeHost(target);assert.ok(['source','private-bundle','nsis-installed'].includes(mode));
 const root=fs.realpathSync(repository),source=git(root,'rev-parse','HEAD');clean(root,source);
 const paths=createPrivatePaths(root),dir=outputDir||path.join(root,'test-results/owned-service-native',target,mode,gate,new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(dir,{recursive:true});
 const tracked=execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
 const expectedFilesPath=writeJSON(path.join(dir,'source-files.json'),{source,files:tracked.map(name=>({path:name,sha256:fileHash(path.join(root,name))}))});
 const rendererBuildRecordPath=fs.realpathSync(rendererBuildRecord||path.join(root,'test-results/owned-service-native',target,'renderer-build.json'));
 const packet={schema:1,repository:root,target,source,mode,gate,ownedRoot:paths.root,outputDir:dir,resultPath:path.join(dir,'results.json'),expectedFilesPath,rendererBuildRecordPath};
 if(mode!=='source'){
  const suppliedExecutable=fs.realpathSync(executablePath);packet.appPath=target.startsWith('darwin-')?path.dirname(path.dirname(path.dirname(suppliedExecutable))):suppliedExecutable;if(target.startsWith('darwin-')){assert.equal(path.basename(suppliedExecutable),'ReviewOps');assert.equal(path.basename(path.dirname(suppliedExecutable)),'MacOS');assert.ok(packet.appPath.endsWith('.app'));}packet.privateInstallRoot=fs.realpathSync(privateInstallRoot);packet.installReceiptPath=installReceipt?fs.realpathSync(installReceipt):null;
  const appRoot=target.startsWith('darwin-')?packet.appPath:path.dirname(packet.appPath),resources=path.join(appRoot,...(target.startsWith('darwin-')?['Contents','Resources']:['resources'])),archive=path.join(resources,'app.asar');
  const asar=createRequire(path.join(root,'package.json'))('@electron/asar'),rows=inventory(appRoot),files=rows.filter(x=>x.kind==='file').map(({kind,...row})=>row),symlinks=rows.filter(x=>x.kind==='symlink').map(({kind,...row})=>row);
  const archiveEntries=asar.listPackage(archive).map(x=>x.replaceAll('\\','/').replace(/^\/+(?=.)/,'')).filter(x=>!asar.statFile(archive,path.join(...x.split('/'))).files).map(name=>{const bytes=asar.extractFile(archive,path.join(...name.split('/')));return{path:name,bytes:bytes.length,sha256:cryptoHash(bytes)};});
  const summary=file=>files.find(row=>row.path===path.relative(appRoot,file).split(path.sep).join('/'));
  const manifest={schema:1,source,version:readBoundedJSON(path.join(root,'package.json')).version,platform:process.platform,arch:process.arch,privateInstallRoot:packet.privateInstallRoot,appPath:packet.appPath,appRoot,sourceManifestSHA256:fileHash(expectedFilesPath),rendererBuildRecordSHA256:fileHash(rendererBuildRecordPath),files,symlinks,archiveEntries,asar:summary(archive),bootstrap:summary(path.join(resources,'owned-services/owned-node-bootstrap.cjs')),...(build?{build}:{})};
  packet.bundleManifestPath=writeJSON(path.join(dir,'bundle-manifest.json'),manifest);
 }
 verifyNativePacket(packet);const inputPath=writeJSON(path.join(dir,'inputs.json'),packet);
 const prepared={inputPath,ownedRoot:paths.root,resultPath:packet.resultPath,packet};
 if(regressions&&gate==='owned16'){
  prepared.regressionInputs={};for(const g of ['panel8','concurrent10']){const child=await prepareNativePacket({repository:root,target,mode,executablePath,privateInstallRoot,installReceipt,rendererBuildRecord:rendererBuildRecordPath,build,gate:g,regressions:false});prepared.regressionInputs[g]=child.inputPath;}
 }
 return prepared;
}
function cryptoHash(bytes){return createRequire(import.meta.url)('node:crypto').createHash('sha256').update(bytes).digest('hex');}
export function verifyReviewedGitFiles({repository,source,expectedFiles,files}){
 const root=fs.realpathSync(repository);assert.match(source,/^[a-f0-9]{40}$/);clean(root,source);
 return files.map(row=>{
  assert.ok(!path.isAbsolute(row.path)&&!row.path.split(/[\\/]/).includes('..'));
  const blob=execFileSync('git',['show',source+':'+row.path],{cwd:root,maxBuffer:8*1024*1024}),gitBlobSHA256=cryptoHash(blob);
  assert.equal(gitBlobSHA256,row.sha256,row.path+' reviewed Git blob');
  if(row.bytes!==undefined)assert.equal(blob.length,row.bytes,row.path+' reviewed Git blob size');
  const checkoutSHA256=fileHash(path.join(root,row.path)),expected=expectedFiles.find(value=>value.path===row.path);
  assert.ok(expected,row.path+' missing from complete checkout manifest');assert.equal(checkoutSHA256,expected.sha256,row.path+' actual checkout bytes');
  return {path:row.path,gitBlobSHA256,gitBlobBytes:blob.length,checkoutSHA256,checkoutBytes:fs.statSync(path.join(root,row.path)).size};
 });
}
export async function runObservedProcess(command,args,{cwd,env=process.env,input='',timeoutMs=180000,limit=8*1024*1024}={}){
 const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let bytes=0,overflow=false,timer;const stdout=[],stderr=[];
 const collect=rows=>chunk=>{bytes+=chunk.length;if(bytes<=limit)rows.push(chunk);else overflow=true;};child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));child.stdin.on('error',()=>{});child.stdin.end(input);
 const done=new Promise(resolve=>{child.once('error',error=>resolve({error:error.message,completed:false}));child.once('close',(code,signal)=>resolve({code,signal,completed:true}));});
 let outcome;try{outcome=await Promise.race([done,new Promise(resolve=>{timer=setTimeout(()=>resolve({completed:false,reason:'observation-timeout'}),timeoutMs);})]);}finally{clearTimeout(timer);}
 const value={...outcome,pid:child.pid,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),overflow,signalSent:false};
 if(!outcome.completed||overflow){if(!outcome.completed){child.unref();for(const stream of [child.stdin,child.stdout,child.stderr])stream?.unref?.();}throw Object.assign(new Error('Owned command observation incomplete; no signal sent'),{observation:value,preservePrivateRoot:true});}return value;
}
export async function prepareNativeAgentFixture({packet,agentSource,rpcSource}){
 verifyNativePacket(packet);const root=packet.ownedRoot; // never create another profile
 const home=path.join(root,'home'),bin=process.platform==='win32'?path.join(root,'bin'):path.join(home,'.local/bin'),agentScript=path.join(root,process.platform==='win32'?'fixture-agent.cjs':'fixture-codex'),rpcScript=path.join(root,'model-rpc.cjs');
 fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(path.join(packet.ownedRoot,'data/codex-manager'),{recursive:true});
 fs.writeFileSync(rpcScript,rpcSource);fs.writeFileSync(agentScript,(process.platform==='win32'?'':'#!'+process.execPath+'\n')+agentSource.replace('FIXTURE_ROOT',JSON.stringify(root)),{mode:0o755});
 const disabled=path.join(home,'no-user-runtime');writeJSON(path.join(root,'data/codex-manager/runtime.json'),{path:disabled});assert.ok(!fs.existsSync(disabled));
 let agentExecutable=agentScript;
 if(process.platform==='win32'){
  assert.equal(process.env.CI,'true','Native fixture compilation is hosted-only');
  const required=['prepare-windows-native-cli.mjs','native-cli/Program.cs','native-cli/OwnedFixture.csproj'];const sourceRows=[];
  for(const name of required){const file=path.join(here,name),relative=path.relative(packet.repository,file).split(path.sep).join('/');assert.ok(!relative.startsWith('..'));execFileSync('git',['ls-files','--error-unmatch',relative],{cwd:packet.repository,stdio:'ignore'});sourceRows.push({path:name,sha256:fileHash(file)});}
  const reviewed=writeJSON(path.join(root,'native-cli-reviewed-source.json'),{source:packet.source,files:sourceRows});
  const compiler=await runObservedProcess(process.execPath,[path.join(here,'prepare-windows-native-cli.mjs'),'--run','--source',packet.source,'--sdk-version','8.0.426','--dotnet',path.join(process.env.ProgramFiles,'dotnet/dotnet.exe'),'--private-root',root,'--node',fs.realpathSync(process.execPath),'--node-sha256',fileHash(process.execPath),'--agent-script',agentScript,'--agent-sha256',fileHash(agentScript),'--reviewed-draft-manifest',reviewed],{cwd:packet.repository,timeoutMs:240000});
  writeJSON(path.join(root,'native-cli-compiler-observation.json'),compiler);assert.equal(compiler.code,0,compiler.stderr);
  const compiled=readBoundedJSON(path.join(root,'native-cli-build.json'));assert.equal(compiled.source,packet.source);assert.equal(compiled.output.peMachine,'0x8664');for(const row of compiled.files)assert.equal(fileHash(path.join(bin,row.path)),row.sha256);
  agentExecutable=path.join(bin,'codex.exe');
  const version=await runObservedProcess(agentExecutable,['--version'],{cwd:root,timeoutMs:10000});assert.equal(version.code,0);assert.equal(version.stdout.trim(),'codex-cli 0.0.0-fixture');
  const messages=[{id:1,method:'initialize'},{id:2,method:'model/list'}],rpc=await runObservedProcess(agentExecutable,['app-server'],{cwd:root,input:messages.map(x=>JSON.stringify(x)+'\n').join(''),timeoutMs:10000});assert.equal(rpc.code,0,rpc.stderr);assert.deepEqual(rpc.stdout.trim().split('\n').map(x=>JSON.parse(x).id),[1,2]);
  if(packet.gate==='owned16'){fs.writeFileSync(path.join(root,'fail-native-preflight'),'intentional');const failed=await runObservedProcess(agentExecutable,['exec'],{cwd:root,input:'OWNED_AGENT:native-preflight',timeoutMs:10000});assert.equal(failed.code,17);writeJSON(path.join(root,'native-cli-preflight.json'),{version,rpc,failed,actualProductCancelTreeStillRequired:true});}else writeJSON(path.join(root,'native-cli-preflight.json'),{version,rpc,originalRegressionAgentSemantics:true,actualProductCancelTreeStillRequired:true});
 }else fs.writeFileSync(path.join(bin,'codex'),'#!'+process.execPath+'\n'+rpcSource,{mode:0o755});
 const p={root,home,data:path.join(root,'data'),temp:path.join(root,'tmp'),bin,ssh:path.join(home,'ssh-config')};fs.mkdirSync(p.temp,{recursive:true});
 const files=[agentScript,rpcScript,...(process.platform==='win32'?fs.readdirSync(bin).map(x=>path.join(bin,x)):[path.join(bin,'codex')])].map(file=>({path:file,sha256:fileHash(file)}));
 return {agentExecutable,agentScript,rpcScript,environment:privateEnvironment(p,fs.realpathSync(process.execPath)),files,launcherJournal:path.join(root,'launcher-journal')};
}
// Pure fixture correlation. Never select a PID by order, timing, or reuse history.
export function selectWindowsAgentIdentity(journals,observed,expected){
 const positive=value=>Number.isSafeInteger(value)&&value>0,ticks=value=>typeof value==='string'&&/^[1-9]\d*$/.test(value);
 const nonce=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
 assert.ok(Array.isArray(journals));assert.ok(positive(observed.pid)&&positive(observed.ppid)&&observed.pid!==observed.ppid);assert.ok(nonce(observed.launchNonce));
 assert.ok(Array.isArray(observed.argv)&&observed.argv.length>=2&&observed.argv.every(value=>typeof value==='string'));
 assert.ok(typeof observed.cwd==='string'&&observed.cwd.length>0);
 for(const key of ['nodeSHA256','agentSHA256','configSHA256'])assert.match(expected[key]||'',/^[0-9a-f]{64}$/);
 const matches=journals.flatMap(journal=>journal.records.filter(row=>row.phase==='node-child-start'&&row.launchNonce===observed.launchNonce&&row.nodeChildPid===observed.pid&&row.launcherPid===observed.ppid).map(row=>({journal,row})));
 assert.equal(matches.length,1,'Exact nonce/PID/parent mapping must be unambiguous');
 const {journal,row}=matches[0];assert.ok(ticks(row.launcherStartTicks)&&ticks(row.nodeStartTicks));
 assert.equal(journal.name,`launcher-${row.launcherPid}-${row.launcherStartTicks}.jsonl`);
 assert.equal(journal.records.filter(value=>value.phase==='node-child-start').length,1);
 const starts=journal.records.filter(value=>value.phase==='native-start');assert.equal(starts.length,1,'Native start must be unique in the same journal');const start=starts[0];
 assert.equal(start.launchNonce,observed.launchNonce);assert.equal(start.launcherPid,observed.ppid);assert.equal(start.launcherStartTicks,row.launcherStartTicks);
 assert.equal(start.launcherPath,expected.launcherPath);assert.equal(start.configSHA256,expected.configSHA256);
 assert.equal(row.nodeExecutable,expected.nodeExecutable);assert.equal(row.agentScript,expected.agentScript);
 assert.equal(row.nodeSHA256,expected.nodeSHA256);assert.equal(row.agentSHA256,expected.agentSHA256);
 assert.deepEqual(observed.argv.slice(0,2),[expected.nodeExecutable,expected.agentScript]);
 assert.deepEqual(row.args,observed.argv.slice(2));assert.deepEqual(start.args,row.args);assert.equal(row.cwd,observed.cwd);assert.equal(start.cwd,row.cwd);
 const exits=journal.records.filter(value=>value.phase==='node-child-exit');assert.ok(exits.length<=1);
 for(const exit of exits){assert.equal(exit.launchNonce,observed.launchNonce);assert.equal(exit.launcherPid,row.launcherPid);assert.equal(exit.launcherStartTicks,row.launcherStartTicks);assert.equal(exit.nodeChildPid,row.nodeChildPid);assert.equal(exit.nodeStartTicks,row.nodeStartTicks);assert.ok(Number.isInteger(exit.exitCode));}
 return {journal:journal.name,launcher:row,nativeStart:start,identities:[{pid:row.launcherPid,startTicks:row.launcherStartTicks},{pid:row.nodeChildPid,startTicks:row.nodeStartTicks}]};
}
export function assertWindowsIdentityStates(states,identities){
 assert.ok(Array.isArray(states));assert.equal(states.length,identities.length);
 assert.deepEqual(states.map(row=>({pid:row.pid,startTicks:row.requestedStartTicks})),identities);
 assert.ok(states.every(row=>row.originalRunning===false));
}
// Complete regular-file snapshots with a strict 16 MiB/file and 32 MiB/read budget.
// Dependency injection is only for inert I/O boundary tests; production uses fs.
export function readWindowsLauncherJournals(directory,io=fs){
 const names=io.readdirSync(directory);assert.ok(names.length<=512);let total=0;
 const same=(left,right)=>right.isFile()&&!right.isSymbolicLink()&&['dev','ino','size','mtimeMs','ctimeMs'].every(key=>right[key]===left[key]);
 return names.map(name=>{
  assert.match(name,/^launcher-\d+-\d+\.jsonl$/);const file=path.join(directory,name),before=io.lstatSync(file);
  assert.ok(before.isFile()&&!before.isSymbolicLink()&&Number.isSafeInteger(before.size)&&before.size>=0&&before.size<=16*1024**2);
  assert.ok(before.size<=32*1024**2-total,'Reject aggregate overflow before opening or reading the file');
  const fd=io.openSync(file,io.constants.O_RDONLY|(io.constants.O_NOFOLLOW||0));let raw;
  try{
   assert.ok(same(before,io.fstatSync(fd)),'Opened journal differs from the path snapshot');
   raw=Buffer.alloc(before.size);
   for(let offset=0;offset<raw.length;){const length=Math.min(64*1024,raw.length-offset),read=io.readSync(fd,raw,offset,length,offset);assert.equal(read,length,'Incomplete journal read; do not retry or omit bytes');offset+=read;}
   assert.ok(same(before,io.fstatSync(fd)),'Journal changed while reading');
   assert.ok(same(before,io.lstatSync(file)),'Journal path changed while reading');
  }finally{io.closeSync(fd);}
  total+=raw.length;
  // At exact budget boundaries, post-read FD/path stats prove the expected size;
  // an extra EOF probe would itself exceed the permitted byte-read budget.
  const text=raw.toString('utf8');assert.ok(text.endsWith('\n'),'Read the complete journal without omitting a partial row');
  return {name,records:text.slice(0,-1).split('\n').map(JSON.parse)};
 });
}
export async function verifyWindowsAgentExit(fixture,observed){
 if(process.platform!=='win32')return;
 const journals=readWindowsLauncherJournals(fixture.launcherJournal);
 const configFile=path.join(path.dirname(fixture.agentExecutable),'fixture-config.json'),config=readBoundedJSON(configFile);
 const snapshot=file=>{const rows=fixture.files.filter(row=>row.path===file);assert.equal(rows.length,1);assert.equal(fileHash(file),rows[0].sha256);return rows[0].sha256;};
 const expected={nodeExecutable:fs.realpathSync.native(process.execPath),agentScript:fs.realpathSync.native(fixture.agentScript),launcherPath:fs.realpathSync.native(fixture.agentExecutable),
  nodeSHA256:fileHash(process.execPath),agentSHA256:snapshot(fixture.agentScript),configSHA256:snapshot(configFile)};snapshot(fixture.agentExecutable);
 assert.equal(fs.realpathSync.native(config.nodeExecutable),expected.nodeExecutable);assert.equal(fs.realpathSync.native(config.agentScript),expected.agentScript);assert.equal(config.nodeSHA256,expected.nodeSHA256);assert.equal(config.agentSHA256,expected.agentSHA256);
 const selected=selectWindowsAgentIdentity(journals,observed,expected);
 const input=writeJSON(path.join(path.dirname(fixture.agentScript),'native-cli-identities-'+observed.launchNonce+'.json'),selected.identities);
 const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');const result=await runObservedProcess(ps,['-NoProfile','-NonInteractive','-File',path.join(here,'inspect-owned-identities.ps1'),'-InputManifest',input],{timeoutMs:10000});assert.equal(result.code,0,result.stderr);const states=JSON.parse(result.stdout);assertWindowsIdentityStates(states,selected.identities);return {...selected,states};
}
export async function verifyNativeFixtureCleanup({packet,fixture}){
 if(process.platform!=='win32')return {status:'not-applicable-platform-mechanism',nativePlatformCleanupStillRequired:true};
 const records=fs.readdirSync(fixture.launcherJournal).flatMap(name=>fs.readFileSync(path.join(fixture.launcherJournal,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)),identities=new Map();
 for(const row of records){if(row.phase==='native-start')identities.set(row.launcherPid+'/'+row.launcherStartTicks,{pid:row.launcherPid,startTicks:row.launcherStartTicks});if(row.phase==='node-child-start')identities.set(row.nodeChildPid+'/'+row.nodeStartTicks,{pid:row.nodeChildPid,startTicks:row.nodeStartTicks});}
 const all=[...identities.values()],observations=[],ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 for(let offset=0;offset<all.length;offset+=32){const input=writeJSON(path.join(packet.ownedRoot,'all-native-identities-'+offset+'.json'),all.slice(offset,offset+32));const read=await runObservedProcess(ps,['-NoProfile','-NonInteractive','-File',path.join(here,'inspect-owned-identities.ps1'),'-InputManifest',input],{timeoutMs:10000});assert.equal(read.code,0,read.stderr);const rows=JSON.parse(read.stdout);assert.equal(rows.length,all.slice(offset,offset+32).length);assert.ok(rows.every(row=>row.originalRunning===false));observations.push(...rows);}
 const proof={status:'confirmed',identityCount:all.length,observations,signalsSent:0};writeJSON(path.join(packet.outputDir,'native-cli-final-cleanup.json'),proof);return proof;
}
export function snapshotNativeFixtureEvidence({packet}){
 const destination=path.join(packet.outputDir,'native-fixture-evidence'),files=[];let total=0;
 const copy=(source,name)=>{const stat=fs.lstatSync(source);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.ok(stat.size<=16*1024*1024);total+=stat.size;assert.ok(total<=32*1024*1024&&files.length<512);const target=path.join(destination,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);files.push({path:name,bytes:stat.size,sha256:fileHash(target)});};
 for(const name of fs.readdirSync(packet.ownedRoot))if(/^(native-cli-.*\.(?:json|log)|agent-.*\.(?:json|jsonl)|regression-agent-.*\.json)$/.test(name))copy(path.join(packet.ownedRoot,name),name);
 const journals=path.join(packet.ownedRoot,'launcher-journal');if(fs.existsSync(journals))for(const name of fs.readdirSync(journals)){assert.match(name,/^launcher-\d+-\d+\.jsonl$/);copy(path.join(journals,name),'launcher-journal/'+name);}
 const manifest={files,totalBytes:total,phase:'snapshot at final observation; producer may be incomplete on failure',privateRoot:packet.ownedRoot};writeJSON(path.join(destination,'manifest.json'),manifest);return {path:destination,...manifest};
}
export async function runNativeGate(options){
 const prepared=await prepareNativePacket(options);let observation;
 try{observation=await runObservedProcess(process.execPath,[path.join(here,'e2e-owned-service-native.mjs'),'--run','--target',prepared.packet.target,'--mode',prepared.packet.mode,'--source',prepared.packet.source,'--inputs',prepared.inputPath],{cwd:prepared.packet.repository,timeoutMs:12*60000});
  writeJSON(path.join(prepared.packet.outputDir,'driver-observation.json'),observation);assert.equal(observation.code,0,observation.stderr);
  const result=readBoundedJSON(prepared.resultPath);const cleanupConfirmed=result.cleanup?.status==='confirmed';assert.equal(result.ok,true);assert.equal(result.checks.length,16);assert.ok(cleanupConfirmed);verifyNativePacket(prepared.packet);
  return {ok:true,resultPath:prepared.resultPath,cleanupConfirmed,preservePrivateRoot:false,result,...prepared};
 }catch(error){if(error.observation)writeJSON(path.join(prepared.packet.outputDir,'driver-observation-failure.json'),error.observation);try{snapshotNativeFixtureEvidence({packet:prepared.packet});}catch{}throw Object.assign(error,{preservePrivateRoot:true,ownedRoot:prepared.ownedRoot,resultPath:prepared.resultPath});}
}
