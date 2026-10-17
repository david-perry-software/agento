---
description: "Lite tier: make a small, well-understood change in this window — branch, implement, verify, PR, wait for checks, merge — with no plan, roadmap, review, or second window"
argument-hint: "What to change, in one or two sentences"
agent: "agent"
tools: [read, search, edit, execute, agent]
---

Needs: terminal, gh, network
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.
Policy: read `<agento-root>/.github/instructions/delivery-policy.instructions.md` once before the first step unless it is already in context; `<agento-root>` comes from the session context line `Agento CLI: node <agento-root>/scripts/agento.mjs`.

Make the change described in the argument end to end in the **current window** on a
short-lived `changes/<slug>` branch. This is the plan-less tier for work that does
not earn delivery artifacts: typo and doc fixes, a one-file bug with an obvious
cause, a config tweak, a dependency bump, a small test. Same guards, same ruleset,
none of the plan → build → review → two-window choreography. This invocation
authorizes creating and deleting a branch, committing, pushing, opening and merging a
pull request, and synchronizing the default branch.

Read the default branch and freehand prefix from the preflight call's `config`
section (`config.branches.default`, `config.branches.freehand`). `main` below
means the configured default.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (an open PR on `changes/<slug>` from the same base is resumed at
its current step; see step 2 for the suffix rule). Open with one
`node <agento-root>/scripts/agento.mjs preflight quick-fix` call (§9–§11; the CLI
path is announced in the session context as `Agento CLI:`): print its `receipt` and
then its `preflightLines` verbatim, and stop on `status: rejected` (exit 3), writing
nothing.
Window check per §11: requires role `primary` on the default branch, clean.

## Refuse when the change does not fit

Stop and name the right command instead of proceeding if any of these hold; the
named command is emitted as its own block per policy §12 (one block per command):

- The argument is empty — ask for the change and stop.
- The working tree is dirty with unrelated changes — name `/agento commit-current-changes`.
- The current branch is a `feature/*` or `issue/*` delivery branch — the work belongs
  to that roadmap; name `/agento build-feature` or `/agento build-issue`.
- The change needs a design decision, touches more than a handful of files, adds a
  user-facing feature, changes a schema or public API, or needs manual/browser
  verification — name `/agento start-session` then `/agento new-feature` or `/agento new-issue`.
- You cannot state the exact verification you will run before merging — plan it.

## Steps

1. The preflight's `window` verdict applies the window check: `role: "primary"` with
   `worktree.branch` equal to `main` and a clean checkout, otherwise it rejects per §11
   with the record's alternatives. Then require clean and synchronized: `git fetch
   origin` then `git status --short --branch` shows nothing and zero ahead/behind.
   Authentication failures halt per the target repository's AGENTS.md.
2. Derive a kebab-case slug (2-4 words) and `git switch -c changes/<slug>`. If the
   branch already exists locally or on origin with an open PR from the same base,
   that is the §9 duplicate — switch to it and resume; append `-2`, `-3`, … only
   when that branch's PR is merged or closed.
3. Read the target repository's AGENTS.md for its test, lint, and typecheck commands
   and load the matching installed skill for the domain touched, per its skills table.
4. Implement the change minimally. Keep unrelated fixes out.
5. **Verify before you commit**: run the project's focused test(s) for the changed
   behavior plus lint and typecheck on the changed files (or the whole project when
   fast). A failing check is a blocker — fix it or revert and report; never commit red.
6. Commit once with a Conventional Commit subject (≤ 72 chars, imperative, no
   trailing period) and a body only if the subject cannot carry the motivation.
7. Publish with one `node <agento-root>/scripts/agento.mjs publish-pr --title
   "<subject>" --body-file - --merge` call whose body, on stdin, states what changed,
   why, and the verification you ran. It pushes with upstream, opens or reuses the PR
   to `main`, waits for every required check within its bounded budget, merges
   `origin/main` into the branch when it falls behind (never a rebase), and merges
   with a normal merge commit through the ruleset (no `--admin`, no squash, no
   rebase).
8. Exit 2 (`status: pending`) means checks are still running: re-send the identical
   call from its `next[]` (never `--watch`, background terminals, or tasks). Exit 3
   stops: failing checks (`checks-failed`) are a resumable blocker — report the PR
   and stop; otherwise report `message` and `reauth`.
9. After the merge the call deletes the branch, switches to `main`, fetches, and
   fast-forwards; confirm from its `sync` a clean tree with zero ahead/behind.
10. Report the commit hash and subject, the PR number, the verification run, and the
    synchronized `main` state.

Never amend, rebase, force-push, reset, bypass hooks or the ruleset, or create
delivery artifacts. If the change grows beyond the fit criteria mid-way, stop, report
the branch and what is on it, and name `/agento new-feature` or `/agento new-issue`.
