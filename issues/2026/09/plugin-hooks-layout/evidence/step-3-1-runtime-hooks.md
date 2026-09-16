# Step 3.1 evidence — plugin-mode hooks run with `${CLAUDE_PLUGIN_ROOT}` expanded (#36)

- **Source log**: `~/.config/Code/logs/20260910T224623/window22/exthost/GitHub.copilot-chat/GitHub Copilot Chat Hooks.log` (9 lines; last modified 2026-09-15 22:01:14 UTC)
- **VS Code**: `code --version` → `1.132.0 df53daabb18cd157bdb08c7f01c34df936cf12f4 x64`
- **Timestamp**: 2026-09-15 18:01:09–18:01:14 local (22:01 UTC); user reported "done 6:01 est"
- **Window**: `/home/david/DP/prismicon` (non-Agento repository with `.github/agento.json`, no workspace `.github/hooks/`), new Agent-mode chat, agent asked to run `git status`
- **Settings state at capture** (user `settings.json`, verified with `grep` right before writing this file): `chat.plugins.enabled: true`; `chat.pluginLocations` = `"/home/david/DP/agento": false`, `"/home/david/DP/agento-worktrees/plan-20260915-192647": true` (plugin registered from this worktree at branch `issue/plugin-hooks-layout`, head `3767c70`; backup `~/.config/Code/User/settings.json.agento-3-1.bak`)

## Log excerpt

Transcript paths and the `Input:` lines are omitted except where a verify check depends on them.

```
2026-09-15 18:01:09.763 [info] [#0] [SessionStart] Executing 1 hook(s)
2026-09-15 18:01:09.763 [info] [#0] [SessionStart] Running: {"command":"/home/david/DP/agento-worktrees/plan-20260915-192647/scripts/hooks/session-context.sh","cwd":{"fsPath":"/home/david/DP/prismicon",…},"env":{"CLAUDE_PLUGIN_ROOT":"/home/david/DP/agento-worktrees/plan-20260915-192647"},"timeout":10}
2026-09-15 18:01:09.763 [info] [#0] [SessionStart] Input: {"hook_event_name":"SessionStart","session_id":"9ce506e5-4a26-4495-85e6-5789dfeaef6e","source":"new","cwd":"/home/david/DP/prismicon",…}
2026-09-15 18:01:09.937 [info] [#0] [SessionStart] Completed (Success) in 214ms
2026-09-15 18:01:09.937 [info] [#0] [SessionStart] Output: {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Current git branch: main\nAgento CLI: node /home/david/DP/agento-worktrees/plan-20260915-192647/scripts/agento.mjs\nSession: role=primary worktree=/home/david/DP/prismicon branch=main delivery=none lifecycle=no-delivery allowed=[/agento continue; /agento start-session; /agento new-feature; /agento new-issue; /agento new-initiative; /agento delivery-status] elsewhere=[]\nNo in-progress delivery work in features/ or issues/."}}
2026-09-15 18:01:13.947 [info] [#1] [PreToolUse] Executing 1 hook(s)
2026-09-15 18:01:13.948 [info] [#1] [PreToolUse] Running: {"command":"/home/david/DP/agento-worktrees/plan-20260915-192647/scripts/hooks/delivery-guard.sh","cwd":{"fsPath":"/home/david/DP/prismicon",…},"env":{"CLAUDE_PLUGIN_ROOT":"/home/david/DP/agento-worktrees/plan-20260915-192647"},"timeout":15}
2026-09-15 18:01:13.948 [info] [#1] [PreToolUse] Input: {"hook_event_name":"PreToolUse","session_id":"9ce506e5-4a26-4495-85e6-5789dfeaef6e","tool_name":"run_in_terminal","tool_input":"...","cwd":"/home/david/DP/prismicon",…}
2026-09-15 18:01:14.086 [info] [#1] [PreToolUse] Completed (Success) in 159ms, no output
```

## Verify checks

| # | Condition | Result | Evidence |
| --- | --- | --- | --- |
| 1 | SessionStart `Running:` command is the absolute path `/home/david/DP/agento-worktrees/plan-20260915-192647/scripts/hooks/session-context.sh` (no `${CLAUDE_PLUGIN_ROOT}` literal) | **pass** | line 2: `"command":"/home/david/DP/agento-worktrees/plan-20260915-192647/scripts/hooks/session-context.sh"` |
| 2 | PreToolUse `Running:` command is the absolute path `…/scripts/hooks/delivery-guard.sh` (no `${CLAUDE_PLUGIN_ROOT}` literal) | **pass** | line 7: `"command":"/home/david/DP/agento-worktrees/plan-20260915-192647/scripts/hooks/delivery-guard.sh"` |
| 3 | Each hook `Completed (Success)` | **pass** | line 4: `[SessionStart] Completed (Success) in 214ms`; line 9: `[PreToolUse] Completed (Success) in 159ms, no output` |
| 4 | `grep -c 'not found'` on the log is 0 | **pass** | `grep -c 'not found' "<log>"` → `0` |
| 5 | Exactly one plugin `Executing 1 hook(s)` per SessionStart and per tool call | **pass** | line 1: `[#0] [SessionStart] Executing 1 hook(s)`; line 6: `[#1] [PreToolUse] Executing 1 hook(s)` — one each, no other `Executing` lines in the 9-line log |
| 6 | SessionStart output contains `Agento CLI: node /home/david/DP/agento-worktrees/plan-20260915-192647/scripts/agento.mjs` | **pass** | line 5 `additionalContext` contains `Agento CLI: node /home/david/DP/agento-worktrees/plan-20260915-192647/scripts/agento.mjs` |

Additional observation: VS Code also exported `CLAUDE_PLUGIN_ROOT` in the hook `env` (`"env":{"CLAUDE_PLUGIN_ROOT":"/home/david/DP/agento-worktrees/plan-20260915-192647"}`), which format 0 (root `plugin.json` + root `hooks.json`) did not do — the root cause recorded in plan.md `## Research`.

The SessionStart `additionalContext` also lists `/agento delivery-status` in `allowed=[…]`, confirming the plugin's Agento context reached the non-Agento repository's chat.
