'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {createStore}=require('../electron/store.cjs');
const {createRequestQueue}=require('../electron/agent-requests.cjs');

const root=path.resolve(__dirname,'..');
const modulePromise=import(pathToFileURL(path.join(root,'scripts/issue-27-28-candidate.mjs')).href);
const hash=content=>crypto.createHash('sha256').update(content).digest('hex');
const instructions='# 에이전트 작업 지시서\n\n## 요청사항\nMANY MISSING EMPTY FAIL QA:MANY QA:MISSING QA:EMPTY QA:FAIL\n\n## 리뷰 정보\n- 제목: 오류와 빈 응답 검사\n';
const wrap=request=>`${instructions}\n이전 대화:\nQA:FAIL\n\n사용자 작업 요청:\n${request}`;
const resultsDirectory=path.join(root,'test-results','issue-27-28');

test('QA-05 only explicit commands in the current request select synthetic errors',async()=>{
 const {fixtureScenario}=await modulePromise;
 for(const request of ['저장한 설정으로 실행하는 검사 요청','MANY','MISSING','EMPTY','FAIL','MANY MISSING EMPTY FAIL','QA:FAIL에 관한 설명','QA:EMPTY\n다음 문장'])assert.equal(fixtureScenario(wrap(request)),'NORMAL',request);
 for(const command of ['MANY','MISSING','EMPTY','FAIL']){
  assert.equal(fixtureScenario(wrap(`QA:${command}`)),command);
  assert.equal(fixtureScenario(` QA:${command}\n`),command);
 }
});

test('QA-05 saved queue requests produce distinct normal, failed, empty, missing-info and many-record results',async()=>{
 const {createFixtureScript}=await modulePromise;
 fs.mkdirSync(resultsDirectory,{recursive:true});
 const directory=fs.mkdtempSync(path.join(resultsDirectory,'fix03-fixture-'));
 const sessions=path.join(directory,'sessions');fs.mkdirSync(sessions);
 const script=path.join(directory,'fixture-runner.cjs'),calls=path.join(directory,'calls.jsonl');
 fs.writeFileSync(script,createFixtureScript({calls,sessionPath:sessions,stepDelayMs:0}),{flag:'wx',mode:0o700});
 const database=path.join(directory,'queue.sqlite'),store=createStore({dbPath:database});
 const caseResults=[];
 try{
  const group=store.saveGroup({name:'03 검사 프로그램'});
  const service=store.saveService({groupId:group.id,name:'격리 로컬',kind:'local',rootPath:directory});
  const project=store.saveProject({groupId:group.id,name:'검사 프로그램',serviceIds:[service.id]});
  const review=store.saveReview({projectId:project.id,serviceId:service.id,title:'검사 명령 분리',body:instructions});
  const queue=createRequestQueue({store,targetForReview:()=>({serviceId:service.id,key:'fixture-only',settings:{binary:process.execPath,model:'qa-model-a',reasoningEffort:'medium'}}),targetForRun:()=> 'fixture-only',start:async input=>{
   const stdin=wrap(input.prompt);
   const output=spawnSync(process.execPath,[script,'exec','resume',`fixture-${input.requestId}`,'--model',input.model,'--config',`model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`],{input:stdin,encoding:'utf8',timeout:10000,cwd:directory});
   if(output.error)throw output.error;
   const events=output.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
   const response=events.find(event=>event.type==='item.completed'&&event.item?.type==='agent_message')?.item.text||'';
   const error=events.find(event=>event.type==='turn.failed')?.error.message||'';
   const result={id:input.requestId,prompt:input.prompt,exitCode:output.status,stderr:output.stderr,events,requestSettings:{model:input.model,reasoningEffort:input.reasoningEffort},stdinSha256:hash(stdin)};
   caseResults.push(result);
   fs.writeFileSync(path.join(directory,`${input.requestId}-stdin.txt`),stdin,{flag:'wx',mode:0o600});
   fs.writeFileSync(path.join(directory,`${input.requestId}-stdout.jsonl`),output.stdout,{flag:'wx',mode:0o600});
   fs.writeFileSync(path.join(directory,`${input.requestId}-stderr.txt`),output.stderr,{flag:'wx',mode:0o600});
   return store.saveAgentRun({id:input.requestId,reviewId:review.id,serviceId:service.id,prompt:input.prompt,response,error,status:error?'failed':'completed',workPath:directory});
  }});
  const cases=[
   {id:'normal',prompt:'저장한 설정으로 실행하는 검사 요청',status:'completed',exit:0,response:true,commands:0,reported:true},
   {id:'failed',prompt:'QA:FAIL',status:'failed',exit:1,response:true,commands:0,reported:true},
   {id:'empty',prompt:'QA:EMPTY',status:'completed',exit:0,response:false,commands:0,reported:true},
   {id:'missing',prompt:'QA:MISSING',status:'completed',exit:0,response:true,commands:0,reported:false},
   {id:'many',prompt:'QA:MANY',status:'completed',exit:0,response:true,commands:115,reported:true}
  ];
  for(const item of cases){
   const saved=queue.add({requestId:item.id,reviewId:review.id,prompt:item.prompt,model:'qa-model-b',reasoningEffort:'high'});
   assert.equal(saved.state,'ready');
   assert.equal(caseResults.length,cases.indexOf(item),'saving must not start a process');
   const [run,repeated]=await Promise.all([queue.start({id:item.id}),queue.start({id:item.id})]);
   assert.equal(run.id,repeated.id);
   assert.equal(run.status,item.status,item.id);
   assert.equal(Boolean(run.response),item.response,item.id);
   const actual=caseResults.at(-1),started=actual.events.find(event=>event.type==='turn.started');
   assert.equal(actual.exitCode,item.exit,item.id);
   assert.equal(actual.stderr,'',item.id);
   assert.equal(actual.events.filter(event=>event.item?.type==='command_execution').length,item.commands,item.id);
   assert.equal(Boolean(started.model),item.reported,item.id);
   assert.equal(Boolean(started.reasoning_effort),item.reported,item.id);
   if(item.reported){assert.equal(started.model,'qa-model-b');assert.equal(started.reasoning_effort,'high');}
   assert.equal(queue.list(review.id).requests.find(request=>request.id===item.id).runStatus,item.status);
  }
  assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,5,'concurrent queue starts share one process');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{store.close();}
 const shaFiles=fs.readdirSync(directory).filter(name=>fs.statSync(path.join(directory,name)).isFile()).sort().map(name=>({path:name,sha256:hash(fs.readFileSync(path.join(directory,name)))}));
 const result={bugId:'QA-05',scope:'Synthetic Node CLI and isolated request queue; no application, OS clipboard, model or SSH execution',createdAt:new Date().toISOString(),directory,dbPath:database,fixtureScript:script,fixtureSha256:hash(fs.readFileSync(script)),cases:caseResults,files:shaFiles};
 const resultPath=path.join(directory,'results.json');fs.writeFileSync(resultPath,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
 const report=`# QA-05 검사 프로그램 수정\n\n검사 결과: 5개 실행 통과. 일반 대기 요청은 정상 응답, QA:FAIL은 실패, QA:EMPTY는 응답 없는 완료로 구별했습니다. QA:MISSING은 사용 모델·추론 정보가 없으며 QA:MANY는 명령 기록 115개를 보냈습니다.\n\n리뷰 지시서와 이전 대화에는 MANY·MISSING·EMPTY·FAIL 및 QA 명령을 모두 포함했습니다. 분기는 마지막 사용자 요청문 전체가 정확한 QA 명령일 때만 적용됩니다. 같은 요청의 동시 실행 두 번은 프로세스 한 개만 시작했습니다. 저장한 모델 B·추론 high가 전달됐습니다.\n\n이 검사는 실제 Node 프로세스와 격리한 요청 저장 처리를 사용했습니다. Electron 화면, 실제 OS 복사, 실제 모델, 실제 SSH는 검사하지 않았습니다. 02의 기존 후보와 DB는 변경하지 않았습니다.\n\n- 결과 파일: ${resultPath}\n- 결과 SHA256: ${hash(fs.readFileSync(resultPath))}\n- 검사 DB: ${database}\n- DB SHA256: ${hash(fs.readFileSync(database))}\n- 검사 프로그램 SHA256: ${hash(fs.readFileSync(script))}\n\n문서 점검\n\n- [x] 구어체를 사용하지 않았습니다.\n- [x] 짧고 명확한 용어를 사용했습니다.\n- [x] 제품 오류와 검사 프로그램 오류를 구분했습니다.\n- [x] 실행 방법과 미검사 항목을 구분했습니다.\n`;
 const reportPath=path.join(directory,'report.md');fs.writeFileSync(reportPath,report,{flag:'wx',mode:0o600});
 console.log(JSON.stringify({bugId:'QA-05',reportPath,reportSha256:hash(fs.readFileSync(reportPath)),resultPath,resultSha256:hash(fs.readFileSync(resultPath)),dbPath:database}));
});

test('candidate verification rejects changed application files and manifest hashes',async()=>{
 const {verifyCandidate}=await modulePromise;
 fs.mkdirSync(resultsDirectory,{recursive:true});
 const directory=fs.mkdtempSync(path.join(resultsDirectory,'fix03-fixture-integrity-'));
 const appRoot=path.join(directory,'app');fs.mkdirSync(appRoot);
 const appFile=path.join(appRoot,'app.txt');fs.writeFileSync(appFile,'candidate',{flag:'wx'});
 const externalFile=path.join(directory,'launcher');fs.writeFileSync(externalFile,'launch',{flag:'wx'});
 const files=[{path:'app.txt',sha256:hash('candidate')}];
 const integrity={version:2,appFilesSha256:hash(JSON.stringify(files)),externalFiles:[{path:externalFile,sha256:hash('launch')}]};
 const candidate={appRoot,files,integrity,candidateHash:hash(JSON.stringify(integrity))};
 assert.equal(verifyCandidate(candidate).checkedFiles,2);
 assert.throws(()=>verifyCandidate({...candidate,candidateHash:'0'.repeat(64)}),/후보 정보의 해시/);
 fs.writeFileSync(externalFile,'changed');assert.throws(()=>verifyCandidate(candidate),/후보 파일이 변경/);
 fs.writeFileSync(externalFile,'launch');fs.writeFileSync(appFile,'changed');assert.throws(()=>verifyCandidate(candidate),/후보 파일이 변경/);
 fs.writeFileSync(appFile,'candidate');fs.writeFileSync(path.join(appRoot,'new-file.txt'),'extra',{flag:'wx'});assert.throws(()=>verifyCandidate(candidate),/파일 목록이 변경/);
});

test('QA fixture handles real JSONL input and output, session resume, and Markdown line breaks',async()=>{
 const {createFixtureScript}=await modulePromise;
 fs.mkdirSync(resultsDirectory,{recursive:true});
 const directory=fs.mkdtempSync(path.join(resultsDirectory,'fix03-fixture-protocol-'));
 const sessions=path.join(directory,'sessions');fs.mkdirSync(sessions);
 const script=path.join(directory,'fixture-runner.cjs'),calls=path.join(directory,'calls.jsonl');
 fs.writeFileSync(script,createFixtureScript({calls,sessionPath:sessions,stepDelayMs:0}),{flag:'wx',mode:0o700});
 const messages=[{id:1,method:'initialize',params:{clientInfo:{name:'fixture-test',version:'1'}}},{id:2,method:'config/read',params:{}},{id:3,method:'model/list',params:{}},{id:4,method:'account/read',params:{}}];
 const requestLines=messages.map(message=>JSON.stringify(message)).join('\n')+'\n';
 const appServer=spawnSync(process.execPath,[script,'app-server'],{input:requestLines,encoding:'utf8',timeout:10000,cwd:directory});
 assert.ifError(appServer.error);assert.equal(appServer.status,0);assert.equal(appServer.stderr,'');
 assert.equal(appServer.stdout.endsWith('\n'),true);
 const responses=appServer.stdout.trimEnd().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(responses.map(response=>response.id),[1,2,3,4]);
 assert.equal(responses[1].result.config.model,'qa-model-a');
 assert.deepEqual(responses[2].result.data.map(item=>item.model),['qa-model-a','qa-model-b']);
 assert.deepEqual(responses[2].result.data[1].supportedReasoningEfforts.map(item=>item.reasoningEffort),['low','medium','high']);
 assert.equal(responses[3].result.requiresOpenaiAuth,false);
 const run=(args,input)=>{
  const processResult=spawnSync(process.execPath,[script,...args],{input,encoding:'utf8',timeout:10000,cwd:directory});
  assert.ifError(processResult.error);assert.equal(processResult.status,0);assert.equal(processResult.stderr,'');
  const events=processResult.stdout.trimEnd().split('\n').map(line=>JSON.parse(line));
  return {...processResult,events};
 };
 const first=run(['exec','--model','qa-model-a'],'첫 요청의 실제 줄바꿈\n다음 문장');
 const sessionId=first.events.find(event=>event.type==='thread.started').thread_id;
 const sessionFile=path.join(sessions,sessionId+'.jsonl');
 const firstSessionRaw=fs.readFileSync(sessionFile,'utf8');
 assert.equal(firstSessionRaw.endsWith('\n'),true);assert.equal(firstSessionRaw.endsWith('\\n'),false);
 const firstSession=firstSessionRaw.trimEnd().split('\n').map(line=>JSON.parse(line));
 assert.equal(firstSession[0].payload.id,sessionId);assert.equal(firstSession[0].payload.model,'qa-model-a');
 const second=run(['exec','resume',sessionId,'--model','qa-model-b'],'모델을 바꾼 이어서 요청');
 assert.equal(second.events.find(event=>event.type==='thread.started').thread_id,sessionId);
 assert.equal(second.events.find(event=>event.type==='turn.started').model,'qa-model-b');
 const resumedRaw=fs.readFileSync(sessionFile,'utf8');
 const resumedSession=resumedRaw.trimEnd().split('\n').map(line=>JSON.parse(line));
 assert.equal(resumedRaw.endsWith('\n'),true);assert.equal(resumedSession[0].payload.id,sessionId);assert.equal(resumedSession[0].payload.model,'qa-model-b');
 const response=first.events.find(event=>event.type==='item.completed'&&event.item?.type==='agent_message').item.text;
 assert.ok(response.startsWith('# 검사 응답\n\n첫 요청의 실제 줄바꿈\n다음 문장\n\n'));
 assert.ok(response.includes('| 항목 | 내용 |\n| --- | --- |\n| 복사 | 줄바꿈과 Markdown 유지 |'));
 assert.ok(response.includes('```js\nconsole.log("copy");\n```'));
 assert.equal(response.includes('\\n'),false);
 const callsRaw=fs.readFileSync(calls,'utf8');
 assert.equal(callsRaw.endsWith('\n'),true);assert.equal(callsRaw.endsWith('\\n'),false);
 const parsedCalls=callsRaw.trimEnd().split('\n').map(line=>JSON.parse(line));
 assert.equal(parsedCalls.length,3);assert.deepEqual(parsedCalls[0].args,['app-server']);
 const write=(name,value)=>fs.writeFileSync(path.join(directory,name),typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
 write('app-server-input.jsonl',requestLines);write('app-server-output.jsonl',appServer.stdout);write('initial-output.jsonl',first.stdout);write('resume-output.jsonl',second.stdout);write('first-session.jsonl',firstSessionRaw);write('response.md',response);
 const result={bugId:'QA-05',scope:'Synthetic Node CLI only; no Electron application, actual model or SSH',directory,checks:{appServerResponses:4,actualJsonlDelimiter:true,sessionResumePreservesId:true,resumedModel:'qa-model-b',callsParsed:parsedCalls.length,markdownActualLineBreaks:true},responses,firstSession,resumedSession,files:fs.readdirSync(directory).filter(name=>fs.statSync(path.join(directory,name)).isFile()).sort().map(name=>({path:name,sha256:hash(fs.readFileSync(path.join(directory,name)))}))};
 write('results.json',result);
 const resultPath=path.join(directory,'results.json');
 write('report.md',`# QA-05 줄바꿈과 대화 재개 추가 검사\n\n검사 결과: 통과. 생성한 프로그램은 실제 줄바꿈으로 나눈 initialize·config/read·model/list·account/read 요청 4개에 각각 응답했습니다. 호출 로그와 대화 기록을 실제 줄바꿈으로 나누어 JSON.parse로 읽었습니다. 응답의 Markdown 제목·표·코드도 실제 줄바꿈을 포함했습니다.\n\n모델 A로 시작한 뒤 모델 B로 재개했을 때 대화 ID가 같았으며 대화 기록의 모델은 B였습니다. 문자열 표시의 이중 escape와 실제 파일 내용을 구별했습니다. 줄바꿈 처리 자체는 변경하지 않았습니다. 이 검사는 생성한 Node 프로그램만 실행했으며 앱 화면·실제 모델·SSH를 검사하지 않았습니다.\n\n- 결과 파일: ${resultPath}\n- 결과 SHA256: ${hash(fs.readFileSync(resultPath))}\n\n문서 점검\n\n- [x] 구어체를 사용하지 않았습니다.\n- [x] 명확한 용어를 사용했습니다.\n- [x] 검사한 동작과 미검사 항목을 구분했습니다.\n`);
 const reportPath=path.join(directory,'report.md');
 console.log(JSON.stringify({bugId:'QA-05',reportPath,reportSha256:hash(fs.readFileSync(reportPath)),resultPath,resultSha256:hash(fs.readFileSync(resultPath))}));
});
