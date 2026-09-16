# Step 3.1 — end-to-end smoke of `/agento agento-init` (first pass)

Date: 2026-09-16. Driver: Builder, from the prompt at branch `feature/artifact-repo-init`
(HEAD `31c3e4a`). Temp dir `/tmp/tmp.crpKjqpynU`. Owner `david-perry-software`.
Throwaway repositories (kept for the user to delete): `agento-smoke-init-20260916`
(product) and `agento-smoke-init-20260916-docs` (companion).

## Setup

```
$ gh repo create david-perry-software/agento-smoke-init-20260916 --public --add-readme --clone
https://github.com/david-perry-software/agento-smoke-init-20260916
$ git -C agento-smoke-init-20260916 log --oneline -1
d69eb97 (HEAD -> main, origin/main, origin/HEAD) Initial commit
```

`--add-readme` supplies the initial `main` commit server-side; the delivery guard
denies every `git push … main`, `git -C` included, so no push to `main` happened.

## Prompt steps as driven

- **Preflight**: `node <agento-root>/scripts/agento.mjs doctor --for agento-init` →
  `status: ok` (node, git-remote, gh authenticated, python3, worktrees-dir, artifact-repo).
- **1 Product repository**: toplevel is the temp clone, not the Agento clone;
  `agento.mjs session --root` → `role: primary`, `worktree.isPrimary: true`;
  `gh repo view --json nameWithOwner,visibility` →
  `david-perry-software/agento-smoke-init-20260916`, `PUBLIC`; default branch `main`.
- **2 Companion name**: default `agento-smoke-init-20260916-docs` accepted; matches
  `^[A-Za-z0-9_.-]{1,100}$` and differs from the product name.
- **3 Companion repository and clone**: `gh repo view` failed (absent) →
  `gh repo create david-perry-software/agento-smoke-init-20260916-docs --public
  --description "Agento delivery artifacts for david-perry-software/agento-smoke-init-20260916"`
  → `created`. `git clone … ../agento-smoke-init-20260916-docs` ("cloned an empty
  repository" warning). `git -C … fetch origin`: no `origin/main` → bootstrap path.
- **4 Companion scaffold**: files prepared in `mktemp -d`; README first line
  `<!-- agento-companion: david-perry-software/agento-smoke-init-20260916 -->`;
  `agento.instructions.md` = `templates/project.instructions.md` frontmatter +
  `delivery-artifacts.instructions.md` body. Published with the Contents API:

  ```
  $ for p in README.md features/.gitkeep issues/.gitkeep initiatives/.gitkeep .github/instructions/agento.instructions.md; do
      gh api -X PUT repos/$OWNER/$NAME/contents/$p -f branch=main \
        -f message="chore: scaffold Agento artifact roots ($p)" -f content="$(base64 -w0 $SCRATCH/$p)"; done
  README.md 50b068b
  features/.gitkeep 04c4c54
  issues/.gitkeep e74c17b
  initiatives/.gitkeep cd88a67
  .github/instructions/agento.instructions.md 592949e
  $ git -C ../agento-smoke-init-20260916-docs fetch origin
   * [new branch]      main       -> origin/main
  $ git -C ../agento-smoke-init-20260916-docs checkout main
  branch 'main' set up to track 'origin/main'.
  ```

- **5 Companion ruleset** (created this run → no question):
  `gh api -X POST repos/…-docs/rulesets` →
  `ruleset 23530556 Agento default branch active rules=pull_request,non_fast_forward,deletion`.
- **6 Product config**: `.github/agento.json` written with
  `"repo": { "name": "agento-smoke-init-20260916-docs", "dir": null }`; no artifact
  roots created in the product.
- **7 AGENTS.md**: `## Agento` section appended from `templates/AGENTS-section.md`
  with `david-perry-software/agento-smoke-init-20260916-docs` /
  `../agento-smoke-init-20260916-docs` filled in.
- **8 CI poller**: `scripts/wait-for-checks.sh` copied from the Agento clone, `-rwxrwxr-x`.
- **9 Product enforcement**: no branch ruleset; `branches/main/protection` → 404.
  Recorded as a gap (a smoke run has no user to ask; no product ruleset created).
- **10 Self-check**: `agento.mjs doctor` → `artifact-repo` `ok`,
  detail `/tmp/tmp.crpKjqpynU/agento-smoke-init-20260916-docs (agento-smoke-init-20260916-docs),
  origin https://github.com/david-perry-software/agento-smoke-init-20260916-docs.git, main present`.
- **11 Commit, PR**: branch `changes/agento-init`, commit
  `chore: initialise Agento (companion david-perry-software/agento-smoke-init-20260916-docs)`,
  PR https://github.com/david-perry-software/agento-smoke-init-20260916/pull/1.

## Verify line

```
$ gh repo view david-perry-software/agento-smoke-init-20260916-docs --json visibility,createdAt
{ "createdAt": "2026-09-16T07:11:14Z", "visibility": "PUBLIC" }
$ git -C agento-smoke-init-20260916-docs ls-tree -r --name-only origin/main
.github/instructions/agento.instructions.md
README.md
features/.gitkeep
initiatives/.gitkeep
issues/.gitkeep
$ gh api repos/david-perry-software/agento-smoke-init-20260916-docs/rulesets --jq '.[].name'
Agento default branch
$ ls agento-smoke-init-20260916
AGENTS.md  README.md  scripts
$ grep -c '"name": "agento-smoke-init-20260916-docs"' agento-smoke-init-20260916/.github/agento.json
1
$ node scripts/agento.mjs doctor --root /tmp/tmp.crpKjqpynU/agento-smoke-init-20260916   # exit 0, artifact-repo ok
$ node scripts/agento.mjs config --root /tmp/tmp.crpKjqpynU/agento-smoke-init-20260916 | grep artifactsRoot
  "artifactsRoot": "/tmp/tmp.crpKjqpynU/agento-smoke-init-20260916-docs",
$ git -C agento-smoke-init-20260916-docs rev-list --count origin/main
5
```
