# Agento

Agento is a VS Code dashboard and command launcher for the Agento delivery workflow.
The Agento activity-bar container includes Deliveries, Initiatives, and Session &
Doctor views, plus refresh, command dispatch, and output commands. A colored
window banner at the top of the sidebar names the window type (primary, plan, build,
freehand, or unmanaged); click it to focus Session & Doctor.

For installation and day-to-day use, see the
[VS Code extension guide](../docs/extension.md). This README focuses on extension
behavior and development.

## Deliveries

The Deliveries view reads the `deliveries` section of `agento.mjs dashboard --pr`
(the `status --pr` document) and shows each non-empty lifecycle
group in CLI order. Delivery rows keep the label compact: slug, type, roadmap
progress, status, and pull request state. Hover over a row for the full product and
companion pull request, worktree owner, workspace, companion checkout, and initiative
details supplied by the CLI. Selecting a delivery opens its roadmap beside the active
editor. Expand a delivery for its Timeline row: phase durations, review rounds,
pauses, and post-ship latency from the dashboard's `metrics` section (git history
only), with every timestamp in the tooltip.

The view refreshes after roadmap, review, and Git changes or when you run the Refresh
command. Empty results and load failures appear directly in the tree; CLI warnings
and errors are also written to the Agento output channel.

## Initiatives

The read-only Initiatives view reads the `initiatives` section of the same
`agento.mjs dashboard --pr` call: the `initiative` list and each initiative's
detail response. It shows initiative progress and groups members as Ready, In flight,
Blocked, and Complete using the state and readiness reported by the CLI. Member
descriptions and tooltips include state, wave, blockers, readiness, and whether the
member is next. Selecting an initiative or member opens its `breakdown.md` beside the
active editor, including when artifacts are stored in a companion repository.
The play action on an in-flight member opens the actions picker of the Deliveries
row with the same slug, or an informational message when no delivery matches.

The shared roadmap and Git watchers refresh both views without polling. Initiative
errors and merged-but-not-complete anomalies remain visible under the affected
initiative without hiding healthy initiatives; empty results and list failures are
shown explicitly in the tree and written to the Agento output channel.

## Session & Doctor

The Session & Doctor view reads the `session`, `doctor`, and `deliveries` sections of
the same `agento.mjs dashboard --pr` call. It shows the current role, worktree, branch, lifecycle,
workspace, companion state, CLI warnings, and every doctor check with its status,
detail, and fallback. Doctor output is read-only: the extension presents the CLI's
diagnosis and fallback text but does not repair the environment.

The view refreshes on activation, when it becomes visible, after watched workspace
changes, or when you run the Refresh command. A load failure remains inline and can
be retried with Refresh. The status bar summarizes the same snapshot as
`Agento: <role> · <N> active`, using the role from the `session` section and the
active count from the `deliveries` section; selecting it focuses the Session & Doctor view.

Every refresh is exactly one CLI spawn, `agento.mjs dashboard --pr` (plus
`--plugin-root <clone>` when a plugin clone is known), and all views, the status bar,
and the window banner update together from that one snapshot. A section the CLI
reports as `{ status: "error", message }` shows the error only in the views that read
it: Deliveries for `deliveries`, Initiatives for `initiatives`, and Session & Doctor
for `session`, `doctor`, or `deliveries`. The CLI's per-section `timings` are
written to the Agento output channel.

## Model Profiles

The Model Profiles view reads `agento.mjs models list --plugin-root <clone>` and
shows two pinned role rows — **Primary windows** and **Secondary windows**, each with
its assignment and an inline turn-off when on — followed by one row per profile: the
name, `primary` and/or `secondary` labels before the description when a role uses
the profile, and an icon — `pass-filled` for the profile in effect in this window,
`error` for a profile with errors, `warning` for one with warnings, and a plain glyph
otherwise. The tooltip lists the description, every error, every warning, the
resolved pins, and the profile's role assignments. When the clone's pins match no
profile, a leading info row says so.

The inline **Use Here** uses the profile for the current window's role (primary
windows run `models apply <name>`; plan/build/freehand windows run
`models use <name> --role secondary`). The context menu offers **Use in Primary
Windows**, **Use in Secondary Windows**, **Turn Off for Primary Windows**, **Turn Off
for Secondary Windows**, Edit, Duplicate, Rename, and Delete; the title bar offers
New Profile, **Turn Off for This Window's Role**, Refresh, and the overflow Open
Profiles File. Switching the primary profile from a secondary window asks a
confirmation first, and Delete names the roles that use the profile and passes
`--force` when one does. Two empty states invite you to create the profiles file, or
to set `agento.pluginRoot` / `chat.pluginLocations` when no Agento plugin clone is
found.

The view refreshes on activation, on every `agento.refresh`, when it becomes visible,
on window focus, and from watchers on the profiles file, the roles file
(`model-roles.json`), and the clone's `.github/agents/*.agent.md` files, so a role or
profile change from a terminal or another window shows up without a manual refresh.
Writes pass the right hash as `--expect` (the profiles-file hash for primary writes,
the roles-file hash for secondary writes), so a stale view shows a retry message and
reloads instead of clobbering a concurrent edit. The window banner shows a `Models:`
line naming the profile in effect in this window.

**Edit** opens a webview form editor for the profile — name, description, default
model, the six agent pins, and per-command overrides — instead of the raw JSON. Each
value is a single model or an ordered fallback list; the datalist offers the models
VS Code reports and free text always works. **Save** dry-runs first and shows errors
and warnings inline; **Save & Use Here** saves then uses the profile in this window's
role. **Add alias** next to a chosen model runs `models alias set`, and a concurrent
write shows a conflict banner with only **Reload**. Closing the panel discards
unsaved edits.

## Commands

The play action in a delivery row, an in-flight initiative member, or the Session &
Doctor title opens a picker in the exact order returned by the CLI's `allowed[]` and
`elsewhere[]` fields. The extension does not maintain its own lifecycle command list.
Delivery selections are revalidated with `agento.mjs next <slug>` immediately before
dispatch.

Actions for the current window open Copilot Chat with the exact canonical command
as the query and agent mode selected, and — when `agento.chatModelPreselect` is
`local` or `copilot` — with a `modelSelector` for the resolved model (see
[Settings](#settings)). Cross-window actions store `/agento continue
<slug>` for five minutes under the CLI-selected target path, then open or focus that
target. A companion delivery prefers its generated `.code-workspace`; other targets
open the CLI-supplied folder. The target window removes the pending record before
submitting it on activation or focus, so one command cannot be submitted twice.

After opening another window, a notification can focus it again while the command
runs. VS Code provides no API for reading or cancelling chat in another window, so
Agento does neither. Expired, malformed, mismatched, rejected, or failed handoffs are
discarded without submission and reported in the UI and Agento output channel.

**Agento: Select Model Profile** lists the profiles in
`~/.config/agento/model-profiles.json`, marks each profile's `primary` / `secondary`
labels, and uses the chosen profile for the current window's role — or *Turn off* —
through the bundled CLI (`agento.mjs models apply|clear --plugin-root <clone>` for
primary windows, `agento.mjs models use <name|none> --role secondary` for
plan/build/freehand windows). The clone is the `agento.pluginRoot` setting, else the
first enabled `chat.pluginLocations` entry whose `.claude-plugin/plugin.json` is named
`agento`. Run *Developer: Reload Window* if the model picker does not update;
failures go to the Agento output channel.

The Model Profiles view is driven by the `agento.modelProfiles.*` commands — Use
Here, Use in Primary Windows, Use in Secondary Windows, Turn Off for Primary Windows,
Turn Off for Secondary Windows, New Profile, Turn Off for This Window's Role, Open
Profiles File, Edit, Duplicate, Rename, Delete, and Create Profiles File — which run
the bundled CLI (`agento.mjs models …`) and share the role-aware use/off path.
**Agento: Edit Model Profile** (Command Palette) picks a profile and opens the same
editor.

## Settings

- `agento.nodePath` selects the Node.js executable used for the bundled CLI.
- `agento.pluginRoot` names the Agento plugin clone for model profiles and the
  Session & Doctor `model-profile` check; empty uses `chat.pluginLocations`.
- `agento.chatModelPreselect` preselects the model for extension-dispatched chat
  commands (`off` by default): `local` sends `modelSelector: { vendor, id }` (an
  exact `vscode.lm` match), `copilot` sends `modelSelector: { id }` (the command's
  Copilot id), and `off` sends no selector — a log line and the window banner
  tooltip name the model to pick by hand. A value that does not match the session
  type has side effects documented in `docs/model-profiles.md`.
- `agento.refreshDebounceMs` controls the watcher debounce and cannot be less than
	3000 milliseconds.

The CLI modules under `cli/` are generated byte copies of the repository's
`scripts/` modules. Run `npm run copy-cli` after changing those sources. Every view
refresh is one `cli/agento.mjs dashboard --pr` call. In this
bundle, the CLI's `PLUGIN_ROOT` resolves to `extension/`; commands that return paths
to plugin prompt files are therefore informational and must not be used for command
dispatch by the extension.

## Development

Run `npm ci`, `npm run build`, `npm run test:unit`, `npm run test:electron`,
`npm run package`, or `npm run test:vsix` from this directory. Packaging validates
the VSIX runtime contents and confirms that VSCE's `extension/LICENSE.txt` entry is
byte-identical to the generated `extension/LICENSE` source. The VSIX smoke installs
the package into an isolated profile, activates it against a generated fixture, and
removes the profile afterward.