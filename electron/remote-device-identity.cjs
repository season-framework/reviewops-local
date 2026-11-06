'use strict';

const path = require('node:path');
const {createPrivateIdentityFiles} = require('./remote-device-identity-files.cjs');
const {createIdentityOwner} = require('./remote-device-identity-internal.cjs');
const {createEncryptedIdentityStorage} = require('./remote-device-identity-storage.cjs');
const {identityRuntimeAllowed} = require('./remote-identity-qualification.cjs');
const {loadMacIdentityStorage} = require('./remote-device-identity-native.cjs');
const owners = new WeakMap();
function fail() {
  throw Object.assign(new Error('The remote identity request was refused.'), {code: 'IDENTITY_UNAVAILABLE'});
}
function unsupportedProvider() {
  const state=()=>Object.freeze({status:'unavailable',backend:'unsupported',identity:null,errorCode:'IDENTITY_UNAVAILABLE'});
  return Object.freeze({state,initialize:async()=>state(),publicCertificate:fail,
    acquireServerTLS:async()=>fail(),sealCredential:async()=>fail(),openCredential:async()=>fail(),closeAndDrain:async()=>{}});
}

function createRemoteDeviceIdentity(options) {
  let descriptors;
  try{
    if(!options||Object.getPrototypeOf(options)!==Object.prototype)fail();
    const names=Reflect.ownKeys(options);
    if(!names.every(name=>typeof name==='string')||names.sort().join(',')!=='app,dataPath')fail();
    descriptors=Object.getOwnPropertyDescriptors(options);
    if(!('value'in descriptors.app)||!('value'in descriptors.dataPath))fail();
  }catch{fail();}
  const {app, dataPath} = options;
  // No dependency injection, test flag, platform override, or alternate loader is
  // accepted here. Controlled fixtures use the separate internal factory.
  if (process.type !== 'browser' || !process.versions.electron) fail();
  const electron = require('electron');
  if (app !== electron.app || !app.isReady() || app.getName() !== 'ReviewOps' ||
      typeof dataPath !== 'string' || !path.isAbsolute(dataPath) ||
      path.resolve(dataPath) !== dataPath || app.getPath('userData') !== dataPath ||
      app.getAppPath() !== path.resolve(__dirname, '..') ||
      app.getPath('exe') !== process.execPath) fail();
  const original = owners.get(app);
  if (original) { if (original.dataPath !== dataPath) fail(); return original.provider; }
  if(!['darwin','win32'].includes(process.platform)){
    const provider=unsupportedProvider();owners.set(app,{dataPath,provider});return provider;
  }
  const appPath = app.getAppPath(), exe = app.getPath('exe');
  const ownerCurrent = () => {
    try {
      return app.isReady() && app.getName() === 'ReviewOps' &&
        app.getAppPath() === appPath && app.getPath('exe') === exe &&
        app.getPath('userData') === dataPath;
    } catch { return false; }
  };
  const allowed = () => ownerCurrent() && identityRuntimeAllowed({
    app, commandLine: app.commandLine, platform: process.platform
  });
  // macOS keeps the existing browser-cookie mock policy. Our own fixed native
  // Keychain backend does not use Chromium's cookie/safeStorage key provider.
  const storage = process.platform === 'darwin'
    ? loadMacIdentityStorage({appPath, packaged: app.isPackaged})
    : createEncryptedIdentityStorage({safeStorage: electron.safeStorage, allowed});
  const provider = createIdentityOwner({
    files: createPrivateIdentityFiles(dataPath), loadNative: () => storage,
    tls: require('./remote-tls.cjs'), ownerCurrent,
    backend: process.platform === 'darwin' ? 'macos-default-file-keychain'
      : process.platform === 'win32' ? 'electron-safe-storage' : 'unsupported'
  });
  owners.set(app, {dataPath, provider});
  return provider;
}

module.exports = {createRemoteDeviceIdentity};
