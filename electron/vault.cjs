'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

const ENCRYPTED_PREFIX = 'reviewops-aes256gcm-v1:';
const SECRET_FIELDS = ['password', 'passphrase'];

function credentialError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createVault(file) {
  const directory = path.dirname(file);
  const keyFile = `${file}.key`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  let values = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);

  function key(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('서비스 식별자가 올바르지 않습니다.');
    return id;
  }
  function readEncryptionKey(create = false) {
    if (create && !fs.existsSync(keyFile)) {
      const temporary = `${keyFile}.${crypto.randomUUID()}.tmp`;
      try {
        atomicWrite(temporary, crypto.randomBytes(32));
        // Linking publishes a complete key without replacing a key created by another process.
        try { fs.linkSync(temporary, keyFile); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    let bytes;
    try {
      const descriptor = fs.openSync(keyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid key file');
        fs.fchmodSync(descriptor, 0o600);
        bytes = fs.readFileSync(descriptor);
      } finally { fs.closeSync(descriptor); }
    } catch {
      throw credentialError('CREDENTIALS_REENTRY_REQUIRED', '저장된 SSH 인증 정보를 읽을 수 없습니다. 호스트관리에서 SSH 접속을 설정한 뒤 프로젝트의 SSH 호스트를 선택하십시오.');
    }
    if (bytes.length !== 32) throw credentialError('CREDENTIALS_KEY_INVALID', '내부 인증 정보 저장 파일이 손상되었습니다. 앱 데이터 폴더의 credentials.json.key 파일을 복구하십시오.');
    return bytes;
  }
  function encrypted(value) { return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX); }
  function encrypt(field, value, encryptionKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${ENCRYPTED_PREFIX}${field}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ENCRYPTED_PREFIX + [iv, cipher.getAuthTag(), ciphertext].map(bytes => bytes.toString('base64')).join(':');
  }
  function decrypt(field, value, encryptionKey) {
    try {
      const parts = value.slice(ENCRYPTED_PREFIX.length).split(':');
      if (parts.length !== 3 || parts.some(part => !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part))) throw new Error('Invalid encrypted value');
      const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64'));
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('Invalid encrypted value');
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
      decipher.setAAD(Buffer.from(`${ENCRYPTED_PREFIX}${field}`));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw credentialError('CREDENTIALS_READ_FAILED', '저장된 SSH 인증 정보가 손상되어 읽을 수 없습니다. 호스트관리에서 SSH 접속을 설정한 뒤 프로젝트의 SSH 호스트를 선택하십시오.');
    }
  }
  function prepare(secret) {
    const prepared = {};
    let encryptionKey;
    for (const field of SECRET_FIELDS) {
      if (!(field in secret)) continue;
      if (typeof secret[field] !== 'string' || secret[field].length > 32768) throw new Error('인증 정보가 올바르지 않습니다.');
      // An empty input keeps an existing secret; clearing requires an explicit flag.
      if (secret[field] === '') continue;
      encryptionKey ||= readEncryptionKey(true);
      prepared[field] = encrypt(field, secret[field], encryptionKey);
    }
    for (const field of SECRET_FIELDS) if (secret[`clear${field[0].toUpperCase()}${field.slice(1)}`] === true) prepared[field] = null;
    return prepared;
  }
  function commit(id, prepared) {
    key(id);
    const record = { ...(values[id] || {}) };
    for (const [field, value] of Object.entries(prepared)) {
      if (!SECRET_FIELDS.includes(field) || (value !== null && !encrypted(value))) throw new Error('인증 정보가 올바르지 않습니다.');
      value === null ? delete record[field] : record[field] = value;
    }
    const next = { ...values, [id]: record };
    atomicWrite(file, JSON.stringify(next)); values = next;
  }
  return {
    prepare, commit,
    checkpoint() { return JSON.stringify(values); },
    restore(checkpoint) {
      if (JSON.stringify(values) === checkpoint) return;
      const restored = JSON.parse(checkpoint);
      atomicWrite(file, checkpoint); values = restored;
    },
    get(id, fields = SECRET_FIELDS) {
      key(id);
      const result = {};
      let encryptionKey;
      for (const field of fields) {
        if (!SECRET_FIELDS.includes(field)) throw new Error('인증 정보가 올바르지 않습니다.');
        const value = values[id]?.[field];
        if (value === undefined) continue;
        if (!encrypted(value)) {
          const label = field === 'password' ? 'SSH 비밀번호' : 'SSH 키 암호';
          throw credentialError('CREDENTIALS_REENTRY_REQUIRED', `이전에 저장한 ${label}는 다시 입력해야 합니다. 호스트관리에서 SSH 키를 등록한 뒤 프로젝트의 SSH 호스트를 선택하십시오. 기존 암호화 자료는 새 값을 저장하기 전까지 보존됩니다.`);
        }
        encryptionKey ||= readEncryptionKey();
        result[field] = decrypt(field, value, encryptionKey);
      }
      return result;
    },
    flags(id) { key(id); return { hasPassword: encrypted(values[id]?.password) && fs.existsSync(keyFile), hasPassphrase: encrypted(values[id]?.passphrase) && fs.existsSync(keyFile) }; },
    delete(id) { key(id); const next = { ...values }; delete next[id]; atomicWrite(file, JSON.stringify(next)); values = next; },
    clear() { atomicWrite(file, '{}'); values = {}; }
  };
}
module.exports = { createVault, atomicWrite };
