---
description: "Diagnose and repair a bug in the Copilot customization system (agents, prompts, instructions, hooks, skills)"
argument-hint: "Describe the misbehavior (what you did, what happened, what you expected)"
agent: "🛠️ Agento Mechanic"
---

Needs: terminal
Fallback: none — every need is hard
Standard fallbacks: delivery-policy §10.
Policy: §1, §9, §10, §11, §12 — loaded by the opening `agento.mjs brief` call; any other §N on demand with `agento.mjs policy N`.
Duplicate submission: An existing capability with the same name is modified in place, never duplicated.

Fix the customization-system bug described in the argument.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this command's
duplicate-submission line. Open with one `node <agento-root>/scripts/agento.mjs brief
fix-copilot` call (§9–§11): print its receipt and `Preflight:` lines verbatim, stop on `status: rejected` (exit 3), and read every `More:` page before the first step.
Window check per §11: requires role `any` (read-only / not window-sensitive).

Follow your full diagnosis protocol: reproduce the symptom, check the usual suspects
and known pitfalls, apply the minimal fix, prove it with the failing reproduction now
passing (plus all guard decision paths if a hook changed), append any new pitfall to
your catalog, and offer to publish via /agento commit-current-changes.

If the argument is empty, ask for: the command or agent used, what happened, and what
was expected — then proceed.
