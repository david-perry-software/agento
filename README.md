# Agento

Agento is a GitHub Copilot **agent plugin** that turns "ask the AI to build a feature"
into a repeatable, resumable, reviewable delivery process for any git repository:

```text
plan  →  build  →  review  →  ship
```

Each stage is a slash command backed by a dedicated agent. Progress lives in a
committed, pushed `roadmap.md` — not in chat history — so any session can be paused,
resumed on another machine, or handed to a different agent from git state alone. A
hook-based guard stops the agent from committing to `main`, force-pushing, bypassing
hooks, or idling on open-ended watchers, and a GitHub ruleset backs it up server-side.

Nothing is copied into your project except a small config file, three artifact
directories, an `## Agento` section in your `AGENTS.md`, and one shell script.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install the plugin](#install-the-plugin)
- [Set up a project](#set-up-a-project)
- [Choose a tier](#choose-a-tier)
- [The full delivery flow](#the-full-delivery-flow)
  - [Initiatives — several features from one brief](#initiatives--several-features-from-one-brief)
- [Lighter tiers](#lighter-tiers)
- [Command reference](#command-reference)
- [Delivery artifacts](#delivery-artifacts)
- [The delivery guard](#the-delivery-guard)
- [Configuration](#configuration)
- [Working on several things at once](#working-on-several-things-at-once)
- [Verifying and troubleshooting](#verifying-and-troubleshooting)
- [Developing Agento](#developing-agento)

---

## How it works

Five ideas carry the whole system:

1. **Artifacts are the state.** Every planned unit of work gets a directory
   `features/YYYY/MM/<slug>/` (or `issues/…`) holding `plan.md`, `roadmap.md`, and
   later `review.md`. The roadmap is a checklist of small steps, each with a
   `verify:` line; a box is ticked only after its verification passes, and the tick is
   committed *with* the step's code. Resuming means reading the roadmap and auditing
   its ticks against the codebase — code is truth. A brief too large for one feature
   becomes an *initiative* (`initiatives/YYYY/MM/<slug>/`) whose `breakdown.md` names
   the member features and their dependencies; its progress is derived from the
   members' roadmaps, never ticked by hand.

2. **One agent per stage.** 🏛️ Architect decomposes a large brief into an
   initiative of member features. 📋 Planner asks clarifying questions, researches, and
   writes the plan and roadmap. 🔨 Builder executes roadmap steps with verification.
   🔍 Reviewer scores the plan's acceptance checklist and writes a verdict.
   🤖 Autopilot loops Builder → Reviewer unattended. 🛠️ Mechanic repairs and extends
   the plugin itself. Each agent's rules are short; the shared policy (who does what,
   verification targets, evidence, git rules) lives once in
   `.github/instructions/delivery-policy.instructions.md`.

3. **One worktree per session.** Planning and building happen in a *secondary*
   VS Code window on a sibling git worktree; shipping and cleanup happen in the
   *primary* window on `main`. Several deliveries can run side by side without
   stepping on each other's branches, ports, or working trees.

4. **Deterministic helpers, not prose.** Slug resolution, status listings, worktree
   paths, and config lookups go through `scripts/agento.mjs`, a small Node CLI the
   prompts call. The model never re-derives "find the roadmap" from a description.

5. **Guard + ruleset.** A `PreToolUse` hook inspects every shell command and file
   edit the agent attempts and answers `allow`, `ask`, or `deny`. It is a slip guard
   for the model; the enforcement boundary is a GitHub ruleset on your default branch,
   which `/agento-init` checks for and offers to create.

Read more: [Architecture](docs/architecture.md).

## Requirements

- **VS Code** with GitHub Copilot (agent mode) and `chat.plugins.enabled: true`. The
  session model opens a second VS Code window via the `code` CLI; the Copilot CLI can
  run the prompts, but the window choreography is VS Code-specific.
- **Linux or macOS.** Hooks are Bash + `python3`. Windows is untested.
- **`git`**, **`gh`** (authenticated, with permission to open and merge PRs in the
  target repo), **`node` ≥ 20**, **`python3`** on `PATH`.
- A **GitHub repository** for the project. Agento's flow is PR-based end to end.

## Install the plugin

Pick one. All three register the same plugin; a local clone is easiest to update and
fork.

**A — local clone (recommended)**

```bash
git clone https://github.com/david-perry-software/agento ~/code/agento
```

VS Code settings (user-level so it applies to every project):

```jsonc
"chat.plugins.enabled": true,
"chat.pluginLocations": { "~/code/agento": true }
```

Update with `git pull`.

**B — install from source**
Command Palette → *Chat: Install Plugin From Source* →
`https://github.com/david-perry-software/agento`.

**C — Copilot CLI**

```bash
copilot plugin install david-perry-software/agento
```

Full details and the developer-mode caveat: [docs/install.md](docs/install.md).

## Set up a project

Open your project in VS Code and run, in a new chat:

```text
/agento-init
```

It scaffolds, on a `changes/agento-init` branch with a PR:

| Created | Purpose |
|---|---|
| `.github/agento.json` | Machine-readable config: artifact roots, worktree dir, branch names, optional release workflow |
| `features/`, `issues/` | Artifact roots (with `.gitkeep`) |
| `AGENTS.md` `## Agento` section | Your project's facts for the agents: install/test/lint/typecheck commands, how to verify locally, shared resources, the skills table |
| `scripts/wait-for-checks.sh` | Bounded CI poller the prompts use instead of `gh … --watch` |

It also checks whether your default branch has a **GitHub ruleset** (require PR,
required checks, no force-push, no deletion) and offers to create one. Say yes — the
delivery guard alone is not protection.

Then, optionally:

```text
/install-skills
```

detects your stack (Next.js, Postgres, Playwright, …), proposes matching agent
skills from the skills registry, installs the ones you approve into
`.agents/skills/`, and fills the `### Skills` table. Agents load the matching skill
before working in that domain.

Fill in the `## Agento` section honestly — the agents quote its commands in plans and
run them in `verify:` steps. See [Project profile](docs/project-profile.md) and the
[worked example](examples/soshiki-profile.md).

## Choose a tier

| The change is… | Use |
|---|---|
| A typo, doc fix, one-file obvious bug, config tweak, dependency bump | `/quick-fix <what>` — one window, verified, PR, merged |
| Exploratory or multi-commit scratch work that still needs no plan | `/start-freehand` → work → `/finish-freehand` |
| Anything with a design decision, several files, a user-facing feature, a schema/API change, or manual verification | The full flow below |

`/quick-fix` refuses work that needs a plan and names the right command instead.

## The full delivery flow

Every step says which window you are in. "Primary" is your normal checkout on `main`;
"secondary" is the worktree window Agento opens for you.

### 1. Start a planning session — primary window

```text
/start-session
```

Creates a detached worktree at `../<repo>-worktrees/plan-<timestamp>` from
`origin/main` and opens it in a new VS Code window. Nothing is branched yet.

### 2. Plan — secondary window

```text
/new-feature add CSV export to the reports page
```

or, for a defect:

```text
/new-issue export button 500s when the report is empty
```

The 📋 Planner:

- asks 3–5 clarifying questions and records your answers verbatim;
- researches the codebase, loads the matching skills, runs your full-repo lint to
  record a baseline, and lists open PRs that touch the same files;
- for issues, **reproduces the defect first**, captures evidence, and files (or links)
  a GitHub issue;
- derives a slug, creates `feature/<slug>` (or `issue/<slug>`), writes `plan.md` and
  `roadmap.md`, commits, pushes, and opens a **draft PR**.

Each roadmap step names how it will be verified and, for user-visible behavior, the
target: `local:<ports>` (default), `dev-stack`, or `preview: <reason>`. Steps only a
human can perform — secrets, dashboards the agent can't reach, approvals — are marked
`(manual)`; anything runnable from a shell or a browser is the agent's job.

The Planner ends by offering the **Build in this worktree** handoff.

### 3. Build — secondary window

Accept the handoff, or run:

```text
/build-feature <slug>        # or /build-issue <slug>
```

The 🔨 Builder runs its resume protocol (fetch, confirm branch ownership, integrate
`origin/main`, audit every ticked box against the code), then for each unchecked
step: load the skill → implement → run `verify:` → tick → commit step + roadmap
together → merge `origin/main` if needed → push.

- Reaching a `(manual)` step, it stops, gives you exact instructions, and waits for a
  confirming screenshot, which it saves under `evidence/` and links from the step.
- Say "pause" at any point: it finishes or reverts the in-flight step, sets
  `status: paused` with a precise `next-step`, and pushes. Resume later with the same
  command from any machine.
- When everything is ticked it sets `status: in-review` and offers the review handoff.

**Unattended alternative:**

```text
/ap <slug>
```

🤖 Autopilot drives Builder → Reviewer → fix → Reviewer for up to three review
rounds, stopping on approval, on any `(manual)` step, on an auth failure, or at the
cap. It never ships.

### 4. Review — secondary window

```text
/review-feature <slug>       # or /review-issue <slug>
```

The 🔍 Reviewer reads the real diff against `origin/main`, runs the project's tests
and typecheck plus every roadmap `verify:` check itself, re-drives user-visible
behavior in the browser and takes its own screenshots, scores each acceptance item
pass/fail with evidence, audits the roadmap for falsely ticked boxes, and writes
`review.md` with `Verdict: approve` or `Verdict: request-changes`. On
request-changes it offers the Builder fix handoff; the findings become new roadmap
steps and the loop repeats.

### 5. Close the session — primary window

After `Verdict: approve`, close the secondary window and switch to the primary:

```text
/close-session feature/<slug>
```

Confirms everything is pushed, removes the worktree, and keeps the branch (it still
has an open PR).

### 6. Ship — primary window

```text
/ship <slug>
```

Audits the roadmap, review, and PR; presents every gap (unticked steps, stale or
negative review, drift) and asks before proceeding on any. On a clean audit or your
explicit yes: marks the PR ready, waits for required checks with the bounded poller,
merges with a normal merge commit through the ruleset, deletes the branch, syncs
`main`, optionally dispatches and waits on a release workflow, and completes any
`(manual, post-ship)` steps in an epilogue PR.

### Initiatives — several features from one brief

When a brief is too large for a single feature, decompose it first — primary window,
on `main`, clean tree:

```text
/new-initiative <brief text | path/to/brief.md>
```

The 🏛️ Architect asks 3–5 clarifying questions, researches, splits the brief into
2–8 independently shippable features with `Requires:` dependencies and waves, and
writes `initiatives/YYYY/MM/<slug>/brief.md` (your text verbatim) and
`breakdown.md`. It validates the result with `agento.mjs initiative <slug>`, then
publishes it itself: `changes/initiative-<slug>` branch, PR, bounded check wait,
normal merge, branch delete, `main` sync. No roadmap is created yet — an initiative
is a plan for plans.

Then, any time, in any window:

```text
/next-feature <initiative-slug>
```

A read-only report: members grouped as ready / blocked (with what blocks them) /
in flight / complete, plus anomalies, and the exact commands to plan the recommended
next member. Each member then goes through the normal flow above, with one twist in
step 2 — the Planner is told which member it is planning:

```text
/start-session                                    # primary
/new-feature initiative:<initiative-slug>/<feature-slug>   # secondary
```

The Planner validates the member through the CLI and hard-stops unless every
`Requires:` feature is `status: complete` (no override); it uses the breakdown's
`Brief:` as the description, keeps the preassigned slug, and writes
`initiative: "<initiative-slug>"` into the roadmap header. Build, review, close, and
ship exactly as for any feature. Members in the same wave that are all `ready` can be
planned and built concurrently, each in its own session. Progress is never ticked in
the breakdown; `/next-feature` and `/delivery-status` derive it from the members'
roadmaps.

### Any time

```text
/delivery-status
```

A read-only dashboard: every roadmap's status, branch, PR state, tick progress, and
recommended next command, plus anomalies (duplicate slugs, stale work, `in-review`
without a review).

```text
/triage-followups
```

Harvests `## Follow-ups` from shipped reviews and roadmaps, files them as GitHub
issues, and annotates the source lines so re-runs skip them.

## Lighter tiers

**`/quick-fix <description>`** — primary window, on `main`, clean tree. Branches to
`changes/<slug>`, implements, runs the project's focused verification, opens a PR,
waits for checks, merges, syncs `main`. Refuses anything that needs a plan.

**`/start-freehand [slug]`** — primary window. Creates a `changes/<slug>` worktree
and opens it. Work freely in the new window with the default agent. Then
**`/finish-freehand`** in that window commits, PRs, waits for checks, and merges;
**`/close-session changes/<slug>`** from the primary window removes the worktree.

**`/commit-current-changes`** — commit whatever is in the current tree on a
`changes/*` branch, PR, wait, merge. Used by Agento's own development and by the
Mechanic.

## Command reference

| Command | Window | Agent | Purpose |
|---|---|---|---|
| `/agento-init [--force]` | primary | default | Scaffold config, artifact roots, AGENTS.md section, CI poller; check for a ruleset |
| `/install-skills` | primary | default | Detect stack, propose skills, install approved ones, update the skills table |
| `/start-session [type/slug \| id] [--resume] [--no-open]` | primary | default | Create/resume a planning or build worktree and open a window |
| `/new-feature <description>` | secondary | 📋 Planner | Clarify, research, plan, branch, draft PR |
| `/new-issue <description \| #n \| url>` | secondary | 📋 Planner | Reproduce, file/link GitHub issue, plan around an exposing test |
| `/new-initiative <brief \| path>` | primary | 🏛️ Architect | Decompose a large brief into member features; publish `brief.md` + `breakdown.md` via a merged PR |
| `/next-feature <initiative-slug>` | any | default | Read-only: ready/blocked/in-flight/complete members, the recommended next feature, and the commands to plan it |
| `/build-feature <slug>` · `/build-issue <slug>` | secondary | 🔨 Builder | Execute roadmap steps with verification; commit + push each |
| `/review-feature <slug>` · `/review-issue <slug>` | secondary | 🔍 Reviewer | Score acceptance, audit roadmap, write verdict |
| `/ap <slug>` | secondary | 🤖 Autopilot | Unattended build → review → fix loop; never ships |
| `/close-session <type/slug \| changes/slug \| id>` | primary | default | Remove a clean, pushed worktree |
| `/ship <slug>` | primary | default | Audit, warn, mark ready, wait, merge, sync, release, epilogue |
| `/quick-fix <description>` | primary | default | Plan-less small change: branch, verify, PR, merge |
| `/start-freehand [slug]` · `/finish-freehand` | primary · secondary | default | Scratch worktree without artifacts; publish it |
| `/commit-current-changes` | any | default | Commit current tree via `changes/*` PR and merge |
| `/delivery-status [filter]` | any | default | Read-only dashboard |
| `/triage-followups [slug]` | primary | default | File follow-ups as issues, annotate sources |
| `/extend-copilot` · `/fix-copilot` | any | 🛠️ Mechanic | Add or repair prompts, agents, instructions, hooks, skills |

Full descriptions: [docs/commands.md](docs/commands.md).

## Delivery artifacts

```text
features/2026/09/csv-export/
├── plan.md        Problem · Decisions · Research · Approach · Risks · Out of scope · Acceptance checklist
├── roadmap.md     YAML header (status, branch, last-updated, next-step, optional initiative) + phases of checkbox steps
├── review.md      Verdict + checklist scoring + roadmap audit + findings + follow-ups
└── evidence/      step-N-M-<name>.png for manual and browser-driven checks

initiatives/2026/09/reporting-suite/
├── brief.md       Source: line + the original brief, verbatim
└── breakdown.md   YAML header + Goal · Decisions · Research · Features (slug, Requires, Brief) · Recommended order · Risks · Definition of done
```

An initiative holds no checkboxes: its progress (per-member state, blockers, waves,
the recommended `next`) is derived by `agento.mjs initiative <slug>` from the member
roadmaps that carry `initiative: "<slug>"` in their header.

Roadmap header statuses: `planned → in-progress → paused → in-review → complete`.
Step syntax:

```markdown
- [ ] 2.3 Add the export button to ReportToolbar — verify: local:3174 shows the button; `pnpm test reports` passes
- [ ] 2.4 (manual) Add EXPORT_BUCKET to the Vercel project env — verify: `vercel env ls` lists it
```

Steps are never deleted (obsolete ones are struck through), discovered work is
appended with `(added <date>)`, and issues must add a regression test that is
observed **failing** before the fix. Exact contract:
[docs/artifacts.md](docs/artifacts.md) and
`.github/instructions/delivery-artifacts.instructions.md`.

## The delivery guard

Two hooks run outside the model on every session:

- **SessionStart** injects the current branch, any resumable roadmaps with their
  `next-step`, and the path of the Agento CLI.
- **PreToolUse** inspects each shell command and file edit and returns `allow`,
  `ask`, or `deny`. It denies commits/pushes/merges on the default branch (including
  after a `git switch main` earlier in the same line), force-pushes in every
  spelling, `--no-verify`, `gh pr merge --admin`, open-ended watchers, and shell
  writes to hook files; it asks before `--amend`, `rebase`, `reset --hard`, editing
  a hook file, or committing delivery work without a roadmap update.

It matches shell text, so it catches the mistakes agents actually make; a determined
command can be spelled around it. That is why the GitHub ruleset is required. Full
rule table and testing notes: [docs/hooks.md](docs/hooks.md).

## Configuration

**`.github/agento.json`** — every key optional; `null` keeps the default.

```json
{
  "artifacts": { "features": "features", "issues": "issues", "initiatives": "initiatives" },
  "worktrees": { "dir": null },
  "branches": {
    "default": "main",
    "feature": "feature/",
    "issue": "issue/",
    "freehand": "changes/",
    "postShip": "post-ship/"
  },
  "checks": { "releaseWorkflow": null }
}
```

`worktrees.dir: null` means a sibling `<repo-name>-worktrees/`. Set
`checks.releaseWorkflow` to a workflow file name and `/ship` will dispatch and wait
on it after merging. Hooks, the CLI, and the prompts all read this file, so a project
on `trunk` with `planning/features` works end to end.

**`AGENTS.md` `## Agento` section** — the narrative facts agents need: commands
(install/test/typecheck/lint/full verification), how to serve the app locally and
verify it, which resources are shared across sessions, and the domain → skill table.

Details: [docs/project-profile.md](docs/project-profile.md).

## Working on several things at once

Run `/start-session` as many times as you like. Each session gets its own worktree
(`plan-<id>`, `feature-<slug>`, `issue-<slug>`, `freehand-<slug>`) under the
worktrees directory, its own window, and stable per-slug ports
(`node scripts/agento.mjs ports <slug>`) so two local servers never collide. A
branch's registered worktree is its reservation — one active builder per slug.

The Builder merges `origin/main` into its branch before every push, so when several
slugs ship back to back the last one doesn't inherit everyone else's conflicts.
Shared resources (a staging backend behind previews, machine-wide databases) are
declared in your `AGENTS.md` and treated as read-only-shareable, destructive-exclusive.
Full model and conflict recipes: [docs/concurrency.md](docs/concurrency.md).

## Verifying and troubleshooting

After install, in a fresh chat in your project:

- The context should include `Current git branch: …` and
  `Agento CLI: node …/scripts/agento.mjs` — the SessionStart hook is firing.
- `/delivery-status` responds with an empty dashboard.
- Ask the agent to run `git push origin main`; the guard denies it.
- Output panel → **GitHub Copilot Chat Hooks** lists both hooks.

If commands don't appear or route to the wrong agent, run `/fix-copilot` and
describe the symptom — the Mechanic knows the usual causes (frontmatter, name
mismatches, missing tools). If you are developing Agento inside its own clone, set
`"chat.pluginLocations": { "<path>": false }` for that workspace; the repo's own
`.github/hooks/` already wires the same hooks in workspace mode.

## Developing Agento

```bash
node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'   # unit + integration suites
./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt    # guard verdicts, asserted
shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh
```

Tests cover the config loader, the roadmap resolver, the CLI, both hooks, the CI
poller (with a stubbed `gh`), and the structure of every agent/prompt/instruction
file (frontmatter validity, cross-references, docs coverage, policy single-sourcing).
Agento is developed with its own workflow — see [AGENTS.md](AGENTS.md) for the
rules, and [CHANGELOG.md](CHANGELOG.md) for what changed.

## Documentation

- [Install](docs/install.md) · [Commands](docs/commands.md) ·
  [Architecture](docs/architecture.md) · [Artifacts](docs/artifacts.md) ·
  [Hooks](docs/hooks.md) · [Concurrency](docs/concurrency.md) ·
  [Project profile](docs/project-profile.md) ·
  [Example profile](examples/soshiki-profile.md)

## License

MIT. See [LICENSE](LICENSE).
