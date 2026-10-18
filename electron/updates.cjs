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
function allowedDownload(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname)) throw new Error('The update server address is not allowed.');
  return url;
}
async function download(url, { filename, maxBytes = 1024 ** 2, expectedSize, expectedHash, onProgress, timeout = 10 * 60 * 1000, transport = https.get } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
  let output;
  try {
    if (filename) output = await fsp.open(filename, 'wx', 0o600);
    const chunks = [], hash = crypto.createHash('sha256'); let total = 0;
    async function request(value, redirects = 0) {
      if (redirects > 5) throw new Error('Too many update server redirects.');
      const target = allowedDownload(value);
      await new Promise((resolve, reject) => {
        const req = transport(target, { signal: controller.signal, headers: { 'User-Agent': 'ReviewOps-Updater', Accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } }, response => {
          if ([301,302,303,307,308].includes(response.statusCode)) { response.resume(); request(new URL(response.headers.location || '', target).href, redirects + 1).then(resolve,reject); return; }
          if (response.statusCode !== 200) { response.resume(); reject(new Error(response.statusCode === 404 ? 'No published update is available yet.' : response.statusCode === 403 || response.statusCode === 429 ? 'GitHub is limiting update checks. Try again later.' : `The update server returned HTTP ${response.statusCode}.`)); return; }
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
    if (expectedHash && hash.digest('hex') !== expectedHash) throw new Error('The update checksum does not match. Download the update again.');
    if (output) await output.sync();
    return filename ? { size: total } : Buffer.concat(chunks);
  } catch (error) {
    if (output) { await output.close(); output = null; await fsp.unlink(filename).catch(() => {}); }
    throw error;
  } finally { clearTimeout(timer); await output?.close(); }
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
async function inspectBundle(bundle, version, arch, command = run) {
  const plist = path.join(bundle, 'Contents/Info.plist');
  const read = async key => (await command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { timeout: 10000, maxBuffer: 1024 ** 2 })).stdout.trim();
  if (await read('CFBundleIdentifier') !== IDENTIFIER || await read('CFBundleShortVersionString') !== version || await read('CFBundleExecutable') !== 'ReviewOps') throw new Error('The downloaded app identity does not match ReviewOps.');
  const binary = path.join(bundle, 'Contents/MacOS/ReviewOps');
  const handle = await fsp.open(binary, 'r');
  let architectures;
  try { const header = Buffer.alloc(4096), {bytesRead} = await handle.read(header, 0, header.length, 0); architectures = machoArchitectures(header.subarray(0, bytesRead)); } finally { await handle.close(); }
  if (!architectures.includes(arch)) throw new Error('The update does not support this Mac processor.');
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120000, maxBuffer: 1024 ** 2 });
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
function createUpdateManager({ app, dataPath, shell, isBusy = () => false, platform = process.platform, arch = process.arch, onChange = () => {}, request = download, command = run, inspect = inspectBundle, spawnImpl = spawn }) {
  const version = app.getVersion(), root = path.join(dataPath, 'updates'), preferences = path.join(root, 'settings.json'), pendingFile = path.join(root, 'pending.json');
  let automatic = true, intervalMinutes = DEFAULT_INTERVAL_MINUTES, running = false, ready = null, interval = null, started = false, pendingInstall = null, status = 'idle', error = '', release = null, progress = 0, checkedAt = null;
  try { const saved=JSON.parse(fs.readFileSync(preferences, 'utf8')); automatic = saved.automatic !== false; if(validInterval(saved.intervalMinutes))intervalMinutes=saved.intervalMinutes; } catch { /* New installations use automatic checks. */ }
  try { const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); if (typeof pending.job === 'string' && path.dirname(pending.job) === root && fs.readFileSync(path.join(pending.job, 'result'), 'utf8').trim() === 'failed') { status = 'error'; error = 'The update could not start. The previous version was restored.'; } } catch { /* No previous installation result. */ }
  const supported = platform === 'darwin' && app.isPackaged && ['arm64','x64'].includes(arch) && /^\d+\.\d+\.\d+$/.test(version);
  const snapshot = () => ({ version, arch, supported, automatic, intervalMinutes, status, error, progress, checkedAt, availableVersion: release?.version || null, releaseUrl: release?.releaseUrl || RELEASES_URL });
  const emit = () => onChange(snapshot());
  const set = (next, message = '') => { status = next; error = message; emit(); };
  const privateRoot = async () => { await fsp.mkdir(root, { recursive: true, mode: 0o700 }); await fsp.chmod(root, 0o700); };
  const schedule = () => { clearInterval(interval); interval = setInterval(() => { if (automatic) manager.check().catch(() => {}); }, intervalMinutes * 60 * 1000); interval.unref?.(); };
  const manager = {
    snapshot,
    get installing() { return status === 'installing'; },
    async configure(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (!Object.hasOwn(payload,'automatic') && !Object.hasOwn(payload,'intervalMinutes'))) throw new Error('변경할 업데이트 설정을 지정하십시오.');
      if (Object.hasOwn(payload,'automatic') && typeof payload.automatic !== 'boolean') throw new Error('Choose whether to check for updates automatically.');
      if (Object.hasOwn(payload,'intervalMinutes') && !validInterval(payload.intervalMinutes)) throw new Error('업데이트 확인 주기는 1~1440분 사이의 정수로 입력하십시오.');
      const nextAutomatic = payload.automatic ?? automatic, nextInterval = payload.intervalMinutes ?? intervalMinutes;
      const enabled = nextAutomatic && !automatic, changedInterval = nextInterval !== intervalMinutes;
      await privateRoot(); atomicWrite(preferences, JSON.stringify({ automatic: nextAutomatic, intervalMinutes: nextInterval })); automatic = nextAutomatic; intervalMinutes = nextInterval;
      if (started && changedInterval) schedule();
      emit();
      if (enabled && started) return manager.check();
      return snapshot();
    },
    async check() {
      if (!supported) return snapshot();
      if (running || pendingInstall) return snapshot();
      running = true; set('checking');
      try {
        const published = JSON.parse((await request(RELEASE_API, { maxBytes: 2 * 1024 ** 2 })).toString('utf8'));
        const tagVersion = typeof published.tag_name === 'string' ? published.tag_name.replace(/^v/, '') : '';
        versionParts(tagVersion);
        if (published.draft || published.prerelease) throw new Error('Only published stable releases can be installed.');
        checkedAt = new Date().toISOString();
        if (!newer(tagVersion, version)) { release = null; set('current'); return snapshot(); }
        const manifestAsset = published.assets?.find(asset => asset.name === 'reviewops-update.json');
        if (!manifestAsset || manifestAsset.size > 1024 ** 2) throw new Error('The release does not contain update information.');
        assetUrl(manifestAsset.browser_download_url, tagVersion, 'reviewops-update.json');
        const manifest = JSON.parse((await request(manifestAsset.browser_download_url, { maxBytes: 1024 ** 2 })).toString('utf8'));
        release = manifestFor(manifest, published, arch, version);
        if (ready?.release?.sha256 !== release?.sha256) ready = null;
        set(ready ? 'ready' : 'available');
      } catch (failure) { set('error', failure.message); }
      finally { running = false; }
      return snapshot();
    },
    async download() {
      if (running || pendingInstall) return snapshot();
      if (!supported || !release) throw new Error('Check for an update first.');
      running = true; progress = 0; set('downloading');
      let job;
      try {
        await privateRoot(); await pruneUpdateCache(root, [ready?.job]); job = await fsp.mkdtemp(path.join(root, 'download-')); await fsp.chmod(job, 0o700);
        atomicWrite(path.join(job, 'metadata.json'), JSON.stringify({ owner: 'reviewops-updater', schema: 1, createdAt: Date.now() }));
        const archive = path.join(job, 'update.zip'), selected = { ...release }; let lastEmit = 0;
        await request(selected.url, { filename: archive, maxBytes: MAX_DOWNLOAD, expectedSize: selected.size, expectedHash: selected.sha256, onProgress: bytes => { progress = Math.floor(bytes / selected.size * 100); if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); emit(); } } });
        set('verifying'); await validateArchive(archive);
        const unpacked = path.join(job, 'unpacked'); await fsp.mkdir(unpacked, { mode: 0o700 });
        await command('/usr/bin/ditto', ['-x', '-k', '--norsrc', archive, unpacked], { timeout: 180000, maxBuffer: 1024 ** 2 });
        const bundle = path.join(unpacked, 'ReviewOps.app');
        await inspect(bundle, selected.version, arch, command);
        ready = { job, bundle, release: selected }; progress = 100; set('ready');
      } catch (failure) { if (job) await fsp.rm(job, { recursive: true, force: true }); ready = null; set('error', failure.message); }
      finally { running = false; }
      return snapshot();
    },
    async install() {
      if (running || pendingInstall) return snapshot();
      if (!ready || !supported) throw new Error('Download and verify the update first.');
      if (isBusy()) throw new Error('Finish active tasks and close terminal sessions before installing the update.');
      running = true;
      try {
        const executable = await fsp.realpath(app.getPath('exe')), marker = executable.lastIndexOf('/ReviewOps.app/Contents/MacOS/ReviewOps');
        if (marker < 0 || executable.slice(marker) !== '/ReviewOps.app/Contents/MacOS/ReviewOps') throw new Error('Move ReviewOps to Applications before installing an update.');
        const target = executable.slice(0, marker) + '/ReviewOps.app';
        if (target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) throw new Error('Move ReviewOps to Applications before installing an update.');
        await fsp.access(path.dirname(target), fs.constants.W_OK);
        await inspect(ready.bundle, ready.release.version, arch, command);
        const suffix = crypto.randomUUID(), incoming = path.join(path.dirname(target), `.ReviewOps-update-${suffix}.app`), previous = path.join(path.dirname(target), `.ReviewOps-previous-${suffix}.app`);
        const helper = path.join(ready.job, 'install.sh');
        await fsp.copyFile(path.join(__dirname, 'update-install.sh'), helper); await fsp.chmod(helper, 0o700);
        // Verification can take time. Work started during it still needs the
        // same protection as work that was active when installation began.
        if(isBusy())throw new Error('Finish active tasks and close terminal sessions before installing the update.');
        pendingInstall = { ...ready, target, incoming, previous, helper };
        atomicWrite(pendingFile, JSON.stringify({ job: ready.job, target, version: ready.release.version }));
        set('installing'); setImmediate(() => app.quit()); return snapshot();
      } finally { running = false; }
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
        if (pending.version === version && typeof pending.job === 'string' && path.dirname(pending.job) === root && path.basename(pending.job).startsWith('download-') && app.getPath('exe') === path.join(pending.target, 'Contents/MacOS/ReviewOps')) atomicWrite(path.join(pending.job, 'healthy'), version);
      } catch { /* Ordinary launches have no pending update. */ }
      return { acknowledged: true };
    },
    openRelease() { return shell.openExternal(release?.releaseUrl || RELEASES_URL); },
    start() {
      if (!supported || started) return;
      started = true;
      pruneUpdateCache(root, [ready?.job]).catch(() => {});
      if (automatic) manager.check().catch(() => {});
      schedule();
    },
    close() { started = false; clearInterval(interval); interval = null; }
  };
  // All callers share the current operation. A sidebar click can safely join a
  // scheduled check or a Settings download without starting a second request.
  let activeTask=null,applying=null;
  for(const name of ['check','download','install']) {
    const action=manager[name];
    manager[name]=(...args)=>{
      if(activeTask)return activeTask;
      const task=Promise.resolve().then(()=>action(...args));
      const tracked=task.finally(()=>{if(activeTask===tracked)activeTask=null;});
      activeTask=tracked;return tracked;
    };
  }
  manager.apply=()=>{
    if(applying)return applying;
    const task=(async()=>{
      try {
        if(activeTask)await activeTask;
        if(!supported||pendingInstall)return snapshot();
        if(!release){await manager.check();if(!release||status==='error')return snapshot();}
        if(!ready){await manager.download();if(!ready||status==='error')return snapshot();}
        return await manager.install();
      }catch(failure){set('error',failure.message);return snapshot();}
    })();
    applying=task.finally(()=>{applying=null;});return applying;
  };
  return manager;
}
module.exports = { createUpdateManager, manifestFor, newer, allowedDownload, download, inspectBundle, machoArchitectures, pruneUpdateCache, hasActiveWork, REPOSITORY, RELEASE_API, RELEASES_URL };
