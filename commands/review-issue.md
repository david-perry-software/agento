---
description: "Review an issue fix against its plan: score the acceptance checklist, audit roadmap.md, write review.md with a verdict"
argument-hint: "Issue slug to review"
agent: "🔍 Agento Reviewer"
---

Needs: terminal, browser, gh, network
Fallback: browser → §10 standard fallback (headless verify or report blocked)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Review the **issue** fix named by the slug in the argument. Resolve its roadmap with
the Agento CLI (`node <agento-root>/scripts/agento.mjs resolve issue <slug>`; path in
the session context line `Agento CLI:`) and stop on any `status` other than `ok`.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (a fresh verdict overwrites review.md; no second PR comment thread).
Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for review-issue` and map
`fail`/`warn` per §10.
Window check per §11: requires role `build` with `delivery.slug` equal to the argument.

Follow your full procedure: confirm from the session record that `worktree.branch` is
`issue/<slug>`, study the diff against
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
