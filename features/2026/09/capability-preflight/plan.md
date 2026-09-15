# Capability preflight: `agento.mjs doctor` and per-command Needs/Fallback declarations

## Problem

Agento commands discover missing capabilities only after they have started. The
initiative brief records four incidents: the `vscode_askQuestions` tool was
unavailable when a Planner reached its clarifying step; Plan mode could not execute
`/agento start-session` because that chat mode has no terminal; destructive steps
stalled on a manual terminal confirmation nobody expected; and `/agento ship` stopped
at a confirmation gate with no streamlined repair path. Policy §1 already says "check
a CLI with `command -v` before invoking it", but there is no single place that does
so, and no prompt says which chat tools it needs or what to do when one is absent.

This feature is the `capability-preflight` member of the
[workflow-orchestration](../../../../initiatives/2026/09/workflow-orchestration/breakdown.md)
initiative (`### capability-preflight`; Wave 2, Size M; requires `command-receipts`,
complete). Its brief: "Some workflows discovered too late that `vscode_askQuestions`
was unavailable; Plan mode could not execute `/start-session`; destructive steps
required manual terminal confirmation; shipping stopped at a confirmation gate without
a streamlined repair path. … Commands should preflight required capabilities before
starting and declare the fallback immediately." The initiative decision fixes the
form: a CLI `doctor` subcommand plus per-command tool declarations with an explicit
fallback.

User-visible effect: every command states, in its first lines, which capabilities it
needs and what happens when one is missing; a hard requirement that is absent produces
a `rejected` receipt naming the fallback instead of a half-started command; and
`/agento doctor` (or `node <agento-root>/scripts/agento.mjs doctor`) reports the
environment's readiness in one JSON document.

## Decisions

- **Q: Which checks should `agento.mjs doctor` run? (breakdown proposes: git remote
  reachable, gh auth, code CLI, python3, Node ≥ 20, worktrees.dir writable)** A: All
  six from the breakdown.
- **Q: When should prompts run `doctor`? Running it on every command adds a network
  call (gh auth, git remote).** A: Only commands that need gh/code/network — new-*,
  ship, quick-fix, finish-freehand, start-session, etc. run `doctor --for <command>`;
  read-only commands skip it.
- **Q: Where should each command's `Needs:` / `Fallback:` declarations live?** A: Body
  lines right after the frontmatter in each prompt — visible to the model;
  customizations test asserts every prompt has both lines and only known capability
  names.
- **Q: How should a failed preflight appear in the §9 receipt?** A: Hard requirement
  missing → `Receipt: rejected — <capability>: <reason>; fallback: <...>`; soft →
  accepted + one `Preflight:` line.
- **Q: Should this feature also add a user-facing `/agento doctor` prompt
  (commands/doctor.md) alongside the CLI subcommand?** A: Yes, add the prompt too —
  listed in README/docs/commands, canonical-commands list, templates/AGENTS-section.

Inherited from the initiative's `## Decisions` (breakdown.md): "CLI `doctor` +
per-command tool declarations — new `agento.mjs doctor` checks gh auth, code CLI, git
remote, python3, node version; prompts also declare which chat tools they need and
their fallback (e.g. ask-questions unavailable → numbered questions in chat)."

## Research

Skills consulted: none — no matching domain (no `.agents/skills/` directory —
verified `ls -d .agents/skills` → absent — and AGENTS.md has no `## Agento` skills
table).

- **CLI dispatch and usage header.** `scripts/agento.mjs` L1–18 is the usage comment
  that `usage()` (L35–38) slices with `.slice(1, 18)` and prints on any usage error;
  a new subcommand line must be added there and the slice widened. Subcommands are a
  `switch (command)` (L~320–460) ending in `default: usage(...)`. `parseArgs()`
  (L51–61) accepts only `--root` and `--pr`; `--for <command>` needs a new branch
  there. `emit()` prints one JSON document and exits; `withExit()` maps
  `status !== "ok"` to exit 3. Existing tool probes: `lookupPullRequest()` (L152–170)
  runs `execFileSync("gh", ["--version"])` in try/catch and converts every failure to
  a `warnings[]` string with a 15 s timeout — the pattern `doctor` reuses per check.
  Config: `loadAgentoConfig(root)` (agento-config.mjs) supplies `worktrees.dir`
  (resolved to `worktreesDir` at L~70; the `session` case resolves it against the
  primary worktree, L~440–446, which `doctor` must copy so a secondary worktree checks
  the right directory).
- **Test harness.** `scripts/agento.test.mjs` has `makeRepo()` (temp clone with a bare
  origin), `run()`/`runWith({cwd, env})` (spawn the CLI, parse JSON), and
  `restrictedPath(extra)` (L73–80): a PATH holding only `node` and `git` symlinks plus
  optional stub executables written from strings — exactly the PATH manipulation the
  breakdown asks for. Existing tests stub `gh` with shell scripts that branch on
  `"$1" = "--version"` (L~290–330). The "usage errors exit 1" test asserts the usage
  text contains `session [--pr]` and will need `doctor` added the same way.
- **Customizations test.** `tests/customizations.test.mjs`: `promptFiles` /
  `agentFiles` / `instructionFiles` enumerations; `splitFrontmatter(file).body`
  (L22–27); "every command and agent opens and closes with the §9 receipt" (L163–169)
  is the model for a new "every command declares Needs: and Fallback:" test; the
  canary test (L171–193) lists `Receipt:`/`Result:` phrases that may appear only in
  the policy file — the new `Preflight:` line format and the `rejected — …;
  fallback:` wording must be added there once §9 (or a new §10) defines them;
  "every slash command is documented in README.md and docs/commands.md" (L195–207)
  requires a new `/agento doctor` prompt to appear in README.md, docs/commands.md,
  and its `## Invocation` list; "command-invocation instructions apply everywhere and
  list every command" (L243–259) requires `/agento doctor` in
  `command-invocation.instructions.md`; "plugin manifest…" (L262–307) requires
  `commands/doctor.md` byte-identical to `.github/prompts/doctor.prompt.md`.
- **Policy touchpoints.** `delivery-policy.instructions.md` §1 L29–31 ("Before
  invoking a CLI not yet proven in this session, check it with `command -v` …") is
  the sentence `doctor` replaces as the canonical presence check. §9 defines
  `Receipt: rejected — <reason>; allowed: <cmd>…` and says alternatives come from
  `agento.mjs session`; the decision adds a preflight rejection form
  (`Receipt: rejected — <capability>: <reason>; fallback: <…>`) and a soft
  `Preflight:` line, which belong in §9 (single source of receipt spellings) plus a
  new `## 10. Capability preflight` section holding the capability vocabulary and
  the `Needs:`/`Fallback:` contract. The frontmatter `description` enumerates the
  sections and must be extended. `sections.size >= 9` in the customizations test
  becomes `>= 10`.
- **Prompts already carrying ad-hoc fallbacks** (to be aligned with the declaration,
  not duplicated): `start-session.prompt.md` L35–40 and `start-freehand.prompt.md`
  L54–58 ("If the `code` CLI is unavailable or opening fails, keep the worktree and
  report the manual open command"); `agento-init.prompt.md` L47, L106 and
  `install-skills.prompt.md` L40 name `vscode/askQuestions` with no fallback;
  `delivery-planner.agent.md` L54 and `initiative-architect.agent.md` L54 say "the
  ask-questions tool" with no fallback; `start-session.prompt.md` L20/L42 uses "plan
  mode" for the Agento *worktree* mode — the prompt text must distinguish the chat
  execution mode from Agento's plan mode when it declares terminal as a need.
- **Command inventory (22 prompts) and their needs**, from reading each prompt's
  steps: terminal + `gh` + network — `new-feature`, `new-issue`, `new-initiative`,
  `build-feature`, `build-issue`, `review-feature`, `review-issue`, `ap`, `ship`,
  `quick-fix`, `finish-freehand`, `commit-current-changes`, `triage-followups`,
  `agento-init`; terminal + `code` — `start-session`, `start-freehand`; terminal
  only — `close-session`, `delivery-status`, `next-feature`, `extend-copilot`,
  `fix-copilot`; ask-questions (soft, with the numbered-questions fallback) —
  `new-feature`, `new-issue`, `new-initiative`, `agento-init`, `install-skills`
  (+ `npx`/network); browser (soft) — `build-*`, `review-*`, `ap` when a roadmap
  step names a `local:`/`preview:` target. Per Decision 2, `doctor --for` runs in
  the 16 commands that need `gh`, `code`, or the network; the terminal-only five and
  `install-skills` (network via `npx`, but no `gh`) skip it — `install-skills`
  declares `network` and probes `npx` itself as today.
- **Docs listing the CLI subcommands** (must gain `doctor`): `docs/commands.md`
  L25–37 (subcommand paragraph), `AGENTS.md` L15–17 (scripts bullet). Command
  tables (must gain `/agento doctor`): `README.md` "Command reference" L353–374,
  `docs/commands.md` table L3–24 and `## Invocation` list L39–61,
  `templates/AGENTS-section.md` L3–6 and its echo in `agento-init.prompt.md`
  step 4 (L50–53). `docs/architecture.md` summarises the policy sections;
  `CHANGELOG.md` has `## 0.4.0 (unreleased)` (L3) — no version bump.
- **Hook.** `scripts/hooks/session-context.sh` prints `Session:` from `agento.mjs
  session`; extending it to run `doctor` would add network latency to every session
  start and is approval-gated. Out of scope (see below); prompts call `doctor`
  themselves.
- **Lint baseline (policy §5)** run 2026-09-14 on `3d2bac3` (`origin/main`):
  - `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, 101 pass /
    0 fail.
  - `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0, all
    fixtures match.
  - `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` → exit 0, no findings
    (`command -v shellcheck` → `/home/david/.local/bin/shellcheck`).
  Baseline is green: no overlap, no scoped gate needed. The Builder reruns all three
  as the full final gate and records the comparison (0 findings; test count ≥ 101 +
  the new tests). Note: the delivery guard denies a single shell line that both
  redirects output and names `scripts/hooks/*.sh` — run shellcheck and the test suite
  as separate commands.
- **Concurrent deliveries.** `gh pr list --state open` → `[]`. Wave-2 siblings
  `window-aware-commands` and `ship-audit-first` are unplanned; both will later edit
  the same prompt bodies (every prompt's opening paragraphs) and `docs/commands.md`.
  See Risks.
- **Environment facts** (for test design, not assumptions in code): Node v22.22.3,
  Python 3.12.3, `code` and `gh` on PATH here; AGENTS.md requires Node ≥ 20 for the
  CLI.

## Approach

Three layers: a CLI subcommand with tests, a policy contract, and per-command
declarations (prompts + agents) with docs kept in sync.

### 1. `agento.mjs doctor [--for <command>]`

- New `case "doctor"` in `scripts/agento.mjs`; new usage line
  `node scripts/agento.mjs doctor [--for <command>]   (environment checks: ok | warn | fail, with fallbacks)`;
  `parseArgs` gains `--for <name>` (validated against `[a-z0-9-]+`).
- Six checks, each `{ id, status: "ok" | "warn" | "fail", detail, fallback }`, every
  probe wrapped in try/catch with a bounded timeout (10 s) so the command never
  throws:
  - `node` — `process.versions.node` major ≥ 20 → ok, else fail; fallback "install
    Node ≥ 20 (AGENTS.md)".
  - `git-remote` — `git remote get-url origin` present, then
    `git ls-remote --exit-code --heads origin <branches.default>` (timeout 10 s) →
    ok; no `origin` → fail (fallback: add the remote); unreachable → warn (fallback:
    "work offline; push/PR steps will fail until the network is back").
  - `gh` — `gh --version` absent → fail (fallback: install GitHub CLI);
    `gh auth status` nonzero → fail (fallback: the exact reauth command `gh auth
    login`, never asked of the user by proxy per §1) ; ok otherwise.
  - `code` — `code --version` → ok; absent → warn (fallback: "print `code
    --new-window <path>` for the user to run; keep the worktree").
  - `python3` — `python3 --version` → ok; absent → warn (fallback: "hooks do not
    run; the guard and SessionStart context are unavailable — proceed with care").
  - `worktrees-dir` — resolve `worktrees.dir` against the **primary** worktree (same
    code path as `session`); parent exists and is writable (`fs.accessSync(W_OK)` on
    the dir or its nearest existing ancestor) → ok; else fail (fallback: create it or
    change `worktrees.dir`).
- `--for <command>` selects the checks that command declares in a static table
  inside `agento.mjs` (the same table the `Needs:` lines are written from; the
  customizations test cross-checks the two, see §3). Without `--for`, all six run.
- Output: `{ status: "ok" | "warn" | "fail", checks: [...], for: <command|null>,
  root, configSource }`; `status` is the worst check status. Exit 0 for `ok` and
  `warn`, 3 for `fail` (via `withExit` semantics: exit 3 = "resolution failed", which
  is what a hard-requirement failure is).
- Tests in `scripts/agento.test.mjs` using `restrictedPath()`: all-ok with stub
  `gh`/`code`/`python3`; `gh` missing → fail with the install fallback; `gh` present
  but `auth status` exit 1 → fail with the reauth fallback; `code` missing → warn;
  `python3` missing → warn; no `origin` → fail; unreachable origin (remote URL to a
  nonexistent path) → warn; `--for close-session` runs only the terminal-side checks;
  `--for bogus-command` → usage error exit 1; usage text lists `doctor`.

### 2. Policy contract (`delivery-policy.instructions.md`)

- **§9 additions** (the only place receipt spellings live): the preflight rejection
  form `Receipt: rejected — <capability>: <reason>; fallback: <fallback>` (used when a
  *hard* need is unmet — no `allowed:` list because the command itself is right, the
  environment is not), and the optional second line
  `Preflight: <capability> <warn|missing> — <fallback>` printed after an `accepted`
  receipt when a *soft* need is unmet. Idempotency row for `/agento doctor`:
  read-only; a duplicate is a fresh run.
- **New `## 10. Capability preflight`**: the capability vocabulary — `terminal`,
  `ask-questions`, `browser`, `gh`, `code`, `network`, `python3` — with what each
  means; the `Needs:` / `Fallback:` line contract (see §3); which needs are hard
  (`terminal` for anything that runs a command; `gh` and `network` for anything that
  pushes, opens a PR, or merges) versus soft (`ask-questions`, `browser`, `code`,
  `python3`); the standard fallbacks (ask-questions → numbered questions in chat,
  wait for the reply, retain verbatim; `code` → print the open command; browser →
  the step's `verify:` is run headless or reported as blocked per §2, never
  silently skipped; terminal unavailable → reject naming the chat mode to switch
  to — "switch to Agent mode", since Plan/Ask modes cannot run commands); when a
  command runs `doctor --for <name>` (Decision 2: commands whose `Needs:` include
  `gh`, `code`, or `network`, before any write) and how a `fail` maps to the §9
  preflight rejection and a `warn` to the `Preflight:` line. §1's `command -v`
  sentence is rewritten to point at `doctor` ("run `agento.mjs doctor --for
  <command>` per §10; for a CLI not covered by it, `command -v`"). Frontmatter
  `description` gains "capability preflight".

### 3. Per-command declarations

- Every `.github/prompts/*.prompt.md` gains, as the first two body lines after the
  frontmatter:
  `Needs: <capability>[, <capability>…]` and
  `Fallback: <one clause per soft need, or "none — every need is hard">`, followed
  by a one-sentence pointer to §10 (the standard fallbacks are not restated). The
  16 `gh`/`code`/`network` commands add "Run `node <agento-root>/scripts/agento.mjs
  doctor --for <name>` before the first write" to their receipt paragraph. Every
  `.github/agents/*.agent.md` gains the same two lines in its opening section; the
  Planner and Architect "ask-questions tool" sentences and the `start-session` /
  `start-freehand` `code` sentences are reworded to defer to the declared fallback
  (§10) rather than restating it; `agento-init` and `install-skills` references to
  `vscode/askQuestions` gain the same deferral.
- Mirror every prompt into `commands/<name>.md` (byte-identical).
- **New `/agento doctor` prompt** (`.github/prompts/doctor.prompt.md` +
  `commands/doctor.md`, default agent): `Needs: terminal`; runs `agento.mjs doctor`,
  presents one line per check (`id status — detail; fallback`), quotes fallbacks
  verbatim, never fixes anything itself (no installs, no `gh auth login` on the
  user's behalf — §1), read-only per §9. Listed in `command-invocation.instructions.md`,
  README.md, docs/commands.md (table + `## Invocation`), `templates/AGENTS-section.md`
  and the `agento-init` step-4 echo.
- **Tests** in `tests/customizations.test.mjs`: (a) "every command and agent declares
  Needs: and Fallback:" — first two body lines match `^Needs: ` / `^Fallback: `, every
  capability token is in the §10 vocabulary parsed from the policy file, `Fallback:`
  is non-empty; (b) "commands that need gh, code, or network run doctor --for" — a
  prompt whose `Needs:` includes one of those cites `doctor --for <its own name>`,
  and no other prompt does; (c) the `--for` table in `agento.mjs` agrees with the
  prompts' `Needs:` lines (parse both; the CLI table is exported or exposed via
  `doctor --for <name>`'s `for.needs` field); (d) canaries `Preflight:` and
  `fallback: <fallback>`-style format words added to the single-source test;
  `sections.size >= 10`.

### 4. Docs

`docs/commands.md` (table row, `## Invocation` entry, CLI paragraph gains `doctor
[--for <command>]` and its exit codes, a short "Preflight" paragraph under
"Receipts"), `README.md` command reference row, `AGENTS.md` scripts bullet,
`docs/architecture.md` policy summary gains "capability preflight",
`templates/AGENTS-section.md`, `CHANGELOG.md` `## 0.4.0 (unreleased)` entry (no
version bump).

### Files touched

`scripts/agento.mjs`, `scripts/agento.test.mjs`, `.github/instructions/delivery-policy.instructions.md`,
`.github/instructions/command-invocation.instructions.md`, all 22 existing
`.github/prompts/*.prompt.md` + new `doctor.prompt.md`, all 23 `commands/*.md`, all 6
`.github/agents/*.agent.md`, `tests/customizations.test.mjs`, `docs/commands.md`,
`docs/architecture.md`, `README.md`, `AGENTS.md`, `templates/AGENTS-section.md`,
`CHANGELOG.md`, and `features/2026/09/capability-preflight/`.

Verification target: none of this is served behaviour — every step is verified by
the node:test suites, the CLI's own JSON output in temp repos, and `grep`; no
`local:`/`dev-stack`/`preview` target applies. No `(manual)` steps: every check is
CLI-executable by the agent.

## Risks

- **Every prompt body changes; wave-2 siblings edit the same files.**
  `window-aware-commands` (window checks in every window-sensitive prompt and agent)
  and `ship-audit-first` (`ship.prompt.md`, README/docs flows) are unplanned but may
  start concurrently. Mitigation: this feature adds two lines at the very top of each
  body and one clause in the receipt paragraph — small, position-stable hunks;
  integrate `origin/main` by merge before every push (policy §7); if a sibling ships
  first, re-mirror `commands/` after the merge (the identity test catches drift).
- **`doctor` adds network latency** (`git ls-remote`, `gh auth status`). Mitigation:
  Decision 2 limits it to the 16 commands that need those capabilities anyway; every
  probe has a bounded timeout; the hook does not run it.
- **`gh auth status` semantics differ by version** (exit codes, stderr vs stdout).
  Mitigation: treat any nonzero exit as `fail`, quote the first stderr line in
  `detail`, and stub `gh` in tests so the suite never depends on a real login.
- **Declaring `terminal` as hard may reject Plan/Ask chat modes** where users used to
  get partial help. Mitigation: that is the brief's requested behaviour ("Plan mode
  could not execute `/start-session`"); the rejection names the mode to switch to.
- **Vocabulary drift** between §10, the prompts, and the CLI table. Mitigation: the
  customizations test parses all three and fails on any token outside the vocabulary
  or any disagreement.
- **Test count and canaries.** New canaries could collide with existing prose (e.g.
  the word "fallback" appears in `agento-init.prompt.md` L90 about
  `chat.pluginLocations`). Mitigation: canaries match the exact line formats
  (`^Preflight: `, `; fallback: `) not the bare word.

## Out of scope

- Extending `scripts/hooks/session-context.sh` to run or print `doctor` (approval-gated,
  adds latency to every session start).
- Replacing prose window checks with `agento.mjs session` (`window-aware-commands`).
- Changing the close/ship order or ship's confirmation gate (`ship-audit-first`).
- `/agento continue` (`continue-command`).
- Installing or repairing anything `doctor` finds missing (it reports; §1 keeps
  installs and logins with the user).
- Version bump of `plugin.json`/`package.json`; hook wiring changes.

## Acceptance checklist

- [ ] `node scripts/agento.mjs doctor` prints one JSON document with six checks
  (`node`, `git-remote`, `gh`, `code`, `python3`, `worktrees-dir`), each with
  `status ∈ {ok, warn, fail}`, `detail`, and `fallback`; overall `status` is the worst
  check; exit 0 for ok/warn, 3 for fail — verify: run it in this worktree and in a
  `restrictedPath()` temp repo; `node --test scripts/agento.test.mjs` passes the new
  doctor cases (gh missing, gh unauthenticated, code missing, python3 missing, no
  origin, unreachable origin, all ok).
- [ ] `doctor --for <command>` runs only that command's declared checks and reports
  the command's needs; an unknown command is a usage error (exit 1); usage text lists
  `doctor [--for <command>]` — verify: the new tests and `node scripts/agento.mjs
  bogus | grep -c 'doctor \[--for'` prints 1.
- [ ] `delivery-policy.instructions.md` §9 defines the preflight rejection receipt and
  the `Preflight:` line, adds a `/agento doctor` idempotency row, and a new `## 10.
  Capability preflight` section defines the capability vocabulary, hard vs soft needs,
  standard fallbacks, and when `doctor --for` runs; §1's presence-check sentence points
  at §10 — verify: read the sections; `node --test tests/customizations.test.mjs`
  passes with `sections.size >= 10`.
- [ ] Every `.github/prompts/*.prompt.md` (23 incl. `doctor`) and every
  `.github/agents/*.agent.md` (6) opens its body with `Needs:` and `Fallback:` lines
  whose tokens are in the §10 vocabulary — verify: the new customizations test passes
  and fails when either line is removed from one file (temporary edit, reverted).
- [ ] Exactly the prompts whose `Needs:` include `gh`, `code`, or `network` instruct
  running `agento.mjs doctor --for <own-name>` before the first write, and the CLI's
  `--for` table agrees with every prompt's `Needs:` line — verify: the new
  cross-check test passes.
- [ ] The Planner/Architect ask-questions sentences, the `start-session`/`start-freehand`
  `code` sentences, and the `agento-init`/`install-skills` `vscode/askQuestions`
  references defer to the declared fallback instead of restating it — verify: `grep -n
  "askQuestions\|ask-questions\|\`code\` CLI is unavailable" .github/prompts/*.md
  .github/agents/*.md` shows only deferral wording; the canary test passes.
- [ ] New `/agento doctor` command exists (`.github/prompts/doctor.prompt.md` ≡
  `commands/doctor.md`), is read-only, and is listed in
  `command-invocation.instructions.md`, `README.md`, `docs/commands.md` (table and
  `## Invocation`), `templates/AGENTS-section.md`, and the `agento-init` step-4 echo —
  verify: existing "documented in README.md and docs/commands.md",
  "command-invocation … list every command", and "plugin manifest" tests pass.
- [ ] `docs/commands.md` CLI paragraph, `AGENTS.md` scripts bullet,
  `docs/architecture.md`, and `CHANGELOG.md` `## 0.4.0 (unreleased)` mention `doctor`
  / capability preflight — verify: `grep -n "doctor" docs/commands.md AGENTS.md
  docs/architecture.md CHANGELOG.md` has a hit in each.
- [ ] Full lint gate matches the baseline: `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` exit 0 with ≥ 102 tests passing (101 + the new cases),
  `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` exit 0, `shellcheck
  scripts/hooks/*.sh scripts/wait-for-checks.sh` exit 0, no new findings versus
  `## Research` — verify: command outputs recorded on the final roadmap step.
- [ ] No files under `scripts/hooks/`, `.github/hooks/`, and none of `hooks.json`,
  `plugin.json`, `package.json`, `scripts/session-state.mjs`,
  `scripts/delivery-roadmap-resolver.mjs` are changed — verify: `git diff --name-only
  origin/main...HEAD` contains none of them.
