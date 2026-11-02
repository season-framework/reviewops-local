// Preparation only. These helpers run only when an explicitly invoked gate calls them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {requireNativeHost,privatePaths,privateEnvironment,appPaths,fileHash,inside,selectMainHost,selectProjectHost,sourceIdentity,nativePhoto,rawPNG} from './native-adapters.mjs';

export const RPC_SOURCE=String.raw`const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli 0.0.0-fixture');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
if(args[0]!=='app-server')process.exit(77);
let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;if(pending.length>131072)process.exit(78);let end;while((end=pending.indexOf('\n'))>=0){const raw=pending.slice(0,end);pending=pending.slice(end+1);if(!raw.trim())continue;const m=JSON.parse(raw);if(m.id==null)continue;let result;if(m.method==='initialize')result={};else if(m.method==='config/read')result={config:{model:'fixture-model',model_reasoning_effort:'high'}};else if(m.method==='model/list')result={data:[{id:'fixture-model',model:'fixture-model',displayName:'Synthetic regression fixture',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null};else process.exit(79);console.log(JSON.stringify({id:m.id,result}));}});`;
export const AGENT_SOURCE=String.raw`const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),base=FIXTURE_ROOT;
if(args[0]==='--version'){console.log('codex-cli 0.0.0-fixture');process.exit(0)}
if(args[0]==='login'&&args[1]==='status')process.exit(0);
if(args[0]==='app-server'){require(path.join(base,'model-rpc.cjs'));return}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.length>262144)process.exit(81)});
process.stdin.on('end',()=>{fs.writeFileSync(path.join(base,'regression-agent-'+process.pid+'-'+Date.now()+'.json'),JSON.stringify({pid:process.pid,argv:process.argv,cwd:process.cwd(),synthetic:true}));const send=value=>console.log(JSON.stringify(value));send({type:'thread.started',thread_id:'regression-'+process.pid});send({type:'turn.started'});
const complete=()=>{send({type:'item.completed',item:{type:'agent_message',text:'QA_FIXTURE_RESULT '+path.basename(process.cwd())}});send({type:'turn.completed'});};
const waiting=input.includes('WAIT_FOR_QA')||input.includes('synthetic observer');if(!waiting){setTimeout(complete,50);return}
const timer=setInterval(()=>{if(fs.existsSync(path.join(base,'finish'))||fs.existsSync(path.join(process.cwd(),'finish'))){clearInterval(timer);complete();}},30);
});`;

export const bounded=async(promise,label,timeout=10000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' observation timed out; underlying work was not cancelled')),timeout);})]);}finally{clearTimeout(timer);}};
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(read,predicate,label,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await sleep(50);}throw new Error('Timed out: '+label);}
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const regular=file=>{const stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink(),file);};

export async function regressionContext(gate){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
 assert.ok(args.includes('--run'),'Prepared only; explicit --run is required');
 const target=option('--target'),source=option('--source'),mode=option('--mode'),inputPath=option('--inputs');
 requireNativeHost(target);assert.match(source||'',/^[a-f0-9]{40}$/);assert.ok(inputPath&&path.isAbsolute(inputPath));
 assert.equal(process.env.REVIEWOPS_LIVE_CODEX||'0','0');assert.equal(process.env.REVIEWOPS_LIVE_CLAUDE||'','');
 const packet=json(inputPath),root=fs.realpathSync(packet.repository);assert.equal(root,fs.realpathSync(process.cwd()));
 assert.equal(packet.target,target);assert.equal(packet.source,source);assert.equal(packet.mode,mode);assert.equal(packet.gate,gate);
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),source);
 assert.equal(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),'','Reviewed source must remain clean');
 const manifest=json(packet.expectedFilesPath);assert.ok(Array.isArray(manifest.files)&&manifest.files.length>=20);
 for(const row of manifest.files){assert.ok(!path.isAbsolute(row.path)&&!row.path.split(/[\\/]/).includes('..'));assert.equal(fileHash(path.join(root,row.path)),row.sha256,row.path);}
 const renderer=json(packet.rendererBuildRecordPath);assert.equal(renderer.source,source);assert.equal(renderer.ok,true);assert.ok(renderer.files?.length);
 for(const row of renderer.files){assert.ok(row.path.startsWith('dist/')&&!row.path.split(/[\\/]/).includes('..'));assert.equal(fileHash(path.join(root,row.path)),row.sha256,row.path);}
 // The parent packet module verifies the full app/ASAR/bootstrap manifest again
 // immediately before launch. A missing verifier is a preparation error, never a skip.
 const packetModule=await import('./native-packet.mjs');
 assert.equal(typeof packetModule.verifyNativePacket,'function','Native packet verifier must be integrated before this gate can run');
 assert.equal(typeof packetModule.verifyNativeFixtureCleanup,'function','Whole native fixture cleanup observer must be integrated before app launch');
 const verification=await packetModule.verifyNativePacket(packet);
 assert.ok(verification,'A source/bundle verification receipt is required');
 const paths=privatePaths(packet.ownedRoot);assert.ok(path.isAbsolute(packet.outputDir)&&path.isAbsolute(packet.resultPath));
 assert.ok(inside(packet.outputDir,packet.resultPath));fs.mkdirSync(packet.outputDir,{recursive:true});
 const fixture=await packetModule.prepareNativeAgentFixture({packet,agentSource:AGENT_SOURCE,rpcSource:RPC_SOURCE});
 assert.ok(Array.isArray(fixture.files)&&fixture.files.length>0);assert.ok(path.isAbsolute(fixture.agentExecutable)&&inside(paths.root,fixture.agentExecutable));
 for(const row of fixture.files){assert.ok(path.isAbsolute(row.path)&&inside(paths.root,row.path));regular(row.path);assert.equal(fileHash(row.path),row.sha256,row.path);}
 assert.ok(fixture.files.some(row=>fs.realpathSync(row.path)===fs.realpathSync(fixture.agentExecutable)));
 const expectedAgent=AGENT_SOURCE.replace('FIXTURE_ROOT',JSON.stringify(paths.root));assert.equal(fs.readFileSync(fixture.agentScript,'utf8').replace(/^#![^\n]*\n/,''),expectedAgent);
 assert.equal(fs.readFileSync(fixture.rpcScript,'utf8').replace(/^#![^\n]*\n/,''),RPC_SOURCE);
 if(process.platform==='win32'){
  assert.ok(/\.exe$/i.test(fixture.agentExecutable),'Never run a .cmd/JS file directly on Windows');
  const pe=fs.readFileSync(fixture.agentExecutable);assert.equal(pe.toString('ascii',0,2),'MZ');const at=pe.readUInt32LE(0x3c);assert.equal(pe.toString('binary',at,at+4),'PE\0\0');assert.equal(pe.readUInt16LE(at+4),0x8664);
  for(const name of ['codex.dll','codex.runtimeconfig.json','codex.deps.json','fixture-config.json'])assert.ok(fixture.files.some(row=>row.path===path.join(path.dirname(fixture.agentExecutable),name)),'Missing native apphost dependency '+name);
 }
 const require=createRequire(path.join(root,'package.json')),{_electron:electron,expect}=require('@playwright/test');
 const launch=appPaths(target,{...packet,app:packet.appPath||packet.executablePath,installReceipt:packet.installReceiptPath,bundleManifest:packet.bundleManifestPath});
 const executable=fs.realpathSync(mode==='source'?require('electron'):launch.executablePath);
 if(packet.executablePath)assert.equal(executable,fs.realpathSync(packet.executablePath));
 const env=privateEnvironment(paths,fs.realpathSync(process.execPath));
 // Parent helper owns fixture-only discovery settings. Do not inherit a user env.
 for(const [key,value]of Object.entries(fixture.environment||{})){
  assert.ok(Object.hasOwn(env,key),'Unexpected fixture environment field '+key);
  if(key==='PATH')assert.ok(inside(paths.root,value.split(path.delimiter)[0]),'Fixture discovery must start inside the owned root');
  else if(['REVIEWOPS_SSH_CONFIG','REVIEWOPS_CODEX_SSH_CONFIG'].includes(key))assert.ok(inside(paths.home,value),'SSH config must remain in the owned home');
  else assert.equal(value,env[key],key+' must retain the isolated profile');
  env[key]=value;
 }
 for(const file of new Set([env.REVIEWOPS_SSH_CONFIG,env.REVIEWOPS_CODEX_SSH_CONFIG])){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# Private regression fixture; no operational SSH hosts\n');}
 const report={ok:false,gate,source,platform:process.platform,arch:process.arch,mode,syntheticCLI:true,externalAI:0,SSH:0,ownedRoot:paths.root,inputPath,inputSHA256:fileHash(inputPath),verification,fixture:{...fixture,environment:undefined},checks:[],photos:[],errors:[],startedAt:new Date().toISOString()};
 const save=()=>fs.writeFileSync(packet.resultPath,JSON.stringify(report,null,2));save();
 assert.equal(typeof packetModule.verifyWindowsAgentExit,'function','Exact Windows launcher/Node exit observer must be integrated');
 return {packet,root,paths,fixture,env,launch:{...launch,executablePath:executable},electron,expect,report,save,source,mode,target,verifyAgentExit:packetModule.verifyWindowsAgentExit,verifyFixtureCleanup:packetModule.verifyNativeFixtureCleanup,snapshotFixtureEvidence:packetModule.snapshotNativeFixtureEvidence};
}

export function retainApplication(application){
 const child=application.process(),owner={application,pid:child.pid,exitObserved:false,closedObserved:false};
 child.once('exit',(code,signal)=>{owner.exitObserved=true;owner.exit={code,signal};});application.once('close',()=>{owner.closedObserved=true;});return owner;
}
export async function launchRegression(context){
 context.launchAttempted=true;
 const original=await context.electron.launch({...context.launch,env:context.env,timeout:30000}),owner=retainApplication(original);
 // Only the harness's observations get deadlines. Product code, native capture
 // policy and underlying work are not changed or cancelled by this proxy.
 const app=new Proxy(original,{get(target,key){if(key==='evaluate')return (...args)=>bounded(target.evaluate(...args),'own Electron main observation',15000);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 context.application=app;context.owner=owner;
 const ipc=(page,action,payload={})=>bounded(page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload}),action,15000);
 context.ipc=ipc;const main=(await selectMainHost(app,until,ipc,bounded)).page;context.main=main;
 const actual=await bounded(app.evaluate(({app})=>({platform:process.platform,arch:process.arch,isPackaged:app.isPackaged,appPath:app.getAppPath(),executablePath:process.execPath,resourcesPath:process.resourcesPath})),'native app identity');
 assert.equal(`${actual.platform}-${actual.arch}`,context.target);assert.equal(actual.isPackaged,context.mode!=='source');assert.equal(fs.realpathSync(actual.executablePath),fs.realpathSync(context.launch.executablePath));
 assert.equal(fs.realpathSync(actual.appPath),fs.realpathSync(context.mode==='source'?context.root:path.join(context.launch.resources,'app.asar')));
 if(context.mode!=='source')assert.equal(fs.realpathSync(actual.resourcesPath),fs.realpathSync(context.launch.resources));
 const effective=await bounded(app.evaluate(({app})=>({OSHome:app.getPath('home'),nodeHome:process.getBuiltinModule('os').homedir(),userData:app.getPath('userData'),paths:Object.fromEntries(['HOME','USERPROFILE','CODEX_HOME','REVIEWOPS_DATA_DIR','REVIEWOPS_SSH_CONFIG','REVIEWOPS_CODEX_SSH_CONFIG'].map(key=>[key,process.env[key]])),sshAuthSocketPresent:Boolean(process.env.SSH_AUTH_SOCK),credentialNames:['OPENAI_API_KEY','ANTHROPIC_API_KEY','AZURE_OPENAI_API_KEY','GH_TOKEN','GITHUB_TOKEN','AWS_ACCESS_KEY_ID'].filter(key=>Boolean(process.env[key]))})),'effective private consumers before account query');
 assert.ok(path.isAbsolute(effective.OSHome));assert.equal(fs.realpathSync(effective.nodeHome),context.paths.home);assert.equal(fs.realpathSync(effective.userData),context.paths.data);
 for(const key of ['HOME','USERPROFILE'])assert.equal(effective.paths[key],context.paths.home);assert.equal(effective.paths.CODEX_HOME,path.join(context.paths.home,'.codex'));assert.equal(effective.paths.REVIEWOPS_DATA_DIR,context.paths.data);for(const key of ['REVIEWOPS_SSH_CONFIG','REVIEWOPS_CODEX_SSH_CONFIG'])assert.equal(effective.paths[key],context.env[key]);
 for(const value of Object.values(effective.paths)){assert.ok(inside(context.paths.root,path.resolve(value)));if(fs.existsSync(value))assert.ok(inside(context.paths.root,fs.realpathSync(value)));}assert.equal(effective.sshAuthSocketPresent,false);assert.deepEqual(effective.credentialNames,[]);
 const isolated=await bounded(main.evaluate(async()=>({accounts:await window.accountManager.getState(),hosts:await window.hostManager.getState()})),'actual private accounts and hosts');assert.deepEqual(isolated.accounts.accounts,[]);assert.equal(isolated.accounts.runtime.available,false);assert.equal(isolated.accounts.runtime.path,null);assert.deepEqual(isolated.hosts.hosts,[]);
 context.report.effectivePrivateConsumers=effective;context.report.appIdentity=actual;context.save();
 await bounded(app.evaluate(({dialog})=>{dialog.showMessageBoxSync=(_host,options)=>{if(options.title!=='저장하지 않은 내용')throw new Error('Unexpected cleanup confirmation');return 1;};}),'controlled own-fixture unload choice');
 return {app,owner,main,ipc};
}
export async function nativeSourceRead(app,page,sourceURL,browserId,ipc,expression){
 const source=await sourceIdentity(app,page,sourceURL,browserId,ipc,bounded);
 return bounded(app.evaluate(({webContents},{id,expression})=>{const contents=webContents.fromId(id);if(!contents||contents.isDestroyed())throw new Error('Owned source is gone');return contents.executeJavaScript(expression);},{id:source.webContentsId,expression}),'exact native source read');
}
export async function capturePair(context,app,page,name,sourceURL,browserId,ipc){
 const host=await bounded(app.browserWindow(page),'photo own host handle');const capturedAt=new Date().toISOString();
 const original=await bounded(host.evaluate(async win=>{const image=await win.capturePage();return image.toDataURL();}),'full own app host photo',10000);
 const save=(suffix,image,scope)=>{const file=path.join(context.packet.outputDir,name+'-'+suffix+'.png');fs.writeFileSync(file,image.bytes);context.report.photos.push({file,capturedAt,sha256:image.sha256,width:image.width,height:image.height,edited:false,scope});};
 save('host',rawPNG(original),'Original full app host content; native source is separately recorded');
 if(sourceURL&&browserId)save('native',await nativePhoto(app,page,sourceURL,browserId,ipc,bounded),'Original exact native source; separate from app host');
 context.save();
}
export async function finishRegression(context,{app,owner,main,ipc,jobs=[],clients=[],server,release}={}){
 app ||= context.application;owner ||= context.owner;main ||= context.main;ipc ||= context.ipc;
 const issues=[];try{await release?.();}catch(error){issues.push({kind:'fixture-release',message:error.message});}
 if(context.launchAttempted&&!app)issues.push({kind:'app-launch-handle-unavailable',message:'An attempted Electron lifetime cannot be confirmed from a lost launch handle.'});
 if(app&&main&&!main.isClosed())for(const id of jobs){try{const state=await ipc(main,'agent.read',{id});if(['running','queued'].includes(state.status))await ipc(main,'agent.cancel',{id});await until(()=>ipc(main,'agent.read',{id}),value=>['completed','cancelled','failed','interrupted'].includes(value.status),'own agent terminal');}catch(error){issues.push({kind:'agent-terminal-unconfirmed',id,message:error.message});}}
 else if(jobs.length)issues.push({kind:'no-trusted-agent-consumer'});
 for(const client of clients)try{await bounded(client.close(),'owned MCP stdin EOF and process close',8000);}catch(error){issues.push({kind:'MCP-close-unconfirmed',message:error.message});}
 if(app&&!owner.exitObserved){try{await bounded(app.evaluate(({app})=>{setImmediate(()=>app.quit());}),'own app quit request',3000);await until(()=>owner,value=>value.exitObserved&&value.closedObserved,'own Electron exit and close',15000);}catch(error){issues.push({kind:'app-exit-unconfirmed',message:error.message});}}
 if(owner&&(!owner.exitObserved||!owner.closedObserved||owner.exit?.code!==0||owner.exit?.signal))issues.push({kind:'app-lifetime-unconfirmed',pid:owner.pid,exitObserved:owner.exitObserved,closedObserved:owner.closedObserved,exit:owner.exit});
 const agentObservations=[];
 try{
  for(const name of fs.readdirSync(context.paths.root).filter(name=>/^regression-agent-\d+-\d+\.json$/.test(name))){const file=path.join(context.paths.root,name);regular(file);const observed=json(file);assert.ok(Number.isInteger(observed.pid)&&observed.pid>0&&observed.synthetic===true);assert.equal(fs.realpathSync(observed.argv[0]),fs.realpathSync(process.execPath));assert.equal(fs.realpathSync(observed.argv[1]),process.platform==='win32'?fs.realpathSync.native(context.fixture.agentScript):fs.realpathSync(context.fixture.agentScript));assert.ok(inside(process.platform==='win32'?fs.realpathSync.native(context.paths.root):context.paths.root,fs.realpathSync(observed.cwd)));const exit=await context.verifyAgentExit(context.fixture,observed);agentObservations.push({observed,exit:exit||'Non-Windows: terminal product job plus own Electron exit observed'});}
  if(context.report.scenariosComplete)assert.equal(agentObservations.length,context.packet.gate==='panel8'?1:2,'Every real synthetic regression agent must have an exact identity record');
 }catch(error){issues.push({kind:'exact-agent-identity-exit-unconfirmed',message:error.message});}
 context.report.agentIdentityObservations=agentObservations;
 try{context.report.nativeFixtureCleanup=await context.verifyFixtureCleanup({packet:context.packet,fixture:context.fixture})||null;}catch(error){issues.push({kind:'native-fixture-lifetime-unconfirmed',message:error.message});}
 if(server?.listening)try{await bounded(new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),'own HTTP fixture server close',8000);}catch(error){issues.push({kind:'fixture-server-close-unconfirmed',message:error.message});}
 context.report.cleanup={status:issues.length?'cleanup-unconfirmed':'confirmed',issues,app:owner?{pid:owner.pid,exitObserved:owner.exitObserved,closedObserved:owner.closedObserved,exit:owner.exit}:null};
 context.report.ok=context.report.scenariosComplete===true&&issues.length===0;context.report.finishedAt=new Date().toISOString();
 if(issues.length){context.report.preservePrivateRoot=true;process.exitCode=1;}
 try{context.report.nativeFixtureEvidence=context.snapshotFixtureEvidence({packet:context.packet});}catch(error){context.report.ok=false;context.report.evidenceFailure=error.message;process.exitCode=1;}
 context.save();return context.report.cleanup;
}
export {selectProjectHost};
