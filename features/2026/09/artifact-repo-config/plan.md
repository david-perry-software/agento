# Artifact repository config: `artifacts.repo` and companion-root resolution in the CLI

## Problem

Every Agento reader of delivery artifacts — `agento.mjs` subcommands (`config`,
`resolve`, `find`, `status`, `close-decision`, `ship-preflight`, `paths`,
`initiative`, `session`, `next`, `doctor`) and the shared resolver in
`scripts/delivery-roadmap-resolver.mjs` — joins the git toplevel of the current
checkout with `config.artifacts.{features,issues,initiatives}` and reads git refs
from that same repository. There is no way to say "the artifacts live in a sibling
repository". This feature is the wave‑1 member **`artifact-repo-config`** of the
initiative [external-artifact-repo](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md)
(`### artifact-repo-config` block): `.github/agento.json` gains an `artifacts.repo`
block, and when it is set the CLI resolves every artifact path and artifact git-ref
read against the companion checkout, with `doctor` verifying that checkout. When it
is unset every subcommand behaves exactly as today, so `main` stays usable while the
later members (init, hooks, paired worktrees, mirrored branches, dual-merge ship,
migration) land one PR at a time.

User-visible effect: a target repository can point Agento at `../<repo>-docs`;
`agento.mjs config` reports the resolved `artifactsRoot`; `status`, `initiative`,
`session`, `next`, `find`, and `resolve` list and resolve roadmaps from the
companion; `doctor` hard-fails with a fallback naming `/agento agento-init` when the
configured companion is missing.

## Decisions

Clarifying questions asked with the ask-questions tool; answers verbatim.

- **Q: What turns companion mode on in `.github/agento.json`? (Template ships nulls =
  "keep default", so `{name: null, dir: null}` must mean in-repo.)**
  A: Non-null `artifacts.repo.name` (or `dir`) — `{ "artifacts": { "repo": { "name":
  "prismicon-docs" } } }` enables it; `dir` defaults to `../<name>`. Nulls = in-repo,
  byte-for-byte today.
- **Q: When the CLI runs inside a managed worktree (`<worktrees.dir>/plan-<id>`),
  `../<name>` resolves to the wrong place. Where should `artifacts.repo.dir` resolve
  from?** A: Primary checkout, like `worktrees.dir` — reuse the `primaryWorktreesDir`
  pattern; every worktree reads the same sibling clone. Paired companion worktrees
  come in wave 2.
- **Q: When `artifacts.repo` is set but the companion checkout is missing/not a git
  repo/has no `origin`, how should the new `doctor` `artifact-repo` check report, and
  which capability does it hang off?** A: `fail`, under `terminal` — every command
  with a terminal need hard-stops with fallback `/agento agento-init`; unset repo →
  `ok` "in-repo layout".
- **Q: With `artifacts.repo` set, what if the product repo still contains in-repo
  `features/`/`issues/`/`initiatives/` (pre-migration state)?** A: Ignore them;
  companion is the only source — simple and deterministic; `doctor` `artifact-repo`
  adds a `warn`-level detail naming the stale roots.
- **Q: The breakdown lists `paths` among routed readers. What should `agento.mjs
  paths` change in this feature?** A: Add `artifactsRoot` (absolute) and make
  `artifactRoot` absolute under it — keeps today's fields; companion fields
  (`companion: {...}`) stay for paired-artifact-worktrees.

Planner's derived decisions (no user question needed; recorded so the Builder does
not re-decide them):

- `artifacts.repo.name` defaults to `<primary-repo-basename>-docs` when only `dir`
  is set; `dir` defaults to `../<name>` when only `name` is set; both are resolved
  against the **primary** checkout path (the first `git worktree list --porcelain`
  entry), using the primary checkout's config when it differs from the current
  root — exactly how `primaryWorktreesDir()` already treats `worktrees.dir`.
- The companion's default branch is assumed to be `config.branches.default` (the
  same name as the product repo). Wave‑2 `artifact-repo-init` creates it that way;
  a separate `artifacts.repo.default` key is out of scope.
- `mergedAnomalies()` (`initiative` command) keeps reading `origin/<default>` merge
  state from the **product** repo: the anomaly it reports is "code branch merged but
  roadmap not complete", and the code branch lives in the product repo.
- In-repo mode (`artifacts.repo` unset) performs no additional git calls at startup
  and emits the same JSON keys as today for every subcommand except `config` and
  `paths`, which gain `artifactsRoot` (equal to `root` in that mode) per Decision 5.
  `doctor` gains one extra check (`artifact-repo`, `ok` in that mode).

## Research

Skills consulted: none — no matching domain (the repository has no
`.agents/skills/` directory — `file_search .agents/skills/**/SKILL.md` returned
nothing — and its AGENTS.md has no `## Agento` skills table).

### Lint baseline (policy §5)

Run from the planning worktree at `origin/main` `2025016`:

- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0; `# tests
  141`, `# pass 141`, `# fail 0`.
- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no output.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.

The baseline is green, so there is no overlap decision to make and no scoped gate:
the Builder reruns the **full** baseline (all three commands) at every step's
`verify:` that touches scripts, and the Reviewer compares against `141 pass / 0
fail`, shellcheck silent, guard exit 0. Note for the Builder: the delivery guard
denies shell redirects that name `scripts/hooks/*` paths (it treated `shellcheck
scripts/hooks/*.sh > /tmp/x.log` as a hook write); run shellcheck without output
redirection.

### Codebase findings (file:line as of `2025016`)

- **Config.** [scripts/agento-config.mjs](../../../../scripts/agento-config.mjs)
  `defaultConfig()` (L6–20) returns `artifacts: { features, issues, initiatives }`,
  `worktrees.dir: ../<basename>-worktrees`, `branches.*`, `checks.releaseWorkflow`;
  `mergeConfig()` (L26–37) recurses into plain objects and treats `null` as "keep
  the default", so a template shipping `"repo": { "name": null, "dir": null }` merges
  to the defaults and a user setting `{ "repo": { "name": "x" } }` leaves `dir: null`
  to be derived. `loadAgentoConfig()` (L39–48) reads `.github/agento.json` then
  `agento.json`. Tests: [scripts/agento-config.test.mjs](../../../../scripts/agento-config.test.mjs)
  (defaults, override, nulls, template load, root-level fallback).
- **CLI roots.** [scripts/agento.mjs](../../../../scripts/agento.mjs) L73–82:
  `root = git rev-parse --show-toplevel`, `config` from `root`, `worktreesDir`,
  `currentBranch`, and `gitAdapter = { lsTree, show }` bound to `root`. Artifact
  readers: `walkFiles`/`walkRoadmaps`/`walkBreakdowns` (L99–120), `describe()` L145
  (`rel` relative to `root`), `describeFromRef()` L161 (`git(root, "show"|"ls-tree")`),
  `allRoadmaps()` L176 (`path.join(root, config.artifacts.features|issues)`),
  `parseBreakdown()` L354 (`rel` relative to `root`), `allBreakdowns()` L408
  (`path.join(root, config.artifacts.initiatives)`), `refFor()` L498 and
  `reviewFreshness()` L508 (`git log` on `<dir>/review.md` in `root`),
  `roadmapOnBranch()` L518 (resolver + `git(root, "ls-tree" …)` on the local branch),
  `mergedAnomalies()` L395 (`git branch -r --merged origin/<default>` — code merge
  state). Subcommands passing `rootDir: root, git: gitAdapter` to the resolver:
  `resolve` L569, `find` L577, `close-decision` L602, `ship-preflight` L609.
  `primaryWorktreesDir()` L210–214 is the existing "resolve a sibling path against
  the primary checkout, loading the primary's config when it differs" helper.
- **Resolver.** [scripts/delivery-roadmap-resolver.mjs](../../../../scripts/delivery-roadmap-resolver.mjs):
  `artifactRoots()` L7, `branchOwner()` L21–29 (worktree ownership — product repo),
  `findLocalRoadmaps({ rootDir, type, slug, config })` L31–74 walks
  `path.join(rootDir, rel)`, `resolveRoadmapArtifact()` L120 uses `findLocalRoadmaps`
  then `git.lsTree(origin/<branch>)` / `git.show`, `closeBuildSessionDecision()` L207
  and `evaluateShipPreflight()` L268 forward `rootDir` to both the artifact walk and
  `branchOwner`. Tests: [scripts/delivery-roadmap-resolver.test.mjs](../../../../scripts/delivery-roadmap-resolver.test.mjs)
  use `tmpRoot()` + `makeGitMock({ remotePaths, remoteContent })`.
- **`paths`.** L624–640 emits `worktreesDir`, `worktree`, `branch`, `artifactRoot`
  (repo-relative string), `defaultBranch`, `postShipBranch`. No prompt reads
  `artifactRoot` today (`grep artifactRoot\b` hits only agento.mjs L635), so making it
  absolute is safe.
- **`config`.** L554–563 emits `config` with `worktrees.dir` already resolved to an
  absolute path — the precedent for emitting resolved `artifacts.repo.dir` and
  `artifactsRoot`.
- **`doctor`.** `DOCTOR_CHECKS` L237–284 (`node`, `git-remote`, `gh`, `code`,
  `python3`, `worktrees-dir`), `CAPABILITY_CHECKS` L290 (`terminal: ["node",
  "python3", "worktrees-dir"]`), `COMMAND_NEEDS` L302 (unchanged by this feature),
  `runDoctor()` L334. Tests enumerate the check ids literally:
  [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs) L209–226 ("six ok
  checks"), L301 and L307 (`--for close-session` → `node, python3, worktrees-dir`;
  `--for ship`). [docs/commands.md](../../../../docs/commands.md) L46–47 says "six
  environment checks". [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs)
  "the CLI needs table agrees with every prompt's Needs: line" spawns `doctor --for
  <name>` under a node+git-only PATH and compares `for.needs` — unaffected because
  `COMMAND_NEEDS` does not change.
- **Test fixtures.** `agento.test.mjs` `makeRepo({ config })` (L17–33) creates a
  bare origin plus a clone under one temp `base`; `makeWorktreeRepo()` (L316–321)
  adds `<base>/wt` as `worktrees.dir`. A companion fixture fits the same pattern:
  a second bare + clone at `<base>/project-docs` (sibling of `<base>/project`).
- **Templates and docs naming the config.** [templates/agento.json](../../../../templates/agento.json)
  L2; [docs/project-profile.md](../../../../docs/project-profile.md) L12 (snippet) and
  L27–29 (key table); [.github/prompts/agento-init.prompt.md](../../../../.github/prompts/agento-init.prompt.md)
  step 2 (L27–44, snippet + the `worktrees.dir: null` sentence) mirrored
  byte-identically in [commands/agento-init.md](../../../../commands/agento-init.md);
  [docs/architecture.md](../../../../docs/architecture.md) L87–96 (configuration
  boundary table); [docs/artifacts.md](../../../../docs/artifacts.md) L3–6 ("in the
  target repository … roots are configurable"); [docs/commands.md](../../../../docs/commands.md)
  L46 (doctor check list). [CHANGELOG.md](../../../../CHANGELOG.md) carries per-release
  sections (e.g. L61 lists the doctor checks).
- **Hooks are out of scope here** (member `artifact-repo-hooks`).
  [scripts/hooks/session-context.sh](../../../../scripts/hooks/session-context.sh)
  reads only `payload.cwd`/`workingDirectory` (L23) — the SessionStart payload
  carries **no list of VS Code workspace folders**, so the initiative's risk item
  "`doctor` warns when the companion folder is not a workspace folder" is **not
  detectable** from the CLI or hook; this plan documents it in
  docs/project-profile.md instead of adding a check (see Risks).
- **Concurrent deliveries.** `gh pr list --state open --json number,headRefName,title`
  → no open PRs. No file overlap to sequence around.

## Approach

All changes are additive and gated on `artifacts.repo` being set; with it unset the
code paths reduce to today's (`artifactsRoot === root`, `artifactsGit === gitAdapter`).

1. **`scripts/agento-config.mjs`**
   - `defaultConfig()` adds `artifacts.repo: { name: null, dir: null }`.
   - New export `resolveArtifactsRoot({ config, rootDir, primaryRoot = rootDir })`
     returning `{ external: boolean, name: string|null, dir: string|null, root:
     string }`: when `repo.name` and `repo.dir` are both null → `{ external: false,
     name: null, dir: null, root: rootDir }`; otherwise `name = repo.name ??
     path.basename(path.resolve(primaryRoot, repo.dir))` when `dir` is set, else
     `repo.name`; `dir = path.resolve(primaryRoot, repo.dir ?? path.join("..",
     name))`; `root = dir`. When `dir` is set and `name` is null, `name =
     path.basename(dir)`. When only `name` is set, `dir = ../<name>` relative to
     `primaryRoot`. (Non-sibling `dir` values are accepted as given — validating
     "sibling only" is not enforced in code; Decision 5 of the initiative merely
     says non-sibling layouts are unsupported.)
2. **`scripts/agento.mjs`**
   - After the existing `root`/`config` bootstrap: a lazy `primaryRoot()` (first
     `parseWorktreeList(git(root, "worktree", "list", "--porcelain"))` entry, else
     `root`; called only when `config.artifacts.repo.name ?? config.artifacts.repo.dir`
     is non-null), then `const artifacts = resolveArtifactsRoot({ config:
     primaryConfig, rootDir: root, primaryRoot })` where `primaryConfig` is the
     primary checkout's config when `primaryRoot !== root` (mirror of
     `primaryWorktreesDir`). `artifactsRoot = artifacts.root`; `artifactsGit = {
     lsTree, show }` bound to `artifactsRoot` (identical object to `gitAdapter` when
     not external). A small `agit(...args)` helper = `git(artifactsRoot, ...args)`.
   - Route through `artifactsRoot`/`artifactsGit`: `describe()` `rel`,
     `describeFromRef()`, `allRoadmaps()`, `parseBreakdown()` `rel`,
     `allBreakdowns()`, `refFor()`, `reviewFreshness()`, `roadmapOnBranch()` (both
     the resolver call and the local-branch `ls-tree`), and the `resolve`, `find`,
     `close-decision`, `ship-preflight` resolver calls (`git: artifactsGit,
     artifactsRoot`). `mergedAnomalies()` stays on `root`.
   - `config` output: `artifactsRoot` (absolute) and `config.artifacts.repo` emitted
     as `{ name, dir }` with `dir` absolute when external, nulls when not.
   - `paths` output: add `artifactsRoot`; `artifactRoot` becomes
     `path.join(artifactsRoot, config.artifacts.features|issues)` (null for
     plan/freehand as today).
   - `doctor`: new `"artifact-repo"` check appended after `worktrees-dir` and added
     to `CAPABILITY_CHECKS.terminal`. Unset → `ok`, detail `in-repo layout
     (artifacts.repo unset)`. Set → `fail` with fallback ``run `/agento agento-init`
     to create and clone the companion repository <name> at <dir>, or correct
     artifacts.repo in .github/agento.json`` when: the directory is absent; `git -C
     <dir> rev-parse --show-toplevel` is not `<dir>` (not a checkout, or a nested
     path); `git -C <dir> remote get-url origin` is empty; neither
     `refs/remotes/origin/<default>` nor `refs/heads/<default>` resolves. Otherwise
     `ok` with detail `<dir> (<name>), origin <url>, <default> present` — or `warn`
     with detail naming each non-empty in-repo root still present under the primary
     checkout (`stale in-repo roots: features/, issues/`) and fallback naming
     `/agento agento-init --migrate` (the wave‑5 migration) / removal. No network
     probe: the check stays offline-safe under `terminal`.
3. **`scripts/delivery-roadmap-resolver.mjs`**
   - `findLocalRoadmaps`, `resolveRoadmapArtifact`, `closeBuildSessionDecision`,
     `evaluateShipPreflight` accept an optional `artifactsRoot` (default `rootDir`)
     used for the artifact walk and for `path.relative`; `branchOwner` and
     `loadAgentoConfig` keep using `rootDir` (product repo). `git` is whatever the
     caller passes (the CLI passes `artifactsGit`).
4. **Tests**
   - `agento-config.test.mjs`: defaults include `repo` nulls; template still loads;
     `resolveArtifactsRoot` cases (unset; name only; dir only; both; primaryRoot ≠
     rootDir).
   - `delivery-roadmap-resolver.test.mjs`: `artifactsRoot` walks the companion, not
     `rootDir`; default keeps today's behaviour.
   - `agento.test.mjs`: `makeRepo({ config, companion })` helper creating
     `<base>/project-docs` (bare + clone, `main` pushed); tests for `config`
     (`artifactsRoot`, resolved `repo.dir`), `status`/`initiative`/`session`/`next`
     reading roadmaps and breakdowns from the companion while ignoring in-repo roots,
     `resolve`/`find` remote fallback from the companion's `origin/feature/<slug>`,
     `paths` absolute roots, managed-worktree resolution (from `<wt>/plan-x` the
     companion is `<base>/project-docs`), and `doctor` `artifact-repo` in all four
     states (unset ok, valid ok, missing/invalid fail with `/agento agento-init`
     fallback, stale-roots warn); existing "six ok checks" and `--for` id lists
     updated to seven checks.
5. **Templates and docs**: `templates/agento.json` (`"repo": { "name": null, "dir":
   null }`), `docs/project-profile.md` (snippet + two table rows + a note that the
   primary VS Code window must add the companion as a workspace folder for the
   editor to see it — not detectable by `doctor`), `agento-init.prompt.md` step 2
   snippet and one sentence (`artifacts.repo.name` … `<repo>-docs`) mirrored into
   `commands/agento-init.md`, `docs/architecture.md` boundary table row,
   `docs/artifacts.md` intro sentence, `docs/commands.md` doctor list ("seven …
   `artifact-repo`") and `config`/`paths` field additions, CHANGELOG unreleased
   entry.

Affected files: `scripts/agento-config.mjs`, `scripts/agento-config.test.mjs`,
`scripts/agento.mjs`, `scripts/agento.test.mjs`,
`scripts/delivery-roadmap-resolver.mjs`, `scripts/delivery-roadmap-resolver.test.mjs`,
`templates/agento.json`, `docs/project-profile.md`, `docs/architecture.md`,
`docs/artifacts.md`, `docs/commands.md`, `.github/prompts/agento-init.prompt.md`,
`commands/agento-init.md`, `CHANGELOG.md`.

## Risks

- **Resolving against the wrong checkout from a worktree.** `../<name>` from
  `<worktrees.dir>/plan-<id>` would point into the worktrees dir. Mitigation:
  resolve against the primary checkout (Decision 2) with a dedicated test from a
  managed worktree; reuse the `primaryWorktreesDir` pattern rather than a new one.
- **Config drift between a worktree and the primary.** A delivery branch may carry
  a different `.github/agento.json`. Mitigation: when `primaryRoot !== root`, read
  `artifacts.repo` from the primary's config, exactly as `worktrees.dir` is today;
  documented in Decisions.
- **Companion default-branch name.** Assumed equal to `branches.default`.
  Mitigation: documented assumption; `doctor` reports the missing ref by name so a
  mismatch is visible; a dedicated key is a follow-up if init ever needs it.
- **Editor cannot see the companion folder** (initiative risk). The SessionStart
  payload has only `cwd`, so no CLI/hook check can tell whether the companion is a
  workspace folder. Mitigation: state it in docs/project-profile.md now; the
  multi-root workspace mechanics belong to `paired-artifact-worktrees`.
- **Hard-fail blast radius.** `artifact-repo` under `terminal` means every command
  hard-stops when the companion is misconfigured. Mitigation: chosen deliberately
  (Decision 3); the fallback names the exact repair command and the unset case is
  always `ok`.
- **Byte-for-byte in-repo behaviour.** Existing tests (141) are the regression net;
  the only intentional output additions in unset mode are `config.artifactsRoot`,
  `config.config.artifacts.repo`, `paths.artifactsRoot`, absolute
  `paths.artifactRoot`, and the seventh doctor check.
- **Concurrent delivery.** No open PRs at planning time. Mitigation regardless:
  integrate `origin/main` by merge before every push (policy §7).

## Out of scope

- Creating or cloning the companion repository (`artifact-repo-init`).
- Hooks (`session-context.sh`, `delivery-guard.sh`) reading `artifacts.repo`
  (`artifact-repo-hooks`).
- Paired worktrees, multi-root workspace files, `session.companion`
  (`paired-artifact-worktrees`).
- Writing artifacts, mirrored branches, companion PRs, dual merge
  (`mirrored-artifact-branches`, `ship-dual-merge`).
- Migrating this repository's or `prismicon`'s history (`artifact-history-migration`).
- Non-sibling companion locations, hosted environments, a separate companion
  default-branch key, removing the in-repo mode.
- Network reachability of the companion's `origin` (the product `git-remote` check
  remains the only network probe).

## Acceptance checklist

- [ ] `defaultConfig()` includes `artifacts.repo: { name: null, dir: null }`, and
  loading `templates/agento.json` keeps `repo` nulls — verify: `node --test
  scripts/agento-config.test.mjs` passes the new assertions.
- [ ] `resolveArtifactsRoot()` returns `external: false, root: rootDir` when both
  fields are null; `../<name>` relative to `primaryRoot` when only `name` is set;
  `name = basename(dir)` when only `dir` is set; and honours `primaryRoot ≠
  rootDir` — verify: unit tests in `scripts/agento-config.test.mjs`.
- [ ] With `artifacts.repo.name` set, `agento.mjs status`, `initiative`, `session`,
  and `next` read roadmaps/breakdowns from the companion checkout and ignore
  in-repo roots — verify: new `scripts/agento.test.mjs` tests using the companion
  fixture, including one where the product repo also has a `features/` roadmap
  that must not appear.
- [ ] `resolve` and `find` fall back to the **companion's** `origin/<branch>` when the
  companion checkout has no local roadmap — verify: test pushes a roadmap on
  `feature/<slug>` in the companion only and asserts `source: "remote"`.
- [ ] From a managed worktree (`<worktrees.dir>/plan-<id>`), the companion resolves
  to the primary checkout's sibling — verify: test asserts `config.artifactsRoot ===
  <base>/project-docs` when run with `cwd` inside `<base>/wt/plan-x`.
- [ ] `agento.mjs config` emits `artifactsRoot` (absolute) and `config.artifacts.repo`
  with an absolute `dir` when set, nulls when unset; `paths` emits `artifactsRoot`
  and an absolute `artifactRoot` — verify: tests for both modes.
- [ ] `doctor` has a seventh check `artifact-repo` under `terminal`: `ok` when unset
  ("in-repo layout"), `ok` for a valid companion, `fail` (exit 3) with a fallback
  containing `/agento agento-init` when the directory is missing, not a git
  toplevel, lacks `origin`, or lacks the default branch, and `warn` naming stale
  in-repo roots — verify: `scripts/agento.test.mjs` doctor tests; `node
  scripts/agento.mjs doctor --for close-session` lists `node, python3,
  worktrees-dir, artifact-repo`.
- [ ] With `artifacts.repo` unset every pre-existing test passes unchanged except
  the literal doctor id lists — verify: `git diff origin/main -- scripts/agento.test.mjs`
  shows edits to existing tests only in the doctor id arrays / "six"→"seven" title.
- [ ] `templates/agento.json`, `docs/project-profile.md`, `agento-init.prompt.md` +
  `commands/agento-init.md` (byte-identical), `docs/architecture.md`,
  `docs/artifacts.md`, `docs/commands.md`, and `CHANGELOG.md` describe
  `artifacts.repo` and the `artifact-repo` check — verify: `diff
  .github/prompts/agento-init.prompt.md commands/agento-init.md` prints nothing;
  `grep -l 'artifacts.repo\|artifact-repo' templates/agento.json
  docs/project-profile.md docs/architecture.md docs/artifacts.md docs/commands.md
  CHANGELOG.md commands/agento-init.md` lists all seven.
- [ ] Full lint gate green and equal to baseline: `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` exit 0 with 0 failures (count ≥ 141), `shellcheck
  scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` exit 0,
  `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0 — verify: the
  Builder records the three exit codes and the test count in roadmap step 4.2.
