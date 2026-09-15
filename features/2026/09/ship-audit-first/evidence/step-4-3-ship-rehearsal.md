# Step 4.3 rehearsal — happy path: `/agento ship widget` with a managed owner worktree

Scratch clone in a temp dir (`<T>`), 2026-09-14: bare `<T>/origin.git`, primary `<T>/widget-repo` on `main` with `.github/agento.json` setting `worktrees.dir` to `../widget-worktrees`, managed worktree `<T>/widget-worktrees/feature-widget` on `feature/widget` (roadmap all ticked, `status: in-review`, `Verdict: approve`, pushed). The GitHub PR merge is simulated by a normal merge commit on `main` plus deletion of the remote branch. Nothing here touches the real Agento worktrees.

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

## 4. status: complete commit in the owner worktree, pushed from there
$ sed -i 's/^status: in-review/status: complete/' '<T>/widget-worktrees/feature-widget/features/2026/09/widget/roadmap.md' && git -C '<T>/widget-worktrees/feature-widget' add -A && git -C '<T>/widget-worktrees/feature-widget' commit -q -m 'chore(widget): status complete' && git -C '<T>/widget-worktrees/feature-widget' push -q && git -C '<T>/widget-worktrees/feature-widget' log --oneline -2
4cc6335 chore(widget): status complete
6500ac8 feat(widget): add widget
[exit 0]

$ git -C <T>/widget-worktrees/feature-widget status --porcelain
[exit 0]

$ git -C <T>/widget-worktrees/feature-widget rev-list --count @{upstream}..HEAD
0
[exit 0]

## 5. Simulated PR merge (normal merge commit) and remote branch deletion
$ git -C '<T>/widget-repo' merge -q --no-ff -m 'Merge pull request #1 from feature/widget' origin/feature/widget && git -C '<T>/widget-repo' push -q origin main && git -C '<T>/widget-repo' push -q origin --delete feature/widget && echo merged
merged
[exit 0]

## 6. Sync main in the primary
$ git -C <T>/widget-repo fetch --prune
[exit 0]

$ git -C <T>/widget-repo status -sb
## main...origin/main
[exit 0]

$ git -C <T>/widget-repo log --oneline -3
5054d7f Merge pull request #1 from feature/widget
392fe76 chore: init
4cc6335 chore(widget): status complete
[exit 0]

## 7. Teardown (owner !== null)
$ git -C <T>/widget-repo worktree remove <T>/widget-worktrees/feature-widget
[exit 0]

$ git -C <T>/widget-repo worktree prune
[exit 0]

$ git -C <T>/widget-repo branch -d feature/widget
Deleted branch feature/widget (was 4cc6335).
[exit 0]

$ git -C <T>/widget-repo worktree list
<T>/widget-repo  5054d7f [main]
[exit 0]

$ git -C <T>/widget-repo branch -a
* main
  remotes/origin/main
[exit 0]

$ node <agento-root>/scripts/agento.mjs --root <T>/widget-repo ship-preflight feature widget
{
  "status": "ok",
  "resolutionSource": "local",
  "branch": "feature/widget",
  "owner": null,
  "message": "Ship preflight can proceed: roadmap resolved via local fallback for feature/widget.",
  "root": "<T>/widget-repo",
  "configSource": "<T>/widget-repo/.github/agento.json"
}
[exit 0]

Result: completed — feature/widget merged (PR #1, simulated), main synced, worktree <T>/widget-worktrees/feature-widget removed and local branch deleted; next: /agento delivery-status
