# Installed Mac to Linux permission diagnostic: supply preparation

This manual diagnostic prepares evidence for the remaining installed-app/real-Linux permission condition in issue 34. It changes no product, finder, SSH behavior or release workflow. A successful supply phase is **not** a VM boot, packaged-app UI result, native QA pass or issue-completion result.

The first milestone is deliberately limited to `prepare-supply`. The workflow has only a manual trigger, contents-read permissions, first-attempt/reviewed-branch guards and no cancellation of an earlier run. A newly added workflow must be reviewed and registered on the default branch before Root dispatches the reviewed diagnostic branch. Do not dispatch an unreviewed branch or rerun a failed attempt.

## Fixed product and external inputs

The public app is R41 source `2a1e9f166e61eb3a30148ea624b4bb921c8ebd6a`, tree `f8e5ce991cf927d8064b1f7d7fe0604a48959303`, 1.4.1-dev-3 / build 41001. Its accepted ARM ZIP is 133,831,763 bytes with SHA256 `2e48f3aa200cf0d0a232d3e70508398105009a7e2ec08aeb928b05460646bead`. The preparation phase records this identity without downloading or launching that app.

Supply inputs are pinned in `scripts/diagnostics/installed-linux-permission-supply-request.json`:

* Homebrew QEMU 11.1.3, formula commit `6f3d127080e96f5192e5280fc94babd809e231ac`, ARM Sequoia bottle 113,165,355 bytes / SHA256 `a99cca4450c91f471e8e546b8fb48780e0cb2104ffbe15d394c1b431d44df620`. Its immutable OCI child is 36,175 bytes / SHA256 `c03180c7ec3614b9c31f8fe287e0d95c608f4c7a59fc925197c54acfb175d0b8`. The request also pins all 29 selected dependency child manifests, literal Tab hashes, and bottle layer sizes/hashes. There is no mutable-index, current-formula-version, Intel binary or source-build fallback.
* Dated Ubuntu 24.04 Noble amd64 cloud image `release-20261017/ubuntu-24.04-server-cloudimg-amd64.img`, SHA256 `04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94`. Verify its detached checksum signature against Canonical primary key `D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81` before the image transfer. This image's official manifest includes OpenSSH; a later guest must still report its actual server and Linux identities.
* Genuine official Codex `rust-v0.166.0`, release 428320524 / asset 689712643, Linux x86_64 musl archive 121,764,138 bytes, SHA256 `a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978`. Root retained the official release metadata SHA256 `21eefb68cd956cedec06809daa38fb8f7e18893730241ace6cf58cfa754814d2`. The actual ELF SHA remains null until the archive is verified and the one real ELF is extracted; the ELF is not executed.

The request's harness commit is initially null. Root binds it only after reviewing the actual commit and exact added-file set. All 429 existing base files and modes must remain unchanged. The current template declares all nine diagnostic files already present on the reviewed branch, including the three separate UI source files. Their presence does not authorize a UI run. Unknown paths or missing preparation files are refused.

## Request, authority and invocation

Use an exact UTF-8 request file and a separate Root control file. The latter must contain `approved:true`, scope `issue34-acquire-prepare-only` and `requestSHA256` equal to the request's actual bytes. This is the existing internal execution control, not a new end-user permission step. The checked-in null harness template is not executable authority.

The manual workflow takes `reviewed_commit`, `request_json` and `approval_json`. It writes their exact strings to fresh files without shell interpolation and passes those files to the Python helper. The source guard requires a clean reviewed HEAD, the exact workflow/App actor/first attempt, and the declared diagnostic-only additions above the 429-file public product base.

```sh
/usr/bin/python3 -I -B scripts/diagnostics/installed-linux-permission-supply.py \
  --request /absolute/reviewed-request.json \
  --approval /absolute/root-approval.json \
  --output /absolute/checkout/test-results/installed-linux-supply
```

Only the workflow's fresh checkout output is admitted. The helper requires preinstalled GPG and adjacent GPGV executables in the same physical package directory and records both hashes. It never installs a package to obtain a verifier or QEMU. Missing tools, metadata drift or an unavailable admitted dependency bottle stop preparation.

## Early public signature verification

After source admission, verify the small public Ubuntu inputs before any QEMU bottle, image or vendor archive transfer. The request seals `SHA256SUMS` at 7,843 bytes / SHA256 `0449a33b78dddb301a3ce2b80398984bc3e1f7880e27b86a31e58bdcbd3d3816`, its detached signature at 833 bytes / `68aae716a548e466e58afddd8b767c54c791f40f1d20d1d12e27c471edb535e5`, and the public key armor at 3,325 bytes / `927138de292fac4d861105a052cf56e9c5921987da385c844d88f34d19b39ab0`. Drift stops the run; there is no refresh or alternate-key fallback.

Create a fresh owned 0700 home under `/private/tmp/r34g-<opaque>` and a new explicit public keyring in the retained output. The two command forms use actual absolute paths and the existing original-process owner:

```text
GPG --no-options --homedir SHORT_HOME --batch --no-autostart --no-auto-key-retrieve --no-auto-key-import --no-random-seed-file --dearmor --output ABS_FRESH_KEYRING ABS_PUBLIC_KEY_ASC
GPGV --homedir SHORT_HOME --keyring ABS_FRESH_KEYRING --status-fd 1 ABS_SIGNATURE ABS_SHA256SUMS
```

There is no import, key listing, trustdb update, explicit agent command or `gpgconf` cleanup. Require both originals to exit zero with actual wait/poll and both observed streams closed. GPGV receives only the explicit keyring, not the user's default trusted keys. The GPG-only seed-file option disables creation of a random seed file; it is not passed to GPGV. Never delete entries inside the home. Only remove the same empty owned home with atomic `rmdir` after the original attempt closes. A late file or socket makes `rmdir` fail, leaving the home retained and preparation failed. Record names/types and the cleanup error code, not entry contents. These observations do not claim global absence of agents or separately retained handles for every internal library action.

Parse GPGV's dedicated status stream, requiring one `VALIDSIG` and no observed bad/error/expired/revoked-signature statuses or multiple signature contexts. Its first fingerprint identifies the signer; the optional tenth field identifies the primary key. The primary must exactly equal the expected Canonical fingerprint. If that field is absent, accept only when the signer itself is that primary; an unproven subkey fails. Then require one exact checksum row for the dated amd64 image with its pre-approved SHA256.

[GnuPG's status contract](https://github.com/gpg/gnupg/blob/gnupg-2.5.24/doc/DETAILS#L537-L568) defines these two fingerprint roles. [GPGV's documented trust model](https://github.com/gpg/gnupg/blob/gnupg-2.5.24/doc/gpgv.texi#L30-L47) trusts supplied keyring keys and does not check key expiry or revocation. The result is cryptographic validity under the exact pinned public key bytes and primary fingerprint, not a live revocation/expiry audit. Rejecting an error status if emitted does not add that audit. The agent-free command path still requires actual clean execution in the reviewed CI cohort; inert parser checks are not tool verification.

## What preparation actually does

1. Complete the small exact-byte public signature subphase above. No large transfer can precede it.
2. Retain the exact pinned formula source as identity evidence, then request the 30 reviewed OCI child manifests directly by immutable digest. Do not query a mutable version index or current formula API. Require each child's actual bytes/hash, exact package version/revision/rebuild/tag reference, one matching layer, and literal `sh.brew.tab` hash. The fixed QEMU Tab selects the exact 29 dependency tuples; every requested dependency must match that declaration. Its 28 ARM Sequoia dependency bottles are distinct from the one explicitly allowed architecture-neutral `ca-certificates` `2026-10-20.all` data bottle. No other `all` tag, lower ARM tag, x86/Linux tag or source build is a fallback. Admit the complete metadata set before any bottle transfer.
3. Retain each nested Tab literally, including older build-time versions and absent fields. Every nested dependency name must belong to the selected root set, but its historical tuple need not equal the root's chosen runtime tuple. The actual reviewed metadata has 17 such differences, including two omitted `bottle_rebuild` fields in the old libidn2 Tab; omitted values are never filled with zero. Acquire each selected official registry bottle once at its exact layer size and SHA256. Anonymous GHCR tokens exist only in memory, never follow redirects, and are not serialized. Redirect records contain hosts/statuses rather than signed URLs. No proxy, cookie or user credential is adopted. Retain failed partials and honest request receipts; do not retry.
4. Inventory every bottle archive with safe member names, finite entry/expanded-size bounds and regular-file hashes. Follow no symlink and extract no QEMU/dependency files. Locate and hash the actual regular `qemu-system-x86_64`, `qemu-img`, `bios.bin` and `bios-256k.bin` entries; check the tools' ARM64 Mach-O headers without executing them. This is an archive seal, not an installed-loader/capability proof.
5. Download and hash the image only after the small signature check has passed. Inspect its QCOW2 header to reject external backing/data files or encryption. Do not create an overlay, seed, VM or SSH endpoint.
6. Acquire the one official Linux CLI archive at its pinned size/SHA. Admit only its expected regular ELF member and safely extract that member to a fresh file, verify ELF64/x86_64 headers and seal its actual bytes/hash. Do not execute `--version`, login status, app-server or any other CLI operation in this phase.

The aggregate transfer cap is 3 GiB, with smaller per-resource caps and a 30-minute between-read deadline. Each socket operation has a 45-second timeout; the result explicitly does not claim a hard interrupt inside a blocked read. Original Git/GPG/GPGV tools retain their creation handles, actual wait/poll/exit and observed stdout/stderr EOF/close. An observation deadline or output cap remains a failure even if the original later drains and closes. An unreadable original pipe remains HELD/UNKNOWN; no signal, PID adoption or retry resolves it. These receipts do not claim every internal GPG helper was separately retained.

`prepared-supply.json` always preserves `archivesOnly:true`, `executableInstalled:false`, `vmBooted:false`, `applicationLaunched:false`, `CLIExecuted:false`, `VMReady:false` and `nativeQAAccepted:false`. `ok:true` means only the supply work completed. The output inventory excludes the temporary GPG working directory; it contains no private SSH key or vendor authentication material.

Failures record a fixed preparation stage and, where available, a source-controlled guard reason code such as `oci-layer-seal`. Arbitrary HTTP/parser exception strings remain redacted because they can contain signed URLs. Transfer receipts retain their fixed stage and resource label. A failed partial or an unknown library exception remains a failure; there is no retry or runtime fallback.

The first preparation attempt stopped before any binary transfer because the official formula API had no `runtime_dependencies` property. A later separately retained fixed QEMU archive also had no `INSTALL_RECEIPT.json`. These original observations remain failures/inspection evidence. The correction uses the actual OCI `sh.brew.tab` metadata rather than inventing either missing property. The bottle reports producer Homebrew `7.0.11-24-g2833c25`; the reviewed [Homebrew 6.0.18 representation](https://github.com/Homebrew/brew/blob/6.0.18/Library/Homebrew/resource.rb#L394-L482) and [dependency-resolution code](https://github.com/Homebrew/brew/blob/6.0.18/Library/Homebrew/formula_installer.rb#L787-L800) explain why historical build tuples are not an exact-version lock. That code treats recorded versions/revisions as minimums. This diagnostic instead pins its chosen root set explicitly and does not claim Homebrew's full resolver or ABI compatibility.

R2 then sealed the actual OCI set and archives but failed at public-key import: its original returned 2 after an agent socket pathname error. That failure and its original artifact remain intact. The current source replaces import with dearmor plus explicit-keyring GPGV, and moves the small signature gate ahead of large transfers. It does not describe R2 as successful supply or claim the new verifier commands have already run.

## Later VM and UI admission remains separate

No VM boot/UI command exists in this preparation workflow. Root must first accept the actual prepared supply. A later reviewed owner must install/pour only the sealed bottle closure with explicit relocation/capability guards. It must inspect actual Mach-O load commands, resolve every non-system dependency against the exact supplied root closure after the reviewed layout/relocation step, and reject unresolved or outside-supply paths. `@rpath`, `@loader_path` and `@executable_path` are not proof of resolution by themselves; no global Homebrew library adoption is allowed. Only after independent loader/capability acceptance may the owner inspect actual firmware, create a local CIDATA seed and read-only base plus disposable overlay, then launch one original QEMU with TCG only. Do not silently build from source or use HVF/KVM.

The planned guest is a real non-root Linux/OpenSSH endpoint with `restrict=on,ipv6=off` and one explicit `hostfwd=tcp:127.0.0.1:<owned-port>-:22`. Transfer the sealed genuine ELF via the owned SSH connection; guest internet is unnecessary. Guest host identity, nonzero UID/EUID, same owned leaf device/inode/UID and real 0700→000→0700 denial need actual records. The genuine CLI has no supplied OAuth/login credential; normal version/login-required is valid and authenticated preflight is not required. Existing version/login/config/model-list metadata may run normally, including separate `/` model-cache work; an empty profile does not prove external calls were zero.

The separate UI driver requires `preparedSupplyPin`, accepted `preparedRootAcceptancePin` and a distinct accepted `guestRootAcceptancePin`. The latter joins the exact guest and sealed ELF/witness to the retained original VM. Its own app/SSH cleanup does not power off or adopt the VM. After the UI original closes, the outer owner must restore mode and request ordinary guest ACPI poweroff, then wait its original QEMU. Guest PIDs are not host retained child handles. No VM/app run, synthetic CLI, authenticated generation, forced cleanup or issue close is authorized by successful preparation.

## Inert local checks

```sh
/usr/bin/python3 -I -B tests/installed_linux_supply_test.py
```

These checks load only the pure guard module. They validate exact manual authority/source/vendor/bottle admission, immutable OCI byte and layer linkage, exact root selection, literal historical omissions, the singular neutral certificate exception, safe failure-stage output, primary-versus-signer status parsing, observed signature refusal/error cases, short private-home admission, exact signed checksum rows, archive path refusal, distinct ARM-host/x86-guest binary headers, unsafe QCOW relationships and original-attempt ownership. Signature status strings in these tests are synthetic parser inputs, not cryptographic verification. The checks create no process, socket, VM, app, CLI invocation or network request. They are not GPG, image, emulator or UI compatibility tests.
