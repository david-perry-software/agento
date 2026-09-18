# Agento Agent Baseline

Agento is a Copilot **agent plugin**: a portable plan → build → review → ship
delivery system. Layout:

- `.claude-plugin/plugin.json` + `hooks/hooks.json` — plugin manifest and plugin-mode
  hook wiring (`${CLAUDE_PLUGIN_ROOT}` paths; this Claude-format layout is the one VS
  Code expands the token for).
- `.github/agents/` — the five delivery agents (Planner, Builder, Reviewer,
  Autopilot, Mechanic).
- `.github/prompts/` — the slash commands (`/agento continue` performs the one
  transition `agento.mjs next` derives by following the dispatched command's files).
- `.github/instructions/` — the shared delivery policy (single source of the rules;
  agents cite `§N`), the artifact format contract, the skills-first policy, and the
  concurrent-delivery mechanics.
- `.github/hooks/` — workspace-mode hook wiring (relative `./scripts/hooks` paths)
  so Agento development is guarded by Agento itself.
- `scripts/` — `agento.mjs` (the CLI prompts call: config, resolve, find, status,
  close-decision, ship-preflight, paths, ports, session, next, initiative, doctor,
  migrate), `agento-config.mjs`, `session-state.mjs`,
  `delivery-roadmap-resolver.mjs`,
  `wait-for-checks.sh`, `hooks/{delivery-guard,session-context,replay-guard}.sh`.
- `templates/` — files `/agento agento-init` scaffolds into target repositories.
- `tests/` — guard fixtures and node:test suites.
- `docs/` — user and architecture documentation.
- `examples/` — a filled-in project profile as reference.
- This repository's own delivery artifacts — `features/`, `issues/`, `initiatives/`
  — live in the companion repository `david-perry-software/agento-docs`, cloned as
  the sibling `../agento-docs`; `.github/agento.json` names it
  (`artifacts.repo.name`). Add `../agento-docs` to the primary window's workspace
  to edit them there; managed sessions open as a two-folder `.code-workspace`.

## Commands

- Test: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` (Node ≥ 20, no
  dependencies)
- Guard smoke: `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt`
- Guard smoke (companion mode): `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh <
  tests/guard-fixtures-companion.txt`
- Shell lint: `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh`

## Non-negotiable rules (this repository eats its own cooking)

- Never commit or push directly to `main`; publish through pull requests. No
  force-push, no rebase of pushed history, no `--no-verify`. (Bootstrap exception:
  the very first push of `main` when the repo had no remote.)
- When developing Agento inside its own clone, do **not** register the clone in
  `chat.pluginLocations` (machine-scoped; a workspace value is ignored): the
  workspace-mode `.github/hooks/` wiring already guards the clone and every worktree
  and is the only wiring whose `./scripts/hooks/…` paths resolve inside a worktree.
  If the clone must stay registered for other repositories, disable the plugin per
  workspace from the Extensions view → *Agent Plugins – Installed* → context menu (or
  the Agent Customizations editor), in each worktree window too, so the plugin-mode
  and workspace-mode hooks do not both fire.
- Hooks are security-sensitive: `scripts/hooks/` and `.github/hooks/` edits are
  always gated behind user approval by the guard itself.
- Never print, request, or log secrets.
- Bounded waits only: `scripts/wait-for-checks.sh`, never `--watch`/`--wait`.
- Every agent's final response ends with a concrete suggested next step — the
  `next:` of the execution receipt's result line (delivery-policy §9).
