'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

class RpcError extends Error {
  constructor(message, code = 'RPC_ERROR') {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** A bounded stdio transport; application policy remains with each caller. */
class RpcClient extends EventEmitter {
  constructor({ command, args = ['app-server'], env, cwd, timeoutMs = 20_000, spawnImpl = spawn, clientInfo, onServerRequest }) {
    super();
    this.options = { command, args, env, cwd, timeoutMs, spawnImpl, clientInfo, onServerRequest };
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    this.child = null;
    this.startPromise = null;
    this.serverRequests = new Map();
  }

  start() {
    if (this.closed) return Promise.reject(new RpcError('Codex 연결이 종료되었습니다.', 'CLOSED'));
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start();
    return this.startPromise;
  }

  async _start() {
    const { command, args, env, cwd, spawnImpl } = this.options;
    if (!command) throw new RpcError('Codex CLI를 설치한 뒤 다시 시도하십시오.', 'MISSING_COMMAND');
    try {
      this.child = spawnImpl(command, args, {
        env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
    } catch {
      this._finish(new RpcError('Codex를 실행하지 못했습니다.', 'SPAWN_ERROR'));
      throw new RpcError('Codex를 실행하지 못했습니다.', 'SPAWN_ERROR');
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._read(chunk));
    // App-server diagnostics can contain sensitive information. Do not store or forward them.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this._finish(new RpcError('Codex 연결이 끊어졌습니다.', 'DISCONNECTED')));
    this.child.on('error', () => this._finish(new RpcError('Codex를 실행하지 못했습니다.', 'SPAWN_ERROR')));
    this.child.on('close', () => this._finish(new RpcError('Codex 연결이 종료되었습니다.', 'DISCONNECTED')));
    try {
      await this._request('initialize', {
        clientInfo: this.options.clientInfo || { name: 'codex_account_manager', title: 'Codex Account Manager', version: require('../../package.json').version },
        capabilities: { experimentalApi: true },
      });
      this._send({ method: 'initialized' });
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async request(method, params = {}) {
    await this.start();
    return this._request(method, params);
  }

  _request(method, params) {
    if (this.closed) return Promise.reject(new RpcError('Codex 연결이 종료되었습니다.', 'CLOSED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('요청 시간이 초과되었습니다.', 'TIMEOUT'));
        // A fresh process will be used for the next explicit request. Never replay mutations.
        this.close();
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _send(message) {
    if (this.closed || !this.child?.stdin?.writable) {
      throw new RpcError('Codex 연결이 종료되었습니다.', 'DISCONNECTED');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _read(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) {
      this._finish(new RpcError('Codex 응답을 읽지 못했습니다.', 'PROTOCOL_ERROR'));
      this.close();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this._finish(new RpcError('Codex 응답을 읽지 못했습니다.', 'PROTOCOL_ERROR'));
        this.close();
        return;
      }
      if (!message || typeof message !== 'object') continue;
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) {
          this._serverRequest(message);
        } else {
          this.emit('notification', message.method, message.params ?? {});
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        // Only propagate the code, never a server message containing credentials or URLs.
        pending.reject(new RpcError('Codex 요청을 처리하지 못했습니다.', message.error.code ?? 'RPC_ERROR'));
      } else if (Object.hasOwn(message, 'result')) {
        pending.resolve(message.result);
      } else {
        pending.reject(new RpcError('Codex 응답을 읽지 못했습니다.', 'PROTOCOL_ERROR'));
      }
    }
  }

  _serverRequest(message) {
    const unsupported = { error: { code: -32601, message: 'Unsupported server request' } };
    // Account clients omit the private hook and retain default denial.
    if (typeof this.options.onServerRequest !== 'function') {
      try { this._send({ id: message.id, ...unsupported }); } catch {}
      return;
    }
    if (!['number','string'].includes(typeof message.id)) return;
    const key = `${typeof message.id}:${message.id}`, signature = JSON.stringify([message.method, message.params]);
    let record = this.serverRequests.get(key);
    if (record && record.signature !== signature) {
      try { this._send({ id: message.id, error: { code: -32600, message: 'Conflicting server request' } }); } catch {}
      return;
    }
    if (!record) {
      if (this.serverRequests.size >= 1000) {
        for (const [previousKey, previous] of this.serverRequests) if (previous.done) {this.serverRequests.delete(previousKey);break;}
        if (this.serverRequests.size >= 1000) {
          try { this._send({ id: message.id, ...unsupported }); } catch {}
          return;
        }
      }
      const promise = Promise.resolve().then(() => this.options.onServerRequest({
        id: message.id, method: message.method, params: message.params ?? {},
      })).then(result => result === undefined ? unsupported : { result }, () => ({
        error: { code: -32603, message: 'Server request could not be completed' },
      }));
      record = { signature, promise, done: false };this.serverRequests.set(key, record);
      promise.then(() => { record.done = true; });
    }
    record.promise.then(response => {
      try { this._send({ id: message.id, ...response }); } catch { /* Never replay a tool after disconnect. */ }
    });
  }

  _finish(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit('close');
  }

  close() {
    this._finish(new RpcError('Codex 연결이 종료되었습니다.', 'CLOSED'));
    if (this.child && this.child.exitCode == null) {
      this.child.stdin.destroy();
      this.child.kill('SIGTERM');
      const child = this.child;
      const timer = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 1_000);
      timer.unref();
    }
    this.buffer = '';
  }
}

module.exports = { RpcClient, RpcError };
