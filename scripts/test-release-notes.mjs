import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {REPOSITORY,TAG,pointerFromBody} from './test-release.mjs';
import {githubReferenceLookup} from './test-release-references.mjs';
const run=promisify(execFile),require=createRequire(import.meta.url);
const {validateBuildInfo,validateChangeNotes}=require('../electron/build-info.cjs');

export async function collectChangeNotes({build,baseCommit,cwd=process.cwd(),command=run,resolveReferences}) {
 build=validateBuildInfo(build);
 if(baseCommit===null)return validateChangeNotes({schema:1,baseCommit:null,commit:build.commit,commits:[],totalCommits:0},build.commit);
 if(!/^[a-f0-9]{40}$/.test(baseCommit||''))throw new Error('이전 테스트 배포의 커밋이 올바르지 않습니다.');
 // A range is reported only when both real commits are present and the public
 // previous build is an ancestor. Branch guesses are never change evidence.
 await command('git',['merge-base','--is-ancestor',baseCommit,build.commit],{cwd});
 const {stdout}=await command('git',['log','--format=%H%x00%s',`${baseCommit}..${build.commit}`],{cwd,maxBuffer:8*1024**2});
 const all=stdout.trim()?stdout.trim().split('\n').map(line=>{const [commit,...subject]=line.split('\0');return {commit,subject:subject.join('\0').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,240)}}):[];
 const commits=[];for(const item of all.slice(0,100))commits.push(resolveReferences?await resolveReferences(item):item);
 return validateChangeNotes({schema:1,baseCommit,commit:build.commit,totalCommits:all.length,commits},build.commit);
}
export async function publicPreviousCommit(fetchImpl=fetch) {
 const response=await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${TAG}`,{headers:{Accept:'application/vnd.github+json','User-Agent':'ReviewOps-Test-Changes','Cache-Control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(30000)});
 if(response.status===404)return null;
 if(!response.ok)throw new Error('이전 공개 테스트 릴리즈를 조회하지 못했습니다.');
 const value=await response.json();
 if(value.tag_name!==TAG||value.draft||!value.prerelease)throw new Error('이전 공개 테스트 릴리즈가 올바르지 않습니다.');
 return pointerFromBody(value.body)?.commit||null;
}
export async function main(args=process.argv.slice(2)) {
 if(![2,4].includes(args.length)||args[0]!=='--directory'||(args.length===4&&args[2]!=='--base-commit'))throw new Error('변경 내용 생성 폴더와 이전 공개 커밋을 지정하십시오.');
 const directory=path.resolve(args[1]),build=JSON.parse(await fs.readFile(path.join(directory,'build-info.json'),'utf8'));
 const baseCommit=args.length===4?(args[3]||null):await publicPreviousCommit();
 const notes=await collectChangeNotes({build,baseCommit,resolveReferences:githubReferenceLookup()});
 await fs.writeFile(path.join(directory,'change-notes.json'),JSON.stringify(notes,null,2)+'\n');
 return notes;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
