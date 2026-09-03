# Installing Agento

Agento is a VS Code Copilot **agent plugin**. It is never copied into your project;
you register the clone (or the Git URL) once and it works alongside any repository
you open.

## Prerequisites

- VS Code with GitHub Copilot (agent mode).
- `git` and `gh` (GitHub CLI, authenticated) in the target project.
- `python3` on PATH (the hooks use it; standard on Linux/macOS).
- `node` ≥ 20 if you want to run Agento's own test suite.

## Option A — local clone (recommended for forkers)

```bash
git clone https://github.com/david-perry-software/agento ~/code/agento
```

VS Code settings (user or workspace):

```jsonc
"chat.plugins.enabled": true,
"chat.pluginLocations": { "~/code/agento": true }
```

Set the value to `false` to disable Agento for a specific workspace — for example
when developing Agento inside its own clone, where the workspace-mode hooks in
`.github/hooks/` already apply.

## Option B — install from source

Command Palette → **Chat: Install Plugin From Source** →
`https://github.com/david-perry-software/agento`.

## Option C — Copilot CLI

```bash
copilot plugin install david-perry-software/agento
```

Plugins installed through the CLI are also discovered by VS Code.

## First run in a project

Open your project and run `/agento-init`. It scaffolds `.github/agento.json`,
`features/` + `issues/`, an `## Agento` section in your `AGENTS.md`, and
`scripts/wait-for-checks.sh`, then commits them on a `changes/agento-init` branch.

## Verifying the install

- `/delivery-status` should respond (empty dashboard on a fresh project).
- The Output panel channel **GitHub Copilot Chat Hooks** should list the Agento
  SessionStart and PreToolUse hooks.
- `git push origin main` typed by the agent is denied by the delivery guard.

## Updating

`chat.pluginLocations` clones update with a normal `git pull`. Plugins installed
from source update via **Extensions: Check for Extension Updates** or
`copilot plugin update agento`.
