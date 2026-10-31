'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createQaAutomation}=require('../electron/qa-automation.cjs');
function fixture(){
  const records=new Map(),commands=[];let time=1,gate;
  const create=projectId=>{
    const contents={isDestroyed:()=>false,debugger:{isAttached:()=>true,sendCommand:async(method,args)=>{commands.push({projectId,method,args});if(projectId==='a'&&gate)await gate;}},executeJavaScript:async()=>false};
    const record={id:'window-'+projectId,projectId,host:{webContents:contents,isDestroyed:()=>false,close(){this.isDestroyed=()=>true;}}};records.set(record.id,record);return record;
  };
  const api=createQaAutomation({getProject:id=>['a','b'].includes(id),getWindow:id=>records.get(id),openWindow:async({projectId})=>create(projectId),now:()=>time,sessionTimeoutMs:100});
  return {api,records,commands,setTime:value=>time=value,setGate:value=>gate=value};
}
const only=({sessionId,projectId,windowId})=>({sessionId,projectId,windowId});
test('QA locks one project to a client and rejects another window identity',async()=>{
 const {api,commands}=fixture(),a=only(await api.handle('open',{projectId:'a',clientId:'codex-a'})),b=only(await api.handle('open',{projectId:'b',clientId:'codex-b'}));
 assert.deepEqual(only(await api.handle('open',{projectId:'a',clientId:'codex-a'})),a);
 await assert.rejects(api.handle('open',{projectId:'a',clientId:'claude-a'}),{code:'PROJECT_BUSY'});
 assert.throws(()=>api.handle('type',{...a,windowId:b.windowId,text:'wrong'}),{code:'SESSION_MISMATCH'});
 assert.throws(()=>api.handle('type',{...a,projectId:b.projectId,text:'wrong'}),{code:'SESSION_MISMATCH'});
 await assert.rejects(api.handle('type',{...a,browserId:'other',text:'wrong'}),{code:'TARGET_MISMATCH'});
 assert.equal(commands.length,0);
});
test('a blocked input in A does not delay B and same-project inputs retain order',async()=>{
 const f=fixture(),a=only(await f.api.handle('open',{projectId:'a',clientId:'codex-a'})),b=only(await f.api.handle('open',{projectId:'b',clientId:'claude-b'}));
 let unblock;f.setGate(new Promise(resolve=>unblock=resolve));
 const first=f.api.handle('type',{...a,text:'A-1'}),second=f.api.handle('type',{...a,text:'A-2'});
 await f.api.handle('type',{...b,text:'B'});
 assert.deepEqual(f.commands.map(c=>c.args.text),['A-1','B']);
 unblock();await Promise.all([first,second]);assert.deepEqual(f.commands.map(c=>c.args.text),['A-1','B','A-2']);
});
test('closed windows and released or expired sessions cannot receive input',async()=>{
 const f=fixture();let a=only(await f.api.handle('open',{projectId:'a',clientId:'codex-a'}));
 await f.api.handle('release',a);assert.throws(()=>f.api.handle('type',{...a,text:'bad'}),{code:'SESSION_MISMATCH'});
 a=only(await f.api.handle('open',{projectId:'a',clientId:'claude-a'}));f.setTime(102);
 assert.throws(()=>f.api.handle('type',{...a,text:'bad'}),{code:'SESSION_EXPIRED'});
 a=only(await f.api.handle('open',{projectId:'a',clientId:'claude-a'}));
 f.records.get(a.windowId).host.isDestroyed=()=>true;
 assert.throws(()=>f.api.handle('type',{...a,text:'bad'}),{code:'TARGET_CLOSED'});assert.equal(f.commands.length,0);
});
test('unsaved input blocks close and reload without global native prompts',async()=>{
 const f=fixture(),a=only(await f.api.handle('open',{projectId:'a',clientId:'codex-a'}));f.records.get(a.windowId).host.webContents.executeJavaScript=async()=>true;
 await assert.rejects(f.api.handle('close',a),{code:'UNSAVED_INPUT'});await assert.rejects(f.api.handle('reload',a),{code:'UNSAVED_INPUT'});
 assert.equal(f.records.get(a.windowId).host.isDestroyed(),false);
});
test('concurrent opens of a project share one pending initialization and recover failed opens',async()=>{
 let resolve,calls=0;const record={id:'window-a',projectId:'a',host:{isDestroyed:()=>false}};
 const api=createQaAutomation({getProject:()=>true,getWindow:()=>record,openWindow:async()=>{calls++;return new Promise(done=>resolve=done);}});
 const first=api.handle('open',{projectId:'a',clientId:'one'}),second=api.handle('open',{projectId:'a',clientId:'one'});
 resolve(record);assert.deepEqual(await first,await second);assert.equal(calls,1);
 let failures=0;const retry=createQaAutomation({getProject:()=>true,getWindow:()=>record,openWindow:async()=>{if(!failures++)throw new Error('failed');return record;}});
 await assert.rejects(retry.handle('open',{projectId:'a',clientId:'one'}),/failed/);assert.equal((await retry.handle('open',{projectId:'a',clientId:'two'})).windowId,'window-a');
});
test('same-client reconnect keeps the bound review and refreshes idle time',async()=>{
 const f=fixture(),a=only(await f.api.handle('open',{projectId:'a',clientId:'same',reviewId:'review-a'}));
 await assert.rejects(f.api.handle('open',{projectId:'a',clientId:'same',reviewId:'review-other'}),{code:'REVIEW_MISMATCH'});
 f.setTime(80);assert.deepEqual(only(await f.api.handle('open',{projectId:'a',clientId:'same',reviewId:'review-a'})),a);
 f.setTime(160);await f.api.handle('type',{...a,text:'alive'});
});
test('timed-out commands cannot share their old window with another session',async()=>{
 let done,record={id:'window-a',projectId:'a',host:{isDestroyed:()=>false,webContents:{isDestroyed:()=>false,debugger:{isAttached:()=>true,sendCommand:()=>new Promise(resolve=>done=resolve)}}}};
 const api=createQaAutomation({getProject:()=>true,getWindow:()=>record,openWindow:async()=>record,operationTimeoutMs:15});
 const a=only(await api.handle('open',{projectId:'a',clientId:'one'}));
 await assert.rejects(api.handle('type',{...a,text:'pending'}),{code:'QA_TIMEOUT'});
 await api.handle('release',a);
 await assert.rejects(api.handle('open',{projectId:'a',clientId:'two'}),{code:'QA_TARGET_UNAVAILABLE'});
 done();record.host.isDestroyed=()=>true;
 await assert.rejects(api.handle('open',{projectId:'a',clientId:'two'}),{code:'TARGET_CLOSED'});
 record={...record,id:'window-new',host:{...record.host,isDestroyed:()=>false}};
 assert.equal((await api.handle('open',{projectId:'a',clientId:'two'})).windowId,'window-new');
});
