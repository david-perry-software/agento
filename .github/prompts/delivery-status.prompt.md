---
description: "Dashboard of all features and issues: status, branch, PR state, checkbox progress, and recommended next actions"
argument-hint: "Optional filter, e.g. features, issues, or a slug"
agent: "agent"
tools: [read, search, execute]
---

Report the state of all delivery work, read-only. Do not modify any files or branches.

1. Recursively find every `roadmap.md` below `features/` and `issues/` (respect the
   argument as a filter). Treat its parent directory name as the slug; flag duplicate
   slugs as anomalies. Extract: slug, artifact path, `status`, `branch`, `last-updated`,
   `next-step`, and checkbox progress (ticked/total across all steps).
2. Cross-reference open PRs with `gh pr list --state all --limit 50` matching
   `feature/*` and `issue/*` branches: PR number, draft/ready, check status.
3. Present one table sorted by status (in-progress, paused, in-review, planned,
   complete), with a final column recommending the next command per row
   (/build-feature, /build-issue, /review-feature, /review-issue, or /ship).
4. Flag anomalies: roadmap branch missing on origin, status in-review without review.md,
   status complete with an open PR, or last-updated older than 14 days.
