# Internal peer-read authority and session core

This disconnected authority core is an internal prerequisite for the direct-read pilot in issues #10 and #11. It does not add a listener, cryptographic authentication, TLS, an OS-key provider, pairing UI, persistence or a remote query route. The existing six local shared queries, their kernel and the local main-frame adapter are unchanged.

The core answers one internal question: may this exact original application-owned session enter a synchronous read callback using the current approved project grants? A future transport must prove its connection-to-identity binding separately. Device IDs, fingerprints, session strings and display names do not authenticate a caller here.

## Trusted providers and exact schemas

`createPeerReadAuthority({verifyPeerHandle, currentDataset})` requires exactly two synchronous functions. Configuration and provider records must be plain or null-prototype objects with exact own data properties. Unknown fields and accessors are rejected. Providers are application-owned callbacks, not request-supplied code.

- `verifyPeerHandle(handle)` returns strict `true` only when its trusted identity system recognizes that exact opaque object/function handle. A truthy string, Promise, record or thrown error denies. The core does not read identity fields on the handle. Production TLS proof, certificate expiry, key rotation, connection binding and OS-key protection are absent; a stub accepting a handle does not establish any of them.
- `currentDataset()` returns exactly `{epoch, projectIds}`. `epoch` is a lowercase UUIDv4 string. `projectIds` is a dense ordinary array of unique existing project IDs, each matching `[A-Za-z0-9_-]{1,128}`. It is the complete current project set, not a caller-selected grant set. Missing, malformed, asynchronous or failed provider output denies without invoking the read callback. The provider must read one coherent committed state and must not perform authority mutations or other side effects.

The epoch and current project set are injected through this narrow provider. This slice makes no Store changes. Existing Store write-admission methods remain opaque Store ownership/epoch checks, not peer grants, and are not exposed to remote callers merely to obtain this information.

## Internal API

| Method | Exact input and behavior |
| --- | --- |
| `setEnabled(value)` | A boolean only. Initially false. A real transition in either direction retires every live session. Repeating the current boolean is unchanged. Returns the current boolean. |
| `approvePeer(handle, {projectIds})` | Exactly one dense unique ID array; every requested project must currently exist. Requires the trusted verifier. Replaces that handle's entire approval and retires its old sessions even when the grant list is identical. An empty list is valid and grants nothing. Approval is allowed while sharing is disabled; it does not enable sharing. Returns no credential or capability. |
| `revokePeer(handle)` | Retires every original session for that exact handle and removes its approval. It does not need verification to revoke an already invalid handle. Returns whether an approval existed. |
| `openSession(handle)` | Requires enabled state, current successful verification, a current-epoch approval and available capacity. Returns a new frozen, fieldless, null-prototype capability tracked by this authority's private WeakMap. No transport session ID is generated. |
| `closeSession(capability)` | Retires that authority-owned session and releases live capacity. Returns true once, then false for the same retired capability. A foreign or forged capability denies. |
| `withReadContext(capability, reader)` | Checks the exact original session and current providers, invokes one trusted synchronous callback with the context below, checks current authority again, and only then returns its result. No asynchronous work is admitted by this API. |

The callback receives exactly `{projectGrants: [{projectId, read: true}]}` with a newly constructed frozen outer record, array and grant records. The order is the explicit approval order. No principal, device, key, epoch or private handle is exposed in this context. Empty approval produces `projectGrants: []` even if the dataset contains other projects; it never means unrestricted access.

There is no operation adapter in this milestone. A future direct-read adapter can call the existing kernel inside this synchronous callback, initially allowing only `projects.list`, `reviews.list` and `reviews.get`. It must construct that operation allowlist and its network envelope explicitly, rather than exposing this callback API or forwarding arbitrary IPC.

## Original ownership and lifecycle

Every session retains the exact peer handle, exact approval-record identity, activation identity and observed dataset epoch from its creation. A serialized capability, a capability from another authority, or another verified handle cannot adopt it. Revocation followed by reapproval, an identical approval replacement, disable/re-enable, and an observed epoch A-to-B-to-A sequence do not revive retired originals. A failed verification retires all live sessions for that handle; a later successful verification requires fresh sessions.

Each authorization boundary samples the trusted verifier and current dataset anew. An observed epoch transition retires all sessions and clears project approvals before another read can enter. A provider failure denies that read but does not claim that an epoch transition occurred. If the provider later confirms the same original state, a session that was not otherwise retired may be used again.

An observed missing project is removed permanently from each affected approval, and those approval originals' sessions are retired. A later same-ID project does not regain the removed grant; explicit current local approval and a fresh session are required. Approval of an already missing project is refused. With only epoch and existing IDs, the core cannot detect a same-epoch delete/recreate that occurs entirely between observations. A future adapter must supply project-incarnation evidence or invalidate affected approvals from its complete mutation feed before claiming protection for that schedule. This implementation does not make that broader guarantee.

`withReadContext` checks again after the callback and after inspecting its returned thenable property. Reentrant revoke, approval replacement, disablement, observed epoch/project changes, verification loss or provider failure withhold the returned result. A Promise, async-function result or other callable `then` produces `INVALID_READER`; the then function is not called. A thrown then getter also produces the fixed reader error. A normal synchronous query error retains its original identity instead of being relabeled as an authentication error.

These fences do not roll back callback side effects, stop an async body already started by a trusted callback, erase a context retained by trusted code, or prevent trusted code from using such a context elsewhere. The composition rule is mandatory: the application supplies a synchronous, side-effect-free query callback, without an intervening await or later use as a cached authority grant. The core returns no usable result when its post-check fails, but it is not a transaction around arbitrary trusted code. The providers likewise must be synchronous and observational.

## Bounds and fixed errors

The authority holds at most 64 approved handles, 1,000 project IDs per approval, 256 live sessions and 100,000 existing project IDs in one provider record. Bounds are fixed internal constants, not caller-overridable options. Excess approval/session capacity produces `AUTHORITY_LIMIT_EXCEEDED`. An oversized approval array is an invalid request; an oversized dataset array denies current authority. No partial grants are returned.

Revoke, approval replacement, observed deletion, disablement, epoch transition and explicit close remove retired records from the strong live-session set. Retired capabilities remain invalid through the WeakMap while their trusted caller retains them; no global history of retired capability keys is kept. This is a live-authority capacity bound, not a network byte/time limit or a bound on arbitrary objects retained by trusted application code. Approvals survive disable/re-enable in memory, while sessions do not. Nothing survives process restart.

| Code | Fixed message |
| --- | --- |
| `INVALID_AUTHORITY_CONFIG` | `Peer read authority is unavailable.` |
| `INVALID_AUTHORITY_REQUEST` | `Invalid peer read authority request.` |
| `ACCESS_DENIED` | `Peer read access is unavailable.` |
| `AUTHORITY_LIMIT_EXCEEDED` | `Peer read authority limit exceeded.` |
| `INVALID_READER` | `A synchronous application-owned read callback is required.` |

Provider error details are not included. Query callback errors are internal results; a future network adapter still needs its own public error allowlist and must not send arbitrary exception text.

## Verification scope and next integration gate

The behavioral tests use injected stub identity and dataset providers, not crypto or a production Store. They cover original capability identity; strict provider/schema refusal; detached/frozen empty and selected grants; revoke/reapprove/identical replacement; activation and observed epoch transitions; observed deletion; pre/post-callback failures; thenable refusal; and bounded resource reuse. The focused command `node --test tests/peer-read-authority.test.cjs` passed all 24 cases on Node.js 24.22.2 on an Intel Mac. No application, cryptographic provider, network connection or two-PC behavior was tested. No formal CI QA IDs are added.

Keep the current macOS browser-cookie `use-mock-keychain` policy and SSH credential vault unchanged. Selecting an independently verified OS-protected identity-key provider is still a prerequisite before connecting this core to real peer approval or TLS. Static source does not establish safeStorage behavior under the current switch. There is no plaintext/adjacent-key fallback, new secret file, automatic identity generation or Keychain call in this slice.

After that provider and TLS/bootstrap design are reviewed, the next stage can compose an opt-in host, exact three-operation network adapter and isolated remote browsing view. Two owned instances on one computer demonstrate transport/lifecycle behavior only. Actual two-PC approval, browsing, project denial, revocation, reconnect and restore checks remain necessary for cross-PC acceptance; none is inferred from these source contracts or the earlier six local queries.
