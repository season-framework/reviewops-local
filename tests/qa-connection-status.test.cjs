'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises'),net=require('node:net'),path=require('node:path');
const {createQaAutomation}=require('../electron/qa-automation.cjs');
const {publicConnectionInfo,queryQaConnectionStatus,toolSocketPath}=require('../electron/tool-integration.cjs');
const {createMcpServer,invokeSocket,connectionInfoResult,qaTools}=require('../electron/mcp-server.cjs');

const instanceId='11111111-1111-4111-8111-111111111111';
const only=({sessionId,projectId,windowId})=>({sessionId,projectId,windowId});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fixture(options={}){
  const records=new Map(),commands=[],scope=[];let time=1,opens=0,opening,command;
  const api=createQaAutomation({getProject:id=>['A','B'].includes(id),getWindow:id=>records.get(id),now:()=>time,
    sessionTimeoutMs:10000,onActiveChange:(record,active)=>scope.push([record.id,active]),...options,
    openWindow:async({projectId})=>{
      opens++;if(opening)await opening;
      const contents={isDestroyed:()=>false,debugger:{isAttached:()=>true,sendCommand:async(method,args)=>{commands.push({projectId,method,args});if(command)await command;}},executeJavaScript:async()=>false};
      const record={id:'window-'+projectId+'-'+opens,projectId,draft:'preserve-'+projectId,terminal:{connected:true},host:{webContents:contents,isDestroyed:()=>false}};
      records.set(record.id,record);return record;
    }});
  return{api,records,commands,scope,setTime:value=>time=value,setOpening:value=>opening=value,setCommand:value=>command=value,get opens(){return opens;}};
}
function client(invoke,projectId){
  const input=new PassThrough(),output=new PassThrough(),responses=new Map(),waiters=new Map();let next=0,buffer='';
  output.setEncoding('utf8');output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);responses.set(value.id,value);waiters.get(value.id)?.(value);waiters.delete(value.id);}});
  const server=createMcpServer({input,output,invoke,projectId});
  const request=(method,params={})=>{const id=++next;const result=new Promise(resolve=>waiters.set(id,resolve));input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return responses.has(id)?Promise.resolve(responses.get(id)):result;};
  return{request,initialize:()=>request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'status-unit',version:'1'}}),call:(name,args)=>request('tools/call',{name,arguments:args}),close:()=>server.close()};
}
function connected(f,projectId){
  const calls=[];
  const c=client(async(action,args)=>{calls.push({action,args});if(action==='connection.qa.status')return queryQaConnectionStatus({instanceId},value=>f.api.connectionStatus(value),args);if(action.startsWith('automation.qa.'))return f.api.handle(action,args);throw new Error('Unexpected action');},projectId);
  return{...c,calls};
}
const status=async(c,projectId)=>{const response=await c.call('reviewops_qa_connection_status',{projectId});assert.equal(response.result.isError,false);return response.result.structuredContent;};

test('QA status reads idle B while A draft, terminal, ownership and commands remain unchanged',async()=>{
  const f=fixture();try{
    const a=only(await f.api.handle('open',{projectId:'A',clientId:'a'})),before=JSON.stringify(f.records.get(a.windowId)),scope=f.scope.slice();
    assert.deepEqual(f.api.connectionStatus({projectId:'B'}),{projectId:'B',availability:'available',bindingState:'not_supplied'});
    assert.equal(JSON.stringify(f.records.get(a.windowId)),before);assert.deepEqual(f.scope,scope);assert.equal(f.opens,1);assert.deepEqual(f.commands,[]);
    await assert.rejects(f.api.handle('open',{projectId:'A',clientId:'other'}),{code:'PROJECT_BUSY'});
  }finally{f.api.close();}
});
test('QA status does not renew or prune a matching lease when observing expiry',async()=>{
  const f=fixture({sessionTimeoutMs:100});try{
    const a=only(await f.api.handle('open',{projectId:'A',clientId:'a'}));f.setTime(80);
    assert.equal(f.api.connectionStatus({projectId:'A',binding:a}).bindingState,'attached');f.setTime(102);
    assert.deepEqual(f.api.connectionStatus({projectId:'A',binding:a}),{projectId:'A',availability:'available',bindingState:'expired'});
    assert.equal(f.records.get(a.windowId).qaActive,true);assert.deepEqual(f.scope,[[a.windowId,true]]);
    assert.throws(()=>f.api.handle('type',{...a,text:'expired'}),{code:'SESSION_EXPIRED'});
    assert.equal(f.api.connectionStatus({projectId:'A',binding:a}).bindingState,'unavailable');assert.deepEqual(f.commands,[]);
  }finally{f.api.close();}
});
test('QA status reports a known destroyed window but does not invent closure from a missing record',async()=>{
  const f=fixture();try{
    const a=only(await f.api.handle('open',{projectId:'A',clientId:'a'})),record=f.records.get(a.windowId);
    record.host.isDestroyed=()=>true;assert.equal(f.api.connectionStatus({projectId:'A',binding:a}).bindingState,'target_closed');
    f.records.delete(a.windowId);assert.deepEqual(f.api.connectionStatus({projectId:'A',binding:a}),{projectId:'A',availability:'unavailable',bindingState:'unavailable'});assert.equal(f.opens,1);
  }finally{f.api.close();}
});
test('QA status is immediate during an unfinished open and does not await another project queue',async()=>{
  const f=fixture(),hold=deferred();let opened;
  try{
    f.setOpening(hold.promise);opened=f.api.handle('open',{projectId:'A',clientId:'a'});
    assert.deepEqual(f.api.connectionStatus({projectId:'A'}),{projectId:'A',availability:'busy',bindingState:'not_supplied'});
    assert.equal(f.api.connectionStatus({projectId:'B'}).availability,'available');assert.equal(f.opens,1);assert.equal(f.records.size,0);
  }finally{hold.resolve();if(opened)await opened;f.api.close();}
});
test('QA status preserves timeout quarantine before and after explicit release',async()=>{
  const f=fixture({operationTimeoutMs:10}),hold=deferred();
  try{
    const a=only(await f.api.handle('open',{projectId:'A',clientId:'a'}));f.setCommand(hold.promise);
    await assert.rejects(f.api.handle('type',{...a,text:'pending'}),{code:'QA_TIMEOUT'});
    assert.deepEqual(f.api.connectionStatus({projectId:'A',binding:a}),{projectId:'A',availability:'quarantined',bindingState:'timed_out'});
    assert.equal(f.api.connectionStatus({projectId:'B'}).availability,'available');await f.api.handle('release',a);
    assert.deepEqual(f.api.connectionStatus({projectId:'A',binding:a}),{projectId:'A',availability:'quarantined',bindingState:'unavailable'});
    await assert.rejects(f.api.handle('open',{projectId:'A',clientId:'other'}),{code:'QA_TARGET_UNAVAILABLE'});
  }finally{hold.resolve();f.api.close();}
});
test('QA status cannot infer ownership from a matching client name or an unverified expired lease',async()=>{
  const f=fixture({sessionTimeoutMs:100});try{
    await f.api.handle('open',{projectId:'A',clientId:'same-name'});f.setTime(102);
    assert.deepEqual(f.api.connectionStatus({projectId:'A'}),{projectId:'A',availability:'busy',bindingState:'not_supplied'});
    assert.throws(()=>f.api.connectionStatus({projectId:'A',clientId:'same-name'}),{code:'INVALID_REQUEST'});
  }finally{f.api.close();}
});
test('QA status rejects cross-project binding input and preserves the original eleven capabilities',async()=>{
  const f=fixture();try{
    const a=only(await f.api.handle('open',{projectId:'A',clientId:'a'})),before=JSON.stringify(f.api.capabilities());
    assert.throws(()=>f.api.connectionStatus({projectId:'B',binding:a}),{code:'TARGET_MISMATCH'});
    assert.equal(f.api.connectionStatus({projectId:'missing'}).availability,'unavailable');assert.equal(JSON.stringify(f.api.capabilities()),before);assert.equal(f.api.capabilities().actions.length,11);
  }finally{f.api.close();}
});

test('QA status MCP tool accepts only projectId, injects only its recorded project binding and returns no control IDs',async()=>{
  const f=fixture(),c=connected(f);try{
    await c.initialize();const listed=(await c.request('tools/list')).result.tools,tool=listed.find(value=>value.name==='reviewops_qa_connection_status');
    assert.equal(listed.length,28);assert.deepEqual(tool.inputSchema.required,['projectId']);assert.deepEqual(Object.keys(tool.inputSchema.properties),['projectId']);assert.equal(tool.inputSchema.additionalProperties,false);assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false});
    const opened=(await c.call('reviewops_qa_open',{projectId:'A',clientId:'a'})).result.structuredContent;
    const value=await status(c,'A');assert.equal(value.instanceId,instanceId);assert.equal(value.bindingState,'attached');assert.equal(value.client.bindingSource,'recorded');assert.equal(value.client.scope,'mcp-server');
    assert.deepEqual(c.calls.at(-1),{action:'connection.qa.status',args:{projectId:'A',binding:only(opened)}});
    for(const field of ['sessionId','windowId','clientId','binding']){const count=c.calls.length;const response=await c.call('reviewops_qa_connection_status',{projectId:'A',[field]:field==='binding'?only(opened):'foreign'});assert.equal(response.result.isError,true);assert.equal(c.calls.length,count);}
    const text=JSON.stringify(value);assert.ok(!text.includes(opened.sessionId));assert.ok(!text.includes(opened.windowId));assert.ok(Buffer.byteLength(text)<=2048);
  }finally{await c.close();f.api.close();}
});
test('QA status from a new MCP record sees a foreign project lease as busy without its IDs',async()=>{
  const f=fixture(),c=connected(f);try{
    const foreign=await f.api.handle('open',{projectId:'A',clientId:'same-name'});await c.initialize();const value=await status(c,'A');
    assert.equal(value.availability,'busy');assert.equal(value.bindingState,'not_supplied');assert.equal(value.client.bindingSource,'none');assert.deepEqual(c.calls.at(-1).args,{projectId:'A'});
    assert.ok(!JSON.stringify(value).includes(foreign.sessionId));assert.ok(!JSON.stringify(value).includes(foreign.windowId));
  }finally{await c.close();f.api.close();}
});
test('QA status enforces a project-restricted MCP connection before any app invocation',async()=>{
  const f=fixture(),c=connected(f,'A');try{
    await c.initialize();const response=await c.call('reviewops_qa_connection_status',{projectId:'B'});assert.equal(response.result.isError,true);assert.equal(JSON.parse(response.result.content[0].text).code,'TARGET_MISMATCH');assert.deepEqual(c.calls,[]);
    assert.equal((await status(c,'A')).client.boundProjectId,'A');
  }finally{await c.close();f.api.close();}
});
test('QA status keeps a stale MCP binding unavailable rather than guessing expiry or adopting a replacement',async()=>{
  const f=fixture(),c=connected(f);try{
    await c.initialize();const old=(await c.call('reviewops_qa_open',{projectId:'A',clientId:'a'})).result.structuredContent;
    await f.api.handle('release',old);let value=await status(c,'A');assert.equal(value.availability,'unavailable');assert.equal(value.bindingState,'unavailable');
    const replacement=await f.api.handle('open',{projectId:'A',clientId:'replacement'});value=await status(c,'A');assert.equal(value.availability,'busy');assert.equal(value.bindingState,'unavailable');assert.ok(!JSON.stringify(value).includes(replacement.sessionId));assert.equal(f.opens,2);
  }finally{await c.close();f.api.close();}
});
test('QA status does not select a last or guessed binding when the MCP record is ambiguous',async()=>{
  const f=fixture(),c=connected(f);try{
    await c.initialize();const first=(await c.call('reviewops_qa_open',{projectId:'A',clientId:'a'})).result.structuredContent;
    await f.api.handle('release',first);const second=(await c.call('reviewops_qa_open',{projectId:'A',clientId:'a'})).result.structuredContent,value=await status(c,'A');
    assert.equal(value.client.bindingSource,'ambiguous');assert.equal(value.bindingState,'not_supplied');assert.equal(value.availability,'busy');assert.deepEqual(c.calls.at(-1).args,{projectId:'A'});
    await f.api.handle('release',second);const missing=await status(c,'A');
    assert.equal(missing.client.bindingSource,'ambiguous');assert.equal(missing.bindingState,'not_supplied');assert.equal(missing.availability,'unavailable');assert.deepEqual(c.calls.at(-1).args,{projectId:'A'});
  }finally{await c.close();f.api.close();}
});
test('QA status returns an explicit unsupported result from an older app without retry, open or release',async()=>{
  const calls=[],c=client(async(action,args)=>{calls.push({action,args});throw Object.assign(new Error('unknown'),{code:'UNKNOWN_ACTION'});});
  try{await c.initialize();const response=await c.call('reviewops_qa_connection_status',{projectId:'A'});assert.equal(JSON.parse(response.result.content[0].text).code,'QA_CONNECTION_STATUS_UNSUPPORTED');assert.equal(calls.length,1);assert.equal(calls[0].action,'connection.qa.status');}
  finally{await c.close();}assert.equal(calls.length,1);
});
test('QA status rejects extra app output, wrong targets and inferred ownership without echoing private output',async()=>{
  const base={schema:1,instanceId,projectId:'A',availability:'available',bindingState:'not_supplied'};
  for(const value of [{...base,token:'private-'+('x'.repeat(5000))},{...base,projectId:'B'},{...base,instanceId:'not-an-instance'},{...base,bindingState:'attached'},{...base,availability:'guessed'}]){
    const c=client(async()=>value);try{await c.initialize();const response=await c.call('reviewops_qa_connection_status',{projectId:'A'});const text=response.result.content[0].text;assert.equal(JSON.parse(text).code,'INVALID_QA_CONNECTION_STATUS');assert.ok(!text.includes('private-'));}finally{await c.close();}
  }
});
test('QA status uses startup metadata and an exact output allowlist while preserving connection.info bytes',()=>{
  const data=path.resolve('/tmp/status-metadata'),metadata={instanceId,version:'1.4.0',build:{channel:'stable',version:'1.4.0'},isPackaged:false,platform:process.platform,arch:process.arch,dataPath:data,homePath:path.dirname(data),appPath:data,executablePath:path.join(data,'ReviewOps'),dataRootSource:'environment',qa:{protocolVersion:1,actions:['open','state','click','type','key','scroll','capture','navigate','reload','close','release'],bindingFields:['sessionId','projectId','windowId'],optionalBrowserId:true,documentGeneration:false}};
  const described=publicConnectionInfo(metadata,data),before=JSON.stringify(described),selection={selection:'data-path-argument',connectionPath:path.join(data,'integrations/tools.json'),homePath:path.dirname(data),platform:process.platform};
  const oldDTO=JSON.stringify(connectionInfoResult(described,selection));const output=queryQaConnectionStatus(described,()=>({projectId:'A',availability:'available',bindingState:'not_supplied'}),{projectId:'A'});
  assert.deepEqual(output,{schema:1,instanceId,projectId:'A',availability:'available',bindingState:'not_supplied'});assert.equal(JSON.stringify(described),before);assert.equal(JSON.stringify(connectionInfoResult(described,selection)),oldDTO);assert.equal(qaTools.length,11);
  assert.throws(()=>queryQaConnectionStatus(described,()=>({projectId:'A',availability:'busy',bindingState:'attached',sessionId:'private'}),{projectId:'A'}),{code:'QA_CONNECTION_STATUS_UNAVAILABLE'});
  assert.throws(()=>queryQaConnectionStatus(described,()=>{throw new Error('private detail');},{projectId:'A'}),error=>error.code==='QA_CONNECTION_STATUS_UNAVAILABLE'&&!error.message.includes('private'));
});
test('QA status rejects unsupported startup metadata without invoking a handler',()=>{
  let called=0;assert.throws(()=>queryQaConnectionStatus(undefined,()=>{called++;},{projectId:'A'}),{code:'QA_CONNECTION_STATUS_UNAVAILABLE'});assert.equal(called,0);
});
test('QA status selected custom descriptor failure has no network or data-root fallback',async()=>{
  const originalLstat=fs.lstat,originalConnect=net.createConnection,seen=[];let sockets=0;
  try{
    fs.lstat=async file=>{seen.push(file);throw Object.assign(new Error('missing'),{code:'ENOENT'});};net.createConnection=()=>{sockets++;throw new Error('Network forbidden in this unit');};
    const selected=path.resolve('/tmp/explicit-unknown-reviewops/integrations/tools.json');await assert.rejects(invokeSocket(selected,'connection.qa.status',{projectId:'A'}),{code:'APP_UNAVAILABLE'});assert.deepEqual(seen,[selected]);assert.equal(sockets,0);
  }finally{fs.lstat=originalLstat;net.createConnection=originalConnect;}
});
test('QA status rejects an oversized selected socket response before decoding private output',async()=>{
  const originalLstat=fs.lstat,originalRead=fs.readFile,originalConnect=net.createConnection;let destroyed=false,writes=0;
  try{
    const data=process.platform==='win32'?path.resolve('qa-status-unit-data'):'/tmp/qa-status-unit',selected=path.join(data,'integrations','tools.json'),socket=new EventEmitter();
    fs.lstat=async file=>{assert.equal(file,selected);return{isFile:()=>true,size:200,mode:0o600,uid:process.getuid?.()};};
    fs.readFile=async file=>{assert.equal(file,selected);return JSON.stringify({version:1,socketPath:toolSocketPath(data,process.platform),token:'a'.repeat(64),pid:1});};
    socket.setEncoding=()=>{};socket.setTimeout=()=>{};socket.destroy=()=>{destroyed=true;};socket.write=()=>{writes++;queueMicrotask(()=>socket.emit('data',JSON.stringify({ok:true,data:{private:'x'.repeat(3000)}})+'\n'));};
    net.createConnection=()=>{queueMicrotask(()=>socket.emit('connect'));return socket;};
    await assert.rejects(invokeSocket(selected,'connection.qa.status',{projectId:'A'}),error=>error.code==='RESPONSE_TOO_LARGE'&&!error.message.includes('private'));
    assert.equal(writes,1);assert.equal(destroyed,true);
  }finally{fs.lstat=originalLstat;fs.readFile=originalRead;net.createConnection=originalConnect;}
});
