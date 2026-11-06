'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createZip}=require('../electron/archive.cjs');
const promotion=import('../scripts/test-release-promotion.mjs'),release=import('../scripts/test-release.mjs'),ledgers=import('../scripts/test-development-ledger.mjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const build={channel:'test',version:'1.6.0',buildNumber:54001,commit:'a'.repeat(40),builtAt:'2026-11-06T18:01:00.000Z',developmentNumber:2};
const base='b'.repeat(40),targets=['darwin-arm64','darwin-x64','win32-x64'];
const context={schema:1,build,baseCommit:base,changes:{schema:1,baseCommit:base,commit:build.commit,totalCommits:1,commits:[{commit:build.commit,subject:'Add accepted Ops behavior'}]}};
const bytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const publisherEnv={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'season-framework/reviewops-local',GITHUB_JOB:'publish',GITHUB_WORKFLOW_REF:'season-framework/reviewops-local/.github/workflows/promote-test-release.yml@refs/heads/main',REVIEWOPS_PUBLICATION_GROUP:'reviewops-test-latest',REVIEWOPS_TEST_PUBLISH:'true',GITHUB_SHA:'f'.repeat(40),GITHUB_RUN_ID:'55000',GITHUB_RUN_NUMBER:'55',GITHUB_RUN_ATTEMPT:'1'};
async function fixture(t){
 const p=await promotion,m=await release,directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-promotion-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const repo={id:7,full_name:'season-framework/reviewops-local'},producer={id:54000,run_number:54,run_attempt:1,head_sha:build.commit,head_repository:repo,repository:repo,path:'.github/workflows/test-release.yml',workflow_id:9,event:'workflow_dispatch',status:'completed',conclusion:'success',created_at:'2026-11-06T18:00:00Z',updated_at:'2026-11-06T18:10:00Z'};
 const job=(name,id)=>({name,id,run_id:producer.id,run_attempt:1,status:'completed',conclusion:'success',started_at:producer.created_at,completed_at:producer.updated_at});
 const jobs=[job('metadata',1),job('publish',2),...targets.map((target,i)=>job('package ('+target+', native, arch)',3+i))];jobs[1].steps=[{name:'Publish the complete build and remove previous test packages',conclusion:'skipped'}];
 const contextBytes=bytes(context),archiveBytes=new Map();let next=10;
 function artifact(name,entries){const id=next++,archive=createZip(entries);archiveBytes.set(id,archive);return {id,name,digest:'sha256:'+hash(archive),size_in_bytes:archive.length,expired:false,created_at:'2026-11-06T18:05:00Z',workflow_run:{id:producer.id,head_sha:producer.head_sha,repository_id:7,head_repository_id:7}};}
 const artifacts=[artifact('reviewops-test-build-context',[{name:'build-context.json',bytes:contextBytes}])];
 for(const target of targets){const names=m.namesFor(build).filter(name=>target==='win32-x64'?name.endsWith('.exe'):name.endsWith('-'+target.slice(7)+'.zip')||name.endsWith('-'+target.slice(7)+'.dmg'));
  const files=names.map(name=>({name,bytes:Buffer.alloc(1200,name.length)}));
  const record={schema:1,target,ok:true,build,checks:['packaged-build-info','package-structure','codesign','dmg-verify','zip-extraction','native-smoke','publisher-status','installed-application','native-owned-service-16','ops-package-source','ops-native-smoke'],files:files.map(file=>({name:file.name,size:file.bytes.length,sha256:hash(file.bytes)}))};
  artifacts.push(artifact('reviewops-test-build-'+target,[...files,{name:'build-info.json',bytes:bytes(build)},{name:'verification-'+target+'.json',bytes:bytes(record)}]));
 }
 const candidate={schema:1,runId:producer.id,runAttempt:1,source:build.commit,contextSHA256:hash(contextBytes),qaNotBefore:'2026-11-08',artifacts:artifacts.map(({id,name,digest})=>({id,name,digest}))};
 const metadata={build,baseCommit:base,reserved:false,reused:false,contextSha256:candidate.contextSHA256,changedCommits:1};
 const api={json:async suffix=>suffix.includes('/workflows/')?{id:9}:structuredClone(producer),list:async(_suffix,key)=>structuredClone(key==='jobs'?jobs:artifacts),download:async(suffix,_maximum,filename)=>{const value=suffix.endsWith('/logs')?Buffer.from(bytes(metadata).toString().split('\n').map(line=>'2026-11-06T18:01:00.0000000Z '+line).join('\n')):archiveBytes.get(Number(suffix.split('/').at(-2)));if(filename)await fs.writeFile(filename,value);return {size:value.length,sha256:hash(value),...(filename?{}:{bytes:value})};}};
 return {p,m,directory,producer,jobs,artifacts,candidate,api,archiveBytes,contextBytes,metadata};
}
async function prepared(t){const f=await fixture(t);return {...f,...await f.p.preparePromotion(f.candidate,{api:f.api,directory:f.directory,readHistoricalCatalog:async()=>null})};}
async function storeFor(plan){const l=await ledgers,m=await release,previous={...build,buildNumber:52001,developmentNumber:1,commit:base};let current={id:1,tag_name:'test-latest',draft:false,prerelease:true,body:l.replaceLedger(m.marker+JSON.stringify({schema:1,buildNumber:previous.buildNumber,commit:base,manifest:'reviewops-test-update-52001-'+base.slice(0,12)+'.json',size:100,sha256:'c'.repeat(64)})+' -->',{schema:1,allocations:[{build:previous,baseCommit:null,history:null}]})};
 const writes=[];return {writes,getRelease:async()=>structuredClone(current),setPointer:async(_id,body)=>{writes.push(body);current={...current,body};},set:value=>{current=value;}};
}
test('explicit promotion pins the original producer while retaining the actual distinct publisher identity',async t=>{
 const f=await prepared(t);assert.deepEqual(f.plan.build,build);assert.equal(f.plan.verification.length,3);assert.equal(f.plan.assets.length,22);assert.equal(f.authority.metadataJobId,1);
 assert.doesNotThrow(()=>f.p.assertProducerPublication(build,build,publisherEnv));
 assert.throws(()=>f.m.assertPublicationCI(build,{...publisherEnv,GITHUB_WORKFLOW_REF:publisherEnv.GITHUB_WORKFLOW_REF.replace('promote-test-release.yml','test-release.yml')}),/다릅니다/);
 for(const patch of [{commit:'e'.repeat(40)},{buildNumber:55001},{developmentNumber:3},{builtAt:'2026-11-07T18:01:00.000Z'}])assert.throws(()=>f.p.assertProducerPublication({...build,...patch},build,publisherEnv),/only its authenticated/);
 assert.equal(publisherEnv.GITHUB_SHA,'f'.repeat(40));assert.equal(publisherEnv.GITHUB_RUN_NUMBER,'55');
});
test('promotion authority requires manual explicit publication and the shared workflow lock',async()=>{
 const p=await promotion;for(const patch of [{GITHUB_EVENT_NAME:'push'},{GITHUB_JOB:'metadata'},{GITHUB_WORKFLOW_REF:publisherEnv.GITHUB_WORKFLOW_REF.replace('promote-test-release','test-release')},{REVIEWOPS_PUBLICATION_GROUP:'other'},{GITHUB_REPOSITORY:'other/repository'},{REVIEWOPS_TEST_PUBLISH:'false'}])assert.throws(()=>p.assertProducerPublication(build,build,{...publisherEnv,...patch}));
 assert.doesNotThrow(()=>p.assertPromotionCI({...publisherEnv,REVIEWOPS_TEST_PUBLISH:'false'}));
});
test('wrong source, repository, run, workflow, attempt and published producer are rejected before artifact use',async t=>{
 const f=await fixture(t),verify=patch=>f.p.verifyProducer(f.candidate,{run:{...f.producer,...patch},workflow:{id:9},jobs:f.jobs,artifacts:f.artifacts});
 for(const patch of [{head_sha:'d'.repeat(40)},{id:123},{run_attempt:2},{workflow_id:10},{event:'push'},{conclusion:'failure'},{head_repository:{full_name:'other/repo'}}])assert.throws(()=>verify(patch),/exact successful/);
 const jobs=structuredClone(f.jobs);jobs[1].steps[0].conclusion='success';assert.throws(()=>f.p.verifyProducer(f.candidate,{run:f.producer,workflow:{id:9},jobs,artifacts:f.artifacts}),/publication was skipped/);
});
test('artifact selection refuses changed digest, expired input, duplicate names and mixed native attempts',async t=>{
 const f=await fixture(t),verify=(artifacts=f.artifacts,jobs=f.jobs)=>f.p.verifyProducer(f.candidate,{run:f.producer,workflow:{id:9},jobs,artifacts});
 for(const patch of [{digest:'sha256:'+'f'.repeat(64)},{expired:true},{workflow_run:{...f.artifacts[0].workflow_run,id:123}},{created_at:'2026-11-07T00:00:00Z'}]){const artifacts=structuredClone(f.artifacts);Object.assign(artifacts[0],patch);assert.throws(()=>verify(artifacts));}
 assert.throws(()=>verify([...f.artifacts,{...f.artifacts[0],id:999}]));const jobs=structuredClone(f.jobs);jobs[2].run_attempt=2;assert.throws(()=>verify(f.artifacts,jobs),/same selected attempt/);
 const duplicate=structuredClone(f.candidate);duplicate.artifacts[1]=duplicate.artifacts[0];assert.throws(()=>f.p.validateCandidate(duplicate),/unique/);
});
test('changed archive bytes fail before extraction despite an unchanged API artifact descriptor',async t=>{
 const f=await fixture(t),item=f.candidate.artifacts[0];f.archiveBytes.set(item.id,Buffer.from('changed'));
 await assert.rejects(f.p.preparePromotion(f.candidate,{api:f.api,directory:f.directory,extract:()=>{throw new Error('must not extract');}}),/digest\/size/);
});
test('context tampering and a metadata publication reservation cannot become producer authority',async t=>{
 const f=await fixture(t),bad={...f.candidate,contextSHA256:'f'.repeat(64)};
 await assert.rejects(f.p.preparePromotion(bad,{api:f.api,directory:f.directory}),/context hash/);
 const p=await promotion;assert.throws(()=>p.verifyPreflightLog(bytes({...f.metadata,reserved:true}).toString(),{...context,sha256:f.candidate.contextSHA256}),/unreserved preflight/);
 assert.throws(()=>p.verifyPreflightLog(bytes({...f.metadata,build:{...build,builtAt:'2026-11-07T18:01:00.000Z'}}).toString(),{...context,sha256:f.candidate.contextSHA256}));
});
test('preview reserves nothing and exact promotion retries reserve only one original producer identity',async t=>{
 const f=await prepared(t),store=await storeFor(f.plan),l=await ledgers;
 const preview=await f.p.reserveProducer(f.plan,store);assert.equal(preview.reused,false);assert.equal(store.writes.length,0);
 await f.p.reserveProducer(f.plan,store,{dryRun:false});assert.equal(store.writes.length,1);let ledger=l.ledgerFromBody((await store.getRelease()).body);assert.deepEqual(ledger.allocations.at(-1).build,build);assert.equal(ledger.allocations.at(-1).baseCommit,base);
 const again=await f.p.reserveProducer(f.plan,store,{dryRun:false});assert.equal(again.reused,true);assert.equal(store.writes.length,1);assert.equal((await release).pointerFromBody((await store.getRelease()).body).buildNumber,52001);
});
test('stale predecessor, occupied predicted dev number, duplicate ledger and changed reservation stop without writes',async t=>{
 const f=await prepared(t),l=await ledgers,m=await release;
 for(const mode of ['stale','occupied','duplicate','changed']){const store=await storeFor(f.plan),current=await store.getRelease(),ledger=l.ledgerFromBody(current.body);
  if(mode==='stale')current.body=current.body.replaceAll(base,'d'.repeat(40));
  else if(mode==='occupied'){const {developmentNumber,...input}=build;current.body=l.replaceLedger(current.body,l.allocateDevelopment(ledger,{...input,buildNumber:53001,commit:'c'.repeat(40)},base).ledger);}
  else if(mode==='duplicate')current.body=current.body.replace(l.ledgerComment(ledger),JSON.stringify({})+l.ledgerComment(ledger)+l.ledgerComment(ledger));
  else current.body=l.replaceLedger(current.body,{schema:1,allocations:[...ledger.allocations,{build:{...build,builtAt:'2026-11-07T18:01:00.000Z'},baseCommit:base,history:null}]});
  store.set(current);await assert.rejects(f.p.reserveProducer(f.plan,store,{dryRun:false}));assert.equal(store.writes.length,0,mode);
 }
});
test('external body changes before reservation prevent mutation',async t=>{
 const f=await prepared(t),store=await storeFor(f.plan),original=store.getRelease;let n=0;store.getRelease=async()=>{const current=await original();if(++n===2)current.body+='External edit';return current;};await assert.rejects(f.p.reserveProducer(f.plan,store,{dryRun:false}),/changed before/);assert.equal(store.writes.length,0);
});
test('whole-product QA declaration binds eligible date, exact build, original context and package bytes',async t=>{
 const f=await prepared(t),qa={schema:1,koreanDate:'2026-11-08',passed:true,build,contextSHA256:f.candidate.contextSHA256,packages:f.plan.assets.filter(item=>item.filename).slice(0,5).map(({name,size,sha256})=>({name,size,sha256})),reportSHA256:'d'.repeat(64)};
 assert.doesNotThrow(()=>f.p.verifyQA(qa,f.candidate,f.plan,new Date('2026-11-07T15:05:00Z')));
 for(const patch of [{koreanDate:'2026-11-07'},{koreanDate:'2026-11-09'},{passed:false},{contextSHA256:'f'.repeat(64)},{build:{...build,buildNumber:55001}},{packages:qa.packages.slice(1)}])assert.throws(()=>f.p.verifyQA({...qa,...patch},f.candidate,f.plan,new Date('2026-11-07T15:05:00Z')));
});
test('producer highlights use the original source catalog instead of newer publisher catalog',async t=>{
 const {loadReleaseHighlights}=await import('../scripts/release-notes-format.mjs');let first;
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-promotion-catalog-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const entry={category:'features',title:'Original accepted behavior',description:'Preserve the reviewed producer feature summary.',commits:[build.commit]};
 await fs.writeFile(path.join(directory,'release-notes.json'),JSON.stringify({schema:1,version:build.version,entries:[{...entry,title:'Later publisher summary'}]}));
 const highlights=await loadReleaseHighlights({directory,version:build.version,changes:context.changes,catalogCommit:build.commit,readHistoricalCatalog:async commit=>{first??=commit;return {schema:1,version:build.version,entries:[entry]};}});
 assert.equal(first,build.commit);assert.deepEqual(highlights,[entry]);
});
test('artifact redirect verifies bytes without forwarding the Actions token to storage',async t=>{
 const p=await promotion,value=Buffer.from('original authenticated archive'),calls=[],directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-promotion-download-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const api=p.producerAPI({token:'synthetic-test-token',fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://example.blob.core.windows.net/artifact'}}):new Response(value);}});
 const output=await api.download('/actions/artifacts/10/zip',value.length,path.join(directory,'original.zip'));
 assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-test-token');assert.equal(calls[1].options.headers,undefined);assert.equal(output.sha256,hash(value));assert.deepEqual(await fs.readFile(path.join(directory,'original.zip')),value);
 const denied=p.producerAPI({token:'synthetic-test-token',fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://attacker.example/artifact'}})});
 await assert.rejects(denied.download('/actions/artifacts/10/zip',100),/Untrusted/);
});
test('promotion accepts only real calendar dates and never rebuilds after missing producer artifacts',async t=>{
 const f=await fixture(t);assert.throws(()=>f.p.validateCandidate({...f.candidate,qaNotBefore:'2026-02-30'}));let downloads=0;
 f.api.list=async(_suffix,key)=>key==='jobs'?f.jobs:[];f.api.download=async()=>{downloads++;throw new Error('must not download');};await assert.rejects(f.p.preparePromotion(f.candidate,{api:f.api,directory:f.directory}),/artifacts/);assert.equal(downloads,0);
});
test('workflow promotion is manual, default read-only, serialized and contains no build or package jobs',async()=>{
 const yaml=require('js-yaml'),workflow=yaml.load(await fs.readFile(path.join(__dirname,'../.github/workflows/promote-test-release.yml'),'utf8'));
 assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);assert.equal(workflow.on.workflow_dispatch.inputs.publish.default,false);assert.equal(workflow.concurrency.group,'reviewops-test-latest');assert.equal(workflow.concurrency['cancel-in-progress'],false);assert.deepEqual(Object.keys(workflow.jobs),['publish']);assert.equal(workflow.jobs.publish.permissions.actions,'read');
 const commands=workflow.jobs.publish.steps.map(step=>step.run||'').join('\n');assert.match(commands,/test-release-promotion/);assert.doesNotMatch(commands,/npm ci|package|test-build|test-development-metadata|GITHUB_RUN_ID=/);
});
