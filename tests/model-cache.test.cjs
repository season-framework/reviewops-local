'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createModelCache } = require('../electron/model-cache.cjs');

const MINUTE = 60 * 1000;
const INITIAL_TIME = Date.parse('2026-10-19T00:00:00.000Z');
const READ_ERROR = '모델 정보를 불러오지 못했습니다. 다시 조회하십시오.';
const SAVE_ERROR = '모델 정보를 파일에 저장하지 못했습니다.';
const INTERVAL_ERROR = '모델 목록 수집 주기는 5~1440분 사이의 정수로 입력하십시오.';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const target = (id = 'local', signature = 'signature-' + id) => ({ id, label: 'Host ' + id, signature, config: { kind: 'local' }, settings: { binary: 'codex' } });
const model = (id = 'model-a') => ({ id, label: 'Model ' + id, reasoning: ['low', 'high'], defaultReasoningEffort: 'high' });
const result = (id = 'model-a') => ({ models: [model(id)], defaultModel: id, defaultReasoningEffort: 'high', installed: true, loggedIn: true, version: 'codex-cli 1.0.0', authState: 'authenticated', modelSource: 'host', modelError: '' });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const dataPath = options.dataPath || fs.mkdtempSync(path.join(os.tmpdir(), 'reviewops-model-cache-'));
  if (!options.dataPath) t.after(() => fs.rmSync(dataPath, { recursive: true, force: true }));
  const observed = { calls: [], states: [] };
  const state = { targets: [target()], time: INITIAL_TIME, response: result() };
  const manager = createModelCache({ dataPath, listTargets: options.listTargets || (() => state.targets),
    collect: async value => { observed.calls.push(value); return options.collect ? options.collect(value) : state.response; },
    onChange: value => { observed.states.push(value); options.onChange?.(value); }, now: () => state.time });
  t.after(() => manager.close());
  return { manager, observed, state, dataPath, filename: path.join(dataPath, 'model-cache.json') };
}

test('cache construction and reads perform no host collection and require valid settings', t => {
  const { manager, observed, filename } = fixture(t);
  assert.equal(manager.get('missing'), null);
  assert.deepEqual(manager.get('local').models, []);
  assert.equal(manager.get('local').cacheStatus, 'empty');
  assert.equal(manager.get('local').cachedAt, null);
  assert.equal(manager.snapshot().intervalMinutes, 60);
  assert.equal(manager.snapshot().refreshing, false);
  assert.deepEqual(observed.calls, []);
  assert.equal(fs.existsSync(filename), false);
  assert.throws(() => createModelCache({ dataPath: 'relative', listTargets: () => [], collect() {} }), /전체 경로/);
  assert.throws(() => createModelCache({ dataPath: os.tmpdir(), listTargets: null, collect() {} }), /올바르지/);
  assert.throws(() => createModelCache({ dataPath: os.tmpdir(), listTargets: () => [], collect: null }), /올바르지/);
});

test('successful collection returns cloned model data and keeps private target settings in memory', async t => {
  const { manager, observed, state, filename } = fixture(t);
  state.targets = [{ ...target(), signature: 'private-host\nprivate-user', config: { password: 'private-password' }, settings: { instructions: 'private-instructions' } }];
  state.response = { ...result(), credentials: 'private-credentials', config: 'private-config', error: 'private-auth-output', auth: 'private-auth' };
  const value = await manager.refresh('local');
  assert.deepEqual(observed.calls, [state.targets[0]]);
  assert.equal(value.modelSource, 'cache');
  assert.equal(value.cacheStatus, 'ready');
  assert.equal(value.installed, true);
  assert.equal(value.loggedIn, true);
  assert.equal(value.authState, 'authenticated');
  assert.equal(value.version, 'codex-cli 1.0.0');
  assert.equal(value.cachedAt, '2026-10-19T00:00:00.000Z');
  assert.equal(value.lastAttemptAt, value.cachedAt);
  assert.equal(value.defaultModel, 'model-a');
  assert.equal(value.defaultReasoningEffort, 'high');
  value.models[0].label = 'changed'; value.models[0].reasoning.push('ultra');
  const snapshot = manager.snapshot(); snapshot.targets[0].models[0].reasoning.length = 0;
  assert.deepEqual(manager.get('local').models, [model()]);
  const disk = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(disk.targets[0].signature, hash(state.targets[0].signature));
  assert.deepEqual(Object.keys(disk.targets[0]).sort(), ['cachedAt', 'defaultModel', 'defaultReasoningEffort', 'failedAt', 'id', 'label', 'lastAttemptAt', 'models', 'signature']);
  for (const serialized of [JSON.stringify(manager.get('local')), JSON.stringify(manager.snapshot()), fs.readFileSync(filename, 'utf8')]) assert.doesNotMatch(serialized, /private-/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});

test('restart restores cached models and interval synchronously without restoring authentication metadata', async t => {
  const first = fixture(t);
  first.state.targets = [target('local', 'a'.repeat(64))];
  await first.manager.refresh('local');
  first.manager.configure({ intervalMinutes: 120 }); first.manager.close();
  assert.equal(JSON.parse(fs.readFileSync(first.filename, 'utf8')).targets[0].signature, 'a'.repeat(64));
  const second = fixture(t, { dataPath: first.dataPath, listTargets: () => first.state.targets });
  assert.deepEqual(second.observed.calls, []);
  assert.equal(second.manager.snapshot().intervalMinutes, 120);
  assert.deepEqual(second.manager.get('local').models, [model()]);
  assert.equal(second.manager.get('local').cacheStatus, 'ready');
  for (const field of ['installed', 'loggedIn', 'version', 'authState', 'config', 'settings', 'signature']) assert.equal(Object.hasOwn(second.manager.get('local'), field), false, field);
  assert.equal(second.manager.get('local').modelSource, 'cache');
});

test('model metadata is normalized, bounded and limited to supported reasoning values', async t => {
  const { manager, state, filename } = fixture(t);
  state.response = { ...result(), models: [null, {}, { id: 'invalid id' }, { id: 'hidden', hidden: true },
    { id: 'hidden-2', visibility: 'hidden' }, { id: 'model-a', label: 'Name\nraw', reasoning: ['low', 'low', 'high', 'secret-value', 1], defaultReasoningEffort: 'ultra', credentials: 'discard-me' },
    model(), ...Array.from({ length: 150 }, (_, i) => model('additional-' + i))], defaultModel: 'invalid model', defaultReasoningEffort: 'secret-value' };
  const value = await manager.refresh('local');
  assert.equal(value.models.length, 100);
  assert.deepEqual(value.models[0], { id: 'model-a', label: 'model-a', reasoning: ['low', 'high'], defaultReasoningEffort: '' });
  assert.equal(new Set(value.models.map(row => row.id)).size, 100);
  assert.equal(value.defaultModel, ''); assert.equal(value.defaultReasoningEffort, '');
  assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /discard-me|secret-value|invalid model|Name/);
});

test('failed collections preserve the last successful models and never expose raw failure output', async t => {
  let mode = 'success';
  const { manager, state, filename } = fixture(t, { collect: async () => {
    if (mode === 'throw') throw new Error('PRIVATE_PASSWORD=do-not-show host=private-host');
    if (mode === 'cache') return { ...result('outdated'), modelSource: 'cache', modelError: 'PRIVATE_TOKEN=do-not-show' };
    return result();
  } });
  const original = await manager.refresh('local');
  for (const next of ['throw', 'cache']) {
    mode = next; state.time += MINUTE;
    const value = await manager.refresh('local');
    assert.deepEqual(value.models, original.models); assert.equal(value.defaultModel, original.defaultModel);
    assert.equal(value.cachedAt, original.cachedAt); assert.equal(value.lastAttemptAt, new Date(state.time).toISOString());
    assert.equal(value.cacheStatus, 'stale'); assert.equal(value.modelError, READ_ERROR); assert.equal(value.error, READ_ERROR);
    assert.doesNotMatch(JSON.stringify(value) + fs.readFileSync(filename, 'utf8'), /PRIVATE_|private-host|outdated/);
  }
  const restored = fixture(t, { dataPath: path.dirname(filename) });
  assert.equal(restored.manager.get('local').cacheStatus, 'stale');
  assert.equal(restored.manager.get('local').modelError, READ_ERROR);
  mode = 'success'; state.time += MINUTE;
  const recovered = await manager.refresh('local');
  assert.equal(recovered.cacheStatus, 'ready'); assert.equal(recovered.modelError, '');
  assert.equal(recovered.cachedAt, new Date(state.time).toISOString());
});

test('a valid host list remains usable when only the host default settings fail', async t => {
  const { manager, state, filename } = fixture(t);
  state.response = { ...result(), modelError: 'config read failed: PRIVATE_TOKEN' };
  const value = await manager.refresh('local');
  assert.deepEqual(value.models, [model()]); assert.equal(value.cacheStatus, 'ready');
  assert.equal(value.modelError, '모델 목록은 불러왔지만 기본 설정을 모두 읽지 못했습니다.');
  assert.doesNotMatch(JSON.stringify(value) + fs.readFileSync(filename, 'utf8'), /PRIVATE_TOKEN|config read failed/);
});

test('authoritative empty lists replace old models while unavailable or malformed results preserve them', async t => {
  const { manager, state } = fixture(t);
  await manager.refresh('local');
  for (const invalid of [null, {}, { models: [null, { id: 'invalid model' }] }, { ...result('other'), installed: false },
    { ...result('other'), modelSource: 'none' }, { ...result('other'), modelSource: 'manual' }]) {
    state.response = invalid; state.time += MINUTE;
    const value = await manager.refresh('local');
    assert.deepEqual(value.models, [model()]); assert.equal(value.cacheStatus, 'stale');
  }
  state.response = { ...result(), models: [], defaultModel: '', defaultReasoningEffort: '' };
  const empty = await manager.refresh('local');
  assert.deepEqual(empty.models, []); assert.equal(empty.defaultModel, ''); assert.equal(empty.cacheStatus, 'ready'); assert.equal(empty.error, '');
});

test('an existing CLI fallback can seed stale models without claiming a successful collection time', async t => {
  const { manager, state, dataPath } = fixture(t);
  state.response = { ...result(), modelSource: 'cache', modelError: 'host output must stay private' };
  const value = await manager.refresh('local');
  assert.deepEqual(value.models, [model()]); assert.equal(value.cacheStatus, 'stale'); assert.equal(value.cachedAt, null);
  assert.equal(value.defaultModel, 'model-a'); assert.equal(value.modelError, READ_ERROR);
  const restored = fixture(t, { dataPath });
  assert.deepEqual(restored.manager.get('local').models, [model()]);
  assert.equal(restored.manager.get('local').cachedAt, null); assert.equal(restored.manager.get('local').cacheStatus, 'stale');
});

test('a first failed collection remains an error after restart instead of becoming a stale success', async t => {
  const { manager, dataPath } = fixture(t, { collect: () => { throw new Error('private transport output'); } });
  assert.equal((await manager.refresh('local')).cacheStatus, 'error');
  const restored = fixture(t, { dataPath });
  assert.equal(restored.manager.get('local').cacheStatus, 'error');
  assert.equal(restored.manager.get('local').cachedAt, null); assert.deepEqual(restored.manager.get('local').models, []);
});

test('concurrent refreshes for one host share the same collection and promise', async t => {
  const gate = deferred(); t.after(() => gate.resolve(result()));
  const { manager, observed } = fixture(t, { collect: () => gate.promise });
  const first = manager.refresh('local'), second = manager.refresh('local'), all = manager.refresh();
  assert.equal(first, second); await settle();
  assert.equal(observed.calls.length, 1); assert.equal(manager.get('local').refreshing, true);
  assert.equal(manager.get('local').cacheStatus, 'refreshing'); assert.equal(manager.snapshot().refreshing, true);
  gate.resolve(result());
  assert.equal((await first).cacheStatus, 'ready'); await all;
  assert.equal(manager.snapshot().refreshing, false); assert.equal(manager.get('local').refreshing, false);
});

test('collection concurrency is limited to three hosts and queued hosts continue after completion', async t => {
  const gates = new Map(), running = new Set(); let maximum = 0;
  const { manager, state, observed } = fixture(t, { collect: async value => {
    running.add(value.id); maximum = Math.max(maximum, running.size);
    const gate = deferred(); gates.set(value.id, gate); await gate.promise; running.delete(value.id); return result(value.id);
  } });
  state.targets = Array.from({ length: 8 }, (_, i) => target('host-' + i));
  const refresh = manager.refresh(); await settle();
  assert.equal(observed.calls.length, 3); assert.equal(running.size, 3);
  for (let index = 0; index < 8; index++) {
    const id = 'host-' + index; assert(gates.has(id)); gates.get(id).resolve(); await settle();
  }
  const snapshot = await refresh;
  assert.equal(maximum, 3); assert.equal(observed.calls.length, 8);
  assert(snapshot.targets.every(row => row.status === 'ready')); assert.equal(snapshot.refreshing, false);
});

test('signature changes discard late responses and automatically collect the replacement target', async t => {
  const oldGate = deferred(), newGate = deferred(); t.after(() => { oldGate.resolve(result('old')); newGate.resolve(result('new')); });
  const { manager, state, observed, filename } = fixture(t, { collect: value => value.signature === 'old' ? oldGate.promise : newGate.promise });
  state.targets = [target('local', 'old')];
  const startup = manager.start(); await settle(); assert.equal(observed.calls.length, 1);
  state.targets = [{ ...target('local', 'new'), config: { host: 'replacement-private-host' } }];
  manager.reconcile(); await settle(); assert.equal(observed.calls.length, 2);
  assert.deepEqual(manager.get('local').models, []); assert.equal(manager.get('local').refreshing, true);
  newGate.resolve(result('new')); await manager.refresh('local');
  const beforeLate = fs.readFileSync(filename, 'utf8'), events = observed.states.length;
  oldGate.resolve(result('old')); await startup; await settle();
  assert.deepEqual(manager.get('local').models, [model('new')]);
  assert.equal(fs.readFileSync(filename, 'utf8'), beforeLate); assert.equal(observed.states.length, events);
  assert.equal(JSON.parse(beforeLate).targets[0].signature, hash('new'));
  assert.doesNotMatch(beforeLate, /replacement-private-host/);
});

test('account invalidation clears old metadata and ignores an earlier pending response before the new collection completes', async t => {
  const oldGate = deferred(), newGate = deferred(); let calls = 0;
  t.after(() => { oldGate.resolve(result('old-account')); newGate.resolve(result('new-account')); });
  const { manager, observed, filename } = fixture(t, { collect: () => ++calls === 1 ? result('previous-account') : calls === 2 ? oldGate.promise : newGate.promise });
  await manager.refresh('local');
  const oldRefresh = manager.refresh('local'); await settle(); assert.equal(observed.calls.length, 2);
  const replacement = manager.invalidate('local'); assert.equal(manager.refresh('local'), replacement);
  const cleared = manager.get('local');
  assert.deepEqual(cleared.models, []); assert.equal(cleared.cachedAt, null);
  assert.equal(cleared.defaultModel, ''); assert.equal(cleared.defaultReasoningEffort, '');
  assert.equal(cleared.installed, undefined); assert.equal(cleared.loggedIn, undefined); assert.equal(cleared.authState, undefined);
  assert.equal(cleared.version, undefined); assert.equal(cleared.refreshing, true);
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8')).targets[0];
  assert.deepEqual(saved.models, []); assert.equal(saved.cachedAt, null); assert.equal(saved.defaultModel, '');
  await settle(); assert.equal(observed.calls.length, 3);
  oldGate.resolve(result('old-account')); await oldRefresh; await settle();
  assert.deepEqual(manager.get('local').models, []); assert.equal(manager.get('local').refreshing, true);
  newGate.resolve(result('new-account'));
  const value = await replacement;
  assert.deepEqual(value.models, [model('new-account')]); assert.equal(value.defaultModel, 'new-account');
  assert.equal(value.cacheStatus, 'ready'); assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /old-account|previous-account/);
  await assert.rejects(manager.invalidate('missing'), { message: '모델 정보를 조회할 호스트를 찾지 못했습니다.' });
});

test('removing a queued or running host prevents its old results from returning after re-adding the id', async t => {
  const gates = new Map();
  const { manager, state, observed } = fixture(t, { collect: value => { const gate = deferred(); gates.set(value.id, gate); return gate.promise; } });
  state.targets = ['a', 'b', 'c', 'queued'].map(id => target(id));
  const all = manager.start(); await settle();
  assert.deepEqual(observed.calls.map(row => row.id), ['a', 'b', 'c']);
  state.targets = [target('b'), target('c')]; manager.reconcile();
  assert.equal(manager.get('a'), null); assert.equal(manager.get('queued'), null);
  const oldA = gates.get('a');
  state.targets.push(target('a')); manager.reconcile();
  oldA.resolve(result('old-a')); await settle();
  assert.deepEqual(manager.get('a').models, []); assert.equal(observed.calls.filter(row => row.id === 'a').length, 2);
  gates.get('a').resolve(result('replacement-a')); gates.get('b').resolve(result('b')); gates.get('c').resolve(result('c'));
  await manager.refresh(); await all;
  assert.deepEqual(manager.get('a').models, [model('replacement-a')]);
  assert.equal(observed.calls.some(row => row.id === 'queued'), false);
});

test('label changes preserve matching cached models and do not trigger another collection', async t => {
  const { manager, state, observed, filename } = fixture(t);
  await manager.start(); const before = manager.get('local');
  state.targets[0] = { ...state.targets[0], label: 'Renamed host', settings: { binary: 'same-signature-settings' } };
  manager.reconcile(); await settle();
  assert.equal(observed.calls.length, 1); assert.equal(manager.get('local').label, 'Renamed host');
  assert.equal(manager.get('local').cachedAt, before.cachedAt); assert.deepEqual(manager.get('local').models, before.models);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).targets[0].label, 'Renamed host');
  state.targets = []; manager.reconcile();
  assert.deepEqual(manager.snapshot().targets, []); assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).targets, []);
});

test('startup collects immediately once and repeats every sixty minutes until closed', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { manager, observed } = fixture(t);
  await manager.start(); await manager.start(); assert.equal(observed.calls.length, 1);
  t.mock.timers.tick(60 * MINUTE - 1); await settle(); assert.equal(observed.calls.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(observed.calls.length, 2);
  t.mock.timers.tick(60 * MINUTE); await settle(); assert.equal(observed.calls.length, 3);
  manager.close(); t.mock.timers.tick(120 * MINUTE); await settle(); assert.equal(observed.calls.length, 3);
});

test('configuring the interval validates integers, persists the preference and replaces the running timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { manager, observed, dataPath } = fixture(t);
  await manager.start(); t.mock.timers.tick(10 * MINUTE);
  for (const invalid of [undefined, null, '30', 4, 1441, 10.5, NaN, Infinity]) {
    assert.throws(() => manager.configure({ intervalMinutes: invalid }), { message: INTERVAL_ERROR });
    assert.equal(manager.snapshot().intervalMinutes, 60);
  }
  assert.equal(manager.configure({ intervalMinutes: 5 }).intervalMinutes, 5); assert.equal(observed.calls.length, 1);
  t.mock.timers.tick(5 * MINUTE - 1); await settle(); assert.equal(observed.calls.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(observed.calls.length, 2);
  manager.configure({ intervalMinutes: 1440 });
  t.mock.timers.tick(60 * MINUTE); await settle(); assert.equal(observed.calls.length, 2);
  manager.close();
  const restored = fixture(t, { dataPath }); assert.equal(restored.manager.snapshot().intervalMinutes, 1440);
});

test('slow scheduled collections share pending host work and do not accumulate duplicate requests', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const gate = deferred(); t.after(() => gate.resolve(result()));
  const { manager, observed } = fixture(t, { collect: () => gate.promise });
  const startup = manager.start(); await settle();
  t.mock.timers.tick(180 * MINUTE); await settle(); assert.equal(observed.calls.length, 1);
  gate.resolve(result()); await startup; await settle();
  t.mock.timers.tick(60 * MINUTE); await settle(); assert.equal(observed.calls.length, 2);
});

test('close settles pending requests and prevents late saves, notifications, scheduling and collection', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const gate = deferred(); t.after(() => gate.resolve(result()));
  const { manager, observed, filename } = fixture(t, { collect: () => gate.promise });
  manager.configure({ intervalMinutes: 5 }); const before = fs.readFileSync(filename, 'utf8');
  const pending = manager.start(); await settle(); manager.close();
  await pending; assert.equal(manager.snapshot().refreshing, false); assert.equal(manager.get('local').refreshing, false);
  const notifications = observed.states.length;
  gate.resolve(result()); await settle();
  assert.equal(fs.readFileSync(filename, 'utf8'), before); assert.equal(observed.states.length, notifications);
  t.mock.timers.tick(60 * MINUTE); await settle();
  await manager.start(); await manager.refresh(); await manager.refresh('local'); manager.reconcile();
  assert.equal(observed.calls.length, 1); assert.deepEqual(manager.get('local').models, []);
  assert.throws(() => manager.configure({ intervalMinutes: 10 }), /종료/);
});

test('corrupt, oversized and unsupported cache files are ignored without host collection', t => {
  const { dataPath, filename, manager } = fixture(t); manager.close();
  const cases = ['{broken', JSON.stringify({ schema: 999, intervalMinutes: 10, targets: [] }),
    JSON.stringify({ schema: 1, intervalMinutes: 10, targets: Array.from({ length: 501 }, () => ({})) })];
  for (const bytes of cases) {
    fs.writeFileSync(filename, bytes);
    const candidate = fixture(t, { dataPath });
    assert.equal(candidate.manager.snapshot().intervalMinutes, 60); assert.deepEqual(candidate.manager.get('local').models, []);
    assert.deepEqual(candidate.observed.calls, []); candidate.manager.close();
  }
  fs.writeFileSync(filename, ''); fs.truncateSync(filename, 32 * 1024 * 1024 + 1);
  const oversized = fixture(t, { dataPath }); assert.deepEqual(oversized.manager.get('local').models, []);
  assert.deepEqual(oversized.observed.calls, []);
});

test('cache files reached through symbolic links are not loaded', t => {
  if (process.platform === 'win32') { t.skip('Creating file symlinks requires host privileges on Windows.'); return; }
  const { manager, dataPath, filename } = fixture(t); manager.close();
  const other = path.join(dataPath, 'outside.json');
  fs.writeFileSync(other, JSON.stringify({ schema: 1, intervalMinutes: 10, targets: [{ ...target(), signature: hash('signature-local'), models: [model()], cachedAt: new Date(INITIAL_TIME).toISOString() }] }));
  fs.symlinkSync(other, filename);
  const candidate = fixture(t, { dataPath });
  assert.equal(candidate.manager.snapshot().intervalMinutes, 60); assert.deepEqual(candidate.manager.get('local').models, []);
});

test('restored data is normalized and requires the current target signature', t => {
  const { manager, dataPath, filename } = fixture(t); manager.close();
  const saved = { schema: 1, intervalMinutes: '15', targets: [{ id: 'local', label: 'Old host', signature: hash('old-signature'), models: [model()], cachedAt: new Date(INITIAL_TIME).toISOString(), config: { password: 'private' } }] };
  fs.writeFileSync(filename, JSON.stringify(saved));
  const changed = fixture(t, { dataPath }); assert.deepEqual(changed.manager.get('local').models, []); assert.equal(changed.manager.snapshot().intervalMinutes, 60);
  saved.targets[0] = { ...saved.targets[0], signature: hash('signature-local'), models: [{ id: 'model-a', reasoning: ['low', 'private'], defaultReasoningEffort: 'private', auth: 'private' }],
    cachedAt: 'invalid-time', lastAttemptAt: 'invalid-time', failedAt: 'invalid-time', defaultModel: 'bad model', defaultReasoningEffort: 'private' };
  fs.writeFileSync(filename, JSON.stringify(saved));
  const normalized = fixture(t, { dataPath }); const value = normalized.manager.get('local');
  assert.equal(value.label, 'Host local'); assert.deepEqual(value.models, [{ id: 'model-a', label: 'model-a', reasoning: ['low'], defaultReasoningEffort: '' }]);
  assert.equal(value.cachedAt, null); assert.equal(value.lastAttemptAt, null); assert.equal(value.defaultModel, ''); assert.equal(value.defaultReasoningEffort, '');
  assert.equal(value.cacheStatus, 'stale'); assert.doesNotMatch(JSON.stringify(value), /private/);
});

test('at most five hundred unique targets are retained and invalid descriptors are ignored', t => {
  const { manager, state, observed } = fixture(t);
  state.targets = Array.from({ length: 510 }, (_, i) => target('host-' + i)); manager.reconcile();
  assert.equal(manager.snapshot().targets.length, 500); assert.equal(manager.get('host-500'), null); assert.deepEqual(observed.calls, []);
  state.targets = [null, {}, target('', 'sig'), target('invalid\nid'), target('no-signature', ''), target('duplicate'), target('duplicate'), target('valid')];
  manager.reconcile(); assert.deepEqual(manager.snapshot().targets.map(row => row.id), ['duplicate', 'valid']);
});

test('host-list errors and unknown host requests reject with safe messages without losing existing models', async t => {
  let fail = false;
  const { manager } = fixture(t, { listTargets: () => { if (fail) throw new Error('PRIVATE_PASSWORD from target config'); return [target()]; } });
  await manager.refresh('local'); fail = true;
  await assert.rejects(manager.refresh(), { message: '모델 정보를 조회할 호스트 목록을 읽지 못했습니다.' });
  assert.deepEqual(manager.get('local').models, [model()]); fail = false;
  await assert.rejects(manager.refresh('missing'), { message: '모델 정보를 조회할 호스트를 찾지 못했습니다.' });
});

test('atomic save failures preserve the previous file, clean temporary files and roll back interval changes', async t => {
  const { manager, filename, dataPath } = fixture(t); await manager.refresh('local');
  const previous = fs.readFileSync(filename, 'utf8'), rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => { if (to === filename) throw new Error('PRIVATE_FILE_PATH_PERMISSION'); return rename(from, to); });
  assert.throws(() => manager.configure({ intervalMinutes: 10 }), { message: SAVE_ERROR });
  assert.equal(manager.snapshot().intervalMinutes, 60); assert.equal(manager.get('local').modelError, SAVE_ERROR);
  assert.equal(fs.readFileSync(filename, 'utf8'), previous); assert.deepEqual(fs.readdirSync(dataPath), ['model-cache.json']);
  mocked.mock.restore(); manager.configure({ intervalMinutes: 10 });
  assert.equal(manager.snapshot().intervalMinutes, 10); assert.equal(manager.get('local').modelError, '');
});

test('a collection save failure reports a safe warning and a later refresh persists the recovered cache', async t => {
  const { manager, state, filename, dataPath } = fixture(t); await manager.refresh('local');
  const previous = fs.readFileSync(filename, 'utf8'), rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => { if (to === filename) throw new Error('PRIVATE_FILE_PERMISSION'); return rename(from, to); });
  state.response = result('updated'); state.time += MINUTE;
  const value = await manager.refresh('local'); assert.deepEqual(value.models, [model('updated')]); assert.equal(value.cacheStatus, 'ready'); assert.equal(value.modelError, SAVE_ERROR);
  assert.equal(fs.readFileSync(filename, 'utf8'), previous); assert.deepEqual(fs.readdirSync(dataPath), ['model-cache.json']);
  mocked.mock.restore(); await manager.refresh('local'); assert.equal(manager.get('local').modelError, '');
  const restored = fixture(t, { dataPath }); assert.deepEqual(restored.manager.get('local').models, [model('updated')]);
});

test('throwing change listeners do not interrupt collection and cannot modify the stored model list', async t => {
  const { manager } = fixture(t, { onChange: value => { value.targets[0].models.splice(0); throw new Error('listener'); } });
  assert.equal((await manager.refresh('local')).cacheStatus, 'ready'); assert.deepEqual(manager.get('local').models, [model()]);
});
