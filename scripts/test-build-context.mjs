import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),{validateBuildInfo,validateChangeNotes}=require('../electron/build-info.cjs');
export const contextHash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function validateBuildContext(value,expectedBuild){
 if(!value||value.schema!==1)throw new Error('테스트 빌드 문맥이 올바르지 않습니다.');
 const build=validateBuildInfo(value.build),changes=validateChangeNotes(value.changes,build.commit);
 if(value.baseCommit!==changes.baseCommit||expectedBuild&&JSON.stringify(build)!==JSON.stringify(validateBuildInfo(expectedBuild)))throw new Error('보존한 빌드 문맥과 네이티브 패키지 정보가 다릅니다.');
 return {schema:1,build,baseCommit:changes.baseCommit,changes};
}
export async function freezeBuildContext(filename,value){
 const context=validateBuildContext(value),bytes=Buffer.from(JSON.stringify(context,null,2)+'\n');
 if(bytes.length>2*1024**2)throw new Error('테스트 빌드 문맥의 허용 크기를 초과했습니다.');
 await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes,{flag:'wx'});
 return {context,sha256:contextHash(bytes),size:bytes.length};
}
export async function consumeBuildContext({filename,directory,expectedHash}){
 if(!/^[a-f0-9]{64}$/.test(expectedHash||''))throw new Error('보존한 빌드 문맥의 해시가 필요합니다.');
 const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024**2)throw new Error('보존한 빌드 문맥 파일이 올바르지 않습니다.');
 const bytes=await fs.readFile(filename);if(contextHash(bytes)!==expectedHash)throw new Error('보존한 빌드 문맥이 변경되었습니다.');
 const build=JSON.parse(await fs.readFile(path.join(directory,'build-info.json'),'utf8')),context=validateBuildContext(JSON.parse(bytes),build);
 await fs.writeFile(path.join(directory,'change-notes.json'),JSON.stringify(context.changes,null,2)+'\n');return context;
}
export async function main(args=process.argv.slice(2)){
 const options={};for(let i=0;i<args.length;i+=2){const key={'--context':'filename','--directory':'directory','--expected-sha':'expectedHash'}[args[i]];if(!key||!args[i+1])throw new Error('보존한 빌드 문맥 파일·폴더·해시를 지정하십시오.');options[key]=args[i+1];}
 return consumeBuildContext(options);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(value=>console.log(JSON.stringify({build:value.build,baseCommit:value.baseCommit,changedCommits:value.changes.totalCommits},null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
