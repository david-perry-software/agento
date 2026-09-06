---
description: "Acceptance gate: audit a feature/issue against roadmap, codebase, and review, warn about gaps, then merge its PR on explicit confirmation"
argument-hint: "Slug of the feature or issue to ship"
agent: "agent"
---

Ship the work named by the slug in the argument. Resolve it with the Agento CLI:
`node <agento-root>/scripts/agento.mjs find <slug>` (the CLI path is announced in the
session context as `Agento CLI:`), then `agento.mjs ship-preflight <type> <slug>` with
the `type` it returned. A `source: remote` resolution (no local roadmap, artifact read
from `origin/<branch>`) is valid and must not be treated as a hard block; `conflict`,
`branch-mismatch`, and `missing` are — report the `message` verbatim and stop. This
prompt authorizes marking the PR ready, merging it through the repository ruleset,
deleting the merged branch, and syncing the default branch — after the confirmation
step below. Read the default branch and post-ship prefix from `agento.mjs config`
(`branches.default`, `branches.postShip`); `main` below stands for the configured
default.

If the slug's roadmap is already `status: complete` but has unticked
`(manual, post-ship)` steps, skip straight to step 5 (post-ship verification epilogue).

Before the audit, inspect `git worktree list --porcelain` for the roadmap's branch. If
a secondary worktree owns it, stop and direct the user to run
`/close-session <type>/<slug>` from the primary workspace window, then rerun this
command in that same primary window. Do not offer raw git commands as an alternative.
Shipping requires exclusive checkout and branch cleanup; never force-remove
the worktree or discard its state. This precondition does not apply when resuming only
the post-ship epilogue after the work branch has already merged.

1. **Audit** (read-only):
   - Fetch; check out the work branch; integrate `origin/<branch>` if ahead.
   - `gh pr view <n> --json mergeStateStatus,mergeable`: `BEHIND` or `CONFLICTING`
     means `origin/main` must be merged into the branch (never rebase) before the PR
     can be marked ready; resolve conflicts per the hotspot recipes in
     [concurrent-delivery.instructions.md](../instructions/concurrent-delivery.instructions.md)
     and list the touched files as an audit note.
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
   - Release entry: does `git diff origin/main...HEAD -- plugin.json package.json`
     change `"version"`? If so, `CHANGELOG.md` should carry a `## <version>
     (unreleased)` heading that step 3 stamps. If `CHANGELOG.md` has an
     `(unreleased)` heading but the version is unchanged, report it as a gap (it is
     not stamped).
2. **Warn, don't block**: present one summary of every gap found (unticked or false
   checkboxes, missing/stale/negative review, drift, uncommitted changes). If gaps
   exist, ask the user explicitly whether to proceed anyway — default is do not
   proceed. Never proceed on gaps without the user's answer.
3. **On confirmation (or a clean audit)**:
   - Set roadmap `status: complete`; record any user-accepted gaps under a
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
   - Merge with a normal merge commit through the ruleset (no admin, no bypass),
     delete the work branch, switch to `main`, fetch, fast-forward, and verify a clean
     tree with zero ahead/behind.
   - Release workflow: if the target repo's `.github/agento.json` sets
     `checks.releaseWorkflow`, dispatch that workflow (or resolve its existing run
     whose `headSha` exactly matches the merge commit, allowing for GitHub's short
     run-registration delay) and watch it with bounded foreground polls via
     `scripts/wait-for-checks.sh run <run-id>` (exit 2 = still pending: rerun it);
     record the outcome. Otherwise skip this step. A failed, cancelled, or timed out
     release run is a resumable hard stop; never substitute a run for another commit
     or trigger a duplicate release.
4. **Report** merge result, PR number, release workflow result and run URL (or that no
   release workflow is configured), and any accepted gaps carried into Follow-ups. Do
   not call the work shipped while its release workflow is pending.
5. **Post-ship verification epilogue** (only if unticked `(manual, post-ship)` steps
   remain; runs after the merge and `main` sync):
   - After any configured release workflow succeeds (or right away when none is
     configured), walk the user through each manual check per the manual step
     protocol (delivery-policy.instructions.md §3): exact instructions, screenshot
     into the slug's `evidence/`, tick with completion date and evidence link.
   - Land it without ceremony: from fresh `main`, create `post-ship/<slug>`, commit the
     evidence files + roadmap tick as one commit, push, open a PR, merge it through the
     ruleset once required checks pass (normal merge commit, no bypass), delete the
     branch, and sync `main`. The user's /ship invocation authorizes this merge.
   - If the user cannot verify yet, stop and report that re-running /ship with the slug
     resumes exactly here.

Never force-push, rebase, squash, amend, or create additional content commits beyond
the roadmap status commit (which carries the changelog date stamp when the plugin
version changed), a refresh of that stamp when the merge lands on a later UTC date, a
ruleset-required integration merge of `origin/main`, and the single post-ship
evidence commit from step 5.
