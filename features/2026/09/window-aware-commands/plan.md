# Window-aware commands: every window-sensitive prompt and agent consumes `agento.mjs session`

## Problem

Member `window-aware-commands` of the
[workflow-orchestration](../../../../initiatives/2026/09/workflow-orchestration/breakdown.md)
initiative (block `### window-aware-commands`). Brief: "The agent twice mistook the
primary window for a resumed secondary worktree … Commands had different validity
depending on whether they ran in the primary, planning, or build window."

Today every window-sensitive command re-derives the answer to "which window am I in"
in prose — `git worktree list --porcelain` plus a sentence about "the primary
worktree" — in `start-session`, `close-session`, `ship`, `quick-fix`,
`new-initiative`, `start-freehand`, `finish-freehand`, the Planner, Architect,
Builder, Reviewer, and Autopilot. `agento.mjs session` (shipped by
`session-state-cli`) already returns the role, the active delivery, the lifecycle,
and the `allowed`/`elsewhere` commands as data, but nothing consumes it except
`/agento delivery-status` and the receipt's `rejected` form. The resolver's
`closeBuildSessionDecision()` still infers "managed worktree present" from a basename
regex plus `currentBranch !== default` — the heuristic version of the same bug.

After this delivery, every window-sensitive prompt and agent runs one CLI call,
requires a listed role, and otherwise rejects the invocation with a §9 receipt whose
alternatives come verbatim from the record — so the wrong-window confusion has no
prose path left to survive on. Hosted workspaces (Codespaces, Actions) become a flag
on the record instead of an exemption each agent remembers.

## Decisions

- **Q1: Consumer scope — include Autopilot and `/agento ap`? Should
  `commit-current-changes` gain a real role requirement or only read the record?**
  A: "Include Autopilot and /agento ap: they run in the build window and do the same
  "another worktree owns the branch" check as the Builder; leaving them on prose
  would keep one path where the two-window confusion survives. Same one-line §10
  citation as build-*. commit-current-changes: give it a real role requirement, not
  just informational. It commits everything on the current worktree and merges —
  from a build worktree that would sidestep the roadmap/review flow, from a freehand
  worktree it duplicates finish-freehand. Rule: require role: primary on a
  non-default branch (its actual use case: a stray primary-window change); reject
  plan/build/freehand with the record's allowed/elsewhere — which will name the
  handoff or finish-freehand for you, no hand-maintained list."
- **Q2: Rejection edges — (a) `role: unmanaged`; (b) the GitHub-hosted exemption as
  prose or data?** A: "(a) role: unmanaged → always reject delivery commands. The
  record's allowed for unmanaged is deliberately empty (session-state-cli Decision
  Q4); a checkout outside worktrees.dir that isn't the primary is exactly the state
  that produced "dude, this is the primary window". The rejection should name the
  fix: open the primary checkout, or git worktree list to find it. Don't carve out
  "on main" — an unmanaged clone on main shipping/merging is the confusing case, not
  the safe one. (b) Make the exemption data: agento.mjs session sets hosted: true
  when CODESPACES=true or GITHUB_ACTIONS=true (both are documented env vars; also
  COPILOT_AGENT-style vars if you find one documented — otherwise those two). In a
  hosted workspace, role is derived from the branch only (build if on a
  delivery-prefixed branch, else primary) and warnings[] says why. Then the Planner's
  prose becomes "hosted workspaces are handled by the record" and the exemption
  stops being something each agent remembers. Unit-test it with env injection."
- **Q3: CLI/resolver additions — `worktrees[]` on `session`, `owner` on
  `close-decision`/`ship-preflight`, exact lookup in `closeBuildSessionDecision()`?**
  A: "both, in one shape. Add worktrees[] to session: every registered entry as
  { path, branch, detached, role, dirPrefix, id, isPrimary, isManaged } (reuse
  deriveRole per entry — it already takes a path). That gives ship/close everything
  without a second command. Also add owner to close-decision and ship-preflight
  ({ path, role, dirPrefix, id } | null for the delivery branch) so those prompts
  consume the decision they already call, and reason: managed-worktree-present
  becomes derived from owner !== null instead of the regex.
  closeBuildSessionDecision(): yes, replace with the exact lookup — entry whose
  branch equals the delivery branch, path inside the realpath of worktrees.dir — and
  drop the currentBranch !== default fallback. That fallback is what makes the
  primary window on a feature branch look like a "managed worktree present"; it's
  the heuristic version of the bug you're fixing. If the primary worktree owns the
  branch, return a distinct reason: primary-owns-branch so close-session and ship
  say "return the primary to main first" rather than trying to remove a worktree.
  Update the resolver tests' fixtures (they currently pass a hand-written porcelain
  string — keep that interface, just parse it exactly)."
- **Q4: Where the rule lives — policy `## 10. Window check` (A) or inline (B), and
  how to enforce it?** A: "Option A, ## 10. Window check. Each prompt/agent gets one
  line: "Window check per §10; requires role primary" (or build, or plan|build).
  Enforce two ways in customizations.test.mjs: (i) every prompt/agent body cites §10
  (mirror the §9 test); (ii) git worktree list --porcelain may appear only in
  start-session, start-freehand, close-session, plus ship until ship-audit-first
  lands (it removes the worktree post-merge — then it consumes owner and the
  allowlist shrinks to three; note this handoff in ## Risks so the two features
  don't fight over ship.md). Bump the sections.size >= 9 guard to >= 10. Keep the
  roles table itself in the CLI (deriveAllowed), not in §10 — §10 states the
  procedure, the data stays single-sourced in code."
- **Q5: Changelog under the existing `## 0.4.0 (unreleased)`, no version bump?**
  A: "Yes — under the existing ## 0.4.0 (unreleased), no version bump, same as the
  other members. /agento ship reports the heading and it's not a gap. Expect the
  CHANGELOG hunk to conflict additively with capability-preflight if it lands first —
  keep both."

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/`
directory and AGENTS.md has no `## Agento` skills table).

- **Record producer.** `scripts/session-state.mjs` exports `parseWorktreeList`
  (L12–31), `deriveRole` (L46–89: primary → managed `^(plan|feature|issue|freehand)-`
  prefix → `unmanaged`; realpath comparison; branch prefix promotes `plan-*` to
  `build`), `deriveDelivery` (L95–118), `deriveLifecycle` (L120–148), `ROLES`
  (L150), and `deriveAllowed` (L205–217) over the `TABLE` (L167–200) — policy §8 as
  data, one row per role × lifecycle, `FREEHAND` (L202) and `UNMANAGED` (L203:
  `allowed: []`, `elsewhere: [start-session @ primary, "this directory is neither the
  primary worktree nor a managed Agento worktree"]`). `deriveRole` takes a `cwd` and
  the parsed list, so classifying every registered entry is a per-entry call with
  `cwd: entry.path`. Nothing reads `process.env`; there is no `hosted` concept.
- **CLI `session` case.** `scripts/agento.mjs` L437–451: parses the worktree list
  once, resolves `worktrees.dir` against the primary checkout (L441–443), derives
  role/delivery/pr/lifecycle/allowed, emits `{ status, role, worktree, delivery, pr,
  lifecycle, allowed, elsewhere, warnings, root, configSource }`. `close-decision`
  (L369–373) passes the raw porcelain string as `worktreeList`; `ship-preflight`
  (L375–379) passes no worktree information at all.
- **Resolver heuristic.** `scripts/delivery-roadmap-resolver.mjs`
  `closeBuildSessionDecision` L189–238: `managedPattern = new RegExp("worktree
  .*<basename of worktrees.dir>[/\\]")` (L202–203) and `if (managedOwnsBranch ||
  currentBranch !== cfg.branches.default)` (L205) → `reason:
  "managed-worktree-present"`; else `remote-roadmap-only` (L212–216). The
  `currentBranch` fallback makes the primary window on a feature branch report a
  managed worktree. `evaluateShipPreflight` L242–282 returns `{ status,
  resolutionSource, branch, message }` with no owner information.
- **Resolver tests.** `scripts/delivery-roadmap-resolver.test.mjs`: L72–89 passes
  `worktreeList: "worktree /repo\nHEAD ...\nbranch refs/heads/main\n"` and expects
  `remote-roadmap-only`; L186–206 passes
  `worktree /repo/../x/<worktreesBase>/feature-widget\nbranch refs/heads/feature/widget`
  and expects `managed-worktree-present`. The second fixture only matches the
  basename regex — its path is *not* inside `config.worktrees.dir` — so it must be
  rewritten to place the entry under `defaultConfig(root).worktrees.dir` for the
  exact lookup. Interface (hand-written porcelain string) stays.
- **CLI integration tests.** `scripts/agento.test.mjs` `session` tests L186–330
  (`makeRepo()`, `run()`, `runWith({ cwd, env })` for PATH/env injection — the
  `--pr` tests already inject `env`, so `CODESPACES`/`GITHUB_ACTIONS` injection uses
  the same helper). `close-decision` asserted at L140 (`remote-roadmap-only`).
  `scripts/session-state.test.mjs`: 20 tests; `role()` helper L34.
- **Prose window checks to replace** (each currently re-derives the role):
  - `.github/prompts/start-session.prompt.md` L24–25 (shared precondition 1: primary
    worktree) and L72–77 (build mode step 2: who owns the roadmap branch — primary →
    stop; secondary → duplicate/resume). Still *creates* worktrees, so it legitimately
    keeps `git worktree list --porcelain` for the ownership scan after the §10 role
    check.
  - `.github/prompts/close-session.prompt.md` L27–28 (shared rule 1), L49–63 (build
    close: `close-decision` reasons `remote-roadmap-only` /
    `managed-worktree-present`). Removes worktrees, so it keeps the porcelain
    command for the registration check (shared rule 6) but reads ownership from
    `owner`.
  - `.github/prompts/ship.prompt.md` L25–31: "inspect `git worktree list
    --porcelain` for the roadmap's branch; if a secondary worktree owns it, stop and
    direct the user to `/agento close-session`". Consumes `ship-preflight`
    already (L9); `owner` replaces the scan — but see Risks: `ship-audit-first` also
    edits this paragraph, so the porcelain allowlist keeps `ship` until that lands.
  - `.github/prompts/start-freehand.prompt.md` L26–27; `finish-freehand.prompt.md`
    L18–23 (managed `freehand-<slug>` check); `quick-fix.prompt.md` L41 and
    `new-initiative.prompt.md` L16 ("require the primary worktree on `main`");
    `new-feature.prompt.md` L28 and `new-issue.prompt.md` L24 ("managed isolated
    planning worktree per the Planner's isolation protocol");
    `build-feature.prompt.md` L21–23 and `build-issue.prompt.md` L21–23 ("if another
    worktree owns the branch, stop"); `review-feature.prompt.md` L15 and
    `review-issue.prompt.md` L15 ("confirm this worktree owns …");
    `commit-current-changes.prompt.md` L19 (inspects the branch, no role rule);
    `ap.prompt.md` (delegates to the Autopilot).
  - Agents: `delivery-planner.agent.md` L40–49 (isolation: porcelain + `plan-<id>`
    path convention + "GitHub-hosted isolated coding-agent workspace is exempt"),
    L98, L136–138; `initiative-architect.agent.md` L41–43 (porcelain + primary);
    `delivery-builder.agent.md` L38–45; `delivery-reviewer.agent.md` L41–48;
    `delivery-autopilot.agent.md` L39–44.
  - `commands/*.md` are byte-identical mirrors of `.github/prompts/*.prompt.md`
    (asserted by `tests/customizations.test.mjs` "plugin manifest…"), so every prompt
    edit is mirrored.
- **Policy file.** `.github/instructions/delivery-policy.instructions.md` has §1–§9;
  §8 (L143–153) is the cross-window handoff; §9 (L155–end) defines `Receipt:
  rejected — <reason>; allowed: …` with alternatives "copied from the session record
  (`agento.mjs session` …): every `allowed[]` entry verbatim, then each
  `elsewhere[]` entry as `<cmd> (<window> window)`" — the rejection form this
  delivery reuses unchanged. The frontmatter `description` enumerates the sections.
- **Customizations test.** `tests/customizations.test.mjs`: "policy section
  references (§N) point at sections that exist" (L152–162, `sections.size >= 9`);
  "every command and agent opens and closes with the §9 receipt" (L164–170) —
  the template for the §10 assertion; canary list (L172–195) forbids restating
  receipt spellings outside the policy file; `guidanceFiles` (L212–221) is the
  scan set for the porcelain allowlist test.
- **Docs that describe the window model** and must stay truthful: `docs/commands.md`
  L28–31 (CLI subcommand paragraph, `session [--pr]`), L83–88 (receipts paragraph
  mentions `agento.mjs session`); `docs/architecture.md` (policy summary);
  `docs/hooks.md` L11 (`Session:` line); `README.md` L416; `AGENTS.md` L15–17
  (scripts bullet); `CHANGELOG.md` L3 `## 0.4.0 (unreleased)` (entries for
  `session`, hook `Session:` line, §9).
- **Hosted environment variables.** Codespaces sets `CODESPACES=true`; GitHub Actions
  sets `GITHUB_ACTIONS=true`, and the Copilot coding agent executes inside an Actions
  runner, so those two variables cover the documented hosted cases (Decision Q2b:
  no separately documented `COPILOT_AGENT` variable found; use the two).
- **Hook.** `scripts/hooks/session-context.sh` already prints the `Session:` line from
  `agento.mjs session`; its format is unchanged by this delivery (the new
  `hosted`/`worktrees` fields are JSON-only), so no approval-gated hook edit occurs.
- **Lint baseline (policy §5)**, run 2026-09-14 at `origin/main` `3d2bac3`:
  - `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` → exit 0, no findings.
  - `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, 101 pass /
    0 fail.
  - `bash scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
  - Green baseline, no findings to overlap: the gate is the **full** repository lint
    (all three commands) at every push and at review, compared against 101/0.
- **Concurrent deliveries.** `gh pr list --state open` → #18
  `feature/capability-preflight` (currently only `features/2026/09/capability-preflight/`
  artifacts). Its plan's "Files touched" names `scripts/agento.mjs`,
  `scripts/agento.test.mjs`, `delivery-policy.instructions.md`, all prompts, all
  `commands/*.md`, all agents, `tests/customizations.test.mjs`, `docs/commands.md`,
  `docs/architecture.md`, `README.md`, `AGENTS.md`, `CHANGELOG.md` — and it adds
  **`## 10. Capability preflight`** to the policy. See Risks.

## Approach

### 1. Session record: `hosted`, `worktrees[]` (`scripts/session-state.mjs`, `scripts/agento.mjs`)

- `deriveRole({ cwd, worktrees, worktreesDir, config, env })`: new optional `env`
  (defaults to `{}` in the pure function; the CLI passes `process.env`). `hosted =
  env.CODESPACES === "true" || env.GITHUB_ACTIONS === "true"`. When hosted, the
  path rules are skipped: `role` is `build` if `worktree.branch` starts with
  `config.branches.feature` or `.issue`, otherwise `primary`; the return gains
  `hosted: true` and `reason: "hosted-workspace: role derived from the branch
  (<VAR>=true)"` that the CLI appends to `warnings[]`. Non-hosted results carry
  `hosted: false`. The worktree entry for the cwd is still resolved from the list so
  `worktree.path`/`branch` stay truthful.
- New export `classifyWorktrees({ worktrees, worktreesDir, config })` →
  `[{ path, branch, detached, role, dirPrefix, id, isPrimary, isManaged }]`, one per
  registered entry, by calling `deriveRole` with `cwd: entry.path` (hosted never
  applies here — the list describes on-disk checkouts). New export
  `findOwner({ worktrees, worktreesDir, branch, config })` → the classified entry
  whose `branch === <delivery branch>` and whose realpath is inside the realpath of
  `worktreesDir` → `{ path, role, dirPrefix, id }`; the primary entry owning the
  branch is reported separately as `{ …, role: "primary" }`; `null` when no entry
  owns it. The resolver imports these (no duplicate parsing logic).
- CLI `session`: emits `hosted` and `worktrees` (classified) alongside the existing
  fields; `warnings` gains the hosted reason. `close-decision` and `ship-preflight`
  gain `owner` (§2). Usage header line updated to `session [--pr] (role, worktree,
  worktrees, delivery, lifecycle, allowed; hosted flag)`.
- Tests: `scripts/session-state.test.mjs` — hosted env injection (`CODESPACES=true`
  on a delivery branch → `build`; `GITHUB_ACTIONS=true` on `main` → `primary`; hosted
  ignores the `worktrees.dir` path; `env` absent → unchanged results), `classifyWorktrees`
  over a list with primary + `plan-` + promoted `plan-` + `feature-` + `freehand-` +
  stray sibling, `findOwner` (managed owner, primary owner, none).
  `scripts/agento.test.mjs` — `session` prints `worktrees[]` with the build worktree
  classified `build`, `hosted: false` by default and `true` with `runWith({ env:
  { GITHUB_ACTIONS: "true" } })` plus the warning.

### 2. Resolver: exact ownership (`scripts/delivery-roadmap-resolver.mjs`)

- `closeBuildSessionDecision({ type, slug, currentBranch, worktreeList, git, rootDir,
  config })` keeps its signature; internally `parseWorktreeList(worktreeList)` →
  `findOwner(...)` for `result.branch`. Outcomes on `status: ok`:
  - managed owner → `reason: "managed-worktree-present"`, `owner: { path, role,
    dirPrefix, id }`;
  - primary owner → `reason: "primary-owns-branch"`, `owner: { path, role:
    "primary", … }`, message "the primary worktree is on <branch>; return it to
    <default> first — nothing to remove";
  - no owner → `reason: "remote-roadmap-only"`, `owner: null`.
  The `currentBranch !== cfg.branches.default` fallback and the basename regex are
  deleted (`escapeRegExp` stays only if still used elsewhere).
- `evaluateShipPreflight({ …, worktreeList })` gains the optional `worktreeList`
  parameter and the same `owner` field (`null` when the list is absent), so
  `ship.prompt.md` reads ownership from the decision it already calls. The CLI's
  `ship-preflight` case passes `git worktree list --porcelain`.
- Tests (`scripts/delivery-roadmap-resolver.test.mjs`): rewrite the L186–206 fixture
  so the managed entry lives at `path.join(config.worktrees.dir, "feature-widget")`
  and add: primary on `feature/widget` → `primary-owns-branch`; an entry on the
  branch *outside* `worktrees.dir` → `remote-roadmap-only` with `owner: null` (the
  old regex accepted a lookalike basename); `currentBranch: "feature/widget"` with
  no owning entry → `remote-roadmap-only` (the dropped fallback); `evaluateShipPreflight`
  with and without `worktreeList`.

### 3. Policy `## 10. Window check` (`.github/instructions/delivery-policy.instructions.md`)

The procedure only (Decision Q4 — the roles table stays in `deriveAllowed`):

1. Before any read of delivery state or any write, run `node
   <agento-root>/scripts/agento.mjs session` (the `Session:` hook line is a hint, the
   CLI call is the check).
2. Compare `role` with the roles the command's `Window check per §10; requires role
   …` line names. Match → proceed; the record's `worktree`, `delivery`, `worktrees[]`,
   and `hosted` replace any further worktree inspection except where a command
   creates or removes worktrees (start-session, start-freehand, close-session — and
   ship until it stops depending on the worktree being gone).
3. Mismatch → `Receipt: rejected — wrong window: role=<role> (<worktree.path>,
   branch <branch|detached>); allowed: …` with the alternatives copied per §9.
   `role: unmanaged` always rejects delivery commands and adds the fix: open the
   primary checkout (`worktrees[0].path`) or a managed worktree from `worktrees[]`.
4. `hosted: true` is not an exemption to remember: the record has already derived the
   role from the branch and said so in `warnings[]`; commands treat it like any other
   record.
5. Commands whose requirement includes a branch condition (commit-current-changes:
   `primary` on a non-default branch; quick-fix / new-initiative / start-*: `primary`
   on the default branch, clean) state it on their §10 line and check it from the
   record's `worktree.branch`.

The frontmatter `description` gains "the window check"; §1's "Needing a CLI …" and §8
are untouched (§8's window *sequence* is unchanged here).

### 4. Consumers (prompts, mirrored `commands/*.md`, agents)

Each file gets one line, right after its §9 receipt sentence, of the form
`Window check per [§10](…delivery-policy.instructions.md): requires role <roles>`,
and its prose worktree check is replaced by reading the record:

| File(s) | Requires | Replaced prose |
| --- | --- | --- |
| `start-session`, `start-freehand`, `quick-fix`, `new-initiative` | `primary` (on default branch, clean, for the latter three and start-session) | "resolve the primary worktree with `git worktree list --porcelain`" → §10 line; start-session build mode step 2 keeps its ownership scan but phrases outcomes from `worktrees[]` (`role: primary` owner → stop; managed owner → resume) |
| `close-session` | `primary` | shared rule 1 → §10; build close reads `owner`: `managed-worktree-present` → continue; `primary-owns-branch` → stop, "return the primary to `main` first"; `remote-roadmap-only` → already closed |
| `ship` | `primary` | the L25–31 paragraph reads `ship-preflight.owner`: managed owner → stop with `/agento close-session <type>/<slug>`; `primary-owns-branch` → stop, return to `main`; `null` → proceed. Wording kept minimal so `ship-audit-first` can drop the precondition later |
| `new-feature`, `new-issue`, Planner | `plan` (or `build` when resuming a promoted planning worktree of the same slug) | Planner step 1 isolation prose → §10 + "hosted workspaces are handled by the record"; the `plan-<session-id>` path convention is now `worktree.isManaged && dirPrefix === "plan"` from the record |
| `build-feature`, `build-issue`, Builder, `ap`, Autopilot | `build` (delivery slug must equal the argument) | "if another worktree owns the branch, stop" → compare `delivery.slug`/`worktree.branch`; another owner is visible in `worktrees[]` and the rejection names `/agento start-session <type>/<slug> --resume` from the record's `elsewhere` |
| `review-feature`, `review-issue`, Reviewer | `build` | same as Builder |
| `finish-freehand` | `freehand` (delivery slug = argument) | L18–23 → §10 |
| `commit-current-changes` | `primary` on a non-default branch | step 1 gains the role rule; plan/build/freehand rejected with the record's alternatives (Decision Q1) |
| `new-initiative`, Architect | `primary` on default, clean | L41–43 porcelain → §10 |
| `delivery-status`, `next-feature`, `agento-init`, `install-skills`, `triage-followups`, `extend-copilot`, `fix-copilot`, Mechanic | `any` | one line: `Window check per §10: requires role any (read-only / not window-sensitive)` so the §10 citation test stays uniform |

No prompt restates the rejection spelling (canary test); each cites §9/§10.

### 5. Tests (`tests/customizations.test.mjs`)

- Bump `sections.size >= 9` to `>= 10`.
- New test "every command and agent declares its window check (§10)": mirror of the
  §9 test over `promptFiles` + `agentFiles`, asserting `/Window check per .*§10.*requires role/`.
- New test "only worktree-mutating commands inspect `git worktree list --porcelain`":
  scan `guidanceFiles` minus docs for the literal; allowlist = `start-session`,
  `start-freehand`, `close-session`, `ship` (prompt + `commands/` mirror each), with
  a comment naming `ship-audit-first` as the delivery that removes `ship`.

### 6. Docs and changelog

`docs/commands.md` CLI paragraph (L28–31): `session` gains `hosted` and `worktrees[]`;
`close-decision`/`ship-preflight` gain `owner`. `docs/architecture.md` policy summary
adds "window check (§10)". `README.md` L416 and `docs/hooks.md` L11 mention the
`hosted` flag. `CHANGELOG.md` under `## 0.4.0 (unreleased)`: **Window-aware commands
(policy §10)** — one entry covering the §10 procedure, `hosted`, `worktrees[]`,
`owner`, `primary-owns-branch`, and the exact-ownership resolver. No version bump.

### Files touched

`scripts/session-state.mjs`, `scripts/session-state.test.mjs`, `scripts/agento.mjs`,
`scripts/agento.test.mjs`, `scripts/delivery-roadmap-resolver.mjs`,
`scripts/delivery-roadmap-resolver.test.mjs`,
`.github/instructions/delivery-policy.instructions.md`, all 22
`.github/prompts/*.prompt.md`, all 22 `commands/*.md`, all 6 `.github/agents/*.agent.md`,
`tests/customizations.test.mjs`, `docs/commands.md`, `docs/architecture.md`,
`docs/hooks.md`, `README.md`, `CHANGELOG.md`, and `features/2026/09/window-aware-commands/`.
Not touched: `scripts/hooks/*` (no approval-gated edit), `AGENTS.md` (subcommand
list unchanged), `plugin.json`/`package.json` (no version bump).

## Risks

- **Concurrent delivery with `capability-preflight` (#18).** Its plan adds
  `## 10. Capability preflight` to the same policy file and touches every prompt,
  agent, `agento.mjs`, `agento.test.mjs`, `customizations.test.mjs`, docs, and
  `CHANGELOG.md`. Mitigation: integrate `origin/main` by merge before every push
  (policy §7); if `capability-preflight` lands first, this delivery's section becomes
  `## 11. Window check` and every `§10` citation written here is renumbered in the
  same integration commit (the "§N exists" test catches a miss), and the
  `sections.size` guard bumps to `>= 11`. Prompt/agent one-liners are additive
  (different lines), the CHANGELOG hunk is additive (keep both entries, Decision Q5),
  and `agento.mjs` edits touch different `case` blocks. Conflict recipes per
  concurrent-delivery.instructions.md.
- **Handoff to `ship-audit-first` over `ship.prompt.md`.** This delivery rewrites only
  the L25–31 precondition paragraph to read `owner`, and keeps `ship` in the
  porcelain allowlist. `ship-audit-first` removes the precondition, consumes `owner`
  for the post-merge close, and shrinks the allowlist to three — noted here so the
  two plans do not fight over the same paragraph. Its plan should reference this
  section.
- **Resolver behaviour change.** Dropping `currentBranch !== default` and the
  basename regex changes `close-decision` for a primary window sitting on the
  delivery branch (now `primary-owns-branch`, not `managed-worktree-present`) and for
  a lookalike directory outside `worktrees.dir` (now `remote-roadmap-only`).
  Mitigation: explicit tests for both, and `close-session` / `ship` prose that
  handles the new reason with a clear "return the primary to `main`" instruction.
- **Hosted detection false positives.** A local shell that exports
  `GITHUB_ACTIONS=true` (e.g. a CI emulator) gets branch-derived roles. Mitigation:
  the record says so in `warnings[]`; only the two documented variables are read;
  nothing else changes.
- **Prose drift in 50 files.** Mitigation: the two new customizations tests
  (citation + porcelain allowlist), the existing byte-identity mirror test, the
  canary test forbidding restated receipt spellings, and the "§N exists" test.

## Out of scope

- Changing the order of close and ship, dropping ship's worktree precondition, or
  performing close-session inside ship (`ship-audit-first`).
- `/agento continue` and any `agento.mjs next` transition derivation
  (`continue-command`).
- `agento.mjs doctor`, `Needs:`/`Fallback:` declarations (`capability-preflight`).
- Changing the `deriveAllowed` table rows, lifecycle mapping, or the hook's
  `Session:` line format.
- Any edit under `scripts/hooks/` or `.github/hooks/`.
- Version bump of `plugin.json`/`package.json`.

## Acceptance checklist

- [ ] `node scripts/agento.mjs session` emits `hosted` (boolean) and `worktrees[]`
  where each registered entry has `{ path, branch, detached, role, dirPrefix, id,
  isPrimary, isManaged }`; the current worktree's entry matches the top-level `role`
  — verify: `scripts/agento.test.mjs` session tests and a manual run from this
  worktree showing the `plan-20260914-223201` entry with `role: "build"`.
- [ ] With `CODESPACES=true` or `GITHUB_ACTIONS=true` in the environment, `session`
  reports `hosted: true`, derives `role` from the branch only (`build` on a
  `feature/`/`issue/` branch, else `primary`), and `warnings[]` names the variable —
  verify: `node --test scripts/session-state.test.mjs scripts/agento.test.mjs` with
  the env-injection tests passing; without either variable results are byte-identical
  to today's fields.
- [ ] `agento.mjs close-decision` and `ship-preflight` return `owner` (`{ path, role,
  dirPrefix, id } | null`); `closeBuildSessionDecision` yields
  `managed-worktree-present` only for an entry on the delivery branch inside the
  realpath of `worktrees.dir`, `primary-owns-branch` when the primary owns it, and
  `remote-roadmap-only` otherwise — including when `currentBranch` equals the
  delivery branch and when a lookalike path sits outside `worktrees.dir` — verify:
  `node --test scripts/delivery-roadmap-resolver.test.mjs` with the rewritten and
  added fixtures; `grep -n "currentBranch !== " scripts/delivery-roadmap-resolver.mjs`
  returns nothing.
- [ ] `delivery-policy.instructions.md` has a `## 10. Window check` section (or the
  next free number per Risks) stating the procedure, the unmanaged rule, the hosted
  rule, and the branch-condition rule, without restating the roles table — verify:
  `node --test tests/customizations.test.mjs` (§N exists, canaries) passes and the
  section text contains no `allowed:` table.
- [ ] Every `.github/prompts/*.prompt.md`, `commands/*.md`, and
  `.github/agents/*.agent.md` cites §10 with a `requires role` clause; window-sensitive
  ones name `primary`, `plan`, `build`, `freehand` (or a combination) per the
  Approach table and `commit-current-changes` requires `primary` on a non-default
  branch — verify: the new "declares its window check" test passes;
  `grep -L "§10" .github/prompts/*.md commands/*.md .github/agents/*.md` is empty.
- [ ] `git worktree list --porcelain` appears in no prompt, command mirror, or agent
  other than `start-session`, `start-freehand`, `close-session`, and `ship` — verify:
  the new allowlist test passes; `grep -l "worktree list --porcelain"
  .github/prompts/*.md .github/agents/*.md commands/*.md` lists exactly those four
  prompts and their four mirrors.
- [ ] The Planner no longer carries the "GitHub-hosted … exempt" sentence; it defers
  to the record's `hosted` flag — verify: `grep -n "hosted" .github/agents/delivery-planner.agent.md`
  shows the deferral and `grep -n "coding-agent workspace is exempt"` returns nothing.
- [ ] `close-session` (build close) and `ship` handle `primary-owns-branch` with a
  "return the primary to `main` first" instruction and never attempt a worktree
  removal for it — verify: read the two prompts; `diff commands/<name>.md
  .github/prompts/<name>.prompt.md` empty for both.
- [ ] `docs/commands.md`, `docs/architecture.md`, `docs/hooks.md`, `README.md`, and
  `CHANGELOG.md` (`## 0.4.0 (unreleased)`, no version bump) describe `hosted`,
  `worktrees[]`, `owner`, and §10 — verify: `grep -n "hosted\|owner\|§10\|Window check"`
  across those files shows each; `git diff origin/main -- plugin.json package.json`
  is empty.
- [ ] Full lint gate against the recorded baseline: `shellcheck scripts/hooks/*.sh
  scripts/wait-for-checks.sh` exit 0; `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` 0 failures with total > 101; `bash
  scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0; `git diff --stat
  origin/main` touches only the files in Approach "Files touched" — verify: command
  outputs recorded on the final roadmap step.
