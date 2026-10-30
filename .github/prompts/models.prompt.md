---
description: "Manage model profiles in ~/.config/agento/model-profiles.json and the per-window-role model-roles.json: create, update, rename, delete, alias set, alias remove, list, show, pins, resolve, apply, adopt, clear, use, init — writes are validated, atomic, and support an optional --expect hash"
argument-hint: "[list | show <name> | pins [--role primary|secondary] | resolve <command> [--role primary|secondary] | apply <name> | adopt | clear | use <name|none> --role primary|secondary | init | create <name> [--from <src>] [--description <text>] | update <name> [--dry-run] | rename <old> <new> | delete <name> [--force] | alias set <picker> <id> | alias remove <picker>]"
agent: "agent"
tools: [read, execute]
---

Needs: terminal
Fallback: none — every need is hard
Capability vocabulary, hard/soft classification, and standard fallbacks: delivery-policy.instructions.md §10.
Policy: §1, §9, §10, §11, §12 — load once with `node <agento-root>/scripts/agento.mjs policy 1 9 10 11 12` before the first step.
Duplicate submission: `apply` of the already-active profile and `clear` on an unpinned clone change nothing (`changed: []`); `init` with the file present reports `created: false`; `list` and `show` are reads.

Manage model profiles: named sets of `model:` pins for the Agento agents and the
commands that run on the built-in agent, defined once in the user-level
`model-profiles.json` and applied to the plugin clone by the Agento CLI. The CLI is
the only writer: never edit a `model:` line, the profiles file, the filter's config,
attributes, or pin state, or a skip-worktree bit yourself. Commits from the clone and
its worktrees are cleaned of pins by the filter. Format and rules:
`docs/model-profiles.md` in the Agento repository.

Open with the acceptance receipt and close with the terminal result line per
delivery-policy.instructions.md §9; a duplicate submission follows this command's
duplicate-submission line. Open with one `node <agento-root>/scripts/agento.mjs preflight
models` call (§9–§11): print its `receipt` and then its `preflightLines` verbatim,
and stop on `status: rejected` (exit 3), writing nothing.
Window check per §11: requires role `any` (not window-sensitive: it rewrites the
plugin clone, never the current checkout's delivery state).

1. Read the argument as `<verb> [<args…>]`, verb `list` when empty. `alias` takes a
   sub-verb (`set <picker> <id>` or `remove <picker>`, the picker quoted as one
   argument); `rename` takes two profile names; `create`, `update`, and `use` take
   one name (`use` also takes the reserved `none`); `pins` takes no name and an
   optional `--role primary|secondary`; `resolve` takes one command name (a
   `.github/prompts/<command>.prompt.md` basename) and an optional
   `--role primary|secondary`; `use` requires `--role primary|secondary`.
   Any other shape: print the argument hint and stop.
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
   takes `--dry-run`, and `delete` also takes `--force`. `use` requires
   `--role primary|secondary` and accepts `--expect <hash>` only with
   `--role secondary` (`--role primary` behaves exactly like `apply <name>` or
   `clear` and writes no profile file); `pins` and `resolve` accept
   `--role primary|secondary` to override the window's bucket.
3. Report from the JSON, quoting values verbatim:
   - `list` — each profile's `name`, `description`, and `errors`; `profilesFile.path`
     and `exists`; `copilotModels`; `active` (`null` = nothing pinned, a profile
     name, or `custom` = pins that match no profile); `roles` (`primary` is the
     derived `active`, `secondary` the stored name or `null`), `rolesFile`
     (`path`/`exists`/`hash` of `model-roles.json`), and `rolesErrors` (non-empty
     when the roles file is invalid). When the profiles file does not exist,
     suggest `/agento models init`.
   - `pins` — `pins` (per agent: `name`, `file`, `model`, `subagentModel`,
     `copilotModel`) and `warnings`, plus the resolution: `role`
     (`primary`/`secondary`), `roleSource` (`window` or `flag`), `windowRole`,
     `profile`, and `source` (`file-pins` or `role-profile`). In plan, build, and
     freehand windows `pins` resolves the secondary profile when one is assigned;
     otherwise it is the clone's file pins.
   - `resolve` — the model one command opens on: `command`, `agent`, `role`,
     `roleSource`, `windowRole`, `profile`, `source` (`file-pins` or
     `role-profile`), `model`, `qualified`, `name`, `vendor`, and `copilotModel`
     (plus `warnings` for a dangling or invalid secondary assignment). Report
     `qualified` and `source`; an unpinned command has null model fields, and it
     writes nothing.
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
   - `use` — `secondaryBefore` and `roles` (`{ secondary }`), plus `written` and
     `rolesFile`. `--role secondary <name>` writes `model-roles.json` after
     validating the profile; `use none --role secondary` turns the role off;
     `--role primary` reports like `apply`/`clear` (see that bullet). The roles
     file is CLI-owned, so a validated `use --role secondary` replaces it wholesale
     and repairs an invalid `model-roles.json`; the user-authored profiles file is
     instead left untouched when it has errors.
   - `rename` — `written` and `activeBefore`/`active` (the applied profile follows
     by content, so it stays `active` under the new name); when the renamed profile
     was the secondary role, also `secondaryBefore` and `roles` (the assignment
     moved to the new name).
   - `delete` — `written` and `activeBefore`/`active`; with `--force` the applied
     profile is deleted and `active` becomes `custom`; when the deleted profile was
     the secondary role and `--force` was passed, also `secondaryBefore` and
     `roles` (the role is now off).
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
   be deleted without `--force`; quote `message`), `assigned` (the profile is the
   secondary role; quote `message` — the user runs `/agento models use none --role
   secondary` to turn the role off, or passes `--force`), `conflict` (the file
   changed since it was read, or `--expect` does not match; quote `expected` and
   `actual`, then re-read `profilesFile.hash` and re-send), `invalid` (quote
   `errors`; the user fixes the profiles file or the JSON on stdin), `dirty` (quote
   `message` and `dirty`; the user commits, stashes, or restores those files in the
   plugin clone — never do it for them; `git restore <file>` brings a recorded pin
   back), `worktree` (quote `message` and `primaryCheckout`: the CLI ran from an
   Agento development worktree, which inherits the clone's pins; the user re-sends
   `/agento models apply <name>` or `/agento models adopt` from the primary window,
   whose CLI lives in the registered clone), `git-too-old` (quote `message`; the user
   upgrades git), `failed` (quote `message`; re-sending is safe).

The result line's `next:` is `/agento models apply <name>` after a write that sets
`reapply` (updating the applied profile) or after `init` or a fixable finding,
`/agento doctor` after `apply`, `adopt`, `clear`, or `use … --role primary` (its
`model-profile` check confirms the pinned state and the filter's health),
`/agento models` after `use … --role secondary` (or a successful `list`, `show`,
`pins`, `resolve`, `create`, `update`, `rename`, `delete`, or `alias` write); it is
repeated as its own block directly above the result line per policy §12.
