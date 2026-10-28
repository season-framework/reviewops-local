'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {copyAgentDraft,executionTarget}=require('../electron/agent-copy-draft.cjs');
const {createStore}=require('../electron/store.cjs');

const current={kind:'local',host:'',hostAlias:'',sshConfigPath:'',port:0,username:'',workPath:'/new-work',binary:'/bin/codex',model:'new-model',reasoningEffort:'high'};
const run={id:'failed-request',status:'failed',prompt:'Preserve the exact request',workPath:'/old-work',model:'old-model',reasoningEffort:'low',independentExecution:true,context:{instruction:true,screenshotId:'image',screenshot:{id:'image',name:'Screenshot'},attachmentIds:['kept','removed'],attachments:[{id:'kept',name:'Kept file'},{id:'removed',name:'Missing file'}],logIds:['log','missing-log'],logs:[{id:'log',name:'Available log'},{id:'missing-log',name:'Missing log'}]}};
const materials={attachments:[{id:'image'},{id:'kept'}],sharedFiles:[],logs:[{id:'log'}]};

test('copy prepares a fresh draft with usable materials and preserves the original request',()=>{
 const before=structuredClone(run),result=copyAgentDraft({run,current,materials,sameLocation:true});
 assert.deepEqual(run,before);assert.equal(result.draft.prompt,run.prompt);assert.equal(result.draft.sourceRunId,run.id);assert.equal(result.draft.fresh,true);assert.equal(result.draft.requestId,null);
 assert.equal(result.draft.model,current.model);assert.equal(result.draft.reasoningEffort,current.reasoningEffort);assert.equal(result.draft.screenshotId,'image');assert.deepEqual(result.draft.attachmentIds,['kept']);assert.deepEqual(result.draft.logIds,['log']);assert.equal(result.draft.instruction,true);
 assert.deepEqual(result.excluded.map(item=>item.id),['removed','missing-log']);assert.ok(result.excluded.every(item=>/더 이상 사용할 수 없습니다/.test(item.reason)));
 assert.equal(result.comparison.find(item=>item.key==='binary').before,null);assert.equal(result.comparison.find(item=>item.key==='workPath').before,'/old-work');
});

test('changed execution location excludes every old selection with an explanation',()=>{
 const result=copyAgentDraft({run,current,materials,sameLocation:false});
 assert.equal(result.draft.screenshotId,null);assert.equal(result.draft.instruction,false);assert.deepEqual(result.draft.attachmentIds,[]);assert.deepEqual(result.draft.logIds,[]);assert.equal(result.excluded.length,6);assert.ok(result.excluded.every(item=>/다시 선택/.test(item.reason)));
 assert.equal(result.draft.prompt,run.prompt);assert.equal(result.draft.fresh,true);
});

test('recorded execution settings produce exact before-and-after values and running requests cannot be copied',()=>{
 const previous={...current,host:'old-host',kind:'ssh',username:'user',port:22,workPath:'/old-work'};
 const result=copyAgentDraft({run:{...run,executionTarget:previous},current,materials,sameLocation:false});
 assert.equal(result.comparison.find(item=>item.key==='host').before,'old-host');assert.equal(result.comparison.find(item=>item.key==='workPath').after,'/new-work');
 for(const status of ['queued','running','completed'])assert.throws(()=>copyAgentDraft({run:{...run,status},current,materials,sameLocation:true}),/실패하거나 중단된/);
});

test('execution snapshot contains selected values without storing credentials',()=>{
 const value=executionTarget({kind:'ssh',host:'example.test',port:22,username:'user',password:'never-save',privateKey:'never-save'},{workPath:'/work',binary:'codex',model:'model',reasoningEffort:'high',instructions:'private request'});
 assert.deepEqual(Object.keys(value),['kind','host','hostAlias','sshConfigPath','port','username','workPath','binary','model','reasoningEffort']);assert.equal(JSON.stringify(value).includes('never-save'),false);
});

test('copied request linkage and execution settings remain immutable through updates and backup',t=>{
 const store=createStore({dbPath:':memory:'});t.after(()=>store.close());
 const group=store.saveGroup({name:'Test'}),service=store.saveService({groupId:group.id,name:'Local',kind:'local',rootPath:'/tmp'}),project=store.saveProject({groupId:group.id,name:'Project',serviceIds:[service.id]}),review=store.saveReview({projectId:project.id,serviceId:service.id,title:'Review'});
 const source=store.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'Original',status:'failed',workPath:'/tmp'});
 const copied=store.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'Edited new request',status:'running',workPath:'/tmp',sourceRunId:source.id,executionTarget:current});
 const updated=store.saveAgentRun({...copied,sourceRunId:'other',executionTarget:{...current,workPath:'/changed'},status:'completed'});
 assert.equal(updated.sourceRunId,source.id);assert.deepEqual(updated.executionTarget,current);
 const backup=store.exportData();store.importData(backup);assert.equal(store.get('agent_runs',copied.id).sourceRunId,source.id);assert.deepEqual(store.get('agent_runs',copied.id).executionTarget,current);assert.equal(store.get('agent_runs',source.id).prompt,'Original');
});
