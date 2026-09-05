---
description: "Create or resume an isolated Git worktree and VS Code window for a delivery session — planning (no argument or a session ID) or building (feature/<slug> or issue/<slug>)"
argument-hint: "[<feature|issue>/<slug> | session-id] [--resume] [--no-open]"
---

Start an isolated delivery session in a sibling worktree. This invocation authorizes
fetching, creating the managed worktree described below, and opening VS Code. It does
not authorize creating a delivery branch, deleting a branch, or changing delivery
artifacts. Optional flags for both modes are `--resume` and `--no-open`; reject extra
arguments or unknown flags.

**Dispatch on the argument:**

- `feature/<slug>` or `issue/<slug>` → **build mode**.
- Blank or a bare session ID matching `[a-z0-9][a-z0-9-]{1,63}` → **plan mode**.

**Shared preconditions:**

1. Resolve the primary repository worktree with `git worktree list --porcelain` and
   require the current workspace to be that primary worktree.
2. Run `git fetch origin`. Authentication or authorization failures halt immediately
   under the repository policy.
3. Managed worktrees live under the managed worktrees directory. Read it — and the
   canonical worktree path and branch for this session — from the Agento CLI:
   `node <agento-root>/scripts/agento.mjs paths <feature|issue|plan> <slug|session-id>`
   (the CLI path is announced in the session context as `Agento CLI:`). It resolves
   `worktrees.dir` from the target repository's `.github/agento.json`, defaulting to
   a sibling `<repo-name>-worktrees/`. Refuse to touch a path that exists but is not
   the registered worktree expected here.
4. Unless `--no-open` was supplied, finish by running `code --new-window <path>`. The
   VS Code CLI may reuse an already-running editor session instead of visibly creating
   a second window; treat a successful worktree as a valid result, say so explicitly,
   and never infer a Git worktree lock or branch conflict from that behavior. If the
   `code` CLI is unavailable or opening fails, keep the worktree and report the manual
   open command.

## Plan mode

Session IDs identify worktrees only and never determine the eventual delivery slug.

1. If no ID was supplied, generate one with `date -u +%Y%m%d-%H%M%S`; if its managed
   path already exists or is registered, append `-2`, `-3`, and so on until unused.
   `--resume` requires an explicit session ID.
2. Set the managed path to `plan-<session-id>` inside the managed worktrees directory
   (default `<repo-name>-worktrees/plan-<session-id>`):
   - Registered without `--resume`: stop and report the session already exists.
   - Registered with `--resume`: reuse it without changing its HEAD, branch, or files.
     This supports both an untouched detached session and one whose planner already
     created its final delivery branch.
3. For a new session, run `git worktree add --detach <path> origin/main` and verify it
   is clean, detached, and exactly at `origin/main`. Never create a temporary branch.
4. Report the path, created or resumed, its branch or detached state, and the exact
   next command for the new window: `/new-feature <description>` or
   `/new-issue <description>`.

Different session IDs may run concurrently. Do not run a planner in this primary
window or infer the delivery slug from the session ID.

## Build mode

1. Resolve the roadmap with `agento.mjs resolve <type> <slug>`. It searches the
   primary worktree first and falls back to `origin/<branch>`; `conflict`,
   `branch-mismatch` (the roadmap's `branch:` must equal the branch derived from the
   argument), and `missing` are hard stops — report the `message` verbatim. If the
   resolved roadmap has `status: complete`, stop and report that no build session is
   needed.
2. Inspect `git worktree list --porcelain` for the roadmap branch:
   - Checked out somewhere without `--resume`: stop; one builder per slug. If it is a
     promoted `plan-<session-id>` path, note that building continues in that existing
     window; do not open a second one.
   - Owned by the primary worktree: stop even with `--resume`; the primary worktree
     must return to `main` first and is never switched automatically.
   - Owned by a secondary worktree with `--resume`: reuse that path without changing
     its branch, directory name, or files (promoted `plan-*` worktrees included).
3. Otherwise create the worktree at the `worktree` path from `agento.mjs paths <type>
   <slug>` on the exact roadmap branch. If the branch exists only as `origin/<branch>`,
   create the local tracking branch as part of `git worktree add`. If it exists
   nowhere, stop and report that the delivery planner must publish it. Never use a
   detached HEAD or a differently named branch.
4. Report the worktree path, branch, created or resumed, and the exact next command
   for the new window: `/build-feature <slug>` or `/build-issue <slug>`.

Do not run the build in this session. Do not install dependencies automatically; note
that the new worktree may require installing dependencies per the project's AGENTS.md.
