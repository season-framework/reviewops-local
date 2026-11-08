# Grouping a broad review request

Decide review boundaries from independently actionable user outcomes, not from the number of sentences or files. This decision guides authorized review creation; it does not authorize extra execution, external publication or a new project target.

## Keep a coherent change together

Use one review when the details describe the same symptom, workflow or acceptance condition, or when a fix is only meaningful as a whole. Related reproduction steps and verification cases belong inside that review.

For example, "remove the forced tab scroll, use the empty header width, keep tabs visible in a narrow window" is one navigation-layout improvement. Do not make separate reviews for CSS files, each width, keyboard checks or the implementation steps. "A saved description disappears after switching to Files and back" is one lost-draft problem, even if it has several reproduction steps.

## Split independent work

Use separate reviews when each change has a distinct desired behavior and can be implemented, tested and resolved without the other. Preserve dependencies and shared context explicitly.

For example, "file search returns unrelated documents, and notification delivery creates duplicate alerts" describes independently reproducible behaviors with separate acceptance checks. Create an appropriately scoped review for each, rather than putting both into a vague "improve the app" review. The number follows the actual independent work; do not target a fixed number or split every bullet automatically.

If the user explicitly asks for one review or chooses boundaries, follow that scope. Do not invent unrelated improvements to fill a grouping plan. If essential target details cannot be resolved from the actual app and request, make useful progress and request only the missing detail instead of creating speculative reviews.

## Preserve scope and original relationships

Before the first write, map every requested change and constraint to its review group. Keep each detail once; do not lose a condition, duplicate the same fix across siblings or add unrequested work. This brief grouping step must not become a reason to stop before saving reviews already authorized by the user.

Search existing reviews, including resolved ones, for each group. Reuse a matching review when it already covers the same behavior. Do not change a resolved review's status or reopen it just to record a follow-up unless requested. When refining or splitting a selected original review, preserve its valid body, comments and evidence, and retain its actual number/ID/title as the original reference. Do not delete the original or automatically close it because related reviews were saved.

New reviews created by one request remain in that request's frozen project. A later visible-screen change must not redirect their writes. If multiple target projects were requested, use supported explicit target selection rather than guessing or bypassing target guards.

## Save each result once

Each genuinely distinct review gets a different stable operation ID. A retry of the same review reuses its original operation ID and identical content. Keep the original group-to-result mapping so a partial failure or resumed conversation does not recreate siblings that already succeeded.

After every save, read the actual review and check title, body, project and requested details. Use `ops_results_lookup` for uncertain results before another write. If a saved review needs correction, update it with a fresh revision. Return each actual saved review link/number and describe any partial failure accurately. Use application-returned result links; do not synthesize `reviewops://` or external GitHub links that the app did not provide.
