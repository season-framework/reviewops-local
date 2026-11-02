'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { macExecutableArchitectures } = require('./native-architecture.cjs');

const runFile = promisify(execFile);
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_FAILURES = 64;
const MAX_DIAGNOSTICS = 16;

// AbortController targets only the execFile child retained here. Keep ownership
// until close, even if abort rejects the callback before the process exits.
function createVersionExecutor(launch = execFile) {
  const children = new Map();
  const key = (command, args) => JSON.stringify([command, args]);
  const execute = (command, args, options) => new Promise((resolve, reject) => {
    const id = key(command, args);
    const child = launch(command, args, { ...options, timeout: 0 }, (error, stdout) => {
      if (error) reject(error); else resolve({ stdout });
    });
    children.set(id, child);
    child.once('close', () => { if (children.get(id) === child) children.delete(id); });
  });
  execute.isPending = (command, args) => children.has(key(command, args));
  return execute;
}

function probeError(kind) {
  return {
    missing: 'Codex CLI를 찾을 수 없습니다. 설치하거나 실행 파일을 선택해 주십시오.',
    permissions: 'Codex 실행 파일에 실행 권한이 없습니다. 파일 권한을 확인하거나 다른 실행 파일을 선택하십시오.',
    'invalid-version': '선택한 파일은 Codex CLI가 아니거나 버전 응답이 올바르지 않습니다.',
    'owned-timeout': 'Codex 실행 파일의 버전 검사 시간이 초과되었습니다. 다시 검사하거나 다른 실행 파일을 선택하십시오.',
    'abnormal-exit': 'Codex 실행 파일의 버전 검사가 비정상 종료되었습니다. 다시 검사하거나 다른 실행 파일을 선택하십시오.',
    architecture: 'Codex 실행 파일이 Apple Silicon을 지원하지 않습니다. Apple Silicon용 Codex CLI를 설치하거나 선택해 주십시오.',
  }[kind];
}

function platformTarget(platform, arch) {
  const targets = {
    'darwin-arm64': ['codex-darwin-arm64', 'aarch64-apple-darwin'],
    'darwin-x64': ['codex-darwin-x64', 'x86_64-apple-darwin'],
    'linux-arm64': ['codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    'linux-x64': ['codex-linux-x64', 'x86_64-unknown-linux-musl'],
    'win32-arm64': ['codex-win32-arm64', 'aarch64-pc-windows-msvc'],
    'win32-x64': ['codex-win32-x64', 'x86_64-pc-windows-msvc'],
  };
  const value = targets[`${platform}-${arch}`];
  return value && { packageName: value[0], triple: value[1], executable: platform === 'win32' ? 'codex.exe' : 'codex' };
}

function vendorCandidates(packageRoot, target, paths = path) {
  if (!target) return [];
  const tail = ['vendor', target.triple, 'bin', target.executable];
  const candidates = [
    paths.join(packageRoot, 'node_modules', '@openai', target.packageName, ...tail),
    paths.join(packageRoot, '..', target.packageName, ...tail),
    paths.join(packageRoot, ...tail),
    // Older Codex releases used a codex directory instead of bin.
    paths.join(packageRoot, 'node_modules', '@openai', target.packageName, 'vendor', target.triple, 'codex', target.executable),
    paths.join(packageRoot, '..', target.packageName, 'vendor', target.triple, 'codex', target.executable),
    paths.join(packageRoot, 'vendor', target.triple, 'codex', target.executable),
  ];
  try {
    const requireFromPackage = createRequire(paths.join(packageRoot, 'package.json'));
    const packageJson = requireFromPackage.resolve(`@openai/${target.packageName}/package.json`);
    candidates.unshift(paths.join(paths.dirname(packageJson), ...tail));
  } catch { /* Optional npm dependency may be installed in a different known layout. */ }
  return candidates;
}

function macAppCandidates({ home, target }) {
  const candidates = [];
  for (const directory of ['/Applications', path.join(home, 'Applications')]) {
    for (const app of ['Codex.app', 'ChatGPT.app']) {
      const resources = path.join(directory, app, 'Contents', 'Resources');
      candidates.push(path.join(resources, 'codex'), path.join(resources, 'bin', 'codex'));
      candidates.push(path.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'));
      candidates.push(...vendorCandidates(path.join(resources, 'app.asar.unpacked', 'node_modules', '@openai', 'codex'), target));
    }
  }
  return candidates;
}

function defaultCandidates({ home, env, platform, target, resourcesPath }) {
  const candidates = [];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const executable = target?.executable || (platform === 'win32' ? 'codex.exe' : 'codex');
  if (resourcesPath) candidates.push(paths.join(resourcesPath, executable), paths.join(resourcesPath, 'bin', executable));
  if (platform === 'win32') {
    const roaming = env.APPDATA || paths.join(home, 'AppData', 'Roaming');
    const npmPrefixes = [paths.join(roaming, 'npm'), env.npm_config_prefix, env.NPM_CONFIG_PREFIX].filter(Boolean);
    for (const prefix of npmPrefixes) {
      if (!paths.isAbsolute(prefix)) continue;
      candidates.push(...vendorCandidates(paths.join(prefix, 'node_modules', '@openai', 'codex'), target, paths));
      candidates.push(paths.join(prefix, 'codex.exe'), paths.join(prefix, 'codex.cmd'), paths.join(prefix, 'codex.ps1'));
    }
  }
  const npmRoots = [
    path.join(home, '.local', 'lib', 'node_modules', '@openai', 'codex'),
    '/opt/homebrew/lib/node_modules/@openai/codex',
    '/usr/local/lib/node_modules/@openai/codex',
  ];
  if (platform !== 'win32') for (const root of npmRoots) candidates.push(...vendorCandidates(root, target, paths));
  if (platform === 'darwin') candidates.push(...macAppCandidates({ home, target }));
  if (platform !== 'win32') candidates.push(path.join(home, '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  for (const directory of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
    // Ignore empty and relative PATH entries so the working directory cannot shadow Codex.
    if (!paths.isAbsolute(directory)) continue;
    candidates.push(paths.join(directory, executable));
    if (platform === 'win32') candidates.push(paths.join(directory, 'codex.cmd'), paths.join(directory, 'codex.ps1'));
  }
  return [...new Set(candidates)];
}

async function isNodeWrapper(file) {
  if (/\.(?:[cm]?js|cmd|bat|ps1)$/i.test(file)) return true;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return /^#![^\r\n]*\bnode\b/.test(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

async function resolveNative(candidate, target) {
  const canonical = await fs.realpath(candidate);
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw new Error('실행 파일을 선택해 주십시오.');
  if (!await isNodeWrapper(canonical)) {
    await fs.access(canonical, constants.X_OK);
    return canonical;
  }
  // Do not execute JavaScript with process.execPath: in a packaged app it is Electron.
  const directory = path.dirname(canonical);
  const packageRoots = /\.(?:cmd|bat|ps1)$/i.test(canonical)
    ? [path.join(directory, 'node_modules', '@openai', 'codex'), path.join(directory, '..', '@openai', 'codex')]
    : [path.dirname(directory)];
  for (const binary of packageRoots.flatMap((root) => vendorCandidates(root, target))) {
    try {
      const native = await fs.realpath(binary);
      if (!(await fs.stat(native)).isFile() || await isNodeWrapper(native)) continue;
      await fs.access(native, constants.X_OK);
      return native;
    } catch { /* Try the next bounded vendor layout. */ }
  }
  throw Object.assign(new Error('Codex 실행 파일이 없습니다. Codex CLI를 다시 설치해 주십시오.'), { code: 'CODEX_NATIVE_MISSING' });
}

/** Dependency injection keeps discovery tests independent of the user's installations. */
function createRuntimeFinder(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const execute = options.execute || createVersionExecutor(options.execFile);
  const inspectArchitectures = options.inspectArchitectures || macExecutableArchitectures;
  const now = options.clock?.now || (() => performance.now());
  const schedule = options.clock?.setTimeout || setTimeout;
  const unschedule = options.clock?.clearTimeout || clearTimeout;
  const timeoutMs = Math.min(5000, Math.max(1, options.timeout || 5000));
  const failures = new Map(), records = [];
  const canonicalHome = fs.realpath(home).catch(() => home);
  let omitted = 0;
  const omit = () => { omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1); };
  const diagnostics = () => {
    const snapshot = { records: records.map(row => ({ ...row })), omitted };
    while (snapshot.records.length && Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 16 * 1024) {
      snapshot.records.shift(); snapshot.omitted++;
    }
    return snapshot;
  };
  const add = row => { if (records.length === MAX_DIAGNOSTICS) { records.shift(); omit(); } records.push(row); };
  const finish = (value, errorKind = null) => ({ ...value, errorKind, diagnostics: diagnostics() });
  const fail = (kind, message = probeError(kind)) => finish(unavailable(message), kind);
  const detectAppleSilicon = options.detectAppleSilicon || (async () => {
    try {
      const { stdout } = await runFile('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { timeout: 2000, maxBuffer: 1024, shell: false });
      return String(stdout).trim() === '1';
    } catch { return false; }
  });
  let hostArch;
  return async function findRuntime(customPath = '', { rediscoverMissingAppPath = false, bypassCooldown = false } = {}) {
    const custom = typeof customPath === 'string' ? customPath.trim() : '';
    if (customPath && !custom) return fail('invalid-version', 'Codex 실행 파일 경로가 올바르지 않습니다.');
    const expanded = custom.startsWith('~/') ? path.join(home, custom.slice(2)) : custom;
    if (custom && !path.isAbsolute(expanded)) return fail('invalid-version', 'Codex 실행 파일의 전체 경로를 입력해 주십시오.');
    const realHome = await canonicalHome;
    const safePath = value => {
      if (!value) return null;
      let result = String(value).replace(/[\x00-\x1f\x7f]/g, '');
      for (const prefix of [...new Set([home, realHome])].sort((a, b) => b.length - a.length)) {
        if (result === prefix || result.startsWith(prefix + path.sep)) { result = '$HOME' + result.slice(prefix.length); break; }
      }
      return result.slice(0, 1024);
    };
    const record = (kind, file, started, extra = {}) => ({
      kind, path: safePath(file),
      version: typeof extra.version === 'string' ? extra.version.slice(0, 128) : null,
      architecture: ['arm64', 'x64', 'arm64,x64', 'x64,arm64'].includes(extra.architecture) ? extra.architecture : null,
      code: Number.isSafeInteger(extra.code) ? extra.code : null,
      signal: /^SIG[A-Z0-9]{1,16}$/.test(extra.signal || '') ? extra.signal : null,
      elapsedMs: Math.min(300_000, Math.max(0, Math.round(now() - started))),
    });
    hostArch ||= platform === 'darwin' && arch === 'x64'
      ? Promise.resolve().then(detectAppleSilicon).then((nativeArm64) => nativeArm64 ? 'arm64' : arch)
      : Promise.resolve(arch);
    const nativeArch = await hostArch, target = platformTarget(platform, nativeArch);
    const candidates = custom ? [expanded] : options.candidates || defaultCandidates({
      home, env, platform, target, resourcesPath: options.resourcesPath || process.resourcesPath,
    });
    const visited = new Set();
    let lastError, lastKind = 'missing';
    for (const candidate of candidates) {
      const started = now();
      let command, fingerprint, architecture = null, exitCode = null, phase = 'resolve', ownedTimeout = false;
      try {
        command = await resolveNative(candidate, target);
        if (visited.has(command)) continue;
        visited.add(command);
        const stat = await fs.stat(command);
        fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':');
        const cached = failures.get(command);
        if (cached && cached.fingerprint !== fingerprint) failures.delete(command);
        if (!custom && !bypassCooldown && cached?.fingerprint === fingerprint && cached.until > now()) {
          lastKind = cached.row.kind;
          continue;
        }
        if (platform === 'darwin') {
          let architectures = [];
          try { architectures = await inspectArchitectures(command); }
          catch (error) {
            // Intel metadata is best effort. Apple Silicon keeps its existing
            // native-only validation and filesystem error distinctions.
            if (nativeArch === 'arm64') throw error;
          }
          architecture = architectures.length ? architectures.join(',') : null;
          if (nativeArch === 'arm64' && !architectures.includes('arm64')) {
            throw Object.assign(new Error('Incompatible architecture'), { code: 'CODEX_ARCHITECTURE' });
          }
        }
        const forceArm64 = platform === 'darwin' && nativeArch === 'arm64' && arch === 'x64';
        const launchCommand = forceArm64 ? '/usr/bin/arch' : command;
        const launchArgs = forceArm64 ? ['-arm64', command] : [];
        const args = [...launchArgs, '--version'];
        phase = 'execute';
        if (execute.isPending?.(launchCommand, args)) {
          lastKind = 'owned-timeout';
          continue;
        }
        const controller = new AbortController();
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = schedule(() => {
            ownedTimeout = true;
            controller.abort();
            reject(Object.assign(new Error('Owned version-probe deadline'), { code: 'CODEX_PROBE_TIMEOUT' }));
          }, timeoutMs);
        });
        let stdout;
        try {
          ({ stdout } = await Promise.race([Promise.resolve().then(() => execute(launchCommand, args, {
            timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true, shell: false, env, signal: controller.signal,
          })), deadline]));
        } finally { unschedule(timer); }
        exitCode = 0;
        const version = /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/m.exec(String(stdout).trim())?.[1];
        if (!version) throw Object.assign(new Error('Invalid version response'), { code: 'CODEX_INVALID_VERSION' });
        failures.delete(command);
        add(record('available', command, started, { version, architecture, code: 0 }));
        return finish({ available: true, path: command, version, command: launchCommand, args: launchArgs });
      } catch (error) {
        lastError = error;
        const kind = ownedTimeout ? 'owned-timeout'
          : ['EACCES', 'EPERM'].includes(error.code) ? 'permissions'
            : error.code === 'CODEX_ARCHITECTURE' ? 'architecture'
              : error.code === 'CODEX_INVALID_VERSION' ? 'invalid-version'
                : phase === 'resolve' && ['ENOENT', 'ENOTDIR', 'CODEX_NATIVE_MISSING'].includes(error.code) ? 'missing'
                  : 'abnormal-exit';
        // Missing potential auto-discovery paths are counted without filling
        // the recent executable-probe history or exposing a full path inventory.
        if (kind === 'missing' && !custom) { omit(); continue; }
        lastKind = kind;
        const row = record(kind, command || candidate, started, { architecture, code: exitCode ?? error.code, signal: error.signal });
        add(row);
        if (command && fingerprint) {
          failures.delete(command);
          failures.set(command, { fingerprint, until: now() + FAILURE_COOLDOWN_MS, row });
          if (failures.size > MAX_FAILURES) failures.delete(failures.keys().next().value);
        }
      }
    }
    if (custom && rediscoverMissingAppPath && platform === 'darwin'
      && ['ENOENT', 'ENOTDIR'].includes(lastError?.code)
      && macAppCandidates({ home, target }).includes(path.normalize(expanded))) {
      try { await fs.stat(expanded); }
      catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return findRuntime('', { bypassCooldown });
      }
    }
    if (lastKind === 'missing' && !custom) add(record('missing', null, now()));
    return fail(lastKind);
  };
}

function unavailable(error) {
  return { available: false, path: null, version: null, command: null, args: [], error };
}

module.exports = { findRuntime: createRuntimeFinder(), createRuntimeFinder, platformTarget, defaultCandidates };
