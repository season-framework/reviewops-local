'use strict';
const {execFileSync}=require('node:child_process');
const path=require('node:path');
module.exports=async function beforePack({electronPlatformName}){
  if(electronPlatformName==='darwin')execFileSync(process.execPath,[path.join(__dirname,'build-remote-identity.cjs')],{stdio:'inherit'});
};
