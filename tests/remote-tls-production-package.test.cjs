'use strict';

// Exercise the actual pinned packager's production collector and an isolated
// module image. These tests do not build/sign/launch an app or use OS storage.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {TmpDir}=require('builder-util');
const {NpmNodeModulesCollector}=require('app-builder-lib/out/node-module-collector/npmNodeModulesCollector.js');
const run=promisify(execFile),repository=path.resolve(__dirname,'..');
const pkg=require('../package.json'),lock=require('../package-lock.json');
const required={'@peculiar/asn1-schema':'3.0.0',asn1js:'4.0.0'};

test('TLS runtime peers are explicit pinned production dependencies in package and lock metadata',()=>{
 for(const [name,version]of Object.entries(required)){
  assert.equal(pkg.dependencies[name],version,'The production packager must see the runtime peer as a direct dependency');
  assert.equal(lock.packages[''].dependencies[name],version);
  assert.equal(lock.packages['node_modules/'+name].version,version);
  assert.notEqual(lock.packages['node_modules/'+name].dev,true);
 }
});

function copyCollected(modules,parent){
 for(const item of modules){
  const destination=path.join(parent,'node_modules',item.name);fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.cpSync(item.dir,destination,{recursive:true,filter:file=>!path.relative(item.dir,file).split(path.sep).includes('node_modules')});
  if(item.dependencies)copyCollected(item.dependencies,destination);
 }
}
test('actual production collection omits peer-only TLS imports before and closes the complete import graph after explicit declarations',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-tls-package-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const explicit of [false,true]){
  const label=explicit?'explicit-production':'peer-only',project=path.join(root,label),image=path.join(root,'image-'+label);fs.mkdirSync(project);
  const dependencies=Object.fromEntries(['@peculiar/x509','reflect-metadata',...(explicit?Object.keys(required):[])].map(name=>[name,pkg.dependencies[name]]));
  fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'owned-tls-package-fixture',version:'0.0.0',dependencies}));
  fs.symlinkSync(path.join(repository,'node_modules'),path.join(project,'node_modules'),process.platform==='win32'?'junction':'dir');
  const temporary=new TmpDir();let collected;
  try{collected=await new NpmNodeModulesCollector(project,temporary).getNodeModules({packageName:'owned-tls-package-fixture'});}
  finally{await temporary.cleanup();}
  copyCollected(collected.nodeModules,image);
  fs.mkdirSync(path.join(image,'electron'),{recursive:true});fs.copyFileSync(path.join(repository,'electron/remote-tls.cjs'),path.join(image,'electron/remote-tls.cjs'));
  const env={...process.env};delete env.NODE_PATH;delete env.NODE_OPTIONS;delete env.ELECTRON_RUN_AS_NODE;
  const script=`try{const tls=require(process.argv[1]);if(typeof tls.createRemoteCertificate!=='function'||typeof tls.createRemoteTLSLease!=='function')throw new Error('Invalid runtime API');console.log(JSON.stringify({ok:true}));}catch(error){console.log(JSON.stringify({ok:false,code:['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND'].includes(error.code)?error.code:'IMPORT_REFUSED'}));}`;
  const observed=await run(process.execPath,['-e',script,path.join(image,'electron/remote-tls.cjs')],{cwd:image,env,timeout:15000});
  const result=JSON.parse(observed.stdout);
  if(explicit)assert.deepEqual(result,{ok:true},'The complete packaged TLS dependency graph must import without source node_modules fallback');
  else{assert.equal(result.ok,false);assert.ok(['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND'].includes(result.code),'The original peer-only graph must reproduce the missing import');}
 }
});
