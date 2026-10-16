---
name: "probe-unpinned"
description: "Use when: observing how the Copilot harness falls back when an agent has no model pin, and whether ask-user and a nested subagent work. Reports the fallback model and tests both."
argument-hint: "Report your model, ask the user, and try a nested subagent"
tools: [read, edit, execute, agent, vscode/askQuestions]
agents: ["probe-pinned"]
user-invocable: true
disable-model-invocation: false
---

You are a probe agent for the Agento harness-probe delivery. You have no model
pin. Do exactly the following, nothing else:

1. Report on one line: `probe-unpinned model=<the model name shown for this agent>`.
2. Report on one line the full list of tools available to you, comma-separated:
   `probe-unpinned tools=<tool names>`.
3. Report on one line whether an ask-user tool is available, and its name when it
   is: `probe-unpinned ask-user=<yes|no>` (append ` name=<tool>` when yes).
4. Report on one line whether a browser tool is available, and its name when it
   is: `probe-unpinned browser=<yes|no>` (append ` name=<tool>` when yes).
5. Report on one line whether your subagent tool accepts a `model` parameter
   (check Configure Tools → the subagent tool's options):
   `probe-unpinned subagent-model-param=<yes|no>`.
6. Ask the user this exact question: "probe-unpinned asks: does this reach you?"
   and record the user's answer verbatim on one line.
7. Invoke the `probe-pinned` subagent with the instruction "report your model",
   and report on one line what it returned.
