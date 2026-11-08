'use strict';
// Synthetic protocol peer for the isolated chat UI suite. This never invokes
// a model or a command shell. Notifications are deliberately controlled proof
// inputs; actual application IPC, cancellation and persistence remain real.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const root=process.env.REVIEWOPS_CHAT_QA_FIXTURE_ROOT,args=process.argv.slice(2);
if(!root||!path.isAbsolute(root))throw new Error('A private chat QA fixture root is required.');
const log=value=>fs.appendFileSync(path.join(root,'protocol.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,cwd:process.cwd(),...value})+'\n');
const writeReceipt=(file,action)=>{const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify({ok:true,action}));fs.renameSync(temporary,file);};
if(args[0]==='--version'){console.log('codex-cli 0.166.0-alpha.5.1');process.exit();}
if(args[0]==='login'&&args[1]==='status')process.exit();
if(args[0]!=='app-server')process.exit(73);
for(const name of ['threads','responses'])fs.mkdirSync(path.join(root,name),{recursive:true});
log({event:'fixture-start'});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),respond=(id,result)=>send({id,result});
let thread,buffer='',seen=0;const acknowledgements=new Set();
const save=()=>{if(thread)fs.writeFileSync(path.join(root,'threads',thread.id+'.json'),JSON.stringify(thread));};
const view=()=>({...thread,turns:[]}),active=()=>thread?.turns.find(turn=>turn.status==='inProgress');
function emitItem(item,completed=false){const turn=active();if(!turn)throw new Error('No running controlled turn');const index=turn.items.findIndex(row=>row.id===item.id);if(index<0)turn.items.push(item);else turn.items[index]=item;thread.updatedAt++;save();send({method:completed?'item/completed':'item/started',params:{threadId:thread.id,turnId:turn.id,item}});}
function stream(text){const turn=active();if(!turn)throw new Error('No running controlled turn');let item=turn.items.find(row=>row.type==='agentMessage');if(!item){item={type:'agentMessage',id:'chat-message-'+randomUUID(),text:''};turn.items.push(item);}item.text+=text;thread.updatedAt++;save();send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:text}});}
function finish(status='interrupted'){
 const turn=active();if(!turn)return;
 for(const item of turn.items.filter(row=>row.type==='agentMessage'))send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});
 turn.status=status;thread.status.type='idle';thread.updatedAt++;save();send({method:'turn/completed',params:{threadId:thread.id,turn}});
}
async function receive(row){
 if(row.id==null)return;
 const params=row.params||{};log({direction:'client',id:row.id,method:row.method,params:row.method==='initialize'?null:params});
 if(!row.method){log({event:'typed-tool-response',id:row.id,success:row.result?.success===true});return;}
 if(row.method==='initialize')return respond(row.id,{userAgent:'reviewops-chat-qa-synthetic',platformFamily:process.platform,platformOs:process.platform});
 if(row.method==='config/read')return respond(row.id,{config:{model:'chat-qa-fixture',model_reasoning_effort:'low'}});
 if(row.method==='model/list')return respond(row.id,{data:[{model:'chat-qa-fixture',displayName:'Synthetic chat QA',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:null});
 if(row.method==='thread/start'){
  thread={id:'chat-thread-'+randomUUID(),status:{type:'idle'},updatedAt:1,turns:[],dynamicTools:params.dynamicTools||[]};save();send({method:'thread/started',params:{thread:view()}});return respond(row.id,{thread:view()});
 }
 if(row.method==='thread/resume')thread=JSON.parse(fs.readFileSync(path.join(root,'threads',params.threadId+'.json'),'utf8'));
 if(!thread||params.threadId!==thread.id)return send({id:row.id,error:{code:-32600,message:'Unknown controlled thread'}});
 if(['thread/read','thread/resume'].includes(row.method))return respond(row.id,{thread:view()});
 if(row.method==='thread/turns/list')return respond(row.id,{data:thread.turns.slice().reverse(),nextCursor:null});
 if(row.method==='thread/backgroundTerminals/list')return respond(row.id,{data:[],nextCursor:null});
 if(row.method==='thread/backgroundTerminals/clean')return respond(row.id,{});
 if(['thread/archive','turn/interrupt'].includes(row.method)){finish();return respond(row.id,{});}
 if(['turn/start','turn/steer'].includes(row.method)){
  let turn=active();if(row.method==='turn/steer'&&(!turn||turn.id!==params.expectedTurnId))return send({id:row.id,error:{code:-32600,message:'Turn changed'}});
  if(!turn){turn={id:'chat-turn-'+randomUUID(),status:'inProgress',itemsView:'full',items:[]};thread.turns.push(turn);thread.status.type='active';send({method:'turn/started',params:{threadId:thread.id,turn}});}
  emitItem({type:'userMessage',id:'chat-user-'+randomUUID(),content:params.input},true);
  const text=(params.input||[]).map(part=>part.text||'').join('\n');
  const ack=()=>{log({event:'turn-ack',turnId:turn.id});respond(row.id,row.method==='turn/steer'?{turnId:turn.id}:{turn});};
  if(text.includes('[CHATQA:DELAY_ACK]')){const timer=setTimeout(()=>{acknowledgements.delete(timer);ack();},45000);acknowledgements.add(timer);log({event:'turn-ack-delayed',turnId:turn.id,delayMs:45000});}
  else ack();
  return;
 }
 send({id:row.id,error:{code:-32601,message:'Unsupported controlled operation'}});
}
const timer=setInterval(()=>{
 if(!active())return;const file=path.join(process.cwd(),'qa-chat-controls.jsonl');if(!fs.existsSync(file))return;
 const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
 for(const line of lines.slice(seen)){
  const request=JSON.parse(line),receipt=path.join(root,'responses',request.id+'.json');if(fs.existsSync(receipt))continue;
  if(request.action==='stream')stream(request.text);
  else if(request.action==='command')emitItem({type:'commandExecution',id:request.itemId||'command-'+randomUUID(),command:request.text,status:request.status==='completed'?'completed':'inProgress'},request.status==='completed');
  else if(request.action==='tool'){
   const itemId=request.itemId||'tool-'+randomUUID();emitItem({type:'dynamicToolCall',id:itemId,tool:'ops_projects_list',status:'inProgress'});
   send({id:'typed:'+request.id,method:'item/tool/call',params:{threadId:thread.id,turnId:active().id,callId:'typed:'+request.id,namespace:null,tool:'ops_projects_list',arguments:{}}});
  }
  else if(request.action==='complete')finish(request.status||'completed');
  else if(request.action==='disconnect'){writeReceipt(receipt,request.action);log({event:'controlled-disconnect'});process.exit(78);}
  else throw new Error('Unsupported controlled action');
  writeReceipt(receipt,request.action);log({event:'control',...request});
 }
 seen=lines.length;
},20);
process.stdin.on('data',bytes=>{buffer+=bytes.toString('utf8');let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim())Promise.resolve(receive(JSON.parse(line))).catch(error=>{log({event:'fixture-error',message:error.message});process.exit(79);});}});
process.stdin.on('end',()=>{clearInterval(timer);for(const timer of acknowledgements)clearTimeout(timer);log({event:'fixture-end'});process.exit();});
