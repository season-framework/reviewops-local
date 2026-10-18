import {setTestLocale} from './test-locale.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const root = process.cwd();
const testRoot = fs.mkdtempSync(path.join('/tmp', 'reviewops-e2e-ssh-'));
const remoteRoot = path.join(testRoot, 'remote-files');
const resultRoot = path.join(root, 'test-results');
const homePath=path.join(testRoot,'home'),sshConfig=path.join(homePath,'.ssh','config');
fs.mkdirSync(path.dirname(sshConfig),{recursive:true,mode:0o700});fs.writeFileSync(sshConfig,'# Isolated synthetic SSH configuration\n',{mode:0o600});
fs.mkdirSync(remoteRoot);
fs.writeFileSync(path.join(remoteRoot,'연결 메모.txt'),'프로젝트 SSH 호스트 파일 읽기 검사\n');
fs.mkdirSync(resultRoot, { recursive: true });

function makeKey() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
}
const originalHostKey = makeKey();
const replacementHostKey = makeKey();
const userKey = makeKey();
const userPublicKey = utils.parseKey(userKey);
const fingerprint = key => `SHA256:${crypto.createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const expectedFingerprint = fingerprint(originalHostKey);
const keyPath = path.join(testRoot, 'test-identity.pem');
fs.writeFileSync(keyPath, userKey, { mode: 0o600 });

let app;
let page;
let server;
let authenticationCount = 0;
let commandCount = 0;
let shellCount = 0;
const shellInputs = [];
const terminalSizes = [];
const connections = new Set();
const failures = [];
const externalRequests = [];

async function startServer(hostKey, port = 0) {
  server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client);
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    client.on('authentication', context => {
      authenticationCount += 1;
      const accepted = context.method === 'publickey' && context.username === 'reviewops-test'
        && context.key.data.equals(userPublicKey.getPublicSSH())
        && (!context.signature || userPublicKey.verify(context.blob, context.signature, context.hashAlgo) === true);
      if (accepted) context.accept();
      else context.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (_acceptExec, reject) => { commandCount += 1; reject(); });
      session.on('pty', (accept, reject, info) => { terminalSizes.push({cols:info.cols,rows:info.rows});accept(); });
      session.on('window-change', (accept, reject, info) => { terminalSizes.push({cols:info.cols,rows:info.rows});accept?.(); });
      session.on('shell', acceptShell => {
        shellCount += 1;
        const stream = acceptShell();
        let line = '';
        stream.on('error', () => {});
        stream.write('\x1b[36mReviewOps SSH terminal\x1b[0m\r\n$ ');
        stream.on('data', chunk => {
          const data = chunk.toString();shellInputs.push(data);
          for (const character of data) {
            if (character === '\r') {
              stream.write('\r\n');
              if (line === 'echo hello') stream.write('hello\r\n');
              if (line === 'pwd') stream.write(remoteRoot + '\r\n');
              if (line === 'exit') { stream.exit(0); stream.end(); return; }
              line = '';stream.write('$ ');
            } else if (character === '\x03') { line = '';stream.write('^C\r\n$ '); }
            else { line += character;stream.write(character); }
          }
        });
      });
      session.on('sftp', acceptSftp => {
        const sftp = acceptSftp(), handles=new Map();let nextHandle=0;
        sftp.on('OPEN',(id,requested)=>{try{const descriptor=fs.openSync(requested,'r'),key=String(++nextHandle);handles.set(key,descriptor);sftp.handle(id,Buffer.from(key));}catch(error){sftp.status(id,2,error.message);}});
        sftp.on('READ',(id,key,offset,length)=>{try{const bytes=Buffer.alloc(length),count=fs.readSync(handles.get(key.toString()),bytes,0,length,offset);if(count)sftp.data(id,bytes.subarray(0,count));else sftp.status(id,1);}catch(error){sftp.status(id,4,error.message);}});
        sftp.on('CLOSE',(id,key)=>{try{fs.closeSync(handles.get(key.toString()));handles.delete(key.toString());sftp.status(id,0);}catch(error){sftp.status(id,4,error.message);}});
        sftp.on('close',()=>{for(const descriptor of handles.values())try{fs.closeSync(descriptor);}catch{}handles.clear();});
        sftp.on('REALPATH', (id, requested) => {
          try {
            const canonical = fs.realpathSync(requested);
            sftp.name(id, [{ filename: canonical, longname: canonical, attrs: {} }]);
          } catch (error) { sftp.status(id, 2, error.message); }
        });
        sftp.on('STAT', (id, requested) => {
          try {
            const info = fs.statSync(requested);
            sftp.attrs(id, { mode: info.mode, uid: info.uid, gid: info.gid, size: info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) });
          } catch (error) { sftp.status(id, 2, error.message); }
        });
      });
    }));
  });
  server.on('error', error => failures.push(`SSH server: ${error.message}`));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function stopServer() {
  if (!server) return;
  for (const connection of connections) connection.end();
  await new Promise(resolve => server.close(resolve));
  server = undefined;
}

async function launch() {
  const env = { ...process.env, HOME:homePath, CODEX_HOME:path.join(homePath,'.codex'), REVIEWOPS_DATA_DIR: path.join(testRoot, 'data'), REVIEWOPS_CODEX_SSH_CONFIG:sshConfig };
  delete env.SSH_AUTH_SOCK;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root],
    executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE,
    env,
    timeout: 30000,
  });
  page = await app.firstWindow(); await setTestLocale(page);
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.waitForFunction(() => !!window.reviewops?.request);
  await expect(page.getByRole('heading', { name: '홈', exact: true })).toBeVisible();
}

const pane=()=>page.locator('.workspace-pane:not([hidden])');
let project;
async function openProjectSettings() {
  await page.locator('.main-nav').getByRole('button', { name: '홈', exact: true }).click();
  await page.locator('.workspace-refresh').click();
  await page.getByRole('button',{name:`${project.name} 프로젝트 열기`,exact:true}).click();
  await pane().getByRole('navigation',{name:'프로젝트 기능',exact:true}).getByRole('button',{name:'설정',exact:true}).click();
  await pane().getByRole('tablist',{name:'프로젝트 설정 항목',exact:true}).getByRole('tab',{name:'연결',exact:true}).click();
}
const savedProject=async()=>((await invoke('snapshot')).projects.find(row=>row.id===project.id));

const request = (action, payload = {}) => page.evaluate(({ action, payload }) => window.reviewops.request(action, payload), { action, payload });
async function invoke(action, payload = {}) {
  const result = await request(action, payload);
  assert.equal(result.ok, true, `${action}: ${result.error?.message || 'IPC failed'}`);
  return result.data;
}

try {
  const port = await startServer(originalHostKey);
  await launch();
  const group = await invoke('group.save', { name: 'SSH 연결 검증' });
  // Keep direct SSH as a migrated connection to retain fingerprint-approval coverage.
  // New host-alias registration is covered by the project-connection and OpenSSH suites.
  const legacy=await invoke('service.save',{name:'기존 SSH 연결',groupId:group.id,kind:'ssh',host:'127.0.0.1',port,username:'reviewops-test',authType:'key',privateKeyPath:keyPath,rootPath:remoteRoot});
  project=await invoke('project.save',{name:'테스트 SSH 프로젝트',groupId:group.id,serviceIds:[legacy.id]});
  assert.equal(project.connection.id,legacy.id);
  assert.equal(authenticationCount, 0, 'Project seed must not connect automatically.');
  let service=project.connection;

  const firstUse = await request('ssh.test', { serviceId: service.id });
  assert.equal(firstUse.ok, false);
  assert.equal(firstUse.error.code, 'SSH_TRUST_REQUIRED');
  assert.equal(firstUse.error.fingerprint, expectedFingerprint);
  assert.equal(firstUse.error.host, '127.0.0.1');
  assert.equal(authenticationCount, 0, 'An untrusted host must not receive authentication.');
  console.log('PASS: contextBridge를 통한 SSH 최초 연결 오류 코드·지문 보존');

  await page.reload();
  await expect(page.getByRole('heading', { name: '홈', exact: true })).toBeVisible();
  await openProjectSettings();
  const form = pane().locator('.original-project-settings');
  await form.getByRole('button', { name: '연결 검사', exact: true }).click();
  const trust = page.getByRole('dialog', { name: 'SSH 호스트 확인', exact: true });
  await expect(trust).toBeVisible({ timeout: 10000 });
  await expect(trust.getByText(expectedFingerprint, { exact: true })).toBeVisible();
  assert.equal(authenticationCount, 0);
  await page.screenshot({ path: path.join(resultRoot, 'e2e-ssh-trust.png'), fullPage: true });
  await trust.getByRole('button', { name: '이 호스트 신뢰', exact: true }).click();
  await expect(trust).toHaveCount(0);
  await expect(form.locator('.connection-ok')).toContainText('연결 완료', { timeout: 10000 });
  assert.ok(authenticationCount > 0);
  assert.equal((await invoke('snapshot')).projects.find(item=>item.id===project.id).connection.hostFingerprint, expectedFingerprint);
  assert.equal(commandCount, 0, 'Connection tests must never execute shell commands.');
  console.log('PASS: 프로젝트 연결 검사 → 지문 표시 → 사용자 승인 → SSH 연결 완료');
  await page.screenshot({ path: path.join(resultRoot, 'e2e-ssh-connected.png'), fullPage: true });

  await form.getByRole('tab',{name:'프로젝트 정보',exact:true}).click();
  await form.getByLabel('기록용 메모',{exact:true}).fill('SSH 터미널 확인');
  await form.getByRole('button',{name:'저장하기',exact:true}).click();
  await expect.poll(async()=>((await savedProject()).memo)).toBe('SSH 터미널 확인');
  assert.equal((await invoke('snapshot')).projects.find(item=>item.id===project.id).connection.hostFingerprint,expectedFingerprint,'Saving settings preserves host trust.');
  service=(await savedProject()).connection;
  await page.locator('.original-project-nav:visible').getByRole('button',{name:'터미널',exact:true}).click();
  const terminal=page.getByRole('region',{name:'SSH 터미널',exact:true});
  assert.equal(shellCount,0,'Opening the terminal view must not connect automatically.');
  await terminal.getByRole('button',{name:'연결',exact:true}).click();
  await expect(terminal.getByText('연결됨',{exact:true})).toBeVisible();
  await expect.poll(()=>shellCount).toBe(1);
  const keyboard=terminal.locator('.xterm-helper-textarea');
  await keyboard.pressSequentially('echo hello',{delay:15});await keyboard.press('Enter');
  await expect.poll(()=>shellInputs.join('')).toContain('echo hello\r');
  await keyboard.pressSequentially('pwd',{delay:15});await keyboard.press('Enter');
  await expect.poll(()=>shellInputs.join('')).toContain('pwd\r');
  await keyboard.press('Control+c');
  await expect.poll(()=>shellInputs.join('')).toContain('\x03');
  await expect(terminal.locator('.xterm-rows')).toContainText('hello');
  await expect(terminal.locator('.xterm-rows')).toContainText('^C');
  const oldSizeCount=terminalSizes.length;
  await page.locator('.original-project:visible').getByRole('separator',{name:'작업 영역 너비'}).press('ArrowLeft');
  await expect.poll(()=>terminalSizes.length).toBeGreaterThan(oldSizeCount);
  await page.screenshot({path:path.join(resultRoot,'e2e-ssh-terminal.png'),fullPage:true});
  await page.locator('.original-project-nav:visible').getByRole('button',{name:'설정',exact:true}).click();
  await page.locator('.original-project-nav:visible').getByRole('button',{name:'터미널',exact:true}).click();
  await expect(terminal.getByText('연결됨',{exact:true})).toBeVisible();
  assert.equal(shellCount,1,'Switching features retains the same terminal session.');
  await terminal.getByRole('button',{name:'종료',exact:true}).click();
  await expect(terminal.getByText('연결 안 됨',{exact:true})).toBeVisible();
  console.log('PASS: 실시간 SSH PTY 입력·출력·Ctrl+C·크기 변경·탭 유지·종료');

  await app.close();
  app = undefined;
  await launch();
  const remembered = await invoke('ssh.test', { serviceId: service.id });
  assert.equal(remembered.fingerprint, expectedFingerprint);
  console.log('PASS: 앱 재실행 후 승인한 SSH 서버 키 유지');

  await stopServer();
  await startServer(replacementHostKey, port);
  const beforeChangedKey = authenticationCount;
  const changed = await request('ssh.test', { serviceId: service.id });
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'SSH_HOST_KEY_CHANGED');
  assert.equal(changed.error.fingerprint, fingerprint(replacementHostKey));
  assert.equal(authenticationCount, beforeChangedKey);
  await openProjectSettings();
  const changedForm = pane().locator('.original-project-settings');
  await changedForm.getByRole('button', { name: '연결 검사', exact: true }).click();
  await expect(changedForm.locator('.original-connection-test .form-error')).toContainText('서버 키가 저장된 키와 다릅니다', { timeout: 10000 });
  await expect(page.getByRole('dialog', { name: 'SSH 호스트 확인', exact: true })).toHaveCount(0);
  assert.equal((await invoke('snapshot')).projects.find(item=>item.id===project.id).connection.hostFingerprint, expectedFingerprint);
  assert.equal(authenticationCount, beforeChangedKey);
  assert.equal(commandCount, 0);
  // Exercise the new project/host selection through Electron and OpenSSH as well.
  const knownHosts=path.join(homePath,'.ssh','known_hosts');
  fs.writeFileSync(knownHosts,`[127.0.0.1]:${port} ssh-rsa ${utils.parseKey(replacementHostKey).getPublicSSH().toString('base64')}\n`,{mode:0o600});
  fs.writeFileSync(sshConfig,`Host reviewops-fixture\n  HostName 127.0.0.1\n  Port ${port}\n  User reviewops-test\n  IdentityFile ${keyPath}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${knownHosts}\n  GlobalKnownHostsFile /dev/null\n`,{mode:0o600});
  const hosts=await page.evaluate(()=>window.hostManager.reloadHosts());assert.equal(hosts.hosts[0].alias,'reviewops-fixture');
  const aliasProject=await invoke('project.save',{name:'SSH 호스트 선택 검사',groupId:group.id,connection:{kind:'ssh',hostAlias:'reviewops-fixture',rootPath:remoteRoot}});
  assert.equal(aliasProject.connection.hostAlias,'reviewops-fixture');
  assert.equal((await invoke('ssh.test',{projectId:aliasProject.id})).ok,true);
  const aliasFile=await invoke('files.read',{projectId:aliasProject.id,path:'연결 메모.txt'});
  assert.equal(aliasFile.content,'프로젝트 SSH 호스트 파일 읽기 검사\n');
  console.log('PASS: 프로젝트 hostAlias → 호스트 SSH 설정 → OpenSSH 연결·파일 읽기');
  assert.deepEqual(failures, []);
  assert.deepEqual(externalRequests, []);
  console.log('PASS: SSH 서버 키 변경 차단, 재승인 창과 인증 전송 없음');
  fs.writeFileSync(path.join(resultRoot, 'e2e-ssh-result.json'), JSON.stringify({
    passed: true,
    executable: process.env.REVIEWOPS_TEST_EXECUTABLE || 'development Electron',
    version: (await invoke('app.info')).version,
    firstUseCode: firstUse.error.code,
    changedKeyCode: changed.error.code,
    fingerprint: expectedFingerprint,
    authenticationCount,
    commandCount,
    shellCount,
    aliasProjectConnection:true,
    aliasFileRead:true,
    terminalSizes,
    shellInputVerified:shellInputs.join('').includes('echo hello\r'),
    failures,
    externalRequests,
    platform: process.platform,
    arch: process.arch,
  }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(resultRoot, 'e2e-ssh-failure.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(resultRoot, 'e2e-ssh-result.json'), JSON.stringify({ passed: false, message: error.message, failures, externalRequests }, null, 2));
  throw error;
} finally {
  if (app) { await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();}).catch(()=>{});await app.close().catch(() => {}); }
  await stopServer();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
