'use strict';

// electron-builder afterSign hook: refuse packaging if any signing pass changed
// an addon after the final-byte manifest was generated. Does not load an addon.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {signingPlan,assertDeveloperConfiguration,verifyDeveloperSignature,command}=require('./mac-signing.cjs');
function verify(directory) {
  const manifestFile=path.join(directory,'remote-identity-manifest.json');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.schema!==1||Object.keys(manifest).sort().join(',')!=='files,schema'||Object.keys(manifest.files).sort().join(',')!=='arm64,x64')throw new Error('Invalid identity addon manifest.');
  for(const arch of ['arm64','x64']){
    const expected=manifest.files[arch],filename=path.join(directory,`remote-identity-darwin-${arch}.node`);
    if(expected.file!==path.basename(filename)||Object.keys(expected).sort().join(',')!=='bytes,file,sha256')throw new Error('Invalid identity addon entry.');
    const stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>32*1024*1024)throw new Error('Invalid identity addon file.');
    const bytes=fs.readFileSync(filename);
    if(bytes.length!==expected.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw new Error('Identity addon changed after manifest generation.');
  }
}
function createAfterSign({env=process.env,execute=command}={}){
 return async context=>{
  if(context.electronPlatformName!=='darwin')return;
  const resources=context.packager.getResourcesDir(context.appOutDir),directory=path.join(resources,'app.asar.unpacked','electron','native');
  verify(directory);
  const plan=signingPlan(env);
  if(plan.mode==='developer-id'){
   assertDeveloperConfiguration(context.packager,plan);
   for(const arch of ['arm64','x64'])verifyDeveloperSignature(path.join(directory,`remote-identity-darwin-${arch}.node`),plan,execute);
   verifyDeveloperSignature(path.resolve(resources,'../..'),plan,execute,{deep:true,entitlements:true});
  }
 };
}
module.exports=createAfterSign();
module.exports.createAfterSign=createAfterSign;
module.exports.verify=verify;
if(require.main===module)verify(path.resolve(__dirname,'../electron/native'));
