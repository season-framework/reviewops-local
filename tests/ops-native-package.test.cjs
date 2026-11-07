'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {finished}=require('node:stream/promises');
const asar=require('@electron/asar');

async function archiveFixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reviewops-ops-native-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repository=path.join(root,'reviewed'),source=path.join(root,'package'),archive=path.join(root,'app.asar');
  const files={'electron/ops-manager.cjs':'// reviewed manager','electron/ops-qa.cjs':'// reviewed goal QA bridge','electron/ops-skills.cjs':'// reviewed skill registry','electron/ops-skill-package.cjs':'// reviewed ZIP validation','electron/ops-skills-ipc.cjs':'// reviewed typed skill IPC','electron/ops-workspace-context.cjs':'// reviewed immutable target',
    'electron/ops-skills-bundled/github-issue-management/SKILL.md':'review instructions','electron/ops-skills-bundled/github-issue-management/references/writing.md':'review references',
    'electron/ops-skills-bundled/qa-usability-report/SKILL.md':'QA instructions','electron/ops-skills-bundled/qa-usability-report/agents/openai.yaml':'interface: {}','electron/ops-skills-bundled/qa-usability-report/scripts/report.py':'raise Exception("never execute")','electron/ops-skills-bundled/qa-usability-report/assets/example.png':Buffer.from([0,255,42]),'electron/ops-skills-bundled/qa-usability-report/assets/template.json':'{"template":true}',
    'node_modules/js-yaml/package.json':JSON.stringify({version:'4.3.2',exports:{'.':{require:'./index.js'}}}),'node_modules/js-yaml/index.js':'module.exports={};',
    'node_modules/argparse/package.json':JSON.stringify({version:'2.0.1',main:'argparse.js'}),'node_modules/argparse/argparse.js':'module.exports={};',
    'node_modules/cron-parser/package.json':JSON.stringify({version:'5.10.4',main:'dist/index.js'}),
    'node_modules/cron-parser/dist/index.js':'module.exports={};',
    'node_modules/luxon/package.json':JSON.stringify({version:'3.7.2',main:'build/node/luxon.js'}),
    'node_modules/luxon/build/node/luxon.js':'module.exports={};'};
  for(const [name,bytes]of Object.entries(files))for(const base of [repository,source]){
    const file=path.join(base,...name.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
  }
  await fs.writeFile(path.join(repository,'package-lock.json'),JSON.stringify({packages:{'node_modules/cron-parser':{version:'5.10.4'},'node_modules/luxon':{version:'3.7.2'},'node_modules/js-yaml':{version:'4.3.2'},'node_modules/argparse':{version:'2.0.1'}}}));
  const pack=async()=>{asar.uncache(archive);await finished(await asar.createPackage(source,archive));asar.uncache(archive);};
  await pack();return {repository,source,archive,pack,resources:Object.keys(files).filter(name=>name.startsWith('electron/ops-skills-bundled/')).sort()};
}

test('native Ops verification binds all Ops modules and bundled cron dependencies to reviewed source',async t=>{
  const f=await archiveFixture(t),{inspectOpsArchive}=await import('../scripts/ops-native-smoke.mjs');
  assert.deepEqual(inspectOpsArchive(f.archive,{repository:f.repository,asar}),{sourceModules:['ops-manager.cjs','ops-qa.cjs','ops-skill-package.cjs','ops-skills-ipc.cjs','ops-skills.cjs','ops-workspace-context.cjs'],skillResources:f.resources,dependencies:{'cron-parser':'5.10.4',luxon:'3.7.2','js-yaml':'4.3.2',argparse:'2.0.1'}});
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
test('native Ops verification rejects a changed or missing skill resource and unexpected added bundle content',async t=>{
 const {inspectOpsArchive}=await import('../scripts/ops-native-smoke.mjs');
 for(const mode of ['changed','missing','extra']){const f=await archiveFixture(t),image=path.join(f.source,'electron/ops-skills-bundled/qa-usability-report/assets/example.png');if(mode==='changed')await fs.writeFile(image,Buffer.from([255,0,42]));else if(mode==='missing')await fs.rm(image);else await fs.writeFile(path.join(f.source,'electron/ops-skills-bundled/qa-usability-report/unreviewed.txt'),'not reviewed');await f.pack();assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}),/Packaged skill resource/);}
});
test('native Ops verification rejects source and packaged resource symlinks instead of following them',async t=>{
 const {inspectOpsArchive}=await import('../scripts/ops-native-smoke.mjs'),f=await archiveFixture(t),relative='electron/ops-skills-bundled/qa-usability-report/link.txt';await fs.symlink('SKILL.md',path.join(f.source,relative));await f.pack();assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}),/Packaged skill links/);await fs.rm(path.join(f.source,relative));await fs.symlink('SKILL.md',path.join(f.repository,relative));await f.pack();assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}),/Invalid reviewed skill resource/);
});
test('native Ops verification requires the actual production YAML loader and rejects an escaping require export',async t=>{
 const {inspectOpsArchive}=await import('../scripts/ops-native-smoke.mjs'),f=await archiveFixture(t);await fs.rm(path.join(f.source,'node_modules/js-yaml/index.js'));await f.pack();assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}));await fs.writeFile(path.join(f.source,'node_modules/js-yaml/index.js'),'module.exports={};');await fs.writeFile(path.join(f.source,'node_modules/js-yaml/package.json'),JSON.stringify({version:'4.3.2',exports:{'.':{require:'../argparse/argparse.js'}}}));await f.pack();assert.throws(()=>inspectOpsArchive(f.archive,{repository:f.repository,asar}),/Invalid dependency entry/);
});
