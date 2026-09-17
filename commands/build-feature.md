---
description: "Start or resume implementation of a planned feature from its roadmap.md, with verified, pushed progress"
argument-hint: "Feature slug, or blank to list resumable features"
agent: "🔨 Agento Builder"
---

Needs: terminal, browser, gh, network
Fallback: browser → §10 standard fallback (headless verify or report blocked)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Build the **feature** named by the slug in the argument. Resolve its roadmap with the
Agento CLI — `node <agento-root>/scripts/agento.mjs resolve feature <slug>` (the CLI
path is announced in the session context as `Agento CLI:`) — and act on the JSON:
`status: ok` gives `path` and `branch`; `conflict`, `branch-mismatch`, or `missing`
are hard stops — report the `message` verbatim.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (the Builder resume/audit protocol below — ticked steps are audited,
never redone). Before the first write, run `node <agento-root>/scripts/agento.mjs
doctor --for build-feature` and map `fail`/`warn` per §10.
Window check per §11: requires role `build` with `delivery.slug` equal to the argument.

- If the argument is blank, run `agento.mjs status feature`, list each item's slug,
  `status`, `steps`, and `nextStep`, recommend the best candidate (in-progress and
  paused first), and ask which to work on.
- Run the resume protocol before any implementation: fetch, confirm from the session
  record that `worktree.branch` is `feature/<slug>`, integrate origin, audit ticked
  checkboxes against the code, repair drift, push the repaired roadmap. If the
  record's `worktrees[]` shows another entry on the branch, stop and report the
  record's alternatives (`/agento start-session feature/<slug> --resume`). In
  companion mode (`companion` not `null`) the roadmap, plan, and evidence live in the
  companion half at `companion.path` on the same branch: read and write them there,
  fetch and integrate that half too, and commit artifacts with `git -C
  <companion.path>`.
- Execute roadmap steps in order: skill-first, implement, run the step's `verify:`
  check, tick the box, commit (step + roadmap together — in companion mode the code
  commit here and the roadmap commit in the companion half, pushed product first),
  push. Ensure a draft PR exists (and, in companion mode, the companion draft PR
  named by the roadmap's `artifact-pr:` header).
- Apply delivery-policy.instructions.md throughout: you run everything CLI-executable
  or browser-drivable yourself; `(manual)` steps follow the manual step protocol;
  `(manual, post-ship)` stays unticked.
- On completion set `status: in-review` and hand off to review. If pausing, follow the
  pause protocol and report the exact resume point. End with the cross-window command
  sequence.
