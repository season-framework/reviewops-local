'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRuntimeFinder, platformTarget, defaultCandidates } = require('../electron/codex/runtime.cjs');

function macBinary(arch = 'arm64') {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  header.writeUInt32LE(2, 12);
  return header;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runtime-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, contents = macBinary(), mode = 0o700) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, { mode });
    return file;
  };
  return { root, write };
}

test('returns a validated direct executable without a shell', async (t) => {
  const { root, write } = await fixture(t);
  const file = await write('Codex CLI');
  const calls = [];
  const find = createRuntimeFinder({ home: root, candidates: [file], execute: async (...args) => { calls.push(args); return { stdout: 'codex-cli 0.149.0\n' }; } });
  const result = await find();
  assert.equal(result.available, true);
  assert.equal(result.path, await fs.realpath(file));
  assert.equal(result.command, result.path);
  assert.equal(result.version, '0.149.0');
  assert.deepEqual(result.args, []);
  assert.deepEqual(calls[0][1], ['--version']);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].timeout, 5000);
});

test('macOS discovery includes the nested desktop CLI in system and user applications', () => {
  const home = path.join(os.tmpdir(), 'codex-candidate-home');
  const candidates = defaultCandidates({ home, env: { PATH: '' }, platform: 'darwin', target: platformTarget('darwin', 'arm64') });
  for (const directory of ['/Applications', path.join(home, 'Applications')]) {
    for (const app of ['Codex.app', 'ChatGPT.app']) {
      assert.ok(candidates.includes(path.join(directory, app, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')));
    }
  }
  assert.equal(candidates.length, new Set(candidates).size);
});

test('a fresh app-only profile discovers the bundled CLI and prerelease version without a manual selection', async (t) => {
  for (const app of ['Codex.app', 'ChatGPT.app']) await t.test(app, async (t) => {
    const { root, write } = await fixture(t);
    const binary = await write(path.join('Applications', app, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'));
    // Every executable candidate is inside this test's private filesystem.
    const candidates = defaultCandidates({ home: root, env: { PATH: '' }, platform: 'darwin', target: platformTarget('darwin', 'arm64') })
      .filter(candidate => candidate.startsWith(root + path.sep));
    const calls = [];
    const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, env: { PATH: '' }, candidates, execute: async (...args) => {
      calls.push(args); return { stdout: 'codex-cli 0.166.0-alpha.5.1\n' };
    } });
    const result = await find();
    assert.equal(result.path, await fs.realpath(binary));
    assert.equal(result.version, '0.166.0-alpha.5.1');
    assert.equal(result.available, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), [result.path, ['--version']]);
    assert.equal(calls[0][2].shell, false);
  });
});

test('only cached missing desktop-app paths opt into rediscovery; explicit project paths remain strict', async (t) => {
  const { root, write } = await fixture(t);
  const old = path.join(root, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex');
  const binary = await write('Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const calls = [];
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, candidates: [binary], execute: async file => {
    calls.push(file); return { stdout: 'codex-cli 0.166.0-alpha.5.1' };
  } });
  assert.equal((await find(old)).available, false);
  assert.deepEqual(calls, []);
  assert.equal((await find(old, { rediscoverMissingAppPath: true })).path, await fs.realpath(binary));
  assert.deepEqual(calls, [await fs.realpath(binary)]);
  assert.equal((await find(path.join(root, 'manually-selected-but-missing'), { rediscoverMissingAppPath: true })).available, false);
  assert.equal(calls.length, 1);
});

test('a valid manual selection keeps priority over the detected desktop CLI', async (t) => {
  const { root, write } = await fixture(t);
  const selected = await write('manual/codex');
  const bundled = await write('Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const calls = [];
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, candidates: [bundled], execute: async file => {
    calls.push(file); return { stdout: 'codex-cli 0.165.0' };
  } });
  assert.equal((await find(selected, { rediscoverMissingAppPath: true })).path, await fs.realpath(selected));
  assert.deepEqual(calls, [await fs.realpath(selected)]);
});

test('cached app launch errors do not count as missing selected files', async (t) => {
  for (const code of ['ENOENT', 'ENOTDIR']) await t.test(code, async (t) => {
    const { root, write } = await fixture(t);
    const selected = await write('Applications/ChatGPT.app/Contents/Resources/codex');
    const canonical = await fs.realpath(selected);
    const bundled = await write('Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
    const calls = [];
    const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, candidates: [bundled], execute: async file => {
      calls.push(file);
      if (file === canonical) throw Object.assign(new Error('Existing executable could not launch'), { code });
      return { stdout: 'codex-cli 0.166.0-alpha.5.1' };
    } });
    assert.equal((await find(selected, { rediscoverMissingAppPath: true })).available, false);
    assert.deepEqual(calls, [await fs.realpath(selected)]);
    assert.equal((await fs.stat(selected)).isFile(), true);
  });
});

test('cached desktop paths with existing invalid, timed-out, or inaccessible files do not silently switch CLIs', async (t) => {
  const { root, write } = await fixture(t);
  const selected = await write('Applications/ChatGPT.app/Contents/Resources/codex');
  const bundled = await write('Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  for (const execute of [async () => ({ stdout: 'another-program 1.0.0' }), async () => { throw Object.assign(new Error('timeout'), { killed: true }); }, async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }]) {
    const calls = [];
    const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, candidates: [bundled], execute: async file => { calls.push(file); return execute(); } });
    assert.equal((await find(selected, { rediscoverMissingAppPath: true })).available, false);
    assert.deepEqual(calls, [await fs.realpath(selected)]);
  }
  await fs.writeFile(selected, macBinary('x64'));
  let executions = 0;
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, candidates: [bundled], execute: async () => { executions++; return { stdout: 'codex-cli 0.166.0' }; } });
  assert.match((await find(selected, { rediscoverMissingAppPath: true })).error, /Apple Silicon/);
  assert.equal(executions, 0);
});

test('resolves an npm symlink and JavaScript wrapper to the native optional dependency', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('lib/node_modules/@openai/codex/bin/codex.js', '#!/usr/bin/env node\nthrow new Error("must not execute");');
  const native = await write('lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');
  const link = path.join(root, 'codex');
  await fs.symlink(wrapper, link);
  const calls = [];
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, execute: async (file) => { calls.push(file); return { stdout: 'codex-cli 0.149.0' }; } });
  const result = await find(link);
  assert.equal(result.path, await fs.realpath(native));
  assert.deepEqual(calls, [await fs.realpath(native)]);
});

test('rejects a wrapper with a missing native dependency without executing it', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('package/bin/codex.js', '#!/usr/bin/env node\n');
  let executions = 0;
  const find = createRuntimeFinder({ home: root, execute: async () => { executions++; return { stdout: 'codex-cli 0.149.0' }; } });
  const result = await find(wrapper);
  assert.equal(result.available, false);
  assert.equal(executions, 0);
  assert.match(result.error, /설치하거나 실행 파일/);
});

test('invalid custom path does not silently fall back to another installation', async (t) => {
  const { root, write } = await fixture(t);
  const file = await write('codex');
  const find = createRuntimeFinder({ home: root, candidates: [file], execute: async () => ({ stdout: 'codex-cli 0.149.0' }) });
  assert.equal((await find(path.join(root, 'missing'))).available, false);
  assert.match((await find('codex')).error, /전체 경로/);
  assert.equal((await find('~/codex')).available, true);
});

test('rejects an unrelated program and does not infer an owned timeout from killed alone', async (t) => {
  const { root, write } = await fixture(t);
  const file = await write('codex');
  const wrong = createRuntimeFinder({ home: root, execute: async () => ({ stdout: 'node v24.0.0' }) });
  assert.equal((await wrong(file)).errorKind, 'invalid-version');
  const timeout = createRuntimeFinder({ home: root, execute: async () => { throw Object.assign(new Error('timeout'), { killed: true }); } });
  assert.equal((await timeout(file)).errorKind, 'abnormal-exit');
});

test('continues discovery after one broken installation and deduplicates symlinks', async (t) => {
  const { root, write } = await fixture(t);
  const bad = await write('bad');
  const good = await write('good');
  const link = path.join(root, 'bad-link');
  await fs.symlink(bad, link);
  const calls = [];
  const find = createRuntimeFinder({ home: root, candidates: [bad, link, good], execute: async (file) => { calls.push(file); return { stdout: file.endsWith('good') ? 'codex-cli 0.149.0-beta.1' : 'other program' }; } });
  assert.equal((await find()).version, '0.149.0-beta.1');
  assert.equal(calls.length, 2);
});

test('rejects a directory or non-executable file before launching a process', async (t) => {
  const { root, write } = await fixture(t);
  const file = await write('readonly', 'placeholder', 0o600);
  let executions = 0;
  const find = createRuntimeFinder({ home: root, execute: async () => { executions++; return { stdout: 'codex-cli 0.149.0' }; } });
  assert.equal((await find(root)).available, false);
  assert.equal((await find(file)).available, false);
  assert.equal(executions, 0);
});

test('Windows discovery includes resources, npm prefixes and absolute PATH entries with native exe names', () => {
  const candidates = defaultCandidates({
    platform: 'win32', target: platformTarget('win32', 'x64'), home: 'C:\\Users\\Operator', resourcesPath: 'C:\\Program Files\\Codex Account Manager\\resources',
    env: { APPDATA: 'C:\\Users\\Operator\\AppData\\Roaming', npm_config_prefix: 'D:\\Tools\\npm', Path: 'C:\\Windows\\System32;D:\\Programs\\node;relative;;.' },
  });
  assert.ok(candidates.includes('C:\\Program Files\\Codex Account Manager\\resources\\bin\\codex.exe'));
  assert.ok(candidates.some((file) => file.startsWith('C:\\Users\\Operator\\AppData\\Roaming\\npm\\node_modules\\@openai\\') && file.endsWith('\\codex.exe')));
  assert.ok(candidates.some((file) => file.startsWith('D:\\Tools\\npm\\node_modules\\@openai\\') && file.endsWith('\\codex.exe')));
  assert.ok(candidates.includes('D:\\Programs\\node\\codex.cmd'));
  assert.ok(candidates.includes('D:\\Programs\\node\\codex.ps1'));
  assert.equal(candidates.some((file) => file.includes('relative') || /homebrew/.test(file)), false);
  assert.equal(candidates.length, new Set(candidates).size);
});

test('Windows npm cmd and PowerShell launchers resolve to codex.exe without a shell or invoking their contents', async (t) => {
  const { root, write } = await fixture(t);
  const cmd = await write('npm/codex.cmd', '@echo off\necho do-not-run-this-launcher');
  const powershell = await write('npm/codex.ps1', 'throw "do not run this launcher"');
  const native = await write('npm/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const calls = [];
  const find = createRuntimeFinder({ platform: 'win32', arch: 'x64', home: root, execute: async (...args) => { calls.push(args); return { stdout: 'codex-cli 0.161.0' }; } });
  assert.equal((await find(cmd)).path, await fs.realpath(native));
  assert.equal((await find(powershell)).path, await fs.realpath(native));
  const nativePath = await fs.realpath(native);
  assert.ok(calls.every(([file, args, options]) => file === nativePath && args[0] === '--version' && options.shell === false && options.windowsHide));
});

test('Windows local npm shim finds an optional native dependency in node_modules', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('project/node_modules/.bin/codex.cmd', '@echo off\n');
  const native = await write('project/node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/codex/codex.exe');
  const find = createRuntimeFinder({ platform: 'win32', arch: 'arm64', home: root, execute: async () => ({ stdout: 'codex-cli 0.161.0' }) });
  assert.equal((await find(wrapper)).path, await fs.realpath(native));
});

test('Windows launcher without a native dependency fails without attempting cmd or PowerShell', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('npm/codex.cmd', '@echo off\n');
  let executions = 0;
  const find = createRuntimeFinder({ platform: 'win32', arch: 'x64', home: root, execute: async () => { executions++; return { stdout: 'codex-cli 0.161.0' }; } });
  assert.equal((await find(wrapper)).available, false);
  assert.equal(executions, 0);
});

test('Apple Silicon rejects an Intel-only custom Codex before executing it', async (t) => {
  const { root, write } = await fixture(t);
  const intel = await write('intel-codex', macBinary('x64'));
  let executions = 0;
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, execute: async () => { executions++; return { stdout: 'codex-cli 0.161.0' }; } });
  const result = await find(intel);
  assert.equal(result.available, false);
  assert.match(result.error, /Apple Silicon/);
  assert.equal(executions, 0);
});

test('Apple Silicon skips an Intel candidate and discovers a native Codex', async (t) => {
  const { root, write } = await fixture(t);
  const intel = await write('intel-codex', macBinary('x64'));
  const arm = await write('arm-codex');
  const calls = [];
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, candidates: [intel, arm], execute: async (file) => { calls.push(file); return { stdout: 'codex-cli 0.161.0' }; } });
  assert.equal((await find()).path, await fs.realpath(arm));
  assert.deepEqual(calls, [await fs.realpath(arm)]);
});

test('an Intel manager running on Apple Silicon resolves the ARM npm dependency', async (t) => {
  const { root, write } = await fixture(t);
  const wrapper = await write('package/bin/codex.js', '#!/usr/bin/env node\n');
  const arm = await write('package/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');
  await write('package/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex', macBinary('x64'));
  const calls = [];
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'x64', detectAppleSilicon: async () => true, home: root, execute: async (command, args) => { calls.push([command, args]); return { stdout: 'codex-cli 0.161.0' }; } });
  const result = await find(wrapper);
  const native = await fs.realpath(arm);
  assert.equal(result.path, native);
  assert.equal(result.command, '/usr/bin/arch');
  assert.deepEqual(result.args, ['-arm64', native]);
  assert.deepEqual(calls, [['/usr/bin/arch', ['-arm64', native, '--version']]]);
});

test('an Intel manager explicitly starts the ARM part of a Universal Codex on Apple Silicon', async (t) => {
  const { root, write } = await fixture(t);
  const universal = Buffer.alloc(112);
  universal.writeUInt32BE(0xcafebabe, 0);
  universal.writeUInt32BE(2, 4);
  for (const [index, arch] of ['x64', 'arm64'].entries()) {
    const base = 8 + index * 20;
    const offset = 48 + index * 32;
    universal.writeUInt32BE(arch === 'arm64' ? 0x0100000c : 0x01000007, base);
    universal.writeUInt32BE(offset, base + 8);
    universal.writeUInt32BE(32, base + 12);
    macBinary(arch).copy(universal, offset);
  }
  const file = await write('universal-codex', universal);
  const calls = [];
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'x64', detectAppleSilicon: async () => true, home: root, execute: async (command, args) => { calls.push([command, args]); return { stdout: 'codex-cli 0.161.0' }; } });
  const result = await find(file);
  assert.equal(result.available, true);
  assert.equal(result.command, '/usr/bin/arch');
  assert.deepEqual(result.args, ['-arm64', await fs.realpath(file)]);
  assert.deepEqual(calls, [[result.command, [...result.args, '--version']]]);
});

test('Intel Macs continue to accept an Intel Codex executable', async (t) => {
  const { root, write } = await fixture(t);
  const intel = await write('intel-codex', macBinary('x64'));
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'x64', detectAppleSilicon: async () => false, home: root, execute: async () => ({ stdout: 'codex-cli 0.161.0' }) });
  assert.equal((await find(intel)).available, true);
});

test('Apple Silicon refuses an unknown launcher instead of running it to inspect its version', async (t) => {
  const { root, write } = await fixture(t);
  const script = await write('codex-script', '#!/bin/sh\nexec intel-codex "$@"\n');
  let executions = 0;
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, candidates: [script, path.join(root, 'missing')], execute: async () => { executions++; return { stdout: 'codex-cli 0.161.0' }; } });
  assert.match((await find()).error, /Apple Silicon/);
  assert.equal(executions, 0);
});

function fakeClock() {
  let time = 0, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    advance: amount => { time += amount; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.callback(); } },
  };
}

test('a failed bundled CLI continues to a healthy independent CLI with sanitized failure metadata', async t => {
  const { root, write } = await fixture(t);
  const bad = await write('Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const good = await write('.local/bin/codex');
  const canonicalBad = await fs.realpath(bad), calls = [];
  const find = createRuntimeFinder({ platform: 'darwin', arch: 'arm64', home: root, candidates: [bad, good], execute: async file => {
    calls.push(file);
    if (file === canonicalBad) throw Object.assign(new Error('Bearer private-token'), { code: 137, signal: 'SIGKILL', stderr: 'secret stderr' });
    return { stdout: 'codex-cli 0.166.0' };
  } });
  const result = await find();
  assert.equal(result.path, await fs.realpath(good));
  assert.deepEqual(calls, [canonicalBad, await fs.realpath(good)]);
  assert.equal(result.errorKind, null);
  assert.equal(result.diagnostics.records[0].kind, 'abnormal-exit');
  assert.equal(result.diagnostics.records[0].signal, 'SIGKILL');
  assert.equal(result.diagnostics.records[0].code, 137);
  assert.ok(result.diagnostics.records[0].path.startsWith('$HOME/'));
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /Bearer|private-token|secret stderr|Signature|서명/);
});

test('version failures retain distinct safe reasons without publishing raw command output', async t => {
  const { root, write } = await fixture(t), file = await write('codex');
  for (const [error, expected] of [
    [{ code: 'EACCES' }, 'permissions'], [{ code: 7 }, 'abnormal-exit'],
    [{ code: 137, signal: 'SIGKILL', killed: true }, 'abnormal-exit'],
  ]) {
    const find = createRuntimeFinder({ home: root, candidates: [file], execute: async () => { throw Object.assign(new Error('private raw failure'), error); } });
    const result = await find();
    assert.equal(result.errorKind, expected);
    assert.doesNotMatch(JSON.stringify(result), /private raw failure|Signature|서명/);
  }
  const empty = createRuntimeFinder({ home: root, candidates: [file], execute: async () => ({ stdout: '' }) });
  assert.equal((await empty()).errorKind, 'invalid-version');
  const missing = createRuntimeFinder({ home: root, candidates: [path.join(root, 'missing')], execute: async () => { assert.fail('Missing files must not execute'); } });
  assert.equal((await missing()).errorKind, 'missing');
});

test('only the owned deadline labels a probe timeout and passes an AbortController signal', async t => {
  const { root, write } = await fixture(t), file = await write('codex'), clock = fakeClock();
  let entered, signal;
  const started = new Promise(resolve => entered = resolve);
  const find = createRuntimeFinder({ home: root, candidates: [file], clock, execute: async (_command, _args, options) => {
    signal = options.signal; entered();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true }));
  } });
  const pending = find(); await started; clock.advance(5000);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.errorKind, 'owned-timeout');
  assert.equal(result.diagnostics.records.at(-1).elapsedMs, 5000);
  assert.equal(result.diagnostics.records.at(-1).signal, null);
});

test('automatic failure cooldown expires after thirty seconds, invalidates changed files, and allows explicit validation', async t => {
  const { root, write } = await fixture(t), file = await write('codex'), clock = fakeClock();
  let calls = 0;
  const find = createRuntimeFinder({ home: root, candidates: [file], clock, execute: async () => { calls++; return { stdout: '' }; } });
  await find(); await find(); assert.equal(calls, 1);
  clock.advance(29999); await find(); assert.equal(calls, 1);
  clock.advance(1); await find(); assert.equal(calls, 2);
  await fs.appendFile(file, Buffer.from([0])); await find(); assert.equal(calls, 3);
  await find(file); assert.equal(calls, 4);
  await find('', { bypassCooldown: true }); assert.equal(calls, 5);
});

test('diagnostic history and failed-candidate cache remain bounded', async t => {
  const { root, write } = await fixture(t), files = [];
  for (let index = 0; index < 65; index++) files.push(await write('codex-' + index));
  const candidates = [...files]; let calls = 0;
  const find = createRuntimeFinder({ home: root, candidates, execute: async () => { calls++; return { stdout: '' }; } });
  const result = await find();
  assert.equal(calls, 65); assert.equal(result.diagnostics.records.length, 16); assert.equal(result.diagnostics.omitted, 49);
  candidates.splice(0, candidates.length, files[0]); await find(); assert.equal(calls, 66, 'Oldest of65failure entries must have been evicted from the64-entry cache');
});

test('an aborted owned child stays retained until close and cannot be launched twice', async t => {
  const { EventEmitter } = require('node:events');
  const { root, write } = await fixture(t), file = await write('codex'), clock = fakeClock();
  const children = []; let entered;
  const started = new Promise(resolve => entered = resolve);
  const find = createRuntimeFinder({ home: root, candidates: [file], clock, execFile: (_command, _args, options, callback) => {
    const child = new EventEmitter(); children.push(child);
    assert.equal(options.shell, false); assert.equal(options.timeout, 0);
    if (children.length === 1) { options.signal.addEventListener('abort', () => callback(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true }); entered(); }
    else setImmediate(() => { callback(null, 'codex-cli 0.166.0'); child.emit('close', 0); });
    return child;
  } });
  const pending = find(); await started; clock.advance(5000);
  assert.equal((await pending).errorKind, 'owned-timeout');
  assert.equal((await find('', { bypassCooldown: true })).errorKind, 'owned-timeout');
  assert.equal(children.length, 1);
  children[0].emit('close', null, 'SIGTERM');
  assert.equal((await find('', { bypassCooldown: true })).available, true);
  assert.equal(children.length, 2);
});

test('backend diagnostic snapshots also enforce the sixteen-KiB budget for long paths', async t => {
  const { root, write } = await fixture(t), candidates = [];
  const long = Array.from({ length: 5 }, (_, index) => String(index) + 'x'.repeat(150)).join('/');
  for (let index = 0; index < 20; index++) candidates.push(await write(long + '/codex-' + index));
  const find = createRuntimeFinder({ home: root, candidates, execute: async () => ({ stdout: '' }) });
  const result = await find();
  assert.ok(Buffer.byteLength(JSON.stringify(result.diagnostics), 'utf8') <= 16 * 1024);
  assert.ok(result.diagnostics.records.length <= 16); assert.ok(result.diagnostics.omitted >= 4);
});
