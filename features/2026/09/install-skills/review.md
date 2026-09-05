# Review: install-skills

Verdict: approve

## Acceptance checklist results

- [pass] `.github/prompts/install-skills.prompt.md` exists with valid frontmatter
  (description + argument-hint) and an 8-step body containing the approval gate
  (`vscode/askQuestions`, default none) and the idempotency rule (skip
  already-installed via `.agents/skills/` comparison) — verified by reading the file.
- [pass] `README.md` and `docs/commands.md` list `/install-skills` —
  `grep -l install-skills` matches both.
- [pass] Existing tests pass — `node --test 'scripts/**/*.test.mjs'
  'tests/**/*.test.mjs'` → 24/24 (run post-implementation).
- [pass] Discoverability — kebab-name file in `.github/prompts/`, same convention
  as the 18 existing commands (spike-proven discovery path).

## Plan vs implementation

Matches plan.md exactly: one prompt file + two doc references, no script/hook/
config changes. The prompt body covers all 8 planned steps including the
precondition (redirect to `/agento-init` when `## Agento` is absent), `--help`
discovery before assuming the skills CLI interface, pnpm-dlx phrasing for pnpm
projects, and the `SKILL.md` name/folder match verification.

## Roadmap audit

All 4 steps ticked with verify evidence; ticks match reality (spot-checked
frontmatter, grep results, test run). `status: in-review` set by step 1.4 as
planned. No falsely ticked boxes.

## Findings

None blocking. Minor: `argument-hint` mentions a `--yes-extra-domain` flag the
body doesn't implement — harmless (extra args are ignored by convention), but a
future cleanup could drop it or implement it.

## Follow-ups

- Consider an `/agento-init` follow-up that offers to run `/install-skills`
  immediately after scaffolding (currently the user must discover it).
