'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {LIMITS}=require('./ops-skill-package.cjs');
function invalid(){throw Object.assign(new Error('스킬 요청 항목을 확인하십시오.'),{code:'OPS_SKILL_REQUEST'});}
function fields(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))invalid();}
function createSkillsHandler({registry,dialog,getWindow}){
 return async(method,input={},guard=()=>{})=>{
  guard();if(!registry)throw Object.assign(new Error('스킬 자료를 열지 못했습니다. 원본을 보존하고 다시 실행하십시오.'),{code:'OPS_SKILLS_UNAVAILABLE'});
  if(method==='snapshot'){fields(input,[]);return registry.snapshot();}
  if(method==='readFile')return registry.readFile(input);
  if(method==='importZip'){
   fields(input,['mode','skillId']);if(!['new','update'].includes(input.mode)||input.mode==='update'&&typeof input.skillId!=='string')invalid();
   const choice=await dialog.showOpenDialog(getWindow(),{title:input.mode==='update'?'스킬 ZIP 업데이트':'스킬 ZIP 가져오기',properties:['openFile'],filters:[{name:'스킬 ZIP',extensions:['zip']}]});guard();
   if(choice.canceled||!choice.filePaths?.length)return {...registry.snapshot(),cancelled:true};
   const file=choice.filePaths[0],handle=await fs.open(file,'r');let bytes;
   try{const stat=await handle.stat();if(!stat.isFile()||stat.size>LIMITS.zip)throw Object.assign(new Error('스킬 ZIP은 20 MiB 이하여야 합니다.'),{code:'OPS_SKILL_LIMIT'});const buffer=Buffer.alloc(stat.size+1);let length=0;while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}const after=await handle.stat();if(length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Object.assign(new Error('선택한 ZIP 파일이 변경되었습니다. 다시 선택하십시오.'),{code:'OPS_SKILL_ZIP'});bytes=buffer.subarray(0,length);}finally{await handle.close();}
   guard();return registry.importZip(bytes,{...input,name:path.basename(file)});
  }
  if(method==='create')return registry.create(input);
  if(method==='update')return registry.update(input);
  if(method==='save')return registry.save(input);
  if(method==='saveFile')return registry.saveFile(input);
  if(method==='remove'){fields(input,['id']);return registry.remove(input.id);}
  if(method==='restoreOriginal'){fields(input,['id']);return registry.restoreOriginal(input.id);}
  if(method==='checkCapabilities'){fields(input,[]);const result=await registry.checkCapabilities();guard();return result;}
  invalid();
 };
}
module.exports={createSkillsHandler};
