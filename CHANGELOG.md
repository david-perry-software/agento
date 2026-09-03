# Changelog

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
