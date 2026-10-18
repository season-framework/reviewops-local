'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStore,SCHEMA_VERSION}=require('../electron/store.cjs');
const models=[{id:'fixture-code',label:'Fixture Code',reasoning:['low','high'],defaultReasoningEffort:'high'}];
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-models-')),dbPath=path.join(dir,'data.sqlite'),stores=[];
 const open=()=>{const s=createStore({dbPath});stores.push(s);return s;};
 const store=open(),group=store.saveGroup({name:'모델 설정 검사'});
 const project=store.saveProject({groupId:group.id,name:'모델 검사 프로젝트',connection:{kind:'local',rootPath:dir}});
 t.after(()=>{stores.forEach(s=>s.close());fs.rmSync(dir,{recursive:true,force:true});});
 return {store,open,project,dir};
}
test('manual models persist through project saving, restart and backup without creating a changed historical connection',t=>{
 const f=fixture(t),p=f.store.saveProject({id:f.project.id,connection:{agentModels:models}});
 assert.deepEqual(p.connection.agentModels,models);
 const review=f.store.saveReview({projectId:p.id,serviceId:p.connection.id,title:'이전 모델 요청'});
 f.store.saveAgentRun({reviewId:review.id,serviceId:p.connection.id,prompt:'저장 검사',status:'completed',model:'fixture-code',workPath:f.dir});
 const same=f.store.saveProject({id:p.id,connection:{id:p.connection.id,agentModels:models}});
 assert.equal(same.connection.id,p.connection.id);
 const backup=f.store.exportData();f.store.close();const reopened=f.open();
 assert.deepEqual(reopened.project(p.id).connection.agentModels,models);
 reopened.importData(backup);assert.deepEqual(reopened.exportData(),backup);
 const changed=reopened.saveProject({id:p.id,connection:{agentModels:[{...models[0],label:'새 표시 이름'}]}});
 assert.notEqual(changed.connection.id,p.connection.id);
 assert.deepEqual(reopened.get('services',p.connection.id).agentModels,models);
});
test('invalid model lists and backups roll back without replacing project data',t=>{
 const f=fixture(t),p=f.store.saveProject({id:f.project.id,connection:{agentModels:models}}),before=f.store.exportData();
 for(const value of [null,{},Array(101).fill(models[0]),[{id:''}],[{id:'two words'}],[models[0],models[0]],[{id:'x',reasoning:['unsupported']}],[{id:'x',reasoning:['low'],defaultReasoningEffort:'high'}],[{id:'x',reasoning:'high'}],[{id:'x',password:'must-not-store'}]]){
  assert.throws(()=>f.store.saveProject({id:p.id,connection:{agentModels:value}}));
  assert.deepEqual(f.store.exportData(),before);
 }
 const broken=structuredClone(before);broken.services[0].agentModels=[{id:'x',reasoning:['invalid']}];
 assert.throws(()=>f.store.importData(broken));assert.deepEqual(f.store.exportData(),before);
});
test('version 6 databases and backups receive empty model lists while preserving projects and history',t=>{
 const f=fixture(t),before=f.store.exportData(),legacy=structuredClone(before);legacy.version=6;
 for(const s of legacy.services)delete s.agentModels;
 for(const p of legacy.projects)if(p.connection)delete p.connection.agentModels;
 f.store.db.exec('ALTER TABLE services DROP COLUMN agentModels; PRAGMA user_version=6;');f.store.close();
 const migrated=f.open();assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
 assert.deepEqual(migrated.exportData(),before);migrated.importData(legacy);assert.deepEqual(migrated.exportData(),before);
 assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
