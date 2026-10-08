# VS Code extension

The Agento extension is a dashboard and command launcher for projects that use the
Agento Copilot agent plugin. Install both parts: the plugin provides the delivery
agents, commands, and guard hooks; the VSIX provides the activity-bar views and
routes the CLI's recommended commands into Copilot Chat.

## Install

Install the plugin first using one of the methods in the
[installation guide](install.md). Then build or obtain `agento-dashboard-0.6.1.vsix`
and install it from the Command Palette with **Extensions: Install from VSIX...**.
From a terminal, the equivalent command is:

```bash
code --install-extension agento-dashboard-0.6.1.vsix
```

Open an initialized Agento project. The activity bar contains an **Agento** view
container with Deliveries, Initiatives, and Session & Doctor views. The extension
uses its bundled CLI, so the project does not need a separate Agento clone on
`PATH`; the plugin must still be installed for Copilot Chat to run the submitted
`/agento ...` commands.

## Deliveries

The Deliveries view groups feature and issue roadmaps by lifecycle: Planned,
Building, In Review, and Shipped. Each row shows the slug, artifact type, completed
steps, roadmap status, and product pull request. Its tooltip includes product and
companion pull requests, worktree ownership, workspace, companion checkout, and
initiative data when the CLI supplies them.

Select a delivery to open its `roadmap.md` beside the active editor. Use the play
action to choose from commands the CLI currently allows for that delivery. The
New Plan title action appears only in the primary window or an unpromoted plan
window (see [Command routing](#command-routing)).

## Initiatives

The Initiatives view groups members as Ready, In flight, Blocked, and Complete.
Member details include wave, blockers, readiness, and whether the member is the
recommended next feature. Select an initiative or member to open its
`breakdown.md`. The play action on a ready member starts the guided planning flow
for that exact initiative member; it appears only in the primary window or an
unpromoted plan window. The New Initiative title action appears only in the
primary window. The play action on an in-flight member opens the
same actions picker the Deliveries view offers for that slug; when no delivery
matches, it shows an informational message naming the slug and dispatches nothing.

## Session & Doctor

The Session & Doctor view shows the current window role, worktree, branch,
lifecycle, generated workspace, companion checkout and sync state, CLI warnings,
and every environment check returned by `agento.mjs doctor`. Doctor findings are
read-only; use the displayed fallback to repair the environment.

The status bar summarizes the same snapshot as `Agento: <role> · <N> active`.
Select it to focus Session & Doctor. The view's play action offers the commands
available in the current window and the commands assigned to another window. Its
New Plan title action appears only in the primary window or an unpromoted plan
window.

## Refresh and recovery

Run **Agento: Refresh** (`agento.refresh`) after an external change. The extension
also refreshes on activation, when Session & Doctor first becomes visible, and after
watched roadmap, review, or Git state changes. File events are debounced by at least
three seconds. Load failures remain visible in the affected tree and are written to
the **Agento** output channel; run Refresh to retry.

If a command must continue in another window, Agento records it for the exact
CLI-selected target and opens that folder or companion workspace. The target window
consumes the record on activation or focus. Pending commands expire after five
minutes and invalid, mismatched, rejected, or failed handoffs are discarded and
reported rather than submitted. Reopen the source window, refresh, and choose the
action again to recover.

## Command routing

The extension does not maintain a parallel workflow state machine. Delivery and
session actions come from the CLI's `allowed[]` and `elsewhere[]` records, and a
delivery selection is revalidated with `agento.mjs next <slug>` before dispatch.

Current-window actions open Copilot Chat **in the command's agent** with the exact
canonical `/agento <name> [args]` query: the `mode` passed to
`workbench.action.chat.open` is the `agent:` frontmatter of the plugin command
file `commands/<name>.md` (`"agent"` for built-in-agent commands), so the agent's
`model:` pin applies. Every dispatch also attaches that command file so the agent
can read it directly. When no plugin clone can be resolved — set
`agento.pluginRoot`, or register the clone in `chat.pluginLocations` — the
dispatch keeps the currently selected agent and writes one
`dispatch: no mode for <command>: <reason>` line to the Agento output channel; a
missing or unreadable command file likewise omits the attachment and writes
`dispatch: no command file for <name>: <reason>`.
Cross-window actions save `/agento continue <slug>` for the CLI-selected folder
or `.code-workspace`, then open or focus that target; the pending command is
consumed with the same agent-mode dispatch. The New Plan action
(`agento.newPlan`) collects a feature or issue description. From an unpromoted
planning window (Session & Doctor reports `role: plan` with a detached worktree)
it submits `/agento new-feature …` or `/agento new-issue …` in that same window —
no new session is started. From the primary window it runs
`agento.mjs start-session --no-open` in the primary checkout (a progress
notification, bounded at 120 s), saves the new-feature or new-issue command as the
pending command for the returned `target` (the plan folder, or its
`.code-workspace` in companion mode), and opens that target itself — nothing goes
through chat and nothing is polled. A `rejected` or `failed` result (or a CLI
timeout) shows the CLI's reason in an error notification with an **Open in chat**
action that submits `/agento start-session` to the primary window's chat instead;
a failed window open keeps the Retry / Focus target recovery prompt.
`agento.planInitiativeMember` uses the selected ready initiative member and takes
the same in-window path from an unpromoted planning window.

Start-session actions take the same CLI path: a Deliveries or Initiatives play
button, a Session & Doctor action, or `/agento continue` whose refreshed
`agento.mjs next` is a `start-session` transition runs `agento.mjs start-session
<next.args> --no-open` (an `/agento start-session …` action without a slug runs
its own arguments), saves `next.then` (for example `/agento continue <slug>`) as
the pending command for the returned target, and opens it. Failures show the CLI
reason with the same **Open in chat** action, which submits the original command.
Other actions on the same delivery (for example `/agento delivery-status`) still
submit to chat.

The planning entry points are gated on the window role from the latest applied
`agento.mjs session` refresh, through two context keys:

| Context key | True when | Gates |
| --- | --- | --- |
| `agento.primary` | `role: primary` | New Initiative (`agento.newInitiative`) |
| `agento.canPlan` | `role: primary`, or `role: plan` with a detached worktree (an unpromoted plan window) | New Plan (`agento.newPlan`) and the ready-member Plan action (`agento.planInitiativeMember`) |

Both keys are false at activation, after a failed session read, and in every
other window — `build` (including a promoted plan worktree), `freehand`,
`unmanaged`, and hosted secondary windows — so the actions are hidden from the
view title bars, member rows, and the Command Palette (Plan never appears in the
Palette because it needs a selected member). Invoked anyway (a keybinding or
`executeCommand`), the command shows an error naming the primary window — for
example `New Initiative runs only in the primary window: switch to the primary
window and run it there.` — and returns before any prompt, editor, or dispatch.
A promoted plan worktree (`role: build`) therefore no longer shows New Plan; resume
that delivery's planning through its actions or the `/agento new-feature` /
`/agento new-issue` resume instead.

## Companion workspaces

When `.github/agento.json` names `artifacts.repo`, delivery and initiative files live
in the sibling companion repository. The views resolve those artifact roots through
the bundled CLI. Cross-window routing prefers the generated `.code-workspace` so the
product and companion halves open together, while roadmap and breakdown selections
open the files from the companion checkout.

Keep both repositories available at the configured sibling paths. Session & Doctor
reports detached, dirty, ahead, behind, or unregistered companion state directly
from the CLI.

## Model profiles

**Agento: Select Model Profile** (Command Palette) shows a quick pick of the profiles
in `~/.config/agento/model-profiles.json` — the applied one marked, each with its
description and first error — plus *Clear*. The choice runs `agento.mjs models apply
<name>` or `models clear` with `--plugin-root` set to the plugin clone: the
`agento.pluginRoot` setting, else the first enabled `chat.pluginLocations` entry whose
`.claude-plugin/plugin.json` is named `agento`. The bundled CLI's own plugin root is
`extension/`, so the extension always passes `--plugin-root`; the Session & Doctor
`doctor` call passes it too, so its `model-profile` check reports the clone. See
[model-profiles.md](model-profiles.md).

## Settings

- `agento.nodePath`: Node.js executable used to run the bundled CLI. The default is
  `node`.
- `agento.pluginRoot`: the Agento plugin clone model profiles are applied to. Empty
  (the default) uses `chat.pluginLocations`.
- `agento.refreshDebounceMs`: delay for watcher-driven refreshes, with a minimum of
  3000 milliseconds.

## Limitations

- The extension submits commands but does not run delivery agents itself.
- VS Code does not expose another window's chat output or cancellation through its
  public API, so Agento cannot inspect or cancel a remote chat.
- Marketplace publishing is not part of packaging; the release gate produces and
  validates a VSIX.
- Linux and macOS are supported by the plugin workflow. Windows remains untested.