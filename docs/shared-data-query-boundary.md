# Shared-data query boundary

`querySharedData(snapshot, callerContext, operation, payload)` is a synchronous, transport-free query kernel. It has no Store, Electron, filesystem, network, or credential dependency. The local main-frame adapter described below connects this kernel to trusted local IPC. No remote or device transport is connected.

The application must obtain one immutable Store snapshot and construct the caller context itself. The context is `{projectGrants: [{projectId, read: true}]}`; an empty list permits nothing. Missing, malformed, broadened, or duplicate grants are rejected. Contexts and grants are exact data objects. The operation payload cannot supply grants, identity, roles, or extra options. This separation is an application contract, not proof of device authentication.

| Operation | Exact payload | Response |
| --- | --- | --- |
| `projects.list` | `{}` | `{version: 1, projects}` containing only granted projects still present |
| `reviews.list` | `{projectId}` | `{version: 1, projectId, reviews}` |
| `reviews.get` | `{projectId, reviewId}` | `{version: 1, projectId, review}` |

Every review lookup first requires a grant for the explicit project and confirms that project exists. A review is resolved only within that project. Missing, unshared, and wrong-project resources produce the same `NOT_FOUND` code and fixed message. Unknown operations and unsupported payload fields produce `INVALID_QUERY`; malformed grant contexts produce `ACCESS_DENIED`. Invalid selected stored values or ambiguous duplicate rows produce the fixed `INVALID_SNAPSHOT` error, with no input values attached.

A project contains only `id`, `name`, `description`, `createdAt`, and `updatedAt`. A review contains only `id`, `projectId`, `number`, `title`, `body`, `status`, `priority`, `category`, `createdAt`, and `updatedAt`. All records, arrays and envelopes are newly constructed. No nested source object is returned or mutated. Stored private fields are not traversed. Status/priority choices, text lengths, ID grammar, timestamp format, and the positive integer number follow the current Store's field types. Custom category IDs are retained. The 100,000-row bound follows the existing Store import bound; this is not a network response-size guarantee.

Titles, bodies and descriptions are deliberately shared user content and are preserved. This module is not a secret scanner for free-form content. Structured connections, settings, paths, URLs, evidence, logs, agent material, activities and attachments are omitted. Comments, run status and attachments require separate reviewed projections.

The caller must not independently fetch portions of a snapshot across awaits. A future adapter must re-resolve grants on each operation and must not trust a peer's context. Network pagination/byte limits, device authentication, revocation sessions, durable revisions, command receipts, restore epochs and transports are future work. No placeholder revision or epoch is emitted here. No mutation, listener, relay, remote UI, or #10/#11 completion is provided.

Focused tests use only synthetic in-memory objects and Node's built-in test/assert modules. They cover exact DTOs, foreign/missing IDs, strict payloads/grants, private-field omission, detached results, frozen input, malformed selected fields, duplicate rows, custom categories, and grant revocation. On canonical base `4651b5b0bbee0603fd1a8e6edeba8a7b78f28bf0`, all 15 focused synthetic contracts passed once with Node v24.22.2; none failed or skipped. No app, transport, or existing adapter was exercised.

## Local main-frame adapter

The local IPC actions `shared.projects.list`, `shared.reviews.list`, and `shared.reviews.get` map to the three kernel operations with the same exact payloads. They use the existing request/invoke envelope; there is no new preload capability or external integration action. Existing renderer snapshots and automation/MCP response contracts are unchanged.

The main process queues each read behind prior application mutations. At execution it revalidates the original trusted main-frame sender and owned window record, then captures one current Store snapshot and calls the synchronous adapter without an intervening await. A closed or replaced sender is refused; the focused window is never adopted.

Only an explicit empty server record project ID denotes the unbound main window, which can read projects in that snapshot. A project window can read only its server-owned project ID, including after QA release. A deleted bound project returns no projects and cannot broaden to other projects. This is the policy of the new shared queries; existing ordinary project-window navigation is not represented as a general backend authorization boundary. Renderer tabs, stale dirty drafts, URL parameters and payload grants do not determine this scope.

With Node v24.22.2, two scoped commands each passed once: 23 kernel/adapter contracts and eight selected actual main-handler contracts, with no failures or skips. The 15 kernel contracts repeat the earlier milestone; the eight adapter and eight handler cases are new. The handler checks use mocked Electron windows with a production Store/Vault in owned temporary files. The remaining main-handler suite was not executed. No renderer build, actual app/frame/OS interaction, network, remote permission, revision, command receipt or restore epoch validation is established by these synthetic checks.
