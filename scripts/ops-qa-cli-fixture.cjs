'use strict';

// Owned by e2e-ops-qa.mjs. The controlled lane exercises actual application
// tools; the optional real lane forwards every byte to the authenticated CLI.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const args=process.argv.slice(2),root=process.env.REVIEWOPS_OPS_QA_FIXTURE_ROOT;
if(!root||!path.isAbsolute(root))throw new Error('An isolated Ops QA fixture root is required.');
const log=entry=>fs.appendFileSync(path.join(root,'protocol.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,cwd:process.cwd(),...entry})+'\n');
fs.mkdirSync(path.join(root,'responses'),{recursive:true});
const real=process.env.REVIEWOPS_OPS_QA_REAL_CLI;
if(real){
 const child=spawn(real,args,{cwd:process.cwd(),env:process.env,stdio:['pipe','pipe','pipe']});log({event:'real-cli-start',childPid:child.pid,operation:args[0]});
 const inspect=(stream,direction)=>{let buffer='';stream.on('data',bytes=>{buffer+=bytes.toString('utf8');let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const row=JSON.parse(line),item=row.params?.item;const images=(row.result?.contentItems||[]).filter(part=>part.type==='inputImage').map(part=>{const value=part.imageUrl?.split(',')[1];if(!value)return {};const image=Buffer.from(value,'base64'),sha256=crypto.createHash('sha256').update(image).digest('hex'),file=sha256+'.png';fs.writeFileSync(path.join(root,'responses',file),image);return {file,size:image.length,sha256};});log({direction,method:row.method||null,threadId:row.params?.threadId||null,turnId:row.params?.turnId||null,tool:row.params?.tool||null,itemType:item?.type||null,images});}catch{/* Non-JSON diagnostics are never retained. */}}});};
 if(args[0]==='app-server'){inspect(process.stdin,'client');inspect(child.stdout,'server');}
 process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!child.killed)child.kill(signal);});
 child.once('error',()=>process.exit(79));child.once('exit',(code,signal)=>{log({event:'real-cli-exit',code,signal});process.exit(code??1);});
}else if(args[0]==='--version'){console.log('codex-cli 0.166.0-alpha.5.1');}
else if(args[0]==='login'&&args[1]==='status'){process.exit(0);}
else if(args[0]==='app-server'){
 const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),threadsPath=path.join(root,'threads');fs.mkdirSync(threadsPath,{recursive:true});
 let thread=null,buffer='',seen=0;const pending=new Map();
 const save=()=>{if(thread)fs.writeFileSync(path.join(threadsPath,thread.id+'.json'),JSON.stringify(thread));};
 const view=()=>({...thread,turns:[]});
 const finish=(status='interrupted')=>{const turn=thread?.turns.find(row=>row.status==='inProgress');if(turn){turn.status=status;thread.status.type='idle';thread.updatedAt++;save();send({method:'turn/completed',params:{threadId:thread.id,turn}});}};
 const respond=(id,result)=>send({id,result});
 async function receive(row){
  if(typeof row.id==='string'&&row.id.startsWith('qa-control:')){
   const request=pending.get(row.id);if(!request)return;pending.delete(row.id);
   const result=row.result||{success:false,error:row.error},images=[];
   for(const part of result.contentItems||[])if(part.type==='inputImage'&&part.imageUrl?.startsWith('data:image/png;base64,')){
    const bytes=Buffer.from(part.imageUrl.split(',')[1],'base64'),filename=request.id+'.png';fs.writeFileSync(path.join(root,'responses',filename),bytes);images.push({file:filename,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
   }
   const text=(result.contentItems||[]).filter(part=>part.type==='inputText').map(part=>part.text||'').join('\n');let data;try{data=JSON.parse(text);}catch{data={text};}
   fs.writeFileSync(path.join(root,'responses',request.id+'.json'),JSON.stringify({id:request.id,tool:request.tool,success:result.success===true,data,images}));log({event:'controlled-tool-result',callId:request.id,tool:request.tool,success:result.success===true,images});return;
  }
  if(row.id==null)return;const params=row.params||{};log({direction:'client',method:row.method,threadId:params.threadId||null,turnId:params.turnId||null});
  if(row.method==='initialize')return respond(row.id,{userAgent:'reviewops-ops-qa-controlled/0.166.0-alpha.5.1',platformFamily:process.platform,platformOs:process.platform});
  if(row.method==='config/read')return respond(row.id,{config:{model:'ops-qa-fixture',model_reasoning_effort:'low'}});
  if(row.method==='model/list')return respond(row.id,{data:[{model:'ops-qa-fixture',displayName:'Controlled Ops QA fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:null});
  if(row.method==='thread/start'){
   thread={id:'fixture-'+crypto.randomUUID(),status:{type:'idle'},updatedAt:1,turns:[],dynamicTools:params.dynamicTools||[]};save();send({method:'thread/started',params:{thread:view()}});return respond(row.id,{thread:view()});
  }
  if(row.method==='thread/resume')thread=JSON.parse(fs.readFileSync(path.join(threadsPath,params.threadId+'.json'),'utf8'));
  if(!thread||params.threadId!==thread.id)return send({id:row.id,error:{code:-32600,message:'Unknown controlled thread'}});
  if(['thread/read','thread/resume'].includes(row.method))return respond(row.id,{thread:view()});
  if(row.method==='thread/turns/list')return respond(row.id,{data:thread.turns.slice().reverse(),nextCursor:null});
  if(row.method==='thread/backgroundTerminals/list')return respond(row.id,{data:[],nextCursor:null});
  if(row.method==='thread/backgroundTerminals/clean')return respond(row.id,{});
  if(row.method==='thread/archive'){finish();return respond(row.id,{});}
  if(row.method==='turn/interrupt'){finish();return respond(row.id,{});}
  if(['turn/start','turn/steer'].includes(row.method)){
   let turn=thread.turns.find(value=>value.status==='inProgress');
   if(row.method==='turn/steer'&&(!turn||turn.id!==params.expectedTurnId))return send({id:row.id,error:{code:-32600,message:'Turn changed'}});
   if(!turn){turn={id:'fixture-turn-'+crypto.randomUUID(),status:'inProgress',itemsView:'full',items:[]};thread.turns.push(turn);thread.status.type='active';send({method:'turn/started',params:{threadId:thread.id,turn}});}
   const item={type:'userMessage',id:'fixture-item-'+crypto.randomUUID(),content:params.input};turn.items.push(item);thread.updatedAt++;save();send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});return respond(row.id,row.method==='turn/steer'?{turnId:turn.id}:{turn});
  }
  send({id:row.id,error:{code:-32601,message:'Unsupported controlled operation'}});
 }
 fs.mkdirSync(path.join(root,'responses'),{recursive:true});
 const timer=setInterval(()=>{
  if(!thread?.turns.some(row=>row.status==='inProgress'))return;
  const file=path.join(process.cwd(),'qa-controls.jsonl');if(!fs.existsSync(file))return;const rows=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
  for(const line of rows.slice(seen)){const request=JSON.parse(line);if(fs.existsSync(path.join(root,'responses',request.id+'.json')))continue;const turn=thread.turns.find(row=>row.status==='inProgress'),id='qa-control:'+request.id;pending.set(id,request);send({id,method:'item/tool/call',params:{threadId:thread.id,turnId:turn.id,callId:request.id,namespace:null,tool:request.tool,arguments:request.args}});}seen=rows.length;
 },20);
 process.stdin.on('data',bytes=>{buffer+=bytes.toString('utf8');let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim())Promise.resolve(receive(JSON.parse(line))).catch(error=>{log({event:'fixture-error',message:error.message});process.exitCode=1;});}});
 process.stdin.on('end',()=>{clearInterval(timer);process.exit();});
}
else{process.exitCode=73;}
