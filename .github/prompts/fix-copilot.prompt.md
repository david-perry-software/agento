---
description: "Diagnose and repair a bug in the Copilot customization system (agents, prompts, instructions, hooks, skills)"
argument-hint: "Describe the misbehavior (what you did, what happened, what you expected)"
agent: "🛠️ Agento Mechanic"
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Fix the customization-system bug described in the argument.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (an existing capability with the same name is modified in place,
never duplicated).

Follow your full diagnosis protocol: reproduce the symptom, check the usual suspects
and known pitfalls, apply the minimal fix, prove it with the failing reproduction now
passing (plus all guard decision paths if a hook changed), append any new pitfall to
your catalog, and offer to publish via /agento commit-current-changes.

If the argument is empty, ask for: the command or agent used, what happened, and what
was expected — then proceed.
