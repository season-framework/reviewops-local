import {_electron as electron, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {userInfo} from 'node:os';
import {createHash, randomUUID, randomBytes, generateKeyPairSync} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {inspectMac} from './test-build.mjs';
import {readBoundedJSON, inventory} from './packaged-bundle-guards.mjs';
import {requireNativeHost, selectMainHost, verifyOriginalMainProcess, createPrivatePaths} from './native-adapters.mjs';
import {isolatedModelRuntime} from './model-cache-fixture.mjs';
import {setTestLocale} from './test-locale.mjs';

// This opt-in lane owns one installed app, two genuine external AppServer
// conversations and their MCP children. It changes no existing chat settings.
// It is feature acceptance, never comprehensive release QA or a two-PC test.
assert.deepEqual(process.argv.slice(2), ['--real-codex']);
assert.equal(process.platform, 'darwin', 'Use the matching macOS native candidate.');
const repository = fs.realpathSync(process.cwd()), require = createRequire(import.meta.url);
const {validateBuildInfo} = require('../electron/build-info.cjs');
const {validateArchive} = require('../electron/update-archive.cjs');
const {requireOpsVersion} = require('../electron/ops-protocol.cjs');
const {RpcClient} = require('../electron/codex/rpc-client.cjs');
const {Server, utils} = require('ssh2');
const asar = require('@electron/asar'), target = `${process.platform}-${process.arch}`;
requireNativeHost(target);
const sha = value => createHash('sha256').update(value).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const candidate = process.env.REVIEWOPS_CANDIDATE_PACKAGE_DIR;
assert.ok(candidate && path.isAbsolute(candidate));
const build = validateBuildInfo(readBoundedJSON(path.join(candidate, 'build-info.json'), 65536));
assert.equal(build.commit, process.env.REVIEWOPS_EXPECT_SOURCE_SHA);
const verification = readBoundedJSON(path.join(candidate, `verification-${target}.json`));
assert.equal(verification.ok, true);assert.equal(verification.target, target);assert.deepEqual(validateBuildInfo(verification.build), build);
for (const check of ['codesign', 'zip-extraction', 'native-smoke', 'ops-package-source', 'ops-native-smoke']) assert.ok(verification.checks.includes(check), 'A mandatory native baseline is missing.');
const zipName = `ReviewOps-${build.version}-test.${build.buildNumber}-${process.arch}.zip`;
assert.equal(verification.files.filter(row => row.name === zipName).length, 1);
const descriptor = verification.files.find(row => row.name === zipName), zip = fs.realpathSync(path.join(candidate, zipName));
assert.ok(descriptor && /^[a-f0-9]{64}$/.test(descriptor.sha256) && Number.isSafeInteger(descriptor.size) && descriptor.size > 1024 && descriptor.size <= 512 * 1024 ** 2);
assert.equal(fs.statSync(zip).size, descriptor.size);assert.equal(hashFile(zip), descriptor.sha256);
const binary = process.env.REVIEWOPS_E2E_CODEX_BINARY;
assert.ok(binary && path.isAbsolute(binary), 'Select the authenticated CLI explicitly.');
const cli = fs.realpathSync(binary);fs.accessSync(cli, fs.constants.X_OK);
const cliVersion = requireOpsVersion(execFileSync(cli, ['--version'], {encoding: 'utf8', timeout: 15000, maxBuffer: 4096}).trim());
const account = userInfo(), osHome = fs.realpathSync(account.homedir), homeStat = fs.lstatSync(osHome);
assert.ok(path.isAbsolute(osHome) && osHome !== '/' && homeStat.isDirectory() && homeStat.uid === account.uid && account.uid === process.getuid() && !(homeStat.mode & 0o022));
const authHome = process.env.CODEX_HOME || path.join(osHome, '.codex');
assert.ok(path.isAbsolute(authHome), 'Keep the explicitly selected existing CLI authentication home.');
const paths = createPrivatePaths(repository), owned = paths.root, data = paths.data;
const output = path.join(repository, 'test-results/qa-controller-external', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
const install = path.join(owned, 'installed'), bundle = path.join(install, 'ReviewOps.app'), resources = path.join(bundle, 'Contents/Resources');
const executable = path.join(bundle, 'Contents/MacOS/ReviewOps'), mcpEntry = path.join(resources, 'mcp/reviewops-mcp.cjs');
const work = {A: path.join(owned, 'work-A'), B: path.join(owned, 'work-B')};
for (const directory of [output, install, ...Object.values(work), path.join(data, 'updates')]) fs.mkdirSync(directory, {recursive: true, mode: 0o700});
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const configPath = paths.ssh;
const appEnv = {...process.env, ...isolatedModelRuntime({home: paths.home, dataPath: data}), HOME: osHome, REVIEWOPS_DATA_DIR: data, REVIEWOPS_SSH_CONFIG: configPath, REVIEWOPS_CODEX_SSH_CONFIG: configPath};
const chatEnv = {...process.env, HOME: osHome, CODEX_HOME: authHome};
for (const environment of [appEnv, chatEnv]) for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_ACCESS_TOKEN', 'ANTHROPIC_API_KEY']) delete environment[name];
writeJSON(path.join(data, 'updates/settings.json'), {automatic: false, intervalMinutes: 10});
const nonce = () => randomBytes(6).toString('hex').toUpperCase();
const words = {A: nonce(), B: nonce()}, checks = [], photos = [], modelTurns = [], modelCalls = [], driverCalls = [], launches = [], images = [], sshSessions = [], errors = [], controllers = {}, projects = {}, reviews = {};
const result = {ok: false, scope: 'One installed macOS app and two genuine external Codex AppServer conversations, project-bound MCP and live owned loopback SSH. Driver operations and actual model tool calls are separate. Not Codex desktop-chat UI registration, shared physical MCP, a remote PC, update continuity or comprehensive release QA.',
  build, target, driverCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), cli: {path: cli, version: cliVersion, sha256: hashFile(cli)}, package: {zip, ...descriptor}, owned, data, output, checks, photos, modelTurns, modelCalls, driverCalls, launches, images, sshSessions};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label, timeout = 20000) {let timer;try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Object.assign(new Error(label), {code: 'OWNED_STEP_TIMEOUT'})), timeout);})]);} finally {clearTimeout(timer);}}
async function until(read, accept, label, timeout = 20000) {const end = Date.now() + timeout;while (Date.now() < end) {const value = await read();if (accept(value)) return value;await wait(100);}throw Object.assign(new Error(label), {code: 'OWNED_STEP_TIMEOUT'});}
const pass = value => {checks.push(value);console.log('PASS: ' + value);};
const fixedBinding = value => Object.fromEntries(['appInstanceId', 'controllerId', 'projectId', 'reviewId', 'sessionId', 'windowId', 'generation', 'state'].map(key => [key, value[key]]));
const proof = value => ({appInstanceId: value.appInstanceId, controllerId: value.controllerId, controllerProof: value.controllerProof, projectId: value.projectId});
const ipc = (page, action, payload = {}) => page.evaluate(({action, payload}) => window.reviewops.invoke(action, payload), {action, payload});
let app, main, appClosed, webServer, sshServer, tapServer, admin, draftA, aHeartbeat, failure, phase = 'admission', originalInventory;
const chats = {}, terminalIds = [], sshConnections = new Set(), sshChildren = new Set();
const tapToken = randomBytes(32).toString('base64url'), tapPath = path.join(owned, 'chat-tap.sock'), tapWrapper = path.join(owned, 'mcp-tap.cjs');
const protocolPending = new Map(), physicalMcp = new Map(), lifecycleDirectory = path.join(owned, 'mcp-lifecycle');
fs.mkdirSync(lifecycleDirectory, {mode: 0o700});

function observeMcp(key, message, direction, transportPID) {
  if (direction === 'client' && message.method === 'tools/call') {
    const args = message.params?.arguments;
    assert.equal(message.params?.name, 'reviewops_qa_controller', 'The genuine chat attempted an unapproved MCP tool.');
    assert.equal(args?.projectId, projects[key].id, 'The genuine chat attempted another project.');
    if (args.operation === 'open') assert.equal(args.reviewId, reviews[key].id);
    const transport = physicalMcp.get(transportPID);assert.ok(transport);transport.modelToolCalls++;
    protocolPending.set(transportPID + ':' + message.id, {key, operation: args.operation, args, at: new Date().toISOString()});
  }
  if (direction !== 'server' || !Object.hasOwn(message, 'id')) return;
  const request = protocolPending.get(transportPID + ':' + message.id);if (!request) return;protocolPending.delete(transportPID + ':' + message.id);
  const reply = message.result, text = reply?.content?.find(item => item.type === 'text')?.text;
  let value;try {value = reply.structuredContent ?? JSON.parse(text);} catch {throw new Error('Invalid actual MCP response.');}
  const call = {key, transportPID, operation: request.operation, at: request.at, completedAt: new Date().toISOString(), isError: Boolean(reply.isError), code: reply.isError ? value.code : null};
  if (!reply.isError) {
    assert.equal(value.projectId, projects[key].id);assert.equal(value.reviewId, reviews[key].id);call.binding = fixedBinding(value);
    if (request.operation === 'open') {assert.ok(!controllers[key]);assert.match(value.controllerProof, /^[A-Za-z0-9_-]{43}$/);controllers[key] = value;}
    else controllers[key] = {...controllers[key], ...fixedBinding(value)};
    if (value.observationId) call.observationId = value.observationId;
    for (const item of reply.content || []) if (item.type === 'image') {
      const bytes = Buffer.from(item.data, 'base64');assert.ok(bytes.length <= 4 * 1024 ** 2);assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const filename = `model-${key}-${images.length}.png`;fs.writeFileSync(path.join(output, filename), bytes, {mode: 0o600});const image = {key, filename, sha256: sha(bytes), bytes: bytes.length, at: call.completedAt};images.push(image);call.image = image;
    }
  }
  // This observer saves no raw JSON-RPC, proofs or proof-bearing model text.
  // The external CLI remains responsible for its own private thread context.
  modelCalls.push(call);
}
async function startTap() {
  tapServer = net.createServer(socket => {let pending = '';socket.setEncoding('utf8');socket.on('error', () => {});socket.on('data', chunk => {
    pending += chunk;if (pending.length > 48 * 1024 ** 2) {failure ||= new Error('Owned tap packet exceeded its bound.');socket.end();return;}
    let offset;while ((offset = pending.indexOf('\n')) >= 0) {const line = pending.slice(0, offset);pending = pending.slice(offset + 1);try {
      const packet = JSON.parse(line);assert.equal(packet.token, tapToken);assert.ok(['A', 'B'].includes(packet.key));
      if (packet.kind === 'start') {physicalMcp.set(packet.pid, {key: packet.key, wrapperPID: packet.pid, parentPID: packet.ppid, childPID: packet.childPID, exit: null, wrapperExit: null, shutdownRequests: [], modelToolCalls: 0});}
      else if (packet.kind === 'close') {const record = physicalMcp.get(packet.pid);assert.ok(record);record.exit = {code: packet.code, signal: packet.signal};}
      else if (packet.kind === 'shutdown-request') {const record = physicalMcp.get(packet.pid);assert.ok(record);record.shutdownRequests.push({reason: packet.reason, at: packet.at});}
      else observeMcp(packet.key, packet.message, packet.direction, packet.pid);
    } catch {failure ||= Object.assign(new Error('The actual MCP tap failed its fixed boundary.'), {code: 'MCP_TAP_REFUSED'});}}
  });});
  await new Promise((resolve, reject) => {tapServer.once('error', reject);tapServer.listen(tapPath, resolve);});fs.chmodSync(tapPath, 0o600);
  fs.writeFileSync(tapWrapper, String.raw`'use strict';
const net=require('node:net'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const [key,entry,connection,project,review]=process.argv.slice(2),socket=net.createConnection(process.env.REVIEWOPS_CHAT_TAP);
const token=process.env.REVIEWOPS_CHAT_TAP_TOKEN,journal=path.join(process.env.REVIEWOPS_CHAT_LIFECYCLE,String(process.pid)+'.jsonl');
const child=spawn(process.execPath,[entry,'--connection',connection,'--project-id',project],{env:process.env,detached:true,stdio:['pipe','pipe','pipe']});let closing=false;
const emit=value=>{const packet={key,pid:process.pid,at:new Date().toISOString(),...value};if(value.kind!=='message')fs.appendFileSync(journal,JSON.stringify(packet)+'\n',{mode:0o600});if(!socket.destroyed)socket.write(JSON.stringify({token,...packet})+'\n');};
function stop(reason){emit({kind:'shutdown-request',reason});if(closing)return;closing=true;process.stdin.pause();child.stdin.end();}
emit({kind:'start',ppid:process.ppid,childPID:child.pid});socket.on('error',()=>stop('observer-error'));
process.on('SIGTERM',()=>stop('SIGTERM'));process.on('SIGINT',()=>stop('SIGINT'));process.stdin.on('end',()=>stop('stdin-EOF'));
process.on('exit',code=>fs.appendFileSync(journal,JSON.stringify({key,pid:process.pid,kind:'wrapper-exit',code,at:new Date().toISOString()})+'\n',{mode:0o600}));
function forward(input,output,direction){let pending='';input.on('data',chunk=>{pending+=chunk.toString('utf8');if(pending.length>40*1024*1024){process.exitCode=1;stop('protocol-bound');return;}let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;let message;try{message=JSON.parse(line);}catch{process.exitCode=1;stop('protocol-json');return;}const args=message.params?.arguments;if(direction==='client'&&message.method==='tools/call'&&(message.params?.name!=='reviewops_qa_controller'||args?.projectId!==project||(args.operation==='open'&&args.reviewId!==review))){process.exitCode=1;stop('tool-scope-refused');return;}emit({kind:'message',direction,message});if(!closing||direction==='server')output.write(line+'\n');}});}
forward(process.stdin,child.stdin,'client');forward(child.stdout,process.stdout,'server');child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('error',()=>{process.exitCode=1;emit({kind:'child-error'});socket.end();});child.on('close',(code,signal)=>{emit({kind:'close',childPID:child.pid,code,signal});process.stdin.destroy();socket.end(()=>{process.exitCode=code===0&&signal===null?0:1;});});
`, {mode: 0o700});
}

const pidExists = pid => {try {process.kill(pid, 0);return true;} catch (error) {if (error.code === 'ESRCH') return false;throw error;}};
function sdkClosureSnapshot() {
  const files = fs.readdirSync(lifecycleDirectory);assert.ok(files.length <= 32);
  for (const name of files) {
    assert.match(name, /^[1-9][0-9]*\.jsonl$/);const file = path.join(lifecycleDirectory, name), stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32768);
    const text = fs.readFileSync(file, 'utf8'), complete = text.slice(0, text.lastIndexOf('\n') + 1);
    const events = complete.split('\n').filter(Boolean).map(line => JSON.parse(line));assert.ok(events.length <= 100);
    for (const event of events) {
      assert.ok(Number.isSafeInteger(event.pid) && event.pid > 0);assert.equal(name, event.pid + '.jsonl');assert.ok(['A', 'B'].includes(event.key));
      let record = physicalMcp.get(event.pid);
      if (!record && event.kind === 'start') {record = {key: event.key, wrapperPID: event.pid, parentPID: event.ppid, childPID: event.childPID, exit: null, wrapperExit: null, shutdownRequests: [], modelToolCalls: 0};physicalMcp.set(event.pid, record);}
      if (!record) continue;
      if (event.kind === 'close') record.exit = {code: event.code, signal: event.signal};
      if (event.kind === 'wrapper-exit') record.wrapperExit = {code: event.code, receipt: 'Original wrapper process exit hook'};
      if (event.kind === 'shutdown-request' && !record.shutdownRequests.some(row => row.reason === event.reason && row.at === event.at)) record.shutdownRequests.push({reason: event.reason, at: event.at});
    }
  }
  return [...physicalMcp.values()].map(record => {
    record.role = record.modelToolCalls > 0 ? 'actual-chat-tool-transport' : 'inventory-or-idle-no-tool-call';
    record.wrapperAbsent = !pidExists(record.wrapperPID);record.childAbsent = Number.isSafeInteger(record.childPID) && record.childPID > 0 && !pidExists(record.childPID);
    record.closureProof = record.wrapperAbsent && record.childAbsent ? 'Exact original PID absence' : 'Not confirmed closed';
    record.childExitStatus = record.exit ? 'Observed original child exit receipt; shutdown intent recorded separately' : 'Natural exit status unconfirmed';
    return record;
  });
}

class DriverMcp {
  constructor() {
    this.pending = new Map();this.next = 0;this.buffer = '';
    this.child = spawn(process.execPath, [mcpEntry, '--data-path', data], {env: appEnv, stdio: ['pipe', 'pipe', 'pipe']});
    this.record = {kind: 'driver-controlled-mcp', pid: this.child.pid, exit: null};launches.push(this.record);
    const abort = () => {for (const pending of this.pending.values()) pending.reject(new Error('Owned driver MCP closed.'));this.pending.clear();};
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {this.record.exit = {code, signal};abort();resolve(this.record.exit);}));this.child.stderr.on('data', () => {});
    this.child.on('error', abort);this.child.stdin.on('error', abort);
    this.child.stdout.on('data', chunk => {this.buffer += chunk;if (this.buffer.length > 8 * 1024 ** 2) {abort();return;}let end;while ((end = this.buffer.indexOf('\n')) >= 0) {const line = this.buffer.slice(0, end);this.buffer = this.buffer.slice(end + 1);if (!line.trim()) continue;let value;try {value = JSON.parse(line);} catch {abort();return;}const pending = this.pending.get(value.id);if (pending) {this.pending.delete(value.id);value.error ? pending.reject(new Error('Owned driver MCP protocol refusal.')) : pending.resolve(value.result);}}});
  }
  async request(method, params) {return bounded(new Promise((resolve, reject) => {const id = ++this.next;this.pending.set(id, {resolve, reject});this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');}), 'Owned driver MCP request');}
  async initialize() {await this.request('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'owned-external-cohort-driver', version: '1'}});this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');}
  async call(key, operation, fields = {}, expectedCode = null) {
    const response = await this.request('tools/call', {name: 'reviewops_qa_controller', arguments: {...proof(controllers[key]), operation, ...fields}});
    const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
    driverCalls.push({key, operation, at: new Date().toISOString(), isError: Boolean(response.isError), code: response.isError ? value.code : null});
    if (expectedCode) {assert.equal(response.isError, true);assert.equal(value.code, expectedCode);return value;}
    if (response.isError) throw Object.assign(new Error('An owned driver QA operation was refused.'), {code: value.code});
    const image = response.content.find(item => item.type === 'image');return image ? {...value, data: image.data} : value;
  }
  async close() {this.child.stdin.end();assert.deepEqual(await bounded(this.closed, 'Original driver MCP natural exit'), {code: 0, signal: null});}
}

const gitBytes = name => execFileSync('git', ['show', `${build.commit}:${name}`], {cwd: repository, maxBuffer: 16 * 1024 ** 2});
async function installCandidate() {
  assert.equal(execFileSync('git', ['rev-parse', `${build.commit}^{commit}`], {cwd: repository, encoding: 'utf8'}).trim(), build.commit);
  await validateArchive(zip);execFileSync('/usr/bin/ditto', ['-x', '-k', zip, install], {timeout: 120000});
  assert.deepEqual(fs.readdirSync(install), ['ReviewOps.app']);assert.equal(fs.realpathSync(bundle), bundle);
  const archive = path.join(resources, 'app.asar');asar.uncache(archive);await inspectMac(bundle, build, process.arch);
  const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\/+/, '')).filter(name => /^electron\/.+/.test(name) && name !== 'electron/reviewops-build.json' && !asar.statFile(archive, name).files);
  const expected = execFileSync('git', ['ls-tree', '-rz', '--name-only', build.commit, '--', 'electron'], {cwd: repository, maxBuffer: 2 * 1024 ** 2}).toString().split('\0').filter(Boolean);
  assert.deepEqual(files.slice().sort(), expected.sort(), 'The installed app must exactly match the selected source object.');
  const source = files.map(name => {const bytes = asar.extractFile(archive, name);assert.deepEqual(bytes, gitBytes(name), 'An installed source entry differs from the selected commit.');return {path: name, sha256: sha(bytes)};});
  for (const name of ['qa-controllers.cjs', 'qa-automation.cjs', 'automation-api.cjs', 'mcp-server.cjs']) assert.ok(source.some(row => row.path === 'electron/' + name));
  for (const [name, installed] of [['mcp-server.cjs', 'reviewops-mcp.cjs'], ['automation-api.cjs', 'automation-api.cjs'], ['instance-discovery.cjs', 'instance-discovery.cjs'], ['review-categories.json', 'review-categories.json']]) assert.deepEqual(fs.readFileSync(path.join(resources, 'mcp', installed)), gitBytes('electron/' + name));
  originalInventory = inventory(bundle);result.admission = {source, archiveSHA256: hashFile(archive), inventorySHA256: sha(JSON.stringify(originalInventory)), mcpEntrySHA256: hashFile(mcpEntry)};
}
async function servePages() {
  webServer = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1');const key = route.pathname.split('/').at(-1);
    response.setHeader('Cache-Control', 'no-store');
    if (!['A', 'B'].includes(key)) {response.writeHead(404);response.end();return;}
    if (route.pathname.startsWith('/visual/')) {response.setHeader('Content-Type', 'application/json');response.end(JSON.stringify({word: words[key]}));return;}
    if (route.pathname !== '/' + key) {response.writeHead(404);response.end();return;}
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><title>Owned external chat ${key}</title><style>body{font:24px sans-serif;padding:25px;min-height:2200px;background:#edf6ff}input{display:block;font:inherit;padding:10px;width:75%;margin:15px 0}canvas{background:white;border:2px solid #173c66;position:fixed;right:30px;bottom:20px;width:420px;height:110px;pointer-events:none}</style><h1>External controller ${key}</h1><label>Owned web draft ${key}<input id="draft" autocomplete="off"></label><p>Use this page for input and scrolling. Read the visual code from the canvas image.</p><canvas width="840" height="220"></canvas><script>window.instance=crypto.randomUUID();let last='';async function draw(){const x=await(await fetch('/visual/${key}')).json();if(x.word===last)return;last=x.word;const c=document.querySelector('canvas').getContext('2d');c.fillStyle='white';c.fillRect(0,0,840,220);c.fillStyle='#173c66';c.font='bold 55px monospace';c.fillText(x.word,35,130)}draw();setInterval(()=>draw().catch(()=>{}),500)</script>`);
  });
  await new Promise((resolve, reject) => {webServer.once('error', reject);webServer.listen(0, '127.0.0.1', resolve);});
  return 'http://127.0.0.1:' + webServer.address().port;
}
async function serveSsh() {
  const keyOptions = {modulusLength: 2048, privateKeyEncoding: {type: 'pkcs1', format: 'pem'}, publicKeyEncoding: {type: 'pkcs1', format: 'pem'}};
  const hostKey = generateKeyPairSync('rsa', keyOptions).privateKey, userKey = generateKeyPairSync('rsa', keyOptions).privateKey;
  const publicKey = utils.parseKey(userKey), username = 'owned-controller-stream', alias = 'owned-controller-stream';
  const keyPath = path.join(owned, 'ssh-key'), knownHosts = path.join(owned, 'known-hosts'), stream = path.join(owned, 'ssh-stream.cjs');
  fs.writeFileSync(keyPath, userKey, {mode: 0o600});
  fs.writeFileSync(stream, String.raw`'use strict';
let tick=0,pending='';const timer=setInterval(()=>process.stdout.write('OWNED_TICK '+(++tick)+'\n'),250);
process.stdout.write('OWNED_READY\n');process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.search(/[\r\n]/))>=0){const line=pending.slice(0,end).trim();pending=pending.slice(end+1);if(line==='EXIT'){clearInterval(timer);process.stdin.pause();process.stdout.write('OWNED_BYE\n');process.exitCode=0;return;}if(/^PING_[A-F0-9]+$/.test(line))process.stdout.write('ECHO '+line+'\n');}});process.stdin.on('end',()=>{clearInterval(timer);process.exitCode=0;});
`, {mode: 0o600});
  sshServer = new Server({hostKeys: [hostKey]}, connection => {
    sshConnections.add(connection);connection.on('error', () => {});connection.on('close', () => sshConnections.delete(connection));
    connection.on('authentication', context => {
      const accepted = context.method === 'publickey' && context.username === username && context.key.data.equals(publicKey.getPublicSSH()) && (!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo) === true);
      accepted ? context.accept() : context.reject();
    });
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept();session.on('pty', accept => accept());session.on('window-change', accept => accept?.());
      session.on('sftp', accept => {
        const sftp = accept();
        const exactRoot = async raw => {const canonical = await fs.promises.realpath(raw);assert.equal(canonical, fs.realpathSync(work.A));return canonical;};
        sftp.on('REALPATH', async (id, raw) => {try {const canonical = await exactRoot(raw);sftp.name(id, [{filename: canonical, attrs: {}}]);} catch {sftp.status(id, 3);}});
        const stat = async (id, raw) => {try {const value = await fs.promises.stat(await exactRoot(raw));sftp.attrs(id, {mode: value.mode, uid: value.uid, gid: value.gid, size: value.size, atime: Math.floor(value.atimeMs / 1000), mtime: Math.floor(value.mtimeMs / 1000)});} catch {sftp.status(id, 3);}};
        sftp.on('STAT', stat);sftp.on('LSTAT', stat);sftp.on('OPEN', id => sftp.status(id, 3));
      });
      const streamShell = accept => {
        const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
        // A real owned PTY supplies the actual tty framing expected by the
        // product's OpenSSH adapter; no remote request command is evaluated.
        const command = "printf '\\036REVIEWOPS_TTY:%s\\037' \"$(tty)\"; exec " + quote(process.execPath) + ' ' + quote(stream);
        const channel = accept(), child = spawn('/usr/bin/script', ['-q', '/dev/null', '/bin/sh', '-c', command], {env: {PATH: '/usr/bin:/bin'}, stdio: ['pipe', 'pipe', 'pipe']});
        const record = {channel: sshSessions.length + 1, childPID: child.pid, startedAt: new Date().toISOString(), exit: null};sshSessions.push(record);sshChildren.add(child);
        channel.on('error', () => {});child.stdin.on('error', () => {});child.stderr.on('data', () => {});child.on('error', () => {failure ||= new Error('An owned SSH stream failed.');});
        channel.pipe(child.stdin);child.stdout.pipe(channel, {end: false});channel.on('end', () => child.stdin.end());channel.on('close', () => child.stdin.end());
        child.once('close', (code, signal) => {record.exit = {code, signal};record.closedAt = new Date().toISOString();sshChildren.delete(child);if (!channel.destroyed) {channel.exit(code ?? 1);channel.end();}});
      };
      session.on('shell', streamShell);
      session.on('exec', (accept, reject, request) => {
        const expected = `printf '\\036REVIEWOPS_TTY:%s\\037' "$(tty)"; stty rows 24 cols 80; export TERM=xterm-256color; exec "\${SHELL:-/bin/sh}" -l`;
        if (request.command !== expected) {reject();return;}streamShell(accept);
      });
    }));
  });
  await new Promise((resolve, reject) => {sshServer.once('error', reject);sshServer.listen(0, '127.0.0.1', resolve);});
  fs.writeFileSync(knownHosts, `[127.0.0.1]:${sshServer.address().port} ssh-rsa ${utils.parseKey(hostKey).getPublicSSH().toString('base64')}\n`, {mode: 0o600});
  fs.writeFileSync(configPath, `Host ${alias}\n  HostName 127.0.0.1\n  Port ${sshServer.address().port}\n  User ${username}\n  IdentityFile ${keyPath}\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${knownHosts}\n  GlobalKnownHostsFile /dev/null\n`, {mode: 0o600});
  return alias;
}

class ExternalChat {
  constructor(key) {
    this.key = key;this.alias = 'owned_qa_' + key + '_' + randomBytes(4).toString('hex');this.active = null;this.items = new Map();this.finished = new Map();this.waiters = new Map();
    this.rpc = new RpcClient({command: cli, args: ['--disable', 'apps', '--disable', 'plugins', 'app-server'], env: chatEnv, cwd: work[key], timeoutMs: 45000, clientInfo: {name: 'reviewops_owned_external_' + key, title: 'Owned external QA ' + key, version: '1'},
      onServerRequest: () => {failure ||= Object.assign(new Error('An unapproved AppServer client request was refused.'), {code: 'EXTERNAL_APPROVAL_REFUSED'});throw failure;}});
    this.rpc.on('notification', (method, params) => {try {this.notification(method, params);} catch {failure ||= Object.assign(new Error('A genuine chat event crossed the fixed cohort boundary.'), {code: 'EXTERNAL_EVENT_REFUSED'});}});
  }
  notification(method, params) {
    if (!this.threadId || params.threadId !== this.threadId) return;
    if (method === 'turn/started') this.active = params.turn.id;
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;assert.ok(item && typeof item.type === 'string');
      if (item.type === 'mcpToolCall') {assert.equal(item.server, this.alias);assert.equal(item.tool, 'reviewops_qa_controller');}
      else assert.ok(['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(item.type), 'A genuine chat used an unapproved built-in tool.');
      if (item.type === 'agentMessage' && method === 'item/completed') {assert.ok(Buffer.byteLength(item.text || '') <= 1024 ** 2);this.items.set(item.id, {turnId: params.turnId, text: item.text || ''});}
    }
    if (method === 'error') failure ||= Object.assign(new Error('The original genuine turn reported an error.'), {code: 'EXTERNAL_TURN_ERROR'});
    if (method === 'turn/completed') {const turn = params.turn;this.finished.set(turn.id, turn);if (this.active === turn.id) this.active = null;this.waiters.get(turn.id)?.(turn);}
  }
  async open() {
    this.stage('appserver-initialize');
    const starting = this.rpc.start(), child = this.rpc.child;
    if (child) {
      this.record = {kind: 'genuine-external-appserver', key: this.key, pid: child.pid, exit: null};launches.push(this.record);
      this.closed = new Promise(resolve => child.once('close', (code, signal) => {this.record.exit = {code, signal};resolve(this.record.exit);}));
    }
    await starting;assert.ok(child && this.closed, 'Retain the original spawned AppServer before setup.');
    this.stage('read-thread-configuration');
    const configured = await this.rpc.request('config/read', {includeLayers: false, cwd: work[this.key]});
    const inherited = configured.config?.mcp_servers ?? {};assert.ok(inherited && typeof inherited === 'object' && !Array.isArray(inherited));
    const config = {'features.shell_tool': false, 'features.apps': false, 'features.plugins': false, web_search: 'disabled'};
    for (const name of Object.keys(inherited)) {assert.match(name, /^[A-Za-z0-9_-]+$/, 'An inherited MCP alias cannot be safely overridden.');assert.notEqual(name, this.alias);config[`mcp_servers.${name}.enabled`] = false;}
    config[`mcp_servers.${this.alias}`] = {command: process.execPath, args: [tapWrapper, this.key, mcpEntry, path.join(data, 'integrations/tools.json'), projects[this.key].id, reviews[this.key].id],
      env: {REVIEWOPS_CHAT_TAP: tapPath, REVIEWOPS_CHAT_TAP_TOKEN: tapToken, REVIEWOPS_CHAT_LIFECYCLE: lifecycleDirectory}, enabled: true, required: true, enabled_tools: ['reviewops_qa_controller'], tools: {reviewops_qa_controller: {approval_mode: 'approve'}}, startup_timeout_sec: 30, tool_timeout_sec: 45};
    // Overrides exist only on this thread. The selected CLI must prove their
    // actual effect through its original-thread inventory before any turn.
    this.stage('thread-start');
    const started = await this.rpc.request('thread/start', {cwd: work[this.key], approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, historyMode: 'paginated', config});
    this.threadId = started.thread.id;assert.match(this.threadId, /^[A-Za-z0-9_-]+$/);this.record.threadId = this.threadId;
    this.stage('complete-inventory-isolation');
    const servers = await this.statusSnapshot();
    assert.equal(new Set(servers.map(server => server.name)).size, servers.length);assert.equal(servers.filter(server => server.name === this.alias).length, 1);
    for (const other of servers.filter(server => server.name !== this.alias)) {
      assert.ok(Object.hasOwn(inherited, other.name), 'An unexpected plugin or inherited server remains on the genuine thread.');
      assert.equal(other.runtimeStatus, 'disabled');assert.deepEqual(Object.keys(other.tools || {}), []);assert.deepEqual(other.resources || [], []);assert.deepEqual(other.resourceTemplates || [], []);
    }
    this.checkOwnServer(servers.find(server => server.name === this.alias), false);
    // Full inventory intentionally creates an SDK-owned temporary MCP manager.
    // Subsequent readiness reads address ONLY the original thread's alias.
    const deadline = Date.now() + 30000;let ready = false;
    this.stage('original-server-ready');
    do {
      const current = await this.statusSnapshot(this.alias);assert.equal(current.length, 1);assert.equal(current[0].name, this.alias);
      this.checkOwnServer(current[0], false);
      if (current[0].runtimeStatus === 'connected') {this.checkOwnServer(current[0], true);ready = true;break;}
      await wait(250);
    } while (Date.now() < deadline);
    if (!ready) throw Object.assign(new Error('Original owned MCP startup did not finish.'), {code: 'OWNED_MCP_STARTUP_TIMEOUT'});
    result.threadIsolation ||= [];result.threadIsolation.push({key: this.key, threadId: this.threadId, alias: this.alias, disabledAliases: Object.keys(inherited).sort(), processFeaturesDisabled: ['apps', 'plugins'], toolNames: ['reviewops_qa_controller'], checkedAt: new Date().toISOString()});
    this.stage('ready-before-model');
  }
  stage(name) {
    this.setupStage = name;result.setupProgress ||= [];result.setupProgress.push({key: this.key, stage: name, at: new Date().toISOString()});
  }
  async statusSnapshot(serverName) {
    let cursor, pages = 0;const servers = [], cursors = new Set();
    do {
      const page = await this.rpc.request('mcpServerStatus/list', {threadId: this.threadId, ...(serverName ? {serverName} : {}), detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? {cursor} : {})});
      if (!Array.isArray(page.data)) {result.mcpInventory ||= [];result.mcpInventory.push({key: this.key, scope: serverName ? 'original-server' : 'complete-temporary-manager', malformed: true});}
      assert.ok(Array.isArray(page.data));servers.push(...page.data);assert.ok(++pages <= 20);assert.ok(page.nextCursor == null || typeof page.nextCursor === 'string');if (page.nextCursor) {assert.equal(cursors.has(page.nextCursor), false);cursors.add(page.nextCursor);}cursor = page.nextCursor;
    } while (cursor);
    const publicName = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value) ? value : 'INVALID_PUBLIC_NAME';
    result.mcpInventory ||= [];result.mcpInventory.push({key: this.key, alias: this.alias, threadId: this.threadId, scope: serverName ? 'original-server' : 'complete-temporary-manager', at: new Date().toISOString(),
      servers: servers.map(server => ({name: publicName(server.name), runtimeStatus: ['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'].includes(server.runtimeStatus) ? server.runtimeStatus : 'unknown', authStatus: ['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(server.authStatus) ? server.authStatus : 'unknown', plugin: server.pluginId != null, httpOrigin: server.httpOrigin != null, toolsError: server.toolsError != null, toolCount: Object.keys(server.tools || {}).length, toolNames: Object.keys(server.tools || {}).slice(0, 1000).map(publicName)}))});
    return servers;
  }
  checkOwnServer(server, requireReady) {
    assert.ok(['notStarted', 'starting', 'connected'].includes(server.runtimeStatus));if (requireReady) assert.equal(server.runtimeStatus, 'connected');
    assert.equal(server.authStatus, 'unsupported');assert.equal(server.pluginId ?? null, null);assert.equal(server.httpOrigin ?? null, null);assert.equal(server.toolsError ?? null, null);assert.ok(server.tools && typeof server.tools === 'object' && !Array.isArray(server.tools));
    const names = Object.keys(server.tools);assert.ok(names.every(name => name === 'reviewops_qa_controller'));
    if (requireReady || server.runtimeStatus === 'connected') assert.deepEqual(names, ['reviewops_qa_controller']);
    if (names.length) {const tool = server.tools.reviewops_qa_controller;assert.equal(tool.name, 'reviewops_qa_controller');assert.deepEqual(tool.inputSchema, require(path.join(resources, 'mcp/automation-api.cjs')).qaControllerSchema);}
  }

  async turn(label, text, visualWord) {
    assert.equal(this.active, null);assert.ok(!failure);const startCalls = modelCalls.length, startImages = images.length;
    const record = {key: this.key, label, threadId: this.threadId, startedAt: new Date().toISOString(), callStart: startCalls, imageStart: startImages};modelTurns.push(record);
    const accepted = await this.rpc.request('turn/start', {threadId: this.threadId, input: [{type: 'text', text, text_elements: []}]});const turnId = accepted.turn.id;record.turnId = turnId;
    const terminal = this.finished.get(turnId) || await bounded(new Promise(resolve => this.waiters.set(turnId, resolve)), 'Original genuine turn completion', 300000);this.waiters.delete(turnId);
    assert.equal(terminal.status, 'completed', 'The original genuine turn did not complete.');assert.ok(!failure);
    await until(() => [...protocolPending.values()].some(request => request.key === this.key), value => !value, 'Original MCP receipt observer drained');
    const messages = [...this.items.values()].filter(item => item.turnId === turnId).map(item => item.text).join('\n');
    assert.ok(messages.includes(visualWord), 'The genuine answer did not contain the unseen canvas code.');
    record.completedAt = new Date().toISOString();record.status = terminal.status;record.responseSHA256 = sha(messages);record.visualMatched = true;record.observedVisualCode = visualWord;
    record.callEnd = modelCalls.length;record.imageEnd = images.length;
    const ownCalls = modelCalls.slice(startCalls).filter(call => call.key === this.key);assert.ok(ownCalls.some(call => call.operation === 'capture' && !call.isError && call.image));
    assert.ok(images.slice(startImages).some(image => image.key === this.key));return ownCalls;
  }
  async interrupt() {
    if (this.active && !this.rpc.closed) {
      const turnId = this.active;await this.rpc.request('turn/interrupt', {threadId: this.threadId, turnId});
      await until(() => this.finished.get(turnId), value => value && ['completed', 'failed', 'interrupted'].includes(value.status), 'Original owned turn interruption', 30000);
    }
  }
  async close() {
    await this.interrupt();
    // Ephemeral threads have no persistent rollout to archive. All six turns
    // reuse their original in-process thread; no process restart is claimed.
    if (this.rpc.child && !this.rpc.child.stdin.destroyed) this.rpc.child.stdin.end();
    if (this.closed) assert.deepEqual(await bounded(this.closed, 'Original external AppServer natural exit', 60000), {code: 0, signal: null});
  }
}

async function projectPage(key) {
  return until(async () => {
    for (const page of app.windows()) if (!page.isClosed() && page.url().startsWith('reviewops://app/')) {
      const context = await ipc(page, 'window.context');if (context.windowId === controllers[key].windowId && context.projectId === projects[key].id) return page;
    }
  }, Boolean, 'Exact original controller project host');
}
async function browser(key, url) {
  return until(async () => {
    const state = await admin.call(key, 'state'), target = state.browsers?.find(row => row.url === url && row.visible);
    if (!target) return null;
    try {const value = await admin.call(key, 'state', {browserId: target.browserId});return value.elements?.some(row => row.tag?.toLowerCase() === 'input') ? target.browserId : null;}
    catch (error) {if (error.code === 'QA_DOCUMENT_NOT_READY') return null;throw error;}
  }, Boolean, 'Exact ready controller browser');
}
async function webValue(url) {
  return app.evaluate(async ({webContents}, url) => {
    const all = webContents.getAllWebContents().filter(value => !value.isDestroyed() && value.getURL() === url);
    if (all.length !== 1) throw new Error('The exact owned browser is not unique.');
    return all[0].executeJavaScript('({draft:document.querySelector("#draft").value,instance:window.instance,scrollY})');
  }, url);
}
async function terminalSnapshot(page, label) {
  const rows = [];
  for (const id of terminalIds) {
    const value = await ipc(page, 'terminal.read', {id, cursor: 0});assert.equal(value.closed, false);assert.equal(value.truncated, false);assert.ok(!value.error);
    assert.ok(value.data.includes('OWNED_READY') && value.data.includes('OWNED_TICK '));
    rows.push({id, cursor: value.cursor, tickCount: value.data.split('OWNED_TICK ').length - 1});
  }
  result.sshCheckpoints ||= [];result.sshCheckpoints.push({label, at: new Date().toISOString(), rows});return rows;
}
async function aPreserved(page, url, original, label, priorStreams) {
  assert.deepEqual(fixedBinding(await admin.call('A', 'status')), original.binding, 'B recovery changed A logical ownership.');
  const web = await webValue(url);assert.equal(web.draft, original.web.draft);assert.equal(web.instance, original.web.instance);assert.equal(web.scrollY, original.web.scrollY);
  assert.equal(await draftA.inputValue(), original.appDraft, 'B recovery changed A unsaved app draft.');
  const streams = await terminalSnapshot(page, label);
  for (let index = 0; index < streams.length; index++) assert.ok(streams[index].cursor > priorStreams[index].cursor && streams[index].tickCount > priorStreams[index].tickCount, 'An original A SSH channel stopped streaming.');
  return streams;
}
function heartbeat(browserId) {
  let stopped = false, task;
  const rows = [];
  task = (async () => {
    while (!stopped) {
      const state = await admin.call('A', 'state', {browserId});const capture = await admin.call('A', 'capture', {browserId});
      assert.ok(state.observationId && capture.observationId);rows.push({at: new Date().toISOString(), browserId, windowId: state.windowId, sessionId: state.sessionId});await wait(1500);
    }
  })().catch(error => {failure ||= error;});
  return {rows, async stop() {stopped = true;await task;}};
}
const pane = page => page.locator('.workspace-pane:not([hidden])');
async function photo(page, name) {
  const context = await ipc(page, 'window.context'), key = ['A', 'B'].find(value => controllers[value]?.projectId === context.projectId && controllers[value]?.windowId === context.windowId);
  assert.ok(key && admin, 'Whole-window evidence needs the exact controller-owned host.');
  const capture = await admin.call(key, 'capture'); // Omit browserId: actual host + native child views.
  const bytes = Buffer.from(capture.data, 'base64');assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');assert.ok(bytes.length <= 8 * 1024 ** 2);
  fs.writeFileSync(path.join(output, name), bytes, {mode: 0o600});photos.push({name, key, scope: 'Original product whole-host composite PNG, including native browser views; no edits or success overlay.', sha256: sha(bytes), bytes: bytes.length, width: capture.width, height: capture.height, at: new Date().toISOString()});
}
const instructions = key => `This is one bounded installed ReviewOps feature acceptance on your original external conversation. Use only the reviewops_qa_controller tool on your configured MCP server, projectId ${projects[key].id}. Never use shell, files, web/search, other MCP tools, other projects, or another controller. Keep the original controller proof private in this conversation and reuse the exact original controller for every follow-up. Do not retry uncertain input or invent success. The visible web page has an input and a canvas containing an image-only code; the code is not available in DOM state text. Discover the correct visible browser from host state. Use a fresh state/capture observation before input; use observed element coordinates, not global focus. Use controller capture on the web browser and read its actual returned image. End with a short answer containing the canvas code you actually saw; never include the controller proof. `;
const webTask = (key, marker) => `In the owned web browser, observe the input. If it is off-screen, scroll up before observing/clicking it. Click the input, select all with key a + Meta, and type exactly ${marker}. Then scroll down by about 400 pixels using the controller scroll operation. Capture the web browser and report the actual canvas code. Use only ${key}'s own browser and fresh observations. `;
const requireOperations = (calls, expected) => {for (const operation of expected) assert.ok(calls.some(call => call.operation === operation && !call.isError), 'A required genuine model tool operation was not observed.');};

try {
  await installCandidate();pass('The matching native candidate, immutable ZIP, exact installed Electron tree and physical MCP resources pass source admission.');
  const origin = await servePages(), alias = await serveSsh();await startTap();
  phase = 'installed-app-launch';
  app = await electron.launch({executablePath: executable, args: [], env: appEnv, timeout: 60000});const child = app.process();
  const launched = {kind: 'installed-electron', pid: child.pid, exit: null};launches.push(launched);
  appClosed = new Promise(resolve => child.once('close', (code, signal) => {launched.exit = {code, signal};resolve(launched.exit);}));
  main = (await selectMainHost(app, until, ipc, bounded)).page;main.setDefaultTimeout(15000);await setTestLocale(main);
  app.on('window', page => page.on('pageerror', () => errors.push('OWNED_RENDERER_ERROR')));main.on('pageerror', () => errors.push('OWNED_RENDERER_ERROR'));
  const identity = await app.evaluate(({app}) => ({pid: process.pid, ppid: process.ppid, platform: process.platform, arch: process.arch, executable: process.execPath, packaged: app.isPackaged}));
  verifyOriginalMainProcess({...identity, expectedPlatform: process.platform, childPID: child.pid});assert.equal(identity.arch, process.arch);assert.equal(identity.packaged, true);assert.equal(fs.realpathSync(identity.executable), executable);launched.identity = identity;
  const info = await ipc(main, 'app.info');assert.deepEqual(info.build, build);assert.equal(fs.realpathSync(info.dataPath), data);
  phase = 'owned-main-foreground-admission';const mainWindow = await app.browserWindow(main), mainId = await mainWindow.evaluate(value => value.id);
  await mainWindow.evaluate(value => value.focus());
  const focusedMainId = await until(() => app.evaluate(({BrowserWindow}) => BrowserWindow.getFocusedWindow()?.id ?? null), value => value === mainId, 'Owned main window foreground capability', 5000);
  driverCalls.push({operation: 'owned-main-foreground-preflight', expectedId: mainId, actualId: focusedMainId, at: new Date().toISOString()});
  const hosts = await main.evaluate(() => window.hostManager.reloadHosts());assert.ok(hosts.hosts.some(host => host.alias === alias));
  const group = await ipc(main, 'group.save', {name: 'Owned external controller acceptance'});
  for (const key of ['A', 'B']) {
    projects[key] = await ipc(main, 'project.save', {groupId: group.id, name: 'External chat project ' + key, connection: {kind: key === 'A' ? 'ssh' : 'local', ...(key === 'A' ? {hostAlias: alias} : {}), rootPath: work[key], viewerUrl: origin + '/' + key, viewerWidth: 1100, viewerHeight: 750, viewerScale: 'fit'}});
    reviews[key] = await ipc(main, 'review.save', {projectId: projects[key].id, title: 'External controller review ' + key});
  }
  result.projects = Object.fromEntries(['A', 'B'].map(key => [key, {projectId: projects[key].id, serviceId: projects[key].connection.id, reviewId: reviews[key].id}]));
  await until(() => fs.existsSync(path.join(data, 'integrations/tools.json')), Boolean, 'Owned installed tool connection');
  admin = new DriverMcp();await admin.initialize();
  phase = 'genuine-A-initial';chats.A = new ExternalChat('A');await chats.A.open();
  const markers = {A: 'A_MODEL_DRAFT_' + nonce(), B: 'B_MODEL_DRAFT_' + nonce(), recovered: 'B_RECONNECTED_' + nonce(), reloaded: 'B_RELOADED_' + nonce(), recreated: 'B_NEW_WINDOW_' + nonce()};
  const callsA = await chats.A.turn('A initial image/input/scroll', instructions('A') + `Open exactly once with reviewId ${reviews.A.id} and label Chat A. ` + webTask('A', markers.A), words.A);
  requireOperations(callsA, ['open', 'state', 'click', 'key', 'type', 'scroll', 'capture']);
  const pageA = await projectPage('A');await expect(pageA.locator('.workspace-qa-scope')).toContainText('Chat A');
  const browserA = await browser('A', origin + '/A');assert.equal((await webValue(origin + '/A')).draft, markers.A);assert.ok((await webValue(origin + '/A')).scrollY > 0);
  await pane(pageA).getByRole('tab', {name: '작업이력', exact: true}).click();draftA = pane(pageA).locator('.original-review-composer').getByLabel('작업 내용', {exact: true});
  const appDraft = 'A_UNSAVED_APP_DRAFT_' + nonce();await draftA.fill(appDraft);
  for (let index = 0; index < 2; index++) {
    const terminal = await ipc(pageA, 'terminal.open', {projectId: projects.A.id, serviceId: projects.A.connection.id, cols: 80, rows: 24});terminalIds.push(terminal.id);
    const ping = 'PING_' + nonce();await ipc(pageA, 'terminal.write', {id: terminal.id, data: ping + '\n'});
    await until(() => ipc(pageA, 'terminal.read', {id: terminal.id, cursor: 0}), value => !value.closed && value.data.includes('ECHO ' + ping), 'Actual bidirectional SSH stream');
  }
  assert.equal(sshSessions.length, 2);const originalA = {binding: fixedBinding(await admin.call('A', 'status')), web: await webValue(origin + '/A'), appDraft};
  let streams = await terminalSnapshot(pageA, 'A active before B');await photo(pageA, '01-a-genuine-qa-draft-ssh.png');
  pass('Genuine A used actual image/input/scroll tools; its visible app draft and two bidirectional live SSH channels are active.');

  phase = 'genuine-B-hot-attach';aHeartbeat = heartbeat(browserA);chats.B = new ExternalChat('B');await chats.B.open();
  const callsB = await chats.B.turn('B hot attachment image/input/scroll', instructions('B') + `Open exactly once with reviewId ${reviews.B.id} and label Chat B. ` + webTask('B', markers.B), words.B);
  requireOperations(callsB, ['open', 'state', 'click', 'key', 'type', 'scroll', 'capture']);
  let pageB = await projectPage('B'), browserB = await browser('B', origin + '/B');await expect(pageB.locator('.workspace-qa-scope')).toContainText('Chat B');
  assert.notEqual(controllers.A.windowId, controllers.B.windowId);assert.equal((await webValue(origin + '/B')).draft, markers.B);assert.ok((await webValue(origin + '/B')).scrollY > 0);
  streams = await aPreserved(pageA, origin + '/A', originalA, 'B attached while A streams', streams);
  const bOpened = modelCalls.find(call => call.key === 'B' && call.operation === 'open');
  assert.ok(aHeartbeat.rows.some(row => row.at < bOpened.at) && aHeartbeat.rows.some(row => row.at > bOpened.completedAt), 'A actual QA activity must span B hot attachment.');
  await photo(pageB, '02-b-genuine-hot-attachment.png');pass('Genuine B attached and used its own image/input/scroll while A QA heartbeats, exact ownership, drafts and both SSH streams continued.');

  await aHeartbeat.stop();result.aQaHeartbeats = aHeartbeat.rows;aHeartbeat = null;
  phase = 'genuine-parallel-input-scroll-capture';
  const oldB = await admin.call('B', 'state', {browserId: browserB});
  words.A = nonce();words.B = nonce();await wait(750);
  const aParallelMarker = 'A_PARALLEL_MODEL_DRAFT_' + nonce();
  const aTurn = chats.A.turn('A original chat parallel input/scroll/image', instructions('A') + `Reuse your exact original proof/controller and A browser, without open, detach, reload or navigate. Call status and fresh state. Preserve the unsaved app draft; in the owned website only, ` + webTask('A', aParallelMarker), words.A);
  const bTurn = chats.B.turn('B-only reconnect with parallel B input/scroll/image', instructions('B') + `Reuse your original proof/controller. Call status, detach, status and reconnect for B only; do not open another controller. Then ` + webTask('B', markers.recovered), words.B);
  // Capture rejection immediately while these original promises remain live;
  // a failed turn never causes an unhandled rejection or a replacement turn.
  const parallel = Promise.all([aTurn, bTurn]);parallel.catch(error => {failure ||= error;});
  await until(() => Boolean(chats.A.active && chats.B.active) || failure, value => value, 'Both genuine original turns active');assert.ok(!failure);
  for (const [key, page] of [['A', pageA], ['B', pageB], ['home', main], ['A', pageA]]) {
    const window = await app.browserWindow(page), expectedId = await window.evaluate(value => value.id);await window.evaluate(value => value.focus());
    const actualId = await until(() => app.evaluate(({BrowserWindow}) => BrowserWindow.getFocusedWindow()?.id ?? null), value => value === expectedId, 'Actual owned foreground window');
    driverCalls.push({operation: 'user-foreground-switch', key, expectedId, actualId, at: new Date().toISOString()});
  }
  const [parallelA, reconnectCalls] = await parallel;
  requireOperations(parallelA, ['status', 'state', 'click', 'key', 'type', 'scroll', 'capture']);
  requireOperations(reconnectCalls, ['status', 'detach', 'reconnect', 'state', 'click', 'key', 'type', 'scroll', 'capture']);
  const span = calls => {const relevant = calls.filter(call => !call.isError && ['click', 'key', 'type', 'scroll', 'capture'].includes(call.operation));return {from: Math.min(...relevant.map(call => Date.parse(call.at))), to: Math.max(...relevant.map(call => Date.parse(call.completedAt)))};};
  const overlap = {A: span(parallelA), B: span(reconnectCalls)};
  assert.ok(Math.max(overlap.A.from, overlap.B.from) < Math.min(overlap.A.to, overlap.B.to), 'Actual genuine input/scroll/capture call spans did not overlap.');result.parallelToolSpans = overlap;
  pass('Both original genuine chats performed overlapping input/scroll/capture; actual user foreground switches were observed on the requested owned windows.');
  const updatedA = await webValue(origin + '/A');assert.equal(updatedA.draft, aParallelMarker);assert.equal(updatedA.instance, originalA.web.instance);assert.ok(updatedA.scrollY > 0);
  // A changed only through its own observed, intentional genuine tool work.
  // B-only later operations must preserve this updated original A baseline.
  originalA.web = updatedA;
  await admin.call('B', 'type', {browserId: browserB, observationId: oldB.observationId, text: 'MUST_NOT_REPLAY'}, 'QA_CONTROLLER_OBSERVATION_REQUIRED');
  assert.equal((await webValue(origin + '/B')).draft, markers.recovered);streams = await aPreserved(pageA, origin + '/A', originalA, 'After parallel A and B-only reconnect', streams);
  pass('Original B chat alone detached/reconnected and refused stale input; A kept its original lease, unsaved app draft and live SSH while making only its own intended web changes.');
  aHeartbeat = heartbeat(browserA);

  phase = 'user-B-reload-and-genuine-recovery';
  const reloadWindow = controllers.B.windowId, reloadSession = controllers.B.sessionId;
  const hostObservation = await admin.call('B', 'state');await pageB.reload();await expect(pageB.locator('.workspace-qa-scope')).toContainText('Chat B');
  await admin.call('B', 'type', {observationId: hostObservation.observationId, text: 'MUST_NOT_REPLAY'}, 'QA_DOCUMENT_STALE');
  driverCalls.push({key: 'B', operation: 'user-host-reload', at: new Date().toISOString()});
  words.B = nonce();await wait(750);
  const reloadedCalls = await chats.B.turn('B original chat after ordinary user host reload', instructions('B') + `The user reloaded only your existing B host. Reuse the original proof/controller, call status and reconnect, then discover the current B browser from fresh host state. Do not open a new controller or replay old input. Then ` + webTask('B', markers.reloaded), words.B);
  requireOperations(reloadedCalls, ['status', 'reconnect', 'state', 'click', 'key', 'type', 'scroll', 'capture']);
  assert.equal(controllers.B.windowId, reloadWindow);assert.equal(controllers.B.sessionId, reloadSession);assert.equal(pageB.isClosed(), false);
  browserB = await browser('B', origin + '/B');assert.equal((await webValue(origin + '/B')).draft, markers.reloaded);
  streams = await aPreserved(pageA, origin + '/A', originalA, 'After genuine B ordinary reload recovery', streams);
  await photo(pageB, '03-b-original-chat-after-user-reload.png');
  pass('Ordinary user B reload rejected its old observation; the original genuine B chat recovered fresh input and image proof in its same window while A continued.');

  phase = 'user-B-close-and-genuine-recreation';
  const priorWindow = controllers.B.windowId, priorSession = controllers.B.sessionId;
  const bWindow = await app.browserWindow(pageB);await bWindow.evaluate(value => value.close());await until(() => pageB.isClosed(), Boolean, 'Normal B-only host closure');
  driverCalls.push({key: 'B', operation: 'user-normal-window-close', at: new Date().toISOString()});words.B = nonce();
  const recreatedCalls = await chats.B.turn('B original controller after user reload and recreation', instructions('B') + `The user reloaded and then normally closed only your B window. Reuse the original proof/controller, call status and reconnect; do not open a new controller or replay old inputs. Discover the new current B browser, then ` + webTask('B', markers.recreated), words.B);
  requireOperations(recreatedCalls, ['status', 'reconnect', 'state', 'type', 'scroll', 'capture']);
  assert.notEqual(controllers.B.windowId, priorWindow);assert.notEqual(controllers.B.sessionId, priorSession);
  pageB = await projectPage('B');browserB = await browser('B', origin + '/B');await expect(pageB.locator('.workspace-qa-scope')).toContainText('Chat B');
  assert.equal((await webValue(origin + '/B')).draft, markers.recreated);streams = await aPreserved(pageA, origin + '/A', originalA, 'After B-only user window recreation', streams);
  await photo(pageB, '04-b-original-chat-new-window.png');pass('Normal B-only window recreation recovered the original genuine controller with a fresh lease and image/input proof while A continued.');

  phase = 'final-original-A-driver-observation';await aHeartbeat.stop();result.aQaHeartbeats.push(...aHeartbeat.rows);aHeartbeat = null;
  await admin.call('A', 'state', {browserId: browserA});await admin.call('A', 'capture', {browserId: browserA});
  await aPreserved(pageA, origin + '/A', originalA, 'A final driver observation', streams);await photo(pageA, '05-a-original-chat-work-preserved.png');
  assert.equal(modelTurns.length, 6);assert.equal(new Set(modelTurns.map(turn => turn.threadId)).size, 2);
  assert.deepEqual(modelCalls.filter(call => call.operation === 'open').map(call => call.key).sort(), ['A', 'B']);
  assert.equal(errors.length, 0);assert.ok(!failure);assert.deepEqual([...new Set([...physicalMcp.values()].filter(row => row.modelToolCalls > 0).map(row => row.key))].sort(), ['A', 'B']);
  pass('Two genuine original conversations completed six bounded turns and image proofs; final driver observations confirmed A original window, scroll, drafts and both SSH channels.');
} catch (error) {
  failure ||= error;result.failure = {phase, code: typeof error.code === 'string' ? error.code : 'EXTERNAL_COHORT_FAILED', setupStages: Object.fromEntries(Object.entries(chats).map(([key, chat]) => [key, chat.setupStage])), driverLocations: [...String(error.stack || '').matchAll(/e2e-qa-controller-external\.mjs:(\d+):(\d+)/g)].map(match => ({line: Number(match[1]), column: Number(match[2])}))};process.exitCode = 1;
  for (const key of ['A', 'B']) if (app && controllers[key]) {const page = await projectPage(key).catch(() => null);if (page) await photo(page, 'failure-owned-' + key + '.png').catch(() => {});}
} finally {
  phase = 'owned-cleanup';const cleanup = result.cleanup = {errors: []};
  const attempt = async (name, action) => {try {await action();} catch {cleanup.errors.push(name);process.exitCode = 1;}};
  if (aHeartbeat) await attempt('A heartbeat completion', () => aHeartbeat.stop());
  // Do not terminate unrelated clients or refresh shared MCP configuration.
  // Even failed cohorts clean only original handles owned by this driver.
  if (failure) for (const key of ['A', 'B']) if (chats[key]) await attempt(key + ' original failed-cohort turn interruption', () => chats[key].interrupt());
  if (draftA && !draftA.page().isClosed()) await attempt('Owned synthetic app draft cleanup', () => draftA.fill(''));
  const pageA = app && controllers.A ? await projectPage('A').catch(() => null) : null;
  if (pageA) for (const id of terminalIds) await attempt('Owned SSH terminal natural exit', async () => {
    await ipc(pageA, 'terminal.write', {id, data: 'EXIT\n'});await until(() => ipc(pageA, 'terminal.read', {id, cursor: 0}), value => value.closed && value.data.includes('OWNED_BYE'), 'Original SSH stream natural end');await ipc(pageA, 'terminal.close', {id});
  });
  if (admin) {
    for (const key of ['A', 'B']) if (controllers[key]) await attempt(key + ' own controller release', () => admin.call(key, 'release'));
    await attempt('Original driver MCP natural exit', () => admin.close());
  }
  for (const key of ['A', 'B']) if (chats[key]) await attempt(key + ' original ephemeral AppServer EOF', () => chats[key].close());
  await attempt('SDK-owned MCP exact PID closure', async () => {
    await until(() => sdkClosureSnapshot(), rows => rows.every(row => row.wrapperAbsent && row.childAbsent), 'SDK-owned original wrapper and MCP child closure', 20000);
  });
  if (app) await attempt('Original installed app natural exit', async () => {await bounded(app.close(), 'Owned installed app close', 30000);assert.deepEqual(await bounded(appClosed, 'Original installed main closure'), {code: 0, signal: null});app = null;});
  for (const connection of sshConnections) connection.end();
  if (sshServer) await attempt('Owned SSH server closure', () => bounded(new Promise(resolve => sshServer.close(resolve)), 'Owned SSH server close'));
  await attempt('Owned SSH streaming children natural exit', async () => {await until(() => sshChildren.size, value => value === 0, 'Original SSH streaming children close');for (const row of sshSessions) assert.deepEqual(row.exit, {code: 0, signal: null});});
  if (tapServer) await attempt('Private tap closure', () => bounded(new Promise(resolve => tapServer.close(resolve)), 'Private tap close'));
  if (webServer) await attempt('Owned fixture HTTP closure', () => bounded(new Promise(resolve => webServer.close(resolve)), 'Owned fixture HTTP close'));
  await attempt('Candidate and selected CLI bytes unchanged', async () => {assert.equal(hashFile(zip), descriptor.sha256);assert.equal(hashFile(cli), result.cli.sha256);if (originalInventory) assert.deepEqual(inventory(bundle), originalInventory);});
  try {result.physicalMcp = sdkClosureSnapshot();} catch {result.physicalMcp = [...physicalMcp.values()];cleanup.errors.push('SDK closure evidence inspection unconfirmed');}
  result.physicalMcpCount = physicalMcp.size + (admin ? 1 : 0);result.actualChatTransportCount = result.physicalMcp.filter(row => row.modelToolCalls > 0).length;result.inventoryOrIdleTransportCount = result.physicalMcp.filter(row => row.modelToolCalls === 0).length;result.models = {originalThreads: Object.values(chats).map(chat => ({key: chat.key, threadId: chat.threadId})), turns: modelTurns.length};
  result.driverSHA256 = hashFile(new URL(import.meta.url));result.rendererErrors = errors;result.ok = !failure && cleanup.errors.length === 0 && checks.length === 8;
  if (!result.ok) process.exitCode = 1;
  // Keep the private failed fixture and immutable original observations for
  // review. No raw controller proof, CLI stderr or full model context is saved.
  writeJSON(path.join(output, 'results.json'), result);
  console.log(JSON.stringify({ok: result.ok, output, checks: checks.length, turns: modelTurns.length, cleanupErrors: cleanup.errors}));
}
