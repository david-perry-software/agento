# Slash commands

| Command | Agent | Purpose |
|---|---|---|
| `/agento agento-init` | default | Scaffold Agento into the current project (companion artifact repository created and cloned, config, AGENTS.md section, CI poller) |
| `/agento install-skills` | default | Detect the project stack, propose matching agent skills, install approved ones, update the AGENTS.md skills table |
| `/agento start-session [type/slug \| session-id] [--resume] [--no-open]` | default | Create/resume an isolated sibling worktree + new VS Code window (plan mode or build mode) |
| `/agento new-feature <description>` | 📋 Agento Planner | Research, ask clarifying questions, write plan.md + roadmap.md, publish branch + draft PR |
| `/agento new-issue <description>` | 📋 Agento Planner | Verify the defect, file a GitHub issue, plan with an exposing regression test |
| `/agento new-initiative <brief \| path>` | 🏛️ Agento Architect | Clarify and decompose a large brief into 2–8 independently shippable features; write `brief.md` + `breakdown.md`; publish through a merged PR from the primary window |
| `/agento next-feature <initiative-slug>` | default | Read-only report of an initiative's members (ready, blocked with `blockedBy`, in flight, complete, anomalies), the CLI's `next`, and the exact `/agento start-session` → `/agento new-feature initiative:<i>/<f>` commands to plan it |
| `/agento build-feature <slug>` · `/agento build-issue <slug>` | 🔨 Agento Builder | Execute roadmap steps with verification; commit + push each step |
| `/agento review-feature <slug>` · `/agento review-issue <slug>` | 🔍 Agento Reviewer | Score the acceptance checklist, audit the roadmap, write review.md |
| `/agento ap <slug>` | 🤖 Agento Autopilot | Unattended build → review → fix loop (stops at approve, manual steps, or auth failures — never ships) |
| `/agento ship <slug>` | default | Acceptance gate: audit in place while the build worktree is open, reject back to that window on a real gap, else required checks green, merge PR, sync main, optional release workflow, tear the worktree down, post-ship epilogue |
| `/agento continue [<slug>]` | default | Derive the one legal next transition from the session record (`agento.mjs next`) and perform it: build, review, or ship here by following that command's own prompt and agent files, or open the worktree window that owns the next step and name the command for it; rejects with the choices when several deliveries are in flight |
| `/agento close-session <session-id \| type/slug \| changes/slug>` | default | Remove a plan/freehand worktree or abandon a build (ship tears down finished builds) |
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
hook announces as `Agento CLI:`. Subcommands: `config` (the merged config with
`worktrees.dir` and `artifacts.repo.dir` resolved to absolute paths, plus
`artifactsRoot` — the checkout the artifact roots are read from: the repository
itself, or the sibling companion checkout when `artifacts.repo` is set),
`resolve <type> <slug>`,
`find <slug>`, `status [type] [slug]`, `close-decision <type> <slug>` and
`ship-preflight <type> <slug> [--pr]` (both report `owner` — `{ path, role, dirPrefix, id }`
or `null` — for the delivery branch, resolved exactly from `git worktree list
--porcelain`; `close-decision` reasons are `managed-worktree-present`,
`primary-owns-branch` (return the primary to the default branch first — nothing to
remove), or `remote-roadmap-only`; in companion mode both add `companion` — `{ path,
branch, detached, dirty, ahead, behind, registered }` for the owner's companion half or
`null` — and `close-decision` stops with `status: "error", reason: "companion-unpushed"`
while that half is dirty, ahead of, or behind its upstream, where `ship-preflight`
lists the same conditions as `companionGaps[]` (`dirty`, `unpushed`, `behind`);
`ship-preflight --pr` additionally looks up the branch's PR via `gh` as `pr`, in
companion mode the same branch name in the companion clone as `companionPr`
(`null` with no extra `gh` call in the in-repo layout), reports lookup failures in
`warnings[]`, and appends the companion PR's problems to `companionGaps[]` —
`missing-pr` (no companion PR), `pr-not-open` (`CLOSED`), `conflicting-pr`
(`mergeStateStatus: CONFLICTING`); a `MERGED` companion PR is not a gap), `paths <kind> <id>`
(worktree and branch names plus `artifactsRoot` and the absolute `artifactRoot`
under it; in companion mode also `companion: { worktreesDir, worktree, branch }` —
the paired half at `<artifacts.repo.dir>-worktrees/<kind>-<id>` — and `workspace`,
the `<worktrees.dir>/<kind>-<id>.code-workspace` file the pair opens as; both `null`
in the in-repo layout), `ports <slug>`,
`session [--pr]` (the window's `role` — `primary`, `plan`, `build`, `freehand`, or
`unmanaged` — its worktree, a `hosted` flag (`true` under `CODESPACES=true` or
`GITHUB_ACTIONS=true`, where the role is derived from the branch alone and
`warnings[]` says so), `worktrees[]` with every registered checkout classified the
same way (each tagged `repo: "product" | "companion"`; companion halves follow every
product entry, so `worktrees[0]` is always the product primary), the active delivery
and its `lifecycle`, and the `allowed` and `elsewhere` commands; in companion mode
also `companion` — the current session's half `{ path, branch, detached, dirty,
ahead, behind, registered }` — and `workspace: { path, exists }`, both `null` from the
primary or in the in-repo layout; a cwd inside a companion half or the companion
clone is anchored on its product checkout and yields the same record, with an
`anchored-from-companion` entry in `warnings[]`; `--pr` adds the branch's PR via `gh`,
degrading to `pr: null` plus a warning when `gh` is absent, and in companion mode also
`companionPr` — the same branch name looked up with `gh pr view` in the companion
clone, degrading to `null` plus a `companionPr:` warning the same way; always `null`
with no extra `gh` call in the in-repo layout; a `MERGED` `pr` beside an `OPEN`
`companionPr` adds a `companion-pr-open` warning, the half-shipped state `/agento
ship` resumes from),
`initiative [<slug>]` (list every breakdown with progress counts, or derive one
initiative's per-feature state, `blockedBy`, waves, `next`, validation `errors`, and
`anomalies` from its member roadmaps),
`doctor [--for <command>]` (seven environment checks — `node`, `git-remote`, `gh`,
`code`, `python3`, `worktrees-dir`, `artifact-repo` — each `{ id, status, detail, fallback }` with
`status` ∈ `ok | warn | fail`; `artifact-repo` also warns when the companion's
`<dir>-worktrees` directory exists but is not writable; `--for` runs only the checks
the named command's `Needs:` line requires and echoes them as `for.needs`),
`next [<slug>]` (the one legal delivery transition derived from the same record as
`session` plus roadmap ownership, review freshness, and initiative readiness:
`status` ∈ `ok | none | ambiguous | blocked | unsupported | missing`, `next`
`{ command, args, invocation, window: here | primary | secondary, then, reason }`,
`candidates[]`, and `dispatch { prompt, agent }` — the absolute paths of the command
file and its agent file; never `/agento ap`; never fetches). Every call prints one JSON
document; exit 0 = usable result (`doctor`: `ok` or `warn`; `next`: `ok` or `none`),
3 = resolution failure
(`missing`, `conflict`, `branch-mismatch`, `invalid` breakdown, `doctor` `fail`,
`next` `ambiguous | blocked | unsupported | missing`),
1 = usage error. Every window-sensitive command runs `session` first and compares
`role` with its `Window check per §11: requires role …` line (policy §11); a mismatch
is a `rejected` receipt listing the record's alternatives.

### Mirrored artifact branches (companion mode)

With `artifacts.repo` set, a delivery is one slug on two branches of the same name:
the product repository's `feature/<slug>` (or `issue/<slug>`) carries the code, the
companion repository's `feature/<slug>` carries `plan.md`, `roadmap.md`, `review.md`,
and `evidence/`. The Planner creates the companion branch right after the product
branch (`git -C <companion.path> switch -c <branch>` from the plan half's detached
`origin/<default>`), pushes it, and opens two draft PRs — the code PR to the
product default branch and a companion PR titled `docs(<type>): <slug>` — cross-linked
in their bodies; the companion PR's number lands in the roadmap header as
`artifact-pr: "#<n>"`. Every describe record that reads a roadmap (`status`,
`resolve`, `find`, `session.delivery`, `initiative` members, `next` and its
`candidates[]`) carries that header as `artifactPr` (`null` when absent), and
`resolve`/`find`/`next` read a roadmap that exists only on the companion's
`origin/<branch>` with `source: remote`. `session` and `next` read the delivery
roadmap from the registered companion half (its working tree on the mirrored branch
takes precedence over the companion clone's same-path copy), so a pair whose roadmap
lives only on the branch still reports `delivery`, `lifecycle`, and the build/review
commands in `allowed[]`. Builder and Reviewer commit artifacts with `git -C
<companion.path>` (policy §7 two-commit rule); the Architect, `/agento
triage-followups`, and `/agento delivery-status` run from the primary window, where
the session record's `companion` is `null` by design, so they detect companion mode
from `agento.mjs config` (`artifactsRoot` ≠ `root`), address the clone as
`artifactsRoot`, and run `gh` from inside it (or with `--repo` set to the
`nameWithOwner` derived there — `artifacts.repo.name` is a directory basename, not a
`gh --repo` value); `/agento delivery-status` shows `companionPr` beside `pr`.
`/agento ship` consumes the `artifact-pr` header end to end: it audits with
`ship-preflight --pr`, reads the artifacts from the companion's `origin/<branch>`,
commits `status: complete` in the companion half, marks both PRs ready, merges the
code PR first (its required checks are the gate) and then the companion PR from
inside the clone, syncs both default branches, tears down both halves and the
`.code-workspace` file, and lands any post-ship evidence on the companion's
`post-ship/<slug>`. A companion merge that fails after the code merge is a
resumable stop: re-sending `/agento ship <slug>` sees `pr: MERGED` and
`companionPr: OPEN` and resumes at the companion merge.

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
- `/agento continue`
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
/agento ship <slug>                   → audited in place, merged, main synced, worktree removed, epilogue
```

Every arrow after the plan is also `/agento continue [<slug>]`: from the secondary
window it runs the build or review step that is legal now; after `Verdict: approve` it
opens the primary window and names `/agento ship <slug>`; from the primary it reopens
the worktree window of the one delivery in flight (`/agento start-session … --resume`)
and names `/agento continue <slug>` for it. Exactly one transition per invocation;
with several deliveries in flight it lists them as `/agento continue <slug>` choices.

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
/agento build-feature <f> → /agento review-feature <f> → /agento ship <f>  (ship tears the worktree down)
/agento next-feature <initiative-slug>          → repeat until `done: true`
```

`/agento continue` covers this flow too: from the primary with no delivery in flight
and exactly one `ready` member it starts the plan session and names
`/agento continue <f>` for the new window, where it derives
`/agento new-feature initiative:<i>/<f>`; the build, review, and ship arrows follow as
in the standard flow.

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
