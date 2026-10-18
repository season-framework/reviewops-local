'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binaryFor = service => service.agentBinary?.trim() || 'codex';

// Catalogs belong to the host and executable, not a review or working folder.
// Project-specific model choices remain on the project connection.
function createModelTargets({hostState = {}, services = [], localBinary = 'codex', localRoot = os.homedir(), localProfile = ''} = {}) {
  const targets = new Map(), serviceIds = new Map();
  const add = (id, label, config, binary, signature) => {
    const accountScope=hash(config.kind==='local'?['local',localRoot,localProfile]:['ssh',config.host,config.port,config.username]);
    if (!targets.has(id)) targets.set(id, {id,label,signature:hash(signature),accountScope,config,settings:{binary,workPath:config.kind==='local'?localRoot:'/',model:'',reasoningEffort:'',instructions:''}});
    return id;
  };
  const local = {kind:'local',rootPath:localRoot};
  add('local','이 컴퓨터',local,localBinary,['local',localBinary,localRoot,localProfile]);
  const registered = new Map();
  for (const host of hostState.hosts || []) {
    if (host.connectable===false || typeof host.alias!=='string' || !host.alias || /^-|[\s*?!\x00-\x1f\x7f]/.test(host.alias)) continue;
    const config={kind:'ssh',hostAlias:host.alias,sshConfigPath:hostState.configPath,host:host.hostName||host.alias,port:Number(host.port)||22,username:host.user||'',authType:'agent',rootPath:'/'};
    const signature=[hostState.configPath,hostState.connectionRevision,host.alias,host.optionsText,host.hostName,host.port,host.user,host.identityFile,host.proxyJump];
    const id='host:'+host.id;
    add(id,host.alias,config,'codex',[...signature,'codex']);
    registered.set(host.alias,{id,config,signature});
  }
  for (const service of services) {
    const binary=binaryFor(service);let id;
    if (service.kind==='local') {
      id=binary===localBinary?'local':add('local:'+hash(binary).slice(0,20),'이 컴퓨터 · '+binary,local,binary,['local',binary,localRoot,localProfile]);
    } else if (service.kind==='ssh' && registered.has(service.hostAlias)) {
      const host=registered.get(service.hostAlias);
      id=binary==='codex'?host.id:add(host.id+':'+hash(binary).slice(0,20),service.hostAlias+' · '+binary,host.config,binary,[...host.signature,binary]);
    } else if (service.kind==='ssh') {
      const signature=[service.hostAlias||'',service.sshConfigPath||'',service.host,service.port,service.username,service.authType,service.privateKeyPath,service.hostFingerprint,binary];
      id='connection:'+hash(signature).slice(0,40);
      add(id,service.hostAlias||service.host||service.name,{...service,rootPath:'/'},binary,signature);
    }
    if (id) serviceIds.set(service.id,id);
  }
  return {targets:[...targets.values()],serviceIds};
}
module.exports = {createModelTargets};
