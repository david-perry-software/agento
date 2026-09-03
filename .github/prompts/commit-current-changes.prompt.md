---
description: "Review all current repository changes, create one accurate commit, and publish it through a protected pull request without running local verification"
argument-hint: "Optional context, intent, or issue reference"
agent: "agent"
---

Review the current Git changes in this repository, commit them with the best
possible commit message, and publish that commit through the protected pull-request
workflow. This invocation explicitly authorizes creating and deleting a branch,
committing, pushing, opening and merging a pull request, and synchronizing `main`.
Treat any provided argument as supplemental context, but ground the message in the
actual diff.

1. Inspect `git status --short`, the current branch and its upstream/ahead-behind
	state, staged and unstaged diffs, untracked files, any pull request for the
	current branch, and a small sample of recent commit subjects. Recover an existing
	publication branch or pull request when repository state proves this prompt was
	interrupted; do not duplicate its commit or pull request.
2. Do not modify source files. Do not run tests, linters, formatters, builds, type
	checks, or other local verification. Do not stop to ask for verification.
3. If there is no unfinished publication state and no change to commit, say so and
	do not create an empty commit. Otherwise fetch the remote and require a cleanly
	recoverable Git state. New work must start from local `main` synchronized with
	`origin/main`; preserve current changes while creating a dedicated branch named
	`changes/<short-slug>` before staging. Never commit or push changes directly to
	`main`.
4. Identify the primary intent and user-visible or architectural effect of the
	changes. Avoid merely listing filenames or restating individual diff hunks.
5. Stage all current non-ignored changes with `git add -A`. Never add ignored files
	or files outside the repository.
6. Create exactly one content commit. Write a concise imperative subject that
	accurately summarizes the main change, follows the repository's established
	convention when one exists, and does not end with punctuation. If no convention
	is established, use Conventional Commits (`type(scope): description`), choosing
	the narrowest accurate type and including a scope only when it adds useful
	specificity. Aim for 50 characters and never exceed 72 characters.
7. Add a body only when it provides useful context that the subject cannot capture.
	Explain the motivation and important behavioral consequences, wrap lines at 72
	characters, and omit implementation trivia. Include an issue reference from the
	argument when relevant.
8. Before committing, ensure the proposed message describes everything staged and
	makes no unsupported claims. Run `git commit` non-interactively, then push the
	publication branch without force and open or reuse a pull request to `main`.
9. Wait for every required check (from the repository's ruleset) to succeed using
	`scripts/wait-for-checks.sh pr <n>` in the foreground; exit 2 means still
	pending — rerun it. Never use `--watch` commands, background terminals, or tasks
	to wait, and never end the turn to "wait".
	Do not merge with checks pending, skipped, cancelled, or failing. Because this
	prompt does not modify files or run verification, report a failed check as an
	exact resumable blocker. If `main` advances, fetch and merge `origin/main` into
	the publication branch without rebasing or rewriting history, push normally,
	and wait for the required checks again; this ruleset-required integration merge
	is the only permitted additional commit.
10. Merge the pull request with a normal merge commit through the repository
	 ruleset. Never use admin mode or a bypass actor. Delete the merged publication
	 branch, switch to `main`, fetch, fast-forward to `origin/main`, and verify a
	 clean tree with zero ahead/behind counts.
11. Report the content commit hash and final subject, pull-request number, merge
	 result, and synchronized `main` state. If execution stops, report the exact
	 branch, pull request, or check phase so the next invocation can resume it.

Do not amend, rebase, squash, force, reset, discard changes, bypass hooks or the
ruleset, or create additional content commits.
