'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const DEFAULTS = Object.freeze({
  timeoutMs: 20000,
  commandTimeoutMs: 60000,
  maxFileBytes: 20 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  maxDirectoryEntries: 5000,
});

class SshError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SshError';
    this.code = code;
    this.details = details;
    Object.assign(this, details);
  }
}

function fingerprintOf(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function validFingerprint(value) {
  return typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new SshError('SSH_CONFIG_INVALID', 'SSH 연결 설정이 필요합니다.');
  }
  const host = String(config.host || '').trim();
  const username = String(config.username || '').trim();
  const port = config.port === undefined || config.port === '' ? 22 : Number(config.port);
  const rootPath = String(config.rootPath || '/').trim();
  const pinnedFingerprint = config.hostFingerprint || config.pinnedFingerprint || '';
  const hostAlias = String(config.hostAlias || '');
  if (hostAlias && (/^[-!]/.test(hostAlias) || /[\s*?\[\]\x00-\x1f\x7f]/.test(hostAlias) || hostAlias.length > 256)) {
    throw new SshError('SSH_CONFIG_INVALID', '개별 SSH 호스트를 선택하십시오.');
  }
  if ((!host && !hostAlias) || host.length > 253 || /[\s\x00-\x1f]/.test(host)) {
    throw new SshError('SSH_CONFIG_INVALID', 'SSH 서버 주소를 입력해 주십시오.');
  }
  if ((!username && !hostAlias) || username.length > 256 || /[\x00-\x1f]/.test(username)) {
    throw new SshError('SSH_CONFIG_INVALID', 'SSH 사용자 이름을 입력해 주십시오.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshError('SSH_CONFIG_INVALID', 'SSH 포트는 1부터 65535 사이의 정수여야 합니다.');
  }
  if (!path.posix.isAbsolute(rootPath) || rootPath.includes('\0')) {
    throw new SshError('SSH_CONFIG_INVALID', '작업 폴더는 /로 시작하는 서버 경로여야 합니다.');
  }
  if (pinnedFingerprint && !validFingerprint(pinnedFingerprint)) {
    throw new SshError('SSH_CONFIG_INVALID', '저장된 서버 키 지문 형식이 잘못되었습니다.');
  }
  const authType = config.authType || (config.privateKeyPath ? 'key' : config.password ? 'password' : 'agent');
  if (!['agent', 'key', 'password'].includes(authType)) {
    throw new SshError('SSH_CONFIG_INVALID', 'SSH 인증 방법을 선택해 주십시오.');
  }
  if (hostAlias && (typeof config.sshConfigPath !== 'string' || !path.isAbsolute(config.sshConfigPath) || /[\0\r\n]/.test(config.sshConfigPath))) {
    throw new SshError('SSH_CONFIG_INVALID', 'SSH 설정 파일 경로를 지정하십시오.');
  }
  return { ...config, host: host || hostAlias, hostAlias, username, port, rootPath: path.posix.normalize(rootPath), pinnedFingerprint, authType };
}

function callbackPromise(invoke) {
  return new Promise((resolve, reject) => {
    invoke((error, result) => error ? reject(error) : resolve(result));
  });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isWithin(root, target) {
  return root === '/' || target === root || target.startsWith(`${root}/`);
}

function userPath(root, input) {
  if (typeof input !== 'string' || input.includes('\0') || input.length > 4096) {
    throw new SshError('SSH_PATH_INVALID', '서버 파일 경로가 잘못되었습니다.');
  }
  const target = path.posix.isAbsolute(input) ? path.posix.normalize(input) : path.posix.resolve(root, input);
  if (!isWithin(root, target)) {
    throw new SshError('SSH_PATH_OUTSIDE_ROOT', '설정한 작업 폴더 안의 파일만 열 수 있습니다.');
  }
  return target;
}

function relativePath(root, target) {
  return path.posix.relative(root, target) || '.';
}

function previewContent(buffer, name) {
  let mimeType;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png';
  else if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) mimeType = 'image/jpeg';
  else if (/^GIF8[79]a/.test(buffer.subarray(0, 6).toString('ascii'))) mimeType = 'image/gif';
  else if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp';
  else if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') mimeType = 'application/pdf';
  if (mimeType) return { mimeType, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` };
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (content.includes('\0')) throw new Error('binary');
  } catch {
    throw new SshError('SSH_BINARY_FILE', '텍스트, PNG, JPEG, GIF, WebP, PDF 파일을 미리 볼 수 있습니다.');
  }
  const extension = path.posix.extname(name).toLowerCase();
  mimeType = extension === '.json' ? 'application/json' : extension === '.md' ? 'text/markdown' : 'text/plain';
  return { mimeType, content };
}

function asSshError(error) {
  if (error instanceof SshError) return error;
  if (error?.level === 'client-authentication') {
    return new SshError('SSH_AUTH_FAILED', 'SSH 인증에 실패했습니다. 사용자 이름과 인증 설정을 확인해 주십시오.');
  }
  if (error?.code === 'ECONNREFUSED') return new SshError('SSH_CONNECTION_REFUSED', 'SSH 서버가 연결을 거부했습니다.');
  if (error?.code === 'ENOTFOUND') return new SshError('SSH_HOST_NOT_FOUND', 'SSH 서버 주소를 찾을 수 없습니다.');
  if (error?.code === 'ETIMEDOUT' || error?.level === 'client-timeout') {
    return new SshError('SSH_TIMEOUT', 'SSH 연결 시간이 초과되었습니다.');
  }
  if (error?.code === 2) return new SshError('SSH_FILE_NOT_FOUND', '서버에서 파일이나 폴더를 찾을 수 없습니다.');
  if (error?.code === 3) return new SshError('SSH_PERMISSION_DENIED', '서버 파일에 접근할 권한이 없습니다.');
  return new SshError('SSH_ERROR', error?.message || 'SSH 작업을 완료하지 못했습니다.');
}

function createSshService(options = {}) {
  const { Client } = options.ssh2 || require('ssh2');
  const limits = { ...DEFAULTS, ...options };
  const connections = new Set();

  async function connect(configInput, action, timeoutMs = limits.timeoutMs, persistent = false) {
    const config = validateConfig(configInput);
    if (config.hostAlias) {
      const client = await (options.connectConfig || require('./config-ssh.cjs').connectConfig)(config, { ...(options.configSsh || {}), timeoutMs });
      connections.add(client);
      return new Promise((resolve, reject) => {
        let settled = false;
        const started = Date.now();
        const timer = setTimeout(() => finish(new SshError('SSH_TIMEOUT', 'SSH 작업 시간이 초과되었습니다.')), timeoutMs);
        function finish(error, value) {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (error || !persistent) { connections.delete(client); client.end(); client.destroy(); }
          if (error) reject(asSshError(error)); else resolve(value);
        }
        client.on('error', error => finish(error));
        client.on('close', () => { connections.delete(client); if (!settled) finish(new SshError('SSH_CONNECTION_CLOSED', 'SSH 연결이 종료되었습니다.')); });
        Promise.resolve().then(() => action(client, config, { fingerprint: null, durationMs: Date.now() - started })).then(value => finish(null, value), finish);
      });
    }
    const auth = {};
    if (config.authType === 'key') {
      if (typeof config.privateKeyPath !== 'string' || !path.isAbsolute(config.privateKeyPath)) {
        throw new SshError('SSH_KEY_INVALID', '개인 키 파일의 전체 경로를 선택해 주십시오.');
      }
      let key;
      try {
        const info = await fs.stat(config.privateKeyPath);
        if (!info.isFile() || info.size > 64 * 1024) throw new Error('invalid key');
        key = await fs.readFile(config.privateKeyPath);
        if (key.length > 64 * 1024) throw new Error('invalid key');
      } catch {
        throw new SshError('SSH_KEY_INVALID', '개인 키 파일을 읽을 수 없습니다.');
      }
      auth.privateKey = key;
      if (config.passphrase) auth.passphrase = String(config.passphrase);
    } else if (config.authType === 'password') {
      if (typeof config.password !== 'string' || !config.password) {
        throw new SshError('SSH_PASSWORD_REQUIRED', 'SSH 비밀번호를 입력해 주십시오.');
      }
      auth.password = config.password;
    } else {
      const agent = process.env.SSH_AUTH_SOCK;
      if (!agent) throw new SshError('SSH_AGENT_UNAVAILABLE', 'SSH 에이전트를 사용할 수 없습니다. 개인 키 파일이나 비밀번호를 선택해 주십시오.');
      auth.agent = agent;
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      connections.add(client);
      let settled = false;
      let trustError;
      let observedFingerprint;
      const started = Date.now();
      const timer = setTimeout(() => finish(new SshError('SSH_TIMEOUT', 'SSH 작업 시간이 초과되었습니다.')), timeoutMs);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error || !persistent) {
          connections.delete(client);
          client.end();
          client.destroy();
        }
        if (error) reject(trustError || asSshError(error));
        else resolve(value);
      }
      client.on('error', error => finish(error));
      client.on('close', () => {
        connections.delete(client);
        if (!settled) finish(new SshError('SSH_CONNECTION_CLOSED', 'SSH 연결이 종료되었습니다.'));
      });
      client.on('ready', async () => {
        try {
          const result = await action(client, config, { fingerprint: observedFingerprint, durationMs: Date.now() - started });
          finish(null, result);
        } catch (error) {
          finish(error);
        }
      });
      try {
        client.connect({
          host: config.host,
          port: config.port,
          username: config.username,
          ...auth,
          readyTimeout: Math.min(timeoutMs, limits.timeoutMs),
          keepaliveInterval: 5000,
          keepaliveCountMax: 2,
          hostVerifier(key) {
            observedFingerprint = fingerprintOf(key);
            if (!config.pinnedFingerprint) {
              trustError = new SshError('SSH_TRUST_REQUIRED', '처음 연결하는 서버입니다. 서버 키 지문을 확인한 후 연결을 허용해 주십시오.', {
                host: config.host, port: config.port, fingerprint: observedFingerprint,
              });
              return false;
            }
            if (config.pinnedFingerprint !== observedFingerprint) {
              trustError = new SshError('SSH_HOST_KEY_CHANGED', '서버 키가 저장된 키와 다릅니다. 연결을 중단했습니다.', {
                host: config.host, port: config.port, fingerprint: observedFingerprint, expectedFingerprint: config.pinnedFingerprint,
              });
              return false;
            }
            return true;
          },
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  async function withSftp(client, config, input, action) {
    const sftp = await callbackPromise(done => client.sftp(done));
    try {
      const root = await callbackPromise(done => sftp.realpath(config.rootPath, done));
      if (!path.posix.isAbsolute(root) || root.includes('\0')) {
        throw new SshError('SSH_PATH_INVALID', '서버가 잘못된 작업 폴더 경로를 반환했습니다.');
      }
      const normalizedRoot = path.posix.normalize(root);
      let requestedInput = input;
      if (typeof input === 'string' && input.startsWith('~/')) {
        const home = await callbackPromise(done => sftp.realpath('.',done));
        if (!path.posix.isAbsolute(home) || home.includes('\0')) throw new SshError('SSH_PATH_INVALID','서버 사용자 폴더를 찾을 수 없습니다.');
        requestedInput = path.posix.resolve(home,input.slice(2));
      } else if (typeof input === 'string' && path.posix.isAbsolute(input) && isWithin(path.posix.normalize(config.rootPath),path.posix.normalize(input))) {
        requestedInput = path.posix.relative(config.rootPath,input);
      }
      const requested = userPath(normalizedRoot, requestedInput);
      const target = await callbackPromise(done => sftp.realpath(requested, done));
      if (!path.posix.isAbsolute(target) || target.includes('\0') || !isWithin(normalizedRoot, path.posix.normalize(target))) {
        throw new SshError('SSH_PATH_OUTSIDE_ROOT', '설정한 작업 폴더 밖으로 연결되는 파일은 열 수 없습니다.');
      }
      return await action(sftp, normalizedRoot, path.posix.normalize(target));
    } finally {
      sftp.end();
    }
  }

  return {
    async test(config) {
      return connect(config, async (client, normalized, connection) => withSftp(client, normalized, '.', async (sftp, root, target) => {
        const attrs = await callbackPromise(done => sftp.stat(target, done));
        if (!attrs.isDirectory()) throw new SshError('SSH_NOT_DIRECTORY', '작업 폴더 경로가 디렉터리가 아닙니다.');
        return { ok: true, host: normalized.host, ...connection, rootPath: root };
      }));
    },

    async list(config, input = '') {
      return connect(config, (client, normalized) => withSftp(client, normalized, input, async (sftp, root, target) => {
        const attrs = await callbackPromise(done => sftp.stat(target, done));
        if (!attrs.isDirectory()) throw new SshError('SSH_NOT_DIRECTORY', '선택한 경로가 폴더가 아닙니다.');
        const handle = await callbackPromise(done => sftp.opendir(target, done));
        const entries = [];
        try {
          while (true) {
            const batch = await new Promise((resolve, reject) => sftp.readdir(handle, (error, entries) => {
              if (error?.code === 1) resolve(null);
              else if (error) reject(error);
              else resolve(entries);
            }));
            if (!batch) break;
            for (const item of batch) {
              if (item.filename === '.' || item.filename === '..') continue;
              if (typeof item.filename !== 'string' || !item.filename || item.filename.includes('/') || item.filename.includes('\0')) {
                throw new SshError('SSH_PATH_INVALID', '서버가 잘못된 파일 이름을 반환했습니다.');
              }
              entries.push({
                name: item.filename,
                path: relativePath(root, path.posix.join(target, item.filename)),
                type: item.attrs.isDirectory() ? 'directory' : item.attrs.isSymbolicLink() ? 'symlink' : item.attrs.isFile() ? 'file' : 'other',
                size: item.attrs.size,
                modifiedAt: item.attrs.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : null,
              });
              if (entries.length > limits.maxDirectoryEntries) throw new SshError('SSH_DIRECTORY_TOO_LARGE', `한 폴더에서 표시할 수 있는 파일은 ${limits.maxDirectoryEntries}개까지입니다.`);
            }
          }
        } finally {
          await callbackPromise(done => sftp.close(handle, done)).catch(() => {});
        }
        entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
        return { path: relativePath(root, target), rootPath: root, entries };
      }));
    },

    async read(config, input, {raw=false,allowBinary=false}={}) {
      return connect(config, (client, normalized) => withSftp(client, normalized, input, async (sftp, root, target) => {
        const attrs = await callbackPromise(done => sftp.stat(target, done));
        if (!attrs.isFile()) throw new SshError('SSH_NOT_FILE', '일반 파일만 열 수 있습니다.');
        if (attrs.size > limits.maxFileBytes) throw new SshError('SSH_FILE_TOO_LARGE', `파일은 ${limits.maxFileBytes}바이트까지 열 수 있습니다.`);
        const handle = await callbackPromise(done => sftp.open(target, 'r', done));
        const chunks = [];
        let size = 0;
        try {
          while (size <= limits.maxFileBytes) {
            const buffer = Buffer.alloc(Math.min(32768, limits.maxFileBytes + 1 - size));
            const bytesRead = await new Promise((resolve, reject) => sftp.read(handle, buffer, 0, buffer.length, size, (error, bytes) => error ? reject(error) : resolve(bytes)));
            if (!bytesRead) break;
            size += bytesRead;
            if (size > limits.maxFileBytes) throw new SshError('SSH_FILE_TOO_LARGE', `파일은 ${limits.maxFileBytes}바이트까지 열 수 있습니다.`);
            chunks.push(buffer.subarray(0, bytesRead));
          }
        } finally {
          await callbackPromise(done => sftp.close(handle, done)).catch(() => {});
        }
        const buffer = Buffer.concat(chunks);
        const name = path.posix.basename(target);
        let preview;
        if (raw) preview = {bytes:buffer};
        else {
          try {preview = previewContent(buffer,name);}
          catch (error) {
            if (!allowBinary || error.code !== 'SSH_BINARY_FILE') throw error;
            preview = {mimeType:'application/octet-stream'};
          }
        }
        return {path:relativePath(root,target),name,...preview,size};
      }));
    },

    async run(config, command) {
      if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 20000) {
        throw new SshError('SSH_COMMAND_INVALID', '실행할 명령을 입력해 주십시오. 명령은 20000자까지 입력할 수 있습니다.');
      }
      return connect(config, async (client, normalized) => {
        const root = await withSftp(client, normalized, '.', async (sftp, canonicalRoot, target) => {
          const attrs = await callbackPromise(done => sftp.stat(target, done));
          if (!attrs.isDirectory()) throw new SshError('SSH_NOT_DIRECTORY', '작업 폴더 경로가 디렉터리가 아닙니다.');
          return canonicalRoot;
        });
        return new Promise((resolve, reject) => {
          const started = Date.now();
          client.exec(`cd ${shellQuote(root)} || exit $?\n${command}`, { pty: false }, (error, stream) => {
            if (error) { reject(error); return; }
            const stdout = [];
            const stderr = [];
            let outputBytes = 0;
            let settled = false;
            function collect(destination, chunk) {
              if (settled) return;
              outputBytes += chunk.length;
              if (outputBytes > limits.maxOutputBytes) {
                settled = true;
                try { stream.signal('TERM'); stream.close(); } catch {}
                reject(new SshError('SSH_OUTPUT_TOO_LARGE', `명령 출력이 ${limits.maxOutputBytes}바이트를 초과하여 연결을 종료했습니다.`));
                return;
              }
              destination.push(Buffer.from(chunk));
            }
            stream.on('data', chunk => collect(stdout, chunk));
            stream.stderr.on('data', chunk => collect(stderr, chunk));
            stream.on('error', error => {
              if (!settled) { settled = true; reject(error); }
            });
            stream.on('close', (code, signal) => {
              if (settled) return;
              settled = true;
              resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: Number.isInteger(code) ? code : null, signal: signal || null, durationMs: Date.now() - started });
            });
          });
        });
      }, limits.commandTimeoutMs);
    },

    async openShell(config, { cols = 80, rows = 24, onData = () => {}, onClose = () => {} } = {}) {
      function dimensions(nextCols, nextRows) {
        if (!Number.isInteger(nextCols) || nextCols < 2 || nextCols > 500 || !Number.isInteger(nextRows) || nextRows < 1 || nextRows > 300) {
          throw new SshError('TERMINAL_SIZE_INVALID', '터미널 크기가 올바르지 않습니다.');
        }
      }
      dimensions(cols, rows);
      return connect(config, async (client, normalized) => {
        const root = await withSftp(client, normalized, '.', async (sftp, canonicalRoot, target) => {
          const attrs = await callbackPromise(done => sftp.stat(target, done));
          if (!attrs.isDirectory()) throw new SshError('SSH_NOT_DIRECTORY', '작업 폴더 경로가 디렉터리가 아닙니다.');
          return canonicalRoot;
        });
        return new Promise((resolve, reject) => {
          client.shell({ term: 'xterm-256color', cols, rows }, (error, stream) => {
            if (error) { reject(error); return; }
            let closed = false;
            const finish = details => {
              if (closed) return;
              closed = true;
              connections.delete(client);
              try { stream.end(); stream.close(); client.end(); client.destroy(); } catch {}
              onClose(details || {});
            };
            stream.on('data', data => { if (!closed) onData(data); });
            stream.stderr.on('data', data => { if (!closed) onData(data); });
            stream.on('error', error => finish({ error: asSshError(error).message }));
            stream.on('close', (code, signal) => finish({ code: Number.isInteger(code) ? code : null, signal: signal || null }));
            client.on('close', () => finish({}));
            client.on('error', error => finish({ error: asSshError(error).message }));
            stream.write(`cd ${shellQuote(root)} || exit $?\r`);
            resolve({
              write(data) {
                if (closed) throw new SshError('TERMINAL_CLOSED', '터미널 연결이 종료되었습니다.');
                stream.write(data);
              },
              resize(size) {
                dimensions(size.cols, size.rows);
                if (closed) throw new SshError('TERMINAL_CLOSED', '터미널 연결이 종료되었습니다.');
                stream.setWindow(size.rows, size.cols, 0, 0);
              },
              close() { finish({}); },
              get closed() { return closed; },
            });
          });
        });
      }, limits.timeoutMs, true);
    },

    close() {
      const closing = [...connections].map(client => { client.end(); return client.destroy(); });
      connections.clear();
      return Promise.allSettled(closing);
    },
  };
}

module.exports = { createSshService, SshError, fingerprintOf, validateConfig, DEFAULTS };
