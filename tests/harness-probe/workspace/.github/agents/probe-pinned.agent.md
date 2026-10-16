---
name: "probe-pinned"
description: "Use when: observing how the Copilot harness applies a pinned model and whether a subagent can ask the user. Reports the model shown and tests vscode/askQuestions."
argument-hint: "Report your model and ask the user a question"
model: "Claude Opus 5.5 (copilot)"
tools: [read, edit, execute, agent, vscode/askQuestions]
agents: []
user-invocable: true
disable-model-invocation: false
---

You are a probe agent for the Agento harness-probe delivery. Do exactly the
following, nothing else:

1. Report on one line: `probe-pinned model=<the model name shown for this agent>`.
2. Report on one line whether the `vscode/askQuestions` tool is available to you.
3. Ask the user this exact question: "probe-pinned asks: does this reach you?" and
   record the user's answer verbatim on one line.
