'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCodexManager } = require('../electron/codex/index.cjs');
const { buildSshArgs, secureProxyCommand } = require('../electron/codex/host-ssh.cjs');
const { terminalSshArgs } = require('../electron/codex/host-terminal.cjs');

async function setup(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-cam-'));
  const { savedRuntime, ...configuration } = extra;
  const configPath = path.join(directory, 'config');
  await fs.writeFile(configPath, 'Host fixture\n  HostName 192.0.2.41\n  User fixture-user\n  Port 2222\n  ProxyJump fixture-jump\n');
  if (savedRuntime) {
    await fs.mkdir(path.join(directory, 'reviewops', 'codex-manager'), { recursive: true });
    await fs.writeFile(path.join(directory, 'reviewops', 'codex-manager', 'runtime.json'), JSON.stringify(savedRuntime));
  }
  const handlers = new Map();
  const ipcMain = { handle: (channel, callback) => handlers.set(channel, callback), removeHandler: channel => handlers.delete(channel) };
  const manager = await createCodexManager({
    dataPath: path.join(directory, 'reviewops'), configPath,
    trusted: event => event.allowed === true,
    findRuntime: async () => ({ available: true, path: '/fixture/codex', version: '0.162.1', command: '/fixture/codex', args: [] }),
    hostOptions: { effectiveConfig: async host => ({ hostName: host.hostName, user: host.user, port: host.port, identities: [], proxyJump: host.proxyJump }), keyStore: { status: async () => ({ privateExists: false, publicExists: false, privateKeyPath: '/fixture/missing-key' }) } },
    shell: { openExternal: async () => {} }, dialog: {}, clipboard: {}, ...configuration,
  });
  manager.registerHandlers(ipcMain);
  t.after(async () => { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const invoke = (name, ...args) => handlers.get(name)({ allowed: true }, ...args);
  return { manager, handlers, invoke, directory, configPath };
}

test('startup can recover a saved app selection without changing settings or making manual choices permissive', async t => {
  const calls = [], original = { path: '/fixture/Applications/ChatGPT.app/Contents/Resources/codex' };
  const runtime = { available: true, path: '/fixture/bundled-codex', version: '0.166.0-alpha.5.1', command: '/usr/bin/arch', args: ['-arm64', '/fixture/bundled-codex'] };
  const h = await setup(t, { savedRuntime: original, findRuntime: async (...args) => { calls.push(args); return runtime; }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/fixture/manual-codex'] }) } });
  assert.deepEqual(calls, [[original.path, { rediscoverMissingAppPath: true }]]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.directory, 'reviewops/codex-manager/runtime.json'), 'utf8')), original);
  assert.deepEqual(h.manager.accountState().runtime, { available: true, path: runtime.path, version: runtime.version, error: undefined });
  const internal = h.manager.localRuntime();
  internal.args.push('must-not-change-runtime');
  assert.deepEqual(h.manager.localRuntime().args, runtime.args);
  await h.invoke('accounts:chooseCodexBinary');
  assert.deepEqual(calls[1], ['/fixture/manual-codex']);
});

test('a detected bundled CLI stays available for signed-out accounts and login reuses its launch command', async t => {
  const configurations = [], requests = [];
  class Client extends EventEmitter {
    constructor(config) { super(); configurations.push(config); }
    async start() { return this; }
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'account/login/start') return { loginId: 'fixture-login', authUrl: 'https://auth.openai.com/fixture-login' };
      return {};
    }
    close() { this.closed = true; this.emit('close'); }
  }
  const runtime = { available: true, path: '/fixture/bundled-codex', version: '0.166.0-alpha.5.1', command: '/usr/bin/arch', args: ['-arm64', '/fixture/bundled-codex'] };
  const h = await setup(t, { findRuntime: async () => runtime, accountOptions: { clientFactory: config => new Client(config) } });
  const added = await h.invoke('accounts:addAccount', 'Synthetic signed-out account');
  assert.equal(added.runtime.available, true);
  assert.equal(added.runtime.version, runtime.version);
  assert.equal(added.accounts[0].status, 'signedOut');
  await h.invoke('accounts:login', added.accounts[0].id);
  assert.equal(configurations[0].command, runtime.command);
  assert.deepEqual(configurations[0].args, [...runtime.args, 'app-server']);
  assert.ok(configurations[0].env.CODEX_HOME.startsWith(h.directory + path.sep));
  assert.ok(requests.some(row => row.method === 'account/login/start'));
  const missing = await setup(t, { findRuntime: async () => ({ available: false, path: null, version: null, command: null, args: [], error: 'Codex CLI를 찾을 수 없습니다. 설치하거나 실행 파일을 선택해 주십시오.' }) });
  assert.equal(missing.manager.accountState().runtime.available, false);
  assert.match(missing.manager.accountState().runtime.error, /설치하거나 실행 파일/);
  assert.equal(configurations.length, 1);
});

test('account and host IPC reject untrusted renderer frames and are removed on close', async t => {
  const h = await setup(t);
  const required = ['accounts:getState', 'accounts:getAccountDetails', 'accounts:refreshAccountDetails', 'accounts:addAccount', 'accounts:renameAccount', 'accounts:login', 'accounts:cancelLogin', 'accounts:refreshAccounts', 'accounts:resetAccounts', 'accounts:removeAccount', 'accounts:openLogin', 'accounts:openUsagePage', 'accounts:chooseCodexBinary', 'hosts:getState', 'hosts:reloadHosts', 'hosts:saveHost', 'hosts:deleteHost', 'hosts:deleteHosts', 'hosts:reorderHosts', 'hosts:saveGroup', 'hosts:deleteGroup', 'hosts:setGroupCollapsed', 'hosts:moveHostToGroup', 'hosts:refreshHosts', 'hosts:cancelRefresh', 'hosts:getHostDetails', 'hosts:generateKey', 'hosts:inspectKeys', 'hosts:registerKey', 'hosts:upgradeCodex', 'hosts:upgradeCodexBatch', 'hosts:startCodexLogin', 'hosts:cancelCodexLogin', 'hosts:openCodexLogin', 'hosts:copyCodexLoginCode', 'hosts:openSshTerminal', 'hosts:listFiles', 'hosts:readTextFile', 'hosts:openFileLink', 'hosts:createDirectory', 'hosts:renameFile', 'hosts:moveFiles', 'hosts:deleteFiles', 'hosts:uploadFiles', 'hosts:downloadFiles', 'hosts:getFileTransfers', 'hosts:cancelFileTransfer'];
  assert.deepEqual([...h.handlers.keys()].sort(), required.sort());
  for (const handler of h.handlers.values()) await assert.rejects(handler({ allowed: false }), /허용되지 않은 요청/);
  await h.manager.close();
  assert.equal(h.handlers.size, 0);
});

test('accounts use independent private file profiles without importing a Codex login', async t => {
  const configs = [];
  class Client extends EventEmitter {
    constructor(config) { super(); this.closed = false; configs.push(config); }
    async request(method) {
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'pro' } };
      return {};
    }
    close() { this.closed = true; this.emit('close'); }
  }
  const h = await setup(t, { accountOptions: { clientFactory: config => new Client(config) } });
  await h.invoke('accounts:addAccount', '첫 번째 계정');
  await h.invoke('accounts:addAccount', '두 번째 계정');
  await h.invoke('accounts:refreshAccounts');
  assert.equal(configs.length, 2);
  assert.notEqual(configs[0].env.CODEX_HOME, configs[1].env.CODEX_HOME);
  for (const config of configs) {
    assert.ok(config.env.CODEX_HOME.startsWith(path.join(h.directory, 'reviewops', 'codex-manager', 'profiles') + path.sep));
    const file = path.join(config.env.CODEX_HOME, 'config.toml');
    assert.equal(await fs.readFile(file, 'utf8'), 'cli_auth_credentials_store = "file"\n');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(config.env.OPENAI_API_KEY, undefined);
  }
});

test('host id and alias resolve the same complete connection without a remote operation', async t => {
  const h = await setup(t);
  const host = h.manager.hostState().hosts[0];
  const byId = await h.manager.resolveHost(host.id), byAlias = await h.manager.resolveHost('fixture');
  assert.deepEqual(byId, byAlias);
  assert.equal(byId.hostName, '192.0.2.41');
  assert.equal(byId.user, 'fixture-user');
  assert.equal(byId.port, 2222);
  assert.equal(byId.proxyJump, 'fixture-jump');
  assert.equal(byId.configPath, h.configPath);
  await assert.rejects(h.manager.resolveHost('-bad'), /호스트를 찾을 수 없습니다/);
});

test('SSH commands and interactive launchers disable macOS Keychain access', () => {
  if (process.platform === 'darwin') assert.ok(buildSshArgs('/fixture/config', { alias: 'fixture' }, 'true').includes('UseKeychain=no'));
  assert.ok(terminalSshArgs('/fixture/config', { alias: 'fixture' }, 'darwin').includes('UseKeychain=no'));
  assert.equal(terminalSshArgs('/fixture/config', { alias: 'fixture' }, 'linux').includes('UseKeychain=no'), false);
});

test('ProxyJump commands retain SSH config and prohibit prompts, forwarding and Keychain', async () => {
  const command = await secureProxyCommand(async (_binary, args) => ({ code: 0, stdout: args.at(-1) === 'fixture' ? 'hostname fixture.invalid\nproxyjump jump\n' : 'hostname jump.invalid\n' }), '/fixture/config', { alias: 'fixture' });
  assert.match(command, /\/fixture\/config/);
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no']) assert.ok(command.includes(option));
  if (process.platform === 'darwin') assert.ok(command.includes('UseKeychain=no'));
});
