'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAgentManager}=require('../electron/agents.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check){for(let i=0;i<200;i++){const value=await check();if(value)return value;await pause(20)}assert.fail('Synthetic service did not reach the expected state');}

async function fixture(t,keepRunning){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-lifecycle-')),stateFile=path.join(root,'service.json'),binary=path.join(root,'fixture-codex');
  fs.writeFileSync(path.join(root,'service.cjs'),`const fs=require('node:fs'),http=require('node:http');const server=http.createServer((_req,res)=>res.end('fixture-ready'));server.listen(0,'127.0.0.1',()=>{const file=process.argv[2];fs.writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+server.address().port}));fs.renameSync(file+'.tmp',file)});`);
  fs.writeFileSync(binary,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli synthetic-service');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
process.stdin.resume();process.stdin.on('end',()=>{const child=spawn(process.execPath,[path.join(process.cwd(),'service.cjs'),path.join(process.cwd(),'service.json')],{stdio:'ignore'});child.unref();const timer=setInterval(()=>{if(!fs.existsSync('service.json'))return;clearInterval(timer);console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-service-session'}));${keepRunning?"setInterval(()=>{},1000);":"console.log(JSON.stringify({type:'turn.completed'}));process.exit(0);"}},20)});
`,{mode:0o755});
  const manager=createAgentManager({commandTimeoutMs:3000,killTimeoutMs:100});
  t.after(async()=>{await manager.closeAll();if(fs.existsSync(stateFile)){const {pid}=JSON.parse(fs.readFileSync(stateFile));if(Number.isSafeInteger(pid)&&pid>1)try{process.kill(pid,'SIGKILL')}catch{}}fs.rmSync(root,{recursive:true,force:true});});
  const job=manager.start({config:{id:'synthetic-service',kind:'local',rootPath:root},settings:{binary,workPath:root},prompt:'Start synthetic test service'});
  const service=await eventually(()=>fs.existsSync(stateFile)&&JSON.parse(fs.readFileSync(stateFile)));
  assert.equal(await (await fetch(service.url)).text(),'fixture-ready');
  return {manager,job,service};
}

test('local CLI completion can leave an independently served child reachable', {skip:process.platform==='win32'},async t=>{
  const {manager,job,service}=await fixture(t,false);
  await eventually(()=>manager.read(job.id).status==='completed');
  assert.equal(await (await fetch(service.url)).text(),'fixture-ready');
});

test('cancelling a local CLI also stops its service in the same process group', {skip:process.platform==='win32'},async t=>{
  const {manager,job,service}=await fixture(t,true);
  assert.equal((await manager.cancel(job.id)).status,'cancelled');
  await eventually(async()=>{try{await fetch(service.url);return false}catch{return true}});
});
