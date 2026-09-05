---
description: "Lite tier: make a small, well-understood change in this window — branch, implement, verify, PR, wait for checks, merge — with no plan, roadmap, review, or second window"
argument-hint: "What to change, in one or two sentences"
agent: "agent"
tools: [read, search, edit, execute, agent]
---

Make the change described in the argument end to end in the **current window** on a
short-lived `changes/<slug>` branch. This is the plan-less tier for work that does
not earn delivery artifacts: typo and doc fixes, a one-file bug with an obvious
cause, a config tweak, a dependency bump, a small test. Same guards, same ruleset,
none of the plan → build → review → two-window choreography. This invocation
authorizes creating and deleting a branch, committing, pushing, opening and merging a
pull request, and synchronizing the default branch.

Read the default branch and freehand prefix from the Agento CLI (`node
<agento-root>/scripts/agento.mjs config` → `branches.default`, `branches.freehand`;
the CLI path is announced in the session context as `Agento CLI:`). `main` below
means the configured default.

## Refuse when the change does not fit

Stop and name the right command instead of proceeding if any of these hold:

- The argument is empty — ask for the change and stop.
- The working tree is dirty with unrelated changes — name `/commit-current-changes`.
- The current branch is a `feature/*` or `issue/*` delivery branch — the work belongs
  to that roadmap; name `/build-feature` or `/build-issue`.
- The change needs a design decision, touches more than a handful of files, adds a
  user-facing feature, changes a schema or public API, or needs manual/browser
  verification — name `/start-session` then `/new-feature` or `/new-issue`.
- You cannot state the exact verification you will run before merging — plan it.

## Steps

1. Require the primary worktree on `main`, clean, and synchronized: `git fetch
   origin` then `git status --short --branch` shows nothing and zero ahead/behind.
   Authentication failures halt per the target repository's AGENTS.md.
2. Derive a kebab-case slug (2-4 words) and `git switch -c changes/<slug>`. If the
   branch already exists locally or on origin, append `-2`, `-3`, ….
3. Read the target repository's AGENTS.md for its test, lint, and typecheck commands
   and load the matching installed skill for the domain touched, per its skills table.
4. Implement the change minimally. Keep unrelated fixes out.
5. **Verify before you commit**: run the project's focused test(s) for the changed
   behavior plus lint and typecheck on the changed files (or the whole project when
   fast). A failing check is a blocker — fix it or revert and report; never commit red.
6. Commit once with a Conventional Commit subject (≤ 72 chars, imperative, no
   trailing period) and a body only if the subject cannot carry the motivation.
7. Push with upstream and open a PR to `main` whose body states what changed, why,
   and the verification you ran.
8. Wait for every required check with `scripts/wait-for-checks.sh pr <n>` in the
   foreground (exit 2 = still pending: rerun; never `--watch`, background terminals,
   or tasks). If `main` advances meanwhile, merge `origin/main` into the branch
   (never rebase), push, and wait again. Failing checks are a resumable blocker —
   report the PR and stop.
9. Merge with a normal merge commit through the ruleset (no `--admin`, no squash,
   no rebase), delete the branch, switch to `main`, fetch, fast-forward, and confirm
   a clean tree with zero ahead/behind.
10. Report the commit hash and subject, the PR number, the verification run, and the
    synchronized `main` state.

Never amend, rebase, force-push, reset, bypass hooks or the ruleset, or create
delivery artifacts. If the change grows beyond the fit criteria mid-way, stop, report
the branch and what is on it, and name `/new-feature` or `/new-issue`.
