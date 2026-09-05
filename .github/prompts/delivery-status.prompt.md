---
description: "Dashboard of all features and issues: status, branch, PR state, checkbox progress, and recommended next actions"
argument-hint: "Optional filter, e.g. features, issues, or a slug"
agent: "agent"
tools: [read, search, execute]
---

Report the state of all delivery work, read-only. Do not modify any files or branches.

1. Run the Agento CLI: `node <agento-root>/scripts/agento.mjs status [feature|issue]
   [slug]` (the CLI path is announced in the session context as `Agento CLI:`),
   passing the argument as the filter. Its JSON gives every roadmap's `slug`, `dir`,
   `type`, `status`, `branch`, `lastUpdated`, `nextStep`, `steps` (ticked/total),
   `reviewVerdict`, `postShipPending`, and a `duplicates` list to flag as anomalies.
2. Cross-reference open PRs with `gh pr list --state all --limit 50` matching the
   configured feature/issue branch prefixes: PR number, draft/ready, check status.
3. Present one table in the CLI's order (in-progress, paused, in-review, planned,
   complete), with a final column recommending the next command per row
   (/build-feature, /build-issue, /review-feature, /review-issue, or /ship).
4. Flag anomalies: roadmap branch missing on origin, status in-review without review.md,
   status complete with an open PR, or last-updated older than 14 days.
