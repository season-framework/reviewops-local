'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createStore} = require('../electron/store.cjs');
const {createPeerReadBrowsing} = require('../electron/peer-read-browsing.cjs');

function fixture(t) {
  const store=createStore({dbPath:':memory:'});
  const group=store.saveGroup({name:'Timeline fixture'});
  const service=store.saveService({groupId:group.id,name:'Host environment',kind:'local',rootPath:'/tmp'});
  const project=store.saveProject({groupId:group.id,name:'Shared project',serviceIds:[service.id]});
  const other=store.saveProject({groupId:group.id,name:'Private project',serviceIds:[service.id]});
  const review=store.saveReview({projectId:project.id,serviceId:service.id,title:'Shared review'});
  const privateReview=store.saveReview({projectId:other.id,serviceId:service.id,title:'Private review'});
  const peer=Object.freeze({}),browsing=createPeerReadBrowsing({store,verifyPeerHandle:value=>value===peer});
  browsing.setEnabled(true);browsing.approvePeer(peer,{projectIds:[project.id]});
  const session=browsing.openSession(peer);
  t.after(()=>browsing.retireAndClose());
  const query=()=>browsing.query(session,'reviews.timeline',{projectId:project.id,reviewId:review.id});
  return {store,project,other,review,privateReview,service,peer,browsing,session,query};
}
test('peer timeline exposes shared comments, saved results and attachment metadata without execution configuration',t=>{
  const f=fixture(t),comment=f.store.addActivity({reviewId:f.review.id,body:'Visible comment'});
  const run=f.store.saveAgentRun({reviewId:f.review.id,serviceId:f.service.id,status:'completed',prompt:'PRIVATE_PROMPT',response:'Visible result',workPath:'/PRIVATE_WORK'});
  f.store.insertActivity(f.review.id,'PRIVATE_PROMPT_ACTIVITY','comment','','',{role:'user',agentRunId:run.id});
  f.store.addActivity({reviewId:f.privateReview.id,body:'PRIVATE_OTHER_REVIEW'});
  f.store.addAttachment({reviewId:f.review.id,activityId:comment.id,name:'visible.txt',mimeType:'text/plain',size:5,sha256:'a'.repeat(64),storageName:'PRIVATE_STORAGE.txt'});
  const value=f.query(),encoded=JSON.stringify(value);
  assert.ok(value.activities.some(row=>row.body==='Visible comment'));
  assert.ok(value.activities.some(row=>row.body==='Visible result'));
  assert.equal(value.attachments[0].name,'visible.txt');
  assert.equal(value.agentRuns[0].status,'completed');
  assert.equal(value.agentRuns[0].response,'Visible result');
  assert.equal(encoded.includes('PRIVATE_'),false);
  assert.equal(encoded.includes('serviceId'),false);
  assert.equal(encoded.includes('metadataJson'),false);
});
test('peer timeline rejects wrong-project reviews, revoked grants and restored dataset authority',t=>{
  const f=fixture(t),denied=error=>['NOT_FOUND','ACCESS_DENIED'].includes(error.code);
  assert.throws(()=>f.browsing.query(f.session,'reviews.timeline',{projectId:f.project.id,reviewId:f.privateReview.id}),denied);
  assert.throws(()=>f.browsing.query(f.session,'reviews.timeline',{projectId:f.other.id,reviewId:f.privateReview.id}),denied);
  f.browsing.revokePeer(f.peer);assert.throws(f.query,denied);
  f.browsing.approvePeer(f.peer,{projectIds:[f.project.id]});
  const session=f.browsing.openSession(f.peer),backup=f.store.exportData();f.store.importData(backup);
  assert.throws(()=>f.browsing.query(session,'reviews.timeline',{projectId:f.project.id,reviewId:f.review.id}),denied);
});
test('peer timeline refuses an oversized complete result instead of truncating history',t=>{
  const f=fixture(t);
  for(let index=0;index<11;index++)f.store.addActivity({reviewId:f.review.id,body:'x'.repeat(100000)});
  assert.throws(f.query,error=>error.code==='BROWSING_QUERY_LIMIT_EXCEEDED');
});
test('browser client rejects timeline target swaps and extra private fields',async()=>{
  const {createRemoteWebClient}=await import('../src/remote/client.mjs');
  let timeline={version:1,projectId:'project',reviewId:'review',activities:[],attachments:[],agentRuns:[]};
  const client=createRemoteWebClient({fetchImpl:async(url,init)=>{
    const request=JSON.parse(init.body);
    const data=url==='/web/v1/session'?{state:'approved',expiresAt:'2099-01-01T00:00:00.000Z'}:timeline;
    return new Response(JSON.stringify({version:1,requestId:request.requestId,ok:true,data}),{headers:{'Content-Type':'application/json; charset=utf-8'}});
  }});
  await client.status();assert.deepEqual(await client.read('reviews.timeline',{projectId:'project',reviewId:'review'}),timeline);
  timeline={...timeline,reviewId:'other'};
  await assert.rejects(client.read('reviews.timeline',{projectId:'project',reviewId:'review'}),error=>error.code==='INVALID_RESPONSE');
  timeline={...timeline,reviewId:'review',workPath:'/private'};
  await assert.rejects(client.read('reviews.timeline',{projectId:'project',reviewId:'review'}),error=>error.code==='INVALID_RESPONSE');
});
