---
description: "Report environment readiness for Agento commands: Node, git remote, gh auth, code CLI, python3, worktrees dir — each with status and fallback; fixes nothing"
argument-hint: "Optional --for <command> to check only that command's needs"
agent: "agent"
tools: [read, execute]
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Report the environment's readiness for Agento commands, read-only. Do not install,
log in, create directories, or change any file, branch, or setting — `doctor`
reports and never repairs (policy §1); the user performs every fix themselves.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row (read-only: a fresh run of the checks).
Window check per §11: requires role `any` (read-only / not window-sensitive).

1. Run the Agento CLI: `node <agento-root>/scripts/agento.mjs doctor` (the CLI path
   is announced in the session context as `Agento CLI:`). If the argument is
   `--for <command>`, pass it through unchanged; a usage error (exit 1) means the
   command name is unknown — print the CLI's message verbatim and stop.
2. Present one line per entry of `checks`, in the CLI's order — the check `id`, its
   `status`, its `detail`, then its `fallback` — quoting `detail` and `fallback`
   verbatim. Then state the overall `status` (`ok`, `warn`, or `fail`)
   and, when `for` is set, the command it was checked for and its `needs` list.
3. For every `warn` or `fail`, the quoted fallback is the whole recommendation.
   Never run the fallback yourself (no `gh auth login`, no installs), never ask the
   user for secrets, and never print them.
4. Exit codes: 0 for `ok`/`warn`, 3 for `fail`. Report the exit code with the
   overall status; a `fail` is not an error of this command — it is the finding.

The result line's `next:` is `/agento doctor` again after the user applies a
fallback, or the command they were about to run when every check is `ok`.
