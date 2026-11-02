'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const read=()=>import('../src/codex/runtime-diagnostics.mjs');
const row=(index=0)=>({kind:'abnormal-exit',path:'$HOME/codex-'+index,version:null,architecture:'arm64',code:137,signal:'SIGKILL',elapsedMs:10});

test('diagnostic copy includes only safe fields and preserves missing and abnormal-exit distinctions',async()=>{
 const {runtimeDiagnostics}=await read();
 const result=runtimeDiagnostics({records:[{...row(),stderr:'secret-stderr',env:{TOKEN:'private-token'},prompt:'private-prompt'},{kind:'missing',path:null}],omitted:0,auth:'private-auth'});
 assert.equal(result.records.length,2);assert.equal(result.records[0].signal,'SIGKILL');assert.equal(result.records[1].kind,'missing');assert.equal(result.records[1].path,null);
 assert.doesNotMatch(JSON.stringify(result),/private-|secret-|stderr|TOKEN|prompt|auth|Signature|서명/);
 assert.deepEqual(Object.keys(result.records[0]),['kind','path','version','architecture','code','signal','elapsedMs']);
});

test('malformed diagnostic fields are omitted rather than guessed and record counts stay bounded',async()=>{
 const {runtimeDiagnostics}=await read();
 const result=runtimeDiagnostics({records:[{...row(),kind:'untrusted'},{...row(),path:'bad\npath'},{...row(),version:'Bearer token',architecture:'secret-arch',code:'private-code',signal:'secret-signal',elapsedMs:-1},...Array.from({length:20},(_,index)=>row(index))],omitted:0});
 assert.ok(result.records.length<=16);assert.ok(result.omitted>=7);
 const value=result.records[0];assert.equal(value.version,null);assert.equal(value.architecture,null);assert.equal(value.code,null);assert.equal(value.signal,null);assert.equal(value.elapsedMs,null);
});

test('UTF-8 copy budget keeps the most recent records and accounts for removals',async()=>{
 const {runtimeDiagnostics}=await read();
 const input=Array.from({length:16},(_,index)=>({...row(index),path:'$HOME/'+'가'.repeat(300)+'/'+index}));
 const result=runtimeDiagnostics({records:input,omitted:2});
 assert.ok(new TextEncoder().encode(JSON.stringify(result,null,2)).length<=16*1024);assert.ok(result.records.length<16);assert.ok(result.omitted>2);
 assert.equal(result.records.at(-1).path,input.at(-1).path);
});
