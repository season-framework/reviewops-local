# Direct remote management

This branch connects the shared-data foundations to Settings, an HTTPS browser view, and ReviewOps app connections for issue #107. Both incoming listeners start disabled. Browser and app approval are independent; browser approval never grants write or execution access.

## Connect a browser

Open **Settings → Remote management**, initialize this computer's identity for its concrete IPv4 address, and enable browser access on an unused port. Export the public certificate and compare its SHA-256 fingerprint on the connecting computer before explicitly trusting it. ReviewOps does not install a trusted root or change global TLS verification. Create a one-use invitation, enter it in the browser, and approve the requested browser with selected projects on the working computer.

The browser shows shared projects, reviews, comments and status history, attachments, and agent status and saved responses. It refreshes an approved visible view every 15 seconds and marks retained data stale after a failed refresh. It cannot change reviews or run an agent. A download verifies sequential chunks and the complete SHA-256 before saving an inert file. Files are limited to 10 MiB.

## Connect another ReviewOps app

Enable app access separately and create an app invitation. On the connecting computer, initialize its own protected identity, then add the working computer's IP, port, public certificate, verified fingerprint, and invitation under **Other PC connections**. Approve that app on the working computer, selecting project read, review write, and agent execution permissions independently.

The remote workspace distinguishes its working computer from local projects. It supports review creation and editing, comments and status changes, attachment uploads to a review or an existing ordinary user comment, verified file downloads, and host-side agent start, follow-up request creation/start, and stop. Uploads use bounded chunks and original target/revision checks; temporary stages are cleaned after rejection, revocation, expiry, or startup recovery. Host settings select the execution environment, including SSH; incoming commands cannot replace paths, executables, or credentials. A revision conflict retains the editor's input. An uncertain command result is looked up using its original request ID rather than silently submitting another operation.

### Current data and original edit intent

The app client refreshes the selected workspace every 15 seconds. A failed
refresh marks the view stale and a transport or protected-credential failure
removes write/execute availability until a successful connection check. Cached
content and drafts remain visible. Host identity and IP remain above the remote
workspace; no operation changes the host's execution configuration.

Before exposing an editable review, the client reads command metadata before
and after the shared detail/timeline query. It adopts that snapshot only if the
dataset epoch, project birth, review generation and revision still match. A
new-review draft similarly belongs to the observed project incarnation. Every
mutation carries that original binding, including the client-observed project
birth and review generation; deleting and recreating the same identifiers does
not make an old draft current. A background refresh never rebases user input.
When a competing edit wins, the client preserves the draft and shows the latest
host content. Rebasing requires an explicit confirmation after comparison.

A lost reply keeps the original request ID and input. The result action looks
up that same durable receipt and clears only the exact submitted input after
confirmed completion. It never resends a command, file, or agent request. A
failed saved-host replacement preserves the previous endpoint, sealed
credential, and unresolved request ownership.

## Identity and recovery

Internal diagnostics can inspect the labels for an unfinished enrollment in the
current default macOS Keychain. The operation derives the account and digest
from the original canonical pending file, fences that file and its owner before
and after the lookup, and permanently restricts its native instance to metadata
inspection and close. It requests attributes only, with no protected data or
item references, and writes no profile files. There is no renderer or network
endpoint for this private diagnostic operation.

Finding a matching label does not verify its key or recover the enrollment.
Not finding it in the current default Keychain does not establish historical or
global absence: older pending files do not identify their original Keychain.
Both outcomes preserve the original pending state and unknown historical cause.
Neither permits automatic reset, replacement, deletion or re-enrollment.

macOS stores the identity key through an app-owned native Keychain module, independent of the existing Chromium browser-cookie policy. Windows uses Electron safeStorage with DPAPI and refuses unavailable or plaintext storage. Private identity material and saved connection credentials are excluded from project backups. Client bearer credentials are sealed using a separate scope-bound key derived from the OS-protected device identity. Host approval files contain token hashes, never replayable bearer credentials.

Approved app sessions expire after 24 hours. Saved approved connections can reopen while that approval remains valid. Revocation, a restored dataset epoch, or a changed project birth invalidates access. Lost identity material requires explicit recovery or new pairing; the provider does not silently replace a lost key. Changing an address or expired certificate requires stopping incoming listeners and reissuing the certificate with the same identity key. Port binding errors are shown in Settings. Sleeping or shutting down the working computer makes it unavailable; routing and firewall configuration must allow the selected IP and port.

### Identity failure diagnostics

Settings shows a validated failure stage, an allowed numeric OSStatus when it was
captured, and the cleanup outcome. It never displays an exception message,
private-key material, bearer credential, Keychain reference or storage path.
Earlier unfinished records without matching captured diagnostics remain
explicitly unknown; present Keychain availability cannot establish their
original failure.

Preparing an existing identity, opening TLS and reopening saved credentials keep
only a bounded, in-memory observation of an actual native preflight or protected
read failure. They do not write an enrollment intent or diagnostic journal. The
original request and metadata must still be current before that observation is
published.

For a captured live operation at `verify-protected-item` with `ITEM_READ_FAILED`
and OSStatus `-25293`, Settings reports that the operating system denied reading
the saved protected identity. Preserve that identity and its profile, and check
the app's authorization and signing status. This observation does not establish
an ACL or signing root cause and does not authorize deletion, replacement or
re-enrollment. Other stages, codes and statuses retain their own diagnostics;
OSStatus `-25308` alone is not reported as a locked Keychain.

Only a recorded default-Keychain locked condition offers guidance to check its
current state and, if still locked, unlock it in macOS Keychain Access and refresh
status. A retained diagnostic describes the earlier operation, not a new check
of the current vault. Refresh reads status; it does not
repeat enrollment or clear its unfinished intent. A pending enrollment keeps
identity setup disabled even after a lock is removed. Unknown outcomes do not
promise that unlocking or restarting will resolve the enrollment.

### Explicit retry of an existing protected identity

Settings offers **Retry reading the existing identity** when an existing
provider is unavailable. This action verifies only the existing canonical
index, persistent item reference, payload digest, key and certificate. It does
not enroll, create/delete an item, renew a certificate, rewrite the profile,
clear pending evidence, change an ACL, or enable Keychain interaction. A missing,
pending or changed original bundle fails closed. Connection status retry then
reopens the original sealed credential; a denied read leaves the saved
connection and draft intact and reports `credential_locked`.

On macOS, a changed application can require an explicit per-application grant
for the **existing item** through the operating system. Apple documents this
[per-item access control](https://developer.apple.com/documentation/security/access-control-lists)
and [Keychain Access workflow](https://support.apple.com/en-gb/guide/mac-help/kychn002/26/mac/26).
Do not select access for all applications or reset, delete or replace the item.
Unlocking a vault does not itself prove app authorization. The native module
continues to disable process-wide Keychain UI; this button cannot display an OS
authorization prompt. An explicit OS grant followed by a successful same-item
read is one possible acceptance path; a consistently signed Developer ID
update is another. Neither is inferred from a fixture or from a numeric error.
A native initialization that was permanently refused requires a new app process
before another read can be attempted; restarting alone does not promise recovery.

The native backend checks default-Keychain availability before a fresh
enrollment intent is written and checks again when creating the protected item.
Availability may change between those observations. A retained diagnostic is
bound to the original intent bytes, is not a capability to read/remove an item,
and never authorizes reset, automatic retry or replacement of the original
identity. Missing or mismatched evidence stays unknown.

## Development and verification

`npm run dev` builds the macOS N-API identity modules before starting Electron. The native build requires locally installed Node headers and Xcode Command Line Tools; it does not download headers. Electron Builder's `beforePack` hook builds both macOS architectures, and `afterSign` verifies the final signed module hashes. Windows uses no native identity addon. Renderer builds publish only the browser entry's dependency closure to the HTTPS listener, excluding the desktop entry and source files.

Focused tests cover committed Store reads, scoped approvals, lifecycle draining, revision checks and durable command receipts, actual HTTPS pairing/reconnection, and protected credential persistence. The feature smoke script uses isolated development data and a test-browser SPKI trust allowlist; it does not change OS trust. These checks do not substitute for installed macOS–Windows, real two-PC acceptance, or comprehensive pre-release QA. Issue #107 remains open until its full installed-platform scenarios, host agent execution and reconnect/input preservation requirements are verified.
