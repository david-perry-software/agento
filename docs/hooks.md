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

**What it is:** a slip guard for an LLM operator. It pattern-matches the shell text
and file paths of tool calls and catches the mistakes agents actually make. **What it
is not:** an enforcement boundary — a determined command can be spelled so that no
regex recognises it. The enforcement layer is a GitHub ruleset on the default branch
(require a pull request, require the CI check, block force pushes, block deletions);
`/agento-init` checks for one and offers to create it. Keep both.

Returns `allow` (silent), `ask` (user confirmation with a reason), or `deny` (with a
reason). Commands are evaluated one shell segment at a time (`&&`, `;`, `|`, `&`),
tracking branch switches earlier in the same line.

| Rule | Decision |
|---|---|
| Commit, push, or non-fast-forward merge while on the configured default branch — including after a `git switch`/`checkout` earlier in the chain — or a push whose refspec targets it | deny |
| `git push --force` / `--force-with-lease` / `--force-if-includes` / `-f` / `+refspec` | deny |
| `git push --delete <default>` / `:<default>` | deny |
| `git commit --no-verify` / `-n`, `git push --no-verify` | deny |
| `gh pr merge --admin` | deny |
| `gh pr merge --squash` / `--rebase` | ask |
| `git commit --amend`, `git rebase`, `git reset --hard`, `git branch -D` | ask |
| Open-ended watchers (`gh pr checks --watch`, `gh run watch`, `vercel --wait`), including behind `nohup`, `setsid`, `timeout`, `&` | deny — use `scripts/wait-for-checks.sh` |
| Any shell command whose word is not a known read-only command and that names `.github/hooks/` or `scripts/hooks/` (rm, mv, cp/install *into* it, truncate, tee, `perl -pi`, `sed -i`, `git checkout -- <hook>`, redirections) | deny — use an edit tool |
| `chmod` / `chown` / `touch` on a hook file | ask |
| Editing a hook file with an edit tool | ask — per-change approval |
| Committing on a `feature/`/`issue/` branch without `roadmap.md` among the files that commit would record (index, `-a` modifications, or explicit pathspecs) | ask — progress may be lost on resume |
| `git worktree remove` with live occupants (processes or an open VS Code folder; Linux only) | ask |
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
