## 10. Capability preflight

The opening `agento.mjs preflight <command>` call has already run the command's
`doctor --for` checks: on `status: rejected` print the receipt and stop; each
`Preflight:` line names a soft fallback to apply. The capability vocabulary, the
hard/soft classification, the Declaration contract, and when `doctor` runs live in
`docs/architecture.md`.

**Standard fallbacks** (declared once here; `Fallback:` lines cite them, never
restate them):

- `terminal` unavailable → reject: "switch to Agent mode and re-send the command";
  no partial help in Plan or Ask mode.
- `ask-questions` unavailable → ask the same questions as a numbered list in chat,
  end the turn, wait for the reply, and retain the answers verbatim in the artifact;
  each question still carries its recommended choice (below).
- `browser` unavailable → run the step's `verify:` headless (curl, CLI, tests) where
  faithful; otherwise report the step blocked per §2 and pause. Never silently skip.
- `code` unavailable → keep the worktree and print `code --new-window
  <worktree-path>` for the user to run.
- `gh` missing or unauthenticated → reject; the user installs GitHub CLI or runs
  `gh auth login` in their own terminal (§1), then re-sends the command.
- `network` unreachable → `doctor` reports `warn`; fetch/push/PR steps are retried
  before the turn ends and the command pauses if they still fail.

**Recommended choice.** Every clarifying question offers 2–4 concrete options with
exactly one recommended — open-ended questions included — and a free-text answer
stays allowed. With the ask-questions tool, the recommended option is listed first
and carries `recommended: true`. In the numbered-list fallback (the tool is missing,
or the agent runs as a subagent, where VS Code withholds it), options are lettered
and the recommended one is bold and suffixed `(recommended)` with a one-line reason.
Retain the answers verbatim, noting which option was the recommended one.

