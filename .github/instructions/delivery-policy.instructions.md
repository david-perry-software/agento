---
description: "Delivery policy shared by the Planner, Builder, Reviewer, Autopilot, and the build/review/ship prompts: the agent/user work boundary, verification targets, evidence, manual and post-ship steps, the lint baseline gate, shell hygiene, git rules, and the cross-window handoff"
applyTo: "**"
---

Single source for the rules every delivery role applies. Agents and prompts link here
instead of restating; if a rule here and a rule elsewhere disagree, this file wins and
the other is a bug to fix. Artifact *formats* (headers, sections, step syntax) live in
[delivery-artifacts.instructions.md](delivery-artifacts.instructions.md); concurrency
*mechanics* (per-slug ports, resolving your own preview, shared resources, integrating
the default branch, conflict recipes) in
[concurrent-delivery.instructions.md](concurrent-delivery.instructions.md). `main`
below means the configured `branches.default` (`agento.mjs config`).

## 1. Who does the work

- The agent runs everything executable from its shell with an available CLI (`gh`,
  `git`, the project's CLIs declared in AGENTS.md, deploy and test commands) and
  everything verifiable by driving a browser itself (load a URL, sign in with test
  credentials, click through a flow, assert rendered state, capture a screenshot).
  Needing a CLI or a browser is never grounds to hand work to the user or to mark a
  step `(manual)`.
- Only the user can: enter secrets, act in dashboards, accounts, or vaults the agent
  cannot reach, grant approvals, operate physical devices. Those steps — and only
  those — are `(manual)`.
- Authentication failure: stop, name the exact reauth command (per AGENTS.md), wait.
  Never ask the user to run the command on your behalf.
- Never print, request, or log secrets; screenshots must not show them.
- Before invoking a CLI not yet proven in this session, check it with `command -v` (or
  the project's documented presence check); report a missing prerequisite instead of
  producing exit 127.

## 2. Verification targets

Every user-visible or deployed behavior is verified **before review**, by the agent,
against the target the roadmap step's `verify:` line names:

- `local:<ports>` (default) — the branch served locally on per-slug ports
  (`agento.mjs ports <slug>`). Needs no platform allowlist edits.
- `dev-stack` — the project's documented full local stack for auth/DB-backed flows.
  Its fixed ports make it exclusive: confirm no other session has it up, and say so.
- `preview: <reason>` — a deployed branch preview, only when the behavior depends on
  the deployed platform itself (build/env wiring, edge/ISR/middleware, backend
  integration, the release path). Convenience is not a reason. Resolve your own
  branch's preview, never another slug's; follow AGENTS.md for platform setup, record
  it on the step, undo it at ship.

Planners write the target; Builders and Reviewers never upgrade a local step to a
preview on their own. If a step requires a preview and none exists, the plan includes
the preview-enablement work — or the user explicitly accepts a post-ship exception
(§4). Never silently defer. The Reviewer re-drives the target independently and
captures its own screenshot rather than trusting the Builder's evidence alone.

## 3. Manual steps and evidence

Syntax: `- [ ] N.M (manual) <exact user action> — verify: <check>`. When the Builder
reaches one — or discovers one mid-step, in which case it is first added as
`(manual) … (added <date>)`:

1. **Stop and instruct**: numbered actions with precise names, URLs, and values; never
   ask for secret values in chat.
2. **Collect proof**: the user confirms completion and attaches a screenshot.
3. **Document**: save it as `evidence/step-<N-M>-<short-name>.png` inside the slug
   directory, link it from the step line, note the completion date on that line.
4. **Verify and advance**: run the machine-checkable part of `verify:`, tick, commit
   evidence + roadmap together, push, continue.
5. If the user cannot act now: pause protocol, with the manual step named in
   `next-step`.

A ticked `(manual)` step without a linked evidence file is a falsely ticked box.
Browser-driven checks the agent performs itself also land their screenshots under
`evidence/` on the work branch.

## 4. Post-ship exception

`- [ ] N.M (manual, post-ship) <action> — verify: <check>` is allowed only when preview
*and* faithful local verification are genuinely impossible or materially unfaithful,
plan.md `## Risks` states why, and the user explicitly accepted it during
clarification. A missing preview URL, convenience, or "wait for the normal release" is
not enough on its own.

Such steps stay unticked through build, review, and ship — they are not gaps.
Reviewers score acceptance items satisfiable only by that step as `deferred to
post-ship`, not fail; an unticked `(manual, post-ship)` step *without* the documented
justification is missing preview evidence and forces `request-changes`. /ship
completes valid exceptions after the merge in its epilogue, landing evidence + tick via
a `<post-ship-prefix><slug>` PR. Evidence rules are identical to §3.

## 5. Lint baseline gate

During planning, run the full-repository lint command from AGENTS.md and record its
command, exit status, and findings in plan.md `## Research`. A red baseline is never
silently waived:

- A finding that overlaps the delivery's files or behavior → cleanup is a prerequisite
  or explicitly in scope.
- All findings demonstrably pre-existing and unrelated → a **scoped gate** is
  permitted, and it must include all of: lint every changed or new lintable file; run
  each affected package/workspace lint that can pass independently; focused tests for
  the changed behavior; the affected package/workspace typecheck; a rerun of
  full-repository lint compared against the initial findings — only the documented
  pre-existing findings may remain. Changed-files-only lint is never sufficient.

Encode the choice in `## Research`, `## Approach`, `## Acceptance checklist`, and
roadmap `verify:` steps. Builders execute every component and record the comparison,
and reassess overlap whenever scope expands (new files, new behavior). Reviewers
compare a fresh final run against the recorded baseline and request changes for
incomplete scoped results, new or undocumented findings, or overlap without planned
cleanup. Applies to new plans and to steps added to active deliveries; never rewrite
historical artifacts solely to adopt it.

## 6. Shell hygiene

- No early-closing pipeline consumers (`| head`) when `pipefail` may be active; use a
  bounded producer, the tool's own limit option, or `sed -n` — an upstream SIGPIPE
  exits the automation shell with 141.
- Run diagnostics, environment doctors, builds, and tests in a wrapper that captures
  and reports their status while leaving the shell at 0. Interpret the captured
  status: an exposing test must be nonzero when expected; every unexpected nonzero is a
  real failure. Surface stderr once; do not blindly rerun the same command.
- CI and deploy waits are bounded foreground polls: `scripts/wait-for-checks.sh pr <n>`
  or `run <id>` (exit 2 = still pending: rerun). Never `--watch`, background
  terminals, VS Code tasks, or ending the turn to "wait".

## 7. Git rules

- Never commit or push to `main`; work branches and pull requests only. Never
  force-push, rebase or amend pushed history, or bypass hooks or rulesets
  (`--no-verify`, `--admin`).
- Integrate `origin/main` by merge — never rebase — before every push and before
  setting `status: in-review`; conflict recipes are in
  concurrent-delivery.instructions.md.
- Commit each roadmap step together with its roadmap.md update, as a Conventional
  Commit. Small, frequent, integrated, pushed commits are the pause/resume mechanism.
- Only the user's /ship marks a PR ready or merges it; Builder, Reviewer, and Autopilot
  never do.
- Keep unrelated changes out; record unrelated problems as Follow-ups in roadmap.md
  instead of fixing them.

## 8. Cross-window handoff

Build and review happen in the secondary (worktree) window; close and ship happen in
the primary window. Every Builder completion, Reviewer verdict, and Autopilot stop ends
with the exact commands:

1. In this window: `/review-feature <slug>` or `/review-issue <slug>` after a build
   completes; the Builder fix handoff after `Verdict: request-changes`.
2. After `Verdict: approve`, switch to the primary workspace window and run
   `/close-session <type>/<slug>`, then `/ship <slug>`.

Never substitute raw git or worktree commands for these workflow commands.
