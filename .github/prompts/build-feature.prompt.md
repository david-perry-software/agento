---
description: "Start or resume implementation of a planned feature from its roadmap.md, with verified, pushed progress"
argument-hint: "Feature slug, or blank to list resumable features"
agent: "🔨 Agento Builder"
---

Build the **feature** named by the slug in the argument. Resolve its roadmap with the
Agento CLI — `node <agento-root>/scripts/agento.mjs resolve feature <slug>` (the CLI
path is announced in the session context as `Agento CLI:`) — and act on the JSON:
`status: ok` gives `path` and `branch`; `conflict`, `branch-mismatch`, or `missing`
are hard stops — report the `message` verbatim.

- If the argument is blank, run `agento.mjs status feature`, list each item's slug,
  `status`, `steps`, and `nextStep`, recommend the best candidate (in-progress and
  paused first), and ask which to work on.
- Run the resume protocol before any implementation: fetch, verify this worktree owns
  `feature/<slug>`, integrate origin, audit ticked checkboxes against the code, repair
  drift, push the repaired roadmap. If another worktree owns the branch, stop and
  report `/start-session feature/<slug> --resume`.
- Execute roadmap steps in order: skill-first, implement, run the step's `verify:`
  check, tick the box, commit (step + roadmap together), push. Ensure a draft PR exists.
- Apply delivery-policy.instructions.md throughout: you run everything CLI-executable
  or browser-drivable yourself; `(manual)` steps follow the manual step protocol;
  `(manual, post-ship)` stays unticked.
- On completion set `status: in-review` and hand off to review. If pausing, follow the
  pause protocol and report the exact resume point. End with the cross-window command
  sequence.
