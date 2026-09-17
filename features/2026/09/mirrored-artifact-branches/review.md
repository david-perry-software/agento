# Review: mirrored-artifact-branches

Verdict: approve

Review round 2, at `158b96c` on `feature/mirrored-artifact-branches` (draft PR #43,
`state: OPEN`, `isDraft: true`, `feature/mirrored-artifact-branches` → `main`,
`headRefOid` = `158b96c`), 2026-09-17, invoked by the Autopilot. This promoted
planning worktree (`plan-20260917-005647`, `role: build`, `delivery.slug:
mirrored-artifact-branches`, `lifecycle: in-review`, `steps: 14/14`) owns the branch
per `agento.mjs session` (`worktrees[]`: primary `/home/david/DP/agento` on `main`,
this entry on the branch, no other; `companion: null`, in-repo layout). `doctor --for
review-feature` → `ok` (node v22.22.3, origin reachable, gh 2.45.0 authenticated,
python3 3.12.3, worktrees-dir writable, artifact-repo in-repo); no `Preflight:` line.
`resolve feature mirrored-artifact-branches` → `status: ok`, `source: local`,
`artifactPr: null`. `git fetch origin` then `git merge-base --is-ancestor origin/main
HEAD` → 0; `git status --porcelain` empty; HEAD equals
`origin/feature/mirrored-artifact-branches`. Skills consulted: none — no matching
domain (no `.agents/skills/`, no `## Agento` skills table in AGENTS.md).

Nothing in this delivery is served behaviour; no `local:`/`dev-stack`/`preview`
target applies, so no browser drive was needed. The user-visible surface is the CLI
JSON and the agent/prompt/instruction prose, re-driven below on a fresh throwaway
/tmp product+companion pair (bare origins, product `.github/agento.json` with
`artifacts.repo.name: "prod-docs"`, script `/tmp/rv2-drive.sh`), never against this
repository's own config and never touching `agento-docs`.

## Round-1 fixes (commits `1721534..158b96c`)

`git log --oneline 1721534..HEAD`: `35aa5a9` (roadmap resume), `7f8dcd0` step 1.6,
`2bbde32` step 2.5, `158b96c` (roadmap back to in-review). `git diff 1721534...HEAD
--stat`: 12 files, +110/−58 — Planner, Architect, delivery-status, new-initiative,
triage-followups (+ their three `commands/` mirrors), docs/commands.md, roadmap.md,
`scripts/agento.mjs` (+1 line), `scripts/agento.test.mjs` (+5/−1). No other file
changed since round 1.

1. **Finding 1 (moderate) — companion trigger from the primary window: fixed.**
   [initiative-architect.agent.md](../../../../.github/agents/initiative-architect.agent.md#L44-L57),
   [new-initiative.prompt.md](../../../../.github/prompts/new-initiative.prompt.md#L49-L55),
   [triage-followups.prompt.md](../../../../.github/prompts/triage-followups.prompt.md#L26-L39),
   and [delivery-status.prompt.md](../../../../.github/prompts/delivery-status.prompt.md#L33-L41)
   step 3 now define companion mode as "`agento.mjs config` reports `artifactsRoot`
   different from `root`", state explicitly that the session record's `companion` is
   `null` in the primary window and is not the trigger, and address the clone as
   `artifactsRoot` (`git -C <artifactsRoot>`). `grep -c 'companion. is not .null'` →
   0 / 0 / 0 for Architect, new-initiative, triage; `grep -n 'companion.path'` in
   the four primary-window files → only delivery-status line 24, which describes the
   *display* of a non-null record in a build window (correct there). The Architect's
   step 1 precondition switched from `companion.dirty/ahead` to `git -C
   <artifactsRoot> status --short --branch`, which is readable from the primary.
   /tmp drive §B from the product primary: `session` → `role: primary`, `companion:
   null`; `config` → `root: …/prod`, `artifactsRoot: …/prod-docs`, `artifactsRoot
   !== root: true`; `doctor` `artifact-repo` → `ok`, `…/prod-docs (prod-docs),
   origin …/prod-docs.git, main present` — exactly the condition the prose names.
   §F on a plain in-repo clone: `artifactsRoot === root: true`, `companion: null`.
2. **Finding 2 (moderate) — `--repo <artifacts.repo.name>`: fixed.** `grep -rn --
   '--repo <artifacts.repo.name'` across `.github docs commands scripts templates
   README.md CHANGELOG.md` → no match. Architect, new-initiative, and triage now run
   `gh` from inside the clone (`cd <artifactsRoot> && gh …`) or pass `--repo
   <companion-repo>` derived once via `gh repo view --json nameWithOwner -q
   .nameWithOwner` (`grep -c nameWithOwner` → 1 each); delivery-status uses `cd
   <artifactsRoot> && gh pr list …`; the Planner's step 8.3 became `cd
   <companion.path> && gh pr create --draft …` (correct in the build window, where
   `companion` is populated) and names `artifacts.repo.name` as a directory
   basename, never a `--repo` value. `scripts/wait-for-checks.sh` already documented
   `--repo OWNER/NAME` (lines 8–9) and only forwards it. /tmp drive §C confirms the
   defect it replaces: `config.artifacts.repo.name` = `prod-docs` =
   `basename(artifactsRoot)`; `gh pr list --repo prod-docs` → exit 1, `expected the
   "[HOST/]OWNER/REPO" format, got "prod-docs"`. The `nameWithOwner` derivation
   itself needs a GitHub remote and could not be executed against the local bare
   origins; its syntax is standard `gh repo view` usage.
3. **Finding 3 (minor) — `initiative` members lack `artifactPr`: fixed (option A).**
   [scripts/agento.mjs](../../../../scripts/agento.mjs#L670) `deriveInitiative` adds
   `artifactPr: roadmap?.artifactPr ?? null`; the `initiative` test asserts `[null,
   null, null]` before and `[null, "#7", null]` after a member gains an `artifact-pr:
   "#7"` header. `node scripts/agento.mjs initiative external-artifact-repo | grep -c
   artifactPr` → 7 (one per member, all `null` — no header in this repo). /tmp drive
   §D from the product primary with a breakdown and roadmap committed only in the
   companion clone: `[["aa","unplanned",null],["bb","in-review","#7"]]`, `errors: []`;
   `status` on the same pair → `[["bb","#7"]]`.

## Lint gate (policy §5, Reviewer half)

Fresh run at `158b96c`, compared with the plan.md baseline at `a6d2903` (185/185/0,
shellcheck silent, both replays exit 0):

| Command | Exit | Result |
|---|---|---|
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | `# tests 188`, `# pass 188`, `# fail 0` (+3 over baseline, all this delivery's CLI tests; the extended `initiative` assertions live inside an existing test) |
| `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` | 0 | silent |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | 104 lines, every fixture matches (the single `mismatch` grep hit is the fixture-file comment echoed on line 2) |
| `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh < tests/guard-fixtures-companion.txt` | 0 | 45 lines, every fixture matches |
| `cmp .github/prompts/<n>.prompt.md commands/<n>.md` for all 24 | 0 | 0 mismatches; `diff <(ls commands) <(ls .github/prompts \| sed …)` empty |

Full gate, no new or undocumented findings.

## Acceptance checklist results

1. **Planner creates the mirrored companion branch right after the product branch**
   — **pass**. `grep -c 'switch -c'` → `delivery-planner.agent.md:1`,
   `new-feature.prompt.md:1`, `new-issue.prompt.md:1`; `grep -c 'no-track'
   start-session.prompt.md` → `1`. /tmp drive §E: `switch -c feature/rv2` in both
   halves from detached `origin/main`, then `session` from the product half →
   `companion.branch: feature/rv2, dirty: false, ahead: 0`.
2. **Draft companion PR `docs(<type>): <slug>` recorded as `artifact-pr`** — **pass**.
   `grep -c 'docs(<type>): <slug>'` → `1`/`1`/`1` (Planner agent, both prompts);
   `grep -c 'artifact-pr'` → `delivery-planner.agent.md:2`,
   `delivery-artifacts.instructions.md:2`. Planner step 8.3 now runs `gh pr create`
   inside the companion half (Finding 2 fix).
3. **`artifactPr` on `status`, `resolve`, `find`, `session.delivery`, `initiative`
   members, `next` candidates, including a companion-origin-only roadmap** — **pass**
   (round-1 fail, now closed). `node --test scripts/agento.test.mjs` exit 0 with the
   `artifactPr: "#7"` assertions including the new `initiative` ones; /tmp drive §D
   (`initiative demo` → `"#7"` on `bb`; `status` → `[["bb","#7"]]`), §E (`resolve
   feature rv2` from the primary → `ok remote #9`; `next rv2` → `artifactPr: "#9"`;
   `session.delivery.artifactPr: "#9"` from both halves).
4. **`session --pr` reports `companionPr`** — **pass**. Tests green (one `gh pr view`
   in-repo, two in companion mode, `companionPr:` warning on failure); `node
   scripts/agento.mjs session --pr` here prints `"companionPr": null` beside `"pr":
   {…}`.
5. **A promoted plan pair is one delivery** — **pass**. /tmp drive §E: from the
   product half `build rv2 feature/rv2 #9 companion=feature/rv2 dirty=false ahead=0
   lifecycle=building`; from the companion half `build rv2 feature/rv2 #9
   companion=feature/rv2 lifecycle=building`; `allowed` = `["/agento continue",
   "/agento build-feature rv2", "/agento delivery-status"]` with the roadmap committed
   only in the companion half. Pair tests green; `evidence/step-2-4-pair-drive.txt`
   consistent.
6. **Builder, Reviewer, Architect, triage write and commit in the companion half** —
   **pass** (round-1 prose defects resolved). `grep -c 'companion'` → builder 18,
   reviewer 16, architect 11, autopilot 2, policy 16, concurrent-delivery 8,
   triage-followups 7, delivery-status 10; `grep -c 'edit-last'
   delivery-reviewer.agent.md` → `1`. Primary-window writers now use the `config`
   trigger and `artifactsRoot` (Finding 1); build-window writers keep
   `companion.path`.
7. **Command mirror intact** — **pass**. 24/24 `cmp` silent, listing diff empty,
   `tests/customizations.test.mjs` included in the 188/188/0 run.
8. **Documentation states the two-PR flow, header, `companionPr`, both-defaults, interim
   ship limitation** — **pass**. `grep -c 'artifact-pr\|companionPr'` →
   `docs/commands.md:5`, `docs/artifacts.md:2`, `CHANGELOG.md:2`; `grep -c 'both'
   docs/concurrency.md` → `6`; docs/commands.md line 114 and CHANGELOG line 25 state
   the `ship-dual-merge` interim; docs/commands.md lines 105–112 now also describe the
   primary-window `config` trigger and the `nameWithOwner` rule.
9. **Full-repository gate green against the §5 baseline** — **pass** (table above).
10. **In-repo layout unchanged** — **pass**. /tmp drive §F on a plain clone without
    `artifacts.repo`: `companion: null`, `delivery: null`, `lifecycle: no-delivery`,
    `artifactsRoot === root`; `session --pr` here → `companionPr: null`; the round-1
    baseline-vs-HEAD CLI diff (only `+ "artifactPr": null` / `+ "companionPr": null`
    additions) is unchanged by round 2, whose only CLI delta is the one
    `deriveInitiative` line, which yields `null` without a header (`initiative
    external-artifact-repo` → 7 × `null`, `errors: []`).

**Score: 10 pass, 0 fail.**

## Plan vs implementation

- Approach steps 1–5 are implemented as prose (Planner/Builder/Reviewer/Architect/
  triage/status/start-session) plus the CLI additions (`artifactPr` on every describe
  record including `initiative` members, `companionPr` on `session --pr`,
  `allRoadmaps(typeFilter, half)` reading the registered companion half with
  precedence over the clone).
- Round-1 deviations resolved: primary-window commands now share the
  `start-session`/`close-session`/`ship` convention (`config` → `artifactsRoot`);
  `gh` runs from inside the companion clone or with a derived `nameWithOwner`.
- Companion-mode gh calls (`pr create`, `pr edit`, `pr comment`, `repo view`) remain
  simulated in the /tmp drives — there is no GitHub for the bare origins; the CLI's
  `companionPr` path is covered by the stubbed-`gh` test.
- Step 3.1 is correctly struck: the breakdown's `### ship-dual-merge` block
  ([breakdown.md](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md#L282-L306))
  assigns `ship-preflight { product, companion }`, the code-then-companion merge
  order, and the companion merge gate to that member; the strike text says so, and
  docs/commands.md + CHANGELOG state the interim behaviour.

## Roadmap audit

14 ticked / 14 (13 ticks + 1 struck); every tick spot-checked:

- 1.1, 1.2, 1.4, 1.5 — unchanged since round 1, re-verified (greps above, named
  tests present and green, /tmp §E reproduces the promotion and the branch-only
  roadmap read).
- 1.3 — the round-1 annotation ("except `initiative` features … carried by 1.6")
  remains accurate as history; 1.6 closes it.
- 1.6 — genuine: `deriveInitiative` line + test assertions, `grep -c artifactPr` → 7,
  `node --test scripts/agento.test.mjs` green (inside the 188 run). Done-note matches.
- 2.1, 2.2, 2.4 — unchanged, re-verified.
- 2.3 — the trigger/`--repo` defects it carried are closed by 2.5.
- 2.5 — genuine: both verify greps 0/empty, mirrors silent, customizations green,
  /tmp §B reproduces `session companion: null` + `config artifactsRoot ≠ root` from
  the product primary. Done-note matches (`wait-for-checks.sh` already documents
  `--repo OWNER/NAME`).
- 3.1 — struck, legitimate and documented (above). 3.2 — docs present, gate re-run
  matches. 3.3 — `initiative external-artifact-repo` lists
  `mirrored-artifact-branches` as `in-review`, `errors: []`; `origin/main` is an
  ancestor.

No repairs needed this round: no falsely ticked box, no missing work. `next-step: ""`
and `status: in-review` are correct for approval.

## Findings

No finding above minor severity remains.

1. **Minor — `status` omits branch-only roadmaps in companion mode** (round-1
   Finding 4, unchanged). `status` walks only the companion clone; /tmp §D shows it
   does see clone-committed roadmaps (`bb` → `#7`), but a roadmap that exists only on
   a mirrored branch is visible to `resolve`/`find`/`next`/`session` and not `status`.
   Recorded in step 2.4 and the follow-ups for `artifact-history-migration`.
2. **Minor — duplicate `gh --version` probe** per `session --pr` in companion mode
   (already a follow-up).
3. **Minor — `nameWithOwner` derivation untested end to end.** The prose is correct
   and standard, but no test or drive executes `gh repo view --json nameWithOwner`
   against a real companion remote; `ship-dual-merge` will exercise it for real and
   should reuse the same derivation (follow-up recorded).

No security findings: `lookupPullRequest` passes the branch as an `execFileSync`
argument (no shell), `header()` builds its regex from constant keys only, the one new
CLI line reads an already-parsed header, and no secrets are read or printed. Git
rules honoured: no pushes to `main`, no rebase, `origin/main` integrated by merge.

## Follow-ups

- `ship-dual-merge` (initiative member): `ship-preflight` gains `{ product, companion
  }` PR blocks read from `artifact-pr`; `/agento ship` merges the code PR first, then
  the companion PR, and its audit rejects a companion PR that is missing, closed, or
  not mergeable. Until then `/agento ship` in companion mode merges only the code PR
  and leaves the companion PR open (docs/commands.md, CHANGELOG).
- `ship-dual-merge`: `close-decision`/`ship-preflight` should also report a companion
  branch whose `origin/<branch>` is behind the half (not just dirty/ahead).
- `ship-dual-merge`: reuse the Architect/triage `gh repo view --json nameWithOwner`
  derivation for the companion `OWNER/REPO` rather than a second one.
- `artifact-history-migration` (initiative member): decide whether `status` should
  walk registered companion halves too (Finding 1).
- `session --pr` runs `gh --version` once per lookup; a shared probe would save a spawn.

