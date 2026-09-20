# VS Code extension

The Agento extension is a dashboard and command launcher for projects that use the
Agento Copilot agent plugin. Install both parts: the plugin provides the delivery
agents, commands, and guard hooks; the VSIX provides the activity-bar views and
routes the CLI's recommended commands into Copilot Chat.

## Install

Install the plugin first using one of the methods in the
[installation guide](install.md). Then build or obtain `agento-dashboard-0.6.0.vsix`
and install it from the Command Palette with **Extensions: Install from VSIX...**.
From a terminal, the equivalent command is:

```bash
code --install-extension agento-dashboard-0.6.0.vsix
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
action to choose from commands the CLI currently allows for that delivery.

## Initiatives

The Initiatives view groups members as Ready, In flight, Blocked, and Complete.
Member details include wave, blockers, readiness, and whether the member is the
recommended next feature. Select an initiative or member to open its
`breakdown.md`. The play action on a ready member starts the guided planning flow
for that exact initiative member.

## Session & Doctor

The Session & Doctor view shows the current window role, worktree, branch,
lifecycle, generated workspace, companion checkout and sync state, CLI warnings,
and every environment check returned by `agento.mjs doctor`. Doctor findings are
read-only; use the displayed fallback to repair the environment.

The status bar summarizes the same snapshot as `Agento: <role> · <N> active`.
Select it to focus Session & Doctor. The view's play action offers the commands
available in the current window and the commands assigned to another window.

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

Current-window actions open Copilot Chat in agent mode with the exact canonical
`/agento <name> [args]` query. Cross-window actions save `/agento continue <slug>`
for the CLI-selected folder or `.code-workspace`, then open or focus that target.
The New Plan action (`agento.newPlan`) collects a feature or issue description and
starts a planning session; `agento.planInitiativeMember` uses the selected ready
initiative member.

## Companion workspaces

When `.github/agento.json` names `artifacts.repo`, delivery and initiative files live
in the sibling companion repository. The views resolve those artifact roots through
the bundled CLI. Cross-window routing prefers the generated `.code-workspace` so the
product and companion halves open together, while roadmap and breakdown selections
open the files from the companion checkout.

Keep both repositories available at the configured sibling paths. Session & Doctor
reports detached, dirty, ahead, behind, or unregistered companion state directly
from the CLI.

## Settings

- `agento.nodePath`: Node.js executable used to run the bundled CLI. The default is
  `node`.
- `agento.refreshDebounceMs`: delay for watcher-driven refreshes, with a minimum of
  3000 milliseconds.

## Limitations

- The extension submits commands but does not run delivery agents itself.
- VS Code does not expose another window's chat output or cancellation through its
  public API, so Agento cannot inspect or cancel a remote chat.
- Marketplace publishing is not part of packaging; the release gate produces and
  validates a VSIX.
- Linux and macOS are supported by the plugin workflow. Windows remains untested.