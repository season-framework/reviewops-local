'use strict';

// Build tooling only. Developer ID timestamping may contact Apple; no product-vault calls.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {command,signingPlan,verifyDeveloperSignature}=require('./mac-signing.cjs');
function localHeaders(args=[]){
 if(args.length&&(args.length!==2||args[0]!=='--headers'))throw new Error('Usage: node scripts/build-remote-identity.cjs [--headers /absolute/include/node]');
 const candidates=args.length?[args[1]]:[path.resolve(path.dirname(process.execPath),'../include/node'),path.join(os.homedir(),'Library/Caches/node-gyp',process.versions.node,'include/node')];
 const headers=candidates.find(candidate=>path.isAbsolute(candidate)&&fs.existsSync(path.join(candidate,'node_api.h')));
 if(!headers)throw new Error('Local Node N-API headers are required; no download was attempted.');
 return headers;
}
function buildRemoteIdentity({directory=path.resolve(__dirname,'../electron/native'),headers=localHeaders(),signing={mode:'adhoc'},execute=command}={}){
 if(!['adhoc','developer-id'].includes(signing.mode)||signing.mode==='developer-id'&&(!/^[A-F0-9]{40}$/.test(signing.identityHash)||!/^[A-Z0-9]{10}$/.test(signing.teamId)||!(signing.keychain===null||typeof signing.keychain==='string'&&path.isAbsolute(signing.keychain))))throw new Error('A resolved build signing selection is required.');
 const temporary=fs.mkdtempSync(path.join(directory,'.identity-build-')),files={};
 try{
  for(const arch of ['arm64','x64']){
   const file=`remote-identity-darwin-${arch}.node`,output=path.join(temporary,file);
   execute('/usr/bin/xcrun',['--sdk','macosx','clang++','-std=c++17','-fobjc-arc','-fexceptions','-fobjc-exceptions','-fobjc-arc-exceptions','-DNAPI_VERSION=8','-fvisibility=hidden','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-mmacosx-version-min=13.0','-arch',arch==='x64'?'x86_64':arch,'-I',headers,'-bundle','-undefined','dynamic_lookup',path.join(directory,'remote-identity-darwin.mm'),'-framework','Security','-framework','CoreFoundation','-framework','Foundation','-o',output]);
   const args=['--force','--sign',signing.mode==='developer-id'?signing.identityHash:'-'];
   if(signing.mode==='developer-id')args.push('--options','runtime','--timestamp',...(signing.keychain?['--keychain',signing.keychain]:[]));
   execute('/usr/bin/codesign',[...args,output]);
   if(signing.mode==='developer-id')verifyDeveloperSignature(output,signing,execute);
   // Hash only final signed bytes. The app signer must keep signIgnore for
   // these addons; afterSign checks that the enclosing seal kept them intact.
   const content=fs.readFileSync(output);files[arch]={file,bytes:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex')};
  }
  for(const entry of Object.values(files))fs.renameSync(path.join(temporary,entry.file),path.join(directory,entry.file));
  const manifest=path.join(temporary,'manifest.json');fs.writeFileSync(manifest,JSON.stringify({schema:1,files})+'\n',{mode:0o644});fs.renameSync(manifest,path.join(directory,'remote-identity-manifest.json'));
  return {schema:1,files};
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={buildRemoteIdentity,localHeaders};
if(require.main===module){
 try{
  if(process.platform!=='darwin')throw new Error('The native identity build requires macOS.');
  if(signingPlan().mode!=='adhoc')throw new Error('Developer ID addon signing requires the reviewed electron-builder hook and its resolved Keychain.');
  buildRemoteIdentity({headers:localHeaders(process.argv.slice(2))});console.log('Built signed N-API 8 identity addons for macOS arm64 and x64.');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
