'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile);
const {validateBuildInfo,displayBuildVersion,validateChangeNotes,matchesLegacyBuild}=require('../electron/build-info.cjs');
const build={channel:'test',version:'1.2.11',buildNumber:11001,commit:'a'.repeat(40),builtAt:'2026-11-01T16:00:00.000Z'};
test('version labels distinguish real development metadata, legacy builds and stable versions',async()=>{
 const renderer=await import('../src/build-version.mjs');
 for(const [info,want] of [[build,'1.2.11-test.11001'],[{...build,developmentNumber:2},'1.2.11-dev-2'],[{...build,developmentNumber:10},'1.2.11-dev-10'],[{channel:'stable',version:'1.2.11'},'1.2.11']]){
  assert.equal(displayBuildVersion(info),want);assert.equal(renderer.displayBuildVersion(info),want);
 }
 for(const developmentNumber of [0,-1,'2',1.2,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateBuildInfo({...build,developmentNumber}));
 assert.deepEqual(validateBuildInfo(build),build);
});
test('legacy remembered identity may omit only the development number and still requires exact core fields',()=>{
 const actual={...build,developmentNumber:1};assert.equal(matchesLegacyBuild(actual,build),true);assert.equal(matchesLegacyBuild(actual,actual),true);
 for(const patch of [{version:'1.2.10'},{buildNumber:11002},{commit:'b'.repeat(40)},{builtAt:'2026-11-01T16:00:01.000Z'},{developmentNumber:2}])assert.equal(matchesLegacyBuild(actual,{...build,...patch}),false);
 assert.equal(matchesLegacyBuild(build,actual),false);assert.throws(()=>matchesLegacyBuild(actual,{...build,developmentNumber:0}));
});
test('change notes reject mismatched identity, control text, duplicate commits and misleading missing base',()=>{
 const notes={schema:1,baseCommit:'b'.repeat(40),commit:build.commit,totalCommits:1,commits:[{commit:build.commit,subject:'Fix test versions (#41)'}]};
 assert.deepEqual(validateChangeNotes(notes,build.commit),notes);
 for(const value of [{...notes,commit:'c'.repeat(40)},{...notes,totalCommits:0},{...notes,baseCommit:null},{...notes,commits:[...notes.commits,...notes.commits],totalCommits:2},{...notes,commits:[{commit:build.commit,subject:'secret\nsecond line'}]}])assert.throws(()=>validateChangeNotes(value,build.commit));
});
test('change collection reports only actual commits after the public predecessor and rejects unrelated history',async t=>{
 const {collectChangeNotes}=await import('../scripts/test-release-notes.mjs');
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-change-range-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 const git=(...args)=>run('git',args,{cwd});
 await git('init','--quiet');await git('config','user.name','Synthetic QA');await git('config','user.email','qa@example.invalid');
 await fs.writeFile(path.join(cwd,'file'),'one');await git('add','file');await git('commit','--quiet','-m','Old public build');
 const baseCommit=(await git('rev-parse','HEAD')).stdout.trim();
 await fs.writeFile(path.join(cwd,'file'),'two');await git('commit','--quiet','-am','Show development version (#41)');
 const commit=(await git('rev-parse','HEAD')).stdout.trim();
 const actual=await collectChangeNotes({cwd,baseCommit,build:{...build,commit}});
 assert.equal(actual.totalCommits,1);assert.equal(actual.commits[0].subject,'Show development version (#41)');assert.equal(actual.commits[0].commit,commit);
 const empty=await collectChangeNotes({cwd,baseCommit:commit,build:{...build,commit}});assert.equal(empty.totalCommits,0);
 const unknown=await collectChangeNotes({cwd,baseCommit:null,build:{...build,commit}});assert.equal(unknown.baseCommit,null);assert.deepEqual(unknown.commits,[]);
 await assert.rejects(collectChangeNotes({cwd,baseCommit:'f'.repeat(40),build:{...build,commit}}));
});
test('public predecessor lookup reads the genuine release pointer and propagates lookup failures',async()=>{
 const {publicPreviousCommit}=await import('../scripts/test-release-notes.mjs');
 const pointer={schema:1,buildNumber:8001,commit:'b'.repeat(40),manifest:`reviewops-test-update-8001-${'b'.repeat(12)}.json`,size:100,sha256:'c'.repeat(64)};
 const value={tag_name:'test-latest',draft:false,prerelease:true,body:`<!-- reviewops-test-pointer:${JSON.stringify(pointer)} -->`};
 assert.equal(await publicPreviousCommit(async()=>Response.json(value)),pointer.commit);
 assert.equal(await publicPreviousCommit(async()=>new Response(null,{status:404})),null);
 await assert.rejects(publicPreviousCommit(async()=>new Response(null,{status:403})));
 await assert.rejects(publicPreviousCommit(async()=>Response.json({...value,draft:true})));
});
