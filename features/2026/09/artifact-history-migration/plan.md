# Artifact history migration: move an in-repo `features/`, `issues/`, `initiatives/` tree into the companion repository

## Problem

Every earlier member of the initiative
[external-artifact-repo](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md)
(`### artifact-history-migration` block) taught the CLI, the hooks, the sessions, the
Planner/Builder/Reviewer, and `/agento ship` to work against a sibling companion
repository — but only for projects initialised *after* the companion existed. A
project that already carries delivery history inside the product repository (this
one: 16 feature directories, 1 issue, 2 initiatives, 10 `evidence/` folders under
`features/2026/09/`, `issues/2026/09/`, `initiatives/2026/09/`) has no path to the
new layout: `doctor` already tells such a project to run `/agento agento-init
--migrate` ([scripts/agento.mjs](../../../../scripts/agento.mjs) L462), and that
command does not exist.

This feature is the wave‑5 member **`artifact-history-migration`**: a documented,
CLI-assisted migration that moves an existing in-repo artifact tree into a freshly
initialised companion (`agento` → `agento-docs`), applied to this repository as the
feature's own acceptance test inside this build, and reproducible by the user for
`prismicon` → `prismicon-docs` with one command. It also closes the initiative: the
plugin version bumps to `0.5.0` for the layout change.

User-visible effect: `/agento agento-init --migrate` on a project with in-repo roots
creates/adopts the companion, imports the whole tree into it on a mirrored branch
with one companion PR, and opens a product PR that removes the roots and sets
`artifacts.repo.name`; `agento.mjs status`, `initiative`, `session`, and `next` read
identical records before and after. After this feature ships, this repository's
`features/`, `issues/`, and `initiatives/` live in `../agento-docs`; the primary
window reads them from there.

## Decisions

Clarifying questions asked with the ask-questions tool; answers verbatim.

- **Q1 — History preservation: how should each moved root's history land in the
  companion repo?** A: "Single import commit" (one import commit per run; full
  history stays in the product repo's log; no `git subtree split` / `filter-repo`).
- **Q2 — Where should the mechanical migration live?** A: "CLI subcommand + init
  flag" (new `agento.mjs migrate` does the deterministic work with node:test
  coverage; `/agento agento-init --migrate` drives it and handles the GitHub/PR side).
- **Q3 — How should the migration of agento itself (→ agento-docs) be performed?**
  A: "Inside this build" (the Builder runs the migration on this feature's own
  branch: creates `david-perry-software/agento-docs` for real, moves every
  `features/`, `issues/`, `initiatives/` entry — including this feature's own
  artifacts — onto the companion branch `feature/artifact-history-migration`, sets
  `artifacts.repo` in the product branch, and the session converts to companion
  mode mid-flight so `/agento ship` dual-merges both).
- **Q4 — Moved plans contain `../../../../scripts/...` links back into the product
  tree. What should happen to them?** A: "Leave as historical" (no rewrite; the
  companion README documents that pre-migration plans link relative to the product
  tree at the time of writing).
- **Q5 — Version bump for the layout change, and how to record the user's
  prismicon run?** A: "0.5.0 + (manual, post-ship) step" (minor bump; a
  `(manual, post-ship)` roadmap step asks the user to run `/agento agento-init
  --migrate` on prismicon after this ships and attach the success screenshot as the
  initiative's final evidence — the policy §4 exception, accepted here).
- **Q6 — The primary (`main`) stays in-repo until this PR merges, so `/agento ship`
  cannot find the migrated roadmap on the product branch. How should the flip be
  resolved?** A: "Branch-aware resolution in the CLI" (companion mode is on when the
  primary's config sets `artifacts.repo` OR the current checkout's config does; for
  slug-targeted reads — `find`, `resolve`, `ship-preflight`, `close-decision`, `next
  <slug>` — a roadmap missing in-repo is retried against
  `origin/<branch>:.github/agento.json`: if that branch sets `artifacts.repo`, the
  roadmap is read from the companion's `origin/<branch>`. Hook edits are
  approval-gated.)

Planner's derived decisions (recorded so the Builder does not re-decide them):

- **Layout rule — "the checkout decides, the primary anchors".** Companion mode is
  on for a checkout when *its own* `.github/agento.json` sets `artifacts.repo`
  (`name` or `dir` non-null). The companion path always resolves against the
  **primary** checkout (today's rule, `resolveArtifactsRoot({ primaryRoot })`);
  when the primary's config also sets `artifacts.repo`, the primary's values win
  (today's rule). Own config unset → in-repo, regardless of the primary (today's
  rule — a worktree on a pre-companion branch keeps reading its own roots). The
  single case that changes is *own set, primary unset* → companion (today: in-repo,
  because `resolveArtifacts()` resolves with the primary's config only). The same
  rule lands in the Python `resolve_artifacts()` shared by both hooks.
- **Branch-aware fallback (`layout: "branch"`).** In a checkout that is in-repo by
  the rule above, the slug-targeted subcommands `resolve`, `find`, `ship-preflight`,
  `close-decision`, `next <slug>` (via `roadmapOnBranch`), and `paths <feature|issue>
  <slug>` consult the delivery branch's own config when the in-repo resolution is
  `missing` (or, for `paths`, always): read `origin/<branch>:.github/agento.json`,
  then `<branch>:.github/agento.json`; if it sets `artifacts.repo`, resolve the
  companion against the primary root; when that directory is a git toplevel, redo
  the read against it — `artifactsRoot` = the companion clone, `artifactsGit` bound
  to it, the companion worktree list and PR lookup taken from it. Results carry
  `layout: "checkout" | "branch"` and `artifactsRoot` so `/agento ship` reads
  artifacts from the right clone. `session`, `status`, `initiative`, `doctor`,
  `config` take no slug and are unchanged. A branch whose config names a companion
  that does not exist on disk stays `missing` (no auto-clone); the message names
  the companion path and `/agento agento-init`.
- **`agento.mjs migrate <destination> [--apply]`.** Filesystem work only — no git
  writes (the prompt and the Builder stage, commit, and push, so the delivery guard
  keeps governing every commit and push). `<destination>` is a companion checkout:
  a git toplevel that is either the companion clone or one of its worktrees (a
  half); the clone is the first `git -C <destination> worktree list --porcelain`
  entry and must be a sibling of the primary checkout (`status: error`, `reason:
  not-sibling` otherwise); `artifacts.repo.name` is the clone's basename. Source
  roots are `config.artifacts.{features,issues,initiatives}` under the checkout the
  command runs in. Default (dry run): `{ status: "ok", mode: "dry-run", source,
  destination, clone, name, roots: [{ rel, files, bytes }], conflicts: [], records
  }` where `records` lists every roadmap (`describeContent` fields) and breakdown
  (`parseBreakdown` slug/dir/features) found under the source roots. Any file under
  `<destination>/<rel>` other than `.gitkeep` that the move would overwrite is a
  conflict → `status: "conflict"`, exit 3, nothing written. `--apply` copies every
  file (`fs.cpSync` recursive — evidence binaries byte-identical), removes the source
  roots from the working tree, writes `.github/agento.json` (created from
  `templates/agento.json` with `artifacts.repo.name` set when absent; otherwise
  only `artifacts.repo.name` is set and every other key is preserved), appends a
  `## Migrated history` section to `<destination>/README.md` when absent (Q4: "plans
  written before the migration link to the product repository with
  `../../../../<path>` relative to their old location; read them against
  `<owner>/<repo>` at the time of writing"), re-describes the destination roots and
  reports `records.identical` plus `records.diff[]`; `mode: "applied"`. Re-run with
  no artifacts under the source roots → `mode: "nothing-to-migrate"`, exit 0, with
  `configSet: true|false`. The subcommand is listed in the usage header and in
  `docs/commands.md`.
- **`/agento agento-init --migrate`.** Runs from the primary checkout on the default
  branch, clean (init's existing step 1 already requires the primary). Steps 1–5
  (companion name, create/adopt, scaffold, ruleset) unchanged. Then: dry run;
  `gh pr list --state open --json headRefName` — any open branch carrying
  `branches.feature`/`branches.issue` prefixes is an in-flight delivery whose in-repo
  artifacts would be stranded by the move: stop and list them unless the user
  explicitly accepts (ask-questions tool or its declared fallback); companion
  branch `changes/agento-init` in the clone (`git -C ../<name> switch -c
  changes/agento-init origin/<default>` — the Architect's existing clone-branching
  pattern); `agento.mjs migrate ../<name> --apply`; `git -C ../<name> add -A`,
  commit `docs(migration): import delivery artifacts from <owner>/<repo>`, `push -u`,
  `gh pr create --draft` run inside the clone titled `docs(migration): import
  delivery artifacts from <owner>/<repo>`; product: AGENTS.md `## Agento` section
  (step 7 as today), `scripts/wait-for-checks.sh` (step 8), product ruleset check
  (step 9), self-check (step 10 — `artifact-repo` must be `ok`, no longer `warn`,
  because the roots are gone from the working tree), then commit the product
  changes on `changes/agento-init` (`chore(agento-init): move delivery artifacts to
  <name>`), push, open the product PR whose body links the companion PR and says
  **merge the companion PR first**, and cross-link the companion PR body. Init
  never merges (as today); the user merges companion then product. Idempotency (§9
  row): roots already gone → `nothing-to-migrate`; existing `changes/agento-init`
  PRs in either repository are resumed, never duplicated. Frontmatter
  `argument-hint` becomes `[--force] [--migrate]`; `Needs:` unchanged (`terminal,
  ask-questions, gh, network`) so `doctor --for agento-init` and the customizations
  suite keep agreeing without a CLI table change.
- **Dogfood on this repository is a delivery, not an init run.** The Builder cannot
  run `/agento agento-init --migrate` here (that prompt runs from the primary; this
  window is the build worktree and `main` is never committed to), so Phase 5 spells
  out the same sequence as roadmap steps on `feature/artifact-history-migration` in
  both halves: create/adopt `david-perry-software/agento-docs` per init steps 2–5
  (bootstrap through the Contents API, ruleset), clone it to `/home/david/DP/agento-docs`
  (sibling of the primary `/home/david/DP/agento`), create this session's companion
  half `/home/david/DP/agento-docs-worktrees/plan-20260917-231812` on
  `feature/artifact-history-migration` (`--no-track -b … origin/main`), write the
  pair's `.code-workspace`, run `agento.mjs migrate <half> --apply` from this
  worktree, commit the import in the half and open the draft companion PR
  `docs(feature): artifact-history-migration`, record `artifact-pr:` in the roadmap
  header (now in the half), commit the product side (roots removed, config, AGENTS.md
  wording), and continue under the two-commit rule. The prompt itself is smoke-tested
  end to end on a throwaway pair (below) and by the user's prismicon run.
- **Throwaway repositories for the prompt smoke.** The Builder creates a public
  scratch product repo `agento-smoke-migrate-<YYYYMMDD>` under the product repo's
  owner seeded with a small in-repo tree (one feature with `evidence/`, one issue,
  one initiative), drives `/agento agento-init --migrate` literally from its primary
  checkout, and asserts the outcome; the Reviewer re-drives the idempotent second
  pass. The same permission the user gave for `artifact-repo-init` ("You can make
  them, ill delete them later") is relied on; the repositories are **not** deleted
  by the agents and their names are recorded in roadmap.md `## Follow-ups`.
- **Ship reads the branch's layout.** `ship-preflight` gains `artifactsRoot` and
  `layout`; `ship.prompt.md` takes `artifactsRoot` from the `ship-preflight` result
  (falling back to `agento.mjs config` only when absent) and treats `layout:
  "branch"` as companion mode. Nothing else in the ship flow changes: the dual
  merge, sync, teardown, and epilogue already work on the companion clone named by
  `artifactsRoot`. After the code PR merges, the primary's `main` carries the config
  and every later command is companion mode by the layout rule.
- **Version and changelog.** `package.json` and `.claude-plugin/plugin.json` →
  `0.5.0`; the `## Unreleased` heading becomes `## 0.5.0 (unreleased)` (ship stamps
  the date — this also settles the follow-up accepted at `artifact-repo-config`'s
  ship) and gains this feature's bullet on top.
- **In-flight deliveries are the migration's one hard precondition.** A delivery
  branch planned in-repo before the flip keeps its artifacts in its own tree while
  `main` no longer has roots; merging `main` into it leaves a checkout whose own
  config says companion but whose roadmap is in-repo. The prompt therefore refuses
  when open delivery PRs exist (above); for this repository no PR is open and this
  is the initiative's last member, so nothing else is planned until it ships.

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/`
directory and its AGENTS.md has no `## Agento` skills table).

### Lint baseline (policy §5)

Run from the planning worktree at `origin/main` `0c32acb`:

- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0; `# tests
  190`, `# pass 190`, `# fail 0`.
- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no output.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
- `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh <
  tests/guard-fixtures-companion.txt` → exit 0.

The baseline is green, so there is no overlap decision and no scoped gate: the
Builder reruns the **full** baseline (all four commands) at every gate step, and the
Reviewer compares a fresh run against `190 pass / 0 fail`, shellcheck silent, both
replays exit 0. Reminder carried from every earlier member: the delivery guard
denies shell redirects that name `scripts/hooks/*` paths (it also denied a `grep …
scripts/hooks/delivery-guard.sh … 2>/dev/null` during this planning); run
shellcheck and greps on hook files without redirection.

### Concurrent deliveries

`gh pr list --state open --json number,headRefName,title` → `[]`. No open delivery
PRs; nothing to sequence after. This member is the last in its initiative
(`agento.mjs initiative external-artifact-repo` → `next: "artifact-history-migration"`,
`ready: true`, every other member `complete`).

### Codebase findings (file:line as of `0c32acb`)

- **Layout resolution today.** [scripts/agento.mjs](../../../../scripts/agento.mjs)
  L149–L159 `resolveArtifacts()`: when the *current* checkout's `artifacts.repo` is
  unset → in-repo with no git call; when set → `primaryRoot` = first `git worktree
  list --porcelain` entry and `resolveArtifactsRoot({ config: primaryConfig, … })`
  — so a secondary worktree whose branch sets `artifacts.repo` while `main` does
  not resolves to **in-repo** (`primaryConfig.artifacts.repo` is null). L160–L168
  `artifactsRoot`/`artifactsGit`/`agit`; L170–L178 `companionWorktrees()` cached
  from `artifacts.dir`; L183–L194 `describeCompanion()`; L204–L207
  `companionOfOwner()`; L362–L366 `lookupCompanionPullRequest()` (in-repo → `null`
  with no `gh` call). All keyed on the module-level `artifacts`.
  [scripts/agento-config.mjs](../../../../scripts/agento-config.mjs) L56–L64
  `resolveArtifactsRoot({ config, rootDir, primaryRoot })` is pure and reusable for
  a branch's config.
- **Slug-targeted readers.** `resolve` L779–L784, `find` L786–L797,
  `close-decision` L812–L835, `ship-preflight` L837–L855 (all pass `rootDir: root,
  artifactsRoot, git: artifactsGit`), `paths` L868–L891 (`companion`/`workspace`
  from `artifacts.external`), `roadmapOnBranch()` L730–L748 (used by `next`).
  [scripts/delivery-roadmap-resolver.mjs](../../../../scripts/delivery-roadmap-resolver.mjs)
  `resolveRoadmapArtifact({ rootDir, artifactsRoot, type, slug, currentBranch, git,
  config })` L120+ returns `status: "missing"` when neither the local walk nor
  `git.lsTree(origin/<branch>)` finds `roadmap.md`; it is the natural retry point.
  `evaluateShipPreflight` / `closeBuildSessionDecision` (L207+, L268+) take the same
  parameters, so a second call with the companion's `artifactsRoot`/`git` needs no
  resolver change.
- **`doctor` already promises the command.** L457–L463: with `artifacts.repo` set
  and non-empty roots under the primary → `warn` whose fallback reads "move them
  into the companion (`/agento agento-init --migrate`) or remove them";
  `holdsArtifacts()` L478–L496 ignores `.gitkeep`. Test
  [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs) L765–L786 asserts
  `/agento agento-init --migrate/` in the fallback.
- **Init prompt.** [.github/prompts/agento-init.prompt.md](../../../../.github/prompts/agento-init.prompt.md):
  frontmatter L1–L4 (`argument-hint: "[--force]"`); step 1 requires the primary
  (L29–L38); steps 2–5 companion name/create-or-adopt/scaffold/ruleset (L40–L98);
  step 6 config snippet (L100–L124); step 7 AGENTS (L126–L167); 8 poller; 9 product
  ruleset; 10 self-check (L197–L201 — "`warn` naming stale in-repo roots … do not
  move or delete anything"); 11 commit on `changes/agento-init`, PR, report
  (L203–L231). [commands/agento-init.md](../../../../commands/agento-init.md) is the
  byte-identical mirror (customizations test "plugin manifest … byte-identical").
  `COMMAND_NEEDS["agento-init"]` L514 = `terminal, ask-questions, gh, network`.
- **Ship prompt.** [.github/prompts/ship.prompt.md](../../../../.github/prompts/ship.prompt.md)
  L11–L25 reads `artifactsRoot` from `agento.mjs config`; L27–L37 companion-mode
  detection (`companionPr !== null`, or `artifactsRoot ≠ root` when `gh` degraded);
  the audit, dual merge, teardown, and epilogue address the companion clone as
  `artifactsRoot` throughout. From the primary on `main` before this PR merges,
  `config.artifactsRoot === root`, so without Q6 the audit would read
  `origin/<branch>:features/…` from the product — where the roadmap no longer is.
- **Hooks.** Both hooks carry the identical Python `resolve_artifacts(product_root)`
  ([scripts/hooks/session-context.sh](../../../../scripts/hooks/session-context.sh)
  L83–L101, [scripts/hooks/delivery-guard.sh](../../../../scripts/hooks/delivery-guard.sh)
  L288–L308): own repo unset → in-repo; primary differs → *primary's* repo, and if
  that is unset → in-repo. Same gap as the CLI. The guard's roadmap nudge
  (L410–L421) consults the companion **clone** (`companion_path`), not the session's
  half — pre-existing; during Phase 5 product commits will draw the nudge's `ask`
  unless the clone's `HEAD` touched a `roadmap.md` (recorded as a follow-up, not
  fixed here). Hook edits are approval-gated (AGENTS.md); tests:
  [tests/session-context.test.mjs](../../../../tests/session-context.test.mjs)
  (`makeRepo({ companion: true })`, L12–L36; "managed worktree resolves the
  companion relative to the primary" L215–L232),
  [tests/guard.test.mjs](../../../../tests/guard.test.mjs), replay fixtures
  [tests/guard-fixtures-companion.txt](../../../../tests/guard-fixtures-companion.txt)
  (`{companion}` substitution, `REPLAY_COMPANION=1`).
- **Session state.** [scripts/session-state.mjs](../../../../scripts/session-state.mjs)
  `pairFor()` L143–L154 derives the companion half as
  `<companionWorktreesDir>/<dirPrefix>-<id>` — for this session
  `/home/david/DP/agento-docs-worktrees/plan-20260917-231812` — and `registered`
  from the companion clone's worktree list; `classifyByPath()` L66–L118 resolves a
  cwd inside that half to the product half's record. Nothing changes here.
- **Test fixtures to reuse.** [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs)
  `makeRepo({ config, companion: true })` L18–L40 (`<base>/project` +
  `<base>/project-docs`, each with a bare origin), `companionOf()` L42,
  `writeRoadmap()`/`writeBreakdown()` L44–L66, `makePairRepo()` L246–L256,
  `restrictedPath({ gh })` + `prStub()` for `gh` stubs, `okStubs`/`byId` for
  `doctor`. Pattern for "roadmap only on a branch": L177–L187.
- **Guidance constraints** ([tests/customizations.test.mjs](../../../../tests/customizations.test.mjs)):
  every prompt needs `description` and no `name:`; `Needs:`/`Fallback:` first two
  body lines from the §10 vocabulary; `doctor --for <name>` cited exactly when
  `gh`/`code`/`network` is needed; `§N` references must exist; relative links must
  resolve; `commands/*.md` byte-identical to prompts; every command written
  `/agento <name>` in guidance files (README, AGENTS.md, docs, templates, agents,
  prompts, instructions, commands); `worktree list --porcelain` only in
  `start-session, start-freehand, close-session, ship`; plugin and package versions
  equal (L411). A `migrate` CLI subcommand is not a slash command and needs no
  `COMMAND_NEEDS` row.
- **Docs and templates naming init or the layout.** [README.md](../../../../README.md)
  L127–L141 (set-up table), L393 (flow table row `/agento agento-init [--force]`);
  [docs/install.md](../../../../docs/install.md) L57–L75; [docs/commands.md](../../../../docs/commands.md)
  L5 (init row), L27–L93 (CLI subcommand list — `migrate` to be added), L95–L129
  (mirrored branches section); [docs/architecture.md](../../../../docs/architecture.md)
  L90 (boundary table), L99–L110 (companion-cwd anchoring — the layout rule belongs
  beside it); [docs/artifacts.md](../../../../docs/artifacts.md) L1–L11 ("Projects
  initialised before the companion existed keep the roots inside the product
  repository"); [docs/project-profile.md](../../../../docs/project-profile.md)
  L34–L35 (`artifacts.repo.*` rows); [templates/companion-README.md](../../../../templates/companion-README.md)
  (unchanged — the migration note is appended by `migrate --apply`, not shipped in
  the template); [AGENTS.md](../../../../AGENTS.md) layout bullets name the plugin's
  own directories and must say where this repository's artifacts live after the
  flip; policy §9 row `/agento agento-init` in
  [delivery-policy.instructions.md](../../../../.github/instructions/delivery-policy.instructions.md).
  [CHANGELOG.md](../../../../CHANGELOG.md) L3 `## Unreleased`; versions `0.4.1` in
  [package.json](../../../../package.json) L3 and
  [.claude-plugin/plugin.json](../../../../.claude-plugin/plugin.json) L4;
  `.github/workflows/ci.yml` is the product's required check.
- **Migration inputs (this repository).** `features/2026/09/{artifact-repo-config,
  artifact-repo-hooks, artifact-repo-init, canonical-commands, capability-preflight,
  command-receipts, continue-command, initiatives-core, initiative-workflow,
  install-skills, mirrored-artifact-branches, paired-artifact-worktrees,
  session-state-cli, ship-audit-first, ship-dual-merge, window-aware-commands}`,
  `issues/2026/09/plugin-hooks-layout`, `initiatives/2026/09/{external-artifact-repo,
  workflow-orchestration}`; `evidence/` under 9 features and the issue. No test reads
  these directories; only prose links point back into the product tree (Q4).
  `.github/agento.json` does not exist here (`configSource: null`) — `migrate
  --apply` creates it.
- **Previous members' follow-ups relevant here.**
  [ship-dual-merge/roadmap.md](../ship-dual-merge/roadmap.md) `## Follow-ups`:
  "decide whether `status` should walk registered companion halves" (not needed —
  `session`/`next` already do; `status` from the primary lists the clone, which is
  correct there) and "watch the `wait-for-checks.sh pr <m> --repo <nameWithOwner>`
  path — the companion has no CI". [ship-dual-merge/review.md](../ship-dual-merge/review.md)
  `## Follow-ups`: `missing-pr` doubles as lookup-failed (unchanged here).
  [paired-artifact-worktrees/roadmap.md](../paired-artifact-worktrees/roadmap.md):
  "Consider a `.code-workspace` for the primary window written by init" (out of
  scope, restated).

## Approach

Everything is additive and, with `artifacts.repo` unset in both the checkout and
its branch, reduces to today's code paths (`layout: "checkout"`, `artifactsRoot ===
root`, no extra git calls except the one `show` of `<ref>:.github/agento.json` on a
`missing` slug-targeted read).

1. **Layout rule in the CLI** — `scripts/agento.mjs` `resolveArtifacts()`: when the
   current checkout's `artifacts.repo` is set, load the primary's config as today
   and use `primaryConfig` **only when it also sets `artifacts.repo`**, else the
   checkout's own config, both resolved with `primaryRoot`. Test: a managed
   worktree whose branch commits `.github/agento.json` with `repo.name` while the
   primary has none → `config.artifactsRoot === <base>/project-docs`, `session`
   reports `companion.registered` once a half exists, `paths` reports the pair; the
   primary itself stays in-repo.
2. **Branch-aware fallback** — new helper `layoutFor(branch)` in `agento.mjs`
   returning `{ artifacts, artifactsRoot, artifactsGit, companionWorktreesDir,
   companionWorktrees, layout }`: `artifacts.external` → the module-level objects
   with `layout: "checkout"`; else read `git show origin/<branch>:.github/agento.json`
   (then `<branch>:…`), `mergeConfig`-style parse via a small exported
   `parseConfigText()` in `agento-config.mjs` (so hooks and CLI share the null-keeps-
   default semantics), `resolveArtifactsRoot({ config: branchConfig, rootDir: root,
   primaryRoot })`; when `external` and `git -C <dir> rev-parse --show-toplevel`
   equals `<dir>`, return objects bound to it with `layout: "branch"`; otherwise
   `null`. `resolve`/`find`: on `status: "missing"`, retry with `layoutFor(branch)`
   when it is non-null; the emitted record gains `layout` and `artifactsRoot`.
   `ship-preflight`/`close-decision`: same retry; `companionOfOwner`,
   `companionGaps`, `lookupCompanionPullRequest`, and the PR-gap logic take the
   layout's companion objects (parametrised instead of reading module-level
   `artifacts`); the result gains `layout` and `artifactsRoot`. `roadmapOnBranch()`:
   same retry so `next <slug>` from the primary resolves. `paths <feature|issue>
   <slug>`: when not external, consult `layoutFor(branch)` and fill `artifactsRoot`,
   `artifactRoot`, `companion`, `workspace` from it (plan/freehand kinds unchanged).
   Tests (`scripts/agento.test.mjs`, using `makeRepo({ companion: true })`): a
   product branch `feature/flip` that commits `.github/agento.json` (`repo.name:
   project-docs`) and no roots, a companion `feature/flip` pushed to the companion
   origin with the roadmap; from the primary on `main` (in-repo): `resolve`/`find`
   → `status: ok`, `source: remote`, `layout: branch`, `artifactsRoot ===
   companionOf(repo)`; `ship-preflight --pr` (stub `gh`) → `companionPr.number ===
   7`, `companionGaps: []`, `artifactsRoot` the companion, and the companion `gh`
   call's `$PWD` inside `project-docs`; `close-decision` → `remote-roadmap-only`;
   `next flip` → `status: ok` with the ship/start-session transition; `paths
   feature flip` → `companion`/`workspace` non-null; a branch whose config names an
   absent companion → still `missing` with the companion path in `message`; a plain
   in-repo branch → today's output byte-for-byte (`layout: "checkout"`).
3. **`migrate` subcommand** — `case "migrate"` in `agento.mjs` per the Decisions:
   argument validation (`usage` on a missing destination), sibling/toplevel checks,
   dry run, conflict detection, `--apply` (copy, remove, config write, README note,
   record comparison), `nothing-to-migrate`. `parseArgs` learns `--apply`. Usage
   header line: `node scripts/agento.mjs migrate <companion-checkout> [--apply]
   (move in-repo artifact roots into the companion; dry run without --apply)`.
   Tests: dry run lists roots/records and writes nothing; conflict on a pre-existing
   `features/2026/09/x/roadmap.md` in the destination exits 3 and writes nothing;
   `--apply` into the clone moves a tree with a binary `evidence/step-1-1-x.png`
   (byte-equal), removes the source roots, creates `.github/agento.json` from the
   template with `repo.name`, preserves an existing config's other keys
   (`branches.default: trunk` survives), appends the README note once (second run
   `nothing-to-migrate`, README unchanged), reports `records.identical: true`; after
   `git add/commit` in both repos, `status`/`initiative` from the product read the
   companion and list the same slugs as before; `--apply` into a registered half
   under `<clone>-worktrees/` resolves `name` from the clone; a non-sibling
   destination → `error`/`not-sibling`.
4. **Hooks (approval-gated; one edit per file)** — `resolve_artifacts()` in both
   hooks: when the primary differs and *its* repo is unset, keep the product root's
   own repo instead of returning in-repo. Tests: `tests/session-context.test.mjs`
   — a managed worktree whose branch commits the companion config while the primary
   has none prints `Artifacts: <companion>` and walks it; `tests/guard.test.mjs` —
   in the same setup `git -C <companion> push origin main` is denied and a product
   delivery-branch commit consults the companion (reason names the companion);
   `tests/guard-fixtures-companion.txt` gains the case if `replay-guard.sh` can
   express it without a harness change (otherwise the node test covers it — note
   the choice on the step). Shellcheck silent.
5. **Prompts (mirrored to `commands/`)** — `agento-init.prompt.md`: description and
   `argument-hint` updated; new `## Migration (--migrate)` section after step 11
   with the M-steps from the Decisions (dry run, in-flight PR refusal, companion
   branch + `migrate --apply` + commit/push/draft PR inside the clone, product
   commit/PR, merge-order note, cross-links, report), step 10's `warn` sentence now
   points at `--migrate`; the idempotency paragraph gains the `nothing-to-migrate`
   and resumed-PR clauses. `ship.prompt.md`: read `artifactsRoot` and `layout` from
   `ship-preflight` (fallback to `config`), `layout: "branch"` counts as companion
   mode — two sentences.
6. **Policy, docs, changelog, version** — policy §9 `/agento agento-init` row gains
   "`--migrate` re-run with the roots already moved reports nothing to migrate and
   resumes the existing PRs"; README set-up table + flow table row + a "Migrating an
   existing project" paragraph (one command, merge companion PR then product PR);
   docs/install.md same; docs/commands.md (init row, `migrate` paragraph, `layout`
   and `artifactsRoot` on `resolve`/`find`/`ship-preflight`/`close-decision`/`paths`,
   the layout rule); docs/architecture.md (layout rule paragraph beside the
   anchoring rule); docs/artifacts.md (in-repo layout is historical; migrated plans'
   links); docs/project-profile.md (`artifacts.repo` rows: the checkout's own config
   decides, the primary anchors and wins when set); AGENTS.md (this repository's
   artifacts live in `../agento-docs`; layout bullets); CHANGELOG `## 0.5.0
   (unreleased)` with the new bullet; versions `0.5.0` in both manifests.
7. **Dogfood (Phase 5)** — the sequence in the Decisions, each step with a
   machine-checkable `verify:`; evidence (`before`/`after` JSON, PR URLs) is written
   into this feature's `evidence/` — which moves with the tree into the companion
   half in the same phase.
8. **Prompt smoke, gate, in-review, post-ship (Phase 6)** — throwaway pair drive of
   `/agento agento-init --migrate` with assertions and a second idempotent pass;
   full gate against the baseline; integrate both origins (product `origin/main`,
   companion `origin/main`), `status: in-review`; the prismicon `(manual, post-ship)`
   step (§4).

Affected files: `scripts/agento.mjs`, `scripts/agento-config.mjs`,
`scripts/agento.test.mjs`, `scripts/agento-config.test.mjs`,
`scripts/hooks/session-context.sh`, `scripts/hooks/delivery-guard.sh`,
`tests/session-context.test.mjs`, `tests/guard.test.mjs`,
`tests/guard-fixtures-companion.txt` (if expressible),
`.github/prompts/agento-init.prompt.md` + `commands/agento-init.md`,
`.github/prompts/ship.prompt.md` + `commands/ship.md`,
`.github/instructions/delivery-policy.instructions.md` (one row), `README.md`,
`docs/install.md`, `docs/commands.md`, `docs/architecture.md`, `docs/artifacts.md`,
`docs/project-profile.md`, `AGENTS.md`, `CHANGELOG.md`, `package.json`,
`.claude-plugin/plugin.json`, `.github/agento.json` (new, written by `migrate`),
and the removal of `features/`, `issues/`, `initiatives/` from the product tree
(moved to `david-perry-software/agento-docs` on `feature/artifact-history-migration`).

## Risks

- **The session converts mid-flight (Q3).** After Phase 5 this worktree's own
  config flips it to companion mode; the roadmap the Builder ticks lives in the
  half, and every step becomes two commits (policy §7). Mitigation: Phase 5 is
  ordered so the CLI rule (Phase 1) and hooks (Phase 3) land and are tested before
  the flip; step 5.7 verifies `session` reports the delivery from the half before
  any further tick; the Builder pause/resume protocol reads both halves.
- **Ship from a primary that is still in-repo (Q6).** Mitigation: branch-aware
  `ship-preflight` (`layout: "branch"`, `artifactsRoot`) tested from a `main`
  primary against a companion-only roadmap; `ship.prompt.md` reads `artifactsRoot`
  from the preflight. Residual: `agento.mjs paths` in the ship teardown must also be
  branch-aware (Approach 2 covers it).
- **Guard nudge fires on every product commit in the paired session.** The nudge
  consults the companion clone's `HEAD`, not the half (pre-existing). Mitigation:
  it is an `ask`, answered by the user; recorded as a follow-up for the hooks, not
  fixed here (one approval-gated edit per hook file, kept to the layout rule).
- **Companion default-branch protection depends on the hook rule.** Until Phase 3
  lands, `git -C ../agento-docs push origin main` from this window would not be
  denied by the guard (the server-side ruleset still blocks it). Mitigation:
  Phase 3 precedes Phase 5; the companion bootstrap uses the Contents API, never
  `git push` to `main`.
- **In-flight deliveries stranded by the move.** Mitigation: the prompt refuses on
  open delivery PRs unless accepted; no PR is open here and no other member is
  ready; documented in README/docs.
- **Merge order for a user run (prismicon).** Product PR merged before the
  companion PR leaves the primary in companion mode reading an empty companion
  `main`. Mitigation: the product PR body and the init report say "merge the
  companion PR first"; `doctor` stays `ok` either way (the clone exists).
- **Historical links break on GitHub (Q4).** Mitigation: the README note appended
  by `migrate --apply`; docs/artifacts.md sentence.
- **Instruction files for artifacts in the primary window.** After the flip the
  product's `delivery-artifacts.instructions.md` `applyTo` no longer matches files
  the primary window edits in `../agento-docs` unless that folder is a workspace
  folder; the companion carries `agento.instructions.md` (contract copy) from the
  init scaffold. Mitigation: AGENTS.md and docs/project-profile.md keep the
  "add `../agento-docs` to the workspace" reminder; `concurrent-delivery.instructions.md`
  stops loading for artifact edits — recorded as a follow-up.
- **Throwaway repositories linger** until the user deletes them (permission carried
  from `artifact-repo-init`). Mitigation: names recorded in roadmap.md
  `## Follow-ups`; the agents never run `gh repo delete`.
- **Prismicon run is post-ship (§4 exception, Q5).** The command exists for prismicon
  only after this feature ships and the plugin clone is updated, and prismicon is
  the user's repository in another window under the user's GitHub account —
  neither preview nor faithful local verification is possible from this session.
  The user accepted the `(manual, post-ship)` step in Q5; ship's epilogue lands its
  screenshot in the companion via `post-ship/artifact-history-migration`.
- **Concurrent delivery.** None open. Mitigation regardless: integrate `origin/main`
  (product) and the companion's `origin/main` by merge before every push (§7).

## Out of scope

- Removing the in-repo layout from the plugin (initiative Out of scope; the layout
  stays supported for projects that never migrate).
- Preserving per-file history in the companion (`git subtree split`,
  `git filter-repo`) — Q1.
- Rewriting historical `../../../../` links in moved plans — Q4.
- Re-targeting the guard's roadmap nudge to the session's companion half
  (follow-up).
- A `.code-workspace` for the primary window written by init (earlier follow-up,
  restated).
- Migrating prismicon from this session (the user's run, post-ship).
- Hosted environments without a sibling directory (initiative Decision 5).

## Acceptance checklist

- [ ] `node scripts/agento.mjs config` run inside a managed worktree whose branch
  commits `.github/agento.json` with `artifacts.repo.name` while the primary has
  none reports `artifactsRoot` equal to `<primary>/../<name>`; the primary's own
  `config` still reports `artifactsRoot === root` — covered by a
  `scripts/agento.test.mjs` test named for the layout rule; `node --test
  scripts/agento.test.mjs` exit 0.
- [ ] From a primary on `main` in the in-repo layout, `resolve`, `find`,
  `ship-preflight --pr`, `close-decision`, `next <slug>`, and `paths feature <slug>`
  for a branch whose `.github/agento.json` names an existing companion return the
  companion-only roadmap with `layout: "branch"`, `artifactsRoot` = the companion
  clone, `companionPr` looked up inside the clone, and `companionGaps: []`; a plain
  in-repo branch returns today's fields plus `layout: "checkout"` — covered by tests
  in `scripts/agento.test.mjs`; exit 0.
- [ ] `node scripts/agento.mjs migrate <dest>` (dry run) writes nothing and lists
  `roots[]`, `records`, `conflicts`; a destination conflict exits 3 with `status:
  "conflict"`; `--apply` moves every file byte-identically (binary evidence
  included), removes the source roots, writes `.github/agento.json` (created from
  the template or preserving existing keys), appends the README note once, reports
  `records.identical: true`; a second `--apply` reports `mode:
  "nothing-to-migrate"`; a non-sibling destination reports `reason: "not-sibling"`
  — covered by tests; `grep -c 'migrate <companion-checkout>' scripts/agento.mjs`
  ≥ 1 (usage header).
- [ ] Both hooks apply the layout rule: `tests/session-context.test.mjs` proves a
  managed worktree whose branch sets the companion config (primary unset) prints
  `Artifacts: <companion>` and walks it; `tests/guard.test.mjs` proves the same
  setup denies `git -C <companion> push origin main` and consults the companion for
  the delivery-branch nudge; `shellcheck` on both hooks silent; both replays exit 0.
- [ ] `.github/prompts/agento-init.prompt.md` has `argument-hint: "[--force]
  [--migrate]"`, a `## Migration (--migrate)` section that runs `agento.mjs migrate`
  with `--apply`, refuses on open delivery PRs unless accepted, opens the companion
  PR from inside the clone and the product PR saying to merge the companion PR
  first, and the idempotency paragraph names `nothing-to-migrate`; `grep -c
  -- '--migrate' .github/prompts/agento-init.prompt.md` ≥ 4; `cmp
  .github/prompts/agento-init.prompt.md commands/agento-init.md` silent;
  `node --test tests/customizations.test.mjs` exit 0.
- [ ] `.github/prompts/ship.prompt.md` reads `artifactsRoot` and `layout` from the
  `ship-preflight` result and treats `layout: "branch"` as companion mode: `grep -c
  '"branch"' .github/prompts/ship.prompt.md` ≥ 1; `cmp` against `commands/ship.md`
  silent.
- [ ] Policy §9 `/agento agento-init` row mentions `--migrate`; README, docs/install.md,
  docs/commands.md, docs/architecture.md, docs/artifacts.md, docs/project-profile.md
  each mention `--migrate` or the layout rule (`grep -l -- '--migrate' README.md
  docs/install.md docs/commands.md` lists all three; `grep -c 'layout' docs/commands.md
  docs/architecture.md docs/project-profile.md` ≥ 1 each); AGENTS.md names
  `../agento-docs` as this repository's artifact location.
- [ ] `package.json` and `.claude-plugin/plugin.json` both read `"version": "0.5.0"`;
  `grep -c '^## 0.5.0 (unreleased)' CHANGELOG.md` = 1 (ship stamps the date) and the
  section's first bullet describes the migration and the layout rule.
- [ ] This repository is migrated on this branch: `git ls-tree -r --name-only
  origin/feature/artifact-history-migration` in the product lists no path under
  `features/`, `issues/`, or `initiatives/` and does list `.github/agento.json`
  with `"name": "agento-docs"`; `git -C /home/david/DP/agento-docs ls-tree -r
  --name-only origin/feature/artifact-history-migration | grep -c
  'roadmap.md\|breakdown.md'` = 19 (16 features + 1 issue + 2 initiatives) and the
  `evidence/` files count equals the pre-move count recorded in
  `evidence/step-5-4-migrate-before.json`; `migrate --apply` output in
  `evidence/step-5-4-migrate-after.json` shows `records.identical: true`.
- [ ] From this worktree, `node scripts/agento.mjs session --pr` reports `companion
  { path: /home/david/DP/agento-docs-worktrees/plan-20260917-231812, branch:
  feature/artifact-history-migration, registered: true, dirty: false, ahead: 0 }`,
  `delivery.roadmap: features/2026/09/artifact-history-migration/roadmap.md`,
  `delivery.artifactPr` equal to the roadmap header's `artifact-pr`, and
  `companionPr.number` equal to it; from the primary
  (`node <agento-root>/scripts/agento.mjs ship-preflight feature
  artifact-history-migration --pr --root /home/david/DP/agento`) reports `layout:
  "branch"`, `artifactsRoot: /home/david/DP/agento-docs`, `companionPr` non-null.
- [ ] The prompt smoke on `agento-smoke-migrate-<YYYYMMDD>`: after the drive, the
  companion repository's `changes/agento-init` branch carries the seeded tree
  (`git ls-tree -r --name-only origin/changes/agento-init` lists the seeded
  `roadmap.md`, `breakdown.md`, and `evidence/*.png`), the product PR body links the
  companion PR and says to merge it first, `agento.mjs doctor --root <smoke
  product>` `artifact-repo` is `ok`, and the second pass reports
  `nothing-to-migrate` with no new PRs — recorded in
  `evidence/step-6-1-migrate-smoke.md`.
- [ ] Full-repository gate against the §5 baseline: `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` exit 0 with `# fail 0` and `# tests` ≥ 190; `shellcheck
  scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` exit 0, no output;
  both replay commands exit 0; no new or undocumented findings.
- [ ] `node scripts/agento.mjs initiative external-artifact-repo` (from this
  worktree, reading the companion half) lists `artifact-history-migration` as
  `in-review` with `errors: []` at handoff, and `done: true` once the roadmap is
  `complete`.
- [ ] (deferred to post-ship) The user's prismicon run: `/agento agento-init
  --migrate` from prismicon's primary window creates `prismicon-docs`, the companion
  PR and product PR are merged in that order, and
  `evidence/step-6-4-prismicon-migration.png` shows `agento.mjs doctor`
  `artifact-repo` `ok` with `prismicon-docs` — landed by the ship epilogue.
