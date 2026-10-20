'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createStore,CATEGORIES,SCHEMA_VERSION}=require('../electron/store.cjs');

function setup(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-categories-')),dbPath=path.join(directory,'data.sqlite'),stores=[];
  const open=()=>{const store=createStore({dbPath});stores.push(store);return store};
  t.after(()=>{for(const store of stores)store.close();fs.rmSync(directory,{recursive:true,force:true})});
  return {directory,dbPath,open,store:open()};
}
function fixture(store){
  const group=store.saveGroup({name:'분류 검사'}),service=store.saveService({groupId:group.id,name:'검사 연결',kind:'local',rootPath:os.tmpdir()}),project=store.saveProject({groupId:group.id,name:'분류 검사 프로젝트',serviceIds:[service.id]});
  return {group,service,project};
}
const copy=value=>JSON.parse(JSON.stringify(value));

test('custom categories retain stable IDs, names, reviews and unused choices across restart and backup restore',t=>{
  const f=setup(t),{store}=f,{project}=fixture(store);
  const category=store.saveReviewCategory({name:'  배포  준비  '}),unused=store.saveReviewCategory({name:'출시 후 검토'});
  assert.match(category.id,/^custom_[a-f0-9-]{36}$/);
  assert.equal(category.name,'배포 준비');
  const review=store.saveReview({projectId:project.id,title:'새 요청',category:category.id});
  const legacy=store.saveReview({projectId:project.id,title:'기존 기능 요청',category:'feature'});
  const updated=store.saveReview({id:review.id,title:'수정한 요청'});
  assert.equal(updated.category,category.id);
  const expected=store.snapshot(),backup=store.exportData();
  assert.equal(backup.version,SCHEMA_VERSION);
  store.close();const restarted=f.open();
  assert.deepEqual(restarted.snapshot(),expected);
  restarted.deleteReview(review.id);
  assert.deepEqual(restarted.settings().reviewCategories,[category,unused]);
  assert.deepEqual(restarted.importData(backup),expected);
  assert.equal(restarted.get('reviews',legacy.id).category,'feature');
  assert.deepEqual(f.open().settings().reviewCategories,[category,unused]);
});

test('category creation is duplicate-safe across stores and validates names without changing existing data',t=>{
  const f=setup(t),{store}=f;
  const category=store.saveReviewCategory({name:'Release Check'});
  assert.deepEqual(f.open().saveReviewCategory({name:'  release   check  '}),category);
  assert.deepEqual(store.saveReviewCategory({name:'Ｒｅｌｅａｓｅ Ｃｈｅｃｋ'}),category);
  assert.equal(store.saveReviewCategory({name:'버그'}).id,'bug');
  assert.equal(store.saveReviewCategory({name:'FEATURE'}).id,'feature');
  assert.deepEqual(store.settings().reviewCategories,[category]);
  const before=store.snapshot();
  for(const name of ['', ' '.repeat(5), 'a'.repeat(61), '줄\n바꿈', '제어\u0001문자', 17])assert.throws(()=>store.saveReviewCategory({name}));
  assert.deepEqual(store.snapshot(),before);
});

test('category backup validation rejects missing, duplicate and malformed registrations atomically',t=>{
  const {store}=setup(t),{project}=fixture(store),category=store.saveReviewCategory({name:'이전 자료'});
  store.saveReview({projectId:project.id,title:'보존할 요청',category:category.id});
  const before=store.snapshot(),backup=store.exportData();
  const malformed=[];
  for(const change of [settings=>delete settings.reviewCategories,settings=>settings.reviewCategories=[],settings=>settings.reviewCategories.push({...category,id:`custom_${crypto.randomUUID()}`}),settings=>settings.reviewCategories[0].id='bug',settings=>settings.reviewCategories[0].name='bug',settings=>settings.reviewCategories[0].extra='invalid']){
    const value=copy(backup);change(value.settings);malformed.push(value);
  }
  for(const value of malformed){assert.throws(()=>store.importData(value));assert.deepEqual(store.snapshot(),before)}
  assert.throws(()=>store.saveSettings({theme:'dark',reviewCategories:[]}),/사용하는 분류/);
  assert.deepEqual(store.snapshot(),before);
  assert.throws(()=>store.saveReview({projectId:project.id,title:'미등록 분류',category:`custom_${crypto.randomUUID()}`}),/분류/);
  assert.deepEqual(store.snapshot(),before);
});

test('v7 review constraint migration preserves foreign keys, indexes, triggers, history and existing category values',t=>{
  const f=setup(t),{store}=f,{group,service,project}=fixture(store);
  const review=store.saveReview({projectId:project.id,serviceId:service.id,title:'기능 요청',category:'feature',evidence:{source:'migration-fixture'}});
  const other=store.saveReview({projectId:project.id,serviceId:service.id,title:'다른 요청',category:'design'});
  const activity=store.addActivity({reviewId:review.id,body:'유지할 기록'});
  store.addAttachment({reviewId:review.id,activityId:activity.id,name:'검사.txt',mimeType:'text/plain',storageName:'migration.txt',size:4,sha256:'a'.repeat(64)});
  const run=store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'completed',response:'보존할 응답'});
  const before=store.snapshot(),beforeRuns=store.listAgentRuns();
  const dependencies=store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all().map(row=>({...row}));
  const foreignKeys=Object.fromEntries(['reviews','activities','attachments','agent_runs'].map(table=>[table,store.db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row=>({...row}))]));
  store.close();
  // The v7 fixture restores the exact former enum constraint in the persisted
  // schema, without using the migration's table-copy implementation.
  const legacy=new DatabaseSync(f.dbPath);
  const schema=legacy.prepare("SELECT sql FROM sqlite_master WHERE name='reviews'").get().sql;
  const old=schema.replace('category TEXT NOT NULL,',`category TEXT NOT NULL CHECK(category IN (${CATEGORIES.map(value=>`'${value}'`).join(',')})),`);
  assert.notEqual(old,schema);
  legacy.enableDefensive?.(false);
  legacy.exec('PRAGMA writable_schema=ON;');
  legacy.prepare("UPDATE sqlite_master SET sql=? WHERE name='reviews'").run(old);
  legacy.exec('PRAGMA writable_schema=OFF; PRAGMA user_version=7;');legacy.close();
  const verifyOld=new DatabaseSync(f.dbPath);
  assert.throws(()=>verifyOld.prepare('UPDATE reviews SET category=? WHERE id=?').run('unregistered',review.id),/CHECK/);verifyOld.close();
  const migrated=f.open();
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
  assert.deepEqual(migrated.snapshot(),before);assert.deepEqual(migrated.listAgentRuns(),beforeRuns);
  assert.deepEqual(migrated.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all().map(row=>({...row})),dependencies);
  for(const [table,keys]of Object.entries(foreignKeys))assert.deepEqual(migrated.db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row=>({...row})),keys);
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(migrated.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.throws(()=>migrated.db.prepare('UPDATE reviews SET number=? WHERE id=?').run(review.number,other.id),/UNIQUE/);
  const unlinked=migrated.saveService({groupId:group.id,name:'연결하지 않은 서비스',kind:'local',rootPath:os.tmpdir()});
  assert.throws(()=>migrated.db.prepare('UPDATE reviews SET serviceId=? WHERE id=?').run(unlinked.id,other.id),/연결된 서비스/);
  const category=migrated.saveReviewCategory({name:'이행 후 분류'});
  assert.equal(migrated.saveReview({id:other.id,category:category.id}).category,category.id);
  migrated.saveProject({id:project.id,serviceIds:[]});
  assert.equal(migrated.get('reviews',other.id).serviceId,null);
  migrated.deleteReview(review.id);
  const after=migrated.snapshot();
  assert(!after.activities.some(row=>row.reviewId===review.id));assert(!after.attachments.some(row=>row.reviewId===review.id));
  assert(!migrated.listAgentRuns().some(row=>row.id===run.id));assert(after.reviews.some(row=>row.id===other.id));
});

test('v7 JSON backups without custom categories still restore after the schema update',t=>{
  const {store}=setup(t),{project}=fixture(store);
  store.saveReview({projectId:project.id,title:'기존 기능',category:'feature'});
  const expected=store.snapshot(),backup=store.exportData();backup.version=7;
  assert.deepEqual(store.importData(backup),expected);
});
