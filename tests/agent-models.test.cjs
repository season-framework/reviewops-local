const test=require('node:test');
const assert=require('node:assert/strict');
const helpers=()=>import('../src/agent-models.mjs');

test('model selection keeps automatic effort empty and replaces only unsupported effort',async()=>{
 const {automaticReasoning,defaultReasoning,supportedReasoning,reasoningOptions}=await helpers();
 const model={id:'fixture',reasoning:['low','high'],defaultReasoningEffort:'low'};
 assert.equal(supportedReasoning(model,''),'');assert.equal(supportedReasoning(model,'high'),'high');assert.equal(supportedReasoning(model,'ultra'),'low');
 assert.equal(defaultReasoning(model),'low');assert.equal(defaultReasoning(model,'high'),'high');
 assert.equal(supportedReasoning({...model,defaultReasoningEffort:'ultra'},'ultra'),'');
 assert.deepEqual(reasoningOptions({reasoning:[]}),[]);assert.equal(supportedReasoning({reasoning:[]},'high'),'');
 assert.equal(automaticReasoning(model,'ultra'),'');assert.equal(automaticReasoning(model,'high'),'high');assert.equal(automaticReasoning(model),'low');
});

test('manual model fallback follows the current form and never replaces available host models',async()=>{
 const {availableModels,manualModels}=await helpers(),host=[{id:'host',reasoning:['high']}],manual=[{id:'manual',label:'직접 등록',reasoning:['low','high'],defaultReasoningEffort:'low'}];
 assert.deepEqual(availableModels({models:host,modelSource:'host'},manual),host);
 assert.deepEqual(availableModels({models:host,modelSource:'cache'},manual),host);
 assert.deepEqual(availableModels({models:[{id:'old-manual'}],modelSource:'manual'},manual),manual);
 assert.deepEqual(availableModels(null,manual),manual);
 assert.deepEqual(manualModels([{id:''},{id:'bad id'},{id:'manual',reasoning:['low','invalid','low'],defaultReasoningEffort:'invalid'},{id:'manual'}]),[{id:'manual',label:'manual',reasoning:['low'],defaultReasoningEffort:''}]);
});

test('environment target changes for a host or saved connection change and contains no credentials',async()=>{
 const {environmentTarget}=await helpers(),service={id:'s',kind:'ssh',host:'a',port:22,username:'u',rootPath:'/work',agentBinary:'codex',password:'secret'};
 assert.equal(environmentTarget(service),environmentTarget({...service,name:'renamed',password:'different'}));
 for(const patch of [{host:'b'},{hostAlias:'other'},{agentBinary:'/other/codex'},{agentWorkPath:'/other'},{updatedAt:'new'}])assert.notEqual(environmentTarget(service),environmentTarget({...service,...patch}));
 assert.equal(environmentTarget(null),'');assert.equal(environmentTarget(service).includes('secret'),false);
});
