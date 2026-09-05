---
description: "Review a feature implementation against its plan: score the acceptance checklist, audit roadmap.md, write review.md with a verdict"
argument-hint: "Feature slug to review"
agent: "🔍 Agento Reviewer"
---

Review the **feature** named by the slug in the argument. Resolve its roadmap with the
Agento CLI (`node <agento-root>/scripts/agento.mjs resolve feature <slug>`; path in the
session context line `Agento CLI:`) and stop on any `status` other than `ok`.

Follow your full procedure: confirm this worktree owns `feature/<slug>`, study the diff against
`origin/main`, load every matching installed skill for the domains the work touches
(per the project's skills table — its AGENTS.md `## Agento` section — and the
skills-first policy, `.agents/skills/`), run the relevant test and
typecheck suites plus the roadmap `verify:` checks, score every plan.md acceptance
checklist item with evidence, and apply the lint gate from
delivery-policy.instructions.md. Audit and repair roadmap.md, and write
`review.md` in the resolved slug directory with an explicit `Verdict: approve` or
`Verdict: request-changes`. Commit and push the review, then summarize the verdict and
top findings and end with the cross-window command sequence.

If the argument is blank, run `agento.mjs status feature`, list the items with
`status: in-review`, and ask which to review.
