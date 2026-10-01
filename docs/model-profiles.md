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
- A value is a model name or a non-empty list of model names, written exactly as the
  chat model picker shows them. Names are passed through verbatim; a name containing
  `<` or `>` (an unfilled template placeholder) or a control character is rejected.
- `agents` keys are aliases: `planner`, `builder`, `reviewer`, `autopilot`,
  `mechanic`, `architect`.
- `prompts` keys are command names (`doctor`, `ship`, …) of commands that run on the
  built-in agent.

## Resolution

| File | Model |
|---|---|
| Agent | `agents.<alias>`, else `default`, else no `model:` line |
| Prompt on a custom agent (`/agento build-feature`, `/agento new-feature`, `/agento ap`, …) | The agent's model; a `prompts.<name>` entry for it is an error |
| Prompt on the built-in agent (`agent: "agent"` or no `agent:`) | `prompts.<name>`, else `default`, else no `model:` line |

A `prompts` key with no matching `.github/prompts/<name>.prompt.md` is an error.
Each prompt's plugin-mode mirror `commands/<name>.md` receives the same bytes as the
prompt.

## Applying and clearing

```text
node <agento-root>/scripts/agento.mjs models [list | show <name> | apply <name> | clear | init] [--plugin-root <dir>]
```

`/agento models …` runs the same verbs from chat, and the extension's
*Agento: Select Model Profile* command offers them as a quick pick. The plugin root
defaults to the clone the CLI runs from; pass `--plugin-root` for another one.

- `apply <name>` writes one `model:` line into every agent, prompt, and mirror (after
  `argument-hint:`, else after `description:`), removes it where the profile resolves
  to nothing, and marks each pinned file `git update-index --skip-worktree` so the
  clone still looks clean to `/agento start-session` and `/agento quick-fix`. It
  refuses (`status: "dirty"`, exit 3) while any of those files differs from `HEAD`
  beyond its `model:` line — skip-worktree would hide such edits.
- `clear` removes every `model:` line and every skip-worktree bit it set.
- Both report `changed[]` and are idempotent: a repeat reports `changed: []`.
- Every verb reports `active` — `null` (nothing pinned), the name of the profile the
  files match, or `custom` (pins that match no profile: hand-edited, or the profile
  changed after it was applied). There is no journal; the state is read from the
  files.

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
applied, `warn` for an invalid profiles file or `custom` pins.

## Developing Agento

Profiles apply to the registered plugin clone (`chat.pluginLocations`). A worktree
window of the Agento repository loads its own workspace `.github/agents/` and
`.github/prompts/`, which stay unpinned; `tests/customizations.test.mjs` fails if a
`model:` line is ever committed. Clear the profile before editing an agent or prompt
in the clone — skip-worktree hides your edits from `git status` — and apply it again
afterwards.

## Limits

- One profile is active per clone (machine-wide, last apply wins); there are no
  per-project profiles.
- `handoffs[].model` is not written; a handoff relies on the target agent's own
  `model:` line.
- From-source and Copilot CLI installs (install options B and C) are replaced on
  update; apply the profile again afterwards.
