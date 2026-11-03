# Durable review-write consistency core

This milestone adds an internal Store boundary, not a renderer, IPC, MCP, remote-write or cross-PC feature. Existing local writes are not conditional yet. Do not expose the new status command until local editors and every asynchronous writer carry admission epochs and deliberate revision tokens through their eventual commits.

## Persistence and compatibility

Database schema 11 adds `dataset_meta`, `review_revisions` and `command_receipts`. They stay outside business snapshots, `TABLES` and logical exports. Logical backup format remains 10, and imports still accept formats 1 through 10. Unsupported top-level backup fields, including control metadata, are rejected. A physical SQLite/profile copy contains control data; this in-database epoch does not detect rollback of itself.

The unpredictable dataset epoch persists across restart. A successful logical import rotates it, retires old receipts and reseeds revisions in the same live transaction as business replacement. Independent validation epochs are never imported. Failed validation or live replacement preserves the original business graph, epoch, revisions and receipts. Old exhausted counters are reseeded only inside that rollback-capable epoch transition.

## Aggregate and writer coverage

A revision is an opaque monotonic invalidation token, not a count of user actions. Database triggers cover insert, update and delete on reviews, activities, attachment metadata, agent runs and saved follow-up requests. Child owner moves invalidate both reviews. Direct queue SQL, agent progress, completion/transfer, startup interruption, review copy/version/target edits and service-link/FK changes therefore use the same boundary. File contents, project headers, settings, runtime readiness and process ownership are outside this aggregate.

A review deletion marks its sidecar as a tombstone before cascade work. Child triggers increment the existing sidecar without reviving it. Reusing a review ID increments its retained counter and records that birth revision in an internal `generation` field. A receipt committed before that birth cannot be replayed against the new row, while ordinary later edits still allow the original receipt. The public token remains epoch plus revision. Values are constrained to safe positive JSON integers. Overflow or a missing sidecar aborts the business statement. No exact per-action increment is promised.

## Synchronous internal command

`reviewWriteState({projectId, reviewId}, callerProvider)` reads a scoped status, epoch and revision in one Store transaction. `setReviewStatusCommand(intent, callerProvider)` accepts exactly `requestId`, `projectId`, `reviewId`, `epoch`, `expectedRevision` and `status`. Both APIs require a synchronous application-owned provider returning `{principalId, projectGrants: [{projectId, write: true}]}`. This is an internal authority input, not a payload, device authentication system or persisted pairing record.

The command obtains current grants inside `BEGIN IMMEDIATE`, scopes the actual review and checks the live epoch before looking up a receipt. Missing and unauthorized targets share fixed `NOT_FOUND`. An identical original intent returns the immutable original acknowledgement before comparing the now-current revision; changed intent with that identity conflicts. Revocation and deleted/no-longer-owned targets are checked again even for retries. A new intent compares the revision, checks the 100,000 active-receipt budget, applies normal Store status/activity rules and inserts its bounded acknowledgement atomically. A no-op status stores a receipt without changing the aggregate revision. Receipts cannot be updated or deleted in their active epoch; no active identity is silently evicted.

The fingerprint is SHA-256 of a versioned fixed primitive tuple. Acknowledgements contain only operation/target/identity/status, committed epoch/revision/time and a changed flag, with a 4 KiB bound. Notifications remain a future after-commit responsibility. Promise/thenable transaction results are rejected, and a caught nested transaction failure still forces outer rollback.

## Validation and activation gates

The DB-only contracts cover migration/reopen, all supported backup formats, control-field rejection, the five-table raw writer matrix, owner moves/FK/cascades, ordinary agent/copy paths, immutable retries and fresh scope, overflow, receipt budget, injected receipt/COMMIT/import failures, nested synchronous rollback, two owned SQLite connections, two simultaneous original worker handles and deliberate natural child exits before/after COMMIT. Focused validation passed in two separate commands: 21 new-core contracts and 88 existing Store/request/copy contracts, each with zero failures or skips. The subsequent full 90-file macOS Node run completed 1,335 tests: 1,334 passed, zero failed and one Windows-only named-pipe case was skipped. The first full run is preserved as 1,333 pass/one failure/one skip; its artificial version-9 fixture was corrected to remove schema-11 control data before constructing the historical schema. The focused and full runs overlap and are not added as unique coverage.

Before any exposed writer, separately integrate local edit tokens, stale asynchronous agent/queue/version/staged-file fences and restore resynchronization. File/DB atomicity, uploads, credentials, TLS, relay/discovery, physical rollback/re-pairing and actual multi-PC behavior remain outside this core. The existing release highlights are preserved; an unconnected foundation is not announced as a completed sharing feature.
