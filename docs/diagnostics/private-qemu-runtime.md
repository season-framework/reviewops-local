# Private QEMU relocation and capability diagnostic

This is a separate manually authorized phase for issue 34. It materializes runnable private derivatives of the accepted ARM QEMU supply and observes four information-only commands. It does not perform package-manager or shared-prefix installation, boot a VM, start SSH, launch ReviewOps or the genuine Linux CLI, download supply inside the adapter, or complete the installed-Mac-to-real-Linux UI condition.

The original four-path source proposal remains frozen at immutable baseline 81c2a48d08c6b00a23478c12e4ca9d1401a0cb4a. The earlier six-path integration started at the Root-accepted post-supply main 34bf2ed064a93c709a2f6d00caa70ca444abca55 and adds the adapter, pure guards, inert tests, this document, a small orchestration entry and a manual workflow. All 438 existing files and modes remain unchanged. The current combined profile retains that baseline and requires exactly twelve additions: those six, the four VM-owner paths, installed-linux-permission-combined.py and the separate installed-linux-permission-ui-v2.mjs (450 total). Both explicit source allowlists name the same twelve paths. Neither an arbitrary baseline nor a silent fallback is admitted. The old worktree is not rebased. The product remains R41 source 2a1e9f166e61eb3a30148ea624b4bb921c8ebd6a, 1.4.1-dev-3 / build 41001.

## Supply evidence and runtime authority

Use the actual R3 whole-supply acceptance, its verbatim preparedSupplyPin, and the 30 bottle/archive/inventory rows from the same R3 ZIP. That ZIP is 1,024,957,312 bytes / SHA256 5f260806475c71e0eddd5909bd640f023bb3a22baa801506087bc979f9e7c4d5. The consumer uses actual producer keys accepted, wholeSupplyAccepted, productSource, bottleArchivesVerified, preparedReportPreservedVerbatim, supplyZIPPin and preparedSupplyPin. No aliases are added to the Root proof.

An accepted report staged on the actual runner can have a new local path, but its bytes/SHA must match the original proof. The ordered blueprint's names, package versions, archive and inventory sizes/hashes must match that report. R2 is historical inspection evidence only; its partial retention is not a mandatory runtime input and cannot replace whole-supply acceptance.

An exact-binding approval with scope issue34-private-qemu-capability, reviewed harness commit, system-tool pins and fresh private prefix/output is also required. False authority stops before loading further inputs. Missing whole-supply acceptance blocks archive extraction, changes, signing and tool invocation. The supply proof remains bytes/provenance evidence, not runtime acceptance.

    python3 -I -B scripts/diagnostics/private-qemu-runtime.py --binding ABS_BINDING --approval ABS_APPROVAL

The adapter still accepts only an exact-binding phase approval. The separate orchestration may derive that approval only under the reviewed conditional parent described below; a raw capability result is never Root runtime acceptance.

## Same-runner tool handoff

Observe /usr/bin/codesign and /usr/bin/git on the actual ARM runner before invocation. Do not reuse hashes from a prior disposable runner. A separately reviewed outer orchestration may lstat, resolve and hash these fixed paths, recording its own source hash, run ID, attempt and GITHUB_SHA. It can then fill only explicitly delegated binding fields. Stage the original Root proof/report without editing their bytes.

That control identifies its parent Root authority and same-runner derivation; it does not claim Root knew the new hashes beforehand. The six-path source proposal includes the observer and manual workflow, but final harness, run number, tool observations and execution authority remain unbound until Root reviews and binds the handoff. The adapter rehashes actual tool files and admits only those fixed system paths.

## Conditional same-runner orchestration

The manual private-qemu-capability workflow has read-only contents/actions permissions, a fixed diagnostic branch, attempt 1 and actor ID 351100875. Register the reviewed workflow on the default branch before dispatching the reviewed diagnostic ref; registration and one dispatch remain separate Root operations. No pull-request, push, schedule or automatic retry trigger is added.

The capability-only child control has scope issue34-private-qemu-capability-orchestration, recipe r3-capability-v1, an opaque control ID and exactly twelve source byte/hash pins under the current combined profile. It binds an exact expectedRunNumber, reviewed GITHUB_SHA and GITHUB_WORKFLOW_SHA, workflow ref, repository, branch, actor and job. Missing or different values fail before materialization, credential access or transport. The source check verifies a clean committed HEAD, exact old 438 Git entries, exactly twelve additions, and all 450 working file bytes/executable modes. The run identity is retained with the same-runner tool observation. A local fresh claim prevents a second invocation in that output directory; the exact run-number gate rejects reuse in another allocated run. Root's external once-dispatch control remains independently required.

The workflow passes only its explicitly issued job token through REVIEWOPS_ARTIFACT_TOKEN with actions:read. The wrapper never reads a user GH_TOKEN, cookies, credential helper or proxy settings. Child environments contain no token. The transport uses a new direct request to the fixed GitHub API artifact 13310680337 of R3 run 41806165323. It accepts exactly HTTP 302 followed by a single unauthenticated HTTPS 200 from productionresultssa13.blob.core.windows.net. This exact host was observed by Root in a bounded 302-only request. Any other host, credentials in the URL, changed port or additional redirect fails. Authorization is sent only to api.github.com. No wildcard host, gh transport, stored signed-URL replay or automatic retry is used. [GitHub's artifact API documentation](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact) states that redirects expire after one minute; each authorized acquisition obtains a fresh redirect. Location and exception text are never retained.

The API body is bounded to 64 KiB and observed to EOF/close. The blob must have the exact 1,024,957,312-byte Content-Length, identity encoding and accepted SHA256. A failed partial stays in runner-temporary storage for that job; it is excluded from the uploaded metadata artifact and is not durably retained after runner teardown. Its receipt records observed/written bytes, hash, EOF, response/file closure and attempt counts. Earlier accepted ZIP bytes cannot substitute for that failed transfer. A 45-second socket timeout and a 30-minute between-read deadline bound ordinary observations; these do not promise interruption inside every blocked read. Failure never initiates a retry.

After sealing the whole ZIP, read only the unique 156,378-byte installed-linux-supply/prepared-supply.json member to EOF and verify f445374990057f8c27c66716582c658014f44048c801e51b7eb6029ec0f37365. Preserve the 3,336-byte Root proof and prepared report verbatim. Materialization records explicitly join original paths/pins to new same-runner paths; they do not edit historical proof fields. Derive the ordered 30-row blueprint only from that exact report. The accepted ZIP stays in fresh runner-temporary storage, outside the uploaded metadata artifact.

The parent conditionally delegates derivation of the exact adapter binding from those fixed inputs and observed fixed /usr/bin/codesign and /usr/bin/git bytes. The derived approval records parent, recipe-source, same-runner observation, materialization and exact binding pins. It is not a previously issued standalone Root approval. After another source/tool check, launch the adapter exactly once through its reviewed original-object owner. Record actual exit, poll, both pipe EOF/close and file closure; an attempted pre-handle failure is not retried or resolved with an earlier Git process. A failed or HELD original remains owned; no signal or PID adoption is introduced.

Only sanitized JSON, original stdout/stderr and receipts are uploaded. The 1 GiB input ZIP, private executable tree and private HOME are not uploaded. The wrapper's result always keeps acceptedRuntime false. A successful observed capability still needs separate Root acceptance and a separately reviewed original VM owner before any boot, SSH or installed-app UI phase.

    /usr/bin/python3 -I -B scripts/diagnostics/private-qemu-capability.py --parent ABS_PARENT --whole-proof ABS_PROOF --output SOURCE/test-results/private-qemu-capability-orchestrator

## Private layout and bounded changes

Use a fresh 12-byte logical prefix such as /tmp/r34abcd under the genuine /tmp to /private/tmp mapping, with current-owner mode 0700. Twelve bytes fit both /opt/homebrew and @@HOMEBREW_CELLAR@@ plus /Cellar without growing a C string.

The layout is Cellar/FORMULA/PKG_VERSION plus opt/FORMULA links into exact kegs. Seal all 30 compressed archives and inventory JSON members before manual extraction. There is no extractall or post-install script. Caps are 18,000 input entries, 1 GiB declared expansion, 512 MiB per file and 20,000 derived entries. Actual inventories contain 17,324 entries / 918,392,318 declared bytes.

Write regular files before creating archive links. Names, types, modes, lengths, link targets and hashes must match inventories. Refuse absolute/traversing names, privileged modes, hardlinks and unsupported types. Relative links must remain in their own keg; parents cannot be symlinks, and finite resolution rejects cycles or missing targets. Directories are private extraction directories, not an ordinary Homebrew install. No mutable Homebrew module, host-global keg, source build or library fallback is used.

Only thin ARM64 executable/dylib/bundle code is supported. The parser bounds headers, load commands, offsets, NUL termination, sections and signature ranges using Apple's public [Mach-O layout](https://github.com/apple-oss-distributions/cctools/blob/main/include/mach-o/loader.h). Fat, foreign or unsupported libraries fail rather than selecting another architecture.

Path replacements are confined to validated dylib/RPATH strings and real __TEXT,__cstring sections. LC paths use their separately checked storage capacity. C strings use equal-width prefix substitutions: redundant internal slash separators pad the logical prefix to 13 or 19 bytes, and normalization must resolve to the same admitted private root. The CELLAR token maps to the exact-width logical prefix plus /Cellar. Only those prefix spans change; suffix bytes and their original offsets stay fixed for pooled compiler references. Record each changed range/hash. Only the eight producer-listed QEMU firmware JSON files may receive ordinary literal substitutions, with UTF-8/JSON checks. Other data stays exact.

All admitted native files in this private supply are inspected and signed as derivatives, including code not invoked by the probes, with a 256-file cap:

    /usr/bin/codesign --force --sign - --timestamp=none FILE
    /usr/bin/codesign --verify --strict FILE

The dash selects ad-hoc signing and the timestamp option disables a timestamp-server request; see the system's Apple codesign(1) manual. No upstream publisher certificate is claimed. Original, patched and signed hashes are separate. Signing can update signature structures, so final bytes are not described as only a path-string delta.

## Loader and original-process observations

Before and after signing, each non-system load must resolve to one regular native file in the supplied closure. /usr/lib/ and /System/Library/ references are classified as system paths, not independently reconstructed system bytes. Other absolute paths must be private. Check loader/executable-relative paths, inherited private RPATHs, ambiguity and symlink targets. Missing or foreign paths and dyld environment commands fail. No host-global Homebrew library is adopted.

Only four QEMU command forms are invoked:

* qemu-system-x86_64 --version: exact 11.1.3 banner.
* qemu-img --version: exact 11.1.3 banner.
* qemu-system-x86_64 -machine help: pc is listed.
* qemu-system-x86_64 -accel help: tcg is listed.

Listing TCG is not executing it; listing a machine is not booting it or proving guest/BIOS/device behavior. Static closure and these probes do not exercise every optional dynamically loaded feature. A later VM/guest controller remains a separate phase.

The original creation objects, actual wait/poll, stdout/stderr EOF/close, caps and HELD/drain behavior come from the reviewed supply owner. No PID adoption, signal, kill, retry or failed-prefix cleanup occurs. Original archives are read-only and freshly rehashed after success. Before/after private inventories must differ only in declared native/signature and allowed text files. Failure retains originals and any created partial derivative. The result separately records privatePrefixCreated; privateDerivativeRetained is false before creation, true only for the same observed prefix identity, and null if its continued identity cannot be established.

## Inert checks and remaining gates

    python3 -I -B tests/private_qemu_runtime_test.py

Guard tests use synthetic bytes, paths and original objects. A separate isolated entry-import smoke loads definitions with a non-main run name while Popen, ZipFile, Path.mkdir/write_text/write_bytes and os.mkdir/symlink/chmod are blocked. It never calls main; these listed seams are not a blanket guarantee about every possible write API. The checks do not install/extract anything, sign code, create a child, open a binary archive, access the network or execute QEMU. They distinguish byte geometry, private path ownership, missing/ambiguous dependencies, whole-supply authority and original completion. Passing them is source validation only.

Actual extraction, relocation, signing and probes still need Root's reviewed binding and phase authority on an actual ARM host. No VM/native UI acceptance, genuine Linux CLI runtime version, permission-denied UI result or issue closure follows from this source packet.


## Combined same-runner integration

The registered manual workflow now uses the reviewed codex/issue34-installed-linux-combined-qa ref and a distinct external parent scope issue34-installed-linux-combined-qa / recipe combined-same-runner-v1. All actual source/run allocation/authority fields are unbound in the source proposal. Root must inspect the actual workflow run list before binding its exact next run number; no local claim authorizes any allocated run or repeat dispatch. The job observation budget is 120 minutes. Infrastructure timeout does not prove normal shutdown or replace the owner's HELD state.

The Python coordinator has three explicitly claimed phases. First it verifies the complete external parent, source12/current workflow SHA/ref/actor/run and raw R3/R41 Root proofs before Node or dependencies are acquired. It creates fresh owned private HOME/cache, exact empty private npm user/global configs and rejects any project .npmrc. Next the pinned setup-node action supplies exact Node 24.22.2 ARM with check-latest false and package-manager-cache false; no registry-url input writes a project config. Actual Node realpath/version/arch/hash is observed. No per-HTTP receipt is invented for the action's internal archive transport. Locked npm ci uses fixed registry.npmjs.org, ignore-scripts/no-audit/no-fund, no user credentials, browser/Electron lifecycle downloads or npm fetch retry. The final phase requires the same preflight/source/parent/private-root identity and dependency record.

In that same job the coordinator derives a capability-only child control, invokes it once, and verifies its actual run identity. A separate explicit combined-parent clause delegates acceptance of that new runtime observation; old R1 private paths/results cannot substitute. It materializes the accepted R3 image and genuine ELF through unique bounded ZIP members and exact size/hash/CRC EOF, without repeating GPG or executing the CLI. The VM materialization producer is a NEW record with originalRootPin/stagedRootPin/files[{originalPin,localPin}], distinct from the unchanged capability-only materialization schema. Historical Root proof/report bytes and old paths are preserved verbatim.

The accepted R41 public ARM primary asset is 708388172, 133831763 bytes / 2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead. Its direct API response must be 200 or one 302 to the Root-observed exact release-assets.githubusercontent.com HTTPS443 host, followed by one unauthenticated 200; no proxy, cookie, signed-URL retention, alternate asset or retry. The API token is sent only to api.github.com. The immutable byte seal binds the package despite the mutable test-latest tag. The app is extracted once with the observed fixed ditto, bounded names/types/internal relative links, and exact ASAR/executable pins. No app bytes are patched or signed. Before/after private bundle inventories must be identical.

Only the combined external parent may delegate distinct current-run runtime, private-app, source, original VM/guest and reviewed UI-v2 approvals. Derived records retain parent/source/recipe pins and say they are not Root-directly-reviewed results. The coordinator passes the actual Node VM owner exactly five private setup variables plus its six admitted CI strings; no token/npm/Git config/user auth is inherited. UI root/output/claimPath and the R41 build are explicit producer fields. The owner remains sole VM/QMP/ephemeral-key/bootstrap/UI lifecycle authority and uses the reviewed v4 closure checks. There is no Python fallback VM controller, signal, second owner, rerun, OAuth submit or model generation.

Artifact uploads are explicit: safe JSON, capability/source-only stdout/stderr, minimal coordinator CLI observations and genuine whole-app PNGs. They exclude the 1 GiB supply ZIP, app ZIP, image/overlay, whole privateRoot/prefix, private HOME/keys, seed contents, sockets, raw VM serial/bootstrap/tool filebacks and npm diagnostic filebacks. The final coordinator verdict is an observation awaiting separate Root acceptance; it does not close issue 34 or claim global process/network absence.

The separate UI-v2 entry retains the old UI file among the exact 438 baseline files. Only bounded phase/failure observations differ; the coordinator and owner pin the new path and hash explicitly. The original R4 failure remains failed. No new app, VM, runtime or permission result follows from these source and inert checks.
