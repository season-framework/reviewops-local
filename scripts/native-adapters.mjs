// Ignored preparation only. Import defines helpers; it launches no process/app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';

export const canonicalPath = file => fs.realpathSync.native(file);
export const targets = new Set(['darwin-x64', 'darwin-arm64', 'win32-x64']);
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const fileHash = file => sha256(fs.readFileSync(file));
export const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
export function requireNativeHost(target) {
  assert.ok(targets.has(target), 'Declare an exact supported test target');
  assert.equal(`${process.platform}-${process.arch}`, target, 'No emulated target/unsupported skip');
  assert.equal(process.versions.electron, undefined, 'Driver/service Node must be standalone');
}
// Bind the main process through the original Electron handle, never from a descriptor PID.
export function verifyOriginalMainProcess(identity) {
  assert.ok(identity && typeof identity === 'object' && !Array.isArray(identity), 'Original main identity is required');
  const {platform, expectedPlatform, pid, ppid, childPID} = identity;
  assert.ok(['darwin', 'win32', 'linux'].includes(expectedPlatform), 'Expected native platform is required');
  assert.equal(platform, expectedPlatform, 'Original main platform differs from the driver');
  for (const value of [pid, ppid, childPID])
    assert.ok(Number.isSafeInteger(value) && value > 0, 'Original process IDs must be positive safe integers');
  assert.notEqual(pid, ppid, 'A process cannot be its own parent');
  if (platform === 'win32') {
    // Pinned Playwright launches both source and packaged Electron through a Windows shell.
    assert.notEqual(pid, childPID, 'Windows main must be distinct from its retained shell');
    assert.equal(ppid, childPID, 'Windows main parent differs from the original retained shell');
  } else assert.equal(pid, childPID, 'Main differs from the original retained direct child');
  return Object.freeze({platform, expectedPlatform, pid, ppid, childPID});
}
export function verifyOriginalConnectionPID(identity, descriptorPID) {
  const original = verifyOriginalMainProcess(identity);
  assert.ok(Number.isSafeInteger(descriptorPID) && descriptorPID > 0, 'Descriptor PID must be a positive safe integer');
  assert.equal(descriptorPID, original.pid, 'Owned descriptor PID differs from the original main process');
  return original;
}

export function privatePaths(privateRoot) {
  const root = fs.realpathSync(privateRoot);
  assert.match(path.basename(root), /^(?:rv-on-|ro-owned-ui-)/, 'Use a short, fresh owned native fixture root');
  return { root, home: path.join(root, 'home'), data: path.join(root, 'data'),
    temp: path.join(root, 'tmp'), bin: path.join(root, 'bin'),
    journal: path.join(root, 'launcher-journal'), ssh: path.join(root, 'home', '.ssh', 'config') };
}
export function createPrivatePaths(repository) {
  // macOS os.tmpdir() can produce a 104-byte UNIX socket after realpath().
  // Use short /private/tmp, without changing the product's 103-byte limit.
  const prefix = process.platform === 'darwin' ? path.join('/tmp', 'ro-owned-ui-') : path.join(os.tmpdir(), 'rv-on-');
  const paths = privatePaths(fs.mkdtempSync(prefix));
  for (const dir of [paths.home, paths.data, paths.temp, paths.bin, paths.journal, path.dirname(paths.ssh)])
    fs.mkdirSync(dir, {recursive: true});
  const require = createRequire(path.join(repository, 'package.json'));
  const {toolSocketPath} = require(path.join(repository, 'electron', 'tool-integration.cjs'));
  const socketPath = toolSocketPath(paths.data, process.platform); // actual production helper, before app launch
  if (process.platform !== 'win32') assert.ok(Buffer.byteLength(socketPath) <= 103);
  else assert.ok(socketPath.startsWith('\\\\.\\pipe\\'), 'Keep the actual Windows named-pipe policy');
  return {...paths, socketPreflight: {path: socketPath, bytes: Buffer.byteLength(socketPath), productionHelper: true}};
}
export function privateEnvironment(paths, nodeExecutable, source = process.env) {
  assert.equal(fs.realpathSync(nodeExecutable), fs.realpathSync(process.execPath));
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TZ']) if (source[key]) env[key] = source[key];
  const system = process.platform === 'win32'
    ? [path.join(source.SystemRoot || source.WINDIR, 'System32'), source.SystemRoot || source.WINDIR]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  Object.assign(env, { HOME: paths.home, USERPROFILE: paths.home,
    APPDATA: path.join(paths.home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(paths.home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(paths.home, 'config'), XDG_CACHE_HOME: path.join(paths.home, 'cache'),
    TMPDIR: paths.temp, TMP: paths.temp, TEMP: paths.temp, CODEX_HOME: path.join(paths.home, '.codex'),
    PATH: [paths.bin, path.dirname(nodeExecutable), ...system].join(path.delimiter),
    REVIEWOPS_DATA_DIR: paths.data, REVIEWOPS_SSH_CONFIG: paths.ssh, REVIEWOPS_CODEX_SSH_CONFIG: paths.ssh });
  // No inherited login/API/proxy/Node hook environment. Never log source env.
  return env;
}
export function appPaths(target, input) {
  requireNativeHost(target);
  if (input.mode === 'source') return { args: [fs.realpathSync(input.repository)], mode: 'source' };
  assert.ok(['private-bundle', 'nsis-installed'].includes(input.mode));
  const root = canonicalPath(input.privateInstallRoot), app = canonicalPath(input.app);
  const temporaryBases = [canonicalPath(os.tmpdir())];
  if (process.platform === 'darwin') temporaryBases.push(canonicalPath('/tmp'));
  if (process.env.RUNNER_TEMP) temporaryBases.push(canonicalPath(process.env.RUNNER_TEMP));
  assert.ok(temporaryBases.some(base => root !== base && inside(base, root)));
  assert.match(path.basename(root), /^(?:owned-service-|rv-on-|ro-owned-ui-|reviewops-)/);
  assert.ok(inside(root, app) && app !== root, 'App must belong to the reviewed private installation');
  if (target.startsWith('darwin-')) {
    assert.equal(input.mode, 'private-bundle'); assert.ok(app.endsWith('.app'));
    return { executablePath: path.join(app, 'Contents', 'MacOS', 'ReviewOps'), args: [], mode: input.mode,
      resources: path.join(app, 'Contents', 'Resources') };
  }
  assert.equal(input.mode, 'nsis-installed', 'win-unpacked is not an installed-app claim');
  assert.equal(path.basename(app), 'ReviewOps.exe');
  assert.ok(input.installReceipt && input.bundleManifest, 'Actual NSIS + installed PE/ASAR receipt required');
  return { executablePath: app, args: [], mode: input.mode, resources: path.join(path.dirname(app), 'resources') };
}
export function trustedHostURL(raw, target) {
  try {
    const u = new URL(raw);
    return u.protocol === 'reviewops:' && u.host === 'app' && u.pathname === '/index.html' &&
      !u.username && !u.password && u.searchParams.getAll('projectId').length === 1 &&
      u.searchParams.getAll('windowId').length === 1 && u.searchParams.get('projectId') === target.projectId &&
      u.searchParams.get('windowId') === target.windowId;
  } catch { return false; }
}
export async function selectMainHost(application, until, ipc, bounded) {
  return until(async () => {
    const pages = application.windows().filter(page => {
      if (page.isClosed()) return false;
      try { const u = new URL(page.url()); return u.protocol === 'reviewops:' && u.host === 'app' &&
        u.pathname === '/index.html' && !u.username && !u.password &&
        !u.searchParams.has('projectId') && !u.searchParams.has('windowId'); } catch { return false; }
    });
    assert.ok(pages.length <= 1, 'Multiple main hosts; do not choose a first child window');
    if (!pages.length || !await bounded(pages[0].evaluate(() => Boolean(window.reviewops?.invoke)), 'main host bridge', 1000)) return null;
    const context = await bounded(ipc(pages[0], 'window.context'), 'main host context', 3000);
    assert.ok(!context.projectId && !context.qaProjectId);
    return {page: pages[0], context};
  }, Boolean, 'owned unbound trusted app host');
}
export async function selectProjectHost(application, target, until, ipc, bounded) {
  assert.equal(typeof target.projectId, 'string'); assert.ok(target.projectId);
  assert.equal(typeof target.windowId, 'string'); assert.ok(target.windowId);
  return until(async () => {
    const pages = application.windows().filter(p => !p.isClosed() && trustedHostURL(p.url(), target));
    assert.ok(pages.length <= 1, 'Duplicate exact host identity');
    if (!pages.length || !await bounded(pages[0].evaluate(() => Boolean(window.reviewops?.invoke)), 'exact host bridge', 1000)) return null;
    const context = await bounded(ipc(pages[0], 'window.context'), 'exact host context', 3000);
    assert.equal(context.projectId, target.projectId); assert.equal(context.windowId, target.windowId);
    return { page: pages[0], context };
  }, Boolean, 'exact returned project/window host');
}
export async function sourceIdentity(application, page, sourceURL, browserId, ipc, bounded, {allowPending=false}={}) {
  const state = await bounded(ipc(page, 'browser.state', { id: browserId }), 'source browser state', 3000);
  assert.equal(new URL(state.url).href, new URL(sourceURL).href);
  const host = await bounded(application.browserWindow(page), 'source app host handle', 3000);
  const hostId = await bounded(host.evaluate(w => w.id), 'source app host identity', 3000);
  return bounded(application.evaluate(({ BrowserWindow }, { hostId, sourceURL, allowPending }) => {
    const found = [];
    const visit = (view, clip) => {
      if (view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL() === sourceURL)
        found.push({ webContentsId: view.webContents.id, clipWindowId: clip.id, parentWindowId: hostId,
          url: sourceURL, clipVisible: clip.isVisible(), backgroundThrottling: view.webContents.getBackgroundThrottling() });
      for (const child of view.children || []) visit(child, clip);
    };
    for (const clip of BrowserWindow.getAllWindows())
      if (!clip.isDestroyed() && clip.getParentWindow()?.id === hostId) visit(clip.contentView, clip);
    if (found.length === 0 && allowPending) return null;
    if (found.length !== 1) throw new Error('Expected one exact source view in this owned host');
    return found[0];
  }, { hostId, sourceURL: new URL(sourceURL).href, allowPending }), 'exact native source identity', 3000);
}
export function rawPNG(dataURL) {
  assert.ok(dataURL.startsWith('data:image/png;base64,'));
  const bytes = Buffer.from(dataURL.slice('data:image/png;base64,'.length), 'base64');
  assert.ok(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0);
  return { bytes, width, height, sha256: sha256(bytes), edited: false };
}
export async function nativePhoto(application, page, sourceURL, browserId, ipc, bounded) {
  const before = await sourceIdentity(application, page, sourceURL, browserId, ipc, bounded);
  // Use the actual product adapter/temporary capture lease, with original PNG.
  // Never change capture options, background policy, resize, focus, or emulate a frame.
  const image = await bounded(ipc(page, 'browser.capture', { id: browserId }), 'original native source photo', 10000);
  const after = await sourceIdentity(application, page, sourceURL, browserId, ipc, bounded);
  assert.deepEqual(after, before); assert.equal(new URL(image.url).href, new URL(sourceURL).href);
  return { ...rawPNG(image.dataUrl), source: before, scope: 'exact native source; separate from full app-host content' };
}
export function windowsFixtureLocations(paths) {
  // Optional .cmd is an intentionally non-executable canary for the product's
  // vendor resolution. Configure the native EXE directly for the main agent3 run.
  return { direct: path.join(paths.bin, 'codex.exe'), shim: path.join(paths.bin, 'codex.cmd'),
    shimContents: '@echo off\r\nexit /b 86\r\n',
    vendor: path.join(paths.bin, 'node_modules', '@openai', 'codex-win32-x64', 'vendor',
      'x86_64-pc-windows-msvc', 'bin', 'codex.exe') };
}
