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
 const readHistoricalCatalog=async()=>null;
 assert.deepEqual(await loadReleaseHighlights({version:'1.3.0',changes,directory,readHistoricalCatalog}),[entry]);
 assert.deepEqual(await loadReleaseHighlights({version:'1.2.11',changes,directory,readHistoricalCatalog}),[]);
 assert.deepEqual(await loadReleaseHighlights({version:'1.3.0',changes:{...changes,commits:[]},directory,readHistoricalCatalog}),[]);
 for(const patch of [{title:'한국어 제목'},{description:'line\nbreak'},{category:'unknown'},{commits:['short']}])assert.throws(()=>validateReleaseHighlights({schema:1,version:'1.3.0',entries:[{...entry,...patch}]},'1.3.0'));
 const calls=[];await loadReleaseHighlights({version:'1.3.0',source:other,directory,command:async(command,args,options)=>{calls.push({command,args,options});return {stdout:''};}});assert.equal(calls.length,2);assert.ok(calls.every(call=>call.command==='git'&&call.args.slice(0,2).join(' ')==='merge-base --is-ancestor'&&call.args.at(-1)===other));
 await assert.rejects(loadReleaseHighlights({version:'1.3.0',source:other,directory,command:async()=>{throw new Error('not an ancestor');}}),/not an ancestor/);
});

test('human notes lead with grouped behavior and retain English source references below',async()=>{
 const {renderTestReleaseNotes}=await load();
 const pointer={schema:1,manifest:`reviewops-test-update-24001-${commit.slice(0,12)}.json`,buildNumber:24001,commit,size:100,sha256:'d'.repeat(64)};
 const build={channel:'test',version:'1.3.0',developmentNumber:2,buildNumber:24001,commit,builtAt:'2026-11-02T03:29:31.170Z'};
 const body=renderTestReleaseNotes({build,versionLabel:'1.3.0-dev-2',pointer,changes,highlights:[entry],verification:[{target:'win32-x64',ok:true,publisher:{status:'NotSigned'}}]});
 assert.deepEqual([...body.matchAll(/^## (.+)$/gm)].map(match=>match[1]),['Fixes','Known limitations','Install and update','Verification','Build details']);
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
 assert.deepEqual([...body.matchAll(/^## (.+)$/gm)].map(match=>match[1]),['Fixes','Known limitations','Install and update','Verification','Build details']);
 assert.match(body,/^\*\*Draft/);assert.ok(body.includes('QA report'));assert.ok(body.includes('## Fixes'));assert.ok(body.includes('**NotSigned**'));assert.equal(/^# /m.test(body),false);assert.equal(/[가-힣]/.test(body),false);assert.ok(body.includes(`/compare/v1.2.11...${commit}`));
 const fallback=renderStableDraftNotes({version:'1.2.11',tag:'v1.2.11',commit,policy:{reason:'한국어 정책 설명'}});assert.equal(/[가-힣]/.test(fallback),false);assert.ok(fallback.includes('## Changes'));
});

test('raw documentation and maintenance stay in source details while unrepresented behavior remains visible',async()=>{
 const {renderTestReleaseNotes}=await load();
 const subjects=['docs: bind the clipboard fix to the Codex release highlight','ci: verify release metadata','feat: add review filters','improve: show selected CLI paths','fix: retain manual CLI selection'];
 const raw={...changes,totalCommits:subjects.length,commits:subjects.map((subject,index)=>({commit:String(index+1).repeat(40),subject,references:[ref]}))};
 const body=renderTestReleaseNotes({build:{buildNumber:27001,commit,builtAt:'2026-11-02T10:48:25.689Z'},versionLabel:'1.3.0-dev-3',pointer:{},changes:raw});
 const [summary,details]=body.split('<details>');
 assert.equal(summary.includes('Bind the clipboard fix'),false);assert.equal(summary.includes('Verify release metadata'),false);
 assert.equal(summary.includes('## Documentation'),false);assert.equal(summary.includes('## Maintenance'),false);
 for(const title of ['Add review filters','Show selected CLI paths','Retain manual CLI selection'])assert.ok(summary.includes(title));
 for(const item of raw.commits){assert.ok(details.includes(item.commit));assert.ok(details.includes(item.subject.replace(/^[a-z]+:\s*/,'').replace(/^./,letter=>letter.toUpperCase())));}
});

test('reviewed documentation and maintenance highlights remain source-bound in test and stable summaries',async()=>{
 const {changeSections,renderStableDraftNotes}=await load();
 const docs={category:'documentation',title:'Read English guides',description:'Use the English setup and troubleshooting guides.',commits:[commit]};
 const maintenance={category:'maintenance',title:'Use verified installers',description:'Download packages with matching source and verification records.',commits:[other]};
 const raw={...changes,commits:[{commit,subject:'docs: translate setup guides',references:[ref]},{commit:other,subject:'build: verify installers'}]};
 const summary=changeSections(raw,[docs,maintenance]);
 assert.ok(summary.includes('## Documentation'));assert.ok(summary.includes('## Maintenance'));assert.ok(summary.includes('Read English guides'));assert.ok(summary.includes('Use verified installers'));
 assert.equal(summary.includes('Translate setup guides'),false);assert.equal(summary.includes('Verify installers'),false);
 assert.equal(changeSections({...raw,commits:[]},[docs,maintenance]),'');
 const stable=renderStableDraftNotes({version:'1.3.0',tag:'v1.3.0',commit},[docs,maintenance]);
 assert.ok(stable.includes('Read English guides'));assert.ok(stable.includes('Use verified installers'));assert.ok(stable.includes(`/commit/${commit}`));assert.ok(stable.includes(`/commit/${other}`));
});

test('editorial highlights avoid a second feature from a merge subject',async()=>{
 const {renderTestReleaseNotes}=await load();
 const queue='d'.repeat(40),service='e'.repeat(40),merge='f'.repeat(40);
 const highlights=[{category:'features',title:'Save follow-up work through MCP',description:'Save scoped requests and start them explicitly.',commits:[queue]},{category:'features',title:'Start and stop project-owned Node services',description:'Control one owned local service and observe its state.',commits:[service]}];
 const raw={...changes,totalCommits:3,commits:[{commit:merge,subject:'Add public saved follow-up queue tools (#57)',references:[ref]},{commit:queue,subject:'Add scoped public saved follow-up queue tools'},{commit:service,subject:'feat: manage project-owned local Node services'}]};
 const body=renderTestReleaseNotes({build:{buildNumber:1,commit:merge,builtAt:'2026-11-02T00:00:00Z'},versionLabel:'preview',pointer:{},changes:raw,highlights});
 const [summary,details]=body.split('<details>');
 assert.ok(summary.includes('**Save follow-up work through MCP:**'));
 assert.ok(summary.includes('**Start and stop project-owned Node services:**'));
 assert.equal(summary.includes('**Add public saved follow-up queue tools.'),false);
 assert.equal((summary.match(/^- \*\*/gm)||[]).length,2);
 assert.ok(details.includes('Add public saved follow-up queue tools'));
 assert.ok(details.includes(`/commit/${merge}`));assert.ok(details.includes('[PR #50]'));
});

test('editorial highlights keep fixture and overlapping fix subjects in source details',async()=>{
 const {renderTestReleaseNotes}=await load();const feature='d'.repeat(40);
 const subjects=['fix: trace Windows fixture cleanup and canonical agent paths','fix: preserve Windows owned-service evidence and add guarded diagnostics','fix: retire native web views across host document reloads'];
 const fallback=subjects.map((subject,index)=>({commit:String(index+1).repeat(40),subject}));
 const raw={...changes,commit:feature,totalCommits:4,commits:[{commit:feature,subject:'feat: manage project-owned local Node services'},...fallback]};
 const highlight={category:'features',title:'Control project-owned services',description:'Start the saved service and confirm cooperative shutdown.',commits:[feature]};
 const body=renderTestReleaseNotes({build:{buildNumber:1,commit:feature,builtAt:'2026-11-02T00:00:00Z'},versionLabel:'preview',pointer:{},changes:raw,highlights:[highlight]});
 const [summary,details]=body.split('<details>');assert.ok(summary.includes('Control project-owned services'));
 assert.equal(summary.includes('## Fixes'),false);
 for(const item of fallback){const title=item.subject.slice(5).replace(/^./,letter=>letter.toUpperCase());assert.equal(summary.includes(title),false);assert.ok(details.includes(title));assert.ok(details.includes(`/commit/${item.commit}`));}
 assert.ok(details.includes(`/compare/${base}...${feature}`));assert.ok(details.includes('Full comparison: 4 commits'));
});

test('editorial highlights outside or incomplete in the range retain behavior fallback',async()=>{
 const {changeSections}=await load();const missing='d'.repeat(40);
 const raw={...changes,commits:[{commit,subject:'feat: add review filters',references:[ref]},{commit:other,subject:'fix: retain manual selection'}]};
 const historical={category:'features',title:'Future feature',description:'Not part of this change range.',commits:[missing]};
 const incomplete={category:'fixes',title:'Incomplete reviewed fix',description:'Requires another source change.',commits:[other,missing]};
 const body=changeSections(raw,[historical,incomplete]);
 assert.ok(body.includes('## New features'));assert.ok(body.includes('Add review filters'));
 assert.ok(body.includes('## Fixes'));assert.ok(body.includes('Retain manual selection'));
 assert.ok(body.includes('[PR #50]'));assert.equal(body.includes('Future feature'),false);assert.equal(body.includes('Incomplete reviewed fix'),false);
});

test('a test range crossing a stable catalog reset retains only its newly included reviewed behavior',async t=>{
 const {loadReleaseHighlights,renderTestReleaseNotes}=await load(),{collectChangeNotes}=await import('../scripts/test-release-notes.mjs');
 const {promisify}=require('node:util'),run=promisify(require('node:child_process').execFile);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-catalog-history-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const git=async(...args)=>(await run('git',args,{cwd:directory})).stdout.trim();
 await git('init','--quiet');await git('config','user.name','Release fixture');await git('config','user.email','release-fixture@example.invalid');await git('config','commit.gpgsign','false');await git('config','core.hooksPath',path.join(directory,'no-hooks'));
 const save=async(label,catalog)=>{await fs.writeFile(path.join(directory,'change.txt'),label);if(catalog)await fs.writeFile(path.join(directory,'release-notes.json'),JSON.stringify(catalog));await git('add','.');await git('commit','--quiet','-m',label);return git('rev-parse','HEAD');};
 const old=await save('fix: older already public behavior');
 const oldEntry={...entry,title:'Older already public behavior',commits:[old]};
 const base=await save('docs: describe previous test scope',{schema:1,version:'1.4.1',entries:[oldEntry]});
 const fix=await save('Keep copied attachment files and source details consistent');
 const fixed={...entry,title:'Keep copied attachment files and source details consistent',description:'Stop a pending copy if its selected source attachment changes.',commits:[fix]};
 const stable=await save('docs: describe consistent attachment sources',{schema:1,version:'1.4.1',entries:[fixed,oldEntry]});
 const feature=await save('feat: discover one privately registered running app');
 const added={category:'features',title:'Connect a fresh MCP process to a running app',description:'Find one privately registered app without changing existing explicit connections.',commits:[feature]};
 const source=await save('release: prepare the next minor version',{schema:1,version:'1.5.0',entries:[added]});
 const build={channel:'test',version:'1.5.0',developmentNumber:1,buildNumber:43001,commit:source,builtAt:'2026-11-04T21:19:46.858Z'};
 const notes=await collectChangeNotes({build,baseCommit:base,cwd:directory,resolveReferences:async item=>({...item,references:[{...ref,number:item.commit===fix?89:90,url:`https://github.com/season-framework/reviewops-local/pull/${item.commit===fix?89:90}`}],referenceStatus:'verified'})});
 const frozen=JSON.stringify(notes),highlights=await loadReleaseHighlights({version:'1.5.0',changes:notes,directory});
 assert.deepEqual(highlights,[added,fixed]);assert.equal(JSON.stringify(notes),frozen);
 const body=renderTestReleaseNotes({build,versionLabel:'1.5.0-dev-1',pointer:{},changes:notes,highlights});
 const summary=body.split('<details>')[0];assert.ok(summary.includes('## New features'));assert.ok(summary.includes('## Fixes'));
 assert.equal((summary.match(/\*\*Keep copied attachment files and source details consistent:/g)||[]).length,1);assert.equal(summary.includes(oldEntry.title),false);
 assert.ok(summary.includes('[PR #89]'));assert.ok(summary.includes('[PR #90]'));
 assert.deepEqual(await loadReleaseHighlights({version:'1.5.0',source,directory,readHistoricalCatalog:async()=>{throw new Error('Stable drafts must not read historical catalogs');}}),[added]);
 const afterStable=await collectChangeNotes({build,baseCommit:stable,cwd:directory});
 assert.deepEqual(await loadReleaseHighlights({version:'1.5.0',changes:afterStable,directory}),[added]);
});

test('current and newest version snapshots win without resurrecting removed or incomplete highlights',async t=>{
 const {loadReleaseHighlights}=await load(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-catalog-precedence-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const feature={category:'features',title:'Current feature',description:'Keep the current reviewed description.',commits:[commit]},fix={...entry,title:'Latest historical fix',commits:[other]};
 await fs.writeFile(path.join(directory,'release-notes.json'),JSON.stringify({schema:1,version:'2.0.0',entries:[feature]}));
 const ordered={...changes,commits:[{commit,subject:'Newer source'},{commit:other,subject:'Older source'}]};
 const calls=[],snapshots=new Map([[commit,{schema:1,version:'1.9.0',entries:[fix,{...entry,title:'Incomplete fix',commits:[other,'d'.repeat(40)]}]}],[other,{schema:1,version:'1.9.0',entries:[{...fix,title:'Older wording'},{...entry,title:'Removed entry',commits:[commit]}]}]]);
 const actual=await loadReleaseHighlights({version:'2.0.0',changes:ordered,directory,readHistoricalCatalog:async id=>{calls.push(id);return snapshots.get(id);}});
 assert.deepEqual(actual,[feature,fix]);assert.deepEqual(calls,ordered.commits.map(item=>item.commit));
 snapshots.set(other,{schema:1,version:'2.0.0',entries:[{...feature,title:'Outdated current wording'}]});
 assert.deepEqual(await loadReleaseHighlights({version:'2.0.0',changes:ordered,directory,readHistoricalCatalog:async id=>snapshots.get(id)}),[feature,fix]);
});

test('historical lookup is capped by the frozen identities and malformed present catalogs are not skipped',async t=>{
 const {loadReleaseHighlights}=await load(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-catalog-bounds-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.writeFile(path.join(directory,'release-notes.json'),JSON.stringify({schema:1,version:'1.3.0',entries:[]}));
 let reads=0;const absent=async()=>{reads++;return null;};
 const tooMany=Array.from({length:101},(_,i)=>({commit:(i+1).toString(16).padStart(40,'0')}));
 for(const commits of [tooMany,[{commit:'not-a-commit'}],[{commit},{commit}]])await assert.rejects(loadReleaseHighlights({version:'1.3.0',changes:{...changes,commits},directory,readHistoricalCatalog:absent}),/100 distinct frozen/);
 assert.equal(reads,0);
 assert.deepEqual(await loadReleaseHighlights({version:'1.3.0',changes,directory,readHistoricalCatalog:absent}),[]);assert.equal(reads,2);
 for(const value of [{schema:9,version:'1.2.0',entries:[]},{schema:1,version:'1.2.0',entries:[{...entry,title:'한국어'}]}])await assert.rejects(loadReleaseHighlights({version:'1.3.0',changes,directory,readHistoricalCatalog:async()=>value}),/schema 1|English/);
});

test('Git catalog reads distinguish an absent path, missing object, invalid mode, invalid JSON and oversized blob',async t=>{
 const {loadReleaseHighlights}=await load(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-catalog-git-read-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const single={...changes,commits:[{commit,subject:'fix: selected behavior'}]},blob='d'.repeat(40),calls=[];
 const options={version:'1.3.0',changes:single,directory};
 assert.deepEqual(await loadReleaseHighlights({...options,command:async(...args)=>{calls.push(args);return {stdout:''};}}),[]);
 assert.deepEqual(calls[0].slice(0,2),['git',['ls-tree','-z',commit,'--','release-notes.json']]);
 await assert.rejects(loadReleaseHighlights({...options,command:async()=>{throw new Error('Missing immutable Git object');}}),/Missing immutable Git object/);
 await assert.rejects(loadReleaseHighlights({...options,command:async()=>({stdout:`120000 blob ${blob}\trelease-notes.json\0`})}),/regular Git blob/);
 for(const [text,message]of [['{broken',/invalid JSON/],['null',/schema 1/],[' '.repeat(256*1024+1),/size limit/]])await assert.rejects(loadReleaseHighlights({...options,command:async(_command,args)=>({stdout:args[0]==='ls-tree'?`100644 blob ${blob}\trelease-notes.json\0`:text})}),message);
 let blobs=0;const catalog={schema:1,version:'1.2.0',entries:[entry]};
 assert.deepEqual(await loadReleaseHighlights({...options,changes,command:async(_command,args)=>{if(args[0]==='ls-tree')return {stdout:`100644 blob ${blob}\trelease-notes.json\0`};blobs++;assert.deepEqual(args,['cat-file','blob',blob]);return {stdout:JSON.stringify(catalog)};}}),[entry]);
 assert.equal(blobs,1,'Repeated immutable blob is read once');
});
