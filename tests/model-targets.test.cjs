'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createModelTargets}=require('../electron/model-targets.cjs');
const host={id:'one',alias:'server-one',hostName:'example.test',user:'tester',port:22,identityFile:'/keys/id',optionsText:'HostName example.test'};
const hostState={configPath:'/fixture/config',connectionRevision:'revision-one',hosts:[host]};
test('host catalogs include local and concrete SSH hosts without a project or network access',()=>{
 const state=createModelTargets({hostState:{...hostState,hosts:[host,{id:'wildcard',alias:'*',connectable:false}]},localRoot:'/fixture/home'});
 assert.deepEqual(state.targets.map(row=>row.id),['local','host:one']);
 const remote=state.targets[1];assert.equal(remote.settings.workPath,'/');assert.equal(remote.settings.model,'');assert.equal(remote.config.hostAlias,host.alias);assert.equal(remote.config.sshConfigPath,hostState.configPath);
});
test('projects on the same host share a catalog regardless of working folder and selected model',()=>{
 const services=[{id:'a',kind:'ssh',hostAlias:host.alias,rootPath:'/work/a',agentModel:'one'},{id:'b',kind:'ssh',hostAlias:host.alias,rootPath:'/work/b',agentModel:'two'}];
 const state=createModelTargets({hostState,services});assert.equal(state.targets.length,2);assert.equal(state.serviceIds.get('a'),'host:one');assert.equal(state.serviceIds.get('b'),'host:one');
});
test('different executables have separate catalogs and only the exact selected local path shares its catalog',()=>{
 const services=[{id:'a',kind:'ssh',hostAlias:host.alias,agentBinary:'/opt/codex'},{id:'b',kind:'local',agentBinary:'codex'},{id:'c',kind:'local',agentBinary:'/app/codex'},{id:'d',kind:'local',agentBinary:'/other/codex'}];
 const state=createModelTargets({hostState,services,localBinary:'/app/codex',localRoot:'/fixture/home'});
 assert.notEqual(state.serviceIds.get('a'),'host:one');assert.notEqual(state.serviceIds.get('b'),'local');assert.equal(state.serviceIds.get('c'),'local');assert.notEqual(state.serviceIds.get('d'),'local');
 assert.equal(state.targets.find(row=>row.id===state.serviceIds.get('b')).settings.binary,'codex');
 assert.equal(state.targets.find(row=>row.id===state.serviceIds.get('a')).settings.binary,'/opt/codex');
 assert.equal(state.targets.find(row=>row.id===state.serviceIds.get('a')).accountScope,state.targets.find(row=>row.id==='host:one').accountScope);
 assert.equal(state.targets.find(row=>row.id===state.serviceIds.get('b')).accountScope,state.targets.find(row=>row.id==='local').accountScope);
});
test('connection changes invalidate signatures while host presentation changes preserve them',()=>{
 const original=createModelTargets({hostState}).targets[1];
 for(const changed of [{...hostState,groups:[{name:'renamed'}]},{...hostState,hosts:[{...host,groupId:'other',order:3}]}])assert.equal(createModelTargets({hostState:changed}).targets[1].signature,original.signature);
 for(const changed of [{...hostState,connectionRevision:'revision-two'},{...hostState,hosts:[{...host,identityFile:'/keys/other'}]}])assert.notEqual(createModelTargets({hostState:changed}).targets[1].signature,original.signature);
});
test('building a catalog never reads credentials and project changes keep its host identity',()=>{
 const service={id:'legacy',kind:'ssh',host:'legacy.test',port:22,username:'tester',authType:'password',updatedAt:'one'};
 const first=createModelTargets({services:[service],credentials:()=>{throw new Error('Secret storage is unavailable')}});
 const second=createModelTargets({services:[service]});
 const a=first.targets[1],b=second.targets[1];assert.equal(a.id,b.id);assert.equal(a.signature,b.signature);assert.equal(a.config.password,undefined);assert.match(a.signature,/^[a-f0-9]{64}$/);
 assert.equal(createModelTargets({services:[{...service,updatedAt:'two',agentInstructions:'Changed project instructions'}]}).targets[1].signature,a.signature);
 assert.notEqual(createModelTargets({services:[{...service,username:'other'}]}).targets[1].signature,a.signature);
});
