---
description: "Start or resume implementation of a planned issue fix from its roadmap.md, with verified, pushed progress"
argument-hint: "Issue slug, or blank to list resumable issues"
agent: "🔨 Agento Builder"
---

Build the **issue** fix named by the slug in the argument. Resolve its roadmap with
the Agento CLI — `node <agento-root>/scripts/agento.mjs resolve issue <slug>` (the CLI
path is announced in the session context as `Agento CLI:`) — and act on the JSON:
`status: ok` gives `path` and `branch`; `conflict`, `branch-mismatch`, or `missing`
are hard stops — report the `message` verbatim.

- If the argument is blank, run `agento.mjs status issue`, list each item's slug,
  `status`, `steps`, and `nextStep`, recommend the best candidate (in-progress and
  paused first), and ask which to work on.
- Run the resume protocol before any implementation: fetch, verify this worktree owns
  `issue/<slug>`, integrate origin, audit ticked checkboxes against the code, repair
  drift, push the repaired roadmap. If another worktree owns the branch, stop and
  report `/start-session issue/<slug> --resume`.
- Execute roadmap steps in order: skill-first, implement, run the step's `verify:`
  check, tick the box, commit (step + roadmap together), push. Ensure a draft PR
  exists whose body starts with `Fixes #<github-issue>` from the roadmap header.
  The exposing regression test must be observed FAILING at its introduction step and
  stay green from the fix step onward.
- Apply delivery-policy.instructions.md throughout: you run everything CLI-executable
  or browser-drivable yourself; `(manual)` steps follow the manual step protocol;
  `(manual, post-ship)` stays unticked.
- On completion write plan.md `## Resolution` (root cause, change summary, proof the
  exposing test passes), set `status: in-review`, and hand off to review. If pausing,
  follow the pause protocol and report the exact resume point. End with the
  cross-window command sequence.
