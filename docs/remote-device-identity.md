# Remote device identity

`createRemoteDeviceIdentity({app, dataPath})` belongs to the original Electron
main process after `app.whenReady()`. The constructor accepts no loader, platform,
keychain, mock, or credential override. Both development and packaged apps use
the same public DTOs and protected-key verification before reporting `ready`.

- macOS uses the fixed N-API 8 addon and the default file Keychain. Each item has
  the fixed ReviewOps service, an immutable random account, and an explicit
  current-process creator ACL. It preserves the browser-cookie mock setting;
  Chromium safeStorage is not the Mac identity backend. Native calls disable
  Keychain user interaction process-wide and do not restore it on shutdown.
- Windows uses Electron 44's synchronous safeStorage/DPAPI API. Only encrypted
  payload is persisted. DPAPI protects against other Windows users, not other
  applications already running as the same user. Mock/basic encryption flags
  and unavailable encryption are refused. Linux is unsupported.

The private `remote-device-identity` profile is separate from Store exports and
backup data. On POSIX its directory/files require 0700/0600, original-owner
snapshots, no symlinks and one file link. Windows inherits the actual user's
profile ACL and uses bounded regular-file/identity checks; POSIX mode bits are
not an assertion about Windows ACLs. Private keys are never written as plaintext.
The public certificate is self-signed; operators must explicitly trust its
public leaf. No OS trust store is modified by this module.

First enrollment persists a pending intent before one key creation. Interrupted
or uncertain creation is never automatically retried. An existing profile with a
missing/protected-unreadable key fails closed; initialize never silently replaces
that device identity. Reissuing a certificate for a new address keeps the same
device and private key. Deleting the whole profile outside the app between
processes cannot be distinguished from an explicit new profile; this is not a
credential recovery or migration protocol. App single-instance ownership remains
required; Node pathname snapshots do not provide hostile same-user atomic CAS.

`sealCredential` and `openCredential` are main-only helpers for saved app bearer
tokens. They verify the existing protected key, use a separate HKDF-SHA256 context
and AES-256-GCM with exact connection scope AAD, and never enroll or reissue.
Only ciphertext is persisted by their caller, outside backups. Buffer copies are
wiped; V8 strings/KeyObjects and native TLS internals have GC-managed lifetimes.

## Build and focused checks

On macOS, run `node scripts/build-remote-identity.cjs` with locally installed Node
headers (or `--headers /absolute/include/node`). It builds/signs both macOS 13+
architectures and publishes the final-byte manifest last. Generated binaries and
manifest are ignored by Git. Mac packaging must unpack `electron/native/**/*`,
ignore these already signed addons in the signing pass, and use
`scripts/verify-remote-identity.cjs` as its `afterSign` hook. The app resource seal
still covers the bundled addons. Signing/ACL continuity across application
updates must be verified for the actual release identity; the manifest does not
prove that continuity. Windows needs no native addon build.

Run `node --test tests/remote-device-identity*.test.cjs` for controlled tests.
`REVIEWOPS_TEST_NATIVE_IDENTITY=1` additionally runs a real development Electron
main fixture on Mac: temporary profile, Keychain enrollment, explicit-leaf TLS,
separate-process reopening, certificate reissue, credential sealing, and exact
fixture-item deletion. It uses the already installed Electron executable and
never downloads one. This is feature QA, not packaged upgrade or Windows OS QA.
