---
description: "Research and plan a new feature with dated delivery artifacts, a pushed branch, and a draft PR"
argument-hint: "Describe the feature"
agent: "📋 Agento Planner"
---

Plan a new **feature** from the description in the argument.

1. Require a managed isolated planning worktree per the Planner's isolation protocol.
2. Ask your clarifying questions first; retain answers verbatim for plan.md
   `## Decisions` without writing files yet.
3. Research the codebase (Explore subagent) and load every matching installed skill
   for the domains the work touches, per the project's skills table (its AGENTS.md
   `## Agento` section) and the skills-first policy (`.agents/skills/`), before
   writing anything. Run and record the full-repository lint baseline, assess
   overlap, and encode cleanup or the complete scoped gate required by the delivery
   artifact contract.
4. Reject a slug already in use: `node <agento-root>/scripts/agento.mjs find <slug>`
   (CLI path in the session context line `Agento CLI:`) must return `status: missing`,
   and neither `feature/<slug>` nor `origin/feature/<slug>` may exist. Create
   `feature/<slug>` from the planning worktree's detached `origin/main` HEAD before
   writing artifacts. Create
   `features/<current-YYYY>/<current-MM>/<slug>/plan.md` and `roadmap.md` per the
   delivery artifact format, with branch `feature/<slug>` in the roadmap header.
5. Commit the two artifacts, push with upstream, and open a draft PR to `main`.
6. Report slug, branch, PR number, and roadmap step count. Offer **Build in this
   worktree** to hand off directly to the Builder without closing, reopening, or
   reinstalling dependencies. Explain that the promoted session is later closed from
   the primary window with `/close-session feature/<slug>`.

If the argument is empty, ask for a feature description and stop.
