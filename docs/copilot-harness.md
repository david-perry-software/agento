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
| Is a plugin `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` discovered and expanded? | Yes — the plugin hook runs and its env includes `CLAUDE_PLUGIN_ROOT`. | Yes — the token expands to the staged plugin copy (`~/.config/Code/agentPlugins/<name>/<hash>`); the diagnostic captures show `cwd`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, and `COPILOT_PLUGIN_ROOT` all point there and `command -v node` succeeds. The earlier "errored" run was the probe's own `../log-payload.mjs` escaping the staged root — not the token and not a missing node. | [Copilot plugin SessionStart diagnostic](../tests/harness-probe/fixtures/copilot-plugin/plugin-SessionStart-1.json); [Copilot plugin PreToolUse diagnostic](../tests/harness-probe/fixtures/copilot-plugin/plugin-PreToolUse-1.json) | `copilot-hook-compat`, `harness-install` |
| Which `tool_name` values arrive? | VS Code tool ids: `run_in_terminal`, `create_file`, `replace_string_in_file`. | Claude tool names: `Bash`, `Write`, `Read`, `Edit`, `Agent`, `tool_search_tool`. | [Local PreToolUse](../tests/harness-probe/fixtures/local/workspace-PreToolUse-1.json), [Copilot PreToolUse](../tests/harness-probe/fixtures/copilot/workspace-PreToolUse-1.json) | `copilot-hook-compat` |
| Which SessionStart output slot is read? | `hookSpecificOutput.additionalContext` (top-level `additionalContext` ignored). | Top-level `additionalContext` (nested ignored) — the opposite of Local. | step 2.2 and step 2.4 observations | `copilot-hook-compat` |
| Which PreToolUse decision slots are read? | `hookSpecificOutput.permissionDecision` (+ reason); top-level decision and ask ignored. | Both `hookSpecificOutput.permissionDecision` (+ reason) and top-level `permissionDecision`; top-level ask shows a hook card then runs. | [Local plugin run](../tests/harness-probe/fixtures/local-plugin/plugin-PreToolUse-1.json), [Copilot plugin run](../tests/harness-probe/fixtures/copilot-plugin/workspace-PreToolUse-1.json) | `copilot-hook-compat` |
| Does exit 2 fail closed? | Yes — "Hook denied tool execution" (reason dropped). | Yes — "hook exited with code 2". | step 2.2 and step 2.4 observations | `copilot-hook-compat` |
| Does `/agento <name> [args]` reach a user skill named `agento` (symlinked)? | No — the Agento plugin's real `/agento <name>` command shadows the user skill; args arrive as free text. | Yes — resolves to the symlinked `~/.copilot/skills/agento` as "Read skill · agento", with ARGUMENTS `delivery-status --probe-arg x` exactly. | [skill fixtures](../tests/harness-probe/skills/agento/SKILL.md); step 2.2 and 2.4 observations | `agento-router-skill`, `harness-install` |
| Can a subagent ask the user, and nest? | `vscode/askQuestions` works and the answer returns within the same turn; a nested subagent runs on its own agent pin and its own `vscode/askQuestions` also works; a nested subagent has no subagent tool of its own, so deeper nesting is unavailable. | The subagent tool is `task` (no ask-user tool); `probe-unpinned` invoked `probe-pinned` via `task` and it completed in 21 s — the earlier 10+ min stall did not recur. | step 2.2, 2.4, and 1.2 observations | `agento-router-skill`, `agents-copilot-models` |
| Do model pins apply, and in what format? | The agent pin (`Claude Opus 5.5 (copilot)`, the VS Code picker form) overrides the parent model; an unpinned agent inherits the parent model. | **`finding: picker-rejected`** — an agent selected directly in a Copilot session runs on the session's model, not its `model:` pin (picker, list, BYOK, specific model, or Auto are all ignored); the pin format itself is accepted (see [Agents and models](#agents-and-models)). The parent model field is absent from the SessionStart payload. | step 2.2, 2.4, and 1.2 observations | `agents-copilot-models` |
| What does `workbench.action.chat.open {query, mode, attachFiles}` do in Copilot? | — | Fills the chat input with `/agento delivery-status`, attaches `delivery-status.md`, sets Agent mode, but does **not** submit; the Copilot input will not send a message that begins with a slash in this dispatch case. | step 2.4 observations | `dispatch-copilot-harness` |

Screenshots and raw observation notes live in the companion artifact repository
(`agento-docs`) under `features/2026/10/harness-probe/evidence/`; the table links
the sanitized fixtures committed in this repository.

## Agents and models

Measured 2026-10-16 (VS Code 1.141.0 / Copilot Chat 0.69.0) by selecting each
probe agent directly from the agent picker in a Copilot session. Evidence lives in
the companion repository under
`features/2026/10/agents-copilot-models/evidence/step-1-2-*.png`.

- **Accepted model form.** The editor hover on an agent's `model:` frontmatter
  resolves the picker form (`Name: Claude Opus 5.5`, `Family: claude-opus-5.5`,
  `Vendor: copilot`) and states the field "is supported by the GitHub Copilot
  harness" — so the `<picker name> (<vendor>)` format is valid input.
- **Directly selected agents ignore the pin (`finding: picker-rejected`).**
  Selecting a probe agent from the picker in a Copilot session did not change the
  model picker, and each agent ran on the session's model (the chat reply footer),
  never on its `model:` pin — picker form (`Claude Opus 5.5 (copilot)`), list form
  (`["Claude Opus 5.5 (copilot)", "claude-opus-5.5"]`), BYOK form
  (`DeepSeek V4 Pro (deepseek)`), a specific model, and Auto (`Auto` routed a task
  to GPT-6 Luna) all behaved the same. Whether the pin applies only to `task`-tool
  subagents, or this is a bug, was not determined. ~7 min per turn.
- **BYOK result.** The `DeepSeek V4 Pro (deepseek)` pin was ignored for a directly
  selected agent exactly like the Copilot pins; the agent ran on the session model.
- **Tool set.** The Copilot tools observed (the same for every agent regardless of
  its `tools:` list): `bash`, `create`, `edit`, `list_agents`, `list_bash`,
  `read_agent`, `read_bash`, `skill`, `sql`, `stop_bash`, `task`, `view`,
  `write_agent`; a GPT-routed turn additionally showed `functions.*` plus
  `apply_patch` and `multi_tool_use.parallel`. There is **no ask-user tool and no
  browser tool**, so `vscode/askQuestions` and `browser` are unavailable in
  Copilot — the §10 `ask-questions` and `browser` fallbacks apply there. A
  question asked as plain chat text works: the agent ends its turn and the user's
  reply arrives as a new turn (~3–4 min round trip).
- **Subagent model parameter.** The Copilot subagent tool is `task`; its optional
  `model` parameter takes bare ids for Copilot-hosted models (35 listed in the
  task-models screenshots, e.g. `claude-opus-5.5`, `gpt-5.6-luna`, …) and
  `<vendor>/<id>` for BYOK models (`deepseek/deepseek-v4-pro`, …). The per-subagent
  model in Copilot is therefore set through `task`'s `model`, not the agent pin.
- **Caveats.** The model's self-reported `model=` line is not evidence (agents
  cannot see their runtime model; some echo their own frontmatter) — only the chat
  reply footer and the model picker count. A confound: Copilot loaded user-level
  Agento instructions into the probe workspace (replies mentioned
  `ask_user`/`openBrowserPage` and ended with an Agento `next:` line), most likely
  from the user's installed agento-plugin; it does not affect the model result.
  Local runs showed a "Warning from Session Start hook" (a probe-workspace side
  effect, not a Copilot finding).

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

## Live checks in the Agento clone (copilot-hook-compat)

The `copilot-hook-compat` delivery ran the guard live in a Copilot chat in the
Agento worktree. The first run (roadmap step 4.2) failed: the SessionStart hook
injected the `Agento CLI:` line, but the PreToolUse guard did not fire — a
`git push origin main --dry-run` ran ("Everything up-to-date") and
`.github/hooks/x.json` was created with no approval card. The re-run (roadmap
step 6.2, with the opt-in guard diagnostic live) passed all three prompts: the
context line was present, the push was denied ("Direct commits/pushes to main are
forbidden; use a work branch and a pull request."), and the hook-file edit asked
("Modifying a protected hook file; approve this specific change?") and was denied
with no file created.

The opt-in diagnostic log (`/tmp/agento-guard-debug.log`) recorded the 6.2 run:
one `entry`+`decision` pair per tool call — `Bash "git push origin main --dry-run"`
→ deny and `Write ".github/hooks/x.json"` → ask — each with `COPILOT_CLI=1` set and
no `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT`/`COPILOT_PLUGIN_ROOT`, i.e. the workspace hook
fired once and there was no plugin-mode duplicate run. The `Bash`/`tool_input.command`
and `Write`/`tool_input.path` shapes are exactly what `decide()` normalizes.

Diagnosis (roadmap 6.3): the exact trigger of the 4.2 failure cannot be proven —
4.2 predates the diagnostic and left no PreToolUse log. The most likely cause is a
stale Copilot session/hook state right after the probe plugin/skill cleanup and
settings changes: SessionStart fired (it binds at chat creation) while PreToolUse
was not yet effective, and 6.2 passed after a full window reload. The opt-in
diagnostic does not alter the verdict path, so the passing 6.2 run reflects the
committed guard code under a fresh session. No code fix was needed. The screenshots
are the companion repository's `features/2026/10/copilot-hook-compat/evidence/`
`step-6-2-copilot-capture-{1,2,3}.png` and `step-4-2-copilot-clone-{1,2}.png`.

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
- **Copilot.** The subagent tool is `task` (no ask-user tool, no browser tool).
  `probe-unpinned` invoked `probe-pinned` via `task` and it completed in 21 s — the
  earlier "Reasoning" 10+ min stall did not recur. The nested run's model was not
  distinguishable (parent and pin were both `Claude Opus 5.5`). The `task` tool's
  `model` parameter and the directly-selected-agent pin finding are in
  [Agents and models](#agents-and-models).

Implication for `agento-router-skill`: a Copilot subagent is launched with the
`task` tool (which has no ask-user tool and takes an optional `model` parameter),
and an agent selected directly in a Copilot session ignores its `model:` pin and
runs on the session's model. The router skill now implements this: Builder and
Reviewer run as subagents through `task` (Copilot) or `runSubagent` (Local) with
their model pin passed as the tool's `model`, while Planner, Architect, Mechanic,
and Autopilot run inline (see [Router skill](#router-skill)).

## Router skill

The `/agento <name> [args]` router lives at `skills/agento/SKILL.md` — a
user-level skill named `agento`, not a plugin skill, so nothing shadows it in
Copilot sessions. Until `harness-install` automates the link, install it by hand:

```sh
ln -s <clone>/skills/agento ~/.copilot/skills/agento
```

The skill parses the command name from the arguments, applies the canonical
spelling redirect rule, reads `commands/<name>.md`, and dispatches by that file's
`agent:` frontmatter:

| `agent:` | Mode |
| --- | --- |
| missing or `agent` | inline |
| `📋 Agento Planner`, `🏛️ Agento Architect`, `🛠️ Agento Mechanic`, `🤖 Agento Autopilot` | inline, as that agent |
| `🔨 Agento Builder`, `🔍 Agento Reviewer` | subagent |

Phase 2 live results (2026-10-17), with the skill linked to
`~/.copilot/skills/agento` and `disable-model-invocation: true`:

- **Copilot — all four checks reached the router** ("Read skill · agento"):
  `/agento delivery-status` printed `Receipt: accepted delivery-status:main:6ee4bdd`
  and the session report; a `delivery-status` spelling with a `.prompt` suffix (the
  old form the redirect rule strips) printed the redirect sentence and ran
  delivery-status; `/agento not-a-command` listed all 25
  `/agento <name>` names with no receipt; `/agento new-feature router smoke test`
  ran the Planner up to its clarifying questions.
- **Redirect sentence placement.** The redirect sentence is printed, but Copilot
  places it inside the collapsed "Completed N steps" block rather than in the
  final reply text.
- **Structured ask-user card.** In Copilot the Planner's clarifying question
  rendered as a structured ask-user card — numbered options with "(Recommended)",
  a custom-answer field, and a Submit button — contradicting the "no ask-user
  tool" finding elsewhere in this document (that finding concerns the `task`
  subagent tool, not an inline run).
- **Missing new-feature receipt.** The new-feature check showed no visible
  `Receipt: accepted new-feature:…` line before the question — the Planner
  summarised "Preflight passed …" instead. Fixed in step 2.9 (the skill now
  requires the dispatched command's §9 receipt line printed verbatim before any
  question or other output); re-checked in step 2.10 (confirmed).
- **Local takeover.** With the link installed, Local routes `/agento <name>`
  through the router skill instead of the plugin prompt command — the reverse of
  the harness-probe finding — so step 2.6's "no Read skill · agento" expectation
  did not hold. The output was correct. Lost model switching (the command file's
  profile-applied prompt `model:` and the agent-mode/pin switch for Planner,
  Architect, Mechanic, and Autopilot, which run inline) is a known gap for
  `harness-install` and `harness-docs`; Builder/Reviewer pins survive through
  `runSubagent` + `subagentModel`.
- **Settled value.** `disable-model-invocation: true` is settled: every Copilot
  check reached the router with it, so steps 2.4/2.5 (flip to `false` and
  re-check) were obsolete.
- **Copilot turns are slow** (~12m 8s for delivery-status, ~4m 11s for the
  redirect, ~8s for the unknown command).
- **Step 2.10** (re-check that the new-feature receipt line appears before the
  question): confirmed 2026-10-17 — the receipt line
  `Receipt: accepted new-feature:plan-20261016-191841:6ee4bdd` is now printed
  verbatim before the structured clarifying-question card.

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
