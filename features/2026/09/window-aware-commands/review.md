# Review: window-aware-commands

Verdict: approve

Review round 2, at `d595e61` on `feature/window-aware-commands` (draft PR #19, head
`d595e61`), 2026-09-14. Round 1 (at `da45a66`) returned `request-changes` with one
blocking finding — the branch was not integrated with `origin/main` `42d111c` after
`capability-preflight` (#18) merged and took `## 10`. The Builder addressed it in
roadmap step 4.3 (merge commit `bb5a4da`, tick `d595e61`): `git merge-base
--is-ancestor origin/main HEAD` now exits 0; the window check landed as `## 11.
Window check` and every citation of this delivery reads `§11`.

This worktree (`plan-20260914-223201`, `role: build`, `delivery.slug:
window-aware-commands`) owns the branch per `agento.mjs session` (`worktrees[]` shows
no other entry on it; the third registered worktree is on `feature/ship-audit-first`).
`doctor --for review-feature` → `ok` (gh authenticated, origin reachable). Skills
consulted: none — no matching domain (no `.agents/skills/`, no `## Agento` skills
table in AGENTS.md).

Verification run by the Reviewer at `d595e61` against the merged tree (baseline in
plan.md `## Research`: 101 pass / 0 fail, shellcheck 0, replay 0):

- `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` → exit 0, no findings.
- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, **120 pass /
  0 fail** (`# tests 120 / # pass 120 / # fail 0`; `grep -c '^not ok'` → 0). +19 over
  the baseline (+11 from this delivery, +8 from `capability-preflight` via the merge);
  no pre-existing findings to carry.
- `bash scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
- `git diff --stat origin/main...HEAD -- scripts/hooks .github/hooks plugin.json
  package.json AGENTS.md` → empty (no hook edit, no version bump).
- `cmp` of all 23 `.github/prompts/*.prompt.md` (incl. the new `doctor`) against
  `commands/*.md` → 0 mismatches; `ls commands/*.md | wc -l` → 23.
- `grep -rln '^<<<<<<< \|^>>>>>>> \|^=======$'` over `.github commands docs scripts
  tests README.md CHANGELOG.md` → empty (no leftover conflict markers).
- Every prompt and agent still carries `capability-preflight`'s `Needs:` and
  `Fallback:` lines (loop over 23 prompts + 6 agents → none missing).

## Acceptance checklist results

(plan.md's note: `§10` in the checklist text means the window check, which is `§11`.)

1. **`session` emits `hosted` and `worktrees[]`; current entry matches top-level
   `role`** — **pass**. `scripts/agento.mjs` `session` case emits `hosted` and
   `worktrees: classified` (diff hunk L587–611); `scripts/agento.test.mjs` asserts the
   shape from primary, build, and unmanaged cwds (in the 120). Manual run from this
   worktree: keys `status, role, hosted, worktree, worktrees, delivery, pr, lifecycle,
   allowed, elsewhere, warnings, root, configSource`; `hosted: false`; top-level
   `role: "build"`; the `worktrees[]` entry for
   `/home/david/DP/agento-worktrees/plan-20260914-223201` is `{ branch:
   "feature/window-aware-commands", detached: false, role: "build", dirPrefix: "plan",
   id: "20260914-223201", isPrimary: false, isManaged: true }`.
2. **Hosted detection** — **pass**. `scripts/session-state.mjs` `HOSTED_VARS` +
   `deriveRole` (branch-only role, `reason` string); `classifyByPath` keeps path rules
   for `classifyWorktrees`. Tests: hosted `CODESPACES`/`GITHUB_ACTIONS` cases and the
   `deepEqual` "env absent … unchanged" case in `session-state.test.mjs`, plus the
   `agento.test.mjs` "hosted workspaces derive the role from the branch and warn once".
   Manual: `GITHUB_ACTIONS=true node scripts/agento.mjs session` → `hosted: true`,
   `role: "build"`, `warnings: ["hosted-workspace: role derived from the branch
   (GITHUB_ACTIONS=true)"]`; with both variables unset → `hosted: false`, no warning.
3. **`close-decision` / `ship-preflight` return `owner`; exact ownership** — **pass**.
   `scripts/delivery-roadmap-resolver.mjs` `branchOwner` (parses the list, resolves
   `worktrees.dir` against the primary entry, delegates to `findOwner`);
   `closeBuildSessionDecision` returns `primary-owns-branch` / `managed-worktree-present`
   / `remote-roadmap-only` each with `owner`; `evaluateShipPreflight` takes optional
   `worktreeList` and returns `owner`; CLI `ship-preflight` passes `git worktree list
   --porcelain`. `grep -n "currentBranch !== \|managedPattern\|escapeRegExp"
   scripts/delivery-roadmap-resolver.mjs` → empty. Fixtures in
   `delivery-roadmap-resolver.test.mjs` cover the managed entry under
   `config.worktrees.dir`, primary owner, lookalike path outside `worktrees.dir`,
   `currentBranch` equal to the delivery branch with no owner, and ship-preflight
   with/without the list. Manual: both subcommands for this slug → `owner` = this
   worktree, `role: "build"`; `close-decision` `reason: managed-worktree-present`.
4. **Policy window-check section without a roles table** — **pass**. `grep -n "^## "
   .github/instructions/delivery-policy.instructions.md` → `232:## 10. Capability
   preflight`, `293:## 11. Window check` (the "next free number per Risks"). §11 states
   the CLI call, the role compare, the `rejected` form with record alternatives, the
   `unmanaged` rule (`worktrees[0].path`, no `main` carve-out), the `hosted` rule, and
   the branch-condition rule, and says the roles table lives in `deriveAllowed`.
   `awk '/^## 11\. /,0' … | grep -c '^|'` → 0 table rows. Frontmatter `description`
   extended. "§N exists" (`sections.size >= 11`) and canary tests pass.
5. **Every prompt, mirror, and agent cites the window check with `requires role`** —
   **pass**. `grep -L "§11" .github/prompts/*.prompt.md commands/*.md
   .github/agents/*.agent.md` → empty (52 files). All 23 prompts and 6 agents carry a
   `Window check per §11: requires role …` line matching the Approach table:
   `primary` (`close-session`, `ship`), `primary` on the default branch, clean
   (`start-session`, `start-freehand`, `quick-fix`, `new-initiative`, Architect),
   `primary` on a non-default branch (`commit-current-changes`), `plan` — or `build`
   when resuming the promoted planning worktree (`new-feature`, `new-issue`, Planner),
   `build` with `delivery.slug` equal to the argument (`build-*`, `review-*`, `ap`,
   Builder, Reviewer, Autopilot), `freehand` with slug (`finish-freehand`), `any`
   (`delivery-status`, `next-feature`, `agento-init`, `install-skills`,
   `triage-followups`, `extend-copilot`, `fix-copilot`, `doctor`, Mechanic). The
   "declares its window check (§11)" test passes.
6. **Porcelain allowlist** — **pass**. `grep -l "worktree list --porcelain"
   .github/prompts/*.md .github/agents/*.md commands/*.md` → exactly
   `close-session`, `ship`, `start-freehand`, `start-session` (prompt + mirror each, 8
   files, no agent). The allowlist test passes and names `ship-audit-first` in its
   comment.
7. **Planner defers hosted handling to the record** — **pass**.
   `.github/agents/delivery-planner.agent.md` L53: "Hosted workspaces (Codespaces,
   Actions, the coding agent) are handled by the record's `hosted` flag"; `grep -n
   "coding-agent workspace is exempt"` over agents, prompts, and mirrors → empty.
8. **`close-session` and `ship` handle `primary-owns-branch`** — **pass**.
   `close-session.prompt.md` L71–73: `primary-owns-branch` → "Stop: return the primary
   to `main` first (`git switch main`), nothing to remove"; `ship.prompt.md` L34–38:
   `role: "primary"` → "stop and return it to `main` first", `null` → proceed, managed
   owner → `/agento close-session`. Both mirrors byte-identical (`cmp` loop above).
9. **Docs and CHANGELOG describe `hosted`, `worktrees[]`, `owner`, §11; no version
   bump** — **pass**. `grep -n "hosted\|owner\|§11\|Window check"` shows
   `docs/commands.md` L30/L36/L52, `docs/architecture.md` L48 (alongside §10 at L46),
   `docs/hooks.md` L11, `README.md` L418–420, `CHANGELOG.md` L58–76 (**Window-aware
   commands (policy §11)** under `## 0.4.0 (unreleased)`, L3). Both 0.4.0 entries kept:
   `capability-preflight`'s **New `agento.mjs doctor` and per-command preflight** (L5)
   and this one (L58). `git diff origin/main...HEAD -- plugin.json package.json` → empty.
10. **Full lint gate against the baseline** — **pass**. Commands and outputs above:
    shellcheck 0; 120/0 (> 101, 0 failures); replay 0. `git diff --stat
    origin/main...HEAD` → 68 files, all within Approach "Files touched" plus the
    `doctor` prompt/mirror (which exists only because of the merge and gained the §11
    line) and the delivery's own artifacts; no `scripts/hooks/*`, `.github/hooks/*`,
    `AGENTS.md`, `plugin.json`, `package.json`.

## Plan vs implementation

- The plan's `## 10. Window check` landed as `## 11. Window check` exactly as
  `## Risks` predicted; plan.md carries the one-line §11 notes on `## Approach` and
  `## Acceptance checklist` rather than a rewrite. Consistent with the Risks recipe.
- The `doctor` prompt and `commands/doctor.md` (from `capability-preflight`) gained a
  `Window check per §11: requires role any` line in the merge commit — the only
  consumer not listed in the plan's Approach table, and required by the uniform
  citation test. Documented on roadmap 4.3.
- Minor deviation carried from round 1, documented on roadmap 1.3: the resolver test
  fixture resolves the managed entry with `path.resolve(root, config.worktrees.dir,
  "feature-widget")` rather than `path.join(config.worktrees.dir, …)`, because
  `worktrees.dir` is relative to the primary entry. Behaviour matches the plan.
- `branchOwner` loads the primary checkout's config when `rootDir` is a linked
  worktree (plan implied `findOwner` only) — necessary for `close-decision` run from a
  build worktree; covered by the manual run from this worktree.
- Roadmap 3.7 reflow repair (single-line §11 regex) unchanged from round 1.
- No undocumented changes in `git diff origin/main...HEAD`.

## Roadmap audit

All 16 ticked steps spot-checked against `d595e61`:

- 1.1–1.3 — `session-state.mjs` (`deriveRole` env/hosted, `classifyWorktrees`,
  `findOwner`), `agento.mjs` `session`/`ship-preflight`, resolver `branchOwner` and
  the three reasons: present in the diff; tests in the 120.
- 1.4, 4.2 — gates recorded at `3d2bac3` were true at the time; the merged-tree
  rerun above supersedes them.
- 2.1, 2.2 — `## 11. Window check` at L293; `customizations.test.mjs` has the
  `>= 11` guard, the `§11 … requires role` test, and the porcelain allowlist test.
- 3.1–3.7 — every `Window check per §11` line listed under checklist item 5 matches
  the step's stated role; porcelain removed everywhere outside the allowlist.
- 4.1 — docs/CHANGELOG grep under checklist item 9.
- 4.3 — the step added in round 1: `merge-base --is-ancestor` exit 0; merge commit
  `bb5a4da` has both parents (`7aacdff`, `42d111c`); headings 10/11; `grep -L "§11"`
  empty; 23-file `cmp` loop empty; no conflict markers; `Needs:`/`Fallback:` retained
  in all 29 prompt/agent files; hooks/plugin/package diff empty; gate 120/0.

No falsely ticked box; no `(manual)` or `(manual, post-ship)` steps; no repairs made.
The roadmap header (`status: in-review`, `next-step: ""`) is left as is.

## Findings

- **Minor** — `scripts/session-state.mjs` `FREEHAND` row of `deriveAllowed` still
  lists `/agento commit-current-changes` while `commit-current-changes.prompt.md`
  requires `primary` on a non-default branch (Decision Q1): a freehand record
  advertises a command that rejects itself. Table rows are explicitly out of scope;
  recorded under roadmap Follow-ups. Not blocking.
- **Minor** — `scripts/delivery-roadmap-resolver.mjs`: `closeBuildSessionDecision`
  passes `worktreeList ?? ""` while `evaluateShipPreflight` passes it raw, so an
  absent list reaches `owner: null` via two paths (`parseWorktreeList("")` vs the
  early return in `branchOwner`). Same result; cosmetic.
- No security-relevant changes: no new shell execution paths beyond the existing
  `git worktree list --porcelain` call, no secrets handling, hook scripts untouched.

## Follow-ups

- Drop `/agento commit-current-changes` from the `FREEHAND` row of `deriveAllowed`
  in `scripts/session-state.mjs` so the record's alternatives match the command's
  window-check requirement (already listed in roadmap.md Follow-ups).
- `ship-audit-first`: remove `ship` from the porcelain allowlist in
  `tests/customizations.test.mjs` and the `ship.prompt.md` `owner` precondition
  paragraph once ship consumes `owner` for its post-merge close (plan.md Risks).
