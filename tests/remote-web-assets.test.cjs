'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadRemoteWebAssets} = require('../electron/remote-web-assets.cjs');
const supported = Number.isInteger(fs.constants.O_NOFOLLOW) && fs.constants.O_NOFOLLOW !== 0;
const options = {skip: !supported, concurrency: false};

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-web-assets-'));
  const directory = path.join(fs.realpathSync(temporary), 'dist');
  fs.mkdirSync(path.join(directory, '.vite'), {recursive: true});
  fs.mkdirSync(path.join(directory, 'assets'));
  const manifest = {
    'remote.html': {file: 'assets/remote-main.js', src: 'remote.html', isEntry: true,
      imports: ['_shared.js'], css: ['assets/remote-main.css']},
    '_shared.js': {file: 'assets/shared.js'},
    'index.html': {file: 'assets/desktop.js', src: 'index.html', isEntry: true}
  };
  const write = (name, bytes) => fs.writeFileSync(path.join(directory, name), bytes);
  write('remote.html', '<!doctype html><script type="module" src="./assets/remote-main.js"></script>');
  write('assets/remote-main.js', 'import "./shared.js";');
  write('assets/shared.js', 'export const publicValue = 1;');
  write('assets/remote-main.css', 'body{color:black}');
  write('assets/desktop.js', 'PRIVATE_DESKTOP_ENTRY');
  write('index.html', 'PRIVATE_DESKTOP_HTML');
  const save = () => write('.vite/manifest.json', JSON.stringify(manifest)); save();
  return {directory, manifest, write, save, close: () => fs.rmSync(temporary, {recursive: true, force: true})};
}
const refused = callback => assert.throws(callback, error => error.code === 'REMOTE_WEB_ASSETS_UNAVAILABLE' &&
  error.message === 'The remote browser assets are unavailable.');

test('asset loader returns only the fixed remote HTML and its explicit dependency closure', options, () => {
  const f = fixture();
  try {
    f.write('PRIVATE.txt', 'PRIVATE_EXTRA');
    const assets = loadRemoteWebAssets(f.directory);
    assert.equal(Object.getPrototypeOf(assets), null);
    assert.equal(Object.isFrozen(assets), true);
    assert.deepEqual(Object.keys(assets).sort(), ['/', '/assets/remote-main.css', '/assets/remote-main.js', '/assets/shared.js']);
    assert.equal(assets['/'].mimeType, 'text/html; charset=utf-8');
    assert.equal(assets['/assets/remote-main.js'].mimeType, 'application/javascript; charset=utf-8');
    assert.equal(assets['/assets/remote-main.css'].mimeType, 'text/css; charset=utf-8');
    assert.equal(Object.values(assets).some(row => row.bytes.includes('PRIVATE_')), false);
    assets['/assets/shared.js'].bytes.fill(0);
    assert.equal(loadRemoteWebAssets(f.directory)['/assets/shared.js'].bytes.toString(), 'export const publicValue = 1;');
  } finally { f.close(); }
});

test('asset loader follows finite dynamic dependencies and deduplicates shared files', options, () => {
  const f = fixture();
  try {
    f.manifest['remote.html'].dynamicImports = ['src/remote/detail.mjs'];
    f.manifest['src/remote/detail.mjs'] = {file: 'assets/detail.js', src: 'src/remote/detail.mjs',
      isDynamicEntry: true, imports: ['_shared.js'], assets: ['assets/mark.svg']};
    f.write('assets/detail.js', 'export const detail = true;'); f.write('assets/mark.svg', '<svg/>'); f.save();
    const assets = loadRemoteWebAssets(f.directory);
    assert.equal(Object.keys(assets).length, 6);
    assert.equal(assets['/assets/mark.svg'].mimeType, 'image/svg+xml');
    assert.equal(Object.hasOwn(assets, '/.vite/manifest.json'), false);
  } finally { f.close(); }
});

test('asset loader refuses desktop entry/source records and unknown or absent dependencies', options, () => {
  const f = fixture();
  try {
    const row = f.manifest['remote.html'];
    for (const key of ['index.html', 'missing']) { row.imports = [key]; f.save(); refused(() => loadRemoteWebAssets(f.directory)); }
    row.imports = ['_shared.js']; f.manifest['_shared.js'].src = 'src/App.jsx'; f.save(); refused(() => loadRemoteWebAssets(f.directory));
    f.manifest['_shared.js'].src = 'src/remote/../App.jsx'; f.save(); refused(() => loadRemoteWebAssets(f.directory));
    delete f.manifest['_shared.js'].src; f.manifest['_shared.js'].unknown = true; f.save(); refused(() => loadRemoteWebAssets(f.directory));
  } finally { f.close(); }
});

test('asset loader refuses output traversal, source routes, extra HTML and unsupported MIME', options, () => {
  const f = fixture();
  try {
    for (const value of ['../PRIVATE.txt', '/assets/shared.js', 'assets/../PRIVATE.txt', 'assets\\shared.js',
      'src/remote/main.jsx', 'index.html', 'assets/source.js.map', 'assets/empty.html']) {
      f.manifest['_shared.js'].file = value; f.save(); refused(() => loadRemoteWebAssets(f.directory));
    }
  } finally { f.close(); }
});

test('asset loader refuses symlinks for the root, manifest, output file and intermediate directory', options, () => {
  const f = fixture();
  try {
    const link = path.join(path.dirname(f.directory), 'linked'); fs.symlinkSync(f.directory, link, 'dir');
    refused(() => loadRemoteWebAssets(link)); fs.unlinkSync(link);
    for (const relative of ['.vite/manifest.json', 'assets/shared.js']) {
      const original = path.join(f.directory, relative), saved = original + '.saved';
      fs.renameSync(original, saved); fs.symlinkSync(saved, original);
      refused(() => loadRemoteWebAssets(f.directory)); fs.unlinkSync(original); fs.renameSync(saved, original);
    }
    fs.renameSync(path.join(f.directory, 'assets'), path.join(f.directory, 'saved-assets'));
    fs.symlinkSync(path.join(f.directory, 'saved-assets'), path.join(f.directory, 'assets'), 'dir');
    refused(() => loadRemoteWebAssets(f.directory));
  } finally { f.close(); }
});

test('asset loader bounds actual file sizes and complete closure count before returning any map', options, () => {
  const f = fixture();
  try {
    f.write('assets/shared.js', Buffer.alloc(4 * 1024 * 1024, 32));
    assert.equal(loadRemoteWebAssets(f.directory)['/assets/shared.js'].bytes.length, 4 * 1024 * 1024);
    f.write('assets/shared.js', Buffer.alloc(4 * 1024 * 1024 + 1, 32)); refused(() => loadRemoteWebAssets(f.directory));
    f.write('assets/shared.js', 'small');
    f.manifest['remote.html'].assets = Array.from({length: 61}, (_, index) => `assets/extra${index}.png`);
    for (const name of f.manifest['remote.html'].assets) f.write(name, 'x'); f.save();
    refused(() => loadRemoteWebAssets(f.directory));
  } finally { f.close(); }
});

test('asset loader bounds total bytes independently of every individual output file', options, () => {
  const f = fixture();
  try {
    f.manifest['remote.html'].assets = Array.from({length: 4}, (_, index) => `assets/large${index}.png`);
    for (const name of f.manifest['remote.html'].assets) f.write(name, Buffer.alloc(4 * 1024 * 1024, 32));
    f.save(); refused(() => loadRemoteWebAssets(f.directory));
  } finally { f.close(); }
});

test('asset loader closes every original descriptor after a short read and returns a fixed public failure', options, () => {
  const f = fixture(), originals = {open: fs.openSync, read: fs.readSync, close: fs.closeSync}, opened = new Set();
  try {
    fs.openSync = function (...args) { const fd = Reflect.apply(originals.open, this, args); opened.add(fd); return fd; };
    fs.closeSync = function (fd) { const result = Reflect.apply(originals.close, this, [fd]); opened.delete(fd); return result; };
    fs.readSync = function (fd, buffer, offset, length, position) { return position === 0 ? 0 : Reflect.apply(originals.read, this, [fd, buffer, offset, length, position]); };
    refused(() => loadRemoteWebAssets(f.directory)); assert.equal(opened.size, 0);
  } finally {
    fs.openSync = originals.open; fs.readSync = originals.read; fs.closeSync = originals.close;
    for (const fd of opened) originals.close(fd); f.close();
  }
});

test('asset loader rejects missing, malformed, oversized and wrong-entry manifests without fallback', options, () => {
  const f = fixture();
  try {
    for (const bytes of ['{', '[]', '{}', '{"remote.html":null}', ' '.repeat(256 * 1024 + 1)]) {
      f.write('.vite/manifest.json', bytes); refused(() => loadRemoteWebAssets(f.directory));
    }
    f.manifest['remote.html'].src = 'index.html'; f.save(); refused(() => loadRemoteWebAssets(f.directory));
    fs.unlinkSync(path.join(f.directory, '.vite/manifest.json')); refused(() => loadRemoteWebAssets(f.directory));
    for (const args of [[], [f.directory, {}], ['relative'], [null]]) refused(() => loadRemoteWebAssets(...args));
  } finally { f.close(); }
});
