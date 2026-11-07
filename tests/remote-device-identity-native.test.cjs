'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const enabled = process.platform === 'darwin' && process.env.REVIEWOPS_TEST_NATIVE_IDENTITY === '1';
test('real development Electron main enrolls, serves TLS and reopens protected identity in a separate process',
  {skip: !enabled, timeout: 60000}, () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-native-identity-test-')));
    fs.chmodSync(directory, 0o700);
    // Read the already-installed executable directly. Requiring Electron's npm
    // launcher may auto-download a missing binary, which this test never does.
    const electronDirectory = path.dirname(require.resolve('electron/package.json'));
    const executable = fs.readFileSync(path.join(electronDirectory, 'path.txt'), 'utf8').trim();
    const electron = path.join(electronDirectory, 'dist', executable);
    assert.equal(fs.existsSync(electron), true, 'Install Electron before the opt-in integration test.');
    const fixture = path.join(__dirname, 'fixtures/remote-device-identity-main.cjs');
    const run = phase => {
      const environment = {...process.env}; delete environment.ELECTRON_RUN_AS_NODE;
      return spawnSync(electron, [fixture, phase, directory], {env: environment, encoding: 'utf8', timeout: 25000});
    };
    const first = run('create');
    const second = run('reopen-cleanup');
    const cleanupConfirmed = second.status === 0 && second.stdout.includes('"cleaned":true');
    if (cleanupConfirmed) fs.rmSync(directory, {recursive: true, force: true});
    assert.equal(first.status, 0, `First main process refused: ${first.stderr}`);
    assert.match(first.stdout, /"tls":true/);
    assert.equal(second.status, 0, `Reopen refused: ${second.stderr}. Retained fixture profile: ${directory}`);
    assert.equal(cleanupConfirmed, true);
  });
