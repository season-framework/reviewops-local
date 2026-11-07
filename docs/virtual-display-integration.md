# Virtual display and relay integration status

This integrates the independent experimental changes from PR #46, PR #48 and
PR #116 into the current application tree. They are available for reviewed
engineering work; they do not add a shipping OS-display, capture or input provider.
The regular Electron application, installer, release workflows and read-only web
session capabilities remain independent of these experiments.

## Relationship and execution

| Component | Integrated PR head | Relationship |
| --- | --- | --- |
| macOS private display lifecycle | `525411716672c22c47514c3a3dbd07d8783ef09a` (#46) | Independent private-API lifecycle experiment |
| Hidden web capture diagnostics | `4afe5158929c26af11eecf4325b127d018169ded` (#48) | One independent diagnostic commit over the already-integrated next-feature base; the later product capture fix is already present |
| Windows IDD/installer/control foundations | `debb418032b3b1f252d472ec74403f7bab47eb5b` (#116) | Independent native driver, package, device and file-owned control components |

All three heads are retained as merge ancestors. None is silently substituted for
another. Original branch pushes retain their existing execution path. Maintainers
can also select the corresponding experimental workflow on `main` with **Run
workflow**. Automatic main pushes, PRs, arbitrary refs and self-hosted native probe
contexts do not activate them. The macOS lifecycle workflow additionally requires
`acknowledge_disposable_runner=true`: its private API can change runner topology.
Both its launcher and compiled native helper enforce the selected context. A local
`--compile-only` binary cannot create a display. These environment checks prevent
accidental execution; they are not an authentication boundary against an operator
who controls both the build and environment.

The six Windows workflows compile or exercise negative/private component cases;
they never import a driver package, create a software device or send display
control IOCTLs to a real driver. Their common gate binds hosted Windows, repository,
main manual dispatch/original prototype push, exact source and original attempt.
The gate's own PowerShell test changes only process environment variables and
restores them in `finally`. The admission workflow still requires the exact
hash-bound original unsigned fixture; an expired artifact is an explicit failure,
not permission to download a different package.

## #8: macOS acceptance still required

The original #46 run `41363588142` at source `5254117` passed its Intel lifecycle
and failed ARM after an existing display changed from 1024x768 to 1920x1080. Owned
object cleanup restored the baseline. That historical ARM failure is unresolved;
this integration does not turn restored state into a successful lifecycle.
Strict existing-display inventory comparisons, the original failure and the
one-owned-object cleanup remain intact. No physical display mode restoration,
second-display workaround or ignored ARM result is introduced.

Before enabling a provider, reproduce and resolve this failure on disposable ARM
and Intel hosts, establish supported macOS/private-ABI and distribution bounds,
and prove creation/resize/removal without existing-display geometry changes.
Then implement project-owned target selection, application-window placement and
return, OS capture, scoped input and Korean IME, target revalidation, permission
revocation, lock/sleep/restart and the installed-app capture-to-review flow. The
current code performs no OS frame capture, input injection or permission request.
A hosted synthetic lifecycle does not replace those installed hardware checks.

## #9: Windows acceptance still required

The integrated driver is an unsigned experiment. Production admission requires a
Microsoft production-trusted catalog covering the exact approved INF/DLL bytes;
no signed positive package is supplied by this tree. Creating a certificate,
changing boot trust or accepting an unrelated signed catalog is not a substitute.
The IddCx swap-chain worker acknowledges and discards frames; it is not a capture
or streaming provider. The current device/control tests include scripted native
callbacks and event handles, not a live monitor.

Complete native broker authentication against the actual standard-user app
process/session/project birth, elevation cancellation, signed package install and
update/removal, and packaged helper delivery before app activation. Prior local
uncommitted broker/UI files are not part of these reviewed PR heads and are not
implicitly accepted by this integration. Then verify real Windows 10/11 x64
installation, monitor create/remove and own-window return, scaling, standard-user
input/Korean IME, UAC limits, pressed-key release, capture provenance and review
attachment, sleep/RDP/device loss, restart and update. Retain working web sessions
when the driver is absent or fails. Local macOS tests cannot certify these paths.

## #11: relay and virtual-screen boundary

The current `peer-read-authority`, Store bridge and `peer-read-browsing` modules
provide internal identity-verifier hooks, birth-aware project read authorization,
revocation and bounded local reads. They are not a relay transport or an endpoint
with cryptographic device authentication. The live `viewer-sessions` provider is
web-only and advertises `input:false` and `virtualDisplay:false`.

Required next integration, separately from direct IP/port connectivity (#10/#107):

1. Bind an outbound work-PC connection and approved client to the authenticated
   device/project grants from #109; treat relay addresses as routing, not identity.
2. Authenticate the two device keys end to end and derive directional encryption
   keys. Bound and sequence encrypted messages so the relay cannot read project
   data, frames, keystrokes or attachment contents and cannot replay operations.
3. Bind direct/relay fallback to the same target, project and restore generation;
   preserve drafts and deduplicate terminal write results. Relay failure must not
   stop local or working direct sessions.
4. Add separate screen-view and screen-control grants plus a host approval/stop
   action. Track pressed keys/buttons per original input lease. Target change,
   disconnect, grant revocation, lock or stale frames must close admission and
   release that lease's original inputs before another target can be selected.
5. Connect only an actually verified OS provider from #8/#9. Reject stale capture
   proof at attachment acceptance using the existing project/draft generation
   boundaries; do not represent a generic web frame as a virtual-monitor frame.
6. Exercise two real PCs with direct access blocked, encrypted relay forwarding,
   reconnect, app exit, server loss and permission withdrawal. Local synthetic
   protocol tests are additional evidence, not this acceptance result.

No relay, E2EE, OS input lease or two-PC acceptance is enabled by these merges.
The related issues therefore need explicit remaining acceptance items in their
result comments even when the experimental PRs themselves are integrated.
