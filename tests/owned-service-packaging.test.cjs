'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {finished}=require('node:stream/promises');
const root=path.resolve(__dirname,'..'),asar=require('@electron/asar');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function bundle(t,{overrides={},build}={}){
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rv-owned-package-')));
 const fixture={temporary,manager:null};
 t.after(async()=>{if(fixture.manager)await fixture.manager.close();await fs.rm(temporary,{recursive:true,force:true});});
 const input=path.join(temporary,'input'),resources=path.join(temporary,'Mock App.app','Contents','Resources');
 await fs.mkdir(path.join(input,'electron'),{recursive:true});await fs.mkdir(resources,{recursive:true});
 const canonical=['mcp-server.cjs','automation-api.cjs','review-categories.json','owned-node-bootstrap.cjs'],bytes={};
 for(const name of canonical){bytes[name]=await fs.readFile(path.join(root,'electron',name));await fs.writeFile(path.join(input,'electron',name),overrides[name]??bytes[name]);}
 if(build!==undefined)await fs.writeFile(path.join(input,'electron','reviewops-build.json'),JSON.stringify(build));
 await finished(await asar.createPackage(input,path.join(resources,'app.asar')));
 await require(path.join(root,'scripts/after-pack.cjs'))({appOutDir:path.dirname(resources),packager:{getResourcesDir:()=>resources}});
 return Object.assign(fixture,{resources,bytes});
}
function archiveOptions(f){
 const archive=path.join(f.resources,'app.asar'),entries=new Map();
 for(const item of asar.listPackage(archive)){
  const name=item.replaceAll('\\','/').replace(/^\/+/,'');if(asar.statFile(archive,name).files)continue;
  const bytes=asar.extractFile(archive,name);entries.set(name,{path:name,bytes:bytes.length,sha256:digest(bytes)});
 }
 return {root,resources:f.resources,archive,entries,asar};
}
test('afterPack publishes the exact canonical owned bootstrap outside the archive and preserves MCP copies',async t=>{
 const f=await bundle(t);
 const physical=path.join(f.resources,'owned-services','owned-node-bootstrap.cjs');
 assert.equal(digest(await fs.readFile(physical)),digest(f.bytes['owned-node-bootstrap.cjs']));
 for(const [from,to]of [['mcp-server.cjs','reviewops-mcp.cjs'],['automation-api.cjs','automation-api.cjs'],['review-categories.json','review-categories.json']])assert.deepEqual(await fs.readFile(path.join(f.resources,'mcp',to)),f.bytes[from]);
 const archived=path.join(f.resources,'app.asar','electron','owned-node-bootstrap.cjs');
 assert.deepEqual(asar.extractFile(path.join(f.resources,'app.asar'),'electron/owned-node-bootstrap.cjs'),f.bytes['owned-node-bootstrap.cjs']);
 const probe=spawnSync(process.execPath,[archived],{cwd:f.temporary,encoding:'utf8',timeout:3000,env:{PATH:path.dirname(process.execPath)}});
 assert.equal(probe.status,1);assert.match(probe.stderr,/MODULE_NOT_FOUND/);
});
test('standalone Node starts and cooperatively stops an owned service through the actual packaged bootstrap copy',async t=>{
 const f=await bundle(t),work=path.join(f.temporary,'project');await fs.mkdir(work);
 const bootstrapPath=path.join(f.resources,'owned-services','owned-node-bootstrap.cjs'),executable=await fs.realpath(process.execPath);
 const entry=["const http=require('node:http');","http.createServer((_req,res)=>res.end(JSON.stringify({pid:process.pid,argv:process.argv,entry:__filename}))).listen(0,'127.0.0.1');"].join('\n');
 await fs.writeFile(path.join(work,'server.cjs'),entry);
 const {createProjectServiceRuntime}=require(path.join(root,'electron/project-service-runtime.cjs'));
 const manager=createProjectServiceRuntime({bootstrapPath,configPath:path.join(f.temporary,'private','services.json'),resolveBinding:(projectId,connectionId)=>({projectId,connectionId,kind:'local',rootPath:work,signature:'packaged-fixture'})});
 f.manager=manager;
 await manager.configure('project','connection',{executable,entry:'server.cjs',args:['packaged argument with spaces'],readinessUrl:'http://127.0.0.1:9999/health'});
 await manager.start('project','connection');
 const until=Date.now()+5000;let state;
 do{state=manager.state('project','connection');if(state.instance.listeners.length)break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<until);
 assert.equal(state.instance.status,'running');assert.ok(state.instance.listeners.length);
 assert.deepEqual(state.instance.actual.spawnArgv,[executable,bootstrapPath]);
 assert.equal(state.instance.urlOwnership,'unverified');assert.equal(state.instance.entrySnapshot.loadedBytesVerified,false);
 const response=await fetch('http://127.0.0.1:'+state.instance.listeners[0].port+'/health',{signal:AbortSignal.timeout(2000)}),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.pid,state.instance.pid);assert.equal(body.entry,path.join(work,'server.cjs'));assert.deepEqual(body.argv,[executable,path.join(work,'server.cjs'),'packaged argument with spaces']);
 const stopped=await manager.stop('project','connection',state.instance.instanceId);
 assert.equal(stopped.instance.status,'exited');assert.equal(stopped.instance.exit.code,0);assert.equal(stopped.instance.exit.signal,null);assert.equal(stopped.instance.exit.drainConfirmed,true);
});
test('native package verification rejects physical and archived MCP bytes outside the reviewed three-file closure',async t=>{
 const {verifyPackagedMcpResources}=await import('../scripts/packaged-bundle-guards.mjs'),f=await bundle(t),options=archiveOptions(f);
 const observed=verifyPackagedMcpResources(options);assert.equal(observed.files.length,3);assert.equal(observed.modulePath,path.join(f.resources,'mcp','reviewops-mcp.cjs'));
 for(const name of ['reviewops-mcp.cjs','automation-api.cjs','review-categories.json']){
  const file=path.join(f.resources,'mcp',name),original=await fs.readFile(file),changed=Buffer.from(original);changed[0]^=1;await fs.writeFile(file,changed);
  assert.throws(()=>verifyPackagedMcpResources(options));await fs.writeFile(file,original);
 }
 const changed=Buffer.from(f.bytes['mcp-server.cjs']);changed[0]^=1;const altered=await bundle(t,{overrides:{'mcp-server.cjs':changed}});
 assert.throws(()=>verifyPackagedMcpResources(archiveOptions(altered)),/differs from reviewed source/);
});
test('native package build identity distinguishes absent metadata from actual valid or foreign test metadata',async t=>{
 const {readPackagedBuildIdentity}=await import('../scripts/packaged-bundle-guards.mjs'),source='a'.repeat(40),version='1.4.0',valid={channel:'test',version,buildNumber:12345,developmentNumber:7,commit:source,builtAt:'2026-11-03T00:00:00.000Z'};
 const missing=await bundle(t);assert.equal(readPackagedBuildIdentity({...archiveOptions(missing),expectedHead:source,expectedVersion:version}),null);
 for(const build of [valid,(({developmentNumber,...rest})=>rest)(valid)]){
  const f=await bundle(t,{build});assert.deepEqual(readPackagedBuildIdentity({...archiveOptions(f),expectedHead:source,expectedVersion:version}),build);
 }
 for(const build of [{...valid,commit:'b'.repeat(40)},{...valid,version:'1.3.0'},{...valid,developmentNumber:0},{...valid,padding:'x'.repeat(65536)}]){
  const f=await bundle(t,{build});assert.throws(()=>readPackagedBuildIdentity({...archiveOptions(f),expectedHead:source,expectedVersion:version}));
 }
});
