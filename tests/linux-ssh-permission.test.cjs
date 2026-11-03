'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const helpers=import(pathToFileURL(path.resolve(__dirname,'../scripts/diagnostics/linux-ssh-permission.mjs')).href);
const source='a'.repeat(40),ref='refs/heads/codex/issue34-linux-permission-qa';
const host={platform:'linux',uid:1001,euid:1001,ci:'true',actions:'true',event:'workflow_dispatch',source,head:source,githubSHA:source,ref,workflowRef:`season-framework/reviewops-local/.github/workflows/linux-ssh-permission.yml@${ref}`,dirty:'',nodeMajor:24,runId:123,attempt:1};
test('Linux permission diagnostic admits only the reviewed manual nonroot Linux source',async()=>{
 const {assertHost}=await helpers;assert.doesNotThrow(()=>assertHost(host));
 for(const patch of [{platform:'darwin'},{uid:0},{uid:undefined},{euid:0},{euid:undefined},{event:'push'},{ci:'false'},{head:'b'.repeat(40)},{githubSHA:'b'.repeat(40)},{dirty:' M electron/agents.cjs'},{nodeMajor:22},{ref:'refs/tags/v1.4.0'},{attempt:0},{attempt:2},{workflowRef:'unrelated'}])assert.throws(()=>assertHost({...host,...patch}));
});
test('folder permission denial cannot pass as a missing CLI or an unchecked error string',async()=>{
 const {assertDenied}=await helpers,work='/tmp/owned/project/restricted';
 const dto={installed:null,authState:'unknown',loggedIn:false,errorCode:'AGENT_WORK_PATH_INACCESSIBLE',workPath:work,modelSource:'none',models:[],error:'bash: cd: Permission denied\nSSH 계정으로 에이전트 작업 폴더를 열 수 없습니다.'};
 assert.doesNotThrow(()=>assertDenied(dto,work));
 for(const patch of [{installed:false},{authState:'not_installed'},{loggedIn:true},{errorCode:'AGENT_NOT_INSTALLED'},{workPath:'/tmp/other'},{models:[{}]},{error:'Permission denied'},{error:'SSH 계정으로 에이전트 작업 폴더를 열 수 없습니다. No such file or directory'}])assert.throws(()=>assertDenied({...dto,...patch},work));
});
test('retained cleanup rejects unknown exit, open streams, signal exit and unexpected model work',async()=>{
 const {assertClosures}=await helpers;
 const shell={exitObserved:true,closeObserved:true,stdoutEnded:true,stderrEnded:true,code:125,signal:null,overflow:false};
 const value={serverClosed:true,jobs:0,updates:0,unexpectedRequests:0,shells:[shell],channels:[{closed:true}],clients:[{closed:true}]};
 assert.doesNotThrow(()=>assertClosures(value));
 for(const patch of [{exitObserved:false},{closeObserved:false},{stdoutEnded:false},{stderrEnded:false},{code:null},{code:90},{signal:'SIGTERM'},{overflow:true}])assert.throws(()=>assertClosures({...value,shells:[{...shell,...patch}]}));
 for(const patch of [{serverClosed:false},{jobs:1},{updates:1},{unexpectedRequests:1},{channels:[{closed:false}]},{clients:[{closed:false}]}])assert.throws(()=>assertClosures({...value,...patch}));
});
