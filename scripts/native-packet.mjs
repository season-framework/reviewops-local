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
export async function verifyWindowsAgentExit(fixture,observed){
 if(process.platform!=='win32')return;
 const entries=fs.readdirSync(fixture.launcherJournal).flatMap(name=>fs.readFileSync(path.join(fixture.launcherJournal,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
 const rows=entries.filter(x=>x.phase==='node-child-start'&&x.nodeChildPid===observed.pid);assert.equal(rows.length,1,'Exact native launcher/Node mapping must be unambiguous');
 const row=rows[0],start=entries.find(x=>x.phase==='native-start'&&x.launcherPid===row.launcherPid);assert.ok(start);
 const input=writeJSON(path.join(path.dirname(fixture.agentScript),'owned-cli-identities-'+observed.pid+'.json'),[{pid:row.launcherPid,startTicks:start.launcherStartTicks},{pid:row.nodeChildPid,startTicks:row.nodeStartTicks}]);
 const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');const result=await runObservedProcess(ps,['-NoProfile','-NonInteractive','-File',path.join(here,'inspect-owned-identities.ps1'),'-InputManifest',input],{timeoutMs:10000});assert.equal(result.code,0,result.stderr);const states=JSON.parse(result.stdout);assert.equal(states.length,2);assert.ok(states.every(x=>x.originalRunning===false));return {launcher:row,states};
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
  writeJSON(path.join(prepared.packet.outputDir,'driver-observation.json'),observation);const result=readBoundedJSON(prepared.resultPath);const cleanupConfirmed=result.cleanup?.status==='confirmed';
  assert.equal(observation.code,0,observation.stderr);assert.equal(result.ok,true);assert.equal(result.checks.length,16);assert.ok(cleanupConfirmed);verifyNativePacket(prepared.packet);
  return {ok:true,resultPath:prepared.resultPath,cleanupConfirmed,preservePrivateRoot:false,result,...prepared};
 }catch(error){if(error.observation)writeJSON(path.join(prepared.packet.outputDir,'driver-observation-failure.json'),error.observation);try{snapshotNativeFixtureEvidence({packet:prepared.packet});}catch{}throw Object.assign(error,{preservePrivateRoot:true,ownedRoot:prepared.ownedRoot,resultPath:prepared.resultPath});}
}
