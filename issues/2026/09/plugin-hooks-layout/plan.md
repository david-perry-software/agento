# Plugin hooks never run: adopt the `.claude-plugin/` + `hooks/hooks.json` layout

## Problem

Installed as a plugin (via `chat.pluginLocations`, install-from-source, or the Copilot
CLI), Agento's two hooks never execute. Every SessionStart and every tool call logs
`/bin/sh: 1: /scripts/hooks/<script>.sh: not found` in the GitHub Copilot Chat Hooks
output channel, because VS Code hands the hook command to the shell with the
`${CLAUDE_PLUGIN_ROOT}` token unexpanded and no `CLAUDE_PLUGIN_ROOT` in the
environment. Target repositories therefore get no `Session:` / `Agento CLI:` context
(the window check, `/agento continue`, and the prompts' CLI path all depend on it) and
no delivery guard — the plugin is silently inert and only the server-side ruleset on
`main` stands between an agent and a direct push.

A second, masked defect: [README.md](../../../../README.md#L514-L516),
[docs/install.md](../../../../docs/install.md#L33-L35), and
[AGENTS.md](../../../../AGENTS.md#L38-L41) tell developers of Agento itself to disable
the plugin "for that workspace" with `"chat.pluginLocations": { "<path>": false }`. The
setting is machine-scoped, so a workspace value is ignored. Nobody noticed because the
plugin-mode hooks fail anyway; once they run, a registered dev clone double-fires both
hooks inside the Agento repo and every one of its worktrees.

## Evidence

GitHub issue: #36

Reproduction (performed by the Planner, 2026-09-15, VS Code 1.132.0 `df53daabb18c`,
Linux):

1. Agento clone `~/DP/agento` registered via `chat.pluginLocations`; current layout is
   root `plugin.json` + root `hooks.json` ([plugin.json](../../../../plugin.json),
   [hooks.json](../../../../hooks.json)).
2. Open a repository, start a new chat, run any terminal tool call.
3. Output → **GitHub Copilot Chat Hooks**:
   - **Observed** — `Running: {"command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-context.sh", …}` →
     `Completed (NonBlockingError)` → `Output: /bin/sh: 1: /scripts/hooks/session-context.sh: not found`;
     the same for `delivery-guard.sh` on every PreToolUse. 164 such lines in one
     window log; 22 window logs affected on this machine.
     Capture: [evidence/hooks-log-excerpt.txt](evidence/hooks-log-excerpt.txt).
   - **Expected** — the token expanded to the plugin's absolute path, both hooks
     `Completed (Success)` once per event, guard decisions applied.
4. Shell-level equivalent — `/bin/sh -c '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/delivery-guard.sh'`
   with the variable unset prints the identical message and exits 127; with
   `CLAUDE_PLUGIN_ROOT` set to the repo root the guard runs and exits 0:
   [evidence/shell-repro.txt](evidence/shell-repro.txt).
5. Root cause traced in VS Code's `workbench.desktop.main.js`:
   [evidence/vscode-source-trace.txt](evidence/vscode-source-trace.txt). Format 0
   (root `plugin.json` + `hooks.json`) parses hooks with `BTo(s,o,t,i)` — the plugin
   root is dropped, no replacement, no env var. Formats 1 (`.claude-plugin/plugin.json`
   + `hooks/hooks.json`) and 2 call `HTo(...)`, which `replaceAll`s the token and sets
   `env.CLAUDE_PLUGIN_ROOT`. Both discovery branches (manifest `hooks` field and default
   `hookConfigPath`) use the format's parser, so no manifest tweak rescues format 0.
   Format detection prefers `.claude-plugin/plugin.json` over the root default. The
   same trace shows `"chat.pluginLocations"` declared `scope: 2` (MACHINE).

## Decisions

Clarifying questions asked in chat (ask-questions tool unavailable, §10 fallback) and
the user's answers, verbatim:

1. **Root files.** *Move to `.claude-plugin/plugin.json` + `hooks/hooks.json` and
   delete the root `plugin.json` and `hooks.json`, or keep the root files as well?*
   > Root files → move, don't duplicate. Delete root plugin.json and hooks.json. Format
   > detection is .claude-plugin/plugin.json exists → format 1, so root copies would
   > never be read and would only reintroduce version drift (the customizations.test.mjs
   > version-match assertion should read the new path). Keep hooks.json content
   > byte-identical apart from location — the ${CLAUDE_PLUGIN_ROOT} token is now correct.

2. **Manifest shape.** *Keep `agents`/`commands`, declare `hooks` explicitly or rely on
   the default, add `$schema`?*
   > Format 1 has no componentPaths override (confirmed above), so it reads default
   > component dirs plus whatever the manifest names via xEn(manifest.agents|commands).
   > Keep "agents": ".github/agents" and "commands": "commands". Declare "hooks":
   > "./hooks/hooks.json" explicitly — it's redundant for VS Code (fixed hookConfigPath)
   > but it's what checkHooks(rel(plugin.hooks), …) in the test reads, and it documents
   > intent. Don't add $schema — there's no published schema URL to point at and an
   > unresolvable one is noise. Everything else (name, version, description, author,
   > homepage, repository, license, keywords) carries over unchanged.

3. **Dev-clone advice replacement.** *(a) per-workspace disable from the Extensions
   view, (b) don't register the dev clone, or (c) accept the double fire?*
   > Dev-clone advice → (b), with (a) as the fallback. Recommend not registering the
   > dev clone in chat.pluginLocations; hooks already guards the clone and every
   > worktree, and it's the only wiring whose ./scripts/hooks/… paths are correct inside
   > a worktree. If the user also wants the plugin installed for other repos from the
   > same clone, (a) applies: chat.plugins.enabledPlugins is scope: 1
   > (window/workspace), so "Disable (Workspace)" genuinely works per-checkout — note it
   > must be done in each worktree window too. Reject (c): duplicated SessionStart
   > context and two guard evaluations per tool call is exactly the "silent/noisy
   > execution" the initiative just fixed. Rewrite README line ~515 and install.md
   > accordingly; the settings.json pluginLocations: false line is dead (machine-scoped)
   > — remove it and replace with the enabledPlugins workspace toggle.

   Planner note: in VS Code's `ConfigurationScope` enum `1` is `APPLICATION` (`2` is
   `MACHINE`), so `chat.plugins.enabledPlugins` is user-only as well, not
   workspace-settable. The per-workspace toggle that does work is the Extensions view →
   *Agent Plugins – Installed* → context menu / Agent Customizations editor, whose
   state VS Code stores outside settings. The docs will name that UI toggle rather than
   a settings key; the intent of (a) is unchanged.

4. **Tests + manual step.** *Unit regression test named after the issue plus a
   `(manual)` runtime check where you register the fixed branch in your user
   settings.json and I read the Hooks log?*
   > Tests + manual step — both, as you propose. (a) Unit test named after the issue:
   > asserts .claude-plugin/plugin.json exists, root plugin.json/hooks.json do not, and
   > every hook command starts with ${CLAUDE_PLUGIN_ROOT}/ and resolves to an executable
   > after substituting the repo root. Evidence: a one-line reproduction showing sh -c
   > '${CLAUDE_PLUGIN_ROOT}delivery-guard.sh' → not found when unset. (b) The (manual)
   > step is legitimate under §1 — it edits your user settings.json, which the agent
   > must not touch — and it's the only faithful proof the token is substituted at
   > runtime. Keep it: evidence is the relevant lines from the GitHub Copilot Chat Hooks
   > output channel showing the resolved absolute path (a .txt/.md capture is fine; no
   > screenshot needed). Verify both hooks fire exactly once in a non-Agento target
   > repo, not just the clone.

5. **Release and upstream.** *CHANGELOG under `0.4.0 (unreleased)` or a bump? File the
   VS Code bug upstream as a step or a follow-up?*
   > CHANGELOG 0.4.0 is already stamped (2026-09-15) and both manifests are 0.4.0, so
   > this is a new entry: add ## 0.4.1 (unreleased) and bump both version fields to
   > 0.4.1 in the branch — /agento ship will stamp the date. It's a patch: nothing
   > user-facing changes except that hooks finally run. Upstream: file it, but as a
   > follow-up in roadmap ## Follow-ups, not a step — a format-0 plugin silently
   > dropping the root token is a VS Code bug worth a microsoft/vscode issue, but our
   > fix doesn't depend on it and the roadmap shouldn't block on an external tracker.
   > Include the minimal repro (root-level plugin.json + hooks.json with
   > ${CLAUDE_PLUGIN_ROOT}) in the follow-up text so whoever files it has it ready.

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/`
directory and its AGENTS.md has no `## Agento` skills table).

**Current layout and consumers of it** (all cited paths are on `origin/main` `d1bdc3e`):

- [plugin.json](../../../../plugin.json) — root manifest: `name`, `description`,
  `version: 0.4.0`, `author`, `homepage`, `repository`, `license`, `keywords`,
  `agents: ".github/agents"`, `commands: "commands"`, `hooks: "hooks.json"`.
- [hooks.json](../../../../hooks.json) — flat format, `SessionStart` →
  `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-context.sh` (timeout 10), `PreToolUse`
  → `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/delivery-guard.sh` (timeout 15).
- [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs#L387-L431)
  — the "plugin manifest…" test reads `rel("plugin.json")`, asserts `plugin.agents` /
  `plugin.commands` exist, mirrors `commands/*.md` against `.github/prompts/*.prompt.md`,
  asserts `plugin.version === package.version`, and `checkHooks(rel(plugin.hooks), …)`
  requires every command to start with `${CLAUDE_PLUGIN_ROOT}/` and resolve to an
  executable under the repo root. The workspace-mode files in `.github/hooks/*.json`
  are checked with `./` stripping.
- Prose that names the layout or the dead advice:
  [AGENTS.md](../../../../AGENTS.md#L6-L7) (layout bullet),
  [AGENTS.md](../../../../AGENTS.md#L38-L41) (dev-clone rule citing `chat.pluginLocations`),
  [README.md](../../../../README.md#L514-L516) (dev-clone advice),
  [docs/install.md](../../../../docs/install.md#L33-L35) (dev-clone advice),
  [docs/hooks.md](../../../../docs/hooks.md#L3-L5) (plugin-mode wiring sentence),
  [.github/agents/copilot-mechanic.agent.md](../../../../.github/agents/copilot-mechanic.agent.md#L17-L18)
  and [L73-L74](../../../../.github/agents/copilot-mechanic.agent.md#L73-L74) (file list,
  "root `hooks.json`"),
  [.github/prompts/agento-init.prompt.md](../../../../.github/prompts/agento-init.prompt.md#L23-L24)
  (self-detection "no `plugin.json` … at its root") and
  [L100](../../../../.github/prompts/agento-init.prompt.md#L100) ("workspace or user"
  `chat.pluginLocations`),
  [.github/prompts/ship.prompt.md](../../../../.github/prompts/ship.prompt.md#L83)
  (release-entry diff `-- plugin.json package.json`). The `commands/agento-init.md` and
  `commands/ship.md` mirrors must stay byte-identical (test above).
- Not referenced by code: `grep` of `scripts/` finds no reader of `plugin.json` or
  `hooks.json`; the CLI and hooks are layout-agnostic. The delivery guard's
  `PROTECTED` regex ([scripts/hooks/delivery-guard.sh](../../../../scripts/hooks/delivery-guard.sh#L109))
  covers `.github/hooks/` and `scripts/hooks/` only — neither the old root `hooks.json`
  nor the new `hooks/hooks.json` is gated (follow-up, not in scope).
- Historical delivery artifacts under `features/**` and `initiatives/**` mention
  `plugin.json`/`hooks.json`; they are records and are not rewritten.

**VS Code behaviour** (1.132.0; [evidence/vscode-source-trace.txt](evidence/vscode-source-trace.txt)):
format detection order is Agent Plugins 1.0 (`$schema`) → `.plugin/plugin.json` →
`.claude-plugin/plugin.json` → root default; format 1 reads manifest `commands`/`agents`
paths, its default hook file is `hooks/hooks.json`, and a manifest `hooks` field is read
through `_readHooksFromPaths` with the same token-expanding parser. Official docs
(code.visualstudio.com, "Agent plugins in VS Code") claim the Copilot format supports
`${CLAUDE_PLUGIN_ROOT}`; the shipped code disagrees — hence the upstream follow-up.

**Copilot CLI compatibility**: the bundled `@github/copilot` CLI
(`/usr/share/code/resources/app/extensions/copilot/dist/cli.js`) references
`.claude-plugin` 13 times, so `copilot plugin install` (install option C) understands
the Claude layout.

**Lint baseline** (§5), run 2026-09-15 on `d1bdc3e`:

- `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` → exit 0, no findings.
- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → 140 tests, 140 pass,
  0 fail.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.

Baseline is green, so there is no overlap to clean up and no scoped gate: the full
gate is simply re-running all three commands at the end and requiring the same clean
result (plus the new test).

**Concurrent deliveries**: `gh pr list --state open` → none. No file overlap risk.

## Approach

1. **Expose.** Add a `node:test` case to `tests/customizations.test.mjs` named
   `plugin layout is Claude format so VS Code expands ${CLAUDE_PLUGIN_ROOT} (#36 plugin-hooks-layout)`
   asserting: `.claude-plugin/plugin.json` exists and parses; root `plugin.json` and
   root `hooks.json` do not exist; the manifest's `hooks` is `./hooks/hooks.json` and
   that file exists; every hook command starts with `${CLAUDE_PLUGIN_ROOT}/` and, after
   substituting the repo root, is an executable file. It fails on the current tree.
2. **Move, don't duplicate.** `git mv plugin.json .claude-plugin/plugin.json` and edit
   only `"hooks": "./hooks/hooks.json"`; `git mv hooks.json hooks/hooks.json` with no
   content change (a 100% rename in `git diff -M`). Retarget the existing manifest
   test to the new manifest path and resolve `plugin.hooks` relative to the repo root
   (stripping a leading `./`).
3. **Prove at runtime.** One `(manual)` step: the user registers this worktree's path
   in their **user** `settings.json` `chat.pluginLocations` (setting the `~/DP/agento`
   clone entry to `false` for the duration), reloads, opens a non-Agento repository,
   starts a new chat, and runs one terminal tool call. The Builder then reads that
   window's `GitHub Copilot Chat Hooks.log`, requires both hooks to run with the
   resolved absolute path, zero `not found`, and exactly one execution per event, and
   saves the lines as `evidence/step-3-1-runtime-hooks.md` (text capture accepted by
   the user in Decisions 4).
4. **Docs and references.** Replace the dev-clone advice in README, docs/install.md,
   and AGENTS.md with: do not register the dev clone (workspace-mode `.github/hooks/`
   already guards the clone and every worktree); fallback: disable the plugin per
   workspace from Extensions → *Agent Plugins – Installed* (or the Agent Customizations
   editor), in each worktree window too. Delete the `pluginLocations: false` snippet.
   Update the layout mentions in AGENTS.md, docs/hooks.md, the Mechanic agent, the
   `agento-init` self-detection and its "workspace or user" wording, and the `ship`
   release-entry diff path; regenerate the two `commands/*.md` mirrors byte-identically.
5. **Release entry.** Bump `.claude-plugin/plugin.json` and `package.json` to `0.4.1`;
   add `## 0.4.1 (unreleased)` above `## 0.4.0 (2026-09-15)` in CHANGELOG.md with a
   **Fixed** bullet referencing #36. `/agento ship` stamps the date.
6. **Gate and publish.** Full lint/test/guard rerun equal to the baseline, scope check
   (no `scripts/hooks/`, `.github/hooks/` changes), merge `origin/main`, push,
   `status: in-review`.

Files touched: `.claude-plugin/plugin.json` (new, from `plugin.json`), `hooks/hooks.json`
(new, from `hooks.json`), `plugin.json` and `hooks.json` (deleted),
`tests/customizations.test.mjs`, `package.json`, `CHANGELOG.md`, `AGENTS.md`, `README.md`,
`docs/install.md`, `docs/hooks.md`, `.github/agents/copilot-mechanic.agent.md`,
`.github/prompts/agento-init.prompt.md`, `.github/prompts/ship.prompt.md`,
`commands/agento-init.md`, `commands/ship.md`, and this slug directory.

## Risks

- **Format 1 discovery differs from format 0 in ways not yet observed** (e.g. a
  Claude-format expectation about `commands/` frontmatter). Mitigation: the `(manual)`
  runtime step verifies hooks *and* the Builder confirms `/agento delivery-status`
  and the agents still appear in the target-repo chat during the same session; any
  discrepancy becomes an `(added)` step before review.
- **Double firing during the runtime test.** If the `~/DP/agento` clone stays
  registered while the worktree is added, the log shows two plugin executions per
  event (one failing). Mitigation: step 3.1 instructs setting the clone entry to
  `false` for the test and restoring it afterwards; the verify requires exactly one
  `Executing 1 hook(s)` per event from the plugin.
- **Dangling `chat.pluginLocations` entry after ship.** `/agento ship` removes the
  worktree; the user's settings would point at a missing path. Mitigation: step 3.1
  tells the user to remove the worktree entry once evidence is captured and to
  re-enable the clone entry (which gains the new layout when `main` is pulled).
- **Copilot CLI / install-from-source paths.** Verified only by grep of the bundled
  CLI for `.claude-plugin`; not exercised end to end. Mitigation: noted as a follow-up
  check after release; the layout is the documented Claude format both tools read.
- **Guard coverage gap.** `hooks/hooks.json` is not in the guard's `PROTECTED` regex
  (nor was the root file). Out of scope here (guard edits are a separate, gated
  delivery); recorded as a follow-up.
- **Concurrent deliveries**: none open at planning time; the Builder still merges
  `origin/main` before every push (§7).

## Out of scope

- Any change to `scripts/hooks/*.sh`, `.github/hooks/*.json`, or the guard's rules.
- Adopting the Agent Plugins 1.0 `$schema` / `com.github.copilot/` layout.
- Filing the upstream VS Code issue (follow-up in roadmap.md).
- Rewriting historical `features/**` / `initiatives/**` artifacts that mention the old
  paths.
- Behavioural changes to the hooks, CLI, prompts, or agents beyond path spellings.

## Acceptance checklist

- [ ] The exposing regression test in `tests/customizations.test.mjs` (name contains
  `#36` and `plugin-hooks-layout`) fails on the `origin/main` layout (`node --test
  tests/customizations.test.mjs` exits 1 naming that test at step 1.1) and passes after
  the move (exit 0 at step 2.3 and in the final gate).
- [ ] `.claude-plugin/plugin.json` exists, parses, and carries `name`, `description`,
  `version`, `author`, `homepage`, `repository`, `license`, `keywords`,
  `agents: ".github/agents"`, `commands: "commands"`, `hooks: "./hooks/hooks.json"` and
  no `$schema`; root `plugin.json` and root `hooks.json` do not exist
  (`test ! -e plugin.json && test ! -e hooks.json`).
- [ ] `hooks/hooks.json` is byte-identical to `origin/main:hooks.json`
  (`git diff --quiet origin/main:hooks.json HEAD:hooks/hooks.json`).
- [ ] Runtime proof: `evidence/step-3-1-runtime-hooks.md` (linked from roadmap step
  3.1) shows, from a non-Agento repository's GitHub Copilot Chat Hooks log, a
  SessionStart and a PreToolUse `Running:` line whose `command` is the absolute
  worktree path to each script, `Completed (Success)`, zero `not found`, and one
  plugin execution per event.
- [ ] `grep -rn 'pluginLocations' README.md docs/install.md AGENTS.md` shows no
  `false` toggle, and each of the three files states: do not register the dev clone;
  fallback: disable the plugin per workspace from the Extensions view / Agent
  Customizations editor, including in worktree windows.
- [ ] Old-layout references are updated: `grep -rn 'plugin\.json\|hooks\.json'
  AGENTS.md docs/hooks.md .github/agents .github/prompts commands` mentions only
  `.claude-plugin/plugin.json` and `hooks/hooks.json`; `commands/agento-init.md` and
  `commands/ship.md` are byte-identical to their prompts (customizations test passes).
- [ ] `.claude-plugin/plugin.json` and `package.json` both read `"version": "0.4.1"`;
  `sed -n '3p' CHANGELOG.md` prints `## 0.4.1 (unreleased)` and that entry references
  `#36`.
- [ ] Lint gate equals the baseline: `shellcheck scripts/hooks/*.sh
  scripts/wait-for-checks.sh` exit 0 with no findings; `node --test
  'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` all pass (≥ 141);
  `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0.
- [ ] `git diff --name-only origin/main...HEAD` lists nothing under `scripts/hooks/`
  or `.github/hooks/`.
- [ ] The PR body starts with `Fixes #36`; `gh pr view --json mergeStateStatus` is not
  `BEHIND` or `DIRTY` when `status: in-review` is set.
