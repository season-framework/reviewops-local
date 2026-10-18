'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Server, utils } = require('ssh2');
const { createConfigSnapshot, connectConfig, wrapSftp, CommandChannel } = require('../electron/config-ssh.cjs');
const { createSshService, validateConfig } = require('../electron/ssh.cjs');
const { createAgentManager } = require('../electron/agents.cjs');
const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
const publicKey = utils.parseKey(hostKey).getPublicSSH();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, ms = 12000) { const start = Date.now(); while (Date.now() - start < ms) { const value = await read(); if (value) return value; await pause(20); } assert.fail('SSH 검사 응답을 받지 못했습니다.'); }
function fileAttrs(info) { return { mode: info.mode, uid: info.uid, gid: info.gid, size: info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) }; }

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-config-ssh-')), root = path.join(base, 'work'), bin = path.join(base, 'bin'), home = path.join(base, 'home');
  const snapshotRoot=path.join(base,'connection-configs');await fs.mkdir(snapshotRoot);
  await fs.mkdir(root); await fs.mkdir(bin); await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(root, 'review.md'), 'SSH 호스트 파일\n');
  await fs.writeFile(path.join(home, '.codex/models_cache.json'), JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture model' }] }));
  const codex = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('codex-cli config-fixture-1.0');return;}if(a[0]==='login'&&a[1]==='status')return;let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const images=a.flatMap((v,i)=>v==='-i'?[{path:a[i+1],bytes:fs.readFileSync(a[i+1]).toString('base64'),mode:fs.statSync(a[i+1]).mode&511}]:[]);fs.writeFileSync('request.json',JSON.stringify({input,args:a,images,pid:process.pid}));const send=x=>console.log(JSON.stringify(x));send({type:'thread.started',thread_id:'alias-session'});if(input.includes('WAIT_FOR_CANCEL')){setInterval(()=>{},1000);return;}send({type:'item.completed',item:{id:'response',type:'agent_message',text:'SSH 완료'}});send({type:'turn.completed'});});\n`;
  await fs.writeFile(path.join(bin, 'codex'), codex, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'setsid'), `#!${process.execPath}\nconst{spawn}=require('node:child_process');let a=process.argv.slice(2);if(a[0]==='--wait')a.shift();const c=spawn(a.shift(),a,{stdio:'inherit',detached:true});c.on('error',()=>process.exit(127));c.on('exit',code=>process.exit(code??143));\n`, { mode: 0o700 });
  const clients = new Set(), children = new Set(), sockets = new Set(); let forwards = 0;
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'none' && context.username === 'fixture' ? context.accept() : context.reject());
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || info.destPort !== server.address().port) { reject(); return; }
        forwards++; const socket = net.connect(info.destPort, info.destIP); sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
        socket.on('connect', () => { const channel = accept(); channel.on('error', () => {}); channel.pipe(socket).pipe(channel); channel.on('close', () => socket.destroy()); });
      });
      client.on('session', accept => {
        const session = accept();
        session.on('sftp', accept => {
          const sftp = accept(), handles = new Map(); let next = 0;
          const save = value => { const id = String(++next); handles.set(id, value); return Buffer.from(id); };
          const on = (operation, run) => sftp.on(operation, async (id, ...args) => { try { await run(id, ...args); } catch (error) { sftp.status(id, error.code === 'ENOENT' ? 2 : 4); } });
          on('REALPATH', async (id, value) => sftp.name(id, [{ filename: await fs.realpath(value === '.' ? base : value), attrs: {} }]));
          on('STAT', async (id, value) => sftp.attrs(id, fileAttrs(await fs.stat(value))));
          on('OPENDIR', async (id, value) => { const entries = await Promise.all((await fs.readdir(value)).map(async name => ({ filename: name, attrs: fileAttrs(await fs.lstat(path.join(value, name))) }))); sftp.handle(id, save({ entries })); });
          on('READDIR', (id, key) => { const handle = handles.get(key.toString()); if (handle.sent) sftp.status(id, 1); else { handle.sent = true; sftp.name(id, handle.entries); } });
          on('OPEN', async (id, value, flags, attributes) => { const mode = flags & 32 ? 'wx' : flags & 2 ? 'w' : 'r'; sftp.handle(id, save({ file: await fs.open(value, mode, attributes.mode || 0o600) })); });
          on('READ', async (id, key, offset, length) => { const buffer = Buffer.alloc(length), result = await handles.get(key.toString()).file.read(buffer, 0, length, offset); if (result.bytesRead) sftp.data(id, buffer.subarray(0, result.bytesRead)); else sftp.status(id, 1); });
          on('WRITE', async (id, key, offset, bytes) => { await handles.get(key.toString()).file.write(bytes, 0, bytes.length, offset); sftp.status(id, 0); });
          on('CLOSE', async (id, key) => { const value = handles.get(key.toString()); await value?.file?.close(); handles.delete(key.toString()); sftp.status(id, 0); });
          sftp.on('close', () => { for (const value of handles.values()) value.file?.close().catch(() => {}); handles.clear(); });
        });
        session.on('exec', (accept, _reject, info) => {
          const channel = accept(); channel.on('error', () => {});
          if(options.rejectStop&&info.command.startsWith("bash -c 'd=")){channel.exit(1);channel.end();return;}
          // Prevent a test shell from reading the user's actual login files.
          const command = info.command.replaceAll('bash -lc ', '/bin/bash --noprofile -c ');
          const child = spawn('/bin/bash', ['--noprofile', '-c', command], { detached: true, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HOME: home, CODEX_HOME: path.join(home, '.codex') }, stdio: ['pipe', 'pipe', 'pipe'] });
          children.add(child); child.stdin.on('error', () => {}); channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
          child.on('close', code => { children.delete(child); if (!channel.destroyed) { channel.exit(code ?? 143); channel.end(); } });
        });
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const known = path.join(base, 'known_hosts'), configPath = path.join(base, 'config');
  await fs.writeFile(known, `[127.0.0.1]:${server.address().port} ssh-rsa ${publicKey.toString('base64')}\n`, { mode: 0o600 });
  await fs.writeFile(configPath, `Host jump fixture\n  HostName 127.0.0.1\n  Port ${server.address().port}\n  User fixture\n  UserKnownHostsFile ${known}\n  GlobalKnownHostsFile /dev/null\nHost fixture\n  ProxyJump fixture@jump:${server.address().port}\n`, { mode: 0o600 });
  const configSsh={snapshotOptions:{tempRoot:snapshotRoot}};
  const ssh = createSshService({ timeoutMs: 6000,configSsh }), manager = createAgentManager({ commandTimeoutMs: 6000, killTimeoutMs: 100,configSsh });
  t.after(async () => {
    await manager.closeAll(); ssh.close();
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    for (const socket of sockets) socket.destroy(); for (const client of clients) { client.end(); client._sock?.destroy(); }
    await new Promise(resolve => server.close(resolve)); await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, manager, ssh, configPath, known, snapshotRoot, forwards: () => forwards, config: { id: 'alias-project', kind: 'ssh', hostAlias: 'fixture', sshConfigPath: configPath, rootPath: root }, settings: { binary: 'codex', model: 'fixture-model' } };
}

test('SSH alias validation reads host and user from config while preserving direct SSH requirements', () => {
  assert.equal(validateConfig({ hostAlias: 'fixture', sshConfigPath: '/tmp/config' }).host, 'fixture');
  assert.throws(() => validateConfig({ host: 'example.invalid' }), { code: 'SSH_CONFIG_INVALID' });
  for (const hostAlias of ['-x', 'a b', '*', 'a\n']) assert.throws(() => validateConfig({ hostAlias, sshConfigPath: '/tmp/config' }), { code: 'SSH_CONFIG_INVALID' });
  assert.throws(() => validateConfig({ hostAlias: 'fixture', sshConfigPath: 'relative' }), { code: 'SSH_CONFIG_INVALID' });
});

test('OpenSSH uses ProxyJump and known_hosts for project file browsing and command stdin', async t => {
  const f = await fixture(t);
  assert.equal((await f.ssh.test(f.config)).ok, true);
  assert.ok((await f.ssh.list(f.config)).entries.some(row => row.name === 'review.md'));
  assert.equal((await f.ssh.read(f.config, 'review.md')).content, 'SSH 호스트 파일\n');
  const client = await connectConfig(f.config), output = [];
  const result = await new Promise((resolve, reject) => client.exec("read line; printf '%s' \"$line\"; printf 'err' >&2; exit 7", { pty: false }, (error, channel) => {
    if (error) { reject(error); return; } const errors = []; channel.on('data', data => output.push(data)); channel.stderr.on('data', data => errors.push(data)); channel.on('error', reject); channel.on('close', code => resolve({ code, stderr: Buffer.concat(errors).toString() })); channel.end('한글 입력\n');
  }));
  client.end(); assert.equal(result.code, 7); assert.ok(result.stderr.endsWith('err')); assert.equal(Buffer.concat(output).toString(), '한글 입력'); assert.ok(f.forwards() >= 4);
});

test('changed known_hosts rejects alias access without a fallback or password prompt', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.known, '');
  await assert.rejects(f.ssh.test(f.config), /SSH 서버 키/);
});

test('SFTP callback adapter keeps exclusive attachment flags, mode and chunk offsets', async () => {
  const writes = [], raw = { open: async (...args) => { writes.push(args); return Buffer.from('h'); }, write: async (_h, offset, bytes) => writes.push({ offset, length: bytes.length }), closeHandle: async () => {} };
  const sftp = wrapSftp(raw), handle = await new Promise((resolve, reject) => sftp.open('/tmp/image', 'wx', 0o600, (error, value) => error ? reject(error) : resolve(value)));
  await new Promise((resolve, reject) => sftp.write(handle, Buffer.alloc(70000), 0, 70000, 17, error => error ? reject(error) : resolve()));
  assert.deepEqual(writes[0], ['/tmp/image', 2 | 8 | 32, 0o600]);
  assert.deepEqual(writes.slice(1), [{ offset: 17, length: 32768 }, { offset: 32785, length: 32768 }, { offset: 65553, length: 4464 }]);
});

test('SSH alias runs the same server Codex CLI with attachment upload, sandbox bypass and session continuation', async t => {
  const f = await fixture(t), status = await f.manager.environment(f.config, f.settings);
  assert.equal(status.installed, true); assert.equal(status.loggedIn, true); assert.equal(status.version, 'codex-cli config-fixture-1.0');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=', 'base64');
  const run = f.manager.start({ config: f.config, settings: f.settings, prompt: '수정하십시오.', images: [{ name: 'image.png', mimeType: 'image/png', bytes: image }] });
  const result = await eventually(() => { const job = f.manager.read(run.id); return ['completed', 'failed'].includes(job.status) && job; });
  assert.equal(result.status, 'completed', result.error); assert.equal(result.response, 'SSH 완료'); assert.equal(result.sessionId, 'alias-session');
  const recorded = JSON.parse(await fs.readFile(path.join(f.root, 'request.json'), 'utf8'));
  assert.ok(recorded.args.includes('--dangerously-bypass-approvals-and-sandbox')); assert.equal(recorded.input, '수정하십시오.'); assert.equal(recorded.images[0].bytes, image.toString('base64')); assert.equal(recorded.images[0].mode, 0o600);
  await eventually(async () => { try { await fs.access(recorded.images[0].path); return false; } catch { return true; } });
  const continued = f.manager.start({ config: f.config, settings: f.settings, prompt: '계속하십시오.', sessionId: result.sessionId });
  assert.equal((await eventually(() => { const row = f.manager.read(continued.id); return ['completed', 'failed'].includes(row.status) && row; })).status, 'completed');
  const args = JSON.parse(await fs.readFile(path.join(f.root, 'request.json'), 'utf8')).args; assert.deepEqual(args.slice(-3), ['resume', 'alias-session', '-']);
});

test('SSH alias cancellation confirms the remote process group stopped and removes uploaded attachments', async t => {
  const f = await fixture(t), image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cyYAAAAASUVORK5CYII=', 'base64');
  const run = f.manager.start({ config: f.config, settings: f.settings, prompt: 'WAIT_FOR_CANCEL', images: [{ name: 'cancel.png', mimeType: 'image/png', bytes: image }] });
  const recorded = await eventually(async () => { try { return JSON.parse(await fs.readFile(path.join(f.root, 'request.json'), 'utf8')); } catch { return null; } });
  await fs.writeFile(f.configPath,'Host fixture\n HostName different.invalid\n User wrong-user\n');
  const result = await f.manager.cancel(run.id);
  assert.equal(result.status, 'cancelled', result.error); assert.equal(result.terminationConfirmed, true);
  await eventually(() => { try { process.kill(recorded.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  await assert.rejects(fs.access(recorded.images[0].path));
  assert.deepEqual(await fs.readdir(f.snapshotRoot),[]);
});

test('SSH alias cancellation reports an unconfirmed stop when the original server rejects it', async t => {
  const f = await fixture(t, { rejectStop: true });
  const run = f.manager.start({ config: f.config, settings: f.settings, prompt: 'WAIT_FOR_CANCEL' });
  const recorded = await eventually(async () => { try { return JSON.parse(await fs.readFile(path.join(f.root, 'request.json'), 'utf8')); } catch { return null; } });
  const controlDirectory = `/tmp/reviewops-agent-${run.id}`, group = Number(await fs.readFile(path.join(controlDirectory, 'pid'), 'utf8'));
  t.after(async () => { try { process.kill(-group, 'SIGKILL'); } catch {} await fs.rm(controlDirectory, { recursive: true, force: true }); });
  await assert.rejects(f.manager.cancel(run.id), { code: 'AGENT_STOP_UNCONFIRMED' });
  const result = await eventually(() => { const row = f.manager.read(run.id); return row.status === 'failed' && row; });
  assert.equal(result.terminationConfirmed, false); assert.doesNotThrow(() => process.kill(recorded.pid, 0));
  try { process.kill(-group, 'SIGKILL'); } catch {}
});

test('embedded SSH terminal resizes its remote tty without writing a command to terminal input', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const resizeCommands = [], owner = { channels: new Set(), destroyed: false, exec: (command, options, done) => { resizeCommands.push(command); done(new Error('fixture resize')); } };
  const channel = new CommandChannel(child, owner, { tty: true, rows: 24, cols: 80 }); owner.channels.add(channel);
  const output = []; channel.on('data', data => output.push(data));
  child.stdout.write(Buffer.from('before\x1eREVIEWOPS_TTY:/dev/pts/7\x1fafter'));
  await new Promise(resolve => setImmediate(resolve));
  channel.setWindow(40, 160);
  assert.equal(Buffer.concat(output).toString(), 'beforeafter');
  assert.match(resizeCommands.at(-1), /^stty -F '\/dev\/pts\/7' rows 40 cols 160/);
  assert.equal(child.stdin.readableLength, 0);
  child.emit('close', 0, null);
});

async function configFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-ssh-snapshot-'));
  const home = path.join(base, 'fixture home'), source = path.join(base, 'source config'), snapshots = path.join(base, 'snapshots');
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true }); await fs.mkdir(snapshots);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, home, source, snapshots, options: { home, tempRoot: snapshots } };
}

test('SSH config snapshots retain quoted paths, Include order and original credential references', async t => {
  const f = await configFixture(t), includes = path.join(f.base, 'included files'); await fs.mkdir(includes);
  const identity = path.join(f.base, 'identity with spaces'), known = path.join(f.base, 'known hosts');
  await fs.writeFile(identity, 'PRIVATE KEY MUST NOT BE COPIED'); await fs.writeFile(known, 'KNOWN HOST CONTENT MUST NOT BE COPIED');
  await fs.writeFile(path.join(includes, 'a.conf'), `Host fixture\n HostName 192.0.2.11\n User selected-user\n IdentityFile "${identity}"\n UserKnownHostsFile "${known}"\n`);
  await fs.writeFile(path.join(includes, 'b.conf'), 'Host fixture\n HostName 192.0.2.99\n');
  await fs.writeFile(f.source, `Include "${includes}/*.conf" # quoted wildcard\n`);
  const snapshot = await createConfigSnapshot(f.source, f.options); t.after(snapshot.cleanup);
  const read = promisify(execFile), command = process.platform === 'darwin' ? '/usr/bin/ssh' : 'ssh';
  const original = await read(command, ['-G', '-F', f.source, 'fixture']), saved = await read(command, ['-G', '-F', snapshot.configPath, 'fixture']);
  assert.equal(saved.stdout, original.stdout); assert.match(saved.stdout, /^hostname 192\.0\.2\.11$/m);
  assert.equal((await fs.stat(snapshot.directory)).mode & 0o777, 0o700);
  const files = [];
  for await (const file of fs.glob(path.join(snapshot.directory, '**/*'))) if ((await fs.stat(file)).isFile()) files.push(file);
  assert.equal(files.length, 3);
  for (const file of files) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const contents = await fs.readFile(file, 'utf8'); assert.equal(contents.includes('PRIVATE KEY MUST NOT BE COPIED'), false); assert.equal(contents.includes('KNOWN HOST CONTENT MUST NOT BE COPIED'), false);
  }
  await fs.writeFile(f.source, 'Host fixture\n HostName modified.invalid\n');
  await fs.writeFile(path.join(includes, 'a.conf'), 'Host fixture\n HostName changed.invalid\n');
  assert.equal((await read(command, ['-G', '-F', snapshot.configPath, 'fixture'])).stdout, saved.stdout);
  snapshot.cleanup(); await assert.rejects(fs.access(snapshot.directory));
});

test('SSH snapshots preserve relative and per-host Include patterns without reading later source edits', async t => {
  const f = await configFixture(t), includes = path.join(f.home, '.ssh', 'hosts'); await fs.mkdir(includes);
  await fs.writeFile(path.join(includes, 'fixture.conf'), 'Host fixture\n HostName 192.0.2.21\n');
  await fs.writeFile(path.join(includes, 'jump.conf'), 'Host jump\n HostName 192.0.2.22\n');
  await fs.writeFile(f.source, 'Include hosts/%n.conf\n');
  const snapshot = await createConfigSnapshot(f.source, f.options); t.after(snapshot.cleanup);
  const read = promisify(execFile), command = process.platform === 'darwin' ? '/usr/bin/ssh' : 'ssh';
  assert.match((await read(command, ['-G', '-F', snapshot.configPath, 'fixture'])).stdout, /^hostname 192\.0\.2\.21$/m);
  assert.match((await read(command, ['-G', '-F', snapshot.configPath, 'jump'])).stdout, /^hostname 192\.0\.2\.22$/m);
});

test('cyclic SSH Includes and files changed during reading fail with temporary copies removed', async t => {
  const f = await configFixture(t), included = path.join(f.base, 'included');
  await fs.writeFile(f.source, `Include "${included}"\n`); await fs.writeFile(included, `Include "${f.source}"\n`);
  await assert.rejects(createConfigSnapshot(f.source, f.options), /같은 파일을 반복/);
  assert.deepEqual(await fs.readdir(f.snapshots), []);
  await fs.writeFile(f.source, 'Host fixture\n HostName 192.0.2.30\n');
  await assert.rejects(createConfigSnapshot(f.source, { ...f.options, afterRead: file => fs.appendFile(file, '# concurrent change\n') }), /SSH 설정이 변경/);
  assert.deepEqual(await fs.readdir(f.snapshots), []);
});

test('closing an SSH connection during config copying aborts preparation and removes its copies', async t => {
  const f = await configFixture(t); await fs.writeFile(f.source, 'Host fixture\n HostName 192.0.2.31\n');
  let readStarted, releaseRead; const started = new Promise(resolve => { readStarted = resolve; }), hold = new Promise(resolve => { releaseRead = resolve; });
  const client = await connectConfig({ hostAlias: 'fixture', sshConfigPath: f.source }, { snapshotOptions: { ...f.options, afterRead: async () => { readStarted(); await hold; } } });
  const rejected = assert.rejects(client.prepareSnapshot(), { name: 'AbortError' });
  await started; const closing = client.destroy(); releaseRead(); await Promise.all([rejected, closing]);
  assert.deepEqual(await fs.readdir(f.snapshots), []);
});

test('SSH config copies reject Include directives that point at private keys or login data', async t => {
  const f = await configFixture(t), key = path.join(f.base, 'custom-key');
  await fs.writeFile(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n');
  await fs.writeFile(f.source, `Include "${key}"\n`);
  await assert.rejects(createConfigSnapshot(f.source, f.options), /SSH 개인 키 파일/);
  const auth = path.join(f.base, 'auth.json'); await fs.writeFile(auth, '{"tokens":{"access_token":"fixture"}}');
  await fs.writeFile(f.source, `Include "${auth}"\n`);
  await assert.rejects(createConfigSnapshot(f.source, f.options), /인증 파일/);
  assert.deepEqual(await fs.readdir(f.snapshots), []);
});
