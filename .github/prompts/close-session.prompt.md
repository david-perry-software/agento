---
description: "Close a clean isolated worktree — a detached planning session (session ID), a fully pushed build session (feature/<slug> or issue/<slug>), or a freehand session (changes/<slug>), with mode detected from worktree state"
argument-hint: "<feature|issue>/<slug> | changes/<slug> | <session-id>"
---

Close the isolated session named by the argument. Run this command from the
primary worktree of this repository after closing the session's VS Code window. This
invocation authorizes removing the managed worktree and, when already merged, deleting
its local branch. It does not authorize discarding changes or deleting an unmerged
branch.

**Dispatch on the argument:**

- `feature/<slug>` or `issue/<slug>` → **build close**.
- `changes/<slug>` → **freehand close**.
- A bare session ID matching `[a-z0-9][a-z0-9-]{1,63}` → resolve
  `plan-<session-id>` inside the managed worktrees directory; if it is detached, run
  **plan close**; if it sits on a `feature/<slug>` or `issue/<slug>` branch it was
  promoted, so run **build close** for that branch using this worktree.

**Shared rules:**

1. Resolve the primary worktree with `git worktree list --porcelain`; require the
   current workspace to be that primary worktree, then `git fetch origin`.
   Authentication or authorization failures halt immediately.
2. Managed paths live under the managed worktrees directory: the `worktrees.dir` value
   from the target repository's `.github/agento.json`, defaulting to a sibling
   directory named `<repo-name>-worktrees/` (e.g. `../myrepo-worktrees/`), with a
   canonical `<type>-<slug>`, `plan-<session-id>`, or `freehand-<slug>` name. Refuse
   to remove any other path, and never remove the primary worktree.
3. Inspect the target with `git -C <path> status --short`. If tracked, untracked,
   staged, or conflicted changes exist, stop and list them. Never use `--force`.
4. Remove with `git worktree remove <canonical-absolute-path>` using the resolved path
   literally (not a shell variable), then run `git worktree prune`. The delivery guard
   checks for process working directories and matching VS Code folders and asks the
   user to close them before approving removal.
5. Do not kill processes or close windows automatically. When the guard reports active
   occupants, show its details and wait for the user's decision; recommend closing the
   listed terminal/process or VS Code window, then rerunning the removal command.

## Plan close

1. If the resolved path is not a registered worktree, report that no such planning
   session is open and stop successfully.
2. Require the worktree to be detached and its HEAD an ancestor of `origin/main`.
3. Remove it and report the removed unpublished planning path.

## Build close

1. Recursively locate exactly one roadmap whose parent is `<slug>` below
   `<type-plural>/`. If absent on the current checkout, enumerate
   `origin/<type>/<slug>` with `git ls-tree` and read the single matching roadmap with
   `git show`. The remote fallback is valid, but the exact `branch:` value still must
   equal `<type>/<slug>`; otherwise report a branch mismatch and stop. If the roadmap
   resolves only from the remote branch, treat the session as already closed unless a
   managed secondary worktree still owns the branch.
2. If no secondary worktree owns the branch, report that there is no build session to
   close and stop successfully. Do not hard-fail on remote-only roadmap resolution.
3. Require an upstream for the branch and verify it is zero commits ahead of its
   upstream. If commits are unpushed, stop and report them.
4. Remove the worktree. Do not delete the branch when it remains on origin or is not
   merged into `origin/main`. If the remote branch no longer exists and the local
   branch is an ancestor of `origin/main`, delete only that merged local branch with
   `git branch -d`.
5. Report the removed path, retained or deleted local branch, and whether the next
   action is `/ship <slug>` or no further cleanup.

## Freehand close

1. Resolve `freehand-<slug>` inside the managed worktrees directory and require the
   registered worktree there to be on branch `changes/<slug>`. If no secondary
   worktree owns that branch, report that there is no freehand session to close and
   stop successfully. Freehand sessions have no delivery artifacts, so never look for
   a roadmap.
2. Require a clean status per shared rule 3. If the branch has an upstream, require it
   to be zero commits ahead; unpushed commits stop the close with
   `/finish-freehand` named as the way to publish them.
3. Remove the worktree. Delete the local branch with `git branch -d` only when the
   remote branch no longer exists and the branch is an ancestor of `origin/main`;
   otherwise retain it and say why.
4. Report the removed path, the retained or deleted local branch, and whether the work
   was already merged or still needs `/finish-freehand` in a resumed session
   (`/start-freehand <slug> --resume`).
