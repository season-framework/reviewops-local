// Import-safe manual diagnostics. No app, SSH, VM, or dependency loads at import.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const SOURCE='2a1e9f166e61eb3a30148ea624b4bb921c8ebd6a';
export const BUILD={channel:'test',version:'1.4.1',buildNumber:41001,commit:SOURCE,builtAt:'2026-11-04T05:32:59.166Z',developmentNumber:3};
const SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const folderMessage='SSH 계정으로 에이전트 작업 폴더를 열 수 없습니다.';
const inside=(root,file)=>file.startsWith(root+'/')&&file!==root;
const absolute=value=>typeof value==='string'&&path.posix.isAbsolute(value)&&path.posix.normalize(value)===value&&!/[\0\r\n]/.test(value);
function pinShape(row){assert.ok(row&&absolute(row.path)&&Number.isSafeInteger(row.bytes)&&row.bytes>0&&SHA.test(row.sha256),'Actual regular-file pin required');}

export function assertBinding(b,host){
 assert.equal(b.schema,1);assert.equal(b.phase,'ui');assert.equal(b.scenario,'installed-linux-permission');
 assert.equal(host.platform,'darwin');assert.equal(host.arch,'arm64');assert.equal(host.electron,undefined);assert.match(host.node,/^24\./);
 assert.ok(host.uid>0&&host.euid>0);assert.equal(host.ci,'true');assert.equal(host.actions,'true');assert.equal(host.event,'workflow_dispatch');
 assert.equal(host.attempt,1);assert.ok(Number.isSafeInteger(host.runId)&&host.runId>0);
 assert.equal(b.source,SOURCE);assert.deepEqual(b.build,BUILD);assert.match(b.harnessSource,COMMIT);assert.equal(host.githubSHA,b.harnessSource);
 assert.equal(b.sourceGuard.productSource,SOURCE);assert.equal(b.sourceGuard.harnessSource,b.harnessSource);assert.equal(b.sourceGuard.baselineFiles,429);assert.equal(b.sourceGuard.existingFilesUnchanged,true);
 for(const name of ['preparedSupplyPin','preparedRootAcceptancePin','guestRootAcceptancePin','sourceGuardRootPin','packageZipPin','expectedASARPin','executablePin','actualNodeIdentity','driverPin'])pinShape(b[name]);
 for(const name of ['root','privateRoot','home','codeHome','dataDir','sshConfig','packageApp','output','claimPath'])assert.ok(absolute(b[name]),name);
 assert.equal(b.home,path.posix.join(b.privateRoot,'home'));assert.equal(b.codeHome,path.posix.join(b.home,'.codex'));assert.equal(b.dataDir,path.posix.join(b.privateRoot,'data'));assert.equal(b.sshConfig,path.posix.join(b.home,'.ssh','config'));
 assert.ok(Buffer.byteLength(path.posix.join(b.dataDir,'integrations/tools.sock'))<=103,'Use a short private profile before app launch');
 assert.ok(inside(b.privateRoot,b.packageApp)&&b.packageApp.endsWith('/ReviewOps.app'));
 assert.equal(b.expectedASARPin.path,path.posix.join(b.packageApp,'Contents/Resources/app.asar'));assert.equal(b.executablePin.path,path.posix.join(b.packageApp,'Contents/MacOS/ReviewOps'));
 assert.equal(b.packageZipPin.bytes,133831763);assert.equal(b.packageZipPin.sha256,'2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead');
 assert.ok(inside(path.posix.join(b.root,'test-results/installed-linux-permission-ui'),b.output));assert.equal(b.claimPath,path.posix.join(b.privateRoot,'installed-linux-permission-ui-once.json'));
 const g=b.guest;assert.equal(g.host,'127.0.0.1');assert.ok(Number.isSafeInteger(g.port)&&g.port>1024&&g.port<65536);assert.match(g.username,/^[a-z][a-z0-9_-]{0,31}$/);assert.match(g.hostKeyFingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);pinShape(g.privateKeyPin);assert.ok(g.privateKeyPin.bytes<=65536&&inside(b.privateRoot,g.privateKeyPin.path));assert.equal(g.home,'/home/'+g.username);assert.equal(g.codeHome,g.home+'/.codex');
 assert.match(g.identity.bootId,/^[a-f0-9-]{36}$/);assert.ok(Number.isSafeInteger(g.identity.uid)&&g.identity.uid>0);assert.equal(g.identity.euid,g.identity.uid);assert.equal(g.identity.machine,'x86_64');assert.ok(typeof g.identity.kernel==='string'&&g.identity.kernel.length>0);
 for(const p of [g.leaf.path,g.genuineCLI.path,g.witness.path,g.witness.logPath])assert.ok(absolute(p));
 assert.ok(g.leaf.path.startsWith('/home/'+g.username+'/'));assert.ok(!inside(g.leaf.path,g.genuineCLI.path)&&!inside(g.leaf.path,g.witness.path)&&!inside(g.leaf.path,g.witness.logPath));
 assert.match(g.leaf.path,/^[A-Za-z0-9/._-]+$/,'The owned fixture leaf has an unambiguous command witness');
 assert.ok(Number.isSafeInteger(g.leaf.dev)&&g.leaf.dev>=0&&Number.isSafeInteger(g.leaf.ino)&&g.leaf.ino>0);assert.equal(g.leaf.uid,g.identity.uid);
 for(const r of [g.genuineCLI,g.witness])assert.ok(Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=512*1024**2&&SHA.test(r.sha256));
 assert.match(g.genuineCLI.version,/^[A-Za-z0-9][A-Za-z0-9 .+_-]{0,159}$/);
 assert.equal(b.allowNormalMetadata,true);assert.equal(b.maximumAppLaunches,1);assert.equal(b.newFormalQAIDs,0);assert.equal(b.vmLifecycleOwnedByOuterController,true);
 assert.ok(Array.isArray(b.dependencyPins)&&b.dependencyPins.length>=2);for(const row of b.dependencyPins)pinShape(row);
}

export function assertWitness(rows){
 assert.ok(Array.isArray(rows)&&rows.length<=500);
 for(const row of rows){assert.ok(Array.isArray(row.args));assert.ok(JSON.stringify(row.args)==='["--version"]'||JSON.stringify(row.args)==='["login","status"]'||JSON.stringify(row.args)==='["app-server"]','Only genuine CLI metadata is admitted');assert.ok(absolute(row.cwd));assert.ok(Number.isSafeInteger(row.uid)&&row.uid>0);}
}
export function assertCheckpoint(value,g,mode){
 assert.equal(value.platform,'Linux');assert.deepEqual(value.identity,g.identity);assert.deepEqual(value.leaf,{...g.leaf,mode});
 assert.deepEqual(value.genuineCLI,{path:g.genuineCLI.path,bytes:g.genuineCLI.bytes,sha256:g.genuineCLI.sha256});assert.deepEqual(value.witness,{path:g.witness.path,bytes:g.witness.bytes,sha256:g.witness.sha256});
 assertWitness(value.entries);assert.ok(value.entries.every(row=>row.uid===g.identity.uid&&row.home===g.home&&row.codeHome===g.codeHome&&Array.isArray(row.forbiddenEnvironmentNames)&&row.forbiddenEnvironmentNames.length===0));assert.equal(value.authAbsent,true);assert.equal(value.home,g.home);assert.equal(value.codeHome,g.codeHome);
}
export function assertDeniedObservation(value){
 assert.equal(value.closed,true);assert.equal(value.stdoutEOF,true);assert.equal(value.stderrEOF,true);assert.equal(value.code,125);assert.equal(value.signal,null);assert.ok(value.stderr.includes('Permission denied')&&value.stderr.includes(folderMessage));
 assert.ok(value.UIText.includes('Codex 설치 미확인')&&value.UIText.includes('로그인 미확인')&&value.UIText.includes('Permission denied')&&value.UIText.includes(folderMessage));
 assert.ok(!value.UIText.includes('Codex 설치 필요')&&!value.UIText.includes('작업 환경에 Codex CLI를 설치'));assert.equal(value.extraCLIEntries,0);assert.equal(value.buttonEnabled,true);
}
export function assertOriginalClosure(owner){
 assert.ok(Number.isSafeInteger(owner.pid)&&owner.pid>0);assert.equal(owner.applicationClosed,true);assert.equal(owner.exitObserved,true);assert.equal(owner.childClosed,true);assert.deepEqual(owner.exit,{code:0,signal:null});
 for(const name of ['stdoutEOF','stderrEOF','stdoutClosed','stderrClosed'])assert.equal(owner[name],true);
}
export async function changePermission(state,action,verifiedOperation){
 assert.ok(['deny','restore'].includes(action));assert.equal(state.confirmed,true);
 // A remote chmod can succeed before its later seal/parse/checkpoint fails.
 if(action==='deny')state.modeRestored=false;
 const value=await verifiedOperation(action);
 if(action==='restore')state.modeRestored=true;
 return value;
}
export function hasFreshFolderCommand(before,after,leaf){
 return after.commands.slice(before.commands.length).some(row=>typeof row.command==='string'&&row.command.includes(leaf));
}

// These are the only remote control scripts. No command is accepted from input.
export function guestScript(action,g){
 assert.ok(['status','deny','restore'].includes(action));
 const values=JSON.stringify({action,identity:g.identity,leaf:g.leaf,cli:g.genuineCLI,witness:g.witness,home:g.home,codeHome:g.codeHome});
 return "python3 - <<'REVIEWOPS_OWNED_GUEST'\n"+`import os,sys,json,stat,hashlib,platform\nv=json.loads(${JSON.stringify(values)})\np=v['leaf']['path']; s=os.lstat(p)\nassert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)\nassert os.path.realpath(p)==p\nassert (s.st_dev,s.st_ino,s.st_uid)==(v['leaf']['dev'],v['leaf']['ino'],v['leaf']['uid'])\nidentity={'bootId':open('/proc/sys/kernel/random/boot_id').read().strip(),'uid':os.getuid(),'euid':os.geteuid(),'kernel':platform.release(),'machine':platform.machine()}\nassert identity==v['identity'] and identity['uid']>0\nif v['action']!='status': os.chmod(p,0 if v['action']=='deny' else 448,follow_symlinks=False)\ns=os.lstat(p)\nassert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and (s.st_dev,s.st_ino,s.st_uid)==(v['leaf']['dev'],v['leaf']['ino'],v['leaf']['uid']) and os.path.realpath(p)==p\ndef seal(r):\n t=os.lstat(r['path']); assert stat.S_ISREG(t.st_mode) and not stat.S_ISLNK(t.st_mode) and t.st_size==r['bytes'] and t.st_size<=536870912\n h=hashlib.sha256()\n with open(r['path'],'rb') as f:\n  for b in iter(lambda:f.read(1048576),b''): h.update(b)\n assert h.hexdigest()==r['sha256']\n return {'path':r['path'],'bytes':t.st_size,'sha256':h.hexdigest()}\nlog=v['witness']['logPath']; entries=[]\nif os.path.lexists(log):\n t=os.lstat(log); assert stat.S_ISREG(t.st_mode) and not stat.S_ISLNK(t.st_mode) and t.st_size<=1048576\n with open(log) as f: entries=[json.loads(line) for line in f if line.strip()]\nassert len(entries)<=500\nhome=os.path.expanduser('~'); code=v['codeHome']; assert home==v['home'] and os.environ.get('CODEX_HOME',code)==code\nprint(json.dumps({'platform':platform.system(),'identity':identity,'home':home,'codeHome':code,'leaf':dict(v['leaf'],mode=stat.S_IMODE(s.st_mode)),'genuineCLI':seal(v['cli']),'witness':seal(v['witness']),'entries':entries,'authAbsent':all(not os.path.lexists(os.path.join(code,n)) for n in ['auth.json','credentials.json'])}))\nREVIEWOPS_OWNED_GUEST`;
}
const hash=file=>{const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),block=Buffer.alloc(1024**2);try{for(;;){const n=fs.readSync(fd,block,0,block.length,null);if(!n)break;h.update(block.subarray(0,n));}}finally{fs.closeSync(fd);}return h.digest('hex');};
function regular(file,max=8*1024**2){const s=fs.lstatSync(file);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.size<=max);return s;}
function read(file){regular(file);return JSON.parse(fs.readFileSync(file,'utf8'));}
function pin(row){pinShape(row);assert.equal(regular(row.path,2*1024**3).size,row.bytes);assert.equal(hash(row.path),row.sha256);return row.path;}
async function until(readValue,test,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const v=await readValue();if(test(v))return v;await new Promise(r=>setTimeout(r,50));}throw new Error(label+' deadline; original resources are retained');}

// Passive observer: real selected ssh2 clients/channels and unchanged callbacks.
function installSSHObserver(_electron,target){
 const {Client}=process.mainModule.require('ssh2'),{StringDecoder}=process.getBuiltinModule('string_decoder'),originalConnect=Client.prototype.connect,originalExec=Client.prototype.exec,selected=new WeakMap();
 const state={clients:[],commands:[]};globalThis.__reviewopsLinuxPermission=state;
 Client.prototype.connect=function(options){
  if(options.host===target.host&&options.port===target.port&&options.username===target.username){const r={ordinal:state.clients.length+1,closed:false};state.clients.push(r);selected.set(this,r);this.once('close',()=>{r.closed=true;});}
  return Reflect.apply(originalConnect,this,arguments);
 };
 Client.prototype.exec=function(command,options,callback){
  if(!selected.has(this))return Reflect.apply(originalExec,this,arguments);
  if(typeof options==='function'){callback=options;options=undefined;}
  const r={ordinal:state.commands.length+1,command,closed:false,code:null,signal:null,stdout:'',stderr:'',stdoutEOF:false,stderrEOF:false,overflow:false};state.commands.push(r);
  const done=(error,channel)=>{if(error){r.error=error.code||error.name;return callback(error,channel);}let n=0;const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};const collect=(key,chunk)=>{n+=chunk.length;if(n<=262144)r[key]+=decoders[key].write(chunk);else r.overflow=true;};channel.on('data',chunk=>collect('stdout',chunk));channel.stderr.on('data',chunk=>collect('stderr',chunk));channel.once('end',()=>{r.stdout+=decoders.stdout.end();r.stdoutEOF=true;});channel.stderr.once('end',()=>{r.stderr+=decoders.stderr.end();r.stderrEOF=true;});channel.once('close',(code,signal)=>{r.closed=true;r.code=code;r.signal=signal||null;});return callback(error,channel);};
  return options===undefined?originalExec.call(this,command,done):originalExec.call(this,command,options,done);
 };
 return {installed:true,selectedEndpoint:{host:target.host,port:target.port,username:target.username}};
}

export async function run(bindingFile,approvalFile){
 assert.ok(absolute(bindingFile)&&absolute(approvalFile)&&bindingFile!==approvalFile);
 const b=read(bindingFile),a=read(approvalFile),host={platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron,uid:process.getuid?.(),euid:process.geteuid?.(),ci:process.env.CI,actions:process.env.GITHUB_ACTIONS,event:process.env.GITHUB_EVENT_NAME,attempt:Number(process.env.GITHUB_RUN_ATTEMPT),runId:Number(process.env.GITHUB_RUN_ID),githubSHA:process.env.GITHUB_SHA};
 assertBinding(b,host);assert.equal(a.approvedForOneInstalledLinuxPermissionUI,true);assert.equal(a.bindingSHA256,hash(bindingFile));assert.equal(a.source,SOURCE);assert.equal(a.harnessSource,b.harnessSource);assert.equal(a.maximumAppLaunches,1);assert.equal(a.vmStartOrStopAuthorized,false);
 for(const key of ['preparedSupplyPin','preparedRootAcceptancePin','guestRootAcceptancePin','sourceGuardRootPin','packageZipPin','expectedASARPin','executablePin','actualNodeIdentity','driverPin'])pin(b[key]);
 assert.equal(b.driverPin.path,fileURLToPath(import.meta.url));assert.equal(fs.realpathSync(process.execPath),b.actualNodeIdentity.path);assert.equal(b.actualNodeIdentity.version.replace(/^v/,''),host.node);
 const prepared=read(b.preparedRootAcceptancePin.path),guestProof=read(b.guestRootAcceptancePin.path),sourceProof=read(b.sourceGuardRootPin.path);
 assert.equal(prepared.accepted,true);assert.deepEqual(prepared.preparedSupplyPin,b.preparedSupplyPin);assert.equal(prepared.productSource,SOURCE);
 assert.equal(guestProof.accepted,true);assert.equal(guestProof.productSource,SOURCE);assert.deepEqual(guestProof.preparedSupplyPin,b.preparedSupplyPin);assert.deepEqual(guestProof.guest,b.guest);assert.equal(guestProof.originalVMRetained,true);
 assert.equal(sourceProof.accepted,true);assert.equal(sourceProof.harnessSource,b.harnessSource);assert.equal(sourceProof.productSource,SOURCE);assert.equal(sourceProof.baselineFiles,429);assert.equal(sourceProof.existingFilesUnchanged,true);
 for(const file of [b.privateRoot,b.home,b.codeHome,b.packageApp])assert.equal(fs.realpathSync(file),file);
 assert.ok(!fs.existsSync(b.output)&&!fs.existsSync(b.claimPath));assert.ok(!fs.existsSync(b.dataDir)||fs.readdirSync(b.dataDir).length===0);assert.equal(fs.readFileSync(b.sshConfig,'utf8'),'');assert.ok(!fs.existsSync(path.join(b.codeHome,'auth.json'))&&!fs.existsSync(path.join(b.codeHome,'credentials.json')));
 const require=createRequire(path.join(b.root,'package.json'));for(const row of b.dependencyPins)pin(row);for(const name of ['@playwright/test','ssh2'])assert.ok(b.dependencyPins.some(row=>row.path===require.resolve(name)));
 const {_electron,expect}=require('@playwright/test'),{Client,utils}=require('ssh2'),{setTestLocale}=await import('../test-locale.mjs');
 fs.mkdirSync(b.output,{recursive:true,mode:0o700});fs.writeFileSync(b.claimPath,JSON.stringify({source:SOURCE,harnessSource:b.harnessSource,maximumAppLaunches:1,automaticRetry:false})+'\n',{flag:'wx',mode:0o600});
 const result={ok:false,source:SOURCE,harnessSource:b.harnessSource,build:BUILD,formalQAID:'QA-034-004',newFormalQAIDs:0,appLaunchAttempts:0,conditions:[],photos:[],controlCommands:[],normalQuitRequests:0,driverSignals:0,VMStarts:0,VMStops:0,modelGenerationRequested:false,OAuthSubmitted:false,startedAt:new Date().toISOString()};
 const save=()=>fs.writeFileSync(path.join(b.output,'results.json'),JSON.stringify(result,null,2)+'\n');save();
 const client=new Client();let controlClosed=false,ready=false;client.once('close',()=>{controlClosed=true;});client.on('error',error=>{result.controlError=error.code||error.name;save();});
 const connected=new Promise((resolve,reject)=>{client.once('ready',()=>{ready=true;resolve();});client.once('error',reject);});
 let app,owner,page,failure,controlPending=0,quitRequested=false,expectedMode=0o700;
 const permission={confirmed:false,modeRestored:false};
 const appClosed=()=>Boolean(owner&&owner.applicationClosed&&owner.exitObserved&&owner.childClosed&&owner.stdoutEOF&&owner.stderrEOF&&owner.stdoutClosed&&owner.stderrClosed);
 const observe=()=>app.evaluate(()=>globalThis.__reviewopsLinuxPermission);
 async function control(action){
  assert.ok(ready&&!controlClosed&&controlPending===0);controlPending++;const row={ordinal:result.controlCommands.length+1,action,closed:false,stdout:'',stderr:'',code:null,stdoutEOF:false,stderrEOF:false};result.controlCommands.push(row);save();
  client.exec(guestScript(action,b.guest),(error,ch)=>{if(error){controlPending--;row.error=error.code||error.name;save();return;}let bytes=0;for(const [stream,key]of [[ch,'stdout'],[ch.stderr,'stderr']]){stream.on('data',chunk=>{bytes+=chunk.length;if(bytes<=2*1024**2)row[key]+=chunk.toString();else row.overflow=true;});stream.once('end',()=>{row[key+'EOF']=true;save();});}ch.once('error',error=>{row.error=error.code||error.name;save();});ch.once('close',(code,signal)=>{row.closed=true;row.code=code;row.signal=signal||null;controlPending--;save();});ch.end();});
  const value=await until(()=>row,v=>v.closed&&v.stdoutEOF&&v.stderrEOF||v.error,'Original control channel',30000);assert.equal(value.error,undefined);assert.equal(value.code,0);assert.equal(value.signal,null);assert.equal(value.overflow,undefined);const v=JSON.parse(value.stdout),mode=action==='deny'?0:action==='restore'?0o700:expectedMode;assertCheckpoint(v,b.guest,mode);expectedMode=mode;return v;
 }
 async function quiet(){const actual=await until(async()=>({cache:await page.evaluate(()=>window.reviewops.invoke('modelCache.state')),ssh:await observe()}),v=>v.cache.targets.every(r=>!r.refreshing)&&v.ssh.clients.every(r=>r.closed)&&v.ssh.commands.every(r=>r.closed&&r.stdoutEOF&&r.stderrEOF),'Original app SSH/model-cache quiescence',40000);result.actualAppSSHObservation=actual.ssh;result.actualModelCacheObservation=actual.cache;save();return actual;}
 async function snapshot(name){const file=path.join(b.output,name);await page.screenshot({path:file,type:'png',fullPage:false});result.photos.push({file,sha256:hash(file),edited:false,scope:'Original whole installed application-host content; OS decorations not captured'});save();}
 const invoke=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
 try{
  result.controlConnectAttempts=1;client.connect({host:b.guest.host,port:b.guest.port,username:b.guest.username,privateKey:fs.readFileSync(pin(b.guest.privateKeyPin)),agent:undefined,readyTimeout:20000,hostVerifier:key=>'SHA256:'+crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/,'')===b.guest.hostKeyFingerprint});
  await connected;let first=await control('status');assertCheckpoint(first,b.guest,0o700);permission.confirmed=true;permission.modeRestored=true;
  fs.mkdirSync(b.dataDir,{recursive:true,mode:0o700});fs.mkdirSync(path.join(b.dataDir,'codex-manager'),{mode:0o700});fs.writeFileSync(path.join(b.dataDir,'codex-manager/runtime.json'),JSON.stringify({path:path.join(b.home,'intentionally-unavailable-local-runtime')}),{flag:'wx',mode:0o600});
  const env={HOME:b.home,USERPROFILE:b.home,CODEX_HOME:b.codeHome,REVIEWOPS_DATA_DIR:b.dataDir,REVIEWOPS_SSH_CONFIG:b.sshConfig,REVIEWOPS_CODEX_SSH_CONFIG:b.sshConfig,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:path.join(b.privateRoot,'tmp'),LANG:'ko_KR.UTF-8',LC_ALL:'ko_KR.UTF-8',TZ:'UTC'};fs.mkdirSync(env.TMPDIR,{recursive:true,mode:0o700});
  result.appLaunchAttempts=1;save();app=await _electron.launch({executablePath:b.executablePin.path,args:[],env,timeout:30000});const child=app.process();
  owner={pid:child.pid,applicationClosed:false,exitObserved:false,childClosed:false,stdoutEOF:child.stdout?.readableEnded===true,stderrEOF:child.stderr?.readableEnded===true,stdoutClosed:child.stdout?.closed===true,stderrClosed:child.stderr?.closed===true,observationStartsAfterPublicHandleReturned:true};
  for(const [stream,prefix]of [[child.stdout,'stdout'],[child.stderr,'stderr']]){stream?.on('data',()=>{});stream?.once('end',()=>{owner[prefix+'EOF']=true;save();});stream?.once('close',()=>{owner[prefix+'Closed']=true;save();});}
  child.once('exit',(code,signal)=>{owner.exitObserved=true;owner.exit={code,signal};save();});child.once('close',()=>{owner.childClosed=true;save();});app.once('close',()=>{owner.applicationClosed=true;save();});result.owner=owner;
  const identity=await app.evaluate(({app})=>({pid:process.pid,platform:process.platform,arch:process.arch,version:app.getVersion(),packaged:app.isPackaged,appPath:app.getAppPath(),executable:process.execPath,userData:app.getPath('userData'),OSHome:app.getPath('home'),nodeHome:process.getBuiltinModule('os').homedir(),codeHome:process.env.CODEX_HOME,forbidden:['SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','NODE_OPTIONS','NODE_PATH'].filter(k=>Boolean(process.env[k]))}));
  assert.equal(identity.pid,owner.pid);assert.equal(identity.platform,'darwin');assert.equal(identity.arch,'arm64');assert.equal(identity.version,'1.4.1');assert.equal(identity.packaged,true);assert.equal(identity.appPath,b.expectedASARPin.path);assert.equal(identity.executable,b.executablePin.path);assert.equal(identity.userData,b.dataDir);assert.equal(identity.nodeHome,b.home);assert.equal(identity.codeHome,b.codeHome);assert.deepEqual(identity.forbidden,[]);result.appIdentity=identity;
  page=await until(()=>app.windows().filter(p=>!p.isClosed()&&/^reviewops:\/\/app\/index\.html$/.test(p.url())),v=>v.length===1,'Exact original app host').then(v=>v[0]);page.setDefaultTimeout(20000);await setTestLocale(page);
  assert.deepEqual((await page.evaluate(()=>window.accountManager.getState())).accounts,[]);assert.equal((await page.evaluate(()=>window.accountManager.getState())).runtime.available,false);assert.deepEqual((await page.evaluate(()=>window.hostManager.getState())).hosts,[]);assert.deepEqual((await invoke('app.info')).build,BUILD);result.privateAgentRunsBefore=await invoke('agent.list');assert.deepEqual(result.privateAgentRunsBefore,[]);
  await app.evaluate(installSSHObserver,b.guest);await invoke('modelCache.configure',{intervalMinutes:1440});
  const group=await invoke('group.save',{name:'Owned real Linux permission QA'}),service=await invoke('service.save',{groupId:group.id,name:'Owned Linux SSH',kind:'ssh',host:b.guest.host,port:b.guest.port,username:b.guest.username,authType:'key',privateKeyPath:b.guest.privateKeyPin.path,rootPath:b.guest.leaf.path,agentWorkPath:b.guest.leaf.path,agentBinary:b.guest.witness.path,agentEnabled:1});
  const project=await invoke('project.save',{groupId:group.id,name:'실제 Linux 폴더 권한 검사',serviceIds:[service.id]});assert.equal(project.connection.id,service.id);result.fixture={projectId:project.id,connectionId:service.id};
  await page.locator('.workspace-refresh').click();const open=page.locator('button.work-home-node-link').and(page.getByRole('button',{name:project.name+' 프로젝트 열기',exact:true}));assert.equal(await open.count(),1);await open.click();const pane=page.locator('.workspace-pane:not([hidden])');await pane.getByRole('navigation',{name:'프로젝트 기능',exact:true}).getByRole('button',{name:'설정',exact:true}).click();const settings=pane.locator('.original-project-settings');await settings.getByRole('tab',{name:'에이전트',exact:true}).click();
  const inspect=settings.getByRole('button',{name:'실행 환경 검사',exact:true}),diagnostic=settings.locator('.agent-environment');await expect(inspect).toBeEnabled();await inspect.click();const trust=page.getByRole('dialog',{name:'SSH 호스트 확인',exact:true});await expect(trust).toBeVisible();await expect(trust).toContainText(b.guest.hostKeyFingerprint);await trust.getByRole('button',{name:'이 호스트 신뢰',exact:true}).click();await expect(inspect).toBeEnabled();await quiet();
  async function inspectOnce(phase){const before=await observe();await expect(inspect).toBeEnabled();await inspect.click();await until(observe,after=>hasFreshFolderCommand(before,after,b.guest.leaf.path),'New post-click original folder command');await expect(inspect).toBeEnabled();await quiet();const text=await diagnostic.innerText();assert.ok(text.includes(b.guest.leaf.path));await diagnostic.scrollIntoViewIfNeeded();await expect(diagnostic).toBeVisible();const after=await observe();const commands=after.commands.slice(before.commands.length);assert.ok(commands.length>0&&commands.every(r=>r.closed&&r.stdoutEOF&&r.stderrEOF&&!r.overflow));return {phase,UIText:text,commands};}
  const normal=await inspectOnce('normal');assert.ok(normal.UIText.includes(b.guest.genuineCLI.version)&&normal.UIText.includes('로그인 필요')&&!normal.UIText.includes('Codex 설치 필요'));const normalState=await control('status');assert.ok(normalState.entries.length>first.entries.length);result.conditions.push(normal);await snapshot('01-normal-genuine-cli-host.png');
  await quiet();const deniedState=await changePermission(permission,'deny',control);const denied=await inspectOnce('denied');const afterDenied=await control('status');assertCheckpoint(afterDenied,b.guest,0);assert.deepEqual(afterDenied.entries,deniedState.entries);const failed=denied.commands.find(r=>r.code===125&&r.stderr.includes(folderMessage));assert.ok(failed);assertDeniedObservation({...failed,UIText:denied.UIText,extraCLIEntries:afterDenied.entries.length-deniedState.entries.length,buttonEnabled:await inspect.isEnabled()});result.conditions.push(denied);await snapshot('02-real-linux-permission-denied-host.png');
  await changePermission(permission,'restore',control);const restored=await inspectOnce('restored');assert.ok(restored.UIText.includes(b.guest.genuineCLI.version)&&restored.UIText.includes('로그인 필요'));const restoredState=await control('status');assert.ok(restoredState.entries.length>afterDenied.entries.length);result.conditions.push(restored);await snapshot('03-same-folder-restored-host.png');
  result.privateAgentRunsAfter=await invoke('agent.list');assert.deepEqual(result.privateAgentRunsAfter,[]);assert.deepEqual((await page.evaluate(()=>window.accountManager.getState())).accounts,[]);result.manualEnvironmentSequenceComplete=true;
 }catch(error){failure=error;result.error={name:error.name,message:error.message};if(result.appLaunchAttempts&&!owner)result.launchOwnership='UNKNOWN: launch rejected before a public original handle; no PID adoption';}
 finally{
  if(ready&&!controlClosed&&!controlPending&&permission.confirmed&&!permission.modeRestored)try{await changePermission(permission,'restore',control);}catch(error){result.restoreError=error.message;failure||=error;}
  if(app&&owner&&permission.modeRestored&&!quitRequested)try{await quiet();const dirty=await page.evaluate(()=>document.documentElement.dataset.reviewopsDirty==='true');assert.equal(dirty,false);quitRequested=true;result.normalQuitRequests++;await app.evaluate(({app})=>{setImmediate(()=>app.quit());});await until(()=>owner,()=>appClosed(),'Original normal app closure');assertOriginalClosure(owner);}catch(error){result.cleanupError=error.message;failure||=error;}
  if(ready&&!controlPending&&permission.modeRestored){client.end();try{await until(()=>controlClosed,Boolean,'Original SSH control connection close');}catch(error){result.controlCleanupError=error.message;failure||=error;}}
  try{pin(b.packageZipPin);pin(b.expectedASARPin);pin(b.executablePin);pin(b.guest.privateKeyPin);}catch(error){result.preservationError=error.message;failure||=error;}
  result.originalApp=owner||null;result.controlConnectionClosed=controlClosed;result.permissionRestored=permission.modeRestored;result.cleanupConfirmed=(!result.appLaunchAttempts||appClosed())&&controlClosed&&permission.modeRestored&&!controlPending;result.ok=!failure&&result.manualEnvironmentSequenceComplete===true&&result.cleanupConfirmed;result.finishedAt=new Date().toISOString();save();
  if(!result.cleanupConfirmed&&(result.appLaunchAttempts||ready||result.controlConnectAttempts&&!controlClosed)){result.held=true;save();await new Promise(()=>{setInterval(()=>save(),10000);});}
 }
 if(failure)throw failure;return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const args=process.argv.slice(2);assert.equal(args.length,4);assert.equal(args[0],'--binding');assert.equal(args[2],'--approval');run(args[1],args[3]).then(r=>console.log(JSON.stringify({ok:r.ok,source:r.source,formalQAID:r.formalQAID,newFormalQAIDs:0}))).catch(e=>{console.error(e.message);process.exitCode=1;});}
