'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const load=()=>import('../scripts/stable-release.mjs');
const commit='a'.repeat(40),version='1.2.11',policy={schema:1,version,previousVersion:'1.2.10',bump:'patch',reason:'SSH folder diagnostic fix',baseCommit:'b'.repeat(40)};
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const env=()=>({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'season-framework/reviewops-local',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:commit,REVIEWOPS_REVIEWED_COMMIT:commit,REVIEWOPS_RELEASE_TAG:`v${version}`,REVIEWOPS_DELIVER_TO_DRAFT:'true',GITHUB_JOB:'draft',GITHUB_WORKFLOW_REF:'season-framework/reviewops-local/.github/workflows/stable-release.yml@refs/heads/main'});
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-stable-release-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const {namesForVersion}=await load(),files=[];
 for(const [index,name]of namesForVersion(version).entries()){const bytes=Buffer.alloc(1024,index+1);await fs.writeFile(path.join(directory,name),bytes);files.push({name,size:bytes.length,sha256:digest(bytes)})}
 for(const target of ['darwin-arm64','darwin-x64','win32-x64']){
  const selected=files.filter(file=>target==='win32-x64'?file.name.endsWith('.exe'):file.name.endsWith(`-${target.split('-')[1]}.zip`)||file.name.endsWith(`-${target.split('-')[1]}.dmg`));
  await fs.writeFile(path.join(directory,`verification-${target}.json`),JSON.stringify({schema:1,channel:'stable',version,commit,target,platform:target.split('-')[0],arch:target.split('-')[1],ok:true,testMetadataAbsent:true,...(target==='win32-x64'?{publisher:{status:'NotSigned'}}:{}),files:selected,checks:['stable-package','source-match',...(target.startsWith('darwin')?['codesign','dmg-verify','zip-extraction','native-smoke']:['publisher-status','installed-application'])]}));
 }
 return directory;
}
function memoryStore(plan,{exists=false}={}){
 let release=exists?{id:1,tag_name:plan.tag,target_commitish:plan.commit,draft:true,prerelease:false}:null,main=commit,tag=null,nextId=1;
 const assets=new Map(),writes=[];
 return {assets,writes,setMain:value=>main=value,setTag:value=>tag=value,setRelease:patch=>release={...release,...patch},
  async getMainCommit(){return main},async getTagCommit(){return tag},async listReleases(){return [{id:99,tag_name:'v1.2.10',draft:false,prerelease:false}]},async getRelease(){return release&&{...release}},
  async createDraft(){writes.push('create');release={id:1,tag_name:plan.tag,target_commitish:plan.commit,draft:true,prerelease:false};return release},
  async listAssets(){return [...assets.values()]},async verifyAsset(asset,file){assert.equal(asset.name,file.name);assert.equal(asset.size,file.size);assert.equal(asset.digest,`sha256:${file.sha256}`);return {method:'download-sha256'}},
  async upload(_release,file){writes.push(file.name);const asset={id:++nextId,name:file.name,size:file.size,state:'uploaded',digest:`sha256:${file.sha256}`};assets.set(asset.id,asset)},
 };
}
test('version selection is explicit and follows patch, feature, and breaking semantic increments',async()=>{
 const {nextVersion,validatePolicy}=await load();assert.equal(nextVersion('1.2.10','patch'),'1.2.11');assert.equal(nextVersion('1.2.10','minor'),'1.3.0');assert.equal(nextVersion('1.2.10','major'),'2.0.0');
 for(const [previous,bump]of [['1.2.10','auto'],['1.2.10','toString'],['01.2.10','patch'],['1.2.10-beta.1','patch'],['9007199254740991.0.0','major']])assert.throws(()=>nextVersion(previous,bump));
 assert.throws(()=>validatePolicy({...policy,bump:'minor'},version));assert.throws(()=>validatePolicy({...policy,reason:''},version));
});
test('draft write permission is limited to an explicit reviewed-main dispatch and delivery job',async()=>{
 const {assertDraftEnvironment}=await load(),valid={env:env(),platform:'linux',version,actualCommit:commit};assert.doesNotThrow(()=>assertDraftEnvironment(valid));
 for(const patch of [{GITHUB_ACTIONS:'false'},{GITHUB_REF:'refs/heads/other'},{GITHUB_SHA:'b'.repeat(40)},{GITHUB_JOB:'collect'},{GITHUB_EVENT_NAME:'push'},{REVIEWOPS_DELIVER_TO_DRAFT:'false'},{REVIEWOPS_RELEASE_TAG:'test-latest'},{GITHUB_REPOSITORY:'other/repository'},{GITHUB_WORKFLOW_REF:'season-framework/reviewops-local/.github/workflows/test-release.yml@refs/heads/main'}])assert.throws(()=>assertDraftEnvironment({...valid,env:{...env(),...patch}}));
 assert.throws(()=>assertDraftEnvironment({...valid,platform:'darwin'}));
});
test('native package collection binds all five installers, three reports, source SHA and checksum manifest',async t=>{
 const directory=await fixture(t),{collectStable}=await load(),plan=await collectStable({directory,version,commit,policy});assert.equal(plan.files.length,11);assert.equal(plan.verification.length,3);
 const manifest=JSON.parse(await fs.readFile(path.join(directory,'reviewops-update.json'),'utf8'));assert.equal(manifest.version,version);assert.equal(Object.keys(manifest.artifacts).length,3);assert.equal(manifest.artifacts['darwin-arm64'].sha256,plan.files[0].sha256);
 await fs.appendFile(path.join(directory,plan.files[0].name),'tampered');await assert.rejects(collectStable({directory,version,commit,policy}),/검사 뒤/);
});
for(const mutation of ['missing-target','wrong-commit','test-build','native-smoke-missing'])test(`collection rejects ${mutation} before any remote write`,async t=>{
 const directory=await fixture(t),{collectStable}=await load(),file=path.join(directory,'verification-darwin-arm64.json'),record=JSON.parse(await fs.readFile(file,'utf8'));
 if(mutation==='missing-target')await fs.rm(file);else{if(mutation==='wrong-commit')record.commit='c'.repeat(40);if(mutation==='test-build')record.testMetadataAbsent=false;if(mutation==='native-smoke-missing')record.checks=record.checks.filter(check=>check!=='native-smoke');await fs.writeFile(file,JSON.stringify(record))}
 await assert.rejects(collectStable({directory,version,commit,policy}));
});
test('delivery creates only a draft and retries reuse the same verified assets',async t=>{
 const directory=await fixture(t),{collectStable,deliverStableDraft}=await load(),plan=await collectStable({directory,version,commit,policy}),store=memoryStore(plan);
 const first=await deliverStableDraft(plan,store);assert.equal(first.draft,true);assert.equal(first.published,false);assert.equal(first.uploaded.length,11);assert.equal(store.writes[0],'create');
 const before=store.writes.length,again=await deliverStableDraft(plan,store);assert.equal(again.reused.length,11);assert.equal(store.writes.length,before);
});
for(const state of ['main-advanced','tag-moved','published','other-version','other-target','asset-conflict'])test(`draft delivery refuses ${state} without replacing files`,async t=>{
 const directory=await fixture(t),{collectStable,deliverStableDraft}=await load(),plan=await collectStable({directory,version,commit,policy}),store=memoryStore(plan,{exists:true});
 if(state==='main-advanced')store.setMain('c'.repeat(40));if(state==='tag-moved')store.setTag('c'.repeat(40));if(state==='published')store.setRelease({draft:false});if(state==='other-version')store.setRelease({tag_name:'v1.2.9'});if(state==='other-target')store.setRelease({target_commitish:'c'.repeat(40)});
 if(state==='asset-conflict'){const file=plan.files[0];store.assets.set(7,{id:7,name:file.name,state:'uploaded',size:file.size,digest:'sha256:'+'0'.repeat(64)})}
 await assert.rejects(deliverStableDraft(plan,store));assert.deepEqual(store.writes,[]);
});
test('main advancement or publication between uploads stops the remaining writes',async t=>{
 const directory=await fixture(t),{collectStable,deliverStableDraft}=await load(),plan=await collectStable({directory,version,commit,policy});
 for(const change of ['main','published']){const store=memoryStore(plan,{exists:true}),upload=store.upload;store.upload=async(...args)=>{await upload(...args);if(change==='main')store.setMain('d'.repeat(40));else store.setRelease({draft:false})};await assert.rejects(deliverStableDraft(plan,store));assert.equal(store.writes.length,1)}
});
test('stable archives exclude test identity and verify packaged source bytes',async t=>{
 const {inspectStableArchive}=await import('../scripts/stable-build.mjs'),asar=require('@electron/asar'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-stable-asar-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const source=path.join(directory,'source'),archive=path.join(directory,'app.asar');
 const content={'electron/main.cjs':'// fixture source','electron/codex/account-service.cjs':'// nested source from the failing Windows path','dist/index.html':'<html>fixture</html>','dist/assets/nested/한글 icon.svg':'<svg/>','LICENSE':'fixture license','NOTICE':'fixture notice','THIRD-PARTY-NOTICES.txt':'fixture third-party notices','package.json':JSON.stringify({version,main:'electron/main.cjs'})};
 for(const [name,bytes]of Object.entries(content)){const file=path.join(source,...name.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes)}await asar.createPackage(source,archive);
 const checked=await inspectStableArchive(archive,version,source);assert.equal(checked.testMetadataAbsent,true);assert.equal(checked.comparedFiles,Object.keys(content).length-1);
 await fs.appendFile(path.join(source,'electron','codex','account-service.cjs'),' changed');await assert.rejects(inspectStableArchive(archive,version,source),/소스와 다릅니다: electron\/codex\/account-service\.cjs/);
 await fs.writeFile(path.join(source,'electron/reviewops-build.json'),'{}');await asar.createPackage(source,archive);await assert.rejects(inspectStableArchive(archive,version,source),/허용하지 않은/);
});
test('the pinned ASAR reader requires native separators for nested Windows source paths',async()=>{
 const vm=require('node:vm'),{createRequire}=require('node:module'),entry=require.resolve('@electron/asar'),asarRequire=createRequire(entry),exports={};
 // Execute the actual pinned reader with Windows path semantics on every host.
 const reader=await fs.readFile(path.join(path.dirname(entry),'filesystem.js'),'utf8');
 vm.runInNewContext(reader,{exports,require:name=>name==='path'?path.win32:asarRequire(name),Buffer,process});
 const file={size:1,offset:'0'},archive=new exports.Filesystem('D:\\checkout with spaces');
 archive.setHeader({files:{electron:{files:{codex:{files:{'account-service.cjs':file}}}}}},0);
 const native=path.win32.relative('D:\\checkout with spaces','D:\\checkout with spaces\\electron\\codex\\account-service.cjs');
 assert.throws(()=>archive.getFile(native.replaceAll('\\','/')),/was not found in this archive/);
 assert.equal(archive.getFile(native),file);
});
test('version preparation updates only explicit version files and records the base commit',async t=>{
 const {prepareVersion,validateSource}=await load(),{execFile}=require('node:child_process'),{promisify}=require('node:util'),run=promisify(execFile),directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-version-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const git=async(...args)=>(await run('git',args,{cwd:directory})).stdout.trim();
 await git('init','-q');await git('config','user.name','Release fixture');await git('config','user.email','fixture@example.invalid');await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({version:'1.2.10'}));await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({version:'1.2.10',packages:{'':{version:'1.2.10'}}}));await git('add','.');await git('commit','-qm','Fixture source');
 const preview=await prepareVersion({bump:'minor',reason:'Compatible new review feature',directory});assert.equal(preview.version,'1.3.0');assert.equal((await git('status','--porcelain')),'');
 const written=await prepareVersion({bump:'minor',reason:'Compatible new review feature',write:true,directory});assert.equal(written.written,true);await assert.rejects(prepareVersion({bump:'patch',reason:'Would overwrite uncommitted release choice',write:true,directory}),/먼저 커밋/);
 await git('add','.');await git('commit','-qm','Choose release version');const actual=await git('rev-parse','HEAD');assert.equal((await validateSource({version:'1.3.0',commit:actual,directory})).bump,'minor');await assert.rejects(validateSource({version:'1.3.0',commit:'e'.repeat(40),directory}));
});
test('stable renderer preserves reviewed notices when optional packages are absent on a native checkout',async t=>{
 const {assertCleanSource}=await load(),{buildRenderer}=await import('../scripts/test-build.mjs'),{execFile}=require('node:child_process'),{promisify}=require('node:util'),run=promisify(execFile);
 // Spaces and Unicode exercise native cwd/script paths, including Windows
 // checkouts. All commands execute real files; no shell or URL pathname is used.
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops native 경로 '));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const git=async(...args)=>(await run('git',args,{cwd:directory})).stdout.trim();
 await fs.mkdir(path.join(directory,'scripts'));await fs.mkdir(path.join(directory,'node_modules/cpu-features'),{recursive:true});
 await fs.copyFile(path.join(__dirname,'../scripts/licenses.mjs'),path.join(directory,'scripts/licenses.mjs'));
 await fs.writeFile(path.join(directory,'scripts/copy-locales.mjs'),'// Synthetic no-op locale copy; Vite build below is real.\n');
 await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'synthetic-renderer',version:'1.0.0',type:'module',private:true}));
 await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({packages:{'node_modules/cpu-features':{version:'0.0.10',optional:true}}}));
 await fs.writeFile(path.join(directory,'node_modules/cpu-features/package.json'),JSON.stringify({name:'cpu-features',version:'0.0.10',license:'MIT'}));
 await fs.writeFile(path.join(directory,'node_modules/cpu-features/LICENSE'),'SYNTHETIC OPTIONAL LICENSE\n');
 await fs.writeFile(path.join(directory,'index.html'),'<!doctype html><title>Native renderer fixture</title>');
 await fs.writeFile(path.join(directory,'.gitignore'),'node_modules/\ndist/\n');
 await run(process.execPath,[path.join(directory,'scripts/licenses.mjs')],{cwd:directory});
 const notices=await fs.readFile(path.join(directory,'THIRD-PARTY-NOTICES.txt'));assert.match(notices.toString(),/cpu-features 0\.0\.10/);
 await git('init','-q');await git('config','user.name','Release fixture');await git('config','user.email','fixture@example.invalid');await git('add','.');await git('commit','-qm','Reviewed fixture');
 await fs.rm(path.join(directory,'node_modules/cpu-features'),{recursive:true});
 // Reproduce the old packaging path: successful renderer build dirties the
 // tracked notices solely because an optional dependency was not installed.
 await buildRenderer({directory});await assert.rejects(assertCleanSource(directory),/THIRD-PARTY-NOTICES\.txt/);
 await fs.writeFile(path.join(directory,'THIRD-PARTY-NOTICES.txt'),notices);await assertCleanSource(directory);
 await buildRenderer({directory,generateLicenses:false});await assertCleanSource(directory);
 assert.deepEqual(await fs.readFile(path.join(directory,'THIRD-PARTY-NOTICES.txt')),notices);assert.match(await fs.readFile(path.join(directory,'dist/index.html'),'utf8'),/Native renderer fixture/);
 await fs.appendFile(path.join(directory,'scripts/copy-locales.mjs'),'// unreviewed change\n');await assert.rejects(assertCleanSource(directory),/scripts\/copy-locales\.mjs/);
 const stable=await fs.readFile(path.join(__dirname,'../scripts/stable-build.mjs'),'utf8');assert.ok(stable.includes('buildRenderer({generateLicenses:false})'));assert.ok(stable.includes('await validateSource({version,commit});await buildNativePackage'));
});

test('workflow keeps native targets, reviewed SHA, read-only collection and explicit draft delivery',async()=>{
 const text=(await fs.readFile(path.join(__dirname,'../.github/workflows/stable-release.yml'),'utf8')).replace(/\r\n/g,'\n');
 assert.match(text,/group: reviewops-stable-release\n  cancel-in-progress: false/);assert.match(text,/deliver_to_draft:[\s\S]*?default: false/);
 for(const runner of ['macos-15','macos-15-intel','windows-latest'])assert.ok(text.includes('runner: '+runner));
 assert.match(text,/ref: \$\{\{ needs.metadata.outputs.commit \}\}/);assert.match(text,/draft:\n    if: inputs.deliver_to_draft == true/);assert.equal((text.match(/contents: write/g)||[]).length,1);
 assert.ok(text.includes('node scripts/stable-release.mjs check'));assert.ok(text.includes('node scripts/stable-release.mjs deliver --directory release/stable --deliver-to-draft'));assert.equal(text.includes('schedule:'),false);assert.equal(text.includes('gh release edit'),false);
});
test('real draft adapter fixes draft=true and rejects mismatched version input before transmission',async()=>{
 const {githubStore}=await import('../scripts/upload-windows-release.mjs'),{assertDraftEnvironment}=await load(),calls=[];
 const store=githubStore({token:'synthetic-only',env:env(),platform:'linux',assertEnvironment:assertDraftEnvironment,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({id:3,tag_name:`v${version}`,target_commitish:commit,draft:true,prerelease:false,immutable:false})}});
 await store.createDraft({version,commit,tag:`v${version}`});const body=JSON.parse(calls[0].options.body);assert.equal(body.draft,true);assert.equal(body.prerelease,false);assert.equal(body.target_commitish,commit);assert.equal(calls[0].options.headers['Content-Type'],'application/json');
 await assert.rejects(store.createDraft({version:'1.3.0',commit,tag:'v1.3.0'}));assert.equal(calls.length,1);
});
test('a created draft ID bypasses a stale listing and is still re-read before use',async()=>{
 const {githubStore}=await import('../scripts/upload-windows-release.mjs'),{assertDraftEnvironment}=await load(),calls=[];
 let release={id:71,tag_name:`v${version}`,target_commitish:commit,draft:true,prerelease:false,immutable:false};
 const store=githubStore({token:'synthetic-only',env:env(),platform:'linux',assertEnvironment:assertDraftEnvironment,fetchImpl:async(input,options)=>{
  const url=new URL(input);calls.push({path:url.pathname,method:options.method});
  if(options.method==='POST'){assert.ok(url.pathname.endsWith('/releases'));return Response.json(release)}
  if(url.pathname.endsWith('/releases'))return Response.json([]); // Creation is not yet visible in listing.
  assert.ok(url.pathname.endsWith('/releases/71'));return Response.json(release);
 }});
 const plan={version,commit,tag:`v${version}`};assert.equal(await store.getRelease(plan.tag),null);
 await store.createDraft(plan);assert.equal((await store.getRelease(plan.tag)).id,71);
 release={...release,draft:false};assert.equal((await store.getRelease(plan.tag)).draft,false);
 assert.equal(calls.filter(call=>call.method==='GET'&&call.path.endsWith('/releases')).length,1);
 assert.equal(calls.filter(call=>call.path.endsWith('/releases/71')).length,2);
});
test('invalid draft creation responses cannot seed a cached release identity',async()=>{
 const {githubStore}=await import('../scripts/upload-windows-release.mjs'),{assertDraftEnvironment}=await load();
 for(const patch of [{id:null},{draft:false},{prerelease:true},{immutable:true},{target_commitish:'c'.repeat(40)},{tag_name:'v9.0.0'}]){
  const calls=[],store=githubStore({token:'synthetic-only',env:env(),platform:'linux',assertEnvironment:assertDraftEnvironment,fetchImpl:async(input,options)=>{
   calls.push({path:new URL(input).pathname,method:options.method});
   return Response.json(options.method==='POST'?{id:71,tag_name:`v${version}`,target_commitish:commit,draft:true,prerelease:false,immutable:false,...patch}:[]);
  }});
  await assert.rejects(store.createDraft({version,commit,tag:`v${version}`}),/기존 정식 draft/);
  assert.equal(await store.getRelease(`v${version}`),null);assert.equal(calls.length,2);assert.equal(calls[1].path.endsWith('/releases'),true);
 }
});

test('collection requires the recorded Windows signature result',async t=>{
 const directory=await fixture(t),{collectStable}=await load(),file=path.join(directory,'verification-win32-x64.json'),report=JSON.parse(await fs.readFile(file,'utf8'));delete report.publisher;await fs.writeFile(file,JSON.stringify(report));await assert.rejects(collectStable({directory,version,commit,policy}),/서명 상태/);
});
