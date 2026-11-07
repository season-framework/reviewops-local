# Opt-in Developer ID signing

The default macOS build remains explicitly ad-hoc signed (`identity: "-"`, hardened runtime off). That mode is useful for development and existing delivery, but it does not qualify a new remote-identity feature as safe across different installed builds. An unchanged same-version reinstall is also not an update-continuity result.

The optional route below prepares Developer ID application and native-addon signing. No certificate, key, repository secret, Keychain ACL, or product identity is created or changed by configuring this source change. Running a future authorized signing build does use the supplied signing credential through the existing electron-builder mechanism. Signing is separate from notarization, Gatekeeper acceptance and actual installed-app testing.

## Explicit selection and credentials

Use a trusted macOS build environment with the locked dependencies and local Node headers. Set:

- `REVIEWOPS_MAC_SIGNING=developer-id` to opt in. Missing/`adhoc` preserves the existing default. Any other mode is refused.
- `CSC_NAME` to the exact 40-hex SHA-1 fingerprint of the intended **Developer ID Application** certificate. This is a certificate selector, not a CodeDirectory hash. Do not use a partial organization name or the full `Developer ID Application:` name prefix.
- `REVIEWOPS_MAC_TEAM_ID` to the expected ten-character Apple Team ID.

Choose one existing electron-builder credential lane:

- For an already installed signing identity, leave `CSC_LINK` unset. The builder uses its normal signing search, optionally scoped by `CSC_KEYCHAIN`.
- For an approved PKCS#12 signing credential, supply standard `CSC_LINK` and `CSC_KEY_PASSWORD` through the trusted credential/CI environment. Electron-builder owns its temporary signing Keychain and disposal. Its import process can change the signing-key search/partition setup; this is distinct from the application's protected remote-identity item. Do not manually import credentials through these hooks.

Do not put certificate contents or passwords in source, command examples, public logs, reports or PR bodies. The hooks do not print them and replace upstream credential errors with a fixed message. They preserve the builder's pull-request signing restriction and never enable `CSC_FOR_PULL_REQUEST` automatically.

After credentials and the actual build have been authorized, the existing entry points use the selected route:

```sh
npm run package:intel
npm run package
```

The test and stable builders also use `scripts/electron-builder.config.cjs`. They preserve explicitly configured `CSC_IDENTITY_AUTO_DISCOVERY` and retain its old `false` default; the exact identity qualifier works without enabling automatic selection. `REVIEWOPS_PACKAGE_OUTPUT` is reserved for the existing package helper's absolute output directory. It avoids mixing a config filename with CLI dot-options, whose merge order could restore the default ad-hoc identity.

Existing GitHub workflows do not acquire credentials or set this opt-in automatically. A maintainer must deliberately supply the variables to a trusted **Mac** build job; do not place Mac signing credentials in Windows jobs or untrusted pull-request environments. This preparation adds no secret values or automatic CI signing run.

## Signing order and fail-closed checks

The opt-in configuration selects distribution signing, requires signing to succeed and enables hardened runtime. It supplies the same explicit JIT-only entitlement policy for the app and inherited signing. This prevents the builder's broader default entitlement template from silently adding library-validation or unsigned-executable-memory exceptions. `preAutoEntitlements` is off, and custom signing requirements/overrides are refused by the hook. The limited policy still requires real signed-app compatibility testing; it is not an assertion that every runtime scenario has passed.

Before packaging, the native hook awaits the exact MacPackager's memoized `codeSigningInfo`. When `CSC_LINK` is used, this makes the builder's imported credential available in the same temporary signing Keychain that the later app signer uses. The hook resolves the exact selector, verifies Developer ID Application naming and expected Team ID, and refuses missing, different or non-Apple candidates before native compilation. The final OS verification below establishes the Apple certificate class; a matching display name alone is insufficient.

Both N-API addons are compiled, signed with the selected identity and scoped Keychain, then verified. Developer ID signing requests a secure timestamp and may contact Apple; this is separate from notarization. Their final signed bytes are hashed **after** signing. The existing schema-1 manifest is published last. The app signer retains the specific addon `signIgnore`; the enclosing app resource seal still covers them. `afterSign` refuses a changed addon/manifest and verifies both addons and the final app.

Each opt-in signature verification uses `codesign --test-requirement` with one conjunction:

- Apple generic trust anchor.
- Developer ID intermediate and Application leaf certificate extension markers.
- Expected Team ID in the leaf's organizational unit.
- The exact selected leaf certificate SHA-1.

This checks the actual signer through the OS verifier even if the builder later refers to the certificate by name. A same-name/same-Team replacement leaf cannot qualify. This requirement is a build-time **verification** condition; it does not install a custom designated requirement in the app, change a product ACL, or pin future app updates to a CodeDirectory hash. The hook additionally verifies runtime flags and the final app's decoded entitlement policy. A failed identity lookup, blocked signing policy, native command, Apple/exact-leaf requirement, manifest check or final entitlement check aborts the build; there is no opt-in fallback to ad-hoc or unsigned output.

## Required acceptance before release

Controlled tests exercise real configuration loading and hook/build logic against inert command-boundary outputs. They do not invoke a compiler, codesign, Keychain, imported certificate, installed application or model:

```sh
node --test tests/mac-signing-build.test.cjs
```

No actual Developer ID package, notarization, strict-library-validation runtime, or cross-build protected-identity continuity is accepted by those tests. Before publication, inspect the actual signed arm64/Intel packages and complete their installed launch and affected feature checks. Keep all platform/package/install/update/data-preservation gates in [Releasing ReviewOps](releasing.md).

For remote identity, perform the [packaged identity continuity](packaged-identity-continuity.md) scenario with the real signed release identity: baseline enrollment, exact reinstall and a genuinely different candidate, preserving the original key/device, saved credential and successful protected connection. The private-copy harness does not replace product-updater or real two-PC acceptance. Whole-product prepublication QA remains subject to the existing daily policy.

Changing future signing identity does not migrate an existing ad-hoc item's ACL, recover a missing key, or authorize reenrollment. Preserve such profiles and their original authorized owner. Any migration is a separate reviewed operation; these hooks do not broaden ACLs, alter the native no-UI policy, disable library validation, or create a new remote identity.

## Primary references

- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing): signing/notarization distinction and code-identity-sensitive macOS APIs.
- [Electron osx-sign renderer entitlement example](https://github.com/electron/osx-sign/blob/main/entitlements/default.darwin.renderer.plist) and GPU equivalent: the explicit JIT entitlement used by this policy.
- [Apple TN3127: Inside Code Signing — Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements): Developer ID issuer/Application extension markers and Team identity under an Apple anchor.
- [Apple Code Signing Requirement Language](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html): `anchor apple generic`, certificate positions, OU fields and exact `H"SHA1"` certificate matching.
- The installed electron-builder/app-builder-lib 26.15.3 primary implementation: `macPackager.js` memoized credential setup and app signing, `mac/MacTargetHelper.js` distribution identity/entitlement handling, `codeSign/macCodeSign.js` explicit selectors/PR policy, and `platformPackager.js` beforePack ordering. The local `codesign(1)` manual documents `--test-requirement` verification. These APIs are version-bound; re-review hooks when upgrading the packaging dependencies.
