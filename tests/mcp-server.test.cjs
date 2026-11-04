'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');
const {finished}=require('node:stream/promises');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createToolIntegration,publicConnectionInfo}=require('../electron/tool-integration.cjs');
const {createMcpServer,invokeSocket,options,connectionInfoResult}=require('../electron/mcp-server.cjs');

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function client({invoke=async()=>({}),projectId,connectionSelection}={}){
  const input=new PassThrough(),output=new PassThrough(),responses=[],waiters=[];
  let buffer='';output.setEncoding('utf8');output.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);responses.push(JSON.parse(line));for(const waiter of waiters.splice(0))waiter();}});
  const server=createMcpServer({input,output,invoke,projectId,connectionSelection});let sequence=0;
  const send=(method,params={},id=++sequence)=>{input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return id;};
  const read=async id=>{for(let i=0;i<100;i++){const result=responses.find(r=>r.id===id);if(result)return result;await Promise.race([new Promise(r=>waiters.push(r)),new Promise(r=>setTimeout(r,10))]);}throw new Error('Missing response '+id);};
  const initialize=async version=>read(send('initialize',{protocolVersion:version||'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}));
  return{input,output,server,send,read,responses,initialize,call:async(name,args)=>read(send('tools/call',{name,arguments:args})),close:()=>server.close()};
}
test('MCP initializes, advertises schemas and rejects calls before initialization',async()=>{
  const c=client();try{
    assert.equal((await c.read(c.send('tools/list'))).error.code,-32002);
    const init=await c.initialize('2025-06-18');assert.equal(init.result.protocolVersion,'2025-06-18');assert.deepEqual(init.result.capabilities,{tools:{listChanged:false}});
    const listed=await c.read(c.send('tools/list'));assert.ok(listed.result.tools.some(t=>t.name==='reviewops_review_create'));assert.ok(listed.result.tools.some(t=>t.name==='reviewops_qa_capture'));
    const categories=listed.result.tools.find(t=>t.name==='reviewops_review_categories_list');assert.ok(categories.annotations.readOnlyHint);assert.deepEqual(categories.inputSchema.required,['projectId']);
    assert.equal(listed.result.tools.length,27);
    const info=listed.result.tools.find(t=>t.name==='reviewops_connection_info');assert.deepEqual(info.inputSchema,{type:'object',properties:{},required:[],additionalProperties:false});assert.deepEqual(info.annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false});
    for(const suffix of ['create','list','get','cancel']){
      const tool=listed.result.tools.find(t=>t.name==='reviewops_followup_'+suffix);assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,['list','get'].includes(suffix));assert.equal(tool.annotations.openWorldHint,false);
      assert.ok(tool.inputSchema.required.includes('projectId'));assert.ok(tool.inputSchema.required.includes('reviewId'));
    }
    for(const name of ['reviewops_review_create','reviewops_review_update'])assert.match(listed.result.tools.find(t=>t.name===name).inputSchema.properties.category.description,/category ID, not a display name.*reviewops_review_categories_list/);
    assert.ok(listed.result.tools.every(t=>!t.action&&t.inputSchema.additionalProperties===false));
    assert.equal((await c.call('not_a_tool',{})).error.code,-32602);
  }finally{await c.close();}
});
test('bound MCP connection filters project discovery and rejects another project before dispatch',async()=>{
  const calls=[],c=client({projectId:'A',invoke:async(action,args)=>{calls.push({action,args});return{projects:[{id:'A'},{id:'B'}]};}});
  try{await c.initialize();assert.deepEqual((await c.call('reviewops_projects_list',{})).result.structuredContent.projects,[{id:'A'}]);
    assert.equal((await c.call('reviewops_reviews_list',{projectId:'B'})).result.isError,true);assert.equal(calls.length,1);
    const categoryAttempt=await c.call('reviewops_review_categories_list',{projectId:'B'});assert.equal(JSON.parse(categoryAttempt.result.content[0].text).code,'TARGET_MISMATCH');assert.equal(calls.length,1);
    assert.equal((await c.call('reviewops_review_update',{projectId:'A',reviewId:'r',body:'X',serviceId:'foreign'})).result.isError,true);assert.equal(calls.length,1);
    for(const suffix of ['create','list','get','cancel']){
      const response=await c.call('reviewops_followup_'+suffix,{projectId:'B',reviewId:'r',...(suffix==='list'?{}:{requestId:'q'}),...(suffix==='create'?{prompt:'Saved only'}:{})});
      assert.equal(JSON.parse(response.result.content[0].text).code,'TARGET_MISMATCH');assert.equal(calls.length,1);
    }
  }finally{await c.close();}
});
test('packaged MCP resources include category definitions and load without the source checkout',async()=>{
  const directory=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'reviewops-mcp-package-'));
  try{
    const asar=require('@electron/asar'),source=path.join(directory,'app-source'),archive=path.join(directory,'app.asar');
    await fs.mkdir(path.join(source,'electron'),{recursive:true});
    const canonical=[['mcp-server.cjs','reviewops-mcp.cjs'],['automation-api.cjs','automation-api.cjs'],['review-categories.json','review-categories.json'],['instance-discovery.cjs','instance-discovery.cjs']];
    for(const [file]of canonical)await fs.copyFile(path.resolve(__dirname,'../electron',file),path.join(source,'electron',file));
    await fs.copyFile(path.resolve(__dirname,'../electron/owned-node-bootstrap.cjs'),path.join(source,'electron/owned-node-bootstrap.cjs'));
    await finished(await asar.createPackage(source,archive));
    const build=require('../package.json').build;
    assert.equal(build.extraResources?.some(item=>canonical.some(([file])=>item.from==='electron/'+file))??false,false,'The canonical MCP files must remain in app.asar rather than extraResources');
    await require(path.resolve(__dirname,'..',build.afterPack))({appOutDir:directory,packager:{getResourcesDir:()=>directory}});
    for(const [file,target]of canonical)assert.deepEqual(await fs.readFile(path.join(directory,'mcp',target)),asar.extractFile(archive,path.join('electron',file)));
    const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'package-smoke',version:'1'}}},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}].map(value=>JSON.stringify(value)+'\n').join('');
    const result=spawnSync(process.execPath,[path.join(directory,'mcp/reviewops-mcp.cjs'),'--data-path',directory],{cwd:directory,input,encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
    const responses=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(responses.find(value=>value.id===2).result.tools.some(tool=>tool.name==='reviewops_review_categories_list'));
    assert.ok(responses.find(value=>value.id===2).result.tools.some(tool=>tool.name==='reviewops_connection_info'));
    assert.deepEqual(responses.find(value=>value.id===2).result.tools.filter(tool=>tool.name.startsWith('reviewops_followup_')).map(tool=>tool.name),['reviewops_followup_create','reviewops_followup_list','reviewops_followup_get','reviewops_followup_cancel']);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('concurrent MCP calls complete independently and preserve their request IDs',async()=>{
  const hold=deferred(),c=client({invoke:async(action,args)=>{if(args.projectId==='A')await hold.promise;return{projectId:args.projectId};}});
  try{await c.initialize();const a=c.send('tools/call',{name:'reviewops_reviews_list',arguments:{projectId:'A'}});const b=c.send('tools/call',{name:'reviewops_reviews_list',arguments:{projectId:'B'}});
    assert.equal((await c.read(b)).result.structuredContent.projectId,'B');assert.ok(!c.responses.some(r=>r.id===a));hold.resolve();assert.equal((await c.read(a)).result.structuredContent.projectId,'A');
  }finally{hold.resolve();await c.close();}
});
test('capture returns a native image block and metadata without repeating image bytes as text',async()=>{
  const c=client({invoke:async()=>({sessionId:'s',projectId:'A',windowId:'w',mimeType:'image/png',data:'cG5n',width:100,height:100,viewport:{width:50,height:50},imageToCss:{scaleX:0.5,scaleY:0.5}})});
  try{await c.initialize();const {result}=await c.call('reviewops_qa_capture',{sessionId:'s',projectId:'A',windowId:'w'});assert.equal(result.content[1].type,'image');assert.equal(result.content[1].data,'cG5n');assert.equal(result.structuredContent.projectId,'A');assert.deepEqual(result.structuredContent.imageToCss,{scaleX:0.5,scaleY:0.5});assert.equal(result.structuredContent.viewport.width,50);assert.ok(!result.content[0].text.includes('cG5n'));assert.ok(!Object.hasOwn(result.structuredContent,'data'));}finally{await c.close();}
});
test('closing MCP releases its QA sessions and keeps app windows available',async()=>{
  const calls=[],c=client({invoke:async(action,args)=>{calls.push({action,args});return{sessionId:'s',projectId:'A',windowId:'w'};}});
  await c.initialize();await c.call('reviewops_qa_open',{projectId:'A',clientId:'codex-a'});await c.close();assert.equal(calls.at(-1).action,'automation.qa.release');assert.deepEqual(calls.at(-1).args,{sessionId:'s',projectId:'A',windowId:'w'});assert.ok(!calls.some(call=>call.action==='automation.qa.close'));
});
test('invalid JSON returns a protocol error without corrupting the next request',async()=>{
  const c=client();try{c.input.write('{bad json}\n');await c.initialize();assert.ok(c.responses.some(r=>r.error?.code===-32700));assert.equal((await c.read(c.send('ping'))).result.constructor,Object);}finally{await c.close();}
});
test('stdio subprocess performs authenticated app calls and frames Unicode without stdout noise',async()=>{
  const directory=await fs.mkdtemp(path.join(process.platform==='win32'?require('node:os').tmpdir():'/tmp','rops-mcp-'));let integration,child;
  try{
    integration=await createToolIntegration({dataPath:directory,dispatch:async()=>({projects:[],services:[],reviews:[]}),showReview:async()=>({}),automationHandler:async(action,args)=>({action,projectId:args.projectId,title:'동시 QA 日本語'})});
    child=spawn(process.execPath,[path.resolve(__dirname,'../electron/mcp-server.cjs'),'--data-path',directory],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'stdio-test',version:'1'}}})+'\n');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'reviewops_reviews_list',arguments:{projectId:'A'}}})+'\n');
    for(let i=0;i<100&&!stdout.includes('동시 QA');i++)await new Promise(r=>setTimeout(r,20));
    const lines=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(lines.length,2);assert.equal(lines.find(r=>r.id===2).result.structuredContent.projectId,'A');assert.equal(stderr,'');
    child.stdin.end();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('MCP did not exit')),2000);child.once('exit',code=>{clearTimeout(timer);assert.equal(code,0);resolve();});});
  }finally{child?.kill();await integration?.close();await fs.rm(directory,{recursive:true,force:true});}
});
test('socket client refuses connection redirects and insecure credentials file',async()=>{
  const directory=await fs.mkdtemp(path.join(process.platform==='win32'?require('node:os').tmpdir():'/tmp','rops-mcp-'));const file=path.join(directory,'integrations','tools.json');
  try{await fs.mkdir(path.dirname(file));await fs.writeFile(file,JSON.stringify({version:1,socketPath:'/tmp/foreign.sock',token:'a'.repeat(64),pid:1}),{mode:0o600});await assert.rejects(invokeSocket(file,'automation.projects.list',{}),{code:'INVALID_CONNECTION'});
    if(process.platform!=='win32'){await fs.chmod(file,0o644);await assert.rejects(invokeSocket(file,'automation.projects.list',{}),{code:'APP_UNAVAILABLE'});}
    assert.throws(()=>options(['--project-id','bad/id']));assert.throws(()=>options(['--data-path','/tmp/a','--connection','/tmp/b']));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('a rejected window close retains ownership until explicit release or MCP shutdown',async()=>{
  const calls=[],c=client({invoke:async(action,args)=>{calls.push({action,args});return action==='automation.qa.close'?{closed:false}:{sessionId:'s',projectId:'A',windowId:'w'};}});
  await c.initialize();await c.call('reviewops_qa_open',{projectId:'A',clientId:'client-a'});
  await c.call('reviewops_qa_close',{sessionId:'s',projectId:'A',windowId:'w'});await c.close();
  assert.equal(calls.at(-1).action,'automation.qa.release');
});
test('an open that finishes after cancellation or disconnection immediately releases its session',async()=>{
  for(const cancellation of [true,false]){
    const hold=deferred(),released=deferred(),c=client({invoke:async(action)=>{if(action==='automation.qa.open'){await hold.promise;return{sessionId:'late',projectId:'A',windowId:'w'};}if(action==='automation.qa.release')released.resolve();return{};}});
    await c.initialize();const open=c.send('tools/call',{name:'reviewops_qa_open',arguments:{projectId:'A',clientId:'client-a'}});
    if(cancellation)c.input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:open}})+'\n');else await c.close();
    hold.resolve();await released.promise;assert.ok(!c.responses.some(r=>r.id===open));await c.close();
  }
});

test('malformed JSON values at the in-flight limit do not crash the MCP stream',async()=>{
  const hold=deferred(),c=client({invoke:async()=>{await hold.promise;return{};}});
  try{
    await c.initialize();
    const ids=[];for(let i=0;i<64;i++)ids.push(c.send('tools/call',{name:'reviewops_reviews_list',arguments:{projectId:'A'}}));
    c.input.write('null\n');
    assert.ok(c.responses.some(response=>response.id===null&&response.error?.code===-32600));
    const excess=c.send('tools/call',{name:'reviewops_reviews_list',arguments:{projectId:'A'}});
    assert.equal((await c.read(excess)).error.code,-32000);
    hold.resolve();await c.read(ids.at(-1));assert.deepEqual((await c.read(c.send('ping'))).result,{});
  }finally{hold.resolve();await c.close();}
});

function appConnectionFixture(dataPath){
  return {instanceId:'22222222-2222-4222-8222-222222222222',version:'1.4.0',build:{channel:'stable',version:'1.4.0'},isPackaged:true,platform:process.platform,arch:process.arch,
    dataPath,homePath:path.dirname(dataPath),appPath:path.join(dataPath,'app.asar'),executablePath:path.join(dataPath,'ReviewOps'),dataRootSource:'environment',
    qa:{protocolVersion:1,actions:['open','state','click','type','key','scroll','capture','navigate','reload','close','release'],bindingFields:['sessionId','projectId','windowId'],optionalBrowserId:true,documentGeneration:false}};
}
const selectionFor=(dataPath)=>({selection:'data-path-argument',connectionPath:path.join(dataPath,'integrations','tools.json'),homePath:path.dirname(dataPath),platform:process.platform});

test('connection tool reaches only the exact read-only action from a project-bound client',async()=>{
  const data=path.resolve('/tmp/connection-info'),reported=publicConnectionInfo(appConnectionFixture(data),data),calls=[];
  const c=client({projectId:'A',connectionSelection:selectionFor(data),invoke:async(action,args)=>{calls.push({action,args});return reported;}});
  try{
    await c.initialize();const response=(await c.call('reviewops_connection_info',{})).result;
    assert.equal(response.isError,false);assert.equal(response.structuredContent.client.boundProjectId,'A');assert.equal(response.structuredContent.app.build.commit,null);
    assert.equal(response.structuredContent.client.selection,'data-path-argument');assert.deepEqual(calls,[{action:'connection.info',args:{}}]);
    assert.equal((await c.call('reviewops_connection_info',{projectId:'B'})).result.isError,true);assert.equal(calls.length,1);
    assert.equal((await c.call('reviewops_connection_info',{force:true})).result.isError,true);assert.equal(calls.length,1);
    await c.close();assert.equal(calls.length,1,'Information query must not register or release a QA lease');
  }finally{await c.close();}
});

test('an old app reports unsupported information without fallback, retry or disabling legacy tools',async()=>{
  const calls=[],data=path.resolve('/tmp/connection-info'),c=client({connectionSelection:selectionFor(data),invoke:async(action)=>{calls.push(action);if(action==='connection.info')throw Object.assign(new Error('old server'),{code:'UNKNOWN_ACTION'});return {projects:[]};}});
  try{
    await c.initialize();const response=(await c.call('reviewops_connection_info',{})).result;
    assert.equal(response.isError,true);const detail=JSON.parse(response.content[0].text);assert.equal(detail.code,'CONNECTION_INFO_UNSUPPORTED');assert.doesNotMatch(detail.message,/restart/i);
    assert.deepEqual(calls,['connection.info']);assert.equal((await c.call('reviewops_projects_list',{})).result.isError,false);assert.deepEqual(calls,['connection.info','automation.projects.list']);
  }finally{await c.close();}
});

test('connection selection keeps explicit, environment and default precedence without searching',()=>{
  const env={REVIEWOPS_DATA_DIR:path.resolve('/tmp/environment-root')};
  const direct=options(['--connection','./selected.json'],env),folder=options(['--data-path','./selected'],env),environment=options([],env);
  assert.equal(direct.selection,'connection-argument');assert.equal(direct.connectionPath,path.resolve('selected.json'));
  assert.equal(folder.selection,'data-path-argument');assert.equal(folder.connectionPath,path.resolve('selected/integrations/tools.json'));
  assert.equal(environment.selection,'environment');assert.equal(environment.connectionPath,path.join(env.REVIEWOPS_DATA_DIR,'integrations','tools.json'));
  const fallback=options([],{APPDATA:path.resolve('/tmp/roaming')});assert.equal(fallback.selection,'platform-default');assert.ok(path.isAbsolute(fallback.connectionPath));
  assert.throws(()=>options(['--connection','a','--data-path','b'],env));
});

test('connection information uses the reported server and client path dialects on every host',()=>{
  for(const serverPlatform of ['darwin','win32']){
    const serverPaths=serverPlatform==='win32'?path.win32:path.posix,serverHome=serverPlatform==='win32'?'C:\\Users\\app':'/Users/app',data=serverPaths.join(serverHome,'data');
    const reported=publicConnectionInfo({...appConnectionFixture(data),platform:serverPlatform,homePath:serverHome,appPath:serverPaths.join(serverHome+'-other','ReviewOps.app'),executablePath:serverPaths.join(serverHome,'bin','ReviewOps')},data);
    assert.deepEqual(reported.location,{dataRootSource:'environment',dataPath:'$HOME'+serverPaths.sep+'data',appPath:serverPaths.join(serverHome+'-other','ReviewOps.app'),executablePath:'$HOME'+serverPaths.sep+'bin'+serverPaths.sep+'ReviewOps',homeRedacted:true});
    for(const clientPlatform of ['darwin','win32']){
      const clientPaths=clientPlatform==='win32'?path.win32:path.posix,clientHome=clientPlatform==='win32'?'C:\\Users\\client':'/Users/client';
      const selection={selection:'data-path-argument',connectionPath:clientPaths.join(clientHome,'data','integrations','tools.json'),homePath:clientHome,platform:clientPlatform};
      const result=connectionInfoResult(reported,selection,'A');
      assert.deepEqual(result.location,reported.location);
      assert.deepEqual(result.client,{selection:'data-path-argument',connectionPath:'$HOME'+clientPaths.sep+['data','integrations','tools.json'].join(clientPaths.sep),boundProjectId:'A'});
      assert.equal(connectionInfoResult(reported,{...selection,connectionPath:clientHome}).client.connectionPath,'$HOME');
      const sibling=clientPaths.join(clientHome+'-other','tools.json');
      assert.equal(connectionInfoResult(reported,{...selection,connectionPath:sibling}).client.connectionPath,sibling);
      assert.throws(()=>connectionInfoResult({...reported,location:{...reported.location,dataPath:'relative'}},selection),{code:'INVALID_CONNECTION_INFO'});
      assert.throws(()=>connectionInfoResult(reported,{...selection,connectionPath:'relative'}),{code:'INVALID_CONNECTION_INFO'});
    }
  }
});

test('connection result refuses private extras, fabricated build identity and aggregate UTF-8 overflow',()=>{
  const data=path.resolve('/tmp/connection-info'),selection=selectionFor(data),value=publicConnectionInfo(appConnectionFixture(data),data);
  const first=connectionInfoResult(value,selection);first.qa.actions.length=0;assert.equal(connectionInfoResult(value,selection).qa.actions.length,11);
  const changed=callback=>{const copy=JSON.parse(JSON.stringify(value));callback(copy);return copy;};
  for(const invalid of [changed(v=>{v.token='private';}),changed(v=>{v.app.build.commit='a'.repeat(40);}),changed(v=>{v.app.displayVersion='guessed';}),changed(v=>{v.qa.documentGeneration=true;}),changed(v=>{v.location.appPath='relative';}),changed(v=>{v.location.appPath=path.parse(data).root+'한'.repeat(1400);})])
    assert.throws(()=>connectionInfoResult(invalid,selection),{code:'INVALID_CONNECTION_INFO'});
  assert.throws(()=>connectionInfoResult(value,undefined),{code:'INVALID_CONNECTION_INFO'});
  const long=path.parse(data).root+'x'.repeat(4000),large=changed(v=>{for(const k of ['dataPath','appPath','executablePath'])v.location[k]=long;});
  assert.throws(()=>connectionInfoResult(large,{...selection,connectionPath:long}),{code:'INVALID_CONNECTION_INFO'});
});

test('MCP connection information round-trips through the authenticated owned socket without Store or window calls',async()=>{
  const data=await fs.mkdtemp(path.join(process.platform==='win32'?require('node:os').tmpdir():'/tmp','rops-info-'));let integration,c;const calls=[];
  try{
    integration=await createToolIntegration({dataPath:data,connectionInfo:appConnectionFixture(data),dispatch:()=>{calls.push('dispatch');throw new Error('No Store access');},showReview:()=>{calls.push('show');throw new Error('No window access');},automationHandler:()=>{calls.push('automation');throw new Error('No QA operation');}});
    c=client({projectId:'A',connectionSelection:selectionFor(data),invoke:(action,args)=>invokeSocket(integration.connectionPath,action,args)});
    await c.initialize();const response=(await c.call('reviewops_connection_info',{})).result;
    assert.equal(response.isError,false);assert.equal(response.structuredContent.instanceId,'22222222-2222-4222-8222-222222222222');assert.equal(response.structuredContent.client.boundProjectId,'A');assert.deepEqual(calls,[]);
    const record=JSON.parse(await fs.readFile(integration.connectionPath,'utf8'));assert.deepEqual(Object.keys(record),['version','socketPath','token','pid']);assert.equal(JSON.stringify(response).includes(record.token),false);
  }finally{await c?.close();await integration?.close();await fs.rm(data,{recursive:true,force:true});}
});

test('explicit, environment and present-default routes never read the running-instance registry', async t => {
  const { createConnectionInvoker } = require('../electron/mcp-server.cjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'ro-route-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const route of ['connection-argument', 'data-path-argument', 'environment', 'platform-default']) {
    const file = path.join(root, route, 'integrations', 'tools.json');
    if (route === 'platform-default') { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'invalid'); }
    let reads = 0;
    const invoke = createConnectionInvoker({ selection: route, connectionPath: file }, { directory: () => { reads++; throw new Error('Registry must not be read'); } });
    await assert.rejects(invoke('automation.projects.list', {})); assert.equal(reads, 0, route);
  }
});

async function discoveredFixture(t) {
  const discovery = require('../electron/instance-discovery.cjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'win32' ? require('node:os').tmpdir() : '/tmp', 'ro-disc-')));
  await fs.chmod(root, 0o700);
  const data = path.join(root, 'custom'), registry = path.join(root, 'registry'); await fs.mkdir(data, { mode: 0o700 });
  const calls = [], metadata = appConnectionFixture(data);
  const bridge = await createToolIntegration({ dataPath: data, dispatch: async () => ({}), showReview: async () => ({}), connectionInfo: metadata,
    discoveryDirectory: registry, automationHandler: async (action, payload) => { calls.push({ action, payload }); return { projects: [{ id: 'A' }] }; } });
  const config = { selection: 'platform-default', connectionPath: path.join(root, 'absent', 'integrations', 'tools.json') };
  const selection = { ...selectionFor(data), selection: 'platform-default', connectionPath: config.connectionPath };
  const invoke = require('../electron/mcp-server.cjs').createConnectionInvoker(config, { selection, directory: () => registry });
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, data, registry, calls, bridge, config, selection, invoke, metadata, discovery };
}

test('a single custom app is selected lazily and concurrent first calls share a frozen discovered session', { skip: process.platform === 'win32' }, async t => {
  const f = await discoveredFixture(t);
  const c = client({ invoke: f.invoke, connectionSelection: f.selection }); t.after(() => c.close());
  await c.initialize(); await c.read(c.send('tools/list')); assert.equal(f.calls.length, 0); assert.equal(f.selection.selection, 'platform-default');
  const [first, second] = await Promise.all([c.call('reviewops_projects_list', {}), c.call('reviewops_projects_list', {})]);
  assert.equal(first.result.isError, false); assert.equal(second.result.isError, false); assert.equal(f.calls.length, 2);
  const info = (await c.call('reviewops_connection_info', {})).result.structuredContent;
  assert.equal(info.instanceId, f.metadata.instanceId); assert.equal(info.client.selection, 'running-instance-registry');
  assert.equal(info.location.dataRootSource, 'environment'); assert.equal(f.calls.length, 2, 'No QA or Store mutation is needed to connect');
});

test('a discovered session refuses descriptor or registry replacement instead of adopting new credentials', { skip: process.platform === 'win32' }, async t => {
  for (const target of ['descriptor', 'registry']) {
    const f = await discoveredFixture(t); await f.invoke('automation.projects.list', {});
    const file = target === 'descriptor' ? f.bridge.connectionPath : path.join(f.registry, f.metadata.instanceId + '.json');
    const original = await fs.readFile(file); await fs.unlink(file); await fs.writeFile(file, original, { mode: 0o600 });
    await assert.rejects(f.invoke('automation.projects.list', {}), { code: 'DISCOVERED_INSTANCE_CHANGED' }); assert.equal(f.calls.length, 1);
    await assert.rejects(f.invoke('automation.projects.list', {}), { code: 'DISCOVERED_INSTANCE_CHANGED' }); assert.equal(f.calls.length, 1);
  }
});

test('stale, multiple and mismatched discovered instances perform no requested action', { skip: process.platform === 'win32' }, async t => {
  for (const kind of ['stale', 'multiple', 'mismatch']) {
    const f = await discoveredFixture(t);
    if (kind === 'stale') await fs.unlink(f.bridge.connectionPath);
    if (kind === 'multiple') f.discovery.publishInstance({ directory: f.registry, connectionPath: path.join(f.root, 'other', 'integrations', 'tools.json'), instanceId: '33333333-3333-4333-8333-333333333333' });
    if (kind === 'mismatch') {
      const file = path.join(f.registry, f.metadata.instanceId + '.json'), replacementId = '33333333-3333-4333-8333-333333333333';
      await fs.unlink(file); f.discovery.publishInstance({ directory: f.registry, connectionPath: f.bridge.connectionPath, instanceId: replacementId });
    }
    await assert.rejects(f.invoke('automation.projects.list', {})); assert.deepEqual(f.calls, []);
  }
});

test('selection refuses a second app or a default descriptor appearing during its read-only handshake', { skip: process.platform === 'win32' }, async t => {
  const net = require('node:net'), discovery = require('../electron/instance-discovery.cjs');
  for (const mutation of ['second', 'default']) {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/ro-select-')); await fs.chmod(root, 0o700);
    const data = path.join(root, 'app'), registry = path.join(root, 'registry'), socketPath = path.join(data, 'integrations', 'tools.sock');
    await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    const connectionPath = path.join(path.dirname(socketPath), 'tools.json'), metadata = appConnectionFixture(data), started = deferred(), release = deferred(); let actions = 0;
    const server = net.createServer(socket => { socket.setEncoding('utf8'); socket.on('error', () => {}); socket.once('data', async raw => {
      const request = JSON.parse(raw); if (request.action === 'connection.info') { started.resolve(); await release.promise; socket.end(JSON.stringify({ ok: true, data: publicConnectionInfo(metadata, data) }) + '\n'); }
      else { actions++; socket.end(JSON.stringify({ ok: true, data: {} }) + '\n'); }
    }); });
    await new Promise(resolve => server.listen(socketPath, resolve));
    await fs.writeFile(connectionPath, JSON.stringify({ version: 1, socketPath, token: 'a'.repeat(64), pid: process.pid }), { mode: 0o600 });
    discovery.publishInstance({ directory: registry, connectionPath, instanceId: metadata.instanceId });
    const defaultPath = path.join(root, 'default', 'integrations', 'tools.json');
    const invoke = require('../electron/mcp-server.cjs').createConnectionInvoker({ selection: 'platform-default', connectionPath: defaultPath }, { directory: () => registry });
    const pending = invoke('automation.projects.list', {}); pending.catch(() => {});
    try {
      await started.promise;
      if (mutation === 'second') discovery.publishInstance({ directory: registry, connectionPath, instanceId: '33333333-3333-4333-8333-333333333333' });
      else { await fs.mkdir(path.dirname(defaultPath), { recursive: true }); await fs.writeFile(defaultPath, '{}'); }
      release.resolve(); await assert.rejects(pending); assert.equal(actions, 0);
    } finally { release.resolve(); await pending.catch(() => {}); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
  }
});

test('a fresh stdio MCP process discovers a custom running app with the data-root environment removed', { skip: process.platform === 'win32' }, async t => {
  const discovery = require('../electron/instance-discovery.cjs'), f = await discoveredFixture(t), home = path.join(f.root, 'home');
  await fs.mkdir(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, 'config') };
  delete env.REVIEWOPS_DATA_DIR;
  const publication = discovery.publishInstance({ directory: discovery.registryDirectory({ home, env }), instanceId: f.metadata.instanceId, connectionPath: f.bridge.connectionPath });
  const input = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fresh-B', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reviewops_connection_info', arguments: {} } }];
  const child = spawn(process.execPath, [path.resolve(__dirname, '../electron/mcp-server.cjs')], { env, stdio: ['pipe','pipe','pipe'] });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  try {
    for (const value of input) child.stdin.write(JSON.stringify(value) + '\n');
    for (let i = 0; i < 200 && !stdout.includes('running-instance-registry'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const response = stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.id === 2);
    assert.equal(response.result.structuredContent.instanceId, f.metadata.instanceId); assert.equal(response.result.structuredContent.client.selection, 'running-instance-registry');
    assert.deepEqual(f.calls, []); assert.equal(stderr, ''); child.stdin.end(); assert.deepEqual(await closed, { code: 0, signal: null });
  } finally { if (child.exitCode === null) { child.stdin.end(); await closed; } publication.removeSync(); }
});

test('every successful legacy route still calls its exact descriptor without inspecting the registry', { skip: process.platform === 'win32' }, async t => {
  const f = await discoveredFixture(t);
  for (const route of ['connection-argument', 'data-path-argument', 'environment', 'platform-default']) {
    let reads = 0;
    const invoke = require('../electron/mcp-server.cjs').createConnectionInvoker({ selection: route, connectionPath: f.bridge.connectionPath }, { directory: () => { reads++; throw new Error('Unexpected registry lookup'); } });
    assert.deepEqual(await invoke('automation.projects.list', {}), { projects: [{ id: 'A' }] }); assert.equal(reads, 0, route);
  }
  assert.equal(f.calls.length, 4);
});
