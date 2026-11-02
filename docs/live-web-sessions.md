# Shared capture sessions for project web views

Screenshot capture in a Home review explicitly selects a `WebContents` already open in the project. It preserves unsaved forms, navigation, and click state by reusing that source instead of opening the same URL again. Home provides PNG preview and capture; input and navigation remain in the original project window.

## Connections and trust boundaries

- `OriginalViewer` and `NativeBrowser` pass both the project ID and connection service ID. Main validates actual store membership in `connection`/`serviceIds` and the requesting window's project. It does not infer the first project from a service ID, so shared and secondary connections remain distinct.
- The in-memory registry in `electron/viewer-sessions.cjs` binds the actual source WebContents, owner window, project/service, temporary session ID, and epoch. A WebContents rebound to another project cannot be reused as the shared source.
- `viewerSession.list/context/begin/preview/capture/end/closeContext` use only the existing trusted main-frame IPC. Lists return views belonging to the requested project's current connection service. External web pages have no access to this API.
- Project QA connections explicitly allow only those seven `viewerSession` actions. Requests must pass both QA project/review/service checks and main's consumer/intent checks. New input or navigation actions are not automatically allowed; shared previews remain read-only. Global management in ordinary app windows and input in original project web views retain their existing permissions.
- A capture intent is bound to the consumer window, composer context UUID and generation, project/review, purpose and exact activity ID, and session/epoch. New reviews, review edits, new and edited activity, agent request drafts, and waiting-request edits use separate composer contexts. Agent edits also verify the exact waiting-request ID.
- Results arriving after navigation, target replacement, source closure, content changes, or cancellation are rejected through user acceptance and temporary-attachment staging. The app does not automatically select another view or reopen a URL. A view whose owning connection was removed is unavailable for new captures.

## Accepted photos and storage

Selecting **Use** creates a temporary attachment by cropping the original PNG retained by main. A renderer-supplied edited image cannot replace that original. Selection coordinates use original PNG pixels, distinct from CSS viewport resolution and display scale.

After the temporary attachment is created, the photo can be saved even if the original viewer navigates or closes. Main verifies the frozen photo's bytes and SHA-256, consumer/composer context/project/review/purpose/activity binding, and existing staging ownership. An accepted photo cannot be reused in another review, draft, or activity. Normal body editing does not invalidate the photo.

Existing review/activity evidence preserves the source session/epoch, project/service, capture time, original pixel dimensions and SHA-256, crop, and saved PNG SHA-256. Activity edits merge previous `log_captures` with new material. Existing JSON size limits and backup formats remain unchanged. Historical session IDs in a backup are not restored as executable sessions; the live registry exists only in memory.

Existing file previews, ordinary file attachments, and direct viewer-toolbar saves retain their existing paths. This increment's intent/frozen checks cover session capture in project/Home review composers and new captures in existing activity edits and the agent album. Agent drafts retain accepted photos for the same consumer and saved draft ID. Leaving the panel aborts only unaccepted requests; explicitly deleting a draft or cancelling an edit discards the composer context.

## Native capture lifetime for hidden sources

A hidden project's native compositor may stop producing frames, causing capture to wait or return an older frame. During an actual capture request, `electron/browser-capture.cjs` temporarily disables `backgroundThrottling` for that target WebContents and restores the previous boolean on completion, rejection, or synchronous error. A target that already had throttling disabled keeps that setting. The implementation retains the existing NativeImage, PNG bytes, pixel dimensions, and crop path from `capturePage(undefined,{stayHidden:true})`.

This temporary setting also affects [Electron's Page Visibility behavior](https://www.electronjs.org/docs/latest/api/web-contents/#contentssetbackgroundthrottlingallowed). A hidden page becomes `visible` during capture and returns to `hidden` after restoration, so visibility events and timers may run. The implementation does not show or focus the window and preserves the original WebContents, URL, and form. Preserving forms and request counts in a synthetic experiment does not verify a real website's visibility-event behavior.

Only one native capture can run for a target WebContents. Duplicate requests for the same intent are also rejected with `CAPTURE_BUSY` until capture and evidence collection finish. Different composer generations do not share a waiting frame. Source or renderer termination fails the native request's caller and restores settings where possible. A late result from the old native request cannot clean up the new renderer's capture settings or results. The underlying native Promise has no cancellation API, and this change adds no separate timeout.

If the restoration setter fails during a renderer transition, the saved original setting is restored again before the next capture starts. Closing the source during restoration does not return a successful photo. Existing consumer/context/generation/session/epoch checks continue after every asynchronous boundary.

## Scope and verification

The connected provider is a web view. Shared-preview input and virtual-display capabilities are `false`; OS capture permission is `notRequired`. OS virtual-monitor creation, native application capture/input, drivers, OS permission/settings changes, and external network exposure are not implemented. This does not complete virtual-monitor issues #8 or #9.

Relevant checks:

```sh
node --test tests/viewer-sessions.test.cjs tests/browser-capture.test.cjs tests/browser-manager.test.cjs tests/review-capture.test.cjs tests/store.test.cjs
npm run build
node scripts/e2e-live-web-sessions.mjs
node scripts/e2e-screenshots.mjs
node scripts/e2e-viewer-toolbar.mjs
node scripts/e2e-browser-ui.mjs
```

The new E2E uses isolated HOME/app data and a loopback synthetic HTTP form. It does not use real AI, account logins, or production SSH. Source Electron checks and packaged/installed-app checks are separate. Original full-window photos and interaction results are written to ignored `test-results/live-web-sessions`.
