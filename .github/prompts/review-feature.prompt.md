---
description: "Review a feature implementation against its plan: score the acceptance checklist, audit roadmap.md, write review.md with a verdict"
argument-hint: "Feature slug to review"
agent: "🔍 Agento Reviewer"
---

Needs: terminal, browser, gh, network
Fallback: browser → §10 standard fallback (headless verify or report blocked)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Review the **feature** named by the slug in the argument. Its roadmap resolution is
the `resolve` section of the preflight call below; stop on any `status` other than
`ok`.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this command's §9
idempotency row (a fresh verdict overwrites review.md; no second PR comment thread).
Open with one `node <agento-root>/scripts/agento.mjs preflight review-feature feature
<slug>` call (§9–§11; path in the session context line `Agento CLI:`): print its
`receipt` and then its `preflightLines` verbatim, and stop on `status: rejected`
(exit 3), writing nothing.
Window check per §11: requires role `build` with `delivery.slug` equal to the argument.

Follow your full procedure: confirm from the session record that `worktree.branch` is
`feature/<slug>`, study the diff against
`origin/main`, load every matching installed skill for the domains the work touches
(per the project's skills table — its AGENTS.md `## Agento` section — and the
skills-first policy, `.agents/skills/`), run the relevant test and
typecheck suites plus the roadmap `verify:` checks, score every plan.md acceptance
checklist item with evidence, and apply the lint gate from
delivery-policy.instructions.md. Audit and repair roadmap.md, and write
`review.md` in the resolved slug directory with an explicit `Verdict: approve` or
`Verdict: request-changes`. Commit and push the review, then summarize the verdict and
top findings and end with the cross-window command sequence. In companion mode (the
session record's `companion` is not `null`) the slug directory is in the companion
half at `companion.path` on the mirrored branch: read plan.md and roadmap.md there,
commit review.md and roadmap repairs with `git -C <companion.path>`, push that half,
and post the single verdict comment on the code PR (`gh pr comment --edit-last` on a
re-review).

If the argument is blank, run `agento.mjs status feature`, list the items with
`status: in-review`, and ask which to review.
