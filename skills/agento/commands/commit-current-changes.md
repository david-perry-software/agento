---
description: "Review all current repository changes, create one accurate commit, and publish it through a protected pull request without running local verification"
argument-hint: "Optional context, intent, or issue reference"
model: "Claude Opus 5.5 (copilot)"
agent: "agent"
---

Needs: terminal, gh, network
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.
Policy: read `<agento-root>/.github/instructions/delivery-policy.instructions.md` once before the first step unless it is already in context; `<agento-root>` comes from the session context line `Agento CLI: node <agento-root>/scripts/agento.mjs`.

Review the current Git changes in this repository, commit them with the best
possible commit message, and publish that commit through the protected pull-request
workflow. This invocation explicitly authorizes creating and deleting a branch,
committing, pushing, opening and merging a pull request, and synchronizing `main`.
Treat any provided argument as supplemental context, but ground the message in the
actual diff.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this command's §9
idempotency row (the existing commit, pull request, or check-wait phase is reused —
step 1 recovers it from repository state). Open with one `node
<agento-root>/scripts/agento.mjs preflight commit-current-changes` call (§9–§11):
print its `receipt` and then its `preflightLines` verbatim, and stop on `status:
rejected` (exit 3), writing nothing.
Window check per §11: requires role `primary` on a non-default branch.

1. The preflight's `window` verdict applies the window check: its `session` must
	report `role: "primary"` with `worktree.branch` different from the configured
	default branch (a stray primary-window change). A `plan`, `build`, or `freehand`
	role is rejected per §11 with the record's alternatives — they already name the
	handoff or `/agento finish-freehand` for that worktree; never hand-maintain that
	list. Then inspect `git status --short`, the current branch and its
	upstream/ahead-behind state, staged and unstaged diffs, untracked files, any pull
	request for the current branch, and a small sample of recent commit subjects.
	Recover an existing publication branch or pull request when repository state
	proves this prompt was interrupted, per the §9 row — never a second commit or
	pull request for the same changes.
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
	makes no unsupported claims. Run `git commit` non-interactively.
9. Publish with one `node <agento-root>/scripts/agento.mjs publish-pr --title
	"<subject>" --body-file - --merge` call, the pull-request body on stdin. It
	pushes the publication branch without force, opens or reuses the pull request to
	`main`, waits for every required check within its bounded budget, merges
	`origin/main` into the branch when GitHub reports it behind (never a rebase; this
	ruleset-required integration merge is the only permitted additional commit),
	merges with a normal merge commit through the ruleset (never admin mode or a
	bypass actor), deletes the merged branch, switches to `main`, and fast-forwards.
	Exit 2 (`status: pending`) means checks are still running: re-send the identical
	call from its `next[]`. Never use `--watch` commands, background terminals, or
	tasks to wait, and never end the turn to "wait". Exit 3 stops with `message` (and
	`reauth` on an authentication failure); because this prompt does not modify files
	or run verification, report a failed check (`checks-failed`) as an exact
	resumable blocker.
10. Confirm from the call's `sync` and `git status --short --branch` a clean `main`
	 with zero ahead/behind counts.
11. Report the content commit hash and final subject, pull-request number, merge
	 result, and synchronized `main` state. If execution stops, report the exact
	 branch, pull request, or check phase so the next invocation can resume it.

Do not amend, rebase, squash, force, reset, discard changes, bypass hooks or the
ruleset, or create additional content commits.
