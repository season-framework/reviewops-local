import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { validateBuildInfo } = require('../electron/build-info.cjs');

export const REPOSITORY = 'season-framework/reviewops-local';
export const TAG = 'test-latest';
export const PUBLICATION_GROUP = 'reviewops-test-latest';
export const ROOT_URL = `https://github.com/${REPOSITORY}/releases/download/${TAG}/`;
export const marker = '<!-- reviewops-test-pointer:';
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const buildKey = build => `${build.buildNumber}-${build.commit.slice(0, 12)}`;
export const manifestName = build => `reviewops-test-update-${buildKey(build)}.json`;
const managedAsset = /^(?:ReviewOps-\d+\.\d+\.\d+-test\.\d+-(?:arm64|x64)\.(?:zip|dmg)(?:\.sha256)?|ReviewOps-\d+\.\d+\.\d+-test\.\d+-windows-x64\.exe(?:\.sha256)?|reviewops-test-update-\d+-[a-f0-9]{12}\.json)$/;
let publishing = false;
export function namesFor(build) {
  validateBuildInfo(build);
  const prefix = `ReviewOps-${build.version}-test.${build.buildNumber}`;
  return [`${prefix}-arm64.zip`, `${prefix}-arm64.dmg`, `${prefix}-x64.zip`, `${prefix}-x64.dmg`, `${prefix}-windows-x64.exe`];
}
export async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export function pointerFromBody(body) {
  if (!body?.includes(marker)) return null;
  const matches = [...body.matchAll(/<!-- reviewops-test-pointer:(.*?) -->/g)];
  if (matches.length !== 1) throw new Error('테스트 릴리스의 최신 빌드 표시가 올바르지 않습니다.');
  let pointer; try { pointer = JSON.parse(matches[0][1]); } catch { throw new Error('테스트 빌드 표시를 읽을 수 없습니다.'); }
  if (pointer.schema !== 1 || !Number.isSafeInteger(pointer.buildNumber) || pointer.buildNumber < 1 ||
      !/^[a-f0-9]{40}$/.test(pointer.commit || '') || !/^[a-f0-9]{64}$/.test(pointer.sha256 || '') ||
      !Number.isSafeInteger(pointer.size) || pointer.size < 1 || pointer.size > 1024 ** 2 ||
      pointer.manifest !== `reviewops-test-update-${pointer.buildNumber}-${pointer.commit.slice(0, 12)}.json`) throw new Error('테스트 빌드 표시가 올바르지 않습니다.');
  return pointer;
}
function assertRelease(release) {
  if (!release || release.tag_name !== TAG || release.draft || !release.prerelease || release.immutable) throw new Error('변경 가능한 test-latest 테스트 릴리스만 사용할 수 있습니다.');
}
function assertOrder(pointer, build, expectedPointer = undefined) {
  if (pointer && pointer.buildNumber > build.buildNumber) throw new Error('더 최신 테스트 빌드가 이미 공개되어 있습니다.');
  if (pointer && pointer.buildNumber === build.buildNumber && pointer.commit !== build.commit) throw new Error('같은 빌드번호가 다른 커밋에 사용되었습니다.');
  if (expectedPointer !== undefined && JSON.stringify(pointer) !== JSON.stringify(expectedPointer)) throw new Error('게시 준비 중 최신 테스트 빌드가 변경되었습니다.');
}
export function ciBuildNumber(env = process.env) {
  const run = Number(env.GITHUB_RUN_NUMBER), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 999 || !Number.isSafeInteger(run * 1000 + attempt)) throw new Error('Actions 실행 번호가 올바르지 않습니다.');
  return run * 1000 + attempt;
}
export function assertPublicationCI(build, env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_JOB !== 'publish' ||
      !String(env.GITHUB_WORKFLOW_REF || '').startsWith(`${REPOSITORY}/.github/workflows/test-release.yml@`) ||
      env.REVIEWOPS_PUBLICATION_GROUP !== PUBLICATION_GROUP || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('실제 게시는 test-release Actions의 단일 게시 작업에서만 실행할 수 있습니다.');
  const latestNumber = ciBuildNumber(env);
  // Re-run failed jobs may reuse successful metadata/package jobs from an
  // earlier attempt of this same run. A full rerun assigns a new attempt.
  if (build && (Math.floor(build.buildNumber / 1000) !== Number(env.GITHUB_RUN_NUMBER) ||
      build.buildNumber % 1000 < 1 || build.buildNumber > latestNumber || build.commit !== env.GITHUB_SHA)) throw new Error('현재 Actions 실행과 게시할 빌드 정보가 다릅니다.');
}
export async function prepareRelease(directory, build) {
  build = validateBuildInfo(build);
  const files = [];
  for (const name of namesFor(build)) {
    const filename = path.join(directory, name), stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || stat.size > 512 * 1024 ** 2) throw new Error(`설치파일 크기 또는 형식이 올바르지 않습니다: ${name}`);
    files.push({ name, filename, size: stat.size, sha256: await fileHash(filename), url: ROOT_URL + name });
  }
  const verification = [];
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const record = JSON.parse(await fs.readFile(path.join(directory, `verification-${target}.json`), 'utf8'));
    if (record.schema !== 1 || record.target !== target || record.ok !== true || JSON.stringify(validateBuildInfo(record.build)) !== JSON.stringify(build) ||
        !Array.isArray(record.checks) || !record.checks.includes('packaged-build-info') || !record.checks.includes('package-structure') ||
        (target.startsWith('darwin') && (!record.checks.includes('codesign') || !record.checks.includes('dmg-verify'))) ||
        (target === 'win32-x64' && (!record.checks.includes('publisher-status') || !record.checks.includes('installed-application')))) throw new Error(`패키지 검사 결과가 올바르지 않습니다: ${target}`);
    const expected = files.filter(file => target === 'win32-x64' ? file.name.endsWith('.exe') : file.name.endsWith(`-${target.slice(7)}.zip`) || file.name.endsWith(`-${target.slice(7)}.dmg`));
    for (const file of expected) if (!record.files?.some(item => item.name === file.name && item.size === file.size && item.sha256 === file.sha256)) throw new Error(`검사 후 설치파일이 변경되었습니다: ${file.name}`);
    verification.push(record);
  }
  const descriptor = file => ({ name: file.name, url: file.url, size: file.size, sha256: file.sha256 });
  const bySuffix = suffix => descriptor(files.find(file => file.name.endsWith(suffix)));
  const manifest = { schema: 2, channel: 'test', version: build.version, build,
    artifacts: { 'darwin-arm64': bySuffix('-arm64.zip'), 'darwin-x64': bySuffix('-x64.zip'), 'win32-x64': bySuffix('-windows-x64.exe') },
    installers: { 'darwin-arm64': bySuffix('-arm64.dmg'), 'darwin-x64': bySuffix('-x64.dmg'), 'win32-x64': bySuffix('-windows-x64.exe') } };
  const manifestBytes = jsonBytes(manifest), name = manifestName(build);
  const pointer = { schema: 1, manifest: name, buildNumber: build.buildNumber, commit: build.commit, size: manifestBytes.length, sha256: hash(manifestBytes) };
  const assets = [...files];
  for (const file of files) {
    const bytes = Buffer.from(`${file.sha256}  ${file.name}\n`);
    assets.push({ name: `${file.name}.sha256`, bytes, size: bytes.length, sha256: hash(bytes) });
  }
  assets.push({ name, bytes: manifestBytes, size: manifestBytes.length, sha256: hash(manifestBytes) });
  return { build, manifest, pointer, assets, verification };
}
function describe(plan) { return { tag: TAG, releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`, pointer: plan.pointer, files: plan.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })), build: plan.build }; }
export async function publishRelease(plan, store, { dryRun = true } = {}) {
  validateBuildInfo(plan.build);
  if (!dryRun && publishing) throw new Error('이미 테스트 게시 작업을 실행 중입니다.');
  if (!dryRun) publishing = true;
  try { return await publishLocked(plan, store, dryRun); } finally { if (!dryRun) publishing = false; }
}
async function publishLocked(plan, store, dryRun) {
  if (!dryRun) store.assertBuildAllowed?.(plan.build);
  const original = await store.getRelease();
  if (original) assertRelease(original);
  const originalPointer = pointerFromBody(original?.body);
  assertOrder(originalPointer, plan.build);
  // Dry run uses only public reads. No token lookup, upload, PATCH or DELETE.
  if (dryRun) return { dryRun: true, ...describe(plan), replaces: originalPointer, retainedReleaseItems: 1 };
  let release = original || await store.createRelease(plan.build.commit);
  assertRelease(release);
  const before = await store.listAssets(release.id);
  for (const asset of before) if (!managedAsset.test(asset.name)) throw new Error(`알 수 없는 파일이 있어 게시를 중단했습니다: ${asset.name}`);
  const previousNames = new Set(before.map(item => item.name));
  const wanted = new Set(plan.assets.map(item => item.name));
  const isCurrent = name => originalPointer && (name === originalPointer.manifest || name.includes(`-test.${originalPointer.buildNumber}-`));
  for (const file of plan.assets) {
    let existing = (await store.listAssets(release.id)).find(item => item.name === file.name);
    // GitHub may retain a zero-byte starter after an upload 502. Recover only
    // unpublished incomplete files; never replace an already published name.
    if (existing?.state === 'starter' && existing.size === 0 && !isCurrent(existing.name)) {
      await store.deleteAsset(existing.id);
      if (await store.assetExists(existing.id)) throw new Error('실패한 업로드 파일을 정리하지 못했습니다.');
      existing = null;
    }
    if (existing) {
      if (existing.state && existing.state !== 'uploaded' || existing.size !== file.size || await store.hashAsset(existing) !== file.sha256) throw new Error(`동일한 파일 이름의 내용이 다릅니다: ${file.name}`);
    } else await store.upload(release, file);
    const uploaded = (await store.listAssets(release.id)).find(item => item.name === file.name);
    if (!uploaded || uploaded.state && uploaded.state !== 'uploaded' || uploaded.size !== file.size || await store.hashAsset(uploaded) !== file.sha256) throw new Error(`업로드 검사에 실패했습니다: ${file.name}`);
  }
  release = await store.getRelease(); assertRelease(release);
  const currentPointer = pointerFromBody(release.body);
  assertOrder(currentPointer, plan.build, originalPointer);
  if (currentPointer?.buildNumber === plan.build.buildNumber && currentPointer.sha256 !== plan.pointer.sha256) throw new Error('같은 빌드의 안내 파일 내용이 변경되었습니다.');
  if (JSON.stringify(currentPointer) !== JSON.stringify(plan.pointer)) {
    const body = `# ReviewOps 테스트 버전\n\n정식 출시 전 기능을 확인할 수 있는 버전입니다. 최신 설치파일 한 벌만 유지합니다.\n\n앱 버전: ${plan.build.version} · 빌드: ${plan.build.buildNumber}\n\n커밋: ${plan.build.commit}\n\n빌드 시각: ${plan.build.builtAt}\n\n${marker}${JSON.stringify(plan.pointer)} -->\n`;
    // One body PATCH switches the complete set. The workflow's global lock is
    // held through upload, this switch and cleanup. Git tags never move.
    await store.setPointer(release.id, body);
  }
  async function assertOwned() {
    const latest = await store.getRelease(); assertRelease(latest);
    if (latest.id !== release.id || JSON.stringify(pointerFromBody(latest.body)) !== JSON.stringify(plan.pointer)) throw new Error('최신 테스트 빌드 표시가 변경되었습니다. 이전 파일은 삭제하지 않았습니다.');
    return latest;
  }
  const committed = await assertOwned();
  for (const file of plan.assets) {
    const asset = (await store.listAssets(committed.id)).find(item => item.name === file.name);
    if (!asset || asset.size !== file.size || await store.hashAsset(asset) !== file.sha256) throw new Error('공개한 테스트 파일을 다시 검증하지 못했습니다. 이전 파일은 유지합니다.');
  }
  const cleanup = (await store.listAssets(committed.id)).filter(item => !wanted.has(item.name));
  for (const asset of cleanup) {
    if (!managedAsset.test(asset.name)) throw new Error(`알 수 없는 파일을 삭제하지 않았습니다: ${asset.name}`);
    await assertOwned();
    await store.deleteAsset(asset.id);
  }
  const final = await assertOwned(), finalAssets = await store.listAssets(final.id);
  if (finalAssets.length !== wanted.size || finalAssets.some(item => !wanted.has(item.name))) throw new Error('이전 테스트 파일 정리 결과가 일치하지 않습니다. 같은 빌드를 재실행하십시오.');
  for (const asset of cleanup) if (await store.assetExists(asset.id)) throw new Error('삭제한 이전 파일이 아직 조회됩니다. 같은 빌드를 재실행하십시오.');
  return { dryRun: false, ...describe(plan), removed: cleanup.map(item => item.name), reused: [...previousNames].filter(name => wanted.has(name)), retainedReleaseItems: 1 };
}

export function githubStore(token, fetchImpl = fetch, env = process.env) {
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  async function request(url, { method = 'GET', body, binary = false, allow404 = false } = {}) {
    if (method !== 'GET') { assertPublicationCI(null, env); if (!token) throw new Error('Actions 게시 토큰이 없습니다.'); }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.github.com', 'uploads.github.com'].includes(parsed.hostname)) throw new Error('게시 API 주소가 올바르지 않습니다.');
    const response = await fetchImpl(url, { method, redirect: 'error', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/vnd.github+json', 'User-Agent': 'ReviewOps-Test-Release', 'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache', ...(body ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) }, body: body ? binary ? body : JSON.stringify(body) : undefined });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub 테스트 게시 요청이 실패했습니다: HTTP ${response.status}`);
    return response;
  }
  return {
    assertBuildAllowed(build) { assertPublicationCI(build, env); },
    async getRelease() { const r = await request(`${api}/releases/tags/${TAG}?cache=${Date.now()}`, { allow404: true }); return r ? r.json() : null; },
    async createRelease(commit) { return (await request(`${api}/releases`, { method: 'POST', body: { tag_name: TAG, target_commitish: commit, name: 'ReviewOps 테스트 버전', body: '', prerelease: true, draft: false, make_latest: 'false' } })).json(); },
    async listAssets(id) { const all = []; for (let page = 1; ; page++) { const result = await (await request(`${api}/releases/${id}/assets?per_page=100&page=${page}&cache=${Date.now()}`)).json(); all.push(...result); if (result.length < 100) return all; } },
    async upload(release, file) { const bytes = file.bytes || await fs.readFile(file.filename); if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error('업로드 직전에 설치파일이 변경되었습니다.'); await request(`https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: bytes, binary: true }); },
    async hashAsset(asset) {
      // Redirects are handled manually. Never forward the Actions token to CDN.
      let response = await fetchImpl(`${api}/releases/assets/${asset.id}?cache=${Date.now()}`, { redirect: 'manual', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/octet-stream', 'Cache-Control': 'no-cache' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const url = new URL(response.headers.get('location'));
        if (url.protocol !== 'https:' || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('설치파일 검사 주소가 올바르지 않습니다.');
        response = await fetchImpl(url, { redirect: 'error', headers: { 'Cache-Control': 'no-cache' } });
      }
      if (!response.ok) throw new Error(`설치파일 재다운로드가 실패했습니다: HTTP ${response.status}`);
      const digest = crypto.createHash('sha256'); let total = 0;
      for await (const chunk of response.body) { total += chunk.length; if (total > asset.size) throw new Error('설치파일 크기가 다릅니다.'); digest.update(chunk); }
      if (total !== asset.size) throw new Error('설치파일 크기가 다릅니다.');
      return digest.digest('hex');
    },
    async setPointer(id, body) { await request(`${api}/releases/${id}`, { method: 'PATCH', body: { body, prerelease: true, make_latest: 'false' } }); },
    async deleteAsset(id) { await request(`${api}/releases/assets/${id}`, { method: 'DELETE', allow404: true }); },
    async assetExists(id) { return Boolean(await request(`${api}/releases/assets/${id}?cache=${Date.now()}`, { allow404: true })); },
  };
}
export async function main(args = process.argv.slice(2), env = process.env) {
  let directory = 'release/test', buildFile, publish = false, offline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--publish') publish = true;
    else if (args[i] === '--dry-run') publish = false;
    else if (args[i] === '--offline') offline = true;
    else if (args[i] === '--directory' && args[i + 1]) directory = args[++i];
    else if (args[i] === '--build-info' && args[i + 1]) buildFile = args[++i];
    else throw new Error('테스트 게시 명령의 옵션을 확인하십시오.');
  }
  if (publish && offline) throw new Error('오프라인 검사에서는 게시할 수 없습니다.');
  const build = JSON.parse(await fs.readFile(buildFile || path.join(directory, 'build-info.json'), 'utf8'));
  const plan = await prepareRelease(directory, build);
  if (publish) assertPublicationCI(plan.build, env);
  const store = offline ? { getRelease: async () => null } : githubStore(publish ? env.GITHUB_TOKEN : undefined, fetch, env);
  return publishRelease(plan, store, { dryRun: !publish });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
