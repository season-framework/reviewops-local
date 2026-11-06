'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {finished}=require('node:stream/promises');
const asar=require('@electron/asar');

async function archiveFixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-ops-native-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repository=path.join(root,'reviewed'),source=path.join(root,'package'),archive=path.join(root,'app.asar');
  const files={'electron/ops-manager.cjs':'// reviewed manager','electron/ops-qa.cjs':'// reviewed goal QA bridge',
    'node_modules/cron-parser/package.json':JSON.stringify({version:'5.10.4',main:'dist/index.js'}),
    'node_modules/cron-parser/dist/index.js':'module.exports={};',
    'node_modules/luxon/package.json':JSON.stringify({version:'3.7.2',main:'build/node/luxon.js'}),
    'node_modules/luxon/build/node/luxon.js':'module.exports={};'};
  for(const [name,bytes]of Object.entries(files))for(const base of [repository,source]){
    const file=path.join(base,...name.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
  }
  await fs.writeFile(path.join(repository,'package-lock.json'),JSON.stringify({packages:{'node_modules/cron-parser':{version:'5.10.4'},'node_modules/luxon':{version:'3.7.2'}}}));
  const pack=async()=>{asar.uncache(archive);await finished(await asar.createPackage(source,archive));asar.uncache(archive);};
  await pack();return {repository,source,archive,pack};
}

test('native Ops verification binds all Ops modules and bundled cron dependencies to reviewed source',async t=>{
  const f=await archiveFixture(t),{inspectOpsArchive}=await import('../scripts/ops-native-smoke.mjs');
  assert.deepEqual(inspectOpsArchive(f.archive,{repository:f.repository,asar}),{sourceModules:['ops-manager.cjs','ops-qa.cjs'],dependencies:{'cron-parser':'5.10.4',luxon:'3.7.2'}});
  await fs.appendFile(path.join(f.source,'electron/ops-qa.cjs'),' changed');await f.pack();
  assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}),/Packaged Ops source differs/);
});
test('native Ops verification refuses missing or mismatched bundled scheduler dependencies',async t=>{
  const f=await archiveFixture(t),{inspectOpsArchive}=await import('../scripts/ops-native-smoke.mjs');
  await fs.rm(path.join(f.source,'node_modules/cron-parser/dist/index.js'));await f.pack();
  assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}));
  await fs.writeFile(path.join(f.source,'node_modules/cron-parser/dist/index.js'),'module.exports={};');
  await fs.writeFile(path.join(f.source,'node_modules/luxon/package.json'),JSON.stringify({version:'0.0.0',main:'build/node/luxon.js'}));await f.pack();
  assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}),/dependency version differs/);
});
test('native Ops verification rejects dependency entries escaping their package',async t=>{
  const f=await archiveFixture(t),{inspectOpsArchive}=await import('../scripts/ops-native-smoke.mjs');
  await fs.writeFile(path.join(f.source,'node_modules/luxon/package.json'),JSON.stringify({version:'3.7.2',main:'../cron-parser/dist/index.js'}));await f.pack();
  assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}),/Invalid dependency entry/);
});
