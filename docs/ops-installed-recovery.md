# Installed Ops original-thread recovery

`scripts/e2e-ops-installed-recovery.mjs` is a focused feature check for a native macOS private installation. It makes two genuine original goal turns and one genuine follow-up on A's original thread. It does not run a whole-product tour, publish a build, change a version, send a report, or test Windows. The daily comprehensive pre-release QA limit does not prevent this feature check.

The first Ops release has no prior public Ops conversation baseline. This lane therefore records an ordinary restart and a **same-candidate reinstall**, not an actual version update from an older Ops app. The existing public-version migration and native package checks retain their separate scope.

## Required inputs

- Use native macOS Node and an artifact for exactly that host architecture. Do not use Rosetta to claim native ARM coverage.
- Select one completed candidate package directory containing `build-info.json`, `verification-darwin-x64.json` or `verification-darwin-arm64.json`, and its legacy-compatible `ReviewOps-VERSION-test.BUILD-ARCH.zip`. The native report must be successful and include signature, extraction, packaged startup and Ops package/startup checks. A failed native candidate is not admitted.
- Set `REVIEWOPS_EXPECT_SOURCE_SHA` to its complete reviewed source commit. That Git object must be available locally. The harness compares every packaged Electron source file with that commit, validates the embedded build identity and checks ZIP size/SHA-256 before extraction and again before reinstall. The driver's current commit is recorded separately.
- Select the actual authenticated Codex executable by absolute path. The validated Ops baseline is `0.166.0-alpha.5.1`; the harness checks the selected CLI before starting a goal. It uses the existing authentication and Codex storage directly. It neither copies auth nor creates an isolated replacement `CODEX_HOME`.
- Keep the source helpers and Playwright dependencies installed. This lane reuses `inspectMac`, the archive validator, native host/window identity helpers, and the existing genuine CLI diagnostic tee. It does not build a package or alter the candidate ZIP.

Example after a valid Intel package is available:

```sh
REVIEWOPS_CANDIDATE_PACKAGE_DIR=/absolute/path/to/verified/test-darwin-x64 \
REVIEWOPS_EXPECT_SOURCE_SHA=FULL_REVIEWED_SOURCE_SHA \
REVIEWOPS_E2E_CODEX_BINARY=/absolute/path/to/authenticated/codex \
node scripts/e2e-ops-installed-recovery.mjs --real-codex
```

The explicit flag authorizes exactly three goal starts in this owned fixture: initial A, initial B and resumed A. The driver submits no additional request or steering message. A failed or unknown result stops the acceptance path; there is no automatic model retry or replacement-thread fallback. Each image interpretation has a bounded four-minute observation period.

## Recorded boundaries

1. Extract the verified ZIP into a fresh private installation. Confirm signature, architecture, package/source/build identity and original main-process ownership. Create exactly two registered projects with separate owned work folders, reviews and goals through the real application IPC. Start A and B through the actual Ops UI. Both use `workspace-write` and `never`, their own QA windows and actual PNG-only nonces. Pause both through the UI.
2. Close the app gracefully and confirm the original Electron process and every tracked wrapper/actual CLI child exited. Keep the app profile, work folders, selected CLI/auth environment and loopback server URL. Relaunch the same private executable. Require original paused goal/project/service/review/thread IDs, conversation, completed QA receipts and PNGs. Startup must send no model input or new `thread/start`.
3. Close and confirm cleanup again. Replace only the private app from the exact same verified ZIP at the same path. Check that data-file hashes were unchanged during replacement and that all bundle file hashes match the first installation. Relaunch with the same application data and work paths. Previous QA leases must not be silently adopted.
4. Change the owned canvas nonce and resume A through the actual UI. Require the original Codex thread ID, a legitimate new turn, real `ops_qa_*` calls and interpretation of the newly returned PNG. The new client/session/window/application lease must differ from its pre-restart lease while remaining bound to the original registered project. Pause A and confirm release. B keeps its original paused state, thread, conversation, receipts and capture files without another model turn.

The resulting B checks prove preservation, **not** B's resumed tool availability. Checking both original threads after reinstall would be a separate four-turn scope and must not be implied by this three-turn result.

The ordinary-restart stage observes metadata reconciliation and retention without a model turn. The actual original-A QA-tool invocation occurs after the cumulative ordinary-restart and same-candidate-reinstall boundaries; do not describe these as two separately executed recovery turns.

## Evidence and retention

Results are written under `test-results/ops-installed-recovery/TIMESTAMP/`. They include build/ZIP/CLI identities, phase checkpoints, actual full-window photographs, original PNG files with receipt/hash/size/dimensions, sanitized protocol metadata, original thread IDs, and Electron/wrapper/actual CLI process exit records. The tee forwards genuine protocol bytes unchanged; it never invents AI output. Image bytes remain PNG files rather than text or base64 in product history. Shell, file, network/search, subagent and other fallback tool items fail the check.

The isolated `/private/tmp/reviewops-ops-recovery-*` installation/profile remains in place after success or failure, including its `ops/state.json`, SQLite database, selected runtime, work folders and private PNG cache. Logical backup alone does not include that PNG cache. No real user project data is registered or changed. Existing Codex authentication is not copied into this directory; the three owned durable CLI conversations remain in their original Codex storage.

Review the full-window photographs for privacy and readability before sharing them. Remove the retained private installation/profile only after accepting the evidence and confirming all recorded owned processes are gone. If the driver crashes or cleanup is unconfirmed, inspect the existing original fixture before any continuation; rerunning from an empty profile does not repair or certify the failed original recovery.

This lane does not mutate global MCP settings, SSH trust, the user-installed app, public release files or updater pointers. Same-candidate copying is not an in-app updater test, a version migration, two-PC coverage or a comprehensive release QA result.
