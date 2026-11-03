# ARM packaged first-run CLI guidance

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
