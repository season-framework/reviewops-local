'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {scopedSnapshot,assertProjectAction}=require('../electron/project-qa-scope.cjs');
function fixture(){
 const snapshot={groups:[{id:'ga'},{id:'gb'}],projects:[{id:'a',groupId:'ga',serviceIds:['sa'],connection:{id:'sa'}},{id:'b',groupId:'gb',serviceIds:['sb'],connection:{id:'sb'}}],services:[{id:'sa'},{id:'sb'}],reviews:[{id:'ra',projectId:'a'},{id:'rb',projectId:'b'}],activities:[{id:'aa',reviewId:'ra'},{id:'ab',reviewId:'rb'}],attachments:[{id:'fa',reviewId:'ra'},{id:'fb',reviewId:'rb'}],settings:{theme:'light'}};
 const options={projectId:'a',snapshot,run:id=>({runa:{id,reviewId:'ra'},runb:{id,reviewId:'rb'}}[id]),request:id=>({qa:{id,reviewId:'ra'},qb:{id,reviewId:'rb'}}[id])};
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
test('directory checks and creation stay inside the project root, including symlink ancestors',t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-qa-path-')),a=path.join(folder,'a'),b=path.join(folder,'b');fs.mkdirSync(a);fs.mkdirSync(b);fs.symlinkSync(b,path.join(a,'other'));
 t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const f=fixture();f.snapshot.services[0]={id:'sa',kind:'local',rootPath:a};
 assert.doesNotThrow(()=>f.check('directory.inspect',{path:path.join(a,'missing','child')}));
 assert.doesNotThrow(()=>f.check('directory.create',{parent:a,name:'new'}));
 for(const target of [b,path.join(a,'other'),path.join(a,'other','missing')])assert.throws(()=>f.check('directory.create',{parent:target,name:'wrong'}),{code:'TARGET_MISMATCH'});
});
