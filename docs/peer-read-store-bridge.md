# Internal committed Store read bridge

The Store bridge is a disconnected application-internal boundary. It creates no peer approval, session, listener, IPC operation, identity provider or network capability. The existing local shared-data operations and PR102 authority core remain unchanged and are not composed here.

`createPeerReadStoreBridge(originalStore, fixedReader)` is an application bootstrap export from `electron/store.cjs`. It accepts exactly two arguments: a successfully initialized original Store and one synchronous, observational application-owned function. The registry, original connection, owner claim and transaction frames remain lexical private state. No registration function, raw SQL runner or guard bypass is exported. A prototype-shaped fake, replacement connection or serialized object cannot acquire the original bridge.

Bootstrap is once per original Store. Its claim is reserved before inspecting the current connection or reader. A duplicate or failed bootstrap cannot free that claim for reuse. An invalid reader leaves ordinary Store use and closure available because it creates no active view or returned bridge; it still consumes the claim. The fixed reader is invoked without the private owner as its JavaScript receiver. It cannot be replaced or supplied anew on each read.

## Bridge and view methods

The frozen bridge exposes `sample()`, `read()` and `retireAndClose()`. All take no arguments.

- `sample()` eagerly reads the existing frozen `{epoch, projects:[{projectId,birth}]}` metadata and returns it only after its own guarded transaction commits. It never invokes the fixed reader or shared-data kernel.
- `read()` invokes the installed fixed reader once inside one guarded transaction. Its result remains private until confirmed COMMIT and the final frame checks. The reader receives a frozen view with `dataset()` and `query(context, operation, payload)` only.
- `retireAndClose()` is a separate, explicit application lifecycle operation. It permanently retires the owner and attempts the captured original connection's native `close()` once, without checkpoint SQL, reopening or retry. It is refused and poisons the frame if attempted during a normal active interval. A confirmed close makes subsequent retirement harmless; a throwing/unknown close leaves retirement in force and cannot be retried through this API. It cannot release the bootstrap claim or adopt another connection.

An ordinary idle `Store.close()` remains available. After that call confirms closure of the matching original connection, the bridge is permanently retired and later `retireAndClose()` performs no additional native close. Failed ordinary closure does not mark the bridge confirmed closed or change the ordinary failure outcome. The public `closed` flag alone is never evidence of confirmed bridge closure.

`view.dataset()` takes no arguments. During `read()` it lazily reads and caches frozen birth metadata within that same transaction. `view.query(context, operation, payload)` accepts exactly three trusted internal arguments and only `projects.list`, `reviews.list` or `reviews.get`. It consumes its one query opportunity before query work, then delegates DTO construction to the unchanged shared-data kernel. No raw snapshot or database is exposed.

The query does not implicitly call `dataset()`. This keeps the independent content bounds testable and confers no authority: a later birth-aware facade must obtain the dataset before authorization and content entry. That facade, its immutable inputs, scoped provider, approval/session bindings, cancellation and post-content release fence are a separate phase. The bridge alone is not a safe network endpoint or an authorization adapter.

View methods are callable only during their original fixed-reader interval. They expire immediately when that callback exits, before inspecting its result's `then` property, and stay expired during COMMIT/ROLLBACK and after success/failure. A failed `dataset()` or `query()` retains its first actual error and poisons that frame. Catching the error and returning manufactured data cannot turn the read into success. A second query attempt cannot replay or replace the first one. A caught forbidden Store mutation also poisons its original frame. Rejected bridge read/sample reentry does not itself poison an otherwise valid outer read if caught.

## Bounded coherent content

Only the project/review columns needed by the kernel are materialized. Project SQL keeps `ORDER BY createdAt,id`; review SQL keeps `ORDER BY updatedAt DESC,id`. Every required array uses a literal SQL `LIMIT 100001` before `.all()`, including reviews for `projects.list`. The 100,001st row causes whole-operation `INVALID_SNAPSHOT` with the existing fixed message `Shared data is unavailable.` No truncation, partial success or fabricated empty array hides overflow. Below the bound, the existing kernel supplies the same DTO fields, ordering, validation and fixed NOT_FOUND behavior.

The view does not call the full Store `snapshot()` or local-window adapter, and does not fetch services, activities, attachments or settings. Row counts alone do not bound total string bytes, CPU time or elapsed time. Network framing, byte/time budgets and two-PC acceptance remain unimplemented.

## Write exclusion and cleanup

Write exclusion begins before owned `BEGIN IMMEDIATE` and remains held through callback, COMMIT and any required owned ROLLBACK. A private frame guard is added to public `transaction` and the direct/early entry paths `upsert`, `insertActivity`, `migrate`, `importData`, `backup` and `close`. In particular, import is refused before validation-Store creation, and backup/close before filesystem or native connection effects. Other transaction-based mutators are stopped before their SQL bodies; this does not claim their earlier input normalization/getters never run.

A pre-existing Store transaction is refused before an interval starts. A raw caller-owned SQL transaction makes BEGIN fail; the bridge never rolls it back. Because an exception does not prove that a controlled BEGIN seam performed no SQL, every unconfirmed BEGIN outcome retains quarantine. This conservative policy can deny further peer reuse while preserving the caller's transaction. Direct raw-connection/control-table writes and privileged replacement of application internals are not sandboxed.

Successful COMMIT is never followed by a false rollback. With confirmed rollback, original kernel, reader, COMMIT and throwing `then`-accessor errors retain their identity, including the first retained view-method failure. If rollback also fails, the outward `AggregateError` has code `PEER_READ_UNAVAILABLE`, `cause` equal to the original primary object, and `errors` containing `[primary, cleanup]`. Both remain diagnosable. Bridge ownership, phase, arity, poisoning, known-thenable and budget refusals otherwise use `PEER_READ_UNAVAILABLE` / `Committed peer read state is unavailable.` Unsupported operations use `INVALID_QUERY` / `Invalid shared-data query.`

Cleanup clears a frame slot only by exact identity and a confirmed COMMIT/ROLLBACK disposition. Unknown cleanup leaves the same original frame non-callable and quarantined; a later raw COMMIT, matching epoch or recovered provider does not revive it. Only explicit owner retirement/closure can dispose of that quarantine. No callback retry, second kernel query, connection adoption or approval minting occurs here.

The fixed reader must not emit, log, serialize or publish pending data. Synchronous-return enforcement rejects thenables, including a throwing `then` accessor. It cannot erase objects retained by trusted callback code or stop side effects that such code already started. This is an application-owned reviewed boundary, not a JavaScript sandbox.

## Compatibility boundary

This slice changes no schema, logical-backup format, authority/kernel API, main/preload mapping, UI, credentials or network behavior. The existing foundation remains schema 12 with logical-backup format 10; a schema-12 database cannot be opened by stable 1.5.0's schema-11 Store. Ordinary Store operations retain their existing behavior outside bridge intervals and retirement.

## Validation

On Node.js 24.22.2 on an Intel Mac, all 60 focused bridge cases passed. The full CJS suite completed 1,713 tests: 1,712 passed, one Windows-only case was skipped, and none failed. The 60 focused cases are included in that total. The renderer build also passed. These checks use owned temporary SQLite databases; installed-application, peer-authentication, transport and two-PC validation remain separate.
