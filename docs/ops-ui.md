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


## Shared assistant composer

The sidebar Ops conversation and the right-hand Ops panel use the same conversation, draft and work-target selection. The panel occupies the body below the workspace tab strip. Opening, closing or resizing it leaves the tab strip at its original width and height.

The single conversation header contains Ops, the current conversation name, previous conversations and a new-conversation action. On a narrow chat, history replaces the conversation and offers a return to the original conversation after selecting another item. A wide chat keeps the history list beside the selected conversation. The compact panel also exposes its close action in that header.

Choose a model and reasoning effort from the locally discovered Codex model catalog in the composer footer. The selection is recorded for each request and passed to the connected Codex session. Changing it during an active turn queues the next request until that turn and its background work are confirmed idle, then resumes the same thread using the new settings. Previous requests retain their original settings and target.

Search the work-target menu for the current screen, a group, project, review or document. The current-screen option captures the visible context when each request is sent. A later screen change never redirects a request that is already queued or running.

## Automatic skills and skill files

Settings contains a skill list and separate detail view. Built-in review/agent, ReviewOps control and usage/usability skills replace the former GitHub and report defaults. Updated applications archive the retired bundled entries while preserving user edits, resources and prior execution snapshots. Archived defaults are excluded from automatic application and do not reappear on restart.

Enabled skills are selected from their registered application rules and task categories using the request and captured target. User-created skills participate in the same selection. Requests and goals do not expose a manual skill picker. The execution record shows the exact immutable skill revisions applied to that request; editing a skill affects later requests.

In a skill detail view, select files from the expandable folder tree. Add files or folders beneath a selected folder and edit Markdown with Monaco. Deletion identifies its scope and refuses removal of required instructions or referenced resources. Skill management is rendered only in its own settings section.

## Conversation activity and deletion

The common composer preserves Markdown source, line breaks and pasted text, grows to a bounded height and offers a rendered preview. Responses and actual tool or command events appear in chronological order. Quiet output does not imply completion. Unknown execution or background state requires reconciliation.

Stop uses an independent control request during input admission and delayed acknowledgements. It cancels queued or preparing input, confirms the original turn and background work have stopped, preserves received response text and retires the original adapter before another request. Deletion removes only the selected conversation after confirmed stop; linked projects, reviews and other conversations remain. A failed interruption retains the conversation and its uncertain status.

## Review authoring and skill detail tabs

The review/agent skill includes immutable writing and request-scope guides. New requests receive their complete selected versions. Review creation uses specific feature-and-behavior titles, relevant Markdown sections, all supplied constraints and truthful evidence. Cohesive steps and exceptions stay together; independent changes become separately actionable reviews in the original project. Existing matching reviews are reused and saved records are reread. External publication and goal execution are separate actions.

Skill details separate information and usage settings from the package-file workspace. Switching tabs keeps metadata and Monaco drafts, selected files, expanded folders and independent scroll positions. Leaving the document or changing destructive context still requires an explicit decision about unsaved work.
