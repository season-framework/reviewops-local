# Concurrent project QA from Codex and Claude Code

The ReviewOps MCP server directly queries and updates projects, reviews, and task runs. Screen QA sends input to a project window's web view without sharing the system mouse or keyboard. Two Codex agents, or Codex and Claude Code, can inspect different projects concurrently.

## Requirements

Run ReviewOps and Node.js on the same computer. Register the projects and connections to inspect. To start agent tasks, configure the project's agent executable, working folder, and login.

Installed apps include `mcp/reviewops-mcp.cjs` and `mcp/automation-api.cjs`.

| Environment | MCP server file |
| --- | --- |
| Installed macOS app | `/Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs` |
| Installed Windows app | `resources\mcp\reviewops-mcp.cjs` in the ReviewOps installation folder |
| Repository source | `electron/mcp-server.cjs` in the repository |

Start the app first. The MCP server reads `integrations/tools.json` in the app data folder to connect to the running app. Default data folders are `~/Library/Application Support/ReviewOps Local` on macOS and `%APPDATA%\ReviewOps Local` on Windows. If the app uses another folder, pass the same folder with `--data-path`.

Adjust Node.js and app paths in these commands for your installation. An absolute Node.js path avoids dependence on the external agent's PATH.

## Connect Codex

Use the stdio connection supported by [Codex MCP configuration](https://developers.openai.com/codex/mcp).

```sh
codex mcp add reviewops -- /opt/homebrew/bin/node \
  /Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs
```

For manual configuration, add this to Codex `config.toml`:

```toml
[mcp_servers.reviewops]
command = "/opt/homebrew/bin/node"
args = ["/Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Check configuration with `codex mcp list`, then request a `reviewops_projects_list` call in a new Codex conversation. Appearing in the configuration list and successfully calling an app function are separate checks.

### Select tools for an automated QA run

A noninteractive `codex exec` run may reject screen-tool calls that need approval. For automated QA authorized by the user, select only the required tools through that run's `-c` arguments. For example, the click-tool setting is below. Per-tool settings are described in the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

```sh
-c 'mcp_servers.reviewops.tools.reviewops_qa_click.approval_mode="approve"'
```

Typing, keys, scrolling, opening a QA connection, and releasing it can each use corresponding settings for `reviewops_qa_type`, `reviewops_qa_key`, `reviewops_qa_scroll`, `reviewops_qa_open`, and `reviewops_qa_release`. List only the tools required by that inspection in `mcp_servers.reviewops.enabled_tools`. Screen inspection that does not need review creation or agent execution should exclude `reviewops_review_create` and `reviewops_run_start`. Apply these arguments to the authorized QA run; they do not change global tool approval settings or system access permissions.

## Connect Claude Code

Run the [Claude Code local stdio connection command](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server) in the working folder to inspect.

```sh
claude mcp add --transport stdio --scope local reviewops -- /opt/homebrew/bin/node \
  /Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs
```

Check the connection with `claude mcp list` or `/mcp` in a conversation, then request `reviewops_projects_list`. To configure only one run, save the following JSON to a file and invoke `claude --mcp-config PATH_TO_FILE`.

```json
{
  "mcpServers": {
    "reviewops": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/node",
      "args": ["/Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs"]
    }
  }
}
```

## Select a project

Read `projectId` from `reviewops_projects_list` first, then specify the target ID on each request. Do not infer the target from a project name or active window.

To restrict one agent's connection to one project, add `--project-id PROJECT_ID` to the server arguments. The connection lists only that project and rejects calls for another project ID. Agents for projects A and B use different project IDs.

```toml
[mcp_servers.reviewops_a]
command = "/opt/homebrew/bin/node"
args = ["/Applications/ReviewOps.app/Contents/Resources/mcp/reviewops-mcp.cjs", "--project-id", "PROJECT_A_ID"]
```

This prevents task-target confusion. It does not separate operating-system permissions between programs running as the same user.

## Reviews and task runs

These tools do not open or focus windows.

| Tool | Required input | Result |
| --- | --- | --- |
| `reviewops_projects_list` | None | Project and connection list |
| `reviewops_review_categories_list` | `projectId` | Allowed category IDs, display names, kinds, and default category |
| `reviewops_reviews_list` | `projectId` | Reviews in that project |
| `reviewops_review_get` | `projectId`, `reviewId` | Review content and activity |
| `reviewops_review_create` | `projectId`, `requestId`, `title` | New review ID and saved content |
| `reviewops_review_update` | `projectId`, `reviewId`, fields to change | Updated review |
| `reviewops_run_start` | `projectId`, `reviewId`, `requestId`, `prompt` | Run ID and initial state |
| `reviewops_run_list` | `projectId`, `reviewId` | Runs for that review |
| `reviewops_run_get` | `projectId`, `reviewId`, `runId` | Progress, logs, response, and error |
| `reviewops_run_cancel` | `projectId`, `reviewId`, `runId` | Cancellation-request result for that run |

Review creation also accepts `body`, `status`, `priority`, `category`, `targetPath`, `targetUrl`, and `serviceId`. Specify `serviceId` if the project has multiple connections. Review updates change only supplied fields and do not move the project or connection. Run creation also accepts `model`, `reasoningEffort`, and `newConversation`.

### Query review category IDs

`category` is an ID, not a display name. First call `reviewops_review_categories_list` with the target `projectId`, then use a returned `categories[].id` in a create/update request. The equivalent local automation-bridge call is `automation.reviewCategories.list`.

```json
{
  "name": "reviewops_review_categories_list",
  "arguments": { "projectId": "PROJECT_B_ID" }
}
```

The response contains `projectId`, `defaultCategory: "ux"`, and `categories`. Each category provides `id`, `name`, and `kind`. Kinds are `builtin` for a built-in category, `legacy` for one from earlier versions, and `custom` for a user-created category. Built-in display names use the app's Korean source text; custom names are returned unchanged. Categories are shared across the app, but listing still requires a valid project ID. A connection started with `--project-id` rejects another project's category query. This call does not create categories or open windows.

Built-in IDs are `bug`, `ux`, `content`, `performance`, `accessibility`, `security`, and `other`. Compatible legacy IDs `feature`, `structure`, `design`, `data`, `message`, and `typo` are also accepted. Custom categories use registered IDs in the form `custom_...`. For example, after adding a category named `Research` in the app, read the `id` of the returned item with that name. Sending the name itself or an invented ID is rejected.

Omitting `category` on a new review uses `ux`; omitting it on an update preserves the existing category. An invalid category returns `INVALID_INPUT` and the category-listing path. Display names and unknown IDs are not saved.

Use a different `requestId` for each new operation. If the response is lost and the same operation must be retried, retain both its ID and content. Changing content under an existing ID returns an error. Review creation returns `projectId` and `reviewId`; run creation also returns `runId`.

Example review request:

```json
{
  "name": "reviewops_review_create",
  "arguments": {
    "projectId": "PROJECT_B_ID",
    "requestId": "qa-b-review-001",
    "title": "Inspect search results",
    "body": "Inspect search input and the results list."
  }
}
```

Use the returned `reviewId` to start a task:

```json
{
  "name": "reviewops_run_start",
  "arguments": {
    "projectId": "PROJECT_B_ID",
    "reviewId": "CREATED_REVIEW_ID",
    "requestId": "qa-b-run-001",
    "prompt": "Inspect search and record any defects with reproduction steps.",
    "newConversation": true
  }
}
```

A `run_start` response does not mean execution is complete. Use its `runId` with `run_get` to read `run.status`, `run.progress`, `run.output`, `run.response`, and `run.error`. Working-folder collision checks and duplicate-run restrictions within a project remain in force.

## Concurrent QA in project windows

1. Each agent calls `reviewops_qa_open` with its own `projectId` and a unique `clientId`, such as `codex-a`, `codex-b`, or `claude-b`.
2. Pass the returned `sessionId`, `projectId`, and `windowId` on every later screen request.
3. Read screen content and element positions with `reviewops_qa_state`. To control an in-app web inspection view, read its `browserId` from the response's `browsers` and add it to subsequent calls. Even when the web view appears in a full-window photo, input to that view requires `browserId`.
4. Click, type, and scroll using element positions from the same screen. Read `qa_state` again after a screen transition.
5. Capture that screen with `reviewops_qa_capture`. The response includes a PNG image, project/window IDs, image dimensions, `viewport`, and `imageToCss`.
6. Release the connection with `reviewops_qa_release` when finished. Use `reviewops_qa_close` to close the window too.

| Screen tool | Additional input | Action |
| --- | --- | --- |
| `reviewops_qa_open` | `projectId`, `clientId`, optional `reviewId` | Create or reuse a project window and QA connection |
| `reviewops_qa_state` | None | Screen text, element positions, and web inspection views |
| `reviewops_qa_click` | `x`, `y`, optional `button`, `clickCount` | Click coordinates in the selected screen |
| `reviewops_qa_type` | `text` | Type into the selected field on that screen |
| `reviewops_qa_key` | `key`, optional `modifiers` | Send a key to that screen |
| `reviewops_qa_scroll` | `x`, `y`, `deltaY`, optional `deltaX` | Scroll at the specified position |
| `reviewops_qa_capture` | None | PNG image of the selected screen |
| `reviewops_qa_navigate` | `browserId`, `url` | Open an HTTP/HTTPS URL in a web inspection view |
| `reviewops_qa_reload` | None | Reload the selected screen |
| `reviewops_qa_close` | None | Close the project window |
| `reviewops_qa_release` | None | Release QA while keeping the window open |

Every screen tool except `open` requires the previously returned `sessionId`, `projectId`, and `windowId`. Requests other than `close` and `release` may add `browserId` to select an in-app web view. Coordinates are CSS pixels relative to the selected screen's top-left corner. Use element `rect` values from `qa_state` directly. Convert image coordinates with `x × imageToCss.scaleX` and `y × imageToCss.scaleY`: for example, image coordinates `(400, 200)` with both scale values `0.5` become click coordinates `(200, 100)`. Browser `bounds` and `clip` describe positions inside the app in app CSS pixels. To control a web view, read state or a photo again with its `browserId` and use that view's coordinates.

Supported `modifiers` are `Shift`, `Control`, `Alt`, and `Meta`.

One QA client owns a project window at a time. Another client receives `PROJECT_BUSY`. To connect the same client to another review, call `qa_release` first, then open with the new `reviewId`. A QA connection expires after 30 minutes without requests.

A connected QA window exposes only its project and Home. Home also lists only that project's reviews. It cannot query or change other groups/projects, global account/host management, backups, or app-wide settings. Because projects may share a CLI account, log in and out from the main window. The same restrictions apply even when another project's IDs are already known. Review creation/update, inspection views, files, and task execution for the connected project remain available. Use the main app window for global management, or release QA first. Releasing or expiring the connection restores previous menus, tabs, and unsaved drafts. A window blocked after a timeout must be closed and reopened as described below.

If an individual screen request does not finish within 20 seconds, it returns `QA_TIMEOUT` and blocks further QA in that window. Releasing the connection alone does not recover it. Preserve draft content, close that window, and reopen it. Other project windows remain available. Input requests for projects A and B are handled in their respective windows and can run concurrently. These tools control ReviewOps windows and in-app web inspection views; operating-system file dialogs and other programs are outside their scope.

Example agent instruction:

> Perform QA in ReviewOps project PROJECT_A_ID with clientId codex-a. Keep the sessionId and windowId returned by qa_open. Inspect input and results with qa_state, qa_click, qa_type, qa_scroll, and qa_capture. Call qa_release when finished.

Give another agent `PROJECT_B_ID` and `claude-b`. While A performs screen QA, B can create reviews, run tasks, and query results.

## Connection errors

- `APP_UNAVAILABLE`: Check that ReviewOps is running and verify the data folder.
- `TARGET_MISMATCH`: Query the project/review/run/window ID combination again. Do not switch automatically to another project.
- `REQUEST_ID_CONFLICT`: Inspect the existing request. Use a new ID only for a new operation.
- `PROJECT_BUSY`: Finish the project's existing QA or release its connection from the current client.
- `REVIEW_MISMATCH`: Release the existing connection with `qa_release`, then reopen the desired review.
- `QA_TIMEOUT` or `QA_TARGET_UNAVAILABLE`: Close and reopen the stalled window. Do not keep entering input through a new connection to the same window.
- Closed window or expired connection: Obtain a new connection with `qa_open`; do not reuse the old `sessionId` or `windowId`.

MCP communicates over standard input/output. Its app connection uses a user-only local socket or Windows pipe, with no TCP port. The connection token changes after every app restart, so the MCP server rereads the connection file on each call. Do not copy its token into configuration files, logs, or issues.
