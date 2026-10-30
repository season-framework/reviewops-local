import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
export const REPOSITORY = 'season-framework/reviewops-local';
const MAX_INSTALLER = 512 * 1024 ** 2;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export function assertUploadEnvironment({ env = process.env, platform = process.platform, version, actualCommit }) {
  if (env.GITHUB_ACTIONS !== 'true' || platform !== 'win32' || env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_JOB !== 'windows' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.REVIEWOPS_PUBLISH_TO_DRAFT !== 'true' ||
      !String(env.GITHUB_WORKFLOW_REF || '').startsWith(`${REPOSITORY}/.github/workflows/windows-release.yml@`)) throw new Error('Windows installer Actions에서 명시적으로 선택한 업로드만 허용합니다.');
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || env.REVIEWOPS_RELEASE_TAG !== `v${version}` ||
      !/^[a-f0-9]{40}$/.test(env.REVIEWOPS_REVIEWED_COMMIT || '') || env.REVIEWOPS_REVIEWED_COMMIT !== env.GITHUB_SHA || env.GITHUB_SHA !== actualCommit) throw new Error('정식 버전·태그·검토한 커밋과 현재 빌드가 일치하지 않습니다.');
}
export async function prepareUpload({ directory = path.join(root, 'release'), reportFile = path.join(root, 'test-results/windows-release.json'), env = process.env, platform = process.platform, version, actualCommit } = {}) {
  assertUploadEnvironment({ env, platform, version, actualCommit });
  const reportStat = await fs.lstat(reportFile);
  if (!reportStat.isFile() || reportStat.isSymbolicLink() || reportStat.size > 4 * 1024 ** 2) throw new Error('Windows 검사 보고서가 올바르지 않습니다.');
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  const name = `ReviewOps-${version}-windows-x64.exe`, filename = path.join(directory, name), stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || stat.size > MAX_INSTALLER) throw new Error('Windows 설치파일이 올바르지 않습니다.');
  const sha256 = await fileHash(filename);
  if (report.ok !== true || report.platform !== 'win32' || report.arch !== 'x64' || report.version !== version || report.sourceCommit !== actualCommit ||
      report.installer !== name || report.size !== stat.size || report.sha256 !== sha256 || report.stableBuild?.metadataAbsent !== true) throw new Error('Windows 검사 보고서와 실제 정식 설치파일이 일치하지 않습니다.');
  const archive = path.join(directory, 'win-unpacked/resources/app.asar'), archiveStat = await fs.lstat(archive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error('검사할 정식 앱 패키지가 없습니다.');
  const asar = require('@electron/asar');
  const entries = asar.listPackage(archive).map(entry => entry.replaceAll('\\', '/').replace(/^\//, ''));
  if (entries.includes('electron/reviewops-build.json')) throw new Error('정식 패키지에 테스트 빌드 정보가 포함되어 있습니다.');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (packaged.version !== version || packaged.main !== 'electron/main.cjs') throw new Error('정식 앱 패키지의 버전 또는 실행 파일이 다릅니다.');
  const checksumFile = `${filename}.sha256`, checksumStat = await fs.lstat(checksumFile);
  if (!checksumStat.isFile() || checksumStat.isSymbolicLink() || checksumStat.size > 1024) throw new Error('설치파일 해시 파일이 올바르지 않습니다.');
  const checksum = await fs.readFile(checksumFile);
  if (checksum.toString('utf8') !== `${sha256}  ${name}\n`) throw new Error('설치파일 해시 기록이 실제 파일과 다릅니다.');
  return { version, commit: actualCommit, tag: `v${version}`, files: [
    { name, filename, size: stat.size, sha256 },
    { name: `${name}.sha256`, filename: checksumFile, bytes: checksum, size: checksum.length, sha256: digest(checksum) },
  ] };
}
function assertPlan(plan) {
  const name = `ReviewOps-${plan.version}-windows-x64.exe`;
  if (!/^\d+\.\d+\.\d+$/.test(plan.version || '') || !/^[a-f0-9]{40}$/.test(plan.commit || '') || plan.tag !== `v${plan.version}` ||
      !Array.isArray(plan.files) || plan.files.length !== 2 || plan.files[0].name !== name || plan.files[1].name !== `${name}.sha256`) throw new Error('정식 Windows 업로드 계획이 올바르지 않습니다.');
  for (const file of plan.files) if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_INSTALLER || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw new Error('정식 Windows 업로드 파일 정보가 올바르지 않습니다.');
}
function assertDraft(release, plan, expectedId) {
  if (!release || !Number.isSafeInteger(release.id) || release.id < 1 || release.tag_name !== plan.tag || release.draft !== true || release.prerelease !== false ||
      release.immutable === true || release.target_commitish !== plan.commit || expectedId && release.id !== expectedId) throw new Error('검토한 커밋을 가리키는 기존 정식 draft만 사용할 수 있습니다.');
}
export async function uploadToDraft(plan, store) {
  assertPlan(plan); store.assertPlanAllowed?.(plan);
  const original = await store.getRelease(plan.tag); assertDraft(original, plan);
  const tagCommit = await store.getTagCommit(plan.tag);
  if (tagCommit && tagCommit !== plan.commit) throw new Error('기존 정식 태그가 검토한 커밋과 다릅니다.');
  const existing = await store.listAssets(original.id), verified = new Map();
  // Check every existing name before the first write. Conflicts never replace
  // a file, and a published release never receives new assets from this tool.
  for (const file of plan.files) {
    const matches = existing.filter(asset => asset.name === file.name);
    if (matches.length > 1) throw new Error('같은 이름의 배포 파일이 중복되어 있습니다.');
    if (matches.length) verified.set(matches[0].id, await store.verifyAsset(matches[0], file));
  }
  const uploaded = [], reused = [];
  for (const file of plan.files) {
    const release = await store.getRelease(plan.tag); assertDraft(release, plan, original.id);
    const assets = await store.listAssets(release.id), matches = assets.filter(asset => asset.name === file.name);
    if (matches.length > 1) throw new Error('같은 이름의 배포 파일이 중복되어 있습니다.');
    if (matches.length) {
      if (!verified.has(matches[0].id)) await store.verifyAsset(matches[0], file);
      reused.push(file.name);
    } else {
      await store.upload(release, file); uploaded.push(file.name);
    }
  }
  const final = await store.getRelease(plan.tag); assertDraft(final, plan, original.id);
  const finalTag = await store.getTagCommit(plan.tag);
  if (finalTag && finalTag !== plan.commit) throw new Error('업로드 중 정식 태그의 커밋이 변경되었습니다.');
  const finalAssets = await store.listAssets(final.id), verification = [];
  for (const file of plan.files) {
    const matches = finalAssets.filter(asset => asset.name === file.name);
    if (matches.length !== 1) throw new Error('업로드한 Windows 파일을 다시 찾을 수 없습니다.');
    verification.push({ name: file.name, ...(await store.verifyAsset(matches[0], file)) });
  }
  return { releaseId: final.id, tag: plan.tag, commit: plan.commit, draft: true, uploaded, reused, verification };
}
class DownloadUnavailable extends Error {
  constructor(status) { super('서버 파일을 다시 내려받을 수 없습니다.'); this.status = status; }
}
export function githubStore({ token, fetchImpl = fetch, env = process.env, platform = process.platform } = {}) {
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  const releaseIds = new Map();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ReviewOps-Windows-Release', 'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache' };
  async function request(suffix, { method = 'GET', bytes, allow404 = false, upload = false } = {}) {
    if (!token) throw new Error('Actions 업로드 토큰이 없습니다.');
    if (method !== 'GET') assertUploadEnvironment({ env, platform, version: String(env.REVIEWOPS_RELEASE_TAG || '').slice(1), actualCommit: env.GITHUB_SHA });
    const url = upload ? `https://uploads.github.com/repos/${REPOSITORY}${suffix}` : api + suffix;
    const response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(120000), headers: { ...headers, ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}) }, ...(bytes ? { body: bytes } : {}) });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub Windows 배포 요청이 실패했습니다: HTTP ${response.status}`);
    return response.json();
  }
  async function downloadedHash(asset) {
    let response;
    try { response = await fetchImpl(`${api}/releases/assets/${asset.id}?cache=${Date.now()}`, { redirect: 'manual', signal: AbortSignal.timeout(120000), headers: { ...headers, Accept: 'application/octet-stream' } }); }
    catch { throw new DownloadUnavailable('network'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      let url; try { url = new URL(response.headers.get('location')); } catch { throw new Error('서버 파일의 다운로드 주소가 올바르지 않습니다.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('서버 파일의 다운로드 주소가 허용되지 않습니다.');
      try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120000), headers: { 'Cache-Control': 'no-cache' } }); }
      catch { throw new DownloadUnavailable('network'); }
    }
    if (!response.ok) {
      if ([403, 429, 500, 502, 503, 504].includes(response.status)) throw new DownloadUnavailable(response.status);
      throw new Error(`서버 파일 재다운로드가 실패했습니다: HTTP ${response.status}`);
    }
    const hash = crypto.createHash('sha256'); let size = 0;
    try { for await (const bytes of response.body) { size += bytes.length; if (size > asset.size) throw new Error('서버 파일 크기가 일치하지 않습니다.'); hash.update(bytes); } }
    catch (error) { if (error instanceof TypeError || error.name === 'AbortError' || error.name === 'TimeoutError') throw new DownloadUnavailable('network'); throw error; }
    if (size !== asset.size) throw new Error('서버 파일 크기가 일치하지 않습니다.');
    return hash.digest('hex');
  }
  return {
    assertPlanAllowed(plan) { assertUploadEnvironment({ env, platform, version: plan.version, actualCommit: plan.commit }); },
    async getRelease(tag) {
      // The tag endpoint describes published releases. Authenticated listing
      // includes drafts; then re-read the selected ID before every upload.
      if (!releaseIds.has(tag)) {
        const matches = [];
        for (let page = 1; ; page++) {
          const releases = await request(`/releases?per_page=100&page=${page}&cache=${Date.now()}`);
          if (!Array.isArray(releases)) throw new Error('기존 릴리스 목록이 올바르지 않습니다.');
          matches.push(...releases.filter(release => release.tag_name === tag));
          if (releases.length < 100) break;
        }
        if (matches.length > 1) throw new Error('같은 태그의 릴리스가 중복되어 있습니다.');
        if (!matches.length) return null;
        releaseIds.set(tag, matches[0].id);
      }
      return request(`/releases/${releaseIds.get(tag)}?cache=${Date.now()}`, { allow404: true });
    },
    async getTagCommit(tag) {
      let ref = await request(`/git/ref/tags/${encodeURIComponent(tag)}`, { allow404: true });
      if (!ref) return null;
      for (let depth = 0; depth < 5; depth++) {
        if (ref.object?.type === 'commit' && /^[a-f0-9]{40}$/.test(ref.object.sha)) return ref.object.sha;
        if (ref.object?.type !== 'tag' || !/^[a-f0-9]{40}$/.test(ref.object.sha)) break;
        ref = await request(`/git/tags/${ref.object.sha}`);
      }
      throw new Error('정식 태그의 커밋을 읽을 수 없습니다.');
    },
    async listAssets(id) {
      const assets = [];
      for (let page = 1; ; page++) {
        const result = await request(`/releases/${id}/assets?per_page=100&page=${page}&cache=${Date.now()}`);
        if (!Array.isArray(result)) throw new Error('배포 파일 목록이 올바르지 않습니다.');
        assets.push(...result); if (result.length < 100) return assets;
      }
    },
    async upload(release, file) {
      const bytes = file.bytes || await fs.readFile(file.filename);
      if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error('업로드 직전에 설치파일이 변경되었습니다.');
      return request(`/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', bytes, upload: true });
    },
    async verifyAsset(asset, file) {
      if (asset.name !== file.name || asset.state !== 'uploaded' || asset.size !== file.size) throw new Error('서버의 Windows 파일 이름·상태·크기가 다릅니다.');
      const expectedDigest = `sha256:${file.sha256}`;
      if (asset.digest && asset.digest !== expectedDigest) throw new Error('서버의 Windows 파일 해시가 다릅니다. 기존 파일은 교체하지 않았습니다.');
      try {
        if (await downloadedHash(asset) !== file.sha256) throw new Error('서버에서 내려받은 Windows 파일 해시가 다릅니다.');
        return { method: 'download-sha256', githubDigest: asset.digest === expectedDigest };
      } catch (error) {
        if (!(error instanceof DownloadUnavailable) || asset.digest !== expectedDigest) throw error;
        return { method: 'github-digest', downloadUnavailable: true, downloadStatus: error.status };
      }
    },
  };
}
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length > 1 || args.length === 1 && args[0] !== '--check-inputs') throw new Error('Windows 업로드 명령의 옵션을 확인하십시오.');
  if (env.REVIEWOPS_PUBLISH_TO_DRAFT !== 'true') return { uploadSelected: false };
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const actualCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assertUploadEnvironment({ env, version, actualCommit });
  if (args[0] === '--check-inputs') return { uploadSelected: true, version, commit: actualCommit };
  const plan = await prepareUpload({ env, version, actualCommit });
  const store = githubStore({ token: env.GITHUB_TOKEN, env });
  return uploadToDraft(plan, store);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
