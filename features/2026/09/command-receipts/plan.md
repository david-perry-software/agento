# Execution receipts and idempotency for every Agento command

## Problem

Agento commands start working silently and end with free-form prose. The user cannot
tell, from the first line of a response, whether a command was accepted, what it is
operating on, or — when it stops — whether it finished, refused, or broke half-way and
what a rerun will do. Duplicate submissions (a second `/agento new-feature`, a
`/agento ship` re-sent after a check wait) are handled ad hoc by each prompt's own
resume language, so nothing guarantees they are harmless.

This feature is the `command-receipts` member of the
[workflow-orchestration](../../../../initiatives/2026/09/workflow-orchestration/breakdown.md)
initiative (`### command-receipts`; Wave 1, Size M). Its brief: "Every command needs an
immediate execution receipt and a terminal result: accepted with operation ID; rejected
with reason and allowed alternatives; completed with resulting state; failed with a
retry-safe explanation. Commands should also be idempotent so duplicate submissions
cannot corrupt lifecycle state."

User-visible effect: every `/agento …` invocation opens with one receipt line and
closes with one result line, in a fixed spelling, and re-sending any command is safe
by construction.

## Decisions

- **Q: Which customization files must open with a receipt and close with a result
  (and be asserted by the customizations test)?** A: All 22 commands + all 6 agents
  (includes utility/setup prompts — agento-init, install-skills, extend-copilot,
  fix-copilot, delivery-status, next-feature, triage-followups — and the
  Mechanic/Architect agents).
- **Q: Which one-line spelling should §9 mandate for the four receipt kinds?** A:
  `Receipt:`/`Result:` lines — `Receipt: accepted <op-id>` · `Receipt: rejected —
  <reason>; allowed: <cmds>` · `Result: completed — <state>; next: <cmd>` · `Result:
  failed — <retry-safe explanation>`.
- **Q: Operation ID is `<command>:<slug-or-session-id>:<short-sha>`. What fills the
  middle segment for commands with no slug/session (delivery-status, agento-init,
  next-feature, extend-copilot…)?** A: Current branch name (e.g.
  `delivery-status:main:e0bbddf` — always derivable from git).
- **Q: Where should a `rejected` receipt take its "allowed alternatives" from?** A:
  `agento.mjs session` `allowed[]`/`elsewhere[]` — reuse the completed
  session-state-cli record; commands never hand-maintain alternative lists.
- **Q: How strict should the new customizations test be?** A: Cite §9 + canary + no
  restated format — every covered file cites §9; the receipt format words are canaries
  that may appear only in the policy file.

Inherited from the initiative's `## Decisions` (breakdown.md): receipts are a policy
section, idempotency is derived from git + roadmap state with no journal, operation
IDs are deterministic (command + subject + HEAD).

## Research

Skills consulted: none — no matching domain (no `.agents/skills/` directory and no
skills table in AGENTS.md; verified `ls -d .agents/skills` → absent).

- **Policy file structure.** `.github/instructions/delivery-policy.instructions.md`
  has sections `## 1.` … `## 8.`; its frontmatter `description` enumerates the
  sections and must gain "execution receipts". The preamble says agents and prompts
  link here instead of restating.
- **Enforcement points already present** in `tests/customizations.test.mjs`:
  - "policy section references (§N) point at sections that exist" (L152–161) parses
    `^## (\d+)\. ` headings, asserts `sections.size >= 8`, and checks every `§N` in
    agents, prompts, and instructions — a new `## 9.` heading makes `§9` citable.
  - "the policy file is the only place the shared rules are spelled out" (L164–181)
    holds a `canaries` regex array scanned over agents/prompts/instructions except the
    policy file — the receipt format words go here.
  - "plugin manifest and hook wiring…" (L214–end) asserts `commands/<name>.md` is
    byte-identical to `.github/prompts/<name>.prompt.md` — every prompt edit must be
    mirrored into `commands/`.
  - File enumeration helpers: `listFiles(dir, suffix)`, `agentFiles`, `promptFiles`,
    `instructionFiles`, `splitFrontmatter(file).body`.
- **Current policy citations.** Agents cite `§N`/link the policy: Planner (L23, 75,
  107–115, 141), Builder (L29, 62–67, 90, 96), Reviewer (L23, 55–78), Autopilot
  (L19–20, 67), Architect (L22–23); Mechanic mentions the file only (L63, 79).
  Prompts: build-feature (L22), build-issue (L25), review-feature (L17), review-issue
  (L22), ship (L40, 67, 91) — the other 17 prompts never reference the policy.
- **Existing idempotency behaviour to codify** (per-file, verbatim locations):
  - `new-feature.prompt.md` L31 / `new-issue.prompt.md` L13: slug reuse rejected /
    existing GitHub issue linked, not duplicated.
  - `build-*.prompt.md` L16–19: resume protocol before implementation.
  - `ship.prompt.md` L19–20: `status: complete` with unticked post-ship steps → skip
    to epilogue; L97–98: re-running resumes at the epilogue.
  - `start-session.prompt.md` L46–48, L68–73 and `start-freehand.prompt.md` L38–40:
    registered worktree without `--resume` → stop; with `--resume` → reuse unchanged.
    The initiative decision ("re-start-session on an existing worktree → `--resume`
    semantics") turns the without-flag stop into a duplicate receipt that resumes.
  - `close-session.prompt.md` L8, L40, L82–83: removal is authorised by invocation;
    nothing today says what happens when the worktree is already gone.
  - `commit-current-changes.prompt.md` L18, L60 and `finish-freehand.prompt.md` L23,
    L64: never duplicate a commit or PR; report the resume phase.
  - `quick-fix.prompt.md` L40: existing `changes/<slug>` → append `-2`, `-3`.
  - `triage-followups.prompt.md` L25, L48, L70: annotated lines / flagged issues
    skipped on re-runs.
  - `agento-init.prompt.md` L7: without `--force`, existing files are kept.
  - `install-skills.prompt.md` L34: already-installed skills excluded.
  - `delivery-status`, `next-feature`: read-only.
- **Alternatives source.** `scripts/session-state.mjs` `deriveAllowed()` (L207–217)
  returns `allowed[]` and `elsewhere[]` (`{command, window, reason}`) per
  role × lifecycle; the SessionStart hook already prints them in the `Session:` line
  (`allowed=[…] elsewhere=[…]`), so a rejected receipt can quote them without a new
  CLI call. No hook or CLI change is needed by this feature.
- **"Suggested next step" rule.** AGENTS.md last bullet: "Every agent's final
  response ends with a concrete suggested next step." The `Result: completed — …;
  next: <cmd>` line is that rule made concrete; AGENTS.md should point at §9.
- **Docs that summarise the policy sections.** `docs/architecture.md` L39–44 lists
  the eight topics; `CHANGELOG.md` has `## 0.4.0 (unreleased)` (plugin.json and
  package.json are both still `0.3.0`; /agento ship stamps the date only when the
  version changes — not this feature's concern). `docs/commands.md` has no policy
  summary; README.md has none.
- **Lint baseline (policy §5)** run 2026-09-14 on `e0bbddf` (`origin/main`):
  - `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, 98 pass /
    0 fail.
  - `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
  - `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` → exit 0, no findings.
  Baseline is green: no overlap, no scoped gate needed. The Builder reruns all three
  as the final full gate and records the comparison (must remain 0 findings, test
  count ≥ 98 + the new tests).
- **Concurrent deliveries.** `gh pr list --state open` → `[]`; no other branch touches
  these files right now. Wave-1 sibling `canonical-commands` (unplanned) will later
  edit the same policy file and test; see Risks.

## Approach

Pure customization-file change; no CLI, hook, or resolver code.

1. **Policy `## 9. Execution receipts`** in
   `.github/instructions/delivery-policy.instructions.md` (append after §8; extend
   the frontmatter `description`). Contents, spelled out once:
   - *Receipt (first line of the response):*
     `Receipt: accepted <op-id>` ·
     `Receipt: accepted <op-id> (duplicate of <op-id>; resuming)` ·
     `Receipt: rejected — <reason>; allowed: <cmd>[, <cmd>…]` (alternatives copied
     from the session record's `allowed[]`, plus `elsewhere[]` entries as
     `<cmd> (<window> window)`; a rejection writes nothing).
   - *Result (last line of the response):*
     `Result: completed — <resulting state>; next: <command>` (state = branch, PR,
     roadmap status/lifecycle as applicable; `next:` is the concrete next command and
     satisfies the AGENTS.md next-step rule) ·
     `Result: failed — <retry-safe explanation>` (what was done, what was not, and
     that re-sending the same command resumes from git + roadmap state).
   - *Operation ID:* `<command>:<subject>:<short-sha>` — suffix-less command name;
     subject = slug, or session id, or the current branch name when there is
     neither; `git rev-parse --short HEAD` at acceptance. Deterministic, no journal:
     the same command on the same subject at the same HEAD is a duplicate.
   - *Idempotency table* — one row per command naming its duplicate-submission
     behaviour, all derived from git + roadmap state: new-feature/new-issue →
     Planner resume protocol on the existing roadmap (no second branch/PR);
     build-* → Builder resume/audit; review-* → fresh verdict overwrites review.md;
     ship → `status: complete` resumes the epilogue, merged PR → sync main only;
     start-session/start-freehand → `--resume` semantics on a registered worktree;
     close-session → worktree already removed → `completed` ("already closed");
     finish-freehand/commit-current-changes → reuse existing commit/PR/check phase;
     quick-fix → open PR on `changes/<slug>` from the same base is resumed, the
     `-2` suffix applies only when that branch's PR is merged or closed;
     new-initiative → open `changes/initiative-<slug>` PR resumed, merged →
     rejected naming the breakdown; agento-init → existing files kept unless
     `--force`; install-skills → installed skills excluded; triage-followups →
     annotated lines skipped; ap → re-enters build/review resume; delivery-status,
     next-feature → read-only; extend-copilot/fix-copilot → existing capability is
     modified, never duplicated.
2. **Tests** in `tests/customizations.test.mjs`: bump `sections.size >= 9`; new test
   "every command and agent opens and closes with the §9 receipt" asserting `§9`
   appears in the body of every prompt and agent file; add canaries
   `/Receipt: accepted/`, `/Receipt: rejected/`, `/Result: completed/`,
   `/Result: failed/`, `/duplicate of <op-id>/` to the single-source test.
3. **Citations** — one sentence per file, no format words: all 22
   `.github/prompts/*.prompt.md` (mirrored byte-for-byte into `commands/*.md`) and
   all 6 `.github/agents/*.agent.md`. Where a prompt already describes a duplicate
   path (ship, build-*, start-*, close-session, quick-fix, finish-freehand,
   commit-current-changes), reword that sentence to defer to the §9 row instead of
   restating it; `start-session`/`start-freehand` change the "registered without
   `--resume`: stop" rule to the duplicate-resumes rule; `close-session` gains the
   "already removed" outcome.
4. **Docs**: `docs/architecture.md` policy summary gains "execution receipts and
   idempotency"; AGENTS.md next-step rule cites §9; `docs/commands.md` gets a short
   "Receipts" paragraph; `CHANGELOG.md` `## 0.4.0 (unreleased)` gets an entry.

Verification target: none of this is served behaviour — every step is verified by
the node:test suite and `grep`; no `local:`/`dev-stack`/`preview` target applies.

## Risks

- **Sibling `canonical-commands` edits the same policy file and test file.**
  Mitigation: this feature appends a self-contained `## 9.` and adds an isolated test
  + canary entries; integrate `origin/main` before every push (policy §7). Sequence:
  the breakdown recommends `canonical-commands` after this feature.
- **Receipts add chatter or drift into prose.** Mitigation: fixed one-line formats,
  duplicate collapses into the single `accepted … (duplicate …)` line, canaries fail
  the suite if any prompt restates the format.
- **Changing `start-session`/`start-freehand` without-`--resume` behaviour.**
  A registered worktree is now resumed instead of refused. Mitigation: `--resume`
  semantics never alter HEAD, branch, or files; the receipt names the duplicate so the
  user sees it was not recreated. `window-aware-commands` (Wave 2) edits the same
  prompts later and will inherit this wording.
- **Op-id middle segment for branchless states** (detached planning worktree has no
  branch name). Mitigation: §9 says use the session id for managed worktrees
  (`plan-<id>`), and `HEAD` literally when detached and unmanaged.
- **Breaking byte-identity between prompts and `commands/`.** Mitigation: every
  prompt step's verify runs the customizations test, which asserts identity.

## Out of scope

- Any change to `scripts/agento.mjs`, `session-state.mjs`, or the hooks (the session
  record already carries `allowed[]`/`elsewhere[]`).
- A persisted operation journal or receipt log.
- `agento.mjs doctor`, per-command `Needs:`/`Fallback:` declarations
  (`capability-preflight`).
- Canonical spelling / `.prompt` suffix redirects (`canonical-commands`).
- Consuming `agento.mjs session` for window checks in prompts
  (`window-aware-commands`); this feature only quotes its `allowed[]`/`elsewhere[]`
  in rejections.
- Version bump of `plugin.json`/`package.json`.

## Acceptance checklist

- [ ] `.github/instructions/delivery-policy.instructions.md` has a `## 9. Execution
  receipts` section defining the five receipt/result line formats, the deterministic
  operation ID (`<command>:<subject>:<short-sha>`, branch-name fallback), the
  `agento.mjs session` `allowed[]`/`elsewhere[]` source for rejections, and an
  idempotency row for each of the 22 commands — verify: read the section; `node --test
  tests/customizations.test.mjs` passes with `sections.size >= 9`.
- [ ] Every `.github/prompts/*.prompt.md` (22) and `.github/agents/*.agent.md` (6)
  body cites `§9` — verify: the new customizations test passes and fails when a
  citation is removed from any one file (spot-check by temporary edit, then revert).
- [ ] The receipt format words appear only in the policy file — verify: the canaries
  `Receipt: accepted`, `Receipt: rejected`, `Result: completed`, `Result: failed`,
  `duplicate of <op-id>` are in the single-source test and it passes.
- [ ] `commands/*.md` remain byte-identical to their prompts — verify: existing
  "plugin manifest and hook wiring" test passes.
- [ ] `start-session`, `start-freehand`, `close-session`, `ship`, `quick-fix`,
  `finish-freehand`, `commit-current-changes`, `build-*` prompt text matches their §9
  idempotency rows (no contradicting "stop and report the session already exists"
  without `--resume`) — verify: `grep -n "already exists" .github/prompts/start-*.md`
  shows only the duplicate-resumes wording; manual read of the listed prompts.
- [ ] `docs/architecture.md`, `docs/commands.md`, AGENTS.md, and `CHANGELOG.md`
  (`## 0.4.0 (unreleased)`) mention execution receipts / §9 — verify: `grep -n
  "receipt" docs/architecture.md docs/commands.md AGENTS.md CHANGELOG.md` has a hit in
  each.
- [ ] Full lint gate matches the baseline: `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` exit 0 with ≥ 99 tests passing, `./scripts/hooks/replay-guard.sh
  < tests/guard-fixtures.txt` exit 0, `shellcheck scripts/hooks/*.sh
  scripts/wait-for-checks.sh` exit 0, no new findings versus `## Research` — verify:
  command outputs recorded on the final roadmap step.
- [ ] No files outside `.github/instructions/`, `.github/prompts/`, `.github/agents/`,
  `commands/`, `tests/customizations.test.mjs`, `docs/`, `AGENTS.md`, `CHANGELOG.md`,
  and `features/2026/09/command-receipts/` are changed — verify: `git diff --stat
  origin/main...HEAD`.
