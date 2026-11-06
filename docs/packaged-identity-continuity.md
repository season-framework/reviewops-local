# Packaged remote identity continuity

`scripts/e2e-packaged-identity-continuity.mjs` checks one OS user's real protected
remote identity and saved app connection through an exact same-version bundle
reinstall and a later, genuinely different packaged build. It uses the packaged
product's Keychain or DPAPI provider, HTTPS listener, approval, credential sealing
and saved connection code. It does not inject a provider, edit an ASAR, change
Keychain ACLs, or replace a missing identity.

This is a focused feature harness. Private bundle copying is its installation
mechanism: it does **not** establish NSIS installation, the product updater UI,
two-PC networking, or comprehensive release QA.

## Prepare admitted packages

Build the baseline and candidate separately from their real source commits using
the existing test packaging commands. Both packages must contain valid
`electron/reviewops-build.json` metadata naming their exact full source SHA. The
candidate must have a later version or test build number and different ASAR bytes.
Do not manufacture a candidate by editing the baseline's resources or version.

Use a dedicated owner-only directory named `reviewops-identity-inputs-*`. Place
the external baseline and candidate bundles in separate children. macOS inputs
are `ReviewOps.app`; Windows inputs are private `ReviewOps` directories containing
`ReviewOps.exe` and `resources/app.asar`. Input bundles are read-only to this
harness and are rechecked after the run. Never point it at a user's installation.
Use a dedicated Windows test account for the DPAPI check.

An example macOS plan, with real paths and full SHAs substituted:

```json
{
  "schema": 1,
  "platform": "darwin",
  "arch": "x64",
  "privateRoot": "/private/tmp/reviewops-identity-inputs-example",
  "baseline": {
    "appPath": "/private/tmp/reviewops-identity-inputs-example/baseline/ReviewOps.app",
    "source": "7343a6f41e80e264d2b9e046ae057f196e8a0a21"
  },
  "candidate": {
    "appPath": "/private/tmp/reviewops-identity-inputs-example/candidate/ReviewOps.app",
    "source": "66b88e542ddcbf07cc79b097185cdae6cb284910"
  }
}
```

The current repository must contain both source commits. Admission compares
packaged runtime modules with those Git objects, validates embedded build/source
identity, inventories every physical file, and records executable/ASAR hashes.
macOS additionally verifies the actual signature, designated requirement, target
architecture and both unpacked addon hashes. Windows checks the real PE target
and records Authenticode status. Unsigned Windows builds are reported accurately.

## Run once on the matching OS and architecture

```sh
node scripts/e2e-packaged-identity-continuity.mjs --plan /absolute/plan.json
```

The harness creates a fresh private installation and data profile. Only the first
baseline phase enrolls an identity. It establishes an actual read-only HTTPS
self-connection and saves its protected credential. Each following phase uses
strict protected reopening and the original sealed credential; it never calls
enrollment or certificate renewal. After natural exit of the original process,
the exact baseline is reinstalled, followed by the real candidate bundle at the
same private application path. Each phase verifies unchanged device/key/leaf,
private index/certificate hashes, credential scope/ciphertext/token hashes,
approved principal, dataset and project. The actual saved connection must reopen
and read its original shared project.

Reports contain safe fingerprints, bundle/source/build identity and original
process exit observations. They contain no private keys, bearer credentials or
Keychain references. Public certificate and one-use invitation values are used
transiently in the normal product pairing flow and are not included in reports.
The isolated profile contains its normal product ciphertext and opaque reference.
Protected main observations replace failures with one fixed error before they
cross the Playwright boundary, including malformed decrypted credentials and
provider errors.
Reports retain fixed startup steps and error categories; protected failures can
include only known provider codes and a small allowlist of OSStatus values that
the actual product returns. Missing native detail remains unknown. Runtime and
provider imports use the original packaged main module loader. Before launch,
the shared native path helper checks the production socket limit; macOS uses a
short owned directory under `/private/tmp`.

On macOS, the actual main PID must match the retained direct child. On Windows,
Playwright retains `cmd.exe`: the actual main must be its distinct direct child,
identified through the original Electron main handle. A read-only PowerShell
observer opens and retains that main's native process handle, records its exact
creation ticks and executable, and waits for that same handle's exit code. The
original main handle must still report the same PID and parent after binding.
Bundle replacement requires main exit code zero, retained shell exit code zero,
observer closure and the original Electron application close event. Access denial,
missing birth/exit proof or a changed identity fails closed. No process name
search, later PID adoption or termination is used.

## Failure and cleanup

On success, the final verified product process removes only the fixture's exact
original Keychain item using its returned reference and digest. DPAPI has no
per-item OS record to delete. The private profile is removed only after the
original final application process exits naturally.

On denial, changed identity, uncertain cleanup or an unconfirmed exit, execution
stops before another bundle replacement. The original profile, private bundles
and report remain available. No ACL broadening, automatic reenrollment, global
Keychain deletion, forced process termination or speculative cleanup is attempted.
An unconfirmed original process can keep the driver alive for inspection. A
retained fixture may still have a Keychain item; do not delete its private index
until its exact original item has been cleaned using the admitted baseline owner.

The present ad-hoc macOS signing configuration requires this check. Apple's
[code signing requirements](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html)
identify an ad-hoc signature with one specific program, while
[TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
describes Keychain tracking through designated requirements. Signature validity
and preserved profile files alone do not prove access after an update. Record an
actual result before changing signing policy or claiming continuity.

The focused unit tests cover inert package/process-stream fixtures and the
serialized protected observation boundary. They do not execute an installed app,
PowerShell, Keychain or DPAPI. Syntax and unit success prepare the harness for a
separate native run; they do not establish continuity on either platform.
