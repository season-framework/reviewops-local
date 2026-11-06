import {_electron as electron,expect} from '@playwright/test';
import {selectControl,expectSelectValue} from './select-control.mjs';
import {setTestLocale} from './test-locale.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{emptyStatistics,recordSnapshot}=require('../electron/codex/statistics.cjs');
const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-usage-ui-'));
const home=path.join(directory,'home'),dataPath=path.join(directory,'data'),accountDir=path.join(dataPath,'codex-manager'),configPath=path.join(directory,'ssh-config');
const output=path.join(root,'test-results','usage-refresh',new Date().toISOString().replace(/[:.]/g,'-'));
for(const p of [home,accountDir,output])fs.mkdirSync(p,{recursive:true});
fs.writeFileSync(configPath,'# Isolated usage-refresh test\n');
const controlPath=path.join(directory,'responses.json'),callsPath=path.join(directory,'calls.jsonl');
const control={failIds:[],usedPercent:20,tokens:4000000};
const updateControl=()=>fs.writeFileSync(controlPath,JSON.stringify(control));updateControl();
const accounts=['Background account','Recovery account','Login required'].map((label,index)=>{
 const id=crypto.randomUUID(),email=`usage-${index+1}@example.invalid`,old=new Date(Date.now()-2*60*60*1000).toISOString();
 const usage={rateLimits:{primary:{usedPercent:90,windowDurationMins:300,resetsAt:1800000000},secondary:null},rateLimitResetCredits:{availableCount:0}};
 const statistics=emptyStatistics(email);recordSnapshot(statistics,usage,old);
 statistics.tokenUsage={summary:{lifetimeTokens:100},dailyUsageBuckets:[]};statistics.usageFetchedAt=old;
 return {id,label,email,status:index===2?'signedOut':'ready',authStarted:index!==2,requiresLogin:index===2,usage,lastUpdated:old,lastUsageRefreshAttemptAt:old,statistics};
});
fs.writeFileSync(path.join(accountDir,'accounts.json'),JSON.stringify({version:1,accounts,activity:[]}));
const program=path.join(directory,'usage-cli.cjs'),binary=path.join(directory,'usage-codex'),source=path.join(directory,'usage-cli.c');
fs.writeFileSync(program,`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);if(args[0]==='--version'){console.log('codex-cli 0.162.1-usage-fixture');process.exit(0)}if(args[0]==='login')process.exit(1);if(args[0]!=='app-server')process.exit(77);
const rows=${JSON.stringify(accounts.map(({id,email})=>({id,email})))},id=path.basename(process.env.CODEX_HOME||''),account=rows.find(row=>row.id===id);let buffer='';
process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const message=JSON.parse(line);if(message.id==null)continue;
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({id,method:message.method,time:Date.now()})+'\\n');const value=JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)},'utf8'));let result={};
if(message.method==='account/read')result={account:{type:'chatgpt',email:account?.email,planType:'plus'}};
else if(message.method==='account/rateLimits/read'){if(value.failIds.includes(id)){console.log(JSON.stringify({id:message.id,error:{code:-32001,message:'Synthetic offline response'}}));continue}result={rateLimits:{primary:{usedPercent:value.usedPercent,windowDurationMins:300,resetsAt:1800000000},secondary:null},rateLimitResetCredits:{availableCount:0}}}
else if(message.method==='account/usage/read')result={summary:{lifetimeTokens:value.tokens},dailyUsageBuckets:[]};
else if(message.method==='config/read')result={config:{model:'fixture-model',model_reasoning_effort:'high'}};
else if(message.method==='model/list')result={data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture model',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null};
else if(message.method!=='initialize'){console.log(JSON.stringify({id:message.id,error:{code:-32601,message:'Unsupported fixture method'}}));continue}
console.log(JSON.stringify({id:message.id,result}));}});
`);
fs.writeFileSync(source,`#include <unistd.h>\n#include <stdlib.h>\nint main(int argc,char** argv){char** args=calloc(argc+2,sizeof(char*));args[0]=${JSON.stringify(process.execPath)};args[1]=${JSON.stringify(program)};for(int i=1;i<argc;i++)args[i+1]=argv[i];execv(args[0],args);return 91;}\n`);
execFileSync('/usr/bin/clang',[source,'-o',binary]);
fs.writeFileSync(path.join(accountDir,'runtime.json'),JSON.stringify({path:binary}));
const calls=()=>fs.existsSync(callsPath)?fs.readFileSync(callsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const quotaCount=id=>calls().filter(row=>row.id===id&&row.method==='account/rateLimits/read').length;
const checks=[],errors=[];let app,page;
const pass=name=>{checks.push(name);console.log('PASS: '+name)};
const pane=()=>page.locator('.workspace-pane:not([hidden])');
const state=()=>page.evaluate(()=>window.accountManager.getState());
const accountRow=account=>pane().getByRole('table',{name:'계정 목록',exact:true}).getByRole('row').filter({has:page.getByRole('button',{name:account.label+' 상세 통계',exact:true})});
async function launch(){
 const env={...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:configPath,REVIEWOPS_CODEX_SSH_CONFIG:configPath};
 for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(10000);await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1450,1040));
 await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
}
async function stop(){if(!app)return;await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.destroy())).catch(()=>{});await app.close();app=null}
async function settings(){await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();await pane().locator('.settings-section-menu').getByRole('button',{name:'자동 확인',exact:true}).click()}
const usageSettings=()=>pane().getByRole('region',{name:'계정 사용량 자동 갱신',exact:true});
try{
 await launch();
 await expect.poll(async()=>{const s=await state();return s.accounts.filter(account=>account.status==='ready'&&account.usageDetailsUpdatedAt).length},{timeout:20000}).toBe(2);
 assert.equal(quotaCount(accounts[0].id),1);assert.equal(quotaCount(accounts[1].id),1);assert.equal(quotaCount(accounts[2].id),0);
 await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();pass('Startup collected summary and detailed usage on Home without opening accounts; login-required account was skipped');
 await settings();await expectSelectValue(usageSettings().getByRole('combobox',{name:'계정 사용량 갱신 주기',exact:true}),'30');await page.screenshot({path:path.join(output,'01-default-30-minutes.png')});
 await selectControl(usageSettings().getByRole('combobox',{name:'계정 사용량 갱신 주기',exact:true}),'custom');const input=usageSettings().getByRole('spinbutton',{name:'계정 사용량 갱신 주기 직접 입력',exact:true});await input.fill('0');await usageSettings().getByRole('button',{name:'주기 저장',exact:true}).click();await expect(usageSettings().getByRole('alert')).toContainText('1~1440');await input.fill('1');await usageSettings().getByRole('button',{name:'주기 저장',exact:true}).click();await expect(usageSettings()).toContainText('주기를 저장했습니다.');assert.equal((await state()).usageRefresh.intervalMinutes,1);await page.screenshot({path:path.join(output,'02-saved-one-minute.png')});pass('Settings showed default30min, rejected0 and saved1min through the real IPC and account file');
 const before=(await state()).accounts.find(account=>account.id===accounts[1].id);
 control.failIds=[accounts[1].id];control.usedPercent=40;control.tokens=8000000;updateControl();
 await page.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
 await expect.poll(()=>quotaCount(accounts[0].id),{timeout:80000,intervals:[1000]}).toBe(2);
 await expect.poll(async()=>(await state()).accounts.find(account=>account.id===accounts[1].id).status,{timeout:10000}).toBe('error');
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized()),true);
 const failed=(await state()).accounts.find(account=>account.id===accounts[1].id);
 assert.deepEqual(failed.usage,before.usage);assert.equal(failed.lastUpdated,before.lastUpdated);
 assert.equal((await state()).accounts[0].usage.rateLimits.primary.usedPercent,40);
 pass('The real main-process1min timer refreshed while minimized on Home; one failed profile retained its values and success time while another refreshed');
 await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.restore();window.focus()});
 await page.locator('.main-nav').getByRole('button',{name:'계정관리',exact:true}).click();await expect(accountRow(accounts[1])).toContainText('사용량 조회에 실패했습니다.');await expect(accountRow(accounts[1])).toContainText('마지막 성공:');await expect(accountRow(accounts[2])).toContainText('다시 로그인 필요');await page.screenshot({path:path.join(output,'03-offline-retained-usage.png')});
 await accountRow(accounts[0]).getByRole('button',{name:accounts[0].label+' 상세 통계',exact:true}).click();
 const openDetails=page.getByRole('dialog').locator('.account-details');
 const totalUsage=page.getByRole('dialog').locator('.details-summary > div').filter({has:page.getByText('전체 사용량',{exact:true})}).getByRole('definition');
 await expect(openDetails).toHaveAttribute('aria-busy','false');
 await expect(totalUsage).toContainText('8M');
 const beforeAutomaticDetails=calls().filter(row=>row.id===accounts[0].id&&row.method==='account/usage/read').length;
 control.failIds=[];control.usedPercent=60;control.tokens=12000000;updateControl();
 await expect.poll(async()=>(await state()).accounts.find(account=>account.id===accounts[1].id).status,{timeout:80000,intervals:[1000]}).toBe('ready');
 await expect.poll(async()=>(await state()).accounts.find(account=>account.id===accounts[1].id).usage.rateLimits.primary.usedPercent,{timeout:10000}).toBe(60);
 await expect.poll(()=>calls().filter(row=>row.id===accounts[0].id&&row.method==='account/usage/read').length,{timeout:10000}).toBe(beforeAutomaticDetails+1);
 await expect(totalUsage).toContainText('12M');
 await page.screenshot({path:path.join(output,'03b-open-detail-live-refresh.png')});await page.getByRole('dialog').getByRole('button',{name:'닫기',exact:true}).last().click();
 await expect(accountRow(accounts[1])).not.toContainText('사용량 조회에 실패했습니다.');
 await page.screenshot({path:path.join(output,'04-automatic-recovery.png')});
 await accountRow(accounts[1]).getByRole('button',{name:accounts[1].label+' 상세 통계',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('마지막 성공:');await page.screenshot({path:path.join(output,'05-updated-details.png')});pass('The following scheduled interval recovered the failed account and updated the visible list and detail cache');
 await page.getByRole('dialog').getByRole('button',{name:'닫기',exact:true}).last().click();
 const count=quotaCount(accounts[0].id);await app.evaluate(({powerMonitor})=>powerMonitor.emit('resume'));await new Promise(resolve=>setTimeout(resolve,250));assert.equal(quotaCount(accounts[0].id),count);pass('A resume event with fresh data did not add duplicate requests');
 await stop();await launch();await settings();await expectSelectValue(usageSettings().getByRole('combobox',{name:'계정 사용량 갱신 주기',exact:true}),'1');assert.equal(quotaCount(accounts[0].id),count);assert.equal((await state()).accounts[1].usage.rateLimits.primary.usedPercent,60);await page.screenshot({path:path.join(output,'06-restarted-persisted-interval.png')});pass('Restart retained the1min setting and latest usage without an unnecessary startup refresh');
 assert.equal(errors.length,0);assert.equal(quotaCount(accounts[2].id),0);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:true,checks,errors,sourceVersion:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),environment:'Source Electron on macOS; synthetic isolated stdio account API; real main-process1min timers and IPC. Default30min scheduling also tested with an injected clock; physical sleep and production service were not exercised.',calls:calls()},null,2));
 console.log('RESULTS: '+output);
}catch(error){fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({ok:false,checks,errors,error:error.stack},null,2));if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error}
finally{await stop();fs.rmSync(directory,{recursive:true,force:true})}
