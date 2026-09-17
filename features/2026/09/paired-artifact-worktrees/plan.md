# Paired artifact worktrees: every managed session owns a product + companion pair

## Problem

With `artifacts.repo` set, delivery artifacts live in a sibling companion checkout
(`../<repo>-docs`), but a managed session is still a **single** worktree of the
product repository opened as a **single-folder** VS Code window. Two consequences:

- The Planner, Builder, and Reviewer in that window cannot see or edit the companion
  at all — Copilot's edit tools and `applyTo` instructions only reach workspace
  folders (breakdown `## Research`, "Editor boundary").
- Two concurrent sessions would share the one companion clone and fight over its
  checked-out branch (breakdown `## Risks`, "Concurrent sessions sharing one
  companion clone").

This feature gives every managed session (`plan-<id>`, `feature-<slug>`,
`issue-<slug>`, `freehand-<slug>`) a **pair** of worktrees — the product half as
today and a companion half on the same branch name — and opens both as one
multi-root VS Code workspace. The CLI (`paths`, `session`, `next`, `close-decision`)
describes both halves; `/agento start-session`, `/agento start-freehand`,
`/agento close-session`, `/agento continue`, and `/agento ship`'s teardown create,
open, and remove them together; the delivery guard's occupant scan covers the
companion half.

This is member `paired-artifact-worktrees` of initiative `external-artifact-repo`
([breakdown.md](../../../../initiatives/2026/09/external-artifact-repo/breakdown.md),
block `### paired-artifact-worktrees`). It implements the session mechanics only —
which branch the artifacts are *committed* on, and the companion PR, belong to
`mirrored-artifact-branches`. With `artifacts.repo` unset, behaviour is byte-for-byte
today's (initiative Decision "Architect's reading").

## Decisions

- **Q1 — Where should each session's companion worktree live?** A: *Parallel
  directory: `<companion-dir>-worktrees/<kind>-<id>`* (e.g.
  `../agento-docs-worktrees/plan-20260916-232139`). Same `<kind>-<id>` name as the
  product half; the `MANAGED_DIR` regex and slugs ending in `-docs` stay unambiguous;
  `git worktree list` in the companion shows them naturally.
- **Q2 — Should the companion worktrees directory be configurable, or derived only?**
  A: *Derived only (`<artifacts.repo.dir>-worktrees`), no new config key.*
- **Q3 — Include the delivery-guard change (occupant scan covers the companion
  worktree path and a `Workspace (<name>)` VS Code window, as deferred by
  artifact-repo-hooks)? Hook edits are approval-gated.** A: *Yes, include it in this
  feature.*
- **Q4 — Should `/agento ship`'s teardown step learn to remove the companion worktree
  and the `.code-workspace` file now, or wait for ship-dual-merge?** A: *Yes —
  teardown removes both halves + workspace file now (close-decision refuses while
  either half is dirty/unpushed).*
- **Q5 — In build mode (`start-session feature/<slug>`), when the companion has no
  `origin/feature/<slug>` yet (deliveries planned before mirrored-artifact-branches),
  what should happen?** A: *Create `feature/<slug>` in the companion from its default
  branch and continue.* Plan mode always creates both halves detached at their
  origin default; the Planner leaves the companion untouched until
  mirrored-artifact-branches.

Planner's derived decisions (no user question needed):

- **Pair only in companion mode.** When `artifacts.external` is false the pair does
  not exist: `paths` reports `companion: null`, `session` reports `companion: null`
  and `worktrees[]` entries carry `repo: "product"`, no `.code-workspace` file is
  written, and `code --new-window <worktree-path>` is used exactly as today.
- **Workspace file** `<worktrees.dir>/<kind>-<id>.code-workspace` (product side, next
  to the product half) with `folders: [{ path: <product worktree> }, { path:
  <companion worktree> }]` as absolute paths and `settings: {}`. It is written by the
  prompt from the `workspace` field `paths` returns; the CLI never writes files.
- **Companion branch for plan sessions is detached** at the companion's
  `origin/<default>` (mirrors the product half). Promoting the companion half onto
  `feature/<slug>` is `mirrored-artifact-branches` work; until then a promoted
  planning pair has a product half on `feature/<slug>` and a companion half still
  detached — `session` reports that honestly (`companion.branch: null,
  detached: true`) and `role` still comes from the product half.
- **Role derivation from the companion half.** A cwd inside
  `<companion-dir>-worktrees/<kind>-<id>` resolves to the *product* half's record:
  same `role`, `worktree` (the product path), `delivery`, and `allowed[]`, plus
  `companion` describing the half the cwd is in. Hooks that run with the companion
  folder as cwd (multi-root windows report the first folder, but a terminal may sit
  in the second) therefore print the same `Session:` line.
- **Companion ownership check.** `findOwner()` keeps returning the product half;
  `close-decision` gains `companion: { path, branch, detached, dirty, ahead } |
  null` and a new error reason `companion-unpushed` (hard stop) so the close never
  orphans companion commits. `ship-preflight` gains the same `companion` block for
  the teardown; audit/merge of the companion PR stays in `ship-dual-merge`.
- **Guard occupant scan** treats `git worktree remove <product-half>` and `git -C
  <companion> worktree remove <companion-half>` alike: it scans processes under the
  target and, in addition to `Folder (<basename>)`, matches `Workspace
  (<kind>-<id>)` lines from `code --status` (the label VS Code prints for an open
  `.code-workspace`; the Builder confirms the exact label in step 4.1 before editing
  the regex).

## Research

Skills consulted: none — no matching domain (`.agents/skills/**/SKILL.md` returns
nothing; AGENTS.md has no `## Agento` skills table).

### Lint baseline (policy §5)

Run from the planning worktree at `origin/main` `a6d2903` (2026-09-16):

| Command | Exit | Findings |
|---|---|---|
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | `# tests 166`, `# pass 166`, `# fail 0` |
| `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` | 0 | none |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | all fixtures match |
| `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh < tests/guard-fixtures-companion.txt` | 0 | all fixtures match |

Green baseline → no overlap decision, no scoped gate: **full gate**. The Builder
reruns all four commands at the end of every phase that touches `scripts/` or
`tests/`; the Reviewer reruns them fresh and compares against 166/166/0, shellcheck
silent, both replays exit 0. Builder notes carried from `artifact-repo-hooks`: (1)
the guard denies any shell redirection that names `scripts/hooks/*` — run the replay
and shellcheck without `> file` / `>/dev/null` (the Planner hit this denial when
chaining the baseline); (2) every edit-tool change to `scripts/hooks/*.sh` is
approval-gated (`PROTECTED`, [delivery-guard.sh L109–L112](../../../../scripts/hooks/delivery-guard.sh#L109-L112))
— keep hook edits few and large; (3) `code --status` output in a session with only
folder windows shows `|    Folder (agento)` / `|    Folder (plan-20260916-232139)`
lines (verified 2026-09-16); the `Workspace (…)` label for `.code-workspace` windows
must be confirmed by opening one (step 4.1).

Step 4.1 probe (added 2026-09-16): `/tmp/agento-pair-probe.code-workspace` with
folders `/tmp` and `/home/david/DP/agento-worktrees/plan-20260916-232139`, opened
with `code --new-window`, then `code --status | grep -E 'Folder \(|Workspace \(|Window \('`
printed verbatim:

```
|  Window (Welcome - agento-pair-probe (Workspace) - Visual Studio Code)
|  Window (Welcome - plan-20260916-232139 - Visual Studio Code)
|  Window (Preview breakdown.md - agento - Visual Studio Code)
|    Folder (plan-20260916-232139): 166 files
|    Folder (plan-20260916-232139): 166 files
|    Folder (agento): 164 files
|    Folder (tmp): more than 20000 files
```

Findings: VS Code prints **no** `Workspace (<name>)` line. A `.code-workspace` window
is reported as a `Window (…)` title line containing `<workspace basename> (Workspace)`,
and each of its folders is listed as an ordinary `Folder (<basename>)` line — so the
existing `Folder (<basename of target>)` match already covers both halves of a pair
(both are named `<kind>-<id>`). Step 4.2 therefore matches three forms against
`os.path.basename(target)`: `Folder (<name>)` (existing), `Window (… <name> (Workspace) …)`
(observed), and `Workspace (<name>)` (the expected form, kept in case a VS Code
version prints it). The probe window cannot be closed from the CLI — the user closes
it by hand.

### Concurrent deliveries

`gh pr list --state open --json number,headRefName,title` → `[]` on 2026-09-16. Wave-2
siblings `artifact-repo-init` and `artifact-repo-hooks` are `complete`; the only
`ready` member is this one. Files most likely shared with a future concurrent slug:
`CHANGELOG.md`, `docs/commands.md`, `docs/concurrency.md`, `scripts/agento.mjs`,
`tests/customizations.test.mjs` (see Risks).

### Codebase facts (file:line as of `a6d2903`)

- **`paths` is the only path derivation** — [scripts/agento.mjs L688–L706](../../../../scripts/agento.mjs#L688-L706):
  validates `kind ∈ feature|issue|plan|freehand`, emits `{ worktreesDir, worktree:
  <worktreesDir>/<kind>-<id>, branch, artifactsRoot, artifactRoot, defaultBranch,
  postShipBranch }`. `worktreesDir = path.resolve(root, config.worktrees.dir)`
  (L73) — computed from *this* root, while `session` uses `primaryWorktreesDir()`
  (L231–L235) to resolve against the primary checkout. The companion side must
  resolve against `artifacts.dir` (absolute, already primary-relative via
  `resolveArtifacts()` L84–L92).
- **Companion resolution exists** — `resolveArtifacts()` returns `{ external, name,
  dir, root }` ([agento.mjs L84–L96](../../../../scripts/agento.mjs#L84-L96),
  [agento-config.mjs `resolveArtifactsRoot`](../../../../scripts/agento-config.mjs)).
  `artifacts.dir` is the sibling clone; nothing yet derives `<dir>-worktrees`.
- **Role derivation is product-only** — [session-state.mjs](../../../../scripts/session-state.mjs):
  `MANAGED_DIR = /^(plan|feature|issue|freehand)-(.+)$/` (L8); `classifyByPath()`
  (L48–L88) takes `{ cwd, worktrees, worktreesDir, config }`, finds the deepest
  containing worktree entry, then tests `isWithin(worktreesDir, cwd)` and the
  `MANAGED_DIR` match on the top directory; `deriveRole()` (L92–L104) adds the hosted
  override; `classifyWorktrees()` (L108–L122) maps every entry with keys `path,
  branch, detached, role, dirPrefix, id, isPrimary, isManaged` — the test
  "classifyWorktrees: one record per registered entry…" asserts this exact key set
  ([session-state.test.mjs L203–L206](../../../../scripts/session-state.test.mjs#L203-L206));
  `findOwner()` (L126–L134) picks the managed entry on the branch.
- **`session` / `next` bootstrap** — [agento.mjs L741–L777](../../../../scripts/agento.mjs#L741-L777)
  and L780–L800: `parseWorktreeList(git(root, "worktree", "list", "--porcelain"))`
  from the product repo only; `deriveRole({ cwd: startDir, … })`. A cwd inside the
  companion half is not inside any product worktree entry, so today it classifies
  `unmanaged` (its `root` would even be the companion repo, whose config has no
  `artifacts.repo` → `artifacts.external` false). The CLI must detect "cwd is inside
  a companion half or the companion clone" **before** trusting `root`, and re-anchor
  on the product primary. **Decision — anchoring rule:** when the cwd's toplevel has
  no `artifacts.repo` of its own, take its primary checkout (first entry of its own
  `git worktree list --porcelain`; for a companion half that is the companion clone
  `../<name>`), list that clone's parent directory once, and pick the sibling git
  checkout whose `.github/agento.json` resolves `artifacts.dir` to exactly that
  clone. Zero matches → today's behaviour (`unmanaged`, plus a `warnings[]` entry
  naming the attempt); two or more → `unmanaged` with a warning listing them. The
  hook already passes `--root <cwd>`, so no hook change is needed for anchoring.
  Documented in `docs/architecture.md`.
- **`deriveAllowed` / `deriveNext`** — [session-state.mjs L220+](../../../../scripts/session-state.mjs#L220):
  `secondary` window is located by `/agento continue` step 4 as "the managed entry
  in `worktrees[]` whose `branch` equals `delivery.branch`" and opened with `code
  <path>` ([continue.prompt.md L66–L73](../../../../.github/prompts/continue.prompt.md#L66-L73));
  with a pair, the thing to open is the `.code-workspace` file.
- **Prompts that create/remove/open worktrees** —
  [start-session.prompt.md](../../../../.github/prompts/start-session.prompt.md)
  (shared precondition 3–4, plan mode 2–3, build mode 2–3),
  [start-freehand.prompt.md](../../../../.github/prompts/start-freehand.prompt.md)
  (session 2–4), [close-session.prompt.md](../../../../.github/prompts/close-session.prompt.md)
  (shared rules 2–6, plan/build/freehand close), [ship.prompt.md](../../../../.github/prompts/ship.prompt.md)
  (Ownership block; step 3 **Teardown**), [continue.prompt.md](../../../../.github/prompts/continue.prompt.md)
  (step 4 `primary`/`secondary`). `commands/*.md` must stay byte-identical to
  `.github/prompts/*.prompt.md` (`tests/customizations.test.mjs` "plugin commands
  must mirror workspace prompts"); the allowlist for `worktree list --porcelain` is
  `start-session, start-freehand, close-session, ship`
  ([customizations.test.mjs L182–L193](../../../../tests/customizations.test.mjs#L182-L193)).
- **Guard occupant scan** — [delivery-guard.sh L55–L106](../../../../scripts/hooks/delivery-guard.sh#L55-L106):
  `worktree_remove_target()` matches `git [-C dir] worktree remove <path>` and
  resolves against `hook_cwd`; scans `/proc/*/cwd`; `code --status` folder match is
  `^\|\s+Folder \(([^)]+)\):` compared with `os.path.basename(target)`. A `-C
  <companion>` removal already resolves the target, so the process scan works for
  the companion half; only the window label needs `Workspace (<name>)`.
  Follow-up recorded in [artifact-repo-hooks roadmap.md L35](../../../../features/2026/09/artifact-repo-hooks/roadmap.md#L35).
- **SessionStart hook** — [session-context.sh](../../../../scripts/hooks/session-context.sh)
  prints `Artifacts: <companion clone path> (branch <b>)` (L131–L133); with a pair
  the meaningful path is the session's companion *half*. The line is produced in
  Python without node; the Python `resolve_artifacts()` is duplicated in both hooks
  ("keep both copies identical").
- **Tests and fixtures** — [scripts/agento.test.mjs](../../../../scripts/agento.test.mjs):
  `makeRepo({ config, companion: true })` (L19) builds `<base>/project` +
  `<base>/project-docs` each with a bare origin; `run(cwd, ...args)` (L67) returns
  `{ json, status }`. [tests/session-context.test.mjs](../../../../tests/session-context.test.mjs):
  `makeRepo({ branch, config, companion })`, `run(cwd, env)`, `pathWithoutNode()`.
  [tests/guard.test.mjs](../../../../tests/guard.test.mjs) drives the guard with
  JSON payloads. [tests/guard-fixtures-companion.txt](../../../../tests/guard-fixtures-companion.txt)
  substitutes `{companion}`.
- **Docs** — [docs/commands.md L27–L64](../../../../docs/commands.md#L27-L64)
  enumerates every subcommand's output; [docs/concurrency.md `## Worktrees`](../../../../docs/concurrency.md);
  [docs/architecture.md `## Configuration boundary`](../../../../docs/architecture.md);
  [docs/project-profile.md](../../../../docs/project-profile.md) table rows for
  `artifacts.repo.*` and the "Add Folder to Workspace" note; [docs/hooks.md](../../../../docs/hooks.md)
  `Artifacts:` and occupant rows; policy §8/§11 in
  [delivery-policy.instructions.md](../../../../.github/instructions/delivery-policy.instructions.md)
  say "secondary (worktree) window" and list worktree-mutating commands.
  `CHANGELOG.md` has an open `## Unreleased` heading (version `0.4.1` unchanged).

## Approach

Companion mode only (`artifacts.external`); every change below is a no-op when
`artifacts.repo` is unset.

1. **`scripts/agento-config.mjs`** — `resolveArtifactsRoot()` additionally returns
   `worktreesDir: <dir>-worktrees` (absolute, `null` when not external). Tests for
   name-only, dir-only, both, and unset.
2. **`scripts/session-state.mjs`**
   - `classifyByPath()` takes an optional `companionWorktreesDir`; when the cwd is
     inside `<companionWorktreesDir>/<kind>-<id>`, the record is the one the product
     half `<worktreesDir>/<kind>-<id>` would produce (branch/detached from the
     product `worktrees` entry when registered, else `null`/`true`), and the result
     gains `half: "companion"` (else `"product"`).
   - New `pairFor({ worktree, companionWorktreesDir, companionWorktrees })` returns
     `{ path, branch, detached, registered }` for the managed product half's
     companion, `null` for the primary/unmanaged/in-repo cases; `dirty` and `ahead`
     are filled by the CLI (they need git).
   - `classifyWorktrees()` gains an optional `repo` tag (`"product" | "companion"`)
     without changing the existing eight keys' order; the existing key-set test is
     extended, not weakened.
   - `deriveNext()` unchanged; `/agento continue` opens the pair through the
     workspace file the CLI now reports (see 3).
3. **`scripts/agento.mjs`**
   - Bootstrap: if the cwd's toplevel is inside `artifacts.worktreesDir` of some
     product, or *is* the companion clone, re-anchor `root` on the product primary
     (derived per the Research decision) before `loadAgentoConfig`; record
     `anchoredFrom: "companion"` in `session`/`next` `warnings[]` so the hook's
     `Session:` line stays informative.
   - Also parse the companion's worktree list once (`git -C <companion clone>
     worktree list --porcelain`) when external.
   - `paths <kind> <id>` → adds `companion: { worktreesDir, worktree, branch } | null`
     (branch identical to the product branch; `null` for `plan`) and `workspace:
     <worktreesDir>/<kind>-<id>.code-workspace | null`.
   - `session` → adds `companion: { path, branch, detached, dirty, ahead,
     registered } | null` for the current managed session and `workspace` (path,
     `exists`); `worktrees[]` entries gain `repo`; companion-half entries are
     appended after the product entries (so `worktrees[0]` stays the product
     primary — every prompt relies on that).
   - `close-decision` → adds `companion` (as above) and returns `status: "error",
     reason: "companion-unpushed"` when the companion half has `ahead > 0` or is
     dirty; `ship-preflight` → adds `companion` and reports `companionGaps[]`
     (`dirty`, `unpushed`) — the prompt treats them as hard-reject gaps.
   - `doctor` `artifact-repo` check: `warn` when `<companion>-worktrees` exists but
     is not writable, with the fallback naming the directory (mirrors
     `worktrees-dir`). `worktrees-dir` unchanged.
   - Usage header updated for `paths` and `session`.
4. **Prompts** (`.github/prompts/*.prompt.md` mirrored to `commands/*.md`):
   - `start-session`: precondition 3 reads `companion`/`workspace` from `paths`;
     plan mode 3 adds `git -C <companion clone> worktree add --detach
     <companion.worktree> origin/<default>`; build mode 3 adds the companion half
     on the same branch (`origin/<branch>` when it exists in the companion, else
     `-b <branch> origin/<default>` per Q5; on resume an already-registered companion
     half is reused untouched); after both halves exist, write the workspace file
     (JSON, two absolute `folders`) and, unless `--no-open`, run `code --new-window
     <workspace>`; §10 `code` fallback prints that command. Refuse a companion path
     that exists but is not the registered companion worktree. Product-only
     behaviour when `companion` is `null`.
   - `start-freehand`: same additions for `freehand-<slug>` on `changes/<slug>`.
   - `close-session`: shared rule 2 resolves both halves and the workspace file;
     rule 3 inspects both `status --short`; rule 4 removes the companion half with
     `git -C <companion clone> worktree remove <path>` then `prune`, removes the
     product half, deletes the workspace file, and deletes the companion's merged
     local branch under the same conditions as the product's; rule 6 (already
     removed) covers each half independently; build close stops on
     `reason: companion-unpushed`.
   - `ship`: Ownership reads `companion` from `ship-preflight`; audit adds
     `companionGaps[]` to the hard-reject list; Teardown removes the companion half
     (`git -C <companion clone> worktree remove`), the product half, and the
     workspace file, in that order, each with the literal resolved path; the
     `paused at teardown` state names whichever path the guard flagged.
   - `continue`: step 4 `secondary` opens `code <workspace>` when the record's
     `workspace.exists` is true, else the worktree path as today.
   - `agento-init`: report line reminds that sessions now open as two-folder
     workspaces (one sentence; no procedure change).
5. **Hooks** (approval-gated)
   - `delivery-guard.sh`: occupant scan also matches `^\|\s+Workspace \(([^)]+)\):`
     against `os.path.basename(target)`; the `-C <companion>` form already resolves
     the path. Add fixtures to `tests/guard-fixtures-companion.txt` for `allow git -C
     {companion} worktree list --porcelain` and a `tests/guard.test.mjs` case that
     stubs `code --status` output containing a `Workspace (feature-x)` line and
     asserts `ask`.
   - `session-context.sh`: when the cwd is a managed product half whose companion
     half exists, `Artifacts:` names the *half* (`<companion-worktrees>/<kind>-<id>`
     and its branch) instead of the clone; otherwise unchanged. Mirror the derived
     `<dir>-worktrees` rule in the shared Python helper of **both** hooks.
6. **Docs and policy** — `docs/commands.md` (`paths`, `session`, `close-decision`,
   `ship-preflight` fields), `docs/concurrency.md` (`## Worktrees` describes the
   pair, the parallel directory, and the workspace file), `docs/architecture.md`
   (companion cwd anchoring), `docs/project-profile.md` (derived
   `<dir>-worktrees`, no key), `docs/hooks.md` (occupant `Workspace` row,
   `Artifacts:` half), policy §8 ("secondary (worktree) window" → the pair's
   workspace window) and §11 step 2 (ownership/teardown may read the companion's
   worktree list too), `CHANGELOG.md` `## Unreleased` entry. `tests/customizations.test.mjs`
   keeps `§N` links valid and the `worktree list --porcelain` allowlist unchanged
   (the same four commands).

## Risks

- **Anchoring a companion cwd on the product primary** is the one genuinely new
  inference (Research, "`session` / `next` bootstrap"). Mitigation: bounded to one
  sibling-directory scan, only attempted when the cwd's toplevel is not itself a
  product with `artifacts.repo` set; falls back to today's `unmanaged` with a
  `warnings[]` entry naming what was tried; unit-tested with `makeRepo({ companion:
  true })` layouts including a `plan-*` pair.
- **`code --status` label for workspace windows** is unverified (`Workspace (<name>)`
  is the expected form). Mitigation: step 4.1 opens a throwaway `.code-workspace`
  and records the observed label before the guard edit; the test stubs the label
  that was observed.
- **Guard edits are approval-gated and Python is duplicated across both hooks.**
  Mitigation: one edit per hook, both in the same phase; the replay fixtures and
  `tests/guard.test.mjs` guard regressions; keep `resolve_artifacts()` identical.
- **Promoted planning pair is half-promoted** until `mirrored-artifact-branches`:
  product on `feature/<slug>`, companion detached. Mitigation: `session.companion`
  reports it truthfully; `close-decision` treats a detached companion half with no
  commits as clean; nothing in this feature writes to the companion.
- **In-repo mode must remain byte-for-byte**, except the additive fields `paths.
  companion`, `paths.workspace`, `session.companion`, `session.workspace`,
  `worktrees[].repo`, `close-decision.companion`, `ship-preflight.companion`.
  Mitigation: acceptance item 9 diffs origin/main's CLI against this branch's on
  this in-repo checkout.
- **Concurrent delivery overlap** on `CHANGELOG.md`, `docs/commands.md`,
  `scripts/agento.mjs`, `tests/customizations.test.mjs` if another slug starts.
  Mitigation: integrate `origin/main` before every push (policy §7); none open today.
- **`worktrees[0]` invariant.** Prompts read the primary as `worktrees[0]`.
  Mitigation: companion entries are appended after all product entries; a test
  asserts `worktrees[0].repo === "product"` and `isPrimary`.
- **Verification on this repository** cannot exercise companion mode end to end
  (this repo is in-repo until `artifact-history-migration`). Mitigation: unit tests
  build throwaway product + companion pairs; step 6.1 additionally drives the real
  prompts against a `/tmp` product/companion pair created with `agento-init`-style
  scaffolding (config with `artifacts.repo.name`), recording the `paths`/`session`
  output and the created directories under `evidence/`.

## Out of scope

- Committing artifacts on the companion branch, the companion draft PR, `artifact-pr:`
  header, `session --pr` returning both PRs — `mirrored-artifact-branches`.
- Auditing or merging the companion PR, `ship-preflight` `{ product, companion }`
  PR blocks, post-ship on the companion — `ship-dual-merge`.
- A `.code-workspace` for the **primary** window (documented as "Add Folder to
  Workspace" by `artifact-repo-init`); `doctor` detecting workspace folders.
- A configurable companion worktrees directory (Q2) and non-sibling companion
  layouts (initiative Decision 5).
- Hosted environments (Codespaces/Actions): no pair; `hosted` records derive role
  from the branch as today.
- Migrating this repository to companion mode — `artifact-history-migration`.

## Acceptance checklist

- [ ] `resolveArtifactsRoot()` returns `worktreesDir: <dir>-worktrees` (absolute)
  when external and `null` when not — verify: `node --test
  scripts/agento-config.test.mjs` passes the new cases.
- [ ] `node scripts/agento.mjs paths <kind> <id>` in a companion-mode repo emits
  `companion: { worktreesDir, worktree: <companion-dir>-worktrees/<kind>-<id>,
  branch }` and `workspace: <worktrees.dir>/<kind>-<id>.code-workspace`; in-repo
  mode emits `companion: null`, `workspace: null` — verify: `scripts/agento.test.mjs`
  cases for `plan`, `feature`, `freehand` in both modes.
- [ ] `agento.mjs session` run from **either** half of a paired managed worktree
  returns the same `role`, `worktree.path` (product half), `delivery`, and
  `allowed[]`, plus `companion: { path, branch, detached, dirty, ahead, registered
  }` and `workspace: { path, exists }`; `worktrees[]` entries carry `repo` with
  `worktrees[0].repo === "product"` and `isPrimary: true` — verify:
  `scripts/agento.test.mjs` tests with a `plan-*` pair (detached both), a
  `feature-*` pair (same branch), and a half-promoted `plan-*` pair.
- [ ] `agento.mjs close-decision` returns `status: error, reason:
  companion-unpushed` when the companion half is dirty or ahead of its upstream, and
  includes `companion` on success; `ship-preflight` includes `companion` and
  `companionGaps[]` — verify: resolver/CLI tests.
- [ ] `/agento start-session` (plan and build modes) and `/agento start-freehand`
  create both halves, write the workspace file, and open it; `/agento close-session`
  and `/agento ship` teardown remove both halves and the file; `/agento continue`
  opens the workspace for `secondary` — verify: prompt text per `## Approach` 4;
  `diff .github/prompts/<p>.prompt.md commands/<p>.md` empty for the five prompts
  plus `agento-init`; `node --test tests/customizations.test.mjs` passes (the
  `worktree list --porcelain` allowlist is unchanged).
- [ ] End-to-end on a throwaway `/tmp` product + companion pair (config
  `artifacts.repo.name`): following `start-session` plan mode creates
  `<wt>/plan-<id>`, `<companion>-worktrees/plan-<id>`, and
  `<wt>/plan-<id>.code-workspace`; `session` from both halves agrees;
  `close-session <id>` removes all three — verify: the command transcript and
  `git worktree list` before/after captured under `evidence/step-6-1-pair-e2e.txt`.
- [ ] Guard: `git worktree remove <path>` asks when `code --status` lists
  `Workspace (<basename>)` for the target; `git -C {companion} worktree remove
  <path>` runs the same scan; other verdicts unchanged — verify:
  `tests/guard.test.mjs` new case; both replays exit 0.
- [ ] SessionStart: from a paired product half the `Artifacts:` line names the
  companion **half** and its branch; from the primary it still names the clone;
  no-node fallback stays equal to with-node minus `Session:` — verify:
  `tests/session-context.test.mjs`.
- [ ] In-repo mode is byte-for-byte except the additive fields listed in `## Risks`
  — verify: run `origin/main`'s `scripts/agento.mjs` and this branch's against this
  checkout for `paths plan x`, `paths feature x`, `session`, `close-decision`,
  `ship-preflight`, `config`, `doctor --for close-session` and diff.
- [ ] Docs, policy, and CHANGELOG updated per `## Approach` 6 — verify: `grep -c
  'code-workspace' docs/concurrency.md docs/commands.md` ≥ 1 each; `grep -c
  'Workspace (' docs/hooks.md` ≥ 1; `grep -c 'companion' CHANGELOG.md` increases;
  `node --test tests/customizations.test.mjs` passes.
- [ ] Full lint gate green and equal to baseline — verify: `node --test
  'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` exit 0 with `# fail 0` and
  `# pass` ≥ 166; `shellcheck …` exit 0 silent; both replays exit 0.
- [ ] Roadmap header carries `initiative: "external-artifact-repo"` and
  `node scripts/agento.mjs initiative external-artifact-repo` reports this member
  with `errors: []` — verify: the CLI output.
