// Actual exported guards evaluated with inert Windows filesystem/platform mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url)),win=path.win32;
const short=String.raw`C:\Users\RUNNER~1\AppData\Local\Temp`,long=String.raw`C:\Users\runneradmin\AppData\Local\Temp`;
const privateRoot=win.join(long,'reviewops-windows-release-4JRnE2');
const root=String.raw`D:\a\reviewops-local\reviewops-local`,manifest=String.raw`D:\evidence\bundle-manifest.json`;
function load(name,{symlinkEscape=false}={}){
 const nativeCalls=[],jsCalls=[];
 const resolveJS=value=>{jsCalls.push(value);return win.resolve(value);};
 resolveJS.native=value=>{
  nativeCalls.push(value);
  if(symlinkEscape&&win.basename(value)==='escape')return String.raw`C:\unowned\outside`;
  const resolved=win.resolve(value);
  return resolved.startsWith(short)?long+resolved.slice(short.length):resolved;
 };
 const mockFS={realpathSync:resolveJS,lstatSync:()=>({isSymbolicLink:()=>false}),
  statSync(file){assert.equal(file,manifest);throw new Error('INERT_MANIFEST_BOUNDARY_REACHED');},
  readdirSync:()=>[{name:'escape',isSymbolicLink:()=>true}],readlinkSync:()=>String.raw`C:\unowned\outside`};
 const strip=source=>source.replace(/^import[^\n]+\n/gm,'').replace(/\bexport (?=(?:async )?(?:function|const)\b)/g,'');
 let adapters=fs.readFileSync(path.join(directory,'../scripts/native-adapters.mjs'),'utf8');
 let guard=fs.readFileSync(path.join(directory,'../scripts/packaged-bundle-guards.mjs'),'utf8');
 if(name==='baseline.mjs'){
  // Controlled original JS-canonicalization model. Reversing these exact call
  // substitutions reproduces the original guard/appPaths API choice; no old app runs.
  adapters=adapters.replaceAll('canonicalPath(','fs.realpathSync(');
  guard=guard.replaceAll('canonicalPath(','fs.realpathSync(');
 }
 const context={assert,fs:mockFS,path:win,os:{tmpdir:()=>short},crypto:{},process:{platform:'win32',arch:'x64',versions:{},env:{RUNNER_TEMP:String.raw`D:\a\_temp`}}};
 vm.runInNewContext(strip(adapters)+'\n'+strip(guard)+'\nthis.api={canonicalPath,appPaths,verifyPackagedBundle,inventory};',context);
 return{...context.api,nativeCalls,jsCalls};
}
const options=(install=privateRoot,app=win.join(install,'installed','ReviewOps.exe'))=>({root,privateInstallRoot:install,appPath:app,manifestPath:manifest,expectedTarget:'win32-x64'});
test('controlled short-base/native-long fixture fails before and reaches the unchanged manifest boundary after',()=>{
 assert.throws(()=>load('baseline.mjs').verifyPackagedBundle(options()),/Dedicated private installed\/extracted app only/);
 const candidate=load('candidate.mjs');assert.throws(()=>candidate.verifyPackagedBundle(options()),/INERT_MANIFEST_BOUNDARY_REACHED/);
 assert.ok(candidate.nativeCalls.includes(short));assert.ok(candidate.nativeCalls.includes(privateRoot));
});
test('exact permitted base and sibling-prefix directory remain rejected',()=>{
 for(const value of [long,long+'-sibling\\reviewops-private'])assert.throws(()=>load('candidate.mjs').verifyPackagedBundle(options(value)),/Dedicated private installed\/extracted app only/);
});
test('general installed or user application roots remain unapproved',()=>{
 for(const value of [String.raw`C:\Program Files\ReviewOps`,String.raw`C:\Users\runneradmin\Apps\reviewops-private`])assert.throws(()=>load('candidate.mjs').verifyPackagedBundle(options(value)),/Dedicated private installed\/extracted app only/);
});
test('noncanonical app alias remains rejected even below the canonical approved root',()=>{
 const app=win.join(short,'reviewops-windows-release-4JRnE2','installed','ReviewOps.exe');
 assert.throws(()=>load('candidate.mjs').verifyPackagedBundle(options(privateRoot,app)),/No app alias/);
});
test('canonicalization does not bypass the existing private-directory prefix',()=>{
 assert.throws(()=>load('candidate.mjs').verifyPackagedBundle(options(win.join(long,'unreviewed-folder'))));
});
test('a bundle symlink escaping the canonical private app remains rejected',()=>{
 assert.throws(()=>load('candidate.mjs',{symlinkEscape:true}).inventory(win.join(privateRoot,'installed')),/Bundle symlink escapes the private app/);
});

test('shared canonicalPath calls the native API and returns its canonical result',()=>{
 const api=load('candidate.mjs');assert.equal(api.canonicalPath(short),long);assert.deepEqual(api.nativeCalls,[short]);assert.deepEqual(api.jsCalls,[]);
});
test('appPaths original alias model fails while the shared canonical helper returns the exact installed app',()=>{
 const input={mode:'nsis-installed',privateInstallRoot:privateRoot,app:win.join(privateRoot,'installed','ReviewOps.exe'),installReceipt:'inert-receipt',bundleManifest:'inert-manifest'};
 assert.throws(()=>load('baseline.mjs').appPaths('win32-x64',input));
 const api=load('candidate.mjs'),result=api.appPaths('win32-x64',input);assert.equal(result.executablePath,input.app);assert.equal(result.mode,'nsis-installed');assert.equal(result.args.length,0);assert.ok(api.nativeCalls.includes(short));assert.ok(api.nativeCalls.includes(privateRoot));assert.ok(api.nativeCalls.includes(input.app));
});
test('appPaths still rejects exact bases, sibling prefixes and general app roots',()=>{
 for(const value of [long,long+'-sibling\\reviewops-private',String.raw`C:\Program Files\reviewops-private`]){
  assert.throws(()=>load('candidate.mjs').appPaths('win32-x64',{mode:'nsis-installed',privateInstallRoot:value,app:win.join(value,'ReviewOps.exe'),installReceipt:'inert',bundleManifest:'inert'}));
 }
});
test('appPaths still rejects outside apps and invalid private directory prefixes',()=>{
 for(const input of [{privateInstallRoot:privateRoot,app:String.raw`C:\unowned\ReviewOps.exe`},{privateInstallRoot:win.join(long,'unreviewed'),app:win.join(long,'unreviewed','ReviewOps.exe')}]){
  assert.throws(()=>load('candidate.mjs').appPaths('win32-x64',{mode:'nsis-installed',installReceipt:'inert',bundleManifest:'inert',...input}));
 }
});
test('appPaths keeps the actual NSIS receipt requirement and rejects private-bundle mode on Windows',()=>{
 const input={privateInstallRoot:privateRoot,app:win.join(privateRoot,'installed','ReviewOps.exe')};
 assert.throws(()=>load('candidate.mjs').appPaths('win32-x64',{...input,mode:'nsis-installed'}),/Actual NSIS/);
 assert.throws(()=>load('candidate.mjs').appPaths('win32-x64',{...input,mode:'private-bundle',installReceipt:'inert',bundleManifest:'inert'}),/not an installed-app claim/);
});
test('source appPaths retains the original JS realpath API without invoking native canonicalization',()=>{
 const api=load('candidate.mjs'),result=api.appPaths('win32-x64',{mode:'source',repository:root});assert.equal(result.args[0],root);assert.equal(result.mode,'source');assert.equal(api.nativeCalls.length,0);assert.deepEqual(api.jsCalls,[root]);
});
