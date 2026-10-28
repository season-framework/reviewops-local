const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');

test('data-change subscription forwards valid revisions and stops after unsubscription',()=>{
 const ipcRenderer=new EventEmitter(),exposed={};
 ipcRenderer.invoke=async()=>({ok:true,data:{}});
 vm.runInNewContext(fs.readFileSync(require.resolve('../electron/preload.cjs'),'utf8'),{
  require:name=>{assert.equal(name,'electron');return {ipcRenderer,contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value}},webUtils:{getPathForFile:()=>''}}},
  process:{isMainFrame:false},
 });
 const received=[],stop=exposed.reviewops.onDataChange(value=>received.push(value.revision));
 for(const revision of [1,-1,'2',1.5,NaN,Number.MAX_SAFE_INTEGER+1,2])ipcRenderer.emit('reviewops:data-change',{}, {revision,privateField:'do not forward'});
 assert.deepEqual(received,[1,2]);
 stop();ipcRenderer.emit('reviewops:data-change',{}, {revision:3});
 assert.deepEqual(received,[1,2]);assert.equal(ipcRenderer.listenerCount('reviewops:data-change'),0);
 assert.equal(typeof exposed.reviewops.onDataChange(null),'function');
});

test('project-open subscription forwards only navigation fields and can unsubscribe',()=>{
 const ipcRenderer=new EventEmitter(),exposed={};
 ipcRenderer.invoke=async()=>({ok:true,data:{}});
 vm.runInNewContext(fs.readFileSync(require.resolve('../electron/preload.cjs'),'utf8'),{
  require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value}},webUtils:{getPathForFile:()=>''}}),process:{isMainFrame:false},
 });
 const received=[],stop=exposed.reviewops.onProjectOpen(value=>received.push({...value}));
 ipcRenderer.emit('reviewops:project-open',{}, {projectId:'B',section:'review',reviewMode:'create',request:2,privateField:'omitted'});
 ipcRenderer.emit('reviewops:project-open',{}, {projectId:'B',request:'3'});
 assert.deepEqual(received,[{projectId:'B',reviewId:undefined,section:'review',reviewMode:'create',request:2}]);
 stop();ipcRenderer.emit('reviewops:project-open',{}, {projectId:'B',request:3});
 assert.equal(received.length,1);assert.equal(ipcRenderer.listenerCount('reviewops:project-open'),0);
 assert.equal(typeof exposed.reviewops.onProjectOpen(null),'function');
});
