'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {OpsSkills,inferredTasks,reviewAuthoringGuidance}=require('../electron/ops-skills.cjs');
const bundled=path.join(__dirname,'../electron/ops-skills-bundled');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-authoring-contract-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}

test('natural Korean and English review authoring/refinement/grouping requests automatically receive the versioned writing guides',t=>{
 const registry=new OpsSkills({dataPath:fixture(t)}),writing=fs.readFileSync(path.join(bundled,'reviewops-review-agent/references/review-writing.md'),'utf8'),grouping=fs.readFileSync(path.join(bundled,'reviewops-review-agent/references/request-scope.md'),'utf8');
 for(const instruction of ['이 개선 요청을 작업별로 나눠서 리뷰로 등록해줘','이 리뷰 내용을 깔끔하게 정리해줘','선택한 이슈의 제목과 본문을 다듬어줘','Turn these requests into separate reviews','Draft a GitHub-style issue for this project','Split the review into independently actionable issues','Rewrite the existing review without losing its scope']){
  const captured=registry.capture({instruction,context:{view:'project',projectId:'chosen-project'}}),skill=captured.snapshot.skills.find(row=>row.slug==='reviewops-review-agent');assert.ok(skill,instruction);assert.equal(skill.version,'2.1.0');assert.ok(captured.prompt.includes(writing),instruction+' receives complete writing guide');assert.ok(captured.prompt.includes(grouping),instruction+' receives complete grouping guide');assert.equal(captured.snapshot.selection,'auto');assert.equal(captured.snapshot.taskKinds.includes('report'),false);
 }
});

test('a clear usage question and read-only request do not create a review-authoring action',()=>{
 for(const instruction of ['프로젝트 사용 방법 알려줘','How do I use project settings?','List the current projects','이 리뷰 읽어줘'])assert.equal(inferredTasks(instruction).includes('review_create'),false,instruction);
 const contract=reviewAuthoringGuidance();assert.ok(typeof contract==='string'&&Buffer.byteLength(contract)<4096);assert.match(contract,/when requested|unless.*requested|asks/i);assert.match(contract,/mode:create/);assert.match(contract,/mode:update/);assert.match(contract,/operationId/);assert.match(contract,/read back/i);
});

test('a bundled writing-guide upgrade preserves user edits and exact old immutable request resources',t=>{
 const directory=fixture(t),legacyFiles=[{path:'SKILL.md',bytes:Buffer.from('---\nname: reviewops-review-agent\ndescription: Original writing\nversion: "2.0.0"\n---\nOLD_REQUEST_INSTRUCTIONS\n[Result](references/recording.md)\n')},{path:'references/recording.md',bytes:Buffer.from('OLD_WRITING_RESOURCE')}];
 let registry=new OpsSkills({dataPath:directory,bundledPath:path.join(directory,'none')});registry._install(legacyFiles,{kind:'bundled-native',name:'ReviewOps 2.0.0'},'new',undefined,{taskKinds:['review_create']});const id=registry.snapshot().skills[0].id,original=registry.capture({instruction:'리뷰 작성'});registry.saveFile({id,path:'references/recording.md',text:'PRESERVED_PERSONAL_RECORDING_RULE'});const edited=registry.capture({instruction:'리뷰 작성'}),before=registry.exportData();
 registry=new OpsSkills({dataPath:directory,bundledPath:bundled});const current=registry.snapshot().skills.find(row=>row.id===id);assert.equal(current.version,'2.1.0');assert.equal(registry.readFile({id,path:'references/recording.md'}).text,'PRESERVED_PERSONAL_RECORDING_RULE');for(const [revision,version]of Object.entries(before.versions))assert.deepEqual(registry.exportData().versions[revision],version);
 assert.equal(registry.capture({inheritedSnapshot:original.snapshot}).prompt,original.prompt);assert.equal(registry.capture({inheritedSnapshot:edited.snapshot}).prompt,edited.prompt);const next=registry.capture({instruction:'개선 요청을 나눠 리뷰로 등록해줘'});assert.notEqual(next.snapshot.skills.find(row=>row.id===id).revision,edited.snapshot.skills[0].revision);assert.ok(next.prompt.includes('## 문제'));assert.ok(next.prompt.includes('independently actionable'));
 const snapshots=new Map([original.snapshot,edited.snapshot,next.snapshot].map(row=>[row.id,row])),read=registry.tools(args=>snapshots.get(args.snapshotId)).find(tool=>tool.name==='ops_skills_read');assert.throws(()=>read.execute({snapshotId:original.snapshot.id,skillId:id,path:'references/review-writing.md'},{}),{code:'OPS_SKILL_NOT_FOUND'});const resource=read.execute({snapshotId:next.snapshot.id,skillId:id,path:'references/review-writing.md'},{});assert.equal(Buffer.from(resource.content,'base64').toString('utf8'),fs.readFileSync(path.join(bundled,'reviewops-review-agent/references/review-writing.md'),'utf8'));
});

test('a missing mandatory writing resource cannot be accepted as a complete default package',t=>{
 const directory=fixture(t),copy=path.join(directory,'bundled');fs.cpSync(bundled,copy,{recursive:true});const registry=new OpsSkills({dataPath:directory,bundledPath:copy}),before=fs.readFileSync(registry.file);fs.rmSync(path.join(copy,'reviewops-review-agent/references/review-writing.md'));assert.throws(()=>new OpsSkills({dataPath:directory,bundledPath:copy}),error=>error.code==='OPS_SKILL_REFERENCE'||error.code==='OPS_SKILL_BUNDLED');assert.deepEqual(fs.readFileSync(registry.file),before);
});
