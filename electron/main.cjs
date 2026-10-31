'use strict';
const { app, BrowserWindow, ipcMain, dialog: nativeDialog, shell, protocol, net, Menu, clipboard } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createStore } = require('./store.cjs');
const { createVault, atomicWrite } = require('./vault.cjs');
const { createSshService } = require('./ssh.cjs');
const { createTerminalManager } = require('./terminal.cjs');
const { MAX_FILE_BYTES, mimeType, describeBytes, listLocal, readLocal, inside } = require('./files.cjs');
const { createHtmlPreview, htmlPreviewResponse } = require('./html-preview.cjs');
const {readAgentOutput} = require('./agent-files.cjs');
const {createUpdateManager,hasActiveWork} = require('./updates.cjs');
const {getBuildInfo} = require('./build-info.cjs');
const {createModelCache} = require('./model-cache.cjs');
const {createModelTargets} = require('./model-targets.cjs');
const {createAppLanguage} = require('./app-language.cjs');
const {inspectDirectory,createChildDirectory} = require('./work-directory.cjs');
const {changeReviewTarget,saveReviewVersion,listReviewVersions,withoutReviewVersions}=require('./review-versions.cjs');

// Keep browser cookie storage independent of macOS Keychain as requested.
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
app.setName('ReviewOps');
const dataPath = process.env.REVIEWOPS_DATA_DIR || path.join(app.getPath('appData'), 'ReviewOps Local');
app.setPath('userData', dataPath);
const appLanguage=createAppLanguage({dataPath});
const dialog=appLanguage.dialog(nativeDialog);
protocol.registerSchemesAsPrivileged([{ scheme: 'reviewops', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const devUrl = !app.isPackaged ? process.env.REVIEWOPS_DEV_URL : null;
const attachmentPath = path.join(dataPath, 'attachments');
let window, store, vault, agents, codexManager, updater, modelCache;
let seasonIntegration, toolIntegration, qaAutomation;
const windowContexts = new Map(), projectWindows = new Map(), terminalOwners = new Map();
const requestWindowContext = new AsyncLocalStorage();
const quitApproved = new WeakSet();
let integrationSequence = 0, dataRevision = 0;
const agentJobs = new Map();
let quitting = false;
let restoring = false;
let actionQueue = Promise.resolve();
const ssh = createSshService();
const terminals = createTerminalManager({ssh});
const stagedAttachments = new Map();
const pendingTrust = new Map();
const operations = new Set();
const windowActions = new Set(['window.state','window.fullscreen','window.close']);
const windowFullScreenChanges = new WeakMap();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const storagePattern = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9]{1,12})?$/;

function liveWindows() { return [...windowContexts.keys()].filter(host=>!host.isDestroyed()); }
function getRequestWindow() {
  const context=requestWindowContext.getStore();
  if(context){if(!windowContexts.has(context.host)||context.host.isDestroyed())throw new Error('요청한 창이 닫혔습니다.');return context.host;}
  const focused=BrowserWindow.getFocusedWindow?.();
  return windowContexts.has(focused)?focused:window&&!window.isDestroyed()?window:liveWindows()[0];
}
function currentWindowRecord() {
  const record=windowContexts.get(getRequestWindow());
  if(!record)throw new Error('요청한 창이 닫혔습니다.');
  return record;
}
function sendToWindows(channel,value) { for(const host of liveWindows())host.webContents.send(channel,value); }
function dataChanged() { sendToWindows('reviewops:data-change',{revision:++dataRevision}); }
function closeWindowResources(host,discardStaged=true) {
  const record=windowContexts.get(host);record?.browsers?.closeAll();if(record)record.browsers=null;
  for(const [id,owner] of terminalOwners)if(owner===host){try{terminals.close(id)}catch{}terminalOwners.delete(id);}
  if(discardStaged)for(const [token,item] of stagedAttachments)if(item.ownerWindow===host)stagedAttachments.delete(token);
}
function closeAllBrowsers() { for(const record of windowContexts.values()){record.browsers?.closeAll();record.browsers=null;} }
function ownedTerminal(id) { if(terminalOwners.get(id)!==getRequestWindow())throw new Error('이 창의 터미널만 사용할 수 있습니다.');return id; }
function ownedStaged(token) { const item=stagedAttachments.get(token);if(item&&item.ownerWindow!==getRequestWindow())throw new Error('이 창에서 추가한 첨부파일만 사용할 수 있습니다.');return item; }
function changesData(action) { return /^(group|project|service|review)\.(save|delete|copy)$|^activity\.add$|^attachment\.(add|delete)$|^agent\.(start|cancel)$|^agent\.request\.(add|update|start|cancel|confirmResult|resolve)$|^review\.(version|target)\.|^backup\.import$/.test(action); }


function screenshotBytes(payload) {
  const data = payload.dataUrl;
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 100 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('PNG 스크린샷을 선택하십시오.');
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  if (bytes.length > MAX_FILE_BYTES || bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('스크린샷은 20 MB 이하의 PNG 파일이어야 합니다.');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if (!width || !height || width*height>64000000 || require('electron').nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error('스크린샷 이미지가 올바르지 않습니다.');
  return bytes;
}
function screenshotName(value) {
  const name=typeof value==='string'?path.basename(value).replace(/[\x00-\x1f/\\]/g,'').slice(0,180):'';
  return name&&/\.png$/i.test(name)?name:`스크린샷-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
}
function stageScreenshot(payload) {
  const bytes=screenshotBytes(payload);
  for(const [token,item] of stagedAttachments)if(item.expires<Date.now())stagedAttachments.delete(token);
  if(stagedAttachments.size>=100 || [...stagedAttachments.values()].reduce((sum,item)=>sum+item.bytes.length,bytes.length)>200*1024*1024)throw new Error('작성 중인 첨부파일을 저장한 후 다시 시도하십시오.');
  const token=crypto.randomUUID(),metadata={name:screenshotName(payload.name),mimeType:'image/png',size:bytes.length,storageName:crypto.randomUUID()+'.png',sha256:digest(bytes)};
  stagedAttachments.set(token,{token,bytes,metadata,ownerWindow:getRequestWindow(),expires:Date.now()+30*60*1000});
  return {token,name:metadata.name,mimeType:metadata.mimeType,size:metadata.size};
}
function agentSettings(service) {
  return {binary:service.agentBinary||'codex',workPath:service.agentWorkPath||service.rootPath,model:service.agentModel||'',reasoningEffort:service.agentReasoningEffort||'',instructions:service.agentInstructions||''};
}
function modelTargets(additional = []) {
  const snapshot=store?.snapshot();
  const services=[...(snapshot?.projects||[]).map(project=>project.connection).filter(Boolean),...additional];
  return createModelTargets({hostState:codexManager?.hostState?.()||{},services,localBinary:codexManager?.accountState?.()?.runtime?.path||'codex',localProfile:process.env.CODEX_HOME||''});
}
function cachedAgentModels(service) {
  const id=modelTargets([service]).serviceIds.get(service.id);
  const cached=id&&modelCache?.get(id);
  const value=cached||{models:[],modelSource:'none',defaultModel:'',defaultReasoningEffort:'',cachedAt:null,cacheStatus:'empty',refreshing:false};
  return !value.models?.length&&service.agentModels?.length?{...value,models:service.agentModels,modelSource:'manual'}:value;
}
function refreshServiceModels(serviceId) {
  const catalog=modelTargets();
  invalidateModelAccount(catalog.serviceIds.get(serviceId),catalog.targets);
}
function invalidateModelAccount(id, targets=modelTargets().targets) {
  const owner=targets.find(target=>target.id===id);
  if(owner&&modelCache)for(const target of targets)if(target.accountScope===owner.accountScope)modelCache.invalidate(target.id).catch(()=>{});
}
function startModelCache() {
  modelCache?.close();
  modelCache=createModelCache({dataPath,listTargets:()=>modelTargets().targets,collect:async target=>{const config=target.config.kind==='ssh'&&!target.config.hostAlias?{...target.config,...credentialValues(target.config)}:target.config;return agentManager().environment(config,target.settings);},onChange:state=>sendToWindows('reviewops:model-cache-state',state)});
  modelCache.start().catch(()=>{});
}
const completedHostLogins=new Map();
function reconcileHostModels(snapshot) {
  modelCache?.reconcile();
  for(const host of snapshot?.hosts||[])if(host.login?.status==='completed'&&completedHostLogins.get(host.id)!==host.login.attemptId) {
    completedHostLogins.set(host.id,host.login.attemptId);
    invalidateModelAccount('host:'+host.id);
  }
}
function agentExecutionScope(service, settings) {
  const remote=service.kind==='ssh';
  return 'target-v2:'+digest(JSON.stringify([service.kind,remote?service.host:'',remote?service.port:0,remote?service.username:'',remote?service.hostAlias||'':'',remote?service.sshConfigPath||'':'',settings.workPath,settings.binary,settings.model]));
}
function savedAgentExecutionScope(run) {
  if(run.sessionScope?.startsWith('target-v2:'))return run.sessionScope;
  // Older runs used the internal connection ID in their scope. Read the saved
  // connection to keep those conversations usable after project settings move.
  if(!run.serviceId||!run.workPath)return null;
  let original;
  try{original=store.get('services',run.serviceId);}catch(error){if(error.code==='NOT_FOUND')return null;throw error;}
  return agentExecutionScope(original,{...agentSettings(original),workPath:run.workPath,model:run.model});
}
function sameAgentLocation(run,service,settings) {
  // A model selection changes the next turn, not the conversation's location.
  return savedAgentExecutionScope(run)===agentExecutionScope(service,{...settings,model:run.model});
}
function agentManager() {
  if(!agents) agents=require('./agents.cjs').createAgentManager({onUpdate:job=>{
    const previous=agentJobs.get(job.id);
    const merged={...previous,...job,...(previous?.prompt?{prompt:previous.prompt}:{}),...(previous?.sessionScope?{sessionScope:previous.sessionScope,workPath:previous.workPath}:{})};
    agentJobs.set(job.id,merged);
    if(job.kind==='agent' && store && !store.closed)store.saveAgentRun(merged);
    if(job.kind==='agent'){for(const record of windowContexts.values())if(record.pendingReview?.reviewId===job.reviewId&&!record.host.isDestroyed())record.host.webContents.send('reviewops:season-update',{reviewId:job.reviewId});dataChanged();}
    if(job.status!=='running'){
      operations.delete(`agent:${job.id}`);
      if(job.kind==='agent')agentJobs.delete(job.id);
      if(job.kind==='login'&&job.status==='completed')refreshServiceModels(job.serviceId);
    }
  }});
  return agents;
}
function restoreRemoteAgents() {
  for(const job of store.listAgentRuns().filter(run=>run.status==='running'&&run.remoteExecution?.version===1&&run.remoteExecution.ready)) {
    try {
      const config=serviceById(job.serviceId,true),settings={...agentSettings(config),workPath:job.workPath,model:job.model,reasoningEffort:job.reasoningEffort};
      if(config.kind!=='ssh'||job.sessionScope!==agentExecutionScope(config,settings))throw new Error('저장된 SSH 접속 설정이 변경되어 에이전트에 다시 연결하지 못했습니다.');
      agentJobs.set(job.id,job);operations.add(`agent:${job.id}`);
      agentManager().restore({job,config,settings});
    } catch(error) {
      operations.delete(`agent:${job.id}`);agentJobs.delete(job.id);
      store.saveAgentRun({...job,status:'interrupted',error:error.message,finishedAt:new Date().toISOString()});
    }
  }
}
function assertNoAgent(predicate) {
  if([...agentJobs.values()].some(job=>job.status==='running'&&predicate(job)))throw new Error('에이전트 실행 또는 로그인이 끝난 후 변경하십시오.');
}
function assertNoAgentWorkspaceConflict(service,settings,independentExecution=false) {
  if(independentExecution)return;
  const {requestTargetKey,conflictingTargets}=require('./agent-requests.cjs'),target=requestTargetKey(service,settings);
  for(const job of agentJobs.values()){
    if(job.kind!=='agent'||job.status!=='running')continue;
    const previous=job.executionTarget||serviceById(job.serviceId,true),previousSettings={workPath:job.workPath||previous.workPath||agentSettings(previous).workPath};
    if(conflictingTargets(target,requestTargetKey(previous,previousSettings)))throw new Error('같은 작업 폴더 또는 그 안의 폴더에서 에이전트가 실행 중입니다. 실행이 끝난 뒤 다시 요청하십시오.');
  }
}
function agentMaterials(reviewId) {
  const review=store.get('reviews',reviewId),snapshot=store.snapshot(),project=snapshot.projects.find(item=>item.id===review.projectId);
  const metadata=item=>{const owner=snapshot.reviews.find(entry=>entry.id===item.reviewId),ownerProject=snapshot.projects.find(entry=>entry.id===owner?.projectId);return {id:item.id,name:item.name,mimeType:item.mimeType,size:item.size,createdAt:item.createdAt,reviewId:item.reviewId,activityId:item.activityId,reviewTitle:owner?.title || '',projectName:ownerProject?.name || '',source:item.reviewId===review.id?(item.activityId?'activity':'review'):'shared'};};
  const attachments=snapshot.attachments.filter(item=>item.reviewId===review.id).map(metadata);
  const sharedFiles=snapshot.attachments.filter(item=>item.reviewId!==review.id&&snapshot.projects.some(owner=>owner.id===snapshot.reviews.find(entry=>entry.id===item.reviewId)?.projectId&&owner.groupId===project.groupId)).map(metadata);
  const evidence=withoutReviewVersions(review.evidence || {}),captures=evidence.log_captures || [];
  const logs=captures.map((capture,index)=>({...capture,id:capture.id || `capture-${index}`,name:capture.label || `리뷰 로그 ${index+1}`}));
  if(!logs.length&&['navigation_log','input_log','network_log','console_log','fingerprint_log'].some(key=>evidence[key]&&Object.keys(evidence[key]).length))logs.push({...evidence,id:'current',name:'리뷰 로그'});
  const categoryNames=require('./review-categories.json'),category=store.reviewCategories().find(item=>item.id===review.category)?.name||[...categoryNames.defaults,...categoryNames.legacy].find(([id])=>id===review.category)?.[1]||review.category;
  const instructionMarkdown=`# 에이전트 작업 지시서\n\n## 요청사항\n${review.body || review.title}\n\n## 리뷰 정보\n- 리뷰: ${review.number} (${review.id})\n- 제목: ${review.title}\n- 상태: ${review.status}\n- 우선순위: ${review.priority}\n- 분류: ${category}\n- 프로젝트: ${project.name}\n- 대상 파일: ${review.targetPath || '없음'}\n- 대상 주소: ${review.targetUrl || '없음'}\n- 첨부파일: ${attachments.length}개\n`;
  const requests=store.listAgentRuns(review.id),last=requests[0]?.context;
  const savedRequests=require('./agent-requests.cjs').listSavedRequests(store.db,review.id);
  return {instruction:{name:'작업 지시서.md',markdown:instructionMarkdown},screenshots:attachments.filter(item=>['image/png','image/jpeg','image/webp'].includes(item.mimeType)),attachments,sharedFiles,logs,hasRequests:requests.length>0,requestIds:[...new Set([...requests.map(run=>run.id),...savedRequests.map(row=>row.id)])],lastRequestContext:last?{instruction:Boolean(last.instruction),screenshotId:last.screenshotId||null,attachmentIds:last.attachmentIds||[],logIds:last.logIds||[]}:null};
}
async function exportInstruction(reviewId) {
  const review=store.get('reviews',reviewId),materials=agentMaterials(reviewId),name=`ReviewOps-${review.number}-${review.title.replace(/[/\\\x00-\x1f]/g,'_').slice(0,90)}.zip`;
  const selection=await dialog.showSaveDialog(getRequestWindow(),{title:'작업 지시서 ZIP 저장',defaultPath:name,filters:[{name:'ZIP 파일',extensions:['zip']}]});
  if(selection.canceled)return {cancelled:true};
  await assertExportDestination(selection.filePath);
  const snapshot=store.snapshot(),entries=[];let total=0;
  const add=(name,bytes)=>{if(typeof bytes==='string')bytes=Buffer.from(bytes);total+=bytes.length;if(total>200*1024*1024)throw new Error('ZIP으로 저장할 자료는 합계 200 MB까지 지원합니다.');entries.push({name,bytes});};
  add('README.md',`# ReviewOps 리뷰 자료\n\n${review.title}\n\n- request.md: 작업 지시서\n- review.json: 리뷰 정보\n- logs/: 저장한 화면 로그\n- screenshots/: 스크린샷과 이미지\n- attachments/: 리뷰 첨부파일\n- activities/: 작업이력과 첨부파일\n\n이 ZIP에는 앱에 저장된 자료가 포함됩니다.\n`);
  add('request.md',materials.instruction.markdown);add('review.json',JSON.stringify(withoutReviewVersions(review),null,2));
  add('logs/current.json',JSON.stringify({...withoutReviewVersions(review.evidence),log_captures:undefined},null,2));
  for(const [index,capture] of materials.logs.entries())add(`logs/${String(index+1).padStart(3,'0')}-${capture.id}.json`,JSON.stringify(capture,null,2));
  const activities=snapshot.activities.filter(item=>item.reviewId===review.id);add('activities/history.json',JSON.stringify(withoutReviewVersions(activities),null,2));
  add('activities/history.md',activities.map(item=>`## ${item.role==='agent'?'에이전트':item.type==='comment'?'사용자':'상태 기록'} · ${item.createdAt}\n\n${item.body || `${item.fromStatus} → ${item.toStatus}`}\n`).join('\n'));
  for(const file of snapshot.attachments.filter(item=>item.reviewId===review.id)) {
    const folder=file.mimeType.startsWith('image/')?'screenshots':file.activityId?`activities/${file.activityId}/attachments`:'attachments';
    add(`${folder}/${file.id}_${file.name}`,await readAttachment(file));
  }
  const bytes=require('./archive.cjs').createZip(entries);atomicWrite(selection.filePath,bytes);
  return {saved:true,path:selection.filePath,name:path.basename(selection.filePath),size:bytes.length};
}
async function readAgentFile(payload,raw=false) {
  const review=store.get('reviews',payload.reviewId),run=payload.runId?store.get('agent_runs',payload.runId):null;
  if(run&&run.reviewId!==review.id)throw new Error('같은 리뷰의 작업 파일만 열 수 있습니다.');
  const service=serviceById(run?.serviceId || review.serviceId),root=run?.workPath || service.agentWorkPath || service.rootPath;
  const config={...service,rootPath:root,...credentialValues(service)};
  const token=`agent-file:${crypto.randomUUID()}`;operations.add(token);
  try{
    const file=await readAgentOutput(config,payload.path,{raw,basePath:payload.basePath,ssh});
    return !raw&&typeof file.content==='string'&&(file.mimeType==='text/html'||/\.html?$/i.test(file.name))?{...file,previewUrl:createHtmlPreview(file.content)}:file;
  }
  catch(error){if(error.code==='SSH_TRUST_REQUIRED'&&error.fingerprint)pendingTrust.set(service.id,{fingerprint:error.fingerprint,host:service.host,port:service.port,expires:Date.now()+300000});throw error;}
  finally{operations.delete(token);}
}
let followupRequests;
function requestQueue() {
  if(!followupRequests)followupRequests=require('./agent-requests.cjs').createRequestQueue({store,
    targetForReview:review=>{const service=serviceById(review.serviceId,true),settings=agentSettings(service);return {serviceId:service.id,key:require('./agent-requests.cjs').requestTargetKey(service,settings),settings};},
    targetForRun:run=>{const service=serviceById(run.serviceId,true);return require('./agent-requests.cjs').requestTargetKey(service,{...agentSettings(service),workPath:run.workPath});},
    start:payload=>agentAction('agent.start',payload)
  });
  return followupRequests;
}
async function agentAction(action,payload) {
  if(action.startsWith('agent.request.')){
    const method=action.slice('agent.request.'.length);if(!['list','add','update','confirmResult','cancel','start','resolve'].includes(method))throw new Error('지원하지 않는 후속 요청 기능입니다.');
    if(method==='add') {
      const signature=digest(JSON.stringify([payload.reviewId,payload.prompt,payload.model??null,payload.reasoningEffort??null,payload.executionSettings??null,Boolean(payload.newConversation),payload.predecessorId||'',payload.requiredResult||'',payload.context??null,payload.attachmentTokens||[],payload.screenshotToken||'',payload.sourceRunId||'',payload.sourceTarget??null,payload.continuedFromRunId||'']));
      const existing=payload.requestId&&require('./agent-requests.cjs').listSavedRequests(store.db,payload.reviewId).find(row=>row.id===payload.requestId);
      if(existing?.requestSignature){if(existing.requestSignature!==signature)throw new Error('이미 사용한 요청 ID입니다. 새 요청으로 등록하십시오.');return requestQueue().list(payload.reviewId).requests.find(row=>row.id===existing.id);}
      payload={...payload,requestSignature:signature};
    }
    if(['add','update'].includes(method)&&payload.context){const context={...payload.context},screenshotToken=payload.screenshotToken||context.screenshotToken;delete context.screenshotToken;payload={...payload,context,...(screenshotToken?{screenshotToken}:{})};}
    if(['add','update'].includes(method)&&(payload.attachmentTokens?.length||payload.screenshotToken)) {
      const tokens=attachmentTokens([...new Set([...(payload.attachmentTokens||[]),...(payload.screenshotToken?[payload.screenshotToken]:[])])]),staged=tokens.map(token=>{const item=ownedStaged(token);if(!item||item.expires<Date.now())throw new Error('첨부파일을 다시 선택하십시오. 임시 보관 시간이 지났습니다.');if(!item.metadata.id)item.metadata.id=crypto.randomUUID();return item;});
      const context=require('./agent-execution-settings.cjs').requestContext(payload.context||{instruction:false,attachmentIds:[],logIds:[]});
      const screenshot=payload.screenshotToken?ownedStaged(payload.screenshotToken):null;
      if(screenshot&&!['image/png','image/jpeg','image/webp'].includes(screenshot.metadata.mimeType))throw new Error('PNG, JPEG, WebP 스크린샷을 선택하십시오.');
      const updated={...payload,context:{...context,screenshotId:screenshot?.metadata.id||context.screenshotId,attachmentIds:[...new Set([...context.attachmentIds,...staged.filter(item=>item&&item!==screenshot).map(item=>item.metadata.id)])]}};
      const result=await saveWithAttachments(tokens,()=>requestQueue()[method](updated),row=>({reviewId:row.reviewId}));return result.entity;
    }
    return requestQueue()[method](method==='list'?payload.reviewId:payload);
  }
  if(action==='agent.loginState'){serviceById(payload.serviceId);return [...agentJobs.values()].reverse().find(job=>job.kind==='login'&&job.serviceId===payload.serviceId)||null;}
  if(action==='agent.list')return store.listAgentRuns(payload.reviewId);
  if(action==='agent.read')return agentJobs.get(payload.id)||store.get('agent_runs',payload.id);
  if(action==='agent.materials')return agentMaterials(payload.reviewId);
  if(action==='agent.instructionExport')return exportInstruction(payload.reviewId);
  if(action==='agent.transfer')return store.transferAgentResponse(payload.runId);
  if(action==='agent.copyDraft'){
    const run=store.get('agent_runs',payload.runId),review=store.get('reviews',payload.reviewId);
    if(run.reviewId!==review.id)throw new Error('같은 리뷰의 요청만 가져올 수 있습니다.');
    const service=serviceById(review.serviceId,true),settings=agentSettings(service),{executionTarget,copyAgentDraft}=require('./agent-copy-draft.cjs'),current=executionTarget(service,settings);
    const sameLocation=run.executionTarget?['kind','host','hostAlias','sshConfigPath','port','username','workPath'].every(key=>(run.executionTarget[key]??'')===(current[key]??'')):savedAgentExecutionScope(run)===agentExecutionScope(service,{...settings,model:run.model});
    const materials=agentMaterials(review.id),copy=copyAgentDraft({run,current,materials,sameLocation}),unavailable=new Set();
    // Check only files retained by the draft's ownership and target checks.
    // Read each file separately so validation does not retain another copy of all attachments.
    for(const id of new Set([copy.draft.screenshotId,...copy.draft.attachmentIds].filter(Boolean))) {
      try{await readAttachment(attachmentById(id));}catch{unavailable.add(id);}
    }
    if(!unavailable.size)return copy;
    return copyAgentDraft({run,current,sameLocation,materials:{...materials,
      attachments:materials.attachments.filter(file=>!unavailable.has(file.id)),
      sharedFiles:materials.sharedFiles.filter(file=>!unavailable.has(file.id)),
      screenshots:materials.screenshots.filter(file=>!unavailable.has(file.id))
    }});
  }

  if(action==='agent.models')return cachedAgentModels(serviceById(payload.serviceId||(payload.projectId?store.project(payload.projectId).connection?.id:null)));
  if(action==='agent.fileRead')return readAgentFile(payload);
  if(action==='agent.fileExport') {
    if(typeof payload.path!=='string'||!payload.path)throw new Error('저장할 작업 파일을 선택하십시오.');
    const selection=await dialog.showSaveDialog(getRequestWindow(),{title:'작업 파일 저장',defaultPath:path.posix.basename(payload.path)});
    if(selection.canceled)return {cancelled:true};
    await assertExportDestination(selection.filePath);
    const file=await readAgentFile(payload,true);atomicWrite(selection.filePath,file.bytes);
    return {saved:true,path:selection.filePath,name:file.name,size:file.size};
  }
  const requestId=action==='agent.start'&&payload.requestId;
  const requestSignature=action==='agent.start'?digest(JSON.stringify([payload.reviewId,typeof payload.prompt==='string'?payload.prompt:'',Boolean(payload.newConversation),payload.model ?? null,payload.reasoningEffort ?? null,payload.context ?? null,payload.attachmentTokens || [],payload.retryOf ?? null,Boolean(payload.independentExecution),...(payload.sourceRunId?[payload.sourceRunId,payload.sourceTarget??null]:[]),...(payload.executionSettings?[payload.executionSettings]:[]),...(payload.continuedFromRunId?[payload.continuedFromRunId]:[])])):'';
  if(requestId && (typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)))throw new Error('에이전트 요청 ID가 올바르지 않습니다.');
  if(requestId){const existing=store.listAgentRuns().find(run=>run.id===requestId);if(existing){if(existing.reviewId!==payload.reviewId||existing.prompt!==payload.prompt||(existing.requestSignature&&existing.requestSignature!==requestSignature))throw new Error('이미 사용한 요청 ID입니다. 새 요청으로 실행하십시오.');return agentJobs.get(requestId)||existing;}}
  const manager=agentManager();
  if(action==='agent.cancel')return manager.cancel(payload.id);
  const review=['agent.start','agent.session'].includes(action)?store.get('reviews',payload.reviewId):null;
  const service=serviceById(review?.serviceId||payload.serviceId||(payload.projectId?store.project(payload.projectId).connection?.id:null),true),settings=agentSettings(service);
  const retry=action==='agent.start'&&payload.retryOf?store.get('agent_runs',payload.retryOf):null;
  if(retry&&retry.reviewId!==review.id)throw new Error('같은 리뷰의 요청만 재실행할 수 있습니다.');
  const source=action==='agent.start'&&payload.sourceRunId?store.get('agent_runs',payload.sourceRunId):null;
  if(source&&(source.reviewId!==review.id||!['failed','cancelled','interrupted'].includes(source.status)))throw new Error('같은 리뷰의 실패하거나 중단된 요청만 새 실행에 연결할 수 있습니다.');
  if(source&&payload.newConversation!==true)throw new Error('가져온 요청은 새 대화로 시작하십시오.');
  if(action==='agent.session') {
    assertNoAgent(job=>job.serviceId===service.id);
    if(payload.model!==undefined){if(typeof payload.model!=='string'||payload.model.length>256||/[\s\0]/.test(payload.model))throw new Error('에이전트 모델 이름이 올바르지 않습니다.');settings.model=payload.model;}
    const candidates=store.listAgentRuns(review.id).filter(run=>run.status==='completed'&&run.sessionId);
    const last=candidates.find(run=>sameAgentLocation(run,service,settings));
    if(!last){
      const moved=candidates.find(run=>run.workPath!==settings.workPath&&sameAgentLocation(run,service,{...settings,workPath:run.workPath}));
      if(moved)return {available:false,sessionId:moved.sessionId,model:moved.model,requestedModel:settings.model,status:'work_path_changed',message:'저장된 세션의 작업 폴더가 프로젝트 설정과 다릅니다. 새 대화로 실행하십시오.'};
      return {available:false,sessionId:'',model:'',requestedModel:settings.model,status:'missing',message:'저장된 에이전트 세션이 없습니다.'};
    }
    const token=`agent-session:${crypto.randomUUID()}`;operations.add(token);
    try{return await manager.session(service,settings,last.sessionId);}
    catch(error){if(error.code==='SSH_TRUST_REQUIRED'&&error.fingerprint)pendingTrust.set(service.id,{fingerprint:error.fingerprint,host:service.host,port:service.port,expires:Date.now()+300000});throw error;}
    finally{operations.delete(token);}
  }
  if(action==='agent.environment'||action==='agent.logout') {
    assertNoAgent(job=>job.serviceId===service.id);
    const token=`agent-probe:${crypto.randomUUID()}`;operations.add(token);
    try{
      const environment=await manager[action==='agent.environment'?'environment':'logout'](service,settings);
      if(action==='agent.environment'&&!environment.models?.length&&service.agentModels?.length)return {...environment,models:service.agentModels,modelSource:'manual'};
      if(action==='agent.logout')refreshServiceModels(service.id);
      return environment;
    }
    catch(error){if(error.code==='SSH_TRUST_REQUIRED'&&error.fingerprint)pendingTrust.set(service.id,{fingerprint:error.fingerprint,host:service.host,port:service.port,expires:Date.now()+300000});throw error;}
    finally{operations.delete(token);}
  }
  assertNoAgent(job=>job.serviceId===service.id);
  const id=requestId || crypto.randomUUID();
  if(action==='agent.login') {
    for(const [key,job] of agentJobs)if(job.kind==='login'&&job.serviceId===service.id&&job.status!=='running')agentJobs.delete(key);
    operations.add(`agent:${id}`);
    try{const job=manager.login({id,serviceId:service.id,config:service,settings});agentJobs.set(id,job);return job;}catch(error){operations.delete(`agent:${id}`);throw error;}
  }
  if(action!=='agent.start')throw new Error('지원하지 않는 에이전트 기능입니다.');
  if(!service.agentEnabled)throw new Error('프로젝트 설정에서 에이전트 사용을 켜십시오.');
  const prompt=typeof payload.prompt==='string'?payload.prompt:'';
  if(!prompt.trim()||prompt.length>100000||prompt.includes('\0'))throw new Error('작업 요청은 1자 이상 100,000자 이하로 입력하십시오.');
  const displayPrompt=payload.displayPrompt===undefined?prompt:payload.displayPrompt;
  if(typeof displayPrompt!=='string'||!displayPrompt.trim()||displayPrompt.length>100000||displayPrompt.includes('\0'))throw new Error('표시할 작업 요청은 1자 이상 100,000자 이하로 입력하십시오.');
  if(payload.model!==undefined){if(typeof payload.model!=='string'||payload.model.length>256||/\s|\0/.test(payload.model))throw new Error('에이전트 모델 이름이 올바르지 않습니다.');settings.model=payload.model;}
  if(payload.reasoningEffort!==undefined){if(!['','none','minimal','low','medium','high','xhigh','max','ultra'].includes(payload.reasoningEffort))throw new Error('에이전트 추론 수준이 올바르지 않습니다.');settings.reasoningEffort=payload.reasoningEffort;}
  if(retry){if(payload.model===undefined)settings.model=retry.model;if(payload.reasoningEffort===undefined)settings.reasoningEffort=retry.reasoningEffort;}
  const selectedSettings={model:payload.model??'',reasoningEffort:payload.reasoningEffort??''};
  const executionSettings=require('./agent-execution-settings.cjs').executionSettings(payload.executionSettings??(retry&&payload.model===undefined&&payload.reasoningEffort===undefined?retry.executionSettings:undefined)??{version:1,selected:selectedSettings,automatic:{model:!selectedSettings.model,reasoningEffort:!selectedSettings.reasoningEffort},sent:{model:settings.model,reasoningEffort:settings.reasoningEffort}},{model:settings.model,reasoningEffort:settings.reasoningEffort});
  const newConversation=Boolean(payload.newConversation);
  if(payload.independentExecution!==undefined&&typeof payload.independentExecution!=='boolean')throw new Error('독립실행 옵션이 올바르지 않습니다.');
  const independentExecution=payload.independentExecution===undefined?Boolean(retry?.independentExecution):payload.independentExecution;
  if(source) {
    const current=require('./agent-copy-draft.cjs').executionTarget(service,settings);
    if(!payload.sourceTarget||['kind','host','hostAlias','sshConfigPath','port','username','workPath','binary'].some(key=>(payload.sourceTarget[key]??'')!==(current[key]??'')))throw new Error('초안을 가져온 뒤 실행 대상이 변경되었습니다. 이전 내용을 다시 가져와 실행 대상을 확인하십시오.');
  }
  assertNoAgentWorkspaceConflict(service,settings,independentExecution);
  const sessionScope=agentExecutionScope(service,settings);
  if(retry&&!sameAgentLocation(retry,service,settings))throw new Error('접속 대상, 작업 폴더 또는 실행 파일이 변경되었습니다. 새 요청으로 실행하십시오.');
  let previous=newConversation?null:store.listAgentRuns(review.id).find(run=>run.status==='completed'&&sameAgentLocation(run,service,settings)&&run.sessionId);
  const currentTarget=require('./agent-copy-draft.cjs').executionTarget(service,settings),sameLocation=run=>{
    const target=run.executionTarget;
    if(target)return ['kind','host','hostAlias','sshConfigPath','port','username','workPath','binary'].every(key=>(target[key]??'')===(currentTarget[key]??''));
    try{const config=store.get('services',run.serviceId);return require('./agent-requests.cjs').requestTargetKey(config,{...agentSettings(config),workPath:run.workPath})===require('./agent-requests.cjs').requestTargetKey(service,settings)&&agentSettings(config).binary===settings.binary;}catch{return false;}
  };
  const explicitPrevious=payload.continuedFromRunId?store.get('agent_runs',payload.continuedFromRunId):null;
  if(explicitPrevious&&(explicitPrevious.reviewId!==review.id||newConversation||!sameLocation(explicitPrevious)))throw new Error('같은 리뷰와 작업 폴더의 요청만 이어서 실행할 수 있습니다.');
  if(retry&&!newConversation) {
    const originalPrevious=retry.continuedFromRunId?store.get('agent_runs',retry.continuedFromRunId):null;
    if(explicitPrevious&&explicitPrevious.id!==retry.id&&explicitPrevious.id!==originalPrevious?.id)throw new Error('재실행은 원본 요청의 대화만 사용할 수 있습니다.');
    previous=retry.sessionId?retry:originalPrevious;
    if(!previous?.sessionId||previous.reviewId!==review.id||!sameLocation(previous))throw Object.assign(new Error('원본 요청의 대화를 사용할 수 없습니다. 새 대화를 선택하여 실행하십시오.'),{code:'AGENT_RETRY_SESSION_MISSING'});
  } else if(explicitPrevious) {
    if(!explicitPrevious.sessionId)throw Object.assign(new Error('이 요청의 대화를 사용할 수 없습니다. 새 대화를 선택하여 실행하십시오.'),{code:'AGENT_SESSION_MISSING'});
    previous=explicitPrevious;
  }
  const logicalPrevious=newConversation?null:retry?previous:explicitPrevious||previous;
  const snapshot=store.snapshot();
  const history=snapshot.activities.filter(item=>item.reviewId===review.id&&item.type==='comment').slice(-30).map(item=>`${item.role==='agent'?'에이전트':'사용자'}: ${item.body}`).join('\n\n').slice(-60000);
  const materials=agentMaterials(review.id),automaticContext=!materials.hasRequests,initialRequest=retry?(retry.context?.initialRequest??true):automaticContext,selection=retry?.context || (payload.context===undefined?{instruction:payload.includeInstruction??automaticContext,attachmentIds:payload.attachmentIds??materials.attachments.filter(item=>item.mimeType.startsWith('image/')?(payload.includeScreenshots??automaticContext):automaticContext).map(item=>item.id),logIds:payload.includeLogs===false?[]:payload.logCaptureId?[payload.logCaptureId]:(payload.includeLogs??automaticContext)?materials.logs.map(item=>item.id):[]}:payload.context);
  if(!selection||typeof selection!=='object'||Array.isArray(selection))throw new Error('에이전트 첨부 자료를 다시 선택하십시오.');
  const selectedIds=(value,label)=>{if(value===undefined)return [];if(!Array.isArray(value)||value.length>100||value.some(item=>typeof item!=='string')||new Set(value).size!==value.length)throw new Error(`${label} 목록이 올바르지 않습니다.`);return value;};
  const attachmentIds=selectedIds(selection.attachmentIds,'첨부파일'),logIds=selectedIds(selection.logIds,'리뷰 로그');
  const screenshot=selection.screenshotId?(retry?.context?.screenshot || materials.screenshots.find(item=>item.id===selection.screenshotId)):null;
  if(selection.screenshotId&&!screenshot)throw new Error('리뷰의 스크린샷을 다시 선택하십시오.');
  const available=[...materials.attachments,...materials.sharedFiles],chosen=attachmentIds.map(fileId=>{const item=available.find(entry=>entry.id===fileId);if(!item)throw new Error('같은 그룹의 첨부파일만 선택할 수 있습니다.');return retry?.context?.attachments?.find(entry=>entry.id===fileId) || item;});
  const logs=logIds.map(logId=>{const item=(retry?.context?.logs || materials.logs).find(entry=>entry.id===logId);if(!item)throw new Error('리뷰 로그를 다시 선택하십시오.');return item;});
  if(selection.instruction!==undefined&&typeof selection.instruction!=='boolean')throw new Error('작업 지시서 선택이 올바르지 않습니다.');
  const tokens=attachmentTokens(payload.attachmentTokens),staged=tokens.map(token=>{const item=ownedStaged(token);if(!item||item.expires<Date.now())throw new Error('첨부파일을 다시 선택하십시오. 임시 보관 시간이 지났습니다.');item.metadata.id ||= crypto.randomUUID();return item;});
  if(selection.screenshotToken&&!tokens.includes(selection.screenshotToken))throw new Error('선택한 스크린샷 파일을 다시 첨부하십시오.');
  const pendingScreenshot=selection.screenshotToken?staged.find(item=>item.token===selection.screenshotToken):null;
  if(pendingScreenshot&&!['image/png','image/jpeg','image/webp'].includes(pendingScreenshot.metadata.mimeType))throw new Error('PNG, JPEG, WebP 스크린샷을 선택하십시오.');
  const pendingFiles=staged.filter(item=>item!==pendingScreenshot).map(item=>({id:item.metadata.id,name:item.metadata.name,mimeType:item.metadata.mimeType,size:item.metadata.size,reviewId:review.id,source:'activity'}));
  const context={instruction:Boolean(selection.instruction),instructionMarkdown:selection.instruction?(retry?.context?.instructionMarkdown ?? materials.instruction.markdown):'',screenshotId:pendingScreenshot?.metadata.id || screenshot?.id || null,screenshot:pendingScreenshot?{...pendingScreenshot.metadata,storageName:undefined,sha256:undefined,reviewId:review.id}:screenshot,attachmentIds:[...new Set([...attachmentIds,...pendingFiles.map(item=>item.id)])],attachments:[...chosen,...pendingFiles],logIds,logs,...(!retry||retry.context?.initialRequest!==undefined?{initialRequest}:{})};
  const sources=[...new Map([...(screenshot?[screenshot]:[]),...chosen].map(item=>[item.id,item])).values()];
  const images=[],files=[];let imageBytes=0,fileBytes=0;
  const collect=(item,bytes)=>{if(['image/png','image/jpeg','image/webp'].includes(item.mimeType)){imageBytes+=bytes.length;if(images.length>=10||imageBytes>40*1024*1024)throw new Error('요청에 첨부할 이미지는 10개, 합계 40 MB까지 지원합니다.');images.push({name:item.name,mimeType:item.mimeType,bytes});}else{fileBytes+=bytes.length;if(files.length>=30||fileBytes>100*1024*1024)throw new Error('요청에 첨부할 파일은 30개, 합계 100 MB까지 지원합니다.');files.push({name:item.name,mimeType:item.mimeType,bytes});}};
  for(const item of sources)collect(item,await readAttachment(attachmentById(item.id)));
  for(const item of staged)collect(item.metadata,item.bytes);
  const logText=JSON.stringify(logs);
  const selectedLogText=logText.length>40000?logText.slice(0,40000)+'\n(긴 로그의 나머지 내용은 첨부 파일에서 확인하십시오.)':logText;
  const selectedText=[context.instructionMarkdown,logs.length?`선택한 로그:\n${selectedLogText}`:''].filter(Boolean).join('\n\n');
  const input=initialRequest?`리뷰: ${review.title}\n대상 파일: ${review.targetPath}\n대상 주소: ${review.targetUrl}\n${context.instructionMarkdown?`\n${context.instructionMarkdown}\n`:''}\n선택한 로그:\n${selectedLogText}\n이전 대화:\n${history}\n\n사용자 작업 요청:\n${prompt}`:selectedText?`${selectedText}\n\n사용자 작업 요청:\n${prompt}`:prompt;
  if(logs.length)files.push({name:'review-logs.json',mimeType:'application/json',bytes:Buffer.from(JSON.stringify(logs,null,2))});
  const job={id,kind:'agent',reviewId:review.id,serviceId:service.id,prompt,executionSettings,...(logicalPrevious?{continuedFromRunId:logicalPrevious.id}:{}),executionTarget:currentTarget,...(source?{sourceRunId:source.id}:{}),model:settings.model,reasoningEffort:settings.reasoningEffort,workPath:settings.workPath,sessionScope,status:'running',sessionId:previous?.sessionId||'',startedAt:new Date().toISOString(),context,newConversation,independentExecution,...(retry?{retryOf:retry.id}:{}),...(requestId?{requestId,requestSignature}:{})};
  const execution={...job,prompt:input,config:service,settings,images,files};
  manager.validateStart(execution);
  const preflightOperation=`agent-preflight:${id}`;operations.add(preflightOperation);
  try{await manager.preflight(service,settings);}
  catch(error){if(error.code==='SSH_TRUST_REQUIRED'&&error.fingerprint)pendingTrust.set(service.id,{fingerprint:error.fingerprint,host:service.host,port:service.port,expires:Date.now()+300000});throw error;}
  finally{operations.delete(preflightOperation);}
  if(requestWindowContext.getStore())getRequestWindow();
  if(store.get('reviews',review.id).serviceId!==service.id||JSON.stringify(serviceById(service.id,true))!==JSON.stringify(service))throw new Error('검사 중 프로젝트 설정이 변경되었습니다. 실행 대상을 살펴본 후 요청을 다시 보내십시오.');
  if(requestId){const existing=store.listAgentRuns().find(run=>run.id===requestId);if(existing){if(existing.requestSignature!==requestSignature)throw new Error('이미 사용한 요청 ID입니다. 새 요청으로 실행하십시오.');return agentJobs.get(requestId)||existing;}}
  assertNoAgent(job=>job.serviceId===service.id);
  assertNoAgentWorkspaceConflict(service,settings,independentExecution);
  manager.validateStart(execution);
  await saveWithAttachments(tokens,()=>{store.saveAgentRun(job);return store.addActivity({reviewId:review.id,body:displayPrompt,role:'user',agentRunId:id,status:'in_progress'});},activity=>({reviewId:review.id,activityId:activity.id}));
  operations.add(`agent:${id}`);agentJobs.set(id,job);
  try{manager.start(execution);return agentJobs.get(id);}
  catch(error){const failed={...job,status:'failed',error:error.message||'에이전트 실행을 시작하지 못했습니다.',errorCode:error.code||'AGENT_START_FAILED',finishedAt:new Date().toISOString()};agentJobs.set(id,failed);store.saveAgentRun(failed);operations.delete(`agent:${id}`);return failed;}
}

function attachmentTokens(value = []) {
  if (!Array.isArray(value) || value.length > 100 || value.some(token => typeof token !== 'string') || new Set(value).size !== value.length) throw new Error('첨부파일 목록이 올바르지 않습니다.');
  return value;
}
async function stageAttachments(paths) {
  for (const [token,item] of stagedAttachments) if (item.expires < Date.now()) stagedAttachments.delete(token);
  if(paths!==undefined && (!Array.isArray(paths)||paths.some(file=>typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))))throw new Error('첨부할 파일을 선택하십시오.');
  const selection = paths===undefined?await dialog.showOpenDialog(getRequestWindow(),{title:'첨부파일 추가',properties:['openFile','multiSelections']}):{canceled:false,filePaths:paths};
  if (selection.canceled) return [];
  if (selection.filePaths.length > 10) throw new Error('한 번에 최대 10개 파일을 추가할 수 있습니다.');
  if (stagedAttachments.size + selection.filePaths.length > 100) throw new Error('작성 중인 첨부파일은 100개까지 보관할 수 있습니다. 먼저 저장하거나 첨부를 취소하십시오.');
  const pending = [];
  let total = [...stagedAttachments.values()].reduce((sum,item)=>sum+item.bytes.length,0);
  for (const file of selection.filePaths) {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('첨부파일은 파일당 20 MB 이하여야 합니다.');
    const bytes = await fsp.readFile(file);
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > 200*1024*1024) throw new Error('첨부파일은 파일당 20 MB, 작성 중인 첨부파일 합계는 200 MB 이하여야 합니다.');
    const extension = path.extname(file).replace(/[^.a-zA-Z0-9]/g,'').slice(0,13);
    pending.push({token:crypto.randomUUID(),bytes,ownerWindow:getRequestWindow(),expires:Date.now()+30*60*1000,metadata:{name:path.basename(file),mimeType:mimeType(file),size:bytes.length,storageName:crypto.randomUUID()+extension,sha256:digest(bytes)}});
  }
  for (const item of pending) stagedAttachments.set(item.token,item);
  return pending.map(({token,metadata})=>({token,name:metadata.name,mimeType:metadata.mimeType,size:metadata.size}));
}
async function saveWithAttachments(value, change, references) {
  const tokens = attachmentTokens(value);
  const staged = tokens.map(token=>{
    const item = ownedStaged(token);
    if (!item || item.expires < Date.now()) throw new Error('첨부파일을 다시 선택하십시오. 임시 보관 시간이 지났습니다.');
    return item;
  });
  let entity,attachments;
  try {
    for (const item of staged) atomicWrite(path.join(attachmentPath,item.metadata.storageName),item.bytes);
    store.transaction(()=>{
      entity = change(staged.length);
      attachments = staged.map(item=>store.addAttachment({...item.metadata,...references(entity)}));
    });
  } catch(error) {
    for (const item of staged) await fsp.rm(path.join(attachmentPath,item.metadata.storageName),{force:true});
    throw error;
  }
  for (const token of tokens) stagedAttachments.delete(token);
  return {entity,attachments};
}

function changeWithCredentials(change) {
  const checkpoint = vault.checkpoint();
  try { return store.transaction(change); }
  catch(error) {
    try { vault.restore(checkpoint); }
    catch { throw new Error('인증 정보 변경을 되돌리지 못했습니다. 데이터 폴더의 쓰기 권한을 확인하십시오.'); }
    throw error;
  }
}
async function deleteEntity(kind, itemId) {
  store.get({group:'groups',project:'projects',service:'services',review:'reviews'}[kind],itemId);
  const snapshot=store.snapshot();
  const projects=new Set(snapshot.projects.filter(item=>kind==='group'?item.groupId===itemId:kind==='project'&&item.id===itemId).map(item=>item.id));
  const services=new Set(snapshot.services.filter(item=>kind==='group'?item.groupId===itemId:kind==='service'&&item.id===itemId).map(item=>item.id));
  const reviews=new Set(snapshot.reviews.filter(item=>projects.has(item.projectId)||(kind==='review'&&item.id===itemId)).map(item=>item.id));
  if(kind==='project')for(const config of snapshot.services)if(config.managedProjectId===itemId&&!snapshot.projects.some(project=>project.id!==itemId&&project.serviceIds.includes(config.id))&&!store.listAgentRuns().some(run=>run.serviceId===config.id&&!reviews.has(run.reviewId)))services.add(config.id);
  if(kind==='service'&&snapshot.projects.some(item=>item.serviceIds.includes(itemId)))throw Object.assign(new Error('연결된 프로젝트를 모두 해제한 뒤 서비스를 삭제하십시오.'),{code:'IN_USE'});
  const affected=job=>reviews.has(job.reviewId)||services.has(job.serviceId);
  await Promise.all([...agentJobs.values()].filter(job=>job.status==='running'&&affected(job)).map(job=>agents.cancel(job.id)));
  const attachments=snapshot.attachments.filter(item=>reviews.has(item.reviewId));
  const staging=attachments.length?path.join(attachmentPath,`.deleting-${crypto.randomUUID()}`):null,moved=[];let committed=false;
  try {
    if(staging)await fsp.mkdir(staging,{mode:0o700});
    for(const file of attachments) {
      if(!storagePattern.test(file.storageName))throw new Error('첨부파일 저장 경로가 올바르지 않습니다.');
      try{await fsp.rename(path.join(attachmentPath,file.storageName),path.join(staging,file.storageName));moved.push(file.storageName);}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    const remove=()=>{
      const result=store[`delete${kind[0].toUpperCase()+kind.slice(1)}`](itemId);
      for(const serviceId of services)vault.delete(serviceId);
      return result;
    };
    const result=services.size?changeWithCredentials(remove):remove();
    committed=true;
    for(const serviceId of services){pendingTrust.delete(serviceId);terminals.closeService(serviceId);}
    for(const [jobId,job] of agentJobs)if(affected(job)){agentJobs.delete(jobId);operations.delete(`agent:${jobId}`);}
    for(const record of windowContexts.values())if(reviews.has(record.pendingReview?.reviewId)){record.pendingDisplay?.reject(new Error('표시할 리뷰가 삭제되었습니다.'));record.pendingReview=null;}
    if(staging)await fsp.rm(staging,{recursive:true,force:true}).catch(()=>{});
    return result;
  } catch(error) {
    if(!committed)for(const storageName of moved)await fsp.rename(path.join(staging,storageName),path.join(attachmentPath,storageName));
    if(staging)await fsp.rm(staging,{recursive:true,force:true});
    throw error;
  }
}
async function cleanDeletedAttachments() {
  const retained=new Set(store.snapshot().attachments.map(item=>item.storageName));
  for(const entry of await fsp.readdir(attachmentPath,{withFileTypes:true}))if(entry.isDirectory()&&/^\.deleting-[a-f0-9-]{36}$/.test(entry.name)) {
    const directory=path.join(attachmentPath,entry.name);
    for(const storageName of await fsp.readdir(directory))if(storagePattern.test(storageName)&&retained.has(storageName)&&!fs.existsSync(path.join(attachmentPath,storageName)))await fsp.rename(path.join(directory,storageName),path.join(attachmentPath,storageName));
    await fsp.rm(directory,{recursive:true,force:true}).catch(()=>{});
  }
}
async function assertExportDestination(file) {
  const parent = await fsp.realpath(path.dirname(file));
  const managedRoot = await fsp.realpath(dataPath);
  if (inside(managedRoot,path.join(parent,path.basename(file)))) throw new Error('앱 데이터 폴더 밖에 저장하십시오. 기존 자료를 덮어쓸 수 없습니다.');
}

function publicSnapshot() {
  const snapshot = store.snapshot();
  snapshot.agentRunning=[...agentJobs.values()].filter(job=>job.kind==='agent'&&job.status==='running').length;
  snapshot.services = snapshot.services.map(service => ({...service, ...vault.flags(service.id)}));
  snapshot.projects=snapshot.projects.map(project=>({...project,connection:project.connection?{...project.connection,...vault.flags(project.connection.id)}:null}));
  return snapshot;
}
function credentialValues(service) {
  const fields = service.kind !== 'ssh' || service.hostAlias ? [] : service.authType === 'password' ? ['password'] : service.authType === 'key' ? ['passphrase'] : [];
  return vault.get(service.id,fields);
}
function serviceById(id, needsSecret = false) {
  const service = store.snapshot().services.find(item => item.id === id);
  if (!service) throw new Error('프로젝트 연결 설정을 찾을 수 없습니다.');
  return needsSecret ? {...service, ...credentialValues(service)} : service;
}
function attachmentById(id) {
  const item = store.snapshot().attachments.find(entry => entry.id === id);
  if (!item || !storagePattern.test(item.storageName)) throw new Error('첨부파일을 찾을 수 없습니다.');
  return item;
}
async function readAttachment(item) {
  const file = path.join(attachmentPath, item.storageName);
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('첨부파일이 올바르지 않습니다.');
  const bytes = await fsp.readFile(file);
  if (digest(bytes) !== item.sha256) throw Object.assign(new Error('첨부파일이 변경되었거나 손상되었습니다.'),{code:'ATTACHMENT_INTEGRITY_FAILED'});
  return bytes;
}
async function backupBundle() {
  const data = store.exportData();
  const files = {};
  let total = 0;
  for (const item of data.attachments) {
    const bytes = await readAttachment(item);
    total += bytes.length;
    if (total > 200 * 1024 * 1024) throw new Error('첨부파일 합계가 200 MB를 초과합니다. 데이터 폴더를 복사해 백업하십시오.');
    files[item.storageName] = bytes.toString('base64');
  }
  return {format:'reviewops-local-backup', version:1, createdAt:new Date().toISOString(), data, files};
}
async function exportBackup() {
  const { canceled, filePath } = await dialog.showSaveDialog(getRequestWindow(), {title:'백업 저장', defaultPath:`ReviewOps-${new Date().toISOString().slice(0,10)}.reviewops.json`, filters:[{name:'ReviewOps 백업', extensions:['json']}]});
  if (canceled || !filePath) return {cancelled:true};
  await assertExportDestination(filePath);
  atomicWrite(filePath, JSON.stringify(await backupBundle()));
  return {path:filePath};
}
async function assertOtherWindowsSaved(caller) {
  for(const host of liveWindows())if(host!==caller&&host.webContents.executeJavaScript&&await host.webContents.executeJavaScript('document.documentElement.dataset.reviewopsDirty === "true"'))throw new Error('다른 창에서 작성 중인 내용을 저장하거나 닫은 뒤 백업을 복원하십시오.');
}
async function importBackup() {
  const caller=getRequestWindow();await assertOtherWindowsSaved(caller);
  const selection = await dialog.showOpenDialog(getRequestWindow(), {title:'백업 복원', properties:['openFile'], filters:[{name:'ReviewOps 백업', extensions:['json']}]});
  if (selection.canceled) return {cancelled:true};
  const file = selection.filePaths[0];
  if ((await fsp.stat(file)).size > 300 * 1024 * 1024) throw new Error('백업 파일은 300 MB 이하여야 합니다.');
  const bundle = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (bundle.format !== 'reviewops-local-backup' || bundle.version !== 1 || !bundle.data || !bundle.files || !Array.isArray(bundle.data.attachments)) throw new Error('지원하지 않는 백업 파일입니다.');
  const validatedFiles = [];
  let total = 0;
  for (const attachment of bundle.data.attachments) {
    if (!storagePattern.test(attachment.storageName) || typeof bundle.files[attachment.storageName] !== 'string') throw new Error('백업 첨부파일 정보가 올바르지 않습니다.');
    const encoded = bundle.files[attachment.storageName];
    if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('백업 첨부파일이 올바르지 않습니다.');
    const bytes = Buffer.from(encoded,'base64');
    total += bytes.length;
    if (bytes.length !== attachment.size || bytes.length > MAX_FILE_BYTES || total > 200 * 1024 * 1024 || digest(bytes) !== attachment.sha256) throw new Error('백업 첨부파일이 손상되었습니다.');
    const storageName = crypto.randomUUID() + path.extname(attachment.storageName);
    validatedFiles.push({ storageName, bytes });
    attachment.storageName = storageName;
  }
  // Validate the complete relationship graph before modifying the working database.
  const tempDir = await fsp.mkdtemp(path.join(app.getPath('temp'),'reviewops-restore-'));
  let validation;
  try {
    validation = createStore({dbPath:path.join(tempDir,'validate.sqlite')});
    validation.importData(bundle.data);
  } finally { validation?.close(); await fsp.rm(tempDir,{recursive:true,force:true}); }
  if (operations.size) throw new Error('진행 중인 SSH 또는 에이전트 작업이 끝난 후 복원하십시오.');
  const choice = await dialog.showMessageBox(getRequestWindow(), {type:'warning', title:'백업 복원', message:'현재 자료를 백업 파일의 내용으로 교체합니다.', detail:'복원 전 자료는 데이터 폴더의 recovery 폴더에 저장됩니다. SSH 비밀번호와 서버 인증 정보는 다시 설정해야 합니다.', buttons:['취소','복원'], defaultId:0, cancelId:0, noLink:true});
  if (choice.response !== 1) return {cancelled:true};
  await assertOtherWindowsSaved(caller);
  if(operations.size)throw new Error('진행 중인 SSH 또는 에이전트 작업이 끝난 후 복원하십시오.');
  const recoveryDir = path.join(dataPath,'recovery',new Date().toISOString().replace(/[:.]/g,'-'));
  await fsp.mkdir(recoveryDir,{recursive:true,mode:0o700});
  atomicWrite(path.join(recoveryDir,'backup.reviewops.json'), JSON.stringify(await backupBundle()));
  if (fs.existsSync(path.join(dataPath,'credentials.json'))) await fsp.copyFile(path.join(dataPath,'credentials.json'), path.join(recoveryDir,'credentials.json'));
  await assertOtherWindowsSaved(caller);
  try {
    for (const item of validatedFiles) atomicWrite(path.join(attachmentPath,item.storageName),item.bytes);
    changeWithCredentials(() => {
      vault.clear();
      store.importData(bundle.data);
    });
  } catch(error) {
    for (const item of validatedFiles) await fsp.rm(path.join(attachmentPath,item.storageName),{force:true});
    throw error;
  }
  pendingTrust.clear();
  await agents?.closeAll();agents=null;agentJobs.clear();
  store.interruptAgentRuns();
  closeAllBrowsers();
  terminals.closeAll();terminalOwners.clear();
  stagedAttachments.clear();
  return {imported:true};
}

async function sshAction(action, payload) {
  const service = serviceById(payload.serviceId||store.project(payload.projectId).connection?.id,true);
  if (service.kind !== 'ssh') throw new Error('SSH 연결이 설정된 프로젝트에서 사용할 수 있습니다.');
  const token = crypto.randomUUID(); operations.add(token);
  try {
    if (action === 'ssh.test') return await ssh.test(service);
    if (action === 'ssh.run') return await ssh.run(service, payload.command);
    if (action === 'terminal.open') {const host=getRequestWindow(),result=await terminals.open(service,{cols:payload.cols,rows:payload.rows});if(!windowContexts.has(host)||host.isDestroyed()){terminals.close(result.id);throw new Error('요청한 창이 닫혔습니다.');}terminalOwners.set(result.id,host);return result;}
    if (action === 'files.list') return await ssh.list(service, payload.path || '');
    return await ssh.read(service, payload.path);
  } catch(error) {
    if (error.code === 'SSH_TRUST_REQUIRED' && error.fingerprint) pendingTrust.set(service.id,{fingerprint:error.fingerprint,host:service.host,port:service.port,expires:Date.now()+5*60*1000});
    throw error;
  } finally { operations.delete(token); }
}

function nativeWindowState(host) {
  return {maximized:host.isMaximized(),fullScreen:host.isFullScreen()};
}
function toggleWindowFullScreen(host) {
  const pending = windowFullScreenChanges.get(host);
  if (pending) return pending;
  const target = !host.isFullScreen();
  const event = target ? 'enter-full-screen' : 'leave-full-screen';
  const transition = new Promise((resolve,reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer);host.removeListener(event,changed);host.removeListener('closed',closed); };
    const changed = () => { cleanup();resolve(nativeWindowState(host)); };
    const closed = () => { cleanup();reject(new Error('창이 닫혔습니다.')); };
    host.once(event,changed);
    host.once('closed',closed);
    timer = setTimeout(() => {
      cleanup();
      if (host.isDestroyed()) reject(new Error('창이 닫혔습니다.'));
      else if (host.isFullScreen() === target) resolve(nativeWindowState(host));
      else reject(new Error('전체 화면 전환을 완료하지 못했습니다.'));
    },10000);
    timer.unref?.();
    try { host.setFullScreen(target); } catch(error) { cleanup();reject(error); }
  });
  const result = transition.finally(() => windowFullScreenChanges.delete(host));
  windowFullScreenChanges.set(host,result);
  return result;
}

async function dispatch(action, payload = {}) {
  if(requestWindowContext.getStore())getRequestWindow();
  if(payload.projectId&&!payload.serviceId&&['ssh.test','ssh.run','terminal.open','files.list','files.read','agent.environment','agent.login','agent.logout','agent.loginState','agent.session'].includes(action))payload={...payload,serviceId:store.project(payload.projectId).connection?.id};
  if (typeof action !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('요청이 올바르지 않습니다.');
  if (action === 'clipboard.writeText') {
    if(typeof payload.text!=='string'||!payload.text.length||Buffer.byteLength(payload.text)>2*1024*1024)throw new Error('복사할 내용을 다시 선택하십시오.');
    clipboard.writeText(payload.text);
    return {copied:true};
  }
  if (action === 'app.language') {const result=appLanguage.setLanguage(payload.language);updateNativeMenu();return result;}
  if (action.startsWith('update.')) {
    if (!updater) throw new Error('Update settings are not ready.');
    if (action === 'update.copyInfo') {
      const state = updater.snapshot();
      const tr = appLanguage.t;
      const describe = (label, build) => !build ? [] : [`${tr(label)}: ${build.version} (${tr(build.channel === 'test' ? '테스트' : '정식')})`, ...(build.channel === 'test' ? [`${tr('빌드 번호')}: ${build.buildNumber}`, `${tr('커밋')}: ${build.commit}`, `${tr('생성 시간')}: ${build.builtAt}`] : [])];
      clipboard.writeText([...describe('설치된 버전', state.installedBuild), ...describe('받을 버전', state.availableBuild || (state.availableVersion ? {channel:'stable',version:state.availableVersion} : null)), `CPU: ${state.arch}`].join('\n'));
      return { copied: true };
    }
    const method = { 'update.state':'snapshot', 'update.check':'check', 'update.download':'download', 'update.install':'install', 'update.apply':'apply', 'update.configure':'configure', 'update.openRelease':'openRelease', 'update.rendererReady':'markHealthy' }[action];
    if (!method) throw new Error('Unsupported update action.');
    return updater[method](payload);
  }
  if (action.startsWith('modelCache.')) {
    if (!modelCache) throw new Error('모델 목록을 준비하고 있습니다.');
    if (updater?.installing && action!=='modelCache.state') throw new Error('ReviewOps is restarting to install an update.');
    if (action==='modelCache.state') return modelCache.snapshot();
    if (action==='modelCache.configure') return modelCache.configure(payload);
    if (action==='modelCache.refresh') { await modelCache.refresh(payload.id); return modelCache.snapshot(); }
    throw new Error('지원하지 않는 모델 목록 요청입니다.');
  }
  if (updater?.installing && !['snapshot','app.info','integration.pending','integration.displayed'].includes(action) && !windowActions.has(action)) throw new Error('ReviewOps is restarting to install an update.');
  if (action === 'window.context') {const record=currentWindowRecord();return {windowId:record.id,projectId:record.projectId};}
  if (action === 'window.navigation') return currentWindowRecord().pendingNavigation || null;
  if (action === 'window.openProject') {
    const project=store.snapshot().projects.find(item=>item.id===payload.projectId);if(!project)throw new Error('프로젝트를 찾을 수 없습니다.');
    const section=payload.section||'review',reviewMode=payload.reviewMode||'detail';
    if(!['review','dashboard','file','terminal','settings'].includes(section)||!['detail','create','edit'].includes(reviewMode))throw new Error('요청한 프로젝트 화면이 올바르지 않습니다.');
    if(payload.reviewId&&store.get('reviews',payload.reviewId).projectId!==project.id)throw new Error('요청한 리뷰의 프로젝트가 일치하지 않습니다.');
    if(reviewMode==='edit'&&!payload.reviewId)throw new Error('수정할 리뷰를 지정하십시오.');
    const existing=projectWindows.get(project.id);
    const record=projectWindow(project.id),host=record.host;
    if(payload.preserveNavigation===true&&existing===record){if(host.isMinimized())host.restore();host.show();host.focus();return {windowId:record.id,projectId:project.id};}
    const value={projectId:project.id,section,reviewMode,reviewId:payload.reviewId||'',request:integrationSequence=Math.max(Date.now(),integrationSequence+1)};
    record.pendingDisplay?.reject(new Error('다른 화면을 선택하여 이전 리뷰 표시를 취소했습니다.'));record.pendingReview=null;
    record.pendingNavigation=value;host.show();host.focus();
    const send=()=>{if(!host.isDestroyed()&&record.pendingNavigation===value)host.webContents.send('reviewops:project-open',value);};
    if(host.webContents.isLoadingMainFrame())host.webContents.once('did-finish-load',send);else send();
    return {windowId:record.id,projectId:project.id};
  }
  if (action === 'integration.pending') return currentWindowRecord().pendingReview || null;
  if (action === 'integration.displayed') {
    const record=currentWindowRecord(),requested=record.pendingReview;
    const matches=requested&&['request','view','projectId','reviewId'].every(key=>payload[key]===requested[key]);
    if(!matches||payload.section!=='review')return {accepted:false};
    if(payload.error)record.pendingDisplay?.reject(new Error(String(payload.error).slice(0,1000)));else record.pendingDisplay?.resolve();
    return {accepted:true};
  }
  if (windowActions.has(action)) {
    const host=getRequestWindow();if(!host||host.isDestroyed())throw new Error('창이 닫혔습니다.');
    if(action==='window.close'){setImmediate(()=>{if(!host.isDestroyed())host.close();});return {closing:true};}
    if(action==='window.fullscreen')return toggleWindowFullScreen(host);
    return nativeWindowState(host);
  }
  if (restoring && !['snapshot','app.info','terminal.read','terminal.close','terminal.resize'].includes(action)) throw new Error('백업 복원이 끝난 후 다시 시도하십시오.');
  if(action.startsWith('agent.'))return agentAction(action,payload);
  if(action==='attachment.stageData')return stageScreenshot(payload);
  if(action==='screenshot.export') {
    const bytes=screenshotBytes(payload),selection=await dialog.showSaveDialog(getRequestWindow(),{title:'스크린샷 저장',defaultPath:screenshotName(payload.name),filters:[{name:'PNG 이미지',extensions:['png']}]});
    if(selection.canceled||!selection.filePath)return {cancelled:true};
    await assertExportDestination(selection.filePath);atomicWrite(selection.filePath,bytes);return {path:selection.filePath};
  }
  if(action==='viewer.capture') {
    const host=getRequestWindow(),bounds=payload.bounds,size=host.getContentSize(),zoom=host.webContents.getZoomFactor();
    if(!bounds||!['x','y','width','height'].every(key=>Number.isFinite(bounds[key]))||bounds.width<=0||bounds.height<=0)throw new Error('캡처할 화면이 없습니다.');
    const x=Math.max(0,Math.floor(bounds.x*zoom)),y=Math.max(0,Math.floor(bounds.y*zoom)),width=Math.min(Math.ceil(bounds.width*zoom),size[0]-x),height=Math.min(Math.ceil(bounds.height*zoom),size[1]-y);
    if(width<=0||height<=0)throw new Error('캡처할 화면이 없습니다.');
    const image=await host.webContents.capturePage({x,y,width,height});
    if(image.isEmpty())throw new Error('화면을 캡처하지 못했습니다.');
    const bytes=image.toPNG();return {dataUrl:`data:image/png;base64,${bytes.toString('base64')}`,mimeType:'image/png',name:screenshotName(),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),capturedAt:new Date().toISOString()};
  }
  if (action.startsWith('browser.')) {
    const record=currentWindowRecord();
    if(!record.browsers)record.browsers=require('./browser.cjs').createBrowserManager(record.host,{...(record.projectId?{partition:'persist:reviewops-browser-project-'+record.projectId}:{}),backgroundPopups:()=>record.qaActive===true});
    return record.browsers.dispatch(action,payload);
  }
  if (action === 'snapshot') return publicSnapshot();
  if (action === 'app.info') return {version:app.getVersion(),dataPath,platform:process.platform,arch:process.arch};
  if (action === 'app.openDataFolder') { const error = await shell.openPath(dataPath); if(error) throw new Error(error); return; }
  if (action === 'external.open') {
    const url = new URL(payload.url);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP 또는 HTTPS 주소만 열 수 있습니다.');
    await shell.openExternal(url.href); return;
  }
  if (action === 'group.save') return store.saveGroup(payload);
  if (action === 'project.save') {
    if(payload.connection===undefined)return store.saveProject(payload);
    const previous=payload.id?store.project(payload.id):null;
    if(previous)assertNoAgent(job=>job.reviewId?store.snapshot().reviews.some(review=>review.id===job.reviewId&&review.projectId===previous.id):job.serviceId===previous.connection?.id);
    let connection=payload.connection;
    if(connection&&connection.kind==='ssh'&&connection.hostAlias){
      const host=await codexManager.resolveHost(connection.hostAlias);
      connection={...connection,hostAlias:host.alias,sshConfigPath:host.configPath,host:host.hostName||host.alias,username:host.user||require('node:os').userInfo().username,port:Number(host.port)||22,authType:'agent',privateKeyPath:'',hostFingerprint:''};
    }else if(connection?.kind==='ssh'&&(!previous?.connection||previous.connection.hostAlias))throw new Error('SSH 호스트를 선택하십시오.');
    const prepared=vault.prepare(connection||{}),clean=connection?{...connection}:connection;
    if(clean){
      // A renderer form can predate a successful trust prompt. Only ssh.trust
      // writes pins; ordinary edits retain the current pin for the same target.
      for(const field of ['password','passphrase','clearPassword','clearPassphrase','hasPassword','hasPassphrase','hostFingerprint'])delete clean[field];
      if(clean.hostAlias)clean.hostFingerprint='';
    }
    const result=changeWithCredentials(()=>{
      const project=store.saveProject({...payload,connection:clean});
      if(project.connection){
        if(project.connectionClonedFrom&&!project.connection.hostAlias&&project.connection.kind==='ssh'){
          const records=JSON.parse(vault.checkpoint());
          if(records[project.connectionClonedFrom])vault.restore(JSON.stringify({...records,[project.connection.id]:{...records[project.connectionClonedFrom]}}));
        }
        vault.commit(project.connection.id,prepared);
      }
      return project;
    });
    if(previous?.connection&&(previous.connection.id!==result.connection?.id||['kind','host','port','username','authType','privateKeyPath','rootPath','hostAlias','sshConfigPath'].some(field=>previous.connection[field]!==result.connection?.[field])||Object.keys(prepared).length)){pendingTrust.delete(previous.connection.id);terminals.closeService(previous.connection.id);}
    const {connectionClonedFrom,...project}=result;
    return {...project,connection:project.connection?{...project.connection,...vault.flags(project.connection.id)}:null};
  }
  if (action === 'reviewCategory.save') return store.saveReviewCategory(payload);
  if (action === 'review.copy') {
    const {copySource,copyReviewRecord}=require('./review-copy.cjs');
    const source=copySource(store,payload),tokens=[];let total=0;
    try {
      for(const file of source.attachments){
        const bytes=await readAttachment(file),token=crypto.randomUUID();
        total+=bytes.length;if(total>200*1024*1024)throw new Error('복사할 첨부 파일은 합계 200 MB까지 지원합니다.');
        stagedAttachments.set(token,{token,bytes,ownerWindow:getRequestWindow(),expires:Date.now()+300000,metadata:{name:file.name,mimeType:file.mimeType,size:bytes.length,sha256:digest(bytes),storageName:crypto.randomUUID()+path.extname(file.storageName)}});
        tokens.push(token);
      }
      return (await saveWithAttachments(tokens,()=>copyReviewRecord(store,payload),review=>({reviewId:review.id}))).entity;
    } finally {for(const token of tokens)stagedAttachments.delete(token);}
  }
  if (action === 'review.version.list') return listReviewVersions(store,payload.reviewId,readAttachment);
  if (action === 'review.version.save') return saveReviewVersion(store,payload,readAttachment);
  if (action === 'review.version.target') return changeReviewTarget(store,payload);
  if (action === 'review.save') {const input={...payload};if(!payload.id&&payload.serviceId===undefined&&payload.projectId)input.serviceId=store.project(payload.projectId).connection?.id||null;return (await saveWithAttachments(payload.attachmentTokens,()=>store.saveReview(input),review=>({reviewId:review.id}))).entity;}
  if (action === 'service.save') {
    if(payload.id)assertNoAgent(job=>job.serviceId===payload.id);
    const previous = payload.id ? store.get('services',payload.id) : null;
    const prepared = vault.prepare(payload);
    const clean = {...payload};
    for (const field of ['password','passphrase','clearPassword','clearPassphrase','hasPassword','hasPassphrase','hostFingerprint']) delete clean[field];
    const service = changeWithCredentials(() => {
      const saved = store.saveService(clean);
      vault.commit(saved.id,prepared);
      return saved;
    });
    const connectionChanged = previous && (['kind','host','port','username','authType','privateKeyPath','rootPath'].some(field=>previous[field]!==service[field]) || Object.keys(prepared).length>0);
    if (connectionChanged) {
      pendingTrust.delete(service.id);
      terminals.closeService(service.id);
    }
    return {...service,...vault.flags(service.id)};
  }
  if (['group.delete','project.delete','service.delete','review.delete'].includes(action)) return deleteEntity(action.split('.')[0],payload.id);
  if (action === 'activity.add') return (await saveWithAttachments(payload.attachmentTokens,count=>store.addActivity({...payload,allowEmpty:count>0}),activity=>({reviewId:payload.reviewId,activityId:activity.id}))).entity;
  if (action === 'activity.update') {
    const remove=attachmentTokens(payload.removeAttachmentIds),deleted=remove.map(id=>attachmentById(id));
    const result=(await saveWithAttachments(payload.attachmentTokens,count=>store.updateActivity({...payload,allowEmpty:count>0}),activity=>({reviewId:activity.reviewId,activityId:activity.id}))).entity;
    for(const file of deleted)await fsp.rm(path.join(attachmentPath,file.storageName),{force:true}).catch(()=>{});
    return result;
  }
  if (action === 'settings.save') return store.saveSettings(payload);
  if (action === 'directory.inspect') return inspectDirectory(payload.path);
  if (action === 'directory.create') return createChildDirectory(payload.parent,payload.name);
  if (action === 'dialog.directory' || action === 'dialog.key' || action === 'dialog.executable') {
    const selection = await dialog.showOpenDialog(getRequestWindow(),{title:action === 'dialog.key' ? 'SSH 개인 키 선택' : action==='dialog.executable'?'Codex 실행 파일 선택':'로컬 폴더 선택',properties:action==='dialog.directory'?['openDirectory','createDirectory']:['openFile','showHiddenFiles']});
    return selection.canceled ? null : selection.filePaths[0];
  }
  if (action === 'attachment.stage') return stageAttachments();
  if (action === 'attachment.stageFiles') return stageAttachments(payload.paths);
  if (action === 'attachment.staged') {
    const tokens=attachmentTokens(payload.tokens),files=[],expiredTokens=[];
    for(const token of tokens){const item=ownedStaged(token);if(!item||item.expires<Date.now()){expiredTokens.push(token);stagedAttachments.delete(token);}else files.push({token,name:item.metadata.name,mimeType:item.metadata.mimeType,size:item.metadata.size});}
    return {files,expiredTokens};
  }
  if (action === 'attachment.stagePreview') {
    const item=ownedStaged(payload.token);
    if(!item||item.expires<Date.now())throw new Error('첨부파일을 다시 선택하십시오. 임시 보관 시간이 지났습니다.');
    return describeBytes(item.bytes,item.metadata.name);
  }
  if (action === 'attachment.discard') {
    for (const token of attachmentTokens(payload.tokens)) {ownedStaged(token);stagedAttachments.delete(token);}
    return {discarded:true};
  }
  if (action === 'attachment.add') {
    if (!store.snapshot().reviews.some(item => item.id === payload.reviewId)) throw new Error('리뷰를 찾을 수 없습니다.');
    const staged = await stageAttachments();
    try {
      return (await saveWithAttachments(staged.map(item=>item.token),()=>null,()=>({reviewId:payload.reviewId,activityId:payload.activityId}))).attachments;
    } finally { for (const item of staged) stagedAttachments.delete(item.token); }
  }
  if (action === 'attachment.read') { const item=attachmentById(payload.id); return describeBytes(await readAttachment(item),item.name); }
  if (action === 'attachment.delete') {
    const item=attachmentById(payload.id); const result=store.deleteAttachment(item.id);
    await fsp.rm(path.join(attachmentPath,item.storageName),{force:true}); return result;
  }
  if (action === 'attachment.export') {
    const item=attachmentById(payload.id); const bytes=await readAttachment(item);
    const selection=await dialog.showSaveDialog(getRequestWindow(),{title:'첨부파일 저장',defaultPath:item.name});
    if(selection.canceled) return {cancelled:true};
    await assertExportDestination(selection.filePath);
    atomicWrite(selection.filePath,bytes); return {path:selection.filePath};
  }
  if (action === 'files.list' || action === 'files.read') {
    const service = serviceById(payload.serviceId);
    if (service.kind === 'ssh') return sshAction(action,payload);
    return action === 'files.list' ? listLocal(service,payload.path || '') : readLocal(service,payload.path);
  }
  if (action === 'ssh.test' || action === 'ssh.run' || action === 'terminal.open') return sshAction(action,payload);
  if (action === 'terminal.read') return terminals.read(ownedTerminal(payload.id),payload.cursor);
  if (action === 'terminal.write') return terminals.write(ownedTerminal(payload.id),payload.data);
  if (action === 'terminal.resize') return terminals.resize(ownedTerminal(payload.id),{cols:payload.cols,rows:payload.rows});
  if (action === 'terminal.close') {ownedTerminal(payload.id);terminalOwners.delete(payload.id);return terminals.close(payload.id);}
  if (action === 'ssh.trust') {
    const service=serviceById(payload.serviceId), pending=pendingTrust.get(service.id);
    if (!pending || pending.expires < Date.now() || pending.host !== service.host || pending.port !== service.port || pending.fingerprint !== payload.fingerprint) throw new Error('연결 검사를 다시 실행한 후 서버 인증 정보를 승인하십시오.');
    pendingTrust.delete(service.id);
    return store.saveService({...service,hostFingerprint:pending.fingerprint});
  }
  if (action === 'backup.export') return exportBackup();
  if (action === 'backup.import') {
    restoring = true;
    try { return await importBackup(); } finally { restoring = false; }
  }
  throw new Error('지원하지 않는 기능입니다.');
}

function senderWindow(event) {
  const host=liveWindows().find(host=>event.sender===host.webContents&&event.senderFrame===host.webContents.mainFrame);
  if(!host)return null;
  try{const url=new URL(event.senderFrame.url);return (devUrl?url.origin===new URL(devUrl).origin:url.protocol==='reviewops:'&&url.host==='app')?host:null;}catch{return null;}
}
function trustedSender(event) { return Boolean(senderWindow(event)); }
function updateNativeMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appLanguage.menu([
      {label:'ReviewOps',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{type:'separator'},{role:'quit'}]},
      {label:'편집',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'보기',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]},
      {label:'윈도우',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]}
    ])));
}
function createWindow(projectId='',{background=false}={}) {
  const host=new BrowserWindow({show:!background,width:1440,height:940,minWidth:800,minHeight:600,title:'ReviewOps',frame:false,fullscreenable:true,simpleFullscreen:false,backgroundColor:'#f7f5f2',
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,webviewTag:false,backgroundThrottling:false}});
  const record={id:crypto.randomUUID(),host,projectId,browsers:null,pendingReview:null,pendingDisplay:null,pendingNavigation:null,presentationQueue:Promise.resolve()};
  windowContexts.set(host,record);if(projectId)projectWindows.set(projectId,record);else window=host;
  const notify=()=>{if(!host.isDestroyed())host.webContents.send('reviewops:window-state',nativeWindowState(host));};
  for(const event of ['maximize','unmaximize','enter-full-screen','leave-full-screen'])host.on(event,notify);
  host.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  host.webContents.on('will-navigate',(event,url)=>{if(url!==host.webContents.getURL())event.preventDefault();});
  host.webContents.on('render-process-gone',()=>{closeWindowResources(host,false);record.pendingDisplay?.reject(new Error('프로젝트 화면의 연결이 끊겼습니다.'));});
  host.webContents.on('did-start-navigation',(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace)closeWindowResources(host,false);});
  host.webContents.on('will-prevent-unload',event=>{
    if(quitApproved.has(host)){event.preventDefault();return;}
    const response=dialog.showMessageBoxSync(host,{type:'question',title:'저장하지 않은 내용',message:'저장하지 않은 내용을 버리고 닫으시겠습니까?',buttons:['계속 작성','내용 버리고 닫기'],defaultId:0,cancelId:0,noLink:true});
    if(response===1)event.preventDefault();else{quitting=false;updater?.cancelInstall();}
  });
  const allowFullscreen=(contents,permission,requestingUrl)=>{
    if(permission!=='fullscreen'||!liveWindows().some(item=>item.webContents===contents))return false;
    try{const url=new URL(requestingUrl||contents.getURL());return devUrl?url.origin===new URL(devUrl).origin:url.protocol==='reviewops:'&&url.host==='app';}catch{return false;}
  };
  host.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(details.isMainFrame!==false&&allowFullscreen(contents,permission,details.requestingUrl)));
  host.webContents.session.setPermissionCheckHandler((contents,permission,origin)=>allowFullscreen(contents,permission,origin));
  const location=devUrl||'reviewops://app/index.html',url=new URL(location);
  if(projectId){url.searchParams.set('projectId',projectId);url.searchParams.set('windowId',record.id);}
  host.loadURL(projectId?url.href:location)?.catch(error=>{record.loadError=error.message;record.pendingDisplay?.reject(error);});
  host.on('closed',()=>{
    closeWindowResources(host);record.pendingDisplay?.reject(new Error('프로젝트 화면을 표시하기 전에 창이 닫혔습니다.'));
    windowContexts.delete(host);if(projectWindows.get(projectId)===record)projectWindows.delete(projectId);if(window===host)window=null;
    if(quitting&&!liveWindows().length){quitting=false;app.quit();}
  });
  return record;
}
function projectWindow(projectId,options) {const existing=projectWindows.get(projectId);return existing&&!existing.host.isDestroyed()?existing:createWindow(projectId,options);}
async function presentReview(record,{reviewId,projectId,fullscreen,displayBounds,focus=true}) {
  const host=record.host;if(host.isDestroyed())throw new Error('프로젝트 화면을 표시하기 전에 창이 닫혔습니다.');
  const current=store.get('reviews',reviewId);if(current.projectId!==projectId)throw new Error('요청한 리뷰의 프로젝트가 일치하지 않습니다.');
  const displays=require('electron').screen.getAllDisplays();
  const chosen=displayBounds&&displays.find(display=>['x','y','width','height'].every(key=>display.bounds[key]===displayBounds[key]))||displays.find(display=>display.id!==require('electron').screen.getPrimaryDisplay().id)||displays[0];
  if(host.isMinimized())host.restore();
  const matchingBounds=()=>['x','y','width','height'].every(key=>Math.abs(host.getBounds()[key]-chosen.bounds[key])<=4);
  if(fullscreen&&host.isFullScreen()&&!matchingBounds())await toggleWindowFullScreen(host);
  if(fullscreen&&!host.isFullScreen()){host.setBounds(chosen.bounds);await toggleWindowFullScreen(host);}
  const requested={view:'project',projectId,reviewId,request:integrationSequence=Math.max(Date.now(),integrationSequence+1)};record.pendingNavigation=null;record.pendingReview=requested;
  const displayed=new Promise((resolve,reject)=>{
    let timer;const cleanup=()=>{clearTimeout(timer);host.removeListener('closed',closed);host.webContents.removeListener('render-process-gone',closed);if(record.pendingDisplay?.request===requested.request)record.pendingDisplay=null;};
    const closed=()=>{cleanup();reject(new Error('프로젝트 화면을 표시하기 전에 창이 닫혔습니다.'));};
    record.pendingDisplay={request:requested.request,resolve:()=>{cleanup();resolve();},reject:error=>{cleanup();reject(error);}};
    host.once('closed',closed);host.webContents.once('render-process-gone',closed);
    timer=setTimeout(()=>{cleanup();reject(new Error('프로젝트 화면을 표시하지 못했습니다. 같은 요청을 다시 보내십시오.'));},8000);
  });
  if(focus){host.show();host.focus();}else host.showInactive();
  const send=()=>{if(!host.isDestroyed()&&record.pendingReview===requested)host.webContents.send('reviewops:season-review',requested);};
  if(host.webContents.isLoadingMainFrame())host.webContents.once('did-finish-load',send);else send();
  await displayed;
  return {shown:host.isVisible()&&!host.isMinimized()&&(!fullscreen||(host.isFullScreen()&&matchingBounds())),fullscreen:host.isFullScreen(),windowId:record.id,view:'project',projectId,reviewId};
}
async function showProjectReview({reviewId,projectId,view='project',fullscreen,displayBounds}) {
  const snapshot=store.snapshot(),review=snapshot.reviews.find(item=>item.id===reviewId),project=snapshot.projects.find(item=>item.id===(projectId||review?.projectId));
  if(view!=='project'||!review||!project||review.projectId!==project.id)throw new Error('요청한 리뷰의 프로젝트를 찾을 수 없습니다.');
  const record=projectWindow(project.id),show=()=>presentReview(record,{reviewId,projectId:project.id,fullscreen,displayBounds});
  const result=record.presentationQueue.then(show);record.presentationQueue=result.catch(()=>{});return result;
}
async function beginQuit() {
  const hosts=liveWindows();
  try {
    for(const host of hosts){
      const dirty=host.webContents.executeJavaScript?await host.webContents.executeJavaScript('document.documentElement.dataset.reviewopsDirty === "true"'):false;
      if(dirty){const answer=dialog.showMessageBoxSync(host,{type:'question',title:'저장하지 않은 내용',message:'저장하지 않은 내용을 버리고 닫으시겠습니까?',buttons:['계속 작성','내용 버리고 닫기'],defaultId:0,cancelId:0,noLink:true});if(answer!==1){quitting=false;updater?.cancelInstall();return;}}
    }
    for(const host of hosts)quitApproved.add(host);
    for(const host of hosts)if(!host.isDestroyed())host.close();
    if(!liveWindows().length){quitting=false;app.quit();}
  }catch(error){quitting=false;updater?.cancelInstall();dialog.showErrorBox('ReviewOps 종료 오류',error.message);}
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{const host=getRequestWindow();if(host){if(host.isMinimized())host.restore();host.show();host.focus();}});
  app.whenReady().then(async()=> {
    app.setName('ReviewOps');
    await fsp.mkdir(attachmentPath,{recursive:true,mode:0o700});
    store=createStore({dbPath:path.join(dataPath,'reviewops.sqlite')});
    await cleanDeletedAttachments();
    store.interruptAgentRuns({preserveRemote:true});
    vault=createVault(path.join(dataPath,'credentials.json'));
    restoreRemoteAgents();
    const dist=path.resolve(__dirname,'../dist');
    protocol.handle('reviewops',request=> {
      const preview=htmlPreviewResponse(request.url,request.method);if(preview)return preview;
      const url=new URL(request.url);
      let target;
      try { target=path.resolve(dist,'.'+decodeURIComponent(url.pathname)); } catch { return new Response('Bad request',{status:400}); }
      if(url.host!=='app'||!inside(dist,target)) return new Response('Forbidden',{status:403});
      return net.fetch(pathToFileURL(target).href);
    });
    ipcMain.handle('reviewops:invoke',async(event,action,payload)=>{
      const host=senderWindow(event);if(!host)return {ok:false,error:{message:'허용되지 않은 요청입니다.'}};
      return requestWindowContext.run({host},async()=>{try {
        let result;
        if ((typeof action === 'string' && (action.startsWith('browser.')||action.startsWith('modelCache.'))) || windowActions.has(action) || ['clipboard.writeText','update.state','update.check','update.download','update.install','update.apply','update.configure','update.openRelease','update.copyInfo','update.rendererReady','snapshot','integration.pending','integration.displayed','window.context','window.openProject','window.navigation','app.info','terminal.read','terminal.write','terminal.resize','terminal.close','agent.models','agent.read','agent.list','agent.loginState','agent.cancel'].includes(action)) result=dispatch(action,payload);
        else {
          result=actionQueue.then(()=>dispatch(action,payload));
          actionQueue=result.catch(()=>{});
        }
        const data=await result;if(changesData(action))dataChanged();
        if(['project.save','project.delete','service.save','service.delete','group.delete','backup.import','ssh.trust'].includes(action))modelCache?.reconcile();
        return {ok:true,data};
      }
      catch(error) { return {ok:false,error:{message:error.message || '작업을 완료하지 못했습니다.',code:error.code,fingerprint:error.fingerprint,host:error.host}}; }});
    });
    updateNativeMenu();
    updater=createUpdateManager({app,dataPath,shell,buildInfo:getBuildInfo(app.getVersion()),isBusy:()=>restoring||hasActiveWork({operations,terminals,codexManager,agents}),onChange:state=>sendToWindows('reviewops:update-state',state)});
    updater.start();
    codexManager=await require('./codex/index.cjs').createCodexManager({dataPath,getWindow:getRequestWindow,getWindows:liveWindows,withWindow:(event,callback)=>{const host=senderWindow(event);if(!host)throw new Error('허용되지 않은 요청입니다.');return requestWindowContext.run({host},callback);},trusted:event=>{if(!trustedSender(event))throw new Error('허용되지 않은 요청입니다.');if(updater?.installing)throw new Error('ReviewOps is restarting to install an update.');},shell,dialog,clipboard,configPath:process.env.REVIEWOPS_SSH_CONFIG||process.env.REVIEWOPS_CODEX_SSH_CONFIG,onHostState:reconcileHostModels,onRuntimeChange:()=>modelCache?.reconcile()});
    codexManager.registerHandlers(ipcMain);
    startModelCache();
    createWindow();
    const integrationDispatch=(action,payload)=>{
      const execute=async()=>{const result=await dispatch(action,payload);if(changesData(action))dataChanged();return result;};
      if(['snapshot','agent.read','agent.cancel'].includes(action))return execute();
      const result=actionQueue.then(execute);actionQueue=result.catch(()=>{});return result;
    };
    qaAutomation=require('./qa-automation.cjs').createQaAutomation({
      getProject:id=>store.snapshot().projects.find(project=>project.id===id),
      getWindow:id=>[...windowContexts.values()].find(record=>record.id===id),
      openWindow:async({projectId,reviewId})=>{
        if(reviewId&&store.get('reviews',reviewId).projectId!==projectId)throw new Error('리뷰의 프로젝트가 일치하지 않습니다.');
        const record=projectWindow(projectId,{background:true});
        record.qaActive=true;
        try {
        if(reviewId)await presentReview(record,{reviewId,projectId,fullscreen:false,focus:false});
        else {await require('./qa-automation.cjs').waitForLoad(record.host.webContents);record.host.showInactive();}
        return record;
        }catch(error){record.qaActive=false;throw error;}
      },
      nativeImage:require('electron').nativeImage
    });
    const automation=require(app.isPackaged?path.join(process.resourcesPath,'mcp','automation-api.cjs'):'./automation-api.cjs').createAutomationApi({dispatch:integrationDispatch,qa:(action,payload)=>qaAutomation.handle(action,payload)});
    try{toolIntegration=await require('./tool-integration.cjs').createToolIntegration({dataPath,dispatch:integrationDispatch,showReview:showProjectReview,automationHandler:automation.handle});}
    catch(error){console.warn('외부 도구 연결을 시작하지 못했습니다:',error.message);}
    if(process.platform!=='win32')try{seasonIntegration=await require('./season-integration.cjs').createSeasonIntegration({dataPath,workspaceRoot:path.join(app.getPath('appData'),'Season AI','reviewops-workspace'),showReview:showProjectReview,dispatch:integrationDispatch});}
    catch(error){console.warn('Season AI 연결을 시작하지 못했습니다:',error.message);}
    app.on('activate',()=>{if(!liveWindows().length)createWindow();});
  }).catch(error=> { dialog.showErrorBox('ReviewOps 실행 오류',error.message); app.quit(); });
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
  // Ask every window before closing any, so cancelling quit preserves the others.
  app.on('before-quit',event=>{if(!liveWindows().length)return;event.preventDefault();if(!quitting){quitting=true;beginQuit();}});
  let stoppingAgents=false,agentsStopped=false;
  app.on('before-quit',event=>{
    if(liveWindows().length)return;
    if((!agents&&!codexManager)||agentsStopped)return;
    event.preventDefault();
    if(stoppingAgents)return;
    stoppingAgents=true;
    modelCache?.close();
    terminals.closeAll();
    Promise.all([agents?.closeAll({preserveRemote:true}),codexManager?.close(),ssh.close?.()]).then(()=>{stoppingAgents=false;agentsStopped=true;app.quit();}).catch(error=>{stoppingAgents=false;startModelCache();dialog.showErrorBox('에이전트 종료 오류',error.message);});
  });
  app.on('will-quit',()=>{qaAutomation?.close();modelCache?.close();updater?.close();updater?.launchInstall();seasonIntegration?.close().catch(()=>{});toolIntegration?.close().catch(()=>{});codexManager?.close().catch(()=>{});closeAllBrowsers();terminals.closeAll();stagedAttachments.clear();ssh.close?.();store?.close();});
}
