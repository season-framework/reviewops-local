# Manage goals in Ops

Open **Ops** from the main window's sidebar. Each goal has its own Codex conversation and schedules. The list shows the target, goal and execution states, latest work, next schedule, errors and any reason it is waiting for a conflicting work target. Independent targets can run in parallel.

## Create and control a goal

Choose **Add goal**, enter a name, description and goal prompt, and select either a registered project or an absolute local folder. Projects with several connections require choosing the intended connection. SSH project targets are labeled as SSH and use the project's configured remote work folder; a remote path is never treated as a local folder.

Model and reasoning fields can use Codex defaults. File-access and approval settings are saved per goal. Ops currently has no interactive approval window, so a request requiring an interactive approval is reported as a failure. Choose settings appropriate for the goal's unattended work.

Save the goal, then choose **Start**. **Pause** and **Resume** preserve its conversation. **Finish** stops scheduled restarts and retains the saved history. Delete a stopped goal to remove its saved conversation, schedules and history. The UI asks before discarding unsaved settings or deleting records.

The conversation tab shows messages from the connected session and accepts additional instructions for an active goal. While execution is running, additional instructions go to that same work. While it is idle, they continue in the existing session. Errors and uncertain delivery are shown for the affected goal; use **Reconnect** to reconcile the original session before sending another request.

## Register schedules

In a goal's **Schedules** tab, add a name, schedule prompt, cron recurrence and IANA time zone. The list displays whether each schedule is enabled, its next due time, latest run and outcome. Edit, disable or delete individual schedules without changing another goal.

Selecting a schedule opens its saved prompt, assembled-prompt preview and associated execution/change history. Changes received from the goal's Codex schedule tools are reflected through the same live state as user edits. History includes the actor, change reason and saved schedule content. If settings change elsewhere during an edit, the UI preserves the draft and requires loading current settings before saving. A deleted schedule cannot silently become a new schedule through a stale edit form.

Paused and finished goals do not automatically start when schedules become due. The list's **Schedules missed while the app was closed or asleep** disclosure shows the scheduler's saved recovery policy. Missed work is coalesced according to that policy instead of replaying every missed recurrence.

## Inspect prompts and results

**Common instructions** saves shared execution guidance. A goal's settings save its goal prompt, and each schedule saves its own prompt. In **Prompts**, choose a schedule and optional request/reason, then refresh the preview. The full prompt and ordered layers come from the backend assembler; previewing does not start Codex. A notice appears if state changes after a preview was generated.

Execution/change records expose their status, reason, schedule IDs, Codex thread/turn IDs and recorded full prompt. Queued or prepared intent is displayed separately from confirmed delivery. Open those records to inspect what was assembled and the outcome actually recorded for that execution.

## Focused UI validation

`node --test tests/ops-ui.test.cjs tests/window-context.test.cjs tests/i18n.test.cjs` checks stale-snapshot handling, configuration ownership, outcome labels and navigation/QA isolation.

After building, `node scripts/e2e-ops-ui.mjs` exercises the real main-process Ops manager, store, scheduler, preload and UI in an isolated data folder. Its CRUD/preview/restart scenarios do not start Codex. Real Codex execution, steering, schedule-tool calls and packaged release acceptance require their own connected checks.
