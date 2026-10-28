import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';

const root=process.cwd(),testRoot=fs.mkdtempSync('/tmp/reviewops-parallel-'),home=path.join(testRoot,'home'),dataPath=path.join(testRoot,'data'),results=path.join(root,'test-results');
const works={A:path.join(testRoot,'A'),B:path.join(testRoot,'B')},binary=path.join(testRoot,'fixture-codex'),requestLog=path.join(testRoot,'requests.jsonl');
const finishA=path.join(testRoot,'finish-A'),finishB=path.join(testRoot,'finish-B'),client=path.join(root,'skills/reviewops/scripts/reviewops.mjs');
for(const directory of [home,dataPath,results,...Object.values(works)])fs.mkdirSync(directory,{recursive:true});
const sshConfig=path.join(home,'.ssh/config');fs.mkdirSync(path.dirname(sshConfig),{recursive:true});fs.writeFileSync(sshConfig,'# No SSH hosts in this fixture\n');
const runtime=isolatedModelRuntime({home,dataPath});
fs.writeFileSync(binary,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli parallel-fixture');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
if(args[0]==='app-server'){const child=require('node:child_process').spawn(path.join(process.env.HOME,'.local/bin/codex'),args,{stdio:'inherit'});child.once('exit',code=>process.exit(code??1));return}
let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(requestLog)},JSON.stringify({args,input,cwd:process.cwd(),pid:process.pid})+'\\n');
 const send=value=>console.log(JSON.stringify(value));send({type:'thread.started',thread_id:'parallel-'+process.pid});send({type:'turn.started'});
 const finish=()=>{send({type:'item.completed',item:{type:'agent_message',text:'FIXTURE_DONE '+path.basename(process.cwd())}});send({type:'turn.completed'});};
 const marker=input.includes('WAIT_A')?${JSON.stringify(finishA)}:input.includes('WAIT_B')?${JSON.stringify(finishB)}:'';
 if(!marker){setTimeout(finish,60);return}
 const deadline=setTimeout(()=>process.exit(2),120000),timer=setInterval(()=>{if(fs.existsSync(marker)){clearInterval(timer);clearTimeout(deadline);finish()}},30);
});
`,{mode:0o700});
const server=http.createServer((request,response)=>{
 const name=new URL(request.url,'http://fixture.invalid').pathname.slice(1)||'empty';
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
 response.end(`<!doctype html><title>Fixture ${name}</title><h1>Fixture ${name}</h1><input id="draft" aria-label="Browser draft"><script>window.fixtureInstance=crypto.randomUUID()</script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const env={...process.env,...runtime,REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:sshConfig,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig};
for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY','CHATGPT_ACCESS_TOKEN'])delete env[key];
const checks=[],errors=[],report={ok:false,checks,errors,testRoot,accountOperations:0,sshOperations:0,modelRequests:0};
let app,main,a,b,projectA,projectB,reviewA,reviewB;
const passed=name=>{checks.push(name);console.log('PASS: '+name)};
const ipc=(page,action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const pane=page=>page.locator('.workspace-pane:not([hidden])');
const agent=page=>pane(page).locator('.agent-panel').last();
const historyDraft=page=>pane(page).locator('.original-review-composer').getByLabel('작업 내용',{exact:true});
const appPages=()=>app.windows().filter(page=>!page.isClosed()&&page.url().startsWith('reviewops://app/'));
const recorded=()=>fs.existsSync(requestLog)?fs.readFileSync(requestLog,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
function external(command,payload={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[client,command,'--data-dir',dataPath],{env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';const timeout=setTimeout(()=>{child.kill();reject(new Error('External fixture client timed out'))},35000);
  child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
  child.once('error',error=>{clearTimeout(timeout);reject(error)});
  child.once('exit',code=>{clearTimeout(timeout);try{const result=JSON.parse(stdout.trim()||stderr.trim());assert.equal(code,0,JSON.stringify(result));assert.equal(result.ok,true,JSON.stringify(result));resolve(result.data)}catch(error){reject(error)}});
  child.stdin.end(JSON.stringify(payload));
 });
}
async function projectPage(project) {
 await expect.poll(()=>appPages().filter(page=>new URL(page.url()).searchParams.get('projectId')===project.id).length).toBe(1);
 const page=appPages().find(page=>new URL(page.url()).searchParams.get('projectId')===project.id);
 await page.waitForFunction(()=>Boolean(window.reviewops?.invoke));if(await page.locator('html').getAttribute('lang')!=='ko')await setTestLocale(page);
 await app.evaluate(({BrowserWindow},id)=>{const host=BrowserWindow.getAllWindows().find(window=>{try{return new URL(window.webContents.getURL()).searchParams.get('projectId')===id}catch{return false}});host.setContentSize(1600,1050)},project.id);
 await expect(page.locator('.workspace-app')).toHaveAttribute('data-window-project-id',project.id);
 return page;
}
async function showProject(page,project){await page.getByRole('tablist',{name:'작업 탭',exact:true}).getByRole('tab',{name:project.name,exact:true}).last().click()}
async function openAgent(page){await pane(page).getByRole('tab',{name:'에이전트',exact:true}).click();await expect(agent(page).getByLabel('에이전트 작업 요청',{exact:true})).toBeVisible()}
async function openHistory(page){await pane(page).getByRole('tab',{name:'작업이력',exact:true}).click();await expect(historyDraft(page)).toBeVisible()}
async function send(page,review,prompt){await agent(page).getByLabel('에이전트 작업 요청',{exact:true}).fill(prompt);await agent(page).getByRole('button',{name:'작업 요청',exact:true}).click();await expect.poll(async()=>(await ipc(page,'agent.list',{reviewId:review.id})).find(run=>run.prompt===prompt)?.id).toBeTruthy();return (await ipc(page,'agent.list',{reviewId:review.id})).find(run=>run.prompt===prompt)}
async function nativeId(suffix){await expect.poll(()=>app.evaluate(({webContents},url)=>webContents.getAllWebContents().filter(contents=>contents.getURL()===url).length,origin+suffix)).toBe(1);return app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(contents=>contents.getURL()===url).id,origin+suffix)}
const native=(id,expression)=>app.evaluate(({webContents},{id,expression})=>webContents.fromId(id).executeJavaScript(expression,true),{id,expression});
async function setDialogAnswers(answers){await app.evaluate(({dialog},answers)=>{globalThis.parallelDialogs=[];globalThis.parallelAnswers=answers;dialog.showMessageBoxSync=(host,options)=>{globalThis.parallelDialogs.push({windowId:host.id,title:options.title,message:options.message});return globalThis.parallelAnswers.shift()??0}},answers)}

try{
 app=await electron.launch({args:[root],env,timeout:30000});main=await app.firstWindow();
 app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));main.on('pageerror',error=>errors.push(error.message));
 await setTestLocale(main);await ipc(main,'update.configure',{automatic:false});
 await app.evaluate(({app,webContents,session},origin)=>{
  globalThis.parallelBlockedRequests=[];const sessions=new Set();
  const install=value=>{if(sessions.has(value))return;sessions.add(value);value.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,reply)=>{const allowed=new URL(details.url).origin===origin;if(!allowed)globalThis.parallelBlockedRequests.push(details.url);reply({cancel:!allowed})})};
  install(session.defaultSession);for(const contents of webContents.getAllWebContents())install(contents.session);app.on('web-contents-created',(_event,contents)=>install(contents.session));
 },origin);
 assert.equal((await main.evaluate(()=>window.accountManager.getState())).accounts.length,0);
 await expect.poll(()=>fs.existsSync(path.join(dataPath,'integrations/tools.json'))).toBe(true);
 const group=await ipc(main,'group.save',{name:'병렬 프로젝트 검사'});
 const makeProject=(name)=>ipc(main,'project.save',{groupId:group.id,name:'프로젝트 '+name,connection:{kind:'local',rootPath:works[name],viewerUrl:origin+'/'+name,agentEnabled:true,agentBinary:binary,agentModel:'fixture-model'}});
 projectA=await makeProject('A');projectB=await makeProject('B');
 const listed=await external('list');assert.deepEqual(listed.map(project=>project.id).sort(),[projectA.id,projectB.id].sort());assert.ok(listed.every(project=>project.kind==='local'));
 passed('격리된 설정과 외부 JSON 클라이언트로 로컬 프로젝트 목록 조회');

 const requestA={requestId:'parallel-open-A',projectId:projectA.id,title:'외부 리뷰 A',body:'A_BODY',tool:'fixture-A'},requestB={requestId:'parallel-open-B',projectId:projectB.id,title:'외부 리뷰 B',body:'B_BODY',tool:'fixture-B'};
 const [openedA,openedB]=await Promise.all([external('open',requestA),external('open',requestB)]);
 assert.equal(openedA.shown,true);assert.equal(openedB.shown,true);assert.notEqual(openedA.windowId,openedB.windowId);
 a=await projectPage(projectA);b=await projectPage(projectB);assert.equal(appPages().length,3);
 reviewA=(await ipc(main,'snapshot')).reviews.find(review=>review.id===openedA.reviewId);reviewB=(await ipc(main,'snapshot')).reviews.find(review=>review.id===openedB.reviewId);
 for(const [page,project,review,opened] of [[a,projectA,reviewA,openedA],[b,projectB,reviewB,openedB]]){
  assert.equal(new URL(page.url()).searchParams.get('projectId'),project.id);assert.equal(new URL(page.url()).searchParams.get('windowId'),String(opened.windowId));
  assert.equal((await ipc(page,'window.context')).projectId,project.id);await expect(pane(page).locator('.original-project')).toHaveAttribute('data-review-id',review.id);await expect(pane(page)).toContainText(review.title);await expect(page).toHaveTitle(project.name+' · ReviewOps');
 }
 passed('동시 외부 요청마다 별도 프로젝트 창을 열고 해당 리뷰 표시');

 const duplicate=await external('open',requestA);assert.equal(duplicate.reviewId,reviewA.id);
 const followup=await external('open',{requestId:'parallel-next-A',projectId:projectA.id,title:'후속 리뷰 A',body:'A_NEXT',tool:'fixture-A'});
 assert.equal(followup.windowId,openedA.windowId);assert.equal(appPages().length,3);
 await external('open',{requestId:'parallel-return-A',projectId:projectA.id,reviewId:reviewA.id,tool:'fixture-A'});
 assert.equal((await external('status',{requestId:requestA.requestId})).status,'shown');
 assert.equal((await ipc(main,'snapshot')).reviews.filter(review=>review.title===requestA.title).length,1);
 passed('같은 요청 ID는 리뷰를 중복 생성하지 않고 같은 프로젝트는 기존 창 사용');

 for(const [page,review] of [[a,reviewA],[b,reviewB]]){await page.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();await page.locator(`[data-tree-node="r-${review.id}"]`).click()}
 const keys=await a.evaluate(({a,b})=>({a:localStorage.getItem(`reviewops.home.project.${a}.selected`),b:localStorage.getItem(`reviewops.home.project.${b}.selected`),tabsA:JSON.parse(localStorage.getItem(`reviewops.workspace.tabs.project.${a}`)),tabsB:JSON.parse(localStorage.getItem(`reviewops.workspace.tabs.project.${b}`)),main:localStorage.getItem('reviewops.home.selected')}),{a:projectA.id,b:projectB.id});
 assert.equal(keys.a,reviewA.id);assert.equal(keys.b,reviewB.id);assert.equal(keys.main,null);assert.ok(keys.tabsA.filter(tab=>tab.kind==='project').every(tab=>tab.entityId===projectA.id));assert.ok(keys.tabsB.filter(tab=>tab.kind==='project').every(tab=>tab.entityId===projectB.id));
 await a.locator(`[data-tree-node="r-${reviewB.id}"]`).click();await expect(pane(b).locator('.original-project')).toHaveAttribute('data-review-id',reviewB.id);await expect(a.locator('.work-home-detail')).toContainText(reviewA.title);assert.equal(appPages().length,3);
 await showProject(a,projectA);await showProject(b,projectB);
 passed('프로젝트별 탭·홈 선택 저장을 분리하고 다른 프로젝트 리뷰는 해당 창으로 전달');

 // The home action exercises App's cross-project create forwarding. Settings is
 // requested through the public window API because the home tree has no settings action.
 await ipc(main,'review.save',{...reviewB,status:'closed'});
 await a.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();
 const bTree=a.locator(`[data-tree-node="p-${projectB.id}"]`).locator('..').locator('..');
 await bTree.getByRole('button',{name:'리뷰 작성',exact:true}).click();
 await expect(pane(b).getByRole('button',{name:'등록 닫기',exact:true})).toBeVisible();
 await expect(pane(b).getByLabel('제목',{exact:true})).toHaveValue('');
 await expect(a.locator('.work-home-detail')).toContainText(reviewA.title);
 await pane(b).getByRole('button',{name:'등록 닫기',exact:true}).click();
 await ipc(a,'window.openProject',{projectId:projectB.id,section:'settings'});
 await expect(pane(b).getByLabel('프로젝트명',{exact:true})).toBeVisible();
 await expect(pane(b).getByLabel('프로젝트명',{exact:true})).toHaveValue(projectB.name);
 await b.reload();await expect(pane(b).getByLabel('프로젝트명',{exact:true})).toBeVisible();
 assert.equal((await ipc(b,'integration.pending')),null);
 await ipc(main,'review.save',{...reviewB,status:'open'});
 await external('open',{requestId:'parallel-after-navigation-B',projectId:projectB.id,reviewId:reviewB.id,tool:'fixture-B'});
 assert.equal(await ipc(b,'window.navigation'),null);
 await expect(pane(b).locator('.original-project')).toHaveAttribute('data-review-id',reviewB.id);
 await showProject(a,projectA);assert.equal(appPages().length,3);
 passed('A 창의 B 리뷰 작성과 설정 요청을 B 창에 표시하고 다시 불러와도 마지막 이동 유지');

 const surfaceA=pane(a).locator('.native-browser-surface'),surfaceB=pane(b).locator('.native-browser-surface');await expect(surfaceA).toHaveAttribute('data-browser-id',/.+/);await expect(surfaceB).toHaveAttribute('data-browser-id',/.+/);
 const browserA=await surfaceA.getAttribute('data-browser-id'),browserB=await surfaceB.getAttribute('data-browser-id'),contentsA=await nativeId('/A'),contentsB=await nativeId('/B');assert.notEqual(browserA,browserB);
 await native(contentsA,"localStorage.setItem('shared-origin-key','A');document.cookie='fixture=A;path=/';document.querySelector('#draft').value='browser A';");
 assert.equal(await native(contentsB,"localStorage.getItem('shared-origin-key')"),null);assert.equal(await native(contentsB,"document.cookie"),'');
 await native(contentsB,"localStorage.setItem('shared-origin-key','B');document.cookie='fixture=B;path=/';document.querySelector('#draft').value='browser B';");
 const bInstance=await native(contentsB,'window.fixtureInstance');assert.equal(await native(contentsA,"localStorage.getItem('shared-origin-key')"),'A');
 const foreign=await a.evaluate(id=>window.reviewops.request('browser.state',{id}),browserB);assert.equal(foreign.ok,false);
 await ipc(a,'browser.navigate',{id:browserA,url:origin+'/A-next'});await expect.poll(async()=>(await ipc(a,'browser.state',{id:browserA})).url).toBe(origin+'/A-next');assert.equal((await ipc(b,'browser.state',{id:browserB})).url,origin+'/B');assert.equal(await native(contentsB,"document.querySelector('#draft').value"),'browser B');
 passed('프로젝트별 브라우저 주소·입력·쿠키·저장값과 브라우저 ID 접근 분리');

 await openAgent(a);await openAgent(b);const draftA='A 작성 중 요청',draftB='B 작성 중 요청';
 await agent(a).getByLabel('에이전트 작업 요청',{exact:true}).fill(draftA);await agent(b).getByLabel('에이전트 작업 요청',{exact:true}).fill(draftB);
 await ipc(main,'review.save',{...reviewB,title:'외부에서 수정한 리뷰 B'});await expect(pane(b)).toContainText('외부에서 수정한 리뷰 B');await expect(agent(a).getByLabel('에이전트 작업 요청',{exact:true})).toHaveValue(draftA);await expect(agent(b).getByLabel('에이전트 작업 요청',{exact:true})).toHaveValue(draftB);
 passed('다른 창의 데이터 변경은 반영하면서 두 창의 작성 중 요청 유지');

 const runA=await send(a,reviewA,'WAIT_A'),quickB=await send(b,reviewB,'QUICK_B');await expect.poll(async()=>(await ipc(main,'agent.read',{id:quickB.id})).status).toBe('completed');assert.equal((await ipc(main,'agent.read',{id:runA.id})).status,'running');
 assert.ok(recorded().some(item=>item.input.includes('WAIT_A')&&item.cwd===fs.realpathSync(works.A)));assert.ok(recorded().some(item=>item.input.includes('QUICK_B')&&item.cwd===fs.realpathSync(works.B)));
 passed('A의 시험용 실행이 계속 진행되는 동안 B의 별도 실행 완료');

 const runB=await send(b,reviewB,'WAIT_B');await expect.poll(async()=>(await ipc(main,'agent.read',{id:runB.id})).status).toBe('running');
 await openHistory(a);await openHistory(b);await historyDraft(a).fill(draftA);await historyDraft(b).fill(draftB);
 // These drafts are local UI state; the running fixture keeps the two jobs open.
 await expect(a.locator('html')).toHaveAttribute('data-reviewops-dirty','true');await expect(b.locator('html')).toHaveAttribute('data-reviewops-dirty','true');
 await setDialogAnswers([1]);await a.reload();await expect(pane(a).locator('.original-project')).toHaveAttribute('data-project-id',projectA.id);await openHistory(a);
 await expect(historyDraft(a)).toHaveValue(draftA);await expect(historyDraft(b)).toHaveValue(draftB);assert.equal((await ipc(main,'agent.read',{id:runB.id})).status,'running');assert.equal(await native(contentsB,'window.fixtureInstance'),bInstance);assert.equal(await native(contentsB,"document.querySelector('#draft').value"),'browser B');
 passed('A 창을 다시 불러와도 B의 화면·브라우저 입력·초안·실행 유지');

 await setDialogAnswers([1]);await ipc(a,'window.close');await expect.poll(()=>a.isClosed()).toBe(true);assert.equal(appPages().length,2);assert.equal(b.isClosed(),false);await expect(historyDraft(b)).toHaveValue(draftB);assert.equal((await ipc(main,'agent.read',{id:runB.id})).status,'running');assert.equal(await native(contentsB,'window.fixtureInstance'),bInstance);
 passed('A 창만 닫으면 B 창과 실행은 계속 유지');

 const reopened=await external('open',{requestId:'parallel-reopen-A',projectId:projectA.id,reviewId:reviewA.id,tool:'fixture-A'});assert.notEqual(reopened.windowId,openedA.windowId);a=await projectPage(projectA);await openHistory(a);await expect(historyDraft(a)).toHaveValue(draftA);await expect(a.locator('html')).toHaveAttribute('data-reviewops-dirty','true');
 await setDialogAnswers([1,0]);await app.evaluate(({app})=>app.quit());await expect.poll(()=>app.evaluate(()=>globalThis.parallelDialogs.length)).toBe(2);assert.equal(appPages().length,3);assert.equal(a.isClosed(),false);assert.equal(b.isClosed(),false);await expect(historyDraft(a)).toHaveValue(draftA);await expect(historyDraft(b)).toHaveValue(draftB);assert.equal((await ipc(main,'agent.read',{id:runB.id})).status,'running');
 passed('전체 종료에서 첫 창 확인 후 다음 창을 취소하면 모든 창과 초안 유지');

 fs.writeFileSync(finishA,'done');fs.writeFileSync(finishB,'done');await expect.poll(async()=>(await ipc(main,'agent.read',{id:runA.id})).status).toBe('completed');await expect.poll(async()=>(await ipc(main,'agent.read',{id:runB.id})).status).toBe('completed');

 await historyDraft(b).fill('저장 후 비울 내용');
 await pane(b).getByRole('button',{name:'작업이력 보내기',exact:true}).click();
 await expect(historyDraft(b)).toHaveValue('');
 const retainedDraft='다른 창에서 삭제해도 남아야 하는 작성 내용';await historyDraft(b).fill(retainedDraft);
 await expect(b.locator('html')).toHaveAttribute('data-reviewops-dirty','true');
 await main.locator(`[data-tree-node="r-${reviewB.id}"]`).click();
 await pane(main).getByRole('tab',{name:'정보',exact:true}).click();
 await pane(main).locator('.original-review-delete').getByRole('button',{name:'삭제',exact:true}).click();
 const deletion=main.getByRole('dialog',{name:'리뷰 삭제',exact:true});
 await deletion.getByLabel('삭제 확인',{exact:true}).fill('외부에서 수정한 리뷰 B');
 await deletion.getByRole('button',{name:'삭제',exact:true}).click();
 await expect.poll(async()=>(await ipc(main,'snapshot')).reviews.some(review=>review.id===reviewB.id)).toBe(false);
 await expect(historyDraft(b)).toHaveValue(retainedDraft);
 await expect(b.locator('.workspace-app')).toContainText('다른 창에서 삭제된 항목이 있습니다. 작성 중인 내용은 이 창에 유지됩니다.');
 assert.equal(await b.evaluate(id=>localStorage.getItem(`reviewops.draft.${id}`),reviewB.id),null);
 await expect(historyDraft(a)).toHaveValue(draftA);
 passed('저장한 입력은 비우고 다른 창에서 리뷰를 삭제해도 B의 작성 중 입력 유지');

 assert.equal(recorded().length,3);assert.deepEqual(errors,[]);report.blockedExternalRequests=await app.evaluate(()=>globalThis.parallelBlockedRequests);assert.deepEqual(report.blockedExternalRequests,[]);assert.equal((await main.evaluate(()=>window.accountManager.getState())).accounts.length,0);
 passed('모든 시험용 실행 종료와 외부 네트워크·실제 계정 사용 없음');
 report.ok=true;report.fixtureRuns=recorded().map(({input,cwd})=>({prompt:input.includes('WAIT_A')?'WAIT_A':input.includes('WAIT_B')?'WAIT_B':'QUICK_B',cwd}));
 await b.screenshot({path:path.join(results,'parallel-workspaces.png'),scale:'css'});console.log(JSON.stringify({ok:true,checks:checks.length,testRoot}));
}catch(error){report.error=error.message;await b?.screenshot({path:path.join(results,'parallel-workspaces-failure.png'),scale:'css'}).catch(()=>{});console.error('PARALLEL_WORKSPACES_FAILURE',testRoot,error);throw error}
finally{
 fs.writeFileSync(finishA,'done');fs.writeFileSync(finishB,'done');fs.writeFileSync(path.join(results,'parallel-workspaces.json'),JSON.stringify(report,null,2));
 if(app){await app.evaluate(({app,BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();app.exit(0)}).catch(()=>{});await app.close().catch(()=>{})}
 await new Promise(resolve=>server.close(resolve));
}
