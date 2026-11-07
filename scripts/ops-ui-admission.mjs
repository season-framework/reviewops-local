// Read-only source/installed admission shared by the Ops UI feature lanes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{validateBuildInfo}=require('../electron/build-info.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileHash=file=>hash(fs.readFileSync(file));
const readJSON=file=>{assert.ok(path.isAbsolute(file),'Admission JSON must use an absolute path');assert.ok(fs.statSync(file).isFile()&&fs.statSync(file).size<=8*1024**2);return JSON.parse(fs.readFileSync(file,'utf8'));};
export const OPS_UI_SOURCE_FILES=Object.freeze(['electron/main.cjs','electron/preload.cjs','electron/ops-manager.cjs','electron/ops-management.cjs','electron/ops-store.cjs','electron/ops-session.cjs','electron/ops-scheduler.cjs','electron/work-directory.cjs','electron/codex/runtime.cjs','electron/build-info.cjs']);

export async function createOpsUiAdmission({sourceRoot=process.cwd(),env=process.env,files=OPS_UI_SOURCE_FILES}={}){
 const root=fs.realpathSync(sourceRoot),driverSourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const executable=env.REVIEWOPS_TEST_EXECUTABLE,expectedPath=env.REVIEWOPS_EXPECTED_BUILD_INFO;
 assert.equal(Boolean(executable),Boolean(expectedPath),'Installed execution requires both REVIEWOPS_TEST_EXECUTABLE and REVIEWOPS_EXPECTED_BUILD_INFO; neither may relabel a source run');
 const record={lane:executable?'installed-test-candidate':'source',driverSourceCommit,sourceRoot:root,observed:null,launches:[]};
 let launchOptions={args:[root]},expectedBuild,archive,producer;
 if(executable){
  assert.equal(process.platform,'darwin','This installed feature adapter currently admits native macOS ZIP producers only; other native platforms use their dedicated package QA');
  assert.ok(path.isAbsolute(executable),'Select the explicit private installed executable');
  const exe=fs.realpathSync(executable);fs.accessSync(exe,fs.constants.X_OK);
  expectedBuild=validateBuildInfo(readJSON(expectedPath));
  assert.equal(execFileSync('git',['rev-parse',expectedBuild.commit+'^{commit}'],{cwd:root,encoding:'utf8'}).trim(),expectedBuild.commit,'The selected producer source object must be available locally');
  const verificationPath=env.REVIEWOPS_TEST_CANDIDATE_VERIFICATION,zip=env.REVIEWOPS_TEST_CANDIDATE_ARCHIVE;
  assert.ok(verificationPath&&zip&&path.isAbsolute(verificationPath)&&path.isAbsolute(zip),'Installed execution requires the original native producer verification and ZIP, not just matching version text');
  producer=readJSON(verificationPath);assert.equal(producer.ok,true);assert.equal(producer.target,process.platform+'-'+process.arch);assert.deepEqual(validateBuildInfo(producer.build),expectedBuild);
  for(const check of ['packaged-build-info','codesign','zip-extraction','native-smoke','ops-package-source','ops-native-smoke'])assert.ok(producer.checks?.includes(check),'Missing native producer admission: '+check);
  const matches=producer.files.filter(row=>row.name===path.basename(zip));assert.equal(matches.length,1);const descriptor=matches[0];assert.match(descriptor.sha256,/^[a-f0-9]{64}$/);assert.equal(fs.statSync(zip).size,descriptor.size);assert.equal(fileHash(zip),descriptor.sha256);
  archive=path.resolve(path.dirname(exe),'../Resources/app.asar');assert.ok(fs.statSync(archive).isFile());
  const {validateArchive}=require('../electron/update-archive.cjs');await validateArchive(zip);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-ops-ui-admission-'));let producerBinding;
  try{
   execFileSync('/usr/bin/ditto',['-x','-k',zip,temporary]);
   const bundle=path.join(temporary,'ReviewOps.app'),producerExe=path.join(bundle,'Contents/MacOS/ReviewOps'),producerAsar=path.join(bundle,'Contents/Resources/app.asar');
   producerBinding={executableSHA256:fileHash(producerExe),asarSHA256:fileHash(producerAsar)};
   assert.equal(fileHash(exe),producerBinding.executableSHA256,'Selected executable must equal the verified native ZIP executable');
   assert.equal(fileHash(archive),producerBinding.asarSHA256,'Selected entire ASAR must equal the verified native ZIP, including its renderer assets');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  const asar=require('@electron/asar');asar.uncache(archive);
  assert.deepEqual(validateBuildInfo(JSON.parse(asar.extractFile(archive,'electron/reviewops-build.json'))),expectedBuild);assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,expectedBuild.version);
  const sourceFiles=files.map(file=>{const expected=execFileSync('git',['show',expectedBuild.commit+':'+file],{cwd:root,maxBuffer:16*1024**2}),bytes=asar.extractFile(archive,file);assert.deepEqual(bytes,expected,file+' must match the selected producer commit, not the driver HEAD');return {file,bytes:bytes.length,sha256:hash(bytes)};});
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',path.resolve(path.dirname(exe),'../..')]);
  Object.assign(record,{expectedBuildInfoPath:fs.realpathSync(expectedPath),expectedBuild,executable:exe,archive,package:{zip:fs.realpathSync(zip),verification:fs.realpathSync(verificationPath),verificationSHA256:fileHash(verificationPath),...descriptor,...producerBinding},sourceFiles});
  launchOptions={executablePath:exe,args:[]};
 }
 return {record,launchOptions,async verify(app,page,dataPath){
  const native=await app.evaluate(({app})=>({isPackaged:app.isPackaged,executable:process.execPath,appPath:app.getAppPath(),version:app.getVersion(),platform:process.platform,arch:process.arch,pid:process.pid}));
  await page.waitForFunction(()=>Boolean(window.reviewops?.invoke));const info=await page.evaluate(()=>window.reviewops.invoke('app.info'));
  assert.equal(info.dataPath,dataPath);assert.equal(info.platform,native.platform);assert.equal(info.arch,native.arch);assert.equal(info.version,native.version);
  if(expectedBuild){assert.equal(native.isPackaged,true);assert.equal(fs.realpathSync(native.executable),record.executable);assert.equal(fs.realpathSync(native.appPath),fs.realpathSync(archive));assert.equal(native.platform,process.platform);assert.equal(native.arch,process.arch);assert.deepEqual(validateBuildInfo(info.build),expectedBuild);assert.equal(info.version,expectedBuild.version);assert.equal(fileHash(archive),record.package.asarSHA256);}
  else{assert.equal(native.isPackaged,false,'Source execution must never be reported as installed QA');assert.equal(fs.realpathSync(native.appPath),root);}
  record.observed={native,appInfo:info};record.launches.push({atUTC:new Date().toISOString(),...record.observed});return record.observed;
 }};
}
