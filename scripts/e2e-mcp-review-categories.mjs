import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),{invokeSocket}=require('../electron/mcp-server.cjs');
// Keep the disposable profile short enough for macOS Unix socket paths.
const root=process.cwd(),output=path.join(root,'test-results/mcp-review-categories'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rmc-'));
const home=path.join(temporary,'home'),dataPath=path.join(temporary,'data'),files=path.join(temporary,'files'),config=path.join(home,'.ssh/config');
fs.mkdirSync(path.dirname(config),{recursive:true});fs.mkdirSync(files);fs.mkdirSync(output,{recursive:true});fs.writeFileSync(config,'# Disposable MCP category fixture\n',{mode:0o600});
const env={...process.env,...isolatedModelRuntime({home,dataPath}),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:config,REVIEWOPS_CODEX_SSH_CONFIG:config};
for(const key of ['ELECTRON_RUN_AS_NODE','OPENAI_API_KEY','CODEX_API_KEY','CHATGPT_ACCESS_TOKEN','ANTHROPIC_API_KEY','SSH_AUTH_SOCK'])delete env[key];
const wire=[],transcript=[],checks=[],pending=new Map();let app,child,page,appVersion='',failure,sequence=0,buffer='',stderr='';
const print=value=>{transcript.push(value);console.log(value)};
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
function rejectPending(error){for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();}
const send=(method,params)=>new Promise((resolve,reject)=>{
 const id=++sequence,json={jsonrpc:'2.0',id,method,params};
 pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Public MCP response timed out'));},10000)});
 wire.push({direction:'request',json});child.stdin.write(JSON.stringify(json)+'\n');
});
async function call(name,args){
 print('REQUEST\n'+JSON.stringify({name,arguments:args},null,2));
 const response=await send('tools/call',{name,arguments:args});print('RESPONSE\n'+JSON.stringify(response,null,2));assert.ok(response.result);return response.result;
}
async function scenario(id,name,run){
 print(`::group::${id} ${name}`);
 try{await run();checks.push({id,name});print('PASS '+id+' '+name);}finally{print('::endgroup::');}
}
try{
 app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();await setTestLocale(page);appVersion=await app.evaluate(({app})=>app.getVersion());
 print(`ReviewOps ${appVersion}; source Electron ${process.platform}/${process.arch}; actual public stdio MCP and authenticated local bridge; disposable synthetic data; no external model or real account login.`);
 const group=await ipc('group.save',{name:'MCP 분류 검사'}),service=await ipc('service.save',{groupId:group.id,name:'합성 작업 폴더',kind:'local',rootPath:files,agentEnabled:false});
 const a=await ipc('project.save',{groupId:group.id,name:'분류 검사 A',serviceIds:[service.id]}),b=await ipc('project.save',{groupId:group.id,name:'경계 검사 B',serviceIds:[service.id]}),custom=await ipc('reviewCategory.save',{name:'연구'});
 await expect.poll(()=>fs.existsSync(path.join(dataPath,'integrations/tools.json')),{timeout:10000,message:'Public MCP bridge did not start for the disposable profile'}).toBe(true);
 child=spawn(process.execPath,[path.join(root,'electron/mcp-server.cjs'),'--data-path',dataPath,'--project-id',a.id],{env,stdio:['pipe','pipe','pipe']});
 child.once('error',rejectPending);child.once('exit',code=>rejectPending(new Error('MCP process exited: '+code)));child.stdin.on('error',rejectPending);
 child.stderr.setEncoding('utf8');child.stderr.on('data',value=>stderr+=value);
 child.stdout.setEncoding('utf8');child.stdout.on('data',value=>{
  buffer+=value;
  try{while(buffer.includes('\n')){
   const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
   const json=JSON.parse(line);wire.push({direction:'response',json});const item=pending.get(json.id);
   if(item){clearTimeout(item.timer);pending.delete(json.id);item.resolve(json);}
  }}catch(error){rejectPending(error);}
 });
 await send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'reviewops-category-regression',version:'1'}});
 let catalog,reviewId;
 await scenario('QA-CAT-001','Discover category IDs and display names',async()=>{
  const listed=await send('tools/list',{}),create=listed.result.tools.find(item=>item.name==='reviewops_review_create');
  assert.match(create.inputSchema.properties.category.description,/ID/);print('CATEGORY INPUT SCHEMA '+JSON.stringify(create.inputSchema.properties.category));
  const result=await call('reviewops_review_categories_list',{projectId:a.id});assert.equal(result.isError,false);catalog=result.structuredContent;
  assert.equal(catalog.defaultCategory,'ux');assert.deepEqual(catalog.categories.find(item=>item.id===custom.id),{...custom,kind:'custom'});
  for(const kind of ['builtin','legacy','custom'])assert.ok(catalog.categories.some(item=>item.kind===kind));
 });
 await scenario('QA-CAT-002','Create with the custom ID returned by lookup',async()=>{
  const category=catalog.categories.find(item=>item.name==='연구').id;
  const result=await call('reviewops_review_create',{projectId:a.id,requestId:'category-custom',title:'사용자 분류 ID로 작성',body:'보존할 리뷰 본문',category});
  assert.equal(result.isError,false);assert.equal(result.structuredContent.review.category,category);reviewId=result.structuredContent.reviewId;
 });
 await scenario('QA-CAT-003','Reject a display name and explain ID lookup',async()=>{
  const result=await call('reviewops_review_create',{projectId:a.id,requestId:'category-invalid-name',title:'생성되면 안 되는 리뷰',category:'연구'});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/INVALID_INPUT.*reviewops_review_categories_list/);
 });
 await scenario('QA-CAT-004','Default an omitted create category to ux',async()=>{
  const result=await call('reviewops_review_create',{projectId:a.id,requestId:'category-default',title:'기본 분류 생략'});assert.equal(result.structuredContent.review.category,'ux');
 });
 await scenario('QA-CAT-005','Update with a builtin ID and preserve it when omitted',async()=>{
  const changed=await call('reviewops_review_update',{projectId:a.id,reviewId,category:'other'});assert.equal(changed.structuredContent.review.category,'other');
  const kept=await call('reviewops_review_update',{projectId:a.id,reviewId,body:'분류를 생략한 내용 수정'});assert.equal(kept.structuredContent.review.category,'other');
 });
 await scenario('QA-CAT-006','Reject an invalid update without changing saved details',async()=>{
  const invalid=await call('reviewops_review_update',{projectId:a.id,reviewId,category:'연구',body:'저장되면 안 되는 본문'});assert.equal(invalid.isError,true);
  const saved=await call('reviewops_review_get',{projectId:a.id,reviewId});assert.equal(saved.isError,false);assert.equal(saved.structuredContent.review.category,'other');assert.equal(saved.structuredContent.review.body,'분류를 생략한 내용 수정');
 });
 await scenario('QA-CAT-007','Reject a different project through the bound MCP',async()=>{
  const result=await call('reviewops_review_categories_list',{projectId:b.id});assert.equal(result.isError,true);assert.match(result.content[0].text,/TARGET_MISMATCH/);
 });
 await scenario('QA-CAT-008','Return the same catalog through the public bridge',async()=>{
  const payload={projectId:a.id};print('BRIDGE REQUEST\n'+JSON.stringify({action:'automation.reviewCategories.list',payload},null,2));
  const result=await invokeSocket(path.join(dataPath,'integrations/tools.json'),'automation.reviewCategories.list',payload);print('BRIDGE RESPONSE\n'+JSON.stringify(result,null,2));assert.deepEqual(result.categories,catalog.categories);
 });
 const snapshot=await ipc('snapshot');assert.equal(snapshot.reviews.length,2);assert.equal(snapshot.reviews.some(item=>item.title==='생성되면 안 되는 리뷰'),false);assert.equal(stderr,'');
 print('PASS all '+checks.length+' public MCP category scenarios. Real model turns and installed-app update checks were not run.');
}catch(error){failure=error;print('FAIL '+error.message);throw error;}
finally{
 rejectPending(new Error('MCP regression finished'));child?.stdin.end();child?.kill();
 if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 fs.writeFileSync(path.join(output,'mcp-wire.jsonl'),wire.map(value=>JSON.stringify(value)).join('\n')+'\n');
 fs.writeFileSync(path.join(output,'transcript.txt'),transcript.join('\n')+'\n');
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:!failure,checks,version:appVersion,source:'source Electron with actual public MCP and local bridge',platform:process.platform,arch:process.arch,externalModels:'not executed',...(failure?{error:failure.message}:{})},null,2)+'\n');
 fs.rmSync(temporary,{recursive:true,force:true});
}
