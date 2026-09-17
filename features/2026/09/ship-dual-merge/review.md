# Review: ship-dual-merge

Verdict: approve

Reviewed 2026-09-17 at `bd040d6` on `feature/ship-dual-merge` (draft PR #44,
in-repo layout, `origin/main` is an ancestor of HEAD, worktree clean, 0 ahead of
upstream). Skills consulted: none — no matching domain (no `.agents/skills/`, no
`## Agento` skills table in AGENTS.md; same as plan.md).

## Acceptance checklist results

1. **`describeCompanion` reports `behind`; `companionGaps()` includes `"behind"`;
   `close-decision` refuses naming `behind`; `session` carries it** — **pass**.
   [scripts/agento.mjs](../../../../scripts/agento.mjs#L183-L192) reads
   `rev-list --count HEAD..@{upstream}` (`"0"` without an upstream) and
   [companionGaps](../../../../scripts/agento.mjs#L209-L212) appends `"behind"`;
   the `close-decision` message for a behind-only half reads `is behind its
   upstream; run git -C <path> merge origin/<branch> (a fast-forward)`
   ([scripts/agento.mjs](../../../../scripts/agento.mjs#L820-L832)). Tests
   [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs#L556-L565) assert
   `companion.behind === 1`, `companionGaps` `["behind"]`, exit 3 /
   `companion-unpushed`, and `behind === 0` after the fast-forward; every in-repo
   `companion: null` / `companionGaps: []` assertion and the pair `deepEqual`s
   (now with `behind: 0`) pass. `node --test scripts/agento.test.mjs
   scripts/session-state.test.mjs` → 92/92/0.
2. **`ship-preflight --pr` emits `pr`, `companionPr`, `warnings[]`; PR gaps
   `missing-pr` / `pr-not-open` / `conflicting-pr`; `MERGED` adds no gap; no `pr`
   key without `--pr`** — **pass**.
   [scripts/agento.mjs](../../../../scripts/agento.mjs#L840-L853): without
   `options.pr` the pre-existing `withExit` runs unchanged; with it, both lookups
   run and gaps are appended only when `artifacts.external`. Test "ship-preflight
   --pr: in-repo one gh call with companionPr null; companion mode both PRs and PR
   gaps; no --pr means no pr key" passes
   ([scripts/agento.test.mjs](../../../../scripts/agento.test.mjs#L1176-L1230):
   `missing-pr`, `pr-not-open`, `conflicting-pr`, `MERGED`/`MERGED` → `[]`,
   `MERGED`/`OPEN` → `[]`, `["dirty","pr-not-open"]` combination, `!("pr" in …)`).
   Re-derived here: `node scripts/agento.mjs ship-preflight feature ship-dual-merge`
   prints `"companion": null`, `"companionGaps": []` and has 0 `"pr"` keys; with
   `--pr` it prints `pr` `{ number: 44, state: OPEN, isDraft: true }`,
   `"companionPr": null`, `"warnings": []`.
3. **`deriveLifecycle` `companion-pr-open` warning; `session --pr` surfaces it** —
   **pass**. [scripts/session-state.mjs](../../../../scripts/session-state.mjs#L227-L257)
   adds the warning when `pr.state === "MERGED"` and `companionPr.state === "OPEN"`
   with `lifecycle` untouched; `session` and `next` pass `companionPr`
   ([scripts/agento.mjs](../../../../scripts/agento.mjs#L938),
   [scripts/agento.mjs](../../../../scripts/agento.mjs#L980)). Tests
   [scripts/session-state.test.mjs](../../../../scripts/session-state.test.mjs#L495-L508)
   (present; absent for `null`, `MERGED`, omitted) and
   [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs#L1152-L1157)
   (`session --pr` with stub `gh` `MERGED`/`OPEN`) pass. Here `node
   scripts/agento.mjs session --pr` prints `"companionPr": null`, `"warnings": []`.
4. **`ship.prompt.md` companion-mode flow and grep thresholds** — **pass**.
   `grep -c 'companionPr'` = 10 (≥ 3); `ship-preflight.*--pr` = 1 (≥ 1);
   `post-ship` = 12 (≥ 3); `-- '--repo <artifacts.repo.name>'` = 0. Read in full:
   artifacts are read via `git -C <artifactsRoot> show origin/<branch>:<path>`
   ([ship.prompt.md](../../../../.github/prompts/ship.prompt.md#L27-L37)),
   `status: complete` is a `git -C <companion.path>` commit
   ([ship.prompt.md](../../../../.github/prompts/ship.prompt.md#L152-L161)), both
   PRs are marked ready, the code PR merges after `wait-for-checks.sh pr <n>` and
   the companion after `wait-for-checks.sh pr <m> --repo <nameWithOwner>`
   ([ship.prompt.md](../../../../.github/prompts/ship.prompt.md#L162-L188)), both
   defaults sync with `merge --ff-only`
   ([ship.prompt.md](../../../../.github/prompts/ship.prompt.md#L189-L193)), and the
   epilogue runs in the companion
   ([ship.prompt.md](../../../../.github/prompts/ship.prompt.md#L229-L247)).
5. **Duplicate-submission case documented in both places** — **pass**. Prompt
   idempotency paragraph [ship.prompt.md](../../../../.github/prompts/ship.prompt.md#L39-L50)
   and the `/agento ship` row in
   [delivery-policy.instructions.md](../../../../.github/instructions/delivery-policy.instructions.md#L241);
   `grep -c 'companion'` on the policy file: 17 on HEAD vs 16 on `origin/main`;
   `tests/customizations.test.mjs` passes inside the full gate.
6. **Command mirror intact** — **pass**. `cmp .github/prompts/ship.prompt.md
   commands/ship.md` silent; `diff <(ls commands) <(ls .github/prompts | sed …)`
   empty.
7. **Docs state the dual merge** — **pass**. `Interim limitation` in docs/commands.md
   = 0; `leaves the companion PR open` in CHANGELOG.md = 0; `companion` in README.md
   10 vs 4 on `origin/main`; `behind` in docs/commands.md = 4; `Ship dual merge` in
   CHANGELOG.md = 1. The mirrored-branches changelog bullet no longer carries the
   "Interim" sentence.
8. **End-to-end drive evidence** — **pass**.
   [evidence/step-4-1-dual-merge-drive.txt](evidence/step-4-1-dual-merge-drive.txt)
   contains the drive script (with a self-asserting Python log check) and the full
   transcript. Run A: `project pr merge 12` (transcript L718) precedes
   `project-docs pr merge 7` (L749); every `pr ready 7`, `pr merge 7`, `repo view`
   call logs `$PWD` = `…/project-docs`; the `wait-for-checks.sh pr 7` `pr view`
   carries `--repo acme/project-docs`; `OK: run A` at L754. Run B: the first
   companion merge fails and prints the exact `Result: failed — code PR #12 merged,
   companion PR #7 open at …; re-send /agento ship xw to resume at the companion
   merge` line (L1017); the re-send preflight shows `pr: MERGED`, `companionPr:
   OPEN`, `companionGaps: []` (L1042–L1053) and `session --pr` warns
   `companion-pr-open` (L1066); pass 2 (after the log marker) has no `pr merge 12`
   and the second `pr merge 7` (L1291); `OK: run B` at L1296. Both runs end
   `product: status [] ahead/behind 0/0; branch feature/xw → gone` and the same for
   the companion (L666–L667, L1172–L1173); both worktree lists are back to the
   primary and `wt/` / `project-docs-worktrees/` are empty; `DRIVE OK` (L1299).
9. **Full-repository gate against the §5 baseline (188/188/0)** — **pass**, rerun by
   the Reviewer: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0,
   `# tests 190`, `# pass 190`, `# fail 0` (+2 = the two new tests in this delivery);
   `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
   scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no output;
   `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0;
   `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh <
   tests/guard-fixtures-companion.txt` → exit 0. No new or undocumented findings; no
   hook script changed (`git diff --stat origin/main...HEAD` lists none).
10. **In-repo layout unchanged** — **pass**. The `ship-preflight` case returns the
    identical object when `options.pr` is unset; the pre-existing in-repo
    `deepEqual` assertions pass unchanged; `node scripts/agento.mjs ship-preflight
    feature ship-dual-merge` prints `"companion": null`, `"companionGaps": []`;
    `lookupCompanionPullRequest` short-circuits with no `gh` call when
    `artifacts.external` is false.

## Plan vs implementation

- Every `## Approach` item (1–8) is implemented in the files the plan lists; no
  undocumented files changed (13 files in the diff, all named in "Affected files" or
  the feature's own artifacts).
- `close-decision`'s message now reads `is <state>; <fix>.` for all gap combinations
  (the `behind`-only fix text is the plan's; mixed gaps keep the old commit-and-push
  text). Slight wording change from the plan ("extended to name `behind`") — the
  test at [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs#L561) pins it.
- The prompt's companion-mode detection (`companionPr !== null`, or `artifactsRoot ≠
  root` when `gh` degraded) matches the plan. Note that in companion mode a degraded
  `gh` makes the CLI emit `missing-pr` alongside the `companionPr:` warning, so the
  audit hard-rejects — acceptable (the prompt cannot ship without `gh` anyway; `gh` is
  a hard need), recorded as a minor finding below.
- No drift in `Needs:` lines (`ship` stays `terminal, gh, network`; the customizations
  suite agrees with `doctor --for ship`).

## Roadmap audit

All 11 boxes ticked; each spot-checked against the codebase:

- 1.1–1.3: code and tests present as described (see checklist items 1–3).
- 2.1–2.3: prompt content present; grep thresholds and `cmp` re-derived (item 4, 6).
- 3.1–3.2: policy row and docs present (items 5, 7).
- 4.1: evidence file committed at `0700d19`, linked from the step line (item 8).
- 4.2: recorded 190/190/0, shellcheck silent, both replays exit 0 — reproduced.
- 4.3: `git merge-base --is-ancestor origin/main HEAD` exit 0; `git status
  --porcelain` empty; `rev-list --count @{upstream}..HEAD` = 0; `agento.mjs initiative
  external-artifact-repo` lists `ship-dual-merge` `state: in-review`, `errors: []`.

No falsely ticked boxes; no steps added; no repairs made. No `(manual)` or
`(manual, post-ship)` steps exist.

## Findings

Ordered by severity; none above minor.

- **Minor — `missing-pr` doubles as "lookup failed".**
   [scripts/agento.mjs](../../../../scripts/agento.mjs#L847-L852) pushes `missing-pr`
  whenever `companionPr` is `null` in companion mode, including when `gh` is absent
  or `gh pr view` errors (the cause is in `warnings[]`). The resulting hard-reject is
  the safe outcome, but the token is slightly misleading; a distinct `pr-lookup-failed`
  gap (or reading `warnings[]` first in the prompt) would be clearer. No behaviour
  change needed for approval.
- **Security — none.** All new `gh`/`git` invocations go through `execFileSync` with
  argument arrays ([scripts/agento.mjs](../../../../scripts/agento.mjs#L48-L51),
  [scripts/agento.mjs](../../../../scripts/agento.mjs#L343-L365)); no shell string
  interpolation. The prompt never uses `--repo <artifacts.repo.name>` and derives
  `nameWithOwner` inside the clone. No hook scripts, guard rules, or secrets touched.
- **Info — companion default sync in the prompt is `switch`/`fetch --prune`/`merge
  --ff-only` only**, consistent with the plan's guard analysis (no commit or push to
  the protected companion default); the replay fixtures pass unchanged, so no fixture
  addition was needed.

## Follow-ups

- Consider a dedicated `pr-lookup-failed` gap token (or prompt guidance to check
  `warnings[]` before reporting `missing-pr`) so a degraded `gh` in companion mode is
  reported as an environment problem rather than a missing PR.
- (carried from roadmap) `session --pr` and `ship-preflight --pr` each run `gh
  --version` once per lookup; a shared probe would save a spawn per call.
- (carried from roadmap) `artifact-history-migration` is the first real
  companion-mode exercise of the dual merge on GitHub; watch the `wait-for-checks.sh
  pr <m> --repo <nameWithOwner>` path there, since the companion has no CI and the
  script's no-checks grace governs how quickly it returns.
