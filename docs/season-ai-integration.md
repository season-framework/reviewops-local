# Season AI integration

Season AI sends creation tasks to the ReviewOps app installed on this Mac. It requires no separate web server, login account, or Docker. Websites, web games, and HTML presentations are saved in Season AI's dedicated workspace and connected as a local folder in a ReviewOps project.

## Workflow

1. Choose the artifact type and content in Season AI, then start creation.
2. Register a ReviewOps group and a project connected to the local folder. Revision requests in the same conversation reuse the existing workspace.
3. Save the request as a review and open that review full screen in ReviewOps. Use the monitor specified by Season AI when one is supplied.
4. Create the artifact through ReviewOps' existing Codex execution. File changes, command execution, progress, and the final response are saved in the existing activity record.
5. Season AI checks file changes and artifact responses before showing artifact buttons. Failed tasks remain in the review and are not marked successful.

Existing ReviewOps tabs and input are preserved. Cancelling a task waits for the actual process to exit. If disconnection leaves task acceptance unknown, inspect that review's state instead of running the same task again.

## Connection between apps

`electron/season-integration.cjs` opens the Unix socket `integrations/season-ai.sock` in the user data folder. It opens no TCP port. `integrations/season-ai.json` stores the socket path and a connection token regenerated on every launch. The directory uses mode `0700`; the file and socket use `0600`. Do not copy this file into Git or shared folders.

Supported requests are `capabilities`, `prepare`, `review.create`, `review.show`, `task.start`, `task.status`, and `task.cancel`. All data changes use ReviewOps' existing action handlers. External processes do not edit SQLite files directly.

Working folders are restricted to `~/Library/Application Support/Season AI/reviewops-workspace/`. The saved review/workspace binding is checked again immediately before execution. Requests cannot inspect or cancel another review's or task's execution. Request IDs prevent duplicate reviews and executions.

For a new project's Codex executable, resolution tries an executable `SEASON_CODEX_PATH`, the Codex bundled with ChatGPT, then the Codex bundled with the Codex app; if none is available, it uses `codex` from `PATH`. Before execution, existing automatically created connections still set to the default `codex` are refreshed using the same order. User-specified executable paths and model settings are preserved. Dates and times in group names use the Mac's local time.

Automated checks set `SEASON_CODEX_PATH` to the full path of a synthetic executable so the test does not invoke a real model.

`reviewops-local://review/<id>` is stored in Season AI's activity buttons. It is not registered as an operating-system URL handler; Season AI opens its saved review through the ReviewOps connection.

## Verification

`node --test tests/season-integration.test.cjs` checks socket permissions, connection tokens, Korean/Japanese payloads, duplicate prevention, workspace-change rejection, deleted-review handling, and cancellation. Real model execution and visible UI are checked separately in the two installed apps.
