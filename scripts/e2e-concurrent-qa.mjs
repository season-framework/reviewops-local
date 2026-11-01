import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {_electron as electron, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';

// Every app operation uses a disposable profile. Model calls are opt-in and use
// only the synthetic projects created below, through invocation-local MCP config.
const root=process.cwd(), temporary=fs.mkdtempSync('/tmp/rops-qa-');
const dataPath=path.join(temporary,'data'), home=path.join(temporary,'home');
const resultDir=path.resolve(process.env.REVIEWOPS_QA_RESULTS||path.join(root,'test-results/issue-24-concurrent-qa'));
const executable=process.env.REVIEWOPS_TEST_EXECUTABLE;
for(const directory of [dataPath,home,resultDir])fs.mkdirSync(directory,{recursive:true});
const runtime=isolatedModelRuntime({home,dataPath});
const sshConfig=path.join(home,'.ssh/config');fs.mkdirSync(path.dirname(sshConfig),{recursive:true});fs.writeFileSync(sshConfig,'# Isolated QA profile\n');
const connection=path.join(dataPath,'integrations/tools.json'),mcpScript=path.resolve(process.env.REVIEWOPS_MCP_SCRIPT||path.join(root,'electron/mcp-server.cjs'));
const finish=path.join(temporary,'finish'),fixture=path.join(temporary,'fixture-codex');
fs.writeFileSync(fixture,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli qa-fixture');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
if(args[0]==='app-server'){const child=require('node:child_process').spawn(path.join(process.env.HOME,'.local/bin/codex'),args,{stdio:'inherit'});child.once('exit',code=>process.exit(code??1));return}
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const send=value=>console.log(JSON.stringify(value));send({type:'thread.started',thread_id:'qa-'+process.pid});send({type:'turn.started'});
 const complete=()=>{send({type:'item.completed',item:{type:'agent_message',text:'QA_FIXTURE_RESULT '+path.basename(process.cwd())}});send({type:'turn.completed'})};
 if(!input.includes('WAIT_FOR_QA')){setTimeout(complete,50);return}
 const deadline=setTimeout(()=>process.exit(2),180000),timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);clearTimeout(deadline);complete()}},30);
});
`,{mode:0o700});
const env={...process.env,...runtime,REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:sshConfig,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig};
for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY','CHATGPT_ACCESS_TOKEN','ANTHROPIC_API_KEY'])delete env[key];
const server=http.createServer((request,response)=>{
 const project=new URL(request.url,'http://qa.invalid').pathname.slice(1)||'unknown';
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
 const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>동시 QA ${project}</title><style>body{font:20px system-ui;margin:28px;min-height:2600px;background:${project.startsWith('A')?'#eff6ff':'#fff7ed'}}input,button{font:inherit;padding:10px}input{display:block;width:80%;margin:20px 0}.tail{margin-top:1500px}</style></head><body><h1>프로젝트 ${project}</h1><label for="draft">QA 입력 ${project}</label><input id="draft" aria-label="QA 입력 ${project}"><button id="counter" onclick="document.querySelector('#count').textContent=++window.hits">클릭 ${project}</button><p>클릭 횟수: <span id="count">0</span></p><p>이 화면의 입력과 스크롤은 프로젝트 ${project}에만 적용됩니다.</p><a target="_blank" href="/${project}-popup">새 검사 화면</a><div class="tail">프로젝트 ${project} 스크롤 결과</div><script>window.hits=0;window.instance=crypto.randomUUID()</script></body></html>`;
 if(project.endsWith('-slow'))setTimeout(()=>response.end(html),1600);else response.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const checks=[],errors=[],calls=[],clients=[],live=[];
const report={ok:false,app:{executable:executable||'source',packaged:Boolean(executable)},checks,errors,calls,live,temporary,startedAt:new Date().toISOString()};
let app,main;
const passed=(name,details={})=>{checks.push({name,...details});console.log('PASS: '+name)};
const ipc=(page,action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const pane=page=>page.locator('.workspace-pane:not([hidden])');
const pages=()=>app.windows().filter(page=>!page.isClosed()&&page.url().startsWith('reviewops://app/'));
const projectPage=async id=>{
 await expect.poll(()=>pages().filter(page=>new URL(page.url()).searchParams.get('projectId')===id).length).toBe(1);
 const page=pages().find(page=>new URL(page.url()).searchParams.get('projectId')===id);
 await page.waitForFunction(()=>Boolean(window.reviewops?.invoke));
 await expect(page.locator('.workspace-app')).toHaveAttribute('data-window-project-id',id);
 return page;
};
const runProcess=(command,args,{processEnv=process.env,cwd=temporary,timeoutMs=180000,input}={})=>new Promise((resolve,reject)=>{
 const child=spawn(command,args,{cwd,env:processEnv,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',streamBuffer='';const startedAt=new Date().toISOString(),streamEvents=[];
 const timer=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),1000).unref();reject(new Error(`${path.basename(command)} timed out`))},timeoutMs);
 child.stdout.on('data',chunk=>{stdout+=chunk;streamBuffer+=chunk;let end;while((end=streamBuffer.indexOf('\n'))>=0){const line=streamBuffer.slice(0,end);streamBuffer=streamBuffer.slice(end+1);try{const event=JSON.parse(line);streamEvents.push({at:new Date().toISOString(),type:event.type,itemType:event.item?.type,tool:event.item?.tool,status:event.item?.status,error:event.item?.error})}catch{}}});child.stderr.on('data',chunk=>stderr+=chunk);
 child.once('error',error=>{clearTimeout(timer);reject(error)});
 child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr,startedAt,finishedAt:new Date().toISOString(),streamEvents})});
 child.stdin.end(input||'');
});

class McpClient {
 constructor(projectId,label){
  this.label=label;this.projectId=projectId;this.next=0;this.pending=new Map();this.stderr='';this.buffer='';
  this.child=spawn(process.execPath,[mcpScript,'--connection',connection,...(projectId?['--project-id',projectId]:[])],{env,stdio:['pipe','pipe','pipe']});
  this.child.stderr.on('data',chunk=>this.stderr+=chunk);
  this.child.stdout.on('data',chunk=>{
   this.buffer+=chunk;let end;
   while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(!line.trim())continue;
    let value;try{value=JSON.parse(line)}catch{this.abort(new Error('MCP stdout contains non-JSON output'));continue}
    const pending=this.pending.get(value.id);if(pending){this.pending.delete(value.id);clearTimeout(pending.timer);value.error?pending.reject(new Error(JSON.stringify(value.error))):pending.resolve(value.result)}
   }
  });
  this.child.once('error',error=>this.abort(error));
  this.child.once('exit',code=>this.abort(new Error(`MCP exited: ${code}; ${this.stderr}`)));
  clients.push(this);
 }
 abort(error){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error)}this.pending.clear()}
 request(method,params){return new Promise((resolve,reject)=>{
  const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('MCP response timeout: '+method))},45000);
  this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 })}
 async initialize(){const result=await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:this.label,version:'1'}});assert.ok(result.serverInfo);this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return result}
 async raw(name,args){return this.request('tools/call',{name:'reviewops_'+name,arguments:args})}
 async call(name,args={}){
  const started=Date.now(),result=await this.raw(name,args);const item={client:this.label,tool:name,projectId:args.projectId,windowId:args.windowId,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),ok:!result.isError};calls.push(item);
  if(result.isError)throw new Error(`${name}: ${result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')}`);
  const text=result.content?.find(item=>item.type==='text')?.text;
  let data=result.structuredContent;if(data===undefined&&text){try{data=JSON.parse(text)}catch{data={text}}}
  const image=result.content?.find(item=>item.type==='image');if(image)data={...data,data:image.data,mimeType:image.mimeType};
  return data;
 }
 close(){this.child.stdin.end();this.child.kill('SIGTERM')}
}
const center=element=>{assert.ok(element?.rect,'Target element is missing');return {x:Math.round(element.rect.x+element.rect.width/2),y:Math.round(element.rect.y+element.rect.height/2)}};
const binding=session=>({sessionId:session.sessionId,projectId:session.projectId,windowId:session.windowId});
const saveCapture=async(client,target,name)=>{
 const capture=await client.call('qa_capture',target);const bytes=Buffer.from(capture.data||capture.dataUrl?.split(',')[1]||'','base64');
 assert.ok(bytes.length>3000);assert.equal(bytes.subarray(1,4).toString(),'PNG');fs.writeFileSync(path.join(resultDir,name+'.png'),bytes);
 return {name:name+'.png',width:capture.width,height:capture.height,bytes:bytes.length};
};
const snapshot=async target=>app.evaluate(({BrowserWindow},{url})=>{
 const candidates=new Map();
 for(const window of BrowserWindow.getAllWindows())if(window.isVisible()){
  if(window.webContents.getURL()===url)candidates.set(window.webContents.id,window.webContents);
  for(const view of window.contentView.children)if(view.webContents?.getURL()===url)candidates.set(view.webContents.id,view.webContents);
 }
 if(candidates.size!==1)throw new Error(`Expected one visible fixture page, found ${candidates.size}`);
 const contents=[...candidates.values()][0];
 return contents.executeJavaScript('({draft:document.querySelector("#draft").value,hits:window.hits,scrollY,instance:window.instance,activeElement:document.activeElement?.id,hasFocus:document.hasFocus()})');
},{url:target});
const focused=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getFocusedWindow()?.id??null);

try{
 app=await electron.launch({args:executable?[]:[root],...(executable?{executablePath:executable}:{}),env,timeout:30000});
 main=await app.firstWindow();app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));main.on('pageerror',error=>errors.push(error.message));
 await setTestLocale(main);await ipc(main,'update.configure',{automatic:false});
 report.app={...report.app,...await ipc(main,'app.info')};delete report.app.dataPath;
 await expect.poll(()=>fs.existsSync(connection)).toBe(true);
 const group=await ipc(main,'group.save',{name:'동시 QA 검사'}),projects={},reviews={};
 for(const name of ['A','B']){
  const work=path.join(temporary,name);fs.mkdirSync(work);
  projects[name]=await ipc(main,'project.save',{groupId:group.id,name:'동시 QA 프로젝트 '+name,connection:{kind:'local',rootPath:work,viewerUrl:origin+'/'+name,agentEnabled:true,agentBinary:fixture,agentModel:'fixture-model'}});
 }
 const admin=new McpClient(null,'qa-admin'),a=new McpClient(projects.A.id,'qa-A'),b=new McpClient(projects.B.id,'qa-B');
 await Promise.all([admin.initialize(),a.initialize(),b.initialize()]);
 const tools=await admin.request('tools/list',{});assert.ok(tools.tools.some(item=>item.name==='reviewops_qa_open'));
 const listed=await a.call('projects_list');assert.equal(JSON.stringify(listed).includes(projects.B.id),false);
 const rejected=await a.raw('reviews_list',{projectId:projects.B.id});assert.equal(rejected.isError,true);
 passed('MCP 연결과 도구 목록, 연결한 프로젝트 밖의 요청 거부');
 for(const [name,client]of [['A',a],['B',b]]){
  const created=await client.call('review_create',{projectId:projects[name].id,requestId:'qa-create-'+name,title:'MCP 리뷰 '+name,body:'MCP 입력 '+name});
  reviews[name]=created.review||created;assert.ok(reviews[name].id||created.reviewId);if(!reviews[name].id)reviews[name].id=created.reviewId;
 }
 const [openedA,openedB]=await Promise.all([
  a.call('qa_open',{projectId:projects.A.id,reviewId:reviews.A.id,clientId:'qa-A'}),
  b.call('qa_open',{projectId:projects.B.id,reviewId:reviews.B.id,clientId:'qa-B'})
 ]);
 const targetA=binding(openedA),targetB=binding(openedB);assert.notEqual(targetA.windowId,targetB.windowId);
 const pageA=await projectPage(projects.A.id),pageB=await projectPage(projects.B.id);
 await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows())if(win.webContents.getURL().startsWith('reviewops://app/'))win.setContentSize(1500,950)});
 assert.equal(pages().length,3);report.projects={A:{projectId:projects.A.id,reviewId:reviews.A.id,windowId:targetA.windowId},B:{projectId:projects.B.id,reviewId:reviews.B.id,windowId:targetB.windowId}};
 passed('프로젝트별 창 동시 생성과 프로젝트·리뷰·창 연결',report.projects);
 const busy=await b.raw('qa_open',{projectId:projects.B.id,clientId:'different-client'});assert.equal(busy.isError,true);
 const foreign=await admin.raw('qa_state',{...targetA,windowId:targetB.windowId});assert.equal(foreign.isError,true);
 passed('다른 조작자의 창 연결과 잘못 조합한 창 ID 거부');
 async function browserTarget(client,target,url){
  let state;await expect.poll(async()=>{state=await client.call('qa_state',target);return state.browsers?.some(item=>item.url===url&&item.visible)}).toBe(true);
  return {...target,browserId:state.browsers.find(item=>item.url===url&&item.visible).browserId};
 }
 const browserA=await browserTarget(a,targetA,origin+'/A'),browserB=await browserTarget(b,targetB,origin+'/B');
 const initialB=await snapshot(origin+'/B');
 async function inputRound(client,target,value){
  const state=await client.call('qa_state',target);const input=state.elements.find(item=>item.tag?.toLowerCase()==='input'&&item.type!=='hidden');
  await client.call('qa_click',{...target,...center(input)});await client.call('qa_key',{...target,key:'a',modifiers:['Meta']});await client.call('qa_type',{...target,text:value});
  const after=await client.call('qa_state',target),button=after.elements.find(item=>item.tag?.toLowerCase()==='button'&&item.text?.includes('클릭'));
  await client.call('qa_click',{...target,...center(button)});
 }
 const sentinel=main.getByLabel('리뷰 제목·분류 검색',{exact:true});await sentinel.fill('MAIN_INPUT_UNCHANGED');
 const mainInput=()=>main.evaluate(()=>({label:document.activeElement?.getAttribute('aria-label'),value:document.activeElement?.value}));
 const expectedMainInput=await mainInput();assert.equal(expectedMainInput.value,'MAIN_INPUT_UNCHANGED');
 await app.evaluate(({BrowserWindow})=>{globalThis.qaFocusEvents=[];for(const window of BrowserWindow.getAllWindows())for(const event of ['focus','blur'])window.on(event,()=>globalThis.qaFocusEvents.push({id:window.id,event,url:window.webContents.isDestroyed()?'closed':window.webContents.getURL()}))});
 const focusBefore=await focused(),overlapStarted=Date.now();
 await Promise.all([inputRound(a,browserA,'PROJECT_A_ONLY'),inputRound(b,browserB,'PROJECT_B_ONLY')]);
 const [valueA,valueB]=await Promise.all([snapshot(origin+'/A'),snapshot(origin+'/B')]);
 report.initialInput={valueA,valueB};
 report.focus={before:focusBefore,after:await focused(),events:await app.evaluate(()=>globalThis.qaFocusEvents)};
 assert.equal(valueA.draft,'PROJECT_A_ONLY');assert.equal(valueB.draft,'PROJECT_B_ONLY');assert.equal(valueA.hits,1);assert.equal(valueB.hits,1);assert.ok(!report.focus.events.some(event=>event.event==='focus'),'QA must not focus a native window');assert.deepEqual(await mainInput(),expectedMainInput);
 const overlapCalls=calls.filter(item=>Date.parse(item.startedAt)>=overlapStarted);assert.ok(overlapCalls.some(x=>overlapCalls.some(y=>x.client!==y.client&&Date.parse(x.startedAt)<Date.parse(y.finishedAt)&&Date.parse(y.startedAt)<Date.parse(x.finishedAt))));
 report.screenshots=await Promise.all([saveCapture(a,targetA,'01-project-A-input'),saveCapture(b,targetB,'02-project-B-input'),saveCapture(a,browserA,'03-browser-A-input'),saveCapture(b,browserB,'04-browser-B-input')]);
 passed('두 MCP 클라이언트의 동시 클릭·입력, 홈 입력 대상 유지, 다른 창 표시 없음');
 await Promise.all([a.call('qa_scroll',{...browserA,x:100,y:200,deltaY:620}),b.call('qa_scroll',{...browserB,x:100,y:200,deltaY:340})]);
 await expect.poll(async()=>(await snapshot(origin+'/A')).scrollY).toBeGreaterThan(300);
 await expect.poll(async()=>(await snapshot(origin+'/B')).scrollY).toBeGreaterThan(100);
 assert.notEqual((await snapshot(origin+'/A')).scrollY,(await snapshot(origin+'/B')).scrollY);
 passed('프로젝트별 스크롤 동시 적용');
 const focusForData=await focused();
 const [updated,run]=await Promise.all([
  b.call('review_update',{projectId:projects.B.id,reviewId:reviews.B.id,title:'MCP 수정 리뷰 B',body:'B만 변경'}),
  a.call('run_start',{projectId:projects.A.id,reviewId:reviews.A.id,requestId:'qa-run-A',prompt:'WAIT_FOR_QA A'})
 ]);
 assert.ok(updated);assert.equal(await focused(),focusForData);
 const runA=run.run||run;const runId=runA.id||run.runId;assert.ok(runId);
 const quickB=await b.call('run_start',{projectId:projects.B.id,reviewId:reviews.B.id,requestId:'qa-run-B',prompt:'QUICK_QA B'});const runBId=(quickB.run||quickB).id||quickB.runId;
 let doneB;await expect.poll(async()=>{doneB=await b.call('run_get',{projectId:projects.B.id,reviewId:reviews.B.id,runId:runBId});return (doneB.run||doneB).status}).toBe('completed');
 const waitingA=await a.call('run_get',{projectId:projects.A.id,reviewId:reviews.A.id,runId});assert.equal((waitingA.run||waitingA).status,'running');assert.match(JSON.stringify(doneB),/QA_FIXTURE_RESULT B/);
 const cross=await admin.raw('run_get',{projectId:projects.A.id,reviewId:reviews.A.id,runId:runBId});assert.equal(cross.isError,true);
 assert.equal((await snapshot(origin+'/B')).draft,'PROJECT_B_ONLY');assert.equal(await focused(),focusForData);
 passed('화면 QA 중 MCP 리뷰 수정·작업 요청·결과 조회, 작업과 결과의 프로젝트 분리');
 let navigationFinished=false;
 const navigation=a.call('qa_navigate',{...browserA,url:origin+'/A-slow'}).then(value=>{navigationFinished=true;return value});
 await b.call('qa_capture',browserB);assert.equal(navigationFinished,false,'B capture must finish while A page is loading');
 await navigation;assert.match((await a.call('qa_state',browserA)).title,/A-slow/);
 await a.call('qa_navigate',{...browserA,url:origin+'/A'});assert.match((await a.call('qa_state',browserA)).title,/QA A$/);
 assert.equal((await snapshot(origin+'/B')).draft,'PROJECT_B_ONLY');
 passed('A의 느린 페이지 이동 중 B 촬영 완료, 이동 응답 이후 새 페이지 표시');
 const beforePopup=await app.evaluate(()=>globalThis.qaFocusEvents.length);
 const popupLink=(await a.call('qa_state',browserA)).elements.find(item=>item.tag==='a'&&item.text==='새 검사 화면');
 await a.call('qa_click',{...browserA,...center(popupLink)});
 const popupA=await browserTarget(a,targetA,origin+'/A-popup');
 await inputRound(a,popupA,'POPUP_A_ONLY');assert.equal((await snapshot(origin+'/A-popup')).draft,'POPUP_A_ONLY');assert.equal((await snapshot(origin+'/B')).draft,'PROJECT_B_ONLY');
 assert.ok(!(await app.evaluate(()=>globalThis.qaFocusEvents)).slice(beforePopup).some(event=>event.event==='focus'));
 report.screenshots.push(await saveCapture(a,popupA,'06-project-A-popup'));
 passed('새 검사 창도 프로젝트 A에 연결하고 B 입력과 창 표시 유지');
 await pane(pageB).getByRole('tab',{name:'작업이력',exact:true}).click();
 const draftB=pane(pageB).locator('.original-review-composer').getByLabel('작업 내용',{exact:true});await draftB.fill('B 창에서 작성 중인 내용');
 const beforeReloadB=await snapshot(origin+'/B');
 await a.call('qa_reload',targetA);await pageA.waitForFunction(()=>Boolean(window.reviewops?.invoke));
 await expect(draftB).toHaveValue('B 창에서 작성 중인 내용');assert.deepEqual(await snapshot(origin+'/B'),beforeReloadB);
 await a.call('qa_close',targetA);await expect.poll(()=>pageA.isClosed()).toBe(true);
 await expect(draftB).toHaveValue('B 창에서 작성 중인 내용');assert.equal((await snapshot(origin+'/B')).instance,initialB.instance);
 report.screenshots.push(await saveCapture(b,targetB,'05-project-B-after-A-closed'));
 passed('A 창 새로고침·종료 후 B 창의 화면·입력·초안 유지');
 fs.writeFileSync(finish,'done');
 await expect.poll(async()=>{const value=await a.call('run_get',{projectId:projects.A.id,reviewId:reviews.A.id,runId});return (value.run||value).status}).toBe('completed');
 passed('창을 종료한 프로젝트의 진행 중 작업 완료와 결과 조회');
 await b.call('qa_release',targetB);
 // Live external-client checks are deliberately separate from synthetic runs.
 if(process.env.REVIEWOPS_LIVE_CLAUDE){
  const claude=process.env.REVIEWOPS_LIVE_CLAUDE,claudeHome=path.join(temporary,'claude-config');fs.mkdirSync(claudeHome);
  const version=(await runProcess(claude,['--version'],{timeoutMs:15000})).stdout.trim();
  const config=JSON.stringify({type:'stdio',command:process.execPath,args:[mcpScript,'--connection',connection,'--project-id',projects.B.id]});
  const claudeEnv={...process.env,CLAUDE_CONFIG_DIR:claudeHome};delete claudeEnv.ELECTRON_RUN_AS_NODE;
  const add=await runProcess(claude,['mcp','add-json','reviewops',config,'--scope','user'],{processEnv:claudeEnv});assert.equal(add.code,0,add.stderr);
  const health=await runProcess(claude,['mcp','get','reviewops'],{processEnv:claudeEnv,timeoutMs:30000});
  fs.writeFileSync(path.join(resultDir,'live-claude-mcp.txt'),health.stdout+'\n'+health.stderr);assert.equal(health.code,0);assert.match(health.stdout,/Connected|connected|연결/);
  const auth=await runProcess(claude,['auth','status'],{timeoutMs:15000});let authState;try{authState=JSON.parse(auth.stdout)}catch{authState={loggedIn:false}}
  live.push({client:'Claude Code',version,mcpConnected:true,loggedIn:Boolean(authState.loggedIn),modelQa:authState.loggedIn?'not_run':'blocked_no_auth'});
  passed('실제 Claude Code의 MCP 서버 연결 검사',{modelQa:authState.loggedIn?'not_run':'blocked_no_auth'});
 }
 if(process.env.REVIEWOPS_LIVE_CODEX==='1'){
  const codexBinary=process.env.REVIEWOPS_CODEX_BINARY||'codex',version=(await runProcess(codexBinary,['--version'],{timeoutMs:15000})).stdout.trim();
  const promptFor=(name)=>`Use only reviewops MCP tools. Your assigned projectId is ${projects[name].id}. This synthetic project was created specifically for this user-authorized QA; only the operations in this prompt are authorized. Call projects_list, reviews_list, and review_get for reviewId ${reviews[name].id}. Open QA with clientId live-codex-${name} and that review. Use qa_state to find its visible browser. Within that browser scroll up 2000 pixels first, then inspect state, click the input element using its rectangle, press Meta+a, type LIVE_CODEX_${name}, click the button once. Capture the browser and the whole ReviewOps window with the input value visible. Then scroll down 240 pixels, verify state, and release the QA session. Do not navigate to another project, use shell, edit files, close windows, or start agent runs. Return the assigned project/window IDs and observed input value.`;
  const executions=await Promise.all(['A','B'].map(async name=>{
   const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--approve-for-me','--json','-C',path.join(temporary,name),'-c',`mcp_servers.reviewops.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.reviewops.args=${JSON.stringify([mcpScript,'--connection',connection,'--project-id',projects[name].id])}`,'-'];
   const value=await runProcess(codexBinary,args,{input:promptFor(name),timeoutMs:240000});
   fs.writeFileSync(path.join(resultDir,'live-codex-'+name+'.jsonl'),value.stdout);fs.writeFileSync(path.join(resultDir,'live-codex-'+name+'.stderr.txt'),value.stderr);
   const events=value.stdout.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);
   const completed=events.filter(event=>event.item?.type==='mcp_tool_call'&&event.item.status==='completed');
   const opened=completed.find(event=>event.item.tool==='reviewops_qa_open')?.item?.result?.content?.find(item=>item.type==='text')?.text;
   let session;try{session=JSON.parse(opened)}catch{}
   const captures=[];
   for(const event of completed.filter(event=>event.item.tool==='reviewops_qa_capture')){
    const capture=event.item.result?.content?.find(item=>item.type==='image');if(!capture)continue;
    let metadata;try{metadata=JSON.parse(event.item.result.content.find(item=>item.type==='text').text)}catch{}
    const filename='live-codex-'+name+'-'+(metadata?.browserId?'browser':'window')+'-'+captures.length+'.png';fs.writeFileSync(path.join(resultDir,filename),Buffer.from(capture.data,'base64'));captures.push({filename,...metadata});
   }
   const calls=value.streamEvents.filter(event=>event.itemType==='mcp_tool_call');
   assert.equal(value.code,0,`Codex ${name} failed: ${value.stderr.slice(-1500)}`);assert.ok(calls.some(item=>item.tool==='reviewops_qa_type'&&item.status==='completed'),`Codex ${name} did not type through MCP`);
   return {client:'Codex',version,project:name,...value,stdout:undefined,stderr:undefined,calls,session,captures};
  }));
  live.push(...executions);assert.ok(Date.parse(executions[0].startedAt)<Date.parse(executions[1].finishedAt)&&Date.parse(executions[1].startedAt)<Date.parse(executions[0].finishedAt));
  const spans=executions.map(execution=>{const events=execution.calls.filter(item=>item.tool?.startsWith('reviewops_qa_'));return{project:execution.project,first:Date.parse(events[0].at),last:Date.parse(events.at(-1).at)}});
  assert.ok(spans[0].first<spans[1].last&&spans[1].first<spans[0].last,'Actual Codex QA tool sequences must overlap');
  report.liveQaOverlapMs=Math.min(spans[0].last,spans[1].last)-Math.max(spans[0].first,spans[1].first);
  for(const name of ['A','B'])assert.equal((await snapshot(origin+'/'+name)).draft,'LIVE_CODEX_'+name);
  passed('실제 Codex 두 실행의 동시 MCP 화면 조작과 프로젝트별 입력 분리');
 }
 assert.deepEqual(errors,[]);report.ok=true;report.finishedAt=new Date().toISOString();console.log(JSON.stringify({ok:true,checks:checks.length,resultDir}));
}catch(error){report.error=error.stack||error.message;for(const page of app?pages():[])await page.screenshot({path:path.join(resultDir,'failure-'+(new URL(page.url()).searchParams.get('projectId')||'main')+'.png')}).catch(()=>{});console.error('CONCURRENT_QA_FAILURE',error);throw error}
finally{
 fs.writeFileSync(finish,'done');for(const client of clients)client.close();
 fs.writeFileSync(path.join(resultDir,'results.json'),JSON.stringify(report,null,2));
 if(app){const timer=setTimeout(()=>app.process()?.kill('SIGKILL'),7000);try{await app.evaluate(({app,BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();app.exit(0)}).catch(()=>{});await app.close().catch(()=>{})}finally{clearTimeout(timer)}}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
