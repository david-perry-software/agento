---
description: "Run a planned feature or issue unattended: Builder and Reviewer loop automatically until approved or a human is needed"
argument-hint: "<feature|issue>/<slug> or bare slug"
agent: "🤖 Agento Autopilot"
---

Needs: terminal, browser, gh, network
Fallback: browser → §10 standard fallback (headless verify or report blocked)
Standard fallbacks: delivery-policy §10.
Policy: §1, §3, §7, §8, §9, §10, §11, §12 — load once with `node <agento-root>/scripts/agento.mjs policy 1 3 7 8 9 10 11 12` before the first step.
Duplicate submission: Re-enters the build or review resume protocol wherever the roadmap stands.

Run the delivery named by the argument unattended.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this command's
duplicate-submission line. Open with one `node <agento-root>/scripts/agento.mjs preflight ap <argument>`
call (§9–§11; the path is in the session context line `Agento CLI:`): print its
`receipt` and then its `preflightLines` verbatim, and stop on `status: rejected`
(exit 3), writing nothing.
Window check per §11: requires role `build` with `delivery.slug` equal to the argument.

- Accept `feature/<slug>`, `issue/<slug>`, or a bare slug and pass it to the preflight
  call unchanged; its `resolve` section is the roadmap resolution (a bare slug is
  resolved type-agnostically). Stop on any `resolve.status` other than `ok`,
  reporting its `message`.
- If the argument is blank, run `agento.mjs status`, list the `resumable` items with
  their `status`, `steps`, and `nextStep`, recommend the best candidate, and ask which
  to run.
- Run your preflight, then the build → review → fix loop per your agent instructions:
  cycle cap 3 review rounds, pause the entire run on any `(manual)` step or auth
  failure, and stop at `Verdict: approve` — /agento ship and /agento close-session always remain the
  user's commands. A roadmap left at a session break (`status: in-progress`, or a
  legacy `paused` whose `next-step` carries neither `(manual)` nor `blocked:`, policy
  §3 pause kinds) is resumed by invoking the Builder, never relayed as a pause. Read roadmap.md and review.md from the artifact checkout the
  session record names: this worktree in the in-repo layout, the companion half
  (`companion.path`) in companion mode.
- If roadmap status is `in-review`, invoke 🔍 Agento Reviewer directly in the same
  window; do not reroute to a manual `/agento review-<type> <slug>` step.
