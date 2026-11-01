import {setTestLocale} from './test-locale.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{invokeSocket}=require('../electron/mcp-server.cjs');
const root=process.cwd(),temporary=fs.mkdtempSync('/tmp/rops-qa-scope-'),home=path.join(temporary,'home'),data=path.join(temporary,'data'),files=path.join(temporary,'files'),work=path.join(temporary,'work'),outside=path.join(temporary,'outside'),sshConfig=path.join(home,'.ssh/config'),results=path.join(root,'test-results/qa-project-scope');
fs.mkdirSync(path.dirname(sshConfig),{recursive:true});fs.mkdirSync(files);fs.mkdirSync(work);fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(work,'other'));fs.mkdirSync(results,{recursive:true});fs.writeFileSync(sshConfig,'# Synthetic project QA scope fixture\n',{mode:0o600});
let app,main,a;const errors=[],checks=[],requests=[];
const ipc=(page,action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const passed=name=>{checks.push(name);console.log('PASS: '+name)};
const qa=async(action,payload)=>{requests.push({action,payload});const result=await invokeSocket(path.join(data,'integrations/tools.json'),'automation.qa.'+action,payload);requests.push({response:result.mimeType?{mimeType:result.mimeType,width:result.width,height:result.height}:result});return result;};
const center=element=>({x:element.rect.x+element.rect.width/2,y:element.rect.y+element.rect.height/2});
async function click(target,name,{role}={}){
 let element;await expect.poll(async()=>{const state=await qa('state',target);element=state.elements.find(item=>(item.label===name||item.text.trim()===name)&&(!role||item.role===role));return Boolean(element);},{message:'Missing visible QA element '+name}).toBe(true);await qa('click',{...target,...center(element)});
}
try{
 const env={...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),REVIEWOPS_DATA_DIR:data,REVIEWOPS_CODEX_SSH_CONFIG:sshConfig};for(const name of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});main=await app.firstWindow();await setTestLocale(main);main.on('pageerror',error=>errors.push(error.message));
 const ga=await ipc(main,'group.save',{name:'프로젝트 A 그룹'}),gb=await ipc(main,'group.save',{name:'프로젝트 B 그룹'});
 const sa=await ipc(main,'service.save',{groupId:ga.id,name:'A 로컬 폴더',kind:'local',rootPath:files,agentWorkPath:work,agentEnabled:false}),sb=await ipc(main,'service.save',{groupId:gb.id,name:'B 로컬 폴더',kind:'local',rootPath:files,agentEnabled:false});
 const pa=await ipc(main,'project.save',{groupId:ga.id,name:'범위 검사 A',serviceIds:[sa.id]}),pb=await ipc(main,'project.save',{groupId:gb.id,name:'변경하지 않을 B',serviceIds:[sb.id]});
 await ipc(main,'review.save',{projectId:pa.id,serviceId:sa.id,title:'A 기존 리뷰'});const rb=await ipc(main,'review.save',{projectId:pb.id,serviceId:sb.id,title:'B 보존 리뷰',body:'보존할 B 본문'});
 await ipc(main,'window.openProject',{projectId:pa.id});
 await expect.poll(()=>app.windows().filter(page=>new URL(page.url()).searchParams.get('projectId')===pa.id).length).toBe(1);a=app.windows().find(page=>new URL(page.url()).searchParams.get('projectId')===pa.id);a.on('pageerror',error=>errors.push(error.message));
 await expect(a.getByRole('heading',{name:pa.name,exact:true})).toBeVisible();
 await a.locator('.main-nav').getByRole('button',{name:'그룹',exact:true}).click();await a.getByRole('button',{name:`그룹 열기: ${gb.name}`,exact:true}).click();await a.locator('.resource-tabs:visible').getByRole('button',{name:'설정',exact:true}).click();
 await a.getByLabel('그룹명',{exact:true}).fill('QA 전부터 보관한 그룹 초안');
 const binding=await qa('open',{projectId:pa.id,clientId:'scope-regression'}),target={sessionId:binding.sessionId,projectId:binding.projectId,windowId:binding.windowId};
 await expect(a.locator('.workspace-app')).toHaveAttribute('data-qa-project-id',pa.id);
 for(const name of ['그룹','계정관리','호스트관리'])await expect(a.locator('.main-nav').getByRole('button',{name,exact:true})).toHaveCount(0);
 await expect(a.getByRole('button',{name:'프로젝트 창 열기',exact:true})).toHaveCount(0);await expect(a.getByRole('tab',{name:gb.name,exact:true})).toHaveCount(0);
 const state=await qa('state',target);assert.ok(!state.text.includes(gb.name));assert.ok(!state.text.includes(pb.name));
 await a.screenshot({path:path.join(results,'01-scoped-project.png')});passed('QA 활성 창에서 다른 그룹·프로젝트·전역 관리·이전 전역 탭 숨김');
 const attempts=[['group.save',{id:gb.id,name:'변경되면 안 됨'}],['group.delete',{id:gb.id}],['project.save',{id:pb.id,name:'변경되면 안 됨'}],['review.save',{id:rb.id,body:'변경되면 안 됨'}],['files.list',{serviceId:sb.id}],['window.openProject',{projectId:pb.id}],['settings.save',{theme:'dark'}]];
 for(const [action,payload]of attempts){const result=await a.evaluate(({action,payload})=>window.reviewops.request(action,payload),{action,payload});assert.equal(result.ok,false,action);assert.equal(result.error.code,'TARGET_MISMATCH',action);console.log('DENIED: '+action+' '+result.error.code);}
 for(const manager of ['accountManager','hostManager'])assert.match(await a.evaluate(async name=>{try{await window[name].getState();return 'unexpected success'}catch(error){return error.message}},manager),/프로젝트 QA 연결 중에는 전체 계정·호스트/);
 assert.equal((await ipc(a,'snapshot')).projects.length,1);passed('외부 ID를 아는 요청도 main IPC에서 차단하고 계정·호스트 IPC 거절');
 await click(target,'홈');await expect(a.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
 await a.getByRole('tab',{name:'홈',exact:true}).focus();await qa('key',{...target,key:'End'});await expect(a.getByRole('tab',{name:pa.name,exact:true})).toHaveAttribute('aria-selected','true');
 await click(target,'홈');await click(target,'리뷰 제목·분류 검색');await qa('type',{...target,text:'범위 검사'});await expect(a.getByRole('searchbox',{name:'리뷰 제목·분류 검색',exact:true})).toHaveValue('범위 검사');
 await qa('key',{...target,key:'A',modifiers:[process.platform==='darwin'?'Meta':'Control']});await qa('key',{...target,key:'Backspace'});
 await click(target,`${pa.name} 프로젝트 열기`);await expect(a.getByRole('button',{name:'새 리뷰',exact:true})).toBeVisible();
 await click(target,'새 리뷰');await expect(a.locator('.original-review-form.is-create:visible')).toBeVisible();await click(target,'제목');await qa('type',{...target,text:'QA에서 A에만 추가한 리뷰'});
 await qa('scroll',{...target,x:1300,y:760,deltaY:900});
 await click(target,'등록');await expect.poll(async()=>(await ipc(main,'snapshot')).reviews.filter(item=>item.projectId===pa.id).length).toBe(2);
 const snapshot=await ipc(main,'snapshot');assert.equal(snapshot.groups.find(item=>item.id===gb.id).name,gb.name);assert.equal(snapshot.projects.find(item=>item.id===pb.id).name,pb.name);assert.equal(snapshot.reviews.find(item=>item.id===rb.id).body,'보존할 B 본문');
 await a.screenshot({path:path.join(results,'02-own-project-review.png')});passed('qa_click/type/key와 키보드 탭 이동은 A에만 적용되고 A 리뷰 등록 및 B 자료 보존');
 await a.locator('.original-project-nav:visible').getByRole('button',{name:'설정',exact:true}).click();
 await a.getByRole('tab',{name:'에이전트',exact:true}).click();const agentSettings=a.locator('.agent-settings-fields:visible');await expect(agentSettings).toBeVisible();
 for(const name of ['Codex 로그인','Codex 로그아웃','로그인 중지'])await expect(agentSettings.getByRole('button',{name,exact:true})).toHaveCount(0);
 await expect(agentSettings.getByText('공유 Codex 로그인·로그아웃은 QA 연결을 해제하거나 기본 창에서 관리하십시오.',{exact:true})).toBeVisible();
 await ipc(a,'agent.models',{serviceId:sa.id});await expect(agentSettings.getByRole('alert')).toHaveCount(0);await expect(agentSettings.getByRole('button',{name:'실행 환경 검사',exact:true})).toBeEnabled();
 for(const folder of [files,work]){assert.equal((await ipc(a,'directory.inspect',{path:folder})).status,'ready');await ipc(a,'directory.create',{parent:folder,name:'qa-child'});assert.ok(fs.statSync(path.join(folder,'qa-child')).isDirectory());}
 for(const folder of [outside,path.join(work,'other'),path.join(work,'other','missing')]){const result=await a.evaluate(payload=>window.reviewops.request('directory.create',payload),{parent:folder,name:'blocked'});assert.equal(result.error.code,'TARGET_MISMATCH');}
 assert.deepEqual(fs.readdirSync(outside),[]);await agentSettings.getByRole('button',{name:'실행 환경 검사',exact:true}).scrollIntoViewIfNeeded();await a.screenshot({path:path.join(results,'04-scoped-agent-settings.png')});passed('QA 에이전트 설정은 공유 로그인 조작 없이 정상 표시되고 별도 작업 폴더만 허용');
 await main.locator('.main-nav').getByRole('button',{name:'그룹',exact:true}).click();await expect(main.getByRole('button',{name:`그룹 열기: ${gb.name}`,exact:true})).toBeVisible();passed('기본 앱 창의 전역 그룹 탐색은 QA와 함께 유지');
 await qa('release',target);await expect(a.locator('.workspace-app')).toHaveAttribute('data-qa-project-id','');
 await expect(a.locator('.main-nav').getByRole('button',{name:'그룹',exact:true})).toBeVisible();await a.getByRole('tab',{name:gb.name,exact:true}).click();await expect(a.getByLabel('그룹명',{exact:true})).toHaveValue('QA 전부터 보관한 그룹 초안');
 await a.screenshot({path:path.join(results,'03-released-user-draft.png')});passed('QA 해제 뒤 기존 전역 메뉴·탭·저장하지 않은 사용자 초안 복원');
 await a.getByLabel('그룹명',{exact:true}).fill(gb.name);await expect.poll(()=>a.evaluate(()=>document.documentElement.dataset.reviewopsDirty)).toBe('false');
 await qa('open',{projectId:pa.id,clientId:'delete-scope-regression'});await ipc(a,'project.delete',{id:pa.id});
 const empty=await ipc(a,'snapshot');assert.deepEqual(empty.projects,[]);await ipc(a,'window.context');await ipc(a,'window.state');
 await expect(a.locator('.workspace-app')).toHaveAttribute('data-qa-project-id',pa.id);await expect(a.getByRole('tab',{name:gb.name,exact:true})).toHaveCount(0);
 await expect(a.locator('.original-project:visible')).toHaveCount(0); await a.screenshot({path:path.join(results,'05-deleted-project.png')});await ipc(a,'window.close');await expect.poll(()=>a.isClosed()).toBe(true);assert.ok(!main.isClosed());passed('QA에서 자기 프로젝트 삭제 뒤 빈 범위를 유지하고 창 닫기 가능');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(results,'result.json'),JSON.stringify({passed:true,checks,errors,source:process.env.REVIEWOPS_TEST_EXECUTABLE||'source Electron',platform:process.platform,arch:process.arch},null,2)+'\n');
}catch(error){if(a)await a.screenshot({path:path.join(results,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(results,'result.json'),JSON.stringify({passed:false,checks,errors,message:error.message},null,2)+'\n');throw error;}
finally{fs.writeFileSync(path.join(results,'qa-requests.json'),JSON.stringify(requests,null,2)+'\n');if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}fs.rmSync(temporary,{recursive:true,force:true});}
