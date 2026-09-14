# Review: window-aware-commands

Verdict: approve

Reviewed at `da45a66` on `feature/window-aware-commands` (draft PR #19), 2026-09-14.
`origin/main` (`3d2bac3`) is an ancestor of HEAD; this worktree
(`plan-20260914-223201`, `role: build`) owns the branch per `agento.mjs session`
(`worktrees[]` shows no other entry on the branch). Skills consulted: none — no
matching domain (no `.agents/skills/`, no `## Agento` skills table in AGENTS.md).

Verification run by the Reviewer:

- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no findings.
- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, **112 pass / 0 fail** (baseline in plan.md `## Research`: 101 / 0; +11 tests, no pre-existing findings to carry).
- `bash scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
- `git diff origin/main...HEAD -- scripts/hooks .github/hooks plugin.json package.json AGENTS.md` → empty (no hook edit, no version bump).
- `cmp` of all 22 `.github/prompts/*.prompt.md` against `commands/*.md` → 0 mismatches.

## Acceptance checklist results

1. **`session` emits `hosted` and `worktrees[]`; current entry matches top-level `role`** — **pass**.
   `scripts/agento.mjs` L460–474 emits both; `scripts/agento.test.mjs` asserts the `worktrees[]` shape from primary, build, and unmanaged cwds. Manual run from this worktree: `hosted: false`, top-level `role: "build"`, `worktrees[]` entry `/home/david/DP/agento-worktrees/plan-20260914-223201` with `role: "build"`, `dirPrefix: "plan"`, `id: "20260914-223201"`.
2. **Hosted detection (`CODESPACES=true` / `GITHUB_ACTIONS=true`)** — **pass**.
   `scripts/session-state.mjs` `deriveRole` L93–105 (`HOSTED_VARS`, branch-only role, `reason` string); tests in `session-state.test.mjs` ("hosted: CODESPACES=true derives build…", "…GITHUB_ACTIONS=true on the default branch derives primary…", "env absent, empty, or with other values leaves results unchanged" — `deepEqual` against the non-hosted result) and `agento.test.mjs` "session: hosted workspaces derive the role from the branch and warn once". Manual: `GITHUB_ACTIONS=true node scripts/agento.mjs session` → `hosted: true`, `role: "build"`, warning `hosted-workspace: role derived from the branch (GITHUB_ACTIONS=true)`. The test harness strips both variables from `baseEnv` so path-based assertions hold under CI.
3. **`close-decision` / `ship-preflight` return `owner`; exact ownership reasons** — **pass**.
   `scripts/delivery-roadmap-resolver.mjs` `branchOwner` L21–29 (parses the list, resolves `worktrees.dir` against the primary entry, delegates to `findOwner`), `closeBuildSessionDecision` L211–233 (`primary-owns-branch` → `managed-worktree-present` → `remote-roadmap-only`, `owner` on each), `evaluateShipPreflight` L259–277 (optional `worktreeList`, `owner`); CLI `ship-preflight` passes `git worktree list --porcelain` (L379). `grep -n "currentBranch !== " scripts/delivery-roadmap-resolver.mjs` → empty; `managedPattern`/`escapeRegExp` gone. Tests: rewritten managed fixture under `config.worktrees.dir` (+ promoted `plan-*`), `primary-owns-branch`, lookalike path outside `worktrees.dir` → `remote-roadmap-only`/`owner: null`, `currentBranch: "feature/widget"` with no owner → `remote-roadmap-only`, other-branch managed entry → null, `evaluateShipPreflight` with/without list. Manual: both subcommands for this slug return `owner` = this worktree with `role: "build"`.
4. **Policy `## 10. Window check` without a roles table** — **pass**.
   `.github/instructions/delivery-policy.instructions.md` §10 has the five-point procedure (CLI call, role compare, `rejected` form with record alternatives, `unmanaged` always rejects and names `worktrees[0].path`, `hosted` needs no exemption, branch conditions read `worktree.branch`) and states the roles table lives in `deriveAllowed`. `awk '/^## 10\. /,0' … | grep '^|'` → no table rows; frontmatter `description` mentions the window check. `tests/customizations.test.mjs` "§N exists" and canary tests pass.
5. **Every prompt, mirror, and agent cites §10 with `requires role`** — **pass**.
   `grep -L "§10" .github/prompts/*.prompt.md commands/*.md .github/agents/*.agent.md` → empty (50 files). New test "every command and agent declares its window check (§10)" passes. Roles match the Approach table: `primary` (start-session/start-freehand/quick-fix/new-initiative/Architect on default branch clean; close-session; ship), `plan`-or-`build` (new-feature/new-issue/Planner), `build` + slug equality (build-*/review-*/ap/Builder/Reviewer/Autopilot), `freehand` + slug (finish-freehand), `primary` on a non-default branch (commit-current-changes, `grep -n "non-default"` L18), `any` for the read-only set and the Mechanic.
6. **Porcelain allowlist** — **pass**.
   `grep -l "worktree list --porcelain"` over prompts, mirrors, agents → exactly `close-session`, `ship`, `start-freehand`, `start-session` (prompt + mirror each, 8 files); whitespace-tolerant `\s+` variant returns the same 8. New test "only worktree-mutating commands inspect `git worktree list --porcelain`" passes and names `ship-audit-first` in its comment.
7. **Planner defers to `hosted`** — **pass**.
   `grep -n "coding-agent workspace is exempt" .github/agents/delivery-planner.agent.md` → empty; L49 "Hosted workspaces (Codespaces, Actions, the coding agent) are handled by the record's `hosted` flag".
8. **`close-session` and `ship` handle `primary-owns-branch` without worktree removal** — **pass**.
   `close-session.prompt.md` build-close step 2 lists the three reasons; `primary-owns-branch` → "Stop: return the primary to `main` first (`git switch main`), nothing to remove". `ship.prompt.md` precondition paragraph reads `ship-preflight.owner`: managed → `/agento close-session`, `role: "primary"` → stop and return to `main`, `null` → proceed. Both mirrors byte-identical (`cmp`).
9. **Docs and changelog; no version bump** — **pass**.
   `docs/commands.md` (owner, reasons, `hosted`, `worktrees[]`, §10), `docs/architecture.md` (window check §10), `docs/hooks.md` and `README.md` (`hosted`, `worktrees[]`), `CHANGELOG.md` entry **Window-aware commands (policy §10)** under `## 0.4.0 (unreleased)`. `git diff origin/main...HEAD -- plugin.json package.json` → empty.
10. **Full lint gate vs baseline** — **pass**.
    shellcheck 0 / tests 112 pass 0 fail (> 101) / replay-guard 0, all run by the Reviewer (commands above). `git diff --stat origin/main...HEAD` → 65 files, all within plan.md "Files touched" (no `scripts/hooks/*`, `.github/hooks/*`, `AGENTS.md`, `plugin.json`, `package.json`).

## Plan vs implementation

- Implemented as planned; §10 stayed §10 (`capability-preflight` #18 has not landed, `origin/main` still `3d2bac3`), so no renumbering and a single CHANGELOG entry (Decision Q5).
- Minor deviation, documented on roadmap 1.3: the resolver test fixture uses `path.resolve(root, config.worktrees.dir, "feature-widget")` (absolute, first entry = `root`) rather than the plan's `path.join(config.worktrees.dir, …)`, because `worktrees.dir` is resolved relative to the primary entry. Behaviour matches the plan's intent.
- `branchOwner` in the resolver loads the primary checkout's config when `rootDir` is a linked worktree (the plan implied `findOwner` only) — necessary so `close-decision` run from a build worktree resolves `worktrees.dir` against the primary; covered by the manual run from this worktree.
- Roadmap 3.7 records a reflow repair: the §10 citation regex is single-line, so `quick-fix`, `ship`, and the Autopilot phrases were put on one line. Consistent with the test as written.
- No undocumented changes found in the diff.

## Roadmap audit

All 15 ticked steps spot-checked against the code and commands above; none falsely ticked, no repairs made. No `(manual)` or `(manual, post-ship)` steps exist. Step evidence lines (1.4, 2.2, 3.7, 4.2) match the Reviewer's independent reruns (112/0, 8 allowlisted porcelain files, 0 mirror mismatches).

## Findings

- **Minor** — `scripts/session-state.mjs` L253: the `FREEHAND` row of `deriveAllowed` still lists `/agento commit-current-changes` as allowed in a freehand worktree, while `commit-current-changes.prompt.md` now requires `primary` on a non-default branch (Decision Q1). A freehand window's record would advertise a command that the command itself rejects. Changing table rows is explicitly out of scope for this delivery and the Builder recorded it under roadmap Follow-ups; not blocking.
- **Minor** — `scripts/delivery-roadmap-resolver.mjs` `closeBuildSessionDecision` passes `worktreeList ?? ""` while `evaluateShipPreflight` passes it through raw, so an absent list yields `owner: null` via two different paths (`parseWorktreeList("")` vs the early return in `branchOwner`). Same result, slightly asymmetric; cosmetic.
- No security-relevant changes: no new shell execution paths, no secrets handling, hook scripts untouched.

## Follow-ups

- Drop `/agento commit-current-changes` from the `FREEHAND` row of `deriveAllowed` in `scripts/session-state.mjs` so the record's alternatives match the command's §10 requirement (already listed in roadmap.md Follow-ups).
- `ship-audit-first`: remove `ship` from the porcelain allowlist in `tests/customizations.test.mjs` and the `ship.prompt.md` precondition paragraph once ship consumes `owner` for its post-merge close (noted in plan.md Risks).
