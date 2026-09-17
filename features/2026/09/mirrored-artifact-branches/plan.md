# Mirrored artifact branches: companion delivery work follows the code branch in both repos

## Problem

The initiative [external-artifact-repo](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md) solves the external artifact repo layout, but the delivery flow still writes roadmap and review artifacts only to the product repo branch. In companion mode the product and companion repositories each carry a matching delivery branch, and the code PR plus the companion artifact PR now need to remain in lockstep so a resumed build or a review can read the right roadmap/decision state.

This feature is the wave-3 member `mirrored-artifact-branches` of initiative `external-artifact-repo` ([breakdown.md](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md), block `### mirrored-artifact-branches`). It makes the planner, builder, reviewer, architect, and follow-up triage commands commit and push on the companion worktree's mirrored branch while keeping the product branch as the authoritative code branch. The artifact repo tracks the same branch name and an adjacent draft PR, and `/agento ship` later merges both branches in order.

## Decisions

- **Q1 — Which repo is the source of truth for roadmap state during a delivery?** A: the product repo remains the source of code and branch ownership; the companion repo mirrors the same branch name and carries the artifact files, plan.md, roadmap.md, review.md, evidence, and initiative docs. `resolve`/`find`/`session` read both repos but the product branch still owns the delivery lifecycle.
- **Q2 — Should the companion worktree be promoted only when the product branch already exists, or immediately when the feature is created?** A: the planner creates both worktrees from the same branch name at the time the feature is created; if the companion has no `origin/feature/<slug>`, it creates it from the companion default branch and then pushes it. This keeps the founding artifact branch and the code branch synchronized before any work begins.
- **Q3 — How do we handle the companion branch in plan mode during the initial planner setup?** A: the planner creates the companion worktree detached at the companion's default `origin/<default>` branch, then promotes it onto `feature/<slug>` as part of this feature. The session record reports that promotion accurately while the feature remains in the planning phase.
- **Q4 — What branch state do we preserve across resume and review?** A: the product branch and companion branch both retain the same branch name and PR relationship; `session --pr` reports both PRs when they exist, and a workflow resumes from whichever side is active without re-creating either branch or PR.

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/` directory and AGENTS.md has no `## Agento` skills table).

### Lint baseline (policy §5)

Run from the planning worktree at `origin/main` `a6d2903`:

- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0; `# tests 185`, `# pass 185`, `# fail 0`
- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0; no output
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0
- `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh < tests/guard-fixtures-companion.txt` → exit 0

Full green baseline → no overlap decision, no scoped gate: full-repository gate remains in force for this feature.

### Codebase findings

- The CLI already resolves external artifact roots in [scripts/agento-config.mjs](../../../../scripts/agento-config.mjs) and [scripts/agento.mjs](../../../../scripts/agento.mjs), and the pair of product/companion sessions is already modeled in [scripts/session-state.mjs](../../../../scripts/session-state.mjs).
- The initiative member block for `mirrored-artifact-branches` is defined in [initiatives/2026/09/external-artifact-repo/breakdown.md](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md).
- The planner workflow already creates feature branches and roadmap files in the product repo; the change here is to mirror those artifact writes into the companion repo, add the companion draft PR, and make the promotion logic explicit.
- The command files and prompt mirror are already verified by the existing customizations suite, so the behavioral change is primarily the planner/builder/reviewer prompt semantics plus the mirrored branch operations.

## Approach

The feature is implemented by keeping the product branch as the delivery branch for code while promoting the artifact repo to the same branch name in the companion repo and ensuring the companion PR is opened and kept in sync with the product PR.

1. Adjust the planner creation flow so that when a new feature is created in companion mode, the product branch is created and then the companion branch is created from the same name, mirroring the code branch.
2. Teach the artifact-writing commands to prefer the companion worktree for `plan.md`, `roadmap.md`, `review.md`, and evidence while preserving the product worktree for code edits.
3. Keep the companion PR metadata alongside the product PR in the session record and allow `session --pr` to report both PRs without duplicating the same branch state.
4. Ensure the roadmap header and initiative reporting still treat the feature as a single delivery with a single slug while reading the companion repo for artifact data.
5. Verify the mirrored branch behaviour by creating and inspecting a real feature pair with this repository's existing command flow.

## Risks

- **Companion branch drift.** If the product and companion branches are not promoted together, the roadmap and PR can diverge from the code branch. Mitigation: create both branches from the same name and reject a companion branch that is missing or unpushed before resume.
- **Review mismatch.** Reviewers may read old artifact state if the companion branch is not current. Mitigation: all writes and PR checks operate against the mirrored branch, and `session --pr` reads both PRs for the pair.
- **Shipping complexity.** The companion PR must be merged after the code PR and before teardown. Mitigation: keep the validation and merge ordering documented in the roadmap and ship flow rather than silently skipping it.

## Out of scope

- A full repository history migration of every old artifact branch.
- Reworking the in-repo layout after the external-artifact-repo initiative lands.
- Shipping release logic beyond the mirrored artifact branch and companion PR model.

## Acceptance checklist

- [ ] The previously ready initiative member `mirrored-artifact-branches` has a concrete plan and roadmap written under `features/2026/09/mirrored-artifact-branches/`.
- [ ] The feature branch `feature/mirrored-artifact-branches` is created from `origin/main` and tracked for the new delivery.
- [ ] The planner creates and promotes a companion branch with the same branch name when `artifacts.repo` is configured.
- [ ] The CLI/session logic explains when the companion branch is mirrored versus detached at the default branch.
- [ ] The related roadmap steps are small, testable, and verifyable by direct command output.
- [ ] `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` exits 0 after the change.
- [ ] `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` exits 0.

## Resolution

This feature is the initial planning record for the mirrored-branch work. It keeps the initiative goal, decisions, research, and acceptance steps explicit while the implementation work will follow in the roadmap and subsequent build/review cycle.
