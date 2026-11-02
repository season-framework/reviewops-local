# Open ReviewOps reviews from external tools

External tools can create a review or open an existing review in a dedicated project window. This connection does not start an agent run. Codex, Claude Code, Hermes, and other command-capable environments can send the same JSON commands. Product-specific APIs and automatic skill installation are not included.

See [Codex and Claude Code MCP integration](mcp.md) for concurrent project QA, review updates, task execution, and result queries. The JSON commands below create/open reviews and query request status.

## Commands

Use a ReviewOps app that supports external-tool integration and Node.js on the same computer. Start the app before invoking the repository script.

```sh
node skills/reviewops/scripts/reviewops.mjs list
node skills/reviewops/scripts/reviewops.mjs open <<'JSON'
{"requestId":"review-example-001","projectId":"PROJECT_ID","title":"Check the documentation","body":"Check the paths in the installation guide.","tool":"claude-code"}
JSON
node skills/reviewops/scripts/reviewops.mjs status <<'JSON'
{"requestId":"review-example-001"}
JSON
```

The default data folder is `~/Library/Application Support/ReviewOps Local` on macOS and `%APPDATA%\ReviewOps Local` on Windows. For another folder, pass `--data-dir` or set `REVIEWOPS_DATA_DIR`. An `.app` path is an executable app, not a data folder. The script does not start the app automatically.

Do not select a target from its project name alone. Specify a project ID returned by `list`, or a full local working-folder path in `workspacePath`; the two fields are mutually exclusive. Folder matching resolves symbolic links and is accepted only when it identifies one project and connection. Select SSH projects by project ID.

An explicit project ID can open a review with matching ownership even when its local folder is missing. Selection by `workspacePath` requires an existing folder. Neither selection starts an agent automatically.

If a project has multiple connections, add `serviceId`. Its membership in the selected project is checked. To open an existing review, provide `reviewId` and omit `title`/`body`. Existing reviews still require an explicit project or working folder.

## Requests and responses

| Command | App request | Behavior |
| --- | --- | --- |
| `list` | `projects.list` | Returns each project's `id`, `name`, `kind`, and `workPath`, plus the same connection fields. Passwords, keys, and host credentials are excluded. |
| `open` | `review.open` | Accepts `requestId`, a target (`projectId` or `workspacePath`), optional `serviceId`, either a new review's `title`/`body` or an existing `reviewId`, and optional source name `tool`. |
| `status` | `review.status` | Queries the saved request and display state by `requestId`. |

Request IDs contain 1–128 letters, digits, underscores, or hyphens. Titles allow up to 300 characters, bodies 100,000, and tool names 80. The complete request must be at most 512 KiB.

Successful responses use `{ "ok": true, "data": ... }`; errors use `{ "ok": false, "error": { "code": "...", "message": "..." } }`. For `open` and `status`, `data` includes the original `payload`, `requestId`, `status`, `projectId`, `serviceId`, `reviewId`, `windowId`, `shown`, `message`, and save time.

| Status | Meaning and next action |
| --- | --- |
| `needs_project` | The target is missing, ambiguous, or its saved connection changed. The original request is retained. Use a new request ID to select another target. If the same path is later registered or duplicate connections are resolved, retry the original request unchanged. |
| `opening` | The review is saved and waiting for its window. Query status rather than submitting a duplicate. |
| `shown` | The requested project/review window is displayed. It does not mean an agent started or the review is complete. |
| `display_failed` | Review preparation or window display failed. The original request and saved review ID are retained. Retry with the same ID and content. |

Changing the content or target of an existing request ID is rejected. Simultaneous identical requests share one operation. A saved review is reused after an app restart or lost response. A deleted review is not recreated under the same request ID.

Status describes the last request result; closing a window does not change it automatically. Sending the same request again reopens its saved review window. Changes to SSH server address, alias, port, username, or configuration-file path require target confirmation rather than silently reopening the previous request.

## Connection between apps

The app records `{version, socketPath, token, pid}` in the data folder's `integrations/tools.json`. Unix uses `integrations/tools.sock`; Windows uses a pipe named `\\.\pipe\reviewops-tools-...`. No TCP or HTTP port is opened. Clients verify the local address and token.

Unix directories use mode `0700`; connection files, request records, and sockets use `0600`. Windows uses the user data folder's access permissions. The token changes on every app launch and is excluded from command output. Do not share the connection file or add it to the repository.

Each connection processes one newline-delimited `{token, action, payload}` JSON request and one response. Request records are saved in `integrations/tools-state.json`. This file contains request bodies and is not automatically included in JSON project backups. New reviews store the deduplication request ID, content hash, and tool name.

Only review saves and request-record changes are serialized. Other projects' requests and status queries can proceed while a window is opening. The existing Season AI connection remains separate.
