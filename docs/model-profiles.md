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
node <agento-root>/scripts/agento.mjs models [list | pins | show <name> | apply <name> | clear | init] [--plugin-root <dir>]
```

`/agento models …` runs the same verbs from chat, and the extension's
*Agento: Select Model Profile* command offers them as a quick pick. The plugin root
defaults to the clone the CLI runs from; pass `--plugin-root` for another one.

- `apply <name>` writes one `model:` line into every agent, prompt, and mirror (after
  `argument-hint:`, else after `description:`), and a nested `model:` line into every
  `handoffs:` item of the planner, builder, and reviewer — the handoff target's pin,
  first entry when it is a list — after the item's last key. It removes the line
  where the profile resolves to nothing, and marks each pinned file
  `git update-index --skip-worktree` so the clone still looks clean to
  `/agento start-session` and `/agento quick-fix`. It refuses (`status: "dirty"`,
  exit 3) while any of those files differs from `HEAD` beyond its `model:` lines —
  skip-worktree would hide such edits.
- `clear` removes every `model:` line and every skip-worktree bit it set.
- Both report `changed[]` and are idempotent: a repeat reports `changed: []`.
- Every verb reports `active` — `null` (nothing pinned), the name of the profile the
  files match, or `custom` (pins that match no profile: hand-edited, or the profile
  changed after it was applied). There is no journal; the state is read from the
  files.

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

Run *Developer: Reload Window* if the model picker does not reflect a change.

## Updating the clone

A pinned file is a local modification hidden by skip-worktree. A `git pull` or merge
that changes one stops with "Your local changes to the following files would be
overwritten" and leaves everything intact. Update in three steps:

```text
node scripts/agento.mjs models clear
git pull
node scripts/agento.mjs models apply <name>
```

Every `models` output repeats this as `hint`, and `agento.mjs doctor` reports the
state as its `model-profile` check: `ok` with nothing pinned or a named profile
applied, `warn` for an invalid profiles file, `custom` pins, the BYOK tier
conflict, or unqualified pins described above.

## Developing Agento

Profiles apply to the registered plugin clone (`chat.pluginLocations`). A worktree
window of the Agento repository loads its own workspace `.github/agents/` and
`.github/prompts/`, which stay unpinned: `apply` refuses a plugin root that is a
linked worktree (`status: "worktree"`, exit 3, naming the clone as
`primaryCheckout`), while `clear` still runs there to unpin it.
`tests/customizations.test.mjs` fails if a `model:` line is ever committed. Clear the
profile before editing an agent or prompt in the clone — skip-worktree hides your
edits from `git status` — and apply it again afterwards.

## Subagents and handoffs

An agent's `model:` pin applies on direct selection, and was observed to apply to
Local subagents regardless of the caller's model in the tested runs. Observed on
VS Code 1.136 with the Local harness: the 🔍 Agento Reviewer subagent ran on its
own pin, `Claude Fable 5.1`, for every caller — the Autopilot on a
bring-your-own-key `DeepSeek V4 Pro (deepseek)` model, a built-in Agent on
`Claude Opus 5.5 (copilot)`, and a built-in Agent on the same bring-your-own-key
`DeepSeek V4 Pro (deepseek)` model. No fallback to the caller's model and no tier
refusal were reproduced.

Copilot-harness (Agent Host) behavior is unverified.

As hardening, Agento now passes explicit `runSubagent`/handoff models: `models
apply` writes a nested `model:` line into every `handoffs:` item (the target's
resolved pin, first entry of a list), and the Autopilot passes the target's pin
as the `runSubagent` `model` when it invokes the Builder or Reviewer.

## Limits

- One profile is active per clone (machine-wide, last apply wins); there are no
  per-project profiles.
- From-source and Copilot CLI installs (install options B and C) are replaced on
  update; apply the profile again afterwards.
