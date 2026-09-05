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
- Run every CLI-executable command yourself (skill-first); a step is human-only
  exclusively for secret entry, external dashboards, approvals, or physical devices.
  Auth failures halt per the target repository's AGENTS.md (workspace root): name the
  exact reauth command and wait.
- On `(manual)` steps or discovered human-only actions: stop, give the user exact
  instructions, collect a confirming screenshot into the resolved slug's `evidence/`,
  link it from the step, then continue (Builder's manual step protocol).
  Deployed-behavior evidence normally comes from a locally served branch on per-slug
  ports before review; a branch preview only when the step names a `preview:` reason;
  `(manual, post-ship)` is allowed only for the Builder protocol's documented,
  user-accepted exception and is then completed by /ship after the merge.
- On completion set `status: in-review` and hand off to review. If pausing, follow the
  pause protocol and report the exact resume point. Include the Builder's exact
  secondary-window then primary-window command sequence in the completion report.
