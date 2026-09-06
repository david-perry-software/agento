# Slash commands

| Command | Agent | Purpose |
|---|---|---|
| `/agento-init` | default | Scaffold Agento into the current project (config, artifact dirs, AGENTS.md section, CI poller) |
| `/install-skills` | default | Detect the project stack, propose matching agent skills, install approved ones, update the AGENTS.md skills table |
| `/start-session [type/slug \| session-id] [--resume] [--no-open]` | default | Create/resume an isolated sibling worktree + new VS Code window (plan mode or build mode) |
| `/new-feature <description>` | 📋 Agento Planner | Research, ask clarifying questions, write plan.md + roadmap.md, publish branch + draft PR |
| `/new-issue <description>` | 📋 Agento Planner | Verify the defect, file a GitHub issue, plan with an exposing regression test |
| `/build-feature <slug>` · `/build-issue <slug>` | 🔨 Agento Builder | Execute roadmap steps with verification; commit + push each step |
| `/review-feature <slug>` · `/review-issue <slug>` | 🔍 Agento Reviewer | Score the acceptance checklist, audit the roadmap, write review.md |
| `/ap <slug>` | 🤖 Agento Autopilot | Unattended build → review → fix loop (stops at approve, manual steps, or auth failures — never ships) |
| `/ship <slug>` | default | Acceptance gate: required checks green, merge PR, sync main, optional release workflow, post-ship epilogue |
| `/close-session <session-id \| type/slug \| changes/slug>` | default | Remove the worktree, delete merged branches, verify state |
| `/quick-fix <description>` | default | Lite tier: small change in the current window — branch, implement, verify, PR, checks, merge; refuses work that needs a plan |
| `/start-freehand <slug>` | default | Lightweight `changes/<slug>` worktree, no artifacts |
| `/finish-freehand` | default | Commit, PR, merge freehand work |
| `/commit-current-changes` | default | Commit everything on the current worktree, PR, merge |
| `/delivery-status` | default | Dashboard of all roadmaps: status, PR, checkbox progress, next action |
| `/triage-followups` | default | File review follow-ups as GitHub issues; annotate sources with `→ filed as #<n>` |
| `/extend-copilot` · `/fix-copilot` | 🛠️ Agento Mechanic | Extend or repair the customization system itself |

Prompts never re-derive slug resolution or config lookups in prose; they call the
**Agento CLI** — `node <agento-root>/scripts/agento.mjs` — whose path the SessionStart
hook announces as `Agento CLI:`. Subcommands: `config`, `resolve <type> <slug>`,
`find <slug>`, `status [type] [slug]`, `close-decision <type> <slug>`,
`ship-preflight <type> <slug>`, `paths <kind> <id>`, `ports <slug>`,
`initiative [<slug>]` (list every breakdown with progress counts, or derive one
initiative's per-feature state, `blockedBy`, waves, `next`, validation `errors`, and
`anomalies` from its member roadmaps). Every call prints one JSON document; exit 0 =
usable result, 3 = resolution failure (`missing`, `conflict`, `branch-mismatch`,
`invalid` breakdown), 1 = usage error.

## The standard flow

```text
/start-session                 → plan-<id> worktree, new window
/new-feature add export to csv → plan + roadmap + draft PR
/handoff "Build in this worktree" or /start-session feature/<slug> from the primary window
/build-feature <slug>          → steps executed, verified, committed, pushed
/review-feature <slug>         → review.md verdict
/ship <slug>                   → merged, main synced, epilogue
/close-session feature/<slug>  → worktree removed
```

## Choosing a tier

| Work | Command |
|---|---|
| Typo, doc fix, one-file obvious bug, config tweak, dependency bump | `/quick-fix` — one window, verified, PR, merged |
| Exploratory or multi-commit scratch work that still needs no plan | `/start-freehand` → `/finish-freehand` |
| Anything with a design decision, several files, a user-facing feature, a schema/API change, or manual verification | `/start-session` → `/new-feature` / `/new-issue` |
