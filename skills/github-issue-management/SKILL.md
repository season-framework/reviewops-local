---
name: github-issue-management
description: "Create and organize GitHub issues, and concisely record committed code changes and verification results. Use for issue/comment writing, duplicate cleanup, and editing or deleting existing comments."
---

# GitHub issue management

Record problems and results briefly and accurately. Work within the repository and issue scope requested by the user. Write GitHub issues and comments in Korean; repository documentation and release notes are maintained in English.

## Scope

- Read the repository, issue content, related comments, and code to understand the requested work. Search open and closed issues before creating another. Reuse an existing issue for the same problem instead of posting a duplicate.
- Perform writes only within the user's request. Do not ask again if the same session already authorizes posting issues or organizing comments. An investigation or draft-only request does not authorize publishing. Using this skill does not authorize every GitHub change.
- Prefer available GitHub tools; use the CLI or API when required capabilities are missing. Let tools handle credentials, and do not print them in content or logs.

## Write an issue

Include the problem, expected behavior, and relevant code locations with only the detail needed. The title should make the trigger and incorrect behavior immediately clear. Put reproduction conditions in the problem description. Describe an unverified report as an observation or proposal.

Use repository-relative paths or GitHub file links that you have checked. Do not invent uninspected files or causes. Exclude lengthy background, work plans, priorities, unimplemented-task lists, and repeated introductions.

## Completion comments

- Write a completion comment only for work actually changed and committed. Investigation, planning, and finding code locations alone do not justify one. Do not declare completion without a commit.
- Include only changes, checks, and code links directly relevant to the issue's requirements and resolution. Exclude other issues' changes, general release news, skill management, or comment-cleanup results, even when included in the same PR.
- Usually use 3–6 lines for the changed behavior, checks actually performed and their results, and a verified commit or file link. Use fewer lines when appropriate. Do not claim an unperformed check passed. Name the check that verifies this issue's behavior rather than substituting the total test count.
- Check each sentence against the current diff, commit, and test output. Do not borrow another task's results or claim a broader resolution than implemented. Describe only the completed part of a partial fix, without claiming the entire issue is resolved.
- Verify that linked commits exist in the remote repository. Use full commit SHAs in `blob/<commit-sha>/<path>` file links and check the file and line. Do not use unpublished commits or moving branch links as completion evidence.
- Exclude plans, priorities, remaining-task lists, repeated introductions, self-evaluation, and checklists. Do not add progress comments without an actual change.

## Organize existing comments

Handle only comments the user asked to organize. Immediately before changing one, reread its ID, issue number, author, and body; confirm that it belongs to the current authenticated account. Do not edit or delete another person's comments.

Reduce inaccurate or unnecessary material as requested. Limit deletions to the specified scope. If the requested organization is already complete, leave it unchanged. Do not post another comment explaining comment cleanup.

## Publish and verify

- Before publishing, check code changes, verification results, links, and wording. Exclude confidential information, tokens, personal data, local absolute paths, and internal server addresses.
- After creating or editing, reread the body and target URL through the API. After deletion, verify through the API that the comment is gone. If a response is unclear, inspect state first rather than reposting the same content.
- Use short, direct sentences. Remove conversational phrasing and unnecessary jargon. Follow the user's terminology requirements. Put any requested wording-review checklist in the final response, outside the GitHub body or comment.
