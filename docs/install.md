# Installing Agento

Agento is a VS Code Copilot **agent plugin**. It is never copied into your project;
you register the clone (or the Git URL) once and it works alongside any repository
you open.

## Prerequisites

- VS Code with GitHub Copilot (agent mode). The session model (`/agento start-session` opens
  a second VS Code window on a sibling worktree) is built around the VS Code CLI
  (`code`); the Copilot CLI can run the prompts but the window choreography is
  VS Code-specific.
- Linux or macOS. The hooks are Bash wrappers around Node modules; the
  worktree-occupant check reads `/proc` and is skipped elsewhere. Windows is untested.
- `git` and `gh` (GitHub CLI, authenticated) in the target project.
- `node` ≥ 20 — required: the prompts call `scripts/agento.mjs` for slug resolution
  and config lookups, both hooks run on it (without `node` on PATH they exit
  silently: no delivery guard, no SessionStart context), and the test suite runs on it.

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
worktree window too. While both wirings are active, the plugin-mode SessionStart hook
stays silent so the session context arrives once, but the delivery guard still runs
twice. `agento.mjs doctor` reports this as its informational `hook-wiring` check:
`warn` when `chat.pluginLocations` in your VS Code user settings maps this clone (or
any checkout sharing its git directory) to `true`. It cannot see a per-workspace
disable, so the warning stays until the clone is unregistered; `doctor --for` never
runs it. `AGENTO_VSCODE_SETTINGS` overrides the settings path.

## Option B — install from source

Command Palette → **Chat: Install Plugin From Source** →
`https://github.com/david-perry-software/agento`.

## Option C — Copilot CLI

```bash
copilot plugin install david-perry-software/agento
```

Plugins installed through the CLI are also discovered by VS Code.

## Copilot harness (Session Target Copilot)

VS Code Copilot Chat has two harnesses, chosen by the chat's **Session Target**:
**Local** and **Copilot**. Both resolve `/agento <name>` through the user-level
router skill `~/.copilot/skills/agento`, a symlink to the plugin clone's
`skills/agento/SKILL.md`. Neither harness loads `*.prompt.md` prompt commands — the
router skill is the only `/agento` path.

### Register the router skill (required)

After installing the plugin (A, B, or C above), register the skill link once:

```bash
node <clone>/scripts/agento.mjs harness install --plugin-root <clone>
```

`<clone>` is the plugin checkout (for Option A, `~/code/agento`). `harness status
[--plugin-root <clone>]` reports the link's state (`absent`, `installed`, `foreign`,
`dangling`, or `not-a-link`); `harness uninstall --plugin-root <clone>` removes only
Agento's own link; and `harness install --force --plugin-root <clone>` replaces a
`foreign` or `dangling` link. `--plugin-root` defaults to the clone the command
runs in.

Without the link `/agento` cannot run in any session and `agento.mjs doctor` fails
naming the exact command. `harness uninstall --plugin-root <clone>` removes the
link, after which `/agento` stops resolving.

Routing every `/agento` through the router skill also changes **Local** sessions:
Builder and Reviewer keep their model pins through the subagent tool, but the
inline agents and prompt-level model pins no longer switch — a known gap of the
router takeover. `harness uninstall` removes `/agento` entirely; it does not
restore prompt commands.

The Copilot CLI path (`copilot plugin install david-perry-software/agento` in
Option C) is **unobserved**: the GitHub Copilot CLI is not installed in the
environment where the harness was measured, so its plugin discovery and the router
link it would or would not create are untested. Use `harness install` for the
Copilot harness.

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
- The doctor `harness` check reports the router link state:
  `node <clone>/scripts/agento.mjs doctor` — `ok` when the link is `installed`,
  `fail` (with the `harness install` or `install --force` command as its fallback)
  when it is `absent`, `foreign`, `dangling`, or `not-a-link`. In either session
  (Copilot or Local) `/agento delivery-status` prints its `Receipt: accepted …`
  line through the router.
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

With a model profile applied (`/agento models apply <name>`, see
[model-profiles.md](model-profiles.md)), a local git clean/smudge filter carries the
pins, so a `git pull` keeps them with no extra step. Re-run `/agento models apply
<name>` when an update adds agents or prompts (`filter.unrecorded`). A clone pinned
by an older Agento (legacy skip-worktree bits) migrates once with `models apply
<name>`, or `models adopt` to keep custom pins. Installs from source or through the
Copilot CLI are replaced on update; apply the profile again afterwards.
