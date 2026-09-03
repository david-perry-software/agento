# Architecture

```mermaid
flowchart TD
    U[User] -->|"/start-session"| SS[worktree + new window]
    U -->|"/new-feature · /new-issue"| P[📋 Agento Planner]
    P -->|plan.md + roadmap.md, draft PR| B
    U -->|"/build-feature · /build-issue"| B[🔨 Agento Builder]
    B -->|"steps + ticks + commits + pushes"| B
    B -->|handoff| R[🔍 Agento Reviewer]
    R -->|review.md: approve| SHIP[/ship/]
    R -->|request-changes| B
    U -->|"/ap"| AP[🤖 Agento Autopilot]
    AP --> B
    AP --> R
    SHIP -->|merge PR, sync main, epilogue| DONE([shipped])
    U -->|"/close-session"| CLOSE[remove worktree]
    DONE --> CLOSE

    subgraph hooks [Hooks — every session]
        SC[session-context.sh<br/>SessionStart: branch + resumable work]
        DG[delivery-guard.sh<br/>PreToolUse: policy decisions]
    end
```

## Pieces

- **Prompts** (`.github/prompts/`) are the slash commands. They are thin: they set
  expectations and dispatch to an agent.
- **Agents** (`.github/agents/`) hold the durable behavior: resume protocol, work
  loop, verification gates, review scoring, autopilot orchestration, and the
  mechanic that maintains the system itself.
- **Instructions** (`.github/instructions/`) are always-on contracts: the artifact
  format, the skills-first policy, and the concurrent-delivery policy.
- **Hooks** run outside the model. `session-context.sh` injects branch + resumable
  work at session start; `delivery-guard.sh` can `allow`/`ask`/`deny` any tool call
  (default-branch protection, force-push, open-ended watchers, hook self-protection,
  worktree-occupant detection).
- **Scripts** are the deterministic helpers: the config loader, the roadmap
  resolver (local search with origin fallback and branch-header validation), the
  bounded CI poller, and the guard replay harness.

## Where state lives

The only durable progress record is the committed, pushed `roadmap.md` in the
**target repository** — never chat, never the plugin, never local files. Any machine
can resume any session from git state alone. The Agento clone itself holds no
per-project state.

## Configuration boundary

| Project-specific fact | Where it lives |
|---|---|
| Artifact roots, worktree dir, branch names, release workflow | target repo `.github/agento.json` (read by hooks + resolver) |
| Commands, verification strategy, shared resources, skills table | target repo `AGENTS.md` `## Agento` section (read by agents) |
| Delivery policy and artifact format | the plugin (this repo) |
