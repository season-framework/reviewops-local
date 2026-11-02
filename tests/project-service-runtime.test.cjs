'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createProjectServiceRuntime,normalizeConfig,readSnapshot}=require('../electron/project-service-runtime.cjs');
const {checkHttp}=require('../electron/service-readiness.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,predicate){for(let n=0;n<100;n++){const value=read();if(predicate(value))return value;await sleep(20);}throw new Error('Fixture condition timed out');}
async function fixture(t,{code,spawnChild,stopTimeoutMs=100}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rv-owned-'));
 await fs.writeFile(path.join(root,'server.cjs'),code||`const http=require('node:http'),fs=require('node:fs');let count=0;http.createServer((req,res)=>{if(req.method==='POST'){count++;fs.writeFileSync('state.json',JSON.stringify({count,pid:process.pid}));}res.end(JSON.stringify({count,pid:process.pid}));}).listen(0,'127.0.0.1');`);
 let signature='A',connectionId='c';const resolveBinding=(projectId,selected)=>projectId==='p'&&selected===connectionId?{projectId,connectionId,kind:'local',rootPath:root,signature}:null;
 const manager=createProjectServiceRuntime({configPath:path.join(root,'private','config.json'),resolveBinding,spawnChild,stopTimeoutMs});
 t.after(async()=>{await manager.close();await fs.rm(root,{recursive:true,force:true});});
 const config={executable:process.execPath,entry:'server.cjs',args:['--synthetic-argument'],readinessUrl:'http://127.0.0.1:9999/health'};
 return {root,manager,config,resolveBinding,change(value){signature=value;manager.invalidate('p');},rebind(value){connectionId=value;manager.invalidate('p');}};
}
function fakeSpawn({onStop='exit'}={}){
 const children=[];
 const spawnChild=(exe,argv,options)=>{
  const child=Object.assign(new EventEmitter(),{pid:4100+children.length,connected:true,stdout:new EventEmitter(),stderr:new EventEmitter(),exitCode:null,signalCode:null});
  child.end=(code=0)=>{child.exitCode=code;child.connected=false;child.emit('exit',code,null);};
  child.kill=()=>{throw new Error('PID signalling is forbidden');};
  child.drain=()=>child.emit('message',{...child.init,type:'drain-ready'});
  child.send=(message,callback)=>{callback?.();if(message.type==='init'){child.init=message;queueMicrotask(()=>child.emit('message',{...message,type:'ready',pid:child.pid,executable:exe,argv:[exe,message.entry,...message.args],spawnArgv:[exe,...argv],cwd:options.cwd,nodeVersion:'24.0.0',reportedAt:new Date().toISOString()}));}if(message.type==='stop'&&onStop==='exit')queueMicrotask(()=>child.drain());if(message.type==='drain-ack')queueMicrotask(()=>child.end());};
  children.push(child);return child;
 };
 return {spawnChild,children};
}
test('configuration rejects shell commands, remote URLs, arbitrary argv shapes and escaped entry paths',async t=>{
 const f=await fixture(t);
 for(const change of [{executable:'node;curl bad'},{entry:'../outside.cjs'},{args:'--eval'},{args:['x\0y']},{readinessUrl:'http://example.com/'},{readinessUrl:'http://user:pass@127.0.0.1/'},{shell:true}]){
  await assert.rejects(f.manager.configure('p','c',{...f.config,...change}));
 }
 assert.throws(()=>normalizeConfig({...f.config,entry:'/tmp/server.cjs'}));
 await assert.rejects(f.manager.configure('other','c',f.config),{code:'TARGET_MISMATCH'});
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'rv-owned-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.writeFile(path.join(outside,'external.cjs'),'');await fs.symlink(path.join(outside,'external.cjs'),path.join(f.root,'link.cjs'));
 await assert.rejects(f.manager.configure('p','c',{...f.config,entry:'link.cjs'}),/프로젝트 작업 폴더/);
});
test('real owned Node runs core POST, reports exact child identity and bounded prelaunch provenance, then only that IPC child exits',async t=>{
 const f=await fixture(t),before=await fs.readFile(path.join(f.root,'server.cjs'));
 await f.manager.configure('p','c',f.config);
 const configured=await fs.stat(path.join(f.root,'private','config.json'));if(process.platform!=='win32')assert.equal(configured.mode&0o777,0o600);
 const started=await f.manager.start('p','c');assert.equal(started.instance.status,'running');assert.ok(started.instance.pid>1);
 const state=await until(()=>f.manager.state('p','c'),v=>v.instance.listeners.length>0),item=state.instance;
 assert.equal(item.actual.executable,await fs.realpath(process.execPath));assert.equal(item.actual.cwd,await fs.realpath(f.root));assert.equal(item.actual.argv[1],await fs.realpath(path.join(f.root,'server.cjs')));assert.deepEqual(item.actual.argv.slice(2),f.config.args);assert.ok(item.actual.spawnArgv[1].endsWith('owned-node-bootstrap.cjs'));
 assert.equal(item.entrySnapshot.sha256,crypto.createHash('sha256').update(before).digest('hex'));assert.equal(item.entrySnapshot.role,'prelaunch-file-snapshot');assert.equal(item.entrySnapshot.loadedBytesVerified,false);assert.equal(item.executableSnapshot.loadedBytesVerified,false);assert.equal(item.urlOwnership,'unverified');
 const url=`http://127.0.0.1:${item.listeners[0].port}`;
 const response=await fetch(url,{method:'POST'}),body=await response.json();assert.equal(body.count,1);assert.equal(body.pid,item.pid);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'state.json'),'utf8')),body);
 // A new consumer retrieves the same main-owned instance; no renderer/job object owns it.
 assert.equal(f.manager.state('p','c').instance.instanceId,item.instanceId);
 await assert.rejects(f.manager.start('p','c'),{code:'SERVICE_BUSY'});
 assert.throws(()=>f.manager.assertMutationAllowed({projectIds:['p']}),{code:'SERVICE_BUSY'});assert.doesNotThrow(()=>f.manager.assertMutationAllowed({projectIds:['unrelated']}));
 const stopped=await f.manager.stop('p','c',item.instanceId);assert.equal(stopped.instance.status,'exited');assert.equal(stopped.instance.exit.code,0);assert.equal(f.manager.hasActive(),false);assert.equal((await checkHttp(url,{timeoutMs:300})).status,'unreachable');
});
test('restart waits for exact old child exit, issues a fresh identity and rejects stale/foreign instance IDs',async t=>{
 const fake=fakeSpawn(),f=await fixture(t,fake);await f.manager.configure('p','c',f.config);
 const first=(await f.manager.start('p','c')).instance;
 await assert.rejects(f.manager.stop('p','foreign',first.instanceId),{code:'TARGET_MISMATCH'});await assert.rejects(f.manager.stop('p','c','outside-pid'),{code:'TARGET_MISMATCH'});
 const second=(await f.manager.restart('p','c',first.instanceId)).instance;assert.notEqual(second.instanceId,first.instanceId);assert.equal(fake.children[0].exitCode,0);
 fake.children[0].emit('message',{...fake.children[0].init,type:'ready',pid:fake.children[0].pid});fake.children[0].emit('exit',8,null);
 assert.equal(f.manager.state('p','c').instance.instanceId,second.instanceId);assert.equal(f.manager.state('p','c').instance.status,'running');await assert.rejects(f.manager.stop('p','c',first.instanceId),{code:'TARGET_MISMATCH'});
});
test('unconfirmed IPC shutdown retains ownership and blocks restart, config mutation and successful app-close cleanup',async t=>{
 const fake=fakeSpawn({onStop:'ignore'}),f=await fixture(t,{...fake,stopTimeoutMs:25});await f.manager.configure('p','c',f.config);const item=(await f.manager.start('p','c')).instance;
 await assert.rejects(f.manager.stop('p','c',item.instanceId),{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(f.manager.state('p','c').instance.status,'stop-unconfirmed');
 await assert.rejects(f.manager.restart('p','c',item.instanceId),{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(fake.children.length,1);await assert.rejects(f.manager.start('p','c'),{code:'SERVICE_BUSY'});await assert.rejects(f.manager.configure('p','c',f.config),{code:'SERVICE_BUSY'});await assert.rejects(f.manager.close(),{code:'SERVICE_STOP_UNCONFIRMED'});
 fake.children[0].drain();await Promise.resolve();assert.equal(f.manager.hasActive(),false);
});
test('prelaunch file snapshots remain explicitly unverified after the entry rewrites itself',async t=>{
 const f=await fixture(t,{code:`require('node:fs').writeFileSync(__filename,'// changed after execution');const timer=setInterval(()=>{},1000);exports.reviewopsShutdown=()=>clearInterval(timer);`});await f.manager.configure('p','c',f.config);const item=(await f.manager.start('p','c')).instance;
 await until(()=>require('node:fs').readFileSync(path.join(f.root,'server.cjs'),'utf8'),v=>v.startsWith('// changed'));
 assert.notEqual(item.entrySnapshot.sha256,crypto.createHash('sha256').update(await fs.readFile(path.join(f.root,'server.cjs'))).digest('hex'));assert.equal(item.entrySnapshot.loadedBytesVerified,false);
 await f.manager.stop('p','c',item.instanceId);
});
test('external port HTTP200 with swallowed EADDRINUSE is never identified as the owned service, and stopping own child preserves external server',async t=>{
 const external=http.createServer((_req,res)=>res.end('EXTERNAL'));
 await new Promise(resolve=>external.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>external.close(resolve)));
 const port=external.address().port,url=`http://127.0.0.1:${port}/health`;
 const f=await fixture(t,{code:`const s=require('node:http').createServer((q,r)=>r.end('owned'));s.on('error',e=>console.error(e.code));s.listen(${port},'127.0.0.1');const timer=setInterval(()=>{},1000);exports.reviewopsShutdown=()=>clearInterval(timer);`});await f.manager.configure('p','c',{...f.config,readinessUrl:url});const started=(await f.manager.start('p','c')).instance;
 const item=await until(()=>f.manager.state('p','c').instance,v=>v.logTail.includes('EADDRINUSE'));assert.deepEqual(item.listeners,[]);assert.equal((await checkHttp(url)).status,'responding');assert.equal(item.urlOwnership,'unverified');
 await f.manager.stop('p','c',started.instanceId);assert.equal(await (await fetch(url)).text(),'EXTERNAL');
});
test('A→B→A revision invalidates delayed start before spawn and saved settings never auto-start on a new manager',async t=>{
 const fake=fakeSpawn(),f=await fixture(t,fake);await f.manager.configure('p','c',f.config);
 const pending=f.manager.start('p','c');f.change('B');f.change('A');await assert.rejects(pending,{code:'STALE_CONTEXT'});assert.equal(fake.children.length,0);
 const restored=createProjectServiceRuntime({configPath:path.join(f.root,'private','config.json'),resolveBinding:f.resolveBinding,spawnChild:fake.spawnChild});assert.equal(restored.state('p','c').instance,null);assert.ok(restored.state('p','c').config);assert.equal(fake.children.length,0);await restored.close();
});
test('spawn exception leaves a retryable failed instance and child channel errors are not falsely treated as exit',async t=>{
 const f=await fixture(t,{spawnChild(){throw new Error('spawn-denied');}});await f.manager.configure('p','c',f.config);await assert.rejects(f.manager.start('p','c'),/spawn-denied/);assert.equal(f.manager.state('p','c').instance.status,'failed');assert.equal(f.manager.hasActive(),false);
 const fake=fakeSpawn({onStop:'ignore'}),g=await fixture(t,{...fake,stopTimeoutMs:20});await g.manager.configure('p','c',g.config);await g.manager.start('p','c');fake.children[0].emit('error',new Error('IPC send failed'));
 assert.equal(g.manager.hasActive(),true);await assert.rejects(g.manager.close(),{code:'SERVICE_STOP_UNCONFIRMED'});fake.children[0].drain();await Promise.resolve();
});
test('successful shutdown never invokes entry process.exit and clears referenced work through the cleanup hook',async t=>{
 const f=await fixture(t,{code:`process.exit=()=>{throw new Error('Must not call process.exit');};const timer=setInterval(()=>{},1000);exports.reviewopsShutdown=()=>clearInterval(timer);`});await f.manager.configure('p','c',f.config);const item=(await f.manager.start('p','c')).instance;const stopped=await f.manager.stop('p','c',item.instanceId);assert.equal(stopped.instance.exit.code,0);assert.equal(stopped.instance.exit.drainConfirmed,true);
});
test('app-close cancels preflight starts/configure permanently before spawn or settings publication',async t=>{
 const fake=fakeSpawn(),f=await fixture(t,fake);await f.manager.configure('p','c',f.config);
 const starting=f.manager.start('p','c');await f.manager.close();await assert.rejects(starting,{code:'STALE_CONTEXT'});assert.equal(fake.children.length,0);assert.equal(f.manager.hasActive(),false);await assert.rejects(f.manager.start('p','c'));
 f.manager.resume();const saving=f.manager.configure('p','c',{...f.config,args:['new']});await f.manager.close();await assert.rejects(saving,{code:'STALE_CONTEXT'});assert.deepEqual(f.manager.state('p','c').config.args,f.config.args);
});
test('bounded snapshot rejects file-to-symlink replacement at open without reading its target',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rv-snapshot-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const target=path.join(await fs.realpath(root),'entry.cjs'),outside=path.join(root,'other.cjs');await fs.writeFile(target,'original');await fs.writeFile(outside,'private');
 const open=fs.open;fs.open=async(name,...args)=>{if(name===target){await fs.unlink(target);await fs.symlink(outside,target);}return open.call(fs,name,...args);};
 try{await assert.rejects(readSnapshot(target,100,'test'));}finally{fs.open=open;}
});
test('bounded snapshot rejects oversized files and a regular-file-to-FIFO replacement without a writer',{skip:process.platform==='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rv-snapshot-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const target=path.join(await fs.realpath(root),'entry.cjs');await fs.writeFile(target,'original');await assert.rejects(readSnapshot(target,2,'test'));
 const open=fs.open;fs.open=async(name,...args)=>{if(name===target){await fs.unlink(target);require('node:child_process').execFileSync('mkfifo',[target]);}return open.call(fs,name,...args);};
 try{await assert.rejects(readSnapshot(target,100,'test'));}finally{fs.open=open;}
});

const delayedPostCode=`const fs=require('node:fs'),fsp=fs.promises,http=require('node:http');let hookCalls=0;
http.createServer((req,res)=>{if(req.method==='POST'){fs.writeFileSync('accepted','yes');setTimeout(async()=>{await fsp.writeFile('stored','complete');res.end('stored');setTimeout(()=>fsp.writeFile('after-response','also complete'),90);},160);}else res.end('idle');}).listen(0,'127.0.0.1');
exports.reviewopsShutdown=async()=>{hookCalls++;await fsp.writeFile('hook-count',String(hookCalls));};`;
test('graceful stop drains accepted POST, async writes and idle keep-alive before exact confirmed exit',async t=>{
 const f=await fixture(t,{code:delayedPostCode,stopTimeoutMs:2500});await f.manager.configure('p','c',f.config);const item=(await f.manager.start('p','c')).instance;
 const ready=await until(()=>f.manager.state('p','c').instance,v=>v.listeners.length),url=`http://127.0.0.1:${ready.listeners[0].port}`;
 await Promise.all([fetch(url).then(r=>r.text()),fetch(url).then(r=>r.text())]);
 const post=fetch(url,{method:'POST'}).then(r=>r.text());await until(()=>require('node:fs').existsSync(path.join(f.root,'accepted')),Boolean);
 let stopped=false;const stopping=f.manager.stop('p','c',item.instanceId).then(v=>{stopped=true;return v;});await sleep(40);assert.equal(stopped,false);
 assert.equal(await post,'stored');const result=await stopping;assert.equal(await fs.readFile(path.join(f.root,'stored'),'utf8'),'complete');assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'also complete');assert.equal(await fs.readFile(path.join(f.root,'hook-count'),'utf8'),'1');assert.equal(result.instance.exit.code,0);assert.equal(result.instance.exit.drainConfirmed,true);
});
test('parent IPC disconnect also drains accepted work naturally instead of calling process.exit',async t=>{
 let child;const f=await fixture(t,{code:delayedPostCode,stopTimeoutMs:2500,spawnChild(...args){return child=require('node:child_process').spawn(...args);}});await f.manager.configure('p','c',f.config);await f.manager.start('p','c');const ready=await until(()=>f.manager.state('p','c').instance,v=>v.listeners.length),url=`http://127.0.0.1:${ready.listeners[0].port}`;
 const post=fetch(url,{method:'POST'}).then(r=>r.text());await until(()=>require('node:fs').existsSync(path.join(f.root,'accepted')),Boolean);child.disconnect();assert.equal(await post,'stored');
 const ended=await until(()=>f.manager.state('p','c').instance,v=>v.exit);assert.equal(ended.exit.code,0);assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'also complete');
});
test('unresolved cleanup hook remains incomplete and preserves B/external servers until its own work explicitly resolves',async t=>{
 const external=http.createServer((_q,r)=>r.end('external'));await new Promise(r=>external.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>external.close(r)));const externalUrl=`http://127.0.0.1:${external.address().port}`;
 const b=await fixture(t,{stopTimeoutMs:1500});await b.manager.configure('p','c',b.config);await b.manager.start('p','c');const bi=await until(()=>b.manager.state('p','c').instance,v=>v.listeners.length),bUrl=`http://127.0.0.1:${bi.listeners[0].port}`;
 const a=await fixture(t,{stopTimeoutMs:35,code:`const fs=require('node:fs');require('node:http').createServer((q,r)=>r.end('A')).listen(0,'127.0.0.1');let calls=0;exports.reviewopsShutdown=()=>{fs.writeFileSync('hook-count',String(++calls));return new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);resolve();}},10);});};`});await a.manager.configure('p','c',a.config);const ai=(await a.manager.start('p','c')).instance;
 try{
  await assert.rejects(a.manager.stop('p','c',ai.instanceId),{code:'SERVICE_STOP_UNCONFIRMED'});await assert.rejects(a.manager.restart('p','c',ai.instanceId),{code:'SERVICE_STOP_UNCONFIRMED'});await assert.rejects(a.manager.close(),{code:'SERVICE_STOP_UNCONFIRMED'});
  assert.equal(a.manager.state('p','c').instance.status,'stop-unconfirmed');assert.equal(await fs.readFile(path.join(a.root,'hook-count'),'utf8'),'1');assert.equal((await fetch(bUrl)).status,200);assert.equal(await (await fetch(externalUrl)).text(),'external');
 }finally{await fs.writeFile(path.join(a.root,'release'),'owned fixture cleanup only');await until(()=>a.manager.state('p','c').instance,v=>v.exit);}
 assert.equal(a.manager.state('p','c').instance.exit.drainConfirmed,true);assert.equal((await fetch(bUrl)).status,200);assert.equal(await (await fetch(externalUrl)).text(),'external');
});
test('exit0 before the bound drain-ready marker remains incomplete and cannot authorize restart or app quit',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rv-incomplete-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'entry.cjs'),'');const fake=fakeSpawn({onStop:'ignore'}),manager=createProjectServiceRuntime({resolveBinding:()=>({projectId:'p',connectionId:'c',kind:'local',rootPath:root,signature:'A'}),spawnChild:fake.spawnChild,stopTimeoutMs:50});
 await manager.configure('p','c',{executable:process.execPath,entry:'entry.cjs',args:[],readinessUrl:'http://127.0.0.1/'});const item=(await manager.start('p','c')).instance;const stopping=manager.stop('p','c',item.instanceId);fake.children[0].end(0);await assert.rejects(stopping,{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(manager.state('p','c').instance.status,'stop-unconfirmed');await assert.rejects(manager.restart('p','c',item.instanceId),{code:'SERVICE_STOP_UNCONFIRMED'});await assert.rejects(manager.close(),{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(fake.children.length,1);
});
test('aggregate settings budget rejects before publication and preserves memory/disk for a successful fresh manager',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rv-config-budget-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'entry.cjs'),'');await fs.writeFile(path.join(root,'node-fixture'),'fixture, never executed',{mode:0o700});const configPath=path.join(root,'config.json'),resolveBinding=(projectId,connectionId)=>({projectId,connectionId,kind:'local',rootPath:root,signature:'A'}),manager=createProjectServiceRuntime({configPath,resolveBinding});
 const small={executable:path.join(root,'node-fixture'),entry:'entry.cjs',args:[],readinessUrl:'http://127.0.0.1/'},large={...small,args:Array.from({length:4},()=> 'x'.repeat(4000))};await manager.configure('first','c',small);let rejected=false,accepted=0;
 for(let index=0;index<100;index++){
  const before=await fs.readFile(configPath);try{await manager.configure('p'+index,'c',large);accepted++;}catch(error){assert.equal(error.code,'SERVICE_CONFIG_BUDGET');assert.deepEqual(await fs.readFile(configPath),before);assert.equal(manager.state('p'+index,'c').config,null);rejected=true;break;}
 }
 assert.equal(rejected,true);assert.ok(accepted>1);assert.deepEqual(manager.state('first','c').config,small);assert.ok((await fs.stat(configPath)).size<=1024*1024);
 const restored=createProjectServiceRuntime({configPath,resolveBinding});assert.deepEqual(restored.state('first','c').config,small);for(let n=0;n<accepted;n++)assert.deepEqual(restored.state('p'+n,'c').config,large);assert.equal(restored.hasActive(),false);await manager.close();await restored.close();
});
test('null and undefined cleanup rejections stay incomplete without throwing, exiting or releasing the keepalive',async()=>{
 const source=await fs.readFile(path.join(__dirname,'../electron/owned-node-bootstrap.cjs'),'utf8');
 for(const rejection of [null,undefined]){
  const sent=[],handles=new Set();let exits=0,disconnects=0;
  class Server extends EventEmitter{listen(){}address(){return null;}close(callback){callback();}}
  const child=Object.assign(new EventEmitter(),{argv:['node','bootstrap'],versions:{node:'24'},execPath:'/node',pid:42,connected:true,cwd:()=>'/private',send(message,callback){sent.push(message);callback?.();},exit(){exits++;},disconnect(){disconnects++;this.connected=false;}});
  require('node:vm').runInNewContext(source,{process:child,require:name=>name==='node:net'?{Server}:{_load:()=>({reviewopsShutdown:()=>Promise.reject(rejection)})},setInterval(){const handle={};handles.add(handle);return handle;},clearInterval:handle=>handles.delete(handle)});
  const bound={protocol:'reviewops-owned-node-v1',token:'private-token',instanceId:'owned-instance'};child.emit('message',{...bound,type:'init',entry:'/private/server.cjs',args:[]});child.emit('message',{...bound,type:'stop'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.some(v=>v.type==='drain-error'&&v.message===String(rejection)),true);assert.equal(sent.some(v=>v.type==='drain-ready'),false);assert.equal(handles.size,1);assert.equal(exits,0);assert.equal(disconnects,0);handles.clear();
 }
});
test('failed settings reset preserves memory, disk and revisions; successful reset publishes before invalidating',async t=>{
 const f=await fixture(t);await f.manager.configure('p','c',f.config);
 const configPath=path.join(f.root,'private','config.json'),before=await fs.readFile(configPath),settings=JSON.parse(JSON.stringify(f.manager.state('p','c').config)),revision=f.manager.revision('p');
 const sync=require('node:fs'),rename=sync.renameSync;
 sync.renameSync=(source,target)=>{if(target===configPath)throw Object.assign(new Error('injected config publication failure'),{code:'EACCES'});return rename(source,target);};
 try{assert.throws(()=>f.manager.forgetConfigurations(),{code:'EACCES'});}finally{sync.renameSync=rename;}
 assert.deepEqual(f.manager.state('p','c').config,settings);assert.equal(f.manager.revision('p'),revision);assert.deepEqual(await fs.readFile(configPath),before);assert.deepEqual(await fs.readdir(path.dirname(configPath)),['config.json']);
 const restored=createProjectServiceRuntime({configPath,resolveBinding:f.resolveBinding});assert.deepEqual(restored.state('p','c').config,settings);await restored.close();
 f.manager.forgetConfigurations();assert.equal(f.manager.state('p','c').config,null);assert.equal(f.manager.revision('p'),revision+1);assert.deepEqual(JSON.parse(await fs.readFile(configPath,'utf8')).configurations,[]);
});
test('outer transaction failure restores reset configuration bytes, memory and revisions after publication',async t=>{
 const f=await fixture(t);await f.manager.configure('p','c',f.config);const file=path.join(f.root,'private','config.json'),bytes=await fs.readFile(file),state=JSON.parse(JSON.stringify(f.manager.state('p','c'))),revision=f.manager.revision('p');let resetObserved=false;
 assert.throws(()=>f.manager.withConfigurationReset(()=>{assert.equal(f.manager.state('p','c').config,null);assert.deepEqual(JSON.parse(require('node:fs').readFileSync(file,'utf8')).configurations,[]);resetObserved=true;throw new Error('outer COMMIT failed');}),/outer COMMIT failed/);
 assert.equal(resetObserved,true);assert.deepEqual(f.manager.state('p','c'),state);assert.deepEqual(await fs.readFile(file),bytes);assert.equal(f.manager.revision('p'),revision);
 assert.equal(f.manager.withConfigurationReset(()=>42),42);assert.equal(f.manager.state('p','c').config,null);assert.equal(f.manager.revision('p'),revision+1);
});
test('outer transaction rollback preserves absence of a settings file when none existed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rv-no-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const configPath=path.join(root,'config.json'),manager=createProjectServiceRuntime({configPath,resolveBinding:(projectId,connectionId)=>({projectId,connectionId,kind:'local',rootPath:root,signature:'A'})});
 assert.throws(()=>manager.withConfigurationReset(()=>{assert.equal(require('node:fs').existsSync(configPath),true);throw new Error('COMMIT failed');}),/COMMIT failed/);assert.equal(require('node:fs').existsSync(configPath),false);assert.equal(manager.state('p','c').config,null);assert.equal(manager.revision('p'),0);await manager.close();
});
