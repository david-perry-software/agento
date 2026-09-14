# Review: capability-preflight

Verdict: approve

Reviewed 2026-09-14 at `f78e9b6` (`feature/capability-preflight`, draft PR #18,
`mergeStateStatus: CLEAN`, `origin/main` `3d2bac3` is an ancestor of HEAD). Diff
`origin/main...HEAD`: 65 files, +1274/−68. Skills consulted: none — no matching
domain (no `.agents/skills/`, no `## Agento` skills table in AGENTS.md). Every
command below was run by the Reviewer in this worktree; nothing is taken from the
Builder's notes.

## Acceptance checklist results

1. **`agento.mjs doctor` prints six checks with status/detail/fallback, worst-status
   roll-up, exit 0/3 — pass.** `node scripts/agento.mjs doctor` → `status: ok`,
   `for: null`, checks `node git-remote gh code python3 worktrees-dir` all `ok`,
   exit 0. `scripts/agento.test.mjs` L194–306 covers all-ok, gh missing (exit 3,
   "install GitHub CLI"), gh unauthenticated (exit 3, "`gh auth login`"), code
   missing (warn), python3 missing (warn), no origin (fail, exit 3), unreachable
   origin (warn, exit 0) in `restrictedPath()` temp repos; `grep -c '^test("doctor'`
   → 5. Suite passes (see item 9).
2. **`doctor --for` filters checks, reports needs, rejects unknown names — pass.**
   `--for close-session` → `node python3 worktrees-dir`; `--for ship` → `node
   git-remote gh python3 worktrees-dir`; `--for nope` → exit 1 (`usage-error`);
   `node scripts/agento.mjs bogus | grep -c 'doctor \[--for'` → 1. Marker-file test
   proves the `gh` stub is never invoked for a terminal-only command
   (`scripts/agento.test.mjs` L283–306).
3. **Policy §9 preflight receipt + `Preflight:` line + `/agento doctor` idempotency
   row; new §10; §1 points at `doctor` — pass.**
   `delivery-policy.instructions.md` L29–33 (§1 rewritten: `doctor --for` first,
   `command -v` only for uncovered CLIs), L173–177 (rejection form), L179–184
   (`Preflight:` line), L229 (idempotency row), L232–291 (`## 10. Capability
   preflight`: vocabulary, hard/soft, standard fallbacks, declaration contract, when
   `doctor` runs). `grep -c '^## 10\. Capability preflight'` → 1;
   `tests/customizations.test.mjs` L157 asserts `sections.size >= 10` and passes.
4. **All 23 prompts and 6 agents open with `Needs:`/`Fallback:` from the §10
   vocabulary — pass.** `grep -L '^Needs: ' .github/prompts/*.prompt.md
   .github/agents/*.agent.md` → empty (23 + 6 files). Negative check: removed the
   `Fallback:` line from `ship.prompt.md` → `node --test tests/customizations.test.mjs`
   fails tests 7, 8, 9, 15 (11 pass / 4 fail); restored, `git status --short | wc -l`
   → 0.
5. **Exactly the gh/code/network prompts run `doctor --for <own-name>`; CLI table
   agrees with every `Needs:` line — pass.** Tests "exactly the commands that need
   gh, code, or network run doctor --for themselves" and "the CLI needs table agrees
   with every prompt's Needs: line" pass (`tests/customizations.test.mjs` L210–235);
   `COMMAND_NEEDS` in `scripts/agento.mjs` L273–297 has 23 entries.
6. **Ask-questions / `code` / `askQuestions` references defer to §10 — pass.**
   `grep -n 'askQuestions\|ask-questions tool\|`code` CLI is unavailable'` over
   prompts and agents returns seven hits, all reading "or its declared fallback
   (§10)" / "apply the declared `code` fallback (§10)"; no `vscode/askQuestions`
   remains. Canary test ("the policy file is the only place …") passes with the new
   `/^Preflight: /m`, `/; fallback: </`, `/switch to Agent mode/` canaries.
7. **`/agento doctor` command exists, is read-only, is listed everywhere — pass.**
   `.github/prompts/doctor.prompt.md` (`Needs: terminal`, "reports and never
   repairs", `tools: [read, execute]`) is byte-identical to `commands/doctor.md`
   (`cmp` over all 23 pairs → no drift; `diff <(ls commands) <(ls .github/prompts |
   sed …)` → empty). Listed in `command-invocation.instructions.md` L14, `README.md`
   command reference, `docs/commands.md` table + `## Invocation`,
   `templates/AGENTS-section.md` L6, and `agento-init.prompt.md` L63. Tests "every
   slash command is documented…", "command-invocation … list every command", and
   "plugin manifest …" pass.
8. **Docs mention `doctor` / capability preflight — pass.** `grep -c doctor`:
   `docs/commands.md` 6 (CLI paragraph with exit codes + new `## Preflight`
   section), `README.md` 1, `AGENTS.md` 1 (L17 scripts bullet),
   `docs/architecture.md` 1 (L47), `CHANGELOG.md` 3 (`## 0.4.0 (unreleased)` entry,
   L5–13).
9. **Full lint gate matches baseline — pass.** Run as three separate commands:
   `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, 109 pass /
   0 fail (baseline 101; +8 = 5 doctor + 3 customizations);
   `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0, no
   mismatches; `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` → exit 0,
   0 findings (baseline 0). No new findings.
10. **No hook / manifest / resolver files changed — pass.** `git diff --name-only
    origin/main...HEAD | grep -E 'scripts/hooks/|\.github/hooks/|^hooks\.json|
    ^plugin\.json|^package\.json|session-state\.mjs|delivery-roadmap-resolver\.mjs'`
    → no matches.

**10 pass / 0 fail / 0 deferred.**

## Plan vs implementation

- **Documented deviation (accepted):** plan.md `## Research` said `install-skills`
  would skip `doctor --for`; the build runs it (17 prompts, not 16) because §10
  binds every `network` command and test (b) enforces that literally. Recorded on
  roadmap step 3.2; the policy text and the CLI table are consistent with the
  implementation, so the plan note is the stale side.
- The `session` case's primary-worktree resolution was factored into
  `primaryWorktreesDir()` (`scripts/agento.mjs` L181–185) so `worktrees-dir` shares
  it — the plan asked for the same code path; this is the cleaner way to get it.
  `session` behaviour is unchanged (existing tests pass).
- `doctor` emits `for: null` when `--for` is absent, as the plan specified.
- No undocumented changes: every touched file is in the plan's `### Files touched`
  list.

## Roadmap audit

All 12 steps spot-checked against the codebase and the commands above; no falsely
ticked box found, no repairs made.

- 1.1–1.3: `scripts/agento.mjs` usage slice `slice(1, 19)`, `--for` validation,
  six checks, `COMMAND_NEEDS`; five `test("doctor…` cases + extended usage test.
- 2.1–2.2: policy §1, §9, §10 as cited in item 3.
- 3.1: recorded pre-3.2 failure names match the three tests that exist.
- 3.2–3.4: declarations, deferral wording, `doctor.prompt.md`, mirror identity.
- 4.1: docs hits as in item 8. 4.2: gate numbers reproduced exactly (109/0/0).
  4.3: `git merge origin/main` — `origin/main` is an ancestor; PR #18 `CLEAN`, draft.
- No `(manual)` or `(manual, post-ship)` steps exist, so no evidence files are due.

## Findings

No finding above minor severity.

- **Minor — the customizations cross-check test hits the network.** "the CLI needs
  table agrees with every prompt's Needs: line" (`tests/customizations.test.mjs`
  L223–234) spawns `doctor --for <name>` for all 23 prompts with `cwd: repoRoot`;
  for the 17 `network` commands each run executes `git ls-remote` against the real
  `origin`. The test only asserts `for.needs`, so it still passes offline (the
  check degrades to `warn`), but it adds ~17 remote round-trips (bounded at 10 s
  each) to a unit suite that was previously offline. Full-suite duration measured
  8.2 s. Not blocking; see Follow-ups.
- **Minor — `probe()` first-line truncation hides multi-line stderr.**
  `scripts/agento.mjs` L191–204 keeps only the first stderr line in `detail`. For
  `gh auth status` that is the useful line; for `git ls-remote` failures the first
  line is sometimes `fatal: …` and sometimes a warning. Acceptable for a
  readiness summary; noted only so nobody relies on `detail` for diagnostics.

## Follow-ups

- Make the `doctor --for` cross-check in `tests/customizations.test.mjs` offline:
  either compare the prompts' `Needs:` lines against an exported/`--dry-run` view of
  `COMMAND_NEEDS` or point `--root` at a temp repo whose `origin` is a local bare
  clone (as `scripts/agento.test.mjs` `makeRepo()` does), so the unit suite never
  depends on GitHub reachability.
- Update plan.md `## Research` "Command inventory" (and the Decision 2 wording) to
  say `install-skills` runs `doctor --for install-skills`, so the historical plan and
  §10 agree; roadmap 3.2 already records the deviation, so this is documentation
  hygiene only.
