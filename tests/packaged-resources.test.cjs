'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const asar=require('@electron/asar'),afterPack=require('../scripts/after-pack.cjs');
const build={channel:'test',version:'1.2.11',buildNumber:10002,commit:'a'.repeat(40),builtAt:'2026-11-01T16:00:00.000Z'};
async function fixture(t,{missingCategory=false}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-packaged-resources-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const source=path.join(directory,'source'),resources=path.join(directory,'resources'),archive=path.join(resources,'app.asar');
 await fs.mkdir(path.join(source,'electron'),{recursive:true});await fs.mkdir(resources);
 await fs.writeFile(path.join(source,'package.json'),JSON.stringify({version:build.version}));await fs.writeFile(path.join(source,'electron/reviewops-build.json'),JSON.stringify(build));
 for(const name of ['mcp-server.cjs','automation-api.cjs','review-categories.json'])if(!missingCategory||name!=='review-categories.json')await fs.copyFile(path.join(__dirname,'../electron',name),path.join(source,'electron',name));
 await asar.createPackage(source,archive);return {directory,resources,archive,context:{appOutDir:directory,packager:{getResourcesDir:()=>resources}}};
}
test('afterPack preserves the canonical ASAR category data and makes identical standalone MCP copies',async t=>{
 const f=await fixture(t);await afterPack(f.context);const {packagedBuildInfo}=await import('../scripts/test-build.mjs');
 assert.deepEqual(packagedBuildInfo(f.archive,build),build);
 for(const [source,target]of [['mcp-server.cjs','reviewops-mcp.cjs'],['automation-api.cjs','automation-api.cjs'],['review-categories.json','review-categories.json']])assert.deepEqual(asar.extractFile(f.archive,path.join('electron',source)),await fs.readFile(path.join(f.resources,'mcp',target)));
});
test('a standalone category copy cannot conceal the missing module needed by the app',async t=>{
 const f=await fixture(t,{missingCategory:true});await fs.mkdir(path.join(f.resources,'mcp'));await fs.copyFile(path.join(__dirname,'../electron/review-categories.json'),path.join(f.resources,'mcp/review-categories.json'));
 await assert.rejects(afterPack(f.context),/review-categories.json/);
 const {packagedBuildInfo}=await import('../scripts/test-build.mjs');assert.throws(()=>packagedBuildInfo(f.archive,build));
});
test('native package inspection rejects a mismatched standalone catalog',async t=>{
 const f=await fixture(t);await afterPack(f.context);await fs.writeFile(path.join(f.resources,'mcp/review-categories.json'),'{}');
 const {packagedBuildInfo}=await import('../scripts/test-build.mjs');assert.throws(()=>packagedBuildInfo(f.archive,build),/배포 자료가 다릅니다: review-categories.json/);
});
