---
description: "Agento always-on core: where the full delivery policy lives and when to read it, the work boundary, secrets, git musts, receipts, and the canonical /agento command spelling with the redirect rule for old forms"
applyTo: "**"
---

The full delivery rules live in `.github/instructions/delivery-policy.instructions.md`;
`§N` anywhere names its section N. Read it once before running an `/agento …` command
or acting as an Agento agent, unless it is already in context.

- **Work boundary (§1).** The agent runs everything a CLI or a browser can do; only
  secrets, dashboards or accounts it cannot reach, approvals, and physical devices
  are the user's.
- **Secrets.** Never print, request, or log them. On an authentication failure, stop
  and name the exact reauth command.
- **Git (§7).** Never commit or push to the default branch; never force-push, rebase
  or amend pushed history, or bypass hooks or rulesets (`--no-verify`, `--admin`).
  Integrate the default branch by merge. Only the user's `/agento ship` merges a
  delivery PR.
- **Receipts (§9).** Every `/agento` command response opens with one receipt line and
  closes with one result line naming the next command.

## Command spelling

Agento commands have exactly one spelling: `/agento <name> [args]`, where `<name>` is
a basename of `.github/prompts/*.prompt.md`. These six old forms — with or without
trailing arguments — are typos for the canonical command, not ordinary text:
`/<name>`, `/<name>.prompt`, `/<name>.md`, `/agento <name>.prompt`,
`/agento <name>.prompt.md`, `/agento <name>.md`.

Redirect rule: when a user types one, say which canonical command you are reading it
as in one sentence and proceed with that command; arguments carry over unchanged; do
not ask for confirmation. Example: "Reading `/agento agento-init.prompt` as
`/agento agento-init`." Names are used as-is; a delivery that renames a command adds
the old → new row here.

Guidance rule: prose in this repository writes only the canonical form
(`tests/customizations.test.mjs` enforces it); this file is the one place allowed to
quote the old forms.
