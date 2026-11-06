'use strict';

// Load only the remote entry and its built dependency closure from the app-owned directory.
const fs = require('node:fs');
const path = require('node:path');
const LIMITS = Object.freeze({manifestBytes: 256 * 1024, manifestRecords: 1024,
  files: 64, fileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024});
const MIME = Object.freeze({'.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2'});
const FIELDS = new Set(['file', 'src', 'name', 'isEntry', 'isDynamicEntry',
  'imports', 'dynamicImports', 'css', 'assets']);
function unavailable() {
  return Object.assign(new Error('The remote browser assets are unavailable.'), {code: 'REMOTE_WEB_ASSETS_UNAVAILABLE'});
}
function assert(value) { if (!value) throw unavailable(); }
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value));
}
function outputName(value) {
  return typeof value === 'string' && /^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:js|css|svg|png|woff2)$/.test(value);
}
function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size &&
    first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

function loadRemoteWebAssets(directory) {
  if (arguments.length !== 1 || typeof directory !== 'string' || !path.isAbsolute(directory)) throw unavailable();
  try {
    const root = path.resolve(directory), rootInfo = fs.lstatSync(root);
    assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
    assert(fs.realpathSync(root) === root);
    const read = (relative, maximum) => {
      const parts = relative.split('/');
      assert(parts.length > 0 && parts.every(part => part && part !== '.' && part !== '..' && !part.includes('\\')));
      let target = root;
      for (let index = 0; index < parts.length; index++) {
        target = path.join(target, parts[index]);
        const info = fs.lstatSync(target);
        assert(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() : info.isDirectory()));
      }
      assert(fs.realpathSync(target) === target);
      let descriptor, primary;
      try {
        descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const before = fs.fstatSync(descriptor);
        assert(before.isFile() && Number.isSafeInteger(before.size) && before.size > 0 && before.size <= maximum);
        assert(sameFile(before, fs.lstatSync(target)));
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const amount = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
          assert(amount > 0); offset += amount;
        }
        assert(fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) === 0);
        assert(sameFile(before, fs.fstatSync(descriptor)) && sameFile(before, fs.lstatSync(target)));
        assert(fs.realpathSync(target) === target);
        return bytes;
      } catch (error) { primary = error; throw error; }
      finally {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); }
          catch (cleanup) { throw primary ? new AggregateError([primary, cleanup], 'Asset descriptor cleanup failed.', {cause: primary}) : cleanup; }
        }
      }
    };

    const manifestBytes = read('.vite/manifest.json', LIMITS.manifestBytes);
    const manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(manifestBytes));
    assert(record(manifest) && Object.keys(manifest).length <= LIMITS.manifestRecords && Object.hasOwn(manifest, 'remote.html'));
    const assets = Object.create(null), files = new Set(), visited = new Set(); let total = 0;
    const add = (file, route, mimeType) => {
      if (files.has(file)) return;
      assert(files.size < LIMITS.files && !Object.hasOwn(assets, route));
      const bytes = read(file, Math.min(LIMITS.fileBytes, LIMITS.totalBytes - total));
      total += bytes.length; assert(total <= LIMITS.totalBytes);
      files.add(file); assets[route] = Object.freeze({bytes, mimeType});
    };
    const addAsset = file => {
      assert(outputName(file));
      const mimeType = MIME[path.extname(file)]; assert(mimeType);
      add(file, '/' + file, mimeType);
    };
    const walk = key => {
      assert(typeof key === 'string' && key.length > 0 && key.length <= 512 && Object.hasOwn(manifest, key));
      if (visited.has(key)) return;
      assert(visited.size < LIMITS.files); visited.add(key);
      const row = manifest[key];
      assert(record(row) && Object.keys(row).every(field => FIELDS.has(field)) && outputName(row.file));
      if (key === 'remote.html') assert(row.isEntry === true && row.src === 'remote.html' && row.file.endsWith('.js'));
      else assert(row.isEntry !== true && (row.src === undefined || typeof row.src === 'string' &&
        /^src\/remote\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jsx?|mjs|css)$/.test(row.src)));
      for (const flag of ['isEntry', 'isDynamicEntry']) assert(row[flag] === undefined || typeof row[flag] === 'boolean');
      assert(row.name === undefined || typeof row.name === 'string' && row.name.length <= 512);
      addAsset(row.file);
      for (const field of ['css', 'assets', 'imports', 'dynamicImports']) {
        const values = row[field];
        assert(values === undefined || Array.isArray(values) && values.length <= LIMITS.files && new Set(values).size === values.length);
        for (const value of values || []) {
          if (field === 'imports' || field === 'dynamicImports') walk(value);
          else { if (field === 'css') assert(typeof value === 'string' && value.endsWith('.css')); addAsset(value); }
        }
      }
    };
    add('remote.html', '/', 'text/html; charset=utf-8');
    walk('remote.html');
    assert(sameFile(rootInfo, fs.lstatSync(root)) && fs.realpathSync(root) === root);
    return Object.freeze(assets);
  } catch { throw unavailable(); }
}

module.exports = {loadRemoteWebAssets};
