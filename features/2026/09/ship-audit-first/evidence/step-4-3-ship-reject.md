# Step 4.3 rehearsal — reject path: dirty owner, then a conflicting integration merge

Same scratch fixture as the happy path (fresh temp dir). Two hard-reject gaps are exercised in turn; in both, nothing is written to the branch — the only mutation is `merge --abort`, which restores the owner worktree to a clean state.

## A. Dirty owner worktree

### Resolve and read ownership
$ node <agento-root>/scripts/agento.mjs --root <T>/widget-repo ship-preflight feature widget
{
  "status": "ok",
  "resolutionSource": "remote",
  "branch": "feature/widget",
  "owner": {
    "path": "<T>/widget-worktrees/feature-widget",
    "role": "build",
    "dirPrefix": "feature",
    "id": "widget"
  },
  "message": "Ship preflight can proceed: roadmap resolved via remote fallback for feature/widget.",
  "root": "<T>/widget-repo",
  "configSource": "<T>/widget-repo/.github/agento.json"
}
[exit 0]

### Make the owner dirty (an unsaved edit in the still-open build window)
$ printf 'scratch\n' >> '<T>/widget-worktrees/feature-widget/README.md'
[exit 0]

$ git -C <T>/widget-worktrees/feature-widget status --porcelain
 M README.md
[exit 0]

$ git -C <T>/widget-worktrees/feature-widget rev-list --count @{upstream}..HEAD
0
[exit 0]

`status --porcelain` is non-empty → hard-reject gap "owner worktree dirty". No write happens:
$ git -C <T>/widget-worktrees/feature-widget rev-parse HEAD
6500ac834b0620dcb26fcf28db55440456480fed
[exit 0]

$ git -C <T>/widget-repo rev-parse origin/feature/widget
6500ac834b0620dcb26fcf28db55440456480fed
[exit 0]

(HEAD `6500ac8` and `origin/feature/widget` `6500ac8` are unchanged; the roadmap on the branch still reads `status: in-review`.)
$ git -C <T>/widget-repo show origin/feature/widget:features/2026/09/widget/roadmap.md
```yaml
status: in-review
branch: feature/widget
last-updated: 2026-09-14
next-step: "ship"
```

## Phase 1

- [x] 1.1 Add the widget — verify: `test -f widget.txt`
[exit 0]

Result: failed — owner worktree <T>/widget-worktrees/feature-widget is dirty (README.md modified); nothing written; next: /agento build-feature widget

## B. Conflicting integration merge (PR BEHIND, then CONFLICTING)

The user commits the edit in the build window so the owner is clean again, and `main` advances with a conflicting change to `notes.md`.
$ git -C '<T>/widget-worktrees/feature-widget' checkout -q -- README.md && printf 'v2 on main\n' > '<T>/widget-repo/notes.md' && git -C '<T>/widget-repo' commit -q -am 'docs: notes v2' && git -C '<T>/widget-repo' push -q origin main && git -C '<T>/widget-repo' log --oneline -1
82e78ed docs: notes v2
[exit 0]

## 1. Resolve and read ownership
$ node <agento-root>/scripts/agento.mjs --root <T>/widget-repo find widget
{
  "type": "feature",
  "status": "ok",
  "source": "remote",
  "path": "features/2026/09/widget/roadmap.md",
  "branch": "feature/widget",
  "message": "Resolved feature/widget from origin/feature/widget; no local roadmap was present in the current checkout.",
  "root": "<T>/widget-repo",
  "configSource": "<T>/widget-repo/.github/agento.json"
}
[exit 0]

$ node <agento-root>/scripts/agento.mjs --root <T>/widget-repo ship-preflight feature widget
{
  "status": "ok",
  "resolutionSource": "remote",
  "branch": "feature/widget",
  "owner": {
    "path": "<T>/widget-worktrees/feature-widget",
    "role": "build",
    "dirPrefix": "feature",
    "id": "widget"
  },
  "message": "Ship preflight can proceed: roadmap resolved via remote fallback for feature/widget.",
  "root": "<T>/widget-repo",
  "configSource": "<T>/widget-repo/.github/agento.json"
}
[exit 0]

## 2. Audit read-only from the primary against origin/feature/widget
$ git -C <T>/widget-repo fetch origin
[exit 0]

$ git -C <T>/widget-repo show origin/feature/widget:features/2026/09/widget/roadmap.md
```yaml
status: in-review
branch: feature/widget
last-updated: 2026-09-14
next-step: "ship"
```

## Phase 1

- [x] 1.1 Add the widget — verify: `test -f widget.txt`
[exit 0]

$ git -C <T>/widget-repo show origin/feature/widget:features/2026/09/widget/review.md
# Review: widget

Verdict: approve
[exit 0]

$ git -C <T>/widget-repo diff --stat origin/main...origin/feature/widget
 features/2026/09/widget/plan.md    |  5 +++++
 features/2026/09/widget/review.md  |  3 +++
 features/2026/09/widget/roadmap.md | 10 ++++++++++
 notes.md                           |  2 +-
 widget.txt                         |  1 +
 5 files changed, 20 insertions(+), 1 deletion(-)
[exit 0]

## 3. Owner worktree must be clean and zero-ahead
$ git -C <T>/widget-worktrees/feature-widget status --porcelain
[exit 0]

$ git -C <T>/widget-worktrees/feature-widget rev-list --count @{upstream}..HEAD
0
[exit 0]

`origin/main` is not an ancestor of `origin/feature/widget` (the PR would report `BEHIND`), so ship integrates in the owner worktree:
$ git -C <T>/widget-repo merge-base --is-ancestor origin/main origin/feature/widget
[exit 1]

$ git -C <T>/widget-worktrees/feature-widget merge origin/main
Auto-merging notes.md
CONFLICT (content): Merge conflict in notes.md
Automatic merge failed; fix conflicts and then commit the result.
[exit 1]

## Conflict → abort in the owner, confirm it is clean again, reject
$ git -C <T>/widget-worktrees/feature-widget merge --abort
[exit 0]

$ git -C <T>/widget-worktrees/feature-widget status --porcelain
[exit 0]

$ git -C <T>/widget-worktrees/feature-widget rev-list --count @{upstream}..HEAD
0
[exit 0]

$ git -C <T>/widget-worktrees/feature-widget log --oneline -1
6500ac8 feat(widget): add widget
[exit 0]

$ git -C <T>/widget-repo show origin/feature/widget:features/2026/09/widget/roadmap.md
```yaml
status: in-review
branch: feature/widget
last-updated: 2026-09-14
next-step: "ship"
```

## Phase 1

- [x] 1.1 Add the widget — verify: `test -f widget.txt`
[exit 0]

Result: failed — integrating origin/main into feature/widget conflicts in notes.md (PR CONFLICTING); merge aborted, owner worktree <T>/widget-worktrees/feature-widget clean; next: /agento build-feature widget
