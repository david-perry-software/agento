# Initiative workflow: Architect agent, `/new-initiative`, `/next-feature`, initiative-aware Planner and status, docs, 0.3.0

## Problem

`initiatives-core` (shipped in PR #11, `48a954b`) gave Agento the *data layer* of the
initiative tier: the `brief.md` + `breakdown.md` contract, the `artifacts.initiatives`
config root, the optional `initiative:` roadmap header, and `agento.mjs initiative
[<slug>]`, which derives per-feature state, `blockedBy`, waves, `next`, validation
`errors`, and `anomalies` from member roadmaps. Nothing yet *produces* a breakdown or
*consumes* one: there is no agent that decomposes a brief, no command that tells the
user which member feature is ready next, the Planner cannot plan a feature as a member
(setting `initiative:` and honouring `Requires:`), `/delivery-status` does not show
initiatives, and the narrative docs, CHANGELOG, and version still describe a
two-tier (features/issues) system.

This delivery adds the **workflow layer**: a 🏛️ Agento Architect agent behind
`/new-initiative` that writes and publishes the initiative artifacts from the primary
window; a read-only `/next-feature <initiative>` that reports the dependency state and
prints the exact commands to plan the next ready member; an explicit
`initiative:<initiative-slug>/<feature-slug>` intake for the Planner that is
dependency-gated by the CLI; an `Initiative` column and initiative summary in
`/delivery-status`; a `/ship` step that stamps `(unreleased)` CHANGELOG headings with
the UTC ship date; user docs; and the `0.3.0` release entry and version bump.

## Decisions

Clarifying questions were asked in chat (the ask-questions tool was unavailable in
this session, as in the `initiatives-core` planning); answers are the user's verbatim
text.

1. **Q:** Where does the Architect run and how does it publish — (a) freehand tier in
   the primary window on a `changes/initiative-<slug>` branch merged via
   `/finish-freehand`, or (b) a managed `plan-<session-id>` worktree with a draft PR
   like the Planner? Does `/new-initiative` accept both inline text and a file path?
   **A:** "Architect: primary-window workflow, with self-contained publishing.
   `/new-initiative` runs in the primary worktree on `main`. It creates
   `changes/initiative-<slug>`, writes `initiatives/YYYY/MM/<slug>/brief.md` and
   `breakdown.md`, opens a PR, waits for checks, merges normally, deletes the branch,
   and returns to synchronized `main`. It should not require a managed planning
   worktree; initiative creation precedes individual feature planning. Accept both
   inline text and a repository-relative file path. Record the original argument or
   path in `Source:` and preserve the source text verbatim in `brief.md`. This is
   closest to option (a), but the Architect completes publishing itself rather than
   requiring a separate `/finish-freehand`."
2. **Q:** `/next-feature <initiative>` — (a) read-only report plus printed commands, or
   (b) direct Planner handoff when inside a planning worktree?
   **A:** "`/next-feature` is read-only: option (a). Run `agento.mjs initiative
   <slug>`. Report ready, blocked, complete, and anomalous members. Select the
   CLI-provided `next`. Print exact commands: [four empty bullets]. Also list other
   ready members that can be planned concurrently. Do not create worktrees or hand
   off directly. Keeping orchestration in the primary window makes the session
   boundary explicit."
   *Planner interpretation of the four empty bullets (the standard flow for one
   member):* `/start-session` (primary) → `/new-feature
   initiative:<initiative-slug>/<feature-slug>` (new window) → **Build in this
   worktree** handoff or `/build-feature <feature-slug>` → `/review-feature
   <feature-slug>`, then `/close-session feature/<feature-slug>` and `/ship
   <feature-slug>` from the primary window.
3. **Q:** Planner initiative intake — refuse or warn when `Requires:` are not all
   `status: complete`? Auto-attach a plain `/new-feature` whose slug matches a member,
   or only via `/next-feature` / an explicit argument?
   **A:** "Planner intake is explicit and dependency-gated. Only attach through
   `initiative:<initiative-slug>/<feature-slug>`. Do not auto-attach a plain
   `/new-feature` based on slug coincidence. Validate the initiative and member
   through `agento.mjs initiative <initiative-slug>`. Hard-stop unless every
   `Requires:` member has `status: complete`; do not offer an override in v1. Use
   `Brief:` as the description baseline, with `Summary:` as context. Use the
   preassigned feature slug. Write `initiative: "<initiative-slug>"` in the roadmap
   header and link the breakdown from `plan.md`. Reject missing, invalid, blocked,
   already-planned, or mismatched members with the CLI's precise diagnostics."
4. **Q:** Status integration — (a) extend only the `/delivery-status` prompt, or (b)
   also embed an `initiatives` array in `agento.mjs status`? `session-context.sh`
   untouched?
   **A:** "Status integration: option (a) only. Extend `/delivery-status` with an
   `Initiative` column for deliveries and a separate initiative summary from
   `agento.mjs initiative`. Leave `agento.mjs status` unchanged beyond its existing
   per-item `initiative` field. Keep `session-context.sh` untouched."
5. **Q:** Release mechanics — `## 0.3.0 (unreleased)` stamped at ship, or dated by
   the Builder with possible drift? Refresh `examples/soshiki-profile.md`?
   **A:** "Release mechanics: use `unreleased`, stamped by `/ship`. Builder sets both
   manifests to `0.3.0`. Builder adds `## 0.3.0 (unreleased)` to `CHANGELOG.md`.
   Extend `/ship` so its final status commit replaces `(unreleased)` with the current
   UTC ship date when the delivery changes the plugin version. This must happen
   immediately before checks and merge, in the same commit as `status: complete`, not
   as a manual step. Update the prompt's final restriction to explicitly permit that
   changelog stamp. If shipping resumes on a later date after failed checks, refresh
   the date before the successful merge. Refresh `soshiki-profile.md` to mention
   `initiatives/` alongside `features` and `issues`."

Inherited from `initiatives-core` Decision 5 (recorded there for this plan): confirm
`0.3.0`, update both `plugin.json` and `package.json`, date the CHANGELOG entry with
the actual ship date — satisfied here by Decision 5's `(unreleased)` + `/ship` stamp.

## Research

Skills consulted: none — no matching domain (this repository's AGENTS.md has no
`## Agento` skills table and no `.agents/skills/` directory exists; confirmed by the
Explore subagent and `list_dir`).

**Lint baseline (policy §5)** — run from the planning worktree at `48a954b`
(`origin/main`), 2026-09-05:

| Command | Exit | Findings |
|---|---|---|
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | 69 tests, 69 pass, 0 fail |
| `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` | 0 | 0 findings (`command -v shellcheck` → `/home/david/.local/bin/shellcheck`) |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | all fixtures match expected verdicts |

Baseline is green; nothing overlaps. This plan touches no shell files or hooks, but a
**full gate** applies (not scoped): all three commands must pass at the end of the
build with zero new findings, compared against this table.

**Concurrent deliveries:** `gh pr list --state open --json number,headRefName,isDraft`
returned `[]`; no open delivery branches, no file overlap to sequence around.

**Slug reservation:** `node scripts/agento.mjs find initiative-workflow` →
`status: missing` (exit 3); `git branch --list feature/initiative-workflow` and
`git ls-remote --heads origin feature/initiative-workflow` both empty.

**Codebase findings (file:line evidence):**

- Agent frontmatter pattern —
  [.github/agents/delivery-planner.agent.md](../../../../.github/agents/delivery-planner.agent.md)
  L1–14: `name` (emoji + text), `description` starting `Use when:`, `argument-hint`,
  `tools`, `agents: ["Explore"]`, `user-invocable`, `disable-model-invocation`,
  `handoffs[]` with `label`/`agent`/`prompt`/`send`. Its Procedure (L30–108) has
  eight steps; step 4 (L64–75) derives the slug and reserves the branch; step 6
  (L86–99) writes the artifacts and names the initial roadmap header fields; the
  `## Scope of edits` (L24–28) restricts writes to `features/` and `issues/`.
- Prompt frontmatter pattern —
  [.github/prompts/new-feature.prompt.md](../../../../.github/prompts/new-feature.prompt.md)
  (`description`, `argument-hint`, `agent: "📋 Agento Planner"`, no `name:`);
  [.github/prompts/delivery-status.prompt.md](../../../../.github/prompts/delivery-status.prompt.md)
  L1–6 (`agent: "agent"`, `tools: [read, search, execute]`), body L8–20 (four steps:
  CLI `status`, `gh pr list` cross-reference, one table, anomalies).
- Primary-window publish pattern to reuse for the Architect —
  [.github/prompts/quick-fix.prompt.md](../../../../.github/prompts/quick-fix.prompt.md)
  steps 1–2 (require primary worktree on `main`, clean, zero ahead/behind; `git switch
  -c changes/<slug>`), steps 7–9 (push with upstream, PR, `scripts/wait-for-checks.sh
  pr <n>` bounded poll, normal merge through the ruleset, delete branch, sync `main`),
  and the "Read the default branch and freehand prefix from `agento.mjs config`
  (`branches.default`, `branches.freehand`)" paragraph.
- Ship prompt —
  [.github/prompts/ship.prompt.md](../../../../.github/prompts/ship.prompt.md)
  step 3 first bullet ("Set roadmap `status: complete` … commit and push"), second
  bullet (mark ready, `wait-for-checks.sh pr <n>`), and the final paragraph ("Never
  … create additional content commits beyond the roadmap status commit, a
  ruleset-required integration merge of `origin/main`, and the single post-ship
  evidence commit from step 5") — this restriction must be widened for the stamp.
- CLI output consumed by the new prompts —
  [scripts/agento.mjs](../../../../scripts/agento.mjs): `initiative` case
  (L402–424); single-slug shape `{ status: ok|invalid|missing, errors[], initiative
  {slug, dir, breakdown, created, lastUpdated}, features[{ slug, state, roadmap,
  branch, requires, recommendedAfter, wave, computedWave, order, blockedBy, ready }],
  waves, next, done, anomalies[{ slug, kind, branch }] }`; list shape `{ status,
  initiativesRoot, items[{ slug, dir, created, lastUpdated, total, complete,
  inFlight, ready, done, valid }] }`; `status` items already carry `initiative`
  (`describe()` L129); exit 3 for `invalid`/`missing`. `find <slug>` (L310–318)
  returns `status: missing` for an unused member slug — the Architect uses it to
  guarantee member slugs are free.
- Guard — [scripts/hooks/delivery-guard.sh](../../../../scripts/hooks/delivery-guard.sh)
  L339–342: the roadmap nudge fires only for `feature/`/`issue/` prefixed branches,
  so committing `initiatives/**` on `changes/initiative-<slug>` is not nudged; L236
  hard-codes the two roots for its own purposes only. No hook change needed
  (Decision 4).
- Tests that the new files must satisfy —
  [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs): agents
  need unique `name`, `description` matching `/Use when/`, non-empty `tools`, `agent`
  tool when `agents:` present, `knownSubagents` = agent names + `Explore` (L95);
  prompts need `description`, no `name:`, `agent` either `"agent"` or an existing
  agent name, non-empty body; relative links must resolve; `§N` must exist in the
  policy; canary phrases only in the policy file; every `/<prompt-stem>` must appear
  in README.md and docs/commands.md (L183–189); plugin.json and package.json
  versions must match (L198). Agents and prompts are registered by directory in
  [plugin.json](../../../../plugin.json) (`"agents": ".github/agents"`,
  `"commands": ".github/prompts"`), so no manifest list changes.
- Docs touchpoints — [README.md](../../../../README.md): Contents L21–36; "How it
  works" five ideas L40–71 (idea 2 lists the five agents); "The full delivery flow"
  L163–289 with `### Any time` L274; Command reference table L306–326; Delivery
  artifacts tree L329–351; intro L16–17 says "two artifact directories".
  [docs/commands.md](../../../../docs/commands.md): command table L3–21, CLI
  paragraph L23–33 (already documents `initiative`), standard flow L35–45, tier table
  L47–53. [docs/architecture.md](../../../../docs/architecture.md): mermaid L3–24
  (no Architect node), Pieces → Agents bullet L28–30, configuration table L60–66.
  [docs/artifacts.md](../../../../docs/artifacts.md) L5–6 and L14–15 already describe
  `brief.md`/`breakdown.md` with author "initiative intake" — to become the Architect.
  [docs/concurrency.md](../../../../docs/concurrency.md) sections Worktrees /
  Verification / Merge-conflict recipes — no initiative mention.
- Templates and examples —
  [templates/AGENTS-section.md](../../../../templates/AGENTS-section.md) L3–6 lists
  the slash commands (no `/new-initiative`, `/next-feature`) and already lists the
  `initiatives/` path; [.github/prompts/agento-init.prompt.md](../../../../.github/prompts/agento-init.prompt.md)
  L49–51 embeds the same sentence and must stay in sync;
  [examples/soshiki-profile.md](../../../../examples/soshiki-profile.md) L12 lists
  only `features/` and `issues/`.
- Versions — [plugin.json](../../../../plugin.json) and
  [package.json](../../../../package.json) both `0.2.0`;
  [CHANGELOG.md](../../../../CHANGELOG.md) L3 `## 0.2.0 (2026-09-05)` (heading
  format `## <version> (<date>)`, bold-lead bullets).
- Policy §8 handoff wording that the Architect and `/next-feature` must not
  contradict: [delivery-policy.instructions.md](../../../../.github/instructions/delivery-policy.instructions.md)
  `## 8. Cross-window handoff` — build/review in the secondary window, close/ship in
  the primary; "Never substitute raw git or worktree commands for these workflow
  commands."

## Approach

All changes are Markdown customization files plus the two manifests and the
CHANGELOG; no script, hook, or test-fixture code changes. `main` and `changes/` below
mean the configured `branches.default` / `branches.freehand`.

**1. 🏛️ Agento Architect** (`.github/agents/initiative-architect.agent.md`, new).
Frontmatter: `name: "🏛️ Agento Architect"`, `description: "Use when: turning a large
brief into an initiative — …"`, `argument-hint`, `tools: [read, search, edit,
execute, agent]`, `agents: ["Explore"]`, `user-invocable: true`, no `handoffs`
(Decision 2: orchestration stays explicit). Body: follows AGENTS.md, ai-skills,
delivery-artifacts, delivery-policy (cite `§1`, `§6`, `§7`). Scope of edits: only
`initiatives/YYYY/MM/<slug>/`. Procedure:

1. *Require the primary worktree on `main`, clean, synchronized* (`git worktree list
   --porcelain`, `git fetch origin`, `git status --short --branch` zero
   ahead/behind) — the quick-fix precondition, not the Planner's isolation.
2. *Read the brief*: the argument is either inline text or a repository-relative
   path to an existing file (exactly one; a path that does not exist is treated as
   inline text only if it contains whitespace, otherwise stop and ask). Keep the
   text byte-for-byte for `brief.md`.
3. *Clarify* 3–5 questions (scope, must-ship-first, size, constraints); retain
   answers verbatim for `breakdown.md ## Decisions`.
4. *Research* with the Explore subagent; load matching skills per the project's
   skills table.
5. *Name and reserve*: kebab-case initiative slug; `agento.mjs initiative <slug>`
   must return `status: missing`; no `initiatives/**/<slug>/` directory may exist
   locally or on `origin/main`; branch `changes/initiative-<slug>` must not exist
   locally or on origin; `git switch -c changes/initiative-<slug>`.
6. *Decompose* into 2–8 independently shippable features, each slug checked free
   with `agento.mjs find <feature-slug>` (`status: missing`) and unique in the file;
   write `brief.md` (`Source: <argument|file path> — <YYYY-MM-DD>`, blank line,
   verbatim text) and `breakdown.md` per the contract (yaml header; Title, Goal,
   Decisions, Research with `Skills consulted:`, Features blocks with all seven
   bullets, Recommended order with waves and an optional mermaid graph, Risks, Out
   of scope, Definition of done; **no checkboxes**).
7. *Validate*: `agento.mjs initiative <slug>` returns `status: ok`, every member
   `state: unplanned`, `errors` absent/empty, and `next` equals the intended first
   feature; fix the breakdown until it does.
8. *Publish*: one Conventional Commit (`docs(initiative): add <slug> breakdown`),
   push with upstream, open a PR to `main` whose body summarizes the features and
   waves, `scripts/wait-for-checks.sh pr <n>` bounded poll (exit 2 → rerun), merge
   with a normal merge commit through the ruleset, delete the branch, switch to
   `main`, fetch, fast-forward, confirm clean tree with zero ahead/behind. If `main`
   advanced, merge `origin/main` into the branch (never rebase) and wait again.
9. *Report*: slug, PR number, features by wave, `next`, and the exact follow-up
   `/next-feature <slug>`.

Non-negotiables: never edit `features/`, `issues/`, or source; never commit to
`main`; never force-push/rebase/amend; never print secrets.

**2. `/new-initiative`** (`.github/prompts/new-initiative.prompt.md`, new):
`agent: "🏛️ Agento Architect"`, `argument-hint: "Brief text, or a repository-relative
path to a file containing it"`. Body restates the procedure headline, the authorized
actions (create/delete the `changes/initiative-<slug>` branch, commit, push, open and
merge the PR, sync `main`), and "If the argument is empty, ask for the brief and stop."

**3. `/next-feature`** (`.github/prompts/next-feature.prompt.md`, new):
`agent: "agent"`, `tools: [read, search, execute]`, `argument-hint: "<initiative-slug>"`.
Read-only. Steps: (1) run `agento.mjs initiative <slug>`; on `missing` or `invalid`
print the CLI `message`/`errors` verbatim and stop; (2) present members grouped as
ready / blocked (with `blockedBy`) / in flight (`planned|in-progress|paused|in-review`)
/ complete, and `anomalies` verbatim; (3) if `next` is `null`: `done: true` → say the
initiative is delivered; otherwise name the in-flight members that must ship first;
(4) otherwise print the exact commands from Decision 2's interpretation with the
slugs substituted, and list the other `ready` members as plannable concurrently
(each with its own `/start-session` → `/new-feature initiative:<i>/<f>`). Never
create worktrees, branches, or files.

**4. Planner initiative intake** (`.github/agents/delivery-planner.agent.md` and
`.github/prompts/new-feature.prompt.md`): a new Procedure step between "Clarify" and
"Research" — *Initiative intake (explicit only)*: when the argument matches
`initiative:<initiative-slug>/<feature-slug>`, run `agento.mjs initiative
<initiative-slug>`; stop on `missing`/`invalid` with the CLI diagnostics; stop if
`<feature-slug>` is not a member, if its `state` is not `unplanned` (already planned
— name the existing roadmap), or if `ready` is false (list `blockedBy`; no override);
otherwise use the block's `Brief:` as the description baseline and `Summary:` as
context, keep the preassigned feature slug in step 4, add `initiative:
"<initiative-slug>"` to the roadmap header in step 6, and link the breakdown file from
plan.md `## Problem`. A plain `/new-feature` never attaches by slug coincidence. The
new-feature prompt documents the argument form and the hard stops in one paragraph.

**5. `/delivery-status`** (`.github/prompts/delivery-status.prompt.md`): step 1 also
reads `initiative` from the items; step 3's table gains an `Initiative` column
(`—` when null); a new step runs `agento.mjs initiative` (list mode) and, for each
`valid` item, `agento.mjs initiative <slug>` to obtain `next` and `anomalies`, then
prints a second table (slug, complete/total, in flight, ready, next, done) with the
recommended command `/next-feature <slug>`; `valid: false` items and `anomalies` join
the anomaly list in step 4. Still read-only.

**6. `/ship` changelog stamp** (`.github/prompts/ship.prompt.md`): step 3's first
bullet becomes: set `status: complete`; **if the branch changes the plugin version**
(`git diff origin/main...HEAD -- plugin.json package.json` touches `"version"`) and
`CHANGELOG.md` has a heading `## <version> (unreleased)`, replace `(unreleased)` with
`(<UTC date from date -u +%Y-%m-%d>)` in the same commit; commit and push. Add: if
the merge is later resumed on a different UTC date (checks failed and were fixed), the
stamped date is refreshed in one more commit before the successful merge. The final
restriction paragraph explicitly permits "the changelog date stamp (and its refresh
on a later ship date)". Also mention the stamp in the step 1 audit output when
`(unreleased)` is present but the version is unchanged (report as a gap, not
stamped).

**7. Docs.** README: intro ("two artifact directories" → three), Contents, idea 2
adds 🏛️ Architect, a new `### Initiatives — several features from one brief` block
in "The full delivery flow" (before `### Any time`) showing `/new-initiative` →
`/next-feature` → the per-member flow, Command reference rows for `/new-initiative`
(primary, 🏛️ Architect) and `/next-feature` (any, default), Delivery artifacts gains
the `initiatives/2026/09/<slug>/ ├── brief.md └── breakdown.md` tree and a sentence on
derived progress. docs/commands.md: two table rows; an "Initiative flow" text block
after the standard flow; tier table row "A brief too large for one feature →
`/new-initiative` then `/next-feature`". docs/architecture.md: mermaid gains
`U -->|"/new-initiative"| A[🏛️ Agento Architect]` → `A -->|brief.md + breakdown.md,
merged PR| INIT[(initiatives/)]` → `U -->|"/next-feature"| INIT` → `P`; Pieces →
Agents bullet lists the Architect; the Scripts bullet mentions the initiative
deriver. docs/artifacts.md: author column "🏛️ Architect" for brief/breakdown and a
"Key rules" line on the `initiative:<i>/<f>` intake. docs/concurrency.md Worktrees
section: one paragraph that ready members of the same wave may be planned/built
concurrently, each in its own session. templates/AGENTS-section.md L3–6 and
agento-init.prompt.md L49–51 add `/new-initiative`, `/next-feature` to the command
list (keep the two in sync); examples/soshiki-profile.md L12 adds
`initiatives/YYYY/MM/<slug>/`.

**8. Release.** `plugin.json` and `package.json` → `0.3.0`; CHANGELOG top entry
`## 0.3.0 (unreleased)` with bold-lead bullets: Architect + `/new-initiative`,
`/next-feature`, Planner `initiative:` intake, `/delivery-status` initiatives,
`/ship` changelog stamp, and (from `initiatives-core`, unreleased so far) the
`initiatives/` artifact contract, `artifacts.initiatives` root, `initiative:` roadmap
header, and `agento.mjs initiative`.

**Verification target:** everything is customization text and CLI-level; `local`
runs of the node test suite plus temp-repo rehearsals of the exact CLI commands the
new agent/prompts prescribe. No served UI, no preview.

## Risks

- **Bootstrapping the `/ship` stamp on this very feature.** In workspace mode the
  primary window loads `ship.prompt.md` from `main`, which will not contain the stamp
  step until this PR merges; the first real use of the stamp is shipping
  `initiative-workflow` itself. Mitigation: roadmap step 7.2 records the exact stamp
  instruction on the roadmap line so the ship operator applies it in the
  `status: complete` commit even with the old prompt loaded; a Follow-up in the
  roadmap notes that later releases are covered automatically.
- **Architect merges to `main` from the primary window.** A mis-scoped decomposition
  is published without a review stage. Mitigation: validation step 7 (`status: ok`,
  all members `unplanned`, `next` as intended) is a hard gate before commit; the
  breakdown is small Markdown and freehand-editable afterwards (`/quick-fix` or
  `/start-freehand`), and progress is never stored in it.
- **`initiative:<i>/<f>` argument parsing.** The Planner must not mistake a
  description that merely starts with "initiative" for the intake form. Mitigation:
  the pattern is anchored (`^initiative:[a-z0-9-]+/[a-z0-9-]+$`, whole argument);
  anything else is a plain description.
- **Customization-test invariants.** A new agent/prompt fails the suite if it lacks
  `Use when`, references a missing `§N`, repeats a canary phrase, or is not listed in
  both README.md and docs/commands.md. Mitigation: every roadmap step that adds a
  file has `node --test tests/customizations.test.mjs` in its `verify:`.
- **No live Architect run inside this repository.** Running `/new-initiative` here
  would merge disposable initiative artifacts into `main` (rejected in
  `initiatives-core` Decision 2). Mitigation: step 1.3 rehearses the Architect's CLI
  commands in a temp repo (breakdown hand-written per the agent's procedure) and
  saves outputs under `evidence/`; the agent text is otherwise verified structurally.
- **Docs drift between `templates/AGENTS-section.md` and `agento-init.prompt.md`.**
  Mitigation: step 5.3 greps both for the two new commands.
- **Concurrent delivery.** No open PRs today. Mitigation regardless: integrate
  `origin/main` before every push (concurrent-delivery.instructions.md).

## Out of scope

- Changes to `scripts/agento.mjs`, `scripts/agento-config.mjs`, any hook
  (`delivery-guard.sh`, `session-context.sh`, `replay-guard.sh`), `hooks.json`, or
  `tests/guard-fixtures.txt` (Decision 4).
- A Planner override for blocked members, auto-attaching by slug coincidence, or a
  direct `/next-feature` → Planner handoff (Decisions 2–3, v1).
- Re-decomposing or editing an existing initiative through an agent (freehand edits).
- Making `find`, `resolve`, `close-decision`, `ship-preflight`, or `start-session`
  initiative-aware; GitHub milestones/projects per initiative.
- Attaching this feature or `initiatives-core` retroactively to an initiative (no
  breakdown exists for them).
- Dispatching a release workflow (this repository configures none).

## Acceptance checklist

- [ ] `.github/agents/initiative-architect.agent.md` exists with `name: "🏛️ Agento
  Architect"`, a `Use when:` description, `tools` including `agent` with
  `agents: ["Explore"]`, no `handoffs`, and a Procedure covering: primary-worktree
  precondition, inline-or-file brief with verbatim `brief.md` and `Source:` line,
  clarification, slug/branch reservation via `agento.mjs initiative <slug>` →
  `missing` and `agento.mjs find <feature-slug>` → `missing` per member,
  `changes/initiative-<slug>` branch, `agento.mjs initiative <slug>` → `ok` validation
  before commit, PR + `wait-for-checks.sh` + normal merge + branch delete + `main`
  sync, and a `/next-feature <slug>` closing suggestion; verify:
  `grep -c 'agento.mjs initiative\|agento.mjs find\|wait-for-checks.sh\|/next-feature\|Source:' .github/agents/initiative-architect.agent.md` ≥ 5 and `node --test tests/customizations.test.mjs` exits 0.
- [ ] `.github/prompts/new-initiative.prompt.md` dispatches to `🏛️ Agento Architect`,
  has an `argument-hint` naming both inline text and a file path, authorizes the
  branch/PR/merge actions, and stops on an empty argument; verify: frontmatter grep
  + `node --test tests/customizations.test.mjs`.
- [ ] `.github/prompts/next-feature.prompt.md` is read-only (`agent: "agent"`,
  `tools: [read, search, execute]`), runs `agento.mjs initiative <slug>`, reports
  ready/blocked/in-flight/complete members and `anomalies`, prints the four commands
  with slugs substituted (`/start-session`, `/new-feature
  initiative:<i>/<f>`, build handoff or `/build-feature <f>`, `/review-feature <f>`
  then `/close-session feature/<f>` + `/ship <f>`), lists other ready members, and
  handles `next: null` (`done` vs in-flight); verify: `grep -c 'initiative:<\|/start-session\|/build-feature\|/review-feature\|/ship\|blockedBy\|anomalies' .github/prompts/next-feature.prompt.md` ≥ 7 and the customization test passes.
- [ ] `delivery-planner.agent.md` has an explicit initiative-intake step that is
  triggered only by the whole-argument form `initiative:<initiative-slug>/<feature-slug>`,
  validates via `agento.mjs initiative`, hard-stops on `missing`/`invalid`/non-member/
  not-`unplanned`/not-`ready` with the CLI diagnostics and offers no override, uses
  `Brief:` + `Summary:`, keeps the preassigned slug, writes `initiative:
  "<initiative-slug>"` in the roadmap header, and links the breakdown from plan.md;
  `new-feature.prompt.md` documents the argument form; verify: `grep -c 'initiative:' .github/agents/delivery-planner.agent.md` ≥ 3, `grep -c 'initiative:' .github/prompts/new-feature.prompt.md` ≥ 1, customization test passes.
- [ ] `delivery-status.prompt.md` adds an `Initiative` column, a second table from
  `agento.mjs initiative` (list mode + per-initiative `next`/`anomalies`), recommends
  `/next-feature <slug>`, and remains read-only; verify: `grep -c 'agento.mjs initiative\|/next-feature\|Initiative' .github/prompts/delivery-status.prompt.md` ≥ 3.
- [ ] `ship.prompt.md` step 3 stamps `## <version> (unreleased)` with the UTC date
  (`date -u +%Y-%m-%d`) in the same commit as `status: complete` when the branch
  changes the plugin version, refreshes it on a later-date resume, and the final
  restriction paragraph permits exactly that stamp; verify: `grep -c 'unreleased' .github/prompts/ship.prompt.md` ≥ 3 and `grep -c 'date -u' .github/prompts/ship.prompt.md` ≥ 1.
- [ ] README.md and docs/commands.md list `/new-initiative` and `/next-feature`
  (command tables + flow text); docs/architecture.md mermaid and Pieces mention the
  Architect; docs/artifacts.md credits the Architect for `brief.md`/`breakdown.md`;
  docs/concurrency.md mentions concurrent planning of same-wave members;
  templates/AGENTS-section.md, agento-init.prompt.md L49–51, and
  examples/soshiki-profile.md are updated; verify:
  `grep -l '/new-initiative' README.md docs/commands.md templates/AGENTS-section.md .github/prompts/agento-init.prompt.md` lists all four, `grep -c Architect docs/architecture.md docs/artifacts.md` ≥ 1 each, `grep -c initiatives examples/soshiki-profile.md docs/concurrency.md` ≥ 1 each, and `node --test tests/customizations.test.mjs` exits 0.
- [ ] `plugin.json` and `package.json` both read `"version": "0.3.0"` and
  CHANGELOG.md's first heading is `## 0.3.0 (unreleased)` with bullets covering the
  Architect/`/new-initiative`, `/next-feature`, Planner intake, `/delivery-status`,
  `/ship` stamp, and the `initiatives-core` CLI/contract; verify: `node -e 'const p=require("./plugin.json"),k=require("./package.json");if(p.version!=="0.3.0"||k.version!=="0.3.0")process.exit(1)'` exits 0 and `sed -n '3p' CHANGELOG.md` prints `## 0.3.0 (unreleased)`.
- [ ] Temp-repo rehearsal evidence exists at `evidence/step-1-3-architect-rehearsal.md`
  (Architect CLI commands: `initiative <slug>` → `missing`, `find <member>` →
  `missing`, then `initiative <slug>` → `ok` with all `unplanned` and the intended
  `next`) and `evidence/step-4-3-ship-stamp.md` (stamp applied to a temp CHANGELOG
  copy, heading shows the UTC date); verify: both files exist and contain the quoted
  outputs.
- [ ] Full lint gate (policy §5, full): `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` exit 0 with ≥ 69 passing; `shellcheck scripts/hooks/*.sh
  scripts/wait-for-checks.sh` exit 0; `./scripts/hooks/replay-guard.sh <
  tests/guard-fixtures.txt` exit 0; no findings beyond the recorded baseline.
- [ ] No files under `scripts/`, `.github/hooks/`, `hooks.json`, or
  `tests/guard-fixtures.txt` are modified; verify: `git diff --name-only
  origin/main...HEAD` excludes them.
