# Copilot harness: observed behavior

This document records what the Copilot (Agent Host) harness actually does, as
measured by the reproducible probe in `tests/harness-probe/` (see
[Reproduce](#reproduce)). It replaces the "unverified" documentation claims in
the `copilot-harness` initiative with recorded observations, so the later
members (`copilot-hook-compat`, `agents-copilot-models`, `agento-router-skill`,
`harness-install`, `dispatch-copilot-harness`) build against facts instead of
guesses. It changes no runtime behavior.

## Versions observed

- VS Code `1.141.0` (commit `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`, x64).
- Copilot Chat extension `0.69.0`, built-in (version read from
  `/usr/share/code/resources/app/extensions/copilot/package.json`; it is not in
  `code --list-extensions`).
- GitHub Copilot CLI: **not installed**. `command -v copilot` resolves to a POSIX
  shim that launches the extension's `copilotCLIShim.js` through the Code binary;
  `copilot --version` (stdin closed) prints "Cannot find GitHub Copilot CLI" and
  prompts `Install GitHub Copilot CLI? ['y/N']`, then exits without installing.
  `copilot plugin install` and `copilot plugin list` are therefore **unobserved**.

## Findings

| Question | Local (Session Target Local) | Copilot (Session Target Copilot) | Evidence | Member impact |
| --- | --- | --- | --- | --- |
| Does `chat.pluginLocations` load a plugin? | Yes. The probe plugin's hooks fire and its `/agento <name>` prompt commands shadow a same-named user skill. | Partially. The plugin's prompt commands are **not** loaded (nothing shadows the user skill), and the plugin's `PreToolUse` hook was invoked but its logger never ran. | [plugin `hooks.json`](../tests/harness-probe/plugin/hooks/hooks.json); `features/2026/10/harness-probe/evidence/step-2-7-plugin-sessions.png` | `harness-install`, `agento-router-skill` |
| Does `copilot plugin install` load a plugin? | — | Unobserved: the Copilot CLI is absent. | Roadmap step 2.6 | `harness-install` |
| Is a workspace `.github/hooks/*.json` (PascalCase, no `version`) discovered? | Yes. | Yes. | [Local SessionStart](../tests/harness-probe/fixtures/local/workspace-SessionStart-1.json), [Copilot SessionStart](../tests/harness-probe/fixtures/copilot/workspace-SessionStart-1.json) | `copilot-hook-compat` |
| Is a plugin `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` discovered and expanded? | Yes — the plugin hook runs and its env includes `CLAUDE_PLUGIN_ROOT`. | The hook is invoked (the model reports it errored) but its logger never runs, so the `${CLAUDE_PLUGIN_ROOT}` path did not resolve to the logger. | [Local plugin SessionStart](../tests/harness-probe/fixtures/local-plugin/plugin-SessionStart-1.json); [Copilot plugin run (workspace-only)](../tests/harness-probe/fixtures/copilot-plugin/workspace-PreToolUse-1.json) | `copilot-hook-compat`, `harness-install` |
| Which `tool_name` values arrive? | VS Code tool ids: `run_in_terminal`, `create_file`, `replace_string_in_file`. | Claude tool names: `Bash`, `Write`, `Read`, `Edit`, `Agent`, `tool_search_tool`. | [Local PreToolUse](../tests/harness-probe/fixtures/local/workspace-PreToolUse-1.json), [Copilot PreToolUse](../tests/harness-probe/fixtures/copilot/workspace-PreToolUse-1.json) | `copilot-hook-compat` |
| Which SessionStart output slot is read? | `hookSpecificOutput.additionalContext` (top-level `additionalContext` ignored). | Top-level `additionalContext` (nested ignored) — the opposite of Local. | step 2.2 and step 2.4 observations | `copilot-hook-compat` |
| Which PreToolUse decision slots are read? | `hookSpecificOutput.permissionDecision` (+ reason); top-level decision and ask ignored. | Both `hookSpecificOutput.permissionDecision` (+ reason) and top-level `permissionDecision`; top-level ask shows a hook card then runs. | [Local plugin run](../tests/harness-probe/fixtures/local-plugin/plugin-PreToolUse-1.json), [Copilot plugin run](../tests/harness-probe/fixtures/copilot-plugin/workspace-PreToolUse-1.json) | `copilot-hook-compat` |
| Does exit 2 fail closed? | Yes — "Hook denied tool execution" (reason dropped). | Yes — "hook exited with code 2". | step 2.2 and step 2.4 observations | `copilot-hook-compat` |
| Does `/agento <name> [args]` reach a user skill named `agento` (symlinked)? | No — the Agento plugin's real `/agento <name>` command shadows the user skill; args arrive as free text. | Yes — resolves to the symlinked `~/.copilot/skills/agento` as "Read skill · agento", with ARGUMENTS `delivery-status --probe-arg x` exactly. | [skill fixtures](../tests/harness-probe/skills/agento/SKILL.md); step 2.2 and 2.4 observations | `agento-router-skill`, `harness-install` |
| Can a subagent ask the user, and nest? | `vscode/askQuestions` works; a nested subagent has no subagent tool, so nesting is unavailable. | Subagent stalls ("Reasoning" 10+ min) — ask-user, nesting, and pin unobserved. | step 2.2 and 2.4 observations | `agento-router-skill`, `agents-copilot-models` |
| Do model pins apply, and in what format? | The agent pin (`Claude Opus 5.5 (copilot)`, the VS Code picker form) overrides the parent model; an unpinned agent inherits the parent model. | Unobserved (subagent stalled); the parent model field is absent from the SessionStart payload. | step 2.2 and 2.4 observations | `agents-copilot-models` |
| What does `workbench.action.chat.open {query, mode, attachFiles}` do in Copilot? | — | Fills the chat input with `/agento delivery-status`, attaches `delivery-status.md`, sets Agent mode, but does **not** submit; the Copilot input will not send a message that begins with a slash in this dispatch case. | step 2.4 observations | `dispatch-copilot-harness` |

Screenshots and raw observation notes live in the companion artifact repository
(`agento-docs`) under `features/2026/10/harness-probe/evidence/`; the table links
the sanitized fixtures committed in this repository.

## Hook input payload fields

All fields are snake_case in both harnesses. Fixture files are the sanitized
captures committed under `tests/harness-probe/fixtures/`.

### SessionStart

| Field | Local | Copilot |
| --- | --- | --- |
| `hook_event_name` | `"SessionStart"` | `"SessionStart"` |
| `session_id` | yes | yes |
| `timestamp` | yes (ISO 8601) | yes (ISO 8601) |
| `cwd` | yes | yes |
| `source` | `"new"` / `"resume"` | `"new"` / `"resume"` |
| `transcript_path` | yes | **no** |
| `model` | yes (e.g. `deepseek-v4-pro`) | **no** |
| `initial_prompt` | **no** | yes (the first user prompt) |

The Copilot harness replaces `transcript_path` + `model` with `initial_prompt`.

### PreToolUse

| Field | Local | Copilot |
| --- | --- | --- |
| `hook_event_name` | `"PreToolUse"` | `"PreToolUse"` |
| `session_id` | yes | yes |
| `timestamp` | yes | yes |
| `cwd` | yes | yes |
| `tool_name` | VS Code id: `run_in_terminal`, `create_file`, `replace_string_in_file` | Claude name: `Bash`, `Write`, `Read`, `Edit`, `Agent`, `tool_search_tool` |
| `tool_input` | object, VS Code shape (`{command, explanation, goal, mode}` or `{filePath, content}`) | object, Claude shape (`{command, description}` or `{path, file_text}` / `{path}` / `{path, old_str, new_str}`) |
| `tool_use_id` | yes | **no** |
| `transcript_path` | yes | **no** |

There is no `apply_patch` tool in either harness.

### Environment variables seen by the hook

- Local workspace hook: `VSCODE_*` variables plus `COPILOT_CLI_ENABLED_FEATURE_FLAGS`
  and `COPILOT_OTEL_FILE_EXPORTER_PATH`. The plugin-source hook additionally sees
  `CLAUDE_PLUGIN_ROOT` (so `${CLAUDE_PLUGIN_ROOT}` expands in Local).
- Copilot workspace hook: `COPILOT_CLI`, `COPILOT_HOME`, `COPILOT_PROJECT_DIR`,
  `COPILOT_*`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP`. There
  are no `VSCODE_*` variables and no `CLAUDE_PLUGIN_ROOT` in the workspace hook.

## Honored output shapes

| Event | Local reads | Copilot reads |
| --- | --- | --- |
| SessionStart | `hookSpecificOutput.additionalContext` | top-level `additionalContext` |
| PreToolUse decision | `hookSpecificOutput.permissionDecision` (+ `permissionDecisionReason`) | both `hookSpecificOutput.permissionDecision` (+ reason) and top-level `permissionDecision` |
| PreToolUse ask | ignored | top-level `permissionDecision: "ask"` shows a hook card, then the command runs under the session's permission mode (observed with "Manual permissions") |

Implication for `copilot-hook-compat`: a single hook can emit both shapes in one
object — top-level Copilot fields plus `hookSpecificOutput` for Local — because
each harness reads a disjoint set of keys and ignores the other's.

**Ask caveat.** A top-level `permissionDecision: "ask"` in Copilot shows a hook
card and then lets the tool run under the session's permission mode (observed with
"Manual permissions"); under auto-approve the tool is not stopped. `deny` verdicts
fail closed in both harnesses. The guard keeps its `ask` verdicts unchanged in both
harnesses; the weaker Copilot `ask` is a documented risk, not a behavior change.

## Exit-2 behavior

A `PreToolUse` hook that exits 2 fails closed in both harnesses:

- Local: the tool is blocked with the generic message "Hook denied tool execution";
  the hook's reason is dropped.
- Copilot: the tool is blocked with "Denied by preToolUse hook: hook exited with
  code 2"; the message names the exit code.

## Skill resolution with arguments

The probe installs two skills: `agento` (a symlink to
`tests/harness-probe/skills/agento`) and `agento-probe-copy` (a copy).

- **Local.** `/agento delivery-status --probe-arg x` did **not** reach
  `~/.copilot/skills/agento`: the installed Agento plugin's real `delivery-status`
  command ran instead, so in Local a plugin's `/agento <name>` namespace shadows a
  user skill named `agento`. Extra arguments arrive as free text.
  `/agento-probe-copy hello` resolved; the skill was attached as a prompt file and
  echoed `arguments=hello`.
- **Copilot.** Slash prompt files are not recognized; each `/name` goes through a
  "Read skill" step (each such turn took ~4 min). `/agento delivery-status
  --probe-arg x` resolved to the symlinked user skill and received ARGUMENTS
  `delivery-status --probe-arg x` exactly. The Agento plugin's prompt commands are
  not loaded in Copilot, so nothing shadows the skill. `/agento-probe-copy hello`
  received ARGUMENTS `hello`.

So the router skill must be a user-level skill (not a plugin skill) to keep the
canonical `/agento <name>` spelling, and the direct-copy and symlinked variants
both resolve with the full argument tail in Copilot.

## Subagents

- **Local.** `probe-pinned` (pinned to `Claude Opus 5.5 (copilot)`) reports
  `Claude Opus 5.5` as its model even when the parent is a different model — the
  agent's model pin overrides the parent. `probe-unpinned` (no `model:`) inherits
  the parent model. `vscode/askQuestions` works in both and the user's answer
  reaches the subagent. A nested subagent has no subagent tool, so **nesting is
  unavailable** in Local.
- **Copilot.** The subagent opened its own read-only chat tab and sat at
  "Reasoning" for 10+ minutes with no tool call and no question; the user stopped
  it. Ask-user, nesting, and model pins in Copilot are therefore **unobserved**.

Implication for `agento-router-skill` (decision 3): an orchestrating agent such as
the Autopilot cannot run as a subagent and still spawn Builder/Reviewer subagents.
The inline fallback remains the path for interactive/orchestrating agents; the
delivery that consumes this finding records the user's approval.

## Dispatch

The Agento extension dashboard dispatches through
`workbench.action.chat.open` with `{ query, mode, attachFiles }`. In a Copilot
session this fills the chat input with `/agento delivery-status`, attaches
`delivery-status.md` (the command file), and sets Agent mode — but it does **not**
submit, and the Copilot chat input will not let the user send a message that
begins with a slash in this dispatch case. Typed `/agento …` messages do send when
entered normally. `dispatch-copilot-harness` owns this gap.

## Reproduce

From the repository root, on Node ≥ 20:

```sh
node tests/harness-probe/probe.mjs setup
node tests/harness-probe/probe.mjs status
code --new-window <workspace path printed by setup>
```

In the probe window, run `tests/harness-probe/PROMPTS.md` once with the chat
Session Target set to Local and once with Session Target set to Copilot, then:

```sh
node tests/harness-probe/probe.mjs collect --harness local
node tests/harness-probe/probe.mjs collect --harness copilot
node tests/harness-probe/probe.mjs collect --harness local-plugin
node tests/harness-probe/probe.mjs collect --harness copilot-plugin
node tests/harness-probe/probe.mjs teardown
```

The plugin runs additionally require registering `tests/harness-probe/plugin` in
`chat.pluginLocations` (a manual step: register, reload, run prompts 1–2, remove,
reload). `collect` has no per-session filter; when both plugin sessions are run
into one log dir, partition the files by timestamp before each `collect`, as
recorded in roadmap step 2.8.

The test suite asserts the logger, sanitizer, and fixture invariants, and that
every relative link in this document resolves:

```sh
node --test tests/harness-probe/probe.test.mjs tests/customizations.test.mjs
```
