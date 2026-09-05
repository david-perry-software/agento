---
description: "Review an issue fix against its plan: score the acceptance checklist, audit roadmap.md, write review.md with a verdict"
argument-hint: "Issue slug to review"
agent: "🔍 Agento Reviewer"
---

Review the **issue** fix named by the slug in the argument. Resolve its roadmap with
the Agento CLI (`node <agento-root>/scripts/agento.mjs resolve issue <slug>`; path in
the session context line `Agento CLI:`) and stop on any `status` other than `ok`.

Follow your full procedure: confirm this worktree owns `issue/<slug>`, study the diff against
`origin/main`, load every matching installed skill for the domains the work touches
(per the project's skills table — its AGENTS.md `## Agento` section — and the
skills-first policy, `.agents/skills/`), run the relevant test and
typecheck suites plus the roadmap `verify:` checks. Acceptance is gated on the exposing
regression test: confirm it exists at the path named in the plan, demonstrably targets
the original defect (per plan.md `## Evidence`), references the issue number or slug in
its name or header comment, and passes; verify plan.md
`## Resolution` is written and consistent with the diff. A missing, vacuous, or
failing exposing test forces `Verdict: request-changes`. Score every plan.md
acceptance checklist item with evidence, and apply the lint gate from
delivery-policy.instructions.md. Audit and repair roadmap.md, and write
`review.md` in the resolved slug directory with an explicit `Verdict: approve` or
`Verdict: request-changes`. Commit and push the review, then summarize the verdict and
top findings and end with the cross-window command sequence.

If the argument is blank, run `agento.mjs status issue`, list the items with
`status: in-review`, and ask which to review.
