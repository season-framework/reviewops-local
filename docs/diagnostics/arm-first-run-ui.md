# ARM packaged first-run CLI discovery

This manual diagnostic checks one remaining condition from issue #52: a fresh
ARM installation finds an authentic desktop-app CLI and shows its path and
version in account management without choosing an executable. The public
ReviewOps package and the future diagnostic checkout have separate identities.
The fixed package is stable 1.4.0, source `84042d8`, with its ZIP, executable,
ASAR and runtime hashes in `arm-first-run-ui-package.json`.

This is a positive-only lane. It does not log in, submit an account-add form,
generate a model response, create a project or install an update. Normal startup
still performs automatic `--version`, `login status`, app-server initialization,
`config/read` and `model/list` metadata work. The updater can check the stable
release as usual. Empty credentials do not prove zero external traffic.

## Preparation boundary

The `arm-first-run-ui.py` preparation driver and the separate manual
workflow own acquisition, native metadata tools and ordinary mount detachment.
The JavaScript UI harness never downloads or mounts a package. Preparation must:

1. Verify the reviewed diagnostic checkout against base source `84042d8`: all
   419 old tracked files remain unchanged, and every added path is one of this
   diagnostic's reviewed files. Record the actual added-path count rather than
   assuming a fixed total. Do not change the old ARM diagnostic's admitted-ref
   gate or either release workflow.
2. Acquire the fixed public ARM ZIP once and verify its actual size/SHA. Extract
   it into a fresh private installation and bind the actual executable/ASAR.
   Source `84042d8` belongs to these installed bytes, not to the future harness
   commit. Stable build metadata remains absent/null.
3. Acquire an authentic current vendor bundle with bounded original transfers.
   Record its actual bundle version/build instead of copying a historical
   version. Verify ARM CLI architecture and deep/strict Apple-anchor/OpenAI
   signatures on the app and CLI, both with Team ID `2DC432GLL2`. Preserve
   original tool receipts and the exact `bundle_inventory` list. Detach only
   the original owned read-only mount normally before any CLI/app launch.
4. Prepare a fresh private HOME containing only `Applications`, `.codex` and
   `.ssh`; put the vendor app under the supported `Applications/ChatGPT.app`
   or `Applications/Codex.app` location. `.codex` contains only `config.toml`
   with `cli_auth_credentials_store = "file"` and a final newline. The SSH
   config is empty. The ReviewOps data directory is absent or empty. No user
   profiles, tokens, SSH agent, Node hooks or executable overrides are adopted.

The separate workflow must first be reviewed and landed on the default branch
so `workflow_dispatch` is available. Then dispatch the exact
reviewed diagnostic branch/commit. This document and the existing old ARM
workflow do not authorize a new dispatch. No rerun or custom-path fallback
substitutes for a missing input or failed first attempt.

## Binding consumed by the UI harness

The preparation driver writes one bounded JSON binding. All paths are absolute and
canonical; files referenced by pins are regular files with exact bytes/SHA256.

- `schema: 1`, `approvedForOnePositiveUILaunch: true`,
  `allowNormalStartupMetadata: true`, `root`, `source`, `harnessSource`.
- `sourceGuard`: `baseSource`, `harnessSource`, `baselineFiles: 419`,
  `oldFilesUnchanged: true`, and actual `addedPaths`. The preparation wrapper
  proves these with original Git commands; the UI harness checks the bound
  identity and allowed path set without importing production startup.
- `privateRoot`, `home`, `codeHome`, `dataDir`, `sshConfig`, `packageApp`,
  `vendorApp`, canonical `CLI`, `CLISHA256`, and fresh UI-only `output` below
  `root/test-results/arm-first-run-ui/`. The driver evidence directory is
  separate from the fresh UI output.
- `packageZipPin`, `expectedASARPin`, `vendorIdentityPin`, `vendorInventoryPin`:
  `{path, bytes, sha256}`. The vendor inventory is the existing Python helper's
  sorted row list, including permission bits through `0o7777`.
- `actualNodeIdentity`: `{path, bytes, sha256, version, platform, arch}` for the
  actual standalone Node 24 ARM interpreter. Local x64 inert tests are not ARM
  runtime evidence.

The vendor identity record has `appPath`, `CLI`, `bundleId: com.openai.codex`,
actual `appVersion`/`appBuild`, `appTeamID`, `CLITeamID`,
`CLIArchitecture: arm64`, and true `appDeepStrictAppleOpenAIVerified`,
`CLIDeepStrictAppleOpenAIVerified`, `originalToolsClosed`,
`ownedMountOrdinarilyDetached` flags backed by the original preparation records.
These are authenticated preparation facts, not renderer-supplied grants.

## One actual UI run

After reviewing the exact diagnostic commit, the preparation driver invokes:

```sh
node scripts/diagnostics/arm-first-run-ui.mjs --run /absolute/prepared-binding.json
```

The harness verifies the package, vendor seal and fresh profile before loading
Playwright. It extracts byte-identical `runtime.cjs` and its
`native-architecture.cjs` companion from the accepted ASAR into an outside-app
observer directory. It calls only `defaultCandidates`/`platformTarget` there;
it never calls that copy's finder. The inventory uses the actual future app
environment, private Node HOME and actual packaged resources directory. Any
earlier real candidate or unknown inventory error stops the lane before launch.
The packaged finder/startup are never patched or injected.

One original Electron application is launched. Through the same returned handle,
the harness checks native ARM main identity, packaged paths, version, private
data/HOME/CODEX_HOME and absent sensitive environment names. Ordinary navigation
opens Accounts. The actual read-only account state must have zero accounts and
the same real CLI path/version shown by `.runtime-summary`. `runtime.json` must
remain absent; no manual runtime selection is saved. A whole host-content PNG
records the actual UI without overlays, cropping or fabricated version text.

`modelCache.state` is observed read-only; neither refresh nor configuration is
called. This captures ordinary metadata status without treating its models as
a generation result. The product may still be draining metadata when quit is
requested, so ordinary quit exercises the existing internal close path.

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

The public ZIP transfer has a 45-second socket timeout, not a hard overall
deadline. The official documentation and vendor DMG use the existing helper's
30/180-second soft network budgets and fixed byte caps. The workflow has a
20-minute outer limit. Cancellation at that limit is external termination;
it does not establish app, stream or mount closure. A failed stage remains
failed even if its original owner later drains and closes normally.

Internal CLI/app-server ChildProcess handles are not exposed by the public
harness API. The result therefore proves the retained app/launcher closure and
sanitized runtime/UI evidence, not every internal child's stdout, exit code or
global process absence. Vendor inventory must remain byte/mode identical.

Passing this lane complements the earlier ARM Node-only finder diagnostic.
It does not prove the reporter's exact historical app version, actual OAuth,
authenticated model generation, user-app update recovery or all of issue #52.
The old C4 environment-name cause and C2 mount-closure uncertainty remain
historical limitations; a new ordinary detach does not resolve them.

## Inert checks

`tests/arm-first-run-ui.test.mjs` imports only the diagnostic's pure admission
functions and compact package JSON. Its eight controlled definitions reject
wrong hosts/package seals/source changes, unsafe profile paths, earlier or
unknown candidates, mismatched visible state and incomplete original closure.
They never import production modules, acquire fixtures or launch a vendor/app.
They are not additional native QA IDs or evidence that this ARM UI run occurred.
