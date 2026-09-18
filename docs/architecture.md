# Architecture

```mermaid
flowchart TD
    U[User] -->|"/agento new-initiative"| A[🏛️ Agento Architect]
    A -->|"brief.md + breakdown.md, merged PR"| INIT[(initiatives/)]
    U -->|"/agento next-feature"| INIT
    INIT -->|"/agento new-feature initiative:<i>/<f>"| P
    U -->|"/agento start-session"| SS[worktree + new window]
    U -->|"/agento new-feature · /agento new-issue"| P[📋 Agento Planner]
    P -->|plan.md + roadmap.md, draft PR| B
    U -->|"/agento build-feature · /agento build-issue"| B[🔨 Agento Builder]
    B -->|"steps + ticks + commits + pushes"| B
    B -->|handoff| R[🔍 Agento Reviewer]
    R -->|review.md: approve| SHIP[/agento ship/]
    R -->|request-changes| B
    U -->|"/agento ap"| AP[🤖 Agento Autopilot]
    AP --> B
    AP --> R
    SHIP -->|"reject: back to the open build window"| B
    SHIP -->|"merge PR, sync main, teardown, epilogue"| DONE([shipped])
    U -->|"/agento close-session (plan/freehand/abandon)"| CLOSE[remove worktree]
    U -->|"/agento continue"| CONT[agento.mjs next: one legal transition]
    CONT -->|"here: follow the command's own files"| B
    CONT -->|"here"| R
    CONT -->|"primary window"| SHIP
    CONT -->|"start-session --resume, then continue"| SS

    subgraph hooks [Hooks — every session]
        SC[session-context.sh<br/>SessionStart: branch + resumable work]
        DG[delivery-guard.sh<br/>PreToolUse: policy decisions]
    end
```

## Pieces

- **Prompts** (`.github/prompts/`) are the slash commands. They are thin: they set
  expectations and dispatch to an agent.
- **Agents** (`.github/agents/`) hold the durable behavior: the Architect's brief
  decomposition and self-contained publish, the Planner's resume protocol and
  dependency-gated initiative intake, the Builder's work loop and verification
  gates, review scoring, autopilot orchestration, and the mechanic that maintains
  the system itself.
- **Instructions** (`.github/instructions/`) are always-on contracts. The
  **delivery policy** (`delivery-policy.instructions.md`, `applyTo: "**"`) is the
  single source for the rules every role shares — who does the work, verification
  targets, manual/post-ship steps and evidence, the lint gate, shell hygiene, git
  rules, the cross-window handoff, and execution receipts with per-command
  idempotency (every command opens with a receipt line carrying a deterministic
  operation ID and closes with a result line; a duplicate submission resumes from git
  + roadmap state), capability preflight (§10: every command and agent declares
  `Needs:`/`Fallback:`; `agento.mjs doctor --for <name>` runs before the first write
  of any command needing `gh`, `code`, or `network`), and the window check (§11: every
  command names the `role` it requires and checks it against `agento.mjs session` — a
  mismatch is a `rejected` receipt with the record's alternatives; the roles table
  itself lives in the CLI); agents and prompts cite its numbered sections
  (`§2`) instead of restating them, and a test fails if a rule is spelled out twice.
  The **artifact contract** holds only formats; **concurrent-delivery** holds only
  mechanics (ports, previews, shared resources, integration recipes); **ai-skills**
  is the skills-first policy; **command-invocation** is the canonical spelling and
  redirect rule for slash commands (`/agento <name>`; old forms are read as the
  canonical command and proceed without confirmation).
- **Hooks** run outside the model. `session-context.sh` injects branch, resumable
  work, and the Agento CLI path at session start; `delivery-guard.sh` can
  `allow`/`ask`/`deny` any tool call (default-branch protection, force-push and hook
  bypasses, open-ended watchers, ruleset-bypassing merges, hook self-protection,
  worktree-occupant detection). The guard is a slip guard for the model, not an
  enforcement boundary — that is the GitHub ruleset on the default branch.
- **Scripts** are the deterministic helpers, fronted by `scripts/agento.mjs`: the
  config loader, the roadmap resolver (local search with origin fallback and
  branch-header validation), the status lister, the initiative deriver (per-member
  state, `blockedBy`, waves, and `next` computed from member roadmaps — the
  breakdown itself holds no progress), worktree path and per-slug port
  derivation, the bounded CI poller, and the guard replay harness. Prompts call the
  CLI rather than re-deriving these algorithms in prose, so the configured branch
  names and artifact roots are honoured everywhere the hooks honour them.

## Where state lives

The only durable progress record is the committed, pushed `roadmap.md` in the
**target repository** — never chat, never the plugin, never local files. Any machine
can resume any session from git state alone. The Agento clone itself holds no
per-project state.

## Configuration boundary

| Project-specific fact | Where it lives |
|---|---|
| Artifact roots, worktree dir, branch names, release workflow | target repo `.github/agento.json` (read by hooks, the resolver, and `scripts/agento.mjs`) |
| Delivery artifacts themselves (`features/`, `issues/`, `initiatives/`) | the target repo, or — when `artifacts.repo` names a sibling companion checkout — that checkout, which the CLI resolves as `artifactsRoot` against the primary checkout and `doctor` verifies (`artifact-repo`); each managed session then owns a companion half under the derived `<artifacts.repo.dir>-worktrees/<kind>-<id>` next to its product half |
| Commands, verification strategy, shared resources, skills table | target repo `AGENTS.md` `## Agento` section (read by agents) |
| Delivery policy and artifact format | the plugin (this repo) |

Where prompt text still says `main`, `features/`, `issues/`, or `initiatives/`, read
it as the configured `branches.default`, `artifacts.features`, `artifacts.issues`,
and `artifacts.initiatives`; the values the model should actually use come from
`agento.mjs config`.

**Companion-cwd anchoring.** The companion clone carries no `agento.json`, so a CLI
call whose cwd is inside the companion clone or one of its halves cannot read the
product config from its own toplevel. `agento.mjs` therefore anchors first: when the
cwd's toplevel has no `artifacts.repo` of its own, it takes that checkout's primary
(the first entry of its own `git worktree list --porcelain`), lists the primary's
parent directory once, and picks the sibling git checkout whose `.github/agento.json`
resolves `artifacts.repo.dir` to exactly that clone. Exactly one match → the record is
computed from that product (for a half `<kind>-<id>`, from the product half of the
same name when it exists) and `warnings[]` carries `anchored-from-companion`; zero
matches → today's behaviour (`unmanaged`); several → `unmanaged` plus a warning
listing them. The hooks pass `--root <cwd>` unchanged, so a terminal sitting in the
companion folder of a pair window prints the same `Session:` line as the product
folder.

**Layout rule — the checkout decides, the primary anchors.** Companion mode is on for
a checkout when *its own* `.github/agento.json` sets `artifacts.repo`; the companion
path always resolves against the primary checkout, and when the primary's config
also sets `artifacts.repo` the primary's values win. Own config unset → in-repo,
regardless of the primary (a worktree on a pre-companion branch keeps reading its own
roots). The CLI (`resolveArtifacts()`) and the Python `resolve_artifacts()` shared by
both hooks apply the same rule. On top of it, the slug-targeted readers (`resolve`,
`find`, `close-decision`, `ship-preflight`, `next <slug>`, `paths <feature|issue>
<slug>`) fall back to the **delivery branch's** config when an in-repo checkout finds
no roadmap: they read `origin/<branch>:.github/agento.json` (then `<branch>:…`) and,
when it names a companion that exists beside the primary, redo the read against that
clone and report `layout: "branch"` with `artifactsRoot` set to it. This is what lets
`/agento ship` run from a primary whose `main` is still in-repo while the migration
PR (`/agento agento-init --migrate`) is open; a branch naming an absent companion
stays `missing` — nothing is cloned implicitly.
