---
description: "Canonical spelling of Agento slash commands and the redirect rule for old forms (bare /<name>, .prompt or .md suffixes): name the canonical command and proceed"
applyTo: "**"
---

Agento commands have exactly one spelling: `/agento <name> [args]`. The `<name>`
values are the basenames of `.github/prompts/*.prompt.md`:

- `/agento agento-init`
- `/agento ap`
- `/agento build-feature`
- `/agento build-issue`
- `/agento close-session`
- `/agento commit-current-changes`
- `/agento delivery-status`
- `/agento extend-copilot`
- `/agento finish-freehand`
- `/agento fix-copilot`
- `/agento install-skills`
- `/agento new-feature`
- `/agento new-initiative`
- `/agento new-issue`
- `/agento next-feature`
- `/agento quick-fix`
- `/agento review-feature`
- `/agento review-issue`
- `/agento ship`
- `/agento start-freehand`
- `/agento start-session`
- `/agento triage-followups`

## Redirect rule

These six old forms — with or without trailing arguments — are typos for the canonical
command, not ordinary text:

- `/<name>`
- `/<name>.prompt`
- `/<name>.md`
- `/agento <name>.prompt`
- `/agento <name>.prompt.md`
- `/agento <name>.md`

When a user types one, say which canonical command you are reading it as in one
sentence and proceed with that command; arguments carry over unchanged; do not ask
for confirmation. Example: "Reading `/agento agento-init.prompt` as
`/agento agento-init`."

Names are used as-is; there is no legacy-name mapping. If a command is ever renamed,
the delivery that renames it adds the old → new row here.

## Guidance rule

Prose in this repository (README, docs, agents, prompts, instructions, templates)
writes only the canonical form; `tests/customizations.test.mjs` rejects a bare
`/<name>` and any `.prompt`/`.md` suffix after a command name. This file is the one
place allowed to quote the old forms.
