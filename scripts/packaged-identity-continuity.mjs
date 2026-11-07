// Read-only package admission and pure continuity comparisons. Importing this
// module starts no application and performs no credential operation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {verifyOriginalMainProcess} from './native-adapters.mjs';
const require=createRequire(import.meta.url);
const {validateBuildInfo}=require('../electron/build-info.cjs');
export const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const within=(root,file)=>file!==root&&file.startsWith(root+path.sep);
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&
  Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

// Keep an actual Windows process handle, rather than treating Playwright's
// retained cmd.exe as the app. This observer only reads and waits; it never
// signals a process or adopts a later process with the same PID.
const WINDOWS_MAIN_OBSERVER=String.raw`
$ErrorActionPreference='Stop'
$owned=$null
try {
 $requested=[int]$env:REVIEWOPS_CONTINUITY_PID
 if($requested -le 0){throw 'Invalid original main PID'}
 $owned=[System.Diagnostics.Process]::GetProcessById($requested)
 $handle=$owned.Handle
 if($handle -eq [IntPtr]::Zero){throw 'Original process handle is unavailable'}
 $ticks=$owned.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
 $executable=$owned.MainModule.FileName
 if(-not [string]::Equals($executable,$env:REVIEWOPS_CONTINUITY_EXE,[StringComparison]::OrdinalIgnoreCase) -or $owned.HasExited){throw 'Original process binding refused'}
 [Console]::Out.WriteLine(([pscustomobject]@{kind='bound';pid=$requested;startTicks=$ticks;executable=$executable}|ConvertTo-Json -Compress))
 [Console]::Out.Flush()
 $owned.WaitForExit()
 [Console]::Out.WriteLine(([pscustomobject]@{kind='exited';pid=$requested;startTicks=$ticks;exitCode=$owned.ExitCode}|ConvertTo-Json -Compress))
 [Console]::Out.Flush()
} catch { [Console]::Error.WriteLine('Original main lifetime observation refused');exit 1 }
finally { if($null -ne $owned){$owned.Dispose()} }
`;
export function observeWindowsOriginalMain({identity,executable,systemRoot=process.env.SystemRoot,spawnProcess=spawn}){
 const original=verifyOriginalMainProcess(identity);assert.equal(original.platform,'win32');
 assert.ok(path.win32.isAbsolute(executable)&&path.win32.isAbsolute(systemRoot));
 const child=spawnProcess(path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
  ['-NoProfile','-NonInteractive','-Command',WINDOWS_MAIN_OBSERVER],{windowsHide:true,stdio:['ignore','pipe','pipe'],
   env:{SystemRoot:systemRoot,WINDIR:systemRoot,REVIEWOPS_CONTINUITY_PID:String(original.pid),REVIEWOPS_CONTINUITY_EXE:executable}});
 let resolveBound,rejectBound,resolveExited,rejectExited,buffer='',total=0,stderrBytes=0,binding,exitRecord,failure;
 const bound=new Promise((resolve,reject)=>{resolveBound=resolve;rejectBound=reject;});
 const exited=new Promise((resolve,reject)=>{resolveExited=resolve;rejectExited=reject;});
 // A binding failure can precede the caller's await; keep both failures owned.
 bound.catch(()=>{});exited.catch(()=>{});
 const refuse=()=>{failure ||= Object.assign(new Error('Original main lifetime could not be verified.'),{code:'ORIGINAL_MAIN_UNCONFIRMED'});rejectBound(failure);rejectExited(failure);};
 const read=line=>{
  try{
   const value=JSON.parse(line);
   if(!binding){
    assert.ok(exact(value,['kind','pid','startTicks','executable'])&&value.kind==='bound'&&value.pid===original.pid);
    assert.ok(typeof value.startTicks==='string'&&/^\d{15,20}$/.test(value.startTicks));
    assert.equal(path.win32.normalize(value.executable).toLowerCase(),path.win32.normalize(executable).toLowerCase());
    binding=Object.freeze({...value});resolveBound(binding);
   }else{
    assert.ok(!exitRecord&&exact(value,['kind','pid','startTicks','exitCode'])&&value.kind==='exited'&&value.pid===binding.pid&&value.startTicks===binding.startTicks);
    assert.ok(Number.isInteger(value.exitCode)&&value.exitCode>=-2147483648&&value.exitCode<=2147483647);exitRecord=Object.freeze({...value});
   }
  }catch{refuse();}
 };
 child.stdout.on('data',bytes=>{
  total+=bytes.length;if(total>8192){refuse();return;}buffer+=bytes.toString('utf8');
  let offset;while((offset=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,offset).replace(/\r$/,'');buffer=buffer.slice(offset+1);read(line);}
 });
 child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;refuse();});
 child.once('error',refuse);
 child.once('close',(code,signal)=>{
  if(failure||code!==0||signal!==null||stderrBytes||buffer||!binding||!exitRecord){refuse();return;}
  resolveExited(Object.freeze({...exitRecord,observerPID:child.pid,observerExit:{code,signal}}));
 });
 return{child,bound,exited};
}

export function validatePlan(input,platform=process.platform,arch=process.arch){
 assert.ok(exact(input,['schema','platform','arch','privateRoot','baseline','candidate']),'Invalid continuity plan');
 assert.equal(input.schema,1);assert.ok(['darwin','win32'].includes(platform));assert.equal(input.platform,platform);assert.equal(input.arch,arch);
 const paths=platform==='win32'?path.win32:path.posix;
 assert.ok(paths.isAbsolute(input.privateRoot)&&/^reviewops-identity-inputs-/.test(paths.basename(input.privateRoot)),'Use a dedicated private input directory');
 for(const entry of [input.baseline,input.candidate]){
  assert.ok(exact(entry,['appPath','source'])&&paths.isAbsolute(entry.appPath)&&COMMIT.test(entry.source));
  const relative=paths.relative(input.privateRoot,entry.appPath);
  assert.ok(relative&&!paths.isAbsolute(relative)&&!relative.split(paths.sep).includes('..'),'App must belong to the private input directory');
  assert.equal(paths.basename(entry.appPath),platform==='darwin'?'ReviewOps.app':'ReviewOps');
 }
 assert.notEqual(input.baseline.appPath,input.candidate.appPath);assert.notEqual(input.baseline.source,input.candidate.source);
 return structuredClone(input);
}
export function compareBuildPair(baseline,candidate){
 assert.notEqual(baseline.source,candidate.source,'Candidate must be an actual different source commit');
 assert.notEqual(baseline.archive.sha256,candidate.archive.sha256,'Candidate ASAR must differ from baseline');
 const compare=(a,b)=>{for(let i=0;i<3;i++){if(a[i]!==b[i])return Math.sign(a[i]-b[i]);}return 0;};
 const version=compare(candidate.build.version.split('.').map(Number),baseline.build.version.split('.').map(Number));
 assert.ok(version>0||version===0&&candidate.build.buildNumber>baseline.build.buildNumber,'Use a later real version or build');
}
export const CONTINUITY_FIELDS=Object.freeze(['backend','deviceIdSHA256','keyFingerprint','certificateFingerprint',
 'indexSHA256','certificateFileSHA256','connectionIdSHA256','principalIdSHA256','credentialScopeSHA256',
 'credentialCiphertextSHA256','credentialTokenSHA256','hostTokenSHA256','projectIdSHA256','datasetEpochSHA256']);
export function assertContinuity(expected,actual){
 assert.ok(exact(expected,CONTINUITY_FIELDS)&&exact(actual,CONTINUITY_FIELDS),'Invalid public continuity summary');
 for(const field of CONTINUITY_FIELDS){
  if(field==='backend')assert.ok(['macos-default-file-keychain','electron-safe-storage'].includes(actual[field]));
  else assert.ok(typeof actual[field]==='string'&&SHA.test(actual[field]),'Invalid continuity fingerprint');
  assert.equal(actual[field],expected[field],`Original continuity changed: ${field}`);
 }
}
export function inventory(root){
 const rows=[];
 const walk=directory=>{
  for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   assert.ok(rows.length<20000,'Package inventory exceeds its bound');
   const file=path.join(directory,entry.name),relative=path.relative(root,file).split(path.sep).join('/');
   if(entry.isSymbolicLink()){
    const target=fs.realpathSync(file);assert.ok(target===root||within(root,target),'Package link escapes the private bundle');
    rows.push({path:relative,kind:'symlink',target:fs.readlinkSync(file)});
   }else if(entry.isDirectory())walk(file);
   else{
    assert.ok(entry.isFile(),'Package contains an unsupported file');const stat=fs.statSync(file);
    assert.ok(stat.size<=1024**3,'Package file exceeds its bound');
    rows.push({path:relative,kind:'file',bytes:stat.size,sha256:sha256(fs.readFileSync(file))});
   }
  }
 };walk(root);return rows;
}
function boundedJSON(bytes,maximum=65536){assert.ok(bytes.length>0&&bytes.length<=maximum);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
export async function inspectPrivateBundle({entry,privateRoot,repository,platform,arch,asar,run}){
 const privateInfo=fs.lstatSync(privateRoot);
 assert.ok(privateInfo.isDirectory()&&!privateInfo.isSymbolicLink()&&fs.realpathSync(privateRoot)===privateRoot);
 if(platform!=='win32')assert.ok(privateInfo.uid===process.getuid()&&(privateInfo.mode&0o777)===0o700,'Private inputs require owner-only access');
 const app=fs.realpathSync(entry.appPath);assert.equal(app,entry.appPath);assert.ok(within(privateRoot,app));
 const rootInfo=fs.lstatSync(app);assert.ok(rootInfo.isDirectory()&&!rootInfo.isSymbolicLink());
 const resources=path.join(app,...(platform==='darwin'?['Contents','Resources']:['resources']));
 const executable=path.join(app,...(platform==='darwin'?['Contents','MacOS','ReviewOps']:['ReviewOps.exe']));
 const archive=path.join(resources,'app.asar');
 for(const file of [executable,archive]){const stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0);}
 // A validated replacement can reuse this path; cached header offsets cannot.
 asar.uncache?.(archive);
 const pkg=boundedJSON(asar.extractFile(archive,'package.json'));
 assert.equal(pkg.name,'reviewops-local');
 const build=validateBuildInfo(boundedJSON(asar.extractFile(archive,'electron/reviewops-build.json')),pkg.version);
 assert.equal(build.commit,entry.source,'Embedded source must equal the admitted commit');
 const sourcePackage=JSON.parse((await run('git',['show',entry.source+':package.json'],{cwd:repository})).stdout);
 assert.equal(pkg.version,sourcePackage.version);
 const tracked=(await run('git',['ls-tree','-r','--name-only',entry.source,'--','electron'],{cwd:repository})).stdout.trim().split('\n')
  .filter(name=>/\.(?:cjs|json)$/.test(name));
 assert.ok(tracked.includes('electron/remote-device-identity.cjs')&&tracked.includes('electron/remote-app-connections.cjs'));
 const sourceFiles=[];
 for(const name of tracked){
  const source=await run('git',['show',entry.source+':'+name],{cwd:repository,encoding:'buffer',maxBuffer:8*1024**2});
  const actual=asar.extractFile(archive,name);assert.equal(sha256(actual),sha256(source.stdout),'Packaged runtime differs from source: '+name);
  sourceFiles.push({path:name,sha256:sha256(actual)});
 }
 let signing,native=null;
 if(platform==='darwin'){
  await run('/usr/bin/codesign',['--verify','--deep','--strict',app],{timeout:120000});
  const requirement=await run('/usr/bin/codesign',['--display','-r','-',app]);
  const text=(requirement.stderr+'\n'+requirement.stdout).split('\n').find(line=>/^(?:# )?designated => /.test(line));
  assert.ok(text,'The actual app designated requirement is missing');
  signing={kind:'macos-code-signature',designatedRequirement:text,designatedRequirementSHA256:sha256(Buffer.from(text))};
  const nativeRoot=path.join(resources,'app.asar.unpacked','electron','native');
  require('./verify-remote-identity.cjs').verify(nativeRoot);
  native=boundedJSON(fs.readFileSync(path.join(nativeRoot,'remote-identity-manifest.json')),1024);
  const arches=(await run('/usr/bin/lipo',['-archs',executable])).stdout.trim().split(/\s+/);
  assert.ok(arches.includes(arch==='x64'?'x86_64':arch));
 }else{
  const fd=fs.openSync(executable,'r');try{
   const header=Buffer.alloc(64);assert.equal(fs.readSync(fd,header,0,64,0),64);assert.equal(header.toString('ascii',0,2),'MZ');
   const offset=header.readUInt32LE(60),pe=Buffer.alloc(6);assert.ok(offset>=64&&offset<fs.fstatSync(fd).size-6);
   assert.equal(fs.readSync(fd,pe,0,6,offset),6);assert.deepEqual(pe.subarray(0,4),Buffer.from([80,69,0,0]));assert.equal(pe.readUInt16LE(4),0x8664);
  }finally{fs.closeSync(fd);}
  const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
   "$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath $env:REVIEWOPS_CONTINUITY_EXE;[pscustomobject]@{status=[string]$s.Status;thumbprint=if($s.SignerCertificate){$s.SignerCertificate.Thumbprint}else{$null}}|ConvertTo-Json -Compress"],
   {env:{...process.env,REVIEWOPS_CONTINUITY_EXE:executable},timeout:30000});
  const signature=JSON.parse(result.stdout);assert.ok(['Valid','NotSigned'].includes(signature.status));
  signing={kind:'windows-authenticode',...signature};
 }
 const files=inventory(app),file=filename=>{const stat=fs.statSync(filename);return{bytes:stat.size,sha256:sha256(fs.readFileSync(filename))};};
 return{appPath:app,source:entry.source,build,executable,executableFile:file(executable),archive:file(archive),
  bundleSHA256:sha256(Buffer.from(JSON.stringify(files))),fileCount:files.length,runtimeSourceSHA256:sha256(Buffer.from(JSON.stringify(sourceFiles))),signing,native};
}
