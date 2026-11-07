import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {REPOSITORY,TAG,PUBLICATION_GROUP,namesFor,prepareRelease,publishRelease,pointerFromBody} from './test-release.mjs';
import {githubReleaseStore} from './test-release-github.mjs';
import {validateBuildContext,contextHash,consumeBuildContext} from './test-build-context.mjs';
import {allocateDevelopment,ledgerFromBody,requireAllocation,replaceLedger} from './test-development-ledger.mjs';
const require=createRequire(import.meta.url),{validateBuildInfo}=require('../electron/build-info.cjs');
const run=promisify(execFile),sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fullSHA=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const targets=['darwin-arm64','darwin-x64','win32-x64'];
const artifactNames=['reviewops-test-build-context',...targets.map(target=>'reviewops-test-build-'+target)];
const publicationStep='Publish the complete build and remove previous test packages';
const maxArchive=768*1024**2;
const fail=message=>{throw new Error(message);};
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function exact(value,keys){return value&&Object.getPrototypeOf(value)===Object.prototype&&same(Object.keys(value).sort(),[...keys].sort());}
export function validateCandidate(value){
 if(!exact(value,['schema','runId','runAttempt','source','contextSHA256','qaNotBefore','artifacts'])||value.schema!==1||!positive(value.runId)||!positive(value.runAttempt)||value.runAttempt>999||!fullSHA(value.source)||!sha(value.contextSHA256)||!validDate(value.qaNotBefore)||!Array.isArray(value.artifacts)||value.artifacts.length!==4)fail('An exact reviewed producer candidate is required.');
 const ids=new Set(),names=new Set();
 for(const item of value.artifacts){
  if(!exact(item,['id','name','digest'])||!positive(item.id)||!artifactNames.includes(item.name)||!/^sha256:[a-f0-9]{64}$/.test(item.digest)||ids.has(item.id)||names.has(item.name))fail('Producer artifact identities must be complete and unique.');
  ids.add(item.id);names.add(item.name);
 }
 return structuredClone(value);
}
export function assertPromotionCI(env,{write=false}={}){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REPOSITORY!==REPOSITORY||env.GITHUB_JOB!=='publish'||!String(env.GITHUB_WORKFLOW_REF||'').startsWith(REPOSITORY+'/.github/workflows/promote-test-release.yml@')||env.REVIEWOPS_PUBLICATION_GROUP!==PUBLICATION_GROUP||!fullSHA(env.GITHUB_SHA)||!positive(Number(env.GITHUB_RUN_ID))||!positive(Number(env.GITHUB_RUN_NUMBER))||!positive(Number(env.GITHUB_RUN_ATTEMPT))||write&&env.REVIEWOPS_TEST_PUBLISH!=='true')fail('Promotion requires its explicit Actions workflow and shared publication lock.');
}
export function assertProducerPublication(build,producerBuild,env){
 assertPromotionCI(env,{write:true});
 if(build&&!same(validateBuildInfo(build),producerBuild))fail('The publisher may publish only its authenticated original producer build.');
}
export function verifyProducer(candidate,{run:producer,workflow,jobs,artifacts}){
 candidate=validateCandidate(candidate);
 if(!producer||producer.id!==candidate.runId||producer.run_attempt!==candidate.runAttempt||producer.head_sha!==candidate.source||producer.head_repository?.full_name!==REPOSITORY||producer.repository?.full_name!==REPOSITORY||producer.path!=='.github/workflows/test-release.yml'||producer.workflow_id!==workflow?.id||producer.event!=='workflow_dispatch'||producer.status!=='completed'||producer.conclusion!=='success'||!positive(producer.run_number))fail('The selected producer is not the exact successful repository preflight.');
 const find=name=>{const found=jobs.filter(job=>job.name===name);if(found.length!==1||found[0].run_id!==producer.id||found[0].run_attempt!==producer.run_attempt||found[0].status!=='completed'||found[0].conclusion!=='success')fail('Required producer jobs must succeed in the same selected attempt.');return found[0];};
 const metadata=find('metadata'),publication=find('publish');
 const packageJobs=new Map(targets.map(target=>{const found=jobs.filter(job=>job.name.startsWith('package ('+target+','));if(found.length!==1)fail('The producer native job set is incomplete.');return[target,find(found[0].name)];}));
 const steps=publication.steps?.filter(step=>step.name===publicationStep);
 if(steps?.length!==1||steps[0].conclusion!=='skipped')fail('Only a preflight whose publication was skipped can be promoted.');
 const selected=candidate.artifacts.map(expected=>{
  const byName=artifacts.filter(item=>item.name===expected.name),actual=artifacts.find(item=>item.id===expected.id);
  if(byName.length!==1||actual!==byName[0]||actual.digest!==expected.digest||actual.expired!==false||!positive(actual.size_in_bytes)||actual.size_in_bytes>maxArchive||actual.workflow_run?.id!==producer.id||actual.workflow_run?.head_sha!==producer.head_sha||actual.workflow_run?.head_repository_id!==producer.repository.id||actual.workflow_run?.repository_id!==producer.repository.id)fail('Producer artifacts are missing, ambiguous, expired or have changed provenance/digests.');
  const job=expected.name.endsWith('-context')?metadata:packageJobs.get(expected.name.slice('reviewops-test-build-'.length));
  if(!job||![actual.created_at,job.started_at,job.completed_at].every(value=>Number.isFinite(Date.parse(value)))||Date.parse(actual.created_at)<Date.parse(job.started_at)||Date.parse(actual.created_at)>Date.parse(job.completed_at))fail('Producer artifact creation does not belong to the selected native job attempt.');
  return {...expected,size:actual.size_in_bytes};
 });
 return {candidate,producer,metadataJobId:metadata.id,artifacts:selected};
}
export function verifyPreflightLog(text,context){
 // The original metadata output is a pretty JSON object, after timestamp stripping.
 const lines=text.replace(/^\d{4}-\d\d-\d\dT[0-9:.]+Z /gm,'').split('\n'),values=[];
 for(let start=0;start<lines.length;start++)if(lines[start].trim()==='{'){
  let end=start+1;while(end<lines.length&&lines[end].trim()!=='}')end++;
  if(end<lines.length)try{const value=JSON.parse(lines.slice(start,end+1).join('\n'));if(Object.hasOwn(value,'reserved')&&Object.hasOwn(value,'contextSha256'))values.push(value);}catch{}
 }
 if(values.length!==1||values[0].reserved!==false||!same(validateBuildInfo(values[0].build),context.build)||values[0].baseCommit!==context.baseCommit||values[0].contextSha256!==context.sha256)fail('Original metadata must prove this exact context was an unreserved preflight.');
}
export function reservationFor(plan,release){
 if(!release||release.tag_name!==TAG||release.draft||!release.prerelease||release.immutable)fail('Promotion requires the existing mutable test-latest release.');
 const ledger=ledgerFromBody(release.body),pointer=pointerFromBody(release.body),base=plan.manifest.changes?.baseCommit;
 if(pointer?.buildNumber===plan.build.buildNumber){if(!same(pointer,plan.pointer))fail('The producer build is already public with a different pointer.');requireAllocation(ledger,plan.build,base);return {ledger,reused:true};}
 if((pointer?.commit||null)!==base||pointer&&pointer.buildNumber>=plan.build.buildNumber)fail('The frozen producer predecessor is no longer current.');
 const existing=ledger.allocations.find(record=>record.build.buildNumber===plan.build.buildNumber);
 if(existing){requireAllocation(ledger,plan.build,base);return {ledger,reused:true};}
 const {developmentNumber,...input}=plan.build,result=allocateDevelopment(ledger,input,base);
 if(result.reused||!same(result.record.build,plan.build)||result.record.build.developmentNumber!==developmentNumber)fail('The predicted producer development identity is no longer available.');
 return {ledger:result.ledger,reused:false};
}
export async function reserveProducer(plan,store,{dryRun=true}={}){
 const original=await store.getRelease(),result=reservationFor(plan,original);
 if(dryRun||result.reused)return result;
 const latest=await store.getRelease();if(latest?.id!==original.id||latest.body!==original.body)fail('The release changed before producer reservation.');
 const body=replaceLedger(original.body,result.ledger);
 await store.setPointer(original.id,body);
 const saved=await store.getRelease();if(saved?.id!==original.id||saved.body!==body)fail('Producer reservation was not confirmed; retry this exact candidate.');
 return result;
}
const koreanDate=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export function verifyQA(record,candidate,plan,now=new Date()){
 const files=plan.assets.filter(file=>file.filename).slice(0,5).map(({name,size,sha256})=>({name,size,sha256}));
 if(!exact(record,['schema','koreanDate','passed','build','contextSHA256','packages','reportSHA256'])||record.schema!==1||record.passed!==true||!validDate(record.koreanDate)||record.koreanDate<candidate.qaNotBefore||record.koreanDate>koreanDate(now)||!same(validateBuildInfo(record.build),plan.build)||record.contextSHA256!==candidate.contextSHA256||!same(record.packages,files)||!sha(record.reportSHA256))fail('Publication requires an eligible completed whole-product QA declaration bound to these exact producer packages.');
}
async function responseBytes(response,maximum,filename){
 if(!response.ok||!response.body)fail('Producer download failed.');
 const digest=crypto.createHash('sha256'),chunks=[];let size=0,handle;
 if(filename)handle=await fs.open(filename,'wx',0o600);
 try{for await(const chunk of response.body){size+=chunk.length;if(size>maximum)fail('Producer download exceeds the expected bound.');digest.update(chunk);if(handle)await handle.writeFile(chunk);else chunks.push(chunk);}}
 finally{await handle?.close();}
 return {size,sha256:digest.digest('hex'),...(filename?{}:{bytes:Buffer.concat(chunks)})};
}
export function producerAPI({token,fetchImpl=fetch}){
 const api='https://api.github.com/repos/'+REPOSITORY;
 const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ReviewOps-Test-Promotion',...(token?{Authorization:'Bearer '+token}:{})};
 async function json(suffix){const response=await fetchImpl(api+suffix,{redirect:'error',headers,signal:AbortSignal.timeout(30000)});if(!response.ok)fail('Producer API read failed: HTTP '+response.status);return response.json();}
 async function list(suffix,key){const values=[];for(let page=1;page<=10;page++){const body=await json(suffix+'?per_page=100&page='+page),rows=body[key];if(!Array.isArray(rows))fail('Invalid producer API page.');values.push(...rows);if(rows.length<100)return values;}fail('Producer metadata exceeds the bounded page limit.');}
 async function download(suffix,maximum,filename){
  let response=await fetchImpl(api+suffix,{redirect:'manual',headers,signal:AbortSignal.timeout(120000)});
  if([301,302,303,307,308].includes(response.status)){
   const url=new URL(response.headers.get('location'));
   if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname.endsWith('.blob.core.windows.net')||url.hostname.endsWith('.actions.githubusercontent.com')||['objects.githubusercontent.com','productionresultssa0.blob.core.windows.net'].includes(url.hostname)))fail('Untrusted producer download redirect.');
   response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(120000)}); // Never forward the token to artifact storage.
  }
  return responseBytes(response,maximum,filename);
 }
 return {json,list,download};
}
export async function preparePromotion(candidate,{api,directory,extract,readHistoricalCatalog}={}){
 candidate=validateCandidate(candidate);
 const [producer,workflow,jobs,artifacts]=await Promise.all([api.json('/actions/runs/'+candidate.runId),api.json('/actions/workflows/test-release.yml'),api.list('/actions/runs/'+candidate.runId+'/attempts/'+candidate.runAttempt+'/jobs','jobs'),api.list('/actions/runs/'+candidate.runId+'/artifacts','artifacts')]);
 const authority=verifyProducer(candidate,{run:producer,workflow,jobs,artifacts});
 await fs.mkdir(directory,{recursive:true});
 const extractArchive=extract||((archive,destination,names)=>run('python3',[fileURLToPath(new URL('./extract-test-promotion.py',import.meta.url)),archive,destination,JSON.stringify(names)],{timeout:120000,maxBuffer:1024*1024}));
 async function receive(item,names){const archive=path.join(directory,item.id+'.zip'),downloaded=await api.download('/actions/artifacts/'+item.id+'/zip',item.size,archive);if(downloaded.size!==item.size||'sha256:'+downloaded.sha256!==item.digest)fail('Downloaded producer archive digest/size does not match its pinned original artifact.');const target=path.join(directory,item.name);await extractArchive(archive,target,names);return target;}
 const contextArtifact=authority.artifacts.find(item=>item.name.endsWith('-context')),contextDirectory=await receive(contextArtifact,['build-context.json']);
 const contextFile=path.join(contextDirectory,'build-context.json'),contextBytes=await fs.readFile(contextFile);
 if(contextBytes.length>2*1024**2||contextHash(contextBytes)!==candidate.contextSHA256)fail('The original frozen context hash does not match.');
 const context=validateBuildContext(JSON.parse(contextBytes));
 if(![producer.created_at,producer.updated_at,context.build.builtAt].every(value=>Number.isFinite(Date.parse(value)))||Date.parse(context.build.builtAt)<Date.parse(producer.created_at)||Date.parse(context.build.builtAt)>Date.parse(producer.updated_at)||context.build.commit!==candidate.source||Math.floor(context.build.buildNumber/1000)!==producer.run_number||context.build.buildNumber%1000!==candidate.runAttempt||!context.build.developmentNumber)fail('The producer context does not match the selected source/run/attempt.');
 const metadata=await api.download('/actions/jobs/'+authority.metadataJobId+'/logs',10*1024**2);
 verifyPreflightLog(metadata.bytes.toString('utf8'),{...context,sha256:candidate.contextSHA256});
 const combined=path.join(directory,'release');await fs.mkdir(combined);
 await fs.copyFile(contextFile,path.join(combined,'build-context.json'),fs.constants.COPYFILE_EXCL);
 await fs.writeFile(path.join(combined,'build-info.json'),JSON.stringify(context.build));
 for(const target of targets){
  const expected=namesFor(context.build).filter(name=>target==='win32-x64'?name.endsWith('.exe'):name.endsWith('-'+target.slice(7)+'.zip')||name.endsWith('-'+target.slice(7)+'.dmg'));
  const artifact=authority.artifacts.find(item=>item.name==='reviewops-test-build-'+target),folder=await receive(artifact,[...expected,'build-info.json','verification-'+target+'.json']);
  if(!same(validateBuildInfo(JSON.parse(await fs.readFile(path.join(folder,'build-info.json'),'utf8'))),context.build))fail('Native package build identities do not agree.');
  for(const name of [...expected,'verification-'+target+'.json'])await fs.copyFile(path.join(folder,name),path.join(combined,name),fs.constants.COPYFILE_EXCL);
 }
 await consumeBuildContext({filename:path.join(combined,'build-context.json'),directory:combined,expectedHash:candidate.contextSHA256});
 const plan=await prepareRelease(combined,context.build,{catalogCommit:candidate.source,readHistoricalCatalog});
 // These source-specific native gates are required for promoted Ops packages too.
 for(const record of plan.verification)if(!['native-owned-service-16','ops-package-source','ops-native-smoke'].every(check=>record.checks.includes(check)))fail('Producer native package acceptance is incomplete.');
 return {plan,authority,context,directory:combined,metadataLogSHA256:metadata.sha256};
}
export async function main(env=process.env){
 assertPromotionCI(env);
 const candidate=validateCandidate(JSON.parse(env.REVIEWOPS_PROMOTION_CANDIDATE||'')),publish=env.REVIEWOPS_TEST_PUBLISH==='true';
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-test-promotion-'));
 const prepared=await preparePromotion(candidate,{api:producerAPI({token:env.GITHUB_TOKEN}),directory});
 const authorize=build=>assertProducerPublication(build,prepared.plan.build,env);
 const store=githubReleaseStore({token:env.GITHUB_TOKEN,authorize,repository:REPOSITORY,tag:TAG});
 const receipt={schema:1,publisher:{runId:Number(env.GITHUB_RUN_ID),runNumber:Number(env.GITHUB_RUN_NUMBER),runAttempt:Number(env.GITHUB_RUN_ATTEMPT),source:env.GITHUB_SHA},producer:candidate,build:prepared.plan.build,metadataLogSHA256:prepared.metadataLogSHA256,stage:'prepared',publicationOutcome:'not-started',published:null};
 const saveReceipt=async()=>{await fs.mkdir('release/test-promotion',{recursive:true});await fs.writeFile('release/test-promotion/receipt.json',JSON.stringify(receipt,null,2)+'\n');};
 await saveReceipt(); // Retain the authenticated producer/publisher before any public mutation.
 try{
  const qaDeclaration=publish?JSON.parse(env.REVIEWOPS_PROMOTION_QA||''):null;
  if(publish)verifyQA(qaDeclaration,candidate,prepared.plan);
  receipt.qaDeclaration=qaDeclaration;receipt.stage='qa-declaration-accepted';await saveReceipt();
  const reservation=await reserveProducer(prepared.plan,store,{dryRun:!publish});
  receipt.reservationReused=reservation.reused;receipt.stage='reservation-complete';await saveReceipt();
  receipt.publicationOutcome=publish?'unconfirmed':'preview';receipt.stage='publication-started';await saveReceipt();
  receipt.result=await publishRelease(prepared.plan,store,{dryRun:!publish});
  receipt.published=publish;receipt.publicationOutcome=publish?'confirmed':'preview';receipt.stage='complete';
  return receipt;
 }catch(error){receipt.failedStage=receipt.stage;receipt.stage='failed';throw error;}
 finally{await saveReceipt();} // A failed job may already have switched the pointer; retain that uncertainty.
 // Producer artifacts are not deleted here; preserve originals through reporting.
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
