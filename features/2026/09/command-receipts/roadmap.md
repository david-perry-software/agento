```yaml
status: in-progress
branch: feature/command-receipts
last-updated: 2026-09-14
next-step: "5.1 docs/architecture.md, docs/commands.md, AGENTS.md receipts wording"
initiative: "workflow-orchestration"
```

## Phase 1: Policy section

- [x] 1.1 Append `## 9. Execution receipts` to `.github/instructions/delivery-policy.instructions.md` per plan.md `## Approach` item 1 (receipt and result line formats, duplicate line, rejection alternatives from the session record's `allowed[]`/`elsewhere[]`, operation ID rule with branch-name / session-id / `HEAD` fallback, idempotency table with one row per command) and add "execution receipts" to the frontmatter `description` — verify: `grep -c '^## 9\. Execution receipts' .github/instructions/delivery-policy.instructions.md` prints 1; `node --test tests/customizations.test.mjs` exit 0
- [x] 1.2 Bump `sections.size >= 8` to `>= 9` in `tests/customizations.test.mjs` "policy section references" and add the canaries `/Receipt: accepted/`, `/Receipt: rejected/`, `/Result: completed/`, `/Result: failed/`, `/duplicate of <op-id>/` to the single-source test — verify: `node --test tests/customizations.test.mjs` exit 0 (no prompt or agent restates the format yet)

## Phase 2: Enforcement test

- [x] 2.1 Add test "every command and agent opens and closes with the §9 receipt" to `tests/customizations.test.mjs`: for every file in `promptFiles` and `agentFiles`, `splitFrontmatter(file).body` must match `/§9\b/`, failing with the relative path — verify: `node --test tests/customizations.test.mjs` exit 1 and the failure lists all 22 prompts and 6 agents (record the count in the commit message)

## Phase 3: Prompt citations

- [x] 3.1 Add the one-sentence §9 citation (open with the acceptance receipt, close with the terminal result, apply this command's §9 idempotency row on a duplicate; no format words) to the 12 prompts that have no duplicate-handling prose today: `agento-init`, `delivery-status`, `extend-copilot`, `fix-copilot`, `install-skills`, `new-feature`, `new-initiative`, `new-issue`, `next-feature`, `review-feature`, `review-issue`, `triage-followups` (`.github/prompts/*.prompt.md`) and mirror each into `commands/<name>.md` — verify: `node --test tests/customizations.test.mjs` failure list shrinks to 10 prompts + 6 agents; byte-identity assertion passes
- [x] 3.2 In `start-session.prompt.md` (L46–48, L68–73) and `start-freehand.prompt.md` (L38–40) replace the "registered without `--resume`: stop and report the session already exists" rule with the §9 duplicate rule (a registered worktree for the same subject is a duplicate submission and is resumed with `--resume` semantics — HEAD, branch, and files untouched) and add the §9 citation; mirror into `commands/` — verify: `grep -n 'already exists' .github/prompts/start-session.prompt.md .github/prompts/start-freehand.prompt.md` shows no "stop" wording; `node --test tests/customizations.test.mjs` byte-identity passes
- [x] 3.3 In `close-session.prompt.md` add the "worktree already removed → report already closed, still delete a merged local branch and prune" outcome and the §9 citation; in `ship.prompt.md` (L19–20, L28, L97–98) defer the `status: complete` → epilogue and merged-PR resume wording to §9 and add the citation; mirror into `commands/` — verify: `grep -n '§9' .github/prompts/close-session.prompt.md .github/prompts/ship.prompt.md` shows one hit each; byte-identity passes
- [x] 3.4 In `build-feature.prompt.md`, `build-issue.prompt.md`, `ap.prompt.md`, `quick-fix.prompt.md` (L40 `-2` suffix rule → applies only when the existing `changes/<slug>` PR is merged or closed; an open PR from the same base is resumed), `finish-freehand.prompt.md`, `commit-current-changes.prompt.md`, `start-freehand.prompt.md` if not done in 3.2 — add the §9 citation and reword existing duplicate prose to defer to the §9 row; mirror into `commands/` — verify: `node --test tests/customizations.test.mjs` failure list contains only the 6 agents
- [x] 3.5 Confirm no prompt restates a receipt format word and all 22 `commands/*.md` equal their prompts — verify: `for f in .github/prompts/*.prompt.md; do cmp -s "$f" "commands/$(basename "$f" .prompt.md).md" || echo "DIFF $f"; done` prints nothing; the canary test passes

## Phase 4: Agent citations

- [x] 4.1 Add the §9 citation to `delivery-planner.agent.md` (resume protocol on an existing roadmap is the new-feature/new-issue idempotency row), `delivery-builder.agent.md` (resume/audit protocol is the build-* row), `delivery-reviewer.agent.md` (verdict overwrite is the review-* row) — verify: `grep -c '§9' .github/agents/delivery-planner.agent.md .github/agents/delivery-builder.agent.md .github/agents/delivery-reviewer.agent.md` prints 1 for each
- [x] 4.2 Add the §9 citation to `delivery-autopilot.agent.md`, `initiative-architect.agent.md`, `copilot-mechanic.agent.md` and make every agent's "final response ends with a next step" wording point at the §9 result line — verify: `node --test tests/customizations.test.mjs` exit 0 (all 28 files cite §9; canaries clean)

## Phase 5: Docs, changelog, gate

- [ ] 5.1 Update `docs/architecture.md` policy summary (L39–44) to list execution receipts and idempotency; add a short "Receipts" paragraph to `docs/commands.md` pointing at policy §9; make the AGENTS.md "concrete suggested next step" rule cite §9 — verify: `grep -n -i 'receipt' docs/architecture.md docs/commands.md AGENTS.md` has ≥ 1 hit per file; `node --test tests/customizations.test.mjs` exit 0 (bare-command scan still clean)
- [ ] 5.2 Add a `## 0.4.0 (unreleased)` CHANGELOG.md entry for execution receipts and per-command idempotency (deterministic operation IDs, session-record alternatives, the start-session/start-freehand duplicate-resumes change, the close-session already-closed outcome, the quick-fix suffix rule) — verify: `grep -n -i 'receipt' CHANGELOG.md` has a hit under `## 0.4.0 (unreleased)`
- [ ] 5.3 Full lint gate against the plan.md baseline: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` exit 0 with ≥ 99 passing; `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0; `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` exit 0; `git diff --stat origin/main...HEAD` lists only the files named in plan.md's last acceptance item — verify: all three exit 0 recorded here with the test count, and the diff stat contains no unexpected paths
- [ ] 5.4 Merge `origin/main` into `feature/command-receipts`, push, set `status: in-review` — verify: `git status -sb` shows no `ahead`/`behind`; `gh pr view --json isDraft,mergeStateStatus` shows the draft PR without `CONFLICTING`
