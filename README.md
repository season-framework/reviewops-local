<p align="center"><img src="website/assets/icon.svg" width="72" alt="ReviewOps"></p>

<h1 align="center">ReviewOps</h1>

<p align="center">From review to resolution.<br>A desktop workspace for project reviews, screenshots, files, and Codex tasks.</p>

<p align="center"><a href="https://season-framework.github.io/reviewops-local/">Website</a> · <a href="https://github.com/season-framework/reviewops-local/releases/latest">Download</a> · <a href="docs/guide-ko.md">한국어 안내</a> · <a href="CONTRIBUTING.md">Contributing</a></p>

![Illustrative ReviewOps workspace with sample content](website/assets/workspace.svg)

*Illustrative interface with sample data. No real project or account data is shown.*

ReviewOps brings a website viewer, review conversations, attachments, and agent tasks into one macOS app. Organize projects inside groups and connect each project to a local folder or a saved SSH host. Review data is stored on your Mac. No ReviewOps server or ReviewOps login is required.

## Features

- **Groups and projects:** organize reviews, labels, priorities, and progress. Keep project connection, viewer, and agent settings together.
- **Website viewer:** open external websites in a dedicated browser view with persistent sessions. Switch between 4K, FHD, HD, tablet, mobile, and custom sizes.
- **Reviews and timeline:** capture screenshots, attach files and browser logs, and keep discussion and task results together. Export a review's instructions and attachments as a ZIP.
- **Codex tasks:** run Codex CLI in a local folder or directly on an SSH host. Send instructions, screenshots, logs, and files; continue a conversation; open generated files from the original working directory.
- **Account and host management:** manage separate Codex account profiles and usage information. Reuse SSH hosts from your SSH configuration, browse remote files, and manage Codex on a host.
- **Languages and accessible controls:** choose an interface language in Settings. Search long dropdown lists and use arrow keys, Enter, and Escape.
- **Local storage and updates:** store reviews in SQLite and attachments in files, export project backups, and download compatible app updates from GitHub Releases.

The core interface supports **English, Korean, Japanese, Simplified Chinese, Traditional Chinese, Spanish, French, German, Brazilian Portuguese, Italian, Russian, and Vietnamese**. Some advanced technical messages use an English fallback. Content you write and external websites are not translated.

## Install

Requires **macOS 13 or later**. Windows and Linux installers are not currently provided.

1. Open the [latest release](https://github.com/season-framework/reviewops-local/releases/latest).
2. Download the `.dmg` matching your Mac: **arm64** for Apple Silicon or **x64** for Intel. You can find your chip in **Apple menu → About This Mac**.
3. Open the DMG and drag **ReviewOps** into **Applications**.
4. Open ReviewOps from Applications.

Release builds are ad hoc signed and are **not Apple-notarized**. If macOS blocks the first launch, follow [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/en-us/102445). Do not disable Gatekeeper system-wide.

Each release includes SHA-256 checksums. To verify a downloaded installer:

```sh
shasum -a 256 ReviewOps-1.2.0-arm64.dmg
```

Compare the result with the checksum published in that release.

## Start a project

1. Open **Groups** and create a group.
2. Create a project inside the group.
3. Choose a **local folder** or a saved **SSH host** and working directory. Register SSH hosts in the sidebar first.
4. Set the website address and viewer preferences in the project's settings.
5. Open **Reviews**, create a review, and add the description, screenshots, logs, or files.
6. Use the review timeline to record progress, or the **Agent** panel to start a Codex task.

Drag the logo or an empty area of the tab bar to move the window. The Home tab stays fixed; other workspace tabs can be reordered by dragging or with **Alt+Shift+←/→**.

### Using Codex

Codex CLI must be installed and signed in on the computer where a task will run. Local projects use Codex on your Mac; SSH projects use Codex on the selected host. Configure the executable, model, reasoning level, and instructions in **Project → Settings → Agent**.

Agent commands run as:

```sh
codex exec --dangerously-bypass-approvals-and-sandbox
```

Tasks have the permissions of the selected local or SSH account. ReviewOps does not add an execution sandbox or approval layer. Use a project folder and account appropriate for the task. Starting an agent task changes the review status to **In progress**.

Codex account profiles in ReviewOps are separate from the default Codex login. Account import is explicit and preserves the source app's data. File-based credentials can be copied; credentials stored only in macOS Keychain require signing in again. ReviewOps does not use Keychain.

### Using SSH

Host management reads `~/.ssh/config` and its included files, including `IdentityFile` and `ProxyJump`. Registered hosts can be selected by multiple projects. The app checks host keys and does not accept an unknown or changed key automatically. On macOS, its SSH commands use `UseKeychain=no`.

Host file management supports browsing, preview, upload, download, rename, move, and delete. The project terminal is available for SSH connections.

## Data and privacy

ReviewOps stores project and review data under:

```text
~/Library/Application Support/ReviewOps Local/
```

The historic folder name is retained so existing installations keep their data.

| Location | Contents |
| --- | --- |
| `reviewops.sqlite` | Groups, projects, connections, reviews, timeline, logs, agent runs, attachment records |
| `attachments/` | Review and timeline attachments |
| `codex-manager/` | Account profiles, cached usage and statistics, import records, executable settings |
| `credentials.json` and `credentials.json.key` | Encrypted credentials for legacy direct SSH connections |
| `recovery/` | Copies made before restoration or migration |
| `Partitions/` | Website cookies and browser storage |

The app does not need a hosted ReviewOps backend. External websites, SSH connections, Codex, account usage requests, and update checks use their respective network services. Instructions and selected attachments are sent to the Codex environment when you start an agent task.

Use **Settings → Save backup file** to export a JSON backup containing project data and attachments. This backup does **not** contain SSH passwords, key passphrases, Codex credentials, or website cookies. To archive the entire installation's data, quit ReviewOps first and copy the application data folder. Keep any backup containing credentials private.

Deleting a group removes its projects, reviews, history, and attachments. Deleting a project removes its review data and connection settings. The confirmation requires the group's or project's name. Saved SSH hosts and Codex accounts are managed separately.

## Updates

ReviewOps automatically checks public [GitHub Releases](https://github.com/season-framework/reviewops-local/releases) for new versions. No GitHub account or token is needed in the app. You can check for updates in Settings and choose when to download and install.

The updater selects the build for your Mac, checks its declared size and SHA-256 hash, verifies the app bundle, and replaces the application before restarting. Project data is kept outside the application bundle. Updates are not installed while agent tasks are running. The website is an introduction and download page; the update feed comes directly from GitHub Releases.

## Development

Use **Node.js 24 or later**, npm, and macOS for Electron packaging.

```sh
git clone https://github.com/season-framework/reviewops-local.git
cd reviewops-local
npm ci
npm run dev
```

Build and run checks:

```sh
npm run build
npm test
npm run test:selects
npm run test:project-connections
npm run test:account-import
```

Tests use temporary app data and synthetic CLI responses. They must not consume real account credits, change remote systems, or overwrite a user's Codex login. See [CONTRIBUTING.md](CONTRIBUTING.md).

Create installers:

```sh
npm run package
npm run package:intel
```

Build output is written to `release/`. The [release guide](docs/releasing.md) covers update ZIPs, checksums, release publication, and GitHub Pages deployment.

| Folder | Purpose |
| --- | --- |
| `src/` | React interface and styles |
| `electron/` | Local database, IPC, browser, SSH, Codex, and updater |
| `tests/` | Unit and integration tests |
| `scripts/` | Development, build, release, and UI test tools |
| `website/` | Static GitHub Pages introduction site |
| `docs/` | User and contributor documentation |

## Contributing and support

Report reproducible problems in [Issues](https://github.com/season-framework/reviewops-local/issues). Include the app version, macOS version, chip type, steps, and a sanitized screenshot or log. Never include tokens, private keys, account credentials, or real project attachments.

For vulnerabilities, follow [SECURITY.md](SECURITY.md). Pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

ReviewOps source code is available under the [MIT License](LICENSE). Third-party libraries, fonts, icons, and Electron components retain their respective licenses. See [NOTICE](NOTICE), [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt), and the [licensing notes](docs/licensing.md).

ReviewOps is an independent project and is not affiliated with or endorsed by OpenAI. Codex is a product of OpenAI.
