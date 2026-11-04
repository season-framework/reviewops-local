# Installed Mac to Linux permission diagnostic: supply preparation

This manual diagnostic prepares evidence for the remaining installed-app/real-Linux permission condition in issue 34. It changes no product, finder, SSH behavior or release workflow. A successful supply phase is **not** a VM boot, packaged-app UI result, native QA pass or issue-completion result.

The first milestone is deliberately limited to `prepare-supply`. The workflow has only a manual trigger, contents-read permissions, first-attempt/reviewed-branch guards and no cancellation of an earlier run. A newly added workflow must be reviewed and registered on the default branch before Root dispatches the reviewed diagnostic branch. Do not dispatch an unreviewed branch or rerun a failed attempt.

## Fixed product and external inputs

The public app is R41 source `2a1e9f166e61eb3a30148ea624b4bb921c8ebd6a`, tree `f8e5ce991cf927d8064b1f7d7fe0604a48959303`, 1.4.1-dev-3 / build 41001. Its accepted ARM ZIP is 133,831,763 bytes with SHA256 `2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead`. The preparation phase records this identity without downloading or launching that app.

Supply inputs are pinned in `scripts/diagnostics/installed-linux-permission-supply-request.json`:

* Homebrew QEMU 11.1.3, formula commit `6f3d127080e96f5192e5280fc94babd809e231ac`, ARM Sequoia bottle SHA256 `a99cca4450c91f471e8e546b8fb48780e0cb2104ffbe15d394c1b431d44df620`. There is no Intel binary or source-build fallback.
* Dated Ubuntu 24.04 Noble amd64 cloud image `release-20261017/ubuntu-24.04-server-cloudimg-amd64.img`, SHA256 `04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94`. Verify its detached checksum signature against Canonical primary key `D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81` before the image transfer. This image's official manifest includes OpenSSH; a later guest must still report its actual server and Linux identities.
* Genuine official Codex `rust-v0.166.0`, release 428320524 / asset 689712643, Linux x86_64 musl archive 121,764,138 bytes, SHA256 `a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978`. Root retained the official release metadata SHA256 `21eefb68cd956cedec06809daa38fb8f7e18893730241ace6cf58cfa754814d2`. The actual ELF SHA remains null until the archive is verified and the one real ELF is extracted; the ELF is not executed.

The request's harness commit is initially null. Root binds it only after reviewing the actual commit and exact added-file set. All 429 existing base files and modes must remain unchanged. Preparation can land independently with its six files; an explicitly bound set may additionally include the three reviewed UI diagnostic files. Unknown paths or missing preparation files are refused.

## Request, authority and invocation

Use an exact UTF-8 request file and a separate Root control file. The latter must contain `approved:true`, scope `issue34-acquire-prepare-only` and `requestSHA256` equal to the request's actual bytes. This is the existing internal execution control, not a new end-user permission step. The checked-in null harness template is not executable authority.

The manual workflow takes `reviewed_commit`, `request_json` and `approval_json`. It writes their exact strings to fresh files without shell interpolation and passes those files to the Python helper. The source guard requires a clean reviewed HEAD, the exact workflow/App actor/first attempt, and the declared diagnostic-only additions above the 429-file public product base.

```sh
/usr/bin/python3 -I -B scripts/diagnostics/installed-linux-permission-supply.py \
  --request /absolute/reviewed-request.json \
  --approval /absolute/root-approval.json \
  --output /absolute/checkout/test-results/installed-linux-supply
```

Only the workflow's fresh checkout output is admitted. The helper requires a preinstalled GPG verifier and records its actual executable hash. It never installs a package to obtain GPG or QEMU. Missing tools, metadata drift or an unavailable admitted dependency bottle stop preparation.

## What preparation actually does

1. Retain the exact pinned formula source and current official formula metadata. Require the reviewed QEMU version and bottle SHA. Resolve its finite runtime dependency closure, requiring every declared dependency version/revision to match the selected sealed rows. By default only `arm64_sequoia` dependency bottles are admitted. Lower supported ARM tags require an explicit reviewed request; x86/Linux tags and source compilation are rejected.
2. Acquire each official registry bottle once, matching its digest and finite caps. Anonymous GHCR tokens exist only in memory, never follow redirects, and are not serialized. Redirect records contain hosts/statuses rather than signed URLs. No proxy, cookie or user credential is adopted. Retain failed partials and honest request receipts; do not retry.
3. Inventory every bottle archive with safe member names, finite entry/expanded-size bounds and regular-file hashes. Follow no symlink and extract no QEMU/dependency files. Locate and hash the actual regular `qemu-system-x86_64`, `qemu-img`, `bios.bin` and `bios-256k.bin` entries; check the tools' ARM64 Mach-O headers without executing them. This is an archive seal, not an installed-loader/capability proof.
4. Acquire the Ubuntu checksum file, detached signature and exact primary key. In a private public-key-only GPG home, verify the primary fingerprint and checksum signature with no automatic key retrieval/autostart. Download and hash the image only after that check. Inspect its QCOW2 header to reject external backing/data files or encryption. Do not create an overlay, seed, VM or SSH endpoint.
5. Acquire the one official Linux CLI archive at its pinned size/SHA. Admit only its expected regular ELF member and safely extract that member to a fresh file, verify ELF64/x86_64 headers and seal its actual bytes/hash. Do not execute `--version`, login status, app-server or any other CLI operation in this phase.

The aggregate transfer cap is 3 GiB, with smaller per-resource caps and a 30-minute between-read deadline. Each socket operation has a 45-second timeout; the result explicitly does not claim a hard interrupt inside a blocked read. Original Git/GPG tools retain their creation handles, actual wait/poll/exit and observed stdout/stderr EOF/close. An observation deadline or output cap remains a failure even if the original later drains and closes. An unreadable original pipe remains HELD/UNKNOWN; no signal, PID adoption or retry resolves it. These receipts do not claim every internal GPG helper was separately retained.

`prepared-supply.json` always preserves `archivesOnly:true`, `executableInstalled:false`, `vmBooted:false`, `applicationLaunched:false`, `CLIExecuted:false`, `VMReady:false` and `nativeQAAccepted:false`. `ok:true` means only the supply work completed. The output inventory excludes the temporary GPG working directory; it contains no private SSH key or vendor authentication material.

## Later VM and UI admission remains separate

No VM boot/UI command exists in this preparation workflow. Root must first accept the actual prepared supply. A later reviewed owner must install/pour only the sealed bottle closure with explicit relocation/capability guards, inspect actual firmware, create a local CIDATA seed and read-only base plus disposable overlay, then launch one original QEMU with TCG only. Do not silently build from source or use HVF/KVM.

The planned guest is a real non-root Linux/OpenSSH endpoint with `restrict=on,ipv6=off` and one explicit `hostfwd=tcp:127.0.0.1:<owned-port>-:22`. Transfer the sealed genuine ELF via the owned SSH connection; guest internet is unnecessary. Guest host identity, nonzero UID/EUID, same owned leaf device/inode/UID and real 0700→000→0700 denial need actual records. The genuine CLI has no supplied OAuth/login credential; normal version/login-required is valid and authenticated preflight is not required. Existing version/login/config/model-list metadata may run normally, including separate `/` model-cache work; an empty profile does not prove external calls were zero.

The separate UI driver requires `preparedSupplyPin`, accepted `preparedRootAcceptancePin` and a distinct accepted `guestRootAcceptancePin`. The latter joins the exact guest and sealed ELF/witness to the retained original VM. Its own app/SSH cleanup does not power off or adopt the VM. After the UI original closes, the outer owner must restore mode and request ordinary guest ACPI poweroff, then wait its original QEMU. Guest PIDs are not host retained child handles. No VM/app run, synthetic CLI, authenticated generation, forced cleanup or issue close is authorized by successful preparation.

## Inert local checks

```sh
/usr/bin/python3 -I -B tests/installed_linux_supply_test.py
```

These checks load only the pure guard module. They validate exact manual authority/source/vendor/bottle admission, archive path refusal, checksum row uniqueness, distinct ARM-host/x86-guest binary headers, unsafe QCOW relationships and original-attempt ownership. They create no process, socket, VM, app, CLI invocation or network request. They are not image, emulator or UI compatibility tests.
