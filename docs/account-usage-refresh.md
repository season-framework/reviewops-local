# Automatic account usage refresh

ReviewOps refreshes signed-in accounts in the main process every 30 minutes by default, including while the account page is closed or the window is minimized. Change **Settings → Automatic checks → Account usage refresh interval** to an integer from 1 to 1440 minutes. Saving applies the interval immediately and preserves it across app restarts.

Startup and power-resume checks refresh missing or overdue data once. Missed intervals are not replayed. Each account uses its last successful summary/detail timestamps and last full usage-cycle attempt to determine its next due time; failed reads wait for the configured interval before another automatic attempt. A fresh resume does not force another request. Manual quota-only reads do not postpone detailed-usage collection. Future persisted timestamps after a clock correction are refreshed rather than treated as freshness evidence.

A failed account keeps its last received values and successful timestamps. The account list and detail view show failure information alongside the retained data. Detailed usage is collected through the account's supported usage API; unsupported detail responses are shown as unavailable rather than invented values. Accounts requiring login remain visible and are not queried automatically.

Automatic summary/detail collection shares in-flight work with manual refreshes, keeps existing per-account login/reset coordination, and uses the existing bounded read queue. A failure in one account does not prevent the other accounts from refreshing. Summary and detail-cache changes are published to open account views.

The interval is saved in the existing private `codex-manager/accounts.json` file. It does not change account profiles or copy credentials. The scheduler and power-resume listener stop when the account manager closes or its selected runtime is replaced.

## Focused validation

`node --test tests/account-usage-refresh.test.cjs tests/codex-manager.test.cjs` covers default and changed scheduling, overdue startup/resume, no catch-up burst, configuration persistence, failed-read retention/recovery, manual overlap and manager shutdown.

After building, `node scripts/e2e-usage-refresh.mjs` runs source Electron with isolated synthetic account RPC responses. It checks the default setting, saves a one-minute interval, observes real timer refreshes with the window minimized, retains data through one failed interval, recovers on the next interval, and checks restart persistence. These fixture results do not establish production-service connectivity, thirty minutes of wall-clock operation, physical sleep or packaged-platform acceptance.
