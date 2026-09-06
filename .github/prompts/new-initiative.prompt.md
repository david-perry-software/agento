---
description: "Turn a large brief into an initiative: clarify, research, decompose into independently shippable features with dependencies and waves, write brief.md + breakdown.md, and publish them to main through a merged PR from the primary window"
argument-hint: "Brief text, or a repository-relative path to a file containing it"
agent: "🏛️ Agento Architect"
---

Create a new **initiative** from the brief in the argument, following the Architect's
procedure end to end in the **current (primary) window**.

1. Require the primary worktree on `main`, clean, and synchronized.
2. Read the brief: inline text, or a repository-relative path to an existing file.
   Record the original argument or path in `brief.md`'s `Source:` line and preserve
   the text verbatim.
3. Ask your clarifying questions first; retain the answers verbatim for
   `breakdown.md ## Decisions` without writing files yet.
4. Research with the Explore subagent and load every matching installed skill.
5. Reserve the slug (`agento.mjs initiative <slug>` → `status: missing`, no existing
   initiative directory, no `changes/initiative-<slug>` branch locally or on origin)
   and `git switch -c changes/initiative-<slug>`.
6. Decompose into 2–8 member features whose slugs are free (`agento.mjs find
   <feature-slug>` → `status: missing`); write `brief.md` and `breakdown.md` per the
   artifact contract, with no checkboxes.
7. Validate with `agento.mjs initiative <slug>` → `status: ok`, every member
   `unplanned`, `next` as intended.
8. Commit, push with upstream, open a PR to `main`, wait for required checks with the
   bounded poller, merge through the ruleset, delete the branch, and return to a
   synchronized `main`.
9. Report the slug, PR number, features by wave, `next`, and the follow-up
   `/next-feature <slug>`.

This invocation authorizes creating and deleting the `changes/initiative-<slug>`
branch, committing, pushing, opening and merging the pull request, and synchronizing
the default branch. It does not authorize planning any member feature or creating
worktrees.

If the argument is empty, ask for the brief (text or file path) and stop.
