import {_electron as electron,expect} from '@playwright/test';
import {setTestLocale} from './test-locale.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

// Controlled stdio is the default. The opt-in lane forwards genuine CLI bytes
// unchanged and makes exactly two goal starts, with a canvas-only image oracle.
const root=process.cwd(),real=process.argv.includes('--real-codex'),lifecycleOnly=process.argv.includes('--lifecycle-only'),executable=process.env.REVIEWOPS_TEST_EXECUTABLE;
if(real&&lifecycleOnly)throw new Error('The genuine image interpretation scope is separate from the controlled lifecycle range.');
if(executable&&!process.env.REVIEWOPS_EXPECTED_BUILD_INFO)throw new Error('Bind an installed app to REVIEWOPS_EXPECTED_BUILD_INFO before launching.');
const directory=fs.realpathSync(fs.mkdtempSync('/tmp/reviewops-ops-qa-')),dataPath=path.join(directory,'data'),home=path.join(directory,'home');
const output=path.join(root,'test-results','ops-qa',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const work=Object.fromEntries(['A','B','C','D'].map(key=>[key,path.join(directory,key)]));
for(const folder of [...Object.values(work),home,path.join(dataPath,'codex-manager'),path.join(dataPath,'updates')])fs.mkdirSync(folder,{recursive:true});
const config=path.join(directory,'ssh-config'),binary=path.join(directory,'qa-codex'),fixture=path.join(directory,'qa-runtime.cjs');fs.writeFileSync(config,'# Owned Ops QA has no SSH connections\n');
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
fs.copyFileSync(path.join(root,'scripts/ops-qa-cli-fixture.cjs'),fixture);fs.writeFileSync(binary,'#!/bin/sh\nexec '+shellQuote(process.execPath)+' '+shellQuote(fixture)+' "$@"\n',{mode:0o700});
fs.writeFileSync(path.join(dataPath,'codex-manager/runtime.json'),JSON.stringify({path:binary}));fs.writeFileSync(path.join(dataPath,'updates/settings.json'),JSON.stringify({automatic:false,intervalMinutes:10}));
const env={...process.env,REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:config,REVIEWOPS_CODEX_SSH_CONFIG:config,REVIEWOPS_OPS_QA_FIXTURE_ROOT:directory};
if(real)env.REVIEWOPS_OPS_QA_REAL_CLI=fs.realpathSync(process.env.REVIEWOPS_E2E_CODEX_BINARY||execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim());
else{env.HOME=home;env.CODEX_HOME=path.join(home,'.codex');fs.mkdirSync(env.CODEX_HOME,{recursive:true});}
for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY','CHATGPT_ACCESS_TOKEN','ANTHROPIC_API_KEY'])delete env[key];
const nonces={A:randomUUID().replaceAll('-','').slice(0,12).toUpperCase(),B:randomUUID().replaceAll('-','').slice(0,12).toUpperCase()},checks=[],errors=[],observations={mode:real?'genuine CLI with unmodified diagnostic tee':'controlled stdio CLI; no genuine model calls',fixture:directory};
let app,main,server,failure,sequence=0;const goals={},projects={},reviews={},primaryConnections={};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(value)return value;await wait(60);}throw new Error('Timed out: '+label);}
const ipc=(action,payload={})=>main.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const snapshot=()=>main.evaluate(()=>window.opsManager.snapshot());
const goal=async key=>(await snapshot()).goals.find(row=>row.id===goals[key].id);
const callOps=(method,input)=>main.evaluate(({method,input})=>window.opsManager[method](input),{method,input});
const ops=()=>main.locator('.workspace-pane:not([hidden]) .ops-workspace');
const detail=()=>ops().locator('.ops-detail');
const pass=(name,details={})=>{checks.push({name,...details});console.log('PASS: '+name);};
const protocol=()=>fs.existsSync(path.join(directory,'protocol.jsonl'))?fs.readFileSync(path.join(directory,'protocol.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
async function content(key,expression){return app.evaluate(({webContents},{url,expression})=>webContents.getAllWebContents().find(row=>row.getURL()===url)?.executeJavaScript(expression),{url:observations.origin+'/'+key.toLowerCase(),expression});}
async function selectGoal(key){await ops().locator('.ops-main-tabs').getByRole('button',{name:'목표',exact:true}).click();await ops().locator('.ops-goal-list').getByRole('button').filter({has:main.getByText(goals[key].name,{exact:true})}).click();await expect(detail().getByRole('heading',{name:goals[key].name,exact:true})).toBeVisible();await detail().getByRole('navigation',{name:'목표 상세 항목',exact:true}).getByRole('button',{name:'정보',exact:true}).click();}
async function photo(name){await main.screenshot({path:path.join(output,name)});}
async function control(key,tool,args={},success=true){
 const id='qa-'+(++sequence)+'-'+randomUUID();fs.appendFileSync(path.join(work[key],'qa-controls.jsonl'),JSON.stringify({id,tool,args})+'\n');
 const file=path.join(directory,'responses',id+'.json');await until(()=>fs.existsSync(file),'actual tool response '+tool);const result=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(result.success,success,tool+': '+JSON.stringify(result.data));if(success)await until(async()=>(await goal(key)).qaReceipts?.some(row=>row.callId===id),'durable QA receipt '+tool);
 const receipt=(await goal(key)).qaReceipts?.find(row=>row.callId===id);if(success)assert.equal(receipt.status,'completed');else if(receipt)assert.ok(['failed','unknown'].includes(receipt.status),'Denied operations must not be labeled completed');return {...result,receipt};
}
const data=result=>result.data?.result||result.data?.data||result.data;
async function locale(){
 if(!executable&&env.REVIEWOPS_DEV_URL){await main.waitForFunction(()=>Boolean(window.reviewops?.invoke));assert.equal(new URL(main.url()).origin,new URL(env.REVIEWOPS_DEV_URL).origin);await main.evaluate(()=>localStorage.setItem('reviewops.language','ko'));await main.reload();await main.waitForFunction(()=>document.documentElement.lang==='ko');}
 else await setTestLocale(main);
}
async function start(key){await callOps('goalAction',{goalId:goals[key].id,action:'start'});await until(async()=>{const row=await goal(key);if(['error','unknown'].includes(row.executionState))throw new Error('Goal '+key+': '+row.lastError);return row.executionState==='running'||row.history.some(entry=>entry.type==='delivery'&&entry.status==='completed');},'goal '+key+' running');}
async function pause(key){await selectGoal(key);await detail().getByRole('button',{name:'일시정지',exact:true}).click();await until(async()=>{const value=await goal(key);return value.status==='paused'&&value.executionState==='idle';},'goal '+key+' pause');await expect(detail().getByRole('button',{name:'목표 시작',exact:true})).toBeVisible();}
async function controlled(){
 if(!lifecycleOnly){
 await Promise.all([start('A'),start('B'),start('C')]);
 const initial=await snapshot();assert.equal(new Set(initial.goals.filter(row=>row.threadId).map(row=>row.threadId)).size,3);
 await Promise.all([control('A','ops_qa_open',{reviewId:reviews.A.id}),control('B','ops_qa_open',{reviewId:reviews.B.id})]);
 const a=await goal('A'),b=await goal('B');assert.equal(a.qaBinding.state,'attached');assert.equal(b.qaBinding.state,'attached');assert.notEqual(a.qaBinding.windowId,b.qaBinding.windowId);assert.notEqual(a.qaBinding.sessionId,b.qaBinding.sessionId);
 observations.originalBindings={A:a.qaBinding,B:b.qaBinding};await selectGoal('A');await expect(detail().getByRole('region',{name:'목표 QA 연결'})).toContainText('연결됨');
 await detail().getByText('QA 연결 식별자',{exact:true}).click();await expect(detail().getByRole('region',{name:'목표 QA 연결'})).toContainText(a.qaBinding.sessionId);await photo('01-independent-qa-bindings.png');
 pass('Actual goal tools acquire distinct project QA windows and UI displays the original goal/thread/turn binding');
 const browsers={};
 for(const key of ['A','B']){const binding=observations.originalBindings[key],browser=await until(async()=>{const state=data(await control(key,'ops_qa_state'));assert.equal(state.projectId,binding.projectId);assert.equal(state.windowId,binding.windowId);assert.equal(state.clientId,binding.clientId);assert.equal(state.sessionId,binding.sessionId);assert.ok(Array.isArray(state.browsers));return state.browsers.find(row=>row.url===observations.origin+'/'+key.toLowerCase());},'original bound browser '+key);browsers[key]=browser.browserId;assert.ok(browsers[key]);await until(async()=>await content(key,'document.readyState')==='complete','loaded source '+key);}
 const docs={};
 for(const key of ['A','B']){
  const observed=data(await control(key,'ops_qa_document',{operation:'state',browserId:browsers[key]}));docs[key]=observed.documentId;assert.ok(docs[key]);const input=observed.elements.find(row=>row.tag==='input'),point={x:input.rect.x+input.rect.width/2,y:input.rect.y+input.rect.height/2};
  await control(key,'ops_qa_document',{operation:'click',browserId:browsers[key],documentId:docs[key],...point});await control(key,'ops_qa_document',{operation:'type',browserId:browsers[key],documentId:docs[key],text:'OWN_'+key});
  assert.equal(await content(key,'document.querySelector("#draft").value'),'OWN_'+key);
 }
 const captured=await control('A','ops_qa_document',{operation:'capture',browserId:browsers.A});assert.equal(captured.images.length,1);assert.equal(captured.images[0].sha256,captured.receipt.capture.sha256);assert.equal(captured.images[0].size,captured.receipt.capture.size);assert.equal(captured.receipt.capture.mimeType,'image/png');
 observations.capture={...captured.images[0],receipt:captured.receipt};assert.equal(JSON.stringify(await snapshot()).includes('data:image/'),false);
 await selectGoal('A');await detail().getByRole('navigation',{name:'목표 상세 항목',exact:true}).getByRole('button',{name:'대화와 실행',exact:true}).click();const receipts=detail().getByRole('region',{name:'QA 처리 기록'});await receipts.locator('details').first().locator('summary').click();await expect(receipts).toContainText(captured.receipt.capture.sha256);await photo('02-actual-capture-receipt.png');
 pass('Bound document input changes only its own source; actual PNG reaches the controlled CLI and matches durable metadata without base64 in product state');
 await control('A','ops_qa_capture',{browserId:browsers.B},false);await control('A','ops_qa_capture',{projectId:b.qaBinding.projectId,sessionId:b.qaBinding.sessionId,windowId:b.qaBinding.windowId},false);
 await control('C','ops_qa_open',{},false);assert.equal((await goal('A')).qaBinding.sessionId,a.qaBinding.sessionId);assert.equal((await goal('B')).qaBinding.sessionId,b.qaBinding.sessionId);assert.equal(await content('B','document.querySelector("#draft").value'),'OWN_B');
 await assert.rejects(callOps('saveGoal',{id:goals.A.id,qaBinding:b.qaBinding}));pass('Foreign browser/binding arguments, renderer binding writes and same-project QA acquisition are denied without changing the original owners');
 await control('A','ops_qa_reload',{browserId:browsers.A});await until(async()=>await content('A','document.readyState')==='complete','reloaded source');
 await control('A','ops_qa_document',{operation:'type',browserId:browsers.A,documentId:docs.A,text:'STALE_REPLAY'},false);assert.equal(await content('A','document.querySelector("#draft").value'),'');
 const renewed=data(await control('A','ops_qa_document',{operation:'state',browserId:browsers.A}));assert.notEqual(renewed.documentId,docs.A);pass('Browser reload invalidates the original document observation and refuses stale input rather than replaying it');
 await pause('A');assert.equal((await goal('A')).qaBinding.state,'released');assert.equal((await goal('B')).qaBinding.state,'attached');await control('B','ops_qa_state');assert.equal(await content('B','document.querySelector("#draft").value'),'OWN_B');
 await control('C','ops_qa_open',{reviewId:reviews.A.id});assert.equal((await goal('C')).qaBinding.state,'attached');assert.notEqual((await goal('C')).qaBinding.sessionId,a.qaBinding.sessionId);await selectGoal('A');await photo('03-selected-goal-release.png');pass('Pausing A releases only its QA lease; B keeps its original session/input, and waiting same-project C can explicitly acquire a new lease');
 }else{await start('B');await control('B','ops_qa_open',{reviewId:reviews.B.id});}
 await ipc('project.delete',{id:projects.B.id});const replacement=await ipc('project.save',{groupId:projects.B.groupId,name:'Replacement QA B',connection:{kind:'local',rootPath:work.B,viewerUrl:observations.origin+'/b'}});assert.notEqual(replacement.id,projects.B.id);
 await control('B','ops_qa_state',{},false);assert.notEqual((await goal('B')).qaBinding?.state,'attached');assert.equal((await goal('B')).projectId,projects.B.id);await selectGoal('B');await photo('04-project-replacement-denied.png');pass('Deleting a project and creating a replacement does not transfer the original goal QA binding or rewrite its project target');
 await selectGoal('D');await expect(detail().getByRole('region',{name:'목표 QA 연결'})).toContainText('폴더 목표에는 QA 연결을 만들지 않습니다.');assert.equal((await goal('D')).threadId,null);assert.equal((await goal('D')).projectId,'');pass('Folder-only goals explicitly show QA unavailable and create no synthetic project/session');
 if(!lifecycleOnly)await pause('C');await pause('B');
}
async function genuine(){
 await Promise.all([start('A'),start('B')]);
 await until(async()=>{const rows=await snapshot();return ['A','B'].every(key=>rows.goals.find(row=>row.id===goals[key].id)?.history.some(row=>row.type==='delivery'&&row.status==='completed'));},'two real image interpretation turns',240000);
 for(const key of ['A','B']){
  const current=await goal(key),answer=current.conversation.filter(row=>row.role==='assistant').map(row=>row.text).join('\n');assert.ok(answer.includes('OPS_QA_'+key+'_IMAGE '+nonces[key]),'Actual image-only nonce must be interpreted for '+key);
  assert.equal(await content(key,'document.querySelector("#draft").value'),'MODEL_'+key);assert.equal(current.qaBinding.projectId,projects[key].id);assert.equal(current.qaBinding.state,'attached');assert.ok(current.qaReceipts.some(row=>row.status==='completed'&&row.capture?.sha256));
 }
 const traffic=protocol(),starts=traffic.filter(row=>row.direction==='client'&&row.method==='turn/start'),allocations=traffic.filter(row=>row.direction==='client'&&row.method==='thread/start');assert.equal(starts.length,2);assert.equal(allocations.length,2);
 const prohibited=traffic.filter(row=>['commandExecution','fileChange','mcpToolCall','webSearch'].includes(row.itemType));assert.deepEqual(prohibited,[]);const modelCalls=traffic.filter(row=>row.direction==='server'&&row.method==='item/tool/call');assert.ok(modelCalls.length>=4);assert.ok(modelCalls.every(row=>row.tool?.startsWith('ops_qa_')));assert.ok(traffic.filter(row=>row.direction==='client'&&row.images?.length).length>=2);
 observations.genuine={actualTurnStarts:starts.length,actualThreadAllocations:allocations.length,modelToolCalls:modelCalls.map(row=>({tool:row.tool,threadId:row.threadId,turnId:row.turnId})),imageResponses:traffic.filter(row=>row.images?.length),prohibitedToolItems:prohibited};
 await selectGoal('B');await photo('01-genuine-independent-image-result.png');pass('Two actual goal threads interpreted separate canvas-only nonces from returned PNGs, changed only their bound inputs and used no filesystem/network fallback');
 const originalB=(await goal('B')).qaBinding;await pause('A');assert.equal((await goal('A')).qaBinding.state,'released');assert.equal((await goal('B')).qaBinding.sessionId,originalB.sessionId);assert.equal((await goal('B')).qaBinding.state,'attached');await photo('02-genuine-selected-release.png');await pause('B');pass('After genuine image interpretation, pausing one goal releases its own binding without changing the independent goal');
}
try{
 server=http.createServer((request,response)=>{const key=request.url==='/a'?'A':'B';response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><meta charset="utf-8"><title>Owned QA '+key+'</title><style>body{font:24px sans-serif;padding:30px;background:'+(key==='A'?'#edf6ff':'#fff5e8')+'}input{font:inherit;padding:9px}canvas{display:block;margin-top:30px}</style><h1>Owned goal '+key+'</h1><label>Input '+key+'<input id="draft"></label><canvas width="850" height="120"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#fff";c.fillRect(0,0,850,120);c.fillStyle="#111";c.font="40px monospace";c.fillText("IMAGE '+key+': '+nonces[key]+'",20,75);</script>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));observations.origin='http://127.0.0.1:'+server.address().port;
 app=await electron.launch({args:executable?[]:[root],executablePath:executable,env,timeout:30000});main=await app.firstWindow();main.setDefaultTimeout(12000);main.on('pageerror',error=>errors.push(error.message));await locale();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1100));
 const identity=await ipc('app.info');observations.app=identity;observations.executablePath=await app.evaluate(()=>process.execPath);if(executable){const expected=JSON.parse(fs.readFileSync(process.env.REVIEWOPS_EXPECTED_BUILD_INFO,'utf8'));assert.deepEqual(identity.build,expected.build||expected);assert.equal(fs.realpathSync(observations.executablePath),fs.realpathSync(executable));}
 const group=await ipc('group.save',{name:'Owned Ops QA projects'});
 for(const key of ['A','B']){projects[key]=await ipc('project.save',{groupId:group.id,name:'Ops QA '+key,connection:{kind:'local',rootPath:work[key],viewerUrl:observations.origin+'/'+key.toLowerCase(),viewerWidth:1100,viewerHeight:750,viewerScale:'fit'}});reviews[key]=await ipc('review.save',{projectId:projects[key].id,title:'Owned QA review '+key});primaryConnections[key]=projects[key].connection.id;assert.equal(projects[key].connection.rootPath,work[key]);}
 const alternate=await ipc('service.save',{groupId:group.id,name:'Independent target for same-project QA conflict',kind:'local',rootPath:work.C});projects.A=await ipc('project.save',{id:projects.A.id,serviceIds:[...projects.A.serviceIds,alternate.id]});
 for(const key of ['A','B','C','D']){
  const selected=key==='C'?projects.A:projects[key],modelPrompt=real&&['A','B'].includes(key)?'Use only this goal’s ops_qa tools. Do not use shell, file, network, search, subagent or schedule tools. First ops_qa_open with reviewId '+reviews[key].id+'. Then ops_qa_state to identify this project’s embedded browser. Use ops_qa_document state to obtain its documentId and input rectangle; click the input and type MODEL_'+key+' using that exact documentId. Capture this same browser with ops_qa_document capture. Read the actual IMAGE '+key+' nonce drawn only in the returned image; it is absent from the state text. Reply exactly OPS_QA_'+key+'_IMAGE followed by the nonce actually seen. Do not invent an image value or create another goal/session.':'Controlled stdio QA transport. Tools are driven by this test’s owned control file; this is not a real model response.';
  const values={name:'Ops QA goal '+key,description:'Owned goal-bound project/window QA acceptance',prompt:modelPrompt,model:'',reasoningEffort:'',sandboxMode:'workspace-write',approvalPolicy:'never',projectId:selected?.id||'',serviceId:key==='C'?alternate.id:primaryConnections[key]||null,workPath:key==='D'?work.D:''};
  const saved=await callOps('saveGoal',values);goals[key]=saved.goals.at(-1);assert.equal(goals[key].workPath,work[key]);
 }
 await main.locator('.main-nav').getByRole('button',{name:'Ops',exact:true}).click();await expect(ops()).toBeVisible();
 if(real)await genuine();else await controlled();
 assert.deepEqual(errors,[]);
}catch(error){failure=error;await main?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error('OPS_QA_FAILURE',error.stack);}
finally{
 if(app){for(const key of Object.keys(goals))try{const row=await goal(key);if(row?.status==='active')await callOps('goalAction',{goalId:row.id,action:'pause'});}catch(error){failure??=error;}observations.finalSnapshot=await snapshot().catch(()=>null);await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 if(server)await new Promise(resolve=>server.close(resolve));
 // A wrapper exits only after its actual child exits. Wait before removing its
 // diagnostic directory so a late exit record cannot race profile cleanup.
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 try{await until(()=>protocol().every(row=>!alive(row.pid)),'owned CLI wrapper exits',10000);}catch(error){failure??=error;}
 const traffic=protocol();observations.runtimeProcesses=[...new Set(traffic.flatMap(row=>[row.pid,row.childPid]).filter(Boolean))].map(pid=>({pid,exited:!alive(pid)}));fs.writeFileSync(path.join(output,'protocol.json'),JSON.stringify(traffic,null,2));
 const responses=path.join(directory,'responses');if(fs.existsSync(responses))fs.cpSync(responses,path.join(output,'tool-responses'),{recursive:true});
 try{if(observations.runtimeProcesses.some(row=>!row.exited))throw new Error('A tracked owned CLI process is still exiting; profile was retained.');fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){failure??=error;}observations.fixtureRemoved=!fs.existsSync(directory);
 const result={ok:!failure,checks,errors,failure:failure?.stack||null,observations,scope:real?'Actual source/installed Electron (as recorded), main/preload/Ops tools and unchanged authenticated CLI transport. Two real goal model turns interpret actual image-only nonces; not physical two-PC or comprehensive release QA.':'Actual source/installed Electron (as recorded), main/preload/QA project windows and genuine PNGs driven by a controlled stdio CLI. No actual model calls or whole-release QA.'};
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log('RESULTS: '+output);
}
if(failure)throw failure;
