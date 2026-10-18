'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Server,utils}=require('ssh2');
const {createSshService,fingerprintOf}=require('../electron/ssh.cjs');
const {createTerminalManager}=require('../electron/terminal.cjs');
const hostKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
const fingerprint=fingerprintOf(utils.parseKey(hostKey).getPublicSSH());
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check){for(let count=0;count<100;count++){if(check())return;await pause(20)}assert.fail('Expected terminal event was not received');}
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-terminal-'));
 const root=path.join(base,"project ' directory");await fs.mkdir(root);
 const clients=new Set(),received=[],sizes=[];let authentications=0;
 const server=new Server({hostKeys:[hostKey]},client=>{
  clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
  client.on('authentication',context=>{authentications++;if(context.method==='password'&&context.username==='tester'&&context.password==='secret')context.accept();else context.reject()});
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();
   session.on('sftp',accept=>{const sftp=accept();sftp.on('REALPATH',(id,file)=>sftp.name(id,[{filename:file,longname:file,attrs:{}}]));sftp.on('STAT',(id)=>sftp.attrs(id,{mode:0o040755,uid:0,gid:0,size:0,atime:0,mtime:0}));});
   session.on('pty',(accept,reject,info)=>{sizes.push({cols:info.cols,rows:info.rows});accept()});
   session.on('window-change',(accept,reject,info)=>{sizes.push({cols:info.cols,rows:info.rows});accept?.()});
   session.on('shell',accept=>{
    const stream=accept();stream.on('error',()=>{});
    const korean=Buffer.from('터미널 준비\r\n$ ');stream.write(korean.subarray(0,2));setTimeout(()=>{if(!stream.destroyed)stream.write(korean.subarray(2))},15);
    stream.on('data',chunk=>{const data=chunk.toString();received.push(data);if(data.includes('echo hello'))stream.write('\r\nhello\r\n$ ');if(data.includes('\x03'))stream.write('^C\r\n$ ');if(data.includes('exit\r')){stream.exit(0);stream.end();}});
   });
  }));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 const ssh=createSshService({timeoutMs:4000}),manager=createTerminalManager({ssh});
 t.after(async()=>{manager.closeAll();ssh.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));await fs.rm(base,{recursive:true,force:true});});
 return {ssh,manager,config:{id:'test-service',host:'127.0.0.1',port:server.address().port,username:'tester',password:'secret',authType:'password',rootPath:root,hostFingerprint:fingerprint},root,received,sizes,authentications:()=>authentications};
}

test('persistent SSH terminal verifies host trust before authentication',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.manager.open({...f.config,hostFingerprint:''}),error=>error.code==='SSH_TRUST_REQUIRED'&&error.fingerprint===fingerprint);
 assert.equal(f.authentications(),0);assert.equal(f.manager.size,0);
 await assert.rejects(f.manager.open({...f.config,hostFingerprint:`SHA256:${'a'.repeat(43)}`}),{code:'SSH_HOST_KEY_CHANGED'});
 assert.equal(f.authentications(),0);assert.equal(f.manager.size,0);
});

test('persistent SSH terminal streams UTF8, accepts input and resizes the PTY',async t=>{
 const f=await fixture(t),{id}=await f.manager.open(f.config,{cols:100,rows:32});
 await eventually(()=>f.manager.read(id).data.includes('터미널 준비'));
 const initial=f.manager.read(id);assert.equal(initial.data.includes('\ufffd'),false);assert.equal(initial.closed,false);
 assert.deepEqual(f.sizes[0],{cols:100,rows:32});
 await eventually(()=>f.received.length>0);
 assert.equal(f.received[0],`cd '${f.root.replace(/'/g,`'"'"'`)}' || exit $?\r`);
 f.manager.write(id,'echo hello\r');await eventually(()=>f.manager.read(id,initial.cursor).data.includes('hello'));
 assert.equal(f.manager.read(id,initial.cursor).data.includes('터미널 준비'),false);
 f.manager.write(id,'\x03');await eventually(()=>f.manager.read(id).data.includes('^C'));
 f.manager.resize(id,{cols:120,rows:40});await eventually(()=>f.sizes.some(size=>size.cols===120&&size.rows===40));
 f.manager.close(id);assert.equal(f.manager.size,0);assert.throws(()=>f.manager.read(id),{code:'TERMINAL_NOT_FOUND'});
});

test('remote shell termination is reported and sessions close by service',async t=>{
 const f=await fixture(t),first=await f.manager.open(f.config),second=await f.manager.open({...f.config,id:'other-service'});
 f.manager.write(first.id,'exit\r');await eventually(()=>f.manager.read(first.id).closed);
 assert.throws(()=>f.manager.write(first.id,'x'),{code:'TERMINAL_CLOSED'});
 f.manager.closeService('test-service');assert.equal(f.manager.size,1);assert.equal(f.manager.read(second.id).closed,false);
 f.manager.closeAll();assert.equal(f.manager.size,0);
});

test('terminal bounds output, input, dimensions, session count, and rejects unknown sessions',async()=>{
 const callbacks=[];let closed=0;
 const ssh={openShell:async(config,options)=>{callbacks.push(options);return {write(){},resize(){},close(){closed++;options.onClose({})}}}};
 const manager=createTerminalManager({ssh,maxBufferBytes:64});
 const {id}=await manager.open({id:'service'});
 const full=Buffer.from('한글'.repeat(100));callbacks[0].onData(full.subarray(0,1));callbacks[0].onData(full.subarray(1));
 const output=manager.read(id);assert.ok(Buffer.byteLength(output.data)<=64);assert.equal(output.data.includes('\ufffd'),false);assert.equal(output.truncated,true);
 assert.equal(manager.read(id,output.cursor).data,'');
 assert.throws(()=>manager.read(id,output.cursor+1),{code:'TERMINAL_CURSOR_INVALID'});
 assert.throws(()=>manager.read(id,-1),{code:'TERMINAL_CURSOR_INVALID'});
 assert.throws(()=>manager.write(id,'x'.repeat(65537)),{code:'TERMINAL_INPUT_INVALID'});
 assert.throws(()=>manager.resize(id,{cols:1,rows:24}),{code:'TERMINAL_SIZE_INVALID'});
 assert.throws(()=>manager.resize(id,{cols:80,rows:301}),{code:'TERMINAL_SIZE_INVALID'});
 assert.throws(()=>manager.write('unknown','x'),{code:'TERMINAL_NOT_FOUND'});
 await assert.rejects(manager.open({id:'service'},{cols:0}),{code:'TERMINAL_SIZE_INVALID'});
 for(let index=1;index<8;index++)await manager.open({id:'service'});
 await assert.rejects(manager.open({id:'service'}),{code:'TERMINAL_LIMIT'});
 manager.closeAll();assert.equal(manager.size,0);assert.equal(closed,8);
});

test('closing during terminal startup disposes the late connection',async()=>{
 let resolveShell,disposed=false;
 const manager=createTerminalManager({ssh:{openShell:()=>new Promise(resolve=>{resolveShell=resolve})}});
 const opening=manager.open({id:'service'});manager.closeService('service');
 resolveShell({close(){disposed=true}});
 await assert.rejects(opening,{code:'TERMINAL_CLOSED'});assert.equal(disposed,true);assert.equal(manager.size,0);
});
