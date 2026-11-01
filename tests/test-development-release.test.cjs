'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process'),Module=require('node:module');
const crypto=require('node:crypto');
const {createZip}=require('../electron/archive.cjs');
const {testManifestFor,createUpdateManager,TEST_RELEASE_API}=require('../electron/updates.cjs');
const release=import('../scripts/test-release.mjs'),ledgerModule=import('../scripts/test-development-ledger.mjs'),metadataModule=import('../scripts/test-development-metadata.mjs');
const build=(number=11001,developmentNumber=1,version='1.2.11')=>({channel:'test',version,buildNumber:number,developmentNumber,commit:number.toString(16).padStart(40,'0'),builtAt:'2026-11-01T16:00:00.000Z'});
const withoutDevelopment=value=>{const {developmentNumber,...rest}=value;return rest;};
function legacyUpdater(){
 const code=execFileSync('git',['show','176bea3a2b8d604515e0849692fb822318745b49:electron/updates.cjs'],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
 const old=new Module(path.join(__dirname,'../electron/legacy-updater.cjs'));old.filename=path.join(__dirname,'../electron/legacy-updater.cjs');old.paths=Module._nodeModulePaths(path.dirname(old.filename));old._compile(code,old.filename);return old.exports;
}
async function fixture(t,info=build(),baseCommit=null){
 const m=await release,l=await ledgerModule,directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-dev-release-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const files=[];
 for(const name of m.namesFor(info)){const bytes=Buffer.alloc(1200,info.buildNumber%251);await fs.writeFile(path.join(directory,name),bytes);files.push({name,size:bytes.length,sha256:m.hash(bytes)});}
 for(const target of ['darwin-arm64','darwin-x64','win32-x64'])await fs.writeFile(path.join(directory,`verification-${target}.json`),JSON.stringify({schema:1,target,ok:true,build:info,checks:['packaged-build-info','package-structure','codesign','dmg-verify','zip-extraction','native-smoke','publisher-status','installed-application'],files}));
 const changes={schema:1,baseCommit,commit:info.commit,totalCommits:baseCommit?1:0,commits:baseCommit?[{commit:info.commit,subject:'Improve development versions (#41)'}]:[]};
 await fs.writeFile(path.join(directory,'change-notes.json'),JSON.stringify(changes));
 return {m,l,directory,info,changes,plan:await m.prepareRelease(directory,info)};
}
async function memoryStore(initialLedger={schema:1,allocations:[]}){
 const m=await release,l=await ledgerModule;let id=1;
 let current={id:1,tag_name:'test-latest',draft:false,prerelease:true,body:l.replaceLedger('',initialLedger)};
 const assets=new Map(),writes=[];
 const store={assets,writes,getRelease:async()=>({...current}),listAssets:async()=>[...assets.values()],hashAsset:async asset=>m.hash(assets.get(asset.id).bytes),assetExists:async id=>assets.has(id),
  upload:async(_,file)=>{const bytes=file.bytes||await fs.readFile(file.filename);const value={id:++id,name:file.name,size:bytes.length,state:'uploaded',bytes};assets.set(value.id,value);writes.push('upload:'+file.name);},
  setPointer:async(_,body,name)=>{current={...current,body,name};writes.push('switch')},deleteAsset:async id=>{assets.delete(id);writes.push('delete:'+id)},
  saveLedger:async(_,body)=>{current={...current,body};writes.push('ledger')},setRelease:value=>{current=value},
  reserve:info=>{const result=l.allocateDevelopment(l.ledgerFromBody(current.body),withoutDevelopment(info),m.pointerFromBody(current.body)?.commit||null);current.body=l.replaceLedger(current.body,result.ledger);return result.record;}
 };
 return store;
}
test('development allocation is per base version, numeric and immutable across metadata retries',async()=>{
 const l=await ledgerModule;let ledger={schema:1,allocations:[]};
 for(let n=1;n<=10;n++){const next=l.allocateDevelopment(ledger,withoutDevelopment(build(10000+n)),null);assert.equal(next.record.build.developmentNumber,n);ledger=next.ledger;}
 const retry=l.allocateDevelopment(ledger,{...withoutDevelopment(build(10002)),builtAt:'2026-11-02T16:00:00.000Z'},'b'.repeat(40));
 assert.equal(retry.reused,true);assert.equal(retry.record.build.developmentNumber,2);assert.equal(retry.record.build.builtAt,build().builtAt);assert.equal(retry.record.baseCommit,null);
 assert.equal(l.allocateDevelopment(ledger,withoutDevelopment(build(20001,1,'1.2.12')),null).record.build.developmentNumber,1);
 assert.throws(()=>l.allocateDevelopment(ledger,{...withoutDevelopment(build(10002)),commit:'f'.repeat(40)},null),/다른 소스/);
});
test('malformed, duplicate or changed published allocation records fail closed',async()=>{
 const l=await ledgerModule,allocated=l.allocateDevelopment({schema:1,allocations:[]},withoutDevelopment(build()),null);
 assert.throws(()=>l.validateLedger({schema:1,allocations:[allocated.record,allocated.record]}),/중복/);
 assert.throws(()=>l.ledgerFromBody(l.ledgerComment(allocated.ledger)+l.ledgerComment(allocated.ledger)),/중복/);
 assert.throws(()=>l.ledgerFromBody('<!-- reviewops-test-development:{"schema":1'),/손상/);
 const history={name:l.historyName(build()),size:100,sha256:'a'.repeat(64)},published=l.publishDevelopment(allocated.ledger,build(),null,history);
 assert.deepEqual(l.publishDevelopment(published,build(),null,history),published);
 assert.throws(()=>l.publishDevelopment(published,build(),null,{...history,sha256:'b'.repeat(64)}),/변경할 수/);
 assert.throws(()=>l.requireAllocation(published,{...build(),builtAt:'2026-11-02T16:00:00.000Z'},null),/패키지/);
});
test('preview does not reserve public numbers; a publishing metadata retry reuses the exact reservation',async()=>{
 const {assignMetadata}=await metadataModule,l=await ledgerModule,store=await memoryStore();
 const first=await assignMetadata({input:withoutDevelopment(build()),publish:false,store});assert.equal(first.build.developmentNumber,1);assert.deepEqual(store.writes,[]);
 const published=await assignMetadata({input:withoutDevelopment(build()),publish:true,store});assert.equal(published.reserved,true);assert.deepEqual(store.writes,['ledger']);
 const again=await assignMetadata({input:{...withoutDevelopment(build()),builtAt:'2026-11-03T00:00:00.000Z'},publish:true,store});assert.equal(again.reused,true);assert.deepEqual(again.build,published.build);assert.deepEqual(store.writes,['ledger']);
 assert.equal(l.ledgerFromBody((await store.getRelease()).body).allocations.length,1);
});
test('metadata rereads the public release and refuses an external body change before writing',async()=>{
 const {assignMetadata}=await metadataModule,store=await memoryStore(),read=store.getRelease;let reads=0;
 store.getRelease=async()=>{const value=await read();if(++reads===2)value.body+='External update';return value;};
 await assert.rejects(assignMetadata({input:withoutDevelopment(build()),publish:true,store}),/변경/);assert.deepEqual(store.writes,[]);
});
test('a truncated allocation ledger never resets the development sequence',async()=>{
 const {assignMetadata}=await metadataModule,store=await memoryStore(),current=await store.getRelease();store.setRelease({...current,body:'<!-- reviewops-test-development:{"schema":1'});
 await assert.rejects(assignMetadata({input:withoutDevelopment(build()),publish:true,store}),/손상/);assert.deepEqual(store.writes,[]);
});
test('metadata mutations require the matching workflow, metadata job, global lock and explicit publication',async()=>{
 const {assertAllocationCI,allocationStore}=await metadataModule;
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'season-framework/reviewops-local',GITHUB_JOB:'metadata',GITHUB_WORKFLOW_REF:'season-framework/reviewops-local/.github/workflows/test-release.yml@refs/heads/test',REVIEWOPS_PUBLICATION_GROUP:'reviewops-test-latest',REVIEWOPS_TEST_PUBLISH:'true',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_NUMBER:'11',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'synthetic-only'};
 assert.doesNotThrow(()=>assertAllocationCI(env));
 for(const patch of [{GITHUB_JOB:'publish'},{REVIEWOPS_TEST_PUBLISH:'false'},{REVIEWOPS_PUBLICATION_GROUP:'other'},{GITHUB_REPOSITORY:'other/repo'},{GITHUB_SHA:'short'}])assert.throws(()=>assertAllocationCI({...env,...patch}));
 let calls=0;assert.throws(()=>allocationStore({env:{},fetchImpl:async()=>{calls++;}}).saveLedger({id:1},'body'));assert.equal(calls,0);
});
test('the metadata API store can append only this run reservation while preserving the public pointer',async()=>{
 const {allocationStore}=await metadataModule,l=await ledgerModule,m=await release,info=build();
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'season-framework/reviewops-local',GITHUB_JOB:'metadata',GITHUB_WORKFLOW_REF:'season-framework/reviewops-local/.github/workflows/test-release.yml@refs/heads/test',REVIEWOPS_PUBLICATION_GROUP:'reviewops-test-latest',REVIEWOPS_TEST_PUBLISH:'true',GITHUB_SHA:info.commit,GITHUB_RUN_NUMBER:'11',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'synthetic-only'};
 const pointer={schema:1,buildNumber:8001,commit:'b'.repeat(40),manifest:`reviewops-test-update-8001-${'b'.repeat(12)}.json`,size:100,sha256:'c'.repeat(64)};
 const current={id:1,tag_name:'test-latest',draft:false,prerelease:true,body:`${m.marker}${JSON.stringify(pointer)} -->`};
 const allocation=l.allocateDevelopment({schema:1,allocations:[]},withoutDevelopment(info),pointer.commit),body=l.replaceLedger(current.body,allocation.ledger),calls=[];
 const store=allocationStore({env,fetchImpl:async(url,options)=>{calls.push({url,method:options.method,body:JSON.parse(options.body)});return Response.json({ok:true})}});
 await store.saveLedger(current,body);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.github.com/repos/season-framework/reviewops-local/releases/1');assert.equal(calls[0].method,'PATCH');assert.deepEqual(m.pointerFromBody(calls[0].body.body),pointer);
 assert.throws(()=>store.saveLedger({...current,tag_name:'v1.2.11'},body));
 assert.throws(()=>store.saveLedger(current,body.replace(pointer.commit,'d'.repeat(40))));
 const altered=l.allocateDevelopment({schema:1,allocations:[]},{...withoutDevelopment(info),commit:'f'.repeat(40)},pointer.commit);
 assert.throws(()=>store.saveLedger(current,l.replaceLedger(current.body,altered.ledger)));
 assert.equal(calls.length,1);
});
test('one verified byte set has canonical development names, legacy names and source-bound immutable history',async t=>{
 const {m,l,info,plan}=await fixture(t);
 assert.deepEqual(m.canonicalNamesFor(info),['ReviewOps-1.2.11-dev-1-arm64.zip','ReviewOps-1.2.11-dev-1-arm64.dmg','ReviewOps-1.2.11-dev-1-x64.zip','ReviewOps-1.2.11-dev-1-x64.dmg','ReviewOps-1.2.11-dev-1-windows-x64.exe']);
 for(const key of ['darwin-arm64','darwin-x64','win32-x64']){
  assert.equal(plan.manifest.artifacts[key].sha256,plan.manifest.developmentArtifacts[key].sha256);assert.equal(plan.manifest.artifacts[key].size,plan.manifest.developmentArtifacts[key].size);
 }
 assert.equal(plan.history.name,l.historyName(info));const history=JSON.parse(plan.assets.find(item=>item.name===plan.history.name).bytes);
 assert.deepEqual(history.build,info);assert.equal(history.manifest.sha256,plan.pointer.sha256);assert.equal(history.files.length,21);
});
test('existing deployed updater accepts legacy aliases while the new updater selects identical canonical bytes',async t=>{
 const {m,plan}=await fixture(t),published={tag_name:'test-latest',draft:false,prerelease:true,assets:plan.assets.map(item=>({name:item.name,size:item.size,browser_download_url:m.ROOT_URL+item.name}))};
 const old=legacyUpdater();
 for(const [platform,arch] of [['darwin','arm64'],['darwin','x64'],['win32','x64']]){
  const before=old.testManifestFor(plan.manifest,published,arch,'1.2.10',null,platform);
  const after=testManifestFor(plan.manifest,published,arch,'1.2.10',null,platform);
  assert.match(before.name,/-test\.11001-/);assert.match(after.name,/-dev-1-/);assert.equal(before.sha256,after.sha256);assert.equal(before.size,after.size);
 }
});
test('preferences written by the real legacy updater remain current after a development app starts',async t=>{
 const {m,plan,directory}=await fixture(t),old=legacyUpdater();
 const published={tag_name:'test-latest',draft:false,prerelease:true,body:`${m.marker}${JSON.stringify(plan.pointer)} -->`,assets:plan.assets.map(item=>({name:item.name,size:item.size,browser_download_url:m.ROOT_URL+item.name}))};
 for(const [platform,arch]of[['darwin','arm64'],['darwin','x64'],['win32','x64']]){
  const dataPath=path.join(directory,platform+'-'+arch),app={isPackaged:true,getVersion:()=> '1.2.10'};
  const options={app,dataPath,platform,arch,shell:{openExternal(){}},request:async url=>Buffer.from(JSON.stringify(url===TEST_RELEASE_API?published:plan.manifest))};
  const previous=old.createUpdateManager(options);t.after(()=>previous.close());
  const state=await previous.configure({testUpdates:true,automatic:false});assert.equal(state.status,'available');
  const saved=JSON.parse(await fs.readFile(path.join(dataPath,'updates/settings.json'),'utf8'));assert.equal(saved.highestTestBuild.developmentNumber,undefined);
  const current=createUpdateManager({...options,app:{...app,getVersion:()=>plan.build.version},buildInfo:plan.build});t.after(()=>current.close());
  const actual=await current.check();assert.equal(actual.status,'current');assert.equal(actual.errorCode,'');assert.equal(actual.availableVersion,null);assert.equal(actual.installedBuild.developmentNumber,1);
  assert.equal(testManifestFor(plan.manifest,published,arch,plan.build.version,plan.build,platform,saved.highestTestBuild),null);
  assert.throws(()=>testManifestFor(plan.manifest,published,arch,plan.build.version,{...plan.build,commit:'f'.repeat(40)},platform,saved.highestTestBuild),/같은 빌드번호/);
  assert.throws(()=>testManifestFor(plan.manifest,published,arch,plan.build.version,{...plan.build,developmentNumber:2},platform,saved.highestTestBuild));
 }
});
test('a pending installation written by the real legacy updater receives health acknowledgment from the development app',{skip:process.platform==='win32'?'Darwin app-bundle filesystem fixture requires POSIX paths; Windows installer contracts run separately.':false},async t=>{
 const old=legacyUpdater(),m=await release,directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-legacy-health-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const dataPath=path.join(directory,'data'),target=path.join(directory,'ReviewOps.app');await fs.mkdir(path.join(target,'Contents/MacOS'),{recursive:true});await fs.writeFile(path.join(target,'Contents/MacOS/ReviewOps'),'synthetic old executable');
 const executable=await fs.realpath(path.join(target,'Contents/MacOS/ReviewOps')),info=build(),bytes=createZip([{name:'ReviewOps.app/Contents/Info.plist',bytes:Buffer.from('synthetic plist')},{name:'ReviewOps.app/Contents/MacOS/ReviewOps',bytes:crypto.randomBytes(2048)}]);
 const name=`ReviewOps-${info.version}-test.${info.buildNumber}-x64.zip`,item={name,url:m.ROOT_URL+name,size:bytes.length,sha256:m.hash(bytes)},manifest={schema:2,channel:'test',version:info.version,build:info,artifacts:{'darwin-x64':item}},manifestBytes=m.jsonBytes(manifest),manifestName=m.manifestName(info),pointer={schema:1,buildNumber:info.buildNumber,commit:info.commit,manifest:manifestName,size:manifestBytes.length,sha256:m.hash(manifestBytes)};
 const published={tag_name:'test-latest',draft:false,prerelease:true,body:`${m.marker}${JSON.stringify(pointer)} -->`,assets:[{name,size:bytes.length,browser_download_url:item.url},{name:manifestName,size:manifestBytes.length,browser_download_url:m.ROOT_URL+manifestName}]};
 const app={isPackaged:true,getVersion:()=> '1.2.10',getPath:()=>executable,quit(){}};
 const manager=old.createUpdateManager({app,dataPath,platform:'darwin',arch:'x64',shell:{},inspect:async()=>{},command:async(_file,args)=>{await fs.mkdir(path.join(args.at(-1),'ReviewOps.app'),{recursive:true});return {stdout:''}},request:async(url,options)=>{
  if(url===TEST_RELEASE_API)return Buffer.from(JSON.stringify(published));if(url.endsWith('.json'))return manifestBytes;assert.equal(options.expectedHash,item.sha256);await fs.writeFile(options.filename,bytes);return {size:bytes.length};
 }});t.after(()=>manager.close());
 await manager.configure({testUpdates:true,automatic:false});const applying=await manager.apply();assert.equal(applying.status,'installing',applying.error);
 const pendingFile=path.join(dataPath,'updates/pending.json'),pending=JSON.parse(await fs.readFile(pendingFile,'utf8'));assert.equal(pending.build.developmentNumber,undefined);
 const current=createUpdateManager({app:{...app,getVersion:()=>info.version},dataPath,platform:'darwin',arch:'x64',shell:{},buildInfo:info});t.after(()=>current.close());
 current.markHealthy();const healthy=path.join(pending.job,'healthy');assert.equal(await fs.readFile(healthy,'utf8'),info.version);
 for(const patch of [{buildNumber:11002},{commit:'f'.repeat(40)},{builtAt:'2026-11-01T16:00:01.000Z'},{developmentNumber:2}]){
  await fs.rm(healthy);await fs.writeFile(pendingFile,JSON.stringify({...pending,build:{...pending.build,...patch}}));current.markHealthy();await assert.rejects(fs.stat(healthy),/ENOENT/);
  await fs.writeFile(pendingFile,JSON.stringify(pending));current.markHealthy();
 }
});
test('numeric development comparison handles 2 to 10, new base dev 1 and server rollback without lexical ordering',async t=>{
 const current=build(10001,2),{m,plan}=await fixture(t,build(11001,10),current.commit);
 const published={tag_name:'test-latest',draft:false,prerelease:true,assets:plan.assets.map(item=>({name:item.name,size:item.size,browser_download_url:m.ROOT_URL+item.name}))};
 assert.equal(testManifestFor(plan.manifest,published,'arm64','1.2.11',current).build.developmentNumber,10);
 assert.throws(()=>testManifestFor(plan.manifest,published,'arm64','1.2.11',{...current,developmentNumber:11}),/오래된/);
 assert.throws(()=>testManifestFor(plan.manifest,published,'arm64','1.2.11',{...current,developmentNumber:10}),/다른 빌드/);
 const next=await fixture(t,build(12001,1,'1.2.12'),plan.build.commit),nextPublished={...published,assets:next.plan.assets.map(item=>({name:item.name,size:item.size,browser_download_url:m.ROOT_URL+item.name}))};
 assert.equal(testManifestFor(next.plan.manifest,nextPublished,'arm64','1.2.11',plan.build).build.version,'1.2.12');
 assert.throws(()=>testManifestFor(plan.manifest,published,'arm64','1.2.10',null,'darwin',next.plan.build),/기본 버전/);
});
test('canonical aliases with different hashes cannot be presented as the same development build',async t=>{
 const {m,plan}=await fixture(t);plan.manifest.developmentArtifacts['darwin-arm64'].sha256='f'.repeat(64);
 const published={tag_name:'test-latest',draft:false,prerelease:true,assets:plan.assets.map(item=>({name:item.name,size:item.size,browser_download_url:m.ROOT_URL+item.name}))};
 assert.throws(()=>testManifestFor(plan.manifest,published,'arm64','1.2.10',null),/호환 파일/);
});
test('publication requires a public reservation before uploads, not just a display development number',async t=>{
 const {m,plan}=await fixture(t),store=await memoryStore();
 await assert.rejects(m.publishRelease(plan,store,{dryRun:false}),/예약/);assert.deepEqual(store.writes,[]);
});
test('publishing retains prior source-bound change history, replaces only packages and retries without overwriting',async t=>{
 const first=await fixture(t),store=await memoryStore();store.reserve(first.info);
 await first.m.publishRelease(first.plan,store,{dryRun:false});
 const firstBody=(await store.getRelease()).body;assert.match(firstBody,/1\.2\.11-dev-1/);
 const second=await fixture(t,build(12001,2),first.info.commit);store.reserve(second.info);
 await second.m.publishRelease(second.plan,store,{dryRun:false});
 assert.ok([...store.assets.values()].some(item=>item.name===first.plan.history.name));assert.ok([...store.assets.values()].some(item=>item.name===second.plan.history.name));
 assert.equal([...store.assets.values()].filter(item=>/ReviewOps-.*-test\.11001-/.test(item.name)).length,0);
 const publicRelease=await store.getRelease();assert.equal(publicRelease.name,'ReviewOps 테스트 1.2.11-dev-2');assert.match(publicRelease.body,/1\.2\.11-dev-1/);assert.match(publicRelease.body,/1\.2\.11-dev-2/);
 const before=store.writes.length;await second.m.publishRelease(second.plan,store,{dryRun:false});assert.equal(store.writes.length,before);
 await assert.rejects(first.m.publishRelease(first.plan,store,{dryRun:false}),/최신/);
 const changed={...second.plan,history:{...second.plan.history,sha256:'f'.repeat(64)}};await assert.rejects(second.m.publishRelease(changed,store,{dryRun:false}),/변경할 수/);assert.equal(store.writes.length,before);
});
test('a changed allocation during upload prevents pointer publication and package cleanup',async t=>{
 const {m,l,info,plan}=await fixture(t),store=await memoryStore();store.reserve(info);
 const original=store.upload;let changed=false;
 store.upload=async(...args)=>{await original(...args);if(!changed){changed=true;const r=await store.getRelease();const ledger=l.ledgerFromBody(r.body);ledger.allocations[0].baseCommit='c'.repeat(40);store.setRelease({...r,body:l.replaceLedger(r.body,ledger)});}};
 await assert.rejects(m.publishRelease(plan,store,{dryRun:false}),/할당 이력/);assert.equal(store.writes.includes('switch'),false);assert.equal(store.writes.some(item=>item.startsWith('delete:')),false);
});
test('commit subjects containing protocol markers remain text and cannot corrupt the release ledger',async t=>{
 const baseCommit='b'.repeat(40),f=await fixture(t,build(),baseCommit),store=await memoryStore(),current=await store.getRelease();
 const pointer={schema:1,buildNumber:8001,commit:baseCommit,manifest:`reviewops-test-update-8001-${baseCommit.slice(0,12)}.json`,size:100,sha256:'c'.repeat(64)};
 store.setRelease({...current,body:`${f.m.marker}${JSON.stringify(pointer)} -->`});store.reserve(f.info);
 const ref={kind:'pull_request',number:44,title:'Verified PR',url:'https://github.com/season-framework/reviewops-local/pull/44',via:'commit_association'};
 const changes={...f.changes,commits:[{commit:f.info.commit,subject:'Explain <!-- reviewops-test-development: metadata --> (#41)',references:[ref],referenceStatus:'verified'}]};await fs.writeFile(path.join(f.directory,'change-notes.json'),JSON.stringify(changes));
 const plan=await f.m.prepareRelease(f.directory,f.info);await f.m.publishRelease(plan,store,{dryRun:false});const body=(await store.getRelease()).body;
 assert.ok(body.includes('&lt;!-- reviewops-test-development: metadata --&gt;'));assert.ok(body.includes('[PR #44](https://github.com/season-framework/reviewops-local/pull/44)'));assert.deepEqual(JSON.parse(plan.assets.find(asset=>asset.name===plan.history.name).bytes).changes.commits[0].references,[ref]);assert.equal(f.l.ledgerFromBody(body).allocations.length,1);assert.equal(f.m.pointerFromBody(body).buildNumber,f.info.buildNumber);
});
test('a failed publication history remains immutable while a later complete build can publish',async t=>{
 const first=await fixture(t),store=await memoryStore();store.reserve(first.info);
 const history=first.plan.assets.find(asset=>asset.name===first.plan.history.name);await store.upload(await store.getRelease(),history);
 const next=await fixture(t,build(12001,2)),record=store.reserve(next.info);assert.equal(record.build.developmentNumber,2);
 await next.m.publishRelease(next.plan,store,{dryRun:false});
 assert.ok([...store.assets.values()].some(asset=>asset.name===history.name));
 assert.equal(next.m.pointerFromBody((await store.getRelease()).body).buildNumber,12001);
});
test('a missing or modified published history blocks all subsequent writes',async t=>{
 const first=await fixture(t),store=await memoryStore();store.reserve(first.info);await first.m.publishRelease(first.plan,store,{dryRun:false});
 const next=await fixture(t,build(12001,2),first.info.commit);store.reserve(next.info);
 const asset=[...store.assets.values()].find(item=>item.name===first.plan.history.name);asset.bytes=Buffer.alloc(asset.size,0);
 const before=store.writes.length;await assert.rejects(next.m.publishRelease(next.plan,store,{dryRun:false}),/이력 파일/);assert.equal(store.writes.length,before);
});
test('a frozen reference snapshot makes a partial-upload retry byte-identical after the PR title changes',async t=>{
 const baseCommit='b'.repeat(40),f=await fixture(t,build(),baseCommit),store=await memoryStore(),current=await store.getRelease(),c=await import('../scripts/test-build-context.mjs');
 const pointer={schema:1,buildNumber:8001,commit:baseCommit,manifest:`reviewops-test-update-8001-${baseCommit.slice(0,12)}.json`,size:100,sha256:'c'.repeat(64)};store.setRelease({...current,body:`${f.m.marker}${JSON.stringify(pointer)} -->`});store.reserve(f.info);
 const notes={...f.changes,commits:[{commit:f.info.commit,subject:'A source change',references:[{kind:'pull_request',number:44,title:'Original PR title',url:'https://github.com/season-framework/reviewops-local/pull/44',via:'commit_association'}],referenceStatus:'verified'}]},filename=path.join(f.directory,'build-context.json');
 const frozen=await c.freezeBuildContext(filename,{schema:1,build:f.info,baseCommit,changes:notes});await fs.writeFile(path.join(f.directory,'build-info.json'),JSON.stringify(f.info));await c.consumeBuildContext({filename,directory:f.directory,expectedHash:frozen.sha256});
 const original=await f.m.prepareRelease(f.directory,f.info),set=store.setPointer;let fail=true;store.setPointer=async(...args)=>{if(fail){fail=false;throw new Error('Injected response failure before pointer switch')}return set(...args)};
 await assert.rejects(f.m.publishRelease(original,store,{dryRun:false}),/Injected/);assert.equal(store.assets.size,22);
 const changed={...notes,commits:[{...notes.commits[0],references:[{...notes.commits[0].references[0],title:'Edited after upload'}]}]};await fs.writeFile(path.join(f.directory,'change-notes.json'),JSON.stringify(changed));
 await c.consumeBuildContext({filename,directory:f.directory,expectedHash:frozen.sha256});const retried=await f.m.prepareRelease(f.directory,f.info);assert.equal(retried.pointer.sha256,original.pointer.sha256);assert.deepEqual(retried.history,original.history);
 await f.m.publishRelease(retried,store,{dryRun:false});assert.equal(f.m.pointerFromBody((await store.getRelease()).body).buildNumber,f.info.buildNumber);
});
