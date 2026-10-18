# Releasing ReviewOps

Release artifacts are published at `season-framework/reviewops-local`. The introduction site is published from the `gh-pages` branch. The application uses **GitHub Releases directly** for updates, not the website.

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

## Windows installer

Run `npm run package:windows` on Windows to build `ReviewOps-<version>-windows-x64.exe`. The installer applies to the current user and retains the application data folder. It includes Start menu and desktop shortcuts.

The `Windows installer` GitHub Actions workflow builds on a Windows runner, runs the Windows-compatible unit checks, installs the package, and checks application startup, local project persistence, and uninstallation. Download its installer, SHA-256 file, and verification report after the workflow passes. The report is a build record; publish only the installer and checksum as user downloads.

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

Recheck the uploaded asset names, sizes, and checksums, then publish the stable release. The in-app updater ignores drafts and prereleases. Keep prior public release assets available; installed older versions may still need them. Never reuse a release tag or replace a published package with different contents under the same version.

A maintainer can use GitHub's web interface, GitHub CLI, or API. Authentication belongs in the user's credential store or environment and must not be written to source, command logs, public Pages content, or the update manifest.

## Publish the website

`website/` is a static site with no package install or build step. Preview it locally:

```sh
python3 -m http.server 8080 --directory website
```

Check English, Korean, Japanese, and Simplified Chinese; desktop and mobile widths; language search and keyboard navigation; download links; and FAQ controls. All assets are relative so the site works at `/reviewops-local/`.

To deploy, copy the contents of `website/`, including `.nojekyll`, to the root of the `gh-pages` branch and push that branch. In the repository's **Settings → Pages**, select **Deploy from a branch**, `gh-pages`, and `/(root)`. Keep the app source on `main`. See [GitHub's publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

After deployment, open `https://season-framework.github.io/reviewops-local/` and verify that its download links reach the published release. A successful source push alone does not confirm that Pages has deployed.
