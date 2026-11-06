import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

if(!process.argv.includes('--real-codex'))throw new Error('Run this account-backed feature check with --real-codex.');
const require=createRequire(import.meta.url),{OpsManager}=require('../electron/ops-manager.cjs'),{createOpsSession}=require('../electron/ops-session.cjs'),{RpcClient}=require('../electron/codex/rpc-client.cjs');
const binary=fs.realpathSync(process.env.REVIEWOPS_E2E_CODEX_BINARY||execFileSync('/usr/bin/which',['codex'],{encoding:'utf8'}).trim());
const root=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-ops-manager-real-')),workPath=path.join(root,'work'),dataPath=path.join(root,'data');fs.mkdirSync(workPath);
const output=path.join(process.cwd(),'test-results','ops-manager-real',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const nonce=randomUUID(),calls=[],toolCalls=[],clients=[],checks=[];let manager,recovered,goalId,waitingId,threadId,turnId,failure;
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const firstTool=deferred(),releaseFirst=deferred(),thirdTool=deferred(),releaseThird=deferred();
const wait=async(predicate,timeout=180000)=>{const until=Date.now()+timeout;while(Date.now()<until){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw new Error('The owned Ops scenario did not reach its expected state.');};
const awaitGate=(promise,message)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),180000);})]).finally(()=>clearTimeout(timer));};
const factory=options=>createOpsSession({...options,rpcFactory:config=>{const rpc=new RpcClient(config),request=rpc.request.bind(rpc);rpc.request=async(method,params)=>{calls.push({method,threadId:params?.threadId,turnId:params?.turnId,deliveryId:params?.clientUserMessageId,prompt:['turn/start','turn/steer'].includes(method)?params.input?.[0]?.text:undefined});return request(method,params);};clients.push(rpc);return rpc;},tools:options.tools.map(tool=>({...tool,execute:async(args,context)=>{
 const result=await tool.execute(args,context);toolCalls.push({name:tool.name,args,context});
 if(['ops_schedules_save','ops_schedules_delete'].includes(tool.name)){const mutations=toolCalls.filter(c=>['ops_schedules_save','ops_schedules_delete'].includes(c.name));if(mutations.length===1){firstTool.resolve();await releaseFirst.promise;}if(mutations.length===3){thirdTool.resolve();await releaseThird.promise;}}
 return result;
}}))});
const options={dataPath,createSession:factory,runtime:{command:binary,args:[],available:true},schedulerOptions:{setTimer:()=>1,clearTimer:()=>{}}};
const instruction=`This is an isolated Ops feature acceptance in a temporary folder. Do not use shell, file, network, search or other tools. Use only this goal's schedule tools. First call ops_schedules_save with id "", name "Original ${nonce}", prompt "No execution is authorized by this disabled test schedule.", cron "0 0 1 1 *", timezone "UTC", enabled false, reason "Create the owned acceptance schedule". Then update that exact returned schedule ID with name "Updated ${nonce}" and otherwise the same disabled settings, reason "Update the owned acceptance schedule". Then delete that exact schedule ID with reason "Remove the completed acceptance schedule". Do not create any other schedule. Reply OPS_MANAGER_${nonce} after these operations.`;
try{
 manager=new OpsManager(options);manager.configure({commonPrompt:'Execute only the isolated acceptance instructions. Every schedule tool is scoped to this goal. Do not use any other tools or perform product development in the temporary target.'});
 let state=await manager.saveGoal({name:'Owned Ops manager acceptance',description:'A real model exercises its own durable schedule tools and one persistent conversation.',workPath,prompt:'Follow the specific acceptance request in this conversation. Preserve completed steps when steering arrives; do not repeat a successful schedule creation. Use only this goal\'s schedule tools.',approvalPolicy:'never',sandboxMode:'workspace-write'});goalId=state.goals.at(-1).id;
 state=await manager.saveGoal({name:'Owned target exclusion',description:'This goal must not start while the first owns the same canonical folder.',workPath,prompt:'Do not perform work. Reply only if this goal is explicitly started without a conflicting owner.',approvalPolicy:'never',sandboxMode:'workspace-write'});waitingId=state.goals.at(-1).id;
 await manager.goalAction({goalId,action:'start',instruction});await awaitGate(firstTool.promise,'The real model did not create its owned schedule.');
 let goal=manager.snapshot().goals.find(g=>g.id===goalId);threadId=goal.threadId;turnId=goal.turnId;assert.ok(threadId&&turnId);assert.equal(goal.toolReceipts.length,1);
 await manager.goalAction({goalId:waitingId,action:'start'});await manager.pumpAll();const waiting=manager.snapshot().goals.find(g=>g.id===waitingId);assert.equal(waiting.executionState,'waiting');assert.equal(waiting.threadId,null);assert.ok(waiting.waitingReason);
 checks.push('A live genuine Codex turn retained its canonical target claim and prevented another goal from starting in the same folder.');
 await manager.goalAction({goalId,action:'request',instruction:`Keep the same three create/update/delete schedule operations. For the update use name "Steered ${nonce}" instead of "Updated ${nonce}". Continue within this active turn; create no other schedule.`});await manager.pump(goalId);
 assert.equal(calls.filter(c=>c.method==='turn/start').length,1);assert.equal(calls.filter(c=>c.method==='turn/steer').length,1);assert.equal(manager.snapshot().goals.find(g=>g.id===goalId).turnId,turnId);releaseFirst.resolve();
 await awaitGate(thirdTool.promise,'The real model did not finish its own schedule mutations.');
 goal=manager.snapshot().goals.find(g=>g.id===goalId);assert.equal(goal.schedules.length,0);assert.equal(goal.toolReceipts.length,3);assert.ok(goal.toolReceipts.every(r=>r.threadId===threadId&&r.turnId===turnId));
 assert.deepEqual(goal.history.filter(h=>h.actor==='codex').map(h=>h.type),['schedule.created','schedule.updated','schedule.deleted']);assert.ok(goal.history.some(h=>h.type==='schedule.updated'&&h.schedule.name===`Steered ${nonce}`));
 for(const request of calls.filter(c=>['turn/start','turn/steer'].includes(c.method))){const record=goal.history.find(h=>h.id===request.deliveryId);assert.ok(record);assert.equal(record.prompt,request.prompt);assert.equal(record.threadId,threadId);assert.equal(record.turnId,turnId);}
 checks.push('The real model created, updated and deleted only its own schedule, with three durable server-call/thread/turn receipts and exact start/steer prompts.');
 await manager.goalAction({goalId:waitingId,action:'pause'});const stopping=manager.goalAction({goalId,action:'pause'});await wait(()=>calls.some(c=>c.method==='turn/interrupt'));releaseThird.resolve();await stopping;
 goal=manager.snapshot().goals.find(g=>g.id===goalId);assert.equal(goal.status,'paused');assert.equal(goal.executionState,'idle');assert.equal(goal.turnId,null);assert.ok(goal.history.some(h=>h.type==='turn.completed'&&h.status==='interrupted'));
 checks.push('Pausing the goal confirmed interruption of the actual active turn without activating its waiting peer.');
 fs.writeFileSync(path.join(output,'before-restart.json'),JSON.stringify(manager.exportData(),null,2));await manager.close();manager=null;
 const starts=calls.filter(c=>c.method==='turn/start').length;recovered=new OpsManager(options);await recovered.init();goal=recovered.snapshot().goals.find(g=>g.id===goalId);assert.equal(goal.threadId,threadId);assert.equal(goal.status,'paused');assert.equal(goal.executionState,'idle');assert.equal(goal.toolReceipts.length,3);assert.equal(calls.filter(c=>c.method==='turn/start').length,starts);assert.equal(recovered.snapshot().goals.find(g=>g.id===waitingId).threadId,null);
 fs.writeFileSync(path.join(output,'after-restart.json'),JSON.stringify(recovered.exportData(),null,2));checks.push('A new manager/app-server process reconciled the original paused thread and durable receipts without a new model turn or replay.');
}catch(error){failure={code:error.code||'OPS_MANAGER_ACTUAL_QA_FAILED',message:error.message};process.exitCode=1;}
finally{
 releaseFirst.resolve();releaseThird.resolve();if(manager&&goalId)try{await manager.goalAction({goalId,action:'pause'});}catch{}
 for(const rpc of clients.filter(c=>!c.closed))if(threadId)try{await rpc.request('thread/archive',{threadId});}catch{}
 await manager?.close();await recovered?.close();
 const result={ok:checks.length===4&&!failure,checks,failure,threadId,turnId,modelTurns:calls.filter(c=>c.method==='turn/start').length,steers:calls.filter(c=>c.method==='turn/steer').length,toolMutations:toolCalls.filter(c=>['ops_schedules_save','ops_schedules_delete'].includes(c.name)).length,output,scope:'Real installed Codex and existing authentication through OpsManager, durable JSON store and goal-bound tools; local source feature test with controlled tool-response timing, not an installed package, physical two-PC or whole-release QA.'};
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(calls,null,2));fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(result));
}
