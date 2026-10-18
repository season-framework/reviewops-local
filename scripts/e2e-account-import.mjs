import {setTestLocale} from './test-locale.mjs';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// The source below is synthetic. This suite never reads an installed manager's data.
// Its native Codex fixture permits --version only; all account process starts fail.
const root = process.cwd(), require = createRequire(import.meta.url);
const testRoot = fs.mkdtempSync(path.join('/tmp', 'reviewops-account-import-'));
const home = path.join(testRoot, 'home'), dataPath = path.join(testRoot, 'reviewops-data');
const sourceDir = path.join(testRoot, 'synthetic-manager-data'), targetDir = path.join(dataPath, 'codex-manager');
const configPath = path.join(home, '.ssh', 'config'), binaryPath = path.join(testRoot, 'fixture-codex');
const blockedPath = path.join(testRoot, 'blocked-account-processes.log'), versionPath = path.join(testRoot, 'version-checks.log');
for (const directory of [home, sourceDir, targetDir, path.dirname(configPath)]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(configPath, '# Isolated account import test\n', { mode: 0o600 });
const nativeSource = path.join(testRoot, 'fixture-codex.c');
fs.writeFileSync(nativeSource, `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    FILE *log = fopen(${JSON.stringify(versionPath)}, "a");
    if (log == NULL) return 71;
    fputs("version\\n", log); fclose(log);
    puts("codex-cli 0.162.1-import-fixture"); return 0;
  }
  FILE *log = fopen(${JSON.stringify(blockedPath)}, "a");
  if (log != NULL) { fputs("blocked account process\\n", log); fclose(log); }
  return 73;
}
`);
execFileSync(process.platform === 'darwin' ? '/usr/bin/clang' : '/usr/bin/cc', ['-O2', nativeSource, '-o', binaryPath], { stdio: 'pipe' });
const canonicalBinaryPath = fs.realpathSync(binaryPath);
fs.writeFileSync(path.join(targetDir, 'runtime.json'), JSON.stringify({ path: binaryPath }), { mode: 0o600 });
fs.writeFileSync(path.join(sourceDir, 'runtime.json'), JSON.stringify({ path: '/synthetic-original-manager.app/Contents/Resources/codex' }), { mode: 0o600 });

const now = new Date(), updatedAt = now.toISOString();
const yesterday = new Date(now.getTime() - 86400000), previousAt = yesterday.toISOString();
const twoDaysAt = new Date(now.getTime() - 2 * 86400000).toISOString();
const today = updatedAt.slice(0, 10), yesterdayDate = previousAt.slice(0, 10);
const expiresAt = new Date(now.getTime() + 7 * 86400000).toISOString();
const accounts = Array.from({ length: 3 }, (_, index) => {
  const id = crypto.randomUUID(), email = `fixture-import-${index + 1}@example.invalid`, idempotencyKey = crypto.randomUUID();
  const status = ['completed', 'pending', 'uncertain'][index], creditId = `fixture-credit-${index + 1}`;
  const primary = { usedPercent: 10 + index, windowDurationMins: 300, resetsAt: Math.floor(now.getTime() / 1000) + 3600 };
  const secondary = { usedPercent: 30 + index, windowDurationMins: 10080, resetsAt: Math.floor(now.getTime() / 1000) + 7200 };
  const bucket = { limitId: 'codex', limitName: 'Codex', primary, secondary, credits: { hasCredits: true, balance: String(100 + index), unlimited: false } };
  const outcome = status === 'completed' ? 'reset' : 'uncertain';
  const resetAttempt = { idempotencyKey, creditId, accountEmail: email, status, startedAt: twoDaysAt, ...(status === 'completed' ? { completedAt: previousAt, outcome: 'reset' } : {}), needsRefresh: true };
  const statistics = {
    version: 1, email, trackingStartedAt: twoDaysAt, updatedAt, usageFetchedAt: updatedAt, usageError: null,
    tokenUsage: { summary: { lifetimeTokens: (index + 1) * 10000000, peakDailyTokens: (index + 2) * 1000000, longestRunningTurnSec: 100 + index, currentStreakDays: 2, longestStreakDays: 3 }, dailyUsageBuckets: [{ startDate: yesterdayDate, tokens: (index + 1) * 1000000 }, { startDate: today, tokens: (index + 2) * 1000000 }] },
    snapshots: [{ time: previousAt, buckets: [{ limitId: 'codex', limitName: 'Codex', primary: { ...primary, usedPercent: 20 + index }, secondary }], creditBalance: 90 + index, creditsUnlimited: false, resetCredits: 1 + index }, { time: updatedAt, buckets: [{ limitId: 'codex', limitName: 'Codex', primary, secondary }], creditBalance: 100 + index, creditsUnlimited: false, resetCredits: 2 + index }],
    resets: [{ id: 'reset-' + crypto.createHash('sha256').update(`${id}:${idempotencyKey}`).digest('hex').slice(0, 32), time: status === 'completed' ? previousAt : twoDaysAt, requestedAt: twoDaysAt, outcome, usedCount: status === 'completed' ? 1 : null, timeKind: status === 'completed' ? 'completed' : 'requested' }]
  };
  return { id, label: `이관 합성 계정 ${index + 1}`, email, planType: 'plus', status: 'ready', usage: { rateLimits: bucket, rateLimitsByLimitId: { codex: bucket }, rateLimitResetCredits: { availableCount: 2 + index, credits: [{ id: creditId, status: 'available', resetType: 'codexRateLimits', expiresAt }] } }, lastUpdated: updatedAt, authStarted: true, statistics, resetAttempt };
});
const sourcePayload = { version: 1, accounts, activity: accounts.map(account => ({ id: crypto.randomUUID(), time: updatedAt, accountId: account.id, label: account.label, type: 'refresh', message: '합성 사용량을 저장했습니다.' })) };
fs.writeFileSync(path.join(sourceDir, 'accounts.json'), JSON.stringify(sourcePayload, null, 2), { mode: 0o600 });
for (const account of accounts) {
  const profile = path.join(sourceDir, 'profiles', account.id); fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n', { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'fixture-note.txt'), 'Synthetic profile without auth.json.\n', { mode: 0o600 });
}
function sourceManifest() {
  const result = {};
  const visit = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) visit(file); else result[path.relative(sourceDir, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } };
  visit(sourceDir); return result;
}
const originalManifest = sourceManifest();
const readTarget = () => JSON.parse(fs.readFileSync(path.join(targetDir, 'accounts.json'), 'utf8'));
const assertNoAccountProcesses = () => assert.equal(fs.existsSync(blockedPath), false, '계정 이관과 캐시 화면에서 Codex 계정 프로세스를 시작하면 안 됩니다.');
const checks = [], rendererErrors = [], externalRequests = [];
const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
let app, page, resultPath, version;
const pane = () => page.locator('.workspace-pane:not([hidden])');
const accountState = () => page.evaluate(() => window.accountManager.getState());
async function launch() {
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), REVIEWOPS_DATA_DIR: dataPath, REVIEWOPS_SSH_CONFIG: configPath, REVIEWOPS_CODEX_SSH_CONFIG: configPath };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_MANAGER_DATA_DIR', 'CODEX_MANAGER_SSH_CONFIG']) delete env[name];
  app = await electron.launch({ args: process.env.REVIEWOPS_TEST_EXECUTABLE ? [] : [root], executablePath: process.env.REVIEWOPS_TEST_EXECUTABLE, env, timeout: 30000 });
  page = await app.firstWindow(); await setTestLocale(page); page.setDefaultTimeout(12000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.reviewops?.invoke && window.accountManager?.getState));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1700, 1050));
  version = await app.evaluate(({ app }) => app.getVersion());
  resultPath = path.join(root, 'test-results', `account-import-v${version}`); fs.mkdirSync(resultPath, { recursive: true });
  await page.locator('.main-nav').getByRole('button', { name: '계정관리', exact: true }).click();
  await expect(pane().getByRole('table', { name: '계정 목록', exact: true })).toBeVisible();
}
async function stop() { if (!app) return; await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close(); app = null; }
async function verifyCachedAccounts() {
  const state = await accountState();
  assert.equal(state.runtime.available, true); assert.equal(state.runtime.path, canonicalBinaryPath);
  assert.equal(state.accounts.length, 3);
  for (const original of accounts) {
    const account = state.accounts.find(item => item.id === original.id);
    assert.ok(account); assert.equal(account.requiresLogin, true); assert.equal(account.status, 'signedOut');
    assert.deepEqual(account.usage, original.usage); assert.equal(account.lastUpdated, original.lastUpdated);
    const row = pane().getByRole('table', { name: '계정 목록', exact: true }).getByRole('row').filter({ has: page.getByRole('button', { name: `${original.label} 상세 통계`, exact: true }) });
    await expect(row).toContainText('다시 로그인 필요');
    await expect(row.getByRole('button', { name: '로그인', exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: `${original.label} 초기화권 목록`, exact: true })).toBeDisabled();
    await expect(row).toContainText(`${100 - original.usage.rateLimits.primary.usedPercent}%`);
    for (const label of ['초기화권 사용', '결과 다시 확인', '사용량 새로고침']) {
      const action = row.getByRole('button', { name: label, exact: true }); if (await action.count()) await expect(action).toBeDisabled();
    }
  }
  await expect(pane().getByRole('button', { name: '새로고침', exact: true })).toBeDisabled();
  const raw = readTarget();
  for (const original of accounts) {
    const account = raw.accounts.find(item => item.id === original.id);
    assert.equal(account.requiresLogin, true);
    for (const field of ['idempotencyKey', 'creditId', 'accountEmail', 'startedAt', 'completedAt', 'outcome', 'needsRefresh']) assert.deepEqual(account.resetAttempt[field], original.resetAttempt[field]);
    assert.equal(account.resetAttempt.status, original.resetAttempt.status === 'pending' ? 'uncertain' : original.resetAttempt.status);
    assert.deepEqual(account.statistics.tokenUsage, original.statistics.tokenUsage);
    assert.deepEqual(account.statistics.snapshots, original.statistics.snapshots);
    assert.equal(account.statistics.resets.length, original.statistics.resets.length);
  }
  assertNoAccountProcesses(); return state;
}

try {
  const { importAccounts } = require('../electron/codex/import-accounts.cjs');
  const imported = await importAccounts({ sourceDir, targetDir, allowImport: true });
  assert.equal(imported.importedCount, 3); assert.equal(imported.requiresLoginCount, 3); assert.equal(imported.authCopiedCount, 0);
  assert.equal(imported.runtimeImported, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(targetDir, 'runtime.json'), 'utf8')).path, binaryPath);
  for (const original of accounts) {
    const importedAccount = readTarget().accounts.find(item => item.id === original.id);
    assert.equal(importedAccount.requiresLogin, true); assert.equal(importedAccount.status, 'signedOut');
    assert.deepEqual(importedAccount.usage, original.usage); assert.deepEqual(importedAccount.statistics, original.statistics); assert.deepEqual(importedAccount.resetAttempt, original.resetAttempt);
    assert.equal(fs.existsSync(path.join(targetDir, 'profiles', original.id, 'auth.json')), false);
  }
  assert.deepEqual(sourceManifest(), originalManifest); assertNoAccountProcesses();
  passed('계정 3개의 사용량·통계·초기화 요청 번호와 프로필을 실제 계정 조작 없이 이관');

  await launch(); await verifyCachedAccounts();
  await expect(pane().getByRole('table', { name: '계정 목록', exact: true }).getByRole('row')).toHaveCount(4);
  await expect(pane().getByRole('status').filter({ hasText: '다시 로그인해야 합니다.' })).toBeVisible();
  await page.screenshot({ path: path.join(resultPath, 'account-list.png') });
  passed('가져온 계정 3개에 저장된 사용량과 다시 로그인 필요 상태 표시');

  await pane().getByRole('checkbox', { name: '모든 계정 선택', exact: true }).check();
  await expect(pane().getByRole('button', { name: '선택 새로고침', exact: true })).toBeDisabled();
  await expect(pane().getByRole('button', { name: '선택 계정 초기화권 사용', exact: true })).toBeDisabled();
  await pane().getByRole('button', { name: '선택 해제', exact: true }).click();
  assertNoAccountProcesses();
  passed('다시 로그인하기 전 조회·초기화·선택 계정 작업 비활성화 및 로그인 버튼 제공');

  for (const [index, original] of accounts.entries()) {
    const details = await page.evaluate(id => window.accountManager.getAccountDetails(id), original.id);
    assert.deepEqual(details.tokenUsage, original.statistics.tokenUsage); assert.deepEqual(details.snapshots, original.statistics.snapshots); assert.equal(details.resets.length, 1);
    await pane().getByRole('button', { name: `${original.label} 상세 통계`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `${original.label} 상세 통계`, exact: true });
    await expect(dialog.getByRole('button', { name: '통계 새로고침', exact: true })).toBeDisabled();
    await expect(dialog).toContainText('저장된 통계입니다.');
    await expect(dialog.locator('.details-summary')).toContainText(`${(index + 1) * 10}M`);
    await expect(dialog.getByRole('table', { name: '기간별 사용량', exact: true })).toContainText(`${index + 2}M`);
    await dialog.getByRole('tab', { name: '잔여량 변화', exact: true }).click();
    await expect(dialog.getByRole('table', { name: '잔여량 조회 기록', exact: true })).toContainText(`${90 - index}%`);
    await expect(dialog.getByRole('table', { name: '초기화권 사용 기록', exact: true })).toBeVisible();
    if (index === 0) await page.screenshot({ path: path.join(resultPath, 'cached-statistics.png') });
    await dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
    assertNoAccountProcesses();
  }
  passed('계정별 상세 사용량·잔여량·초기화 기록을 캐시에서 표시하고 실제 조회 차단');

  const beforeRestart = await verifyCachedAccounts(); await stop();
  const beforeRepeat = readTarget();
  const repeated = await importAccounts({ sourceDir, targetDir, allowImport: true });
  assert.equal(repeated.importedCount, 0); assert.equal(repeated.alreadyImported, true);
  assert.deepEqual(readTarget(), beforeRepeat); assert.deepEqual(sourceManifest(), originalManifest);
  passed('같은 원본을 다시 이관해도 계정·통계·초기화 요청을 중복 생성하지 않음');

  await launch(); const afterRestart = await verifyCachedAccounts();
  assert.deepEqual(afterRestart.accounts, beforeRestart.accounts);
  assert.equal(readTarget().accounts.length, 3); assert.deepEqual(sourceManifest(), originalManifest);
  assert.deepEqual(rendererErrors, []); assert.deepEqual(externalRequests, []); assertNoAccountProcesses();
  assert.ok(fs.existsSync(versionPath));
  passed('재실행 후 계정과 통계 유지, 원본 변경·계정 RPC·외부 HTTP 요청·화면 오류 없음');
  const report = { ok: true, version, checks, importedAccounts: 3, requiresLoginAccounts: 3, copiedAuthFiles: 0, accountProcesses: 0, accountLogins: 0, creditOperations: 0, rendererErrors, externalRequests, testRoot, executable: process.env.REVIEWOPS_TEST_EXECUTABLE || 'development' };
  fs.writeFileSync(path.join(resultPath, process.env.REVIEWOPS_TEST_EXECUTABLE ? 'dmg.json' : 'source.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(testRoot, 'failure.png') }).catch(() => {});
  if (resultPath) fs.writeFileSync(path.join(resultPath, process.env.REVIEWOPS_TEST_EXECUTABLE ? 'dmg.json' : 'source.json'), JSON.stringify({ ok: false, checks, error: error.message, testRoot }, null, 2));
  console.error('ACCOUNT IMPORT FAILURE', testRoot, error); process.exitCode = 1;
} finally { await stop().catch(() => {}); }
