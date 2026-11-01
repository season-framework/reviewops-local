'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {scopedSnapshot,assertProjectAction}=require('../electron/project-qa-scope.cjs');
function fixture(){
 const snapshot={groups:[{id:'ga'},{id:'gb'}],projects:[{id:'a',groupId:'ga',serviceIds:['sa'],connection:{id:'sa'}},{id:'b',groupId:'gb',serviceIds:['sb'],connection:{id:'sb'}}],services:[{id:'sa'},{id:'sb'}],reviews:[{id:'ra',projectId:'a'},{id:'rb',projectId:'b'}],activities:[{id:'aa',reviewId:'ra'},{id:'ab',reviewId:'rb'}],attachments:[{id:'fa',reviewId:'ra'},{id:'fb',reviewId:'rb'}],settings:{theme:'light'}};
 const options={projectId:'a',snapshot,run:id=>({runa:{id,reviewId:'ra'},runb:{id,reviewId:'rb'},login:{id,kind:'login',serviceId:'sa'},service:{id,serviceId:'sa'},reviewLogin:{id,kind:'login',serviceId:'sa',reviewId:'ra'}}[id]),request:id=>({qa:{id,reviewId:'ra'},qb:{id,reviewId:'rb'}}[id])};
 return {snapshot,check:(action,payload)=>assertProjectAction({...options,action,payload})};
}
test('project QA snapshot excludes other project reviews, groups, connections and evidence',()=>{
 const {snapshot}=fixture(),result=scopedSnapshot(snapshot,'a');
 for(const [key,id] of [['projects','a'],['groups','ga'],['services','sa'],['reviews','ra'],['activities','aa'],['attachments','fa']])assert.deepEqual(result[key].map(item=>item.id),[id]);
 assert.equal(snapshot.projects.length,2);assert.equal(scopedSnapshot(snapshot,''),snapshot);
});
test('QA IPC rejects foreign targets, global management and nested foreign evidence before dispatch',()=>{
 const {check}=fixture();
 const denied=[['group.save',{id:'gb',name:'wrong'}],['group.delete',{id:'gb'}],['settings.save',{theme:'dark'}],['backup.import',{}],['agent.login',{serviceId:'sa'}],['agent.logout',{serviceId:'sa'}],['reviewCategory.save',{name:'global'}],['project.save',{id:'b'}],['project.save',{id:'a',groupId:'gb'}],['project.save',{id:'a',serviceIds:['sb']}],['window.openProject',{projectId:'b'}],['review.save',{id:'rb',body:'wrong'}],['review.save',{projectId:'b',title:'wrong'}],['activity.update',{id:'ab',body:'wrong'}],['attachment.read',{id:'fb'}],['files.read',{serviceId:'sb',path:'a.txt'}],['agent.list',{}],['agent.cancel',{id:'runb'}],['agent.request.start',{id:'qb'}],['agent.start',{reviewId:'ra',prompt:'wrong',context:{attachmentIds:['fb']}}],['agent.start',{reviewId:'ra',retryOf:'runb'}],['review.copy',{reviewId:'ra',projectId:'b'}],['unknown.future.action',{}]];
 for(const [action,payload] of denied)assert.throws(()=>check(action,payload),{code:'TARGET_MISMATCH'},action);
 for(const [action,payload] of [['review.save',{id:'ra',body:'own'}],['project.save',{id:'a',name:'own'}],['review.version.save',{reviewId:'ra',attachmentIds:['fa']}],['files.list',{serviceId:'sa'}],['browser.capture',{id:'own-window-browser'}],['agent.start',{reviewId:'ra',context:{attachmentIds:['fa']}}],['agent.request.start',{id:'qa'}]])assert.doesNotThrow(()=>check(action,payload),action);
});
test('QA cannot inspect or cancel global authentication and service jobs even on its own connection',()=>{
 const {check}=fixture();
 assert.throws(()=>check('agent.loginState',{serviceId:'sa'}),{code:'TARGET_MISMATCH'});
 for(const action of ['agent.read','agent.cancel']){
  for(const id of ['login','service','reviewLogin'])assert.throws(()=>check(action,{id}),{code:'TARGET_MISMATCH'},action+' '+id);
  assert.doesNotThrow(()=>check(action,{id:'runa'}));
 }
});
test('deleted project QA retains empty snapshots and safe window controls without widening scope',()=>{
 const f=fixture();f.snapshot.projects=f.snapshot.projects.filter(item=>item.id!=='a');
 for(const action of ['snapshot','window.state','window.context','window.fullscreen','window.close'])assert.doesNotThrow(()=>f.check(action,{}),action);
 for(const key of ['projects','groups','services','reviews','activities','attachments'])assert.deepEqual(scopedSnapshot(f.snapshot,'a')[key],[],key);
 for(const action of ['project.save','agent.environment','directory.inspect'])assert.throws(()=>f.check(action,{}),{code:'TARGET_MISMATCH'});
 assert.throws(()=>f.check('window.context',{projectId:'b'}),{code:'TARGET_MISMATCH'});
});
test('directory checks allow both saved local roots while denying symlink escapes from either',t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-qa-path-')),a=path.join(folder,'a'),b=path.join(folder,'b'),work=path.join(folder,'work');fs.mkdirSync(a);fs.mkdirSync(b);fs.mkdirSync(work);fs.symlinkSync(b,path.join(a,'other'));fs.symlinkSync(b,path.join(work,'other'));
 t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const f=fixture();f.snapshot.services[0]={id:'sa',kind:'local',rootPath:a,agentWorkPath:work};
 for(const root of [a,work]){
  assert.doesNotThrow(()=>f.check('directory.inspect',{path:path.join(root,'missing','child')}));
  assert.doesNotThrow(()=>f.check('directory.create',{parent:root,name:'new'}));
  for(const target of [b,path.join(root,'other'),path.join(root,'other','missing')])assert.throws(()=>f.check('directory.create',{parent:target,name:'wrong'}),{code:'TARGET_MISMATCH'});
 }
});

test('QA permits only implemented read-only viewer session verbs and rejects foreign explicit targets',()=>{
 const {check}=fixture();
 for(const action of ['viewerSession.list','viewerSession.context','viewerSession.begin','viewerSession.preview','viewerSession.capture','viewerSession.end','viewerSession.closeContext']){
  assert.doesNotThrow(()=>check(action,{projectId:'a',reviewId:'ra',contextId:'own-draft',intentId:'own-intent'}),action);
  for(const payload of [{projectId:'b'},{projectId:'a',reviewId:'rb'},{projectId:'a',serviceId:'sb'}])assert.throws(()=>check(action,payload),{code:'TARGET_MISMATCH'},action);
 }
 for(const action of ['viewerSession.input','viewerSession.navigate','viewerSession.click','viewerSession.future'])assert.throws(()=>check(action,{projectId:'a'}),{code:'TARGET_MISMATCH'},action);
});
