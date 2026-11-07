'use strict';
const fs=require('node:fs'),path=require('node:path');
const {LIMITS,sha,safePath,readZip,validatePackage,fail}=require('./ops-skill-package.cjs');
function readDirectory(directory,prefix=''){
 const result=[];
 for(const name of fs.readdirSync(directory)){
  const relative=safePath(prefix?prefix+'/'+name:name),file=path.join(directory,name),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink())fail('OPS_SKILL_PATH','스킬 원본의 심볼릭 링크는 사용할 수 없습니다.',relative);
  if(stat.isDirectory())result.push(...readDirectory(file,relative));
  else if(stat.isFile()&&stat.size<=LIMITS.file)result.push({path:relative,bytes:fs.readFileSync(file)});
  else fail('OPS_SKILL_PATH','크기 제한 이내의 일반 파일만 사용할 수 있습니다.',relative);
 }
 return result;
}
function loadBundledSkills(directory,{required=false}={}){
 if(!fs.existsSync(directory)){if(required)fail('OPS_SKILL_BUNDLED','초기 제공 스킬 자료가 없습니다.');return [];}
 const manifestFile=path.join(directory,'provenance.json');let manifest;
 if(fs.existsSync(manifestFile)){
  const stat=fs.lstatSync(manifestFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)fail('OPS_SKILL_BUNDLED','초기 스킬 출처 자료를 확인하십시오.');
  manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.version!==1||!manifest.packages||typeof manifest.packages!=='object'||Array.isArray(manifest.packages)||Object.keys(manifest.packages).length>100)fail('OPS_SKILL_BUNDLED','초기 스킬 출처 자료가 올바르지 않습니다.');
 }else if(required)fail('OPS_SKILL_BUNDLED','초기 스킬 ZIP 출처 자료가 없습니다.');
 const folders=fs.readdirSync(directory).filter(name=>{const stat=fs.lstatSync(path.join(directory,name));if(stat.isSymbolicLink())fail('OPS_SKILL_BUNDLED','초기 스킬의 심볼릭 링크는 사용할 수 없습니다.',name);return stat.isDirectory();}).sort();
 if(manifest&&JSON.stringify(folders)!==JSON.stringify(Object.keys(manifest.packages).sort()))fail('OPS_SKILL_BUNDLED','초기 스킬 폴더와 제공 ZIP 목록이 다릅니다.');
 // Validate every original before mutating the retained user registry.
 return folders.map(slug=>{
  const folderFiles=readDirectory(path.join(directory,slug)),version=validatePackage(folderFiles);
  if(version.slug!==slug)fail('OPS_SKILL_BUNDLED','초기 스킬 이름이 폴더와 다릅니다.',slug);
  if(!manifest)return {files:folderFiles,version,source:{kind:'bundled-directory',name:'초기 제공 스킬 디렉터리 사본',package:slug}};
  const origin=manifest.packages[slug];
  if(!origin||origin.file!==slug+'.zip'||!Number.isSafeInteger(origin.bytes)||origin.bytes<1||origin.bytes>LIMITS.zip||!/^[a-f0-9]{64}$/.test(origin.sha256||'')||typeof origin.url!=='string'||!/^https:\/\/github\.com\/user-attachments\/files\/[0-9]+\/[a-z0-9-]+\.zip$/.test(origin.url))fail('OPS_SKILL_BUNDLED','제공 ZIP 출처 항목을 확인하십시오.',slug);
  const archive=path.join(directory,origin.file),stat=fs.lstatSync(archive);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==origin.bytes)fail('OPS_SKILL_BUNDLED','제공 ZIP 원본 크기가 다릅니다.',origin.file);
  const bytes=fs.readFileSync(archive);if(sha(bytes)!==origin.sha256)fail('OPS_SKILL_BUNDLED','제공 ZIP 원본 해시가 다릅니다.',origin.file);
  const files=readZip(bytes),zipVersion=validatePackage(files);
  if(zipVersion.slug!==slug||files.length!==folderFiles.length||files.some(file=>!folderFiles.some(row=>row.path===file.path&&row.bytes.equals(file.bytes))))fail('OPS_SKILL_BUNDLED','제공 ZIP과 초기 스킬 파일이 다릅니다.',slug);
  return {files,version:zipVersion,source:{kind:'bundled-zip',name:origin.file,url:origin.url,bytes:origin.bytes,sha256:origin.sha256,package:slug}};
 });
}
module.exports={loadBundledSkills};
