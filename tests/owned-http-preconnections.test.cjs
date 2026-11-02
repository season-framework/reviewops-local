'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {createProjectServiceRuntime}=require('../electron/project-service-runtime.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,accept,label){for(let i=0;i<200;i++){const value=await read();if(accept(value))return value;await pause(10);}throw new Error('Owned fixture did not reach '+label);}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned fixture cleanup unconfirmed: '+label)),3000);})]);}finally{clearTimeout(timer);}}
const readJSON=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const connectionRecorder=`let connected=0;server.on('connection',socket=>{require('node:fs').writeFileSync('connections.json',JSON.stringify({connected:++connected}));});`;
const plainHTTP=`const http=require('node:http');const server=http.createServer((request,response)=>response.end('ordinary response'));${connectionRecorder}server.listen(0,'127.0.0.1');`;

async function fixture(t,code,{stopTimeoutMs=250,readyFile}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rv-http-preconnection-')),clients=[],cleanups=[],nonce=crypto.randomUUID(),journal=path.join(root,'original-child.jsonl');let child,exit,close;
 const event=(phase,details={})=>syncFs.appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),phase,nonce,...details})+'\n',{mode:0o600});
 // Test-only control exists before startup. It can resume only refused requests
 // captured by the public ServerResponse observer in the owned fixture below.
 const control=`const __reviewopsFixtureFs=require('node:fs'),__reviewopsFixtureRefusedRequests=new Set();process.on('message',message=>{if(message?.rvHttpFixtureCleanup!==${JSON.stringify(nonce)})return;const resumed=__reviewopsFixtureRefusedRequests.size;for(const request of __reviewopsFixtureRefusedRequests)request.resume();__reviewopsFixtureRefusedRequests.clear();__reviewopsFixtureFs.writeFileSync('fixture-cleanup-ack.json',JSON.stringify({nonce:${JSON.stringify(nonce)},resumedRequests:resumed}),{mode:0o600});});\n`;
 await fs.writeFile(path.join(root,'server.cjs'),control+code);
 const manager=createProjectServiceRuntime({resolveBinding:()=>({projectId:'p',connectionId:'c',kind:'local',rootPath:root,signature:'owned fixture'}),stopTimeoutMs,
  spawnChild(...args){child=spawn(...args);event('original-child-retained',{pid:child.pid,executable:args[0],argv:args[1],cwd:args[2].cwd,entry:path.join(root,'server.cjs')});child.once('exit',(code,signal)=>{exit={code,signal};event('original-child-exit',{pid:child.pid,...exit});});child.once('close',(code,signal)=>{close={code,signal};event('original-stdio-close',{pid:child.pid,...close});});return child;}});
 t.after(async()=>{
  for(const cleanup of cleanups)await cleanup();
  if(!exit&&child?.connected){
   event('fixture-cooperative-cleanup-requested',{pid:child.pid});
   child.send({rvHttpFixtureCleanup:nonce},error=>{if(error)event('fixture-control-send-error',{code:error.code});});
   await until(async()=>({ack:await readJSON(path.join(root,'fixture-cleanup-ack.json')),exit}),value=>value.ack?.nonce===nonce||value.exit,'own cooperative cleanup acknowledgment or original exit');
   const ack=await readJSON(path.join(root,'fixture-cleanup-ack.json'));if(ack)event('fixture-cooperative-cleanup-acknowledged',ack);
  }
  for(const client of clients)if(!client.socket.destroyed&&!client.socket.writableEnded)client.socket.end(client.release);
  await bounded(Promise.all(clients.map(client=>client.closed)),'original clients');
  await manager.close();await until(()=>close,Boolean,'original child close');
  assert.deepEqual(exit,{code:0,signal:null});assert.deepEqual(close,{code:0,signal:null});
  t.diagnostic(JSON.stringify({fixture:'private loopback only',pid:child.pid,exit,close,clients:clients.length,signalsSent:0,originalJournal:(await fs.readFile(journal,'utf8')).trim().split('\n').map(JSON.parse)}));
  await fs.rm(root,{recursive:true,force:true});
 });
 await manager.configure('p','c',{executable:process.execPath,entry:'server.cjs',args:[],readinessUrl:'http://127.0.0.1/'});
 const started=(await manager.start('p','c')).instance;
 if(readyFile)await until(()=>readJSON(path.join(root,readyFile)),Boolean,readyFile);
 const state=await until(()=>manager.state('p','c'),value=>value.instance.listeners.length>0,'owned listener');
 const port=state.instance.listeners[0].port;
 const connect=async({release='GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',allowHalfOpen=false,onEnd}={})=>{
  const before=(await readJSON(path.join(root,'connections.json')))?.connected||0;
  const socket=net.createConnection({host:'127.0.0.1',port,allowHalfOpen}),client={socket,release,data:'',ended:false,errors:[]};
  clients.push(client);client.closed=new Promise(resolve=>socket.once('close',resolve));
  socket.on('data',bytes=>{client.data+=bytes.toString();});socket.on('error',error=>client.errors.push(error.code));
  socket.on('end',()=>{client.ended=true;onEnd?.(socket);});
  await new Promise(resolve=>socket.once('connect',resolve));
  await until(()=>readJSON(path.join(root,'connections.json')),value=>value?.connected>before,'actual accepted TCP connection');
  return client;
 };
 return {root,manager,port,started,connect,state:()=>manager.state('p','c'),stop:()=>manager.stop('p','c',started.instanceId),close:()=>close,onCleanup:cleanup=>cleanups.push(cleanup)};
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
 const code=`const fs=require('node:fs'),http=require('node:http');const server=http.createServer((q,r)=>r.end('must not reach entry after drain'));${connectionRecorder}server.on('connection',socket=>socket.once('data',()=>fs.writeFileSync('received.json',JSON.stringify({bytesRead:socket.bytesRead}))));server.listen(0,'127.0.0.1');`;
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
function post(port){return new Promise((resolve,reject)=>{const request=http.request({host:'127.0.0.1',port,method:'POST',path:'/',agent:false},response=>{let body='';response.on('data',bytes=>{body+=bytes;});response.on('end',()=>resolve({status:response.statusCode,body}));});request.on('error',reject);request.end('owned payload');});}

test('accepted POST and later async writes drain while an unrelated empty HTTP connection receives FIN',async t=>{
 const f=await fixture(t,acceptedPost,{stopTimeoutMs:1200}),pending=post(f.port);
 await until(()=>syncFs.existsSync(path.join(f.root,'accepted')),Boolean,'accepted POST');const client=await f.connect();
 const stopping=f.stop();assert.deepEqual(await pending,{status:200,body:'stored'});
 const stopped=await stopping;assert.equal(await fs.readFile(path.join(f.root,'stored'),'utf8'),'complete');
 assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'complete');
 assert.equal(stopped.instance.exit.drainConfirmed,true);await bounded(client.closed,'unused HTTP client');assert.equal(client.data,'');
});

test('a peer attempting its first request after the owned FIN cannot crash accepted-request drain',async t=>{
 const code=acceptedPost.replace("if(request.method!=='POST')","if(request.url==='/late')fs.writeFileSync('unexpected-late-entry','yes');if(request.method!=='POST')").replace("server.listen(0,'127.0.0.1');","server.on('connection',socket=>{const id=connected;socket.once('data',()=>{if(id===2)fs.writeFileSync('late-input.json',JSON.stringify({id,bytesRead:socket.bytesRead}));});});server.listen(0,'127.0.0.1');");
 const f=await fixture(t,code,{stopTimeoutMs:1200}),pending=post(f.port);
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
 const code=acceptedPost.replace("if(request.method!=='POST')","if(request.url==='/late')fs.writeFileSync('unexpected-late-entry','yes');if(request.method!=='POST')").replace("server.listen(0,'127.0.0.1');","server.on('"+protocol+"',(request,socket)=>{fs.writeFileSync('unexpected-protocol-entry','"+protocol+"');socket.end('entry must not write after FIN');});server.on('connection',socket=>{const id=connected;socket.once('data',()=>{if(id===2)fs.writeFileSync('late-protocol-input.json',JSON.stringify({id,bytesRead:socket.bytesRead}));});socket.on('error',error=>fs.writeFileSync('unexpected-socket-error',error.code));});server.listen(0,'127.0.0.1');");
 const f=await fixture(t,code,{stopTimeoutMs:1200}),pending=post(f.port);
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
 const code=`const fs=require('node:fs'),http=require('node:http');const server=http.createServer((q,r)=>r.end('ordinary'));${connectionRecorder}server.listen(0,'127.0.0.1',()=>{const first=server.listenerCount('connection');server.close(()=>server.listen(0,'127.0.0.1',()=>fs.writeFileSync('relisten.json',JSON.stringify({first,second:server.listenerCount('connection')}))));});`;
 const f=await fixture(t,code,{stopTimeoutMs:350,readyFile:'relisten.json'}),counts=await readJSON(path.join(f.root,'relisten.json'));
 assert.equal(counts.first,counts.second);await f.connect();const stopped=await f.stop();assert.equal(stopped.instance.exit.drainConfirmed,true);
});

for(const expectation of ['100-continue','owned-unknown-expectation'])test('a first HTTP Expect '+expectation+' after the owned FIN cannot write or reach the entry',async t=>{
 const code=acceptedPost.replace("if(request.method!=='POST')","if(request.url==='/late')fs.writeFileSync('unexpected-late-entry','yes');if(request.method!=='POST')").replace("server.listen(0,'127.0.0.1');","for(const method of ['writeContinue','writeHead']){const original=http.ServerResponse.prototype[method];http.ServerResponse.prototype[method]=function(...args){if(this.socket?.writableEnded){__reviewopsFixtureRefusedRequests.add(this.req);fs.appendFileSync('late-expect-write-attempts.jsonl',JSON.stringify({method,status:method==='writeHead'?args[0]:100,writableEnded:true})+'\\n');}return Reflect.apply(original,this,args);};}server.on('connection',socket=>{const id=connected;socket.once('data',()=>{if(id===2)fs.writeFileSync('late-expect-input.json',JSON.stringify({id,bytesRead:socket.bytesRead}));});socket.on('error',error=>fs.writeFileSync('late-expect-error.json',JSON.stringify({code:error.code})));});server.listen(0,'127.0.0.1');");
 const f=await fixture(t,code,{stopTimeoutMs:1200}),pending=post(f.port);
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
 const result=new Promise((resolve,reject)=>{request=http.request({host:'127.0.0.1',port:f.port,method:'POST',agent:false,headers:{Expect:expectation,'Content-Length':Buffer.byteLength(body)}},response=>{let data='';response.on('data',bytes=>{data+=bytes;});response.on('end',()=>resolve({status:response.statusCode,body:data}));});request.on('error',reject);request.on('continue',()=>{continued=true;});request.flushHeaders();request.write(body.slice(0,half));});
 f.onCleanup(()=>{if(request&&!request.writableEnded)request.end(body.slice(half));});
 await until(()=>syncFs.existsSync(path.join(f.root,'accepted')),Boolean,'custom accepted Expect POST');
 assert.equal(await fs.readFile(path.join(f.root,'custom-event'),'utf8'),event);
 const stopping=f.stop();await until(()=>syncFs.existsSync(path.join(f.root,'drain-started')),Boolean,'stop after accepted Expect headers');request.end(body.slice(half));
 assert.deepEqual(await result,{status:200,body:'stored'});const stopped=await stopping;
 assert.equal(await fs.readFile(path.join(f.root,'stored-body'),'utf8'),body);assert.equal(await fs.readFile(path.join(f.root,'after-response'),'utf8'),'complete');
 assert.equal(continued,expectation==='100-continue');assert.equal(stopped.instance.exit.drainConfirmed,true);
});

test('default pre-drain Expect behavior still sends 100 and rejects unsupported expectations with 417',async t=>{
 const code=`const fs=require('node:fs'),http=require('node:http');let handled=0;const server=http.createServer(async(request,response)=>{let body='';for await(const chunk of request)body+=chunk;fs.writeFileSync('handled.json',JSON.stringify({count:++handled,body}));response.end('stored');});${connectionRecorder}server.listen(0,'127.0.0.1');`;
 const f=await fixture(t,code,{stopTimeoutMs:350});let continued=false;
 const request=expectation=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:f.port,method:'POST',agent:false,headers:{Expect:expectation,'Content-Length':10}},response=>{let body='';response.on('data',bytes=>{body+=bytes;});response.on('end',()=>resolve({status:response.statusCode,body}));});req.on('error',reject);req.on('continue',()=>{continued=true;});req.end('owned-body');});
 assert.deepEqual(await request('100-continue'),{status:200,body:'stored'});assert.equal(continued,true);
 const rejected=await request('owned-unknown-expectation');assert.equal(rejected.status,417);assert.deepEqual(await readJSON(path.join(f.root,'handled.json')),{count:1,body:'owned-body'});
 assert.equal((await f.stop()).instance.exit.drainConfirmed,true);
});

for(const expectation of ['100-continue','owned-unknown-expectation'])test('a writable partial Expect '+expectation+' request retains the draining 503 policy',async t=>{
 const code=`const fs=require('node:fs'),http=require('node:http');const server=http.createServer((request,response)=>{fs.writeFileSync('unexpected-entry','yes');response.end('unexpected');});${connectionRecorder}server.on('connection',socket=>socket.once('data',()=>fs.writeFileSync('partial.json',JSON.stringify({bytesRead:socket.bytesRead}))));server.listen(0,'127.0.0.1');`;
 const f=await fixture(t,code,{stopTimeoutMs:100}),client=await f.connect({release:'\r\n'});
 client.socket.write('POST /late HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\nExpect: '+expectation+'\r\n');
 await until(()=>readJSON(path.join(f.root,'partial.json')),value=>value?.bytesRead>0,'partial Expect bytes');await assert.rejects(f.stop(),{code:'SERVICE_STOP_UNCONFIRMED'});assert.equal(client.ended,false);
 client.socket.end('\r\n');await bounded(client.closed,'completed partial Expect');assert.match(client.data,/^HTTP\/1\.1 503 /);assert.equal(syncFs.existsSync(path.join(f.root,'unexpected-entry')),false);
 await until(()=>f.state().instance.status,value=>value==='exited','natural exit after Expect503');assert.equal(f.state().instance.exit.drainConfirmed,true);
});
