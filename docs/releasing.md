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

Recheck the uploaded asset names, sizes, and checksums, then publish the stable release. When checking for stable updates, the in-app updater ignores drafts and prereleases. Keep prior public release assets available; installed older versions may still need them. Never reuse a stable release tag or replace a published stable package with different contents under the same version.

A maintainer can use GitHub's web interface, GitHub CLI, or API. Authentication belongs in the user's credential store or environment and must not be written to source, command logs, public Pages content, or the update manifest.

## 테스트 버전 배포

개발 PC에서 만든 테스트 빌드를 QA PC에서 설치할 수 있도록 GitHub Releases의 `test-latest` 사전 출시 항목 하나를 계속 사용한다. 빌드마다 새 Release를 만들지 않는다. 게시가 끝나면 최신 빌드의 설치파일 5개, 해시 파일 5개와 업데이트 안내 파일 1개만 남긴다. 기존 정식 Release와 다운로드 파일은 변경하거나 삭제하지 않는다.

설정의 `앱 업데이트`에서 `테스트 버전 받기`를 켠 PC만 테스트 업데이트를 조회한다. 체크를 해제하면 이후 정식 업데이트를 조회하며, 설치된 테스트 앱이나 데이터를 즉시 이전 상태로 바꾸지 않는다. Windows에서는 앱에서 검증된 EXE를 내려받고 `설치 파일 열기`로 실행한다. 앱은 자동 종료하지 않으며, 설치 화면의 안내에 따라 기존 앱을 닫고 진행한다.

테스트 빌드에는 앱 버전, 증가하는 빌드 번호, 전체 커밋 ID와 빌드 시각을 함께 기록한다. 앱 버전이 같아도 빌드 번호로 새 빌드를 구별한다. `test-latest` 태그의 소스 코드 링크 대신 앱에 포함된 커밋 ID로 설치된 코드를 찾는다. 테스트 패키지 생성이 끝나거나 실패하면 생성한 `electron/reviewops-build.json`을 삭제한다. 정식 패키지 생성도 이 파일을 먼저 지워 테스트 빌드 정보가 섞이지 않게 한다.

### Actions에서 실행

`codex/test-updates` 브랜치에 push하면 `.github/workflows/test-release.yml`이 패키지 생성과 게시 준비 검사만 수행한다. 실제 게시는 수동 실행에서 `publish`를 `true`로 선택할 때만 수행한다.

1. GitHub Actions에서 테스트 배포 워크플로와 사용할 브랜치 또는 태그를 선택한다.
2. `publish`를 기본값인 `false`로 두고 실행하여 세 패키지의 생성과 게시 준비 검사를 수행한다. 공개된 테스트 배포는 바뀌지 않는다.
3. 검사가 끝나면 같은 브랜치 또는 태그를 선택하고 `publish`를 `true`로 바꾸어 새 실행을 시작한다. 게시 실행의 커밋 ID가 의도한 코드와 같은지 확인한다. 이 실행은 새 빌드 번호로 패키지를 다시 만들고, 검사가 끝난 파일만 게시한다.

CI 빌드 번호는 `GITHUB_RUN_NUMBER * 1000 + GITHUB_RUN_ATTEMPT`로 만든다. 실행 시도 번호는 1~999만 허용한다. 빌드 시각은 첫 작업에서 한 번 생성하고 모든 패키지에 같은 값을 전달한다. 메타데이터 작업부터 다시 실행하면 같은 커밋에도 새 빌드 번호를 부여한다. 실패한 작업만 재실행하여 이전에 성공한 패키지를 사용하는 경우에는 같은 실행의 기존 빌드 번호를 유지한다. 다른 실행의 빌드나 이후 시도의 번호는 허용하지 않는다.

최신 실행의 임시 다운로드 파일은 최대 1일 보관하고 이전 실행의 파일은 삭제한다. 일부 운영체제의 빌드나 게시 준비 검사가 실패해도 같은 실행에서 이미 성공한 파일은 남겨 실패한 작업만 재실행할 수 있게 한다. 보관 기간이 지나 파일을 받을 수 없으면 전체 작업을 다시 실행한다. 실제 게시가 끝나면 현재 실행의 임시 파일도 삭제한다. 실행을 강제로 종료하여 정리하지 못한 파일도 최대 1일 보관한다. Actions 실행 로그는 남는다.

### 로컬에서 패키지 검사

패키지에 들어가는 소스나 빌드 스크립트에 커밋하지 않은 변경이 있으면 테스트 패키지 생성을 중단한다. 변경 내용을 통합 커밋한 뒤 다음 명령의 `FULL_COMMIT_SHA`를 해당 전체 커밋 ID로 바꾼다. 빌드 번호와 시각은 세 패키지에 같은 값을 사용하며, 예시의 시각도 해당 빌드를 시작한 UTC 시각으로 바꾼다. 각 명령은 해당 운영체제와 CPU를 사용하는 PC에서 실행한다.

```sh
npm run package:test -- --target darwin-arm64 --number 1001 --commit FULL_COMMIT_SHA --built-at 2026-10-31T00:00:00.000Z
npm run package:test -- --target darwin-x64 --number 1001 --commit FULL_COMMIT_SHA --built-at 2026-10-31T00:00:00.000Z
npm run package:test -- --target win32-x64 --number 1001 --commit FULL_COMMIT_SHA --built-at 2026-10-31T00:00:00.000Z
```

결과는 각각 `release/test-darwin-arm64/`, `release/test-darwin-x64/`, `release/test-win32-x64/`에 생성된다. 빌드 중인 앱은 각 폴더의 `packaged/` 아래에 두므로 기존 `release/mac/`와 `release/mac-arm64/`의 앱을 덮어쓰지 않는다. 세 결과 폴더의 첫 단계에 있는 ZIP·DMG·EXE·JSON 파일만 `release/test/`에 모으고 `build-info.json`의 내용이 모두 같은지 검사한다. 다음 명령은 파일과 게시 준비 상태를 검사하며, 공개 GitHub 자료를 조회할 뿐 파일을 올리거나 삭제하지 않는다.

```sh
npm run release:test -- --directory release/test
```

네트워크 조회 없이 로컬 파일만 검사하려면 `--offline`을 추가한다.

```sh
npm run release:test -- --directory release/test --offline
```

실제 게시 옵션인 `--publish`는 위 Actions 워크플로의 게시 작업에서만 허용한다. 기본 실행은 항상 검사만 수행한다.

### 게시 순서

1. macOS arm64·x64와 Windows x64 패키지를 같은 빌드 정보로 만든다.
2. 패키지에 포함된 빌드 정보, 파일 구성, macOS 서명과 DMG, Windows 설치파일의 서명 상태를 검사한다. Windows에서는 설치·시작·같은 앱 버전 재설치 후 프로젝트와 리뷰 분류가 보존되는지도 검사한다. 설치파일의 크기와 SHA-256을 검사 결과에 연결한다.
3. 모든 브랜치의 테스트 게시 작업을 같은 대기열에서 한 번에 하나씩 실행한다. 더 높은 빌드 번호가 이미 공개되어 있으면 늦게 끝난 이전 빌드는 게시하지 않는다.
4. 새 파일을 모두 올리고 다시 내려받아 크기와 해시를 검사한다. 이 작업이 끝날 때까지 기존 최신 빌드를 안내한다.
5. Release 본문의 최신 빌드 표시를 한 번 바꿔 새 업데이트 안내 파일을 가리키게 한다. 표시와 파일이 같은 빌드인지 다시 검사한다.
6. 새 파일을 사용할 수 있는 상태에서 이전 테스트 빌드의 설치파일, 업데이트 안내 파일과 해시 파일을 삭제한다. 게시가 끝났을 때 최신 파일 한 벌만 남았는지 검사한다.

파일 이름에는 빌드 번호를 넣으며 이미 공개한 파일 이름에 다른 내용을 덮어쓰지 않는다. 일부 파일만 올라간 상태와 손상된 파일은 최신 빌드로 안내하지 않는다. 게시 도구는 같은 빌드의 자료를 다시 받아도 중단된 업로드와 이전 파일 정리를 복구한다. 사용 중인 최신 빌드가 아닌 빈 실패 업로드만 지우고 다시 올린다. 아직 사용 중인 최신 파일은 삭제하지 않는다.

삭제된 이전 테스트 파일을 요청하여 404를 받으면 설치를 중단하고 이전 다운로드 대상을 지운다. 사용자가 `업데이트 확인`을 다시 눌러 최신 빌드를 조회한다. 해시 검사가 실패하면 선택한 빌드는 유지하고 같은 파일을 다시 내려받을 수 있게 한다. 두 경우 모두 자동으로 다시 조회하거나 설치하지 않으며 설치된 앱을 유지한다.

이번 테스트 업데이트 기능은 DB 저장 형식을 바꾸지 않는다. 다만 이 개발 브랜치가 이미 사용하는 DB 형식 10은 정식 1.2.9에서 열 수 없으며, 기존 보호 처리가 열기를 거절한다. QA는 별도 데이터 폴더에서 진행하고, 정식 앱으로 돌아갈 때 QA 데이터를 삭제하거나 이전 백업으로 자동 교체하지 않는다. `테스트 버전 받기` 체크 해제는 이후 정식 업데이트 조회만 선택하며 앱이나 DB를 자동으로 이전 버전으로 바꾸지 않는다.

## Publish the website

`website/` is a static site with no package install or build step. Preview it locally:

```sh
python3 -m http.server 8080 --directory website
```

Check English, Korean, Japanese, and Simplified Chinese; desktop and mobile widths; language search and keyboard navigation; download links; and FAQ controls. All assets are relative so the site works at `/reviewops-local/`.

To deploy, copy the contents of `website/`, including `.nojekyll`, to the root of the `gh-pages` branch and push that branch. In the repository's **Settings → Pages**, select **Deploy from a branch**, `gh-pages`, and `/(root)`. Keep the app source on `main`. See [GitHub's publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

After deployment, open `https://season-framework.github.io/reviewops-local/` and verify that its download links reach the published release. A successful source push alone does not confirm that Pages has deployed.
