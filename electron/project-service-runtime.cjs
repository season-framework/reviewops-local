'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {atomicWrite}=require('./vault.cjs');
const PROTOCOL='reviewops-owned-node-v1',ACTIVE=new Set(['starting','running','stopping','stop-unconfirmed']),CONFIG_BUDGET=1024*1024;
const fail=(message,code='SERVICE_RUNTIME_INVALID')=>{throw Object.assign(new Error(message),{code});};
const inside=(root,target)=>{const r=path.relative(root,target);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
async function readSnapshot(target,maxBytes,role,root){
 const before=await fsp.lstat(target);
 if(!before.isFile()||before.isSymbolicLink()||before.size>maxBytes)fail('일반 파일의 허용 크기를 초과했습니다.');
 const file=await fsp.open(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const stat=await file.stat(),canonical=await fsp.realpath(target),named=await fsp.lstat(target);
  if(!stat.isFile()||stat.size>maxBytes||canonical!==target||root&&!inside(root,canonical)||named.isSymbolicLink()||named.dev!==stat.dev||named.ino!==stat.ino||before.dev!==stat.dev||before.ino!==stat.ino)fail('스냅샷 검사 중 파일 경로가 변경되었습니다.');
  const digest=crypto.createHash('sha256');let size=0;
  while(size<=maxBytes){const buffer=Buffer.alloc(Math.min(65536,maxBytes+1-size));const {bytesRead}=await file.read(buffer,0,buffer.length,size);if(!bytesRead)break;size+=bytesRead;if(size>maxBytes)fail('스냅샷 파일이 허용 크기를 초과했습니다.');digest.update(buffer.subarray(0,bytesRead));}
  const after=await file.stat(),finalNamed=await fsp.lstat(target);
  if(after.size!==size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||finalNamed.isSymbolicLink()||finalNamed.dev!==stat.dev||finalNamed.ino!==stat.ino||await fsp.realpath(target)!==target)fail('스냅샷 검사 중 파일 내용이 변경되었습니다.');
  return {path:target,size,sha256:digest.digest('hex'),checkedAt:new Date().toISOString(),role,loadedBytesVerified:false};
 }finally{await file.close();}
}
function normalizeConfig(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['executable','entry','args','readinessUrl'].includes(k)))fail('Node 서비스 설정을 확인하십시오.');
 const {executable,entry,args=[],readinessUrl}=value;
 if(typeof executable!=='string'||!path.isAbsolute(executable)||executable.length>4096||executable.includes('\0'))fail('Node 실행 파일의 전체 경로를 입력하십시오.');
 if(typeof entry!=='string'||path.isAbsolute(entry)||entry.includes('\0')||entry.length>4096||!entry.endsWith('.cjs'))fail('프로젝트 안의 상대 .cjs 실행 파일을 입력하십시오.');
 if(!Array.isArray(args)||args.length>64||args.some(v=>typeof v!=='string'||v.length>4096||v.includes('\0'))||Buffer.byteLength(JSON.stringify(args))>16384)fail('인수는 문자열 JSON 배열로 입력하십시오.');
 let url;try{url=new URL(readinessUrl);}catch{fail('로컬 HTTP 준비 상태 주소를 입력하십시오.');}
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.href.length>4096)fail('인증 정보가 없는 loopback HTTP 주소만 지원합니다.');
 url.hash='';return {executable,entry,args:[...args],readinessUrl:url.href};
}
function createProjectServiceRuntime({configPath,resolveBinding,spawnChild=spawn,stopTimeoutMs=3000,startTimeoutMs=5000,bootstrapPath=path.join(__dirname,'owned-node-bootstrap.cjs')}={}){
 const configurations=new Map(),instances=new Map(),generations=new Map();let closing=false,lifecycle=0;
 if(configPath&&fs.existsSync(configPath)){
  const bytes=fs.readFileSync(configPath);if(bytes.length>CONFIG_BUDGET)fail('서비스 설정 파일이 너무 큽니다.');
  const saved=JSON.parse(bytes);for(const row of saved.configurations||[])if(typeof row.projectId==='string'&&typeof row.connectionId==='string')configurations.set(row.projectId+'\0'+row.connectionId,{...row,config:normalizeConfig(row.config)});
 }
 const generation=id=>generations.get(id)||0;
 const key=(projectId,connectionId)=>projectId+'\0'+connectionId;
 function binding(projectId,connectionId){
  if(typeof projectId!=='string'||!projectId||typeof connectionId!=='string'||!connectionId)fail('프로젝트와 연결을 지정하십시오.');
  const value=resolveBinding(projectId,connectionId);
  if(!value||value.kind!=='local'||value.projectId!==projectId||value.connectionId!==connectionId||!path.isAbsolute(value.rootPath||''))fail('현재 프로젝트의 로컬 연결만 사용할 수 있습니다.','TARGET_MISMATCH');
  return {...value,generation:generation(projectId)};
 }
 const same=(a,b)=>a.generation===b.generation&&a.signature===b.signature&&a.rootPath===b.rootPath;
 const current=bound=>{if(!same(bound,binding(bound.projectId,bound.connectionId)))fail('서비스 작업 중 프로젝트 연결이 변경되었습니다.','STALE_CONTEXT');};
 const active=item=>item&&ACTIVE.has(item.status);
 const view=item=>item?{instanceId:item.instanceId,projectId:item.projectId,connectionId:item.connectionId,status:item.status,pid:item.pid||null,startedAt:item.startedAt,actual:item.actual||null,executableSnapshot:item.executableSnapshot||null,entrySnapshot:item.entrySnapshot||null,listeners:item.listeners||[],urlOwnership:'unverified',logTail:item.logTail||'',error:item.error||'',exit:item.exit||null}:null;
 const state=(projectId,connectionId)=>{const bound=binding(projectId,connectionId),saved=configurations.get(key(projectId,connectionId)),item=instances.get(key(projectId,connectionId));return {config:saved&&saved.signature===bound.signature?saved.config:null,instance:view(item)};};
 function persist(next=configurations){const bytes=JSON.stringify({version:1,configurations:[...next.values()]},null,2);if(Buffer.byteLength(bytes)>CONFIG_BUDGET)fail('전체 서비스 설정은 1 MiB 이하로 저장해야 합니다.','SERVICE_CONFIG_BUDGET');if(configPath)atomicWrite(configPath,bytes);}
 async function files(bound,config){
  const root=await fsp.realpath(bound.rootPath),entry=await fsp.realpath(path.resolve(root,config.entry)),executable=await fsp.realpath(config.executable);
  if(!inside(root,entry))fail('실행 파일은 프로젝트 작업 폴더 안에 있어야 합니다.');
  await fsp.access(executable,fs.constants.X_OK);
  const [entrySnapshot,executableSnapshot]=await Promise.all([readSnapshot(entry,20*1024*1024,'prelaunch-file-snapshot',root),readSnapshot(executable,200*1024*1024,'prelaunch-executable-snapshot')]);
  current(bound);return {root,entry,executable,executableSnapshot,entrySnapshot};
 }
 async function configure(projectId,connectionId,input){
  if(closing)fail('서비스를 종료하고 있습니다.');
  const bound=binding(projectId,connectionId),id=key(projectId,connectionId);if(active(instances.get(id)))fail('실행 중인 서비스를 중지한 뒤 설정을 변경하십시오.','SERVICE_BUSY');
  const config=normalizeConfig(input),revision=generation(projectId)+1,operationLifecycle=lifecycle;generations.set(projectId,revision);bound.generation=revision;
  await files(bound,config);current(bound);if(closing||operationLifecycle!==lifecycle)fail('앱 종료로 서비스 설정 저장을 취소했습니다.','STALE_CONTEXT');
  const next=new Map(configurations);next.set(id,{projectId,connectionId,signature:bound.signature,config});persist(next);
  configurations.set(id,next.get(id));return state(projectId,connectionId);
 }
 function send(item,type){
  if(item.exited||!item.child?.connected)return false;
  try{item.child.send({protocol:PROTOCOL,token:item.token,instanceId:item.instanceId,type},()=>{});return true;}catch{return false;}
 }
 async function start(projectId,connectionId){
  if(closing)fail('서비스를 종료하고 있습니다.');
  const bound=binding(projectId,connectionId),id=key(projectId,connectionId),saved=configurations.get(id);
  if(active(instances.get(id)))fail('이 프로젝트 연결의 서비스가 이미 실행 중입니다.','SERVICE_BUSY');
  if(!saved||saved.signature!==bound.signature)fail('현재 연결의 Node 서비스 설정을 먼저 저장하십시오.');
  const item={projectId,connectionId,instanceId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex'),status:'starting',startedAt:new Date().toISOString(),listeners:[],logTail:'',bound,exited:false,lifecycle};instances.set(id,item);
  try{
   const prepared=await files(bound,saved.config);current(bound);if(instances.get(id)!==item||item.cancelled||closing||item.lifecycle!==lifecycle)fail('서비스 실행 요청이 변경되었습니다.','STALE_CONTEXT');
   item.entrySnapshot=prepared.entrySnapshot;item.executableSnapshot=prepared.executableSnapshot;
   const env={};for(const name of ['PATH','HOME','TMPDIR','TMP','TEMP','SystemRoot','WINDIR','USERPROFILE','LOCALAPPDATA','APPDATA','LANG','LC_ALL','TZ'])if(process.env[name]!==undefined)env[name]=process.env[name];
   const child=spawnChild(prepared.executable,[bootstrapPath],{cwd:prepared.root,env,detached:true,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe','ipc']});item.child=child;item.pid=child.pid;
   item.exitPromise=new Promise(resolve=>{item.resolveExit=resolve;});
   const append=bytes=>{item.logTail=(item.logTail+bytes.toString()).slice(-65536);};child.stdout?.on('data',append);child.stderr?.on('data',append);
   const ended=(code,signal)=>{if(item.exited)return;item.exited=true;item.shutdownConfirmed=!item.stopRequested||item.drainReady&&code===0&&!signal;item.status=item.shutdownConfirmed?'exited':'stop-unconfirmed';item.listeners=[];item.exit={code,signal,at:new Date().toISOString(),drainConfirmed:!!item.drainReady};if(item.shutdownConfirmed&&item.stopRequested)item.error='';item.resolveExit();item.rejectReady?.(Object.assign(new Error(item.error||'Node 서비스가 준비 전에 종료되었습니다.'),{code:'SERVICE_EXITED'}));};
   child.once('exit',ended);child.on('error',error=>{item.error=String(error.message).slice(0,1000);if(!child.pid)ended(null,null);else item.rejectReady?.(error);});
   const ready=new Promise((resolve,reject)=>{item.rejectReady=reject;item.resolveReady=resolve;});
   child.on('message',message=>{
    if(!message||message.protocol!==PROTOCOL||message.token!==item.token||message.instanceId!==item.instanceId||item.exited)return;
    if(message.type==='ready'){
     if(message.pid!==child.pid||message.executable!==prepared.executable||typeof message.nodeVersion!=='string'||message.nodeVersion.length>100||message.cwd!==prepared.root||JSON.stringify(message.argv)!==JSON.stringify([prepared.executable,prepared.entry,...saved.config.args])||JSON.stringify(message.spawnArgv)!==JSON.stringify([prepared.executable,bootstrapPath])){item.error='Node 실행 정체성을 확인하지 못했습니다.';item.rejectReady(new Error(item.error));return;}
     if(item.status!=='starting')return;
     item.actual={executable:message.executable,argv:message.argv,spawnArgv:message.spawnArgv,cwd:message.cwd,nodeVersion:message.nodeVersion,reportedAt:message.reportedAt,source:'owned-child-ipc',loadedBytesVerified:false};item.status='running';item.resolveReady();
    }else if(message.type==='listeners'&&Array.isArray(message.listeners)){item.listeners=message.listeners.slice(0,32).filter(v=>v&&typeof v.address==='string'&&Number.isInteger(v.port)&&v.port>0&&v.port<=65535).map(v=>({address:v.address.slice(0,100),family:String(v.family).slice(0,20),port:v.port,source:'owned-child-net-server-listening'}));}
    else if(message.type==='drain-ready'&&item.stopRequested){item.drainReady=true;send(item,'drain-ack');}
    else if(message.type==='drain-error'){item.error=String(message.message).slice(0,1000);}
    else if(message.type==='error'){item.error=String(message.message).slice(0,1000);item.rejectReady(new Error(item.error));}
   });
   child.send({protocol:PROTOCOL,type:'init',token:item.token,instanceId:item.instanceId,entry:prepared.entry,args:saved.config.args},error=>{if(error)item.rejectReady(error);});
   let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Node 서비스 시작 응답을 확인하지 못했습니다.'),{code:'SERVICE_START_TIMEOUT'})),startTimeoutMs);})]);}finally{clearTimeout(timer);}
   current(bound);return state(projectId,connectionId);
  }catch(error){item.error=error.message;if(item.child&&!item.exited){try{await stopItem(item);}catch{}}else if(!item.child)item.status='failed';throw error;}
 }
 async function stopItem(item){
  if(item.exited){if(item.stopRequested&&!item.shutdownConfirmed)fail('서비스 종료를 확인하지 못했습니다. 강제 종료하지 않았습니다.','SERVICE_STOP_UNCONFIRMED');return;}
  if(!item.child)return;
  if(item.stopping)return item.stopping;
  item.stopping=(async()=>{
   item.status='stopping';item.stopRequested=true;send(item,'stop');let timer;
   try{await Promise.race([item.exitPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('서비스 종료를 확인하지 못했습니다. 강제 종료하지 않았습니다.'),{code:'SERVICE_STOP_UNCONFIRMED'})),stopTimeoutMs);})]);if(!item.shutdownConfirmed)fail('서비스 종료를 확인하지 못했습니다. 강제 종료하지 않았습니다.','SERVICE_STOP_UNCONFIRMED');}
   catch(error){if(!item.exited){item.status='stop-unconfirmed';item.error=error.message;}throw error;}finally{clearTimeout(timer);item.stopping=null;}
  })();return item.stopping;
 }
 function own(projectId,connectionId,instanceId){const bound=binding(projectId,connectionId),item=instances.get(key(projectId,connectionId));if(!item||item.instanceId!==instanceId||!same(bound,item.bound))fail('현재 프로젝트 연결의 서비스 인스턴스만 사용할 수 있습니다.','TARGET_MISMATCH');return item;}
 async function stop(projectId,connectionId,instanceId){const item=own(projectId,connectionId,instanceId);if(item.status==='starting'&&!item.child)fail('서비스 시작 응답을 기다린 뒤 중지하십시오.','SERVICE_BUSY');await stopItem(item);current(item.bound);return state(projectId,connectionId);}
 async function restart(projectId,connectionId,instanceId){const item=own(projectId,connectionId,instanceId);await stopItem(item);current(item.bound);return start(projectId,connectionId);}
 function assertMutationAllowed({projectIds=[],connectionIds=[],all=false}={}){
  if([...instances.values()].some(item=>active(item)&&(all||projectIds.includes(item.projectId)||connectionIds.includes(item.connectionId))))fail('소유 서비스를 중지한 뒤 프로젝트 연결·삭제·복원을 변경하십시오.','SERVICE_BUSY');
 }
 function invalidate(projectId){generations.set(projectId,generation(projectId)+1);}
 function forgetConfigurations(){assertMutationAllowed({all:true});persist(new Map());for(const row of configurations.values())invalidate(row.projectId);configurations.clear();}
 // The callback is the complete synchronous store/vault transaction, including
 // SQLite COMMIT. Resetting inside its callback alone cannot cover COMMIT failure.
 function withConfigurationReset(change){
  assertMutationAllowed({all:true});
  const saved=new Map(configurations),revisions=new Map(generations),existed=!!configPath&&fs.existsSync(configPath),bytes=existed?fs.readFileSync(configPath):null;
  if(bytes&&bytes.length>CONFIG_BUDGET)fail('서비스 설정 파일이 너무 큽니다.');
  forgetConfigurations();
  try{return change();}catch(error){
   let rollbackError;
   try{if(configPath){if(existed)atomicWrite(configPath,bytes);else try{fs.unlinkSync(configPath);}catch(failure){if(failure.code!=='ENOENT')throw failure;}}}catch(failure){rollbackError=failure;}
   configurations.clear();for(const [id,value] of saved)configurations.set(id,value);
   generations.clear();for(const [id,value] of revisions)generations.set(id,value);
   if(rollbackError)throw Object.assign(new Error('서비스 설정을 되돌리지 못했습니다. 데이터 폴더의 쓰기 권한을 확인하십시오.'),{code:'SERVICE_CONFIG_ROLLBACK_FAILED',cause:rollbackError,originalError:error});
   throw error;
  }
 }
 async function close(){
  closing=true;const closingLifecycle=++lifecycle;
  for(const item of instances.values())if(item.status==='starting'&&!item.child){item.cancelled=true;item.status='failed';item.error='앱 종료로 서비스 시작을 취소했습니다.';}
  try{await Promise.all([...instances.values()].filter(active).map(stopItem));}catch(error){if(lifecycle===closingLifecycle)closing=false;throw error;}
 }
 function resume(){closing=false;}
 return {configure,state,start,stop,restart,assertMutationAllowed,invalidate,revision:generation,forgetConfigurations,withConfigurationReset,close,resume,hasActive:()=>[...instances.values()].some(active)};
}
module.exports={createProjectServiceRuntime,normalizeConfig,readSnapshot};
