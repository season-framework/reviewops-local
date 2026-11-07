# Hosted hidden web capture diagnostic

This branch contains a standalone synthetic Electron experiment. It does not load
ReviewOps, change its product code, run a renderer build, package an application,
publish a release or perform installed-app QA. A completed diagnostic job is not a
passed product gate.

## Evidence and question

In integration run `41347819871`, source `95e671e9c8aea2cc088bc4497e7da3f4d7b647f4`,
Windows completed live14. QA8 completed its first five groups, then its Home preview
remained busy. The saved snapshot **before** any effectful `browser.state` query
contains `viewerSession.preview` pending for 5096 ms and the original target's
`capturePage(undefined, {stayHidden:true})` pending for 5094 ms. No CDP operation,
load failure or renderer exit was pending/reported. The same target previously
captured visible 310×207 PNGs in 1 and 4 ms. After Home hid its child clip window,
the parent remained visible. The separate post-failure `stayHidden:false` request
also timed out after 2003 ms on that already-pending target.

The latter does not test a fresh default-options target. `document.visibilityState`
being `visible` and successful JavaScript do not establish that the native window's
compositor can present/copy its surface. The current evidence identifies the
native capture await; it does not establish a single upstream root cause or a fix.

## Independent cases

Each row launches a fresh Electron process, in-memory partition and owned temporary
profile. It creates the product's parent → frameless child clip window →
WebContentsView graph, beginning with the child at 1×1 before applying the recorded
310×207 view size and 1200×800 emulation with scale `310/1200`. It captures a visible
native baseline, hides the child, updates only a synthetic canvas marker, waits
five seconds, then issues one hidden request with a five-second deadline.

| Case | Hidden request | Target throttling | Purpose |
| --- | --- | --- | --- |
| native-hidden | `capturePage(undefined,{stayHidden:true})` | true | Reproduce the product's capture choice |
| native-default | `capturePage()` | true | Isolate a fresh default-options request from an already stalled request |
| native-unthrottled | Native, `stayHidden:true` | false from creation | Test target rendering/throttling without changing global defaults |
| cdp-surface | `Page.captureScreenshot`, `fromSurface:true` | true | Compare Chromium's surface screenshot path |
| cdp-view | Same command, `fromSurface:false` | true | Compare the browser/view snapshot path |
| native-hidden-focus-emulated | Native, `stayHidden:true`; focus emulation enabled before baseline | true | Isolate Playwright's persistent visible-capturer state in a fresh source |
| native-default-focus-emulated | Native, default options; focus emulation enabled before baseline | true | Separate that state from the native capture option |
| native-temporary-unthrottled | Native, `stayHidden:true` | true, false only after hide and restored afterward | Conditional follow-up only when the from-creation case returns a fresh frame and preserves source/geometry |

The experiment records source WebContents ID, DOM instance, unsaved form, URL,
request count, view/clip bounds, viewport/DPR, target throttling, native visibility,
RAF counter, lifecycle events, operation outcome and timing. Identity, form,
request count and geometry must remain unchanged. The baseline marker is red; it
is changed to blue **after** hide. Sampling original decoded PNG pixels distinguishes
a fresh hidden source frame from a cached visible baseline. PNG size/hash and that
one marker sample are recorded; PNG files and image base64 are never written or
logged. No capture modifies the form or navigates/recreates the source.

Timeout/rejection and a returned stale frame remain explicit diagnostic outcomes.
The target is destroyed afterward; a second capture is never issued on a graph
with a pending request. The parent Node process independently kills only its
owned child process tree after 35 seconds. A source/geometry violation or setup
failure fails the diagnostic job. Seven primary cases plus one conditional case
fit inside the six-minute probe step and ten-minute job bounds (eight maximum
cases × 35-second child watchdog = 280 seconds). The five original comparisons
remain separate from the two focus-emulation cases and one conditional follow-up.

`stayAwake:true` is omitted initially: it controls the sleep wake lock, while the
observed hosted runner was active. A later power-state experiment can separate
that factor if these results justify it. No display mode, desktop capture,
permission grant, GPU flag, feature flag or user profile changes are performed.

## Primary implementation references

- [Electron 44.9.0 capture implementation](https://github.com/electron/electron/blob/v44.9.0/shell/browser/api/electron_api_web_contents.cc#L3907):
  `capturePage` checks the current surface, acquires a capturer handle and calls
  `CopyFromSurface` with a zero timeout. Completion releases the handle through
  the callback. Its public Promise has no cancellation parameter.
- [Electron capture options](https://www.electronjs.org/docs/latest/api/web-contents/#contentscapturepagerect-opts):
  default `stayHidden` is false; a page's capture visibility differs from its
  window visibility. Disabling background throttling also affects Page Visibility.
- [Electron's earlier Windows/Linux fix, #39730](https://github.com/electron/electron/pull/39730):
  documents an older occlusion case in which a surface-copy callback did not run.
  This history supports investigating surface lifecycle, but does not prove this
  is the same regression in 44.9.0.
- [Chromium 152 screenshot paths](https://github.com/chromium/chromium/blob/152.0.7977.167/content/browser/devtools/protocol/page_handler.cc#L1293):
  the surface path can temporarily change emulation and view size; the view path
  explicitly does not support clip/emulation. A nearby implementation comment
  explains that a completely hidden surface screenshot can stall without
  presentation. These alternatives require source/viewport/crop validation before
  any production use.
- [Chromium 152 capture visibility](https://github.com/chromium/chromium/blob/152.0.7977.167/content/browser/web_contents/web_contents_impl.cc#L2490):
  hidden and visible capturer counts are distinct. The resulting hidden-but-painting
  page state is not the same as revealing a native window.
- [Electron 44.9.0 dependency identity](https://github.com/electron/electron/blob/v44.9.0/DEPS#L3):
  pins Chromium `152.0.7977.167` for the source references above.
- [Playwright 1.64.1 page initialization](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/chromium/crPage.ts):
  enables focus emulation on main-frame targets by default. The locally installed
  version used by the integration harness is 1.64.1.
- [Chromium focus emulation](https://github.com/chromium/chromium/blob/152.0.7977.167/content/browser/devtools/protocol/emulation_handler.cc#L931):
  enabling it retains a visible capturer handle until it is disabled. This can
  explain `isBeingCaptured:true` before any native screenshot and `visibilityState`
  remaining visible. It is a separate variable, not proof of an automation defect.
  The direct Electron cases do not enable it; the two explicitly named cases
  enable it once before the visible baseline. Both record `isBeingCaptured`
  before and after that baseline; this API returns a boolean, not a numeric count.

## Product decision after this experiment

Do not choose `stayHidden:false` from the already-pending probe, increase the QA
timeout, remove the native gates or globally disable throttling. If a fresh native
variant works, repeat source-identity, form, network-count and pixel/crop checks in
the actual QA8 flow before selecting it. A temporary target-only throttling change
is a candidate only if its own case and restoration checks pass; its Page
Visibility/timer effects must remain explicit. A CDP result alone is insufficient
to substitute its different pixel/viewport semantics for the product's native PNG.

A separate bounded product error path can keep the UI responsive on an unresolved
capture, invalidate its intent/proof and reject late completion. Because a timeout
does not cancel Electron's native request, it also needs one-in-flight protection
per source. Retrying indefinitely or reloading/destroying a user's source to
recover a screenshot would lose the preservation guarantee. No such product fix
is included in this diagnostic branch.

## Invocation and review boundary

The workflow runs on an original `codex/hidden-web-capture-probe` push or an
explicit manual dispatch of `main` in the original repository, on GitHub-hosted Windows x64 and Intel macOS. Both launcher
and app refuse local/self-hosted/unrelated contexts. It uses the existing pinned
checkout/setup-node/upload actions, Node 24, `npm ci` and JSON-only artifacts with
one-day retention and a prefix outside publication cleanup.

Pure boundary checks: `node --test tests/hidden-web-capture-probe.test.cjs`.
Native invocation is the workflow's `node scripts/hidden-web-capture-probe.mjs`.
The branch must be reviewed before any commit/push and native execution. No local
Electron experiment was executed when preparing it.

After integration, see [the virtual display integration status](virtual-display-integration.md) for current execution gates and remaining product acceptance. Historical observations above describe their original source and run.
