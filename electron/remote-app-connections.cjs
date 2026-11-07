'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID,randomBytes,createHash} = require('node:crypto');
const {isIP} = require('node:net');
const {createRemoteAppClient} = require('./remote-app-client.cjs');
const {captureRemoteAppIntent} = require('./remote-app-commands.cjs');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code) { throw Object.assign(new Error('The remote connection could not be completed.'), {code}); }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) fail('INVALID_REMOTE_REQUEST');
  const result={};
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('INVALID_REMOTE_REQUEST');result[key]=descriptor.value;}
  return result;
}
// Saved profiles contain public pairing data and an OS-protected credential
// envelope. Raw tokens and local command prompts never enter profile files/IPC.
function createRemoteAppConnections({dataPath,identityProvider}) {
  if(typeof dataPath!=='string'||!path.isAbsolute(dataPath))fail('INVALID_REMOTE_REQUEST');
  const directory=path.join(dataPath,'remote-app-connections'),file=path.join(directory,'hosts.json');
  function owned(stat,isDirectory=false){
    if(stat.isSymbolicLink()||(isDirectory?!stat.isDirectory():!stat.isFile())||
      typeof process.getuid==='function'&&stat.uid!==process.getuid()||process.platform!=='win32'&&(stat.mode&0o077))fail('REMOTE_CONNECTIONS_UNAVAILABLE');
  }
  fs.mkdirSync(directory,{recursive:true,mode:0o700});owned(fs.lstatSync(directory),true);
  const entries=new Map(),unresolved=new Map(),pendingUploads=new Map(),work=new Set(),connecting=new Set();let closed=false,closing;
  function save(){
    const temporary=file+'.'+randomUUID()+'.tmp';
    let descriptor;
    try{
      owned(fs.lstatSync(directory),true);try{owned(fs.lstatSync(file));}catch(error){if(error.code!=='ENOENT')throw error;}
      const bytes=Buffer.from(JSON.stringify({version:1,hosts:[...entries.values()].map(row=>({...row.profile,ciphertext:row.ciphertext||''})),unresolved:[...unresolved.values()],pendingUploads:[...pendingUploads.values()]}));
      if(bytes.length>512*1024)fail('COMMAND_LIMIT');
      descriptor=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(descriptor,bytes);fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;
      fs.renameSync(temporary,file);
      if(process.platform!=='win32'){const parent=fs.openSync(directory,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
    }
    catch(error){if(error.code==='COMMAND_LIMIT')throw error;fail('REMOTE_CONNECTIONS_UNAVAILABLE');}
    finally{if(descriptor!==undefined)fs.closeSync(descriptor);try{fs.unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  function profile(input){
    const value=fields(input,['id','label','address','port','certificatePEM','certificateFingerprint']);
    if(typeof value.id!=='string'||!UUID.test(value.id)||typeof value.label!=='string'||!value.label.trim()||value.label.length>120||/[\x00-\x1f\x7f]/.test(value.label))fail('INVALID_REMOTE_REQUEST');
    if(typeof value.address!=='string'||!Number.isInteger(value.port)||value.port<1||value.port>65535||typeof value.certificatePEM!=='string'||value.certificatePEM.length>32768||typeof value.certificateFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.certificateFingerprint))fail('INVALID_REMOTE_REQUEST');
    return Object.freeze(value);
  }
  function publicRemote(input){
    try{
      const value=fields(input,['id','label','address','state','expiresAt','grants']);
      if(typeof value.id!=='string'||!UUID.test(value.id)||typeof value.label!=='string'||!value.label.trim()||value.label.length>120||
        typeof value.address!=='string'||!isIP(value.address)||!['pending','approved'].includes(value.state)||
        !Number.isSafeInteger(value.expiresAt)||value.expiresAt<0||!Array.isArray(value.grants)||value.grants.length>1000)fail('INVALID_RESPONSE');
      value.grants=Object.freeze(value.grants.map(input=>{
        const grant=fields(input,['projectId','read','write','execute']);
        if(typeof grant.projectId!=='string'||!ID.test(grant.projectId)||grant.read!==true||typeof grant.write!=='boolean'||typeof grant.execute!=='boolean')fail('INVALID_RESPONSE');
        return Object.freeze(grant);
      }));return Object.freeze(value);
    }catch{fail('INVALID_RESPONSE');}
  }
  let descriptor;
  try{
    descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    const stat=fs.fstatSync(descriptor);owned(stat);if(stat.size>512*1024)fail('REMOTE_CONNECTIONS_UNAVAILABLE');
    const bytes=fs.readFileSync(descriptor);if(bytes.length>512*1024)fail('REMOTE_CONNECTIONS_UNAVAILABLE');
    const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    const saved=fields(parsed,['version','hosts','unresolved',...(Object.hasOwn(parsed,'pendingUploads')?['pendingUploads']:[])]);
    if(saved.version!==1||!Array.isArray(saved.hosts)||saved.hosts.length>16||!Array.isArray(saved.unresolved)||saved.unresolved.length>256)fail('REMOTE_CONNECTIONS_UNAVAILABLE');
    for(const value of saved.hosts){const {ciphertext,...publicFields}=value,p=profile(publicFields);if(entries.has(p.id)||typeof ciphertext!=='string'||ciphertext.length>512)fail('REMOTE_CONNECTIONS_UNAVAILABLE');entries.set(p.id,{profile:p,ciphertext,client:null,remote:null,busy:false,errorCode:null});}
    for(const input of saved.unresolved){
      const value=fields(input,['id','requestId','epoch','projectId','operation',...(Object.hasOwn(input,'intentSHA256')?['intentSHA256']:[])]);
      if(!entries.has(value.id)||typeof value.requestId!=='string'||!ID.test(value.requestId)||typeof value.epoch!=='string'||!UUID.test(value.epoch)||
        typeof value.projectId!=='string'||!ID.test(value.projectId)||typeof value.operation!=='string'||
        value.intentSHA256!==undefined&&!/^[a-f0-9]{64}$/.test(value.intentSHA256)||unresolved.has(value.id+':'+value.requestId))fail('REMOTE_CONNECTIONS_UNAVAILABLE');
      unresolved.set(value.id+':'+value.requestId,Object.freeze(value));
    }
    if(saved.pendingUploads!==undefined){
      if(!Array.isArray(saved.pendingUploads)||saved.pendingUploads.length>64)fail('REMOTE_CONNECTIONS_UNAVAILABLE');
      for(const input of saved.pendingUploads){const value=fields(input,['id','requestId','epoch','projectId','reviewId','uploadId','name','phase',...(Object.hasOwn(input,'intentSHA256')?['intentSHA256']:[]),...(Object.hasOwn(input,'file')?['file']:[])]);
        if(!entries.has(value.id)||![value.requestId,value.projectId,value.reviewId].every(id=>typeof id==='string'&&ID.test(id))||!UUID.test(value.epoch)||
          !(value.uploadId===null||typeof value.uploadId==='string'&&ID.test(value.uploadId))||typeof value.name!=='string'||value.name.length>255||!['staging','committing'].includes(value.phase)||value.intentSHA256!==undefined&&!/^[a-f0-9]{64}$/.test(value.intentSHA256))fail('REMOTE_CONNECTIONS_UNAVAILABLE');
        pendingUploads.set(value.id+':'+value.requestId,value);
      }
    }
  }catch(error){if(error.code!=='ENOENT')fail('REMOTE_CONNECTIONS_UNAVAILABLE');}
  finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
  function check(guard){if(closed)fail('CONNECTION_CLOSED');if(typeof guard!=='function')fail('ACCESS_DENIED');guard();}
  function scope(row){return `remote-app-client:${row.profile.id}:${row.profile.certificateFingerprint}`;}
  function client(row,guard,sessionToken=''){
    return createRemoteAppClient({...row.profile,sessionToken,onSessionToken:async secret=>{
      const currentGuard=row.guard||guard;check(currentGuard);
      if(!secret)row.ciphertext='';
      else{if(!identityProvider)fail('IDENTITY_UNAVAILABLE');row.ciphertext=await identityProvider.sealCredential({scope:scope(row),secret,assertCurrent:()=>check(currentGuard)});}
      check(currentGuard);save();
    }});
  }
  async function restore(row,guard){
    if(row.client||!row.ciphertext)return;
    if(!identityProvider)fail('IDENTITY_UNAVAILABLE');
    const secret=await identityProvider.openCredential({scope:scope(row),ciphertext:row.ciphertext,assertCurrent:()=>check(guard)});
    check(guard);row.client=client(row,guard,secret);
  }
  function snapshot(){return {connections:[...entries.values()].map(row=>({id:row.profile.id,label:row.profile.label,address:row.profile.address,port:row.profile.port,
    certificateFingerprint:row.profile.certificateFingerprint,state:row.remote?.state||(row.ciphertext?'saved':'disconnected'),remote:row.remote,errorCode:row.errorCode,busy:row.busy})),pendingCommands:[...unresolved.values()].map(row=>({...row})),pendingUploads:[...pendingUploads.values()].map(row=>({...row}))};}
  async function use(input,keys,guard,action){
    check(guard);const value=fields(input,['id',...keys]),row=entries.get(value.id);
    if(!row)fail('NOT_FOUND');if(row.busy)fail('REMOTE_MANAGEMENT_BUSY');row.busy=true;row.guard=guard;
    try{await restore(row,guard);if(!row.client)fail('AUTH_REQUIRED');check(guard);const result=await action(row,value);check(guard);row.errorCode=null;return result;}
    catch(error){row.errorCode=/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'CONNECTION_UNAVAILABLE';throw error;}
    finally{row.busy=false;}
  }
  const api={
    state(input,guard){fields(input,[]);check(guard);return snapshot();},
    async connect(input,guard){
      check(guard);const value=fields(input,['id','label','address','port','certificatePEM','certificateFingerprint','invitation']);
      const id=value.id||randomUUID();let row=entries.get(id);
      if(row?.busy||connecting.has(id))fail('REMOTE_MANAGEMENT_BUSY');if(!row&&entries.size+connecting.size>=16)fail('COMMAND_LIMIT');
      const selected=profile({id,label:value.label,address:value.address,port:value.port,certificatePEM:value.certificatePEM,certificateFingerprint:value.certificateFingerprint});
      if(row?.client)fail('ALREADY_CONNECTED');
      if(row&&[...unresolved.values(),...pendingUploads.values()].some(value=>value.id===id)&&
        ['address','port','certificateFingerprint','certificatePEM'].some(key=>row.profile[key]!==selected[key]))fail('UNRESOLVED_COMMAND');
      const original=row;connecting.add(id);if(original)original.busy=true;
      try{
      if(!identityProvider||typeof identityProvider.sealCredential!=='function'||typeof identityProvider.openCredential!=='function')fail('IDENTITY_UNAVAILABLE');
      const probe=randomBytes(32).toString('base64url'),credentialScope=`remote-app-client:${id}:${selected.certificateFingerprint}`;
      const sealed=await identityProvider.sealCredential({scope:credentialScope,secret:probe,assertCurrent:()=>check(guard)});check(guard);
      const opened=await identityProvider.openCredential({scope:credentialScope,ciphertext:sealed,assertCurrent:()=>check(guard)});check(guard);
      if(opened!==probe)fail('IDENTITY_UNAVAILABLE');
      row={profile:selected,client:null,remote:null,busy:true,errorCode:null,ciphertext:'',guard};row.client=client(row,guard);entries.set(id,row);save();
      try{row.remote=publicRemote(await row.client.connect({invitation:value.invitation,label:selected.label}));check(guard);return {id,remote:row.remote};}
      catch(error){row.errorCode=error.code||'CONNECTION_UNAVAILABLE';await row.client.disconnect().catch(()=>{});row.client=null;throw error;}
      finally{row.busy=false;}
      }finally{connecting.delete(id);if(original)original.busy=false;}
    },
    refresh(input,guard){return use(input,[],guard,async row=>{row.remote=publicRemote(await row.client.state());return {id:row.profile.id,remote:row.remote};});},
    read(input,guard){return use(input,['operation','payload'],guard,(row,value)=>row.client.read(value.operation,value.payload));},
    writeState(input,guard){return use(input,['projectId','reviewId'],guard,(row,value)=>row.client.writeState({projectId:value.projectId,reviewId:value.reviewId}));},
    command(input,guard){return use(input,['envelope'],guard,async(row,value)=>{
      const intent=captureRemoteAppIntent(value.envelope),intentSHA256=createHash('sha256').update(JSON.stringify(intent)).digest('hex');
      const key=row.profile.id+':'+intent.requestId;if(!unresolved.has(key)&&unresolved.size>=256)fail('COMMAND_LIMIT');
      const previous=unresolved.get(key);
      if(previous&&(['epoch','projectId','operation'].some(field=>previous[field]!==intent[field])||previous.intentSHA256&&previous.intentSHA256!==intentSHA256))fail('IDEMPOTENCY_CONFLICT');
      unresolved.set(key,Object.freeze({id:row.profile.id,requestId:intent.requestId,epoch:intent.epoch,projectId:intent.projectId,operation:intent.operation,intentSHA256}));save();
      try{
        const result=await row.client.command(intent);check(guard);if(result.state!=='pending'){unresolved.delete(key);save();}return result;
      }catch(error){
        if(['INVALID_COMMAND','REVISION_CONFLICT'].includes(error.code)){check(guard);unresolved.delete(key);save();}
        throw error;
      }
    });},
    result(input,guard){return use(input,['requestId','epoch','projectId'],guard,async(row,value)=>{
      const result=await row.client.result({requestId:value.requestId,epoch:value.epoch,projectId:value.projectId});check(guard);
      if(result.state!=='pending'){unresolved.delete(row.profile.id+':'+value.requestId);save();}return result;
    });},
    attachment(input,guard){return use(input,['operation','payload'],guard,async(row,value)=>{
      const allowed=['describe','readChunk','beginUpload','writeChunk','commitUpload','result','discardUpload'];
      if(!allowed.includes(value.operation))fail('INVALID_REMOTE_REQUEST');
      const payload=JSON.parse(JSON.stringify(value.payload));let key,record;
      if(value.operation==='beginUpload'){
        if(!payload||![payload.requestId,payload.projectId,payload.reviewId].every(id=>typeof id==='string'&&ID.test(id))||!UUID.test(payload.epoch)||typeof payload.name!=='string'||payload.name.length>255)fail('INVALID_REMOTE_REQUEST');
        key=row.profile.id+':'+payload.requestId;record=pendingUploads.get(key);
        if(record&&record.phase==='committing')fail('UNRESOLVED_COMMAND');
        const intentSHA256=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        if(record&&(['epoch','projectId','reviewId','name'].some(field=>payload[field]!==record[field])||record.intentSHA256&&record.intentSHA256!==intentSHA256))fail('IDEMPOTENCY_CONFLICT');
        if(!record&&pendingUploads.size>=64)fail('COMMAND_LIMIT');
        record={id:row.profile.id,requestId:payload.requestId,epoch:payload.epoch,projectId:payload.projectId,reviewId:payload.reviewId,uploadId:record?.uploadId||null,name:payload.name,phase:'staging',intentSHA256,
          file:{name:payload.name,mimeType:payload.mimeType,size:payload.size,sha256:payload.sha256,activityId:payload.activityId}};
        pendingUploads.set(key,record);save();
      }else if(['commitUpload','discardUpload'].includes(value.operation)){
        [key,record]=[...pendingUploads.entries()].find(([,item])=>item.id===row.profile.id&&item.uploadId===payload?.uploadId)||[];
        if(!record)fail('NOT_FOUND');
        if(value.operation==='commitUpload'){record.phase='committing';save();}
        else if(record.phase==='committing')fail('UNRESOLVED_COMMAND');
      }else if(value.operation==='result'){
        key=row.profile.id+':'+payload?.requestId;record=pendingUploads.get(key);
        if(record&&['epoch','projectId','reviewId'].some(field=>payload[field]!==record[field]))fail('IDEMPOTENCY_CONFLICT');
      }
      let result;
      try{result=await row.client.attachment(value.operation,payload);check(guard);}
      catch(error){
        if(record&&['INVALID_ATTACHMENT_REQUEST','HASH_MISMATCH','UPLOAD_INCOMPLETE','REVISION_CONFLICT','CHUNK_CONFLICT','UPLOAD_EXPIRED'].includes(error.code)){check(guard);pendingUploads.delete(key);save();}
        throw error;
      }
      if(record){
        if(result.state==='committed'&&(['requestId','projectId','reviewId'].some(field=>result[field]!==record[field])||
          record.uploadId!==null&&result.uploadId!==record.uploadId||record.file&&Object.keys(record.file).some(field=>result.attachment[field]!==record.file[field])))fail('INVALID_RESPONSE');
        if(result.state==='committed'||value.operation==='discardUpload')pendingUploads.delete(key);
        else if(value.operation==='beginUpload')record.uploadId=result.uploadId;
        save();
      }
      return result;
    });},
    cancelPendingUpload(input,guard){return use(input,['requestId'],guard,async(row,value)=>{
      const key=row.profile.id+':'+value.requestId,record=pendingUploads.get(key);if(!record)fail('NOT_FOUND');if(record.phase!=='staging')fail('UNRESOLVED_COMMAND');
      if(record.uploadId)await row.client.attachment('discardUpload',{uploadId:record.uploadId}).catch(error=>{if(!['NOT_FOUND','ACCESS_DENIED','UPLOAD_EXPIRED'].includes(error.code))throw error;});
      check(guard);pendingUploads.delete(key);save();return {discarded:true};
    });},
    async disconnect(input,guard){return use(input,[],guard,async row=>{if([...unresolved.values(),...pendingUploads.values()].some(value=>value.id===row.profile.id))fail('UNRESOLVED_COMMAND');try{await row.client.disconnect();}finally{row.client=null;row.remote=null;}return {disconnected:true};});},
    async forget(input,guard){
      check(guard);const {id}=fields(input,['id']),row=entries.get(id);if(!row)fail('NOT_FOUND');if(row.busy)fail('REMOTE_MANAGEMENT_BUSY');
      if([...unresolved.values(),...pendingUploads.values()].some(value=>value.id===id))fail('UNRESOLVED_COMMAND');row.busy=true;row.guard=guard;
      try{await row.client?.disconnect();check(guard);entries.delete(id);save();return snapshot();}finally{row.busy=false;}
    },
    closeAndDrain(){if(closing)return closing;closed=true;closing=(async()=>{
      await Promise.all([...entries.values()].map(row=>row.client?.close()));await Promise.allSettled([...work]);
    })();return closing;}
  };
  return Object.freeze(Object.fromEntries(Object.entries(api).map(([name,method])=>[name,(...args)=>{
    const result=method(...args);if(name!=='closeAndDrain'&&result&&typeof result.then==='function'){
      work.add(result);result.then(()=>work.delete(result),()=>work.delete(result));
    }return result;
  }])));
}
module.exports={createRemoteAppConnections};
