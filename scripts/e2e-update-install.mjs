import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
if(process.platform!=='darwin')throw new Error('This integration test requires macOS.');
const root=await fs.mkdtemp('/tmp/reviewops-installer-test-');
const helper=path.resolve('electron/update-install.sh');
const environment={...process.env,REVIEWOPS_DATA_DIR:path.join(root,'isolated-data')};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const checks=[];
async function fixture(bundle,body,version='1.2.0') {
 await fs.mkdir(path.join(bundle,'Contents/MacOS'),{recursive:true});
 await fs.writeFile(path.join(bundle,'Contents/Info.plist'),`<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>kr.co.season.reviewops.local</string><key>CFBundleName</key><string>ReviewOps</string><key>CFBundleExecutable</key><string>ReviewOps</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
 await fs.writeFile(path.join(bundle,'Contents/MacOS/ReviewOps'),`#!/bin/sh\n${body}\n`,{mode:0o755});
 await run('/usr/bin/codesign',['--force','--sign','-',bundle]);
 await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
}
async function scenario(name,healthy) {
 const folder=path.join(root,name),job=path.join(folder,'job'),target=path.join(folder,'ReviewOps.app'),source=path.join(job,'ReviewOps.app'),incoming=path.join(folder,'.incoming.app'),previous=path.join(folder,'.previous.app');
 await fs.mkdir(job,{recursive:true});
 const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
 await fixture(target,`/usr/bin/printf restored > ${quote(path.join(folder,'restored'))}\n/usr/bin/printf '%s' "$REVIEWOPS_DATA_DIR" > ${quote(path.join(folder,'rollback-data-path'))}\nexit 0`,'1.1.1');
 await fixture(source,healthy?`/usr/bin/printf '%s' "$REVIEWOPS_DATA_DIR" > ${quote(path.join(job,'data-path'))}\n/usr/bin/touch ${quote(path.join(job,'healthy'))}\n/bin/sleep 4`:'exit 1');
 // Dead parent PID: the helper still exercises its own normal exit wait.
 const child=spawn('/bin/sh',[helper,'999999',target,source,job,incoming,previous],{env:environment,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
 const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(new Error('Installer test timed out'))},30000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);resolve(code)})});
 const result=(await fs.readFile(path.join(job,'result'),'utf8')).trim();
 assert.equal(result,healthy?'installed':'failed',output);
 const version=(await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(target,'Contents/Info.plist')])).stdout.trim();
 assert.equal(version,healthy?'1.2.0':'1.1.1');
 await run('/usr/bin/codesign',['--verify','--deep','--strict',target]);
 if(healthy){assert.equal(code,0);assert.equal(await fs.readFile(path.join(job,'data-path'),'utf8'),environment.REVIEWOPS_DATA_DIR);assert.equal((await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(job,'previous.app/Contents/Info.plist')])).stdout.trim(),'1.1.1')}
 else {assert.notEqual(code,0);assert(await fs.stat(path.join(job,'failed.app')));for(let n=0;n<30;n++){try{if(await fs.readFile(path.join(folder,'rollback-data-path'),'utf8')===environment.REVIEWOPS_DATA_DIR)break}catch{}await wait(100)}assert.equal(await fs.readFile(path.join(folder,'rollback-data-path'),'utf8'),environment.REVIEWOPS_DATA_DIR);}
 checks.push({name,status:'passed',version,result});
}
try{
 await scenario('success',true);
 await scenario('startup-failure',false);
 await wait(4500);
 const output=path.resolve('test-results/updates');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'installer.json'),JSON.stringify({checks,userDataAccess:false,installedAppTouched:false},null,2));
 console.log(JSON.stringify({checks,userDataAccess:false,installedAppTouched:false},null,2));
}finally{await fs.rm(root,{recursive:true,force:true})}
