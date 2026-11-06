'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AccountService } = require('../electron/codex/account-service.cjs');
const { AccountUsageRefresher } = require('../electron/codex/usage-refresh.cjs');
const MINUTE = 60_000;
const settle = () => new Promise(resolve => setImmediate(resolve));
const quota = () => ({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 }, secondary: null } });
const details = () => ({ summary: { lifetimeTokens: 400 }, dailyUsageBuckets: [] });

function timerHarness(accounts = []) {
  let time = Date.parse('2026-11-06T10:00:00Z'), nextId = 0;
  const calls = [], timers = new Map();
  const service = { accounts, removing: new Set(), resetTasks: new Map(), usageRefreshIntervalMinutes: 30,
    async refreshUsage(id) {
      calls.push(id);
      const account = accounts.find(row => row.id === id);
      account.lastUpdated = account.lastUsageRefreshAttemptAt = new Date(time).toISOString();
      account.statistics = { usageFetchedAt: account.lastUpdated };
    } };
  const refresher = new AccountUsageRefresher({ service, now: () => time,
    setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id) });
  return { service, refresher, calls, timers, now: () => time,
    async advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); } await settle(); } };
}

async function serviceHarness(t, custom = async () => undefined) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewops-usage-refresh-'));
  const calls = [], changes = [];
  class Client extends EventEmitter {
    constructor(config) { super(); this.id = path.basename(config.env.CODEX_HOME); }
    async start() { return this; }
    async request(method) {
      calls.push({ id: this.id, method });
      const value = await custom(this.id, method);
      if (value !== undefined) return value;
      if (method === 'account/read') return { account: { type: 'chatgpt', email: this.id + '@example.invalid', planType: 'plus' } };
      if (method === 'account/rateLimits/read') return quota();
      if (method === 'account/usage/read') return details();
      return {};
    }
    close() { this.closed = true; this.emit('close'); }
  }
  const config = { dataDir, command: '/fixture/codex', clientFactory: options => new Client(options), onChange: state => changes.push(state) };
  const service = new AccountService(config); await service.init();
  t.after(async () => { await service.close(); await fs.rm(dataDir, { force: true, recursive: true }); });
  const add = async () => (await service.addAccount('Usage test account')).accounts.at(-1).id;
  return { service, config, calls, changes, add, dataDir };
}

test('startup refreshes missing or overdue signed-in data without opening an account page', async () => {
  const recent = '2026-11-06T09:50:00Z';
  const h = timerHarness([
    { id: 'missing', email: 'missing@example.invalid' },
    { id: 'old', email: 'old@example.invalid', lastUpdated: '2026-11-06T08:00:00Z' },
    { id: 'fresh', email: 'fresh@example.invalid', lastUpdated: recent, statistics: { usageFetchedAt: recent } },
    { id: 'logged-out', requiresLogin: true, email: 'out@example.invalid' },
    { id: 'unused', status: 'signedOut' },
  ]);
  await h.refresher.run();
  assert.deepEqual(h.calls, ['missing', 'old']);
  await h.advance(19 * MINUTE); assert.equal(h.calls.length, 2);
  await h.advance(MINUTE); assert.deepEqual(h.calls, ['missing', 'old', 'fresh']);
  await h.advance(10 * MINUTE); assert.deepEqual(h.calls, ['missing', 'old', 'fresh', 'missing', 'old']);
  h.refresher.close(); assert.equal(h.timers.size, 0);
});

test('sleep resume coalesces missed intervals into one refresh and reuses an in-flight batch', async () => {
  const h = timerHarness([{ id: 'a', email: 'a@example.invalid' }]);
  await h.refresher.run();
  let release;
  const original = h.service.refreshUsage;
  h.service.refreshUsage = async id => { await new Promise(resolve => { release = resolve; }); await original(id); };
  await h.advance(6 * 60 * MINUTE);
  const resumed = h.refresher.run();
  assert.equal(h.refresher.run(), resumed);
  release(); await resumed;
  assert.deepEqual(h.calls, ['a', 'a']);
  await h.advance(29 * MINUTE); assert.equal(h.calls.length, 2);
  h.refresher.close();
});

test('interval changes reschedule existing accounts without a restart or a request burst', async () => {
  const h = timerHarness([{ id: 'a', email: 'a@example.invalid' }]);
  await h.refresher.run(); await h.advance(10 * MINUTE);
  h.service.usageRefreshIntervalMinutes = 5;
  await h.refresher.run(); assert.equal(h.calls.length, 2);
  await h.refresher.run(); assert.equal(h.calls.length, 2);
  await h.advance(5 * MINUTE); assert.equal(h.calls.length, 3);
  h.refresher.close();
});

test('refresh settings validate and persist while old account files default to thirty minutes', async t => {
  const h = await serviceHarness(t);
  assert.equal(h.service.snapshot().usageRefresh.intervalMinutes, 30);
  for (const value of [0, -1, 1441, 1.5, '5', null]) await assert.rejects(h.service.configureUsageRefresh(value), /1~1440/);
  await h.service.configureUsageRefresh(17);
  const saved = JSON.parse(await fs.readFile(path.join(h.dataDir, 'accounts.json')));
  assert.equal(saved.usageRefreshIntervalMinutes, 17);
  await h.service.close();
  const reloaded = new AccountService(h.config); await reloaded.init(); t.after(() => reloaded.close());
  assert.equal(reloaded.snapshot().usageRefresh.intervalMinutes, 17);
  assert.equal(h.calls.length, 0);
});

test('automatic and manual refresh share an account cycle and publish detail-cache updates', async t => {
  let release, hold = false;
  const h = await serviceHarness(t, async (_id, method) => {
    if (hold && method === 'account/usage/read') await new Promise(resolve => { release = resolve; });
  });
  const id = await h.add(); hold = true;
  const automatic = h.service.refreshUsage(id);
  while (!release) await settle();
  const manual = h.service.refreshAccounts([id]);
  const detail = h.service.refreshAccountDetails(id);
  release(); await Promise.all([automatic, manual, detail]);
  assert.equal(h.calls.filter(row => row.method === 'account/rateLimits/read').length, 1);
  assert.equal(h.calls.filter(row => row.method === 'account/usage/read').length, 1);
  assert.equal(h.service.snapshot().accounts[0].usageDetailsUpdatedAt, h.service.getAccountDetails(id).usageFetchedAt);
  assert.ok(h.changes.some(state => state.accounts[0]?.usageDetailsUpdatedAt));
});

test('failed automatic reads retain successful values and time, recover later, and do not block other accounts', async t => {
  let failedId = null;
  const h = await serviceHarness(t, async (id, method) => {
    if (id === failedId && method === 'account/rateLimits/read') throw new Error('Synthetic network failure');
  });
  const first = await h.add(), second = await h.add();
  await Promise.all([h.service.refreshUsage(first), h.service.refreshUsage(second)]);
  const before = h.service.snapshot().accounts[0], beforeDetails = h.service.getAccountDetails(first);
  failedId = first;
  await Promise.all([h.service.refreshUsage(first), h.service.refreshUsage(second)]);
  const failed = h.service.snapshot().accounts[0];
  assert.deepEqual(failed.usage, before.usage); assert.equal(failed.lastUpdated, before.lastUpdated);
  assert.deepEqual(h.service.getAccountDetails(first).tokenUsage, beforeDetails.tokenUsage);
  assert.equal(failed.status, 'error'); assert.equal(h.service.snapshot().accounts[1].status, 'ready');
  const refresher = new AccountUsageRefresher({ service: h.service });
  const count = h.calls.length; await refresher.run(); await refresher.run();
  assert.equal(h.calls.length, count, 'a failure must not trigger immediate automatic retries');
  failedId = null; await h.service.refreshUsage(first);
  assert.equal(h.service.snapshot().accounts[0].status, 'ready');
  refresher.close();
});

test('manual quota-only activity cannot postpone the detailed-usage deadline', async t => {
  const h = timerHarness([{ id: 'a', email: 'a@example.invalid' }]);
  await h.refresher.run();
  await h.advance(20 * MINUTE);
  h.service.accounts[0].lastUpdated = new Date(h.now()).toISOString();
  h.refresher.schedule();
  await h.advance(5 * MINUTE);
  h.service.accounts[0].lastUpdated = new Date(h.now()).toISOString();
  h.refresher.schedule();
  await h.advance(5 * MINUTE);
  assert.equal(h.calls.length, 2, 'the original thirty-minute detail deadline still runs');
  h.refresher.close();
  const actual = await serviceHarness(t), id = await actual.add();
  await actual.service.refreshUsage(id);
  const fullAttempt = actual.service.accounts[0].lastUsageRefreshAttemptAt;
  await actual.service.refreshAccounts([id]);
  assert.equal(actual.service.accounts[0].lastUsageRefreshAttemptAt, fullAttempt);
});

test('future persisted clock dates cannot overflow the timer or cause a refresh hot loop', async () => {
  const future = '2036-11-06T10:00:00Z';
  const h = timerHarness([{ id: 'a', email: 'a@example.invalid', lastUpdated: future, lastUsageRefreshAttemptAt: future, statistics: { usageFetchedAt: future } }]);
  h.refresher.schedule();
  const initial = [...h.timers.values()][0];
  assert.ok(initial.at - h.now() >= MINUTE);
  assert.ok(initial.at - h.now() <= 2 ** 31 - 1);
  await h.advance(MINUTE); assert.equal(h.calls.length, 1);
  await h.advance(1000); assert.equal(h.calls.length, 1);
  assert.ok([...h.timers.values()][0].at - h.now() > MINUTE);
  h.refresher.close();
});

test('manual detail work completed during automatic checkpoint saving is not collected twice', async t => {
  const h = await serviceHarness(t), id = await h.add();
  await h.service.refreshAccounts([id]);
  h.calls.length = 0;
  const save = h.service._save.bind(h.service);
  let release, saving;
  const entered = new Promise(resolve => { saving = resolve; });
  h.service._save = async () => { h.service._save = save; saving(); await new Promise(resolve => { release = resolve; }); return save(); };
  const automatic = h.service.refreshUsage(id); await entered;
  await h.service.refreshAccountDetails(id);
  release(); await automatic;
  assert.equal(h.calls.filter(row => row.method === 'account/usage/read').length, 1);
  assert.equal(h.calls.filter(row => row.method === 'account/rateLimits/read').length, 1);
});

test('login beginning during an automatic checkpoint prevents a stale background account read', async t => {
  const h = await serviceHarness(t, async (_id, method) => {
    if (method === 'account/login/start') return { loginId: 'usage-login', authUrl: 'https://auth.openai.com/usage-fixture' };
  });
  const id = await h.add();
  const save = h.service._save.bind(h.service);
  let release, saving;
  const entered = new Promise(resolve => { saving = resolve; });
  h.service._save = async () => { h.service._save = save; saving(); await new Promise(resolve => { release = resolve; }); return save(); };
  const automatic = h.service.refreshUsage(id); await entered;
  const login = h.service.login(id);
  release(); await Promise.all([automatic, login]);
  assert.equal(h.calls.filter(row => row.method === 'account/rateLimits/read').length, 0);
  assert.equal(h.calls.filter(row => row.method === 'account/login/start').length, 1);
  assert.equal(h.service.snapshot().accounts[0].status, 'loggingIn');
});
