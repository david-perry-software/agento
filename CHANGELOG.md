# Changelog

## 0.2.0 (2026-09-05)

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
