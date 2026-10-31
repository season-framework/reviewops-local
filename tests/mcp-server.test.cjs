'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createToolIntegration}=require('../electron/tool-integration.cjs');
const {createMcpServer,invokeSocket,options}=require('../electron/mcp-server.cjs');

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function client({invoke=async()=>({}),projectId}={}){
  const input=new PassThrough(),output=new PassThrough(),responses=[],waiters=[];
  let buffer='';output.setEncoding('utf8');output.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);responses.push(JSON.parse(line));for(const waiter of waiters.splice(0))waiter();}});
  const server=createMcpServer({input,output,invoke,projectId});let sequence=0;
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
    assert.ok(listed.result.tools.every(t=>!t.action&&t.inputSchema.additionalProperties===false));
    assert.equal((await c.call('not_a_tool',{})).error.code,-32602);
  }finally{await c.close();}
});
test('bound MCP connection filters project discovery and rejects another project before dispatch',async()=>{
  const calls=[],c=client({projectId:'A',invoke:async(action,args)=>{calls.push({action,args});return{projects:[{id:'A'},{id:'B'}]};}});
  try{await c.initialize();assert.deepEqual((await c.call('reviewops_projects_list',{})).result.structuredContent.projects,[{id:'A'}]);
    assert.equal((await c.call('reviewops_reviews_list',{projectId:'B'})).result.isError,true);assert.equal(calls.length,1);
    assert.equal((await c.call('reviewops_review_update',{projectId:'A',reviewId:'r',body:'X',serviceId:'foreign'})).result.isError,true);assert.equal(calls.length,1);
  }finally{await c.close();}
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
