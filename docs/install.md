# Installing Agento

Agento is a VS Code Copilot **agent plugin**. It is never copied into your project;
you register the clone (or the Git URL) once and it works alongside any repository
you open.

## Prerequisites

- VS Code with GitHub Copilot (agent mode). The session model (`/agento start-session` opens
  a second VS Code window on a sibling worktree) is built around the VS Code CLI
  (`code`); the Copilot CLI can run the prompts but the window choreography is
  VS Code-specific.
- Linux or macOS. The hooks are Bash + `python3`; the worktree-occupant check reads
  `/proc` and is skipped elsewhere. Windows is untested.
- `git` and `gh` (GitHub CLI, authenticated) in the target project.
- `python3` on PATH (the hooks use it; standard on Linux/macOS).
- `node` ≥ 20 — required: the prompts call `scripts/agento.mjs` for slug resolution
  and config lookups, and the test suite runs on it.

## Option A — local clone (recommended for forkers)

```bash
git clone https://github.com/david-perry-software/agento ~/code/agento
```

VS Code **user** settings (`chat.pluginLocations` is machine-scoped; a workspace
value is ignored):

```jsonc
"chat.plugins.enabled": true,
"chat.pluginLocations": { "~/code/agento": true }
```

When developing Agento inside its own clone, do **not** register that clone here: the
workspace-mode hooks in `.github/hooks/` already guard the clone and every worktree,
and they are the only wiring whose `./scripts/hooks/…` paths resolve inside a
worktree. If the clone must stay registered because it serves other repositories,
disable the plugin per workspace from the Extensions view → **Agent Plugins –
Installed** → context menu on Agento (or the Agent Customizations editor) — in each
worktree window too.

## Option B — install from source

Command Palette → **Chat: Install Plugin From Source** →
`https://github.com/david-perry-software/agento`.

## Option C — Copilot CLI

```bash
copilot plugin install david-perry-software/agento
```

Plugins installed through the CLI are also discovered by VS Code.

## First run in a project

Open your project and run `/agento agento-init`. It creates the companion artifact
repository `<repo>-docs` on GitHub (same owner and visibility as your project),
clones it to `../<repo>-docs` with `features/`, `issues/`, and `initiatives/`
inside, then scaffolds `.github/agento.json` pointing at it, an `## Agento` section
in your `AGENTS.md`, and `scripts/wait-for-checks.sh`, and commits those on a
`changes/agento-init` branch. Add the companion folder to your VS Code workspace so
its artifact-format instructions load.

Managed sessions open as a two-folder `.code-workspace` pairing the product and
companion halves. The first time VS Code sees that workspace settings block it may
show **Enable terminal auto approve?**; choose **Enable** once for the machine.
To avoid a trust prompt for every new session, trust the parent worktree directories
(`../<repo>-worktrees` and `../<repo>-docs-worktrees`, or your configured
alternatives) once instead of each child folder.

A project that already keeps `features/`, `issues/`, or `initiatives/` inside its own
repository runs `/agento agento-init --migrate` instead: one command imports the tree
into the companion as a single commit and opens two PRs — merge the companion PR
first, then the product PR. Ship any in-flight deliveries before migrating; the
command refuses while open delivery PRs exist unless you accept.

## Verifying the install

- `/agento delivery-status` should respond (empty dashboard on a fresh project).
- The Output panel channel **GitHub Copilot Chat Hooks** should list the Agento
  SessionStart and PreToolUse hooks, and a new chat's context should include an
  `Agento CLI: node .../scripts/agento.mjs` line.
- `git push origin main` typed by the agent is denied by the delivery guard.
- The default branch has a GitHub ruleset (require PR, required checks, no force
  push, no deletion) — `/agento agento-init` checks and offers to create one, and
  protects the companion's default branch the same way. The guard alone is not
  protection.

## Updating

`chat.pluginLocations` clones update with a normal `git pull`. Plugins installed
from source update via **Extensions: Check for Extension Updates** or
`copilot plugin update agento`.
