# Review: plugin-hooks-layout

Verdict: approve

Review round 1, at `f5bd509` on `issue/plugin-hooks-layout` (GitHub issue #36, draft
PR #37, head `f5bd509f…`, `mergeStateStatus: CLEAN`), 2026-09-15. This worktree
(`plan-20260915-192647`, `role: build`, `delivery.slug: plugin-hooks-layout`) owns the
branch per `agento.mjs session` (`worktrees[]`: primary on `main`, this entry on the
branch, no other). `doctor --for review-issue` → `ok` (node v22.22.3, origin reachable,
gh 2.45.0 authenticated, python3, worktrees-dir writable). `origin/main` `d1bdc3e` is
an ancestor of `HEAD` (`git merge-base --is-ancestor origin/main HEAD` → 0); working
tree clean. Skills consulted: none — no matching domain (no `.agents/skills/`, no
`## Agento` skills table in AGENTS.md).

Nothing in this delivery is served behaviour; no `local:`/`dev-stack`/`preview` target
applies. The runtime target is the VS Code Hooks output channel, re-checked from the
source log (below) and the shell-level repro, both re-driven by the Reviewer.

Verification run by the Reviewer at `f5bd509` (baseline in plan.md `## Research`: 140
pass / 0 fail at `d1bdc3e`, shellcheck 0, replay-guard 0):

- `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` → exit 0, no findings
  (equals baseline).
- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, `# tests 141`,
  `# pass 141`, `# fail 0`, no `not ok` lines. +1 over the baseline, the #36 test; no
  new findings.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0 (equals
  baseline).
- Exposing test, independently: `git archive origin/main` extracted to `/tmp` (no
  worktree, no stash, tree untouched) with the step-1.1 test file
  (`git show 85c5e77:tests/customizations.test.mjs`) → `node --test
  tests/customizations.test.mjs` exit 1, `# pass 18 / # fail 1`, the only `not ok`
  being `plugin layout is Claude format so VS Code expands ${CLAUDE_PLUGIN_ROOT} (#36
  plugin-hooks-layout)` with `.claude-plugin/plugin.json missing`. With the final test
  file on the same old tree, that test *and* the retargeted manifest test fail (ENOENT
  on `.claude-plugin/plugin.json`), as expected after step 2.3. On `HEAD` both are `ok`.
- Shell-level root cause: `/bin/sh -c '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/delivery-guard.sh'
  </dev/null` with the variable unset → `/bin/sh: 1: /scripts/hooks/delivery-guard.sh:
  not found`, exit 127; with `CLAUDE_PLUGIN_ROOT=$PWD` and a benign
  `run_in_terminal` `ls` JSON on stdin → exit 0.
- Runtime evidence source log
  `~/.config/Code/logs/20260910T224623/window22/exthost/GitHub.copilot-chat/GitHub
  Copilot Chat Hooks.log` read directly: 9 lines, mtime 2026-09-15 18:01:14 -0400;
  `grep -c 'not found'` → 0; `grep -c 'Executing'` → 2 (one SessionStart, one
  PreToolUse); both `"command"` values are the absolute worktree paths to
  `session-context.sh` / `delivery-guard.sh`; `env.CLAUDE_PLUGIN_ROOT` is the worktree
  path; `Completed (Success) in 214ms` and `in 159ms`; `Agento CLI: node
  /home/david/DP/agento-worktrees/plan-20260915-192647/scripts/agento.mjs` present;
  `cwd.fsPath` is `/home/david/DP/prismicon` (non-Agento repo); zero literal
  `${CLAUDE_PLUGIN_ROOT}` occurrences. The excerpt in
  [evidence/step-3-1-runtime-hooks.md](evidence/step-3-1-runtime-hooks.md) is faithful.

## Acceptance checklist results

1. **Exposing test fails on the old layout, passes now** — **pass**. See the
   `git archive` reproduction above (exit 1 naming only the #36 test with the 1.1
   file); `HEAD` gate 141/141.
2. **`.claude-plugin/plugin.json` shape; root files gone** — **pass**. Node
   comparison against `origin/main:plugin.json`: every key except `hooks` and
   `version` byte-equal (`name, description, version, author, homepage, repository,
   license, keywords, agents, commands, hooks`); `agents: ".github/agents"`,
   `commands: "commands"`, `hooks: "./hooks/hooks.json"`, no `$schema`;
   `test ! -e plugin.json && test ! -e hooks.json` → true. `version` differs only by
   the planned `0.4.0 → 0.4.1` bump (item 7).
3. **`hooks/hooks.json` byte-identical to `origin/main:hooks.json`** — **pass**.
   `git diff --quiet origin/main:hooks.json HEAD:hooks/hooks.json` → 0; `cmp` → 0;
   `git diff -M --diff-filter=R --name-status` shows `R100 hooks.json →
   hooks/hooks.json` and `R090 plugin.json → .claude-plugin/plugin.json`.
4. **Runtime proof in `evidence/step-3-1-runtime-hooks.md`** — **pass**. File exists,
   is linked from roadmap step 3.1 with `completed 2026-09-15`, and every one of its
   six verify conditions is confirmed against the source log above (absolute
   `Running:` commands, `Completed (Success)` ×2, `not found` = 0, exactly one
   `Executing 1 hook(s)` per event, `Agento CLI:` line, non-Agento cwd).
5. **Dev-clone advice** — **pass**. `grep -rn 'pluginLocations' README.md
   docs/install.md AGENTS.md` shows only the `true` install snippets and the new
   advice; `false`-toggle count 0. Each file: `Agent Plugins` ≥ 1, `machine-scoped`
   hit ([README.md](../../../../README.md#L518), [docs/install.md](../../../../docs/install.md#L26),
   [AGENTS.md](../../../../AGENTS.md#L41)), `Agent Customizations editor` ≥ 1,
   `worktree window` ≥ 1, and each says "do not register" the clone.
6. **Old-layout references updated; mirrors identical** — **pass**. The plan's grep
   over `AGENTS.md docs/hooks.md .github/agents .github/prompts commands` excluding the
   new paths prints nothing; a wider sweep over `README.md docs templates
   .github/instructions` also prints nothing; `grep 'workspace or user|for that
   workspace|user or workspace'` over docs/prompts/agents/commands prints nothing.
   `cmp` of `agento-init` and `ship` prompts vs `commands/*.md` → identical; the
   customizations test's mirror assertion passes.
7. **Versions and CHANGELOG** — **pass**. Both manifests `0.4.1` (node check exit 0);
   `sed -n '3p' CHANGELOG.md` → `## 0.4.1 (unreleased)`; the entry's **Fixed** bullet
   references `#36` once and describes the move, the runtime effect, and the corrected
   dev-clone advice.
8. **Lint gate equals baseline** — **pass**. shellcheck 0/0 findings, 141/141 tests,
   replay-guard 0 (above).
9. **Nothing under `scripts/hooks/` or `.github/hooks/`** — **pass**.
   `git diff --name-only origin/main...HEAD | grep -E '^(scripts/hooks/|\.github/hooks/)'`
   → no matches; the 20 changed paths are the manifest/hooks moves, docs, prompts and
   their mirrors, test, package.json, CHANGELOG, and the slug directory.
10. **PR body and merge state** — **pass**. `gh pr view 37 --json
    mergeStateStatus,isDraft,body` → `CLEAN`, `isDraft: true`, base `main`, head
    `f5bd509f…`, body first line `Fixes #36`. (Roadmap 5.2 recorded `BLOCKED` at push
    time; it has since resolved to `CLEAN` — neither is `BEHIND`/`DIRTY`.)

## Plan vs implementation

- Implementation matches `## Approach` 1–6 and the `Files touched` list exactly; no
  undocumented file changes (`git diff --name-only origin/main...HEAD` ⊆ the list plus
  the slug's evidence files).
- Deviation, documented on the step line and in `## Resolution`: step 3.1's
  settings-file part was performed by the Builder with the user's explicit permission
  (backup `~/.config/Code/User/settings.json.agento-3-1.bak`), and the settings were
  restored afterwards. The chat/`git status` part and the report-back stayed with the
  user, so the `(manual)` classification remains honest. The plan's Decisions 4
  accepted a text (`.md`) capture instead of a `.png` screenshot; the evidence file
  follows that agreement.
- The plan's step 5.2 verify `git diff --diff-filter=D --name-only` prints nothing
  because git pairs the moves as renames; the roadmap records the `--no-renames`
  equivalent (`hooks.json`, `plugin.json`) — the intent (root files gone) is met and
  independently confirmed with `test ! -e`.
- `## Resolution` is present in plan.md with root cause, what changed, and proof, per
  the artifact contract.

## Roadmap audit

All 10 ticked boxes spot-checked against the tree and the commands above: 1.1 (old-tree
reproduction), 2.1–2.3 (manifest comparison, byte-identity, retargeted test), 3.1
(evidence file exists, linked, dated, verified against the source log), 4.1–4.3 (greps,
`cmp`, versions, CHANGELOG), 5.1–5.2 (gate re-run, scope grep, PR state). No falsely
ticked boxes; no missing steps; no repairs made.

## Findings

No findings above minor.

- **Minor / housekeeping** — the Builder's settings backup
  `~/.config/Code/User/settings.json.agento-3-1.bak` is still on disk (roadmap 3.1
  says "kept"). Harmless, outside the repository; the user may delete it once
  satisfied. Not a blocker.
- **Minor / test precision** — the new test in
  [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs#L433-L454)
  checks `mode & 0o111` (any execute bit) rather than owner-execute specifically; this
  mirrors the existing `checkHooks` helper and is adequate for a repo-tracked file.
  Informational only.
- **Security** — no new executable code; `hooks/hooks.json` content unchanged; the
  hook scripts themselves are untouched (`scripts/hooks/`, `.github/hooks/` not in the
  diff). No secrets in the diff or the evidence excerpt (the `Input:` transcript paths
  were elided by the Builder).

## Follow-ups

- File the VS Code bug upstream (microsoft/vscode): a Copilot-format (format 0: root
  `plugin.json` + root `hooks.json`) plugin's hook commands are spawned with
  `${CLAUDE_PLUGIN_ROOT}` unexpanded and without `CLAUDE_PLUGIN_ROOT` in the
  environment, although the format descriptor lists both `${PLUGIN_ROOT}` and
  `${CLAUDE_PLUGIN_ROOT}` as `pluginRootTokens` and the docs promise expansion. Minimal
  repro and source trace are in roadmap.md `## Follow-ups` and
  [evidence/vscode-source-trace.txt](evidence/vscode-source-trace.txt). Observed on
  1.132.0 `df53daabb18c`.
- Extend the delivery guard's `PROTECTED` regex to gate `hooks/hooks.json` and
  `.claude-plugin/` edits (a `scripts/hooks/` change — separate, approval-gated
  delivery with new `tests/guard-fixtures.txt` cases).
- Exercise install option B (*Chat: Install Plugin From Source*) and option C
  (`copilot plugin install`) against the new layout after release and record the result
  in docs/install.md.
- New: after `/agento ship` removes this worktree, confirm the user's
  `chat.pluginLocations` no longer references `plan-20260915-192647` (roadmap 3.1 says
  the entry was removed and the clone restored to `true`; a dangling path would log a
  discovery error) and delete `~/.config/Code/User/settings.json.agento-3-1.bak`.
- New: the `agento-init` self-detection now keys on `.claude-plugin/plugin.json` with
  `"name": "agento"`; if Agento ever adopts the Agent Plugins 1.0 `$schema` layout, that
  prompt line and the #36 test both need to move with it (note for that future
  delivery, not a defect now).
