# /install-skills — stack-aware skill installer

## Problem

Agento's skills-first policy requires each target repo to keep a `### Skills`
domain table in its `AGENTS.md` `## Agento` section and to install matching
skills into `.agents/skills/`. Today that is entirely manual: the user must know
the skills registry, pick skills per domain, run the installer per skill, and
edit AGENTS.md by hand. This is error-prone and means most projects end up with
an empty skills table and agents that say `none — no matching domain`.

## Decisions

- Deliver as a **prompt** (`/install-skills`), not an agent or script: it is a
  one-shot task needing model judgment (stack detection, skill selection) — the
  Mechanic's own decision flow says "slash command with inputs → prompt".
- **Propose, don't spray**: present a domain → candidate table and require
  explicit per-skill approval via `vscode/askQuestions` before installing.
  Skills inject instructions into sessions; silent bulk install is a supply-chain
  risk.
- Requires the target repo to be `/agento-init`'d first (the AGENTS.md `## Agento`
  section must exist to be updated).
- Idempotent: skills already present in `.agents/skills/` are listed as installed
  and skipped.

## Research

- Skills consulted: none — no matching domain (the built-in `agent-customization`
  skill informs the prompt's format conventions).
- Skills CLI: `npx skills add <owner/repo> --skill <name>` from the repo root;
  discovery via `npx skills` list/search. Documented in Agento's
  `.github/instructions/ai-skills.instructions.md`.
- The `## Agento` profile format is defined by `templates/AGENTS-section.md`.
- Baseline: no lint configured in agento (`node --test` is the gate); repo is
  markdown + shell + mjs only.

## Approach

Add one file: `.github/prompts/install-skills.prompt.md`. Steps the prompt
prescribes in the target repo:

1. Verify `AGENTS.md` has an `## Agento` section; if not, stop and direct to
   `/agento-init`.
2. Detect the stack from manifests/lockfiles/config (`package.json`,
   `requirements.txt`, `go.mod`, CI workflow files, etc.).
3. Search the skills registry for candidates per detected domain.
4. Present a domain → skill → source → why table; ask per-skill approval with
   `vscode/askQuestions`.
5. For each approved skill: run the installer from the repo root; skip any
   already present (idempotent).
6. Update the `### Skills` table in `AGENTS.md` with each installed domain row.
7. Verify each installed dir has a `SKILL.md` whose frontmatter `name` matches
   its folder (per the Mechanic's known-pitfalls list).
8. Commit on a `changes/install-skills` branch and open a PR (never direct to
   the default branch — the delivery guard denies that).

Docs: add `/install-skills` to `README.md` command list and `docs/commands.md`
table. No script changes; no hook changes; no config-schema changes.

## Risks

- **Registry availability/format drift** (the `skills` CLI output may change) —
  mitigated by prescribing `--help` discovery first and stating "no candidate
  found" per domain instead of guessing.
- **Prompt-only enforcement of approval** — accepted: VS Code's tool approval
  plus the explicit askQuestions gate is the available mechanism; hooks can't
  distinguish skill installs cleanly.
- **pnpm projects** — prompt says use the project's documented runner
  (`pnpm dlx` where AGENTS.md declares pnpm).

## Out of scope

- Auto-install without approval.
- A curated skill catalog inside the plugin (keeps Agento stack-agnostic).
- Updating soshiki's own skill set.

## Acceptance checklist

- [ ] `.github/prompts/install-skills.prompt.md` exists with valid frontmatter
  (description + argument-hint) and the 8-step body — verify: `head -6` shows
  frontmatter; body contains the approval gate and idempotency rule
- [ ] `README.md` and `docs/commands.md` list `/install-skills` — verify: grep
- [ ] All existing tests still pass — verify: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` exit 0
- [ ] Prompt is discoverable: file follows plugin conventions (kebab name in
  `.github/prompts/`) — verify: `ls .github/prompts/ | grep install-skills`
