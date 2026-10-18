'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { syncDirectory } = require('../electron/directory-sync.cjs');
const { AccountService } = require('../electron/codex/account-service.cjs');

test('Windows omits unsupported directory flushing without opening a directory handle', async () => {
  await syncDirectory('C:\\account-data', {
    platform: 'win32',
    fsImpl: { open: async () => assert.fail('A Windows directory must not be opened for fsync') },
  });
});

test('POSIX flushes the directory and closes its handle', async () => {
  const calls = [];
  await syncDirectory('/account-data', {
    platform: 'linux',
    fsImpl: { open: async (...args) => {
      calls.push(['open', ...args]);
      return { sync: async () => calls.push(['sync']), close: async () => calls.push(['close']) };
    } },
  });
  assert.deepEqual(calls, [['open', '/account-data', 'r'], ['sync'], ['close']]);
});

test('POSIX directory permission and I/O errors remain visible and handles close after a failed flush', async t => {
  const openError = Object.assign(new Error('Directory cannot be opened'), { code: 'EPERM' });
  await assert.rejects(syncDirectory('/account-data', {
    platform: 'darwin', fsImpl: { open: async () => { throw openError; } },
  }), error => error === openError);
  for (const code of ['EPERM', 'EIO', 'EINVAL']) {
    await t.test(code, async () => {
      let closed = false;
      const failure = Object.assign(new Error('Directory flush failed'), { code });
      await assert.rejects(syncDirectory('/account-data', {
        platform: 'linux',
        fsImpl: { open: async () => ({ sync: async () => { throw failure; }, close: async () => { closed = true; } }) },
      }), error => error === failure);
      assert.equal(closed, true);
    });
  }
});

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-account-save-'));
  const filename = path.join(dataDir, 'accounts.json');
  const service = new AccountService({ dataDir });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, filename, temporary: filename + '.tmp', service };
}

test('account saving flushes file contents before publishing the new file on every platform', async t => {
  const h = await fixture(t), calls = [];
  const open = fs.open.bind(fs), rename = fs.rename.bind(fs);
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await open(filename, ...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { calls.push(filename === h.temporary ? 'file-sync' : 'directory-sync'); return sync(); };
    return handle;
  });
  t.mock.method(fs, 'rename', async (...args) => { calls.push('rename'); return rename(...args); });
  try {
    await h.service._save();
    assert.deepEqual(calls, ['file-sync', 'rename', ...(process.platform === 'win32' ? [] : ['directory-sync'])]);
    assert.deepEqual(JSON.parse(await fs.readFile(h.filename, 'utf8')), { version: 1, accounts: [], activity: [] });
  } finally { t.mock.restoreAll(); }
});

test('account file write, fsync, and rename failures are not suppressed and a later save can recover', async t => {
  for (const stage of ['write', 'sync', 'rename']) {
    await t.test(stage, async t => {
      const h = await fixture(t), original = '{"original":true}';
      await fs.writeFile(h.filename, original);
      const failure = Object.assign(new Error(`File ${stage} failed`), { code: 'EPERM' });
      const open = fs.open.bind(fs), rename = fs.rename.bind(fs);
      t.mock.method(fs, 'open', async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (filename === h.temporary) {
          const method = stage === 'write' ? 'writeFile' : stage === 'sync' ? 'sync' : null;
          if (method) handle[method] = async () => { throw failure; };
        }
        return handle;
      });
      t.mock.method(fs, 'rename', async (...args) => {
        if (stage === 'rename' && args[0] === h.temporary) throw failure;
        return rename(...args);
      });
      try {
        await assert.rejects(h.service._save(), error => error === failure);
        assert.equal(await fs.readFile(h.filename, 'utf8'), original);
      } finally { t.mock.restoreAll(); }
      await h.service._save();
      assert.deepEqual(JSON.parse(await fs.readFile(h.filename, 'utf8')), { version: 1, accounts: [], activity: [] });
    });
  }
});
