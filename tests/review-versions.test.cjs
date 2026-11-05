'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createStore}=require('../electron/store.cjs');
const {changeReviewTarget,saveReviewVersion,listReviewVersions,withoutReviewVersions}=require('../electron/review-versions.cjs');
function setup(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-versions-')),dbPath=path.join(directory,'reviewops.sqlite'),store=createStore({dbPath}),bytes=new Map();
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true})});
 const group=store.saveGroup({name:'버전 검사'}),project=store.saveProject({name:'검토 대상',groupId:group.id}),review=store.saveReview({title:'자료 버전',body:'버전 검사',projectId:project.id});
 const add=(content,name='report.txt',reviewId=review.id)=>{const value=Buffer.from(content),file=store.addAttachment({reviewId,name,storageName:crypto.randomUUID()+'.txt',mimeType:'text/plain',size:value.length,sha256:crypto.createHash('sha256').update(value).digest('hex')});bytes.set(file.id,value);return file};
 const read=async file=>{if(!bytes.has(file.id))throw Object.assign(new Error('missing'),{code:'ENOENT'});return bytes.get(file.id)};
 return {store,review,project,add,read,bytes,dbPath};
}
test('version snapshots keep immutable same-name copies and mark changed target for review',async t=>{
 const {store,review,add,read}=setup(t),first=add('first');
 const a=await saveReviewVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[first.id],source:'선택한 보고서'},read,originalOperation(store));
 const second=add('second');const b=await saveReviewVersion(store,{reviewId:review.id,target:{code:'B'},attachmentIds:[second.id]},read,originalOperation(store));
 assert.notEqual(a.id,b.id);const list=await listReviewVersions(store,review.id,read);assert.equal(list.entries.length,2);assert.equal(list.entries[0].needsReview,true);assert.equal(list.entries[1].needsReview,false);assert.equal(list.entries[0].attachments[0].sha256,first.sha256);assert.equal(list.entries[1].attachments[0].sha256,second.sha256);assert.notEqual(first.sha256,second.sha256);assert.equal(list.entries[0].attachments[0].name,list.entries[1].attachments[0].name);
 changeReviewTarget(store,{reviewId:review.id,target:{code:'C',artifact:'release-3',database:'schema-4'}});assert.ok((await listReviewVersions(store,review.id,read)).entries.every(entry=>entry.needsReview));assert.equal(store.listAgentRuns(review.id).length,0);
});
test('missing and corrupted copies are shown without changing the saved version',async t=>{
 const {store,review,add,read,bytes}=setup(t),first=add('first'),second=add('second'),third=add('third');
 await saveReviewVersion(store,{reviewId:review.id,target:{artifact:'A'},attachmentIds:[first.id,second.id,third.id]},read,originalOperation(store));
 store.deleteAttachment(first.id);bytes.set(second.id,Buffer.from('changed'));bytes.delete(third.id);
 const list=await listReviewVersions(store,review.id,read);assert.deepEqual(list.entries[0].attachments.map(file=>file.status),['missing','changed','missing']);assert.equal(list.entries[0].attachments[1].sha256,second.sha256);
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{artifact:'B'},attachmentIds:[second.id]},read,originalOperation(store)),/변경되었거나 손상/);assert.equal((await listReviewVersions(store,review.id,read)).entries.length,1);
});
test('saved version metadata survives export/import and a reopened database',async t=>{
 const {store,review,add,read,dbPath}=setup(t),file=add('backup');
 await saveReviewVersion(store,{reviewId:review.id,target:{code:'commit-a',database:'schema-a'},attachmentIds:[file.id],source:'로컬 보고서'},read,originalOperation(store));
 const expected=store.get('reviews',review.id).evidence.review_versions,backup=store.exportData();store.importData(backup);assert.deepEqual(store.get('reviews',review.id).evidence.review_versions,expected);
 const reopened=createStore({dbPath});try{assert.deepEqual(reopened.get('reviews',review.id).evidence.review_versions,expected);assert.equal((await listReviewVersions(reopened,review.id,read)).entries[0].attachments[0].status,'available')}finally{reopened.close()}
});
test('unrelated attachments and invalid requests cannot write version entries',async t=>{
 const {store,review,project,add,read}=setup(t),other=store.saveReview({title:'다른 리뷰',projectId:project.id}),file=add('other','other.txt',other.id),valid=add('valid');
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[file.id]},read,originalOperation(store)),/이 리뷰/);
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{},attachmentIds:[valid.id]},read,originalOperation(store)),/버전을 입력/);
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[valid.id,valid.id]},read,originalOperation(store)),/선택/);
 assert.equal((await listReviewVersions(store,review.id,read)).entries.length,0);
});
test('local version labels are removed from agent logs and instruction exports',()=>{
 const input={evidence:{review_versions:{source:'LOCAL_ONLY'},console_log:[{message:'kept'}],log_captures:[{review_versions:{source:'NESTED_LOCAL'},input_log:[]}]}};
 const result=withoutReviewVersions(input);assert.deepEqual(result,{evidence:{console_log:[{message:'kept'}],log_captures:[{input_log:[]}]}});assert.equal(input.evidence.review_versions.source,'LOCAL_ONLY');
});

function originalOperation(store,assertScope=()=>{}) {
 return Object.freeze({admission:store.captureWriteAdmission(),assertScope});
}
function heldVersion(store,input,read,operation) {
 let entered,release;
 const reading=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
 const settled=saveReviewVersion(store,input,async file=>{entered();await gate;return read(file)},operation)
  .then(value=>({value}),error=>({error}));
 return {reading,release,settled};
}
test('version save refuses a changed target after its attachment read',async t=>{
 const {store,review,add,read}=setup(t),file=add('retained source');
 const input={reviewId:review.id,target:{code:'original-target'},source:'Keep the draft',attachmentIds:[file.id]},beforeInput=structuredClone(input);
 const held=heldVersion(store,input,read,originalOperation(store));await held.reading;let result,expected;
 try{changeReviewTarget(store,{reviewId:review.id,target:{code:'newer-target'}});expected=store.exportData();}
 finally{held.release();result=await held.settled;}
 assert.equal(result.error?.code,'REVISION_CONFLICT');assert.deepEqual(store.exportData(),expected);assert.deepEqual(input,beforeInput);
});
test('version save refuses an invalidated original frame after its attachment read',async t=>{
 const {store,review,add,read}=setup(t),file=add('retained source');let current=true;
 const operation=originalOperation(store,()=>{if(!current)throw Object.assign(new Error('The original window is no longer current.'),{code:'ACCESS_DENIED'});});
 const before=store.exportData(),held=heldVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[file.id]},read,operation);await held.reading;
 let result;try{current=false;}finally{held.release();result=await held.settled;}
 assert.equal(result.error?.code,'ACCESS_DENIED');assert.deepEqual(store.exportData(),before);
});

for(const change of ['review edit','attachment removed','attachment metadata replaced','review reborn','epoch replaced']) {
 test(`version save keeps its original snapshot when ${change} during reading`,async t=>{
  const {store,review,project,add,read}=setup(t),file=add('original bytes');
  const held=heldVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[file.id]},read,originalOperation(store));await held.reading;
  const raw={...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(review.id)};
  let expected,result;
  try{
   if(change==='review edit')store.addActivity({reviewId:review.id,body:'A legitimate later edit'});
   if(change==='attachment removed')store.deleteAttachment(file.id);
   if(change==='attachment metadata replaced')store.db.prepare('UPDATE attachments SET name=? WHERE id=?').run('newer-name.txt',file.id);
   if(change==='review reborn'){
    store.deleteReview(review.id);
    const keys=Object.keys(raw);store.db.prepare(`INSERT INTO reviews(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>raw[key]));
   }
   if(change==='epoch replaced')store.importData(store.exportData());
   expected=store.exportData();
  }finally{held.release();result=await held.settled;}
  assert.equal(result.error?.code,change==='epoch replaced'?'STALE_EPOCH':change==='review reborn'?'STALE_REVIEW':'REVISION_CONFLICT');
  assert.deepEqual(store.exportData(),expected);
 });
}
for(const failure of ['validation','rollback']) {
 test(`a ${failure} import leaves the original version save usable`,async t=>{
  const {store,review,add,read}=setup(t),file=add('original bytes'),before=store.exportData();
  const held=heldVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[file.id]},read,originalOperation(store));await held.reading;let result;
  try{
   if(failure==='validation')assert.throws(()=>store.importData({...before,format:'not-a-backup'}));
   else assert.throws(()=>store.transaction(()=>{store.importData(before);throw new Error('Deliberate replacement rollback');}),/Deliberate replacement rollback/);
   assert.deepEqual(store.exportData(),before);
  }finally{held.release();result=await held.settled;}
  assert.equal(result.error,undefined);assert.equal(store.get('reviews',review.id).evidence.review_versions.entries[0].id,result.value.id);
 });
}
test('all selected attachment metadata is checked before any byte read',async t=>{
 const {store,review,project,add,read}=setup(t),first=add('first'),other=store.saveReview({projectId:project.id,title:'Other'}),foreign=add('foreign','foreign.txt',other.id);
 let reads=0;const before=store.exportData();
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[first.id,foreign.id]},file=>{reads++;return read(file)},originalOperation(store)),/이 리뷰/);
 assert.equal(reads,0);assert.deepEqual(store.exportData(),before);
});
test('an independent SQLite writer can invalidate the original snapshot without an awaited transaction',async t=>{
 const {store,review,add,read,dbPath}=setup(t),file=add('original bytes'),other=createStore({dbPath});
 const held=heldVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[file.id]},read,originalOperation(store));await held.reading;let result,expected;
 try{other.saveReview({id:review.id,body:'Committed by the other connection'});expected=store.exportData();}
 finally{held.release();result=await held.settled;other.close();}
 assert.equal(result.error?.code,'REVISION_CONFLICT');assert.deepEqual(store.exportData(),expected);
});
test('two original version saves retain the committed winner and refuse the stale list',async t=>{
 const {store,review,add,read}=setup(t),file=add('same original bytes');
 const first=heldVersion(store,{reviewId:review.id,target:{code:'winner'},attachmentIds:[file.id]},read,originalOperation(store));
 const second=heldVersion(store,{reviewId:review.id,target:{code:'stale-loser'},attachmentIds:[file.id]},read,originalOperation(store));
 await Promise.all([first.reading,second.reading]);let winner,loser,committed;
 try{first.release();winner=await first.settled;assert.equal(winner.error,undefined);committed=store.exportData();}
 finally{first.release();second.release();loser=await second.settled;}
 assert.equal(loser.error?.code,'REVISION_CONFLICT');assert.deepEqual(store.exportData(),committed);
 const versions=store.get('reviews',review.id).evidence.review_versions;
 assert.equal(versions.entries.length,1);assert.equal(versions.entries[0].id,winner.value.id);assert.equal(versions.currentTarget.code,'winner');
});
test('a missing or forged operation is rejected before reading or writing',async t=>{
 const {store,review,add,read}=setup(t),file=add('original bytes'),before=store.exportData();let reads=0;
 for(const operation of [undefined,{admission:{},assertScope(){}}])
  await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[file.id]},value=>{reads++;return read(value)},operation),{code:'INVALID_WRITE_ADMISSION'});
 assert.equal(reads,0);assert.deepEqual(store.exportData(),before);
});
test('the actual renderer rejection path preserves draft fields and emits no success toast',async t=>{
 const vm=require('node:vm'),app=fs.readFileSync(path.join(__dirname,'../src/App.jsx'),'utf8'),panel=fs.readFileSync(path.join(__dirname,'../src/ReviewVersions.jsx'),'utf8');
 const {store,review,add,read}=setup(t),file=add('original bytes');
 const calls=[],draft={target:{code:'Keep target'},source:'Keep source',selected:[file.id]},original=structuredClone(draft);
 const context={t:value=>value,review,...draft,dirtyTarget:{current:true},
  setBusy:value=>calls.push(['busy',value]),setError:value=>calls.push(['error',value]),setToast:value=>calls.push(['toast',value]),
  setSaving:value=>calls.push(['saving',value]),setSelected:value=>calls.push(['selected',value]),setSource:value=>calls.push(['source',value]),setAttempt:()=>calls.push(['attempt']),
  invoke:async(action,input)=>{
   assert.equal(action,'review.version.save');
   return saveReviewVersion(store,input,async value=>{store.addActivity({reviewId:review.id,body:'A legitimate concurrent edit'});return read(value)},originalOperation(store));
  },reload:async()=>calls.push(['reload'])};
 const caller=app.slice(app.indexOf(' const run=async('),app.indexOf(' const beforeRestore='));
 const save=panel.slice(panel.indexOf(' const save=async('),panel.indexOf(' const disabled='));
 const execute=vm.runInNewContext(`(async()=>{${caller}\n${save}\nawait save(true);})`,context);
 await execute();assert.equal(context.dirtyTarget.current,true);
 assert.deepEqual(draft,original);
 const message='리뷰 또는 선택한 첨부 자료가 변경되었습니다. 사본을 다시 검사한 뒤 저장하십시오.';
 assert.ok(calls.some(([name,value])=>name==='error'&&value===message));
 const english=JSON.parse(fs.readFileSync(path.join(__dirname,'../src/i18n/en.json'),'utf8'));
 assert.equal(english[message],'The review or selected attachments changed. Recheck the saved copies before saving.');
 assert.equal(calls.some(([name])=>['toast','selected','source','attempt','reload'].includes(name)),false);
});


for (const code of ['ENOENT', 'EACCES']) {
 test(`version list keeps original scope failures outside a rejected ${code} byte read`, async t => {
  const {store,review,add,read}=setup(t),file=add('Original scope bytes');
  await saveReviewVersion(store,{reviewId:review.id,target:{code:'original'},attachmentIds:[file.id]},read,originalOperation(store));
  let allowed=true,entered,release;
  const reading=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
  const operation=originalOperation(store,()=>{if(!allowed)throw Object.assign(new Error('Original scope lost'),{code:'ACCESS_DENIED'});});
  const pending=listReviewVersions(store,review.id,async()=>{entered();await gate;throw Object.assign(new Error('Owned read failed'),{code});},operation)
   .then(value=>({value}),error=>({error}));
  let result,expected;
  try{await Promise.race([reading,pending.then(()=>{throw new Error('List settled before its read gate');})]);allowed=false;expected=store.exportData();}
  finally{release();result=await pending;}
  assert.equal(result.error.code,'ACCESS_DENIED');assert.equal(result.value,undefined);assert.deepEqual(store.exportData(),expected);
 });
}

test('version list settles every launched original read before an ownership refusal escapes',async t=>{
 const {store,review,add,read}=setup(t),first=add('First owned bytes'),second=add('Second owned bytes');
 await saveReviewVersion(store,{reviewId:review.id,target:{code:'paired'},attachmentIds:[first.id,second.id]},read,originalOperation(store));
 let allowed=true,allStarted,settled=false;
 const started=new Promise(resolve=>{allStarted=resolve}),releases=new Map(),reads=[];
 const operation=originalOperation(store,()=>{if(!allowed)throw Object.assign(new Error('Original scope lost'),{code:'ACCESS_DENIED'});});
 const pending=listReviewVersions(store,review.id,async file=>{
  reads.push(file.id);await new Promise(resolve=>{releases.set(file.id,resolve);if(releases.size===2)allStarted();});return read(file);
 },operation).then(value=>({value}),error=>({error})).then(result=>{settled=true;return result;});
 let result,expected;
 try{
  await Promise.race([started,pending.then(()=>{throw new Error('List settled before both original reads started');})]);
  allowed=false;expected=store.exportData();releases.get(first.id)();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false,'The second already-started read must settle before refusal');
 }finally{for(const release of releases.values())release();result=await pending;}
 assert.deepEqual(reads,[first.id,second.id]);assert.equal(result.error.code,'ACCESS_DENIED');assert.deepEqual(store.exportData(),expected);
});

test('version list permits ordinary history and service-selection edits without an aggregate fence',async t=>{
 const {store,review,project,add,read,dbPath}=setup(t),file=add('Retained version bytes');
 const first=store.saveService({groupId:project.groupId,name:'First local service',kind:'local',rootPath:path.dirname(dbPath)});
 const second=store.saveService({groupId:project.groupId,name:'Next local service',kind:'local',rootPath:path.dirname(dbPath)});
 store.saveProject({id:project.id,groupId:project.groupId,name:project.name,serviceIds:[first.id,second.id]});
 store.saveReview({id:review.id,serviceId:first.id});
 const saved=await saveReviewVersion(store,{reviewId:review.id,target:{code:'retained'},attachmentIds:[file.id]},read,originalOperation(store));
 let entered,release;const reading=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
 const pending=listReviewVersions(store,review.id,async value=>{entered();await gate;return read(value);},originalOperation(store)).then(value=>({value}),error=>({error}));
 let result,expected;
 try{
  await Promise.race([reading,pending.then(()=>{throw new Error('List settled before its read gate');})]);
  store.addActivity({reviewId:review.id,body:'Legitimate history while listing'});store.saveReview({id:review.id,serviceId:second.id,body:'Current notes preserved'});
  store.saveProject({id:project.id,groupId:project.groupId,name:project.name,serviceIds:[second.id]});expected=store.exportData();
 }finally{release();result=await pending;}
 assert.equal(result.error,undefined);assert.equal(result.value.entries[0].id,saved.id);assert.equal(result.value.entries[0].attachments[0].status,'available');
 assert.deepEqual(store.exportData(),expected);
});

test('version list retains genuine unreadable and empty results without changing their DTOs',async t=>{
 const {store,review,add,read}=setup(t),file=add('Unreadable original bytes');
 assert.deepEqual(await listReviewVersions(store,review.id,read),{currentTarget:null,entries:[]});
 const saved=await saveReviewVersion(store,{reviewId:review.id,target:{code:'unreadable'},attachmentIds:[file.id]},read,originalOperation(store));
 const before=store.exportData(),listed=await listReviewVersions(store,review.id,async()=>{throw Object.assign(new Error('Owned access denied'),{code:'EACCES'});});
 assert.equal(listed.entries[0].id,saved.id);assert.equal(listed.entries[0].attachments[0].status,'unreadable');
 assert.equal(listed.entries[0].attachments[0].message,'보관된 사본을 읽을 수 없습니다. 파일 손상 또는 접근 권한을 검사하십시오.');assert.deepEqual(store.exportData(),before);
});


for (const change of ['restored epoch', 'review reborn']) {
 test(`version list ${change} refusal preserves its cause and reload guidance`,async t=>{
  const {store,review,add,read}=setup(t),file=add('Reload-list original bytes');
  await saveReviewVersion(store,{reviewId:review.id,target:{code:'reload'},attachmentIds:[file.id]},read,originalOperation(store));
  let entered,release;const reading=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
  const pending=listReviewVersions(store,review.id,async value=>{entered();await gate;return read(value);},originalOperation(store)).then(value=>({value}),error=>({error}));
  let result,expected;
  try{
   await Promise.race([reading,pending.then(()=>{throw new Error('List settled before its read gate');})]);
   if(change==='restored epoch')store.importData(store.exportData());
   else{
    const original={...store.db.prepare('SELECT * FROM reviews WHERE id=?').get(review.id)},keys=Object.keys(original);
    store.transaction(()=>{store.deleteReview(review.id);store.db.prepare(`INSERT INTO reviews(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>original[key]));});
   }
   expected=store.exportData();
  }finally{release();result=await pending;}
  const code=change==='restored epoch'?'STALE_EPOCH':'STALE_REVIEW';
  assert.equal(result.error.code,code);assert.equal(result.error.cause.code,code);assert.notEqual(result.error,result.error.cause);
  const message='리뷰 또는 자료가 변경되었습니다. 검토자료 버전 목록을 다시 불러오십시오.';
  assert.equal(result.error.message,message);assert.deepEqual(store.exportData(),expected);
  const english=JSON.parse(fs.readFileSync(path.join(__dirname,'../src/i18n/en.json'),'utf8'));
  assert.equal(english[message],'The review or data changed. Reload the saved review-version list.');
  const translations=JSON.parse(fs.readFileSync(path.join(__dirname,'../src/i18n/translations.json'),'utf8'));
  for(const language of ['ja','zh-CN','zh-TW'])assert.ok(translations[language][message]);
 });
}
