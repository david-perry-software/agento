---
description: "Diagnose and repair a bug in the Copilot customization system (agents, prompts, instructions, hooks, skills)"
argument-hint: "Describe the misbehavior (what you did, what happened, what you expected)"
agent: "🛠️ Agento Mechanic"
---

Fix the customization-system bug described in the argument.

Follow your full diagnosis protocol: reproduce the symptom, check the usual suspects
and known pitfalls, apply the minimal fix, prove it with the failing reproduction now
passing (plus all guard decision paths if a hook changed), append any new pitfall to
your catalog, and offer to publish via /commit-current-changes.

If the argument is empty, ask for: the command or agent used, what happened, and what
was expected — then proceed.
