# Internal committed Store read bridge

The Store bridge is a disconnected application-internal boundary. It creates no peer approval, session, listener, IPC operation, identity provider or network capability. The existing six-operation local query API and PR102 authority core keep their contracts; the bridge uses a separate bounded internal entry for three browsing operations.

`createPeerReadStoreBridge(originalStore, fixedReader)` is an application bootstrap export from `electron/store.cjs`. It accepts exactly two arguments: a successfully initialized original Store and one synchronous, observational application-owned function. The registry, original connection, owner claim and transaction frames remain lexical private state. No registration function, raw SQL runner or guard bypass is exported. A prototype-shaped fake, replacement connection or serialized object cannot acquire the original bridge.

Bootstrap is once per original Store. Its claim is reserved before inspecting the current connection or reader. A duplicate or failed bootstrap cannot free that claim for reuse. An invalid reader leaves ordinary Store use and closure available because it creates no active view or returned bridge; it still consumes the claim. The fixed reader is invoked without the private owner as its JavaScript receiver. It cannot be replaced or supplied anew on each read.

## Bridge and view methods

The frozen bridge exposes `sample()`, `read()` and `retireAndClose()`. All take no arguments.

- `sample()` eagerly reads the existing frozen `{epoch, projects:[{projectId,birth}]}` metadata and returns it only after its own guarded transaction commits. It never invokes the fixed reader or shared-data kernel.
- `read()` invokes the installed fixed reader once inside one guarded transaction. Its result remains private until confirmed COMMIT and the final frame checks. The reader receives a frozen view with `dataset()` and `query(context, operation, payload)` only.
- `retireAndClose()` is a separate, explicit application lifecycle operation. It permanently retires the owner and attempts the captured original connection's native `close()` once, without checkpoint SQL, reopening or retry. It is refused and poisons the frame if attempted during a normal active interval. A confirmed close makes subsequent retirement harmless; a throwing/unknown close leaves retirement in force and cannot be retried through this API. It cannot release the bootstrap claim or adopt another connection.

An ordinary idle `Store.close()` remains available. After that call confirms closure of the matching original connection, the bridge is permanently retired and later `retireAndClose()` performs no additional native close. Failed ordinary closure does not mark the bridge confirmed closed or change the ordinary failure outcome. The public `closed` flag alone is never evidence of confirmed bridge closure.

`view.dataset()` takes no arguments. During `read()` it lazily reads and caches frozen birth metadata within that same transaction. `view.query(context, operation, payload)` accepts exactly three trusted internal arguments and only `projects.list`, `reviews.list` or `reviews.get`. It consumes its one query opportunity before query work, then uses the bounded internal kernel entry with the existing DTO validators. No raw snapshot, row key, loader or database is exposed.

The query does not implicitly call `dataset()`. This keeps the independent content bounds testable and confers no authority: a later birth-aware facade must obtain the dataset before authorization and content entry. That facade, its immutable inputs, scoped provider, approval/session bindings, cancellation and post-content release fence are a separate phase. The bridge alone is not a safe network endpoint or an authorization adapter.

View methods are callable only during their original fixed-reader interval. They expire immediately when that callback exits, before inspecting its result's `then` property, and stay expired during COMMIT/ROLLBACK and after success/failure. A failed `dataset()` or `query()` retains its first actual error and poisons that frame. Catching the error and returning manufactured data cannot turn the read into success. A second query attempt cannot replay or replace the first one. A caught forbidden Store mutation also poisons its original frame. Rejected bridge read/sample reentry does not itself poison an otherwise valid outer read if caught.

## Bounded coherent content

The loader first checks real project/review count sentinels. Counts are exact at or below 100,000; 100,001 means overflow, not the complete table cardinality. Overflow refuses the whole operation with existing `INVALID_SNAPSHOT` / `Shared data is unavailable.` Only SQL-bounded rowid-text/identifier key inventories use `.all()`, and their lengths must match the admitted counts. Description/body fields are never loaded in bulk. Selected rows use original-key `.get()` calls, preserving selector identity without truncation, fabricated empty arrays or deduplication that hides rows.

SQL type/octet guards bound each consumed field before driver conversion. General text permits at most three storage bytes per allowed UTF-16 unit under UTF-8 or two under UTF-16le/be; ASCII fields use one or two. Existing JavaScript validators still enforce exact length, grammar, dates and NUL rules. Control epoch/ID projections are also finite. Migration, triggers and schema are unchanged. `projects.list` checks the real review count but reads no review field; the other operations avoid foreign content and `reviews.get` avoids other own review bodies.

Only validated, admitted DTOs are sorted, by binary-equivalent ASCII dates/IDs: projects `createdAt,id`, reviews `updatedAt DESC,id`. There is no full-body SQL sorter or locale-sensitive comparison. Existing DTO fields and fixed resource-refusal semantics remain. The separate six-operation local kernel entry is unchanged.

The complete version-1 JSON result is limited to 1,048,576 UTF-8 bytes, including envelope, keys and punctuation. An exact numeric escaping counter runs before each DTO is retained and produces no JSON during the protected interval. Equality is accepted; cap+1 refuses the whole result with `BROWSING_QUERY_LIMIT_EXCEEDED` / `Shared browsing response exceeds the read limit.` Valid oversized lists are not corrupt snapshots. Early size refusal need not inspect later content for a later corruption. It never returns a shortened array or replays the query.

The view does not call the full Store `snapshot()` or local-window adapter, and does not fetch services, activities, attachments or settings. Key/control inventories have finite row/cell bounds separate from the one-MiB response limit. These are query/control-read bounds, not bounds for Store construction, migration, import or backup. Object overhead, database I/O, heap/RSS, CPU deadlines and future network framing are not proved by that JSON bound. Two-PC and live transport acceptance remain separate.

## Write exclusion and cleanup

Write exclusion begins before owned `BEGIN IMMEDIATE` and remains held through callback, COMMIT and any required owned ROLLBACK. A private frame guard is added to public `transaction` and the direct/early entry paths `upsert`, `insertActivity`, `migrate`, `importData`, `backup` and `close`. In particular, import is refused before validation-Store creation, and backup/close before filesystem or native connection effects. Other transaction-based mutators are stopped before their SQL bodies; this does not claim their earlier input normalization/getters never run.

A pre-existing Store transaction is refused before an interval starts. A raw caller-owned SQL transaction makes BEGIN fail; the bridge never rolls it back. Because an exception does not prove that a controlled BEGIN seam performed no SQL, every unconfirmed BEGIN outcome retains quarantine. This conservative policy can deny further peer reuse while preserving the caller's transaction. Direct raw-connection/control-table writes and privileged replacement of application internals are not sandboxed.

Successful COMMIT is never followed by a false rollback. With confirmed rollback, original kernel, reader, COMMIT and throwing `then`-accessor errors retain their identity, including the first retained view-method failure. If rollback also fails, the outward `AggregateError` has code `PEER_READ_UNAVAILABLE`, `cause` equal to the original primary object, and `errors` containing `[primary, cleanup]`. Both remain diagnosable. Bridge ownership, phase, arity, poisoning, known-thenable and per-view query-slot refusals otherwise use `PEER_READ_UNAVAILABLE` / `Committed peer read state is unavailable.` Unsupported operations use `INVALID_QUERY` / `Invalid shared-data query.`

Cleanup clears a frame slot only by exact identity and a confirmed COMMIT/ROLLBACK disposition. Unknown cleanup leaves the same original frame non-callable and quarantined; a later raw COMMIT, matching epoch or recovered provider does not revive it. Only explicit owner retirement/closure can dispose of that quarantine. No callback retry, second kernel query, connection adoption or approval minting occurs here.

The fixed reader must not emit, log, serialize or publish pending data. Synchronous-return enforcement rejects thenables, including a throwing `then` accessor. It cannot erase objects retained by trusted callback code or stop side effects that such code already started. This is an application-owned reviewed boundary, not a JavaScript sandbox.

## Compatibility boundary

This slice changes no schema, logical-backup format, authority API, existing local six-operation query API, main/preload mapping, UI, credentials or network behavior. The additional internal bounded entry is not a request-supplied source/grant override. The existing foundation remains schema 12 with logical-backup format 10; a schema-12 database cannot be opened by stable 1.5.0's schema-11 Store. Ordinary Store operations retain their existing behavior outside bridge intervals and retirement.

## Earlier bridge validation

On Node.js 24.22.2 on an Intel Mac, all 60 focused bridge cases passed. The full CJS suite completed 1,713 tests: 1,712 passed, one Windows-only case was skipped, and none failed. The 60 focused cases are included in that total. The renderer build also passed. These checks use owned temporary SQLite databases; installed-application, peer-authentication, transport and two-PC validation remain separate.

## Current C bounded-browsing local validation

The C focused run passed all 141 cases with no failures or skips. The build completed with exit code 0 and the existing chunk-size warning. The first C full run explicitly used `node --test --test-concurrency=2 tests/*.test.cjs`: 1,794 total, 1,793 passed, one Windows-only skip and no failures. The focused cases are a subset of that full run, not additional acceptance counts.

These are local Source/owned-SQLite checks covering encoding, row/cell, complete DTO-byte and failure/recovery cases. They establish no installed-app, cryptographic-provider, network, two-PC, CPU-deadline or heap/RSS outcome. This configured-concurrency C result does not convert the historical B default-concurrency failure into a pass or establish its cause; the earlier validation records above remain separate.
