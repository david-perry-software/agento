---
description: "Close a clean isolated worktree — a detached planning session (session ID), a fully pushed build session (feature/<slug> or issue/<slug>), or a freehand session (changes/<slug>), with mode detected from worktree state"
argument-hint: "<feature|issue>/<slug> | changes/<slug> | <session-id>"
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Close the isolated session named by the argument. Run this command from the
primary worktree of this repository after closing the session's VS Code window. This
invocation authorizes removing the managed worktree (in companion mode, both halves
of the pair and its `.code-workspace` file) and, when already merged, deleting its
local branch in each repository. It does not authorize discarding changes or deleting
an unmerged branch. `/agento ship` performs the build close itself once the PR is merged, so this
command is the normal close only for plan and freehand sessions and for build
sessions you abandon or supersede; closing a finished build before shipping stays
valid (ship then takes its no-owner path).

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (shared rule 6 below). Window check per §11: requires role `primary`.

**Dispatch on the argument:**

- `feature/<slug>` or `issue/<slug>` → **build close**.
- `changes/<slug>` → **freehand close**.
- A bare session ID matching `[a-z0-9][a-z0-9-]{1,63}` → resolve
  `plan-<session-id>` inside the managed worktrees directory; if it is detached, run
  **plan close**; if it sits on a `feature/<slug>` or `issue/<slug>` branch it was
  promoted, so run **build close** for that branch using this worktree.

**Shared rules:**

1. Apply the window check: `node <agento-root>/scripts/agento.mjs session` must report
   `role: "primary"`; otherwise reject per §11 with the record's alternatives. Then
   `git fetch origin`. Authentication or authorization failures halt immediately.
2. Managed paths live under the managed worktrees directory; resolve the canonical
   path for the argument with the Agento CLI — `node <agento-root>/scripts/agento.mjs
   paths <feature|issue|plan|freehand> <slug|session-id>` (path announced in the
   session context as `Agento CLI:`) — which reads `worktrees.dir` from the target
   repository's `.github/agento.json` (default: sibling `<repo-name>-worktrees/`).
   The same result names the pair: `companion.worktree` (the companion half, a
   worktree of the companion clone at `artifactsRoot`) and `workspace` (the
   `.code-workspace` file); both `null` in the in-repo layout, where every rule below
   applies to the product half alone. Refuse to remove any other path, and never
   remove the primary worktree or the companion clone itself.
3. Inspect the target with `git -C <path> status --short` — the product half and, when
   registered, the companion half. If tracked, untracked, staged, or conflicted
   changes exist in either, stop and list them. Never use `--force`.
4. Remove the companion half first, when registered: `git -C <artifactsRoot> worktree
   remove <companion-absolute-path>` with the literal resolved path, then `git -C
   <artifactsRoot> worktree prune`. Then remove the product half with `git worktree
   remove <canonical-absolute-path>` using the resolved path literally (not a shell
   variable), then run `git worktree prune`. Finally delete the workspace file when it
   exists (`rm <workspace>`, literal path). The delivery guard checks each removal for
   process working directories and matching VS Code folder or workspace windows and
   asks the user to close them before approving removal.
5. Do not kill processes or close windows automatically. When the guard reports active
   occupants, show its details and wait for the user's decision; recommend closing the
   listed terminal/process or VS Code window, then rerunning the removal command.
6. Worktree already removed (the canonical path is neither registered per
   `git worktree list --porcelain` nor present on disk — checked per half, the
   companion's via `git -C <artifactsRoot> worktree list --porcelain`): report that
   half as already closed and continue with the other half and the workspace file;
   when nothing remains, stop successfully — but still delete each repository's local
   branch when it is merged there (remote branch gone and an ancestor of that
   repository's `origin/main`, `git branch -d` / `git -C <artifactsRoot> branch -d`)
   and run `git worktree prune` in each.

## Plan close

1. If the resolved path is not a registered worktree, report that no such planning
   session is open and stop successfully.
2. Require the worktree to be detached and its HEAD an ancestor of `origin/main`; a
   registered companion half must likewise be detached with its HEAD an ancestor of
   the companion's `origin/main` (a half left on a branch with commits is unpushed
   work — stop and list it).
3. Remove the pair and report the removed unpublished planning path(s).

## Build close

1. Run `agento.mjs close-decision <type> <slug>`. It resolves the roadmap locally with
   an `origin/<branch>` fallback and validates the `branch:` header. `status: error`
   (`multiple-roadmaps`, `branch-mismatch`, `no-resolvable-roadmap`,
   `companion-unpushed`) stops the close — report the `message` verbatim.
   `companion-unpushed` means the companion half (`companion.path`) is dirty or ahead
   of its upstream: the user commits and pushes (or discards) there first; never
   remove it.
2. Read `owner` (`{ path, role, dirPrefix, id } | null`), `reason`, and `companion`
   (`{ path, branch, detached, dirty, ahead, registered } | null`) from the decision:
   - `reason: managed-worktree-present` — `owner` is the managed worktree on the
     branch; continue below with `owner.path` as the target.
   - `reason: primary-owns-branch` — the primary worktree itself is on the delivery
     branch. Stop: return the primary to `main` first (`git switch main`), nothing to
     remove.
   - `reason: remote-roadmap-only` (`owner: null`) — no worktree owns the branch:
     report that the build session is already closed (or never opened) and stop
     successfully per shared rule 6. Do not hard-fail on remote-only roadmap
     resolution.
3. Require an upstream for the branch and verify it is zero commits ahead of its
   upstream. If commits are unpushed, stop and report them. (The companion half was
   already checked by the CLI: `companion.ahead` is `0` and `companion.dirty` false
   whenever the decision is `ok`.)
4. Remove the pair per shared rule 4 (companion half when `companion.registered`, then
   `owner.path`, then the workspace file). Do not delete a branch when it remains on
   its origin or is not merged into that repository's `origin/main`. If the remote
   branch no longer exists and the local branch is an ancestor of `origin/main`,
   delete only that merged local branch with `git branch -d` — in the product repo
   and, under the same conditions evaluated in the companion clone, with `git -C
   <artifactsRoot> branch -d <branch>`.
5. Report the removed path(s), retained or deleted local branch(es), and whether the
   next action is `/agento ship <slug>` or no further cleanup.

## Freehand close

1. Resolve `freehand-<slug>` inside the managed worktrees directory and require the
   registered worktree there to be on branch `changes/<slug>`. If no secondary
   worktree owns that branch, report that there is no freehand session to close and
   stop successfully. Freehand sessions have no delivery artifacts, so never look for
   a roadmap.
2. Require a clean status per shared rule 3 (both halves). If the branch has an
   upstream — in either repository — require it to be zero commits ahead; unpushed
   commits stop the close with `/agento finish-freehand` named as the way to publish
   them.
3. Remove the pair per shared rule 4. Delete the local branch with `git branch -d` only
   when the remote branch no longer exists and the branch is an ancestor of
   `origin/main`; otherwise retain it and say why. Apply the same rule in the companion
   clone (`git -C <artifactsRoot> branch -d changes/<slug>`).
4. Report the removed path(s), the retained or deleted local branch(es), and whether
   the work was already merged or still needs `/agento finish-freehand` in a resumed
   session; when it does, emit `/agento start-freehand <slug> --resume` as its own
   block per policy §12, preceded by one line saying it runs from this primary window.
