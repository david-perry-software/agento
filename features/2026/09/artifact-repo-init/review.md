# Review: artifact-repo-init

Verdict: approve

Reviewed at HEAD `646753d` on `feature/artifact-repo-init` (draft PR #40, base `main`),
`origin/main` an ancestor of HEAD (`git merge-base --is-ancestor origin/main HEAD` →
true), work tree clean, `gh pr checks 40` → `test pass`. Skills consulted: none — no
matching domain (no `.agents/skills/` directory; AGENTS.md has no `## Agento` skills
table). Every command below was run by the Reviewer in this worktree on 2026-09-16
against the Builder's throwaway checkout `/tmp/tmp.crpKjqpynU` (still present) and the
live GitHub repositories `david-perry-software/agento-smoke-init-20260916` and
`…-docs`; the Builder's evidence files were read but not relied on. No throwaway
repository was deleted; the PR was neither marked ready nor merged.

## Acceptance checklist results

1. **Prompt creates/adopts the companion, clones `../<name>`, scaffolds README + three
   `.gitkeep` roots + `.github/instructions/agento.instructions.md`, bootstraps only
   when `origin/<default>` is absent, creates the companion ruleset for a companion it
   created, writes `"repo": { "name": "<name>"`, creates no product roots, self-checks
   with `doctor`** — **pass.** `.github/prompts/agento-init.prompt.md`: `grep -c 'gh
   repo create'` = 2 (L49 command, L51 failure wording); `grep -c '"name": "<name>"'`
   = 1 (L117); `grep -c 'agento-companion'` = 1 (L62 marker rule); `grep -c
   'artifact-repo'` = 1 (L206 self-check); `grep -n '\.gitkeep'` → only L72
   (`<features>/.gitkeep`, `<issues>/.gitkeep`, `<initiatives>/.gitkeep` in the
   companion scaffold); `grep -c 'Create the artifact roots from the config'` = 0.
   Step 6 (L108–109) says "Do **not** create `features/`, `issues/`, or
   `initiatives/` in the product repository". Step 4 (L82–91) bootstraps only when
   there is "No `origin/<default>` yet" and step 5 (L96) creates the ruleset "For a
   companion this run `created`" with `pull_request`, `non_fast_forward`, `deletion`
   and "no `required_status_checks`". The bootstrap is via the Contents API rather
   than the literal `git push` the checklist text names — see Plan vs implementation
   (Builder amendment, step 2.3); the behaviour the item specifies (default branch
   populated before the ruleset, no PR, only when the branch is absent) holds.
2. **`commands/agento-init.md` byte-identical** — **pass.** `diff
   .github/prompts/agento-init.prompt.md commands/agento-init.md` printed nothing.
3. **Templates** — **pass.** `grep -c '<owner>/<companion>'` = 1 in each of
   `templates/AGENTS-section.md`, the prompt, and `commands/agento-init.md`;
   `diff` of the template's `## Agento` … `### Commands` span against the prompt's
   de-indented inline block printed nothing (the whole block matches, not just the
   sentence). `sed -n 1p templates/companion-README.md` =
   `<!-- agento-companion: <owner>/<repo> -->`. `grep -c
   'features/\*\*,issues/\*\*,initiatives/\*\*' templates/project.instructions.md`
   = 1, and its body now names the companion copy path
   `.github/instructions/agento.instructions.md` (L10–11).
4. **Policy §9 row** — **pass.** `grep -c 'adopted, never recreated'
   .github/instructions/delivery-policy.instructions.md` = 1 (L233).
5. **Docs** — **pass.** `grep -c 'companion'`: README.md 4, docs/install.md 3,
   docs/commands.md 2, docs/project-profile.md 5, docs/artifacts.md 4. `grep -c
   'Artifact roots (with `.gitkeep`)' README.md` = 0; `grep -c 'features/` +
   `issues/`' docs/install.md` = 0. README L134–135 set-up rows and L139–142
   ruleset sentence, L382 flow row, docs/install.md "First run in a project" and
   "Verifying the install" sections, docs/commands.md L5, docs/project-profile.md
   config-table rows and workspace-folder note, docs/artifacts.md opening paragraph
   and "exact contract" paragraph all describe the companion scaffold (see the
   `git diff origin/main...HEAD` hunks for each).
6. **CHANGELOG** — **pass.** `awk '/^## Unreleased/,/^## 0\.4\.1/' CHANGELOG.md |
   grep -c 'agento-init'` = 2 (L20 bullet; it names the adopt rule, the Contents
   API bootstrap, the companion ruleset, the templates, and "no longer gets
   `features/`, `issues/`, or `initiatives/` roots").
7. **End-to-end smoke** — **pass** (re-driven by the Reviewer, not taken from
   `evidence/step-3-1-init-smoke.md`):
   - `gh repo view david-perry-software/agento-smoke-init-20260916-docs --json
     visibility,createdAt,description,defaultBranchRef` → `PUBLIC`,
     `2026-09-16T07:11:14Z`, `Agento delivery artifacts for
     david-perry-software/agento-smoke-init-20260916`, default `main`; product repo
     `PUBLIC` (same visibility).
   - `git -C <tmp>/…-docs fetch origin && git ls-tree -r --name-only origin/main` →
     exactly `.github/instructions/agento.instructions.md`, `README.md`,
     `features/.gitkeep`, `initiatives/.gitkeep`, `issues/.gitkeep`; `rev-list
     --count origin/main` = 5 (one Contents-API commit per file, README first:
     `50b068b … 592949e`); `branch -r` → only `origin/main`.
   - README on `origin/main` is byte-identical to `templates/companion-README.md`
     with `<owner>/<repo>` filled (`diff` empty); the body of
     `.github/instructions/agento.instructions.md` after its frontmatter is
     byte-identical to the plugin's `delivery-artifacts.instructions.md` body
     (`diff` empty); its `applyTo` is `features/**,issues/**,initiatives/**`.
   - `gh api repos/…-docs/rulesets` → one ruleset `23530556 Agento default branch
     branch active`; `rulesets/23530556` → `conditions.ref_name.include:
     ["~DEFAULT_BRANCH"]`, `exclude: []`, rules `pull_request`, `non_fast_forward`,
     `deletion` (no `required_status_checks`).
   - `ls -A <tmp>/agento-smoke-init-20260916` → `AGENTS.md .git .github README.md
     scripts` — no `features`, `issues`, `initiatives`. `.github/agento.json` carries
     `"repo": { "name": "agento-smoke-init-20260916-docs", "dir": null }` (grep = 1);
     `AGENTS.md` L8 has the companion sentence; `scripts/wait-for-checks.sh` is
     `-rwxrwxr-x`, 5356 bytes; branch `changes/agento-init` at `9f32a77` pushed, PR #1
     open (`gh pr list -R … --state all` → one PR).
   - `node scripts/agento.mjs doctor --root <tmp>/agento-smoke-init-20260916` → exit
     0, `status: ok`, `artifact-repo ok — <tmp>/agento-smoke-init-20260916-docs
     (agento-smoke-init-20260916-docs), origin
     https://github.com/david-perry-software/agento-smoke-init-20260916-docs.git,
     main present`.
   - `node scripts/agento.mjs config --root <tmp>/agento-smoke-init-20260916` →
     `artifactsRoot: "/tmp/tmp.crpKjqpynU/agento-smoke-init-20260916-docs"`,
     `repo.name: "agento-smoke-init-20260916-docs"`, `repo.dir` the same absolute
     path, `configSource` the product's `.github/agento.json`.
8. **Idempotency** — **pass.** `evidence/step-3-2-init-rerun.md` records
   `createdAt 2026-09-16T07:11:14Z` and `rev-list --count origin/main` = 5 before
   and after, and a report stating repository, clone, and all files `kept`. Reviewer
   confirmation after both passes: `createdAt` still `2026-09-16T07:11:14Z`,
   `rev-list --count origin/main` still 5, companion has zero PRs (`gh pr list -R
   …-docs --state all` → 0) and a single branch `main` (`gh api …/branches`), the
   product clone is clean on `changes/agento-init` with one commit above `main`.
9. **Throwaway names in roadmap `## Follow-ups`** — **pass.** `grep -c
   'agento-smoke-init-' features/2026/09/artifact-repo-init/roadmap.md` = 4; the
   bullet names both repositories and the open product PR #1.
10. **Full lint baseline green** — **pass.** `node --test 'scripts/**/*.test.mjs'
    'tests/**/*.test.mjs'` → `# tests 153`, `# pass 153`, `# fail 0`, exit 0 —
    identical to plan.md `## Research` (153/0 at `fc380e8`). `shellcheck
    scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
    scripts/hooks/session-context.sh scripts/wait-for-checks.sh` (no redirection)
    → no output, exit 0. `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt`
    → exit 0, no `FAIL`/`not ok` lines.

## Plan vs implementation

- **Bootstrap mechanism changed from `git push -u` to the GitHub Contents API**
  (Builder amendment, roadmap step 2.3, plan.md `## Decisions` "Builder amendment").
  Justified and verified: `scripts/hooks/delivery-guard.sh` builds its `GIT` regex as
  `\bgit\b(?:\s+-[Cc]\s+\S+)*` (L262) and `target_dir()` honours `git -C <path>`
  (L214–222), so `git -C ../<name> push -u origin <default>` is denied (the Reviewer
  observed the guard denying a shell line containing that command during this
  review). The replacement keeps Q2's shape — default branch populated before the
  ruleset, no PR, only when `origin/<default>` is absent — and the smoke's five
  single-file commits confirm it works. `grep -c 'contents/<path>'` = 1, `grep -c
  'push -u origin <default>'` = 0 in the prompt. plan.md `## Decisions`, roadmap
  `## Follow-ups`, and CHANGELOG were updated; plan.md `## Risks` bullet "Direct
  push to the companion default branch" and `## Acceptance checklist` item 1
  ("bootstraps by direct push") were **not** re-worded — historical plan text, noted
  as a minor finding, not a gap in the implementation.
- **Product ruleset not created in the smoke.** Step 9 is check-then-*ask*; a smoke
  run has no user, so the Builder recorded the gap (both evidence files). Consistent
  with the prompt; the product repository is throwaway.
- **Smoke setup used `gh repo create --add-readme`** for the product's initial
  `main` commit instead of the plan's "initial commit pushed to `main`" — the guard
  would deny that push too; equivalent for the purpose (a product repo with a
  default branch).
- No undocumented changes: `git diff --stat origin/main...HEAD` touches exactly the
  files plan.md `## Approach` lists ("Affected files") plus the delivery artifacts.
  No `scripts/*.mjs`, hook, or test-runner change (plan `## Out of scope`).

## Roadmap audit

All nine boxes spot-checked against the code and the live repositories; none
falsely ticked, no repairs made.

- 1.1, 1.2, 1.3 — greps and `diff` in checklist items 1–4 above; `node --test
  tests/customizations.test.mjs` is part of the 153-test run.
- 2.1, 2.2 — checklist items 5–6.
- 2.3 (added 2026-09-16) — `contents/<path>` = 1, `push -u origin <default>` = 0,
  prompt/commands diff empty; plan.md `## Decisions` carries the "Builder amendment
  (added 2026-09-16)" paragraph; CHANGELOG L28–30 names the Contents API. Properly
  marked `(added <date>)` with the discovery reason on the line.
- 3.1, 3.2 — checklist items 7–8, re-driven by the Reviewer against the same
  `/tmp/tmp.crpKjqpynU` checkout and the live repositories.
- 3.3 — checklist item 10 plus `gh pr checks 40` → `test pass`.
- No `(manual)` or `(manual, post-ship)` steps exist; no evidence-file requirement
  under §3 applies (the smoke evidence is CLI transcripts, which is the right form
  for a command with no UI).

## Findings

Nothing above minor severity.

1. **Minor — `base64 -w0` is GNU-only.** `.github/prompts/agento-init.prompt.md`
   L87 (`-f content="$(base64 -w0 <file>)"`): macOS/BSD `base64` has no `-w`. A
   portable spelling is `base64 < <file> | tr -d '\n'`. Guidance the agent adapts,
   but it will trip the first macOS run of init.
2. **Minor — adopted-companion ruleset rules are under-specified.** Step 5 (L102)
   says an `adopted` companion gets "the same check-then-ask that step 9 runs for
   the product", but step 9's rule list includes `required_status_checks`, which
   step 5 itself says the companion must not have. The intended reading (ask as in
   step 9, create with step 5's three rules) should be stated explicitly.
3. **Minor — stale plan text after the amendment.** plan.md `## Risks` "Direct push
   to the companion default branch … the bootstrap push must remain allowed" and
   `## Acceptance checklist` item 1 "bootstraps by direct push" describe the
   pre-amendment design; `## Decisions` and roadmap `## Follow-ups` are current.
   Historical artifact wording — fine to leave, or one-line touch-ups if the
   Builder prefers a self-consistent plan.
4. **Observation, not a defect — the Contents API is a guard-invisible write to a
   default branch.** The delivery guard cannot see `gh api -X PUT …/contents/…`, so
   the bootstrap is now outside the guard's reach entirely. This is exactly what the
   user accepted in Q2 and happens only while the companion has no default branch
   and no ruleset; after the ruleset exists the API write is refused server-side.
   Worth a sentence in `artifact-repo-hooks` (whether the guard should recognise
   this call) — recorded below as a follow-up, no change requested here.

## Follow-ups

- `artifact-repo-hooks`: decide whether the guard should recognise `gh api -X PUT
  repos/<owner>/<name>/contents/<path> -f branch=<default>` as a default-branch write
  and allow it only when the target repository has no ruleset yet (or leave it
  ungoverned as the sanctioned bootstrap path); today it is invisible to the guard.
- Portability pass over `agento-init.prompt.md` shell snippets (`base64 -w0`) when
  a macOS user first runs init; cheap to fold into any later init change.
- Clarify step 5's adopted-companion rule set (three rules, no status checks) the
  next time the prompt is touched.
- Throwaway repositories `david-perry-software/agento-smoke-init-20260916` (open
  PR #1) and `david-perry-software/agento-smoke-init-20260916-docs` (ruleset
  `Agento default branch`) remain for the user to delete (plan Q4); the local clones
  are in `/tmp/tmp.crpKjqpynU`.
