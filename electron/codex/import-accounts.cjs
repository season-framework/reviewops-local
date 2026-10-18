'use strict';

// Explicit, same-user account import. This module never opens Keychain or starts Codex.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const empty = () => ({ version: 1, accounts: [], activity: [] });
function fail(message) { return new Error(message); }
function absolute(value) { if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fail('이관할 저장 폴더의 전체 경로를 지정하십시오.'); return path.resolve(value); }
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function same(left, right) { return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]); }
async function readStable(file, { optional = false, limit = 64 * 1024 * 1024 } = {}) {
  let info;
  try { info = await fs.lstat(file, { bigint: true }); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(limit)) throw fail('이관할 자료는 크기가 제한된 일반 파일이어야 합니다.');
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true }), bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
    if (bytes.length > limit || !same(info, before) || !same(before, after) || !same(after, current)) throw fail('계정 자료가 변경되었습니다. 다시 이관하십시오.');
    return { bytes, stat: after, file, hash: digest(bytes) };
  } finally { await handle.close(); }
}
function parse(bytes, message) { try { return JSON.parse(bytes.toString('utf8')); } catch { throw fail(message); } }
function validate(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > 100 || (data.activity !== undefined && !Array.isArray(data.activity))) throw fail('계정 자료 형식이 올바르지 않습니다.');
  const ids = new Set();
  for (const account of data.accounts) {
    if (!account || !UUID.test(account.id) || ids.has(account.id) || typeof account.label !== 'string' || !account.label.trim() || account.label.trim().length > 60) throw fail('계정 이름 또는 식별자가 올바르지 않습니다.');
    ids.add(account.id);
  }
  return data;
}
async function atomic(file, bytes) {
  const temporary = file + '.import-' + crypto.randomUUID(); let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
}
async function privateWrite(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); await fs.chmod(file, 0o600); }
async function canonicalTarget(value) {
  let current = value; const tail = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail.reverse()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(current); if (parent === current) throw error; tail.push(path.basename(current)); current = parent; }
  }
}
async function lockImport(targetDir) {
  const lock = path.join(targetDir, '.account-import.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      const owner = { pid: process.pid, token: crypto.randomUUID() };
      try { await privateWrite(path.join(lock, 'owner.json'), json(owner)); } catch (error) { await fs.rm(lock, { recursive: true, force: true }); throw error; }
      return async () => {
        let current;
        try { current = parse((await readStable(path.join(lock, 'owner.json'), { limit: 1024 })).bytes, '계정 이관 잠금 정보를 읽지 못했습니다.'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (current.token === owner.token) await fs.rm(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      const info = await fs.lstat(lock);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail('계정 이관 잠금 폴더를 확인하십시오.');
      const saved = await readStable(path.join(lock, 'owner.json'), { optional: true, limit: 1024 });
      if (saved) {
        const owner = parse(saved.bytes, '계정 이관 잠금 정보를 읽지 못했습니다.');
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') stale = true; }
        }
      } else stale = Date.now() - info.mtimeMs > 60000;
      if (!stale) throw fail('다른 계정 이관이 진행 중입니다.');
      const abandoned = lock + '.stale-' + crypto.randomUUID();
      await fs.rename(lock, abandoned); await fs.rm(abandoned, { recursive: true, force: true });
    }
  }
  throw fail('계정 이관 잠금을 만들지 못했습니다.');
}
async function ownedDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; const info = await fs.lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw fail('계정 자료 폴더의 연결 파일은 사용할 수 없습니다.'); }
}
async function loadSource(sourceDir) {
  const directory = await fs.realpath(absolute(sourceDir));
  const accounts = await readStable(path.join(directory, 'accounts.json'));
  const data = validate(parse(accounts.bytes, '원본 계정 자료를 읽지 못했습니다.'));
  const profiles = [];
  for (const account of data.accounts) {
    const profile = path.join(directory, 'profiles', account.id);
    if (await exists(profile) && await fs.realpath(profile) !== profile) throw fail('원본 계정 폴더의 연결 파일은 이관할 수 없습니다.');
    const config = await readStable(path.join(profile, 'config.toml'), { optional: true, limit: 1024 * 1024 });
    const store = /cli_auth_credentials_store\s*=\s*["']([^"']+)["']/.exec(config?.bytes.toString('utf8') || '')?.[1] || 'unspecified';
    // Keyring profiles can contain an obsolete auth.json. Only their active file store is copied.
    const fileStore = ['file', 'auto', 'unspecified'].includes(store) && account.status !== 'loggingIn';
    const auth = fileStore ? await readStable(path.join(profile, 'auth.json'), { optional: true, limit: 2 * 1024 * 1024 }) : null;
    if (auth) { const value = parse(auth.bytes, '원본 파일 로그인을 읽지 못했습니다.'); if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw fail('원본 파일 로그인 형식이 올바르지 않습니다.'); }
    const models = await readStable(path.join(profile, 'models_cache.json'), { optional: true, limit: 2 * 1024 * 1024 });
    profiles.push({ id: account.id, config, store, auth, models });
  }
  const runtime = await readStable(path.join(directory, 'runtime.json'), { optional: true, limit: 65536 });
  return { directory, accounts, data, profiles, runtime, sourceKey: digest(Buffer.from(directory)) };
}
async function loadTarget(targetDir) {
  const accounts = await readStable(path.join(targetDir, 'accounts.json'), { optional: true });
  return { accounts, data: accounts ? validate(parse(accounts.bytes, 'ReviewOps 계정 자료를 읽지 못했습니다.')) : empty() };
}
async function verifySnapshot(snapshot) {
  if (!snapshot) return;
  const current = await readStable(snapshot.file, { limit: Math.max(snapshot.bytes.length, 1) + 1 });
  if (!same(snapshot.stat, current.stat) || snapshot.hash !== current.hash) throw fail('계정 자료가 변경되었습니다. 다시 이관하십시오.');
}
function summary(source) {
  return { accountCount: source.data.accounts.length, usageCount: source.data.accounts.filter(row => row.usage).length, statisticsCount: source.data.accounts.filter(row => row.statistics).length,
    resetAttemptCount: source.data.accounts.filter(row => row.resetAttempt).length, activityCount: source.data.activity?.length || 0, fileAuthCount: source.profiles.filter(row => row.auth).length,
    requiresLoginCount: source.profiles.filter(row => !row.auth).length, runtimePresent: Boolean(source.runtime) };
}
async function inspectAccountImport({ sourceDir, targetDir }) {
  const source = await loadSource(sourceDir), target = await loadTarget(absolute(targetDir));
  return { ...summary(source), existingAccountCount: target.data.accounts.length };
}
async function readManifest(targetDir) {
  const file = path.join(targetDir, 'account-imports.json'), snapshot = await readStable(file, { optional: true, limit: 4 * 1024 * 1024 });
  const value = snapshot ? parse(snapshot.bytes, '계정 이관 기록을 읽지 못했습니다.') : { version: 1, sources: {} };
  if (value.version !== 1 || !value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)) throw fail('계정 이관 기록 형식이 올바르지 않습니다.');
  return value;
}
async function writeManifest(targetDir, plan, manifest) {
  const prior = manifest.sources[plan.sourceKey] || { accounts: {} };
  manifest.sources[plan.sourceKey] = { ...prior, sourceDirectory: plan.sourceDirectory, importedAt: plan.createdAt, accounts: { ...prior.accounts, ...Object.fromEntries(plan.processedIds.map(id => [id, { archive: plan.archiveName, imported: plan.rows.some(row => row.id === id) }])) } };
  await atomic(path.join(targetDir, 'account-imports.json'), json(manifest));
}
async function cleanStaging(targetDir, archivePath, plan) {
  await fs.rm(path.join(archivePath, 'staged-profiles'), { recursive: true, force: true });
  for (const entry of plan.profiles) {
    const markerPath = path.join(targetDir, 'profiles', entry.id, '.account-import-owner.json');
    const marker = await readStable(markerPath, { optional: true, limit: 1024 });
    if (marker && parse(marker.bytes, '계정 폴더 이관 정보를 읽지 못했습니다.').archiveName === plan.archiveName) await fs.rm(markerPath, { force: true });
  }
}
async function commitPlan(targetDir, archivePath, plan, manifest) {
  const target = await loadTarget(targetDir), ids = new Set(target.data.accounts.map(row => row.id));
  // Atomic accounts.json was already committed before an interrupted marker write.
  if (plan.rows.length && plan.rows.every(row => ids.has(row.id))) {
    if (plan.runtime && !await exists(path.join(targetDir, 'runtime.json'))) await privateWrite(path.join(targetDir, 'runtime.json'), json(plan.runtime));
    await writeManifest(targetDir, plan, manifest); await atomic(path.join(archivePath, 'completed.json'), json({ completedAt: new Date().toISOString() }));
    await cleanStaging(targetDir, archivePath, plan); return;
  }
  if ((target.accounts?.hash || null) !== plan.targetHash) throw fail('ReviewOps 계정 자료가 변경되었습니다. 기존 자료를 보존한 상태로 이관을 중단했습니다.');
  for (const entry of plan.profiles) {
    const destination = path.join(targetDir, 'profiles', entry.id); await ownedDirectory(path.dirname(destination));
    const ownerPath = path.join(destination, '.account-import-owner.json');
    if (!await exists(destination)) { await fs.mkdir(destination, { mode: 0o700 }); await privateWrite(ownerPath, json({ archiveName: plan.archiveName })); }
    else {
      const marker = await readStable(ownerPath, { optional: true, limit: 1024 });
      if (!marker && (await fs.readdir(destination)).length === 0) await privateWrite(ownerPath, json({ archiveName: plan.archiveName }));
      else if (!marker || parse(marker.bytes, '계정 폴더 이관 정보를 읽지 못했습니다.').archiveName !== plan.archiveName) throw fail('기존 계정 폴더를 덮어쓰지 않고 이관을 중단했습니다.');
    }
    for (const file of entry.files) {
      const source = path.join(archivePath, 'staged-profiles', entry.id, file.name), final = path.join(destination, file.name);
      if (await exists(final)) { if ((await readStable(final, { limit: 2 * 1024 * 1024 })).hash !== file.hash) throw fail('기존 계정 로그인 파일이 변경되어 덮어쓰지 않았습니다.'); }
      else await privateWrite(final, (await readStable(source, { limit: 2 * 1024 * 1024 })).bytes);
    }
  }
  const latest = await loadTarget(targetDir);
  if ((latest.accounts?.hash || null) !== plan.targetHash) throw fail('ReviewOps 계정 자료가 변경되었습니다. 기존 자료를 보존한 상태로 이관을 중단했습니다.');
  const activity = [...(latest.data.activity || [])], activityIds = new Set(activity.map(row => row.id));
  for (const row of plan.activity) if (!activityIds.has(row.id)) { activity.push(row); activityIds.add(row.id); }
  activity.sort((left, right) => String(left.time || '').localeCompare(String(right.time || '')));
  await atomic(path.join(targetDir, 'accounts.json'), json({ ...latest.data, accounts: [...latest.data.accounts, ...plan.rows], activity }));
  if (plan.runtime && !await exists(path.join(targetDir, 'runtime.json'))) await privateWrite(path.join(targetDir, 'runtime.json'), json(plan.runtime));
  await writeManifest(targetDir, plan, manifest);
  await atomic(path.join(archivePath, 'completed.json'), json({ completedAt: new Date().toISOString() }));
  // Profiles have private destination copies; the import archive retains metadata only.
  await cleanStaging(targetDir, archivePath, plan);
}
async function importAccounts(options = {}) {
  if (options.allowImport !== true) throw fail('계정 이관을 명시적으로 요청해야 합니다.');
  const sourceDir = await fs.realpath(absolute(options.sourceDir)), targetDir = await canonicalTarget(absolute(options.targetDir));
  if (sourceDir === targetDir || sourceDir.startsWith(targetDir + path.sep) || targetDir.startsWith(sourceDir + path.sep)) throw fail('원본과 ReviewOps 저장 폴더는 서로 포함되지 않아야 합니다.');
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 }); await fs.chmod(targetDir, 0o700);
  const releaseLock = await lockImport(targetDir);
  try {
    const imports = path.join(targetDir, 'imports'); await ownedDirectory(imports);
    let manifest = await readManifest(targetDir);
    // Resume a prepared import without reading or repeating source credentials.
    for (const name of await fs.readdir(imports)) {
      const archive = path.join(imports, name), planFile = path.join(archive, 'plan.json');
      if (!await exists(planFile) || await exists(path.join(archive, 'completed.json'))) continue;
      const plan = parse((await readStable(planFile)).bytes, '중단된 계정 이관 기록을 읽지 못했습니다.');
      if (plan.sourceDirectory === await fs.realpath(sourceDir)) { await commitPlan(targetDir, archive, plan, manifest); manifest = await readManifest(targetDir); }
    }
    const source = await loadSource(sourceDir), target = await loadTarget(targetDir), previous = manifest.sources[source.sourceKey]?.accounts || {};
    const ids = new Set(target.data.accounts.map(row => row.id)), rows = [], profiles = [], processedIds = [];
    let skippedCount = 0;
    for (const row of source.data.accounts) {
      if (previous[row.id] || ids.has(row.id) || await exists(path.join(targetDir, 'profiles', row.id))) { skippedCount++; processedIds.push(row.id); continue; }
      const profile = source.profiles.find(item => item.id === row.id), imported = structuredClone(row);
      if (!profile.auth) { imported.requiresLogin = true; imported.status = 'signedOut'; imported.authStarted = false; }
      else { delete imported.requiresLogin; imported.authStarted = true; imported.status = row.email || row.usage ? 'ready' : 'signedOut'; }
      rows.push(imported); processedIds.push(row.id); profiles.push(profile);
    }
    if (target.data.accounts.length + rows.length > 100) throw fail('계정은 최대 100개까지 보관할 수 있습니다. 기존 계정을 정리한 뒤 이관하십시오.');
    const counts = { importedCount: rows.length, skippedCount, requiresLoginCount: rows.filter(row => row.requiresLogin).length, authCopiedCount: profiles.filter(row => row.auth).length };
    if (!rows.length && source.data.accounts.every(row => previous[row.id])) return { ...counts, activityImportedCount: 0, runtimeImported: false, alreadyImported: true, manifestPath: path.join(targetDir, 'account-imports.json') };
    const archiveName = 'import-' + crypto.randomUUID(), archivePath = path.join(imports, archiveName); await fs.mkdir(archivePath, { mode: 0o700 });
    await privateWrite(path.join(archivePath, 'source-accounts.json'), source.accounts.bytes);
    if (target.accounts) await privateWrite(path.join(archivePath, 'target-accounts-before.json'), target.accounts.bytes);
    if (source.runtime) await privateWrite(path.join(archivePath, 'source-runtime.json'), source.runtime.bytes);
    const savedProfiles = [];
    for (const profile of profiles) {
      const files = [{ name: 'config.toml', bytes: Buffer.from('cli_auth_credentials_store = "file"\n') }];
      if (profile.auth) files.push({ name: 'auth.json', bytes: profile.auth.bytes });
      if (profile.models) files.push({ name: 'models_cache.json', bytes: profile.models.bytes });
      if (profile.config) await privateWrite(path.join(archivePath, 'source-profile-configs', profile.id + '.toml'), profile.config.bytes);
      for (const file of files) await privateWrite(path.join(archivePath, 'staged-profiles', profile.id, file.name), file.bytes);
      savedProfiles.push({ id: profile.id, files: files.map(({ name, bytes }) => ({ name, hash: digest(bytes) })) });
    }
    const seenActivity = new Set((target.data.activity || []).map(row => row.id)), activity = [];
    for (const row of source.data.activity || []) { const id = row.id || 'import-' + digest(json(row)); if (!seenActivity.has(id)) { activity.push({ ...row, id }); seenActivity.add(id); } }
    let runtime = null;
    if (source.runtime && !await exists(path.join(targetDir, 'runtime.json'))) {
      const value = parse(source.runtime.bytes, '원본 Codex 실행 설정을 읽지 못했습니다.');
      if (typeof value.path === 'string' && path.isAbsolute(value.path) && !/[\0\r\n]/.test(value.path) && !/Codex Account Manager\.app\//i.test(value.path) && await exists(value.path)) runtime = { path: value.path };
    }
    const plan = { version: 1, sourceKey: source.sourceKey, sourceDirectory: source.directory, archiveName, createdAt: new Date().toISOString(), targetHash: target.accounts?.hash || null, rows, profiles: savedProfiles, activity, processedIds, runtime };
    await verifySnapshot(source.accounts);
    for (const profile of profiles) for (const file of [profile.config, profile.auth, profile.models]) await verifySnapshot(file);
    await privateWrite(path.join(archivePath, 'plan.json'), json(plan));
    await options.beforeCommit?.();
    await commitPlan(targetDir, archivePath, plan, manifest);
    return { ...counts, activityImportedCount: activity.length, runtimeImported: Boolean(runtime), alreadyImported: false, archivePath, manifestPath: path.join(targetDir, 'account-imports.json') };
  } finally { await releaseLock(); }
}
module.exports = { inspectAccountImport, importAccounts };
