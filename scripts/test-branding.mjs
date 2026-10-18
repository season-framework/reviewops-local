import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import electronExecutable from 'electron';

// Each process uses generated test values and an isolated internal vault.
// It does not open the application's data or any operating-system credential store.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSource = await fs.readFile(path.join(repository, 'electron/main.cjs'), 'utf8');
assert.equal(mainSource.includes('safeStorage'), false, 'The application must not access Electron safeStorage');
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-branding-'));
const fixturePath = path.join(testRoot, 'synthetic-hashes.json');
const dataPath = path.join(testRoot, 'data');
const probeSource = String.raw`
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createVault } = require(process.env.PROBE_VAULT_PATH);
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
app.setName('ReviewOps');
const beforeReadyName = app.getName();
app.setPath('userData', process.env.REVIEWOPS_DATA_DIR);
app.setPath('sessionData', path.join(process.env.REVIEWOPS_DATA_DIR, 'session'));
app.whenReady().then(() => {
  assert.equal(app.getName(), 'ReviewOps');
  assert.equal(beforeReadyName, 'ReviewOps');
  assert.equal(app.getPath('userData'), process.env.REVIEWOPS_DATA_DIR);
  const window = new BrowserWindow({show:false,title:'ReviewOps',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  assert.equal(window.getTitle(), 'ReviewOps');
  const unusedKeychain = new Proxy({}, {get() {throw new Error('Keychain must never be accessed');}});
  const file = path.join(process.env.REVIEWOPS_DATA_DIR, 'credentials.json');
  const vault = createVault(file, unusedKeychain);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const generate = () => crypto.randomBytes(48).toString('base64');
  let fixtures;
  if (process.env.PROBE_PHASE === 'create') {
    const password = generate(), passphrase = generate();
    vault.commit('synthetic-service', vault.prepare({password,passphrase}));
    const serialized = fs.readFileSync(file, 'utf8');
    assert.equal(serialized.includes(password), false);
    assert.equal(serialized.includes(passphrase), false);
    fixtures = {password:hash(password),passphrase:hash(passphrase)};
  } else {
    fixtures = JSON.parse(fs.readFileSync(process.env.PROBE_FIXTURE_PATH,'utf8'));
    const credentials = vault.get('synthetic-service');
    assert.equal(hash(credentials.password), fixtures.password);
    assert.equal(hash(credentials.passphrase), fixtures.passphrase);
    if (process.env.PROBE_PHASE === 'update') {
      const password = generate();
      vault.commit('synthetic-service', vault.prepare({password,passphrase:''}));
      fixtures.password = hash(password);
      assert.equal(vault.get('synthetic-service').passphrase, credentials.passphrase);
    }
  }
  assert.deepEqual(vault.flags('synthetic-service'), {hasPassword:true,hasPassphrase:true});
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file+'.key').mode & 0o777, 0o600);
  assert.equal(fs.statSync(process.env.REVIEWOPS_DATA_DIR).mode & 0o777, 0o700);
  fs.writeFileSync(process.env.PROBE_FIXTURE_PATH, JSON.stringify(fixtures), {mode:0o600});
  window.destroy();
  process.stdout.write(JSON.stringify({phase:process.env.PROBE_PHASE,beforeReadyName,displayName:app.getName(),fixturesVerified:2,keychainAccesses:0})+'\n');
  app.quit();
}).catch(error => {process.stderr.write(error.name+': '+error.message+'\n');app.exit(1);});
`;

async function probe(phase) {
  const appDirectory = path.join(testRoot, phase);
  await fs.mkdir(appDirectory);
  await fs.writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({name:'reviewops-branding-probe',productName:'ReviewOps',version:'1.0.0',main:'main.cjs'}));
  await fs.writeFile(path.join(appDirectory, 'main.cjs'), probeSource);
  const env = {...process.env,REVIEWOPS_DATA_DIR:dataPath,PROBE_PHASE:phase,PROBE_FIXTURE_PATH:fixturePath,PROBE_VAULT_PATH:path.join(repository,'electron/vault.cjs')};
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve,reject) => {
    const child = spawn(electronExecutable,[appDirectory],{env,stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    const timeout = setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Internal vault ${phase} probe timed out`));},30000);
    child.stdout.on('data',data=>{stdout+=data;});
    child.stderr.on('data',data=>{stderr+=data;});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('exit',code=>{
      clearTimeout(timeout);
      if(code!==0) return reject(new Error(`Internal vault ${phase} probe failed (${code}): ${stderr.slice(-2000)}`));
      try {resolve(JSON.parse(stdout.trim().split('\n').at(-1)));}
      catch {reject(new Error(`Internal vault ${phase} probe returned no result`));}
    });
  });
}

try {
  await fs.mkdir(dataPath);
  await fs.mkdir(path.join(dataPath,'session'));
  for (const phase of ['create','update','restart']) {
    const result = await probe(phase);
    assert.equal(result.beforeReadyName, 'ReviewOps');
    assert.equal(result.displayName, 'ReviewOps');
    assert.equal(result.fixturesVerified, 2);
    assert.equal(result.keychainAccesses, 0);
  }
  console.log('PASS: ReviewOps application and window branding remain consistent before and after initialization');
  console.log('PASS: internal encrypted credentials survive update and restart without keychain access');
  console.log('PASS: isolated data directory; no application vault or real credentials read');
} finally {
  await fs.rm(testRoot,{recursive:true,force:true});
}
