---
description: "Start or resume a lightweight freehand work session in an isolated Git worktree and VS Code window — no plan, roadmap, or review artifacts, just a branch to edit freely and publish later"
argument-hint: "[slug] [--resume] [--no-open]"
agent: "agent"
---

Needs: terminal, code
Fallback: code → §10 standard fallback (keep the worktree; print the open command)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Start an isolated freehand session: a sibling worktree on its own work branch where
changes are made directly with the default VS Code agent and whatever tools are
enabled, bypassing the plan/build/review delivery pipeline. This invocation authorizes
fetching, creating the managed worktree and its branch described below, and opening
VS Code. It does not authorize committing, pushing, deleting a branch, or touching
delivery artifacts.

Optional flags are `--resume` and `--no-open`; reject extra arguments or unknown
flags. Reject an argument containing `/` and direct `feature/<slug>` or
`issue/<slug>` to `/agento start-session` instead — freehand sessions never carry a delivery
slug.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row: a registered worktree for the same slug is resumed with `--resume`
semantics whether or not the flag was given, leaving HEAD, branch, and files untouched.
Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for start-freehand` and map
`fail`/`warn` per §10.
Window check per §11: requires role `primary` on the default branch, clean.

**Preconditions:**

1. Apply the window check: `node <agento-root>/scripts/agento.mjs session` must report
   `role: "primary"` with `worktree.branch` equal to the configured default branch;
   otherwise reject per §11 with the record's alternatives.
2. Run `git fetch origin`. Authentication or authorization failures halt immediately
   under the repository policy.
3. Managed worktrees live under the managed worktrees directory: the `worktrees.dir`
   value from the target repository's `.github/agento.json`, defaulting to a sibling
   directory named `<repo-name>-worktrees/` (e.g. `../myrepo-worktrees/`). Refuse to
   touch a path that exists but is not the registered worktree expected here.

**Session:**

1. Derive the slug from the argument; it must match `[a-z0-9][a-z0-9-]{1,63}`. If no
   argument was supplied, generate one with `date -u +%Y%m%d-%H%M%S`. `--resume`
   requires an explicit slug.
2. The managed path is `freehand-<slug>` inside the managed worktrees directory
   (default `<repo-name>-worktrees/freehand-<slug>`) and the branch is
   `changes/<slug>`:
   - Registered (with or without `--resume`): a duplicate submission per §9 — reuse it
     without changing its branch, HEAD, or files, and say the session already exists
     and was resumed.
   - If the path is free but `changes/<slug>` is already checked out elsewhere (an
     entry on that branch in the record's `worktrees[]`, confirmed with
     `git worktree list --porcelain` — permitted here because this command creates
     worktrees), stop; one session per branch.
3. For a new session, run
   `git worktree add --no-track -b changes/<slug> <path> origin/main`. `origin/main`
   is only the starting point, so `--no-track` is required to keep the branch from
   adopting the wrong upstream. If `changes/<slug>` already exists locally or on
   origin without a registered worktree, reuse that exact branch instead of creating
   it. Verify the new worktree is clean and on the expected branch.
4. Unless `--no-open` was supplied, finish by running `code --new-window <path>`. The
   VS Code CLI may reuse an already-running editor session instead of visibly creating
   a second window; treat a successful worktree as a valid result, say so explicitly,
   and never infer a Git worktree lock or branch conflict from that behavior. If the
   `code` CLI is unavailable or opening fails, apply the declared `code` fallback (§10).

Do not create plan.md, roadmap.md, review.md, or any `features/`/`issues/` directory,
and do not start the work in this primary window. Do not install dependencies
automatically; note that the new worktree may require installing dependencies per the
project's AGENTS.md.

Report the worktree path, the branch, whether it was created or resumed, and the exact
follow-up commands: work freely in the new window, then `/agento finish-freehand` there to
commit, publish, and merge, and finally `/agento close-session changes/<slug>` from this
primary window.
