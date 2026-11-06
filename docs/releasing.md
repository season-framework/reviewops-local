# Releasing ReviewOps

Release artifacts are published at `season-framework/reviewops-local`. The introduction site is published from the `gh-pages` branch. The application uses **GitHub Releases directly** for updates, not the website.

## Release note language and structure

Maintain repository documentation and release notes in English. Continue GitHub issue and comment discussions in Korean.

Lead release notes with a concise description of the user-visible impact. Group changes under **New features**, **Improvements**, **Fixes**, and **Known limitations**, using only categories that have content. State what changed in each item and link the relevant issue or PR. Follow the feature changes with **Install and update** and relevant **Verification** details. Keep source commits, build identifiers, artifact references, and detailed validation records below the user-visible changes.

Describe only features included in that release. Distinguish source, packaged-app, and installed-app checks, identify the platforms actually tested, and retain material limitations. Preserve updater pointers, allocation ledgers, and history markers when editing a release body.

Maintain the reviewed English highlights in [`release-notes.json`](../release-notes.json). Each entry has a category, a short behavior-focused title, a description, and the full implementation commit SHA or SHAs. Update the catalog version when preparing a new base version. Avoid announcing a feature through a planning or merge commit alone.

The shared formatter generates both test-release descriptions and stable-draft descriptions. Test releases include a reviewed highlight only when all of its commits appear in the frozen change list since the previous public test build. They also read historical catalogs from those exact Git commits, using each catalog's own version, so resetting the current catalog for a stable version does not hide a fix that the test channel has not published yet. The current catalog takes precedence, followed by the newest frozen catalog for each older version; entries removed in a newer snapshot are not revived. The newest selected snapshot also owns each complete implementation-commit set, avoiding duplicate summaries across versions. Reads are limited to the existing 100-commit context; an absent catalog path is skipped, while a missing Git object or malformed catalog stops preparation. No historical code or network lookup is used. Stable drafts continue to use only the current version's catalog and check that every highlighted commit is an ancestor of the reviewed source; they do not read historical catalogs.

When at least one reviewed highlight matches, those highlights alone form the top-level change sections. Keep all user-visible changes in the reviewed catalog; raw merge subjects, validation work and overlapping branch history remain in the collapsed source details. If no reviewed highlight matches, feature, improvement and fix subjects retain the existing grouped fallback; raw documentation and maintenance subjects stay in source details. To announce a user-facing documentation or maintenance change above those details, add a reviewed, source-bound highlight. The detailed commit list and verified issue/PR links remain below the feature changes. Commit subjects containing non-Latin text are linked as **Source update** rather than treated as translated English feature descriptions. The original change-note JSON and its issue titles are retained unchanged for the app and immutable history.

GitHub already displays the release name, so the generated body does not repeat it as a top-level heading. Installer choices, known signing limitations, actual native verification, and source/build details follow the changes. A generated draft still identifies the pending issue-linked QA, report, and publication review; formatting does not publish it or certify additional UI scenarios.

## Prepare a release

1. Update the version in `package.json` and `package-lock.json`.
2. Review the changelog and public documentation. Use synthetic content for screenshots.
3. Run `npm ci`, `npm run build`, `npm test`, and UI tests relevant to the changes.
4. Build and inspect each platform and processor type you intend to publish. Do not publish a package that has not been built and checked.
5. Confirm that source and artifacts contain no credentials, user data, host configuration, or private screenshots.

```sh
npm run package
npm run package:intel
```

The DMGs are installation media. The updater requires separate ZIPs containing a single top-level `ReviewOps.app` bundle. On macOS, create them from the corresponding built application:

```sh
ditto -c -k --norsrc --keepParent release/mac-arm64/ReviewOps.app release/ReviewOps-1.2.0-arm64.zip
ditto -c -k --norsrc --keepParent release/mac/ReviewOps.app release/ReviewOps-1.2.0-x64.zip
```

Use the actual version for each release. Do not put application data, credentials, or installer volumes inside the ZIP. Verify the bundle's version, identifier, signature, and architecture before archiving it. Use `hdiutil verify` for each DMG and compute SHA-256 checksums for every downloadable package.

## Automated stable draft preparation

The chat checks new issues and comments hourly and resumes known development, integration, validation and pending test delivery every 30 minutes. A ready, reviewed change batch can proceed to release checks immediately; the daily **04:00 Asia/Seoul** task is a fallback for deferred QA and delivery. These schedules do not create a build or version when no actionable changes exist. The workflows have no separate schedule. Test delivery uses `test-release.yml` and its single `test-latest` prerelease without requiring a new stable version for each test build.

Comprehensive product QA is limited to one ready candidate per Korean calendar day, immediately before publication of either a test or stable release. Record the date, version, source and outcome before starting, and reuse valid evidence for that same candidate. A different candidate or changed source after that day's QA waits until the next eligible day for full QA and publication; implementation, integration, package preparation and necessary unit, integration or feature checks can continue. All required platform and installation checks still apply. Reuse the existing candidate, build allocation and live CI run for the same product source instead of dispatching duplicate builds or publishing each commit separately.

Choose the version change explicitly after reviewing the included changes:

| Change | Choice | Example from 1.2.10 |
| --- | --- | --- |
| Compatible fixes without new behavior | `patch` | 1.2.11 |
| Compatible new functionality | `minor` | 1.3.0 |
| An incompatible change requiring migration or changed usage | `major` | 2.0.0 |

Preview the choice, then write it with a short reason. The command updates `package.json`, the two root version entries in `package-lock.json`, and `release-plan.json`. It does not commit, push, tag, or publish anything. Writing requires committed package sources. The release plan records the previous version and source commit so the build can reject a mismatched or stale choice.

```sh
node scripts/stable-release.mjs version --bump patch --reason "Fix SSH folder diagnostics"
node scripts/stable-release.mjs version --bump patch --reason "Fix SSH folder diagnostics" --write
```

Review and commit these files with the release notes, merge the version change to `main`, and select that full reviewed commit. Dispatch `stable-release.yml` from `main` with `reviewed_commit`, `release_version`, and `deliver_to_draft`. Delivery is `false` by default; that mode only retains the verified package set as a workflow artifact. Selecting `true` may create or fill a matching **draft** and still never publishes it.

```sh
gh workflow run stable-release.yml --ref main \
  -f reviewed_commit=FULL_REVIEWED_MAIN_SHA \
  -f release_version=1.2.11 \
  -F deliver_to_draft=true
```

The workflow runs on native macOS arm64, macOS Intel, and Windows x64 runners. It checks the explicit version policy against the previous published stable version and requires `main` to remain at the reviewed commit. Each package has a report binding its version, complete SHA, target, size, and SHA-256. The full existing unit suite runs on macOS; release and updater contract tests run on every target. Mac checks include bundle identity, version, architecture, signature, source bytes, DMG integrity, extracted update ZIP, and the existing packaged-app smoke scenario. Windows reuses the installer/startup/persistence/uninstall verification. Test build metadata is rejected in stable archives. Existing ad hoc Mac signing and unsigned Windows delivery remain unchanged.

When dependencies change, run the normal `npm run build`, review the regenerated `THIRD-PARTY-NOTICES.txt`, and commit it before selecting the release source. Stable packaging uses that reviewed notices file without regenerating it from the runner's installed packages: optional native dependencies can be absent on a different operating system. The clean-source checks still run before and after the renderer build, and the archive verification still compares the packaged notices with the committed source file. A dirty-source failure lists the changed paths.

All five packages and all three successful native reports must be collected before any draft upload. The collection produces five checksum files and `reviewops-update.json`. Native verification reports remain workflow artifacts; the eleven delivery files are the public download candidates. Published releases, a differently targeted tag, and same-name files with different bytes are rejected. An exact retry reuses matching files and verifies them again. Rerun a failed draft job with its original delivery artifact; rebuilding a version can produce different installer bytes and must not overwrite that draft's files.

After native verification, the release task performs issue-linked QA with the QA report skill, prepares the PDF report, and sends it using the sender and recipient configured for the local release task. Review the uploaded names, sizes, checksums, source commit, report, and release notes before publishing the draft. The workflow cannot replace this QA or report delivery. A failed build, changed `main`, unavailable QA environment, or failed report delivery leaves the release unpublished.

## Windows installer

Run `npm run package:windows` on Windows to build `ReviewOps-<version>-windows-x64.exe`. The installer applies to the current user and retains the application data folder. It includes Start menu and desktop shortcuts.

The `Windows installer` GitHub Actions workflow builds on a Windows runner, runs the Windows-compatible unit checks, installs the package, and checks application startup, local project persistence, and uninstallation. Download its installer, SHA-256 file, and verification report after the workflow passes. The report is a build record; publish only the installer and checksum as user downloads.

To send the verified Windows installer directly to an existing draft, use `workflow_dispatch` with `release_tag`, `publish_to_draft: true`, and the full `reviewed_commit`. The workflow ref and the draft's target must point to that same commit. The optional upload accepts only the EXE and its checksum; it never publishes the release or replaces different existing files.

Windows installers are unsigned. The macOS updater does not install Windows EXE files. Windows users download a new installer and run it with the app closed. The optional Season AI connection is macOS-only, and Windows host management uses SSH key authentication.

## Update manifest

The release asset `reviewops-update.json` declares the packages the updater may install. Its contract is:

```json
{
  "schema": 1,
  "version": "1.2.0",
  "artifacts": {
    "darwin-arm64": {
      "name": "ReviewOps-1.2.0-arm64.zip",
      "url": "https://github.com/season-framework/reviewops-local/releases/download/v1.2.0/ReviewOps-1.2.0-arm64.zip",
      "size": 123456789,
      "sha256": "<sha256-of-the-zip>"
    }
  }
}
```

The size and checksum above are illustrative. Generate the real manifest after all ZIPs are complete:

```sh
node scripts/create-update-manifest.mjs release 1.2.0
```

The script writes the manifest and a checksum file for each ZIP. Add `darwin-x64` only when publishing a verified Intel ZIP. The manifest version, release tag, package filenames, and app bundle version must agree.

## Publish

Create a **draft** release with tag `v<version>` against the reviewed source commit. Upload:

- Each verified Mac processor type's `.dmg` and `.zip`.
- The verified Windows x64 `.exe`, when included in the release.
- SHA-256 checksum files for the packages.
- `reviewops-update.json`.
- Release notes with platform support, changes, verification, and known limitations.

Recheck the uploaded asset names, sizes, and checksums, then publish the stable release. When checking for stable updates, the in-app updater ignores drafts and prereleases. Keep prior public release assets available; installed older versions may still need them. Never reuse a stable release tag or replace a published stable package with different contents under the same version.

A maintainer can use GitHub's web interface, GitHub CLI, or API. Authentication belongs in the user's credential store or environment and must not be written to source, command logs, public Pages content, or the update manifest.

## Test releases

Reuse the single GitHub Releases prerelease `test-latest` so QA computers can install development builds. Do not create a new release for every build. The latest build has five installers, each published under both its development-version name (`-dev-N`) and its older-app-compatible name (`-test.BUILD`). Both names have identical size, SHA-256, and content. After publication, retain the ten latest installer names, ten checksum files, and one update-pointer file; remove older test installers. Development-version history JSON files are retained, so the total asset count grows with history. Existing stable releases and their downloads are never changed or deleted.

Only computers with **Get test versions** enabled under **App updates** check test updates. Disabling it selects stable updates for future checks without immediately downgrading the installed test app or data. On Windows, download the verified EXE in the app and select **Open installer**. The app does not exit automatically; close it according to the installer instructions.

Each test build records the per-base-version development number, global CI build number, full commit ID, and UTC build time. For example, `1.3.0-dev-1` has development number 1 and a separate global build number. A new base version starts a new development sequence; numbers within the same base version are compared numerically. Legacy builds without a development number retain identifiers such as `1.2.10-test.8001`. Validation checks the base/development sequence and the existing global-build rollback guard. Find installed source by the commit embedded in the app, rather than the `test-latest` tag's source-code link. Delete generated `electron/reviewops-build.json` after successful or failed test packaging. Stable packaging also deletes it first so test metadata cannot leak into stable packages.

### Run from Actions

Pushing to `codex/test-updates` runs package creation and publication-preflight checks in `.github/workflows/test-release.yml`. Publication occurs only when a manual run explicitly selects `publish: true`.

1. Select the test-release workflow and intended branch or tag in GitHub Actions.
2. Run with the default `publish: false` to build and preflight all three targets. The public test release stays unchanged.
3. After accepting a preflight, use [Promote verified test preflight](test-preflight-promotion.md) to publish its original packages without rebuilding unchanged product source. Promotion verifies the selected producer, frozen context and all original artifacts, then reserves that exact predicted development identity under the shared lock.

The original workflow's `publish: true` mode still builds and publishes a new identity. Use it when a new build is intended; it is not required to deliver an already accepted immutable preflight. A failed publication inside an already reserved publishing run continues to use the existing failed-job retry path.

A publication run reserves a per-base-version development number under the global workflow lock. A validation-only (`publish: false`) run predicts the next number but changes no release body, allocation history, or asset. Reserved numbers are never reused after failure, so public numbers can contain gaps. See [Development version identity and change history](test-development-versions.md) for the full contract.

CI build numbers are `GITHUB_RUN_NUMBER * 1000 + GITHUB_RUN_ATTEMPT`, with attempt values limited to 1–999. The first job creates the build time once and passes the same value to every package. Rerunning from metadata gives even the same commit a new build number. Rerunning only failed jobs while reusing successful packages retains that run's original development number, global build number, commit, and build time. Metadata freezes the real changes since the previous public commit and independently verified per-commit PR/issue references in one hash-linked context file. Rerunning only a failed publish job uses that original context rather than querying changed PR titles or bodies. A full metadata rerun may create another build. Ordinary publication rejects builds from other runs or later attempt numbers. The explicit promotion workflow has a separate authenticated producer check; it preserves the original producer identity and records the actual publisher identity without impersonating the producer.

Temporary package downloads and the frozen context for the latest run are retained for at most one day; earlier runs' copies are deleted. Shared-web-session and QA-recovery results and full-window photos from all three native targets are separate diagnostic artifacts retained for at most one day, independently of post-publication installer-artifact cleanup. Successful files remain available when another target or publication preflight fails so only failed jobs can be rerun. If retention expires, ordinary retry cannot recover those Actions inputs. Promotion also stops when its pinned producer artifacts are missing or expired; it does not silently rebuild or accept unverified local replacements. Schedule accepted-candidate delivery before expiry or arrange reviewed provenance-bound preservation before the deadline. Successful publication also deletes that run's temporary files. Files left by a forcibly cancelled run still expire within one day. Actions logs remain available.

### Verify local packages

Test packaging stops if package source or build scripts have uncommitted changes. Commit the integrated source first, then replace `FULL_COMMIT_SHA` below with that full commit. Use the same build number and time for all three targets, replacing the example time with the build's actual UTC start time. Run each command on its matching operating system and CPU.

```sh
npm run package:test -- --target darwin-arm64 --number 1001 --commit FULL_COMMIT_SHA --built-at 2026-10-31T00:00:00.000Z
npm run package:test -- --target darwin-x64 --number 1001 --commit FULL_COMMIT_SHA --built-at 2026-10-31T00:00:00.000Z
npm run package:test -- --target win32-x64 --number 1001 --commit FULL_COMMIT_SHA --built-at 2026-10-31T00:00:00.000Z
```

Outputs go to `release/test-darwin-arm64/`, `release/test-darwin-x64/`, and `release/test-win32-x64/`. Apps under construction stay in each folder's `packaged/` directory, leaving existing apps in `release/mac/` and `release/mac-arm64/` unchanged. Collect only top-level ZIP/DMG/EXE/JSON files from the three output folders into `release/test/` and verify that every `build-info.json` agrees. This command checks files and publication readiness; it queries public GitHub data without uploading or deleting files:

```sh
npm run release:test -- --directory release/test
```

Add `--offline` to check local files without network queries:

```sh
npm run release:test -- --directory release/test --offline
```

The actual `--publish` option is permitted only in the Actions workflow's publish job. Default invocation always verifies only.

### Publication sequence

Native Ops checks must verify the packaged `ops-*.cjs` source and the pinned `cron-parser`/`luxon` dependencies. The actual installed application must expose Ops IPC and navigation, calculate an IANA-timezone schedule, and preserve paused/finished goals and settings through backup/restore and restart. Windows verification also retains the Ops JSON file across same-version reinstall and uninstall. These checks create no model conversation. The unavailable saved-thread startup fixture is synthetic; it does not certify genuine Codex conversation recovery.

Before publishing an Ops candidate, also check installed goal execution and its project/window/QA-session binding, independent goals and cleanup, and the original genuine Codex conversation after reconnect and candidate reinstall. An update from a public version without Ops can prove core-data migration, but cannot by itself prove retention of a pre-existing Ops conversation. Record the actual path tested. The focused preservation script can run against an explicitly selected installed executable:

```sh
REVIEWOPS_TEST_EXECUTABLE=/path/to/ReviewOps.app/Contents/MacOS/ReviewOps \
  REVIEWOPS_EXPECT_SOURCE_SHA=FULL_REVIEWED_SHA node scripts/e2e-ops-preservation.mjs
```

1. Build macOS arm64/x64 and Windows x64 packages with identical build identity.
2. Verify embedded build identity, file contents, macOS signatures and DMGs, and the Windows installer's signature status. On Windows, check installation, startup, and preservation of projects and review categories after reinstalling the same app version. Bind installer size and SHA-256 to the verification result.
3. Serialize test publication from every branch through one queue. If a higher global build number is already public, do not publish an older build that finishes later.
4. Upload every new file, then download it again and verify size and hash. Continue pointing users to the previous latest build until this finishes.
5. Switch the release body's latest-build pointer once to the new update file. Verify that the pointer and file identify the same build.
6. Once new files are usable, delete previous test installers, update-pointer files, and checksums. Verify that the latest development/compatibility names and every existing development-history JSON remain. Stop publication if an existing history file is missing or its size/hash changed.

Compatibility filenames include the global build number; development filenames include the base version and development number. Neither name may overwrite different bytes under an already-published name. Partial or damaged uploads are never advertised as the latest build. Retrying the same build can recover interrupted uploads and previous-file cleanup. Only unused incomplete uploads may be deleted and reuploaded; files used by the current pointer are retained.

A 404 for a removed older test file stops installation and clears the old download target. The user must select **Check for updates** again to discover the current build. A hash failure preserves the selected build so the same file can be downloaded again. Neither condition automatically rechecks or installs, and the installed app is retained.

The test-update feature itself does not change the database storage format. This source upgrades the local database to schema 12 for project incarnations; stable 1.5.0 supports at most schema 11 and refuses to open that upgraded database. Logical backup format 10 remains unchanged, but this does not provide an automatic physical-database downgrade. Use a separate data folder for QA and preserve a backup before updating existing data. Returning to an older app does not delete QA data or restore an older backup automatically. Disabling **Get test versions** changes only future update checks; it does not downgrade the app or database.

## Publish the website

`website/` is a static site with no package install or build step. Preview it locally:

```sh
python3 -m http.server 8080 --directory website
```

Check English, Korean, Japanese, and Simplified Chinese; desktop and mobile widths; language search and keyboard navigation; download links; and FAQ controls. All assets are relative so the site works at `/reviewops-local/`.

To deploy, copy the contents of `website/`, including `.nojekyll`, to the root of the `gh-pages` branch and push that branch. In the repository's **Settings → Pages**, select **Deploy from a branch**, `gh-pages`, and `/(root)`. Keep the app source on `main`. See [GitHub's publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

After deployment, open `https://season-framework.github.io/reviewops-local/` and verify that its download links reach the published release. A successful source push alone does not confirm that Pages has deployed.
