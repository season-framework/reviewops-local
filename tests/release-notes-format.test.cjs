'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const load=()=>import('../scripts/release-notes-format.mjs');
const commit='a'.repeat(40),base='b'.repeat(40),other='c'.repeat(40);
const ref={kind:'pull_request',number:50,title:'원래 이슈 제목',url:'https://github.com/season-framework/reviewops-local/pull/50',via:'commit_association'};
const changes={schema:1,baseCommit:base,commit,totalCommits:2,commits:[{commit:other,subject:'Merge pull request #50',references:[ref],referenceStatus:'verified'},{commit,subject:'fix: keep web previews after reload',references:[ref],referenceStatus:'verified'}]};
const entry={category:'fixes',title:'Keep previews reliable after reload',description:'Reload a project while preserving newer previews and other projects.',commits:[commit]};

test('reviewed highlights are English, versioned and bound to complete actual commit ranges',async t=>{
 const {loadReleaseHighlights,validateReleaseHighlights}=await load(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-release-copy-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const catalog={schema:1,version:'1.3.0',entries:[entry,{...entry,title:'Unreleased feature',commits:['d'.repeat(40)]}]};await fs.writeFile(path.join(directory,'release-notes.json'),JSON.stringify(catalog));
 assert.deepEqual(await loadReleaseHighlights({version:'1.3.0',changes,directory}),[entry]);
 assert.deepEqual(await loadReleaseHighlights({version:'1.2.11',changes,directory}),[]);
 assert.deepEqual(await loadReleaseHighlights({version:'1.3.0',changes:{...changes,commits:[]},directory}),[]);
 for(const patch of [{title:'한국어 제목'},{description:'line\nbreak'},{category:'unknown'},{commits:['short']}])assert.throws(()=>validateReleaseHighlights({schema:1,version:'1.3.0',entries:[{...entry,...patch}]},'1.3.0'));
 const calls=[];await loadReleaseHighlights({version:'1.3.0',source:other,directory,command:async(command,args,options)=>{calls.push({command,args,options});return {stdout:''};}});assert.equal(calls.length,2);assert.ok(calls.every(call=>call.command==='git'&&call.args.slice(0,2).join(' ')==='merge-base --is-ancestor'&&call.args.at(-1)===other));
 await assert.rejects(loadReleaseHighlights({version:'1.3.0',source:other,directory,command:async()=>{throw new Error('not an ancestor');}}),/not an ancestor/);
});

test('human notes lead with grouped behavior and retain English source references below',async()=>{
 const {renderTestReleaseNotes}=await load();
 const pointer={schema:1,manifest:`reviewops-test-update-24001-${commit.slice(0,12)}.json`,buildNumber:24001,commit,size:100,sha256:'d'.repeat(64)};
 const build={channel:'test',version:'1.3.0',developmentNumber:2,buildNumber:24001,commit,builtAt:'2026-11-02T03:29:31.170Z'};
 const body=renderTestReleaseNotes({build,versionLabel:'1.3.0-dev-2',pointer,changes,highlights:[entry],verification:[{target:'win32-x64',ok:true,publisher:{status:'NotSigned'}}]});
 assert.match(body,/\*\*Keep previews reliable after reload:\*\*/);assert.ok(body.indexOf('## Fixes')<body.indexOf('## Build details'));assert.ok(body.indexOf('## Install and update')<body.indexOf('<details>'));
 assert.equal(/^# /m.test(body),false);assert.equal(/[가-힣]/.test(body),false);assert.equal((body.match(/Keep previews reliable after reload/g)||[]).length,1);
 assert.ok(body.includes('[PR #50](https://github.com/season-framework/reviewops-local/pull/50)'));assert.ok(body.includes('**NotSigned**'));
 const {pointerFromBody}=await import('../scripts/test-release.mjs'),ledger=await import('../scripts/test-development-ledger.mjs');
 const allocation=ledger.allocateDevelopment({schema:1,allocations:[]},{channel:'test',version:build.version,buildNumber:build.buildNumber,commit,builtAt:build.builtAt},base).ledger;
 const complete=ledger.replaceLedger(body,allocation);assert.deepEqual(pointerFromBody(complete),pointer);assert.deepEqual(ledger.ledgerFromBody(complete),allocation);
 assert.equal((complete.match(/<!-- reviewops-test-pointer:/g)||[]).length,1);assert.equal((complete.match(/<!-- reviewops-test-development:/g)||[]).length,1);
});

test('untranslated subjects and protocol-looking text cannot introduce non-English copy or extra machine markers',async()=>{
 const {renderTestReleaseNotes}=await load();const raw={...changes,commits:[{commit,subject:'fix: Explain <!-- reviewops-test-development: metadata --> (#41)'},{commit:other,subject:'fix: 한글 변경 日本語 제목',references:[ref]}]};
 const body=renderTestReleaseNotes({build:{buildNumber:24001,commit,builtAt:'2026-11-02T00:00:00Z'},versionLabel:'1.3.0-dev-2',pointer:{},changes:raw});
 assert.equal(/[가-힣\u3040-\u30ff\u3400-\u9fff]/.test(body),false);assert.ok(body.includes('&lt;!-- reviewops-test-development: metadata --&gt;'));assert.equal(body.includes('<!-- reviewops-test-development:'),false);assert.ok(body.includes('Source update'));
});

test('stable draft notes share categories and preserve pending QA and unsigned-installer limits',async()=>{
 const {renderStableDraftNotes}=await load();const body=renderStableDraftNotes({version:'1.3.0',tag:'v1.3.0',commit,policy:{previousVersion:'1.2.11',reason:'Add scoped reviews'},verification:[{target:'win32-x64',ok:true,publisher:{status:'NotSigned'}}]},[entry]);
 assert.match(body,/^\*\*Draft/);assert.ok(body.includes('QA report'));assert.ok(body.includes('## Fixes'));assert.ok(body.includes('**NotSigned**'));assert.equal(/^# /m.test(body),false);assert.equal(/[가-힣]/.test(body),false);assert.ok(body.includes(`/compare/v1.2.11...${commit}`));
 const fallback=renderStableDraftNotes({version:'1.2.11',tag:'v1.2.11',commit,policy:{reason:'한국어 정책 설명'}});assert.equal(/[가-힣]/.test(fallback),false);assert.ok(fallback.includes('## Changes'));
});
