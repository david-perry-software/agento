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
- Capabilities are checked before work starts, not discovered mid-command: every
  command opens with `agento.mjs preflight <command>`, which runs the command's
  `doctor` checks before its first write (§10). For a CLI `doctor` does not cover,
  check it with `command -v` (or the project's documented presence check) before the
  first invocation; report a missing prerequisite instead of producing exit 127.

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
   The slug directory is in the artifact checkout: this worktree in the in-repo
   layout, the companion half (`companion.path` in the session record, on the
   mirrored branch) in companion mode — evidence never lands in the product half
   there.
4. **Verify and advance**: run the machine-checkable part of `verify:`, tick, commit
   evidence + roadmap together (one companion commit in companion mode), push,
   continue.
5. If the user cannot act now: pause protocol, with the manual step named in
   `next-step`.

A ticked `(manual)` step without a linked evidence file is a falsely ticked box.
Browser-driven checks the agent performs itself also land their screenshots under
`evidence/` on the work branch.

**Pause kinds.** `status: paused` means exactly one thing: only the user can advance
the roadmap — a `(manual)` step has been reached, or a blocker only the user can
clear (an auth failure, a missing prerequisite, a decision). Its `next-step` names
the step and carries the reason as a marker: `"<N.M> (manual) <action>"` for a manual
step, `"<N.M> blocked: <reason>"` for a blocker. Stopping for any other reason —
session length, token budget, a clean phase boundary, the user saying "pause" with
nothing outstanding — is a **session break**, not a pause: the in-flight step is
finished or reverted, everything is committed and pushed, `status` stays
`in-progress`, and `next-step` names the next unticked step. A session break needs
nobody: `/agento build-<type> <slug>`, `/agento ap <slug>`, and `/agento continue`
all resume it through the Builder's resume protocol, and the Autopilot never stops
on one. A `paused` roadmap whose `next-step` carries neither marker predates this
rule and is read as a session break.

## 4. Post-ship exception

`- [ ] N.M (manual, post-ship) <action> — verify: <check>` is allowed only when preview
*and* faithful local verification are genuinely impossible or materially unfaithful,
plan.md `## Risks` states why, and the user explicitly accepted it during
clarification. A missing preview URL, convenience, or "wait for the normal release" is
not enough on its own.

Such steps stay unticked through build, review, and ship — they are not gaps.
Reviewers score acceptance items satisfiable only by that step as `deferred to
post-ship`, not fail; an unticked `(manual, post-ship)` step *without* the documented
justification is missing preview evidence and forces `request-changes`. /agento ship
completes valid exceptions after the merge in its epilogue, landing evidence + tick via
a `<post-ship-prefix><slug>` PR. Evidence rules are identical to §3.

## 5. Lint baseline gate

During planning, run the full-repository lint command from AGENTS.md and record its
command, exit status, and findings in plan.md `## Research` (the plan.md in the
artifact checkout — the companion half in companion mode; the lint itself always runs
in the product checkout). A red baseline is never silently waived:

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
- CI and deploy waits are bounded foreground polls, each call returning within 60 s:
  CI waits use `scripts/wait-for-checks.sh pr <n>` or `run <id>`; deploy waits use
  `node <agento-root>/scripts/agento.mjs release <merge-sha> --wait N` (N ≤ 60). Exit
  2 = still pending: rerun. Never `--watch`, background terminals, VS Code tasks, or
  ending the turn to "wait". `agento.mjs ship` and `agento.mjs publish-pr --merge`
  run their waits internally under the same ≤ 60 s bound and return `status:
  pending` (exit 2) for the re-send.

## 7. Git rules

- Never commit or push to `main`; work branches and pull requests only. Never
  force-push, rebase or amend pushed history, or bypass hooks or rulesets
  (`--no-verify`, `--admin`).
- Integrate `origin/main` by merge — never rebase — before every push and before
  setting `status: in-review`; conflict recipes are in
  concurrent-delivery.instructions.md. In companion mode integrate both defaults:
  the product's `origin/main` into the product branch and the companion's
  `origin/<default>` into the mirrored companion branch (`git -C <companion.path>
  merge origin/<default>`).
- Commit each roadmap step together with its roadmap.md update, as a Conventional
  Commit. Small, frequent, integrated, pushed commits are the pause/resume mechanism.
  **Two-commit rule (companion mode):** a step is one code commit in the product half
  and one artifact commit (roadmap tick, evidence, plan/review edits) in the companion
  half, both Conventional Commits naming the step, pushed product first then
  companion; the companion half must end every step with `dirty: false`, `ahead: 0`
  in the session record. Both repositories carry the same branch name and each has
  its own draft PR (`artifact-pr:` in the roadmap header names the companion's).
- Only the user's /agento ship marks a PR ready or merges it; Builder, Reviewer, and Autopilot
  never do.
- Keep unrelated changes out; record unrelated problems as Follow-ups in roadmap.md
  instead of fixing them.
- **Clean handoff.** At every handoff — Builder completion, Builder pause or session
  break, Reviewer verdict — `git status --porcelain --untracked-files=all` prints
  nothing in the product worktree and, in companion mode, in the companion half.
  Byproducts written outside their sink (test output, stray screenshots): delete
  them, never commit them. Evidence is committed under the slug's `evidence/`. A
  byproduct that keeps coming back means fixing its producer (route the output to
  its sink) and recording a Follow-up; `.gitignore` is reserved for genuinely
  generated artifacts.

## 8. Cross-window handoff

Build and review happen in the secondary (worktree) window — in companion mode
(`artifacts.repo` set) that is the pair's `<kind>-<id>.code-workspace` window holding
the product half and its companion half; close and ship happen in the primary window. Every Builder completion, Reviewer verdict, and Autopilot stop ends
with the exact commands:

1. In this window: `/agento review-feature <slug>` or `/agento review-issue <slug>` after a build
   completes; the Builder fix handoff after `Verdict: request-changes`.
2. After `Verdict: approve`, switch to the primary workspace window and run
   `/agento ship <slug>`; it audits while this worktree is still open, sends you
   back here on a rejected audit, and tears the worktree down once the PR is merged.
   Standalone `/agento close-session <type>/<slug>` is for plan and freehand
   sessions and for abandoning a build.

`/agento continue [slug]` derives the same handoff command from the session record
(`agento.mjs next`) and performs it; it may be named alongside the explicit command in
these hand-offs. Never substitute raw git or worktree commands for these workflow
commands.

## 9. Execution receipts

Every `/agento …` command and every agent response opens with exactly one receipt
line and closes with exactly one result line. The CLI derives the operation ID
(`opId`) and assembles the `receipt` and `preflightLines`; print them verbatim, never
rebuild them, and stop on `status: rejected` (emit its alternatives as §12 blocks,
write nothing).

- A duplicate submission of the same operation receives the duplicate form of the
  accepted receipt (`Receipt: accepted <op-id> (duplicate of <op-id>; resuming)`);
  re-sending any command is safe by construction, and the command resumes per its
  duplicate-submission line.
- Close with one result line: `Result: completed — <resulting state>; next:
  <command>`, or `Result: failed — <retry-safe explanation>`. A pause (manual step or
  blocker awaiting the user) is a `completed` result whose state is `paused`, and a
  session break (§3 pause kinds) a `completed` result whose state is `in-progress`;
  both name the resume command in `next:` and neither is a failure.

The op-id grammar, the receipt variants the CLI assembles, and the idempotency table
live in `docs/architecture.md`.

## 10. Capability preflight

The opening `agento.mjs preflight <command>` call has already run the command's
`doctor --for` checks: on `status: rejected` print the receipt and stop; each
`Preflight:` line names a soft fallback to apply. The capability vocabulary, the
hard/soft classification, the Declaration contract, and when `doctor` runs live in
`docs/architecture.md`.

**Standard fallbacks** (declared once here; `Fallback:` lines cite them, never
restate them):

- `terminal` unavailable → reject: "switch to Agent mode and re-send the command";
  no partial help in Plan or Ask mode.
- `ask-questions` unavailable → ask the same questions as a numbered list in chat,
  end the turn, wait for the reply, and retain the answers verbatim in the artifact;
  each question still carries its recommended choice (below).
- `browser` unavailable → run the step's `verify:` headless (curl, CLI, tests) where
  faithful; otherwise report the step blocked per §2 and pause. Never silently skip.
- `code` unavailable → keep the worktree and print `code --new-window
  <worktree-path>` for the user to run.
- `gh` missing or unauthenticated → reject; the user installs GitHub CLI or runs
  `gh auth login` in their own terminal (§1), then re-sends the command.
- `network` unreachable → `doctor` reports `warn`; fetch/push/PR steps are retried
  before the turn ends and the command pauses if they still fail.

**Recommended choice.** Every clarifying question offers 2–4 concrete options with
exactly one recommended — open-ended questions included — and a free-text answer
stays allowed. With the ask-questions tool, the recommended option is listed first
and carries `recommended: true`. In the numbered-list fallback (the tool is missing,
or the agent runs as a subagent, where VS Code withholds it), options are lettered
and the recommended one is bold and suffixed `(recommended)` with a one-line reason.
Retain the answers verbatim, noting which option was the recommended one.

## 11. Window check

Which window a command runs in is data, not prose: every command and agent carries a
`Window check per §11: requires role <roles>` line, and the roles table lives in the
CLI (`WINDOW_ROLES` and `deriveAllowed` in `scripts/session-state.mjs`).

- `window.match: false` → print the preflight `receipt` and its alternatives as §12
  blocks, write nothing.
- On a match, the record's `worktree`, `companion`, `delivery`, and `lifecycle`
  replace fresh git inspection. Only worktree-mutating commands (`start-session`,
  `start-freehand`, `close-session`, and `ship` teardown) read
  `git worktree list --porcelain`, and they call `preflight --full` (or
  `agento.mjs session`) for `worktrees[]`.
- A requirement with a branch condition — `primary` on a non-default branch
  (`commit-current-changes`); `primary` on the default branch, clean (`quick-fix`,
  `new-initiative`, `start-session`, `start-freehand`); build-window commands whose
  `delivery.slug` must equal the argument — states it on the same line and checks it
  from the record's `worktree.branch` and `delivery`, never from a fresh `git branch`
  reading.

The record field catalogue and the numbered procedure live in `docs/architecture.md`.

## 12. Command presentation

VS Code chat puts a one-click copy button on a fenced code block and on nothing else,
so every `/agento …` command the response asks the user to run — now, next, or in
another window — is emitted in its own **copyable command block**: a fenced block
with no language tag whose only content is exactly that one command, arguments
substituted, with no comment, prompt character, or surrounding text. One block holds
one command; a block with a language tag would make the editor offer to run a chat
command in a terminal, and a block with two commands or a trailing `#` comment copies
an unusable paste.

**Where it applies.**

- The `next:` command of the §9 result line, repeated in a block directly above the
  result line. The result line itself is unchanged and stays the single last line.
- Each command of the §8 cross-window handoff, as a numbered list with one block per
  item and the window named in the item's prose.
- The resume command named by a pause (Builder pause protocol, manual step awaiting
  the user, `/agento ship`'s teardown pause).
- Every alternative a `rejected` receipt offers (`allowed:` and the `elsewhere`
  entries): the receipt stays a single first line and the blocks follow it.
- The command `/agento continue` names for another window; the exact commands
  `/agento next-feature` reports; `/agento ship`'s reject-back handoff to the build
  window; the Build-in-this-worktree offer's `/agento build-<type> <slug>`
  alternative.

**Unattended alternative.** Whenever one of those blocks holds
`/agento build-<type> <slug>` or `/agento review-<type> <slug>` — the §8 handoff,
the Builder fix handoff, the Builder pause resume command, the ship reject-back
handoff, the Build-in-this-worktree offer, the next-feature report, and
`/agento continue` when it names one of those — the response also offers
`/agento ap <slug>` in its own block directly after it, preceded by one line naming
it as the unattended alternative (for example "Or unattended, in this window:").
The ap block follows build and review commands only — never `/agento ship`,
`/agento start-session`, or any other command — and the §9 result line's `next:`
stays the build or review command.

**Where it does not apply.** Descriptive mentions — what a command does, what an agent
never runs, the redirect sentence, table rows, headers — stay inline in backticks.
Repository prose (README, docs, templates, AGENTS.md) is out of scope and keeps inline
code. Shell commands the *agent* runs itself (§1) are its own work, never presented
to the user as blocks.

**Ordering.** Several blocks appear in execution order, each preceded by exactly one
line saying where or when to run it (for example "In this window:" or "From the
primary window, after approval:").
