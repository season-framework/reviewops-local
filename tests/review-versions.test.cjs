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
 const a=await saveReviewVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[first.id],source:'선택한 보고서'},read);
 const second=add('second');const b=await saveReviewVersion(store,{reviewId:review.id,target:{code:'B'},attachmentIds:[second.id]},read);
 assert.notEqual(a.id,b.id);const list=await listReviewVersions(store,review.id,read);assert.equal(list.entries.length,2);assert.equal(list.entries[0].needsReview,true);assert.equal(list.entries[1].needsReview,false);assert.equal(list.entries[0].attachments[0].sha256,first.sha256);assert.equal(list.entries[1].attachments[0].sha256,second.sha256);assert.notEqual(first.sha256,second.sha256);assert.equal(list.entries[0].attachments[0].name,list.entries[1].attachments[0].name);
 changeReviewTarget(store,{reviewId:review.id,target:{code:'C',artifact:'release-3',database:'schema-4'}});assert.ok((await listReviewVersions(store,review.id,read)).entries.every(entry=>entry.needsReview));assert.equal(store.listAgentRuns(review.id).length,0);
});
test('missing and corrupted copies are shown without changing the saved version',async t=>{
 const {store,review,add,read,bytes}=setup(t),first=add('first'),second=add('second'),third=add('third');
 await saveReviewVersion(store,{reviewId:review.id,target:{artifact:'A'},attachmentIds:[first.id,second.id,third.id]},read);
 store.deleteAttachment(first.id);bytes.set(second.id,Buffer.from('changed'));bytes.delete(third.id);
 const list=await listReviewVersions(store,review.id,read);assert.deepEqual(list.entries[0].attachments.map(file=>file.status),['missing','changed','missing']);assert.equal(list.entries[0].attachments[1].sha256,second.sha256);
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{artifact:'B'},attachmentIds:[second.id]},read),/변경되었거나 손상/);assert.equal((await listReviewVersions(store,review.id,read)).entries.length,1);
});
test('saved version metadata survives export/import and a reopened database',async t=>{
 const {store,review,add,read,dbPath}=setup(t),file=add('backup');
 await saveReviewVersion(store,{reviewId:review.id,target:{code:'commit-a',database:'schema-a'},attachmentIds:[file.id],source:'로컬 보고서'},read);
 const expected=store.get('reviews',review.id).evidence.review_versions,backup=store.exportData();store.importData(backup);assert.deepEqual(store.get('reviews',review.id).evidence.review_versions,expected);
 const reopened=createStore({dbPath});try{assert.deepEqual(reopened.get('reviews',review.id).evidence.review_versions,expected);assert.equal((await listReviewVersions(reopened,review.id,read)).entries[0].attachments[0].status,'available')}finally{reopened.close()}
});
test('unrelated attachments and invalid requests cannot write version entries',async t=>{
 const {store,review,project,add,read}=setup(t),other=store.saveReview({title:'다른 리뷰',projectId:project.id}),file=add('other','other.txt',other.id),valid=add('valid');
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[file.id]},read),/이 리뷰/);
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{},attachmentIds:[valid.id]},read),/버전을 입력/);
 await assert.rejects(saveReviewVersion(store,{reviewId:review.id,target:{code:'A'},attachmentIds:[valid.id,valid.id]},read),/선택/);
 assert.equal((await listReviewVersions(store,review.id,read)).entries.length,0);
});
test('local version labels are removed from agent logs and instruction exports',()=>{
 const input={evidence:{review_versions:{source:'LOCAL_ONLY'},console_log:[{message:'kept'}],log_captures:[{review_versions:{source:'NESTED_LOCAL'},input_log:[]}]}};
 const result=withoutReviewVersions(input);assert.deepEqual(result,{evidence:{console_log:[{message:'kept'}],log_captures:[{input_log:[]}]}});assert.equal(input.evidence.review_versions.source,'LOCAL_ONLY');
});
