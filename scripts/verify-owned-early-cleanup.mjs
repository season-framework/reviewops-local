// Hosted diagnostic only. Import is inert; never changes the original driver result.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertNativeTarget,nativeOutput,nativeRendererRecord,observeOwnedCommand} from './owned-native-orchestration.mjs';
import {prepareNativePacket,verifyNativePacket,snapshotNativeFixtureEvidence} from './native-packet.mjs';

const message='OWNED_EARLY_CLEANUP_PROBE: three running agents before first observe';
const condition='three-running-before-first-observe-v1';
const positive=value=>Number.isSafeInteger(value)&&value>0;
const read=file=>{const stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024**2);return JSON.parse(fs.readFileSync(file,'utf8'));};
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');

// Pure checks only: an unrelated failure, incomplete lifetime or partial cleanup
// cannot turn into an expected pass just because a controlled marker was saved.
export function validateEarlyCleanupResult(report,observation,source){
 assert.equal(observation.exitObserved,true);assert.equal(observation.closeObserved,true);
 assert.equal(observation.signalSentByOrchestrator,false);assert.ok(positive(observation.retainedDriverPid));
 assert.equal(observation.exit?.code,1);assert.equal(observation.exit?.signal,null);
 assert.equal(observation.outcome?.complete,true);assert.equal(observation.outcome?.code,1);assert.equal(observation.outcome?.signal,null);
 assert.equal(report.source,source);assert.equal(report.dirty,false);assert.equal(report.target,'win32-x64');
 assert.equal(report.platform,'win32');assert.equal(report.arch,'x64');assert.equal(report.mode,'source');
 assert.equal(report.ok,false);assert.equal(report.syntheticCLI,true);assert.equal(report.externalAI,0);assert.equal(report.SSH,0);
 assert.equal(report.fullIssueComplete,false);assert.equal(report.failure?.message,message);assert.ok(report.failure.stack.includes('at agents ('));
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRendererRequests,[]);assert.equal(report.agentRuns.length,0);
 assert.deepEqual(report.checks.map(({id,name,status})=>({id,name,status})),[{id:'NEXT-015-001',name:'UI-save-start-provenance-and-core',status:'pass'}]);
 const marker=report.earlyCleanupProbe;assert.equal(marker.schema,1);assert.equal(marker.condition,condition);
 assert.equal(marker.source,source);assert.equal(marker.target,'win32-x64');assert.equal(marker.mode,'source');
 assert.equal(marker.tag,'normal');assert.equal(marker.ending,'normal');assert.equal(marker.phase,'after-three-CLI-argv-checks-before-first-observe');
 assert.ok(Number.isFinite(Date.parse(marker.at)));assert.ok(Date.parse(marker.at)<=Date.parse(report.failure.at));
 const markers=report.operations.filter(row=>row.action==='controlled-early-cleanup-failure');assert.equal(markers.length,1);
 const {action,at,...savedMarker}=markers[0];assert.equal(action,'controlled-early-cleanup-failure');
 // record() supplies its own timestamp before spreading the exact marker.
 assert.equal(at,marker.at);assert.deepEqual(savedMarker,Object.fromEntries(Object.entries(marker).filter(([key])=>key!=='at')));
 assert.equal(marker.jobs.length,3);assert.equal(new Set(marker.jobs.map(row=>row.id)).size,3);
 assert.deepEqual(marker.jobs.map(row=>row.role),['starter','inspect-1','inspect-2']);
 assert.equal(new Set(marker.jobs.map(row=>row.serviceId)).size,3);assert.equal(new Set(marker.jobs.map(row=>row.reviewId)).size,3);
 assert.equal(new Set(marker.jobs.map(row=>row.cli.pid)).size,3);
 for(const row of marker.jobs){
  assert.equal(row.status,'running');assert.equal(row.key,'normal-'+row.role);assert.ok(typeof row.id==='string'&&row.id.length>0);
  assert.ok(positive(row.cli.pid));assert.equal(row.cli.role,row.key);assert.ok(Array.isArray(row.cli.argv)&&row.cli.argv.length>=2);
  assert.ok(row.cli.argv.every(value=>typeof value==='string'));assert.equal(typeof row.cli.cwd,'string');assert.ok(row.cli.cwd.length>0);
 }
 assert.equal(marker.projectBindings.length,2);assert.deepEqual(marker.projectBindings.map(row=>row.label).sort(),['A','B']);
 assert.equal(new Set(marker.projectBindings.map(row=>row.projectId)).size,2);
 const a=marker.projectBindings.find(row=>row.label==='A');assert.equal(marker.service.projectId,a.projectId);assert.equal(marker.service.connectionId,a.connectionId);
 assert.ok(positive(marker.service.pid));assert.ok(typeof marker.service.instanceId==='string'&&marker.service.instanceId.length>0);
 const core=report.checks[0].actual.instance;assert.equal(core.instanceId,marker.service.instanceId);assert.equal(core.pid,marker.service.pid);
 assert.equal(report.cleanup?.status,'confirmed');assert.deepEqual(report.cleanup.issues,[]);
 assert.deepEqual(report.cleanup.appLifetimes,report.appLifetimes);assert.equal(report.appLifetimes.length,1);assert.equal(report.appLaunchAttempts.length,1);
 for(const owner of report.appLifetimes){
  assert.ok(positive(owner.pid));assert.equal(owner.exitObserved,true);assert.equal(owner.closedObserved,true);assert.equal(owner.exit?.code,0);assert.equal(owner.exit?.signal,null);
  const attempts=report.appLaunchAttempts.filter(row=>row.pid===owner.pid);assert.equal(attempts.length,1);assert.equal(attempts[0].status,'retained');
 }
 const stopped=report.operations.filter(row=>row.action==='cleanup-owned-runtime-confirmed');assert.equal(stopped.length,2);
 for(const binding of marker.projectBindings){
  const rows=stopped.filter(row=>row.projectId===binding.projectId);assert.equal(rows.length,1);const instance=rows[0].instance;
  assert.equal(instance.projectId,binding.projectId);assert.equal(instance.connectionId,binding.connectionId);assert.equal(instance.status,'exited');
  assert.ok(positive(instance.pid));assert.equal(instance.exit?.code,0);assert.equal(instance.exit?.signal,null);assert.equal(instance.exit?.drainConfirmed,true);
  if(binding.label==='A'){assert.equal(instance.instanceId,marker.service.instanceId);assert.equal(instance.pid,marker.service.pid);}
 }
 const native=report.nativeFixtureCleanup;assert.equal(native.status,'confirmed');assert.equal(native.signalsSent,0);
 assert.ok(Number.isSafeInteger(native.identityCount)&&native.identityCount>=6);assert.equal(native.observations.length,native.identityCount);
 assert.ok(native.observations.every(row=>positive(row.pid)&&typeof row.requestedStartTicks==='string'&&/^\d+$/.test(row.requestedStartTicks)&&row.originalRunning===false));
 for(const job of marker.jobs)assert.ok(native.observations.some(row=>row.pid===job.cli.pid),'Each actual CLI Node identity must be confirmed absent');
 assert.equal(report.nativeFixtureEvidenceFailure,undefined);assert.ok(report.nativeFixtureEvidence?.files.length>0);
 return {condition,source,target:'win32-x64',mode:'source',controlledFailure:message,namedOwnedChecksPassed:1,
  normalOwned16Passed:false,threeRunningJobIds:marker.jobs.map(row=>row.id),cleanupConfirmed:true,nativeIdentityCount:native.identityCount,
  appLifetimes:report.appLifetimes,harnessOrchestratorSignalsSent:0,nativeIdentityInspectorSignalsSent:0,
  originalProductAgentCancelRetained:true,fullIssueComplete:false,existing16UniqueAdded:0};
}

export async function main(args=process.argv.slice(2)){
 assert.deepEqual([args[0],args[1],args[2],args[3]],['--run','--target','win32-x64','--source']);assert.equal(args.length,5);
 const source=args[4];assert.match(source,/^[a-f0-9]{40}$/);assertNativeTarget('win32-x64');
 assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_SHA,source);assert.equal(process.env.REVIEWOPS_OWNED_EARLY_FAILURE_PROBE,'1');
 const repository=fs.realpathSync(process.cwd()),outputDir=path.join(nativeOutput(repository,'win32-x64'),'early-cleanup-probe',new Date().toISOString().replace(/[:.]/g,'-'));
 const prepared=await prepareNativePacket({repository,target:'win32-x64',mode:'source',gate:'owned16',regressions:false,
  rendererBuildRecord:nativeRendererRecord(repository,'win32-x64'),outputDir});
 assert.equal(prepared.packet.source,source);
 const reportPath=path.join(outputDir,'driver-observation.json'),acceptancePath=path.join(outputDir,'early-cleanup-acceptance.json');
 const acceptance={schema:1,source,target:'win32-x64',condition,ok:false,resultPath:prepared.resultPath,observationPath:reportPath,
  ownedRoot:prepared.ownedRoot,privateRootRetained:true,normalOwned16Passed:false,fullIssueComplete:false};
 write(acceptancePath,acceptance);
 try{
  let driverFailure;
  try{await observeOwnedCommand({args:[path.join(repository,'scripts/e2e-owned-service-native.mjs'),'--run','--target','win32-x64','--mode','source','--source',source,'--inputs',prepared.inputPath],
   cwd:repository,env:{...process.env,REVIEWOPS_LIVE_CODEX:'0',REVIEWOPS_LIVE_CLAUDE:''},reportPath,timeoutMs:12*60000});}
  catch(error){driverFailure=error;acceptance.originalDriverError={name:error.name,message:error.message,resultPath:error.resultPath||null};write(acceptancePath,acceptance);}
  assert.ok(driverFailure,'The original driver must retain and rethrow the controlled failure');assert.equal(driverFailure.resultPath,reportPath);
  const report=read(prepared.resultPath),observation=read(reportPath),proof=validateEarlyCleanupResult(report,observation,source);
  verifyNativePacket(prepared.packet);Object.assign(acceptance,{ok:true,proof,finishedAt:new Date().toISOString()});write(acceptancePath,acceptance);return acceptance;
 }catch(error){
  acceptance.failure={name:error.name,message:error.message,stack:error.stack};acceptance.finishedAt=new Date().toISOString();write(acceptancePath,acceptance);
  try{snapshotNativeFixtureEvidence({packet:prepared.packet});}catch(cause){acceptance.snapshotFailure=cause.message;write(acceptancePath,acceptance);}
  throw Object.assign(error,{preservePrivateRoot:true,ownedRoot:prepared.ownedRoot,resultPath:prepared.resultPath});
 }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 main().then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
}
