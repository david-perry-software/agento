# Hooks

Agento ships two hooks. In plugin mode they are wired by `hooks/hooks.json` (the
Claude-format layout next to `.claude-plugin/plugin.json`) with `${CLAUDE_PLUGIN_ROOT}`
paths; the same scripts are wired workspace-mode in `.github/hooks/` for developing
Agento itself.

## SessionStart — `scripts/hooks/session-context.sh`

Injects `Current git branch: <branch>`, the `Agento CLI:` path, one
`Session: role=… worktree=… branch=… delivery=… lifecycle=… allowed=[…] elsewhere=[…]`
line (the output of `agento.mjs session` without `--pr`; the record's `hosted` flag
and `worktrees[]` are JSON-only and do not appear on the line), plus one line per
in-progress / paused / in-review roadmap (`status:` and `next-step:` from the YAML
header) into every new chat session via `hookSpecificOutput.additionalContext`. It
reads the repository from the hook input's `cwd` and the artifact roots from the
target's `.github/agento.json` — it never assumes the plugin's own directory. The
`Session:` line needs `node` on `PATH`; when it is missing, or the CLI fails or
exceeds its 5 s timeout, the line is omitted and the rest of the output is unchanged.

When the config sets `artifacts.repo`, the roadmaps are walked in the sibling
companion checkout instead (resolved against the primary checkout, like
`worktrees.dir`, so managed worktrees agree with the CLI) and the product's own
`features/` and `issues/` are ignored. One extra line,
`Artifacts: <absolute companion path> (branch <name|detached>)`, follows the
`Session:` line (or `Agento CLI:` when there is none); it is produced without `node`,
so the no-node fallback still equals the full output minus `Session:`. A missing
companion directory yields the same line with `detached` and the usual "No
in-progress delivery work" line — `agento.mjs doctor` is where the companion is
validated. From a managed product worktree `<kind>-<id>` whose companion half
`<companion>-worktrees/<kind>-<id>` exists, the `Artifacts:` line names that half and
its branch, and the roadmaps are walked there; the primary and an unpaired worktree
still name the clone. With `artifacts.repo` unset the output is byte-identical to before.

## PreToolUse — `scripts/hooks/delivery-guard.sh`

**What it is:** a slip guard for an LLM operator. It pattern-matches the shell text
and file paths of tool calls and catches the mistakes agents actually make. **What it
is not:** an enforcement boundary — a determined command can be spelled so that no
regex recognises it. The enforcement layer is a GitHub ruleset on the default branch
(require a pull request, require the CI check, block force pushes, block deletions);
`/agento agento-init` checks for one and offers to create it. Keep both.

Returns `allow` (silent), `ask` (user confirmation with a reason), or `deny` (with a
reason). Commands are evaluated one shell segment at a time (`&&`, `;`, `|`, `&`),
tracking branch switches earlier in the same line.

Inside a managed session window, these `ask` cases should be the only approval
prompts you normally see once the session `.code-workspace` settings are current.

| Rule | Decision |
|---|---|
| Commit, push, or non-fast-forward merge while on the configured default branch — including after a `git switch`/`checkout` earlier in the chain — or a push whose refspec targets it | deny |
| `git push --force` / `--force-with-lease` / `--force-if-includes` / `-f` / `+refspec` | deny |
| `git push --delete <default>` / `:<default>` — deleting any **non-default** remote branch (`--delete <ref>` / `:<ref>`) is allowed even while the checkout is on the default branch (#47) | deny |
| `git commit --no-verify` / `-n`, `git push --no-verify` | deny |
| `gh pr merge --admin` | deny |
| `gh pr merge --squash` / `--rebase` | ask |
| `git commit --amend`, `git rebase`, `git reset --hard`, `git branch -D` | ask |
| Open-ended watchers (`gh pr checks --watch`, `gh run watch`, `vercel --wait`), including behind `nohup`, `setsid`, `timeout`, `&` | deny — use `scripts/wait-for-checks.sh` |
| Any shell command whose word is not a known read-only command and that names `.github/hooks/` or `scripts/hooks/` (rm, mv, cp/install *into* it, truncate, tee, `perl -pi`, `sed -i`, `git checkout -- <hook>`, redirections) | deny — use an edit tool |
| `chmod` / `chown` / `touch` on a hook file | ask |
| Editing a hook file with an edit tool | ask — per-change approval |
| Committing on a `feature/`/`issue/` branch without `roadmap.md` among the files that commit would record (index, `-a` modifications, or explicit pathspecs) | ask — progress may be lost on resume |
| Companion mode (`artifacts.repo` set): the same commit in the product checkout while the companion checkout has neither a staged `roadmap.md` nor a `roadmap.md` in its `HEAD` commit — the reason names the companion path and its current branch; the product commit's own files are never what decides | ask — progress may be lost on resume |
| Companion mode: commit, push, or merge targeting the companion checkout (`git -C <companion> …`, `cd <companion> && …`) on the **product** config's default branch, or a push whose refspec targets it | deny — the product config governs the companion |
| `git worktree remove` with live occupants (processes or an open VS Code folder; Linux only) | ask |
| `git [-C <companion clone>] worktree remove <half>` while the pair's `<kind>-<id>.code-workspace` window is open — `code --status` shows `Window (… <kind>-<id> (Workspace) …)` (observed) or `Workspace (<kind>-<id>)`; both halves share the name, so either removal asks | ask |
| Everything else | allow |

Branch names, the default branch, and artifact roots come from the target repo's
`.github/agento.json`; the guard walks to the repo root (`git rev-parse
--show-toplevel`) before reading it, so it behaves identically in primary and
secondary worktrees. When that config sets `artifacts.repo`, the guard also resolves
the companion checkout (from the hook `cwd`'s repository, against its primary
checkout) and applies the product's `branches.*` to commands that target it — a
companion carries no `agento.json` of its own. A commit run directly in the companion
on a delivery branch keeps the ordinary roadmap rule (roadmap among the recorded
files).

## Testing hook behavior

- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` — each fixture line is
  `<expected-verdict> <command>`; the harness replays every command against a
  throwaway repo on a feature branch and exits 1 on any mismatch (CI runs this).
  Lines without a verdict prefix are printed without being asserted, so you can
  also pipe in an ad-hoc file of commands to see what the guard would decide.
- `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh < tests/guard-fixtures-companion.txt`
  — the same harness with a sibling companion repo beside the throwaway product repo
  (product config: `artifacts.repo.dir` → the companion, `branches.default: trunk`);
  the literal `{companion}` in each fixture command is replaced with the companion's
  absolute path.
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
