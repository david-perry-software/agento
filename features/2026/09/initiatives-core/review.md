# Review: initiatives-core

Verdict: approve

Reviewed at `6d0cc41` (branch `feature/initiatives-core`, draft PR #11,
`mergeStateStatus: CLEAN`, `origin/main` `a60c9d2` is an ancestor of HEAD) on
2026-09-05 in worktree `/home/david/DP/agento-worktrees/plan-20260906-004606`.
Skills consulted: none — no matching domain (no `## Agento` skills table in
AGENTS.md, no `.agents/skills/` directory).

## Acceptance checklist results

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Contract file: `applyTo` with `initiatives/**`, optional `initiative:` header, `# brief.md` / `# breakdown.md` sections | **pass** | `grep -c 'initiatives/\*\*\|# brief.md\|# breakdown.md\|^initiative:' .github/instructions/delivery-artifacts.instructions.md` → 5 (≥ 4). `node --test tests/customizations.test.mjs` → 8 pass / 0 fail. Read L3 (`applyTo`), L59–64 (`initiative:` header + validation rule), L104–140 (brief/breakdown sections list every field and section from plan `## Approach`, incl. "No checkboxes"). |
| 2 | Default config root + four mirrors mention `initiatives` | **pass** | `node scripts/agento.mjs config \| grep '"initiatives": "initiatives"'` matches. `grep -l initiatives templates/agento.json templates/project.instructions.md templates/AGENTS-section.md .github/prompts/agento-init.prompt.md` lists all four. Diff of the prompt shows description, JSON snippet, step 3 and step 6 updated. |
| 3 | 3-feature chain: wave-1 `ready`, dependent `blockedBy`, `next` by wave then order; completing the dependency flips the dependent | **pass** | Test `initiative derives state, readiness, waves, and next…` and `initiative picks next by explicit wave…` pass (69/69 suite). Independent re-drive (`/tmp/review-redrive.sh`, temp repo): `alpha`/`beta` `ready`, `gamma.blockedBy == ["beta"]`, `next == "alpha"`; after `beta` `status: complete` (+ `initiative: "suite"`) and `alpha` `in-progress`: `gamma` ready, `next == "gamma"`. |
| 4 | Validation → `invalid` + `errors[]` + exit 3 for unknown slug, cycle, duplicate, missing/mismatched header; missing breakdown → `missing` exit 3 | **pass** | Tests `initiative rejects unknown slugs…`, `…dependency cycles`, `…duplicate feature blocks`, `…initiative header is missing or mismatched`, `…missing breakdown with exit 3` pass. Re-drive: cycle → exit 3 `["dependency cycle among: x, y"]`; unknown+duplicate → exit 3 with three descriptive errors; header absent → `has no initiative: header (expected "suite")`; header `"other"` → `names initiative "other", expected "suite"`; `initiative nope` → exit 3 `status: "missing"`. |
| 5 | Only `status: complete` satisfies `Requires:`; merged-but-`in-review` stays blocking and is an anomaly (Decision 3) | **pass** | Test `initiative flags merged-but-not-complete members without unblocking dependents` passes. Re-drive: `feature/beta` fast-forwarded into the temp `origin/main` with roadmap `in-review` → `gamma.blockedBy == ["beta"]`, `ready: false`, `anomalies == [{slug:"beta",kind:"merged-but-not-complete",branch:"feature/beta"}]`, status still `ok` exit 0. Code: [scripts/agento.mjs](../../../../scripts/agento.mjs#L263) `blockedBy` tests `status !== "complete"` only. |
| 6 | List mode with `total`, `complete`, `inFlight`, `ready`, `done`, `valid` | **pass** | Test `initiative list mode counts progress for every breakdown` passes. Re-drive: empty root → `items: []` exit 0; three breakdowns → three items with the six fields, `valid: false` for the cyclic and unknown-slug ones, `complete: 1` for `suite`. |
| 7 | `status` items carry `initiative` (`null` when absent) | **pass** | `node scripts/agento.mjs status \| grep -c '"initiative"'` → 2 (both real roadmaps → `null`). Re-drive: `[["beta","suite"]]`. Test `initiative header is carried by status items…` passes. |
| 8 | Usage output includes `initiative [<slug>]` | **pass** | `node scripts/agento.mjs bogus \| grep -c 'initiative \[<slug>\]'` → 1; usage array has 16 lines and ends with the `Options:` line (slice widened correctly, nothing truncated). |
| 9 | docs/commands.md, docs/project-profile.md, docs/artifacts.md updated | **pass** | `grep -c initiative` → commands.md 2, project-profile.md 2, artifacts.md 4. Diff shows subcommand + exit-code text, config row, brief/breakdown rows. |
| 10 | Full lint gate, no findings beyond baseline | **pass** | Fresh run: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` exit 0, 69 tests / 69 pass / 0 fail (baseline 59 + 10 `initiative` tests; `grep -c '^test("initiative' scripts/agento.test.mjs` → 10). `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` exit 0, no output (`command -v shellcheck` → `/home/david/.local/bin/shellcheck`; baseline was exit 127/not installed, so this is a strict improvement, no findings). `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0, every fixture matches. |
| 11 | No forbidden files modified | **pass** | `git diff --name-only origin/main...HEAD` (16 files) contains nothing under `scripts/hooks/` or `.github/hooks/` and none of `hooks.json`, `plugin.json`, `package.json`, `CHANGELOG.md`, `README.md`; versions remain `0.2.0` in both manifests. |

Decision 2 check: `git ls-files initiatives/` → empty; `git status --short | grep -c '^?? initiatives/'` → 0. No disposable initiative artifacts are committed or left behind.

## Plan vs implementation

- Delivered as planned: contract, config root, four scaffolding mirrors, `initiative [<slug>]` subcommand (single-slug + list mode), validation, anomaly, tests, reference docs, temp-repo dry run and non-merged rehearsal evidence.
- Minor signature deviations, all harmless: `parseBreakdown(file)` takes a path instead of `content`; `walkRoadmaps` was generalised into `walkFiles(base, name)` with two thin wrappers (an undocumented but behaviour-preserving refactor — existing `find`/`status` tests still pass).
- Additive output fields beyond the plan's interface list: `errors` is always present (empty on `ok`), features carry `roadmap`, `branch`, `computedWave`, `order`; list mode carries `initiativesRoot`. None rename or remove a planned field, so `initiative-workflow` can consume the shape as specified.
- `Wave:` with a non-numeric value parses to `null` silently (re-drive: `Wave: later` → `wave: null`, computed level used instead). Not in the plan's validation list; recorded as a follow-up, not a defect.
- Evidence files are dated `2026-09-06` while the roadmap lines say `2026-09-05` (worktree name suggests a UTC/local midnight boundary). Cosmetic.

## Roadmap audit

All 18 boxes spot-checked against the codebase by re-running each `verify:` command (results above). No falsely ticked boxes; no missing-work steps needed; no `(manual)` or `(manual, post-ship)` steps exist. Step 6.1's recorded gate results (69/69, shellcheck 0, guard 0) match my fresh run; step 6.2's `CLEAN` merge state confirmed via `gh pr view 11`. No repairs made to roadmap.md.

## Findings

1. **minor** — This repository's own [AGENTS.md](../../../../AGENTS.md#L16) still lists the CLI subcommands as `config, resolve, find, status, close-decision, ship-preflight, paths, ports` without `initiative`. The plan scoped README/architecture narrative to `initiative-workflow` but did not mention AGENTS.md; fold the one-word addition into that feature.
2. **minor** — [scripts/agento.mjs](../../../../scripts/agento.mjs#L187-L189) `parseBreakdown` accepts any `Wave:` value and maps non-integers to `null` without an `errors[]` entry, so a typo silently changes `next` ordering. Consider validating in `initiative-workflow` (which will author breakdowns).
3. **informational** — `mergedAnomalies` relies on `git branch -r --merged origin/<default>` and the CLI never fetches; the code comment and plan document this ("reflects the last fetch"). `git()` swallows errors, so a repo without the remote branch simply yields no anomalies. Acceptable for an informational field.
4. **informational** — Security: subprocess calls use `execFileSync` with argument arrays (no shell), all paths are derived from the repo root and config; no user input reaches a shell. No secrets are read or printed.

## Follow-ups

- Add `initiative` to the CLI subcommand list in this repo's AGENTS.md (§ Non-negotiable/layout bullet) — can ride with `initiative-workflow`.
- Emit a validation error for non-numeric `Wave:` values in `parseBreakdown`.
- Guard fixture for the `{ shellcheck …; }` / `cd scripts/hooks && …` denial noted in plan `## Research` (already listed as out of scope there; still unfiled).
