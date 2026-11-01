'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateChangeNotes}=require('../electron/build-info.cjs');
const repo='season-framework/reviewops-local',commit='a'.repeat(40),privateCommit='b'.repeat(40);
const pr={number:44,title:'Development version support',body:'Related #41; based on PR #32; unrelated/repo#99',html_url:`https://github.com/${repo}/pull/44`,base:{repo:{full_name:repo}}};
const issue={number:41,title:'Detailed development versions',html_url:`https://github.com/${repo}/issues/41`};
test('explicit references accept local issue notation and URLs without inferring foreign repository references',async()=>{
 const {explicitReferences}=await import('../scripts/test-release-references.mjs');
 assert.deepEqual(explicitReferences(`Related #41, foreign/repo#99 and ${repo}#42 https://github.com/${repo}/issues/43`),[41,42,43]);
 assert.deepEqual(explicitReferences('other-season-framework/reviewops-local#41 foreign/repo-#42 foreign/repo.#43 https://github.com/other-season-framework/reviewops-local#44'),[]);
});
test('each public commit receives only its verified PR association and actual issue references',async()=>{
 const {githubReferenceLookup}=await import('../scripts/test-release-references.mjs'),calls=[];
 const lookup=githubReferenceLookup({token:'synthetic-token',fetchImpl:async(url,options)=>{
  calls.push(String(url));assert.equal(new URL(url).hostname,'api.github.com');assert.equal(options.redirect,'error');
  if(String(url).includes(privateCommit+'/pulls'))return new Response(null,{status:404});
  if(String(url).includes('/commits/'))return Response.json([pr]);
  if(String(url).endsWith('/issues/41'))return Response.json(issue);
  if(String(url).endsWith('/issues/32'))return Response.json({...pr,number:32,html_url:`https://github.com/${repo}/pull/32`,pull_request:{}});
  return new Response(null,{status:404});
 }});
 const actual=await lookup({commit,subject:'Show build identity'});assert.equal(actual.referenceStatus,'verified');assert.deepEqual(actual.references.map(ref=>[ref.kind,ref.number]),[['pull_request',44],['issue',41]]);assert.equal(actual.references[0].via,'commit_association');assert.equal(actual.references[1].sourcePullRequest,44);
 const unknown=await lookup({commit:privateCommit,subject:'Local unpublished commit'});assert.equal(unknown.referenceStatus,'unavailable');assert.deepEqual(unknown.references,[]);
 assert.equal(calls.some(url=>url.endsWith('/issues/99')),false);
});
test('PR association pagination is complete and repeated issue lookups are cached',async()=>{
 const {githubReferenceLookup}=await import('../scripts/test-release-references.mjs');let pages=0,issues=0;
 const lookup=githubReferenceLookup({fetchImpl:async url=>{
  if(String(url).includes('/commits/')){pages++;return Response.json(new URL(url).searchParams.get('page')==='1'?Array.from({length:100},()=>pr):[]);}
  issues++;return String(url).endsWith('/issues/41')?Response.json(issue):new Response(null,{status:404});
 }});const actual=await lookup({commit,subject:'#41'});assert.equal(pages,2);assert.equal(issues,2);assert.deepEqual(actual.references.map(ref=>ref.number),[44,41]);
});
test('lookup failures remain unknown and no PR is copied from another commit',async()=>{
 const {githubReferenceLookup}=await import('../scripts/test-release-references.mjs');
 for(const status of [403,429,500]){const actual=await githubReferenceLookup({fetchImpl:async()=>new Response(null,{status})})({commit,subject:'A source change'});assert.equal(actual.referenceStatus,'unavailable');assert.deepEqual(actual.references,[]);}
});
test('change metadata rejects tampered reference URLs, kind/number mismatches, duplicates and false availability',()=>{
 const reference={kind:'issue',number:41,title:issue.title,url:issue.html_url,via:'commit_subject'},notes={schema:1,baseCommit:privateCommit,commit,totalCommits:1,commits:[{commit,subject:'Change',references:[reference],referenceStatus:'verified'}]};
 assert.equal(validateChangeNotes(notes,commit).commits[0].references[0].number,41);
 for(const patch of [{url:'https://evil.invalid/issues/41'},{url:`https://github.com/${repo}/pull/41`},{number:42},{kind:'other'},{number:0},{title:'control\ntext'},{via:'guessed'},{via:'pull_request_body',sourcePullRequest:44}])assert.throws(()=>validateChangeNotes({...notes,commits:[{...notes.commits[0],references:[{...reference,...patch}]}]},commit));
 assert.throws(()=>validateChangeNotes({...notes,commits:[{...notes.commits[0],references:[reference,reference]}]},commit));
 assert.throws(()=>validateChangeNotes({...notes,commits:[{...notes.commits[0],referenceStatus:'unavailable'}]},commit));
});
