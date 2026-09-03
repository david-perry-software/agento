---
description: "Start or resume implementation of a planned issue fix from its roadmap.md, with verified, pushed progress"
argument-hint: "Issue slug, or blank to list resumable issues"
agent: "🔨 Agento Builder"
---

Build the **issue** fix named by the slug in the argument. Resolve exactly one roadmap
whose parent directory is `<slug>` anywhere below `issues/`; dated paths are
valid, but duplicate matches are an error.

- If the argument is blank, recursively list all roadmap.md files below `issues/` with their `status` and
  `next-step`, recommend the best candidate (in-progress and paused first), and ask
  which to work on.
- Run the resume protocol before any implementation: fetch, verify this worktree owns
  `issue/<slug>`, integrate origin, audit ticked checkboxes against the code, repair
  drift, push the repaired roadmap. If another worktree owns the branch, stop and
  report `/start-session issue/<slug> --resume`.
- Execute roadmap steps in order: skill-first, implement, run the step's `verify:`
  check, tick the box, commit (step + roadmap together), push. Ensure a draft PR
  exists whose body starts with `Fixes #<github-issue>` from the roadmap header.
  The exposing regression test must be observed FAILING at its introduction step and
  stay green from the fix step onward.
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
- On completion write plan.md `## Resolution` (root cause, change summary, proof the
  exposing test passes), set `status: in-review`, and hand off to review. If pausing,
  follow the pause protocol and report the exact resume point. Include the Builder's
  exact secondary-window then primary-window command sequence in the completion report.
