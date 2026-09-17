# Review: mirrored-artifact-branches

Verdict: request-changes

Review round 1, at `2ab19e8` on `feature/mirrored-artifact-branches` (draft PR #43,
`state: OPEN`, `isDraft: true`, `feature/mirrored-artifact-branches` → `main`),
2026-09-17. This promoted planning worktree (`plan-20260917-005647`, `role: build`,
`delivery.slug: mirrored-artifact-branches`, `lifecycle: in-review`) owns the branch
per `agento.mjs session` (`worktrees[]`: primary `/home/david/DP/agento` on `main`,
this entry on the branch, no other; `companion: null`, in-repo layout). `doctor --for
review-feature` → `ok` (node v22.22.3, origin reachable, gh 2.45.0 authenticated,
python3 3.12.3, worktrees-dir writable, artifact-repo in-repo); no `Preflight:` line.
`resolve feature mirrored-artifact-branches` → `status: ok`, `source: local`,
`artifactPr: null`. `git fetch origin` then `git merge-base --is-ancestor origin/main
HEAD` → 0 (`origin/main` = `1aa6f5e`); 14 commits ahead of `origin/main`, `git status
--porcelain` empty, 0 ahead of upstream. Skills consulted: none — no matching domain
(no `.agents/skills/`, no `## Agento` skills table in AGENTS.md).

Nothing in this delivery is served behaviour; no `local:`/`dev-stack`/`preview`
target applies, so no browser drive was needed. The user-visible surface is the CLI
JSON and the agent/prompt/instruction prose, re-driven below on a throwaway /tmp
product+companion pair (bare origins, product `.github/agento.json` with
`artifacts.repo.name: "project-docs"`), never against this repository's own config.

## Lint gate (policy §5, Reviewer half)

Fresh run at `2ab19e8`, compared with the plan.md baseline at `a6d2903` (185/185/0,
shellcheck silent, both replays exit 0):

| Command | Exit | Result |
|---|---|---|
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | `# tests 188`, `# pass 188`, `# fail 0` (+3 over baseline, all this delivery's CLI tests; matches the Builder's 188/188/0) |
| `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` | 0 | silent |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | every fixture matches |
| `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh < tests/guard-fixtures-companion.txt` | 0 | every fixture matches |

Full gate, no new or undocumented findings.

## Acceptance checklist results

1. **Planner creates the mirrored companion branch right after the product branch**
   — **pass**. `grep -c 'switch -c'` → `delivery-planner.agent.md:1`,
   `new-feature.prompt.md:1`, `new-issue.prompt.md:1`; `grep -c 'no-track'
   start-session.prompt.md` → `1`. Re-driven on the /tmp pair: after `git -C <plan>
   switch -c feature/rv` then `git -C <half> switch -c feature/rv` from the detached
   `origin/main`, `session` from the plan half reports `companion: { branch:
   "feature/rv", detached: false, dirty: false, ahead: 0, registered: true }` and
   `git -C <half> rev-parse --abbrev-ref @{upstream}` fails (no upstream); `git -C
   <docs> worktree add --no-track -b feature/nt <half2> origin/main` likewise leaves
   `@{upstream}` unset.
2. **Draft companion PR `docs(<type>): <slug>` recorded as `artifact-pr`** — **pass**.
   `grep -c 'docs(<type>): <slug>'` → `1`/`1`/`1` across the Planner agent and both
   prompts; `grep -c 'artifact-pr'` → `delivery-planner.agent.md:2`,
   `delivery-artifacts.instructions.md:2` (header line 59 + prose line 67).
3. **`artifactPr` on `status`, `resolve`, `find`, `session.delivery`, `initiative`
   members, `next` candidates, including a companion-origin-only roadmap** —
   **fail** (one surface missing). `node --test scripts/agento.test.mjs` exit 0 with
   the `artifactPr: "#7"` assertions; `status`, `resolve`, `find`, `session.delivery`,
   `next` and `next.candidates[]` verified (in-repo diff below and /tmp drive §H:
   `resolve feature rv` → `source: remote`, `artifactPr: "#7"`; `next rv` →
   `artifactPr: "#7"`). But `initiative` members do **not** carry it: `deriveInitiative`
   ([scripts/agento.mjs](../../../../scripts/agento.mjs#L664-L677)) projects
   `slug/state/roadmap/branch/requires/recommendedAfter/wave/computedWave/order/
   blockedBy/ready` only, and `node scripts/agento.mjs initiative external-artifact-repo
   | grep -c artifactPr` → `0`. The claim is repeated in CHANGELOG.md line 19,
   docs/commands.md line 98, delivery-artifacts.instructions.md line 70, and roadmap
   step 1.3 — see Finding 3 and added step 1.6.
4. **`session --pr` reports `companionPr`** — **pass**. `node --test
   scripts/agento.test.mjs scripts/session-state.test.mjs` exit 0 (the new test asserts
   one `gh pr view` in-repo, two in companion mode — the second with cwd the companion
   clone — and the `companionPr:` warning on failure); `node scripts/agento.mjs session
   --pr` in this checkout prints `"companionPr": null`.
5. **A promoted plan pair is one delivery** — **pass**. Pair tests green; /tmp drive
   §G: `session` from the product half and from the companion half yield identical
   `delivery` (`rv`, `feature/rv`, `in-review`, `artifactPr: "#7"`),
   `companion.branch === delivery.branch`, `companion.ahead: 0`, `companion.dirty:
   false`, `worktrees[]` tagged `[product main primary] [product feature/rv build]
   [companion main unmanaged] [companion feature/rv build]`; §E with the roadmap
   committed only in the half: `lifecycle: planned`, `allowed` contains
   `/agento build-feature rv`, `next` from the half emits `/agento build-feature rv`
   with `artifactPr: "#7"` and the `anchored-from-companion` warning.
   `evidence/step-2-4-pair-drive.txt` matches.
6. **Builder, Reviewer, Architect, triage write and commit in the companion half** —
   **pass on the stated check**, with two prose defects (Findings 1 and 2).
   `grep -c 'companion'` → builder 18, reviewer 16, architect 14, autopilot 2, policy
   16, concurrent-delivery 8, triage-followups 6, delivery-status 8; `grep -c
   'edit-last' delivery-reviewer.agent.md` → `1`.
7. **Command mirror intact** — **pass**. Every `cmp .github/prompts/<n>.prompt.md
   commands/<n>.md` silent, `diff <(ls commands) <(ls .github/prompts | sed …)` empty,
   `node --test tests/customizations.test.mjs` → 19/19/0.
8. **Documentation states the two-PR flow, header, `companionPr`, both-defaults, interim
   ship limitation** — **pass**. `grep -c 'artifact-pr\|companionPr'` →
   `docs/commands.md:5`, `docs/artifacts.md:2`, `CHANGELOG.md:2`; `grep -c 'both'
   docs/concurrency.md` → `6`; docs/commands.md "Mirrored artifact branches" section
   and CHANGELOG state the `ship-dual-merge` interim.
9. **Full-repository gate green against the §5 baseline** — **pass** (table above).
10. **In-repo layout unchanged** — **pass**. `origin/main`'s `scripts/` extracted to
    `/tmp/agento-main` and run against this checkout with `--root $PWD`, diffed against
    HEAD's CLI: `session` → only `+ "artifactPr": null` and `+ "companionPr": null`;
    `status` → one `+ "artifactPr": null` per item (16); `resolve`, `find`, `next` →
    `+ "artifactPr": null` (plus `next.dispatch` paths and `config.pluginRoot`, which
    differ only because the baseline copy lives in /tmp); `paths feature xw`,
    `close-decision`, `ship-preflight`, `initiative external-artifact-repo` →
    byte-identical. `session --pr` in-repo makes exactly one `gh pr view` call
    (test-asserted).

**Score: 9 pass, 1 fail.**

## Plan vs implementation

- Approach steps 1–5 are implemented as prose (Planner/Builder/Reviewer/Architect/
  triage/status/start-session) plus the CLI additions (`artifactPr` on describe
  records, `companionPr` on `session --pr`, `allRoadmaps(typeFilter, half)` reading the
  registered companion half with precedence over the clone). Step 3.1 (ship merge
  gate) is correctly struck as `ship-dual-merge` scope; docs and CHANGELOG state the
  interim.
- Undocumented gap: `initiative` members lack `artifactPr` while four documents say
  otherwise (Finding 3).
- Deviation from prior members' convention: primary-window commands (start-session,
  close-session, ship) detect companion mode from `agento.mjs paths` / `config`
  (`artifactsRoot`), but this delivery's Architect, `/agento new-initiative`, and
  `/agento triage-followups` text keys off the session record's `companion`, which is
  `null` from the primary by design (Finding 1).
- `--repo <artifacts.repo.name>` is used as if `artifacts.repo.name` were a GitHub
  `OWNER/REPO`; the CLI defines it as the sibling directory basename (Finding 2).
- Companion-mode gh calls (`pr create`, `pr edit`, `pr comment`) were simulated in the
  Builder's drive and in mine — there is no GitHub for the /tmp pair; the CLI's
  `companionPr` path is covered by the stubbed-`gh` test instead.

## Roadmap audit

12 ticked / 12 at review start; every tick spot-checked:

- 1.1 — genuine repair: the 2026-09-16 unticking is recorded on the step and the
  re-scoped work exists (`switch -c` in the Planner and both prompts, `--no-track` in
  start-session build mode step 3, `cmp` silent, and the /tmp drive above reproduces
  both the `switch -c` promotion and the `--no-track` no-upstream behaviour).
- 1.2, 1.4, 1.5 — the named tests exist in `scripts/agento.test.mjs` ("a plan pair
  promoted on both halves is one delivery from either side", the extended
  companion-origin fallback test with `artifact-pr`, "session and next read the
  delivery roadmap from the registered companion half") and pass.
- 1.3 — the header, `header()` parsing, `session --pr` `companionPr`, and the tests
  are real; the `initiative` features claim in the step text is not (Finding 3).
  Left ticked with an annotation; the gap is carried by the added step 1.6 rather
  than re-doing the rest.
- 2.1, 2.2, 2.3 — prose present in every named file; `customizations.test.mjs`
  green. 2.3's Architect/triage text has the trigger and `--repo` defects (Findings
  1–2), carried by the added step 2.5.
- 2.4 — evidence transcript present and consistent with my re-drive.
- 3.1 — struck with a documented reason; 3.2 — docs present, gate re-run matches;
  3.3 — `initiative external-artifact-repo` lists `mirrored-artifact-branches` as
  `in-review` with `errors: []`, `origin/main` is an ancestor.

Repairs made (this review): added `1.6 (added 2026-09-17)` and `2.5 (added
2026-09-17)`; annotated 1.3; `next-step` now points at 1.6; `last-updated` bumped.
No falsely ticked box was unticked — the two gaps are additive missing work.

## Findings

1. **Moderate — companion mode is undetectable from the primary window as written.**
   [initiative-architect.agent.md](../../../../.github/agents/initiative-architect.agent.md#L44),
   [new-initiative.prompt.md](../../../../.github/prompts/new-initiative.prompt.md#L49),
   and [triage-followups.prompt.md](../../../../.github/prompts/triage-followups.prompt.md#L26)
   define companion mode as "the session record's `companion` is not `null`" and
   route every git/gh step through `companion.path`. `pairFor()`
   ([session-state.mjs](../../../../scripts/session-state.mjs#L141-L152)) returns
   `null` for any non-managed worktree, so from the primary — the only window those
   three commands run in — `companion` is always `null` even with `artifacts.repo`
   set (docs/commands.md says so; my /tmp drive §A: `role: primary`, `companion:
   null`, `workspace: null` with `artifacts.repo.name` configured). Result: in
   companion mode the Architect would branch, commit, and open its PR in the
   product checkout and never in the companion; triage would likewise. Fix: detect
   via `agento.mjs config` (`config.artifacts.repo.name`/`dir` non-null, or
   `artifactsRoot !== root`) or `doctor`'s `artifact-repo` check, and address the
   clone as `artifactsRoot` (the convention start-session/close-session/ship already
   use), not `companion.path`. `delivery-status.prompt.md` step 3 ("in companion
   mode run the same listing…") should name the same trigger.
2. **Moderate — `--repo <artifacts.repo.name>` is not an `OWNER/REPO`.**
   `artifacts.repo.name` is the sibling companion directory's basename
   ([agento-config.mjs](../../../../scripts/agento-config.mjs#L61-L63),
   docs/project-profile.md line 34, e.g. `agento-docs`), but
   [initiative-architect.agent.md](../../../../.github/agents/initiative-architect.agent.md#L118-L120),
   [triage-followups.prompt.md](../../../../.github/prompts/triage-followups.prompt.md#L79-L81),
   [delivery-status.prompt.md](../../../../.github/prompts/delivery-status.prompt.md#L36),
   [new-initiative.prompt.md](../../../../.github/prompts/new-initiative.prompt.md#L51),
   and `scripts/wait-for-checks.sh pr <n> --repo <artifacts.repo.name>` pass it to
   `gh --repo`, which requires `[HOST/]OWNER/REPO` and will reject a bare name. The
   Planner's step 8.3 hedges ("owner/name from the companion's origin") but still
   labels it `artifacts.repo.name`. Fix: run `gh` with its cwd inside the companion
   clone (it infers the repository from `origin`) or derive `gh repo view --json
   nameWithOwner -q .nameWithOwner` there once and use that value for `--repo` and
   `wait-for-checks.sh`.
3. **Minor — `initiative` members do not carry `artifactPr`.** Claimed in
   [CHANGELOG.md](../../../../CHANGELOG.md#L19),
   [docs/commands.md](../../../../docs/commands.md#L98),
   [delivery-artifacts.instructions.md](../../../../.github/instructions/delivery-artifacts.instructions.md#L70),
   plan acceptance item 3, and roadmap 1.3; not implemented in `deriveInitiative`
   ([scripts/agento.mjs](../../../../scripts/agento.mjs#L664-L677)) and no test asserts
   it. Either add `artifactPr: roadmap?.artifactPr ?? null` to the member record with
   a test, or drop `initiative` from the four claims. Scored as the failing acceptance
   item above.
4. **Minor — `status` omits branch-only roadmaps in companion mode.** `status` still
   walks only the companion clone (`allRoadmaps(typeFilter)` without a half), so a
   roadmap that exists only on the mirrored branch is visible to
   `resolve`/`find`/`next`/`session` but not `status` (/tmp drive §H: `status items:
   []` while `resolve` is `source: remote`). Already recorded by the Builder in step
   2.4 and the follow-ups; noted here because `/agento delivery-status` in companion
   mode will under-report until it is decided.
5. **Minor — duplicate `gh --version` probe** per `session --pr` in companion mode
   (already a follow-up).

No security findings: `lookupPullRequest` passes the branch as an `execFileSync`
argument (no shell), `header()` builds its regex from constant keys only, and no
secrets are read or printed. Git rules honoured: no pushes to `main`, no rebase, merge
integration of `origin/main` (`1aa6f5e`) present.

## Follow-ups

- `ship-dual-merge` (initiative member): `ship-preflight` gains `{ product, companion
  }` PR blocks read from `artifact-pr`; `/agento ship` merges the code PR first, then
  the companion PR, and its audit rejects a companion PR that is missing, closed, or
  not mergeable. Until then `/agento ship` in companion mode merges only the code PR
  and leaves the companion PR open (docs/commands.md, CHANGELOG).
- `ship-dual-merge`: `close-decision`/`ship-preflight` should also report a companion
  branch whose `origin/<branch>` is behind the half (not just dirty/ahead).
- `ship-dual-merge`: it needs the companion's GitHub `OWNER/REPO`; once Finding 2 is
  fixed, reuse the same derivation there rather than a second one.
- `artifact-history-migration` (initiative member): decide whether `status` should
  walk registered companion halves too (Finding 4).
- `session --pr` runs `gh --version` once per lookup; a shared probe would save a spawn.
