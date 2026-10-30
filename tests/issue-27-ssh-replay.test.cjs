'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createAgentManager}=require('../electron/agents.cjs');
const line=event=>JSON.stringify(event)+'\n';
const config={id:'mock-replay',kind:'ssh',host:'replay.invalid',port:22,username:'tester',authType:'password',password:'mock-only',rootPath:'/isolated/project'};
const settings={binary:'codex',workPath:'/isolated/project',model:'chosen-model',reasoningEffort:'high'};
const timestamp='2026-10-30T06:00:00.000Z';
const progress=(sequence,message='명령 실행 완료')=>({sequence,state:'completed',message,step:'command_execution',createdAt:timestamp});
async function until(check) {for(let n=0;n<400;n++){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,3));}throw new Error('Mock replay did not settle');}
function fixture(t,{stdout,stderr=Buffer.alloc(0),saved,chunkSize=65536}) {
 const updates=[],server={state:'running',reads:0,starts:0};
 class Channel extends EventEmitter {
  constructor(command){super();this.command=command;this.stderr=new EventEmitter();}
  end(){queueMicrotask(()=>{try{
   let output='';
   if(this.command.includes('wc -c < "$d/stdout"')) {
    server.reads++;
    const outOffset=Number(this.command.match(/tail -c \+(\d+) "\$d\/stdout"/)[1])-1,errOffset=Number(this.command.match(/tail -c \+(\d+) "\$d\/stderr"/)[1])-1;
    output=[server.state,server.state==='done'?'0':'',String(stdout.length),String(stderr.length),stdout.subarray(outOffset,outOffset+chunkSize).toString('base64'),stderr.subarray(errOffset,errOffset+chunkSize).toString('base64')].join('\n')+'\n';
   } else if(!this.command.startsWith('rm -rf -- '))throw new Error('Unexpected command: '+this.command);
   if(output)this.emit('data',Buffer.from(output));this.emit('close',0);
  }catch(error){this.emit('error',error);}});return this;}
  signal(){}close(){this.emit('close',143);}
 }
 class Client extends EventEmitter {
  connect(){queueMicrotask(()=>this.emit('ready'));return this;}
  exec(command,_options,callback){callback(null,new Channel(command));}
  end(){if(this.destroyed)return;this.destroyed=true;this.emit('close');}destroy(){this.end();}
 }
 const manager=createAgentManager({ssh2:{Client},spawn(){throw new Error('Subprocess forbidden');},remotePollMs:3,remoteReconnectMs:3,commandTimeoutMs:1000,onUpdate:value=>updates.push(value)});
 t.after(()=>manager.closeAll({preserveRemote:true}));
 manager.restore({job:saved,config,settings});
 return {manager,updates,server,async caughtUp(){return until(()=>{const value=manager.read(saved.id);return value.remoteExecution.stdoutOffset===stdout.length&&value.remoteExecution.stderrOffset===stderr.length&&server.reads>1?value:null;});},async complete(){server.state='done';return until(()=>{const value=manager.read(saved.id);return value.status==='completed'?value:null;});}};
}
function savedJob(id,extra={}) {return {id,kind:'agent',reviewId:'review',serviceId:config.id,status:'running',response:'',output:'',sessionId:'saved-session',progress:[],progressOmitted:0,startedAt:timestamp,remoteExecution:{version:1,ready:true,stdoutOffset:0,stderrOffset:0},...extra};}

test('SSH replay preserves saved sequence, omitted count, event times and reported time with no new events',async t=>{
 const stdout=Buffer.from(line({type:'thread.started',thread_id:'saved-session'})+line({type:'turn.started',model:'actual-model',reasoning_effort:'medium'})+Array.from({length:120},(_,n)=>line({type:'item.completed',item:{id:'command-'+n,type:'command_execution',exit_code:0}})).join(''));
 const reportedSettings={model:'actual-model',reasoningEffort:'medium',source:'cli_event',eventType:'turn.started',reportedAt:timestamp};
 const saved=savedJob('replay-old',{output:stdout.toString(),progress:Array.from({length:100},(_,n)=>progress(25+n)),progressOmitted:24,reportedSettings,remoteExecution:{version:1,ready:true,stdoutOffset:stdout.length,stderrOffset:0}});
 const f=fixture(t,{stdout,saved,chunkSize:347}),running=await f.caughtUp();
 assert.deepEqual(running.progress,saved.progress);assert.equal(running.progressOmitted,24);assert.deepEqual(running.reportedSettings,reportedSettings);assert.equal(running.output,saved.output);assert.equal(running.sessionId,'saved-session');
 for(const update of f.updates)assert.deepEqual(update.progress,saved.progress);
 const finished=await f.complete();assert.equal(finished.progress.at(-1).sequence,125);assert.equal(finished.progressOmitted,25);assert.deepEqual(finished.progress.slice(0,-1),saved.progress.slice(1));assert.deepEqual(finished.reportedSettings,reportedSettings);assert.equal(f.server.starts,0);
});

test('SSH replay separates old and new events in one read and appends only unread output',async t=>{
 const old=line({type:'turn.started',model:'old-model'}),newEvent=line({type:'item.completed',item:{id:'new',type:'agent_message',text:'새 응답'}}),stdout=Buffer.from(old+newEvent),stderr=Buffer.from('이전 오류\n새 오류\n');
 const saved=savedJob('replay-crossing',{output:old+'이전 오류\n',response:'이전 응답',progress:[progress(7)],progressOmitted:0,reportedSettings:{model:'old-model',source:'cli_event',eventType:'turn.started',reportedAt:timestamp},remoteExecution:{version:1,ready:true,stdoutOffset:Buffer.byteLength(old),stderrOffset:Buffer.byteLength('이전 오류\n')}});
 const f=fixture(t,{stdout,stderr,saved}),running=await f.caughtUp();
 assert.equal(running.response,'새 응답');assert.equal(running.progress.length,2);assert.deepEqual(running.progress[0],saved.progress[0]);assert.equal(running.progress[1].sequence,8);assert.equal(running.output,saved.output+newEvent+'새 오류\n');assert.deepEqual(running.reportedSettings,saved.reportedSettings);
 const done=await f.complete();assert.equal(done.progress.at(-1).sequence,9);assert.equal(done.output.includes('\ufffd'),false);
});

test('SSH replay retains a partial JSON event and UTF8 bytes across the saved read position',async t=>{
 const earlier=line({type:'thread.started',thread_id:'saved-session'}),answer=line({type:'item.completed',item:{id:'answer',type:'agent_message',text:'한글 응답'}}),stdout=Buffer.from(earlier+answer),offset=stdout.indexOf(Buffer.from('한'))+1;
 const saved=savedJob('replay-utf8',{output:stdout.subarray(0,offset-1).toString(),progress:[progress(3,'대화 연결')],remoteExecution:{version:1,ready:true,stdoutOffset:offset,stderrOffset:0}});
 const f=fixture(t,{stdout,saved,chunkSize:31}),running=await f.caughtUp();assert.equal(running.response,'한글 응답');assert.equal(running.output,stdout.toString());assert.equal(running.progress.length,2);assert.equal(running.progress.at(-1).sequence,4);assert.deepEqual(running.progress[0],saved.progress[0]);await f.complete();
});

test('SSH restore before the first output byte keeps preparation records before new events',async t=>{
 const stdout=Buffer.from(line({type:'thread.started',thread_id:'new-session'})),saved=savedJob('replay-zero',{progress:[progress(1,'준비'),progress(2,'시작')]});
 const f=fixture(t,{stdout,saved}),running=await f.caughtUp();assert.deepEqual(running.progress.slice(0,2),saved.progress);assert.equal(running.progress.at(-1).sequence,3);assert.equal(running.sessionId,'new-session');await f.complete();
});
