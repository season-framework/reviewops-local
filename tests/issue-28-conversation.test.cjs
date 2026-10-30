'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const conversation=()=>import('../src/agent-conversation.mjs');
const drafts=()=>import('../src/agent-draft.mjs');

test('message copy writes the complete raw request and response without rendered labels',async()=>{
 const {copyMessageText}=await conversation();
 const raw='  요청 원문\r\n\r\n# 제목\n\n```js\nconst value = "진행 중";\n```\n🙂 <button>복사</button>\n';
 const written=[];
 const result=await copyMessageText(raw,{writeText:async text=>written.push(text)});
 assert.equal(result.status,'copied');
 assert.deepEqual(written,[raw]);
});

test('streaming response copy keeps the partial raw text and identifies it as unfinished',async()=>{
 const {copyMessageText}=await conversation();
 const raw='응답 작성 중\n\n- 아직 완료되지 않은 항목';
 let copied;
 const result=await copyMessageText(raw,{streaming:true,writeText:async text=>{copied=text;}});
 assert.equal(copied,raw);
 assert.equal(result.status,'streaming');
});

test('empty responses do not write to the clipboard or report successful copying',async()=>{
 const {copyMessageText}=await conversation();
 let writes=0;
 for(const value of ['', ' \r\n\t ', null, undefined, 0, {}]){
  const result=await copyMessageText(value,{streaming:true,writeText:async()=>{writes++;}});
  assert.equal(result.status,'empty');
 }
 assert.equal(writes,0);
});

test('clipboard rejection and synchronous failure never report successful or streaming copy',async()=>{
 const {copyMessageText}=await conversation();
 for(const writeText of [async()=>{throw new Error('Permission denied');},()=>{throw new Error('Unavailable');}]){
  for(const streaming of [false,true]){
   const result=await copyMessageText('보존할 원문',{streaming,writeText});
   assert.equal(result.status,'failed');
   assert.ok(result.error);
  }
 }
});

test('missing clipboard support returns a failure that the interface can show',async()=>{
 const {copyMessageText}=await conversation();
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
 try{
  const result=await copyMessageText('원문');
  assert.equal(result.status,'failed');
  assert.ok(result.error);
 }finally{
  if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);
  else delete globalThis.navigator;
 }
});

test('copy success waits for the clipboard operation to finish',async()=>{
 const {copyMessageText}=await conversation();
 let release,finished=false;
 const pending=copyMessageText('원문',{writeText:()=>new Promise(resolve=>{release=resolve;})}).then(value=>{finished=true;return value;});
 await Promise.resolve();
 assert.equal(finished,false);
 release();
 assert.equal((await pending).status,'copied');
});

test('new output follows the latest content only while the reader remains at the bottom',async()=>{
 const {shouldFollowLatest}=await conversation();
 assert.equal(shouldFollowLatest({nearBottom:true}),true);
 assert.equal(shouldFollowLatest({nearBottom:false}),false);
 assert.equal(shouldFollowLatest({nearBottom:true,readingEarlier:true}),false);
 assert.equal(shouldFollowLatest({nearBottom:true,detailsOpen:true}),false);
 assert.equal(shouldFollowLatest({nearBottom:false,detailsOpen:false,readingEarlier:false}),false);
 assert.equal(shouldFollowLatest(),false);
});

test('opened execution records prevent output updates from moving the outer conversation',async()=>{
 const {shouldFollowLatest}=await conversation();
 for(const nearBottom of [true,false])for(const readingEarlier of [true,false]){
  assert.equal(shouldFollowLatest({nearBottom,readingEarlier,detailsOpen:true}),false);
 }
});

test('execution detail keeps selected, sent and reported model settings separate',async()=>{
 const {executionSettingsView}=await conversation();
 const run={
  model:'legacy-model',reasoningEffort:'legacy-effort',
  executionSettings:{version:1,selected:{model:'chosen-model',reasoningEffort:'high'},automatic:{model:false,reasoningEffort:false},sent:{model:'sent-model',reasoningEffort:'medium'}},
  reportedSettings:{model:'reported-model',reasoningEffort:'low',source:'cli_event',eventType:'thread.started',reportedAt:'2026-10-30T08:00:00Z'},
 };
 const before=structuredClone(run),view=executionSettingsView(run);
 assert.equal(view.recorded,true);
 assert.deepEqual(view.selected,{model:'chosen-model',reasoningEffort:'high'});
 assert.deepEqual(view.sent,{model:'sent-model',reasoningEffort:'medium'});
 assert.deepEqual(view.automatic,{model:false,reasoningEffort:false});
 assert.deepEqual(view.reported,{model:'reported-model',reasoningEffort:'low'});
 assert.deepEqual(run,before);
});

test('automatic settings and missing CLI values are not shown as reported execution values',async()=>{
 const {executionSettingsView}=await conversation();
 const run={executionSettings:{version:1,selected:{model:'',reasoningEffort:''},automatic:{model:true,reasoningEffort:true},sent:{model:'resolved-default',reasoningEffort:'high'}}};
 const view=executionSettingsView(run);
 assert.equal(view.recorded,true);
 assert.deepEqual(view.automatic,{model:true,reasoningEffort:true});
 assert.deepEqual(view.reported,{});
 const partial=executionSettingsView({...run,reportedSettings:{model:'actual-model'}});
 assert.deepEqual(partial.reported,{model:'actual-model'});
 assert.equal(Object.hasOwn(partial.reported,'reasoningEffort'),false);
});

test('legacy history without a request snapshot remains unrecorded despite newer project settings',async()=>{
 const {executionSettingsView}=await conversation();
 for(const run of [{},{model:'old-model',reasoningEffort:'high'},{executionTarget:{model:'later-setting',reasoningEffort:'low'}},{executionSettings:{version:0,selected:{model:'invalid-version'}}}]){
  const view=executionSettingsView(run);
  assert.equal(view.recorded,false);
  assert.deepEqual(view.selected,{});
  assert.deepEqual(view.sent,{});
  assert.deepEqual(view.reported,{});
 }
});

test('accepting one request preserves another panel draft, newly attached files and changed settings',async()=>{
 const {acceptedAgentDraft}=await drafts();
 const sent={contextVersion:1,prompt:'送信した依頼',requestId:'sent-request',model:'sent-model',reasoningEffort:'low',pending:[{token:'sent-token',name:'sent.txt'}],attachmentIds:['sent-file'],logIds:['sent-log'],screenshotId:'sent-shot',screenshotToken:'sent-shot-token',instruction:false,fresh:false,sourceRunId:'sent-source'};
 const current={...sent,prompt:'다음 요청 초안',requestId:null,model:'next-model',reasoningEffort:'high',pending:[...sent.pending,{token:'next-token',name:'next.txt'}],attachmentIds:[...sent.attachmentIds,'next-file'],logIds:[...sent.logIds,'next-log'],screenshotId:'next-shot',screenshotToken:'next-shot-token',instruction:true,fresh:true,sourceRunId:'next-source',sourceTarget:{workPath:'/next'}};
 const before=structuredClone(current),next=acceptedAgentDraft(current,sent);
 assert.equal(next.prompt,'다음 요청 초안');
 assert.equal(next.requestId,null);
 assert.equal(next.model,'next-model');
 assert.equal(next.reasoningEffort,'high');
 assert.deepEqual(next.pending,[{token:'next-token',name:'next.txt'}]);
 assert.deepEqual(next.attachmentIds,['next-file']);
 assert.deepEqual(next.logIds,['next-log']);
 assert.equal(next.screenshotId,'next-shot');
 assert.equal(next.screenshotToken,'next-shot-token');
 assert.equal(next.instruction,true);
 assert.equal(next.fresh,true);
 assert.equal(next.sourceRunId,'next-source');
 assert.deepEqual(next.sourceTarget,{workPath:'/next'});
 assert.deepEqual(current,before);
});

test('material refresh and screen return preserve an unsent request after a save rejection',async()=>{
 const {initializeAgentDraft}=await drafts();
 const draft={contextVersion:1,contextInitialized:true,prompt:'저장 재시도할 요청',requestId:'rejected-request',model:'selected-model',reasoningEffort:'high',pending:[{token:'retained-file',name:'file.txt'}],attachmentIds:['selected-file'],logIds:['selected-log'],screenshotId:'selected-shot',fresh:true};
 const materials={hasRequests:true,requestIds:['older-accepted-request'],screenshots:[{id:'new-default',createdAt:'2026-10-30'}],logs:[{id:'new-default-log'}]};
 const result=initializeAgentDraft(draft,materials);
 assert.deepEqual(result,draft);
});

test('accepting an earlier request cannot erase a distinct request that uses the same wording',async()=>{
 const {acceptedAgentDraft}=await drafts();
 const sent={contextVersion:1,prompt:'같은 작업을 다시 요청합니다.',requestId:'first-request',pending:[{token:'first-token'}],attachmentIds:[],logIds:[]};
 const current={...sent,requestId:'second-request',pending:[{token:'second-token'}]};
 const next=acceptedAgentDraft(current,sent);
 assert.equal(next.requestId,'second-request');
 assert.equal(next.prompt,current.prompt);
 assert.deepEqual(next.pending,current.pending);
});

test('draft storage failures retain the unsaved value for a later retry',async()=>{
 const {persistAgentDraft}=await drafts();
 const draft={prompt:'보존할 초안',pending:[{token:'unsaved-file'}],attachmentIds:['selected-file'],screenshotId:'shot',model:'chosen-model'};
 const before=structuredClone(draft),written=[];
 const storage={setItem(){throw new Error('Quota exceeded');}};
 const failed=persistAgentDraft(storage,'reviewops.agent.draft.test',draft);
 assert.equal(failed.saved,false);
 assert.ok(failed.error);
 assert.deepEqual(draft,before);
 const saved=persistAgentDraft({setItem:(key,value)=>written.push([key,value])},'reviewops.agent.draft.test',draft);
 assert.equal(saved.saved,true);
 assert.deepEqual(JSON.parse(written[0][1]),before);
 assert.equal(written[0][0],'reviewops.agent.draft.test');
});

test('separate review draft keys keep simultaneous request text and attachments separate',async()=>{
 const {persistAgentDraft}=await drafts();
 const values=new Map(),storage={setItem:(key,value)=>values.set(key,value)};
 const first={prompt:'리뷰 A',pending:[{token:'file-a'}]},second={prompt:'리뷰 B',pending:[{token:'file-b'}]};
 assert.equal(persistAgentDraft(storage,'reviewops.agent.draft.review-a',first).saved,true);
 assert.equal(persistAgentDraft(storage,'reviewops.agent.draft.review-b',second).saved,true);
 assert.deepEqual(JSON.parse(values.get('reviewops.agent.draft.review-a')),first);
 assert.deepEqual(JSON.parse(values.get('reviewops.agent.draft.review-b')),second);
});

test('returning to a screen retains text and attachments after persistent storage rejects a write',async()=>{
 const {persistAgentDraft,readPersistedAgentDraft}=await drafts();
 const key='reviewops.agent.draft.failed-write-screen-return';
 const stale={prompt:'이전 저장값',pending:[]};
 const storage={getItem:()=>JSON.stringify(stale),setItem(){throw new Error('Quota exceeded');}};
 assert.deepEqual(readPersistedAgentDraft(storage,key),stale);
 const unsaved={prompt:'저장 실패 뒤에도 유지할 초안',pending:[{token:'retained-token',name:'retained.txt'}],attachmentIds:['retained-file'],logIds:['retained-log'],screenshotId:'retained-shot',model:'chosen-model',reasoningEffort:'high'};
 assert.equal(persistAgentDraft(storage,key,unsaved).saved,false);
 // A newly mounted screen reads the same key again; it must not replace the
 // newer in-memory draft with the stale value left in persistent storage.
 const returned=readPersistedAgentDraft({getItem:storage.getItem},key);
 assert.deepEqual(returned,unsaved);
});

test('unsaved review drafts remain separate when more than one screen changes',async()=>{
 const {persistAgentDraft,readPersistedAgentDraft}=await drafts();
 const storage={getItem:()=>null,setItem(){throw new Error('Storage disabled');}};
 const first={prompt:'첫 화면 미저장 초안',pending:[{token:'first-unsaved'}]},second={prompt:'다른 화면 미저장 초안',pending:[{token:'second-unsaved'}]};
 assert.equal(persistAgentDraft(storage,'reviewops.agent.draft.unsaved-a',first).saved,false);
 assert.equal(persistAgentDraft(storage,'reviewops.agent.draft.unsaved-b',second).saved,false);
 assert.deepEqual(readPersistedAgentDraft(storage,'reviewops.agent.draft.unsaved-a'),first);
 assert.deepEqual(readPersistedAgentDraft(storage,'reviewops.agent.draft.unsaved-b'),second);
});

test('an explicit storage refresh can receive changes saved by another window',async()=>{
 const {persistAgentDraft,readPersistedAgentDraft}=await drafts();
 const key='reviewops.agent.draft.external-window-change';
 let value;
 const storage={getItem:()=>value,setItem:(_,next)=>{value=next;}};
 persistAgentDraft(storage,key,{prompt:'이 창의 저장값'});
 value=JSON.stringify({prompt:'다른 창의 새 저장값',attachmentIds:['new-file']});
 assert.deepEqual(readPersistedAgentDraft(storage,key,{refresh:true}),{prompt:'다른 창의 새 저장값',attachmentIds:['new-file']});
});

test('legacy plain-text drafts survive even when their text is valid JSON',async()=>{
 const {readPersistedAgentDraft}=await drafts();
 const values=['123','null','[]','"따옴표가 포함된 요청"','이전 버전의 일반 요청문'];
 for(const [index,raw] of values.entries()){
  const result=readPersistedAgentDraft({getItem:()=>raw},`reviewops.agent.draft.legacy-text-${index}`,{refresh:true});
  assert.deepEqual(result,{prompt:raw});
 }
});

const savedAutomaticSettings=()=>({version:1,selected:{model:'',reasoningEffort:''},automatic:{model:true,reasoningEffort:true},sent:{model:'model-a',reasoningEffort:'medium'}});

test('editing only queued reasoning preserves the model resolved before project defaults changed',async()=>{
 const {pendingSettingsForEdit}=await conversation();
 const saved=savedAutomaticSettings(),before=structuredClone(saved);
 const edited=pendingSettingsForEdit(saved,{reasoningEffort:'low'},{model:'model-b',reasoningEffort:'high'});
 assert.deepEqual(edited,{version:1,selected:{model:'',reasoningEffort:'low'},automatic:{model:true,reasoningEffort:false},sent:{model:'model-a',reasoningEffort:'low'}});
 assert.deepEqual(saved,before);
});

test('changing queued conversation or request text preserves both saved execution settings',async()=>{
 const {pendingSettingsForEdit}=await conversation();
 const saved=savedAutomaticSettings();
 for(const patch of [{newConversation:true},{newConversation:false},{prompt:'수정한 후속 요청'},{newConversation:true,prompt:'새 대화로 실행할 요청'}]){
  const edited=pendingSettingsForEdit(saved,patch,{model:'model-b',reasoningEffort:'high'});
  assert.deepEqual(edited,saved);
  assert.notEqual(edited,saved);
  assert.notEqual(edited.selected,saved.selected);
  assert.notEqual(edited.automatic,saved.automatic);
  assert.notEqual(edited.sent,saved.sent);
 }
});

test('editing only queued model preserves the reasoning value saved before a default change',async()=>{
 const {pendingSettingsForEdit}=await conversation();
 const saved=savedAutomaticSettings();
 const edited=pendingSettingsForEdit(saved,{model:'chosen-model'},{model:'model-b',reasoningEffort:'high'});
 assert.deepEqual(edited,{version:1,selected:{model:'chosen-model',reasoningEffort:''},automatic:{model:false,reasoningEffort:true},sent:{model:'chosen-model',reasoningEffort:'medium'}});
});

test('explicitly selecting project default updates only the queued model to the new default',async()=>{
 const {pendingSettingsForEdit}=await conversation();
 const saved={version:1,selected:{model:'chosen-model',reasoningEffort:'low'},automatic:{model:false,reasoningEffort:false},sent:{model:'chosen-model',reasoningEffort:'low'}};
 const edited=pendingSettingsForEdit(saved,{model:''},{model:'model-b',reasoningEffort:'high'});
 assert.deepEqual(edited,{version:1,selected:{model:'',reasoningEffort:'low'},automatic:{model:true,reasoningEffort:false},sent:{model:'model-b',reasoningEffort:'low'}});
});

test('explicitly selecting automatic queued reasoning omits it without changing the saved model',async()=>{
 const {pendingSettingsForEdit}=await conversation();
 const saved={version:1,selected:{model:'',reasoningEffort:'low'},automatic:{model:true,reasoningEffort:false},sent:{model:'model-a',reasoningEffort:'low'}};
 const edited=pendingSettingsForEdit(saved,{reasoningEffort:''},{model:'model-b',reasoningEffort:'high'});
 assert.deepEqual(edited,{version:1,selected:{model:'',reasoningEffort:''},automatic:{model:true,reasoningEffort:true},sent:{model:'model-a',reasoningEffort:''}});
});

test('successive queued field changes retain earlier edits and do not mutate their input snapshots',async()=>{
 const {pendingSettingsForEdit}=await conversation();
 const saved=savedAutomaticSettings();
 for(const pair of [saved,saved.selected,saved.automatic,saved.sent])Object.freeze(pair);
 const defaults=Object.freeze({model:'model-b',reasoningEffort:'high'});
 const first=pendingSettingsForEdit(saved,Object.freeze({reasoningEffort:'low'}),defaults);
 const firstBefore=structuredClone(first);
 const second=pendingSettingsForEdit(first,Object.freeze({model:''}),defaults);
 const final=pendingSettingsForEdit(second,{newConversation:true},defaults);
 assert.deepEqual(final,{version:1,selected:{model:'',reasoningEffort:'low'},automatic:{model:true,reasoningEffort:false},sent:{model:'model-b',reasoningEffort:'low'}});
 assert.deepEqual(first,firstBefore);
 assert.deepEqual(saved,savedAutomaticSettings());
});
