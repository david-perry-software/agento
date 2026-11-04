---
name: agento
description: "Use when the user types /agento <command> [args]: routes an Agento command to its skills/agento/commands/<name>.md and runs it inline or through its custom agent."
argument-hint: "<command> [args]"
user-invocable: true
disable-model-invocation: true
---

# Agento command router

Routes `/agento <name> [args]` in every session (Copilot and Local) to its command
body through the Agento CLI's `brief` subcommand, and runs it inline or through its
custom agent. Follow the steps below in order.

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
`<agento-root>/skills/agento/commands/` exists.

## 4. Run the brief

Run `node <agento-root>/scripts/agento.mjs brief <name> <argument>` — one
host-approved bash call. It prints the receipt and `Preflight:` lines, the session,
the delivery (roadmap header and current step when the argument is a slug), the
command body (and the agent body when one applies), the declared policy sections, and
a `More:` / `On demand:` footer, every page within 7 KB. On exit 1, relay the
valid-name list it printed — the `/agento <name>` for every command — and stop.
Never guess a closest match. Read every `More:` page (`… brief … --page N`) before the
first step.

## 5. Dispatch

A `Dispatch:` block — or its absence — decides how the brief is followed. The command
file's `agent:` frontmatter produced it; the table stays as documentation:

| `agent:` | Mode |
| --- | --- |
| missing or `agent` | inline |
| `📋 Agento Planner`, `🏛️ Agento Architect`, `🛠️ Agento Mechanic`, `🤖 Agento Autopilot` | inline, as that agent |
| `🔨 Agento Builder`, `🔍 Agento Reviewer` | subagent |

- **`Dispatch:` block present** (`subagent`): invoke the named agent with the
  subagent tool — `task` (Copilot) with the printed `copilotModel` as its `model`, or
  `runSubagent` (Local) with the printed `subagentModel` as its `model`, omitting the
  model when it is `null` — passing the printed `Prompt:` and the argument. Relay the
  subagent's final message verbatim, including its receipt and result lines and its
  command blocks.
- **No `Dispatch:` block** (`inline` or `inline, as that agent`): follow the printed
  command body (and agent body, when printed) as this turn's instructions, with the
  argument as its argument. Where the agent needs `ask-questions` or `browser` and the
  tool is absent, its §10 fallback applies (numbered questions in chat; headless
  verify).

Never `view` a file under `<agento-root>`: command, agent, and policy text comes from
`brief` and `policy`; files inside the current workspace are unaffected.

Whichever mode applies, the dispatched command's §9 receipt line must be printed verbatim as visible text, before any question or other output.

## 6. No own receipt

The router adds no receipt or result line of its own; the dispatched command owns
§9. The router's own outputs are only the redirect sentence and the unknown-name
list.
