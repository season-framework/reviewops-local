'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {filePathVariants,agentFileCandidates,readAgentOutput} = require('../electron/agent-files.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-agent-files-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'work','docs'),{recursive:true});
  const work = path.join(root,'work');
  return {root,work,config:{kind:'local',rootPath:work}};
}

test('the saved ReviewOps development-log link strips its line number',async t=>{
  const {work,config}=await fixture(t);
  await fs.writeFile(path.join(work,'docs/development-log.md'),'# 배포 재시도 기록');
  for(const suffix of [':8305',':8263',':8305:2','#L8305','#L8305-L8310']) {
    const file=await readAgentOutput(config,path.join(work,'docs/development-log.md')+suffix);
    assert.equal(file.content,'# 배포 재시도 기록');
    assert.equal(file.name,'development-log.md');
  }
});

test('spaces, parentheses, percent signs and hash characters remain valid filenames',async t=>{
  const {work,config}=await fixture(t);
  for(const name of ['결과 보고서(최종).md','진행률100%.md','결과#2026.md','결과%20.md']) {
    await fs.writeFile(path.join(work,name),name);
    assert.equal((await readAgentOutput(config,name)).content,name);
  }
  assert.equal((await readAgentOutput(config,'<결과 보고서(최종).md>')).name,'결과 보고서(최종).md');
});

test('file and sandbox URLs decode their paths without treating section fragments as filenames',async t=>{
  const {work,config}=await fixture(t),target=path.join(work,'결과 보고서.md');
  await fs.writeFile(target,'URL_RESULT');
  assert.equal((await readAgentOutput(config,pathToFileURL(target).href+'#L10')).content,'URL_RESULT');
  assert.equal((await readAgentOutput(config,'sandbox:'+encodeURI(target))).content,'URL_RESULT');
  await fs.writeFile(path.join(work,'report'),'BASE_FILE');await fs.writeFile(path.join(work,'report#L12'),'LITERAL_HASH');
  assert.equal((await readAgentOutput(config,pathToFileURL(path.join(work,'report#L12')).href)).content,'LITERAL_HASH');
  assert.throws(()=>filePathVariants('file://another-server/work/file.md'),/프로젝트에 연결한 폴더/);
  for(const value of ['https://example.test/report.md','javascript:alert(1)','bad\0file','bad\\file']) assert.throws(()=>filePathVariants(value));
});

test('nested Markdown resolves relative links next to the current document and keeps work-root links compatible',async t=>{
  const {work,config}=await fixture(t);
  await fs.writeFile(path.join(work,'docs/next.md'),'DOC_NEXT');
  await fs.writeFile(path.join(work,'top.md'),'ROOT_FILE');
  const basePath=path.join(work,'docs/current.md');
  assert.equal((await readAgentOutput(config,'./next.md',{basePath})).content,'DOC_NEXT');
  assert.equal((await readAgentOutput(config,'top.md',{basePath})).content,'ROOT_FILE');
  assert.equal((await readAgentOutput(config,'docs/next.md',{basePath})).content,'DOC_NEXT');
  assert.equal((await readAgentOutput(config,'docs/next.md#section')).content,'DOC_NEXT');
});

test('local canonical path aliases work while traversal and symlink escapes remain rejected',async t=>{
  const {root,work,config}=await fixture(t),alias=path.join(root,'alias');
  await fs.symlink(work,alias);await fs.writeFile(path.join(work,'result.md'),'INSIDE');
  const canonical=await fs.realpath(work);
  assert.equal((await readAgentOutput({...config,rootPath:alias},path.join(canonical,'result.md'))).content,'INSIDE');
  await fs.writeFile(path.join(root,'private.md'),'OUTSIDE');await fs.symlink(path.join(root,'private.md'),path.join(work,'escape.md'));
  for(const value of ['../private.md',path.join(root,'private.md'),'escape.md']) await assert.rejects(readAgentOutput(config,value),/작업 폴더/);
  await assert.rejects(readAgentOutput(config,'missing.md'),{code:'AGENT_FILE_NOT_FOUND'});
});

test('remote reads preserve the selected run folder, nested bases, raw bytes and specific SSH failures',async()=>{
  const calls=[],config={kind:'ssh',rootPath:'/opt/spring',host:'fixture.test'};
  const ssh={async read(actual,value,options){calls.push({actual,value,options});if(value==='/opt/spring/docs/next.md')return{path:'docs/next.md',name:'next.md',mimeType:'text/markdown',content:'SSH_FILE',...(options.raw?{bytes:Buffer.from('SSH_FILE')}:{})};throw Object.assign(new Error('missing'),{code:'SSH_FILE_NOT_FOUND'});}};
  const result=await readAgentOutput(config,'./next.md:8305',{ssh,basePath:'/opt/spring/docs/current.md',raw:true});
  assert.equal(result.content,'SSH_FILE');assert.equal(result.absolutePath,'/opt/spring/docs/next.md');assert.equal(result.bytes.toString(),'SSH_FILE');assert.equal(calls[0].actual.rootPath,'/opt/spring');
  const denied={async read(){throw Object.assign(new Error('denied'),{code:'SSH_PERMISSION_DENIED'});}};
  await assert.rejects(readAgentOutput(config,'file.md',{ssh:denied}),{code:'SSH_PERMISSION_DENIED'});
  assert.deepEqual(agentFileCandidates('/opt/spring','~/report.md'),['~/report.md']);
});
