'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {createProjectServiceRuntime}=require('../electron/project-service-runtime.cjs');
const {publishJSON,canReleaseRawInput}=require('./helpers/owned-http-json.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,accept,label){for(let i=0;i<200;i++){const value=await read();if(accept(value))return value;await pause(10);}throw new Error('Owned fixture did not reach '+label);}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned fixture cleanup unconfirmed: '+label)),3000);})]);}finally{clearTimeout(timer);}}
const readJSON=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const connectionRecorder=`let connected=0;server.on('connection',socket=>{__reviewopsFixturePublish('connections.json',{connected:++connected});});`;
const plainHTTP=`const http=require('node:http');const server=http.createServer((request,response)=>response.end('ordinary response'));${connectionRecorder}server.listen(0,'127.0.0.1');`;

async function fixture(t,code,{stopTimeoutMs=250,readyFile}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rv-http-preconnection-')),clients=[],httpClients=[],httpResults=[],cleanups=[],nonce=crypto.randomUUID(),journal=path.join(root,'original-child.jsonl');let child,exit,close,cleanupInProgress=false,rawReleaseAllowed=false;
 const evidence=path.resolve(__dirname,'../test-results/owned-service-native/http-contract-fixtures',nonce);syncFs.mkdirSync(evidence,{recursive:true,mode:0o700});
 const event=(phase,details={})=>{const line=JSON.stringify({at:new Date().toISOString(),phase,nonce,...details})+'\n';syncFs.appendFileSync(journal,line,{mode:0o600});syncFs.appendFileSync(path.join(evidence,'original-child.jsonl'),line,{mode:0o600});};
 const snapshot=phase=>{const value={phase,nonce,root,cleanupInProgress,rawReleaseAllowed,pid:child?.pid??null,exit:exit??null,close:close??null,clients:clients.map(client=>({id:client.id,deferredOnEnd:Boolean(client.deferredEnd),destroyed:client.socket.destroyed,writableEnded:client.socket.writableEnded,ended:client.ended,errors:client.errors})),httpClients:httpClients.map(row=>({id:row.id,requestClosed:row.requestClosed,responseSeen:Boolean(row.response),responseClosed:row.responseClosed,requestEnded:row.request.writableEnded,error:row.error??null})),completedWrites:Object.fromEntries(['stored','after-response'].map(name=>[name,syncFs.existsSync(path.join(root,name))?syncFs.readFileSync(path.join(root,name),'utf8').slice(0,128):null])),originalJournal:syncFs.readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};publishJSON(path.join(evidence,phase+'.json'),value);return value;};
 // Same original IPC channel as stop. A later control acknowledgment proves
 // the earlier stop message was processed before pending raw input is released.
 const control=`const __reviewopsFixtureFs=require('node:fs'),{publishJSON:__reviewopsFixturePublish}=require(${JSON.stringify(path.join(__dirname,'helpers/owned-http-json.cjs'))}),__reviewopsFixtureRefusedRequests=new Set();process.on('message',message=>{if(message?.rvHttpFixtureCleanup!==${JSON.stringify(nonce)})return;const resumed=__reviewopsFixtureRefusedRequests.size;for(const request of __reviewopsFixtureRefusedRequests)request.resume();__reviewopsFixtureRefusedRequests.clear();__reviewopsFixturePublish('fixture-cleanup-ack.json',{nonce:${JSON.stringify(nonce)},resumedRequests:resumed});});\n`;
 await fs.writeFile(path.join(root,'server.cjs'),control+code);
 const manager=createProjectServiceRuntime({resolveBinding:()=>({projectId:'p',connectionId:'c',kind:'local',rootPath:root,signature:'owned fixture'}),stopTimeoutMs,
  spawnChild(...args){child=spawn(...args);event('original-child-retained',{pid:child.pid,executable:args[0],argv:args[1],cwd:args[2].cwd,entry:path.join(root,'server.cjs')});child.once('exit',(code,signal)=>{exit={code,signal};event('original-child-exit',{pid:child.pid,...exit});});child.once('close',(code,signal)=>{close={code,signal};event('original-stdio-close',{pid:child.pid,...close});});return child;}});
 const httpRequest=(options,onResponse)=>{
  let done;const row={id:httpClients.length+1,requestClosed:false,responseClosed:false,closed:new Promise(resolve=>{done=resolve;})};
  const complete=()=>{if(row.requestClosed&&(!row.response||row.responseClosed))done();};
  row.request=http.request(options,response=>{row.response=response;response.once('close',()=>{row.responseClosed=true;event('original-http-response-close',{clientId:row.id});complete();});response.once('error',error=>{row.error=error.code||error.message;});onResponse(response);});
  httpClients.push(row);event('original-http-client-retained',{clientId:row.id,port:options.port,method:options.method});row.request.once('close',()=>{row.requestClosed=true;event('original-http-request-close',{clientId:row.id});complete();});row.request.once('error',error=>{row.error=error.code||error.message;});return row.request;
 };
 const trackHttpResult=promise=>{httpResults.push(promise.then(value=>{event('original-http-result',{status:value?.status??null,body:typeof value?.body==='string'?value.body.slice(0,128):null});return {ok:true};},error=>{event('original-http-result-error',{code:error.code||null,message:error.message});return {ok:false,error};}));return promise;};
 t.after(async()=>{
  cleanupInProgress=true;event('fixture-cleanup-begin',{pid:child?.pid??null});const initial=snapshot('before-cleanup');t.diagnostic(JSON.stringify({fixtureLifecycle:'before-cleanup',...initial}));
  const errors=[],attempt=async(label,operation)=>{try{return await operation();}catch(error){errors.push(error);event('fixture-cleanup-error',{label,code:error.code||null,message:error.message});}};
  // Start close before awaiting bodies/responses: a fixture may respond only
  // after its shutdown hook runs. Keep the original deadline and child handle.
  event('original-manager-close-requested');const stopping=manager.close().then(()=>event('original-manager-close-complete'),error=>{errors.push(error);event('fixture-cleanup-error',{label:'original manager close',code:error.code||null,message:error.message});});
  try{
   await attempt('registered request completion',async()=>{for(const cleanup of cleanups)await cleanup();});
   let controlState;
   if(!exit&&child?.connected){
    event('fixture-cooperative-cleanup-requested',{pid:child.pid});
    try{child.send({rvHttpFixtureCleanup:nonce},error=>{if(error)event('fixture-control-send-error',{code:error.code});});}catch(error){event('fixture-control-send-error',{code:error.code});}
    controlState=await attempt('control acknowledgment or original exit',()=>until(async()=>({ack:await readJSON(path.join(root,'fixture-cleanup-ack.json')),exit}),value=>value.ack?.nonce===nonce||value.exit,'own cooperative cleanup acknowledgment or original exit'));
    if(controlState?.ack?.nonce===nonce)event('fixture-cooperative-cleanup-acknowledged',controlState.ack);
   }
   rawReleaseAllowed=canReleaseRawInput(nonce,controlState,exit);
   if(rawReleaseAllowed){
    event('fixture-raw-release-authorized',{basis:exit?'original-exit':'own-control-ack'});
    await attempt('original raw release',async()=>{for(const client of clients){if(client.deferredEnd){const callback=client.deferredEnd;client.deferredEnd=null;event('fixture-deferred-onEnd-released',{clientId:client.id});callback(client.socket);}if(!client.socket.destroyed&&!client.socket.writableEnded){event('fixture-raw-input-released',{clientId:client.id});client.socket.end(client.release);}}});
   }else{
    const error=new Error('Owned raw input held: no matching control acknowledgment or original exit');errors.push(error);event('fixture-raw-release-held',{message:error.message});
   }
   await Promise.all([
    attempt('original raw clients',()=>bounded(Promise.all(clients.map(client=>client.closed)),'original raw clients')),
    attempt('original HTTP clients',()=>bounded(Promise.all(httpClients.map(row=>row.closed)),'original HTTP request/response close')),
    attempt('original HTTP results',async()=>{for(const result of await bounded(Promise.all(httpResults),'original HTTP results'))if(!result.ok)throw result.error;})
   ]);
  }finally{
   await stopping;await attempt('original child close',()=>until(()=>close,Boolean,'original child close'));
   event('fixture-cleanup-end',{exit:exit??null,close:close??null,cleanupErrors:errors.length});const final=snapshot('after-cleanup');
   t.diagnostic(JSON.stringify({fixture:'private loopback only',pid:child?.pid??null,exit:exit??null,close:close??null,clients:clients.length,httpClients:httpClients.length,signalsSent:0,cleanupErrors:errors.length,evidence,originalJournal:final.originalJournal}));
   if(!errors.length&&exit?.code===0&&exit.signal===null&&close?.code===0&&close.signal===null)await fs.rm(root,{recursive:true,force:true});
  }
  if(errors.length)throw new AggregateError(errors,'Owned fixture cleanup remains failed; original evidence retained.');
  assert.deepEqual(exit,{code:0,signal:null});assert.deepEqual(close,{code:0,signal:null});
 });
 await manager.configure('p','c',{executable:process.execPath,entry:'server.cjs',args:[],readinessUrl:'http://127.0.0.1/'});
 const started=(await manager.start('p','c')).instance;
 if(readyFile)await until(()=>readJSON(path.join(root,readyFile)),Boolean,readyFile);
 const state=await until(()=>manager.state('p','c'),value=>value.instance.listeners.length>0,'owned listener');
 const port=state.instance.listeners[0].port;
 const connect=async({release='GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',allowHalfOpen=false,onEnd}={})=>{
  const before=(await readJSON(path.join(root,'connections.json')))?.connected||0;
  const socket=net.createConnection({host:'127.0.0.1',port,allowHalfOpen}),client={id:clients.length+1,socket,release,data:'',ended:false,errors:[]};
  clients.push(client);event('original-raw-client-retained',{clientId:client.id,port,allowHalfOpen});client.closed=new Promise(resolve=>socket.once('close',()=>{event('original-raw-client-close',{clientId:client.id});resolve();}));
  socket.on('data',bytes=>{client.data+=bytes.toString();});socket.on('error',error=>client.errors.push(error.code));
  socket.on('end',()=>{client.ended=true;if(cleanupInProgress&&!rawReleaseAllowed){client.deferredEnd=onEnd;event('fixture-raw-onEnd-deferred',{clientId:client.id});}else onEnd?.(socket);});
  await new Promise(resolve=>socket.once('connect',resolve));
  await until(()=>readJSON(path.join(root,'connections.json')),value=>value?.connected>before,'actual accepted TCP connection');
  return client;
 };
 return {root,manager,port,started,httpRequest,trackHttpResult,connect,state:()=>manager.state('p','c'),stop:()=>manager.stop('p','c',started.instanceId),close:()=>close,onCleanup:cleanup=>cleanups.push(cleanup)};
}

test('plain HTTP zero-byte half-open peer drains without waiting for its FIN',async t=>{
 const f=await fixture(t,plainHTTP,{stopTimeoutMs:350}),client=await f.connect({allowHalfOpen:true,release:null});
 assert.equal(client.socket.bytesWritten,0);
 const outcome=await f.stop().then(value=>({value}),error=>({error:error.code}));
 assert.equal(outcome.error,undefined,'An unused HTTP preconnection must not leave shutdown unconfirmed');
 assert.equal(outcome.value.instance.status,'exited');assert.equal(outcome.value.instance.exit.drainConfirmed,true);
 await until(()=>client.ended,Boolean,'server FIN while peer stays half-open');assert.equal(client.socket.writableEnded,false,'The peer has sent no FIN when original child exit is confirmed');assert.equal(client.socket.bytesWritten,0);assert.equal(client.data,'');t.diagnostic(JSON.stringify({halfOpenPeer:true,peerFINSentBeforeChildExit:false,peerBytesWritten:client.socket.bytesWritten,serverFINObserved:client.ended}));
});

test('partial HTTP headers remain open until the original draining request policy can refuse them',async t=>{
 const code=`const fs=require('node:fs'),http=require('node:http');const server=http.createServer((q,r)=>r.end('must not reach entry after drain'));${connectionRecorder}server.on('connection',socket=>socket.once('data',()=>__reviewopsFixturePublish('received.json',{bytesRead:socket.bytesRead})));server.listen(0,'127.0.0.1');`;
 const f=await fixture(t,code,{stopTimeoutMs:100}),client=await f.connect({release:'\r\n'});
 client.socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n');
 await until(()=>readJSON(path.join(f.root,'received.json')),value=>value?.bytesRead>0,'partial header bytes received');
 await assert.rejects(f.stop(),{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(client.ended,false);
 client.socket.end('\r\n');await bounded(client.closed,'completed partial request');assert.match(client.data,/^HTTP\/1\.1 503 /);
 await until(()=>f.state().instance.status,value=>value==='exited','natural exit after refused request');
 assert.equal(f.state().instance.exit.drainConfirmed,true);
});

const acceptedPost=`const fs=require('node:fs'),fsp=fs.promises,http=require('node:http');const writes=new Set();
const server=http.createServer((request,response)=>{if(request.method!=='POST'){response.end('ordinary');return;}fs.writeFileSync('accepted','yes');const work=(async()=>{await new Promise(r=>setTimeout(r,160));await fsp.writeFile('stored','complete');response.end('stored');await new Promise(r=>setTimeout(r,70));await fsp.writeFile('after-response','complete');})();writes.add(work);work.then(()=>writes.delete(work),()=>writes.delete(work));});${connectionRecorder}
exports.reviewopsShutdown=()=>Promise.all([...writes]);server.listen(0,'127.0.0.1');`;
function post(f){return f.trackHttpResult(new Promise((resolve,reject)=>{const request=f.httpRequest({host:'127.0.0.1',port:f.port,method:'POST',path:'/',agent:false},response=>{let body='';response.on('data',bytes=>{body+=bytes;});response.on('end',()=>resolve({status:response.statusCode,body}));});request.on('error',reject);request.end('owned payload');}));}

test('accepted POST and later async writes drain while an unrelated empty HTTP connection receives FIN',async t=>{
 const f=await fixture(t,acceptedPost,{stopTimeoutMs:1200}),pending=post(f);
 await until(()=>syncFs.existsSync(path.join(f.root,'accepted')),Boolean,'accepted POST');const client=await f.connect();
 const stopping=f.stop();assert.deepEqual(await pending,{status:200,body:'stored'});
 const stopped=await stopping;assert.equal(await fs.readFile(path.join(f.root,'stored'),'utf8'),'complete');
 assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'complete');
 assert.equal(stopped.instance.exit.drainConfirmed,true);await bounded(client.closed,'unused HTTP client');assert.equal(client.data,'');
});

test('a peer attempting its first request after the owned FIN cannot crash accepted-request drain',async t=>{
 const code=acceptedPost.replace("if(request.method!=='POST')","if(request.url==='/late')fs.writeFileSync('unexpected-late-entry','yes');if(request.method!=='POST')").replace("server.listen(0,'127.0.0.1');","server.on('connection',socket=>{const id=connected;socket.once('data',()=>{if(id===2)__reviewopsFixturePublish('late-input.json',{id,bytesRead:socket.bytesRead});});});server.listen(0,'127.0.0.1');");
 const f=await fixture(t,code,{stopTimeoutMs:1200}),pending=post(f);
 await until(()=>syncFs.existsSync(path.join(f.root,'accepted')),Boolean,'accepted POST');
 let sent=false;const body='x'.repeat(128*1024),lateRequest='POST /late HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: '+body.length+'\r\n\r\n'+body;
 const client=await f.connect({allowHalfOpen:true,release:lateRequest,onEnd:socket=>{if(!socket.writableEnded){sent=true;socket.end(lateRequest);}}});
 const stopping=f.stop();assert.deepEqual(await pending,{status:200,body:'stored'});const stopped=await stopping;
 assert.equal(sent,true);assert.equal(client.data,'');await bounded(client.closed,'raced first request peer');
 assert.equal(stopped.instance.exit.code,0);assert.equal(stopped.instance.exit.drainConfirmed,true);
 assert.equal(syncFs.existsSync(path.join(f.root,'unexpected-late-entry')),false);t.diagnostic(JSON.stringify({lateInputReachedServer:(await readJSON(path.join(f.root,'late-input.json')))?.bytesRead>0,clientErrors:client.errors,unacceptedInputMayMeetClosedTransport:true}));assert.ok(client.errors.every(code=>['EPIPE','ECONNRESET'].includes(code)));
 assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'complete');
});

for(const protocol of ['upgrade','connect'])test('a first HTTP '+protocol+' after the owned FIN is refused while an accepted POST drains',async t=>{
 const code=acceptedPost.replace("if(request.method!=='POST')","if(request.url==='/late')fs.writeFileSync('unexpected-late-entry','yes');if(request.method!=='POST')").replace("server.listen(0,'127.0.0.1');","server.on('"+protocol+"',(request,socket)=>{fs.writeFileSync('unexpected-protocol-entry','"+protocol+"');socket.end('entry must not write after FIN');});server.on('connection',socket=>{const id=connected;socket.once('data',()=>{if(id===2)__reviewopsFixturePublish('late-protocol-input.json',{id,bytesRead:socket.bytesRead});});socket.on('error',error=>fs.writeFileSync('unexpected-socket-error',error.code));});server.listen(0,'127.0.0.1');");
 const f=await fixture(t,code,{stopTimeoutMs:1200}),pending=post(f);
 await until(()=>syncFs.existsSync(path.join(f.root,'accepted')),Boolean,'accepted POST');
 const headers=protocol==='upgrade'?'GET /late HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: owned-fixture\r\n\r\n':'CONNECT owned-fixture:80 HTTP/1.1\r\nHost: owned-fixture:80\r\n\r\n';
 const lateInput=headers+'x'.repeat(128*1024);let sent=false;
 const client=await f.connect({allowHalfOpen:true,release:lateInput,onEnd:socket=>{if(!socket.writableEnded){sent=true;socket.end(lateInput);}}});
 const stopping=f.stop();assert.deepEqual(await pending,{status:200,body:'stored'});const stopped=await stopping;
 assert.equal(sent,true);assert.equal(client.data,'');await bounded(client.closed,'raced '+protocol+' peer');
 assert.equal(syncFs.existsSync(path.join(f.root,'unexpected-protocol-entry')),false);assert.equal(syncFs.existsSync(path.join(f.root,'unexpected-late-entry')),false);assert.equal(syncFs.existsSync(path.join(f.root,'unexpected-socket-error')),false);
 t.diagnostic(JSON.stringify({protocol,lateInputReachedServer:(await readJSON(path.join(f.root,'late-protocol-input.json')))?.bytesRead>0,clientErrors:client.errors,unacceptedInputMayMeetClosedTransport:true}));assert.ok(client.errors.every(code=>['EPIPE','ECONNRESET'].includes(code)));
 assert.equal(stopped.instance.exit.code,0);assert.equal(stopped.instance.exit.drainConfirmed,true);
 assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'complete');
});

test('a raw net server preconnection is preserved until its own peer ends',async t=>{
 const f=await fixture(t,`const net=require('node:net');const server=net.createServer(socket=>socket.resume());${connectionRecorder}server.listen(0,'127.0.0.1');`,{stopTimeoutMs:100});
 const client=await f.connect({release:null});await assert.rejects(f.stop(),{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(client.ended,false);
 client.socket.end();await bounded(client.closed,'raw net peer end');await until(()=>f.state().instance.status,value=>value==='exited','raw net natural exit');
});

test('a TLS listener awaiting a handshake is preserved until its own peer ends',async t=>{
 const f=await fixture(t,`const tls=require('node:tls');const server=tls.createServer();server.on('tlsClientError',()=>{});${connectionRecorder}server.listen(0,'127.0.0.1');`,{stopTimeoutMs:100});
 const client=await f.connect({release:null});await assert.rejects(f.stop(),{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(client.ended,false);
 client.socket.end();await bounded(client.closed,'TLS pending peer end');await until(()=>f.state().instance.status,value=>value==='exited','TLS listener natural exit');
});

test('re-listening on the same HTTP server does not duplicate preconnection observers',async t=>{
 const code=`const fs=require('node:fs'),http=require('node:http');const server=http.createServer((q,r)=>r.end('ordinary'));${connectionRecorder}server.listen(0,'127.0.0.1',()=>{const first=server.listenerCount('connection');server.close(()=>server.listen(0,'127.0.0.1',()=>__reviewopsFixturePublish('relisten.json',{first,second:server.listenerCount('connection')})));});`;
 const f=await fixture(t,code,{stopTimeoutMs:350,readyFile:'relisten.json'}),counts=await readJSON(path.join(f.root,'relisten.json'));
 assert.equal(counts.first,counts.second);await f.connect();const stopped=await f.stop();assert.equal(stopped.instance.exit.drainConfirmed,true);
});

for(const expectation of ['100-continue','owned-unknown-expectation'])test('a first HTTP Expect '+expectation+' after the owned FIN cannot write or reach the entry',async t=>{
 const code=acceptedPost.replace("if(request.method!=='POST')","if(request.url==='/late')fs.writeFileSync('unexpected-late-entry','yes');if(request.method!=='POST')").replace("server.listen(0,'127.0.0.1');","for(const method of ['writeContinue','writeHead']){const original=http.ServerResponse.prototype[method];http.ServerResponse.prototype[method]=function(...args){if(this.socket?.writableEnded){__reviewopsFixtureRefusedRequests.add(this.req);fs.appendFileSync('late-expect-write-attempts.jsonl',JSON.stringify({method,status:method==='writeHead'?args[0]:100,writableEnded:true})+'\\n');}return Reflect.apply(original,this,args);};}server.on('connection',socket=>{const id=connected;socket.once('data',()=>{if(id===2)__reviewopsFixturePublish('late-expect-input.json',{id,bytesRead:socket.bytesRead});});socket.on('error',error=>__reviewopsFixturePublish('late-expect-error.json',{code:error.code}));});server.listen(0,'127.0.0.1');");
 const f=await fixture(t,code,{stopTimeoutMs:1200}),pending=post(f);
 await until(()=>syncFs.existsSync(path.join(f.root,'accepted')),Boolean,'accepted POST');
 const body='x'.repeat(128*1024),lateInput='POST /late HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nExpect: '+expectation+'\r\nContent-Length: '+body.length+'\r\n\r\n'+body;let sent=false;
 const client=await f.connect({allowHalfOpen:true,release:lateInput,onEnd:socket=>{if(!socket.writableEnded){sent=true;socket.end(lateInput);}}});
 const stopping=f.stop().then(value=>({value}),error=>({error:error.code}));assert.deepEqual(await pending,{status:200,body:'stored'});const outcome=await stopping;
 const error=await readJSON(path.join(f.root,'late-expect-error.json'));
 const attempts=syncFs.existsSync(path.join(f.root,'late-expect-write-attempts.jsonl'))?(await fs.readFile(path.join(f.root,'late-expect-write-attempts.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):[];
 t.diagnostic(JSON.stringify({expectation,observedWriteAttempts:attempts,observedSocketError:error,stopOutcome:outcome.error||outcome.value.instance.exit,lateInputReceived:(await readJSON(path.join(f.root,'late-expect-input.json')))?.bytesRead>0}));
 assert.equal(outcome.error,undefined,'A refused Expect request must not leave shutdown unconfirmed');await bounded(client.closed,'raced Expect peer');
 assert.equal(sent,true);assert.equal(client.data,'');assert.equal(error,null);assert.deepEqual(attempts,[],'Node must not automatically write 100/417 after the owned FIN');
 assert.equal(syncFs.existsSync(path.join(f.root,'unexpected-late-entry')),false);assert.ok(client.errors.every(code=>['EPIPE','ECONNRESET'].includes(code)));
 assert.equal(outcome.value.instance.exit.drainConfirmed,true);assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'complete');
});

for(const expectation of ['100-continue','owned-unknown-expectation'])test('an accepted custom '+expectation+' POST keeps its full body and asynchronous writes during drain',async t=>{
 const event=expectation==='100-continue'?'checkContinue':'checkExpectation';
 const code=`const fs=require('node:fs'),fsp=fs.promises,http=require('node:http'),writes=new Set();
 const handle=(request,response)=>{fs.writeFileSync('accepted','yes');const work=(async()=>{let body='';for await(const chunk of request)body+=chunk;await fsp.writeFile('stored-body',body);response.end('stored');await new Promise(r=>setTimeout(r,70));await fsp.writeFile('after-response','complete');})();writes.add(work);work.then(()=>writes.delete(work),()=>writes.delete(work));};
 const server=http.createServer(handle);server.on('${event}',(request,response)=>{fs.writeFileSync('custom-event','${event}');${expectation==='100-continue'?'response.writeContinue();':''}handle(request,response);});${connectionRecorder}
 exports.reviewopsShutdown=()=>{fs.writeFileSync('drain-started','yes');return Promise.all([...writes]);};server.listen(0,'127.0.0.1');`;
 const f=await fixture(t,code,{stopTimeoutMs:1200}),body='owned-request-body-'.repeat(8192),half=Math.floor(body.length/2);let continued=false,request;
 const result=f.trackHttpResult(new Promise((resolve,reject)=>{request=f.httpRequest({host:'127.0.0.1',port:f.port,method:'POST',agent:false,headers:{Expect:expectation,'Content-Length':Buffer.byteLength(body)}},response=>{let data='';response.on('data',bytes=>{data+=bytes;});response.on('end',()=>resolve({status:response.statusCode,body:data}));});request.on('error',reject);request.on('continue',()=>{continued=true;});request.flushHeaders();request.write(body.slice(0,half));}));
 f.onCleanup(()=>{if(request&&!request.writableEnded)request.end(body.slice(half));});
 await until(()=>syncFs.existsSync(path.join(f.root,'accepted')),Boolean,'custom accepted Expect POST');
 assert.equal(await fs.readFile(path.join(f.root,'custom-event'),'utf8'),event);
 const stopping=f.stop();await until(()=>syncFs.existsSync(path.join(f.root,'drain-started')),Boolean,'stop after accepted Expect headers');request.end(body.slice(half));
 assert.deepEqual(await result,{status:200,body:'stored'});const stopped=await stopping;
 assert.equal(await fs.readFile(path.join(f.root,'stored-body'),'utf8'),body);assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'complete');
 assert.equal(continued,expectation==='100-continue');assert.equal(stopped.instance.exit.drainConfirmed,true);
});

test('default pre-drain Expect behavior still sends 100 and rejects unsupported expectations with 417',async t=>{
 const code=`const fs=require('node:fs'),http=require('node:http');let handled=0;const server=http.createServer(async(request,response)=>{let body='';for await(const chunk of request)body+=chunk;__reviewopsFixturePublish('handled.json',{count:++handled,body});response.end('stored');});${connectionRecorder}server.listen(0,'127.0.0.1');`;
 const f=await fixture(t,code,{stopTimeoutMs:350});let continued=false;
 const request=expectation=>f.trackHttpResult(new Promise((resolve,reject)=>{const req=f.httpRequest({host:'127.0.0.1',port:f.port,method:'POST',agent:false,headers:{Expect:expectation,'Content-Length':10}},response=>{let body='';response.on('data',bytes=>{body+=bytes;});response.on('end',()=>resolve({status:response.statusCode,body}));});req.on('error',reject);req.on('continue',()=>{continued=true;});req.end('owned-body');}));
 assert.deepEqual(await request('100-continue'),{status:200,body:'stored'});assert.equal(continued,true);
 const rejected=await request('owned-unknown-expectation');assert.equal(rejected.status,417);assert.deepEqual(await readJSON(path.join(f.root,'handled.json')),{count:1,body:'owned-body'});
 assert.equal((await f.stop()).instance.exit.drainConfirmed,true);
});

for(const expectation of ['100-continue','owned-unknown-expectation'])test('a writable partial Expect '+expectation+' request retains the draining 503 policy',async t=>{
 const code=`const fs=require('node:fs'),http=require('node:http');const server=http.createServer((request,response)=>{fs.writeFileSync('unexpected-entry','yes');response.end('unexpected');});${connectionRecorder}server.on('connection',socket=>socket.once('data',()=>__reviewopsFixturePublish('partial.json',{bytesRead:socket.bytesRead})));server.listen(0,'127.0.0.1');`;
 const f=await fixture(t,code,{stopTimeoutMs:100}),client=await f.connect({release:'\r\n'});
 client.socket.write('POST /late HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\nExpect: '+expectation+'\r\n');
 await until(()=>readJSON(path.join(f.root,'partial.json')),value=>value?.bytesRead>0,'partial Expect bytes');await assert.rejects(f.stop(),{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(client.ended,false);
 client.socket.end('\r\n');await bounded(client.closed,'completed partial Expect');assert.match(client.data,/^HTTP\/1\.1 503 /);assert.equal(syncFs.existsSync(path.join(f.root,'unexpected-entry')),false);
 await until(()=>f.state().instance.status,value=>value==='exited','natural exit after Expect503');assert.equal(f.state().instance.exit.drainConfirmed,true);
});
