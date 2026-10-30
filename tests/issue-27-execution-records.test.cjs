'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStore,SCHEMA_VERSION}=require('../electron/store.cjs');
const {createRequestQueue,listSavedRequests}=require('../electron/agent-requests.cjs');
const {createAgentManager,buildArguments}=require('../electron/agents.cjs');

function fixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-issue-27-')),dbPath=path.join(directory,'test.sqlite');
 let store=createStore({dbPath});
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const group=store.saveGroup({name:'검사용 그룹'}),service=store.saveService({groupId:group.id,name:'검사용 작업 폴더',kind:'local',rootPath:directory,agentModel:'project-model',agentReasoningEffort:'high'}),project=store.saveProject({groupId:group.id,name:'검사용 프로젝트',serviceIds:[service.id]}),review=store.saveReview({projectId:project.id,serviceId:service.id,title:'설정 기록 검사'});
 return {directory,dbPath,service,project,review,get store(){return store;},reopen(){store.close();store=createStore({dbPath});return store;},run(extra={}){return store.saveAgentRun({reviewId:review.id,serviceId:service.id,prompt:'요청 원문',model:'sent-model',reasoningEffort:'high',workPath:directory,status:'running',...extra});}};
}
const explicit=(model='sent-model',reasoningEffort='high')=>({version:1,selected:{model,reasoningEffort},automatic:{model:!model,reasoningEffort:!reasoningEffort},sent:{model,reasoningEffort}});
const automatic=()=>({version:1,selected:{model:'',reasoningEffort:''},automatic:{model:true,reasoningEffort:true},sent:{model:'project-model',reasoningEffort:'high'}});

test('each execution preserves selected, automatic, sent and explicitly reported values through update, restart and backup',t=>{
 const f=fixture(t),selection=automatic(),reported={model:'runtime-model',reasoningEffort:'medium',source:'cli_event',eventType:'turn.started',reportedAt:new Date().toISOString()};
 const first=f.run({model:'project-model',executionSettings:selection}),second=f.run({executionSettings:explicit(),retryOf:first.id,sourceRunId:first.id,continuedFromRunId:first.id});
 f.store.saveAgentRun({id:first.id,status:'completed',response:' \n응답 원문\n ',reportedSettings:reported});
 f.store.saveAgentRun({id:first.id,model:'later-default',reasoningEffort:'low',executionSettings:explicit('later-default','low')});
 f.reopen();
 const restored=f.store.get('agent_runs',first.id);
 assert.deepEqual(restored.executionSettings,selection);assert.deepEqual(restored.reportedSettings,reported);
 assert.equal(restored.model,'project-model');assert.equal(restored.reasoningEffort,'high');assert.equal(restored.response,' \n응답 원문\n ');
 assert.ok(restored.startedAt);assert.ok(restored.finishedAt);
 const linked=f.store.get('agent_runs',second.id);for(const key of ['retryOf','sourceRunId','continuedFromRunId'])assert.equal(linked[key],first.id);
 assert.equal(linked.reportedSettings,undefined);
 f.store.interruptAgentRuns();const backup=f.store.exportData();f.store.importData(backup);assert.deepEqual(f.store.exportData(),backup);
});

test('legacy records keep absent settings and reported values absent after project changes and partial updates',t=>{
 const f=fixture(t),run=f.run({model:'old-sent',reasoningEffort:''});
 f.store.saveService({id:f.service.id,agentModel:'new-default',agentReasoningEffort:'ultra'});
 f.store.saveAgentRun({id:run.id,status:'failed',executionSettings:explicit('old-sent',''),error:'검사용 오류'});
 assert.equal(f.store.get('agent_runs',run.id).executionSettings,undefined);assert.equal(f.store.get('agent_runs',run.id).reportedSettings,undefined);
 const backup=f.store.exportData();f.store.importData(backup);const restored=f.store.get('agent_runs',run.id);
 assert.equal(restored.model,'old-sent');assert.equal(restored.executionSettings,undefined);assert.equal(restored.reportedSettings,undefined);
});

test('saved followup uses its snapshot after project changes, accepts an explicit edit and blocks edits during launch',async t=>{
 const f=fixture(t),inputs=[];let release;
 const queue=createRequestQueue({store:f.store,targetForReview:()=>({serviceId:f.service.id,key:'same-folder',settings:{model:f.store.get('services',f.service.id).agentModel,reasoningEffort:f.store.get('services',f.service.id).agentReasoningEffort}}),targetForRun:()=>'',start:input=>{inputs.push(input);return new Promise(resolve=>{release=()=>resolve(f.run({id:input.requestId,model:input.model,reasoningEffort:input.reasoningEffort,executionSettings:input.executionSettings}));});}});
 const saved=queue.add({requestId:'saved-request',reviewId:f.review.id,prompt:'저장한 요청',executionSettings:automatic(),newConversation:true,context:{instruction:false,screenshotId:null,attachmentIds:[],logIds:[]}});
 f.store.saveService({id:f.service.id,agentModel:'changed-default',agentReasoningEffort:'low'});
 assert.deepEqual(queue.add({requestId:'saved-request',reviewId:f.review.id,prompt:'저장한 요청'}).executionSettings,saved.executionSettings);
 const updated=queue.update({id:saved.id,model:'edited-model',reasoningEffort:'medium'});assert.equal(updated.model,'edited-model');assert.equal(updated.newConversation,true);
 const started=queue.start({id:saved.id});await Promise.resolve();
 assert.throws(()=>queue.update({id:saved.id,model:'race'}),/이미 시작/);assert.throws(()=>queue.cancel({id:saved.id}),/시작된 요청/);
 const again=queue.start({id:saved.id});release();await Promise.all([started,again]);assert.equal(inputs.length,1);
 assert.equal(inputs[0].model,'edited-model');assert.equal(inputs[0].reasoningEffort,'medium');assert.deepEqual(inputs[0].context,{instruction:false,screenshotId:null,attachmentIds:[],logIds:[]});assert.equal(inputs[0].newConversation,true);
});

test('changing a queued continuation to a new conversation clears only its continuation link and rejects conflicting backups',async t=>{
 const f=fixture(t),previous=f.run({status:'completed',sessionId:'previous-session'}),inputs=[];
 const queue=createRequestQueue({store:f.store,targetForReview:()=>({serviceId:f.service.id,key:'same-folder'}),targetForRun:()=>'',start:async input=>{inputs.push(input);return f.run({id:input.requestId,prompt:input.prompt,newConversation:input.newConversation});}});
 const saved=queue.add({requestId:'continued-request',reviewId:f.review.id,prompt:'이전 요청에서 이어서 실행',continuedFromRunId:previous.id,newConversation:false});
 const before=f.store.exportData(),invalid=structuredClone(before);invalid.agentRequests[0].newConversation=true;
 assert.throws(()=>f.store.importData(invalid),/새 대화에는 이어서 요청할 실행/);assert.deepEqual(f.store.exportData(),before);
 assert.throws(()=>queue.add({requestId:'invalid-continuation',reviewId:f.review.id,prompt:'서로 다른 설정',newConversation:true,continuedFromRunId:previous.id}),/새 대화에는 이어서 요청할 실행/);
 const updated=queue.update({id:saved.id,newConversation:true});assert.equal(updated.newConversation,true);assert.equal(updated.continuedFromRunId,'');
 await queue.start({id:saved.id});assert.equal(inputs.length,1);assert.equal(inputs[0].newConversation,true);assert.equal(inputs[0].continuedFromRunId,undefined);
 const failed=f.run({status:'failed'}),sourceTarget={kind:'local',host:'',hostAlias:'',sshConfigPath:'',port:0,username:'',workPath:f.directory,binary:'codex',model:'sent-model',reasoningEffort:'high'};
 const copied=queue.add({requestId:'copied-request',reviewId:f.review.id,prompt:'이전 내용을 가져온 요청',newConversation:true,sourceRunId:failed.id,sourceTarget});
 const retained=queue.update({id:copied.id,newConversation:true});assert.equal(retained.sourceRunId,failed.id);assert.deepEqual(retained.sourceTarget,sourceTarget);assert.equal(retained.continuedFromRunId,'');
});

test('version 9 database and backup retain old requests without inventing selections and require a saved choice before start',async t=>{
 const f=fixture(t),queue=createRequestQueue({store:f.store,targetForReview:()=>({serviceId:f.service.id,key:'same-folder'}),targetForRun:()=>'',start:()=>{throw new Error('실행되면 안 됩니다.');}});
 queue.add({requestId:'old-request',reviewId:f.review.id,prompt:'과거 대기 요청'});
 const legacy=f.store.exportData();legacy.version=9;
 for(const row of legacy.agentRequests)for(const key of ['model','reasoningEffort','binary','settingsRecorded','newConversation','executionSettings','context','sourceRunId','sourceTarget','continuedFromRunId','requestSignature'])delete row[key];
 for(const column of ['model','reasoningEffort','binary','settingsRecorded','newConversation','executionSettingsJson','contextJson','sourceRunId','sourceTargetJson','continuedFromRunId','requestSignature'])f.store.db.exec(`ALTER TABLE agent_requests DROP COLUMN ${column}`);
 f.store.db.exec('PRAGMA user_version=9;');f.reopen();
 assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
 assert.equal(listSavedRequests(f.store.db)[0].settingsRecorded,false);assert.equal(listSavedRequests(f.store.db)[0].executionSettings,null);
 f.store.importData(legacy);assert.equal(listSavedRequests(f.store.db)[0].settingsRecorded,false);
 const restoredQueue=createRequestQueue({store:f.store,targetForReview:()=>({serviceId:f.service.id,key:'same-folder'}),targetForRun:()=>'',start:()=>{throw new Error('실행되면 안 됩니다.');}});
 await assert.rejects(restoredQueue.start({id:'old-request'}),/저장된 설정이 없습니다/);
 restoredQueue.update({id:'old-request',model:'',reasoningEffort:''});assert.equal(restoredQueue.list(f.review.id).requests[0].state,'ready');
});

test('invalid settings and backup changes fail without replacing saved data',t=>{
 const f=fixture(t);f.run({executionSettings:explicit()});const before=f.store.exportData();
 const invalid=[value=>{value.agentRuns[0].executionSettings.sent.model='different';},value=>{value.agentRuns[0].executionSettings.automatic.model=true;},value=>{value.agentRuns[0].reportedSettings={model:'guessed',source:'project'};},value=>{value.agentRuns[0].progressOmitted=-1;}];
 for(const change of invalid){const data=structuredClone(before);change(data);assert.throws(()=>f.store.importData(data));assert.deepEqual(f.store.exportData(),before);}
});

test('SSH execution snapshots, omitted progress and unavailable actual values survive backup restoration',t=>{
 const f=fixture(t),remote=f.store.saveService({groupId:f.service.groupId,name:'검사용 SSH',kind:'ssh',host:'example.invalid',username:'test',rootPath:'/tmp/project'});
 f.store.saveProject({id:f.project.id,serviceIds:[f.service.id,remote.id]});
 const run=f.run({serviceId:remote.id,workPath:'/tmp/project',executionSettings:explicit(),remoteExecution:{version:1,ready:true,stdoutOffset:12,stderrOffset:0},progressOmitted:37});
 f.reopen();assert.equal(f.store.interruptAgentRuns({preserveRemote:true}).length,0);
 const backup=f.store.exportData();f.store.importData(backup);f.store.interruptAgentRuns();const restored=f.store.get('agent_runs',run.id);
 assert.deepEqual(restored.executionSettings,explicit());assert.equal(restored.reportedSettings,undefined);assert.equal(restored.progressOmitted,37);assert.equal(restored.status,'interrupted');assert.ok(restored.finishedAt);
});

test('CLI records only lifecycle values it receives and counts entries removed from the latest 100',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-issue-27-cli-')),binary=path.join(directory,'fixture-cli');
 fs.writeFileSync(binary,`#!/usr/bin/env node
if(process.argv[2]==='--version'){console.log('codex-cli test');process.exit(0);}
if(process.argv[2]==='login'){process.exit(0);}
let input='';process.stdin.on('data',value=>input+=value);process.stdin.on('end',()=>{
const send=value=>console.log(JSON.stringify(value));
send({type:'thread.started',thread_id:'fixture-session'});
send(input.includes('REPORT')?{type:'turn.started',model:'reported-runtime',reasoning_effort:'medium'}:{type:'turn.started'});
for(let n=0;n<120;n++)send({type:'item.completed',item:{id:'command-'+n,type:'command_execution',exit_code:0}});
send({type:'item.completed',item:{id:'response',type:'agent_message',text:' \\n원문 응답\\n '}});
send({type:'turn.completed'});
});`,{mode:0o755});
 const manager=createAgentManager({env:{...process.env,HOME:directory,CODEX_HOME:path.join(directory,'empty-home')},commandTimeoutMs:3000});
 t.after(async()=>{await manager.closeAll();fs.rmSync(directory,{recursive:true,force:true});});
 const settings={binary,workPath:directory,model:'sent-model',reasoningEffort:'high'},config={kind:'local',rootPath:directory};
 async function complete(id,prompt){manager.start({id,prompt,config,settings,executionSettings:explicit()});for(let count=0;count<200;count++){const run=manager.read(id);if(run.status==='completed')return run;if(run.status==='failed')assert.fail(run.error);await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('검사용 CLI가 종료되지 않았습니다.');}
 const missing=await complete('missing-actual','NO_VALUES');assert.equal(missing.reportedSettings,undefined);
 const reported=await complete('reported-actual','REPORT');assert.equal(reported.reportedSettings.model,'reported-runtime');assert.equal(reported.reportedSettings.reasoningEffort,'medium');assert.equal(reported.reportedSettings.source,'cli_event');assert.equal(reported.reportedSettings.eventType,'turn.started');
 assert.equal(reported.model,'sent-model');assert.deepEqual(reported.executionSettings,explicit());assert.equal(reported.progress.length,100);assert.equal(reported.progressOmitted,27);assert.equal(reported.progress[0].sequence,28);assert.equal(reported.response,' \n원문 응답\n ');assert.ok(reported.finishedAt);
 assert.deepEqual(buildArguments({model:'',reasoningEffort:''}).slice(0,3),['exec','--json','--skip-git-repo-check']);
});
