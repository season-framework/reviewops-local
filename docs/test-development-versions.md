# Test development identity

The application/package semver stays `major.minor.patch`. A test build has two
separate integers: the existing global `buildNumber` and a new
`developmentNumber` scoped to that base version. The visible version is
`1.2.11-dev-2`. Old metadata without a development number remains
`1.2.10-test.8001`; it is never relabeled with an invented development number.
Stable builds continue to display their plain semver.

## Assignment and retries

The existing `reviewops-test-latest` workflow lock covers metadata, all three
native packages, validation, publication and cleanup. A publication request adds
one reservation to `reviewops-test-development` in the existing `test-latest`
release body. Only the matching workflow's `metadata` job, with explicit
publication enabled, may write it. Validation-only runs read the next candidate
number without changing the release.

A reservation binds base version, development number, global build number,
full source SHA, the original ISO/UTC timestamp and the actual previous public
pointer's commit. Repeating that metadata job reuses the original identity,
including its timestamp. Reusing a global build number for another source or
base version fails. Reserved numbers are not recycled after a failed build, so
the public sequence can contain gaps. Each base version starts its own numeric
sequence. All native jobs receive exactly the same reservation output.

The ledger rejects duplicate identities and malformed records. It is never
trimmed to make room: exceeding its bounded size fails the release instead of
forgetting a number or overwriting a public version.

## File compatibility

The five verified native files retain the old `-test.BUILD` names in the schema-2
`artifacts` and `installers` maps. Already installed updaters require those exact
names. The producer also uploads canonical `-dev-N` aliases of the same verified
file bytes, with equal sizes and SHA-256 values. New maps
`developmentArtifacts` and `developmentInstallers` identify those names. New
updaters select the canonical names and reject any mismatch with the legacy
descriptors. Older updaters ignore the new maps and can install the same bytes.

Base versions are compared numerically first, development numbers numerically
within a base version, and the existing global build rollback guard remains.
The same public development number cannot denote another build. No updater
preference, project, review or data location is migrated by this change.

## Publication and change history

Change notes are computed from the reserved previous public commit to the
candidate's exact commit, after verifying Git ancestry. They contain real commit
subjects, full commit links and the full comparison link. A list longer than
100 commits reports the real total and links the complete comparison. If there
is no previous public pointer, the UI says that no change range is available.

Each published development version has a source-bound JSON history asset. It
records its build identity, predecessor, actual change list, manifest digest and
all canonical/legacy file hashes. The body links these records. Rotating the
latest installer set preserves history assets, including bytes uploaded before
a failed pointer switch. A retry must match those bytes. Existing published
history is rechecked before writes; a missing/changed history, reservation,
pointer or asset aborts publication. The pointer and published history ledger
switch in one release-body PATCH under the workflow lock. Tags never move.

Unit contracts exercise an actual copy of the previously deployed updater and
synthetic publication stores. Those checks are distinct from installing an old
packaged app, performing the native update and verifying its stored data after
restart. Source UI tests use isolated generated identities and updater responses;
they do not publish or install a test release.
