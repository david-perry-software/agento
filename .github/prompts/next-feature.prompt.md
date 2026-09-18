---
description: "Read-only initiative report: which member features are ready, blocked, in flight, or complete, the CLI's recommended next feature, and the exact commands to plan it"
argument-hint: "<initiative-slug>"
agent: "agent"
tools: [read, search, execute]
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Report the dependency state of the initiative named by the argument and print the
commands that plan its next member feature. This command is **read-only**: never
create worktrees, branches, or files, and never hand off to another agent —
orchestration stays explicit in the primary window.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (read-only: a fresh read). Window check per §11: requires role
`any` (read-only / not window-sensitive).

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
4. Otherwise print the exact commands for `next`, with the slugs substituted, as a
   numbered list — one locating line, then one bare fenced block holding exactly one
   command, per policy §12:

   1. In the primary window (creates a new `plan-<id>` worktree and window):

      ```
      /agento start-session
      ```

   2. In the new secondary window (writes plan.md, roadmap.md, and the draft PR):

      ```
      /agento new-feature initiative:<initiative-slug>/<feature-slug>
      ```

   3. In the secondary window, take the Planner's **Build in this worktree** handoff,
      or run:

      ```
      /agento build-feature <feature-slug>
      ```

      Or unattended, in the same window (builds, reviews, and fixes until approve):

      ```
      /agento ap <feature-slug>
      ```

   4. In the secondary window, after the build completes:

      ```
      /agento review-feature <feature-slug>
      ```

   5. From the primary window, after `Verdict: approve` (audits in place, merges,
      tears the worktree down):

      ```
      /agento ship <feature-slug>
      ```

   Then list every other `ready` member as plannable concurrently — each needs its own
   `/agento start-session` first (identical to block 1), then one block per member:

   ```
   /agento new-feature initiative:<initiative-slug>/<other-feature-slug>
   ```

   Note that members in the same wave with no `Requires:` between them can be planned
   and built in separate sessions at the same time.

Never run `/agento start-session` or `/agento new-feature` yourself, and never modify the breakdown
— progress is derived from the member roadmaps, not recorded here.
