# Changelog

## 0.3.0 (unreleased)

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
