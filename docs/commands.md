# Slash commands

| Command | Agent | Purpose |
|---|---|---|
| `/agento agento-init` | default | Scaffold Agento into the current project (config, artifact dirs, AGENTS.md section, CI poller) |
| `/agento install-skills` | default | Detect the project stack, propose matching agent skills, install approved ones, update the AGENTS.md skills table |
| `/agento start-session [type/slug \| session-id] [--resume] [--no-open]` | default | Create/resume an isolated sibling worktree + new VS Code window (plan mode or build mode) |
| `/agento new-feature <description>` | 📋 Agento Planner | Research, ask clarifying questions, write plan.md + roadmap.md, publish branch + draft PR |
| `/agento new-issue <description>` | 📋 Agento Planner | Verify the defect, file a GitHub issue, plan with an exposing regression test |
| `/agento new-initiative <brief \| path>` | 🏛️ Agento Architect | Clarify and decompose a large brief into 2–8 independently shippable features; write `brief.md` + `breakdown.md`; publish through a merged PR from the primary window |
| `/agento next-feature <initiative-slug>` | default | Read-only report of an initiative's members (ready, blocked with `blockedBy`, in flight, complete, anomalies), the CLI's `next`, and the exact `/agento start-session` → `/agento new-feature initiative:<i>/<f>` commands to plan it |
| `/agento build-feature <slug>` · `/agento build-issue <slug>` | 🔨 Agento Builder | Execute roadmap steps with verification; commit + push each step |
| `/agento review-feature <slug>` · `/agento review-issue <slug>` | 🔍 Agento Reviewer | Score the acceptance checklist, audit the roadmap, write review.md |
| `/agento ap <slug>` | 🤖 Agento Autopilot | Unattended build → review → fix loop (stops at approve, manual steps, or auth failures — never ships) |
| `/agento ship <slug>` | default | Acceptance gate: required checks green, merge PR, sync main, optional release workflow, post-ship epilogue |
| `/agento close-session <session-id \| type/slug \| changes/slug>` | default | Remove the worktree, delete merged branches, verify state |
| `/agento quick-fix <description>` | default | Lite tier: small change in the current window — branch, implement, verify, PR, checks, merge; refuses work that needs a plan |
| `/agento start-freehand <slug>` | default | Lightweight `changes/<slug>` worktree, no artifacts |
| `/agento finish-freehand` | default | Commit, PR, merge freehand work |
| `/agento commit-current-changes` | default | Commit everything on the current worktree, PR, merge |
| `/agento delivery-status` | default | Dashboard of all roadmaps: status, PR, checkbox progress, next action |
| `/agento doctor [--for <command>]` | default | Environment readiness: Node, git remote, gh auth, code CLI, python3, worktrees dir — each with status and fallback; fixes nothing |
| `/agento triage-followups` | default | File review follow-ups as GitHub issues; annotate sources with `→ filed as #<n>` |
| `/agento extend-copilot` · `/agento fix-copilot` | 🛠️ Agento Mechanic | Extend or repair the customization system itself |

Prompts never re-derive slug resolution or config lookups in prose; they call the
**Agento CLI** — `node <agento-root>/scripts/agento.mjs` — whose path the SessionStart
hook announces as `Agento CLI:`. Subcommands: `config`, `resolve <type> <slug>`,
`find <slug>`, `status [type] [slug]`, `close-decision <type> <slug>`,
`ship-preflight <type> <slug>`, `paths <kind> <id>`, `ports <slug>`,
`session [--pr]` (the window's `role` — `primary`, `plan`, `build`, `freehand`, or
`unmanaged` — its worktree, the active delivery and its `lifecycle`, and the `allowed`
and `elsewhere` commands; `--pr` adds the branch's PR via `gh`, degrading to
`pr: null` plus a warning when `gh` is absent),
`initiative [<slug>]` (list every breakdown with progress counts, or derive one
initiative's per-feature state, `blockedBy`, waves, `next`, validation `errors`, and
`anomalies` from its member roadmaps),
`doctor [--for <command>]` (six environment checks — `node`, `git-remote`, `gh`,
`code`, `python3`, `worktrees-dir` — each `{ id, status, detail, fallback }` with
`status` ∈ `ok | warn | fail`; `--for` runs only the checks the named command's
`Needs:` line requires and echoes them as `for.needs`). Every call prints one JSON
document; exit 0 = usable result (`doctor`: `ok` or `warn`), 3 = resolution failure
(`missing`, `conflict`, `branch-mismatch`, `invalid` breakdown, `doctor` `fail`),
1 = usage error.

## Invocation

Every command has one spelling, `/agento <name> [args]`. The canonical names are:

- `/agento agento-init`
- `/agento install-skills`
- `/agento start-session`
- `/agento new-feature`
- `/agento new-issue`
- `/agento new-initiative`
- `/agento next-feature`
- `/agento build-feature`
- `/agento build-issue`
- `/agento review-feature`
- `/agento review-issue`
- `/agento ap`
- `/agento ship`
- `/agento close-session`
- `/agento quick-fix`
- `/agento start-freehand`
- `/agento finish-freehand`
- `/agento commit-current-changes`
- `/agento delivery-status`
- `/agento doctor`
- `/agento triage-followups`
- `/agento extend-copilot`
- `/agento fix-copilot`

Old forms are read as the canonical command — the agent says which in one sentence and
proceeds, arguments unchanged, without asking for confirmation — per
[command-invocation.instructions.md](../.github/instructions/command-invocation.instructions.md):

| Typed | Read as |
|---|---|
| `/<name> [args]` | `/agento <name> [args]` |
| `/<name>.prompt [args]` | `/agento <name> [args]` |
| `/<name>.md [args]` | `/agento <name> [args]` |
| `/agento <name>.prompt [args]` | `/agento <name> [args]` |
| `/agento <name>.prompt.md [args]` | `/agento <name> [args]` |
| `/agento <name>.md [args]` | `/agento <name> [args]` |

## Receipts

Every command opens with one receipt line and closes with one result line, in the
fixed spellings defined once in `delivery-policy.instructions.md` §9 (execution
receipts). The receipt names a deterministic operation ID
(`<command>:<subject>:<short-sha>`); a rejection lists the alternatives from
`agento.mjs session`; the result names the resulting state and the concrete next
command. Re-sending any command is safe: §9's idempotency table says, per command,
what a duplicate submission does, all derived from git + roadmap state.

## Preflight

Every command and agent opens its body with `Needs:` (the capabilities it uses, from
the vocabulary in `delivery-policy.instructions.md` §10) and `Fallback:` (what happens
when a soft need is absent). Hard needs (`terminal`; `gh` and `network` for anything
that pushes or touches GitHub) missing produce a rejection receipt naming the
fallback instead of a half-started command; soft needs (`ask-questions`, `browser`,
`code`, `python3`) missing add one `Preflight:` line and the command proceeds with
the standard fallback. Commands that need `gh`, `code`, or `network` run
`agento.mjs doctor --for <name>` before their first write; `/agento doctor` runs the
same checks on demand and only reports — installs and logins stay with the user.

## The standard flow

```text
/agento start-session                 → plan-<id> worktree, new window
/agento new-feature add export to csv → plan + roadmap + draft PR
/handoff "Build in this worktree" or /agento start-session feature/<slug> from the primary window
/agento build-feature <slug>          → steps executed, verified, committed, pushed
/agento review-feature <slug>         → review.md verdict
/agento ship <slug>                   → merged, main synced, epilogue
/agento close-session feature/<slug>  → worktree removed
```

## The initiative flow

For a brief too large for one feature, decompose it first and then run the standard
flow once per member:

```text
/agento new-initiative <brief | path>           → primary window, on main: 🏛️ Architect clarifies, decomposes,
                                           writes brief.md + breakdown.md, publishes via a merged PR
/agento next-feature <initiative-slug>          → any window, read-only: ready / blocked / in flight / complete,
                                           the CLI's `next`, and the commands below with slugs filled in
/agento start-session                           → primary window
/agento new-feature initiative:<i>/<f>          → secondary window: Planner validates the member via
                                           `agento.mjs initiative <i>`, hard-stops unless every
                                           `Requires:` member is complete, keeps slug <f>, writes
                                           `initiative: "<i>"` in the roadmap header
/agento build-feature <f> → /agento review-feature <f> → /agento close-session feature/<f> → /agento ship <f>
/agento next-feature <initiative-slug>          → repeat until `done: true`
```

Same-wave members that are all `ready` may be planned and built concurrently, each
in its own session. The breakdown holds no checkboxes; progress is derived from the
members' roadmaps.

## Choosing a tier

| Work | Command |
|---|---|
| Typo, doc fix, one-file obvious bug, config tweak, dependency bump | `/agento quick-fix` — one window, verified, PR, merged |
| Exploratory or multi-commit scratch work that still needs no plan | `/agento start-freehand` → `/agento finish-freehand` |
| Anything with a design decision, several files, a user-facing feature, a schema/API change, or manual verification | `/agento start-session` → `/agento new-feature` / `/agento new-issue` |
| A brief too large for one feature — several dependent, independently shippable features | `/agento new-initiative` then `/agento next-feature` for each member |
