'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { inspectAccountImport, importAccounts } = require('../electron/codex/import-accounts.cjs');
const { AccountService } = require('../electron/codex/account-service.cjs');

const encoded = value => JSON.stringify(value, null, 2) + '\n';
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const present = async file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const mode = async file => (await fs.stat(file)).mode & 0o777;
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : encoded(value)); }
function account(index, extra = {}) {
  const id = crypto.randomUUID(), email = `fixture-${index}@example.invalid`, time = new Date().toISOString();
  return {
    id, label: `이관 계정 ${index}`, email, planType: 'pro', status: 'ready', authStarted: true, lastUpdated: time,
    usage: { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1900000000 } }, rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1900000000 } } }, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'fixture-credit', status: 'available', resetType: 'codexRateLimits', grantedAt: 1 }] } },
    statistics: { version: 1, email, trackingStartedAt: time, updatedAt: time, usageFetchedAt: time, usageError: null,
      tokenUsage: { summary: { lifetimeTokens: 321, peakDailyTokens: 123, longestRunningTurnSec: 4, currentStreakDays: 2, longestStreakDays: 3 }, dailyUsageBuckets: [{ startDate: time.slice(0, 10), tokens: 123 }] },
      snapshots: [{ time, buckets: [{ limitId: 'codex', limitName: null, primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: null }], creditBalance: 0, creditsUnlimited: false, resetCredits: 1 }], resets: [] },
    resetAttempt: { idempotencyKey: crypto.randomUUID(), creditId: 'fixture-credit', accountEmail: email, status: 'completed', outcome: 'reset', startedAt: time, completedAt: time, needsRefresh: false },
    ...extra,
  };
}
async function fixture(t, count = 3, { store = 'keyring', auth = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-import-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, 'source'), targetDir = path.join(directory, 'target');
  const accounts = Array.from({ length: count }, (_, i) => account(i + 1));
  const activity = Array.from({ length: 100 }, (_, i) => ({ id: `fixture-activity-${i}`, time: new Date(Date.now() - (100 - i) * 1000).toISOString(), accountId: i % 3 === 0 ? crypto.randomUUID() : accounts[0]?.id || '', label: '활동', type: i % 2 ? 'global' : 'info', message: `저장한 활동 ${i}`, extra: { keep: i } }));
  const data = { version: 1, accounts, activity, importedExtension: { unchanged: true } };
  await write(path.join(sourceDir, 'accounts.json'), data);
  for (const row of accounts) {
    const profile = path.join(sourceDir, 'profiles', row.id);
    await write(path.join(profile, 'config.toml'), `cli_auth_credentials_store = "${store}"\nmodel = "fixture-model"\n`);
    await write(path.join(profile, 'models_cache.json'), { models: [{ id: 'fixture-model' }] });
    if (auth) await write(path.join(profile, 'auth.json'), { tokens: { access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token' } });
  }
  return { directory, sourceDir, targetDir, data, run: options => importAccounts({ sourceDir, targetDir, allowImport: true, ...options }) };
}
async function tree(directory) {
  const result = {};
  async function walk(current, prefix) {
    for (const name of (await fs.readdir(current)).sort()) {
      const absolute = path.join(current, name), relative = path.join(prefix, name), stat = await fs.lstat(absolute);
      result[relative] = { mode: stat.mode & 0o777, hash: stat.isFile() ? crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex') : stat.isSymbolicLink() ? await fs.readlink(absolute) : null };
      if (stat.isDirectory()) await walk(absolute, relative);
    }
  }
  await walk(directory, ''); return result;
}
async function service(t, h, clientFactory = () => { throw new Error('Unexpected RPC'); }) {
  const value = new AccountService({ dataDir: h.targetDir, command: '/fixture/codex', clientFactory });
  await value.init(); t.after(() => value.close()); return value;
}

test('import is opt-in and does not inspect or create files without explicit authorization', async t => {
  const h = await fixture(t, 1);
  await assert.rejects(importAccounts({ sourceDir: path.join(h.directory, 'missing'), targetDir: h.targetDir }), /명시적으로/);
  assert.equal(await present(h.targetDir), false);
});

test('metadata, reset request identity, cached statistics and all source activity are copied without changing the source', async t => {
  const h = await fixture(t), before = await tree(h.sourceDir);
  await fs.mkdir(h.targetDir);
  const existing = account(50), duplicate = { ...h.data.activity[5], message: 'ReviewOps에서 유지할 활동' };
  await write(path.join(h.targetDir, 'accounts.json'), { version: 1, accounts: [existing], activity: [duplicate] });
  const inspection = await inspectAccountImport(h);
  assert.deepEqual(inspection, { accountCount: 3, usageCount: 3, statisticsCount: 3, resetAttemptCount: 3, activityCount: 100, fileAuthCount: 0, requiresLoginCount: 3, runtimePresent: false, existingAccountCount: 1 });
  const result = await h.run(), saved = await read(path.join(h.targetDir, 'accounts.json'));
  assert.equal(result.importedCount, 3); assert.equal(result.requiresLoginCount, 3); assert.equal(result.authCopiedCount, 0); assert.equal(result.activityImportedCount, 99);
  assert.deepEqual(saved.accounts[0], existing);
  for (let i = 0; i < 3; i++) assert.deepEqual(saved.accounts[i + 1], { ...h.data.accounts[i], requiresLogin: true, status: 'signedOut', authStarted: false });
  assert.equal(saved.activity.length, 100); assert.deepEqual(saved.activity.find(row => row.id === duplicate.id), duplicate);
  assert.deepEqual(saved.activity.find(row => row.id === h.data.activity[0].id), h.data.activity[0]);
  assert.equal(saved.activity.some(row => !h.data.accounts.some(account => account.id === row.accountId)), true);
  assert.equal(await fs.readFile(path.join(result.archivePath, 'source-accounts.json'), 'utf8'), encoded(h.data));
  assert.equal(await fs.readFile(path.join(result.archivePath, 'target-accounts-before.json'), 'utf8'), encoded({ version: 1, accounts: [existing], activity: [duplicate] }));
  assert.deepEqual(await tree(h.sourceDir), before);
  assert.equal(await mode(h.targetDir), 0o700); assert.equal(await mode(result.archivePath), 0o700);
  assert.equal(await mode(path.join(result.archivePath, 'source-accounts.json')), 0o600); assert.equal(await mode(path.join(h.targetDir, 'accounts.json')), 0o600);
  assert.equal(await present(path.join(result.archivePath, 'staged-profiles')), false);
  for (const row of h.data.accounts) {
    assert.equal(await mode(path.join(h.targetDir, 'profiles', row.id)), 0o700);
    assert.equal(await present(path.join(h.targetDir, 'profiles', row.id, 'auth.json')), false);
    assert.equal(await fs.readFile(path.join(h.targetDir, 'profiles', row.id, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n');
    assert.equal(await fs.readFile(path.join(result.archivePath, 'source-profile-configs', row.id + '.toml'), 'utf8'), 'cli_auth_credentials_store = "keyring"\nmodel = "fixture-model"\n');
  }
});

test('Keychain-only accounts stay signed out after startup and cannot refresh or redeem reset credits', async t => {
  const h = await fixture(t); await h.run(); let clients = 0;
  const value = await service(t, h, () => { clients++; throw new Error('Unexpected RPC'); });
  for (const row of value.snapshot().accounts) { assert.equal(row.requiresLogin, true); assert.equal(row.status, 'signedOut'); }
  const details = value.getAccountDetails(h.data.accounts[0].id);
  assert.equal(details.tokenUsage.summary.lifetimeTokens, 321); assert.equal(details.snapshots.length, 1); assert.equal(details.resets.length, 1);
  await value.refreshAccounts();
  assert.deepEqual(await value.refreshAccountDetails(h.data.accounts[0].id), details);
  await assert.rejects(value.resetAccounts([h.data.accounts[0].id]), /다시 로그인/);
  assert.equal(clients, 0);
  const saved = await read(path.join(h.targetDir, 'accounts.json'));
  assert.equal(saved.accounts[0].requiresLogin, true); assert.equal(saved.accounts[0].authStarted, false);
  assert.deepEqual(saved.accounts[0].resetAttempt.idempotencyKey, h.data.accounts[0].resetAttempt.idempotencyKey);
  await value.close();
  const restarted = await service(t, h, () => { clients++; throw new Error('Unexpected RPC'); });
  assert.equal(restarted.snapshot().accounts[0].requiresLogin, true);
  await restarted.removeAccount(h.data.accounts[0].id);
  assert.equal(clients, 0);
});

test('an incomplete reset remains uncertain and is never replayed during account import or startup', async t => {
  const h = await fixture(t, 1), attempt = h.data.accounts[0].resetAttempt;
  attempt.status = 'pending'; delete attempt.completedAt; delete attempt.outcome; attempt.needsRefresh = true;
  await write(path.join(h.sourceDir, 'accounts.json'), h.data); const result = await h.run();
  assert.deepEqual((await read(path.join(h.targetDir, 'accounts.json'))).accounts[0].resetAttempt, attempt);
  const value = await service(t, h), saved = await read(path.join(h.targetDir, 'accounts.json'));
  assert.equal(saved.accounts[0].resetAttempt.status, 'uncertain'); assert.equal(saved.accounts[0].resetAttempt.idempotencyKey, attempt.idempotencyKey);
  assert.equal(value.getAccountDetails(h.data.accounts[0].id).resets[0].outcome, 'uncertain');
  assert.deepEqual((await read(path.join(result.archivePath, 'source-accounts.json'))).accounts[0].resetAttempt, attempt);
});

test('file credentials are copied privately while obsolete files in keyring profiles are not activated', async t => {
  const h = await fixture(t, 2, { store: 'file', auth: true });
  const obsolete = h.data.accounts[1];
  await write(path.join(h.sourceDir, 'profiles', obsolete.id, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  const before = await tree(h.sourceDir), result = await h.run(), saved = await read(path.join(h.targetDir, 'accounts.json'));
  assert.equal(result.authCopiedCount, 1); assert.equal(result.requiresLoginCount, 1);
  assert.equal(saved.accounts[0].requiresLogin, undefined); assert.equal(saved.accounts[0].authStarted, true); assert.equal(saved.accounts[0].status, 'ready');
  const profile = path.join(h.targetDir, 'profiles', saved.accounts[0].id);
  assert.deepEqual(await fs.readFile(path.join(profile, 'auth.json')), await fs.readFile(path.join(h.sourceDir, 'profiles', saved.accounts[0].id, 'auth.json')));
  assert.equal(await mode(path.join(profile, 'auth.json')), 0o600); assert.equal(await mode(profile), 0o700);
  assert.equal(await present(path.join(h.targetDir, 'profiles', obsolete.id, 'auth.json')), false);
  assert.deepEqual(await tree(h.sourceDir), before); assert.equal(await present(path.join(result.archivePath, 'staged-profiles')), false);
});

test('existing accounts, profiles and runtime are preserved and repeated import never recreates removed accounts', async t => {
  const h = await fixture(t, 3, { store: 'file', auth: true });
  const existing = { ...h.data.accounts[0], label: '기존 계정 이름', requiresLogin: true };
  const oldProfile = path.join(h.targetDir, 'profiles', h.data.accounts[1].id);
  await write(path.join(h.targetDir, 'accounts.json'), { version: 1, accounts: [existing], activity: [] });
  await write(path.join(oldProfile, 'keep.txt'), '기존 파일');
  await write(path.join(h.targetDir, 'runtime.json'), { path: '/existing/codex' });
  await write(path.join(h.sourceDir, 'runtime.json'), { path: '/source/codex' });
  const first = await h.run(); assert.equal(first.importedCount, 1); assert.equal(first.skippedCount, 2); assert.equal(first.runtimeImported, false);
  let saved = await read(path.join(h.targetDir, 'accounts.json'));
  assert.deepEqual(saved.accounts[0], existing); assert.equal(await fs.readFile(path.join(oldProfile, 'keep.txt'), 'utf8'), '기존 파일');
  assert.deepEqual(await read(path.join(h.targetDir, 'runtime.json')), { path: '/existing/codex' });
  const archiveNames = await fs.readdir(path.join(h.targetDir, 'imports'));
  const second = await h.run(); assert.equal(second.alreadyImported, true); assert.equal(second.importedCount, 0);
  saved.accounts = saved.accounts.filter(row => row.id !== h.data.accounts[2].id); await write(path.join(h.targetDir, 'accounts.json'), saved);
  await fs.rm(path.join(h.targetDir, 'profiles', h.data.accounts[2].id), { recursive: true });
  assert.equal((await h.run()).alreadyImported, true);
  assert.equal((await read(path.join(h.targetDir, 'accounts.json'))).accounts.some(row => row.id === h.data.accounts[2].id), false);
  assert.deepEqual(await fs.readdir(path.join(h.targetDir, 'imports')), archiveNames);
});

test('runtime configuration is archived and reused only when its executable survives independently', async t => {
  const h = await fixture(t, 1), binary = path.join(h.directory, 'independent-codex'); await write(binary, '#!/bin/sh\nexit 0\n');
  await write(path.join(h.sourceDir, 'runtime.json'), { path: binary, additional: 'preserve in archive' });
  const result = await h.run(); assert.equal(result.runtimeImported, true);
  assert.deepEqual(await read(path.join(h.targetDir, 'runtime.json')), { path: binary });
  assert.deepEqual(await read(path.join(result.archivePath, 'source-runtime.json')), { path: binary, additional: 'preserve in archive' });
  const second = await fixture(t, 1), appBinary = path.join(second.directory, 'Codex Account Manager.app', 'Contents', 'Resources', 'codex');
  await write(appBinary, 'fixture'); await write(path.join(second.sourceDir, 'runtime.json'), { path: appBinary });
  const skipped = await second.run(); assert.equal(skipped.runtimeImported, false); assert.equal(await present(path.join(second.targetDir, 'runtime.json')), false);
  assert.equal(await present(path.join(skipped.archivePath, 'source-runtime.json')), true);
});

test('prepared imports resume after interruption and remove staged credentials and temporary ownership markers', async t => {
  const h = await fixture(t, 1, { store: 'file', auth: true });
  await assert.rejects(h.run({ beforeCommit: () => { throw new Error('synthetic interruption'); } }), /synthetic interruption/);
  assert.equal(await present(path.join(h.targetDir, '.account-import.lock')), false);
  const archive = path.join(h.targetDir, 'imports', (await fs.readdir(path.join(h.targetDir, 'imports')))[0]);
  assert.equal(await present(path.join(archive, 'staged-profiles', h.data.accounts[0].id, 'auth.json')), true);
  const result = await h.run(); assert.equal(result.alreadyImported, true);
  assert.equal((await read(path.join(h.targetDir, 'accounts.json'))).accounts.length, 1);
  assert.equal(await present(path.join(archive, 'completed.json')), true); assert.equal(await present(path.join(archive, 'staged-profiles')), false);
  assert.equal(await present(path.join(h.targetDir, 'profiles', h.data.accounts[0].id, '.account-import-owner.json')), false);
});

test('recovery after accounts.json commit also removes credential staging and keeps existing account content', async t => {
  const h = await fixture(t, 1, { store: 'file', auth: true });
  await assert.rejects(h.run({ beforeCommit: () => { throw new Error('synthetic interruption'); } }), /synthetic interruption/);
  const archive = path.join(h.targetDir, 'imports', (await fs.readdir(path.join(h.targetDir, 'imports')))[0]), plan = await read(path.join(archive, 'plan.json'));
  const destination = path.join(h.targetDir, 'profiles', h.data.accounts[0].id);
  await fs.cp(path.join(archive, 'staged-profiles', h.data.accounts[0].id), destination, { recursive: true });
  await write(path.join(destination, '.account-import-owner.json'), { archiveName: path.basename(archive) });
  await write(path.join(h.targetDir, 'accounts.json'), { version: 1, accounts: plan.rows, activity: plan.activity });
  const before = await fs.readFile(path.join(h.targetDir, 'accounts.json'));
  assert.equal((await h.run()).alreadyImported, true);
  assert.deepEqual(await fs.readFile(path.join(h.targetDir, 'accounts.json')), before);
  assert.equal(await present(path.join(archive, 'staged-profiles')), false);
  assert.equal(await present(path.join(destination, '.account-import-owner.json')), false);
});

test('stale process and abandoned pre-owner locks are recovered while an active import remains exclusive', async t => {
  const h = await fixture(t, 1); await fs.mkdir(h.targetDir);
  const lock = path.join(h.targetDir, '.account-import.lock'); await fs.mkdir(lock);
  await write(path.join(lock, 'owner.json'), { pid: process.pid, token: 'active-fixture' });
  await assert.rejects(h.run(), /別|다른 계정 이관/); assert.equal(await present(path.join(h.targetDir, 'accounts.json')), false);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); await once(child, 'close');
  await write(path.join(lock, 'owner.json'), { pid: child.pid, token: 'stale-fixture' });
  assert.equal((await h.run()).importedCount, 1); assert.equal(await present(lock), false);
  const other = await fixture(t, 1); await fs.mkdir(other.targetDir); const noOwner = path.join(other.targetDir, '.account-import.lock'); await fs.mkdir(noOwner);
  const old = new Date(Date.now() - 120000); await fs.utimes(noOwner, old, old);
  assert.equal((await other.run()).importedCount, 1); assert.equal(await present(noOwner), false);
});

test('canonical source and target equality, symlinks and nesting are rejected before original files or permissions change', async t => {
  const h = await fixture(t, 1); await fs.chmod(h.sourceDir, 0o755); const before = await tree(h.sourceDir);
  const link = path.join(h.directory, 'source-link'); await fs.symlink(h.sourceDir, link, 'dir');
  for (const targetDir of [h.sourceDir, link, path.join(link, 'new', 'target'), h.directory]) {
    await assert.rejects(importAccounts({ sourceDir: h.sourceDir, targetDir, allowImport: true }), /서로 포함/);
    assert.equal(await mode(h.sourceDir), 0o755); assert.deepEqual(await tree(h.sourceDir), before);
  }
  assert.equal(await present(path.join(h.sourceDir, 'new')), false);
});

test('source profile links and credential links are rejected without copying authentication', async t => {
  const h = await fixture(t, 1, { store: 'file', auth: true }), profile = path.join(h.sourceDir, 'profiles', h.data.accounts[0].id);
  const held = path.join(h.directory, 'held-auth'); await fs.rename(path.join(profile, 'auth.json'), held); await fs.symlink(held, path.join(profile, 'auth.json'));
  await assert.rejects(h.run(), /일반 파일/); assert.equal(await present(path.join(h.targetDir, 'accounts.json')), false);
  await fs.rm(path.join(profile, 'auth.json')); await fs.rename(held, path.join(profile, 'auth.json'));
  const moved = path.join(h.directory, 'moved-profile'); await fs.rename(profile, moved); await fs.symlink(moved, profile, 'dir');
  await assert.rejects(h.run(), /연결 파일/); assert.equal(await present(path.join(h.targetDir, 'accounts.json')), false);
});

test('destination profile and archive links cannot redirect writes outside the account directory', async t => {
  for (const name of ['profiles', 'imports']) {
    const h = await fixture(t, 1), outside = path.join(h.directory, 'outside'); await fs.mkdir(outside); await fs.mkdir(h.targetDir); await fs.symlink(outside, path.join(h.targetDir, name), 'dir');
    await assert.rejects(h.run(), /연결 파일/); assert.deepEqual(await fs.readdir(outside), []);
    assert.equal(await present(path.join(h.targetDir, 'accounts.json')), false);
  }
});

test('an account file modified during import is preserved and the prepared import does not overwrite it on retry', async t => {
  const h = await fixture(t, 1), external = { version: 1, accounts: [account(88)], activity: [] };
  await assert.rejects(h.run({ beforeCommit: () => write(path.join(h.targetDir, 'accounts.json'), external) }), /기존 자료를 보존/);
  assert.deepEqual(await read(path.join(h.targetDir, 'accounts.json')), external);
  await assert.rejects(h.run(), /기존 자료를 보존/); assert.deepEqual(await read(path.join(h.targetDir, 'accounts.json')), external);
});

test('only an explicit successful login clears the imported login requirement', async t => {
  const h = await fixture(t, 1); await h.run(); const requests = [], clients = [];
  class Client extends EventEmitter {
    constructor() { super(); this.closed = false; clients.push(this); }
    async start() {}
    async request(method) {
      requests.push(method);
      if (method === 'account/login/start') return { loginId: 'fixture-login', authUrl: 'https://auth.openai.com/fixture-login' };
      if (method === 'account/read') return { account: { type: 'chatgpt', email: h.data.accounts[0].email, planType: 'pro' } };
      if (method === 'account/rateLimits/read') return h.data.accounts[0].usage;
      return {};
    }
    close() { this.closed = true; this.emit('close'); }
  }
  const value = await service(t, h, () => new Client()), id = h.data.accounts[0].id;
  await value.login(id); assert.equal(value.snapshot().accounts[0].requiresLogin, true);
  await value.cancelLogin(id); assert.equal(value.snapshot().accounts[0].status, 'signedOut'); assert.equal(value.snapshot().accounts[0].requiresLogin, true);
  await value.login(id); await value._loginCompleted(id, clients.at(-1), { loginId: 'fixture-login', success: false });
  assert.equal(value.snapshot().accounts[0].status, 'signedOut'); assert.equal(value.snapshot().accounts[0].requiresLogin, true);
  await value.login(id); await value._loginCompleted(id, clients.at(-1), { loginId: 'fixture-login', success: true });
  assert.equal(value.snapshot().accounts[0].requiresLogin, undefined); assert.equal(value.snapshot().accounts[0].status, 'ready');
  assert.equal((await read(path.join(h.targetDir, 'accounts.json'))).accounts[0].requiresLogin, undefined);
  assert.equal(requests.includes('account/rateLimits/reset'), false);
});
