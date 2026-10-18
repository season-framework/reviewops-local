'use strict';
// Account and host management ported from Codex Account Manager.
// ReviewOps stores account profiles separately and never imports an existing Codex login.
const fs = require('node:fs/promises');
const path = require('node:path');
const { AccountService, validateResetSelections } = require('./account-service.cjs');
const { findRuntime } = require('./runtime.cjs');
const { HostService } = require('./host-service.cjs');
const { HostFileService } = require('./host-files.cjs');
const { createHostFileHandlers } = require('./host-file-handlers.cjs');
const { openSshTerminal } = require('./host-terminal.cjs');

async function createCodexManager(options = {}) {
  const dataPath = options.dataPath;
  if (typeof dataPath !== 'string' || !path.isAbsolute(dataPath)) throw new Error('계정 저장 폴더의 전체 경로를 지정하십시오.');
  const dataDir = path.join(dataPath, 'codex-manager');
  const settingsPath = path.join(dataDir, 'runtime.json');
  const { shell, dialog, clipboard } = options;
  const getWindow = options.getWindow || (() => options.window || null);
  const findRuntimeImpl = options.findRuntime || findRuntime;
  const assertTrusted = event => {
    if (typeof options.trusted !== 'function') throw new Error('허용되지 않은 요청입니다.');
    if (options.trusted(event) === false) throw new Error('허용되지 않은 요청입니다.');
  };
  let service, hostService, fileService, runtime;
  let changingRuntime = false, registered = false, closed = false;
  const channels = [];
  const send = (channel, snapshot) => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, snapshot);
  };
  function state() {
    return { ...service.snapshot(), runtime: { available: runtime.available, path: runtime.path, version: runtime.version, error: runtime.error } };
  }
  function publish() { if (service) send('accounts:state', state()); }
  function publishHosts() {
    if (!hostService) return;
    const snapshot = hostService.snapshot();
    send('hosts:state', snapshot);
    options.onHostState?.(snapshot);
  }
  function publishFileTransfers(transfers) { send('hosts:fileTransfers', transfers); }
function accountId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('계정을 선택하십시오.');
  return id;
}
function ids(value, optional = false) {
  if (optional && value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error('계정을 선택하십시오.');
  return [...new Set(value.map(accountId))];
}
async function openLogin(id) {
  const account = service.snapshot().accounts.find(row => row.id === accountId(id));
  const value = account?.login?.url;
  if (!value) throw new Error('로그인을 먼저 시작하십시오.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password) throw new Error('로그인 주소를 열 수 없습니다.');
  await shell.openExternal(url.href);
}
function remoteLogin(id) {
  const host = hostService.requireHost(id, true);
  const login = host.login;
  if (!login || !['waiting', 'verifying'].includes(login.status)) throw new Error('호스트 로그인을 먼저 시작하십시오.');
  return login;
}
async function openCodexLogin(id) {
  const login = remoteLogin(id);
  let url;
  try { url = new URL(login.url); } catch { throw new Error('로그인 주소를 열 수 없습니다.'); }
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('로그인 주소를 열 수 없습니다.');
  await shell.openExternal(url.href);
}
function copyCodexLoginCode(id) {
  const code = remoteLogin(id).userCode;
  if (typeof code !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(code)) throw new Error('인증 코드를 복사할 수 없습니다.');
  clipboard.writeText(code);
  return true;
}
async function setupService(command) {
  service = new AccountService({ ...(options.accountOptions || {}), dataDir, command: command.command || '', args: [...(command.args || []), 'app-server'], onChange: publish });
  await service.init();
}
function registerHandlers(ipcMain = options.ipcMain) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('IPC 연결을 지정하십시오.');
    if (registered) throw new Error('계정 및 호스트 관리가 이미 연결되어 있습니다.');
    const register = (channel, handler) => { ipcMain.handle(channel, handler); channels.push([ipcMain, channel]); };
    registered = true;
  const methods = {
    getState: async () => state(),
    getAccountDetails: async id => service.getAccountDetails(accountId(id)),
    refreshAccountDetails: async id => service.refreshAccountDetails(accountId(id)),
    addAccount: async label => { await service.addAccount(label); return state(); },
    renameAccount: async (id, label) => { await service.renameAccount(accountId(id), label); return state(); },
    login: async (id, method) => {
      if (!['chatgpt', 'chatgptDeviceCode', undefined].includes(method)) throw new Error('로그인 방식을 선택하십시오.');
      await service.login(accountId(id), method || 'chatgpt');
      if (service.snapshot().accounts.find(row => row.id === id)?.login?.url) await openLogin(id);
      return state();
    },
    cancelLogin: async id => { await service.cancelLogin(accountId(id)); return state(); },
    refreshAccounts: async selected => { await service.refreshAccounts(ids(selected, true)); return state(); },
    resetAccounts: async (selected, selections = null) => {
      const selectedIds = ids(selected);
      if (service.snapshot().accounts.some(account=>selectedIds.includes(account.id)&&account.requiresLogin)) throw new Error('다시 로그인한 뒤 초기화권을 사용하십시오.');
      const credits = validateResetSelections(selectedIds, selections, service.snapshot().accounts, { requireSelection: true });
      await service.resetAccounts(selectedIds, credits);
      return state();
    },
    removeAccount: async id => { await service.removeAccount(accountId(id)); return state(); },
    openLogin,
    openUsagePage: async () => shell.openExternal('https://chatgpt.com/codex/settings/usage'),
    chooseCodexBinary: async () => {
      const active = service.snapshot();
      if (changingRuntime || active.refresh?.running || active.accounts.some(a => a.status === 'loading' || a.status === 'loggingIn' || a.resetAttempt?.status === 'pending')) throw new Error('진행 중인 작업이 끝난 뒤 변경하십시오.');
      changingRuntime = true;
      try {
        const selection = await dialog.showOpenDialog(getWindow(), { title: 'Codex 실행 파일 선택', properties: ['openFile', 'showHiddenFiles'] });
        if (selection.canceled) return state();
        const found = await findRuntimeImpl(selection.filePaths[0]);
        if (!found.available) throw new Error(found.error || 'Codex 실행 파일을 찾을 수 없습니다.');
        await service.close();
        runtime = found;
        await fs.writeFile(settingsPath, JSON.stringify({ path: found.path }), { mode: 0o600 });
        await setupService(found);
        publish();
        options.onRuntimeChange?.();
        return state();
      } finally { changingRuntime = false; }
    },
  };
  for (const [method, handler] of Object.entries(methods)) {
    register(`accounts:${method}`, async (event, ...args) => {
      assertTrusted(event);
      if (changingRuntime && method !== 'getState' && method !== 'chooseCodexBinary') throw new Error('Codex 실행 파일을 변경하고 있습니다.');
      return handler(...args);
    });
  }
  const hostMethods = {
    ...createHostFileHandlers({ fileService, hostService, dialog, shell, getWindow }),
    getState: () => hostService.snapshot(),
    reloadHosts: () => hostService.reloadHosts(),
    saveHost: (draft, revision) => hostService.saveHost(draft, revision),
    deleteHost: (id, revision) => hostService.deleteHost(id, revision),
    deleteHosts: (selected, revision) => hostService.deleteHosts(selected, revision),
    reorderHosts: (selected, revision) => hostService.reorderHosts(selected, revision),
    saveGroup: (draft, revision) => hostService.saveGroup(draft, revision),
    deleteGroup: (id, revision) => hostService.deleteGroup(id, revision),
    setGroupCollapsed: (id, collapsed, revision) => hostService.setGroupCollapsed(id, collapsed, revision),
    moveHostToGroup: (id, groupId, revision, orderedIds) => hostService.moveHostToGroup(id, groupId, revision, orderedIds),
    refreshHosts: selected => hostService.refreshHosts(selected),
    cancelRefresh: () => hostService.cancelRefresh(),
    getHostDetails: id => hostService.getHostDetails(id),
    generateKey: id => hostService.generateKey(id),
    inspectKeys: (id, password) => hostService.inspectKeys(id, password),
    registerKey: (id, password) => hostService.registerKey(id, password),
    upgradeCodex: async id => { await hostService.upgradeCodex(id); return hostService.snapshot(); },
    upgradeCodexBatch: selected => hostService.upgradeCodexBatch(selected),
    startCodexLogin: id => hostService.startCodexLogin(id),
    cancelCodexLogin: id => hostService.cancelCodexLogin(id),
    openCodexLogin,
    copyCodexLoginCode,
    openSshTerminal: async id => {
      const host = hostService.requireHost(id, true);
      const current = await hostService.config.read();
      if (current.revision !== hostService.state.revision) throw new Error('SSH 설정이 변경되었습니다. 목록을 새로고침한 뒤 접속하십시오.');
      return openSshTerminal({ host: { ...host }, configPath: hostService.state.configPath, shell });
    },
  };
  for (const [method, handler] of Object.entries(hostMethods)) {
    register(`hosts:${method}`, async (event, ...args) => {
      assertTrusted(event);
      return handler(...args);
    });
  }
}

  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  if (options.accountImport) await require('./import-accounts.cjs').importAccounts({ ...options.accountImport, targetDir: dataDir });
  let customPath;
  try { customPath = JSON.parse(await fs.readFile(settingsPath, 'utf8')).path; } catch (error) { if (error.code !== 'ENOENT') throw new Error('Codex 실행 설정을 읽지 못했습니다.'); }
  runtime = await findRuntimeImpl(customPath);
  await setupService(runtime);
  const configPath = options.configPath || process.env.REVIEWOPS_CODEX_SSH_CONFIG || process.env.CODEX_MANAGER_SSH_CONFIG || undefined;
  hostService = new HostService({ ...(options.hostOptions || {}), configPath, sshDir: options.sshDir || (configPath ? path.dirname(configPath) : undefined), onChange: publishHosts });
  try {
    await hostService.init();
    fileService = new HostFileService({ ...(options.fileOptions || {}), hostService, onChange: publishFileTransfers });
  } catch (error) { await Promise.allSettled([service.close(), hostService.close()]); throw error; }

  return {
    registerHandlers,
    accountState: state,
    hostState: () => hostService.snapshot(),
    // Resolve OpenSSH Includes, Host defaults and identity substitutions without connecting.
    async resolveHost(idOrAlias) {
      if (closed) throw new Error('호스트 관리가 종료되었습니다.');
      if (typeof idOrAlias !== 'string' || !idOrAlias || idOrAlias.length > 256) throw new Error('호스트를 선택하십시오.');
      const current = await hostService.config.read();
      if (current.revision !== hostService.state.revision) await hostService.reloadHosts();
      const row = hostService.state.hosts.find(host => host.id === idOrAlias || host.alias === idOrAlias);
      const host = hostService.requireHost(row?.id || idOrAlias, true);
      const effective = await hostService.effective(host);
      const key = await hostService.selectedKey(host, undefined, effective);
      return {
        id: host.id, alias: host.alias, hostName: effective.hostName || host.hostName || host.alias,
        user: effective.user || host.user, port: Number(effective.port || host.port || 22),
        identityFile: key.privateExists ? key.privateKeyPath : '', privateKeyPath: key.privateExists ? key.privateKeyPath : '',
        proxyJump: effective.proxyJump || host.proxyJump || '', configPath: hostService.state.configPath,
        host: structuredClone(host), effective, key,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const [ipcMain, channel] of channels) ipcMain.removeHandler(channel);
      await Promise.allSettled([service.close(), fileService.close(), hostService.close()]);
    },
    get accountService() { return service; },
    get hostService() { return hostService; },
    get fileService() { return fileService; },
  };
}
module.exports = { createCodexManager };
