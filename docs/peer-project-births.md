# Internal project births for future peer reads

This Store foundation records project incarnations for a future peer read adapter. It does not connect
PR #102's authority core to a listener, UI, key provider, peer approval, session,
query composer, IPC, MCP or network. The existing authority module, its 24 tests
and its documentation remain unchanged. The existing six local query DTOs and
backup format 10 remain unchanged.

## Why an epoch and project ID are insufficient

An empty project can be deleted and recreated with the same ID and timestamps
between two observations. Ordinary project deletion does not change the dataset
epoch. Review generations cannot identify a project with no reviews. A timestamp,
SQLite row ID or the current project-ID set is therefore not a birth guarantee.

Schema 12 adds two private control tables:

- `peer_project_birth_counter` holds one row: the current dataset epoch and an
  integer counter from zero through `Number.MAX_SAFE_INTEGER`.
- `peer_project_births` holds one unique positive birth value for each live
  project. It retains no deleted-project history. Retained bookkeeping is one
  singleton plus the current project set, rather than an unbounded tombstone log.

The migration backfills all existing projects in project-ID order inside the Store's
migration transaction. That one-time backfill reads their IDs and allocates one
row per existing project; its work and temporary ID array grow with the local
project count. The 100,000-project bound applies to the new reader, not a silent
truncation of migration input. A larger legacy graph is backfilled but the peer
reader then refuses it in full. Large-graph migration stress has not been validated. Ordinary metadata updates retain their births. SQL
triggers advance the counter and assign a new birth on every project insertion
and ID change. Deletion removes the live row. An insertion replaces any prior
birth for that ID, so `INSERT OR REPLACE` still receives a fresh birth when SQLite
recursive delete triggers are disabled. An ID change A-to-B-to-A also receives
new births even when no reader observes the intermediate name.

The triggers use SQL only and apply to business-table writes from another SQLite
connection; they do not depend on that connection loading a JavaScript callback.
They are not a defense against privileged control-table/schema tampering.

Counter increments and birth assignment belong to the same transaction as the
project mutation. An explicit trigger `RAISE(ABORT)` refuses an unavailable or exhausted counter
before incrementing it, independently of an outer `INSERT OR IGNORE` or
`UPDATE OR IGNORE` conflict policy. SQL constraints also enforce the safe range;
no unsafe counter or birth value is converted to JavaScript. The reader also uses SQL `CASE` guards to mask
invalid or out-of-range integers before the driver converts them, then validates
the exact live set, uniqueness, counter bound and current epoch.

See SQLite's [trigger conflict rules](https://www.sqlite.org/lang_createtrigger.html)
and [conflict resolution](https://www.sqlite.org/lang_conflict.html) for the
outer-statement policy and statement rollback behavior.

## One committed metadata reader

`Store.peerReadDataset()` accepts no arguments and returns a fresh, deeply frozen
record with exactly this shape:

```js
{
  epoch,
  projects: [{projectId, birth}]
}
```

Projects are ordered by ID. At most 100,000 are returned. Missing, orphaned or
malformed birth state, epoch mismatch, an unavailable Store or a failed read or
commit produces `PEER_READ_UNAVAILABLE` with the fixed message
`Committed peer read state is unavailable.` No partial state is returned. The
method neither reads project content nor traverses services, credentials, review
bodies, activities, attachments or settings.

The entry rejects a pre-existing Store transaction. Its new top-level transaction
must commit before the result is returned; there is no caller callback or point
at which an approval or capability can be minted. A raw transaction started
directly on the SQLite connection also prevents the fresh `BEGIN`; the reader
must not roll back that caller-owned transaction. No undocumented native
transaction-state API is used.

A rolled-back project insertion may reuse a counter value later. This is safe
only because this API never exposes an uncommitted birth. A direct call to the
bookkeeping module's raw `readDataset(db)` has no committed-state guarantee and
must not be used as an authority provider. The Store entry is the admitted API.

`Store.transaction()` currently uses `BEGIN IMMEDIATE`. This metadata interval is
synchronous; it must never span socket I/O or an `await`. The method
issues no business mutation, revision, receipt or data-change notification. These source checks do not establish installed-application file/WAL invariants.

## Database-version compatibility

Schema 12 cannot be opened by the currently released stable 1.5.0 application,
whose maximum supported database schema is 11. The existing newer-database refusal is retained. Logical backup
format 10 and its DTOs remaining unchanged does **not** provide an automatic
physical-database downgrade. Upgrade/rollback communication and any later
packaged validation must state that difference explicitly.

## Import and backup behavior

The ordinary snapshot and logical export continue using their explicit existing
table lists. Neither new control table is included in those DTOs or logical
backups; caller-supplied control values remain unsupported import fields.

During logical import, the existing consistency core first changes the epoch and
the Store removes the old business graph. Only with a different epoch and no live
projects may the birth counter reset. Imported projects then receive new births.
An epoch plus a birth is an internal incarnation pair, not a device identity or
portable grant. A failed import rolls back epoch, business rows and both sidecars
together. Same-epoch reset is refused. A successful new-epoch import can reset an
exhausted old counter without reviving an old epoch-bound observation.

Physical database/profile rollback, copying a database, and privileged mutation
of consistency controls remain outside this guarantee. A future facade must bind
the original Store instance as well as its observed epoch and project birth.

## Integration remains blocked

The unchanged PR #102 provider accepts exactly `{epoch, projectIds}` and does not
consume births. This foundation alone does not fix that disconnected core's
documented unobserved-recreation limitation and must not enable live peer reads.

The next separately reviewed composition must cover every approval, session-open
and query path with application-owned epoch/project-birth admissions; invalidate
mismatched originals permanently; and compare current committed authority at the
actual read boundary. It must not pass a third field to the old exact provider
or silently discard births. Separate calls to this reader and `snapshot()` do
not establish one coherent query interval. A private Store-owned read view and
its commit-failure rules need review before a three-operation composer is added.

That composer must call `querySharedData` with the authority's context directly.
The local-window adapter deliberately grants all current projects to an unbound
local window and is unsuitable for a peer. Only `projects.list`, `reviews.list`
and `reviews.get` are proposed initially; no new DTO, arbitrary IPC forwarding or
caller-supplied grants are implied. OS-protected identity, TLS binding, network
budgets and actual two-PC acceptance remain separate gates.

Future database invariant snapshots must include these **two additional control
tables**. Earlier 13-table native observations describe earlier source and are
not retroactively expanded.

The focused project-birth, Store and consistency suite passed all 88 cases on
Node.js 24.22.2 on an Intel Mac, including the 17 project-birth cases. The full CJS
suite completed 1,653 tests: 1,652 passed, one Windows-only case was skipped, and
none failed. The 88 focused cases are included in that total and are not added to
it. The renderer build also passed.

These source and owned temporary SQLite checks do not establish installed-app,
peer-network, cryptographic-authentication or actual two-PC acceptance. PR #102's
authority remains uncomposed with this internal birth projection.
