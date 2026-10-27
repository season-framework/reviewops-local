'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createAgentManager}=require('../electron/agents.cjs');

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-preflight-')),work=path.join(root,'work'),binary=path.join(root,'codex-test');await fs.mkdir(work);
 await fs.writeFile(binary,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),root=process.cwd();
fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='--version'){console.log('codex-cli test-preflight');process.exit(0)}
if(args[0]==='login'&&args[1]==='status'){const file=path.join(root,'auth-code');process.exit(fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0)}
console.log(JSON.stringify({type:'thread.started',thread_id:'test-preflight'}));process.exit(0);
`,{mode:0o700});
 const manager=createAgentManager({env:{...process.env,HOME:root,CODEX_HOME:path.join(root,'codex-home')},commandTimeoutMs:2000});
 t.after(async()=>{await manager.closeAll();await fs.rm(root,{recursive:true,force:true})});
 return {root,work,binary,manager,config:{id:'preflight',kind:'local',rootPath:work},settings:{binary,workPath:work}};
}
test('preflight probes the selected executable and login without creating an agent job',async t=>{
 const f=await fixture(t),status=await f.manager.preflight(f.config,f.settings);
 assert.equal(status.binary,f.binary);assert.equal(status.workPath,await fs.realpath(f.work));assert.equal(status.version,'codex-cli test-preflight');assert.equal(status.authState,'authenticated');
 assert.deepEqual(f.manager.list(),[]);
 const commands=(await fs.readFile(path.join(f.work,'commands.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(commands,[['--version'],['login','status']]);
});
test('preflight distinguishes missing executable, expired login, failed login check, and missing folder',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.manager.preflight(f.config,{...f.settings,binary:path.join(f.root,'absent')}),{code:'AGENT_NOT_INSTALLED'});
 await fs.writeFile(path.join(f.work,'auth-code'),'1');await assert.rejects(f.manager.preflight(f.config,f.settings),{code:'AGENT_AUTH_REQUIRED'});
 await fs.writeFile(path.join(f.work,'auth-code'),'2');await assert.rejects(f.manager.preflight(f.config,f.settings),{code:'AGENT_AUTH_CHECK_FAILED'});
 await assert.rejects(f.manager.preflight(f.config,{...f.settings,workPath:path.join(f.root,'missing')}),{code:'AGENT_WORK_PATH_MISSING'});
 assert.deepEqual(f.manager.list(),[]);
});
test('execution repeats the folder check after a successful preflight',async t=>{
 const f=await fixture(t);await f.manager.preflight(f.config,f.settings);await fs.rm(f.work,{recursive:true});
 const job=f.manager.start({config:f.config,settings:f.settings,prompt:'No changes'});
 for(let attempt=0;attempt<100&&f.manager.read(job.id).status==='running';attempt++)await new Promise(resolve=>setTimeout(resolve,10));
 const result=f.manager.read(job.id);assert.equal(result.status,'failed');assert.equal(result.errorCode,'AGENT_WORK_PATH_MISSING');
});
