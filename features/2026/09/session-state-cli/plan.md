# session-state-cli: `agento.mjs session` — the authoritative role/worktree/delivery/lifecycle record

## Problem

Agento's window-role detection is prose repeated in every prompt: `start-session`,
`close-session`, `quick-fix`, `new-initiative`, `start-freehand`, `finish-freehand`,
and `ship` each tell the model to read `git worktree list --porcelain` and decide
whether "this is the primary worktree". Nothing returns the role as data, lifecycle
state is scattered across the roadmap header, `review.md`, and GitHub, and the
SessionStart hook does not say which window a session is in. That is the root of the
"mistook the primary window for a secondary worktree" incidents.

This feature adds `node scripts/agento.mjs session` — one JSON record answering "where
am I, what is active, what may I run next" — emits a one-line `Session:` summary from
the SessionStart hook, and shows the record in `/agento delivery-status`. No other
prompt changes here; consumers adopt the record in the `window-aware-commands` member.

Initiative member: this plan implements the `### session-state-cli` block of
[workflow-orchestration/breakdown.md](../../../../initiatives/2026/09/workflow-orchestration/breakdown.md)
(Wave 1, no `Requires:`).

## Decisions

The ask-questions tool was unavailable in this session; questions were asked in chat
with a stated default for each, and the user answered **"defaults"** (the first-listed
option of every question is adopted verbatim below).

- **Q1: Should `agento.mjs session` call `gh pr view` by default, or only behind an
  opt-in flag so the SessionStart hook stays fast?** A: defaults → opt-in `--pr` flag;
  the hook omits it; `/agento delivery-status` passes it.
- **Q2: Hook output shape — one `Session:` line or a multi-line block, and what
  happens when Node is missing?** A: defaults → one line
  (`Session: role=… worktree=… delivery=… lifecycle=… allowed=[…]`); when Node is
  missing the hook silently falls back to today's Python output with no `Session:`
  line.
- **Q3: A promoted `plan-<id>` worktree now on `feature/<slug>` — does `role` report
  `build`, `plan`, or `plan-promoted`?** A: defaults → `build` (branch prefix wins over
  directory-name prefix; `worktree.dirPrefix` still exposes `plan`).
- **Q4: For `role: freehand` / `role: unmanaged`, is `delivery` derived from the branch
  prefix and is `allowed` a fixed list?** A: defaults → `delivery` is derived from the
  branch prefix whenever the branch matches `feature/`/`issue/`; `freehand` gets a
  fixed `allowed` (`/agento finish-freehand <slug>`, `/agento commit-current-changes`);
  `unmanaged` gets `allowed: []` with `elsewhere` naming the primary window.
- **Q5: Consumers in scope — docs/README/CHANGELOG updated, delivery-status change
  limited to adding the record, no other prompt touched?** A: defaults → yes: update
  `docs/commands.md`, `README.md`, `docs/hooks.md`, `AGENTS.md` CLI list, and
  `CHANGELOG.md`; the `delivery-status` prompt only gains a `session --pr` step and a
  "Session" section; no other prompt or agent is edited.

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/`
directory and no `## Agento` skills table in `AGENTS.md`; verified 2026-09-13).

### Codebase facts

- **CLI shape.** `scripts/agento.mjs` is a single-file `switch` over subcommands
  (`config`, `resolve`, `find`, `status`, `close-decision`, `ship-preflight`, `ports`,
  `paths`, `initiative`) — see the usage header lines 7–16 and `switch (command)` at
  L322. Shared state computed at startup: `root` (git toplevel of `--root`/cwd),
  `config`, `worktreesDir = path.resolve(root, config.worktrees.dir)`, `currentBranch`
  (L64–71). `usage()` prints lines 1–17 of the file as the usage block (L34–37), so a
  new subcommand must be added to that header.
- **Roadmap description already exists.** `describe(file, type)` (L109–131) returns
  `status`, `branch`, `nextStep`, `reviewVerdict` (`approve|request-changes|null` from
  `review.md`), `steps {ticked,total}`, `postShipPending`, `initiative`. `allRoadmaps()`
  (L133–141) walks the configured artifact roots. Lifecycle can be derived from these
  fields plus PR state.
- **Managed path derivation exists one way only.** `paths <kind> <id>` (L358–374)
  computes `<worktreesDir>/<kind>-<id>` and the branch from `config.branches.*`; the
  reverse (cwd → kind/id) does not exist. Directory prefixes in use: `plan-<session-id>`
  (`commands/start-session.md` L44–45), `feature-<slug>`/`issue-<slug>` for build
  sessions (`commands/start-session.md` L75 creates the worktree at `paths <type>
  <slug>`), and `freehand-<slug>` (`commands/start-freehand.md` L35–36). A promoted planning worktree
  keeps its `plan-<session-id>` directory while on `feature/<slug>`
  (`commands/start-session.md` L69–74, `commands/close-session.md` L17–19).
- **Role heuristic to replace later.** `closeBuildSessionDecision()` in
  `scripts/delivery-roadmap-resolver.mjs` L188–215 tests a regex
  `worktree .*<worktreeBase>[/\\]` against `git worktree list --porcelain` and
  `currentBranch !== default`. This plan leaves it untouched (consumption is
  `window-aware-commands`), but the new role function is exported so it can be reused.
- **git adapter.** `git(root, ...args)` (L44–50) swallows errors and returns `""`;
  `git worktree list --porcelain` output blocks are `worktree <path>` / `HEAD <sha>` /
  `branch refs/heads/<name>` or `detached`, separated by blank lines (verified in this
  worktree: primary at `/home/david/DP/agento` on `refs/heads/main`, this one
  `detached` before the branch was created).
- **Hook.** `scripts/hooks/session-context.sh` is Bash + a Python heredoc (L13–77). It
  reads `cwd` from the hook JSON, prints `Current git branch:`, `Agento CLI: node
  <AGENTO_ROOT>/scripts/agento.mjs` when that file exists (L47–49), one `Delivery work:`
  line per resumable roadmap, and always exits 0. `AGENTO_ROOT` is exported at L10–11.
  Editing it is approval-gated (`scripts/hooks/delivery-guard.sh` PROTECTED rules; see
  `docs/hooks.md` table rows "Editing a hook file with an edit tool → ask").
- **Hook tests.** `tests/session-context.test.mjs`: 5 tests, each spawning `bash
  <hook>` with `{cwd}` JSON and regex-matching `additionalContext`. `makeRepo()` makes
  a plain `git init` repo (no worktrees, no origin) — new tests for `Session:` need a
  repo with a second worktree and a `.github/agento.json` pointing `worktrees.dir` at
  a temp directory.
- **CLI tests.** `scripts/agento.test.mjs`: `makeRepo()` creates a clone with a bare
  origin (L17–33), `writeRoadmap()` (L35–39), `run(cwd, ...args)` parses JSON and
  returns `{ json, status }`. 17 tests today; the `usage` test (L167) asserts the
  header lists subcommands.
- **Dashboard prompt.** `commands/delivery-status.md` ≡ `.github/prompts/
  delivery-status.prompt.md` (byte-identical, asserted by
  `tests/customizations.test.mjs` L215–228 "plugin commands must mirror workspace
  prompts"). Steps 1–5 run `status`, `gh pr list`, present a table, run `initiative`,
  flag anomalies. Frontmatter `tools: [read, search, execute]`.
- **Docs that enumerate CLI subcommands** and must gain `session`: `docs/commands.md`
  L26–33 ("Subcommands: …"), `AGENTS.md` L16–17, `README.md` L69–71 (prose only, no
  list — mention optional), `CHANGELOG.md` (new entry under a `## 0.4.0 (unreleased)`
  heading; current top is `## 0.3.0 (2026-09-06)`; `plugin.json`/`package.json` are
  both `0.3.0`). Hook output described in `docs/hooks.md` L7–13 and `README.md`
  L414–415 ("SessionStart injects …").
- **`gh` availability.** Policy §1 requires `command -v gh` before first use; the CLI
  must not fail when `gh` is absent or unauthenticated (breakdown Risks: `pr: null` +
  `warnings[]`). `gh pr view <branch> --json number,state,isDraft,mergeStateStatus,url`
  is the documented field set.

### Lint baseline (policy §5)

Full-repository lint commands from `AGENTS.md`, run 2026-09-13 on `origin/main`
(`87b7bbd`):

| Command | Exit | Findings |
|---|---|---|
| `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` | 0 | none |
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | 70 pass, 0 fail |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | all fixtures match |

Baseline is green, so no cleanup prerequisite exists. Gate for this delivery: **full
gate** — the Builder reruns all three commands after every phase and the Reviewer
reruns them fresh; any new finding is a regression to fix in this delivery.

### Concurrent deliveries

`gh pr list --state open --json number,headRefName` → `[]` (no open delivery PRs on
2026-09-13). Sibling wave-1 members `command-receipts` and `canonical-commands` are
`unplanned`; if they start concurrently, the shared files are `CHANGELOG.md`,
`docs/commands.md`, `README.md`, and `tests/customizations.test.mjs` (see Risks).

## Approach

### 1. `agento.mjs session [--pr]` (new subcommand, `scripts/agento.mjs`)

Add to the usage header and the `switch`. The subcommand composes three pure,
exported helpers placed in a new module `scripts/session-state.mjs` so they are
unit-testable without spawning the CLI and reusable by `window-aware-commands`:

- `parseWorktreeList(porcelain)` → `[{ path, head, branch|null, detached }]`.
- `deriveRole({ cwd, worktrees, worktreesDir, config })` →
  `{ role, worktree }` where `worktree = { path, branch, detached, isPrimary,
  isManaged, dirPrefix, id }`. Rules, in order:
  1. `cwd` resolves (realpath) to the first `worktree` entry → `role: primary`,
     `isPrimary: true`.
  2. Otherwise, if `cwd` is inside `worktreesDir` and its top-level directory name
     matches `^(plan|feature|issue|freehand)-(.+)$` → `isManaged: true`,
     `dirPrefix`, `id`. Role: `freehand` when prefix is `freehand`; `build` when the
     branch starts with `config.branches.feature` or `.issue` (this is how a promoted
     `plan-*` worktree becomes `build` — Decision Q3); otherwise `plan`.
  3. Else `role: unmanaged` (a worktree Agento did not create, or a plain directory).
- `deriveDelivery({ branch, dirPrefix, id, roadmaps, config })` → `null` or
  `{ type, slug, ...describe() fields }`: type/slug come from the branch prefix
  (`feature/x` → feature `x`), falling back to `dirPrefix`/`id` when the directory
  prefix is `feature`/`issue` and the branch is detached. Roadmap fields come from
  `allRoadmaps()` matched by slug+type (`null` fields when no roadmap exists yet, e.g.
  a fresh planning branch before the first commit).
- `deriveLifecycle({ delivery, pr })` → one of `no-delivery | planned | building |
  paused | in-review | approved | shipped | post-ship-pending`:
  - no delivery or no roadmap → `no-delivery`
  - `status: planned` → `planned`; `in-progress` → `building`; `paused` → `paused`
  - `in-review` → `approved` when `reviewVerdict === "approve"`, else `in-review`
  - `complete` → `post-ship-pending` when `postShipPending > 0`, else `shipped`
  - PR state refines only when present: `pr.state === "MERGED"` with a non-complete
    roadmap adds a `warnings[]` entry (`merged-but-not-complete`) but does not change
    `lifecycle`.
- `deriveAllowed({ role, lifecycle, delivery })` → `{ allowed: [...], elsewhere:
  [{ command, window, reason }] }` from a fixed table (one row per role × lifecycle),
  emitting concrete strings such as `/agento build-feature <slug>`,
  `/agento review-feature <slug>`, `/agento close-session feature/<slug>`,
  `/agento ship <slug>`, `/agento finish-freehand <slug>`,
  `/agento commit-current-changes`, `/agento start-session`, `/agento new-feature`,
  `/agento new-issue`, `/agento new-initiative`, `/agento delivery-status`. Windows
  are `primary` or `secondary`. The table encodes today's policy §8 (build/review in the
  secondary window, close/ship in the primary); it is data, so `ship-audit-first` can
  change one row later.

The CLI then emits:

```json
{ "status": "ok", "role": "build", "worktree": {…}, "delivery": {…}|null,
  "pr": {…}|null, "lifecycle": "building", "allowed": [...], "elsewhere": [...],
  "warnings": [], "root": "…", "configSource": … }
```

`--pr` (parsed in `parseArgs`) runs `gh pr view <branch> --json
number,state,isDraft,mergeStateStatus,url` only when `command -v gh` succeeds
(`execFileSync("gh", …)` inside try/catch); absent/unauthenticated/no-PR all yield
`pr: null` plus a `warnings[]` string. Without `--pr`, `pr` is `null` and no warning
is added. Exit code is always 0 for `session` (a role is always derivable); `status`
is always `"ok"`.

`cwd` for role detection is `options.root ?? process.cwd()` **before** the
`rev-parse --show-toplevel` normalisation (the hook passes the session cwd via
`--root`), so a subdirectory inside a worktree resolves to that worktree's entry.

### 2. SessionStart hook (`scripts/hooks/session-context.sh`) — approval-gated edit

After computing `agento_root` and before the `Delivery work:` loop, the Python block
runs `node <agento_root>/scripts/agento.mjs session --root <cwd>` via
`subprocess.run(..., timeout=5)` when `shutil.which("node")` succeeds and the CLI file
exists. On exit 0 and parseable JSON, append one line:

```
Session: role=<role> worktree=<worktree.path> branch=<branch|detached> delivery=<type>/<slug>|none lifecycle=<lifecycle> allowed=[<cmd>; <cmd>] elsewhere=[<cmd>@<window>; …]
```

Any failure (no `node`, nonzero exit, JSON error, timeout) is swallowed and the output
is today's exactly (Decision Q2). The Bash wrapper is unchanged; only the Python
heredoc grows. Per `docs/hooks.md`, this edit triggers the guard's `ask` — the Builder
requests approval once for the change.

### 3. `/agento delivery-status` (`commands/delivery-status.md` + `.github/prompts/delivery-status.prompt.md`)

Insert a new first step: run `node <agento-root>/scripts/agento.mjs session --pr` and
present a short **Session** section before the deliveries table: role, worktree path
and branch, active delivery, lifecycle, `allowed` commands (one per line), and
`elsewhere` commands with their window; echo `warnings[]` verbatim. Existing steps
renumber 2–6 and are otherwise untouched. Both files stay byte-identical.

### 4. Tests

- `scripts/session-state.test.mjs` (new): pure-function tests over the porcelain
  parser, every role rule (primary; managed `plan-` detached → `plan`; promoted
  `plan-` on `feature/x` → `build`; `feature-x` dir → `build`; `freehand-x` →
  `freehand`; sibling dir outside `worktreesDir` → `unmanaged`; cwd in a subdirectory),
  every lifecycle mapping, and the allowed/elsewhere table for each role × lifecycle.
- `scripts/agento.test.mjs`: integration tests using a clone + `git worktree add`
  under a temp `worktrees.dir` configured in `.github/agento.json`: `session` from the
  primary (role primary, lifecycle no-delivery), from a managed build worktree with a
  roadmap (delivery + lifecycle + allowed), from a promoted plan worktree, and `--pr`
  with `PATH` stripped of `gh` (→ `pr: null`, one warning); usage header lists
  `session`.
- `tests/session-context.test.mjs`: `Session:` line present with `role=primary` on a
  plain repo; `role=build` from a managed worktree; no `Session:` line and unchanged
  output when `PATH` excludes `node` (fallback); existing five tests still pass.
- `tests/customizations.test.mjs` needs no change (commands mirror test already covers
  the prompt edit; run it).

### 5. Docs

`docs/commands.md` subcommand list; `AGENTS.md` scripts bullet; `docs/hooks.md`
SessionStart paragraph (the `Session:` line and the Node fallback); `README.md`
"The delivery guard" SessionStart bullet; `CHANGELOG.md` new `## 0.4.0 (unreleased)`
entry. `plugin.json`/`package.json` versions are **not** bumped here (release stamping
belongs to `/agento ship` when the version changes; leaving them at `0.3.0` keeps the
customizations version-equality test green).

### Files touched

`scripts/agento.mjs`, `scripts/session-state.mjs` (new),
`scripts/session-state.test.mjs` (new), `scripts/agento.test.mjs`,
`scripts/hooks/session-context.sh` (gated), `tests/session-context.test.mjs`,
`commands/delivery-status.md`, `.github/prompts/delivery-status.prompt.md`,
`docs/commands.md`, `docs/hooks.md`, `README.md`, `AGENTS.md`, `CHANGELOG.md`.

## Risks

- **Hook edit is approval-gated and security-sensitive.** Mitigation: the Python
  block only adds a bounded (`timeout=5`) subprocess call to the plugin's own CLI and
  string formatting; every failure path degrades to today's output; shellcheck stays
  green; the Builder requests the guard approval once and records it in the step.
- **Hook latency.** Spawning Node on every session start adds ~100–300 ms.
  Mitigation: `--pr` is off in the hook (Decision Q1); 5 s timeout; measured in step
  2.3.
- **`gh` absent/unauthenticated in `--pr` mode.** Mitigation: `pr: null` +
  `warnings[]`; `lifecycle` never depends on `pr`; tested with a stripped `PATH`.
- **realpath/symlink mismatches between `git worktree list` paths and the hook `cwd`.**
  Mitigation: compare `fs.realpathSync` of both sides; test with a symlinked temp dir on
  Linux (`/tmp` is real on this host, so add an explicit symlink in the test).
- **Concurrent wave-1 members** (`command-receipts`, `canonical-commands`) edit
  `CHANGELOG.md`, `docs/commands.md`, `README.md`, and `tests/customizations.test.mjs`.
  No open PRs today. Mitigation: integrate `origin/main` by merge before every push
  (policy §7); keep the CHANGELOG entry as its own bullet block under the unreleased
  heading; do not touch `customizations.test.mjs`.
- **`closeBuildSessionDecision()` keeps its regex heuristic** this feature. Mitigation:
  documented as an explicit out-of-scope handoff to `window-aware-commands`, which
  the breakdown assigns that replacement.
- **Lifecycle table drift** when `ship-audit-first` inverts close/ship. Mitigation:
  `deriveAllowed` is a data table with a test per row, so one row change + one test
  change suffices later.

## Out of scope

- Consuming `session` from any prompt or agent other than `/agento delivery-status`
  (that is `window-aware-commands`), including replacing the regex in
  `closeBuildSessionDecision()`.
- `agento.mjs doctor` / capability checks (`capability-preflight`).
- `agento.mjs next` / transition selection (`continue-command`).
- Changing the close → ship order or policy §8 (`ship-audit-first`).
- Rewriting the Bash+Python hook in Node, or emitting the `Session:` line without Node.
- Persisting any state; `session` is derived purely from git, the filesystem, and
  (optionally) `gh`.
- Bumping `plugin.json`/`package.json` versions.

## Acceptance checklist

- [ ] `node scripts/agento.mjs session` from the primary worktree on `main` prints
  `role: "primary"`, `worktree.isPrimary: true`, `lifecycle: "no-delivery"`,
  `allowed` containing `/agento start-session`, and exits 0 — verify: run it in
  `/home/david/DP/agento` and in a subdirectory of it.
- [ ] From a managed worktree on `feature/<slug>` with a `status: in-progress` roadmap,
  `session` prints `role: "build"`, `delivery.slug`, `lifecycle: "building"`,
  `allowed` including `/agento build-feature <slug>`, and `elsewhere` naming
  `/agento ship <slug>` for the `primary` window — verify: `scripts/agento.test.mjs`
  integration test.
- [ ] A promoted `plan-<id>` worktree on `feature/<slug>` reports `role: "build"` and
  `worktree.dirPrefix: "plan"` — verify: unit + integration test.
- [ ] A `freehand-<slug>` worktree reports `role: "freehand"` with the fixed `allowed`
  list; a directory outside `worktrees.dir` that is not the primary reports
  `role: "unmanaged"`, `allowed: []`, and `elsewhere` pointing to `primary` — verify:
  unit tests.
- [ ] Every lifecycle value (`no-delivery`, `planned`, `building`, `paused`,
  `in-review`, `approved`, `shipped`, `post-ship-pending`) is produced by exactly the
  roadmap/review inputs listed in `## Approach` — verify: `scripts/session-state.test.mjs`
  table test.
- [ ] `session --pr` with `gh` missing from `PATH` yields `pr: null`, one `warnings[]`
  entry, unchanged `lifecycle`, exit 0; without `--pr` the CLI never invokes `gh` —
  verify: integration test with stripped `PATH`, plus `strace -f -e execve` or a stub
  `gh` on `PATH` that fails the test if invoked.
- [ ] `node scripts/agento.mjs` usage output lists `session [--pr]` — verify: usage test.
- [ ] The SessionStart hook emits exactly one `Session: role=… lifecycle=… allowed=[…]`
  line after `Agento CLI:` when `node` is available, and byte-identical
  pre-feature output when `node` is absent from `PATH` — verify:
  `tests/session-context.test.mjs`.
- [ ] `/agento delivery-status` prompt (both copies, byte-identical) opens with a
  `session --pr` step and a Session section; `tests/customizations.test.mjs` passes —
  verify: `node --test tests/customizations.test.mjs` and `diff` of the two files.
- [ ] Docs list the new subcommand and hook line: `docs/commands.md`, `AGENTS.md`,
  `docs/hooks.md`, `README.md` SessionStart bullet, `CHANGELOG.md` unreleased entry —
  verify: `grep -n "session" docs/commands.md AGENTS.md docs/hooks.md README.md CHANGELOG.md`.
- [ ] Full lint gate green and equal to baseline: `shellcheck scripts/hooks/*.sh
  scripts/wait-for-checks.sh` exit 0; `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` 0 failures with ≥ 70 + new tests; `./scripts/hooks/
  replay-guard.sh < tests/guard-fixtures.txt` exit 0 — verify: rerun all three and
  compare against the baseline table in `## Research`.
- [ ] No file outside the `## Approach` "Files touched" list changed; no prompt or
  agent other than `delivery-status` edited — verify: `git diff --stat origin/main`.
