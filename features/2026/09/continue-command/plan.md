# continue-command: `/agento continue [slug]` derives and performs the next legal transition

## Problem

The user is still the workflow coordinator. Even with `agento.mjs session` answering
"where am I and what may I run", the user has to read `allowed[]`/`elsewhere[]`,
pick the right command, type it with the right slug, and — for cross-window steps —
open the right worktree window first. The sequence `next-feature → start-session →
new-feature → build → review → ship` is deterministic given the session record, the
roadmaps, and the initiative breakdowns, yet nothing derives it.

This feature adds `node scripts/agento.mjs next [<slug>]` — a pure, unit-tested
transition function over the session record, roadmaps, worktree ownership, review
freshness, and initiative readiness — and a new `/agento continue [slug]` command
that runs it and **performs** the transition: in this window by following the named
command's own prompt (and agent) file, or across windows by creating/reopening the
worktree window (`/agento start-session` semantics) and naming the exact follow-up
command for it. One transition per invocation; anything not derivable ends in a
rejected receipt listing the choices.

Initiative member: this plan implements the `### continue-command` block of
[workflow-orchestration/breakdown.md](../../../../initiatives/2026/09/workflow-orchestration/breakdown.md)
(Wave 3; `Requires: session-state-cli, window-aware-commands, ship-audit-first`, all
`status: complete` as of 2026-09-14 — `agento.mjs initiative workflow-orchestration`
reports `continue-command` as `ready: true` and `next`).

## Decisions

Asked with the ask-questions tool on 2026-09-14; answers verbatim.

- **Q1 — Dispatch mechanism: how should `/agento continue` perform a transition that
  belongs to a custom agent (Planner: new-feature; Builder: build-*; Reviewer:
  review-*)?** A: **Follow the target prompt + agent file inline, same turn** —
  continue reads the named `.prompt.md` (and its agent file) and executes it as if
  invoked, in the default agent. Truly "performs" it; no logic duplicated.
- **Q2 — Ambiguity / initiatives: in the primary window with no slug and several
  candidates (multiple in-flight deliveries, or a ready initiative member), what does
  continue do?** A: **Proceed only when exactly one candidate; otherwise reject
  listing the choices** — a ready initiative member counts as a candidate
  (→ start-session plan mode, then "run `/agento continue` in the new window"). Two
  or more candidates → rejected receipt listing each as `/agento continue <slug>`.
- **Q3 — CLI shape: where does the transition derivation live?** A: **New
  `agento.mjs next [<slug>]` subcommand; `session` unchanged; hook untouched** — pure
  `deriveNext(...)` → `{ command, args, window: here|primary|secondary, reason }` in
  `session-state.mjs`, unit-tested over every role × lifecycle. No approval-gated
  hook edit.
- **Q4 — Scope: which tiers may continue drive?** A: **Delivery lifecycle only:
  start-session, new-feature (initiative member), build-*, review-*, ship (incl.
  teardown/epilogue)** — freehand / quick-fix / commit-current-changes windows get a
  rejected receipt with the record's allowed list. `/agento ap` is never chosen.
- **Q5 — Verification: how should the new prompt itself be verified (beyond CLI unit
  tests)?** A: **Unit tests for `next` + customizations tests + a Builder rehearsal
  per role captured under `evidence/`** — rehearsal transcripts (primary/no-delivery,
  plan window, build window at building/in-review/approved) saved as
  `evidence/step-N-M-*.md` like ship-audit-first did.

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/`
directory and no `## Agento` skills table in `AGENTS.md`; verified 2026-09-14).

### Codebase facts

- **Session record is the input.** `scripts/agento.mjs` `case "session"` (L≈445–470)
  composes `parseWorktreeList` → `deriveRole` → `classifyWorktrees` →
  `deriveDelivery` → `deriveLifecycle` → `deriveAllowed` from
  `scripts/session-state.mjs` and emits `role`, `hosted`, `worktree`, `worktrees[]`,
  `delivery`, `pr`, `lifecycle`, `allowed[]`, `elsewhere[]`, `warnings[]`. Lifecycle
  values: `LIFECYCLES = ["no-delivery","planned","building","paused","in-review",
  "approved","shipped","post-ship-pending"]` (`session-state.mjs` L≈157); roles:
  `ROLES = ["primary","build","plan","freehand","unmanaged"]` (L≈201).
- **The allowed table is data.** `TABLE` in `session-state.mjs` (L≈228–265) is
  role × lifecycle → `{ allowed, elsewhere }` with placeholders `<type>`/`<slug>`
  filled by `deriveAllowed()` (L≈270–281). `FREEHAND` and `UNMANAGED` are fixed
  rows. Policy §11 names `deriveAllowed` as the single roles table. Tests:
  `scripts/session-state.test.mjs` L≈355–460 assert exact rows for several cells
  (`approved.allowed` deep-equal at L397/L420, `plan.allowed` at L444, freehand at
  L449) — adding `/agento continue` to rows means updating those assertions.
  `scripts/agento.test.mjs` asserts `allowed` membership (L335, L363, L411, L437,
  L451) and `tests/session-context.test.mjs` regex-matches the hook's
  `allowed=[…]` list.
- **Ownership lookup exists.** `findOwner({ worktrees, worktreesDir, branch,
  config })` (`session-state.mjs` L≈125–135) returns `{ path, role, dirPrefix, id }
  | null` for a branch; `ship-preflight` and `close-decision` already expose it.
- **Roadmap description.** `describe()` (`agento.mjs` L≈109–131) yields `status`,
  `branch`, `reviewVerdict` (`approve | request-changes | null` from `review.md`),
  `steps`, `postShipPending`, `initiative`. `allRoadmaps()` walks local artifact
  roots only; `resolveRoadmapArtifact()` (`delivery-roadmap-resolver.mjs`) falls
  back to `origin/<branch>` via `gitAdapter.lsTree/show`, which is how `find` and
  `ship-preflight` see a roadmap that is not yet on `main`.
- **Review freshness is checked in prose today.** `ship.prompt.md` step 1 asks
  whether review.md is "stale (older than the last code commit)"; no CLI computes it.
  `git log -1 --format=%ct <ref> -- <dir>/review.md` versus `git log -1 --format=%ct
  <ref> -- . ':(exclude)<dir>/review.md'` gives a deterministic answer per branch ref.
- **Initiative readiness exists.** `deriveInitiative()` (`agento.mjs` L≈292–360)
  returns `features[]` with `state`, `ready`, `blockedBy`, and a single `next`;
  `allBreakdowns()` lists every breakdown. `/agento next-feature` prints the
  `start-session → new-feature initiative:<i>/<f> → build → review → ship` sequence
  as text (`next-feature.prompt.md` step 4).
- **Doctor and needs tables.** `COMMAND_NEEDS` in `agento.mjs` (L≈263–287) maps every
  command to its `Needs:` tokens; `tests/customizations.test.mjs` "the CLI needs
  table agrees with every prompt's Needs: line" fails for a prompt missing from it,
  and "exactly the commands that need gh, code, or network run doctor --for
  themselves" requires a `doctor --for continue` mention.
- **Prompt/agent conventions.** Every prompt opens its body with `Needs:` /
  `Fallback:` + the §10 pointer, cites §9 (receipt + idempotency row) and carries a
  `Window check per §11: requires role …` line; `commands/<name>.md` must be
  byte-identical to `.github/prompts/<name>.prompt.md` (`plugin.json` `commands:
  "commands"`, `agents: ".github/agents"`); agent files are matched to prompts by the
  `name:` frontmatter (`agent: "🔨 Agento Builder"` ↔
  `.github/agents/delivery-builder.agent.md` `name:`). `agento.mjs config` already
  emits `pluginRoot`, so the CLI can hand back absolute dispatch paths.
- **Canaries and guards in `tests/customizations.test.mjs`.** No file except the
  policy may spell `Receipt: accepted|rejected`, `Result: completed|failed`,
  `duplicate of <op-id>`, `Preflight: `, `switch to Agent mode`; only
  `ship.prompt.md` may say "paused at teardown"; only `start-session`,
  `start-freehand`, `close-session`, `ship` may mention `worktree list --porcelain`;
  no guidance may sequence close-session before ship; every command must appear in
  `README.md`, `docs/commands.md` (table **and** `## Invocation` list), and
  `.github/instructions/command-invocation.instructions.md`; bare `/<name>` and
  `.prompt`/`.md` suffixes are rejected everywhere in guidance.
- **Docs that enumerate commands or the flow.** `README.md` "Command reference"
  (L360–383) and "The full delivery flow" (L168+); `docs/commands.md` table (L3–24),
  CLI subcommand paragraph (L26–53), `## Invocation` (L55–94), "The standard flow"
  (L118) and "The initiative flow" (L129); `docs/architecture.md` mermaid (L3–28);
  `templates/AGENTS-section.md` L3–5 and `agento-init.prompt.md` L62 command lists;
  `AGENTS.md` scripts bullet (L16–18); `CHANGELOG.md` `## 0.4.0 (unreleased)`
  (L3) — `plugin.json`/`package.json` remain `0.3.0`, no bump here.
- **Policy touchpoints.** `delivery-policy.instructions.md` §8 (cross-window
  handoff commands), §9 idempotency table (one row per command — `continue` needs
  one), §11 (window check procedure; roles table lives in `deriveAllowed`).

### Lint baseline (policy §5)

Full-repository commands from `AGENTS.md`, run 2026-09-14 in this worktree at
`origin/main` `b2dbbda`:

| Command | Exit | Findings |
|---|---|---|
| `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` | 0 | none |
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | 124 pass, 0 fail |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | all fixtures match |

Baseline is green; no cleanup prerequisite. Gate for this delivery: **full gate** —
the Builder reruns all three commands at the end of every phase and the Reviewer
reruns them fresh; any new finding is a regression fixed in this delivery. (Note for
the Builder: the guard blocks a terminal line that spells `scripts/hooks/*.sh` next
to a redirect; list the hook files explicitly as above.)

### Concurrent deliveries

`gh pr list --state open --json number,headRefName,title` → `[]` on 2026-09-14. All
six sibling members of `workflow-orchestration` are `status: complete`. No overlap
risk from other deliveries; the shared-file risk below is theoretical.

## Approach

### 1. `deriveNext()` — pure transition function (`scripts/session-state.mjs`)

```
deriveNext({ role, worktree, delivery, lifecycle, owner, reviewFresh,
             candidates, requestedSlug, config })
  → { status, next, candidates, reason }
```

Inputs are plain data the CLI assembles (no git or fs inside the function):

- `role`, `worktree`, `delivery`, `lifecycle` — from the session helpers.
- `owner` — `findOwner()` for the delivery branch (`null` when none).
- `reviewFresh` — `true` when the last commit touching `review.md` on the branch ref
  is not older than the last commit touching anything else; `false` when older;
  `null` when there is no review.md.
- `candidates` — when no slug is active: every non-`complete` roadmap visible from
  `main` or owned by a registered worktree (`kind: "delivery"`, with `type`,
  `status`, `owner`) plus every initiative member with `ready: true`
  (`kind: "initiative-member"`, with `initiative`).
- `requestedSlug` — the optional argument, already resolved by the CLI to one
  candidate (or reported `missing`).

`status` ∈ `ok | none | ambiguous | blocked | unsupported | missing`; `next` is
`{ command, args, invocation, window: "here" | "primary" | "secondary", then, reason }`
or `null`. The rules, all delivery-lifecycle only (Decision Q4):

| Role | Lifecycle / situation | `next` | window | `then` |
|---|---|---|---|---|
| `build`, `plan` (promoted) | `planned`, `building`, `paused` | `/agento build-<type> <slug>` | here | — |
| `build`, `plan` | `in-review`, `reviewVerdict: null` or `reviewFresh: false` | `/agento review-<type> <slug>` | here | — |
| `build`, `plan` | `in-review`, `reviewVerdict: request-changes`, `reviewFresh: true` | `/agento build-<type> <slug>` (fix handoff) | here | — |
| `build`, `plan` | `approved`, `reviewFresh: true` | `/agento ship <slug>` | primary | — |
| `build`, `plan` | `approved`, `reviewFresh: false` | `/agento review-<type> <slug>` (re-review) | here | — |
| `build`, `plan` | `shipped`, `post-ship-pending` | `/agento ship <slug>` (teardown / epilogue) | primary | — |
| `plan` | `no-delivery`, exactly one ready initiative member | `/agento new-feature initiative:<i>/<f>` | here | — |
| `plan` | `no-delivery`, zero ready members | `status: none` — describe the feature yourself (`/agento new-feature <description>`) | — | — |
| `plan` | `no-delivery`, several ready members | `status: ambiguous`, `candidates[]` | — | — |
| `build` | `no-delivery` (branch without roadmap) | `status: blocked` — plan it first from the primary | — | — |
| `primary`, slug given or exactly one candidate | delivery `planned`/`building`/`paused`/`in-review`, owner managed | `/agento start-session <type>/<slug> --resume` (reopens the window) | here | `/agento continue <slug>` |
| `primary` | same, owner `null` | `/agento start-session <type>/<slug>` | here | `/agento continue <slug>` |
| `primary` | `approved` (fresh) or `post-ship-pending`, any owner | `/agento ship <slug>` | here | — |
| `primary` | `approved`, `reviewFresh: false` | `/agento start-session <type>/<slug> [--resume]` | here | `/agento continue <slug>` (→ review) |
| `primary` | `complete`, managed owner still present | `/agento ship <slug>` (teardown resume) | here | — |
| `primary` | `complete`, no owner | `status: none` — shipped; nothing to continue | — | — |
| `primary` | owner `role: primary` (the primary sits on the branch) | `status: blocked` — return the primary to `main` first | — | — |
| `primary`, no slug | candidate is one ready initiative member | `/agento start-session` (plan mode) | here | `/agento continue <f>` |
| `primary`, no slug | zero candidates | `status: none` — `/agento new-feature`, `/agento new-issue`, or `/agento new-initiative` | — | — |
| `primary`, no slug | two or more candidates | `status: ambiguous`, `candidates[]` each with `invocation: /agento continue <slug>` | — | — |
| `build`/`plan`, slug ≠ `delivery.slug` | — | `status: blocked` — wrong window for that slug; alternatives from the record | — | — |
| `freehand`, `unmanaged` | any | `status: unsupported` | — | — |

`/agento ap` is never emitted. `invocation` is the joined string
(`/agento build-feature continue-command`); `then` is the follow-up for the window
the transition opens, or `null`. Every emitted command is one that already exists
(`commandNames` of `.github/prompts/`), asserted by a unit test.

### 2. `agento.mjs next [<slug>]` (new subcommand, `scripts/agento.mjs`)

Add to the usage header and the `switch`. It reuses the `session` composition
(same role/worktree/delivery/lifecycle derivation, no `--pr`), then:

1. **Resolve the slug** when given: `allRoadmaps()` first; else
   `resolveRoadmapArtifact()` (feature, then issue — same as `find`) so a roadmap
   living only on `origin/<branch>` is found from the primary; else an initiative
   member with that slug across `allBreakdowns()` (unique, `ready: true`); else
   `status: missing` with the `find` message.
2. **Owner** via `findOwner()` over the classified `worktrees[]`.
3. **Review freshness** via `git log -1 --format=%ct <ref> -- <dir>/review.md` and
   `git log -1 --format=%ct <ref> -- . ':(exclude)<dir>/review.md'`, where `<ref>`
   is `origin/<branch>` when that ref exists, else the local branch, else `HEAD`.
   Never fetches (read-only, offline-safe); when `<ref>` is the local branch only, a
   `warnings[]` entry says the answer reflects the last fetch.
4. **Candidates** (no slug): non-`complete` local roadmaps ∪ deliveries of managed
   `worktrees[]` entries (remote-resolved when not local) ∪ `ready` members of every
   valid breakdown.
5. **Dispatch paths**: for the emitted command, `dispatch.prompt =
   <pluginRoot>/commands/<name>.md` and `dispatch.agent` = the
   `<pluginRoot>/.github/agents/*.agent.md` whose `name:` equals the prompt's
   `agent:` frontmatter (`null` for default-agent prompts). `pluginRoot` is the
   existing `PLUGIN_ROOT`.

Output: `{ status, role, lifecycle, slug, type, next, candidates, reviewFresh,
dispatch, warnings, root, configSource }`. Exit 0 for `ok` and `none`; exit 3 for
`ambiguous`, `blocked`, `unsupported`, `missing` (the prompt maps exit 3 to the §9
rejected receipt). Usage errors (extra positionals, bad slug) exit 1 as today.

### 3. `/agento continue` appears in the session record

Add `CONTINUE = "/agento continue"` as the first entry of every `primary`, `build`,
and `plan` row in `TABLE` (`deriveAllowed`), so the hook's `Session:` line and every
rejected receipt advertise it. `FREEHAND` and `UNMANAGED` rows are unchanged
(Decision Q4). Update the exact-row assertions in `scripts/session-state.test.mjs`
and any `allowed` assertions in `scripts/agento.test.mjs` /
`tests/session-context.test.mjs` that break; add `continue` to `COMMAND_NEEDS`
with `["terminal", "ask-questions", "browser", "gh", "code", "network"]` — the union
of what the dispatched commands need, so `doctor --for continue` covers them.

### 4. The prompt (`.github/prompts/continue.prompt.md` ≡ `commands/continue.md`)

Frontmatter: `description`, `argument-hint: "[<slug>]"`, `agent: "agent"` (default
agent; no `tools:` restriction because it may follow Planner/Builder/Reviewer files
that need read/search/edit/execute/agent/browser). Body:

- `Needs: terminal, ask-questions, browser, gh, code, network` /
  `Fallback: ask-questions, browser, code → §10 standard fallbacks` / §10 pointer.
- §9 receipt + idempotency sentence (row: a duplicate re-derives from git + roadmap
  state and performs whatever transition is now legal; never a second worktree,
  branch, or PR — the dispatched command's own row governs the rest). Run
  `doctor --for continue` before the first write.
- `Window check per §11: requires role primary, plan, or build` — `freehand` and
  `unmanaged` reject with the record's alternatives; in `build`/`plan` a slug
  argument must equal `delivery.slug`.
- Procedure: (1) `agento.mjs session`; (2) `agento.mjs next [<slug>]`; (3) map
  `status`: `ok` → perform; `none` → completed result naming the record's first
  `allowed` command; `ambiguous`/`blocked`/`unsupported`/`missing` → rejected
  receipt quoting `reason` and listing `candidates[].invocation` (or the record's
  alternatives). (4) **Perform** — `window: here`: read `dispatch.prompt` and, when
  non-null, `dispatch.agent`, and carry that command out exactly as those files say
  with `next.args` as its argument, including its own doctor and window check;
  `window: primary` or `secondary`: run `code <path>` (the primary's `worktrees[0].path`
  or the owner path — reuses an open window) when the `code` CLI is available, else
  the §10 fallback, then name the command for that window. When `then` is set, the
  result line's `next:` is `then`; otherwise it is `/agento continue [<slug>]`.
  Exactly one transition per invocation. (5) The response has one receipt (this
  command's) and one result line (the dispatched command's outcome, with `next:`
  rewritten to `/agento continue [<slug>]` or `then`).
- Never chooses `/agento ap`, never inspects worktrees itself, never restates any
  policy canary, never marks a PR ready or merges outside `/agento ship`'s own text.

### 5. Policy, instructions, docs

- `delivery-policy.instructions.md`: §9 idempotency row for `/agento continue`; §8
  gains one sentence that `/agento continue [slug]` derives the same handoff
  command from the session record and may be named alongside it.
- `command-invocation.instructions.md`: add `/agento continue` to the canonical list.
- `docs/commands.md`: table row, `## Invocation` entry, `next [<slug>]` in the CLI
  paragraph, `/agento continue` shown as the shorthand in "The standard flow" and
  "The initiative flow".
- `README.md`: command reference row (window `primary · secondary`), a short
  paragraph in "The full delivery flow"; `docs/architecture.md`: a
  `/agento continue` node into the mermaid graph; `templates/AGENTS-section.md` and
  `agento-init.prompt.md` (≡ `commands/agento-init.md`) command lists;
  `AGENTS.md` scripts bullet (`next`); `CHANGELOG.md` `## 0.4.0 (unreleased)` entry.

### 6. Tests

- `scripts/session-state.test.mjs`: `deriveNext` table test over every role ×
  lifecycle × (`reviewFresh`, owner) combination in §1, ambiguity/none/blocked/
  unsupported/missing statuses, slug mismatch, every emitted command name ∈
  `.github/prompts/` basenames, `/agento ap` never emitted; updated `deriveAllowed`
  rows.
- `scripts/agento.test.mjs`: integration over a clone + `git worktree add` (as the
  existing `session` tests do): primary with one in-progress roadmap → start-session
  `--resume` + `then`; two candidates → `ambiguous`, exit 3; build worktree
  `in-progress` → build-feature `here` with `dispatch.prompt`/`dispatch.agent`
  paths that exist; `in-review` + fresh `approve` → ship `primary`; stale `approve`
  → review; `complete` with owner → ship; unplanned ready member slug from the
  primary → start-session + `then: /agento continue <f>`; freehand worktree →
  `unsupported`, exit 3; usage header lists `next [<slug>]`.
- `tests/customizations.test.mjs`: no new assertions needed — the existing suite
  enforces the receipt, window check, Needs/doctor, CLI table, README/docs/Invocation
  listing, command mirror, and canaries for the new prompt.
- `tests/session-context.test.mjs`: adjust only if its `allowed=[…]` regex breaks.

### Files touched

`scripts/session-state.mjs`, `scripts/session-state.test.mjs`, `scripts/agento.mjs`,
`scripts/agento.test.mjs`, `tests/session-context.test.mjs` (only if needed),
`.github/prompts/continue.prompt.md` (new), `commands/continue.md` (new),
`.github/prompts/agento-init.prompt.md`, `commands/agento-init.md`,
`.github/instructions/delivery-policy.instructions.md`,
`.github/instructions/command-invocation.instructions.md`, `docs/commands.md`,
`docs/architecture.md`, `README.md`, `templates/AGENTS-section.md`, `AGENTS.md`,
`CHANGELOG.md`, plus this delivery's `plan.md`, `roadmap.md`, and `evidence/`.
No hook file is edited.

## Risks

- **Inline dispatch executes another command's prompt inside the default agent**,
  which lacks a custom agent's `tools:`/`agents:` frontmatter restrictions. Mitigation:
  the continue prompt carries no `tools:` restriction (superset), instructs the model
  to apply the dispatched agent file's rules verbatim, and the dispatched command's
  own doctor and window check still run; the rehearsal evidence checks the derived
  receipt/result for each role.
- **Review freshness by commit time could misjudge a review committed together with
  code** (same commit touches review.md and code). Mitigation: "not older" counts as
  fresh; the Reviewer commits review.md alone by convention, and `ship` still
  performs its own staleness check.
- **Adding `/agento continue` to every `allowed` row changes the session record and
  hook output**, breaking exact-row assertions. Mitigation: update the assertions in
  the same step (1.3); the hook script itself is untouched, so no approval-gated edit.
- **Remote-only roadmaps from the primary** (planned but not merged) require
  `origin/<branch>` to be fetched; `next` never fetches. Mitigation: `warnings[]`
  names the staleness; `/agento start-session` (the dispatched command) fetches
  anyway.
- **Scope creep** (breakdown risk): the transition table grows into a second
  workflow engine. Mitigation: `deriveNext` is one data table per role; the prompt
  composes existing commands by file reference and performs exactly one transition
  per invocation; anything not derivable is a rejected receipt.
- **Concurrent-delivery overlap**: none today (no open PRs, all sibling members
  complete). Should a new delivery touch `docs/commands.md`, `README.md`,
  `CHANGELOG.md`, or `session-state.mjs`, integrate `origin/main` before every push
  per concurrent-delivery.instructions.md.

## Out of scope

- Driving freehand, quick-fix, or commit-current-changes tiers (Decision Q4).
- Choosing `/agento ap`; unattended chaining of several transitions in one invocation.
- Adding a `next` field to the `session` record or the SessionStart hook line
  (Decision Q3); any hook edit.
- Automatically switching the primary worktree off a delivery branch, closing VS Code
  windows, or killing processes.
- Changing the artifact formats or the `deriveAllowed` freehand/unmanaged rows.
- A persisted journal of performed transitions (initiative decision: deterministic
  state from git + roadmap only).
- Bumping `plugin.json`/`package.json` versions (release stamping belongs to
  `/agento ship`).

## Acceptance checklist

- [ ] `deriveNext()` is exported from `scripts/session-state.mjs` and a table test in
  `scripts/session-state.test.mjs` covers every cell of the §1 table (each role ×
  lifecycle × `reviewFresh`/owner variant), the six `status` values, and asserts
  every emitted command is a `.github/prompts/` basename and never `ap` — verify:
  `node --test scripts/session-state.test.mjs` passes and the test names list the
  cells.
- [ ] `node scripts/agento.mjs next` in this build worktree with the roadmap
  `in-progress` prints `status: "ok"`, `next.invocation: "/agento build-feature
  continue-command"`, `next.window: "here"`, and `dispatch.prompt`/`dispatch.agent`
  pointing at existing files — verify: run it and `test -f` both paths.
- [ ] From the primary (`--root /home/david/DP/agento`) with no slug and this
  delivery the only in-flight candidate, `next` prints `/agento start-session
  feature/continue-command --resume` with `then: "/agento continue
  continue-command"`; with two in-flight roadmaps in a test clone it prints
  `status: "ambiguous"`, exit 3, `candidates[].invocation` each `/agento continue
  <slug>` — verify: live run + `scripts/agento.test.mjs`.
- [ ] `in-review` + fresh `Verdict: approve` → `/agento ship <slug>` with
  `window: "primary"` from a build worktree and `"here"` from the primary; a stale
  approve → `/agento review-<type> <slug>`; `request-changes` fresh → build —
  verify: `scripts/agento.test.mjs` integration tests over a clone with two commits.
- [ ] From the primary, a ready initiative member slug with no roadmap →
  `/agento start-session` (plan mode) with `then: "/agento continue <f>"`; from a
  detached `plan-*` worktree with exactly one ready member → `/agento new-feature
  initiative:<i>/<f>` `here` — verify: `scripts/agento.test.mjs`.
- [ ] A freehand worktree → `status: "unsupported"`, exit 3; a build worktree given a
  different slug → `status: "blocked"`, exit 3; unknown slug → `status: "missing"`,
  exit 3; usage lists `next [<slug>]` — verify: `scripts/agento.test.mjs` and
  `node scripts/agento.mjs`.
- [ ] `/agento continue` is the first `allowed` entry of every `primary`/`build`/
  `plan` row of `deriveAllowed` and absent from `freehand`/`unmanaged`; `continue` is
  in `COMMAND_NEEDS`; hook output unchanged in shape — verify:
  `node --test scripts/session-state.test.mjs scripts/agento.test.mjs
  tests/session-context.test.mjs`; `node scripts/agento.mjs doctor --for continue`
  echoes the six needs.
- [ ] `.github/prompts/continue.prompt.md` and `commands/continue.md` are
  byte-identical, declare `Needs:`/`Fallback:`, cite §9 and `doctor --for continue`,
  carry `Window check per §11: requires role primary, plan, or build`, never mention
  `worktree list --porcelain`, `/agento ap` as a choice, or a policy canary — verify:
  `node --test tests/customizations.test.mjs` passes; `diff` is empty.
- [ ] Policy §9 idempotency table has a `/agento continue` row and §8 names the
  shorthand; `command-invocation.instructions.md` lists `/agento continue` — verify:
  `grep -n "/agento continue" .github/instructions/*.md` shows both files; the
  customizations suite passes.
- [ ] `README.md`, `docs/commands.md` (table, `## Invocation`, CLI paragraph, both
  flows), `docs/architecture.md`, `templates/AGENTS-section.md`,
  `agento-init.prompt.md` ≡ `commands/agento-init.md`, `AGENTS.md`, and
  `CHANGELOG.md` `## 0.4.0 (unreleased)` mention `/agento continue` (docs) and
  `next` (CLI lists); versions stay `0.3.0` — verify: `grep -n "agento continue"`
  across those files; customizations suite passes.
- [ ] Rehearsal evidence `evidence/step-3-1-continue-rehearsal.md` records, for the
  primary (no slug; slug), this promoted plan/build worktree (`building`,
  `in-review`), and a freehand path, the exact `agento.mjs next` JSON and the
  receipt/result lines the prompt derives — verify: file exists, is linked from the
  roadmap step, and its recorded JSON matches a fresh run.
- [ ] Full lint gate green and equal to the baseline: shellcheck exit 0; node tests
  0 failures with total > 124; replay-guard exit 0; `git diff --stat origin/main`
  touches only the files in "Files touched" — verify: rerun all three commands and
  the diff.
