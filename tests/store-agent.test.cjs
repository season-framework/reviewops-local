'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createStore, SCHEMA_VERSION} = require('../electron/store.cjs');

const SERVICE_FIELDS = ['agentEnabled','agentBinary','agentWorkPath','agentModel','agentReasoningEffort','agentInstructions','agentModels'];
const clone = value => JSON.parse(JSON.stringify(value));
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-agent-store-'));
  const dbPath = path.join(directory,'data.sqlite');
  const stores = [];
  const open = () => {const store=createStore({dbPath});stores.push(store);return store;};
  t.after(() => {for(const store of stores)store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const store = open();
  const group = store.saveGroup({name:'합성 테스트 그룹'});
  const service = store.saveService({groupId:group.id,name:'합성 작업 폴더',kind:'local',rootPath:directory});
  const project = store.saveProject({groupId:group.id,name:'합성 테스트 프로젝트',serviceIds:[service.id]});
  const review = store.saveReview({projectId:project.id,serviceId:service.id,title:'검색 입력 수정',body:'검색어를 유지합니다.'});
  return {store,open,directory,dbPath,group,service,project,review};
}
function start(f, extra={}) {
  return f.store.saveAgentRun({reviewId:f.review.id,serviceId:f.service.id,prompt:'검색어가 유지되도록 수정하십시오.',status:'running',model:'test-model',reasoningEffort:'high',workPath:f.directory,sessionScope:'scope-test',progress:[{sequence:1,state:'running',message:'요청 처리 시작',step:'response',createdAt:new Date().toISOString()}],...extra});
}

function windowsStore(t) {
  const windowsModule = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/store.cjs'),'utf8'), {
    require:name=>name==='node:path'?path.win32:require(name), module:windowsModule, Buffer
  });
  const store=windowsModule.exports.createStore({dbPath:':memory:'});
  t.after(()=>store.close());
  return store;
}

test('Windows preserves SSH run paths through progress, owned connection versions, deletion and backup', t => {
  const store=windowsStore(t),group=store.saveGroup({name:'Windows SSH history'});
  const project=store.saveProject({groupId:group.id,name:'SSH project',connection:{kind:'ssh',host:'example.test',username:'operator',rootPath:'/srv/project'}});
  const review=store.saveReview({projectId:project.id,serviceId:project.connection.id,title:'SSH result'});
  const run=store.saveAgentRun({reviewId:review.id,serviceId:project.connection.id,status:'running',workPath:'/srv/project',prompt:'Preserve the server path'});
  assert.equal(run.workPath,'/srv/project');
  assert.equal(store.saveAgentRun({id:run.id,output:'progress',workPath:run.workPath}).workPath,'/srv/project');
  const next=store.saveProjectConnection(project.id,{rootPath:'/srv/next-project'});
  assert.notEqual(next.connection.id,run.serviceId);
  assert.equal(store.saveAgentRun({id:run.id,status:'completed',response:'SSH result',workPath:run.workPath}).workPath,'/srv/project');
  assert.equal(store.get('agent_runs',run.id).serviceId,project.connection.id);
  let backup=clone(store.exportData());store.importData(backup);
  assert.deepEqual(clone(store.exportData()),backup);
  store.deleteService(project.connection.id);
  assert.equal(store.get('agent_runs',run.id).serviceId,null);
  assert.equal(store.saveAgentRun({id:run.id,output:'Historical output'}).workPath,'/srv/project');
  backup=clone(store.exportData());store.importData(backup);
  assert.deepEqual(clone(store.exportData()),backup);
  assert.equal(store.get('agent_runs',run.id).workPath,'/srv/project');
});

test('Windows preserves local drive and share run paths, including detached backup history', t => {
  const store=windowsStore(t),group=store.saveGroup({name:'Windows local history'});
  for(const workPath of ['C:\\Users\\Operator\\Project','\\\\server\\share\\Project']) {
    const project=store.saveProject({groupId:group.id,name:workPath,connection:{kind:'local',rootPath:workPath}});
    const review=store.saveReview({projectId:project.id,serviceId:project.connection.id,title:'Local result'});
    const run=store.saveAgentRun({reviewId:review.id,serviceId:project.connection.id,status:'running',workPath});
    assert.equal(run.workPath,workPath);
    assert.equal(store.saveAgentRun({id:run.id,status:'completed',response:'Local result'}).workPath,workPath);
    store.saveProjectConnection(project.id,null);store.deleteService(project.connection.id);
    assert.equal(store.saveAgentRun({id:run.id,output:'Detached local output'}).workPath,workPath);
  }
  const backup=clone(store.exportData());store.importData(backup);
  assert.deepEqual(clone(store.exportData()),backup);
});

test('Windows historical runs retain their paths when a legacy service changes host kind', t => {
  const store=windowsStore(t),group=store.saveGroup({name:'Legacy connection'});
  const service=store.saveService({groupId:group.id,name:'Shared SSH',kind:'ssh',host:'example.test',username:'operator',rootPath:'/srv/project'});
  const project=store.saveProject({groupId:group.id,name:'Legacy project',serviceIds:[service.id]});
  const review=store.saveReview({projectId:project.id,serviceId:service.id,title:'Historical result'});
  const run=store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'running',workPath:'/srv/project'});
  store.saveService({id:service.id,kind:'local',rootPath:'C:\\New project'});
  assert.equal(store.saveAgentRun({id:run.id,status:'completed',response:'Original SSH output',workPath:run.workPath}).workPath,'/srv/project');
  const backup=clone(store.exportData());store.importData(backup);
  assert.deepEqual(clone(store.exportData()),backup);
});

test('service agent defaults and configured paths persist without altering SSH or viewer settings', t => {
  const f=setup(t);
  assert.deepEqual(SERVICE_FIELDS.map(key=>f.service[key]),[0,'codex','','','','',[]]);
  const configured=f.store.saveService({id:f.service.id,agentEnabled:true,agentBinary:'/Applications/Test App/codex',agentWorkPath:f.directory,agentModel:'test-model',agentReasoningEffort:'high',agentInstructions:'요청한 파일만 수정하십시오.'});
  assert.equal(configured.agentEnabled,1);
  f.store.saveService({id:f.service.id,description:'이름과 설정 유지'});
  f.store.close();
  const reopened=f.open().get('services',f.service.id);
  for(const key of SERVICE_FIELDS)assert.deepEqual(reopened[key],configured[key]);
  assert.equal(reopened.viewerWidth,f.service.viewerWidth);assert.equal(reopened.rootPath,f.service.rootPath);
});

test('agent configuration rejects malformed paths, switches and unsupported settings atomically', t => {
  const f=setup(t),before=f.store.snapshot();
  for(const change of [{agentBinary:'codex; whoami'},{agentBinary:'--help'},{agentBinary:'/tmp/../codex'},{agentWorkPath:'relative'},{agentModel:'invalid model'},{agentReasoningEffort:'arbitrary'},{agentEnabled:2},{agentInstructions:'x'.repeat(50001)}]) {
    assert.throws(()=>f.store.saveService({id:f.service.id,...change}));
    assert.deepEqual(f.store.snapshot(),before);
  }
});

test('completed execution writes one agent response and preserves context across partial updates', t => {
  const f=setup(t),run=start(f);
  f.store.addActivity({reviewId:f.review.id,body:run.prompt,role:'user',agentRunId:run.id});
  const done=f.store.saveAgentRun({id:run.id,status:'completed',sessionId:'conversation-test',response:'검색어 유지 처리를 추가했습니다.',output:'synthetic output',progress:JSON.stringify([{sequence:2,state:'completed',message:'응답 작성 완료'}]),terminationConfirmed:true,usage:{input_tokens:12,output_tokens:8}});
  assert.equal(done.prompt,run.prompt);assert.equal(done.sessionScope,run.sessionScope);assert.equal(done.workPath,run.workPath);assert.equal(done.createdAt,run.createdAt);
  assert.equal(done.progress[0].sequence,2);assert.equal(done.terminationConfirmed,true);assert.equal(done.usage.output_tokens,8);
  f.store.saveAgentRun({...done});
  assert.equal(f.store.saveAgentRun({id:run.id,status:'running',response:'late update'}).status,'completed');
  const messages=f.store.snapshot().activities.filter(item=>item.agentRunId===run.id);
  assert.equal(messages.filter(item=>item.role==='agent').length,1);
  assert.equal(messages.filter(item=>item.role==='user').length,1);
  assert.equal(messages.find(item=>item.role==='agent').body,done.response);
  assert.equal('agentRuns' in f.store.snapshot(),false);
  assert.throws(()=>f.store.updateActivity({id:messages.find(item=>item.role==='agent').id,body:'응답 변조'}),/사용자가 작성한/);
});

test('failed, cancelled and interrupted executions do not produce a completed response activity', t => {
  const f=setup(t);
  for(const status of ['failed','cancelled','interrupted']) {
    const run=start(f);
    f.store.saveAgentRun({id:run.id,status,response:'진행 중 작성된 응답',error:'테스트 중지'});
    assert.equal(f.store.snapshot().activities.some(item=>item.agentRunId===run.id),false);
    assert.equal(f.store.saveAgentRun({id:run.id,status:'completed',response:'late completion'}).status,status);
  }
});

test('unfinished executions are marked interrupted after restart and completed conversations remain intact', t => {
  const f=setup(t),active=start(f),queued=start(f,{status:'queued'}),done=start(f);
  f.store.saveAgentRun({id:active.id,response:'부분 응답'});
  f.store.saveAgentRun({id:done.id,status:'completed',response:'완료 응답',sessionId:'completed-session'});
  f.store.close();const reopened=f.open();
  assert.equal(reopened.interruptAgentRuns().length,2);
  assert.equal(reopened.interruptAgentRuns().length,0);
  const rows=reopened.listAgentRuns(f.review.id);
  assert.equal(rows.find(item=>item.id===active.id).status,'interrupted');
  assert.equal(rows.find(item=>item.id===active.id).response,'부분 응답');
  assert.ok(rows.find(item=>item.id===queued.id).finishedAt);
  assert.equal(rows.find(item=>item.id===done.id).sessionId,'completed-session');
  assert.equal(reopened.snapshot().activities.filter(item=>item.role==='agent').length,1);
});

test('restart preserves only confirmed remote agent jobs and backup restore still interrupts them',t=>{
  const f=setup(t),remote=f.store.saveService({groupId:f.group.id,name:'SSH 작업',kind:'ssh',host:'example.test',username:'test',rootPath:'/tmp/project'});
  f.store.saveProject({id:f.project.id,serviceIds:[f.service.id,remote.id]});
  const metadata={version:1,ready:true,stdoutOffset:1024,stderrOffset:12};
  const durable=start(f,{serviceId:remote.id,workPath:'/tmp/project',remoteExecution:metadata});
  const preparing=start(f,{serviceId:remote.id,workPath:'/tmp/project',remoteExecution:{...metadata,ready:false}});
  const legacy=start(f,{serviceId:remote.id,workPath:'/tmp/project'}),local=start(f,{remoteExecution:metadata});
  assert.deepEqual(f.store.get('agent_runs',durable.id).remoteExecution,metadata);
  assert.equal(f.store.interruptAgentRuns({preserveRemote:true}).length,3);
  assert.equal(f.store.get('agent_runs',durable.id).status,'running');
  for(const run of [preparing,legacy,local])assert.equal(f.store.get('agent_runs',run.id).status,'interrupted');
  assert.equal(f.store.interruptAgentRuns().length,1);
  assert.equal(f.store.get('agent_runs',durable.id).status,'interrupted');
});

test('remote execution metadata rejects paths, commands and invalid output offsets',t=>{
  const f=setup(t),remote={version:1,ready:true,stdoutOffset:0,stderrOffset:0};
  for(const change of [{version:2},{ready:1},{stdoutOffset:-1},{stderrOffset:1.1},{stdoutOffset:Number.MAX_SAFE_INTEGER+1},{directory:'/tmp/arbitrary'},{command:'anything'}])assert.throws(()=>start(f,{remoteExecution:{...remote,...change}}));
  assert.equal(f.store.listAgentRuns().length,0);
});

test('fresh agent runs need a linked service, while unlinking preserves and permits updates to past executions', t => {
  const f=setup(t),run=start(f);
  const unlinked=f.store.saveService({groupId:f.group.id,name:'연결하지 않은 폴더',kind:'local',rootPath:f.directory});
  const another=f.store.saveReview({projectId:f.project.id,title:'다른 리뷰'});
  assert.throws(()=>f.store.saveAgentRun({id:run.id,reviewId:another.id}),/바꿀 수 없습니다/);
  assert.throws(()=>f.store.saveAgentRun({reviewId:f.review.id,serviceId:unlinked.id}),/연결된 서비스/);
  assert.throws(()=>f.store.addActivity({reviewId:another.id,body:'잘못된 연결',agentRunId:run.id}),/같은 리뷰/);
  f.store.saveProject({id:f.project.id,serviceIds:[]});
  assert.equal(f.store.get('reviews',f.review.id).serviceId,null);
  assert.equal(f.store.get('agent_runs',run.id).serviceId,f.service.id);
  assert.throws(()=>start(f),/연결된 서비스/);
  assert.throws(()=>start(f,{serviceId:null}),/서비스/);
  const completed=f.store.saveAgentRun({id:run.id,status:'completed',response:'연결 해제 후 받은 응답'});
  assert.equal(completed.serviceId,f.service.id);
  assert.equal(f.store.snapshot().activities.find(row=>row.agentRunId===run.id).body,completed.response);
  const unlinkedBackup=f.store.exportData();
  f.store.importData(unlinkedBackup);
  assert.deepEqual(f.store.exportData(),unlinkedBackup);
  assert.deepEqual(f.store.deleteService(f.service.id),{deleted:true});
  const historical=f.store.get('agent_runs',run.id);
  assert.equal(historical.serviceId,null);
  assert.equal(historical.prompt,run.prompt);
  assert.equal(historical.response,completed.response);
  assert.equal(f.store.get('reviews',f.review.id).serviceId,null);
  assert.equal(f.store.snapshot().activities.find(row=>row.agentRunId===run.id).body,completed.response);
  const deletedBackup=f.store.exportData();
  f.store.importData(deletedBackup);
  assert.deepEqual(f.store.exportData(),deletedBackup);
  assert.equal(f.store.saveAgentRun({id:run.id,output:'응답 기록 유지'}).serviceId,null);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('large output and progress remain bounded while the full response is preserved separately from the timeline', t => {
  const f=setup(t),run=start(f);
  const response='a'.repeat(120000),output='가'.repeat(400000);
  const done=f.store.saveAgentRun({id:run.id,status:'completed',response,output,progress:Array.from({length:250},(_,index)=>({sequence:index,message:`단계 ${index}`}))});
  assert.equal(done.response,response);assert.ok(Buffer.byteLength(done.output)<=1024*1024);assert.equal(done.output.includes('\uFFFD'),false);
  assert.equal(done.progress.length,200);assert.equal(done.progress[0].sequence,50);
  const activity=f.store.snapshot().activities.find(item=>item.agentRunId===run.id);
  assert.equal(activity.body.length,100000);assert.match(activity.body,/전체 응답은 에이전트 탭/);
});

test('current backups round-trip agent settings, sessions, progress and response links without duplicates', t => {
  const f=setup(t);
  f.store.saveService({id:f.service.id,agentEnabled:1,agentModel:'test-model',agentInstructions:'테스트 지침'});
  const run=start(f);
  f.store.addActivity({reviewId:f.review.id,body:run.prompt,agentRunId:run.id});
  const done=f.store.saveAgentRun({id:run.id,status:'completed',sessionId:'session-backup',response:'백업할 응답'});
  const backup=f.store.exportData(),untouched=clone(backup);
  assert.equal(backup.version,SCHEMA_VERSION);assert.equal(backup.agentRuns.length,1);
  f.store.importData(backup);
  assert.deepEqual(f.store.exportData(),backup);assert.deepEqual(backup,untouched);
  f.store.saveAgentRun(done);
  assert.equal(f.store.snapshot().activities.filter(item=>item.role==='agent').length,1);
});

test('invalid agent backup data never replaces existing records', t => {
  const f=setup(t),run=start(f);f.store.saveAgentRun({id:run.id,status:'completed',response:'보존할 응답'});
  const backup=f.store.exportData();
  const invalid = [
    value=>{value.agentRuns[0].status='invalid';},
    value=>{value.agentRuns[0].reviewId='missing';},
    value=>{value.agentRuns[0].serviceId='missing';},
    value=>{value.agentRuns[0].response='x'.repeat(256*1024+1);},
    value=>{value.agentRuns[0].output='x'.repeat(1024*1024+1);},
    value=>{value.agentRuns[0].progress=Array.from({length:201},()=>({message:'overflow'}));},
    value=>{value.agentRuns[0].sessionId='invalid session';},
    value=>{value.agentRuns[0].workPath='../outside';},
    value=>{value.activities.find(item=>item.role==='agent').agentRunId='missing';},
    value=>{value.agentRuns[0].status='failed';},
    value=>{value.agentRuns.push({...value.agentRuns[0]});},
    value=>{value.activities.push({...value.activities.find(item=>item.role==='agent'),id:'duplicate-response'});}
  ];
  for(const change of invalid) {
    const payload=clone(backup);change(payload);assert.throws(()=>f.store.importData(payload));assert.deepEqual(f.store.exportData(),backup);
  }
});

test('version 2 JSON backups receive safe defaults and retain original comments', t => {
  const f=setup(t);f.store.addActivity({reviewId:f.review.id,body:'기존 작업 내용'});
  const backup=f.store.exportData();backup.version=2;delete backup.agentRuns;
  for(const service of backup.services)for(const key of SERVICE_FIELDS)delete service[key];
  for(const activity of backup.activities){delete activity.role;delete activity.agentRunId;}
  const snapshot=f.store.importData(backup);
  assert.equal(snapshot.services[0].agentEnabled,0);assert.equal(snapshot.services[0].agentBinary,'codex');
  assert.equal(snapshot.activities.find(item=>item.type==='comment').body,'기존 작업 내용');
  assert.ok(snapshot.activities.every(item=>item.role==='user'&&item.agentRunId===''));
});

test('an existing version 2 database migrates in place without changing rows or file metadata', t => {
  const f=setup(t),before=f.store.snapshot();
  f.store.db.exec('DROP TRIGGER IF EXISTS agent_run_service_insert; DROP TRIGGER IF EXISTS agent_run_service_update; DROP TRIGGER IF EXISTS agent_run_project_service_delete; DROP TRIGGER service_delete_linked; DROP TABLE agent_runs; DROP INDEX agent_response_run;');
  for(const key of SERVICE_FIELDS)f.store.db.exec(`ALTER TABLE services DROP COLUMN ${key};`);
  for(const key of ['managedProjectId','hostAlias','sshConfigPath'])f.store.db.exec(`ALTER TABLE services DROP COLUMN ${key};`);
  f.store.db.exec('ALTER TABLE reviews DROP COLUMN evidenceJson; ALTER TABLE activities DROP COLUMN evidenceJson;');
  f.store.db.exec('ALTER TABLE activities DROP COLUMN role; ALTER TABLE activities DROP COLUMN agentRunId; PRAGMA user_version=2;');
  f.store.close();const migrated=f.open();
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
  assert.deepEqual(migrated.snapshot(),before);assert.deepEqual(migrated.listAgentRuns(),[]);
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('version 4 agent history migrates with every record intact and allows detach, deletion and backup restoration', t=>{
  const f=setup(t),run=start(f);
  f.store.addActivity({reviewId:f.review.id,body:run.prompt,agentRunId:run.id});
  f.store.saveAgentRun({id:run.id,status:'completed',response:'기존 작업 응답',sessionId:'existing-session',usage:{input_tokens:12,output_tokens:8}});
  const legacyBackup=f.store.exportData();legacyBackup.version=4;
  for(const key of ['managedProjectId','hostAlias','sshConfigPath','agentModels'])f.store.db.exec(`ALTER TABLE services DROP COLUMN ${key};`);
  const schema=f.store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_runs'").get().sql;
  const indexes=f.store.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='agent_runs' AND type='index' AND sql IS NOT NULL").all();
  f.store.db.exec('DROP TRIGGER project_service_delete; DROP TRIGGER service_delete_linked;');
  f.store.db.exec(schema.replace('CREATE TABLE "agent_runs"','CREATE TABLE agent_runs_v4').replace('serviceId TEXT REFERENCES services(id) ON DELETE SET NULL','serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT'));
  f.store.db.exec('INSERT INTO agent_runs_v4 SELECT * FROM agent_runs; DROP TABLE agent_runs; ALTER TABLE agent_runs_v4 RENAME TO agent_runs;');
  for(const index of indexes)f.store.db.exec(index.sql);
  f.store.db.exec(`
    CREATE TRIGGER project_service_delete BEFORE DELETE ON project_services
    WHEN EXISTS(SELECT 1 FROM reviews WHERE projectId=OLD.projectId AND serviceId=OLD.serviceId)
    BEGIN SELECT RAISE(ABORT, '리뷰에서 사용하는 서비스 연결은 해제할 수 없습니다.'); END;
    CREATE TRIGGER agent_run_service_insert BEFORE INSERT ON agent_runs
    WHEN NOT EXISTS(SELECT 1 FROM reviews r JOIN project_services ps ON ps.projectId=r.projectId WHERE r.id=NEW.reviewId AND ps.serviceId=NEW.serviceId)
    BEGIN SELECT RAISE(ABORT, '프로젝트에 연결된 서비스의 실행 기록만 저장할 수 있습니다.'); END;
    CREATE TRIGGER agent_run_service_update BEFORE UPDATE OF reviewId,serviceId ON agent_runs
    WHEN NOT EXISTS(SELECT 1 FROM reviews r JOIN project_services ps ON ps.projectId=r.projectId WHERE r.id=NEW.reviewId AND ps.serviceId=NEW.serviceId)
    BEGIN SELECT RAISE(ABORT, '프로젝트에 연결된 서비스의 실행 기록만 저장할 수 있습니다.'); END;
    CREATE TRIGGER agent_run_project_service_delete BEFORE DELETE ON project_services
    WHEN EXISTS(SELECT 1 FROM agent_runs a JOIN reviews r ON r.id=a.reviewId WHERE r.projectId=OLD.projectId AND a.serviceId=OLD.serviceId)
    BEGIN SELECT RAISE(ABORT, '에이전트 실행 기록에서 사용하는 서비스 연결은 해제할 수 없습니다.'); END;
    PRAGMA user_version=4;
  `);
  assert.equal(f.store.db.prepare('PRAGMA table_info(agent_runs)').all().find(row=>row.name==='serviceId').notnull,1);
  assert.throws(()=>f.store.db.prepare('DELETE FROM project_services').run(),/연결은 해제/);
  f.store.close();
  const migrated=f.open();
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
  assert.deepEqual(migrated.exportData(),{...legacyBackup,version:SCHEMA_VERSION});
  migrated.importData(legacyBackup);
  assert.deepEqual(migrated.exportData(),{...legacyBackup,version:SCHEMA_VERSION});
  migrated.saveProject({id:f.project.id,serviceIds:[]});
  migrated.deleteService(f.service.id);
  const archived=migrated.get('agent_runs',run.id);
  assert.equal(archived.serviceId,null);
  for(const field of ['response','sessionId','prompt','progress','usage'])assert.deepEqual(archived[field],legacyBackup.agentRuns[0][field]);
  const detachedBackup=migrated.exportData();
  migrated.importData(detachedBackup);
  assert.deepEqual(migrated.exportData(),detachedBackup);
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('explicit response transfer restores a missing legacy activity once and keeps stored execution options unchanged',t=>{
 const f=setup(t),run=start(f,{independentExecution:true,newConversation:false});
 const completed=f.store.saveAgentRun({id:run.id,status:'completed',response:'작업 완료',sessionId:'fixture-session'});
 const automatic=f.store.snapshot().activities.find(item=>item.agentRunId===run.id&&item.role==='agent');assert.ok(automatic);
 assert.deepEqual(f.store.transferAgentResponse(run.id),{activityId:automatic.id,alreadySaved:true});
 f.store.db.prepare('DELETE FROM activities WHERE id=?').run(automatic.id);
 const restored=f.store.transferAgentResponse(run.id);assert.equal(restored.alreadySaved,false);
 assert.deepEqual(f.store.transferAgentResponse(run.id),{activityId:restored.activityId,alreadySaved:true});
 assert.equal(f.store.snapshot().activities.filter(item=>item.agentRunId===run.id&&item.role==='agent').length,1);
 f.store.saveAgentRun({id:run.id,independentExecution:false,newConversation:true});
 assert.equal(f.store.get('agent_runs',run.id).independentExecution,true);assert.equal(f.store.get('agent_runs',run.id).newConversation,false);
 const exported=f.store.exportData();f.store.importData(exported);
 assert.equal(f.store.get('agent_runs',completed.id).independentExecution,true);
 const pending=start(f);assert.throws(()=>f.store.transferAgentResponse(pending.id),/완료된/);
});
