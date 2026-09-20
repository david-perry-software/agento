---
description: "Verify and document an issue with evidence, file a GitHub issue, and plan the fix around an exposing regression test"
argument-hint: "Describe the issue or bug"
agent: "📋 Agento Planner"
---

Needs: terminal, ask-questions, gh, network
Fallback: ask-questions → §10 standard fallback (numbered questions in chat)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Plan a new **issue** (bug or defect) from the argument. This invocation authorizes
creating one GitHub issue with `gh issue create` (unless importing an existing one).

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (a slug that already has a roadmap enters your resume protocol — no
second branch, worktree, or PR; an existing GitHub issue is linked, not duplicated).
Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for new-issue` and map
`fail`/`warn` per §10.
Window check per §11: requires role `plan` — or `build` when resuming this slug's promoted planning worktree.

The argument takes three forms — detect which applies:
- **Free text**: a new defect description; you will file the GitHub issue in step 6.
- **GitHub issue** (`#<n>` or issue URL): import it — `gh issue view <n>` supplies the
  starting description; do NOT create a duplicate, link the existing number instead.
- **Sentry issue** (ID or sentry.io URL), only if the project uses Sentry and has the
  sentry-cli skill installed: use that skill to pull the stack trace, event frequency,
  affected releases, and a sample event into `## Evidence`, then continue as free text
  (a GitHub issue is still filed, linking the Sentry issue).

1. Require a managed isolated planning worktree per the Planner's isolation protocol
   (the session record's `worktree.isManaged` with `dirPrefix: "plan"`).
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
   create `issue/<slug>` from the planning worktree's detached `origin/main` HEAD; in
   companion mode also promote the companion half onto the same name — `git -C
   <companion.path> switch -c issue/<slug>` from its detached `origin/<default>` HEAD,
   after the Planner's step 5 checks that the branch exists nowhere in the companion.
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
   delivery artifact format, with branch `issue/<slug>`, under the `artifactRoot` of
   `node <agento-root>/scripts/agento.mjs paths issue <slug>` (the companion half in
   companion mode, the product checkout in-repo; `evidence/` from step 5 lives there
   too). The roadmap MUST include an early step
   that adds a regression test exposing the defect and verifies it FAILS, and the
   acceptance checklist's first item MUST require that test to pass. The test's name
   or header comment must reference the GitHub issue number and slug so future readers
   can trace it back to the evidence.
8. Commit the artifacts (including evidence/), push with upstream, and open a draft PR
   to `main` whose body starts
   with `Fixes #<n>` so the merge closes the issue. In companion mode follow the
   Planner's step 8 order: commit and push the artifacts in the companion half (`git
   -C <companion.path>`), publish the product branch with one empty Conventional
   Commit and open the draft code PR (body starting with `Fixes #<n>`), open the
   **draft** companion PR titled `docs(<type>): <slug>` whose body links the code PR,
   append the companion PR URL to the code PR body via the REST PATCH endpoint in an
   idempotent check (only when the URL is absent), then record `artifact-pr: "#<n>"`
   in the roadmap header and push that second companion commit.

   Example idempotent cross-link:
   `current_body=$(gh pr view <code PR> --json body --jq '.body'); if ! printf '%s' "$current_body" | grep -Fq "<companion PR URL>"; then gh api repos/<owner>/<repo>/pulls/<code PR> -X PATCH -f body="${current_body}$'\n\nCompanion PR: <companion PR URL>"; fi`
9. Report slug, branch, GitHub issue number, PR number (and the companion PR number in
   companion mode), and roadmap step count. Offer
   **Build in this worktree** to hand off directly to the Builder without closing,
   reopening, or reinstalling dependencies, with the `/agento build-issue <slug>`
   alternative emitted as its own block per policy §12, followed by `/agento ap <slug>`
   in its own block as the unattended alternative. Explain that the promoted
   session is later torn down by `/agento ship <slug>` from the primary window once
   the PR is merged (`/agento close-session issue/<slug>` only to abandon it).

If the argument is empty, ask for an issue description and stop.
