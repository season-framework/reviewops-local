'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {qaTools,documentTool}=require('./mcp-server.cjs');
const {validate,schema}=require('./automation-api.cjs');
const {opsToolOutput}=require('./ops-session.cjs');
const MAX_PNG=2*1024*1024,MAX_RESULT=256*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
function failure(code,message){return Object.assign(new Error(message),{code});}
const bindingKeys=['clientId','sessionId','projectId','windowId'];
const bindingOnly=value=>Object.fromEntries(bindingKeys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const requestBinding=value=>Object.fromEntries(['sessionId','projectId','windowId'].filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const privateBinding=lease=>lease?{...bindingOnly(lease),appInstanceId:lease.context.appInstanceId}:null;
const withoutBinding=input=>{
  const value=structuredClone(input);for(const key of ['projectId','sessionId','windowId','clientId'])delete value.properties[key];
  value.required=value.required.filter(key=>!['projectId','sessionId','windowId','clientId'].includes(key));return value;
};
function pngInfo(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<33||bytes.length>MAX_PNG||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')throw failure('OPS_QA_IMAGE_INVALID','The QA capture is not a bounded PNG.');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(!width||!height||width>20000||height>20000)throw failure('OPS_QA_IMAGE_INVALID','The QA capture dimensions are invalid.');return {width,height};
}
function safeError(error){const code=String(error?.code||'OPS_QA_FAILED').slice(0,80),uncertain=['OPS_QA_UNKNOWN','OPS_QA_OPERATION_UNKNOWN'].includes(code);return {code,message:(String(error?.message||'The goal QA operation failed.').slice(0,800)+(uncertain?' Do not replay this operation. Observe this goal’s target again before choosing a new action.':'')).slice(0,1000),...(error?.inputMayHaveApplied?{inputMayHaveApplied:true}: {})};}

function createOpsQa(options){
  const {goalId,getContext,isCurrent,admit,recordStart,recordOutcome,handle,captureDir}=options;
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(goalId||'')||[getContext,isCurrent,admit,recordStart,recordOutcome,handle].some(value=>typeof value!=='function')||!path.isAbsolute(captureDir||''))throw failure('OPS_QA_CONFIG','The trusted goal QA connection is unavailable.');
  const instance=randomUUID();let lease=null,generation=0,closed=false,queue=Promise.resolve();
  const tools=[...qaTools,documentTool].map(tool=>({...tool,name:tool.name.replace(/^reviewops_qa_/,'ops_qa_'),inputSchema:withoutBinding(tool.inputSchema)}));
  tools.push({name:'ops_qa_status',action:'status',description:'Read only this goal’s project QA availability and current binding. This does not acquire a window.',inputSchema:schema({})});
  const scope=ctx=>[ctx.projectId,ctx.projectEpoch,ctx.projectBirth,ctx.threadId,ctx.appInstanceId];
  function checkContext(ctx,metadata,expectedGeneration){
    if(closed||generation!==expectedGeneration)throw failure('OPS_QA_STALE','This goal’s QA ownership changed. Observe and reconnect through this goal only.');
    if(ctx.goalId!==goalId||ctx.status!=='active'||!ctx.projectId||!ctx.threadId||!ctx.turnId||metadata.threadId!==ctx.threadId||metadata.turnId!==ctx.turnId||typeof metadata.callId!=='string'||!metadata.callId)throw failure('OPS_QA_SCOPE','QA requires this active goal’s registered project and current Codex turn.');
    isCurrent(ctx);
    if(lease&&(lease.context.lifecycleToken!==ctx.lifecycleToken||canonical(scope(lease.context))!==canonical(scope(ctx))))throw failure('OPS_QA_STALE','The old QA lease cannot be adopted by a changed goal or application.');
  }
  function directory(){
    fs.mkdirSync(captureDir,{recursive:true,mode:0o700});const stat=fs.lstatSync(captureDir);
    if(!stat.isDirectory()||stat.isSymbolicLink()||typeof process.getuid==='function'&&stat.uid!==process.getuid()||process.platform!=='win32'&&(stat.mode&0o077))throw failure('OPS_QA_CAPTURE_STORAGE','The private QA capture directory is unavailable.');
    return fs.realpathSync(captureDir);
  }
  function storeCapture(value){
    if(value.mimeType!=='image/png'||typeof value.data!=='string'||value.data.length>Math.ceil(MAX_PNG/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))throw failure('OPS_QA_IMAGE_INVALID','The original QA PNG exceeds the image limit or is invalid.');
    const bytes=Buffer.from(value.data,'base64');if(bytes.toString('base64')!==value.data)throw failure('OPS_QA_IMAGE_INVALID','The original QA PNG encoding is invalid.');
    const dimensions=pngInfo(bytes);if(value.width!==dimensions.width||value.height!==dimensions.height)throw failure('OPS_QA_IMAGE_INVALID','QA image dimensions do not match its original bytes.');
    const id=randomUUID(),relativePath=id+'.png',file=path.join(directory(),relativePath);let fd;
    try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}
    return {capture:{id,relativePath,sha256:sha(bytes),size:bytes.length,mimeType:'image/png',...dimensions},bytes};
  }
  function readCapture(capture){
    if(!capture||!/^[a-f0-9-]{36}\.png$/.test(capture.relativePath||'')||capture.relativePath!==capture.id+'.png'||!Number.isSafeInteger(capture.size)||capture.size>MAX_PNG||!/^[a-f0-9]{64}$/.test(capture.sha256||''))throw failure('OPS_QA_IMAGE_UNAVAILABLE','The original capture receipt is invalid. No new capture was taken.');
    const file=path.join(directory(),capture.relativePath);let fd;
    try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size!==capture.size||typeof process.getuid==='function'&&stat.uid!==process.getuid()||process.platform!=='win32'&&(stat.mode&0o077))throw failure('OPS_QA_IMAGE_UNAVAILABLE','The original capture is unavailable.');const bytes=fs.readFileSync(fd);const dimensions=pngInfo(bytes);if(sha(bytes)!==capture.sha256||dimensions.width!==capture.width||dimensions.height!==capture.height)throw failure('OPS_QA_IMAGE_UNAVAILABLE','The original capture changed. No new capture was taken.');return bytes;}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function output(receipt){
    if(receipt.status!=='completed')return opsToolOutput({error:receipt.error||{code:'OPS_QA_UNKNOWN',message:'The original operation is not confirmed. Do not replay input.'}},{success:false});
    return opsToolOutput({...receipt.result,...(receipt.capture?{capture:receipt.capture}: {})},{images:receipt.capture?[readCapture(receipt.capture)]:[]});
  }
  async function releaseLease(current,reason){
    if(!current)return;
    let status='completed',error;
    try{await handle('automation.qa.release',requestBinding(current),()=>{if(current.context.appInstanceId!==options.appInstanceId&&options.appInstanceId!==undefined)throw failure('OPS_QA_STALE','The original application is no longer available.');});}
    catch(cause){status='unknown';error=safeError(cause);}
    await recordOutcome({callId:null,status,...(error?{error}: {}),binding:{...privateBinding(current),state:status==='completed'?'released':'unknown',reason}});
    if(error)throw failure('OPS_QA_RELEASE_UNCONFIRMED','Only this goal’s QA release is unconfirmed. Other windows were retained.');
  }
  async function run(tool,args,metadata){
    validate(tool.inputSchema,args);const ctx=await getContext(),epoch=generation;
    const guard=()=>checkContext(ctx,metadata,epoch);guard();
    const argsDigest=sha(canonical({tool:tool.name,args})),request={callId:metadata.callId,tool:tool.name,args:structuredClone(args),argsDigest,context:ctx};
    const admission=await admit(request);guard();
    if(admission?.reused){if(!['completed','failed'].includes(admission.receipt?.status))throw failure('OPS_QA_UNKNOWN','The original QA operation is pending or uncertain. Do not replay it.');return output(admission.receipt);}
    await recordStart({...request,binding:privateBinding(lease)});
    const action=tool.action.replace(/^automation\.qa\./,''),mutation=!['status','state','capture'].includes(action)&&!(action==='document'&&['state','capture'].includes(args.operation));
    let invoked=false,candidate,receipt,recorded=false;
    try{
      guard();
      let value;
      if(action==='status'){invoked=true;value=await handle('status',{projectId:ctx.projectId,...(lease?{binding:requestBinding(lease)}: {})},guard);}
      else if(action==='open'){
        const clientId='ops_'+sha(goalId+'\0'+ctx.appInstanceId+'\0'+instance).slice(0,48);
        invoked=true;value=await handle(tool.action,{...args,projectId:ctx.projectId,clientId},guard);
        if(!value||value.projectId!==ctx.projectId||value.clientId!==clientId||!value.sessionId||!value.windowId)throw failure('OPS_QA_BINDING_INVALID','QA did not confirm this goal’s project/window binding.');
        candidate={...bindingOnly(value),context:ctx};guard();lease=candidate;
      }else{
        if(!lease)throw failure('OPS_QA_NOT_CONNECTED','Open QA through this goal before controlling its project window.');
        const binding=requestBinding(lease);invoked=true;value=await handle(tool.action,{...args,...binding},guard);
        if(!value||['sessionId','projectId','windowId'].some(key=>value[key]!==binding[key]))throw failure('OPS_QA_BINDING_INVALID','QA returned another target. No binding was adopted.');
      }
      guard();
      let capture,bytes;const result={...value};
      if(Object.hasOwn(result,'data')){({capture,bytes}=storeCapture(result));delete result.data;result.capture=capture;}
      if(Buffer.byteLength(JSON.stringify(result))>MAX_RESULT)throw failure('OPS_QA_RESULT_TOO_LARGE','The QA observation exceeds the goal history limit.');
      if(action==='release'||action==='close'&&result.closed===true){const previous=lease;lease=null;result.bindingState='released';candidate=previous;}
      receipt={callId:metadata.callId,status:'completed',result,binding:{...privateBinding(candidate||lease),state:action==='release'||action==='close'&&result.closed?'released':lease?'attached':'unavailable'},...(capture?{capture}: {})};
      await recordOutcome(receipt);recorded=true;guard();
      return opsToolOutput(result,{images:bytes?[bytes]:[]});
    }catch(error){
      if(recorded)return opsToolOutput({error:safeError(error),originalResult:receipt.result},{success:false});
      if(candidate&&lease!==candidate)await releaseLease(candidate,'The goal changed while QA was opening.').catch(()=>{});
      const unknown=Boolean(error.inputMayHaveApplied)||invoked&&mutation;
      receipt={callId:metadata.callId,status:unknown?'unknown':'failed',error:safeError(error),binding:privateBinding(lease)};
      await recordOutcome(receipt);return output(receipt);
    }
  }
  return Object.freeze({
    tools:tools.map(tool=>({name:tool.name,description:(tool.name==='ops_qa_open'?'Open or reuse only this goal’s registered project window in the background. Its QA client and lease are created internally. An optional review must belong to this project.':tool.description)+' The project, QA client, session and window are fixed by this goal; never supply or substitute their IDs.',inputSchema:tool.inputSchema,execute:(args,metadata)=>{const input=structuredClone(args),original=Object.freeze({...metadata});const operation=queue.then(()=>run(tool,input,original)).catch(error=>opsToolOutput({error:safeError(error)},{success:false}));queue=operation.catch(()=>{});return operation;}})),
    async release(reason='The goal released QA.') {generation++;const current=lease;lease=null;await releaseLease(current,reason);},
    async close(){closed=true;generation++;const current=lease;lease=null;await releaseLease(current,'The goal connection closed.');},
  });
}
module.exports={createOpsQa,MAX_OPS_QA_PNG:MAX_PNG};
