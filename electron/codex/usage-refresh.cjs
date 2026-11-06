'use strict';

const MINUTE = 60_000;
const MAX_TIMER_DELAY = 2 ** 31 - 1;
const DEFAULT_USAGE_REFRESH_MINUTES = 30;

function usageRefreshInterval(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new Error('계정 사용량 갱신 주기는 1~1440분 사이의 정수로 입력하십시오.');
  }
  return value;
}

// This main-process timer does not depend on the selected page or window visibility.
class AccountUsageRefresher {
  constructor({ service, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.service = service;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = null;
    this.closed = false;
  }

  eligible(account) {
    return !account.requiresLogin && (account.email || account.usage || account.authStarted)
      && account.status !== 'loggingIn' && !this.service.removing.has(account.id);
  }

  dueAt(account) {
    // Future persisted dates after a clock correction are not freshness evidence.
    const timestamp = value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= this.now() ? Date.parse(value) : 0;
    const lastSuccess = Math.min(timestamp(account.lastUpdated), timestamp(account.statistics?.usageFetchedAt));
    return Math.max(lastSuccess, timestamp(account.lastUsageRefreshAttemptAt))
      + this.service.usageRefreshIntervalMinutes * MINUTE;
  }

  schedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed || this.running) return;
    const accounts = this.service.accounts.filter(account => this.eligible(account));
    if (!accounts.length) return;
    const due = Math.min(...accounts.map(account => this.dueAt(account)));
    // Busy profiles are retried on a bounded timer, never in a catch-up loop.
    this.timer = this.setTimer(() => { this.timer = null; void this.run(); }, Math.min(MAX_TIMER_DELAY, Math.max(MINUTE, due - this.now())));
    this.timer?.unref?.();
  }

  run() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    const accounts = this.service.accounts.filter(account => this.eligible(account)
      && account.status !== 'loading' && !this.service.resetTasks.has(account.id)
      && this.dueAt(account) <= this.now());
    const task = Promise.allSettled(accounts.map(account => this.service.refreshUsage(account.id)))
      .finally(() => { if (this.running === task) this.running = null; this.schedule(); });
    this.running = task;
    return task;
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = { AccountUsageRefresher, DEFAULT_USAGE_REFRESH_MINUTES, usageRefreshInterval };
