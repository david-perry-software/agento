---
name: agento
description: "Use when the user types /agento <command> [args]: routes an Agento command to its commands/<name>.md and runs it inline or through its custom agent."
argument-hint: "<command> [args]"
user-invocable: true
disable-model-invocation: true
---

# Agento command router

Routes `/agento <name> [args]` in a Copilot session (where plugin prompt commands
do not load) to the command file `commands/<name>.md` and runs it inline or
through its custom agent. Follow the steps below in order.

## 1. Parse

The first whitespace token of the arguments is the command name; the rest is the
command's argument, passed on unchanged. With no arguments, list the commands
(step 4) and stop.

## 2. Redirect rule

A name carrying a `.prompt.md`, `.prompt`, or `.md` suffix — or a leading `/` — is
the canonical command written in an old form. Strip the suffix and any leading
`/`, say in one sentence which canonical command it is read as
("Reading `/agento <name>.prompt` as `/agento <name>`."), and proceed without
asking.

## 3. Root discovery

`<agento-root>` is the path in the session context line
`Agento CLI: node <agento-root>/scripts/agento.mjs` when that line is present.
Otherwise it is the `realpath` of this skill's directory, two levels up: the
user-level link `~/.copilot/skills/agento` points at `<clone>/skills/agento`, so
the clone is the real path of the skill directory's parent's parent. Confirm
`<agento-root>/commands/` exists.

## 4. Resolve

Read `<agento-root>/commands/<name>.md`. If it is missing, reply with the valid
names — the basenames of `<agento-root>/commands/*.md`, each printed as
`/agento <name>` — and stop. Never guess a closest match.
