# Hooks

Agento ships two hooks. In plugin mode they are wired by `hooks.json` with
`${PLUGIN_ROOT}` paths; the same scripts are wired workspace-mode in
`.github/hooks/` for developing Agento itself.

## SessionStart — `scripts/hooks/session-context.sh`

Injects `Current git branch: <branch>` plus one line per in-progress / paused /
in-review roadmap (`status:` and `next-step:` from the YAML header) into every new
chat session via `hookSpecificOutput.additionalContext`. It reads the repository
from the hook input's `cwd` and the artifact roots from the target's
`.github/agento.json` — it never assumes the plugin's own directory.

## PreToolUse — `scripts/hooks/delivery-guard.sh`

Returns `allow` (silent), `ask:<reason>` (user confirmation), or `deny:<reason>`:

| Rule | Decision |
|---|---|
| Commit or push while on the configured default branch, or push targeting it | deny |
| `git push --force` / `--force-with-lease` / `-f` | deny |
| Open-ended watchers (`gh pr checks --watch`, `gh run watch`, `vercel --wait`) | deny — use `scripts/wait-for-checks.sh` |
| Destructive shell change (`rm`, `mv`, `>`, `tee`, `sed -i`) targeting `.github/hooks/` or `scripts/hooks/` | deny — use an edit tool |
| Editing a hook file with an edit tool | ask — per-change approval |
| Committing on a `feature/`/`issue/` branch without a staged `roadmap.md` | ask — progress may be lost on resume |
| `git worktree remove` with live occupants (processes or an open VS Code folder) | ask |
| Everything else | allow |

Branch names, the default branch, and artifact roots come from the target repo's
`.github/agento.json`; the guard walks to the repo root (`git rev-parse
--show-toplevel`) before reading it, so it behaves identically in primary and
secondary worktrees.

## Testing hook behavior

- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` — each fixture line is
  `<expected-verdict> <command>`; the harness replays every command against a
  throwaway repo on a feature branch and exits 1 on any mismatch (CI runs this).
  Lines without a verdict prefix are printed without being asserted, so you can
  also pipe in an ad-hoc file of commands to see what the guard would decide.
- `tests/guard.test.mjs` — the assertion suite (spins up real temp git repos).
- `tests/session-context.test.mjs` — SessionStart output against temp repos.
- `tests/customizations.test.mjs` — frontmatter validity and cross-reference
  integrity for every agent, prompt, instruction, and hook wiring file.
- VS Code: Output panel → **GitHub Copilot Chat Hooks**, or *Developer: Show Agent
  Debug Logs*.

## Safety note

Hooks run shell commands with your user's permissions. The guard protects its own
files (`ask` on edits, `deny` on destructive shell), but review any fork's hook
changes before enabling them — same as you would a CI script.
