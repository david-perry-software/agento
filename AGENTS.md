# Agento Agent Baseline

Agento is a Copilot **agent plugin**: a portable plan → build → review → ship
delivery system. Layout:

- `plugin.json` + `hooks.json` — plugin manifest and plugin-mode hook wiring
  (`${PLUGIN_ROOT}` paths).
- `.github/agents/` — the five delivery agents (Planner, Builder, Reviewer,
  Autopilot, Mechanic).
- `.github/prompts/` — the slash commands.
- `.github/instructions/` — the artifact contract, skills-first policy, and
  concurrent-delivery policy.
- `.github/hooks/` — workspace-mode hook wiring (relative `./scripts/hooks` paths)
  so Agento development is guarded by Agento itself.
- `scripts/` — `agento-config.mjs`, `delivery-roadmap-resolver.mjs`,
  `wait-for-checks.sh`, `hooks/{delivery-guard,session-context,replay-guard}.sh`.
- `templates/` — files `/agento-init` scaffolds into target repositories.
- `tests/` — guard fixtures and node:test suites.
- `docs/` — user and architecture documentation.
- `examples/` — a filled-in project profile as reference.

## Commands

- Test: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` (Node ≥ 20, no
  dependencies)
- Guard smoke: `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt`
- Shell lint: `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh`

## Non-negotiable rules (this repository eats its own cooking)

- Never commit or push directly to `main`; publish through pull requests. No
  force-push, no rebase of pushed history, no `--no-verify`. (Bootstrap exception:
  the very first push of `main` when the repo had no remote.)
- When developing Agento inside its own clone, keep the plugin **disabled** for this
  workspace (`chat.pluginLocations`) so the plugin-mode and workspace-mode hooks do
  not both fire.
- Hooks are security-sensitive: `scripts/hooks/` and `.github/hooks/` edits are
  always gated behind user approval by the guard itself.
- Never print, request, or log secrets.
- Bounded waits only: `scripts/wait-for-checks.sh`, never `--watch`/`--wait`.
- Every agent's final response ends with a concrete suggested next step.
