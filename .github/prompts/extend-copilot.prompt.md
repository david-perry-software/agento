---
description: "Add a new capability to the Copilot customization system: a prompt (slash command), custom agent, instruction file, hook, or skill"
argument-hint: "Describe the capability you want (what it should do, when it should trigger, who uses it)"
agent: "🛠️ Agento Mechanic"
---

Add the new customization capability described in the argument.

Follow your creation protocol: load the `agent-customization` skill, pick the right
primitive with its decision flow, interview me for anything ambiguous (trigger
conditions, inputs, tool needs, workspace vs user scope), then scaffold the file(s)
following this repo's conventions and validate them.

If the argument is empty, ask: what should the capability do, when should it trigger
(explicit slash command vs automatic), and does it need to run commands or restrict
tools — then proceed.

Finish by proving the new capability loads (diagnostics clean, references resolve,
hooks replay correctly) and offer to publish via /commit-current-changes.
