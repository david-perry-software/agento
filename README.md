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
   project's `.github/agento.json`, `features/` + `issues/` directories, and an
   `## Agento` section in your project's `AGENTS.md`.

## License

MIT. See [LICENSE](LICENSE).

*Full documentation lands with v0.1.0 — see `docs/`.*
