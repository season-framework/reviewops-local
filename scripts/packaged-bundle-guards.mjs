// Read-only bundle verification. Importing this module launches nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const within=(base,value)=>value===base||value.startsWith(base+path.sep);
const relative=value=>typeof value==='string'&&value.length>0&&!path.isAbsolute(value)&&!value.split(/[\\/]/).some(part=>!part||part==='.'||part==='..');
export const readBoundedJSON=(file,max=8*1024*1024)=>{assert.ok(fs.statSync(file).isFile());assert.ok(fs.statSync(file).size<=max);return JSON.parse(fs.readFileSync(file,'utf8'));};
export function inventory(directory,base=directory,rows=[]){
 for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const file=path.join(directory,entry.name),rel=path.relative(base,file).split(path.sep).join('/');
  assert.ok(rows.length<20000,'Bundle inventory budget exceeded');
  if(entry.isSymbolicLink()){
   assert.ok(within(base,fs.realpathSync(file)),'Bundle symlink escapes the private app');
   rows.push({path:rel,kind:'symlink',target:fs.readlinkSync(file)});
  }else if(entry.isDirectory())inventory(file,base,rows);
  else{assert.ok(entry.isFile(),'Unsupported bundle file type');rows.push({path:rel,kind:'file',bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))});}
 }
 return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
export function verifyPackagedBundle({root,appPath,privateInstallRoot,manifestPath,expectedHead,expectedVersion,buildFiles,sourceManifestSHA256,rendererBuildRecordSHA256,asar,expectedTarget,installReceiptPath}){
 assert.ok(path.isAbsolute(appPath)&&path.isAbsolute(privateInstallRoot)&&path.isAbsolute(manifestPath));
 const install=fs.realpathSync(privateInstallRoot),app=fs.realpathSync(appPath),temporary=fs.realpathSync(os.tmpdir());
 const permitted=[temporary,path.join(fs.realpathSync(root),'.local-data')];
 if(process.platform==='darwin')permitted.push(fs.realpathSync('/tmp'));
 if(process.env.RUNNER_TEMP)permitted.push(fs.realpathSync(process.env.RUNNER_TEMP));
 assert.ok(permitted.some(base=>install!==base&&within(base,install)),'Dedicated private installed/extracted app only');
 assert.ok(install.split(path.sep).some(part=>/^(owned-service-|reviewops-|ro-owned-ui-|rv-on-)/.test(part)));
 assert.equal(expectedTarget,process.platform+'-'+process.arch);
 const mac=process.platform==='darwin',appRoot=mac?app:path.dirname(app);
 assert.ok(within(install,app));if(mac){assert.equal(path.dirname(app),install);assert.equal(path.basename(app),'ReviewOps.app');}else assert.equal(path.basename(app),'ReviewOps.exe');
 assert.equal(path.resolve(appPath),app,'No app alias');assert.equal(fs.lstatSync(app).isSymbolicLink(),false);
 const manifest=readBoundedJSON(manifestPath);assert.equal(manifest.schema,1);assert.equal(manifest.source,expectedHead);assert.equal(manifest.version,expectedVersion);assert.equal(manifest.platform,process.platform);assert.equal(manifest.arch,process.arch);assert.equal(manifest.privateInstallRoot,install);assert.equal(manifest.appPath,app);assert.equal(manifest.sourceManifestSHA256,sourceManifestSHA256);assert.equal(manifest.rendererBuildRecordSHA256,rendererBuildRecordSHA256);
 assert.ok(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=20000);assert.ok(Array.isArray(manifest.symlinks)&&manifest.symlinks.length<=20000);
 const seen=new Set();for(const row of [...manifest.files,...manifest.symlinks]){assert.ok(relative(row.path)&&!seen.has(row.path));seen.add(row.path);}
 const actual=inventory(appRoot),regular=actual.filter(row=>row.kind==='file').map(({kind,...row})=>row),symlinks=actual.filter(row=>row.kind==='symlink').map(({kind,...row})=>row);
 assert.deepEqual(regular,manifest.files.slice().sort((a,b)=>a.path.localeCompare(b.path)),'Every regular bundle file must match the root-reviewed manifest');assert.deepEqual(symlinks,manifest.symlinks.slice().sort((a,b)=>a.path.localeCompare(b.path)),'Every bundle symlink must match the root-reviewed manifest');
 const resources=path.join(appRoot,...(mac?['Contents','Resources']:['resources'])),archive=path.join(resources,'app.asar'),executable=mac?path.join(app,'Contents','MacOS','ReviewOps'):app,bootstrap=path.join(resources,'owned-services','owned-node-bootstrap.cjs');
 for(const required of [executable,archive,bootstrap])assert.ok(manifest.files.some(row=>row.path===path.relative(appRoot,required).split(path.sep).join('/')),'Missing required physical bundle file');
 if(!mac){
  assert.ok(installReceiptPath,'Real NSIS receipt required');const receipt=readBoundedJSON(installReceiptPath);
  assert.equal(receipt.schema,1);assert.equal(receipt.source,expectedHead);assert.equal(receipt.target,expectedTarget);assert.equal(receipt.installationCompleted,true);
  assert.equal(fs.realpathSync(receipt.installationRoot),appRoot);assert.equal(fs.realpathSync(receipt.executablePath),app);assert.equal(receipt.pe.machine,'0x8664');assert.equal(receipt.version,expectedVersion);
  assert.equal(fs.realpathSync(receipt.archivePath),archive);assert.equal(receipt.archiveSHA256,hash(fs.readFileSync(archive)));assert.equal(receipt.installerSHA256,hash(fs.readFileSync(receipt.installerPath)));
 }
 fs.accessSync(executable,fs.constants.X_OK);
 for(const [key,file]of [['asar',archive],['bootstrap',bootstrap]]){const row=manifest.files.find(value=>value.path===path.relative(appRoot,file).split(path.sep).join('/'));assert.deepEqual(manifest[key],row,key+' summary must match its physical file row');}
 assert.ok(Array.isArray(manifest.archiveEntries)&&manifest.archiveEntries.length>0&&manifest.archiveEntries.length<=20000);
 const entries=new Map();for(const row of manifest.archiveEntries){assert.ok(relative(row.path)&&!entries.has(row.path)&&/^[a-f0-9]{64}$/.test(row.sha256));const bytes=asar.extractFile(archive,path.join(...row.path.split('/')));assert.equal(bytes.length,row.bytes);assert.equal(hash(bytes),row.sha256,row.path);entries.set(row.path,row);}
 const sourceModules=['electron/main.cjs','electron/browser.cjs','electron/project-service-runtime.cjs','electron/owned-node-bootstrap.cjs','electron/codex/runtime.cjs','electron/codex/index.cjs','electron/agents.cjs','electron/model-targets.cjs','electron/preload.cjs','electron/build-info.cjs'];
 for(const name of sourceModules){assert.ok(entries.has(name),'Missing source-fidelity archive entry '+name);assert.equal(entries.get(name).sha256,hash(fs.readFileSync(path.join(root,name))),name+' differs from reviewed source');}
 for(const row of buildFiles){assert.ok(row.path.startsWith('dist/'));assert.ok(entries.has(row.path),'Missing built renderer archive entry '+row.path);assert.equal(entries.get(row.path).sha256,row.sha256,row.path);}
 const archivedDist=asar.listPackage(archive).map(name=>name.replaceAll('\\','/').replace(/^\/+(?=.)/,'')).filter(name=>name.startsWith('dist/')&&!asar.statFile(archive,path.join(...name.split('/'))).files);
 assert.deepEqual(archivedDist.sort(),buildFiles.map(row=>row.path).sort(),'Build record must cover every packaged renderer file');
 assert.equal(hash(fs.readFileSync(bootstrap)),entries.get('electron/owned-node-bootstrap.cjs').sha256,'Physical bootstrap must equal its canonical ASAR/source copy');
 assert.ok(entries.has('package.json'),'Missing packaged package.json manifest row');
 const packagedPackage=JSON.parse(asar.extractFile(archive,'package.json').toString()),sourcePackage=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.equal(packagedPackage.version,expectedVersion);assert.equal(packagedPackage.name,sourcePackage.name);
 if(manifest.build!==undefined){assert.equal(manifest.build.commit,expectedHead);assert.equal(manifest.build.version,expectedVersion);assert.deepEqual(JSON.parse(asar.extractFile(archive,path.join('electron','reviewops-build.json')).toString()),manifest.build);}
 return {source:expectedHead,version:expectedVersion,appPath:app,privateInstallRoot:install,executablePath:executable,resourcesPath:resources,appArchivePath:archive,manifestPath,manifestSHA256:hash(fs.readFileSync(manifestPath)),sourceManifestSHA256,rendererBuildRecordSHA256,bundleFiles:actual.length,appArchiveSHA256:hash(fs.readFileSync(archive)),physicalBootstrapSHA256:hash(fs.readFileSync(bootstrap)),rendererFiles:archivedDist.length,build:manifest.build||null};
}
