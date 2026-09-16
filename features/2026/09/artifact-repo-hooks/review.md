# Review: artifact-repo-hooks

Verdict: approve

Reviewed at `44e81ca` (branch `feature/artifact-repo-hooks`, draft PR #41) from the
build worktree `/home/david/DP/agento-worktrees/plan-20260916-072936`; `origin/main`
is an ancestor of `HEAD` (`git merge-base --is-ancestor origin/main HEAD` → true).
Skills consulted: none — no matching domain (no `.agents/skills/**/SKILL.md`, no
`## Agento` skills table in AGENTS.md).

Lint gate (policy §5) re-driven by the Reviewer against the recorded baseline
(153/153/0, shellcheck silent, replay exit 0):

- `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, `# tests
  166`, `# pass 166`, `# fail 0` (13 new tests, all `companion:` prefixed).
- `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
  scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no output.
- `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
- `REPLAY_COMPANION=1 ./scripts/hooks/replay-guard.sh <
  tests/guard-fixtures-companion.txt` → exit 0.

Equal to the baseline: no findings then, none now.

## Acceptance checklist results

1. **In-repo mode byte-identical to `origin/main`** — pass. `git diff
   origin/main...HEAD -- tests/guard.test.mjs tests/session-context.test.mjs` removes
   only the two fixture-factory signatures (`makeGitRepo`/`makeRepo` refactored to
   accept `companion`); no existing test body changed and all pass. Reviewer ran
   `origin/main`'s `session-context.sh` (via `git show`, placed two directories below
   a root symlinking `scripts/agento.mjs` so `AGENTO_ROOT` resolves) and `HEAD`'s
   against the same temp repo holding an in-progress `features/…` and a paused
   `issues/…` roadmap: outputs `IDENTICAL` after normalising the CLI path.
   `printf '{"cwd":"%s"}' "$PWD" | bash scripts/hooks/session-context.sh` in this
   worktree prints 0 `Artifacts:` lines. In-repo replay exit 0.
2. **Companion walk + one `Artifacts:` line after `Session:`** — pass. Tests
   "companion: lists roadmaps from the companion checkout and ignores the product's
   own roots" and "companion: exactly one Artifacts: line, directly after Session:" in
   [tests/session-context.test.mjs](../../../../tests/session-context.test.mjs);
   code at [session-context.sh L131–L147](../../../../scripts/hooks/session-context.sh#L131-L147)
   (`walk_root = companion if external else root`; line appended after the
   `Session:` append).
3. **No-node fallback in companion mode = with-node minus `Session:`** — pass. Test
   "companion: the no-node fallback equals the with-node output minus Session:,
   Artifacts: included"; the `Artifacts:` line is produced by the Python block, not
   the CLI.
4. **Managed worktree resolves the companion against the primary** — pass. Test
   "companion: a managed worktree resolves the companion relative to the primary
   checkout"; `resolve_artifacts()` takes the first `git worktree list --porcelain`
   entry and re-reads the primary's config when it differs.
5. **Guard protects the companion default branch via the product config** — pass.
   Tests "companion: denies pushing the companion's default branch using the product
   config" (`trunk`), "…denies a commit while the companion sits on the product's
   default branch", "…allows pushes to companion work branches", "…denies a
   default-branch refspec push reached through cd"; companion replay exit 0 with 8
   `deny`, 8 `allow`, 3 generic-rule lines, and `push origin main` correctly `allow`
   under `branches.default: trunk`.
6. **Re-targeted roadmap nudge** — pass. Test "companion: roadmap nudge on a product
   commit inspects the companion index and HEAD" covers: `ask` with reason matching
   `/companion|project-docs/`, `/roadmap\.md/`, `/branch main/`; `allow` on staged
   companion `roadmap.md`; `allow` on companion `HEAD` touching one; `ask` after a
   further roadmap-less companion commit; `ask` even when the product commit itself
   stages a `roadmap.md` (product roots ignored). Fixture lines `ask git commit -m x
   code.js` / `ask git commit -m x features/x/roadmap.md` agree. Code at
   [delivery-guard.sh L397–L409](../../../../scripts/hooks/delivery-guard.sh#L397-L409).
7. **Commit directly in the companion keeps today's rule** — pass. Test "companion: a
   commit run in the companion on a delivery branch keeps today's nudge rule";
   `target_is_companion` routes to the unchanged `commit_files()` branch.
8. **Full lint gate equal to baseline** — pass (see header: 166/166/0, shellcheck
   silent exit 0, both replays exit 0).
9. **Docs, CHANGELOG, AGENTS.md** — pass. `grep -c 'Artifacts:' docs/hooks.md` = 1;
   `grep -c 'guard-fixtures-companion' docs/hooks.md` = 1; `grep -c
   'guard-fixtures-companion' AGENTS.md` = 1; `awk '/^## Unreleased/,/^## 0\./'
   CHANGELOG.md | grep -c hook` = 5; `node --test tests/customizations.test.mjs` →
   19 pass / 0 fail.
10. **Roadmap header `initiative:` and CLI state** — pass. Header carries
    `initiative: "external-artifact-repo"`; `node scripts/agento.mjs initiative
    external-artifact-repo` → `artifact-repo-hooks` `state: in-review`, `errors: []`.

## Plan vs implementation

Implementation follows plan.md `## Approach` items 1–6 and Decisions Q1–Q5:

- **Q1 (nudge rule)** — implemented as specified: `git -C <companion> diff --cached
  --name-only` + `git -C <companion> show --name-only --format= HEAD`; `ask` reason
  is the exact planned text with `{companion_path}` and `{companion_branch}`
  (`detached` fallback). Commits targeting the companion fall through to the
  unchanged rule.
- **Q2 (product config governs the companion)** — `product_root` is the hook `cwd`'s
  toplevel; when `realpath(target_root) == realpath(companion_path)` the guard
  reloads `config = load_config(product_root)` so `default_branch`/prefixes come from
  the product. The companion's own `agento.json` is never read (only
  `load_config(target_root)` before the override, which is then discarded).
- **Q3 (Python reimplementation, line shape)** — `resolve_artifacts()` mirrors
  `resolveArtifactsRoot()` (`dir` → `resolve(primary, dir)`, else `../<name>`;
  `name = repo.name or basename(path)`); duplicated between the hooks inside
  `# --- shared with … ---` markers and verified byte-identical by the Reviewer
  (`diff` of the two marked regions after swapping the cross-reference filename →
  no output). `Artifacts: <abs path> (branch <name|detached>)` is appended
  immediately after the `Session:` append (after `Agento CLI:`/`Current git branch:`
  when absent) and only when `external`.
- **Q4 (occupant check)** — untouched (no diff in
  `worktree_remove_target()`/occupant scan); recorded as a roadmap Follow-up.
- **Q5 (product roots ignored)** — `walk_root = companion if external else root`;
  `rel` stays relative to the walked base so `Delivery work:` paths keep today's
  shape.

Deviations, all documented on the roadmap or in the harness header:

- Steps 2.1 and 2.3 landed in one guard edit (roadmap 2.3 says so; plan.md `## Risks`
  motivates it).
- The companion replay harness sets `branches.default: trunk` in the product config
  (plan item 4 named only `artifacts.repo.dir`) so the fixture proves the product
  config — not the guard's built-in `main` — governs the companion. Documented in the
  `replay-guard.sh` header, the fixture header, and docs/hooks.md.
- `replay-guard.sh` rejects `REPLAY_COMPANION=1` together with `REPLAY_CWD` (exit 1
  with a message) rather than silently ignoring it — a sensible tightening, verified.

No undocumented changes: `git diff --stat origin/main...HEAD` touches exactly the
nine files listed under `Affected files` plus the two delivery artifacts.

## Roadmap audit

All 12 boxes spot-checked against the codebase; none falsely ticked, no repairs made.

- 1.1 — `REPLAY_COMPANION` block, `{companion}` substitution, and the `-docs` trap
  present; `printf 'allow git -C {companion} status\n' | REPLAY_COMPANION=1
  ./scripts/hooks/replay-guard.sh` prints the substituted absolute path, exit 0.
- 1.2 — fixture file present (44 lines), AGENTS.md `## Commands` gains the companion
  replay; the exposing-run mismatch count (10) is recorded on the line.
- 2.1–2.4, 3.1–3.3 — code and the 13 named tests present and passing.
- 4.1 — grep counts above; customizations test green.
- 4.2 — recorded gate at `0e3d97b` reproduced by the Reviewer at `44e81ca` with
  identical numbers.
- 4.3 — `git status --porcelain` empty; `origin/main` is an ancestor;
  `agento.mjs session` → `lifecycle: in-review`; initiative CLI as in item 10.

No `(manual)` or `(manual, post-ship)` steps exist.

## Findings

Ordered by severity; none above minor.

1. **Minor — duplicate toplevel lookup in the guard.**
   [delivery-guard.sh L306](../../../../scripts/hooks/delivery-guard.sh#L306) runs
   `git -C <hook_cwd> rev-parse --show-toplevel` on every guarded git command even
   in in-repo mode, although `target_root` (L300) already holds the same value
   whenever `hook_cwd` is the target (the common case). One extra 5 s-bounded
   subprocess per command; harmless, but `product_root = target_root` when
   `workdir == hook_cwd` would avoid it.
2. **Minor — companion-mode nudge no longer requires recordable files.** The in-repo
   rule only asks when `commit_files(segment)` is non-empty; the companion branch
   asks for any delivery-branch commit, including `git commit --allow-empty`. This is
   what the plan's Approach item 3 specifies (the product files are irrelevant in
   companion mode), so it is noted for awareness only.
3. **Informational — guard companion tests do not exercise a managed product
   worktree as `hook_cwd`.** Primary-resolution is covered in
   `tests/session-context.test.mjs` and the helper is byte-identical in both hooks,
   so the guard path is transitively covered; a direct guard test would close the
   gap if the helpers ever diverge (see Follow-ups).

No security issues: no secrets handled; all subprocesses keep the 5 s timeout and
`capture_output`; the guard never reads a config from inside the companion.

## Follow-ups

- Add a test asserting the `# --- shared with … ---` regions of
  `scripts/hooks/delivery-guard.sh` and `scripts/hooks/session-context.sh` are
  byte-identical (already listed in roadmap.md Follow-ups; the Reviewer's manual
  `diff` is the interim evidence).
- Reuse `target_root` for `product_root` in the guard when `hook_cwd` is the target
  (Finding 1).
- `paired-artifact-worktrees`: add the paired companion worktree path to the guard's
  `git worktree remove` occupant scan (plan.md Decision Q4; already in roadmap.md
  Follow-ups).
