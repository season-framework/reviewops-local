'use strict';

// Keep OpenSSH's Host/Include/ProxyJump configuration for project connections.
// The callback interface matches the small part of ssh2 used by ReviewOps.
const { EventEmitter } = require('node:events');
const { Duplex, PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const { buildSshArgs, secureProxyCommand, runProcess, terminateProcessGroup, assertAlias, shellQuote, SSH_OPTIONS } = require('./codex/host-ssh.cjs');
const { sshExecutable } = require('./codex/local-commands.cjs');
const { connectSftp, FLAGS, CHUNK_SIZE } = require('./codex/sftp-client.cjs');

function configError(message) { const error = new Error(message); error.code = 'SSH_CONFIG_INVALID'; return error; }
function canceledSnapshot() { const error = new Error('SSH 연결 준비가 취소되었습니다.'); error.name = 'AbortError'; return error; }
function includeWords(value) {
  const words = []; let word = '', quote = '', escaped = false, started = false;
  for (const character of value) {
    if (escaped) { word += character; escaped = false; started = true; continue; }
    if (character === '\\') { escaped = true; started = true; continue; }
    if (quote) { if (character === quote) quote = ''; else word += character; started = true; continue; }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (character === '#') break;
    if (/\s/.test(character)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += character; started = true; }
  }
  if (escaped || quote) throw configError('SSH Include 경로의 따옴표를 확인하십시오.');
  if (started) words.push(word);
  if (!words.length || words.length > 256) throw configError('SSH Include 경로를 확인하십시오.');
  return words;
}
function configQuote(value) { return JSON.stringify(String(value)); }
function sameConfigStat(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

async function createConfigSnapshot(sourcePath, options = {}) {
  const home = options.home || os.userInfo().homedir, environment = options.env || process.env;
  const check = () => { if (options.signal?.aborted) throw canceledSnapshot(); };
  const base = options.tempRoot || os.tmpdir();
  const directory = await fs.mkdtemp(path.join(base, 'reviewops-ssh-config-'));
  await fs.chmod(directory, 0o700);
  const sourceStats = new Map(); let fileCount = 0, totalBytes = 0, includeNumber = 0;
  const cleanup = () => { syncFs.rmSync(directory, { recursive: true, force: true }); };
  const expand = value => {
    let result = value.replace(/\$\{([^}]+)\}/g, (_all, name) => {
      if (typeof environment[name] !== 'string') throw configError('SSH Include에 사용한 환경 변수를 찾을 수 없습니다.');
      return environment[name];
    });
    result = result.replace(/%%|%[duiLl]/g, token => token === '%%' ? '%%' : ({ '%d': home, '%u': os.userInfo().username, '%i': String(os.userInfo().uid), '%l': os.hostname(), '%L': os.hostname().split('.')[0] })[token]);
    if (result === '~' || result.startsWith('~/')) result = path.join(home, result.slice(2));
    else if (result.startsWith('~')) {
      const end = result.indexOf('/'), user = result.slice(1, end < 0 ? undefined : end);
      if (user !== os.userInfo().username) throw configError('SSH Include의 다른 사용자 홈 경로는 전체 경로로 입력하십시오.');
      result = path.join(home, end < 0 ? '' : result.slice(end + 1));
    }
    return path.isAbsolute(result) ? result : path.resolve(home, '.ssh', result);
  };
  const copy = async (source, destination, ancestors = []) => {
    check();
    if (ancestors.length >= 16 || ++fileCount > 512) throw configError('SSH Include의 파일 수 또는 연결 단계가 너무 많습니다.');
    const canonical = await fs.realpath(source);
    if (/^(?:auth\.json|credentials\.json|known_hosts[0-9]*|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?)$/i.test(path.basename(canonical))) throw configError('SSH Include에는 인증 파일이나 서버 키 목록을 사용할 수 없습니다.');
    if (ancestors.includes(canonical)) throw configError('SSH Include가 같은 파일을 반복해서 참조합니다.');
    const handle = await fs.open(canonical, 'r'); let contents, before;
    try {
      before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > 1024n * 1024n) throw configError('SSH 설정 파일은 1 MB 이하의 일반 파일이어야 합니다.');
      const bytes = await handle.readFile(); totalBytes += bytes.length;
      if (bytes.length > 1024 * 1024 || totalBytes > 8 * 1024 * 1024) throw configError('SSH 설정 파일의 전체 크기가 너무 큽니다.');
      contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|SSH PRIVATE KEY FILE FORMAT|PuTTY-User-Key-File-/m.test(contents)) throw configError('SSH 개인 키 파일은 연결 설정 사본에 포함할 수 없습니다.');
      await options.afterRead?.(canonical);
      const after = await handle.stat({ bigint: true }), current = await fs.stat(source, { bigint: true });
      if (!sameConfigStat(before, after) || !sameConfigStat(after, current) || await fs.realpath(source) !== canonical) throw configError('SSH 설정이 변경되었습니다. 다시 연결하십시오.');
    } finally { await handle.close(); }
    sourceStats.set(source, { canonical, stat: before });
    const lines = contents.match(/[^\n]*\n|[^\n]+$/g) || [], result = [];
    for (const line of lines) {
      check();
      const match = /^(\s*)Include(?:\s*=\s*|\s+)(.*?)(\r?\n)?$/i.exec(line);
      if (!match) { result.push(line); continue; }
      const destinations = [];
      for (const word of includeWords(match[2])) {
        const pattern = expand(word), parts = pattern.split(path.sep);
        const magic = component => /[*?\[]/.test(component) || /%(?!%)/.test(component.replace(/%%/g, ''));
        let first = parts.findIndex(magic); if (first < 0) first = parts.length - 1;
        const anchor = parts.slice(0, first).join(path.sep).replace(/%%/g, '%') || path.parse(pattern).root;
        const relativePattern = parts.slice(first).join(path.sep), namespace = path.join(directory, 'include-' + includeNumber++);
        const globPattern = pattern.replace(/%%|%[A-Za-z]/g, token => token === '%%' ? '%' : '*');
        const matches = [];
        for await (const file of fs.glob(globPattern)) { matches.push(file); if (matches.length > 512) throw configError('SSH Include의 파일 수가 너무 많습니다.'); }
        matches.sort();
        for (const file of matches) await copy(file, path.join(namespace, path.relative(anchor, file)), [...ancestors, canonical]);
        destinations.push(configQuote(path.join(namespace, relativePattern)));
      }
      result.push(`${match[1]}Include ${destinations.join(' ')}${match[3] || ''}`);
    }
    check(); await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); check();
    await fs.writeFile(destination, result.join(''), { mode: 0o600, flag: 'wx' });
    await fs.chmod(destination, 0o600);
  };
  try {
    const configPath = path.join(directory, 'config');
    await copy(sourcePath, configPath);
    for (const [source, { canonical, stat }] of sourceStats) {
      check();
      if (await fs.realpath(source) !== canonical || !sameConfigStat(stat, await fs.stat(source, { bigint: true }))) throw configError('SSH 설정이 변경되었습니다. 다시 연결하십시오.');
    }
    check();
    return { directory, configPath, fileCount, sourcePaths: [...sourceStats.keys()], cleanup };
  } catch (error) { cleanup(); throw error; }
}

function connectionError(stderr) {
  const value = String(stderr || '');
  const error = new Error(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(value)
    ? 'SSH 서버 키를 확인하지 못했습니다. 호스트관리의 SSH 접속에서 서버 키를 확인하십시오.'
    : /Permission denied|Authentication failed|Too many authentication failures|passphrase/i.test(value)
      ? 'SSH 인증에 실패했습니다. 호스트관리에서 SSH 키 등록과 접속 설정을 확인하십시오.'
      : 'SSH 연결을 시작하지 못했습니다. 호스트관리에서 접속 설정을 확인하십시오.');
  error.code = /host key|IDENTIFICATION/i.test(value) ? 'SSH_HOST_KEY_ERROR' : /Permission denied|Authentication failed|passphrase/i.test(value) ? 'SSH_AUTH_FAILED' : 'SSH_CONNECTION_FAILED';
  return error;
}
function attrs(info) {
  return { ...info, atime: info.accessedAt ? Math.floor(info.accessedAt / 1000) : 0, mtime: info.modifiedAt ? Math.floor(info.modifiedAt / 1000) : 0,
    isDirectory: () => (info.mode & 0o170000) === 0o040000, isFile: () => (info.mode & 0o170000) === 0o100000, isSymbolicLink: () => (info.mode & 0o170000) === 0o120000 };
}
function callback(promise, done) { Promise.resolve(promise).then(result => done(null, result), error => done(error)); }
function openFlags(flags) {
  if (Number.isInteger(flags)) return flags;
  const known = { r: FLAGS.READ, 'r+': FLAGS.READ | FLAGS.WRITE, w: FLAGS.WRITE | FLAGS.CREAT | 16, wx: FLAGS.WRITE | FLAGS.CREAT | FLAGS.EXCL, 'w+': FLAGS.READ | FLAGS.WRITE | FLAGS.CREAT | 16, a: FLAGS.WRITE | FLAGS.CREAT | 4 };
  if (!(flags in known)) throw configError('파일 열기 방식이 올바르지 않습니다.');
  return known[flags];
}
function wrapSftp(raw) {
  const result = {
    realpath: (value, done) => callback(raw.realpath(value), done),
    stat: (value, done) => callback(raw.stat(value).then(attrs), done),
    lstat: (value, done) => callback(raw.lstat(value).then(attrs), done),
    fstat: (handle, done) => callback(raw.fstat(handle).then(attrs), done),
    opendir: (value, done) => callback(raw.opendir(value), done),
    readdir: (handle, done) => callback(raw.readdir(handle).then(rows => rows ? rows.map(row => ({ filename: row.name, longname: row.name, attrs: attrs(row) })) : null), done),
    close: (handle, done) => callback(raw.closeHandle(handle), done),
    open(value, flags, options, done) {
      if (typeof options === 'function') { done = options; options = {}; }
      try { callback(raw.open(value, openFlags(flags), typeof options === 'number' ? options : options?.mode ?? 0o600), done); } catch (error) { done(error); }
    },
    read(handle, buffer, offset, length, position, done) {
      callback(raw.read(handle, position, Math.min(length, CHUNK_SIZE)).then(data => { if (!data) return 0; data.copy(buffer, offset); return data.length; }), (error, count) => done(error, count, buffer));
    },
    write(handle, buffer, offset, length, position, done) {
      callback((async () => { for (let sent = 0; sent < length; sent += CHUNK_SIZE) await raw.write(handle, position + sent, buffer.subarray(offset + sent, offset + Math.min(length, sent + CHUNK_SIZE))); })(), done);
    },
    mkdir(value, options, done) { if (typeof options === 'function') { done = options; options = {}; } callback(raw.mkdir(value, typeof options === 'number' ? options : options?.mode ?? 0o755), done); },
    unlink: (value, done) => callback(raw.remove(value), done),
    rmdir: (value, done) => callback(raw.rmdir(value), done),
    rename: (from, to, done) => callback(raw.rename(from, to), done),
    readlink: (value, done) => callback(raw.readlink(value), done),
    end: () => raw.close(),
  };
  result.readFile = (value, options, done) => {
    if (typeof options === 'function') { done = options; options = {}; }
    callback((async () => {
      const info = await raw.stat(value);
      if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > 20 * 1024 * 1024) throw configError('20 MB 이하의 파일만 읽을 수 있습니다.');
      const handle = await raw.open(value, FLAGS.READ), chunks = []; let length = 0;
      try { for (;;) { const data = await raw.read(handle, length); if (!data?.length) break; length += data.length; if (length > 20 * 1024 * 1024) throw configError('20 MB 이하의 파일만 읽을 수 있습니다.'); chunks.push(data); } }
      finally { await raw.closeHandle(handle); }
      const bytes = Buffer.concat(chunks); const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? bytes.toString(encoding) : bytes;
    })(), done);
  };
  result.writeFile = (value, data, options, done) => {
    if (typeof options === 'function') { done = options; options = {}; }
    callback((async () => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, options?.encoding || 'utf8');
      const handle = await raw.open(value, openFlags(options?.flag || 'w'), options?.mode ?? 0o600);
      try { for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) await raw.write(handle, offset, bytes.subarray(offset, offset + CHUNK_SIZE)); }
      finally { await raw.closeHandle(handle); }
    })(), done);
  };
  return result;
}

class CommandChannel extends Duplex {
  constructor(child, owner, { tty = false, cols = 80, rows = 24 } = {}) {
    super({ autoDestroy: false, emitClose: false });
    this.child = child; this.owner = owner; this.stderr = new PassThrough(); this.stderrText = ''; this.closedOnce = false;
    this.ttyPending = tty; this.ttyBuffer = Buffer.alloc(0); this.dimensions = { cols, rows }; this.ttyPath = '';
    child.stdout.on('data', data => this.output(data));
    child.stderr.on('data', data => { this.stderrText = (this.stderrText + data.toString()).slice(-8192); this.stderr.write(data); });
    child.stdin.on('error', () => {});
    child.once('error', error => this.emit('error', error));
    child.once('close', (code, signal) => {
      if (this.closedOnce) return; this.closedOnce = true;
      owner.channels.delete(this);
      if (this.ttyBuffer.length) this.push(this.ttyBuffer);
      this.push(null); this.stderr.end();
      this.emit('exit', code, signal); this.emit('close', code, signal);
    });
  }
  output(data) {
    if (!this.ttyPending) { this.push(data); return; }
    this.ttyBuffer = Buffer.concat([this.ttyBuffer, data]);
    const text = this.ttyBuffer.toString(), match = /\x1eREVIEWOPS_TTY:([^\x1f\r\n]+)\x1f/.exec(text);
    if (match) {
      this.ttyPath = /^\/dev\/(?:pts\/\d+|tty[\w-]+)$/.test(match[1]) ? match[1] : '';
      this.ttyPending = false;
      const end = Buffer.byteLength(text.slice(0, match.index + match[0].length));
      const before = this.ttyBuffer.subarray(0, Buffer.byteLength(text.slice(0, match.index)));
      const after = this.ttyBuffer.subarray(end); this.ttyBuffer = Buffer.alloc(0);
      if (before.length) this.push(before); if (after.length) this.push(after);
      this.setWindow(this.dimensions.rows, this.dimensions.cols);
    } else if (this.ttyBuffer.length > 8192) { this.ttyPending = false; this.push(this.ttyBuffer); this.ttyBuffer = Buffer.alloc(0); }
  }
  _read() {}
  _write(chunk, encoding, done) { if (!this.child.stdin.writable) { done(new Error('SSH 입력이 종료되었습니다.')); return; } this.child.stdin.write(chunk, encoding, done); }
  _final(done) { this.child.stdin.end(done); }
  _destroy(error, done) { terminateProcessGroup(this.child); done(error); }
  signal(name) { this.child.kill(String(name).startsWith('SIG') ? name : `SIG${name}`); }
  close() { terminateProcessGroup(this.child); }
  setWindow(rows, cols) {
    if (!Number.isInteger(rows) || rows < 1 || rows > 300 || !Number.isInteger(cols) || cols < 2 || cols > 500) return;
    this.dimensions = { rows, cols };
    if (!this.ttyPath || this.closedOnce || this.owner.destroyed) return;
    const tty = shellQuote(this.ttyPath);
    // A separate SSH channel resizes the terminal without injecting text into it.
    this.owner.exec(`stty -F ${tty} rows ${rows} cols ${cols} 2>/dev/null || stty -f ${tty} rows ${rows} cols ${cols}`, { pty: false }, (error, channel) => {
      if (error) return;
      channel.on('error', () => {}); channel.resume(); channel.stderr.resume(); channel.end();
    });
  }
}

class ConfigClient extends EventEmitter {
  constructor(config, options) {
    super(); this.config = config; this.options = options; this.destroyed = false; this.channels = new Set(); this.sftps = new Set(); this.abort = new AbortController();
    this.host = { alias: config.hostAlias }; this.configPath = config.sshConfigPath;
    this.proxy = null; this.snapshotPromise = null; this.snapshot = null; this.cleanupPromise = null;
  }
  async prepareSnapshot() {
    if (this.destroyed) throw canceledSnapshot();
    this.snapshotPromise ||= createConfigSnapshot(this.config.sshConfigPath, { ...(this.options.snapshotOptions || {}), env: this.options.env || process.env, signal: this.abort.signal }).then(snapshot => {
      if (this.destroyed) { snapshot.cleanup(); throw canceledSnapshot(); }
      this.snapshot = snapshot; this.configPath = snapshot.configPath; return snapshot;
    });
    return this.snapshotPromise;
  }
  async proxyCommand() {
    await this.prepareSnapshot();
    this.proxy ||= (this.options.proxyResolver || secureProxyCommand)(this.options.runCommand || runProcess, this.configPath, this.host, { signal: this.abort.signal });
    return this.proxy;
  }
  exec(command, settings, done) {
    if (typeof settings === 'function') { done = settings; settings = {}; }
    let called = false;
    const finish = (error, channel) => { if (called) return; called = true; done(error, channel); };
    (async () => {
      if (typeof command !== 'string' || command.includes('\0') || Buffer.byteLength(command) > 4 * 1024 * 1024) throw configError('SSH 명령이 올바르지 않습니다.');
      const proxyCommand = await this.proxyCommand();
      if (this.destroyed) throw new Error('SSH 연결이 종료되었습니다.');
      const tty = Boolean(settings?.pty), args = buildSshArgs(this.configPath, this.host, command, { proxyCommand });
      if (tty) args.splice(args.indexOf('-T'), 1, '-tt');
      const child = (this.options.spawnImpl || spawn)(sshExecutable(), args, { shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...(this.options.env || process.env), SSH_ASKPASS_REQUIRE: 'never', DISPLAY: '' } });
      const channel = new CommandChannel(child, this, { tty, ...(settings?.pty || {}) });
      this.channels.add(channel); finish(null, channel);
    })().catch(error => finish(error));
  }
  shell(settings, done) {
    const cols = settings?.cols || 80, rows = settings?.rows || 24;
    const command = `printf '\\036REVIEWOPS_TTY:%s\\037' "$(tty)"; stty rows ${rows} cols ${cols}; export TERM=xterm-256color; exec "\${SHELL:-/bin/sh}" -l`;
    this.exec(command, { pty: { cols, rows } }, done);
  }
  sftp(done) {
    (async () => {
      if (this.destroyed) throw new Error('SSH 연결이 종료되었습니다.');
      await this.prepareSnapshot();
      const raw = await (this.options.connectSftp || connectSftp)({ configPath: this.configPath, host: this.host, signal: this.abort.signal, timeoutMs: this.options.timeoutMs || 20000, spawnImpl: this.options.spawnImpl || spawn, runCommand: this.options.runCommand || runProcess, proxyResolver: this.options.proxyResolver || secureProxyCommand });
      if (this.destroyed) { raw.close(); throw new Error('SSH 연결이 종료되었습니다.'); }
      this.sftps.add(raw);
      return wrapSftp(raw);
    })().then(value => done(null, value), error => done(error));
  }
  end() { return this.destroy(); }
  destroy() {
    if (this.destroyed) return this.cleanupPromise;
    this.destroyed = true; this.abort.abort();
    for (const channel of this.channels) channel.close();
    for (const raw of this.sftps) raw.close();
    this.sftps.clear();
    this.snapshot?.cleanup();
    this.cleanupPromise = (this.snapshotPromise || Promise.resolve()).then(snapshot => snapshot?.cleanup(), () => {});
    this.emit('close'); return this.cleanupPromise;
  }
}

async function connectConfig(config, options = {}) {
  assertAlias(config?.hostAlias);
  if (typeof config.sshConfigPath !== 'string' || !path.isAbsolute(config.sshConfigPath) || /[\0\r\n]/.test(config.sshConfigPath)) throw configError('SSH 설정 파일 경로를 지정하십시오.');
  if (!options.skipConfigCheck) await fs.access(config.sshConfigPath);
  return new ConfigClient(config, options);
}

module.exports = { createConfigSnapshot, includeWords, connectConfig, ConfigClient, wrapSftp, CommandChannel, connectionError };
