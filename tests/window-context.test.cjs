const test=require('node:test');
const assert=require('node:assert/strict');
const helpers=()=>import('../src/window-context.mjs');

test('main window keeps existing storage and tabs while project windows restore only their project',async()=>{
 const {windowStorageKeys,restoreWindowTabs}=await helpers();
 const saved=JSON.stringify([{id:'a',kind:'project',entityId:'A'},{id:'b',kind:'project',entityId:'B'},{id:'settings',kind:'settings'},{id:'old-service',kind:'service',entityId:'s'}]);
 assert.equal(windowStorageKeys().tabs,'reviewops.workspace.tabs');
 assert.equal(windowStorageKeys().homeSelected,'reviewops.home.selected');
 assert.equal(restoreWindowTabs(saved).active,'home');
 assert.equal(restoreWindowTabs(saved).tabs.length,5);
 const a=restoreWindowTabs(saved,'A');
 assert.equal(a.active,'a');
 assert.deepEqual(a.tabs.map(tab=>tab.id),['home','a','settings']);
 assert.notEqual(windowStorageKeys('A').tabs,windowStorageKeys('B').tabs);
 assert.notEqual(windowStorageKeys('A').homeSelected,windowStorageKeys().homeSelected);
 assert.equal(windowStorageKeys('A').home+'.selected',windowStorageKeys('A').homeSelected);
});

test('new or damaged project storage opens its own project and rejects foreign window parameters',async()=>{
 const {readWindowContext,restoreWindowTabs}=await helpers();
 assert.deepEqual(readWindowContext('?projectId=project_A&windowId=12'),{projectId:'project_A',windowId:'12'});
 assert.deepEqual(readWindowContext('?projectId=../A&windowId=%3Cscript%3E'),{projectId:'',windowId:''});
 for(const value of ['broken','{}','[null,{}]']){
  const restored=restoreWindowTabs(value,'A');
  assert.equal(restored.tabs.find(tab=>tab.id===restored.active).entityId,'A');
 }
});

test('opening a different project routes its review without changing the current window target',async()=>{
 const {externalProjectRequest}=await helpers();
 assert.equal(externalProjectRequest('','B',{reviewId:'r'}),null);
 assert.equal(externalProjectRequest('A','A',{reviewId:'r'}),null);
 assert.deepEqual(externalProjectRequest('A','B',{reviewId:'r',section:'review',reviewMode:'edit'}),{projectId:'B',reviewId:'r',section:'review',reviewMode:'edit'});
 assert.deepEqual(externalProjectRequest('A','B',{section:'review',reviewMode:'create'}),{projectId:'B',section:'review',reviewMode:'create'});
 assert.deepEqual(externalProjectRequest('A','B',{section:'settings'}),{projectId:'B',section:'settings'});
 assert.deepEqual(externalProjectRequest('A','B'),{projectId:'B'});
});

test('project navigation keeps create and settings destinations and rejects another recipient',async()=>{
 const {projectNavigationUpdate}=await helpers();
 const create={projectId:'B',reviewMode:'create',section:'review',request:20};
 assert.deepEqual(projectNavigationUpdate('B',create),{section:'review',sectionRequest:20,reviewId:'',reviewMode:'create',selectionRequest:20,integrationRequest:0});
 assert.equal(projectNavigationUpdate('A',create),null);
 assert.equal(projectNavigationUpdate('',create),null);
 assert.equal(projectNavigationUpdate('B',{...create,section:'unknown'}),null);
 assert.equal(projectNavigationUpdate('B',{...create,reviewMode:'edit'}),null);
 assert.equal(projectNavigationUpdate('B',{...create,reviewMode:'detail',section:'settings'}).section,'settings');
});

test('dirty tab notification remains true until every draft is cleared',async()=>{
 const {dirtyTabSet}=await helpers(),changes=[],dirty=dirtyTabSet(value=>changes.push(value));
 assert.equal(dirty.add('one'),dirty);dirty.add('two');dirty.delete('one');
 assert.equal(changes.at(-1),true);
 dirty.delete('two');assert.equal(changes.at(-1),false);
 dirty.add('three');dirty.clear();assert.equal(changes.at(-1),false);
 assert.equal(changes[0],false);
});

test('another window deletion preserves dirty project input context without retaining unrelated records',async()=>{
 const {preserveDeletedDrafts}=await helpers();
 const previous={groups:[{id:'g'}],projects:[{id:'A',groupId:'g',serviceIds:['s']},{id:'B',groupId:'g'}],services:[{id:'s'}],reviews:[{id:'r',projectId:'A',serviceId:'s'},{id:'other',projectId:'B'}],activities:[{id:'a',reviewId:'r'}],attachments:[{id:'f',reviewId:'r'}]};
 const next={groups:[],projects:[],services:[],reviews:[],activities:[],attachments:[]};
 const result=preserveDeletedDrafts(previous,next,[{id:'tab',kind:'project',entityId:'A'}],new Set(['tab']));
 assert.equal(result.preserved,true);
 assert.deepEqual(result.data.projects.map(row=>row.id),['A']);
 assert.deepEqual(result.data.reviews.map(row=>row.id),['r']);
 assert.deepEqual(result.data.attachments.map(row=>row.id),['f']);
 assert.deepEqual(preserveDeletedDrafts(previous,next,[],new Set()).data,next);
 const updated={...next,projects:[{id:'A',name:'Updated',groupId:'g'}],reviews:[{id:'r',title:'Latest',projectId:'A'}]};
 const fresh=preserveDeletedDrafts(previous,updated,[{id:'tab',kind:'project',entityId:'A'}],new Set(['tab']));
 assert.equal(fresh.data.projects[0].name,'Updated');assert.equal(fresh.data.reviews[0].title,'Latest');
});

test('deleted home review keeps its project while a dirty unrelated tab does not protect it',async()=>{
 const {preserveDeletedDrafts}=await helpers();
 const previous={projects:[{id:'A',groupId:'g'}],reviews:[{id:'r',projectId:'A'}]},next={projects:[],reviews:[]};
 const home=preserveDeletedDrafts(previous,next,[{id:'home',kind:'home'}],new Set(['home']),'r');
 assert.equal(home.preserved,true);assert.equal(home.data.reviews[0].id,'r');
 assert.equal(preserveDeletedDrafts(previous,next,[{id:'settings',kind:'settings'}],new Set(['settings']),'r').preserved,false);
});
