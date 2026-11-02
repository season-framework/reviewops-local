import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {sourceIdentity} from '../scripts/native-adapters.mjs';
import {verifyReviewedGitFiles} from '../scripts/native-packet.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const bounded=promise=>promise;
const url='http://127.0.0.1:43123/';
function nativeFixture(){
 let views=[];
 const view=id=>({webContents:{id,isDestroyed:()=>false,getURL:()=>url,getBackgroundThrottling:()=>true}});
 const clip={id:9,isDestroyed:()=>false,getParentWindow:()=>({id:7}),isVisible:()=>true,contentView:{get children(){return views;}}};
 return {
  application:{browserWindow:async()=>({evaluate:async fn=>fn({id:7})}),evaluate:async(fn,args)=>fn({BrowserWindow:{getAllWindows:()=>[clip]}},args)},
  ipc:async()=>({url}),setCount:count=>{views=Array.from({length:count},(_,i)=>view(20+i));},clip,
 };
}

test('a pending exact source may be retried, while capture lookup remains strict',async()=>{
 const f=nativeFixture(),read=options=>sourceIdentity(f.application,{},url,'owned-browser',f.ipc,bounded,options);
 await assert.rejects(read(),/Expected one exact source/);
 assert.equal(await read({allowPending:true}),null);
 f.setCount(1);const ready=await read({allowPending:true});
 assert.equal(ready.webContentsId,20);assert.equal(ready.parentWindowId,7);assert.equal(ready.url,url);
 assert.deepEqual(await read(),ready);
});

test('pending lookup rejects duplicate matches and never adopts another host source',async()=>{
 const f=nativeFixture(),read=()=>sourceIdentity(f.application,{},url,'owned-browser',f.ipc,bounded,{allowPending:true});
 f.setCount(2);await assert.rejects(read(),/Expected one exact source/);
 f.setCount(1);f.clip.getParentWindow=()=>({id:99});assert.equal(await read(),null);
});

test('reviewed Git bytes and CRLF checkout bytes retain separate exact hashes',t=>{
 const repository=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-git-evidence-'));
 t.after(()=>fs.rmSync(repository,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:repository,stdio:['ignore','pipe','pipe']});
 git('init','-q');git('config','user.name','Evidence fixture');git('config','user.email','fixture@example.invalid');git('config','core.autocrlf','true');
 const file=path.join(repository,'component.jsx'),canonical=Buffer.from('export const label = "검사";\n// reviewed source\n');
 fs.writeFileSync(file,canonical);git('add','component.jsx');git('commit','-qm','Reviewed fixture');
 const source=git('rev-parse','HEAD').toString().trim();fs.unlinkSync(file);git('checkout','HEAD','--','component.jsx');
 const checkout=fs.readFileSync(file);assert.ok(checkout.includes(Buffer.from('\r\n')));assert.notEqual(hash(checkout),hash(canonical));
 const options={repository,source,expectedFiles:[{path:'component.jsx',sha256:hash(checkout)}],files:[{path:'component.jsx',sha256:hash(canonical),bytes:canonical.length}]};
 const [actual]=verifyReviewedGitFiles(options);assert.equal(actual.gitBlobSHA256,hash(canonical));assert.equal(actual.checkoutSHA256,hash(checkout));
 assert.throws(()=>verifyReviewedGitFiles({...options,files:[{path:'component.jsx',sha256:hash(checkout)}]}),/reviewed Git blob/);
 assert.throws(()=>verifyReviewedGitFiles({...options,expectedFiles:[{path:'component.jsx',sha256:hash(canonical)}]}),/actual checkout bytes/);
 fs.appendFileSync(file,'// unreviewed\r\n');assert.throws(()=>verifyReviewedGitFiles(options));
});
