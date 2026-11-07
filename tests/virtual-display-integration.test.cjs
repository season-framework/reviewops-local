'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {FileMatcher}=require('app-builder-lib/out/fileMatcher');

test('packaging excludes experimental drivers, native helpers and diagnostic entry points',()=>{
 const root=path.resolve(__dirname,'..'),config=require('../package.json').build;
 const matcher=new FileMatcher(root,path.join(root,'release'),value=>value,config.files).createFilter();
 const included=relative=>{const filename=path.join(root,relative);return matcher(filename,fs.statSync(filename));};
 assert.equal(included('electron/main.cjs'),true);
 assert.equal(included('package.json'),true);
 const walk=directory=>fs.readdirSync(path.join(root,directory),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
 const excluded=[...walk('experiments/macos-virtual-display'),...walk('experiments/windows-virtual-display'),
  'scripts/hidden-web-capture-probe.mjs','scripts/hidden-web-capture-probe-app.cjs','scripts/hidden-web-capture-probe-common.cjs'];
 assert.ok(excluded.length>50);
 for(const filename of excluded)assert.equal(included(filename),false,filename+' must not enter the application package');
 for(const extra of ['extraFiles','extraResources'])assert.equal(config[extra],undefined,'Experimental helpers need a separate reviewed delivery change');
});
