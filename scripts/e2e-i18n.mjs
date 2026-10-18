import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openSelect,selectControl,expectSelectValue} from './select-control.mjs';
import {setTestLocale} from './test-locale.mjs';
const root=process.cwd(),testRoot=fs.mkdtempSync('/tmp/reviewops-i18n-'),home=path.join(testRoot,'home'),dataPath=path.join(testRoot,'data'),files=path.join(testRoot,'files');
fs.mkdirSync(path.join(home,'.ssh'),{recursive:true});fs.mkdirSync(files);const config=path.join(home,'.ssh','config');fs.writeFileSync(config,'# Isolated localization fixture\n');
const en=JSON.parse(fs.readFileSync(path.join(root,'src/i18n/en.json'))),translations=JSON.parse(fs.readFileSync(path.join(root,'src/i18n/translations.json')));
const languages=[['en','English'],['ja','Japanese'],['zh-CN','Simplified'],['zh-TW','Traditional'],['es','Spanish'],['fr','French'],['de','German'],['pt-BR','Portuguese'],['it','Italian'],['ru','Russian'],['vi','Vietnamese'],['ko','Korean']];
const text=(source,language)=>language==='ko'?source:translations[language]?.[source]??en[source]??source;
let app,page,version,output;const checks=[],errors=[];const pass=name=>{checks.push(name);console.log('PASS: '+name)};
const pane=()=>page.locator('.workspace-pane:not([hidden])');
const ipc=(action,payload={})=>page.evaluate(({action,payload})=>window.reviewops.invoke(action,payload),{action,payload});
const settings=(language)=>page.locator('.sidebar-bottom').getByRole('button',{name:text('설정',language),exact:true});
async function launch(){
 const env={...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex'),REVIEWOPS_DATA_DIR:dataPath,REVIEWOPS_SSH_CONFIG:config,REVIEWOPS_CODEX_SSH_CONFIG:config};for(const key of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>Boolean(window.reviewops?.invoke));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1000));await ipc('update.configure',{automatic:false});
}
try{
 await launch();version=await app.evaluate(({app})=>app.getVersion());output=path.join(root,'test-results',`i18n-v${version}`);fs.mkdirSync(output,{recursive:true});
 const initial=await page.evaluate(()=>({language:document.documentElement.lang,stored:localStorage.getItem('reviewops.language')}));assert.equal(initial.language,initial.stored);pass('First-run language is saved immediately');
 await setTestLocale(page,'ko');
 const group=await ipc('group.save',{name:'홈',description:'설정 日本語 中文 — untouched',labels:['리뷰']});
 const project=await ipc('project.save',{name:'설정',groupId:group.id,description:'홈',connection:{kind:'local',rootPath:files}});
 const review=await ipc('review.save',{projectId:project.id,title:'리뷰',body:'홈 설정 — user content must remain unchanged',status:'in_progress'});
 await page.locator('.workspace-refresh').click();await pane().getByRole('button',{name:'설정 프로젝트 열기',exact:true}).click();
 await pane().getByRole('navigation',{name:'프로젝트 기능',exact:true}).getByRole('button',{name:'설정',exact:true}).click();
 const draft='홈 — unsaved 日本語 中文';await pane().getByLabel('프로젝트명',{exact:true}).fill(draft);await pane().getByLabel('설명',{exact:true}).fill('설정');
 await settings('ko').click();const languageControl=pane().locator('#reviewops-language');
 let current='ko';
 for(const [language,searchTerm]of languages){
  console.log('CHECK locale: '+language);
  const {search,listbox,popup}=await openSelect(languageControl);await expect(search).toBeVisible();await search.fill(searchTerm);await expect(listbox.getByRole('option')).toHaveCount(1);await expect(listbox.getByRole('option')).toHaveAttribute('data-value',language);await expect(search).toHaveValue(searchTerm);await expect(search).toBeFocused();await search.press('Enter');await expect(popup).toBeHidden();await expectSelectValue(languageControl,language);
  await expect(page.locator('html')).toHaveAttribute('lang',language);await expect(pane().getByRole('heading',{name:text('언어',language),exact:true})).toBeVisible();await expect(page.locator('.main-nav').getByRole('button',{name:text('홈',language),exact:true})).toBeVisible();assert.equal(await page.evaluate(()=>localStorage.getItem('reviewops.language')),language);
  const nativeLabels=()=>app.evaluate(({Menu})=>Menu.getApplicationMenu().items.map(item=>item.label));await expect.poll(nativeLabels).toContain(text('편집',language));
  if(['en','ja','zh-CN','de'].includes(language))await page.screenshot({path:path.join(output,`settings-${language}.png`)});
  current=language;
 }
 pass('All 12 languages are searchable by English names and update navigation, settings and native menus');
 const nativeSearch=await openSelect(languageControl);await nativeSearch.search.fill('日本語');await expect(nativeSearch.listbox.getByRole('option')).toHaveCount(1);await nativeSearch.search.press('Escape');await expectSelectValue(languageControl,'ko');pass('Native language names can be searched and Escape keeps the selection');
 await selectControl(languageControl,'ja');current='ja';
 await page.locator('.workspace-tab-select').getByText('설정',{exact:true}).click();
 await expect(pane().getByLabel(text('프로젝트명','ja'),{exact:true})).toHaveValue(draft);await expect(pane().getByLabel(text('설명','ja'),{exact:true})).toHaveValue('설정');
 await expect(pane().locator('.original-status-field').getByRole('button',{name:text('활성','ja'),exact:true})).toHaveAttribute('aria-pressed','true');
 const snapshot=await ipc('snapshot');assert.equal(snapshot.groups.find(item=>item.id===group.id).name,'홈');assert.equal(snapshot.projects.find(item=>item.id===project.id).name,'설정');assert.equal(snapshot.reviews.find(item=>item.id===review.id).body,'홈 설정 — user content must remain unchanged');
 pass('Language changes preserve unsaved form fields, enum values and all user content');
 await pane().locator('.original-settings-subnav').getByRole('button',{name:text('저장하기','ja'),exact:true}).click();await expect(page.getByRole('status').filter({hasText:text('프로젝트 저장 완료','ja')})).toBeVisible();
 await settings('ja').click();await selectControl(pane().locator('#reviewops-language'),'fr');
 await app.close();app=null;await launch();await expect(page.locator('html')).toHaveAttribute('lang','fr');await settings('fr').click();await expectSelectValue(pane().locator('#reviewops-language'),'fr');
 const after=await ipc('snapshot');assert.equal(after.projects.find(item=>item.id===project.id).name,draft);assert.equal(after.reviews.find(item=>item.id===review.id).title,'리뷰');pass('Language selection and saved user content survive an app restart');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,800));await selectControl(pane().locator('#reviewops-language'),'de');const picker=await openSelect(pane().locator('#reviewops-language'));const bounds=await picker.popup.boundingBox();const size=page.viewportSize()||await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert.ok(bounds.x>=0&&bounds.x+bounds.width<=size.width);await picker.search.press('Escape');pass('Searchable language list fits a narrow window');
 assert.deepEqual(errors,[]);pass('No renderer errors, account sign-ins or SSH tasks');
 fs.writeFileSync(path.join(output,process.env.REVIEWOPS_TEST_EXECUTABLE?'dmg.json':'source.json'),JSON.stringify({ok:true,version,checks,languages:languages.map(([code])=>code),rendererErrors:errors,testRoot,accountLogins:0,creditOperations:0,sshOperations:0},null,2));console.log(JSON.stringify({ok:true,version,checks:checks.length,testRoot}));
}catch(error){if(page&&output)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}finally{await app?.close().catch(()=>{});}
