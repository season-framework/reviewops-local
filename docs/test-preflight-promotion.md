# Promote a verified test preflight

Use **Promote verified test preflight** (`promote-test-release.yml`) when a successful validation-only test build is already accepted and unchanged. It downloads and verifies the original producer packages and context, then publishes those same bytes. It performs no renderer build, native packaging, feature tests, version bump, model execution, email, or tag movement.

The workflow is manual and defaults to `publish: false`. It shares `reviewops-test-latest` with the original publisher. Normal same-run allocation/publication guards remain unchanged. Promotion runs with its real publisher run and source identity; embedded app metadata continues to identify the original producer.

## Select and preview

Prepare the `candidate` JSON from the reviewed original run and its Actions artifact metadata. Pin all four original artifact IDs and GitHub SHA-256 archive digests, not just their names. Use a full source SHA and the original metadata output's context hash. Set `qaNotBefore` to the next eligible Korean calendar date under the release policy.

```json
{
  "schema": 1,
  "runId": 123456789,
  "runAttempt": 1,
  "source": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "contextSHA256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "qaNotBefore": "2026-11-08",
  "artifacts": [
    {"id": 101, "name": "reviewops-test-build-context", "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
    {"id": 102, "name": "reviewops-test-build-darwin-arm64", "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
    {"id": 103, "name": "reviewops-test-build-darwin-x64", "digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},
    {"id": 104, "name": "reviewops-test-build-win32-x64", "digest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}
  ]
}
```

These values are illustrative. Dispatch the promotion workflow with this JSON and `publish: false` for a read-only preview. The receipt records the original producer, actual publisher, frozen build identity and proposed release files. No public reservation, asset or pointer changes occur.

Before using a selected producer, the workflow checks the same repository, workflow, full source SHA, exact run/attempt, successful required jobs, skipped original publication, and original metadata log's `reserved: false`. It checks each pinned artifact's identity, digest, size, provenance and job-attempt timing, then verifies the downloaded archive bytes before bounded extraction. It consumes the original frozen context and native verification records. Release highlights come from the producer's Git catalog; later publisher edits do not silently change the accepted summary.

Missing or expired artifacts stop promotion. There is no arbitrary local-package import or automatic rebuild fallback. Account for the one-day producer retention window when scheduling the next eligible QA date. The daily 04:00 fallback may occur after an earlier producer's artifacts expire.

## Publish the original candidate

Perform the required comprehensive product QA once on an eligible Korean date, using the exact accepted candidate and packages. Reuse its already accepted native/feature evidence where valid. Record the real scenarios, results, photos and report under the release policy; this workflow does not perform or certify that work.

For `publish: true`, provide a `qa` declaration with exactly these fields:

- `schema: 1`, `passed: true`, and the actual `koreanDate`.
- `build`: the complete unchanged original producer build object from the preview.
- `contextSHA256`: the original context hash.
- `packages`: the first five legacy installer descriptors in the preview's file list, each containing only `name`, `size` and `sha256`, in that order.
- `reportSHA256`: the actual completed QA report's SHA-256.

The declaration is an explicit maintainer assertion bound to the candidate; the workflow validates its shape, date and exact package/build identities. It does not independently inspect the PDF or enforce another chat's daily QA record. The release task remains responsible for the actual QA and daily limit. The declaration is retained in the promotion receipt. The receipt is created before reservation/publication and retained on failure. An interrupted publication records an unconfirmed outcome, because a lost response may follow an already completed pointer switch.

Under the shared lock, publication rereads the existing release and allocation ledger. It reserves the original predicted development number only if it remains available and the frozen previous public commit is still current. An identical prior reservation is reused after interruption. A conflicting allocation, changed predecessor, newer public build, modified history or changed public filename stops publication; no package is relabeled or overwritten.

The existing uploader verifies every new file, then switches the pointer/history ledger in one release-body update and verifies it before retiring previous test installers. It retains published history and stable releases. Promotion leaves the original producer artifacts intact through reporting. Finish the existing Korean report/email procedure once after the actual release is confirmed; the promotion workflow does not send mail.

An exact promotion retry uses the same candidate JSON, original packages and declaration. It neither claims the publisher's run number as the app's build nor fabricates a new production source SHA.
