'use strict';

const {randomUUID,createHash}=require('node:crypto');
const path=require('node:path');
const {OpsStore,validateOpsData,RECOVERY_POLICY}=require('./ops-store.cjs');
const {OpsScheduler,validateSchedule,nextOccurrence}=require('./ops-scheduler.cjs');
const {requireDirectory}=require('./work-directory.cjs');
const {requestTargetKey,conflictingTargets,executionIdentity}=require('./agent-requests.cjs');
const {executionSettings,requestContext}=require('./agent-execution-settings.cjs');
const {OpsManagement,EXECUTION}=require('./ops-management.cjs');
const CONFIG=['model','reasoningEffort','sandboxMode','approvalPolicy'];
const GOAL_FIELDS=['id','name','description','projectId','serviceId','workPath','prompt','skillIds','taskKinds',...CONFIG];
function fail(code,message){throw Object.assign(new Error(message),{code});}
function fields(input,names){if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).some(key=>!names.includes(key)))fail('INVALID_OPS_REQUEST','Ops 요청 항목을 확인하십시오.');return input;}
function string(value,max,name,required=false){if(typeof value!=='string'||value.length>max||value.includes('\0')||required&&!value.trim())fail('INVALID_OPS_REQUEST',`${name}을 확인하십시오.`);return value;}
function activeDelivery(goal){return [...goal.history].reverse().find(row=>row.type==='delivery'&&['prepared','accepted','unknown'].includes(row.status));}
function canonicalJSON(value){if(Array.isArray(value))return '['+value.map(canonicalJSON).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJSON(value[key])).join(',')+'}';return JSON.stringify(value);}
function terminalStatus(status){return status==='failed'?'failed':['interrupted','cancelled'].includes(status)?'interrupted':'completed';}
function qaResult(value){const keys=['projectId','clientId','sessionId','windowId','browserId','documentId','contract','url','title','applied','released','closed','reloaded','availability','bindingState','capturedAt','width','height','mimeType'],result=Object.fromEntries(keys.filter(key=>['string','number','boolean'].includes(typeof value?.[key])).map(key=>[key,typeof value[key]==='string'?value[key].slice(0,4096):value[key]]));for(const [field,allowed]of [['viewport',['width','height','scrollX','scrollY']],['imageToCss',['scaleX','scaleY']]])if(value?.[field])result[field]=Object.fromEntries(allowed.filter(key=>typeof value[field][key]==='number').map(key=>[key,value[field][key]]));return result;}

class OpsManager{
  constructor({dataPath,onChange=()=>{},resolveTarget=async input=>({workPath:await requireDirectory(input.workPath),projectId:input.projectId||'',targetKind:'local',targetIdentity:'local'}),resolveSessionTarget,resolveRuntime,runtime,createSession,createQaBridge,managementAdapter,skillProvider,validateQaContext=()=>{},appInstanceId=randomUUID(),now=Date.now,schedulerOptions={}}){
    this.store=new OpsStore({dataPath});this.onChange=onChange;this.resolveTarget=resolveTarget;this.resolveSessionTarget=resolveSessionTarget;this.resolveRuntime=resolveRuntime;this.runtime=runtime;this.createSession=createSession;this.now=now;
    this.sessions=new Map();this.pumps=new Map();this.messages=new Map();this.reconciling=new Map();this.lifecycle=new Map();this.draining=new Set();this.closed=false;this.suspended=false;this.revision=this.store.data.revision;
    this.dataPath=dataPath;this.appInstanceId=appInstanceId;this.createQaBridge=createQaBridge;this.validateQaContext=validateQaContext;this.qaBridges=new Map();this.qaTokens=new Map();this.qaReleases=new Map();this.retiring=new Map();this.retirementFailures=new Map();this.qaOperations=new Map();this.closing=false;
    this.scheduler=new OpsScheduler({tick:at=>this.tick(at),nextDue:()=>this.nextDue(),now,...schedulerOptions,onError:error=>this._schedulerError(error)});
    this.skillProvider=skillProvider;
    this.management=new OpsManagement(this,managementAdapter);
  }
  _open(){if(this.closed)fail('OPS_CLOSED','Ops가 종료되고 있습니다.');}
  _goal(data,id){const goal=data.goals.find(row=>row.id===id);if(!goal)fail('OPS_GOAL_NOT_FOUND','Ops 목표를 찾을 수 없습니다.');return goal;}
  _time(){return new Date(this.now()).toISOString();}
  _ownsTarget(goal){return this.retirementFailures.has(goal.id)||this.retiring.has(goal.id)||this.qaReleases.has(goal.id)||this.draining.has(goal.id)||Boolean(goal.turnId)||goal.modelState==='running'||goal.backgroundState==='active'||goal.backgroundCount>0||Boolean(goal.threadId&&goal.backgroundState!=='empty')||['running','starting','unknown'].includes(goal.executionState)||goal.history.some(h=>h.type==='delivery'&&['prepared','accepted','unknown'].includes(h.status));}
  _qaContext(id){const goal=this._goal(this.store.data,id);if(!this.qaTokens.has(id))this.qaTokens.set(id,Object.freeze({}));return {...Object.fromEntries(['projectId','projectEpoch','projectBirth','projectConnectionSignature','serviceId','workPath','threadId','turnId','status'].map(key=>[key,goal[key]])),goalId:id,appInstanceId:this.appInstanceId,lifecycleToken:this.qaTokens.get(id)};}
  _qaCurrent(context){const current=this._qaContext(context.goalId);if(this.closed||this.closing||this.suspended||current.status!=='active'||!current.threadId||!current.turnId||['lifecycleToken','appInstanceId','projectId','projectEpoch','projectBirth','projectConnectionSignature','serviceId','workPath','threadId','turnId'].some(key=>current[key]!==context[key]))fail('OPS_QA_SCOPE','현재 목표·프로젝트·실행의 QA 연결을 다시 확인하십시오.');this.validateQaContext(context);return true;}
  _qaAdmit(id,input){const context=input.context;this._qaCurrent(context);if(context.goalId!==id||typeof input.callId!=='string'||!input.callId||input.callId.length>512||typeof input.tool!=='string'||!/^ops_qa_[a-z_]+$/.test(input.tool))fail('INVALID_OPS_TOOL','목표 QA 도구의 원래 호출 식별자가 필요합니다.');const digest=createHash('sha256').update(canonicalJSON({tool:input.tool,args:input.args})).digest('hex');if(input.argsDigest!==digest)fail('INVALID_OPS_TOOL','QA 요청의 원래 내용을 확인할 수 없습니다.');const goal=this._goal(this.store.data,id),previous=(goal.qaReceipts||[]).find(row=>row.callId===input.callId);if(previous){if(previous.argsDigest!==digest||previous.tool!==input.tool||previous.threadId!==context.threadId||previous.turnId!==context.turnId)fail('OPS_TOOL_REPLAY_MISMATCH','같은 QA 호출의 내용이나 실행 소유자가 변경되었습니다.');if(['prepared','unknown'].includes(previous.status))fail('OPS_QA_OPERATION_UNKNOWN','이 QA 호출은 이미 시작되었으며 결과가 확인되지 않았습니다. 같은 호출을 다시 실행하지 마십시오.');return {reused:true,receipt:structuredClone(previous)};}if((goal.qaReceipts||[]).length>=10000)fail('OPS_QA_HISTORY_LIMIT','목표 QA 기록이 한도에 도달했습니다. 기존 기록은 보존했습니다.');return {reused:false};}
  _qaBinding(goal,binding,context){return {...binding,projectId:binding.projectId||context.projectId,projectEpoch:context.projectEpoch,projectBirth:context.projectBirth,threadId:context.threadId,turnId:context.turnId,appInstanceId:binding.appInstanceId||context.appInstanceId,state:binding.state||'attached',...(binding.state==='released'?{releasedAt:this._time()}:{attachedAt:this._time()})};}
  _qaStart(id,input){if(this._qaAdmit(id,input).reused)fail('OPS_QA_OPERATION_RECORDED','이미 완료한 QA 호출을 다시 시작할 수 없습니다.');this._mutate(data=>{const goal=this._goal(data,id),context=input.context;goal.qaReceipts??=[];const receipt={callId:input.callId,tool:input.tool,argsDigest:input.argsDigest,status:'prepared',projectId:context.projectId,projectEpoch:context.projectEpoch,projectBirth:context.projectBirth,threadId:context.threadId,turnId:context.turnId,appInstanceId:context.appInstanceId,createdAt:this._time()};if(input.binding){receipt.binding=this._qaBinding(goal,input.binding,context);goal.qaBinding=receipt.binding;}goal.qaReceipts.push(receipt);this._history(goal,'qa.operation','Codex가 목표에 연결된 QA 작업을 시작했습니다.',{...receipt,callId:input.callId,id:randomUUID()});});this.qaOperations.set(id+':'+input.callId,input.context);}
  _qaOutcome(id,input){if(this.closed)return;const existing=this.store.data.goals.find(goal=>goal.id===id);if(!existing)return;if(!input.callId){if(!input.binding||existing.qaBinding?.sessionId!==input.binding.sessionId||existing.qaBinding?.appInstanceId!==input.binding.appInstanceId)return;this._mutate(data=>{const goal=this._goal(data,id);goal.qaBinding={...goal.qaBinding,...input.binding,releasedAt:this._time()};this._history(goal,'qa.binding',input.binding.reason||'목표 QA 연결을 해제했습니다.',{status:input.status,projectId:input.binding.projectId,windowId:input.binding.windowId,sessionId:input.binding.sessionId});});return;}
    const context=this.qaOperations.get(id+':'+input.callId);if(!context)fail('OPS_QA_OPERATION_UNKNOWN','현재 앱이 시작한 원래 QA 호출을 확인할 수 없습니다.');let status=input.status;if(!['completed','failed','unknown'].includes(status))fail('INVALID_OPS_TOOL','QA 작업 결과를 확인하십시오.');try{this._qaCurrent(context);}catch{status='unknown';}
    this._mutate(data=>{const goal=this._goal(data,id),receipt=(goal.qaReceipts||[]).find(row=>row.callId===input.callId);if(!receipt)fail('OPS_QA_OPERATION_UNKNOWN','원래 QA 작업 기록을 찾을 수 없습니다.');receipt.status=status;receipt.completedAt=this._time();if(input.error)receipt.error={code:String(input.error.code||'OPS_QA_FAILED').slice(0,128),message:String(input.error.message||'QA 작업을 완료하지 못했습니다.').slice(0,2000),inputMayHaveApplied:Boolean(input.error.inputMayHaveApplied)};if(input.result)receipt.result=qaResult(input.result);if(input.capture)receipt.capture=structuredClone(input.capture);if(input.binding&&context){receipt.binding=this._qaBinding(goal,input.binding,context);if(status!=='unknown')goal.qaBinding=receipt.binding;}const history=[...goal.history].reverse().find(row=>row.type==='qa.operation'&&row.callId===input.callId);if(history)Object.assign(history,receipt,{id:history.id});});this.qaOperations.delete(id+':'+input.callId);
  }
  _qa(id){if(!this.createQaBridge)return null;if(!this.qaBridges.has(id))this.qaBridges.set(id,this.createQaBridge({goalId:id,appInstanceId:this.appInstanceId,captureDir:path.join(this.dataPath,'ops','captures',id),getContext:()=>this._qaContext(id),isCurrent:context=>this._qaCurrent(context),admit:input=>this._qaAdmit(id,input),recordStart:input=>this._qaStart(id,input),recordOutcome:input=>this._qaOutcome(id,input)}));return this.qaBridges.get(id);}
  _releaseQa(id,reason){this.qaTokens.set(id,Object.freeze({}));if(this.qaReleases.has(id))return this.qaReleases.get(id);const bridge=this.qaBridges.get(id);if(!bridge)return Promise.resolve({confirmed:true});const task=Promise.resolve().then(()=>bridge.release(reason)).then(()=>({confirmed:true})).catch(error=>{if(!this.closed&&this.store.data.goals.some(g=>g.id===id))this._mutate(data=>{const g=this._goal(data,id);g.executionState='unknown';g.lastError=String(error.message||error).slice(0,2000);if(g.qaBinding)g.qaBinding={...g.qaBinding,state:'unknown',lastError:g.lastError,reason};});return {confirmed:false,error};}).finally(()=>{if(this.qaReleases.get(id)===task)this.qaReleases.delete(id);if(!this.closed&&!this.closing)void this.pumpAll();});this.qaReleases.set(id,task);return task;}
  _retireIdleSession(id,reason){if(this.retiring.has(id))return this.retiring.get(id);const goal=this._goal(this.store.data,id),failed=this.retirementFailures.get(id);if(!failed&&this._ownsTarget(goal))return Promise.resolve();const session=failed?.session||this.sessions.get(id);
    // Detach before the first await, and retain admission until both the old
    // QA lease and this exact adapter have drained. Never close a replacement.
    if(this.sessions.get(id)===session)this.sessions.delete(id);const release=this._releaseQa(id,reason),task=Promise.resolve(release).then(async result=>{if(result?.confirmed===false)throw result.error;await session?.close?.();this.retirementFailures.delete(id);}).catch(error=>{this.retirementFailures.set(id,{session,reason});this._deliveryError(id,error);throw error;}).finally(()=>{if(this.retiring.get(id)===task)this.retiring.delete(id);if(!this.closed&&!this.closing)void this.pumpAll();});this.retiring.set(id,task);return task;}
  targetsChanged(){for(const id of this.qaBridges.keys())try{const context=this._qaContext(id);if(context.projectId)this.validateQaContext(context);}catch{void this._releaseQa(id,'원래 프로젝트 또는 연결이 변경되어 목표 QA 연결을 해제했습니다.');}}
  _activity(goal,modelState,backgroundState,backgroundCount){
    goal.modelState=modelState;goal.backgroundState=['active','empty','unknown'].includes(backgroundState)?backgroundState:'unknown';goal.backgroundCount=Number.isSafeInteger(backgroundCount)&&backgroundCount>=0?backgroundCount:null;
    const held=this.draining.has(goal.id)||['paused','finished'].includes(goal.status)&&(this.lifecycle.has(goal.id)||goal.executionState==='unknown');
    return held?'unknown':modelState==='running'?'running':modelState==='idle'&&goal.backgroundState==='active'?'running':modelState==='idle'&&goal.backgroundState==='empty'?'idle':'unknown';
  }
  _promptBudget(data){const {opsDeliveryPrompt}=require('./ops-session.cjs');for(const goal of data.goals){const parts=[data.commonPrompt,goal.name,goal.description,goal.workPath,goal.prompt,...goal.schedules.flatMap(s=>[s.name,s.prompt,s.cron,s.timezone])];try{opsDeliveryPrompt({deliveryId:'BUDGET',prompt:parts.join('\n')+'\n'+' '.repeat(40000)});}catch{fail('OPS_PROMPT_LIMIT','공통·목표·예약의 조립된 프롬프트가 너무 큽니다. 내용을 줄인 뒤 저장하십시오.');}}}
  _requestKey(goal,identity=goal.targetLockIdentity||goal.targetIdentity||''){return requestTargetKey({kind:goal.targetKind||'local',host:identity,hostAlias:'',sshConfigPath:'',port:0,username:''},{workPath:goal.workPath});}
  _requestKeys(goal){return [...new Set(goal.targetLockIdentities?.length?goal.targetLockIdentities:[goal.targetLockIdentity||goal.targetIdentity||'local'])].map(identity=>this._requestKey(goal,identity));}
  _history(goal,type,reason,extra={}){const row={id:randomUUID(),type,createdAt:this._time(),reason,...extra};
    if(type==='delivery'){
      // Reuse the native follow-up request's immutable execution contract. Ops
      // adds its own thread/turn journal rather than inventing review FK rows.
      Object.assign(row,{serviceId:goal.serviceId||null,targetKey:this._requestKey(goal),model:goal.model,reasoningEffort:goal.reasoningEffort,binary:'',settingsRecorded:true,newConversation:false,executionSettings:executionSettings(undefined,{model:goal.model,reasoningEffort:goal.reasoningEffort}),context:requestContext({instruction:true,attachmentIds:[],logIds:[]}),requestSignature:randomUUID()});
      row.goalTarget={projectId:goal.projectId||'',projectEpoch:goal.projectEpoch||null,projectBirth:goal.projectBirth||null,workPath:goal.workPath,targetIdentity:goal.targetIdentity||'local'};
      row.executionIdentityHash=createHash('sha256').update(executionIdentity(row)).digest('hex');
    }
    goal.history.push(row);goal.updatedAt=row.createdAt;return row;}
  _mutate(change){this._open();this.store.update(change);this._notify();this.scheduler.arm();return this.snapshot();}
  _notify(){this.revision++;try{this.onChange(this.snapshot());}catch{/* Renderer listeners do not own persistence. */}}
  snapshot(){const data=this.store.read(),runtime=typeof this.runtime==='function'?this.runtime():this.runtime;return {...data,managementConversations:this.management.snapshot(),availableSkills:this.skillProvider?.snapshot().skills||[],revision:this.revision,recoveryPolicy:RECOVERY_POLICY,runtime:runtime?{available:runtime.available!==false,path:runtime.path||runtime.command||'',version:runtime.version||'',error:runtime.error||null}:null,
    goals:data.goals.map(goal=>({...goal,qaBinding:goal.qaBinding||(!goal.projectId?{state:'unavailable',projectId:'',reason:'등록된 프로젝트를 사용하는 목표에서만 QA 창에 연결할 수 있습니다.'}:null),nextRunAt:goal.schedules.filter(s=>s.enabled).map(s=>s.nextRunAt).filter(Boolean).sort()[0]||null,
      conversation:[...goal.conversation.filter(row=>!this.messages.has(goal.id+':'+row.id)),...[...this.messages].filter(([key])=>key.startsWith(goal.id+':')).map(([,value])=>value)]}))};}
  nextDue(){if(this.suspended||this.closed)return null;return this.store.data.goals.filter(g=>g.status==='active').flatMap(g=>g.schedules.filter(s=>s.enabled).map(s=>s.nextRunAt)).filter(Boolean).sort()[0]||null;}
  async init(){
    // Apply the same actual execution contract to retained and new goals.
    if(this.store.data.goals.some(goal=>goal.sandboxMode!==EXECUTION.sandboxMode||goal.approvalPolicy!==EXECUTION.approvalPolicy))this._mutate(data=>{for(const goal of data.goals)Object.assign(goal,EXECUTION);});
    this.management.init();
    const goals=this.store.read().goals.filter(g=>g.threadId||activeDelivery(g));
    // Restore ownership before opening any connection. One unavailable server
    // must not delay the window or independently owned goals.
    if(goals.length)this._mutate(data=>{for(const goal of data.goals)if(goals.some(g=>g.id===goal.id)){goal.executionState='unknown';if(goal.threadId){goal.backgroundState='unknown';goal.backgroundCount=null;}goal.waitingReason='원래 Codex 세션과 작업 소유권을 확인하고 있습니다.';}});
    if(this.store.data.goals.some(g=>g.qaBinding||g.qaReceipts?.some(r=>r.status==='prepared')))this._mutate(data=>{for(const goal of data.goals){if(goal.qaBinding&&goal.qaBinding.state!=='unavailable')goal.qaBinding={...goal.qaBinding,state:'stale',reason:'이전 앱의 QA 연결입니다. 현재 실행에서 새 연결을 명시적으로 열어야 합니다.'};for(const receipt of goal.qaReceipts||[])if(receipt.status==='prepared'){receipt.status='unknown';receipt.error={code:'OPS_QA_OPERATION_UNKNOWN',message:'앱이 다시 시작되어 원래 QA 작업 결과를 확인할 수 없습니다.',inputMayHaveApplied:true};const history=goal.history.find(row=>row.type==='qa.operation'&&row.callId===receipt.callId);if(history){history.status='unknown';history.error=receipt.error;}}}});
    for(const goal of goals)void this.reconnect(goal.id).catch(error=>this._schedulerError(error));
    void this.scheduler.wake();return this.snapshot();
  }
  async saveGoal(input,guard=()=>{}){
    this._open();fields(input,GOAL_FIELDS);const before=input.id?this._goal(this.store.data,input.id):null;
    const raw={name:before?.name||'',description:before?.description||'',projectId:before?.projectId||'',serviceId:before?.serviceId||null,workPath:before?.workPath||'',prompt:before?.prompt||'',...(before?.skillIds!==undefined?{skillIds:before.skillIds}:{}),...(before?.taskKinds!==undefined?{taskKinds:before.taskKinds}:{}),model:before?.model||'',reasoningEffort:before?.reasoningEffort||'',...input,...EXECUTION};
    string(raw.name,200,'목표 이름',true);string(raw.description,100000,'설명');string(raw.prompt,100000,'목표 프롬프트');string(raw.model,256,'모델');
    string(raw.projectId,128,'프로젝트');string(raw.workPath,4096,'작업 폴더');if(raw.serviceId!==null)string(raw.serviceId,128,'프로젝트 연결');
    if(!['','none','minimal','low','medium','high','xhigh','max','ultra'].includes(raw.reasoningEffort)||!['read-only','workspace-write','danger-full-access'].includes(raw.sandboxMode)||!['never','untrusted','on-request'].includes(raw.approvalPolicy))fail('INVALID_OPS_REQUEST','Codex 실행 설정을 확인하십시오.');
    executionSettings(undefined,{model:raw.model,reasoningEffort:raw.reasoningEffort});
    if(this.skillProvider)this.captureSkills({instruction:raw.prompt,skillIds:raw.skillIds,taskKinds:raw.taskKinds});
    const target=await this.resolveTarget(raw);this._open();guard();const timestamp=this._time();
    const result=this._mutate(data=>{
      const goal=raw.id?this._goal(data,raw.id):null;
      if(goal&&(goal.workPath!==target.workPath||goal.projectId!==(target.projectId||'')||goal.targetIdentity!==(target.targetIdentity||'local')||goal.projectConnectionSignature&&target.projectConnectionSignature&&goal.projectConnectionSignature!==target.projectConnectionSignature||CONFIG.some(key=>goal[key]!==raw[key]))&&this._ownsTarget(goal))fail('OPS_GOAL_BUSY','실행 또는 전달 결과를 확인한 뒤 작업 대상과 실행 설정을 변경하십시오.');
      if(goal?.threadId&&goal.targetIdentity!==(target.targetIdentity||'local'))fail('OPS_SESSION_TARGET_CHANGED','기존 대화는 원래 작업 서버에 연결됩니다. 다른 서버는 새 목표로 등록하십시오.');
      const saved={...raw,workPath:target.workPath,projectId:target.projectId||'',projectEpoch:target.projectEpoch,projectBirth:target.projectBirth,projectConnectionSignature:target.projectConnectionSignature,targetKind:target.targetKind||'local',targetIdentity:target.targetIdentity||'local',targetLockIdentity:target.targetLockIdentity||target.targetIdentity||'local',targetLockIdentities:target.targetLockIdentities||[target.targetLockIdentity||target.targetIdentity||'local'],targetLabel:target.targetLabel||target.workPath,serviceId:target.serviceId||null,id:goal?.id||randomUUID(),updatedAt:timestamp};
      if(goal){Object.assign(goal,saved);this._history(goal,'goal.updated','사용자가 목표 설정을 변경했습니다.');this._rebasePending(goal,'목표 설정 변경으로 미전달 지시를 다시 조립했습니다.');}
      else{if(data.goals.length>=100)fail('OPS_LIMIT','목표는 100개까지 등록할 수 있습니다.');data.goals.push({...saved,status:'draft',executionState:'idle',threadId:null,turnId:null,lastError:null,lastWork:'',waitingReason:null,createdAt:timestamp,schedules:[],history:[],conversation:[],toolReceipts:[],qaReceipts:[]});}
      this._promptBudget(data);
    });
    if(before){const current=this._goal(this.store.data,before.id);if(!this._ownsTarget(current))await this._retireIdleSession(before.id,'목표 설정을 저장하여 유휴 QA 연결을 해제했습니다.');}
    return result;
  }
  async deleteGoal(id,guard=()=>{}){guard();const result=this._mutate(data=>{const goal=this._goal(data,id);if(goal.status==='active'||this._ownsTarget(goal))fail('OPS_GOAL_BUSY','목표를 일시정지하고 실행 결과를 확인한 뒤 삭제하십시오.');data.goals=data.goals.filter(g=>g.id!==id);});const session=this.sessions.get(id);this.sessions.delete(id);await this._releaseQa(id,'목표가 삭제되어 QA 연결을 해제했습니다.');this.qaBridges.delete(id);await session?.close?.();return result;}
  configure(input){fields(input,['commonPrompt']);string(input.commonPrompt,100000,'공통 실행 지침');return this._mutate(data=>{data.commonPrompt=input.commonPrompt;this._promptBudget(data);for(const goal of data.goals)this._rebasePending(goal,'공통 지침 변경으로 미전달 지시를 다시 조립했습니다.',data.commonPrompt);});}
  _layers(goal,{scheduleIds=[],reason='사용자 요청',instruction='',skills,commonPrompt=this.store.data.commonPrompt}={}){
    const schedules=scheduleIds.map(id=>goal.schedules.find(s=>s.id===id)).filter(Boolean);
    return [
      {name:'common',content:commonPrompt},
      {name:'goal',content:`Goal: ${goal.name}\nDescription: ${goal.description}\nWorking target: ${goal.workPath}\n\n${goal.prompt}`},
      {name:'schedule',content:schedules.map(s=>`Schedule: ${s.name}\nCron: ${s.cron} (${s.timezone})\n${s.prompt}`).join('\n\n')},
      {name:'request',content:instruction},
      {name:'skills',content:skills?this.captureSkills({inheritedSnapshot:skills}).prompt:''},
      {name:'context',content:`Reason: ${reason}\nGoal ID: ${goal.id}\nCurrent state: ${goal.status}\nLatest work: ${(goal.lastWork||'').slice(-8000)}\nOnly manage schedules belonging to this goal. Pausing or finishing the goal prevents automatic restarts.`}
    ];
  }
  _compose(goal,options,id,commonPrompt=this.store.data.commonPrompt){const layers=this._layers(goal,{...options,commonPrompt}),raw=layers.filter(l=>l.content).map(l=>`## ${l.name}\n${l.content}`).join('\n\n');const {opsDeliveryPrompt}=require('./ops-session.cjs');return {layers,prompt:opsDeliveryPrompt({deliveryId:id,prompt:raw})};}
  preview(input){fields(input,['goalId','scheduleId','reason','instruction']);const goal=this._goal(this.store.data,input.goalId),skills=this.captureSkills({instruction:[goal.prompt,input.instruction||'',goal.schedules.find(row=>row.id===input.scheduleId)?.prompt||''].join('\n'),skillIds:goal.skillIds,taskKinds:goal.taskKinds}).snapshot;return {...this._compose(goal,{skills,scheduleIds:input.scheduleId?[input.scheduleId]:[],reason:input.reason||'프롬프트 미리보기',instruction:input.instruction||''},'PREVIEW'),reason:input.reason||'프롬프트 미리보기',goalId:goal.id,scheduleId:input.scheduleId||null};}
  _receipt(goal,meta,args){
    if(!meta.callId)return null;
    if(typeof meta.callId!=='string'||meta.callId.length>512)fail('INVALID_OPS_TOOL','예약 도구의 호출 식별자가 올바르지 않습니다.');
    const digest=createHash('sha256').update(canonicalJSON({request:args,reason:meta.reason})).digest('hex');
    const previous=(goal.toolReceipts||[]).find(r=>r.callId===meta.callId);
    if(previous){if(previous.digest!==digest||previous.threadId!==meta.threadId||previous.turnId!==meta.turnId)fail('OPS_TOOL_REPLAY_MISMATCH','같은 도구 요청의 내용이나 실행 소유자가 변경되었습니다.');return {previous};}
    if(goal.status!=='active'||goal.threadId!==meta.threadId||goal.turnId!==meta.turnId)fail('OPS_TOOL_SCOPE','현재 목표의 실행에서만 예약을 변경할 수 있습니다.');
    return {digest};
  }
  _cancelPendingSchedule(goal,id){
    for(const old of [...goal.history])if(old.type==='delivery'&&old.status==='queued'&&old.scheduleIds?.includes(id)){
      old.status='cancelled';old.cancelledAt=this._time();old.cancelReason='예약이 삭제되거나 사용 중지되어 미전달 지시를 취소했습니다.';
      const remaining=old.scheduleIds.filter(sid=>sid!==id&&goal.schedules.some(s=>s.id===sid&&s.enabled));
      if(remaining.length){const deliveryId=randomUUID(),reason='예약 사용 변경 후 남은 예약 지시',skills=old.skills,assembled=this._compose(goal,{scheduleIds:remaining,reason,skills},deliveryId);this._history(goal,'delivery',reason,{id:deliveryId,status:'queued',scheduleId:remaining[0],scheduleIds:remaining,...(skills?{skills}:{}),prompt:assembled.prompt,layers:assembled.layers,threadId:goal.threadId,turnId:null});}
    }
  }
  _rebasePending(goal,reason,commonPrompt=this.store.data.commonPrompt){
    for(const old of [...goal.history])if(old.type==='delivery'&&old.status==='queued'){
      const scheduleIds=(old.scheduleIds||[]).filter(id=>goal.schedules.some(s=>s.id===id&&s.enabled)),instruction=old.layers?.find(l=>l.name==='request')?.content||'';
      old.status='replaced';old.replacedAt=this._time();if(old.scheduleIds?.length&&!scheduleIds.length){old.status='cancelled';continue;}
      const id=randomUUID(),skills=old.skills,assembled=this._compose(goal,{scheduleIds,reason:old.reason,instruction,skills},id,commonPrompt);old.replacedBy=id;
      this._history(goal,'delivery',old.reason,{id,status:'queued',scheduleId:scheduleIds[0]||null,scheduleIds,...(skills?{skills}:{}),prompt:assembled.prompt,layers:assembled.layers,threadId:goal.threadId,turnId:null,replacementReason:reason});
    }
  }
  saveSchedule(input,meta={}){
    fields(input,['goalId','id','name','prompt','cron','timezone','enabled']);string(input.name,200,'예약 이름',true);string(input.prompt,100000,'예약 프롬프트');if(typeof input.enabled!=='boolean')fail('INVALID_OPS_REQUEST','예약 사용 여부를 확인하십시오.');const valid=validateSchedule(input.cron,input.timezone);
    return this._mutate(data=>{
      const goal=this._goal(data,input.goalId),receipt=this._receipt(goal,meta,input);if(receipt?.previous)return;
      const previous=input.id?goal.schedules.find(s=>s.id===input.id):null;if(input.id&&!previous)fail('OPS_SCHEDULE_NOT_FOUND','목표의 예약을 찾을 수 없습니다.');
      if(!previous&&goal.schedules.length>=100)fail('OPS_LIMIT','목표마다 예약은 100개까지 등록할 수 있습니다.');
      const value={id:previous?.id||randomUUID(),goalId:goal.id,name:input.name,prompt:input.prompt,...valid,enabled:input.enabled,nextRunAt:input.enabled?nextOccurrence(valid.cron,valid.timezone,this.now()):null,lastRunAt:previous?.lastRunAt||null,lastResult:previous?.lastResult||null,createdAt:previous?.createdAt||this._time(),updatedAt:this._time()};
      if(previous)Object.assign(previous,value);else goal.schedules.push(value);
      this._promptBudget(data);
      if(!value.enabled)this._cancelPendingSchedule(goal,value.id);
      this._history(goal,previous?'schedule.updated':'schedule.created',meta.reason||'사용자가 예약을 저장했습니다.',{scheduleId:value.id,actor:meta.callId?'codex':'user',schedule:structuredClone(value),...(meta.callId?{callId:meta.callId,threadId:meta.threadId,turnId:meta.turnId}:{})});
      if(receipt){goal.toolReceipts??=[];goal.toolReceipts.push({callId:meta.callId,digest:receipt.digest,threadId:meta.threadId,turnId:meta.turnId,scheduleId:value.id,createdAt:this._time()});}
    });
  }
  deleteSchedule(input,meta={}){fields(input,['goalId','id']);return this._mutate(data=>{const goal=this._goal(data,input.goalId),receipt=this._receipt(goal,meta,input);if(receipt?.previous)return;const schedule=goal.schedules.find(s=>s.id===input.id);if(!schedule)fail('OPS_SCHEDULE_NOT_FOUND','목표의 예약을 찾을 수 없습니다.');goal.schedules=goal.schedules.filter(s=>s.id!==input.id);this._cancelPendingSchedule(goal,input.id);this._history(goal,'schedule.deleted',meta.reason||'사용자가 예약을 삭제했습니다.',{scheduleId:input.id,actor:meta.callId?'codex':'user',schedule,...(meta.callId?{callId:meta.callId,threadId:meta.threadId,turnId:meta.turnId}:{})});if(receipt){goal.toolReceipts??=[];goal.toolReceipts.push({callId:meta.callId,digest:receipt.digest,threadId:meta.threadId,turnId:meta.turnId,scheduleId:input.id,createdAt:this._time()});}});}
  _tools(id){
    const own=()=>structuredClone(this._goal(this.store.data,id).schedules),schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
    const reason={type:'string',minLength:1,maxLength:10000},field={type:'string'},run=(kind,args,context)=>{
      const names=kind==='delete'?['id','reason']:['id','name','prompt','cron','timezone','enabled','reason'];fields(args,names);string(args.reason,10000,'예약 변경 이유',true);
      const {reason,...input}=args;const meta={...context,reason};if(!meta.callId)fail('INVALID_OPS_TOOL','예약 도구의 원래 호출 식별자가 필요합니다.');
      if(kind==='delete')this.deleteSchedule({...input,goalId:id},meta);else{if(!input.id)delete input.id;this.saveSchedule({...input,goalId:id},meta);}return {schedules:own()};
    };
    return [
      {name:'ops_schedules_list',description:'List schedules belonging to this Ops goal only.',inputSchema:schema({}),execute:()=>({schedules:own()})},
      {name:'ops_schedules_save',description:'Create or update one schedule for this goal. Use an empty id to create. Record why this follow-up is needed.',inputSchema:schema({id:field,name:field,prompt:field,cron:field,timezone:field,enabled:{type:'boolean'},reason}),execute:(args,context)=>run('save',args,context)},
      {name:'ops_schedules_delete',description:'Delete an unnecessary schedule belonging to this goal and record the reason.',inputSchema:schema({id:field,reason}),execute:(args,context)=>run('delete',args,context)}
    ].concat(this._qa(id)?.tools||[],this.skillTools((args,context)=>{const goal=this._goal(this.store.data,id),delivery=[...goal.history].reverse().find(row=>row.type==='delivery'&&row.skills?.id===args.snapshotId&&['prepared','accepted'].includes(row.status));if(!delivery||goal.status!=='active'||goal.threadId!==context.threadId||goal.turnId!==context.turnId)fail('OPS_SKILL_SCOPE','원래 목표 요청에서 선택한 스킬만 읽을 수 있습니다.');return delivery.skills;},()=>{if(this.closed||this.closing||this.suspended)fail('OPS_SKILL_SCOPE','목표 실행을 확인하십시오.');}));
  }
  _session(id){let session=this.sessions.get(id);if(session)return session;const goal=this._goal(this.store.data,id),factory=this.createSession||require('./ops-session.cjs').createOpsSession;
    session=factory({goalId:id,workPath:goal.workPath,target:{kind:goal.targetKind||'local',identityKey:goal.targetIdentity||'local',projectId:goal.projectId,serviceId:goal.serviceId},resolveSessionTarget:this.resolveSessionTarget?()=>this.resolveSessionTarget(structuredClone(this._goal(this.store.data,id))):undefined,config:{...Object.fromEntries(CONFIG.map(k=>[k,goal[k]])),...EXECUTION},threadId:goal.threadId,runtime:typeof this.runtime==='function'?this.runtime():this.runtime,resolveRuntime:this.resolveRuntime?()=>this.resolveRuntime(structuredClone(this._goal(this.store.data,id))):typeof this.runtime==='function'?this.runtime:()=>this.runtime,onEvent:event=>this._event(id,event),tools:this._tools(id)});this.sessions.set(id,session);return session;}
  _event(id,event){
    if(this.closed)return;const current=this.store.data.goals.find(g=>g.id===id);if(!current)return;
    try{
      if(event.type==='message'){
        const message={id:String(event.itemId||event.id||randomUUID()),role:['user','assistant','system','tool'].includes(event.role)?event.role:'assistant',text:String(event.text||''),createdAt:this._time(),partial:Boolean(event.partial),...(typeof event.threadId==='string'&&event.threadId?{threadId:event.threadId}:{}),...(typeof event.turnId==='string'&&event.turnId?{turnId:event.turnId}:{})};
        if(message.role==='user'){const delivery=activeDelivery(current);if(delivery?.skills)message.skills=delivery.skills;}
        if(message.partial){this.messages.set(id+':'+message.id,message);this._notify();return;}
        this.messages.delete(id+':'+message.id);this._mutate(data=>{const g=this._goal(data,id),old=g.conversation.find(row=>row.id===message.id);if(old)Object.assign(old,message,{createdAt:old.createdAt});else g.conversation.push(message);if(message.role==='assistant')g.lastWork=message.text.slice(-8000);});return;
      }
      this._mutate(data=>{const goal=this._goal(data,id);if(event.threadId)goal.threadId=event.threadId;
        if(event.type==='turn.started'){goal.turnId=event.turnId;goal.modelState='running';goal.executionState='running';goal.waitingReason=null;goal.lastError=null;const pending=goal.history.find(h=>h.type==='delivery'&&h.status==='prepared'&&h.mode==='start');if(pending){pending.threadId=goal.threadId;pending.turnId=event.turnId;}}
        else if(event.type==='turn.completed'){if(!goal.turnId||goal.turnId===event.turnId){goal.executionState=this._activity(goal,'idle',event.backgroundState,event.backgroundCount);if(event.status==='failed'&&goal.executionState==='idle')goal.executionState='error';goal.turnId=null;goal.waitingReason=null;if(event.status==='failed')goal.lastError='Codex 실행이 실패했습니다. 기록을 확인한 뒤 재연결하십시오.';}for(const h of goal.history)if(h.type==='delivery'&&h.turnId===event.turnId&&['prepared','accepted'].includes(h.status)){h.status=terminalStatus(event.status);h.outcome=event.status||'completed';h.completedAt=this._time();}this._history(goal,'turn.completed',event.reason||'Codex 실행이 종료되었습니다.',{threadId:goal.threadId,turnId:event.turnId||null,status:event.status||'completed',backgroundState:goal.backgroundState,backgroundCount:goal.backgroundCount});}
        else if(event.type==='error'){goal.lastError=String(event.message||'Codex 연결 상태를 확인하십시오.');goal.executionState='unknown';const h=activeDelivery(goal);if(h)h.status='unknown';}
        else if(event.type==='delivery'){const h=goal.history.find(row=>row.id===event.deliveryId);if(h&&event.state==='accepted'){h.status='accepted';h.threadId=event.threadId||goal.threadId;h.turnId=event.turnId||goal.turnId;}else if(h&&event.state==='unknown')h.status='unknown';}
      });
      if(event.type==='turn.completed')void this.pumpAll();
    }catch(error){this._deliveryError(id,error);if(['thread','turn.started','delivery'].includes(event.type))throw error;}
  }
  _enqueue(id,{scheduleIds=[],reason,instruction='',skillSnapshot}){
    string(instruction,100000,'추가 지시');const deliveryId=randomUUID();
    this._mutate(data=>{const goal=this._goal(data,id);if(goal.status!=='active')fail('OPS_GOAL_INACTIVE','활성화된 목표에만 지시를 전달할 수 있습니다.');const skills=this.captureSkills({instruction:[goal.prompt,instruction,...scheduleIds.map(id=>goal.schedules.find(row=>row.id===id)?.prompt||'')].join('\n'),skillIds:goal.skillIds,taskKinds:goal.taskKinds,inheritedSnapshot:skillSnapshot}).snapshot;const assembled=this._compose(goal,{scheduleIds,reason,instruction,skills},deliveryId);this._history(goal,'delivery',reason,{id:deliveryId,status:'queued',scheduleId:scheduleIds[0]||null,scheduleIds,...(skills?{skills}:{}),prompt:assembled.prompt,layers:assembled.layers,threadId:goal.threadId,turnId:null});});
    void this.pump(id);return deliveryId;
  }
  _blocker(goal){const keys=this._requestKeys(goal);return this.store.data.goals.find(other=>other.id!==goal.id&&this._ownsTarget(other)&&this._requestKeys(other).some(first=>keys.some(second=>conflictingTargets(first,second))));}
  pump(id){if(this.pumps.has(id))return this.pumps.get(id);const task=this._pump(id).catch(error=>this._deliveryError(id,error)).finally(()=>{if(this.pumps.get(id)===task)this.pumps.delete(id);});this.pumps.set(id,task);return task;}
  async _pump(id){
    while(!this.closed&&!this.closing&&!this.suspended){
      const goal=this._goal(this.store.data,id);if(goal.status!=='active'||this.lifecycle.has(id)||this.reconciling.has(id)||this.qaReleases.has(id)||this.retiring.has(id)||this.retirementFailures.has(id)||goal.executionState==='unknown')return;
      const delivery=goal.history.find(row=>row.type==='delivery'&&row.status==='queued');if(!delivery)return;
      if(delivery.executionIdentityHash!==createHash('sha256').update(executionIdentity(delivery)).digest('hex'))fail('OPS_REQUEST_CHANGED','저장된 후속 요청의 실행 내용이 변경되었습니다. 원래 기록을 확인하십시오.');
      if(delivery.targetKey!==this._requestKey(goal)||delivery.model!==goal.model||delivery.reasoningEffort!==goal.reasoningEffort)fail('OPS_REQUEST_CHANGED','저장된 요청과 현재 대상·실행 설정이 다릅니다. 목표 설정을 저장해 미전달 요청을 다시 확인하십시오.');
      const blocker=this._blocker(goal);if(blocker){this._mutate(data=>{const g=this._goal(data,id);g.executionState='waiting';g.waitingReason=`${blocker.name} 목표가 겹치는 작업 폴더를 사용 중입니다.`;});return;}
      const target=await this.resolveTarget(goal);const live=this._goal(this.store.data,id);if(live.status!=='active'||this.suspended||this.closed||this.closing||this.qaReleases.has(id)||this.retiring.has(id)||this.retirementFailures.has(id))return;
      const currentDelivery=live.history.find(row=>row.id===delivery.id);
      if(!currentDelivery||currentDelivery.status!=='queued'||currentDelivery.executionIdentityHash!==delivery.executionIdentityHash)continue;
      if(target.workPath!==live.workPath||(target.targetIdentity||'local')!==(live.targetIdentity||'local')||live.projectConnectionSignature&&target.projectConnectionSignature&&live.projectConnectionSignature!==target.projectConnectionSignature)fail('OPS_TARGET_CHANGED','작업 폴더·서버 또는 Codex 실행 파일이 변경되었습니다. 원래 연결을 복원하여 실행을 확인하거나 목표 설정에서 대상을 다시 선택하십시오.');
      // Acquire the durable target claim and delivery journal before any send.
      // Another goal's pump rechecks this claim after its own asynchronous path lookup.
      const targetLockIdentities=[...new Set([...(live.targetLockIdentities||[live.targetLockIdentity||live.targetIdentity||'local']),...(target.targetLockIdentities||[target.targetLockIdentity||target.targetIdentity||'local'])])];
      const after=this._blocker({...live,targetLockIdentities});if(after){this._mutate(data=>{const g=this._goal(data,id);g.executionState='waiting';g.waitingReason=`${after.name} 목표가 겹치는 작업 폴더를 사용 중입니다.`;});return;}
      const mode=live.turnId&&live.executionState==='running'?'steer':'start';
      const session=this._session(id);let result;
      this._mutate(data=>{const g=this._goal(data,id),h=g.history.find(row=>row.id===delivery.id);h.status='prepared';h.mode=mode;h.preparedAt=this._time();g.targetLockIdentities=targetLockIdentities;if(target.projectConnectionSignature)g.projectConnectionSignature=target.projectConnectionSignature;g.executionState=mode==='steer'?'running':'starting';g.waitingReason=null;});
      try{result=await session[mode]({deliveryId:delivery.id,prompt:delivery.prompt,threadId:live.threadId,turnId:live.turnId});}
      catch(error){this._deliveryError(id,error,delivery.id);return;}
      if(this.closed)return;
      if(result.delivery!=='accepted'){this._mutate(data=>{const g=this._goal(data,id),h=g.history.find(row=>row.id===delivery.id);h.status='unknown';h.threadId=result.threadId||g.threadId;h.turnId=result.deliveryTurnId||result.turnId||null;g.threadId=h.threadId;g.executionState='unknown';g.lastError='원래 지시의 전달 결과를 확인하지 못했습니다. 중복 요청 없이 원래 세션을 확인하십시오.';});return;}
      this._mutate(data=>{const g=this._goal(data,id),h=g.history.find(row=>row.id===delivery.id);h.deliveredAt=this._time();h.threadId=result.threadId||g.threadId;h.turnId=result.deliveryTurnId||result.turnId||h.turnId||g.turnId;
        const terminal=g.history.find(row=>row.type==='turn.completed'&&row.turnId===h.turnId),outcome=terminal?.status||result.outcome;
        const completed=Boolean(terminal)||['completed','failed','interrupted'].includes(h.status)||Boolean(result.outcome);
        h.status=completed?terminalStatus(outcome||h.status):'accepted';if(outcome)h.outcome=outcome;g.threadId=h.threadId;g.turnId=completed?null:(result.activeTurnId||result.turnId||g.turnId);g.executionState=this._activity(g,completed||result.state==='idle'?'idle':'running',terminal?.backgroundState||result.backgroundState||g.backgroundState,terminal?.backgroundCount??result.backgroundCount??g.backgroundCount);if(outcome==='failed'&&g.executionState==='idle')g.executionState='error';g.lastError=outcome==='failed'?'Codex 실행이 실패했습니다. 기록을 확인하십시오.':null;for(const sid of h.scheduleIds||[]){const s=g.schedules.find(row=>row.id===sid);if(s)s.lastResult=h.status;}});
    }
  }
  _deliveryError(id,error,deliveryId){if(this.closed)return;try{this._mutate(data=>{const goal=this._goal(data,id),delivery=deliveryId?goal.history.find(h=>h.id===deliveryId):goal.history.find(h=>h.type==='delivery'&&h.status==='queued')||activeDelivery(goal);goal.lastError=String(error?.message||error);const notSent=error?.deliveryState==='not_sent';
    // A rejected new request cannot erase work owned by an earlier turn. For a
    // definite pre-send failure, exclude only that request's temporary claim.
    const retained=this._ownsTarget(notSent?{...goal,executionState:'error',history:goal.history.filter(h=>h.id!==delivery?.id)}:goal);
    goal.executionState=retained?notSent&&goal.turnId?'running':'unknown':'error';if(delivery){delivery.status=notSent||delivery.status==='queued'?'queued':goal.executionState==='unknown'?'unknown':'failed';delivery.error=goal.lastError;}this._history(goal,'error','실행 상태 확인이 필요합니다.',{message:goal.lastError});});}catch{/* Preserve the original store file if persistence itself failed. */}}
  _schedulerError(error){if(this.closed)return;try{this._mutate(data=>{data.lastError=String(error?.message||error);});}catch{/* A failed scheduler checkpoint never changes another goal's state. */}}
  async reconnect(id,pump=true){
    if(this.reconciling.has(id))return this.reconciling.get(id);
    const task=(async()=>{try{if(this.retiring.has(id))await this.retiring.get(id);if(this.retirementFailures.has(id))await this._retireIdleSession(id,'실패한 원래 QA·실행 연결 정리를 다시 확인했습니다.');}catch{return;}const goal=this._goal(this.store.data,id),delivery=activeDelivery(goal)||[...goal.history].reverse().find(h=>h.type==='delivery'&&h.threadId);if(!goal.threadId&&!delivery){if(pump)await this.pump(id);return;}
      let result;try{result=await this._session(id).reconcile({threadId:goal.threadId,turnId:goal.turnId,deliveryId:delivery?.id,prompt:delivery?.prompt});}catch(error){this._mutate(data=>{const g=this._goal(data,id);g.executionState='unknown';g.backgroundState='unknown';g.backgroundCount=null;g.lastError=String(error?.message||error);this._history(g,'error','기존 세션과 작업 소유권을 확인하지 못했습니다.',{message:g.lastError});});return;}
      this._mutate(data=>{const g=this._goal(data,id),h=delivery&&g.history.find(row=>row.id===delivery.id),finishedTurn=result.deliveryTurnId||result.turnId,outcome=result.outcome||result.turnStatus,terminal=['completed','failed','interrupted'].includes(outcome);if(result.threadId)g.threadId=result.threadId;g.turnId=result.state==='running'?(result.activeTurnId||result.turnId||null):null;g.executionState=this._activity(g,result.state,result.backgroundState,result.backgroundCount);g.lastError=g.executionState==='unknown'?'기존 세션과 백그라운드 작업 상태를 아직 확인하지 못했습니다.':null;
        if(h&&['prepared','unknown','accepted'].includes(h.status)){if(result.delivery==='accepted'){h.status=terminal?terminalStatus(outcome):result.state==='idle'?'unknown':'accepted';h.outcome=terminal?outcome:null;h.threadId=g.threadId;h.turnId=finishedTurn||h.turnId;if(h.status==='unknown')g.executionState='unknown';if(outcome==='failed'){if(g.executionState==='idle')g.executionState='error';g.lastError='Codex 실행이 실패했습니다. 기록을 확인하십시오.';}}else if(result.delivery==='not_found'&&result.state==='idle'&&result.safeToRetry===true){h.status='queued';}else{h.status='unknown';g.executionState='unknown';}}
        if(result.state==='idle'&&outcome&&!terminal)g.executionState='unknown';
        if(result.delivery==='accepted'&&finishedTurn&&terminal)for(const row of g.history)if(row.type==='delivery'&&row.status==='accepted'&&row.threadId===g.threadId&&row.turnId===finishedTurn){row.status=terminalStatus(outcome);row.outcome=outcome;row.completedAt=this._time();}
        if(g.executionState!=='unknown')g.waitingReason=null;else if(!g.lastError)g.lastError='기존 실행의 종료 결과를 아직 확인하지 못했습니다.';
        this._history(g,'session.reconciled','원래 Codex 세션과 전달 기록을 확인했습니다.',{threadId:g.threadId,turnId:g.turnId,status:g.executionState});
      });
      const current=this._goal(this.store.data,id);if(current.status!=='active'&&current.threadId)await this._interrupt(id);
    })().finally(()=>{this.reconciling.delete(id);if(pump)void this.pumpAll();});this.reconciling.set(id,task);return task;
  }
  async _interrupt(id){if(this.retiring.has(id))await this.retiring.get(id);if(this.retirementFailures.has(id))await this._retireIdleSession(id,'중지 전에 원래 QA·실행 연결 정리를 다시 확인했습니다.');const goal=this._goal(this.store.data,id),qaRelease=this._releaseQa(id,'목표 실행을 중지하여 QA 연결을 해제했습니다.');if(!goal.threadId){const qa=await qaRelease;if(qa?.confirmed===false)throw qa.error;if(goal.executionState==='unknown')fail('OPS_DELIVERY_UNKNOWN','원래 실행 결과를 확인한 뒤 중지하십시오.');this._mutate(data=>{const g=this._goal(data,id);g.executionState='idle';g.waitingReason=null;});return;}
    this.draining.add(id);this._mutate(data=>{this._goal(data,id).executionState='unknown';});
    try{
      let turnId=goal.turnId,confirmed=false;
      for(let attempt=0;attempt<3;attempt++){const result=await this._session(id).interrupt({threadId:goal.threadId,turnId});if(result?.confirmed===true){const finished=result.turnId||turnId;this._mutate(data=>{const g=this._goal(data,id);for(const h of g.history)if(h.type==='delivery'&&h.turnId===finished&&['prepared','accepted','unknown'].includes(h.status)){h.status=terminalStatus(result.status||'interrupted');h.outcome=result.status||'interrupted';h.completedAt=this._time();}});}if(result?.confirmed===true&&result.state==='idle'){confirmed=true;break;}if(result?.confirmed===true&&result.state==='running'&&result.activeTurnId&&result.activeTurnId!==turnId){turnId=result.activeTurnId;continue;}break;}
      if(!confirmed)fail('OPS_INTERRUPT_UNCONFIRMED','원래 Codex 실행과 백그라운드 작업의 중지를 확인하지 못했습니다. 연결을 다시 확인하십시오.');
      const qa=await qaRelease;if(qa?.confirmed===false)throw qa.error;
      this._mutate(data=>{const g=this._goal(data,id);g.turnId=null;g.modelState='idle';g.backgroundState='empty';g.backgroundCount=0;g.executionState='idle';g.waitingReason=null;g.lastError=null;});
    }finally{this.draining.delete(id);}
  }
  async goalAction(input,guard=()=>{},internal={}){fields(input,['goalId','action','instruction']);const {goalId:id,action}=input;this._goal(this.store.data,id);guard();
    if(action==='request'){this._enqueue(id,{reason:'사용자의 추가 지시',instruction:string(input.instruction,100000,'추가 지시',true),skillSnapshot:internal.skillSnapshot});return this.snapshot();}
    if(action==='reconnect'){await this.reconnect(id);guard();return this.snapshot();}
    if(!['start','resume','pause','finish'].includes(action))fail('INVALID_OPS_REQUEST','목표 작업을 확인하십시오.');
    if(this.lifecycle.has(id)){await this.lifecycle.get(id);return this.snapshot();}
    const task=(async()=>{
      if(action==='pause'||action==='finish'){
        void this._releaseQa(id,'사용자가 목표를 일시정지하거나 종료했습니다.');
        this._mutate(data=>{const goal=this._goal(data,id);goal.status=action==='pause'?'paused':'finished';if(goal.threadId)goal.executionState='unknown';this._history(goal,`goal.${goal.status}`,'사용자가 목표 실행을 변경했습니다.');if(action==='finish')for(const h of goal.history)if(h.type==='delivery'&&h.status==='queued')h.status='cancelled';});
        const pending=this.pumps.get(id);if(pending)await pending;try{await this._interrupt(id);}catch(error){this._deliveryError(id,error);}return;
      }
      const current=this._goal(this.store.data,id);if(current.status==='active')return;
      if(current.status==='finished'&&action!=='start')fail('OPS_GOAL_FINISHED','종료한 목표는 시작 버튼으로 다시 시작하십시오.');
      const startSkills=this.captureSkills({instruction:[current.prompt,input.instruction||''].join('\n'),skillIds:current.skillIds,taskKinds:current.taskKinds,inheritedSnapshot:internal.skillSnapshot}).snapshot;
      if(current.executionState==='unknown')await this.reconnect(id,false);
      if(this._goal(this.store.data,id).executionState==='unknown')fail('OPS_DELIVERY_UNKNOWN','원래 전달 결과를 확인한 뒤 재개하십시오.');
      guard();this._mutate(data=>{const goal=this._goal(data,id);goal.status='active';Object.assign(goal,EXECUTION);this._history(goal,`goal.${action}`,current.status==='finished'?'사용자가 종료한 목표를 기존 설정과 대화로 다시 시작했습니다.':'사용자가 목표 실행을 변경했습니다.');});
      this._enqueue(id,{reason:action==='start'?'목표 시작':'목표 재개',instruction:input.instruction||'',skillSnapshot:startSkills});
    })().finally(()=>{this.lifecycle.delete(id);void this.pumpAll();});this.lifecycle.set(id,task);await task;return this.snapshot();
  }
  async tick(at=this.now()){
    if(this.closed||this.suspended)return;
    // Probe only retained/uncertain owners. These are metadata reads, never new
    // model input, and normal model completion does not terminate a service.
    const probes=this.store.data.goals.filter(g=>g.threadId&&(g.executionState==='unknown'||this._ownsTarget(g)&&!g.turnId));
    for(const goal of probes)void this.reconnect(goal.id).catch(error=>this._schedulerError(error));
    if(this.closed||this.suspended)return;const due=[];
    for(const goal of this.store.data.goals)if(goal.status==='active'){const ids=goal.schedules.filter(s=>s.enabled&&s.nextRunAt&&new Date(s.nextRunAt).getTime()<=at).map(s=>s.id);if(ids.length)due.push({id:goal.id,ids});}
    for(const item of due){const id=randomUUID();try{this._mutate(data=>{const goal=this._goal(data,item.id),reason='예약 시각 도래: 누락된 반복은 목표별 한 번으로 모았습니다.';
      const skills=this.captureSkills({instruction:[goal.prompt,...item.ids.map(id=>goal.schedules.find(row=>row.id===id)?.prompt||'')].join('\n'),skillIds:goal.skillIds,taskKinds:goal.taskKinds}).snapshot;const pending=goal.history.filter(h=>h.type==='delivery'&&h.status==='queued'&&h.scheduleIds?.length&&canonicalJSON(h.skills?.skills||[])===canonicalJSON(skills?.skills||[])),combined=[...new Set([...pending.flatMap(h=>h.scheduleIds),...item.ids])].filter(sid=>goal.schedules.some(s=>s.id===sid&&s.enabled));
      for(const old of pending){old.status='coalesced';old.coalescedInto=id;}
      const assembled=this._compose(goal,{scheduleIds:combined,reason,skills},id);
      for(const schedule of goal.schedules)if(item.ids.includes(schedule.id)){schedule.lastRunAt=this._time();schedule.lastResult='queued';schedule.nextRunAt=nextOccurrence(schedule.cron,schedule.timezone,at);}
      this._history(goal,'delivery',reason,{id,status:'queued',scheduleId:combined[0],scheduleIds:combined,...(skills?{skills}:{}),prompt:assembled.prompt,layers:assembled.layers,threadId:goal.threadId,turnId:null});});}catch(error){this._deliveryError(item.id,error);}}
    for(const goal of this.store.data.goals)if(goal.status==='active')void this.pump(goal.id);
  }
  async pumpAll(){await Promise.allSettled(this.store.data.goals.filter(g=>g.status==='active').map(g=>this.pump(g.id)));}
  managementCreate(input,guard){return this.management.create(input,guard);}
  managementRequest(input,guard,internal){return this.management.request(input,guard,internal);}
  captureSkills(input){return this.skillProvider?this.skillProvider.capture(input):{snapshot:null,prompt:''};}
  skillTools(resolveSnapshot,validateContext){return this.skillProvider?.tools(resolveSnapshot,validateContext)||[];}
  managementAction(input,guard){return this.management.action(input,guard);}
  hasActiveWork(){return this.management.hasActiveWork()||this.pumps.size>0||this.reconciling.size>0||this.qaReleases.size>0||this.retiring.size>0||this.retirementFailures.size>0||this.store.data.goals.some(g=>this._ownsTarget(g));}
  runtimeChanged(){if(this.closed)return;this.management.runtimeChanged();for(const goal of this.store.data.goals)if(['idle','error'].includes(goal.executionState)&&!this._ownsTarget(goal))void this._retireIdleSession(goal.id,'실행 환경 변경으로 유휴 QA 연결을 해제했습니다.').catch(()=>{});this._notify();}
  exportData(){return this.store.read();}
  validateImport(value){return validateOpsData(value);}
  restore(value,options){if(this.hasActiveWork()&&!(this.suspended&&options?.pause===false))fail('OPS_GOAL_BUSY','실행 중이거나 확인되지 않은 Ops 목표를 정리한 뒤 복원하십시오.');void this.management.reset();for(const id of this.qaBridges.keys())void this._releaseQa(id,'자료 복원으로 이전 QA 연결을 해제했습니다.');for(const session of this.sessions.values())Promise.resolve(session.close?.()).catch(()=>{});this.sessions.clear();this.store.restore(value,options);this.store.update(data=>{for(const goal of data.goals)Object.assign(goal,EXECUTION);});this._notify();return this.snapshot();}
  setSuspended(value){this.suspended=Boolean(value);this.scheduler.arm();if(!value)void this.scheduler.wake();}
  async close(){if(this.closeTask)return this.closeTask;this.closing=true;this.scheduler.close();this.closeTask=(async()=>{await this.management.close();await Promise.allSettled([...this.qaBridges.keys()].map(id=>this._releaseQa(id,'앱 종료로 목표 QA 연결을 해제했습니다.')));await Promise.allSettled([...this.retiring.values()]);this.closed=true;await Promise.allSettled([...new Set([...this.sessions.values(),...[...this.retirementFailures.values()].map(row=>row.session).filter(Boolean)])].map(session=>session.close?.()));this.sessions.clear();this.qaBridges.clear();this.retirementFailures.clear();})();return this.closeTask;}
}
async function createOpsManager(options){const manager=new OpsManager(options);await manager.init();return manager;}
module.exports={OpsManager,createOpsManager};
