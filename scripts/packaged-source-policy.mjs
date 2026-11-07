// Read-only package source admission. Git bookkeeping is not app runtime data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const control='electron/native/.gitignore';
const nativeNames=['electron/native/remote-identity-manifest.json','electron/native/remote-identity-darwin-arm64.node','electron/native/remote-identity-darwin-x64.node'];
const archiveName=name=>path.join(...name.split('/'));
const normalize=name=>name.replaceAll('\\','/').replace(/^\//,'');
export function expectedPackagedSourceFiles(sourceFiles,archiveFiles){
 const present=new Set(archiveFiles.map(normalize));
 // Compare it too if a producer intentionally included it. Only this exact
 // missing repository-control file is optional; runtime files never are.
 return sourceFiles.filter(name=>name!==control||present.has(name));
}
export function comparePackagedCheckout(archive,{repository,asar,mismatchMessage=name=>`Packaged file does not match its source: ${name}`}){
 const files=[],visit=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);assert.equal(entry.isSymbolicLink(),false,`Unexpected source symlink: ${file}`);if(entry.isDirectory())visit(file);else if(entry.isFile())files.push(file);}};
 visit(path.join(repository,'electron'));visit(path.join(repository,'dist'));files.push(...['LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt'].map(name=>path.join(repository,name)));
 const names=files.map(file=>path.relative(repository,file).split(path.sep).join('/')),selected=expectedPackagedSourceFiles(names,asar.listPackage(archive));
 for(const name of selected)assert.deepEqual(asar.extractFile(archive,archiveName(name)),fs.readFileSync(path.join(repository,...name.split('/'))),mismatchMessage(name));
 return {files:selected,omittedRepositoryControlFiles:names.filter(name=>!selected.includes(name))};
}
export function comparePackagedElectronTree(archive,{asar,sourceFiles,readSource,platform=process.platform}){
 const all=asar.listPackage(archive).map(normalize),files=[];
 for(const name of all.filter(name=>name.startsWith('electron/'))){const stat=asar.statFile(archive,archiveName(name),false);assert.ok(!stat.link,`Packaged Electron source link is not allowed: ${name}`);if(!stat.files&&name!=='electron/reviewops-build.json')files.push(name);}
 const expected=expectedPackagedSourceFiles(sourceFiles,files),generated=platform==='darwin'?nativeNames:[];
 assert.deepEqual(files.slice().sort(),[...expected,...generated].sort(),'The installed Electron tree must exactly match reviewed source and validated native identity files.');
 const source=expected.map(name=>{const bytes=asar.extractFile(archive,archiveName(name));assert.deepEqual(bytes,readSource(name),`Installed source differs from embedded commit: ${name}`);return {path:name,sha256:hash(bytes)};});
 const generatedNative=[];
 if(platform==='darwin'){
  const directory=path.join(archive+'.unpacked','electron','native');require('./verify-remote-identity.cjs').verify(directory);
  for(const name of nativeNames){const bytes=asar.extractFile(archive,archiveName(name)),physical=fs.readFileSync(path.join(archive+'.unpacked',...name.split('/')));assert.deepEqual(bytes,physical,`Packaged native identity differs from verified final bytes: ${name}`);generatedNative.push({path:name,sha256:hash(bytes)});}
 }
 return {source,generatedNative,omittedRepositoryControlFiles:sourceFiles.filter(name=>!expected.includes(name))};
}
