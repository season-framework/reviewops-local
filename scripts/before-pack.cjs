'use strict';
const {signingPlan,resolveDeveloperSigning}=require('./mac-signing.cjs');
const {buildRemoteIdentity}=require('./build-remote-identity.cjs');
function createBeforePack({env=process.env,build=buildRemoteIdentity,findIdentity,isSignAllowed}={}){
 return async function beforePack(context){
  if(context.electronPlatformName!=='darwin')return;
  const plan=signingPlan(env);
  const signing=plan.mode==='developer-id'?await resolveDeveloperSigning(context.packager,plan,{findIdentity,isSignAllowed}):plan;
  build({signing});
 };
}
module.exports=createBeforePack();
module.exports.createBeforePack=createBeforePack;
