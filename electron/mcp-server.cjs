#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const discovery = require('./instance-discovery.cjs');
const { dataTools, validate, schema, ID, string } = require('./automation-api.cjs');

const MAX_INPUT = 512 * 1024, MAX_RESPONSE = 32 * 1024 * 1024, MAX_CONNECTION_INFO = 16 * 1024, MAX_QA_CONNECTION_STATUS = 2048;
const versions = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const binding = { sessionId: ID, projectId: ID, windowId: ID };
const surface = { ...binding, browserId: ID };
const required = ['sessionId','projectId','windowId'];
const point = { x: { type: 'number', minimum: 0, maximum: 20000 }, y: { type: 'number', minimum: 0, maximum: 20000 } };
const qaTools = [
  ['open', 'Open or reuse the project window without bringing it to the front. Each project permits one QA client. Use a unique clientId per agent and keep the returned sessionId/projectId/windowId for subsequent operations.', schema({ projectId: ID, clientId: ID, reviewId: ID }, ['projectId','clientId'])],
  ['state', 'Read the specified ReviewOps window or native browser: visible text, element rectangles in CSS pixels, viewport, and browser IDs with bounds/clip in host CSS pixels. Inputs use CSS coordinates of the selected surface. Use browserId for the embedded website, even when it appears inside a whole-window capture.', schema(surface, required)],
  ['click', 'Click at CSS coordinates in the selected ReviewOps window or native browser. qa_state rectangles already use CSS pixels. For a screenshot point, multiply image x/y by qa_capture imageToCss.scaleX/scaleY. To click the embedded website, set browserId and use that browser surface coordinates.', schema({ ...surface, ...point, button: { type: 'string', enum: ['left','right'] }, clickCount: { type: 'integer', enum: [1,2] } }, [...required,'x','y'])],
  ['type', 'Insert text into the focused field of the specified surface without using the system clipboard or keyboard.', schema({ ...surface, text: string(100000) }, [...required,'text'])],
  ['key', 'Send a key to the specified surface, for example Enter, Tab, Backspace, or A with a Control/Meta modifier.', schema({ ...surface, key: { ...string(80), minLength: 1 }, modifiers: { type: 'array', items: { type: 'string', enum: ['Shift','Control','Alt','Meta'] }, maxItems: 4 } }, [...required,'key'])],
  ['scroll', 'Scroll the specified surface at CSS x/y. Positive deltaY scrolls down. Use browserId to scroll the embedded website. If deriving a point from a screenshot, first multiply its x/y by imageToCss.scaleX/scaleY.', schema({ ...surface, ...point, deltaX: { type: 'number', minimum: -20000, maximum: 20000 }, deltaY: { type: 'number', minimum: -20000, maximum: 20000 } }, [...required,'x','y','deltaY'])],
  ['capture', 'Capture the specified window or native browser as a PNG. Metadata includes image width/height, CSS viewport, and imageToCss.scaleX/scaleY: multiply image coordinates by those scales before clicking. A whole-window capture includes the embedded website; interacting with that website requires its browserId and browser surface coordinates.', schema(surface, required)],
  ['reload', 'Reload the specified ReviewOps window or native browser. Other project windows remain open.', schema(surface, required)],
  ['close', 'Close the specified project window; other projects continue. Release the session instead when the window should remain open.', schema(binding, required)],
  ['release', 'Release this QA session while leaving the project window open.', schema(binding, required)],
  ['navigate', 'Navigate the selected native browser to an HTTP or HTTPS URL. Requires browserId from qa_state.', schema({ ...surface, url: { ...string(8192), minLength: 1 } }, [...required,'browserId','url'])]
].map(([action, description, inputSchema]) => ({ name: 'reviewops_qa_' + action, action: 'automation.qa.' + action, description, inputSchema,
  annotations: { readOnlyHint: ['state','capture'].includes(action), destructiveHint: ['close','reload'].includes(action), openWorldHint: ['navigate','click','key','type'].includes(action) } }));
const connectionTool = { name: 'reviewops_connection_info', action: 'connection.info', description: 'Read the selected running app identity, reported QA capabilities and connection location without opening, focusing or controlling a project. When no explicit or default connection exists, the MCP server may select exactly one privately registered running app. This does not grant QA ownership.', inputSchema: schema({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
const qaConnectionTool = { name: 'reviewops_qa_connection_status', action: 'connection.qa.status', description: 'Read QA availability for the selected app and project, using only this MCP server process\'s recorded binding when unambiguous. This is not chat ownership, reconnection or permission to control a window. It does not acquire, release or renew a QA session.', inputSchema: schema({projectId:ID},['projectId']), annotations: {readOnlyHint:true,destructiveHint:false,openWorldHint:false} };
const tools = [...dataTools, ...qaTools, connectionTool, qaConnectionTool];
const error = (message, code = 'CLIENT_ERROR') => Object.assign(new Error(message), { code });
function connectionInfoResult(value, selection, projectId) {
  const invalid = () => { throw error('Running app connection information is unavailable or invalid.', 'INVALID_CONNECTION_INFO'); };
  const text = max => ({ type: 'string', minLength: 1, maxLength: max });
  const actions = ['open','state','click','type','key','scroll','capture','navigate','reload','close','release'];
  const keys = ['sessionId','projectId','windowId'];
  try {
    validate(schema({ schema: { type: 'integer', enum: [1] }, instanceId: { ...text(36), pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
      app: schema({ version: text(128), displayVersion: text(256), isPackaged: { type: 'boolean' }, platform: text(32), arch: text(32),
        build: schema({ channel: { type: 'string', enum: ['test','stable'] }, version: text(128), buildNumber: {}, developmentNumber: {}, commit: {}, builtAt: {} }, ['channel','version','buildNumber','developmentNumber','commit','builtAt']) }, ['version','displayVersion','isPackaged','platform','arch','build']),
      location: schema({ dataRootSource: { type: 'string', enum: ['environment','platform-default'] }, dataPath: text(4096), appPath: text(4096), executablePath: text(4096), homeRedacted: { type: 'boolean', enum: [true] } }, ['dataRootSource','dataPath','appPath','executablePath','homeRedacted']),
      qa: schema({ protocolVersion: { type: 'integer', enum: [1] }, actions: { type: 'array', maxItems: 11, items: { type: 'string', enum: actions } }, bindingFields: { type: 'array', maxItems: 3, items: { type: 'string', enum: keys } }, optionalBrowserId: { type: 'boolean', enum: [true] }, documentGeneration: { type: 'boolean', enum: [false] } }, ['protocolVersion','actions','bindingFields','optionalBrowserId','documentGeneration']) }, ['schema','instanceId','app','location','qa']), value);
  } catch { invalid(); }
  const scalar = (item, bytes) => { if (typeof item !== 'string' || /[\x00-\x1f\x7f]/.test(item) || Buffer.byteLength(item) > bytes) invalid(); };
  for (const key of ['version','displayVersion','platform','arch']) scalar(value.app[key], key === 'displayVersion' ? 256 : key === 'version' ? 128 : 32);
  const build = value.app.build;
  if (build.version !== value.app.version) invalid();
  if (build.channel === 'test') {
    if (!/^\d+\.\d+\.\d+$/.test(build.version) || !Number.isSafeInteger(build.buildNumber) || build.buildNumber < 1 || build.developmentNumber !== null && (!Number.isSafeInteger(build.developmentNumber) || build.developmentNumber < 1) ||
        !/^[a-f0-9]{40}$/.test(build.commit || '') || typeof build.builtAt !== 'string' || !Number.isFinite(Date.parse(build.builtAt)) || new Date(build.builtAt).toISOString() !== build.builtAt) invalid();
  } else if (['buildNumber','developmentNumber','commit','builtAt'].some(key => build[key] !== null)) invalid();
  const displayVersion = build.channel === 'test' ? build.developmentNumber ? `${build.version}-dev-${build.developmentNumber}` : `${build.version}-test.${build.buildNumber}` : build.version;
  if (value.app.displayVersion !== displayVersion || JSON.stringify(value.qa.actions) !== JSON.stringify(actions) || JSON.stringify(value.qa.bindingFields) !== JSON.stringify(keys)) invalid();
  const serverPaths = value.app.platform === 'win32' ? path.win32 : path.posix;
  for (const key of ['dataPath','appPath','executablePath']) {
    const item = value.location[key];scalar(item, 4096);
    if (item !== '$HOME' && !item.startsWith('$HOME' + serverPaths.sep) && !serverPaths.isAbsolute(item)) invalid();
  }
  if (!selection || !['connection-argument','data-path-argument','environment','platform-default','running-instance-registry'].includes(selection.selection)) invalid();
  scalar(selection.platform, 32);
  const clientPaths = selection.platform === 'win32' ? path.win32 : path.posix;
  scalar(selection.connectionPath, 4096);scalar(selection.homePath, 4096);
  if (!clientPaths.isAbsolute(selection.connectionPath) || !clientPaths.isAbsolute(selection.homePath)) invalid();
  if (projectId !== undefined) { try { validate(ID, projectId); } catch { invalid(); } }
  const relative = clientPaths.relative(selection.homePath, selection.connectionPath);
  const connectionPath = !relative ? '$HOME' : relative !== '..' && !relative.startsWith('..' + clientPaths.sep) && !clientPaths.isAbsolute(relative) ? '$HOME' + clientPaths.sep + relative : selection.connectionPath;
  scalar(connectionPath, 4096);
  // Server JSON has passed the exact nested allowlist; retain no private extras.
  const result = JSON.parse(JSON.stringify(value));
  result.client = { selection: selection.selection, connectionPath, boundProjectId: projectId ?? null };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_CONNECTION_INFO) invalid();
  return result;
}
function qaConnectionStatusResult(value, projectId, bindingSource, boundProjectId) {
  const invalid=()=>{throw error('QA connection status is unavailable or invalid for the selected app.','INVALID_QA_CONNECTION_STATUS');};
  try{validate(schema({schema:{type:'integer',enum:[1]},instanceId:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'},projectId:ID,
    availability:{type:'string',enum:['available','busy','quarantined','unavailable']},bindingState:{type:'string',enum:['not_supplied','attached','expired','target_closed','timed_out','unavailable']}},['schema','instanceId','projectId','availability','bindingState']),value);}catch{invalid();}
  if(value.projectId!==projectId||bindingSource!=='recorded'&&value.bindingState!=='not_supplied')invalid();
  // Ambiguous old records cannot establish an idle connection by omission.
  const result={...value,availability:bindingSource==='ambiguous'&&value.availability==='available'?'unavailable':value.availability,
    client:{bindingSource,scope:'mcp-server',boundProjectId:boundProjectId??null}};
  if(Buffer.byteLength(JSON.stringify(result))>MAX_QA_CONNECTION_STATUS)invalid();
  return result;
}
function defaultDataPath(env = process.env) {
  if (env.REVIEWOPS_DATA_DIR) return path.resolve(env.REVIEWOPS_DATA_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ReviewOps Local');
  if (process.platform === 'win32') { if (!env.APPDATA) throw error('APPDATA is missing. Set --data-path.'); return path.join(env.APPDATA, 'ReviewOps Local'); }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ReviewOps Local');
}
function expectedSocket(dataPath) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\reviewops-tools-${crypto.createHash('sha256').update(path.win32.resolve(dataPath).toLowerCase()).digest('hex').slice(0,32)}`;
  return path.join(dataPath, 'integrations', 'tools.sock');
}
async function invokeSocket(connectionPath, action, payload, { timeoutMs = 40000 } = {}) {
  const connectionFile = path.resolve(connectionPath), dataPath = path.dirname(path.dirname(connectionFile));
  let connection;
  try {
    const stat = await fs.lstat(connectionFile);
    if (!stat.isFile() || stat.size > 8192 || process.platform !== 'win32' && (stat.mode & 0o077 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw error('Invalid connection file permissions.');
    connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
  } catch { throw error('ReviewOps connection is unavailable. Start ReviewOps and check the data folder.', 'APP_UNAVAILABLE'); }
  if (connection.version !== 1 || connection.socketPath !== expectedSocket(dataPath) || !/^[a-f0-9]{64}$/.test(connection.token || '') || !Number.isSafeInteger(connection.pid) || connection.pid <= 0) throw error('Invalid ReviewOps connection record. Check the selected data folder and connection configuration before retrying.', 'INVALID_CONNECTION');
  return invokeConnection(connection, action, payload, { timeoutMs });
}
function invokeConnection(connection, action, payload, { timeoutMs = 40000 } = {}) {
  const request = JSON.stringify({ token: connection.token, action, payload }) + '\n';
  if (Buffer.byteLength(request) > MAX_INPUT) throw error('Request exceeds 512 KiB.', 'REQUEST_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socketPath); let input = '', settled = false;
    const finish = (failure, value) => { if (settled) return; settled = true; socket.destroy(); failure ? reject(failure) : resolve(value); };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(error('ReviewOps response timed out. Check the existing request before retrying.', 'TIMEOUT')));
    socket.on('error', () => finish(error('Cannot connect to ReviewOps. Start the app and check the data folder.', 'APP_UNAVAILABLE')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => {
      input += chunk;
      const limit = action === 'connection.info' ? MAX_CONNECTION_INFO + 128 : action === 'connection.qa.status' ? MAX_QA_CONNECTION_STATUS + 128 : MAX_RESPONSE;
      if (Buffer.byteLength(input) > limit) return finish(error(action === 'connection.info' ? 'ReviewOps connection information exceeds the allowed size.' : action === 'connection.qa.status' ? 'QA connection status exceeds the allowed size.' : 'ReviewOps response exceeds 32 MiB.', 'RESPONSE_TOO_LARGE'));
      const end = input.indexOf('\n'); if (end < 0) return;
      let response; try { response = JSON.parse(input.slice(0,end)); } catch { return finish(error('Invalid ReviewOps response.', 'INVALID_RESPONSE')); }
      if (!response || typeof response.ok !== 'boolean') return finish(error('Invalid ReviewOps response.', 'INVALID_RESPONSE'));
      if (!response.ok) return finish(error(String(response.error?.message || 'ReviewOps request failed.'), response.error?.code || 'REQUEST_FAILED'));
      finish(null, response.data);
    });
    socket.on('close', () => { if (!settled) finish(error('ReviewOps closed the connection before replying. Check the existing request before retrying.', 'CONNECTION_CLOSED')); });
  });
}
// Resolve lazily: initialize and tools/list never inspect a profile or contact an app.
function createConnectionInvoker(config, { selection = { selection: config.selection, connectionPath: config.connectionPath, homePath: os.homedir(), platform: process.platform }, directory = () => discovery.registryDirectory(), timeoutMs = 2000 } = {}) {
  let selected, resolving;
  const changed = () => error('The discovered ReviewOps instance changed. Restart this MCP connection or select an explicit connection.', 'DISCOVERED_INSTANCE_CHANGED');
  async function resolve() {
    if (config.selection !== 'platform-default') return { legacy: true };
    try { await fs.lstat(config.connectionPath); return { legacy: true }; }
    catch (failure) { if (failure.code !== 'ENOENT') return { legacy: true }; }
    const candidate = discovery.findInstance(directory());
    const snapshot = discovery.readPrivateFile(candidate.connectionPath);
    let connection;
    try { connection = JSON.parse(snapshot.bytes.toString('utf8')); } catch { throw error('Invalid discovered ReviewOps connection record.', 'INVALID_CONNECTION'); }
    if (!connection || JSON.stringify(Object.keys(connection).sort()) !== JSON.stringify(['pid','socketPath','token','version']) || connection.version !== 1 || connection.socketPath !== expectedSocket(path.dirname(path.dirname(candidate.connectionPath))) || !/^[a-f0-9]{64}$/.test(connection.token || '') || !Number.isSafeInteger(connection.pid) || connection.pid <= 0) throw error('Invalid discovered ReviewOps connection record.', 'INVALID_CONNECTION');
    const nextSelection = { ...selection, selection: 'running-instance-registry', connectionPath: candidate.connectionPath };
    const info = await invokeConnection(connection, 'connection.info', {}, { timeoutMs });
    connectionInfoResult(info, nextSelection, config.projectId);
    if (info.instanceId !== candidate.instanceId) throw changed();
    // Finish admission without another await between the final observations and selection.
    try { fsSync.lstatSync(config.connectionPath); throw changed(); }
    catch (failure) { if (failure.code !== 'ENOENT') throw changed(); }
    discovery.assertUnchanged(candidate.snapshot); discovery.assertUnchanged(snapshot);
    const current = discovery.findInstance(directory());
    if (current.instanceId !== candidate.instanceId || current.snapshot.identity !== candidate.snapshot.identity || !current.snapshot.bytes.equals(candidate.snapshot.bytes)) throw changed();
    if (selection) Object.assign(selection, nextSelection);
    return { connection: Object.freeze(connection), snapshot, registrySnapshot: candidate.snapshot, instanceId: candidate.instanceId };
  }
  return async (action, payload) => {
    if (!selected) {
      if (!resolving) resolving = resolve().then(value => { selected = value; return value; }).finally(() => { resolving = undefined; });
      await resolving;
    }
    if (selected.legacy) return invokeSocket(config.connectionPath, action, payload);
    discovery.assertUnchanged(selected.registrySnapshot); discovery.assertUnchanged(selected.snapshot);
    const result = await invokeConnection(selected.connection, action, payload);
    if (action === 'connection.info') {
      connectionInfoResult(result, selection, config.projectId);
      if (result.instanceId !== selected.instanceId) throw changed();
    }
    return result;
  };
}
function toolResult(value, protocolVersion) {
  let metadata = value; const content = [];
  if (value?.mimeType === 'image/png' && typeof value.data === 'string') {
    const { data, ...rest } = value; metadata = rest;
    content.push({ type: 'image', data, mimeType: 'image/png' });
  }
  content.unshift({ type: 'text', text: JSON.stringify(metadata ?? null) });
  return { content, ...(versions.indexOf(protocolVersion) <= 1 ? { structuredContent: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : { result: metadata ?? null } } : {}), isError: false };
}
function createMcpServer({ invoke, projectId, connectionSelection, input = process.stdin, output = process.stdout } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('invoke is required');
  if (projectId) validate(ID, projectId, 'projectId');
  let initialized = false, protocolVersion = versions[0], buffer = '', closing = false, closePromise;
  const pending = new Map(), sessions = new Map();
  const write = value => { if (!output.destroyed && output.writable !== false) output.write(JSON.stringify(value) + '\n'); };
  const respondError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  async function handle(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id !== undefined && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) { respondError(null,-32600,'Invalid request'); return; }
    if (message.id === undefined) {
      if (message.method === 'notifications/initialized') return;
      if (message.method === 'notifications/cancelled') { const task = pending.get(message.params?.requestId); if (task) task.cancelled = true; }
      return;
    }
    const id = message.id;
    if (pending.has(id)) { respondError(id,-32600,'Request ID is already in use'); return; }
    const task = { cancelled: false }; pending.set(id,task);
    try {
      const params = message.params || {}; let result;
      if (message.method === 'initialize') {
        if (initialized || typeof params.protocolVersion !== 'string' || !params.clientInfo || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string' || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)) { respondError(id,-32602,'Invalid initialization'); return; }
        initialized = true; protocolVersion = versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0];
        result = { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'reviewops', version: '1.0.0' }, instructions: 'Always pass the exact project ID. Data tools do not move windows. For simultaneous QA, open a separate project session per client and use only the returned session/window IDs. QA inputs address the selected web contents directly and never use the shared system mouse or keyboard. Input coordinates are CSS pixels of the selected surface; convert screenshot points using imageToCss. For embedded websites, specify browserId. QA_TIMEOUT disables the affected window for further QA; close and reopen that window before starting another session.' };
      } else if (message.method === 'ping') result = {};
      else if (message.method === 'server/discover') { respondError(id,-32601,'Method not found'); return; }
      else if (!initialized) { respondError(id,-32002,'Initialize the MCP connection first'); return; }
      else if (message.method === 'tools/list') {
        if (params.cursor !== undefined) { respondError(id,-32602,'Unknown cursor'); return; }
        result = { tools: tools.map(({ action, ...tool }) => tool) };
      } else if (message.method === 'tools/call') {
        const tool = tools.find(item => item.name === params.name);
        if (!tool) { respondError(id,-32602,'Unknown tool'); return; }
        try {
          const args = params.arguments === undefined ? {} : params.arguments;
          validate(tool.inputSchema,args);
          if (projectId && args.projectId !== undefined && args.projectId !== projectId) throw error('This MCP connection is bound to another project.', 'TARGET_MISMATCH');
          let invocation=args,bindingSource;
          if(tool.action==='connection.qa.status'){
            const recorded=[...sessions.values()].filter(value=>value.projectId===args.projectId);
            bindingSource=recorded.length===1?'recorded':recorded.length?'ambiguous':'none';
            invocation={projectId:args.projectId};
            if(recorded.length===1){
              try{validate(schema(binding,required),recorded[0]);}catch{throw error('The recorded QA binding is unavailable.','INVALID_QA_CONNECTION_STATUS');}
              invocation.binding={...recorded[0]};
            }
          }
          let value;
          try { value = await invoke(tool.action,invocation); }
          catch (failure) {
            if (tool.action === 'connection.info' && failure.code === 'UNKNOWN_ACTION') throw error('The connected app does not report connection identity or capabilities. Check the configured app and MCP paths; no project connection was changed.', 'CONNECTION_INFO_UNSUPPORTED');
            if (tool.action === 'connection.qa.status' && failure.code === 'UNKNOWN_ACTION') throw error('The selected app does not provide QA connection status. Inspect reviewops_connection_info; no QA connection was changed.','QA_CONNECTION_STATUS_UNSUPPORTED');
            throw failure;
          }
          if (tool.action === 'connection.info') value = connectionInfoResult(value, connectionSelection, projectId);
          if (tool.action === 'connection.qa.status') value = qaConnectionStatusResult(value,args.projectId,bindingSource,projectId);
          if (tool.action === 'automation.projects.list' && projectId) value = { ...value, projects: value.projects.filter(project => (project.projectId || project.id) === projectId) };
          if (tool.action === 'automation.qa.open' && value?.sessionId) {
            const binding = { sessionId: value.sessionId, projectId: value.projectId, windowId: value.windowId };
            if (closing || task.cancelled && !sessions.has(value.sessionId)) await invoke('automation.qa.release',binding);
            else if (!task.cancelled) sessions.set(value.sessionId,binding);
          }
          if (tool.action === 'automation.qa.release' || tool.action === 'automation.qa.close' && value?.closed === true) sessions.delete(args.sessionId);
          result = toolResult(value,protocolVersion);
        } catch (failure) { result = { content: [{ type: 'text', text: JSON.stringify({ code: typeof failure.code === 'string' ? failure.code : 'REQUEST_FAILED', message: String(failure.message || 'Request failed.').slice(0,2000) }) }], isError: true }; }
      } else { respondError(id,-32601,'Method not found'); return; }
      if (!task.cancelled && !closing) write({ jsonrpc: '2.0', id, result });
    } catch { respondError(id,-32603,'Internal error'); }
    finally { pending.delete(id); }
  }
  const onData = chunk => {
    if (closing) return;
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0,end); buffer = buffer.slice(end+1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_INPUT) { respondError(null,-32600,'Request exceeds 512 KiB'); continue; }
      let message; try { message = JSON.parse(line); } catch { respondError(null,-32700,'Parse error'); continue; }
      if (pending.size >= 64) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) respondError(null,-32600,'Invalid request');
        else if (typeof message.id === 'string' || Number.isSafeInteger(message.id)) respondError(message.id,-32000,'Too many pending requests');
        continue;
      }
      void handle(message);
    }
    if (Buffer.byteLength(buffer) > MAX_INPUT) { buffer = ''; respondError(null,-32600,'Request exceeds 512 KiB'); void close(); }
  };
  function close() {
    if (closePromise) return closePromise;
    closing = true; input.off('data',onData); input.pause();
    // A disconnected client relinquishes its QA windows; active work is retained.
    closePromise = Promise.allSettled([...sessions.values()].map(binding => Promise.race([Promise.resolve().then(() => invoke('automation.qa.release',binding)), new Promise(resolve => { const timer = setTimeout(resolve,1000); timer.unref?.(); })]))).then(() => { sessions.clear(); });
    return closePromise;
  }
  input.setEncoding('utf8'); input.on('data',onData); input.once('end',() => { void close(); });
  return { close, handle };
}
function options(args, env = process.env) {
  let connectionPath, dataPath, projectId;
  for (let index=0;index<args.length;index++) {
    const option = args[index], value = args[++index];
    if (!['--connection','--data-path','--project-id'].includes(option) || !value || value.startsWith('--')) throw error('Usage: node reviewops-mcp.cjs [--data-path FOLDER | --connection FILE] [--project-id ID]');
    if (option === '--connection') { if (connectionPath || dataPath) throw error('Specify only one connection location.'); connectionPath = path.resolve(value); }
    if (option === '--data-path') { if (connectionPath || dataPath) throw error('Specify only one connection location.'); dataPath = path.resolve(value); }
    if (option === '--project-id') { if (projectId) throw error('Specify project ID once.'); validate(ID,value,'projectId'); projectId = value; }
  }
  return { connectionPath: connectionPath || path.join(dataPath || defaultDataPath(env),'integrations','tools.json'), projectId,
    selection: connectionPath ? 'connection-argument' : dataPath ? 'data-path-argument' : env.REVIEWOPS_DATA_DIR ? 'environment' : 'platform-default' };
}
function main(args = process.argv.slice(2)) {
  const config = options(args), selection = { selection: config.selection, connectionPath: config.connectionPath, homePath: os.homedir(), platform: process.platform };
  const server = createMcpServer({ invoke: createConnectionInvoker(config, { selection }), projectId: config.projectId, connectionSelection: selection });
  const stop = () => { void server.close().finally(() => process.exit(0)); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  process.stdout.on('error',stop);
  return server;
}
module.exports = { createMcpServer, invokeSocket, createConnectionInvoker, options, toolResult, tools, qaTools, connectionInfoResult, main };
if (require.main === module) { try { main(); } catch (failure) { process.stderr.write(String(failure.message) + '\n'); process.exitCode = 1; } }
