'use strict';
// Renderer/catalog checks only; no Electron, app, host registration or screen QA.
const test=require('node:test'),assert=require('node:assert/strict');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const catalog=require('../src/i18n/en.json');
const t=(key,values=[])=>String(catalog[key]||key).replace(/\{(\d+)\}/g,(_,index)=>String(values[index]??''));
const metadata={contract:'logical-qa-controller-v1',label:'Agent B',projectId:'project-b',state:'attached',generation:1};
const modulePromise=import('../src/qa-controller-badge.mjs');
async function render(controller,projectId='project-b'){const {QaControllerBadge}=await modulePromise;return renderToStaticMarkup(React.createElement(QaControllerBadge,{projectId,projectName:'Project B',controller,t}));}
test('legacy scope stays unchanged without public controller metadata',async()=>{
 const html=await render(null);assert.match(html,/>Project QA<\/span>/);assert.doesNotMatch(html,/controller|Project B|data-qa-controller/);
});
test('the own project label and attached/detached/unknown state are visible and escaped',async()=>{
 for(const [state,label]of [['attached','Connected'],['detached','Disconnected'],['unknown','Status unavailable']]){const html=await render({...metadata,state,label:'Agent <B> & peer'});assert.match(html,/Project B/);assert.match(html,/QA controller: Agent &lt;B&gt; &amp; peer/);assert.ok(html.includes(label));assert.ok(html.includes('data-qa-controller-state="'+state+'"'));assert.doesNotMatch(html,/<B>/);}
});
test('release, foreign project, invalid contract and private extra fields clear the displayed owner',async()=>{
 const {qaControllerMetadata}=await modulePromise;
 for(const value of [{...metadata,state:'released'},{...metadata,projectId:'project-a'},{...metadata,contract:'other'},{...metadata,proof:'PRIVATE-RESUME-PROOF'},{...metadata,controllerId:'PRIVATE-CONTROLLER-ID'},{...metadata,generation:0},{...metadata,label:'Agent\nB'}]){assert.equal(qaControllerMetadata(value,'project-b'),null);const html=await render(value);assert.doesNotMatch(html,/Agent|PRIVATE|controller|data-qa-controller/);}
});
test('a new controller generation can start again without treating its label as ownership authority',async()=>{
 const {qaControllerMetadata}=await modulePromise;const prior=qaControllerMetadata({...metadata,generation:8},'project-b'),next=qaControllerMetadata({...metadata,label:'New Agent',generation:1},'project-b');assert.equal(prior.generation,8);assert.equal(next.generation,1);assert.ok((await render(next)).includes('New Agent'));
});
test('new English labels retain source placeholders and contain no private protocol fields',()=>{
 for(const key of ['QA 제어자: {0}','QA 제어 연결됨','QA 제어 연결 끊김','QA 제어 상태 확인 필요']){assert.equal(typeof catalog[key],'string');assert.deepEqual(catalog[key].match(/\{\d+\}/g)||[],key.match(/\{\d+\}/g)||[]);assert.doesNotMatch(catalog[key],/[가-힣]|proof|token|controllerId/);}
});
