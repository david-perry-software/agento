# Review: command-receipts

Verdict: approve

Reviewed 2026-09-14 at `15df7fb` (`feature/command-receipts`, draft PR #16,
`mergeStateStatus: CLEAN`, `origin/main` `e0bbddf` is an ancestor of HEAD, worktree
`plan-20260914-025756` owns the branch). Skills consulted: none — no matching domain
(no `.agents/skills/` directory, no skills table in AGENTS.md). Every command below was
run by the Reviewer in an exit-status-capturing wrapper; no Builder evidence was
trusted without re-running it. No source files were modified by this review.

## Acceptance checklist results

1. **`## 9. Execution receipts` section — pass.**
   `grep -c '^## 9\. Execution receipts' .github/instructions/delivery-policy.instructions.md`
   → `1`; frontmatter `description` ends with "execution receipts with per-command
   idempotency". Read the section: it defines the five lines (`accepted`, `accepted …
   (duplicate of …; resuming)`, `rejected — …; allowed: …`, `completed — …; next: …`,
   `failed — …`), the operation ID `<command>:<subject>:<short-sha>` with the
   slug → session id → branch name → literal `HEAD` fallback chain, the
   `agento.mjs session` `allowed[]`/`elsewhere[]` source for rejections, and an
   idempotency table (15 rows) that names all 22 commands — checked by looping over
   `commands/*.md` basenames against the table: no `NO ROW` output. `sections.size >= 9`
   is asserted in `tests/customizations.test.mjs` L155 and the suite passes.
2. **All 22 prompts and 6 agents cite `§9` — pass.** `for f in .github/prompts/*.prompt.md
   .github/agents/*.agent.md; do grep -q '§9' "$f" || echo MISSING $f; done` → no
   output (22 prompts, 6 agents counted). Negative spot-check performed in a temporary
   `git archive HEAD` copy (worktree untouched): replacing `§9` with `§X` in
   `next-feature.prompt.md` and `copilot-mechanic.agent.md` made
   `node --test tests/customizations.test.mjs` exit 1 with `not ok 6 - every command and
   agent opens and closes with the §9 receipt` listing exactly those two paths (the
   byte-identity test also failed for `next-feature.md`, as expected).
3. **Receipt format words only in the policy file — pass.** Canaries
   `/Receipt: accepted/`, `/Receipt: rejected/`, `/Result: completed/`,
   `/Result: failed/`, `/duplicate of <op-id>/` are present in the single-source test
   (diff L181–185) and the test passes. Independent
   `grep -rlE 'Receipt: accepted|Receipt: rejected|Result: completed|Result: failed|duplicate of <op-id>' .github commands docs AGENTS.md CHANGELOG.md README.md templates`
   returned only `delivery-policy.instructions.md`.
4. **`commands/*.md` byte-identical to prompts — pass.**
   `for f in .github/prompts/*.prompt.md; do cmp -s "$f" "commands/$(basename "$f" .prompt.md).md" || echo DIFF $f; done`
   → no output; 22 prompts / 22 commands; the "plugin manifest and hook wiring" test
   passes in the full run.
5. **Duplicate-handling prose matches the §9 rows — pass.**
   `grep -n 'already exists' .github/prompts/start-*.prompt.md` shows only the
   "reuse it … and say the session already exists and was resumed" wording (L44, L52)
   plus unrelated slug/branch-collision lines (L47, L51); no "stop" rule remains.
   Read the diff of `start-session`, `start-freehand`, `close-session` (new outcome 6:
   already removed → report already closed, still `git branch -d` a merged branch and
   `git worktree prune`), `ship` (`status: complete` → epilogue; merged PR → sync `main`
   only), `quick-fix` (open PR from the same base is resumed; `-2` suffix only when
   merged/closed), `finish-freehand`, `commit-current-changes` (reuse existing
   commit/PR/check phase), `build-*` and `ap` (resume/audit protocol) — each matches its
   table row; no contradictions found.
6. **Docs, AGENTS.md, CHANGELOG mention receipts / §9 — pass.**
   `grep -n -i receipt docs/architecture.md docs/commands.md AGENTS.md CHANGELOG.md` →
   hits at architecture.md L43–44, commands.md L40–44 (`## Receipts`), AGENTS.md L46
   (next-step rule cites §9), CHANGELOG.md L19–20 under `## 0.4.0 (unreleased)` (L3).
7. **Full lint gate matches baseline — pass.**
   `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, `# tests 99`,
   `# pass 99`, `# fail 0` (baseline 98/98; +1 is the step 2.1 enforcement test).
   `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
   `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` → exit 0, 0 lines of
   output. No new findings versus plan.md `## Research`.
8. **No files outside the allowed set — pass.** `git diff --stat origin/main...HEAD` →
   58 files, 690+/51−; `git diff --name-only origin/main...HEAD` filtered against the
   allowed prefixes (`.github/instructions/`, `.github/prompts/`, `.github/agents/`,
   `commands/`, `tests/customizations.test.mjs`, `docs/`, `AGENTS.md`, `CHANGELOG.md`,
   `features/2026/09/command-receipts/`) → empty.

## Plan vs implementation

- Approach items 1–4 are all implemented as written; no undocumented changes. Out-of-scope
  items respected: no edits to `scripts/`, hooks, `plugin.json`, or `package.json`.
- Step 4.1's `verify:` predicted `grep -c '§9'` = 1 per agent; after step 4.2 (next-step
  wording also points at the §9 result line) the counts are planner 2, builder 3,
  reviewer 2, autopilot 4, architect 2, mechanic 3. This is the planned effect of 4.2,
  not a deviation, but the 4.1 verify text was stale when ticked (see Roadmap audit).
- The negative spot-check in acceptance item 2 was defined as a temporary edit + revert;
  performed in a temp copy of HEAD instead so the worktree stayed clean — equivalent
  evidence.

## Roadmap audit

- All 14 boxes spot-checked against the working tree; none falsely ticked. No repairs made.
- 2.1: commit `38d0d3a` body records "Exposing run: exit 1, 28 files listed (22 prompts +
  6 agents)" as the step required.
- 5.3: recorded at `d51f537` (99 tests, all gates exit 0, 58 files); reproduced at
  `15df7fb` with identical numbers.
- 5.4: `git status -sb` shows no ahead/behind; PR #16 is draft, `CLEAN`; `origin/main`
  is an ancestor of HEAD; 16 commits on the branch, all Conventional Commits.
- Minor: 4.1's `verify:` ("prints 1 for each") is superseded by 4.2 — left as-is since
  the tick was true at the time and the final state is asserted by the test suite.

## Findings

- None above minor severity.
- Minor (informational): `grep -n 'already exists' .github/prompts/start-*.prompt.md`
  still matches two unrelated lines (path/branch collision handling); the acceptance
  check's intent — no "stop" rule for a registered worktree — holds.

## Follow-ups

- When `canonical-commands` (Wave 1 sibling) lands, its policy/test edits must keep the
  `## 9.` numbering and the five canaries intact; noted in plan.md `## Risks`, nothing
  to file now.
