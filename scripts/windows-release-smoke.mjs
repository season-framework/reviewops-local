import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron, expect } from '@playwright/test';
import { setTestLocale } from './test-locale.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const run = promisify(execFile);
const root = process.cwd();
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = metadata.version;
const installerName = `ReviewOps-${version}-windows-x64.exe`;
const installer = path.resolve(process.argv[2] || path.join(root, 'release', installerName));
const outputRoot = path.join(root, 'test-results');
const reportFile = path.join(outputRoot, 'windows-release.json');
const report = {
  ok: false, version, platform: process.platform, arch: process.arch,
  sourceCommit: process.env.GITHUB_SHA || null,
  installer: path.basename(installer), checks: [], rendererErrors: [],
  actualAccountOperations: 0,
  unitTestScope: 'Windows-compatible suites; full existing suite runs separately on macOS.',
};
let app, page, fixtureRoot;
const check = (name, details) => {
  report.checks.push({ name, ...(details === undefined ? {} : { details }) });
  console.log(`PASS: ${name}`);
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `Unexpected source symlink: ${file}`);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
async function peInfo(file) {
  const handle = await fs.open(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    assert.equal((await handle.read(dos, 0, dos.length, 0)).bytesRead, dos.length);
    assert.equal(dos.toString('ascii', 0, 2), 'MZ', 'Missing DOS executable signature.');
    const header = Buffer.alloc(26);
    assert.equal((await handle.read(header, 0, header.length, dos.readUInt32LE(60))).bytesRead, header.length);
    assert.equal(header.toString('binary', 0, 4), 'PE\u0000\u0000', 'Missing PE signature.');
    return { machine: `0x${header.readUInt16LE(4).toString(16)}`, optionalHeader: `0x${header.readUInt16LE(24).toString(16)}` };
  } finally { await handle.close(); }
}
async function windowsFileInfo(file) {
  const script = "$ErrorActionPreference='Stop'; $item=Get-Item -LiteralPath $env:REVIEWOPS_VERIFY_BINARY; $signature=Get-AuthenticodeSignature -LiteralPath $item.FullName; [pscustomobject]@{FileVersion=$item.VersionInfo.FileVersion;ProductVersion=$item.VersionInfo.ProductVersion;ProductName=$item.VersionInfo.ProductName;SignatureStatus=[string]$signature.Status} | ConvertTo-Json -Compress";
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, REVIEWOPS_VERIFY_BINARY: file }, windowsHide: true, timeout: 30000,
  });
  return JSON.parse(stdout.trim());
}
async function nativeProcess(file, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Installer command timed out: ${path.basename(file)}`)); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} exited with ${code ?? signal}.`));
    });
  });
}
async function waitForFileState(file, exists) {
  await expect.poll(async () => {
    try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, { timeout: 30000 }).toBe(exists);
}
async function verifyAsar(archive) {
  const entries = asar.listPackage(archive).map(entry => entry.replaceAll('\\', '/').replace(/^\//, ''));
  const allowedRoots = new Set(['dist', 'electron', 'node_modules', 'package.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']);
  for (const entry of entries) {
    assert.ok(allowedRoots.has(entry.split('/')[0]), `Unexpected packaged path: ${entry}`);
    assert.ok(!/(^|\/)(?:\.git|\.ssh|\.codex|\.env(?:\.[^/]*)?|reviewops\.sqlite(?:-wal|-shm)?|credentials\.json|auth\.json|accounts\.json|test-results)(?:\/|$)/i.test(entry), `Unexpected private data path: ${entry}`);
  }
  const files = [...await walk(path.join(root, 'electron')), ...await walk(path.join(root, 'dist')),
    ...['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt'].map(name => path.join(root, name))];
  for (const file of files) {
    const relative = path.relative(root, file);
    assert.equal(digest(asar.extractFile(archive, relative)), await hashFile(file), `Packaged file does not match its source: ${relative}`);
  }
  const packagedMetadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(packagedMetadata.version, version);
  assert.equal(packagedMetadata.main, metadata.main);
  check('Packaged source, built interface, licenses, and package version match the checkout', { comparedFiles: files.length, archiveEntries: entries.length });
  check('Package contains only application files and dependencies; no user data');
  return hashFile(archive);
}

await fs.mkdir(outputRoot, { recursive: true });
try {
  assert.equal(process.platform, 'win32', 'Run this verification on native Windows.');
  assert.equal(process.arch, 'x64', 'Run this verification with x64 Node.js.');
  assert.equal(path.basename(installer), installerName);
  if (process.env.REVIEWOPS_RELEASE_TAG) assert.equal(process.env.REVIEWOPS_RELEASE_TAG, `v${version}`);
  assert.equal(metadata.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(metadata.build.nsis.perMachine, false);
  assert.equal(metadata.build.nsis.allowElevation, false);
  assert.equal(metadata.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(metadata.build.nsis.runAfterFinish, false);
  const installerPE = await peInfo(installer);
  // The NSIS bootstrap can be 32-bit while its installed application is x64.
  assert.ok(['0x14c', '0x8664'].includes(installerPE.machine));
  const installerVersion = await windowsFileInfo(installer);
  assert.ok([version, `${version}.0`].includes(installerVersion.ProductVersion), JSON.stringify(installerVersion));
  report.installerPE = installerPE;
  report.installerVersion = installerVersion;
  report.sha256 = await hashFile(installer);
  report.size = (await fs.stat(installer)).size;
  await fs.writeFile(`${installer}.sha256`, `${report.sha256}  ${installerName}\n`);
  check('Installer PE structure, product version, per-user installation, and data retention options');
  const packagedArchive = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
  const archiveHash = await verifyAsar(packagedArchive);

  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-windows-release-'));
  const installDir = path.join(fixtureRoot, 'installed');
  const fixtureHome = path.join(fixtureRoot, 'home');
  const roaming = path.join(fixtureRoot, 'roaming');
  const local = path.join(fixtureRoot, 'local');
  const dataPath = path.join(roaming, 'ReviewOps Local');
  const filesPath = path.join(fixtureRoot, 'project-files');
  const sshConfig = path.join(fixtureHome, '.ssh', 'config');
  await Promise.all([fs.mkdir(path.dirname(sshConfig), { recursive: true }), fs.mkdir(local, { recursive: true }), fs.mkdir(filesPath), fs.mkdir(path.join(dataPath, 'codex-manager'), { recursive: true })]);
  await fs.writeFile(sshConfig, '# Isolated Windows installer verification\n');
  await fs.writeFile(path.join(filesPath, 'windows-fixture.txt'), 'WINDOWS_LOCAL_PROJECT_FILE');
  // A non-existent explicit runtime prevents scanning any installed Codex login.
  await fs.writeFile(path.join(dataPath, 'codex-manager', 'runtime.json'), JSON.stringify({ path: path.join(fixtureRoot, 'codex-not-installed.exe') }));
  const keepFile = path.join(dataPath, 'keep-user-file.txt');
  const keepText = 'Preserve existing ReviewOps user files during installation and removal.\n';
  await fs.writeFile(keepFile, keepText);
  const env = { ...process.env, HOME: fixtureHome, USERPROFILE: fixtureHome, APPDATA: roaming, LOCALAPPDATA: local,
    CODEX_HOME: path.join(fixtureHome, '.codex'), REVIEWOPS_DATA_DIR: dataPath,
    REVIEWOPS_SSH_CONFIG: sshConfig, REVIEWOPS_CODEX_SSH_CONFIG: sshConfig };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_ACCESS_TOKEN']) delete env[name];
  // NSIS requires the destination switch last, without manual quote characters.
  await nativeProcess(installer, ['/S', `/D=${installDir}`], env);
  const executable = path.join(installDir, 'ReviewOps.exe');
  await waitForFileState(executable, true);
  assert.equal(await hashFile(path.join(installDir, 'resources', 'app.asar')), archiveHash);
  const installedPE = await peInfo(executable);
  assert.equal(installedPE.machine, '0x8664');
  assert.equal(installedPE.optionalHeader, '0x20b');
  const installedVersion = await windowsFileInfo(executable);
  assert.ok([version, `${version}.0`].includes(installedVersion.ProductVersion), JSON.stringify(installedVersion));
  assert.equal(installedVersion.ProductName, 'ReviewOps');
  report.installedPE = installedPE;
  report.installedVersion = installedVersion;
  check('Silent installation creates the x64 application with the expected version and unchanged app archive');
  assert.equal(await fs.readFile(keepFile, 'utf8'), keepText);

  const invoke = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.invoke(action, payload), { action, payload });
  async function launch() {
    app = await electron.launch({ executablePath: executable, args: ['--disable-gpu'], env, timeout: 45000 });
    app.process().stderr?.on('data', chunk => fs.appendFile(path.join(outputRoot, 'windows-electron.log'), chunk).catch(() => {}));
    page = await app.firstWindow();
    page.on('pageerror', error => report.rendererErrors.push(error.message));
    page.setDefaultTimeout(15000);
    await setTestLocale(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1000, height: 700 }));
    await expect(page.getByRole('heading', { name: '홈', exact: true })).toBeVisible();
    const info = await invoke('app.info');
    assert.equal(info.platform, 'win32'); assert.equal(info.arch, 'x64'); assert.equal(info.version, version);
    assert.equal(path.resolve(info.dataPath).toLowerCase(), path.resolve(dataPath).toLowerCase());
    const accountState = await page.evaluate(() => window.accountManager.getState());
    assert.equal(accountState.accounts.length, 0);
    assert.equal(accountState.runtime.available, false);
  }
  async function closeWindow() {
    const closed = app.waitForEvent('close', { timeout: 20000 });
    await page.getByRole('button', { name: '창 닫기', exact: true }).click();
    await closed;
    app = null; page = null;
  }
  await launch();
  check('Installed application launches its home screen and IPC in an isolated profile');
  const refresh = page.locator('.workspace-refresh');
  const enterFullScreen = () => page.getByRole('button', { name: '창 전체 화면', exact: true });
  const leaveFullScreen = () => page.getByRole('button', { name: '창 전체 화면 종료', exact: true });
  const closeButton = page.getByRole('button', { name: '창 닫기', exact: true });
  const geometry = await page.locator('.workspace-tabs').evaluate(strip => {
    const controls = [strip.querySelector('.workspace-refresh'), ...strip.querySelectorAll('.window-control')];
    return controls.map(node => ({ x: node.getBoundingClientRect().x, right: node.getBoundingClientRect().right, cursor: getComputedStyle(node).cursor }));
  });
  assert.equal(geometry.length, 3);
  assert.ok(geometry[0].right <= geometry[1].x + 1 && geometry[1].right <= geometry[2].x + 1);
  assert.equal(geometry[1].cursor, 'pointer'); assert.equal(geometry[2].cursor, 'pointer');
  await page.mouse.move(5, 100);
  const initialBackground = await closeButton.evaluate(node => getComputedStyle(node).backgroundColor);
  await closeButton.hover();
  await expect.poll(() => closeButton.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(initialBackground);
  await refresh.focus(); await page.keyboard.press('Tab'); await expect(enterFullScreen()).toBeFocused();
  await enterFullScreen().press('Enter');
  await expect.poll(async () => (await invoke('window.state')).fullScreen).toBe(true);
  await expect(leaveFullScreen()).toHaveAttribute('aria-pressed', 'true');
  await leaveFullScreen().click();
  await expect.poll(async () => (await invoke('window.state')).fullScreen).toBe(false);
  check('Top-right refresh, full-screen, and close icons support mouse, keyboard, and native full-screen changes');

  const group = await invoke('group.save', { name: 'Windows 설치 검사' });
  const service = await invoke('service.save', { name: 'Windows 로컬 폴더', groupId: group.id, kind: 'local', rootPath: filesPath });
  const project = await invoke('project.save', { name: 'Windows 저장 검사', groupId: group.id, serviceIds: [service.id], description: 'Windows 설치 후 저장한 프로젝트입니다.' });
  const projectFile = await invoke('files.read', { serviceId: service.id, path: 'windows-fixture.txt' });
  assert.match(JSON.stringify(projectFile), /WINDOWS_LOCAL_PROJECT_FILE/);
  await refresh.click();
  await expect(page.getByRole('button', { name: `${project.name} 프로젝트 열기`, exact: true })).toBeVisible();
  const stored = await invoke('snapshot');
  assert.equal(stored.services.find(item => item.id === service.id).rootPath, filesPath);
  assert.equal(stored.projects.find(item => item.id === project.id).name, project.name);
  await page.screenshot({ path: path.join(outputRoot, 'windows-installed.png') });
  check('Windows local folder, file reading, project saving, and refresh');
  await closeWindow();
  check('Close icon shuts down the installed application');
  await launch();
  const restored = await invoke('snapshot');
  assert.equal(restored.projects.find(item => item.id === project.id).name, project.name);
  assert.equal(restored.services.find(item => item.id === service.id).rootPath, filesPath);
  assert.equal(await fs.readFile(keepFile, 'utf8'), keepText);
  await closeWindow();
  assert.deepEqual(report.rendererErrors, []);
  check('Restart preserves saved projects, Windows paths, and existing user files');

  const databaseFile = path.join(dataPath, 'reviewops.sqlite');
  const databaseHash = await hashFile(databaseFile);
  const uninstaller = (await fs.readdir(installDir)).find(name => /^Uninstall.*\.exe$/i.test(name));
  assert.ok(uninstaller, 'Uninstaller is missing.');
  // _?= keeps NSIS in the current process so exit means removal has finished.
  await nativeProcess(path.join(installDir, uninstaller), ['/S', `_?=${installDir}`], env);
  await waitForFileState(executable, false);
  assert.equal(await fs.readFile(keepFile, 'utf8'), keepText);
  assert.equal(await hashFile(databaseFile), databaseHash);
  check('Silent uninstall removes the executable and preserves the user database and existing files');
  report.ok = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  if (page) await page.screenshot({ path: path.join(outputRoot, 'windows-failure.png') }).catch(() => {});
  process.exitCode = 1;
  console.error(error);
} finally {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
    await app.close().catch(() => {});
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
}
