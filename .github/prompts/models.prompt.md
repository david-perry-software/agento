---
description: "Pin Agento agents and commands to models from a named profile in ~/.config/agento/model-profiles.json: list, show, apply, clear, or init — rewrites model: lines in the plugin clone"
argument-hint: "[list | show <name> | apply <name> | clear | init]"
agent: "agent"
tools: [read, execute]
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.

Manage model profiles: named sets of `model:` pins for the Agento agents and the
commands that run on the built-in agent, defined once in the user-level
`model-profiles.json` and applied to the plugin clone by the Agento CLI. The CLI is
the only writer: never edit a `model:` line, the profiles file, or a skip-worktree
bit yourself, and never commit pinned files. Format and rules: `docs/model-profiles.md`
in the Agento repository.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row.
Window check per §11: requires role `any` (not window-sensitive: it rewrites the
plugin clone, never the current checkout's delivery state).

1. Read the argument as `<verb> [<name>]`, verb `list` when empty. Any other shape:
   print the argument hint and stop.
2. Run the Agento CLI: `node <agento-root>/scripts/agento.mjs models <verb> [<name>]`
   (the CLI path is announced in the session context as `Agento CLI:`). Its default
   plugin root is the clone that CLI lives in; pass `--plugin-root <dir>` only when
   the user names another clone. A usage error (exit 1): print its `message`
   verbatim and stop.
3. Report from the JSON, quoting values verbatim:
   - `list` — each profile's `name`, `description`, and `errors`; `profilesFile.path`
     and `exists`; `active` (`null` = nothing pinned, a profile name, or `custom` =
     pins that match no profile). When the file does not exist, suggest
     `/agento models init`.
   - `show` — the resolved `targets` (agents first, then prompts; `commands/` mirrors
     carry the same value as their prompt) and any `errors`.
   - `init` — `created` and `profilesFile.path`; tell the user to replace every
     `<…>` placeholder with model names exactly as the chat model picker shows them,
     then run `/agento models apply <name>`.
   - `apply`, `clear` — the number and list of `changed` files, `active`, and the
     `skipWorktree` count; quote `hint` verbatim. Tell the user to run
     *Developer: Reload Window* if the model picker does not reflect the change.
4. Exit 3 is a finding, not an error of this command: `not-found` (quote `known`),
   `invalid` (quote `errors`; the user fixes the profiles file), `dirty` (quote
   `message` and `dirty`; the user commits, stashes, or restores those files in the
   plugin clone — never do it for them), `failed` (quote `message`; re-sending is
   safe).

The result line's `next:` is `/agento models apply <name>` after `init` or a fixable
finding, `/agento doctor` after `apply` or `clear` (its `model-profile` check
confirms the pinned state), and `/agento models` after `list` or `show`; it is
repeated as its own block directly above the result line per policy §12.
