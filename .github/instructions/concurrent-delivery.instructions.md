---
description: "Use when verifying a delivery branch or when two or more delivery sessions may run at once: local-first verification on per-slug resources, when a deployed preview is genuinely required, sharing backing resources safely, and integrating the default branch continuously so /ship never hits merge conflicts"
applyTo: "features/**,issues/**"
---

Concurrent sessions in sibling worktrees verify at the same time. Deployments do not
clobber each other, but several backing resources may be shared. The project-specific
facts (which resources are shared, which preview system exists) live in the target
repository's AGENTS.md `## Agento` section; this file carries the portable policy.

## Serving your branch locally

Which target a step verifies against (`local:<ports>`, `dev-stack`, `preview:
<reason>`) is decided by [delivery-policy.instructions.md](delivery-policy.instructions.md)
§2. The mechanics:

- **Per-slug ports.** Derive them once with the Agento CLI and use them in every
  command and every roadmap `verify:` line, so a resumed session reuses the same ports
  and two sessions never collide:

  ```bash
  node <agento-root>/scripts/agento.mjs ports <slug>   # {"WEB_PORT": 31xx, "API_PORT": 41xx}
  ```

- **Full local stack.** Its fixed ports make it exclusive: confirm no other session
  has it up before starting it, and say so in your report.
- **Deployment preview.** Follow the platform setup the project's AGENTS.md documents
  (e.g. origin allowlists), record it on the step, and undo it at ship.

## Resolve your own preview, never another branch's

Most preview systems give each pushed branch a stable alias derived from that branch,
so two branches never share a preview URL. Resolve yours from your own PR (comment,
deploy log, or platform CLI — whichever the project's AGENTS.md documents), record the
resolved URL on the roadmap step and in the evidence file, and never copy a preview URL
out of another slug's roadmap, plan, or review. No preview means verify against a
faithful local branch instead — never guess or hand-construct an alias.

## Shared resources that DO collide

Check the project's AGENTS.md for which of these exist and their names:

- **One staging backend behind every preview.** Prefer read-only checks. When a check
  must write, name records uniquely (slug + timestamp) and delete them afterwards.
  Never reset, truncate, or bulk-delete shared staging data — another session may be
  mid-verification.
- **Single-variable allowlists are read-modify-write.** If a platform stores allowed
  origins or similar in one variable, two sessions editing it concurrently silently
  drop each other's entry. Re-read the variable after writing to confirm both entries
  survived, and prune yours once the branch merges.
- **Machine-wide local services** (databases, emulators with pinned project IDs and
  fixed ports) are shared by every worktree. Read-only runs may share them;
  destructive work (resets, reseeding, migration replays) is exclusive — confirm no
  other session is verifying before you run it, and say so in your report when you do.
- **Default ports collide.** Two sessions serving branches on the project's default
  ports collide; use the per-slug derivation above.

Keep build and test output directories repository-relative, so each worktree writes
its own — never point them at an absolute shared path.

## Integrate the default branch continuously, not at ship time

When several slugs ship back to back, the last ones to close carry every earlier merge
as an unintegrated diff, and /ship — running in the primary window with no build
context — inherits the conflicts. Keep the diff small instead (substitute the
configured `branches.default` for `main` throughout):

- **Before every push** of a roadmap step: `git fetch origin`; if `origin/main` is
  not an ancestor of `HEAD` (`git merge-base --is-ancestor origin/main HEAD` fails),
  `git merge origin/main` into the branch first (never rebase), resolve conflicts with
  the step's context fresh, rerun the step's `verify:`, then push.
- **Before setting `status: in-review`** and again **before /ship marks the PR ready**,
  the branch must contain `origin/main`. Check `gh pr view <n> --json
  mergeStateStatus`: `BEHIND` means merge main; `DIRTY` means conflicts to resolve
  on the branch; `BLOCKED` means required checks still pending.
- **Known hotspots** (most-changed files across recent PR merges) and their recipes:
  - Lockfiles: take main's version (`git checkout origin/main -- <lockfile>`),
    regenerate with the project's package manager (`--lockfile-only` or equivalent),
    stage the result.
  - Barrel exports and global stylesheets: keep both sides (union), then run the
    affected typecheck / lint.
  - Shared shells and navigation components: keep both features' additions; rerun the
    affected e2e or UI spec locally.
  - Delivery artifacts never conflict across slugs (each has its own directory); a
    conflict there means the same slug was edited from two sessions — stop and
    reconcile with the roadmap as truth.
- Never resolve a conflict by discarding the other side wholesale, and never use
  `--force`, `rebase`, or `--ours`/`--theirs` on source files without reading both.
