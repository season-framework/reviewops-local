'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const conversation=()=>import('../src/agent-conversation.mjs');

test('legacy execution shows explicitly reported model and reasoning without inventing earlier settings',async()=>{
 const {executionSettingsView}=await conversation();
 const run={model:'old-sent-model',reasoningEffort:'high',executionTarget:{model:'target-model',reasoningEffort:'medium'},reportedSettings:{model:'EXPLICIT_ACTUAL_MODEL',reasoningEffort:'low',source:'cli_event',eventType:'turn.started',reportedAt:'2026-10-30T09:00:00Z'}};
 const before=structuredClone(run),view=executionSettingsView(run);
 assert.deepEqual(view,{recorded:false,selected:{},automatic:{},sent:{},reported:{model:'EXPLICIT_ACTUAL_MODEL',reasoningEffort:'low'}});
 assert.deepEqual(run,before);
 view.reported.model='display-only-change';
 assert.equal(run.reportedSettings.model,'EXPLICIT_ACTUAL_MODEL');
});

test('legacy execution with one reported value leaves the other missing',async()=>{
 const {executionSettingsView}=await conversation();
 for(const reportedSettings of [{model:'reported-model'},{reasoningEffort:'medium'}]){
  const view=executionSettingsView({model:'old-sent-model',reasoningEffort:'high',reportedSettings});
  assert.equal(view.recorded,false);
  assert.deepEqual(view.selected,{});
  assert.deepEqual(view.sent,{});
  assert.deepEqual(view.reported,reportedSettings);
 }
});

test('unsupported selection snapshots do not hide explicitly reported values',async()=>{
 const {executionSettingsView}=await conversation();
 const view=executionSettingsView({executionSettings:{version:0,selected:{model:'old-chosen-model'},sent:{model:'old-sent-model'},automatic:{model:false}},reportedSettings:{model:'reported-model',reasoningEffort:'low'}});
 assert.deepEqual(view,{recorded:false,selected:{},automatic:{},sent:{},reported:{model:'reported-model',reasoningEffort:'low'}});
});

test('missing or invalid reported values stay unavailable for legacy and recorded executions',async()=>{
 const {executionSettingsView}=await conversation();
 const executionSettings={version:1,selected:{model:'chosen-model',reasoningEffort:'high'},sent:{model:'sent-model',reasoningEffort:'high'},automatic:{model:false,reasoningEffort:false}};
 for(const recorded of [false,true])for(const reportedSettings of [undefined,{},null,{model:'',reasoningEffort:''},{model:17,reasoningEffort:false},{model:{name:'not-a-string'},reasoningEffort:['low']}]){
  const view=executionSettingsView({model:'legacy-model',reasoningEffort:'medium',executionSettings:recorded?executionSettings:undefined,reportedSettings});
  assert.equal(view.recorded,recorded);
  assert.deepEqual(view.reported,{});
 }
});
