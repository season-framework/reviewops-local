import {setTestLocale} from './test-locale.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-agent-quit-'));
const pidFile=path.join(folder,'probe.pid'),binary=path.join(folder,'fake-codex');
// A bounded test-owned process models a stuck CLI environment probe. No user
// login, existing Codex configuration or paid model request is involved.
fs.writeFileSync(binary,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`);
fs.chmodSync(binary,0o700);
let app,processHandle,pid;
const alive=()=>{if(!pid)return false;try{process.kill(pid,0);return true}catch{return false}};
try{
 const env={...process.env,REVIEWOPS_DATA_DIR:path.join(folder,'data')};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[process.cwd()],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env});processHandle=app.process();
 const page=await app.firstWindow(); await setTestLocale(page);await page.waitForFunction(()=>window.reviewops?.invoke);
 const invoke=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
 const group=await invoke('group.save',{name:'종료 검사'}),service=await invoke('service.save',{name:'검사 프로세스',kind:'local',groupId:group.id,rootPath:folder,agentBinary:binary});
 const pending=invoke('agent.environment',{serviceId:service.id}).catch(()=>{});
 await expect.poll(()=>fs.existsSync(pidFile)).toBe(true);pid=Number(fs.readFileSync(pidFile,'utf8'));assert.ok(pid>1);assert.equal(alive(),true);
 await app.evaluate(({app})=>app.quit()).catch(()=>{});
 await expect.poll(()=>processHandle.exitCode,{timeout:10000}).toBe(0);
 await expect.poll(alive,{timeout:5000}).toBe(false);await pending;
 console.log(JSON.stringify({ok:true,check:'앱 종료 시 실행 환경 검사 프로세스 종료',testRoot:folder}));
}finally{
 if(alive())try{process.kill(-pid,'SIGKILL')}catch{}
 if(processHandle&&processHandle.exitCode===null)processHandle.kill('SIGKILL');
}
