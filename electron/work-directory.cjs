'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');

function failure(status,code,message,location='') {return {ok:false,status,code,message,path:location};}
async function inspectDirectory(value,{filesystem=fs,paths=path}={}) {
  if(typeof value!=='string'||!value.trim()||value.length>4096||/[\0\r\n]/.test(value)||!paths.isAbsolute(value.trim()))return failure('invalid','AGENT_WORK_PATH_INVALID','작업 폴더의 전체 경로를 입력하십시오.');
  const location=value.trim();
  try {
    const resolved=await filesystem.realpath(location);
    if(!(await filesystem.stat(resolved)).isDirectory())return failure('not_directory','AGENT_WORK_PATH_NOT_DIRECTORY','선택한 경로는 파일입니다. 작업할 폴더를 선택하십시오.',location);
    await filesystem.access(resolved,constants.R_OK|constants.X_OK);
    return {ok:true,status:'ready',path:location,resolvedPath:resolved,message:'사용할 수 있는 폴더입니다.'};
  } catch(error) {
    if(error.code==='ENOENT')return failure('missing','AGENT_WORK_PATH_MISSING','폴더가 없습니다. 기존 폴더를 선택하거나 새 폴더를 만드십시오.',location);
    if(error.code==='ENOTDIR')return failure('not_directory','AGENT_WORK_PATH_NOT_DIRECTORY','경로에 폴더가 아닌 파일이 포함되어 있습니다. 다른 폴더를 선택하십시오.',location);
    return failure('inaccessible','AGENT_WORK_PATH_INACCESSIBLE','폴더에 접근할 수 없습니다. 접근 권한이 있는 다른 폴더를 선택하십시오.',location);
  }
}
async function requireDirectory(value,options) {
  const result=await inspectDirectory(value,options);
  if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code});
  return result.resolvedPath;
}
async function createChildDirectory(parent,name,{filesystem=fs,paths=path}={}) {
  if(typeof name!=='string'||!name.trim()||name!==name.trim()||name.length>255||name==='.'||name==='..'||/[\0-\x1f/\\<>:"|?*]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw Object.assign(new Error('폴더 이름에는 경로 구분자나 특수 문자를 사용할 수 없습니다.'),{code:'DIRECTORY_NAME_INVALID'});
  const root=await requireDirectory(parent,{filesystem,paths});
  const location=paths.join(root,name);
  try {await filesystem.mkdir(location,{mode:0o700});}
  catch(error) {
    if(error.code==='EEXIST')throw Object.assign(new Error('같은 이름의 파일이나 폴더가 있습니다. 다른 이름을 입력하십시오.'),{code:'DIRECTORY_EXISTS'});
    throw Object.assign(new Error('선택한 위치에 폴더를 만들 수 없습니다. 다른 위치를 선택하십시오.'),{code:'DIRECTORY_CREATE_FAILED'});
  }
  return location;
}
module.exports={inspectDirectory,requireDirectory,createChildDirectory};
