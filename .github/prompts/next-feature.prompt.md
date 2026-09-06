---
description: "Read-only initiative report: which member features are ready, blocked, in flight, or complete, the CLI's recommended next feature, and the exact commands to plan it"
argument-hint: "<initiative-slug>"
agent: "agent"
tools: [read, search, execute]
---

Report the dependency state of the initiative named by the argument and print the
commands that plan its next member feature. This command is **read-only**: never
create worktrees, branches, or files, and never hand off to another agent —
orchestration stays explicit in the primary window.

1. Run the Agento CLI: `node <agento-root>/scripts/agento.mjs initiative <slug>` (the
   CLI path is announced in the session context as `Agento CLI:`). If `status` is
   `missing` or `invalid`, print its `message` and every entry of `errors` verbatim
   and stop. If the argument is empty, run `agento.mjs initiative` (list mode), show
   the initiatives with their `complete`/`total` counts, ask which one to report on,
   and stop.
2. Present the members from `features[]`, grouped:
   - **Ready** — `ready: true` (`state: unplanned`, every `Requires:` complete);
   - **Blocked** — `state: unplanned` and `ready: false`, each with its `blockedBy`;
   - **In flight** — `state` is `planned`, `in-progress`, `paused`, or `in-review`,
     with `branch` and `roadmap`;
   - **Complete** — `state: complete`.
   Then list `anomalies` verbatim (slug, kind, branch) — for example a member branch
   on origin with no roadmap, or a roadmap whose `initiative:` header names another
   initiative.
3. If `next` is `null`: when `done` is `true`, say the initiative is fully delivered
   and stop; otherwise name the in-flight members that must reach `status: complete`
   before anything else becomes ready, and stop.
4. Otherwise print the exact commands for `next`, with the slugs substituted:

   ```text
   /start-session                                        # primary window → new plan-<id> worktree + window
   /new-feature initiative:<initiative-slug>/<feature-slug>   # secondary window → plan.md + roadmap.md + draft PR
   Build in this worktree  (Planner handoff)  — or —  /build-feature <feature-slug>   # secondary window
   /review-feature <feature-slug>                        # secondary window; then, from the primary window:
   /close-session feature/<feature-slug>  →  /ship <feature-slug>
   ```

   Then list every other `ready` member as plannable concurrently, each with its own
   `/start-session` → `/new-feature initiative:<initiative-slug>/<feature-slug>`
   pair, and note that members in the same wave with no `Requires:` between them can
   be planned and built in separate sessions at the same time.

Never run `/start-session` or `/new-feature` yourself, and never modify the breakdown
— progress is derived from the member roadmaps, not recorded here.
