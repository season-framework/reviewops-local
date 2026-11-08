---
name: reviewops-review-agent
description: "Create or respond to ReviewOps reviews, run an agent only when requested, and record verified results."
version: "2.0.0"
application_rules: "리뷰 등록, 리뷰 응답, 에이전트 실행"
---

# ReviewOps reviews and agent work

Use this skill for internal ReviewOps review creation, replies, requested agent execution and result recording. External GitHub publication and standalone QA reports require a separate user request; neither is a prerequisite for an internal review.

1. Read the selected project, the original review and every relevant reply. Search existing reviews before creating one. Reuse the original review for the same request; do not create duplicates after an uncertain result.
2. Name the target feature and requested change in the title. Record the problem, user impact, reproduction steps, actual behavior and expected behavior as needed. Distinguish a user report from an action you actually reproduced.
3. When a screen explains the problem or result, capture the real whole application window and connect the operation steps to that photograph. Preserve the original; add only a few numbered outlines to a separate copy. Never substitute packaged examples for current evidence.
4. Use the internal review/comment tools for the destination the user requested. Review creation, replying, agent start and agent completion are separate actions. Start or stop an agent only when the user's request includes that action; creating or opening a review does not itself authorize a run.
5. Keep the original project, review and selected execution target. Record implementation, tests, failures and partial work accurately on that review. Do not mark a review resolved merely because an agent was started.
6. Read the saved review, reply, execution status and attachments again. Report the actual persisted identifiers and state; after a timeout check status before retrying the same operation.

Use concise Korean written prose and parallel bullets for Korean requests. Follow the [recording format](references/recording.md).
