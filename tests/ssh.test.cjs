'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Server, utils } = require('ssh2');
const { createSshService, fingerprintOf, validateConfig } = require('../electron/ssh.cjs');

const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
const hostFingerprint = fingerprintOf(utils.parseKey(hostKey).getPublicSSH());

function attrs(info) {
  return { mode: info.mode, uid: info.uid, gid: info.gid, size: info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) };
}

async function fixture(t, limits = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-ssh-'));
  const root = path.join(base, "work ' folder");
  const outside = path.join(base, 'outside.txt');
  const privateKeyPath = path.join(base, 'identity.pem');
  await fs.writeFile(privateKeyPath, hostKey, { mode: 0o600 });
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'review.md'), '리뷰 내용\n');
  await fs.writeFile(path.join(root, 'nested', 'data.json'), '{"review":true}');
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(300));
  await fs.writeFile(path.join(root, 'raw.bin'), Buffer.from([0, 255, 10]));
  await fs.writeFile(path.join(root, 'document.pdf'), '%PDF-1.7\nfixture');
  await fs.writeFile(path.join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  await fs.writeFile(outside, 'private');
  await fs.symlink(outside, path.join(root, 'outside-link'));
  const requests = [];
  const commands = [];
  const clients = new Set();
  let authenticationCount = 0;
  let active = 0;

  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    active += 1;
    client.on('error', () => {});
    client.on('close', () => { clients.delete(client); active -= 1; });
    client.on('authentication', context => {
      authenticationCount += 1;
      if (context.method === 'password' && context.username === 'tester' && context.password === 'secret') context.accept();
      else if (context.method === 'publickey' && context.username === 'tester' && context.key.data.equals(utils.parseKey(hostKey).getPublicSSH()) && (!context.signature || utils.parseKey(hostKey).verify(context.blob, context.signature, context.hashAlgo) === true)) context.accept();
      else context.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', acceptSftp => {
        const sftp = acceptSftp();
        const handles = new Map();
        let nextHandle = 1;
        function handle(value) {
          const id = String(nextHandle++);
          handles.set(id, value);
          return Buffer.from(id);
        }
        function operation(name, implementation) {
          sftp.on(name, async (id, ...args) => {
            try { await implementation(id, ...args); }
            catch (error) {
              const code = error.code === 'ENOENT' ? 2 : error.code === 'EACCES' ? 3 : 4;
              try { sftp.status(id, code, error.message); } catch {}
            }
          });
        }
        operation('REALPATH', async (id, file) => {
          requests.push({ operation: 'realpath', file });
          const canonical = await fs.realpath(file === '.' ? base : file);
          sftp.name(id, [{ filename: canonical, longname: canonical, attrs: {} }]);
        });
        operation('STAT', async (id, file) => {
          requests.push({ operation: 'stat', file });
          sftp.attrs(id, attrs(await fs.stat(file)));
        });
        operation('LSTAT', async (id, file) => sftp.attrs(id, attrs(await fs.lstat(file))));
        operation('OPENDIR', async (id, directory) => {
          requests.push({ operation: 'opendir', file: directory });
          const names = await fs.readdir(directory);
          const entries = await Promise.all(names.map(async name => ({ filename: name, longname: name, attrs: attrs(await fs.lstat(path.join(directory, name))) })));
          sftp.handle(id, handle({ entries, offset: 0 }));
        });
        operation('READDIR', async (id, token) => {
          const directory = handles.get(token.toString());
          if (directory.offset >= directory.entries.length) sftp.status(id, 1);
          else {
            const entries = directory.entries.slice(directory.offset, directory.offset + 2);
            directory.offset += entries.length;
            sftp.name(id, entries);
          }
        });
        operation('OPEN', async (id, file) => {
          requests.push({ operation: 'open', file });
          sftp.handle(id, handle({ file: await fs.open(file, 'r') }));
        });
        operation('READ', async (id, token, offset, length) => {
          const file = handles.get(token.toString()).file;
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await file.read(buffer, 0, length, offset);
          if (bytesRead) sftp.data(id, buffer.subarray(0, bytesRead));
          else sftp.status(id, 1);
        });
        operation('CLOSE', async (id, token) => {
          const entry = handles.get(token.toString());
          handles.delete(token.toString());
          if (entry?.file) await entry.file.close();
          sftp.status(id, 0);
        });
        sftp.on('close', () => {
          for (const entry of handles.values()) if (entry.file) entry.file.close().catch(() => {});
          handles.clear();
        });
      });
      session.on('exec', (acceptExec, _reject, info) => {
        commands.push(info.command);
        const stream = acceptExec();
        stream.on('error', () => {});
        if (info.command.endsWith('hang')) return;
        if (info.command.endsWith('large-output')) {
          stream.write('x'.repeat(512));
          stream.exit(0);
          stream.end();
          return;
        }
        stream.write('stdout content');
        stream.stderr.write('stderr content');
        stream.exit(7);
        stream.end();
      });
    }));
  });
  server.on('error', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const service = createSshService({ timeoutMs: 5000, ...limits });
  t.after(async () => {
    service.close();
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(base, { recursive: true, force: true });
  });
  const config = { host: '127.0.0.1', port: server.address().port, username: 'tester', authType: 'password', password: 'secret', rootPath: root, hostFingerprint };
  return { service, config, root, outside, privateKeyPath, requests, commands, authenticationCount: () => authenticationCount, active: () => active };
}

test('SSH requires explicit key trust before authentication and refuses a changed key', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.test({ ...f.config, hostFingerprint: '' }), error => {
    assert.equal(error.code, 'SSH_TRUST_REQUIRED');
    assert.equal(error.fingerprint, hostFingerprint);
    assert.equal(error.host, '127.0.0.1');
    return true;
  });
  assert.equal(f.authenticationCount(), 0);
  await assert.rejects(f.service.test({ ...f.config, hostFingerprint: `SHA256:${'a'.repeat(43)}` }), { code: 'SSH_HOST_KEY_CHANGED' });
  assert.equal(f.authenticationCount(), 0);
  const result = await f.service.test(f.config);
  assert.equal(result.ok, true);
  assert.equal(result.fingerprint, hostFingerprint);
  assert.equal(result.host, f.config.host);
  assert.equal(result.rootPath, await fs.realpath(f.root));
  assert.ok(f.authenticationCount() > 0);
});

test('SSH reads real SFTP directory pages and text, image, and PDF files', async t => {
  const f = await fixture(t);
  const listing = await f.service.list(f.config);
  assert.equal(listing.path, '.');
  assert.equal(listing.entries[0].name, 'nested');
  assert.equal(listing.entries.find(entry => entry.name === 'outside-link').type, 'symlink');
  const review = await f.service.read(f.config, 'review.md');
  assert.equal(review.content, '리뷰 내용\n');
  assert.equal(review.mimeType, 'text/markdown');
  assert.equal(review.size, Buffer.byteLength('리뷰 내용\n'));
  const nested = await f.service.read(f.config, 'nested/data.json');
  assert.equal(nested.path, 'nested/data.json');
  assert.equal(nested.mimeType, 'application/json');
  const pdf = await f.service.read(f.config, 'document.pdf');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.ok(pdf.dataUrl.startsWith('data:application/pdf;base64,'));
  const png = await f.service.read(f.config, 'image.png');
  assert.equal(png.mimeType, 'image/png');
  assert.ok(png.dataUrl.startsWith('data:image/png;base64,'));
});

test('SSH blocks traversal and symlinks leaving the configured root before file open', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.read(f.config, '../outside.txt'), { code: 'SSH_PATH_OUTSIDE_ROOT' });
  await assert.rejects(f.service.read(f.config, f.outside), { code: 'SSH_PATH_OUTSIDE_ROOT' });
  await assert.rejects(f.service.read(f.config, 'outside-link'), { code: 'SSH_PATH_OUTSIDE_ROOT' });
  assert.equal(f.requests.some(request => request.operation === 'open'), false);
  const result = await f.service.read(f.config, 'nested/../review.md');
  assert.equal(result.content, '리뷰 내용\n');
});

test('SSH file reads accept configured path aliases, canonical absolute paths and home-relative paths inside the root',async t=>{
  const f=await fixture(t),alias=path.join(path.dirname(f.root),'alias');await fs.symlink(f.root,alias);
  const aliased={...f.config,rootPath:alias};
  assert.equal((await f.service.read(aliased,path.join(alias,'review.md'))).content,'리뷰 내용\n');
  assert.equal((await f.service.read(aliased,path.join(await fs.realpath(f.root),'review.md'))).content,'리뷰 내용\n');
  assert.equal((await f.service.read(f.config,'~/'+path.basename(f.root)+'/review.md')).content,'리뷰 내용\n');
  await assert.rejects(f.service.read(f.config,'~/outside.txt'),{code:'SSH_PATH_OUTSIDE_ROOT'});
  const binary=await f.service.read(f.config,'raw.bin',{allowBinary:true});assert.equal(binary.mimeType,'application/octet-stream');assert.equal(binary.size,3);assert.equal(binary.content,undefined);assert.equal(binary.bytes,undefined);
});

test('SSH rejects oversized files, unsupported binaries, directories, and excessive directory entries', async t => {
  const f = await fixture(t, { maxFileBytes: 128, maxDirectoryEntries: 2 });
  await assert.rejects(f.service.read(f.config, 'large.txt'), { code: 'SSH_FILE_TOO_LARGE' });
  await assert.rejects(f.service.read(f.config, 'raw.bin'), { code: 'SSH_BINARY_FILE' });
  const binary=await f.service.read(f.config,'raw.bin',{raw:true});assert.deepEqual(binary.bytes,Buffer.from([0,255,10]));assert.equal(binary.size,3);
  await assert.rejects(f.service.read(f.config,'outside-link',{raw:true}),{code:'SSH_PATH_OUTSIDE_ROOT'});
  await assert.rejects(f.service.read(f.config, 'nested'), { code: 'SSH_NOT_FILE' });
  await assert.rejects(f.service.list(f.config), { code: 'SSH_DIRECTORY_TOO_LARGE' });
  await assert.rejects(f.service.read(f.config, 'missing.txt'), { code: 'SSH_FILE_NOT_FOUND' });
});

test('SSH runs only a supplied command, quotes the root, and separates output and exit status', async t => {
  const f = await fixture(t);
  await f.service.test(f.config);
  await f.service.list(f.config);
  assert.equal(f.commands.length, 0);
  const result = await f.service.run(f.config, 'explicit-command');
  assert.equal(result.stdout, 'stdout content');
  assert.equal(result.stderr, 'stderr content');
  assert.equal(result.code, 7);
  const canonical = await fs.realpath(f.root);
  assert.equal(f.commands[0], `cd '${canonical.replace(/'/g, `'"'"'`)}' || exit $?\nexplicit-command`);
  await assert.rejects(f.service.run(f.config, ''), { code: 'SSH_COMMAND_INVALID' });
  assert.equal(f.commands.length, 1);
});

test('SSH limits combined command output and times out a stalled command', async t => {
  const f = await fixture(t, { maxOutputBytes: 64, commandTimeoutMs: 1000 });
  await assert.rejects(f.service.run(f.config, 'large-output'), { code: 'SSH_OUTPUT_TOO_LARGE' });
  await assert.rejects(f.service.run(f.config, 'hang'), { code: 'SSH_TIMEOUT' });
  assert.equal(f.commands.length, 2);
});

test('SSH rejects invalid settings and authentication without leaking the password', async t => {
  const f = await fixture(t);
  assert.throws(() => validateConfig({ ...f.config, port: 0 }), { code: 'SSH_CONFIG_INVALID' });
  assert.throws(() => validateConfig({ ...f.config, rootPath: 'relative' }), { code: 'SSH_CONFIG_INVALID' });
  await assert.rejects(f.service.test({ ...f.config, password: 'wrong-password' }), error => {
    assert.equal(error.code, 'SSH_AUTH_FAILED');
    assert.equal(error.message.includes('wrong-password'), false);
    return true;
  });
});

test('SSH authenticates with a private key and rejects unreadable key paths', async t => {
  const f = await fixture(t);
  const keyConfig = { ...f.config, authType: 'key', password: undefined, privateKeyPath: f.privateKeyPath };
  assert.equal((await f.service.test(keyConfig)).ok, true);
  await assert.rejects(f.service.test({ ...keyConfig, privateKeyPath: 'relative-key' }), { code: 'SSH_KEY_INVALID' });
  await assert.rejects(f.service.test({ ...keyConfig, privateKeyPath: '/nonexistent/reviewops-key' }), { code: 'SSH_KEY_INVALID' });
});
