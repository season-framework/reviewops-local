import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),require=createRequire(import.meta.url),run=promisify(execFile),asar=require('@electron/asar');
const {setTestLocale}=await import(pathToFileURL(path.join(root,'scripts/test-locale.mjs')));
const {isolatedModelRuntime}=await import(pathToFileURL(path.join(root,'scripts/model-cache-fixture.mjs')));
const {collectChangeNotes}=await import(pathToFileURL(path.join(root,'scripts/test-release-notes.mjs')));
if(process.platform!=='darwin'||process.arch!=='x64')throw new Error('This installed integration harness requires native macOS Intel.');
const base=process.env.REVIEWOPS_LEGACY_PACKAGE_DIR;
if(!base||!path.isAbsolute(base))throw new Error('Set REVIEWOPS_LEGACY_PACKAGE_DIR to a verified original public legacy ZIP directory.');
const oldRecord=JSON.parse(await fs.readFile(path.join(base,'verification.json'),'utf8'));
const {validateBuildInfo}=require(path.join(root,'electron/build-info.cjs'));
const oldBuild=validateBuildInfo(oldRecord.build);
if(oldRecord.actual_public_installer!==true||oldRecord.name!==`ReviewOps-${oldBuild.version}-test.${oldBuild.buildNumber}-x64.zip`||!/^[a-f0-9]{64}$/.test(oldRecord.sha256||'')||!Number.isSafeInteger(oldRecord.size)||oldRecord.size<1024||oldRecord.size>512*1024**2)throw new Error('The preserved original public package record is invalid.');
const oldZip=path.join(base,oldRecord.name),newDirectory=process.env.REVIEWOPS_CANDIDATE_PACKAGE_DIR||path.join(root,'release/test-darwin-x64');
const newInfo=validateBuildInfo(JSON.parse(await fs.readFile(path.join(newDirectory,'build-info.json'),'utf8')));
if(newInfo.developmentNumber!==1)throw new Error('This first-migration harness expects an unpublished dev-1 candidate.');
const newZip=path.join(newDirectory,`ReviewOps-${newInfo.version}-test.${newInfo.buildNumber}-x64.zip`);
const output=path.join(root,'test-results/development-version',`installed-${new Date().toISOString().replace(/[:.]/g,'-')}`);await fs.mkdir(output,{recursive:true});
const temp=await fs.mkdtemp('/tmp/reviewops-installed-dev-'),home=path.join(temp,'home'),dataPath=path.join(temp,'data'),targetDirectory=path.join(temp,'target');
await fs.mkdir(targetDirectory);await fs.mkdir(path.join(dataPath,'updates'),{recursive:true});await fs.mkdir(home,{recursive:true});
const hash=async file=>{const digest=crypto.createHash('sha256');for await(const bytes of sync.createReadStream(file))digest.update(bytes);return digest.digest('hex');};
const oldHash=await hash(oldZip);assert.equal(oldHash,oldRecord.sha256);assert.equal((await fs.stat(oldZip)).size,oldRecord.size);
const newHash=await hash(newZip),newSize=(await fs.stat(newZip)).size;
await run('/usr/bin/ditto',['-x','-k',oldZip,targetDirectory],{timeout:120000});
const target=await fs.realpath(path.join(targetDirectory,'ReviewOps.app')),executable=path.join(target,'Contents/MacOS/ReviewOps'),archive=path.join(target,'Contents/Resources/app.asar');
const oldAsarHash=await hash(archive);assert.deepEqual(JSON.parse(asar.extractFile(archive,'electron/reviewops-build.json')),oldRecord.build);
await fs.writeFile(path.join(dataPath,'updates/settings.json'),JSON.stringify({automatic:false,intervalMinutes:10,channel:'test',highestTestBuild:oldRecord.build}));
const config=path.join(home,'ssh-config');await fs.writeFile(config,'# isolated installed update fixture\n');
const env={...process.env,...isolatedModelRuntime({home,dataPath}),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:config,REVIEWOPS_CODEX_SSH_CONFIG:config};
for(const key of Object.keys(env))if(/(?:TOKEN|API_KEY|PASSWORD|SECRET)$/.test(key)||['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK'].includes(key))delete env[key];
const releaseRoot='https://github.com/season-framework/reviewops-local/releases/download/test-latest/';
const api='https://api.github.com/repos/season-framework/reviewops-local/releases/tags/test-latest';
const descriptor=name=>({name,url:releaseRoot+name,size:newSize,sha256:newHash});
const legacyName=path.basename(newZip),canonicalName=`ReviewOps-${newInfo.version}-dev-${newInfo.developmentNumber}-x64.zip`;
const changes=await collectChangeNotes({build:newInfo,baseCommit:oldRecord.build.commit,cwd:root});
const manifest={schema:2,channel:'test',version:newInfo.version,build:newInfo,changes,artifacts:{'darwin-x64':descriptor(legacyName)},developmentArtifacts:{'darwin-x64':descriptor(canonicalName)}};
const bytes=Buffer.from(JSON.stringify(manifest)),manifestName=`reviewops-test-update-${newInfo.buildNumber}-${newInfo.commit.slice(0,12)}.json`;
const pointer={schema:1,manifest:manifestName,buildNumber:newInfo.buildNumber,commit:newInfo.commit,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
const published={tag_name:'test-latest',draft:false,prerelease:true,body:`<!-- reviewops-test-pointer:${JSON.stringify(pointer)} -->`,assets:[legacyName,canonicalName].map(name=>({name,size:newSize,browser_download_url:releaseRoot+name})).concat({name:manifestName,size:bytes.length,browser_download_url:releaseRoot+manifestName})};
const map={[api]:{base64:Buffer.from(JSON.stringify(published)).toString('base64')},[releaseRoot+manifestName]:{base64:bytes.toString('base64')},[releaseRoot+legacyName]:{file:newZip,size:newSize},[releaseRoot+canonicalName]:{file:newZip,size:newSize}};
const checks=[],photos=[],rendererErrors=[];let app,page,launchedPid;
const pass=(id,result)=>{checks.push({id,status:'pass',result});console.log(`PASS ${id}: ${result}`)};
const photo=async name=>{await page.screenshot({path:path.join(output,name)});photos.push(name)};
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const settings=()=>page.locator('.workspace-pane:not([hidden]) .update-settings');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(read,{timeout=90000}={}){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(value)return value;await wait(250)}throw new Error('Timed out waiting for isolated install state.');}
async function launch(){app=await electron.launch({executablePath:executable,args:[],env,timeout:60000});page=await app.firstWindow();page.setDefaultTimeout(15000);await setTestLocale(page);page.on('pageerror',error=>rendererErrors.push(error.message));await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,850));}
async function transport(stage){await app.evaluate(async(_,{map,logFile})=>{
 const require=process.mainModule.require.bind(process.mainModule),https=require('node:https'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events'),fs=require('node:fs');
 globalThis.installedUpdateTransport={requests:[],map};
 https.get=(url,options,callback)=>{const request=new EventEmitter();request.setTimeout=()=>request;request.destroy=error=>{queueMicrotask(()=>request.emit('error',error||new Error('Aborted fixture request')));return request};const name=String(url),item=map[name];globalThis.installedUpdateTransport.requests.push(name);fs.appendFileSync(logFile,name+'\n',{mode:0o600});queueMicrotask(()=>{
  if(!item){request.emit('error',new Error('Unexpected URL in isolated fixture: '+name));return;}
  const body=item.file?null:Buffer.from(item.base64,'base64'),response=item.file?fs.createReadStream(item.file):Readable.from(body);response.statusCode=200;response.headers={'content-length':String(item.file?item.size:body.length)};callback(response);
 });return request;};
 },{map,logFile:path.join(output,`transport-${stage}.jsonl`)});}
async function updates(){await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();await page.locator('.settings-section-menu').getByRole('button',{name:'자동 확인',exact:true}).click();await expect(settings()).toBeVisible();await settings().locator('.update-version-row').scrollIntoViewIfNeeded();}
try{
 await launch();await transport('old');
 const oldAppInfo=await ipc('app.info');assert.equal(oldAppInfo.version,oldRecord.build.version);
 const group=await ipc('group.save',{name:'Migration QA group'}),projectFolder=path.join(temp,'project-files');await fs.mkdir(projectFolder);
 const project=await ipc('project.save',{groupId:group.id,name:'Migration preservation project',connection:{kind:'local',rootPath:projectFolder}});
 const review=await ipc('review.save',{projectId:project.id,title:'Preserved review after development update',body:'Original review body retained across native update.'});
 const sentinel=path.join(dataPath,'preserved-user-data.txt');await fs.writeFile(sentinel,'synthetic preservation sentinel');
 await updates();await settings().locator('summary').click();await settings().locator('.update-build-list').scrollIntoViewIfNeeded();await photo('01-authentic-legacy-installed.png');
 pass('QA-041-NATIVE-001','Verified authentic public11001 ZIP/source ASAR copied unchanged; isolated app started and synthetic project/review seeded.');
 await settings().getByRole('button',{name:'업데이트 확인',exact:true}).click();await expect(settings().getByRole('button',{name:'업데이트 설치',exact:true})).toBeEnabled();await settings().locator('.update-build-list').scrollIntoViewIfNeeded();await photo('02-legacy-sees-local-candidate.png');
 const oldState=await ipc('update.state');assert.equal(oldState.availableBuild.buildNumber,newInfo.buildNumber);assert.equal(oldState.availableBuild.developmentNumber,undefined);assert.equal(await hash(archive),oldAsarHash);
 const before=await ipc('snapshot');
 const close=app.waitForEvent('close',{timeout:120000});await settings().getByRole('button',{name:'업데이트 설치',exact:true}).click().catch(error=>{if(!/closed|destroyed/i.test(error.message))throw error;});
 const pending=await poll(async()=>{try{return JSON.parse(await fs.readFile(path.join(dataPath,'updates/pending.json'),'utf8'))}catch{return null}});assert.equal(pending.build.developmentNumber,undefined);await close;
 const result=await poll(async()=>{try{return (await fs.readFile(path.join(pending.job,'result'),'utf8')).trim()}catch{return null}});
 assert.equal(result,'installed',await fs.readFile(path.join(pending.job,'install.log'),'utf8'));assert.equal(await fs.readFile(path.join(pending.job,'healthy'),'utf8'),newInfo.version);
 launchedPid=Number(await fs.readFile(path.join(pending.job,'launched.pid'),'utf8'));await wait(1500);
 assert.ok((await run('/bin/ps',['-p',String(launchedPid),'-o','command='])).stdout.includes(target));process.kill(launchedPid,'SIGTERM');await wait(1000);launchedPid=null;
 pass('QA-041-NATIVE-002','Actual legacy update checked fixture endpoint, streamed real ZIP/hash verification, replaced copied app after quit, launched new binary and received production health ACK.');
 asar.uncache(archive);assert.deepEqual(JSON.parse(asar.extractFile(archive,'electron/reviewops-build.json')),newInfo);await run('/usr/bin/codesign',['--verify','--deep','--strict',target]);
 await launch();await transport('new');const actual=await ipc('app.info');assert.equal(actual.build.developmentNumber,1);assert.equal(actual.build.commit,newInfo.commit);assert.equal(actual.build.buildNumber,newInfo.buildNumber);
 await page.locator('.sidebar-bottom').getByRole('button',{name:'설정',exact:true}).click();await page.locator('.settings-section-menu').getByRole('button',{name:'일반',exact:true}).click();await expect(page.locator('.app-version')).toContainText(`${newInfo.version}-dev-1`);await photo('03-new-native-app-version.png');
 const after=await ipc('snapshot');for(const [kind,id]of[['groups',group.id],['projects',project.id],['reviews',review.id]])assert.deepEqual(after[kind].find(item=>item.id===id),before[kind].find(item=>item.id===id));assert.equal(await fs.readFile(sentinel,'utf8'),'synthetic preservation sentinel');
 pass('QA-041-NATIVE-003','Restarted installed copied new app reports dev1/exact SHA; persisted project/review IDs and all stored fields plus sentinel remain equal.');
 await updates();await settings().getByRole('button',{name:'업데이트 확인',exact:true}).click();await expect(settings().getByRole('status')).toHaveText('설치된 테스트 버전이 최신입니다.');await expect(settings().locator('.update-version-row')).toContainText(`${newInfo.version}-dev-1`);
 if(!await settings().locator('details').getAttribute('open'))await settings().locator('summary').click();await settings().getByRole('button',{name:'버전 정보 복사',exact:true}).click();const copied=await app.evaluate(({clipboard})=>clipboard.readText());assert.ok(copied.includes(`${newInfo.version}-dev-1`));assert.ok(copied.includes(newInfo.commit));await photo('04-new-current-and-copy.png');
 const newState=await ipc('update.state');assert.equal(newState.testUpdates,true);assert.equal(newState.automatic,false);assert.equal(newState.availableVersion,null);assert.equal(newState.errorCode,'');
 pass('QA-041-NATIVE-004','New app reads legacy highest/pending state, checks same local candidate as current, copies dev1/SHA and preserves test channel/automatic-off preference.');
 await page.locator('.main-nav').getByRole('button',{name:'홈',exact:true}).click();await page.locator('.work-home-tree-review').filter({hasText:review.title}).click();await expect(page.getByText(review.body,{exact:true})).toBeVisible();await photo('05-preserved-review.png');
 assert.deepEqual(rendererErrors,[]);
 const oldRequests=(await fs.readFile(path.join(output,'transport-old.jsonl'),'utf8')).trim().split('\n');assert.ok(oldRequests.includes(releaseRoot+legacyName));
 const record={ok:true,old:{...oldRecord,zip:oldZip,asarSha256:oldAsarHash},new:{build:newInfo,zip:newZip,size:newSize,sha256:newHash,installedAsarSha256:await hash(archive)},checks,photos,oldRequests,newRequests:await app.evaluate(()=>globalThis.installedUpdateTransport.requests),temp,dataPath,target,pending,pendingResult:result,rendererErrors,limitations:['macOS Intel only','actual old public11001 package; new package is unpublished local QA fixture global'+newInfo.buildNumber,'GitHub HTTPS request transport intercepted in main memory; actual ZIP bytes, updater, signature checks, replacement, binary startup, health ACK and persisted data are real','not a live public update check/download; no Release or canonical source ASAR modified','historical public8001 bytes unavailable; its parser is covered by separate contracts']};await fs.writeFile(path.join(output,'results.json'),JSON.stringify(record,null,2));console.log(JSON.stringify({ok:true,output,checks:checks.length}));
}catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,temp,target,newInfo,oldRecord},null,2));throw error;}
finally{await app?.close().catch(()=>{});if(launchedPid)try{process.kill(launchedPid,'SIGTERM')}catch{}}
