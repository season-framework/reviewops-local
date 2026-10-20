const test=require('node:test');
const assert=require('node:assert/strict');
const helpers=()=>import('../src/agent-draft.mjs');
const materials={screenshots:[{id:'old',createdAt:'2026-01-01'},{id:'latest',createdAt:'2026-01-02'}],logs:[{id:'log-a'},{id:'log-b'}],hasRequests:false,requestIds:[]};

test('a first unsent request receives default materials once and keeps its draft on reload',async()=>{
 const {initializeAgentDraft}=await helpers();
 const first=initializeAgentDraft({prompt:'First request',pending:[{token:'new-file'}]},materials);
 assert.equal(first.instruction,true);assert.equal(first.screenshotId,'latest');assert.deepEqual(first.logIds,['log-a','log-b']);assert.deepEqual(first.attachmentIds,[]);
 const edited={...first,instruction:false,screenshotId:null,logIds:[]};
 assert.deepEqual(initializeAgentDraft(edited,materials),edited);
 assert.equal(initializeAgentDraft(first,materials).pending[0].token,'new-file');
});

test('saved requests prevent automatic materials after draft loss or a new conversation',async()=>{
 const {initializeAgentDraft}=await helpers(),saved={...materials,hasRequests:true,requestIds:['accepted']};
 for(const draft of [{},{fresh:true},{prompt:'Continue',fresh:true}]){
  const next=initializeAgentDraft(draft,saved);
  assert.equal(next.instruction,false);assert.equal(next.screenshotId,null);assert.deepEqual(next.attachmentIds,[]);assert.deepEqual(next.logIds,[]);
  assert.equal(next.fresh,draft.fresh);assert.equal(next.prompt,draft.prompt);
 }
});

test('accepted requests consume all sent materials and preserve model and execution preferences',async()=>{
 const {initializeAgentDraft,acceptedAgentDraft}=await helpers();
 const sent={...initializeAgentDraft({prompt:'Send'},materials),requestId:'accepted',pending:[{token:'file'}],screenshotToken:'shot',attachmentIds:['selected'],fresh:true,independent:true,model:'selected-model',reasoningEffort:'high'};
 const next=acceptedAgentDraft(sent,sent);
 assert.equal(next.prompt,'');assert.equal(next.requestId,null);assert.equal(next.instruction,false);assert.equal(next.screenshotId,null);assert.equal(next.screenshotToken,null);assert.deepEqual(next.pending,[]);assert.deepEqual(next.attachmentIds,[]);assert.deepEqual(next.logIds,[]);assert.equal(next.fresh,false);
 assert.equal(next.model,'selected-model');assert.equal(next.reasoningEffort,'high');assert.equal(next.independent,true);
 assert.deepEqual(initializeAgentDraft(next,{...materials,hasRequests:true}),next);
});

test('accepting a request preserves a different draft and materials added in another panel',async()=>{
 const {acceptedAgentDraft}=await helpers();
 const sent={prompt:'Sent',requestId:'sent',instruction:false,screenshotId:'sent-shot',screenshotToken:null,attachmentIds:['sent-file'],logIds:['sent-log'],pending:[{token:'sent-token'}],fresh:false};
 const current={...sent,prompt:'Next draft',requestId:null,instruction:true,screenshotId:'new-shot',screenshotToken:'new-shot-token',attachmentIds:['sent-file','new-file'],logIds:['sent-log','new-log'],pending:[...sent.pending,{token:'new-token'}],fresh:true};
 const next=acceptedAgentDraft(current,sent);
 assert.equal(next.prompt,'Next draft');assert.equal(next.instruction,true);assert.equal(next.screenshotId,'new-shot');assert.equal(next.screenshotToken,'new-shot-token');assert.deepEqual(next.attachmentIds,['new-file']);assert.deepEqual(next.logIds,['new-log']);assert.deepEqual(next.pending,[{token:'new-token'}]);assert.equal(next.fresh,true);
});

test('legacy drafts remove selections retained from the last request and keep new materials',async()=>{
 const {initializeAgentDraft}=await helpers();
 const previous={instruction:true,screenshotId:'latest',attachmentIds:['sent-file'],logIds:['log-a']};
 const draft={contextInitialized:true,prompt:'Unsent text',instruction:true,screenshotId:'latest',attachmentIds:['sent-file','new-file'],logIds:['log-a','log-b'],pending:[{token:'unsent-file'}]};
 const next=initializeAgentDraft(draft,{...materials,hasRequests:true,lastRequestContext:previous});
 assert.equal(next.instruction,false);assert.equal(next.screenshotId,null);assert.deepEqual(next.attachmentIds,['new-file']);assert.deepEqual(next.logIds,['log-b']);assert.equal(next.prompt,'Unsent text');assert.deepEqual(next.pending,draft.pending);
 const manual=initializeAgentDraft({...draft,screenshotId:'different-shot'},{...materials,hasRequests:true,lastRequestContext:{instruction:false}});
 assert.equal(manual.instruction,true);assert.equal(manual.screenshotId,'different-shot');assert.deepEqual(manual.attachmentIds,draft.attachmentIds);
});

test('a rejected request keeps its request ID and materials even if older requests exist',async()=>{
 const {initializeAgentDraft}=await helpers();
 const draft={contextInitialized:true,prompt:'Retry rejected request',requestId:'not-saved',instruction:true,screenshotId:'latest',attachmentIds:['selected'],logIds:['log-a'],pending:[{token:'unsent'}],fresh:true};
 const next=initializeAgentDraft(draft,{...materials,hasRequests:true,requestIds:['earlier'],lastRequestContext:{instruction:true,screenshotId:'latest',attachmentIds:['selected'],logIds:['log-a']}});
 for(const key of Object.keys(draft))assert.deepEqual(next[key],draft[key],key);
});

test('an accepted request with a lost response is consumed from its persisted ID after restart',async()=>{
 const {initializeAgentDraft}=await helpers();
 const draft={contextVersion:1,contextInitialized:true,requestId:'accepted',prompt:'Already saved',instruction:true,screenshotId:'latest',attachmentIds:['sent'],logIds:['log-a'],pending:[{token:'consumed'}],fresh:true};
 const next=initializeAgentDraft(draft,{...materials,hasRequests:true,requestIds:['accepted']});
 assert.equal(next.prompt,'');assert.equal(next.requestId,null);assert.deepEqual(next.pending,[]);assert.equal(next.instruction,false);assert.equal(next.screenshotId,null);assert.deepEqual(next.attachmentIds,[]);assert.deepEqual(next.logIds,[]);assert.equal(next.fresh,false);
});
