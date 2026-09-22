# Changelog

## Unreleased

- **Fixed.** The Reviewer's auto-sent handoff now targets the Autopilot ("Continue
  unattended") instead of the Builder. In VS Code Autopilot mode the old Reviewer →
  Builder → Reviewer chain looped forever on an approve (`send: true` handoffs are
  unconditional); the Autopilot declares no handoffs, reads the verdict, and either
  drives the fix loop through subagents or stops. `tests/customizations.test.mjs`
  now rejects any cycle among `send: true` handoffs.
- **Fixed.** The companion-mode roadmap nudge on a product-half commit now accepts an
  edited-but-uncommitted `roadmap.md` in the companion working tree (untracked or
  unstaged, not only staged). The two-commit rule commits the product before the
  companion tick is staged, so the Builder's ordinary step commit no longer asks
  and stalls unattended `/agento ap` runs.
- **Fixed.** The delivery guard now recognises every worktree of the companion clone
  (the companion halves of managed sessions) as the companion, so the Planner's
  chained `git -C <companion half> merge && add && commit && push` no longer trips
  the product-commit roadmap nudge and stalls unattended `/agento ap` runs; the
  nudge on a product-half commit inspects the paired companion half rather than the
  companion primary.
- **Fixed.** Managed companion-mode session windows now get their `.code-workspace`
  file from `agento.mjs workspace <kind> <id> [--write]`, including the session
  auto-approve settings block by default, a `session-workspace` `doctor` check, and
  the `worktrees.autoApprove` config switch to keep VS Code's stock prompts when a
  project wants them. The docs and init scaffold now describe the one-time
  acceptance/trust flow for those workspace settings. (#58)

## 0.6.0 (2026-09-20)

- **Extension acceptance.** The release gate now exercises deterministic in-repo
  and companion repositories through every contributed view, the status bar, and
  registered command dispatch. Packaging also installs the VSIX into an isolated
  profile, proves activation and command/view contributions, and removes all test
  state. The new [extension guide](docs/extension.md) documents installation,
  operation, companion workspaces, recovery, and public API limitations.
- **Command dispatch.** Delivery context menus and the Session & Doctor view now
  present actions directly from the CLI's ordered `allowed[]` and `elsewhere[]`
  records. Current-window actions submit the exact canonical command to Copilot Chat
  in agent mode; cross-window actions revalidate with `next`, persist a target-keyed
  `/agento continue <slug>` for up to five minutes, and open or focus the CLI-selected
  primary folder or companion workspace. Pending commands are deleted before
  submission, and stale, malformed, mismatched, or failed handoffs are surfaced
  without executing lifecycle work inside the extension.
- **Initiatives tree.** The extension now renders CLI-derived initiative progress,
  Ready, In flight, Blocked, and Complete member groups, and per-initiative errors
  and anomalies without re-deriving dependency state. Initiative and member rows
  open the CLI-supplied breakdown beside the active editor in both in-repo and
  companion layouts, and existing watcher events refresh the view without polling.
- **Session & Doctor panel.** The extension now presents read-only `session --pr`,
  `doctor`, and `status --pr` output for the current window, including session,
  workspace, companion, warning, check detail, and fallback state. Visibility and
  manual refreshes update the panel without polling, failures remain inline with a
  retry action, and the status bar summarizes the current role and active delivery
  count while providing a shortcut back to the view.
- **Deliveries tree.** The extension now renders the CLI's `status --pr` lifecycle
  groups as compact delivery rows with complete PR, ownership, workspace, companion,
  and initiative tooltips. Selecting a row opens its roadmap beside the active
  editor; watcher and command refreshes update the tree, while empty results,
  warnings, and errors remain explicit. Electron coverage exercises both in-repo and
  companion layouts.
- **Added.** A VS Code extension scaffold under `extension/` with an Agento activity
  bar container, refresh and output commands, bundled CLI client, debounced delivery
  watchers, activation coverage, and VSIX packaging.
- **Added.** Additive CLI JSON for dashboards: `agento.mjs status [--pr]` reads
  roadmaps from managed companion halves (or managed build worktrees in the in-repo
  layout) before the artifact checkout, adds per-item `lifecycle`, `owner`,
  `workspace`, `companion`, `pr`, and `companionPr` (the last two filled only with
  `--pr` and only for non-complete items) plus top-level `lifecycles[]` and
  `warnings[]`; `agento.mjs next` adds `next.target` (`{ path, workspace } | null`)
  naming the checkout the transition's `window` refers to. No existing field, order,
  or exit code changes.

## 0.5.2 (2026-09-18)

- **Fixed.** The delivery guard no longer denies `git push --delete <branch>` /
  `git push :<branch>` of a non-default branch while the checkout is on the default
  branch, so `/agento ship`'s post-merge teardown runs from the primary; deleting the
  default branch itself and content pushes from it stay denied. `/agento ship` now
  names the delete command (`git push origin --delete <branch>` from the primary,
  `git -C <artifactsRoot> push origin --delete <branch>` for the companion) and
  notes that `gh pr merge --delete-branch` is not an alternative. (#47)

## 0.5.1 (2026-09-18)

- **Copyable command blocks.** New delivery-policy §12 (command presentation):
  every `/agento …` command a response asks the user to run — the §9 result's
  `next:` (repeated directly above the result line), §8 cross-window handoff items,
  pause resume commands, `rejected` receipt alternatives, `/agento next-feature`'s
  sequence, `/agento continue`'s named command, `/agento ship`'s reject-back and
  teardown-pause commands, and the Build-in-this-worktree alternative — is emitted
  as its own fenced block with no language tag holding exactly that one command, so
  VS Code chat offers a one-click copy button. Descriptive mentions stay inline.
  Every build or review command block is followed by an `/agento ap <slug>` block
  as the unattended alternative.
  Every agent and prompt cites §12; `tests/customizations.test.mjs` enforces the
  citation, that `next-feature` prints one command per block, and that the
  build/review handoffs offer the ap alternative.

## 0.5.0 (2026-09-18)

- **Artifact history migration.** New `agento.mjs migrate <companion-checkout>
  [--apply]` subcommand moves an in-repo `features/`, `issues/`, `initiatives/`
  tree into the companion checkout (dry run with `roots[]`, `records`, and
  `conflicts[]`; `--apply` copies byte-identically, removes the source roots,
  writes `artifacts.repo.name` into `.github/agento.json`, appends a `## Migrated
  history` note to the companion README, and reports `records.identical`;
  re-runs report `nothing-to-migrate`). `/agento agento-init --migrate` drives it:
  in-flight delivery PRs are refused unless accepted, the import lands as one
  commit on the companion's `changes/agento-init` with a draft PR, and the product
  PR removes the roots and says to merge the companion PR first. Layout rule —
  "the checkout decides, the primary anchors": a checkout whose own config sets
  `artifacts.repo` is in companion mode even while the primary's default branch is
  not, in the CLI (`resolveArtifacts()`) and in both hooks' `resolve_artifacts()`.
  Branch-aware resolution: `resolve`, `find`, `close-decision`, `ship-preflight`,
  `next <slug>`, and `paths` fall back to the delivery branch's own
  `.github/agento.json` when an in-repo checkout finds no roadmap and report
  `layout: "branch"` with `artifactsRoot`; `/agento ship` reads both from the
  preflight. This repository's own artifacts moved to
  `david-perry-software/agento-docs`. Minor version bump for the layout change.

- **Ship dual merge.** In companion mode `/agento ship` merges both PRs: it audits
  with the new `agento.mjs ship-preflight <type> <slug> --pr` (adds `pr`,
  `companionPr`, `warnings[]`, and the companion PR gaps `missing-pr`,
  `pr-not-open`, `conflicting-pr` to `companionGaps[]`; a `MERGED` companion PR is
  not a gap), reads roadmap, review, and plan from the companion's `origin/<branch>`,
  integrates a `BEHIND` companion PR with `git -C <companion.path> merge
  origin/<default>`, commits `status: complete` in the companion half, marks both
  PRs ready, merges the code PR first and then the companion PR from inside the
  companion clone, syncs both default branches, deletes the merged companion local
  branch at teardown, and runs the post-ship epilogue (`post-ship/<slug>`, evidence
  + roadmap tick, PR, merge) in the companion repository. A companion merge that
  fails after the code merge is a resumable stop — the re-send sees `pr: MERGED`
  and `companionPr: OPEN` and resumes at the companion merge (policy §9 row). CLI:
  `describeCompanion` gains `behind` (upstream commits not in the half's HEAD) and
  `companionGaps[]`/`close-decision` flag it as `behind`; `deriveLifecycle` warns
  `companion-pr-open` when the code PR is merged but the companion PR is still
  open. In-repo layout unchanged.
- **Mirrored artifact branches.** In companion mode a delivery's artifacts follow the
  code branch: the Planner creates the companion branch of the same name right after
  the product branch (`git -C <companion.path> switch -c <branch>` from the plan
  half's detached `origin/<default>`; `/agento start-session` build mode adds
  `--no-track`), writes `plan.md`/`roadmap.md`/`evidence/` there, pushes it, publishes
  the product branch with one empty Conventional Commit, and opens two cross-linked
  draft PRs — the code PR and a companion PR titled `docs(<type>): <slug>` — recording
  the latter in the new optional roadmap header `artifact-pr: "#<n>"`. Builder steps
  become two commits (code in the product half, roadmap tick + evidence in the
  companion half, pushed product first — policy §7 two-commit rule); the Reviewer
  writes `review.md` in the companion half and posts one verdict comment on the code
  PR (`gh pr comment --edit-last` on re-review); the Architect and `/agento
  triage-followups` branch and merge in the companion; both halves integrate their
  own origin default before every push. CLI: every describe record (`status`,
  `resolve`, `find`, `session.delivery`, `initiative` members, `next` and its
  `candidates[]`) carries `artifactPr`; `session --pr` adds `companionPr` (the branch
  looked up in the companion clone, `null` with no extra `gh` call in the in-repo
  layout); `session`/`next` read the delivery roadmap from the registered companion
  half, so a roadmap living only on the mirrored branch still yields `delivery`,
  `lifecycle`, and the build/review commands. In-repo layout unchanged.
- **Paired companion worktrees.** In companion mode every managed session is a pair:
  `/agento start-session` and `/agento start-freehand` create the product half in
  `worktrees.dir` and a companion half of the same `<kind>-<id>` name under the
  derived `<artifacts.repo.dir>-worktrees/` (plan sessions detached at the companion's
  origin default, build and freehand sessions on the same branch name), write
  `<worktrees.dir>/<kind>-<id>.code-workspace` with both folders, and open that
  workspace; `/agento continue` reopens it. `agento.mjs paths` gains `companion` and
  `workspace`; `session`/`next` gain `companion { path, branch, detached, dirty,
  ahead, registered }`, `workspace { path, exists }`, and tag every `worktrees[]`
  entry `repo: "product" | "companion"`; a cwd inside the companion clone or one of
  its halves is anchored on its product checkout (`anchored-from-companion` warning)
  and yields the same record. `close-decision` stops with `companion-unpushed` and
  `ship-preflight` lists `companionGaps[]` while the companion half is dirty or
  ahead; `/agento close-session` and `/agento ship`'s teardown remove companion half,
  product half, and workspace file together. `doctor` `artifact-repo` warns when
  `<dir>-worktrees` exists but is not writable. The delivery guard also asks before
  `git [-C <companion>] worktree remove` while the pair's workspace window is open,
  and the SessionStart `Artifacts:` line names the companion half from a paired
  product worktree. Policy §8 names the pair's workspace window as the secondary
  window; §11 lets the four worktree-mutating commands read the companion clone's
  worktree list. In-repo layout: all new fields are `null`/`[]`, output otherwise
  unchanged.
- **Both hooks read `artifacts.repo`.** With a companion configured, the SessionStart
  hook (`scripts/hooks/session-context.sh`) walks the companion checkout for
  resumable roadmaps (product `features/`/`issues/` ignored, resolved against the
  primary checkout like the CLI) and prints one `Artifacts: <path> (branch <b>)` line
  after `Session:` — with or without `node`. The delivery guard
  (`scripts/hooks/delivery-guard.sh`) applies the product config's `branches.*` to
  commands targeting the companion (its default branch is denied commits, pushes, and
  merges) and re-targets the roadmap nudge: a product delivery-branch commit asks
  unless the companion's index stages a `roadmap.md` or its `HEAD` commit touched
  one; the reason names the companion path and branch. `replay-guard.sh` gains
  `REPLAY_COMPANION=1` (sibling companion repo, `{companion}` substitution) with
  `tests/guard-fixtures-companion.txt`. Unset `artifacts.repo` → both hooks emit
  today's output verbatim.
- **New `artifacts.repo` config: delivery artifacts in a sibling companion
  repository.** `.github/agento.json` gains `artifacts.repo: { name, dir }` (template
  ships nulls = today's in-repo layout). Setting `name` (or `dir`) makes every artifact
  reader in `scripts/agento.mjs` — `status`, `initiative`, `session`, `next`, `find`,
  `resolve`, `close-decision`, `ship-preflight`, `paths` — and the shared resolver walk
  `<primary-checkout>/../<name>` (resolved against the primary checkout and its config,
  like `worktrees.dir`, so managed worktrees agree) and read artifact git refs from
  that checkout; in-repo `features/`, `issues/`, `initiatives/` are ignored while the
  key is set. `config` and `paths` report `artifactsRoot` (and `paths.artifactRoot` is
  now absolute). `doctor` gains a seventh check, `artifact-repo`, under `terminal`:
  `ok` when unset, `fail` with a fallback naming `/agento agento-init` when the
  companion is absent, not a checkout toplevel, has no `origin`, or lacks the default
  branch, and `warn` naming stale non-empty in-repo roots. Companion creation, hooks,
  paired worktrees, and mirrored branches follow in the `external-artifact-repo`
  initiative's later members.
- **`/agento agento-init` creates and clones the companion repository.** Init asks
  for the companion name (default `<repo>-docs`), creates it on GitHub with the
  product's owner and visibility (`gh repo create`), clones it to `../<name>`,
  scaffolds `README.md` (from the new `templates/companion-README.md`, whose first
  line is the `<!-- agento-companion: <owner>/<repo> -->` marker), `.gitkeep` in each
  artifact root, and `.github/instructions/agento.instructions.md` (the
  `templates/project.instructions.md` frontmatter plus the verbatim artifact
  contract), writes those bootstrap files to the companion's default branch through
  the GitHub Contents API (`gh api -X PUT …/contents/<path>`, one commit per file —
  never `git push`, which the delivery guard denies for any default branch)
  before protecting it with a `pull_request` / `non_fast_forward` / `deletion`
  ruleset, and writes `artifacts.repo.name` into the product's `.github/agento.json`.
  An existing companion repository or clone is adopted (marker or empty default
  branch required), never recreated or reset; a companion that already has commits
  receives missing files through a PR. The product repository no longer gets
  `features/`, `issues/`, or `initiatives/` roots; `templates/AGENTS-section.md`
  names the companion; the run ends with `agento.mjs doctor` requiring
  `artifact-repo` `ok`.

## 0.4.1 (2026-09-16)

- **Fixed: plugin hooks never ran (#36).** The manifest moved from a root
  `plugin.json` to `.claude-plugin/plugin.json` and the hook wiring from a root
  `hooks.json` to `hooks/hooks.json` (content unchanged). VS Code parses the root-level
  Copilot layout without expanding `${CLAUDE_PLUGIN_ROOT}`, so every SessionStart and
  PreToolUse hook spawned as `/scripts/hooks/…: not found` and installed plugins had no
  `Session:`/`Agento CLI:` context and no delivery guard; the Claude-format layout is the
  one VS Code substitutes the token for, so both hooks now execute. A regression test
  (`tests/customizations.test.mjs`) pins the layout. The dev-clone advice in README.md,
  docs/install.md, and AGENTS.md no longer suggests a workspace
  `"chat.pluginLocations": { "<path>": false }` toggle (the setting is machine-scoped, so
  a workspace value is ignored): do not register the dev clone at all, or disable the
  plugin per workspace from the Extensions view → *Agent Plugins – Installed*.

## 0.4.0 (2026-09-15)

- **New `/agento continue [<slug>]` and `agento.mjs next [<slug>]`.** `next` is a
  pure, unit-tested transition function (`deriveNext` in `scripts/session-state.mjs`)
  over the session record, roadmap ownership (`findOwner`), review freshness (last
  commit touching `review.md` versus the last code commit on `origin/<branch>`, the
  local branch, or `HEAD` — never fetching), and initiative readiness. It prints
  `status` (`ok | none | ambiguous | blocked | unsupported | missing`), `next`
  (`command`, `args`, `invocation`, `window: here | primary | secondary`, `then`,
  `reason`), `candidates[]`, and `dispatch { prompt, agent }` — the absolute paths of
  the command file and the agent file its `agent:` frontmatter names. `/agento
  continue` runs it and performs the one transition: in this window by following the
  dispatched command's own prompt and agent files verbatim (Builder, Reviewer,
  Planner for an initiative member, `ship` from the primary), or across windows by
  reopening the owning worktree (`/agento start-session … --resume`) or the primary
  (`code <path>`) and naming the command for it. Delivery lifecycle only — freehand,
  quick-fix, and commit-current-changes windows are rejected with the record's
  alternatives, and `/agento ap` is never chosen; several candidates are listed as
  `/agento continue <slug>` choices. `/agento continue` is now the first `allowed`
  entry of every `primary`, `build`, and `plan` row in the session record; policy §8
  names it as the derived handoff shorthand and §9 gains its idempotency row.
- **`/agento ship` audits first and tears down last.** Ship no longer requires
  `/agento close-session` before it runs. With the build worktree still owning the
  branch (`owner` from `ship-preflight`), the audit is read-only from the primary
  against `origin/<branch>`, the owner must be clean and zero-ahead, and every write
  (integration merge, `status: complete` commit, changelog stamp, push) goes through
  `git -C <owner.path>`; a conflicting integration merge is aborted and handed back to
  the build window. Gaps are split into a pinned hard-reject list (unticked or falsely
  ticked steps, review missing/stale/request-changes, failing regression test, dirty
  or unpushed owner, `CONFLICTING` PR — nothing written, `next:` names the open
  window's build or review command) and a confirmation list (unstamped changelog, PR
  nits, undocumented drift); a missing `Fixes #<n>` is fixed via `gh pr edit`. After
  the merge and `main` sync, ship removes the worktree, prunes, and deletes the merged
  local branch; when the secondary window still occupies the path it pauses (`paused
  at teardown`) and a re-send resumes there — new §9 ship idempotency row. Policy §8
  now hands off `Verdict: approve` → `/agento ship <slug>` directly; standalone
  `/agento close-session` is for plan and freehand sessions and abandoned builds
  (closing before ship stays valid — ship then takes its no-owner path). The session
  record's allowed/elsewhere table lists ship before close for approved deliveries and
  points a shipped-but-still-open worktree back at ship. A customizations test rejects
  any guidance that sequences close-session before ship.
- **New `agento.mjs doctor` and per-command preflight.** `doctor [--for <command>]`
  runs six environment checks (`node` ≥ 20, `git-remote`, `gh` installed and
  authenticated, `code` CLI, `python3`, writable `worktrees-dir`), each reported as
  `{ id, status, detail, fallback }`, overall `ok | warn | fail` (exit 3 on `fail`);
  `--for` limits the run to the named command's needs. Every prompt and agent now
  opens with `Needs:` / `Fallback:` lines from the §10 vocabulary; commands needing
  `gh`, `code`, or `network` run `doctor --for <name>` before their first write and
  map `fail` to a `Receipt: rejected — <capability>: …; fallback: …` receipt and
  `warn` to a `Preflight:` line. New `/agento doctor` command reports the checks and
  fixes nothing. Policy gains `## 10. Capability preflight`; the customizations test
  cross-checks vocabulary, prompts, and the CLI table.

- **New `agento.mjs session [--pr]`.** One JSON record answering "where am I, what is
  active, what may I run next": the window `role` (`primary`, `plan`, `build`,
  `freehand`, `unmanaged` — a promoted `plan-*` worktree on a delivery branch reports
  `build`), the `worktree`, the active `delivery` with its roadmap fields, a derived
  `lifecycle` (`no-delivery | planned | building | paused | in-review | approved |
  shipped | post-ship-pending`), and the `allowed` / `elsewhere` command table that
  encodes the build-and-review-in-the-secondary, close-and-ship-in-the-primary policy.
  `--pr` adds the branch's PR via `gh`, degrading to `pr: null` plus a warning when
  `gh` is absent or unauthenticated. Pure helpers live in `scripts/session-state.mjs`.
- **SessionStart hook emits a `Session:` line** built from `agento.mjs session` after
  `Agento CLI:`; when `node` is missing or the CLI fails, the output is byte-identical
  to 0.3.0.
- **`/agento delivery-status` opens with a Session section** (role, worktree, delivery,
  lifecycle, allowed and elsewhere commands, warnings) from `session --pr`.
- **Canonical command invocation.** New
  `.github/instructions/command-invocation.instructions.md` (`applyTo: "**"`) fixes
  the one spelling `/agento <name> [args]`, lists every command, and tells the agent to
  read the six old forms (`/<name>`, `/<name>.prompt`, `/<name>.md`,
  `/agento <name>.prompt`, `/agento <name>.prompt.md`, `/agento <name>.md`, with or
  without arguments) as the canonical command — say which in one sentence and
  proceed, no confirmation — so `/agento agento-init.prompt` is never again treated as
  prose. `docs/commands.md` gains an `## Invocation` section; the scaffolded AGENTS.md
  section carries the canonical-form note. `tests/customizations.test.mjs` now rejects
  a `.prompt`/`.md` suffix after a command name in guidance, requires suffix-less
  `<name>.md` files in the plugin `commands` directory, requires every command in the
  `## Invocation` section, and pins the instruction file to `applyTo: "**"` and the
  exact prompt list.
- **Execution receipts and per-command idempotency (policy §9).** Every `/agento …`
  command and agent response opens with exactly one `Receipt:` line and closes with
  exactly one `Result:` line; the formats live only in
  `delivery-policy.instructions.md`, and every prompt and agent cites §9 (enforced by
  `tests/customizations.test.mjs`). Operation IDs are deterministic
  (`<command>:<subject>:<short-sha>`), so re-sending a command is recognised as a
  duplicate from git + roadmap state alone — nothing is journaled. Rejections list
  alternatives copied from the session record's `allowed[]` / `elsewhere[]`. Behaviour
  changes that follow from the idempotency table: `/agento start-session` and
  `/agento start-freehand` resume a registered worktree for the same subject with
  `--resume` semantics instead of stopping; `/agento close-session` reports an
  already-removed worktree as already closed and still deletes a merged local branch;
  `/agento quick-fix` reuses an open `changes/<slug>` PR from the same base and applies
  the `-2`, `-3` suffix only when that PR is merged or closed.
- **Window-aware commands (policy §11).** New `## 11. Window check` in
  `delivery-policy.instructions.md`: every command and agent carries one
  `Window check per §11: requires role …` line, runs `agento.mjs session` before
  reading delivery state or writing, and rejects a mismatch with the §9 `rejected`
  receipt whose alternatives come from the record (`role: unmanaged` always rejects
  and names the primary checkout). The roles table stays in the CLI (`deriveAllowed`).
  `session` gains `hosted` (`true` under `CODESPACES=true` or `GITHUB_ACTIONS=true`;
  the role is then derived from the branch alone and `warnings[]` says why — the
  Planner's prose exemption for hosted workspaces is gone) and `worktrees[]` (every
  registered checkout as `{ path, branch, detached, role, dirPrefix, id, isPrimary,
  isManaged }`). `close-decision` and `ship-preflight` gain `owner`
  (`{ path, role, dirPrefix, id } | null`); `closeBuildSessionDecision` resolves
  ownership exactly (entry on the branch inside the realpath of `worktrees.dir`)
  instead of a basename regex plus a `currentBranch !== default` fallback, and a
  primary checkout sitting on the delivery branch now yields the new reason
  `primary-owns-branch` ("return the primary to `main` first") rather than
  `managed-worktree-present`. `git worktree list --porcelain` remains only in
  `start-session`, `start-freehand`, `close-session`, and `ship`;
  `tests/customizations.test.mjs` enforces the §11 citation and that allowlist.
  `/agento commit-current-changes` now requires role `primary` on a non-default
  branch; `/agento finish-freehand` requires role `freehand`.

## 0.3.0 (2026-09-06)

- **New 🏛️ Agento Architect and `/new-initiative <brief | path>`.** Runs in the
  primary window on `main`: clarifies, researches, decomposes a large brief into 2–8
  independently shippable member features with `Requires:` dependencies and waves,
  writes `initiatives/YYYY/MM/<slug>/brief.md` (the source text verbatim under a
  `Source:` line) and `breakdown.md`, validates the result with `agento.mjs initiative
  <slug>`, and publishes it itself on a `changes/initiative-<slug>` branch through a
  PR, bounded check wait, and normal merge before syncing `main`.
- **New `/next-feature <initiative-slug>`.** Read-only: groups members as ready,
  blocked (with `blockedBy`), in flight, and complete; surfaces anomalies; names the
  CLI's recommended `next` and prints the exact `/start-session` → `/new-feature
  initiative:<i>/<f>` → build → review → close → ship commands, plus the other
  ready members that can be planned concurrently. Never creates worktrees or files.
- **Planner initiative intake.** `/new-feature initiative:<initiative-slug>/<feature-slug>`
  attaches a plan to an initiative explicitly — never by slug coincidence. The Planner
  validates the member via `agento.mjs initiative`, hard-stops on missing, invalid,
  already-planned, non-member, or blocked members (no override), uses the breakdown's
  `Brief:`/`Summary:`, keeps the preassigned slug, writes `initiative: "<slug>"` in the
  roadmap header, and links the breakdown from plan.md.
- **`/delivery-status` shows initiatives**: an `Initiative` column on every delivery
  and a second table from `agento.mjs initiative` (complete/total, in flight, ready,
  `next`, `done`) recommending `/next-feature <slug>`; invalid breakdowns and
  initiative anomalies join the anomaly list.
- **`/ship` stamps the changelog.** When the shipped branch changes the plugin version
  and `CHANGELOG.md` carries `## <version> (unreleased)`, the `status: complete` commit
  replaces `(unreleased)` with the UTC ship date; a merge resumed on a later date
  refreshes the stamp first.
- **Initiative foundation** (from `initiatives-core`, previously unreleased): the
  `initiatives/YYYY/MM/<slug>/` artifact contract (`brief.md` + `breakdown.md`, no
  checkboxes), the `artifacts.initiatives` config root, the optional `initiative:`
  roadmap header, and `agento.mjs initiative [<slug>]`, which derives per-member
  state, `blockedBy`, waves, `next`, validation `errors`, and `anomalies` from the
  member roadmaps.

## 0.2.0 (2026-09-05)

- **Single-source delivery policy.** The work boundary, verification targets,
  manual/post-ship steps and evidence, lint gate, shell hygiene, git rules, and
  cross-window handoff — previously restated in up to five files with drifting
  wording — now live once in `delivery-policy.instructions.md` (`applyTo: "**"`).
  Builder, Planner, Reviewer, Autopilot, the build/review/ship prompts, the artifact
  contract, and concurrent-delivery cite its numbered sections. A test fails if a
  canary phrase reappears outside the policy file or a `§N` reference dangles. The
  Mechanic's pitfalls list drops entries that merely restated policy.
- **New `/quick-fix` lite tier**: a small, well-understood change made end to end in
  the current window — branch, implement, verify, PR, bounded check wait, merge —
  with the same guards and ruleset but no plan/roadmap/review/second window. Refuses
  work that needs a plan and names the right command instead.
- **New `scripts/agento.mjs` CLI** (`config`, `resolve`, `find`, `status`,
  `close-decision`, `ship-preflight`, `paths`, `ports`). Prompts and agents call it
  for slug resolution, status listings, worktree paths, and config values instead of
  re-deriving the algorithms in prose; the SessionStart hook announces its path as
  `Agento CLI:`. Configured branch names and artifact roots are now honoured by the
  prompts, not just the hooks.
- **Delivery guard hardening.** Evaluates commands per shell segment and tracks
  `git switch`/`checkout` through a chain; newly denies `+refspec` and `--force=`
  pushes, `--no-verify`, `gh pr merge --admin`, remote deletion of the default branch,
  watchers behind `nohup`/`setsid`/`timeout`/`&`, and hook-file writes by command word
  (cp/install/truncate/tee/`perl -pi`/`git checkout --`) rather than a five-verb
  denylist; asks before `--amend`, `rebase`, `reset --hard`, `branch -D`, and
  squash/rebase merges; the roadmap nudge inspects `-a` and pathspec commits. The
  decision is emitted as JSON directly, so reasons with colons are intact.
- **Config:** `null` in `.github/agento.json` means "keep the default" (the shipped
  template's `worktrees.dir: null` previously crashed the resolver).
- **`wait-for-checks.sh`:** a PR with no checks terminates (`--no-checks-grace`,
  default 30s) instead of pending forever.
- **Tests/CI:** the guard fixture replay asserts expected verdicts and runs in a
  throwaway repo on a feature branch; new suites for `session-context.sh`,
  `wait-for-checks.sh` (stubbed `gh`), the CLI, and customization-file structure
  (frontmatter, agent cross-references, docs coverage, hook wiring, version sync).
- **Frontmatter fixes:** `/ship` and `/triage-followups` run on the default agent
  (their Builder/Planner hosts forbade what they do); `/install-skills` no longer
  advertises an unimplemented flag.
- **Docs:** the guard is described as a slip guard with GitHub rulesets as the
  enforcement layer; `/agento-init` checks for a ruleset and offers to create one and
  no longer offers an unpinned `curl` fallback; platform support (Linux/macOS, VS
  Code) stated.

## 0.1.0 (2026-09-03)

Initial release, extracted from the delivery system developed inside the Soshiki
project.

- Five agents: 📋 Agento Planner, 🔨 Agento Builder, 🔍 Agento Reviewer,
  🤖 Agento Autopilot, 🛠️ Agento Mechanic.
- 18 slash commands: /agento-init, /start-session, /new-feature, /new-issue,
  /build-feature, /build-issue, /review-feature, /review-issue, /ap, /ship,
  /close-session, /start-freehand, /finish-freehand, /commit-current-changes,
  /delivery-status, /triage-followups, /extend-copilot, /fix-copilot.
- Hooks: SessionStart context (branch + resumable work) and PreToolUse delivery
  guard (default-branch and force-push protection, watcher denial, roadmap nudge,
  hook self-protection, worktree-occupant check).
- Scripts: `agento-config.mjs` (`.github/agento.json` loader),
  `delivery-roadmap-resolver.mjs` (local + origin fallback, branch-header
  validation), `wait-for-checks.sh` (bounded CI poller), `replay-guard.sh`.
- Instructions: delivery artifact contract, skills-first policy,
  concurrent-delivery policy.
- All Soshiki-specific couplings removed; project facts parameterized via
  `.github/agento.json` and the target repo's `AGENTS.md` `## Agento` section.
