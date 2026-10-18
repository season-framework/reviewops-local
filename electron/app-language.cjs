'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {atomicWrite} = require('./vault.cjs');
const CODES = ['en','ko','ja','zh-CN','zh-TW','es','fr','de','pt-BR','it','ru','vi'];
const NATIVE = {
 '작업 지시서 ZIP 저장':'Save task instructions as ZIP','ZIP 파일':'ZIP files','작업 파일 저장':'Save task file',
 '첨부파일 추가':'Add attachments','백업 저장':'Save backup','ReviewOps 백업':'ReviewOps backup',
 '백업 복원':'Restore backup','현재 자료를 백업 파일의 내용으로 교체합니다.':'Replace the current data with this backup?',
 '복원 전 자료는 데이터 폴더의 recovery 폴더에 저장됩니다. SSH 비밀번호와 서버 인증 정보는 다시 설정해야 합니다.':'A copy of your current data will be saved in the recovery folder. You will need to enter SSH passwords and verify server identities again.',
 '취소':'Cancel','복원':'Restore','스크린샷 저장':'Save screenshot','PNG 이미지':'PNG images',
 'SSH 개인 키 선택':'Choose SSH private key','로컬 폴더 선택':'Choose local folder','첨부파일 저장':'Save attachment',
 '저장하지 않은 내용':'Unsaved changes','저장하지 않은 내용을 버리고 닫으시겠습니까?':'Discard unsaved changes and close?',
 '계속 작성':'Keep editing','내용 버리고 닫기':'Discard and close','ReviewOps 실행 오류':'ReviewOps startup error',
 '에이전트 종료 오류':'Could not stop the agent','편집':'Edit','보기':'View','윈도우':'Window',
 'ReviewOps 정보':'About ReviewOps','ReviewOps 숨기기':'Hide ReviewOps','다른 앱 숨기기':'Hide Others','ReviewOps 종료':'Quit ReviewOps',
 '실행 취소':'Undo','다시 실행':'Redo','잘라내기':'Cut','복사':'Copy','붙여넣기':'Paste','전체 선택':'Select All',
 '실제 크기':'Actual Size','확대':'Zoom In','축소':'Zoom Out','전체화면':'Toggle Full Screen','개발자 도구':'Developer Tools',
 '최소화':'Minimize','모두 앞으로 가져오기':'Bring All to Front',
};
const ROLE_LABELS = {about:'ReviewOps 정보',hide:'ReviewOps 숨기기',hideOthers:'다른 앱 숨기기',quit:'ReviewOps 종료',undo:'실행 취소',redo:'다시 실행',cut:'잘라내기',copy:'복사',paste:'붙여넣기',selectAll:'전체 선택',resetZoom:'실제 크기',zoomIn:'확대',zoomOut:'축소',togglefullscreen:'전체화면',toggleDevTools:'개발자 도구',minimize:'최소화',zoom:'확대',front:'모두 앞으로 가져오기'};
function createAppLanguage({dataPath, catalogPath}) {
 const preference=path.join(dataPath,'language.json');
 let language='ko', en={}, translations={};
 try {const value=JSON.parse(fs.readFileSync(preference,'utf8')).language;if(CODES.includes(value))language=value;}catch{}
 const directory=catalogPath||[path.join(__dirname,'../src/i18n'),path.join(__dirname,'../dist/locales')].find(item=>fs.existsSync(path.join(item,'en.json')));
 if(directory){try{en=JSON.parse(fs.readFileSync(path.join(directory,'en.json'),'utf8'));translations=JSON.parse(fs.readFileSync(path.join(directory,'translations.json'),'utf8'));}catch{}}
 const t=value=>typeof value!=='string'||language==='ko'?value:translations[language]?.[value]??en[value]??NATIVE[value]??value;
 const options=value=>{
  if(!value||typeof value!=='object')return value;
  const result={...value};
  for(const key of ['title','message','detail','buttonLabel','nameFieldLabel'])if(typeof result[key]==='string')result[key]=t(result[key]);
  if(Array.isArray(result.buttons))result.buttons=result.buttons.map(t);
  if(Array.isArray(result.filters))result.filters=result.filters.map(item=>({...item,name:t(item.name)}));
  return result;
 };
 return {
  getLanguage:()=>language,
  setLanguage(value){if(!CODES.includes(value))throw new Error('Unsupported display language.');if(value!==language){atomicWrite(preference,JSON.stringify({language:value}));language=value;}return {language};},
  t,
  menu:templateMenu,
  dialog:original=>new Proxy(original,{get(target,key){const fn=target[key];if(typeof fn!=='function')return fn;if(key==='showErrorBox')return (title,content)=>fn.call(target,t(title),t(content));if(!['showOpenDialog','showOpenDialogSync','showSaveDialog','showSaveDialogSync','showMessageBox','showMessageBoxSync'].includes(key))return fn.bind(target);return (...args)=>fn.apply(target,args.map((value,index)=>index===args.length-1?options(value):value));}}),
 };
 function templateMenu(template){return template.map(item=>({...item,...(item.label||ROLE_LABELS[item.role]?{label:t(item.label||ROLE_LABELS[item.role])}:{}),...(Array.isArray(item.submenu)?{submenu:templateMenu(item.submenu)}:{})}));}
}
module.exports={createAppLanguage,CODES,NATIVE};
