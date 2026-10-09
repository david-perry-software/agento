---
description: "Close a clean isolated worktree — a detached planning session (session ID), a fully pushed build session (feature/<slug> or issue/<slug>), or a freehand session (changes/<slug>), with mode detected from worktree state"
argument-hint: "<feature|issue>/<slug> | changes/<slug> | <session-id> [--dry-run] [--ignore-occupants]"
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Close the isolated session named by the argument. Run this command from the
primary worktree of this repository after closing the session's VS Code window. This
invocation authorizes removing the managed worktree (in companion mode, both halves
of the pair and its `.code-workspace` file) and, when already merged, deleting its
local branch in each repository. It does not authorize discarding changes or deleting
an unmerged branch. `/agento ship` performs the build close itself once the PR is merged, so this
command is the normal close only for plan and freehand sessions and for build
sessions you abandon or supersede; closing a finished build before shipping stays
valid (ship then takes its no-owner path).

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12; a duplicate submission follows this
command's §9 idempotency row. Window check per §11: requires role `primary`.

## One call

Run exactly one command, passing the user's argument through unchanged and adding
`--dry-run` or `--ignore-occupants` only when the user asked for them (the CLI path is
announced in the session context as `Agento CLI:`):

`node <agento-root>/scripts/agento.mjs close-session <feature|issue>/<slug> | changes/<slug> | <session-id> [--dry-run] [--ignore-occupants]`

The CLI performs the whole close deterministically and prints one JSON document:
the §11 window check from the session record (role `primary`); a bounded
`git fetch --prune origin` in the product clone and, in companion mode, the companion
clone; the dispatch (`feature/<slug>` or `issue/<slug>` → build close through the
same decision `close-decision` reports; `changes/<slug>` → freehand close; a bare
session ID → plan close, or the build close of the branch a promoted `plan-<id>`
worktree now carries); the managed paths of both halves and the workspace file; the
clean, pushed, and branch checks of every registered half; its own occupant check
(processes whose working directory is inside a half, and VS Code windows that have
it open — the same check and wording as the delivery guard, which cannot see a
removal made inside the CLI); the removal in order — companion half, prune, product
half, prune, workspace file — never forced; and the local-branch rule in each
repository (deleted only when gone from origin, merged into that repository's
`origin/<default>`, checked out nowhere else, and accepted by git's non-forced
delete). Do not run any of these steps yourself, before or after the call, and do not
rerun the CLI within one submission. Never kill processes or close windows. A
duplicate submission is safe: halves already removed are reported
`registered: false` and skipped, and merged local branches left behind are still
deleted.

## Map the JSON to the response

- **Exit 1** (`status: "usage-error"`): §9 rejected receipt quoting `message`; offer
  `/agento close-session <session-id>`, `/agento close-session changes/<slug>`, and
  `/agento close-session <feature|issue>/<slug>` as the alternatives, each in its own
  §12 block.
- **`status: "rejected"`**: §9 rejected receipt with `reason` verbatim (and
  `message` when set) and the alternatives copied from `allowed[]` and `elsewhere[]`
  per §9, each in its own §12 block. Nothing was removed. Add per `reason`:
  - `dirty`: list `dirty.product` and `dirty.companion`; the user commits, pushes,
    or discards them.
  - `unpushed`: list `commits.product` and `commits.companion`; when `next` holds
    `/agento finish-freehand`, emit it in its own block, preceded by one line saying
    it runs in the freehand session's window.
  - `primary-owns-branch`: the primary is on the delivery branch; quote `fix` (the
    default-branch switch) for the user.
  - `companion-unpushed`, `multiple-roadmaps`, `branch-mismatch`,
    `no-resolvable-roadmap`, `unregistered`, `protected-path`: quote `message`.
- **`status: "blocked"`** (`reason: "occupied"`): accepted receipt; list every
  `occupants.product` and `occupants.companion` entry verbatim under its half's path;
  ask the user to close the listed terminals or processes and the session's VS Code
  window. Emit the re-send command `/agento close-session <argument>` in its own §12
  block, followed — after one line naming it as the explicit override for occupants
  the user has decided to leave — by `/agento close-session <argument> --ignore-occupants`
  in its own block. Nothing was removed; the result is `completed` with state
  `blocked`.
- **`status: "failed"`**: accepted receipt and the §9 failed result with what
  happened and that re-sending the command resumes:
  - `fetch-auth`: quote `message`; the user runs `reauth` in their own terminal
    (§1) and re-sends.
  - `worktree-remove` or `branch-delete`: quote `message` (the failing git call and
    its stderr) and name `half`; report each half with `removed: true` as already
    removed.
- **`status: "ok"`**: accepted receipt and the report:
  1. `applied: false` (`--dry-run`): say first that this is a preview and nothing
     was changed; every field below is what a real run would do.
  2. `outcome` — `closed`, `already-closed` (no worktree owned the branch), or
     `nothing-to-close` (no such session is open).
  3. `product.path` and, with a pair, `companion.path`, each as removed
     (`removed: true`) or already gone (`registered: false`); `workspace.path` and
     whether it was removed.
  4. `branches.product` and `branches.companion`: the branch `name` with `action`
     (`deleted`, `retained`, `absent`) and its `reason` verbatim.
  5. Every `warnings[]` entry verbatim (an unreachable origin, occupants ignored
     with `--ignore-occupants`).
  6. Each `next` command in its own §12 block, preceded by one line saying it runs
     from this primary window: `/agento ship <slug>` when the delivery is not
     complete, or `/agento start-freehand <slug> --resume` when freehand work still
     needs publishing. An empty `next` means no further cleanup.

There is no step-by-step fallback: if the CLI cannot run or prints no JSON, end with
the §9 failed result quoting its stderr; re-sending the command resumes from git
state.
