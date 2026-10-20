'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createEvidenceRecorder,safeUrl,safeText,LIMIT}=require('../electron/browser-evidence.cjs');
class Contents extends EventEmitter {
  constructor(id){super();this.id=id;this.url='https://fixture.invalid/page';this.logs=[];this.closed=false;this.inspectorActions=[]}
  isDestroyed(){return this.closed}
  getURL(){return this.url}
  getTitle(){return '검사 페이지'}
  async executeJavaScriptInIsolatedWorld(world,scripts){
    assert.equal(world,109);
    if(scripts[0].code.includes('function readInputRecorder'))return {logs:this.logs.splice(0),fingerprint:{url:this.url,title:this.getTitle(),viewport:{width:1440,height:900}}};
    for(const action of ['pick','show','clear'])if(scripts[0].code.endsWith('('+JSON.stringify(action)+')')){this.inspectorActions.push(action);return action==='pick'?this.pickResult:action==='show'?this.showResult:null}
    return null;
  }
}
const item=contents=>({view:{webContents:contents},requestedUrl:contents.url,emulation:JSON.stringify({width:1440,height:900,scale:.75})});
test('주소와 콘솔 문자열에서 인증 정보 제외',()=>{
  const result=safeUrl('https://user:password@fixture.invalid/path?token=secret&view=1#access_token=hidden');
  assert.ok(!result.includes('user:'));assert.ok(!result.includes('secret'));assert.ok(!result.includes('hidden'));assert.ok(result.includes('view=1'));
  assert.equal(safeText('Authorization Bearer secret.value token=private password=hidden'),'Authorization Bearer [비공개] token=[비공개] password=[비공개]');
  assert.equal(safeText('{"token":"fixture-secret","password":"fixture-password"}'),'{"token":"[비공개]","password":"[비공개]"}');
  assert.ok(!safeText('Authorization: Basic Zml4dHVyZTpzZWNyZXQ=').includes('Zml4dHVyZTpzZWNyZXQ='));
});
test('서비스 변경 시 이전 로그·선택 요소·대기 중 통신 기록을 비움',async t=>{
  const recorder=createEvidenceRecorder();t.after(()=>recorder.close());const page=new Contents(1),entry=item(page);recorder.track(page,entry);
  page.emit('did-navigate',{},page.url);page.logs.push({type:'change',target:{id:'draft'},value_length:4,masked:true});entry.selectedElement={selector:'#old'};
  recorder.beforeRequest({id:70,webContentsId:1,url:page.url,method:'GET'});await recorder.reset(entry);recorder.completed({id:70,statusCode:200});
  const evidence=await recorder.collect(entry);for(const key of ['navigation','input','network','console'])assert.equal(evidence[key+'_log'].length,0);assert.equal(evidence.fingerprint_log.selectedElement,undefined);
});
test('브라우저별 이동·콘솔·입력·환경 로그 수집과 상한',async t=>{
  const recorder=createEvidenceRecorder();t.after(()=>recorder.close());
  const page=new Contents(1),entry=item(page);recorder.track(page,entry);
  page.emit('dom-ready');
  for(let i=0;i<LIMIT+5;i++)page.emit('did-navigate',{},page.url+'?index='+i);
  page.emit('console-message',{}, {level:'error',message:'token=hidden',lineNumber:4,sourceId:page.url});
  page.logs.push({type:'change',at:'2026-10-17',target:{name:'password'},value:'hidden',redacted:true},{type:'click',target:{tag:'button'}});
  entry.selectedElement={selector:'#submit',tag:'button'};
  const evidence=await recorder.collect(entry);
  assert.equal(evidence.navigation_log.length,LIMIT);assert.equal(evidence.console_log[0].message,'token=[비공개]');
  assert.equal(evidence.input_log[0].value,undefined);assert.equal(evidence.input_log[0].value_length,6);assert.equal(evidence.input_log[0].masked,true);assert.equal(evidence.fingerprint_log.selectedElement.selector,'#submit');
  assert.deepEqual(evidence.viewport,{width:1440,height:900,scale:.75});
  evidence.console_log[0].message='changed';
  assert.equal((await recorder.collect(entry)).console_log[0].message,'token=[비공개]');
});
test('통신 로그를 해당 뷰어에만 저장하고 종류별로 삭제',async t=>{
  const recorder=createEvidenceRecorder();t.after(()=>recorder.close());
  const first=new Contents(1),second=new Contents(2),a=item(first),b=item(second);
  recorder.track(first,a);recorder.track(second,b);
  recorder.beforeRequest({id:10,webContentsId:1,url:first.url+'?api_key=hidden',method:'GET',resourceType:'xhr'});
  recorder.beforeRequest({id:20,webContentsId:2,url:second.url,method:'GET',resourceType:'xhr'});
  recorder.completed({id:10,statusCode:200});recorder.failed({id:20,error:'ERR_FAILED'});
  assert.equal((await recorder.collect(a)).network_log[0].status,200);
  assert.ok(!(await recorder.collect(a)).network_log[0].url.includes('hidden'));
  assert.equal((await recorder.collect(b)).network_log[0].error,'ERR_FAILED');
  first.emit('did-navigate',{},first.url);
  const cleared=await recorder.clear(a,'network');
  assert.equal(cleared.network_log.length,0);assert.equal(cleared.navigation_log.length,1);
  assert.equal((await recorder.clear(a)).navigation_log.length,0);
  first.closed=true;first.emit('destroyed');recorder.beforeRequest({id:30,webContentsId:1,url:first.url,method:'GET'});recorder.completed({id:30,statusCode:200});
  assert.equal(a.evidence.network_log.length,0);
});

test('선택 요소 위치를 다시 읽고 표시 해제 시 저장된 선택도 즉시 지움',async t=>{
  const recorder=createEvidenceRecorder();t.after(()=>recorder.close());const page=new Contents(1),entry=item(page);recorder.track(page,entry);
  page.pickResult={selector:'#button',rect:{x:10,y:20,width:100,height:40}};
  assert.equal((await recorder.pick(entry)).selector,'#button');assert.equal((await recorder.collect(entry)).fingerprint_log.selectedElement.rect.y,20);
  page.showResult={...page.pickResult,rect:{x:10,y:150,width:100,height:40}};
  assert.equal((await recorder.showElement(entry)).rect.y,150);assert.equal(entry.selectedElement.rect.y,150);
  await recorder.clearElement(entry);assert.equal(entry.selectedElement,undefined);assert.equal((await recorder.collect(entry)).fingerprint_log.selectedElement,undefined);
  assert.deepEqual(page.inspectorActions,['pick','show','clear']);
});

test('새 요소 지정 취소는 이전 선택을 보존하고 페이지 이동은 이전 선택을 지움',async t=>{
  const recorder=createEvidenceRecorder();t.after(()=>recorder.close());const page=new Contents(1),entry=item(page);recorder.track(page,entry);
  page.pickResult={selector:'#old'};await recorder.pick(entry);page.pickResult=null;
  assert.equal(await recorder.pick(entry),null);assert.equal(entry.selectedElement.selector,'#old');
  page.emit('did-navigate',{},'https://fixture.invalid/next');assert.equal(entry.selectedElement,undefined);assert.equal((await recorder.collect(entry)).fingerprint_log.selectedElement,undefined);
});

for(const action of ['clear','reset','navigate'])test(`${action} 이후 도착한 이전 요소 지정 응답은 저장하지 않음`,async t=>{
  const recorder=createEvidenceRecorder();t.after(()=>recorder.close());const page=new Contents(1),entry=item(page);recorder.track(page,entry);
  let resolve;page.pickResult=new Promise(done=>{resolve=done});const pending=recorder.pick(entry);
  if(action==='clear')await recorder.clearElement(entry);else if(action==='reset')await recorder.reset(entry);else page.emit('did-navigate',{},'https://fixture.invalid/next');
  resolve({selector:'#late'});assert.equal(await pending,null);assert.equal(entry.selectedElement,undefined);assert.equal((await recorder.collect(entry)).fingerprint_log.selectedElement,undefined);
});

for(const action of ['clear','reset','navigate'])test(`${action} 이후 도착한 이전 요소 위치 응답은 선택을 복원하지 않음`,async t=>{
  const recorder=createEvidenceRecorder();t.after(()=>recorder.close());const page=new Contents(1),entry=item(page);recorder.track(page,entry);
  entry.selectedElement={selector:'#old'};let resolve;page.showResult=new Promise(done=>{resolve=done});const pending=recorder.showElement(entry);
  if(action==='clear')await recorder.clearElement(entry);else if(action==='reset')await recorder.reset(entry);else page.emit('did-navigate',{},'https://fixture.invalid/next');
  resolve({selector:'#old',rect:{x:0,y:0,width:50,height:30}});assert.equal(await pending,null);assert.equal(entry.selectedElement,undefined);
});
