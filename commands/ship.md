---
description: "Acceptance gate: audit a feature/issue against roadmap, codebase, and review while its build worktree is still open, reject back to that window on a real gap, merge its PR on a clean audit or explicit confirmation, then tear the build worktree down"
argument-hint: "Slug of the feature or issue to ship"
agent: "agent"
---

Needs: terminal, gh, network
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Ship the work named by the slug in the argument. Resolve it with the Agento CLI:
`node <agento-root>/scripts/agento.mjs find <slug>` (the CLI path is announced in the
session context as `Agento CLI:`), then `agento.mjs ship-preflight <type> <slug>` with
the `type` it returned. A `source: remote` resolution (no local roadmap, artifact read
from `origin/<branch>`) is valid and must not be treated as a hard block; `conflict`,
`branch-mismatch`, and `missing` are — report the `message` verbatim and stop. This
prompt authorizes marking the PR ready, merging it through the repository ruleset,
deleting the merged branch, syncing the default branch, and removing the build
worktree that owned the branch — after the audit and confirmation steps below. Read
the default branch and post-ship prefix from `agento.mjs config` (`branches.default`,
`branches.postShip`); `main` below stands for the configured default.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row: a roadmap already `status: complete` with unticked
`(manual, post-ship)` steps skips straight to step 5 (post-ship verification
epilogue); a roadmap `status: complete` on `main` whose PR is merged while a managed
worktree still owns the branch resumes at the teardown in step 3, then the epilogue
if post-ship steps remain; an already-merged PR with no owning worktree only syncs
`main` and reports it. Before the first write, run
`node <agento-root>/scripts/agento.mjs doctor --for ship` and map `fail`/`warn` per
§10.
Window check per §11: requires role `primary`.

**Ownership.** Read `owner` from the `ship-preflight` result (`{ path, role,
dirPrefix, id } | null`, derived by the CLI from `git worktree list --porcelain` for
the roadmap's branch). It selects one of two paths for every git operation below;
`role: "primary"` means the primary worktree itself sits on the branch — stop and
return it to `main` first.

- `owner !== null` (a managed `plan` or `build` worktree still owns the branch — the
  normal case straight after `Verdict: approve`). The audit is read-only from the
  primary against `origin/<branch>`: `git fetch origin`; read roadmap.md, review.md,
  and plan.md with `git show origin/<branch>:<path>`; diff with
  `git diff origin/main...origin/<branch>`. Require `git -C <owner.path> status
  --porcelain` to print nothing and `git -C <owner.path> rev-list --count
  @{upstream}..HEAD` to print `0`; either failing is a hard-reject gap (step 2). Every
  write happens in the owner worktree: `git -C <owner.path> merge origin/main` when
  the PR is `BEHIND`, the `status: complete` commit and changelog stamp, and
  `git -C <owner.path> push`. A conflicting integration merge is build-window work:
  `git -C <owner.path> merge --abort`, confirm `status --porcelain` is empty again,
  and reject naming `/agento build-<type> <slug>` for the open window.
- `owner === null` (the session was already closed, or this is a re-send after
  teardown). Fetch, check out the work branch in the primary, integrate, commit, and
  push from there. Closing the session before shipping therefore stays valid.

Never check the branch out in the primary while an owner exists (git refuses anyway);
never create a temporary detached checkout — it is a second place to lose commits.
Ownership does not apply when resuming only the post-ship epilogue.

1. **Audit** (read-only):
   - Fetch; on the `owner === null` path check out the work branch and integrate
     `origin/<branch>` if ahead; on the `owner !== null` path read everything from
     `origin/<branch>` as described above and run the clean and zero-ahead checks.
   - `gh pr view <n> --json mergeStateStatus,mergeable`: `BEHIND` means `origin/main`
     must be merged into the branch (never rebase) before the PR can be marked ready
     — in the owner worktree via `git -C <owner.path>` when one exists; list the
     touched files as an audit note. `CONFLICTING` is a hard-reject gap: the
     conflict is resolved in the build window per the hotspot recipes in
     [concurrent-delivery.instructions.md](../instructions/concurrent-delivery.instructions.md),
     not here.
   - roadmap.md: list unticked steps; spot-check ticked steps against the actual
     codebase and note falsely ticked ones (code is truth). Unticked
     `(manual, post-ship)` steps are expected only under the documented exception in
     delivery-policy.instructions.md §4. Queue valid exceptions for step 5; list
     unjustified deferrals as gaps.
   - review.md: present and `Verdict: approve`? Note if missing, stale (older than the
     last code commit), or `request-changes`.
   - Issues only: the exposing regression test passes, plan.md `## Resolution` is
     written, and the PR body contains `Fixes #<github-issue>` so the merge closes the
     GitHub issue.
   - PR state and required checks via `gh pr view` / `gh pr checks`.
   - Release entry: does `git diff origin/main...origin/<branch> -- plugin.json
     package.json` change `"version"`? If so, `CHANGELOG.md` should carry a
     `## <version> (unreleased)` heading that step 3 stamps. If `CHANGELOG.md` has an
     `(unreleased)` heading but the version is unchanged, report it as a gap (it is
     not stamped).
2. **Sort the gaps** into the two pinned lists; nothing else counts as a gap.
   - **Hard-reject** — any of: unticked steps that are not `(manual, post-ship)`;
     falsely ticked steps; review.md missing, stale, or `request-changes`; an issue's
     regression test failing; the owner worktree dirty or unpushed; PR
     `CONFLICTING`. Write nothing (the only permitted cleanup is the `merge --abort`
     above) and end with the §9 failed result line carrying `<gaps>; next: <command>`,
     where `<command>` is `/agento review-<type> <slug>` when the review is the only
     gap, otherwise `/agento build-<type> <slug>` (the Builder fix handoff) — both run
     in the still-open secondary window at `owner.path`; when `owner === null`, name
     `/agento start-session <type>/<slug> --resume` instead.
   - **Confirmation path** — unstamped changelog, PR body/title nits, undocumented
     unrelated drift. Present them in one summary, ask the user explicitly whether to
     proceed (default is do not proceed), and on yes record them under
     `## Follow-ups (accepted at ship)` in roadmap.md during step 3. Never proceed on
     these without the user's answer. A missing `Fixes #<n>` on an issue PR is not a
     question: fix it with `gh pr edit <n> --body` and note it in the report.
3. **On confirmation (or a clean audit)** — writes go through `git -C <owner.path>`
   when an owner exists, else the primary checkout:
   - Set roadmap `status: complete`; record any user-accepted gaps under the
     `## Follow-ups (accepted at ship)` section in roadmap.md. **Changelog date
     stamp:** when the branch changes the plugin version (audit above) and
     `CHANGELOG.md` contains the heading `## <version> (unreleased)`, replace
     `(unreleased)` on that heading with `(<date>)` where `<date>` is the output of
     `date -u +%Y-%m-%d` — in this same commit, immediately before checks and merge,
     never as a manual step. Commit and push.
   - Mark the draft PR ready for review; wait for every required check with
     `scripts/wait-for-checks.sh pr <n>` in the foreground (exit 2 = still pending:
     rerun it; bounded polls only, per delivery-policy.instructions.md §6).
     Failing or pending required checks are the one hard stop — the ruleset enforces
     them and they must not be bypassed; report them as a resumable blocker. If
     shipping resumes on a later UTC date after such a stop, refresh the stamped
     heading to the new `date -u +%Y-%m-%d` in one more commit before the successful
     merge.
   - Merge with a normal merge commit through the ruleset (no admin, no bypass) and
     delete the remote work branch. In the primary: switch to `main` (it already is
     on the owner path), `git fetch --prune`, fast-forward, and verify a clean tree
     with zero ahead/behind.
   - Release workflow: if the target repo's `.github/agento.json` sets
     `checks.releaseWorkflow`, dispatch that workflow (or resolve its existing run
     whose `headSha` exactly matches the merge commit, allowing for GitHub's short
     run-registration delay) and watch it with bounded foreground polls via
     `scripts/wait-for-checks.sh run <run-id>` (exit 2 = still pending: rerun it);
     record the outcome. Otherwise skip this step. A failed, cancelled, or timed out
     release run is a resumable hard stop; never substitute a run for another commit
     or trigger a duplicate release.
   - **Teardown** (only when `owner !== null`): `git worktree remove <owner.path>`
     with the literal resolved path, then `git worktree prune`, then `git branch -d
     <branch>` (safe: the remote branch is gone and the local one is an ancestor of
     `origin/main`). The removal triggers the delivery guard's occupant check; never
     answer that ask yourself. If the guard reports the VS Code window or a process
     still occupying the path, stop here with the §9 completed result line whose state
     and next step read exactly
     `paused at teardown (worktree <path> still open); next: close that VS Code window, then /agento ship <slug>`
     — `main` is already merged and synced, and the re-send resumes at this bullet
     per the §9 row. When `owner === null`, delete the merged local branch from the
     primary as before.
4. **Report** merge result, PR number, release workflow result and run URL (or that no
   release workflow is configured), the removed worktree path (or that none was
   registered), and any accepted gaps carried into Follow-ups. Do not call the work
   shipped while its release workflow is pending.
5. **Post-ship verification epilogue** (only if unticked `(manual, post-ship)` steps
   remain; runs after the merge, `main` sync, and teardown):
   - After any configured release workflow succeeds (or right away when none is
     configured), walk the user through each manual check per the manual step
     protocol (delivery-policy.instructions.md §3): exact instructions, screenshot
     into the slug's `evidence/`, tick with completion date and evidence link.
   - Land it without ceremony: from fresh `main`, create `post-ship/<slug>`, commit the
     evidence files + roadmap tick as one commit, push, open a PR, merge it through the
     ruleset once required checks pass (normal merge commit, no bypass), delete the
     branch, and sync `main`. The user's /agento ship invocation authorizes this merge.
   - If the user cannot verify yet, stop and report that re-running /agento ship with the slug
     resumes exactly here (the duplicate-submission rule cited above).

Never force-push, rebase, squash, amend, or create additional content commits beyond
the roadmap status commit (which carries the changelog date stamp when the plugin
version changed), a refresh of that stamp when the merge lands on a later UTC date, a
ruleset-required integration merge of `origin/main`, and the single post-ship
evidence commit from step 5. Never `git worktree remove --force` or otherwise discard
the owner worktree's state; on a rejected audit the only permitted cleanup is the
`git -C <owner.path> merge --abort` that restores the pre-merge state.
