# ReviewOps 1.2.10

This release records models and reasoning per request, improves copying and run history in agent conversations, and unifies follow-up request entry. The optional test channel lets another computer install builds before a stable release.

## Conversation and request history

- [#27](https://github.com/season-framework/reviewops-local/issues/27): Each request separately records the selected model/reasoning level, values passed to execution, and actual values reported by the executable. Reruns and follow-up requests each keep their own record. Missing historical values are not filled from later settings.
- [#28](https://github.com/season-framework/reviewops-local/issues/28): Copy original request and response text with success/failure feedback. Responses still being written are identified as in progress.
- During execution, read the latest operation at the bottom of the conversation and expand its saved run record. Long lists scroll within a fixed height. New output preserves your position while reading earlier content.
- Write initial and follow-up requests in one composer. Save the next request to the waiting list during execution and start it manually. Editing a waiting request or importing an earlier request preserves other drafts.
- Open **More** for detailed settings, request/run IDs, and original logs. Per-request model and reasoning information remains visible in the conversation.

## Optional test versions

- Enable **Settings → Automatic checks → App updates → Get test versions** to check the latest prerelease build. It is off by default.
- The test release keeps the latest installer set. New builds replace earlier test installers instead of adding a separate release for every build.
- Installed and available versions are separate. **Show details** displays the build number, commit, and build time; version information can also be copied.
- macOS uses the existing download/verification/install/restart flow. On Windows, select **Download installer**, wait for verification, then select **Open installer**. The Windows app does not close automatically; follow the installer instructions.
- Change the test-channel selection during a check or download. A response or download from the old selection cannot install a build for the new selection. Missing test versions and communication failures have separate status messages.
- Disabling the option selects stable updates for future checks. It does not downgrade the installed app or data, and the stable update method is unchanged.

## Install and preserve data

- On macOS 13 or later, choose `ReviewOps-1.2.10-arm64.dmg` for Apple Silicon or `ReviewOps-1.2.10-x64.dmg` for Intel.
- On Windows 10/11 x64, use `ReviewOps-1.2.10-windows-x64.exe`.
- Projects, reviews, attachments, and settings are stored separately from the installation folder and preserved during updates.
- Data saved by 1.2.10 cannot be opened by 1.2.9. Back up before updating if you may need to return to the older app. Disabling test versions does not delete data or restore an older backup.
