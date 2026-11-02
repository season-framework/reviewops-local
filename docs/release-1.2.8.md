# ReviewOps 1.2.8

This release checks the execution environment before starting tasks and adds controls for follow-up requests and review evidence. It preserves draft input and lets website navigation resume after closing an attachment.

## Changes

- [#12](https://github.com/season-framework/reviewops-local/issues/12): Check that the working folder exists and is accessible before execution. A missing folder leads to folder selection or creation guidance.
- [#13](https://github.com/season-framework/reviewops-local/issues/13): Check the Codex executable and login state before execution. A failed start preserves the written request and selected material.
- [#14](https://github.com/season-framework/reviewops-local/issues/14): Import an earlier request as a new draft and compare its previous settings with the new execution settings. Missing or damaged attachments are excluded with a request to select them again. Importing a draft does not start execution; start it explicitly.
- [#16](https://github.com/season-framework/reviewops-local/issues/16): Specify tasks that must finish first and the results a follow-up request needs. Show the waiting reason and registration order, and prevent overlapping execution in the same working folder. Waiting requests start manually. Screenshot and attachment selectors are no longer obscured by the follow-up request area.
- [#17](https://github.com/season-framework/reviewops-local/issues/17): Choose whether to capture the screen when creating a review. Capture failure preserves the written content and attachment selection so you can retry or save without a capture.
- [#18](https://github.com/season-framework/reviewops-local/issues/18): Closing a review attachment or returning to the previous website preserves the original website URL and navigation history.
- [#19](https://github.com/season-framework/reviewops-local/issues/19): Render Markdown tables as tables. Document preview can switch between formatted content and source.
- [#20](https://github.com/season-framework/reviewops-local/issues/20): Keep additions made during execution as follow-up requests and display their submission status. After the follow-up run finishes, record whether it was applied, its result version, and handling notes. Submission alone does not mean the request was read or applied.
- [#21](https://github.com/season-framework/reviewops-local/issues/21): Show execution results alongside review status. After execution, offer next actions such as inspecting the result or requesting more work. The user decides whether the review is complete.
- [#22](https://github.com/season-framework/reviewops-local/issues/22): Enter names for code, artifact, and database versions and retain attached copies. Changing the target version marks earlier evidence as needing review and identifies missing or damaged copies. Version names and provenance stay on the device and are not sent automatically to agents.
- [#23](https://github.com/season-framework/reviewops-local/issues/23): Before saving a review, show the project, execution target, working folder, and attachment provenance. Copying an unexecuted review to another project preserves its selected attachment copies and leaves the original review and history intact.

## Install and update

- On macOS 13 or later, choose an `arm64` DMG for Apple Silicon or `x64` for Intel. The macOS update notification can also install the new version.
- The macOS app uses an ad hoc signature and is not notarized by Apple. The operating system may require confirmation on first launch.
- On Windows 10/11 x64, use `ReviewOps-1.2.8-windows-x64.exe`. The installer is unsigned.
- On Windows, close the app and run the new installer to update. In-app automatic installation is not supported.
- Project and review data are stored separately from the installation folder and preserved during updates.

## Not included in this version

- Development-service start/stop and readiness management from [#15](https://github.com/season-framework/reviewops-local/issues/15) are not included. This change adds tests that distinguish service execution state after agent completion or cancellation.
- Separating another project's request into a dedicated ReviewOps window from [#24](https://github.com/season-framework/reviewops-local/issues/24) is not included.
- Virtual monitors from [#8](https://github.com/season-framework/reviewops-local/issues/8) and [#9](https://github.com/season-framework/reviewops-local/issues/9), and computer-to-computer connections/remote input from [#10](https://github.com/season-framework/reviewops-local/issues/10) and [#11](https://github.com/season-framework/reviewops-local/issues/11), are not included.
