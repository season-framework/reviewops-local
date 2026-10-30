'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const load = import('../scripts/test-release.mjs');
const buildFor = n => ({ channel: 'test', version: '1.2.9', buildNumber: n, commit: n.toString(16).padStart(40, '0'), builtAt: '2026-10-30T16:00:00.000Z' });
async function fixture(t, n = 1001) {
  const m = await load, directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-test-release-')), build = buildFor(n);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = [];
  for (const name of m.namesFor(build)) {
    const bytes = Buffer.alloc(1200, n % 251); await fs.writeFile(path.join(directory, name), bytes);
    files.push({ name, size: bytes.length, sha256: m.hash(bytes) });
  }
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    await fs.writeFile(path.join(directory, `verification-${target}.json`), JSON.stringify({ schema: 1, ok: true, target, build, files,
      checks: ['packaged-build-info', 'package-structure', ...(target.startsWith('darwin') ? ['codesign', 'dmg-verify'] : ['publisher-status', 'installed-application'])] }));
  }
  await fs.writeFile(path.join(directory, 'build-info.json'), JSON.stringify(build));
  return { m, directory, build, plan: await m.prepareRelease(directory, build) };
}
async function memoryStore(plan = null) {
  const m = await load;
  let id = 0, release = plan ? { id: 1, tag_name: m.TAG, draft: false, prerelease: true, body: `${m.marker}${JSON.stringify(plan.pointer)} -->` } : null;
  const assets = new Map(), writes = [];
  async function insert(file) {
    const bytes = file.bytes || await fs.readFile(file.filename);
    const asset = { id: ++id, name: file.name, size: bytes.length, state: 'uploaded', bytes: Buffer.from(bytes) };
    assets.set(asset.id, asset); return asset;
  }
  if (plan) for (const file of plan.assets) await insert(file);
  const store = {
    assets, writes, readPointer: () => m.pointerFromBody(release?.body),
    async getRelease() { return release ? { ...release } : null; },
    async createRelease() { writes.push('create'); release = { id: 1, tag_name: m.TAG, draft: false, prerelease: true, body: '' }; return { ...release }; },
    async listAssets() { return [...assets.values()].map(asset => ({ ...asset })); },
    async upload(_release, file) { writes.push(`upload:${file.name}`); await insert(file); },
    async hashAsset(asset) { return m.hash(assets.get(asset.id).bytes); },
    async setPointer(_id, body) { writes.push('switch'); release.body = body; },
    async deleteAsset(assetId) { writes.push(`delete:${assetId}`); assets.delete(assetId); },
    async assetExists(assetId) { return assets.has(assetId); },
    setRelease(value) { release = value; },
    addStarter(name) { const value = { id: ++id, name, size: 0, state: 'starter', bytes: Buffer.alloc(0) }; assets.set(value.id, value); return value.id; },
  };
  return store;
}

test('all target files and verification hashes form one complete test manifest', async t => {
  const { m, directory, plan } = await fixture(t);
  assert.equal(plan.assets.length, 11);
  assert.match(plan.manifest.artifacts['win32-x64'].name, /-windows-x64\.exe$/);
  assert.equal(m.hash(plan.assets.at(-1).bytes), plan.pointer.sha256);
  await fs.appendFile(path.join(directory, plan.assets[0].name), 'changed');
  await assert.rejects(m.prepareRelease(directory, plan.build), /변경/);
});
test('missing platform verification prevents any publication plan', async t => {
  const { m, directory, build } = await fixture(t);
  await fs.rm(path.join(directory, 'verification-win32-x64.json'));
  await assert.rejects(m.prepareRelease(directory, build), /ENOENT/);
});
test('default dry run performs no writes; offline CLI never reads a token', async t => {
  const { m, directory, plan } = await fixture(t), store = await memoryStore();
  assert.equal((await m.publishRelease(plan, store)).dryRun, true); assert.deepEqual(store.writes, []);
  const env = new Proxy({}, { get(_target, key) { if (key === 'GITHUB_TOKEN') throw new Error('token lookup'); } });
  assert.equal((await m.main(['--directory', directory, '--offline'], env)).dryRun, true);
});
test('the CLI defaults to an offline review when requested and refuses offline publication', async t => {
  const { directory } = await fixture(t);
  const { promisify } = require('node:util'), { execFile } = require('node:child_process');
  const run = promisify(execFile), script = path.join(__dirname, '../scripts/test-release.mjs');
  const result = await run(process.execPath, [script, '--directory', directory, '--offline'], { env: {} });
  assert.equal(JSON.parse(result.stdout).dryRun, true);
  await assert.rejects(run(process.execPath, [script, '--directory', directory, '--offline', '--publish'], { env: {} }), /오프라인/);
});
test('complete upload and hash verification precede the only pointer switch', async t => {
  const old = await fixture(t, 1001), next = await fixture(t, 2001), store = await memoryStore(old.plan), set = store.setPointer;
  store.setPointer = async (...args) => {
    for (const file of next.plan.assets) assert.ok([...store.assets.values()].some(a => a.name === file.name && a.size === file.size));
    assert.ok([...store.assets.values()].some(a => a.name === old.plan.assets[0].name));
    await set(...args);
  };
  const result = await next.m.publishRelease(next.plan, store, { dryRun: false });
  assert.equal(result.retainedReleaseItems, 1); assert.equal(store.assets.size, 11); assert.deepEqual(store.readPointer(), next.plan.pointer);
  assert.equal(store.writes.filter(x => x === 'switch').length, 1);
  assert.ok(store.writes.findIndex(x => x.startsWith('delete:')) > store.writes.indexOf('switch'));
});
test('an older CI completion and reused build number cannot overwrite a newer publication', async t => {
  const old = await fixture(t, 1001), next = await fixture(t, 2001), store = await memoryStore(next.plan);
  await assert.rejects(old.m.publishRelease(old.plan, store, { dryRun: false }), /더 최신/);
  assert.deepEqual(store.writes, []);
  const changed = { ...next.plan, build: { ...next.build, commit: 'f'.repeat(40) } };
  await assert.rejects(next.m.publishRelease(changed, store, { dryRun: false }), /다른 커밋/);
});
test('failed partial upload keeps the previous pointer and retries without replacing files', async t => {
  const old = await fixture(t, 1001), next = await fixture(t, 2001), store = await memoryStore(old.plan), upload = store.upload;
  let count = 0;
  store.upload = async (...args) => { if (++count === 3) throw new Error('interrupted'); await upload(...args); };
  await assert.rejects(next.m.publishRelease(next.plan, store, { dryRun: false }), /interrupted/);
  assert.deepEqual(store.readPointer(), old.plan.pointer); assert.equal(store.writes.includes('switch'), false);
  store.upload = upload;
  await next.m.publishRelease(next.plan, store, { dryRun: false });
  assert.equal(store.assets.size, 11); assert.deepEqual(store.readPointer(), next.plan.pointer);
});
test('an unpublished empty GitHub starter asset is removed and uploaded again', async t => {
  const { m, plan } = await fixture(t), store = await memoryStore();
  store.setRelease({ id: 1, tag_name: m.TAG, draft: false, prerelease: true, body: '' });
  const id = store.addStarter(plan.assets[0].name);
  await m.publishRelease(plan, store, { dryRun: false });
  assert.equal(store.assets.has(id), false); assert.equal(store.assets.size, 11);
});
test('published or nonempty files are never silently replaced', async t => {
  const { m, plan } = await fixture(t), store = await memoryStore(plan);
  const file = [...store.assets.values()][0]; file.bytes[0] ^= 1;
  await assert.rejects(m.publishRelease(plan, store, { dryRun: false }), /内容|내용/);
  assert.equal(store.writes.some(x => x.startsWith('delete:')), false);
});
test('response loss after the switch and partial cleanup both recover on exact retry', async t => {
  const old = await fixture(t, 1001), next = await fixture(t, 2001), store = await memoryStore(old.plan), set = store.setPointer;
  store.setPointer = async (...args) => { await set(...args); throw new Error('lost response'); };
  await assert.rejects(next.m.publishRelease(next.plan, store, { dryRun: false }), /lost response/);
  assert.deepEqual(store.readPointer(), next.plan.pointer); assert.equal(store.assets.size, 22);
  store.setPointer = set;
  const remove = store.deleteAsset; let count = 0;
  store.deleteAsset = async id => { if (++count === 3) throw new Error('cleanup interrupted'); await remove(id); };
  await assert.rejects(next.m.publishRelease(next.plan, store, { dryRun: false }), /cleanup interrupted/);
  store.deleteAsset = remove;
  await next.m.publishRelease(next.plan, store, { dryRun: false }); assert.equal(store.assets.size, 11);
});
test('a stable release or unknown asset is left unchanged', async t => {
  const { m, plan } = await fixture(t), store = await memoryStore();
  store.setRelease({ id: 2, tag_name: 'v1.2.9', draft: false, prerelease: false, body: 'stable' });
  await assert.rejects(m.publishRelease(plan, store, { dryRun: false }), /test-latest/); assert.deepEqual(store.writes, []);
  store.setRelease({ id: 1, tag_name: m.TAG, draft: false, prerelease: true, body: '' }); store.addStarter('unrelated.txt');
  await assert.rejects(m.publishRelease(plan, store, { dryRun: false }), /알 수 없는/); assert.deepEqual(store.writes, []);
});
test('a changed pointer before commit prevents switching and deleting any previous file', async t => {
  const old = await fixture(t, 1001), next = await fixture(t, 2001), future = await fixture(t, 3001), store = await memoryStore(old.plan), get = store.getRelease;
  let reads = 0;
  store.getRelease = async () => { if (++reads === 2) store.setRelease({ id: 1, tag_name: 'test-latest', prerelease: true, body: `${next.m.marker}${JSON.stringify(future.plan.pointer)} -->` }); return get(); };
  await assert.rejects(next.m.publishRelease(next.plan, store, { dryRun: false }), /더 최신/);
  assert.equal(store.writes.includes('switch'), false); assert.equal(store.writes.some(x => x.startsWith('delete:')), false);
});
test('overlapping publishers are rejected in one process', async t => {
  const { m, plan } = await fixture(t), store = await memoryStore(), upload = store.upload;
  let release; const gate = new Promise(resolve => { release = resolve; }); let entered;
  const firstUpload = new Promise(resolve => { entered = resolve; });
  store.upload = async (...args) => { entered(); await gate; await upload(...args); };
  const first = m.publishRelease(plan, store, { dryRun: false }); await firstUpload;
  await assert.rejects(m.publishRelease(plan, store, { dryRun: false }), /이미/);
  release(); await first;
});
test('Actions build ordering includes reruns without allowing an old run past a newer run', async () => {
  const { ciBuildNumber, assertPublicationCI, REPOSITORY, PUBLICATION_GROUP } = await load;
  assert.ok(ciBuildNumber({ GITHUB_RUN_NUMBER: '2', GITHUB_RUN_ATTEMPT: '1' }) > ciBuildNumber({ GITHUB_RUN_NUMBER: '1', GITHUB_RUN_ATTEMPT: '999' }));
  assert.throws(() => ciBuildNumber({ GITHUB_RUN_NUMBER: '1', GITHUB_RUN_ATTEMPT: '1000' }));
  const build = buildFor(1001), env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_JOB: 'publish', GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/test-release.yml@refs/heads/codex/test-updates`, REVIEWOPS_PUBLICATION_GROUP: PUBLICATION_GROUP, GITHUB_SHA: build.commit, GITHUB_RUN_NUMBER: '1', GITHUB_RUN_ATTEMPT: '1' };
  assert.doesNotThrow(() => assertPublicationCI(build, env));
  assert.throws(() => assertPublicationCI(build, { ...env, GITHUB_JOB: 'package' }));
  assert.throws(() => assertPublicationCI({ ...build, buildNumber: 2001 }, env));
  assert.doesNotThrow(() => assertPublicationCI(build, { ...env, GITHUB_RUN_ATTEMPT: '2' }));
  assert.doesNotThrow(() => assertPublicationCI({ ...build, buildNumber: 1002 }, { ...env, GITHUB_RUN_ATTEMPT: '2' }));
  assert.throws(() => assertPublicationCI({ ...build, buildNumber: 1003 }, { ...env, GITHUB_RUN_ATTEMPT: '2' }));
  assert.throws(() => assertPublicationCI({ ...build, buildNumber: 1000 }, { ...env, GITHUB_RUN_ATTEMPT: '2' }));
});
test('adapter cannot mutate outside the serialized workflow', async () => {
  const { githubStore } = await load; let calls = 0;
  const store = githubStore('synthetic-test-token', async () => { calls++; }, {});
  await assert.rejects(store.deleteAsset(7), /Actions/); assert.equal(calls, 0);
});
test('CDN verification follows allowed redirects without leaking the token', async () => {
  const { githubStore, hash } = await load, bytes = Buffer.from('fixture'), calls = [];
  const store = githubStore('synthetic-test-token', async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }) : new Response(bytes);
  }, {});
  assert.equal(await store.hashAsset({ id: 1, size: bytes.length }), hash(bytes));
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-test-token'); assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.redirect, 'error');
});
test('test identity is removed after a successful operation and after an exception', async t => {
  const { withBuildInfo } = await import('../scripts/build-info.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-build-info-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'build.json'), build = buildFor(1001), options = { channel: 'test', number: build.buildNumber, commit: build.commit, builtAt: build.builtAt, version: build.version, output };
  await withBuildInfo(options, async info => { assert.deepEqual(info, build); assert.deepEqual(JSON.parse(await fs.readFile(output)), build); });
  await assert.rejects(fs.stat(output), /ENOENT/);
  await assert.rejects(withBuildInfo(options, async () => { throw new Error('packager failed'); }), /packager failed/);
  await assert.rejects(fs.stat(output), /ENOENT/);
});
test('workflow uses one global lock, native targets, least publishing scope and explicit publish', async () => {
  const yaml = require('js-yaml'), workflow = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/test-release.yml'), 'utf8'));
  assert.equal(workflow.concurrency.group, 'reviewops-test-latest'); assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.deepEqual(workflow.on.push.branches, ['codex/test-updates']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.deepEqual(workflow.jobs.package.strategy.matrix.include.map(item => item.target).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
  const publish = workflow.jobs.publish.steps.find(step => step.run?.includes('--publish'));
  assert.match(publish.if, /workflow_dispatch/); assert.match(publish.if, /inputs.publish/);
  const stage = workflow.jobs.package.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(stage.with['retention-days'], 1);
});

test('artifact cleanup retains only the reviewed candidate and never deletes another workflow', async () => {
  const { cleanupArtifacts } = await import('../scripts/test-build-artifacts.mjs');
  const { REPOSITORY, PUBLICATION_GROUP } = await load;
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_JOB: 'publish', GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/test-release.yml@refs/heads/codex/test-updates`, REVIEWOPS_PUBLICATION_GROUP: PUBLICATION_GROUP, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '30', GITHUB_RUN_NUMBER: '3', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 'synthetic-test-token' };
  let nextId = 0;
  const entries = [], runs = { 10: { workflow_id: 7, status: 'completed', conclusion: 'success' }, 20: { workflow_id: 7, status: 'completed', conclusion: 'success' }, 30: { workflow_id: 7, status: 'in_progress' }, 40: { workflow_id: 7, status: 'in_progress' }, 5: { workflow_id: 99, status: 'completed', conclusion: 'success' } };
  for (const run of [5, 10, 20, 30, 40]) for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) entries.push({ id: ++nextId, name: `reviewops-test-build-${target}`, workflow_run: { id: run } });
  entries.push({ id: ++nextId, name: 'stable-windows-installer', workflow_run: { id: 10 } });
  const deleted = new Set();
  const fetchImpl = async (value, options) => {
    const url = new URL(value), suffix = url.pathname.split('/actions/')[1];
    if (suffix === 'workflows/test-release.yml') return Response.json({ id: 7 });
    if (suffix === 'artifacts') return Response.json({ artifacts: entries.filter(entry => !deleted.has(entry.id)) });
    if (suffix.startsWith('runs/')) return Response.json(runs[Number(suffix.slice(5))]);
    const id = Number(suffix.slice('artifacts/'.length));
    if (options.method === 'DELETE') { deleted.add(id); return new Response(null, { status: 204 }); }
    return deleted.has(id) ? new Response(null, { status: 404 }) : Response.json(entries.find(entry => entry.id === id));
  };
  const dryRun = await cleanupArtifacts({ env, fetchImpl, keepCurrent: true });
  assert.equal(dryRun.retainedRun, 30); assert.equal(deleted.size, 0);
  assert.deepEqual([...new Set(dryRun.artifacts.map(item => item.run))], [10, 20]);
  const fallback = await cleanupArtifacts({ env, fetchImpl, keepCandidate: true });
  assert.equal(fallback.retainedRun, 20); assert.deepEqual([...new Set(fallback.artifacts.map(item => item.run))], [10, 30]);
  const result = await cleanupArtifacts({ env, fetchImpl, keepCurrent: true, remove: true });
  assert.equal(deleted.size, 6); assert.equal(result.artifacts.length, 6);
  assert.equal([...deleted].some(id => entries.find(entry => entry.id === id).workflow_run.id === 5), false);
});

test('partial platform artifacts survive failed-job cleanup and complete on retry', async () => {
  const { cleanupArtifacts } = await import('../scripts/test-build-artifacts.mjs');
  const { REPOSITORY, PUBLICATION_GROUP } = await load;
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_JOB: 'publish', GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/test-release.yml@refs/heads/codex/test-updates`, REVIEWOPS_PUBLICATION_GROUP: PUBLICATION_GROUP, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '30', GITHUB_RUN_NUMBER: '3', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 'synthetic-test-token' };
  let id = 0;
  const entries = ['darwin-arm64', 'darwin-x64'].map(target => ({ id: ++id, name: `reviewops-test-build-${target}`, workflow_run: { id: 30 } }));
  entries.push({ id: ++id, name: 'reviewops-test-build-win32-x64', workflow_run: { id: 20 } });
  const fetchImpl = async (url, options) => {
    const suffix = new URL(url).pathname.split('/actions/')[1];
    if (suffix === 'workflows/test-release.yml') return Response.json({ id: 7 });
    if (suffix === 'artifacts') return Response.json({ artifacts: entries });
    if (suffix.startsWith('runs/')) return Response.json({ workflow_id: 7, status: suffix.endsWith('/30') ? 'in_progress' : 'completed', conclusion: 'failure' });
    const assetId = Number(suffix.slice('artifacts/'.length)), at = entries.findIndex(entry => entry.id === assetId);
    if (options.method === 'DELETE') { if (at !== -1) entries.splice(at, 1); return new Response(null, { status: 204 }); }
    return at === -1 ? new Response(null, { status: 404 }) : Response.json(entries[at]);
  };
  await cleanupArtifacts({ env, fetchImpl, remove: true, keepCurrent: true });
  assert.equal(entries.length, 2); assert.ok(entries.every(entry => entry.workflow_run.id === 30));
  // Re-run failed jobs only: successful Mac jobs do not run again. Their
  // artifacts are still present when the Windows retry adds its package.
  entries.push({ id: ++id, name: 'reviewops-test-build-win32-x64', workflow_run: { id: 30 } });
  await cleanupArtifacts({ env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, fetchImpl, remove: true, keepCurrent: true });
  assert.equal(entries.length, 3);
  const yaml = require('js-yaml'), workflow = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/test-release.yml'), 'utf8'));
  const cleanup = workflow.jobs.publish.steps.find(step => step.run?.includes('test-build-artifacts.mjs'));
  assert.match(cleanup.env.KEEP_CURRENT, /needs\.metadata\.result/);
  assert.doesNotMatch(cleanup.env.KEEP_CURRENT, /needs\.package\.result/);
});
