import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fileHash,jsonBytes,hash} from './test-release.mjs';
import {githubStore,uploadToDraft,REPOSITORY} from './upload-windows-release.mjs';
const run=promisify(execFile),root=fileURLToPath(new URL('..',import.meta.url));
const sha=value=>/^[a-f0-9]{40}$/.test(value||'');
export const TARGETS=['darwin-arm64','darwin-x64','win32-x64'];
const packageInputs=['src','electron','build','scripts','package.json','package-lock.json','release-plan.json','vite.config.*','LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt'];
export function parseVersion(value){
 if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw new Error('정식 버전은 1.2.3 형식을 사용하십시오.');
 const parts=value.split('.').map(Number);if(parts.some(part=>!Number.isSafeInteger(part)))throw new Error('버전 숫자가 너무 큽니다.');return parts;
}
export function nextVersion(previous,bump){
 const parts=parseVersion(previous),index={major:0,minor:1,patch:2}[bump];if(!['major','minor','patch'].includes(bump))throw new Error('patch, minor, major 중 하나를 명시적으로 선택하십시오.');
 parts[index]++;for(let i=index+1;i<3;i++)parts[i]=0;const version=parts.join('.');parseVersion(version);return version;
}
export function validatePolicy(policy,version){
 if(policy?.schema!==1||policy.version!==version||nextVersion(policy.previousVersion,policy.bump)!==version||!sha(policy.baseCommit)||typeof policy.reason!=='string'||!policy.reason.trim()||policy.reason.length>2000||policy.reason.includes('\0'))throw new Error('버전 선택 기록과 정식 버전이 일치하지 않습니다.');return policy;
}
async function git(args,directory=root){return (await run('git',args,{cwd:directory})).stdout.trim()}
export async function assertCleanSource(directory=root){if(await git(['status','--porcelain','--untracked-files=all','--',...packageInputs],directory))throw new Error('패키지 소스와 버전 선택 기록을 먼저 커밋하십시오.')}
export async function prepareVersion({bump,reason,write=false,directory=root}){
 const file=path.join(directory,'package.json'),lockFile=path.join(directory,'package-lock.json');
 const pkg=JSON.parse(await fs.readFile(file,'utf8')),lock=JSON.parse(await fs.readFile(lockFile,'utf8')),version=nextVersion(pkg.version,bump);
 if(lock.version!==pkg.version||lock.packages?.['']?.version!==pkg.version)throw new Error('package.json과 package-lock.json 버전이 다릅니다.');
 const policy=validatePolicy({schema:1,previousVersion:pkg.version,version,bump,reason,baseCommit:await git(['rev-parse','HEAD'],directory)},version);
 if(write){await assertCleanSource(directory);pkg.version=version;lock.version=version;lock.packages[''].version=version;await fs.writeFile(file,jsonBytes(pkg));await fs.writeFile(lockFile,jsonBytes(lock));await fs.writeFile(path.join(directory,'release-plan.json'),jsonBytes(policy));}
 return {...policy,written:write};
}
export async function validateSource({version,commit,directory=root}){
 parseVersion(version);if(!sha(commit)||await git(['rev-parse','HEAD'],directory)!==commit)throw new Error('검토한 전체 커밋 SHA와 작업 폴더가 다릅니다.');
 await assertCleanSource(directory);
 const pkg=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8')),lock=JSON.parse(await fs.readFile(path.join(directory,'package-lock.json'),'utf8'));
 if(pkg.version!==version||lock.version!==version||lock.packages?.['']?.version!==version)throw new Error('소스·잠금 파일·배포 버전이 일치하지 않습니다.');
 const policy=validatePolicy(JSON.parse(await fs.readFile(path.join(directory,'release-plan.json'),'utf8')),version);
 await git(['merge-base','--is-ancestor',policy.baseCommit,commit],directory);
 const previous=JSON.parse(await git(['show',`${policy.baseCommit}:package.json`],directory));if(previous.version!==policy.previousVersion)throw new Error('버전 선택 이전 커밋의 앱 버전이 다릅니다.');
 return policy;
}
export function assertDispatch({env=process.env,version,commit}){
 parseVersion(version);
 if(!sha(commit)||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPOSITORY||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_SHA!==commit||env.REVIEWOPS_REVIEWED_COMMIT!==commit||env.REVIEWOPS_RELEASE_TAG!==`v${version}`||env.GITHUB_WORKFLOW_REF!==`${REPOSITORY}/.github/workflows/stable-release.yml@refs/heads/main`)throw new Error('main의 검토한 커밋을 선택한 정식 배포 Actions에서 실행하십시오.');
}
export function assertDraftEnvironment({env=process.env,platform=process.platform,version,actualCommit}){
 assertDispatch({env,version,commit:actualCommit});if(platform!=='linux'||env.GITHUB_JOB!=='draft'||env.REVIEWOPS_DELIVER_TO_DRAFT!=='true')throw new Error('검증 후 명시적으로 선택한 draft 전달 작업만 허용합니다.');
}
export async function assertRemoteSource(plan,store){
 validatePolicy(plan.policy,plan.version);
 if(await store.getMainCommit()!==plan.commit)throw new Error('main이 검토한 커밋에서 변경되었습니다. 다시 검토하고 빌드하십시오.');
 const releases=await store.listReleases(),published=releases.filter(item=>!item.draft&&!item.prerelease&&/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(item.tag_name||''));
 published.sort((a,b)=>{const aa=parseVersion(a.tag_name.slice(1)),bb=parseVersion(b.tag_name.slice(1));for(let i=0;i<3;i++)if(aa[i]!==bb[i])return bb[i]-aa[i];return 0});
 if(published[0]?.tag_name!==`v${plan.policy.previousVersion}`)throw new Error('이전 정식 릴리즈가 버전 선택 기록과 다릅니다. 이미 게시한 버전은 재사용하지 않습니다.');
 const tagged=await store.getTagCommit(plan.tag);if(tagged&&tagged!==plan.commit)throw new Error('기존 정식 태그가 검토한 커밋과 다릅니다.');
}
export function namesForVersion(version){parseVersion(version);return [`ReviewOps-${version}-arm64.zip`,`ReviewOps-${version}-arm64.dmg`,`ReviewOps-${version}-x64.zip`,`ReviewOps-${version}-x64.dmg`,`ReviewOps-${version}-windows-x64.exe`]}
export function validateStablePlan(plan){
 validatePolicy(plan.policy,plan.version);if(!sha(plan.commit)||plan.tag!==`v${plan.version}`)throw new Error('정식 배포 커밋 또는 태그가 올바르지 않습니다.');
 const names=namesForVersion(plan.version),expected=new Set([...names,...names.map(name=>name+'.sha256'),'reviewops-update.json']);
 if(!Array.isArray(plan.files)||plan.files.length!==expected.size||new Set(plan.files.map(file=>file.name)).size!==expected.size)throw new Error('정식 설치파일 한 벌이 모두 필요합니다.');
 for(const file of plan.files)if(!expected.has(file.name)||!Number.isSafeInteger(file.size)||file.size<1||file.size>512*1024**2||!/^[a-f0-9]{64}$/.test(file.sha256||''))throw new Error('정식 배포 파일 정보가 올바르지 않습니다.');
}
export async function collectStable({directory,version,commit,policy}){
 validatePolicy(policy,version);if(!sha(commit))throw new Error('전체 소스 커밋 SHA가 필요합니다.');
 const files=[];
 for(const name of namesForVersion(version)){
  const filename=path.join(directory,name),info=await fs.lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.size<1024||info.size>512*1024**2)throw new Error('정식 설치파일이 없거나 올바르지 않습니다: '+name);
  files.push({name,filename,size:info.size,sha256:await fileHash(filename)});
 }
 const verification=[];
 for(const target of TARGETS){
  const reportFile=path.join(directory,`verification-${target}.json`),reportInfo=await fs.lstat(reportFile);if(!reportInfo.isFile()||reportInfo.isSymbolicLink()||reportInfo.size>4*1024**2)throw new Error('네이티브 검사 보고서가 올바르지 않습니다: '+target);
  const record=JSON.parse(await fs.readFile(reportFile,'utf8'));
  const required=['stable-package','source-match',...(target.startsWith('darwin')?['codesign','dmg-verify','zip-extraction','native-smoke']:['publisher-status','installed-application'])];
  if(record.schema!==1||record.ok!==true||record.channel!=='stable'||record.version!==version||record.commit!==commit||record.target!==target||record.platform+'-'+record.arch!==target||!Array.isArray(record.checks)||!required.every(check=>record.checks.includes(check))||record.testMetadataAbsent!==true)throw new Error('네이티브 정식 패키지 검사가 완료되지 않았습니다: '+target);
  const expected=files.filter(file=>target==='win32-x64'?file.name.endsWith('.exe'):file.name.endsWith(`-${target.split('-')[1]}.zip`)||file.name.endsWith(`-${target.split('-')[1]}.dmg`));
  if(target==='win32-x64'&&!['Valid','NotSigned'].includes(record.publisher?.status))throw new Error('Windows 설치파일 서명 상태 검사가 없습니다.');
  if(!Array.isArray(record.files)||record.files.length!==expected.length||!expected.every(file=>record.files.some(item=>item.name===file.name&&item.size===file.size&&item.sha256===file.sha256)))throw new Error('검사 뒤 설치파일이 변경되었습니다: '+target);
  verification.push(record);
 }
 const descriptor=file=>({name:file.name,url:`https://github.com/${REPOSITORY}/releases/download/v${version}/${file.name}`,size:file.size,sha256:file.sha256});
 const manifest={schema:1,version,artifacts:{'darwin-arm64':descriptor(files[0]),'darwin-x64':descriptor(files[2]),'win32-x64':descriptor(files[4])}};
 const generated=files.map(file=>({name:file.name+'.sha256',bytes:Buffer.from(`${file.sha256}  ${file.name}\n`)}));generated.push({name:'reviewops-update.json',bytes:jsonBytes(manifest)});
 for(const item of generated){await fs.writeFile(path.join(directory,item.name),item.bytes);files.push({...item,size:item.bytes.length,sha256:hash(item.bytes)})}
 const plan={version,commit,tag:`v${version}`,policy,files,verification};validateStablePlan(plan);return plan;
}
export async function deliverStableDraft(plan,store){
 validateStablePlan(plan);await store.assertPlanAllowed?.(plan);await assertRemoteSource(plan,store);
 if(!await store.getRelease(plan.tag)){await assertRemoteSource(plan,store);await store.createDraft(plan)}
 const guarded={...store,
  async getRelease(tag){if(await store.getMainCommit()!==plan.commit)throw new Error('업로드 중 main 커밋이 변경되었습니다.');return store.getRelease(tag)},
  async upload(release,file){if(await store.getMainCommit()!==plan.commit)throw new Error('업로드 전에 main 커밋이 변경되었습니다.');return store.upload(release,file)}
 };
 const result=await uploadToDraft(plan,guarded,{validatePlan:validateStablePlan});await assertRemoteSource(plan,store);return {...result,published:false};
}
function options(args){const values={};for(let i=0;i<args.length;i++){if(['--write','--deliver-to-draft'].includes(args[i]))values[args[i].slice(2)]=true;else{if(!['--bump','--reason','--version','--commit','--directory'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('정식 배포 명령의 옵션을 확인하십시오.');values[args[i].slice(2)]=args[++i]}}return values}
export async function main(args=process.argv.slice(2),env=process.env){
 const command=args.shift(),input=options(args);
 if(command==='version')return prepareVersion({bump:input.bump,reason:input.reason,write:!!input.write});
 if(!['check','collect','deliver'].includes(command))throw new Error('version, check, collect, deliver 명령을 사용하십시오.');
 const version=input.version||String(env.REVIEWOPS_RELEASE_TAG||'').slice(1),commit=input.commit||env.REVIEWOPS_REVIEWED_COMMIT,policy=await validateSource({version,commit});
 const store=githubStore({token:env.GITHUB_TOKEN||env.GH_TOKEN,env,assertEnvironment:assertDraftEnvironment});
 if(command==='check'){assertDispatch({env,version,commit});await assertRemoteSource({version,commit,tag:`v${version}`,policy},store);return {version,commit,policy}}
 const plan=await collectStable({directory:path.resolve(input.directory||'release/stable'),version,commit,policy});
 if(command==='deliver'){if(!input['deliver-to-draft'])throw new Error('초안 전달 옵션을 명시하십시오.');assertDraftEnvironment({env,version,actualCommit:commit});return deliverStableDraft(plan,store)}
 return {version,commit,tag:plan.tag,files:plan.files.map(({name,size,sha256})=>({name,size,sha256})),verification:plan.verification};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
