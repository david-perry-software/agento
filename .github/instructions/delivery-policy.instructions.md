---
description: "Use when running any /agento command or acting as an Agento agent (Planner, Builder, Reviewer, Autopilot, Architect, Mechanic): the full delivery policy — the agent/user work boundary, verification targets, evidence, manual and post-ship steps, pause kinds (paused vs. session break), the lint baseline gate, shell hygiene, git rules, the cross-window handoff, execution receipts with per-command idempotency, capability preflight, the window check every command runs against the session record, and command presentation"
applyTo: ".github/agents/**,.github/prompts/**,.github/instructions/**,skills/agento/commands/**"
---

Single source for the rules every delivery role applies. Agents and prompts link here
instead of restating; if a rule here and a rule elsewhere disagree, this file wins and
the other is a bug to fix. Artifact *formats* (headers, sections, step syntax) live in
[delivery-artifacts.instructions.md](delivery-artifacts.instructions.md); concurrency
*mechanics* (per-slug ports, resolving your own preview, shared resources, integrating
the default branch, conflict recipes) in
[concurrent-delivery.instructions.md](concurrent-delivery.instructions.md). `main`
below means the configured `branches.default` (`agento.mjs config`).

## Sections

- §1 [Who does the work](policy/01-who-does-the-work.md) — the agent/user work boundary and what counts as `(manual)`
- §2 [Verification targets](policy/02-verification-targets.md) — how every step's `verify:` target is chosen and verified
- §3 [Manual steps and evidence](policy/03-manual-steps-and-evidence.md) — the manual-step protocol, evidence rules, and pause kinds
- §4 [Post-ship exception](policy/04-post-ship-exception.md) — when a step may defer to post-ship and what it requires
- §5 [Lint baseline gate](policy/05-lint-baseline-gate.md) — the full-repository lint baseline and the scoped gate
- §6 [Shell hygiene](policy/06-shell-hygiene.md) — shell usage rules: pipes, waits, and bounded timeouts
- §7 [Git rules](policy/07-git-rules.md) — work branches, merge-not-rebase, the two-commit rule, clean handoff
- §8 [Cross-window handoff](policy/08-cross-window-handoff.md) — the build → review → ship command sequence across windows
- §9 [Execution receipts](policy/09-execution-receipts.md) — the receipt and result lines every command opens and closes with
- §10 [Capability preflight](policy/10-capability-preflight.md) — the opening preflight, hard/soft capabilities, and fallbacks
- §11 [Window check](policy/11-window-check.md) — which window a command runs in and the role/slug requirements
- §12 [Command presentation](policy/12-command-presentation.md) — copyable command blocks and the unattended `/agento ap` alternative

Read sections with `agento.mjs policy N`; never `view` them.
