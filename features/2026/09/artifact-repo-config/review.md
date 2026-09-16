# Review: artifact-repo-config

Verdict: approve

Reviewed at HEAD `1c6d168` on `feature/artifact-repo-config` (draft PR #39, base
`main`), `origin/main` an ancestor of HEAD (`git merge-base --is-ancestor` true), work
tree clean. Skills consulted: none — no matching domain (no `.agents/skills/`
directory, no `## Agento` skills table in AGENTS.md). Every command below was run by
the Reviewer in this worktree on 2026-09-16; the Builder's evidence was not relied on.

## Acceptance checklist results

1. **`defaultConfig()` includes `artifacts.repo: { name: null, dir: null }`; template
   keeps nulls** — **pass.** `scripts/agento-config.mjs` L9 adds the key; tests
   "defaults derive the worktree dir…" and "the shipped templates/agento.json loads…"
   assert `deepEqual(config.artifacts.repo, { name: null, dir: null })`. Included in
   the 153/153 run below.
2. **`resolveArtifactsRoot()` semantics (unset, name-only, dir-only, both,
   `primaryRoot ≠ rootDir`)** — **pass.** `scripts/agento-config.mjs` L50–61; five
   `resolveArtifactsRoot …` tests in `scripts/agento-config.test.mjs` L94–137 cover
   each case (including a config with no `repo` key at all). All pass.
3. **`status`, `initiative`, `session`, `next` read the companion and ignore in-repo
   roots** — **pass.** Test "status, initiative, session, and next read the companion
   and ignore in-repo roots" (`scripts/agento.test.mjs`) writes a stale
   `features/2026/09/stale` roadmap and a stale breakdown in the product repo and
   asserts only the companion's `alpha`/`bug`/`demo` appear (`initiative stale-init`
   → `missing`, `next stale` → `missing`). Reviewer smoke in a throwaway pair (below)
   confirmed `status` lists the companion-only `demo` roadmap.
4. **`resolve`/`find` fall back to the companion's `origin/<branch>`** — **pass.** Test
   "resolve, find, ship-preflight, and close-decision fall back to the companion's
   origin branch" pushes `feature/widget` to the companion's bare origin only, plants
   a same-named roadmap in the product repo, and asserts `source: "remote"` for both
   `resolve` and `find`, `resolutionSource: "remote"` and `remote-roadmap-only`.
5. **Managed worktree resolves the companion beside the primary** — **pass.** Test
   "a managed worktree resolves the companion beside the primary checkout, not
   beside itself": `worktrees.dir: ../wt`, `git worktree add --detach <base>/wt/plan-x
   origin/main`, asserts `config.artifactsRoot === <base>/project-docs` and
   `!== <base>/wt/project-docs`, then the promoted build session resolves from the
   companion.
6. **`config` emits `artifactsRoot` + absolute `repo.dir`; `paths` emits
   `artifactsRoot` + absolute `artifactRoot`** — **pass.** Both modes tested
   ("config with artifacts.repo.name reports…", "paths and ports derive…", "paths
   places artifactRoot under the companion…"). Reviewer comparison of origin/main's
   CLI vs this branch's CLI on this checkout (in-repo mode): `paths feature widget`
   differs only by `+artifactsRoot` and `artifactRoot: "features"` →
   `"<root>/features"`; `paths plan …` only by `+artifactsRoot`; `config` only by
   `+artifactsRoot` and `+artifacts.repo: {null, null}`.
7. **`doctor` seventh check `artifact-repo` under `terminal`, all states** — **pass.**
   `node scripts/agento.mjs doctor --for close-session` here lists `node, python3,
   worktrees-dir, artifact-repo`, the new check `ok` "in-repo layout (artifacts.repo
   unset)". Test "doctor artifact-repo passes a valid companion, fails a missing or
   broken one naming /agento agento-init, and warns on stale in-repo roots" covers
   valid, `.gitkeep`-only (not stale), stale `features/`+`issues/` → `warn` with
   `--migrate` fallback, missing default branch, no `origin`, not a toplevel, absent
   → `fail` exit 3. Reviewer smoke (throwaway `/tmp/…/product` + `product-docs`):
   valid → `ok`, stale `features/x/roadmap.md` → `warn "…; stale in-repo roots:
   features/"`, `mv product-docs …off` → exit 3 with the `/agento agento-init …
   product-docs at …` fallback, `dir: ../product-docs/features` → `fail "… is not a
   git checkout toplevel (git rev-parse --show-toplevel → …/product-docs)"`.
8. **Pre-existing tests unchanged except the doctor id lists** — **pass (with
   note).** `git diff origin/main...HEAD -- scripts/agento.test.mjs | grep '^-'`
   removes only: the `makeRepo` fixture header (refactored into `cloneWithOrigin`),
   the "six"→"seven" title, and four doctor id/status arrays. No pre-existing
   assertion was altered or dropped. Two existing tests gained *additive* assertions
   ("config resolves the template's null worktrees.dir…" and "paths and ports…"),
   which roadmap step 2.3 explicitly required; the acceptance wording is stricter
   than the roadmap — recorded under Plan vs implementation.
9. **Templates and docs describe `artifacts.repo` / `artifact-repo`; prompt and
   command byte-identical** — **pass (with note).** `diff
   .github/prompts/agento-init.prompt.md commands/agento-init.md` prints nothing.
   `grep -l 'artifacts.repo\|artifact-repo' …` lists six of the seven files: the
   seventh, `templates/agento.json`, cannot literally contain `artifacts.repo` (JSON
   nesting); it contains `"repo": { "name": null, "dir": null }` (`grep -c '"repo"'`
   → 1). The plan's grep is unsatisfiable for JSON — a plan-verification defect, not
   an implementation gap.
10. **Full lint gate green and equal to baseline** — **pass.** Reviewer run:
    `node --test 'scripts/**/*.test.mjs' 'tests/**/*.test.mjs'` → exit 0, `# tests
    153`, `# pass 153`, `# fail 0` (baseline 141/141/0; +12 new tests, no failures);
    `shellcheck scripts/hooks/delivery-guard.sh scripts/hooks/replay-guard.sh
    scripts/hooks/session-context.sh scripts/wait-for-checks.sh` → exit 0, no
    output; `./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt` → exit 0.
    Matches the Builder's 4.2 record at `b663785`; no new or undocumented findings.

## Plan vs implementation

- Implemented as designed in `## Approach` items 1–5: `resolveArtifactsRoot()`
  (`scripts/agento-config.mjs`), the lazy `resolveArtifacts()` bootstrap +
  `artifactsRoot`/`artifactsGit`/`agit` in `scripts/agento.mjs` (L84–103), routing of
  `describe`, `describeFromRef`, `allRoadmaps`, `parseBreakdown`, `allBreakdowns`,
  `refFor`, `reviewFreshness`, `roadmapOnBranch`, and the four resolver call sites;
  `mergedAnomalies()` stays on `root` as decided. Resolver gains the optional
  `artifactsRoot` (default `rootDir`) in all four exported functions; `branchOwner`
  and `loadAgentoConfig` keep `rootDir`.
- **In-repo mode is byte-for-byte** except the named additive fields: Reviewer ran
  origin/main's `agento.mjs` and the branch's against this same checkout for
  `resolve`, `find`, `ship-preflight`, `close-decision`, `status`, `ports`, `paths`,
  `doctor --for close-session`, `config` — identical output save `config.artifactsRoot`,
  `config.config.artifacts.repo`, `paths.artifactsRoot`, absolute `paths.artifactRoot`,
  and the seventh doctor check, exactly the plan's Risk-list enumeration.
- Deviation, documented: step 4.1's recipe includes a push of the companion's `main`;
  the delivery guard denies `git push … main` from the agent shell anywhere (the
  Reviewer hit the same denial), so the evidence exercises `refs/heads/main`. The
  `refs/remotes/origin/main` path is covered by the unit test fixture (cloned from a
  bare origin). Acceptable.
- Deviation, minor wording: acceptance item 8 says existing tests change only in the
  doctor id lists, while roadmap 2.3 and Approach item 4 require additive assertions
  in the existing "paths and ports" test. The roadmap is the truer contract; no
  assertion was weakened.
- Plan defect: acceptance item 9's `grep -l` can never list `templates/agento.json`
  (see item 9). Future plans should grep for `"repo"` in JSON files.
- Docs: `docs/commands.md`, `docs/architecture.md`, `docs/artifacts.md`,
  `docs/project-profile.md` (two table rows + workspace-folder note),
  `CHANGELOG.md` `## Unreleased` entry — all present and accurate to the code.

## Roadmap audit

All 11 ticked steps spot-checked against the codebase; no false ticks, no repairs
made.

- 1.1, 2.1–2.4, 3.1: the code and the named tests exist and pass (153/153).
- 1.2, 3.2: files edited as listed; `diff` prompt vs command empty; `grep -c '"repo"'`
  ≥ 1 in `templates/agento.json`, `docs/project-profile.md`, `commands/agento-init.md`.
- 2.1's verify "`config` in this worktree still reports `artifactsRoot` equal to
  `root`" — confirmed. 2.3's verify "`paths feature widget` shows an absolute
  `artifactRoot` under `artifactsRoot`" — confirmed. 3.1's verify "`doctor --for
  close-session` lists `node, python3, worktrees-dir, artifact-repo` all ok" —
  confirmed.
- 4.1: evidence at [evidence/step-4-1-smoke.md](evidence/step-4-1-smoke.md), dated,
  with the push deviation stated on the step line and in the file. Reviewer re-drove
  the scenario independently (results in acceptance item 7).
- 4.2: recorded counts reproduced exactly (153/153/0, shellcheck 0, guard 0).
- 4.3: `git log origin/main..HEAD` shows only this feature's 13 commits;
  `origin/main` is an ancestor of HEAD; `git status` clean; `session` reports
  `lifecycle: in-review`, `status: in-review`, `next-step: ""`.

## Findings

No finding above minor severity.

- **Minor — `resolveArtifacts()` decides mode from the current checkout's config, then
  reads `name`/`dir` from the primary's** ([scripts/agento.mjs](../../../../scripts/agento.mjs#L88-L94)).
  A managed worktree whose branch predates `artifacts.repo` stays in-repo while the
  primary is in companion mode (and a branch that adds the key while the primary lacks
  it resolves `external: false`). This follows plan Approach item 2 ("no extra git
  call when unset") and the Risks section, so it is a documented trade-off rather
  than a defect; worth revisiting when `artifact-repo-hooks` or
  `paired-artifact-worktrees` make the primary the single source of the key.
- **Minor — `git worktree list --porcelain` runs up to three times per `doctor`**
  (`resolveArtifacts()`, `worktrees-dir`, `artifact-repo`). No behavioural effect;
  hoisting `primaryRoot` into a memoised helper would remove the duplication.
- **Minor — `holdsArtifacts()` treats a symlinked directory as a file**
  ([scripts/agento.mjs](../../../../scripts/agento.mjs#L330-L346)): `Dirent.isDirectory()`
  is false for symlinks, so a symlink under an in-repo root counts as stale content.
  Conservative (warn, not fail); acceptable.
- **Security — none.** All git invocations go through `execFileSync("git", ["-C",
  root, ...args])` with array arguments (no shell); the config-provided `dir` is
  resolved with `path.resolve` and only used as a `-C` cwd and in `fs` presence checks;
  no secrets are read, printed, or logged; the check performs no network probe.

## Follow-ups

- Make the primary checkout the single source of `artifacts.repo` for mode selection
  (not just for `name`/`dir`), or document the asymmetry in `docs/project-profile.md`,
  when `artifact-repo-hooks` lands.
- Memoise the primary-root lookup in `scripts/agento.mjs` so `doctor` and the
  bootstrap share one `git worktree list` call.
- Planner convention: acceptance greps that must match JSON templates should use the
  JSON key spelling (`"repo"`), not the dotted config path.
