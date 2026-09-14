# Ship audits first: `/agento ship` audits and merges while the build worktree exists, then tears it down

## Problem

Today `/agento ship` refuses to run while a managed secondary worktree still owns the
delivery branch: [commands/ship.md](../../../../commands/ship.md#L25-L31) tells the
user to run `/agento close-session <type>/<slug>` first and rerun. When the audit then
finds a gap (unticked step, stale or `request-changes` review, failing regression
test), the build session is already gone and recovery is awkward: return the primary
to `main`, reopen the feature with `/agento start-session <type>/<slug> --resume`,
build and review again, close again, then ship. The initiative brief records one
30-turn session spending roughly turns 9–22 on exactly this path.

This feature inverts the order. `/agento ship` audits from the primary window against
`origin/<branch>` while the build worktree is still open; a rejected audit sends the
user straight back to that window with the exact build or review command; a clean
audit (or a user-accepted lesser gap) merges, and ship then performs the build-close
steps itself (remove the worktree, prune, delete the merged local branch, sync
`main`). Standalone `/agento close-session` stays valid for plan and freehand sessions,
abandoned builds, and anyone who still closes before shipping.

This is the `ship-audit-first` member of the `workflow-orchestration` initiative —
see the `### ship-audit-first` block in
[initiatives/2026/09/workflow-orchestration/breakdown.md](../../../../initiatives/2026/09/workflow-orchestration/breakdown.md)
(Priority 2, "Ship audits should also happen before teardown").

## Decisions

Clarifying questions were asked as numbered questions in chat (the ask-questions tool
was unavailable in this session). Answers are the user's, verbatim.

- **Q1. Sequencing vs. PR #19 (`feature/window-aware-commands`, in flight, rewrites
  the same ship/close-session/policy passages). Plan now against `origin/main` but
  have the Builder integrate `origin/main` after `window-aware-commands` ships before
  touching those files? Or build fully independently?**
  A: "Sequencing — agreed, with a concrete 1.1 gate. Write the plan now against
  origin/main but read the owner shape from origin/feature/window-aware-commands
  (its plan.md ## Approach) so the design targets what #19 lands. Step 1.1 verify:
  should be machine-checkable: agento.mjs ship-preflight feature <any-slug> on the
  integrated branch prints an owner key, and git merge-base --is-ancestor <#19 merge
  sha> HEAD. Record in ## Risks that a request-changes on #19 pauses this build at
  1.1 (pause protocol, next-step: 1.1)."
- **Q2. Where do ship's writes happen while the worktree exists? Audit read-only
  against `origin/<branch>` and do the `status: complete` commit, changelog stamp,
  and any `origin/main` integration merge inside the owning worktree via
  `git -C <owner.path>`? Or a temporary detached checkout?**
  A: "Writes via git -C <owner.path> — agreed, keep the no-owner path too. Two
  branches in ship: owner !== null (secondary worktree registered): audit read-only
  from the primary against origin/<branch>; require the owner worktree clean and
  zero-ahead; do the status: complete commit, changelog stamp, and any origin/main
  integration merge with git -C <owner.path>; push from there. If the integration
  merge conflicts, that is build-window work: abort the merge in the owner worktree
  (git -C … merge --abort), leave it clean, and reject naming /agento build-feature
  <slug> in the open window. owner === null (session already closed, or a re-send
  after teardown): today's behaviour — check out in the primary. This keeps
  close-session → ship valid for anyone who still does it. Never check the branch
  out in the primary while an owner exists (git refuses anyway); never use a
  temporary detached checkout — it creates a second untracked place to lose
  commits."
- **Q3. Gap handling: should all gaps hard-reject with a `rejected` receipt, or
  should code-level gaps hard-reject while lesser gaps keep the "warn, ask, record
  under Follow-ups" path?**
  A: "Split — agreed; pin the two lists in the prompt. Hard-reject (rejected receipt
  naming the open window's command): unticked non-post-ship steps, falsely ticked
  steps, review missing/stale/request-changes, issue regression test failing, dirty
  or unpushed owner worktree, PR CONFLICTING. Name /agento review-feature <slug> when
  the only gap is the review; otherwise /agento build-feature <slug> (Builder fix
  handoff). Confirmation path (warn, ask, record under ## Follow-ups (accepted at
  ship)): unstamped changelog, PR body/title nits, undocumented unrelated drift,
  missing Fixes #n (fixable by ship itself — actually just fix it via gh pr edit)."
- **Q4. Teardown when the secondary VS Code window is still open and the delivery
  guard blocks removal: pause and resume on re-send, or complete with the worktree
  retained and name close-session as next?**
  A: "Pause — agreed, and extend §9's ship row. After the merge, the roadmap on main
  is already status: complete, so a re-send currently hits "complete → epilogue".
  Add to the ship idempotency row: "status: complete, PR merged, and a managed
  worktree still owns the (now-deleted-on-origin) branch → resume at teardown".
  Result line: Result: completed — paused at teardown (worktree <path> still open);
  next: close that VS Code window, then /agento ship <slug>. Don't answer the guard's
  ask yourself; the pause is the answer. Local branch deletion (git branch -d)
  happens in the same teardown step, after removal."
- **Q5. Scope of doc updates beyond ship.md, close-session.md, policy §8, README/docs
  flows, next-feature.md, Builder/Reviewer handoffs: also Autopilot and
  templates/AGENTS-section.md, and a customizations test that no guidance says
  "close-session then ship"?**
  A: "Docs — agreed. Autopilot's stop handoff text (it names close → ship) and
  AGENTS-section.md (echoed in agento-init.md step 4) both change. Test: reject
  close-session followed within the same line/paragraph by →/then and /agento ship,
  and ship … after … close-session, across README, AGENTS.md, agents, prompts,
  instructions, commands, docs, templates; allowlist CHANGELOG.md and features/**
  (historical). §8 keeps "close and ship happen in the primary window" but reorders:
  ship (which tears down) is the normal end; standalone /agento close-session is for
  plan/freehand sessions and abandoned builds."
- **Addition from the user:** "One addition to ## Out of scope: the /agento continue
  composition and the hook's Session: line are untouched here — continue-command
  consumes the new ship."

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/`
directory and AGENTS.md has no `## Agento` skills table).

### Lint baseline (policy §5)

Run in this planning worktree at `origin/main` `3d2bac3`, each in a status-capturing
wrapper:

| Command | Exit | Findings |
| --- | --- | --- |
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | 101 tests, 101 pass, 0 fail |
| `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` | 0 | none |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | all fixtures match |

Baseline is green; there is nothing to overlap or scope. The full gate applies:
every roadmap step that changes a tested file reruns the whole suite and shellcheck
stays green (no shell files change here). No `local:`/`dev-stack`/`preview` target
applies — nothing in this feature is served behaviour; verification is the node:test
suite, `grep`, and a dry-run rehearsal of the new ship flow against a scratch clone.

### Current state of the code this changes

- **Ship precondition today.** [commands/ship.md](../../../../commands/ship.md#L25-L31)
  (mirrored byte-for-byte in
  [.github/prompts/ship.prompt.md](../../../../.github/prompts/ship.prompt.md)):
  "inspect `git worktree list --porcelain` … If a secondary worktree owns it, stop and
  direct the user to run `/agento close-session <type>/<slug>` … then rerun". Audit
  step 1 checks out the work branch in the primary
  ([L34](../../../../commands/ship.md#L34)); step 2 is "warn, don't block" for every
  gap ([L61–L64](../../../../commands/ship.md#L61-L64)); step 3 commits `status:
  complete`, marks ready, waits, merges, deletes the branch, syncs `main`
  ([L65–L92](../../../../commands/ship.md#L65-L92)); step 5 is the post-ship
  epilogue. The closing paragraph enumerates the only commits ship may create
  ([L104–L108](../../../../commands/ship.md#L104-L108)).
- **What PR #19 (`feature/window-aware-commands`) changes in the same files**
  (`git diff origin/main origin/feature/window-aware-commands -- commands/ship.md
  commands/close-session.md .github/instructions/delivery-policy.instructions.md`):
  - ship.md gains `Window check per §10: requires role primary` and replaces the
    L25–31 paragraph with one that reads `owner` from `ship-preflight`
    (`{ path, role, dirPrefix, id } | null`): managed owner → still stops with
    `/agento close-session`; `primary-owns-branch` → stop, return to `main`; `null`
    → proceed. Its plan says the wording is "kept minimal so `ship-audit-first` can
    drop the precondition later".
  - close-session.md build close step 2 reads `owner`/`reason`
    (`managed-worktree-present`, `primary-owns-branch`, `remote-roadmap-only`).
  - Policy gains `## 10. Window check`, which explicitly names ship as a command
    that may still read `git worktree list --porcelain` "while it still depends on
    the worktree being gone" — text this feature must revise.
  - Resolver: `evaluateShipPreflight({ …, worktreeList })` gains the optional list
    and returns `owner` (from `findOwner()` in `scripts/session-state.mjs`);
    `closeBuildSessionDecision` drops its regex heuristic for the same `findOwner`.
    The CLI's `ship-preflight` passes `git worktree list --porcelain`.
- **Resolver today** ([scripts/delivery-roadmap-resolver.mjs](../../../../scripts/delivery-roadmap-resolver.mjs#L241-L277)):
  `evaluateShipPreflight({ type, slug, rootDir, currentBranch, git, config })` returns
  `{ status, resolutionSource, branch, message }` with no ownership data; its one test
  is "ship preflight resolves remote fallback before failing a missing local roadmap"
  ([scripts/delivery-roadmap-resolver.test.mjs](../../../../scripts/delivery-roadmap-resolver.test.mjs#L91-L108)).
  `closeBuildSessionDecision` ([L188–L236](../../../../scripts/delivery-roadmap-resolver.mjs#L188-L236))
  infers ownership from a basename regex plus `currentBranch !== default`.
- **Session record's allowed-command table** ([scripts/session-state.mjs](../../../../scripts/session-state.mjs#L153-L200)):
  `SHIP_LATER` / `SHIP_NOW` list `CLOSE` before `SHIP` with reasons "close the
  session from the primary window" / "ship from the primary window"; `primary ×
  approved` allows `[CLOSE, SHIP, STATUS]`; `build|plan × shipped` sends the user
  to `CLOSE` "the delivery is complete; close this worktree from the primary
  window". The comment reads "Policy §8 as data: build/review in the secondary
  window, close/ship in the primary." Test
  [scripts/session-state.test.mjs](../../../../scripts/session-state.test.mjs#L306)
  asserts the `approved.allowed` order `[close-session, ship, delivery-status]`.
- **Policy §8** ([.github/instructions/delivery-policy.instructions.md](../../../../.github/instructions/delivery-policy.instructions.md#L141-L152)):
  item 2 reads "After `Verdict: approve`, switch to the primary workspace window and
  run `/agento close-session <type>/<slug>`, then `/agento ship <slug>`." The §9 ship
  idempotency row ([L200](../../../../.github/instructions/delivery-policy.instructions.md#L200))
  covers only "complete with unticked post-ship steps → epilogue; merged PR → sync".
- **Prose that states the close → ship order** (all must change; grep
  `close-session.{0,80}(→|then|,).{0,40}/agento ship`):
  [delivery-policy §8 L149](../../../../.github/instructions/delivery-policy.instructions.md#L149);
  [commands/next-feature.md L42](../../../../commands/next-feature.md#L42) and its
  prompt mirror; [docs/commands.md L117](../../../../docs/commands.md#L117) (initiative
  flow) and the standard flow block
  [L98–L106](../../../../docs/commands.md#L98-L106) which lists ship then
  close-session as separate final lines; [README.md](../../../../README.md#L256-L275)
  sections "### 5. Close the session — primary window" and "### 6. Ship — primary
  window"; [docs/architecture.md](../../../../docs/architecture.md#L15-L22) mermaid
  (`SHIP → DONE → CLOSE` via a separate `/agento close-session` edge);
  [.github/agents/delivery-reviewer.agent.md L72–L74](../../../../.github/agents/delivery-reviewer.agent.md#L72-L74)
  ("`/agento close-session` then `/agento ship` from the primary window on
  approval"); [delivery-builder.agent.md L92–L96](../../../../.github/agents/delivery-builder.agent.md#L92-L96)
  and [delivery-autopilot.agent.md L64–L65](../../../../.github/agents/delivery-autopilot.agent.md#L64-L65)
  defer to "the cross-window sequence from policy §8" (they follow §8 automatically
  but the Autopilot's ground rule "You never run /agento ship, merge, close" and the
  Planner's step 9 "close it from the primary workspace window with
  `/agento close-session <type>/<slug>` after review"
  ([delivery-planner.agent.md L139–L142](../../../../.github/agents/delivery-planner.agent.md#L139-L142))
  need rewording); [templates/AGENTS-section.md L5–L6](../../../../templates/AGENTS-section.md#L5-L6)
  and [commands/agento-init.md L55–L56](../../../../commands/agento-init.md#L55-L56)
  list the commands in close-then-ship order.
- **Customizations test scaffolding** ([tests/customizations.test.mjs](../../../../tests/customizations.test.mjs#L209-L245)):
  `guidanceFiles` already spans README, AGENTS.md, agents, prompts, instructions,
  `commands/`, `docs/`, `templates/`; the `.prompt`-suffix test shows the allowlist
  pattern (`CHANGELOG.md` skipped by label). The "plugin manifest…" test asserts
  `commands/*.md` ≡ `.github/prompts/*.prompt.md` byte-for-byte, so every prompt
  edit is made twice.
- **Delivery guard on worktree removal** ([commands/close-session.md](../../../../commands/close-session.md#L38-L44)
  shared rules 4–5): `git worktree remove` triggers the guard's occupant check
  (process cwd, matching VS Code folder) and returns `ask`; the prompt must not
  answer that ask itself.
- **CHANGELOG** already has `## 0.4.0 (unreleased)`; `plugin.json`/`package.json`
  are both `0.3.0` and are not bumped here.

### Concurrent deliveries (open PRs at planning time)

- **PR #19 `feature/window-aware-commands`** touches `commands/ship.md`,
  `commands/close-session.md`, `.github/instructions/delivery-policy.instructions.md`,
  `scripts/delivery-roadmap-resolver.mjs` + test, `scripts/session-state.mjs` + test,
  `scripts/agento.mjs` + test, `tests/customizations.test.mjs`, and the Architect
  agent — every code file this plan edits. Sequenced after (Decision Q1, step 1.1).
- **PR #18 `feature/capability-preflight`** touches every prompt/command, every
  agent, README, `docs/commands.md`, `docs/architecture.md`, `CHANGELOG.md`,
  `templates/AGENTS-section.md`, `tests/customizations.test.mjs`, `scripts/agento.mjs`
  — one added `Needs:`/`Fallback:` line per file plus a new `doctor` command. Not a
  hard prerequisite; overlap is line-adjacent, resolved by integrating `origin/main`
  before every push.

## Approach

All prompt edits are made in `.github/prompts/<name>.prompt.md` and mirrored
byte-for-byte to `commands/<name>.md`.

### 1. Gate on `window-aware-commands` (roadmap step 1.1)

Nothing else starts until PR #19's merge commit is an ancestor of `HEAD`
(`git merge-base --is-ancestor $(gh pr view 19 --json mergeCommit --jq
.mergeCommit.oid) HEAD`) and `node scripts/agento.mjs ship-preflight feature
<any-slug>` on the integrated branch prints an `owner` key. If #19 is not merged, the
Builder pauses at 1.1 (Risks).

### 2. `/agento ship` (`ship.prompt.md` + `commands/ship.md`)

Rewrite the precondition paragraph and steps 1–3 around `owner` from
`ship-preflight` (shape `{ path, role, dirPrefix, id } | null`, landed by #19):

- **Precondition → ownership branch.** Delete "stop and direct the user to
  `/agento close-session`". Keep `primary-owns-branch` → stop ("return the primary to
  `main` first"). Two paths from here:
  - **`owner !== null` (managed worktree still owns the branch).** The audit is
    read-only from the primary against `origin/<branch>` (`git fetch origin`; read
    roadmap/review/plan with `git show origin/<branch>:<path>`; diff with `git diff
    origin/main...origin/<branch>`). Require `git -C <owner.path> status --porcelain`
    empty and `git -C <owner.path> rev-list --count @{upstream}..HEAD` equal to 0;
    either failing is a hard-reject gap. All writes happen in the owner worktree:
    `git -C <owner.path> merge origin/main` (when `mergeStateStatus` is `BEHIND`),
    the `status: complete` commit and changelog stamp, and `git -C <owner.path>
    push`. A conflicting integration merge is build-window work: `git -C
    <owner.path> merge --abort`, confirm the worktree is clean again, and reject
    naming `/agento build-<type> <slug>` for the open window.
  - **`owner === null`.** Today's behaviour unchanged: fetch, check out the branch
    in the primary, integrate, commit, push from there.
  - Never check the branch out in the primary while an owner exists; never create a
    temporary detached checkout.
- **Step 2 splits into hard-reject and confirmation gaps (pinned lists).**
  *Hard-reject* — end with `Receipt`-style rejection per §9, i.e. the result line is
  `Result: failed — <gaps>; next: <command>` where `<command>` is
  `/agento review-<type> <slug>` when the review is the only gap, otherwise
  `/agento build-<type> <slug>` (the Builder fix handoff) in the still-open secondary
  window (`owner.path`), or `/agento start-session <type>/<slug> --resume` when
  `owner === null`: unticked non-post-ship steps; falsely ticked steps; review
  missing, stale, or `request-changes`; issue regression test failing; owner
  worktree dirty or unpushed; PR `CONFLICTING`. Nothing is written on a hard reject
  (except the `merge --abort` cleanup). *Confirmation path* — warn, ask, and on yes
  record under `## Follow-ups (accepted at ship)`: unstamped changelog, PR body/title
  nits, undocumented unrelated drift. A missing `Fixes #<n>` on an issue PR is fixed
  by ship itself via `gh pr edit <n> --body` and noted, not asked.
- **Step 3 gains teardown after the `main` sync** (only when `owner !== null`):
  `git worktree remove <owner.path>` with the literal resolved path, `git worktree
  prune`, then `git branch -d <branch>` (safe: the remote branch is deleted by the
  merge and the local one is an ancestor of `origin/main`). The removal triggers the
  delivery guard's occupant check; ship never answers that ask. If the guard reports
  the VS Code window or a process still occupying the path, ship stops with
  `Result: completed — paused at teardown (worktree <path> still open); next: close
  that VS Code window, then /agento ship <slug>`. Order inside step 3 becomes: status
  commit + push (in owner) → mark ready → wait for checks → merge → sync `main` →
  release workflow → teardown → step 4 report → step 5 epilogue.
- **Duplicate submission (§9 row).** Add the teardown resume case to the opening
  paragraph: `status: complete` on `main`, PR merged, and a managed worktree still
  owns the branch → resume at teardown, then the epilogue if post-ship steps remain.
- **Description frontmatter** updated to mention teardown; the closing "Never
  force-push…" paragraph gains "never `git worktree remove --force`" and lists the
  `merge --abort` as the only cleanup permitted on a rejected audit.
- **Window check line** (from #19) stays `requires role primary`.

### 3. `/agento close-session` (`close-session.prompt.md` + `commands/close-session.md`)

Behaviour unchanged. The intro gains one sentence: `/agento ship` now performs the
build close itself after merging, so this command is the normal close only for plan
and freehand sessions and for abandoned or superseded build sessions; running it before
ship remains valid (ship then takes the `owner === null` path). Build close step 5
reports "next action is `/agento ship <slug>`" — keep, it is still true.

### 4. Policy (`delivery-policy.instructions.md`)

- **§8** keeps "Build and review happen in the secondary window; close and ship
  happen in the primary window" and rewrites item 2: "After `Verdict: approve`,
  switch to the primary workspace window and run `/agento ship <slug>`; it audits
  while this worktree is still open, sends you back here on a rejected audit, and
  tears the worktree down after the merge. Standalone `/agento close-session` is for
  plan and freehand sessions and for abandoning a build."
- **§9 ship row** becomes: "`status: complete` with unticked post-ship steps resumes
  at the epilogue; `status: complete`, PR merged, and a managed worktree still owning
  the branch resumes at teardown; an already-merged PR with no worktree only syncs
  the default branch and reports it."
- **§10 (from #19)** — drop the parenthetical "and `/agento ship` while it still
  depends on the worktree being gone"; ship now reads `owner` only, and the one
  worktree mutation it performs (teardown) is listed with start-/close-session.
- Frontmatter `description` unchanged in meaning (already lists the handoff).

### 5. Session record table (`scripts/session-state.mjs` + test)

Policy §8 as data must match the new order:

- `SHIP_LATER` → `[primary(SHIP, "after Verdict: approve, ship from the primary window — ship audits here first and tears this worktree down after the merge")]`
  and `SHIP_NOW` → `[primary(SHIP, "ship from the primary window — audits this worktree first, tears it down after the merge")]`;
  `CLOSE` is no longer listed as the normal next step for an approved build.
- `primary × approved` → `allowed: [SHIP, CLOSE, STATUS]` (ship first; close stays
  allowed for abandoning).
- `build|plan × shipped` elsewhere → `primary(SHIP, "the delivery is merged; re-send ship from the primary window to tear this worktree down")`
  when the worktree still exists (this is exactly the resume-at-teardown case), and
  `CLOSE` remains as a second entry for manual cleanup.
- Update the header comment ("Policy §8 as data: build/review in the secondary
  window; ship — which audits first and tears down — in the primary").
- Tests in `scripts/session-state.test.mjs`: the `approved.allowed` assertion
  ([L306](../../../../scripts/session-state.test.mjs#L306)) and any `elsewhere`
  assertions that pin `CLOSE` before `SHIP`; add one asserting `build × approved`
  `elsewhere` names ship first and its reason mentions teardown.

### 6. Resolver coverage (`scripts/delivery-roadmap-resolver.test.mjs`)

#19 lands `owner` on `evaluateShipPreflight`. Add the "worktree present" cases this
feature depends on: managed worktree on `feature/widget` inside `worktrees.dir` →
`owner.path` is that entry and `owner.role === "build"`; a promoted `plan-<id>`
worktree on the branch → `owner.dirPrefix === "plan"`; no `worktreeList` → `owner ===
null`; and `status: ok` is unaffected by ownership (ownership is never a preflight
error). No resolver source change is expected; if the integrated `owner` shape differs
from the #19 plan, the tests pin what ship.md consumes.

### 7. Handoff prose (agents, prompts, docs, template)

- `.github/agents/delivery-reviewer.agent.md` step 8: "`/agento ship <slug>` from the
  primary window on approval (it audits while this worktree is open and tears it
  down after the merge)".
- `.github/agents/delivery-builder.agent.md` completion and
  `.github/agents/delivery-autopilot.agent.md` step 4 / ground rule: keep "never run
  /agento ship" but the §8 sequence they quote is now ship-first; Autopilot's stop
  text names `/agento ship <slug>` directly.
- `.github/agents/delivery-planner.agent.md` step 9: "ship it from the primary
  workspace window with `/agento ship <slug>` after review; `/agento close-session
  <type>/<slug>` remains available to abandon the session."
- `.github/prompts/next-feature.prompt.md` + `commands/next-feature.md` L42:
  `/agento ship <feature-slug>` alone (ship tears down).
- `docs/commands.md`: standard flow ends with `/agento ship <slug> → audited in
  place, merged, main synced, worktree removed, epilogue`; initiative flow line
  L117 drops the close-session hop; close-session table row reads "Remove a
  plan/freehand worktree or abandon a build (ship tears down finished builds)".
- `README.md`: merge "### 5. Close the session" into "### 5. Ship — primary window"
  describing audit-in-place, the reject-back-to-the-open-window path, teardown, and
  the pause when the window is still open; add a short "Closing without shipping"
  note for `/agento close-session`; command table rows for close-session and ship.
- `docs/architecture.md` mermaid: `R -->|approve| SHIP`, `SHIP -->|reject| B`
  (back to the Builder in the open window), `SHIP -->|merge, sync, teardown, epilogue|
  DONE`; the `/agento close-session` edge becomes "plan/freehand/abandon".
- `templates/AGENTS-section.md` + `commands/agento-init.md` (and prompt mirror) step
  4 command list: order `… /agento ship, /agento close-session …` with a
  parenthetical that ship tears down the build worktree.
- `CHANGELOG.md` `## 0.4.0 (unreleased)`: one entry for the new ship flow, the split
  gap lists, the teardown pause, and the §8/§9 changes.

### 8. Guard test (`tests/customizations.test.mjs`)

New test "guidance never sequences close-session before ship (ship-audit-first)":
over `guidanceFiles` (README, AGENTS.md, agents, prompts, instructions, `commands/`,
`docs/`, `templates/`), split each file into paragraphs (blank-line separated; fenced
code blocks count as paragraphs) and reject any paragraph matching
`/\/agento close-session\b[^\n]*?(→|then|,\s*then|and then)[^\n]*?\/agento ship\b/` or
`/\/agento ship\b[^\n]*?\bafter\b[^\n]*?\/agento close-session\b/`, with an
allowlist of `CHANGELOG.md`; `features/**` and `initiatives/**` are not in
`guidanceFiles` and stay historical. Also add a canary to the single-source test that
the string `paused at teardown` appears exactly in the ship prompt and nowhere else in
guidance, and extend the `§9` table check (if present from `command-receipts`) to
require the ship row to contain `teardown`.

### 9. Rehearsal (roadmap step 4.x)

Dry-run the new prompt text against a scratch clone with a fake `worktrees.dir`: a
managed worktree on `feature/widget` with a complete roadmap and approving review;
walk the ship steps manually (`ship-preflight` → owner → audit against
`origin/feature/widget` → `git -C` status/zero-ahead → status commit in the owner →
worktree remove → `branch -d`), recording the command transcript under
`evidence/step-4-2-ship-rehearsal.md` (text, like the existing
`features/2026/09/initiatives-core/evidence/step-5-3-rehearsal.md`). A second
transcript exercises the reject path (dirty owner worktree → no writes, `merge
--abort` leaves it clean) and the pause path (a process holding the worktree cwd →
guard `ask` → pause result line).

### Files touched

`.github/prompts/ship.prompt.md`, `commands/ship.md`,
`.github/prompts/close-session.prompt.md`, `commands/close-session.md`,
`.github/prompts/next-feature.prompt.md`, `commands/next-feature.md`,
`.github/prompts/agento-init.prompt.md`, `commands/agento-init.md`,
`.github/instructions/delivery-policy.instructions.md`,
`.github/agents/delivery-reviewer.agent.md`, `delivery-builder.agent.md`,
`delivery-autopilot.agent.md`, `delivery-planner.agent.md`,
`scripts/session-state.mjs`, `scripts/session-state.test.mjs`,
`scripts/delivery-roadmap-resolver.test.mjs`, `tests/customizations.test.mjs`,
`README.md`, `docs/commands.md`, `docs/architecture.md`,
`templates/AGENTS-section.md`, `CHANGELOG.md`,
`features/2026/09/ship-audit-first/evidence/*.md`.

## Risks

- **PR #19 (`window-aware-commands`) is a hard sequencing prerequisite** — it lands
  the `owner` field and rewrites the same ship/close-session/policy passages. If #19
  receives `request-changes` or is not merged when the build starts, the Builder
  pauses at step 1.1 (pause protocol: `status: paused`, `next-step: 1.1`) and resumes
  when `git merge-base --is-ancestor <#19 merge sha> HEAD` holds. No part of this
  feature is built against the pre-#19 text.
- **PR #18 (`capability-preflight`) touches every file here** with one added line per
  prompt/agent and a new `doctor` command. Mitigation: integrate `origin/main` before
  every push (policy §7); conflicts are line-adjacent insertions resolved by keeping
  both lines.
- **Ship writes into a worktree it does not run in** (`git -C <owner.path>`). A stale
  or dirty owner would corrupt the build session. Mitigation: hard-reject unless
  `status --porcelain` is empty and zero-ahead; the only mutation on a rejected audit
  is `merge --abort` restoring the pre-merge state; never `--force`; never check the
  branch out in the primary while an owner exists.
- **Teardown blocked by the still-open secondary window.** The delivery guard returns
  `ask` on `git worktree remove` when a VS Code window or process occupies the path.
  Mitigation (Decision Q4): ship never answers the ask; it pauses with the exact
  result line and re-send resumes at teardown via the new §9 row. `main` is already
  merged and synced at that point, so nothing is lost by pausing.
- **`branch -d` after teardown on a not-yet-fetched state.** Mitigation: teardown
  runs after `git fetch --prune` and the `main` fast-forward, so the deleted remote
  branch is known and the local branch is provably an ancestor.
- **Session record table change alters `allowed[]` order** consumed by rejections
  and by `continue-command` later. Mitigation: tests pin the new order; the change is
  data in one table with a comment citing §8.
- **Prose drift back to close-then-ship.** Mitigation: the new customizations test
  fails on any guidance paragraph sequencing close-session before ship.
- **Byte-identity between prompts and `commands/`.** Every prompt step's verify runs
  the customizations suite, which asserts identity.

## Out of scope

- `/agento continue` and `agento.mjs next` (the `continue-command` member consumes
  the new ship flow; no composition logic here).
- The SessionStart hook and its `Session:` line (`scripts/hooks/session-context.sh`
  is untouched; the hook already prints whatever `allowed[]`/`elsewhere[]` the table
  yields).
- `agento.mjs doctor`, `Needs:`/`Fallback:` lines (`capability-preflight`).
- Any change to `closeBuildSessionDecision`, `findOwner`, or the `owner` shape
  themselves (landed by `window-aware-commands`); this feature only adds tests over
  the paths ship consumes.
- Removing `/agento close-session`'s build-close mode — it stays for abandoned or
  pre-closed sessions.
- Bumping `plugin.json`/`package.json`; the `0.4.0 (unreleased)` heading is stamped
  by whichever ship bumps the version.
- Freehand (`changes/<slug>`) sessions and `/agento finish-freehand`.

## Acceptance checklist

- [ ] `git merge-base --is-ancestor <PR #19 merge sha> HEAD` succeeds on the feature
  branch and `node scripts/agento.mjs ship-preflight feature <slug>` output contains
  an `owner` key — verified by running both on the branch.
- [ ] `commands/ship.md` (≡ `.github/prompts/ship.prompt.md`) no longer instructs
  the user to run `/agento close-session` before shipping; `grep -n "close-session"
  commands/ship.md` returns only the teardown/abandon references.
- [ ] `commands/ship.md` documents both ownership paths: `owner !== null` (read-only
  audit against `origin/<branch>`, clean + zero-ahead owner required, writes via
  `git -C <owner.path>`, `merge --abort` on conflict, reject naming
  `/agento build-<type> <slug>`) and `owner === null` (today's primary checkout) —
  verified by reading the prompt and by the rehearsal transcripts in `evidence/`.
- [ ] `commands/ship.md` pins the two gap lists exactly as Decision Q3: hard-reject
  (unticked non-post-ship steps, falsely ticked steps, review missing/stale/
  request-changes, issue regression test failing, dirty or unpushed owner worktree,
  PR `CONFLICTING`) naming `/agento review-<type> <slug>` when the review is the only
  gap else `/agento build-<type> <slug>`; confirmation path (unstamped changelog, PR
  body/title nits, undocumented unrelated drift); missing `Fixes #<n>` fixed via `gh
  pr edit` — verified by grep for each list item.
- [ ] `commands/ship.md` step 3 performs teardown after the `main` sync (`git
  worktree remove <owner.path>`, `git worktree prune`, `git branch -d <branch>`),
  never answers the guard's ask, and pauses with exactly `Result: completed — paused
  at teardown (worktree <path> still open); next: close that VS Code window, then
  /agento ship <slug>` — verified by grep for the result line.
- [ ] Policy §9 ship row contains the teardown-resume case ("`status: complete`, PR
  merged, and a managed worktree still owning the branch resumes at teardown") and
  §8 item 2 names `/agento ship <slug>` as the step after approval with standalone
  `/agento close-session` reserved for plan/freehand sessions and abandoned builds;
  §10's ship parenthetical is removed — verified by grep.
- [ ] `scripts/session-state.mjs` table lists ship before close for approved
  deliveries and names ship (resume at teardown) for `build|plan × shipped`;
  `scripts/session-state.test.mjs` asserts the new order and reasons — verified by
  `node --test scripts/session-state.test.mjs`.
- [ ] `scripts/delivery-roadmap-resolver.test.mjs` covers `evaluateShipPreflight`
  with a managed owner (`owner.path`, `owner.role`), a promoted `plan-*` owner, and
  no `worktreeList` (`owner === null`) — verified by `node --test
  scripts/delivery-roadmap-resolver.test.mjs`.
- [ ] `tests/customizations.test.mjs` has a test that rejects any guidance paragraph
  sequencing `/agento close-session` before `/agento ship` (→/then/and then, or "ship
  … after … close-session") over README, AGENTS.md, agents, prompts, instructions,
  `commands/`, `docs/`, `templates/`, allowlisting `CHANGELOG.md`; it fails when a
  fixture line `/agento close-session feature/x → /agento ship x` is injected into
  a guidance file and passes on the branch — verified by running the suite with and
  without the injected line.
- [ ] No guidance file (README, docs, agents, prompts, commands, template) describes
  close-session as the step before ship; `commands/next-feature.md` L42, `docs/
  commands.md` flows, README §5/§6, `docs/architecture.md` mermaid, Reviewer/Builder/
  Autopilot/Planner handoffs, `templates/AGENTS-section.md`, and `commands/
  agento-init.md` are updated — verified by the new customizations test plus manual
  read.
- [ ] `commands/close-session.md` states that ship performs the build close after
  merging and that this command is for plan/freehand sessions and abandoned builds,
  with build-close behaviour otherwise unchanged — verified by diff.
- [ ] `CHANGELOG.md` `## 0.4.0 (unreleased)` has an entry for ship-audit-first;
  `plugin.json` and `package.json` remain `0.3.0` — verified by grep.
- [ ] Rehearsal transcripts exist under `features/2026/09/ship-audit-first/evidence/`
  for the happy path (audit → owner-side commit → merge simulated → teardown →
  `branch -d`), the reject path (dirty owner → no writes, `merge --abort` leaves the
  owner clean), and the pause path (occupied worktree → guard `ask` → pause result
  line) — verified by reading the files.
- [ ] Full gate: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` exits
  0 with zero failures; `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh`
  exits 0; `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exits 0 —
  compared against the recorded green baseline (no new findings).
