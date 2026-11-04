## 12. Command presentation

VS Code chat puts a one-click copy button on a fenced code block and on nothing else,
so every `/agento …` command the response asks the user to run — now, next, or in
another window — is emitted in its own **copyable command block**: a fenced block
with no language tag whose only content is exactly that one command, arguments
substituted, with no comment, prompt character, or surrounding text. One block holds
one command; a block with a language tag would make the editor offer to run a chat
command in a terminal, and a block with two commands or a trailing `#` comment copies
an unusable paste.

**Where it applies.**

- The `next:` command of the §9 result line, repeated in a block directly above the
  result line. The result line itself is unchanged and stays the single last line.
- Each command of the §8 cross-window handoff, as a numbered list with one block per
  item and the window named in the item's prose.
- The resume command named by a pause (Builder pause protocol, manual step awaiting
  the user, `/agento ship`'s teardown pause).
- Every alternative a `rejected` receipt offers (`allowed:` and the `elsewhere`
  entries): the receipt stays a single first line and the blocks follow it.
- The command `/agento continue` names for another window; the exact commands
  `/agento next-feature` reports; `/agento ship`'s reject-back handoff to the build
  window; the Build-in-this-worktree offer's `/agento build-<type> <slug>`
  alternative.

**Unattended alternative.** Whenever one of those blocks holds
`/agento build-<type> <slug>` or `/agento review-<type> <slug>` — the §8 handoff,
the Builder fix handoff, the Builder pause resume command, the ship reject-back
handoff, the Build-in-this-worktree offer, the next-feature report, and
`/agento continue` when it names one of those — the response also offers
`/agento ap <slug>` in its own block directly after it, preceded by one line naming
it as the unattended alternative (for example "Or unattended, in this window:").
The ap block follows build and review commands only — never `/agento ship`,
`/agento start-session`, or any other command — and the §9 result line's `next:`
stays the build or review command.

**Where it does not apply.** Descriptive mentions — what a command does, what an agent
never runs, the redirect sentence, table rows, headers — stay inline in backticks.
Repository prose (README, docs, templates, AGENTS.md) is out of scope and keeps inline
code. Shell commands the *agent* runs itself (§1) are its own work, never presented
to the user as blocks.

**Ordering.** Several blocks appear in execution order, each preceded by exactly one
line saying where or when to run it (for example "In this window:" or "From the
primary window, after approval:").
