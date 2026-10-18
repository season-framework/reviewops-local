'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
async function invoke(action,payload={}) {
  const result=await ipcRenderer.invoke('reviewops:invoke',action,payload);
  if(!result.ok){const error=new Error(result.error.message);Object.assign(error,result.error);throw error;}
  return result.data;
}
contextBridge.exposeInMainWorld('reviewops', Object.freeze({
  request: (action, payload = {}) => ipcRenderer.invoke('reviewops:invoke', action, payload),
  invoke,
  onUpdateState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('reviewops:update-state', listener);
    return () => ipcRenderer.removeListener('reviewops:update-state', listener);
  },
  onModelCacheState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('reviewops:model-cache-state', listener);
    return () => ipcRenderer.removeListener('reviewops:model-cache-state', listener);
  },
  onWindowState: callback => {
    if (typeof callback !== 'function') throw new TypeError('창 상태를 받을 함수를 지정하십시오.');
    const listener = (_event,state) => callback({maximized:!!state.maximized,fullScreen:!!state.fullScreen});
    ipcRenderer.on('reviewops:window-state',listener);
    return () => ipcRenderer.removeListener('reviewops:window-state',listener);
  },
  onIntegrationReview: callback => {
    if (typeof callback !== 'function') throw new TypeError('리뷰를 열 함수를 지정하십시오.');
    const listener = (_event, value) => {
      if (typeof value?.reviewId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.reviewId)) callback({reviewId:value.reviewId,projectId:value.projectId,view:value.view,request:value.request});
    };
    ipcRenderer.on('reviewops:season-review',listener);
    return () => ipcRenderer.removeListener('reviewops:season-review',listener);
  },
  onIntegrationUpdate: callback => {
    if (typeof callback !== 'function') throw new TypeError('작업 상태를 받을 함수를 지정하십시오.');
    const listener = (_event, value) => { if (typeof value?.reviewId === 'string') callback({reviewId:value.reviewId}); };
    ipcRenderer.on('reviewops:season-update',listener);
    return () => ipcRenderer.removeListener('reviewops:season-update',listener);
  },
  stageFiles: files => invoke('attachment.stageFiles',{paths:Array.from(files||[],file=>webUtils.getPathForFile(file)).filter(Boolean)})
}));

// Embedded viewers must never receive account or host-management APIs.
if (process.isMainFrame) {

const invoke = (method) => (...args) => ipcRenderer.invoke(`accounts:${method}`, ...args);
contextBridge.exposeInMainWorld('accountManager', Object.freeze({
  getState: invoke('getState'),
  getAccountDetails: invoke('getAccountDetails'),
  refreshAccountDetails: invoke('refreshAccountDetails'),
  addAccount: invoke('addAccount'),
  renameAccount: invoke('renameAccount'),
  login: invoke('login'),
  cancelLogin: invoke('cancelLogin'),
  refreshAccounts: invoke('refreshAccounts'),
  resetAccounts: (ids, selections = null) => ipcRenderer.invoke('accounts:resetAccounts', ids, selections),
  removeAccount: invoke('removeAccount'),
  openLogin: invoke('openLogin'),
  openUsagePage: invoke('openUsagePage'),
  chooseCodexBinary: invoke('chooseCodexBinary'),
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('accounts:state', listener);
    return () => ipcRenderer.removeListener('accounts:state', listener);
  },
}));

const invokeHost = method => (...args) => ipcRenderer.invoke(`hosts:${method}`, ...args);
contextBridge.exposeInMainWorld('hostManager', Object.freeze({
  getState: invokeHost('getState'),
  reloadHosts: invokeHost('reloadHosts'),
  saveHost: invokeHost('saveHost'),
  deleteHost: invokeHost('deleteHost'),
  deleteHosts: invokeHost('deleteHosts'),
  reorderHosts: invokeHost('reorderHosts'),
  saveGroup: invokeHost('saveGroup'),
  deleteGroup: invokeHost('deleteGroup'),
  setGroupCollapsed: invokeHost('setGroupCollapsed'),
  moveHostToGroup: invokeHost('moveHostToGroup'),
  refreshHosts: invokeHost('refreshHosts'),
  cancelRefresh: invokeHost('cancelRefresh'),
  getHostDetails: invokeHost('getHostDetails'),
  generateKey: invokeHost('generateKey'),
  inspectKeys: invokeHost('inspectKeys'),
  registerKey: invokeHost('registerKey'),
  upgradeCodex: invokeHost('upgradeCodex'),
  upgradeCodexBatch: invokeHost('upgradeCodexBatch'),
  startCodexLogin: invokeHost('startCodexLogin'),
  cancelCodexLogin: invokeHost('cancelCodexLogin'),
  openCodexLogin: invokeHost('openCodexLogin'),
  copyCodexLoginCode: invokeHost('copyCodexLoginCode'),
  openSshTerminal: invokeHost('openSshTerminal'),
  listFiles: invokeHost('listFiles'),
  readTextFile: invokeHost('readTextFile'),
  openFileLink: invokeHost('openFileLink'),
  createDirectory: invokeHost('createDirectory'),
  renameFile: invokeHost('renameFile'),
  moveFiles: invokeHost('moveFiles'),
  deleteFiles: invokeHost('deleteFiles'),
  uploadFiles: invokeHost('uploadFiles'),
  downloadFiles: invokeHost('downloadFiles'),
  getFileTransfers: invokeHost('getFileTransfers'),
  cancelFileTransfer: invokeHost('cancelFileTransfer'),
  onFileTransfers(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, transfers) => callback(transfers);
    ipcRenderer.on('hosts:fileTransfers', listener);
    return () => ipcRenderer.removeListener('hosts:fileTransfers', listener);
  },
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('hosts:state', listener);
    return () => ipcRenderer.removeListener('hosts:state', listener);
  },
}));

}
