'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const load = () => import('../scripts/upload-windows-release.mjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const commit = 'a'.repeat(40);
const version = '1.2.10';
const tag = `v${version}`;
const validEnv = () => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'season-framework/reviewops-local',
  GITHUB_JOB: 'windows',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'season-framework/reviewops-local/.github/workflows/windows-release.yml@refs/heads/codex/test-updates',
  GITHUB_SHA: commit,
  REVIEWOPS_PUBLISH_TO_DRAFT: 'true',
  REVIEWOPS_RELEASE_TAG: tag,
  REVIEWOPS_REVIEWED_COMMIT: commit,
});
function planFixture() {
  const bytes = Buffer.alloc(2048, 7); bytes.write('MZ');
  const name = `ReviewOps-${version}-windows-x64.exe`;
  const file = { name, size: bytes.length, sha256: sha256(bytes), bytes };
  const checksum = Buffer.from(`${file.sha256}  ${name}\n`);
  return { version, commit, tag, files: [file, { name: `${name}.sha256`, size: checksum.length, sha256: sha256(checksum), bytes: checksum }] };
}
function memoryStore(plan, { installed = false } = {}) {
  let id = 0;
  let release = { id: 17, tag_name: tag, draft: true, prerelease: false, immutable: false, target_commitish: commit };
  let tagCommit = commit;
  const assets = new Map(), writes = [];
  function insert(file, bytes = file.bytes) {
    const asset = { id: ++id, name: file.name, size: bytes.length, state: 'uploaded', digest: `sha256:${sha256(bytes)}`, bytes: Buffer.from(bytes) };
    assets.set(asset.id, asset); return asset;
  }
  if (installed) for (const file of plan.files) insert(file);
  return {
    assets, writes, insert,
    setRelease(patch) { release = patch === null ? null : { ...release, ...patch }; },
    setTagCommit(value) { tagCommit = value; },
    async getRelease() { return release ? { ...release } : null; },
    async getTagCommit() { return tagCommit; },
    async listAssets() { return [...assets.values()].map(asset => ({ ...asset })); },
    async upload(_release, file) { writes.push(file.name); return insert(file); },
    async verifyAsset(asset, file) {
      const stored = assets.get(asset.id);
      assert.ok(stored, 'The uploaded asset is missing.');
      assert.equal(stored.name, file.name);
      assert.equal(stored.size, file.size);
      assert.equal(sha256(stored.bytes), file.sha256);
      return { method: 'download-sha256' };
    },
  };
}

test('draft upload requires an explicit Windows dispatch for the reviewed commit and stable version', async () => {
  const { assertUploadEnvironment } = await load();
  const options = { env: validEnv(), platform: 'win32', version, actualCommit: commit };
  assert.doesNotThrow(() => assertUploadEnvironment(options));
  for (const patch of [
    { GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'another/repository' }, { GITHUB_JOB: 'regression' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: 'season-framework/reviewops-local/.github/workflows/test-release.yml@refs/heads/main' },
    { REVIEWOPS_PUBLISH_TO_DRAFT: 'false' }, { REVIEWOPS_RELEASE_TAG: 'test-latest' },
    { REVIEWOPS_REVIEWED_COMMIT: 'b'.repeat(40) }, { GITHUB_SHA: 'b'.repeat(40) },
  ]) assert.throws(() => assertUploadEnvironment({ ...options, env: { ...validEnv(), ...patch } }));
  assert.throws(() => assertUploadEnvironment({ ...options, platform: 'darwin' }));
  assert.throws(() => assertUploadEnvironment({ ...options, actualCommit: 'b'.repeat(40) }));
  assert.throws(() => assertUploadEnvironment({ ...options, version: '1.2.10-beta.1' }));
});
test('published, prerelease, missing, and differently targeted releases are never changed', async () => {
  const { uploadToDraft } = await load(), plan = planFixture();
  for (const patch of [null, { draft: false }, { prerelease: true }, { tag_name: 'v1.2.9' }, { target_commitish: 'b'.repeat(40) }]) {
    const store = memoryStore(plan); store.setRelease(patch);
    await assert.rejects(uploadToDraft(plan, store));
    assert.deepEqual(store.writes, []);
  }
});
test('a tag pointing to another commit prevents upload before any file changes', async () => {
  const { uploadToDraft } = await load(), plan = planFixture(), store = memoryStore(plan);
  store.setTagCommit('b'.repeat(40));
  await assert.rejects(uploadToDraft(plan, store));
  assert.deepEqual(store.writes, []);
});
test('an exact retry reuses both existing files without replacing assets', async () => {
  const { uploadToDraft } = await load(), plan = planFixture(), store = memoryStore(plan, { installed: true });
  const originalIds = [...store.assets.keys()];
  await uploadToDraft(plan, store);
  await uploadToDraft(plan, store);
  assert.deepEqual(store.writes, []);
  assert.deepEqual([...store.assets.keys()], originalIds);
});
test('same-name content changes are rejected without upload or replacement', async () => {
  const { uploadToDraft } = await load(), plan = planFixture(), store = memoryStore(plan);
  const changed = Buffer.from(plan.files[0].bytes); changed[100] ^= 1;
  const existing = store.insert(plan.files[0], changed);
  await assert.rejects(uploadToDraft(plan, store));
  assert.deepEqual(store.writes, []);
  assert.deepEqual([...store.assets.keys()], [existing.id]);
});
test('a failed second upload can retry without duplicating the already verified installer', async () => {
  const { uploadToDraft } = await load(), plan = planFixture(), store = memoryStore(plan), upload = store.upload;
  let interrupted = true;
  store.upload = async (release, file) => {
    if (file.name.endsWith('.sha256') && interrupted) { interrupted = false; throw new Error('interrupted checksum upload'); }
    return upload(release, file);
  };
  await assert.rejects(uploadToDraft(plan, store), /interrupted checksum upload/);
  assert.equal(store.assets.size, 1);
  await uploadToDraft(plan, store);
  assert.equal(store.assets.size, 2);
  assert.deepEqual(store.writes, plan.files.map(file => file.name));
});
test('publication during staging prevents writing the next draft file', async () => {
  const { uploadToDraft } = await load(), plan = planFixture(), store = memoryStore(plan), upload = store.upload;
  store.upload = async (...args) => {
    const result = await upload(...args);
    store.setRelease({ draft: false });
    return result;
  };
  await assert.rejects(uploadToDraft(plan, store));
  assert.deepEqual(store.writes, [plan.files[0].name]);
  assert.equal(store.assets.size, 1);
});
function remoteFixture(file, { status = 200, changed = false } = {}) {
  const asset = { id: 12, name: file.name, size: file.size, state: 'uploaded', digest: `sha256:${file.sha256}` };
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input); calls.push({ url: url.href, options });
    if (url.hostname === 'api.github.com') {
      const accept = new Headers(options.headers).get('accept') || '';
      return accept.includes('application/octet-stream')
        ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/windows-fixture' } })
        : Response.json(asset);
    }
    assert.equal(url.hostname, 'release-assets.githubusercontent.com');
    const bytes = Buffer.from(file.bytes); if (changed) bytes[100] ^= 1;
    return new Response(status === 200 ? bytes : null, { status });
  };
  return { asset, calls, fetchImpl };
}
test('server download verification never forwards the CI token to the asset host', async () => {
  const { githubStore } = await load(), file = planFixture().files[0], remote = remoteFixture(file);
  const store = githubStore({ token: 'synthetic-upload-token', fetchImpl: remote.fetchImpl, env: validEnv(), platform: 'win32' });
  const result = await store.verifyAsset(remote.asset, file);
  assert.equal(result.method, 'download-sha256');
  const api = remote.calls.filter(call => call.url.startsWith('https://api.github.com/'));
  const cdn = remote.calls.filter(call => call.url.startsWith('https://release-assets.githubusercontent.com/'));
  assert.ok(api.length > 0); assert.equal(cdn.length, 1);
  assert.ok(api.every(call => new Headers(call.options.headers).get('authorization') === 'Bearer synthetic-upload-token'));
  assert.equal(new Headers(cdn[0].options.headers).get('authorization'), null);
  assert.equal(cdn[0].options.redirect, 'error');
});
test('a temporary server download failure can use the matching GitHub digest', async () => {
  const { githubStore } = await load(), file = planFixture().files[0], remote = remoteFixture(file, { status: 503 });
  const store = githubStore({ token: 'synthetic-upload-token', fetchImpl: remote.fetchImpl, env: validEnv(), platform: 'win32' });
  const result = await store.verifyAsset(remote.asset, file);
  assert.equal(result.method, 'github-digest');
  assert.equal(result.downloadUnavailable, true);
});
test('a downloaded content mismatch fails even when metadata claims the expected digest', async () => {
  const { githubStore } = await load(), file = planFixture().files[0], remote = remoteFixture(file, { changed: true });
  const store = githubStore({ token: 'synthetic-upload-token', fetchImpl: remote.fetchImpl, env: validEnv(), platform: 'win32' });
  await assert.rejects(store.verifyAsset(remote.asset, file));
});

test('local preparation binds the verified installer to its report and a stable ASAR package', async t => {
  const { prepareUpload } = await load();
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), asar = require('@electron/asar');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-windows-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'release'), source = path.join(root, 'package-source');
  const archive = path.join(directory, 'win-unpacked/resources/app.asar'), reportFile = path.join(root, 'windows-release.json');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.mkdir(path.join(source, 'electron'), { recursive: true });
  await fs.writeFile(path.join(source, 'electron/main.cjs'), "'use strict';\n");
  const plan = planFixture();
  for (const file of plan.files) await fs.writeFile(path.join(directory, file.name), file.bytes);
  const report = { ok: true, platform: 'win32', arch: 'x64', version, sourceCommit: commit, installer: plan.files[0].name,
    size: plan.files[0].size, sha256: plan.files[0].sha256, stableBuild: { metadataAbsent: true } };
  const writeReport = value => fs.writeFile(reportFile, JSON.stringify(value));
  async function writeArchive({ packagedVersion = version, testBuild = false } = {}) {
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ version: packagedVersion, main: 'electron/main.cjs' }));
    const metadata = path.join(source, 'electron/reviewops-build.json');
    if (testBuild) await fs.writeFile(metadata, JSON.stringify({ channel: 'test' }));
    else await fs.rm(metadata, { force: true });
    await fs.rm(archive, { force: true });
    await asar.createPackage(source, archive); asar.uncache(archive);
  }
  const options = { directory, reportFile, env: validEnv(), platform: 'win32', version, actualCommit: commit };
  await writeReport(report); await writeArchive();
  const prepared = await prepareUpload(options);
  assert.deepEqual(prepared.files.map(file => file.name), plan.files.map(file => file.name));
  assert.equal(prepared.files[0].sha256, plan.files[0].sha256);
  for (const patch of [{ size: report.size + 1 }, { sha256: '0'.repeat(64) }, { sourceCommit: 'b'.repeat(40) }, { stableBuild: { metadataAbsent: false } }]) {
    await writeReport({ ...report, ...patch });
    await assert.rejects(prepareUpload(options));
  }
  await writeReport(report); await writeArchive({ testBuild: true });
  await assert.rejects(prepareUpload(options), /테스트 빌드/);
  await writeArchive({ packagedVersion: '1.2.9' });
  await assert.rejects(prepareUpload(options), /버전/);
});

test('draft lookup uses authenticated release listing and refreshes the selected release ID', async () => {
  const { githubStore } = await load(), calls = [];
  const draft = { id: 17, tag_name: tag, draft: true, prerelease: false, target_commitish: commit };
  const fetchImpl = async input => {
    const url = new URL(input); calls.push(url.pathname);
    if (url.pathname.endsWith('/releases')) return Response.json([draft]);
    assert.ok(url.pathname.endsWith('/releases/17'));
    return Response.json(draft);
  };
  const store = githubStore({ token: 'synthetic-upload-token', fetchImpl, env: validEnv(), platform: 'win32' });
  assert.equal((await store.getRelease(tag)).id, 17);
  assert.equal((await store.getRelease(tag)).draft, true);
  assert.equal(calls.filter(value => value.endsWith('/releases')).length, 1);
  assert.equal(calls.filter(value => value.endsWith('/releases/17')).length, 2);
  assert.equal(calls.some(value => value.includes('/releases/tags/')), false);
});

test('workflow keeps draft upload disabled by default and gates token use on explicit dispatch', async () => {
  const fs = require('node:fs/promises'), path = require('node:path'), yaml = require('js-yaml');
  const workflow = yaml.load(await fs.readFile(path.join(__dirname, '../.github/workflows/windows-release.yml'), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.publish_to_draft.default, false);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.windows.permissions.contents, 'write');
  assert.equal(workflow.jobs.windows.env.REVIEWOPS_EXPECT_STABLE_BUILD, 'true');
  const upload = workflow.jobs.windows.steps.find(step => step.run === 'node scripts/upload-windows-release.mjs');
  assert.match(upload.if, /workflow_dispatch/); assert.match(upload.if, /publish_to_draft == true/);
  assert.ok(upload.env.GITHUB_TOKEN);
  const { main } = await load();
  const env = new Proxy({ REVIEWOPS_PUBLISH_TO_DRAFT: 'false' }, { get(target, key) { if (key === 'GITHUB_TOKEN') throw new Error('Unexpected token lookup'); return target[key]; } });
  assert.deepEqual(await main([], env), { uploadSelected: false });
});
