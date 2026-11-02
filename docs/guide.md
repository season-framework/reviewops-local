# ReviewOps user guide

ReviewOps manages project reviews, screenshots, files, and Codex tasks on your computer. It does not require a ReviewOps server or account. Projects belong to groups, and each project connects to a local folder or an SSH host.

## Install

ReviewOps supports Windows 10/11 x64 and macOS 13 or later.

### Windows

1. Download `ReviewOps-<version>-windows-x64.exe` from the [latest release](https://github.com/season-framework/reviewops-local/releases/latest).
2. Run the installer and choose an installation folder. It installs for the current Windows user.
3. Open ReviewOps from the Start menu or desktop shortcut.

Windows installers are unsigned. Updating or uninstalling the app preserves project data.

### macOS

1. Download the DMG for your Mac from the [latest release](https://github.com/season-framework/reviewops-local/releases/latest).
2. Choose `arm64` for Apple Silicon or `x64` for Intel.
3. Open the DMG and drag ReviewOps to Applications.
4. Open ReviewOps from Applications.

macOS 13 or later is required. The app is not notarized by Apple. If macOS blocks the first launch, follow [Apple's opening instructions](https://support.apple.com/ko-kr/102445).

## Connect a project

1. Create or select a **Group**.
2. Select **Create project** inside the group.
3. Choose **Local folder** or **SSH host** as the connection type.
4. Register an SSH host in **Hosts** first, then select the saved host and server working folder in the project.
5. Open the project's **Settings** to change its website URL, viewport size, and agent settings.

Drag the logo or an empty area of the top tab bar to move the window. Reorder tabs other than Home by dragging them or pressing **Alt+Shift+Left/Right**.

## Reviews and attachments

Create a review in a project and set its description, status, category, and priority. Built-in categories are Bug, UX, Content, Performance, Accessibility, Security, and Other. Select **+** beside the category to add a named category. Custom categories are available to other reviews and included in backups and restores.

Attach screenshots, logs, and files. Capture the viewer or use **+** in the activity composer to add material. Selecting an element in the review target keeps a border around it. **Go to selected element** returns to its location; **Clear element highlight** removes the border.

Activity shows conversations and agent progress together. A task-instruction ZIP can bundle the request, logs, screenshots, activity, and attachments.

The viewer maintains its own website cookies and login state. Choose 4K, FHD, HD, tablet, mobile, or a custom viewport size. Numeric input is applied when you press Enter or leave the field.

## Codex tasks

Local tasks use Codex CLI on this computer; SSH tasks use Codex CLI on the selected server. Install Codex and sign in in the environment where the task will run. Set the executable, model, and task instructions in **Project → Settings → Agent**.

At startup, the app collects model lists, supported reasoning levels, and defaults from this computer and registered SSH hosts. It refreshes them every hour by default. A review's **Agent** panel uses the saved list without reconnecting to the host. In **Hosts**, inspect each host's list and last collection time or refresh it manually. Failed collection preserves the last successful list. Change the interval in **Settings → Automatic checks**. If no saved list is available, use **Project → Settings → Agent → Register models** to enter model IDs, display names, and reasoning levels. These lists are saved with project connection settings and included in backups.

Send requests and attachments from a review's **Agent** panel. The first request automatically includes the task instructions, screenshots, and logs; subsequent requests send text only. Use **+** to add more material. Failed model collection preserves the saved list; inspect the error in **Settings → Automatic checks**. Starting a task changes the review status to **In progress**. File links in responses open against the connection and working folder used for that execution.

Each request separately records the selected model and reasoning level, the values passed to the executable, and the actual values reported by that executable. Later setting changes and reruns do not overwrite earlier records. Missing values in historical records are not filled from later settings. Open **More** for detailed values, request and run IDs, and original logs.

**Copy request text** and **Copy response** copy the original content and report success or failure. Copying a response in progress includes only the content written so far. During execution, the bottom of the conversation shows the latest operation; selecting it opens the saved run record. Long lists scroll internally. Reading earlier content preserves the scroll position; **Go to latest** moves to new output.

While a task runs, write the next request in the same composer and select **Save to waiting list**. Saving and running are separate actions: a saved request starts only when you select its run button. **Continue conversation** uses the same conversation; **Start a new conversation** creates another. Editing a waiting request or importing an earlier request preserves other drafts. Open the composer's **More** section for execution settings and connection details.

The execution command is `codex exec --dangerously-bypass-approvals-and-sandbox`. Tasks run with the selected account's permissions; the app adds no separate sandbox or approval flow.

## Accounts and hosts

Use **Accounts** to manage each Codex account's login, usage, and statistics. Each account has its own storage folder, leaving the default Codex login file unchanged. Authentication is stored in files rather than the keychain. Importing an existing account does not copy credentials held only in the keychain; sign in again in that case.

On macOS, ReviewOps can find the CLI bundled in Codex or ChatGPT apps installed in `/Applications` or `~/Applications`, including the nested `codex-cli/CodexCLI.app` layout. **Accounts** shows the detected CLI version and resolved executable path. Automatic discovery continues to other known candidates when one cannot run. A valid manually selected executable takes priority. If a saved app or versioned executable disappears after an update, startup can search from its recorded selection source. Other invalid explicit paths retain their error. Default local project execution and login use the same selected CLI; an explicit project executable remains separate. Finding a CLI does not sign in or copy credentials: use the appropriate account or project login flow. If no executable is available, install Codex CLI or select its executable.

Automatic discovery waits 30 seconds before retrying a failed executable, unless its file changes. A deliberate file selection validates that file once. Use **Check CLI again** to request a fresh check; it is limited to once every 30 seconds. **Choose executable** is available for both detected and unavailable CLIs. Canceling or failing a new selection preserves the previous executable setting. A failed check of the selected executable can report it as unavailable without replacing the saved selection. Older saved standalone paths without a recorded selection source require choosing the executable again if that path disappears.

Open **CLI diagnostics** to inspect up to 16 bounded records, including redacted paths, recognized versions, architectures, exit codes, signals, and elapsed time. **Copy diagnostics** copies only those sanitized fields and an omitted-record count, within 16 KiB. Missing files, execution permissions, timeouts, invalid versions, architecture mismatches, abnormal exits, and sign-in requirements are separate states. A signal such as `SIGKILL` or exit code `137` alone does not establish a code-signature problem. Use an official CLI or app distribution for replacement; ReviewOps does not restore or resign an app or change macOS security settings.

**Hosts** uses `~/.ssh/config` and included SSH configuration files. Connect a saved host to multiple projects. Host management supports file browsing, upload, download, rename, move, deletion, and remote Codex management.

## Settings and updates

Search the language selector in Settings to change the interface language. Supported languages are English, Korean, Japanese, Simplified and Traditional Chinese, Spanish, French, German, Brazilian Portuguese, Italian, Russian, and Vietnamese. Some technical messages remain in English. User content and external websites are not translated.

When automatic checks are enabled, the macOS app checks for updates at startup and every ten minutes by default. Change the interval in **Settings → Automatic checks**. Re-enabling automatic checks also checks immediately. Updates use public GitHub Releases, so the app does not require a GitHub account or token. A new version appears as a notification at the bottom of the left sidebar. Select it to download, install, and restart the app. The same controls are available in Settings. The app validates the download before replacement and preserves project data.

SSH agent tasks continue on the server after the app exits. Reopening the app reads the same task's output and result. The server requires bash, nohup, and setsid. Finish local tasks, terminals, logins, and file transfers before updating.

SSH task persistence applies to tasks started in version 1.2.2 or later. Finish tasks started in earlier versions before installing 1.2.2.

Photos, documents, and logs in activity appear as attachment buttons below the body. Select a button to open its popup, download the file, or delete it.

For stable Windows updates, download the latest installer, close the app, and reinstall. The stable update method is unchanged. Season AI integration is not supported on Windows. Host management uses SSH key authentication.

### Get test versions

Enable **Settings → Automatic checks → App updates → Get test versions** to check prerelease builds. It is off by default. Test installers can be downloaded on development and QA computers. The test channel keeps the latest installer set and replaces earlier test installers when a new build is published.

Installed and available versions are displayed separately. **Show details** displays the build number, commit, and build time; **Copy version information** copies them. macOS uses the existing update installation flow. On Windows, select **Download installer**, wait for verification, then select **Open installer**. The app does not close automatically: close it and follow the installer instructions.

You can change the test-channel selection during a check or download. Disabling it selects stable updates for future checks; it does not downgrade the installed app, delete project data, or restore an older backup. Data saved by 1.2.10 cannot be opened by 1.2.9. Back up before updating if you may need to return to the older app.

## Store and delete data

Data is stored in `~/Library/Application Support/ReviewOps Local/` on macOS and `%APPDATA%\ReviewOps Local\` on Windows. The existing folder name is retained so earlier installations can keep using their data.

Use **Settings → Save backup file** to export project data and attachments as JSON. SSH passwords, key passphrases, Codex login credentials, and external website cookies are not included. To move all data, close the app and preserve the data folder.

Deleting a group or project requires entering its name. Deleting a group also deletes its projects, reviews, activity, and attachments. Deleting a project deletes its reviews and attachments. SSH hosts and Codex accounts are managed separately.

Report problems in Korean in [Issues](https://github.com/season-framework/reviewops-local/issues), including the app version, operating system version, and reproduction steps. Exclude tokens, passwords, private keys, and real project data.
