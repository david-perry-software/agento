---
description: "Wrap up a freehand session: commit everything on the session branch, publish it through a protected pull request, and merge it into main without running local verification"
argument-hint: "Optional context, intent, or issue reference"
agent: "agent"
---

Wrap up the freehand session in this worktree: commit the current changes, publish
the branch, and merge it into `main` through the protected pull-request workflow. This
invocation explicitly authorizes committing, pushing, opening and merging a pull
request, and deleting the merged remote branch. Treat any provided argument as
supplemental context, but ground the commit message in the actual diff.

1. Require the current workspace to be a managed freehand worktree: resolve
   `git worktree list --porcelain` and confirm this is a secondary worktree named
   `freehand-<slug>` inside the managed worktrees directory (default
   `<repo-name>-worktrees/`) on branch `changes/<slug>`. If the
   branch is `main`, `feature/*`, or `issue/*`, stop and name the correct command
   (`/commit-current-changes` from the primary worktree, or `/ship <slug>` for
   delivery work).
2. Inspect `git status --short`, the branch's upstream and ahead/behind state, staged
   and unstaged diffs, untracked files, any existing pull request for the branch, and
   a small sample of recent commit subjects. Recover an existing pull request when
   repository state proves this prompt was interrupted; never duplicate a commit or
   pull request.
3. Do not modify source files. Do not run tests, linters, formatters, builds, type
   checks, or other local verification, and do not stop to ask for verification — the
   required pull-request checks are the gate.
4. If the working tree is clean and the branch has no commits beyond `origin/main`,
   report that there is nothing to publish and stop. Never create an empty commit.
5. Fetch the remote and require a cleanly recoverable Git state. If there are
   uncommitted changes, stage all non-ignored changes with `git add -A` and create
   exactly one commit for them. Never add ignored files or files outside the
   repository, and never squash, amend, or rewrite commits already made during the
   session.
6. Write a concise imperative subject that accurately summarizes the primary intent
   and user-visible or architectural effect of the change rather than listing
   filenames, follows the repository's established convention (Conventional Commits,
   `type(scope): description`, with the narrowest accurate type and a scope only when
   it adds specificity), does not end with punctuation, aims for 50 characters, and
   never exceeds 72. Add a body only when it supplies motivation or behavioral
   consequences the subject cannot capture; wrap it at 72 characters and include an
   issue reference from the argument when relevant.
7. Push the branch without force, setting its upstream on the first push, then open or
   reuse a pull request to `main`. Give the pull request a title matching the session's
   overall change and a body summarizing every commit on the branch.
8. Wait for every required check (from the repository's ruleset) to succeed using
   `scripts/wait-for-checks.sh pr <n>` in the foreground; exit 2 means still
   pending — rerun it. Never use `--watch` commands, background terminals, or tasks
   to wait, and never end the turn to "wait". Do
   not merge with checks pending, skipped, cancelled, or failing. Because this prompt
   does not modify files or run verification, report a failed check as an exact
   resumable blocker. If `main` advances, fetch and merge `origin/main` into the
   session branch without rebasing or rewriting history, push normally, and wait for
   the required checks again; this ruleset-required integration merge is the only
   permitted additional commit.
9. Merge the pull request with a normal merge commit through the repository ruleset.
   Never use admin mode or a bypass actor. Delete the merged remote branch. Do not
   switch this worktree to `main` and do not delete the local branch from inside the
   worktree that owns it.
10. Report every commit hash and subject published, the pull-request number, the merge
    result, and the exact cleanup handoff: close this VS Code window, then run
    `/close-session changes/<slug>` from the primary workspace window to remove the
    worktree and delete the merged local branch. If execution stops, report the exact
    branch, pull request, or check phase so the next invocation can resume it.

Do not amend, rebase, squash, force-push, reset, discard changes, bypass hooks or the
ruleset, or commit directly to `main`.
