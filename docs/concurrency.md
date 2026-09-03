# Concurrency model

Agento is built for several delivery sessions running side by side on one machine.

## Worktrees

- One **primary** worktree, kept on the default branch.
- Managed secondary worktrees live in the configured `worktrees.dir` — by default a
  sibling of the primary named `<repo-name>-worktrees/`:
  - `plan-<session-id>` — detached planning sessions (promoted in place to the
    delivery branch by the Planner's handoff)
  - `feature-<slug>` / `issue-<slug>` — build sessions
  - `freehand-<slug>` — freehand sessions on `changes/<slug>`
- A branch's registered worktree is its reservation: one active builder per slug.
- `/start-session` refuses to touch a path that exists but is not the expected
  registered worktree; `/close-session` removes worktrees and prunes merged
  branches. The delivery guard asks before removing a worktree that still has
  processes or a VS Code window inside it.

## Verification without collisions

Full policy: `.github/instructions/concurrent-delivery.instructions.md`. Summary:

1. **Verify locally first.** Per-slug ports derived from the slug
   (`cksum`-based offset) give every session a stable, collision-free local target.
2. **Previews are the exception.** Only when the step names a platform-dependent
   reason; resolve your own branch's preview, never another's.
3. **Shared resources are documented per project** in AGENTS.md `## Agento` —
   staging backends, machine-wide local services, fixed ports. Read-only sharing is
   fine; destructive operations are exclusive.
4. **Integrate the default branch before every push** (merge, never rebase), so
   /ship inherits no conflicts.

## Merge-conflict recipes

- Lockfile: take main's, regenerate with the project's package manager, stage.
- Barrels / global stylesheets / shared shells: union both sides, rerun checks.
- Delivery artifacts: a conflict means two sessions touched the same slug — stop and
  reconcile with the roadmap as truth.
