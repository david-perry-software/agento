# Review: canonical-commands

Verdict: approve

Reviewed 2026-09-14 at HEAD `8228f69` on `feature/canonical-commands` (PR #17, draft)
in worktree `/home/david/DP/agento-worktrees/plan-20260914-034045`. `origin/main`
`e0bbddf` is an ancestor of HEAD (`git merge-base --is-ancestor` exit 0), so no
integration merge was needed. Skills consulted: none — no matching domain
(`.agents/skills/` absent; no `## Agento` skills table in AGENTS.md).

Full gate rerun by the Reviewer (policy §5, compared with the plan `## Research`
baseline of 98 pass / 0 fail / shellcheck clean / replay-guard clean):

| Command | Exit | Result |
|---|---|---|
| `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` | 0 | 100 tests, 100 pass, 0 fail |
| `shellcheck scripts/hooks/*.sh scripts/wait-for-checks.sh` | 0 | none |
| `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` | 0 | all fixtures match |

No finding present now that was absent at baseline; the +2 test count is exactly the
two new `test(` calls (i, iv). PR #17 CI: `scripts/wait-for-checks.sh pr 17` →
`pass=1 fail=0 pending=0`, `RESULT: success`.

## Acceptance checklist results

1. **Instruction file exists with `description`, `applyTo: "**"`, canonical form, full
   command list, six redirected forms, "name it and proceed" rule, no legacy table** —
   **pass**. `sed -n '1,4p'` shows the frontmatter; body lists 22 `/agento <name>`
   bullets; the roadmap 1.1 loop over `.github/prompts/*.prompt.md` printed no
   `missing`; `## Redirect rule` lists the six forms "with or without trailing
   arguments" and the one-sentence example; `grep -nE '^\|'` finds no table rows.
   Test (iv) passes in the gate.
2. **`docs/commands.md` `## Invocation` before `## The standard flow`** — **pass**.
   `grep -n '^## ' docs/commands.md` → `40:## Invocation`, `80:## The standard flow`
   (no `## Receipts` yet — #16 has not merged). `sed -n '/^## Invocation/,/^## The
   standard flow/p' | grep -c '/agento '` = 29 (≥ 22). Test (iii) passes.
3. **Template + agento-init prompt/command carry the same note, pair byte-identical** —
   **pass**. `diff .github/prompts/agento-init.prompt.md commands/agento-init.md` is
   empty; `grep -c 'canonical'` = 1 in `templates/AGENTS-section.md` and in
   `commands/agento-init.md`; the manifest test passes.
4. **Test (i) named after the `agento-init.prompt` defect, scans guidance + CHANGELOG,
   two-path allowlist, fails on `/agento ship.prompt` in README** — **pass**.
   [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs#L219-L233):
   name contains `(agento-init.prompt defect)`; `allowlist = new Set(["CHANGELOG.md",
   ".github/instructions/command-invocation.instructions.md"])`; iterates
   `[...guidanceFiles, rel("CHANGELOG.md")]`. Mutation: appended `Use /agento
   ship.prompt here` to README.md → `README.md writes a suffixed command "/agento
   ship.prompt"; use /agento <name>`, `# fail 1`; reverted with `git checkout`.
5. **Manifest test asserts `^[a-z0-9-]+\.md$` per entry and byte-identity; fails on
   `commands/zz.prompt.md`** — **pass**.
   [tests/customizations.test.mjs](../../../../tests/customizations.test.mjs#L249-L268):
   `fs.readdirSync` loop with `assert.match(name, /^[a-z0-9-]+\.md$/)`, then the
   existing `deepEqual` and per-file `assert.equal` on contents. Mutation: `touch
   commands/zz.prompt.md` → `commands/zz.prompt.md: command files are <name>.md only
   (no .prompt suffix)`, `# fail 1`; file removed.
6. **Test (iv) fails on a listed command with no prompt** — **pass**. Mutation:
   appended `` - `/agento nonexistent` `` to the instruction file →
   `.github/instructions/command-invocation.instructions.md lists /agento nonexistent,
   which has no .github/prompts/nonexistent.prompt.md`, `# fail 1`; reverted.
7. **`docs/architecture.md` Instructions bullet + `CHANGELOG.md` 0.4.0 bullet quoting
   the defect** — **pass**. `grep -n 'command-invocation' docs/architecture.md
   CHANGELOG.md` → `docs/architecture.md:47`, `CHANGELOG.md:20`; `grep -n
   'agento-init.prompt' CHANGELOG.md` → line 25 inside the `## 0.4.0 (unreleased)`
   list.
8. **Full gate green at final commit, ≥ 100 tests** — **pass**. Table above:
   100/100/0, exits 0/0/0. The Builder's correction of this item's bound from "≥ 102"
   to "≥ 100" (dated 2026-09-13 in plan.md and roadmap 4.2) is **justified**: the
   plan's "four test assertions" are two new tests ((i) and (iv) — two `+test(`
   lines in the diff) plus two tightened existing tests ((ii) renamed, (iii)
   extended), so the original "≥ 102" was an arithmetic slip, not a scope cut. The
   correction is annotated in place with date and rationale rather than silently
   rewritten.
9. **No `commands/` or `.github/prompts/` file other than the `agento-init` pair
   modified** — **pass**. `git diff --stat origin/main...HEAD -- commands
   .github/prompts` → exactly `.github/prompts/agento-init.prompt.md | 2 ++` and
   `commands/agento-init.md | 2 ++`.
10. **Roadmap header `initiative: "workflow-orchestration"`; initiative CLI reports
    the slug with `state` = roadmap `status` and no errors** — **pass**. Roadmap
    header has `initiative: "workflow-orchestration"` and `status: in-review`; `node
    scripts/agento.mjs initiative workflow-orchestration` → `"errors": []`,
    `"slug": "canonical-commands"` with `"state": "in-review"`.

Tally: 10 pass, 0 fail, 0 deferred.

## Plan vs implementation

- Implementation matches `## Approach` items 1–6 one-to-one; no undocumented changes
  (`git diff --stat origin/main...HEAD`: 10 files, all named in the plan).
- Only deviation: the acceptance-item bound "≥ 102" → "≥ 100" edited by the Builder,
  discussed and accepted under item 8 above.
- The exposing-test mutation for (iii) (roadmap 3.3) was also re-driven: deleting the
  `` - `/agento ship` `` row from `docs/commands.md` → `docs/commands.md ## Invocation
  does not list /agento ship`, `# fail 1`; reverted.
- Plan Q3 exception honoured: the agento-init pair is the only command/prompt touched;
  no per-command citation lines added (owned by `command-receipts`, PR #16).
- The plan left a README instruction-file list conditional; README references only
  the policy and artifact files by path (L62, L408), so no README edit was required.

## Roadmap audit

Every ticked box (1.1, 1.2, 2.1, 2.2, 3.1–3.4, 4.1–4.3) was re-run against the code
with its own `verify:` command (results above); all hold. No `(manual)` steps exist.
No falsely ticked boxes; no missing-work steps added; no repairs made.

## Findings

- **Minor** — [.github/instructions/command-invocation.instructions.md](../../../../.github/instructions/command-invocation.instructions.md#L57)
  says "This file is the one place allowed to quote the old forms", while test (i)
  also allowlists `CHANGELOG.md` (which quotes `/agento agento-init.prompt`). The
  `## Guidance rule` scopes "prose" to README/docs/agents/prompts/instructions/
  templates, so the changelog is technically outside the claim, but a reader of the
  instruction file alone would not know CHANGELOG is exempt. Non-blocking.
- No security-relevant surface: the change is guidance text and node:test assertions
  only; no hooks, CLI, or agents modified.

## Follow-ups

- Tighten the wording of the `## Guidance rule` sentence to mention that
  `CHANGELOG.md` is also exempt (historical record), or drop CHANGELOG from the
  allowlist once the 0.4.0 entry is the only quoter and rephrase it — either keeps
  the instruction file and the test allowlist self-consistent. → filed as #24
