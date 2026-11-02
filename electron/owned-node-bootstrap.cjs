'use strict';
// Private child IPC only. This launcher supports one in-process CommonJS server;
// it deliberately does not supervise arbitrary descendants or expose an HTTP token.
const exit=process.exit.bind(process),send=process.send?.bind(process);
const originalArgv=[...process.argv],net=require('node:net'),http=require('node:http'),Module=require('node:module');
let initialized=false,token='',instanceId='',entryExports,draining=false,drainReady=false,keepAlive;
const servers=new Set(),closeMethods=new WeakMap(),httpPreconnections=new WeakMap(),address=net.Server.prototype.address;
const describeError=error=>{try{return String(error?.message??error).slice(0,1000);}catch{return 'Unknown service cleanup failure.';}};
const report=value=>{try{send?.({protocol:'reviewops-owned-node-v1',token,instanceId,...value},()=>{});}catch{}};
const listeners=()=>{
 const values=[];
 for(const server of servers){let item;try{item=address.call(server);}catch{}if(item&&typeof item==='object')values.push({address:item.address,family:item.family,port:item.port});}
 report({type:'listeners',listeners:values.slice(0,32)});
};
const listen=net.Server.prototype.listen;
const close=net.Server.prototype.close;
function endEmptyHttpConnection(state,socket){
 // A TCP connection is not an accepted HTTP request. End only an untouched
 // plain-HTTP preconnection; never end partial headers or an active response.
 if(!state.pending.has(socket)||socket.encrypted===true||socket.destroyed||socket.writableEnded||socket.bytesRead!==0||socket.bytesWritten!==0||socket.readableLength!==0)return;
 state.finSent.add(socket);
 try{socket.end();}catch(error){state.finSent.delete(socket);throw error;}
}
function trackHttpPreconnections(server){
 if(httpPreconnections.has(server))return httpPreconnections.get(server);
 // Do not infer HTTP behavior from a generic net/TLS server or a subclass.
 if(Object.getPrototypeOf(server)!==http.Server.prototype)return null;
 const state={pending:new Set(),finSent:new WeakSet()};httpPreconnections.set(server,state);
 server.on('connection',socket=>{
  if(socket.encrypted===true)return;
  state.pending.add(socket);socket.once('close',()=>state.pending.delete(socket));
  if(draining)try{endEmptyHttpConnection(state,socket);}catch(error){report({type:'drain-error',message:describeError(error)});}
 });
 server.on('close',()=>state.pending.clear());
 return state;
}
net.Server.prototype.listen=function(...args){
 if(draining)throw Object.assign(new Error('The owned service is shutting down.'),{code:'SERVICE_STOPPING'});
 if(!servers.has(this)){
  servers.add(this);closeMethods.set(this,this.close);this.on('listening',listeners);this.on('close',()=>{servers.delete(this);listeners()});
  // HTTP close handles currently idle keep-alive sockets. A request active at
  // close can become idle later, so close only those idle sockets after finish.
  // Never use closeAllConnections or destroy an accepted request's socket.
  if(typeof this.closeIdleConnections==='function'){
   const emit=this.emit,closeIdle=this.closeIdleConnections,server=this,preconnections=trackHttpPreconnections(this);
   this.emit=function(event,...values){
    if(event==='upgrade'||event==='connect'){
     const socket=values[1];preconnections?.pending.delete(socket);
     // The HTTP parser detaches for these protocols. Only an already-FINned
     // preconnection is refused here; previously accepted handlers stay intact.
     if(draining&&preconnections?.finSent.has(socket)){socket.resume();return true;}
    }
    if(event==='request'||preconnections&&(event==='checkContinue'||event==='checkExpectation')){
     const request=values[0],response=values[1];preconnections?.pending.delete(request.socket);
     if(draining){
      // Its peer can send a first request after our FIN was queued. That new
      // request was never accepted by the entry and has no writable response.
      // Read only that refused input so the peer can finish without a forced close.
      if(preconnections?.finSent.has(request.socket)){request.resume();return true;}
      response.statusCode=503;response.setHeader('Connection','close');response.end('Service is shutting down.');return true;
     }
     response.once('finish',()=>{if(draining)Reflect.apply(closeIdle,server,[]);});
    }
    return Reflect.apply(emit,this,[event,...values]);
   };
  }
 }
 return Reflect.apply(listen,this,args);
};
function finishDrain(){
 clearInterval(keepAlive);process.removeListener('message',onMessage);process.removeListener('disconnect',onDisconnect);
 // No process.exit here: referenced requests, fs operations and timers must
 // finish naturally. Unref'ed work and deliberate entry process.exit are outside
 // this cooperative contract. Never signal a PID or force-close a connection.
 if(process.connected)process.disconnect();
}
function announceReady(){if(process.connected)report({type:'drain-ready'});else finishDrain();}
function beginDrain(reason){
 if(draining){if(drainReady)announceReady();return;}
 draining=true;
 // An unresolved cleanup Promise by itself does not keep Node alive. Retain a
 // referenced handle until all listener closes and the optional hook complete.
 keepAlive=setInterval(()=>{},1000);
 const closing=[...servers].map(server=>new Promise((resolve,reject)=>{
  try{
   const state=httpPreconnections.get(server);
   if(state){
    // Node checks listener counts before its automatic 100/417 writes. During
    // drain, route both Expect branches through the refusal in our emit wrapper.
    server.on('checkContinue',()=>{});server.on('checkExpectation',()=>{});
   }
   Reflect.apply(closeMethods.get(server)||close,server,[error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()]);
   if(state)for(const socket of state.pending)endEmptyHttpConnection(state,socket);
  }catch(error){if(error.code==='ERR_SERVER_NOT_RUNNING')resolve();else reject(error);}
 }));
 let cleanup;try{cleanup=typeof entryExports?.reviewopsShutdown==='function'?entryExports.reviewopsShutdown({reason}):undefined;}catch(error){cleanup=Promise.reject(error);}
 Promise.all([...closing,cleanup]).then(()=>{drainReady=true;announceReady();},error=>{report({type:'drain-error',message:describeError(error)});});
}
function onDisconnect(){beginDrain('parent-disconnect');}
function onMessage(message){
 if(!message||message.protocol!=='reviewops-owned-node-v1')return;
 if(initialized){
  if(message.token!==token||message.instanceId!==instanceId)return;
  if(message.type==='stop')beginDrain('stop');
  if(message.type==='drain-ack'&&drainReady)finishDrain();
  if(message.type==='listeners')listeners();
  return;
 }
 if(message.type!=='init'||typeof message.token!=='string'||typeof message.instanceId!=='string')return;
 initialized=true;token=message.token;instanceId=message.instanceId;
 if(!send||process.versions.electron){report({type:'error',message:'A standalone Node executable is required.'});exit(1);return;}
 process.argv=[process.execPath,message.entry,...message.args];
 report({type:'ready',pid:process.pid,executable:process.execPath,argv:[...process.argv],spawnArgv:originalArgv,cwd:process.cwd(),nodeVersion:process.versions.node,reportedAt:new Date().toISOString()});
 try{entryExports=Module._load(message.entry,null,true);}catch(error){report({type:'error',message:describeError(error)});exit(1);}
}
process.on('disconnect',onDisconnect);
process.on('message',onMessage);
