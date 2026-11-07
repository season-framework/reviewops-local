'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {copyIdentityDiagnostic,captureIdentityDiagnostic,legacyIdentityDiagnostic,identityDiagnosticRecord,retainedIdentityDiagnostic}=require('../electron/remote-identity-diagnostics.cjs');
const pending=Buffer.from('Synthetic canonical pending snapshot; no real identity');
test('identity diagnostics copy only known own data fields and never provider text, accessors or arbitrary status',()=>{
 const secret='Synthetic private provider message must not escape';let accessed=false;
 const error=Object.assign(new Error(secret),{code:'ITEM_CREATE_FAILED',osStatus:-25308,mayRemain:true,cause:secret});
 const value=captureIdentityDiagnostic({stage:'create-protected-item',error,cleanup:'not-attempted'});
 assert.deepEqual(value,{version:1,source:'live-operation',stage:'create-protected-item',code:'ITEM_CREATE_FAILED',osStatus:-25308,mayRemain:true,cleanup:'not-attempted'});
 assert.equal(JSON.stringify(value).includes(secret),false);
 const unsafe={get code(){accessed=true;return secret;},osStatus:12345678,mayRemain:false};
 const unknown=captureIdentityDiagnostic({stage:'create-protected-item',error:unsafe,cleanup:'not-attempted'});
 assert.equal(accessed,false);assert.equal(unknown.code,'UNKNOWN');assert.equal(unknown.osStatus,null);assert.equal(unknown.mayRemain,null);
 assert.throws(()=>copyIdentityDiagnostic({...value,message:secret}),e=>e.code==='IDENTITY_UNAVAILABLE'&&!e.message.includes(secret));
 assert.throws(()=>copyIdentityDiagnostic(new Proxy(value,{ownKeys(){throw new Error(secret);}})),e=>e.code==='IDENTITY_UNAVAILABLE'&&!e.message.includes(secret));
});
test('retained diagnostic needs exact original intent bytes and cannot relabel a current preflight as a historical create',()=>{
 const live=captureIdentityDiagnostic({stage:'create-protected-item',error:{code:'DEFAULT_LOCKED',osStatus:null,mayRemain:false},cleanup:'not-attempted'});
 const record=identityDiagnosticRecord(pending,live),restored=retainedIdentityDiagnostic(record,pending);
 assert.equal(restored.source,'retained-intent');assert.equal(restored.code,'DEFAULT_LOCKED');
 assert.deepEqual(retainedIdentityDiagnostic(record,Buffer.from('Another intent')),legacyIdentityDiagnostic());
 const current=captureIdentityDiagnostic({stage:'backend-preflight',error:{code:'DEFAULT_LOCKED'},mayRemain:false,cleanup:'not-needed'});
 assert.throws(()=>identityDiagnosticRecord(pending,current),{code:'IDENTITY_UNAVAILABLE'});
 assert.deepEqual(retainedIdentityDiagnostic({...record,diagnostic:current},pending),legacyIdentityDiagnostic());
});
test('uncertain own cleanup overrides a less cautious native flag and legacy history remains wholly unknown',()=>{
 const value=captureIdentityDiagnostic({stage:'publish-index',error:{code:'ITEM_CREATE_FAILED',osStatus:-25308,mayRemain:false},cleanup:'unconfirmed'});
 assert.equal(value.mayRemain,true);
 assert.throws(()=>copyIdentityDiagnostic({...value,mayRemain:false}),{code:'IDENTITY_UNAVAILABLE'});
 assert.throws(()=>copyIdentityDiagnostic({...legacyIdentityDiagnostic(),code:'DEFAULT_LOCKED'}),{code:'IDENTITY_UNAVAILABLE'});
});
