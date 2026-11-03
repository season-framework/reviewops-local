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
    assert.equal(listed.result.tools.length,26);
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
    const canonical=[['mcp-server.cjs','reviewops-mcp.cjs'],['automation-api.cjs','automation-api.cjs'],['review-categories.json','review-categories.json']];
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
