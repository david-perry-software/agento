---
description: "Dashboard of all features, issues, and initiatives: status, branch, PR state, checkbox progress, initiative membership and readiness, and recommended next actions"
argument-hint: "Optional filter, e.g. features, issues, or a slug"
agent: "agent"
tools: [read, search, execute]
---

Report the state of all delivery work, read-only. Do not modify any files or branches.
Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (read-only: a fresh read). Window check per §10: requires role
`any` (read-only / not window-sensitive).

1. Run the Agento CLI: `node <agento-root>/scripts/agento.mjs session --pr` (the CLI
   path is announced in the session context as `Agento CLI:`). Present a short
   **Session** section first: `role`, `worktree.path` and `worktree.branch` (or
   `detached`), the active `delivery` as `<type>/<slug>` (or none), `lifecycle`, the
   `allowed` commands one per line, each `elsewhere` command with its `window`, and
   every `warnings[]` entry verbatim.
2. Run `node <agento-root>/scripts/agento.mjs status [feature|issue] [slug]`,
   passing the argument as the filter. Its JSON gives every roadmap's `slug`, `dir`,
   `type`, `status`, `branch`, `lastUpdated`, `nextStep`, `steps` (ticked/total),
   `reviewVerdict`, `postShipPending`, `initiative` (the initiative slug from the
   roadmap header, or null), and a `duplicates` list to flag as anomalies.
3. Cross-reference open PRs with `gh pr list --state all --limit 50` matching the
   configured feature/issue branch prefixes: PR number, draft/ready, check status.
4. Present one table in the CLI's order (in-progress, paused, in-review, planned,
   complete) with an `Initiative` column (`—` when null) and a final column
   recommending the next command per row (/agento build-feature, /agento build-issue,
   /agento review-feature, /agento review-issue, or /agento ship).
5. Initiatives: run `agento.mjs initiative` (list mode). Skip this section when its
   `items` is empty. For each item with `valid: true`, run `agento.mjs initiative
   <slug>` to obtain `next`, `done`, and `anomalies`. Present a second table with one
   row per initiative: slug, complete/total, in flight, ready, `next` (or `—`), done,
   and the recommended command `/agento next-feature <slug>` (omit when `done` is true).
6. Flag anomalies: roadmap branch missing on origin, status in-review without review.md,
   status complete with an open PR, last-updated older than 14 days, `duplicates`,
   initiatives with `valid: false` (quote their `errors`), and every entry of an
   initiative's `anomalies` (slug, kind, branch).
