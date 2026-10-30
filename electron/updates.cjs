'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const { atomicWrite } = require('./vault.cjs');
const { validateArchive } = require('./update-archive.cjs');
const run = promisify(execFile);
const REPOSITORY = 'season-framework/reviewops-local';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const TEST_TAG = 'test-latest';
const TEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/tags/${TEST_TAG}`;
const TEST_RELEASE_URL = `${RELEASES_URL}/tag/${TEST_TAG}`;
const MAX_DOWNLOAD = 512 * 1024 ** 2;
const DEFAULT_INTERVAL_MINUTES = 10;
const validInterval = value => Number.isInteger(value) && value >= 1 && value <= 1440;
const IDENTIFIER = 'kr.co.season.reviewops.local';
function versionParts(value) {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) throw new Error('The release version is invalid.');
  return value.split('.').map(Number);
}
function newer(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function assetUrl(value, version, filename) {
  if (value !== `${RELEASES_URL}/download/v${version}/${filename}`) throw new Error('The update download address is invalid.');
  return value;
}
function manifestFor(manifest, release, arch, currentVersion) {
  if (!manifest || manifest.schema !== 1 || release.draft || release.prerelease) throw new Error('The update information is invalid.');
  versionParts(manifest.version);
  if (release.tag_name !== `v${manifest.version}`) throw new Error('The release version does not match its update information.');
  if (!newer(manifest.version, currentVersion)) return null;
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Updates are not available for this processor.');
  const item = manifest.artifacts?.[`darwin-${arch}`], filename = `ReviewOps-${manifest.version}-${arch}.zip`;
  if (!item || item.name !== filename || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1024 || item.size > MAX_DOWNLOAD) throw new Error('An update for this Mac is not available in this release.');
  assetUrl(item.url, manifest.version, filename);
  const publishedAsset = release.assets?.find(asset => asset.name === filename);
  if (!publishedAsset || publishedAsset.size !== item.size || publishedAsset.browser_download_url !== item.url) throw new Error('The update file does not match the GitHub release.');
  return { ...item, version: manifest.version, releaseUrl: `${RELEASES_URL}/tag/v${manifest.version}` };
}
function updateFailure(code, message) { return Object.assign(new Error(message), { code }); }
function testBuild(value, version) {
  if (!value || value.channel !== 'test' || value.version !== version || !Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1 || !/^[a-f0-9]{40}$/.test(value.commit) || typeof value.builtAt !== 'string' || !Number.isFinite(Date.parse(value.builtAt)) || new Date(value.builtAt).toISOString() !== value.builtAt) throw updateFailure('invalid_manifest', '테스트 버전의 빌드 정보가 올바르지 않습니다.');
  versionParts(value.version);
  return { channel: 'test', version, buildNumber: value.buildNumber, commit: value.commit, builtAt: value.builtAt };
}
function testPointer(release) {
  if (!release || release.draft || !release.prerelease || release.tag_name !== TEST_TAG) throw updateFailure('invalid_manifest', '테스트 버전의 공개 정보가 올바르지 않습니다.');
  const pointers = [...String(release.body || '').matchAll(/<!-- reviewops-test-pointer:(.*?) -->/g)];
  if (!pointers.length) throw updateFailure('test_unavailable', '공개된 테스트 설치파일이 없습니다.');
  if (pointers.length !== 1) throw updateFailure('invalid_manifest', '테스트 버전의 파일 정보가 중복되었습니다.');
  let value; try { value = JSON.parse(pointers[0][1]); } catch { throw updateFailure('invalid_manifest', '테스트 버전의 파일 정보를 읽을 수 없습니다.'); }
  if (value.schema !== 1 || !Number.isSafeInteger(value.buildNumber) || value.buildNumber < 1 || !/^[a-f0-9]{40}$/.test(value.commit) || value.manifest !== `reviewops-test-update-${value.buildNumber}-${value.commit.slice(0,12)}.json` || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 1024 ** 2) throw updateFailure('invalid_manifest', '테스트 버전의 파일 정보가 올바르지 않습니다.');
  const asset = release.assets?.find(item => item.name === value.manifest), url = `${RELEASES_URL}/download/${TEST_TAG}/${value.manifest}`;
  if (!asset || asset.size !== value.size || asset.browser_download_url !== url) throw updateFailure('test_unavailable', '테스트 버전의 안내 파일이 없습니다. 다시 확인하십시오.');
  return { ...value, url };
}
function testManifestFor(manifest, published, arch, currentVersion, installedBuild, platform = 'darwin', highestBuild = null) {
  if (!manifest || manifest.schema !== 2 || manifest.channel !== 'test' || published.draft || !published.prerelease || published.tag_name !== TEST_TAG) throw updateFailure('invalid_manifest', '테스트 업데이트 정보가 올바르지 않습니다.');
  const build = testBuild(manifest.build, manifest.version);
  if (newer(currentVersion, build.version)) throw updateFailure('older_build', '설치된 앱보다 낮은 테스트 버전은 설치하지 않습니다.');
  for (const known of [installedBuild?.channel === 'test' ? installedBuild : null, highestBuild]) {
    if (!known) continue;
    if (build.buildNumber < known.buildNumber) throw updateFailure('older_build', '이전에 받은 테스트 빌드보다 오래된 파일입니다. 다시 확인하십시오.');
    if (build.buildNumber === known.buildNumber && (build.commit !== known.commit || build.version !== known.version || build.builtAt !== known.builtAt)) throw updateFailure('invalid_manifest', '같은 빌드번호의 앱 정보가 다릅니다. 설치를 중단했습니다.');
  }
  const key = `${platform}-${arch}`, item = manifest.artifacts?.[key];
  const filename = platform === 'darwin' ? `ReviewOps-${build.version}-test.${build.buildNumber}-${arch}.zip` : `ReviewOps-${build.version}-test.${build.buildNumber}-windows-${arch}.exe`;
  if (!['darwin-arm64','darwin-x64','win32-x64'].includes(key) || !item || item.name !== filename || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1024 || item.size > MAX_DOWNLOAD || item.url !== `${RELEASES_URL}/download/${TEST_TAG}/${filename}`) throw updateFailure('test_unavailable', '이 컴퓨터에서 사용할 테스트 설치파일이 없습니다.');
  const asset = published.assets?.find(value => value.name === filename);
  if (!asset || asset.size !== item.size || asset.browser_download_url !== item.url) throw updateFailure('invalid_manifest', '테스트 설치파일과 업데이트 정보가 다릅니다.');
  if (installedBuild?.channel === 'test' && build.buildNumber === installedBuild.buildNumber) return null;
  return { ...item, version: build.version, build, channel: 'test', releaseUrl: TEST_RELEASE_URL };
}
function allowedDownload(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname)) throw new Error('The update server address is not allowed.');
  return url;
}
async function download(url, { filename, maxBytes = 1024 ** 2, expectedSize, expectedHash, onProgress, signal, timeout = 10 * 60 * 1000, transport = https.get } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
  let output;
  try {
    if (filename) output = await fsp.open(filename, 'wx', 0o600);
    const chunks = [], hash = crypto.createHash('sha256'); let total = 0;
    async function request(value, redirects = 0) {
      if (redirects > 5) throw new Error('Too many update server redirects.');
      const target = allowedDownload(value);
      await new Promise((resolve, reject) => {
        const req = transport(target, { signal: controller.signal, headers: { 'User-Agent': 'ReviewOps-Updater', Accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', 'Cache-Control': 'no-cache', Pragma: 'no-cache' } }, response => {
          if ([301,302,303,307,308].includes(response.statusCode)) { response.resume(); request(new URL(response.headers.location || '', target).href, redirects + 1).then(resolve,reject); return; }
          if (response.statusCode !== 200) { response.resume(); reject(updateFailure(response.statusCode === 404 ? 'not_found' : 'network_error', response.statusCode === 404 ? 'No published update is available yet.' : response.statusCode === 403 || response.statusCode === 429 ? 'GitHub is limiting update checks. Try again later.' : `The update server returned HTTP ${response.statusCode}.`)); return; }
          if (Number(response.headers['content-length'] || 0) > maxBytes) { response.destroy(); reject(new Error('The update download exceeds its size limit.')); return; }
          (async () => {
            for await (const chunk of response) {
              total += chunk.length;
              if (total > maxBytes || (expectedSize && total > expectedSize)) throw new Error('The update download exceeds its expected size.');
              hash.update(chunk);
              if (output) { let offset = 0; while (offset < chunk.length) { const written = await output.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) throw new Error('The update file could not be written.'); offset += written.bytesWritten; } } else chunks.push(chunk);
              onProgress?.(total);
            }
          })().then(resolve, error => { response.destroy(); reject(error); });
        });
        req.setTimeout(30000, () => req.destroy(new Error('The update download timed out.')));
        req.on('error', reject);
      });
    }
    await request(url);
    if (expectedSize && total !== expectedSize) throw new Error('The update download is incomplete.');
    if (expectedHash && hash.digest('hex') !== expectedHash) throw updateFailure('hash_mismatch', 'The update checksum does not match. Download the update again.');
    if (output) await output.sync();
    return filename ? { size: total } : Buffer.concat(chunks);
  } catch (error) {
    if (output) { await output.close(); output = null; await fsp.unlink(filename).catch(() => {}); }
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await output?.close(); }
}
function machoArchitectures(bytes) {
  const cpu = value => value === 0x0100000c ? 'arm64' : value === 0x01000007 ? 'x64' : null;
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) throw new Error('The update executable is invalid.');
  const little = bytes.readUInt32LE(0), big = bytes.readUInt32BE(0);
  if (little === 0xfeedfacf) return [cpu(bytes.readUInt32LE(4))].filter(Boolean);
  if (big === 0xfeedfacf) return [cpu(bytes.readUInt32BE(4))].filter(Boolean);
  const fat64 = big === 0xcafebabf || little === 0xcafebabf;
  if (![0xcafebabe, 0xcafebabf].includes(big) && ![0xcafebabe, 0xcafebabf].includes(little)) throw new Error('The update executable is invalid.');
  const read = [0xcafebabe, 0xcafebabf].includes(big) ? offset => bytes.readUInt32BE(offset) : offset => bytes.readUInt32LE(offset);
  const count = read(4), stride = fat64 ? 32 : 20;
  if (!count || count > 32 || 8 + count * stride > bytes.length) throw new Error('The update executable is invalid.');
  return Array.from({ length: count }, (_, index) => cpu(read(8 + index * stride))).filter(Boolean);
}
async function inspectBundle(bundle, version, arch, command = run, expectedBuild = null) {
  const plist = path.join(bundle, 'Contents/Info.plist');
  const read = async key => (await command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { timeout: 10000, maxBuffer: 1024 ** 2 })).stdout.trim();
  if (await read('CFBundleIdentifier') !== IDENTIFIER || await read('CFBundleShortVersionString') !== version || await read('CFBundleExecutable') !== 'ReviewOps') throw new Error('The downloaded app identity does not match ReviewOps.');
  const binary = path.join(bundle, 'Contents/MacOS/ReviewOps');
  const handle = await fsp.open(binary, 'r');
  let architectures;
  try { const header = Buffer.alloc(4096), {bytesRead} = await handle.read(header, 0, header.length, 0); architectures = machoArchitectures(header.subarray(0, bytesRead)); } finally { await handle.close(); }
  if (!architectures.includes(arch)) throw new Error('The update does not support this Mac processor.');
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120000, maxBuffer: 1024 ** 2 });
  if (expectedBuild) {
    let raw; try { raw = await fsp.readFile(path.join(bundle, 'Contents/Resources/app.asar/electron/reviewops-build.json'), 'utf8'); } catch { throw updateFailure('build_mismatch', '다운로드한 앱의 빌드 정보를 읽을 수 없습니다.'); }
    let actual; try { actual = testBuild(JSON.parse(raw), version); } catch { throw updateFailure('build_mismatch', '다운로드한 앱의 빌드 정보가 올바르지 않습니다.'); }
    if (JSON.stringify(actual) !== JSON.stringify(testBuild(expectedBuild, version))) throw updateFailure('build_mismatch', '다운로드한 앱과 안내된 빌드 정보가 다릅니다.');
  }
}
async function inspectWindowsInstaller(filename, selected) {
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== selected.size) throw updateFailure('invalid_installer', '설치파일 크기 또는 형식이 올바르지 않습니다.');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== selected.sha256) throw updateFailure('hash_mismatch', '설치파일이 변경되었습니다. 다시 받으십시오.');
  const handle = await fsp.open(filename, 'r');
  try {
    const header = Buffer.alloc(64); await handle.read(header, 0, header.length, 0);
    const offset = header.readUInt32LE(60);
    if (header.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset > stat.size - 4) throw updateFailure('invalid_installer', 'Windows 설치파일 형식이 올바르지 않습니다.');
    const pe = Buffer.alloc(4); await handle.read(pe, 0, 4, offset);
    if (!pe.equals(Buffer.from([80, 69, 0, 0]))) throw updateFailure('invalid_installer', 'Windows 설치파일 형식이 올바르지 않습니다.');
  } finally { await handle.close(); }
}
function hasActiveWork({ operations, terminals, codexManager, agents }) {
  const account = codexManager?.accountState?.(), host = codexManager?.hostState?.();
  const blockingOperations=[...(operations || [])].some(token=>{
    if(typeof token!=='string'||!token.startsWith('agent:')||!agents||agents.hasBlockingJobs!==false)return true;
    try {const job=agents.read(token.slice(6));return !(job.kind==='agent'&&job.remoteExecution?.version===1&&job.remoteExecution.ready);}catch{return true;}
  });
  return Boolean(blockingOperations || agents?.hasBlockingJobs || terminals?.size || account?.refresh?.running || account?.accounts?.some(item => ['loading','loggingIn'].includes(item.status) || item.resetAttempt?.status === 'pending') || host?.refresh?.running || host?.batchUpgrade?.running || host?.hosts?.some(item => item.operation?.running) || codexManager?.fileService?.operations?.size || codexManager?.fileService?.getTransfers?.().some(item => item.status === 'running'));
}
async function pruneUpdateCache(root, protectedJobs = []) {
  let contents; try { contents = await fsp.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const protectedPaths = new Set(protectedJobs.filter(value => typeof value === 'string' && path.dirname(value) === root));
  try { const pending = JSON.parse(await fsp.readFile(path.join(root, 'pending.json'), 'utf8')); if (typeof pending.job === 'string' && path.dirname(pending.job) === root) protectedPaths.add(pending.job); } catch {}
  const candidates = [];
  for (const item of contents) {
    if (!item.isDirectory() || !/^download-[A-Za-z0-9]{6}$/.test(item.name)) continue;
    const job = path.join(root, item.name), marker = path.join(job, 'metadata.json');
    try {
      const stat = await fsp.lstat(marker); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) continue;
      const metadata = JSON.parse(await fsp.readFile(marker, 'utf8'));
      if (metadata.owner !== 'reviewops-updater' || metadata.schema !== 1 || !Number.isFinite(metadata.createdAt)) continue;
      let installed = false; try { installed = (await fsp.readFile(path.join(job, 'result'), 'utf8')).trim() === 'installed'; } catch {}
      candidates.push({ job, createdAt: metadata.createdAt, installed });
    } catch { /* Unknown directories never belong to the cleanup operation. */ }
  }
  candidates.sort((a,b) => b.createdAt - a.createdAt);
  for (const item of candidates.slice(0, 2)) protectedPaths.add(item.job);
  const lastInstalled = candidates.find(item => item.installed); if (lastInstalled) protectedPaths.add(lastInstalled.job);
  for (const item of candidates) if (!protectedPaths.has(item.job)) await fsp.rm(item.job, { recursive: true, force: true });
}
function createUpdateManager({ app, dataPath, shell, isBusy = () => false, platform = process.platform, arch = process.arch, onChange = () => {}, request = download, command = run, inspect = inspectBundle, spawnImpl = spawn, buildInfo = null }) {
  const version = app.getVersion(), root = path.join(dataPath, 'updates'), preferences = path.join(root, 'settings.json'), pendingFile = path.join(root, 'pending.json');
  let installedBuild = buildInfo?.channel === 'test' ? testBuild(buildInfo, version) : { channel: 'stable', version };
  let automatic = true, intervalMinutes = DEFAULT_INTERVAL_MINUTES, channel = 'stable', highestTestBuild = null;
  let ready = null, interval = null, started = false, pendingInstall = null, status = 'idle', error = '', errorCode = '', release = null, progress = 0, checkedAt = null;
  let generation = 0, activeTask = null, applying = null, controller = null, configuration = Promise.resolve();
  try {
    const saved = JSON.parse(fs.readFileSync(preferences, 'utf8'));
    automatic = saved.automatic !== false; if (validInterval(saved.intervalMinutes)) intervalMinutes = saved.intervalMinutes;
    if (saved.channel === 'test' || saved.testUpdates === true) channel = 'test';
    if (saved.highestTestBuild) highestTestBuild = testBuild(saved.highestTestBuild, saved.highestTestBuild.version);
  } catch { /* Missing preferences keep stable updates selected. */ }
  try { const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); if (typeof pending.job === 'string' && path.dirname(pending.job) === root && fs.readFileSync(path.join(pending.job, 'result'), 'utf8').trim() === 'failed') { status = 'error'; error = 'The update could not start. The previous version was restored.'; errorCode = 'install_failed'; } } catch { /* No previous installation result. */ }
  const supported = platform === 'darwin' && app.isPackaged && ['arm64','x64'].includes(arch) && /^\d+\.\d+\.\d+$/.test(version);
  const testSupported = supported || (platform === 'win32' && app.isPackaged && arch === 'x64');
  const canCheck = () => supported || (channel === 'test' && testSupported);
  const snapshot = () => ({ version, arch, supported, testSupported, canCheck: canCheck(), manualInstall: !supported && canCheck(), automatic, intervalMinutes, channel, testUpdates: channel === 'test', installedBuild: { ...installedBuild }, availableBuild: release?.build || null, generation, status, error, errorCode, progress, checkedAt, availableVersion: release?.version || null, releaseUrl: release?.releaseUrl || (channel === 'test' ? TEST_RELEASE_URL : RELEASES_URL) });
  const emit = () => onChange(snapshot());
  const set = (next, message = '', code = '') => { status = next; error = message; errorCode = code; emit(); };
  const stale = Symbol('old update channel');
  const guard = epoch => { if (generation !== epoch) throw stale; };
  const privateRoot = async () => { await fsp.mkdir(root, { recursive: true, mode: 0o700 }); await fsp.chmod(root, 0o700); };
  const preferenceValues = (nextAutomatic = automatic, nextInterval = intervalMinutes, nextChannel = channel) => ({ automatic: nextAutomatic, intervalMinutes: nextInterval, ...(nextChannel === 'test' ? { channel: 'test' } : {}), ...(highestTestBuild ? { highestTestBuild } : {}) });
  const savePreferences = () => atomicWrite(preferences, JSON.stringify(preferenceValues()));
  const schedule = () => { clearInterval(interval); interval = setInterval(() => { if (automatic) manager.check().catch(() => {}); }, intervalMinutes * 60 * 1000); interval.unref?.(); };
  const manager = {
    snapshot,
    get installing() { return status === 'installing'; },
    configure(payload) {
      const task = configuration.then(async () => {
        if (pendingInstall || status === 'installing') throw new Error('설치가 끝난 뒤 업데이트 설정을 변경하십시오.');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !['automatic','intervalMinutes','channel','testUpdates'].some(key => Object.hasOwn(payload,key))) throw new Error('변경할 업데이트 설정을 지정하십시오.');
        if (Object.hasOwn(payload,'automatic') && typeof payload.automatic !== 'boolean') throw new Error('Choose whether to check for updates automatically.');
        if (Object.hasOwn(payload,'intervalMinutes') && !validInterval(payload.intervalMinutes)) throw new Error('업데이트 확인 주기는 1~1440분 사이의 정수로 입력하십시오.');
        if (Object.hasOwn(payload,'channel') && !['stable','test'].includes(payload.channel)) throw new Error('정식 버전 또는 테스트 버전을 선택하십시오.');
        if (Object.hasOwn(payload,'testUpdates') && typeof payload.testUpdates !== 'boolean') throw new Error('테스트 버전 받기 설정을 선택하십시오.');
        if (Object.hasOwn(payload,'channel') && Object.hasOwn(payload,'testUpdates') && (payload.channel === 'test') !== payload.testUpdates) throw new Error('업데이트 설정이 서로 다릅니다.');
        const nextAutomatic = payload.automatic ?? automatic, nextInterval = payload.intervalMinutes ?? intervalMinutes;
        const nextChannel = payload.channel ?? (Object.hasOwn(payload,'testUpdates') ? payload.testUpdates ? 'test' : 'stable' : channel);
        const enabled = nextAutomatic && !automatic, changedInterval = nextInterval !== intervalMinutes, changedChannel = nextChannel !== channel;
        await privateRoot();
        if (pendingInstall || status === 'installing') throw new Error('설치가 끝난 뒤 업데이트 설정을 변경하십시오.');
        atomicWrite(preferences, JSON.stringify(preferenceValues(nextAutomatic, nextInterval, nextChannel)));
        automatic = nextAutomatic; intervalMinutes = nextInterval;
        if (changedChannel) {
          generation++; controller?.abort(); controller = null; activeTask = null; applying = null;
          channel = nextChannel; release = null; ready = null; pendingInstall = null; checkedAt = null; progress = 0;
          await fsp.unlink(pendingFile).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
          set('idle');
        } else emit();
        if (started && changedInterval) schedule();
        return { check: changedChannel || (enabled && started) };
      });
      configuration = task.catch(() => {});
      return task.then(result => result.check ? manager.check() : snapshot());
    },
    async check(epoch, signal) {
      if (!canCheck() || pendingInstall) return snapshot();
      set('checking');
      try {
        const checkingChannel = channel;
        const published = JSON.parse((await request(checkingChannel === 'test' ? TEST_RELEASE_API : RELEASE_API, { maxBytes: 2 * 1024 ** 2, signal })).toString('utf8')); guard(epoch);
        let candidate;
        if (checkingChannel === 'test') {
          const pointer = testPointer(published);
          const manifest = JSON.parse((await request(pointer.url, { maxBytes: 1024 ** 2, expectedSize: pointer.size, expectedHash: pointer.sha256, signal })).toString('utf8')); guard(epoch);
          if (manifest.build?.buildNumber !== pointer.buildNumber || manifest.build?.commit !== pointer.commit) throw updateFailure('invalid_manifest', '테스트 안내 파일과 공개한 빌드 정보가 다릅니다.');
          candidate = testManifestFor(manifest, published, arch, version, installedBuild, platform, highestTestBuild);
          highestTestBuild = testBuild(manifest.build, manifest.version); await privateRoot(); guard(epoch); savePreferences();
        } else {
          const tagVersion = typeof published.tag_name === 'string' ? published.tag_name.replace(/^v/, '') : '';
          versionParts(tagVersion);
          if (published.draft || published.prerelease) throw new Error('Only published stable releases can be installed.');
          if (!newer(tagVersion, version)) { release = null; ready = null; checkedAt = new Date().toISOString(); set('current'); return snapshot(); }
          const manifestAsset = published.assets?.find(asset => asset.name === 'reviewops-update.json');
          if (!manifestAsset || manifestAsset.size > 1024 ** 2) throw new Error('The release does not contain update information.');
          assetUrl(manifestAsset.browser_download_url, tagVersion, 'reviewops-update.json');
          const manifest = JSON.parse((await request(manifestAsset.browser_download_url, { maxBytes: 1024 ** 2, signal })).toString('utf8')); guard(epoch);
          candidate = manifestFor(manifest, published, arch, version);
        }
        release = candidate; checkedAt = new Date().toISOString();
        if (ready?.release?.sha256 !== release?.sha256 || ready?.generation !== epoch) ready = null;
        set(!release ? 'current' : ready ? 'ready' : 'available');
      } catch (failure) {
        if (generation === epoch && failure !== stale) { release = null; ready = null; set('error', failure.message, channel === 'test' && failure.code === 'not_found' ? 'test_unavailable' : failure.code || 'network_error'); }
      }
      return snapshot();
    },
    async download(epoch, signal) {
      if (pendingInstall) return snapshot();
      if (!canCheck() || !release) throw new Error('Check for an update first.');
      const selected = { ...release }; progress = 0; set('downloading');
      let job;
      try {
        await privateRoot(); guard(epoch); await pruneUpdateCache(root, [ready?.job]); guard(epoch);
        job = await fsp.mkdtemp(path.join(root, 'download-')); await fsp.chmod(job, 0o700); guard(epoch);
        atomicWrite(path.join(job, 'metadata.json'), JSON.stringify({ owner: 'reviewops-updater', schema: 1, createdAt: Date.now() }));
        const archive = path.join(job, supported ? 'update.zip' : selected.name); let lastEmit = 0;
        await request(selected.url, { filename: archive, maxBytes: MAX_DOWNLOAD, expectedSize: selected.size, expectedHash: selected.sha256, signal, onProgress: bytes => { if (generation !== epoch) return; progress = Math.floor(bytes / selected.size * 100); if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); emit(); } } }); guard(epoch);
        set('verifying');
        if (!supported) {
          await inspectWindowsInstaller(archive, selected); guard(epoch);
          ready = { job, installer: archive, release: selected, generation: epoch }; progress = 100; set('ready');
          return snapshot();
        }
        await validateArchive(archive); guard(epoch);
        const unpacked = path.join(job, 'unpacked'); await fsp.mkdir(unpacked, { mode: 0o700 }); guard(epoch);
        await command('/usr/bin/ditto', ['-x', '-k', '--norsrc', archive, unpacked], { timeout: 180000, maxBuffer: 1024 ** 2 }); guard(epoch);
        const bundle = path.join(unpacked, 'ReviewOps.app');
        await inspect(bundle, selected.version, arch, command, selected.build || null); guard(epoch);
        ready = { job, bundle, release: selected, generation: epoch }; progress = 100; set('ready');
      } catch (failure) {
        if (job) await fsp.rm(job, { recursive: true, force: true });
        if (generation === epoch && failure !== stale) {
          ready = null;
          if (selected.channel === 'test' && failure.code === 'not_found') {
            release = null;
            set('error', '테스트 버전이 변경되었습니다. 업데이트를 다시 확인하십시오.', 'test_changed');
          } else set('error', failure.message, failure.code || 'download_failed');
        }
      }
      return snapshot();
    },
    async install(epoch) {
      if (pendingInstall) return snapshot();
      if (!ready || ready.generation !== epoch || !canCheck() || ready.release.channel !== (channel === 'test' ? 'test' : undefined)) throw new Error('Download and verify the update first.');
      if (isBusy()) throw new Error('Finish active tasks and close terminal sessions before installing the update.');
      const selectedReady = ready;
      if (!supported) {
        set('verifying');
        try {
          await inspectWindowsInstaller(selectedReady.installer, selectedReady.release); guard(epoch);
          if (isBusy()) throw new Error('Finish active tasks and close terminal sessions before installing the update.');
          set('installing');
          const failure = await shell.openPath(selectedReady.installer); guard(epoch);
          if (failure) throw updateFailure('installer_failed', '설치파일을 열지 못했습니다. 다시 시도하십시오.');
          set('ready');
        } catch (failure) {
          if (failure === stale) throw failure;
          if (generation === epoch) set('error', failure.code === 'installer_failed' ? '설치파일을 열지 못했습니다. 다시 시도하십시오.' : failure.message, failure.code || 'install_failed');
        }
        return snapshot();
      }
      const executable = await fsp.realpath(app.getPath('exe')); guard(epoch);
      const marker = executable.lastIndexOf('/ReviewOps.app/Contents/MacOS/ReviewOps');
      if (marker < 0 || executable.slice(marker) !== '/ReviewOps.app/Contents/MacOS/ReviewOps') throw new Error('Move ReviewOps to Applications before installing an update.');
      const target = executable.slice(0, marker) + '/ReviewOps.app';
      if (target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) throw new Error('Move ReviewOps to Applications before installing an update.');
      await fsp.access(path.dirname(target), fs.constants.W_OK); guard(epoch);
      await inspect(selectedReady.bundle, selectedReady.release.version, arch, command, selectedReady.release.build || null); guard(epoch);
      const suffix = crypto.randomUUID(), incoming = path.join(path.dirname(target), `.ReviewOps-update-${suffix}.app`), previous = path.join(path.dirname(target), `.ReviewOps-previous-${suffix}.app`);
      const helper = path.join(selectedReady.job, 'install.sh');
      await fsp.copyFile(path.join(__dirname, 'update-install.sh'), helper); await fsp.chmod(helper, 0o700); guard(epoch);
      if (isBusy()) throw new Error('Finish active tasks and close terminal sessions before installing the update.');
      pendingInstall = { ...selectedReady, target, incoming, previous, helper };
      atomicWrite(pendingFile, JSON.stringify({ job: selectedReady.job, target, version: selectedReady.release.version, build: selectedReady.release.build || null }));
      set('installing'); setImmediate(() => { if (generation === epoch && pendingInstall?.generation === epoch) app.quit(); }); return snapshot();
    },
    cancelInstall() { if (pendingInstall) { pendingInstall = null; set('ready'); } },
    launchInstall() {
      if (!pendingInstall) return;
      const plan = pendingInstall; pendingInstall = null;
      const log = fs.openSync(path.join(plan.job, 'install.log'), 'a', 0o600);
      try { const child = spawnImpl('/bin/sh', [plan.helper, String(process.pid), plan.target, plan.bundle, plan.job, plan.incoming, plan.previous], { detached: true, stdio: ['ignore', log, log], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir(), REVIEWOPS_DATA_DIR: dataPath, ...(process.env.REVIEWOPS_SSH_CONFIG ? { REVIEWOPS_SSH_CONFIG: process.env.REVIEWOPS_SSH_CONFIG } : {}), ...(process.env.REVIEWOPS_CODEX_SSH_CONFIG ? { REVIEWOPS_CODEX_SSH_CONFIG: process.env.REVIEWOPS_CODEX_SSH_CONFIG } : {}) } }); child.on?.('error', failure => { try { fs.appendFileSync(path.join(plan.job, 'install.log'), failure.message + '\n'); } catch {} }); child.unref(); } finally { fs.closeSync(log); }
    },
    markHealthy() {
      try {
        const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        const buildMatches = !pending.build || (installedBuild.channel === 'test' && JSON.stringify(testBuild(pending.build, version)) === JSON.stringify(installedBuild));
        if (buildMatches && pending.version === version && typeof pending.job === 'string' && path.dirname(pending.job) === root && path.basename(pending.job).startsWith('download-') && app.getPath('exe') === path.join(pending.target, 'Contents/MacOS/ReviewOps')) atomicWrite(path.join(pending.job, 'healthy'), version);
      } catch { /* Ordinary launches have no pending update. */ }
      return { acknowledged: true };
    },
    openRelease() { return shell.openExternal(release?.releaseUrl || (channel === 'test' ? TEST_RELEASE_URL : RELEASES_URL)); },
    start() {
      if (started) return;
      started = true;
      pruneUpdateCache(root, [ready?.job]).catch(() => {});
      if (automatic && canCheck()) manager.check().catch(() => {});
      schedule();
    },
    close() { started = false; clearInterval(interval); interval = null; generation++; controller?.abort(); controller = null; }
  };
  for (const name of ['check','download','install']) {
    const action = manager[name];
    manager[name] = () => {
      if (activeTask) return activeTask;
      const epoch = generation, currentController = new AbortController(); controller = currentController;
      const task = Promise.resolve().then(() => { guard(epoch); return action(epoch, currentController.signal); }).catch(failure => { if (failure === stale || generation !== epoch) return snapshot(); throw failure; });
      const tracked = task.finally(() => { if (activeTask === tracked) { activeTask = null; if (controller === currentController) controller = null; } });
      activeTask = tracked; return tracked;
    };
  }
  manager.apply = () => {
    if (applying) return applying;
    const epoch = generation;
    const task = (async () => {
      try {
        if (activeTask) await activeTask; guard(epoch);
        if (!supported || pendingInstall) return snapshot();
        if (!release) { await manager.check(); guard(epoch); if (!release || status === 'error') return snapshot(); }
        if (!ready) { await manager.download(); guard(epoch); if (!ready || status === 'error') return snapshot(); }
        return await manager.install();
      } catch (failure) { if (generation === epoch && failure !== stale) set('error', failure.message, failure.code || 'install_failed'); return snapshot(); }
    })();
    const tracked = task.finally(() => { if (applying === tracked) applying = null; }); applying = tracked; return tracked;
  };
  return manager;
}
module.exports = { createUpdateManager, manifestFor, newer, allowedDownload, download, inspectBundle, inspectWindowsInstaller, machoArchitectures, pruneUpdateCache, hasActiveWork, REPOSITORY, RELEASE_API, RELEASES_URL, TEST_RELEASE_API, TEST_RELEASE_URL, TEST_TAG, testManifestFor, testPointer, testBuild };
