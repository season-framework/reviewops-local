'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStore,SCHEMA_VERSION}=require('../electron/store.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-evidence-store-')),dbPath=path.join(directory,'data.sqlite'),stores=[];const open=()=>{const store=createStore({dbPath});stores.push(store);return store;};const store=open(),group=store.saveGroup({name:'로그 검사'}),project=store.saveProject({groupId:group.id,name:'등록 자료'});t.after(()=>{stores.forEach(item=>item.close());fs.rmSync(directory,{recursive:true,force:true})});return {store,open,project};}
const capture=message=>({schemaVersion:1,capturedAt:new Date().toISOString(),url:'https://example.invalid',title:'합성 화면',viewport:{width:1440,height:900,scale:1},navigation_log:[],input_log:[],network_log:[],console_log:[{level:'error',message}],fingerprint_log:{userAgent:'synthetic'}});
test('registration logs and log-only activities receive stable versions and survive backup and restart',t=>{
 const f=fixture(t),review=f.store.saveReview({projectId:f.project.id,title:'등록 로그',evidence:capture('첫 로그')});
 assert.equal(review.evidence.log_captures.length,1);assert.equal(review.evidence.log_captures[0].label,'리뷰 등록 로그');
 const activity=f.store.addActivity({reviewId:review.id,body:'',evidence:capture('후속 로그')});
 assert.equal(activity.body,'');assert.equal(activity.evidence.log_captures.length,1);
 const saved=f.store.get('reviews',review.id);assert.equal(saved.evidence.log_captures.length,2);assert.equal(saved.evidence.console_log[0].message,'후속 로그');
 assert.equal(saved.evidence.log_captures[0].id,review.evidence.log_captures[0].id);assert.equal(saved.evidence.log_captures[1].id,activity.evidence.log_captures[0].id);
 const backup=f.store.exportData();f.store.importData(backup);assert.deepEqual(f.store.exportData(),backup);
 f.store.close();assert.deepEqual(f.open().get('reviews',review.id).evidence,saved.evidence);
});
test('invalid or oversized log imports and registrations do not alter existing reviews',t=>{
 const f=fixture(t),review=f.store.saveReview({projectId:f.project.id,title:'보존할 리뷰',evidence:capture('보존할 로그')}),before=f.store.exportData();
 for(const evidence of [{console_log:{}},{console_log:Array(1001).fill({message:'overflow'})},{console_log:[{message:'x'.repeat(2*1024*1024)}]},{password:'must-not-persist'}]){assert.throws(()=>f.store.saveReview({id:review.id,evidence}));assert.deepEqual(f.store.exportData(),before);}
 const invalid=JSON.parse(JSON.stringify(before));invalid.reviews[0].evidence.log_captures=[{id:'../invalid'}];assert.throws(()=>f.store.importData(invalid));assert.deepEqual(f.store.exportData(),before);
});
test('version 3 SQLite and JSON data migrate with empty evidence while preserving identities',t=>{
 const f=fixture(t),review=f.store.saveReview({projectId:f.project.id,title:'기존 리뷰'}),backup=f.store.exportData();
 // Restore the actual version 3 service constraints and triggers before reopening.
 // Merely lowering user_version would leave version 5 deletion rules in this fixture.
 for(const key of ['managedProjectId','hostAlias','sshConfigPath'])f.store.db.exec(`ALTER TABLE services DROP COLUMN ${key};`);
 const schema=f.store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_runs'").get().sql;
 const indexes=f.store.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='agent_runs' AND type='index' AND sql IS NOT NULL").all();
 f.store.db.exec('DROP TRIGGER project_service_delete; DROP TRIGGER service_delete_linked;');
 f.store.db.exec(schema.replace(/^CREATE TABLE\s+(?:"agent_runs"|agent_runs)\s*\(/i,'CREATE TABLE agent_runs_v3 (').replace('serviceId TEXT REFERENCES services(id) ON DELETE SET NULL','serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT'));
 f.store.db.exec('INSERT INTO agent_runs_v3 SELECT * FROM agent_runs; DROP TABLE agent_runs; ALTER TABLE agent_runs_v3 RENAME TO agent_runs;');
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
 `);
 f.store.db.exec('ALTER TABLE reviews DROP COLUMN evidenceJson; ALTER TABLE activities DROP COLUMN evidenceJson; PRAGMA user_version=3;');f.store.close();
 const migrated=f.open();assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(migrated.get('reviews',review.id).evidence,{});
 backup.version=3;backup.reviews.forEach(item=>delete item.evidence);backup.activities.forEach(item=>delete item.evidence);migrated.importData(backup);
 assert.equal(migrated.get('reviews',review.id).title,'기존 리뷰');assert.deepEqual(migrated.get('reviews',review.id).evidence,{});
});
