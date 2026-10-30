import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { withBuildInfo } from './build-info.mjs';
import { fileHash, namesFor, jsonBytes } from './test-release.mjs';
const require = createRequire(import.meta.url), run = promisify(execFile);
const { validateBuildInfo } = require('../electron/build-info.cjs');
const { validateArchive } = require('../electron/update-archive.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const asar = require('@electron/asar');
export const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];

export function packagedBuildInfo(archive, expected) {
  const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
  const allowed = new Set(['dist', 'electron', 'node_modules', 'package.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']);
  for (const entry of entries) {
    if (!allowed.has(entry.split('/')[0]) || /(^|\/)(?:\.git|\.ssh|\.codex|\.env(?:\.[^/]*)?|reviewops\.sqlite(?:-wal|-shm)?|credentials\.json|auth\.json|accounts\.json|test-results)(?:\/|$)/i.test(entry)) throw new Error(`패키지에 허용하지 않은 파일이 있습니다: ${entry}`);
  }
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  const actual = validateBuildInfo(JSON.parse(asar.extractFile(archive, 'electron/reviewops-build.json').toString('utf8')), expected.version);
  if (pkg.version !== expected.version || JSON.stringify(actual) !== JSON.stringify(validateBuildInfo(expected))) throw new Error('패키지의 빌드 정보가 생성한 빌드와 다릅니다.');
  return actual;
}
async function inspectMac(bundle, build, arch) {
  const plist = path.join(bundle, 'Contents/Info.plist');
  const read = async key => (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim();
  if (await read('CFBundleIdentifier') !== 'kr.co.season.reviewops.local' || await read('CFBundleShortVersionString') !== build.version || await read('CFBundleExecutable') !== 'ReviewOps') throw new Error('macOS 앱 정보가 올바르지 않습니다.');
  const { stdout } = await run('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents/MacOS/ReviewOps')]);
  if (!stdout.trim().split(/\s+/).includes(arch === 'x64' ? 'x86_64' : arch)) throw new Error('macOS 실행파일의 CPU 종류가 다릅니다.');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120000 });
  packagedBuildInfo(path.join(bundle, 'Contents/Resources/app.asar'), build);
}
async function windowsPublisher(installer) {
  const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:REVIEWOPS_VERIFY_BINARY; [pscustomobject]@{status=[string]$s.Status;subject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null}} | ConvertTo-Json -Compress";
  const env = { ...process.env, REVIEWOPS_VERIFY_BINARY: installer };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, timeout: 30000 });
  const result = JSON.parse(stdout.trim());
  if (!['Valid', 'NotSigned'].includes(result.status)) throw new Error('Windows 설치파일 서명 검사가 실패했습니다.');
  // Existing ReviewOps Windows installers are unsigned. Record this truthfully.
  return result;
}
export async function packageTestBuild({ target, number, commit, builtAt }) {
  if (!TARGETS.includes(target) || !target.startsWith(`${process.platform}-`)) throw new Error('해당 운영체제에서 빌드를 실행하십시오.');
  const actualCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  if (commit !== actualCommit) throw new Error('작업 폴더의 커밋과 빌드할 커밋이 다릅니다.');
  const packageInputs = ['src', 'electron', 'build', 'scripts', 'package.json', 'package-lock.json', 'vite.config.*', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt'];
  const changed = (await run('git', ['status', '--porcelain', '--untracked-files=all', '--', ...packageInputs], { cwd: root })).stdout.trim();
  if (changed) throw new Error('패키지 소스에 커밋하지 않은 변경이 있습니다. 통합 커밋 후 테스트 패키지를 생성하십시오.');
  const output = path.join(root, 'release', `test-${target}`);
  const packageRoot = path.join(output, 'packaged');
  await fs.mkdir(path.join(root, 'release'), { recursive: true });
  const lock = path.join(root, 'release/.test-build.lock');
  const handle = await fs.open(lock, 'wx');
  try {
    return await withBuildInfo({ channel: 'test', number, commit, builtAt }, async build => {
      await fs.rm(output, { recursive: true, force: true }); await fs.mkdir(output, { recursive: true });
      // Run the same build steps directly; npm's CLI is not a local dependency.
      for (const args of [[path.join(root, 'scripts/licenses.mjs')], [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'], [path.join(root, 'scripts/copy-locales.mjs')]]) {
        await run(process.execPath, args, { cwd: root, timeout: 180000, maxBuffer: 8 * 1024 ** 2 });
      }
      const arch = target.split('-')[1], platformArgs = target.startsWith('darwin') ? ['--mac', 'dmg'] : ['--win', 'nsis'];
      await run(process.execPath, [require.resolve('electron-builder/cli.js'), ...platformArgs, `--${arch}`, `--config.directories.output=${packageRoot}`, '--publish', 'never'], { cwd: root, timeout: 900000, maxBuffer: 8 * 1024 ** 2, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
      const files = [], checks = ['packaged-build-info', 'package-structure'];
      const copy = async (from, name) => { const to = path.join(output, name); await fs.copyFile(from, to); files.push(to); return to; };
      const names = namesFor(build);
      let publisher = null;
      if (target.startsWith('darwin')) {
        const bundle = path.join(packageRoot, arch === 'arm64' ? 'mac-arm64' : 'mac', 'ReviewOps.app');
        await inspectMac(bundle, build, arch);
        const dmg = await copy(path.join(packageRoot, `ReviewOps-${build.version}-${arch}.dmg`), names.find(name => name.endsWith(`-${arch}.dmg`)));
        await run('/usr/bin/hdiutil', ['verify', dmg], { timeout: 120000 });
        const zip = path.join(output, names.find(name => name.endsWith(`-${arch}.zip`)));
        await run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', bundle, zip], { timeout: 180000 });
        await validateArchive(zip); files.push(zip);
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-test-package-'));
        try { await run('/usr/bin/ditto', ['-x', '-k', zip, temporary], { timeout: 180000 }); await inspectMac(path.join(temporary, 'ReviewOps.app'), build, arch); }
        finally { await fs.rm(temporary, { recursive: true, force: true }); }
        checks.push('codesign', 'dmg-verify', 'zip-extraction');
      } else {
        const installer = path.join(packageRoot, `ReviewOps-${build.version}-windows-x64.exe`);
        packagedBuildInfo(path.join(packageRoot, 'win-unpacked/resources/app.asar'), build);
        publisher = await windowsPublisher(installer);
        // Reuse the existing native install/startup/persistence/uninstall checks.
        await run(process.execPath, [path.join(root, 'scripts/windows-release-smoke.mjs'), installer], { cwd: root, timeout: 600000, maxBuffer: 8 * 1024 ** 2, env: { ...process.env, REVIEWOPS_VERIFY_PACKAGE_ROOT: packageRoot } });
        const report = JSON.parse(await fs.readFile(path.join(root, 'test-results/windows-release.json'), 'utf8'));
        if (report.ok !== true || report.sha256 !== await fileHash(installer)) throw new Error('Windows 설치 검사가 완료되지 않았습니다.');
        await copy(installer, names.find(name => name.endsWith('.exe')));
        checks.push('publisher-status', 'installed-application');
      }
      const record = { schema: 1, target, ok: true, build, checks, ...(publisher ? { publisher } : {}), files: [] };
      for (const file of files) record.files.push({ name: path.basename(file), size: (await fs.stat(file)).size, sha256: await fileHash(file) });
      await fs.writeFile(path.join(output, `verification-${target}.json`), jsonBytes(record));
      await fs.writeFile(path.join(output, 'build-info.json'), jsonBytes(build));
      return { output, ...record };
    });
  } finally { await handle.close(); await fs.rm(lock, { force: true }); }
}
export async function main(args = process.argv.slice(2)) {
  if (args.shift() !== 'package') throw new Error('test-build 명령은 package를 사용하십시오.');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--target': 'target', '--number': 'number', '--commit': 'commit', '--built-at': 'builtAt' }[args[i]];
    if (!key || !args[i + 1]) throw new Error('테스트 패키지 명령의 옵션을 확인하십시오.');
    options[key] = args[i + 1];
  }
  return packageTestBuild(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
