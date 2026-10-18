'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createAppLanguage}=require('../electron/app-language.cjs');
function fixture(t){const root=fs.mkdtempSync('/tmp/reviewops-language-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('native language selection is private, persistent and limited to supported languages',t=>{
 const dataPath=fixture(t),language=createAppLanguage({dataPath});
 assert.equal(language.getLanguage(),'ko');language.setLanguage('en');
 assert.equal(language.t('백업 저장'),'Save backup');
 assert.equal(createAppLanguage({dataPath}).getLanguage(),'en');
 assert.equal(fs.statSync(path.join(dataPath,'language.json')).mode&0o777,0o600);
 assert.throws(()=>language.setLanguage('../../other'));assert.equal(language.getLanguage(),'en');
});
test('native dialog translation preserves filenames, window references and option semantics',t=>{
 const language=createAppLanguage({dataPath:fixture(t)});language.setLanguage('en');
 const window={id:3};let received;
 const wrapped=language.dialog({showSaveDialog(...args){received=args;return 'saved';},showMessageBoxSync(...args){received=args;return 1;}});
 const original={title:'백업 저장',defaultPath:'백업 저장',filters:[{name:'ReviewOps 백업',extensions:['json']}]};
 assert.equal(wrapped.showSaveDialog(window,original),'saved');
 assert.equal(received[0],window);assert.equal(received[1].title,'Save backup');assert.equal(received[1].defaultPath,'백업 저장');
 assert.deepEqual(received[1].filters,[{name:'ReviewOps backup',extensions:['json']}]);assert.equal(original.title,'백업 저장');
 assert.equal(wrapped.showMessageBoxSync({title:'저장하지 않은 내용',buttons:['계속 작성','내용 버리고 닫기'],cancelId:0}),1);
 assert.deepEqual(received[0].buttons,['Keep writing','Discard and close']);assert.equal(received[0].cancelId,0);
});
test('native menus update labels without changing Electron roles',t=>{
 const language=createAppLanguage({dataPath:fixture(t)});language.setLanguage('en');
 const source=[{label:'편집',submenu:[{role:'copy'},{role:'paste'}]}];
 assert.deepEqual(language.menu(source),[{label:'Edit',submenu:[{role:'copy',label:'Copy'},{role:'paste',label:'Paste'}]}]);
 language.setLanguage('ko');assert.equal(language.menu(source)[0].label,'편집');assert.equal(source[0].submenu[0].label,undefined);
});
