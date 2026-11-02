import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {clearBuildInfo} from './build-info.mjs';
import {buildRenderer,buildNativePackage,inspectMac,windowsPublisher} from './test-build.mjs';
import {validateSource,assertDispatch,TARGETS} from './stable-release.mjs';
import {fileHash,jsonBytes,hash} from './test-release.mjs';
import {runRequiredOwnedGate,runWindowsInstalledSmoke,nativePackagedRendererRecord} from './owned-native-orchestration.mjs';
import {recordNativeRenderer} from './native-packet.mjs';
const require=createRequire(import.meta.url),asar=require('@electron/asar'),{validateArchive}=require('../electron/update-archive.cjs'),run=promisify(execFile),root=fileURLToPath(new URL('..',import.meta.url));
async function sourceFiles(directory){const files=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('소스 파일의 심볼릭 링크는 허용하지 않습니다.');if(entry.isDirectory())files.push(...await sourceFiles(file));else if(entry.isFile())files.push(file)}return files}
export async function inspectStableArchive(archive,version,directory=root){
 const info=await fs.lstat(archive);if(!info.isFile()||info.isSymbolicLink())throw new Error('정식 앱 아카이브가 올바르지 않습니다.');
 asar.uncache(archive);
 const entries=asar.listPackage(archive).map(name=>name.replaceAll('\\','/').replace(/^\//,'')),allowed=new Set(['dist','electron','node_modules','package.json','LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt']);
 for(const entry of entries)if(!allowed.has(entry.split('/')[0])||/(^|\/)(?:\.git|\.ssh|\.codex|\.env(?:\.[^/]*)?|reviewops-build\.json|reviewops\.sqlite(?:-wal|-shm)?|credentials\.json|auth\.json|accounts\.json|test-results)(?:\/|$)/i.test(entry))throw new Error('정식 패키지에 허용하지 않은 파일이 있습니다: '+entry);
 const pkg=JSON.parse(asar.extractFile(archive,'package.json').toString('utf8'));if(pkg.version!==version||pkg.main!=='electron/main.cjs')throw new Error('정식 패키지 버전 또는 실행 파일이 다릅니다.');
 const files=[...await sourceFiles(path.join(directory,'electron')),...await sourceFiles(path.join(directory,'dist')),...['LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt'].map(name=>path.join(directory,name))];
 // ASAR's directory traversal splits on the host's path.sep. Keep the native
 // path for extraction; slash-normalized names are only for display/policies.
 for(const file of files){const relative=path.relative(directory,file);if(hash(asar.extractFile(archive,relative))!==await fileHash(file))throw new Error('정식 패키지가 검사한 소스와 다릅니다: '+relative.replaceAll('\\','/'))}
 return {version,testMetadataAbsent:true,comparedFiles:files.length};
}
export async function packageStable({target,version,commit,env=process.env}){
 if(!TARGETS.includes(target)||target!==`${process.platform}-${process.arch}`)throw new Error('대상 운영체제와 CPU에 맞는 네이티브 runner를 사용하십시오.');
 assertDispatch({env,version,commit});await validateSource({version,commit});
 const output=path.join(root,'release',`stable-${target}`),packageRoot=path.join(output,'packaged');await fs.mkdir(path.dirname(output),{recursive:true});
 const lock=path.join(root,'release/.stable-build.lock'),handle=await fs.open(lock,'wx');
 try{
  await clearBuildInfo();await fs.rm(output,{recursive:true,force:true});await fs.mkdir(output,{recursive:true});
  // Native installations can omit optional dependencies. Their presence must
  // not rewrite the reviewed, committed notices during stable packaging.
  await buildRenderer({generateLicenses:false});
  const rendererBuildRecord=nativePackagedRendererRecord(root,target,'stable');
  await recordNativeRenderer({repository:root,source:commit,recordPath:rendererBuildRecord});
  await validateSource({version,commit});await buildNativePackage(target,packageRoot);
  const arch=target.split('-')[1],files=[],checks=['stable-package','source-match'];let publisher;
  const copy=async(name)=>{const from=path.join(packageRoot,name),to=path.join(output,name);await fs.copyFile(from,to);files.push(to);return to};
  if(process.platform==='darwin'){
   const bundle=path.join(packageRoot,arch==='arm64'?'mac-arm64':'mac','ReviewOps.app'),verify=archive=>inspectStableArchive(archive,version);
   await inspectMac(bundle,{version},arch,verify);
   const dmg=await copy(`ReviewOps-${version}-${arch}.dmg`);await run('/usr/bin/hdiutil',['verify',dmg],{timeout:120000});
   const zip=path.join(output,`ReviewOps-${version}-${arch}.zip`);await run('/usr/bin/ditto',['-c','-k','--norsrc','--keepParent',bundle,zip],{timeout:180000});await validateArchive(zip);files.push(zip);
   const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-stable-package-'));
   let preservePrivateInstall=false,ownedGateAttempted=false;
   try{
    await run('/usr/bin/ditto',['-x','-k',zip,temporary],{timeout:180000});
    const extracted=path.join(temporary,'ReviewOps.app');await inspectMac(extracted,{version},arch,verify);
    const smokeEnv={...env,REVIEWOPS_TEST_EXECUTABLE:path.join(extracted,'Contents/MacOS/ReviewOps')};delete smokeEnv.ELECTRON_RUN_AS_NODE;
    await run(process.execPath,[path.join(root,'scripts/e2e.mjs')],{cwd:root,env:smokeEnv,timeout:300000,maxBuffer:8*1024**2});
    ownedGateAttempted=true;
    await runRequiredOwnedGate({repository:root,target,mode:'private-bundle',
     executablePath:path.join(extracted,'Contents/MacOS/ReviewOps'),privateInstallRoot:temporary,
     rendererBuildRecord});
   }catch(error){preservePrivateInstall=ownedGateAttempted&&error.preservePrivateRoot!==false;if(preservePrivateInstall)console.error('Retain unconfirmed private app:',temporary,error.ownedRoot||'',error.resultPath||'');throw error}
   finally{if(!preservePrivateInstall)await fs.rm(temporary,{recursive:true,force:true})}
   checks.push('codesign','dmg-verify','zip-extraction','native-smoke','native-owned-service-16');
  }else{
   const name=`ReviewOps-${version}-windows-x64.exe`,installer=path.join(packageRoot,name);
   await inspectStableArchive(path.join(packageRoot,'win-unpacked/resources/app.asar'),version);publisher=await windowsPublisher(installer);
   await runWindowsInstalledSmoke({repository:root,installer,env:{...env,REVIEWOPS_VERIFY_PACKAGE_ROOT:packageRoot,
    REVIEWOPS_EXPECT_STABLE_BUILD:'true',REVIEWOPS_OWNED_RENDERER_RECORD:rendererBuildRecord}});
   const report=JSON.parse(await fs.readFile(path.join(root,'test-results/windows-release.json'),'utf8'));
   if(report.ok!==true||report.sourceCommit!==commit||report.version!==version||report.sha256!==await fileHash(installer)||report.stableBuild?.metadataAbsent!==true||report.ownedService?.ok!==true||report.ownedService?.cleanupConfirmed!==true)throw new Error('Windows 설치·실행·자료 보존 검사를 완료하지 못했습니다.');
   await copy(name);checks.push('publisher-status','installed-application','native-owned-service-16');
  }
  const record={schema:1,channel:'stable',version,commit,target,platform:process.platform,arch:process.arch,ok:true,testMetadataAbsent:true,checks,...(publisher?{publisher}:{}),files:[]};
  for(const file of files)record.files.push({name:path.basename(file),size:(await fs.stat(file)).size,sha256:await fileHash(file)});
  await fs.writeFile(path.join(output,`verification-${target}.json`),jsonBytes(record));return {output,...record};
 }finally{await clearBuildInfo();await handle.close();await fs.rm(lock,{force:true})}
}
export async function main(args=process.argv.slice(2),env=process.env){if(args.length!==2||args[0]!=='--target')throw new Error('--target darwin-arm64|darwin-x64|win32-x64를 지정하십시오.');return packageStable({target:args[1],version:String(env.REVIEWOPS_RELEASE_TAG||'').slice(1),commit:env.REVIEWOPS_REVIEWED_COMMIT,env})}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
