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

test('native clipboard bridge is exposed only in the main frame and preserves text and errors',async()=>{
 for(const isMainFrame of [false,true]) {
  const ipcRenderer=new EventEmitter(),exposed={},calls=[];let error=false;
  ipcRenderer.invoke=async(...args)=>{calls.push(args);return error?{ok:false,error:{message:'clipboard denied',code:'COPY_FAILED'}}:{ok:true,data:{copied:true}};};
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/preload.cjs'),'utf8'),{require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value}},webUtils:{getPathForFile:()=>''}}),process:{isMainFrame}});
  assert.equal(typeof exposed.reviewops.copyText,isMainFrame?'function':'undefined');
  if(!isMainFrame)continue;
  const text=' \n원문\n```code```\n';assert.equal((await exposed.reviewops.copyText(text)).copied,true);assert.equal(calls[0][0],'reviewops:invoke');assert.equal(calls[0][1],'clipboard.writeText');assert.equal(calls[0][2].text,text);
  error=true;await assert.rejects(exposed.reviewops.copyText(text),error=>error.message==='clipboard denied'&&error.code==='COPY_FAILED');
 }
});
