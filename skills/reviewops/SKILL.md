---
name: reviewops
description: "Create a review for a specified ReviewOps project or open an existing review in a dedicated task window. Use to send review requests from external tools or query request status."
---

# ReviewOps review requests

This skill's `scripts/reviewops.mjs` accepts JSON on Node.js standard input and passes it to a running ReviewOps app. Codex, Claude Code, Hermes, and other command-capable environments use the same commands. Automatic skill installation and product-specific APIs are not provided.

Start ReviewOps first. The command saves a review and opens its task window; it does not automatically start Codex or another agent.

- Use the project ID or absolute working-folder path specified by the user. Query projects and connections with `list` first when needed. Do not choose arbitrarily when names repeat or a folder belongs to multiple projects.
- Specify `serviceId` when a project has multiple connections. Folder selection must match the real path of a local project and identify one connection. Select an SSH workspace by `projectId`.
- Generate a new `requestId` for every new request and retain it until a response arrives. Retry the same request with exactly the same ID and JSON content. Do not change the content or target of an already-used ID.
- `needs_project` requires selecting or confirming the target. Read `message` and `reviewId`; do not recreate a saved review. Use a new ID to change the target. A `display_failed` result may already include a saved review ID, so retry with the original ID and content.
- After a disconnection or timeout, query `status` first. Do not report an error as success or create a duplicate review under a new ID.
- Do not print or copy the app connection file's token. The script handles it internally.

Replace `SKILL_DIR` with the actual directory containing this file. An `.app` path is not a data folder. If data is outside the default location, use `--data-dir` or `REVIEWOPS_DATA_DIR`.

```sh
node "$SKILL_DIR/scripts/reviewops.mjs" list
```

Create a review request:

```sh
node "$SKILL_DIR/scripts/reviewops.mjs" open <<'JSON'
{"requestId":"review-2026-001","projectId":"PROJECT_ID","serviceId":"SERVICE_ID","title":"Inspect checkout","body":"Check whether the checkout button is obscured on a mobile viewport.","tool":"codex"}
JSON
```

Use `workspacePath` instead of `projectId` when appropriate. Omit `serviceId` when there is only one connection. To open an existing review, use `reviewId` instead of `title`/`body` and still specify the project or working folder.

```sh
node "$SKILL_DIR/scripts/reviewops.mjs" status <<'JSON'
{"requestId":"review-2026-001"}
JSON
```

Read `ok`, `data.status`, `data.reviewId`, and `data.windowId` and report the result. `shown` means the requested review window was displayed, not that review work is complete.

See the repository's [MCP integration guide](../../docs/mcp.md) for concurrent project QA and MCP tools. This skill's JSON commands provide only the review creation/opening/status actions described above.
