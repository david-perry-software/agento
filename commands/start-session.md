---
description: "Create or resume an isolated Git worktree and VS Code window for a delivery session — planning (no argument or a session ID) or building (feature/<slug> or issue/<slug>)"
argument-hint: "[<feature|issue>/<slug> | session-id] [--resume] [--no-open]"
---

Needs: terminal, code
Fallback: code → §10 standard fallback (keep the worktree; print the open command)
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Start an isolated delivery session in a sibling worktree: **plan mode** for a blank
argument or a bare session ID (`[a-z0-9][a-z0-9-]{1,63}`), **build mode** for
`feature/<slug>` or `issue/<slug>`; optional flags `--resume` and `--no-open`. This
invocation authorizes fetching, creating the managed worktree (in companion mode, the
product + companion **pair** and its `.code-workspace` file), and opening VS Code. It
does not authorize creating a delivery branch in the product repository, deleting a
branch, or changing delivery artifacts. "Plan mode" and "build mode" are Agento
worktree modes, not VS Code chat modes; this command runs in Agent chat mode because
it needs a terminal.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9, its `next:` command repeated in its own block
directly above the result line per §12.
Window check per §11: requires role `primary` on the default branch, clean.

## One call

Run exactly one command, passing the user's argument and flags through unchanged
(the CLI path is announced in the session context as `Agento CLI:`):

`node <agento-root>/scripts/agento.mjs start-session [<feature|issue>/<slug> | <session-id>] [--resume] [--no-open]`

The CLI performs the whole start deterministically and prints one JSON document:
the §11 window check from the session record (role `primary`, the default branch, a
clean `git status --porcelain`); the capability checks of
`agento.mjs doctor --for start-session` (§10); a bounded `git fetch origin` in the
product clone and, in companion mode, the companion clone; the session ID (generated
`YYYYMMDD-HHMMSS` with `-2`, `-3` suffixes in plan mode) or the roadmap resolution
and branch ownership (build mode); `git worktree add` for each missing half (plan:
detached at `origin/<default>`; build: the exact roadmap branch, the companion half
on the same branch name); the post-add check of both halves; the `.code-workspace`
file (`agento.mjs workspace` semantics: written when missing or stale); and
`code --new-window`. Do not run any of these steps yourself, before or after the
call, and do not rerun the CLI within one submission. A duplicate submission follows
this command's §9 idempotency row: the CLI reuses a registered session untouched and
reports `outcome: "resumed"`.

## Map the JSON to the response

- **Exit 1** (`status: "usage-error"`): §9 rejected receipt quoting `message`; offer
  `/agento start-session` (plan) and `/agento start-session <feature|issue>/<slug>`
  (build) as the alternatives, each in its own §12 block.
- **`status: "rejected"` with `capability`**: §9 capability-rejection receipt built
  from `capability`, `reason`, and `fallback`. Nothing was written.
- **`status: "rejected"`** otherwise (wrong window, primary off the default branch or
  dirty, roadmap `conflict` / `branch-mismatch` / `missing` / complete, branch not
  published): §9 rejected receipt with `reason` verbatim and the alternatives copied
  from `allowed[]` and `elsewhere[]` per §9, each in its own §12 block. Nothing was
  written.
- **`status: "failed"`**: accepted receipt, then the §9 failed result with what
  happened and that re-sending the command after the fix resumes:
  - `fetch-auth`: quote `message`; the user runs `reauth` in their own terminal
    (§1), then re-sends.
  - `post-add-check`: name `half`, `registeredIn`, `origin` against
    `expectedOrigin`, and the exact `fix` (`git -C <clone> worktree remove <path>`)
    for the user to run. Never remove or repair a half yourself; no workspace file
    was written and no window opened.
  - `worktree-add`: quote `message` (the failing `git worktree add` and its stderr).
- **`status: "ok"`**: accepted receipt, one §10 preflight line per `preflight[]`
  entry quoting its `fallback`, then the report:
  1. `outcome` — `created`, or `resumed` (a registered session reused with HEAD,
     branch, and files untouched; a promoted `plan-*` worktree included).
  2. `product.path` with `product.branch` or "detached"; with a pair, also
     `companion.path` and `companion.branch`, and `workspace.path` (and whether it was
     written or refreshed).
  3. Every `warnings[]` entry verbatim (an unreachable origin, a companion branch
     created without an upstream and the push command that publishes it, an open
     failure).
  4. The window: `opened: true` means VS Code was asked to open `target.path`; it may
     reuse or focus an already-open window instead of creating a second one — that is
     success, never a worktree lock or branch conflict. `opened: false` (`--no-open`,
     or the `code` CLI missing or failing) is the §10 `code` fallback: print
     `openCommand` for the user to run.
  5. The new worktree may need its dependencies installed per the project's
     AGENTS.md; this command never installs them.
  6. Each `next` command for the new window in its own §12 block: plan mode
     `/agento new-feature <description>` and `/agento new-issue <description>`; build
     mode `/agento build-<type> <slug>`, followed by `/agento ap <slug>` as the
     unattended alternative (§12).

There is no step-by-step fallback: if the CLI cannot run or prints no JSON, end with
the §9 failed result quoting its stderr; re-sending the command resumes from git
state. Do not run a planner or builder in this primary window, and do not infer the
delivery slug from a session ID.
