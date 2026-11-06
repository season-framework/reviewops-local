import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID,generateKeyPairSync} from 'node:crypto';

if(!process.argv.includes('--real-codex'))throw new Error('Account-backed transport QA requires --real-codex.');
const require=createRequire(import.meta.url),{createOpsSession}=require('../electron/ops-session.cjs'),{RpcClient}=require('../electron/codex/rpc-client.cjs');
const sshMode=process.argv.includes('--ssh');
const command=fs.realpathSync(process.env.REVIEWOPS_E2E_CODEX_BINARY||execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim());
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const workPath=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-ops-real-session-')));
const output=path.join(process.cwd(),'test-results','ops-session-real',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const events=[],calls=[],checks=[],nonce=randomUUID();let client,session,resumed,threadId,turnId,failure;
async function ownedSsh(){
 const {Server,utils}=require('ssh2'),{createSshService,fingerprintOf}=require('../electron/ssh.cjs');
 const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
 const password=randomUUID(),clients=new Set(),children=new Set();
 const server=new Server({hostKeys:[key]},connection=>{
  clients.add(connection);connection.on('error',()=>{});connection.on('close',()=>clients.delete(connection));
  connection.on('authentication',context=>context.method==='password'&&context.username==='owned-ops-fixture'&&context.password===password?context.accept():context.reject());
  connection.on('ready',()=>connection.on('session',accept=>{
   const accepted=accept();accepted.on('sftp',accept=>{
    const sftp=accept();
    sftp.on('REALPATH',async(id,value)=>{try{const canonical=await fs.promises.realpath(value);sftp.name(id,[{filename:canonical,attrs:{}}]);}catch{sftp.status(id,2);}});
    sftp.on('STAT',async(id,value)=>{try{const info=await fs.promises.stat(value);sftp.attrs(id,{mode:info.mode,uid:info.uid,gid:info.gid,size:info.size,atime:Math.floor(info.atimeMs/1000),mtime:Math.floor(info.mtimeMs/1000)});}catch{sftp.status(id,2);}});
   });
   accepted.on('exec',(accept,_reject,info)=>{
    const channel=accept();channel.on('error',()=>{});
    const child=spawn('/bin/bash',['-c',info.command],{env,detached:true,stdio:['pipe','pipe','pipe']});children.add(child);
    channel.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.pipe(channel,{end:false});child.stderr.pipe(channel.stderr,{end:false});
    child.on('close',code=>{children.delete(child);if(!channel.destroyed){channel.exit(code??143);channel.end();}});
   });
  }));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const config={kind:'ssh',host:'127.0.0.1',port:server.address().port,username:'owned-ops-fixture',authType:'password',password,rootPath:workPath,hostFingerprint:fingerprintOf(utils.parseKey(key).getPublicSSH())};
 const inspector=createSshService(),target=await inspector.inspectAppServerTarget(config,{workPath});await inspector.close();
 return {target:{kind:'ssh',identityKey:target.identity,lockIdentity:target.lockIdentity},resolveSessionTarget:()=>({sshConfig:config,workPath:target.canonicalWorkPath,binary:command,targetIdentity:target.identity}),
  async close(){for(const child of children)if(child.exitCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}for(const connection of clients){connection.end();connection._sock?.destroy();}await new Promise(resolve=>server.close(resolve));}};
}
const owned=sshMode?await ownedSsh():null;
const options={goalId:'owned_protocol_goal',workPath,config:{approvalPolicy:'never',sandboxMode:'workspace-write'},runtime:{command,args:[]},env,
 ...(owned?{target:owned.target,resolveSessionTarget:owned.resolveSessionTarget}:{}),
 rpcFactory:value=>(client=new RpcClient(value)),onEvent:event=>events.push(event),
 tools:[{name:'ops_protocol_probe',description:'Return a nonce for this isolated transport check only. This changes no schedule or product data.',inputSchema:{type:'object',properties:{reason:{type:'string'},value:{type:'string'}},required:['reason','value'],additionalProperties:false},
  execute:(args,metadata)=>{calls.push({args,metadata});return {nonce,value:args.value};}}]};
const wait=async(check,timeout)=>{const started=Date.now();while(Date.now()-started<timeout){if(await check())return;await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('The owned actual CLI turn did not reach the expected state.');};
try{
 session=createOpsSession(options);
 const first=await session.start({deliveryId:'protocol_start',prompt:'This is isolated transport acceptance in a temporary directory. Call ops_protocol_probe with reason "confirm the owned protocol" and value "BASE", then reply OPS_PROTOCOL_BASE and the returned nonce. Use no shell, network, other tools, or files.'});
 threadId=first.threadId;turnId=first.turnId;assert.equal(first.delivery,'accepted');
 const steer=await session.steer({deliveryId:'protocol_steer',threadId,turnId,prompt:'Apply this update within the same active turn: call ops_protocol_probe once with value "STEERED" and reason "the instruction arrived during the same turn"; reply OPS_PROTOCOL_STEERED and its returned nonce. Do not call any other tools.'});
 assert.equal(steer.delivery,'accepted');assert.equal(steer.threadId,threadId);assert.equal(steer.deliveryTurnId,turnId);
 checks.push('The genuine app-server accepted start and steering on one persistent thread and the same turn.');
 await wait(()=>events.some(event=>event.type==='turn.completed'&&event.turnId===turnId),180000);
 const completed=events.find(event=>event.type==='turn.completed'&&event.turnId===turnId);assert.equal(completed.status,'completed');
 assert.equal(calls.length,1);assert.equal(calls[0].args.value,'STEERED');assert.equal(calls[0].metadata.threadId,threadId);assert.equal(calls[0].metadata.turnId,turnId);
 assert.ok(events.some(event=>event.type==='message'&&event.role==='assistant'&&!event.partial&&event.text.includes(nonce)&&event.text.includes('OPS_PROTOCOL_STEERED')));
 checks.push('The real model invoked the bound client tool and used its actual returned nonce in the final response.');
 const acknowledged=await session.reconcile({deliveryId:'protocol_steer',prompt:'Apply this update within the same active turn: call ops_protocol_probe once with value "STEERED" and reason "the instruction arrived during the same turn"; reply OPS_PROTOCOL_STEERED and its returned nonce. Do not call any other tools.',threadId,turnId});
 assert.equal(acknowledged.delivery,'accepted');assert.equal(acknowledged.state,'idle');assert.equal(acknowledged.outcome,'completed');
 checks.push('Actual paginated turn history confirmed the exact delivered instruction and completed outcome.');
 await session.close();session=null;
 resumed=createOpsSession({...options,threadId});
 const recovered=await resumed.reconcile({deliveryId:'protocol_start',prompt:'This is isolated transport acceptance in a temporary directory. Call ops_protocol_probe with reason "confirm the owned protocol" and value "BASE", then reply OPS_PROTOCOL_BASE and the returned nonce. Use no shell, network, other tools, or files.',threadId,turnId});
 assert.equal(recovered.threadId,threadId);assert.equal(recovered.delivery,'accepted');assert.equal(recovered.state,'idle');assert.equal(recovered.outcome,'completed');
 checks.push('A new app-server connection resumed the original durable thread without a new model turn or replay.');
}catch(error){failure={code:error.code||'OPS_ACTUAL_QA_FAILED',message:error.message};process.exitCode=1;}
finally{
 threadId ||= events.find(event=>event.type==='thread')?.threadId;turnId ||= events.find(event=>event.type==='turn.started')?.turnId;
 if(session&&threadId&&turnId)try{await session.interrupt({threadId,turnId});}catch{}
 if(client&&!client.closed&&threadId)try{await client.request('thread/archive',{threadId});}catch{}
 await session?.close();await resumed?.close();try{await owned?.close();}catch{failure||={code:'OWN_SSH_CLEANUP_UNCONFIRMED',message:'The owned SSH fixture did not close cleanly.'};process.exitCode=1;}
 const result={ok:checks.length===4&&!failure,checks,failure,threadId,turnId,toolCalls:calls.length,output,targetKind:sshMode?'ssh':'local',scope:`Genuine installed CLI and existing authentication; ${sshMode?'owned loopback SSH':'local'} transport, same-turn steering, one bound probe tool and restart recovery; not UI, a separate physical PC or release QA`};
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));fs.writeFileSync(path.join(output,'events.json'),JSON.stringify(events,null,2));
 fs.rmSync(workPath,{recursive:true,force:true});console.log(JSON.stringify(result));
}
