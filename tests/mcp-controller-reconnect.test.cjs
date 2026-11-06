'use strict';
// Controlled JSON-RPC boundaries only. No Electron, native input or model runs.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PassThrough}=require('node:stream');
const {createMcpServer,qaTools}=require('../electron/mcp-server.cjs');
const {qaControllerSchema,validateQaControllerArguments,createAutomationApi}=require('../electron/automation-api.cjs');
function client(invoke,projectId){
 const input=new PassThrough(),output=new PassThrough(),responses=new Map(),waiters=new Map();let text='',sequence=0;
 output.setEncoding('utf8');output.on('data',chunk=>{text+=chunk;let end;while((end=text.indexOf('\n'))>=0){const reply=JSON.parse(text.slice(0,end));text=text.slice(end+1);responses.set(reply.id,reply);waiters.get(reply.id)?.(reply);waiters.delete(reply.id);}});
 const server=createMcpServer({invoke,projectId,input,output}),request=(method,params={})=>{const id=++sequence,promise=new Promise(resolve=>waiters.set(id,resolve));input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return responses.has(id)?Promise.resolve(responses.get(id)):promise;};
 return{input,server,request,initialize:()=>request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'shared-chat-host',version:'1'}}),call:async args=>(await request('tools/call',{name:'reviewops_qa_controller',arguments:args})).result,close:()=>server.close()};
}
const proof=projectId=>({projectId,appInstanceId:'11111111-1111-4111-8111-111111111111',controllerId:crypto.randomUUID(),controllerProof:crypto.randomBytes(32).toString('base64url')});
const envelope=(args,extra={})=>({contract:'logical-qa-controller-v1',operation:args.operation,projectId:args.projectId,appInstanceId:args.appInstanceId||'11111111-1111-4111-8111-111111111111',controllerId:args.controllerId||crypto.randomUUID(),reviewId:args.reviewId||'',state:'attached',generation:1,expiresAt:'2026-11-07T01:00:00.000Z',sessionId:'session-'+args.projectId,windowId:'window-'+args.projectId,clientId:'controller-'+args.projectId,...(args.operation==='open'?{controllerProof:crypto.randomBytes(32).toString('base64url')}:{}),...(args.operation==='status'?{availability:'busy',bindingState:'attached'}:{}),...extra});
const failureCode=result=>JSON.parse(result.content[0].text).code;
test('the additive controller schema is shared with app dispatch while legacy eleven QA tools remain intact',async()=>{
 const calls=[],c=client(async(action,args)=>{calls.push({action,args});return envelope(args);});
 try{
  await c.initialize();const listed=(await c.request('tools/list')).result.tools,tool=listed.find(item=>item.name==='reviewops_qa_controller');assert.deepEqual(tool.inputSchema,qaControllerSchema);assert.equal(listed.length,29);assert.equal(qaTools.length,11);
  assert.deepEqual(qaTools.map(item=>item.name),['open','state','click','type','key','scroll','capture','reload','close','release','navigate'].map(name=>'reviewops_qa_'+name));
  assert.equal((await c.call({operation:'open',projectId:'A',label:'same label'})).isError,false);assert.equal(calls.length,1);
  const api=createAutomationApi({dispatch(){assert.fail('No data dispatch');},qa:async(action,args)=>{assert.equal(action,'controller');validateQaControllerArguments(args);return{accepted:true};}});
  assert.deepEqual(await api.handle('automation.qa.controller',{operation:'open',projectId:'B'}),{accepted:true});
  for(const args of [{operation:'status',projectId:'A'},{operation:'open',projectId:'A',clientId:'name-is-not-proof'},{operation:'type',...proof('A'),text:'without observation'},{operation:'state',...proof('A'),windowId:'foreign'},{operation:'detach',...proof('A'),browserId:'not-lifecycle'},...['x'.repeat(121),'','   ','Agent\nB','Agent\u007fB'].map(label=>({operation:'open',projectId:'A',label}))]){
   assert.equal((await c.call(args)).isError,true);await assert.rejects(api.handle('automation.qa.controller',args));
  }
  assert.equal(calls.length,1);
 }finally{await c.close();}
});
test('project-bound controller calls reject other projects before invoking the app',async()=>{
 const calls=[],c=client(async(action,args)=>{calls.push({action,args});return envelope(args);},'A');
 try{await c.initialize();const refused=await c.call({operation:'status',...proof('B')});assert.equal(failureCode(refused),'TARGET_MISMATCH');assert.deepEqual(calls,[]);}finally{await c.close();}
});
test('controller result binding, operation and proof shape are confirmed without accepting private extras',async()=>{
 const args={operation:'status',...proof('B')};
 for(const patch of [{projectId:'A'},{controllerId:crypto.randomUUID()},{appInstanceId:crypto.randomUUID()},{operation:'release'},{controllerProof:'x'.repeat(43)},{privateToken:'private'},{generation:0},{expiresAt:'not-a-date'},{availability:'invented'}]){
  const c=client(async()=>envelope(args,patch));try{await c.initialize();assert.equal(failureCode(await c.call(args)),'INVALID_QA_CONTROLLER_RESULT');}finally{await c.close();}
 }
 const c=client(async(_action,args)=>envelope(args,{controllerProof:undefined}));try{await c.initialize();assert.equal(failureCode(await c.call({operation:'open',projectId:'B'})),'INVALID_QA_CONTROLLER_RESULT');}finally{await c.close();}
});
test('unsupported or timed-out controller calls are never retried, substituted or followed by shared cleanup',async()=>{
 for(const code of ['UNKNOWN_ACTION','QA_TIMEOUT','QA_DOCUMENT_CHANGED_AFTER_INPUT']){
  const calls=[],c=client(async(action,args)=>{calls.push({action,args});throw Object.assign(new Error('Controlled refusal; observe rather than replay.'),{code});});
  try{await c.initialize();const result=await c.call({operation:'type',...proof('B'),observationId:crypto.randomUUID(),text:'one input'});assert.equal(failureCode(result),code==='UNKNOWN_ACTION'?'QA_CONTROLLER_UNSUPPORTED':code);assert.equal(calls.length,1);assert.equal(calls[0].action,'automation.qa.controller');}finally{await c.close();}assert.equal(calls.length,1);
 }
});
test('physical EOF releases only legacy sessions and never app-owned logical controllers',async()=>{
 const calls=[],c=client(async(action,args)=>{calls.push({action,args});return action==='automation.qa.controller'?envelope(args):{sessionId:'legacy-session',projectId:'C',windowId:'legacy-window'};});
 await c.initialize();assert.equal((await c.call({operation:'open',projectId:'A'})).isError,false);assert.equal((await c.call({operation:'open',projectId:'B'})).isError,false);await c.request('tools/call',{name:'reviewops_qa_open',arguments:{projectId:'C',clientId:'legacy'}});c.input.end();await c.close();
 assert.deepEqual(calls.filter(row=>row.action==='automation.qa.release'),[{action:'automation.qa.release',args:{sessionId:'legacy-session',projectId:'C',windowId:'legacy-window'}}]);assert.equal(calls.some(row=>row.action==='automation.qa.controller'&&row.args.operation==='release'),false);
});
test('one real QA core behind shared MCP preserves A while only B reconnects, replaces its window and releases',async()=>{
 const {EventEmitter}=require('node:events'),{createQaAutomation}=require('../electron/qa-automation.cjs');let clock=1000,windowSequence=0;
 const projects=new Map(['A','B'].map(id=>[id,{id}])),windows=new Map(),currentWindows=new Map(),trace=[],publicChanges=[];
 function contents(name){const view=new EventEmitter();view.draft='';Object.assign(view,{dead:false,isDestroyed:()=>view.dead,isCrashed:()=>false,isLoadingMainFrame:()=>false,getZoomFactor:()=>1,
  executeJavaScript:async script=>script.includes('width:innerWidth,height:innerHeight')&&!script.includes('document.querySelectorAll')?{width:20,height:10}:{url:'https://fixture.invalid/'+name,title:name,text:view.draft,elements:[],viewport:{width:20,height:10,scrollX:0,scrollY:0}},
  capturePage:async()=>({isEmpty:()=>false,toPNG:()=>{const png=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(20,16);png.writeUInt32BE(10,20);return png;}}),
  debugger:{isAttached:()=>true,sendCommand:async(method,args)=>{trace.push({name,method,args});if(method==='Input.insertText')view.draft+=args.text;}}});return view;}
 function makeWindow(projectId){const id='window-'+projectId+'-'+(++windowSequence),hostContents=contents('host-'+projectId),browserContents=contents('web-'+projectId),browserId='browser-'+id;
  const record={id,projectId,dead:false,ssh:{connected:true,marker:'controlled SSH marker'},host:{isDestroyed:()=>record.dead,webContents:hostContents,focus(){assert.fail('No global window focus');},close(){assert.fail('No project window close');}},browsers:{automationTargets:()=>[{browserId,contents:browserContents,documentReady:true,inputScale:1,url:'https://fixture.invalid/'+projectId,title:projectId,visible:true,bounds:{x:0,y:0,width:20,height:10},clip:null}]},hostContents,browserContents,browserId};windows.set(id,record);currentWindows.set(projectId,record);return record;}
 const api=createQaAutomation({appInstanceId:'11111111-1111-4111-8111-111111111111',now:()=>clock,sessionTimeoutMs:30000,getProject:id=>projects.get(id),getWindow:id=>windows.get(id),openWindow:async({projectId})=>currentWindows.get(projectId)||makeWindow(projectId),
  captureControllerTarget:({projectId})=>{const original=projects.get(projectId);return()=>{if(!original||projects.get(projectId)!==original)throw Object.assign(new Error('Original project changed'),{code:'QA_CONTROLLER_STALE'});};},onControllerChange:(windowId,value)=>publicChanges.push({windowId,value})});
 const invocation=async(action,args)=>{assert.ok(action.startsWith('automation.qa.'));return api.handle(action,args);},c=client(invocation);let next;
 const unwrap=result=>{assert.equal(result.isError,false,result.content?.[0]?.text);return result.structuredContent;},binding=value=>Object.fromEntries(['projectId','appInstanceId','controllerId','controllerProof'].map(key=>[key,value[key]]));
 try{
  await c.initialize();const a=unwrap(await c.call({operation:'open',projectId:'A',label:'same caller label'})),b=unwrap(await c.call({operation:'open',projectId:'B',label:'same caller label'})),aProof=binding(a),bProof=binding(b),aWindow=currentWindows.get('A');
  const aState=unwrap(await c.call({operation:'state',...aProof}));unwrap(await c.call({operation:'type',...aProof,observationId:aState.observationId,text:'A unsaved draft'}));
  const bHost=unwrap(await c.call({operation:'state',...bProof})),browserId=bHost.browsers[0].browserId,bState=unwrap(await c.call({operation:'state',...bProof,browserId}));
  const captured=await c.call({operation:'capture',...aProof});assert.equal(captured.isError,false);assert.equal(captured.content[1].type,'image');assert.equal(captured.structuredContent.data,undefined);
  const beforeA=unwrap(await c.call({operation:'status',...aProof}));clock=1500;unwrap(await c.call({operation:'status',...bProof}));unwrap(await c.call({operation:'detach',...bProof}));unwrap(await c.call({operation:'reconnect',...bProof}));
  const count=trace.length,oldInput=await c.call({operation:'type',...bProof,browserId,observationId:bState.observationId,text:'must not replay'});assert.equal(failureCode(oldInput),'QA_CONTROLLER_OBSERVATION_REQUIRED');assert.equal(trace.length,count);
  const freshB=unwrap(await c.call({operation:'state',...bProof,browserId}));unwrap(await c.call({operation:'type',...bProof,browserId,observationId:freshB.observationId,text:'B only'}));assert.equal(currentWindows.get('B').browserContents.draft,'B only');
  const oldB=currentWindows.get('B');oldB.dead=true;oldB.hostContents.dead=true;oldB.hostContents.emit('destroyed');oldB.browserContents.dead=true;oldB.browserContents.emit('destroyed');windows.delete(oldB.id);currentWindows.delete('B');
  const rebound=unwrap(await c.call({operation:'reconnect',...bProof}));assert.notEqual(rebound.windowId,b.windowId);assert.equal(currentWindows.get('A'),aWindow);assert.deepEqual(unwrap(await c.call({operation:'status',...aProof})),beforeA);assert.equal(aWindow.hostContents.draft,'A unsaved draft');assert.deepEqual(aWindow.ssh,{connected:true,marker:'controlled SSH marker'});
  unwrap(await c.call({operation:'release',...bProof}));assert.deepEqual(unwrap(await c.call({operation:'status',...aProof})),beforeA);c.input.end();await c.close();
  next=client(invocation);await next.initialize();assert.deepEqual(unwrap(await next.call({operation:'status',...aProof})),beforeA);assert.equal(failureCode(await next.call({operation:'open',projectId:'A',label:'same caller label'})),'PROJECT_BUSY');
  assert.equal(failureCode(await next.call({operation:'status',...aProof,controllerProof:b.controllerProof})),'QA_CONTROLLER_PROOF_REFUSED');
  const legacyBinding={sessionId:a.sessionId,projectId:'A',windowId:a.windowId};for(const [name,args]of [['release',legacyBinding],['type',{...legacyBinding,text:'no observation bypass'}],['open',{projectId:'A',clientId:a.clientId}]]){const reply=(await next.request('tools/call',{name:'reviewops_qa_'+name,arguments:args})).result;assert.equal(failureCode(reply),'QA_CONTROLLER_PROOF_REQUIRED');}
  assert.equal(aWindow.hostContents.draft,'A unsaved draft');assert.deepEqual(unwrap(await next.call({operation:'status',...aProof})),beforeA);assert.ok(publicChanges.length>0);assert.equal(JSON.stringify(publicChanges).includes(a.controllerProof),false);assert.equal(JSON.stringify(publicChanges).includes(a.controllerId),false);
  clock=31001;assert.equal(failureCode(await next.call({operation:'status',...aProof})),'QA_CONTROLLER_EXPIRED');
 }finally{await c.close();await next?.close();api.close();}
});
