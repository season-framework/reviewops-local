'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MIME = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.jsx': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain', '.xml': 'text/plain', '.yaml': 'text/plain',
  '.yml': 'text/plain', '.log': 'text/plain', '.py': 'text/plain', '.java': 'text/plain', '.sh': 'text/plain',
  '.sql': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.ico': 'image/x-icon'
};
function mimeType(name) { return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream'; }
function relativePath(input = '') {
  if (typeof input !== 'string' || input.includes('\0') || input.includes('\\') || path.isAbsolute(input) || input.split('/').includes('..')) throw new Error('지정한 폴더 밖의 파일에는 접근할 수 없습니다.');
  return input.replace(/^\.\//, '');
}
function inside(root, target) { return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep); }
async function resolveLocal(rootPath, relative = '') {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) throw new Error('프로젝트의 로컬 폴더를 선택하십시오.');
  const root = await fs.realpath(rootPath);
  const target = await fs.realpath(path.resolve(root, relativePath(relative)));
  if (!inside(root, target)) throw new Error('지정한 폴더 밖의 파일에는 접근할 수 없습니다.');
  return { root, target };
}
function describeBytes(bytes, name, relative = '') {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('미리보기는 20 MB 이하 파일만 지원합니다.');
  const mime = mimeType(name), result = { path: relative, name, mimeType: mime, size: bytes.length };
  if (mime.startsWith('image/') || mime === 'application/pdf') result.dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  else if (mime.startsWith('text/') || mime === 'application/json' || !bytes.subarray(0, 8192).includes(0)) {
    result.content = bytes.toString('utf8');
    if (mime === 'application/octet-stream') result.mimeType = 'text/plain';
  }
  return result;
}
async function listLocal(service, relative = '') {
  const { target } = await resolveLocal(service.rootPath, relative);
  const names = await fs.readdir(target, { withFileTypes: true });
  if (names.length > 10000) throw new Error('파일이 10,000개를 초과합니다. 하위 폴더를 선택하십시오.');
  const entries = await Promise.all(names.map(async entry => {
    const stat = await fs.lstat(path.join(target, entry.name));
    return { name: entry.name, path: path.posix.join(relative, entry.name), type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file', size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }));
  entries.sort((a,b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
  return { path: relative, entries };
}
async function readLocal(service, relative, {raw=false}={}) {
  const { root, target } = await resolveLocal(service.rootPath, relative);
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('일반 파일만 열 수 있습니다.');
  if (before.size > MAX_FILE_BYTES) throw new Error('미리보기는 20 MB 이하 파일만 지원합니다.');
  // Nonblocking open also prevents a file replaced by a FIFO from stalling the app.
  let file;
  try { file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ELOOP') throw new Error('지정한 폴더 밖의 파일에는 접근할 수 없습니다.');
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('일반 파일만 열 수 있습니다.');
    if (stat.size > MAX_FILE_BYTES) throw new Error('미리보기는 20 MB 이하 파일만 지원합니다.');
    const canonical = await fs.realpath(target);
    const named = await fs.lstat(target);
    if (canonical !== target || !inside(root, canonical) || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw new Error('파일 경로가 변경되었습니다. 파일 목록을 다시 불러오십시오.');
    }
    const chunks = [];
    let size = 0;
    while (size <= MAX_FILE_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_FILE_BYTES) throw new Error('미리보기는 20 MB 이하 파일만 지원합니다.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes=Buffer.concat(chunks,size);
    return {...describeBytes(bytes, path.basename(target), relative),...(raw?{bytes}:{})};
  } finally { await file.close(); }
}
module.exports = { MAX_FILE_BYTES, mimeType, relativePath, inside, resolveLocal, describeBytes, listLocal, readLocal };
