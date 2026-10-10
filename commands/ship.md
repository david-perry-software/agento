---
description: "Acceptance gate: audit a feature/issue against roadmap, codebase, and review while its build worktree is still open, reject back to that window on a real gap, merge its PR on a clean audit or explicit confirmation, then tear the build worktree down"
argument-hint: "Slug of the feature or issue to ship"
agent: "agent"
---

Needs: terminal, gh, network
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Ship the work named by the slug in the argument. The whole ship — audit, the
user's confirmation, marking the PR ready, the bounded check wait, the merge through
the repository ruleset, the companion merge in companion mode, the release wait, the
default-branch syncs, the teardown of the build worktree pair and its
`.code-workspace` file, and the post-ship epilogue — is one Agento CLI subcommand,
`agento.mjs ship`, that resumes from git and GitHub state alone. This prompt only
calls it, relays the user's decision, and formats its JSON. This invocation
authorizes every write the CLI performs after the confirmation step below.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this
command's §9 idempotency row — re-sending `/agento ship <slug>` resumes wherever
the CLI's phase derivation says the ship stands, creating nothing a second time.
The CLI runs the `doctor --for ship` checks itself before its first write and
reports them in `preflight[]`. Window check per §11: requires role `primary`.

## Calls

The CLI path is announced in the session context as `Agento CLI:`.

1. `node <agento-root>/scripts/agento.mjs find <slug>` — the delivery `type`
   (`feature` or `issue`). A `conflict`, `branch-mismatch`, or `missing` result is
   reported verbatim with the §9 rejected receipt; stop.
2. `node <agento-root>/scripts/agento.mjs ship <type> <slug>` — the audit call. It
   never writes to any repository (the one exception: an issue PR body missing its
   `Fixes #<n>` line is completed through the GitHub API and reported in
   `actions[]`). It prints one JSON document with `status`, `phase`, `resumedAt`,
   `outcome`, `audit`, `gaps { hard, confirm }`, `confirmToken`, `rejectTo`,
   `actions`, `pr`, `companionPr`, `mergeSha`, `release`, `teardown`, `postShip`,
   `next`, `preflight`, `warnings`, and the §9 fields.
3. **Judgment before confirm** (only when `status: "ok"` and `outcome:
   "awaiting-confirm"`): read `audit.diffFiles`, `audit.roadmap`, and the review
   summary in `audit.review`; spot-check ticked roadmap steps against the code they
   claim and look for undocumented unrelated drift in the diff. A finding is a gap:
   report it with the build-window handoff (`/agento build-<type> <slug>` in its
   own §12 block, then `/agento ap <slug>` as the unattended alternative) and
   withhold the confirmation; nothing is merged.
4. **Ask** — present `gaps.confirm[]` verbatim as one summary: for
   `untracked-byproducts`, every `paths[]` entry with the words "will be deleted";
   `changelog-unstamped`, `pr-behind`, and `companion-pr-behind` with their
   `detail`. Ask the user explicitly whether to proceed; the default is do not
   proceed. With an empty `gaps.confirm[]`, say the audit is clean and still ask
   for the go-ahead to merge. On no, write nothing and end with the §9 completed
   result in state `awaiting-confirm`.
5. On yes: `node <agento-root>/scripts/agento.mjs ship <type> <slug> --confirm <confirmToken>`
   with the token from the audit JSON, unchanged. The CLI recomputes the token; a
   changed gap set is rejected (`confirm-stale`) and nothing is written.
6. On `status: "pending"` (exit 2, a bounded check or release wait ran out of its
   ≤ 60 s budget), re-send the identical command from step 5 — or `… ship <type>
   <slug>` without `--confirm` when `next[0]` carries no token — and repeat while
   it stays pending. Never run `git`, `gh`, a check watcher, or a release poll
   yourself, before, between, or after these calls.

## Map the JSON to the response

- **Exit 1** (`status: "usage-error"`): §9 rejected receipt quoting `message`;
  offer `/agento ship <slug>` in its own §12 block.
- **`status: "rejected"`**: §9 rejected receipt with `reason` verbatim (and
  `message` when set), the alternatives from `allowed[]` and `elsewhere[]` per §9
  each in its own §12 block, and nothing was written. Add per `reason`:
  - `wrong window: …`: the record's alternatives are the whole answer.
  - `audit-gaps`: list every `gaps.hard[]` entry as `code — detail` (with `paths[]`
    verbatim where present). Emit `rejectTo.command` in its own §12 block,
    preceded by one line naming `rejectTo.window`; when it is the build or review
    command, follow it with `/agento ap <slug>` in its own block as the unattended
    alternative.
  - `confirm-stale`: show `providedToken`, the fresh `confirmToken`, and the current
    `gaps.confirm[]`; go back to step 4 with the new list.
  - `integration-conflict`: quote `message` (the merge was aborted and the tree is
    clean again); emit `rejectTo.command` in its own §12 block for the build window
    with `/agento ap <slug>` after it.
  - `owner-tree-changed`, `owner-diverged`, `primary-dirty`, `primary-owns-branch`
    (quote `fix`), `pr-missing`, `pr-closed`, `multiple-roadmaps`, `branch-mismatch`,
    `no-resolvable-roadmap`, and the capability rejection (`capability`, `check`,
    `fallback`): quote `message` or `fallback`.
- **`status: "pending"`** (exit 2): accepted receipt; name `phase` (`checks`,
  `merge-companion`, `release`, or `epilogue`) and quote `message`; emit `next[0]`
  in its own §12 block as the command to re-send, and re-send it yourself while the
  turn allows (step 6). The §9 result is `completed` with state `pending at <phase>`.
- **`status: "blocked"`** (`reason: "occupied"`, `outcome: "paused-teardown"`):
  the merge and syncs are done; a half of the pair is still open. List
  `teardown.occupants.product` and `teardown.occupants.companion` verbatim under
  their paths. Emit `/agento ship <slug>` in its own §12 block, preceded by one line
  saying to close the flagged window first, and end with the §9 completed result
  whose state and next step read exactly
  `paused at teardown (worktree <teardown.pausedPath> still open); next: close that VS Code window, then /agento ship <slug>`.
  Nothing was removed; the re-send resumes at the teardown with halves already
  removed skipped.
- **`status: "failed"`**: accepted receipt and the §9 failed result quoting
  `message`, what the `actions[]` already did, and that re-sending `/agento ship
  <slug>` resumes from git and GitHub state:
  - `fetch-auth`, `push-auth`, `gh-auth`: the user runs `reauth` in their own
    terminal (§1), then re-sends.
  - `checks-failed`: a required check failed before the merge; emit
    `rejectTo.command` in its own §12 block for the build window (with
    `/agento ap <slug>` after it) when set.
  - `companion-merge`: the code PR is merged and the companion PR is not; the
    result line's state and next step are the CLI's `message` verbatim (it names
    both PRs and says the re-send resumes at the companion merge).
  - `release-failed`, `release-no-run`, `release-no-merge-sha`: name the verdict and
    `release.run.url`; never substitute another run or trigger a second release.
  - `worktree-remove`, `branch-delete`, `sync-failed`, `switch-failed`,
    `commit-failed`, `push-failed`, `gh-error`, `clean-failed`,
    `post-ship-checks-failed`: quote `message` and `half` when set.
- **`status: "ok"`**, by `outcome`:
  - `awaiting-confirm` (`phase: "audit"`): steps 3–5 above.
  - `shipped`: the report — the merged code PR `pr.number` (and `companionPr.number`
    in companion mode), `mergeSha`, the `release` verdict with `release.run.url`
    (both URLs for `superseded-success`, the `reason` for `not-triggered` or
    `not-configured`, nothing when `release` is null), the synced defaults, the
    removed `teardown.product.path`, `teardown.companion.path`, and
    `teardown.workspace.path` with each `teardown.branches.*.action`, the
    `gaps.confirm[]` accepted into `## Follow-ups (accepted at ship)`, and every
    `warnings[]` entry verbatim. `next` is empty.
  - `already-shipped`: a re-send after the ship; report the sync-only `actions[]`
    (or that nothing changed) and that the delivery was already merged.
  - `post-ship-pending` (`phase: "epilogue"`): the merge, syncs, and teardown are
    done; `(manual, post-ship)` steps remain. For each `postShip.steps[]` entry
    with `ticked: false` or `evidencePresent: false`, walk the user through the
    manual step protocol of delivery-policy.instructions.md §3 — exact instructions,
    the screenshot saved under `evidence/` in the slug directory at
    `postShip.path` (the artifact checkout on `postShip.branch`), the tick with its
    completion date and evidence link — then re-send `/agento ship <slug>` (its own
    §12 block): the CLI commits the evidence and ticks, opens or reuses the
    post-ship PR, merges it, syncs the default, and deletes the branch. The CLI
    never ticks a post-ship step itself. If the user cannot verify yet, end with the
    §9 completed result in state `post-ship-pending` naming the same re-send.

There is no step-by-step fallback: if the CLI cannot run or prints no JSON, end with
the §9 failed result quoting its stderr; re-sending the command resumes from git and
GitHub state.
