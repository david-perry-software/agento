# Canonical command invocation: one spelling, old forms redirected, packaging tests

## Problem

Member `### canonical-commands` of the
[workflow-orchestration](../../../../initiatives/2026/09/workflow-orchestration/breakdown.md)
initiative (wave 1, size S). Brief: "`/agento agento-init.prompt` was treated as
ordinary text because commands were exported with the wrong path and `.prompt` suffix
… Invocation style also varied between `/agento ship`, `/ship`, `/agento ap.prompt`,
`/ap`. Canonical command names, aliases for old forms, and packaging tests should make
command invocation unambiguous."

Today the canonical form `/agento <name>` is enforced only indirectly: a test rejects
unqualified `/<name>` in guidance, and another asserts `commands/*.md` mirror
`.github/prompts/*.prompt.md`. Nothing tells the model what to do when a user types an
old form (`/ship`, `/agento ap.prompt`, `/agento-init.md`), no test rejects a `.prompt`
or `.md` suffix written after a command name in guidance, and the plugin `commands`
directory name check is loose enough to accept a `foo.prompt.md` file. A user who types
an old form gets their command treated as prose; a maintainer who mis-exports a
command gets no test failure. After this feature, every guidance surface agrees on
one spelling, an old form is recognised and redirected without confirmation, and the
packaging tests fail on the exact defect that motivated the brief.

## Decisions

The ask-questions tool was unavailable in this session; questions were asked as
numbered items in chat and the answers are retained verbatim.

- **Q1: Where should the invocation rule live?** (a) a new `## 9. Command invocation`
  section in `delivery-policy.instructions.md`, or (b) a new
  `.github/instructions/command-invocation.instructions.md` with `applyTo: "**"`?
  A: "(b), .github/instructions/command-invocation.instructions.md, applyTo: "**".
  Avoids the §9/§10 collision outright and keeps the policy file to shared delivery
  rules; invocation is a chat-surface concern. Keep it short (canonical form,
  redirect rule, "say which and proceed")."
- **Q2: Redirect scope — what does "old form" include? Legacy-name mapping?**
  A: "names-as-is only. Your six forms are right: /<name>, /<name>.prompt, /<name>.md,
  /agento <name>.prompt, /agento <name>.prompt.md, /agento <name>.md. Also treat
  /agento <name>.prompt with trailing arguments the same way. No legacy-name mapping —
  nothing has been renamed (ap has always been ap), and a mapping table invents state
  to maintain. If a rename ever happens, that feature adds its row."
- **Q3: Where does the redirect rule need to be cited — per-command lines or the
  single file + docs table?** A: "single instruction file + commands.md ## Invocation
  table. Do not add per-command lines; command-receipts already touches every command
  file and you'd conflict on all of them for no gain (applyTo: "**" already reaches
  every turn). One exception: add a sentence to AGENTS-section.md (and its echo in
  agento-init.md step 4 — one file, small hunk) so target repos get the
  canonical-form note."
- **Q4: Test tightening — how strict?** A: "(i) and (ii) yes, (iii) yes, plus one.
  (i) Scan for \.(prompt|prompt\.md|md)\b directly after a known command name in
  guidance files; name it after the agento-init.prompt defect. Exclude CHANGELOG.md
  (historical) and the instruction file itself (it must quote the bad forms as
  examples) — use an allowlist of those two paths rather than weakening the regex.
  (ii) plugin.json commands dir: only ^[a-z0-9-]+\.md$, byte-identical to the prompt —
  already partly there; tighten the name regex. (iii) every command name in the
  ## Invocation table. Add (iv): the instruction file exists with applyTo: "**" and
  lists every command name (so a new command can't skip it) — or drop (iii) in favour
  of (iv) if you want just one "listing" test; (iv) is the one that guards behaviour."
  Planner's reading: keep both (iii) and (iv) — the user said "plus one" and offered
  the drop only as an option.
- **Q5: Sequencing vs `command-receipts`.** A: "proceed now. Overlap is only
  commands.md, customizations.test.mjs, CHANGELOG.md (all additive hunks in different
  regions), and command-receipts is in-review awaiting /agento ship, so it will merge
  first. Merge origin/main before every push per §7; if it lands mid-build, resolve
  the three additive hunks. Note in ## Risks that commands/*.md is deliberately
  untouched to avoid that branch."
- **Correction from the user (context for Q5):** `command-receipts` "is already built
  and reviewed on origin/feature/command-receipts (not a plan — it owns ## 9.
  Execution receipts and adds a one-line §9 citation to every command file, 59 files
  touched)."

## Research

Skills consulted: none — no matching domain (the repository has no `.agents/skills/`
directory and no skills table in `AGENTS.md`).

### Lint baseline (policy §5)

Run 2026-09-13 at `origin/main` `e0bbddf`, from the planning worktree:

| Command | Exit | Findings |
|---|---|---|
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | 98 tests, 98 pass, 0 fail |
| `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` | 0 | none |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | all fixtures match |

Baseline is green; no overlap to assess. The **full gate** applies: the Builder reruns
all three commands after every step and the Reviewer reruns them at verdict time; any
new failure is a regression introduced by this branch.

### Existing enforcement (what the new tests tighten)

- `tests/customizations.test.mjs` L191–213 "active guidance qualifies Agento slash
  commands with the plugin name": regex `(?<![\w.-])/(?:<names>)\b` over `README.md`,
  `AGENTS.md`, agents, prompts, instructions, `commands/`, `docs/`, `templates/`.
  Rejects `/ship`; does **not** reject `/agento ship.prompt` (the suffix follows a
  qualified name) and does not scan `CHANGELOG.md`.
- L215–228 "plugin manifest and hook wiring point at existing executable files":
  `listFiles(rel(plugin.commands), ".md")` then `path.basename(file, ".md")` compared
  with `path.basename(promptFile, ".prompt.md")`. A stray `foo.prompt.md` in
  `commands/` would produce basename `foo.prompt` and fail the `deepEqual` only by
  accident of ordering; there is no explicit `^[a-z0-9-]+\.md$` assertion and the
  test's name does not mention the defect.
- L183–189 "every slash command is documented in README.md and docs/commands.md":
  asserts `/agento <name>` appears somewhere in each file — a natural anchor for (iii).
- L133–140 "every instruction file has a description and applyTo": generic frontmatter
  check; (iv) adds a targeted check for the new file's `applyTo: "**"` and its command
  list.
- Helper surface used by new tests: `listFiles`, `splitFrontmatter`,
  `parseFrontmatter`, `promptFiles`, `instructionFiles`, `rel` (L1–90).
- `grep -rn '\.prompt\b'` over guidance (excluding `.prompt.md` file references)
  returned no hits at baseline, and `CHANGELOG.md` has no `agento-init.prompt` entry
  today — the allowlist for `CHANGELOG.md` is forward-looking (the 0.4.0 entry this
  feature adds will quote the bad form).

### Instruction files and how they are wired

- `.github/instructions/` holds four files (`ai-skills`, `concurrent-delivery`,
  `delivery-artifacts`, `delivery-policy`). Each has `description` + `applyTo`
  frontmatter (`ai-skills` and `delivery-policy` use `applyTo: "**"`). The plugin
  manifest `plugin.json` does not enumerate instructions; the customizations test
  discovers them by directory listing, so a new file is picked up automatically.
- `docs/architecture.md` L39–47 describes the four instruction files by role; the new
  file needs one sentence there. `README.md` L62 and L408 reference the policy and
  artifact files by path but do not enumerate all instructions — no change needed
  unless the Builder finds a list.

### Docs and templates to touch

- `docs/commands.md`: `# Slash commands` table (L1–24), CLI paragraph (L26–39),
  `## The standard flow` (L40), `## The initiative flow` (L52), `## Choosing a tier`
  (L75). The new `## Invocation` section goes between the CLI paragraph and
  `## The standard flow` — `command-receipts` (PR #16) inserts `## Receipts` at
  exactly that position (L37–46 of its diff), so the Builder places `## Invocation`
  directly before `## The standard flow` and after `## Receipts` if it is already
  present.
- `templates/AGENTS-section.md` L3–7 lists the slash commands in prose; its echo is
  `commands/agento-init.md` step 4 (L40–50) — and, because `commands/*.md` are
  byte-identical copies of `.github/prompts/*.prompt.md` (test L215–228), the same
  hunk must land in `.github/prompts/agento-init.prompt.md`. This is the one command
  file this feature edits; `command-receipts` adds a §9 citation line to the same file
  in a different region (its opening), so the hunks are disjoint.
- `CHANGELOG.md`: `## 0.4.0 (unreleased)` already exists (L3) with three
  `session-state-cli` bullets; add one bullet. PR #16 adds its own bullet to the same
  section.

### Concurrent deliveries

`gh pr list --state open`: one open PR, #16 `feature/command-receipts` (draft, 59
files). Non-prompt files it changes: all six `.github/agents/*.agent.md`,
`.github/instructions/delivery-policy.instructions.md`, `AGENTS.md`, `CHANGELOG.md`,
`docs/architecture.md`, `docs/commands.md`, `tests/customizations.test.mjs`, its own
`features/2026/09/command-receipts/*`. Overlap with this plan: `CHANGELOG.md`
(additive bullets in the same `0.4.0` list), `docs/commands.md` (adjacent new
sections), `docs/architecture.md` (different bullets), `tests/customizations.test.mjs`
(#16 edits L155 `sections.size >= 9`, adds a test after L161 and five canaries at
L170–178; this plan adds tests after L213 and edits L215–228), and
`commands/agento-init.md` + its prompt twin (disjoint hunks). See `## Risks`.

## Approach

Pure customization-file change: one new instruction file, two docs edits, one template
+ its prompt/command echo, one changelog bullet, and four test assertions. No CLI,
hook, or agent behaviour changes.

1. **`.github/instructions/command-invocation.instructions.md`** (new, `applyTo:
   "**"`, `description` present). Content, kept to a few paragraphs:
   - Canonical form: `/agento <name> [args]`; the full list of `<name>` values, one
     per line, generated from `.github/prompts/*.prompt.md` (the test in step 4
     pins this list to the prompt directory so a new command cannot skip it).
   - Redirect rule: the six old forms — `/<name>`, `/<name>.prompt`, `/<name>.md`,
     `/agento <name>.prompt`, `/agento <name>.prompt.md`, `/agento <name>.md` — with
     or without trailing arguments, are typos for the canonical command. The agent
     names the canonical command in one sentence ("Reading `/ship foo` as
     `/agento ship foo`.") and proceeds with it; no confirmation, no extra question.
     Arguments carry over unchanged.
   - No legacy-name table: names are used as-is; if a command is ever renamed, that
     delivery adds its row here.
   - Guidance rule: prose in this repository writes only the canonical form; the
     customizations tests enforce it. This file is the one place allowed to quote the
     old forms.
2. **`docs/commands.md`**: new `## Invocation` section (before `## The standard flow`)
   with a table of every command's canonical spelling and one row per redirected
   form pattern, plus a one-line pointer to the instruction file. Every `/agento
   <name>` appears in this section (test (iii) anchors on the `## Invocation`
   heading and the next `## `).
3. **`templates/AGENTS-section.md`** + `.github/prompts/agento-init.prompt.md` step 4
   + `commands/agento-init.md` (byte-identical copy): one sentence after the command
   list: "Commands are always written `/agento <name>`; a bare `/<name>` or a
   `.prompt`/`.md` suffix is read as the canonical command and proceeds without
   confirmation."
4. **`tests/customizations.test.mjs`** — four assertions, added after the existing
   "active guidance qualifies…" test and by tightening the manifest test:
   - (i) `test("guidance never writes a command with a .prompt or .md suffix
     (agento-init.prompt defect)")`: regex
     `/(?:\/agento\s+|(?<![\w.-])\/)(?:<names>)\.(?:prompt\.md|prompt|md)\b/` over
     the same `guidanceFiles` list as the unqualified-command test **plus**
     `CHANGELOG.md`, with an allowlist of exactly two relative paths skipped:
     `CHANGELOG.md` and
     `.github/instructions/command-invocation.instructions.md`. (Adding
     `CHANGELOG.md` to the list and then allowlisting it makes the allowlist explicit
     and keeps the door open to scanning it later.)
   - (ii) In "plugin manifest and hook wiring…": rename to include "suffix-less
     command names" and add, per file in `listFiles(rel(plugin.commands), ".md")`,
     `assert.match(path.basename(file), /^[a-z0-9-]+\.md$/)` before the existing
     `deepEqual`. Use `fs.readdirSync` for the directory so a non-`.md` stray (e.g.
     `ship.prompt`) is also rejected.
   - (iii) In "every slash command is documented…": extract the `## Invocation`
     section of `docs/commands.md` (from that heading to the next `^## `) and assert
     it contains `/agento <name>` for every prompt.
   - (iv) `test("command-invocation instructions apply everywhere and list every
     command")`: `splitFrontmatter` + `parseFrontmatter` on the new file; assert
     `applyTo === "**"`, and assert the body contains `/agento <name>` for every
     `promptFiles` basename, and contains no `/agento <name>` for a name that is
     **not** a prompt (guards against stale entries after a command is removed).
5. **`docs/architecture.md`** L39–47: add "**command-invocation** is the canonical
   spelling and redirect rule for slash commands" to the Instructions bullet.
6. **`CHANGELOG.md`** `## 0.4.0 (unreleased)`: one bullet naming the new instruction
   file, the redirect rule, and the tests, quoting `/agento agento-init.prompt` as the
   motivating defect (this is why `CHANGELOG.md` is allowlisted in (i)).

Verification is the full gate from `## Research`: the three baseline commands after
every step; the Reviewer reruns them independently. No user-visible runtime behaviour
is served, so no `local:`/`dev-stack`/`preview:` target applies.

## Risks

- **Concurrent delivery with `feature/command-receipts` (PR #16, in-review).**
  Shared files: `CHANGELOG.md`, `docs/commands.md`, `docs/architecture.md`,
  `tests/customizations.test.mjs`, `commands/agento-init.md` +
  `.github/prompts/agento-init.prompt.md`. All hunks are additive and in different
  regions (see `## Research` → Concurrent deliveries). Mitigation: `commands/*.md`
  and `.github/prompts/*.prompt.md` are deliberately untouched **except**
  `agento-init` (user's explicit exception, Q3); no per-command citation lines are
  added. Integrate `origin/main` by merge before every push (policy §7); if #16 lands
  mid-build, resolve the additive hunks by keeping both sides — in
  `docs/commands.md` keep `## Receipts` then `## Invocation`; in the test file keep
  #16's `sections.size >= 9` and its new test plus this plan's additions; in
  `CHANGELOG.md` keep both 0.4.0 bullets.
- **Test (i) false positives on legitimate file references.** Guidance frequently
  writes `.github/prompts/ship.prompt.md` (a path) — the regex requires a leading `/`
  or `/agento ` immediately before the name, and `(?<![\w.-])` excludes path
  segments like `prompts/ship.prompt.md` because `/` there is preceded by `s`.
  Mitigation: the Builder runs the test at baseline before adding the instruction
  file and confirms zero hits, then adds the allowlist entries.
- **Test (iv) over-constraining future commands.** A new prompt file without a row in
  the instruction file fails the suite — intended; the failure message must name the
  file and the missing command so the fix is obvious.
- **Instruction size creep.** The user asked for the file to be short. Acceptance
  bounds it: canonical form, list, redirect rule, guidance rule — no restatement of
  policy text (the existing canary test guards policy phrases).

## Out of scope

- Any change to command behaviour, the CLI, hooks, or agents.
- Legacy-name mapping (nothing has been renamed; a future rename adds its row).
- Per-command citation lines in `commands/*.md` / `.github/prompts/*.prompt.md`
  (owned by `command-receipts`; `applyTo: "**"` already reaches every turn).
- Registering bare `/ship`-style commands in the plugin (not possible for a
  namespaced plugin; redirect-in-text is the agreed meaning of "alias").
- Window-validity of commands (`window-aware-commands`), receipts (`command-receipts`),
  `/agento continue` (`continue-command`).

## Acceptance checklist

- [ ] `.github/instructions/command-invocation.instructions.md` exists with
  frontmatter `description` and `applyTo: "**"`, states the canonical form
  `/agento <name> [args]`, lists every `.github/prompts/*.prompt.md` basename as
  `/agento <name>`, states the six redirected forms (with or without trailing
  arguments) and the "name the canonical command in one sentence and proceed, no
  confirmation" rule, and contains no legacy-name mapping table — verify: read the
  file; `node --test tests/customizations.test.mjs` passes test (iv).
- [ ] `docs/commands.md` has a `## Invocation` section listing every `/agento <name>`
  and the redirected-form patterns, placed before `## The standard flow` (after
  `## Receipts` when present) — verify: test (iii) passes; `grep -n '^## '
  docs/commands.md` shows the ordering.
- [ ] `templates/AGENTS-section.md`, `.github/prompts/agento-init.prompt.md` step 4,
  and `commands/agento-init.md` carry the same one-sentence canonical-form note and
  the prompt/command pair remain byte-identical — verify: `diff
  .github/prompts/agento-init.prompt.md commands/agento-init.md` is empty; the manifest
  test passes.
- [ ] `tests/customizations.test.mjs` contains a test named after the
  `agento-init.prompt` defect that rejects `\.(prompt\.md|prompt|md)\b` directly after
  `/<name>` or `/agento <name>` in every guidance file including `CHANGELOG.md`, with
  an explicit two-path allowlist (`CHANGELOG.md`,
  `.github/instructions/command-invocation.instructions.md`) — verify: the test
  passes on the branch, and temporarily inserting `/agento ship.prompt` into
  `README.md` makes it fail with the file path in the message (revert afterwards).
- [ ] The plugin manifest test asserts every entry in `plugin.json` `commands` matches
  `^[a-z0-9-]+\.md$` and is byte-identical to its prompt — verify: the test passes;
  temporarily adding `commands/zz.prompt.md` makes it fail (remove afterwards).
- [ ] Test (iv) also fails when the instruction file lists a `/agento <name>` that has
  no prompt file — verify: temporarily add `/agento nonexistent` to the instruction
  file and observe the failure (revert afterwards).
- [ ] `docs/architecture.md` Instructions bullet names the command-invocation file;
  `CHANGELOG.md` `## 0.4.0 (unreleased)` has one bullet for this feature quoting the
  `/agento agento-init.prompt` defect — verify: `grep -n 'command-invocation'
  docs/architecture.md CHANGELOG.md` shows both.
- [ ] Full gate green at the final commit: `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` exit 0 with ≥ 100 tests passing (98 baseline + 2 new tests
  (i) and (iv); (ii) and (iii) tighten existing tests and add no count — corrected by
  the Builder 2026-09-13 from the original "≥ 102", which counted all four
  assertions as new tests; count may be higher once #16 merges), `shellcheck
  scripts/hooks/*.sh scripts/wait-for-checks.sh` exit 0, `./scripts/hooks/replay-guard.sh
  < tests/guard-fixtures.txt` exit 0 — verify: rerun all three and compare with the
  `## Research` baseline (no findings either time).
- [ ] No file under `commands/` or `.github/prompts/` other than the `agento-init`
  pair is modified — verify: `git diff --stat origin/main...HEAD -- commands
  .github/prompts` lists only those two files.
- [ ] Roadmap header carries `initiative: "workflow-orchestration"` and
  `node scripts/agento.mjs initiative workflow-orchestration` reports
  `canonical-commands` with `state` equal to the roadmap `status` and no `errors` —
  verify: run the CLI.
