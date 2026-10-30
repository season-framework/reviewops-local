const test=require('node:test');
const assert=require('node:assert/strict');
const helpers=()=>import('../src/agent-draft.mjs');

test('queue edit snapshots retain selected and sent settings, materials and original links',async()=>{
 const {queueEditDraft}=await helpers();
 const row={id:'queued-a',prompt:'Keep request',newConversation:false,model:'resolved-a',reasoningEffort:'medium',executionSettings:{version:1,selected:{model:'',reasoningEffort:''},automatic:{model:true,reasoningEffort:true},sent:{model:'resolved-a',reasoningEffort:'medium'}},context:{instruction:true,screenshotId:'shot-a',attachmentIds:['file-a'],logIds:['log-a']},sourceRunId:'origin-a',sourceTarget:{workPath:'/owned'},continuedFromRunId:'continued-a',predecessorId:'before-a',requiredResult:'Saved file'};
 const before=structuredClone(row),draft=queueEditDraft(row);
 assert.equal(draft.editingId,'queued-a');assert.equal(draft.prompt,'Keep request');assert.equal(draft.model,'');assert.equal(draft.reasoningEffort,'');assert.deepEqual(draft.executionSettings.sent,{model:'resolved-a',reasoningEffort:'medium'});
 assert.equal(draft.instruction,true);assert.equal(draft.screenshotId,'shot-a');assert.deepEqual(draft.attachmentIds,['file-a']);assert.deepEqual(draft.logIds,['log-a']);assert.equal(draft.sourceRunId,'origin-a');assert.equal(draft.continuedFromRunId,'continued-a');assert.equal(draft.predecessorId,'before-a');assert.equal(draft.requiredResult,'Saved file');assert.deepEqual(row,before);
});

test('legacy follow-up normalization keeps empty text with settings and attachments accessible',async()=>{
 const {legacyFollowupDraft,hasAgentDraftContent}=await helpers();
 for(const value of [{model:'chosen'},{reasoningEffort:'high'},{pending:[{token:'file'}]},{attachmentIds:['file']},{logIds:['log']},{screenshotId:'shot'},{predecessorId:'before'},{requiredResult:'result'},{newConversation:true}]){
  const before=structuredClone(value),draft=legacyFollowupDraft(value);
  assert.equal(hasAgentDraftContent(value),true);assert.equal(hasAgentDraftContent(draft),true);assert.deepEqual(value,before);
 }
 assert.equal(hasAgentDraftContent({prompt:'  ',model:'',reasoningEffort:'',pending:[]}),false);
 assert.equal(legacyFollowupDraft({newConversation:true}).fresh,true);
 assert.equal(legacyFollowupDraft({newConversation:true,fresh:false}).fresh,false);
});

test('a late queue save response keeps later text, model, links and newly attached files',async()=>{
 const {acceptedQueueEditDraft}=await helpers();
 const sent={editingId:'queued-a',prompt:'Submitted text',model:'sent-model',pending:[{token:'consumed'}],attachmentIds:['old'],screenshotToken:'consumed-shot',sourceRunId:'origin'};
 const current={...sent,prompt:'Later edit',model:'later-model',pending:[...sent.pending,{token:'later'}],attachmentIds:['old','later-existing'],sourceRunId:'later-origin'};
 const before=structuredClone(current),next=acceptedQueueEditDraft(current,sent,{context:{attachmentIds:['old','saved-staged'],screenshotId:'saved-shot'}});
 assert.equal(next.prompt,'Later edit');assert.equal(next.model,'later-model');assert.equal(next.sourceRunId,'later-origin');assert.deepEqual(next.pending,[{token:'later'}]);assert.deepEqual(next.attachmentIds,['old','later-existing','saved-staged']);assert.equal(next.screenshotId,'saved-shot');assert.equal(next.screenshotToken,null);assert.deepEqual(current,before);
 assert.deepEqual(acceptedQueueEditDraft(sent,sent,{context:{}}),{});
 const other={...current,editingId:'queued-b'};assert.deepEqual(acceptedQueueEditDraft(other,sent,{}),other);
});

test('separate request, legacy and queue edit slots survive a remount and material refresh',async()=>{
 const {persistAgentDraft,readPersistedAgentDraft,initializeAgentDraft}=await helpers();
 const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 const general={contextVersion:1,prompt:'General draft',model:'model-g',pending:[{token:'g'}]},legacy={prompt:'Legacy draft',model:'model-l',pending:[{token:'l'}]},editing={editingId:'queued-a',contextVersion:1,prompt:'Queue edit',model:'model-e',pending:[{token:'e'}]};
 for(const [slot,value]of Object.entries({draft:general,followup:legacy,edit:editing}))persistAgentDraft(storage,`reviewops.agent.${slot}.retained`,value);
 initializeAgentDraft(general,{hasRequests:true,requestIds:['unrelated-completion'],screenshots:[],logs:[]});
 for(const [slot,value]of Object.entries({draft:general,followup:legacy,edit:editing}))assert.deepEqual(readPersistedAgentDraft(storage,`reviewops.agent.${slot}.retained`,{refresh:true}),value);
});

test('the app clipboard bridge takes priority and a rejected write remains retryable',async()=>{
 const {copyMessageText}=await import('../src/agent-conversation.mjs');
 const previous=globalThis.window,writes=[];
 try{
  globalThis.window={reviewops:{copyText:async value=>{writes.push(value);throw new Error('Denied');}}};
  assert.equal((await copyMessageText('raw response')).status,'failed');
  globalThis.window.reviewops.copyText=async value=>writes.push(value);
  assert.equal((await copyMessageText('raw response',{streaming:true})).status,'streaming');
  assert.deepEqual(writes,['raw response','raw response']);
  assert.equal((await copyMessageText('  ')).status,'empty');assert.equal(writes.length,2);
 }finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});
