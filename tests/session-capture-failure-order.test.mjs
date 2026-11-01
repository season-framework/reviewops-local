import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
for(const stem of ['qa-viewer-sessions','live-web-sessions']){
 const source=fs.readFileSync(new URL(`../scripts/e2e-${stem}.mjs`,import.meta.url),'utf8');
 const start=source.lastIndexOf('}catch(error){')+'}catch(error){'.length,end=source.indexOf('\nfinally{',start);assert.ok(start>0&&end>start);
 const body=source.slice(start,end).replace(/}\s*$/,'');
 const execute=new AsyncFunction('error','captureDiagnostics','app','fs','path','output','process','a','source','home','checks','readSessionCaptureDiagnostics','readSessionCaptureFailureFacts','probeSessionCaptureAfterFailure','origin',body);
 function fixture({probe='1',failStorage=false}={}){
  const events=[],stored=new Map(),original=new Error('original QA selector failure');let visibility='original-hidden';
  const page={isClosed:()=>false,screenshot:async()=>{events.push('original-png');}};
  const storage={writeFileSync:(file,text)=>{const name=path.basename(file);events.push(name);if(failStorage)throw new Error('diagnostic storage failure');stored.set(name,JSON.parse(text));}};
  const readTrace=async()=>{events.push('trace:'+visibility);return {visibility};};
  const readFacts=async()=>{events.push('effectful-browser-state');visibility='facts-synchronized';return {error:'fixture error'};};
  const postProbe=async()=>{events.push('optional-false-probe');return {diagnosticOnly:true,originalQaResult:'failed'};};
  return {events,stored,original,run:()=>execute(original,true,{},storage,path,'output',{env:{REVIEWOPS_CAPTURE_POSTFAILURE_PROBE:probe},platform:'unit',arch:'unit'},page,page,page,[],readTrace,readFacts,postProbe,'http://127.0.0.1:1234')};
 }
 test(stem+': untouched failure snapshot precedes effectful facts and optional probe',async()=>{const f=fixture();await assert.rejects(f.run(),e=>e===f.original);const before=f.stored.get('capture-diagnostics-before-facts.json'),after=f.stored.get('capture-diagnostics-after-facts.json');assert.equal(before.observationPhase,'before-effectful-browser-state');assert.equal(before.visibility,'original-hidden');assert.equal(after.observationPhase,'after-effectful-browser-state');assert.equal(after.visibility,'facts-synchronized');const i=x=>f.events.indexOf(x);assert.ok(i('original-png')<i('capture-original-failure.json'));assert.ok(i('capture-original-failure.json')<i('trace:original-hidden'));assert.ok(i('capture-diagnostics-before-facts.json')<i('effectful-browser-state'));assert.ok(i('capture-diagnostics-after-facts.json')<i('optional-false-probe'));assert.equal(f.stored.get('capture-postfailure-probe.json').originalQaResult,'failed');});
 test(stem+': disabling optional probe still preserves both labeled baselines',async()=>{const f=fixture({probe:'0'});await assert.rejects(f.run(),e=>e===f.original);assert.ok(f.stored.has('capture-diagnostics-before-facts.json'));assert.ok(f.stored.has('capture-diagnostics-after-facts.json'));assert.ok(!f.events.includes('optional-false-probe'));});
 test(stem+': diagnostic storage failure cannot replace original QA error',async()=>{const f=fixture({failStorage:true});await assert.rejects(f.run(),e=>e===f.original);assert.ok(!f.events.includes('effectful-browser-state'));});
}
