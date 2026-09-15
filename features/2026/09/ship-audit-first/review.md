# Review: ship-audit-first

Verdict: approve

Review round 1, at `b86fd25` on `feature/ship-audit-first` (draft PR #20, head
`b86fd25`, `mergeStateStatus: CLEAN`), 2026-09-14. This worktree
(`plan-20260914-233032`, `role: build`, `delivery.slug: ship-audit-first`) owns the
branch per `agento.mjs session` (`worktrees[]`: primary on `main`, this entry on the
branch, no other). `doctor --for review-feature` → `ok` (node v22, origin reachable,
gh authenticated, python3, worktrees-dir writable). `origin/main` `e32d872` is an
ancestor of `HEAD` (`git merge-base --is-ancestor origin/main HEAD` → 0) and PR #19's
merge commit `e32d872d…` is an ancestor (roadmap 1.1 gate). Skills consulted: none —
no matching domain (no `.agents/skills/`, no `## Agento` skills table in AGENTS.md).

Nothing in this delivery is served behaviour; no `local:`/`dev-stack`/`preview`
target applies (plan.md `## Research`), so no browser drive was needed.

Verification run by the Reviewer at `b86fd25` (baseline in plan.md `## Research`:
120 pass / 0 fail at `3325195`, shellcheck 0, replay 0):

- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, **124 pass /
  0 fail** (`# tests 124 / # pass 124 / # fail 0`, no `not ok` lines). +4 over the
  integrated baseline, all from this delivery (three `evaluateShipPreflight`
  ownership tests, one close-before-ship guidance guard); no new findings.
- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no output.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0, all
  fixtures match.
- `cmp` of all 23 `.github/prompts/*.prompt.md` against `commands/*.md` → 0
  mismatches.
- Guard-test negative check: appended `/agento close-session feature/x → /agento
  ship x` to `docs/concurrency.md`, `node --test tests/customizations.test.mjs` →
  exit 1, `not ok 16 - guidance never sequences close-session before ship
  (ship-audit-first)` naming `docs/concurrency.md: "/agento close-session feature/x
  → /agento ship"`; reverted with `git checkout -- docs/concurrency.md` (`git status
  --porcelain` empty), rerun → 18 pass / 0 fail.
- `git diff --stat origin/main...HEAD` → 32 files; no `scripts/hooks/`,
  `.github/hooks/`, `plugin.json`, or `package.json` change.

## Acceptance checklist results

1. **PR #19 ancestry + `owner` key** — pass. `sha=$(gh pr view 19 --json mergeCommit
   --jq .mergeCommit.oid)` → `e32d872d3ddd74bb6c0522765ba6583ce6c644c2`; `git
   merge-base --is-ancestor "$sha" HEAD` → exit 0. `node scripts/agento.mjs
   ship-preflight feature ship-audit-first` output line 5 is `"owner": {`.
2. **ship.md no longer instructs close-session first** — pass. `grep -n
   "close-session" commands/ship.md` returns nothing at all (stricter than "only
   teardown/abandon references"); `cmp .github/prompts/ship.prompt.md
   commands/ship.md` → 0. The old "stop and direct the user to run `/agento
   close-session`… then rerun" paragraph is gone (diff `commands/ship.md`).
3. **Both ownership paths documented** — pass. [commands/ship.md](../../../../commands/ship.md#L35-L59):
   `owner !== null` → read-only audit via `git show origin/<branch>:<path>` and `git
   diff origin/main...origin/<branch>`, `git -C <owner.path> status --porcelain`
   empty and `rev-list --count @{upstream}..HEAD` = 0, writes via `git -C
   <owner.path>` (merge/status commit/stamp/push), `merge --abort` + reject naming
   `/agento build-<type> <slug>` on conflict; `owner === null` → today's primary
   checkout; "never check the branch out in the primary while an owner exists…
   never create a temporary detached checkout". Rehearsed in
   [evidence/step-4-3-ship-rehearsal.md](evidence/step-4-3-ship-rehearsal.md) (owner
   path) and [evidence/step-4-3-ship-reject.md](evidence/step-4-3-ship-reject.md)
   (conflict → `merge --abort` → `status --porcelain` empty).
4. **Pinned gap lists** — pass. [commands/ship.md](../../../../commands/ship.md#L88-L103):
   hard-reject = unticked non-`(manual, post-ship)` steps, falsely ticked steps,
   review missing/stale/`request-changes`, issue regression test failing, owner
   dirty or unpushed, PR `CONFLICTING`; `<command>` is `/agento review-<type>
   <slug>` when the review is the only gap else `/agento build-<type> <slug>`, or
   `/agento start-session <type>/<slug> --resume` when `owner === null`.
   Confirmation = unstamped changelog, PR body/title nits, undocumented unrelated
   drift; missing `Fixes #<n>` fixed via `gh pr edit <n> --body`. "nothing else
   counts as a gap" pins the lists.
5. **Teardown + exact pause line** — pass. [commands/ship.md](../../../../commands/ship.md#L133-L143):
   teardown after the `main` sync and release workflow — `git worktree remove
   <owner.path>`, `git worktree prune`, `git branch -d <branch>`; "never answer
   that ask yourself"; `grep -c "paused at teardown (worktree <path> still open);
   next: close that VS Code window, then /agento ship <slug>" commands/ship.md` → 1.
6. **Policy §8/§9/window-check** — pass. `grep -n "resumes at teardown"
   .github/instructions/delivery-policy.instructions.md` → L222 (ship row: "`status:
   complete`, PR merged, and a managed worktree still owning the branch resumes at
   teardown"); §8 item 2 (L150–154) hands off to `/agento ship <slug>` with
   standalone `/agento close-session` "for plan and freehand sessions and for
   abandoning a build"; `grep -c 'close-session <type>/<slug>\`, then'` → 0; the
   "while it still depends on the worktree being gone" parenthetical is gone from
   §11 (now "`/agento ship` for its post-merge teardown"). (The plan's "§10" means
   the window-check section, which is `§11` after the `capability-preflight` merge.)
7. **Session-state table + tests** — pass. [scripts/session-state.mjs](../../../../scripts/session-state.mjs#L214-L258):
   `SHIP_LATER`/`SHIP_NOW` name ship only with "tears … down" reasons, `TEARDOWN =
   [SHIP, CLOSE]` for `build|plan × shipped`, `primary × approved` = `[SHIP, CLOSE,
   STATUS]`, header comment cites §8 as data. `scripts/session-state.test.mjs`
   asserts the new order and `/tears/` reasons; `tests/session-context.test.mjs`
   updated to the new `elsewhere=[…ship widget@primary]`. Both pass in the full run.
8. **Resolver ownership tests** — pass. [scripts/delivery-roadmap-resolver.test.mjs](../../../../scripts/delivery-roadmap-resolver.test.mjs#L111-L177):
   managed `feature-widget` → `owner.path`, `role: build`, `dirPrefix: feature`;
   promoted `plan-20260914-233032` → `dirPrefix: plan`, `id`, `role: build`; no
   `worktreeList` → `owner === null`; `status: ok` in all three. No resolver source
   change (as planned).
9. **Guard test rejects close-then-ship** — pass. [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs#L352-L371):
   two regexes over paragraph-unwrapped `guidanceFiles`, allowlist `CHANGELOG.md`;
   negative check above (injected fixture → `not ok 16`; reverted → pass). The
   `paused at teardown` canary (L290–297) requires the string in `ship.prompt.md`
   and rejects it elsewhere in agents/prompts/instructions.
10. **No guidance describes close-session before ship** — pass. Guard test green on
    the branch; manual sweep `grep -rn -i 'close.{0,60}session.{0,120}ship'` over
    README, AGENTS.md, docs, agents, instructions, commands, templates leaves only
    the enumerative command list in `commands/agento-init.md` L64 /
    `templates/AGENTS-section.md` L6 (not a sequence). Verified by diff:
    `commands/next-feature.md` L47 (`/agento ship <feature-slug>` alone),
    `docs/commands.md` standard and initiative flows, README `### 5. Ship — primary
    window` (+ "Closing without shipping"; headings now 1–5 contiguous),
    `docs/architecture.md` mermaid (`SHIP -->|reject| B`, `SHIP -->|merge, sync,
    teardown, epilogue| DONE`, close-session edge "plan/freehand/abandon"),
    Reviewer step 8, Builder completion, Autopilot ground rule + step 4, Planner
    step 9, `templates/AGENTS-section.md`, `commands/agento-init.md`.
11. **close-session.md intro** — pass. Diff adds one sentence
    ([commands/close-session.md](../../../../commands/close-session.md#L14-L17)):
    ship performs the build close after merge; this command is for plan/freehand
    sessions and abandoned/superseded builds; closing before ship stays valid. No
    other change to the file (`cmp` with the prompt → 0).
12. **CHANGELOG + versions** — pass. `grep -c '^## .*(unreleased)' CHANGELOG.md` →
    1; the `## 0.4.0 (unreleased)` entry "`/agento ship` audits first and tears down
    last" covers the ownership paths, gap lists, teardown pause, §8/§9, table, and
    guard test. `grep -n '"version"' plugin.json package.json` → both `0.3.0`.
13. **Rehearsal transcripts** — pass. Three files under `evidence/`:
    `step-4-3-ship-rehearsal.md` (owner clean/zero-ahead → `git -C` status commit +
    push → simulated merge → `fetch --prune` → `worktree remove` → `worktree prune`
    → `branch -d`), `step-4-3-ship-reject.md` (dirty owner → HEAD and
    `origin/feature/widget` unchanged; conflicting `merge` → `merge --abort` →
    `status --porcelain` empty, HEAD unchanged), `step-4-3-ship-pause.md` (sleep
    holding the cwd → `replay-guard.sh` → `ask`, full guard JSON `permissionDecision:
    ask`, no answer given, worktree still registered, `main` synced). Each ends with
    the `Result:` line its path specifies; the pause file's last line is exactly the
    prompt's `paused at teardown (worktree <path> still open); next: close that VS
    Code window, then /agento ship <slug>` with the path and slug filled in.
14. **Full gate vs. baseline** — pass. See the verification block above: 124/124,
    shellcheck 0, replay 0; no new findings against the recorded baseline.

## Plan vs implementation

- Implemented as designed in `## Approach` §1–§9. Deviations, all documented on the
  roadmap or in the plan:
  - Roadmap 4.1 grew to include `new-feature`/`new-issue` step 6/9 handoff sentences
    and the two `docs/commands.md` flow blocks, because the 2.2 guard test had to be
    green at 4.1 (noted on the step line).
  - `tests/session-context.test.mjs` (one regex) changed — not in the plan's "Files
    touched" list but a necessary consequence of the table change.
  - Roadmap 4.2 `verify:` was repaired from `grep -c "unreleased"` to `grep -c '^##
    .*(unreleased)'` with the reason on the step line (three historical prose
    mentions); intent preserved.
  - The plan's §8 "extend the §9 table check (if present)" had no such test to
    extend; the `paused at teardown` canary was added instead. Consistent with the
    plan's conditional.
- Evidence file names are `step-4-3-*` (plan §9 said `step-4-2-*` before the roadmap
  placed the rehearsal at 4.3); roadmap links resolve.
- Out-of-scope items respected: no change to `closeBuildSessionDecision`,
  `findOwner`, the `owner` shape, `scripts/hooks/`, `agento.mjs`, or the version.

## Roadmap audit

All 13 steps ticked; each spot-checked against the codebase and commit history:

- 1.1 — `e32d872` ancestor; `owner` key present (checked above).
- 1.2 / 4.4 — plan.md `## Research` records the integrated (120) and final (124)
  runs with exit statuses and the baseline comparison.
- 2.1 — three new tests present and passing.
- 2.2 — commit `38dba3e` body records the exposing run (2 of 18 failing, files
  named); test present.
- 2.3 — commit `05d800e` body records the exposing run (2 of 25 failing); assertions
  present.
- 3.1 — table rewritten per Approach §5; tests green.
- 3.2 — greps above.
- 3.3 — `cmp` 0; pause line count 1; no `close-session` in ship.md.
- 3.4 — `cmp` 0; `grep -n "abandon" commands/close-session.md` → L16.
- 4.1 / 4.2 — customizations suite green; diffs read.
- 4.3 — three evidence files exist, end with the specified `Result:` lines.

No falsely ticked boxes; no repairs made; no `(manual)` or `(manual, post-ship)`
steps in this roadmap.

## Findings

No blocking or major findings.

- **Minor / observation** — [commands/ship.md](../../../../commands/ship.md#L89-L97)
  ends a hard reject with "the §9 failed result line carrying `<gaps>; next:
  <command>`", but policy §9 spells the failed form as `Result: failed — <retry-safe
  explanation>` without a `next:` segment. This is the wording plan Decision Q3 and
  Approach §2 asked for, and the rehearsal transcripts follow it; a one-line §9
  clarification ("a failed line may carry `next:`") would remove the ambiguity.
  Not a gap in this delivery.
- **Minor / observation** — the guard regex `(→|\bthen\b|and then)` will also
  flag a paragraph such as "`/agento close-session` is for abandoning; then
  `/agento ship`…" if anyone writes one; that is the intended strictness and no
  current guidance trips it.

## Follow-ups

- Policy §9: state explicitly that a `Result: failed` line may carry a `; next:
  <command>` segment (ship's hard-reject uses it) so prompts and policy agree
  letter-for-letter. → filed as #32
