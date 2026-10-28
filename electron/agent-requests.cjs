'use strict';

const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REQUEST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_requests (
    id TEXT PRIMARY KEY, reviewId TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    serviceId TEXT REFERENCES services(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL, predecessorId TEXT NOT NULL DEFAULT '', targetKey TEXT NOT NULL,
    requiredResult TEXT NOT NULL DEFAULT '', resultConfirmed INTEGER NOT NULL DEFAULT 0 CHECK(resultConfirmed IN (0,1)),
    runId TEXT NOT NULL DEFAULT '', cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
    resolution TEXT NOT NULL DEFAULT 'pending' CHECK(resolution IN ('pending','applied','deferred')),
    resultVersion TEXT NOT NULL DEFAULT '', resultNote TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_requests_review ON agent_requests(reviewId,createdAt);
`;
const FIELDS = ['id','reviewId','serviceId','prompt','predecessorId','targetKey','requiredResult','resultConfirmed','runId','cancelled','resolution','resultVersion','resultNote','createdAt','updatedAt'];
const active = run => ['running','queued'].includes(run?.status);
const readRow = row => row ? {...row,resultConfirmed:Boolean(row.resultConfirmed),cancelled:Boolean(row.cancelled)} : null;
const fail = message => {throw new Error(message);};
function text(value, label, max=10000, required=false) {
  if(typeof value!=='string'||value.includes('\0')||value.length>max||required&&!value.trim())fail(`${label}: 내용을 다시 입력하십시오.`);
  return value.trim();
}
function identifier(value, required=false) {
  if(typeof value!=='string'||(value&&!/^[a-zA-Z0-9_-]{1,128}$/.test(value))||required&&!value)fail('후속 요청의 연결 정보가 올바르지 않습니다.');
  return value;
}
function requestTargetKey(service,settings) {
  let folder=service.kind==='ssh'?path.posix.normalize(settings.workPath):path.resolve(settings.workPath);
  if(service.kind==='local'){try{folder=fs.realpathSync(folder);}catch{}if(process.platform==='win32')folder=folder.toLowerCase();}
  return JSON.stringify({kind:service.kind,host:service.kind==='ssh'?service.host||'':'',hostAlias:service.kind==='ssh'?service.hostAlias||'':'',sshConfigPath:service.kind==='ssh'?service.sshConfigPath||'':'',port:service.kind==='ssh'?service.port:0,username:service.kind==='ssh'?service.username:'',folder});
}
function conflictingTargets(first,second) {
  if(first===second)return true;
  try {
    const a=JSON.parse(first),b=JSON.parse(second);
    if(!a.folder||!b.folder||['kind','host','port','username'].some(key=>a[key]!==b[key]))return false;
    if(a.kind==='ssh'&&!a.host&&['hostAlias','sshConfigPath'].some(key=>a[key]!==b[key]))return false;
    const paths=a.kind==='ssh'?path.posix:path,inside=(root,child)=>{const relative=paths.relative(root,child);return relative===''||!paths.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+paths.sep);};
    return inside(a.folder,b.folder)||inside(b.folder,a.folder);
  }catch{return false;}
}
function listSavedRequests(db, reviewId) {
  return db.prepare(`SELECT * FROM agent_requests ${reviewId?'WHERE reviewId=?':''} ORDER BY createdAt,rowid`).all(...(reviewId?[reviewId]:[])).map(readRow);
}
function writeRow(db, row) {
  db.prepare(`INSERT INTO agent_requests(${FIELDS.join(',')}) VALUES(${FIELDS.map(key=>':'+key).join(',')}) ON CONFLICT(id) DO UPDATE SET ${FIELDS.filter(key=>!['id','createdAt'].includes(key)).map(key=>`${key}=excluded.${key}`).join(',')}`).run({...row,resultConfirmed:Number(row.resultConfirmed),cancelled:Number(row.cancelled)});
  return readRow(row);
}
function importRequests(store, rows=[]) {
  if(!Array.isArray(rows)||rows.length>100000)fail('백업 파일의 후속 요청 수가 올바르지 않습니다.');
  const ids=new Set();
  for(const source of rows) {
    if(!source||typeof source!=='object'||Object.keys(source).some(key=>!FIELDS.includes(key)))fail('백업 파일의 후속 요청 형식이 올바르지 않습니다.');
    const row={...source};
    for(const key of ['id','reviewId','predecessorId','runId'])identifier(row[key],['id','reviewId'].includes(key));
    if(ids.has(row.id))fail('백업 파일에 같은 후속 요청이 중복되어 있습니다.');ids.add(row.id);
    const review=store.get('reviews',row.reviewId);
    if(row.serviceId!==null)store.get('services',identifier(row.serviceId,true));
    for(const [key,max,required] of [['prompt',100000,true],['targetKey',8192,true],['requiredResult',10000,false],['resultVersion',1000,false],['resultNote',10000,false]])row[key]=text(row[key],({prompt:'후속 요청',targetKey:'실행 대상',requiredResult:'필요한 결과',resultVersion:'결과 버전',resultNote:'처리 내용'})[key],max,required);
    for(const key of ['resultConfirmed','cancelled'])if(typeof row[key]!=='boolean')fail('백업 파일의 후속 요청 상태가 올바르지 않습니다.');
    if(!['pending','applied','deferred'].includes(row.resolution)||row.resolution==='applied'&&!row.resultVersion||row.resolution==='deferred'&&!row.resultNote)fail('백업 파일의 요청 처리 결과가 올바르지 않습니다.');
    for(const key of ['createdAt','updatedAt'])if(typeof row[key]!=='string'||!Number.isFinite(Date.parse(row[key])))fail('후속 요청의 저장 시각이 올바르지 않습니다.');
    if(row.runId&&store.get('agent_runs',row.runId).reviewId!==review.id)fail('후속 요청과 실행의 리뷰가 다릅니다.');
    const predecessor=store.listAgentRuns().find(run=>run.id===row.predecessorId);
    if(predecessor&&store.get('reviews',predecessor.reviewId).projectId!==review.projectId)fail('다른 프로젝트의 실행을 기다리는 후속 요청은 가져올 수 없습니다.');
    if(row.serviceId!==null&&store.get('services',row.serviceId).groupId!==store.get('projects',review.projectId).groupId)fail('다른 그룹의 실행 대상이 후속 요청에 연결되어 있습니다.');
    // A removed predecessor remains identifiable and keeps the request waiting.
    writeRow(store.db,row);
  }
}

function requestState(row,{runs,requests,review,target,runTarget}) {
  const run=runs.find(item=>item.id===(row.runId||row.id));
  if(row.cancelled)return {...row,state:'cancelled',reason:'후속 요청을 취소했습니다.',delivery:'not_sent'};
  if(run) {
    const reason=active(run)?'후속 실행에 요청을 제출했습니다. 요청을 읽었는지와 반영했는지는 별도로 확인해야 합니다.':run.status==='completed'?'후속 실행이 끝났습니다. 결과를 읽고 요청의 반영 여부를 기록하십시오.':'후속 실행이 완료되지 않았습니다. 실행 기록을 확인하고 새 요청으로 다시 등록하십시오.';
    return {...row,runId:run.id,state:active(run)?'running':'finished',runStatus:run.status,reason,delivery:'submitted',response:run.response||'',runError:run.error||''};
  }
  const waiting=reason=>({...row,state:'waiting',reason,delivery:'not_sent'});
  if(!target||target.serviceId!==row.serviceId||target.key!==row.targetKey)return waiting('접속 대상이나 작업 폴더가 변경되었습니다. 새 후속 요청으로 등록하십시오.');
  if(row.predecessorId) {
    const previous=runs.find(item=>item.id===row.predecessorId);
    if(!previous)return waiting('먼저 끝나야 하는 실행 기록을 찾을 수 없습니다. 새 후속 요청에서 기다릴 실행을 다시 선택하십시오.');
    if(active(previous))return waiting('선택한 실행이 끝나기를 기다리고 있습니다.');
    if(previous.status!=='completed')return waiting(previous.status==='failed'?'먼저 실행한 작업이 실패했습니다. 결과를 확인한 뒤 새 후속 요청을 등록하십시오.':'먼저 실행한 작업이 중단되었습니다. 결과를 확인한 뒤 새 후속 요청을 등록하십시오.');
  }
  if(row.requiredResult&&!row.resultConfirmed)return waiting('실행에 필요한 결과가 준비되었는지 확인하십시오.');
  const blocker=runs.find(item=>active(item)&&(item.serviceId===row.serviceId||conflictingTargets(runTarget(item),row.targetKey)));
  if(blocker)return {...waiting('같은 작업 폴더의 실행이 끝나기를 기다리고 있습니다.'),blockingRunId:blocker.id};
  const earlier=requests.slice(0,requests.findIndex(item=>item.id===row.id)).find(item=>!item.cancelled&&!item.runId&&!runs.some(run=>run.id===item.id)&&conflictingTargets(item.targetKey,row.targetKey));
  if(earlier)return {...waiting('먼저 등록한 후속 요청을 실행하거나 취소하십시오.'),blockingRequestId:earlier.id};
  return {...row,state:'ready',reason:'실행할 수 있습니다. 실행 버튼을 누르면 시작합니다.',delivery:'not_sent'};
}

function createRequestQueue({store,targetForReview,targetForRun,start}) {
  const starting=new Map();
  const get=id=>{identifier(id,true);const row=readRow(store.db.prepare('SELECT * FROM agent_requests WHERE id=?').get(id));if(!row)fail('후속 요청을 찾을 수 없습니다.');return row;};
  const targetSafe=review=>{try{return targetForReview(review);}catch{return null;}};
  function state(row) {
    return requestState(row,{runs:store.listAgentRuns(),requests:listSavedRequests(store.db),review:store.get('reviews',row.reviewId),target:targetSafe(store.get('reviews',row.reviewId)),runTarget:run=>{try{return targetForRun(run);}catch{return '';}}});
  }
  function update(row,patch) {return writeRow(store.db,{...row,...patch,updatedAt:new Date().toISOString()});}
  return {
    list(reviewId) {
      const review=store.get('reviews',reviewId),reviews=store.snapshot().reviews.filter(item=>item.projectId===review.projectId),allowed=new Set(reviews.map(item=>item.id));
      return {requests:listSavedRequests(store.db,reviewId).map(state),predecessors:store.listAgentRuns().filter(run=>allowed.has(run.reviewId)).map(run=>({id:run.id,reviewId:run.reviewId,title:reviews.find(item=>item.id===run.reviewId)?.title||'',prompt:run.prompt.slice(0,160),status:run.status,createdAt:run.createdAt})),supportsLiveDelivery:false,automaticStart:false};
    },
    add(input) {
      const review=store.get('reviews',input.reviewId),target=targetForReview(review),id=identifier(input.requestId||randomUUID(),true),prompt=text(input.prompt,'후속 요청',100000,true),predecessorId=identifier(input.predecessorId||''),requiredResult=text(input.requiredResult||'','필요한 결과',10000);
      const existing=readRow(store.db.prepare('SELECT * FROM agent_requests WHERE id=?').get(id));
      if(existing){if(existing.reviewId!==review.id||existing.prompt!==prompt||existing.predecessorId!==predecessorId||existing.requiredResult!==requiredResult)fail('이미 사용한 요청 ID입니다. 새 요청으로 등록하십시오.');return state(existing);}
      if(store.listAgentRuns().some(run=>run.id===id))fail('이미 사용한 요청 ID입니다. 새 요청으로 등록하십시오.');
      if(predecessorId){const run=store.get('agent_runs',predecessorId);if(store.get('reviews',run.reviewId).projectId!==review.projectId)fail('같은 프로젝트의 실행만 기다릴 수 있습니다.');}
      const now=new Date().toISOString();
      const row={id,reviewId:review.id,serviceId:target.serviceId,prompt,predecessorId,targetKey:target.key,requiredResult,resultConfirmed:false,runId:'',cancelled:false,resolution:'pending',resultVersion:'',resultNote:'',createdAt:now,updatedAt:now};
      writeRow(store.db,row);return state(row);
    },
    confirmResult(input) {
      const row=get(input.id);
      if(row.runId||row.cancelled)fail('이미 처리한 후속 요청은 바꿀 수 없습니다.');
      if(!row.requiredResult)fail('확인할 결과가 지정되지 않았습니다.');
      if(row.predecessorId&&store.listAgentRuns().find(run=>run.id===row.predecessorId)?.status!=='completed')fail('먼저 실행한 작업이 완료된 뒤 결과를 확인하십시오.');
      return state(update(row,{resultConfirmed:true}));
    },
    cancel(input) {
      const row=get(input.id);if(row.runId||store.listAgentRuns().some(run=>run.id===row.id))fail('시작된 요청은 에이전트 실행에서 중지하십시오.');return state(update(row,{cancelled:true}));
    },
    async start(input) {
      const row=get(input.id),existing=store.listAgentRuns().find(run=>run.id===(row.runId||row.id));
      if(existing)return existing;
      const current=state(row);if(current.state!=='ready')fail(current.reason);
      if(starting.has(row.id))return starting.get(row.id);
      const pending=Promise.resolve().then(()=>start({reviewId:row.reviewId,requestId:row.id,prompt:row.prompt,context:{instruction:true,attachmentIds:[],logIds:[]},independentExecution:false})).then(job=>{update(row,{runId:job.id});return job;}).finally(()=>starting.delete(row.id));
      starting.set(row.id,pending);return pending;
    },
    resolve(input) {
      const row=get(input.id),run=store.listAgentRuns().find(run=>run.id===(row.runId||row.id));
      if(!run||active(run))fail('후속 실행이 끝난 뒤 처리 결과를 기록하십시오.');
      if(!['applied','deferred'].includes(input.resolution))fail('요청의 처리 결과를 선택하십시오.');
      const resultVersion=text(input.resultVersion||'','결과 버전',1000,input.resolution==='applied'),resultNote=text(input.resultNote||'','처리 내용',10000,input.resolution==='deferred');
      return state(update(row,{runId:run.id,resolution:input.resolution,resultVersion,resultNote}));
    }
  };
}

module.exports={REQUEST_SCHEMA,listSavedRequests,importRequests,createRequestQueue,requestState,requestTargetKey,conflictingTargets};
