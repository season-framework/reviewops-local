'use strict';

// Build tooling only. This module never opens the product identity vault.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const addonIgnore='.*remote-identity-darwin-(arm64|x64)\\.node$';
const entitlementName='entitlements.developer-id.plist';
const fail=()=>{throw new Error('Developer ID signing preparation or verification failed. Check the reviewed signing configuration and credential availability.');};
function signingPlan(env=process.env){
 const mode=env.REVIEWOPS_MAC_SIGNING;
 if(mode===undefined||mode===''||mode==='adhoc')return Object.freeze({mode:'adhoc'});
 if(mode!=='developer-id'||typeof env.CSC_NAME!=='string'||!/^([a-fA-F0-9]{40})$/.test(env.CSC_NAME)||typeof env.REVIEWOPS_MAC_TEAM_ID!=='string'||!/^([A-Z0-9]{10})$/.test(env.REVIEWOPS_MAC_TEAM_ID))fail();
 return Object.freeze({mode:'developer-id',identityHash:env.CSC_NAME.toUpperCase(),teamId:env.REVIEWOPS_MAC_TEAM_ID});
}
function entitlementPath(projectDir){return path.join(projectDir,'build',entitlementName);}
function readEntitlements(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>65536)fail();
 let value;try{value=require('plist').parse(text);}catch{fail();}
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='com.apple.security.cs.allow-jit'||value['com.apple.security.cs.allow-jit']!==true)fail();
 return value;
}
function builderConfiguration(base,env=process.env,projectDir=path.resolve(__dirname,'..')){
 const plan=signingPlan(env),config=structuredClone(base);
 if(env.REVIEWOPS_PACKAGE_OUTPUT!==undefined){if(typeof env.REVIEWOPS_PACKAGE_OUTPUT!=='string'||!path.isAbsolute(env.REVIEWOPS_PACKAGE_OUTPUT))fail();config.directories={...config.directories,output:env.REVIEWOPS_PACKAGE_OUTPUT};}
 if(plan.mode==='developer-id'){
  const entitlements=entitlementPath(projectDir);readEntitlements(fs.readFileSync(entitlements,'utf8'));
  config.forceCodeSigning=true;
  config.mac={...config.mac,identity:plan.identityHash,type:'distribution',hardenedRuntime:true,strictVerify:true,preAutoEntitlements:false,entitlements,entitlementsInherit:entitlements};
 }
 return config;
}
function assertDeveloperConfiguration(packager,plan){
 const config=packager.platformSpecificBuildOptions,entitlements=entitlementPath(packager.projectDir);
 if(config.identity!==plan.identityHash||config.type!=='distribution'||config.hardenedRuntime!==true||config.strictVerify!==true||config.preAutoEntitlements!==false||config.entitlements!==entitlements||config.entitlementsInherit!==entitlements||packager.forceCodeSigning!==true||config.requirements!=null||config.sign!=null||JSON.stringify(config.signIgnore)!==JSON.stringify([addonIgnore]))fail();
 readEntitlements(fs.readFileSync(entitlements,'utf8'));
}
async function resolveDeveloperSigning(packager,plan,{findIdentity,isSignAllowed}={}){
 assertDeveloperConfiguration(packager,plan);
 const signer=findIdentity&&isSignAllowed?null:require('app-builder-lib/out/codeSign/macCodeSign');
 const allowed=isSignAllowed||signer.isSignAllowed,find=findIdentity||signer.findIdentity;
 // Respect the builder's PR/platform signing policy; never enable a bypass.
 if(allowed(false)!==true)fail();
 try{
  // CSC_LINK credentials are imported by the builder, once, into its owned
  // temporary Keychain. Main-app signing later uses this same memoized value.
  const info=await packager.codeSigningInfo.value;
  const keychain=info?.keychainFile??null;
  if(keychain!==null&&(typeof keychain!=='string'||!path.isAbsolute(keychain)||/[\0\r\n]/.test(keychain)))fail();
  const identity=await find('Developer ID Application',plan.identityHash,keychain);
  if(!identity||typeof identity.hash!=='string'||identity.hash.toUpperCase()!==plan.identityHash||typeof identity.name!=='string'||!identity.name.startsWith('Developer ID Application: ')||!identity.name.endsWith(' ('+plan.teamId+')'))fail();
  return Object.freeze({...plan,keychain});
 }catch{fail();} // Never include CSC_LINK, passwords or an upstream credential error.
}
function command(file,args){
 const result=spawnSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 if(result.error||result.status!==0)throw new Error('The macOS build or signing command was refused.');
 return result;
}
function developerRequirement(selection){
 if(!/^[A-F0-9]{40}$/.test(selection.identityHash)||!/^[A-Z0-9]{10}$/.test(selection.teamId))fail();
 // Verification only: do not replace the app's designated requirement or ACL.
 // Apple TN3127 defines the issuer/leaf OIDs; RequirementLang defines H"SHA1".
 return 'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'+selection.teamId+'" and certificate leaf = H"'+selection.identityHash+'"';
}
function verifyDeveloperSignature(file,selection,execute=command,{deep=false,entitlements=false}={}){
 execute('/usr/bin/codesign',['--verify',...(deep?['--deep']:[]),'--strict','--test-requirement',developerRequirement(selection),file]);
 const result=execute('/usr/bin/codesign',['--display','--verbose=4',file]);
 const text=result.stderr||'';
 if(/(?:^|\n)Signature=adhoc(?:\n|$)/.test(text)||!/(?:^|\n)Authority=Developer ID Application: [^\r\n]+(?:\n|$)/.test(text)||!text.split(/\r?\n/).includes('TeamIdentifier='+selection.teamId)||!/(?:^|\n)CodeDirectory [^\r\n]*flags=[^\r\n]*\bruntime\b/.test(text))fail();
 if(entitlements)readEntitlements(execute('/usr/bin/codesign',['--display','--entitlements',':-',file]).stdout);
}
module.exports={signingPlan,builderConfiguration,assertDeveloperConfiguration,resolveDeveloperSigning,verifyDeveloperSignature,developerRequirement,command,readEntitlements};
