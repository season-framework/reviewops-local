# Shared-data query boundary

`querySharedData(snapshot, callerContext, operation, payload)` is a synchronous, transport-free query kernel. It has no Store, Electron, filesystem, network, or credential dependency. No production adapter is connected in this milestone.

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
