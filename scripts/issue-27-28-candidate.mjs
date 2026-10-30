import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Prepare a real application snapshot for manual review. This script never
// starts Electron or opens an existing application database.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {createStore}=require('../electron/store.cjs');
const {createRequestQueue,requestTargetKey}=require('../electron/agent-requests.cjs');
const id=`${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
const directory=path.join(root,'.local-data',`q2728-${id}`);
const appRoot=path.join(directory,'app'),dataPath=path.join(directory,'data'),work=path.join(directory,'work'),sessionProfile=path.join(directory,'qa-sessions');
const evidence=path.join(root,'test-results','issue-27-28');
for(const item of [appRoot,dataPath,work,evidence,path.join(directory,'bin'),path.join(sessionProfile,'sessions')])fs.mkdirSync(item,{recursive:true});
const write=(file,content,mode=0o600)=>fs.writeFileSync(file,content,{flag:'wx',mode});
const hash=content=>crypto.createHash('sha256').update(content).digest('hex');
const quote=value=>`'${String(value).replaceAll("'", "'\"'\"'")}'`;
const binary=path.join(directory,'bin','codex-qa');
const fixtureScript=path.join(directory,'bin','fixture-runner.cjs');
const calls=path.join(directory,'cli-calls.jsonl');
const fixture=`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2),emit=value=>console.log(JSON.stringify(value));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({at:new Date().toISOString(),args})+'\\n');
if(args[0]==='--version'){console.log('codex-cli 0.0.0-issue-27-28-qa');process.exit(0)}
if(args[0]==='login'&&args[1]==='status'){console.log('검사 전용 실행 프로그램');process.exit(0)}
if(args[0]==='app-server'){
 let pending='';process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;const message=JSON.parse(line);if(message.id==null)continue;
 let result={};if(message.method==='config/read')result={config:{model:'qa-model-a',model_reasoning_effort:'medium'}};
 if(message.method==='model/list')result={data:['qa-model-a','qa-model-b'].map((model,i)=>({id:model,model,displayName:i?'검사 모델 B':'검사 모델 A',supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'medium'})),nextCursor:null};
 if(message.method==='account/read')result={account:null,requiresOpenaiAuth:false};emit({id:message.id,result});}});return;
}
if(args[0]!=='exec')process.exit(77);
let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',async()=>{
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const selected=args.indexOf('--model'),model=selected<0?'qa-model-a':args[selected+1];
 const configured=args.find(arg=>arg.startsWith('model_reasoning_effort='));let effort='medium';if(configured)try{effort=JSON.parse(configured.split('=').slice(1).join('='))}catch{}
 const resume=args.indexOf('resume'),sessionId=resume<0?'qa-thread-'+Date.now():args[resume+1];
 fs.writeFileSync(${JSON.stringify(path.join(sessionProfile,'sessions'))}+'/'+sessionId+'.jsonl',JSON.stringify({type:'session_meta',payload:{id:sessionId,model,cwd:process.cwd()}})+'\\n');
 emit({type:'thread.started',thread_id:sessionId});
 emit(prompt.includes('MISSING')?{type:'turn.started'}:{type:'turn.started',model,reasoning_effort:effort});
 if(prompt.includes('MANY'))for(let i=0;i<115;i++)emit({type:'item.completed',item:{id:'command-'+i,type:'command_execution',exit_code:0}});
 const body='# 검사 응답\\n\\n'+prompt+'\\n\\n'+Array.from({length:35},(_,i)=>(i+1)+'. 긴 응답의 읽던 위치와 최신 내용 이동을 검사합니다.').join('\\n')+'\\n\\n| 항목 | 내용 |\\n| --- | --- |\\n| 복사 | 줄바꿈과 Markdown 유지 |\\n\\n'+String.fromCharCode(96).repeat(3)+'js\\nconsole.log("copy");\\n'+String.fromCharCode(96).repeat(3);
 if(!prompt.includes('EMPTY')){emit({type:'item.started',item:{id:'response',type:'agent_message',text:'작성 중인 검사 응답'}});await pause(7000);emit({type:'item.updated',item:{id:'response',type:'agent_message',text:body.slice(0,500)}});await pause(7000);emit({type:'item.completed',item:{id:'response',type:'agent_message',text:body}});}
 if(prompt.includes('FAIL')){emit({type:'turn.failed',error:{message:'검사 요청에 따른 실행 실패'}});process.exitCode=1;return;}
 emit({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}});
});
`;
write(fixtureScript,fixture,0o700);
// The production runtime picker requires a native Apple Silicon executable.
// Compile a small, fixed launcher instead of weakening that validation.
const launcherSource=path.join(directory,'bin','fixture-launcher.c');
write(launcherSource,`#include <unistd.h>\n#include <stdlib.h>\n#include <stdio.h>\nint main(int argc,char **argv){char **args=calloc((size_t)argc+2,sizeof(char*));if(!args)return 126;args[0]=${JSON.stringify(process.execPath)};args[1]=${JSON.stringify(fixtureScript)};for(int i=1;i<argc;i++)args[i+1]=argv[i];execv(args[0],args);perror("qa launcher");return 127;}\n`);
execFileSync('/usr/bin/clang',[launcherSource,'-o',binary],{stdio:'pipe'});
const runtimeCheck=await require('../electron/codex/runtime.cjs').findRuntime(binary);
if(!runtimeCheck.available||runtimeCheck.path!==binary)throw new Error(`검사 실행 프로그램을 선택하지 못했습니다: ${runtimeCheck.error}`);
write(path.join(directory,'ssh-config'),'# Isolated candidate: no SSH hosts\n');
fs.mkdirSync(path.join(dataPath,'codex-manager'),{recursive:true});
write(path.join(dataPath,'codex-manager','runtime.json'),JSON.stringify({path:binary}));
write(path.join(dataPath,'language.json'),JSON.stringify({language:'ko'}));
write(path.join(work,'sample.md'),'# 첨부 검사\n\n이 파일은 후보 앱 전용 자료입니다.\n');
const store=createStore({dbPath:path.join(dataPath,'reviewops.sqlite')});
let seed;
try{
 const group=store.saveGroup({name:'GitHub #27·#28 검사'});
 const project=store.saveProject({groupId:group.id,name:'격리 후보',connection:{kind:'local',rootPath:work,agentEnabled:true,agentBinary:binary,agentModel:'qa-model-a',agentReasoningEffort:'medium'}});
 const service=project.connection;
 const review=store.saveReview({projectId:project.id,serviceId:service.id,title:'요청별 기록과 대화 화면',body:'검사 전용 DB입니다. MANY: 기록 100개 초과, MISSING: 실제 사용 값 누락, EMPTY: 빈 응답, FAIL: 실행 실패. 검사용 실행 프로그램은 실제 모델이나 SSH에 연결하지 않습니다.',category:'ux',priority:'high'});
 const linkedReview=store.saveReview({projectId:project.id,serviceId:service.id,title:'연결된 요청 읽기',body:'다른 리뷰의 요청·응답 이동을 위한 검사 기록입니다.',category:'ux'});
 const earlier=new Date(Date.now()-360000).toISOString(),later=new Date(Date.now()-300000).toISOString();
 const response='# 완료된 검사 응답\n\n'+Array.from({length:45},(_,i)=>`${i+1}. 긴 대화에서 읽던 위치가 유지되는지 검사합니다.`).join('\n')+'\n\n| 항목 | 내용 |\n| --- | --- |\n| 원문 | Markdown과 줄바꿈 |\n\n```js\nconsole.log("copy");\n```';
 const completed=store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'completed',prompt:'Markdown 표와 코드가 포함된 검사 요청\n\n```js\nconst value = 1;\n```',response,model:'qa-model-a',reasoningEffort:'medium',workPath:work,startedAt:earlier,finishedAt:later,requestId:'qa-completed',executionSettings:{version:1,selected:{model:'qa-model-a',reasoningEffort:'medium'},automatic:{model:false,reasoningEffort:false},sent:{model:'qa-model-a',reasoningEffort:'medium'}},reportedSettings:{model:'qa-model-a',reasoningEffort:'medium',source:'cli_event',eventType:'turn.started',reportedAt:earlier},progress:Array.from({length:100},(_,i)=>({sequence:i+16,state:'completed',step:'command_execution',message:`검사 명령 ${i+16} 완료`,createdAt:later})),progressOmitted:15});
 const legacy=store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'failed',prompt:'기록이 없는 예전 실행',error:'검사용 예전 실패 기록',workPath:work,startedAt:earlier,finishedAt:later});
 const automatic={version:1,selected:{model:'',reasoningEffort:''},automatic:{model:true,reasoningEffort:true},sent:{model:'',reasoningEffort:''}};
 const linked=store.saveAgentRun({reviewId:linkedReview.id,serviceId:service.id,status:'completed',prompt:'다른 리뷰에 저장된 요청 원문',response:'다른 리뷰의 실제 저장 응답입니다.\n\n연결된 요청과 응답을 함께 읽습니다.',workPath:work,startedAt:earlier,finishedAt:later,executionSettings:automatic});
 const missing=store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'completed',prompt:'자동 선택 후 실제 사용 값을 제공하지 않은 실행',response:'프로그램이 실제 사용 값을 보내지 않은 검사 기록입니다.',workPath:work,startedAt:earlier,finishedAt:later,executionSettings:automatic,continuedFromRunId:completed.id});
 store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'completed',prompt:'응답이 없는 완료 실행',response:'',workPath:work,startedAt:earlier,finishedAt:later,executionSettings:automatic,continuedFromRunId:missing.id});
 store.saveAgentRun({reviewId:review.id,serviceId:service.id,status:'completed',prompt:'예전 실패 요청을 재실행한 검사 기록',response:'원본 실행으로 이동할 수 있습니다.',workPath:work,startedAt:earlier,finishedAt:later,executionSettings:automatic,retryOf:legacy.id});
 const queue=createRequestQueue({store,targetForReview:()=>({serviceId:service.id,key:requestTargetKey(service,{workPath:work}),settings:{binary,workPath:work,model:'qa-model-a',reasoningEffort:'medium'}}),targetForRun:()=>requestTargetKey(service,{workPath:work}),start:()=>{throw new Error('후보 준비 중 실행할 수 없습니다.')}});
 queue.add({requestId:'qa-waiting',reviewId:review.id,prompt:'저장한 설정으로 실행하는 검사 요청',model:'qa-model-b',reasoningEffort:'high',predecessorId:linked.id});
 seed={groupId:group.id,projectId:project.id,reviewId:review.id,serviceId:service.id,completedRunId:completed.id,linkedReviewId:linkedReview.id,linkedRunId:linked.id,schemaVersion:store.exportData().version};
}finally{store.close();}

execFileSync(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--outDir',path.join(appRoot,'dist')],{cwd:root,stdio:'inherit'});
fs.cpSync(path.join(root,'electron'),path.join(appRoot,'electron'),{recursive:true,errorOnExist:true});
fs.mkdirSync(path.join(appRoot,'dist/locales'),{recursive:true});
for(const name of ['en.json','translations.json'])fs.copyFileSync(path.join(root,'src/i18n',name),path.join(appRoot,'dist/locales',name),fs.constants.COPYFILE_EXCL);
const original=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
write(path.join(appRoot,'package.json'),JSON.stringify({...original,name:'reviewops-issue-27-28-candidate',productName:'ReviewOps 후보'},null,2));
// Dependencies remain pinned by the checked-in lock file; app code and built
// assets are copied and never follow later source edits.
fs.symlinkSync(path.join(root,'node_modules'),path.join(appRoot,'node_modules'),'dir');
const files=[];
function collect(base,relative=''){
 for(const entry of fs.readdirSync(path.join(base,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(entry.name==='node_modules')continue;
  const next=path.join(relative,entry.name);if(entry.isDirectory())collect(base,next);else if(entry.isFile())files.push({path:next,sha256:hash(fs.readFileSync(path.join(base,next)))});
 }
}
collect(appRoot);
const candidateHash=hash(JSON.stringify(files));
const wrapper=path.join(directory,'ReviewOps Candidate.app'),macos=path.join(wrapper,'Contents/MacOS');
fs.mkdirSync(macos,{recursive:true});
const executable=require('electron');
const launch=`#!/bin/sh\ncd ${quote(appRoot)} || exit 1\nexec /usr/bin/env -u ELECTRON_RUN_AS_NODE -u OPENAI_API_KEY -u CODEX_API_KEY -u SSH_AUTH_SOCK REVIEWOPS_DATA_DIR=${quote(dataPath)} REVIEWOPS_SSH_CONFIG=${quote(path.join(directory,'ssh-config'))} REVIEWOPS_CODEX_SSH_CONFIG=${quote(path.join(directory,'ssh-config'))} CODEX_HOME=${quote(sessionProfile)} ${quote(executable)} ${quote(appRoot)} "$@" >> ${quote(path.join(directory,'runtime.log'))} 2>&1\n`;
write(path.join(macos,'ReviewOpsCandidate'),launch,0o700);
write(path.join(wrapper,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ReviewOpsCandidate</string><key>CFBundleIdentifier</key><string>kr.co.season.reviewops.qa.${id}</string><key>CFBundleName</key><string>ReviewOps 후보</string><key>CFBundleDisplayName</key><string>ReviewOps 후보</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>`);
write(path.join(directory,'start-candidate.command'),launch,0o700);
const metadata={createdAt:new Date().toISOString(),baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),candidateHash,appRoot,wrapper,startCommand:path.join(directory,'start-candidate.command'),dbPath:path.join(dataPath,'reviewops.sqlite'),dbSha256:hash(fs.readFileSync(path.join(dataPath,'reviewops.sqlite'))),runtimeLog:path.join(directory,'runtime.log'),fixtureBinary:binary,fixtureScript,fixtureSha256:hash(fixture),fixtureBinarySha256:hash(fs.readFileSync(binary)),runtimeCheck,sessionProfile,fixtureMode:'Synthetic CLI events through the real application; no model or SSH connection',dependencyLockSha256:hash(fs.readFileSync(path.join(root,'package-lock.json'))),seed,files};
const report=path.join(evidence,`candidate-${id}.json`);
write(report,JSON.stringify(metadata,null,2));
console.log(JSON.stringify({report,wrapper,startCommand:metadata.startCommand,dbPath:metadata.dbPath,candidateHash,seed},null,2));
