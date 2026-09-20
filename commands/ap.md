---
description: "Run a planned feature or issue unattended: Builder and Reviewer loop automatically until approved or a human is needed"
argument-hint: "<feature|issue>/<slug> or bare slug"
agent: "🤖 Agento Autopilot"
---

Needs: terminal, browser, gh, network
Fallback: browser → §10 standard fallback (headless verify or report blocked)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Run the delivery named by the argument unattended.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this command's §9
idempotency row (re-enter the build or review resume protocol wherever the roadmap
stands). Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for ap` and map `fail`/`warn` per §10.
Window check per §11: requires role `build` with `delivery.slug` equal to the argument.

- Accept `feature/<slug>`, `issue/<slug>`, or a bare slug. Resolve it with the Agento
  CLI (`node <agento-root>/scripts/agento.mjs resolve <type> <slug>`, or `find <slug>`
  for a bare slug; the path is in the session context line `Agento CLI:`) and stop on
  any `status` other than `ok`, reporting its `message`.
- If the argument is blank, run `agento.mjs status`, list the `resumable` items with
  their `status`, `steps`, and `nextStep`, recommend the best candidate, and ask which
  to run.
- Run your preflight, then the build → review → fix loop per your agent instructions:
  cycle cap 3 review rounds, pause the entire run on any `(manual)` step or auth
  failure, and stop at `Verdict: approve` — /agento ship and /agento close-session always remain the
  user's commands. Read roadmap.md and review.md from the artifact checkout the
  session record names: this worktree in the in-repo layout, the companion half
  (`companion.path`) in companion mode.
- If roadmap status is `in-review`, invoke 🔍 Agento Reviewer directly in the same
  window; do not reroute to a manual `/agento review-<type> <slug>` step.
