# Review: session-state-cli

Verdict: approve

Reviewed 2026-09-13 on `feature/session-state-cli` at `8d6ebe7` (13 commits ahead of
`origin/main` `87b7bbd`, which is an ancestor of `HEAD`). Worktree
`/home/david/DP/agento-worktrees/plan-20260914-015913` owns the branch; the primary
worktree `/home/david/DP/agento` is on `main`. Draft PR #15. Skills consulted: none —
no matching domain (no `.agents/skills/` directory, no `## Agento` skills table in
`AGENTS.md`).

Every command below was run fresh by the Reviewer in this worktree.

## Acceptance checklist results

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | `session` from the primary on `main` → `role: primary`, `isPrimary: true`, `no-delivery`, `allowed` has `/agento start-session`, exit 0 | **pass** | `node scripts/agento.mjs session --root /home/david/DP/agento` → `{"role":"primary","isPrimary":true,"branch":"main","lifecycle":"no-delivery","allowed":["/agento start-session",…]}`; `--root /home/david/DP/agento/scripts/hooks` → `role: primary`, `worktree.path: /home/david/DP/agento`; exit 0. (Running `node scripts/agento.mjs session` *inside* the primary uses `main`'s CLI, which predates the subcommand and returns `usage-error` — expected until ship.) |
| 2 | Managed worktree on `feature/<slug>` with `in-progress` roadmap → `build`, `delivery.slug`, `building`, `allowed` has `/agento build-feature <slug>`, `elsewhere` has `/agento ship <slug>@primary` | **pass** | `scripts/agento.test.mjs` "session from a managed build worktree reports the delivery, lifecycle, and commands" passes; `tests/session-context.test.mjs` "reports role=build …" asserts the same line end to end (`allowed=[/agento build-feature widget; …] elsewhere=[… /agento ship widget@primary]`). |
| 3 | Promoted `plan-<id>` worktree on `feature/<slug>` → `role: build`, `dirPrefix: plan` | **pass** | Live: `node scripts/agento.mjs session` in this worktree → `role: "build"`, `worktree.dirPrefix: "plan"`, `worktree.id: "20260914-015913"`, `delivery.slug: "session-state-cli"`. Unit `session-state.test.mjs` L84 and integration `agento.test.mjs` "session promotes a plan-* worktree to build …" pass. |
| 4 | `freehand-<slug>` → `role: freehand` with the fixed list; non-primary dir outside `worktrees.dir` → `unmanaged`, `allowed: []`, `elsewhere` → `primary` | **pass** | `session-state.test.mjs` L106 "freehand: …", L115 "unmanaged: …", L344 "… freehand and unmanaged are fixed" pass; `FREEHAND`/`UNMANAGED` constants in [session-state.mjs](../../../../scripts/session-state.mjs#L205-L206). |
| 5 | Every lifecycle value produced by exactly the inputs in `## Approach` | **pass** | `deriveLifecycle` switch in [session-state.mjs](../../../../scripts/session-state.mjs#L123-L150) matches the plan mapping row for row; `session-state.test.mjs` L227 asserts the produced set equals `LIFECYCLES` and L251 asserts `MERGED` only adds `merged-but-not-complete` without changing the lifecycle. |
| 6 | `--pr` with `gh` missing → `pr: null`, one warning, unchanged lifecycle, exit 0; without `--pr` `gh` never invoked | **pass** | `PATH=<node,git only> node scripts/agento.mjs session --pr` → `pr: null`, `warnings: ["pr: gh CLI not found on PATH; …"]`, `lifecycle: in-review`, exit 0. Stub `gh` (`exit 99`, writes `INVOKED` to stderr) first on `PATH` without `--pr` → `pr: null`, 0 stderr lines. With real `gh`: `pr: {number: 15, state: OPEN, isDraft: true, mergeStateStatus: CLEAN}`. Integration tests "session --pr degrades …" and "session never invokes gh without --pr …" pass. |
| 7 | Usage output lists `session [--pr]` | **pass** | `node scripts/agento.mjs` usage line 19: `node scripts/agento.mjs session [--pr]  (role, worktree, delivery, lifecycle, allowed)`; `session extra` → `usage-error` "session takes no positional arguments". |
| 8 | Hook emits exactly one `Session:` line after `Agento CLI:` with node; byte-identical pre-feature output without node | **pass** | `bash scripts/hooks/session-context.sh <<< '{"cwd":"$PWD"}'` → one `Session: role=build … lifecycle=in-review allowed=[/agento review-feature session-state-cli; /agento delivery-status] elsewhere=[…@primary; …@primary]` line directly after `Agento CLI:`; with `cwd=/home/david/DP/agento` → `Session: role=primary … lifecycle=no-delivery`. `origin/main` and `HEAD` hook copies run from the same temp root with a `PATH` lacking `node` → `cmp` reports identical bytes. `tests/session-context.test.mjs` 8/8 pass. Timing: 0.13 s. |
| 9 | `delivery-status` prompt (both copies identical) opens with `session --pr` and a Session section; customizations test passes | **pass** | `diff commands/delivery-status.md .github/prompts/delivery-status.prompt.md` → empty; new step 1 runs `session --pr` and lists role/worktree/delivery/lifecycle/allowed/elsewhere/warnings; steps renumbered 2–6 with unchanged text; `node --test tests/customizations.test.mjs` → 9 pass / 0 fail. |
| 10 | Docs list the subcommand and hook line | **pass** | `docs/commands.md:30` (`session [--pr]`), `AGENTS.md:17-18` (`session`, `session-state.mjs`), `docs/hooks.md:11` (`Session:` line, no-`--pr`), `README.md:415-417` (`Session:` summary + node fallback), `CHANGELOG.md:3-18` (`## 0.4.0 (unreleased)` with three entries); `plugin.json`/`package.json` still `0.3.0`. |
| 11 | Full lint gate green and equal to baseline | **pass** | `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` exit 0, no findings; `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → 98 tests, 98 pass, 0 fail (baseline 70; +28 new); `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0, no mismatches. No new findings vs the baseline table. |
| 12 | No file outside "Files touched" changed; no other prompt/agent edited | **pass** | `git diff --stat origin/main...HEAD` → 15 files: the 13 listed in plan.md plus `features/2026/09/session-state-cli/{plan,roadmap}.md`. `.github/agents/` and other `commands/`/`.github/prompts/` untouched. |

Tally: 12 pass, 0 fail, 0 deferred to post-ship.

## Plan vs implementation

- Implemented as designed: pure helpers in `scripts/session-state.mjs`
  (`parseWorktreeList`, `deriveRole`, `deriveDelivery`, `deriveLifecycle`,
  `deriveAllowed`, plus exported `LIFECYCLES`/`ROLES`), composed by the `session` case
  in [agento.mjs](../../../../scripts/agento.mjs#L445-L460); `--pr` in `parseArgs`;
  `lookupPullRequest` guarded by a `gh --version` probe and `execFileSync` argv arrays.
- Documented deviation (roadmap 2.1 note): `worktrees.dir` is resolved against the
  **primary** worktree's config (`worktrees[0].path`), not the current root, so a
  secondary checkout finds the right sibling directory. Sensible and covered by the
  live run from this worktree.
- Small additive extras beyond the plan text: `deriveAllowed` also accepts `worktree`
  to fill `<slug>` from the directory id when no delivery exists; `deriveLifecycle`
  emits an `unknown-roadmap-status` warning for unrecognised statuses; unit tests cover
  an empty worktree list and unknown role/lifecycle. None widen scope.
- `closeBuildSessionDecision()` regex left untouched, as the plan's out-of-scope list
  requires.

## Roadmap audit

All 10 boxes spot-checked against the codebase and the fresh gate; none falsely
ticked. No `(manual)` or `(manual, post-ship)` steps exist. Step 2.3 records the
guard approval date (2026-09-13) and the measured hook latency, which I reproduced
(0.13 s). Step 2.4/3.3 gate numbers (98 pass, shellcheck 0, replay 0) match my rerun.
No repairs made.

## Findings

No findings above minor severity.

- **minor** — [agento.mjs](../../../../scripts/agento.mjs#L161-L165): a `gh` binary
  that is present but fails `gh --version` (e.g. broken install) is reported as
  "gh CLI not found on PATH". Harmless (still `pr: null` + one warning), but the
  message could say "not usable" to avoid misleading the user.
- **minor** — [session-context.sh](../../../../scripts/hooks/session-context.sh#L42-L47):
  `except Exception` is broad, but that is the intended silent-fallback contract
  (Decision Q2) and `capture_output=True` keeps CLI stderr out of the hook's output.
- **minor** — [agento.mjs](../../../../scripts/agento.mjs#L170-L171): the first stderr
  line of a failed `gh pr view` is surfaced verbatim in `warnings[]`. `gh`'s auth and
  not-found errors are non-sensitive, so acceptable; keep in mind if the field set
  ever grows.

Security review: both subprocess calls (`execFileSync("gh", […])`, Python
`subprocess.run([node, cli, "session", "--root", cwd])`) use argv arrays with no shell;
timeouts are bounded (15 s / 5 s); the hook reads no env beyond `AGENTO_ROOT`,
prints only paths, branch names and command strings, and never elevates or writes.
`--pr` is opt-in and absent from the hook, so SessionStart never reaches the network.

## Follow-ups

- Reword the `gh --version` probe failure message to "gh CLI not usable on PATH"
  (see Findings). Trivial; could ride along with `window-aware-commands`. → filed as #31
- `window-aware-commands` (initiative member) should replace the regex heuristic in
  `closeBuildSessionDecision()` with `deriveRole`, as the plan hands off.
