---
description: "Turn a large brief into an initiative: clarify, research, decompose into independently shippable features with dependencies and waves, write brief.md + breakdown.md, and publish them to main through a merged PR from the primary window"
argument-hint: "Brief text, or a repository-relative path to a file containing it"
agent: "🏛️ Agento Architect"
---

Needs: terminal, ask-questions, gh, network
Fallback: ask-questions → §10 standard fallback (numbered questions in chat)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Create a new **initiative** from the brief in the argument, following the Architect's
procedure end to end in the **current (primary) window**.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (an open `changes/initiative-<slug>` PR is resumed from step 7; a
merged one is rejected naming the existing breakdown), which takes precedence over
the slug reservation in step 5. Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for new-initiative` and map
`fail`/`warn` per §10.
Window check per §11: requires role `primary` on the default branch, clean.

1. Apply the window check (`agento.mjs session` → `role: "primary"`, `worktree.branch`
   = `main`; otherwise reject per §11 with the record's alternatives), then require
   the tree clean and synchronized.
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
   `/agento next-feature <slug>`.

This invocation authorizes creating and deleting the `changes/initiative-<slug>`
branch, committing, pushing, opening and merging the pull request, and synchronizing
the default branch. It does not authorize planning any member feature or creating
worktrees. In companion mode (the session record's `companion` is not `null`) all of
that happens in the companion clone at `companion.path` — `git -C <companion.path>`
and `gh … --repo <artifacts.repo.name>` — and the product checkout is not touched.

If the argument is empty, ask for the brief (text or file path) and stop.
