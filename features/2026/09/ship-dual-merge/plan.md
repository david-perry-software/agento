# Ship dual merge: `/agento ship` merges the code PR and the companion PR

## Problem

In companion mode (`artifacts.repo` set) a delivery is one slug on two branches of
the same name: the product repository's `feature/<slug>` carries the code and the
companion repository's `feature/<slug>` carries `plan.md`, `roadmap.md`, `review.md`,
and `evidence/`, each with its own draft PR (the companion PR number sits in the
roadmap header as `artifact-pr: "#<n>"`). Today `/agento ship` merges only the code
PR and leaves the companion PR open for the user to merge by hand — the interim
limitation stated in [docs/commands.md](../../../../docs/commands.md) and
[CHANGELOG.md](../../../../CHANGELOG.md). Until both merge, the companion default
branch never receives `status: complete`, `agento.mjs initiative` keeps the member
`in-review`, and the mirrored branch and its worktree half linger.

This feature is the wave-4 member `ship-dual-merge` of initiative
`external-artifact-repo`
([breakdown.md](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md),
block `### ship-dual-merge`; Decision 4: "b, yes merge both"). After it, `/agento
ship` audits both halves, writes `status: complete` in the companion, marks both PRs
ready, merges the code PR then the companion PR through their rulesets, syncs both
default branches, tears the pair down, and lands post-ship evidence on the
companion's `post-ship/<slug>`. With `artifacts.repo` unset, behaviour is
byte-for-byte today's in-repo flow.

## Decisions

- **Q1 — How should `ship-preflight` expose the two PRs?** A: *Additive: keep
  today's fields, add `--pr`* — keep `owner`, `companion`, `companionGaps`,
  `resolutionSource` as-is; a new `--pr` flag (like `session --pr`) adds `pr` and
  `companionPr` via `gh`, and companion PR problems (`missing-pr`, `pr-not-open`,
  `conflicting-pr`) join `companionGaps[]`. No consumer breaks.
- **Q2 — When the code PR merges but the companion merge fails, how should the
  re-send recover?** A: *Resume at companion merge from gh state* — the re-send
  reads `pr.state === MERGED` and `companionPr.state === OPEN` from `ship-preflight
  --pr`, skips the code merge, and resumes at the companion merge; the §9
  idempotency row gains this case. Teardown and `main` sync wait until both are
  merged.
- **Q3 — Include the deferred follow-up: flag a companion half whose HEAD is behind
  `origin/<branch>` as a gap?** A: *Yes, add `behind` to `companionGaps`* — one
  `rev-list --count HEAD..@{upstream}` read in `describeCompanion` and a `behind`
  gap for both `ship-preflight` and `close-decision`.
- **Q4 — Should `/agento delivery-status` (and `session --pr` lifecycle) warn when
  the code PR is merged but the companion PR is still open?** A: *Yes, in scope* —
  add a `companion-pr-open` warning in `deriveLifecycle` when `pr.state === MERGED`
  and `companionPr.state === OPEN`; lifecycle stays `in-review`.
- **Q5 — How should the dual merge be verified before review?** A: */tmp pair with
  simulated gh + unit tests* — same approach as mirrored-artifact-branches step 2.4:
  bare origins, a stub `gh` on `PATH` logging its calls, transcript saved under
  `evidence/`. No GitHub resources created.

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/`
directory and AGENTS.md has no `## Agento` skills table).

### Lint baseline (policy §5)

Run from the planning worktree at `origin/main` `9b59f66` (2026-09-17):

- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0; `# tests
  188`, `# pass 188`, `# fail 0`
- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0; no output
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0
- `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh <
  tests/guard-fixtures-companion.txt` → exit 0

Fully green baseline → no overlap, no scoped gate: the full-repository gate stays in
force and is rerun at the end of the roadmap against these numbers. Note for the
Builder: the delivery guard denies shell redirections (`> file`) on a command line
that also names a hook script; run the replay lines without redirection.

### Open delivery branches

`gh pr list --state open --json number,headRefName` → `[]` (2026-09-17). No
concurrent delivery touches the files below.

### Codebase findings

- **`ship-preflight` already carries the companion half but not the PRs.**
  [scripts/agento.mjs](../../../../scripts/agento.mjs) `case "ship-preflight"`
  (≈L830) calls `evaluateShipPreflight()` from
  [scripts/delivery-roadmap-resolver.mjs](../../../../scripts/delivery-roadmap-resolver.mjs)
  (`{ status, resolutionSource, branch, owner, message }`) and spreads on
  `companion` (`companionOfOwner(owner)` → `{ path, branch, detached, dirty, ahead,
  registered } | null`) and `companionGaps(companion)` (`dirty`, `unpushed`).
  `describeCompanion()` (≈L182) reads `status --porcelain` and `rev-list --count
  @{upstream}..HEAD`; it has no `behind` reading (Decision Q3 adds
  `rev-list --count HEAD..@{upstream}`).
- **PR lookup is reusable.** `lookupPullRequest(branch, { cwd, label })` (≈L341)
  runs `gh pr view <branch> --json number,state,isDraft,mergeStateStatus,url` and
  degrades to `{ pr: null, warnings: [...] }`; `lookupCompanionPullRequest(branch)`
  runs it inside the companion clone (`artifactsRoot`) and returns `null` with no
  `gh` call in the in-repo layout. `parseArgs()` (L56) already understands `--pr`
  (`options.pr`), used only by `session` today (L919–920). `ship-preflight --pr`
  reuses both helpers verbatim.
- **Lifecycle warnings live in one place.**
  [scripts/session-state.mjs](../../../../scripts/session-state.mjs)
  `deriveLifecycle({ delivery, pr })` (L226–254) pushes `merged-but-not-complete`
  when `pr.state === "MERGED"` and the roadmap is not `complete`; Decision Q4 adds
  a `companionPr` parameter and a `companion-pr-open` warning next to it. Callers:
  `session` (agento.mjs ≈L921) and `next`; `delivery-status.prompt.md` L23 prints
  `warnings[]` verbatim and L25 shows `companionPr` beside `pr`.
- **The ship prompt is half-way there.**
  [.github/prompts/ship.prompt.md](../../../../.github/prompts/ship.prompt.md)
  (mirrored byte-for-byte to [commands/ship.md](../../../../commands/ship.md))
  already: reads `companion` and `companionGaps[]` from `ship-preflight`, treats a
  non-empty `companionGaps[]` as hard-reject, and tears down the companion half and
  the `.code-workspace` file. It does **not**: read roadmap/review from the
  companion's `origin/<branch>`, commit `status: complete` in the companion half,
  mark/merge the companion PR, sync the companion default, or run the post-ship
  epilogue in the companion. Its `Needs: terminal, gh, network` matches
  `COMMAND_NEEDS.ship` (agento.mjs L532) and stays unchanged.
- **Policy and docs name the interim limitation explicitly.**
  [delivery-policy.instructions.md](../../../../.github/instructions/delivery-policy.instructions.md)
  §9 idempotency row for `/agento ship` has three cases (post-ship epilogue,
  teardown resume, already-merged no-worktree); §7 says only `/agento ship` merges;
  §8 names the primary window for close and ship. [docs/commands.md](../../../../docs/commands.md)
  L113–116 ("Interim limitation: until the `ship-dual-merge` initiative member
  lands…"), [CHANGELOG.md](../../../../CHANGELOG.md) L24–25, and
  [README.md](../../../../README.md) L256–280 (`### 5. Ship — primary window`)
  describe today's single-merge flow. `docs/commands.md` L30–36 documents the
  `ship-preflight` fields.
- **Companion `OWNER/REPO` derivation exists in prose.** The Architect,
  `triage-followups`, and `delivery-status` derive `gh repo view --json
  nameWithOwner -q .nameWithOwner` from inside the clone or run `gh` with `cwd` in
  the clone (mirrored-artifact-branches step 2.5). Ship reuses the same rule: run
  `gh` for the companion PR from inside `artifactsRoot` (or `owner`'s companion
  half), never `--repo <artifacts.repo.name>`.
- **Existing tests to extend.** [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs):
  the pair fixture `makePairRepo()` (≈L515), the close-decision/ship-preflight
  companion test (≈L500–570), and the `session --pr` stub-`gh` tests (≈L1060–1130)
  show the `restrictedPath({ gh })` pattern for a fake `gh` that switches on `$PWD`
  (`*project-docs*` → companion). [scripts/session-state.test.mjs](../../../../scripts/session-state.test.mjs)
  covers `deriveLifecycle`. [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs)
  enforces prompt/command mirrors, resolvable links, valid `§N` references,
  `Needs:` agreement with `doctor --for`, and the `worktree list --porcelain`
  allowlist (`start-session, start-freehand, close-session, ship`).
- **Guard.** [scripts/hooks/delivery-guard.sh](../../../../scripts/hooks/delivery-guard.sh)
  has no rule on `gh pr merge` / `gh pr ready` (grep empty); it protects the
  companion default branch for `git -C <companion>` pushes and commits
  (artifact-repo-hooks). The companion `main` sync after the merge is a
  fast-forward `git -C <artifactsRoot> pull --ff-only` / `merge --ff-only
  origin/<default>` on the clone — neither a commit nor a push, so no guard change
  is needed; confirmed by the existing product-side sync in today's ship prompt.
- **Deferred follow-ups this plan absorbs** (from
  [mirrored-artifact-branches/review.md](../mirrored-artifact-branches/review.md)
  `## Follow-ups` and [paired-artifact-worktrees/roadmap.md](../paired-artifact-worktrees/roadmap.md)):
  `ship-preflight` PR blocks read alongside `artifact-pr`; audit rejects a companion
  PR that is missing, closed, or not mergeable; `behind` gap (Decision Q3); reuse
  the `nameWithOwner` derivation. Not absorbed: the `gh --version` double probe
  (still a follow-up) and `status` walking registered halves
  (`artifact-history-migration`).

## Approach

Everything is additive; with `artifacts.repo` unset each change is a no-op.

1. **CLI — `describeCompanion` `behind`** ([scripts/agento.mjs](../../../../scripts/agento.mjs)).
   Add `behind` (`rev-list --count HEAD..@{upstream}`, `0` without upstream) to the
   companion record and `"behind"` to `companionGaps()` when `behind > 0`.
   `close-decision` already stops on any gap (`companion-unpushed` reason text is
   extended to name `behind`); `ship-preflight` lists it. `session`/`next`
   `companion` gain the same field (same function) — documented as additive.
2. **CLI — `ship-preflight --pr`.** In the `ship-preflight` case, when `options.pr`
   is set, call `lookupPullRequest(branch)` and `lookupCompanionPullRequest(branch)`
   and emit `pr`, `companionPr`, and `warnings[]` (the lookup warnings). In
   companion mode append to `companionGaps[]`: `missing-pr` (companion PR lookup
   returned `null`), `pr-not-open` (`companionPr.state` is `CLOSED`), `conflicting-pr`
   (`companionPr.mergeStateStatus === "CONFLICTING"`). A `MERGED` companion PR is
   **not** a gap (it is the resume-at-teardown case). Without `--pr`: today's output
   exactly (`pr`/`companionPr` absent). In-repo: `companionPr: null`, no companion
   `gh` call, `companionGaps` unchanged. Update the usage header.
3. **CLI — lifecycle warning** ([scripts/session-state.mjs](../../../../scripts/session-state.mjs)).
   `deriveLifecycle({ delivery, pr, companionPr })` pushes
   `companion-pr-open: PR #<pr> for <branch> is merged but companion PR #<n> is
   still open` when `pr.state === "MERGED"` and `companionPr?.state === "OPEN"`;
   lifecycle unchanged. `session` and `next` pass `companionPr`.
4. **Prompt — `ship.prompt.md`** (mirrored to `commands/ship.md`). Rewrite the
   companion-mode path:
   - Resolve with `ship-preflight <type> <slug> --pr`; read `pr`, `companionPr`,
     `companion`, `companionGaps[]`. In companion mode (`companionPr !== null` or
     `agento.mjs config` `artifactsRoot ≠ root`) the audit reads roadmap.md,
     review.md, plan.md from the **companion's** `origin/<branch>` (`git -C
     <artifactsRoot> fetch origin` then `git -C <artifactsRoot> show
     origin/<branch>:<path>`); the code diff stays on the product. `companionGaps[]`
     including the new PR gaps are hard-reject; the companion PR `BEHIND` its default
     is integrated in the companion half by `git -C <companion.path> merge
     origin/<default>` (never rebase; abort + reject on conflict, same as product).
   - Step 3 writes `status: complete` (+ `## Follow-ups (accepted at ship)`) in the
     companion half via `git -C <companion.path>` and pushes it; the changelog stamp
     stays a product commit (CHANGELOG.md lives in the product). In-repo mode:
     unchanged single commit.
   - Mark both PRs ready (`gh pr ready <n>` in the product; `gh pr ready <m>` run
     from inside the companion clone). Wait on the code PR's required checks with
     `scripts/wait-for-checks.sh pr <n>`; merge the code PR (normal merge commit,
     delete remote branch). Then, for the companion: `wait-for-checks.sh pr <m>
     --repo <nameWithOwner>` (derived with `gh repo view --json nameWithOwner` inside
     the clone; the script already accepts `--repo OWNER/NAME`) and merge it the
     same way from inside the clone. A companion merge failure is a resumable hard
     stop: report both PR URLs and end with `Result: failed`; the re-send resumes
     here (step 6 below). Ordering rationale is stated inline: the code PR's checks
     are the real gate; the companion carries only artifacts.
   - Sync both defaults: product `main` as today; companion `git -C <artifactsRoot>
     switch <default> && git -C <artifactsRoot> fetch --prune && git -C
     <artifactsRoot> merge --ff-only origin/<default>`; verify clean and zero
     ahead/behind in both. Teardown unchanged (already removes both halves and the
     workspace file), then `git -C <artifactsRoot> branch -d <branch>` for the merged
     companion local branch.
   - Epilogue: `post-ship/<slug>` branch, evidence commit, PR, and merge happen in
     the **companion** repository (`git -C <artifactsRoot>` from its fresh default;
     `gh` from inside the clone); the roadmap tick lands there because the roadmap
     lives there. In-repo: unchanged.
   - Idempotency paragraph gains the case: `pr.state === MERGED` and `companionPr.state
     === OPEN` → skip audit-writes and the code merge, resume at "mark the companion
     PR ready / wait / merge", then sync, teardown, epilogue.
5. **Policy — `delivery-policy.instructions.md` §9** `/agento ship` row adds the
   Decision Q2 case verbatim (`code PR merged, companion PR open → resumes at the
   companion merge`). No new `§` sections, so `customizations.test.mjs` `§N`
   references stay valid.
6. **Docs.** [docs/commands.md](../../../../docs/commands.md): `ship-preflight`
   paragraph gains `--pr` (`pr`, `companionPr`, `warnings[]`, new gap tokens,
   `behind`), `companion` gains `behind`, and the "Interim limitation" sentence is
   replaced by the dual-merge description; [README.md](../../../../README.md) `### 5.
   Ship` gains one companion-mode paragraph (both PRs ready, code first then
   companion, both defaults synced, epilogue in the companion);
   [CHANGELOG.md](../../../../CHANGELOG.md) `## Unreleased` gains a **Ship dual
   merge** entry and drops the "Interim" sentence from the mirrored-branches entry.
   `docs/artifacts.md` needs no change (the `artifact-pr` header semantics — "the
   PR `/agento ship` merges after the code PR" — become true).
7. **Tests.** [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs): extend
   the pair close-decision/ship-preflight test with a `behind` case (push a second
   commit to the companion's `origin/feature/widget` from the clone, fetch in the
   half); new `ship-preflight --pr` test using the `restrictedPath({ gh })` stub
   pattern: in-repo → `pr` present, `companionPr: null`, one `gh` call; companion
   mode → both PRs, two calls with the second `$PWD` in the clone; stub variants
   yielding `missing-pr`, `pr-not-open`, `conflicting-pr`, and `MERGED` (no gap);
   without `--pr` the output has no `pr` key. [scripts/session-state.test.mjs](../../../../scripts/session-state.test.mjs):
   `deriveLifecycle` `companion-pr-open` warning present/absent cases.
   [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs) runs
   unchanged as the mirror/links/§N gate.
8. **End-to-end drive (Decision Q5).** On a `/tmp` product + companion pair with bare
   origins and a stub `gh` on `PATH` that logs `$PWD $*` and answers `pr view` with
   `MERGED`/`OPEN` states from a state file, drive the ship prompt's exact command
   sequence twice: once clean (both merges "succeed"), once with the companion
   `pr merge` failing on the first pass and the re-send resuming at the companion
   merge. Save the transcript as `evidence/step-4-1-dual-merge-drive.txt`.

Affected files: `scripts/agento.mjs`, `scripts/session-state.mjs`,
`scripts/agento.test.mjs`, `scripts/session-state.test.mjs`,
`.github/prompts/ship.prompt.md` + `commands/ship.md`,
`.github/instructions/delivery-policy.instructions.md`, `docs/commands.md`,
`README.md`, `CHANGELOG.md`, and this feature's `evidence/`.

## Risks

- **Code merged, companion not merged (two-PR divergence).** The breakdown's named
  risk. Mitigation: `status: complete` is committed and pushed in the companion
  *before* either merge; the companion merge failure is a `Result: failed` with both
  URLs; the re-send detects `pr: MERGED` + `companionPr: OPEN` from `ship-preflight
  --pr` and resumes at the companion merge (Decision Q2); `deriveLifecycle` warns
  `companion-pr-open` so `/agento delivery-status` surfaces the half-shipped state
  (Decision Q4).
- **`ship-preflight --pr` output divergence.** Adding keys could break a prose
  consumer reading the JSON. Mitigation: keys appear only with `--pr` (Decision Q1);
  the existing companion test asserts `deepEqual` on the no-flag shape plus
  `behind`, and the in-repo assertions stay unchanged.
- **`behind` false positives.** A companion half whose upstream moved because the
  Builder pushed from another machine is legitimately behind and `close-decision`
  now refuses. Mitigation: the reason text names the fix (`git -C <companion.path>
  merge origin/<branch>` — a fast-forward); the check needs an upstream, so a
  never-pushed half reports `behind: 0`.
- **Companion `gh` targeting.** `artifacts.repo.name` is a directory basename, not
  `OWNER/REPO`. Mitigation: every companion `gh` call in the prompt runs from inside
  the clone (`cd <artifactsRoot> && gh …`) or with `--repo` derived by `gh repo view
  --json nameWithOwner -q .nameWithOwner` there — the same rule mirrored-artifact-branches
  step 2.5 set; `customizations.test.mjs` continues to reject the literal
  `--repo <artifacts.repo.name>`.
- **Guard interaction during the companion default sync.** `git -C <artifactsRoot>
  switch <default>` / `merge --ff-only` on the clone's protected default branch.
  Mitigation: the guard denies commits and pushes to the companion default, not
  fast-forward merges or switches (verified against
  `tests/guard-fixtures-companion.txt` during build; if a fixture is missing, add
  the `allow` line — a fixture file, not a hook edit).
- **Prompt length and mirror drift.** `ship.prompt.md` grows; `commands/ship.md`
  must stay byte-identical. Mitigation: every prompt step's `verify:` includes
  `cmp .github/prompts/ship.prompt.md commands/ship.md` and the customizations
  suite.
- **Concurrent delivery.** No open PRs today; if one appears touching
  `scripts/agento.mjs` or `ship.prompt.md`, integrate `origin/main` by merge before
  every push (policy §7).
- **No real GitHub exercise before review.** Decision Q5 chooses simulated `gh`.
  Mitigation: the drive uses the prompt's literal commands with a stub that logs
  `$PWD $*`, so the *sequence and cwd* of every `gh` call are asserted; the first
  real exercise is this feature's own ship in the in-repo layout (no companion
  here) and later `artifact-history-migration`, which flips this repository over.

## Out of scope

- Removing the in-repo layout or changing behaviour with `artifacts.repo` unset.
- `status` walking registered companion halves (`artifact-history-migration`).
- Sharing one `gh --version` probe across lookups (existing follow-up).
- A release-workflow equivalent for the companion repository (the companion has no
  CI; `checks.releaseWorkflow` stays product-only).
- Real GitHub rulesets or throwaway repositories for verification (Decision Q5).
- Any change to `close-session` beyond the `behind` gap it inherits from
  `describeCompanion`.

## Acceptance checklist

- [ ] `describeCompanion` reports `behind` and `companionGaps()` includes `"behind"`
  when the companion half is behind its upstream, for `ship-preflight`,
  `close-decision` (which refuses with a reason naming `behind`), and `session`:
  `node --test scripts/agento.test.mjs` exit 0 with the new `behind` assertions;
  the in-repo assertions (`companion: null`, `companionGaps: []`) unchanged.
- [ ] `ship-preflight <type> <slug> --pr` emits `pr`, `companionPr`, and
  `warnings[]` — in-repo: `companionPr: null` and exactly one `gh pr view` call;
  companion mode: two calls, the second with `$PWD` in the companion clone — and
  appends `missing-pr`, `pr-not-open`, or `conflicting-pr` to `companionGaps[]`
  while a `MERGED` companion PR adds no gap: `node --test scripts/agento.test.mjs`
  exit 0 with those cases; without `--pr` the JSON has no `pr` key.
- [ ] `deriveLifecycle` pushes a `companion-pr-open` warning when `pr.state ===
  "MERGED"` and `companionPr.state === "OPEN"`, leaving `lifecycle` unchanged, and
  `session --pr` surfaces it: `node --test scripts/session-state.test.mjs
  scripts/agento.test.mjs` exit 0 with the new cases.
- [ ] `ship.prompt.md` in companion mode reads roadmap/review from the companion's
  `origin/<branch>`, commits `status: complete` via `git -C <companion.path>`, marks
  both PRs ready, merges the code PR first and the companion PR second (each after
  `wait-for-checks.sh`), syncs both defaults, and runs the epilogue in the
  companion; `grep -c 'companionPr' .github/prompts/ship.prompt.md` ≥ 3, `grep -c
  'ship-preflight <type> <slug> --pr\|ship-preflight.*--pr' .github/prompts/ship.prompt.md`
  ≥ 1, `grep -c 'post-ship' .github/prompts/ship.prompt.md` ≥ 3, and `grep -c --
  '--repo <artifacts.repo.name>' .github/prompts/ship.prompt.md` = 0.
- [ ] Duplicate-submission behaviour is documented in both places: the ship
  prompt's idempotency paragraph and the `/agento ship` row of
  `delivery-policy.instructions.md` §9 name the "code PR merged, companion PR open →
  resume at the companion merge" case: `grep -c 'companion' .github/instructions/delivery-policy.instructions.md`
  increased versus `origin/main`; `node --test tests/customizations.test.mjs` exit 0.
- [ ] The command mirror is intact: `cmp .github/prompts/ship.prompt.md
  commands/ship.md` silent; `diff <(ls commands) <(ls .github/prompts | sed
  's/\.prompt\.md$/.md/')` empty.
- [ ] Docs state the dual merge and no longer describe the interim limitation:
  `grep -c 'Interim limitation' docs/commands.md` = 0; `grep -c 'leaves the
  companion PR open' CHANGELOG.md` = 0; `grep -c 'companion' README.md` increased
  versus `origin/main`; `grep -c 'behind' docs/commands.md` ≥ 1; `grep -c
  'Ship dual merge' CHANGELOG.md` = 1.
- [ ] The end-to-end drive on a `/tmp` pair with a logging stub `gh` records the
  clean dual merge and the resume-at-companion-merge path in
  `evidence/step-4-1-dual-merge-drive.txt`, showing the product `gh pr merge`
  before the companion one and every companion `gh` call with `$PWD` inside the
  companion clone.
- [ ] Full-repository gate green against the §5 baseline (188/188/0, shellcheck
  silent, both replays exit 0): `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` exit 0 with `# fail 0` and `# tests` ≥ 188; `shellcheck
  scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` exit 0 silent;
  `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0;
  `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh <
  tests/guard-fixtures-companion.txt` exit 0; no new findings.
- [ ] The in-repo layout is unchanged: with `artifacts.repo` unset, `ship-preflight`
  without `--pr` is byte-identical to `origin/main`'s output for this checkout
  (`diff <(node <(git show origin/main:scripts/agento.mjs) …)` is impractical —
  instead the existing in-repo `deepEqual` assertions in `scripts/agento.test.mjs`
  pass unchanged and `node scripts/agento.mjs ship-preflight feature ship-dual-merge`
  in this worktree prints `companion: null`, `companionGaps: []`).
