'use strict';
const yaml=require('js-yaml');
const path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const LIMITS=Object.freeze({zip:20*1024**2,package:32*1024**2,file:8*1024**2,files:500,text:256*1024,store:128*1024**2});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code,message,location){throw Object.assign(new Error((location?location+': ':'')+message),{code,location});}
function safePath(value){if(typeof value!=='string'||!value||value.length>1024||value!==value.normalize('NFC')||/[:\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..'))fail('OPS_SKILL_PATH','패키지 안의 상대 경로만 사용할 수 있습니다.',String(value).slice(0,200));return value;}
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const value of bytes)crc=crcTable[(crc^value)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function readZip(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>LIMITS.zip)fail('OPS_SKILL_ZIP','ZIP은 20 MiB 이하여야 합니다.');
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0)fail('OPS_SKILL_ZIP','ZIP 끝 정보를 읽을 수 없습니다.');
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count||!count||count>LIMITS.files*2||offset+size!==end)fail('OPS_SKILL_ZIP','단일 ZIP의 일반 파일만 지원합니다. ZIP64·분할 ZIP은 사용할 수 없습니다.');
 let cursor=offset,total=0;const files=[],names=new Set(),ranges=[];
 for(let i=0;i<count;i++){
  if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)fail('OPS_SKILL_ZIP','ZIP 파일 목록이 손상되었습니다.');
  const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),length=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42),mode=bytes.readUInt32LE(cursor+38)>>>16;
  if((flags&1)||![0,8].includes(method)||cursor+46+nameLength+extraLength+commentLength>end||length>LIMITS.file||compressed>LIMITS.zip||bytes.readUInt16LE(cursor+34))fail('OPS_SKILL_ZIP','암호화·큰 파일·지원하지 않는 압축 형식입니다.');
  const raw=bytes.subarray(cursor+46,cursor+46+nameLength),name=raw.toString('utf8'),directory=name.endsWith('/'),entry=safePath(directory?name.slice(0,-1):name),key=entry.toLowerCase();
  if(!Buffer.from(name).equals(raw)||names.has(key))fail('OPS_SKILL_ZIP','UTF-8 경로가 아니거나 이름이 중복됩니다.',entry);names.add(key);
  const kind=mode&0xf000;if(kind&&![0x8000,0x4000].includes(kind))fail('OPS_SKILL_ZIP','심볼릭 링크와 특수 파일은 가져올 수 없습니다.',entry);
  if(local+30>offset||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||bytes.readUInt16LE(local+26)!==nameLength)fail('OPS_SKILL_ZIP','ZIP 개별 파일 정보가 일치하지 않습니다.',entry);
  const start=local+30+nameLength+bytes.readUInt16LE(local+28),stop=start+compressed;
  if(stop>offset||!bytes.subarray(local+30,local+30+nameLength).equals(raw))fail('OPS_SKILL_ZIP','ZIP 파일 범위가 올바르지 않습니다.',entry);
  let rangeEnd=stop;if(flags&8){let d=stop;if(d+12>offset)fail('OPS_SKILL_ZIP','ZIP 데이터 정보가 없습니다.',entry);if(bytes.readUInt32LE(d)===0x08074b50)d+=4;if(d+12>offset||bytes.readUInt32LE(d)!==crc||bytes.readUInt32LE(d+4)!==compressed||bytes.readUInt32LE(d+8)!==length)fail('OPS_SKILL_ZIP','ZIP 데이터 정보가 일치하지 않습니다.',entry);rangeEnd=d+12;}else if(bytes.readUInt32LE(local+14)!==crc||bytes.readUInt32LE(local+18)!==compressed||bytes.readUInt32LE(local+22)!==length)fail('OPS_SKILL_ZIP','ZIP 크기·체크섬 정보가 일치하지 않습니다.',entry);
  ranges.push([local,rangeEnd]);cursor+=46+nameLength+extraLength+commentLength;if(directory)continue;
  total+=length;if(total>LIMITS.package||files.length>=LIMITS.files)fail('OPS_SKILL_LIMIT','패키지는 파일 500개·압축 해제 32 MiB 이하여야 합니다.');
  let content;try{content=method===8?zlib.inflateRawSync(bytes.subarray(start,stop),{maxOutputLength:LIMITS.file}):Buffer.from(bytes.subarray(start,stop));}catch{fail('OPS_SKILL_ZIP','압축을 해제할 수 없습니다.',entry);}
  if(content.length!==length||crc32(content)!==crc)fail('OPS_SKILL_ZIP','파일 크기 또는 체크섬이 일치하지 않습니다.',entry);
  const appleDouble=path.posix.basename(entry).startsWith('._')&&content.length>=4&&content.readUInt32BE(0)===0x00051607;
  if(!appleDouble&&!entry.split('/').includes('__MACOSX')&&path.posix.basename(entry)!=='.DS_Store')files.push({path:entry,bytes:content});
 }
 ranges.sort((a,b)=>a[0]-b[0]);if(cursor!==end||ranges.some((r,i)=>i&&ranges[i-1][1]>r[0]))fail('OPS_SKILL_ZIP','ZIP의 파일 영역이 겹칩니다.');
 const roots=files.filter(row=>path.posix.basename(row.path)==='SKILL.md');if(roots.length!==1)fail('OPS_SKILL_REQUIRED','SKILL.md가 정확히 하나 있는 스킬 ZIP을 선택하십시오.');
 const prefix=path.posix.dirname(roots[0].path);if(prefix!=='.'&&prefix.includes('/'))fail('OPS_SKILL_REQUIRED','SKILL.md는 ZIP 루트 또는 하나의 스킬 폴더 안에 있어야 합니다.',roots[0].path);
 if(prefix!=='.'&&files.some(row=>!row.path.startsWith(prefix+'/')))fail('OPS_SKILL_REQUIRED','스킬 폴더 밖에 파일이 있습니다.');
 return files.map(row=>({...row,path:prefix==='.'?row.path:row.path.slice(prefix.length+1)}));
}
function yamlFields(value,location='SKILL.md',lineOffset=0){if(Buffer.byteLength(value)>LIMITS.text)fail('OPS_SKILL_LIMIT','YAML 지침은 256 KiB 이하여야 합니다.',location);let document;try{document=yaml.load(value,{schema:yaml.JSON_SCHEMA,json:false});}catch(error){fail('OPS_SKILL_METADATA','YAML 문법을 확인하십시오: '+String(error.reason||'잘못된 형식'),location+':'+((error.mark?.line||0)+1+lineOffset));}if(!document||typeof document!=='object'||Array.isArray(document))fail('OPS_SKILL_METADATA','YAML 항목이 필요합니다.',location+':'+(lineOffset+1));const result={};for(const key of ['name','description','version','display_name','default_prompt','application_rules'])if(document[key]!==undefined){if(typeof document[key]!=='string')fail('OPS_SKILL_METADATA','YAML '+key+' 값은 문자열이어야 합니다.',location+':'+(lineOffset+1));result[key]=document[key];}if(document.interface!==undefined){if(!document.interface||typeof document.interface!=='object'||Array.isArray(document.interface))fail('OPS_SKILL_METADATA','interface 항목을 확인하십시오.',location+':'+(lineOffset+1));for(const key of ['display_name','default_prompt'])if(document.interface[key]!==undefined){if(typeof document.interface[key]!=='string')fail('OPS_SKILL_METADATA','interface '+key+' 값은 문자열이어야 합니다.',location+':'+(lineOffset+1));result[key]=document.interface[key];}}return result;}
function textFile(bytes,name){const value=bytes.toString('utf8');if(!Buffer.from(value).equals(bytes)||value.includes('\0'))fail('OPS_SKILL_TEXT','UTF-8 텍스트 파일이 아닙니다.',name);return value;}
function validatePackage(files,overrides={}){
 if(!Array.isArray(files)||!files.length||files.length>LIMITS.files)fail('OPS_SKILL_REQUIRED','스킬 파일이 없습니다.');
 const names=new Set();let total=0;for(const row of files){safePath(row.path);if(names.has(row.path.toLowerCase())||!Buffer.isBuffer(row.bytes)||row.bytes.length>LIMITS.file)fail('OPS_SKILL_PACKAGE','중복 또는 큰 파일입니다.',row.path);names.add(row.path.toLowerCase());total+=row.bytes.length;}if(total>LIMITS.package)fail('OPS_SKILL_LIMIT','스킬 크기가 32 MiB를 초과합니다.');
 for(const name of names)if([...names].some(other=>other.startsWith(name+'/')))fail('OPS_SKILL_PATH','파일과 폴더 경로가 겹칩니다.',name);
 const directories=overrides.directories;if(directories!==undefined){if(!Array.isArray(directories)||directories.length>LIMITS.files||new Set(directories.map(value=>safePath(value).toLowerCase())).size!==directories.length)fail('OPS_SKILL_PATH','폴더 경로가 중복되거나 너무 많습니다.');for(const directory of directories)if(names.has(directory.toLowerCase())||[...names].some(name=>directory.toLowerCase().startsWith(name+'/')))fail('OPS_SKILL_PATH','파일과 폴더 경로가 겹칩니다.',directory);}
 const main=files.find(row=>row.path==='SKILL.md');if(!main)fail('OPS_SKILL_REQUIRED','필수 지침 파일이 없습니다.','SKILL.md');if(main.bytes.length>LIMITS.text)fail('OPS_SKILL_LIMIT','지침 파일은 256 KiB 이하여야 합니다.','SKILL.md');
 const instruction=textFile(main.bytes,'SKILL.md'),front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(instruction);if(!front)fail('OPS_SKILL_METADATA','name과 description을 포함한 YAML 머리말이 필요합니다.','SKILL.md:1');
 if(!instruction.slice(front[0].length).trim())fail('OPS_SKILL_REQUIRED','실행할 지침 본문이 없습니다.','SKILL.md');
 const meta=yamlFields(front[1],'SKILL.md',1);if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(meta.name||'')||typeof meta.description!=='string'||!meta.description.trim()||meta.description.length>4000)fail('OPS_SKILL_METADATA','name 또는 description을 확인하십시오.','SKILL.md:2');
 const dependencies=[];for(const row of files.filter(row=>/\.md$/i.test(row.path))){const value=textFile(row.bytes,row.path);let fence=null;for(const [i,line]of value.split('\n').entries()){
   const marker=/^\s*(`{3,}|~{3,})/.exec(line);if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=null;continue;}if(fence)continue;
   const links=[...line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(m=>m[1].split(/\s+['"]/)[0]);for(const match of line.matchAll(/\x60((?:references|assets|scripts|agents)\/[^\x60\s]+)\x60/g))links.push(match[1]);
   for(let link of links){if(/^[a-z][a-z0-9+.-]*:/i.test(link)||link.startsWith('#')||link.startsWith('/'))continue;try{link=decodeURIComponent(link.split('#')[0]);}catch{fail('OPS_SKILL_REFERENCE','참조 경로를 읽을 수 없습니다.',row.path+':'+(i+1));}if(!link)continue;
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(row.path),link));if(resolved.startsWith('../')){if(/^\.\.\/[a-z0-9-]+\/SKILL\.md$/.test(resolved)){dependencies.push(resolved);continue;}fail('OPS_SKILL_REFERENCE','패키지 밖의 상대 참조는 사용할 수 없습니다.',row.path+':'+(i+1));}
    if(!files.some(file=>file.path===resolved)&&!directories?.includes(resolved)&&!files.some(file=>file.path.startsWith(resolved+'/')))fail('OPS_SKILL_REFERENCE','참조 파일이 없습니다: '+resolved,row.path+':'+(i+1));
   }
  }}
 const agent=files.find(row=>row.path==='agents/openai.yaml'),agentFields=agent?yamlFields(textFile(agent.bytes,agent.path),agent.path):{};
 const metadata={...(overrides.applicationRules!==undefined||meta.application_rules!==undefined?{applicationRules:overrides.applicationRules??meta.application_rules}:{}),...(directories!==undefined?{directories:[...directories].sort()}:{}),slug:meta.name,name:overrides.name??agentFields.display_name??meta.name,description:overrides.description??meta.description,defaultPrompt:overrides.defaultPrompt??agentFields.default_prompt??'',version:overrides.version??meta.version??'',dependencies:[...new Set(dependencies)]};
 if(metadata.applicationRules!==undefined&&(typeof metadata.applicationRules!=='string'||metadata.applicationRules.length>4000||metadata.applicationRules.includes('\0')))fail('OPS_SKILL_METADATA','사용 규칙은 4000자 이내로 입력하십시오.','applicationRules');
 for(const [key,max]of [['name',200],['description',4000],['defaultPrompt',20000],['version',100]])if(typeof metadata[key]!=='string'||metadata[key].length>max||metadata[key].includes('\0')||key==='name'&&!metadata[key].trim())fail('OPS_SKILL_METADATA','스킬 설명이나 기본 요청을 확인하십시오.',key);
 return {...metadata,files:files.slice().sort((a,b)=>a.path.localeCompare(b.path)).map(row=>({path:row.path,sha256:sha(row.bytes),size:row.bytes.length}))};
}
module.exports={LIMITS,sha,safePath,readZip,validatePackage,textFile,yamlFields,fail};
