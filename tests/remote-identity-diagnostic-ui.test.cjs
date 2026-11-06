'use strict';

// Render the actual diagnostic component without Electron, a vault or a model.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const contract=require('../electron/remote-identity-diagnostics.cjs');
function renderer(){
 const source=fs.readFileSync(path.join(__dirname,'../src/RemoteManagementSettings.jsx'),'utf8');
 const pure=source.slice(source.indexOf('const ID='),source.indexOf('export default function RemoteManagementSettings')).replace(/\bexport /g,'');
 const context={React,t:value=>value,Object,Reflect,Array,Date,Number,Set,URL};
 return vm.runInNewContext(pure+'\n;({identityDiagnosticValid,identityValid,IdentityDiagnosticNotice,identitySetupBlocked});',context);
}
const legacy=()=>({version:1,source:'legacy-intent',stage:'unknown',code:'UNKNOWN',osStatus:null,mayRemain:null,cleanup:'unknown'});
const pending=diagnostic=>({status:'pending',backend:'macos-default-file-keychain',identity:null,errorCode:'IDENTITY_PENDING',...(diagnostic?{diagnostic}:{})});

test('renderer accepts the closed provider diagnostic vocabulary and rejects private/accessor extensions',()=>{
 const ui=renderer(),base={version:1,source:'live-operation',stage:'backend-preflight',code:'DEFAULT_LOCKED',osStatus:null,mayRemain:false,cleanup:'not-needed'};
 for(const code of contract.CODES)assert.equal(ui.identityDiagnosticValid({...base,code}),true,code);
 for(const osStatus of contract.OS_STATUSES)assert.equal(ui.identityDiagnosticValid({...base,osStatus}),true,String(osStatus));
 assert.equal(ui.identityValid(pending()),true);assert.equal(ui.identityValid(pending(legacy())),true);
 let accessed=0;const accessor={...base};Object.defineProperty(accessor,'code',{get(){accessed++;return 'DEFAULT_LOCKED';},enumerable:true});
 for(const diagnostic of [accessor,{...base,code:'PRIVATE_NATIVE_MESSAGE'},{...base,osStatus:123456},{...base,path:'/private/keychain'},{...legacy(),stage:'backend-preflight'},{...base,source:'retained-intent'},{...base,cleanup:'confirmed',mayRemain:true},{...base,cleanup:'unconfirmed',mayRemain:false}])assert.equal(ui.identityDiagnosticValid(diagnostic),false);
 assert.equal(accessed,0);
 assert.equal(ui.identityValid({status:'ready',backend:'macos-default-file-keychain',identity:null,errorCode:null,diagnostic:base}),false);
});

test('backend preflight diagnostics reach the renderer without accepting arbitrary status or private fields',()=>{
 const ui=renderer();
 for(const [rawStatus,expectedStatus] of [[-25294,-25294],[-25295,-25295],[-25307,-25307],[12345678,null]]){
  const diagnostic=contract.captureIdentityDiagnostic({stage:'backend-preflight',error:{code:'DEFAULT_KEYCHAIN_FAILED',osStatus:rawStatus,mayRemain:false,path:'Synthetic private path'},cleanup:'not-needed'});
  const identity={status:'unavailable',backend:'macos-default-file-keychain',identity:null,errorCode:'IDENTITY_UNAVAILABLE',diagnostic};
  assert.equal(diagnostic.osStatus,expectedStatus);assert.equal(ui.identityValid(identity),true);
  const html=renderToStaticMarkup(React.createElement(ui.IdentityDiagnosticNotice,{identity}));
  assert.ok(html.includes('보안 저장소 사전 확인'));assert.ok(html.includes('정리 대상 없음'));
  assert.ok(html.includes(expectedStatus===null?'확인 불가':String(expectedStatus)));
  assert.equal(html.includes('Synthetic private path'),false);assert.equal(html.includes('DEFAULT_KEYCHAIN_FAILED'),false);
  assert.equal(ui.identityValid({...identity,diagnostic:{...diagnostic,osStatus:12345678}}),false);
  assert.equal(ui.identityValid({...identity,diagnostic:{...diagnostic,path:'Synthetic private path'}}),false);
  assert.throws(()=>contract.copyIdentityDiagnostic({...diagnostic,path:'Synthetic private path'}),{code:'IDENTITY_UNAVAILABLE'});
 }
});
test('known locked diagnostics render actionable fixed guidance without enabling pending replay',()=>{
 const ui=renderer(),identity=pending({version:1,source:'retained-intent',stage:'create-protected-item',code:'DEFAULT_LOCKED',osStatus:-25308,mayRemain:false,cleanup:'not-needed'});
 const html=renderToStaticMarkup(React.createElement(ui.IdentityDiagnosticNotice,{identity}));
 assert.ok(html.includes('작업 당시 기본 Keychain 잠금이 확인되었습니다.'));
 assert.ok(html.includes('상태 새로고침은 등록을 다시 실행하거나 기록을 삭제하지 않습니다.'));
 assert.ok(html.includes("이 진단은 보존한 등록 시도의 기록입니다. 현재 보안 저장소 상태를 새로 검사한 결과가 아닙니다."));assert.ok(html.includes('-25308'));assert.equal(html.includes('DEFAULT_LOCKED'),false);
 assert.equal(ui.identitySetupBlocked({identity,web:{enabled:false},app:{enabled:false}}),true);
 assert.equal(ui.identitySetupBlocked({identity:{...identity,errorCode:'CERTIFICATE_REISSUE_REQUIRED'},web:{},app:{}}),true);
});

test('legacy unknown intent renders uncertainty without promising unlock or restart recovery',()=>{
 const ui=renderer(),identity=pending(legacy());
 const html=renderToStaticMarkup(React.createElement(ui.IdentityDiagnosticNotice,{identity}));
 assert.ok(html.includes('실패 원인과 보호된 신원 항목의 상태를 확인할 수 없습니다.'));
 assert.equal(html.includes('잠금 해제'),false);assert.equal(html.includes('재시작'),false);
 assert.equal(html.includes('legacy-intent'),false);assert.equal(html.includes('UNKNOWN'),false);
 assert.equal(renderToStaticMarkup(React.createElement(ui.IdentityDiagnosticNotice,{identity:pending()})),'');
});
