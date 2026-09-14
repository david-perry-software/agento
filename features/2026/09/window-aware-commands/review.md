# Review: window-aware-commands

Verdict: request-changes

Reviewed at `da45a66` on `feature/window-aware-commands` (draft PR #19), 2026-09-14.
This worktree (`plan-20260914-223201`, `role: build`) owns the branch per
`agento.mjs session` (`worktrees[]` shows no other entry on it). Skills consulted:
none — no matching domain (no `.agents/skills/`, no `## Agento` skills table in
AGENTS.md).

**Blocking:** during this review `capability-preflight` (PR #18) merged and
`origin/main` moved `3d2bac3` → `42d111c`. `git merge-base --is-ancestor origin/main
HEAD` now exits 1, and `origin/main`'s `delivery-policy.instructions.md` already
carries `## 10. Capability preflight` (`git show origin/main:… | grep -n "^## "` →
`232:## 10. Capability preflight`). This branch's `## 10. Window check` and every
`§10` citation collide exactly as plan.md `## Risks` predicted; a dry-run
`git merge --no-commit --no-ff origin/main` (aborted, tree left clean) conflicts in
40 files: the policy file, 17 prompts + their 17 `commands/` mirrors,
`docs/architecture.md`, `docs/commands.md`, `scripts/agento.mjs`,
`scripts/agento.test.mjs`, `tests/customizations.test.mjs`. The implementation at
`da45a66` is sound (every check below passed against the pre-merge base), but a
branch that is not integrated with `main` cannot be approved (Reviewer procedure
step 1; policy §7; roadmap 4.2's own `git merge origin/main` verify).

Verification run by the Reviewer at `da45a66` against the pre-merge base `3d2bac3`
(must be rerun on the merged tree):

- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no findings.
- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, **112 pass / 0 fail** (baseline in plan.md `## Research`: 101 / 0; +11 tests, no pre-existing findings to carry).
- `bash scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
- `git diff origin/main...HEAD -- scripts/hooks .github/hooks plugin.json package.json AGENTS.md` (at `3d2bac3`) → empty (no hook edit, no version bump).
- `cmp` of all 22 `.github/prompts/*.prompt.md` against `commands/*.md` → 0 mismatches.

## Acceptance checklist results

1. **`session` emits `hosted` and `worktrees[]`; current entry matches top-level `role`** — **pass**.
   `scripts/agento.mjs` L460–474 emits both; `scripts/agento.test.mjs` asserts the `worktrees[]` shape from primary, build, and unmanaged cwds. Manual run from this worktree: `hosted: false`, top-level `role: "build"`, `worktrees[]` entry `/home/david/DP/agento-worktrees/plan-20260914-223201` with `role: "build"`, `dirPrefix: "plan"`, `id: "20260914-223201"`.
2. **Hosted detection (`CODESPACES=true` / `GITHUB_ACTIONS=true`)** — **pass**.
   `scripts/session-state.mjs` `deriveRole` L93–105 (`HOSTED_VARS`, branch-only role, `reason` string); tests in `session-state.test.mjs` ("hosted: CODESPACES=true derives build…", "…GITHUB_ACTIONS=true on the default branch derives primary…", "env absent, empty, or with other values leaves results unchanged" — `deepEqual` against the non-hosted result) and `agento.test.mjs` "session: hosted workspaces derive the role from the branch and warn once". Manual: `GITHUB_ACTIONS=true node scripts/agento.mjs session` → `hosted: true`, `role: "build"`, warning `hosted-workspace: role derived from the branch (GITHUB_ACTIONS=true)`. The test harness strips both variables from `baseEnv` so path-based assertions hold under CI.
3. **`close-decision` / `ship-preflight` return `owner`; exact ownership reasons** — **pass**.
   `scripts/delivery-roadmap-resolver.mjs` `branchOwner` L21–29 (parses the list, resolves `worktrees.dir` against the primary entry, delegates to `findOwner`), `closeBuildSessionDecision` L211–233 (`primary-owns-branch` → `managed-worktree-present` → `remote-roadmap-only`, `owner` on each), `evaluateShipPreflight` L259–277 (optional `worktreeList`, `owner`); CLI `ship-preflight` passes `git worktree list --porcelain` (L379). `grep -n "currentBranch !== " scripts/delivery-roadmap-resolver.mjs` → empty; `managedPattern`/`escapeRegExp` gone. Tests: rewritten managed fixture under `config.worktrees.dir` (+ promoted `plan-*`), `primary-owns-branch`, lookalike path outside `worktrees.dir` → `remote-roadmap-only`/`owner: null`, `currentBranch: "feature/widget"` with no owner → `remote-roadmap-only`, other-branch managed entry → null, `evaluateShipPreflight` with/without list. Manual: both subcommands for this slug return `owner` = this worktree with `role: "build"`.
4. **Policy `## 10. Window check` (or the next free number per Risks) without a roles table** — **fail (integration)**.
   Content is correct: `.github/instructions/delivery-policy.instructions.md` §10 has the five-point procedure (CLI call, role compare, `rejected` form with record alternatives, `unmanaged` always rejects and names `worktrees[0].path`, `hosted` needs no exemption, branch conditions read `worktree.branch`) and states the roles table lives in `deriveAllowed`; `awk '/^## 10\. /,0' … | grep '^|'` → no table rows; frontmatter `description` extended; "§N exists" and canary tests pass at `da45a66`. But `origin/main` `42d111c` already owns `## 10. Capability preflight`, so per this item's "next free number per Risks" clause the section must become `## 11. Window check`, with the frontmatter and the `sections.size` guard (`>= 11`) following.
5. **Every prompt, mirror, and agent cites the window-check section with `requires role`** — **fail (integration)**.
   At `da45a66`: `grep -L "§10" .github/prompts/*.prompt.md commands/*.md .github/agents/*.agent.md` → empty (50 files); new test "every command and agent declares its window check (§10)" passes; roles match the Approach table (`primary` for start-session/start-freehand/quick-fix/new-initiative/Architect on default branch clean, close-session, ship; `plan`-or-`build` for new-feature/new-issue/Planner; `build` + slug equality for build-*/review-*/ap/Builder/Reviewer/Autopilot; `freehand` + slug for finish-freehand; `primary` on a non-default branch for commit-current-changes, L18; `any` for the read-only set and the Mechanic). After integration every `Window check per §10` line of this delivery and the test regex must read `§11`, while the merged files keep `capability-preflight`'s `Needs:`/`Fallback:` lines and its own `§10` citations.
6. **Porcelain allowlist** — **pass**.
   `grep -l "worktree list --porcelain"` over prompts, mirrors, agents → exactly `close-session`, `ship`, `start-freehand`, `start-session` (prompt + mirror each, 8 files); whitespace-tolerant `\s+` variant returns the same 8. New test "only worktree-mutating commands inspect `git worktree list --porcelain`" passes and names `ship-audit-first` in its comment. Re-verify after the merge (the start-*/close-session/ship prompts are among the conflicting files).
7. **Planner defers to `hosted`** — **pass**.
   `grep -n "coding-agent workspace is exempt" .github/agents/delivery-planner.agent.md` → empty; L49 "Hosted workspaces (Codespaces, Actions, the coding agent) are handled by the record's `hosted` flag".
8. **`close-session` and `ship` handle `primary-owns-branch` without worktree removal** — **pass**.
   `close-session.prompt.md` build-close step 2 lists the three reasons; `primary-owns-branch` → "Stop: return the primary to `main` first (`git switch main`), nothing to remove". `ship.prompt.md` precondition paragraph reads `ship-preflight.owner`: managed → `/agento close-session`, `role: "primary"` → stop and return to `main`, `null` → proceed. Both mirrors byte-identical (`cmp`). `ship.prompt.md` conflicts on merge — re-check the paragraph and the mirror afterwards.
9. **Docs and changelog; no version bump** — **pass** (re-check after merge).
   `docs/commands.md` (owner, reasons, `hosted`, `worktrees[]`, §10), `docs/architecture.md` (window check §10), `docs/hooks.md` and `README.md` (`hosted`, `worktrees[]`), `CHANGELOG.md` entry **Window-aware commands (policy §10)** under `## 0.4.0 (unreleased)`. `git diff origin/main...HEAD -- plugin.json package.json` → empty. The docs' `§10` references and the CHANGELOG title must be renumbered; keep both CHANGELOG entries (Decision Q5).
10. **Full lint gate vs baseline and diff scope** — **fail (integration)**.
    shellcheck 0 / tests 112 pass 0 fail (> 101) / replay-guard 0, all run by the Reviewer — against `3d2bac3`. At `3d2bac3` `git diff --stat origin/main...HEAD` → 65 files, all within plan.md "Files touched". But `origin/main` is no longer an ancestor, roadmap 4.2's `git merge origin/main` verify no longer holds, and the merge currently conflicts in 40 files; the gate must be rerun on the merged tree and compared against the recorded 101 / 0 baseline plus whatever `capability-preflight` added.

## Plan vs implementation

- Implementation matches the plan; the deviation is the integration state. plan.md `## Risks` anticipated `capability-preflight` landing first and prescribed the response (renumber `## 10` → `## 11`, every `§10` citation written here → `§11`, `sections.size >= 11`, keep both CHANGELOG entries, merge — never rebase). Roadmap 1.4 and 4.2 recorded `origin/main` still at `3d2bac3` when they ran, which was true then; #18 merged afterwards.
- Minor deviation, documented on roadmap 1.3: the resolver test fixture uses `path.resolve(root, config.worktrees.dir, "feature-widget")` (absolute, first entry = `root`) rather than the plan's `path.join(config.worktrees.dir, …)`, because `worktrees.dir` is resolved relative to the primary entry. Behaviour matches the plan's intent.
- `branchOwner` in the resolver loads the primary checkout's config when `rootDir` is a linked worktree (the plan implied `findOwner` only) — necessary so `close-decision` run from a build worktree resolves `worktrees.dir` against the primary; covered by the manual run from this worktree.
- Roadmap 3.7 records a reflow repair: the §10 citation regex is single-line, so `quick-fix`, `ship`, and the Autopilot phrases were put on one line. Consistent with the test as written.
- No undocumented changes found in the diff.

## Roadmap audit

All 15 ticked steps spot-checked against the code and commands above; none was falsely ticked at the time it was ticked (1.4 and 4.2 explicitly record `origin/main` = `3d2bac3`), and their evidence lines match the Reviewer's reruns (112/0, 8 allowlisted porcelain files, 0 mirror mismatches). No `(manual)` or `(manual, post-ship)` steps exist. Integration work is now missing, so the Reviewer added roadmap step `4.3 (added 2026-09-14)`: merge `origin/main` (`42d111c`), renumber `## 10. Window check` → `## 11` and this delivery's `§10` citations → `§11` (policy frontmatter, prompts, mirrors, agents, docs, CHANGELOG title, `tests/customizations.test.mjs` regex and `>= 11` guard), keep both CHANGELOG entries and `capability-preflight`'s lines, rerun the full gate, push. `next-step` set to `4.3`; `status` stays `in-review` until the Builder fix handoff reruns 4.3.

## Findings

- **Blocking** — Branch not integrated with `origin/main` (`42d111c`); `## 10` and all `§10` citations collide with `capability-preflight`'s `## 10. Capability preflight`; 40-file merge conflict. Recipe: plan.md `## Risks` and concurrent-delivery.instructions.md (merge, never rebase). Evidence: `git merge-base --is-ancestor origin/main HEAD` → exit 1; `git show origin/main:.github/instructions/delivery-policy.instructions.md | grep -n "^## "` → `232:## 10. Capability preflight`; `git merge --no-commit --no-ff origin/main` → exit 1 with the conflict list above (aborted).
- **Minor** — `scripts/session-state.mjs` L253: the `FREEHAND` row of `deriveAllowed` still lists `/agento commit-current-changes` as allowed in a freehand worktree, while `commit-current-changes.prompt.md` now requires `primary` on a non-default branch (Decision Q1). A freehand window's record would advertise a command that the command itself rejects. Changing table rows is explicitly out of scope for this delivery and the Builder recorded it under roadmap Follow-ups; not blocking.
- **Minor** — `scripts/delivery-roadmap-resolver.mjs` `closeBuildSessionDecision` passes `worktreeList ?? ""` while `evaluateShipPreflight` passes it through raw, so an absent list yields `owner: null` via two different paths (`parseWorktreeList("")` vs the early return in `branchOwner`). Same result, slightly asymmetric; cosmetic.
- No security-relevant changes: no new shell execution paths, no secrets handling, hook scripts untouched.

## Follow-ups

- Drop `/agento commit-current-changes` from the `FREEHAND` row of `deriveAllowed` in `scripts/session-state.mjs` so the record's alternatives match the command's window-check requirement (already listed in roadmap.md Follow-ups).
- `ship-audit-first`: remove `ship` from the porcelain allowlist in `tests/customizations.test.mjs` and the `ship.prompt.md` precondition paragraph once ship consumes `owner` for its post-merge close (noted in plan.md Risks).
