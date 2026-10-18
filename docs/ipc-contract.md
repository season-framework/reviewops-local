# ReviewOps IPC

Renderer uses `await window.reviewops.request(action, payload)`. It returns `{ok:true,data}` or `{ok:false,error:{message,code?,fingerprint?,host?}}` so SSH error details survive the Electron bridge. The shared renderer helper unwraps it. `invoke` remains available for callers that only need the message. No HTTP API or login.

All entities have UUID `id`, ISO `createdAt`, `updatedAt`. Names are required. DTOs use camelCase.

- group: `{id,name,description}`
- project: `{id,groupId,name,description,serviceIds:[]}`
- service: `{id,groupId,name,description,kind:'ssh'|'local',host,port,username,authType:'agent'|'key'|'password',privateKeyPath,rootPath,viewerUrl,hostFingerprint,hasPassword,hasPassphrase}`. Root defaults `/` for SSH; local roots must be explicitly picked. Password and passphrase are only accepted on save and encrypted by main; never present in snapshot. Default port 22. No automatic SSH connection.
- review: `{id,projectId,serviceId:null|string,title,body,status,priority,category,targetPath,targetUrl}`. Status: `open,in_progress,in_review,resolved,recheck,closed`. Priority: `low,normal,high,critical`. Category: `bug,ux,feature,content,other`. Optional target fields default empty.
- activity: `{id,reviewId,type:'comment'|'created'|'updated'|'status',body,createdAt,fromStatus?,toStatus?}`
- attachment: `{id,reviewId,activityId:null|string,name,mimeType,size,storageName,sha256,createdAt}`. Actual bytes belong to main.

## Renderer actions

| Action | Payload | Result |
| --- | --- | --- |
| `snapshot` | `{}` | `{groups,projects,services,reviews,activities,attachments,settings,agentRunning}` (arrays, settings object) |
| `group.save` / `project.save` / `service.save` / `review.save` | entity fields | saved entity |
| `group.delete` / `project.delete` / `service.delete` / `review.delete` | `{id}` | `{deleted:true}` |
| `activity.add` | `{reviewId,body?,status?}` | saved comment or status activity; status and comment are saved together in one transaction. A nonempty comment or a changed status is required. |
| `attachment.add` | `{reviewId}` | array of saved attachment metadata, native picker; cancel returns [] |
| `attachment.read` | `{id}` | `{name,mimeType,content?,dataUrl?,size}` |
| `attachment.delete` | `{id}` | `{deleted:true}` |
| `attachment.export` | `{id}` | `{path}` or `{cancelled:true}` |
| `dialog.directory` / `dialog.key` | `{}` | string path or null |
| `files.list` | `{serviceId,path:''}` | `{path,entries:[{name,path,type:'directory'|'file'|'symlink',size,modifiedAt?}]}`; path relative to configured root |
| `files.read` | `{serviceId,path}` | `{path,name,mimeType,content?,dataUrl?,size}` |
| `ssh.test` | `{serviceId}` | `{ok:true,host,fingerprint}`; throws SSH_TRUST_REQUIRED with fingerprint |
| `ssh.trust` | `{serviceId,fingerprint}` | saved service; trust dialog in UI is explicit |
| `ssh.run` | `{serviceId,command}` | `{stdout,stderr,code,signal?,truncated?}`; user pressed Run only |
| `backup.export` | `{}` | `{path}` or `{cancelled:true}` |
| `backup.import` | `{}` | `{imported:true}` or `{cancelled:true}`; main owns file and replace confirmation dialogs |
| `app.info` | `{}` | `{version,dataPath,platform,arch}` |
| `app.openDataFolder` | `{}` | void |
| `external.open` | `{url}` | void; only http/https |
| `settings.save` | `{theme:'light'|'dark'}` | settings |

Group/project deletion is refused while children exist. Service deletion/unlink is refused if reviews refer to it. Review deletion cascades comments and attachment metadata. UI confirms deletion. Main cleans attachment bytes.

## Store implementation contract

`createStore({dbPath})` returns synchronous methods `snapshot`, `saveGroup`, `saveProject`, `saveService`, `saveReview`, `deleteGroup(id)`, `deleteProject(id)`, `deleteService(id)`, `deleteReview(id)`, `addActivity`, `addAttachment`, `deleteAttachment(id)`, `saveSettings`, `exportData`, `importData(data)`, `close`. `exportData` returns versioned `{format:'reviewops-local',version:3,...snapshot,agentRuns}`. `importData` validates entire data, preserves IDs, replaces all content inside one transaction and clears hostFingerprint and secret availability. Main validates attachment bytes before import. Store save methods accept flat payload. Main keeps encrypted secrets in separate `credentials.json`, maps availability into snapshot; store must not retain password/passphrase fields. Main sets hostFingerprint via saveService after successful explicit trust. Store never has secret fields in export.

## SSH implementation contract

`createSshService(options?)` returns async `test(config)`, `list(config,relativePath='')`, `read(config,relativePath)`, `run(config,command)`. Config is service DTO plus transient `password`/`passphrase`. Errors have `.code`, `.fingerprint` if trust needed. SHA256 key pin in `hostFingerprint`. Return file response as above. Client connections close after operation. Files max 20 MiB; command output max 2 MiB; run max 60s. SFTP realpath under configured root for browse/read. SSH commands are intentionally unrestricted and executed only by explicit user action.


## External browser

Only the trusted app main frame can call these actions. External WebContentsView pages and login popups have no preload or application bridge. They share `persist:reviewops-browser-internal`, separate from the app renderer session. CORS compatibility is enabled only for this partition. HTTP and HTTPS navigation is accepted; local files and application URLs are refused.

| Action | Payload | Result |
| --- | --- | --- |
| `browser.create` | `{url,contextId?,viewport?}` | browser state; starts hidden after viewport preparation |
| `browser.layout` | `{id,visible,bounds,clip,viewport}` | browser state |
| `browser.state` | `{id}` | browser state |
| `browser.navigate` | `{id,url}` | browser state; loading continues independently |
| `browser.back` / `browser.forward` / `browser.reload` / `browser.stop` | `{id}` | browser state |
| `browser.close` | `{id}` | `{closed:true}` |

State is `{id,url,title,loading,canGoBack,canGoForward,error}`. Bounds and clip are `{x,y,width,height}` in app renderer CSS coordinates; viewport is `{width,height,scale}`. Main converts these to native coordinates and places the full WebContentsView inside a frameless child BrowserWindow whose bounds match the visible area. The OS window boundary clips painting without changing native input coordinates. Main prepares the requested viewport before the first external navigation and retains it through navigation and reload using a main-owned CDP session. Without a viewport, creation uses 1920×1080 at scale 1. Layout updates run in order; captures and evidence collection wait for size changes to finish. Main follows the host window position, visibility and fullscreen state. Hidden tabs and app dialogs hide the native surface without closing it. Closing the workspace, reloading the app renderer, or importing a backup closes its browser views and popups. Persistent browser storage is excluded from JSON backups.


## Screenshots and agents (1.0.5)

`update.apply {}` checks when needed, downloads and verifies the selected release, and requests installation. Concurrent calls share the same operation. It returns the same state shape as `update.state`; failures include `status: "error"` and a message, and another call retries the incomplete step. Unsaved editor changes may cancel restart.

SSH agent runs persist `remoteExecution: {version:1,ready,stdoutOffset,stderrOffset}`. Only confirmed server launches can survive app shutdown. Startup reconnects to the saved service and run ID, replays output, and never launches another process for that ID. Explicit cancellation still terminates the remote process group. Backup restoration interrupts existing jobs. Local tasks, terminals, login operations, and transfers prevent installation.

- `browser.capture {id}` captures the external WebContentsView. `viewer.capture {bounds}` captures a local file preview using renderer CSS coordinates. Both return `{dataUrl,mimeType,name,width,height,capturedAt,url?}`; dimensions are PNG pixels.
- `attachment.stageData {dataUrl,name}` accepts validated PNG bytes and returns a staged attachment token. `review.save` or `activity.add` persists it with `attachmentTokens`. `attachment.discard` releases unused tokens.
- `screenshot.export {dataUrl,name}` opens a native save dialog and returns `{path}` or `{cancelled:true}`.
- Service fields: `agentEnabled`, `agentBinary`, `agentWorkPath`, `agentModel`, `agentReasoningEffort`, `agentInstructions`, `agentModels`. Registered models contain `id`, `label`, `reasoning`, and `defaultReasoningEffort`; they are stored with the project connection. Empty work path uses the service root. Empty model/effort uses Codex defaults.
- `agent.environment {serviceId}` returns installed/version/loggedIn/authState/workPath/models, plus defaultModel/defaultReasoningEffort/modelSource/modelError. Sources are host, cache, manual, or none. Host discovery uses read-only Codex app-server model/list and config/read calls; it does not start a conversation or a model turn. `agent.login {serviceId}` starts device authorization; `agent.loginState {serviceId}` restores its latest state after navigation; `agent.logout {serviceId}` clears the selected environment's Codex login.
- `agent.start {reviewId,prompt,newConversation?}` starts a Codex CLI execution in the service's local or SSH working directory. Images are read and verified by main, then supplied to the CLI; renderer cannot choose arbitrary attachment paths.
- `agent.fileRead {reviewId,path,runId?,basePath?}` opens a generated file using its saved run service and working directory. File URLs, line references, path aliases and document-relative links are normalized in main. The response includes `absolutePath` for nested links. Files remain inside the working directory; regular-file and 20 MB checks apply. Unsupported binary files return metadata for download. `agent.fileExport` accepts the same payload and exports original bytes.
- `agent.list {reviewId}` returns persisted runs, newest first. `agent.read {id}` returns a live or persisted run. `agent.cancel {id}` waits for process termination.
- Run fields include id/kind/reviewId/serviceId/prompt/status/model/reasoningEffort/sessionId/sessionScope/workPath/response/output/error/progress/startedAt/finishedAt. Login jobs remain in memory. Run statuses include running/completed/failed/cancelled/interrupted.
- Activities have `role: 'user'|'agent'|'system'` and `agentRunId`. A completed response creates one agent activity. Failed or cancelled jobs retain their execution log without inventing a completed response.
- SQLite schema 3 migrates previous databases. Backups 1, 2 and 3 are accepted. Active jobs block restore and relevant service changes; imported running jobs become interrupted and are never auto-restarted. Codex credentials and session files stay in their execution environment and are excluded from backups.
