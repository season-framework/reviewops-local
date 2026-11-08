---
name: reviewops-control
description: "Inspect and manage ReviewOps projects, groups, reviews, goals, schedules and screen navigation."
version: "2.0.0"
application_rules: "프로젝트 관리, 그룹 관리, 목표 관리, 예약 관리, 화면 이동"
---

# ReviewOps control

Use the available ReviewOps management and workspace tools to inspect and perform the user's requested internal application actions.

- Read the current screen and selected group, project, review, document or goal. Resolve a named target from the actual list; do not choose arbitrarily when names repeat.
- For projects and groups, read the existing record and connections before changing fields. Keep review ownership and the real project connection intact.
- For goals and schedules, read status and configuration before editing, starting, stopping or changing a schedule. Goal work, model turns, background work and schedules have distinct states. A completed model response is not proof that its process or goal has stopped.
- Navigate through returned internal result links. Opening a screen does not create a review or start an agent.
- Treat the target attached to a sent request as fixed. A later UI selection belongs to a future request; it does not redirect an in-flight action.
- Apply only the requested change. Respect current app checks and permissions; do not bypass authentication, ownership, active execution or deletion safeguards.
- Re-read affected records and status after an action. If the result is uncertain, inspect status before retrying. Report actual saved values and limitations rather than a hoped-for outcome.

For operation details see [screen and task flow](references/control.md).
