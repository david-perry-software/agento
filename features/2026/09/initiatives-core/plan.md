# Initiatives core: artifact contract, config root, and `agento.mjs initiative`

## Problem

Agento plans, builds, reviews, and ships one feature or issue per session. A large
brief (an MVP-scale prompt) has no home: nothing records how it decomposes into
independently shippable features, which of those depend on which, and which one is
ready to start next. Users hand-track that in chat or in ad-hoc notes, so the
Planner → Builder → Reviewer → /ship flow cannot be pointed at "the next ready
feature of initiative X" deterministically.

This delivery adds the **initiative tier's foundation**: the artifact contract for
`initiatives/YYYY/MM/<slug>/brief.md` + `breakdown.md`, the `artifacts.initiatives`
config root scaffolded by `/agento-init`, an optional `initiative:` roadmap header,
and a deterministic `agento.mjs initiative [<slug>]` subcommand that derives
per-feature progress from existing roadmaps (code is truth) and validates the
breakdown's dependency graph. The Architect agent, `/new-initiative`,
`/next-feature`, Planner/status integration, narrative docs, and the 0.3.0 release
are the second feature, `initiative-workflow`, which requires this one to ship first.

## Decisions

Clarifying questions were asked in chat (the ask-questions tool was unavailable in
this session); answers are the user's verbatim text.

1. **Q:** Single feature vs. split? The brief is ~10 steps across 5 phases and would
   exceed the ~15-step guideline it proposes.
   **A:** "Split into two features. `initiatives-core`: artifact/config contract, CLI
   state derivation, validation, and tests. `initiative-workflow`: Architect agent,
   `/new-initiative`, `/next-feature`, Planner/status integration, docs, and release.
   `initiative-workflow` requires `initiatives-core` to be shipped first. This keeps
   each delivery reviewable and gives us a practical test of the ordering model we
   are introducing."
2. **Q:** Live-run verification (brief item 4) would merge a sample
   `changes/initiative-<sample>` PR to `main`. Keep as example / delete in follow-up /
   skip the merge?
   **A:** "Choose option (c). Use the temp-repository dry run plus a non-merged live
   rehearsal. Do not leave sample initiative artifacts or merge disposable data into
   `main`."
3. **Q:** Should a `Requires:` dependency be satisfied only by roadmap
   `status: complete`, or also by a git-merged branch?
   **A:** "Only `status: complete` satisfies `Requires:`. Keep dependency resolution
   deterministic and artifact-based. A merged branch with an `in-review` roadmap is
   inconsistent delivery state that should be reported as an anomaly, not silently
   interpreted as complete."
4. **Q:** Touch the delivery guard for `initiatives/**`?
   **A:** "Leave the guard untouched. It does not currently block `initiatives/**`;
   hook changes are unnecessary and out of scope."
5. **Q:** Confirm `0.3.0` and CHANGELOG dating.
   **A:** "Confirm `0.3.0`. Update both `plugin.json` and `package.json`. Date the
   `CHANGELOG.md` entry with the actual ship date, not the planning date."
   (Applies to `initiative-workflow`, which carries the release; recorded here so the
   second plan inherits it.)

Planner interpretation recorded for the Builder: `initiatives-core` updates only the
reference docs that describe what it ships (the CLI subcommand line in
docs/commands.md, the config-key row in docs/project-profile.md, the artifact table in
docs/artifacts.md). README, docs/architecture.md, CHANGELOG, and the version bump stay
in `initiative-workflow` per answer 1.

## Research

Skills consulted: none — no matching domain (AGENTS.md has no `## Agento` skills
table and no `.agents/skills/` directory exists in this repository).

**Lint baseline (policy §5)** — run from the planning worktree at `a60c9d2`
(`origin/main`), 2026-09-05:

| Command | Exit | Findings |
|---|---|---|
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | 59 tests, 59 pass, 0 fail |
| `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` | 127 | `shellcheck` is **not installed** on this machine (`command -v shellcheck` empty). Not a lint finding; a missing prerequisite. |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | all fixtures match expected verdicts |

Baseline is green where runnable; no findings overlap this delivery's files. This
plan touches no shell files, so the shellcheck component is unaffected by the
change, but the Builder must still run it — install shellcheck first (e.g.
`sudo apt install shellcheck` is a user action; the Builder reports the missing
prerequisite and asks, per §1) — or record its absence explicitly in the roadmap
step. A **full gate** applies (not scoped): the full test suite, shellcheck, and the
guard smoke must all pass at the end of the build with zero new findings.

Side observation (not blocking, recorded as a follow-up candidate): the
delivery guard denied `{ shellcheck scripts/hooks/*.sh …; echo "exit=$?"; }` and
`cd scripts/hooks && { ./replay-guard.sh < … ; }` from the automation shell even
though `tests/guard-fixtures.txt` lists the bare `shellcheck scripts/hooks/*.sh
scripts/wait-for-checks.sh` line as `allow`. Wrapping a read-only hook-path command
in a `{ …; }` group or `cd`ing into `scripts/hooks/` appears to trip the
"destructive shell changes to hook files" rule. Hooks are out of scope here.

**Concurrent deliveries:** `gh pr list --state open` returned `[]`; no open delivery
branches, so no file overlap to sequence around.

**Codebase findings (file:line evidence):**

- CLI shape — [scripts/agento.mjs](../../../../scripts/agento.mjs) L1–16 usage
  header (read back by `usage()` via `.slice(1, 16)`, so adding a usage line means
  widening that slice); `emit()` L38–41 prints one JSON document; exit codes 0/1/3
  (`withExit()` L124–126 maps `status !== "ok"` to 3); `requireSlug()` L79–82 is the
  slug regex; `header()` L84–88 reads `key: value` / `key: "value"` from the yaml
  block; `walkRoadmaps(base)` L90–107 is a generator over `roadmap.md` files;
  `describe()` L109–131 builds the per-roadmap record (`status`, `branch`,
  `githubIssue`, step counts…); `allRoadmaps()` L133–141 iterates
  `config.artifacts.features` / `.issues`; `find` L158–169 returns
  `status: "missing"` for unused slugs; `status` L171–182 sorts by status order and
  emits `items`, `duplicates`, `resumable`.
- Config — [scripts/agento-config.mjs](../../../../scripts/agento-config.mjs)
  L6–19 `defaultConfig()` has `artifacts: { features, issues }`; `mergeConfig()`
  L25–37 deep-merges and treats `null` as "keep default"; no key allowlist, so
  `artifacts.initiatives` merges without further code.
- Roadmap parsing elsewhere —
  [scripts/delivery-roadmap-resolver.mjs](../../../../scripts/delivery-roadmap-resolver.mjs)
  `parseRoadmapContent()` reads only `branch:` and `status:` by regex; an extra
  `initiative:` header is ignored (no break).
- Tests — [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs) L16–33
  `makeRepo({ config })` builds a bare origin + clone, L35–39 `writeRoadmap(root,
  rel, header, steps)`, L41–50 `run(cwd, ...args)` spawns the CLI and parses JSON;
  6 tests today. [scripts/agento-config.test.mjs](../../../../scripts/agento-config.test.mjs)
  asserts `artifacts.features/issues` defaults (L13–24) and template loading
  (L66–79); 6 tests.
- Customization invariants —
  [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs):
  instructions need `description` + `applyTo`; relative links must resolve; `§N`
  refs must exist in the policy file; canary phrases only in the policy file
  (`materially unfaithful`, `changed-files-only lint`, `SIGPIPE`,
  `evidence/step-<N-M>-<short-name>.png`, "never ask/hand … run the command"); every
  prompt must be listed in README.md and docs/commands.md; plugin.json/package.json
  versions must match. No check reads `templates/`.
- Scaffolding — [.github/prompts/agento-init.prompt.md](../../../../.github/prompts/agento-init.prompt.md)
  L1 description names "features/ and issues/ directories"; step 2 (L15–31) embeds
  the config JSON; step 3 (L33–34) creates the roots with `.gitkeep`; step 4
  embeds the AGENTS section text; step 6 copies `templates/project.instructions.md`
  when roots differ.
- Templates — [templates/agento.json](../../../../templates/agento.json) mirrors
  the default config; [templates/project.instructions.md](../../../../templates/project.instructions.md)
  (11 lines) is a frontmatter stub with `applyTo: "features/**,issues/**"` and a
  note to keep `applyTo` in sync with `artifacts.features` / `artifacts.issues`;
  [templates/AGENTS-section.md](../../../../templates/AGENTS-section.md) L1–8 lists
  commands and the two artifact paths.
- Contract — [.github/instructions/delivery-artifacts.instructions.md](../../../../.github/instructions/delivery-artifacts.instructions.md)
  `applyTo: "features/**,issues/**"` (L3); roadmap yaml block "exactly these
  fields" (L43–51) with `github-issue` as the only optional field.
- Hooks — [scripts/hooks/session-context.sh](../../../../scripts/hooks/session-context.sh)
  L32–42 hard-codes `roots = [features, issues]` from config. Per Decision 4 and the
  brief ("session-context.sh — unchanged"), hooks stay untouched: initiatives are
  not resumable sessions and need no SessionStart announcement.
- Docs touchpoints — [docs/commands.md](../../../../docs/commands.md) L25–28 lists
  CLI subcommands; [docs/project-profile.md](../../../../docs/project-profile.md)
  L16–24 config table; [docs/artifacts.md](../../../../docs/artifacts.md) L1–12
  artifact table.
- Versions — plugin.json and package.json both `0.2.0`; CHANGELOG top entry
  `## 0.2.0 (2026-09-05)`. Unchanged by this feature.

## Approach

**Artifact contract** (`.github/instructions/delivery-artifacts.instructions.md`;
mirror `applyTo` in `templates/project.instructions.md`):

- `applyTo: "features/**,issues/**,initiatives/**"`; update the description.
- Roadmap yaml block gains an optional `initiative: "<initiative-slug>"` field
  (features only, listed next to `github-issue`).
- New `# brief.md` section: verbatim intake text preceded by a one-line
  `Source: <argument|file path> — <YYYY-MM-DD>` header.
- New `# breakdown.md` section. Yaml header: `initiative`, `created`,
  `last-updated`. Body, in order: `# <Title>`, `## Goal`, `## Decisions`,
  `## Research` (with `Skills consulted:`), `## Features` (one `### <feature-slug>`
  block each, bullets `- Summary:`, `- Brief:`, `- Requires: <slugs|none>`,
  `- Recommended after: <slugs|none>`, `- Wave: <n>`, `- Size: S|M|L`,
  `- Independence:`), `## Recommended order` (waves + rationale, optional mermaid),
  `## Risks`, `## Out of scope`, `## Definition of done`. **No checkboxes** —
  progress is derived by the CLI.

**Config root:** add `initiatives: "initiatives"` to `defaultConfig().artifacts`
in `scripts/agento-config.mjs`; mirror in `templates/agento.json`,
`templates/AGENTS-section.md` (artifact paths sentence), and
`.github/prompts/agento-init.prompt.md` (description, config snippet, step 3 creates
the third root with `.gitkeep`, step 6 mentions the third `applyTo` entry).

**CLI** (`scripts/agento.mjs`, new `initiative` case; keep the single-file style):

- Usage line `node scripts/agento.mjs initiative [<slug>]`; widen the
  `usage()` slice accordingly.
- `describe()` gains `initiative: header(content, "initiative") || null` so
  `status` items carry it.
- `walkBreakdowns(base)` (same generator pattern as `walkRoadmaps`) yields
  `breakdown.md` files under `config.artifacts.initiatives`; the initiative slug is
  the parent directory name.
- `parseBreakdown(content)` → `{ slug, created, lastUpdated, features: [{ slug,
  requires: [], recommendedAfter: [], wave: n|null, order }] }` from `### <slug>`
  blocks and their bullets (`none` → empty list; comma/space separated slugs).
- `deriveInitiative(breakdown, roadmaps)`:
  - `state` per feature: no roadmap → `unplanned`; otherwise the roadmap's `status`
    (`planned|in-progress|paused|in-review|complete`). Only `complete` satisfies
    `Requires:` (Decision 3).
  - `blockedBy` = requires not complete; `ready` = `state === "unplanned"` and
    `blockedBy` empty; `waves` = topological levels from `Requires` (explicit
    `Wave:` is reported, but ordering for `next` uses explicit `Wave:` when
    present, then computed level, then listed order); `next` = first ready feature
    by (wave, listed order) or `null`; `done` = every feature `complete`.
  - Validation → `status: "invalid"`, exit 3, with an `errors` array: unknown slug
    in `Requires`/`Recommended after`; dependency cycle (Kahn's algorithm leaves
    nodes); duplicate `### <slug>`; a roadmap exists for a member slug whose
    `initiative:` header is absent or names a different initiative.
  - `anomalies` (informational, never changes state or exit code): a member whose
    roadmap `branch` appears in `git branch -r --merged origin/<default>` while its
    status is not `complete` (`merged-but-not-complete`, Decision 3); a member with
    `status: complete` and a still-existing remote branch is *not* flagged (normal
    until branch deletion).
  - Missing breakdown for the slug → `status: "missing"`, exit 3.
- List mode (no slug): `items: [{ slug, dir, created, lastUpdated, total,
  complete, inFlight, ready, done, valid }]` for every breakdown; exit 0.
- Output shape is JSON like every other subcommand; `withExit()` maps `ok` → 0.

**Tests:** temp-repo fixtures in `scripts/agento.test.mjs` with a `writeBreakdown()`
helper: parse + state derivation, ready/blocked, `next` by wave then listed order,
cycle detection, unknown slug, wrong/missing `initiative:` header on a member
roadmap, missing initiative, list mode, `status` items carrying `initiative`,
merged-but-not-complete anomaly (push a branch to the temp origin and merge it into
`main` there). `scripts/agento-config.test.mjs`: new default and template assertions.

**Docs (reference only):** docs/commands.md CLI subcommand list and exit codes;
docs/project-profile.md config table row for `artifacts.initiatives`;
docs/artifacts.md gains `brief.md` / `breakdown.md` rows and the initiatives path.

**Verification target:** all behavior is CLI/test level — `local` runs of the node
test suite and a temp-repo dry run; no served UI, no preview.

## Risks

- **Two-feature sequencing.** `initiative-workflow` depends on this feature's
  contract and CLI output shape. Mitigation: the JSON field names above are the
  interface; the Builder must not rename them without updating this plan, and the
  second plan is written after this one ships (it will be the first real
  `Requires:` consumer).
- **Usage header slice.** `usage()` reads lines `1..16` of agento.mjs; adding a line
  without widening the slice truncates help output. Mitigation: explicit roadmap
  step + assertion that the `initiative` line appears in `usage-error` output.
- **Hidden contract dependents.** `templates/project.instructions.md` and the
  agento-init prompt restate the roots; forgetting one leaves target repos without
  the third root. Mitigation: a dedicated roadmap step greps for `initiatives` in
  every mirror.
- **Git-derived anomaly check in a fresh clone.** `git branch -r --merged` needs a
  fetched remote; the CLI never fetches. Mitigation: the anomaly is informational
  only; document that it reflects the last fetch.
- **shellcheck missing on the build machine.** Mitigation: Builder installs it (user
  action if privileges are needed) or records the exact `command -v` failure in
  the roadmap step; the gate is full, not scoped.
- **Concurrent delivery.** No open PRs today. Mitigation regardless: integrate
  `origin/main` before every push (concurrent-delivery.instructions.md).

## Out of scope

- Architect agent, `/new-initiative`, `/next-feature`, Planner "initiative intake",
  `/delivery-status` initiatives table, README / docs/architecture.md narrative,
  CHANGELOG 0.3.0 entry, and the version bump → feature `initiative-workflow`.
- Any hook change (`delivery-guard.sh`, `session-context.sh`, `replay-guard.sh`).
- GitHub issues/milestones/project boards per feature.
- Extending `find <slug>` to search initiatives roots, or making `resolve` /
  `close-decision` / `ship-preflight` initiative-aware.
- Re-decomposing an existing initiative (edits stay freehand).
- Guard fixture for the `{ shellcheck …; }` denial observed during research.

## Acceptance checklist

- [ ] `.github/instructions/delivery-artifacts.instructions.md` has
  `applyTo: "features/**,issues/**,initiatives/**"`, documents the optional
  `initiative:` roadmap header, and contains `# brief.md` and `# breakdown.md`
  sections listing every field and section named in `## Approach`; verify:
  `grep -c 'initiatives/\*\*\|# brief.md\|# breakdown.md\|^initiative:' .github/instructions/delivery-artifacts.instructions.md` ≥ 4 and `node --test tests/customizations.test.mjs` passes.
- [ ] `node scripts/agento.mjs config` in a repo without agento.json prints
  `config.artifacts.initiatives === "initiatives"`; `templates/agento.json`,
  `templates/project.instructions.md` `applyTo`, `templates/AGENTS-section.md`, and
  `.github/prompts/agento-init.prompt.md` (description, JSON snippet, step 3, step 6)
  all mention `initiatives`; verify: `grep -l initiatives templates/agento.json templates/project.instructions.md templates/AGENTS-section.md .github/prompts/agento-init.prompt.md` lists all four.
- [ ] `node scripts/agento.mjs initiative <slug>` on a 3-feature breakdown with one
  dependency chain reports wave-1 features `ready`, the dependent feature with a
  non-empty `blockedBy`, and `next` = the first ready feature by wave then listed
  order; after adding a `status: complete` roadmap (with matching `initiative:`
  header) for the dependency, the dependent becomes `ready` and `next`; verify:
  `node --test scripts/agento.test.mjs` cases named `initiative …` pass.
- [ ] Validation: unknown `Requires` slug, dependency cycle, duplicate `### <slug>`,
  and a member roadmap missing/mismatched `initiative:` header each yield
  `status: "invalid"` with a descriptive `errors[]` and exit 3; a slug with no
  breakdown yields `status: "missing"` exit 3; verify: dedicated tests in
  `scripts/agento.test.mjs`.
- [ ] Only `status: complete` satisfies `Requires:`; a member whose branch is merged
  into `origin/main` but whose roadmap is `in-review` stays blocking and is listed
  under `anomalies` as `merged-but-not-complete`; verify: dedicated test.
- [ ] `node scripts/agento.mjs initiative` (no slug) lists every breakdown with
  `total`, `complete`, `inFlight`, `ready`, `done`, `valid`; verify: list-mode test.
- [ ] `node scripts/agento.mjs status` items carry `initiative` (`null` when the
  header is absent); verify: extended status test.
- [ ] Usage output (`node scripts/agento.mjs bogus`) includes the
  `initiative [<slug>]` line; verify: test asserting the usage array.
- [ ] docs/commands.md CLI list and docs/project-profile.md config table mention
  `initiative` / `artifacts.initiatives`; docs/artifacts.md documents `brief.md` and
  `breakdown.md`; verify: `grep -c initiative docs/commands.md docs/project-profile.md docs/artifacts.md` ≥ 1 each.
- [ ] Full lint gate: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'`
  exit 0 with ≥ 59 + new tests passing; `shellcheck scripts/hooks/*.sh
  scripts/wait-for-checks.sh` exit 0 (or its absence recorded with the exact
  `command -v` result); `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt`
  exit 0; no findings beyond the recorded baseline.
- [ ] No files under `scripts/hooks/`, `.github/hooks/`, `hooks.json`, `plugin.json`,
  `package.json`, `CHANGELOG.md`, or `README.md` are modified; verify:
  `git diff --name-only origin/main...HEAD` excludes them.
