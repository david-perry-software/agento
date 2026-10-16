# Model profiles

VS Code honors a `model:` frontmatter field on custom agents (`.agent.md`) and prompt
files (`.prompt.md`): a single model name, or a prioritized list the picker tries in
order. A **model profile** is a named set of such pins for the Agento agents and the
commands that run on the built-in agent — for example a strong model for planning and
review and a cheaper one for status and doctor commands. Profiles are defined once per
user and applied to the plugin clone by the Agento CLI; nothing about them is
committed.

## The profiles file

`~/.config/agento/model-profiles.json` — or `$XDG_CONFIG_HOME/agento/model-profiles.json`
when `XDG_CONFIG_HOME` is set; `AGENTO_CONFIG_HOME` replaces the directory (tests use
it). `agento.mjs models init` (or `/agento models init`) creates it from
`templates/model-profiles.json` when it does not exist yet.

```json
{
  "copilotModels": {
    "Claude Opus 5.5 (copilot)": "claude-opus-5.5",
    "DeepSeek V4 Pro (deepseek)": "deepseek/deepseek-v4-pro"
  },
  "profiles": {
    "mixed": {
      "description": "Strong model for planning and review, a cheaper one elsewhere",
      "default": "GPT-5 mini (copilot)",
      "agents": {
        "planner": "Claude Opus 4.5 (copilot)",
        "reviewer": ["Claude Opus 4.5 (copilot)", "GPT-5 (copilot)"],
        "architect": "Claude Opus 4.5 (copilot)"
      },
      "prompts": {
        "delivery-status": "GPT-5 mini (copilot)"
      }
    }
  }
}
```

- Profile names match `[a-z0-9-]+`. Each profile may carry `description`, `default`,
  `agents`, and `prompts`; any other key is an error.
- The top level carries `profiles` and an optional `copilotModels`; any other
  top-level key is an error. `copilotModels` maps a qualified picker name to the
  Copilot `task` model id for the same model — a bare id for Copilot-hosted models
  or `<vendor>/<id>` for bring-your-own-key models, for example
  `"Claude Opus 5.5 (copilot)"` → `"claude-opus-5.5"` and
  `"DeepSeek V4 Pro (deepseek)"` → `"deepseek/deepseek-v4-pro"`. Each value is
  validated like a model value (non-empty string, no `<`/`>` placeholder, no
  control character); an unknown shape invalidates the whole file. The map never
  changes a written `model:` line — it only feeds `models pins`' `copilotModel`
  and the missing-alias warning (see below).
- A value is a model name or a non-empty list of model names in the qualified form
  `<picker name> (<vendor>)`, for example `Claude Opus 4.5 (copilot)` or
  `DeepSeek V4 Pro (deepseek)`. VS Code resolves a bare picker name only for some
  Copilot models; a model from another provider (a language-model extension) is
  silently ignored unless qualified, and VS Code logs
  `models "<name>" not found. Use format "<name> (<vendor>)"`. The vendor is the
  part before `/` in the model id (`deepseek/deepseek-v4-pro` → `deepseek`). Names
  are otherwise passed through verbatim; a name containing `<` or `>` (an unfilled
  template placeholder) or a control character is rejected. A name without a
  `(vendor)` suffix is accepted but warned about (see the vendor-suffix warning
  below).
- `agents` keys are aliases: `planner`, `builder`, `reviewer`, `autopilot`,
  `mechanic`, `architect`.
- `prompts` keys are command names (`doctor`, `ship`, …) of commands that run on the
  built-in agent.

## Resolution

| File | Model |
|---|---|
| Agent | `agents.<alias>`, else `default`, else no `model:` line |
| Handoff item (`handoffs:` entry) | The target agent's pin, first entry of a list, else no `model:` line |
| Prompt on a custom agent (`/agento build-feature`, `/agento new-feature`, `/agento ap`, …) | The agent's model; a `prompts.<name>` entry for it is an error |
| Prompt on the built-in agent (`agent: "agent"` or no `agent:`) | `prompts.<name>`, else `default`, else no `model:` line |

`copilotModels` does not participate in this table: it aliases a picker name to the
Copilot `task` model id **after** resolution so `models pins` can report it. It never
changes which `model:` line a file gets — writing the Copilot id into a `model:`
line was found not to help (see [Subagents and handoffs](#subagents-and-handoffs)).

A `prompts` key with no matching `.github/prompts/<name>.prompt.md` is an error.
Each prompt's plugin-mode mirror `commands/<name>.md` receives the same bytes as the
prompt.

`/agento start-session` is a thin formatter: one `agento.mjs start-session` call
does the window check, fetch, worktree adds, and window open, and the model only
maps the JSON to the receipt and report. Pin it to a fast model (for example
`"prompts": { "start-session": "<fast model>" }`); a slow reasoning model buys
nothing here. The dashboard's New Plan and start-session play buttons call the CLI
directly and use no model at all.

A `model:` line in a `commands/<name>.md` mirror is a no-op for plugin commands:
the dashboard dispatches a command by switching chat to the command's `agent:`
and the agent's own `model:` then applies. A `prompts.<name>` pin takes effect
only where `.github/prompts/<name>.prompt.md` is loaded (workspace mode). The
mirrors keep receiving the same bytes so `models apply` and the byte-equality test
are unchanged.

## Applying and clearing

```text
node <agento-root>/scripts/agento.mjs models [list | pins | show <name> | apply <name> | adopt | clear | init] [--plugin-root <dir>]
```

`/agento models …` runs the same verbs from chat, and the extension's
*Agento: Select Model Profile* command offers them as a quick pick. The plugin root
defaults to the clone the CLI runs from; pass `--plugin-root` for another one.

- `apply <name>` writes one `model:` line into every agent, prompt, and mirror (after
  `argument-hint:`, else after `description:`), and a nested `model:` line into every
  `handoffs:` item of the planner, builder, and reviewer — the handoff target's pin,
  first entry when it is a list — after the item's last key. It removes the line
  where the profile resolves to nothing, records every file's resolved pins as the
  state of a local git clean/smudge filter (see [The pin filter](#the-pin-filter)),
  so the clone still looks clean to `/agento start-session` and `/agento quick-fix`
  and every pull, merge, and switch keeps the pins. It refuses (`status: "dirty"`,
  exit 3) while any of those files carries a change git would see — a body edit, or a
  `model:` line other than the recorded pin (`git restore <file>` brings the recorded
  pin back).
- `adopt` records the pins the files carry right now as the filter state, without
  changing a byte — the migration path for a clone whose pins match no profile
  (`active: custom`). It refuses linked worktrees and body edits like `apply`.
- `clear` removes every `model:` line, the filter (its config section, its attribute
  block, and `<common-dir>/agento/`), and any legacy skip-worktree bit; the files
  equal `HEAD` afterwards.
- All three report `changed[]` and are idempotent: a repeat reports `changed: []`.
- Every verb reports `active` — `null` (nothing pinned), the name of the profile the
  files match, or `custom` (pins that match no profile: hand-edited, or the profile
  changed after it was applied) — plus `filter { installed, config, attributes,
  state, stateFile, script, scriptCurrent, unrecorded[] }` (`null` outside git),
  `legacySkipWorktree` (files still flagged by an older `apply`; `skipWorktree` is a
  deprecated alias kept for one release), `dirty`, and `hint`. There is no journal;
  the state is read from the files, the git config, and the pin state file.

`models pins` (CLI-only, for the Autopilot) reports each agent's current pin read
from the plugin root's files: `pins: { planner, builder, reviewer, autopilot,
mechanic, architect }`, each `{ name, file, model, subagentModel }` where `model` is
the parsed pin (a name, a list, or `null`) and `subagentModel` the name or its first
entry. The Autopilot passes the Builder's and Reviewer's `subagentModel` as the
`runSubagent` `model` when it invokes them.

The BYOK tier warning: when `autopilot` is pinned to a non-`copilot` (bring-your-own
key) model while `builder` or `reviewer` pins a `copilot` model, `models
show`/`apply`/`pins` report a `warnings[]` entry naming the pins and the fix — pin
`autopilot` at least as high as the highest-tier model it delegates to. `apply` still
succeeds. `agento.mjs doctor`'s `model-profile` check returns `warn` with the same
detail when the applied pins trigger it. Unqualified names give no tier warning
because the vendor is unknown.

The vendor-suffix warning: a value without a `(vendor)` suffix gets one
`warnings[]` entry, `model values without a (vendor) suffix: …`, naming each
distinct unqualified value once with every place it is used (`default`, an agent
alias, `prompts.<name>`; list entries included). `models show`/`apply` check the
profile's own entries, `models pins` the agents' current pins. `apply` still
succeeds (exit 0) and writes the pins. `agento.mjs doctor`'s `model-profile` check
returns `warn` when an applied, named profile pins an unqualified value; when the
BYOK tier warning applies too, the detail joins both with `; `.

The missing-Copilot-alias warning: when `copilotModels` is present and a pinned
agent's first picker entry has no entry in it, `models show`/`apply`/`pins` report
`agent pins without a Copilot alias: …` naming each such agent and its picker
name. `apply` still succeeds (exit 0). `agento.mjs doctor`'s `model-profile` check
returns `warn` with the same detail; when the BYOK tier or vendor-suffix warning
applies too, the detail joins them with `; `.

Run *Developer: Reload Window* if the model picker does not reflect a change.

## The pin filter

`apply` and `adopt` install a git clean/smudge filter named `agento-models` in the
clone:

- `<common-dir>/agento/` holds `model-pins.json` (each target file's resolved
  top-level and handoff pins; no profile name) and copies of `model-filter.mjs` and
  `model-profiles.mjs`, refreshed on every apply.
- The clone's local config sets `filter.agento-models.clean` and `.smudge` to
  `node "$(git rev-parse --path-format=absolute --git-common-dir)/agento/model-filter.mjs" clean|smudge %f`
  and `filter.agento-models.required` to `true`.
- A marker-delimited block in `<common-dir>/info/attributes` assigns the filter to
  `/.github/agents/*.agent.md`, `/.github/prompts/*.prompt.md`, and `/commands/*.md`.

`clean` strips exactly the recorded pins, so git compares and commits pin-free
content; `smudge` writes the recorded pins back whenever git rewrites a file. A
different `model:` value or any other edit passes through, so git still shows it.
With `required=true` a missing or broken filter makes git refuse the operation, so a
pin can never reach a commit. Needs git ≥ 2.31 (`apply` and `adopt` refuse older
versions with `status: "git-too-old"`) and `node` on git's `PATH`.

## Updating the clone

A `git pull`, merge, `switch`, or `stash` in a pinned clone needs no extra step: git
sees no local change in a pinned file, rewrites it, and the filter puts the same pins
back. `/agento ship`, `agento.mjs publish-pr --merge`, and `/agento finish-freehand`
fast-forward a pinned clone the same way.

A new agent or prompt that arrives with an update has no recorded pin and stays
unpinned; `filter.unrecorded` lists it and `active` may read `custom` until you run
`models apply <name>` again. Every `models` output says so as `hint`.

Clones pinned by an older Agento carry legacy skip-worktree bits (reported as
`legacySkipWorktree`), and a pull that touches one of those files still stops.
Migrate once: `models apply <name>` re-pins a profile and clears the bits; `models
adopt` keeps the current pins exactly (the route for `active: custom`).

`agento.mjs doctor` reports the state as its `model-profile` check: `ok` with nothing
pinned or a named profile applied on a healthy filter; `warn` for an invalid profiles
file, `custom` pins, the BYOK tier conflict, or unqualified pins described above,
and for legacy skip-worktree bits, pins without a healthy filter (missing config,
attribute block, or state), a copied filter script older than the CLI, or non-empty
`filter.unrecorded` — each with the command that fixes it.

## Developing Agento

Profiles apply to the registered plugin clone (`chat.pluginLocations`). The filter's
config and attributes live in the clone's common git directory, so every linked
worktree of the clone — an Agento development worktree included — inherits the pins
whenever git writes a target file there (a new worktree gets them at checkout; an
older one as git rewrites each file). Commits from any of them are cleaned and carry
no `model:` line; `tests/customizations.test.mjs` fails if one is ever committed.
`apply` and `adopt` refuse a plugin root that is a linked worktree (`status:
"worktree"`, exit 3, naming the clone as `primaryCheckout`); `clear` still runs
there to unpin that worktree's files and leaves the clone's shared filter alone.
Editing an agent or prompt in a pinned clone is safe: `git status` shows your edit,
not the pin.

## Subagents and handoffs

An agent's `model:` pin applies on direct selection, and was observed to apply to
Local subagents regardless of the caller's model in the tested runs. Observed on
VS Code 1.136 with the Local harness: the 🔍 Agento Reviewer subagent ran on its
own pin, `Claude Fable 5.1`, for every caller — the Autopilot on a
bring-your-own-key `DeepSeek V4 Pro (deepseek)` model, a built-in Agent on
`Claude Opus 5.5 (copilot)`, and a built-in Agent on the same bring-your-own-key
`DeepSeek V4 Pro (deepseek)` model. No fallback to the caller's model and no tier
refusal were reproduced.

Copilot-harness (Agent Host, measured on VS Code 1.141.0 / Copilot Chat 0.69.0):
an agent selected directly in a Copilot session runs on the **session's** model,
not its `model:` pin — the picker form, list form, BYOK form, a specific model, and
Auto all ignore the pin (`finding: picker-rejected`). The pin format is accepted by
the editor (the `model:` hover resolves `<name> (<vendor>)` and states the field is
supported by the Copilot harness), but it is not applied to directly selected
agents; whether it applies only to `task`-tool subagents, or this is a bug, is not
determined. The per-subagent model in Copilot is set through the `task` tool's
`model` parameter instead, which is what `copilotModels` and `models pins`'
`copilotModel` feed — so in a Copilot session the user must set the model picker
themselves.

As hardening, Agento now passes explicit `runSubagent`/handoff models: `models
apply` writes a nested `model:` line into every `handoffs:` item (the target's
resolved pin, first entry of a list), and the Autopilot passes the target's pin
as the `runSubagent` `model` when it invokes the Builder or Reviewer.

The handoff button honours that nested pin. Observed on VS Code 1.136.0 with the
Local harness, in a non-Agento workspace: after a 📋 Agento Planner reply,
**Build in this worktree** prefilled the prompt with 🔨 Agento Builder selected
and the model picker on the builder pin, `DeepSeek V4 Pro (deepseek)`, not the
Planner's `Claude Opus 5.5 (copilot)`.

## Limits

- One profile is active per clone (machine-wide, last apply wins); there are no
  per-project profiles.
- From-source and Copilot CLI installs (install options B and C) are replaced on
  update; apply the profile again afterwards.
