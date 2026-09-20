---
description: "Create or resume an isolated Git worktree and VS Code window for a delivery session — planning (no argument or a session ID) or building (feature/<slug> or issue/<slug>)"
argument-hint: "[<feature|issue>/<slug> | session-id] [--resume] [--no-open]"
---

Needs: terminal, code
Fallback: code → §10 standard fallback (keep the worktree; print the open command)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Start an isolated delivery session in a sibling worktree. This invocation authorizes
fetching, creating the managed worktree described below (in companion mode, the
product + companion **pair** and its `.code-workspace` file), and opening VS Code. It
does not authorize creating a delivery branch in the product repository, deleting a
branch, or changing delivery artifacts. Optional flags for both modes are `--resume` and `--no-open`; reject extra
arguments or unknown flags. "Plan mode" and "build mode" below are Agento worktree
modes chosen by the argument, not VS Code chat modes; this command runs in Agent
chat mode because it needs a terminal.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this command's §9
idempotency row: a registered worktree for the same subject is resumed with `--resume`
semantics whether or not the flag was given, leaving HEAD, branch, and files untouched.
Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for start-session` and map
`fail`/`warn` per §10.
Window check per §11: requires role `primary` on the default branch, clean.

**Dispatch on the argument:**

- `feature/<slug>` or `issue/<slug>` → **build mode**.
- Blank or a bare session ID matching `[a-z0-9][a-z0-9-]{1,63}` → **plan mode**.

**Shared preconditions:**

1. Apply the window check: `node <agento-root>/scripts/agento.mjs session` must report
   `role: "primary"` with `worktree.branch` equal to the configured default branch;
   otherwise reject per §11 with the record's alternatives. The record's `worktrees[]`
   is the ownership source for build mode step 2.
2. Run `git fetch origin`. Authentication or authorization failures halt immediately
   under the repository policy.
3. Managed worktrees live under the managed worktrees directory. Read it — and the
   canonical worktree path and branch for this session — from the Agento CLI:
   `node <agento-root>/scripts/agento.mjs paths <feature|issue|plan> <slug|session-id>`
   (the CLI path is announced in the session context as `Agento CLI:`). It resolves
   `worktrees.dir` from the target repository's `.github/agento.json`, defaulting to
   a sibling `<repo-name>-worktrees/`. Refuse to touch a path that exists but is not
   the registered worktree expected here. The same result carries the **pair**
   fields: `companion` (`{ worktreesDir, worktree, branch } | null`) and `workspace`
   (`<worktrees.dir>/<kind>-<id>.code-workspace | null`). Both are `null` in the
   in-repo layout — then everything below is product-only and nothing else changes.
   When `companion` is set, `artifactsRoot` is the companion clone and
   `companion.worktree` is this session's **companion half**, created in the
   companion clone with `git -C <artifactsRoot> worktree add …` as each mode says.
   A companion path that exists but is not that clone's registered worktree is
   refused exactly like a product path.
4. When the pair exists and both halves are present, run
   `node <agento-root>/scripts/agento.mjs workspace <kind> <id> --write` to write
   the workspace file at the `workspace` path (`workspace plan <session-id>` in
   plan mode; `workspace <type> <slug>` in build mode). On resume, run the same
   command again to refresh a stale file. The CLI-written file keeps product-first
   folders and carries the session auto-approve settings block unless
   `worktrees.autoApprove` is `false`. Unless `--no-open` was supplied, finish by
   running `code --new-window <workspace>` (the pair) or
   `code --new-window <path>` (product-only). The VS Code CLI may reuse an
   already-running editor session instead of visibly creating a second window; treat a
   successful worktree as a valid result, say so explicitly, and never infer a Git
   worktree lock or branch conflict from that behavior. If the `code` CLI is
   unavailable or opening fails, apply the declared `code` fallback (§10), printing
   the same argument (workspace file or path).

## Plan mode

Session IDs identify worktrees only and never determine the eventual delivery slug.

1. If no ID was supplied, generate one with `date -u +%Y%m%d-%H%M%S`; if its managed
   path already exists or is registered, append `-2`, `-3`, and so on until unused.
   `--resume` requires an explicit session ID.
2. Set the managed path to `plan-<session-id>` inside the managed worktrees directory
   (default `<repo-name>-worktrees/plan-<session-id>`):
   - Registered (with or without `--resume`): a duplicate submission per §9 — reuse it
     without changing its HEAD, branch, or files, and say the session already exists
     and was resumed. This supports both an untouched detached session and one whose
     planner already created its final delivery branch.
3. For a new session, run `git worktree add --detach <path> origin/main` and verify it
   is clean, detached, and exactly at `origin/main`. Never create a temporary branch.
   With a pair, create the companion half the same way in the companion clone:
   `git -C <artifactsRoot> fetch origin`, then `git -C <artifactsRoot> worktree add
   --detach <companion.worktree> origin/<default>` (the companion's default branch;
   detached, mirroring the product half — the Planner promotes both halves onto the
   delivery branch when it reserves the slug). A companion half that is already
   registered — for example on a resume whose product half was promoted — is reused
   untouched. Then write the workspace file per shared precondition 4.
4. Report the path (and companion half and workspace file when they exist), created
   or resumed, its branch or detached state, and the exact next command for the new
   window: `/agento new-feature <description>` or `/agento new-issue <description>`.

Different session IDs may run concurrently. Do not run a planner in this primary
window or infer the delivery slug from the session ID.

## Build mode

1. Resolve the roadmap with `agento.mjs resolve <type> <slug>`. It searches the
   primary worktree first and falls back to `origin/<branch>`; `conflict`,
   `branch-mismatch` (the roadmap's `branch:` must equal the branch derived from the
   argument), and `missing` are hard stops — report the `message` verbatim. If the
   resolved roadmap has `status: complete`, stop and report that no build session is
   needed.
2. Find the roadmap branch's owner in the session record's `worktrees[]` (the entry
   whose `branch` equals it; this command creates worktrees, so it may confirm the
   registration with `git worktree list --porcelain` before step 3):
   - Owner with `isPrimary: true`: stop even with `--resume`; the primary worktree
     must return to `main` first and is never switched automatically.
   - Owner with `isManaged: true` (with or without `--resume`): a duplicate
     submission per §9 — reuse that path without changing its branch, directory name,
     or files (promoted `plan-*` worktrees included); one builder per slug, so note
     that building continues in that existing window and do not open a second one.
3. Otherwise create the worktree at the `worktree` path from `agento.mjs paths <type>
   <slug>` on the exact roadmap branch. If the branch exists only as `origin/<branch>`,
   create the local tracking branch as part of `git worktree add`. If it exists
   nowhere, stop and report that the delivery planner must publish it. Never use a
   detached HEAD or a differently named branch. With a pair, also create the
   companion half on the **same branch name** in the companion clone: `git -C
   <artifactsRoot> fetch origin`; when `origin/<branch>` exists there, `git -C
   <artifactsRoot> worktree add <companion.worktree> <branch>` (tracking it); when it
   does not yet exist in the companion (deliveries planned before the companion
   branch mirroring landed), `git -C <artifactsRoot> worktree add --no-track -b
   <branch> <companion.worktree> origin/<default>` and say so — the flag keeps
   the half from inheriting an `origin/<default>` upstream, so its later artifact
   commits count as unpushed until `git -C <companion.worktree> push -u origin
   <branch>` publishes the mirrored branch. A companion half already
   registered at that path (whatever its branch) is reused untouched — never switch
   it. Then write the workspace file per shared precondition 4.
4. Report the worktree path, branch, created or resumed (plus the companion half, its
   branch, and the workspace file when they exist), and the exact next command for
   the new window: `/agento build-feature <slug>` or `/agento build-issue <slug>`.

Do not run the build in this session. Do not install dependencies automatically; note
that the new worktree may require installing dependencies per the project's AGENTS.md.
