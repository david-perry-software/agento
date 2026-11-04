## 11. Window check

Which window a command runs in is data, not prose: every command and agent carries a
`Window check per §11: requires role <roles>` line, and the roles table lives in the
CLI (`WINDOW_ROLES` and `deriveAllowed` in `scripts/session-state.mjs`).

- `window.match: false` → print the preflight `receipt` and its alternatives as §12
  blocks, write nothing.
- On a match, the record's `worktree`, `companion`, `delivery`, and `lifecycle`
  replace fresh git inspection. Only worktree-mutating commands (`start-session`,
  `start-freehand`, `close-session`, and `ship` teardown) read
  `git worktree list --porcelain`, and they call `preflight --full` (or
  `agento.mjs session`) for `worktrees[]`.
- A requirement with a branch condition — `primary` on a non-default branch
  (`commit-current-changes`); `primary` on the default branch, clean (`quick-fix`,
  `new-initiative`, `start-session`, `start-freehand`); build-window commands whose
  `delivery.slug` must equal the argument — states it on the same line and checks it
  from the record's `worktree.branch` and `delivery`, never from a fresh `git branch`
  reading.

The record field catalogue and the numbered procedure live in `docs/architecture.md`.

