# Step 3.1 — `/agento continue` rehearsal against live state

Recorded 2026-09-14 by the Builder in the promoted worktree
`/home/david/DP/agento-worktrees/plan-20260915-024029` (branch
`feature/continue-command`, HEAD `d81672f`; primary `/home/david/DP/agento` on
`main` at `b2dbbda`). Each section pastes the `agento.mjs next` JSON exactly as
printed and the receipt, preflight, and result lines the
[continue prompt](../../../../../.github/prompts/continue.prompt.md) derives from it
following policy §9/§10/§11. `doctor --for continue` in this environment:
`ok` — `node:ok git-remote:ok gh:ok code:ok python3:ok worktrees-dir:ok`, so no
`Preflight:` line is emitted in any case below.

Session records used for the window check and the rejection alternatives:

- primary (`--root /home/david/DP/agento`): `role: primary`, `lifecycle: no-delivery`,
  `allowed: ["/agento continue", "/agento start-session", "/agento new-feature",
  "/agento new-issue", "/agento new-initiative", "/agento delivery-status"]`,
  `elsewhere: []`.
- this worktree: `role: build`, `lifecycle: building`, `allowed: ["/agento continue",
  "/agento build-feature continue-command", "/agento delivery-status"]`,
  `elsewhere: [{ command: "/agento ship continue-command", window: "primary" }]`.

## (a) Primary window, no slug

Command: `node scripts/agento.mjs next --root /home/david/DP/agento` → exit 0

```json
{
  "status": "ok",
  "role": "primary",
  "lifecycle": "no-delivery",
  "slug": "continue-command",
  "type": "feature",
  "next": {
    "command": "start-session",
    "args": ["feature/continue-command", "--resume"],
    "invocation": "/agento start-session feature/continue-command --resume",
    "window": "here",
    "then": "/agento continue continue-command",
    "reason": "feature/continue-command is in-progress: reopen its worktree window, then continue there"
  },
  "candidates": [],
  "reviewFresh": null,
  "dispatch": {
    "prompt": "/home/david/DP/agento-worktrees/plan-20260915-024029/commands/start-session.md",
    "agent": null
  },
  "warnings": [],
  "reason": "feature/continue-command is in-progress: reopen its worktree window, then continue there",
  "root": "/home/david/DP/agento",
  "configSource": null
}
```

Derived by the prompt (window check: `role: primary` ∈ {primary, plan, build} → proceed;
`status: ok`, `window: here` → follow `dispatch.prompt` = `commands/start-session.md`
with args `feature/continue-command --resume`; `then` set → it is the result's `next:`):

```text
Receipt: accepted continue:main:b2dbbda
Result: completed — worktree /home/david/DP/agento-worktrees/plan-20260915-024029 reopened for feature/continue-command (start-session --resume); next: /agento continue continue-command
```

The one candidate was found without a slug because this delivery is the only
non-complete roadmap visible from the primary (owned by the managed worktree, so
`--resume`).

## (b) Primary window, slug `continue-command`

Command: `node scripts/agento.mjs next continue-command --root /home/david/DP/agento` → exit 0

```json
{
  "status": "ok",
  "role": "primary",
  "lifecycle": "no-delivery",
  "slug": "continue-command",
  "type": "feature",
  "next": {
    "command": "start-session",
    "args": ["feature/continue-command", "--resume"],
    "invocation": "/agento start-session feature/continue-command --resume",
    "window": "here",
    "then": "/agento continue continue-command",
    "reason": "feature/continue-command is in-progress: reopen its worktree window, then continue there"
  },
  "candidates": [],
  "reviewFresh": null,
  "dispatch": {
    "prompt": "/home/david/DP/agento-worktrees/plan-20260915-024029/commands/start-session.md",
    "agent": null
  },
  "warnings": [],
  "reason": "feature/continue-command is in-progress: reopen its worktree window, then continue there",
  "root": "/home/david/DP/agento",
  "configSource": null
}
```

Derived by the prompt (identical transition; the op-id carries the slug as subject):

```text
Receipt: accepted continue:continue-command:b2dbbda
Result: completed — worktree /home/david/DP/agento-worktrees/plan-20260915-024029 reopened for feature/continue-command (start-session --resume); next: /agento continue continue-command
```

## (c) This promoted worktree — `in-progress`, then a temporary `in-review` header

### (c1) roadmap `status: in-progress` (as committed)

Command: `node scripts/agento.mjs next` (cwd = this worktree) → exit 0

```json
{
  "status": "ok",
  "role": "build",
  "lifecycle": "building",
  "slug": "continue-command",
  "type": "feature",
  "next": {
    "command": "build-feature",
    "args": ["continue-command"],
    "invocation": "/agento build-feature continue-command",
    "window": "here",
    "then": null,
    "reason": "roadmap status in-progress: the Builder continues in this window"
  },
  "candidates": [],
  "reviewFresh": null,
  "dispatch": {
    "prompt": "/home/david/DP/agento-worktrees/plan-20260915-024029/commands/build-feature.md",
    "agent": "/home/david/DP/agento-worktrees/plan-20260915-024029/.github/agents/delivery-builder.agent.md"
  },
  "warnings": [],
  "reason": "roadmap status in-progress: the Builder continues in this window",
  "root": "/home/david/DP/agento-worktrees/plan-20260915-024029",
  "configSource": null
}
```

Derived by the prompt (`window: here` → read `commands/build-feature.md` and
`delivery-builder.agent.md`, run the Builder's resume protocol for
`continue-command` in this window; the result line is the Builder's own, with `next:`
rewritten to the continue shorthand because a further transition — review — follows):

```text
Receipt: accepted continue:continue-command:d81672f
Result: completed — feature/continue-command status: in-progress, roadmap advanced by the Builder in this window; next: /agento continue continue-command
```

### (c2) roadmap header temporarily set to `status: in-review` (not committed)

`sed -i 's/^status: in-progress$/status: in-review/' features/2026/09/continue-command/roadmap.md`,
then `node scripts/agento.mjs next` → exit 0; afterwards
`git checkout -- features/2026/09/continue-command/roadmap.md` restored
`status: in-progress` and `git status --short` was empty.

```json
{
  "status": "ok",
  "role": "build",
  "lifecycle": "in-review",
  "slug": "continue-command",
  "type": "feature",
  "next": {
    "command": "review-feature",
    "args": ["continue-command"],
    "invocation": "/agento review-feature continue-command",
    "window": "here",
    "then": null,
    "reason": "status in-review with no verdict yet: the Reviewer runs in this window"
  },
  "candidates": [],
  "reviewFresh": null,
  "dispatch": {
    "prompt": "/home/david/DP/agento-worktrees/plan-20260915-024029/commands/review-feature.md",
    "agent": "/home/david/DP/agento-worktrees/plan-20260915-024029/.github/agents/delivery-reviewer.agent.md"
  },
  "warnings": [],
  "reason": "status in-review with no verdict yet: the Reviewer runs in this window",
  "root": "/home/david/DP/agento-worktrees/plan-20260915-024029",
  "configSource": null
}
```

Derived by the prompt (`window: here` → follow `commands/review-feature.md` +
`delivery-reviewer.agent.md`; `reviewFresh: null` because no review.md exists yet):

```text
Receipt: accepted continue:continue-command:d81672f
Result: completed — review.md written for feature/continue-command with the Reviewer's verdict; next: /agento continue continue-command
```

(After `Verdict: approve` the same command would derive `/agento ship continue-command`
with `window: primary`, and the prompt would run `code /home/david/DP/agento` and name
that command rather than run it here.)

## (d) Temporary freehand-named directory under the worktrees dir

`git worktree add --detach /home/david/DP/agento-worktrees/freehand-rehearsal-tmp HEAD`,
then `node scripts/agento.mjs next --root /home/david/DP/agento-worktrees/freehand-rehearsal-tmp`
→ exit 3; afterwards `git worktree remove --force` + `git worktree prune` removed it
(`git worktree list` shows no `rehearsal` entry; the directory is gone).

```json
{
  "status": "unsupported",
  "role": "freehand",
  "lifecycle": "no-delivery",
  "slug": "continue-command",
  "type": "feature",
  "next": null,
  "candidates": [],
  "reviewFresh": null,
  "dispatch": null,
  "warnings": [],
  "reason": "role freehand has no delivery lifecycle to continue; use the session record's allowed commands",
  "root": "/home/david/DP/agento-worktrees/freehand-rehearsal-tmp",
  "configSource": null
}
```

Derived by the prompt (window check fails first: `role: freehand` ∉ {primary, plan,
build}; the alternatives are the freehand row of the session record, nothing is written):

```text
Receipt: rejected — wrong window: role=freehand (/home/david/DP/agento-worktrees/freehand-rehearsal-tmp, branch detached); allowed: /agento finish-freehand <slug>, /agento commit-current-changes
```

Note: a bare `mkdir` of the same path (not a registered worktree) was tried first and
yields `role: unmanaged`, `status: unsupported`, exit 3 — also a rejection, with an
empty `allowed[]` and the fix naming the primary checkout — so a real detached worktree
was used to exercise the `freehand` row.

## Reproduction

Re-running each recorded command reproduces the recorded `status`, `next.invocation`,
and `window` as long as the roadmap header and worktree registrations are unchanged;
(c2) and (d) require re-creating their temporary state as described. `git status
--short` was empty after every case except for this evidence file.
