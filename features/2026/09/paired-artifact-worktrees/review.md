# Review: paired-artifact-worktrees

Verdict: approve

Review round 1, at `4f27b60` on `feature/paired-artifact-worktrees` (draft PR #42,
`state: OPEN`, `isDraft: true`, base `main`), 2026-09-16. This promoted planning
worktree (`plan-20260916-232139`, `role: build`, `delivery.slug:
paired-artifact-worktrees`) owns the branch per `agento.mjs session` (`worktrees[]`:
primary `/home/david/DP/agento` on `main`, this entry on the branch, no other;
`companion: null`, in-repo layout). `doctor --for review-feature` → `ok` (node
v22.22.3, origin reachable, gh 2.45.0 authenticated, python3, worktrees-dir writable,
artifact-repo in-repo); no `Preflight:` line. `resolve feature
paired-artifact-worktrees` → `status: ok`, `source: local`. `git fetch origin` then
`git merge-base --is-ancestor origin/main HEAD` → 0 (`origin/main` = `a6d2903`, the
plan's baseline commit). `git status --short` empty, 0 commits ahead of upstream.
Skills consulted: none — no matching domain (no `.agents/skills/`, no `## Agento`
skills table in AGENTS.md).

Nothing in this delivery is served behaviour; no `local:`/`dev-stack`/`preview`
target applies, so no browser drive was needed. The user-visible surface is the CLI
JSON, the hooks' output, and the prompt text, all re-driven below.

## Lint gate (policy §5, Reviewer half)

Fresh run at `4f27b60`, compared with the plan.md baseline at `a6d2903`
(166/166/0, shellcheck silent, both replays exit 0):

| Command | Exit | Result |
|---|---|---|
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | `# tests 185`, `# pass 185`, `# fail 0` (+19 over baseline, all from this delivery; matches the Builder's 185/185/0) |
| `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` | 0 | silent |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | every fixture matches |
| `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh < tests/guard-fixtures-companion.txt` | 0 | every fixture matches, including the new `allow git -C {companion} worktree list --porcelain` |

Full gate, no new or undocumented findings.

## Acceptance checklist results

1. **`resolveArtifactsRoot()` returns `worktreesDir`** — **pass**.
   [agento-config.mjs](../../../../scripts/agento-config.mjs) adds `worktreesDir:
   <dir>-worktrees` (absolute; `null` when not external);
   [agento-config.test.mjs L106–L160](../../../../scripts/agento-config.test.mjs#L106-L160)
   covers unset, name-only, dir-only, both, and `primaryRoot ≠ rootDir` (asserting
   it is *not* placed under the product worktrees dir). Part of the 185-pass run.
2. **`paths` emits `companion` / `workspace`** — **pass**. Test "paths in companion
   mode adds the companion half and the workspace file; in-repo mode reports null"
   ([agento.test.mjs L265](../../../../scripts/agento.test.mjs#L265)) covers `plan`,
   `feature`, `issue`, `freehand` in both modes. Re-driven on my own `/tmp` pair:
   `paths plan 20260916-150000` → `companion.worktree =
   …/project-docs-worktrees/plan-20260916-150000`, `workspace =
   …/project-worktrees/plan-20260916-150000.code-workspace`; `paths feature
   pair-check` → `companion.branch = feature/pair-check`. In-repo on this checkout:
   `companion: null`, `workspace: null` (see item 9).
3. **`session` agrees from either half** — **pass**. Tests at
   [agento.test.mjs L285](../../../../scripts/agento.test.mjs#L285) (feature pair:
   `strip(fromHalf)` deep-equals `strip(fromProduct)`, `worktrees[0].repo ===
   "product"` and `isPrimary`, `repo` sequence `product, product, companion,
   companion`, `next.invocation` equal from both halves) and
   [L345](../../../../scripts/agento.test.mjs#L345) (plan pair both detached,
   half-promoted pair → `role: build` from both halves with the companion still
   `detached: true`, product half without companion half → `registered: false`).
   My `/tmp` re-drive: from both halves of `plan-20260916-150000` → `role: plan`,
   identical `worktree.path` (product half), `allowed`, `companion { registered:
   true, detached: true, ahead: 0 }`, `workspace.exists: true`, `worktrees[]` tags
   `[product/primary, product/plan, companion/unmanaged, companion/plan]`; the
   companion half additionally carries one `anchored-from-companion` warning. Same
   agreement for the `feature-pair-check` pair (`role: build`, `delivery.slug:
   pair-check`, `allowed` includes `/agento build-feature pair-check`).
4. **`close-decision` / `ship-preflight` companion checks** — **pass**. Test at
   [agento.test.mjs L410](../../../../scripts/agento.test.mjs#L410): unregistered
   half → `ok` with `registered: false`; clean → `ok` + `companion`; dirty → exit 3,
   `companion-unpushed`, message "is dirty"; committed with no upstream → `ahead: 1`,
   "is unpushed"; pushed → `ok`; both → "dirty and unpushed"; in-repo → `companion:
   null`, `companionGaps: []`. Re-driven on `/tmp`: dirty companion half →
   `['error', 'companion-unpushed', dirty=true]` and `ship-preflight` →
   `companionGaps: ['dirty']`; clean → `ok`. The Builder's evidence additionally shows
   the `ahead` case ([step-6-1-pair-e2e.txt L636–L640](evidence/step-6-1-pair-e2e.txt#L636-L640)).
5. **Prompts create/remove/open the pair** — **pass**. `diff -q` of
   `.github/prompts/<p>.prompt.md` vs `commands/<p>.md` empty for `start-session`,
   `start-freehand`, `close-session`, `ship`, `continue`, `agento-init`.
   `tests/customizations.test.mjs` passes inside the 185; the `worktree list
   --porcelain` allowlist at [customizations.test.mjs L185](../../../../tests/customizations.test.mjs#L185)
   is still exactly `start-session, start-freehand, close-session, ship`. Prompt text
   checked against `## Approach` 4: start-session precondition 3–4 (pair fields,
   workspace JSON, `code --new-window <workspace>`, §10 fallback prints the same
   argument), plan mode `worktree add --detach … origin/<default>`, build mode
   `origin/<branch>` else `-b <branch> origin/<default>` (Q5), reuse of a registered
   half; start-freehand `--no-track -b changes/<slug>`; close-session rules 2–6 per
   half + workspace file + `companion-unpushed` stop; ship Ownership/hard-reject
   `companionGaps[]`/Teardown order companion → product → workspace file with
   "whichever half the guard flagged"; continue step 4 opens `<path>.code-workspace`
   for `secondary`, folder for `primary`; agento-init report sentence.
6. **End-to-end on a `/tmp` pair** — **pass**. Builder evidence:
   [step-6-1-pair-e2e.txt](evidence/step-6-1-pair-e2e.txt) (745 lines, plan + build
   start/close, worktree lists before/after both repos). Independently re-driven by
   me on a fresh `/tmp/agento-review-e2e-*` product + companion (bare origins,
   product config `artifacts.repo.name: project-docs`, no `code` windows): plan
   mode created `project-worktrees/plan-<id>`, `project-docs-worktrees/plan-<id>`
   (both detached at `origin/main`) and the `.code-workspace`; close removed all
   three (`git worktree list` back to the single primary in each repo, both
   `*-worktrees/` dirs empty). Build mode: roadmap planted on the companion's `main`,
   `feature/pair-check` in the product only → companion had no `origin/feature/…`,
   Q5 path `-b feature/pair-check … origin/main` taken; both halves on the branch;
   close removed all three. A cwd in the companion clone itself → `unmanaged`,
   anchored on the product with the warning. An unrelated sibling repo → `primary`,
   no warning. Fixture removed afterwards.
7. **Guard workspace-window scan** — **pass**.
   [delivery-guard.sh L89–L114](../../../../scripts/hooks/delivery-guard.sh#L89-L114)
   matches `Workspace (<name>)` and `Window (… <name> (Workspace) …)` against
   `os.path.basename(target)`; test "asks before removing a worktree whose pair is
   open as a .code-workspace window" in [guard.test.mjs](../../../../tests/guard.test.mjs)
   stubs `code` on `PATH` and asserts `ask` for `git worktree remove <product>` and
   `git -C <clone> worktree remove <companion>` (observed title form, title-only,
   and the expected `Workspace (…)` form) and `allow` for a different name. Both
   replays exit 0 (table above).
8. **SessionStart `Artifacts:` names the half** — **pass**.
   [session-context.sh L137–L144](../../../../scripts/hooks/session-context.sh#L137-L144);
   five new tests in [session-context.test.mjs](../../../../tests/session-context.test.mjs)
   (half path + branch and roadmaps walked there; detached half → `(branch
   detached)`; no half → clone; primary → clone; no-node fallback equals with-node
   minus `Session:`). The shared Python helper is byte-identical in both hooks
   (`diff` of delivery-guard.sh L259–L309 vs session-context.sh L52–L102 → empty).
9. **In-repo byte-for-byte** — **pass**. `origin/main`'s four `scripts/*.mjs` copied
   to `/tmp` and run against this checkout beside this branch's: `paths plan xy`,
   `paths feature xy` → only `+ companion: null, + workspace: null`; `session` →
   only `+ repo: "product"` per entry, `+ companion: null`, `+ workspace: null`;
   `close-decision feature paired-artifact-worktrees` → only `+ companion: null`;
   `ship-preflight feature paired-artifact-worktrees` → only `+ companion: null, +
   companionGaps: []`; `close-decision feature nosuch` (error path) → identical;
   `doctor --for close-session` → identical; `config` → identical apart from
   `pluginRoot`. Exactly the additive set listed in plan.md `## Risks` (plus the
   usage header text, expected from `## Approach` 3).
10. **Docs, policy, CHANGELOG** — **pass**. `grep -c 'code-workspace'` →
    `docs/concurrency.md: 2`, `docs/commands.md: 1`; `grep -c 'Workspace ('
    docs/hooks.md` → 1; `grep -c companion CHANGELOG.md` 17 → 30; policy §8 names
    the pair's workspace window, §11 step 2 allows the companion clone's worktree
    list for the four mutating commands; customizations test green.
11. **Full lint gate equal to baseline** — **pass** (table above: 185/185/0 ≥ 166,
    shellcheck silent, both replays 0).
12. **Initiative membership** — **pass**. Roadmap header `initiative:
    "external-artifact-repo"`; `node scripts/agento.mjs initiative
    external-artifact-repo` → `errors: []`, member `paired-artifact-worktrees`
    `state: in-review`, branch `feature/paired-artifact-worktrees`.

## Plan vs implementation

- Every `## Approach` item landed in the file the plan named; no undocumented
  files. 33 files, 2513+/263− (`git diff --stat origin/main...HEAD`), of which
  `scripts/hooks/*` are the two planned, approval-gated edits (one per file, each
  commit `7bcaed6`/`d8c8b15`).
- Deviation, documented: the guard regex uses the *observed* `Window (… <name>
  (Workspace) …)` title form plus the expected `Workspace (<name>)` form (plan.md
  step 4.1 probe, recorded in `## Research`) — the plan anticipated this.
- Deviation, documented in roadmap 3.5: `/agento continue` cannot read
  `workspace.exists` from the primary (the record's `workspace` is `null` there), so
  `secondary` opens `<path>.code-workspace` next to the located `worktrees[]` entry
  when the file exists. Correct given the CLI's shape.
- Deviation, minor, in docs/plan wording only: plan.md Research and
  [docs/architecture.md](../../../../docs/architecture.md) say zero/many anchoring
  matches yield `unmanaged`; the implementation (and its test at
  [agento.test.mjs L378](../../../../scripts/agento.test.mjs#L378)) yields *today's
  behaviour* — the clone as its own `primary`, its own halves as `plan`/`build` —
  which is what the plan's "today's behaviour" clause means. See Findings 2.
- `anchorRoot()` runs on every CLI invocation, in-repo mode included (one
  `readdir` of the primary's parent plus a config read per sibling git checkout).
  Bounded and side-effect free; byte-for-byte output preserved (item 9); noted, not
  a finding.

## Roadmap audit

All 21 ticked steps spot-checked against the code, tests, and commits:

- 1.1–1.2: config + session-state diffs and tests present (items 1, 3).
- 2.1–2.5: `anchorRoot`, `paths`, `session`/`next`, `close-decision`/`ship-preflight`,
  `doctor` (read-only `project-docs-worktrees` → `warn`, test at L486) all present
  with the named tests.
- 2.6: commit `18c3a87` body carries the diff summary as the step requires; my
  independent rerun (item 9) agrees with it.
- 3.1–3.5: mirrors empty, text as specified (item 5).
- 4.1: probe output quoted verbatim in plan.md `## Research`; 4.2–4.3: hook diffs,
  guard test, fixtures, session-context tests (items 7–8).
- 5.1–5.2: docs/policy/CHANGELOG diffs (item 10).
- 6.1: evidence file committed in `ecb9934`; 6.2: gate reproduced; 6.3: `status:
  in-review`, `next-step: ""`, 0 ahead, initiative CLI `in-review`.

No `(manual)` steps exist. No falsely ticked boxes; no repairs made. One imprecise
verify clause left as-is (step 2.1 says an unrelated repo reports `unmanaged`; a
standalone repo is its own `primary`, which is what the test asserts and what
today's code does — the intent, "no anchoring, no warning", holds).

## Findings

1. **Minor — typo in ship prompt.** [ship.prompt.md L20–L21](../../../../.github/prompts/ship.prompt.md#L20-L21)
   (mirrored in `commands/ship.md`) reads "Read the / the default branch". Cosmetic;
   fix in the next delivery that touches the prompt.
2. **Minor — anchoring fallback described as `unmanaged`.** plan.md `## Research`
   ("Decision — anchoring rule") and [docs/architecture.md](../../../../docs/architecture.md)
   "Companion-cwd anchoring" say zero or several matches yield `unmanaged`; the
   implementation and test keep today's classification of that checkout (its own
   `primary`, or its own managed worktree role). Doc wording only; behaviour is the
   safer one (no false `unmanaged` rejection of an in-repo project whose worktrees
   dir happens to end in `-worktrees`).
3. **Minor — companion half tracks `origin/<default>` in build mode.**
   [start-session.prompt.md](../../../../.github/prompts/start-session.prompt.md)
   build mode step 3 creates a missing companion branch with `git -C <artifactsRoot>
   worktree add -b <branch> <companion.worktree> origin/<default>`, which (git's
   default `branch.autoSetupMerge`) sets the new branch's upstream to `origin/main`
   — my `/tmp` re-drive printed `branch 'feature/pair-check' set up to track
   'origin/main'`. `describeCompanion()` then counts `ahead` against `origin/main`,
   which still flags every unpushed companion commit (the test "committed but never
   pushed" covers the no-upstream case; the tracking case is caught because those
   commits are not on `origin/main` either), and the guard denies pushes to the
   companion default. Not a correctness hole today; `start-freehand` already uses
   `--no-track`. Recommend the same flag here when `mirrored-artifact-branches`
   starts committing on the companion half. Follow-up below.

No security findings: the hook edits are limited to an additional read-only regex
over `code --status` output and a widened return tuple; no new subprocess inputs,
no secrets, no new write paths.

## Follow-ups

- `mirrored-artifact-branches`: add `--no-track` to the build-mode companion
  `worktree add -b <branch> … origin/<default>` in start-session (Finding 3), so the
  half never carries an `origin/<default>` upstream once artifacts are committed
  there.
- Fix the "Read the the" typo in `ship.prompt.md` / `commands/ship.md` (Finding 1)
  and align the anchoring-fallback wording in `docs/architecture.md` with the
  implemented "today's behaviour" (Finding 2) in the next delivery touching those
  files.
