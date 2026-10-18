import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createRequire} from 'node:module';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(import.meta.url),run=promisify(execFile);
const {createUpdateManager,RELEASE_API,RELEASES_URL}=require('../electron/updates.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(process.argv[2]==='--worker') {
 const plan=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
 const {archive,dataPath,target,version,asset}=plan;
 const states=[];
 const manager=createUpdateManager({app:{isPackaged:true,getVersion:()=> '0.0.1',getPath:()=>path.join(target,'Contents/MacOS/ReviewOps'),quit(){}},dataPath,shell:{openExternal:async()=>{}},platform:'darwin',arch:process.arch,onChange:state=>states.push(state.status),request:async(url,options)=>{
  if(url===RELEASE_API)return Buffer.from(JSON.stringify({tag_name:`v${version}`,draft:false,prerelease:false,assets:[{...asset,browser_download_url:asset.url},{name:'reviewops-update.json',size:512,browser_download_url:`${RELEASES_URL}/download/v${version}/reviewops-update.json`}]}));
  if(url.endsWith('/reviewops-update.json'))return Buffer.from(JSON.stringify({schema:1,version,artifacts:{[`darwin-${process.arch}`]:asset}}));
  assert.equal(options.expectedHash,asset.sha256);assert.equal(options.expectedSize,asset.size);await fs.copyFile(archive,options.filename);return {size:asset.size};
 }});
 assert.equal((await manager.apply()).status,'installing');assert.deepEqual(states,['checking','available','downloading','verifying','ready','installing']);manager.launchInstall();process.exit(0);
}
const source=process.env.REVIEWOPS_TEST_APP;
if(!source||!path.isAbsolute(source)||!source.endsWith('.app'))throw new Error('Set REVIEWOPS_TEST_APP to an absolute packaged ReviewOps.app path.');
const root=await fs.mkdtemp('/tmp/reviewops-upkg-'),dataPath=path.join(root,'data'),target=path.join(root,'ReviewOps.app'),home=path.join(root,'home'),config=path.join(home,'.ssh/config');
let launchedPid;
try{
 await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,'# Isolated updater integration test\n');
 await fs.mkdir(path.join(dataPath,'codex-manager'),{recursive:true});
 // Ensure runtime probing cannot use or mutate any actual Codex account.
 const binary=path.join(root,'codex-fixture'),c=path.join(root,'codex-fixture.c');
 await fs.writeFile(c,'#include <stdio.h>\n#include <string.h>\nint main(int argc,char**argv){if(argc==2&&!strcmp(argv[1],"--version")){puts("codex-cli 0.0.0-fixture");return 0;}return 73;}\n');
 await run('/usr/bin/clang',['-O2',c,'-o',binary]);
 await fs.writeFile(path.join(dataPath,'codex-manager/runtime.json'),JSON.stringify({path:binary}));
 const preserved=path.join(dataPath,'keep-user-file.txt');await fs.writeFile(preserved,'Keep this project data unchanged.');
 await run('/usr/bin/ditto',['--norsrc',source,target]);
 const version=(await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(source,'Contents/Info.plist')])).stdout.trim();
 const name=`ReviewOps-${version}-${process.arch}.zip`,archive=path.join(root,name);await run('/usr/bin/ditto',['-c','-k','--norsrc','--keepParent',source,archive],{timeout:120000});
 const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
 const asset={name,url:`${RELEASES_URL}/download/v${version}/${name}`,size:(await fs.stat(archive)).size,sha256:hash.digest('hex')};
 const plan=path.join(root,'plan.json');await fs.writeFile(plan,JSON.stringify({archive,dataPath,target,version,asset}));
 await run(process.execPath,[import.meta.filename,'--worker',plan],{env:{...process.env,HOME:home,REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:config},timeout:180000});
 const pending=JSON.parse(await fs.readFile(path.join(dataPath,'updates/pending.json'),'utf8'));
 let result='';for(let n=0;n<90;n++){try{result=(await fs.readFile(path.join(pending.job,'result'),'utf8')).trim();if(result)break}catch{}await wait(1000)}
 try{launchedPid=Number(await fs.readFile(path.join(pending.job,'launched.pid'),'utf8'))}catch{}
 assert.equal(result,'installed',await fs.readFile(path.join(pending.job,'install.log'),'utf8'));
 assert.equal(await fs.readFile(path.join(pending.job,'healthy'),'utf8'),version);
 assert.equal(await fs.readFile(preserved,'utf8'),'Keep this project data unchanged.');
 assert.equal((await fs.stat(path.join(dataPath,'reviewops.sqlite'))).isFile(),true);
 await run('/usr/bin/codesign',['--verify','--deep','--strict',target]);
 const report={version,checks:['one-click check, download, verification and installation','GitHub release contract','native ZIP extraction and signature verification','replacement after parent exit','real Electron startup','trusted renderer-ready health acknowledgment','isolated data location','existing data preserved'],result,installedAppTouched:false,actualAccountOperations:0};
 await fs.mkdir('test-results/updates',{recursive:true});await fs.writeFile('test-results/updates/packaged.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
 if(launchedPid)try{process.kill(launchedPid,'SIGTERM')}catch{}
 // The helper may still be retaining the previous bundle after reporting a
 // successful install. Retry removal while that private copy finishes.
 await wait(1500);await fs.rm(root,{recursive:true,force:true,maxRetries:12,retryDelay:250});
}
