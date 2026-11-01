import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {REPOSITORY,TAG,PUBLICATION_GROUP,ciBuildNumber,pointerFromBody} from './test-release.mjs';
import {ledgerFromBody,allocateDevelopment,replaceLedger} from './test-development-ledger.mjs';
import {collectChangeNotes} from './test-release-notes.mjs';
import {githubReferenceLookup} from './test-release-references.mjs';
import {freezeBuildContext} from './test-build-context.mjs';

export function assertAllocationCI(env) {
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPOSITORY||env.GITHUB_JOB!=='metadata'||env.REVIEWOPS_PUBLICATION_GROUP!==PUBLICATION_GROUP||!String(env.GITHUB_WORKFLOW_REF||'').startsWith(`${REPOSITORY}/.github/workflows/test-release.yml@`)||env.REVIEWOPS_TEST_PUBLISH!=='true'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw new Error('개발 번호 예약은 전역 잠금 안의 테스트 게시 metadata 작업에서만 실행할 수 있습니다.');
 ciBuildNumber(env);
}
export function allocationStore({env=process.env,fetchImpl=fetch}={}) {
 const api=`https://api.github.com/repos/${REPOSITORY}`;
 const request=async(suffix,{method='GET',body}={})=>{
  if(method!=='GET'){assertAllocationCI(env);if(!env.GITHUB_TOKEN)throw new Error('개발 버전 예약 토큰이 없습니다.');}
  const response=await fetchImpl(api+suffix,{method,headers:{Accept:'application/vnd.github+json','User-Agent':'ReviewOps-Development-Metadata','Cache-Control':'no-cache',...(env.GITHUB_TOKEN?{Authorization:`Bearer ${env.GITHUB_TOKEN}`}:{ }),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(method==='GET'&&response.status===404)return null;
  if(!response.ok)throw new Error(`개발 버전 metadata 요청이 실패했습니다: HTTP ${response.status}`);
  return response.json();
 };
 return {
  getRelease:()=>request(`/releases/tags/${TAG}`),
  createRelease:build=>{
   assertAllocationCI(env);
   if(build.commit!==env.GITHUB_SHA||build.buildNumber!==ciBuildNumber(env))throw new Error('예약할 소스와 현재 Actions 실행이 다릅니다.');
   return request('/releases',{method:'POST',body:{tag_name:TAG,target_commitish:build.commit,name:'ReviewOps 테스트 버전',body:'',prerelease:true,draft:false,make_latest:'false'}});
  },
  saveLedger:(release,body)=>{
   assertAllocationCI(env);
   if(release.tag_name!==TAG||release.draft||!release.prerelease||!Number.isSafeInteger(release.id)||release.id<1)throw new Error('개발 번호 예약 대상이 test-latest가 아닙니다.');
   const old=ledgerFromBody(release.body),next=ledgerFromBody(body),record=next.allocations.at(-1);
   if(next.allocations.length!==old.allocations.length+1||JSON.stringify(next.allocations.slice(0,-1))!==JSON.stringify(old.allocations)||record.build.buildNumber!==ciBuildNumber(env)||record.build.commit!==env.GITHUB_SHA||record.history!==null||JSON.stringify(pointerFromBody(release.body))!==JSON.stringify(pointerFromBody(body)))throw new Error('현재 실행의 새 예약 한 건만 추가할 수 있습니다.');
   return request(`/releases/${release.id}`,{method:'PATCH',body:{body,prerelease:true,make_latest:'false'}});
  }
 };
}
export async function assignMetadata({input,publish=false,store}) {
 let release=await store.getRelease();
 const check=value=>{if(value&&(value.tag_name!==TAG||value.draft||!value.prerelease||value.immutable))throw new Error('test-latest 공개 테스트 릴리즈만 사용할 수 있습니다.');};
 check(release);
 const originalBody=release?.body||'',pointer=pointerFromBody(originalBody),ledger=ledgerFromBody(originalBody);
 const allocation=allocateDevelopment(ledger,input,pointer?.commit||null);
 if(publish&&!allocation.reused){
  if(!release){release=await store.createRelease(allocation.record.build);check(release);if(release.body)throw new Error('새 테스트 릴리즈의 설명이 예상과 다릅니다.');}
  const latest=await store.getRelease();check(latest);
  if(latest.id!==release.id||String(latest.body||'')!==originalBody)throw new Error('예약 중 테스트 릴리즈가 변경되었습니다.');
  const body=replaceLedger(originalBody,allocation.ledger);
  await store.saveLedger(latest,body);
  const saved=await store.getRelease();check(saved);
  if(saved.id!==latest.id||saved.body!==body)throw new Error('개발 번호 예약 결과를 확인하지 못했습니다.');
 }
 return {build:allocation.record.build,baseCommit:allocation.record.baseCommit,reserved:publish,reused:allocation.reused};
}
export async function main(args=process.argv.slice(2),env=process.env) {
 if(args.length)throw new Error('개발 버전 metadata 명령에 추가 옵션을 사용할 수 없습니다.');
 const publish=env.REVIEWOPS_TEST_PUBLISH==='true';if(publish)assertAllocationCI(env);
 const version=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
 const value=await assignMetadata({input:{channel:'test',version,buildNumber:ciBuildNumber(env),commit:env.GITHUB_SHA,builtAt:new Date().toISOString()},publish,store:allocationStore({env})});
 const changes=await collectChangeNotes({build:value.build,baseCommit:value.baseCommit,resolveReferences:githubReferenceLookup({token:env.GITHUB_TOKEN})});
 const frozen=await freezeBuildContext(path.resolve('release/test-context/build-context.json'),{schema:1,build:value.build,baseCommit:value.baseCommit,changes});
 if(env.GITHUB_OUTPUT)await fs.appendFile(env.GITHUB_OUTPUT,`number=${value.build.buildNumber}\ndevelopment_number=${value.build.developmentNumber}\nbuilt_at=${value.build.builtAt}\nbase_commit=${value.baseCommit||''}\ncontext_sha=${frozen.sha256}\n`);
 return {...value,contextSha256:frozen.sha256,changedCommits:changes.totalCommits};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
