# Internal birth-bound peer browsing

`createPeerReadBrowsing({store, verifyPeerHandle})` composes the existing Store read bridge and peer authority for three internal browsing operations. It is disconnected from main/preload, renderer IPC, listeners and transport. It adds no pairing UI, OS identity/key provider, persistence or network endpoint. The injected verifier recognizes a trusted original handle; a string ID or fingerprint is not authentication, and TLS connection binding, expiry and key rotation are not implemented here.

The factory accepts exactly one own-data ordinary/null-prototype record with those two fields. It accepts no core, bridge, kernel, provider, callback or per-request Store override. It acquires the genuine original Store's once-only bridge before constructing its private core. A duplicate bootstrap cannot replace or close an existing owner's bridge. The fixed content reader, core, bridge, scopes, grants and connections never escape.

## Application-only API

The returned object is frozen and exposes exactly these methods:

| Method | Contract |
| --- | --- |
| `setEnabled(boolean)` | Default is false. Enable is refused during another operation. Valid disable cancels pending work, even when already disabled. An actual transition changes activation and retires old sessions. |
| `approvePeer(peer, {projectIds})` | Performs a local approval after one committed control sample. IDs are unique and bounded by 1,000; an empty list stays empty. Approval while disabled is allowed. Returns undefined. |
| `revokePeer(peer)` | Removes the published approval and returns the core's removal boolean. It also cancels a matching pending first approval when no approval exists and the result is false. |
| `openSession(peer)` | Requires enabled state and a current published local binding, samples committed controls, then returns an original opaque facade capability. It returns no resource content. |
| `closeSession(capability)` | Closes that owned original and cancels a query using it. Returns the core's live/retired result; repeat close returns false. A foreign or serialized token is denied. |
| `query(capability, operation, payload)` | Returns an unchanged detached kernel DTO after one protected content interval and a fresh release control sample. |
| `retireAndClose()` | Idle application lifecycle only. Retires all facade authority before closing the captured bridge owner. It is refused during an operation without attempting close. Confirmed closure is idempotent; a failed close leaves the facade terminal and is not retried. |

The query allowlist is exactly `projects.list` with `{}`, `reviews.list` with `{projectId}`, and `reviews.get` with `{projectId, reviewId}`. It does not expose the other local kernel operations. Handles and capabilities are original process-local objects/functions, never portable credentials. Capabilities are frozen empty null-prototype objects backed by a WeakMap; their inner capabilities and binding metadata are private.

Malformed factory options/arity use `INVALID_AUTHORITY_CONFIG`. Malformed application arity and approval input use `INVALID_AUTHORITY_REQUEST`; malformed query names/payloads/arity use `INVALID_QUERY`. Invalid approve/open identity types, missing approvals, foreign/known-retired capabilities and disabled access use `ACCESS_DENIED`; primitive revoke handles are invalid authority requests. A schema-valid option containing a fake/replaced Store propagates the bridge's refusal. Existing limit, kernel and Store errors are not converted into missing-resource success. A later wire adapter needs a separate public error allowlist.

## One captured operation and irreversible cancellation

Only one approval, open or query may be in flight. Its unique private record is installed before descriptor/prototype inspection. Exact own-data captures reject getters, holes, symbols, duplicate IDs, extra fields and non-ordinary array prototypes without reading accessor values. The owned approval array and shallow query payload are copied and frozen before Store/verifier/COMMIT seams; the same captured IDs drive birth lookup, core approval and kernel input. The caller's original objects are never frozen in place or reread later.

A valid revoke, close or disable cancels applicable pending work permanently. Deleting an approval cannot reset the pending record, and finally clears only that same original operation. Nonrestrictive approve/open/query/enable and idle-only retirement attempts are refused during another operation before changing authority; a caught refusal alone does not cancel the outer read. There is no unbounded tombstone map for handles that were never approved.

Requests known to be disabled, to lack local approval, or to use a foreign, serialized, closed or locally retired capability stop before Store access. This is a local knowledge guarantee. A capability whose retirement is hidden in the core may still require a control interval before the core refuses it. Proxy traps and privileged JavaScript side effects are not sandboxed; installing the operation first makes reentrant cancellation well-defined.

## Birth bindings and verifier outcomes

At most 64 published peer bindings hold the original Store, epoch and frozen approved `{projectId,birth}` pairs. A complete valid committed sample synchronizes these bindings. If its epoch differs or any approved project is missing/recreated, the entire affected binding is revoked and its old capabilities remain denied. A later explicit local approval can use the new sample and create fresh originals; it never revives old ones. That fresh approval is not automatically cancelled merely because synchronization retired its previous stale binding. An actual `revokePeer` during the new approval still cancels it.

Unrelated peers/projects, ordinary project metadata, review edits and monotonic counter increases do not revoke an unaffected binding. Unavailable/corrupt metadata is an error, not an empty project set, and never falls back to the last successful sample. A recoverable control read failure with confirmed rollback does not invent birth revocation; unknown transaction cleanup remains the Store bridge's separate quarantine outcome.

The delegated verifier calls the trusted verifier once per core invocation and preserves its exact result/throw. Only an actual non-true result or throw changes that peer's verification generation and cancels matching work. The core then retires all of that peer's live sessions while keeping its approval. After recovery, fresh sessions can use the retained approval with a current control sample; old generation tokens stay denied. `ACCESS_DENIED` alone is not evidence of verifier failure, because metadata/provider failures also use it.

The core owns the sole 256-live-session quota. There is no outer live-capability Set, retired-token collection or independent session counter. Weak outer capability records reference shared binding/activation/generation identities. Approval records stay bounded by 64 peers, IDs by 1,000, and there is only one pending operation and current provider scope. Disable/re-enable, reapproval, revocation or confirmed birth change cannot restore an old original.

## Protected content and release boundary

The fixed bridge reader calls `view.dataset()` first, synchronizes births outside the core provider, and installs a content scope for that exact original operation/view. The provider returns only frozen `{epoch,projectIds}` from this protected dataset. It performs no Store reads, revocation or grants of its own. The core's `withReadContext` passes its context unchanged to exactly one `view.query` call, preserving existing DTO fields/order and fixed NOT_FOUND behavior. No raw snapshot, local-window fallback or caller context is accepted.

The content scope is cleared before the fixed reader returns. The Store bridge expires its methods, validates the synchronous result, and commits or rolls back under write exclusion. The facade holds the committed content privately, checks cancellation, obtains one fresh committed metadata sample, synchronizes births again, and installs a release scope. A second core `withReadContext` checks current lifecycle/verifier/provider authority while returning the already computed DTO. It performs no second content query. Final identity/activation/generation/cancellation checks precede return.

Each scope has an exact original owner, Store, operation, identity and allowed phase. Missing, cancelled, wrong-phase or expired scopes deny; finally clears only that original scope. No scope/provider/current-dataset/callback override or stale-view fallback exists. Approval and open use separately committed admission scopes; no approval/session is minted inside a Store read view. A later stage failure discards any newly changed candidate authority rather than restoring a previously revoked approval.

A successful query therefore has one bridge read, one kernel query and one release sample. Failure never triggers replay. A lifecycle change in either COMMIT seam withholds the pending DTO. Ordinary review edits between content and release do not cause an aggregate-revision fence: content belongs to the first committed interval, permission to the final committed control sample and synchronous lifecycle checks. Database changes after that last control sample are ordered after its permission check. This is not a promise about later socket queues, serialization or eventual network flush.

The fixed module-owned reader must not publish, log, emit or serialize pending content. Return-value withholding is not a JavaScript sandbox against trusted callback effects. Retirement is a separate idle owner operation; on its native-close failure all facade authority stays terminal. Valid-arity authority methods then deny without Store work, and another retirement call does not retry close.

## Scope and compatibility

The Store bridge, birth bookkeeping, authority core, six-operation query kernel, local adapter, main/preload, schema and logical-backup format are unchanged. This internal composition is not installed-app, TLS, remote-input, service transport or two-PC acceptance. Row bounds inherited from the Store/kernel do not establish a network byte/time budget. Live integration requires separate identity/transport, credential, approval UI, request/response budget and delivery-boundary review.

## Validation and remaining test limitation

The 55 focused browsing cases passed. The renderer build passed with the existing large-chunk warning. A complete run with `node --test --test-concurrency=2 tests/*.test.cjs` passed 1,767 tests with one Windows-only named-pipe/path-casing case skipped (1,768 total).

The first default `npm test` run failed one existing agent model-timeout assertion: `modelSource` was undefined instead of `cache` (1,766 passed, one failed, one Windows-only skip). The unchanged case then passed once in isolation. Source inspection points to an earlier version-probe refusal path, but the specific original process outcome and cause were not recorded. The later configured full pass does not establish that the default-concurrency failure is fixed. No production or test code was changed to hide that failure. These are local automated checks; installed-app, network and two-PC behavior has not been validated here.
