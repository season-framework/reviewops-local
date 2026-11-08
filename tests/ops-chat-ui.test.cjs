'use strict';
// Pure renderer state checks. These do not launch Electron or a model.
const test=require('node:test'),assert=require('node:assert/strict');
const helpers=()=>import('../src/ops-chat-state.mjs');

test('Stop remains available through admission, a delayed turn acknowledgement and a quiet tool run',async()=>{
 const {canStopManagementConversation:stop,managementPhase:phase}=await helpers();
 assert.equal(stop({executionState:'idle',requests:[]},{submitting:true}),true);
 assert.equal(phase({executionState:'idle',requests:[]},{submitting:true}),'submitting');
 for(const status of ['queued','prepared','accepted'])assert.equal(stop({executionState:'idle',requests:[{status}]}),true,status);
 const tool={executionState:'running',activity:{phase:'working'},conversation:[],progressEvents:[{status:'running'}]};
 assert.equal(stop(tool),true);assert.equal(phase(tool),'working');
 assert.equal(phase({...tool,activity:{phase:'responding'}}),'responding');
 assert.equal(stop({executionState:'idle',requests:[{status:'completed'}],activity:{phase:'completed'}}),false);
});

test('an uncertain live connection cannot be displayed as completed or stopped',async()=>{
 const {canStopManagementConversation:stop,managementPhase:phase}=await helpers();
 const row={executionState:'unknown',activity:{phase:'completed'},requests:[{status:'completed'}]};
 assert.equal(phase(row),'unknown');assert.equal(phase(row,{stopping:true}),'unknown');assert.equal(stop(row),true);
 assert.equal(phase({executionState:'idle',activity:{phase:'stopped'},requests:[{status:'interrupted'}]}),'stopped');
 assert.equal(phase({executionState:'error',requests:[{status:'failed'}]}),'error');
 assert.equal(phase({executionState:'idle',requests:[{status:'cancelled'}]}),'stopped');
});

test('progress stays in chronological conversation order when streaming updates replace an existing event',async()=>{
 const {managementTimeline}=await helpers();
 const user={id:'user',createdAt:'2026-11-08T01:00:00Z',text:'# Original\n\n- exact'},tool={id:'tool',turnId:'one',createdAt:'2026-11-08T01:00:01Z',updatedAt:'2026-11-08T01:00:05Z',status:'completed',text:'exact output\nnext line'},assistant={id:'reply',createdAt:'2026-11-08T01:00:02Z',partial:true,text:'```js\nconst value = 1;\n'};
 const row={conversation:[user,assistant],progressEvents:[tool]};
 const timeline=managementTimeline(row);assert.deepEqual(timeline.map(entry=>entry.value.id),['user','tool','reply']);assert.equal(timeline[1].value.text,'exact output\nnext line');assert.equal(timeline[2].value,assistant);assert.deepEqual(row.conversation,[user,assistant]);
});

test('deleting one conversation clears only its UI state and retains every other draft, caret and scroll',async()=>{
 const {removeManagementUiConversation:remove}=await helpers();
 const current={selected:'one',historyOrigin:'one',drafts:{one:'discard',two:'# Keep\n\n- original',new:'new draft'},scrollPositions:{one:{top:20},two:{top:125,atBottom:false}},selections:{one:{start:0,end:3},two:{start:1,end:8}},model:'selected-model',reasoningEffort:'low',target:'review:original'};
 const next=remove(current,'one',[{id:'two'}]);assert.equal(next.selected,'two');assert.equal(next.historyOrigin,'');assert.deepEqual(next.drafts,{two:'# Keep\n\n- original',new:'new draft'});assert.deepEqual(next.scrollPositions,{two:{top:125,atBottom:false}});assert.deepEqual(next.selections,{two:{start:1,end:8}});assert.equal(next.model,current.model);assert.equal(next.target,current.target);assert.equal(current.drafts.one,'discard');
 assert.equal(remove({...current,selected:'two',historyOrigin:'two'},'one',[{id:'two'}]).selected,'two');
 assert.equal(remove(current,'one',[]).selected,'');
});

test('history previews use the latest received record without changing stored Markdown or line breaks',async()=>{
 const {managementPreview}=await helpers();
 const row={conversation:[{text:'older'},{text:'# Heading\n\n> quoted **text**\nnext line'},{text:'   '}]};
 assert.equal(managementPreview(row),'# Heading > quoted **text** next line');assert.equal(row.conversation[1].text,'# Heading\n\n> quoted **text**\nnext line');assert.equal(managementPreview({conversation:[]}),'');
});
