'use strict';

// Run on macOS before development/package use. No network or private vault calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
if (process.platform !== 'darwin') throw new Error('The native identity build requires macOS. Windows uses built-in DPAPI.');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--headers')) throw new Error('Usage: node scripts/build-remote-identity.cjs [--headers /absolute/include/node]');
const candidates = args.length ? [args[1]] : [
  path.resolve(path.dirname(process.execPath), '../include/node'),
  path.join(os.homedir(), 'Library/Caches/node-gyp', process.versions.node, 'include/node')
];
const headers = candidates.find(candidate => path.isAbsolute(candidate) && fs.existsSync(path.join(candidate, 'node_api.h')));
if (!headers) throw new Error('Node N-API headers are required locally; pass --headers /absolute/include/node. No download was attempted.');
const directory = path.resolve(__dirname, '../electron/native');
const temporary = fs.mkdtempSync(path.join(directory, '.identity-build-'));
const files = {};
try {
  for (const arch of ['arm64', 'x64']) {
    const file = `remote-identity-darwin-${arch}.node`, output = path.join(temporary, file);
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang++',
      '-std=c++17', '-fobjc-arc', '-fexceptions', '-fobjc-exceptions', '-fobjc-arc-exceptions',
      '-DNAPI_VERSION=8', '-fvisibility=hidden', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
      '-mmacosx-version-min=13.0', '-arch', arch === 'x64' ? 'x86_64' : arch,
      '-I', headers, '-bundle', '-undefined', 'dynamic_lookup', path.join(directory, 'remote-identity-darwin.mm'),
      '-framework', 'Security', '-framework', 'CoreFoundation', '-framework', 'Foundation', '-o', output
    ], {stdio: 'inherit'});
    // Manifest covers the final signed addon. electron-builder must signIgnore
    // these addons; the enclosing application still seals them as resources.
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], {stdio: 'inherit'});
    const content = fs.readFileSync(output);
    files[arch] = {file, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex')};
  }
  // Publish manifest last. A concurrent load during a rebuild refuses mismatches.
  for (const entry of Object.values(files)) fs.renameSync(path.join(temporary, entry.file), path.join(directory, entry.file));
  const manifest = path.join(temporary, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({schema: 1, files}) + '\n', {mode: 0o644});
  fs.renameSync(manifest, path.join(directory, 'remote-identity-manifest.json'));
  console.log('Built signed N-API 8 identity addons for macOS arm64 and x64.');
} finally { fs.rmSync(temporary, {recursive: true, force: true}); }
