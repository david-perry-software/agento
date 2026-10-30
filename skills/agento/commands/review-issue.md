---
description: "Review an issue fix against its plan: score the acceptance checklist, audit roadmap.md, write review.md with a verdict"
argument-hint: "Issue slug to review"
agent: "🔍 Agento Reviewer"
---

Needs: terminal, browser, gh, network
Fallback: browser → §10 standard fallback (headless verify or report blocked)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.
Policy: §1, §2, §3, §4, §5, §7, §8, §9, §10, §11, §12 — load once with `node <agento-root>/scripts/agento.mjs policy 1 2 3 4 5 7 8 9 10 11 12` before the first step.

Review the **issue** fix named by the slug in the argument. Its roadmap resolution is
the `resolve` section of the preflight call below; stop on any `status` other than
`ok`.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this command's §9
idempotency row (a fresh verdict overwrites review.md; no second PR comment thread).
Open with one `node <agento-root>/scripts/agento.mjs preflight review-issue issue
<slug>` call (§9–§11; path in the session context line `Agento CLI:`): print its
`receipt` and then its `preflightLines` verbatim, and stop on `status: rejected`
(exit 3), writing nothing.
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
`Verdict: request-changes`. Publish it with one `node <agento-root>/scripts/agento.mjs
review-publish issue <slug> --body-file -` call (the Reviewer's step 8, the summary
on stdin): it commits review.md and roadmap repairs, pushes, and leaves exactly one
verdict comment on the code PR, edited on a re-review. Then summarize the verdict and
top findings and end with the cross-window command sequence. In companion mode (the
session record's `companion` is not `null`) the slug directory is in the companion
half at `companion.path` on the mirrored branch: read plan.md and roadmap.md and
write review.md there.

If the argument is blank, run `agento.mjs status issue`, list the items with
`status: in-review`, and ask which to review.
