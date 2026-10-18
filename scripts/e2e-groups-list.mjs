import {setTestLocale} from './test-locale.mjs';
import { openSelect, closeSelect, expectSelectValue } from './select-control.mjs';
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd(),testRoot=fs.mkdtempSync(path.join('/tmp','reviewops-groups-list-'));
const homePath=path.join(testRoot,'home'),sshConfig=path.join(homePath,'.ssh','config');
fs.mkdirSync(path.dirname(sshConfig),{recursive:true});fs.writeFileSync(sshConfig,'# Synthetic group list fixture\n',{mode:0o600});
const resultRoot=path.join(root,'test-results');
fs.mkdirSync(resultRoot,{recursive:true});
let app,page;const checks=[],errors=[],requests=[];
const passed=name=>{checks.push(name);console.log(`PASS: ${name}`)};
async function invoke(action,payload={}) {
 const result=await page.evaluate(({action,payload})=>window.reviewops.request(action,payload),{action,payload});
 assert.equal(result.ok,true,`${action}: ${result.error?.message||'요청 실패'}`);return result.data;
}
const pane=()=>page.getByRole('region',{name:'그룹 목록',exact:true});
const table=()=>pane().getByRole('table',{name:'그룹 목록',exact:true});
const rows=()=>table().locator('tbody tr[tabindex]');
const search=()=>pane().getByRole('searchbox',{name:'그룹명, 설명, 라벨 검색',exact:true});
const label=()=>pane().getByRole('combobox',{name:'그룹 라벨',exact:true});
const status=name=>pane().getByRole('group',{name:'그룹 운영 상태',exact:true}).getByRole('button',{name,exact:true});
const pagination=()=>pane().getByRole('navigation',{name:'그룹 페이지',exact:true});
const groupRow=name=>rows().filter({has:page.getByRole('button',{name:`그룹 열기: ${name}`,exact:true})});
const primary=()=>page.locator('.main-nav').getByRole('button',{name:'그룹',exact:true});
const resize=(width,height=1000)=>app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height});
const near=(actual,expected,message,tolerance=.8)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${message}: ${actual} / ${expected}`);

async function geometry() {
 return table().evaluate(node=>{
  const box=element=>{const {x,y,width,height}=element.getBoundingClientRect();return {x,y,width,height}};
  const css=element=>getComputedStyle(element);
  const root=node.closest('.groups-page-region'),card=root;
  const row=[...node.querySelectorAll('tbody tr[tabindex]')].find(item=>!item.querySelector('.groups-page-labels')),name=row.querySelector('.groups-page-name'),description=row.querySelector('.groups-page-description');
  const summary=row.querySelector('[aria-label="리뷰 현황"]'),open=row.querySelector('button');
  const query=root.querySelector('.groups-page-query'),header=root.closest('.workspace-pane').querySelector('.groups-page-header');
  return {window:window.innerWidth,document:document.documentElement.scrollWidth,header:box(header),card:box(card),query:box(query),thead:box(node.querySelector('thead')),row:box(row),cellPadding:css(row.querySelector('td')).padding,
   radius:css(card).borderRadius,border:css(card).borderTopColor,headerCountColor:css(header.querySelector('.groups-page-count')).color,projectCountColor:css(row.querySelector('.groups-page-project-column > p:first-child')).color,name:{size:css(name).fontSize,weight:css(name).fontWeight,lineHeight:css(name).lineHeight},description:description?{size:css(description).fontSize,lineHeight:css(description).lineHeight}:null,
   summary:box(summary),summaryLabels:[...summary.querySelectorAll('span')].map(item=>({size:css(item).fontSize})),summaryCounts:[...summary.querySelectorAll('strong')].map(item=>({size:css(item).fontSize,weight:css(item).fontWeight})),open:box(open),openRadius:css(open).borderRadius};
 });
}

try {
 const env={...process.env,HOME:homePath,CODEX_HOME:path.join(homePath,'.codex'),REVIEWOPS_CODEX_SSH_CONFIG:sshConfig,REVIEWOPS_DATA_DIR:path.join(testRoot,'data')};for(const name of ['ELECTRON_RUN_AS_NODE','SSH_AUTH_SOCK','OPENAI_API_KEY','CODEX_API_KEY'])delete env[name];
 app=await electron.launch({args:process.env.REVIEWOPS_TEST_EXECUTABLE?[]:[root],executablePath:process.env.REVIEWOPS_TEST_EXECUTABLE,env,timeout:30000});
 page=await app.firstWindow(); await setTestLocale(page);page.setDefaultTimeout(10000);
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url())});
 await page.waitForFunction(()=>!!window.reviewops?.request);await resize(1920);
 await primary().click();await expect(page.locator('.workspace-pane:visible').getByRole('heading',{name:'그룹',exact:true})).toBeVisible();
 await expect(pane()).toContainText('등록된 그룹이 없습니다.');await expect(rows()).toHaveCount(0);
 await pane().getByRole('button',{name:'그룹 등록',exact:true}).click();
 const form=page.getByRole('dialog',{name:'그룹 만들기',exact:true});await expect(form).toBeVisible();
 await form.getByLabel('그룹 이름',{exact:true}).fill('검사 등록 그룹');await form.getByLabel('설명',{exact:true}).fill('목록에서 등록한 그룹입니다.');
 await form.getByRole('button',{name:'저장',exact:true}).click();await expect(form).toHaveCount(0);
 const created=(await invoke('snapshot')).groups.find(item=>item.name==='검사 등록 그룹');assert.ok(created);
 await expect(page.locator('.workspace-pane:visible').getByRole('heading',{name:created.name,exact:true})).toBeVisible();
 await invoke('group.delete',{id:created.id});await page.locator('.workspace-tab.active .tab-close').click();
 passed('빈 목록 안내, 그룹 등록과 저장 후 그룹 화면 연결');

 const groups=[];
 for(let index=1;index<=48;index++)groups.push(await invoke('group.save',{name:`검사 그룹 ${String(index).padStart(2,'0')}`,description:index===2?'':index===1?'검색 화면과 문서 기능을 관리합니다.':`목록 확인 설명 ${index}`,labels:index===1?['화면','문서']:index===2?['문서']:index===3?['배포']:[],operationalStatus:index<=45?'active':index<=47?'archived':'disabled'}));
 const first=groups[0],last=groups[44];
 const project=await invoke('project.save',{name:'검사 프로젝트',groupId:first.id,serviceIds:[]});
 const second=await invoke('project.save',{name:'추가 프로젝트',groupId:first.id,serviceIds:[]});
 for(const state of ['open','in_progress','in_review','resolved','closed','recheck'])await invoke('review.save',{projectId:project.id,title:`${state} 상태 검사`,body:'그룹 리뷰 집계를 확인합니다.',status:state});
 await invoke('review.save',{projectId:second.id,title:'추가 열림 검사',body:'다른 프로젝트의 리뷰를 함께 집계합니다.',status:'open'});
 await invoke('project.save',{name:'끝 페이지 프로젝트',groupId:last.id,serviceIds:[]});
 await page.locator('.workspace-refresh').click();await primary().click();
 await expect(table().getByRole('columnheader')).toHaveText(['그룹','프로젝트','리뷰 현황','작업']);
 for(const unwanted of ['회원','공개 범위','소유자'])await expect(table().getByRole('columnheader',{name:unwanted,exact:true})).toHaveCount(0);
 await expect(rows()).toHaveCount(20);await expect(status('활성')).toHaveAttribute('aria-pressed','true');
 await expect(groupRow(first.name)).toContainText(first.description);await expect(groupRow(first.name)).toContainText('#화면');
 await expect(groupRow(first.name).locator('[aria-label="리뷰 현황"] strong')).toHaveText(['2','1','1','1']);
 await expect(groupRow(first.name).locator('td').nth(1)).toHaveText(/2/);
 await expect(groupRow(groups[1].name).locator('[aria-label="리뷰 현황"] strong')).toHaveText(['0','0','0','0']);
 await expect(groupRow(groups[1].name)).toContainText('설명 없음');
 await expect(pagination().getByRole('button',{name:'이전 페이지',exact:true})).toBeDisabled();
 await expect(pagination().getByRole('button',{name:'1 페이지',exact:true})).toHaveAttribute('aria-current','page');
 await pagination().getByRole('button',{name:'다음 페이지',exact:true}).click();await expect(rows()).toHaveCount(20);
 await pagination().getByRole('button',{name:'3 페이지',exact:true}).click();await expect(rows()).toHaveCount(5);
 await expect(groupRow(last.name)).toBeVisible();await expect(pagination().getByRole('button',{name:'다음 페이지',exact:true})).toBeDisabled();
 await pagination().getByRole('button',{name:'이전 페이지',exact:true}).click();await expect(rows()).toHaveCount(20);
 await pagination().getByRole('button',{name:'1 페이지',exact:true}).click();
 passed('그룹 표 4개 열, 프로젝트·리뷰 집계, 빈 설명 표시와 20개 단위 페이지 이동');

 await pane().evaluate(node=>node.closest('.groups-page-content').scrollTop=0);
 const desktop1920=await geometry();
 for(const [actual,expected,name] of [[desktop1920.header.height,65,'머리글 높이'],[desktop1920.card.y,121,'목록 상단'],[desktop1920.card.width,1280,'목록 최대 너비'],[desktop1920.card.x,360,'목록 중앙 배치'],[desktop1920.query.height,68,'검색 영역 높이'],[desktop1920.thead.height,47.09375,'표 머리글 높이'],[desktop1920.row.height,89.6875,'그룹 행 높이'],[desktop1920.summary.width,168,'리뷰 현황 너비'],[desktop1920.summary.height,48.6875,'리뷰 현황 높이'],[desktop1920.open.width,64,'열기 버튼 너비'],[desktop1920.open.height,36,'열기 버튼 높이']])near(actual,expected,name);
 assert.equal(desktop1920.radius,'12px');assert.equal(desktop1920.border,'rgb(222, 216, 210)');assert.equal(desktop1920.cellPadding,'20px 16px');
 assert.equal(desktop1920.headerCountColor,'rgb(107, 98, 91)');assert.equal(desktop1920.projectCountColor,'rgb(32, 41, 56)');
 assert.deepEqual(desktop1920.name,{size:'15px',weight:'600',lineHeight:'23.25px'});assert.deepEqual(desktop1920.description,{size:'12px',lineHeight:'16px'});
 assert.ok(desktop1920.summaryLabels.every(item=>item.size==='12px'));assert.ok(desktop1920.summaryCounts.every(item=>item.size==='14px'&&item.weight==='600'));
 await expect(page.locator('.toast')).toHaveCount(0);await page.screenshot({scale:'css',path:path.join(resultRoot,'groups-list-1920.png')});
 await resize(1360);const desktop1360=await geometry();near(desktop1360.card.width,1216,'1360px 창에서 목록 너비');near(desktop1360.card.x,112,'1360px 창에서 목록 왼쪽 여백');assert.ok(desktop1360.document<=desktop1360.window);
 await page.screenshot({scale:'css',path:path.join(resultRoot,'groups-list-1360.png')});await resize(1920);
 passed('원본 실측과 머리글·카드·표 간격·글꼴·리뷰 집계·열기 버튼 비교');

 await search().fill('검색 화면');await expect(rows()).toHaveCount(1);await expect(groupRow(first.name)).toBeVisible();
 await search().fill('배포');await expect(rows()).toHaveCount(1);await expect(groupRow(groups[2].name)).toBeVisible();
 await search().fill('검사 그룹 45');await expect(rows()).toHaveCount(1);await expect(groupRow(last.name)).toBeVisible();
 await search().fill('일치하는 그룹 없음');await expect(rows()).toHaveCount(0);await expect(pane()).toContainText('검색 결과가 없습니다.');
 await search().fill('');await expect(rows()).toHaveCount(20);await expect(pagination().getByRole('button',{name:'1 페이지',exact:true})).toHaveAttribute('aria-current','page');
 let labelPopup=await openSelect(label());await labelPopup.search.fill('문');await labelPopup.search.press('Enter');await expect(rows()).toHaveCount(2);
 await expect(groupRow(first.name)).toBeVisible();await expect(groupRow(groups[1].name)).toBeVisible();
 await search().focus();await openSelect(label());await expectSelectValue(label(),'문서');await expect(label()).toHaveAttribute('aria-expanded','true');await expect(rows()).toHaveCount(2);await closeSelect(label());await expectSelectValue(label(),'문서');
 await pane().getByRole('button',{name:'그룹 라벨 지우기',exact:true}).click();await expect(rows()).toHaveCount(20);
 labelPopup=await openSelect(label());await labelPopup.search.fill('존재하지 않는 라벨');await labelPopup.search.press('Escape');await expectSelectValue(label(),'');
 await status('보관').click();await expect(rows()).toHaveCount(2);await expect(groupRow(groups[45].name)).toBeVisible();await expect(status('활성')).toHaveAttribute('aria-pressed','false');
 await status('비활성').click();await expect(rows()).toHaveCount(1);await expect(groupRow(groups[47].name)).toBeVisible();
 await status('활성').click();await expect(rows()).toHaveCount(20);
 passed('그룹 이름·설명·라벨 검색, 라벨 키보드 선택·해제, 검색 결과 없음과 단일 운영 상태 선택');

 await search().fill(first.name);await groupRow(first.name).focus();await page.keyboard.press('Enter');
 await expect(page.locator('.workspace-pane:visible').getByRole('heading',{name:first.name,exact:true})).toBeVisible();
 await page.locator('.workspace-pane:visible').getByRole('button',{name:'그룹 목록',exact:true}).click();await expect(pane()).toBeVisible();
 await search().fill('');await search().fill(groups[1].name);await groupRow(groups[1].name).focus();await page.keyboard.press('Space');
 await expect(page.locator('.workspace-pane:visible').getByRole('heading',{name:groups[1].name,exact:true})).toBeVisible();await primary().click();
 await search().fill('');await search().fill(first.name);await pane().getByRole('button',{name:`그룹 열기: ${first.name}`,exact:true}).click();
 await expect(page.locator('.workspace-pane:visible').getByRole('heading',{name:first.name,exact:true})).toBeVisible();await primary().click();await search().fill('');
 passed('Enter·Space 키와 열기 버튼으로 그룹 진입, 그룹 목록 복귀');

 const longName=`긴 그룹 이름 ${'프로젝트 화면과 서비스 작업 내용을 확인합니다 '.repeat(5)}`.slice(0,120);
 await invoke('group.save',{id:first.id,name:longName});await page.locator('.workspace-refresh').click();
 await search().fill('긴 그룹 이름');await resize(800,900);
 await expect(rows()).toHaveCount(1);const mobile=await table().evaluate(node=>{const row=node.querySelector('tbody tr[tabindex]'),open=row.querySelector('button'),input=document.querySelector('.groups-page-region input[type="search"]'),summary=row.querySelector('.groups-page-review-summary');const css=getComputedStyle(row),cellCss=getComputedStyle(row.querySelector('td')),summaryCss=getComputedStyle(summary),summaryCellCss=getComputedStyle(summary.parentElement),box=row.getBoundingClientRect(),button=open.getBoundingClientRect();return {window:window.innerWidth,doc:document.documentElement.scrollWidth,tableWidth:node.getBoundingClientRect().width,row:{x:box.x,y:box.y,width:box.width,height:box.height,radius:css.borderRadius,padding:cellCss.padding,display:css.display,overflow:css.overflow,titleMinWidth:cellCss.minWidth},summary:{width:summary.getBoundingClientRect().width,cellWidth:summary.parentElement.getBoundingClientRect().width,cellPaddingLeft:Number.parseFloat(summaryCellCss.paddingLeft),cellPaddingRight:Number.parseFloat(summaryCellCss.paddingRight),gap:summaryCss.columnGap,columnWidths:[...summary.children].map(item=>item.getBoundingClientRect().width)},open:{x:button.x,y:button.y,width:button.width,height:button.height},inputHeight:input.getBoundingClientRect().height,theadDisplay:getComputedStyle(node.querySelector('thead')).display,overflow:row.scrollWidth>row.clientWidth};});
 assert.ok(mobile.doc<=mobile.window);assert.equal(mobile.row.radius,'8px');assert.equal(mobile.row.padding,'12px 92px 12px 12px');near(mobile.open.height,44,'좁은 창 열기 버튼 높이');near(mobile.inputHeight,44,'좁은 창 검색창 높이');assert.ok(mobile.open.x+mobile.open.width<=mobile.row.x+mobile.row.width);assert.ok(mobile.open.y<=mobile.row.y+13);assert.equal(mobile.overflow,false);
 assert.equal(mobile.row.titleMinWidth,'0px');assert.equal(mobile.row.overflow,'hidden');assert.equal(mobile.summary.gap,'4px');assert.equal(mobile.summary.columnWidths.length,4);near(mobile.summary.width,mobile.summary.cellWidth-mobile.summary.cellPaddingLeft-mobile.summary.cellPaddingRight,'좁은 창 리뷰 현황 전체 너비');for(const width of mobile.summary.columnWidths)near(width,(mobile.summary.width-12)/4,'좁은 창 리뷰 현황 네 칸 동일 너비');
 await expect(page.locator('.toast')).toHaveCount(0);await page.screenshot({scale:'css',path:path.join(resultRoot,'groups-list-mobile.png')});
 await page.getByRole('button',{name:'어두운 화면',exact:true}).click();
 const dark=await pane().evaluate(node=>({text:getComputedStyle(node).color,background:getComputedStyle(node).backgroundColor,cardBackground:getComputedStyle(node.querySelector('table').parentElement).backgroundColor}));assert.notEqual(dark.text,dark.background);assert.notEqual(dark.cardBackground,'rgb(255, 255, 255)');
 await page.screenshot({scale:'css',path:path.join(resultRoot,'groups-list-dark.png')});await page.getByRole('button',{name:'밝은 화면',exact:true}).click();
 passed('좁은 창의 원본 카드 배치와 44px 입력·버튼, 긴 이름 말줄임과 어두운 화면');

 await resize(1920);await search().fill('');await status('보관').click();
 for(const group of groups.filter(item=>item.operationalStatus==='archived'))await invoke('group.save',{id:group.id,operationalStatus:'active'});
 await page.locator('.workspace-refresh').click();await expect(rows()).toHaveCount(0);await expect(pane()).toContainText('보관 그룹이 없습니다.');
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 passed('저장 자료 변경 반영과 빈 운영 상태 안내, 외부 API 요청 없이 실행');
 fs.writeFileSync(path.join(resultRoot,'groups-list.json'),JSON.stringify({version:(await invoke('app.info')).version,executable:process.env.REVIEWOPS_TEST_EXECUTABLE||'development Electron',checks,errors,externalRequests:requests,desktop1920,desktop1360,mobile,dark},null,2));
 console.log(`PASS: 그룹 목록 ${checks.length}개 검사 완료`);
} finally {await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});await app?.close().catch(()=>{});fs.rmSync(testRoot,{recursive:true,force:true});}
