---
description: "Verify and document an issue with evidence, file a GitHub issue, and plan the fix around an exposing regression test"
argument-hint: "Describe the issue or bug"
agent: "📋 Agento Planner"
---

Plan a new **issue** (bug or defect) from the argument. This invocation authorizes
creating one GitHub issue with `gh issue create` (unless importing an existing one).

The argument takes three forms — detect which applies:
- **Free text**: a new defect description; you will file the GitHub issue in step 6.
- **GitHub issue** (`#<n>` or issue URL): import it — `gh issue view <n>` supplies the
  starting description; do NOT create a duplicate, link the existing number instead.
- **Sentry issue** (ID or sentry.io URL), only if the project uses Sentry and has the
  sentry-cli skill installed: use that skill to pull the stack trace, event frequency,
  affected releases, and a sample event into `## Evidence`, then continue as free text
  (a GitHub issue is still filed, linking the Sentry issue).

1. Require a managed isolated planning worktree per the Planner's isolation protocol.
2. Ask your clarifying questions first (include reproduction steps and observed vs
   expected behavior); retain answers verbatim for plan.md `## Decisions` without
   writing files yet.
3. Research the codebase (Explore subagent) to locate the defect and load every
   matching installed skill for the domains the work touches, per the project's
   skills table (its AGENTS.md `## Agento` section) and the skills-first policy
   (`.agents/skills/`). Retain a root-cause hypothesis with file
   evidence for `## Research` without writing files yet. Run and record the
   full-repository lint baseline, assess overlap, and encode cleanup or the complete
   scoped gate required by the delivery artifact contract.
4. Derive the slug and reject it unless `node <agento-root>/scripts/agento.mjs find
   <slug>` (CLI path in the session context line `Agento CLI:`) returns
   `status: missing` and neither `issue/<slug>` nor `origin/issue/<slug>` exists, then
   create `issue/<slug>` from the planning worktree's detached `origin/main` HEAD.
5. **Verify the issue before planning.** Reproduce it: run the relevant commands or
   tests, capture exact error output/logs, and for UI-visible defects capture
   screenshots (playwright-cli skill / browser tools). Store binary evidence in the
   issue's dated `evidence/` directory and document everything in plan.md `## Evidence`.
   If you cannot reproduce it, report what you tried and ask the user — do not plan
   an unverified fix.
6. **File or link the GitHub issue**: for free-text and Sentry intake, `gh issue
   create` titled after the slug, with the verified reproduction, observed vs expected
   behavior, evidence, root-cause hypothesis, and Sentry link when applicable. For
   imported issues, reuse the existing number. Record it as `GitHub issue: #<n>` in
   plan.md `## Evidence` and `github-issue` in the roadmap header.
7. Create `issues/<current-YYYY>/<current-MM>/<slug>/plan.md` and `roadmap.md` per the
   delivery artifact format, with branch `issue/<slug>`. The roadmap MUST include an early step
   that adds a regression test exposing the defect and verifies it FAILS, and the
   acceptance checklist's first item MUST require that test to pass. The test's name
   or header comment must reference the GitHub issue number and slug so future readers
   can trace it back to the evidence.
8. Commit the artifacts (including evidence/), push with upstream, and open a draft PR
   to `main` whose body starts
   with `Fixes #<n>` so the merge closes the issue.
9. Report slug, branch, GitHub issue number, PR number, and roadmap step count. Offer
   **Build in this worktree** to hand off directly to the Builder without closing,
   reopening, or reinstalling dependencies. Explain that the promoted session is later
   closed from the primary window with `/close-session issue/<slug>`.

If the argument is empty, ask for an issue description and stop.
