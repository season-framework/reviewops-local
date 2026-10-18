# Release history

## 1.2.3

- Add a Windows x64 installer with Start menu and desktop shortcuts.
- Support Windows local project folders and prevent the optional macOS integration from blocking Windows startup.
- Add Windows downloads and installation instructions to the introduction website.
- Keep macOS in-app updates available; Windows updates use the installer.
- Preserve account storage on Windows without unsupported directory flushes.
- Complete app shutdown when a newly started SSH job cannot confirm cancellation.

## 1.2.2

- Show available updates at the bottom of the sidebar, with one action to download, install, and restart.
- Keep SSH agent tasks running through app updates and reconnect to their output after restarting.
- Keep local tasks, terminals, login operations, and transfers protected during installation.
- Show work-history images, files, and logs as small attachment buttons that open a popup.
- Keep saved partial output when a remote task cannot be recovered, without starting the request again.

## 1.2.1

- Move full-screen and close icons to the upper right, next to refresh.
- Use icons without persistent borders or backgrounds, with visible hover, click and keyboard focus feedback.
- Keep window controls visible with collapsed or expanded navigation, light or dark appearance, and narrow windows.

## 1.2.0

- First public source release under the MIT License.
- Application language selection with a searchable list.
- GitHub release checks and downloadable application updates.
- Public introduction website and contributor documentation.
- Apple Silicon and Intel installers for macOS 13 or later.

Validation: 511 unit checks; 56 Apple Silicon package UI checks; real application replacement and restart; installer failure recovery; package integrity and source comparison. UI and agent tests use isolated data and synthetic accounts/commands.

## 1.1.1

- Shared searchable dropdowns throughout the application.
- Consistent menus for attachments, review status and file actions.
- Improved keyboard input, selection labels and menus above the web viewer.

## 1.1.0

- Project connection settings for local folders and SSH hosts.
- Integrated Codex account and SSH host management.
- Account import that preserves saved usage and activity information.
- Project settings aligned with the ReviewOps interface.

## 1.0

- Local groups, projects, reviews and work history stored in SQLite.
- Web viewer, screenshots, logs and file attachments.
- Local and SSH Codex execution with review-linked work records.
- File management, terminals, backup and restore.

Release-specific downloads and changes are published in
[GitHub Releases](https://github.com/season-framework/reviewops-local/releases).
