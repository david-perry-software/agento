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
- **Companion mode** (`artifacts.repo` set): every managed session is a **pair**. The
  product half lives in `worktrees.dir` as above; the companion half is a worktree of
  the companion clone with the same `<kind>-<id>` name under the derived parallel
  directory `<artifacts.repo.dir>-worktrees/` (for example
  `../agento-docs-worktrees/feature-<slug>`); plan sessions hold both halves detached
  at their origin default, build and freehand sessions hold both on the same branch
  name. `/agento start-session` and `/agento start-freehand` create both halves and
  write `<worktrees.dir>/<kind>-<id>.code-workspace` (two absolute `folders`), which
  is the window they open and the one `/agento continue` reopens; `/agento
  close-session` and `/agento ship`'s teardown remove the companion half, the product
  half, and the workspace file together, refusing while the companion half is dirty
  or unpushed (`companion-unpushed`). The one-builder-per-slug reservation covers
  both halves: `agento.mjs session` from either half describes the same session.
- `/agento start-session` refuses to touch a path that exists but is not the expected
  registered worktree; `/agento close-session` removes worktrees and prunes merged
  branches. The delivery guard asks before removing a worktree that still has
  processes, a VS Code folder window, or the pair's `.code-workspace` window inside it.
- Initiative members in the same wave whose `Requires:` are all complete are all
  `ready` at once (`/agento next-feature <initiative-slug>` lists them); each may be planned
  and built concurrently in its own `/agento start-session` → `/agento new-feature
  initiative:<i>/<f>` session. The Architect publishes the breakdown from the
  primary worktree on a short-lived `changes/initiative-<slug>` branch, so it never
  competes with a delivery worktree.

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
   /agento ship inherits no conflicts.

## Merge-conflict recipes

- Lockfile: take main's, regenerate with the project's package manager, stage.
- Barrels / global stylesheets / shared shells: union both sides, rerun checks.
- Delivery artifacts: a conflict means two sessions touched the same slug — stop and
  reconcile with the roadmap as truth.
