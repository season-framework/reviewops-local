'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

// Only fixture snapshots use this helper. Readers keep strict JSON parsing.
// The temporary file and destination share a private directory/filesystem.
function publishJSON(file,value,{beforeRename}={}){
 const destination=path.resolve(file),temporary=destination+'.'+randomUUID()+'.tmp';
 try{
  fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});
  beforeRename?.({destination,temporary});
  fs.renameSync(temporary,destination);
 }finally{
  try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
}
const canReleaseRawInput=(nonce,control,originalExit)=>Boolean(originalExit)||control?.ack?.nonce===nonce;
module.exports={publishJSON,canReleaseRawInput};
