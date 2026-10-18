const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const en=require('../src/i18n/en.json');
const translations=require('../src/i18n/translations.json');
const core=()=>import('../src/i18n/index.js');

test('language codes resolve browser variants and unsupported languages',async()=>{
 const {resolveLocale}=await core();
 for(const [input,expected]of [['ko-KR','ko'],['en-GB','en'],['ja-JP','ja'],['zh-Hant-HK','zh-TW'],['zh-HK','zh-TW'],['zh-SG','zh-CN'],['pt-PT','pt-BR'],['FR_fr','fr'],['unknown','en']])assert.equal(resolveLocale(input),expected);
});
test('catalogs include twelve usable languages and preserve message placeholders',async()=>{
 const {LANGUAGES}=await core();assert.equal(LANGUAGES.length,12);
 assert.ok(Object.keys(en).length>=1100);
 for(const [language,catalog]of Object.entries(translations)){
  assert.ok(Object.keys(catalog).length>=280,language);
  for(const key of ['홈','그룹','프로젝트','설정','표시 언어','저장','취소','삭제','작업이력','앱 업데이트'])assert.ok(catalog[key],`${language}: ${key}`);
  for(const [key,value]of Object.entries(catalog)){
   assert.equal(typeof value,'string');assert.ok(value.trim());
   assert.deepEqual([...(key.match(/\{\d+\}/g)||[])].sort(),[...(value.match(/\{\d+\}/g)||[])].sort(),`${language}: ${key}`);
  }
 }
 for(const [key,value]of Object.entries(en)){assert.ok(!/[가-힣]/.test(value),key);assert.deepEqual([...(key.match(/\{\d+\}/g)||[])].sort(),[...(value.match(/\{\d+\}/g)||[])].sort(),key);}
});
test('switches labels without changing option values, source messages or user interpolation',async()=>{
 const {setLocale,t,localized}=await core();const raw=[['open','열림'],['in_progress','진행']];const options=localized(raw);
 const userName='홈 <script>alert(1)</script> 日本語';
 setLocale('en');assert.equal(options[0][0],'open');assert.equal(options[0][1],'Open');assert.equal(t('{0} 열기',[userName]),`Open ${userName}`);
 setLocale('ja');assert.equal(options[0][0],'open');assert.equal(options[0][1],'未着手');assert.equal(t('SSH 접속 정보를 조회하지 못했습니다.'),'Could not load SSH connection details.');
 setLocale('ko');assert.deepEqual([...options].map(row=>[...row]),raw);assert.equal(t('홈'),'홈');assert.equal(t('raw user text'),'raw user text');
});
test('selected language is persisted and subscribers are notified once',async()=>{
 const {setLocale,getLocale,subscribeLocale,LANGUAGE_STORAGE_KEY}=await core();
 const previous=global.window;const stored=new Map();global.window={localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)}};
 try{setLocale('ko');let notifications=0;const stop=subscribeLocale(()=>notifications++);setLocale('de-DE');setLocale('de');assert.equal(getLocale(),'de');assert.equal(stored.get(LANGUAGE_STORAGE_KEY),'de');assert.equal(notifications,1);stop();setLocale('ko');assert.equal(notifications,1);}finally{global.window=previous;}
});
test('reset credit eligibility is independent of display language and still rejects invalid credits',async()=>{
 const {setLocale,LANGUAGES}=await core();const {resetCreditStatus,isResetCreditSelectable}=await import('../src/codex/reset-credit-state.mjs');
 const credit={id:'synthetic-credit',resetType:'codexRateLimits',status:'available',grantedAt:100,expiresAt:300};
 for(const language of LANGUAGES){setLocale(language.code);assert.equal(resetCreditStatus(credit,200),'available');assert.equal(isResetCreditSelectable(credit,200),true);assert.equal(isResetCreditSelectable(credit,300),false);assert.equal(isResetCreditSelectable({...credit,status:'used'},200),false);assert.equal(isResetCreditSelectable({...credit,grantedAt:250},200),false);assert.equal(isResetCreditSelectable({...credit,expiresAt:99},200),false);assert.equal(isResetCreditSelectable({...credit,id:''},200),false);}
 setLocale('ko');
});
