# ARM packaged CLI diagnostics

The current test-only successor prepares one same-app missing→rescan observation
against the accepted R40 package. Its contract is described under “Same-app rescan
successor” below. The earlier first-run contract is retained here as a historical
reference; its source419/stable package assertions and its old branch admission
are not the source429/current package admission for this successor.

## Retained historical first-run CLI guidance

The `missing-cli-first-run` scenario checks the distinct issue #52 condition in
which a fresh ARM installation has no available Codex CLI. It opens the accepted
public ReviewOps 1.4.0 package once and checks installation/file-selection
guidance in Accounts. It does not repeat the accepted positive first-run UI run
41726405285 or alter production discovery/startup.

The package identity remains source `84042d8bb8d7d6f758d936d63f41fc325349550e`,
independent of the new reviewed harness commit. Its ZIP, executable, ASAR and
runtime hashes remain in `arm-first-run-ui-package.json`. The prior positive
workflow/source at `83f3804a2f73d75961202f069ba47330dada1746` and its eight inert
guard definitions are retained. This branch changes only the six diagnostic
paths; all 419 package-source files must retain their modes and Git blob IDs.

## One explicitly admitted missing-CLI lane

The manual workflow dispatches only `codex/issue52-arm-missing-cli-ui` at the
exact supplied `reviewed_commit`, first attempt, on genuine ARM macOS. It sets
`DIAGNOSTIC_SCENARIO=missing-cli-first-run`. The Python driver acquires only the
fixed public ReviewOps ZIP, checks its size/SHA and real ARM executable/ASAR,
and prepares a fresh private HOME, CODEX_HOME, empty SSH configuration and data
directory. `Applications` is empty; `.codex` contains only the fixed file-auth
`config.toml`. It does not download, copy, mount, remove or modify a vendor app,
CLI or user installation. No known user authentication is adopted.

The UI binding requires `schema: 1`, `scenario: missing-cli-first-run`,
`approvedForOneMissingCLIUILaunch: true` and `allowNormalStartupMetadata: true`.
The positive-only approval flag, `vendorApp`, `CLI`, `CLISHA256`, vendor identity
and vendor inventory pins are forbidden in this lane. Common inputs remain
`root`, `source`, `harnessSource`, the original Git-backed `sourceGuard`,
`privateRoot`, `home`, `codeHome`, `dataDir`, `sshConfig`, `packageApp`, the actual
`packageZipPin`, `expectedASARPin`, `actualNodeIdentity` and fresh UI `output`.
No supplied flag or fabricated positive vendor record can substitute for an
actual all-missing inventory.

The ASAR's exact runtime module and native-architecture companion are extracted
to an outside-app observer directory, checked against accepted bytes and source,
and used only for `defaultCandidates`/`platformTarget`. The packaged app's finder
is neither injected nor called by the observer. The inventory uses the actual
future app environment, private Node HOME and packaged resources directory.
Every actual default candidate must be missing. A present file, directory or
dangling candidate symlink blocks launch; permission and unknown errors also
block it. The diagnostic never removes an existing installation, filters a
candidate or supplies a custom path to manufacture the condition. Candidate
count is observed rather than fixed to the prior positive run's 63 rows.

The inventory is recorded before launch and checked again synchronously after
loading Playwright, immediately before its single launch request. An actual
host with a present candidate stops before the app is requested. No automatic
retry or fallback follows a failed preparation or UI stage. Source preparation
and inert guard results do not authorize a dispatch.

## Actual UI observation contract

Through the original app handle, the harness checks packaged ARM identity,
version 1.4.0, accepted executable/ASAR/resources paths, private Node HOME,
CODEX_HOME/data path and absent sensitive input environment names. The macOS OS
home may remain the runner's home; it is recorded separately, not presented as
an isolated OS account. Ordinary Accounts navigation waits for the mounted tab.

An initial `available: false` snapshot is insufficient. The harness waits for a
settled `runtime.errorKind: missing`, null path/version and actual missing
records, then checks the visible installation/file-selection notice, zero
accounts, absent `.runtime-summary`, visible Recheck/Choose executable buttons
and no login dialog. It does not click Recheck, Choose executable, Add account
or any login control. No `runtime.json` selection file may appear. A whole host
PNG and the separate state/visible-value JSON retain the actual result.

Normal automatic startup metadata (`--version`, `login status`, app-server
initialization/configuration/model-list reads) and updater checks are not
suppressed. Missing default inputs do not establish globally zero external
traffic or independently prove zero internal child launches. This lane does
not request OAuth submission, a model turn, account addition, a project or an
update installation. It makes no separate authentication claim.

## Ownership and limitations

The application and launcher ChildProcess can be retained only after
`_electron.launch` successfully returns its public handle. Stream observations
start at that point; byte counts do not attest earlier output. A launch rejection
before a public handle leaves ownership `UNKNOWN`; library cleanup/signals are
not independently observed and no PID is adopted for repair.

Normal cleanup requires the original application close, original launcher exit
and close, exit code 0/null signal, and actual stdout/stderr EOF plus closed
streams. A deadline writes `HELD` evidence and waits on the same original handles
without a second quit, wrapper signal, PID adoption or retry. The outer wrapper
must keep and drain its original driver too. Product-internal metadata controls
have their own existing cancellation policy; wrapper signals 0 is not a claim
that all internal children received no signals.

The original closure implementation is shared with the positive lane. After
cleanup the same actual default paths must still be missing; all three inventory
snapshots are retained. These are bounded observations, not a claim that every
system path remained absent between snapshots. Package members and the empty
private Applications directory must remain unchanged, with no private auth file.

The public ZIP transfer has a 45-second socket timeout, not a hard overall
network deadline. This lane has no vendor documentation/DMG transfer or mount.
The workflow's 20-minute outer limit can externally terminate the job; that
does not establish original app/driver/stream closure. A failed stage remains
failed after a late drain. Internal CLI/app-server handles are not exposed by
the public harness API, so their individual stdio/global process absence is not
claimed. No old C2 closure uncertainty is resolved by this lane.

## Inert admission checks

The original eight controlled positive definitions remain unchanged. Additional
pure definitions check scenario-specific authority and package/private/source
boundaries, actual all-missing input, rejection of present/unknown/dangling
candidates, and rejection of transient unavailable, permission/login or stale
summary states as a missing-CLI UI success. These tests import only diagnostic
pure guards and its compact reference JSON. Fake lstat results exercise guards;
no filesystem fixture, production import, app, CLI or network is executed.

A later actual ARM run can complement the missing-CLI guidance condition only.
It cannot complete actual OAuth, authenticated local model use, historical
reporter installation, user-app update recovery or all of issue #52. This
source-only diagnostic adds no formal native QA ID and does not change release
workflows or the older bundled-CLI diagnostic's admitted branch.


## Same-app rescan successor (source-only preparation)

The distinct `missing-cli-then-rescan` lane is prepared on
`codex/issue52-arm-rescan-ui`. The registered manual workflow is reused at its
exact reviewed branch commit, first attempt, with Node 24.22.2 and the existing
read-only permissions and serialized concurrency group. It does not dispatch a
release workflow, rebuild the product or change a version. A new genuine ARM
run is required; historical runs cannot prove this transition retrospectively.
The positive and negative exports and their stable package reference remain
intact, and their original branches/commits remain available. The manual job on
this successor is admitted only for the new branch/scenario.

The current product is the actual R40 public ARM ZIP, source
`2738216b9797312709775125d6cbe4983b96e226`, tree
`5c5ffccac84f2b9d9c976cb3bb4af7c4ad45b0ae`, 1.4.1-dev-2/build 40001.
Its size/SHA, selected ASAR and executable seals, embedded build, exact runtime
and native-architecture module bytes are separate from the old stable reference
under `rescan` in the package JSON. The current seals come from an accepted
cached-only selected-member CRC/read and inert ASAR-header observation; that
observation did not extract files, execute the app or validate signatures.
Unbound member seals are rejected before acquisition. The original 419-plus-six
source rule is not applied to the new lane: all 429 entries must exist, exactly
the six declared diagnostic paths may differ and all other 423 Git blobs and
modes must be unchanged. No production finder, account or startup code changes.

Before launch the preparer obtains a genuine official ARM vendor bundle using
the retained positive preparation's bounded official-page/DMG policy, exact
owned read-only mount, ordinary detach, ARM/minimum-OS checks and deep strict
Apple/OpenAI signatures. Actual future vendor version, hashes and receipts are
recorded; the earlier alpha.6 cohort is not copied into a new result. The stage
is outside HOME and every real default candidate, on the same private filesystem.
No fake bundle, CLI wrapper, finder/candidate override, PATH injection or manual
runtime selection is accepted.

One original app opens with a fresh private HOME/CODEX_HOME/userData, file-based
credential storage, empty SSH config and no accounts. All actual default paths
must be absent before and immediately before launch. After Accounts has settled
on the real missing state, the driver moves the verified stage once to the
previously absent private HOME/Applications destination with a same-filesystem
rename. It checks the unchanged inventory and first genuine candidate, confirms
the app still reports missing before the click, and clicks the unique actual
**Check CLI again** button once when enabled. The existing UI/server interval is
not bypassed. The same original PID, public handle, main page and private paths
must remain; actual state and visible summary must agree on the new canonical
path/version. Accounts remain zero; no auth.json or manual runtime.json may be
created. Two whole-window original PNGs retain the before/after observations.

The rescan result has separate missing and recovered predicates. Its final
candidate inventory deliberately contains the genuine vendor CLI; it cannot be
reported as the historical all-missing lane. Source/package bytes and the vendor
inventory remain unchanged apart from the declared private stage move. Private
runtime diagnostics and normal metadata cache updates are expected. Ordinary
metadata/version/login-status/app-server configuration/model-list reads are
allowed; no account addition, login, model generation, project/agent action,
executable chooser or vendor desktop launch is requested. Global zero traffic,
raw internal CLI child closure, real OAuth, an authenticated model turn, a real
user-app update and the reporter's exact historical installation are not proven.

Cleanup reuses the original app/launcher receipt contract above: one ordinary
quit, exit 0/null signal, application and child close, both EOF/closed streams,
plus the original driver closure. Unknown pre-handle ownership or late drain
stays UNKNOWN/HELD without adoption, signal, retry or a second app. No actual
same-app run has been accepted merely by preparing this source, and no formal
QA ID is added.
