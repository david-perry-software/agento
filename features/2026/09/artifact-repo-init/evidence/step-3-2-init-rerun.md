# Step 3.2 — idempotent re-drive of `/agento agento-init` (second pass)

Date: 2026-09-16. Same temp checkout as step 3.1 (`/tmp/tmp.crpKjqpynU`), driven
from the prompt at branch `feature/artifact-repo-init` (HEAD `a1e2810`). No `--force`.

## Baseline before the pass

```
$ gh repo view david-perry-software/agento-smoke-init-20260916-docs --json createdAt --jq .createdAt
2026-09-16T07:11:14Z
$ git -C ../agento-smoke-init-20260916-docs rev-list --count origin/main
5
```

## Prompt steps as driven

- **1**: `agento.mjs session --root` → `isPrimary: true`; `gh repo view` →
  `david-perry-software/agento-smoke-init-20260916 PUBLIC`; default `main`.
- **2**: default `agento-smoke-init-20260916-docs` accepted.
- **3**: `gh repo view david-perry-software/agento-smoke-init-20260916-docs` succeeds →
  repository **adopted**. `../agento-smoke-init-20260916-docs` exists,
  `rev-parse --show-toplevel` is that path and `remote get-url origin` is
  `https://github.com/david-perry-software/agento-smoke-init-20260916-docs.git` →
  clone **adopted**. `fetch origin`; `origin/main` exists; first line of its
  `README.md` is `<!-- agento-companion: david-perry-software/agento-smoke-init-20260916 -->`
  → accepted.
- **4**: `origin/main` exists → only missing files would be committed on
  `changes/agento-init`. All five present:
  `kept README.md`, `kept features/.gitkeep`, `kept issues/.gitkeep`,
  `kept initiatives/.gitkeep`, `kept .github/instructions/agento.instructions.md`
  → nothing to commit, no companion branch, no PR, nothing written to `main`.
- **5**: adopted → check-then-ask: `rulesets --jq 'select(.target=="branch") | .name'`
  → `Agento default branch` — already protected, no question.
- **6–8**: `kept .github/agento.json`, `kept AGENTS.md` (`## Agento` section present),
  `kept scripts/wait-for-checks.sh`.
- **9**: product still has no ruleset (`rulesets | length` = 0); gap recorded again.
- **10**: `agento.mjs doctor` → `artifact-repo` `ok`, exit 0.
- **11**: `git status --short` empty on `changes/agento-init`; open PR #1 on that
  branch reused; nothing committed.

Report of the run: companion `david-perry-software/agento-smoke-init-20260916-docs`
adopted (repository and clone at `../agento-smoke-init-20260916-docs`); all
companion and product scaffold files **kept**; companion ruleset already protected;
product ruleset gap; PR #1 reused.

## Verify line

```
$ gh repo view david-perry-software/agento-smoke-init-20260916-docs --json createdAt --jq .createdAt
2026-09-16T07:11:14Z            # unchanged
$ git -C ../agento-smoke-init-20260916-docs fetch origin && git -C ../agento-smoke-init-20260916-docs rev-list --count origin/main
5                               # unchanged
$ git -C ../agento-smoke-init-20260916-docs branch -r
  origin/main                   # no changes/agento-init pushed to the companion
```
