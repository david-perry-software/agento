```yaml
status: in-progress
branch: feature/mirrored-artifact-branches
last-updated: 2026-09-16
next-step: "Verify session state cross-repo mirroring from both halves and then update planner/build/reviewer artifact path handling"
initiative: "external-artifact-repo"
```

## Phase 1: Branch and session mirroring

- [x] 1.1 Create the mirrored artifact branch in the companion repo when the planner creates the product feature branch — verify: `git branch --all --list 'feature/mirrored-artifact-branches' 'origin/feature/mirrored-artifact-branches'` shows the branch in both repos after creation.
- [ ] 1.2 Ensure the session state reports the product half and companion half as the same logical delivery, with `repo: product|companion` values and a shared branch name — verify: `node scripts/agento.mjs session` from both worktree halves reports the same `delivery.slug` and `delivery.branch`.
- [ ] 1.3 Add the companion PR metadata to the session result and ensure `session --pr` can report both PRs without re-creating the branch — verify: `node scripts/agento.mjs session --pr` includes the companion PR object when present.

## Phase 2: Planner, Builder, and Reviewer writes

- [ ] 2.1 Teach the planner workflow to write artifact files into the companion worktree and push that branch before opening the companion draft PR — verify: `git -C <companion> status --short` on the mirrored branch includes `plan.md` and `roadmap.md` after the planner commit.
- [ ] 2.2 Ensure the builder/resume path uses the mirrored branch for artifact step commits and evidence while leaving code work in the product branch — verify: `git status --short` in each repo shows the artifact file changes in the companion and code changes in the product.
- [ ] 2.3 Update review and follow-up operations to write `review.md` and triage results to the companion repo and keep the review PR aligned to the code PR — verify: `gh pr view <artifact-pr>` shows the review artifact updates and the linked code PR.

## Phase 3: Ship integration and verification

- [ ] 3.1 Add the companion-side merge gate to `/agento ship` and make the merge order explicit: code PR first, companion PR second — verify: the ship preflight reports both `product` and `companion` PR owners and the roadmap step remains aligned.
- [ ] 3.2 Run the repository verification gate against the feature branch and ensure the mirrored-branch changes are green — verify: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` and `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` exit 0.
- [ ] 3.3 Promote the feature to review and confirm the initiative member reports `state: in-review` with `errors: []` — verify: `node scripts/agento.mjs initiative external-artifact-repo` lists `mirrored-artifact-branches` as `in-review`.
