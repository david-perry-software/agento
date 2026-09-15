# Changelog

## 0.4.1 (unreleased)

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
