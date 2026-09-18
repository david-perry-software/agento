---
description: "Delivery policy shared by the Planner, Builder, Reviewer, Autopilot, and the build/review/ship prompts: the agent/user work boundary, verification targets, evidence, manual and post-ship steps, the lint baseline gate, shell hygiene, git rules, the cross-window handoff, execution receipts with per-command idempotency, capability preflight, the window check every command runs against the session record, and command presentation"
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
- Capabilities are checked before work starts, not discovered mid-command: a command
  whose `Needs:` line includes `gh`, `code`, or `network` runs `agento.mjs doctor
  --for <command>` before its first write (§10). For a CLI `doctor` does not cover,
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
- CI and deploy waits are bounded foreground polls: `scripts/wait-for-checks.sh pr <n>`
  or `run <id>` (exit 2 = still pending: rerun). Never `--watch`, background
  terminals, VS Code tasks, or ending the turn to "wait".

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
line and closes with exactly one result line, in the spellings below and nowhere else
restated. Re-sending any command is safe by construction: duplicate behaviour is
derived from git + roadmap state (no journal) per the table at the end of this section.

**Receipt — the first line of the response:**

- `Receipt: accepted <op-id>` — work starts.
- `Receipt: accepted <op-id> (duplicate of <op-id>; resuming)` — the same operation
  was already submitted; the command resumes per its idempotency row and creates
  nothing a second time.
- `Receipt: rejected — <reason>; allowed: <cmd>[, <cmd>…]` — nothing is written. The
  alternatives are copied from the session record (`agento.mjs session`, echoed by
  the SessionStart hook's `Session:` line): every `allowed[]` entry verbatim, then
  each `elsewhere[]` entry as `<cmd> (<window> window)`. Commands never hand-maintain
  alternative lists.
- `Receipt: rejected — <capability>: <reason>; fallback: <fallback>` — nothing is
  written; a *hard* need from the command's `Needs:` line is unmet (§10). There is no
  `allowed:` list because the command is right and the environment is not; `<reason>`
  and `<fallback>` are the `detail` and `fallback` of the failing `doctor` check, or
  the §10 standard fallback for a chat capability.

**Preflight — an optional second line, directly after an `accepted` receipt:**

- `Preflight: <capability> <warn|missing> — <fallback>` — one line per unmet *soft*
  need (§10), quoting the `doctor` check's `fallback` or the §10 standard fallback
  verbatim. The command then proceeds using that fallback. No line is printed when
  every need is met.

**Result — the last line of the response:**

- `Result: completed — <resulting state>; next: <command>` — state names the branch,
  PR, roadmap `status`, or lifecycle as applicable; `next:` is the concrete next
  command and is how the AGENTS.md "ends with a concrete suggested next step" rule is
  satisfied.
- `Result: failed — <retry-safe explanation>` — what was done, what was not, and that
  re-sending the same command resumes from git + roadmap state (or what must change
  first). A pause (Builder pause protocol, manual step awaiting the user) is a
  `completed` result whose state is `paused` and whose `next:` names the resume
  command, not a failure.

**Operation ID** — `<command>:<subject>:<short-sha>`:

- `<command>` is the suffix-less command name (`new-feature`, `ship`, `ap`).
- `<subject>` is the slug when the command takes one; else the session id of a
  managed worktree (`plan-<id>`); else the current branch name (`git branch
  --show-current`, e.g. `delivery-status:main:e0bbddf`); else, detached and unmanaged,
  the literal `HEAD`.
- `<short-sha>` is `git rev-parse --short HEAD` at acceptance.

The ID is deterministic: the same command on the same subject at the same HEAD is a
duplicate submission and receives the duplicate receipt. Nothing is persisted; the
command recognises the duplicate from what the first submission left in git and the
roadmap.

**Idempotency table** — what a duplicate submission does, per command:

| Command | Duplicate submission |
| --- | --- |
| `/agento new-feature`, `/agento new-issue` | An existing roadmap for the slug enters the Planner resume protocol; no second branch, worktree, or PR. An existing GitHub issue is linked, not duplicated. |
| `/agento build-feature`, `/agento build-issue` | The Builder resume/audit protocol on the existing branch and roadmap; ticked steps are audited, never redone. |
| `/agento review-feature`, `/agento review-issue` | A fresh verdict overwrites review.md; no second PR comment thread. |
| `/agento ship` | `status: complete` with unticked post-ship steps resumes at the epilogue; `status: complete`, PR merged, and a managed worktree still owning the branch resumes at teardown; an already-merged PR with no worktree only syncs the default branch and reports it; in companion mode, a code PR merged while the companion PR is still open resumes at the companion merge, then sync, teardown, epilogue. |
| `/agento ap` | Re-enters the build or review resume protocol wherever the roadmap stands. |
| `/agento continue` | Re-derives the transition from git + roadmap state and performs whatever is legal now; never a second worktree, branch, or PR — the dispatched command's own row governs the rest. |
| `/agento start-session`, `/agento start-freehand` | A registered worktree for the same subject is resumed with `--resume` semantics whether or not the flag was given: HEAD, branch, and files untouched, the window reopened. |
| `/agento close-session` | A worktree already removed is reported as already closed; a merged local branch is still deleted and worktrees pruned. |
| `/agento finish-freehand`, `/agento commit-current-changes` | The existing commit, PR, or check-wait phase is reused; never a second commit or PR for the same changes. |
| `/agento quick-fix` | An open PR on `changes/<slug>` from the same base is resumed; the `-2`, `-3` suffix applies only when that branch's PR is merged or closed. |
| `/agento new-initiative` | An open `changes/initiative-<slug>` PR is resumed; a merged one is rejected naming the existing breakdown. |
| `/agento agento-init` | Existing files are kept unless `--force`; an existing companion repository or clone is adopted, never recreated or reset. With `--migrate`, roots already moved report nothing to migrate and existing `changes/agento-init` PRs in either repository are resumed, never duplicated. |
| `/agento install-skills` | Already-installed skills are excluded from the batch. |
| `/agento triage-followups` | Already-annotated follow-up lines and already-flagged issues are skipped. |
| `/agento delivery-status`, `/agento next-feature`, `/agento doctor` | Read-only; a duplicate is a fresh read (for `doctor`, a fresh run of the checks). |
| `/agento extend-copilot`, `/agento fix-copilot` | An existing capability with the same name is modified in place, never duplicated. |

## 10. Capability preflight

Commands state what they need before they start and name the fallback immediately;
a missing capability is never discovered mid-command. `agento.mjs doctor [--for
<command>]` is the canonical presence check for everything CLI-side.

**Vocabulary** — the only tokens a `Needs:` line may use:

- `terminal` — a shell the agent can run commands in (Agent mode; Plan and Ask chat
  modes have none).
- `ask-questions` — the structured ask-questions chat tool for clarification.
- `browser` — the integrated browser tools for driving a URL and capturing state.
- `gh` — the GitHub CLI, installed and authenticated (`doctor` check `gh`).
- `code` — the VS Code CLI for opening a worktree window (`doctor` check `code`).
- `network` — the `origin` remote reachable for fetch, push, PR, and package
  installs (`doctor` check `git-remote`).
- `python3` — the interpreter the hooks run under (`doctor` check `python3`).

**Hard versus soft.** `terminal` is hard for every command that runs anything; `gh`
and `network` are hard for every command that pushes, opens or merges a PR, or files
an issue. `ask-questions`, `browser`, `code`, and `python3` are soft: the command
proceeds with the fallback. A hard need unmet → the §9 preflight rejection receipt;
a soft need unmet → the §9 `Preflight:` line, then proceed.

**Standard fallbacks** (declared once here; `Fallback:` lines cite them, never
restate them):

- `terminal` unavailable → reject: "switch to Agent mode and re-send the command";
  no partial help in Plan or Ask mode.
- `ask-questions` unavailable → ask the same questions as a numbered list in chat,
  end the turn, wait for the reply, and retain the answers verbatim in the artifact.
- `browser` unavailable → run the step's `verify:` headless (curl, CLI, tests) where
  faithful; otherwise report the step blocked per §2 and pause. Never silently skip.
- `code` unavailable → keep the worktree and print `code --new-window
  <worktree-path>` for the user to run.
- `python3` unavailable → hooks do not run (no delivery guard, no SessionStart
  context); proceed with care and apply this policy by hand.
- `gh` missing or unauthenticated → reject; the user installs GitHub CLI or runs
  `gh auth login` in their own terminal (§1), then re-sends the command.
- `network` unreachable → `doctor` reports `warn`; fetch/push/PR steps are retried
  before the turn ends and the command pauses if they still fail.

**Declaration contract.** Every prompt (`.github/prompts/*.prompt.md`) and agent
(`.github/agents/*.agent.md`) opens its body with exactly two lines:

```
Needs: <capability>[, <capability>…]
Fallback: <one clause per soft need naming the §10 standard fallback, or "none — every need is hard">
```

followed by a one-sentence pointer to this section. Tokens come from the vocabulary
above; the CLI's `doctor --for <command>` table lists the same needs for every
command, and `tests/customizations.test.mjs` fails on any disagreement.

**When `doctor` runs.** A command whose `Needs:` include `gh`, `code`, or `network`
runs `node <agento-root>/scripts/agento.mjs doctor --for <command>` before its first
write. Overall `fail` (exit 3) → the §9 preflight rejection receipt quoting the
failing check's `detail` and `fallback`; `warn` (exit 0) → one `Preflight:` line per
warning check, then proceed. Terminal-only commands and `/agento doctor` itself skip
the call; `doctor` reports and never repairs (no installs, no logins — §1).

## 11. Window check

Which window a command runs in is data, not prose. Every command and agent carries one
line of the form `Window check per §11: requires role <roles>` and applies this
procedure before reading delivery state or writing anything; the roles table itself
lives in the CLI (`deriveAllowed`), never here or in a prompt.

1. Run `node <agento-root>/scripts/agento.mjs session` (the SessionStart hook's
   `Session:` line is a hint; the CLI call is the check). The record carries `role`
   (`primary` | `plan` | `build` | `freehand` | `unmanaged`), `hosted`, `worktree`
   (`path`, `branch`, `detached`, `isPrimary`, `isManaged`, `dirPrefix`, `id`),
   `worktrees[]` (every registered checkout classified the same way), `delivery`,
   `lifecycle`, `allowed[]`, `elsewhere[]`, and `warnings[]`.
2. Compare `role` with the roles the command's line names. Match → proceed; from here
   on the record's `worktree`, `delivery`, and `worktrees[]` replace any further
   worktree inspection. Only commands that create or remove worktrees
   (`/agento start-session`, `/agento start-freehand`, `/agento close-session`, and
   `/agento ship` for its post-merge teardown) may additionally
   read `git worktree list --porcelain` — in companion mode also the companion
   clone's, `git -C <companion> worktree list --porcelain`, for the paired half —
   and only for that mutation. Ownership of a
   delivery branch comes from `worktrees[]` or from `close-decision` /
   `ship-preflight` `owner` (`{ path, role, dirPrefix, id } | null`; reasons
   `managed-worktree-present`, `primary-owns-branch`, `remote-roadmap-only`).
3. Mismatch → the §9 `rejected` receipt with reason `wrong window: role=<role>
   (<worktree.path>, branch <worktree.branch|detached>)` and the alternatives copied
   from the record per §9. `role: unmanaged` always rejects delivery commands
   (its `allowed[]` is empty by design) and the rejection adds the fix: open the
   primary checkout at `worktrees[0].path`, or one of the managed entries in
   `worktrees[]`. Never carve out an exception for being on `main`.
4. `hosted: true` (Codespaces, Actions, the coding agent) is not an exemption anyone
   remembers: the record has already derived `role` from the branch alone and said
   so in `warnings[]`; commands treat a hosted record like any other.
5. A requirement with a branch condition — `primary` on a non-default branch
   (`/agento commit-current-changes`); `primary` on the default branch, clean
   (`/agento quick-fix`, `/agento new-initiative`, `/agento start-session`,
   `/agento start-freehand`); build-window commands whose `delivery.slug` must equal
   the argument — states it on the same line and checks it from the record's
   `worktree.branch` and `delivery`, never from a fresh `git branch` reading.

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

**Where it does not apply.** Descriptive mentions — what a command does, what an agent
never runs, the redirect sentence, table rows, headers — stay inline in backticks.
Repository prose (README, docs, templates, AGENTS.md) is out of scope and keeps inline
code. Shell commands the *agent* runs itself (§1) are its own work, never presented
to the user as blocks.

**Ordering.** Several blocks appear in execution order, each preceded by exactly one
line saying where or when to run it (for example "In this window:" or "From the
primary window, after approval:").
