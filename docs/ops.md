# Ops goals and schedules

Ops keeps a separate persistent Codex conversation for each goal. A goal stores its name, description, project connection or folder, execution settings and goal prompt. The global instructions, goal prompt, schedule instructions, user request and current progress are shown separately in the prompt preview. Every delivery record preserves the complete marked prompt that was actually submitted, its reason, originating schedules and original thread/turn identifiers. A preview uses a visible `PREVIEW` delivery marker; the actual delivery identifier is assigned before submission and appears in its history record.

## Execution and target ownership

Start activates a goal; pause and finish persist the inactive state before interrupting its turn. Additional instructions resume the existing thread when idle and steer the current turn while running. Reconnect reads the original session and delivery marker before allowing another attempt. Paused and finished goals never start because a schedule becomes due.

Independent targets run concurrently. Local folders are resolved through the filesystem before execution, including symbolic links. Project goals use an explicitly selected project connection when several exist. SSH projects use the original approved SSH connection, host-key checks and server-side canonical directory; a remote path is never interpreted as a local folder. Goals whose canonical directories overlap in the same target namespace wait with a visible reason. An unconfirmed running turn retains its claim until reconciliation. Changing the target server of an existing conversation requires a separate goal; editing the prompt does not create a new conversation.

The model's dynamic tools can list, save or delete only schedules belonging to that goal. Tool arguments cannot select another goal. A mutation requires the active thread and turn, a reason and the server's original call identifier. The schedule change, reason and durable tool receipt are saved together; replaying the same call does not repeat the change.

Ops uses the existing follow-up request modules from issues #16, #20 and #56: `requestTargetKey` and `conflictingTargets` provide target-conflict decisions, `executionSettings` and `requestContext` capture the submitted model/context contract, and `executionIdentity` guards the immutable saved request before delivery. The internal SSH comparison key uses the verified server lock namespace, not a network address to connect to. Ops adds goal-scoped scheduling and live steering around these shared contracts. Its durable thread/turn journal is separate from `agent_requests`, whose foreign keys and ownership rules require an actual review and native agent run; Ops does not create synthetic review rows or change existing review-request history.

Interactive command/file approval requests are not approved automatically. The default unattended policy is `never`; other policies may produce a visible approval-required error because Ops currently provides no approval dialog. Changing sandbox or approval policy does not broaden permissions in an existing in-flight turn.

## Scheduling and recovery

Each goal supports several five-field cron schedules with an IANA timezone. The pinned `cron-parser` implementation handles calendar and daylight-saving transitions. The watcher runs in the main process, independently of the selected screen or minimized windows. On startup or sleep resume, overdue schedules are combined into at most one instruction per goal and their next occurrence advances beyond the current time. It does not replay each missed occurrence. Multiple due schedules retain their identities and instructions in the combined record.

Prepared deliveries are saved and synced before a network write. A lost acknowledgement becomes `unknown`, rather than starting another session. Recovery looks for the exact original user-message marker in the original thread. An absent marker alone does not prove that a timed-out request was never accepted, even when the current thread is idle. Retry requires an explicit safe-to-retry result from the transport; incomplete or unavailable history stays unknown. Definite failures before a network submission can retain a queued request. If the initial thread creation loses its response before any thread ID is known, Ops retains the unknown state and does not create another thread blindly.

Disabling or deleting a schedule cancels its queued instructions that have not been submitted. Instructions already accepted or whose delivery is unknown remain in history and require session reconciliation; disabling a schedule does not claim to cancel a running turn. Use the goal's pause action to interrupt it.

## Persistence and backup

The private, versioned `ops/state.json` file lives under the application's data directory. It stores goals, schedules, settings, conversation records, tool receipts and delivery history. Writes use an exclusive temporary file, file sync, atomic replacement and directory sync on supported platforms. Corrupt or inaccessible files are retained and reported; they are not silently reset.

Application backups include an optional versioned `ops` section alongside the existing review data. Older backups remain readable and preserve the current Ops records when they contain no Ops section. Application restore preserves prompts, records and external thread identifiers but places goals in a paused state requiring reconciliation, including when the restored project data came from an older backup. Active or unconfirmed Ops work blocks a destructive application restore and update installation. A recovery backup is created before replacing current data. Ops does not copy account credentials into goals or backup records.

The transport, manager and UI checks cover different scopes. State-machine tests use a controlled executor to exercise races and durable recovery; they do not prove real AI execution, an installed package or cross-platform acceptance. Those conditions must be checked separately before releasing this feature.
