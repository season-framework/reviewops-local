# Direct remote management

This branch connects the shared-data foundations to Settings, an HTTPS browser view, and ReviewOps app connections for issue #107. Both incoming listeners start disabled. Browser and app approval are independent; browser approval never grants write or execution access.

## Connect a browser

Open **Settings → Remote management**, initialize this computer's identity for its concrete IPv4 address, and enable browser access on an unused port. Export the public certificate and compare its SHA-256 fingerprint on the connecting computer before explicitly trusting it. ReviewOps does not install a trusted root or change global TLS verification. Create a one-use invitation, enter it in the browser, and approve the requested browser with selected projects on the working computer.

The browser shows shared projects, reviews, comments and status history, attachment metadata, and agent status and saved responses. It refreshes an approved visible view every 15 seconds and marks retained data stale after a failed refresh. It cannot change reviews or run an agent. Attachment file downloads and uploads are not implemented by this increment.

## Connect another ReviewOps app

Enable app access separately and create an app invitation. On the connecting computer, initialize its own protected identity, then add the working computer's IP, port, public certificate, verified fingerprint, and invitation under **Other PC connections**. Approve that app on the working computer, selecting project read, review write, and agent execution permissions independently.

The remote workspace distinguishes its working computer from local projects. It supports review creation and editing, comments and status changes, and host-side agent start, follow-up request creation/start, and stop. Host settings select the execution environment, including SSH; incoming commands cannot replace paths, executables, or credentials. A revision conflict retains the editor's input. An uncertain command result is looked up using its original request ID rather than silently submitting another operation.

## Identity and recovery

macOS stores the identity key through an app-owned native Keychain module, independent of the existing Chromium browser-cookie policy. Windows uses Electron safeStorage with DPAPI and refuses unavailable or plaintext storage. Private identity material and saved connection credentials are excluded from project backups. Client bearer credentials are sealed using a separate scope-bound key derived from the OS-protected device identity. Host approval files contain token hashes, never replayable bearer credentials.

Approved app sessions expire after 24 hours. Saved approved connections can reopen while that approval remains valid. Revocation, a restored dataset epoch, or a changed project birth invalidates access. Lost identity material requires explicit recovery or new pairing; the provider does not silently replace a lost key. Changing an address or expired certificate requires stopping incoming listeners and reissuing the certificate with the same identity key. Port binding errors are shown in Settings. Sleeping or shutting down the working computer makes it unavailable; routing and firewall configuration must allow the selected IP and port.

## Development and verification

`npm run dev` builds the macOS N-API identity modules before starting Electron. The native build requires locally installed Node headers and Xcode Command Line Tools; it does not download headers. Electron Builder's `beforePack` hook builds both macOS architectures, and `afterSign` verifies the final signed module hashes. Windows uses no native identity addon. Renderer builds publish only the browser entry's dependency closure to the HTTPS listener, excluding the desktop entry and source files.

Focused tests cover committed Store reads, scoped approvals, lifecycle draining, revision checks and durable command receipts, actual HTTPS pairing/reconnection, and protected credential persistence. The feature smoke script uses isolated development data and a test-browser SPKI trust allowlist; it does not change OS trust. These checks do not substitute for installed macOS–Windows, real two-PC acceptance, or comprehensive pre-release QA. Issue #107 remains open until its full installed-platform scenarios, attachment transfers, and reconnect/input preservation requirements are verified.
