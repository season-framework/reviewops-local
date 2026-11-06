'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {validateSchedule}=require('./ops-scheduler.cjs');
const MAX_STATE_BYTES=64*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DEFAULT_PROMPT='Work toward this Ops goal using its existing conversation and working target. On every request, assess the objective, current progress, and new user instructions. Continue actionable implementation and appropriate checks. Use only this goal\'s schedule tools to arrange useful follow-ups, explain every schedule change, and remove unnecessary schedules. Do not create work or repeated checks solely to remain busy. Report actual results and remaining conditions accurately.';
const RECOVERY_POLICY='Missed occurrences are combined once per goal at startup or resume; older occurrences are skipped. Paused and finished goals never restart automatically. Unconfirmed delivery is reconciled against the original Codex thread before replay. Backups restore Ops goals paused, retaining their prompts, history and session identity.';
function fail(message='Ops 저장 자료가 올바르지 않습니다.') {throw Object.assign(new Error(message),{code:'OPS_STORAGE_UNAVAILABLE'});}
function text(value,max){return typeof value==='string'&&value.length<=max&&!value.includes('\0');}
function validateOpsData(value){
  if(!value||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!text(value.commonPrompt,100000)||!Array.isArray(value.goals)||value.goals.length>100)fail();
  const ids=new Set(),schedules=new Set(),threads=new Set();
  for(const g of value.goals){
    if(!g||!UUID.test(g.id)||ids.has(g.id)||!text(g.name,200)||!g.name.trim()||!text(g.description,100000)||!text(g.prompt,100000)||!text(g.workPath,4096)||!(g.targetKind==='ssh'?path.posix:path).isAbsolute(g.workPath)||!text(g.projectId,128)||!['local','ssh'].includes(g.targetKind)||!text(g.targetIdentity,512)||!g.targetIdentity||
      !text(g.model,256)||!['','none','minimal','low','medium','high','xhigh','max','ultra'].includes(g.reasoningEffort)||
      !['read-only','workspace-write','danger-full-access'].includes(g.sandboxMode)||!['never','untrusted','on-request'].includes(g.approvalPolicy)||
      !['draft','active','paused','finished'].includes(g.status)||!['idle','starting','running','waiting','unknown','error'].includes(g.executionState)||!Array.isArray(g.schedules)||g.schedules.length>100||!Array.isArray(g.history)||!Array.isArray(g.conversation)||
      g.threadId!==null&&(!text(g.threadId,256)||!g.threadId||threads.has(g.threadId))||g.turnId!==null&&!text(g.turnId,256))fail();
    ids.add(g.id);
    if(g.threadId)threads.add(g.threadId);
    for(const s of g.schedules){if(!s||!UUID.test(s.id)||schedules.has(s.id)||s.goalId!==g.id||!text(s.name,200)||!s.name.trim()||!text(s.prompt,100000)||typeof s.enabled!=='boolean')fail();validateSchedule(s.cron,s.timezone);schedules.add(s.id);}
    for(const h of g.history)if(!h||!UUID.test(h.id)||!text(h.type,80)||!text(h.reason||'',100000)||h.prompt!==undefined&&!text(h.prompt,2*1024*1024))fail();
    for(const item of g.conversation)if(!item||!text(item.id,256)||!['user','assistant','system','tool'].includes(item.role)||!text(item.text,4*1024*1024))fail();
  }
  if(Buffer.byteLength(JSON.stringify(value))>MAX_STATE_BYTES)fail('Ops 기록이 64 MiB를 초과합니다. 기존 자료는 보존했습니다.');
  return structuredClone(value);
}
function initial(){return {version:1,revision:0,commonPrompt:DEFAULT_PROMPT,goals:[]};}
class OpsStore{
  constructor({dataPath}){
    if(typeof dataPath!=='string'||!path.isAbsolute(dataPath))fail();
    this.directory=path.join(dataPath,'ops');this.file=path.join(this.directory,'state.json');
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});this.check(this.directory,true);
    let fd;
    try{fd=fs.openSync(this.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));this.check(this.file,false);if(fs.fstatSync(fd).size>MAX_STATE_BYTES)fail();this.data=validateOpsData(JSON.parse(fs.readFileSync(fd,'utf8')));}
    catch(error){if(error.code!=='ENOENT')throw error;this.data=initial();this.persist(this.data);}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  check(location,directory){const stat=fs.lstatSync(location);if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||typeof process.getuid==='function'&&stat.uid!==process.getuid()||process.platform!=='win32'&&(stat.mode&0o077))fail('Ops 자료 폴더의 소유권과 접근 권한을 확인하십시오.');}
  persist(value){
    this.check(this.directory,true);try{this.check(this.file,false);}catch(error){if(error.code!=='ENOENT')throw error;}
    const temporary=path.join(this.directory,randomUUID()+'.tmp');let fd;
    try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,this.file);
      if(process.platform!=='win32'){const dir=fs.openSync(this.directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
    }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  read(){return structuredClone(this.data);}
  update(change){const next=this.read();change(next);next.revision=this.data.revision+1;validateOpsData(next);this.persist(next);this.data=next;return this.read();}
  restore(value,{pause=true}={}){const next=validateOpsData(value);next.revision=this.data.revision+1;if(pause)for(const goal of next.goals){if(goal.status!=='finished')goal.status='paused';goal.executionState=goal.threadId?'unknown':'idle';goal.waitingReason='백업에서 복원했습니다. 기존 세션을 확인한 뒤 재개하십시오.';}this.persist(next);this.data=next;return this.read();}
}
module.exports={OpsStore,validateOpsData,RECOVERY_POLICY,DEFAULT_PROMPT};
