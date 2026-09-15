# Step 4.3 rehearsal — pause path: teardown blocked by an occupant of the worktree

Same scratch fixture (fresh temp dir). The audit, status commit, simulated merge, and `main` sync succeed exactly as in the happy path; then a shell holds the worktree as its cwd (standing in for the still-open secondary VS Code window) when ship reaches `git worktree remove`. The delivery guard (`scripts/hooks/delivery-guard.sh`, replayed through `scripts/hooks/replay-guard.sh` with `REPLAY_CWD` set to the scratch primary) answers `ask`; ship does not answer it and pauses.

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
a470380 chore(widget): status complete
4475751 feat(widget): add widget
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
e0d05e8 Merge pull request #1 from feature/widget
a956722 chore: init
a470380 chore(widget): status complete
[exit 0]

## 7. Teardown attempt with an occupant
A shell process (`sleep`, PID redacted) now has cwd `<T>/widget-worktrees/feature-widget`.
$ printf 'ask git worktree remove %s\n' '<T>/widget-worktrees/feature-widget' | REPLAY_CWD='<T>/widget-repo' '<agento-root>/scripts/hooks/replay-guard.sh'
git worktree remove <T>/widget-worktrees/feature-widget -> ask
[exit 0]

Full guard decision for the same command:
$ python3 -c 'import json,sys;print(json.dumps({"tool_name":"run_in_terminal","tool_input":{"command":sys.argv[1]},"cwd":sys.argv[2]}))' 'git worktree remove <T>/widget-worktrees/feature-widget' '<T>/widget-repo' | '<agento-root>/scripts/hooks/delivery-guard.sh' | sed -E 's/PID [0-9]+/PID <n>/g'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "Active worktree occupants detected - PID <n> (sleep). Close their terminals or VS Code window before removal. Proceed anyway?"}}
[exit 0]

Ship does not answer the ask. The worktree stays registered and `main` is already merged and synced:
$ git -C <T>/widget-repo worktree list
<T>/widget-repo                      e0d05e8 [main]
<T>/widget-worktrees/feature-widget  a470380 [feature/widget]
[exit 0]

$ git -C <T>/widget-repo status -sb
## main...origin/main
[exit 0]

$ node <agento-root>/scripts/agento.mjs --root <T>/widget-repo ship-preflight feature widget
{
  "status": "ok",
  "resolutionSource": "local",
  "branch": "feature/widget",
  "owner": {
    "path": "<T>/widget-worktrees/feature-widget",
    "role": "build",
    "dirPrefix": "feature",
    "id": "widget"
  },
  "message": "Ship preflight can proceed: roadmap resolved via local fallback for feature/widget.",
  "root": "<T>/widget-repo",
  "configSource": "<T>/widget-repo/.github/agento.json"
}
[exit 0]

Result: completed — paused at teardown (worktree <T>/widget-worktrees/feature-widget still open); next: close that VS Code window, then /agento ship widget
