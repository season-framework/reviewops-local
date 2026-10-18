import {setTestLocale} from './test-locale.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';

const {Server,utils}=ssh2;
const root=process.cwd(),testRoot=fs.mkdtempSync(path.join('/tmp','reviewops-agent-files-'));
const results=path.join(root,'test-results'),dataPath=path.join(testRoot,'data');fs.mkdirSync(results,{recursive:true});
const homePath=path.join(testRoot,'home'),sshConfig=path.join(homePath,'.ssh','config');fs.mkdirSync(path.dirname(sshConfig),{recursive:true});fs.writeFileSync(sshConfig,'# Synthetic agent file fixture\n',{mode:0o600});
const password='synthetic-ssh-password-17',remoteRoot='/opt/spring';
const documentPath=remoteRoot+'/docs/development-log.md';
const specialName='공백 (배포) 100% #결과.md',specialPath=remoteRoot+'/docs/'+specialName;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=','base64');
const binary=Buffer.alloc(180001);for(let index=0;index<binary.length;index++)binary[index]=index%251;
function fixturePdf(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];
 let text='%PDF-1.4\n';const offsets=[0];for(const [index,body]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${body}\nendobj\n`;}
 const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');text+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(text);
}
const pdf=fixturePdf();
const files=new Map([
 [documentPath,Buffer.from('# 배포 재시도 기록\n\nFIXTURE_DEPLOYMENT_LOG_8305\n\n[다음 문서](./next.md)\n\n[같은 이름의 루트 문서](../next.md)')],
 [remoteRoot+'/docs/next.md',Buffer.from('# 다음 문서\n\nFIXTURE_NESTED_DOC_DIRECTORY')],
 [remoteRoot+'/next.md',Buffer.from('# 루트 문서\n\nFIXTURE_ROOT_DIRECTORY')],
 [specialPath,Buffer.from('# 특수 문자 문서\n\nFIXTURE_SPACES_PARENTHESES_PERCENT_HASH')],
 [remoteRoot+'/docs/literal%20name.md',Buffer.from('# 퍼센트 파일\n\nFIXTURE_LITERAL_PERCENT_NAME')],
 [remoteRoot+'/artifacts/preview.html',Buffer.from('<!doctype html><title>합성 HTML</title><h1>FIXTURE_HTML_PREVIEW</h1><p id="script-result"></p><p id="isolation-result"></p><script>document.getElementById("script-result").textContent="FIXTURE_SCRIPT_EXECUTED";let parentBridge=false;try{parentBridge=!!parent.reviewops}catch{}document.getElementById("isolation-result").textContent=JSON.stringify({parentBridge,nodeRequire:typeof require,nodeProcess:typeof process});</script>')],
 [remoteRoot+'/artifacts/pixel.png',png],
 [remoteRoot+'/artifacts/sample.pdf',pdf],
 [remoteRoot+'/artifacts/archive.bin',binary],
 ['/outside/private.md',Buffer.from('OUTSIDE_FILE_MUST_NOT_BE_OPENED')],
 ['/opt/changed/docs/development-log.md',Buffer.from('WRONG_NEW_WORK_DIRECTORY')],
]);
const directories=new Set(['/','/opt','/opt/spring','/opt/spring/docs','/opt/spring/artifacts','/opt/changed','/opt/changed/docs','/outside','/home/reviewops-fixture']);
const encodedSpecial=remoteRoot+'/docs/'+encodeURIComponent(specialName);
const response=[
 `[배포 재시도 기록](${documentPath}:8305)`,
 `[줄과 열](${documentPath}:8305:9)`,
 `[줄 앵커](${documentPath}#L8305)`,
 `[줄 범위](${documentPath}#L8305-L8310)`,
 `[특수 문자 파일](<${specialPath}>)`,
 `[인코딩된 특수 문자 파일](${encodedSpecial})`,
 `[퍼센트 이름](docs/literal%20name.md)`,
 `[파일 주소](file://${documentPath}#L8305)`,
 `[샌드박스 주소](sandbox:${documentPath}#L8305)`,
 '[HTML 화면](artifacts/preview.html)',
 '[PNG 이미지](artifacts/pixel.png)',
 '[PDF 문서](artifacts/sample.pdf)',
 '[바이너리 파일](artifacts/archive.bin)',
 '[범위 밖 파일](/outside/private.md)',
 '[범위 밖 연결](docs/linked-outside.md)',
 '[없는 파일](docs/missing.md:11)',
].join('\n\n');
const hostKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
const fingerprint='SHA256:'+crypto.createHash('sha256').update(utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/,'');
const clients=new Set(),checks=[],errors=[],requests=[],commands=[],fileReads=[];let authentications=0,app,page,server;
const passed=name=>{checks.push(name);console.log(`PASS: ${name}`)};
const pane=()=>page.locator('.workspace-pane:not([hidden])'),panel=()=>pane().locator('.agent-panel').last();
const preview=()=>page.locator('.agent-generated-preview [role="dialog"]');
const request=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.request(action,payload),{action,payload});
async function ipc(action,payload={}){const result=await request(action,payload);assert.equal(result.ok,true,`${action}: ${result.error?.message||'IPC 오류'}`);return result.data;}
const normalize=value=>value==='.'?'/home/reviewops-fixture':path.posix.normalize(value);
function attrs(file){const directory=directories.has(file),size=files.get(file)?.length||0;return{mode:directory?0o040755:0o100644,uid:1000,gid:1000,size,atime:1700000000,mtime:1700000000};}
async function startServer(){
 server=new Server({hostKeys:[hostKey]},client=>{
  clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
  client.on('authentication',context=>{authentications++;if(context.method==='password'&&context.username==='fixture-user'&&context.password===password)context.accept();else context.reject();});
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();
   session.on('sftp',acceptSftp=>{
    const sftp=acceptSftp(),handles=new Map();let handleNumber=0;
    sftp.on('REALPATH',(id,input)=>{let target=normalize(input);if(target===remoteRoot+'/docs/linked-outside.md')target='/outside/private.md';if(files.has(target)||directories.has(target))sftp.name(id,[{filename:target,longname:target,attrs:attrs(target)}]);else sftp.status(id,2,'합성 서버에 파일이 없습니다.');});
    sftp.on('STAT',(id,input)=>{const target=normalize(input);if(files.has(target)||directories.has(target))sftp.attrs(id,attrs(target));else sftp.status(id,2,'합성 서버에 파일이 없습니다.');});
    sftp.on('OPEN',(id,input)=>{const target=normalize(input);if(!files.has(target)){sftp.status(id,2,'합성 서버에 파일이 없습니다.');return;}const key=String(++handleNumber);handles.set(key,{path:target,bytes:files.get(target)});sftp.handle(id,Buffer.from(key));});
    sftp.on('READ',(id,key,offset,length)=>{const file=handles.get(key.toString());if(!file){sftp.status(id,4,'잘못된 합성 파일 핸들입니다.');return;}if(offset>=file.bytes.length){sftp.status(id,1);return;}const chunk=file.bytes.subarray(offset,offset+length);fileReads.push({path:file.path,offset,length:chunk.length});sftp.data(id,chunk);});
    sftp.on('CLOSE',(id,key)=>{handles.delete(key.toString());sftp.status(id,0);});
   });
   session.on('exec',(acceptExec,_reject,info)=>{
    const stream=acceptExec(),record={command:info.command,input:'',kind:''};commands.push(record);stream.on('error',()=>{});stream.on('data',chunk=>{record.input+=chunk.toString();});
    const finish=(text='',code=0)=>{stream.write(text);stream.exit(code);stream.end();};
    if(info.command.includes('--version')){record.kind='version';finish('codex-cli synthetic-file-17\n');return;}
    if(info.command.includes('models_cache.json')){record.kind='models';finish(JSON.stringify({models:[{slug:'fixture-model',display_name:'합성 모델'}]}));return;}
    if(info.command.includes('login')&&info.command.includes('status')){record.kind='authentication';finish('');return;}
    if(info.command.includes('--json')){
     record.kind='request';stream.on('end',()=>{setTimeout(()=>finish([{type:'thread.started',thread_id:'fixture-files-thread'},{type:'turn.started'},{type:'item.completed',item:{id:'answer',type:'agent_message',text:response}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].map(event=>JSON.stringify(event)+'\n').join('')),60);});return;
    }
    record.kind='unexpected';finish('지원하지 않는 합성 SSH 명령입니다.\n',1);
   });
  }));
 });
 server.on('error',error=>errors.push('합성 SSH 서버: '+error.message));await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;
}
async function launch(){
 const env={...process.env,HOME:homePath,CODEX_HOME:path.join(homePath,'.codex'),REVIEWOPS_CODEX_SSH_CONFIG:sshConfig,REVIEWOPS_DATA_DIR:dataPath};for(const name of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});page=await app.firstWindow(); await setTestLocale(page);page.on('pageerror',error=>errors.push(error.message));page.on('request',req=>{if(/^https?:/.test(req.url()))requests.push(req.url());});await page.waitForFunction(()=>!!window.reviewops?.request);await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('reviewops://app/')).setSize(1600,1050));
}
async function stopApp(){if(!app)return;const current=app;app=null;await current.evaluate(({app})=>app.exit(0)).catch(()=>{});await current.close().catch(()=>{});}
async function openLink(container,label,name,marker){await container.getByRole('link',{name:label,exact:true}).click();await expect(preview()).toBeVisible();if(name)await expect(preview()).toHaveAccessibleName(name);if(marker)await expect(preview()).toContainText(marker);}
async function closePreview(){await preview().getByRole('button',{name:'닫기',exact:true}).click();await expect(preview()).toHaveCount(0);}
async function download(expected,name){const destination=path.join(testRoot,name);await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},destination);await preview().getByRole('button',{name:'다운로드',exact:true}).click();await expect(preview().getByRole('status')).toContainText('저장 완료');assert.deepEqual(fs.readFileSync(destination),expected);}
try{
 const port=await startServer();await launch();
 assert.equal(await app.evaluate(({app})=>app.commandLine.hasSwitch('use-mock-keychain')),process.platform==='darwin');
 const group=await ipc('group.save',{name:'SSH 작업 파일 검사'}),service=await ipc('service.save',{groupId:group.id,name:'합성 SSH 서비스',kind:'ssh',host:'127.0.0.1',port,username:'fixture-user',authType:'password',password,rootPath:remoteRoot,agentEnabled:true,agentBinary:'/fixture/bin/codex',agentWorkPath:remoteRoot,agentModel:'fixture-model'}),project=await ipc('project.save',{groupId:group.id,name:'생성 파일 검사',serviceIds:[service.id]}),review=await ipc('review.save',{projectId:project.id,serviceId:service.id,title:'SSH 작업 파일 링크',body:'FAKE_FIXTURE_ONLY'});
 const snapshot=await ipc('snapshot'),saved=snapshot.services.find(item=>item.id===service.id);assert.equal(saved.hasPassword,true);assert.equal(saved.password,undefined);assert.ok(!JSON.stringify(snapshot).includes(password));const encrypted=fs.readFileSync(path.join(dataPath,'credentials.json'),'utf8');assert.ok(encrypted.includes('reviewops-aes256gcm-v1:'));assert.ok(!encrypted.includes(password));assert.equal(fs.statSync(path.join(dataPath,'credentials.json')).mode&0o777,0o600);assert.equal(fs.statSync(path.join(dataPath,'credentials.json.key')).mode&0o777,0o600);assert.ok(!fs.readFileSync(path.join(dataPath,'reviewops.sqlite')).includes(Buffer.from(password)));
 const first=await request('ssh.test',{serviceId:service.id});assert.equal(first.ok,false);assert.equal(first.error.code,'SSH_TRUST_REQUIRED');assert.equal(first.error.fingerprint,fingerprint);assert.equal(authentications,0);await ipc('ssh.trust',{serviceId:service.id,fingerprint});passed('macOS 키체인 요청 방지와 내부 암호화 저장·서버 승인 전 인증 차단');

 await page.locator('.workspace-refresh').click();await page.getByRole('button',{name:`${project.name} 프로젝트 열기`,exact:true}).click();await pane().locator('.original-review-table tbody tr').filter({hasText:review.title}).click();await pane().getByRole('tab',{name:'에이전트',exact:true}).click();await panel().getByLabel('에이전트 작업 요청',{exact:true}).fill('합성 SSH 파일 응답 생성');await panel().getByRole('button',{name:'작업 요청',exact:true}).click();await expect.poll(async()=>(await ipc('agent.list',{reviewId:review.id}))[0]?.status,{timeout:20000}).toBe('completed');const run=(await ipc('agent.list',{reviewId:review.id}))[0];assert.equal(run.workPath,remoteRoot);assert.equal(run.response,response);const execution=commands.filter(item=>item.kind==='request');assert.equal(execution.length,1);assert.match(execution[0].command,/^bash -lc /);assert.ok(execution[0].command.includes('--dangerously-bypass-approvals-and-sandbox'));assert.ok(!execution[0].command.includes('sandbox_mode='));assert.ok(!execution[0].command.includes('--sandbox'));assert.ok(execution[0].input.includes('합성 SSH 파일 응답 생성'));assert.ok(authentications>0);assert.ok(!commands.some(item=>item.kind==='unexpected'));passed('SSH 비밀번호 인증으로 합성 CLI 실행·로그인 셸·제한 해제 옵션 전달');

 const answer=panel().locator('.agent-answer').last();await openLink(answer,'배포 재시도 기록','development-log.md','FIXTURE_DEPLOYMENT_LOG_8305');await page.screenshot({path:path.join(results,'agent-files-ssh-markdown.png'),scale:'css'});await closePreview();for(const label of ['줄과 열','줄 앵커','줄 범위']){await openLink(answer,label,'development-log.md','FIXTURE_DEPLOYMENT_LOG_8305');await closePreview();}passed('실제 오류와 같은 절대 경로·줄 번호·열 번호·줄 앵커 링크 열기');

 await openLink(answer,'배포 재시도 기록','development-log.md');await preview().getByRole('link',{name:'다음 문서',exact:true}).click();await expect(preview()).toHaveAccessibleName('next.md');await expect(preview()).toContainText('FIXTURE_NESTED_DOC_DIRECTORY');await expect(preview()).not.toContainText('FIXTURE_ROOT_DIRECTORY');await closePreview();await openLink(answer,'배포 재시도 기록','development-log.md');await preview().getByRole('link',{name:'같은 이름의 루트 문서',exact:true}).click();await expect(preview()).toContainText('FIXTURE_ROOT_DIRECTORY');await closePreview();passed('Markdown 안의 상대 경로를 열린 문서 폴더에서 찾기');

 for(const label of ['특수 문자 파일','인코딩된 특수 문자 파일']){await openLink(answer,label,specialName,'FIXTURE_SPACES_PARENTHESES_PERCENT_HASH');await closePreview();}await openLink(answer,'퍼센트 이름','literal%20name.md','FIXTURE_LITERAL_PERCENT_NAME');await closePreview();for(const label of ['파일 주소','샌드박스 주소']){await openLink(answer,label,'development-log.md','FIXTURE_DEPLOYMENT_LOG_8305');await closePreview();}passed('공백·괄호·퍼센트·샵 파일명과 파일 주소·샌드박스 주소 열기');

 await openLink(answer,'HTML 화면','preview.html');const html=page.frameLocator('.agent-generated-frame');await expect(html.getByRole('heading',{name:'FIXTURE_HTML_PREVIEW',exact:true})).toBeVisible();await expect(html.locator('#script-result')).toHaveText('FIXTURE_SCRIPT_EXECUTED');assert.deepEqual(JSON.parse(await html.locator('#isolation-result').innerText()),{parentBridge:false,nodeRequire:'undefined',nodeProcess:'undefined'});await download(files.get(remoteRoot+'/artifacts/preview.html'),'내려받은 화면.html');await closePreview();passed('HTML 실행·앱 연결 격리와 원본 파일 다운로드');
 await openLink(answer,'PNG 이미지','pixel.png');await expect(preview().getByRole('img',{name:'pixel.png',exact:true})).toBeVisible();assert.equal(await preview().getByRole('img',{name:'pixel.png',exact:true}).evaluate(image=>image.naturalWidth),1);await download(png,'내려받은 이미지.png');await closePreview();await openLink(answer,'PDF 문서','sample.pdf');await expect(preview().locator('iframe')).toHaveAttribute('src',/^data:application\/pdf;base64,/);await download(pdf,'내려받은 문서.pdf');await closePreview();passed('PNG·PDF 미리보기와 원본 바이트 보존');
 await openLink(answer,'바이너리 파일','archive.bin');await expect(preview()).toContainText('미리보기를 지원하지 않습니다');await download(binary,'내려받은 파일.bin');await closePreview();assert.ok(fileReads.filter(item=>item.path.endsWith('/archive.bin')).length>=6);passed('바이너리 파일 안내와 여러 SFTP 구간으로 받은 다운로드 바이트 보존');

 for(const label of ['범위 밖 파일','범위 밖 연결']){await answer.getByRole('link',{name:label,exact:true}).click();await expect(preview().getByRole('alert')).toContainText(/작업 폴더|설정한/);await expect(preview()).not.toContainText('OUTSIDE_FILE_MUST_NOT_BE_OPENED');await closePreview();}assert.ok(!fileReads.some(item=>item.path==='/outside/private.md'));await answer.getByRole('link',{name:'없는 파일',exact:true}).click();await expect(preview().getByRole('alert')).toContainText('파일을 찾을 수 없습니다');await closePreview();passed('작업 폴더 밖 파일·심볼릭 연결 차단과 없는 파일 안내');

 await pane().getByRole('tab',{name:'작업이력',exact:true}).click();const history=pane().locator('.review-chat-message.is-agent').last();await openLink(history,'배포 재시도 기록','development-log.md','FIXTURE_DEPLOYMENT_LOG_8305');await closePreview();assert.equal((await ipc('snapshot')).activities.filter(item=>item.agentRunId===run.id&&item.role==='agent').length,1);await ipc('service.save',{id:service.id,rootPath:'/opt/changed',agentWorkPath:'/opt/changed'});await page.locator('.workspace-refresh').click();await openLink(history,'배포 재시도 기록','development-log.md','FIXTURE_DEPLOYMENT_LOG_8305');await expect(preview()).not.toContainText('WRONG_NEW_WORK_DIRECTORY');await closePreview();passed('작업이력 링크 열기와 연결 폴더를 변경한 뒤에도 이전 실행 폴더 유지');

 const beforeRestart=authentications;await stopApp();await launch();assert.equal(await app.evaluate(({app})=>app.commandLine.hasSwitch('use-mock-keychain')),process.platform==='darwin');await ipc('ssh.test',{serviceId:service.id});assert.ok(authentications>beforeRestart);const reopened=await ipc('agent.fileRead',{reviewId:review.id,runId:run.id,path:documentPath+':8305'});assert.ok(reopened.content.includes('FIXTURE_DEPLOYMENT_LOG_8305'));assert.equal(reopened.absolutePath,documentPath);assert.ok(!fs.readFileSync(path.join(dataPath,'credentials.json'),'utf8').includes(password));passed('앱 재실행 뒤 내부 저장 비밀번호와 이전 작업 파일 접근 유지');
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);fs.writeFileSync(path.join(results,'agent-files.json'),JSON.stringify({passed:true,version:(await ipc('app.info')).version,executable:process.env.REVIEWOPS_TEST_EXECUTABLE||'development Electron',checks,errors,externalRequests:requests,authentications,commands:commands.map(item=>({kind:item.kind,command:item.command})),fileReadCount:fileReads.length,testRoot},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,testRoot}));
}catch(error){await page?.screenshot({path:path.join(results,'agent-files-failure.png'),scale:'css'}).catch(()=>{});fs.writeFileSync(path.join(results,'agent-files-failure.json'),JSON.stringify({passed:false,checks,errors,requests,commands:commands.map(item=>({kind:item.kind,command:item.command})),fileReads,message:error.message,testRoot},null,2));console.error('AGENT_FILES_FAILURE',testRoot,error);throw error;}finally{await stopApp();for(const client of clients)client.destroy();if(server)await new Promise(resolve=>server.close(resolve));}
