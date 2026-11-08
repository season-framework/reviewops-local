import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {setTestLocale} from './test-locale.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {createOpsUiAdmission} from './ops-ui-admission.mjs';
import {comparePackagedElectronTree} from './packaged-source-policy.mjs';

const root=process.cwd(),args=process.argv.slice(2),mode=args.includes('--before')?'before':'after';
assert.ok(args.every(x=>['--before','--after','--reproduce-only','--extended','--dynamic-only'].includes(x)));
assert.ok(!(args.includes('--before')&&args.includes('--after')));
const reproduceOnly=args.includes('--reproduce-only');assert.ok(!reproduceOnly||mode==='before');
const extended=args.includes('--extended'),dynamicOnly=args.includes('--dynamic-only');assert.ok(!dynamicOnly||mode==='after'&&!reproduceOnly);
const output=process.env.REVIEWOPS_NAV_OUTPUT||path.join(root,'test-results/navigation-layout',new Date().toISOString().replace(/[:.]/g,'-'));
assert.ok(path.isAbsolute(output)&&!fs.existsSync(output),'Use a fresh absolute output directory.');fs.mkdirSync(output,{recursive:true});
const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-navigation-'))),dataPath=path.join(temporary,'data'),home=path.join(temporary,'home'),work=path.join(temporary,'work'),ssh=path.join(temporary,'ssh-config');
for(const directory of [dataPath,home,work,path.join(dataPath,'updates')])fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(ssh,'# Owned layout fixture; no SSH connections\n');fs.writeFileSync(path.join(work,'navigation.md'),'# Navigation fixture\nNo model or external service is used.\n');fs.writeFileSync(path.join(dataPath,'updates/settings.json'),JSON.stringify({automatic:false,intervalMinutes:10}));
const env={...process.env,...isolatedModelRuntime({home,dataPath}),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:ssh,REVIEWOPS_CODEX_SSH_CONFIG:ssh};
for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','REVIEWOPS_DEV_URL','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY','CHATGPT_ACCESS_TOKEN','ANTHROPIC_API_KEY'])delete env[key];
const hash=b=>createHash('sha256').update(b).digest('hex'),fileHash=p=>hash(fs.readFileSync(p));
function tree(directory){const rows=[];function visit(base){for(const e of fs.readdirSync(base,{withFileTypes:true})){const p=path.join(base,e.name);assert.equal(e.isSymbolicLink(),false);if(e.isDirectory())visit(p);else if(e.isFile())rows.push({path:path.relative(directory,p),sha256:fileHash(p)});}}visit(directory);return rows.sort((a,b)=>a.path.localeCompare(b.path));}
const rendererBefore=env.REVIEWOPS_TEST_EXECUTABLE?null:tree(path.join(root,'dist'));
let files,packagedTree;
if(env.REVIEWOPS_TEST_EXECUTABLE){const build=JSON.parse(fs.readFileSync(env.REVIEWOPS_EXPECTED_BUILD_INFO,'utf8')),require=createRequire(path.join(root,'package.json')),asar=require('@electron/asar'),archive=path.resolve(path.dirname(env.REVIEWOPS_TEST_EXECUTABLE),'../Resources/app.asar'),sourceFiles=execFileSync('git',['ls-tree','-rz','--name-only',build.commit,'--','electron'],{cwd:root}).toString().split('\0').filter(Boolean);packagedTree=comparePackagedElectronTree(archive,{asar,sourceFiles,readSource:name=>execFileSync('git',['show',build.commit+':'+name],{cwd:root,maxBuffer:32*1024**2})});files=packagedTree.source.map(x=>x.path);}
const admission=await createOpsUiAdmission({sourceRoot:root,env,...(files?{files}:{})});
const english=JSON.parse(fs.readFileSync(path.join(root,'src/i18n/en.json'),'utf8'));let locale='ko';
const tr=(key,...values)=>{let text=locale==='en'?(english[key]||key):key;values.forEach((v,i)=>text=text.replaceAll('{'+i+'}',String(v)));return text;};
const measurements=[],violations=[],checks=[],photos=[],errors=[];let app,page,original,closePromise,exit=null,closed=null,cleanup=false,failure;
const result={ok:false,mode,reproduceOnly,extended,dynamicOnly,driverSHA256:hash(fs.readFileSync(new URL(import.meta.url))),source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),output,temporary,admission:admission.record,packagedTree,rendererBefore,measurements,violations,checks,photos,errors,scope:'Actual Electron layout with private synthetic local data and model-list fixture. No genuine model, SSH or external request. Before is reproduction evidence, not a product pass.'};
const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const pane=()=>page.locator('.workspace-pane:not([hidden])');
const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function photo(name){const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:false});const b=fs.readFileSync(file);photos.push({file,width:b.readUInt32BE(16),height:b.readUInt32BE(20),sha256:hash(b),scope:'Original whole app host content; OS decoration excluded; no crop/edit.'});}
async function measure(locator,id,finite=true){await expect(locator).toBeVisible();await frames();const value=await locator.evaluate(node=>{const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};const style=getComputedStyle(node);return {bar:rect(node),parent:rect(node.parentElement),header:node.closest('header')?rect(node.closest('header')):null,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,overflowX:style.overflowX,maxWidth:style.maxWidth,flex:style.flex,wrap:style.flexWrap,viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,buttons:[...node.querySelectorAll('button')].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent.trim(),...rect(e)}))};});const problems=[];if(finite){if(value.scrollWidth>value.clientWidth+1)problems.push('finite tabs overflow');for(const b of value.buttons){if(b.x<value.bar.x-1||b.right>value.bar.right+1||b.y<value.bar.y-1||b.bottom>value.bar.bottom+1)problems.push('button outside strip: '+b.text);if(value.header&&(b.x<value.header.x-1||b.right>value.header.right+1||b.y<value.header.y-1||b.bottom>value.header.bottom+1))problems.push('button outside header: '+b.text);}if(value.documentWidth>value.viewport+1)problems.push('document overflow');}const row={id,locale,...value,problems};measurements.push(row);if(problems.length)violations.push(row);save();return row;}
async function keyboard(strip){const buttons=strip.locator('button');await buttons.first().focus();await page.keyboard.press('End');await expect(buttons.last()).toBeFocused();await page.keyboard.press('Home');await expect(buttons.first()).toBeFocused();const first=buttons.first();assert.ok(['true','page'].includes(await first.getAttribute('aria-pressed'))||['true','page'].includes(await first.getAttribute('aria-selected'))||await first.getAttribute('aria-current')==='page');}
async function sidebar(expanded){const current=await page.locator('.workspace-app').evaluate(n=>n.classList.contains('sidebar-expanded'));if(current!==expanded)await page.locator('.sidebar-bottom').getByRole('button',{name:tr(expanded?'메뉴 펼치기':'메뉴 접기'),exact:true}).click();}
async function resize(width){const window=await app.browserWindow(page);await window.evaluate((w,width)=>w.setSize(width,1000),width);await frames();}
async function homeTab(){await page.locator('.workspace-tab[data-tab-id="home"] .workspace-tab-select').click();await expect(pane().locator('.work-home')).toBeVisible();}
let group,projects,activeDraft;
async function openProject(index=0){await homeTab();await pane().getByRole('button',{name:tr('{0} 프로젝트 열기',projects[index].name),exact:true}).click();await expect(pane().locator('.original-project')).toHaveAttribute('data-project-id',projects[index].id);}
async function core(width,expanded,{capture=false,prefix=''}={}){await resize(width);await sidebar(expanded);await openProject();await projectFeature('review');const id=`${prefix}${locale}-${width}-${expanded?'expanded':'collapsed'}`;await measure(pane().locator('.original-project-nav'),id+'-project');if(capture)await photo(id+'-project');await keyboard(pane().locator('.original-project-nav'));await pane().locator('.original-project-back').click();await expect(pane().locator('.resource-content')).toHaveAttribute('data-ops-group-id',group.id);await measure(pane().locator('.group-resource-header .resource-tabs'),id+'-group');if(capture)await photo(id+'-group');await keyboard(pane().locator('.group-resource-header .resource-tabs'));checks.push({id:id+'-primary-navigation',kind:'fixed project/group tabs'});save();}
async function projectFeature(key){await pane().locator('.original-project-nav').getByRole('button',{name:tr({review:'리뷰',settings:'설정',file:'파일'}[key]),exact:true}).click();await expect(pane().locator('.original-project')).toHaveAttribute('data-section',key);}
async function extraBars(width,expanded,{capture=false,prefix=''}={}){
 await openProject();await projectFeature('settings');const id=`${prefix}${locale}-${width}-${expanded?'expanded':'collapsed'}`;
 const settings=pane().locator('.original-kept-panel:not([hidden]) .original-project-settings'),tabs=settings.locator('.original-project-settings-tabs');
 await keyboard(tabs);await measure(tabs,id+'-project-settings');if(capture)await photo(id+'-project-settings');
 const description=settings.getByRole('textbox',{name:tr('설명'),exact:true}),marker='UNSAVED_NAVIGATION_'+locale,originalDescription=await description.inputValue();activeDraft={originalDescription};await description.fill(marker);
 await projectFeature('file');const content=pane().locator('.original-kept-panel:not([hidden])');
 const fileTabs=content.locator('.original-file-view-tabs');if(!await fileTabs.isVisible()){const load=content.locator('.file-browser-header').getByRole('button',{name:tr('파일 불러오기'),exact:true});if(await load.isVisible())await load.click();const row=content.locator('.file-table tbody tr').filter({hasText:'navigation.md'});await expect(row).toBeVisible();await row.click();}
 await expect(fileTabs).toBeVisible();await measure(fileTabs,id+'-file-mode');await keyboard(fileTabs);if(capture)await photo(id+'-file-mode');
 await projectFeature('settings');await keyboard(tabs);await expect(description).toHaveValue(marker);await description.fill(originalDescription);await frames();activeDraft=null;
 checks.push({id:id+'-settings-file',kind:'project settings/file tabs and unsaved settings draft keepalive'});save();
}
async function testDynamicTabs({page,projects,openProject,openHome,photo,measure,pass}) {
  void measure;
  assert.equal(projects.length,12,'This scenario uses exactly12 distinct projects.');
  assert.equal(new Set(projects.map(project=>project.id)).size,12);
  assert.equal(new Set(projects.map(project=>project.name)).size,12,'Exact accessible labels must be unique.');
  const strip=page.locator('.workspace-tab-list');
  const tabs=()=>strip.locator('.workspace-tab-select[role="tab"]');
  const namedTab=name=>strip.getByRole('tab',{name,exact:true});
  const byId=id=>page.locator(`[id=${JSON.stringify(id)}]`);
  const associatedPane=async tab=>{
    const paneId=await tab.getAttribute('aria-controls');
    assert.ok(paneId,'The real selected tab must identify its existing pane.');
    const pane=byId(paneId);
    await expect(pane).toHaveCount(1);
    await expect(pane).toHaveAttribute('role','tabpanel');
    await expect(pane).toHaveAttribute('aria-labelledby',await tab.getAttribute('id'));
    return {paneId,pane};
  };
  const assertSelected=async(row,{full=true}={})=>{
    const tab=byId(row.id);
    await expect(tab).toHaveAttribute('aria-selected','true');
    await expect(tab).toBeFocused();
    const {pane}=await associatedPane(tab);
    await expect(pane).toBeVisible();
    await expect(page.locator('.workspace-pane:not([hidden])')).toHaveCount(1);
    const project=projects.find(project=>project.name===row.name);
    if(project)await expect(pane.locator('.original-project')).toHaveAttribute('data-project-id',project.id);
    const position=await tab.evaluate(node=>{
      const list=node.closest('.workspace-tab-list'),a=node.getBoundingClientRect(),b=list.getBoundingClientRect();
      const wrapper=node.closest('.workspace-tab'),w=wrapper.getBoundingClientRect(),close=wrapper.querySelector('.tab-close'),c=close?.getBoundingClientRect();return {left:a.left,right:a.right,listLeft:b.left,listRight:b.right,scrollLeft:list.scrollLeft,wrapper:{left:w.left,right:w.right},close:c?{left:c.left,right:c.right}:null};
    });
    if(full)assert.ok(position.left>=position.listLeft-1&&position.right<=position.listRight+1,'Home/End reveal the selected label inside its scrollport.');else assert.ok(position.right>position.listLeft&&position.left<position.listRight,'Arrow focus retains visible intersection in its existing scrollport.');
    return position;
  };
  let firstTab,firstPane,firstPaneId,description,originalDescription,descriptionNode,paneNode;
  const observation={projects:projects.map(({id,name})=>({id,name})),keyboard:[],draft:{restored:false},arrowDiagnostics:[]};result.dynamic=observation;
  try {
    await openProject(0);
    firstTab=namedTab(projects[0].name);
    await expect(firstTab).toHaveCount(1);
    await expect(firstTab).toHaveAttribute('aria-selected','true');
    ({pane:firstPane,paneId:firstPaneId}=await associatedPane(firstTab));
    await expect(firstPane.locator('.original-project')).toHaveAttribute('data-project-id',projects[0].id);
    await firstPane.locator('.original-project-nav').getByRole('button',{name:'설정',exact:true}).click();
    const settings=firstPane.locator('.original-project-settings');
    await expect(settings).toBeVisible();
    await settings.locator('.original-project-settings-tabs').getByRole('tab',{name:'프로젝트 정보',exact:true}).click();
    description=settings.getByRole('textbox',{name:'설명',exact:true});
    originalDescription=await description.inputValue();
    const draft=`${originalDescription}\nOwned dynamic workspace keepalive ${Date.now()}`;
    await description.fill(draft);
    await expect(description).toHaveValue(draft);
    descriptionNode=await description.elementHandle();paneNode=await firstPane.elementHandle();
    assert.ok(descriptionNode&&paneNode);
    observation.draft={projectId:projects[0].id,paneId:firstPaneId,original:originalDescription,draft,restored:false};

    for(let index=1;index<projects.length;index++) {
      await openProject(index);
      const tab=namedTab(projects[index].name);
      await expect(tab).toHaveCount(1);
      await expect(tab).toHaveAttribute('aria-selected','true');
      const {pane}=await associatedPane(tab);
      await expect(pane.locator('.original-project')).toHaveAttribute('data-project-id',projects[index].id);
    }
    for(const project of projects)await expect(namedTab(project.name)).toHaveCount(1);
    await expect(firstPane).toBeHidden();
    assert.equal(await descriptionNode.evaluate(node=>node.isConnected),true,'Hidden original draft textarea stays mounted.');
    assert.equal(await descriptionNode.evaluate(node=>node.value),draft,'Hidden original draft remains exact.');

    observation.geometry=await strip.evaluate(list=>{
      const box=list.getBoundingClientRect(),style=getComputedStyle(list);
      return {clientWidth:list.clientWidth,scrollWidth:list.scrollWidth,scrollLeft:list.scrollLeft,overflowX:style.overflowX,flexWrap:style.flexWrap,box:{left:box.left,right:box.right,width:box.width},viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
        tabs:[...list.querySelectorAll('.workspace-tab')].map(node=>{const rect=node.getBoundingClientRect(),css=getComputedStyle(node),button=node.querySelector('.workspace-tab-select'),label=node.querySelector('.tab-title');return {name:button.getAttribute('aria-label'),id:button.id,paneId:button.getAttribute('aria-controls'),width:rect.width,top:rect.top,flexBasis:css.flexBasis,flexShrink:css.flexShrink,label:label.textContent,labelClientWidth:label.clientWidth,labelScrollWidth:label.scrollWidth,labelOverflow:getComputedStyle(label).textOverflow};})};
    });
    const geometry=observation.geometry;
    assert.ok(geometry.scrollWidth>geometry.clientWidth+8,'Twelve192px tabs genuinely exceed the real available strip.');
    assert.ok(['auto','scroll'].includes(geometry.overflowX),'The dynamic tabstrip retains usable horizontal overflow.');
    assert.equal(geometry.flexWrap,'nowrap','Dynamic workspace tabs retain one scrollable row.');
    assert.ok(geometry.documentWidth<=geometry.viewport+1,'Overflow stays inside the tabstrip rather than widening the document.');
    for(const project of projects) {
      const row=geometry.tabs.find(row=>row.name===project.name);
      assert.ok(row);assert.ok(Math.abs(row.width-192)<=.5,project.name+' retains192px outer tab width.');
      assert.equal(row.flexShrink,'0');assert.equal(row.label,project.name);assert.ok(row.labelClientWidth>0);assert.equal(row.labelOverflow,'ellipsis');
    }
    const top=geometry.tabs[0].top;
    assert.ok(geometry.tabs.every(row=>Math.abs(row.top-top)<=1),'All real dynamic tabs remain on the same row.');
    await photo('dynamic-workspace-12-tabs-end');

    // Use actual DOM order, never infer a tab ID from a project ID. Earlier
    // independent scenarios may legitimately have left Group/Settings tabs.
    const order=await tabs().evaluateAll(nodes=>nodes.map(node=>({id:node.id,name:node.getAttribute('aria-label'),paneId:node.getAttribute('aria-controls')})));
    assert.ok(order.length>=13);
    const first=order[0],last=order.at(-1),beforeLast=order.at(-2);
    assert.equal(first.name,'홈','The existing fixed Home tab remains first.');
    const press=async(key,expected)=>{
      const selected=strip.locator('.workspace-tab-select[aria-selected="true"]');
      await expect(selected).toHaveCount(1);await selected.focus();await selected.press(key);
      const position=await assertSelected(expected);observation.keyboard.push({key,selected:expected,...position});
    };
    await press('Home',first);await press('End',last);
    // Arrow visibility is recorded without introducing a full-label contract
    // absent from the existing workspace-tab regression. Focus/pane selection
    // remains asserted; Home/End still require full visible label bounds.
    for(const [key,expected] of [['ArrowLeft',beforeLast],['ArrowRight',last]]){
      const selected=strip.locator('.workspace-tab-select[aria-selected="true"]');await selected.focus();await selected.press(key);
      const position=await assertSelected(expected,{full:false});observation.arrowDiagnostics.push({key,selected:expected,...position,labelFullyVisible:position.left>=position.listLeft-1&&position.right<=position.listRight+1});
    }
    assert.ok(observation.keyboard.find(row=>row.key==='End').scrollLeft>observation.keyboard.find(row=>row.key==='Home').scrollLeft,'Home/End reveal opposite ends of the genuinely overflowing list.');

    const closing=byId(last.id),closingWrapper=closing.locator('..');
    await closingWrapper.locator('.tab-close').click();await expect(byId(last.id)).toHaveCount(0);await expect(namedTab('홈')).toHaveCount(1);assert.equal(await tabs().count(),order.length-1);
    observation.close={name:last.name,id:last.id,remainingTabs:order.length-1,fixedHomeRetained:true};
    await openHome();
    await expect(namedTab('홈')).toHaveAttribute('aria-selected','true');
    await expect(firstPane).toBeHidden();
    assert.equal(await paneNode.evaluate((node,id)=>node.isConnected&&document.getElementById(id)===node,firstPaneId),true,'The original keyed pane is preserved across all navigation.');
    await firstTab.click();
    await expect(firstTab).toHaveAttribute('aria-selected','true');
    await expect(firstPane).toBeVisible();await expect(description).toBeVisible();await expect(description).toHaveValue(draft);
    assert.equal(await descriptionNode.evaluate(node=>node.isConnected&&node.value),draft,'The same original textarea retains the unsaved draft.');
    await photo('dynamic-workspace-original-draft-retained');
    observation.draft.paneNodePreserved=true;observation.draft.textareaNodePreserved=true;observation.draft.valuePreserved=true;
  } catch(error) {
    await photo('dynamic-workspace-failure').catch(()=>{});
    throw error;
  } finally {
    // Undo only this owned fixture's unsaved text through its actual UI. Never
    // save it, change persisted records, close another tab or use app.exit().
    if(description&&originalDescription!==undefined&&firstTab) {
      await firstTab.click();await expect(description).toBeVisible();await description.fill(originalDescription);await expect(description).toHaveValue(originalDescription);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      observation.draft.restored=true;
    }
    await descriptionNode?.dispose();await paneNode?.dispose();
  }
  assert.equal(observation.draft.restored,true);
  pass('NAV-DYNAMIC-001','Twelve real192px workspace tabs overflow only their own strip; Home/End select the associated panes; close retains fixed Home and preserve the original unsaved project draft.');
  return observation;
}

try{
 app=await electron.launch({...admission.launchOptions,env,timeout:30000});original=app.process();result.originalPID=original.pid;original.once('exit',(code,signal)=>{exit={code,signal};});closePromise=new Promise(resolve=>original.once('close',(code,signal)=>{closed={code,signal};resolve();}));page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await app.evaluate(({app,session})=>{globalThis.__navigationExternal=[];const protect=s=>s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(request,done)=>{globalThis.__navigationExternal.push({url:request.url,method:request.method});done({cancel:true});});protect(session.defaultSession);app.on('session-created',protect);});
 await admission.verify(app,page,dataPath);await setTestLocale(page,'ko');
 group=await ipc('group.save',{name:'Navigation audit group'});projects=[];
 for(let i=0;i<(reproduceOnly?1:12);i++)projects.push(await ipc('project.save',{groupId:group.id,name:i?'Navigation project '+String(i+1).padStart(2,'0'):'Long navigation project title with a real local folder',connection:{kind:'local',rootPath:work,agentWorkPath:work,agentBinary:path.join(home,'.local/bin/codex')}}));
 result.fixtures={groupId:group.id,projectIds:projects.map(p=>p.id)};await ipc('review.save',{projectId:projects[0].id,title:'Navigation review fixture',body:'Saved original fixture body'});await page.locator('.workspace-refresh').click();
 if(reproduceOnly)await core(1920,false,{capture:true});
 else if(!dynamicOnly)for(const language of ['ko','en']){locale=language;await setTestLocale(page,language);for(const width of [1920,1360,1100,1000,800])for(const expanded of [false,true]){const capture=width===800&&expanded||(width===1360||width===1920)&&!expanded;await core(width,expanded,{capture});if(extended)await extraBars(width,expanded,{capture});}}
 if((extended||dynamicOnly)&&!reproduceOnly){
  locale='ko';await setTestLocale(page,locale);await resize(800);await sidebar(true);
  if(!dynamicOnly){await page.getByRole('button',{name:'Ops 대화 패널',exact:true}).click();await expect(page.locator('.ops-global-panel:not([hidden])')).toBeVisible();
   await core(800,true,{capture:true,prefix:'ops-panel-'});await extraBars(800,true,{capture:true,prefix:'ops-panel-'});
   await page.getByRole('button',{name:'Ops 대화 패널 닫기',exact:true}).click();await expect(page.locator('.ops-global-panel')).toBeHidden();
  }else{await openProject();await pane().locator('.original-project-back').click();await expect(pane().locator('.resource-content')).toHaveAttribute('data-ops-group-id',group.id);}
  result.dynamic=await testDynamicTabs({page,projects,openProject,openHome:homeTab,photo,pass:(id,description)=>checks.push({id,kind:description})});save();
 }
 result.externalRequests=await app.evaluate(()=>globalThis.__navigationExternal);assert.deepEqual(result.externalRequests,[]);assert.deepEqual(errors,[]);
 if(mode==='before')assert.ok(violations.some(v=>v.id.endsWith('-project'))&&violations.some(v=>v.id.endsWith('-group')),'Before must reproduce the actual project and group caps.');else assert.deepEqual(violations,[],'Finite navigation must use available width and keep every tab bounded.');
 result.ok=true;result.reproduced=mode==='before';
}catch(error){failure=error;result.failure={message:error.message,stack:error.stack};save();if(page&&!page.isClosed())await photo('failure').catch(()=>{});}
finally{
 if(app){
  if(activeDraft&&page&&!page.isClosed())try{await openProject();await projectFeature('settings');const settings=pane().locator('.original-kept-panel:not([hidden]) .original-project-settings');await settings.locator('.original-project-settings-tabs button').first().click();const description=settings.getByRole('textbox',{name:tr('설명'),exact:true});await description.fill(activeDraft.originalDescription);await frames();activeDraft=null;result.failureDraftRestored=true;}catch(error){result.failureDraftRestoreError=error.message;}
  try{const timer=ms=>new Promise((_,reject)=>setTimeout(()=>reject(new Error('Original process close timed out')),ms));await Promise.race([app.close(),timer(15000)]);await Promise.race([closePromise,timer(15000)]);assert.deepEqual(exit,{code:0,signal:null});assert.deepEqual(closed,{code:0,signal:null});cleanup=true;}
  catch(error){failure??=error;result.cleanupError=error.message;if(original&&exit===null){result.failedOwnedCleanup={pid:original.pid,signal:'SIGKILL',reason:'Exact owned private QA app after cleanup timeout; failed run only.'};original.kill('SIGKILL');await Promise.race([closePromise,new Promise(resolve=>setTimeout(resolve,3000))]);}}
 }
 result.originalExit=exit;result.originalClose=closed;result.cleanupConfirmed=cleanup;if(rendererBefore){result.rendererAfter=tree(path.join(root,'dist'));try{assert.deepEqual(result.rendererAfter,rendererBefore);}catch(error){failure??=error;result.rendererChanged=true;}}
 const remove=cleanup&&!failure;result.fixtureRemoved=remove;if(remove)fs.rmSync(temporary,{recursive:true,force:true});if(failure)result.ok=false;save();
}
console.log(JSON.stringify({ok:result.ok,mode,checks:checks.length,violations:violations.length,result:path.join(output,'result.json')}));if(failure)throw failure;
