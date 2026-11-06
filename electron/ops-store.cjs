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
const QA_BINDING_FIELDS=['state','projectId','projectEpoch','projectBirth','clientId','sessionId','windowId','threadId','turnId','appInstanceId','attachedAt','releasedAt','reason','lastError'];
const QA_RECEIPT_FIELDS=['callId','tool','argsDigest','status','projectId','projectEpoch','projectBirth','threadId','turnId','appInstanceId','createdAt','completedAt','binding','capture','error','result'];
function validateQaBinding(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!QA_BINDING_FIELDS.includes(key))||!['attached','released','stale','unknown','unavailable'].includes(value.state))fail();for(const [key,entry]of Object.entries(value))if(key==='projectBirth'?!Number.isSafeInteger(entry)||entry<1:!text(entry,['reason','lastError'].includes(key)?2000:512))fail();}
function validateQaReceipt(value,history=false){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>![...QA_RECEIPT_FIELDS,...(history?['id','type','reason']:[])].includes(key))||!text(value.callId,512)||!value.callId||!text(value.tool,100)||!/^ops_qa_[a-z_]+$/.test(value.tool)||!/^[a-f0-9]{64}$/.test(value.argsDigest||'')||!['prepared','completed','failed','unknown'].includes(value.status))fail();
  for(const key of ['projectId','projectEpoch','threadId','turnId','appInstanceId','createdAt'])if(!text(value[key],512))fail();if(!Number.isSafeInteger(value.projectBirth)||value.projectBirth<1)fail();
  if(value.completedAt!==undefined&&!text(value.completedAt,64))fail();if(value.binding)validateQaBinding(value.binding);
  if(value.capture){const c=value.capture;if(Object.keys(c).some(key=>!['id','sha256','size','mimeType','width','height','relativePath'].includes(key))||!UUID.test(c.id)||!/^[a-f0-9]{64}$/.test(c.sha256||'')||!Number.isSafeInteger(c.size)||c.size<1||c.size>2*1024*1024||c.mimeType!=='image/png'||!Number.isSafeInteger(c.width)||!Number.isSafeInteger(c.height)||c.width<1||c.height<1||c.width>32768||c.height>32768||c.relativePath!==c.id+'.png')fail();}
  if(value.error){if(Object.keys(value.error).some(key=>!['code','message','inputMayHaveApplied'].includes(key))||!text(value.error.code,128)||!text(value.error.message,2000)||typeof value.error.inputMayHaveApplied!=='boolean')fail();}
  if(value.result){const allowed=['projectId','clientId','sessionId','windowId','browserId','documentId','contract','url','title','applied','released','closed','reloaded','availability','bindingState','capturedAt','width','height','mimeType','viewport','imageToCss'];if(typeof value.result!=='object'||Array.isArray(value.result)||Object.entries(value.result).some(([key,entry])=>!allowed.includes(key)||(!['viewport','imageToCss'].includes(key)&&!(text(entry,4096)||typeof entry==='boolean'||typeof entry==='number'&&Number.isFinite(entry)))))fail();for(const [field,keys]of [['viewport',['width','height','scrollX','scrollY']],['imageToCss',['scaleX','scaleY']]])if(value.result[field]){const numbers=value.result[field];if(typeof numbers!=='object'||Array.isArray(numbers)||Object.entries(numbers).some(([key,entry])=>!keys.includes(key)||!Number.isFinite(entry)||Math.abs(entry)>1e9||field==='imageToCss'&&entry<=0))fail();}}
}
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
    if(g.targetLockIdentities!==undefined&&(!Array.isArray(g.targetLockIdentities)||g.targetLockIdentities.length<1||g.targetLockIdentities.length>8||g.targetLockIdentities.some(value=>!text(value,512)||!value)))fail();
    if(g.projectConnectionSignature!==undefined&&!/^[a-f0-9]{64}$/.test(g.projectConnectionSignature))fail();
    if(g.qaBinding!==undefined&&g.qaBinding!==null)validateQaBinding(g.qaBinding);
    if(g.qaReceipts!==undefined){if(!Array.isArray(g.qaReceipts)||g.qaReceipts.length>10000)fail();const calls=new Set();for(const receipt of g.qaReceipts){validateQaReceipt(receipt);if(calls.has(receipt.callId))fail();calls.add(receipt.callId);}}
    if(g.threadId)threads.add(g.threadId);
    for(const s of g.schedules){if(!s||!UUID.test(s.id)||schedules.has(s.id)||s.goalId!==g.id||!text(s.name,200)||!s.name.trim()||!text(s.prompt,100000)||typeof s.enabled!=='boolean')fail();validateSchedule(s.cron,s.timezone);schedules.add(s.id);}
    for(const h of g.history){if(!h||!UUID.test(h.id)||!text(h.type,80)||!text(h.reason||'',100000)||h.prompt!==undefined&&!text(h.prompt,2*1024*1024))fail();if(h.type==='qa.operation')validateQaReceipt(h,true);}
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
  restore(value,{pause=true}={}){const next=validateOpsData(value);next.revision=this.data.revision+1;for(const goal of next.goals){if(pause){if(goal.status!=='finished')goal.status='paused';goal.executionState=goal.threadId?'unknown':'idle';goal.waitingReason='백업에서 복원했습니다. 기존 세션을 확인한 뒤 재개하십시오.';}if(goal.qaBinding&&goal.qaBinding.state!=='unavailable')goal.qaBinding={...goal.qaBinding,state:'stale',reason:'복원한 QA 기록은 현재 앱의 창 연결 소유권을 부여하지 않습니다.'};for(const receipt of goal.qaReceipts||[])if(receipt.status==='prepared'){receipt.status='unknown';const history=goal.history.find(row=>row.type==='qa.operation'&&row.callId===receipt.callId);if(history)history.status='unknown';}}this.persist(next);this.data=next;return this.read();}
}
module.exports={OpsStore,validateOpsData,RECOVERY_POLICY,DEFAULT_PROMPT};
