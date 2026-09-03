---
description: "Run a planned feature or issue unattended: Builder and Reviewer loop automatically until approved or a human is needed"
argument-hint: "<feature|issue>/<slug> or bare slug"
agent: "🤖 Agento Autopilot"
---

Run the delivery named by the argument unattended.

- Accept `feature/<slug>`, `issue/<slug>`, or a bare slug; resolve exactly one
  roadmap.md recursively below `features/` or `issues/` and treat duplicate matches as
  an error.
- If the argument is blank, recursively list roadmaps with `status` in-progress,
  paused, or in-review, recommend the best candidate, and ask which to run.
- Run your preflight, then the build → review → fix loop per your agent instructions:
  cycle cap 3 review rounds, pause the entire run on any `(manual)` step or auth
  failure, and stop at `Verdict: approve` — /ship and /close-session always remain the
  user's commands.
