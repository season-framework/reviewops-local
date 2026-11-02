'use strict';
// Private child IPC only. This launcher supports one in-process CommonJS server;
// it deliberately does not supervise arbitrary descendants or expose an HTTP token.
const exit=process.exit.bind(process),send=process.send?.bind(process);
const originalArgv=[...process.argv],net=require('node:net'),Module=require('node:module');
let initialized=false,token='',instanceId='',entryExports,draining=false,drainReady=false,keepAlive;
const servers=new Set(),closeMethods=new WeakMap(),address=net.Server.prototype.address;
const describeError=error=>{try{return String(error?.message??error).slice(0,1000);}catch{return 'Unknown service cleanup failure.';}};
const report=value=>{try{send?.({protocol:'reviewops-owned-node-v1',token,instanceId,...value},()=>{});}catch{}};
const listeners=()=>{
 const values=[];
 for(const server of servers){let item;try{item=address.call(server);}catch{}if(item&&typeof item==='object')values.push({address:item.address,family:item.family,port:item.port});}
 report({type:'listeners',listeners:values.slice(0,32)});
};
const listen=net.Server.prototype.listen;
const close=net.Server.prototype.close;
net.Server.prototype.listen=function(...args){
 if(draining)throw Object.assign(new Error('The owned service is shutting down.'),{code:'SERVICE_STOPPING'});
 if(!servers.has(this)){
  servers.add(this);closeMethods.set(this,this.close);this.on('listening',listeners);this.on('close',()=>{servers.delete(this);listeners()});
  // HTTP close handles currently idle keep-alive sockets. A request active at
  // close can become idle later, so close only those idle sockets after finish.
  // Never use closeAllConnections or destroy an accepted request's socket.
  if(typeof this.closeIdleConnections==='function'){
   const emit=this.emit,closeIdle=this.closeIdleConnections,server=this;
   this.emit=function(event,...values){
    if(event==='request'){
     const response=values[1];
     if(draining){response.statusCode=503;response.setHeader('Connection','close');response.end('Service is shutting down.');return true;}
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
  try{Reflect.apply(closeMethods.get(server)||close,server,[error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()]);}catch(error){if(error.code==='ERR_SERVER_NOT_RUNNING')resolve();else reject(error);}
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
