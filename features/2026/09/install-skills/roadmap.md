```yaml
status: in-review
branch: feature/install-skills
last-updated: 2026-09-05
next-step: ""
```

## Phase 1: Prompt

- [x] 1.1 Write `.github/prompts/install-skills.prompt.md` per plan.md approach (8 steps, approval gate, idempotency, verify-each-skill) — verify: `head -6 .github/prompts/install-skills.prompt.md` shows valid frontmatter; body contains `vscode/askQuestions` and the AGENTS.md `### Skills` update step
- [x] 1.2 Document the command in README.md and docs/commands.md — verify: `grep -l install-skills README.md docs/commands.md` lists both
- [x] 1.3 Regression check — verify: `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` exit 0
- [x] 1.4 Set status to in-review — verify: roadmap header shows `status: in-review`
