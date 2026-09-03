# Agento

An extractable, self-contained Copilot **agent plugin** that adds a complete
plan → build → review → ship delivery system to any git project:

`/start-session` → `/new-feature` or `/new-issue` → `/build-feature|issue` →
`/review-feature|issue` → `/ap` (unattended loop) → `/ship` → `/close-session`,
plus a freehand escape hatch (`/start-freehand`, `/finish-freehand`) for work
that doesn't warrant artifacts.

Progress lives in committed, pushed `roadmap.md` files — work resumes from git
state alone, on any machine.

## Install (side by side — nothing is copied into your project)

1. Clone this repo anywhere, e.g. next to your project:

   ```bash
   git clone https://github.com/david-perry-software/agento ~/code/agento
   ```

2. In VS Code settings (user or workspace), register the local clone as a plugin:

   ```jsonc
   "chat.pluginLocations": {
     "~/code/agento": true
   }
   ```

   Enable agent plugins if you haven't: `"chat.plugins.enabled": true`.
   (You can also install from source: Command Palette →
   *Chat: Install Plugin From Source* → `https://github.com/david-perry-software/agento`,
   or with Copilot CLI: `copilot plugin install david-perry-software/agento`.)

3. Open your project in VS Code and run `/agento-init` — it scaffolds your
   project's `.github/agento.json`, `features/` + `issues/` directories, an
   `## Agento` section in your project's `AGENTS.md`, and
   `scripts/wait-for-checks.sh`.

## Commands

`/agento-init` · `/start-session` · `/new-feature` · `/new-issue` ·
`/build-feature` · `/build-issue` · `/review-feature` · `/review-issue` ·
`/ap` · `/ship` · `/close-session` · `/start-freehand` · `/finish-freehand` ·
`/commit-current-changes` · `/delivery-status` · `/triage-followups` ·
`/extend-copilot` · `/fix-copilot`

## Documentation

- [Install options and first run](docs/install.md)
- [Command reference](docs/commands.md)
- [Architecture](docs/architecture.md)
- [Delivery artifacts (plan/roadmap/review)](docs/artifacts.md)
- [Hooks (guard + session context)](docs/hooks.md)
- [Concurrency model (worktrees, ports, previews)](docs/concurrency.md)
- [Project profile: `.github/agento.json` + `AGENTS.md`](docs/project-profile.md)
- [Example filled-in project profile](examples/soshiki-profile.md)

## Developing Agento

`node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` ·
`./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` ·
`shellcheck scripts/hooks/*.sh`. See [AGENTS.md](AGENTS.md) — Agento is developed
with Agento's own hooks in workspace mode, so keep the plugin disabled for this
workspace.

## License

MIT. See [LICENSE](LICENSE).

