# Independent logical QA controllers

`reviewops_qa_controller` is an opt-in MCP tool backed by `automation.qa.controller`. Its response contract is `logical-qa-controller-v1`. It separates a project's logical QA ownership from the lifetime of a physical MCP process. The eleven legacy QA tools retain their existing behavior.

Open one controller per chat/project. A new chat B can open project B while A continues QA in project A. No app restart, shared system input or change to A's controller is required. One project still admits only one QA owner; opening a busy project fails rather than taking it over.

## Open and retain the original binding

```json
{"operation":"open","projectId":"PROJECT_B_ID","label":"Chat B"}
```

`reviewId` is optional. The response includes `appInstanceId`, `controllerId`, `controllerProof`, the actual QA lease binding, state, generation and expiry. Every later operation requires the original `appInstanceId`, `projectId`, `controllerId` and `controllerProof`. Keep these four fields together. The app issues the random 43-character proof; matching a label, project name, client name or PID cannot substitute for it. The app retains only the proof's hash, in memory. Do not put the proof or connection token in source, logs, screenshots, issues or reports.

The own-window badge shows the connected project, caller-supplied label and attached/detached/unknown state. Released or expired ownership clears the controller label. This public metadata contains no controller ID, proof or grant. Identical labels can belong to different controllers.

## Operations

All rows except `open` require the four original binding fields. Unsupported or unrelated fields are refused.

| Operation | Additional fields | Behavior |
| --- | --- | --- |
| `open` | `projectId`, optional `reviewId`, `label` | Acquire the project's ordinary QA lease and return a private controller proof. |
| `status` | None | Read this controller and the current lease status without renewing it or reconnecting. |
| `detach` | None | Invalidate queued/observed controller work while retaining its bounded lease. |
| `reconnect` | None | Rebind this controller through the normal project-open checks; never take another owner's lease. |
| `release` | None | Revoke this controller and release only its matching lease; leave the window open. |
| `state`, `capture` | Optional `browserId` | Observe the exact surface and receive an app-issued `observationId`; capture also returns its actual image. |
| `click` | `observationId`, `x`, `y`; optional `button`, `clickCount`, `browserId` | Send input to the observed surface. |
| `type` | `observationId`, `text`; optional `browserId` | Insert at the actual focus/selection. |
| `key` | `observationId`, `key`; optional `modifiers`, `browserId` | Send the specified key to the observed surface. |
| `scroll` | `observationId`, `x`, `y`, `deltaY`; optional `deltaX`, `browserId` | Scroll the observed surface. |
| `navigate` | `browserId`, `url` | Navigate the specified web view; discard prior observations. |
| `reload` | Optional `browserId` | Reload the selected surface; discard prior observations. |

An omitted `browserId` selects this controller's main ReviewOps surface. For a web inspection view, first obtain its actual `browserId` from state, then observe that view explicitly. Input uses CSS coordinates in the selected surface, as in the [legacy coordinate contract](mcp.md#legacy-qa-in-project-windows). Never infer a target from the foreground window.

## Reconnect B while A continues

1. Keep B's original four binding fields privately in B's chat. Call `status` when a read-only diagnosis is sufficient.
2. If B needs logical reconnection, call `detach` and then `reconnect` with those fields. A keeps its controller, window, draft and running work. These operations do not restart the MCP process, app or SSH transport.
3. Read fresh `state` or `capture` from B's returned actual binding before sending input. A detach/reconnect/release changes B's generation and invalidates its old observations. A new controller can start at generation 1; generations are not a global ordering.
4. Release B when finished. Releasing B does not release A or close either project's window.

Physical MCP EOF does not release these opt-in leases. A new physical connection to the same capable app can resume only with the original proof. Neither EOF nor detach extends the existing idle lifetime: the default is 30 minutes, successful controller work renews activity, and `status` does not. App restart loses these ephemeral records; an old proof cannot adopt a replacement app. Reconnect does not change the selected app/data root or repair host tool registration.

## Fresh observations and ambiguous input

Each observation belongs to the original controller generation and exact surface/document. Known stale input is refused before dispatch. Navigation, reload, renderer loss and window replacement require fresh observations. The underlying document check does not freeze arbitrary layout, focus or application-data changes; inspect again when these change.

Once input dispatch may have begun, an error can mean the input partly applied. Do not replay it automatically. Observe the same original target and reconcile its actual state. A fresh observation or logical reconnect never clears timeout/release quarantine. Preserve unsaved drafts before following the existing explicit close/reopen recovery. If safe window recreation is blocked by a draft guard, report that blocker instead of discarding the draft.

An older app returns `QA_CONTROLLER_UNSUPPORTED` for this extension. Do not fall back to legacy input, another app, system input or an app-wide restart. Wrong proof/app/project, expired ownership, detached input and missing observations fail explicitly. A project status query or matching display label cannot recover a lost proof.

## Host registration and acceptance

An app capability and a chat host's exposed tool list are separate. Register the physical MCP entry shipped in the selected installed app and allow `reviewops_qa_controller` for the intended connection. Use explicit `--connection` or `--data-path` plus `--project-id` when selecting a private candidate/project. Do not change a shared host connection or invoke a global tool reload as a B-only recovery. See [Codex registration](mcp.md#connect-codex).

Controlled protocol and renderer tests verify their specific contracts. Feature acceptance additionally uses an installed candidate and two genuine external-agent chats: open B during A's QA and real SSH activity; input/capture both projects independently; switch foreground windows; reconnect/release only B; and reload/recreate B's target with fresh observations. Record A/B drafts, queued work and A's original SSH channel throughout. Full-window photos and tool results must come from that execution. A controlled protocol driver alone does not prove external-chat behavior, and a private installed candidate does not establish delivery of a public release.
