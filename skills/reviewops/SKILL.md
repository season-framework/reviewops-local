---
name: reviewops
description: "Compose clear ReviewOps reviews for a specified project, group broad requests into independently actionable work, and create or open their task windows through the app bridge."
---

# ReviewOps review registration and agent execution

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

Compose the title and Markdown body first using the [review writing guide](references/review-writing.md). For broad requests read the [grouping guide](references/request-scope.md); keep a coherent workflow together and split only independently actionable changes. Then create a review request:

```sh
node "$SKILL_DIR/scripts/reviewops.mjs" open <<'JSON'
{"requestId":"review-2026-001","projectId":"PROJECT_ID","serviceId":"SERVICE_ID","title":"Checkout button is obscured on a narrow window","body":"## Problem\n\nA user reports that the checkout button is obscured in a narrow window. Direct reproduction has not been performed.\n\n## Reported steps\n\n1. Open checkout in a narrow window.\n2. Inspect the checkout action.\n\n## Expected behavior\n\nThe checkout action remains visible and usable.","tool":"codex"}
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

## Review creation and response rules

Read the target project, existing review and relevant comments before writing. Search for the same request and update the existing review instead of duplicating it. Name the target feature and requested change; record the issue, user impact, operation sequence, actual result and expected result as needed. Distinguish a user report from an actual reproduction.

Use real whole-window photographs and linked operation steps for UI problems and development results. Preserve original photographs and annotate a separate copy. Record only implemented changes and tests actually performed; retain failures, partial work and unrun checks. Re-read saved reviews, replies, status and attachments. Ordinary internal review work does not require GitHub publication or a standalone QA report.

Review registration and agent execution are separate actions. The bridge above registers or opens a review and does not start an agent. If the user requests execution, use the selected app's supported agent tools, preserve the original review and execution target, and record the actual outcome on that review. Do not report opening a task window as completion.

## Request scope and saved results

Before saving, read both writing and grouping guides and inspect the target project and relevant existing reviews/comments through supported app tools when available. The bridge's `list` command lists projects and connections; it does not itself provide a full review search or response API. Do not claim an omitted duplicate search or response was performed. Use the supported ReviewOps/MCP tools for those actions.

Write one concise, specific title and a composed Markdown body per actual review. Preserve every requested detail and the original review reference. A multi-step reproduction or tightly coupled fix belongs in one review. A broad request may need separate reviews only when their desired behavior and acceptance can stand alone; do not create a review per sentence, file or implementation step, or force a fixed count. Follow an explicit single-review request.

Each distinct new review uses its own stable `requestId` and the same intended project/connection. Reuse the original JSON and request ID for a retry. Keep the mapping from request parts to actual returned review IDs so a partial failure does not recreate successful siblings. Query uncertain status first and read each saved title/body and returned result link using the app's available read tools. Correct the same review instead of creating a replacement. Do not invent a GitHub URL or unsupported internal link scheme.
