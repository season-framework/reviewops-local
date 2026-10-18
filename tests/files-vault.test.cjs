'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {listLocal,readLocal}=require('../electron/files.cjs');
const {createVault}=require('../electron/vault.cjs');

test('로컬 서비스 폴더 조회, 텍스트 미리보기, 상위 경로와 심볼릭 링크 차단',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-files-'));
  try {
    const root=path.join(temp,'root'); fs.mkdirSync(root); fs.mkdirSync(path.join(root,'하위 폴더'));
    fs.writeFileSync(path.join(root,'테스트.txt'),'로컬 리뷰 자료');
    fs.writeFileSync(path.join(temp,'private.txt'),'private');
    fs.symlinkSync(path.join(temp,'private.txt'),path.join(root,'link.txt'));
    const list=await listLocal({rootPath:root});
    assert.equal(list.entries[0].name,'하위 폴더');
    assert.equal((await readLocal({rootPath:root},'테스트.txt')).content,'로컬 리뷰 자료');
    await assert.rejects(readLocal({rootPath:root},'../private.txt'),/폴더 밖/);
    await assert.rejects(readLocal({rootPath:root},'link.txt'),/폴더 밖/);
    await assert.rejects(readLocal({rootPath:root},'/etc/passwd'),/폴더 밖/);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});

test('로컬 파일의 짧은 읽기를 이어서 처리하고 파일 전체를 표시',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-file-chunks-'));
  const open=fs.promises.open.bind(fs.promises);
  try {
    const content='짧은 읽기에서도 파일 전체를 읽습니다.\n'.repeat(100);
    fs.writeFileSync(path.join(temp,'review.txt'),content);
    t.mock.method(fs.promises,'open',async(...args)=>{
      const file=await open(...args),read=file.read.bind(file);
      file.read=(buffer,offset,length,position)=>read(buffer,offset,Math.min(length,7),position);
      return file;
    });
    const result=await readLocal({rootPath:temp},'review.txt');
    assert.equal(result.content,content);
    assert.equal(result.size,Buffer.byteLength(content));
  } finally {t.mock.restoreAll();fs.rmSync(temp,{recursive:true,force:true});}
});

test('로컬 FIFO와 파일 열기 직전 바뀐 FIFO는 대기하지 않고 거부',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-file-fifo-'));
  const open=fs.promises.open.bind(fs.promises);
  try {
    execFileSync('/usr/bin/mkfifo',[path.join(temp,'pipe')]);
    await assert.rejects(readLocal({rootPath:temp},'pipe'),/일반 파일/);
    const filePath=path.join(temp,'review.txt');fs.writeFileSync(filePath,'review');
    t.mock.method(fs.promises,'open',async(...args)=>{
      fs.unlinkSync(filePath);execFileSync('/usr/bin/mkfifo',[filePath]);
      return open(...args);
    });
    await assert.rejects(readLocal({rootPath:temp},'review.txt'),/일반 파일/);
  } finally {t.mock.restoreAll();fs.rmSync(temp,{recursive:true,force:true});}
});

test('로컬 파일을 여는 동안 바뀐 외부 링크와 상위 폴더 링크를 거부',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reviewops-file-race-'));
  const open=fs.promises.open.bind(fs.promises);
  try {
    const root=path.join(temp,'root'),outside=path.join(temp,'outside');
    fs.mkdirSync(root);fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root,'review.txt'),'review');
    fs.writeFileSync(path.join(outside,'review.txt'),'private');
    t.mock.method(fs.promises,'open',async(...args)=>{
      fs.unlinkSync(path.join(root,'review.txt'));
      fs.symlinkSync(path.join(outside,'review.txt'),path.join(root,'review.txt'));
      return open(...args);
    });
    await assert.rejects(readLocal({rootPath:root},'review.txt'),/폴더 밖/);
    t.mock.restoreAll();
    const nested=path.join(root,'nested');fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'review.txt'),'review');
    t.mock.method(fs.promises,'open',async(...args)=>{
      fs.renameSync(nested,path.join(root,'original'));
      fs.symlinkSync(outside,nested);
      return open(...args);
    });
    await assert.rejects(readLocal({rootPath:root},'nested/review.txt'),/파일 경로가 변경/);
  } finally {t.mock.restoreAll();fs.rmSync(temp,{recursive:true,force:true});}
});

const unusedKeychain = new Proxy({}, { get() { throw new Error('Keychain must never be accessed'); } });
function vaultFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.json');
  return { directory, file, keyFile: `${file}.key`, vault: createVault(file, unusedKeychain) };
}

test('내부 암호화 저장소는 키체인 없이 저장하고 재실행 후 같은 값을 읽음', t => {
  const { directory, file, keyFile, vault } = vaultFixture(t);
  vault.commit('service-1', vault.prepare({ password: 'not-plaintext', passphrase: 'key-secret' }));
  const serialized = fs.readFileSync(file, 'utf8');
  assert.equal(serialized.includes('not-plaintext'), false);
  assert.equal(serialized.includes('key-secret'), false);
  assert.match(JSON.parse(serialized)['service-1'].password, /^reviewops-aes256gcm-v1:/);
  assert.deepEqual(vault.flags('service-1'), { hasPassword: true, hasPassphrase: true });
  assert.deepEqual(createVault(file, unusedKeychain).get('service-1'), { password: 'not-plaintext', passphrase: 'key-secret' });
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(keyFile).length, 32);
  assert.equal(serialized.includes(fs.readFileSync(keyFile).toString('base64')), false);
});

test('빈 입력은 저장값을 유지하고 명시적 삭제만 인증 정보를 제거', t => {
  const { vault, keyFile } = vaultFixture(t);
  vault.commit('service-1', vault.prepare({ password: 'original', passphrase: 'key-secret' }));
  vault.commit('service-1', vault.prepare({ password: '', passphrase: '' }));
  assert.deepEqual(vault.get('service-1'), { password: 'original', passphrase: 'key-secret' });
  vault.commit('service-1', vault.prepare({ clearPassword: true }));
  assert.deepEqual(vault.flags('service-1'), { hasPassword: false, hasPassphrase: true });
  assert.deepEqual(vault.get('service-1'), { passphrase: 'key-secret' });
  vault.commit('service-1', vault.prepare({ clearPassphrase: true }));
  assert.deepEqual(vault.get('service-1'), {});
  assert.equal(fs.existsSync(keyFile), true);
});

test('같은 값을 다시 저장해도 암호문이 달라지며 암호문이나 필드가 변조되면 거부', t => {
  const { vault, file } = vaultFixture(t);
  vault.commit('service-1', vault.prepare({ password: 'same-value', passphrase: 'other-value' }));
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = vault.prepare({ password: 'same-value' });
  assert.notEqual(next.password, original['service-1'].password);
  const tampered = structuredClone(original);
  tampered['service-1'].password = tampered['service-1'].password.slice(0, -4) + 'AAAA';
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => createVault(file, unusedKeychain).get('service-1'), error => error.code === 'CREDENTIALS_READ_FAILED');
  original['service-1'].password = original['service-1'].passphrase;
  fs.writeFileSync(file, JSON.stringify(original));
  assert.throws(() => createVault(file, unusedKeychain).get('service-1'), error => error.code === 'CREDENTIALS_READ_FAILED');
});

test('키 파일 손실과 변조를 알리고 기존 암호문을 그대로 보존', t => {
  const { vault, file, keyFile } = vaultFixture(t);
  vault.commit('service-1', vault.prepare({ password: 'original' }));
  const saved = fs.readFileSync(file, 'utf8');
  const encryptionKey = fs.readFileSync(keyFile);
  fs.unlinkSync(keyFile);
  assert.deepEqual(vault.flags('service-1'), { hasPassword: false, hasPassphrase: false });
  assert.throws(() => vault.get('service-1'), error => error.code === 'CREDENTIALS_REENTRY_REQUIRED' && /호스트관리/.test(error.message));
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  fs.writeFileSync(keyFile, 'invalid');
  assert.throws(() => vault.get('service-1'), error => error.code === 'CREDENTIALS_KEY_INVALID');
  fs.writeFileSync(keyFile, encryptionKey);
  assert.equal(vault.get('service-1').password, 'original');
  fs.writeFileSync(keyFile, Buffer.alloc(32));
  assert.throws(() => vault.get('service-1'), error => error.code === 'CREDENTIALS_READ_FAILED');
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
});

test('키체인 형식의 기존 값은 읽지 않고 보존하며 필요한 항목만 다시 입력', t => {
  const { directory, file, keyFile } = vaultFixture(t);
  const original = JSON.stringify({ 'service-1': { password: 'legacy-encrypted-password', passphrase: 'legacy-encrypted-passphrase' } });
  fs.writeFileSync(file, original);
  fs.chmodSync(file, 0o644);
  fs.chmodSync(directory, 0o755);
  const vault = createVault(file, unusedKeychain);
  assert.deepEqual(vault.flags('service-1'), { hasPassword: false, hasPassphrase: false });
  assert.throws(() => vault.get('service-1', ['password']), error => error.code === 'CREDENTIALS_REENTRY_REQUIRED' && /호스트관리/.test(error.message) && /SSH 비밀번호/.test(error.message));
  assert.throws(() => vault.get('service-1', ['passphrase']), /SSH 키 암호/);
  assert.deepEqual(vault.get('service-1', []), {});
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(keyFile), false);
  vault.commit('service-1', vault.prepare({ password: 'replacement' }));
  assert.deepEqual(vault.get('service-1', ['password']), { password: 'replacement' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['service-1'].passphrase, 'legacy-encrypted-passphrase');
  assert.deepEqual(vault.flags('service-1'), { hasPassword: true, hasPassphrase: false });
  assert.throws(() => vault.get('service-1'), /SSH 키 암호/);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('인증 정보 변경을 되돌리면 기존 암호문과 재실행 후 읽기 결과를 복구', t => {
  const { vault, file, keyFile } = vaultFixture(t);
  vault.commit('service-1', vault.prepare({ password: 'original' }));
  const checkpoint = vault.checkpoint(), originalKey = fs.readFileSync(keyFile);
  vault.commit('service-1', vault.prepare({ password: 'changed', passphrase: 'added' }));
  vault.restore(checkpoint);
  assert.equal(fs.readFileSync(file, 'utf8'), checkpoint);
  assert.deepEqual(createVault(file, unusedKeychain).get('service-1'), { password: 'original' });
  assert.deepEqual(fs.readFileSync(keyFile), originalKey);
  vault.delete('service-1');
  assert.deepEqual(vault.get('service-1'), {});
  vault.restore(checkpoint);
  vault.clear();
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.deepEqual(vault.flags('service-1'), { hasPassword: false, hasPassphrase: false });
  vault.restore(checkpoint);
  assert.equal(vault.get('service-1').password, 'original');
});

test('첫 저장 이전으로 되돌려도 키를 유지하고 다음 저장을 정상 처리', t => {
  const { vault, file, keyFile } = vaultFixture(t);
  const checkpoint = vault.checkpoint();
  vault.commit('service-1', vault.prepare({ password: 'temporary' }));
  vault.restore(checkpoint);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.equal(fs.existsSync(keyFile), true);
  vault.commit('service-2', vault.prepare({ passphrase: 'new-key-secret' }));
  assert.deepEqual(createVault(file, unusedKeychain).get('service-2'), { passphrase: 'new-key-secret' });
});

test('인증 정보 저장 중 쓰기 실패 시 이전 파일과 메모리 값을 유지', t => {
  const { vault, file } = vaultFixture(t);
  vault.commit('service-1', vault.prepare({ password: 'original' }));
  const before = fs.readFileSync(file, 'utf8');
  const prepared = vault.prepare({ password: 'changed' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => { if (args[1] === file) throw new Error('Synthetic write failure'); return rename(...args); });
  assert.throws(() => vault.commit('service-1', prepared), /Synthetic write failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(vault.get('service-1'), { password: 'original' });
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')), false);
  t.mock.restoreAll();
});

test('기존 형식의 인증 정보는 명시적 삭제와 복구도 키체인 없이 처리', t => {
  const { file } = vaultFixture(t);
  fs.writeFileSync(file, JSON.stringify({ 'service-1': { password: 'legacy-encrypted-password' } }));
  const vault = createVault(file, unusedKeychain), checkpoint = vault.checkpoint();
  vault.commit('service-1', vault.prepare({ password: '' }));
  assert.equal(vault.checkpoint(), checkpoint);
  vault.commit('service-1', vault.prepare({ clearPassword: true }));
  assert.deepEqual(vault.get('service-1'), {});
  vault.restore(checkpoint);
  assert.equal(fs.readFileSync(file, 'utf8'), checkpoint);
  assert.throws(() => vault.get('service-1'), error => error.code === 'CREDENTIALS_REENTRY_REQUIRED');
});
