'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {inspectDirectory,requireDirectory,createChildDirectory}=require('../electron/work-directory.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-directory-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('folder checks distinguish a missing path, a file, and inaccessible folders',async t=>{
 const root=await fixture(t),file=path.join(root,'file');await fs.writeFile(file,'keep');
 assert.equal((await inspectDirectory(root)).status,'ready');
 assert.equal((await inspectDirectory(path.join(root,'missing'))).status,'missing');
 assert.equal((await inspectDirectory(file)).status,'not_directory');
 assert.equal((await inspectDirectory('relative')).status,'invalid');
 const denied={...fs,access:async()=>{throw Object.assign(new Error('private details'),{code:'EACCES'})}};
 const result=await inspectDirectory(root,{filesystem:denied});assert.equal(result.status,'inaccessible');assert.ok(!result.message.includes('private details'));
 await assert.rejects(requireDirectory(root,{filesystem:denied}),{code:'AGENT_WORK_PATH_INACCESSIBLE'});
});

test('folder creation creates only one named child in the selected existing parent',async t=>{
 const root=await fixture(t);const made=await createChildDirectory(root,'새 프로젝트');
 assert.equal(made,path.join(await fs.realpath(root),'새 프로젝트'));assert.equal((await fs.stat(made)).isDirectory(),true);
 await fs.writeFile(path.join(made,'keep'),'unchanged');
 await assert.rejects(createChildDirectory(root,'새 프로젝트'),{code:'DIRECTORY_EXISTS'});
 for(const name of ['../escape','nested/child','nested\\child','.','..','CON',' name','name.'])await assert.rejects(createChildDirectory(root,name),{code:'DIRECTORY_NAME_INVALID'});
 await assert.rejects(createChildDirectory(path.join(root,'missing-parent'),'child'),{code:'AGENT_WORK_PATH_MISSING'});
 assert.deepEqual(await fs.readdir(root),['새 프로젝트']);assert.equal(await fs.readFile(path.join(made,'keep'),'utf8'),'unchanged');
});

test('deletion after a successful folder check is caught on the next check',async t=>{
 const root=await fixture(t),work=await createChildDirectory(root,'work');assert.equal(await requireDirectory(work),work);
 await fs.rmdir(work);await assert.rejects(requireDirectory(work),{code:'AGENT_WORK_PATH_MISSING'});
});
