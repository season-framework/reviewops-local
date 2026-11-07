import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {_electron as electron, expect} from '@playwright/test';
import {setTestLocale} from './test-locale.mjs';
import {seedOpsSmoke,verifyOpsSmoke,verifyOpsData,verifyOpsFile,mutateOpsSmoke,seedUnavailableOpsThread} from './ops-native-smoke.mjs';

const repository=process.cwd(),fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-ops-preservation-'));
const dataPath=path.join(fixtureRoot,'data'),fixtureHome=path.join(fixtureRoot,'home'),workPath=path.join(fixtureRoot,'work');
const backup=path.join(fixtureRoot,'ops.reviewops.json'),config=path.join(fixtureHome,'.ssh','config');
for(const directory of [workPath,path.dirname(config),path.join(dataPath,'codex-manager')])fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(config,'# Isolated native preservation fixture\n',{mode:0o600});
fs.writeFileSync(path.join(dataPath,'codex-manager','runtime.json'),JSON.stringify({path:path.join(fixtureRoot,'unavailable-codex')}),{mode:0o600});
const output=path.join(repository,'test-results','ops-preservation',new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(output,{recursive:true});
const result={ok:false,checks:[],errors:[],scope:'Focused Ops persistence feature check; no whole-product QA or actual Codex thread/model execution.',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),executable:process.env.REVIEWOPS_TEST_EXECUTABLE||'source Electron'};
let app,page,closed=true;
const invoke=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
async function launch(){
  const env={...process.env,HOME:fixtureHome,CODEX_HOME:path.join(fixtureHome,'.codex'),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_CODEX_SSH_CONFIG:config};
  delete env.ELECTRON_RUN_AS_NODE;delete env.SSH_AUTH_SOCK;
  app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[repository],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});closed=false;
  page=await app.firstWindow();page.setDefaultTimeout(15000);await setTestLocale(page);
  page.on('pageerror',error=>result.errors.push(error.message));
  await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
  const info=await invoke('app.info');
  if(process.env.REVIEWOPS_EXPECT_SOURCE_SHA)assert.equal(info.build.commit,process.env.REVIEWOPS_EXPECT_SOURCE_SHA);
  result.app={version:info.version,build:info.build,platform:info.platform,arch:info.arch};
}
async function close(){await app.close();app=null;closed=true;}
try{
  await launch();
  const fixture=await seedOpsSmoke(page,{workPath});
  result.checks.push('Real Ops IPC, navigation, paused/finished goals and IANA cron calculation work with no model conversation.');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},backup);
  await invoke('backup.export');verifyOpsData(JSON.parse(fs.readFileSync(backup,'utf8')).ops,fixture);
  await mutateOpsSmoke(page,fixture);
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});},backup);
  await invoke('backup.import');await verifyOpsSmoke(page,fixture);
  result.checks.push('The actual application backup restores original Ops prompts, goal/schedule IDs and paused/finished states after mutation.');
  await close();verifyOpsFile(dataPath,fixture);seedUnavailableOpsThread(dataPath,fixture);
  await launch();result.ops=await verifyOpsSmoke(page,fixture);
  await expect.poll(()=>page.evaluate(id=>window.opsManager.snapshot().then(state=>Boolean(state.goals.find(goal=>goal.id===id)?.lastError)),fixture.offlineGoalId)).toBe(true);
  await page.locator('.main-nav').getByRole('button',{name:'Ops',exact:true}).click();
  await expect(page.locator('.ops-main-tabs').getByRole('button',{name:'대화',exact:true})).toHaveAttribute('aria-current','page');
  await page.locator('.ops-main-tabs').getByRole('button',{name:'목표',exact:true}).click();
  await page.locator('.ops-goal-list button').filter({hasText:'Native Ops unavailable saved thread'}).click();
  await expect(page.getByRole('heading',{name:'Native Ops unavailable saved thread',exact:true})).toBeVisible();
  await page.screenshot({path:path.join(output,'unavailable-thread-window.png'),fullPage:true});
  result.checks.push('Restart opens the real window and Ops IPC while an explicitly synthetic unavailable saved thread remains paused/unknown with its original ID; no model input or fake successful resume.');
  await close();verifyOpsFile(dataPath,fixture);assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.failure={message:error.message};if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{
  if(app)await close().catch(error=>{result.cleanupError=error.message;});
  result.fixturePreserved=!closed;if(closed)fs.rmSync(fixtureRoot,{recursive:true,force:true});else result.fixtureRoot=fixtureRoot;
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,checks:result.checks,output,fixturePreserved:result.fixturePreserved}));
}
