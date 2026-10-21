---
description: "Manage model profiles in ~/.config/agento/model-profiles.json: create, update, rename, delete, alias set, alias remove, list, show, apply, adopt, clear, init — writes are validated, atomic, and support an optional --expect hash"
argument-hint: "[list | show <name> | apply <name> | adopt | clear | init | create <name> [--from <src>] [--description <text>] | update <name> [--dry-run] | rename <old> <new> | delete <name> [--force] | alias set <picker> <id> | alias remove <picker>]"
agent: "agent"
tools: [read, execute]
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.
Policy: read `<agento-root>/.github/instructions/delivery-policy.instructions.md` once before the first step unless it is already in context; `<agento-root>` comes from the session context line `Agento CLI: node <agento-root>/scripts/agento.mjs`.

Manage model profiles: named sets of `model:` pins for the Agento agents and the
commands that run on the built-in agent, defined once in the user-level
`model-profiles.json` and applied to the plugin clone by the Agento CLI. The CLI is
the only writer: never edit a `model:` line, the profiles file, the filter's config,
attributes, or pin state, or a skip-worktree bit yourself. Commits from the clone and
its worktrees are cleaned of pins by the filter. Format and rules:
`docs/model-profiles.md` in the Agento repository.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's §9
idempotency row. Open with one `node <agento-root>/scripts/agento.mjs preflight
models` call (§9–§11): print its `receipt` and then its `preflightLines` verbatim,
and stop on `status: rejected` (exit 3), writing nothing.
Window check per §11: requires role `any` (not window-sensitive: it rewrites the
plugin clone, never the current checkout's delivery state).

1. Read the argument as `<verb> [<args…>]`, verb `list` when empty. `alias` takes a
   sub-verb (`set <picker> <id>` or `remove <picker>`, the picker quoted as one
   argument); `rename` takes two profile names; `create` and `update` take one
   name. Any other shape: print the argument hint and stop.
2. Run the Agento CLI: `node <agento-root>/scripts/agento.mjs models <verb> [<args>…]`
   (the CLI path is announced in the session context as `Agento CLI:`). Its default
   plugin root is the clone that CLI lives in; pass `--plugin-root <dir>` only when
   the user names another clone. A usage error (exit 1): print its `message`
   verbatim and stop. `update` reads the full profile object as JSON from stdin:
   drive it as `models show <name>` (keep `profilesFile.hash`) → `models update
   <name> --dry-run` with the JSON on stdin (heredoc) → `models update <name>
   --expect <hash>` with the same JSON. The write verbs `create`, `update`,
   `rename`, `delete`, `alias set`, and `alias remove` all accept `--expect <hash>`;
   `create` also takes `--from <src>` and `--description <text>`, `update` also
   takes `--dry-run`, and `delete` also takes `--force`.
3. Report from the JSON, quoting values verbatim:
   - `list` — each profile's `name`, `description`, and `errors`; `profilesFile.path`
     and `exists`; `copilotModels`; `active` (`null` = nothing pinned, a profile
     name, or `custom` = pins that match no profile). When the file does not exist,
     suggest `/agento models init`.
   - `show` — the resolved `targets` (agents first, then prompts; `commands/` mirrors
     carry the same value as their prompt), `profilesFile.hash` (keep it to pass as
     `--expect`), and any `errors`.
   - `create` — `written`, `profilesFile.path` and `profilesFile.hash`, and
     `reformatted`; the profile is created empty, as a deep copy with `--from`, and
     with `--description` setting or overriding the description.
   - `update` — `written`, `profilesFile.hash`, `reformatted`, `activeBefore`/
     `active`, and `warnings`; `--dry-run` reports `dryRun: true`, `written: false`,
     `errors`, and `warnings` without writing. When `reapply` is set, the applied
     profile changed — re-apply it (see the `next:` rule).
   - `rename` — `written` and `activeBefore`/`active` (the applied profile follows
     by content, so it stays `active` under the new name).
   - `delete` — `written` and `activeBefore`/`active`; with `--force` the applied
     profile is deleted and `active` becomes `custom`.
   - `alias set` / `alias remove` — `written` and the resulting `copilotModels`.
   - `init` — `created` and `profilesFile.path`; tell the user to replace every
     `<…>` placeholder with a qualified model name, `<picker name> (<vendor>)`
     (for example `Claude Opus 4.5 (copilot)`; a non-Copilot model is ignored by
     VS Code without its vendor), then run `/agento models apply <name>`.
   - `apply`, `adopt`, `clear` — the number and list of `changed` files, `active`, and
     the filter health: `filter.installed` and `filter.scriptCurrent` (after `clear`,
     `filter.installed: false` is expected), every `filter.unrecorded` file (suggest
     `/agento models apply <name>` to pin them), and the `legacySkipWorktree` count
     when non-zero (suggest `/agento models adopt` to keep the pins, or
     `/agento models apply <name>`); quote `hint` verbatim. Tell the user to run
     *Developer: Reload Window* if the model picker does not reflect the change.
4. Exit 3 is a finding, not an error of this command: `not-found` (quote `known`),
   `exists` (the name is taken; quote `known`), `active` (the applied profile cannot
   be deleted without `--force`; quote `message`), `conflict` (the file changed
   since it was read, or `--expect` does not match; quote `expected` and `actual`,
   then re-read `profilesFile.hash` and re-send), `invalid` (quote `errors`; the
   user fixes the profiles file or the JSON on stdin), `dirty` (quote `message` and
   `dirty`; the user commits, stashes, or restores those files in the plugin clone —
   never do it for them; `git restore <file>` brings a recorded pin back),
   `worktree` (quote `message` and `primaryCheckout`: the CLI ran from an Agento
   development worktree, which inherits the clone's pins; the user re-sends
   `/agento models apply <name>` or `/agento models adopt` from the primary window,
   whose CLI lives in the registered clone), `git-too-old` (quote `message`; the user
   upgrades git), `failed` (quote `message`; re-sending is safe).

The result line's `next:` is `/agento models apply <name>` after a write that sets
`reapply` (updating the applied profile) or after `init` or a fixable finding,
`/agento doctor` after `apply`, `adopt`, or `clear` (its `model-profile`
check confirms the pinned state and the filter's health), and `/agento models` after
`list`, `show`, or a successful `create`, `update`, `rename`, `delete`, or `alias`
write; it is
repeated as its own block directly above the result line per policy §12.
